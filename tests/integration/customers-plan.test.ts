import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { createTestContext, tenantA, tenantB, type TestContext } from './harness';

/**
 * The customer indexes, asked of the PLANNER.
 *
 * An index is a claim until something reads the plan. `customers_tenant_username_idx`
 * existed from the first schema commit, `drizzle-customer.repository.ts` said in a
 * comment that the username search used it, and the planner ignored it completely: a
 * default-collation btree cannot serve `lower(username) LIKE 'x%'`, so the search walked
 * `customers_tenant_created_idx` and filtered. On 20 000 customers in one tenant that was
 * 12 289 rows discarded to return 26, at 364 shared buffers — and nothing in the suite
 * could tell, because a filtered scan returns the same rows.
 *
 * Migration 0036 added `text_pattern_ops`. This file is what stops the pair drifting
 * again: it asserts the INDEX NAME appears in the plan and that the prefix is an Index
 * Cond rather than a Filter, which is the difference between a bounded scan and a walk of
 * the tenant.
 *
 * Both queries are issued through the REAL repository, so the statement under test is the
 * one production sends. `panel-monitor-scale.test.ts` records why a retyped query in a
 * test proves a plan for something nobody runs.
 */

/** Enough rows that the planner has a reason to prefer an index. */
const ROWS = 20_000;
const PAGE = 25;

describe('the customer query plans', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.reset();
    await ctx.container.database.withClient(async (client) => {
      // Both tenants, so the leading `tenant_id` column is doing work rather than
      // matching everything. A single-tenant fixture makes any index look selective.
      for (const [scope, offset] of [
        [tenantA, 0],
        [tenantB, ROWS],
      ] as const) {
        await client.query(
          `INSERT INTO customers (id, tenant_id, telegram_user_id, username, status, created_at)
             SELECT gen_random_uuid(), $1::uuid, ($2::int + g)::text, 'member' || ($2::int + g),
                    'ACTIVE', now() - ((g) || ' seconds')::interval
               FROM generate_series(1, $3::int) AS g`,
          [scope.tenantId, 900_000_000 + offset, ROWS],
        );
      }
      // The planner chooses on STATISTICS. Without this the table looks empty and every
      // plan is a sequential scan, which would make the assertions below pass or fail
      // for a reason unrelated to the indexes.
      await client.query('ANALYZE customers');
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  /**
   * The plan for the statement the REPOSITORY builds, not a retyped one.
   *
   * Drizzle's `toSQL()` gives the text and the parameters it would send, so the plan is
   * for production's own query. A hand-written equivalent in a test is a plan for a
   * query nobody runs — the defect `panel-monitor-scale.test.ts` records in full.
   */
  const planFor = async (build: () => { sql: string; params: readonly unknown[] }) => {
    const { sql, params } = build();
    return ctx.container.database.withClient(async (client) => {
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF) ${sql}`,
        [...params],
      );
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });
  };

  /** The rows the executor threw away, which is what a filtered scan costs. */
  const removedByFilter = (plan: string): number => {
    const match = /Rows Removed by Filter: (\d+)/.exec(plan);
    return match === null ? 0 : Number(match[1]);
  };

  it('serves the username PREFIX search from customers_tenant_username_idx', async () => {
    const repository = new DrizzleCustomerRepository(ctx.container.database.db);
    const plan = await planFor(() => {
      // `list` is async and builds its statement internally, so the query is rebuilt here
      // from the repository's OWN predicate — the `sql` template it pushes — by calling it
      // and capturing the statement drizzle would send.
      const built = repository.listStatement(tenantA, { usernamePrefix: 'member9001' }, PAGE, null);
      const compiled = built.toSQL();
      return { sql: compiled.sql, params: compiled.params };
    });

    expect(plan, `the username index is not in the plan:\n${plan}`).toContain(
      'customers_tenant_username_idx',
    );
    /*
     * An Index COND, not a Filter, and the distinction is the whole finding.
     *
     * A `Filter: (lower(username) ~~ 'member9001%')` line means the executor read rows
     * and threw them away; an `Index Cond` carrying `~>=~` and `~<~` means the prefix
     * bounded the scan. Both return the same rows, which is why only the plan can tell
     * them apart.
     */
    expect(plan, `the prefix did not bound the scan:\n${plan}`).toMatch(/Index Cond:.*~>=~/s);
    // A few rows may still be re-checked — the `LIKE` is kept as a Filter beside the
    // range — but not thousands. Before 0036 this number was 12 289.
    expect(removedByFilter(plan), `too many rows discarded:\n${plan}`).toBeLessThan(500);
  }, 60_000);

  it('serves the keyset page from customers_tenant_created_idx', async () => {
    const repository = new DrizzleCustomerRepository(ctx.container.database.db);
    const anchor = await ctx.container.database.withClient(async (client) => {
      const { rows } = await client.query<{ id: string; at: string }>(
        `SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
           FROM customers WHERE tenant_id = $1 ORDER BY created_at ASC, id ASC LIMIT 1`,
        [tenantA.tenantId],
      );
      return rows[0] as { id: string; at: string };
    });

    const plan = await planFor(() => {
      const built = repository.listStatement(tenantA, {}, PAGE, {
        createdAt: anchor.at,
        id: anchor.id as never,
      });
      const compiled = built.toSQL();
      return { sql: compiled.sql, params: compiled.params };
    });

    expect(plan, `the pagination index is not in the plan:\n${plan}`).toContain(
      'customers_tenant_created_idx',
    );
    // The keyset is INSIDE the Index Cond, so the scan starts at the cursor rather than
    // at the tenant's first row. A cursor in a Filter would re-read and discard every
    // page already served, which is the cost an OFFSET has and a keyset exists to avoid.
    expect(plan, `the cursor did not bound the scan:\n${plan}`).toMatch(/Index Cond:.*ROW\(/s);
    expect(plan, 'the page was sorted rather than read in order').not.toContain('Sort Key:');
  }, 60_000);
});
