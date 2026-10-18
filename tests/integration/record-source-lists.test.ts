import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  CUSTOMER_ROUTES,
  DISCOUNT_ROUTES,
  ORDER_ROUTES,
  PAYMENT_ROUTES,
  PRODUCT_ROUTES,
  RESELLER_ROUTES,
  SERVICE_ROUTES,
  SESSION_COOKIE_NAME,
  TICKET_ROUTES,
  customerListResponseSchema,
  customerResponseSchema,
  discountListResponseSchema,
  orderListResponseSchema,
  paymentListResponseSchema,
  productListResponseSchema,
  resellerListResponseSchema,
  serviceListResponseSchema,
  ticketListResponseSchema,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { AudienceFixtures } from './audience-fixtures';
import {
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  testConfig,
  type TestContext,
} from './harness';

/**
 * «از میرزا» (owner decision 2026-10-17): the eight normal lists carry `source`, filter on
 * it, and never put `source_ref` on the wire.
 *
 * Each case gives the list one native row and one row the import wrote (a native row flipped
 * to `MIRZA` with its `source_ref`, so the fixture is a state the schema accepts), then asks
 * the REAL route with a real session: unfiltered both come back marked; `source=MIRZA`
 * returns only the imported one; `source=NEXA` only the native one; a value that is not a
 * source is refused rather than ignored (an ignored filter would read as "none imported").
 */

const ORIGIN = 'https://admin.example.test';
const REF = 'mirza-secret-ref-4417';
const AMOUNT = { amountMinor: '250000', currency: 'IRT' };
const VALID_QUOTE = JSON.stringify({
  productId: null,
  quotedAt: '2026-10-01T00:00:00.000Z',
  currency: 'IRT',
  finalAmount: AMOUNT,
  trace: [
    {
      step: 'BASE_PRICE',
      effect: 'REPLACES',
      ruleId: null,
      ruleLabel: 'fixture',
      amountBefore: AMOUNT,
      amountAfter: AMOUNT,
    },
  ],
});

