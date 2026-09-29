import {
  AUDIENCE_ERROR_CODES,
  CAMPAIGN_ERROR_CODES,
  CAMPAIGN_PAGE_DEFAULT,
  CAMPAIGN_PAGE_MAX,
  COMMERCE_ERROR_CODES,
  errors,
  normaliseDiscountCode,
  uuidV7Schema,
  type ActorContext,
  type AudiencePreview,
  type AuditWriter,
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
  CampaignActionConfig,
  CampaignActionRecord,
  CampaignCalendar,
  CampaignCursor,
  CampaignDraftWrite,
  CampaignPage,
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
};

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
}

/**
 * What a campaign produced, from persisted rows only (D9). There is no "revenue caused"
 * field and no conversion rate: nothing persists that a purchase was CAUSED by a campaign.
 */
export interface CampaignResults {
  readonly discount: DiscountOutcome | null;
  readonly cashback: CashbackOutcome | null;
}

/** What a confirmation binds to, and the liability that is determinable before it. */
export interface CampaignPreview {
  readonly audience: AudiencePreview;
  readonly discountMaxLiability: {
    readonly amountMinor: bigint;
    readonly currency: CurrencyCode;
  } | null;
}

export interface CampaignServiceDeps {
  readonly campaigns: CampaignRepository;
  readonly discounts: Pick<DiscountRepository, 'create' | 'setStatus' | 'findById' | 'findByCode'>;
  readonly cashbackRules: Pick<CashbackRuleRepository, 'create' | 'setStatus' | 'findById'>;
  readonly discountAdmin: Pick<DiscountAdminService, 'assertReferences'>;
  readonly cashbackAdmin: Pick<CashbackRuleAdminService, 'assertReferences'>;
  readonly calendar: CampaignCalendar;
  /** The SHARED audience engine (round N, B1): the same query Broadcast and the mass actions use. */
  readonly audience: Pick<AudienceService, 'evaluate' | 'sampleOf'>;
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
  ): Promise<CampaignPage & { presentation: CampaignDetail['presentation'] }> {
    await this.deps.guard.check(scope, actor, CAMPAIGN_VIEW_PERMISSION);
    const limit = Math.min(Math.max(query.limit ?? CAMPAIGN_PAGE_DEFAULT, 1), CAMPAIGN_PAGE_MAX);
    const page = await this.deps.campaigns.list(
      scope,
      query.state === undefined ? {} : { state: query.state },
      limit,
      query.cursor ?? null,
    );
    return { ...page, presentation: await this.deps.calendar.presentationFor(scope) };
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
    return {
      discount:
        discountId === null ? null : await this.deps.campaigns.discountOutcome(scope, discountId),
      cashback:
        cashbackRuleId === null
          ? null
          : await this.deps.campaigns.cashbackOutcome(scope, cashbackRuleId),
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
    return {
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
    },
  ): Promise<CampaignDetail> {
    const campaignId = this.campaignId(input.campaignId);
    const requestHash = hashRequest({
      campaignId,
      expectedDefinitionHash: input.expectedDefinitionHash,
      expectedRecipients: input.expectedRecipients,
      expectedFingerprint: input.expectedFingerprint,
    });
    const denial = { action: 'campaign.schedule', entityType: 'Campaign', entityId: campaignId };
    await this.authorize(scope, actor, denial);

    const replay = await this.deps.idempotency.find<{ campaignId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return this.detailOf(scope, campaignId);

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
        await this.checkActionPermissions(scope, actor, actions, tx);
        await this.assertActionReferences(
          scope,
          actions.map((a) => a.config),
          tx,
        );

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

        for (const action of actions) {
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
    return this.detailOf(scope, campaignId);
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
    );
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
    if (replay !== null) return this.detailOf(scope, campaignId);

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
    return this.detailOf(scope, campaignId);
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
    actions: readonly CampaignActionRecord[],
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
      actions: draft.actions,
    };
  }

  private async detailOf(scope: TenantContext, campaignId: string): Promise<CampaignDetail> {
    const campaign = await this.deps.campaigns.findById(scope, campaignId);
    if (campaign === null) throw notFound();
    const actions = await this.deps.campaigns.actionsOf(scope, campaignId);
    const discountId = actions.find((a) => a.kind === 'DISCOUNT')?.discountId ?? null;
    const cashbackRuleId = actions.find((a) => a.kind === 'CASHBACK')?.cashbackRuleId ?? null;
    return {
      campaign,
      actions,
      discount: discountId === null ? null : await this.deps.discounts.findById(scope, discountId),
      cashbackRule:
        cashbackRuleId === null
          ? null
          : await this.deps.cashbackRules.findById(scope, cashbackRuleId),
      presentation: await this.deps.calendar.presentationFor(scope),
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
  return { kind: action.kind, terms: { ...action.terms, appliesTo: [...action.terms.appliesTo] } };
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
