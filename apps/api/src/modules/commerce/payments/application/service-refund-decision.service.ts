import {
  ADMIN_AMOUNT_CAPTURE_TTL_MS,
  ADMIN_CAPTURE_REASON_MAX_LENGTH,
  COMMERCE_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  errors,
  isNexaError,
  money,
  uuidV7Schema,
  type ActorContext,
  type AdminAmountCaptureCloseReason,
  type AuditWriter,
  type BotInstanceId,
  type Clock,
  type IdempotencyStore,
  type IdGenerator,
  type Money,
  type OperationalEventRecorder,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  AdminAmountCaptureRecord,
  AdminAmountCaptureRepository,
} from './admin-amount-capture-ports.js';
import type { ServiceRefundRequestRecord } from './service-refund-request-ports.js';
import {
  SERVICE_REFUND_DECIDE_PERMISSIONS,
  type ServiceRefundRequestService,
  type ServiceRefundReview,
} from './service-refund-request.service.js';
import { parseTypedAmount } from './typed-amount.js';

export interface ServiceRefundDecisionServiceDeps {
  readonly captures: AdminAmountCaptureRepository;
  /** The ONE decision path. The captures only ask it; every rule is decided there, again. */
  readonly requests: Pick<
    ServiceRefundRequestService,
    'reviewForDecision' | 'preview' | 'approve' | 'rejectWithin'
  >;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** An entered amount, remembered against the message's key so a redelivery is answered. */
  readonly idempotency: IdempotencyStore;
}

/** The namespace every Telegram capture remembers its message under. */
const TEXT_NAMESPACE = 'TELEGRAM' as const;

/**
 * Whether a message may be read by this prompt: only one sent AFTER the tap that opened it
 * (Codex review of #83, round 5). Telegram's `update_id` increases per bot, so a
 * redelivered message typed earlier — for the prompt this one replaced, or for any other
 * kind of prompt — is never this prompt's amount or reason. Unknown on either side (a
 * prompt opened by no update, a caller that passes none) decides nothing here.
 */
function isNewerThan(updateId: bigint | undefined, capture: AdminAmountCaptureRecord): boolean {
  if (updateId === undefined || capture.openedUpdateId === null) return true;
  return updateId > capture.openedUpdateId;
}

export type DecisionOpenResult =
  | {
      readonly outcome: 'OPENED';
      readonly capture: AdminAmountCaptureRecord;
      readonly review: ServiceRefundReview;
    }
  /** The request was decided before the tap. Nothing was opened. */
  | { readonly outcome: 'CLOSED' }
  /** Open, but nothing about it can be executed now: no service, or nothing left to refund. */
  | { readonly outcome: 'NOT_EXECUTABLE' };

export type DecisionTextResult =
  /** This administrator has no refund-request prompt waiting on this bot. */
  | { readonly outcome: 'NO_CAPTURE' }
  | { readonly outcome: 'EXPIRED' }
  /** The request was decided another way while the prompt was open. */
  | { readonly outcome: 'CLOSED' }
  | { readonly outcome: 'NOT_EXECUTABLE' }
  /** Not an amount, or not one the payment has left. The prompt stays open. */
  | { readonly outcome: 'INVALID_AMOUNT'; readonly remaining: Money }
  | {
      readonly outcome: 'AMOUNT_ENTERED';
      readonly capture: AdminAmountCaptureRecord;
      readonly amount: Money;
      readonly review: ServiceRefundReview;
    }
  /** Not a reason. The prompt stays open. */
  | { readonly outcome: 'INVALID_REASON' }
  | { readonly outcome: 'REJECTED'; readonly request: ServiceRefundRequestRecord };

