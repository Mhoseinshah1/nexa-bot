import { sql } from 'drizzle-orm';
import type { ProductCategoryId } from '@nexa/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  API_PREFIX,
  AUTH_ROUTES,
  COMMERCE_ERROR_CODES,
  ORDER_ROUTES,
  PLATFORM_ERROR_CODES,
  SESSION_COOKIE_NAME,
  money,
  orderListResponseSchema,
  orderResponseSchema,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  createAdmin,
  migrateOnce,
  resetDatabase,
  seededCategoryFor,
  tenantA,
  tenantB,
  testConfig,
} from './harness';

/**
 * Orders over real HTTP. TWO ROUTES, both reads, and that is the subject.
 *
 * What only exists at this layer:
 *
 *   - the projection, which is the one place a field the contract does not declare could
 *     become JSON, and the one place the SNAPSHOT could quietly be replaced by a join on
 *     today's product row;
 *   - authorization for an authenticated caller who does not hold `orders.view`, because
 *     the Web Admin not drawing a link is not authorization;
 *   - tenant scope taken from the SESSION, which is what makes another tenant's order id
 *     useless rather than merely unlikely;
 *   - the ABSENCE of a write. There is no cancel, no mark-paid, no refund and no settle,
 *     and the case at the bottom asserts that by asking for them.
 */

const ORIGIN = 'https://admin.example.test';

