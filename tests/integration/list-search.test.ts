import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  CUSTOMER_ROUTES,
  ORDER_ROUTES,
  PAYMENT_ROUTES,
  SERVICE_ROUTES,
  SESSION_COOKIE_NAME,
  customerListResponseSchema,
  orderListResponseSchema,
  paymentListResponseSchema,
  serviceListResponseSchema,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, tenantB, testConfig } from './harness';

/**
 * The Web Admin's one search box (spec §10), over real HTTP.
 *
 * Each list takes a single `q`, and the server decides what it is by its shape
 * (`classifyListSearch`). These cases pin what each shape FINDS on each list, and the two
 * properties a search box can silently lose:
 *
 *   - tenant isolation — tenant B holds a customer with the SAME Telegram id, username,
 *     name and product name as tenant A's, so a search that leaked would find two rows;
 *   - pagination stability — thirty matches created in the SAME instant, paged ten at a
 *     time, must come back exactly once each, which only the `(created_at, id)` keyset
 *     tie-break guarantees.
 *
 * `list-search-plan.test.ts` is the other half: it proves each of these is answered from
 * an index rather than by a walk of the tenant, which no behavioural assertion can see.
 */

const ORIGIN = 'https://admin.example.test';

interface Fixture {
  readonly panelId: string;
  readonly goldProductId: string;
  readonly silverProductId: string;
  readonly ali: string;
  readonly sara: string;
  readonly karimi: string;
  readonly aliB: string;
  readonly aliOrder: string;
  readonly saraOrder: string;
  readonly karimiOrder: string;
  readonly aliBOrder: string;
  readonly aliPayment: string;
}

