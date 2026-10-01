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
import { hashRequest } from '../../apps/api/src/modules/platform/idempotency/infrastructure/drizzle-idempotency-store';
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
    creditLimit: { amount: '0', currency: 'IRT' },
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

  /** A paid reseller purchase, from a wallet funded with exactly its price. */
  async function purchased(): Promise<{ tierId: string; orderId: string }> {
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
    // No reseller credit (owner decision, 2026-10-01): the wallet holds the 80 000 it pays.
    await fund(customerA, 80_000n);
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

  /*
   * Reseller credit was removed (owner decision, 2026-10-01: no reseller debt, no credit
   * purchases). The view keeps its shape and reports the balance and any legacy debt, with
   * an allowance of zero, whatever limit a row stored before the decision still holds.
   */

  const fund = async (customerId: string, amountMinor: bigint) =>
    api.container.wallet.adjust(tenantA, await ownerActor(), customerId as UserId, {
      idempotencyKey: key(),
      direction: 'CREDIT',
      amountMinor,
      currency: 'IRT',
      note: 'شارژ آزمون',
    });

  /** A limit stored BEFORE the decision: no write can set one now, so the row is edited. */
  const legacyLimit = (table: 'reseller_tiers' | 'resellers', id: string, amount: bigint) =>
    table === 'reseller_tiers'
      ? api.container.database.db.execute(
          sql`UPDATE reseller_tiers SET credit_limit_amount = ${amount} WHERE id = ${id}`,
        )
      : api.container.database.db.execute(
          sql`UPDATE resellers SET credit_limit_amount = ${amount}, credit_limit_currency = 'IRT'
               WHERE customer_id = ${id}`,
        );

  /** A debt run up under the old credit line: a plain ledger row, as it was written then. */
  const legacyDebt = (customerId: string, amount: bigint) =>
    api.container.database.db.execute(sql`
      INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount, currency, reference)
      VALUES (${api.container.ids.uuid()}, ${tenantA.tenantId}, ${customerId}, 'DEBIT', 'PURCHASE',
              ${amount}, 'IRT', ${`legacy-credit-${key()}`})`);

  it('shows the balance with an allowance of zero: there is no credit to draw', async () => {
    const tierId = await createdTier({ name: 'Silver' });
    await post(RESELLER_ROUTES.register, registerBody(customerA2, tierId));
    expect(await creditOf(customerA2), 'nothing drawn, nothing available on credit').toEqual({
      customerId: customerA2,
      status: 'ACTIVE',
      effectiveLimit: IRT('0'),
      limitSource: 'TIER',
      sellingCurrency: 'IRT',
      credit: 'NO_LIMIT',
      balance: IRT('0'),
      allowance: IRT('0'),
      creditInUse: IRT('0'),
      availableToSpend: IRT('0'),
      overLimitBy: IRT('0'),
    });

    await purchased();
    expect(await creditOf(customerA)).toMatchObject({
      credit: 'NO_LIMIT',
      balance: IRT('0'),
      allowance: IRT('0'),
      creditInUse: IRT('0'),
      availableToSpend: IRT('0'),
    });
  });

  it('agrees with settlement at the frontier: available-to-spend is the balance, one unit more is refused', async () => {
    const { tierId } = await purchased();
    await legacyLimit('reseller_tiers', tierId, 100_000n);
    await fund(customerA, 20_000n);
    const available = BigInt((await creditOf(customerA)).availableToSpend.amount);
    expect(available, 'a stored limit of 100 000 adds nothing').toBe(20_000n);

    /*
     * A LIST_PRICE override so the product's price is the order's total, and the view's
     * number is tested against the settlement path itself rather than restated.
     */
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
      balance: IRT('0'),
      creditInUse: IRT('0'),
      availableToSpend: IRT('0'),
      overLimitBy: IRT('0'),
    });
  });

  it('shows a legacy debt as it is, under a stored limit that grants nothing, active or suspended', async () => {
    const { tierId } = await purchased();
    await legacyLimit('resellers', customerA, 100_000n);
    await legacyDebt(customerA, 80_000n);
    const legacy = {
      effectiveLimit: IRT('100000'),
      limitSource: 'RESELLER',
      credit: 'NO_LIMIT',
      balance: IRT('-80000'),
      allowance: IRT('0'),
      creditInUse: IRT('80000'),
      availableToSpend: IRT('-80000'),
      overLimitBy: IRT('80000'),
    };
    expect(await creditOf(customerA)).toMatchObject({ status: 'ACTIVE', ...legacy });
    const order = await confirmedOrder(await product(1_000n));
    await expect(settle(order)).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS,
    });

    // A suspension that echoes nothing about credit leaves the debt, and the stored limit
    // is cleared by the write (null: no limit of its own).
    await post(RESELLER_ROUTES.update(customerA), updateBody(tierId, { status: 'SUSPENDED' }));
    expect(await creditOf(customerA)).toMatchObject({
      status: 'SUSPENDED',
      ...legacy,
      effectiveLimit: IRT('0'),
      limitSource: 'TIER',
    });
  });

  it('refuses a non-zero credit limit with 400 on every write, and stores none', async () => {
    const refused = [
      await post(RESELLER_TIER_ROUTES.create, tierBody({ creditLimit: IRT('100000') })),
      await post(RESELLER_TIER_ROUTES.create, tierBody({ creditLimit: IRT('1') })),
    ];
    const tierId = await createdTier({ name: 'Zero' });
    refused.push(
      await post(RESELLER_TIER_ROUTES.update(tierId), tierBody({ creditLimit: IRT('5000') })),
      await post(
        RESELLER_ROUTES.register,
        registerBody(customerA, tierId, { creditLimit: IRT('5000') }),
      ),
    );
    expect((await post(RESELLER_ROUTES.register, registerBody(customerA, tierId))).statusCode).toBe(
      201,
    );
    refused.push(
      await post(
        RESELLER_ROUTES.update(customerA),
        updateBody(tierId, { creditLimit: { amount: '5000', currency: 'USD' } }),
      ),
    );
    for (const response of refused) {
      expect(response.statusCode, response.body).toBe(400);
    }
    const stored = await api.container.database.db.execute(sql`
      SELECT credit_limit_amount::text AS amount FROM reseller_tiers
      UNION ALL SELECT credit_limit_amount::text FROM resellers`);
    expect(
      (stored.rows as { amount: string | null }[]).every(
        (r) => r.amount === null || r.amount === '0',
      ),
    ).toBe(true);
    expect(await creditOf(customerA)).toMatchObject({
      credit: 'NO_LIMIT',
      allowance: IRT('0'),
    });
  });

  it('replays over HTTP a positive-limit tier command that committed before the decision', async () => {
    /*
     * PR #132 review, finding 2: the schema must let the pre-decision body through to the
     * service's replay lookup, so a retry across the upgrade gets its original 201.
     */
    const idempotencyKey = key();
    const body = tierBody({ idempotencyKey, name: 'Legacy', creditLimit: IRT('0') });
    const first = await post(RESELLER_TIER_ROUTES.create, body);
    expect(first.statusCode, first.body).toBe(201);
    const original = resellerTierResponseSchema.parse(first.json()).tier.id;
    // The previous release hashed the body it was sent, positive limit included.
    await api.container.database.db.execute(sql`
      UPDATE request_idempotency
         SET request_hash = ${hashRequest({
           tier: {
             name: 'Legacy',
             pricingMode: 'PERCENTAGE_DISCOUNT',
             discountPercentage: 20,
             creditLimit: { amount: '100000', currency: 'IRT' },
           },
         })}
       WHERE key = ${idempotencyKey}`);
    const retried = await post(RESELLER_TIER_ROUTES.create, {
      ...body,
      creditLimit: IRT('100000'),
    });
    expect(retried.statusCode, retried.body).toBe(201);
    expect(resellerTierResponseSchema.parse(retried.json()).tier).toMatchObject({
      id: original,
      creditLimit: IRT('0'),
    });
    // A new key with the same positive limit is refused.
    expect(
      (
        await post(
          RESELLER_TIER_ROUTES.create,
          tierBody({ name: 'New', creditLimit: IRT('100000') }),
        )
      ).statusCode,
    ).toBe(400);
  });

  // -------------------------------------------------------------------------
  // D2 — purchase history
  // -------------------------------------------------------------------------

  it('lists the purchase as confirmation recorded it, survives a tier re-price and rename, and omits the margin', async () => {
    const { tierId, orderId } = await purchased();
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
    const { tierId } = await purchased();
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
    const { tierId } = await purchased();
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
    const { tierId } = await purchased();
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
