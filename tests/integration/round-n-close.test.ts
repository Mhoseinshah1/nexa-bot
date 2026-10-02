import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIENCE_ERROR_CODES,
  BROADCAST_ERROR_CODES,
  BROADCAST_LEASE_MS,
  BULK_ERROR_CODES,
  CUSTOMER_NOTIFICATION_SWEEP_LIMIT,
  isNexaError,
  type ActorContext,
  type AudienceDefinitionInput,
  type BotInstanceId,
  type BulkGrant,
  type Clock,
  type CorrelationId,
  type UserId,
} from '@nexa/contracts';
import { BroadcastService } from '../../apps/api/src/modules/commerce/broadcasts/application/broadcast.service';
import { BroadcastDispatcher } from '../../apps/api/src/modules/commerce/broadcasts/application/broadcast-dispatcher';
import type {
  BroadcastDeliverRequest,
  BroadcastPinResult,
  BroadcastRenderRequest,
  BroadcastRenderResult,
  BroadcastSendResult,
  BroadcastTransport,
} from '../../apps/api/src/modules/commerce/broadcasts/application/ports';
import { DrizzleBroadcastRepository } from '../../apps/api/src/modules/commerce/broadcasts/infrastructure/drizzle-broadcast.repository';
import { DrizzleRecipientFactsReader } from '../../apps/api/src/modules/commerce/broadcasts/infrastructure/drizzle-recipient-facts.reader';
import { BulkOperationProcessor } from '../../apps/api/src/modules/commerce/bulk-operations/application/bulk-operation-processor';
import { DrizzleBulkOperationRepository } from '../../apps/api/src/modules/commerce/bulk-operations/infrastructure/drizzle-bulk-operation.repository';
import { CampaignService } from '../../apps/api/src/modules/commerce/campaigns/application/campaign.service';
import type { CampaignActionConfig } from '../../apps/api/src/modules/commerce/campaigns/application/ports';
import { DrizzleCampaignRepository } from '../../apps/api/src/modules/commerce/campaigns/infrastructure/drizzle-campaign.repository';
import { IntlCampaignCalendar } from '../../apps/api/src/modules/commerce/campaigns/infrastructure/intl-campaign-calendar';
import { CustomerNotifier } from '../../apps/api/src/modules/commerce/messaging/application/customer-notifier';
import { CustomerNotificationService } from '../../apps/api/src/modules/commerce/messaging/application/customer-notification.service';
import type { CustomerMessage } from '../../apps/api/src/modules/commerce/messaging/application/ports';
import { DrizzleCustomerNotificationRepository } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-customer-notification.repository';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleCashbackRuleRepository } from '../../apps/api/src/modules/commerce/pricing/infrastructure/drizzle-cashback.repository';
import { DrizzleDiscountRepository } from '../../apps/api/src/modules/commerce/pricing/infrastructure/drizzle-discount.repository';
import { DrizzleServiceReminderSnapshotReader } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service-reminder.repository';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import { CachedTenantPresentationReader } from '../../apps/api/src/modules/control/templates/infrastructure/cached-tenant-presentation.reader';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';
import { AudienceFixtures } from './audience-fixtures';

/**
 * Round N close (`docs/round-n-close-audit.md`): the frozen audience that closes OQ-C1-04,
 * pause and resume on a mass operation and their propagation from a campaign, forward,
 * copy and pin on a broadcast, and the promotional opt-out. Every case here is one of the
 * brief's named regressions, against the real tables.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BOT_A = SEED_IDS.botA1 as BotInstanceId;

class StoppedClock implements Clock {
  private at = Date.now() + 5_000;
  now(): Date {
    return new Date(this.at);
  }
  advance(ms: number): void {
    this.at += ms;
  }
}

/** Telegram, scripted per chat: every send and every pin is recorded. */
class ScriptedTransport implements BroadcastTransport {
  readonly delivered: string[] = [];
  readonly requests: BroadcastDeliverRequest[] = [];
  readonly pinned: string[] = [];
  private readonly scripts = new Map<string, BroadcastSendResult[]>();
  private readonly pinScripts = new Map<string, BroadcastPinResult[]>();
  crashOn: string | null = null;
  crashOnPin: string | null = null;
  /** Runs between the caller's reads and its send: what another operator commits meanwhile. */
  beforeDeliver: (() => Promise<void>) | null = null;

  script(chatId: string, ...results: BroadcastSendResult[]): void {
    this.scripts.set(chatId, results);
  }

  scriptPin(chatId: string, ...results: BroadcastPinResult[]): void {
    this.pinScripts.set(chatId, results);
  }

  async render(_scope: unknown, request: BroadcastRenderRequest): Promise<BroadcastRenderResult> {
    return {
      ok: true,
      rendered: {
        contentKind: request.contentKind,
        text: request.body,
        buttons: request.buttons,
        source: request.source,
      },
    };
  }

  async deliver(_scope: unknown, request: BroadcastDeliverRequest): Promise<BroadcastSendResult> {
    if (this.beforeDeliver !== null) await this.beforeDeliver();
    this.delivered.push(request.chatId);
    this.requests.push(request);
    if (this.crashOn === request.chatId) throw new Error('worker died mid-send');
    return (
      this.scripts.get(request.chatId)?.shift() ?? {
        outcome: 'SENT',
        messageId: 100 + this.delivered.length,
      }
    );
  }

  async pin(
    _scope: unknown,
    request: { chatId: string; botInstanceId: string; messageId: number },
  ): Promise<BroadcastPinResult> {
    this.pinned.push(request.chatId);
    if (this.crashOnPin === request.chatId) throw new Error('worker died mid-pin');
    return this.pinScripts.get(request.chatId)?.shift() ?? { outcome: 'PINNED' };
  }
}

const telegramActor = (key: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: `corr-${key}` as CorrelationId,
});

