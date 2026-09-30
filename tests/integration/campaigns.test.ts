import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIENCE_ERROR_CODES,
  EMPTY_PRODUCT_DISPLAY,
  errors,
  isNexaError,
  money,
  systemJobActor,
  type ActorContext,
  type BotInstanceId,
  type Clock,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { BulkOperationProcessor } from '../../apps/api/src/modules/commerce/bulk-operations/application/bulk-operation-processor';
import { DrizzleBulkOperationRepository } from '../../apps/api/src/modules/commerce/bulk-operations/infrastructure/drizzle-bulk-operation.repository';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import { CustomerNotifier } from '../../apps/api/src/modules/commerce/messaging/application/customer-notifier';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import type {
  CampaignActionConfig,
  CampaignCashbackTerms,
  CampaignDiscountTerms,
} from '../../apps/api/src/modules/commerce/campaigns/application/ports';
import { CampaignService } from '../../apps/api/src/modules/commerce/campaigns/application/campaign.service';
import { CampaignScheduleLoop } from '../../apps/api/src/modules/commerce/campaigns/application/campaign-schedule-loop';
import { DrizzleCampaignRepository } from '../../apps/api/src/modules/commerce/campaigns/infrastructure/drizzle-campaign.repository';
import { IntlCampaignCalendar } from '../../apps/api/src/modules/commerce/campaigns/infrastructure/intl-campaign-calendar';
import { DrizzleDiscountRepository } from '../../apps/api/src/modules/commerce/pricing/infrastructure/drizzle-discount.repository';
import { DrizzleCashbackRuleRepository } from '../../apps/api/src/modules/commerce/pricing/infrastructure/drizzle-cashback.repository';
import { CachedTenantPresentationReader } from '../../apps/api/src/modules/control/templates/infrastructure/cached-tenant-presentation.reader';
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
 * Campaigns (`docs/round-n-campaigns-audit.md`), through the service an operator and the
 * worker use, against PostgreSQL.
 *
 * The clock is the test's, so "the start has passed" and "the end has passed" are decided
 * here rather than by waiting; the pricing engine the orders go through keeps the real
 * clock, which is why the windows below straddle real time where an order is priced.
 */

class TestClock implements Clock {
  private offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const customerActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

const TWENTY_PERCENT: CampaignDiscountTerms = {
  kind: 'AUTOMATIC',
  code: null,
  type: 'PERCENTAGE',
  value: 20n,
  currency: null,
  appliesTo: ['NEW_SERVICE'],
  productId: null,
  categoryId: null,
  firstPurchaseOnly: false,
  minimumSubtotal: null,
  totalLimit: null,
  perCustomerLimit: null,
  priority: 0,
  stackable: false,
};

const TEN_PERCENT_BACK: CampaignCashbackTerms = {
  percent: 10,
  appliesTo: ['NEW_SERVICE'],
  productId: null,
  categoryId: null,
};

describe('campaigns', () => {
  let ctx: TestContext;
  let clock: TestClock;
  let repository: DrizzleCampaignRepository;
  let service: CampaignService;
  let loop: CampaignScheduleLoop;
  let owner: ActorContext;
  let calendar: IntlCampaignCalendar;
  let products: DrizzleProductRepository;
  let panelA: string;
  let customerA: UserId;
  let n = 0;
  const key = (): string => `campaign-key-${(n += 1)}`;

  /** The service's dependencies: the container's own, with the test's clock. */
  const deps = (): ConstructorParameters<typeof CampaignService>[0] => ({
    campaigns: repository,
    discounts: new DrizzleDiscountRepository(ctx.container.database.db),
    cashbackRules: new DrizzleCashbackRuleRepository(ctx.container.database.db),
    discountAdmin: ctx.container.discounts,
    cashbackAdmin: ctx.container.cashbackRules,
    calendar: calendar,
    // The SHARED engine, the one Broadcast and the mass actions use: no stand-in.
    audience: ctx.container.audience,
    broadcasts: ctx.container.broadcasts,
    massActions: ctx.container.bulkOperations,
    guard: ctx.container.guard,
    uow: ctx.container.uow,
    audit: ctx.container.audit,
    opsLog: ctx.container.opsLogWriter,
    sessions: ctx.container.sessions,
    idempotency: ctx.container.idempotency,
    scopeActivity: ctx.container.tenants,
    clock,
    ids: ctx.container.ids,
  });

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    const c = ctx.container;
    clock = new TestClock();
    repository = new DrizzleCampaignRepository(c.database.db);
    calendar = new IntlCampaignCalendar(new CachedTenantPresentationReader(c.tenants, clock));
    service = new CampaignService(deps());
    loop = new CampaignScheduleLoop(service, repository, {
      scope: () => tenantA,
      intervalMs: 60_000,
      now: () => clock.now(),
      ids: c.ids,
      logger: { info: () => undefined, error: () => undefined },
    });
    owner = adminActorFor(
      await createAdmin(c, tenantA, { username: 'owner-campaigns', roleKeys: ['owner'] }),
    );
    products = new DrizzleProductRepository(c.database.db);
    panelA = c.ids.uuid();
    await c.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(c, tenantA, panelA);
    const { customer } = await c.customers.resolveFromUpdate(tenantA, customerActor('resolve'), {
      idempotencyKey: 'resolve-campaign-customer',
      telegramUserId: '930001',
      from: { id: 930001, first_name: 'زهرا' },
      botInstanceId: BOT_A,
    });
    customerA = customer.id;
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function product(price: bigint): Promise<ProductId> {
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
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
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return created.id;
  }

  /** A window in the tenant's own calendar, `fromMs`..`toMs` away from now. */
  async function window(fromMs: number, toMs: number) {
    const presentation = await calendar.presentationFor(tenantA);
    const start = calendar.localOf(new Date(clock.now().getTime() + fromMs), presentation);
    const end = calendar.localOf(new Date(clock.now().getTime() + toMs), presentation);
    return { startDate: start.date, startTime: start.time, endDate: end.date, endTime: end.time };
  }

  async function draftCampaign(
    actions: readonly CampaignActionConfig[],
    options: { fromMs?: number; toMs?: number; actor?: ActorContext } = {},
  ): Promise<string> {
    const detail = await service.createDraft(tenantA, options.actor ?? owner, {
      idempotencyKey: key(),
      draft: {
        name: 'جشنواره پاییز',
        description: 'فقط برای آزمون',
        ...(await window(options.fromMs ?? -HOUR, options.toMs ?? DAY)),
        audience: { version: 1 },
        actions,
      },
    });
    return detail.campaign.id;
  }

  /** Confirms what the preview showed; `tamper` changes one part of the binding. */
  async function schedule(
    id: string,
    actor: ActorContext = owner,
    tamper: { recipients?: number; fingerprint?: string } = {},
  ) {
    const { audience } = await service.preview(tenantA, actor, id);
    return service.schedule(tenantA, actor, {
      idempotencyKey: key(),
      campaignId: id,
      expectedDefinitionHash: audience.definitionHash,
      expectedRecipients: tamper.recipients ?? audience.customers,
      expectedFingerprint: tamper.fingerprint ?? audience.fingerprint,
    });
  }

  const orderDraft = async (price = 100_000n) =>
    ctx.container.orders.createDraft(tenantA, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customerA,
      productId: await product(price),
    });

  const confirm = (order: OrderRecord) =>
    ctx.container.orders.confirm(tenantA, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customerA,
      orderId: order.id,
    });

