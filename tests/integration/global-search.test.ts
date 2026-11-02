import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  GLOBAL_SEARCH_LIMIT_DEFAULT,
  GLOBAL_SEARCH_ROUTES,
  SESSION_COOKIE_NAME,
  globalSearchResponseSchema,
  type GlobalSearchKind,
  type GlobalSearchResponse,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  tenantB,
  testConfig,
} from './harness';

/**
 * R11 A1: the top-bar global search, over real HTTP.
 *
 * Pins the three properties a search that spans lists can silently lose:
 *   - PERMISSIONS — a kind is returned only to an actor holding that kind's own list
 *     permission(s), and is ABSENT (not empty, not an error) otherwise;
 *   - TENANT ISOLATION — tenant B holds a twin of every tenant-A record (same Telegram id,
 *     username, name, product, provider username), so a leaking query finds two rows;
 *   - BOUNDS — at most `limit` hits per kind, with `hasMore` exact.
 */
const ORIGIN = 'https://admin.example.test';

describe('the global search', () => {
  let api: ApiApp;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);
  const run = (statement: ReturnType<typeof sql>) => api.container.database.db.execute(statement);
  const newId = () => api.container.ids.uuid();

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

  /** A role holding exactly `permissions`, and an admin holding only that role. */
  async function adminWith(username: string, permissions: readonly string[]): Promise<void> {
    const roleId = newId();
    await run(sql`INSERT INTO roles (id, tenant_id, key, name, is_system)
      VALUES (${roleId}, ${tenantA.tenantId}, ${`role_${username.replace(/-/g, '_')}`}, ${username}, false)`);
    for (const permission of permissions) {
      await run(sql`INSERT INTO role_permissions (tenant_id, role_id, permission_key)
        VALUES (${tenantA.tenantId}, ${roleId}, ${permission})`);
    }
    const admin = await createAdmin(api.container, tenantA, {
      username,
      password: 'a-long-enough-password',
    });
    await run(sql`INSERT INTO admin_roles (tenant_id, admin_id, role_id)
      VALUES (${tenantA.tenantId}, ${admin.id}, ${roleId})`);
    cookies[username] = await cookieFor(username, 'a-long-enough-password');
  }

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

  /** One customer with a product, a paid order and an active service, in `tenantId`. */
  async function household(
    tenantId: string,
    input: { telegramUserId: string; username: string; first: string; provider: string },
  ): Promise<{
    customerId: string;
    orderId: string;
    serviceId: string;
    paymentId: string;
    paymentCode: string;
    ticketId: string;
    ticketNumber: string;
  }> {
    const panelId = newId();
    await run(sql`INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelId}, ${tenantId}, ${`Panel ${panelId.slice(-6)}`}, 'marzban',
              'https://search.example.test', 'ACTIVE')`);
    const productId = newId();
    await run(sql`INSERT INTO products
        (id, tenant_id, title, status, audience, sort_order, panel_id, duration_days,
         traffic_bytes, price_amount, price_currency)
      VALUES (${productId}, ${tenantId}, 'Gold Plan Monthly', 'ACTIVE', 'EVERYONE', 0, ${panelId},
              30, 53687091200, 250000, 'IRT')`);
    const customerId = newId();
    await run(sql`INSERT INTO customers
        (id, tenant_id, telegram_user_id, username, first_name, last_name, status, created_at)
      VALUES (${customerId}, ${tenantId}, ${input.telegramUserId}, ${input.username},
              ${input.first}, 'Rezaei', 'ACTIVE', '2026-01-01T00:00:00Z'::timestamptz)`);
    const orderId = newId();
    await run(sql`INSERT INTO orders
        (id, tenant_id, customer_id, state, product_id, panel_id, line_title,
         line_duration_days, line_traffic_bytes, line_unit_price_amount, line_quantity,
         subtotal_amount, discount_amount, total_amount, currency, quote, settled_at, confirmed_at)
      VALUES (${orderId}, ${tenantId}, ${customerId}, 'PAID', ${productId}, ${panelId},
              'Gold Plan Monthly', 30, 53687091200, 250000, 1, 250000, 0, 250000, 'IRT',
              ${quote(productId)}::jsonb, now(), now())`);
    const serviceId = newId();
    await run(sql`INSERT INTO services
        (id, tenant_id, customer_id, order_id, panel_id, product_id, provider_username, state,
         delivery_state, traffic_limit_bytes, traffic_used_bytes, provisioned_at, delivered_at)
      VALUES (${serviceId}, ${tenantId}, ${customerId}, ${orderId}, ${panelId}, ${productId},
              ${input.provider}, 'ACTIVE', 'DELIVERED', 53687091200, 0, now(), now())`);
    // R12 F3 item 8: a payment (found by its tracking code) and a ticket (found by its number).
    const paymentId = newId();
    await run(sql`INSERT INTO payments
        (id, tenant_id, customer_id, order_id, state, method, amount, currency, reference,
         expires_at)
      VALUES (${paymentId}, ${tenantId}, ${customerId}, ${orderId}, 'PENDING', 'MANUAL_TRANSFER',
              250000, 'IRT', ${`NX-${paymentId.slice(-12)}`}, now() + interval '1 hour')`);
    const paymentCode = (
      (await run(sql`SELECT code FROM payments WHERE id = ${paymentId}`)).rows[0] as {
        code: string;
      }
    ).code;
    const categoryId = newId();
    await run(sql`INSERT INTO ticket_categories (id, tenant_id, title)
      VALUES (${categoryId}, ${tenantId}, 'اتصال')`);
    const ticketId = newId();
    await run(sql`INSERT INTO tickets
        (id, tenant_id, customer_id, bot_instance_id, category_id, category_title, subject,
         opening_key)
      VALUES (${ticketId}, ${tenantId}, ${customerId},
              ${tenantId === (tenantA.tenantId as string) ? SEED_IDS.botA1 : SEED_IDS.botB1},
              ${categoryId}, 'اتصال', 'کندی اتصال', ${`open-${ticketId}`})`);
    const ticketNumber = (
      (await run(sql`SELECT number::text AS number FROM tickets WHERE id = ${ticketId}`))
        .rows[0] as { number: string }
    ).number;
    return { customerId, orderId, serviceId, paymentId, paymentCode, ticketId, ticketNumber };
  }

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);

    await createAdmin(api.container, tenantA, {
      username: 'owner-gs',
      password: 'the-owners-password',
      roleKeys: ['owner'],
    });
    cookies.owner = await cookieFor('owner-gs', 'the-owners-password');
    await adminWith('only-orders', ['orders.view']);
    await adminWith('only-customers', ['users.view', 'users.search']);
    await adminWith('view-no-search', ['users.view']);
    await adminWith('only-services', ['services.view']);
    await adminWith('nothing-relevant', ['panels.view']);
    await adminWith('only-tickets', ['tickets.view']);
    await adminWith('only-payments', ['payments.view']);

    const a = await household(tenantA.tenantId as string, {
      telegramUserId: '111111111',
      username: 'ali_reza',
      first: 'Ali',
      provider: 'nxali1',
    });
    // Tenant B's twin: same Telegram id, username, name, product and provider username.
    const b = await household(tenantB.tenantId as string, {
      telegramUserId: '111111111',
      username: 'ali_reza',
      first: 'Ali',
      provider: 'nxali1',
    });
    ids.customerA = a.customerId;
    ids.orderA = a.orderId;
    ids.serviceA = a.serviceId;
    ids.customerB = b.customerId;
    ids.orderB = b.orderId;
    ids.serviceB = b.serviceId;
    ids.paymentA = a.paymentId;
    ids.paymentCodeA = a.paymentCode;
    ids.ticketA = a.ticketId;
    ids.ticketNumberA = a.ticketNumber;
    ids.paymentB = b.paymentId;
    ids.ticketB = b.ticketId;
  });

  const search = async (
    q: string,
    who = 'owner',
    extra: Record<string, string> = {},
  ): Promise<GlobalSearchResponse> => {
    const response = await inject({
      method: 'GET',
      url: `${API_PREFIX}${GLOBAL_SEARCH_ROUTES.search}?${new URLSearchParams({ q, ...extra }).toString()}`,
      headers: { cookie: cookies[who] as string },
    });
    expect(response.statusCode, response.body).toBe(200);
    return globalSearchResponseSchema.parse(response.json());
  };
  const kinds = (out: GlobalSearchResponse): GlobalSearchKind[] => out.groups.map((g) => g.kind);
  const hitIds = (out: GlobalSearchResponse, kind: GlobalSearchKind): string[] =>
    out.groups.find((g) => g.kind === kind)?.hits.map((h) => h.id) ?? [];

  it('finds a customer, an order and a service by what an operator would type', async () => {
    const byId = await search('111111111');
    expect(hitIds(byId, 'CUSTOMER')).toEqual([ids.customerA]);
    const byName = await search('@ali_r');
    expect(hitIds(byName, 'CUSTOMER')).toEqual([ids.customerA]);
    const byProduct = await search('Gold Plan');
    expect(hitIds(byProduct, 'ORDER')).toEqual([ids.orderA]);
    const byProvider = await search('nxali1');
    expect(hitIds(byProvider, 'SERVICE')).toEqual([ids.serviceA]);
    // Every kind the owner may read is asked (R12 F3 item 8 added payments and tickets).
    expect(kinds(byProvider)).toEqual(['CUSTOMER', 'ORDER', 'SERVICE', 'PAYMENT', 'TICKET']);
  });

  it('never returns another tenant’s record, whatever the twin looks like', async () => {
    for (const q of ['111111111', '@ali_r', 'Gold Plan', 'nxali1', 'Ali']) {
      const out = await search(q);
      const all = out.groups.flatMap((g) => g.hits.map((h) => h.id));
      expect(all, q).not.toContain(ids.customerB);
      expect(all, q).not.toContain(ids.orderB);
      expect(all, q).not.toContain(ids.serviceB);
    }
    // And from tenant B's side: its own admin sees exactly its own three records.
    const ownerB = await createAdmin(api.container, tenantB, {
      username: 'owner-gs-b',
      roleKeys: ['owner'],
    });
    const out = await api.container.globalSearch.search(tenantB, adminActorFor(ownerB), {
      q: 'nxali1',
    });
    expect(hitIds(out, 'SERVICE')).toEqual([ids.serviceB]);
    const everything = await api.container.globalSearch.search(tenantB, adminActorFor(ownerB), {
      q: '111111111',
    });
    expect(hitIds(everything, 'CUSTOMER')).toEqual([ids.customerB]);
  });

  it('returns a kind only to an actor holding that kind’s own permissions', async () => {
    // Every one of these matches in the owner's answer; each actor sees only the kind it may.
    expect(kinds(await search('Gold Plan', 'owner'))).toContain('ORDER');
    const orders = await search('Ali', 'only-orders');
    expect(kinds(orders)).toEqual(['ORDER']);
    const customers = await search('Ali', 'only-customers');
    expect(kinds(customers)).toEqual(['CUSTOMER']);
    expect(hitIds(customers, 'CUSTOMER')).toEqual([ids.customerA]);
    const services = await search('nxali1', 'only-services');
    expect(kinds(services)).toEqual(['SERVICE']);
    expect(hitIds(services, 'SERVICE')).toEqual([ids.serviceA]);
  });

  it('R12 F3: finds a payment by its tracking code and a ticket by its number, per permission and tenant', async () => {
    const byCode = await search(ids.paymentCodeA as string);
    expect(hitIds(byCode, 'PAYMENT')).toEqual([ids.paymentA]);
    expect(byCode.groups.find((g) => g.kind === 'PAYMENT')?.hits[0]).toMatchObject({
      title: ids.paymentCodeA,
      state: 'PENDING',
    });
    // The code is also found typed lower-case or after a #, the way operators paste it.
    expect(hitIds(await search((ids.paymentCodeA as string).toLowerCase()), 'PAYMENT')).toEqual([
      ids.paymentA,
    ]);

    const byNumber = await search(ids.ticketNumberA as string);
    expect(hitIds(byNumber, 'TICKET')).toEqual([ids.ticketA]);
    expect(byNumber.groups.find((g) => g.kind === 'TICKET')?.hits[0]?.title).toBe(
      `#${ids.ticketNumberA as string}`,
    );
    expect(hitIds(await search(`#${ids.ticketNumberA as string}`), 'TICKET')).toEqual([
      ids.ticketA,
    ]);
    // Free text is not a ticket number or code: the customers' kind finds people, not tickets.
    expect(hitIds(await search('کندی'), 'TICKET')).toEqual([]);

    // Each kind needs its own permission and is ABSENT otherwise.
    expect(kinds(await search(ids.paymentCodeA as string, 'only-payments'))).toEqual(['PAYMENT']);
    expect(kinds(await search(ids.ticketNumberA as string, 'only-tickets'))).toEqual(['TICKET']);
    expect(kinds(await search(ids.paymentCodeA as string, 'only-orders'))).not.toContain('PAYMENT');
    // Never another tenant's.
    for (const q of [ids.paymentCodeA as string, ids.ticketNumberA as string]) {
      const all = (await search(q)).groups.flatMap((g) => g.hits.map((h) => h.id));
      expect(all, q).not.toContain(ids.paymentB);
      expect(all, q).not.toContain(ids.ticketB);
    }
  });

  it('refuses nothing and reveals nothing to an actor with users.view but not users.search', async () => {
    const out = await search('Ali', 'view-no-search');
    expect(out.groups).toEqual([]);
  });

  it('answers an empty list to an actor holding none of the three read permissions', async () => {
    expect(await search('nxali1', 'nothing-relevant')).toEqual({ groups: [] });
  });

  it('is refused without a session', async () => {
    const response = await inject({
      method: 'GET',
      url: `${API_PREFIX}${GLOBAL_SEARCH_ROUTES.search}?q=ali`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a malformed query (empty, too long, limit above the cap, a repeated key)', async () => {
    const bad = async (query: string) =>
      (
        await inject({
          method: 'GET',
          url: `${API_PREFIX}${GLOBAL_SEARCH_ROUTES.search}${query}`,
          headers: { cookie: cookies.owner as string },
        })
      ).statusCode;
    expect(await bad('')).toBe(400);
    expect(await bad('?q=')).toBe(400);
    expect(await bad(`?q=${'x'.repeat(65)}`)).toBe(400);
    expect(await bad('?q=ali&limit=11')).toBe(400);
    expect(await bad('?q=ali&q=bob')).toBe(400);
  });

  it('bounds the hits per kind and says exactly when there are more', async () => {
    for (let i = 0; i < 12; i += 1) {
      await run(sql`INSERT INTO customers
          (id, tenant_id, telegram_user_id, username, first_name, last_name, status)
        VALUES (${newId()}, ${tenantA.tenantId}, ${`9000000${String(i).padStart(2, '0')}`},
                ${`bulk_${i}`}, ${`Bulk${i}`}, 'Person', 'ACTIVE')`);
    }
    const out = await search('Bulk');
    const customers = out.groups.find((g) => g.kind === 'CUSTOMER');
    expect(customers?.hits).toHaveLength(GLOBAL_SEARCH_LIMIT_DEFAULT);
    expect(customers?.hasMore).toBe(true);
    const ten = await search('Bulk', 'owner', { limit: '10' });
    expect(ten.groups.find((g) => g.kind === 'CUSTOMER')?.hits).toHaveLength(10);
    expect(ten.groups.find((g) => g.kind === 'CUSTOMER')?.hasMore).toBe(true);
    const exact = await search('Ali');
    expect(exact.groups.find((g) => g.kind === 'CUSTOMER')?.hasMore).toBe(false);
  });
});
