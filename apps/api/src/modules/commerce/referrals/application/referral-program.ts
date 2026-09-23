import {
  COMMERCE_ERROR_CODES,
  errors,
  isDiscountablePurpose,
  money,
  referralCodeFor,
  referralCodeFromStartPayload,
  referralCommissionMinor,
  referralScopeOf,
  referralStartPayload,
  referralTriggerFor,
  type ActorContext,
  type AuditWriter,
  type BotInstanceId,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type Money,
  type OperationalEventRecorder,
  type PermissionKey,
  type ReferralCommissionScope,
  type ReferralRejection,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { BotInstanceRepository } from '../../../platform/tenancy/application/ports.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { FeatureFlagResolver } from '../../../control/features/application/feature-flags.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerRepository } from '../../customers/application/ports.js';
import type { OrderRecord } from '../../orders/application/ports.js';
import type { ReferralCommissionRepository, ReferralRepository } from './ports.js';

/**
 * What a customer turn acts under: the webhook's `SYSTEM_JOB`, holding the one key every
 * customer flow here holds. Ownership is not a permission; it is the customer id the
 * surface passes, resolved from the update.
 */
export const REFERRAL_WEBHOOK_PERMISSION: PermissionKey = 'maintenance.run';

const REFERRAL_NAMESPACE = 'TELEGRAM';

/** No commission id is this, so it excludes nothing when asked "any other earned one?". */
const NO_COMMISSION = '00000000-0000-0000-0000-000000000000';

export interface ReferralProgramDeps {
  readonly referrals: ReferralRepository;
  readonly commissions: Pick<ReferralCommissionRepository, 'promise' | 'hasEarnedForReferral'>;
  readonly customers: Pick<CustomerRepository, 'findById'>;
  readonly settings: SettingsResolver;
  readonly features: FeatureFlagResolver;
  readonly bots: Pick<BotInstanceRepository, 'findById'>;
  /**
   * The bot's username as Telegram states it NOW, asked outside any transaction.
   *
   * `bot_instances.username` is what the bootstrap recorded, and a rename in BotFather
   * leaves it stale; a link built from it sends the referee to a name that may no longer
   * exist or may belong to another bot. Null when Telegram could not be asked.
   */
  readonly botUsernames: {
    liveUsername(scope: TenantContext, botInstanceId: BotInstanceId): Promise<string | null>;
  };
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly idempotency: IdempotencyStore;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** The program's terms as they stand, read in one place so no caller decides "active" alone. */
export interface ReferralTerms {
  readonly active: boolean;
  readonly percent: number | null;
  readonly scope: ReferralCommissionScope;
  readonly minimum: Money;
}

export type ReferralInvite =
  | { readonly outcome: 'INACTIVE' }
  | { readonly outcome: 'UNAVAILABLE' }
  | {
      readonly outcome: 'READY';
      readonly code: string;
      readonly link: string;
      readonly referredCount: number;
    };

/**
 * The referral program: who is attributed to whom, the customer's own link, and the
 * commission promised when a referred customer confirms an order
 * (`docs/wp9-referral-audit.md` F2–F6, F11).
 *
 * Earning and reversing the commission is `ReferralCommissionService`'s, which touches the
 * ledger; nothing here writes to a wallet.
 */
export class ReferralProgram {
  constructor(private readonly deps: ReferralProgramDeps) {}

  /**
   * Whether the program is running, and on what terms (F4, F5).
   *
   * ACTIVE only when the flag is on AND a rate is chosen: a switched-on program with no
   * rate would attribute customers to terms that do not exist yet.
   */
  async terms(scope: TenantContext, tx?: unknown): Promise<ReferralTerms> {
    const enabled = await this.deps.features.isEnabled(scope, 'referrals', tx);
    const percent = await this.deps.settings.valueOf<number | null>(
      scope,
      'referral.commission_percent',
      tx,
    );
    const commissionScope = await this.deps.settings.valueOf<ReferralCommissionScope>(
      scope,
      'referral.commission_scope',
      tx,
    );
    const minimum = await this.deps.settings.valueOf<{ amountMinor: string; currency: string }>(
      scope,
      'referral.minimum_order_amount',
      tx,
    );
    return {
      active: enabled && percent !== null,
      percent,
      scope: commissionScope,
      minimum: money(BigInt(minimum.amountMinor), minimum.currency as Money['currency']),
    };
  }

