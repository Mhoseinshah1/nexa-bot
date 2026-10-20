import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceSearch } from '../../apps/api/src/modules/commerce/provisioning/application/ports';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { createTestContext, tenantA, tenantB, type TestContext } from './harness';

/**
 * The operator's services list after a LARGE import, asked of the planner (Track 3 §3).
 *
 * The one-time import writes a tenant's whole history at once — hundreds of thousands of
 * ended services beside a few thousand live ones — and the list's three tabs each have to
 * reach their first page without walking that history. The order is
 * `COALESCE(original_started_at, created_at) DESC, id DESC`, and three online indexes serve
 * it (`online-indexes.ts`): one per tab shape. A plan that sorts, or that reads the ended
 * history to find the live page, returns the same 25 rows — which is why only the plan can
 * tell, and why this file reads it rather than timing a query.
 *
 * The statement is the REAL repository's, through `listStatement`.
 */

/** The imported history: ended services. */
const ENDED = 190_000;
/** What is still live. Five percent: a scan that filtered instead of bounding would show. */
const LIVE = 10_000;
/** Another tenant's rows, so the leading `tenant_id` is doing work. */
const FOREIGN = 5_000;
const PAGE = 25;

/**
 * A distinct public code per row, written by the fixture rather than drawn by the insert
 * trigger (`nexa_assign_public_code`). The trigger looks each candidate up in a table the
 * planner still believes is empty, which is a sequential scan per row — quadratic over 200 000
 * rows, and what made this file's setup outlast its hook timeout. The code is the four-letter
 * `prefix` plus the row number in the code alphabet (30^4 > 200 000), so it is unique per tenant
 * and well-formed (`PUBLIC_CODE_ALPHABET`).
 */
const CODE_SQL = (prefix: string, n: string): string =>
  `'${prefix}' || substr('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + (${n} / 27000) % 30, 1)
        || substr('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + (${n} / 900) % 30, 1)
        || substr('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + (${n} / 30) % 30, 1)
        || substr('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + ${n} % 30, 1)`;

