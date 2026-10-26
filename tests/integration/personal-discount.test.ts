import { readFileSync } from 'node:fs';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  COMMERCE_ERROR_CODES,
  CUSTOMER_360_ROUTES,
  EMPTY_PRODUCT_DISPLAY,
  SESSION_COOKIE_NAME,
  isNexaError,
  money,
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
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import {
  adminActorFor,
  createAdmin,
  makePanelSellable,
  migrateOnce,
  resetDatabase,
  tenantA,
  testConfig,
} from './harness';

/**
 * R10 D3 — the personal discount, end to end (owner spec; lead's decisions).
 *
 * Real PostgreSQL, the real API app (so the Web Admin route, its session and its 403 are the
 * real ones), the real order, pricing, reseller and payment services. Each case names the
 * rule it pins:
 *
 * - set from the customer's page: audited with before/after and the reason, an event when it
 *   changed, idempotent per key; `users.discount.edit` or a recorded DENIED and a 403; a
 *   stopped scope refuses inside the transaction;
 * - behind `personal_discount` (off by default): off, a stored percent changes no price;
 * - on: a purchase and a renewal are priced with it, a wallet top-up never is;
 * - the larger single discount wins, never stacked, and the decision is frozen on the quote;
 * - confirmation refuses `DISCOUNT_NO_LONGER_VALID` when the percent changed or the flag went
 *   off since the quote — never re-prices;
 * - a reseller whose personal discount wins confirms and records LIST terms.
 */

const ORIGIN = 'https://admin.example.test';
const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const viaBot: TenantContext = { ...tenantA, botInstanceId: BOT_A };
const LIST = 100_000n;

const customerActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('personal discount (R10 D3)', () => {
  let api: ApiApp;
  let products: DrizzleProductRepository;
  let owner: ActorContext;
  let operator: ActorContext;
  let ownerCookie: string;
  let operatorCookie: string;
  let panelA: string;
  let productA: ProductId;
  let customerA: UserId;
  let n = 0;
  const key = (): string => `personal-${(n += 1)}-${Date.now()}`;

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
    panelA = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(api.container, tenantA, panelA);
    owner = adminActorFor(
      await createAdmin(api.container, tenantA, {
        username: 'owner-personal',
        password: 'the-owners-password',
        roleKeys: ['owner'],
      }),
    );
    operator = adminActorFor(
      await createAdmin(api.container, tenantA, {
        username: 'operator-personal',
        password: 'the-operators-password',
        roleKeys: ['operator'],
      }),
    );
    ownerCookie = await cookieFor('owner-personal', 'the-owners-password');
    operatorCookie = await cookieFor('operator-personal', 'the-operators-password');
    productA = await product(LIST);
    customerA = await customer('962001');
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

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

  const post = (path: string, cookie: string, payload: unknown) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${path}`,
      headers: { cookie, origin: ORIGIN },
      payload,
    });

  async function customer(telegramUserId: string): Promise<UserId> {
    const { customer: record } = await api.container.customers.resolveFromUpdate(
      tenantA,
      customerActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'سارا' },
        botInstanceId: BOT_A,
      },
    );
    return record.id;
  }

  async function product(price: bigint): Promise<ProductId> {
    const created = await products.create(tenantA, {
      id: api.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن شخصی',
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

  async function setFlag(enabled: boolean): Promise<void> {
    const current = await api.container.featureFlagResolver.resolve(tenantA, 'personal_discount');
    await api.container.featureFlags.set(tenantA, owner, {
      key: 'personal_discount',
      enabled,
      expectedVersion: current.version,
      idempotencyKey: key(),
      reason: 'personal discount integration test',
    });
  }

  const setPercent = (percent: number, customerId: UserId = customerA, actor = owner) =>
    api.container.customerControls.setPersonalDiscount(tenantA, actor, {
      idempotencyKey: key(),
      customerId,
      percent,
      reason: 'مشتری وفادار',
    });

  const draft = (customerId: UserId = customerA, productId: ProductId = productA) =>
    api.container.orders.createDraft(viaBot, customerActor(key()), {
      idempotencyKey: key(),
      customerId,
      productId,
    });

  const confirm = (order: OrderRecord, customerId: UserId = customerA) =>
    api.container.orders.confirm(viaBot, customerActor(key()), {
      idempotencyKey: key(),
      customerId,
      orderId: order.id,
    });

  async function rows<T>(query: SQL): Promise<T[]> {
    return ((await api.container.database.db.execute(query as never)) as unknown as { rows: T[] })
      .rows;
  }

  const count = async (query: SQL): Promise<number> =>
    Number((await rows<{ n: number }>(query))[0]?.n ?? 0);

  async function refusalOf(promise: Promise<unknown>): Promise<{
    code: string;
    details: Record<string, unknown>;
  }> {
    try {
      await promise;
    } catch (error) {
      if (isNexaError(error)) return { code: error.code, details: error.details };
      throw error;
    }
    throw new Error('expected a refusal');
  }

  const audits = () =>
    rows<{ result: string; reason: string | null; before: unknown; after: unknown }>(
      sql`SELECT result, reason, before, after FROM audit_logs
           WHERE tenant_id = ${tenantA.tenantId} AND action = 'customer.personal_discount.set'
           ORDER BY occurred_at, id`,
    );

  const events = () =>
    rows<{ payload: unknown }>(
      sql`SELECT payload FROM outbox_messages
           WHERE event_type = 'CustomerPersonalDiscountChanged' ORDER BY created_at`,
    );

  async function automaticRule(percent: bigint): Promise<string> {
    const created = await api.container.discounts.create(tenantA, owner, {
      idempotencyKey: key(),
      write: {
        kind: 'AUTOMATIC',
        code: null,
        label: 'حراج',
        type: 'PERCENTAGE',
        value: percent,
        currency: null,
        appliesTo: ['NEW_SERVICE', 'RENEW'],
        productId: null,
        categoryId: null,
        customerId: null,
        firstPurchaseOnly: false,
        minimumSubtotal: null,
        startsAt: null,
        endsAt: null,
        totalLimit: null,
        perCustomerLimit: null,
        priority: 0,
        stackable: false,
      },
    });
    await api.container.discounts.activate(tenantA, owner, {
      idempotencyKey: key(),
      discountId: created.rule.id,
    });
    return created.rule.id;
  }

  // -------------------------------------------------------------------------
  // The control
  // -------------------------------------------------------------------------

  describe('the Web Admin control', () => {
    it('sets the percent over HTTP: audited before/after with the reason, one event, replay-safe', async () => {
      const idempotencyKey = key();
      const body = { idempotencyKey, percent: 25, reason: 'مشتری وفادار' };
      const first = await post(CUSTOMER_360_ROUTES.personalDiscount(customerA), ownerCookie, body);
      expect(first.statusCode).toBe(201);
      const answer = JSON.parse(first.body) as {
        changed: boolean;
        overview: { personalDiscount: { percent: number; setAt: string | null; enabled: boolean } };
      };
      expect(answer.changed).toBe(true);
      expect(answer.overview.personalDiscount.percent).toBe(25);
      expect(answer.overview.personalDiscount.setAt).not.toBeNull();
      // The flag ships OFF, and the page is told so.
      expect(answer.overview.personalDiscount.enabled).toBe(false);

      // The same key again: the first answer, nothing written twice.
      const replay = await post(CUSTOMER_360_ROUTES.personalDiscount(customerA), ownerCookie, body);
      expect(replay.statusCode).toBe(201);
      expect((JSON.parse(replay.body) as { changed: boolean }).changed).toBe(true);

      // The same percent under a new key: audited as unchanged, no event.
      expect((await setPercent(25)).changed).toBe(false);
      // Removed with 0.
      expect((await setPercent(0)).changed).toBe(true);

      expect(await audits()).toEqual([
        {
          result: 'SUCCESS',
          reason: 'مشتری وفادار',
          before: { percent: 0 },
          after: { percent: 25, changed: true },
        },
        {
          result: 'SUCCESS',
          reason: 'مشتری وفادار',
          before: { percent: 25 },
          after: { percent: 25, changed: false },
        },
        {
          result: 'SUCCESS',
          reason: 'مشتری وفادار',
          before: { percent: 25 },
          after: { percent: 0, changed: true },
        },
      ]);
      expect((await events()).map((e) => e.payload)).toEqual([
        { percentBefore: 0, percentAfter: 25 },
        { percentBefore: 25, percentAfter: 0 },
      ]);
    });

    it('refuses a percent outside 0..100 or not whole, and a missing reason', async () => {
      for (const percent of [-1, 101, 12.5]) {
        const response = await post(CUSTOMER_360_ROUTES.personalDiscount(customerA), ownerCookie, {
          idempotencyKey: key(),
          percent,
          reason: 'x',
        });
        expect(response.statusCode, String(percent)).toBe(400);
      }
      expect(
        (
          await refusalOf(
            api.container.customerControls.setPersonalDiscount(tenantA, owner, {
              idempotencyKey: key(),
              customerId: customerA,
              percent: 101,
              reason: 'x',
            }),
          )
        ).code,
      ).toBe(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID);
      expect(
        (
          await refusalOf(
            api.container.customerControls.setPersonalDiscount(tenantA, owner, {
              idempotencyKey: key(),
              customerId: customerA,
              percent: 10,
              reason: '   ',
            }),
          )
        ).code,
      ).toBe(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID);
      expect(await audits()).toEqual([]);
    });

    it('without users.discount.edit: 403, a DENIED audit row, and nothing changed', async () => {
      const response = await post(CUSTOMER_360_ROUTES.personalDiscount(customerA), operatorCookie, {
        idempotencyKey: key(),
        percent: 40,
        reason: 'x',
      });
      expect(response.statusCode).toBe(403);
      expect((await refusalOf(setPercent(40, customerA, operator))).code).toBe(
        'platform.permission_denied',
      );
      expect((await audits()).map((a) => a.result)).toEqual(['DENIED', 'DENIED']);
      const overview = await api.container.customerControls.overview(tenantA, owner, customerA);
      expect(overview.personalDiscount.percent).toBe(0);
      expect(await events()).toEqual([]);
    });

    it('a stopped scope refuses the change inside the transaction', async () => {
      await api.container.database.db.execute(
        sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
      );
      expect((await refusalOf(setPercent(30))).code).toBe(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
      );
      const stored = await rows<{ percent: number }>(
        sql`SELECT personal_discount_percent AS percent FROM customers WHERE id = ${customerA}`,
      );
      expect(stored).toEqual([{ percent: 0 }]);
    });

    it('migration 0283 backfills the key into existing owner roles only, idempotently', async () => {
      await api.container.database.db.execute(
        sql`DELETE FROM role_permissions WHERE permission_key = 'users.discount.edit'`,
      );
      const migration = readFileSync('apps/api/drizzle/0283_personal_discount_grant.sql', 'utf8');
      const backfill = migration.slice(migration.indexOf('INSERT INTO "role_permissions"'));
      await api.container.database.db.execute(sql.raw(backfill));
      await api.container.database.db.execute(sql.raw(backfill));
      const granted = await rows<{ role_key: string }>(
        sql`SELECT r.key AS role_key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
             WHERE rp.permission_key = 'users.discount.edit' AND r.tenant_id = ${tenantA.tenantId}`,
      );
      expect(granted).toEqual([{ role_key: 'owner' }]);
    });
  });

  // -------------------------------------------------------------------------
  // Pricing
  // -------------------------------------------------------------------------

  describe('pricing', () => {
    it('with the flag OFF (the default), a stored percent changes no price', async () => {
      await setPercent(30);
      const order = await draft();
      expect(order.totals.total.amountMinor).toBe(LIST);
      expect(order.totals.quote.personalDiscount).toBeUndefined();
      expect(order.totals.quote.trace.map((s) => s.step)).toEqual(['BASE_PRICE']);
    });

    it('with the flag on: a purchase is priced with it, confirms, and the quote holds the decision', async () => {
      await setFlag(true);
      await setPercent(30);
      const order = await draft();
      expect(order.totals.total.amountMinor).toBe(70_000n);
      expect(order.totals.discount.amountMinor).toBe(30_000n);
      expect(order.totals.quote.trace.map((s) => s.step)).toEqual([
        'BASE_PRICE',
        'PERSONAL_DISCOUNT',
      ]);
      expect(order.totals.quote.personalDiscount).toEqual({
        percent: 30,
        outcome: 'APPLIED',
        competingTotal: money(LIST, 'IRT'),
        rule: 'LARGER_SINGLE_WINS',
      });
      const confirmed = await confirm(order);
      expect(confirmed.state).toBe('AWAITING_PAYMENT');
      expect(confirmed.totals.total.amountMinor).toBe(70_000n);
      // Frozen on the stored row, as the jsonb document says it.
      const stored = await rows<{ decision: unknown }>(
        sql`SELECT quote->'personalDiscount' AS decision FROM orders WHERE id = ${order.id}`,
      );
      expect(stored[0]?.decision).toEqual({
        percent: 30,
        outcome: 'APPLIED',
        competingTotal: { amountMinor: '100000', currency: 'IRT' },
        rule: 'LARGER_SINGLE_WINS',
      });
    });

    it('a renewal is priced with it; a wallet top-up never is', async () => {
      await setFlag(true);
      await setPercent(20);
      /*
       * A service of the customer's to renew, on a MARZBAN panel: 3X-UI declares no RENEW,
       * so a renewal on the sellable fixture panel is refused before pricing is asked
       * (the `automatic-refund` suite's fixture, for the same reason).
       */
      const renewable = await api.container.panels.create(tenantA, owner, {
        name: 'Panel Renew',
        providerType: 'marzban',
        baseUrl: 'https://renew.example.test',
        credentials: { username: 'nexa', password: 'not-a-real-password' },
        activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
        idempotencyKey: key(),
      });
      const panelRenew = renewable.view.panel.id;
      const renewProduct = (
        await products.create(tenantA, {
          id: api.container.ids.uuid() as ProductId,
          draft: {
            title: 'پلن تمدید',
            description: 'یک ماهه',
            audience: 'EVERYONE',
            sortOrder: 10,
            panelId: panelRenew as PanelId,
            categoryId: SEED_IDS.categoryA as ProductCategoryId,
            specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
            price: money(LIST, 'IRT'),
            display: EMPTY_PRODUCT_DISPLAY,
          },
          now: api.container.clock.now(),
        })
      ).id;
      await products.setStatus(
        tenantA,
        renewProduct,
        'INACTIVE',
        'ACTIVE',
        api.container.clock.now(),
      );
      const bought = await draft(customerA, renewProduct);
      const serviceId = api.container.ids.uuid();
      await api.container.database.db.execute(sql`
        INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id,
                              provider_username, subscription_ref, provider_client_id,
                              traffic_limit_bytes, state, provisioned_at, expires_at)
        VALUES (${serviceId}, ${tenantA.tenantId}, ${customerA}, ${bought.id}, ${panelRenew},
                ${renewProduct}, 'personal_renew', ${'a'.repeat(32)}, ${api.container.ids.uuid()},
                0, 'ACTIVE', now(), now() + interval '30 days')`);
      const { order: renewal } = await api.container.commercialActions.draft(
        viaBot,
        customerActor(key()),
        customerA,
        { serviceId, kind: 'RENEW', idempotencyKey: key() },
      );
      expect(renewal.purpose).toBe('RENEW');
      expect(renewal.totals.total.amountMinor).toBe(80_000n);
      expect(renewal.totals.quote.personalDiscount?.outcome).toBe('APPLIED');

      const { payment } = await api.container.payments.requestWalletTopupTyped(
        viaBot,
        customerActor(key()),
        customerA,
        { idempotencyKey: key(), amount: money(100_000n, 'IRT'), provider: 'MANUAL_TRANSFER' },
      );
      expect(payment.amount.amountMinor).toBe(100_000n);
    });

    it('the larger single discount wins and they are never stacked', async () => {
      await setFlag(true);
      await setPercent(30);
      const ruleId = await automaticRule(40n);
      const ordinaryWins = await draft();
      // 40 % automatic (60 000) beats 30 % personal (70 000) — and is not 30 % on top.
      expect(ordinaryWins.totals.total.amountMinor).toBe(60_000n);
      expect(ordinaryWins.totals.quote.trace.map((s) => [s.step, s.ruleId])).toEqual([
        ['BASE_PRICE', null],
        ['PROMOTIONAL_DISCOUNT', ruleId],
      ]);
      expect(ordinaryWins.totals.quote.personalDiscount).toMatchObject({
        outcome: 'NOT_LARGER',
        competingTotal: money(70_000n, 'IRT'),
      });
      // It confirms and redeems the rule like any discounted order.
      await confirm(ordinaryWins);
      expect(
        await count(sql`SELECT count(*)::int AS n FROM discount_redemptions
                         WHERE order_id = ${ordinaryWins.id}`),
      ).toBe(1);

      // At 50 %, the personal price wins alone: no promotional step, no redemption.
      const other = await customer('962002');
      await setPercent(50, other);
      const personalWins = await draft(other);
      expect(personalWins.totals.total.amountMinor).toBe(50_000n);
      expect(personalWins.totals.quote.trace.map((s) => s.step)).toEqual([
        'BASE_PRICE',
        'PERSONAL_DISCOUNT',
      ]);
      await confirm(personalWins, other);
      expect(
        await count(sql`SELECT count(*)::int AS n FROM discount_redemptions
                         WHERE order_id = ${personalWins.id}`),
      ).toBe(0);
    });

    it('confirmation refuses DISCOUNT_NO_LONGER_VALID when the percent changed since the quote', async () => {
      await setFlag(true);
      await setPercent(30);
      const order = await draft();
      await setPercent(10);
      const refusal = await refusalOf(confirm(order));
      expect(refusal.code).toBe(COMMERCE_ERROR_CODES.DISCOUNT_NO_LONGER_VALID);
      expect(refusal.details).toMatchObject({ discount: 'PERSONAL', reason: 'PERCENT_CHANGED' });
      const state = await rows<{ state: string; total: string }>(
        sql`SELECT state, total_amount::text AS total FROM orders WHERE id = ${order.id}`,
      );
      // Never re-priced: still the draft at the quoted figure.
      expect(state).toEqual([{ state: 'DRAFT', total: '70000' }]);
    });

    it('confirmation refuses DISCOUNT_NO_LONGER_VALID when the flag went off since the quote', async () => {
      await setFlag(true);
      await setPercent(30);
      const order = await draft();
      await setFlag(false);
      const refusal = await refusalOf(confirm(order));
      expect(refusal.code).toBe(COMMERCE_ERROR_CODES.DISCOUNT_NO_LONGER_VALID);
      expect(refusal.details).toMatchObject({ reason: 'FEATURE_OFF' });
    });

    it('a reseller whose personal discount wins confirms and records LIST terms', async () => {
      await setFlag(true);
      const tier = await api.container.resellersAdmin.createTier(tenantA, owner, {
        idempotencyKey: key(),
        write: {
          name: 'Silver',
          pricingMode: 'PERCENTAGE_DISCOUNT',
          discountPercentage: 20,
          creditLimit: money(0n, 'IRT'),
        },
      });
      await api.container.resellersAdmin.replaceGrants(tenantA, owner, {
        idempotencyKey: key(),
        tierId: tier.id,
        grants: [
          { kind: 'OPERATION', subject: null },
          { kind: 'PRODUCT', subject: null },
          { kind: 'PANEL', subject: null },
          { kind: 'BOT', subject: null },
        ],
      });
      await api.container.resellersAdmin.register(tenantA, owner, {
        idempotencyKey: key(),
        customerId: customerA,
        write: {
          tierId: tier.id,
          pricingMode: 'TIER',
          discountPercentage: null,
          creditLimit: null,
        },
      });
      // 20 % reseller price is 80 000; a 35 % personal discount is 65 000 and wins.
      await setPercent(35);
      const order = await draft();
      expect(order.totals.total.amountMinor).toBe(65_000n);
      expect(order.totals.quote.trace.map((s) => s.step)).toEqual([
        'BASE_PRICE',
        'PERSONAL_DISCOUNT',
      ]);
      expect(order.totals.quote.personalDiscount?.competingTotal.amountMinor).toBe(80_000n);
      const confirmed = await confirm(order);
      expect(confirmed.state).toBe('AWAITING_PAYMENT');
      const terms = await rows<Record<string, unknown>>(
        sql`SELECT layer, percent, list_amount::text AS list, cost_amount::text AS cost,
                   promotion_amount::text AS promotion, sale_amount::text AS sale,
                   margin_amount::text AS margin, fixed_price
              FROM order_reseller_terms WHERE order_id = ${order.id}`,
      );
      // The personal discount is the promotion; no margin is recorded as a discount.
      expect(terms).toEqual([
        {
          layer: 'LIST',
          percent: null,
          list: '100000',
          cost: '100000',
          promotion: '35000',
          sale: '65000',
          margin: '0',
          fixed_price: false,
        },
      ]);

      // And with a personal discount that loses, the reseller price stands, as before.
      await setPercent(10);
      const resellerPriced = await draft();
      expect(resellerPriced.totals.total.amountMinor).toBe(80_000n);
      expect(resellerPriced.totals.quote.trace.map((s) => s.step)).toEqual([
        'BASE_PRICE',
        'TIER_PRICE',
      ]);
      await confirm(resellerPriced);
    });
  });
});
