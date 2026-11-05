import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { systemContext } from '@nexa/contracts';
import {
  createDatabase,
  type DatabaseHandle,
} from '../../apps/api/src/infrastructure/persistence/database';
import {
  withDatabaseScope,
  withSystemScope,
} from '../../apps/api/src/infrastructure/persistence/database-scope';
import {
  ensureRowLevelSecurity,
  TENANT_POLICY,
  tenantTableSecurity,
} from '../../apps/api/src/infrastructure/persistence/row-level-security';
import { productCategories } from '../../apps/api/src/infrastructure/persistence/schema';
import {
  createTestContext,
  SEED_IDS,
  tenantA,
  tenantB,
  testAppDatabaseUrl,
  type TestContext,
} from './harness';

/**
 * Row-level security (ADR-0037).
 *
 * The catalogue is read from PostgreSQL itself, never from a list kept here: "every table
 * with a tenant_id column" is a query, so a table a later migration adds is checked the
 * day it lands. The cross-tenant cases run through the APPLICATION's pool, as nexa_app —
 * the owner bypasses the policies and would prove nothing.
 */

/**
 * The tables WITHOUT `tenant_id`, each a decision recorded in ADR-0037 § Tables without
 * RLS. A new one fails this list until someone decides whether it holds a hosted tenant's
 * data.
 */
const TABLES_WITHOUT_TENANT = [
  'aggregate_sequences',
  'backup_run_parts',
  'backup_runs',
  'installation_keys',
  'process_runs',
  'processed_messages',
  'tenants',
];

/** Every way a tenant table can fall short. Empty means every one is secured. */
async function insecureTenantTables(client: PoolClient): Promise<string[]> {
  const policies = await client.query<{ table: string; ok: boolean }>(
    `SELECT tablename AS table,
            permissive = 'PERMISSIVE' AND cmd = 'ALL' AND roles = '{public}'
            AND qual LIKE '%nexa_rls_system_path()%' AND qual LIKE '%nexa_current_tenant_id()%'
            AND with_check = qual AS ok
       FROM pg_policies WHERE schemaname = 'public' AND policyname = $1`,
    [TENANT_POLICY],
  );
  const shape = new Map(policies.rows.map((row) => [row.table, row.ok]));
  const problems: string[] = [];
  for (const state of await tenantTableSecurity(client)) {
    if (!state.enabled) problems.push(`${state.table}: row-level security is not enabled`);
    if (state.forced) problems.push(`${state.table}: FORCEd, which ADR-0037's rollout is not`);
    if (!state.tenantPolicy) problems.push(`${state.table}: no ${TENANT_POLICY} policy`);
    else if (shape.get(state.table) !== true)
      problems.push(`${state.table}: ${TENANT_POLICY} has another shape`);
  }
  return problems;
}