export type DecisionConfirmResult =
  | { readonly outcome: 'EXECUTING'; readonly request: ServiceRefundRequestRecord }
  | { readonly outcome: 'EXPIRED' }
  | { readonly outcome: 'CANCELLED' }
  /** The request was decided before this confirmation. Nothing moved. */
  | { readonly outcome: 'CLOSED' }
  | { readonly outcome: 'NOT_EXECUTABLE' }
  /** The payment has less left than the amount stated now: a partial refund landed first. */
  | { readonly outcome: 'INVALID_AMOUNT'; readonly remaining: Money }
  /** No such prompt for this administrator, or one with nothing to confirm. */
  | { readonly outcome: 'GONE' };

export type DecisionCancelResult =
  | { readonly outcome: 'CANCELLED' }
  /** Already confirmed: a cancel cannot undo an approval. */
  | { readonly outcome: 'CONFIRMED' }
  | { readonly outcome: 'GONE' };

/**
 * The Telegram half of an administrator's decision on a customer's service refund request
 * (WP19, brief §2.6 and §2.9): the prompts behind the review card's approve and reject.
 *
 * The prompts are `admin_amount_captures` rows, the receipt credit's machinery, keyed by a
 * purpose of their own: one names ONE administrator, ONE bot and ONE request, expires in
 * `ADMIN_AMOUNT_CAPTURE_TTL_MS`, and reads ONE message. Another administrator's message, a
 * customer's message and a slash command never reach it.
 *
 * - **Approve** reads an amount, has the request service check it under the payment's lock
 *   (`preview`) and restates it with one destructive confirmation. The confirm button names
 *   the CAPTURE, never the figure, so what it approves is what the row holds; the approval
 *   decides everything again (`ServiceRefundRequestService.approve`).
 * - **Reject** reads the mandatory reason and rejects at once (brief §2.9: "then exactly
 *   once") — there is nothing to delete or move, so there is nothing a second confirmation
 *   would protect.
 *
 * Nothing here decides money or state; every write is the request service's.
 */
export class ServiceRefundDecisionService {
  constructor(private readonly deps: ServiceRefundDecisionServiceDeps) {}

