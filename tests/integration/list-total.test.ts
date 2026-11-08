import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { DrizzleOrderRepository } from '../../apps/api/src/modules/commerce/orders/infrastructure/drizzle-order.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import {
  LIST_TOTAL_EXACT_CEILING,
  listTotal,
} from '../../apps/api/src/infrastructure/persistence/list-total';
import { customers } from '../../apps/api/src/infrastructure/persistence/schema';
import { createTestContext, tenantA, tenantB, type TestContext } from './harness';

/**
 * The count chip's total (web redesign PR-10), on tables the size a Mirza import makes.
 *
 * What this file protects, each with the way it fails when reverted:
 *
 * - A big selection is NOT counted. `estimated: true` is only ever returned by the planner
 *   path, so seeing it on 200 000 rows proves no `count(*)` ran; replacing the estimate with
 *   an exact count flips the flag and fails here.
 * - The answer comes back inside a time bound far below what a count of the tenant costs
 *   on a loaded server, so a regression that scans shows up as a slow test.
 * - A small selection (a filter that matches a handful of rows, or a small tenant) IS
 *   exact, so the chip shows «۷», not «حدود ۷».
 * - Another tenant's rows are in neither figure.
 * - A total that cannot be produced in time is `null` and the call returns, which is what
 *   lets the page draw its list without it.
 *
 * The three repositories are the real ones; the fixture is written straight in, the way
 * `services-plan.test.ts` does, because 600 000 settled orders is a fixture nobody can
 * afford and nothing here asserts product behaviour.
 */
const BIG = 200_000;
const SMALL = 3_000;
const BLOCKED = 7;
/** Generous for a loaded CI runner and still two orders below a scan of 200k rows ×3. */
const BOUND_MS = 400;

