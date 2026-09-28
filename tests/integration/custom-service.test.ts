import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  customServiceVolumeBytes,
  money,
  parseCustomServiceVolume,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { CustomServiceRuleInput } from '../../apps/api/src/modules/commerce/custom-service/application/custom-service-admin.service';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import { DrizzleReceiptReviewFactsReader } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-receipt-review-facts.reader';
import { CUSTOM_SERVICE_RULES_LOCK_CLASS } from '../../apps/api/src/modules/commerce/custom-service/infrastructure/drizzle-custom-service.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  tenantA,
  tenantB,
  validatePanelConnection,
  type TestContext,
} from './harness';

/**
 * Package D — the custom service, end to end (`docs/package-d-custom-service-audit.md`).
 *
 * Every rule of the brief that a database can hold to: the rules and their overlap check,
 * the specificity order, the unavailable request, the frozen terms, the honoured-or-refused
 * confirmation, the discount and cashback pipeline, the reseller tier, tenant isolation,
 * a replayed payment, provisioning on a real-socket Marzban fake, and the absence of any
 * product behind any of it.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const customerActor = (label: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: `telegram-update:${label}`,
  surface: 'TELEGRAM',
  correlationId: label as CorrelationId,
});

const refusalOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; kind?: string; details?: Record<string, unknown> };
  }
  throw new Error('expected a refusal');
};

const units = (gb: string): bigint => {
  const parsed = parseCustomServiceVolume(gb);
  if (parsed === null) throw new Error(`not a volume: ${gb}`);
  return parsed;
};

const VOLUME_RULE: CustomServiceRuleInput = {
  dimension: 'VOLUME',
  label: null,
  minUnits: units('1'),
  maxUnits: units('100'),
  unitPriceMinor: 20_000n,
  customerId: null,
  resellerTierId: null,
  panelId: null,
  enabled: true,
};

const TIME_RULE: CustomServiceRuleInput = {
  dimension: 'TIME',
  label: null,
  minUnits: 1n,
  maxUnits: 365n,
  unitPriceMinor: 1_500n,
  customerId: null,
  resellerTierId: null,
  panelId: null,
  enabled: true,
};

interface Fixture {
  ctx: TestContext;
  owner: ActorContext;
  key: () => string;
}

function helpers(f: Fixture) {
  const { ctx } = f;
  const db = () => ctx.container.database.db;

  async function rows<T>(query: SQL): Promise<T[]> {
    return ((await db().execute(query as never)) as unknown as { rows: T[] }).rows;
  }

  async function setFlag(key: string, enabled: boolean, scope: TenantContext = tenantA) {
    const before = (await ctx.container.featureFlags.list(scope, f.owner)).find(
      (flag) => flag.key === key,
    );
    if (before === undefined) throw new Error(`no ${key} flag`);
    await ctx.container.featureFlags.set(scope, f.owner, {
      idempotencyKey: f.key(),
      key,
      enabled,
      expectedVersion: before.version,
      confirmKey: key,
      reason: 'custom-service suite',
    });
  }

  async function setSetting(settingKey: string, value: unknown) {
    const before = await ctx.container.settingsService.get(tenantA, f.owner, settingKey);
    await ctx.container.settingsService.set(tenantA, f.owner, {
      idempotencyKey: f.key(),
      key: settingKey,
      value,
      expectedVersion: before.version,
    });
  }

  const rule = (input: Partial<CustomServiceRuleInput>, scope: TenantContext = tenantA) =>
    ctx.container.customServiceAdmin.createRule(scope, f.owner, {
      idempotencyKey: f.key(),
      rule: { ...VOLUME_RULE, ...input },
    });

  const timeRule = (input: Partial<CustomServiceRuleInput> = {}) =>
    rule({ ...TIME_RULE, ...input });

  const location = (panelId: string, label = '🇩🇪 آلمان', enabled = true) =>
    ctx.container.customServiceAdmin.saveLocation(tenantA, f.owner, {
      idempotencyKey: f.key(),
      panelId,
      label,
      enabled,
    });

  const register = async (telegramUserId: string, startPayload?: string): Promise<UserId> =>
    (
      await ctx.container.customers.resolveFromUpdate(tenantA, customerActor(f.key()), {
        idempotencyKey: f.key(),
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'نگار' },
        botInstanceId: BOT_A,
        ...(startPayload === undefined ? {} : { startPayload }),
      })
    ).customer.id;

  const draft = (customerId: UserId, panelId: string, gb: string, days: number) =>
    ctx.container.orders.createCustomDraft(tenantA, customerActor(f.key()), {
      idempotencyKey: f.key(),
      customerId,
      panelId,
      volumeUnits: units(gb),
      durationDays: days,
    });

  const confirm = (order: OrderRecord) =>
    ctx.container.orders.confirm(tenantA, customerActor(f.key()), {
      idempotencyKey: f.key(),
      customerId: order.customerId,
      orderId: order.id,
    });

  async function pay(order: OrderRecord, payKey = f.key()) {
    await ctx.container.wallet.adjust(tenantA, f.owner, order.customerId, {
      idempotencyKey: f.key(),
      direction: 'CREDIT',
      amountMinor: order.totals.total.amountMinor,
      currency: 'IRT',
      note: 'fixture',
    });
    return ctx.container.payments.settleFromWallet(
      tenantA,
      customerActor(payKey),
      order.customerId,
      {
        idempotencyKey: payKey,
        orderId: order.id,
      },
    );
  }

  const terms = async (orderId: string) =>
    (
      await rows<Record<string, unknown>>(
        sql`SELECT * FROM order_custom_service_terms WHERE order_id = ${orderId}`,
      )
    )[0];

  return {
    rows,
    setFlag,
    setSetting,
    rule,
    timeRule,
    location,
    register,
    draft,
    confirm,
    pay,
    terms,
  };
}

describe('Package D — the custom service', () => {
  const f = {} as Fixture;
  let n = 0;
  f.key = () => `custom-${(n += 1)}-${randomUUID()}`;
  let h: ReturnType<typeof helpers>;
  let panelA: string;
  let customer: UserId;

  // Telegram's `getMe`, which a referral invite asks for the bot's current name.
  let getMe: Server;

  beforeAll(async () => {
    getMe = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { id: 7001, username: 'acme_store_bot' } }));
      });
    });
    await new Promise<void>((resolve) => getMe.listen(0, '127.0.0.1', resolve));
    const address = getMe.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    f.ctx = await createTestContext({
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
    h = helpers(f);
  }, 120_000);

  afterAll(async () => {
    await f.ctx?.close();
    getMe?.closeAllConnections();
    await new Promise<void>((resolve) => (getMe === undefined ? resolve() : getMe.close(() => resolve())));
  });

  beforeEach(async () => {
    await f.ctx.reset();
    const db = f.ctx.container.database.db;
    panelA = f.ctx.container.ids.uuid();
    await db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'DE-internal-1', 'marzban', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(f.ctx.container, tenantA, panelA);
    f.owner = adminActorFor(
      await createAdmin(f.ctx.container, tenantA, {
        username: 'owner-custom',
        roleKeys: ['owner'],
      }),
    );
    customer = await h.register('940001');
  });

  /** Flag on, the panel offered, and one VOLUME and one TIME rule for ordinary customers. */
  async function offer(): Promise<void> {
    await h.setFlag('custom_service', true);
    await h.location(panelA);
    await h.rule({});
    await h.timeRule();
  }

  // -------------------------------------------------------------------------
  // D2 — the rules
  // -------------------------------------------------------------------------

  describe('the operator’s rules (D2)', () => {
    it('refuses an overlapping enabled range at the same specificity, and names the other rule', async () => {
      const first = await h.rule({ minUnits: units('1'), maxUnits: units('10') });
      const refusal = await refusalOf(h.rule({ minUnits: units('10'), maxUnits: units('20') }));
      expect(refusal.code).toBe('commerce.custom_service_rule_overlap');
      expect(refusal.details).toEqual({ otherRuleId: first.id });
    });

    it('accepts adjacent ranges, other levels, other panels, the other dimension and a disabled draft', async () => {
      await h.rule({ minUnits: units('1'), maxUnits: units('10') });
      await h.rule({ minUnits: units('10.01'), maxUnits: units('20') });
      await h.rule({ customerId: customer, minUnits: units('1'), maxUnits: units('10') });
      await h.rule({ panelId: panelA, minUnits: units('1'), maxUnits: units('10') });
      await h.timeRule({ minUnits: 1n, maxUnits: 10n });
      await h.rule({ minUnits: units('5'), maxUnits: units('6'), enabled: false });
      const all = await f.ctx.container.customServiceAdmin.listRules(tenantA, f.owner);
      expect(all).toHaveLength(6);
    });

    it('refuses to ENABLE a disabled rule that overlaps an enabled one', async () => {
      await h.rule({ minUnits: units('1'), maxUnits: units('10') });
      const draftRule = await h.rule({
        minUnits: units('5'),
        maxUnits: units('6'),
        enabled: false,
      });
      const refusal = await refusalOf(
        f.ctx.container.customServiceAdmin.updateRule(tenantA, f.owner, {
          idempotencyKey: f.key(),
          ruleId: draftRule.id,
          rule: { ...VOLUME_RULE, minUnits: units('5'), maxUnits: units('6'), enabled: true },
        }),
      );
      expect(refusal.code).toBe('commerce.custom_service_rule_overlap');
    });

    it('lets a rule keep its own range on an edit', async () => {
      const created = await h.rule({ minUnits: units('1'), maxUnits: units('10') });
      const edited = await f.ctx.container.customServiceAdmin.updateRule(tenantA, f.owner, {
        idempotencyKey: f.key(),
        ruleId: created.id,
        rule: {
          ...VOLUME_RULE,
          minUnits: units('1'),
          maxUnits: units('10'),
          unitPriceMinor: 30_000n,
        },
      });
      expect(edited.unitPrice).toEqual(money(30_000n, 'IRT'));
    });

    it('serialises two concurrent overlapping creates: exactly one wins', async () => {
      /*
       * The rules' write lock is held from outside until BOTH creates are proven waiting
       * on it in `pg_locks`, then released together. Each then reads the rules under the
       * lock: with it exclusive, the second reads the first's committed row; with it
       * shared, both would read an empty table and both insert.
       */
      const db = f.ctx.container.database.db;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      let held!: () => void;
      const holding = new Promise<void>((resolve) => (held = resolve));
      const holder = db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${CUSTOM_SERVICE_RULES_LOCK_CLASS}, hashtext(${String(tenantA.tenantId)}))`,
        );
        held();
        await gate;
      });
      await holding;
      const racing = Promise.allSettled([
        h.rule({ minUnits: units('1'), maxUnits: units('10') }),
        h.rule({ minUnits: units('5'), maxUnits: units('15') }),
      ]);
      const deadline = Date.now() + 5_000;
      for (;;) {
        const [waiting] = await h.rows<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype = 'advisory'`,
        );
        if ((waiting?.n ?? 0) >= 2) break;
        if (Date.now() > deadline) throw new Error('the two creates never waited on the lock');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      open();
      await holder;
      const results = await racing;
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect((rejected.reason as { code: string }).code).toBe(
        'commerce.custom_service_rule_overlap',
      );
    });

    it('prices a rule in the sales currency, never one the client names', async () => {
      const created = await h.rule({});
      expect(created.unitPrice.currency).toBe('IRT');
    });

    it('refuses a rule naming another tenant’s panel, and a customer and a tier together', async () => {
      const panelB = f.ctx.container.ids.uuid();
      await f.ctx.container.database.db.execute(sql`
        INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
        VALUES (${panelB}, ${tenantB.tenantId}, 'B', 'marzban', 'https://b.example.test', 'ACTIVE')`);
      expect((await refusalOf(h.rule({ panelId: panelB }))).code).toBe(
        'commerce.custom_service_rule_invalid',
      );
      expect(
        (await refusalOf(h.rule({ customerId: customer, resellerTierId: randomUUID() }))).code,
      ).toBe('commerce.custom_service_rule_invalid');
    });

    it('charges catalog.pricing.edit to write and catalog.view to read', async () => {
      const support = adminActorFor(
        await createAdmin(f.ctx.container, tenantA, {
          username: 'support-cs',
          roleKeys: ['support'],
        }),
      );
      const denied = await refusalOf(
        f.ctx.container.customServiceAdmin.createRule(tenantA, support, {
          idempotencyKey: f.key(),
          rule: VOLUME_RULE,
        }),
      );
      expect(denied.kind).toBe('PERMISSION_DENIED');
    });

    it('keeps each tenant’s rules and locations its own', async () => {
      await h.rule({});
      await h.location(panelA);
      const ownerB = adminActorFor(
        await createAdmin(f.ctx.container, tenantB, {
          username: 'owner-b-cs',
          roleKeys: ['owner'],
        }),
      );
      expect(await f.ctx.container.customServiceAdmin.listRules(tenantB, ownerB)).toEqual([]);
      expect(await f.ctx.container.customServiceAdmin.listLocations(tenantB, ownerB)).toEqual([]);
      // A location on another tenant's panel is refused as unknown.
      const refusal = await refusalOf(
        f.ctx.container.customServiceAdmin.saveLocation(tenantB, ownerB, {
          idempotencyKey: f.key(),
          panelId: panelA,
          label: 'x',
          enabled: true,
        }),
      );
      expect(refusal.code).toBe('commerce.custom_service_rule_invalid');
    });
  });

  // -------------------------------------------------------------------------
  // D1, D3, D4, D6 — the draft
  // -------------------------------------------------------------------------

  describe('the draft', () => {
    it('refuses while the feature is off (D1)', async () => {
      await h.location(panelA);
      await h.rule({});
      await h.timeRule();
      expect((await refusalOf(h.draft(customer, panelA, '10', 30))).code).toBe(
        'commerce.custom_service_disabled',
      );
    });

    it('prices volume × per-GB plus days × per-day, names no product, and freezes the terms (D4, D6)', async () => {
      await offer();
      const order = await h.draft(customer, panelA, '10.25', 30);
      expect(order.purpose).toBe('CUSTOM_SERVICE');
      expect(order.line.productId).toBeNull();
      expect(order.line.panelId).toBe(panelA);
      expect(order.line.title).toBe('🇩🇪 آلمان');
      expect(order.line.specification).toEqual({
        durationDays: 30,
        trafficBytes: customServiceVolumeBytes(units('10.25')),
        deviceLimit: null,
      });
      // 10.25 × 20,000 + 30 × 1,500
      expect(order.totals.subtotal).toEqual(money(205_000n + 45_000n, 'IRT'));
      expect(order.totals.total).toEqual(money(250_000n, 'IRT'));
      expect(order.totals.quote.trace.map((step) => step.step)).toEqual([
        'CUSTOM_SERVICE_FORMULA',
        'CUSTOM_SERVICE_FORMULA',
      ]);

      const frozen = await h.terms(order.id);
      expect(frozen).toMatchObject({
        panel_id: panelA,
        location_label: '🇩🇪 آلمان',
        volume_units: 1025n,
        duration_days: 30,
        volume_rule_level: 'TIER_ALL_PANELS',
        time_rule_level: 'TIER_ALL_PANELS',
        price_per_gb_amount: 20000n,
        volume_amount: 205000n,
        price_per_day_amount: 1500n,
        time_amount: 45000n,
        base_amount: 250000n,
        currency: 'IRT',
      });
      // No product was made for it, and none exists.
      const [products] = await h.rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM products`);
      expect(products?.n).toBe(0);
    });

    it('is honoured at each specificity level, most specific first (D3)', async () => {
      await h.setFlag('custom_service', true);
      await h.location(panelA);
      await h.timeRule();
      await h.rule({ unitPriceMinor: 4n }); // ordinary, all panels
      await h.rule({ panelId: panelA, unitPriceMinor: 3n }); // ordinary, this panel
      await h.rule({ customerId: customer, unitPriceMinor: 2n }); // customer, all panels
      await h.rule({ customerId: customer, panelId: panelA, unitPriceMinor: 1n });
      const order = await h.draft(customer, panelA, '100', 1);
      expect((await h.terms(order.id))?.volume_rule_level).toBe('CUSTOMER_PANEL');
      expect((await h.terms(order.id))?.price_per_gb_amount).toBe(1n);

      const someoneElse = await h.register('940002');
      const theirs = await h.draft(someoneElse, panelA, '100', 1);
      expect((await h.terms(theirs.id))?.volume_rule_level).toBe('TIER_PANEL');
      expect((await h.terms(theirs.id))?.price_per_gb_amount).toBe(3n);
    });

    it('is unavailable with no VOLUME rule or no TIME rule, and when outside every range', async () => {
      await h.setFlag('custom_service', true);
      await h.location(panelA);
      await h.rule({});
      const noTime = await refusalOf(h.draft(customer, panelA, '10', 30));
      expect(noTime.code).toBe('commerce.custom_service_unavailable');
      expect(noTime.details).toEqual({ reason: 'NO_TIME_RULE' });
      await h.timeRule();
      const tooMuch = await refusalOf(h.draft(customer, panelA, '100.01', 30));
      expect(tooMuch.details).toEqual({ reason: 'NO_VOLUME_RULE' });
      const tooLong = await refusalOf(h.draft(customer, panelA, '10', 366));
      expect(tooLong.details).toEqual({ reason: 'NO_TIME_RULE' });
      // The bounds themselves are inside.
      await h.draft(customer, panelA, '100', 365);
      await h.draft(customer, panelA, '1', 1);
    });

    it('is unavailable on a location that is not offered, and on a panel that cannot sell', async () => {
      await h.setFlag('custom_service', true);
      await h.rule({});
      await h.timeRule();
      expect((await refusalOf(h.draft(customer, panelA, '10', 30))).details).toEqual({
        reason: 'LOCATION_NOT_OFFERED',
      });
      await h.location(panelA, 'آلمان', false);
      expect((await refusalOf(h.draft(customer, panelA, '10', 30))).details).toEqual({
        reason: 'LOCATION_NOT_OFFERED',
      });
      await h.location(panelA, 'آلمان', true);
      await f.ctx.container.database.db.execute(
        sql`UPDATE panels SET status = 'DISABLED' WHERE id = ${panelA}`,
      );
      expect((await refusalOf(h.draft(customer, panelA, '10', 30))).details).toEqual({
        reason: 'PANEL_NOT_ELIGIBLE',
      });
    });

    it('prices an ACTIVE reseller by their tier’s rules, with no reseller layer on top', async () => {
      await h.setFlag('custom_service', true);
      await h.location(panelA);
      await h.timeRule();
      await h.rule({}); // ordinary customers: 20,000 per GB
      const tier = await f.ctx.container.resellersAdmin.createTier(tenantA, f.owner, {
        idempotencyKey: f.key(),
        write: {
          name: 'Gold',
          pricingMode: 'PERCENTAGE_DISCOUNT',
          discountPercentage: 50,
          creditLimit: money(0n, 'IRT'),
        },
      });
      await f.ctx.container.resellersAdmin.register(tenantA, f.owner, {
        idempotencyKey: f.key(),
        customerId: customer,
        write: {
          tierId: tier.id,
          pricingMode: 'TIER',
          discountPercentage: null,
          creditLimit: null,
        },
      });
      // No tier rule yet: the ordinary customers' rule does not price a reseller.
      expect((await refusalOf(h.draft(customer, panelA, '10', 1))).details).toEqual({
        reason: 'NO_VOLUME_RULE',
      });
      await h.rule({ resellerTierId: tier.id, unitPriceMinor: 10_000n });
      await h.timeRule({ resellerTierId: tier.id, unitPriceMinor: 1_000n });
      const order = await h.draft(customer, panelA, '10', 1);
      // 10 × 10,000 + 1 × 1,000 — and NOT halved again by the tier's 50 percent.
      expect(order.totals.total).toEqual(money(101_000n, 'IRT'));
      expect(order.totals.quote.trace.every((s) => s.step === 'CUSTOM_SERVICE_FORMULA')).toBe(true);
      await h.confirm(order);
      const [written] = await h.rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM order_reseller_terms WHERE order_id = ${order.id}`,
      );
      expect(written?.n).toBe(0);
    });

    it('never lets another tenant’s customer buy on this tenant’s location', async () => {
      await offer();
      const b = await f.ctx.container.customers.resolveFromUpdate(tenantB, customerActor(f.key()), {
        idempotencyKey: f.key(),
        telegramUserId: '940099',
        from: { id: 940099, first_name: 'ب' },
        botInstanceId: SEED_IDS.botB1 as BotInstanceId,
      });
      const ownerB = adminActorFor(
        await createAdmin(f.ctx.container, tenantB, {
          username: 'owner-b2-cs',
          roleKeys: ['owner'],
        }),
      );
      const before = (await f.ctx.container.featureFlags.list(tenantB, ownerB)).find(
        (flag) => flag.key === 'custom_service',
      );
      await f.ctx.container.featureFlags.set(tenantB, ownerB, {
        idempotencyKey: f.key(),
        key: 'custom_service',
        enabled: true,
        expectedVersion: before?.version ?? null,
        confirmKey: 'custom_service',
        reason: 'isolation',
      });
      const refusal = await refusalOf(
        f.ctx.container.orders.createCustomDraft(tenantB, customerActor(f.key()), {
          idempotencyKey: f.key(),
          customerId: b.customer.id,
          panelId: panelA,
          volumeUnits: units('10'),
          durationDays: 30,
        }),
      );
      expect(refusal.details).toEqual({ reason: 'LOCATION_NOT_OFFERED' });
    });
  });

  // -------------------------------------------------------------------------
  // D6 — history stays true; confirmation honours or refuses
  // -------------------------------------------------------------------------

  describe('the frozen terms and the confirmation', () => {
    it('keeps a draft’s terms byte for byte when its rule is edited and then deleted', async () => {
      await offer();
      const order = await h.draft(customer, panelA, '10', 30);
      const before = await h.terms(order.id);
      const [volumeRule] = (
        await f.ctx.container.customServiceAdmin.listRules(tenantA, f.owner)
      ).filter((r) => r.dimension === 'VOLUME');
      await f.ctx.container.customServiceAdmin.updateRule(tenantA, f.owner, {
        idempotencyKey: f.key(),
        ruleId: volumeRule!.id,
        rule: { ...VOLUME_RULE, unitPriceMinor: 99_999n },
      });
      await f.ctx.container.customServiceAdmin.deleteRule(tenantA, f.owner, {
        idempotencyKey: f.key(),
        ruleId: volumeRule!.id,
      });
      expect(await h.terms(order.id)).toEqual(before);
    });

    it('refuses to UPDATE or DELETE a terms row, in the database', async () => {
      await offer();
      const order = await h.draft(customer, panelA, '10', 30);
      const db = f.ctx.container.database.db;
      await expect(
        db.execute(
          sql`UPDATE order_custom_service_terms SET location_label = 'x' WHERE order_id = ${order.id}`,
        ),
      ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/frozen/) } });
      await expect(
        db.execute(sql`DELETE FROM order_custom_service_terms WHERE order_id = ${order.id}`),
      ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/frozen/) } });
    });

    it('refuses a terms row whose arithmetic does not add up, in the database', async () => {
      await offer();
      const order = await h.draft(customer, panelA, '10', 30);
      const other = await h.draft(customer, panelA, '10', 30);
      const db = f.ctx.container.database.db;
      await expect(
        db.execute(sql`
          INSERT INTO order_custom_service_terms
            (tenant_id, order_id, panel_id, location_label, volume_units, traffic_bytes,
             duration_days, volume_rule_id, volume_rule_level, price_per_gb_amount, volume_amount,
             time_rule_id, time_rule_level, price_per_day_amount, time_amount, base_amount, currency)
          SELECT tenant_id, ${order.id}::uuid, panel_id, location_label, volume_units, traffic_bytes,
                 duration_days, volume_rule_id, volume_rule_level, price_per_gb_amount, volume_amount + 1,
                 time_rule_id, time_rule_level, price_per_day_amount, time_amount, base_amount + 1, currency
            FROM order_custom_service_terms WHERE order_id = ${other.id}`),
      ).rejects.toThrow();
    });

    it('confirms at the quoted price, taking a capacity slot and a username', async () => {
      await offer();
      const order = await h.draft(customer, panelA, '10', 30);
      const confirmed = await h.confirm(order);
      expect(confirmed.state).toBe('AWAITING_PAYMENT');
      expect(confirmed.totals.total).toEqual(order.totals.total);
      const [slot] = await h.rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM panel_capacity_reservations WHERE order_id = ${order.id}`,
      );
      expect(slot?.n).toBe(1);
      const [name] = await h.rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM service_username_reservations WHERE order_id = ${order.id}`,
      );
      expect(name?.n).toBe(1);
    });

    it('refuses a confirmation whose rule was re-priced since the quote, and never re-prices it', async () => {
      await offer();
      const order = await h.draft(customer, panelA, '10', 30);
      const [volumeRule] = (
        await f.ctx.container.customServiceAdmin.listRules(tenantA, f.owner)
      ).filter((r) => r.dimension === 'VOLUME');
      await f.ctx.container.customServiceAdmin.updateRule(tenantA, f.owner, {
        idempotencyKey: f.key(),
        ruleId: volumeRule!.id,
        rule: { ...VOLUME_RULE, unitPriceMinor: 25_000n },
      });
      const refusal = await refusalOf(h.confirm(order));
      expect(refusal.code).toBe('commerce.custom_service_terms_changed');
      const [row] = await h.rows<{ state: string; total_amount: bigint }>(
        sql`SELECT state, total_amount FROM orders WHERE id = ${order.id}`,
      );
      expect(row).toEqual({
        state: 'DRAFT',
        total_amount: order.totals.total.amountMinor,
      });
    });

    it('refuses a confirmation when a more specific rule now applies, or the location was withdrawn', async () => {
      await offer();
      const first = await h.draft(customer, panelA, '10', 30);
      await h.rule({ customerId: customer, unitPriceMinor: 20_000n }); // same price, other rule
      expect((await refusalOf(h.confirm(first))).code).toBe(
        'commerce.custom_service_terms_changed',
      );

      const second = await h.draft(customer, panelA, '10', 30);
      await h.location(panelA, 'آلمان', false);
      expect((await refusalOf(h.confirm(second))).code).toBe(
        'commerce.custom_service_terms_changed',
      );
    });

    it('refuses a confirmation while the feature is off', async () => {
      await offer();
      const order = await h.draft(customer, panelA, '10', 30);
      await h.setFlag('custom_service', false);
      expect((await refusalOf(h.confirm(order))).code).toBe('commerce.custom_service_disabled');
    });

    it('settles once for a replayed wallet payment', async () => {
      await offer();
      const order = await h.confirm(await h.draft(customer, panelA, '10', 30));
      const payKey = f.key();
      await h.pay(order, payKey);
      await f.ctx.container.payments.settleFromWallet(tenantA, customerActor(payKey), customer, {
        idempotencyKey: payKey,
        orderId: order.id,
      });
      const [debits] = await h.rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM wallet_entries WHERE order_id = ${order.id} AND direction = 'DEBIT'`,
      );
      expect(debits?.n).toBe(1);
      const [services] = await h.rows<{ n: number; product: string | null }>(
        sql`SELECT count(*)::int AS n, max(product_id::text) AS product FROM services WHERE order_id = ${order.id}`,
      );
      expect(services).toEqual({ n: 1, product: null });
    });
  });

  // -------------------------------------------------------------------------
  // D4 — the commercial pipeline
  // -------------------------------------------------------------------------

  describe('the commercial pipeline (D4)', () => {
    const DISCOUNT = {
      kind: 'CODE' as const,
      code: 'CUSTOM10',
      label: 'ده درصد',
      type: 'PERCENTAGE' as const,
      value: 10n,
      currency: null,
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
    };

    async function code(appliesTo: readonly ('NEW_SERVICE' | 'CUSTOM_SERVICE')[]) {
      const created = await f.ctx.container.discounts.create(tenantA, f.owner, {
        idempotencyKey: f.key(),
        write: { ...DISCOUNT, appliesTo },
      });
      await f.ctx.container.discounts.activate(tenantA, f.owner, {
        idempotencyKey: f.key(),
        discountId: created.rule.id,
      });
    }

    it('applies a code that names CUSTOM_SERVICE, re-quoting from the frozen terms', async () => {
      await offer();
      await code(['CUSTOM_SERVICE']);
      const order = await h.draft(customer, panelA, '10', 30);
      const coded = await f.ctx.container.orders.applyDiscountCode(
        tenantA,
        customerActor(f.key()),
        {
          idempotencyKey: f.key(),
          customerId: customer,
          orderId: order.id,
          code: 'CUSTOM10',
        },
      );
      expect(coded.totals.subtotal).toEqual(money(245_000n, 'IRT'));
      expect(coded.totals.discount).toEqual(money(24_500n, 'IRT'));
      expect(coded.totals.total).toEqual(money(220_500n, 'IRT'));
      // Re-quoted from the draft's own terms: the two formula steps, never a list price.
      expect(coded.totals.quote.trace.slice(0, 2).map((step) => step.step)).toEqual([
        'CUSTOM_SERVICE_FORMULA',
        'CUSTOM_SERVICE_FORMULA',
      ]);
      const confirmed = await h.confirm(coded);
      expect(confirmed.totals.total).toEqual(money(220_500n, 'IRT'));
      const [redeemed] = await h.rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM discount_redemptions WHERE order_id = ${order.id}`,
      );
      expect(redeemed?.n).toBe(1);
    });

    it('refuses a code that names only NEW_SERVICE', async () => {
      await offer();
      await code(['NEW_SERVICE']);
      const order = await h.draft(customer, panelA, '10', 30);
      const refusal = await refusalOf(
        f.ctx.container.orders.applyDiscountCode(tenantA, customerActor(f.key()), {
          idempotencyKey: f.key(),
          customerId: customer,
          orderId: order.id,
          code: 'CUSTOM10',
        }),
      );
      expect(refusal.code).toBe('commerce.discount_code_rejected');
    });

    it('promises cashback at confirmation and earns it at delivery', async () => {
      await offer();
      const rule = await f.ctx.container.cashbackRules.create(tenantA, f.owner, {
        idempotencyKey: f.key(),
        write: {
          label: 'کش‌بک',
          percent: 10,
          appliesTo: ['CUSTOM_SERVICE'],
          productId: null,
          categoryId: null,
          startsAt: null,
          endsAt: null,
        },
      });
      await f.ctx.container.cashbackRules.activate(tenantA, f.owner, {
        idempotencyKey: f.key(),
        ruleId: rule.id,
      });
      const order = await h.confirm(await h.draft(customer, panelA, '10', 30));
      await h.pay(order);
      await f.ctx.container.database.db.execute(sql`
        UPDATE provisioning_operations
           SET state = 'SUCCEEDED', completed_at = now(), claimed_by = NULL, lease_until = NULL
         WHERE order_id = ${order.id}`);
      await f.ctx.container.cashback.settleDue(tenantA, 50);
      const [promise] = await h.rows<{ state: string; earned_amount: bigint }>(
        sql`SELECT state, earned_amount FROM order_cashback WHERE order_id = ${order.id}`,
      );
      expect(promise).toEqual({ state: 'EARNED', earned_amount: 24_500n });
    });

    it('promises the referrer a commission and pays it at delivery', async () => {
      await h.setSetting('referral.commission_percent', 10);
      await h.setFlag('referrals', true);
      await offer();
      const referrer = await h.register('940010');
      const invited = await f.ctx.container.referrals.invite(tenantA, customerActor(f.key()), {
        idempotencyKey: f.key(),
        customerId: referrer,
        botInstanceId: BOT_A,
      });
      if (invited.outcome !== 'READY') throw new Error(invited.outcome);
      const referee = await h.register('940011', `ref-${invited.code}`);
      const order = await h.confirm(await h.draft(referee, panelA, '10', 30));
      await h.pay(order);
      await f.ctx.container.database.db.execute(sql`
        UPDATE provisioning_operations
           SET state = 'SUCCEEDED', completed_at = now(), claimed_by = NULL, lease_until = NULL
         WHERE order_id = ${order.id}`);
      expect(await f.ctx.container.referralCommissions.settleDue(tenantA, 50)).toBe(1);
      const [commission] = await h.rows<{ state: string; amount: bigint }>(
        sql`SELECT state, amount FROM order_referral_commissions WHERE order_id = ${order.id}`,
      );
      expect(commission).toEqual({ state: 'EARNED', amount: 24_500n });
    });

    it('refuses to renew or extend a custom service (OQ-PKG-D-01)', async () => {
      await offer();
      const order = await h.confirm(await h.draft(customer, panelA, '10', 30));
      await h.pay(order);
      const [service] = await h.rows<{ id: string }>(
        sql`SELECT id FROM services WHERE order_id = ${order.id}`,
      );
      await f.ctx.container.database.db.execute(
        sql`UPDATE services SET state = 'ACTIVE', provisioned_at = now() WHERE id = ${service!.id}`,
      );
      const refusal = await refusalOf(
        f.ctx.container.commercialActions.draft(tenantA, customerActor(f.key()), customer, {
          serviceId: service!.id,
          kind: 'RENEW',
          idempotencyKey: f.key(),
        }),
      );
      expect(refusal.code).toBe('commerce.custom_service_not_extendable');
      // And no button is offered for it in the first place.
      const record = await new DrizzleServiceRepository(f.ctx.container.database.db).findById(
        tenantA,
        service!.id,
      );
      expect(
        await f.ctx.container.commercialActions.availableFor(
          tenantA,
          customerActor(f.key()),
          record!,
        ),
      ).toEqual([]);
    });

    it('counts a live custom order as a purchase, so the customer is no longer a first-time buyer', async () => {
      await offer();
      const products = new DrizzleProductRepository(f.ctx.container.database.db);
      const now = f.ctx.container.clock.now();
      const product = await products.create(tenantA, {
        id: f.ctx.container.ids.uuid() as ProductId,
        draft: {
          title: 'پلن پایه',
          description: 'یک ماهه',
          audience: 'EVERYONE',
          sortOrder: 10,
          panelId: panelA as PanelId,
          categoryId: SEED_IDS.categoryA as ProductCategoryId,
          specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
          price: money(100_000n, 'IRT'),
          display: EMPTY_PRODUCT_DISPLAY,
        },
        now,
      });
      await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', now);
      const created = await f.ctx.container.discounts.create(tenantA, f.owner, {
        idempotencyKey: f.key(),
        write: {
          ...DISCOUNT,
          kind: 'AUTOMATIC',
          code: null,
          firstPurchaseOnly: true,
          appliesTo: ['NEW_SERVICE'],
        },
      });
      await f.ctx.container.discounts.activate(tenantA, f.owner, {
        idempotencyKey: f.key(),
        discountId: created.rule.id,
      });
      const productDraft = () =>
        f.ctx.container.orders.createDraft(tenantA, customerActor(f.key()), {
          idempotencyKey: f.key(),
          customerId: customer,
          productId: product.id,
        });
      // Before any purchase, the first-purchase rule applies.
      expect((await productDraft()).totals.discount).toEqual(money(10_000n, 'IRT'));
      await h.confirm(await h.draft(customer, panelA, '10', 30));
      // A custom service awaiting payment is a purchase: the rule no longer applies.
      expect((await productDraft()).totals.discount).toEqual(money(0n, 'IRT'));
    });

    it('lets a paid custom service be the source of a refund request', async () => {
      await offer();
      const order = await h.confirm(await h.draft(customer, panelA, '10', 30));
      await h.pay(order);
      const [row] = await h.rows<{ id: string }>(
        sql`SELECT id FROM services WHERE order_id = ${order.id}`,
      );
      await f.ctx.container.database.db.execute(
        sql`UPDATE services SET state = 'ACTIVE', provisioned_at = now() WHERE id = ${row!.id}`,
      );
      const service = await new DrizzleServiceRepository(f.ctx.container.database.db).findById(
        tenantA,
        row!.id,
      );
      const eligibility = await f.ctx.container.serviceRefundRequests.eligibilityOf(
        tenantA,
        service!,
        { checkFlag: false },
      );
      expect(eligibility.eligible).toBe(true);
    });

    it('names the reserved username on the operator’s receipt card for a custom order', async () => {
      await offer();
      const order = await h.confirm(await h.draft(customer, panelA, '10', 30));
      const [held] = await h.rows<{ username: string }>(
        sql`SELECT username FROM service_username_reservations WHERE order_id = ${order.id}`,
      );
      const facts = await new DrizzleReceiptReviewFactsReader(
        f.ctx.container.database.db,
      ).factsFor(tenantA, order.id);
      expect(facts.purpose).toBe('CUSTOM_SERVICE');
      expect(facts.serviceUsername).toBe(held!.username);
      expect(facts.productTitle).toBe('🇩🇪 آلمان');
    });
  });

  // -------------------------------------------------------------------------
  // D5 — the Telegram flow's windows
  // -------------------------------------------------------------------------

  describe('the typed figures (D5)', () => {
    it('reads the volume, keeps the window open on a bad figure, carries the volume to the days window and drafts', async () => {
      await offer();
      const service = f.ctx.container.customServiceFlow;
      const actor = customerActor(f.key());
      const begun = await service.begin(tenantA, actor, {
        idempotencyKey: f.key(),
        botInstanceId: BOT_A,
        customerId: customer,
        panelId: panelA,
      });
      expect(begun).toEqual({
        outcome: 'ASK_VOLUME',
        location: { panelId: panelA, label: '🇩🇪 آلمان' },
      });

      const read = async (text: string) => {
        const result = await f.ctx.container.customerCaptures.readText(tenantA, actor, {
          idempotencyKey: f.key(),
          botInstanceId: BOT_A,
          customerId: customer,
          text,
        });
        if (result.outcome !== 'READ') throw new Error(result.outcome);
        return result.capture;
      };

      let capture = await read('10.255');
      expect(
        await service.recordVolume(tenantA, actor, {
          capture,
          text: '10.255',
          botInstanceId: BOT_A,
        }),
      ).toEqual({
        outcome: 'INVALID',
      });
      capture = await read('۱۰٫۵'); // the same window, still open
      expect(capture.purpose).toBe('CUSTOM_SERVICE_VOLUME');
      expect(
        await service.recordVolume(tenantA, actor, { capture, text: '۱۰٫۵', botInstanceId: BOT_A }),
      ).toEqual({ outcome: 'ASK_DAYS', volumeBytes: customServiceVolumeBytes(1_050n) });

      capture = await read('سی');
      expect(capture.purpose).toBe('CUSTOM_SERVICE_DAYS');
      expect(capture.customVolumeUnits).toBe(1_050n);
      expect(await service.recordDays(tenantA, actor, { capture, text: 'سی' })).toEqual({
        outcome: 'INVALID',
      });
      capture = await read('30');
      const drafted = await service.recordDays(tenantA, actor, { capture, text: '30' });
      expect(drafted.outcome).toBe('DRAFTED');
      if (drafted.outcome !== 'DRAFTED') return;
      expect(drafted.order.line.specification.durationDays).toBe(30);
      expect(drafted.order.line.specification.trafficBytes).toBe(customServiceVolumeBytes(1_050n));
      // The days window was closed by the draft's own transaction.
      const next = await f.ctx.container.customerCaptures.readText(tenantA, actor, {
        idempotencyKey: f.key(),
        botInstanceId: BOT_A,
        customerId: customer,
        text: '31',
      });
      expect(next.outcome).toBe('NO_WINDOW');
    });

    it('refuses a volume no rule prices before asking for the days', async () => {
      await offer();
      const service = f.ctx.container.customServiceFlow;
      const actor = customerActor(f.key());
      await service.begin(tenantA, actor, {
        idempotencyKey: f.key(),
        botInstanceId: BOT_A,
        customerId: customer,
        panelId: panelA,
      });
      const read = await f.ctx.container.customerCaptures.readText(tenantA, actor, {
        idempotencyKey: f.key(),
        botInstanceId: BOT_A,
        customerId: customer,
        text: '500',
      });
      if (read.outcome !== 'READ') throw new Error(read.outcome);
      expect(
        await service.recordVolume(tenantA, actor, {
          capture: read.capture,
          text: '500',
          botInstanceId: BOT_A,
        }),
      ).toEqual({ outcome: 'UNAVAILABLE' });
    });

    it('offers only locations whose panel can sell and that price this customer', async () => {
      await offer();
      const service = f.ctx.container.customServiceFlow;
      expect(await service.offeredLocations(tenantA, customerActor(f.key()), customer)).toEqual([
        { panelId: panelA, label: '🇩🇪 آلمان' },
      ]);
      await h.setFlag('custom_service', false);
      expect(await service.offeredLocations(tenantA, customerActor(f.key()), customer)).toEqual([]);
    });
  });
});