  /** The card's approve button: open the amount prompt. */
  openApprove(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly botInstanceId: BotInstanceId;
      readonly requestId: string;
      /** The tap's Telegram `update_id`: the prompt then reads only newer messages. */
      readonly updateId?: bigint;
    },
  ): Promise<DecisionOpenResult> {
    return this.open(scope, actor, input, 'SERVICE_REFUND_AMOUNT');
  }

  /** The card's reject button: open the reason prompt. */
  openReject(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly botInstanceId: BotInstanceId;
      readonly requestId: string;
      /** The tap's Telegram `update_id`: the prompt then reads only newer messages. */
      readonly updateId?: bigint;
    },
  ): Promise<DecisionOpenResult> {
    return this.open(scope, actor, input, 'SERVICE_REFUND_REJECT_REASON');
  }

  /**
   * An administrator's plain message: an amount or a reason, IF one of their refund-request
   * prompts is waiting for it. `NO_CAPTURE` — the answer for almost every message — is a
   * READ keyed on their own id, reached before any permission is charged.
   */
  async submitText(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly text: string;
      /** The message's Telegram `update_id`; a prompt reads only messages newer than its tap. */
      readonly updateId?: bigint;
    },
  ): Promise<DecisionTextResult> {
    const adminId = adminIdOrNull(actor);
    if (adminId === null) return { outcome: 'NO_CAPTURE' };
    /*
     * A redelivered amount message (Codex review of #83, round 4). The first delivery
     * recorded the amount, so no prompt is waiting for one any more, and the redelivery
     * would be answered with nothing — the confirmation button lost with the first reply.
     * The first delivery remembered which prompt it filled; while that prompt is still
     * open it is restated, and the approval behind its button decides everything again.
     */
    const requestHash = hashRequest({
      bot: input.botInstanceId,
      text: input.text,
      serviceRefundText: true,
    });
    const replayed = await this.deps.idempotency.find<{ captureId: string }>(
      scope,
      TEXT_NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );
    if (replayed !== null) {
      /*
       * A known replay is answered from the prompt it filled and goes NOWHERE else (Codex
       * review of #83, round 5). Offered to the prompt open now, a redelivered amount could
       * become the reason of a later rejection prompt — and a rejection is decided on its
       * reason at once.
       */
      return (
        (await this.enteredAgain(scope, actor, replayed.result.captureId)) ?? { outcome: 'CLOSED' }
      );
    }
    const remember = { key: input.idempotencyKey, hash: requestHash };
    const amountCapture = await this.deps.captures.findAwaitingAmount(
      scope,
      input.botInstanceId,
      adminId,
      undefined,
      'SERVICE_REFUND_AMOUNT',
    );
    if (amountCapture !== null && isNewerThan(input.updateId, amountCapture)) {
      return this.submitAmount(scope, actor, amountCapture, input.text, remember);
    }
    const reasonCapture = await this.deps.captures.findAwaitingReason(
      scope,
      input.botInstanceId,
      adminId,
      'SERVICE_REFUND_REJECT_REASON',
    );
    if (reasonCapture !== null && isNewerThan(input.updateId, reasonCapture)) {
      return this.submitReason(scope, actor, reasonCapture, input.text, remember);
    }
    return { outcome: 'NO_CAPTURE' };
  }

  /**
   * The final confirmation: close the prompt as CONFIRMED, then approve its amount.
   *
   * Closed FIRST and approved after. A prompt found already CONFIRMED is approved again with
   * the same amount, which the approval answers with the request as it stands — so a double
   * tap is one approval, and a crash between the close and the approval is finished by the
   * next tap rather than stranded.
   */
  async confirmApprove(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly captureId: string },
  ): Promise<DecisionConfirmResult> {
    const adminId = adminIdOf(actor);
    const captureId = captureIdOf(input.captureId);
    const denial = denialFor(captureId);
    await this.authorize(scope, actor, denial);

    const decided = await this.mutate(scope, actor, denial, async (tx) => {
      const found = await this.deps.captures.findById(scope, captureId, tx);
      if (found === null || found.adminId !== adminId) return { outcome: 'GONE' } as const;
      await this.deps.captures.lockForAdmin(scope, found.botInstanceId, adminId, tx);
      const capture = await this.deps.captures.findById(scope, captureId, tx);
      if (
        capture === null ||
        capture.purpose !== 'SERVICE_REFUND_AMOUNT' ||
        capture.amountMinor === null ||
        capture.serviceRefundRequestId === null
      ) {
        return { outcome: 'GONE' } as const;
      }
      if (capture.closeReason === 'CONFIRMED') return { outcome: 'APPROVE', capture } as const;
      if (capture.closeReason !== null) return closedOutcome(capture.closeReason);
      const now = this.deps.clock.now();
      if (now.getTime() >= capture.expiresAt.getTime()) {
        await this.deps.captures.close(scope, capture.id, 'EXPIRED', now, tx);
        return { outcome: 'EXPIRED' } as const;
      }
      if (!(await this.deps.captures.close(scope, capture.id, 'CONFIRMED', now, tx))) {
        // Read back rather than assumed: a close that did not happen is never followed by
        // an approval.
        const standing = await this.deps.captures.findById(scope, captureId, tx);
        if (standing?.closeReason === 'CONFIRMED') {
          return { outcome: 'APPROVE', capture: standing } as const;
        }
        return closedOutcome(standing?.closeReason ?? 'CANCELLED');
      }
      return { outcome: 'APPROVE', capture } as const;
    });
    if (decided.outcome !== 'APPROVE') return decided;

    const requestId = decided.capture.serviceRefundRequestId as string;
    const amountMinor = decided.capture.amountMinor as bigint;
    try {
      const request = await this.deps.requests.approve(scope, actor, { requestId, amountMinor });
      // A replay of this same approval answers with the request as it stands, which may be
      // past EXECUTING by now: a deletion that finished is not "started".
      if (request.state !== 'EXECUTING') return { outcome: 'CLOSED' };
      return { outcome: 'EXECUTING', request };
    } catch (error) {
      // Classified first: an error this workflow does not know is rethrown with the capture
      // still CONFIRMED, so a retry of an indeterminate failure is still the same approval.
      const refused = await this.refusalOf(scope, actor, requestId, error);
      // A definitive refusal retires the confirmation. The administrator is told the approval
      // failed; the same old button, tapped later when the panel or the payment's bound has
      // recovered, must not then carry it out without a new confirmation.
      await this.mutate(scope, actor, denial, async (tx) => {
        await this.deps.captures.retireConfirmed(scope, captureId, tx);
      });
      return refused;
    }
  }

  /** The cancel button of either prompt. Nothing has moved, and after this nothing will. */
  async cancel(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly captureId: string },
  ): Promise<DecisionCancelResult> {
    const adminId = adminIdOf(actor);
    const captureId = captureIdOf(input.captureId);
    const denial = denialFor(captureId);
    await this.authorize(scope, actor, denial);
    return this.mutate(scope, actor, denial, async (tx) => {
      const found = await this.deps.captures.findById(scope, captureId, tx);
      if (found === null || found.adminId !== adminId || !isDecisionPurpose(found.purpose)) {
        return { outcome: 'GONE' } as const;
      }
      // The admin lock the confirmation takes: a cancel and a confirm tapped together are
      // serial, and the second reads the first.
      await this.deps.captures.lockForAdmin(scope, found.botInstanceId, adminId, tx);
      const capture = await this.deps.captures.findById(scope, captureId, tx);
      if (capture === null) return { outcome: 'GONE' } as const;
      if (capture.closeReason === 'CONFIRMED') return { outcome: 'CONFIRMED' } as const;
      if (
        capture.closeReason === null &&
        !(await this.deps.captures.close(scope, capture.id, 'CANCELLED', this.deps.clock.now(), tx))
      ) {
        const standing = await this.deps.captures.findById(scope, captureId, tx);
        if (standing?.closeReason === 'CONFIRMED') return { outcome: 'CONFIRMED' } as const;
      }
      return { outcome: 'CANCELLED' } as const;
    });
  }

  // -------------------------------------------------------------------------

  private async open(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly botInstanceId: BotInstanceId;
      readonly requestId: string;
      readonly updateId?: bigint;
    },
    purpose: 'SERVICE_REFUND_AMOUNT' | 'SERVICE_REFUND_REJECT_REASON',
  ): Promise<DecisionOpenResult> {
    const adminId = adminIdOf(actor);
    const denial = {
      action: 'service_refund_request.decision_capture',
      entityType: 'ServiceRefundRequest',
      entityId: input.requestId,
    };
    await this.authorize(scope, actor, denial);
    let review: ServiceRefundReview;
    try {
      review = await this.deps.requests.reviewForDecision(scope, actor, input.requestId);
    } catch (error) {
      if (
        isNexaError(error) &&
        error.code === COMMERCE_ERROR_CODES.SERVICE_REFUND_REQUEST_NOT_FOUND
      ) {
        return { outcome: 'CLOSED' };
      }
      throw error;
    }
    if (review.request.state !== 'OPEN') return { outcome: 'CLOSED' };
    // A rejection needs neither the service nor any money left; an approval needs both.
    if (
      purpose === 'SERVICE_REFUND_AMOUNT' &&
      (review.service === null || review.remaining.amountMinor <= 0n)
    ) {
      return { outcome: 'NOT_EXECUTABLE' };
    }
    return this.mutate(scope, actor, denial, async (tx) => {
      await this.deps.captures.lockForAdmin(scope, input.botInstanceId, adminId, tx);
      const now = this.deps.clock.now();
      const capture = await this.deps.captures.open(
        scope,
        {
          id: this.deps.ids.uuid(),
          botInstanceId: input.botInstanceId,
          adminId,
          serviceRefundRequestId: review.request.id,
          purpose,
          openedAt: now,
          expiresAt: new Date(now.getTime() + ADMIN_AMOUNT_CAPTURE_TTL_MS),
          ...(input.updateId === undefined ? {} : { openedUpdateId: input.updateId }),
        },
        tx,
      );
      return { outcome: 'OPENED', capture, review } as const;
    });
  }

  private async submitAmount(
    scope: TenantContext,
    actor: ActorContext,
    waiting: AdminAmountCaptureRecord,
    text: string,
    remember: { readonly key: string; readonly hash: string },
  ): Promise<DecisionTextResult> {
    const requestId = waiting.serviceRefundRequestId;
    /* istanbul ignore next -- the table's target CHECK: this purpose names a request. */
    if (requestId === null) return { outcome: 'NO_CAPTURE' };
    const now = this.deps.clock.now();
    if (now.getTime() >= waiting.expiresAt.getTime()) {
      await this.closeIfOpen(scope, actor, waiting, 'EXPIRED');
      return { outcome: 'EXPIRED' };
    }
    let review: ServiceRefundReview;
    try {
      review = await this.deps.requests.reviewForDecision(scope, actor, requestId);
    } catch (error) {
      /*
       * Only a request that is gone or decided closes the prompt (Codex review of #83,
       * round 4). A failed read — a dropped connection, a revoked permission — says nothing
       * about the request, and closing on it would leave an OPEN request whose approver
       * must open the prompt again for no reason they were told.
       */
      if (
        !isNexaError(error) ||
        (error.code !== COMMERCE_ERROR_CODES.SERVICE_REFUND_REQUEST_NOT_FOUND &&
          error.code !== COMMERCE_ERROR_CODES.SERVICE_REFUND_REQUEST_STATE_INVALID)
      ) {
        throw error;
      }
      await this.closeIfOpen(scope, actor, waiting, 'SUPERSEDED');
      return { outcome: 'CLOSED' };
    }
    if (review.request.state !== 'OPEN') {
      await this.closeIfOpen(scope, actor, waiting, 'SUPERSEDED');
      return { outcome: 'CLOSED' };
    }
    const amount = parseTypedAmount(text, review.request.principal.currency);
    if (amount === null) return { outcome: 'INVALID_AMOUNT', remaining: review.remaining };
    // The figure the confirmation will state is one the server has just checked under the
    // payment's lock — never one a message rendered.
    try {
      await this.deps.requests.preview(scope, actor, {
        requestId,
        amountMinor: amount.amountMinor,
      });
    } catch (error) {
      const refused = await this.refusalOf(scope, actor, requestId, error);
      if (refused.outcome === 'CLOSED') await this.closeIfOpen(scope, actor, waiting, 'SUPERSEDED');
      if (
        refused.outcome === 'CLOSED' ||
        refused.outcome === 'NOT_EXECUTABLE' ||
        refused.outcome === 'INVALID_AMOUNT'
      ) {
        return refused;
      }
      /* istanbul ignore next -- `refusalOf` rethrows anything else. */
      return { outcome: 'CLOSED' };
    }

    const denial = denialFor(waiting.id);
    const adminId = adminIdOf(actor);
    const recorded = await this.mutate(scope, actor, denial, async (tx) => {
      await this.deps.captures.lockForAdmin(scope, waiting.botInstanceId, adminId, tx);
      // Read again under the lock: two messages arriving together are one amount.
      const capture = await this.deps.captures.findById(scope, waiting.id, tx);
      if (capture === null || capture.closedAt !== null || capture.amountMinor !== null) {
        return null;
      }
      if (!(await this.deps.captures.recordAmount(scope, capture.id, amount.amountMinor, tx))) {
        return null;
      }
      await rememberOnce(
        this.deps.idempotency,
        scope,
        TEXT_NAMESPACE,
        remember.key,
        remember.hash,
        { captureId: capture.id },
        tx,
      );
      return { ...capture, amountMinor: amount.amountMinor };
    });
    if (recorded === null) return { outcome: 'NO_CAPTURE' };
    return { outcome: 'AMOUNT_ENTERED', capture: recorded, amount, review };
  }

  /**
   * The confirmation a redelivered amount message is owed: its prompt restated with the
   * amount it recorded, while that prompt is still open and its request still OPEN.
   * `null` otherwise — the message is then an ordinary one, and finds no prompt.
   */
  private async enteredAgain(
    scope: TenantContext,
    actor: ActorContext,
    captureId: string,
  ): Promise<DecisionTextResult | null> {
    const capture = await this.deps.captures.findById(scope, captureId);
    if (
      capture === null ||
      capture.closedAt !== null ||
      capture.amountMinor === null ||
      capture.serviceRefundRequestId === null ||
      capture.adminId !== adminIdOrNull(actor)
    ) {
      return null;
    }
    const review = await this.deps.requests.reviewForDecision(
      scope,
      actor,
      capture.serviceRefundRequestId,
    );
    if (review.request.state !== 'OPEN') return null;
    const amount = money(capture.amountMinor, review.request.principal.currency);
    return { outcome: 'AMOUNT_ENTERED', capture, amount, review };
  }

  private async submitReason(
    scope: TenantContext,
    actor: ActorContext,
    waiting: AdminAmountCaptureRecord,
    text: string,
    remember: { readonly key: string; readonly hash: string },
  ): Promise<DecisionTextResult> {
    const requestId = waiting.serviceRefundRequestId;
    /* istanbul ignore next -- the table's target CHECK: this purpose names a request. */
    if (requestId === null) return { outcome: 'NO_CAPTURE' };
    const reason = text.trim();
    if (reason.length === 0 || Array.from(reason).length > ADMIN_CAPTURE_REASON_MAX_LENGTH) {
      return { outcome: 'INVALID_REASON' };
    }
    const now = this.deps.clock.now();
    if (now.getTime() >= waiting.expiresAt.getTime()) {
      await this.closeIfOpen(scope, actor, waiting, 'EXPIRED');
      return { outcome: 'EXPIRED' };
    }
    /*
     * The prompt and the rejection in ONE transaction, under the administrator's capture
     * lock — the lock `cancel` and `open` take. The prompt is read again under it and must
     * still be open: a prompt cancelled, or replaced by another, a moment before this message
     * was read decides nothing. And the rejection commits with the prompt's close, so
     * neither is ever left without the other; a redelivered message finds no open prompt.
     */
    const adminId = adminIdOf(actor);
    try {
      const request = await this.mutate(scope, actor, denialFor(waiting.id), async (tx) => {
        await this.deps.captures.lockForAdmin(scope, waiting.botInstanceId, adminId, tx);
        const capture = await this.deps.captures.findById(scope, waiting.id, tx);
        if (capture === null || capture.closedAt !== null) return null;
        const rejected = await this.deps.requests.rejectWithin(
          scope,
          actor,
          { requestId, reason },
          tx,
        );
        await this.deps.captures.recordReason(scope, capture.id, reason, tx);
        await this.deps.captures.close(scope, capture.id, 'CONFIRMED', this.deps.clock.now(), tx);
        // Its redelivery is then a known replay, answered and never offered to a newer prompt.
        await rememberOnce(
          this.deps.idempotency,
          scope,
          TEXT_NAMESPACE,
          remember.key,
          remember.hash,
          { captureId: capture.id },
          tx,
        );
        return rejected;
      });
      if (request === null) return { outcome: 'NO_CAPTURE' };
      return { outcome: 'REJECTED', request };
    } catch (error) {
      // Classified before the prompt is touched: a transient failure rolled the rejection and
      // the close back together, and is rethrown with the prompt — and the typed reason's
      // chance to be sent again — intact. Only a refusal that proves the request is decided or
      // not actionable closes it.
      const refused = await this.refusalOf(scope, actor, requestId, error);
      await this.closeIfOpen(scope, actor, waiting, 'SUPERSEDED');
      return refused.outcome === 'NOT_EXECUTABLE' ? refused : { outcome: 'CLOSED' };
    }
  }

  /**
   * The request service's refusals, as a prompt's answer. Anything that is not one of the
   * three this workflow expects is rethrown: a surface answers an unknown error with its own
   * refusal sentence, never with a guess.
   */
  private async refusalOf(
    scope: TenantContext,
    actor: ActorContext,
    requestId: string,
    error: unknown,
  ): Promise<
    | { readonly outcome: 'CLOSED' }
    | { readonly outcome: 'NOT_EXECUTABLE' }
    | { readonly outcome: 'INVALID_AMOUNT'; readonly remaining: Money }
  > {
    if (!isNexaError(error)) throw error;
    switch (error.code) {
      case COMMERCE_ERROR_CODES.SERVICE_REFUND_REQUEST_STATE_INVALID:
      case COMMERCE_ERROR_CODES.SERVICE_REFUND_REQUEST_NOT_FOUND:
        return { outcome: 'CLOSED' };
      case COMMERCE_ERROR_CODES.SERVICE_REFUND_NOT_ELIGIBLE:
      case COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND:
        return { outcome: 'NOT_EXECUTABLE' };
      case COMMERCE_ERROR_CODES.REFUND_EXCEEDS_REFUNDABLE: {
        const review = await this.deps.requests.reviewForDecision(scope, actor, requestId);
        return { outcome: 'INVALID_AMOUNT', remaining: review.remaining };
      }
      default:
        throw error;
    }
  }

  private async closeIfOpen(
    scope: TenantContext,
    actor: ActorContext,
    capture: AdminAmountCaptureRecord,
    reason: AdminAmountCaptureCloseReason,
  ): Promise<void> {
    await this.mutate(scope, actor, denialFor(capture.id), async (tx) => {
      await this.deps.captures.close(scope, capture.id, reason, this.deps.clock.now(), tx);
    });
  }

  /** Every write here: `refunds.issue` re-checked inside the transaction, and the scope's activity. */
  private mutate<T>(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
    fn: (tx: TransactionScope) => Promise<T>,
  ): Promise<T> {
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      'refunds.issue',
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        return fn(tx);
      },
    );
  }

  /** Both decision keys, before any prompt is opened or confirmed: deny by default at each step. */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    for (const permission of SERVICE_REFUND_DECIDE_PERMISSIONS) {
      try {
        await this.deps.guard.check(scope, actor, permission);
      } catch (error) {
        await recordMutationDenial(this.mutationDeps(), scope, actor, permission, denial, error);
        throw error;
      }
    }
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
}