  /**
   * Attributes a newly registered customer to whoever's link they arrived through (F2).
   *
   * Called INSIDE the transaction that resolved the customer, so the referral commits with
   * the customer row or not at all. `created` is that transaction's own answer: a customer
   * who already existed is never attributed, whatever link they followed later, and a
   * `/start` that carries no referral payload is not an attempt at all.
   *
   * Every attempt that does not produce a referral is AUDITED with its reason and never
   * told to the customer (F11): the greeting is the same either way, so the bot is not an
   * oracle for which codes exist. Nothing here throws for a refusal — a registration never
   * fails because of the link it came through.
   */
  async attributeOnArrival(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly refereeId: UserId;
      readonly created: boolean;
      readonly startPayload: string | null;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<void> {
    if (input.startPayload === null) return;
    const code = referralCodeFromStartPayload(input.startPayload);
    if (code === null) return;

    const refuse = async (reason: ReferralRejection): Promise<void> => {
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'referral.attribute',
          entityType: 'Customer',
          entityId: input.refereeId,
          before: null,
          after: { reason },
          result: 'DENIED',
        },
        tx,
      );
    };

    if (!input.created) return refuse('ALREADY_REGISTERED');
    const terms = await this.terms(scope, tx);
    if (!terms.active) return refuse('PROGRAM_INACTIVE');

    const owner = await this.deps.referrals.findCodeOwner(scope, code, tx);
    if (owner === null) return refuse('CODE_UNKNOWN');
    // Unreachable for a customer created in this transaction — nobody has handed out a
    // code for an id that did not exist — and the database refuses it too. Kept so the
    // refusal is named rather than a constraint violation.
    if (owner.customerId === input.refereeId) return refuse('SELF_REFERRAL');
    if (owner.status === 'BLOCKED') return refuse('REFERRER_BLOCKED');

    const trigger = referralTriggerFor(terms.scope);
    const referralId = this.deps.ids.uuid();
    const wrote = await this.deps.referrals.attribute(
      scope,
      {
        id: referralId,
        referrerId: owner.customerId,
        refereeId: input.refereeId,
        trigger,
        now: input.now,
      },
      tx,
    );
    if (!wrote) return refuse('ALREADY_ATTRIBUTED');

    await this.deps.audit.record(
      scope,
      actor,
      {
        action: 'referral.attribute',
        entityType: 'Customer',
        entityId: input.refereeId,
        before: null,
        after: { referralId, referrerId: owner.customerId, trigger },
        result: 'SUCCESS',
      },
      tx,
    );
    await this.deps.outbox.write(tx, actor, {
      eventType: 'ReferralAttributed',
      aggregateType: 'Referral',
      aggregateId: referralId,
      payload: {
        referralId,
        referrerId: owner.customerId,
        refereeId: input.refereeId,
        trigger,
      },
    });
  }