describe('order HTTP surface', () => {
  let api: ApiApp;
  /** A custom role holding `orders.view` alone — no system role has exactly that shape. */
  let viewerCookie: string;
  /** A real operator who holds no `orders.*` permission at all. */
  let technicalCookie: string;
  let panelA: string;
  let products: DrizzleProductRepository;
  let customerA: UserId;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    const config = testConfig();
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(api.container.database.db);

    await createAdmin(api.container, tenantA, {
      username: 'technical',
      password: 'the-technical-password',
      roleKeys: ['technical'],
    });

    const viewerRoleId = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO roles (id, tenant_id, key, name, is_system)
      VALUES (${viewerRoleId}, ${tenantA.tenantId}, 'order_viewer', 'Order viewer', false)`);
    await api.container.database.db.execute(sql`
      INSERT INTO role_permissions (tenant_id, role_id, permission_key)
      VALUES (${tenantA.tenantId}, ${viewerRoleId}, 'orders.view')`);
    const viewer = await createAdmin(api.container, tenantA, {
      username: 'viewer',
      password: 'the-viewers-password',
    });
    await api.container.database.db.execute(sql`
      INSERT INTO admin_roles (tenant_id, admin_id, role_id)
      VALUES (${tenantA.tenantId}, ${viewer.id}, ${viewerRoleId})`);

    panelA = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://panel.example.test', 'ACTIVE')`);

    viewerCookie = await cookieFor('viewer', 'the-viewers-password');
    technicalCookie = await cookieFor('technical', 'the-technical-password');
    customerA = await customer(tenantA, SEED_IDS.botA1 as BotInstanceId, '900100');
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

  const systemActor = (correlationId: string): ActorContext => ({
    type: 'SYSTEM_JOB',
    id: null,
    label: 'telegram-update:test',
    surface: 'TELEGRAM',
    correlationId: correlationId as CorrelationId,
  });

  async function customer(
    scope: typeof tenantA,
    botInstanceId: BotInstanceId,
    telegramUserId: string,
  ): Promise<UserId> {
    const { customer: record } = await api.container.customers.resolveFromUpdate(
      scope,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'زهرا' },
        botInstanceId,
      },
    );
    return record.id;
  }

  async function sellableProduct(scope: typeof tenantA, panelId: string, title = 'پلن پایه') {
    const created = await products.create(scope, {
      id: api.container.ids.uuid() as ProductId,
      draft: {
        title,
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        /*
         * The category of the tenant this product is written for, never a fixed one.
         * `products_tenant_category_fk` is composite, so a tenant B product filed
         * under tenant A's category is refused by the database — turning a
         * cross-tenant isolation test into a foreign-key error instead of the
         * assertion it was written to make.
         */
        categoryId: seededCategoryFor(scope) as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: api.container.clock.now(),
    });
    await products.setStatus(scope, created.id, 'INACTIVE', 'ACTIVE', api.container.clock.now());
    const after = await products.findById(scope, created.id);
    if (after === null) throw new Error('product vanished');
    return after;
  }

  let keyCounter = 0;
  const draftFor = async (scope: typeof tenantA, customerId: UserId, productId: string) =>
    api.container.orders.createDraft(scope, systemActor(`order-${(keyCounter += 1)}`), {
      idempotencyKey: `orders-http-${keyCounter}-${Date.now()}`,
      customerId,
      productId,
    });

  const get = (path: string, cookie: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: { cookie, origin: ORIGIN } });

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  it('lists orders, and the response is exactly what the contract declares', async () => {
    const product = await sellableProduct(tenantA, panelA);
    const order = await draftFor(tenantA, customerA, product.id);

    const response = await get(ORDER_ROUTES.list, viewerCookie);
    expect(response.statusCode).toBe(200);
    // Parsed by the FROZEN schema, so an undeclared field is a failure here rather than
    // something a consumer starts depending on.
    const body = orderListResponseSchema.parse(JSON.parse(response.body));
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]).toMatchObject({
      id: order.id,
      customerId: customerA,
      state: 'DRAFT',
      productId: product.id,
      panelId: panelA,
      lineTitle: 'پلن پایه',
      lineQuantity: 1,
      totalAmount: '250000',
      currency: 'IRT',
      confirmedAt: null,
    });
    expect(body.nextCursor).toBeNull();
  });

  it('renders the SNAPSHOT, not the product as it reads now', async () => {
    const product = await sellableProduct(tenantA, panelA);
    await draftFor(tenantA, customerA, product.id);

    await products.update(
      tenantA,
      product.id,
      {
        title: 'یک نام کاملاً دیگر',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelA as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 365, trafficBytes: 1n, deviceLimit: 9 },
        price: money(999_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      api.container.clock.now(),
    );

    const body = orderListResponseSchema.parse(
      JSON.parse((await get(ORDER_ROUTES.list, viewerCookie)).body),
    );
    // The legacy «محصول حذف‌شده» is what a response that joined on today's row produces.
    expect(body.orders[0]?.lineTitle).toBe('پلن پایه');
    expect(body.orders[0]?.lineDurationDays).toBe(30);
    expect(body.orders[0]?.lineTrafficBytes).toBe('53687091200');
    expect(body.orders[0]?.totalAmount).toBe('250000');
  });

  it('carries an amount past 2^53 as text, losing no unit', async () => {
    const created = await products.create(tenantA, {
      id: api.container.ids.uuid() as ProductId,
      draft: {
        title: 'گران',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 1,
        panelId: panelA as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 1n, deviceLimit: null },
        // Above `Number.MAX_SAFE_INTEGER`. A JSON number would round it.
        price: money(9_007_199_254_740_993n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: api.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', api.container.clock.now());
    await draftFor(tenantA, customerA, created.id);

    const raw = (await get(ORDER_ROUTES.list, viewerCookie)).body;
    expect(raw).toContain('"totalAmount":"9007199254740993"');
    const body = orderListResponseSchema.parse(JSON.parse(raw));
    expect(BigInt(body.orders[0]?.totalAmount ?? '0')).toBe(9_007_199_254_740_993n);
  });

  it('reads one order by id', async () => {
    const product = await sellableProduct(tenantA, panelA);
    const order = await draftFor(tenantA, customerA, product.id);

    const response = await get(ORDER_ROUTES.detail(order.id), viewerCookie);
    expect(response.statusCode).toBe(200);
    expect(orderResponseSchema.parse(JSON.parse(response.body)).order.id).toBe(order.id);
  });

  it('filters by state, customer and product', async () => {
    const first = await sellableProduct(tenantA, panelA, 'یکی');
    const second = await sellableProduct(tenantA, panelA, 'دیگری');
    const other = await customer(tenantA, SEED_IDS.botA1 as BotInstanceId, '900200');
    const mine = await draftFor(tenantA, customerA, first.id);
    const theirs = await draftFor(tenantA, other, second.id);

    const byCustomer = orderListResponseSchema.parse(
      JSON.parse((await get(`${ORDER_ROUTES.list}?customerId=${customerA}`, viewerCookie)).body),
    );
    expect(byCustomer.orders.map((o) => o.id)).toEqual([mine.id]);

    const byProduct = orderListResponseSchema.parse(
      JSON.parse((await get(`${ORDER_ROUTES.list}?productId=${second.id}`, viewerCookie)).body),
    );
    expect(byProduct.orders.map((o) => o.id)).toEqual([theirs.id]);

    const awaiting = orderListResponseSchema.parse(
      JSON.parse((await get(`${ORDER_ROUTES.list}?state=AWAITING_PAYMENT`, viewerCookie)).body),
    );
    expect(awaiting.orders).toHaveLength(0);
  });

  it('pages by a cursor it minted, and refuses one it did not', async () => {
    const product = await sellableProduct(tenantA, panelA);
    for (let i = 0; i < 3; i += 1) {
      await draftFor(tenantA, customerA, product.id);
    }

    const firstPage = orderListResponseSchema.parse(
      JSON.parse((await get(`${ORDER_ROUTES.list}?limit=2`, viewerCookie)).body),
    );
    expect(firstPage.orders).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = orderListResponseSchema.parse(
      JSON.parse(
        (
          await get(
            `${ORDER_ROUTES.list}?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
            viewerCookie,
          )
        ).body,
      ),
    );
    expect(secondPage.orders).toHaveLength(1);
    // No overlap and no gap: the keyset is on `(created_at, id)`, both immutable.
    const seen = [...firstPage.orders, ...secondPage.orders].map((o) => o.id);
    expect(new Set(seen).size).toBe(3);

    // A cursor this server did not mint is a 400, never a silent restart at page one.
    const bad = await get(`${ORDER_ROUTES.list}?cursor=not-a-cursor`, viewerCookie);
    expect(bad.statusCode).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Authorization and tenancy
  // -------------------------------------------------------------------------

  it('refuses an authenticated operator who does not hold orders.view', async () => {
    const product = await sellableProduct(tenantA, panelA);
    const order = await draftFor(tenantA, customerA, product.id);

    for (const path of [ORDER_ROUTES.list, ORDER_ROUTES.detail(order.id)]) {
      const response = await get(path, technicalCookie);
      expect(response.statusCode, path).toBe(403);
      expect(JSON.parse(response.body).error.code, path).toBe(
        PLATFORM_ERROR_CODES.PERMISSION_DENIED,
      );
    }
  });

  it('refuses an unauthenticated caller', async () => {
    const response = await inject({
      method: 'GET',
      url: `${API_PREFIX}${ORDER_ROUTES.list}`,
      headers: { origin: ORIGIN },
    });
    expect(response.statusCode).toBe(401);
  });

  it('cannot reach another tenant’s order, and says only that it is unknown', async () => {
    const panelB = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelB}, ${tenantB.tenantId}, 'Panel B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
    const theirProduct = await sellableProduct(tenantB, panelB);
    const theirCustomer = await customer(tenantB, SEED_IDS.botB1 as BotInstanceId, '900300');
    const theirs = await draftFor(tenantB, theirCustomer, theirProduct.id);

    // The scope comes from the SESSION, so naming the id is useless rather than merely
    // unlikely. And the answer is "unknown", not "forbidden": the second would confirm
    // that the id exists somewhere.
    const response = await get(ORDER_ROUTES.detail(theirs.id), viewerCookie);
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND);

    const list = orderListResponseSchema.parse(
      JSON.parse((await get(ORDER_ROUTES.list, viewerCookie)).body),
    );
    expect(list.orders).toHaveLength(0);
  });

  it('refuses a FILTER that is not an id, rather than answering 500', async () => {
    /*
     * `customer_id` and `product_id` are `uuid` columns, so an unvalidated filter
     * reaches PostgreSQL as `invalid input syntax for type uuid`. That is a 500 with a
     * stack trace in the log for what is almost always an operator pasting a Telegram id
     * into the wrong box — and a 500 tells them the server is broken rather than that
     * the value is not an id.
     *
     * Every shape below was accepted by the first version of `orderListQuerySchema`,
     * which took `z.string().max(64)`.
     */
    for (const bad of ['not-a-uuid', '5551234567', '019220ab-cdef-7012-8345', '%20']) {
      for (const field of ['customerId', 'productId']) {
        const response = await get(`${ORDER_ROUTES.list}?${field}=${bad}`, viewerCookie);
        expect(response.statusCode, `${field}=${bad}`).toBe(400);
        expect(JSON.parse(response.body).error.kind, `${field}=${bad}`).toBe('VALIDATION');
      }
    }
  });

  it('answers a malformed id as a refusal rather than a 500', async () => {
    // `orders.id` is a `uuid` column: an unvalidated path segment reaches PostgreSQL as
    // `invalid input syntax for type uuid` and is answered 500.
    const response = await get(ORDER_ROUTES.detail('not-a-uuid'), viewerCookie);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe(
      COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
    );
  });

  // -------------------------------------------------------------------------
  // The boundary, asserted by asking for what is past it
  // -------------------------------------------------------------------------

  it('has no write route at all: settle, cancel, refund and mark-paid do not exist', async () => {
    const product = await sellableProduct(tenantA, panelA);
    const order = await draftFor(tenantA, customerA, product.id);

    /*
     * Each of these is a real operator action whose meaning depends on a payment record
     * that does not exist in this release. A route answering any of them would be the
     * legacy system's silent-success pattern with a nicer font — and the easiest thing
     * to add here by accident.
     */
    for (const path of [
      `${ORDER_ROUTES.detail(order.id)}/settle`,
      `${ORDER_ROUTES.detail(order.id)}/cancel`,
      `${ORDER_ROUTES.detail(order.id)}/refund`,
      `${ORDER_ROUTES.detail(order.id)}/mark-paid`,
      ORDER_ROUTES.list,
    ]) {
      const response = await inject({
        method: 'POST',
        url: `${API_PREFIX}${path}`,
        headers: { cookie: viewerCookie, origin: ORIGIN },
        payload: { idempotencyKey: 'a-key-long-enough' },
      });
      expect(response.statusCode, path).toBe(404);
    }

    // And the order did not move.
    expect(
      orderResponseSchema.parse(
        JSON.parse((await get(ORDER_ROUTES.detail(order.id), viewerCookie)).body),
      ).order.state,
    ).toBe('DRAFT');
  });
});
