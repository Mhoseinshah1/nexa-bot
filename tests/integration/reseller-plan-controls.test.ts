import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  COMMERCE_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  money,
  settingDefinition,
  type ActorContext,
  type BotInstanceId,
  type Clock,
  type CorrelationId,
  type FeatureFlagKey,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type ResellerEntitlementDimension,
  type ResellerGrantKind,
  type SettingKey,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleCustomerNotificationRepository } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-customer-notification.repository';
import { CustomerNotificationService } from '../../apps/api/src/modules/commerce/messaging/application/customer-notification.service';
import type {
  CustomerMessage,
  CustomerSendResult,
} from '../../apps/api/src/modules/commerce/messaging/application/ports';
import { CustomerNotifier } from '../../apps/api/src/modules/commerce/messaging/application/customer-notifier';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import { DrizzleNotificationSubjectReader } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-notification-subject.reader';
import { DrizzleCustomerReminderFactsReader } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-customer-reminder-facts.reader';
import { DrizzleServiceReminderSnapshotReader } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service-reminder.repository';
import { DrizzleReportingRepository } from '../../apps/api/src/modules/commerce/reporting/infrastructure/drizzle-reporting.repository';
import { DrizzleResellerRepository } from '../../apps/api/src/modules/commerce/resellers/infrastructure/drizzle-reseller.repository';
import { ResellerMinimumService } from '../../apps/api/src/modules/commerce/resellers/application/reseller-minimum.service';
import { CachedTenantPresentationReader } from '../../apps/api/src/modules/control/templates/infrastructure/cached-tenant-presentation.reader';
import { TenantMonthlyPeriods } from '../../apps/api/src/infrastructure/time/monthly-period';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Round N, package D (`docs/round-n-reseller-audit.md`), end to end at the service boundary
 * over real PostgreSQL:
 *
 * - R1: a reseller's own entitlement override, per dimension, over the EXISTING Products,
 *   with the existing precedence (the override REPLACES the tier); the catalogue courtesy
 *   and the authoritative confirmation both judge the effective grants; the preview.
 * - R2: the monthly minimum — tier and own, the reports' own sales definition, the tenant
 *   calendar, the optional notices (at most one per reseller per month, replica-safe), the
 *   send-time re-check, and NO consequence: no ledger entry, no status, no tier change.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const viaBot: TenantContext = { ...tenantA, botInstanceId: BOT_A };

const customerActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

interface Grant {
  readonly kind: ResellerGrantKind;
  readonly subject: string | null;
}

const EVERYTHING: readonly Grant[] = [
  { kind: 'OPERATION', subject: null },
  { kind: 'PRODUCT', subject: null },
  { kind: 'PANEL', subject: null },
  { kind: 'BOT', subject: null },
];

