import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  type DatabaseHandle,
} from '../../apps/api/src/infrastructure/persistence/database';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { TENANT_REPLACE_REASON } from '../../apps/api/src/modules/platform/backup/infrastructure/tenant-archive-apply';
import { AesGcmSecretCipher } from '../../apps/api/src/infrastructure/crypto/secret-cipher';
import {
  migrateOnce,
  resetDatabase,
  SEED_IDS,
  testAppDatabaseUrl,
  testOwnerDatabaseUrl,
} from './harness';

/**
 * Phase 6B (ADR-0039 § 4, § 10): the TENANT REWRITE ALLOWANCE, guard by guard.
 *
 * The list of guards is NOT written here: it is every non-constraint trigger that fires on
 * DELETE, read from `pg_trigger`, as (trigger function, table) pairs. A guard added later
 * without the allowance's branch fails "accepts inside" below; one that admits a DELETE outside
 * the run fails "refuses outside".
 *
 * Each pair is exercised on a probe: a temporary table named like the real one (`LIKE` it, so
 * `TG_TABLE_NAME` and `OLD`'s columns are the real ones), the real guard function attached
 * BEFORE DELETE, and two rows — one of the replaced tenant, one of another. A row carries what
 * makes its guard refuse outside a run: a system role, a PUBLISHED terms version, a product an
 * order references (a temporary `orders` shadows the real one inside the transaction), the
 * HOST admin, an
 * outbox message of the tenant for `processed_messages`. Then, as the application connects
 * (`nexa_app`, `SET ROLE nexa_system` for the system path):
 *
 *   outside      the system path and the replace's reason, no allowance      → refused
 *   inside       + `nexa.tenant_rewrite` naming an APPLYING REPLACE request of the tenant,
 *                  claimed by THIS transaction                                → the row goes
 *   not system   the allowance and the reason, but the statement as nexa_app   → refused
 *   wrong reason the allowance, another system-path reason                     → refused
 *   other tenant the allowance, the other tenant's row                         → refused
 *   not applying the allowance, the request VERIFIED                           → refused
 *   other run    `nexa.tenant_rewrite` naming another id                       → refused
 *   stale claim  a transaction that did not claim it (an earlier one did)      → refused
 */

const OTHER_REASON = 'tenant archive: create the restored tenant and its register';

const H1 = '01900000-0000-7000-8000-0000000e0001';
const H2 = '01900000-0000-7000-8000-0000000e0002';
const INSTALLATION_ADMIN = '01900000-0000-7000-8000-0000000e00a1';
const REQUEST = '01900000-0000-7000-8000-0000000e00f1';

interface Pair {
  readonly fn: string;
  readonly table: string;
}

type Outcome =
  | { readonly ok: true; readonly rows: number }
  | { readonly ok: false; readonly code: string; readonly message: string };

let owner: DatabaseHandle;
let pairs: Pair[] = [];
const outbox: Record<string, string> = {};

async function appClient(): Promise<Client> {
  const client = new Client({ connectionString: testAppDatabaseUrl() });
  await client.connect();
  return client;
}

