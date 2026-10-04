import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database } from '../../apps/api/src/infrastructure/persistence/database';
import { DrizzleReportingRepository } from '../../apps/api/src/modules/commerce/reporting/infrastructure/drizzle-reporting.repository';
import { createTestContext, tenantA, tenantB, type TestContext } from './harness';

/**
 * The dashboard's sales aggregates, asked of the PLANNER (Issue 16,
 * `docs/perf/web-admin-navigation.md`).
 *
 * `GET /dashboard/summary` runs 29 statements, most of them a windowed aggregate over the
 * tenant's PAID orders by `settled_at`. With no index on `settled_at` every one of them
 * was a sequential scan of the tenant's whole order history — the same rows, so no
 * behavioural test could tell — measured at 1.2–1.6 s per dashboard request on 320 000
 * orders. `orders_tenant_paid_settled_idx` (`online-indexes.ts`) is the fix, and this
 * file is what says the statements the REAL repository sends reach it.
 *
 * The statements are captured, not retyped: the repository is given a database whose
 * `execute` records each compiled statement on its way through, so a change to the SQL
 * is a change to what is explained here. Two tenants of 20 000 orders over a year, three
 * in four paid, so a thirty-day window is about one twelfth of one tenant — the case a
 * range index is for — and the other tenant's rows are there to be skipped.
 */
const ROWS = 20_000;
const DAY_MS = 86_400_000;

