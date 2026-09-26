import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  API_PREFIX,
  AUTH_ROUTES,
  COMMERCE_ERROR_CODES,
  RESELLER_HISTORY_MAX,
  RESELLER_ROUTES,
  RESELLER_TIER_ROUTES,
  SESSION_COOKIE_NAME,
  money,
  resellerCreditResponseSchema,
  resellerHistoryResponseSchema,
  resellerPurchasePageSchema,
  resellerTierResponseSchema,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type TenantContext,
  type UserId,
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
 * WP14 (`docs/wp14-reseller-phase2-audit.md` D1–D3) over real HTTP.
 *
 * Every figure the credit view answers is a derivation of R8 and the ledger, and the test
 * drives the ledger through the real settlement path (`settleFromWallet`) rather than
 * writing entries by hand, so "credit in use" is checked against a debt the product
 * actually produced. No money moves through any route under test: each is a GET.
 */

const ORIGIN = 'https://admin.example.test';
const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const viaBot: TenantContext = { ...tenantA, botInstanceId: BOT_A };

const customerActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('reseller phase 2 HTTP surface (WP14)', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let financeCookie: string;
  let supportCookie: string;
  let foreignCookie: string;
  let panelA: string;
  let customerA: UserId;
  let customerA2: UserId;
  let n = 0;
  const key = (): string => `reseller-p2-${(n += 1)}`;

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
      ['finance', ['finance'], tenantA],
      ['support', ['support'], tenantA],
      ['observer', ['observer'], tenantA],
      ['foreign', ['owner'], tenantB],
    ] as const) {
      await createAdmin(api.container, scope, {
        username,
        password: `the-${username}-password`,
        roleKeys: [...roleKeys],
      });
    }
    ownerCookie = await cookieFor('owner');
    financeCookie = await cookieFor('finance');
    supportCookie = await cookieFor('support');
    api.container.setInstallationTenant(tenantB.tenantId);
    foreignCookie = await cookieFor('foreign');
    api.container.setInstallationTenant(tenantA.tenantId);

    panelA = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(api.container, tenantA, panelA);
    customerA = await customer('950001', 'نیلوفر');
    customerA2 = await customer('950002', 'Behnam');
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

  async function customer(telegramUserId: string, firstName: string): Promise<UserId> {
    const { customer: record } = await api.container.customers.resolveFromUpdate(
      tenantA,
      customerActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: firstName },
        botInstanceId: BOT_A,
      },
    );
    return record.id;
  }

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

  const get = (path: string, cookie: string | null = ownerCookie) =>
    inject({
      method: 'GET',
      url: `${API_PREFIX}${path}`,
      headers: cookie === null ? { origin: ORIGIN } : { cookie, origin: ORIGIN },
    });
  const post = (path: string, payload: unknown, cookie: string | null = ownerCookie) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${path}`,
      headers: cookie === null ? { origin: ORIGIN } : { cookie, origin: ORIGIN },
      payload,
    });

  const tierBody = (overrides: Record<string, unknown> = {}) => ({
    idempotencyKey: key(),
    name: 'Gold',
    pricingMode: 'PERCENTAGE_DISCOUNT',
    discountPercentage: 20,
    creditLimit: { amount: '100000', currency: 'IRT' },
    ...overrides,
  });

  const registerBody = (customerId: string, tierId: string, overrides = {}) => ({
    idempotencyKey: key(),
    customerId,
    tierId,
    pricingMode: 'TIER',
    discountPercentage: null,
    creditLimit: null,
    ...overrides,
  });

  const EVERYTHING = [
    { kind: 'OPERATION', subject: null },
    { kind: 'PRODUCT', subject: null },
    { kind: 'PANEL', subject: null },
    { kind: 'BOT', subject: null },
  ];

  async function createdTier(overrides: Record<string, unknown> = {}): Promise<string> {
    const response = await post(RESELLER_TIER_ROUTES.create, tierBody(overrides));
    expect(response.statusCode, response.body).toBe(201);
    return resellerTierResponseSchema.parse(response.json()).tier.id;
  }

  async function purchasedOnCredit(): Promise<{ tierId: string; orderId: string }> {
    const tierId = await createdTier({ name: 'Gold', discountPercentage: 20 });
    await post(RESELLER_TIER_ROUTES.grants(tierId), { idempotencyKey: key(), grants: EVERYTHING });
    expect((await post(RESELLER_ROUTES.register, registerBody(customerA, tierId))).statusCode).toBe(
      201,
    );
    const drafted = await api.container.orders.createDraft(viaBot, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customerA,
      productId: await product(100_000n),
    });
    await api.container.orders.confirm(viaBot, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customerA,
      orderId: drafted.id,
    });
    // An empty wallet: the whole 80 000 is drawn on the 100 000 credit line.
    const { order } = await api.container.payments.settleFromWallet(
      viaBot,
      customerActor(key()),
      customerA,
      { idempotencyKey: key(), orderId: drafted.id },
    );
    expect(order.state).toBe('PAID');
    return { tierId, orderId: drafted.id };
  }

  const creditOf = async (customerId: string, cookie: string = ownerCookie) => {
    const response = await get(RESELLER_ROUTES.credit(customerId), cookie);
    expect(response.statusCode, response.body).toBe(200);
    return resellerCreditResponseSchema.parse(response.json()).credit;
  };

  const updateBody = (tierId: string, overrides: Record<string, unknown> = {}) => ({
    idempotencyKey: key(),
    tierId,
    status: 'ACTIVE',
    pricingMode: 'TIER',
    discountPercentage: null,
    creditLimit: null,
    ...overrides,
  });

  const IRT = (amount: string) => ({ amount, currency: 'IRT' });

  // -------------------------------------------------------------------------
  // D1 — credit standing
  // -------------------------------------------------------------------------

  it('shows the credit a purchase on credit drew, as settlement would allow the next one', async () => {
    const before = await createdTier({ name: 'Silver' });
    await post(RESELLER_ROUTES.register, registerBody(customerA2, before));
    expect(await creditOf(customerA2), 'nothing drawn yet').toMatchObject({
      credit: 'CREDIT_APPLIES',
      limitSource: 'TIER',
      balance: IRT('0'),
      allowance: IRT('100000'),
      creditInUse: IRT('0'),
      availableToSpend: IRT('100000'),
      overLimitBy: IRT('0'),
    });

    await purchasedOnCredit();
    expect(await creditOf(customerA)).toEqual({
      customerId: customerA,
      status: 'ACTIVE',
      effectiveLimit: IRT('100000'),
      limitSource: 'TIER',
      sellingCurrency: 'IRT',
      credit: 'CREDIT_APPLIES',
      balance: IRT('-80000'),
      allowance: IRT('100000'),
      creditInUse: IRT('80000'),
      availableToSpend: IRT('20000'),
      overLimitBy: IRT('0'),
    });
  });

  it('agrees with settlement at the frontier: available-to-spend passes and one unit more is refused', async () => {
    await purchasedOnCredit();
    const available = BigInt((await creditOf(customerA)).availableToSpend.amount);
    expect(available).toBe(20_000n);

    /*
     * A LIST_PRICE override so the product's price is the order's total, and the view's
     * number is tested against the settlement path itself rather than restated.
     */
    const tierId = await tierOf(customerA);
    await post(
      RESELLER_ROUTES.update(customerA),
      updateBody(tierId, { pricingMode: 'LIST_PRICE' }),
    );
    const over = await confirmedOrder(await product(available + 1n));
    await expect(settle(over)).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS,
      details: { shortfallMinor: '1' },
    });
    const exact = await confirmedOrder(await product(available));
    expect((await settle(exact)).order.state).toBe('PAID');
    expect(await creditOf(customerA)).toMatchObject({
      balance: IRT('-100000'),
      creditInUse: IRT('100000'),
      availableToSpend: IRT('0'),
      overLimitBy: IRT('0'),
    });
  });

  it('reports the debt a lowered limit no longer covers, and leaves it where it is', async () => {
    const { tierId } = await purchasedOnCredit();
    const lowered = await post(
      RESELLER_ROUTES.update(customerA),
      updateBody(tierId, { creditLimit: IRT('50000') }),
    );
    expect(lowered.statusCode, lowered.body).toBe(201);
    expect(await creditOf(customerA)).toMatchObject({
      effectiveLimit: IRT('50000'),
      limitSource: 'RESELLER',
      credit: 'CREDIT_APPLIES',
      balance: IRT('-80000'),
      allowance: IRT('50000'),
      creditInUse: IRT('80000'),
      availableToSpend: IRT('-30000'),
      overLimitBy: IRT('30000'),
    });
  });

  it('keeps a suspended reseller’s debt and applies no credit to it', async () => {
    const { tierId } = await purchasedOnCredit();
    await post(RESELLER_ROUTES.update(customerA), updateBody(tierId, { status: 'SUSPENDED' }));
    expect(await creditOf(customerA)).toMatchObject({
      status: 'SUSPENDED',
      // The limit is still on record; it simply does not apply (R1, R8).
      effectiveLimit: IRT('100000'),
      credit: 'RESELLER_SUSPENDED',
      balance: IRT('-80000'),
      allowance: IRT('0'),
      creditInUse: IRT('80000'),
      availableToSpend: IRT('-80000'),
      overLimitBy: IRT('80000'),
    });
  });

  it('says NO_LIMIT for a zero limit and CURRENCY_MISMATCH for a limit in another currency', async () => {
    const zero = await createdTier({ name: 'Zero', creditLimit: IRT('0') });
    await post(RESELLER_ROUTES.register, registerBody(customerA, zero));
    expect(await creditOf(customerA)).toMatchObject({ credit: 'NO_LIMIT', allowance: IRT('0') });

    await post(
      RESELLER_ROUTES.update(customerA),
      updateBody(zero, { creditLimit: { amount: '5000', currency: 'USD' } }),
    );
    expect(await creditOf(customerA)).toMatchObject({
      credit: 'CURRENCY_MISMATCH',
      effectiveLimit: { amount: '5000', currency: 'USD' },
      sellingCurrency: 'IRT',
      allowance: IRT('0'),
      availableToSpend: IRT('0'),
    });
  });

  // -------------------------------------------------------------------------
  // D2 — purchase history
  // -------------------------------------------------------------------------

  it('lists the purchase as confirmation recorded it, survives a tier re-price and rename, and omits the margin', async () => {
    const { tierId, orderId } = await purchasedOnCredit();
    const renamed = await post(
      RESELLER_TIER_ROUTES.update(tierId),
      tierBody({ name: 'Platinum', discountPercentage: 50 }),
    );
    expect(renamed.statusCode, renamed.body).toBe(201);

    const response = await get(RESELLER_ROUTES.purchases(customerA));
    expect(response.statusCode, response.body).toBe(200);
    const page = resellerPurchasePageSchema.parse(response.json());
    expect(page.nextCursor).toBeNull();
    expect(page.purchases).toEqual([
      {
        orderId,
        orderState: 'PAID',
        purpose: 'NEW_SERVICE',
        confirmedAt: expect.any(String),
        tierName: 'Gold',
        layer: 'TIER',
        percent: 20,
        listAmount: '100000',
        costAmount: '80000',
        promotionAmount: '0',
        saleAmount: '80000',
        currency: 'IRT',
      },
    ]);
    expect(response.body).not.toContain('margin');
  });

  it('pages purchases newest first with a keyset cursor, and refuses a cursor it did not write', async () => {
    const { tierId } = await purchasedOnCredit();
    await post(
      RESELLER_ROUTES.update(customerA),
      updateBody(tierId, { pricingMode: 'LIST_PRICE' }),
    );
    const second = await confirmedOrder(await product(1_000n));
    const third = await confirmedOrder(await product(1_000n));

    const first = resellerPurchasePageSchema.parse(
      (await get(`${RESELLER_ROUTES.purchases(customerA)}?limit=2`)).json(),
    );
    expect(first.purchases.map((p) => p.orderId)).toEqual([third, second]);
    expect(first.nextCursor).not.toBeNull();
    const rest = resellerPurchasePageSchema.parse(
      (
        await get(
          `${RESELLER_ROUTES.purchases(customerA)}?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`,
        )
      ).json(),
    );
    expect(rest.purchases).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
    // A confirmed-but-unpaid order is still a purchase record, in its current state.
    expect(first.purchases.every((p) => p.orderState === 'AWAITING_PAYMENT')).toBe(true);

    expect(
      (await get(`${RESELLER_ROUTES.purchases(customerA)}?cursor=bm90LWEtY3Vyc29y`)).statusCode,
    ).toBe(400);
  });

  // -------------------------------------------------------------------------
  // D3 — change history
  // -------------------------------------------------------------------------

  it('returns exactly this reseller’s audited changes, newest first, without IP or user agent', async () => {
    const tierId = await createdTier();
    await post(RESELLER_ROUTES.register, registerBody(customerA, tierId));
    await post(RESELLER_ROUTES.register, registerBody(customerA2, tierId));
    await post(RESELLER_ROUTES.update(customerA), updateBody(tierId, { status: 'SUSPENDED' }));
    // A refused update is part of the history too, recorded as DENIED.
    await post(RESELLER_ROUTES.update(customerA), updateBody(tierId), financeCookie);
    // Something else recorded against the same customer is not reseller history.
    await api.container.wallet.adjust(tenantA, await ownerActor(), customerA, {
      idempotencyKey: key(),
      direction: 'CREDIT',
      amountMinor: 1n,
      currency: 'IRT',
      note: 'x',
    });

    const response = await get(RESELLER_ROUTES.history(customerA));
    expect(response.statusCode, response.body).toBe(200);
    const { entries } = resellerHistoryResponseSchema.parse(response.json());
    expect(entries.map((e) => [e.action, e.result])).toEqual([
      ['reseller.update', 'DENIED'],
      ['reseller.update', 'SUCCESS'],
      ['reseller.register', 'SUCCESS'],
    ]);
    expect(entries[1]).toMatchObject({
      actorType: 'WEB_ADMIN',
      surface: 'WEB',
      before: { status: 'ACTIVE' },
      after: { status: 'SUSPENDED' },
    });
    expect(response.body).not.toMatch(/"ip"|userAgent|user_agent|wallet\./u);
  });

  it('returns a tier’s own audited changes and never another tier’s', async () => {
    const tierId = await createdTier();
    const other = await createdTier({ name: 'Other' });
    await post(RESELLER_TIER_ROUTES.update(tierId), tierBody({ name: 'Renamed' }));
    await post(RESELLER_TIER_ROUTES.grants(tierId), { idempotencyKey: key(), grants: EVERYTHING });
    await post(RESELLER_TIER_ROUTES.update(other), tierBody({ name: 'Other 2' }));

    const { entries } = resellerHistoryResponseSchema.parse(
      (await get(RESELLER_TIER_ROUTES.history(tierId))).json(),
    );
    expect(entries.map((e) => e.action)).toEqual([
      'reseller_tier.grants',
      'reseller_tier.update',
      'reseller_tier.create',
    ]);
    expect(entries[1]?.after).toMatchObject({ name: 'Renamed' });
  });

  it('bounds the history at RESELLER_HISTORY_MAX rows', async () => {
    const tierId = await createdTier();
    await post(RESELLER_ROUTES.register, registerBody(customerA, tierId));
    for (let i = 0; i < RESELLER_HISTORY_MAX + 2; i += 1) {
      await post(
        RESELLER_ROUTES.update(customerA),
        updateBody(tierId, { status: i % 2 === 0 ? 'SUSPENDED' : 'ACTIVE' }),
      );
    }
    const { entries } = resellerHistoryResponseSchema.parse(
      (await get(RESELLER_ROUTES.history(customerA))).json(),
    );
    expect(entries).toHaveLength(RESELLER_HISTORY_MAX);
    expect(entries.some((e) => e.action === 'reseller.register')).toBe(false);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Authorization and isolation
  // -------------------------------------------------------------------------

  it('charges resellers.view and the extra key each view needs, on every new route', async () => {
    const { tierId } = await purchasedOnCredit();
    const routes = [
      RESELLER_ROUTES.credit(customerA),
      RESELLER_ROUTES.purchases(customerA),
      RESELLER_ROUTES.history(customerA),
      RESELLER_TIER_ROUTES.history(tierId),
    ];
    for (const path of routes) {
      expect((await get(path, null)).statusCode, path).toBe(401);
      // Support holds users.view and orders.view, but not resellers.view.
      expect((await get(path, supportCookie)).statusCode, path).toBe(403);
      // Finance holds all four keys.
      expect((await get(path, financeCookie)).statusCode, path).toBe(200);
    }

    const drop = (permission: string) =>
      api.container.database.db.execute(sql`
        DELETE FROM role_permissions rp USING roles r
         WHERE r.id = rp.role_id AND r.tenant_id = rp.tenant_id
           AND r.key = 'finance' AND rp.permission_key = ${permission}`);

    await drop('audit.view');
    expect((await get(RESELLER_ROUTES.history(customerA), financeCookie)).statusCode).toBe(403);
    expect((await get(RESELLER_TIER_ROUTES.history(tierId), financeCookie)).statusCode).toBe(403);
    expect((await get(RESELLER_ROUTES.credit(customerA), financeCookie)).statusCode).toBe(200);

    await drop('orders.view');
    expect((await get(RESELLER_ROUTES.purchases(customerA), financeCookie)).statusCode).toBe(403);
    expect((await get(RESELLER_ROUTES.credit(customerA), financeCookie)).statusCode).toBe(200);

    await drop('users.view');
    expect((await get(RESELLER_ROUTES.credit(customerA), financeCookie)).statusCode).toBe(403);
  });

  it('shows tenant B nothing of tenant A’s credit, purchases or history, and 404s an unknown id', async () => {
    const { tierId } = await purchasedOnCredit();
    for (const path of [
      RESELLER_ROUTES.credit(customerA),
      RESELLER_ROUTES.purchases(customerA),
      RESELLER_ROUTES.history(customerA),
      RESELLER_TIER_ROUTES.history(tierId),
    ]) {
      expect((await get(path, foreignCookie)).statusCode, path).toBe(404);
    }
    for (const path of [
      RESELLER_ROUTES.credit(customerA2),
      RESELLER_ROUTES.purchases(customerA2),
      RESELLER_ROUTES.history(customerA2),
      RESELLER_ROUTES.credit('not-a-uuid'),
      RESELLER_TIER_ROUTES.history(api.container.ids.uuid()),
      RESELLER_TIER_ROUTES.history('not-a-uuid'),
    ]) {
      expect((await get(path)).statusCode, path).toBe(404);
    }
  });

  // -------------------------------------------------------------------------
  // Helpers that need the scenario above
  // -------------------------------------------------------------------------

  async function tierOf(customerId: string): Promise<string> {
    const rows = await api.container.database.db.execute(
      sql`SELECT tier_id FROM resellers WHERE customer_id = ${customerId}`,
    );
    return (rows.rows[0] as { tier_id: string }).tier_id;
  }

  async function confirmedOrder(productId: ProductId): Promise<string> {
    const drafted = await api.container.orders.createDraft(viaBot, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customerA,
      productId,
    });
    await api.container.orders.confirm(viaBot, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customerA,
      orderId: drafted.id,
    });
    return drafted.id;
  }

  const settle = (orderId: string) =>
    api.container.payments.settleFromWallet(viaBot, customerActor(key()), customerA, {
      idempotencyKey: key(),
      orderId,
    });

  async function ownerActor(): Promise<ActorContext> {
    const rows = await api.container.database.db.execute(
      sql`SELECT id FROM admins WHERE username = 'owner' AND tenant_id = ${tenantA.tenantId}`,
    );
    return {
      type: 'WEB_ADMIN',
      id: (rows.rows[0] as { id: string }).id,
      label: 'owner',
      surface: 'WEB',
      correlationId: `wp14-${key()}` as CorrelationId,
    };
  }
});
