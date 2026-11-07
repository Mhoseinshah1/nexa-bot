import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  type DatabaseHandle,
} from '../../../apps/api/src/infrastructure/persistence/database';
import { withDatabaseScope } from '../../../apps/api/src/infrastructure/persistence/database-scope';
import {
  ensureRowLevelSecurity,
  TENANT_POLICY,
  tenantTableSecurity,
} from '../../../apps/api/src/infrastructure/persistence/row-level-security';
import { testAppDatabaseUrl } from '../harness';
import { buildWorld, PAIRS, type TenantWorld, type World } from './fixtures';

/**
 * Phase 6A PR-5 (D3) — underneath every surface: the database itself, as nexa_app.
 *
 * The surfaces' suites prove the application never hands one tenant another's rows. This
 * one proves the floor under them: a statement bound to tenant X that names tenant Y's rows
 * with NO tenant predicate of its own — the missed predicate ADR-0037 is there for — sees
 * nothing and changes nothing, on EVERY tenant table in the catalogue, by tenant and by
 * the victim's real ids; and a row written into Y from X's binding is refused.
 *
 * The last block is the mutation check kept as a test: with one table's policy removed the
 * probes above turn red, and they turn green again when the migration step restores it.
 * (`scripts/claude/isolation-mutation.sh` runs the WHOLE suite with a policy removed.)
 */

/** Tables whose rows the fixtures give every tenant, with the victim's id in each. */
const BY_ID: readonly (readonly [string, (v: TenantWorld) => string])[] = [
  ['customers', (v) => v.customerId],
  ['orders', (v) => v.orderId],
  ['products', (v) => v.productId],
  ['product_categories', (v) => v.categoryId],
  ['panels', (v) => v.panelId],
  ['services', (v) => v.serviceId],
  ['payments', (v) => v.paymentId],
  ['payment_receipts', (v) => v.receiptId],
  ['tickets', (v) => v.ticketId],
  ['ticket_categories', (v) => v.ticketCategoryId],
  ['ticket_messages', (v) => v.ticketMessageId],
  ['broadcasts', (v) => v.broadcastId],
  ['admins', (v) => v.owner.id],
  ['bot_instances', (v) => v.botId],
];