describe('list totals on large tables', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.reset();
    await ctx.container.database.withClient(async (client) => {
      await client.query('SET statement_timeout = 0');
      try {
        for (const [scope, offset, rows] of [
          [tenantA, 0, BIG],
          [tenantB, BIG, SMALL],
        ] as const) {
          const panelId = ctx.container.ids.uuid();
          const productId = ctx.container.ids.uuid();
          const customerId = ctx.container.ids.uuid();
          await client.query(
            `INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
               VALUES ($1::uuid, $2::uuid, $3, 'marzban', 'https://total.example.test', 'ACTIVE')`,
            [panelId, scope.tenantId, `Total panel ${String(offset)}`],
          );
          await client.query(
            `INSERT INTO products
               (id, tenant_id, title, status, audience, sort_order, panel_id, duration_days,
                traffic_bytes, price_amount, price_currency)
               VALUES ($1::uuid, $2::uuid, 'total', 'ACTIVE', 'EVERYONE', 0, $3::uuid, 30,
                       53687091200, 250000, 'IRT')`,
            [productId, scope.tenantId, panelId],
          );
          await client.query(
            `INSERT INTO customers (id, tenant_id, telegram_user_id, status)
               VALUES ($1::uuid, $2::uuid, $3, 'ACTIVE')`,
            [customerId, scope.tenantId, String(700_000_000 + offset)],
          );
          await client.query(
            `INSERT INTO customers
               (id, tenant_id, telegram_user_id, username, status, blocked_at, created_at)
               SELECT gen_random_uuid(), $1::uuid, ($2::int + g)::text, 'member' || ($2::int + g),
                      CASE WHEN g <= $4::int THEN 'BLOCKED' ELSE 'ACTIVE' END,
                      CASE WHEN g <= $4::int THEN now() END,
                      now() - ((g) || ' seconds')::interval
                 FROM generate_series(1, $3::int) AS g`,
            [scope.tenantId, 900_000_000 + offset, rows, scope === tenantA ? BLOCKED : 0],
          );
          await client.query(
            `INSERT INTO orders
               (id, tenant_id, customer_id, state, product_id, panel_id, line_title,
                line_duration_days, line_traffic_bytes, line_unit_price_amount, line_quantity,
                subtotal_amount, discount_amount, total_amount, currency, quote, settled_at,
                refunded_at, created_at)
               SELECT ('00000000-0000-4000-8000-' || lpad(($2::int + g)::text, 12, '0'))::uuid,
                      $1::uuid, $3::uuid,
                      CASE WHEN g <= $7::int THEN 'REFUNDED' ELSE 'PAID' END,
                      $4::uuid, $5::uuid, 'total', 30,
                      53687091200, 250000, 1, 250000, 0, 250000, 'IRT', '{}'::jsonb, now(),
                      CASE WHEN g <= $7::int THEN now() END,
                      now() - ((g) || ' seconds')::interval
                 FROM generate_series(1, $6::int) AS g`,
            [scope.tenantId, offset, customerId, productId, panelId, rows, BLOCKED],
          );
          await client.query(
            `INSERT INTO services
               (id, tenant_id, customer_id, order_id, panel_id, product_id, provider_username,
                state, delivery_state, traffic_limit_bytes, traffic_used_bytes, created_at,
                updated_at, provisioned_at, delivered_at)
               SELECT gen_random_uuid(), $1::uuid, $2::uuid,
                      ('00000000-0000-4000-8000-' || lpad(($3::int + g)::text, 12, '0'))::uuid,
                      $4::uuid, $5::uuid, 'nxtotal' || ($3::int + g), 'ACTIVE', 'DELIVERED',
                      53687091200, 0,
                      now() - ((g) || ' seconds')::interval,
                      now() - ((g) || ' seconds')::interval,
                      now() - ((g) || ' seconds')::interval,
                      now() - ((g) || ' seconds')::interval
                 FROM generate_series(1, $6::int) AS g`,
            [scope.tenantId, customerId, offset, panelId, productId, rows],
          );
        }
        // The planner estimates from STATISTICS; an un-analysed table looks empty.
        await client.query('ANALYZE customers');
        await client.query('ANALYZE orders');
        await client.query('ANALYZE services');
      } finally {
        await client.query('RESET statement_timeout');
      }
    });
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const timed = async <T>(run: () => Promise<T>): Promise<{ result: T; ms: number }> => {
    const start = performance.now();
    const result = await run();
    return { result, ms: performance.now() - start };
  };

  const within = (value: number, expected: number) =>
    expect(Math.abs(value - expected) / expected).toBeLessThan(0.1);

  it('estimates the customers of a 200k tenant instead of counting them', async () => {
    const repository = new DrizzleCustomerRepository(ctx.container.database.db);
    const { result, ms } = await timed(() => repository.total(tenantA, {}));
    expect(result).not.toBeNull();
    expect(result?.estimated).toBe(true);
    within(result?.value ?? 0, BIG + 1);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it('estimates the orders and the services of a 200k tenant the same way', async () => {
    const orders = new DrizzleOrderRepository(ctx.container.database.db);
    const services = new DrizzleServiceRepository(ctx.container.database.db);
    const o = await timed(() => orders.total(tenantA, {}, []));
    const s = await timed(() => services.total(tenantA, {}));
    for (const [one, expected] of [
      [o, BIG],
      [s, BIG],
    ] as const) {
      expect(one.result?.estimated).toBe(true);
      within(one.result?.value ?? 0, expected);
      expect(one.ms).toBeLessThan(BOUND_MS);
    }
  });

  it('counts exactly when a filter makes the selection small', async () => {
    const customersRepo = new DrizzleCustomerRepository(ctx.container.database.db);
    const ordersRepo = new DrizzleOrderRepository(ctx.container.database.db);
    expect(await customersRepo.total(tenantA, { status: 'BLOCKED' })).toEqual({
      value: BLOCKED,
      estimated: false,
    });
    expect(await ordersRepo.total(tenantA, { state: 'REFUNDED' }, [])).toEqual({
      value: BLOCKED,
      estimated: false,
    });
  });

  it('counts a small tenant exactly and never includes another tenant', async () => {
    const customersRepo = new DrizzleCustomerRepository(ctx.container.database.db);
    const servicesRepo = new DrizzleServiceRepository(ctx.container.database.db);
    // The tenant's own one-row customer plus the generated ones.
    expect(await customersRepo.total(tenantB, {})).toEqual({ value: SMALL + 1, estimated: false });
    expect(await servicesRepo.total(tenantB, {})).toEqual({ value: SMALL, estimated: false });
  });

  it('returns the estimate, executing no count, when the count itself is planned as costly', async () => {
    // The same 7-row selection that is exact above, with the cost ceiling lowered under the
    // count's plan: the planner's row estimate is returned and flagged, nothing is counted.
    const out = await listTotal(
      ctx.container.database.db,
      customers,
      sql`${customers.tenantId} = ${tenantA.tenantId} AND ${customers.status} = 'BLOCKED'`,
      { countCostCeiling: 1 },
    );
    expect(out?.estimated).toBe(true);
    expect(out?.value).toBeGreaterThan(0);
  });

  it('keeps the exact path under the ceiling', () => {
    expect(LIST_TOTAL_EXACT_CEILING).toBeLessThan(SMALL * 2);
  });

  it('returns null, and returns, when the figure cannot be produced in time', async () => {
    // One row by the planner's estimate (equality on a unique key), so the exact path runs
    // — and `pg_sleep` per examined row outlives the statement timeout.
    const { result, ms } = await timed(() =>
      listTotal(
        ctx.container.database.db,
        customers,
        sql`${customers.tenantId} = ${tenantA.tenantId} AND ${customers.telegramUserId} = '900000001' AND pg_sleep(5) IS NOT NULL`,
      ),
    );
    expect(result).toBeNull();
    expect(ms).toBeLessThan(4_000);
  }, 20_000);
});
