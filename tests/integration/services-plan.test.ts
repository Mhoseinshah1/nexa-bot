import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { createTestContext, tenantA, tenantB, type TestContext } from './harness';

/**
 * The service lookup, asked of the PLANNER.
 *
 * An index is a claim until something reads the plan. `customers-plan.test.ts` records
 * what that costs when nobody checks: an index existed from the first schema commit, a
 * repository comment said the search used it, and the planner ignored it completely —
 * 12 289 rows discarded to return 26, with nothing in the suite able to tell, because a
 * filtered scan returns the same rows.
 *
 * This file is the same guard for WP3's lookup. `services_tenant_provider_username_idx`
 * is built OUTSIDE the migrator — see `infrastructure/persistence/online-indexes.ts` for
 * why a populated table's index cannot be an ordinary `CREATE INDEX` in a migration —
 * and `online-indexes.test.ts` asserts it exists and matches its declaration. What only
 * a plan can say is whether the query the repository actually sends reaches it.
 *
 * The statement comes from the REAL repository through `listStatement`, so this explains
 * production's own query rather than a retyped equivalent.
 */

/** Enough rows that the planner has a reason to prefer an index. */
const ROWS = 20_000;

describe('the service query plans', () => {
  let ctx: TestContext;
  /** A name that exists, taken from the fixture rather than guessed. */
  let needle: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.reset();
    await ctx.container.database.withClient(async (client) => {
      /*
       * The fixture is not an application statement, so the application's
       * `statement_timeout` (15 s) does not bound it. Forty thousand FK-checked inserts
       * overran it on a contended CI runner (PR #69's re-run: `57014` inside the services
       * insert's `FOR KEY SHARE` on `orders`), failing the suite in setup before a single
       * plan was read. Lifted for this session only and put back in `finally`, because a
       * pooled connection that kept `0` would unbound the next borrower's real work.
       */
      await client.query('SET statement_timeout = 0');
      try {
        /*
         * Rows written straight in, unlike the behavioural suites.
         *
         * This file measures the PLANNER, and twenty thousand settled orders is a fixture
         * nobody can afford. Nothing here asserts product behaviour: the only properties
         * that matter are the row count, the two tenants and the column values the index
         * covers. `customers-plan.test.ts` builds its fixture the same way for the same
         * reason.
         *
         * BOTH tenants, so the leading `tenant_id` column is doing work rather than
         * matching everything. A single-tenant fixture makes any index look selective,
         * and this index exists precisely to keep one tenant's lookup off another's rows.
         */
        for (const [scope, offset] of [
          [tenantA, 0],
          [tenantB, ROWS],
        ] as const) {
          const panelId = ctx.container.ids.uuid();
          const productId = ctx.container.ids.uuid();
          const customerId = ctx.container.ids.uuid();
          await client.query(
            `INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
               VALUES ($1::uuid, $2::uuid, $3, 'marzban', 'https://plan.example.test', 'ACTIVE')`,
            [panelId, scope.tenantId, `Plan panel ${String(offset)}`],
          );
          await client.query(
            `INSERT INTO products
               (id, tenant_id, title, status, audience, sort_order, panel_id, duration_days,
                traffic_bytes, price_amount, price_currency)
               VALUES ($1::uuid, $2::uuid, 'plan', 'ACTIVE', 'EVERYONE', 0, $3::uuid, 30,
                       53687091200, 250000, 'IRT')`,
            [productId, scope.tenantId, panelId],
          );
          await client.query(
            `INSERT INTO customers (id, tenant_id, telegram_user_id, status)
               VALUES ($1::uuid, $2::uuid, $3, 'ACTIVE')`,
            [customerId, scope.tenantId, String(800_000_000 + offset)],
          );
          /*
           * One order per service, because `services.order_id` is NOT NULL and
           * `services_tenant_order_key` is unique on `(tenant_id, order_id)`. The rows
           * are minimal but real: every NOT NULL column and every CHECK the schema
           * declares is satisfied, so this fixture is a state the product could have
           * produced — just produced far faster than twenty thousand settled orders.
           */
          await client.query(
            `INSERT INTO orders
               (id, tenant_id, customer_id, state, product_id, panel_id, line_title,
                line_duration_days, line_traffic_bytes, line_unit_price_amount, line_quantity,
                subtotal_amount, discount_amount, total_amount, currency, quote, settled_at,
                created_at)
               SELECT ('00000000-0000-4000-8000-' || lpad(($2::int + g)::text, 12, '0'))::uuid,
                      $1::uuid, $3::uuid, 'PAID', $4::uuid, $5::uuid, 'plan', 30,
                      53687091200, 250000, 1, 250000, 0, 250000, 'IRT', '{}'::jsonb, now(),
                      now() - ((g) || ' seconds')::interval
                 FROM generate_series(1, $6::int) AS g`,
            [scope.tenantId, offset, customerId, productId, panelId, ROWS],
          );
          await client.query(
            `INSERT INTO services
               (id, tenant_id, customer_id, order_id, panel_id, product_id, provider_username,
                state, delivery_state, traffic_limit_bytes, traffic_used_bytes, created_at,
                updated_at, provisioned_at, delivered_at)
               SELECT gen_random_uuid(), $1::uuid, $2::uuid,
                      ('00000000-0000-4000-8000-' || lpad(($3::int + g)::text, 12, '0'))::uuid,
                      $4::uuid, $5::uuid, 'nxplan' || ($3::int + g), 'ACTIVE', 'DELIVERED',
                      53687091200, 0,
                      now() - ((g) || ' seconds')::interval,
                      now() - ((g) || ' seconds')::interval,
                      now() - ((g) || ' seconds')::interval,
                      now() - ((g) || ' seconds')::interval
                 FROM generate_series(1, $6::int) AS g`,
            [scope.tenantId, customerId, offset, panelId, productId, ROWS],
          );
        }
        /*
         * The planner chooses on STATISTICS. Without this the table looks empty and every
         * plan is a sequential scan, which would make the assertion below pass or fail for
         * a reason unrelated to the index.
         */
        await client.query('ANALYZE services');
      } finally {
        await client.query('RESET statement_timeout');
      }
    });
    needle = 'nxplan9001';
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

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

  it('serves the provider-username lookup from services_tenant_provider_username_idx', async () => {
    const repository = new DrizzleServiceRepository(ctx.container.database.db);
    const plan = await planFor(() => {
      const compiled = repository
        .listStatement(tenantA, { providerUsername: needle }, 25, null)
        .toSQL();
      return { sql: compiled.sql, params: compiled.params };
    });

    /*
     * The NAME, because the only other index that carries `provider_username` is
     * `services_panel_provider_username_key`, which leads with `panel_id` and cannot
     * serve a tenant-scoped lookup at all. A plan naming that one instead would mean the
     * query had been rewritten to take a panel, which is a different feature.
     */
    expect(plan, `the lookup index is not in the plan:\n${plan}`).toContain(
      'services_tenant_provider_username_idx',
    );
    /*
     * An Index COND, not a Filter, and the distinction is the whole point.
     *
     * A `Filter: (provider_username = 'nxplan9001')` line means the executor read rows
     * and threw them away; an Index Cond means the name bounded the scan. Both return
     * the same one row, which is why only the plan can tell them apart — exactly the
     * blindness `customers-plan.test.ts` was written after.
     */
    expect(plan, `the name did not bound the scan:\n${plan}`).toMatch(
      /Index Cond:.*provider_username/s,
    );
    expect(removedByFilter(plan), `rows were read and discarded:\n${plan}`).toBeLessThan(500);
  }, 60_000);
});
