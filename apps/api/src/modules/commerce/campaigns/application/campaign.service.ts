import {
  AUDIENCE_ERROR_CODES,
  BROADCAST_BODY_DEFINITION,
  BROADCAST_ERROR_CODES,
  BROADCAST_LARGE_AUDIENCE,
  BULK_ERROR_CODES,
  BULK_LARGE_OPERATION,
  CAMPAIGN_ERROR_CODES,
  CAMPAIGN_LAUNCHED_ACTION_KINDS,
  CAMPAIGN_PAGE_DEFAULT,
  CAMPAIGN_PAGE_MAX,
  COMMERCE_ERROR_CODES,
  errors,
  isNexaError,
  normaliseDiscountCode,
  uuidV7Schema,
  validateTemplateBody,
  type ActorContext,
  type AudiencePreview,
  type AuditWriter,
  type BroadcastCounts,
  type BulkGrant,
  type BulkCounts,
  type BulkPreview,
  type CampaignActionKind,
  type Clock,
  type CurrencyCode,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { BroadcastService } from '../../broadcasts/application/broadcast.service.js';
import type { BulkOperationService } from '../../bulk-operations/application/bulk-operation.service.js';
import {
  AUDIENCE_PREVIEW_PERMISSION,
  freezeAudience,
  toPreview,
  type AudienceService,
} from '../../audience/application/audience.service.js';
import {
  auditView as discountAuditView,
  DISCOUNT_EDIT_PERMISSION,
  type DiscountAdminService,
} from '../../pricing/application/discount-admin.service.js';
import {
  auditView as cashbackAuditView,
  CASHBACK_RULE_EDIT_PERMISSION,
  type CashbackRuleAdminService,
} from '../../pricing/application/cashback-rule-admin.service.js';
import type {
  CashbackRuleRepository,
  CashbackRuleWrite,
  DiscountRepository,
  DiscountRuleRecord,
  CashbackRuleRecord,
  DiscountRuleWrite,
} from '../../pricing/application/ports.js';
import type {
  AnnouncementAttribution,
  CampaignActionConfig,
  CampaignActionRecord,
  CampaignGiftConfig,
  CampaignLaunchBindingRecord,
  CampaignCalendar,
  CampaignCursor,
  CampaignDraftWrite,
  CampaignRecord,
  CampaignRepository,
  CashbackOutcome,
  DiscountOutcome,
} from './ports.js';

export const CAMPAIGN_VIEW_PERMISSION: PermissionKey = 'campaigns.view';
export const CAMPAIGN_MANAGE_PERMISSION: PermissionKey = 'campaigns.manage';

/**
 * The permission each action ALSO needs (`docs/round-n-campaigns-audit.md` D10): a
 * campaign is never a way to do what its operator could not do directly.
 */
export const CAMPAIGN_ACTION_PERMISSIONS: Readonly<
  Partial<Record<CampaignActionKind, PermissionKey>>
> = {
  DISCOUNT: DISCOUNT_EDIT_PERMISSION,
  CASHBACK: CASHBACK_RULE_EDIT_PERMISSION,
  // The shared engines' own keys (round N, B1/B2), charged again by those engines.
  WALLET_GIFT: 'users.wallet.mass',
  TRAFFIC_GIFT: 'services.mass.grant',
  TIME_GIFT: 'services.mass.grant',
  ANNOUNCEMENT: 'broadcasts.send',
};

/** The kinds handed to a shared engine to perform, rather than standing as a rule. */
const LAUNCHED_KINDS: ReadonlySet<CampaignActionKind> = new Set(CAMPAIGN_LAUNCHED_ACTION_KINDS);

/** A gift's binding as the confirmation sends it. */
export interface CampaignGiftBindingInput {
  readonly count: number;
  readonly fingerprint: string;
  readonly typedCount: number | null;
}

/** What an operator submits for a draft: the window in the tenant's own calendar. */
export interface CampaignDraftInput {
  readonly name: string;
  readonly description: string;
  readonly startDate: string;
  readonly startTime: string;
  readonly endDate: string;
  readonly endTime: string;
  readonly audience: unknown;
  readonly actions: readonly CampaignActionConfig[];
}

export interface CampaignDetail {
  readonly campaign: CampaignRecord;
  readonly actions: readonly CampaignActionRecord[];
  /** The live rows the campaign's rules are, read now — never a copy. */
  readonly discount: DiscountRuleRecord | null;
  readonly cashbackRule: CashbackRuleRecord | null;
  readonly presentation: { readonly timezone: string; readonly calendar: 'jalali' | 'gregorian' };
  /** The window as the tenant's own calendar and clock read it. */
  readonly startLocal: { readonly date: string; readonly time: string };
  readonly endLocal: { readonly date: string; readonly time: string };
}

/** One row of the campaign list. */
export interface CampaignListItem {
  readonly campaign: CampaignRecord;
  readonly actionKinds: readonly CampaignActionKind[];
  readonly startLocal: { readonly date: string; readonly time: string };
  readonly endLocal: { readonly date: string; readonly time: string };
}

/**
 * What a campaign produced, from persisted rows only (D9). There is no "revenue caused"
 * field and no conversion rate: nothing persists that a purchase was CAUSED by a campaign.
 */
export interface CampaignResults {
  /** The audience count the operator confirmed; null before the confirmation. */
  readonly targeted: number | null;
  readonly discount: DiscountOutcome | null;
  readonly cashback: CashbackOutcome | null;
  /** The engines' own records, read through — never a copy the campaign keeps. */
  readonly announcement: BroadcastCounts | null;
  readonly walletGift: CampaignGiftOutcome | null;
  readonly trafficGift: CampaignGiftOutcome | null;
  readonly timeGift: CampaignGiftOutcome | null;
  /**
   * Roadmap C3: the discount's PAID redeemers against the announcement's frozen recipients.
   * Null unless the campaign has both, and the announcement has been launched.
   */
  readonly audienceAttribution: AnnouncementAttribution | null;
}

/** A gift's own engine counts, read through, and what the ledger holds for a wallet gift. */
export interface CampaignGiftOutcome {
  readonly counts: BulkCounts;
  readonly credited: { readonly amountMinor: bigint; readonly currency: CurrencyCode } | null;
}

/** What a confirmation binds to, and the liability that is determinable before it. */
export interface CampaignPreview {
  readonly audience: AudiencePreview;
  readonly discountMaxLiability: {
    readonly amountMinor: bigint;
    readonly currency: CurrencyCode;
  } | null;
  /** Each gift's own preview, from the mass-action engine: count, set and liability. */
  readonly gifts: Partial<Record<'WALLET_GIFT' | 'TRAFFIC_GIFT' | 'TIME_GIFT', BulkPreview>>;
  /** Which counts the confirmation must type back. */
  readonly typedCountRequired: {
    readonly audience: boolean;
    readonly walletGift: boolean;
    readonly trafficGift: boolean;
    readonly timeGift: boolean;
  };
}

export interface CampaignServiceDeps {
  readonly campaigns: CampaignRepository;
  readonly discounts: Pick<DiscountRepository, 'create' | 'setStatus' | 'findById' | 'findByCode'>;
  readonly cashbackRules: Pick<CashbackRuleRepository, 'create' | 'setStatus' | 'findById'>;
  readonly discountAdmin: Pick<DiscountAdminService, 'assertReferences'>;
  readonly cashbackAdmin: Pick<CashbackRuleAdminService, 'assertReferences'>;
  readonly calendar: CampaignCalendar;
  /** The SHARED audience engine (round N, B1): the same query Broadcast and the mass actions use. */
  readonly audience: Pick<AudienceService, 'evaluate' | 'sampleOf' | 'freeze' | 'releaseFrozen'>;
  /** The SHARED mass-action engine (round N, B2): wallet, traffic and time gifts. */
  readonly massActions: Pick<
    BulkOperationService,
    | 'preview'
    | 'create'
    | 'cancel'
    | 'pause'
    | 'resume'
    | 'get'
    | 'progress'
    | 'freezeServiceAudience'
  >;
  /** The SHARED Broadcast lane (round N, B1): the announcement. */
  readonly broadcasts: Pick<
    BroadcastService,
    'create' | 'launch' | 'pause' | 'resume' | 'cancel' | 'get' | 'counts'
  >;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * Campaigns, as an operator manages them (`docs/round-n-campaigns-audit.md`).
 *
 * A composition: the discount and cashback actions are rules in the pricing module's own
 * tables, created in the confirming transaction with the CAMPAIGN'S window as their own
 * window, so the one pricing boundary decides when they apply — even if the worker that
 * marks the campaign ACTIVE and COMPLETED is late or down. Pausing and cancelling withdraw
 * the rules through the same conditional status update the discounts page uses; what
 * that does to an order is the engine's existing rule (a draft is refused with
 * `DISCOUNT_NO_LONGER_VALID`, a confirmed order keeps its price, a cashback promise stays).
 *
 * The seven-step write path every admin service here runs: authorize before the replay,
 * the replay, then one transaction that re-authorizes, reads scope activity, locks,
 * validates against the tenant's own rows, writes, audits and remembers the key.
 */
export class CampaignService {
  constructor(private readonly deps: CampaignServiceDeps) {}

  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: {
      readonly limit?: number;
      readonly cursor?: CampaignCursor;
      readonly state?: CampaignRecord['state'];
    },
  ): Promise<{
    readonly items: readonly CampaignListItem[];
    readonly nextCursor: CampaignCursor | null;
    readonly presentation: CampaignDetail['presentation'];
  }> {
    await this.deps.guard.check(scope, actor, CAMPAIGN_VIEW_PERMISSION);
    const limit = Math.min(Math.max(query.limit ?? CAMPAIGN_PAGE_DEFAULT, 1), CAMPAIGN_PAGE_MAX);
    const page = await this.deps.campaigns.list(
      scope,
      query.state === undefined ? {} : { state: query.state },
      limit,
      query.cursor ?? null,
    );
    const presentation = await this.deps.calendar.presentationFor(scope);
    const items: CampaignListItem[] = [];
    for (const campaign of page.items) {
      const actions = await this.deps.campaigns.actionsOf(scope, campaign.id);
      items.push({
        campaign,
        actionKinds: actions.map((a) => a.kind),
        startLocal: this.deps.calendar.localOf(campaign.startsAt, presentation),
        endLocal: this.deps.calendar.localOf(campaign.endsAt, presentation),
      });
    }
    return { items, nextCursor: page.nextCursor, presentation };
  }

  async get(scope: TenantContext, actor: ActorContext, id: string): Promise<CampaignDetail> {
    await this.deps.guard.check(scope, actor, CAMPAIGN_VIEW_PERMISSION);
    return this.detailOf(scope, this.campaignId(id));
  }

  /** The persisted outcome of every linked rule. A read; writes nothing. */
  async results(scope: TenantContext, actor: ActorContext, id: string): Promise<CampaignResults> {
    await this.deps.guard.check(scope, actor, CAMPAIGN_VIEW_PERMISSION);
    const campaignId = this.campaignId(id);
    const campaign = await this.deps.campaigns.findById(scope, campaignId);
    if (campaign === null) throw notFound();
    const actions = await this.deps.campaigns.actionsOf(scope, campaignId);
    const discountId = actions.find((a) => a.kind === 'DISCOUNT')?.discountId ?? null;
    const cashbackRuleId = actions.find((a) => a.kind === 'CASHBACK')?.cashbackRuleId ?? null;
    const bulkOf = async (kind: CampaignActionKind): Promise<CampaignGiftOutcome | null> => {
      const operationId = actions.find((a) => a.kind === kind)?.bulkOperationId ?? null;
      if (operationId === null) return null;
      const read = await readableOrNull(
        Promise.all([
          this.deps.massActions.get(scope, actor, operationId),
          this.deps.massActions.progress(scope, actor, [operationId]),
        ]),
      );
      if (read === null) return null;
      const [operation, progress] = read;
      const counts = progress.counts.get(operationId);
      if (counts === undefined) return null;
      return {
        counts,
        credited:
          operation.currency === null
            ? null
            : {
                amountMinor: progress.credited.get(operationId) ?? 0n,
                currency: operation.currency,
              },
      };
    };
    const broadcastId = actions.find((a) => a.kind === 'ANNOUNCEMENT')?.broadcastId ?? null;
    return {
      targeted: campaign.audienceConfirmedCount,
      discount:
        discountId === null ? null : await this.deps.campaigns.discountOutcome(scope, discountId),
      cashback:
        cashbackRuleId === null
          ? null
          : await this.deps.campaigns.cashbackOutcome(scope, cashbackRuleId),
      announcement:
        broadcastId === null
          ? null
          : ((await readableOrNull(this.deps.broadcasts.counts(scope, actor, [broadcastId])))?.get(
              broadcastId,
            ) ?? null),
      walletGift: await bulkOf('WALLET_GIFT'),
      trafficGift: await bulkOf('TRAFFIC_GIFT'),
      timeGift: await bulkOf('TIME_GIFT'),
      audienceAttribution:
        broadcastId === null || discountId === null
          ? null
          : await this.deps.campaigns.announcementAttribution(scope, { broadcastId, discountId }),
    };
  }

  /**
   * The preview a confirmation binds to (D7). A read: writes nothing and holds no lock.
   *
   * The audience is the SHARED engine's own evaluation of the stored definition — the same
   * count, set fingerprint and sample Broadcast shows — so `schedule` can refuse a
   * confirmation for a set that has since changed. A sample names customers, so the preview
   * also charges the audience engine's own read key.
   *
   * Liability is reported only where it is determinable: a FIXED_AMOUNT discount with a total
   * limit can take off at most `value × limit`; a percentage discount and a cashback rule
   * depend on orders nobody has placed, and say so (null) rather than invent a figure.
   */
  async preview(scope: TenantContext, actor: ActorContext, id: string): Promise<CampaignPreview> {
    await this.deps.guard.check(scope, actor, CAMPAIGN_VIEW_PERMISSION);
    await this.deps.guard.check(scope, actor, AUDIENCE_PREVIEW_PERMISSION);
    const campaignId = this.campaignId(id);
    const campaign = await this.deps.campaigns.findById(scope, campaignId);
    if (campaign === null) throw notFound();
    const actions = await this.deps.campaigns.actionsOf(scope, campaignId);
    const evaluation = await this.deps.audience.evaluate(scope, campaign.audience);
    const sample = await this.deps.audience.sampleOf(
      scope,
      evaluation.audience.definition,
      evaluation.asOf,
    );
    const discount = actions.find((a) => a.config.kind === 'DISCOUNT')?.config;
    const gifts: Partial<Record<'WALLET_GIFT' | 'TRAFFIC_GIFT' | 'TIME_GIFT', BulkPreview>> = {};
    for (const action of actions) {
      const config = action.config;
      if (
        config.kind === 'WALLET_GIFT' ||
        config.kind === 'TRAFFIC_GIFT' ||
        config.kind === 'TIME_GIFT'
      ) {
        gifts[config.kind] = await this.deps.massActions.preview(scope, actor, {
          grant: grantOf(config),
          definition: campaign.audience,
        });
      }
    }
    const has = (kind: CampaignActionKind) => actions.some((a) => a.kind === kind);
    return {
      gifts,
      typedCountRequired: {
        audience:
          has('ANNOUNCEMENT') && typedCountRequiredFor('ANNOUNCEMENT', evaluation.customers),
        walletGift: gifts.WALLET_GIFT !== undefined,
        trafficGift:
          gifts.TRAFFIC_GIFT !== undefined &&
          typedCountRequiredFor('TRAFFIC_GIFT', gifts.TRAFFIC_GIFT.count),
        timeGift:
          gifts.TIME_GIFT !== undefined &&
          typedCountRequiredFor('TIME_GIFT', gifts.TIME_GIFT.count),
      },
      audience: toPreview(evaluation, sample),
      discountMaxLiability:
        discount?.kind === 'DISCOUNT' &&
        discount.terms.type === 'FIXED_AMOUNT' &&
        discount.terms.totalLimit !== null &&
        discount.terms.currency !== null
          ? {
              amountMinor: discount.terms.value * BigInt(discount.terms.totalLimit),
              currency: discount.terms.currency,
            }
          : null,
    };
  }

  /** Creates a DRAFT. Idempotent, audited. Nothing is priced, sent or credited by a draft. */
  async createDraft(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly draft: CampaignDraftInput },
  ): Promise<CampaignDetail> {
    const requestHash = hashRequest({ draft: serialisableDraft(input.draft) });
    const denial = { action: 'campaign.create', entityType: 'Campaign', entityId: null };
    await this.authorize(scope, actor, denial);

    const replay = await this.deps.idempotency.find<{ campaignId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return this.detailOf(scope, replay.result.campaignId);

    const presentation = await this.deps.calendar.presentationFor(scope);
    const write = this.resolveDraft(input.draft, presentation);
    const now = this.deps.clock.now();
    const id = this.deps.ids.uuid();

    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CAMPAIGN_MANAGE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        // A draft may only hold what its author may do: refused now, not at the schedule.
        await this.checkActionPermissions(scope, actor, write.actions, tx);
        await this.assertActionReferences(scope, write.actions, tx);
        const row = await this.deps.campaigns.insertDraft(
          scope,
          {
            id,
            write,
            actionIds: write.actions.map(() => this.deps.ids.uuid()),
            createdByAdminId: adminIdOf(actor),
            now,
          },
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'campaign.create',
            entityType: 'Campaign',
            entityId: row.id,
            before: null,
            after: campaignAuditView(row, write.actions),
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          'WEB',
          input.idempotencyKey,
          requestHash,
          { campaignId: row.id },
          tx,
        );
      },
    );
    return this.detailOf(scope, id);
  }

  /** Replaces a DRAFT's fields and actions. Anything past DRAFT is `CAMPAIGN_NOT_EDITABLE`. */
  async updateDraft(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly campaignId: string;
      readonly draft: CampaignDraftInput;
    },
  ): Promise<CampaignDetail> {
    const campaignId = this.campaignId(input.campaignId);
    const requestHash = hashRequest({ campaignId, draft: serialisableDraft(input.draft) });
    const denial = { action: 'campaign.update', entityType: 'Campaign', entityId: campaignId };
    await this.authorize(scope, actor, denial);

    const replay = await this.deps.idempotency.find<{ campaignId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return this.detailOf(scope, campaignId);

    const presentation = await this.deps.calendar.presentationFor(scope);
    const write = this.resolveDraft(input.draft, presentation);
    const now = this.deps.clock.now();

    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CAMPAIGN_MANAGE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.deps.campaigns.lockById(scope, campaignId, tx);
        if (before === null) throw notFound();
        if (before.state !== 'DRAFT') throw notEditable();
        const beforeActions = await this.deps.campaigns.actionsOf(scope, campaignId, tx);
        await this.checkActionPermissions(scope, actor, write.actions, tx);
        await this.assertActionReferences(scope, write.actions, tx);
        const replaced = await this.deps.campaigns.replaceDraft(
          scope,
          { id: campaignId, write, actionIds: write.actions.map(() => this.deps.ids.uuid()), now },
          tx,
        );
        if (!replaced) throw notEditable();
        const after = await this.deps.campaigns.findById(scope, campaignId, tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'campaign.update',
            entityType: 'Campaign',
            entityId: campaignId,
            before: campaignAuditView(
              before,
              beforeActions.map((a) => a.config),
            ),
            after: campaignAuditView(after ?? before, write.actions),
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          'WEB',
          input.idempotencyKey,
          requestHash,
          { campaignId },
          tx,
        );
      },
    );
    return this.detailOf(scope, campaignId);
  }

  /**
   * DRAFT → SCHEDULED: the operator's confirmation after the preview.
   *
   * In ONE transaction, under the campaign's lock: freeze the audience with the count the
   * operator confirmed, and create every standing rule — ACTIVE, with the campaign's window
   * as its own — in the pricing module's tables. Either all of it commits or none of it
   * does, so a scheduled campaign always has its rules and a rule never outlives a failed
   * confirmation.
   */
  async schedule(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly campaignId: string;
      /** What the operator's preview showed: the definition, the count and the SET. */
      readonly expectedDefinitionHash: string;
      readonly expectedRecipients: number;
      readonly expectedFingerprint: string;
      /** The audience count typed back, where the announcement's size asks for it. */
      readonly typedCount?: number | null;
      /** Each gift's own binding, from its engine's preview. A wallet gift adds its total. */
      readonly walletGift?: (CampaignGiftBindingInput & { readonly totalMinor: string }) | null;
      readonly trafficGift?: CampaignGiftBindingInput | null;
      readonly timeGift?: CampaignGiftBindingInput | null;
    },
  ): Promise<CampaignDetail> {
    const campaignId = this.campaignId(input.campaignId);
    const requestHash = hashRequest({
      campaignId,
      expectedDefinitionHash: input.expectedDefinitionHash,
      expectedRecipients: input.expectedRecipients,
      expectedFingerprint: input.expectedFingerprint,
      typedCount: input.typedCount ?? null,
      walletGift: input.walletGift ?? null,
      trafficGift: input.trafficGift ?? null,
      timeGift: input.timeGift ?? null,
    });
    const denial = { action: 'campaign.schedule', entityType: 'Campaign', entityId: campaignId };
    await this.authorize(scope, actor, denial);

    const replay = await this.deps.idempotency.find<{ campaignId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      // A replay also finishes a hand-over the first attempt could not (same keys, same
      // bindings: an engine that already took it replays rather than doing it twice).
      await this.launchPending(scope, actor, campaignId);
      return this.detailOf(scope, campaignId);
    }

    // Each gift's binding is checked against its engine's own preview BEFORE anything is
    // written, so a stale gift preview refuses the whole confirmation rather than leaving a
    // scheduled campaign whose gift failed. The engine checks the same binding again when
    // it takes the work.
    const draft = await this.deps.campaigns.findById(scope, campaignId);
    if (draft === null) throw notFound();
    const draftActions = await this.deps.campaigns.actionsOf(scope, campaignId);
    const bindings = await this.verifiedGiftBindings(scope, actor, draft, draftActions, input);

    const now = this.deps.clock.now();

    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CAMPAIGN_MANAGE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const campaign = await this.deps.campaigns.lockById(scope, campaignId, tx);
        if (campaign === null) throw notFound();
        if (campaign.state !== 'DRAFT') throw transitionInvalid();
        if (campaign.updatedAt.getTime() !== draft.updatedAt.getTime()) {
          // Edited between the gift check above and this lock: preview again.
          throw errors.conflict(
            AUDIENCE_ERROR_CODES.CHANGED,
            'The campaign changed since the preview. Preview again before confirming.',
          );
        }
        if (campaign.endsAt.getTime() <= now.getTime()) {
          throw errors.validation(
            CAMPAIGN_ERROR_CODES.CAMPAIGN_WINDOW_INVALID,
            'The campaign window is already over.',
          );
        }
        const actions = await this.deps.campaigns.actionsOf(scope, campaignId, tx);
        if (actions.length === 0) {
          throw errors.validation(
            CAMPAIGN_ERROR_CODES.CAMPAIGN_NO_ACTION,
            'A campaign needs at least one action before it is scheduled.',
          );
        }
        // Roadmap C4: a draft saved by the release before this rule is refused here too.
        assertAnnouncementPurpose(actions.map((a) => a.config));
        await this.checkActionPermissions(scope, actor, actions, tx);
        await this.assertActionReferences(
          scope,
          actions.map((a) => a.config),
          tx,
        );
        if (
          actions.some((a) => LAUNCHED_KINDS.has(a.kind)) &&
          campaign.startsAt.getTime() > now.getTime() + LAUNCH_MAX_LEAD_MS
        ) {
          // Broadcast and the mass-action engine each take work at most sixty days ahead.
          throw errors.validation(
            CAMPAIGN_ERROR_CODES.CAMPAIGN_WINDOW_INVALID,
            'A campaign with a gift or an announcement starts within sixty days.',
          );
        }

        // The confirmation binds to what the preview showed: the definition, the count and
        // the fingerprint of the set, re-evaluated here, inside this transaction, by the
        // shared engine (the audience engine's own `audience.changed` when any differs).
        const audience = await this.deps.audience.evaluate(scope, campaign.audience, now, tx);
        if (
          audience.audience.hash !== input.expectedDefinitionHash ||
          audience.customers !== input.expectedRecipients ||
          audience.fingerprint !== input.expectedFingerprint
        ) {
          throw errors.conflict(
            AUDIENCE_ERROR_CODES.CHANGED,
            'The audience changed since the preview. Preview again before confirming.',
            { previewed: input.expectedRecipients, now: audience.customers },
          );
        }
        const audienceCount = audience.customers;

        /*
         * Round N close (§A): the CUSTOMERS confirmed are frozen here, in this transaction,
         * by the same query at the same instant the comparison above read — so the rows
         * written are the set confirmed, and the engines are later seeded from them rather
         * than from a live re-selection. Frozen once, shared by the announcement and the
         * wallet gift; a service gift freezes its own SERVICES set below, through the engine
         * that owns the eligibility rule.
         */
        let frozenCustomers: { readonly id: string } | null = null;
        const frozenCustomersId = async () => {
          if (frozenCustomers === null) {
            const frozen = await this.deps.audience.freeze(
              scope,
              campaign.audience,
              now,
              adminIdOf(actor),
              tx,
            );
            if (frozen.count !== audienceCount || frozen.fingerprint !== audience.fingerprint) {
              throw errors.conflict(
                AUDIENCE_ERROR_CODES.CHANGED,
                'The audience changed while it was being confirmed. Preview again.',
              );
            }
            frozenCustomers = frozen;
          }
          return frozenCustomers.id;
        };

        for (const action of actions) {
          if (LAUNCHED_KINDS.has(action.kind)) {
            const binding =
              action.kind === 'ANNOUNCEMENT'
                ? this.announcementBinding(audience, input.typedCount ?? null)
                : bindings.get(action.kind);
            if (binding === undefined) throw bindingInvalid(action.kind);
            const frozenAudienceId =
              action.kind === 'TRAFFIC_GIFT' || action.kind === 'TIME_GIFT'
                ? await this.freezeGiftServices(scope, actor, campaign, action, binding, now, tx)
                : await frozenCustomersId();
            await this.deps.campaigns.bindAction(
              scope,
              { actionId: action.id, binding, frozenAudienceId },
              tx,
            );
            continue;
          }
          await this.createStandingRule(scope, actor, campaign, action, now, tx);
        }

        const moved = await this.deps.campaigns.schedule(
          scope,
          {
            id: campaignId,
            adminId: adminIdOf(actor),
            confirmedCount: audienceCount,
            fingerprint: audience.fingerprint,
            now,
          },
          tx,
        );
        if (!moved) throw transitionInvalid();

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'campaign.schedule',
            entityType: 'Campaign',
            entityId: campaignId,
            before: { state: campaign.state },
            after: {
              state: 'SCHEDULED',
              startsAt: campaign.startsAt.toISOString(),
              endsAt: campaign.endsAt.toISOString(),
              audienceConfirmedCount: audienceCount,
              actions: actions.map((a) => a.kind),
            },
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          'WEB',
          input.idempotencyKey,
          requestHash,
          { campaignId },
          tx,
        );
      },
    );
    // AFTER the commit, never inside it: each engine runs its own transaction, and a
    // campaign must never hold its lock across another module's work.
    await this.launchPending(scope, actor, campaignId);
    return this.detailOf(scope, campaignId);
  }

  /**
   * Hands every confirmed-but-not-yet-launched action to its engine, under the operator's
   * own actor, with a key derived from the campaign and the action and the binding frozen by
   * the schedule. An engine that already took the work replays; one that refuses on the
   * merits leaves the action FAILED with its code; anything else (the database, a crash)
   * leaves it PENDING for the next attempt — never a guess either way.
   *
   * Callable again (`CAMPAIGN_ROUTES.launch`) while the campaign is SCHEDULED, ACTIVE or
   * PAUSED; a no-op for anything already launched.
   */
  async launchPending(
    scope: TenantContext,
    actor: ActorContext,
    campaignId: string,
  ): Promise<CampaignDetail> {
    await this.deps.guard.check(scope, actor, CAMPAIGN_MANAGE_PERMISSION);
    const id = this.campaignId(campaignId);
    const campaign = await this.deps.campaigns.findById(scope, id);
    if (campaign === null) throw notFound();
    if (!['SCHEDULED', 'ACTIVE', 'PAUSED'].includes(campaign.state))
      return this.detailOf(scope, id);
    const actions = await this.deps.campaigns.actionsOf(scope, id);
    for (const action of actions) {
      if (!LAUNCHED_KINDS.has(action.kind) || action.binding === null) continue;
      if (action.state !== 'PENDING' && action.state !== 'FAILED') continue;
      let launched: { broadcastId?: string; bulkOperationId?: string };
      try {
        launched = await this.handOver(scope, actor, campaign, action, action.binding);
      } catch (error) {
        if (!isNexaError(error) || !REFUSAL_KINDS.has(error.kind)) throw error;
        await this.recordHandOver(scope, actor, action, { failedCode: error.code });
        continue;
      }
      await this.recordHandOver(scope, actor, action, { launched });
      await this.reconcile(scope, actor, action, launched);
    }
    return this.detailOf(scope, id);
  }

  /**
   * Records what an engine answered, with its audit row, in one transaction. True when the
   * action moved. Not gated on scope activity: it records work the engine already accepted
   * or refused, and the engine itself decided that under its own activity check.
   */
  private async recordHandOver(
    scope: TenantContext,
    actor: ActorContext,
    action: CampaignActionRecord,
    outcome:
      | { readonly launched: { broadcastId?: string; bulkOperationId?: string } }
      | { readonly failedCode: string },
  ): Promise<boolean> {
    return this.deps.uow.run(scope, async (tx) => {
      const now = this.deps.clock.now();
      const moved =
        'launched' in outcome
          ? await this.deps.campaigns.linkEngine(
              scope,
              { actionId: action.id, ...outcome.launched, now },
              tx,
            )
          : await this.deps.campaigns.failAction(
              scope,
              { actionId: action.id, code: outcome.failedCode, now },
              tx,
            );
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'launched' in outcome ? 'campaign.action_launched' : 'campaign.action_failed',
          entityType: 'Campaign',
          entityId: action.campaignId,
          before: { kind: action.kind, state: action.state },
          after:
            'launched' in outcome
              ? { kind: action.kind, moved, ...outcome.launched }
              : { kind: action.kind, moved, code: outcome.failedCode },
          result: 'SUCCESS',
        },
        tx,
      );
      return moved;
    });
  }

  /**
   * The engine record was made AFTER the campaign's own edges looked for one. A cancel or a
   * pause that committed before the link found no engine record to stop, and the engine has
   * just made one — RUNNING, or SENDING — under a campaign that is no longer running. The
   * campaign is read again only now, after the link committed, so every edge that commits
   * from here on sees the link and propagates itself; and every edge that committed before
   * is seen here. An action CANCELLED meanwhile stops its engine — before the start a cancel
   * credits, grants and sends nothing; a campaign PAUSED meanwhile pauses it, exactly as
   * `pause` would have (a RUNNING operation, a SENDING broadcast). An action LAUNCHED by a
   * concurrent hand-over, or a campaign still running, needs nothing.
   */
  private async reconcile(
    scope: TenantContext,
    actor: ActorContext,
    action: CampaignActionRecord,
    launched: { broadcastId?: string; bulkOperationId?: string },
  ): Promise<void> {
    const campaign = await this.deps.campaigns.findById(scope, action.campaignId);
    const current = (await this.deps.campaigns.actionsOf(scope, action.campaignId)).find(
      (a) => a.id === action.id,
    );
    if (current?.state === 'CANCELLED') {
      if (launched.bulkOperationId !== undefined) {
        await ignoringStateConflict(
          this.deps.massActions.cancel(scope, actor, launched.bulkOperationId),
        );
      }
      if (launched.broadcastId !== undefined) {
        await ignoringStateConflict(
          this.deps.broadcasts.cancel(scope, actor, launched.broadcastId),
        );
      }
      return;
    }
    if (campaign?.state !== 'PAUSED' || current === undefined) return;
    await this.forEachBroadcast(scope, actor, [current], 'SENDING', 'pause');
    await this.forEachBulkOperation(scope, actor, [current], 'RUNNING', 'pause');
  }

  /** One action to its engine. Returns the engine record's id. */
  private async handOver(
    scope: TenantContext,
    actor: ActorContext,
    campaign: CampaignRecord,
    action: CampaignActionRecord,
    binding: CampaignLaunchBindingRecord,
  ): Promise<{ broadcastId?: string; bulkOperationId?: string }> {
    const config = action.config;
    const key = `campaign:${campaign.id}:${action.kind.toLowerCase()}`;
    /*
     * Round N close (§A): every engine record is seeded from the frozen audience bound at
     * the confirmation, so a retry finds the same members however the live audience moved.
     * An action confirmed by the release before this one carries no frozen id and keeps
     * its old path (a live evaluation the engine compares with the binding).
     */
    const frozenAudienceId = action.frozenAudienceId;
    if (config.kind === 'ANNOUNCEMENT') {
      const draft = await this.deps.broadcasts.create(scope, actor, {
        idempotencyKey: key,
        title: campaign.name,
        contentKind: 'TEXT',
        body: config.terms.body,
        buttons: config.terms.buttons,
        audience: campaign.audience,
        // Roadmap C4: a campaign is promotional; the opt-out decides at the send.
        purpose: 'MARKETING',
        frozenAudienceId,
      });
      // A retry after a launch that committed: the broadcast is already past DRAFT.
      if (draft.state !== 'DRAFT') return { broadcastId: draft.id };
      // Broadcast schedules at least a minute ahead; a start nearer than that sends now.
      const later =
        campaign.startsAt.getTime() >= this.deps.clock.now().getTime() + ANNOUNCEMENT_MIN_LEAD_MS;
      await this.deps.broadcasts.launch(scope, actor, draft.id, {
        idempotencyKey: `${key}:launch`,
        mode: later ? 'SCHEDULE' : 'NOW',
        scheduledAt: later ? campaign.startsAt : null,
        expectedVersion: draft.version,
        expectedDefinitionHash: campaign.audienceHash,
        expectedRecipients: binding.count,
        expectedFingerprint: binding.fingerprint,
        typedCount: binding.typedCount,
      });
      return { broadcastId: draft.id };
    }
    if (config.kind === 'CASHBACK' || config.kind === 'DISCOUNT') return {};
    const created = await this.deps.massActions.create(scope, actor, {
      idempotencyKey: key,
      grant: grantOf(config),
      definition: campaign.audience,
      notify: config.terms.notify,
      note: campaign.name,
      expectedDefinitionHash: campaign.audienceHash,
      expectedCount: binding.count,
      expectedFingerprint: binding.fingerprint,
      expectedTotalMinor: binding.totalMinor,
      typedCount: binding.typedCount,
      // Frozen and confirmed now; processed from the campaign's start (never before).
      notBefore: campaign.startsAt,
      frozenAudienceId,
    });
    return { bulkOperationId: created.id };
  }

  /**
   * Round N close (§A): a traffic or time gift's SERVICES, frozen in the confirming
   * transaction by the mass-action engine's own eligibility query, and compared with the
   * binding its preview produced — a service that became eligible or ineligible since the
   * preview refuses the confirmation, exactly as a customer would.
   */
  private async freezeGiftServices(
    scope: TenantContext,
    actor: ActorContext,
    campaign: CampaignRecord,
    action: CampaignActionRecord,
    binding: CampaignLaunchBindingRecord,
    now: Date,
    tx: TransactionScope,
  ): Promise<string> {
    const config = action.config;
    if (config.kind !== 'TRAFFIC_GIFT' && config.kind !== 'TIME_GIFT')
      throw bindingInvalid(action.kind);
    const frozen = await this.deps.massActions.freezeServiceAudience(
      scope,
      actor,
      { grant: grantOf(config), definition: campaign.audience, asOf: now },
      tx,
    );
    if (frozen.count !== binding.count || frozen.fingerprint !== binding.fingerprint) {
      throw errors.conflict(
        AUDIENCE_ERROR_CODES.CHANGED,
        'What this gift reaches changed since the preview. Preview again before confirming.',
        { kind: config.kind, previewed: binding.count, now: frozen.count },
      );
    }
    return frozen.id;
  }

  /**
   * Round N close (§A): the release sweep for frozen audiences nothing live names any more.
   * Run by the campaign lane under `maintenance.run`; the audience engine decides which.
   */
  async releaseFrozenAudiences(scope: TenantContext, actor: ActorContext): Promise<number> {
    return this.deps.uow.run(scope, async (tx) => {
      await this.deps.guard.check(scope, actor, 'maintenance.run', tx);
      return this.deps.audience.releaseFrozen(scope, this.deps.clock.now(), tx);
    });
  }

  /**
   * Each gift's binding, checked against its engine's own preview of the stored definition.
   * The count must be typed back where the engine asks for it: a wallet credit always, a
   * grant from `BULK_LARGE_OPERATION` services.
   */
  private async verifiedGiftBindings(
    scope: TenantContext,
    actor: ActorContext,
    campaign: CampaignRecord,
    actions: readonly CampaignActionRecord[],
    input: {
      readonly walletGift?: (CampaignGiftBindingInput & { readonly totalMinor: string }) | null;
      readonly trafficGift?: CampaignGiftBindingInput | null;
      readonly timeGift?: CampaignGiftBindingInput | null;
    },
  ): Promise<Map<CampaignActionKind, CampaignLaunchBindingRecord>> {
    const out = new Map<CampaignActionKind, CampaignLaunchBindingRecord>();
    for (const action of actions) {
      const config = action.config;
      if (
        config.kind !== 'WALLET_GIFT' &&
        config.kind !== 'TRAFFIC_GIFT' &&
        config.kind !== 'TIME_GIFT'
      ) {
        continue;
      }
      const given =
        config.kind === 'WALLET_GIFT'
          ? input.walletGift
          : config.kind === 'TRAFFIC_GIFT'
            ? input.trafficGift
            : input.timeGift;
      if (given === null || given === undefined) throw bindingInvalid(config.kind);
      const preview = await this.deps.massActions.preview(scope, actor, {
        grant: grantOf(config),
        definition: campaign.audience,
      });
      const totalMinor =
        config.kind === 'WALLET_GIFT' ? (preview.totalLiability?.amountMinor ?? null) : null;
      if (
        preview.count !== given.count ||
        preview.fingerprint !== given.fingerprint ||
        (config.kind === 'WALLET_GIFT' && (input.walletGift?.totalMinor ?? null) !== totalMinor)
      ) {
        throw errors.conflict(
          AUDIENCE_ERROR_CODES.CHANGED,
          'What this gift reaches changed since the preview. Preview again before confirming.',
          { kind: config.kind, previewed: given.count, now: preview.count },
        );
      }
      if (preview.count === 0) {
        throw errors.validation(AUDIENCE_ERROR_CODES.EMPTY, 'This gift reaches nobody.', {
          kind: config.kind,
        });
      }
      if (typedCountRequiredFor(config.kind, preview.count) && given.typedCount !== preview.count) {
        throw errors.validation(
          CAMPAIGN_ERROR_CODES.CAMPAIGN_CONFIRMATION_REQUIRED,
          'Type the number of items this gift reaches to confirm it.',
          { kind: config.kind },
        );
      }
      out.set(config.kind, {
        count: preview.count,
        fingerprint: preview.fingerprint,
        typedCount: given.typedCount,
        totalMinor,
      });
    }
    return out;
  }

  /** The announcement's binding is the campaign audience's own, confirmed above. */
  private announcementBinding(
    audience: { readonly customers: number; readonly fingerprint: string },
    typedCount: number | null,
  ): CampaignLaunchBindingRecord {
    if (audience.customers === 0) {
      throw errors.validation(AUDIENCE_ERROR_CODES.EMPTY, 'The announcement reaches nobody.');
    }
    if (
      typedCountRequiredFor('ANNOUNCEMENT', audience.customers) &&
      typedCount !== audience.customers
    ) {
      throw errors.validation(
        CAMPAIGN_ERROR_CODES.CAMPAIGN_CONFIRMATION_REQUIRED,
        'Type the number of recipients to confirm the announcement.',
        { kind: 'ANNOUNCEMENT' },
      );
    }
    return {
      count: audience.customers,
      fingerprint: audience.fingerprint,
      typedCount,
      totalMinor: null,
    };
  }

  /** ACTIVE → PAUSED: withdraws the standing rules until resumed. */
  async pause(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly campaignId: string },
  ): Promise<CampaignDetail> {
    return this.operatorEdge(
      scope,
      actor,
      input,
      'campaign.pause',
      async (campaign, actions, now, tx) => {
        if (!(await this.deps.campaigns.pause(scope, campaign.id, now, tx))) {
          throw transitionInvalid();
        }
        return this.setRules(scope, actor, actions, 'INACTIVE', now, tx);
      },
      // The announcement pauses with it where Broadcast can (a SENDING broadcast), and each
      // gift where its engine can (a RUNNING operation): no new item is claimed until the
      // resume; an item already PLANNED on a panel still reaches its own end (round N close §B).
      async (actions) => {
        await this.forEachBroadcast(scope, actor, actions, 'SENDING', 'pause');
        await this.forEachBulkOperation(scope, actor, actions, 'RUNNING', 'pause');
      },
      'PAUSED',
    );
  }

  /** PAUSED → ACTIVE, only while the window is still open: re-publishes the rules. */
  async resume(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly campaignId: string },
  ): Promise<CampaignDetail> {
    return this.operatorEdge(
      scope,
      actor,
      input,
      'campaign.resume',
      async (campaign, actions, now, tx) => {
        if (!(await this.deps.campaigns.resume(scope, campaign.id, now, tx))) {
          throw transitionInvalid();
        }
        return this.setRules(scope, actor, actions, 'ACTIVE', now, tx);
      },
      async (actions) => {
        await this.forEachBroadcast(scope, actor, actions, 'PAUSED', 'resume');
        await this.forEachBulkOperation(scope, actor, actions, 'PAUSED', 'resume');
      },
      'ACTIVE',
    );
  }

  /**
   * Any non-terminal state → CANCELLED (D6). Stops FUTURE work only: the rules are
   * withdrawn and actions that never launched are cancelled. A confirmed redemption, a
   * promised or earned cashback, and anything already credited, sent or applied on a panel
   * stay exactly as they are — nothing is reversed or recalled.
   */
  async cancel(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly campaignId: string },
  ): Promise<CampaignDetail> {
    return this.operatorEdge(
      scope,
      actor,
      input,
      'campaign.cancel',
      async (campaign, actions, now, tx) => {
        // Cancelling a CANCELLED campaign again changes nothing here and re-asks the engines
        // below, so an engine cancel that failed the first time can be retried.
        if (campaign.state === 'CANCELLED') return { alreadyCancelled: true };
        const moved = await this.deps.campaigns.cancel(
          scope,
          { id: campaign.id, adminId: adminIdOf(actor), now },
          tx,
        );
        if (!moved) throw transitionInvalid();
        const withdrawn = await this.setRules(scope, actor, actions, 'INACTIVE', now, tx);
        const pendingCancelled = await this.deps.campaigns.cancelPendingActions(
          scope,
          campaign.id,
          now,
          tx,
        );
        return { ...withdrawn, pendingCancelled };
      },
      // AFTER the commit: each engine cancels what it has not done yet, in its own
      // transaction. A credit written, a grant applied or a message sent stays as it is.
      async (actions) => {
        for (const action of actions) {
          if (action.bulkOperationId !== null) {
            // A repeated cancel is answered, not refused, by the engine itself.
            await ignoringStateConflict(
              this.deps.massActions.cancel(scope, actor, action.bulkOperationId),
            );
          }
        }
        await this.forEachBroadcast(scope, actor, actions, null, 'cancel');
      },
      'CANCELLED',
    );
  }

  /**
   * Pause or resume each gift's mass operation, where it stands in `from` (round N close §B).
   * Idempotent: an operation already moved by a replay, or steered by hand on its own page,
   * is left as it is, and the engine's own repeated-command answer covers the rest.
   */
  private async forEachBulkOperation(
    scope: TenantContext,
    actor: ActorContext,
    actions: readonly CampaignActionRecord[],
    from: 'RUNNING' | 'PAUSED',
    command: 'pause' | 'resume',
  ): Promise<void> {
    for (const action of actions) {
      if (action.bulkOperationId === null) continue;
      const current = await this.deps.massActions.get(scope, actor, action.bulkOperationId);
      if (current.state !== from) continue;
      await ignoringStateConflict(
        this.deps.massActions[command](scope, actor, action.bulkOperationId),
      );
    }
  }

  /** Pause, resume or cancel the announcement's broadcast, where it stands in `from`. */
  private async forEachBroadcast(
    scope: TenantContext,
    actor: ActorContext,
    actions: readonly CampaignActionRecord[],
    from: 'SENDING' | 'PAUSED' | null,
    command: 'pause' | 'resume' | 'cancel',
  ): Promise<void> {
    for (const action of actions) {
      if (action.broadcastId === null) continue;
      if (from !== null) {
        const current = await this.deps.broadcasts.get(scope, actor, action.broadcastId);
        if (current.state !== from) continue;
      }
      await ignoringStateConflict(this.deps.broadcasts[command](scope, actor, action.broadcastId));
    }
  }

  // -------------------------------------------------------------------------------------
  // The worker's two edges. SYSTEM_JOB, `maintenance.run`, each a conditional UPDATE.
  // -------------------------------------------------------------------------------------

  /**
   * SCHEDULED → ACTIVE for one campaign whose start has passed. True when THIS call moved
   * it. The standing rules need nothing here: their own window already opened them.
   */
  async startIfDue(
    scope: TenantContext,
    actor: ActorContext,
    campaignId: string,
  ): Promise<boolean> {
    return this.deps.uow.run(scope, async (tx) => {
      await this.deps.guard.check(scope, actor, 'maintenance.run', tx);
      // A stopped installation starts nothing new; the campaign waits until it resumes.
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return false;
      const now = this.deps.clock.now();
      const moved = await this.deps.campaigns.start(scope, campaignId, now, tx);
      if (!moved) return false;
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'campaign.start',
          entityType: 'Campaign',
          entityId: campaignId,
          before: { state: 'SCHEDULED' },
          after: { state: 'ACTIVE' },
          result: 'SUCCESS',
        },
        tx,
      );
      return true;
    });
  }

  /**
   * ACTIVE|PAUSED → COMPLETED for one campaign whose end has passed. True when THIS call
   * moved it. The rules' own window has closed them already; completing writes nothing to
   * pricing, so the worker needs no pricing permission.
   *
   * Not gated on scope activity: recording that a window has closed is not new business
   * work, and a stopped installation's campaign must not read ACTIVE for ever.
   */
  async completeIfDue(
    scope: TenantContext,
    actor: ActorContext,
    campaignId: string,
  ): Promise<boolean> {
    return this.deps.uow.run(scope, async (tx) => {
      await this.deps.guard.check(scope, actor, 'maintenance.run', tx);
      const now = this.deps.clock.now();
      const before = await this.deps.campaigns.findById(scope, campaignId, tx);
      const moved = await this.deps.campaigns.complete(scope, campaignId, now, tx);
      if (!moved) return false;
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'campaign.complete',
          entityType: 'Campaign',
          entityId: campaignId,
          before: { state: before?.state ?? null },
          after: { state: 'COMPLETED' },
          result: 'SUCCESS',
        },
        tx,
      );
      return true;
    });
  }

  // -------------------------------------------------------------------------------------

  private async operatorEdge(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly campaignId: string },
    action: 'campaign.pause' | 'campaign.resume' | 'campaign.cancel',
    edge: (
      campaign: CampaignRecord,
      actions: readonly CampaignActionRecord[],
      now: Date,
      tx: TransactionScope,
    ) => Promise<Record<string, unknown>>,
    /** What the shared engines are then asked, after the commit, in their own transactions. */
    afterCommit: (actions: readonly CampaignActionRecord[]) => Promise<void>,
    /** The state this edge leaves the campaign in; the engines are steered only from it. */
    settled: 'PAUSED' | 'ACTIVE' | 'CANCELLED',
  ): Promise<CampaignDetail> {
    const campaignId = this.campaignId(input.campaignId);
    const requestHash = hashRequest({ campaignId, action });
    const denial = { action, entityType: 'Campaign', entityId: campaignId };
    await this.authorize(scope, actor, denial);

    const replay = await this.deps.idempotency.find<{ campaignId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      // The edge committed, but its engine commands may not have: the process died, or an
      // engine answered with an error, after the commit. They are idempotent, so a replay
      // asks them again — but only while the campaign is still where this edge left it: a
      // replayed PAUSE after a later RESUME must not pause the announcement again.
      await this.steerEngines(scope, campaignId, settled, afterCommit);
      return this.detailOf(scope, campaignId);
    }

    const now = this.deps.clock.now();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CAMPAIGN_MANAGE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const campaign = await this.deps.campaigns.lockById(scope, campaignId, tx);
        if (campaign === null) throw notFound();
        const actions = await this.deps.campaigns.actionsOf(scope, campaignId, tx);
        await this.checkActionPermissions(scope, actor, actions, tx);
        const effects = await edge(campaign, actions, now, tx);
        const after = await this.deps.campaigns.findById(scope, campaignId, tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action,
            entityType: 'Campaign',
            entityId: campaignId,
            before: { state: campaign.state },
            after: { state: after?.state ?? null, ...effects },
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          'WEB',
          input.idempotencyKey,
          requestHash,
          { campaignId },
          tx,
        );
      },
    );
    await this.steerEngines(scope, campaignId, settled, afterCommit);
    return this.detailOf(scope, campaignId);
  }

  private async steerEngines(
    scope: TenantContext,
    campaignId: string,
    settled: 'PAUSED' | 'ACTIVE' | 'CANCELLED',
    afterCommit: (actions: readonly CampaignActionRecord[]) => Promise<void>,
  ): Promise<void> {
    const campaign = await this.deps.campaigns.findById(scope, campaignId);
    if (campaign?.state !== settled) return;
    await afterCommit(await this.deps.campaigns.actionsOf(scope, campaignId));
  }

  /**
   * Moves every linked rule to `to` with the pricing module's conditional status update,
   * auditing each as the discounts page would. A rule already there is left alone and
   * reported unchanged — an operator may have withdrawn it on the rules page first.
   */
  private async setRules(
    scope: TenantContext,
    actor: ActorContext,
    actions: readonly CampaignActionRecord[],
    to: 'ACTIVE' | 'INACTIVE',
    now: Date,
    tx: TransactionScope,
  ): Promise<Record<string, unknown>> {
    const from = to === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    const effects: Record<string, unknown> = {};
    for (const action of actions) {
      if (action.discountId !== null) {
        const changed = await this.deps.discounts.setStatus(
          scope,
          action.discountId,
          from,
          to,
          now,
          tx,
        );
        effects['discountChanged'] = changed;
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: to === 'ACTIVE' ? 'discount.activate' : 'discount.deactivate',
            entityType: 'Discount',
            entityId: action.discountId,
            before: { status: from },
            after: { status: changed ? to : from, changed, campaignId: action.campaignId },
            result: 'SUCCESS',
          },
          tx,
        );
      }
      if (action.cashbackRuleId !== null) {
        const changed = await this.deps.cashbackRules.setStatus(
          scope,
          action.cashbackRuleId,
          from,
          to,
          now,
          tx,
        );
        effects['cashbackChanged'] = changed;
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: to === 'ACTIVE' ? 'cashback_rule.activate' : 'cashback_rule.deactivate',
            entityType: 'CashbackRule',
            entityId: action.cashbackRuleId,
            before: { status: from },
            after: { status: changed ? to : from, changed, campaignId: action.campaignId },
            result: 'SUCCESS',
          },
          tx,
        );
      }
    }
    return effects;
  }

  /**
   * Creates the rule a standing action is, ACTIVE, windowed to the campaign, and links it.
   * The same INSERT, the same references check and the same audit rows as the rules pages.
   */
  private async createStandingRule(
    scope: TenantContext,
    actor: ActorContext,
    campaign: CampaignRecord,
    action: CampaignActionRecord,
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    const config = action.config;
    if (config.kind === 'DISCOUNT') {
      const write = discountWriteOf(campaign, config.terms);
      const id = this.deps.ids.uuid();
      const created = await this.deps.discounts.create(scope, id, write, now, tx);
      if (created === null) {
        throw errors.conflict(
          COMMERCE_ERROR_CODES.DISCOUNT_CODE_TAKEN,
          'Another discount already uses that code.',
        );
      }
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'discount.create',
          entityType: 'Discount',
          entityId: id,
          before: null,
          after: { ...discountAuditView(created), campaignId: campaign.id },
          result: 'SUCCESS',
        },
        tx,
      );
      await this.deps.discounts.setStatus(scope, id, 'INACTIVE', 'ACTIVE', now, tx);
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'discount.activate',
          entityType: 'Discount',
          entityId: id,
          before: { status: 'INACTIVE' },
          after: { status: 'ACTIVE', changed: true, campaignId: campaign.id },
          result: 'SUCCESS',
        },
        tx,
      );
      if (
        !(await this.deps.campaigns.linkRule(
          scope,
          { actionId: action.id, discountId: id, now },
          tx,
        ))
      ) {
        throw transitionInvalid();
      }
      return;
    }
    if (config.kind === 'CASHBACK') {
      const write = cashbackWriteOf(campaign, config.terms);
      const id = this.deps.ids.uuid();
      const created = await this.deps.cashbackRules.create(scope, id, write, now, tx);
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'cashback_rule.create',
          entityType: 'CashbackRule',
          entityId: id,
          before: null,
          after: { ...cashbackAuditView(created), campaignId: campaign.id },
          result: 'SUCCESS',
        },
        tx,
      );
      await this.deps.cashbackRules.setStatus(scope, id, 'INACTIVE', 'ACTIVE', now, tx);
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'cashback_rule.activate',
          entityType: 'CashbackRule',
          entityId: id,
          before: { status: 'INACTIVE' },
          after: { status: 'ACTIVE', changed: true, campaignId: campaign.id },
          result: 'SUCCESS',
        },
        tx,
      );
      if (
        !(await this.deps.campaigns.linkRule(
          scope,
          { actionId: action.id, cashbackRuleId: id, now },
          tx,
        ))
      ) {
        throw transitionInvalid();
      }
    }
  }

  /** Every action's own permission, through the guard, inside the transaction. */
  private async checkActionPermissions(
    scope: TenantContext,
    actor: ActorContext,
    actions: readonly { readonly kind: CampaignActionKind }[],
    tx: TransactionScope,
  ): Promise<void> {
    const needed = new Set<PermissionKey>();
    for (const action of actions) {
      const permission = CAMPAIGN_ACTION_PERMISSIONS[action.kind];
      if (permission !== undefined) needed.add(permission);
    }
    for (const permission of needed) await this.deps.guard.check(scope, actor, permission, tx);
  }

  /** The references each rule names must be this tenant's: the rules pages' own check. */
  private async assertActionReferences(
    scope: TenantContext,
    actions: readonly CampaignActionConfig[],
    tx: TransactionScope,
  ): Promise<void> {
    const kinds = new Set<string>();
    for (const action of actions) {
      if (kinds.has(action.kind)) {
        throw errors.validation(
          CAMPAIGN_ERROR_CODES.CAMPAIGN_REQUEST_INVALID,
          'A campaign has at most one action of each kind.',
        );
      }
      kinds.add(action.kind);
      if (action.kind === 'DISCOUNT') {
        // The window is irrelevant to references; any placeholder instants will do.
        await this.deps.discountAdmin.assertReferences(
          scope,
          { ...discountWriteOf(null, action.terms) },
          tx,
        );
        if (action.terms.code !== null) {
          const taken = await this.deps.discounts.findByCode(
            scope,
            normaliseDiscountCode(action.terms.code),
            tx,
          );
          if (taken !== null) {
            throw errors.conflict(
              COMMERCE_ERROR_CODES.DISCOUNT_CODE_TAKEN,
              'Another discount already uses that code.',
            );
          }
        }
      }
      if (action.kind === 'ANNOUNCEMENT') {
        // The broadcast placeholder catalogue, by the one validator Broadcast itself uses, so
        // a draft is told about `{wallet}` now rather than at its start.
        const issues = validateTemplateBody(BROADCAST_BODY_DEFINITION, action.terms.body);
        if (issues.length > 0) {
          throw errors.validation(
            BROADCAST_ERROR_CODES.BODY_INVALID,
            'The announcement uses a placeholder Broadcast does not offer.',
            { issues: issues.map((issue) => issue.kind) },
          );
        }
      }
      if (action.kind === 'CASHBACK') {
        await this.deps.cashbackAdmin.assertReferences(
          scope,
          cashbackWriteOf(null, action.terms),
          tx,
        );
      }
    }
  }

  private resolveDraft(
    draft: CampaignDraftInput,
    presentation: { readonly timezone: string; readonly calendar: 'jalali' | 'gregorian' },
  ): CampaignDraftWrite {
    const name = draft.name.trim();
    if (name.length === 0) {
      throw errors.validation(
        CAMPAIGN_ERROR_CODES.CAMPAIGN_REQUEST_INVALID,
        'A campaign has a name.',
      );
    }
    const startsAt = this.deps.calendar.instantOf(draft.startDate, draft.startTime, presentation);
    const endsAt = this.deps.calendar.instantOf(draft.endDate, draft.endTime, presentation);
    if (startsAt === null || endsAt === null || startsAt.getTime() >= endsAt.getTime()) {
      throw errors.validation(
        CAMPAIGN_ERROR_CODES.CAMPAIGN_WINDOW_INVALID,
        'The campaign window is unreadable or ends before it starts.',
      );
    }
    return {
      name,
      description: draft.description.trim(),
      startsAt,
      endsAt,
      // The shared contract's one canonical spelling, so the stored definition, its hash
      // and the preview can never disagree about who is meant.
      ...(() => {
        const frozen = freezeAudience(draft.audience);
        return { audience: frozen.definition, audienceHash: frozen.hash };
      })(),
      actions: assertAnnouncementPurpose(draft.actions),
    };
  }

  private async detailOf(scope: TenantContext, campaignId: string): Promise<CampaignDetail> {
    const campaign = await this.deps.campaigns.findById(scope, campaignId);
    if (campaign === null) throw notFound();
    const actions = await this.deps.campaigns.actionsOf(scope, campaignId);
    const discountId = actions.find((a) => a.kind === 'DISCOUNT')?.discountId ?? null;
    const cashbackRuleId = actions.find((a) => a.kind === 'CASHBACK')?.cashbackRuleId ?? null;
    const presentation = await this.deps.calendar.presentationFor(scope);
    return {
      campaign,
      actions,
      discount: discountId === null ? null : await this.deps.discounts.findById(scope, discountId),
      cashbackRule:
        cashbackRuleId === null
          ? null
          : await this.deps.cashbackRules.findById(scope, cashbackRuleId),
      presentation,
      startLocal: this.deps.calendar.localOf(campaign.startsAt, presentation),
      endLocal: this.deps.calendar.localOf(campaign.endsAt, presentation),
    };
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }

  /** Before the replay lookup: a replay returns a campaign, and would hand it to anybody. */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, CAMPAIGN_MANAGE_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        CAMPAIGN_MANAGE_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        CAMPAIGN_ERROR_CODES.CAMPAIGN_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
    }
  }

  private campaignId(candidate: string): string {
    const parsed = uuidV7Schema.safeParse(candidate);
    if (!parsed.success) throw notFound();
    return parsed.data;
  }
}