  async function payFromWallet(order: OrderRecord): Promise<void> {
    await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: key(),
      direction: 'CREDIT',
      amountMinor: order.totals.total.amountMinor,
      currency: 'IRT',
      note: 'موجودی آزمون',
    });
    await ctx.container.payments.settleFromWallet(tenantA, customerActor(key()), customerA, {
      idempotencyKey: key(),
      orderId: order.id,
    });
  }

  const deliver = (orderId: string) =>
    ctx.container.database.db.execute(sql`
      UPDATE provisioning_operations
         SET state = 'SUCCEEDED', completed_at = now(), claimed_by = NULL, lease_until = NULL
       WHERE order_id = ${orderId}`);

  async function refusal(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      if (isNexaError(error)) return error.code;
      throw error;
    }
    throw new Error('expected a refusal');
  }

  async function rows<T>(query: SQL): Promise<T[]> {
    return ((await ctx.container.database.db.execute(query as never)) as unknown as { rows: T[] })
      .rows;
  }

  async function count(query: SQL): Promise<number> {
    return (await rows<{ n: number }>(query))[0]?.n ?? 0;
  }

  const stateOf = async (id: string): Promise<string | undefined> =>
    (await rows<{ state: string }>(sql`SELECT state FROM campaigns WHERE id = ${id}`))[0]?.state;

  /** A SCHEDULED campaign written directly, for the worker's edges alone. */
  async function scheduledRow(startsAt: Date, endsAt: Date, tenant = tenantA): Promise<string> {
    const id = ctx.container.ids.uuid();
    const now = clock.now();
    await ctx.container.database.db.execute(sql`
      INSERT INTO campaigns (id, tenant_id, name, state, starts_at, ends_at, audience,
                             audience_hash, audience_frozen_at, audience_confirmed_count,
                             audience_fingerprint, scheduled_at)
      VALUES (${id}, ${tenant.tenantId}, 'بهار', 'SCHEDULED', ${startsAt}, ${endsAt},
              '{}'::jsonb, ${'0'.repeat(64)}, ${now}, 0, ${'0'.repeat(32)}, ${now})`);
    return id;
  }

  describe('the worker lane', () => {
    it('does not start a campaign before its start, then starts it exactly once', async () => {
      const id = await scheduledRow(
        new Date(clock.now().getTime() + HOUR),
        new Date(clock.now().getTime() + DAY),
      );
      expect(await loop.runOnce(tenantA)).toEqual({ started: 0, completed: 0 });
      expect(await stateOf(id)).toBe('SCHEDULED');

      clock.advance(HOUR + 1);
      // Two replicas on the same tick: the conditional UPDATE decides, once.
      const [first, second] = await Promise.all([loop.runOnce(tenantA), loop.runOnce(tenantA)]);
      expect(first.started + second.started).toBe(1);
      expect(await loop.runOnce(tenantA), 'and a later tick moves nothing').toEqual({
        started: 0,
        completed: 0,
      });
      expect(await stateOf(id)).toBe('ACTIVE');
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'campaign.start' AND entity_id = ${id}`,
        ),
      ).toBe(1);
    });

    it('refuses each edge in the database itself, whatever a caller believes is due', async () => {
      // The discovery query already filters on time; the UPDATE says it again, so a caller
      // holding a stale id (or none of the query's reasoning) cannot move a campaign early.
      const job = systemJobActor('campaign-test', 'c-test' as CorrelationId);
      const future = await scheduledRow(
        new Date(clock.now().getTime() + HOUR),
        new Date(clock.now().getTime() + DAY),
      );
      expect(await service.startIfDue(tenantA, job, future)).toBe(false);
      expect(await service.completeIfDue(tenantA, job, future)).toBe(false);
      expect(await stateOf(future)).toBe('SCHEDULED');

      const running = await scheduledRow(
        new Date(clock.now().getTime() - HOUR),
        new Date(clock.now().getTime() + HOUR),
      );
      expect(await service.startIfDue(tenantA, job, running)).toBe(true);
      expect(await service.startIfDue(tenantA, job, running), 'never twice').toBe(false);
      expect(await service.completeIfDue(tenantA, job, running), 'not before its end').toBe(false);
      expect(await stateOf(running)).toBe('ACTIVE');
    });

    it('completes a running campaign once its end has passed, exactly once', async () => {
      const id = await scheduledRow(
        new Date(clock.now().getTime() - HOUR),
        new Date(clock.now().getTime() + HOUR),
      );
      await loop.runOnce(tenantA);
      expect(await stateOf(id)).toBe('ACTIVE');

      clock.advance(HOUR + 1);
      const [first, second] = await Promise.all([loop.runOnce(tenantA), loop.runOnce(tenantA)]);
      expect(first.completed + second.completed).toBe(1);
      expect(await stateOf(id)).toBe('COMPLETED');
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'campaign.complete' AND entity_id = ${id}`,
        ),
      ).toBe(1);
    });

    it('starts and completes in one tick a campaign whose whole window passed while it was down', async () => {
      const id = await scheduledRow(
        new Date(clock.now().getTime() - 2 * HOUR),
        new Date(clock.now().getTime() - HOUR),
      );
      expect(await loop.runOnce(tenantA)).toEqual({ started: 1, completed: 1 });
      expect(await stateOf(id)).toBe('COMPLETED');
    });

    it('decides nothing about another tenant’s campaigns', async () => {
      const id = await scheduledRow(
        new Date(clock.now().getTime() - HOUR),
        new Date(clock.now().getTime() + HOUR),
        tenantB,
      );
      expect(await loop.runOnce(tenantA)).toEqual({ started: 0, completed: 0 });
      expect(await stateOf(id)).toBe('SCHEDULED');
    });

    it('starts nothing for a stopped installation, and still records a closed window', async () => {
      const running = await scheduledRow(
        new Date(clock.now().getTime() - 2 * HOUR),
        new Date(clock.now().getTime() + HOUR),
      );
      await loop.runOnce(tenantA);
      expect(await stateOf(running)).toBe('ACTIVE');

      await ctx.container.database.db.execute(
        sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
      );
      const waiting = await scheduledRow(
        new Date(clock.now().getTime() - HOUR),
        new Date(clock.now().getTime() + DAY),
      );
      clock.advance(HOUR + 1);
      await loop.runOnce(tenantA);
      expect(await stateOf(waiting), 'no new work for a stopped installation').toBe('SCHEDULED');
      expect(await stateOf(running), 'but a closed window is recorded').toBe('COMPLETED');
    });
  });

  describe('the discount and cashback actions are the existing engines’ own rules', () => {
    it('creates nothing priced while a DRAFT, and ACTIVE rules windowed to the campaign once scheduled', async () => {
      const id = await draftCampaign([
        { kind: 'DISCOUNT', terms: TWENTY_PERCENT },
        { kind: 'CASHBACK', terms: TEN_PERCENT_BACK },
      ]);
      expect(await count(sql`SELECT count(*)::int AS n FROM discounts`)).toBe(0);
      expect((await orderDraft()).totals.total.amountMinor, 'a draft discounts nothing').toBe(
        100_000n,
      );

      const detail = await schedule(id);
      expect(detail.campaign.state).toBe('SCHEDULED');
      expect(detail.campaign.audienceConfirmedCount).toBe(1);
      expect(detail.discount?.status).toBe('ACTIVE');
      expect(detail.discount?.label).toBe('جشنواره پاییز');
      expect(detail.discount?.startsAt?.getTime()).toBe(detail.campaign.startsAt.getTime());
      expect(detail.discount?.endsAt?.getTime()).toBe(detail.campaign.endsAt.getTime());
      expect(detail.cashbackRule?.status).toBe('ACTIVE');
      expect(detail.cashbackRule?.endsAt?.getTime()).toBe(detail.campaign.endsAt.getTime());

      // Priced by the ONE pricing boundary checkout uses: the campaign computed nothing.
      const order = await orderDraft();
      expect(order.totals.discount.amountMinor).toBe(20_000n);
      expect(order.totals.total.amountMinor).toBe(80_000n);
      expect(order.totals.quote.trace.map((step) => step.ruleId)).toContain(detail.discount?.id);
      expect(order.totals.quote.cashback?.ruleId).toBe(detail.cashbackRule?.id);
      expect(order.totals.quote.cashback?.amount.amountMinor).toBe(8_000n);
    });

    it('leaves the price alone before the window opens, because the engine enforces the window', async () => {
      const id = await draftCampaign([{ kind: 'DISCOUNT', terms: TWENTY_PERCENT }], {
        fromMs: HOUR,
        toMs: DAY,
      });
      const detail = await schedule(id);
      expect(detail.discount?.status).toBe('ACTIVE');
      expect((await orderDraft()).totals.total.amountMinor).toBe(100_000n);
    });

    it('refuses a confirmation whose audience moved since the preview, and creates nothing', async () => {
      const id = await draftCampaign([{ kind: 'DISCOUNT', terms: TWENTY_PERCENT }]);
      const { audience } = await service.preview(tenantA, owner, id);
      expect(audience.customers).toBe(1);

      // Somebody registers between the preview and the confirmation.
      await ctx.container.customers.resolveFromUpdate(tenantA, customerActor('late'), {
        idempotencyKey: 'resolve-late-customer',
        telegramUserId: '930002',
        from: { id: 930002, first_name: 'علی' },
        botInstanceId: BOT_A,
      });
      const confirm = (binding: { recipients: number; fingerprint: string }) =>
        service.schedule(tenantA, owner, {
          idempotencyKey: key(),
          campaignId: id,
          expectedDefinitionHash: audience.definitionHash,
          expectedRecipients: binding.recipients,
          expectedFingerprint: binding.fingerprint,
        });
      expect(await refusal(confirm({ recipients: 1, fingerprint: audience.fingerprint }))).toBe(
        'audience.changed',
      );
      // The right COUNT with a stale SET is refused too: the binding is the set.
      expect(await refusal(confirm({ recipients: 2, fingerprint: audience.fingerprint }))).toBe(
        'audience.changed',
      );
      expect(await stateOf(id)).toBe('DRAFT');
      expect(await count(sql`SELECT count(*)::int AS n FROM discounts`)).toBe(0);

      expect((await schedule(id)).campaign.audienceConfirmedCount).toBe(2);
    });

    it('charges each action’s own permission: a campaign is no way round it', async () => {
      const sales = adminActorFor(
        await createAdmin(ctx.container, tenantA, { username: 'sales-c', roleKeys: ['sales'] }),
      );
      // Sales holds campaigns.manage and catalog.discounts.edit, not catalog.pricing.edit.
      const discountOnly = await draftCampaign([{ kind: 'DISCOUNT', terms: TWENTY_PERCENT }], {
        actor: sales,
      });
      expect((await schedule(discountOnly, sales)).campaign.state).toBe('SCHEDULED');

      // A draft may not even hold an action its author may not perform…
      expect(
        await refusal(
          draftCampaign([{ kind: 'CASHBACK', terms: TEN_PERCENT_BACK }], { actor: sales }),
        ),
      ).toBe('platform.permission_denied');
      expect(await count(sql`SELECT count(*)::int AS n FROM campaigns`)).toBe(1);

      // …and a draft somebody else made cannot be confirmed without the action's key either.
      const withCashback = await draftCampaign([{ kind: 'CASHBACK', terms: TEN_PERCENT_BACK }]);
      expect(await refusal(schedule(withCashback, sales))).toBe('platform.permission_denied');
      expect(await stateOf(withCashback)).toBe('DRAFT');
      expect(await count(sql`SELECT count(*)::int AS n FROM cashback_rules`)).toBe(0);
    });

    it('refuses to edit a scheduled campaign, and a code another rule already holds', async () => {
      const id = await draftCampaign([{ kind: 'DISCOUNT', terms: TWENTY_PERCENT }]);
      await schedule(id);
      expect(
        await refusal(
          service.updateDraft(tenantA, owner, {
            idempotencyKey: key(),
            campaignId: id,
            draft: {
              name: 'دیگر',
              description: '',
              ...(await window(-HOUR, DAY)),
              audience: { version: 1 },
              actions: [],
            },
          }),
        ),
      ).toBe('campaign.not_editable');

      const coded = { ...TWENTY_PERCENT, kind: 'CODE' as const, code: 'autumn-20' };
      const first = await draftCampaign([{ kind: 'DISCOUNT', terms: coded }]);
      await schedule(first);
      expect(await refusal(draftCampaign([{ kind: 'DISCOUNT', terms: coded }]))).toBe(
        'commerce.discount_code_taken',
      );
    });

    it('replays a confirmation, and keeps tenants apart', async () => {
      const id = await draftCampaign([{ kind: 'DISCOUNT', terms: TWENTY_PERCENT }]);
      const { audience } = await service.preview(tenantA, owner, id);
      const input = {
        idempotencyKey: key(),
        campaignId: id,
        expectedDefinitionHash: audience.definitionHash,
        expectedRecipients: audience.customers,
        expectedFingerprint: audience.fingerprint,
      };
      await service.schedule(tenantA, owner, input);
      await service.schedule(tenantA, owner, input);
      expect(await count(sql`SELECT count(*)::int AS n FROM discounts`)).toBe(1);

      const ownerB = adminActorFor(
        await createAdmin(ctx.container, tenantB, { username: 'owner-b', roleKeys: ['owner'] }),
      );
      expect(await refusal(service.get(tenantB, ownerB, id))).toBe('campaign.not_found');
    });
  });

  describe('pause, resume and cancel', () => {
    it('pause withdraws the rules and resume restores them, only inside the window', async () => {
      const id = await draftCampaign([{ kind: 'DISCOUNT', terms: TWENTY_PERCENT }]);
      await schedule(id);
      await loop.runOnce(tenantA);
      const paused = await service.pause(tenantA, owner, { idempotencyKey: key(), campaignId: id });
      expect(paused.campaign.state).toBe('PAUSED');
      expect(paused.discount?.status).toBe('INACTIVE');
      expect((await orderDraft()).totals.total.amountMinor).toBe(100_000n);

      const resumed = await service.resume(tenantA, owner, {
        idempotencyKey: key(),
        campaignId: id,
      });
      expect(resumed.discount?.status).toBe('ACTIVE');
      expect((await orderDraft()).totals.total.amountMinor).toBe(80_000n);

      await service.pause(tenantA, owner, { idempotencyKey: key(), campaignId: id });
      clock.advance(2 * DAY);
      expect(
        await refusal(service.resume(tenantA, owner, { idempotencyKey: key(), campaignId: id })),
        'a window that has closed is not resumed',
      ).toBe('campaign.transition_invalid');
    });

    it('cancel stops future work and undoes no completed financial effect', async () => {
      const id = await draftCampaign([
        { kind: 'DISCOUNT', terms: TWENTY_PERCENT },
        { kind: 'CASHBACK', terms: TEN_PERCENT_BACK },
      ]);
      await schedule(id);
      await loop.runOnce(tenantA);

      // One order all the way through: discounted, paid, delivered, cashback earned.
      const delivered = await confirm(await orderDraft());
      await payFromWallet(delivered);
      await deliver(delivered.id);
      expect(await ctx.container.cashback.settleDue(tenantA, 50)).toBe(1);
      // One order confirmed and not yet delivered: its cashback is a promise.
      const promised = await confirm(await orderDraft());
      // One draft carrying the discount, not yet confirmed.
      const pendingDraft = await orderDraft();

      const cancelled = await service.cancel(tenantA, owner, {
        idempotencyKey: key(),
        campaignId: id,
      });
      expect(cancelled.campaign.state).toBe('CANCELLED');
      expect(cancelled.discount?.status).toBe('INACTIVE');
      expect(cancelled.cashbackRule?.status).toBe('INACTIVE');

      // Future work stops: a new draft is full price, and the old draft is refused
      // rather than silently re-priced — the engine's own rule.
      expect((await orderDraft()).totals.total.amountMinor).toBe(100_000n);
      expect(await refusal(confirm(pendingDraft))).toBe('commerce.discount_no_longer_valid');

      // Nothing completed is undone.
      expect(
        await rows<{ order_id: string; amount: string }>(
          sql`SELECT order_id, amount::text AS amount FROM discount_redemptions ORDER BY created_at`,
        ),
      ).toEqual([
        { order_id: delivered.id, amount: '20000' },
        { order_id: promised.id, amount: '20000' },
      ]);
      expect(
        await rows<{ order_id: string; state: string }>(
          sql`SELECT order_id, state FROM order_cashback ORDER BY created_at`,
        ),
      ).toEqual([
        { order_id: delivered.id, state: 'EARNED' },
        { order_id: promised.id, state: 'PENDING' },
      ]);
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM wallet_entries WHERE reason = 'CASHBACK_PURCHASE'`,
        ),
      ).toBe(1);
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM wallet_entries WHERE reason = 'CASHBACK_REVERSAL'`,
        ),
        'no reversal',
      ).toBe(0);

      // The promise made before the cancel is still kept at delivery.
      await payFromWallet(promised);
      await deliver(promised.id);
      expect(await ctx.container.cashback.settleDue(tenantA, 50)).toBe(1);

      // And the worker never moves a cancelled campaign.
      clock.advance(2 * DAY);
      expect(await loop.runOnce(tenantA)).toEqual({ started: 0, completed: 0 });
      expect(await stateOf(id)).toBe('CANCELLED');
    });
  });

  describe('results', () => {
    it('reports only persisted attribution: redemptions and promises of the campaign’s own rules', async () => {
      // An order before the campaign existed is not the campaign's, whatever it bought.
      const before = await confirm(await orderDraft());
      const id = await draftCampaign([
        { kind: 'DISCOUNT', terms: TWENTY_PERCENT },
        { kind: 'CASHBACK', terms: TEN_PERCENT_BACK },
      ]);
      await schedule(id);
      const paid = await confirm(await orderDraft());
      await payFromWallet(paid);
      await deliver(paid.id);
      await ctx.container.cashback.settleDue(tenantA, 50);
      await confirm(await orderDraft());
      await orderDraft(); // a draft redeems nothing

      const results = await service.results(tenantA, owner, id);
      // No field beyond what a row persists: no revenue caused, no conversion.
      expect(Object.keys(results).sort()).toEqual([
        'announcement',
        'cashback',
        'discount',
        'targeted',
        'timeGift',
        'trafficGift',
        'walletGift',
      ]);
      expect(results.targeted).toBe(1);
      // A campaign with no gift and no announcement reports none: nothing is invented.
      expect([
        results.announcement,
        results.walletGift,
        results.trafficGift,
        results.timeGift,
      ]).toEqual([null, null, null, null]);
      expect(results.discount?.byOrderState).toEqual([
        { state: 'AWAITING_PAYMENT', count: 1, amount: 20_000n, currency: 'IRT' },
        { state: 'PAID', count: 1, amount: 20_000n, currency: 'IRT' },
      ]);
      expect(results.cashback?.byState.map((t) => [t.state, t.count, t.amount])).toEqual([
        ['EARNED', 1, 8_000n],
        ['PENDING', 1, 8_000n],
      ]);
      expect(results.cashback?.totals).toEqual([
        { currency: 'IRT', earned: 8_000n, reversedRecovered: 0n, reversedUnrecovered: 0n },
      ]);
      expect(before.totals.discount.amountMinor).toBe(0n);
    });
  });

  it('never adds cashback amounts in different currencies together', async () => {
    const id = await draftCampaign([{ kind: 'CASHBACK', terms: TEN_PERCENT_BACK }]);
    await schedule(id);
    const irt = await confirm(await orderDraft());
    const other = await confirm(await orderDraft());
    await payFromWallet(irt);
    await deliver(irt.id);
    await ctx.container.cashback.settleDue(tenantA, 50);
    // A promise in another currency — a tenant that changed its selling currency during
    // the campaign. The guard freezes a promise's currency, so the test sets it aside.
    const db = ctx.container.database.db;
    await db.execute(sql`ALTER TABLE order_cashback DISABLE TRIGGER USER`);
    try {
      await db.execute(
        sql`UPDATE order_cashback SET currency = 'USD' WHERE order_id = ${other.id}`,
      );
    } finally {
      await db.execute(sql`ALTER TABLE order_cashback ENABLE TRIGGER USER`);
    }

    const results = await service.results(tenantA, owner, id);
    expect(results.cashback?.totals).toEqual([
      { currency: 'IRT', earned: 10_000n, reversedRecovered: 0n, reversedUnrecovered: 0n },
      { currency: 'USD', earned: 0n, reversedRecovered: 0n, reversedUnrecovered: 0n },
    ]);
    expect(results.cashback?.byState.map((t) => [t.state, t.currency, t.amount])).toEqual([
      ['EARNED', 'IRT', 10_000n],
      ['PENDING', 'USD', 10_000n],
    ]);
  });

  describe('the announcement is a broadcast of the shared lane', () => {
    const ANNOUNCE = {
      kind: 'ANNOUNCEMENT' as const,
      terms: {
        body: 'سلام {firstName}، جشنواره شروع شد',
        buttons: [],
        purpose: 'MARKETING' as const,
      },
    };

    const broadcastOf = async (campaignId: string) =>
      (
        await rows<{ id: string; state: string; recipient_count: number | null }>(sql`
          SELECT b.id, b.state, b.recipient_count
            FROM campaign_actions a JOIN broadcasts b ON b.id = a.broadcast_id
           WHERE a.campaign_id = ${campaignId} AND a.kind = 'ANNOUNCEMENT'`)
      )[0];

    it('launches it at the confirmation, scheduled for the start, to the frozen audience', async () => {
      const id = await draftCampaign([{ kind: 'DISCOUNT', terms: TWENTY_PERCENT }, ANNOUNCE], {
        fromMs: 2 * HOUR,
        toMs: DAY,
      });
      const detail = await schedule(id);
      const action = detail.actions.find((a) => a.kind === 'ANNOUNCEMENT');
      expect(action?.state).toBe('LAUNCHED');
      const broadcast = await broadcastOf(id);
      expect(broadcast?.state).toBe('SCHEDULED');
      expect(broadcast?.recipient_count).toBe(1);
      const scheduled = await rows<{ scheduled_at: Date }>(
        sql`SELECT scheduled_at FROM broadcasts WHERE id = ${broadcast?.id}`,
      );
      expect(new Date(scheduled[0]?.scheduled_at as Date).getTime()).toBe(
        detail.campaign.startsAt.getTime(),
      );

      // A replayed launch hands nothing over twice.
      await service.launchPending(tenantA, owner, id);
      expect(await count(sql`SELECT count(*)::int AS n FROM broadcasts`)).toBe(1);

      // Cancelling before the start cancels the broadcast: nobody is messaged.
      await service.cancel(tenantA, owner, { idempotencyKey: key(), campaignId: id });
      expect((await broadcastOf(id))?.state).toBe('CANCELLED');
    });

    it('a replayed pause after a resume does not pause the announcement again', async () => {
      const id = await draftCampaign([{ kind: 'DISCOUNT', terms: TWENTY_PERCENT }, ANNOUNCE]);
      await schedule(id);
      await loop.runOnce(tenantA);
      expect((await broadcastOf(id))?.state).toBe('SENDING');

      const pauseKey = key();
      await service.pause(tenantA, owner, { idempotencyKey: pauseKey, campaignId: id });
      expect((await broadcastOf(id))?.state).toBe('PAUSED');
      await service.resume(tenantA, owner, { idempotencyKey: key(), campaignId: id });
      expect((await broadcastOf(id))?.state).toBe('SENDING');

      await service.pause(tenantA, owner, { idempotencyKey: pauseKey, campaignId: id });
      expect(await stateOf(id)).toBe('ACTIVE');
      expect((await broadcastOf(id))?.state).toBe('SENDING');
    });

    it('a failed announcement rolls back no financial action', async () => {
      const failing = new CampaignService({
        ...deps(),
        broadcasts: {
          ...ctx.container.broadcasts,
          create: ctx.container.broadcasts.create.bind(ctx.container.broadcasts),
          get: ctx.container.broadcasts.get.bind(ctx.container.broadcasts),
          // Broadcast refuses the hand-over on its merits.
          launch: () =>
            Promise.reject(errors.conflict(AUDIENCE_ERROR_CODES.CHANGED, 'refused for the test')),
        } as never,
      });
      const id = await draftCampaign([{ kind: 'DISCOUNT', terms: TWENTY_PERCENT }, ANNOUNCE]);
      const { audience } = await failing.preview(tenantA, owner, id);
      const detail = await failing.schedule(tenantA, owner, {
        idempotencyKey: key(),
        campaignId: id,
        expectedDefinitionHash: audience.definitionHash,
        expectedRecipients: audience.customers,
        expectedFingerprint: audience.fingerprint,
      });
      expect(detail.campaign.state).toBe('SCHEDULED');
      expect(detail.actions.find((a) => a.kind === 'ANNOUNCEMENT')?.state).toBe('FAILED');
      // The discount stands: the message and the money are separate records.
      expect(detail.discount?.status).toBe('ACTIVE');
      expect((await orderDraft()).totals.total.amountMinor).toBe(80_000n);
    });
  });

  describe('gifts are mass operations of the shared engine', () => {
    const GIFT = {
      kind: 'WALLET_GIFT' as const,
      terms: { amountMinor: '5000', currency: 'IRT' as const, notify: false },
    };

    /** The confirmation exactly as the operator's page sends it, from the preview. */
    async function confirmGift(
      id: string,
      tamper: { totalMinor?: string; typedCount?: number | null } = {},
    ) {
      const preview = await service.preview(tenantA, owner, id);
      const wallet = preview.gifts.WALLET_GIFT;
      if (wallet === undefined) throw new Error('no wallet gift preview');
      return service.schedule(tenantA, owner, {
        idempotencyKey: key(),
        campaignId: id,
        expectedDefinitionHash: preview.audience.definitionHash,
        expectedRecipients: preview.audience.customers,
        expectedFingerprint: preview.audience.fingerprint,
        walletGift: {
          count: wallet.count,
          fingerprint: wallet.fingerprint,
          typedCount: tamper.typedCount === undefined ? wallet.count : tamper.typedCount,
          totalMinor: tamper.totalMinor ?? wallet.totalLiability?.amountMinor ?? '0',
        },
      });
    }

    const massCredits = () =>
      rows<{ customer_id: string; amount: string }>(
        sql`SELECT customer_id, amount::text AS amount FROM wallet_entries WHERE reason = 'MASS_CREDIT'`,
      );

    it('shows the exact liability, then credits each customer exactly once from the start', async () => {
      const id = await draftCampaign([GIFT]);
      const preview = await service.preview(tenantA, owner, id);
      expect(preview.gifts.WALLET_GIFT?.count).toBe(1);
      expect(preview.gifts.WALLET_GIFT?.totalLiability).toEqual({
        amountMinor: '5000',
        currency: 'IRT',
      });
      expect(preview.typedCountRequired.walletGift).toBe(true);

      const detail = await confirmGift(id);
      const action = detail.actions.find((a) => a.kind === 'WALLET_GIFT');
      expect(action?.state).toBe('LAUNCHED');
      const op = await rows<{ not_before: Date }>(
        sql`SELECT not_before FROM bulk_operations WHERE id = ${action?.bulkOperationId}`,
      );
      expect(new Date(op[0]?.not_before as Date).getTime()).toBe(
        detail.campaign.startsAt.getTime(),
      );

      await ctx.container.bulkOperationProcessor.pass(tenantA);
      await ctx.container.bulkOperationProcessor.pass(tenantA);
      await service.launchPending(tenantA, owner, id);
      expect(await massCredits()).toEqual([{ customer_id: customerA, amount: '5000' }]);

      // Cancelling afterwards stops what is left and takes nothing back.
      await service.cancel(tenantA, owner, { idempotencyKey: key(), campaignId: id });
      expect(await massCredits()).toHaveLength(1);
      const results = await service.results(tenantA, owner, id);
      expect(results.walletGift?.credited).toEqual({ amountMinor: 5000n, currency: 'IRT' });
      expect(results.walletGift?.counts.credited).toBe(1);
    });

    it('credits nothing before the start, and a cancel before it credits nothing at all', async () => {
      const id = await draftCampaign([GIFT], { fromMs: 2 * HOUR, toMs: DAY });
      await confirmGift(id);
      await ctx.container.bulkOperationProcessor.pass(tenantA);
      expect(await massCredits()).toHaveLength(0);

      await service.cancel(tenantA, owner, { idempotencyKey: key(), campaignId: id });
      await ctx.container.bulkOperationProcessor.pass(tenantA);
      expect(await massCredits()).toHaveLength(0);
      expect(await rows<{ state: string }>(sql`SELECT state FROM bulk_operation_items`)).toEqual([
        { state: 'CANCELLED' },
      ]);
    });

    it('refuses a confirmation whose liability or typed count is not what the preview showed', async () => {
      const id = await draftCampaign([GIFT]);
      expect(await refusal(confirmGift(id, { totalMinor: '4000' }))).toBe('audience.changed');
      expect(await refusal(confirmGift(id, { typedCount: null }))).toBe(
        'campaign.confirmation_required',
      );
      expect(await stateOf(id)).toBe('DRAFT');
      expect(await count(sql`SELECT count(*)::int AS n FROM bulk_operations`)).toBe(0);
    });

    it('stops a gift the engine took after the campaign was cancelled mid hand-over', async () => {
      const id = await draftCampaign([GIFT]);
      // The operator cancels in the instant between the confirmation's commit and the
      // hand-over: the cancel finds no engine record to stop, and the engine then makes one.
      const racing = new CampaignService({
        ...deps(),
        massActions: {
          ...ctx.container.bulkOperations,
          preview: ctx.container.bulkOperations.preview.bind(ctx.container.bulkOperations),
          get: ctx.container.bulkOperations.get.bind(ctx.container.bulkOperations),
          progress: ctx.container.bulkOperations.progress.bind(ctx.container.bulkOperations),
          cancel: ctx.container.bulkOperations.cancel.bind(ctx.container.bulkOperations),
          create: async (...args: Parameters<typeof ctx.container.bulkOperations.create>) => {
            await service.cancel(tenantA, owner, { idempotencyKey: key(), campaignId: id });
            return ctx.container.bulkOperations.create(...args);
          },
        } as never,
      });
      const preview = await racing.preview(tenantA, owner, id);
      const wallet = preview.gifts.WALLET_GIFT;
      await racing.schedule(tenantA, owner, {
        idempotencyKey: key(),
        campaignId: id,
        expectedDefinitionHash: preview.audience.definitionHash,
        expectedRecipients: preview.audience.customers,
        expectedFingerprint: preview.audience.fingerprint,
        walletGift: {
          count: wallet?.count ?? 0,
          fingerprint: wallet?.fingerprint ?? '',
          typedCount: wallet?.count ?? 0,
          totalMinor: wallet?.totalLiability?.amountMinor ?? '0',
        },
      });
      expect(await stateOf(id)).toBe('CANCELLED');
      // The start has passed, so an operation left running would credit on the next pass.
      await ctx.container.bulkOperationProcessor.pass(tenantA);
      expect(await massCredits()).toHaveLength(0);
      expect(await rows<{ state: string }>(sql`SELECT state FROM bulk_operations`)).toEqual([
        { state: 'CANCELLED' },
      ]);
    });

    it('a replayed cancel asks the engine again when the first engine cancel failed', async () => {
      const id = await draftCampaign([GIFT], { fromMs: 2 * HOUR, toMs: DAY });
      await confirmGift(id);
      let failures = 1;
      const flaky = new CampaignService({
        ...deps(),
        massActions: {
          ...ctx.container.bulkOperations,
          get: ctx.container.bulkOperations.get.bind(ctx.container.bulkOperations),
          progress: ctx.container.bulkOperations.progress.bind(ctx.container.bulkOperations),
          preview: ctx.container.bulkOperations.preview.bind(ctx.container.bulkOperations),
          create: ctx.container.bulkOperations.create.bind(ctx.container.bulkOperations),
          cancel: (...args: Parameters<typeof ctx.container.bulkOperations.cancel>) => {
            if (failures > 0) {
              failures -= 1;
              return Promise.reject(new Error('the engine was unreachable'));
            }
            return ctx.container.bulkOperations.cancel(...args);
          },
        } as never,
      });
      const cancelKey = key();
      await expect(
        flaky.cancel(tenantA, owner, { idempotencyKey: cancelKey, campaignId: id }),
      ).rejects.toThrow('unreachable');
      // The campaign's own cancel committed; the engine's did not.
      expect(await stateOf(id)).toBe('CANCELLED');
      expect(await rows<{ state: string }>(sql`SELECT state FROM bulk_operations`)).toEqual([
        { state: 'RUNNING' },
      ]);

      // The operator presses again: the same command, replayed, reaches the engine.
      await flaky.cancel(tenantA, owner, { idempotencyKey: cancelKey, campaignId: id });
      expect(await rows<{ state: string }>(sql`SELECT state FROM bulk_operations`)).toEqual([
        { state: 'CANCELLED' },
      ]);
    });

    it('a delayed hand-over gifts exactly the confirmed set, however the audience moved since', async () => {
      const id = await draftCampaign([GIFT], { fromMs: 2 * HOUR, toMs: DAY });
      // The confirmation commits, and the engine is unreachable for the hand-over.
      const down = new CampaignService({
        ...deps(),
        massActions: {
          ...ctx.container.bulkOperations,
          preview: ctx.container.bulkOperations.preview.bind(ctx.container.bulkOperations),
          create: () => Promise.reject(new Error('the engine was unreachable')),
        } as never,
      });
      const preview = await down.preview(tenantA, owner, id);
      const wallet = preview.gifts.WALLET_GIFT;
      await expect(
        down.schedule(tenantA, owner, {
          idempotencyKey: key(),
          campaignId: id,
          expectedDefinitionHash: preview.audience.definitionHash,
          expectedRecipients: preview.audience.customers,
          expectedFingerprint: preview.audience.fingerprint,
          walletGift: {
            count: wallet?.count ?? 0,
            fingerprint: wallet?.fingerprint ?? '',
            typedCount: wallet?.count ?? 0,
            totalMinor: wallet?.totalLiability?.amountMinor ?? '0',
          },
        }),
      ).rejects.toThrow('unreachable');
      expect(await stateOf(id)).toBe('SCHEDULED');

      // The confirmation FROZE the set: one customer, held durably and named by the action.
      const frozenId = (
        await rows<{ frozen_audience_id: string | null }>(
          sql`SELECT frozen_audience_id FROM campaign_actions WHERE campaign_id = ${id}`,
        )
      )[0]?.frozen_audience_id;
      expect(frozenId).toBeTruthy();
      expect(
        await rows<{ customer_id: string }>(
          sql`SELECT customer_id FROM frozen_audience_members WHERE frozen_audience_id = ${frozenId}`,
        ),
      ).toEqual([{ customer_id: customerA }]);

      // Somebody registers before the hand-over is retried: the LIVE definition has moved.
      const late = await ctx.container.customers.resolveFromUpdate(
        tenantA,
        customerActor('late-gift'),
        {
          idempotencyKey: 'resolve-late-gift',
          telegramUserId: '930003',
          from: { id: 930003, first_name: 'مریم' },
          botInstanceId: BOT_A,
        },
      );
      expect(
        (await ctx.container.audience.evaluate(tenantA, { version: 1 })).customers,
        'the live audience now has two',
      ).toBe(2);

      // Round N close (§A, closing OQ-C1-04): the retry seeds the engine from the frozen
      // members, so it succeeds with exactly the confirmed set — the newcomer gets nothing.
      const detail = await service.launchPending(tenantA, owner, id);
      const action = detail.actions.find((a) => a.kind === 'WALLET_GIFT');
      expect(action?.state).toBe('LAUNCHED');
      expect(action?.frozenAudienceId).toBe(frozenId);
      const operation = await ctx.container.bulkOperations.get(
        tenantA,
        owner,
        action?.bulkOperationId as string,
      );
      expect(operation.frozenAudienceId).toBe(frozenId);
      expect(operation.itemCount).toBe(1);
      expect(
        await rows<{ customer_id: string }>(
          sql`SELECT customer_id FROM bulk_operation_items WHERE bulk_operation_id = ${operation.id}`,
        ),
      ).toEqual([{ customer_id: customerA }]);
      expect(late.customer.id).not.toBe(customerA);

      // And when the start comes, the credit reaches the confirmed customer alone. The
      // container's processor keeps the real clock, so one on the test's clock is driven.
      clock.advance(3 * HOUR);
      const processor = new BulkOperationProcessor({
        repository: new DrizzleBulkOperationRepository(ctx.container.database.db),
        wallet: new DrizzleWalletRepository(ctx.container.database.db),
        grants: ctx.container.provisioning,
        notifier: new CustomerNotifier({
          notifications: ctx.container.customerNotifications,
          bots: { botFor: async () => BOT_A },
          ids: ctx.container.ids,
        }),
        outbox: ctx.container.outbox,
        uow: ctx.container.uow,
        scopeActivity: ctx.container.tenants,
        sellingCurrency: async () => 'IRT',
        clock,
        ids: ctx.container.ids,
        logger: { info: () => undefined, error: () => undefined },
      });
      await processor.pass(tenantA);
      expect(await massCredits()).toEqual([{ customer_id: customerA, amount: '5000' }]);
    });

    it('refuses a time gift that reaches no service, before anything is written', async () => {
      const id = await draftCampaign([
        { kind: 'DISCOUNT', terms: TWENTY_PERCENT },
        { kind: 'TIME_GIFT', terms: { durationDays: 3, notify: false } },
      ]);
      const preview = await service.preview(tenantA, owner, id);
      const time = preview.gifts.TIME_GIFT;
      expect(time?.count).toBe(0);
      expect(
        await refusal(
          service.schedule(tenantA, owner, {
            idempotencyKey: key(),
            campaignId: id,
            expectedDefinitionHash: preview.audience.definitionHash,
            expectedRecipients: preview.audience.customers,
            expectedFingerprint: preview.audience.fingerprint,
            timeGift: {
              count: 0,
              fingerprint: time?.fingerprint as string,
              typedCount: null,
            },
          }),
        ),
      ).toBe('audience.empty');
      expect(await stateOf(id)).toBe('DRAFT');
      expect(await count(sql`SELECT count(*)::int AS n FROM discounts`)).toBe(0);
    });

    it('charges the mass-credit permission: a campaign is no way round it', async () => {
      const sales = adminActorFor(
        await createAdmin(ctx.container, tenantA, { username: 'sales-g', roleKeys: ['sales'] }),
      );
      expect(await refusal(draftCampaign([GIFT], { actor: sales }))).toBe(
        'platform.permission_denied',
      );
      const id = await draftCampaign([GIFT]);
      expect(await refusal(service.preview(tenantA, sales, id))).toBe('platform.permission_denied');
      expect(
        await refusal(
          service.schedule(tenantA, sales, {
            idempotencyKey: key(),
            campaignId: id,
            expectedDefinitionHash: 'a'.repeat(64),
            expectedRecipients: 1,
            expectedFingerprint: 'b'.repeat(32),
            walletGift: {
              count: 1,
              fingerprint: 'b'.repeat(32),
              typedCount: 1,
              totalMinor: '5000',
            },
          }),
        ),
      ).toBe('platform.permission_denied');
      expect(await count(sql`SELECT count(*)::int AS n FROM bulk_operations`)).toBe(0);
    });
  });
});