describe('isolation proof (PR-5) — the database layer, as nexa_app', () => {
  let world: World;
  let app: DatabaseHandle;
  let tables: string[];

  beforeAll(async () => {
    world = await buildWorld();
    app = createDatabase(testAppDatabaseUrl(), 2);
    expect(await app.scopeEnforcement()).toBe('enforcing');
    tables = (await world.api.container.database.withClient(tenantTableSecurity)).map(
      (state) => state.table,
    );
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await world?.close();
  });

  const owner = () => world.api.container.database;
  const ident = (table: string) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`not a table: ${table}`);
    return sql.raw(`"${table}"`);
  };
  const countAs = (scope: TenantWorld | null, statement: ReturnType<typeof sql>) => {
    const run = async () =>
      ((await (scope === null ? owner() : app).db.execute(statement)).rows[0] as { n: number }).n;
    return scope === null ? run() : withDatabaseScope(scope.scope, run);
  };

  /** Every tenant table in which the OWNER sees rows of `victim` (the non-vacuous set). */
  async function populated(victim: TenantWorld): Promise<string[]> {
    const out: string[] = [];
    for (const table of tables) {
      const n = await countAs(
        null,
        sql`SELECT count(*)::int AS n FROM ${ident(table)} WHERE tenant_id = ${victim.tenantId}`,
      );
      if (n > 0) out.push(table);
    }
    return out;
  }

  /** The tables in which `attacker`'s binding sees any row of `victim`'s. Empty passes. */
  async function leakingTables(
    attacker: TenantWorld,
    victim: TenantWorld,
    among: readonly string[],
  ): Promise<string[]> {
    const out: string[] = [];
    for (const table of among) {
      const n = await countAs(
        attacker,
        sql`SELECT count(*)::int AS n FROM ${ident(table)} WHERE tenant_id = ${victim.tenantId}`,
      );
      if (n > 0) out.push(table);
    }
    return out;
  }

  /** The tables in which `tenant`'s own binding does NOT see its own rows. Empty passes. */
  async function blindTables(tenant: TenantWorld, among: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const table of among) {
      const n = await countAs(
        tenant,
        sql`SELECT count(*)::int AS n FROM ${ident(table)} WHERE tenant_id = ${tenant.tenantId}`,
      );
      if (n === 0) out.push(table);
    }
    return out;
  }

  describe.each(PAIRS)('%s’s binding against %s’s rows', (attackerLabel, victimLabel) => {
    const attacker = () => world.tenants[attackerLabel];
    const victim = () => world.tenants[victimLabel];

    it('sees none of the victim’s rows in ANY tenant table, and all of its own', async () => {
      const victims = await populated(victim());
      // Not vacuous: the household spans this many tables.
      expect(victims.length).toBeGreaterThanOrEqual(20);
      expect(await leakingTables(attacker(), victim(), tables)).toEqual([]);
      expect(await blindTables(victim(), victims)).toEqual([]);
    });

    it.each(BY_ID.map(([table, id]) => [table, id] as const))(
      'guesses the victim’s id in %s: nothing read, nothing updated, nothing deleted',
      async (table, id) => {
        const target = id(victim());
        const read = await countAs(
          attacker(),
          sql`SELECT count(*)::int AS n FROM ${ident(table)} WHERE id = ${target}`,
        );
        expect(read).toBe(0);
        const touched = await withDatabaseScope(attacker().scope, async () =>
          app.db.execute(sql`UPDATE ${ident(table)} SET id = id WHERE id = ${target}`),
        );
        expect(touched.rowCount ?? 0).toBe(0);
        if (table !== 'admins' && table !== 'bot_instances') {
          const removed = await withDatabaseScope(attacker().scope, async () =>
            app.db.execute(sql`DELETE FROM ${ident(table)} WHERE id = ${target}`),
          );
          expect(removed.rowCount ?? 0).toBe(0);
        }
        // The row is there, as the owner sees it, and the victim's own binding reads it.
        expect(
          await countAs(null, sql`SELECT count(*)::int AS n FROM ${ident(table)} WHERE id = ${target}`),
        ).toBe(1);
        expect(
          await countAs(
            victim(),
            sql`SELECT count(*)::int AS n FROM ${ident(table)} WHERE id = ${target}`,
          ),
        ).toBe(1);
      },
    );

    it('refuses a row written into the victim from the attacker’s binding (WITH CHECK)', async () => {
      const id = world.api.container.ids.uuid();
      await expect(
        withDatabaseScope(attacker().scope, async () =>
          app.db.execute(sql`INSERT INTO customers (id, tenant_id, telegram_user_id, status)
            VALUES (${id}, ${victim().tenantId}, '222222222', 'ACTIVE')`),
        ),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
      await expect(
        withDatabaseScope(attacker().scope, async () =>
          app.db.execute(sql`UPDATE customers SET tenant_id = ${victim().tenantId}
                              WHERE id = ${attacker().customerId}`),
        ),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
      expect(
        await countAs(null, sql`SELECT count(*)::int AS n FROM customers WHERE id = ${id}`),
      ).toBe(0);
    });
  });

  describe('the mutation check: one table without its policy turns these probes red', () => {
    const table = 'customers';
    const attacker = () => world.tenants.HOSTED_1;
    const victim = () => world.tenants.HOSTED_2;

    async function restore() {
      expect(await ensureRowLevelSecurity(owner())).toEqual([table]);
      expect(await leakingTables(attacker(), victim(), [table])).toEqual([]);
      expect(await blindTables(attacker(), [table])).toEqual([]);
    }

    it('the policy dropped (RLS still on, so deny-all): a tenant goes blind to its own rows', async () => {
      await owner().db.execute(sql.raw(`DROP POLICY ${TENANT_POLICY} ON "${table}"`));
      try {
        expect(await blindTables(attacker(), [table])).toEqual([table]);
      } finally {
        await restore();
      }
    });

    it('the policy dropped and RLS off: the attacker reads the victim’s rows', async () => {
      await owner().db.execute(sql.raw(`DROP POLICY ${TENANT_POLICY} ON "${table}"`));
      await owner().db.execute(sql.raw(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`));
      try {
        expect(await leakingTables(attacker(), victim(), [table])).toEqual([table]);
        expect(
          await countAs(
            attacker(),
            sql`SELECT count(*)::int AS n FROM customers WHERE id = ${victim().customerId}`,
          ),
        ).toBe(1);
      } finally {
        await restore();
      }
    });
  });
});