function adminIdOf(actor: ActorContext): string | null {
  return actor.type === 'WEB_ADMIN' || actor.type === 'TELEGRAM_ADMIN' ? actor.id : null;
}

function notFound() {
  return errors.notFound(CAMPAIGN_ERROR_CODES.CAMPAIGN_NOT_FOUND, 'Unknown campaign.');
}

function notEditable() {
  return errors.conflict(
    CAMPAIGN_ERROR_CODES.CAMPAIGN_NOT_EDITABLE,
    'Only a draft is edited. Cancel this campaign and create a new one.',
  );
}

function transitionInvalid() {
  return errors.conflict(CAMPAIGN_ERROR_CODES.CAMPAIGN_TRANSITION_INVALID, 'The campaign moved.');
}

/** The rule a discount action is. `campaign` null only for the references check. */
function discountWriteOf(
  campaign: CampaignRecord | null,
  terms: Extract<CampaignActionConfig, { kind: 'DISCOUNT' }>['terms'],
): DiscountRuleWrite {
  return {
    kind: terms.kind,
    code: terms.code === null ? null : normaliseDiscountCode(terms.code),
    label: campaign?.name ?? 'campaign',
    type: terms.type,
    value: terms.value,
    currency: terms.currency,
    appliesTo: terms.appliesTo,
    productId: terms.productId,
    categoryId: terms.categoryId,
    customerId: null,
    firstPurchaseOnly: terms.firstPurchaseOnly,
    minimumSubtotal: terms.minimumSubtotal,
    startsAt: campaign?.startsAt ?? null,
    endsAt: campaign?.endsAt ?? null,
    totalLimit: terms.totalLimit,
    perCustomerLimit: terms.perCustomerLimit,
    priority: terms.priority,
    stackable: terms.stackable,
  };
}

