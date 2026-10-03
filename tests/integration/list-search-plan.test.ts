import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyListSearch, type ListSearchTerm } from '@nexa/contracts';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { DrizzleOrderRepository } from '../../apps/api/src/modules/commerce/orders/infrastructure/drizzle-order.repository';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { createTestContext, tenantA, tenantB, type TestContext } from './harness';

/**
 * The Web Admin's one search box (spec §10), asked of the PLANNER.
 *
 * Each list's `q` is an OR of exact and prefix matches, and an OR is a bounded BitmapOr
 * only when EVERY arm has an index — one unindexed arm and the whole predicate becomes a
 * Filter over a walk of the tenant's table, which returns exactly the same rows. So the
 * behavioural suite (`list-search.test.ts`) cannot tell a correct search from a sequential
 * scan, and this file is what can: on a seeded dataset of 20 000 rows per table in EACH of
 * two tenants, it explains the statement the REAL repository sends (`listStatement`, or
 * the drizzle builder `list` awaits) and asserts which indexes the planner chose.
 *
 * `customers-plan.test.ts` and `services-plan.test.ts` record why a retyped query proves
 * nothing, and why the index NAME and the Index Cond are both asserted.
 */

const ROWS = 20_000;
const PAGE = 25;
/**
 * A UUIDv7-SHAPED id: the search box reads only a v7 as an internal id, because every id
 * this product mints is one (`classifyListSearch`), so a v4 fixture id would be searched
 * as text and the plan under test would be a different query.
 */
const V7 = "overlay(gen_random_uuid()::text placing '7' from 15)::uuid";

