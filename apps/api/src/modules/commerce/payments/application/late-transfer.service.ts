import {
  COMMERCE_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  errors,
  lateTransferReference,
  paymentIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type LateTransferDecision,
  type OperationalEventRecorder,
  type PaymentId,
  type PaymentRejectionReason,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { CustomerNotifier } from '../../messaging/application/customer-notifier.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { WalletRepository } from '../../wallet/application/ports.js';
import { lateReviewRefusal } from '../domain/late-review.js';
import type { LateTransferDecisionRecord, LateTransferRepository } from './late-transfer-ports.js';
import type { PaymentRecord, PaymentRepository } from './ports.js';
import type { PaymentReceiptRepository } from './receipt-ports.js';

/**
 * The authority that decides a late transfer.
 *
 * `receipts.review`, the permission that could have confirmed the same transfer inside
 * its window (`docs/wp10-payments-audit.md` P1). A credit to the wallet is the same money
 * reaching the customer by the only door still open, so it is the same decision by the
 * same person — and NOT `users.wallet.credit`, which `receipt_reviewer` does not hold and
 * which carries no payment to bound it.
 */
export const LATE_TRANSFER_PERMISSION: PermissionKey = 'receipts.review';
/** Reading the lane is reading payments. */
export const LATE_TRANSFER_VIEW_PERMISSION: PermissionKey = 'payments.view';

/** An operator's decision arrives through the Web Admin's namespace, like a confirmation. */
const OPERATOR_NAMESPACE = 'WEB' as const;

export interface LateTransferServiceDeps {
  /** The payment READ and its row lock. Nothing here moves a payment's state. */
  readonly payments: Pick<PaymentRepository, 'findById' | 'findByIdForUpdate'>;
  /** Counting receipts, which is half of what "vouched for" means. */
  readonly receipts: Pick<PaymentReceiptRepository, 'countForPayment'>;
  readonly decisions: LateTransferRepository;
  /** `append` and `lockCustomer` only: a credit, under the lock every ledger write takes. */
  readonly wallet: Pick<WalletRepository, 'append' | 'lockCustomer'>;
  readonly notifier: CustomerNotifier;
  readonly outbox: OutboxWriter;
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

/** A payment and the decision standing on it now. */
export interface LateTransferOutcome {
  readonly payment: PaymentRecord;
  readonly decision: LateTransferDecisionRecord;
}

/** What the payment surfaces show of the lane, per payment. */
export interface LateReviewView {
  readonly decision: LateTransferDecisionRecord | null;
  /** In the lane NOW: expired, a transfer, vouched for, and undecided. */
  readonly eligible: boolean;
}

/**
 * The late-review lane: money that arrived after its payment closed.
 *
 * `docs/wp10-payments-audit.md` P1, closing D1. The owner's expiry rule stands — the
 * payment and its order close at the deadline and nothing reopens either — and a
 * transfer the customer VOUCHED FOR (a signal or a receipt) still gets an outcome. Two,
 * exactly, recorded once:
 *
 * - **credit**: the payment's exact amount to the customer's wallet under
 *   `LATE_TRANSFER`, reference `<paymentId>:late`. The payment stays EXPIRED and the
 *   order stays closed; the customer may spend the credit on the same order again or on
 *   a new one.
 * - **dismiss**: nothing moves, and a `PAYMENT_REJECTION_REASONS` member says why.
 *
 * ## What makes it one decision
 *
 * The PAYMENT's row lock, taken first, with the decision read after it: two reviewers,
 * or a credit racing a dismissal, serialise there and the second reads the first's
 * decision and is refused `LATE_TRANSFER_ALREADY_DECIDED`. Beneath that, and each on its
 * own, the decision table's primary key and `wallet_entries_late_transfer_payment_key`
 * refuse a second decision and a second credit from a writer that skipped the lock.
 *
 * ## The lane is bounded by construction
 *
 * It holds only expired transfers somebody vouched for, and every item leaves it
 * through exactly one decision row, which nothing can edit or delete (0111).
 */
export class LateTransferService {
  constructor(private readonly deps: LateTransferServiceDeps) {}

  /** A reviewer finding the transfer: the exact amount goes to the wallet. */
  async credit(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    input: { readonly idempotencyKey: string },
  ): Promise<LateTransferOutcome> {
    const paymentId = this.paymentId(id);
    const denial = { action: 'payment.late_credit', entityType: 'Payment', entityId: paymentId };
    await this.authorize(scope, actor, denial);

    /*
     * The DECISION is part of the identity, as `confirmManualTransfer` puts it for
     * approve and reject: the two commands share a namespace and would otherwise share a
     * hash, and a key reused across them must be a mismatch rather than a replay that
     * answers "credited" for a dismissal.
     */
    const requestHash = hashRequest({ paymentId, decision: 'CREDITED' });
    const replayed = await this.replayed(scope, input.idempotencyKey, requestHash, paymentId);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      LATE_TRANSFER_PERMISSION,
      denial,
      async (tx) => {
        const payment = await this.lockEligible(scope, paymentId, tx);
        const decidedBy = this.adminIdOf(actor);

        /*
         * The customer's lock BEFORE the append, matching every other write to this
         * ledger: a credit cannot overdraw, but one lock order everywhere is what keeps
         * two movements of one wallet from deadlocking. After the payment's, which is
         * the order `RefundService` takes the same two in.
         */
        if (!(await this.deps.wallet.lockCustomer(scope, payment.customerId, tx))) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
        }

        const { entry, inserted } = await this.deps.wallet.append(
          scope,
          {
            id: this.deps.ids.uuid(),
            customerId: payment.customerId,
            direction: 'CREDIT',
            reason: 'LATE_TRANSFER',
            // The payment's OWN frozen amount — what the customer was told to send. The
            // request carries no figure, and 0111 refuses a decision that disagrees.
            amount: payment.amount,
            reference: lateTransferReference(payment.id),
            orderId: payment.orderId,
            paymentId: payment.id,
            actorAdminId: decidedBy,
            note: null,
            now,
          },
          tx,
        );
        /*
         * An entry already under this payment's reference, with no decision row beside
         * it, is money a writer credited without deciding. It is not this command's to
         * adopt: the credit happened once, and a decision recorded now would claim a
         * reviewer made it. Refused as decided, which is what the money says.
         */
        if (!inserted) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.LATE_TRANSFER_ALREADY_DECIDED,
            'This late transfer has already been credited.',
            { decision: 'CREDITED' },
          );
        }

        const decision = await this.deps.decisions.record(
          scope,
          {
            paymentId: payment.id,
            decision: 'CREDITED',
            reason: null,
            note: null,
            amount: payment.amount,
            walletEntryId: entry.id,
            decidedByAdminId: decidedBy,
            decidedAt: now,
          },
          tx,
        );

        await this.deps.outbox.write(tx, actor, {
          eventType: 'WalletEntryRecorded',
          aggregateType: 'Wallet',
          aggregateId: entry.customerId,
          payload: {
            customerId: entry.customerId,
            entryId: entry.id,
            direction: entry.direction,
            reason: entry.reason,
            amountMinor: entry.amount.amountMinor.toString(),
            currency: entry.amount.currency,
          },
        });

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'payment.late_credit',
            entityType: 'Payment',
            entityId: payment.id,
            before: { state: payment.state, lateDecision: null },
            after: {
              state: payment.state,
              lateDecision: 'CREDITED',
              orderId: payment.orderId,
              amountMinor: payment.amount.amountMinor.toString(),
              currency: payment.amount.currency,
              walletEntryId: entry.id,
            },
            result: 'SUCCESS',
          },
          tx,
        );

        /*
         * The customer is told in THIS transaction, for the reason every money fact on
         * this lane is: there is no window in which the credit exists and the sentence
         * saying so does not. The answer is not checked — a customer with no bot link
         * has nobody to tell, and a messaging concern may not veto a decision about money.
         */
        await this.deps.notifier.notify(
          scope,
          payment.customerId,
          'LATE_TRANSFER_CREDITED',
          payment.id,
          now,
          tx,
        );

        await this.remember(scope, input.idempotencyKey, requestHash, payment.id, tx);
        return { payment, decision };
      },
    );
  }

  /** A reviewer deciding the late transfer did not arrive, or not as it should. */
  async dismiss(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    input: {
      readonly idempotencyKey: string;
      readonly reason: PaymentRejectionReason;
      readonly note: string | null;
    },
  ): Promise<LateTransferOutcome> {
    const paymentId = this.paymentId(id);
    const denial = { action: 'payment.late_dismiss', entityType: 'Payment', entityId: paymentId };
    await this.authorize(scope, actor, denial);

    const requestHash = hashRequest({
      paymentId,
      decision: 'DISMISSED',
      reason: input.reason,
      note: input.note,
    });
    const replayed = await this.replayed(scope, input.idempotencyKey, requestHash, paymentId);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      LATE_TRANSFER_PERMISSION,
      denial,
      async (tx) => {
        const payment = await this.lockEligible(scope, paymentId, tx);

        const decision = await this.deps.decisions.record(
          scope,
          {
            paymentId: payment.id,
            decision: 'DISMISSED',
            reason: input.reason,
            note: input.note,
            amount: null,
            walletEntryId: null,
            decidedByAdminId: this.adminIdOf(actor),
            decidedAt: now,
          },
          tx,
        );

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'payment.late_dismiss',
            entityType: 'Payment',
            entityId: payment.id,
            before: { state: payment.state, lateDecision: null },
            after: {
              state: payment.state,
              lateDecision: 'DISMISSED',
              reason: input.reason,
              orderId: payment.orderId,
            },
            result: 'SUCCESS',
          },
          tx,
        );

        /*
         * `PAYMENT_REJECTED`, whose sentence already says a reviewer looked at the
         * transfer and did not accept it. The one kind per subject rule holds: an
         * EXPIRED payment was never rejected, so its subject is free.
         */
        await this.deps.notifier.notify(
          scope,
          payment.customerId,
          'PAYMENT_REJECTED',
          payment.id,
          now,
          tx,
        );

        await this.remember(scope, input.idempotencyKey, requestHash, payment.id, tx);
        return { payment, decision };
      },
    );
  }

  /**
   * The lane as the payment surfaces show it, for a page of payments.
   *
   * Two batched reads, and membership decided by `lateReviewRefusal` — the SAME function
   * `credit` and `dismiss` refuse with — so a row the list marks eligible is a row the
   * decision accepts.
   */
  async viewsFor(
    scope: TenantContext,
    actor: ActorContext,
    payments: readonly PaymentRecord[],
  ): Promise<ReadonlyMap<PaymentId, LateReviewView>> {
    await this.deps.guard.check(scope, actor, LATE_TRANSFER_VIEW_PERMISSION);
    const ids = payments.map((payment) => payment.id);
    const [decisions, receipts] = await Promise.all([
      this.deps.decisions.decisionsFor(scope, ids),
      this.deps.decisions.receiptCountsFor(scope, ids),
    ]);
    const views = new Map<PaymentId, LateReviewView>();
    for (const payment of payments) {
      const decision = decisions.get(payment.id) ?? null;
      views.set(payment.id, {
        decision,
        eligible:
          decision === null && lateReviewRefusal(payment, receipts.get(payment.id) ?? 0) === null,
      });
    }
    return views;
  }

  // -------------------------------------------------------------------------

  /**
   * The payment, LOCKED, and in the lane — or the refusal that says why not.
   *
   * The lock comes first and every fact is read after it, which is the whole of the
   * concurrency story: the decision read here cannot be stale, because the only writers
   * of a decision are this method's callers and they queue on this row.
   */
  private async lockEligible(
    scope: TenantContext,
    paymentId: PaymentId,
    tx: TransactionScope,
  ): Promise<PaymentRecord> {
    await this.assertScopeActive(scope, tx);
    const payment = await this.deps.payments.findByIdForUpdate(scope, paymentId, tx);
    if (payment === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.');
    }

    const standing = await this.deps.decisions.findDecision(scope, paymentId, tx);
    if (standing !== null) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.LATE_TRANSFER_ALREADY_DECIDED,
        'This late transfer has already been decided.',
        { decision: standing.decision satisfies LateTransferDecision },
      );
    }

    const receipts = await this.deps.receipts.countForPayment(scope, paymentId, tx);
    const refusal = lateReviewRefusal(payment, receipts);
    if (refusal !== null) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.LATE_TRANSFER_NOT_ELIGIBLE,
        'This payment is not waiting for a late review.',
        { reason: refusal, state: payment.state },
      );
    }
    return payment;
  }

  /**
   * The administrator deciding. `decided_by_admin_id` is NOT NULL and an FK to admins:
   * a decision about somebody's money with nobody named is the legacy receipt review.
   * `receipts.review` is held only by administrators, so this refuses nothing the guard
   * let through — it is the type's statement of that.
   */
  private adminIdOf(actor: ActorContext): string {
    if ((actor.type === 'WEB_ADMIN' || actor.type === 'TELEGRAM_ADMIN') && actor.id !== null) {
      return actor.id;
    }
    throw errors.permissionDenied(
      PLATFORM_ERROR_CODES.PERMISSION_DENIED,
      'Only an administrator can decide a late transfer.',
    );
  }

  private async replayed(
    scope: TenantContext,
    idempotencyKey: string,
    requestHash: string,
    paymentId: PaymentId,
  ): Promise<LateTransferOutcome | null> {
    const found = await this.deps.idempotency.find<{ paymentId: string }>(
      scope,
      OPERATOR_NAMESPACE,
      idempotencyKey,
      requestHash,
    );
    if (found === null) return null;
    const [payment, decision] = await Promise.all([
      this.deps.payments.findById(scope, paymentId),
      this.deps.decisions.findDecision(scope, paymentId),
    ]);
    if (payment === null || decision === null) return null;
    return { payment, decision };
  }

  private async remember(
    scope: TenantContext,
    idempotencyKey: string,
    requestHash: string,
    paymentId: PaymentId,
    tx: TransactionScope,
  ): Promise<void> {
    await rememberOnce(
      this.deps.idempotency,
      scope,
      OPERATOR_NAMESPACE,
      idempotencyKey,
      requestHash,
      { paymentId },
      tx,
    );
  }

  private paymentId(candidate: string): PaymentId {
    const parsed = paymentIdSchema.safeParse(candidate);
    if (!parsed.success) {
      // The answer a well-formed id from another tenant gets, for the reason
      // `RefundService.parseIdentifier` gives: no oracle, and no 500 for a bad segment.
      throw errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.');
    }
    return parsed.data;
  }

  /** `recordMutationDenial`, not a bare check — see `ProductService.authorize`. */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, LATE_TRANSFER_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        LATE_TRANSFER_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
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