describe('reseller plan controls and the monthly minimum (round N, package D)', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let owner: ActorContext;
  let panelA: string;
  let panelA2: string;
  let resellerOne: UserId;
  let resellerTwo: UserId;
  let n = 0;
  const key = (): string => `round-n-d-${(n += 1)}`;
  let sends: CustomerMessage[] = [];
  let outcomes: CustomerSendResult[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    sends = [];
    outcomes = [];
    products = new DrizzleProductRepository(ctx.container.database.db);
    panelA = ctx.container.ids.uuid();
    panelA2 = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE'),
             (${panelA2}, ${tenantA.tenantId}, 'Panel A2', 'sanaei', 'https://a2.example.test', 'ACTIVE')`);
    await makePanelSellable(ctx.container, tenantA, panelA);
    await makePanelSellable(ctx.container, tenantA, panelA2);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-round-n', roleKeys: ['owner'] }),
    );
    resellerOne = await customer('960001');
    resellerTwo = await customer('960002');
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function customer(telegramUserId: string): Promise<UserId> {
    const { customer: record } = await ctx.container.customers.resolveFromUpdate(
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

  async function product(price: bigint, panelId: string = panelA): Promise<ProductId> {
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: `پلن ${String(price)}`,
        description: 'یک ماهه',
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(price, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return created.id;
  }

  async function tier(grants: readonly Grant[] = EVERYTHING, name = `Tier ${n}`) {
    const created = await ctx.container.resellersAdmin.createTier(tenantA, owner, {
      idempotencyKey: key(),
      write: {
        name,
        pricingMode: 'LIST_PRICE',
        discountPercentage: null,
        creditLimit: money(0n, 'IRT'),
      },
    });
    if (grants.length > 0) {
      await ctx.container.resellersAdmin.replaceGrants(tenantA, owner, {
        idempotencyKey: key(),
        tierId: created.id,
        grants,
      });
    }
    return created.id;
  }

  const register = (customerId: UserId, tierId: string) =>
    ctx.container.resellersAdmin.register(tenantA, owner, {
      idempotencyKey: key(),
      customerId,
      write: { tierId, pricingMode: 'TIER', discountPercentage: null, creditLimit: null },
    });

  const override = (
    customerId: UserId,
    overrides: readonly { dimension: ResellerEntitlementDimension; grants: readonly Grant[] }[],
  ) =>
    ctx.container.resellersAdmin.replaceOverrides(tenantA, owner, {
      idempotencyKey: key(),
      customerId,
      overrides,
    });

  const browse = async (customerId: UserId) =>
    (await ctx.container.products.browse(viaBot, customerActor(key()), 50, customerId)).items
      .map((p) => p.id)
      .sort();

  const draft = (customerId: UserId, productId: string) =>
    ctx.container.orders.createDraft(viaBot, customerActor(key()), {
      idempotencyKey: key(),
      customerId,
      productId,
    });

  const confirm = (customerId: UserId, orderId: string) =>
    ctx.container.orders.confirm(viaBot, customerActor(key()), {
      idempotencyKey: key(),
      customerId,
      orderId,
    });

  /** A reseller buys and pays from a wallet an operator funded: a real PAID reseller sale. */
  async function sold(customerId: UserId, price: bigint) {
    await ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: key(),
      direction: 'CREDIT',
      amountMinor: price,
      currency: 'IRT',
      note: 'شارژ آزمون',
    });
    const order = await draft(customerId, await product(price));
    await confirm(customerId, order.id);
    const { payment, order: paid } = await ctx.container.payments.settleFromWallet(
      viaBot,
      customerActor(key()),
      customerId,
      { idempotencyKey: key(), orderId: order.id },
    );
    expect(paid.state).toBe('PAID');
    return { orderId: order.id, paymentId: payment.id };
  }

  async function rows<T>(query: SQL): Promise<T[]> {
    const result = await ctx.container.database.db.execute(query);
    return result.rows as T[];
  }

  const refusal = (code: string, details?: Record<string, unknown>) =>
    expect.objectContaining({
      code,
      ...(details === undefined ? {} : { details: expect.objectContaining(details) }),
    });

  // =========================================================================
  // R1 — per-reseller entitlement overrides over the existing Products
  // =========================================================================

  describe('R1: entitlement overrides', () => {
    it('narrows one reseller to named existing Products; the catalogue and the confirmation agree', async () => {
      const granted = await product(100_000n);
      const other = await product(120_000n);
      const tierId = await tier();
      await register(resellerOne, tierId);
      await register(resellerTwo, tierId);
      expect(await browse(resellerOne)).toEqual([granted, other].sort());

      await override(resellerOne, [
        { dimension: 'CATALOGUE', grants: [{ kind: 'PRODUCT', subject: granted }] },
      ]);
      // The courtesy: only the named Product, and only for this reseller.
      expect(await browse(resellerOne)).toEqual([granted]);
      expect(await browse(resellerTwo), 'the tier is untouched').toEqual([granted, other].sort());
      // The rule: a draft of the other Product is refused, naming the dimension.
      await expect(draft(resellerOne, other)).rejects.toEqual(
        refusal(COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED, { dimension: 'CATALOGUE' }),
      );
      expect((await draft(resellerOne, granted)).state).toBe('DRAFT');
    });

    it('re-decides at confirmation: a grant withdrawn after the draft refuses the sale', async () => {
      const granted = await product(100_000n);
      await register(resellerOne, await tier());
      const order = await draft(resellerOne, granted);

      await override(resellerOne, [{ dimension: 'PANEL', grants: [] }]);
      await expect(confirm(resellerOne, order.id)).rejects.toEqual(
        refusal(COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED, { dimension: 'PANEL' }),
      );
      const [row] = await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM order_reseller_terms WHERE order_id = ${order.id}`,
      );
      expect(row?.n, 'no terms written for a refused confirmation').toBe(0);

      // Removing the override restores the tier's grants: the same draft now confirms.
      await override(resellerOne, []);
      expect((await confirm(resellerOne, order.id)).state).toBe('AWAITING_PAYMENT');
    });

    it('widens a dimension the tier refuses, for that reseller only (the override REPLACES)', async () => {
      const onA2 = await product(100_000n, panelA2);
      const tierId = await tier([
        { kind: 'OPERATION', subject: null },
        { kind: 'PRODUCT', subject: null },
        { kind: 'PANEL', subject: panelA },
        { kind: 'BOT', subject: null },
      ]);
      await register(resellerOne, tierId);
      await register(resellerTwo, tierId);
      await expect(draft(resellerOne, onA2)).rejects.toEqual(
        refusal(COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED, { dimension: 'PANEL' }),
      );
      await override(resellerOne, [
        { dimension: 'PANEL', grants: [{ kind: 'PANEL', subject: panelA2 }] },
      ]);
      expect((await draft(resellerOne, onA2)).state).toBe('DRAFT');
      await expect(draft(resellerTwo, onA2), 'the tier still refuses everyone else').rejects.toEqual(
        refusal(COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED, { dimension: 'PANEL' }),
      );
      // REPLACES, never adds: the tier's panel A is no longer granted to this reseller.
      await expect(draft(resellerOne, await product(90_000n))).rejects.toEqual(
        refusal(COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED, { dimension: 'PANEL' }),
      );
    });

    it('previews tier value vs override vs effective, with the evaluator’s answer per Product', async () => {
      const granted = await product(100_000n);
      const other = await product(120_000n);
      const tierId = await tier(EVERYTHING, 'Gold');
      await register(resellerOne, tierId);
      await ctx.container.resellersAdmin.setTierMinimum(tenantA, owner, {
        idempotencyKey: key(),
        tierId,
        minimum: money(1_000_000n, 'IRT'),
      });
      const policy = await override(resellerOne, [
        { dimension: 'CATALOGUE', grants: [{ kind: 'PRODUCT', subject: granted }] },
      ]);

      const catalogue = policy.dimensions.find((d) => d.dimension === 'CATALOGUE');
      expect(catalogue).toEqual({
        dimension: 'CATALOGUE',
        source: 'RESELLER',
        tierGrants: [{ kind: 'PRODUCT', subject: null }],
        overrideGrants: [{ kind: 'PRODUCT', subject: granted }],
        effectiveGrants: [{ kind: 'PRODUCT', subject: granted }],
      });
      expect(policy.dimensions.find((d) => d.dimension === 'PANEL')).toMatchObject({
        source: 'TIER',
        overrideGrants: null,
        effectiveGrants: [{ kind: 'PANEL', subject: null }],
      });
      expect(policy.botBasis).toBe('ANY_BOT');
      const decisions = new Map(policy.products.map((p) => [p.productId, p.decision]));
      expect(decisions.get(granted)).toEqual({ allowed: true });
      expect(decisions.get(other)).toEqual({ allowed: false, dimension: 'CATALOGUE' });
      expect(policy.pricing).toEqual({
        tierMode: 'LIST_PRICE',
        tierPercent: null,
        overrideMode: 'TIER',
        overridePercent: null,
        layer: 'LIST',
        percent: null,
      });
      expect(policy.monthlyMinimum).toEqual({
        tier: money(1_000_000n, 'IRT'),
        own: null,
        effective: money(1_000_000n, 'IRT'),
        source: 'TIER',
      });
      // A read is the same answer.
      expect(await ctx.container.resellersAdmin.policy(tenantA, owner, resellerOne)).toEqual(policy);
    });

    it('audits the override with its before and after, replays a key, and refuses a foreign subject', async () => {
      const granted = await product(100_000n);
      await register(resellerOne, await tier());
      const idempotencyKey = key();
      const body = {
        idempotencyKey,
        customerId: resellerOne,
        overrides: [
          {
            dimension: 'CATALOGUE' as const,
            grants: [{ kind: 'PRODUCT' as const, subject: granted }],
          },
        ],
      };
      await ctx.container.resellersAdmin.replaceOverrides(tenantA, owner, body);
      await ctx.container.resellersAdmin.replaceOverrides(tenantA, owner, body);
      const audits = await rows<{ before: unknown; after: unknown }>(sql`
        SELECT before, after FROM audit_logs
         WHERE action = 'reseller.grants_override' AND entity_id = ${resellerOne}`);
      expect(audits, 'the replay wrote nothing').toHaveLength(1);
      expect(audits[0]).toEqual({
        before: { dimensions: [], grants: [] },
        after: { dimensions: ['CATALOGUE'], grants: [{ kind: 'PRODUCT', subject: granted }] },
      });

      const foreign = ctx.container.ids.uuid();
      await expect(
        override(resellerOne, [
          { dimension: 'CATALOGUE', grants: [{ kind: 'PRODUCT', subject: foreign }] },
        ]),
      ).rejects.toEqual(refusal(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID));
      await expect(
        override(resellerOne, [
          // A grant filed under another dimension than its own.
          { dimension: 'PANEL', grants: [{ kind: 'PRODUCT', subject: granted }] },
        ]),
      ).rejects.toEqual(refusal(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID));
    });

    it('keeps another tenant out of the override and the preview', async () => {
      await register(resellerOne, await tier());
      const ownerB = adminActorFor(
        await createAdmin(ctx.container, tenantB, { username: 'owner-b-n', roleKeys: ['owner'] }),
      );
      await expect(
        ctx.container.resellersAdmin.policy(tenantB, ownerB, resellerOne),
      ).rejects.toEqual(refusal(COMMERCE_ERROR_CODES.RESELLER_NOT_FOUND));
      await expect(
        ctx.container.resellersAdmin.replaceOverrides(tenantB, ownerB, {
          idempotencyKey: key(),
          customerId: resellerOne,
          overrides: [],
        }),
      ).rejects.toEqual(refusal(COMMERCE_ERROR_CODES.RESELLER_NOT_FOUND));
    });
  });

  // =========================================================================
  // R2 — the monthly minimum
  // =========================================================================

  describe('R2: the monthly minimum', () => {
    const setTierMinimum = (tierId: string, amount: bigint | null) =>
      ctx.container.resellersAdmin.setTierMinimum(tenantA, owner, {
        idempotencyKey: key(),
        tierId,
        minimum: amount === null ? null : money(amount, 'IRT'),
      });
    const setOwnMinimum = (customerId: UserId, amount: bigint | null) =>
      ctx.container.resellersAdmin.setMinimum(tenantA, owner, {
        idempotencyKey: key(),
        customerId,
        minimum: amount === null ? null : money(amount, 'IRT'),
      });
    const progress = (
      query: Parameters<typeof ctx.container.resellerMinimums.progress>[2] = {},
    ) => ctx.container.resellerMinimums.progress(tenantA, owner, query);

    it('tracks tier and own minimums against the reports’ own sales figure, per reseller', async () => {
      const resellerThree = await customer('960003');
      const tierId = await tier(EVERYTHING, 'Normal');
      await setTierMinimum(tierId, 100_000n);
      await register(resellerOne, tierId);
      await register(resellerTwo, tierId);
      await register(resellerThree, tierId);
      await setOwnMinimum(resellerTwo, 50_000n);
      await setOwnMinimum(resellerThree, 0n);

      await sold(resellerOne, 60_000n);
      await sold(resellerTwo, 60_000n);
      await sold(resellerThree, 10_000n);

      const report = await progress();
      const byCustomer = new Map(report.rows.map((row) => [row.customerId, row]));
      expect(byCustomer.get(resellerOne)).toMatchObject({
        minimum: money(100_000n, 'IRT'),
        source: 'TIER',
        achieved: money(60_000n, 'IRT'),
        remaining: money(40_000n, 'IRT'),
        progressBasisPoints: 6_000,
        state: 'BELOW',
      });
      expect(byCustomer.get(resellerTwo)).toMatchObject({
        minimum: money(50_000n, 'IRT'),
        source: 'RESELLER',
        remaining: money(0n, 'IRT'),
        progressBasisPoints: 12_000,
        state: 'ACHIEVED',
      });
      expect(byCustomer.get(resellerThree), 'an own zero is an explicit none').toMatchObject({
        minimum: null,
        source: 'NONE',
        achieved: money(10_000n, 'IRT'),
        state: 'NO_MINIMUM',
      });
      expect(report.counts).toEqual({ achieved: 1, below: 1, noMinimum: 1, notActive: 0 });
      expect(report.period.key).toBe('THIS_MONTH');
      expect(report.period.running).toBe(true);
      expect(report.period.end.getTime()).toBeGreaterThan(report.period.start.getTime());

      // The filters.
      expect((await progress({ filter: 'ACHIEVED' })).rows.map((r) => r.customerId)).toEqual([
        resellerTwo,
      ]);
      expect((await progress({ filter: 'BELOW' })).rows.map((r) => r.customerId)).toEqual([
        resellerOne,
      ]);
      // The previous month holds none of this month's sales.
      const previous = await progress({ period: 'PREVIOUS_MONTH' });
      expect(previous.period.end.getTime()).toBe(report.period.start.getTime());
      expect(previous.rows.every((r) => r.achieved.amountMinor === 0n)).toBe(true);

      // The SAME figure the resellers report gives: one definition of a reseller's sales.
      const reported = await ctx.container.reports.resellers(tenantA, owner, {
        range: 'THIS_MONTH',
      });
      for (const row of reported.rows) {
        const ours = byCustomer.get(row.resellerCustomerId);
        expect(row.sales).toEqual([{ currency: 'IRT', amount: String(ours?.achieved.amountMinor) }]);
      }
    });

    it('counts only sales under reseller terms, and drops a fully refunded one, like the report', async () => {
      const tierId = await tier();
      await setTierMinimum(tierId, 100_000n);
      // A purchase BEFORE registration carries no reseller terms and is not the reseller's sale.
      await sold(resellerOne, 30_000n);
      await register(resellerOne, tierId);
      const { orderId, paymentId } = await sold(resellerOne, 70_000n);
      expect(
        (await progress()).rows.find((r) => r.customerId === resellerOne)?.achieved,
      ).toEqual(money(70_000n, 'IRT'));

      await ctx.container.database.db.execute(sql`
        UPDATE provisioning_operations
           SET state = 'SUCCEEDED', completed_at = now(), claimed_by = NULL, lease_until = NULL
         WHERE tenant_id = ${tenantA.tenantId} AND order_id = ${orderId}`);
      await ctx.container.refunds.request(tenantA, owner, {
        idempotencyKey: key(),
        paymentId,
        amountMinor: 70_000n,
        reason: 'بازگشت کامل',
      });
      expect(
        (await progress()).rows.find((r) => r.customerId === resellerOne),
        'a fully refunded order is not a sale',
      ).toMatchObject({ achieved: money(0n, 'IRT'), state: 'BELOW' });
    });

    it('applies no minimum to a suspended reseller, and a tier zero is none', async () => {
      const tierId = await tier();
      await setTierMinimum(tierId, 0n);
      await register(resellerOne, tierId);
      expect((await progress()).rows[0]).toMatchObject({ state: 'NO_MINIMUM', minimum: null });
      await setTierMinimum(tierId, 100_000n);
      const current = await ctx.container.resellersAdmin.get(tenantA, owner, resellerOne);
      await ctx.container.resellersAdmin.update(tenantA, owner, {
        idempotencyKey: key(),
        customerId: resellerOne,
        write: {
          tierId: current.tierId,
          status: 'SUSPENDED',
          pricingMode: current.pricingMode,
          discountPercentage: current.discountPercentage,
          creditLimit: current.creditLimit,
        },
      });
      expect((await progress()).rows[0]).toMatchObject({ state: 'NOT_ACTIVE', remaining: null });
    });

    it('charges resellers.view AND orders.view for the progress read', async () => {
      const denied = { code: PLATFORM_ERROR_CODES.PERMISSION_DENIED };
      // Support holds orders.view but not resellers.view.
      const support = adminActorFor(
        await createAdmin(ctx.container, tenantA, { username: 'support-n', roleKeys: ['support'] }),
      );
      await expect(ctx.container.resellerMinimums.progress(tenantA, support, {})).rejects.toMatchObject(
        denied,
      );
      // Finance holds both; without orders.view the sums of order amounts are refused.
      const finance = adminActorFor(
        await createAdmin(ctx.container, tenantA, { username: 'finance-n', roleKeys: ['finance'] }),
      );
      expect((await ctx.container.resellerMinimums.progress(tenantA, finance, {})).rows).toEqual([]);
      await ctx.container.database.db.execute(sql`
        DELETE FROM role_permissions rp USING roles r
         WHERE r.id = rp.role_id AND r.tenant_id = rp.tenant_id
           AND r.key = 'finance' AND rp.permission_key = 'orders.view'`);
      await expect(ctx.container.resellerMinimums.progress(tenantA, finance, {})).rejects.toMatchObject(
        denied,
      );
      // The writes need resellers.edit, which finance does not hold.
      const tierId = await tier();
      await expect(
        ctx.container.resellersAdmin.setTierMinimum(tenantA, finance, {
          idempotencyKey: key(),
          tierId,
          minimum: money(1n, 'IRT'),
        }),
      ).rejects.toMatchObject(denied);
    });

    // -----------------------------------------------------------------------
    // The notices
    // -----------------------------------------------------------------------

    const periods = new TenantMonthlyPeriods();
    const at = (ms: number): Clock => ({ now: () => new Date(ms) });

    /** The sweep with the test's clock, flags and reminder days; everything else production. */
    function sweep(clock: Clock, flags: Partial<Record<FeatureFlagKey, boolean>>, days = 3) {
      const db = ctx.container.database.db;
      return new ResellerMinimumService({
        resellers: new DrizzleResellerRepository(db),
        sales: new DrizzleReportingRepository(db),
        periods,
        presentation: new CachedTenantPresentationReader(ctx.container.tenants, clock),
        settings: {
          valueOf: async <T>(_scope: unknown, settingKey: SettingKey) =>
            (settingKey === 'reminders.reseller_minimum_days'
              ? days
              : settingDefinition(settingKey).defaultValue) as T,
        },
        features: { isEnabled: async (_scope: unknown, flag: FeatureFlagKey) => flags[flag] ?? false },
        notifier: new CustomerNotifier({
          notifications: new DrizzleCustomerNotificationRepository(db),
          bots: { botFor: async () => BOT_A },
          ids: ctx.container.ids,
        }),
        guard: ctx.container.guard,
        scopeActivity: ctx.container.tenants,
        uow: ctx.container.uow,
        clock,
        ids: ctx.container.ids,
      }).runOnce(tenantA);
    }

    function dispatcher(clock: Clock): CustomerNotificationService {
      const db = ctx.container.database.db;
      const people = new DrizzleCustomerRepository(db);
      return new CustomerNotificationService({
        notifications: new DrizzleCustomerNotificationRepository(db),
        refundFigures: new DrizzleWalletRepository(db),
        paymentCredits: new DrizzleWalletRepository(db),
        rejectionReasons: new DrizzlePaymentRepository(db),
        reminderSnapshots: new DrizzleServiceReminderSnapshotReader(db),
        reminderFacts: new DrizzleCustomerReminderFactsReader(db),
        contacts: {
          contactFor: async (scope, customerId, tx) => {
            const found = await people.findById(scope, customerId, tx);
            if (found === null) return { kind: 'NONE' };
            return { kind: 'CONTACT', contact: { chatId: found.telegramUserId } };
          },
        },
        subjects: new DrizzleNotificationSubjectReader(db),
        messenger: {
          send: async (_scope, message) => {
            sends.push(message);
            return outcomes.shift() ?? { outcome: 'DELIVERED' };
          },
          acknowledge: async () => undefined,
          sendFile: async () => ({ outcome: 'REFUSED' }),
        },
        uow: ctx.container.uow,
        clock,
        scopeIsActive: async () => true,
        logger: { info: () => {}, error: () => {} },
      });
    }

    /** An instant inside the reminder window of the CURRENT tenant month, never before now. */
    async function inReminderWindow(days = 3): Promise<number> {
      const now = ctx.container.clock.now();
      const presentation = await new CachedTenantPresentationReader(
        ctx.container.tenants,
        ctx.container.clock,
      ).presentationFor(tenantA);
      return Math.max(now.getTime(), periods.reminderStart(now, days, presentation).getTime());
    }

    async function noticeRows() {
      return rows<{ customer_id: string; kind: string; minimum_amount: string }>(sql`
        SELECT customer_id, kind, minimum_amount::text FROM reseller_minimum_notices
         ORDER BY kind, customer_id`);
    }
    async function notificationRows() {
      return rows<{ kind: string; customer_id: string; state: string }>(sql`
        SELECT kind, customer_id, state FROM customer_notifications ORDER BY kind, customer_id`);
    }

    async function belowAndAchieved() {
      const tierId = await tier();
      await setTierMinimum(tierId, 100_000n);
      await register(resellerOne, tierId);
      await register(resellerTwo, tierId);
      await sold(resellerOne, 40_000n);
      await sold(resellerTwo, 150_000n);
      return tierId;
    }

    it('raises one reminder and one achievement per reseller per month, whatever the passes or replicas', async () => {
      await belowAndAchieved();
      const now = ctx.container.clock.now().getTime();
      const flags = { reseller_minimum_reminders: true, reseller_minimum_achieved_notices: true };

      // Before the window only the achievement is due.
      const window = await inReminderWindow();
      if (window > now) {
        expect(await sweep(at(now), flags)).toBe(1);
        expect((await noticeRows()).map((r) => r.kind)).toEqual(['ACHIEVED']);
      }

      const first = await sweep(at(window), flags);
      const again = await sweep(at(window + 60_000), flags);
      // A second replica on the same instant: the unique key is the arbiter.
      const replica = await Promise.all([sweep(at(window + 120_000), flags), sweep(at(window + 120_000), flags)]);
      expect(first + again + replica[0] + replica[1] + (window > now ? 1 : 0)).toBe(2);
      expect(await noticeRows()).toEqual([
        { customer_id: resellerTwo, kind: 'ACHIEVED', minimum_amount: '100000' },
        { customer_id: resellerOne, kind: 'REMINDER', minimum_amount: '100000' },
      ]);
      expect(await notificationRows()).toEqual([
        { kind: 'RESELLER_MINIMUM_ACHIEVED', customer_id: resellerTwo, state: 'PENDING' },
        { kind: 'RESELLER_MINIMUM_REMINDER', customer_id: resellerOne, state: 'PENDING' },
      ]);
    });

    it('sends nothing with both switches off, and no achievement by default', async () => {
      await belowAndAchieved();
      const window = await inReminderWindow();
      expect(await sweep(at(window), {})).toBe(0);
      expect(await sweep(at(window), { reseller_minimum_reminders: true })).toBe(1);
      expect((await noticeRows()).map((r) => r.kind)).toEqual(['REMINDER']);
    });

    it('creates no debt, ledger entry, status or tier change for a reseller below the minimum', async () => {
      const tierId = await belowAndAchieved();
      const ledger = async () =>
        rows<Record<string, unknown>>(sql`SELECT * FROM wallet_entries ORDER BY created_at, id`);
      const resellerRows = async () =>
        rows<Record<string, unknown>>(
          sql`SELECT customer_id, tier_id, status, credit_limit_amount FROM resellers ORDER BY customer_id`,
        );
      const ledgerBefore = await ledger();
      const resellersBefore = await resellerRows();
      const paymentsBefore = await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM payments`);

      const window = await inReminderWindow();
      await sweep(at(window), { reseller_minimum_reminders: true, reseller_minimum_achieved_notices: true });
      await dispatcher(at(window)).deliverDue(tenantA, 200);

      expect(await ledger(), 'no ledger entry — no debt, fee or debit').toEqual(ledgerBefore);
      expect(await resellerRows(), 'no demotion, suspension or tier change').toEqual(resellersBefore);
      expect(await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM payments`)).toEqual(
        paymentsBefore,
      );
      const settlement = await rows<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM wallet_entries
         WHERE reason IN ('RESELLER_SETTLEMENT', 'RESELLER_MEMBERSHIP_FEE')`);
      expect(settlement[0]?.n).toBe(0);
      expect((await ctx.container.resellersAdmin.getTier(tenantA, owner, tierId)).monthlyMinimum).toEqual(
        money(100_000n, 'IRT'),
      );
    });

    it('renders the minimum, the live sales, what remains and the days left', async () => {
      await belowAndAchieved();
      const window = await inReminderWindow();
      await sweep(at(window), { reseller_minimum_reminders: true, reseller_minimum_achieved_notices: true });
      await dispatcher(at(window)).deliverDue(tenantA, 200);

      const reminder = sends.find((s) => s.templateKey === 'bot.reseller.minimum_reminder');
      expect(reminder?.values).toEqual({
        minimum: money(100_000n, 'IRT'),
        achievedSales: money(40_000n, 'IRT'),
        remainingSales: money(60_000n, 'IRT'),
        days: expect.any(Number),
      });
      const days = reminder?.values.days as number;
      expect(days).toBeGreaterThanOrEqual(1);
      expect(days).toBeLessThanOrEqual(3);
      const achieved = sends.find((s) => s.templateKey === 'bot.reseller.minimum_achieved');
      expect(achieved?.values).toEqual({
        minimum: money(100_000n, 'IRT'),
        achievedSales: money(150_000n, 'IRT'),
      });
      expect(await notificationRows()).toEqual([
        { kind: 'RESELLER_MINIMUM_ACHIEVED', customer_id: resellerTwo, state: 'DELIVERED' },
        { kind: 'RESELLER_MINIMUM_REMINDER', customer_id: resellerOne, state: 'DELIVERED' },
      ]);
    });

    it('supersedes a waiting reminder once the reseller reaches the minimum, or it is removed', async () => {
      await belowAndAchieved();
      const window = await inReminderWindow();
      await sweep(at(window), { reseller_minimum_reminders: true });
      // The reseller reaches the minimum before the queued reminder leaves.
      await sold(resellerOne, 60_000n);
      await dispatcher(at(window)).deliverDue(tenantA, 200);
      expect(sends).toEqual([]);
      expect(await notificationRows()).toEqual([
        { kind: 'RESELLER_MINIMUM_REMINDER', customer_id: resellerOne, state: 'SUPERSEDED' },
      ]);
    });

    it('supersedes a waiting reminder whose minimum an operator changed, or whose reseller was suspended', async () => {
      await belowAndAchieved();
      const window = await inReminderWindow();
      await sweep(at(window), { reseller_minimum_reminders: true });
      await setOwnMinimum(resellerOne, 0n);
      await dispatcher(at(window)).deliverDue(tenantA, 200);
      expect(sends).toEqual([]);
      expect((await notificationRows())[0]?.state).toBe('SUPERSEDED');
    });
  });
});