describe('the reporting query plans', () => {
  let ctx: TestContext;
  const dialect = new PgDialect();
  let captured: { sql: string; params: unknown[] }[] = [];
  let repository: DrizzleReportingRepository;
  let window: { from: Date; to: Date };

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.reset();
    const real = ctx.container.database.db;
    const recording = {
      execute: (query: SQL) => {
        const compiled = dialect.sqlToQuery(query);
        captured.push({ sql: compiled.sql, params: [...compiled.params] });
        return real.execute(query);
      },
    } as unknown as Database;
    repository = new DrizzleReportingRepository(recording);
    const now = Date.now();
    window = { from: new Date(now - 30 * DAY_MS), to: new Date(now) };

    await ctx.container.database.withClient(async (client) => {
      // A fixture, not an application statement: see `services-plan.test.ts`.
      await client.query('SET statement_timeout = 0');
      try {
        for (const scope of [tenantA, tenantB]) {
          const panelId = ctx.container.ids.uuid();
          await client.query(
            `INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
               VALUES ($1::uuid, $2::uuid, 'Plan panel', 'marzban', 'https://plan.example.test', 'ACTIVE')`,
            [panelId, scope.tenantId],
          );
          await client.query(
            `INSERT INTO products
               (id, tenant_id, title, status, audience, sort_order, panel_id, duration_days,
                traffic_bytes, price_amount, price_currency)
               SELECT gen_random_uuid(), $1::uuid, 'Plan ' || k, 'ACTIVE', 'EVERYONE', k,
                      $2::uuid, 30, 53687091200, 250000, 'IRT'
                 FROM generate_series(1, 10) AS k`,
            [scope.tenantId, panelId],
          );
          await client.query(
            `INSERT INTO customers (id, tenant_id, telegram_user_id, status)
               SELECT gen_random_uuid(), $1::uuid, 'plan-' || $1::text || '-' || g, 'ACTIVE'
                 FROM generate_series(1, $2::int) AS g`,
            [scope.tenantId, ROWS / 4],
          );
          // One year of orders, oldest first; one in four is not PAID (and so has no
          // settlement), the states a real history holds beside its sales.
          await client.query(
            `INSERT INTO orders
               (id, tenant_id, customer_id, state, product_id, panel_id, line_title,
                line_duration_days, line_traffic_bytes, line_unit_price_amount, line_quantity,
                subtotal_amount, discount_amount, total_amount, currency, quote, settled_at,
                cancelled_at, created_at)
               SELECT gen_random_uuid(), $1::uuid, c.id,
                      CASE WHEN g % 4 = 0 THEN 'CANCELLED' ELSE 'PAID' END,
                      p.id, $2::uuid, p.title, 30, 53687091200, 250000, 1, 250000, 0, 250000,
                      'IRT', '{}'::jsonb,
                      CASE WHEN g % 4 = 0 THEN NULL ELSE t END,
                      CASE WHEN g % 4 = 0 THEN t END, t
                 FROM generate_series(1, $3::int) AS g
                 CROSS JOIN LATERAL (SELECT now() - (g * interval '1 day' * 365 / $3::int) AS t) s
                 JOIN (SELECT id, row_number() OVER (ORDER BY id) AS n
                         FROM customers WHERE tenant_id = $1::uuid) c ON c.n = 1 + g % ($3::int / 4)
                 JOIN (SELECT id, title, row_number() OVER (ORDER BY sort_order) AS k
                         FROM products WHERE tenant_id = $1::uuid) p ON p.k = 1 + g % 10`,
            [scope.tenantId, panelId, ROWS],
          );
        }
        // What autovacuum leaves a live table in: statistics, and a visibility map that
        // lets an index-only scan skip the heap.
        await client.query('VACUUM ANALYZE orders');
      } finally {
        await client.query('RESET statement_timeout');
      }
    });
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const explain = async (statement: { sql: string; params: unknown[] }): Promise<string> =>
    ctx.container.database.withClient(async (client) => {
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF) ${statement.sql}`,
        statement.params,
      );
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });

  /** The buffers the plan's top node reports, which include every node beneath it. */
  const buffersIn = (plan: string): number => {
    const match = /Buffers: shared( hit=(\d+))?( read=(\d+))?/.exec(plan);
    return match === null ? 0 : Number(match[2] ?? 0) + Number(match[4] ?? 0);
  };

  /** The one statement a call sent, captured on its way through. */
  const statementOf = async (call: () => Promise<unknown>) => {
    captured = [];
    await call();
    expect(captured).toHaveLength(1);
    return captured[0]!;
  };

  const shapes: readonly {
    readonly what: string;
    readonly call: () => Promise<unknown>;
  }[] = [
    {
      what: 'salesTotals (the KPI pairs, eight per dashboard request)',
      call: () => repository.salesTotals(tenantA, window),
    },
    {
      what: 'trend REVENUE (the revenue series)',
      call: () =>
        repository.trend(tenantA, 'REVENUE', 'IRT', [
          window.from,
          new Date(window.from.getTime() + 15 * DAY_MS),
          window.to,
        ]),
    },
    {
      what: 'salesTrendByPurpose (sales by kind)',
      call: () =>
        repository.salesTrendByPurpose(tenantA, [
          window.from,
          new Date(window.from.getTime() + 15 * DAY_MS),
          window.to,
        ]),
    },
    {
      what: 'revenueCurrencies',
      call: () => repository.revenueCurrencies(tenantA, [window]),
    },
  ];

  for (const shape of shapes) {
    it(`serves ${shape.what} from orders_tenant_paid_settled_idx`, async () => {
      const plan = await explain(await statementOf(shape.call));
      expect(plan, `the paid-settlement index is not in the plan:\n${plan}`).toContain(
        'orders_tenant_paid_settled_idx',
      );
      // The window BOUNDS the scan: `settled_at` is in the Index Cond, not a Filter over
      // the tenant's history.
      expect(plan, `the window did not bound the scan:\n${plan}`).toMatch(
        /Index Cond:.*settled_at/s,
      );
      expect(plan, `the orders heap was walked:\n${plan}`).not.toContain('Seq Scan on orders');
      /*
       * Measured on this fixture: 38 buffers for `salesTotals` with the index (an
       * index-only range of 1 233 entries, no heap fetch), and 620 with the declaration
       * deleted — a sequential scan of both tenants' 40 000 orders, which kills all four
       * of these. The threshold sits between with room on both sides.
       */
      expect(buffersIn(plan), `more than the window was read:\n${plan}`).toBeLessThan(200);
    }, 60_000);
  }

  it('still answers what the sequential scan answered', async () => {
    // A plan test proves nothing if the planned statement now counts something else.
    const totals = await repository.salesTotals(tenantA, window);
    const expected = await ctx.container.database.withClient(async (client) => {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM orders
          WHERE tenant_id = $1::uuid AND state = 'PAID'
            AND settled_at >= $2::timestamptz AND settled_at < $3::timestamptz`,
        [tenantA.tenantId, window.from.toISOString(), window.to.toISOString()],
      );
      return rows[0]?.n ?? 0;
    });
    expect(expected).toBeGreaterThan(1_000);
    expect(totals.successfulOrders).toBe(expected);
  }, 60_000);
});