describe('Package D — a custom service is provisioned like a purchase (D7)', () => {
  let ctx: TestContext;
  let panel: FakeMarzban;
  let services: DrizzleServiceRepository;
  let owner: ActorContext;
  let panelId: string;
  let customerId: UserId;
  let n = 0;
  const key = () => `custom-provision-${(n += 1)}`;

  beforeAll(async () => {
    ctx = await createTestContext({ PANEL_HTTP_ALLOW_LOOPBACK: 'true' });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  afterEach(async () => {
    await panel?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    services = new DrizzleServiceRepository(ctx.container.database.db);
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-cs-p', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban custom',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-custom-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);
    customerId = (
      await ctx.container.customers.resolveFromUpdate(tenantA, customerActor('r'), {
        idempotencyKey: 'resolve-custom-p',
        telegramUserId: '940500',
        from: { id: 940500, first_name: 'سینا' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
  });

  it('asks the panel for exactly the typed GB and days, and records a service with no product', async () => {
    const fixture: Fixture = { ctx, owner, key };
    const h = helpers(fixture);
    await h.setFlag('custom_service', true);
    await h.location(panelId, '🇳🇱 هلند');
    await h.rule({});
    await h.timeRule();

    const order = await h.confirm(await h.draft(customerId, panelId, '10.25', 45));
    await h.pay(order);
    await ctx.container.provisionerLoop.tick();

    const service = await services.findByOrderId(tenantA, order.id);
    expect(service?.state).toBe('ACTIVE');
    expect(service?.productId).toBeNull();
    expect(service?.trafficLimitBytes).toBe(11_005_853_696n);
    const [account] = [...panel.users.values()];
    expect(account?.dataLimit).toBe(11_005_853_696);
    // 45 days from the create, as the order bought.
    const expiresAt = service?.expiresAt?.getTime() ?? 0;
    const now = ctx.container.clock.now().getTime();
    expect(Math.round((expiresAt - now) / 86_400_000)).toBe(45);
  });
});