describe('the services list plans over 200 000 services', () => {
  let ctx: TestContext;
  let repository: DrizzleServiceRepository;

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.reset();
    await ctx.container.database.withClient(async (client) => {
      // A fixture, not an application statement: see `services-plan.test.ts`.
      await client.query('SET statement_timeout = 0');
      try {
        for (const [scope, rows, offset] of [
          [tenantA, ENDED + LIVE, 0],
          [tenantB, FOREIGN, ENDED + LIVE],
        ] as const) {
          const panelId = ctx.container.ids.uuid();
          const productId = ctx.container.ids.uuid();
          const customerId = ctx.container.ids.uuid();
          await client.query(
            `INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
               VALUES ($1::uuid, $2::uuid, $3, 'marzban', 'https://plan.example.test', 'ACTIVE')`,
            [panelId, scope.tenantId, `Started plan panel ${String(offset)}`],
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
            [customerId, scope.tenantId, String(810_000_000 + offset)],
          );
          await client.query(
            `INSERT INTO orders
               (id, tenant_id, customer_id, state, product_id, panel_id, line_title,
                line_duration_days, line_traffic_bytes, line_unit_price_amount, line_quantity,
                subtotal_amount, discount_amount, total_amount, currency, quote, settled_at,
                created_at, code)
               SELECT ('00000000-0000-4000-8000-' || lpad(($2::int + g)::text, 12, '0'))::uuid,
                      $1::uuid, $3::uuid, 'PAID', $4::uuid, $5::uuid, 'plan', 30,
                      53687091200, 250000, 1, 250000, 0, 250000, 'IRT', '{}'::jsonb, now(),
                      now() - ((g) || ' minutes')::interval,
                      ${CODE_SQL('SPQN', '($2::int + g)')}
                 FROM generate_series(1, $6::int) AS g`,
            [scope.tenantId, offset, customerId, productId, panelId, rows],
          );
          /*
           * Statistics for the orders just written, BEFORE the services insert: its triggers
           * look each row's order up, and a plan made against a table the planner still thinks
           * is empty is a sequential scan per service — minutes, not seconds.
           */
          await client.query('ANALYZE orders');
          /*
           * Every 20th row of tenant A is live and the rest ended, INTERLEAVED in time, as an
           * import's history and a live installation's sales are; a rare few of the live ones
           * are SUSPENDED. One row in ten carries an original date earlier than its
           * `created_at`, as an adopted service does.
           */
          await client.query(
            `INSERT INTO services
               (id, tenant_id, customer_id, order_id, panel_id, product_id, provider_username,
                state, delivery_state, traffic_limit_bytes, traffic_used_bytes, created_at,
                updated_at, provisioned_at, delivered_at, terminated_at, original_started_at, code)
               SELECT gen_random_uuid(), $1::uuid, $2::uuid,
                      ('00000000-0000-4000-8000-' || lpad(($3::int + g)::text, 12, '0'))::uuid,
                      $4::uuid, $5::uuid, 'nxstart' || ($3::int + g),
                      CASE WHEN g % 4000 = 0 THEN 'SUSPENDED'
                           WHEN g % 20 = 0 THEN 'ACTIVE' ELSE 'TERMINATED' END, 'DELIVERED',
                      53687091200, 0,
                      now() - ((g) || ' minutes')::interval,
                      now() - ((g) || ' minutes')::interval,
                      now() - ((g) || ' minutes')::interval,
                      now() - ((g) || ' minutes')::interval,
                      CASE WHEN g % 20 = 0 THEN NULL ELSE now() END,
                      CASE WHEN g % 10 = 3 THEN now() - ((g + 525600) || ' minutes')::interval END,
                      ${CODE_SQL('SPQS', '($3::int + g)')}
                 FROM generate_series(1, $6::int) AS g`,
            [scope.tenantId, customerId, offset, panelId, productId, rows],
          );
        }
        await client.query('VACUUM ANALYZE services');
      } finally {
        await client.query('RESET statement_timeout');
      }
    });
    repository = new DrizzleServiceRepository(ctx.container.database.db);
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const planOf = async (
    search: ServiceSearch,
    cursor: { createdAt: string; id: string } | null,
  ) => {
    const compiled = repository.listStatement(tenantA, search, PAGE, cursor).toSQL();
    return ctx.container.database.withClient(async (client) => {
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF) ${compiled.sql}`,
        [...compiled.params],
      );
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });
  };

  /** Rows the executor read and threw away: what a filtered scan costs. */
  const removedByFilter = (plan: string): number =>
    [...plan.matchAll(/Rows Removed by Filter: (\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);

  /** A cursor from the middle of a tab, taken from the repository's own page. */
  const cursorOf = async (search: ServiceSearch) => {
    const first = await repository.list(tenantA, search, PAGE, null);
    expect(first.items).toHaveLength(PAGE);
    expect(first.nextCursor).not.toBeNull();
    return first.nextCursor;
  };

  /*
   * Which index the planner takes depends on how common the tab's rows are, and it is right
   * to: with ended rows at 95%, the ENDED page is cheapest read off the every-service index,
   * discarding the odd live row. What must hold whatever it picks is the SHAPE — one of the
   * keyset indexes, read in order, stopped by the LIMIT, no sort and almost nothing
   * discarded. The two cases that need a particular index name it: the LIVE tab (5% of rows:
   * any other index discards 19 rows per hit), and a RARE state (SUSPENDED, 50 of 200 000:
   * only the state-leading index finds it without walking the tab).
   */
  const KEYSET_INDEXES = [
    'services_tenant_live_started_page_idx',
    'services_tenant_state_started_page_idx',
    'services_tenant_started_page_idx',
  ];
  for (const [tab, search, index] of [
    ['LIVE', { lifecycle: 'LIVE' }, 'services_tenant_live_started_page_idx'],
    ['ENDED', { lifecycle: 'ENDED' }, null],
    ['ALL', {}, 'services_tenant_started_page_idx'],
    ['common state', { state: 'ACTIVE' }, null],
    ['rare state', { state: 'SUSPENDED' }, 'services_tenant_state_started_page_idx'],
  ] as const) {
    it(`serves the ${tab} page from a keyset index, in order, without a sort`, async () => {
      for (const cursor of [null, await cursorOf(search)]) {
        const plan = await planOf(search, cursor);
        const used = KEYSET_INDEXES.filter((name) => plan.includes(name));
        expect(used, `the ${tab} page used no keyset index:\n${plan}`).toHaveLength(1);
        if (index !== null) {
          expect(plan, `the ${tab} page did not use its index:\n${plan}`).toContain(index);
        }
        /*
         * No Sort node: the index hands the rows over in the list's order, and the LIMIT
         * stops the scan at the page. A sort means every row of the tab was read first.
         */
        expect(plan, `the ${tab} page sorted:\n${plan}`).not.toMatch(/\bSort\b/);
        expect(plan, `the ${tab} page walked the table:\n${plan}`).not.toContain('Seq Scan');
        /*
         * The keyset continuation and the tab bound the scan: it starts at the cursor and
         * reads the page, not the history around it.
         */
        expect(removedByFilter(plan), `rows were read and discarded:\n${plan}`).toBeLessThan(
          PAGE * 2,
        );
      }
    }, 120_000);
  }

  it('pages the LIVE tab newest-first by the original date, never seeing an ended row', async () => {
    const first = await repository.list(tenantA, { lifecycle: 'LIVE' }, PAGE, null);
    const second = await repository.list(tenantA, { lifecycle: 'LIVE' }, PAGE, first.nextCursor);
    const rows = [...first.items, ...second.items];
    expect(rows).toHaveLength(PAGE * 2);
    expect(rows.every((row) => row.state !== 'TERMINATED')).toBe(true);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1]!.originalStartedAt.getTime()).toBeGreaterThanOrEqual(
        rows[i]!.originalStartedAt.getTime(),
      );
    }
  }, 60_000);
});