describe('row-level security', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const owner = (): DatabaseHandle => ctx.container.database;
  const app = (): DatabaseHandle => ctx.applicationDatabase;

  describe('the catalogue', () => {
    it('secures EVERY table with a tenant_id column, and only with the one policy', async () => {
      const problems = await owner().withClient(insecureTenantTables);
      expect(problems).toEqual([]);
      const tables = await owner().withClient(tenantTableSecurity);
      // Not vacuous: the schema has two hundred of them.
      expect(tables.length).toBeGreaterThan(150);
    });

    it('notices a table whose policy was dropped or whose RLS was disabled', async () => {
      // The check above, run against a deliberately broken catalogue inside a transaction
      // that is rolled back: the proof that it can fail, kept as a test.
      await owner().withClient(async (client) => {
        await client.query('BEGIN');
        try {
          await client.query('ALTER TABLE customers DISABLE ROW LEVEL SECURITY');
          await client.query(`DROP POLICY ${TENANT_POLICY} ON panels`);
          const problems = await insecureTenantTables(client);
          expect(problems).toEqual(
            expect.arrayContaining([
              'customers: row-level security is not enabled',
              `panels: no ${TENANT_POLICY} policy`,
            ]),
          );
        } finally {
          await client.query('ROLLBACK');
        }
      });
    });

    it('pins the tables that have no tenant_id', async () => {
      const result = await owner().withClient((client) =>
        client.query<{ table: string }>(
          `SELECT c.relname AS table FROM pg_class c
            WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
              AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                               AND a.attname = 'tenant_id' AND NOT a.attisdropped)
            ORDER BY 1`,
        ),
      );
      expect(result.rows.map((row) => row.table)).toEqual(TABLES_WITHOUT_TENANT);
    });

    it('changes nothing when it runs again', async () => {
      expect(await ensureRowLevelSecurity(owner())).toEqual([]);
    });

    it('gives the application role no way around the policies', async () => {
      const roles = await owner().withClient((client) =>
        client.query<{
          rolname: string;
          rolsuper: boolean;
          rolbypassrls: boolean;
          rolcanlogin: boolean;
        }>(
          `SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles
            WHERE rolname IN ('nexa_app', 'nexa_system') ORDER BY rolname`,
        ),
      );
      expect(roles.rows).toEqual([
        { rolname: 'nexa_app', rolsuper: false, rolbypassrls: false, rolcanlogin: true },
        { rolname: 'nexa_system', rolsuper: false, rolbypassrls: false, rolcanlogin: false },
      ]);
      const membership = await owner().withClient((client) =>
        client.query<{ inherit_option: boolean; set_option: boolean }>(
          `SELECT m.inherit_option, m.set_option FROM pg_auth_members m
             JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
            WHERE g.rolname = 'nexa_system' AND u.rolname = 'nexa_app'`,
        ),
      );
      expect(membership.rows).toEqual([{ inherit_option: false, set_option: true }]);
    });
  });

  describe('as the application role', () => {
    it('is what the suite’s containers connect as', async () => {
      expect(await app().scopeEnforcement()).toBe('enforcing');
      expect(await owner().scopeEnforcement()).toBe('owner');
    });

    it('reads another tenant’s rows as zero rows, even when asked for them by id', async () => {
      const asB = await withDatabaseScope(tenantB, () =>
        app().db.select({ id: productCategories.id }).from(productCategories),
      );
      expect(asB.map((row) => row.id)).toEqual([SEED_IDS.categoryB]);
      const aByIdAsB = await withDatabaseScope(tenantB, () =>
        app()
          .db.select({ id: productCategories.id })
          .from(productCategories)
          .where(sql`${productCategories.id} = ${SEED_IDS.categoryA}`),
      );
      expect(aByIdAsB).toEqual([]);
    });

    it('refuses to write a row into another tenant', async () => {
      await expect(
        withDatabaseScope(tenantB, () =>
          app()
            .db.update(productCategories)
            .set({ name: 'B was here' })
            .where(sql`${productCategories.id} = ${SEED_IDS.categoryA}`)
            .returning({ id: productCategories.id }),
        ),
      ).resolves.toEqual([]);
      await expect(
        withDatabaseScope(tenantB, () =>
          app()
            .db.update(productCategories)
            .set({ tenantId: SEED_IDS.tenantA as never })
            .where(sql`${productCategories.id} = ${SEED_IDS.categoryB}`),
        ),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
      const untouched = await owner()
        .db.select({ name: productCategories.name })
        .from(productCategories)
        .where(sql`${productCategories.id} = ${SEED_IDS.categoryA}`);
      expect(untouched[0]?.name).not.toBe('B was here');
    });

    it('RAISES for a tenant-table statement with no tenant bound, rather than answering', async () => {
      await expect(
        app().db.select({ id: productCategories.id }).from(productCategories),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
    });

    it('sees every tenant on the system path, and nothing without its reason', async () => {
      const all = await withSystemScope('row-level security test', () =>
        app().db.select({ id: productCategories.id }).from(productCategories),
      );
      expect(all.map((row) => row.id).sort()).toEqual(
        [SEED_IDS.categoryA, SEED_IDS.categoryB].sort(),
      );
      await expect(
        withDatabaseScope(systemContext(''), () =>
          app().db.select({ id: productCategories.id }).from(productCategories),
        ),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
    });

    it('never carries one checkout’s tenant into the next borrower of the connection', async () => {
      // One connection, so the second checkout is the SAME session as the first.
      const single = createDatabase(testAppDatabaseUrl(), 1);
      try {
        const asA = await withDatabaseScope(tenantA, () =>
          single.db.select({ id: productCategories.id }).from(productCategories),
        );
        expect(asA.map((row) => row.id)).toEqual([SEED_IDS.categoryA]);
        const asB = await withDatabaseScope(tenantB, () =>
          single.db.select({ id: productCategories.id }).from(productCategories),
        );
        expect(asB.map((row) => row.id)).toEqual([SEED_IDS.categoryB]);
        await expect(
          single.db.select({ id: productCategories.id }).from(productCategories),
        ).rejects.toMatchObject({ cause: { code: '42501' } });
        const role = await withSystemScope('row-level security test', () =>
          single.withClient((client) =>
            client.query<{ who: string }>('SELECT current_user AS who'),
          ),
        );
        expect(role.rows[0]?.who).toBe('nexa_system');
        const after = await single.withClient((client) =>
          client.query<{ who: string }>('SELECT current_user AS who'),
        );
        expect(after.rows[0]?.who).toBe('nexa_app');
      } finally {
        await single.close();
      }
    });

    it('lets a hosted tenant’s transaction see the installation’s recovery freeze', async () => {
      // The write gate's question is installation-wide; the recovery row is tenant A's.
      // Asked inside tenant B's unit of work it must still be seen (0316's function).
      await ctx.container.database.db.execute(sql`
        INSERT INTO recovery_requests (id, tenant_id, source, state, stage, created_at, updated_at)
        VALUES ('01900000-0000-7000-8000-00000000fe01', ${SEED_IDS.tenantA}, 'UPLOAD',
                'QUIESCING', 'QUIESCE', now(), now())`);
      await expect(ctx.container.uow.run(tenantB, async () => undefined)).rejects.toMatchObject({
        code: 'recovery.quiesced',
      });
    });
  });
});