describe('the list-search query plans', () => {
  let ctx: TestContext;
  /** Fixture facts the assertions search for, taken from the rows rather than guessed. */
  const facts = {
    customerId: '',
    orderId: '',
    productId: '',
    paymentId: '',
    panelId: '',
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.reset();
    await ctx.container.database.withClient(async (client) => {
      // The fixture is not an application statement; see `services-plan.test.ts`.
      await client.query('SET statement_timeout = 0');
      try {
        for (const [scope, offset] of [
          [tenantA, 0],
          [tenantB, ROWS],
        ] as const) {
          const panelId = ctx.container.ids.uuid();
          await client.query(
            `INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
               VALUES ($1::uuid, $2::uuid, $3, 'marzban', 'https://plan.example.test', 'ACTIVE')`,
            [panelId, scope.tenantId, `Search panel ${String(offset)}`],
          );
          // Forty products, one of them with a rare name the product-name arm can find.
          await client.query(
            `INSERT INTO products
               (id, tenant_id, title, status, audience, sort_order, panel_id, duration_days,
                traffic_bytes, price_amount, price_currency)
               SELECT gen_random_uuid(), $1::uuid,
                      CASE WHEN k = 40 THEN 'Rare Platinum' ELSE 'Plan ' || k || ' Gold' END,
                      'ACTIVE', 'EVERYONE', k, $2::uuid, 30, 53687091200, 250000, 'IRT'
                 FROM generate_series(1, 40) AS k`,
            [scope.tenantId, panelId],
          );
          await client.query(
            `INSERT INTO customers
               (id, tenant_id, telegram_user_id, username, first_name, last_name, status,
                created_at)
               SELECT ${V7}, $1::uuid, ($2::int + g)::text, 'member' || ($2::int + g),
                      'First' || ($2::int + g), 'Last' || ($2::int + g), 'ACTIVE',
                      now() - ((g) || ' seconds')::interval
                 FROM generate_series(1, $3::int) AS g`,
            [scope.tenantId, 900_000_000 + offset, ROWS],
          );
          // One order per customer, title as snapshot. The rare product is on one order in a
          // thousand, so its name is a SELECTIVE search, which is the case an index is for.
          await client.query(
            `INSERT INTO orders
               (id, tenant_id, customer_id, state, product_id, panel_id, line_title,
                line_duration_days, line_traffic_bytes, line_unit_price_amount, line_quantity,
                subtotal_amount, discount_amount, total_amount, currency, quote, settled_at,
                created_at)
               SELECT ${V7}, c.tenant_id, c.id, 'PAID', p.id, $2::uuid, p.title, 30,
                      53687091200, 250000, 1, 250000, 0, 250000, 'IRT', '{}'::jsonb, now(),
                      c.created_at
                 FROM (SELECT c.*, row_number() OVER (ORDER BY c.created_at) AS n
                         FROM customers c WHERE c.tenant_id = $1::uuid) c
                 JOIN (SELECT p.*, row_number() OVER (ORDER BY p.sort_order) - 1 AS k
                         FROM products p WHERE p.tenant_id = $1::uuid) p ON p.k = CASE WHEN c.n % 1000 = 0 THEN 39 ELSE c.n % 39 END`,
            [scope.tenantId, panelId],
          );
          await client.query(
            `INSERT INTO payments
               (id, tenant_id, customer_id, order_id, state, method, amount, currency,
                reference, external_reference, created_at, updated_at)
               SELECT ${V7}, o.tenant_id, o.customer_id, o.id, 'PENDING',
                      'MANUAL_TRANSFER', 250000, 'IRT', 'ref-' || o.id, 'ext' || c.telegram_user_id,
                      o.created_at, o.created_at
                 FROM orders o JOIN customers c ON c.id = o.customer_id
                WHERE o.tenant_id = $1::uuid`,
            [scope.tenantId],
          );
          // A gateway invoice per payment (Payment Operations Center, program §10), so the
          // provider-reference arm is planned against a populated table: an order id and an
          // invoice id on each, and a NOWPayments-style payment id on one in ten.
          await client.query(
            `INSERT INTO gateway_invoices
               (payment_id, tenant_id, provider, provider_order_id, provider_invoice_id,
                creation_state, created_invoice_at, provider_unit, sent_amount, hinted_payment_id)
               SELECT p.id, p.tenant_id, 'TONPAYS', 'po-' || p.id, 'pi-' || p.id, 'CREATED',
                      p.created_at, 'IRT', 250000,
                      CASE WHEN n % 10 = 0 THEN ($2::bigint + n)::text END
                 FROM (SELECT p.*, row_number() OVER (ORDER BY p.created_at, p.id) AS n
                         FROM payments p WHERE p.tenant_id = $1::uuid) p`,
            [scope.tenantId, 880_000_000_000 + offset],
          );
          await client.query(
            `INSERT INTO services
               (id, tenant_id, customer_id, order_id, panel_id, product_id, provider_username,
                state, delivery_state, traffic_limit_bytes, traffic_used_bytes, created_at,
                updated_at, provisioned_at, delivered_at)
               SELECT ${V7}, o.tenant_id, o.customer_id, o.id, o.panel_id,
                      o.product_id, 'nxs' || c.telegram_user_id, 'ACTIVE', 'DELIVERED',
                      53687091200, 0, o.created_at, o.created_at, o.created_at, o.created_at
                 FROM orders o JOIN customers c ON c.id = o.customer_id
                WHERE o.tenant_id = $1::uuid`,
            [scope.tenantId],
          );
          if (scope === tenantA) facts.panelId = panelId;
        }
        // The planner chooses on STATISTICS; without them every plan is a sequential scan.
        await client.query(
          'ANALYZE customers, products, orders, payments, services, gateway_invoices',
        );

        const { rows } = await client.query<{
          customer_id: string;
          order_id: string;
          product_id: string;
          payment_id: string;
        }>(
          `SELECT o.customer_id, o.id AS order_id, o.product_id, p.id AS payment_id
             FROM orders o JOIN payments p ON p.order_id = o.id
             JOIN customers c ON c.id = o.customer_id
            WHERE o.tenant_id = $1::uuid AND c.telegram_user_id = '900009001'`,
          [tenantA.tenantId],
        );
        const row = rows[0];
        if (row === undefined) throw new Error('the fixture has no customer 900009001');
        facts.customerId = row.customer_id;
        facts.orderId = row.order_id;
        facts.productId = row.product_id;
        facts.paymentId = row.payment_id;
      } finally {
        await client.query('RESET statement_timeout');
      }
    });
  }, 300_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const planFor = async (built: { toSQL(): { sql: string; params: unknown[] } }) => {
    const { sql, params } = built.toSQL();
    return ctx.container.database.withClient(async (client) => {
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF) ${sql}`,
        [...params],
      );
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });
  };

  /** Every `Rows Removed by Filter`, summed: what a filtered walk costs. */
  const removedByFilter = (plan: string): number =>
    [...plan.matchAll(/Rows Removed by Filter: (\d+)/g)].reduce(
      (sum, match) => sum + Number(match[1]),
      0,
    );

  const term = (raw: string): ListSearchTerm => {
    const classified = classifyListSearch(raw);
    if (classified === null) throw new Error(`"${raw}" is not a search`);
    return classified;
  };

  /** The three things every search plan must show, and the indexes this one must use. */
  const expectBounded = (plan: string, indexes: readonly string[]) => {
    for (const index of indexes) {
      expect(plan, `${index} is not in the plan:\n${plan}`).toContain(index);
    }
    // A sequential scan of a 40 000-row table is the failure this file exists for. The
    // forty-row product catalogue is allowed one: it is the deliberately-small infix arm.
    const seqScans = [...plan.matchAll(/Seq Scan on (\w+)/g)].map((match) => match[1]);
    expect(
      seqScans.filter((table) => table !== 'products'),
      `a table was walked:\n${plan}`,
    ).toEqual([]);
    expect(removedByFilter(plan), `rows were read and discarded:\n${plan}`).toBeLessThan(500);
  };

  const customers = () => new DrizzleCustomerRepository(ctx.container.database.db);
  const orders = () => new DrizzleOrderRepository(ctx.container.database.db);
  const payments = () => new DrizzlePaymentRepository(ctx.container.database.db);
  const services = () => new DrizzleServiceRepository(ctx.container.database.db);

  describe('customers', () => {
    it('resolves a Telegram id through the unique key', async () => {
      const plan = await planFor(
        customers().listStatement(tenantA, { text: term('900009001') }, PAGE, null),
      );
      expectBounded(plan, ['customers_tenant_telegram_key']);
    }, 60_000);

    it('serves a name prefix from the three text_pattern_ops indexes as one BitmapOr', async () => {
      const plan = await planFor(
        customers().listStatement(tenantA, { text: term('First9001') }, PAGE, null),
      );
      expectBounded(plan, [
        'customers_tenant_username_idx',
        'customers_tenant_full_name_idx',
        'customers_tenant_last_name_idx',
      ]);
      expect(plan).toContain('BitmapOr');
      expect(plan, `the prefix did not bound the scan:\n${plan}`).toMatch(/Index Cond:.*~>=~/s);
    }, 60_000);

    it('serves a last-name prefix', async () => {
      const plan = await planFor(
        customers().listStatement(tenantA, { text: term('last9001') }, PAGE, null),
      );
      expectBounded(plan, ['customers_tenant_last_name_idx']);
    }, 60_000);
  });

  describe('orders', () => {
    it('resolves a Telegram id to the customer once, then reads its orders by index', async () => {
      const plan = await planFor(
        orders().listStatement(tenantA, { text: term('900009001') }, PAGE, null),
      );
      expectBounded(plan, ['customers_tenant_telegram_key', 'orders_customer_created_idx']);
      // The customer lookup is an InitPlan — evaluated once — never a per-row SubPlan.
      expect(plan).toContain('InitPlan');
    }, 60_000);

    it('serves a uuid from the primary key, the customer and the product indexes', async () => {
      const plan = await planFor(
        orders().listStatement(tenantA, { text: term(facts.orderId) }, PAGE, null),
      );
      expectBounded(plan, [
        'orders_pkey',
        'orders_customer_created_idx',
        'orders_tenant_product_created_idx',
      ]);
    }, 60_000);

    it('serves a product name from the snapshot-title and the product indexes', async () => {
      // Resolved first, exactly as `list` does it; see `productIdsTitled` for why.
      const productIds = await orders().productIdsTitled(tenantA, 'rare plat');
      expect(productIds).toHaveLength(1);
      const plan = await planFor(
        orders().listStatement(
          tenantA,
          { text: term('rare plat') },
          PAGE,
          null,
          undefined,
          productIds,
        ),
      );
      expectBounded(plan, ['orders_tenant_line_title_idx', 'orders_tenant_product_created_idx']);
    }, 60_000);

    it('serves an @username from the username index and the customer index', async () => {
      const plan = await planFor(
        orders().listStatement(tenantA, { text: term('@member900009001') }, PAGE, null),
      );
      expectBounded(plan, ['customers_tenant_username_idx', 'orders_customer_created_idx']);
    }, 60_000);
  });

  describe('payments', () => {
    it('serves digits from the customer, reference and bank-reference indexes', async () => {
      const plan = await planFor(
        payments().listStatement(tenantA, { text: term('900009001') }, PAGE, null),
      );
      expectBounded(plan, [
        'customers_tenant_telegram_key',
        'payments_customer_created_idx',
        'payments_tenant_reference_key',
        'payments_tenant_external_reference_idx',
      ]);
    }, 60_000);

    it('serves a uuid from the primary key, the customer and the order indexes', async () => {
      const plan = await planFor(
        payments().listStatement(tenantA, { text: term(facts.orderId) }, PAGE, null),
      );
      expectBounded(plan, [
        'payments_pkey',
        'payments_customer_created_idx',
        'payments_tenant_order_idx',
      ]);
    }, 60_000);

    it('serves a gateway’s own order or invoice id from the invoice unique keys, then the payment’s tenant key', async () => {
      const plan = await planFor(
        payments().listStatement(tenantA, { text: term(`po-${facts.paymentId}`) }, PAGE, null),
      );
      expectBounded(plan, [
        'gateway_invoices_order_id_key',
        'gateway_invoices_invoice_id_key',
        'payments_tenant_id_key',
      ]);
      // The provider ids are resolved ONCE, never per payment row.
      expect(plan).toContain('InitPlan');
    }, 60_000);

    it('serves a gateway’s payment id (digits) from its own index', async () => {
      const plan = await planFor(
        payments().listStatement(tenantA, { text: term('880000000010') }, PAGE, null),
      );
      expectBounded(plan, ['gateway_invoices_tenant_hinted_payment_idx', 'payments_tenant_id_key']);
    }, 60_000);

    it('serves a reference exactly', async () => {
      const plan = await planFor(
        payments().listStatement(tenantA, { text: term(`ref-${facts.orderId}x`) }, PAGE, null),
      );
      expectBounded(plan, [
        'payments_tenant_reference_key',
        'payments_tenant_external_reference_idx',
      ]);
    }, 60_000);
  });

  describe('services', () => {
    it('serves a uuid from the primary key, customer, order and panel indexes', async () => {
      const plan = await planFor(
        services().listStatement(tenantA, { text: term(facts.customerId) }, PAGE, null),
      );
      expectBounded(plan, [
        'services_pkey',
        'services_customer_created_idx',
        'services_tenant_order_key',
        'services_tenant_panel_idx',
      ]);
    }, 60_000);

    it('serves a provider username exactly', async () => {
      const plan = await planFor(
        services().listStatement(tenantA, { text: term('nxs900009001') }, PAGE, null),
      );
      expectBounded(plan, ['services_tenant_provider_username_idx']);
    }, 60_000);

    it('serves a Telegram id through the customer index', async () => {
      const plan = await planFor(
        services().listStatement(tenantA, { text: term('900009001') }, PAGE, null),
      );
      expectBounded(plan, ['customers_tenant_telegram_key', 'services_customer_created_idx']);
    }, 60_000);
  });
});