  /**
   * The customer's own link, and how many people have joined through it (F3, F12).
   *
   * Records the customer's code the first time they ask, which is the only write here:
   * the code is `referralCodeFor(id)`, so asking twice records nothing new. A code that
   * collides with another customer's is refused as `UNAVAILABLE` rather than reassigned.
   */
  async invite(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly botInstanceId: BotInstanceId;
    },
  ): Promise<ReferralInvite> {
    const customerId = input.customerId as UserId;
    const requestHash = hashRequest({ customerId, bot: input.botInstanceId });
    const denial = { action: 'referral.invite', entityType: 'Customer', entityId: customerId };
    await this.deps.guard.check(scope, actor, REFERRAL_WEBHOOK_PERMISSION);

    /*
     * A redelivered turn — Telegram retrying an update whose reply was lost — carries the
     * key this call already remembered. It is answered again rather than refused: the code
     * is derived and already recorded, so recomputing the invite changes nothing, and
     * remembering the key a second time would throw `IDEMPOTENCY_IN_FLIGHT` on every retry
     * and the customer would never see the link. A key remembered for a different request
     * still refuses, inside `find`.
     */
    const replay = await this.deps.idempotency.find<{ customerId: string; code: string }>(
      scope,
      REFERRAL_NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );

    // Outside the transaction: a network call inside one would hold its locks for as long
    // as Telegram takes to answer.
    const username = await this.deps.botUsernames.liveUsername(scope, input.botInstanceId);

    return runAuthorizedMutation(
      {
        uow: this.deps.uow,
        guard: this.deps.guard,
        audit: this.deps.audit,
        opsLog: this.deps.opsLog,
        sessions: this.deps.sessions,
        clock: this.deps.clock,
      },
      scope,
      actor,
      REFERRAL_WEBHOOK_PERMISSION,
      denial,
      async (tx): Promise<ReferralInvite> => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        if (!(await this.terms(scope, tx)).active) return { outcome: 'INACTIVE' };

        const customer = await this.deps.customers.findById(scope, customerId, tx);
        if (customer === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
        }

        const bot = await this.deps.bots.findById(input.botInstanceId);
        // The bot the customer is talking to is the only name a link can carry. A bot of
        // another tenant, or none, is a link that would take the referee somewhere else.
        if (bot === null || bot.tenantId !== scope.tenantId) return { outcome: 'UNAVAILABLE' };
        // A link Telegram could not vouch for is not offered: a stale name is worse than none.
        if (username === null) return { outcome: 'UNAVAILABLE' };

        const code = referralCodeFor(customerId);
        const recorded = await this.deps.referrals.ensureCode(
          scope,
          { customerId, code, now: this.deps.clock.now() },
          tx,
        );
        if (recorded === 'TAKEN') return { outcome: 'UNAVAILABLE' };

        const referredCount = await this.deps.referrals.countReferredBy(scope, customerId, tx);
        if (replay === null) {
          await rememberOnce(
            this.deps.idempotency,
            scope,
            REFERRAL_NAMESPACE,
            input.idempotencyKey,
            requestHash,
            { customerId, code },
            tx,
          );
        }
        return {
          outcome: 'READY',
          code,
          link: `https://t.me/${username}?start=${referralStartPayload(code)}`,
          referredCount,
        };
      },
    );
  }

  /**
   * The commission promised when a referred customer confirms an order (F6).
   *
   * Called from `PricingService.redeem`, the one confirmation hook both order paths
   * share, INSIDE the confirming transaction; every condition is read there, so a program
   * switched off or a referrer blocked a moment earlier is honoured. Writes at most one
   * `PENDING` row per order and nothing else: nothing is credited until delivery.
   */
  async promise(
    scope: TenantContext,
    order: OrderRecord,
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    // A trial is not a purchase and earns nobody anything (plan §9.7).
    if (!isDiscountablePurpose(order.purpose)) return;

    const terms = await this.terms(scope, tx);
    if (!terms.active || terms.percent === null) return;

    const total = order.totals.total;
    if (total.amountMinor <= 0n) return;
    if (terms.minimum.amountMinor > 0n) {
      // A floor in another currency is not converted: an order it cannot be compared with
      // earns nothing, which is the fail-closed reading of an amount rule.
      if (terms.minimum.currency !== total.currency) return;
      if (total.amountMinor < terms.minimum.amountMinor) return;
    }

    const referral = await this.deps.referrals.findByReferee(scope, order.customerId, tx);
    if (referral === null) return;
    const commissionScope = referralScopeOf(referral.trigger);
    if (commissionScope === null) return;

    const referrer = await this.deps.customers.findById(scope, referral.referrerId as UserId, tx);
    if (referrer === null || referrer.status === 'BLOCKED') return;

    // A courtesy, not the guard: first-order scope is DECIDED when a commission is earned,
    // under the referrer's lock. This only spares the ledger a promise that could never be
    // kept because an earlier order already paid.
    if (
      commissionScope === 'FIRST_PAID_ORDER' &&
      (await this.deps.commissions.hasEarnedForReferral(scope, referral.id, NO_COMMISSION, tx))
    ) {
      return;
    }

    const amount = referralCommissionMinor(total.amountMinor, terms.percent);
    if (amount <= 0n) return;

    await this.deps.commissions.promise(
      scope,
      {
        id: this.deps.ids.uuid(),
        orderId: order.id,
        referralId: referral.id,
        referrerId: referral.referrerId,
        refereeId: order.customerId,
        scope: commissionScope,
        percent: terms.percent,
        basis: total,
        amount: money(amount, total.currency),
        now,
      },
      tx,
    );
  }
}
