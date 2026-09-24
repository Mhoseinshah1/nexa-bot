import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  API_PREFIX,
  AUTH_ROUTES,
  CASHBACK_RULE_ROUTES,
  DISCOUNT_ROUTES,
  ORDER_ROUTES,
  PRICE_PREVIEW_ROUTE,
  SESSION_COOKIE_NAME,
  cashbackRuleResponseSchema,
  discountListResponseSchema,
  discountResponseSchema,
  money,
  orderPricingResponseSchema,
  pricePreviewResponseSchema,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  createAdmin,
  makePanelSellable,
  migrateOnce,
  resetDatabase,
  tenantA,
  tenantB,
  testConfig,
} from './harness';

/**
 * The pricing surface over real HTTP (WP8 P12): discounts, cashback rules, the preview
 * and an order's pricing.
 *
 * Every response is parsed through its CONTRACT schema, so the wire shape the Web Admin
 * reads is the one the controller writes — a field renamed on one side and not the
 * other fails here rather than rendering blank. Authorization is asserted at the edge
 * too: a role without the permission is answered 403 by the service, not hidden by a
 * button.
 */

const ORIGIN = 'https://admin.example.test';

const customerActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('pricing HTTP surface', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let salesCookie: string;
  let supportCookie: string;
  let technicalCookie: string;
  let foreignCookie: string;
  let panelA: string;
  let n = 0;
  const key = (): string => `pricing-http-${(n += 1)}`;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN });
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
    for (const [username, roleKeys, scope] of [
      ['owner', ['owner'], tenantA],
      ['sales', ['sales'], tenantA],
      ['support', ['support'], tenantA],
      ['technical', ['technical'], tenantA],
      ['foreign', ['owner'], tenantB],
    ] as const) {
      await createAdmin(api.container, scope, {
        username,
        password: `the-${username}-password`,
        roleKeys: [...roleKeys],
      });
    }
    ownerCookie = await cookieFor('owner');
    salesCookie = await cookieFor('sales');
    supportCookie = await cookieFor('support');
    technicalCookie = await cookieFor('technical');
    api.container.setInstallationTenant(tenantB.tenantId);
    foreignCookie = await cookieFor('foreign');
    api.container.setInstallationTenant(tenantA.tenantId);

    panelA = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(api.container, tenantA, panelA);
  });

  async function cookieFor(username: string): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password: `the-${username}-password` },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(response.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error(`No session cookie for ${username}: ${response.body}`);
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  const get = (path: string, cookie = ownerCookie) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: { cookie, origin: ORIGIN } });
  const post = (path: string, payload: unknown, cookie = ownerCookie) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${path}`,
      headers: { cookie, origin: ORIGIN },
      payload,
    });

  const discountBody = (overrides: Record<string, unknown> = {}) => ({
    idempotencyKey: key(),
    kind: 'CODE',
    code: 'spring25',
    label: 'بهار',
    type: 'PERCENTAGE',
    value: '25',
    currency: null,
    appliesTo: ['NEW_SERVICE'],
    productId: null,
    categoryId: null,
    customerId: null,
    firstPurchaseOnly: false,
    minimumSubtotalAmount: null,
    startsAt: null,
    endsAt: null,
    totalRedemptionsLimit: 10,
    perCustomerLimit: 1,
    priority: 5,
    stackable: false,
    ...overrides,
  });

  async function product(price: bigint): Promise<ProductId> {
    const products = new DrizzleProductRepository(api.container.database.db);
    const created = await products.create(tenantA, {
      id: api.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: 'یک ماهه',
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelA as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(price, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: api.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', api.container.clock.now());
    return created.id;
  }

  it('creates an INACTIVE discount with its code normalised, lists it, and activates it', async () => {
    const created = await post(DISCOUNT_ROUTES.create, discountBody());
    expect(created.statusCode).toBe(201);
    const { discount } = discountResponseSchema.parse(created.json());
    expect(discount).toMatchObject({
      code: 'SPRING25',
      status: 'INACTIVE',
      value: '25',
      liveRedemptions: 0,
    });

    const list = discountListResponseSchema.parse((await get(DISCOUNT_ROUTES.list)).json());
    expect(list.discounts.map((d) => d.id)).toEqual([discount.id]);

    const activated = await post(DISCOUNT_ROUTES.activate(discount.id), {
      idempotencyKey: key(),
    });
    expect(discountResponseSchema.parse(activated.json()).discount.status).toBe('ACTIVE');

    const detail = discountResponseSchema.parse(
      (await get(DISCOUNT_ROUTES.detail(discount.id))).json(),
    );
    expect(detail.discount.status).toBe('ACTIVE');
  });

  it('answers a taken code 409, a changed code 400, and an unknown id 404', async () => {
    const { discount } = discountResponseSchema.parse(
      (await post(DISCOUNT_ROUTES.create, discountBody())).json(),
    );
    expect(
      (await post(DISCOUNT_ROUTES.create, discountBody({ code: 'SPRING25' }))).statusCode,
    ).toBe(409);
    expect(
      (await post(DISCOUNT_ROUTES.update(discount.id), discountBody({ code: 'OTHER' }))).statusCode,
    ).toBe(400);
    expect((await get(DISCOUNT_ROUTES.detail(api.container.ids.uuid()))).statusCode).toBe(404);
    expect((await get(DISCOUNT_ROUTES.detail('not-a-uuid'))).statusCode).toBe(400);
  });

  it('refuses a body the contract refuses, naming the field rather than a constraint', async () => {
    const response = await post(
      DISCOUNT_ROUTES.create,
      discountBody({ type: 'PERCENTAGE', value: '150' }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('charges catalog.discounts.edit to write and catalog.pricing.edit for cashback', async () => {
    expect((await post(DISCOUNT_ROUTES.create, discountBody(), supportCookie)).statusCode).toBe(
      403,
    );
    expect((await post(DISCOUNT_ROUTES.create, discountBody(), salesCookie)).statusCode).toBe(201);
    const cashback = {
      idempotencyKey: key(),
      label: 'کش‌بک',
      percent: 5,
      appliesTo: ['NEW_SERVICE'],
      productId: null,
      categoryId: null,
      startsAt: null,
      endsAt: null,
    };
    expect((await post(CASHBACK_RULE_ROUTES.create, cashback, salesCookie)).statusCode).toBe(403);
    const created = await post(CASHBACK_RULE_ROUTES.create, cashback);
    expect(created.statusCode).toBe(201);
    expect(cashbackRuleResponseSchema.parse(created.json()).rule).toMatchObject({
      percent: 5,
      status: 'INACTIVE',
    });
  });

  it('keeps another tenant’s rules out of reach', async () => {
    const { discount } = discountResponseSchema.parse(
      (await post(DISCOUNT_ROUTES.create, discountBody())).json(),
    );
    expect((await get(DISCOUNT_ROUTES.detail(discount.id), foreignCookie)).statusCode).toBe(404);
    const theirs = discountListResponseSchema.parse(
      (await get(DISCOUNT_ROUTES.list, foreignCookie)).json(),
    );
    expect(theirs.discounts).toEqual([]);
  });

  it('previews a price through the checkout engine without writing anything', async () => {
    const { discount } = discountResponseSchema.parse(
      (await post(DISCOUNT_ROUTES.create, discountBody({ perCustomerLimit: null }))).json(),
    );
    await post(DISCOUNT_ROUTES.activate(discount.id), { idempotencyKey: key() });
    const productId = await product(100_000n);

    const response = await get(
      `${PRICE_PREVIEW_ROUTE}?purpose=NEW_SERVICE&productId=${productId}&code=spring25`,
    );
    expect(response.statusCode).toBe(200);
    const preview = pricePreviewResponseSchema.parse(response.json());
    expect(preview).toMatchObject({
      subtotalAmount: '100000',
      discountAmount: '25000',
      totalAmount: '75000',
      code: { accepted: true, reason: null },
    });
    expect(preview.rules).toEqual([
      { discountId: discount.id, label: 'بهار', kind: 'CODE', outcome: 'APPLIED', reason: null },
    ]);
    const orders = (await api.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM orders` as never,
    )) as unknown as { rows: { n: number }[] };
    expect(orders.rows[0]?.n).toBe(0);
  });

  it('reports a code that depends on the customer as undecided, never as a made-up reason', async () => {
    const { discount } = discountResponseSchema.parse(
      (await post(DISCOUNT_ROUTES.create, discountBody({ perCustomerLimit: 1 }))).json(),
    );
    await post(DISCOUNT_ROUTES.activate(discount.id), { idempotencyKey: key() });
    const productId = await product(100_000n);
    const preview = pricePreviewResponseSchema.parse(
      (
        await get(`${PRICE_PREVIEW_ROUTE}?purpose=NEW_SERVICE&productId=${productId}&code=spring25`)
      ).json(),
    );
    // A per-customer limit, previewed without a customer: neither yes nor any refusal.
    expect(preview.code).toEqual({ accepted: false, reason: null });
    expect(preview.rules[0]).toMatchObject({ outcome: 'CUSTOMER_DEPENDENT', reason: null });
    expect(preview.totalAmount).toBe('100000');
  });

  it('refuses a preview that prices an add-on purpose from a product', async () => {
    const productId = await product(100_000n);
    expect(
      (await get(`${PRICE_PREVIEW_ROUTE}?purpose=ADD_TRAFFIC&productId=${productId}`)).statusCode,
    ).toBe(400);
  });

  it('shows an order’s pricing on its own route', async () => {
    const { discount } = discountResponseSchema.parse(
      (await post(DISCOUNT_ROUTES.create, discountBody({ perCustomerLimit: null }))).json(),
    );
    await post(DISCOUNT_ROUTES.activate(discount.id), { idempotencyKey: key() });
    const { customer } = await api.container.customers.resolveFromUpdate(
      tenantA,
      customerActor('resolve-http'),
      {
        idempotencyKey: 'resolve-http',
        telegramUserId: '930001',
        from: { id: 930001, first_name: 'زهرا' },
        botInstanceId: SEED_IDS.botA1 as BotInstanceId,
      },
    );
    const draft = await api.container.orders.createDraft(tenantA, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customer.id,
      productId: await product(100_000n),
    });
    await api.container.orders.applyDiscountCode(tenantA, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customer.id,
      orderId: draft.id,
      code: 'SPRING25',
    });
    await api.container.orders.confirm(tenantA, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customer.id,
      orderId: draft.id,
    });

    const response = await get(ORDER_ROUTES.pricing(draft.id));
    expect(response.statusCode).toBe(200);
    const pricing = orderPricingResponseSchema.parse(response.json());
    expect(pricing).toMatchObject({
      orderId: draft.id,
      discountCode: 'SPRING25',
      subtotalAmount: '100000',
      discountAmount: '25000',
      totalAmount: '75000',
      cashback: null,
    });
    expect(pricing.adjustments).toEqual([
      { ruleId: discount.id, label: 'بهار', amountBefore: '100000', amountAfter: '75000' },
    ]);
    expect(pricing.redemptions.map((r) => [r.discountId, r.amount])).toEqual([
      [discount.id, '25000'],
    ]);
    // `orders.view` is required; Technical holds no `orders.*` permission.
    expect((await get(ORDER_ROUTES.pricing(draft.id), technicalCookie)).statusCode).toBe(403);
  });
});