function cashbackWriteOf(
  campaign: CampaignRecord | null,
  terms: Extract<CampaignActionConfig, { kind: 'CASHBACK' }>['terms'],
): CashbackRuleWrite {
  return {
    label: campaign?.name ?? 'campaign',
    percent: terms.percent,
    appliesTo: terms.appliesTo,
    productId: terms.productId,
    categoryId: terms.categoryId,
    startsAt: campaign?.startsAt ?? null,
    endsAt: campaign?.endsAt ?? null,
  };
}

function serialisableAction(action: CampaignActionConfig): Record<string, unknown> {
  if (action.kind === 'DISCOUNT') {
    return {
      kind: action.kind,
      terms: {
        ...action.terms,
        value: action.terms.value.toString(),
        minimumSubtotal: action.terms.minimumSubtotal?.toString() ?? null,
        appliesTo: [...action.terms.appliesTo],
      },
    };
  }
  if (action.kind === 'CASHBACK') {
    return {
      kind: action.kind,
      terms: { ...action.terms, appliesTo: [...action.terms.appliesTo] },
    };
  }
  // Every other kind's terms are already plain JSON: strings, numbers, booleans.
  return { kind: action.kind, terms: JSON.parse(JSON.stringify(action.terms)) as unknown };
}

function serialisableDraft(draft: CampaignDraftInput): Record<string, unknown> {
  return { ...draft, actions: draft.actions.map(serialisableAction) };
}