beforeAll(async () => {
  await migrateOnce(testOwnerDatabaseUrl());
  owner = createDatabase(testOwnerDatabaseUrl(), 2);
  await resetDatabase(owner.db);
  await seed(
    owner.db,
    new AesGcmSecretCipher(
      { activeKeyId: 'k', keys: new Map([['k', Buffer.alloc(32, 7)]]), format: 'canonical' },
      false,
    ),
  );
  for (const [id, slug] of [
    [H1, 'rewrite-one'],
    [H2, 'rewrite-two'],
  ] as const) {
    await owner.db.execute(sql`
      INSERT INTO tenants (id, kind, parent_tenant_id, slug, display_name, status, locale,
                           display_timezone, calendar, currency)
      VALUES (${id}, 'HOSTED', ${SEED_IDS.tenantA}, ${slug}, ${slug}, 'ACTIVE', 'fa',
              'Asia/Tehran', 'jalali', 'IRT')`);
    const message = randomUUID();
    outbox[id] = message;
    await owner.db.execute(sql`
      INSERT INTO outbox_messages (id, tenant_id, aggregate_type, aggregate_id, sequence,
                                   event_type, payload, actor, correlation_id, occurred_at)
      VALUES (${message}, ${id}, 'Customer', ${randomUUID()}, 1, 'customer.created', '{}'::jsonb,
              '{}'::jsonb, 'c', now())`);
  }
  await owner.db.execute(sql`
    INSERT INTO admins (id, tenant_id, username, display_name, password_hash, password_updated_at)
    VALUES (${INSTALLATION_ADMIN}, ${SEED_IDS.tenantA}, 'rewrite-owner', 'Owner', 'x', now())`);
  await owner.db.execute(sql`
    INSERT INTO tenant_restores (id, tenant_id, hosted_tenant_id, mode, state, stage,
                                 artifact_sha256, requested_by_admin_id, created_at, updated_at)
    VALUES (${REQUEST}, ${SEED_IDS.tenantA}, ${H1}, 'REPLACE', 'APPLYING', 'APPLY',
            ${'a'.repeat(64)}, ${INSTALLATION_ADMIN}, now(), now())`);
  pairs = (
    await owner.db.execute(sql`
      SELECT DISTINCT p.proname AS fn, c.relname AS "table"
        FROM pg_trigger t
        JOIN pg_proc p ON p.oid = t.tgfoid
        JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal AND t.tgconstraint = 0 AND (t.tgtype & 8) = 8
         AND c.relnamespace = 'public'::regnamespace
       ORDER BY 1, 2`)
  ).rows as unknown as Pair[];
}, 300_000);

afterAll(async () => {
  await owner?.close();
});

/** The probe of one pair inside `client`'s open transaction: the two rows, the guard on it. */
async function probe(client: Client, pair: Pair): Promise<void> {
  const table = `pg_temp."${pair.table}"`;
  await client.query(
    `CREATE TEMP TABLE "${pair.table}" (LIKE public."${pair.table}") ON COMMIT DROP`,
  );
  const columns = (
    await client.query<{ name: string; type: string }>(
      `SELECT attname AS name, format_type(atttypid, atttypmod) AS type FROM pg_attribute
        WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped`,
      [table],
    )
  ).rows;
  for (const column of columns) {
    await client.query(`ALTER TABLE ${table} ALTER COLUMN "${column.name}" DROP NOT NULL`);
  }
  await client.query(
    `CREATE TRIGGER rewrite_probe BEFORE DELETE ON ${table}
       FOR EACH ROW EXECUTE FUNCTION public.${pair.fn}()`,
  );
  await client.query(`GRANT ALL ON ${table} TO nexa_system`);
  const has = (name: string) => columns.some((column) => column.name === name);
  for (const tenant of [H1, H2]) {
    const values: Record<string, unknown> = {};
    if (has('tenant_id')) values['tenant_id'] = tenant;
    if (has('id'))
      values['id'] = columns.find((c) => c.name === 'id')?.type === 'uuid' ? randomUUID() : 1;
    if (has('is_system')) values['is_system'] = true;
    if (pair.table === 'roles') values['key'] = 'owner';
    if (pair.table === 'terms_versions') values['status'] = 'PUBLISHED';
    // Phase 6B PR-5: the hosted tenant's HOST principal, undeletable outside a replace.
    if (pair.table === 'admins') values['kind'] = 'HOST';
    if (pair.table === 'processed_messages') {
      values['message_id'] = outbox[tenant];
      values['consumer'] = 'probe';
    }
    const names = Object.keys(values);
    await client.query(
      `INSERT INTO ${table} (${names.map((n) => `"${n}"`).join(', ')})
       VALUES (${names.map((_n, i) => `$${String(i + 1)}`).join(', ')})`,
      names.map((n) => values[n]),
    );
  }
  if (pair.fn === 'nexa_product_referenced_never_deleted') {
    // What makes this guard refuse: an order of the product (shadowing the real table here).
    await client.query(`CREATE TEMP TABLE orders (tenant_id uuid, product_id uuid) ON COMMIT DROP`);
    await client.query(`INSERT INTO orders SELECT tenant_id, id FROM ${table}`);
    await client.query(`GRANT ALL ON pg_temp.orders TO nexa_system`);
  }
}