describe('record source on the normal lists', () => {
  let api: ApiApp;
  let cookie: string;
  let fixtures: AudienceFixtures;
  let panel: string;
  let ctx: TestContext;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);
  const get = (path: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: { cookie, origin: ORIGIN } });
  const run = (query: ReturnType<typeof sql>) => api.container.database.db.execute(query);

  beforeAll(async () => {
    const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
    ctx = { container: api.container } as unknown as TestContext;
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    const login = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner', password: 'the-owners-real-password' },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(login.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error(`No session cookie: ${login.body}`);
    cookie = `${SESSION_COOKIE_NAME}=${match[1] as string}`;
    fixtures = new AudienceFixtures(ctx, tenantA.tenantId as string);
    panel = await fixtures.panel();
  });

  /** Flip one native row to the import's, the way the CHECK wants it: both columns at once. */
  async function markMirza(table: string, keyColumn: string, key: string): Promise<void> {
    await run(
      sql`UPDATE ${sql.raw(table)} SET source = 'MIRZA', source_ref = ${REF}
           WHERE tenant_id = ${tenantA.tenantId} AND ${sql.raw(keyColumn)} = ${key}`,
    );
  }

  /** The shared assertions; `ids` reads the id out of one parsed list. */
  async function expectFiltering(
    route: string,
    parse: (body: unknown) => readonly { id: string; source: 'NEXA' | 'MIRZA' }[],
    native: string,
    imported: string,
  ): Promise<void> {
    const all = await get(route);
    expect(all.statusCode).toBe(200);
    // `source_ref` is provenance for the importer; it is not the web's business.
    expect(all.body).not.toContain(REF);
    expect(all.body).not.toContain('source_ref');
    expect(all.body).not.toContain('sourceRef');
    const rows = parse(all.json());
    expect(rows.find((row) => row.id === imported)?.source).toBe('MIRZA');
    expect(rows.find((row) => row.id === native)?.source).toBe('NEXA');

    const joiner = route.includes('?') ? '&' : '?';
    const mirza = parse((await get(`${route}${joiner}source=MIRZA`)).json());
    expect(mirza.map((row) => row.id)).toEqual([imported]);
    const nexa = parse((await get(`${route}${joiner}source=NEXA`)).json());
    expect(nexa.map((row) => row.id)).toEqual([native]);
    expect((await get(`${route}${joiner}source=SPAM`)).statusCode).toBe(400);
  }

  it('customers, and the customer detail', async () => {
    const native = await fixtures.customer({ telegramUserId: '9100001' });
    const imported = await fixtures.customer({ telegramUserId: '9100002' });
    await markMirza('customers', 'id', imported);
    await expectFiltering(
      CUSTOMER_ROUTES.list,
      (body) => customerListResponseSchema.parse(body).customers,
      native,
      imported,
    );
    const detail = await get(CUSTOMER_ROUTES.detail(imported));
    expect(customerResponseSchema.parse(detail.json()).customer.source).toBe('MIRZA');
    // The ref for a customer can be `user:<telegram id>`; it never reaches the page.
    expect(detail.body).not.toContain(REF);
  });

  it('products', async () => {
    const native = await fixtures.product(panel, 'native');
    const imported = await fixtures.product(panel, 'imported');
    await markMirza('products', 'id', imported);
    await expectFiltering(
      PRODUCT_ROUTES.list,
      (body) => productListResponseSchema.parse(body).products,
      native,
      imported,
    );
  });

  it('orders', async () => {
    const customer = await fixtures.customer({ telegramUserId: '9100003' });
    // Written straight in with a REAL quote: the order repository parses it, and a
    // confirmed order's quote cannot be edited afterwards.
    const product = await fixtures.product(panel);
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const id = api.container.ids.uuid();
      ids.push(id);
      await run(sql`INSERT INTO orders
        (id, tenant_id, customer_id, state, purpose, product_id, panel_id, line_title, line_duration_days,
         line_traffic_bytes, line_unit_price_amount, line_quantity, subtotal_amount,
         discount_amount, total_amount, currency, quote, settled_at, confirmed_at)
        VALUES (${id}, ${tenantA.tenantId}, ${customer}, 'PAID', 'NEW_SERVICE', ${product}, ${panel}, 'plan', 30,
                53687091200, 250000, 1, 250000, 0, 250000, 'IRT', ${VALID_QUOTE}::jsonb, now(), now())`);
    }
    const native = ids[0] as string;
    const imported = ids[1] as string;
    await markMirza('orders', 'id', imported);
    await expectFiltering(
      ORDER_ROUTES.list,
      (body) => orderListResponseSchema.parse(body).orders,
      native,
      imported,
    );
  });

  it('services', async () => {
    const customer = await fixtures.customer({ telegramUserId: '9100004' });
    const native = await fixtures.service({ customerId: customer, panelId: panel });
    const imported = await fixtures.service({ customerId: customer, panelId: panel });
    await markMirza('services', 'id', imported);
    await expectFiltering(
      SERVICE_ROUTES.list,
      (body) => serviceListResponseSchema.parse(body).services,
      native,
      imported,
    );
  });

  it('payments', async () => {
    const ids: string[] = [];
    for (const reference of ['rs-pay-1', 'rs-pay-2']) {
      // One open top-up per customer, so each payment has its own.
      const customer = await fixtures.customer({ telegramUserId: `91000${reference.slice(-1)}9` });
      const id = api.container.ids.uuid();
      ids.push(id);
      await run(sql`INSERT INTO payments
        (id, tenant_id, customer_id, method, state, amount, currency, reference, expires_at,
         gateway_provider)
        VALUES (${id}, ${tenantA.tenantId}, ${customer}, 'MANUAL_TRANSFER', 'PENDING', 250000,
                'IRT', ${reference}, now() + interval '1 hour', 'MANUAL_TRANSFER')`);
    }
    await markMirza('payments', 'id', ids[1] as string);
    await expectFiltering(
      PAYMENT_ROUTES.list,
      (body) => paymentListResponseSchema.parse(body).payments,
      ids[0] as string,
      ids[1] as string,
    );
  });

  it('tickets', async () => {
    const customer = await fixtures.customer({
      telegramUserId: '9100006',
      botInstanceId: SEED_IDS.botA1,
    });
    const category = api.container.ids.uuid();
    await run(
      sql`INSERT INTO ticket_categories (id, tenant_id, title) VALUES (${category}, ${tenantA.tenantId}, 'General')`,
    );
    const ids: string[] = [];
    for (const key of ['rs-open-1', 'rs-open-2']) {
      const id = api.container.ids.uuid();
      ids.push(id);
      await run(sql`INSERT INTO tickets (id, tenant_id, customer_id, bot_instance_id, category_id,
          category_title, status, opening_key)
        VALUES (${id}, ${tenantA.tenantId}, ${customer}, ${SEED_IDS.botA1}, ${category}, 'General',
                'OPEN', ${key})`);
    }
    await markMirza('tickets', 'id', ids[1] as string);
    await expectFiltering(
      TICKET_ROUTES.list,
      (body) => ticketListResponseSchema.parse(body).tickets,
      ids[0] as string,
      ids[1] as string,
    );
  });

  it('discounts', async () => {
    const ids: string[] = [];
    for (const label of ['native rule', 'imported rule']) {
      const id = api.container.ids.uuid();
      ids.push(id);
      await run(sql`INSERT INTO discounts (id, tenant_id, kind, label, type, value, applies_to)
        VALUES (${id}, ${tenantA.tenantId}, 'AUTOMATIC', ${label}, 'PERCENTAGE', 10,
                ARRAY['NEW_SERVICE'])`);
    }
    await markMirza('discounts', 'id', ids[1] as string);
    await expectFiltering(
      DISCOUNT_ROUTES.list,
      (body) => discountListResponseSchema.parse(body).discounts,
      ids[0] as string,
      ids[1] as string,
    );
  });

  it('resellers', async () => {
    const tier = await fixtures.tier('rs-tier');
    const first = await fixtures.customer({ telegramUserId: '9100007' });
    const second = await fixtures.customer({ telegramUserId: '9100008' });
    await fixtures.reseller(first, tier);
    await fixtures.reseller(second, tier);
    await markMirza('resellers', 'customer_id', second);
    // A reseller is keyed by its customer; adapt the shared assertion to that.
    await expectFiltering(
      RESELLER_ROUTES.list,
      (body) =>
        resellerListResponseSchema
          .parse(body)
          .resellers.map((row) => ({ id: row.customerId, source: row.source })),
      first,
      second,
    );
  });
});