function campaignAuditView(
  campaign: CampaignRecord,
  actions: readonly CampaignActionConfig[],
): Record<string, unknown> {
  return {
    name: campaign.name,
    description: campaign.description,
    state: campaign.state,
    startsAt: campaign.startsAt.toISOString(),
    endsAt: campaign.endsAt.toISOString(),
    audience: campaign.audience,
    actions: actions.map(serialisableAction),
  };
}

/**
 * The error kinds that are an engine's REFUSAL on the merits — the action is FAILED with the
 * code. Anything else (the database, a timeout, a crash) leaves the action PENDING.
 */
/**
 * Broadcast schedules only at least a minute ahead (`broadcast.service.ts`); an announcement
 * whose campaign starts sooner than this is sent at once, which is what the start means.
 */
const ANNOUNCEMENT_MIN_LEAD_MS = 90_000;
/**
 * Broadcast and the mass-action engine each take work at most sixty days ahead; a campaign
 * that hands them any starts within that (a day's margin for the time the preview takes).
 */
const LAUNCH_MAX_LEAD_MS = 59 * 86_400_000;

const REFUSAL_KINDS: ReadonlySet<string> = new Set([
  'VALIDATION',
  'NOT_FOUND',
  'CONFLICT',
  'PRECONDITION_FAILED',
]);

