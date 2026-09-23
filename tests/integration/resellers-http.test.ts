import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  ORDER_ROUTES,
  RESELLER_ROUTES,
  RESELLER_TIER_ROUTES,
  SESSION_COOKIE_NAME,
  money,
  orderPricingResponseSchema,
  resellerListResponseSchema,
  resellerResponseSchema,
  resellerTierListResponseSchema,
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
 * The reseller surface over real HTTP (`docs/wp9-reseller-audit.md` R11, R12).
 *
 * Every response is parsed through its CONTRACT schema, so the wire shape the Web Admin
 * reads is the one the controller writes. Authorization is asserted at the edge:
 * `resellers.view` for reads, `resellers.edit` for writes, charged by the service and
 * answered 401/403 here — never by a button that is not drawn.
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

describe('reseller HTTP surface', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let financeCookie: string;
  let supportCookie: string;
  let observerCookie: string;
  let foreignCookie: string;
  let panelA: string;
  let customerA: UserId;
  let customerA2: UserId;
  let n = 0;
  const key = (): string => `reseller-http-${(n += 1)}`;

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
    observerCookie = await cookieFor('observer');
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

  // -------------------------------------------------------------------------
  // Authentication and authorization
  // -------------------------------------------------------------------------

  it('answers 401 to a request with no session, on every route', async () => {
    const tierId = api.container.ids.uuid();
    for (const response of [
      await get(RESELLER_TIER_ROUTES.list, null),
      await get(RESELLER_TIER_ROUTES.detail(tierId), null),
      await get(RESELLER_ROUTES.list, null),
      await get(RESELLER_ROUTES.detail(customerA), null),
      await post(RESELLER_TIER_ROUTES.create, tierBody(), null),
      await post(RESELLER_TIER_ROUTES.update(tierId), tierBody(), null),
      await post(RESELLER_TIER_ROUTES.grants(tierId), { idempotencyKey: key(), grants: [] }, null),
      await post(RESELLER_ROUTES.register, registerBody(customerA, tierId), null),
    ]) {
      expect(response.statusCode, response.body).toBe(401);
    }
    expect(await tierCount()).toBe(0);
  });

  it('answers 403 to an admin without resellers.view, on every read', async () => {
    const tierId = await createdTier();
    for (const path of [
      RESELLER_TIER_ROUTES.list,
      RESELLER_TIER_ROUTES.detail(tierId),
      RESELLER_ROUTES.list,
      RESELLER_ROUTES.detail(customerA),
    ]) {
      expect((await get(path, supportCookie)).statusCode, path).toBe(403);
    }
  });

  it('lets finance and observer read (resellers.view) and refuses them every write (resellers.edit)', async () => {
    const tierId = await createdTier();
    const registered = await post(RESELLER_ROUTES.register, registerBody(customerA, tierId));
    expect(registered.statusCode, registered.body).toBe(201);

    for (const cookie of [financeCookie, observerCookie]) {
      const tiers = await get(RESELLER_TIER_ROUTES.list, cookie);
      expect(tiers.statusCode, tiers.body).toBe(200);
      expect(resellerTierListResponseSchema.parse(tiers.json()).tiers.map((t) => t.id)).toEqual([
        tierId,
      ]);
      const list = await get(RESELLER_ROUTES.list, cookie);
      expect(list.statusCode).toBe(200);
      expect(resellerListResponseSchema.parse(list.json()).resellers).toHaveLength(1);

      for (const response of [
        await post(RESELLER_TIER_ROUTES.create, tierBody({ name: 'Other' }), cookie),
        await post(RESELLER_TIER_ROUTES.update(tierId), tierBody({ name: 'Renamed' }), cookie),
        await post(
          RESELLER_TIER_ROUTES.grants(tierId),
          { idempotencyKey: key(), grants: EVERYTHING },
          cookie,
        ),
        await post(RESELLER_ROUTES.register, registerBody(customerA2, tierId), cookie),
        await post(
          RESELLER_ROUTES.update(customerA),
          { ...registerBody(customerA, tierId), status: 'SUSPENDED' },
          cookie,
        ),
      ]) {
        expect(response.statusCode, response.body).toBe(403);
      }
    }
    const tier = resellerTierResponseSchema.parse(
      (await get(RESELLER_TIER_ROUTES.detail(tierId))).json(),
    ).tier;
    expect(tier).toMatchObject({ name: 'Gold', grants: [] });
    expect(await tierCount()).toBe(1);
  });

  it('gives finance resellers.view through migration 0112 on an installation whose role predates it', async () => {
    const query = (text: string) =>
      api.container.database.withClient((client) => client.query(text));
    // An installation upgraded from before WP9-B: finance exists without the key.
    await query(`
      DELETE FROM role_permissions rp USING roles r
       WHERE r.id = rp.role_id AND r.tenant_id = rp.tenant_id
         AND r.key = 'finance' AND rp.permission_key = 'resellers.view'`);
    expect((await get(RESELLER_TIER_ROUTES.list, financeCookie)).statusCode).toBe(403);

    // The statement under test, read from the migration and never retyped.
    const migration = readFileSync('apps/api/drizzle/0112_resellers_view_finance.sql', 'utf8');
    const start = migration.indexOf('INSERT INTO "role_permissions"');
    expect(start).toBeGreaterThan(-1);
    await query(migration.slice(start));
    await query(migration.slice(start)); // and it is safe to run twice

    expect((await get(RESELLER_TIER_ROUTES.list, financeCookie)).statusCode).toBe(200);
    expect(
      (await post(RESELLER_TIER_ROUTES.create, tierBody(), financeCookie)).statusCode,
      'view, never edit',
    ).toBe(403);
    const granted = await query(`
      SELECT r.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
       WHERE rp.permission_key = 'resellers.edit' AND r.tenant_id = '${SEED_IDS.tenantA}'
       ORDER BY r.key`);
    expect(granted.rows.map((row: Record<string, string>) => row.key)).toEqual(['owner']);
  });

  // -------------------------------------------------------------------------
  // The owner's round trip, parsed by the contracts
  // -------------------------------------------------------------------------

  it('creates, reads, updates and grants a tier, every response parsing with its contract', async () => {
    const created = await post(RESELLER_TIER_ROUTES.create, tierBody());
    expect(created.statusCode, created.body).toBe(201);
    const { tier } = resellerTierResponseSchema.parse(created.json());
    expect(tier).toMatchObject({
      name: 'Gold',
      pricingMode: 'PERCENTAGE_DISCOUNT',
      discountPercentage: 20,
      creditLimit: { amount: '100000', currency: 'IRT' },
      grants: [],
      resellerCount: 0,
    });

    const detail = await get(RESELLER_TIER_ROUTES.detail(tier.id));
    expect(detail.statusCode).toBe(200);
    expect(resellerTierResponseSchema.parse(detail.json()).tier.id).toBe(tier.id);

    const updated = await post(
      RESELLER_TIER_ROUTES.update(tier.id),
      tierBody({ name: 'Platinum', pricingMode: 'LIST_PRICE', discountPercentage: null }),
    );
    expect(updated.statusCode, updated.body).toBe(201);
    expect(resellerTierResponseSchema.parse(updated.json()).tier).toMatchObject({
      name: 'Platinum',
      pricingMode: 'LIST_PRICE',
      discountPercentage: null,
    });

    const grants = [
      { kind: 'OPERATION', subject: 'NEW_SERVICE' },
      { kind: 'PANEL', subject: panelA },
      { kind: 'BOT', subject: BOT_A },
      { kind: 'CATEGORY', subject: null },
    ];
    const granted = await post(RESELLER_TIER_ROUTES.grants(tier.id), {
      idempotencyKey: key(),
      grants,
    });
    expect(granted.statusCode, granted.body).toBe(201);
    expect(
      new Set(resellerTierResponseSchema.parse(granted.json()).tier.grants.map((g) => g.kind)),
    ).toEqual(new Set(['OPERATION', 'PANEL', 'BOT', 'CATEGORY']));

    const list = await get(RESELLER_TIER_ROUTES.list);
    expect(list.statusCode).toBe(200);
    const parsed = resellerTierListResponseSchema.parse(list.json());
    expect(parsed.tiers).toHaveLength(1);
    expect(parsed.tiers[0]?.grants).toHaveLength(4);
  });

  it('registers, lists, searches, reads and updates a reseller, every response parsing with its contract', async () => {
    const tierId = await createdTier();
    const registered = await post(RESELLER_ROUTES.register, registerBody(customerA, tierId));
    expect(registered.statusCode, registered.body).toBe(201);
    const { reseller } = resellerResponseSchema.parse(registered.json());
    expect(reseller).toMatchObject({
      customerId: customerA,
      telegramUserId: '950001',
      displayName: 'نیلوفر',
      tier: { id: tierId, name: 'Gold' },
      status: 'ACTIVE',
      pricingMode: 'TIER',
      creditLimit: null,
      // The tier's, because the reseller has none of their own.
      effectiveCreditLimit: { amount: '100000', currency: 'IRT' },
    });
    const second = await post(
      RESELLER_ROUTES.register,
      registerBody(customerA2, tierId, {
        pricingMode: 'PERCENTAGE_DISCOUNT',
        discountPercentage: 35,
        creditLimit: { amount: '5000', currency: 'IRT' },
      }),
    );
    expect(second.statusCode, second.body).toBe(201);
    expect(resellerResponseSchema.parse(second.json()).reseller).toMatchObject({
      creditLimit: { amount: '5000', currency: 'IRT' },
      effectiveCreditLimit: { amount: '5000', currency: 'IRT' },
    });

    const all = resellerListResponseSchema.parse((await get(RESELLER_ROUTES.list)).json());
    expect(all.resellers.map((r) => r.customerId)).toEqual([customerA2, customerA]);
    expect(all.nextCursor).toBeNull();

    // Keyset pages: one per page, and a cursor for the rest (its second page is a regression below).
    const page1 = resellerListResponseSchema.parse(
      (await get(`${RESELLER_ROUTES.list}?limit=1`)).json(),
    );
    expect(page1.resellers.map((r) => r.customerId)).toEqual([customerA2]);
    expect(page1.nextCursor).not.toBeNull();
    // Search by Telegram id and by name.
    const byId = resellerListResponseSchema.parse(
      (await get(`${RESELLER_ROUTES.list}?search=950001`)).json(),
    );
    expect(byId.resellers.map((r) => r.customerId)).toEqual([customerA]);
    const byName = resellerListResponseSchema.parse(
      (await get(`${RESELLER_ROUTES.list}?search=behn`)).json(),
    );
    expect(byName.resellers.map((r) => r.customerId)).toEqual([customerA2]);

    const detail = await get(RESELLER_ROUTES.detail(customerA));
    expect(detail.statusCode).toBe(200);
    expect(resellerResponseSchema.parse(detail.json()).reseller.customerId).toBe(customerA);

    const suspended = await post(RESELLER_ROUTES.update(customerA), {
      idempotencyKey: key(),
      tierId,
      status: 'SUSPENDED',
      pricingMode: 'LIST_PRICE',
      discountPercentage: null,
      creditLimit: { amount: '0', currency: 'IRT' },
    });
    expect(suspended.statusCode, suspended.body).toBe(201);
    expect(resellerResponseSchema.parse(suspended.json()).reseller).toMatchObject({
      status: 'SUSPENDED',
      pricingMode: 'LIST_PRICE',
      effectiveCreditLimit: { amount: '0', currency: 'IRT' },
    });

    const active = resellerListResponseSchema.parse(
      (await get(`${RESELLER_ROUTES.list}?status=ACTIVE`)).json(),
    );
    expect(active.resellers.map((r) => r.customerId)).toEqual([customerA2]);
    const inTier = resellerListResponseSchema.parse(
      (await get(`${RESELLER_ROUTES.list}?tierId=${tierId}`)).json(),
    );
    expect(inTier.resellers).toHaveLength(2);
  });

  it('refuses malformed bodies with 400, conflicts with 409 and unknown ids with 404', async () => {
    // A percentage mode needs a percentage; a list-price mode refuses one.
    expect(
      (await post(RESELLER_TIER_ROUTES.create, tierBody({ discountPercentage: null }))).statusCode,
    ).toBe(400);
    expect(
      (await post(RESELLER_TIER_ROUTES.create, tierBody({ pricingMode: 'LIST_PRICE' }))).statusCode,
    ).toBe(400);
    expect(
      (await post(RESELLER_TIER_ROUTES.create, tierBody({ discountPercentage: 101 }))).statusCode,
    ).toBe(400);
    expect(
      (
        await post(
          RESELLER_TIER_ROUTES.create,
          tierBody({ creditLimit: { amount: '-1', currency: 'IRT' } }),
        )
      ).statusCode,
    ).toBe(400);
    expect(await tierCount()).toBe(0);

    const tierId = await createdTier();
    expect(
      (await post(RESELLER_TIER_ROUTES.create, tierBody({ name: 'gold' }))).statusCode,
      'a name taken in another case',
    ).toBe(409);
    // A grant names a purpose or an id; each grant appears once.
    expect(
      (
        await post(RESELLER_TIER_ROUTES.grants(tierId), {
          idempotencyKey: key(),
          grants: [{ kind: 'OPERATION', subject: 'TRIAL' }],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post(RESELLER_TIER_ROUTES.grants(tierId), {
          idempotencyKey: key(),
          grants: [{ kind: 'PANEL', subject: 'not-a-uuid' }],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post(RESELLER_TIER_ROUTES.grants(tierId), {
          idempotencyKey: key(),
          grants: [
            { kind: 'BOT', subject: null },
            { kind: 'BOT', subject: null },
          ],
        })
      ).statusCode,
    ).toBe(400);

    expect((await post(RESELLER_ROUTES.register, registerBody(customerA, tierId))).statusCode).toBe(
      201,
    );
    expect(
      (await post(RESELLER_ROUTES.register, registerBody(customerA, tierId))).statusCode,
      'registered twice',
    ).toBe(409);
    expect(
      (await post(RESELLER_ROUTES.register, registerBody(customerA2, api.container.ids.uuid())))
        .statusCode,
      'an unknown tier',
    ).toBe(404);
    expect((await get(RESELLER_TIER_ROUTES.detail(api.container.ids.uuid()))).statusCode).toBe(404);
    expect((await get(RESELLER_TIER_ROUTES.detail('not-a-uuid'))).statusCode).toBe(404);
    expect((await get(RESELLER_ROUTES.detail(customerA2))).statusCode).toBe(404);
  });

  it('shows tenant B nothing of tenant A’s tiers and resellers', async () => {
    const tierId = await createdTier();
    await post(RESELLER_ROUTES.register, registerBody(customerA, tierId));

    expect((await get(RESELLER_TIER_ROUTES.detail(tierId), foreignCookie)).statusCode).toBe(404);
    expect((await get(RESELLER_ROUTES.detail(customerA), foreignCookie)).statusCode).toBe(404);
    expect(
      resellerTierListResponseSchema.parse(
        (await get(RESELLER_TIER_ROUTES.list, foreignCookie)).json(),
      ).tiers,
    ).toEqual([]);
    expect(
      resellerListResponseSchema.parse((await get(RESELLER_ROUTES.list, foreignCookie)).json())
        .resellers,
    ).toEqual([]);
    expect(
      (
        await post(
          RESELLER_TIER_ROUTES.grants(tierId),
          { idempotencyKey: key(), grants: [] },
          foreignCookie,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await post(RESELLER_ROUTES.register, registerBody(customerA, tierId), foreignCookie))
        .statusCode,
      'tenant A’s customer is unknown in tenant B',
    ).toBe(404);
  });

  it('exposes a confirmed reseller order’s terms on the order pricing read', async () => {
    const tierId = await createdTier({ name: 'Gold', discountPercentage: 20 });
    await post(RESELLER_TIER_ROUTES.grants(tierId), { idempotencyKey: key(), grants: EVERYTHING });
    await post(RESELLER_ROUTES.register, registerBody(customerA, tierId));

    const drafted = await api.container.orders.createDraft(viaBot, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customerA,
      productId: await product(100_000n),
    });
    const draftRead = orderPricingResponseSchema.parse(
      (await get(ORDER_ROUTES.pricing(drafted.id))).json(),
    );
    expect(draftRead.reseller, 'nothing is recorded before confirmation').toBeNull();

    await api.container.orders.confirm(viaBot, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customerA,
      orderId: drafted.id,
    });
    const response = await get(ORDER_ROUTES.pricing(drafted.id));
    expect(response.statusCode).toBe(200);
    const pricing = orderPricingResponseSchema.parse(response.json());
    expect(pricing).toMatchObject({
      subtotalAmount: '80000',
      discountAmount: '0',
      totalAmount: '80000',
      reseller: {
        resellerCustomerId: customerA,
        tierId,
        tierName: 'Gold',
        layer: 'TIER',
        percent: 20,
        listAmount: '100000',
        costAmount: '80000',
        promotionAmount: '0',
        saleAmount: '80000',
        marginAmount: '20000',
        botInstanceId: BOT_A,
      },
    });
    // The margin is never shown as a customer discount.
    expect(pricing.adjustments).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Regressions: defects this suite found in the first implementation
  // -------------------------------------------------------------------------

  describe('a tier’s resellerCount counts its resellers (it was always zero)', () => {
    /*
     * Found by this suite in the first implementation and fixed; what follows is the
     * defect as it was, which this block now holds shut.
     *
     * `DrizzleResellerRepository.listTiers` counts with a correlated subquery inside a
     * SINGLE-TABLE select, and drizzle renders a column interpolated into a select field
     * WITHOUT its table when the query has no join. The statement it sends is
     *
     *   (SELECT count(*)::int FROM "resellers" r
     *     WHERE r.tenant_id = "tenant_id" AND r.tier_id = "id")
     *
     * so both bare names bind to the subquery's own `r` — `r.tier_id = r.id` — and the
     * count is zero for every tier however many resellers it has.
     */
    it('counts the resellers on each tier', async () => {
      const gold = await createdTier({ name: 'Gold' });
      const silver = await createdTier({ name: 'Silver' });
      for (const customerId of [customerA, customerA2]) {
        const registered = await post(RESELLER_ROUTES.register, registerBody(customerId, gold));
        expect(registered.statusCode, registered.body).toBe(201);
      }
      const tiers = resellerTierListResponseSchema.parse(
        (await get(RESELLER_TIER_ROUTES.list)).json(),
      ).tiers;
      expect(tiers.map((t) => [t.name, t.resellerCount])).toEqual([
        ['Gold', 2],
        ['Silver', 0],
      ]);
      expect(
        resellerTierResponseSchema.parse((await get(RESELLER_TIER_ROUTES.detail(gold))).json()).tier
          .resellerCount,
      ).toBe(2);
      expect(silver).not.toBe(gold);
    });
  });

  describe('the reseller list mints a cursor its own decoder accepts (it refused it)', () => {
    /*
     * Found by this suite in the first implementation and fixed; what follows is the
     * defect as it was, which this block now holds shut.
     *
     * `DrizzleResellerRepository.list` builds `next.createdAt` from
     * `Date.toISOString()` — MILLIsecond text, `…T12:34:56.789Z`. `decodeKeysetCursor`
     * accepts only PostgreSQL's own MICROsecond rendering (`\.\d{6}Z`), which every other
     * keyset repository produces with `to_char(… 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`. So the
     * `nextCursor` of page one is answered 400 `control.invalid_value`, and no list longer
     * than one page can be walked past its first page.
     */
    it('serves the second page with the cursor the first page returned', async () => {
      const tierId = await createdTier();
      for (const customerId of [customerA, customerA2]) {
        await post(RESELLER_ROUTES.register, registerBody(customerId, tierId));
      }
      const page1 = resellerListResponseSchema.parse(
        (await get(`${RESELLER_ROUTES.list}?limit=1`)).json(),
      );
      expect(page1.resellers.map((r) => r.customerId)).toEqual([customerA2]);
      expect(page1.nextCursor).not.toBeNull();

      const response = await get(
        `${RESELLER_ROUTES.list}?limit=1&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
      );
      expect(response.statusCode, response.body).toBe(200);
      const page2 = resellerListResponseSchema.parse(response.json());
      expect(page2.resellers.map((r) => r.customerId)).toEqual([customerA]);
      expect(page2.nextCursor).toBeNull();
    });
  });

  async function tierCount(): Promise<number> {
    const result = (await api.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM reseller_tiers` as never,
    )) as unknown as { rows: { n: number }[] };
    return result.rows[0]?.n ?? 0;
  }
});