/** Claims the allowance for the current transaction, as the replace's apply does. */
async function claim(client: Client): Promise<void> {
  await client.query(
    `SELECT set_config('role', 'nexa_system', true),
                             set_config('app.system_reason', $1, true)`,
    [TENANT_REPLACE_REASON],
  );
  const claimed = await client.query(
    `UPDATE tenant_restores SET rewrite_xact_id = (pg_current_xact_id()::text)::bigint
      WHERE id = $1 AND state = 'APPLYING' RETURNING id`,
    [REQUEST],
  );
  expect(claimed.rowCount).toBe(1);
  await client.query(
    `SELECT set_config('role', 'none', true), set_config('app.system_reason', '', true)`,
  );
}

/** One DELETE of `tenant`'s probe row under `as`, inside a savepoint that is then undone. */
async function attempt(
  client: Client,
  pair: Pair,
  tenant: string,
  as: { role: 'nexa_system' | 'none'; reason: string; rewrite: string; before?: string },
): Promise<Outcome> {
  await client.query('SAVEPOINT attempt');
  try {
    if (as.before !== undefined) {
      await client.query(
        `SELECT set_config('role', 'nexa_system', true),
                                 set_config('app.system_reason', $1, true)`,
        [TENANT_REPLACE_REASON],
      );
      await client.query(as.before, [REQUEST]);
    }
    await client.query(
      `SELECT set_config('role', $1, true), set_config('app.system_reason', $2, true),
              set_config('app.current_tenant_id', $4, true),
              set_config('nexa.tenant_rewrite', $3, true)`,
      [as.role, as.reason, as.rewrite, tenant],
    );
    const where =
      pair.table === 'processed_messages' ? `message_id = $1::uuid` : `tenant_id = $1::uuid`;
    const result = await client.query(`DELETE FROM pg_temp."${pair.table}" WHERE ${where}`, [
      pair.table === 'processed_messages' ? outbox[tenant] : tenant,
    ]);
    return { ok: true, rows: result.rowCount ?? 0 };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { ok: false, code: e.code ?? '', message: e.message ?? '' };
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT attempt');
  }
}

/** A refusal BY THE GUARD (its own error codes), never a privilege or a missing object. */
function refusedByGuard(outcome: Outcome): boolean {
  return !outcome.ok && (outcome.code === '23001' || outcome.code === 'P0001');
}