describe('round N close', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let fixtures: AudienceFixtures;
  let clock: StoppedClock;
  let transport: ScriptedTransport;
  let dispatcher: BroadcastDispatcher;
  let broadcasts: BroadcastService;
  let campaigns: CampaignService;
  let calendar: IntlCampaignCalendar;
  let n = 0;
  const key = (): string => `rnc-${(n += 1)}-${Date.now()}`;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const campaignDeps = (): ConstructorParameters<typeof CampaignService>[0] => ({
    campaigns: new DrizzleCampaignRepository(ctx.container.database.db),
    discounts: new DrizzleDiscountRepository(ctx.container.database.db),
    cashbackRules: new DrizzleCashbackRuleRepository(ctx.container.database.db),
    discountAdmin: ctx.container.discounts,
    cashbackAdmin: ctx.container.cashbackRules,
    calendar,
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

  beforeEach(async () => {
    await ctx.reset();
    const c = ctx.container;
    owner = adminActorFor(
      await createAdmin(c, tenantA, { username: 'owner-rnc', roleKeys: ['owner'] }),
    );
    fixtures = new AudienceFixtures(ctx, tenantA.tenantId as string);
    clock = new StoppedClock();
    transport = new ScriptedTransport();
    dispatcher = new BroadcastDispatcher({
      repository: new DrizzleBroadcastRepository(c.database.db),
      transport,
      facts: new DrizzleRecipientFactsReader(c.database.db, async () => 'IRT'),
      outbox: c.outbox,
      uow: c.uow,
      clock,
      ids: c.ids,
      scopeIsActive: async () => true,
      logger: { info: () => undefined, error: () => undefined },
      marketingOptOut: optOutPolicy(),
    });
    broadcasts = new BroadcastService({
      marketingOptOut: optOutPolicy(),
      repository: new DrizzleBroadcastRepository(c.database.db),
      audience: c.audience,
      transport,
      facts: new DrizzleRecipientFactsReader(c.database.db, async () => 'IRT'),
      guard: c.guard,
      uow: c.uow,
      audit: c.audit,
      opsLog: c.opsLog,
      sessions: c.sessions,
      idempotency: c.idempotency,
      scopeActivity: c.tenants,
      outbox: c.outbox,
      clock,
      ids: c.ids,
    });
    calendar = new IntlCampaignCalendar(new CachedTenantPresentationReader(c.tenants, clock));
    campaigns = new CampaignService(campaignDeps());
  });

  /** Spec §9: the container's own switch, as production wires it. */
  const optOutPolicy = () => ({
    honoured: (scope: typeof tenantA, tx?: unknown) =>
      ctx.container.featureFlagResolver.isEnabled(scope, 'customer_marketing_opt_out', tx),
  });

  function processor(): BulkOperationProcessor {
    return new BulkOperationProcessor({
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
  }

  async function customers(count: number, prefix = 77): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      ids.push(
        await fixtures.customer({
          telegramUserId: `${String(prefix)}${String(1000 + index)}`,
          botInstanceId: SEED_IDS.botA1,
          firstName: `c${String(index)}`,
        }),
      );
    }
    return ids;
  }

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return ((await ctx.container.database.db.execute(query as never)) as unknown as { rows: T[] })
      .rows;
  }

  const massCredits = () =>
    rows<{ customer_id: string; amount: string }>(
      sql`SELECT customer_id, amount::text AS amount FROM wallet_entries
           WHERE reason = 'MASS_CREDIT' ORDER BY customer_id`,
    );

  async function refusal(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      if (isNexaError(error)) return error.code;
      throw error;
    }
    throw new Error('expected a refusal');
  }

  async function window(fromMs: number, toMs: number) {
    const presentation = await calendar.presentationFor(tenantA);
    const start = calendar.localOf(new Date(clock.now().getTime() + fromMs), presentation);
    const end = calendar.localOf(new Date(clock.now().getTime() + toMs), presentation);
    return { startDate: start.date, startTime: start.time, endDate: end.date, endTime: end.time };
  }

  async function draftCampaign(
    service: CampaignService,
    actions: readonly CampaignActionConfig[],
    fromMs = -HOUR,
    audience: AudienceDefinitionInput = { version: 1 },
  ): Promise<string> {
    const detail = await service.createDraft(tenantA, owner, {
      idempotencyKey: key(),
      draft: {
        name: 'جشنوارهٔ پاییز',
        description: '',
        ...(await window(fromMs, DAY)),
        audience,
        actions,
      },
    });
    return detail.campaign.id;
  }

  /** Confirms exactly what the preview showed, for every gift the campaign has. */
  async function confirmCampaign(service: CampaignService, id: string) {
    const preview = await service.preview(tenantA, owner, id);
    const gift = (kind: 'WALLET_GIFT' | 'TRAFFIC_GIFT' | 'TIME_GIFT') => {
      const p = preview.gifts[kind];
      if (p === undefined) return null;
      return {
        count: p.count,
        fingerprint: p.fingerprint,
        typedCount: kind === 'WALLET_GIFT' || p.count >= 100 ? p.count : null,
      };
    };
    const wallet = gift('WALLET_GIFT');
    return service.schedule(tenantA, owner, {
      idempotencyKey: key(),
      campaignId: id,
      expectedDefinitionHash: preview.audience.definitionHash,
      expectedRecipients: preview.audience.customers,
      expectedFingerprint: preview.audience.fingerprint,
      typedCount: preview.typedCountRequired.audience ? preview.audience.customers : null,
      walletGift:
        wallet === null
          ? null
          : {
              ...wallet,
              totalMinor: preview.gifts.WALLET_GIFT?.totalLiability?.amountMinor ?? '0',
            },
      trafficGift: gift('TRAFFIC_GIFT'),
      timeGift: gift('TIME_GIFT'),
    });
  }

  /**
   * A campaign service whose engines are unreachable for the FIRST hand-over only: the
   * confirmation commits, the hand-over that follows it throws at its first engine call
   * (`stage`: the engine's create, or — for the announcement — the launch AFTER a create
   * that committed), and every later call goes through.
   */
  function withEnginesDownOnce(stage: 'create' | 'launch' = 'create'): CampaignService {
    let down = true;
    const fail = () => {
      down = false;
      return Promise.reject(new Error('the engine was unreachable'));
    };
    const bulk = ctx.container.bulkOperations;
    const bc = ctx.container.broadcasts;
    return new CampaignService({
      ...campaignDeps(),
      massActions: {
        preview: bulk.preview.bind(bulk),
        get: bulk.get.bind(bulk),
        progress: bulk.progress.bind(bulk),
        cancel: bulk.cancel.bind(bulk),
        pause: bulk.pause.bind(bulk),
        resume: bulk.resume.bind(bulk),
        freezeServiceAudience: bulk.freezeServiceAudience.bind(bulk),
        create: (...args: Parameters<typeof bulk.create>) =>
          down && stage === 'create' ? fail() : bulk.create(...args),
      },
      broadcasts: {
        launch: (...args: Parameters<typeof bc.launch>) =>
          down && stage === 'launch' ? fail() : bc.launch(...args),
        pause: bc.pause.bind(bc),
        resume: bc.resume.bind(bc),
        cancel: bc.cancel.bind(bc),
        get: bc.get.bind(bc),
        counts: bc.counts.bind(bc),
        create: (...args: Parameters<typeof bc.create>) =>
          down && stage === 'create' ? fail() : bc.create(...args),
      },
    });
  }

  describe('A — the frozen audience (closing OQ-C1-04)', () => {
    it('a retried hand-over gifts and messages exactly the confirmed customers, never a newcomer', async () => {
      const [a, b] = await customers(2);
      const service = withEnginesDownOnce();
      const id = await draftCampaign(service, [
        { kind: 'WALLET_GIFT', terms: { amountMinor: '5000', currency: 'IRT', notify: false } },
        { kind: 'ANNOUNCEMENT', terms: { body: 'سلام', buttons: [], purpose: 'MARKETING' } },
      ]);
      await expect(confirmCampaign(service, id)).rejects.toThrow('unreachable');
      const actions = await new DrizzleCampaignRepository(ctx.container.database.db).actionsOf(
        tenantA,
        id,
      );
      const frozenIds = new Set(actions.map((x) => x.frozenAudienceId));
      // ONE customer set, frozen once, shared by the gift and the announcement.
      expect(frozenIds.size).toBe(1);
      const [frozenId] = [...frozenIds];
      expect(
        (
          await rows<{ customer_id: string }>(
            sql`SELECT customer_id FROM frozen_audience_members
                 WHERE frozen_audience_id = ${frozenId} ORDER BY customer_id`,
          )
        ).map((r) => r.customer_id),
      ).toEqual([a, b].sort());

      // The live audience moves before the retry.
      const [newcomer] = await customers(1, 99);
      const detail = await service.launchPending(tenantA, owner, id);
      for (const action of detail.actions) expect(action.state).toBe('LAUNCHED');
      const gift = detail.actions.find((x) => x.kind === 'WALLET_GIFT');
      const announcement = detail.actions.find((x) => x.kind === 'ANNOUNCEMENT');
      const items = await rows<{ customer_id: string }>(
        sql`SELECT customer_id FROM bulk_operation_items
             WHERE bulk_operation_id = ${gift?.bulkOperationId} ORDER BY customer_id`,
      );
      expect(items.map((r) => r.customer_id)).toEqual([a, b].sort());
      const recipients = await rows<{ customer_id: string }>(
        sql`SELECT customer_id FROM broadcast_recipients
             WHERE broadcast_id = ${announcement?.broadcastId} ORDER BY customer_id`,
      );
      expect(recipients.map((r) => r.customer_id)).toEqual([a, b].sort());
      expect(items.some((r) => r.customer_id === newcomer)).toBe(false);
      const op = await ctx.container.bulkOperations.get(
        tenantA,
        owner,
        gift?.bulkOperationId as string,
      );
      expect(op.frozenAudienceId).toBe(frozenId);
      const bc = await ctx.container.broadcasts.get(
        tenantA,
        owner,
        announcement?.broadcastId as string,
      );
      expect(bc.frozenAudienceId).toBe(frozenId);
    });

    it('a service gift freezes its services; a service eligible only later gets nothing, one no longer active is SKIPPED', async () => {
      const panel = await fixtures.panel('grant');
      await makePanelSellable(ctx.container, tenantA, panel);
      const [a, b, c] = await customers(3);
      const serviceA = await fixtures.service({ customerId: a as string, panelId: panel });
      const serviceB = await fixtures.service({ customerId: b as string, panelId: panel });
      const service = withEnginesDownOnce();
      const id = await draftCampaign(
        service,
        [{ kind: 'TRAFFIC_GIFT', terms: { trafficGb: '10', notify: false } }],
        -HOUR,
        { version: 1, service: {} },
      );
      await expect(confirmCampaign(service, id)).rejects.toThrow('unreachable');
      const frozen = await rows<{ kind: string; member_count: number }>(
        sql`SELECT kind, member_count FROM frozen_audiences`,
      );
      expect(frozen).toEqual([{ kind: 'SERVICES', member_count: 2 }]);

      // Since the confirmation: c got a service (eligible now), and b's expired.
      await fixtures.service({ customerId: c as string, panelId: panel });
      await ctx.container.database.db.execute(
        sql`UPDATE services SET state = 'EXPIRED' WHERE id = ${serviceB}::uuid`,
      );
      const detail = await service.launchPending(tenantA, owner, id);
      const gift = detail.actions.find((x) => x.kind === 'TRAFFIC_GIFT');
      expect(gift?.state).toBe('LAUNCHED');
      expect(
        (
          await rows<{ service_id: string }>(
            sql`SELECT service_id FROM bulk_operation_items
                 WHERE bulk_operation_id = ${gift?.bulkOperationId} ORDER BY service_id`,
          )
        ).map((r) => r.service_id),
      ).toEqual([serviceA, serviceB].sort());

      // The write re-decides live safety: the expired service is SKIPPED, never planned.
      await processor().pass(tenantA);
      const items = await rows<{ service_id: string; state: string; skip_reason: string | null }>(
        sql`SELECT service_id, state, skip_reason FROM bulk_operation_items ORDER BY service_id`,
      );
      expect(items.find((r) => r.service_id === serviceA)).toMatchObject({ state: 'PLANNED' });
      expect(items.find((r) => r.service_id === serviceB)).toMatchObject({
        state: 'SKIPPED',
        skip_reason: 'SERVICE_NOT_ELIGIBLE',
      });
      const ops = await rows<{ service_id: string }>(
        sql`SELECT service_id FROM provisioning_operations`,
      );
      expect(ops).toEqual([{ service_id: serviceA }]);
    });

    it('releases a frozen audience only once nothing live names it, and never its header', async () => {
      await customers(2);
      // The hand-over fails once, so for a while the audience is named by the campaign's
      // action ALONE — the case the sweep's campaign clause exists for.
      const service = withEnginesDownOnce();
      const id = await draftCampaign(
        service,
        [{ kind: 'WALLET_GIFT', terms: { amountMinor: '5000', currency: 'IRT', notify: false } }],
        2 * HOUR,
      );
      await expect(confirmCampaign(service, id)).rejects.toThrow('unreachable');
      const frozenId = (await rows<{ id: string }>(sql`SELECT id FROM frozen_audiences`))[0]
        ?.id as string;
      const members = () =>
        rows<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM frozen_audience_members WHERE frozen_audience_id = ${frozenId}`,
        ).then((r) => r[0]?.n ?? 0);
      const actor = telegramActor('sweep');
      clock.advance(2 * DAY);
      // Old enough, and no engine record yet — but the campaign is live: kept.
      expect(await rows(sql`SELECT id FROM bulk_operations`)).toHaveLength(0);
      expect(await service.releaseFrozenAudiences(tenantA, actor)).toBe(0);
      expect(await members()).toBe(2);
      // Handed over now: the operation names it too, and it is still kept.
      await service.launchPending(tenantA, owner, id);
      expect(await rows(sql`SELECT id FROM bulk_operations`)).toHaveLength(1);
      expect(await service.releaseFrozenAudiences(tenantA, actor)).toBe(0);

      await campaigns.cancel(tenantA, owner, { idempotencyKey: key(), campaignId: id });
      expect(await campaigns.releaseFrozenAudiences(tenantA, actor)).toBe(1);
      expect(await members()).toBe(0);
      const header = await rows<{ released_at: Date | null; member_count: number }>(
        sql`SELECT released_at, member_count FROM frozen_audiences WHERE id = ${frozenId}`,
      );
      expect(header[0]?.released_at).not.toBeNull();
      expect(header[0]?.member_count).toBe(2);
      // Nothing can be seeded from a released audience; the header stays for the record.
      const preview = await ctx.container.bulkOperations.preview(tenantA, owner, {
        grant: { kind: 'WALLET_CREDIT', amountMinor: '5000', currency: 'IRT' },
        definition: { version: 1 },
      });
      expect(
        await refusal(
          ctx.container.bulkOperations.create(tenantA, owner, {
            idempotencyKey: key(),
            grant: { kind: 'WALLET_CREDIT', amountMinor: '5000', currency: 'IRT' },
            definition: { version: 1 },
            notify: false,
            note: 'again',
            expectedDefinitionHash: preview.definitionHash,
            expectedCount: 2,
            expectedFingerprint: preview.fingerprint,
            expectedTotalMinor: '10000',
            typedCount: 2,
            notBefore: null,
            frozenAudienceId: frozenId,
          }),
        ),
      ).toBe(AUDIENCE_ERROR_CODES.FROZEN_RELEASED);
    });

    it('a draft the hand-over left behind holds nothing: the audience is released, and the draft refuses', async () => {
      await customers(2);
      // The announcement's draft commits; the process dies before its launch.
      const service = withEnginesDownOnce('launch');
      const id = await draftCampaign(service, [
        { kind: 'ANNOUNCEMENT', terms: { body: 'سلام', buttons: [], purpose: 'MARKETING' } },
      ]);
      await expect(confirmCampaign(service, id)).rejects.toThrow('unreachable');
      const [draft] = await rows<{ id: string; state: string; frozen_audience_id: string }>(
        sql`SELECT id, state, frozen_audience_id FROM broadcasts`,
      );
      expect(draft).toMatchObject({ state: 'DRAFT' });
      const frozenId = draft?.frozen_audience_id as string;
      const actor = telegramActor('sweep');
      // The campaign still names the set: held.
      clock.advance(2 * DAY);
      expect(await service.releaseFrozenAudiences(tenantA, actor)).toBe(0);
      // The campaign ends with the action never linked: the DRAFT is all that names the
      // set, and a draft holds nothing.
      await campaigns.cancel(tenantA, owner, { idempotencyKey: key(), campaignId: id });
      expect(await service.releaseFrozenAudiences(tenantA, actor)).toBe(1);
      expect(
        await rows(
          sql`SELECT id FROM frozen_audience_members WHERE frozen_audience_id = ${frozenId}`,
        ),
      ).toHaveLength(0);
      // The draft outlived its set: refused, never sent to a set nobody holds.
      expect((await broadcasts.get(tenantA, owner, draft?.id as string)).state).toBe('DRAFT');
      expect(await refusal(broadcasts.preview(tenantA, owner, draft?.id as string))).toBe(
        AUDIENCE_ERROR_CODES.FROZEN_RELEASED,
      );
    });

    it('a frozen draft’s preview counts the reachable part of the set it holds', async () => {
      const [withBot] = await customers(1);
      const noBot = await fixtures.customer({ telegramUserId: '772000', botInstanceId: null });
      const frozen = await ctx.container.uow.run(tenantA, (tx) =>
        ctx.container.audience.freeze(tenantA, { version: 1 }, clock.now(), null, tx),
      );
      expect(frozen).toMatchObject({ count: 2, reachable: 1 });
      const draft = await broadcasts.create(tenantA, owner, {
        idempotencyKey: key(),
        title: 'notice',
        contentKind: 'TEXT',
        body: 'سلام',
        buttons: [],
        audience: { version: 1 },
        purpose: 'SERVICE_ANNOUNCEMENT',
        frozenAudienceId: frozen.id,
      });
      const preview = await broadcasts.preview(tenantA, owner, draft.id);
      expect(preview).toMatchObject({
        customers: 2,
        reachable: 1,
        fingerprint: frozen.fingerprint,
      });
      // What the preview said is what the launch writes: one to send, one UNREACHABLE.
      await broadcasts.launch(tenantA, owner, draft.id, {
        idempotencyKey: key(),
        mode: 'NOW',
        scheduledAt: null,
        expectedVersion: draft.version,
        expectedDefinitionHash: preview.definitionHash,
        expectedRecipients: preview.customers,
        expectedFingerprint: preview.fingerprint,
        typedCount: null,
      });
      const recipients = await rows<{ customer_id: string; state: string }>(
        sql`SELECT customer_id, state FROM broadcast_recipients`,
      );
      expect(Object.fromEntries(recipients.map((r) => [r.customer_id, r.state]))).toEqual({
        [withBot as string]: 'PENDING',
        [noBot]: 'UNREACHABLE',
      });
    });

    it('a frozen SERVICES set is bound to the grant it was selected for', async () => {
      const panel = await fixtures.panel('grant');
      await makePanelSellable(ctx.container, tenantA, panel);
      const [a] = await customers(1);
      await fixtures.service({ customerId: a as string, panelId: panel });
      const traffic: BulkGrant = { kind: 'SERVICE_TRAFFIC', trafficGb: '10' };
      const time: BulkGrant = { kind: 'SERVICE_TIME', durationDays: 7 };
      const definition = { version: 1, service: {} };
      const frozen = await ctx.container.uow.run(tenantA, (tx) =>
        ctx.container.bulkOperations.freezeServiceAudience(
          tenantA,
          owner,
          { grant: traffic, definition, asOf: clock.now() },
          tx,
        ),
      );
      expect(frozen).toMatchObject({ kind: 'SERVICES', grantKind: 'SERVICE_TRAFFIC', count: 1 });
      expect(
        await rows(sql`SELECT id FROM frozen_audiences WHERE grant_kind = 'SERVICE_TRAFFIC'`),
      ).toHaveLength(1);
      const create = async (grant: BulkGrant) => {
        const preview = await ctx.container.bulkOperations.preview(tenantA, owner, {
          grant,
          definition,
        });
        return ctx.container.bulkOperations.create(tenantA, owner, {
          idempotencyKey: key(),
          grant,
          definition,
          notify: false,
          note: 'bound',
          expectedDefinitionHash: preview.definitionHash,
          expectedCount: 1,
          expectedFingerprint: preview.fingerprint,
          expectedTotalMinor: null,
          typedCount: null,
          notBefore: null,
          frozenAudienceId: frozen.id,
        });
      };
      // The same definition, the same services today — and still not the set a time
      // grant's rule selected: refused.
      expect(await refusal(create(time))).toBe(AUDIENCE_ERROR_CODES.FROZEN_KIND_MISMATCH);
      expect((await create(traffic)).frozenAudienceId).toBe(frozen.id);
    });
  });

  describe('B — pause and resume', () => {
    const credit: BulkGrant = { kind: 'WALLET_CREDIT', amountMinor: '5000', currency: 'IRT' };

    async function confirmBulk(
      grant: BulkGrant,
      definition: AudienceDefinitionInput = { version: 1 },
    ) {
      const preview = await ctx.container.bulkOperations.preview(tenantA, owner, {
        grant,
        definition,
      });
      return ctx.container.bulkOperations.create(tenantA, owner, {
        idempotencyKey: key(),
        grant,
        definition,
        notify: false,
        note: 'gift',
        expectedDefinitionHash: preview.definitionHash,
        expectedCount: preview.count,
        expectedFingerprint: preview.fingerprint,
        expectedTotalMinor: preview.totalLiability?.amountMinor ?? null,
        typedCount: preview.count,
        notBefore: null,
      });
    }

    it('a paused operation claims nothing new, resumes exactly once, and a cancel reverses nothing done', async () => {
      await customers(4);
      const op = await confirmBulk(credit);
      await processor().pass(tenantA, 1);
      expect(await massCredits()).toHaveLength(1);

      const paused = await ctx.container.bulkOperations.pause(tenantA, owner, op.id);
      expect(paused).toMatchObject({ state: 'PAUSED' });
      expect(paused.pausedAt).not.toBeNull();
      await processor().pass(tenantA);
      await processor().pass(tenantA);
      expect(await massCredits(), 'nothing claimed while paused').toHaveLength(1);
      // Repeated, answered; a pause of a paused operation is not a conflict.
      expect((await ctx.container.bulkOperations.pause(tenantA, owner, op.id)).state).toBe(
        'PAUSED',
      );

      const resumed = await ctx.container.bulkOperations.resume(tenantA, owner, op.id);
      expect(resumed).toMatchObject({ state: 'RUNNING', pausedAt: null });
      // A replayed resume finds RUNNING and is answered, not repeated.
      expect((await ctx.container.bulkOperations.resume(tenantA, owner, op.id)).state).toBe(
        'RUNNING',
      );
      await processor().pass(tenantA, 1);
      expect(await massCredits(), 'continues from exactly where it stopped').toHaveLength(2);

      const cancelled = await ctx.container.bulkOperations.cancel(tenantA, owner, op.id);
      expect(cancelled.state).toBe('CANCELLED');
      await processor().pass(tenantA);
      expect(await massCredits()).toHaveLength(2);
      const counts = (
        await ctx.container.bulkOperations.progress(tenantA, owner, [op.id])
      ).counts.get(op.id);
      expect(counts).toMatchObject({ credited: 2, cancelled: 2, pending: 0 });
      // A PAUSED operation can be cancelled too, and its PENDING items go with it.
      await customers(2, 66);
      const second = await confirmBulk(credit, { version: 1, customerStatus: 'ANY' });
      await ctx.container.bulkOperations.pause(tenantA, owner, second.id);
      expect((await ctx.container.bulkOperations.cancel(tenantA, owner, second.id)).state).toBe(
        'CANCELLED',
      );
      await expect(
        ctx.container.bulkOperations.resume(tenantA, owner, second.id),
      ).rejects.toMatchObject({ code: BULK_ERROR_CODES.STATE_CONFLICT });
    });

    it('an ambiguous provider write finishes its reconciliation while paused; a PENDING item waits', async () => {
      const panel = await fixtures.panel('grant');
      await makePanelSellable(ctx.container, tenantA, panel);
      const [a, b, c] = await customers(3);
      for (const customerId of [a, b, c]) {
        await fixtures.service({ customerId: customerId as string, panelId: panel });
      }
      const op = await confirmBulk(
        { kind: 'SERVICE_TRAFFIC', trafficGb: '10' },
        { version: 1, service: {} },
      );
      await processor().pass(tenantA, 2);
      const planned = await rows<{ id: string }>(sql`SELECT id FROM provisioning_operations`);
      expect(planned).toHaveLength(2);
      await ctx.container.bulkOperations.pause(tenantA, owner, op.id);
      // The provisioner decides the two in flight: one UNKNOWN then reconciled, one succeeded.
      await ctx.container.database.db.execute(
        sql`UPDATE provisioning_operations SET state = 'UNKNOWN' WHERE id = ${planned[0]?.id}::uuid`,
      );
      await ctx.container.database.db.execute(
        sql`UPDATE provisioning_operations SET state = 'SUCCEEDED', completed_at = now()
             WHERE id = ${planned[1]?.id}::uuid`,
      );
      await processor().pass(tenantA);
      let counts = (
        await ctx.container.bulkOperations.progress(tenantA, owner, [op.id])
      ).counts.get(op.id);
      expect(counts).toMatchObject({
        pending: 1,
        planned: 1,
        awaitingReconciliation: 1,
        succeeded: 1,
      });
      await ctx.container.database.db.execute(
        sql`UPDATE provisioning_operations SET state = 'SUCCEEDED', completed_at = now()
             WHERE id = ${planned[0]?.id}::uuid`,
      );
      await processor().pass(tenantA);
      counts = (await ctx.container.bulkOperations.progress(tenantA, owner, [op.id])).counts.get(
        op.id,
      );
      expect(counts, 'reconciled while paused; the pending item untouched').toMatchObject({
        pending: 1,
        planned: 0,
        succeeded: 2,
      });
      expect((await ctx.container.bulkOperations.get(tenantA, owner, op.id)).state).toBe('PAUSED');
      expect(await rows(sql`SELECT id FROM provisioning_operations`)).toHaveLength(2);

      await ctx.container.bulkOperations.resume(tenantA, owner, op.id);
      await processor().pass(tenantA);
      expect(await rows(sql`SELECT id FROM provisioning_operations`)).toHaveLength(3);

      // Paused again with its last item in flight: the item is settled, the operation is
      // NOT closed under the operator — COMPLETED is reached from RUNNING only.
      await ctx.container.bulkOperations.pause(tenantA, owner, op.id);
      await ctx.container.database.db.execute(
        sql`UPDATE provisioning_operations SET state = 'SUCCEEDED', completed_at = now()
             WHERE state <> 'SUCCEEDED'`,
      );
      await processor().pass(tenantA);
      counts = (await ctx.container.bulkOperations.progress(tenantA, owner, [op.id])).counts.get(
        op.id,
      );
      expect(counts).toMatchObject({ pending: 0, planned: 0, succeeded: 3 });
      expect((await ctx.container.bulkOperations.get(tenantA, owner, op.id)).state).toBe('PAUSED');
      await ctx.container.bulkOperations.resume(tenantA, owner, op.id);
      await processor().pass(tenantA);
      expect((await ctx.container.bulkOperations.get(tenantA, owner, op.id)).state).toBe(
        'COMPLETED',
      );
    });

    it('a campaign pause and resume propagate to its gift idempotently, and never fight the operation’s own page', async () => {
      await customers(2);
      const id = await draftCampaign(campaigns, [
        { kind: 'WALLET_GIFT', terms: { amountMinor: '5000', currency: 'IRT', notify: false } },
      ]);
      const detail = await confirmCampaign(campaigns, id);
      const opId = detail.actions.find((x) => x.kind === 'WALLET_GIFT')?.bulkOperationId as string;
      const opState = async () =>
        (await ctx.container.bulkOperations.get(tenantA, owner, opId)).state;
      // The start has passed: the worker makes it ACTIVE.
      await ctx.container.database.db.execute(
        sql`UPDATE campaigns SET state = 'ACTIVE', started_at = now() WHERE id = ${id}`,
      );
      expect(await opState()).toBe('RUNNING');

      const pauseKey = key();
      await campaigns.pause(tenantA, owner, { idempotencyKey: pauseKey, campaignId: id });
      expect(await opState()).toBe('PAUSED');
      await campaigns.pause(tenantA, owner, { idempotencyKey: pauseKey, campaignId: id });
      expect(await opState()).toBe('PAUSED');

      const resumeKey = key();
      await campaigns.resume(tenantA, owner, { idempotencyKey: resumeKey, campaignId: id });
      expect(await opState()).toBe('RUNNING');
      await campaigns.resume(tenantA, owner, { idempotencyKey: resumeKey, campaignId: id });
      expect(await opState()).toBe('RUNNING');

      // Paused by the campaign, resumed by hand on its own page: a later campaign resume
      // finds nothing to do and does not fail.
      await campaigns.pause(tenantA, owner, { idempotencyKey: key(), campaignId: id });
      await ctx.container.bulkOperations.resume(tenantA, owner, opId);
      const resumed = await campaigns.resume(tenantA, owner, {
        idempotencyKey: key(),
        campaignId: id,
      });
      expect(resumed.campaign.state).toBe('ACTIVE');
      expect(await opState()).toBe('RUNNING');
      expect(await massCredits()).toHaveLength(0);
    });

    it('a hand-over retried under a paused campaign lands paused, and the resume releases it', async () => {
      await customers(2);
      const service = withEnginesDownOnce();
      const id = await draftCampaign(service, [
        { kind: 'WALLET_GIFT', terms: { amountMinor: '5000', currency: 'IRT', notify: false } },
        { kind: 'ANNOUNCEMENT', terms: { body: 'سلام', buttons: [], purpose: 'MARKETING' } },
      ]);
      await expect(confirmCampaign(service, id)).rejects.toThrow('unreachable');
      await ctx.container.database.db.execute(
        sql`UPDATE campaigns SET state = 'ACTIVE', started_at = now() WHERE id = ${id}`,
      );
      // The pause finds no engine record to stop: nothing was handed over yet.
      await campaigns.pause(tenantA, owner, { idempotencyKey: key(), campaignId: id });
      expect(await rows(sql`SELECT id FROM bulk_operations`)).toHaveLength(0);

      // The retry: the engines take the work — under a campaign that is PAUSED.
      const detail = await service.launchPending(tenantA, owner, id);
      const opId = detail.actions.find((x) => x.kind === 'WALLET_GIFT')?.bulkOperationId as string;
      const bcId = detail.actions.find((x) => x.kind === 'ANNOUNCEMENT')?.broadcastId as string;
      expect((await ctx.container.bulkOperations.get(tenantA, owner, opId)).state).toBe('PAUSED');
      expect((await broadcasts.get(tenantA, owner, bcId)).state).toBe('PAUSED');
      await processor().pass(tenantA);
      await dispatcher.pass(tenantA);
      expect(await massCredits()).toHaveLength(0);
      expect(transport.delivered).toEqual([]);

      await campaigns.resume(tenantA, owner, { idempotencyKey: key(), campaignId: id });
      expect((await ctx.container.bulkOperations.get(tenantA, owner, opId)).state).toBe('RUNNING');
      expect((await broadcasts.get(tenantA, owner, bcId)).state).toBe('SENDING');
      await processor().pass(tenantA);
      expect(await massCredits()).toHaveLength(2);
    });
  });

  describe('D — the promotional opt-out', () => {
    async function optOut(customerId: string, optedOut: boolean, k = key()) {
      return ctx.container.customers.setMarketingOptOut(tenantA, telegramActor(k), {
        idempotencyKey: k,
        customerId,
        optedOut,
      });
    }

    async function draft(
      purpose: 'MARKETING' | 'SERVICE_ANNOUNCEMENT',
      frozenAudienceId: string | null = null,
    ) {
      return broadcasts.create(tenantA, owner, {
        idempotencyKey: key(),
        title: purpose,
        contentKind: 'TEXT',
        body: 'سلام',
        buttons: [],
        audience: { version: 1 },
        purpose,
        frozenAudienceId,
      });
    }

    async function launch(id: string) {
      const record = await broadcasts.get(tenantA, owner, id);
      const preview = await broadcasts.preview(tenantA, owner, id);
      return broadcasts.launch(tenantA, owner, id, {
        idempotencyKey: key(),
        mode: 'NOW',
        scheduledAt: null,
        expectedVersion: record.version,
        expectedDefinitionHash: preview.definitionHash,
        expectedRecipients: preview.customers,
        expectedFingerprint: preview.fingerprint,
        typedCount: null,
      });
    }

    const states = async (broadcastId: string) =>
      Object.fromEntries(
        (
          await rows<{ chat_id: string; state: string; error_code: string | null }>(
            sql`SELECT chat_id, state, error_code FROM broadcast_recipients WHERE broadcast_id = ${broadcastId}::uuid`,
          )
        ).map((r) => [r.chat_id, r.error_code === null ? r.state : `${r.state}:${r.error_code}`]),
      );

    it('excludes an opted-out customer from MARKETING at the count, the materialisation and the send, and from nothing else', async () => {
      const [a, b, c] = await customers(3);
      const first = await optOut(b as string, true, 'stop-b');
      expect(first.changed).toBe(true);
      expect(first.customer.marketingOptOutAt).not.toBeNull();
      // The same update again is the same answer; a fresh opt-out changes nothing.
      expect((await optOut(b as string, true, 'stop-b')).changed).toBe(true);
      expect((await optOut(b as string, true)).changed).toBe(false);
      expect(
        (await ctx.container.customers.get(tenantA, owner, b as string)).marketingOptOutAt,
      ).not.toBeNull();

      const marketing = await draft('MARKETING');
      const notice = await draft('SERVICE_ANNOUNCEMENT');
      expect((await broadcasts.preview(tenantA, owner, marketing.id)).customers).toBe(2);
      expect((await broadcasts.preview(tenantA, owner, notice.id)).customers).toBe(3);
      // The shared audience itself still counts everybody: the exclusion is the send's.
      expect((await ctx.container.audience.evaluate(tenantA, { version: 1 })).customers).toBe(3);

      await launch(marketing.id);
      expect(Object.keys(await states(marketing.id)).sort()).toEqual(['771000', '771002']);
      // c opts out after the launch: re-read at the send, skipped before the stamp.
      await optOut(c as string, true);
      await dispatcher.pass(tenantA);
      expect(await states(marketing.id)).toEqual({
        '771000': 'SENT',
        '771002': 'SKIPPED:broadcast.marketing_opted_out',
      });
      expect(transport.delivered).toEqual(['771000']);

      // A service announcement reaches all three, opted out or not.
      await launch(notice.id);
      clock.advance(1_001);
      await dispatcher.pass(tenantA);
      expect(await states(notice.id)).toEqual({
        '771000': 'SENT',
        '771001': 'SENT',
        '771002': 'SENT',
      });
      expect(a).toBeTruthy();

      // Opting back in: the next MARKETING send counts them again.
      expect((await optOut(b as string, false)).changed).toBe(true);
      expect((await optOut(b as string, false)).changed).toBe(false);
      const again = await draft('MARKETING');
      expect((await broadcasts.preview(tenantA, owner, again.id)).customers).toBe(2);
    });

    it('a MARKETING send seeded from a frozen audience keeps the confirmed count and writes an opted-out member SKIPPED', async () => {
      const [a, b] = await customers(2);
      const frozen = await ctx.container.uow.run(tenantA, (tx) =>
        ctx.container.audience.freeze(tenantA, { version: 1 }, clock.now(), null, tx),
      );
      expect(frozen.count).toBe(2);
      await optOut(b as string, true);
      const record = await draft('MARKETING', frozen.id);
      const preview = await broadcasts.preview(tenantA, owner, record.id);
      expect(preview).toMatchObject({ customers: 2, fingerprint: frozen.fingerprint });
      const launched = await launch(record.id);
      expect(launched.recipientCount).toBe(2);
      expect(launched.audienceFingerprint).toBe(frozen.fingerprint);
      expect(await states(record.id)).toEqual({
        '771000': 'PENDING',
        '771001': 'SKIPPED:broadcast.marketing_opted_out',
      });
      await dispatcher.pass(tenantA);
      expect(transport.delivered).toEqual(['771000']);
      expect(a).toBeTruthy();
    });

    it('an opt-out that lands after the pass’s reads and before the stamp is honoured by the stamp', async () => {
      const [a] = await customers(1);
      // A worker whose reads are done and whose stamp has not happened: the opt-out commits
      // in between. The stamp decides under the customer's lock, so it is seen.
      const facts = new DrizzleRecipientFactsReader(ctx.container.database.db, async () => 'IRT');
      const racing = new BroadcastDispatcher({
        repository: new DrizzleBroadcastRepository(ctx.container.database.db),
        transport,
        facts: {
          factsFor: async (scope, customerId, options) => {
            await optOut(customerId, true);
            return facts.factsFor(scope, customerId, options);
          },
        },
        outbox: ctx.container.outbox,
        uow: ctx.container.uow,
        clock,
        ids: ctx.container.ids,
        scopeIsActive: async () => true,
        logger: { info: () => undefined, error: () => undefined },
      });
      const marketing = await draft('MARKETING');
      await launch(marketing.id);
      expect(await states(marketing.id)).toEqual({ '771000': 'PENDING' });
      await racing.pass(tenantA);
      expect(await states(marketing.id)).toEqual({
        '771000': 'SKIPPED:broadcast.marketing_opted_out',
      });
      expect(transport.delivered).toEqual([]);
      expect(a).toBeTruthy();
    });

    async function setOptOutPolicy(enabled: boolean) {
      const current = await ctx.container.featureFlagResolver.resolve(
        tenantA,
        'customer_marketing_opt_out',
      );
      await ctx.container.featureFlags.set(tenantA, owner, {
        key: 'customer_marketing_opt_out',
        enabled,
        expectedVersion: current.version,
        idempotencyKey: key(),
        reason: 'Spec §9 integration test.',
      });
    }

    const storedOptOut = async (customerId: string) =>
      (
        await rows<{ at: Date | null }>(
          sql`SELECT marketing_opt_out_at AS at FROM customers WHERE id = ${customerId}`,
        )
      )[0]?.at ?? null;

    it('spec §9: with the policy OFF a MARKETING send ignores a stored opt-out — at the count, the materialisation and the send — without erasing it; ON again honours it', async () => {
      const [a, b] = await customers(2);
      await optOut(b as string, true);
      const stored = await storedOptOut(b as string);
      expect(stored).not.toBeNull();

      await setOptOutPolicy(false);
      const marketing = await draft('MARKETING');
      expect((await broadcasts.preview(tenantA, owner, marketing.id)).customers).toBe(2);
      await launch(marketing.id);
      expect(await states(marketing.id)).toEqual({ '771000': 'PENDING', '771001': 'PENDING' });
      await dispatcher.pass(tenantA);
      expect(await states(marketing.id)).toEqual({ '771000': 'SENT', '771001': 'SENT' });
      expect(transport.delivered.sort()).toEqual(['771000', '771001']);
      // The stored preference is untouched.
      expect(await storedOptOut(b as string)).toEqual(stored);

      // ON again: the earlier choice is effective at once.
      await setOptOutPolicy(true);
      const again = await draft('MARKETING');
      expect((await broadcasts.preview(tenantA, owner, again.id)).customers).toBe(1);
      expect(a).toBeTruthy();
    });

    it('spec §9: the send re-reads the policy at its stamp — rows materialised while OFF are SKIPPED if it is ON again before they go', async () => {
      const [a, b] = await customers(2);
      await optOut(b as string, true);
      await setOptOutPolicy(false);
      const marketing = await draft('MARKETING');
      await launch(marketing.id);
      expect(await states(marketing.id)).toEqual({ '771000': 'PENDING', '771001': 'PENDING' });
      await setOptOutPolicy(true);
      await dispatcher.pass(tenantA);
      expect(await states(marketing.id)).toEqual({
        '771000': 'SENT',
        '771001': 'SKIPPED:broadcast.marketing_opted_out',
      });
      expect(transport.delivered).toEqual(['771000']);
      expect(a).toBeTruthy();
    });

    it('spec §9: a service announcement is unaffected by the policy either way', async () => {
      const [a, b] = await customers(2);
      await optOut(b as string, true);
      for (const enabled of [false, true]) {
        await setOptOutPolicy(enabled);
        const notice = await draft('SERVICE_ANNOUNCEMENT');
        expect((await broadcasts.preview(tenantA, owner, notice.id)).customers).toBe(2);
      }
      expect(a).toBeTruthy();
    });

    it('a transactional notice on ADR-0030’s lane still reaches an opted-out customer', async () => {
      const [b] = await customers(1);
      await optOut(b as string, true);
      const repo = new DrizzleCustomerNotificationRepository(ctx.container.database.db);
      const people = new DrizzleCustomerRepository(ctx.container.database.db);
      const sends: CustomerMessage[] = [];
      const lane = new CustomerNotificationService({
        refundFigures: new DrizzleWalletRepository(ctx.container.database.db),
        paymentCredits: new DrizzleWalletRepository(ctx.container.database.db),
        rejectionReasons: new DrizzlePaymentRepository(ctx.container.database.db),
        notifications: repo,
        reminderSnapshots: new DrizzleServiceReminderSnapshotReader(ctx.container.database.db),
        contacts: {
          contactFor: async (scope, customerId, tx) => {
            const found = await people.findById(scope, customerId, tx);
            if (found === null) return { kind: 'NONE' };
            if (found.status !== 'ACTIVE') return { kind: 'BLOCKED' };
            return { kind: 'CONTACT', contact: { chatId: found.telegramUserId } };
          },
        },
        subjects: { stillHolds: async () => true },
        messenger: {
          send: async (_scope, message) => {
            sends.push(message);
            return { outcome: 'DELIVERED' };
          },
          acknowledge: async () => undefined,
          sendFile: async () => ({ outcome: 'REFUSED' }),
        },
        uow: ctx.container.uow,
        clock: ctx.container.clock,
        scopeIsActive: async () => true,
        logger: { info: () => {}, error: () => {} },
      });
      await ctx.container.uow.run(tenantA, (tx) =>
        repo.enqueue(
          tenantA,
          {
            id: ctx.container.ids.uuid(),
            customerId: b as UserId,
            botInstanceId: BOT_A,
            kind: 'PAYMENT_REJECTED',
            subjectId: ctx.container.ids.uuid(),
          },
          ctx.container.clock.now(),
          tx,
        ),
      );
      const report = await lane.deliverDue(tenantA, CUSTOMER_NOTIFICATION_SWEEP_LIMIT);
      expect(report.delivered).toBe(1);
      expect(sends).toHaveLength(1);
      expect(await rows<{ state: string }>(sql`SELECT state FROM customer_notifications`)).toEqual([
        { state: 'DELIVERED' },
      ]);
    });
  });

  describe('C — forward, copy and pin', () => {
    const SOURCE = { chatId: '-1001234567890', messageId: 42 };

    async function sourced(
      kind: 'FORWARD' | 'COPY',
      buttons: { label: string; url: string }[] = [],
    ) {
      return broadcasts.create(tenantA, owner, {
        idempotencyKey: key(),
        title: kind,
        contentKind: kind,
        body: '',
        buttons,
        audience: { version: 1 },
        source: SOURCE,
      });
    }

    async function launchNow(id: string) {
      const record = await broadcasts.get(tenantA, owner, id);
      const preview = await broadcasts.preview(tenantA, owner, id);
      return broadcasts.launch(tenantA, owner, id, {
        idempotencyKey: key(),
        mode: 'NOW',
        scheduledAt: null,
        expectedVersion: record.version,
        expectedDefinitionHash: preview.definitionHash,
        expectedRecipients: preview.customers,
        expectedFingerprint: preview.fingerprint,
        typedCount: null,
      });
    }

    async function tester() {
      await fixtures.customer({ telegramUserId: '771500', botInstanceId: SEED_IDS.botA1 });
      return adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: 'tester-rnc',
          roleKeys: ['owner'],
          telegramUserId: '771500',
        }),
      );
    }

    it('a forward or copy names its source, is verified by the real preview, and stays send-once across a restart', async () => {
      await customers(3);
      // The shape: a FORWARD takes no buttons and no text; a composed kind takes no source.
      expect(await refusal(sourced('FORWARD', [{ label: 'x', url: 'https://example.test' }]))).toBe(
        BROADCAST_ERROR_CODES.SOURCE_CONTENT_INVALID,
      );
      expect(
        await refusal(
          broadcasts.create(tenantA, owner, {
            idempotencyKey: key(),
            title: 't',
            contentKind: 'TEXT',
            body: 'hi',
            buttons: [],
            audience: { version: 1 },
            source: SOURCE,
          }),
        ),
      ).toBe(BROADCAST_ERROR_CODES.SOURCE_REQUIRED);
      expect(
        await refusal(
          broadcasts.create(tenantA, owner, {
            idempotencyKey: key(),
            title: 'c',
            contentKind: 'COPY',
            body: '',
            buttons: [],
            audience: { version: 1 },
          }),
        ),
      ).toBe(BROADCAST_ERROR_CODES.SOURCE_REQUIRED);

      const copy = await sourced('COPY', [{ label: 'Open', url: 'https://example.test' }]);
      expect(copy.source).toEqual(SOURCE);
      expect(copy.sourceVerifiedAt).toBeNull();
      // Unverified: the Bot API cannot read a message by id, so nothing launches blind.
      expect(await refusal(launchNow(copy.id))).toBe(BROADCAST_ERROR_CODES.SOURCE_UNVERIFIED);

      const operator = await tester();
      expect(await broadcasts.test(tenantA, operator, copy.id)).toBe('SENT');
      expect(transport.requests[0]?.rendered).toMatchObject({
        contentKind: 'COPY',
        source: SOURCE,
      });
      const verified = await broadcasts.get(tenantA, owner, copy.id);
      expect(verified.sourceVerifiedAt).not.toBeNull();

      // A changed source is unverified again; the same source keeps its verification.
      const edited = await broadcasts.update(tenantA, owner, copy.id, {
        expectedVersion: verified.version,
        title: 'COPY',
        contentKind: 'COPY',
        body: '',
        buttons: [],
        audience: { version: 1 },
        source: { ...SOURCE, messageId: 43 },
      });
      expect(edited.sourceVerifiedAt).toBeNull();
      const same = await broadcasts.update(tenantA, owner, copy.id, {
        expectedVersion: edited.version,
        title: 'COPY again',
        contentKind: 'COPY',
        body: '',
        buttons: [],
        audience: { version: 1 },
        source: { ...SOURCE, messageId: 43 },
      });
      expect(same.sourceVerifiedAt).toBeNull();
      expect(await broadcasts.test(tenantA, operator, copy.id)).toBe('SENT');
      transport.requests.length = 0;
      transport.delivered.length = 0;

      // The operator's own customer is in the audience too: four recipients.
      await launchNow(copy.id);
      transport.crashOn = '771001';
      await dispatcher.pass(tenantA);
      expect([...transport.delivered].sort()).toEqual(['771000', '771001', '771002', '771500']);
      for (const request of transport.requests) {
        expect(request.rendered).toMatchObject({
          contentKind: 'COPY',
          source: { ...SOURCE, messageId: 43 },
        });
      }
      // A restarted worker: the stamped send is reaped UNCONFIRMED and never sent twice.
      transport.crashOn = null;
      await dispatcher.pass(tenantA);
      clock.advance(BROADCAST_LEASE_MS + 1);
      await dispatcher.pass(tenantA);
      expect(transport.delivered.filter((chat) => chat === '771001')).toHaveLength(1);
      const recipients = await broadcasts.recipients(tenantA, owner, copy.id, {
        state: null,
        limit: 10,
        after: null,
      });
      expect(recipients.map((r) => r.state).sort()).toEqual([
        'SENT',
        'SENT',
        'SENT',
        'UNCONFIRMED',
      ]);

      // FORWARD goes the same way, through `forwardMessage`.
      const forward = await sourced('FORWARD');
      expect(await broadcasts.test(tenantA, operator, forward.id)).toBe('SENT');
      expect(transport.requests.at(-1)?.rendered).toMatchObject({
        contentKind: 'FORWARD',
        source: SOURCE,
      });
    });

    it('a verification names the kind it was sent as and the draft that was tested', async () => {
      await customers(1);
      const operator = await tester();
      const copy = await sourced('COPY');
      expect(await broadcasts.test(tenantA, operator, copy.id)).toBe('SENT');
      const verified = await broadcasts.get(tenantA, owner, copy.id);
      expect(verified.sourceVerifiedAt).not.toBeNull();

      // The same source sent the other way is a different request to Telegram: unverified.
      const asForward = await broadcasts.update(tenantA, owner, copy.id, {
        expectedVersion: verified.version,
        title: 'FORWARD',
        contentKind: 'FORWARD',
        body: '',
        buttons: [],
        audience: { version: 1 },
        source: SOURCE,
      });
      expect(asForward.sourceVerifiedAt).toBeNull();

      // A test whose send is in flight while another operator edits the draft: the stamp
      // names the draft that was tested, and the edited one stays unverified.
      transport.beforeDeliver = async () => {
        await broadcasts.update(tenantA, owner, copy.id, {
          expectedVersion: asForward.version,
          title: 'FORWARD, edited',
          contentKind: 'FORWARD',
          body: '',
          buttons: [],
          audience: { version: 1 },
          source: { ...SOURCE, messageId: 43 },
        });
      };
      expect(await broadcasts.test(tenantA, operator, copy.id)).toBe('SENT');
      transport.beforeDeliver = null;
      const edited = await broadcasts.get(tenantA, owner, copy.id);
      expect(edited.source).toEqual({ ...SOURCE, messageId: 43 });
      expect(edited.sourceVerifiedAt).toBeNull();
      // Tested as it now stands: verified.
      expect(await broadcasts.test(tenantA, operator, copy.id)).toBe('SENT');
      expect((await broadcasts.get(tenantA, owner, copy.id)).sourceVerifiedAt).not.toBeNull();
    });

    it('records the pin apart from the send: delivered stays delivered whatever the pin did, and a pin is attempted once', async () => {
      await customers(3);
      const record = await broadcasts.create(tenantA, owner, {
        idempotencyKey: key(),
        title: 'pinned',
        contentKind: 'TEXT',
        body: 'سلام',
        buttons: [],
        audience: { version: 1 },
        pin: true,
      });
      expect(record.pin).toBe(true);
      await launchNow(record.id);
      transport.scriptPin('771001', { outcome: 'FAILED', errorCode: 'telegram.rejected.400' });
      transport.crashOnPin = '771002';
      const report = await dispatcher.pass(tenantA);
      expect(report).toMatchObject({ sent: 3, pinned: 1, pinFailed: 1 });
      const byChat = async () =>
        Object.fromEntries(
          (
            await rows<{
              chat_id: string;
              state: string;
              pin_state: string | null;
              pin_error_code: string | null;
            }>(
              sql`SELECT chat_id, state, pin_state, pin_error_code FROM broadcast_recipients
                   WHERE broadcast_id = ${record.id}::uuid`,
            )
          ).map((r) => [r.chat_id, [r.state, r.pin_state, r.pin_error_code]]),
        );
      expect(await byChat()).toEqual({
        '771000': ['SENT', 'PINNED', null],
        '771001': ['SENT', 'FAILED', 'telegram.rejected.400'],
        '771002': ['SENT', 'PENDING', null],
      });
      let counts = (await broadcasts.counts(tenantA, owner, [record.id])).get(record.id);
      expect(counts).toMatchObject({ sent: 3, pinned: 1, pinFailed: 1 });
      // Never a second attempt: not on the next pass, not after the lease, when the
      // stranded pin is resolved UNCONFIRMED exactly as a stranded send is.
      transport.crashOnPin = null;
      await dispatcher.pass(tenantA);
      clock.advance(BROADCAST_LEASE_MS + 1);
      await dispatcher.pass(tenantA);
      expect(transport.pinned.sort()).toEqual(['771000', '771001', '771002']);
      expect((await byChat())['771002']).toEqual([
        'SENT',
        'UNCONFIRMED',
        'broadcast.pin_interrupted',
      ]);
      counts = (await broadcasts.counts(tenantA, owner, [record.id])).get(record.id);
      expect(counts).toMatchObject({ sent: 3, pinned: 1, pinFailed: 2 });
      expect((await broadcasts.get(tenantA, owner, record.id)).state).toBe('COMPLETED');
      const page = await broadcasts.recipients(tenantA, owner, record.id, {
        state: null,
        limit: 10,
        after: null,
      });
      expect(page.map((r) => r.pinState).sort()).toEqual(['FAILED', 'PINNED', 'UNCONFIRMED']);
    });
  });
});