function bindingInvalid(kind: CampaignActionKind) {
  return errors.validation(
    CAMPAIGN_ERROR_CODES.CAMPAIGN_BINDING_INVALID,
    'Confirm each gift with the figures its preview showed.',
    { kind },
  );
}

/**
 * Whether the engine behind `kind` asks for the count typed back at `count` — the engines'
 * own thresholds, so the campaign asks exactly when they will.
 */
export function typedCountRequiredFor(kind: CampaignActionKind, count: number): boolean {
  switch (kind) {
    case 'WALLET_GIFT':
      return true;
    case 'TRAFFIC_GIFT':
    case 'TIME_GIFT':
      return count >= BULK_LARGE_OPERATION;
    case 'ANNOUNCEMENT':
      return count >= BROADCAST_LARGE_AUDIENCE;
    default:
      return false;
  }
}

/** A gift's terms as the mass-action engine's grant. */
function grantOf(config: CampaignGiftConfig): BulkGrant {
  switch (config.kind) {
    case 'WALLET_GIFT':
      return {
        kind: 'WALLET_CREDIT',
        amountMinor: config.terms.amountMinor,
        currency: config.terms.currency,
      };
    case 'TRAFFIC_GIFT':
      return { kind: 'SERVICE_TRAFFIC', trafficGb: config.terms.trafficGb };
    case 'TIME_GIFT':
      return { kind: 'SERVICE_TIME', durationDays: config.terms.durationDays };
  }
}