describe('the tenant rewrite allowance — every DELETE guard, from the catalogue', () => {
  it('finds the guards it tests, and every one carries the allowance', async () => {
    const functions = [...new Set(pairs.map((pair) => pair.fn))];
    // Non-vacuous: the twelve history guards of 0001… onward, on dozens of tables.
    expect(functions.length).toBeGreaterThanOrEqual(11);
    expect(pairs.length).toBeGreaterThanOrEqual(40);
    expect(functions).toContain('nexa_reject_mutation');
    const sources = (
      await owner.db.execute(sql`
        SELECT proname AS fn, prosrc AS src FROM pg_proc
         WHERE proname = ANY(${`{${functions.join(',')}}`}::text[])`)
    ).rows as { fn: string; src: string }[];
    expect(
      sources.filter((s) => !s.src.includes('nexa_tenant_rewrite_permits')).map((s) => s.fn),
    ).toEqual([]);
  });

  it('the lookup is the system path’s alone: definer, pinned search_path, no PUBLIC or nexa_app', async () => {
    const [fn] = (
      await owner.db.execute(sql`
        SELECT p.prosecdef AS definer, p.proconfig AS config,
               has_function_privilege('nexa_app', p.oid, 'EXECUTE') AS app,
               has_function_privilege('nexa_system', p.oid, 'EXECUTE') AS system,
               EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public
          FROM pg_proc p WHERE p.proname = 'nexa_tenant_rewrite_allowed'`)
    ).rows as {
      definer: boolean;
      config: string[];
      app: boolean;
      system: boolean;
      public: boolean;
    }[];
    expect(fn).toMatchObject({ definer: true, app: false, system: true, public: false });
    expect(fn?.config.some((c) => c.startsWith('search_path=pg_catalog'))).toBe(true);
    const [permits] = (
      await owner.db.execute(sql`
        SELECT prosecdef AS definer FROM pg_proc WHERE proname = 'nexa_tenant_rewrite_permits'`)
    ).rows as { definer: boolean }[];
    expect(permits?.definer).toBe(false);
    const client = await appClient();
    try {
      await expect(
        client.query(`SELECT nexa_tenant_rewrite_allowed($1::uuid)`, [H1]),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.end();
    }
  });

  it('each guard refuses a DELETE outside the replace run and admits it only inside', async () => {
    const failures: string[] = [];
    const client = await appClient();
    try {
      for (const pair of pairs) {
        await client.query('BEGIN');
        try {
          await probe(client, pair);
          await claim(client);
          const label = `${pair.fn} on ${pair.table}`;
          const inside = {
            role: 'nexa_system' as const,
            reason: TENANT_REPLACE_REASON,
            rewrite: REQUEST,
          };
          const cases: [string, Outcome, 'refused' | 'deleted'][] = [
            ['outside', await attempt(client, pair, H1, { ...inside, rewrite: '' }), 'refused'],
            ['inside', await attempt(client, pair, H1, inside), 'deleted'],
            [
              'not system',
              // nexa_app can set the reason itself: the role is what it cannot be.
              await attempt(client, pair, H1, { ...inside, role: 'none' }),
              'refused',
            ],
            [
              'wrong reason',
              await attempt(client, pair, H1, { ...inside, reason: OTHER_REASON }),
              'refused',
            ],
            ['other tenant', await attempt(client, pair, H2, inside), 'refused'],
            [
              'not applying',
              await attempt(client, pair, H1, {
                ...inside,
                before: `UPDATE tenant_restores SET state = 'VERIFIED' WHERE id = $1`,
              }),
              'refused',
            ],
            [
              'other run',
              await attempt(client, pair, H1, { ...inside, rewrite: randomUUID() }),
              'refused',
            ],
          ];
          for (const [name, outcome, want] of cases) {
            const good =
              want === 'deleted' ? outcome.ok && outcome.rows === 1 : refusedByGuard(outcome);
            if (!good) failures.push(`${label}: ${name} → ${JSON.stringify(outcome)}`);
          }
        } finally {
          await client.query('COMMIT');
        }
        // A transaction that did not claim the allowance: the earlier claim is dead.
        await client.query('BEGIN');
        try {
          await probe(client, pair);
          const stale = await attempt(client, pair, H1, {
            role: 'nexa_system',
            reason: TENANT_REPLACE_REASON,
            rewrite: REQUEST,
          });
          if (!refusedByGuard(stale)) {
            failures.push(`${pair.fn} on ${pair.table}: stale claim → ${JSON.stringify(stale)}`);
          }
        } finally {
          await client.query('ROLLBACK');
        }
      }
    } finally {
      await client.end();
    }
    expect(failures).toEqual([]);
  }, 300_000);

  it('the allowance admits DELETE only: an UPDATE stays refused inside the run', async () => {
    const client = await appClient();
    const pair = { fn: 'nexa_reject_mutation', table: 'audit_logs' };
    try {
      await client.query('BEGIN');
      await probe(client, pair);
      await client.query(
        `CREATE TRIGGER rewrite_probe_update BEFORE UPDATE ON pg_temp.audit_logs
           FOR EACH ROW EXECUTE FUNCTION public.nexa_reject_mutation()`,
      );
      await claim(client);
      await client.query(
        `SELECT set_config('role', 'nexa_system', true), set_config('app.system_reason', $1, true),
                set_config('nexa.tenant_rewrite', $2, true)`,
        [TENANT_REPLACE_REASON, REQUEST],
      );
      await expect(
        client.query(`UPDATE pg_temp.audit_logs SET action = 'x' WHERE tenant_id = $1`, [H1]),
      ).rejects.toMatchObject({ code: '23001' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  });
});
