import {
  COMMERCE_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  errors,
  money,
  paymentIdSchema,
  receiptCreditCommandSchema,
  receiptCreditReference,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PaymentId,
  type PermissionKey,
  type ReceiptCreditCommand,
  type SalesCurrencyCode,
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
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { WalletRepository } from '../../wallet/application/ports.js';
import type { PaymentRecord, PaymentRepository } from './ports.js';
import type { PaymentReceiptRepository } from './receipt-ports.js';
import type { ReceiptCreditRecord, ReceiptCreditRepository } from './receipt-credit-ports.js';

/**
 * The authority a receipt's credit-to-wallet needs: BOTH of these.
 *
 * `receipts.review`, because it is a disposition of a receipt — the permission that
 * approves or rejects the same receipt. And `users.wallet.credit`, because it puts an
 * amount the reviewer TYPED into a wallet, which is exactly what that key guards. An
 * installation that separates a receipt reviewer from finance keeps that separation: the
 * seeded `receipt_reviewer` holds the first and not the second, so it may still approve
 * and reject and is refused this. Deny by default — both are checked, neither implies the
 * other.
 */
export const RECEIPT_CREDIT_REVIEW_PERMISSION: PermissionKey = 'receipts.review';
export const RECEIPT_CREDIT_WALLET_PERMISSION: PermissionKey = 'users.wallet.credit';
/** Reading a disposition is reading the payment. */
export const RECEIPT_CREDIT_VIEW_PERMISSION: PermissionKey = 'payments.view';

/**
 * The namespace an operator's review arrives through — the one `confirmManualTransfer`
 * and `rejectManualTransfer` use, from the Web Admin and the Telegram panel alike. Shared
 * on purpose: a key reused across approve, reject and credit is a PAYLOAD mismatch (each
 * hash names its decision), never a replay that answers one decision with another.
 */
const OPERATOR_NAMESPACE = 'WEB' as const;

export interface ReceiptDispositionServiceDeps {
  /** The payment's READ, its row lock and its one resolving edge. Nothing else. */
  readonly payments: Pick<PaymentRepository, 'findById' | 'findByIdForUpdate' | 'resolve'>;
  /** Counting receipts: a credit disposes of a receipt, so there has to be one. */
  readonly receipts: Pick<PaymentReceiptRepository, 'countForPayment'>;
  readonly credits: ReceiptCreditRepository;
  /** `append` and `lockCustomer` only: a credit, under the lock every ledger write takes. */
  readonly wallet: Pick<WalletRepository, 'append' | 'lockCustomer'>;
  /** Reads `sales.currency`: a wallet is credited only in what this installation sells in. */
  readonly settings: SettingsResolver;
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

/** The payment, now FAILED, and the disposition standing on it. */
export interface ReceiptCreditOutcome {
  readonly payment: PaymentRecord;
  readonly credit: ReceiptCreditRecord;
}

/**
 * A card-to-card receipt's third disposition: crediting what the reviewer judged arrived
 * to the customer's wallet (Payment File 02 §11–§12, `docs/payments-file02-design.md`
 * D2).
 *
 * Approve is `PaymentService.confirmManualTransfer` and reject is
 * `rejectManualTransfer`; this is the one that needed a service of its own, because it is
 * the only one that moves an amount the payment does not already name.
 *
 * ## What makes the three mutually exclusive (invariant 7)
 *
 * All three take the payment out of `PENDING` through a conditional UPDATE — approve
 * through `confirm`, reject and this through `resolve(..., 'FAILED')` — and only one of
 * any two can match `state = 'PENDING'`. This takes the payment's row lock FIRST, so a
 * racer either precedes it (and this reads the resolved state and refuses) or waits for
 * it (and its own UPDATE then matches nothing). The loser is answered
 * `PAYMENT_STATE_INVALID` and nothing of its commits.
 *
 * ## What makes it at most once (invariant 8)
 *
 * Twice over, and each on its own: `receipt_credits`' primary key on the payment, and
 * `wallet_entries_receipt_credit_payment_key` on the ledger — plus the reference
 * `<paymentId>:receipt-credit`, derived from the payment rather than from either
 * reviewer's key.
 *
 * ## What it does NOT do
 *
 * It does not settle the order: a manual credit is not a payment of it. The order stays
 * `AWAITING_PAYMENT`, and the customer may pay it from the wallet — the credit included
 * — or let it expire. And it earns no top-up gift: a receipt credit is not a successful
 * top-up, whatever the payment was for.
 */
export class ReceiptDispositionService {
  constructor(private readonly deps: ReceiptDispositionServiceDeps) {}

  async creditToWallet(
    scope: TenantContext,
    actor: ActorContext,
    command: ReceiptCreditCommand,
  ): Promise<ReceiptCreditOutcome> {
    const paymentId = this.paymentId(command.paymentId);
    const denial = { action: 'payment.receipt_credit', entityType: 'Payment', entityId: paymentId };
    // Both keys, before the replay lookup: a replay returns a payment and a credit, and a
    // caller who may not credit must not be handed either by guessing a key.
    await this.authorize(scope, actor, RECEIPT_CREDIT_REVIEW_PERMISSION, denial);
    await this.authorize(scope, actor, RECEIPT_CREDIT_WALLET_PERMISSION, denial);

    const parsed = receiptCreditCommandSchema.safeParse(command);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'A receipt credit needs a positive amount within the bound and a short note.',
        { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
      );
    }
    const input = parsed.data;

    /*
     * The AMOUNT is part of the identity, and so is the decision. A replay of the same
     * command answers with the first result; the same key with a different amount is a
     * payload mismatch, refused — never a second credit and never the first one relabelled.
     */
    const requestHash = hashRequest({
      paymentId,
      decision: 'CREDIT',
      amountMinor: input.amountMinor.toString(),
      note: input.note,
    });
    const replayed = await this.replayed(scope, input.idempotencyKey, requestHash, paymentId);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();
    const decidedBy = this.adminIdOf(actor);

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      RECEIPT_CREDIT_REVIEW_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.recheckWalletAuthority(scope, actor, denial, tx);

        /*
         * The payment's row FIRST, and every fact read after it. The lock the approve and
         * reject UPDATEs and `ReceiptService.submit` all take, so the state and the
         * receipt count below cannot be stale.
         */
        const payment = await this.deps.payments.findByIdForUpdate(scope, paymentId, tx);
        if (payment === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.');
        }
        if (payment.method !== 'MANUAL_TRANSFER' || payment.state !== 'PENDING') {
          const standing = await this.deps.credits.findByPayment(scope, paymentId, tx);
          throw errors.conflict(
            COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID,
            'This payment was already resolved and cannot be credited to the wallet.',
            {
              state: payment.state,
              ...(standing === null ? {} : { disposition: 'CREDITED_TO_WALLET' }),
            },
          );
        }
        if ((await this.deps.receipts.countForPayment(scope, paymentId, tx)) === 0) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID,
            'This transfer carries no receipt to credit.',
            { state: payment.state, reason: 'NO_RECEIPT' },
          );
        }

        /*
         * The wallet is credited only in what this installation sells in — the rule
         * `confirmAndCredit` applies to a top-up, for its reason: a balance no order can
         * be priced against is `WALLET_CURRENCY_UNSUPPORTED`'s own definition.
         */
        const selling = await this.deps.settings.valueOf<SalesCurrencyCode>(
          scope,
          'sales.currency',
          tx,
        );
        if (payment.amount.currency !== selling) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.WALLET_CURRENCY_UNSUPPORTED,
            'This transfer is denominated in a currency this installation no longer sells in.',
          );
        }

        /*
         * The customer's lock BEFORE the append, matching every other writer of this
         * ledger, and AFTER the payment's, the order `RefundService` takes the same two
         * in — and `signalTransferSent` and `settleFromWallet` too: row, then customer.
         */
        if (!(await this.deps.wallet.lockCustomer(scope, payment.customerId, tx))) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
        }

        /*
         * PENDING -> FAILED through the one conditional edge a rejection also uses. Under
         * the lock above it cannot lose, and it is still asked: the boolean is the
         * mechanism, and a caller that ignored it would record a disposition that did
         * not happen.
         */
        const moved = await this.deps.payments.resolve(
          scope,
          paymentId,
          'FAILED',
          { resolvedByAdminId: decidedBy, resolutionNote: input.note, resolvedAt: now },
          now,
          tx,
        );
        if (!moved) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID,
            'This payment was already resolved and cannot be credited to the wallet.',
          );
        }

        const amount = money(input.amountMinor, payment.amount.currency);
        const { entry, inserted } = await this.deps.wallet.append(
          scope,
          {
            id: this.deps.ids.uuid(),
            customerId: payment.customerId,
            direction: 'CREDIT',
            reason: 'RECEIPT_CREDIT',
            // The REVIEWER's figure, in the payment's currency. 0114 refuses a
            // disposition whose entry holds anything else.
            amount,
            reference: receiptCreditReference(payment.id),
            orderId: payment.orderId,
            paymentId: payment.id,
            actorAdminId: decidedBy,
            note: input.note,
            now,
          },
          tx,
        );
        /*
         * An entry already under this payment's reference is money a writer credited
         * without the disposition. It is not this command's to adopt — the payment was
         * PENDING a statement ago, so nothing of ours wrote it — and the whole command
         * rolls back rather than recording a disposition a reviewer did not make.
         */
        if (!inserted) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID,
            'This payment has already been credited to the wallet.',
            { disposition: 'CREDITED_TO_WALLET' },
          );
        }

        const credit = await this.deps.credits.record(
          scope,
          {
            paymentId: payment.id,
            amount,
            walletEntryId: entry.id,
            decidedByAdminId: decidedBy,
            decidedAt: now,
            note: input.note,
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
            action: 'payment.receipt_credit',
            entityType: 'Payment',
            entityId: payment.id,
            before: { state: payment.state },
            after: {
              state: 'FAILED',
              disposition: 'CREDITED_TO_WALLET',
              orderId: payment.orderId,
              // What the payment asked for and what the reviewer credited: the
              // difference, when there is one, is the reason this disposition exists.
              paymentAmountMinor: payment.amount.amountMinor.toString(),
              creditedMinor: amount.amountMinor.toString(),
              currency: amount.currency,
              walletEntryId: entry.id,
              // Stated because it is the surprising part: the order is not settled.
              orderLeftAwaitingPayment: payment.orderId !== null,
            },
            result: 'SUCCESS',
          },
          tx,
        );

        /*
         * The customer is told in THIS transaction, for the reason every money fact here
         * is: there is no window in which the credit exists and the sentence saying so
         * does not. The answer is not checked — a customer with no bot link has nobody
         * to tell, and a messaging concern may not veto a decision about money.
         */
        await this.deps.notifier.notify(
          scope,
          payment.customerId,
          'RECEIPT_CREDITED_TO_WALLET',
          payment.id,
          now,
          tx,
        );

        await rememberOnce(
          this.deps.idempotency,
          scope,
          OPERATOR_NAMESPACE,
          input.idempotencyKey,
          requestHash,
          { paymentId: payment.id },
          tx,
        );

        const resolved = await this.deps.payments.findById(scope, payment.id, tx);
        /* istanbul ignore next -- the UPDATE above reported one row; this cannot be null. */
        if (resolved === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.');
        }
        return { payment: resolved, credit };
      },
    );
  }

  /**
   * A payment's credit-to-wallet disposition, for the Web Admin's read-only detail.
   * Null for every payment that was not decided this way. Under `payments.view`.
   */
  async creditFor(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<ReceiptCreditRecord | null> {
    await this.deps.guard.check(scope, actor, RECEIPT_CREDIT_VIEW_PERMISSION);
    return this.deps.credits.findByPayment(scope, this.paymentId(id));
  }

  // -------------------------------------------------------------------------

  /**
   * `users.wallet.credit` again, inside the transaction that writes.
   *
   * The pre-check above records a denial the ordinary way; this is the same key read
   * under the transaction's own snapshot, so a grant revoked between the two refuses
   * rather than crediting. `runAuthorizedMutation` re-checks only the one key it is
   * given, which is `receipts.review`.
   */
  private async recheckWalletAuthority(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
    tx: TransactionScope,
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, RECEIPT_CREDIT_WALLET_PERMISSION, tx);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        RECEIPT_CREDIT_WALLET_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }

  /**
   * The administrator deciding. `decided_by_admin_id` is NOT NULL and an FK to admins:
   * a decision about somebody's money with nobody named is the legacy receipt review.
   * Both keys are held only by administrators, so this refuses nothing the guard let
   * through — it is the type's statement of that.
   */
  private adminIdOf(actor: ActorContext): string {
    if ((actor.type === 'WEB_ADMIN' || actor.type === 'TELEGRAM_ADMIN') && actor.id !== null) {
      return actor.id;
    }
    throw errors.permissionDenied(
      PLATFORM_ERROR_CODES.PERMISSION_DENIED,
      'Only an administrator can credit a receipt to a wallet.',
    );
  }

  private async replayed(
    scope: TenantContext,
    idempotencyKey: string,
    requestHash: string,
    paymentId: PaymentId,
  ): Promise<ReceiptCreditOutcome | null> {
    const found = await this.deps.idempotency.find<{ paymentId: string }>(
      scope,
      OPERATOR_NAMESPACE,
      idempotencyKey,
      requestHash,
    );
    if (found === null) return null;
    const [payment, credit] = await Promise.all([
      this.deps.payments.findById(scope, paymentId),
      this.deps.credits.findByPayment(scope, paymentId),
    ]);
    if (payment === null || credit === null) return null;
    return { payment, credit };
  }

  private paymentId(candidate: string): PaymentId {
    const parsed = paymentIdSchema.safeParse(candidate);
    if (!parsed.success) {
      // The answer a well-formed id from another tenant gets: no oracle, and no 500.
      throw errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.');
    }
    return parsed.data;
  }

  /** `recordMutationDenial`, not a bare check — see `ProductService.authorize`. */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    permission: PermissionKey,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (error) {
      await recordMutationDenial(this.mutationDeps(), scope, actor, permission, denial, error);
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