/**
 * An engine answering that its record is already past the state a command needs — a
 * broadcast that finished, an operation that completed — is the outcome, not a failure:
 * there is nothing left for the command to stop.
 */
async function ignoringStateConflict(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch (error) {
    if (
      isNexaError(error) &&
      (error.code === BROADCAST_ERROR_CODES.STATE_CONFLICT ||
        error.code === BULK_ERROR_CODES.STATE_CONFLICT)
    ) {
      return;
    }
    throw error;
  }
}

/**
 * An engine record the viewer may not read (its own view key) is shown as absent rather than
 * failing the whole results page; the campaign page says which key it takes.
 */
async function readableOrNull<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work;
  } catch (error) {
    if (isNexaError(error) && error.kind === 'PERMISSION_DENIED') return null;
    throw error;
  }
}

/**
 * Roadmap C4 — the promotional opt-out stays authoritative. A campaign is promotional by what
 * it is: its announcement exists to tell people about an offer or a gift. Sent as a
 * SERVICE_ANNOUNCEMENT it would reach every customer who opted out of promotions, with no
 * reason given and nothing on the customer's side changed — the silent override C4 rules out.
 * So a campaign's announcement is MARKETING, and the opt-out decides at the send.
 *
 * No release ever persisted the purpose (the repository's `configToJson` drops it), so every
 * campaign announcement sent so far went as MARKETING: this makes the screen and the API say
 * what the lane already did, rather than accept a choice and silently ignore it. A service
 * fact — compensation after an outage — is a Broadcast of its own, composed and confirmed
 * as a service announcement on the Broadcast page.
 */
export function assertAnnouncementPurpose<T extends readonly CampaignActionConfig[]>(
  actions: T,
): T {
  const announcement = actions.find((a) => a.kind === 'ANNOUNCEMENT');
  if (announcement?.kind === 'ANNOUNCEMENT' && announcement.terms.purpose !== 'MARKETING') {
    throw errors.validation(
      CAMPAIGN_ERROR_CODES.CAMPAIGN_ANNOUNCEMENT_PURPOSE_INVALID,
      'A campaign announces itself as a promotional message; a service fact is a broadcast of its own.',
    );
  }
  return actions;
}