function isDecisionPurpose(purpose: string): boolean {
  return purpose === 'SERVICE_REFUND_AMOUNT' || purpose === 'SERVICE_REFUND_REJECT_REASON';
}

function closedOutcome(
  reason: AdminAmountCaptureCloseReason,
): { readonly outcome: 'CANCELLED' } | { readonly outcome: 'EXPIRED' } {
  return reason === 'CANCELLED' ? { outcome: 'CANCELLED' } : { outcome: 'EXPIRED' };
}

function denialFor(captureId: string) {
  return {
    action: 'service_refund_request.decision_capture',
    entityType: 'AdminAmountCapture',
    entityId: captureId,
  };
}

function adminIdOrNull(actor: ActorContext): string | null {
  return (actor.type === 'WEB_ADMIN' || actor.type === 'TELEGRAM_ADMIN') && actor.id !== null
    ? actor.id
    : null;
}

function adminIdOf(actor: ActorContext): string {
  const id = adminIdOrNull(actor);
  if (id !== null) return id;
  throw errors.permissionDenied(
    PLATFORM_ERROR_CODES.PERMISSION_DENIED,
    'Only an administrator can decide a refund request.',
  );
}

function captureIdOf(candidate: string): string {
  const parsed = uuidV7Schema.safeParse(candidate);
  // An id that is not one names no capture: the same answer as another person's.
  return parsed.success ? parsed.data : '00000000-0000-7000-8000-000000000000';
}