describe('the unified list search', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let viewerCookie: string;
  let fx: Fixture;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  const run = (statement: ReturnType<typeof sql>) => api.container.database.db.execute(statement);
  const id = () => api.container.ids.uuid();

  beforeAll(async () => {
    const config = testConfig();
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  });

  afterAll(async () => {
    await api?.close();
  });

  async function cookieFor(username: string, password: string): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password },
    });
    const header = String(response.headers['set-cookie'] ?? '');
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(header);
    if (match === null) throw new Error(`No session cookie for ${username}: ${response.body}`);
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  /** A quote that `priceQuoteWireSchema` reads back: the stored shape of a list price. */
  const quote = (productId: string) =>
    JSON.stringify({
      productId,
      quotedAt: '2026-01-01T00:00:00.000Z',
      currency: 'IRT',
      finalAmount: { amountMinor: '250000', currency: 'IRT' },
      trace: [
        {
          step: 'BASE_PRICE',
          effect: 'REPLACES',
          ruleId: null,
          ruleLabel: 'list price',
          amountBefore: { amountMinor: '250000', currency: 'IRT' },
          amountAfter: { amountMinor: '250000', currency: 'IRT' },
        },
      ],
    });

  async function panel(tenantId: string): Promise<string> {
    const panelId = id();
    await run(sql`INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelId}, ${tenantId}, ${`Search ${panelId.slice(-6)}`}, 'marzban',
              'https://search.example.test', 'ACTIVE')`);
    return panelId;
  }

  async function product(tenantId: string, panelId: string, title: string): Promise<string> {
    const productId = id();
    await run(sql`INSERT INTO products
        (id, tenant_id, title, status, audience, sort_order, panel_id, duration_days,
         traffic_bytes, price_amount, price_currency)
      VALUES (${productId}, ${tenantId}, ${title}, 'ACTIVE', 'EVERYONE', 0, ${panelId}, 30,
              53687091200, 250000, 'IRT')`);
    return productId;
  }

  async function customer(
    tenantId: string,
    input: {
      telegramUserId: string;
      username: string | null;
      firstName: string | null;
      lastName: string | null;
      createdAt?: string;
    },
  ): Promise<string> {
    const customerId = id();
    await run(sql`INSERT INTO customers
        (id, tenant_id, telegram_user_id, username, first_name, last_name, status, created_at)
      VALUES (${customerId}, ${tenantId}, ${input.telegramUserId}, ${input.username},
              ${input.firstName}, ${input.lastName}, 'ACTIVE',
              ${input.createdAt ?? '2026-01-01T00:00:00Z'}::timestamptz)`);
    return customerId;
  }

  /** A paid order on a product, its payment, and the service it produced. */
  async function sale(
    tenantId: string,
    input: {
      customerId: string;
      panelId: string;
      productId: string;
      title: string;
      reference: string;
      externalReference: string | null;
      providerUsername: string;
    },
  ): Promise<{ orderId: string; paymentId: string }> {
    const orderId = id();
    const paymentId = id();
    await run(sql`INSERT INTO orders
        (id, tenant_id, customer_id, state, product_id, panel_id, line_title,
         line_duration_days, line_traffic_bytes, line_unit_price_amount, line_quantity,
         subtotal_amount, discount_amount, total_amount, currency, quote, settled_at,
         confirmed_at)
      VALUES (${orderId}, ${tenantId}, ${input.customerId}, 'PAID', ${input.productId},
              ${input.panelId}, ${input.title}, 30, 53687091200, 250000, 1, 250000, 0, 250000,
              'IRT', ${quote(input.productId)}::jsonb, now(), now())`);
    await run(sql`INSERT INTO payments
        (id, tenant_id, customer_id, order_id, state, method, amount, currency, reference,
         external_reference)
      VALUES (${paymentId}, ${tenantId}, ${input.customerId}, ${orderId}, 'PENDING',
              'MANUAL_TRANSFER', 250000, 'IRT', ${input.reference}, ${input.externalReference})`);
    await run(sql`INSERT INTO services
        (id, tenant_id, customer_id, order_id, panel_id, product_id, provider_username, state,
         delivery_state, traffic_limit_bytes, traffic_used_bytes, provisioned_at, delivered_at)
      VALUES (${id()}, ${tenantId}, ${input.customerId}, ${orderId}, ${input.panelId},
              ${input.productId}, ${input.providerUsername}, 'ACTIVE', 'DELIVERED',
              53687091200, 0, now(), now())`);
    return { orderId, paymentId };
  }

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);

    await createAdmin(api.container, tenantA, {
      username: 'owner-search',
      password: 'the-owners-password',
      roleKeys: ['owner'],
    });
    // `users.view` WITHOUT `users.search`: the box must not become a way around it.
    const viewerRoleId = id();
    await run(sql`INSERT INTO roles (id, tenant_id, key, name, is_system)
      VALUES (${viewerRoleId}, ${tenantA.tenantId}, 'list_viewer', 'List viewer', false)`);
    await run(sql`INSERT INTO role_permissions (tenant_id, role_id, permission_key)
      VALUES (${tenantA.tenantId}, ${viewerRoleId}, 'users.view')`);
    const viewer = await createAdmin(api.container, tenantA, {
      username: 'viewer-search',
      password: 'the-viewers-password',
    });
    await run(sql`INSERT INTO admin_roles (tenant_id, admin_id, role_id)
      VALUES (${tenantA.tenantId}, ${viewer.id}, ${viewerRoleId})`);

    const a = tenantA.tenantId as string;
    const b = tenantB.tenantId as string;
    const panelA = await panel(a);
    const panelB = await panel(b);
    const goldA = await product(a, panelA, 'Gold Plan Monthly');
    const silverA = await product(a, panelA, 'Silver Weekly');
    const goldB = await product(b, panelB, 'Gold Plan Monthly');

    const ali = await customer(a, {
      telegramUserId: '111111111',
      username: 'ali_reza',
      firstName: 'Ali',
      lastName: 'Rezaei',
    });
    // `alixreza` is what an UNESCAPED `_` in `ali_r` would also match.
    const sara = await customer(a, {
      telegramUserId: '222222222',
      username: 'alixreza',
      firstName: 'Sara',
      lastName: 'Ahmadi',
    });
    const karimi = await customer(a, {
      telegramUserId: '333333333',
      username: null,
      firstName: 'محمد',
      lastName: 'کریمی',
    });
    // Tenant B's twin of Ali: same Telegram id, username, name and product name.
    const aliB = await customer(b, {
      telegramUserId: '111111111',
      username: 'ali_reza',
      firstName: 'Ali',
      lastName: 'Rezaei',
    });

    const aliSale = await sale(a, {
      customerId: ali,
      panelId: panelA,
      productId: goldA,
      title: 'Gold Plan Monthly',
      reference: 'REF-ALI-1',
      externalReference: '987654321',
      providerUsername: 'nxali1',
    });
    const saraSale = await sale(a, {
      customerId: sara,
      panelId: panelA,
      productId: silverA,
      title: 'Silver Weekly',
      reference: 'REF-SARA-1',
      externalReference: null,
      providerUsername: 'nxsara1',
    });
    const karimiSale = await sale(a, {
      customerId: karimi,
      panelId: panelA,
      productId: goldA,
      // The SNAPSHOT title: the product has since been renamed to the current one above.
      title: 'Legacy Gold',
      reference: 'REF-KARIMI-1',
      externalReference: null,
      providerUsername: 'nxkarimi1',
    });
    const aliBSale = await sale(b, {
      customerId: aliB,
      panelId: panelB,
      productId: goldB,
      title: 'Gold Plan Monthly',
      reference: 'REF-ALI-1',
      externalReference: '987654321',
      providerUsername: 'nxali1',
    });

    fx = {
      panelId: panelA,
      goldProductId: goldA,
      silverProductId: silverA,
      ali,
      sara,
      karimi,
      aliB,
      aliOrder: aliSale.orderId,
      saraOrder: saraSale.orderId,
      karimiOrder: karimiSale.orderId,
      aliBOrder: aliBSale.orderId,
      aliPayment: aliSale.paymentId,
    };

    ownerCookie = await cookieFor('owner-search', 'the-owners-password');
    viewerCookie = await cookieFor('viewer-search', 'the-viewers-password');
  });

  const get = (path: string, query: Record<string, string>, cookie = ownerCookie) =>
    inject({
      method: 'GET',
      url: `${API_PREFIX}${path}?${new URLSearchParams(query).toString()}`,
      headers: { cookie },
    });

  const customerIds = async (q: string) => {
    const response = await get(CUSTOMER_ROUTES.list, { q });
    expect(response.statusCode, response.body).toBe(200);
    return customerListResponseSchema
      .parse(response.json())
      .customers.map((row) => row.id)
      .sort();
  };
  const orderIds = async (q: string) => {
    const response = await get(ORDER_ROUTES.list, { q });
    expect(response.statusCode, response.body).toBe(200);
    return orderListResponseSchema
      .parse(response.json())
      .orders.map((row) => row.id)
      .sort();
  };
  const paymentIds = async (q: string) => {
    const response = await get(PAYMENT_ROUTES.list, { q });
    expect(response.statusCode, response.body).toBe(200);
    return paymentListResponseSchema
      .parse(response.json())
      .payments.map((row) => row.id)
      .sort();
  };
  const serviceOrders = async (q: string) => {
    const response = await get(SERVICE_ROUTES.list, { q });
    expect(response.statusCode, response.body).toBe(200);
    return serviceListResponseSchema
      .parse(response.json())
      .services.map((row) => row.orderId)
      .sort();
  };
  const sorted = (...ids: string[]) => [...ids].sort();

  describe('/users', () => {
    it('finds a customer by EXACT numeric Telegram id, never by a prefix of one', async () => {
      expect(await customerIds('111111111')).toEqual([fx.ali]);
      expect(await customerIds('11111111')).toEqual([]);
    });

    it('finds by username prefix, with or without the @, and escapes LIKE wildcards', async () => {
      expect(await customerIds('@ALI_R')).toEqual([fx.ali]);
      // `_` is a literal here; unescaped it would also match `alixreza`.
      expect(await customerIds('ali_r')).toEqual([fx.ali]);
      expect(await customerIds('@ali')).toEqual(sorted(fx.ali, fx.sara));
    });

    it('finds by a partial name: first name, display name or last name, by prefix', async () => {
      expect(await customerIds('sar')).toEqual([fx.sara]);
      expect(await customerIds('Ali Rez')).toEqual([fx.ali]);
      expect(await customerIds('rezae')).toEqual([fx.ali]);
      expect(await customerIds('کریم')).toEqual([fx.karimi]);
      expect(await customerIds('محمد ک')).toEqual([fx.karimi]);
    });

    it('finds by the internal id', async () => {
      expect(await customerIds(fx.sara)).toEqual([fx.sara]);
      // Another tenant's id is not a row of this one.
      expect(await customerIds(fx.aliB)).toEqual([]);
    });

    it('keeps the status filter separate, and applies both', async () => {
      await run(sql`UPDATE customers SET status = 'BLOCKED', blocked_at = now()
        WHERE id = ${fx.sara}`);
      const response = await get(CUSTOMER_ROUTES.list, { q: '@ali', status: 'ACTIVE' });
      expect(customerListResponseSchema.parse(response.json()).customers.map((r) => r.id)).toEqual([
        fx.ali,
      ]);
    });

    it('charges users.search for the box, as for every other way of finding one person', async () => {
      const response = await get(CUSTOMER_ROUTES.list, { q: '111111111' }, viewerCookie);
      expect(response.statusCode).toBe(403);
      // The list itself is still the viewer's.
      expect((await get(CUSTOMER_ROUTES.list, {}, viewerCookie)).statusCode).toBe(200);
    });

    it('refuses an over-long search as a 400, not an empty page', async () => {
      const response = await get(CUSTOMER_ROUTES.list, { q: 'x'.repeat(65) });
      expect(response.statusCode).toBe(400);
    });

    it('pages thirty same-instant matches exactly once each', async () => {
      const created: string[] = [];
      for (let n = 0; n < 30; n += 1) {
        created.push(
          await customer(tenantA.tenantId as string, {
            telegramUserId: String(500_000_000 + n),
            username: `pager${String(n)}`,
            firstName: 'Pager',
            lastName: null,
            // The SAME instant for all thirty: only the id tie-break orders them.
            createdAt: '2026-02-02T02:02:02.000Z',
          }),
        );
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const response = await get(CUSTOMER_ROUTES.list, {
          q: 'pager',
          limit: '7',
          ...(cursor === null ? {} : { cursor }),
        });
        const page = customerListResponseSchema.parse(response.json());
        seen.push(...page.customers.map((row) => row.id));
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
      expect(seen).toHaveLength(30);
      expect(new Set(seen).size).toBe(30);
      expect([...seen].sort()).toEqual([...created].sort());
    });
  });

  describe('/orders', () => {
    it('finds a customer’s orders by Telegram id and shows the Telegram id on the row', async () => {
      const response = await get(ORDER_ROUTES.list, { q: '111111111' });
      const rows = orderListResponseSchema.parse(response.json()).orders;
      expect(rows.map((row) => row.id)).toEqual([fx.aliOrder]);
      expect(rows[0]?.customerTelegramUserId).toBe('111111111');
      expect(rows[0]?.customerUsername).toBe('ali_reza');
    });

    it('finds by order id, customer id or product id', async () => {
      expect(await orderIds(fx.saraOrder)).toEqual([fx.saraOrder]);
      expect(await orderIds(fx.karimi)).toEqual([fx.karimiOrder]);
      expect(await orderIds(fx.goldProductId)).toEqual(sorted(fx.aliOrder, fx.karimiOrder));
      expect(await orderIds(fx.aliBOrder)).toEqual([]);
    });

    it('finds by product name: the snapshot title by prefix, or the current product title by part', async () => {
      // A prefix of the snapshot title.
      expect(await orderIds('silver')).toEqual([fx.saraOrder]);
      expect(await orderIds('legacy')).toEqual([fx.karimiOrder]);
      // Part of the CURRENT product title, which finds the order sold under its old name too.
      expect(await orderIds('plan month')).toEqual(sorted(fx.aliOrder, fx.karimiOrder));
    });

    it('finds by @username prefix', async () => {
      expect(await orderIds('@alix')).toEqual([fx.saraOrder]);
    });

    it('never crosses into another tenant holding the same identifiers', async () => {
      // Tenant B's Ali shares every searchable value with tenant A's.
      expect(await orderIds('111111111')).toEqual([fx.aliOrder]);
      expect(await orderIds('@ali_reza')).toEqual([fx.aliOrder]);
      expect(await orderIds('gold plan')).not.toContain(fx.aliBOrder);
    });

    it('keeps the state filter separate', async () => {
      const response = await get(ORDER_ROUTES.list, { q: 'gold', state: 'REFUNDED' });
      expect(orderListResponseSchema.parse(response.json()).orders).toEqual([]);
    });
  });

  describe('/payments', () => {
    it('finds by Telegram id, by the reference and by the bank reference', async () => {
      expect(await paymentIds('111111111')).toEqual([fx.aliPayment]);
      expect(await paymentIds('REF-ALI-1')).toEqual([fx.aliPayment]);
      expect(await paymentIds('987654321')).toEqual([fx.aliPayment]);
      // Exact: a partial reference over money finds nothing.
      expect(await paymentIds('REF-ALI')).toEqual([]);
    });

    it('finds by payment id and by order id', async () => {
      expect(await paymentIds(fx.aliPayment)).toEqual([fx.aliPayment]);
      expect(await paymentIds(fx.aliOrder)).toEqual([fx.aliPayment]);
    });
  });

  describe('/services', () => {
    it('finds by provider username exactly, by Telegram id and by any of its ids', async () => {
      expect(await serviceOrders('NXSARA1')).toEqual([fx.saraOrder]);
      expect(await serviceOrders('nxsara')).toEqual([]);
      expect(await serviceOrders('333333333')).toEqual([fx.karimiOrder]);
      expect(await serviceOrders(fx.aliOrder)).toEqual([fx.aliOrder]);
      expect(await serviceOrders(fx.panelId)).toEqual(
        sorted(fx.aliOrder, fx.saraOrder, fx.karimiOrder),
      );
    });

    it('carries the Telegram identity on every row', async () => {
      const response = await get(SERVICE_ROUTES.list, { q: '222222222' });
      const rows = serviceListResponseSchema.parse(response.json()).services;
      expect(rows.map((row) => row.customerTelegramUserId)).toEqual(['222222222']);
    });

    it('matches nothing for text that is no provider username, rather than scanning', async () => {
      expect(await serviceOrders('سرویس')).toEqual([]);
    });
  });
});
