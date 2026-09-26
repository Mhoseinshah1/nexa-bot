import {
  ADMIN_AMOUNT_CAPTURE_TTL_MS,
  COMMERCE_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  errors,
  money,
  paymentIdSchema,
  uuidV7Schema,
  type ActorContext,
  type AdminAmountCaptureCloseReason,
  type AuditWriter,
  type BotInstanceId,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type Money,
  type OperationalEventRecorder,
  type PaymentId,
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
import type { CustomerRecord, CustomerRepository } from '../../customers/application/ports.js';
import type { PaymentRecord, PaymentRepository } from './ports.js';
import type { PaymentReceiptRepository } from './receipt-ports.js';
import type {
  AdminAmountCaptureRecord,
  AdminAmountCaptureRepository,
} from './admin-amount-capture-ports.js';
import {
  RECEIPT_CREDIT_REVIEW_PERMISSION,
  RECEIPT_CREDIT_WALLET_PERMISSION,
  type ReceiptCreditOutcome,
  type ReceiptDispositionService,
} from './receipt-disposition.service.js';
import { parseTypedAmount } from './typed-amount.js';

/**
 * Where the capture's own writes are remembered. Telegram, because that is the only surface
 * with a capture: the Web Admin is read-only for card-to-card (Payment File 02 §10).
 */
const CAPTURE_NAMESPACE = 'TELEGRAM' as const;

/**
 * The idempotency key a capture's confirmation credits under.
 *
 * DERIVED from the capture, never from the tap: a double tap, a redelivered tap and a tap
 * after a crash between the capture's close and the credit are all the same credit —
 * `creditToWallet` answers the second with the first's result. Exported so the tests can
 * name it rather than re-derive it.
 */
export function receiptCreditCaptureKey(captureId: string): string {
  return `receipt-credit-capture:${captureId}`;
}

/** The audit note the credit carries: through which surface it was taken. ASCII, like approve's. */
const CREDIT_NOTE = 'Credited to the wallet in the Telegram management panel.';

export interface ReceiptCreditCaptureServiceDeps {
  readonly captures: AdminAmountCaptureRepository;
  /** The payment READ alone: this service decides nothing about it. */
  readonly payments: Pick<PaymentRepository, 'findById'>;
  readonly receipts: Pick<PaymentReceiptRepository, 'countForPayment'>;
  readonly customers: Pick<CustomerRepository, 'findById'>;
  /** The ONE credit path. The capture only asks it, under a key derived from itself. */
  readonly dispositions: Pick<ReceiptDispositionService, 'creditToWallet'>;
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

/** What the reviewer is asked about, and who owes it. */
export interface CaptureSubject {
  readonly capture: AdminAmountCaptureRecord;
  readonly payment: PaymentRecord;
  readonly customer: CustomerRecord | null;
}

export type CaptureOpenResult =
  | ({ readonly outcome: 'OPENED' } & CaptureSubject)
  /** The payment is no longer a pending manual transfer. Nothing was opened. */
  | { readonly outcome: 'GONE' };

export type CaptureAmountResult =
  /** This administrator has no capture waiting for an amount on this bot. */
  | { readonly outcome: 'NO_CAPTURE' }
  /** Not an amount. The capture stays open, and the reviewer is asked again. */
  | { readonly outcome: 'INVALID'; readonly payment: PaymentRecord }
  | { readonly outcome: 'EXPIRED' }
  /** The payment was decided another way while the capture was open. */
  | { readonly outcome: 'GONE' }
  | ({ readonly outcome: 'ENTERED'; readonly amount: Money } & CaptureSubject);

export type CaptureConfirmResult =
  | {
      readonly outcome: 'CREDITED';
      readonly amount: Money;
      readonly result: ReceiptCreditOutcome;
    }
  /** Cancelled, superseded or expired before the confirmation. Nothing moved. */
  | { readonly outcome: 'CLOSED'; readonly reason: AdminAmountCaptureCloseReason }
  /** No such capture for this administrator, or one with no amount to confirm. */
  | { readonly outcome: 'GONE' };

export type CaptureCancelResult =
  | { readonly outcome: 'CANCELLED' }
  /** Already confirmed: a cancel cannot undo a credit. */
  | { readonly outcome: 'CONFIRMED' }
  | { readonly outcome: 'GONE' };

/**
 * The Telegram half of a receipt's credit-to-wallet disposition (Payment File 02 §12,
 * `docs/payments-file02-design.md` D3): ask for an amount, read ONE message, state the
 * amount, and only then credit it.
 *
 * ## Why a capture, and why this one is safe
 *
 * The amount is typed, and a prompt that reads the next message is what INCIDENT-FIN-001
 * was. So the prompt is a row (`admin_amount_captures`) that names ONE administrator, ONE
 * bot and ONE payment, expires in `ADMIN_AMOUNT_CAPTURE_TTL_MS`, and reads ONE amount: once
 * one is recorded it stops reading, so the figure a confirmation states cannot change
 * under it. Another administrator's message, a customer's message and a slash command never
 * reach it — the first two because the lookup is by the sender's own administrator id, the
 * third because a command is parsed before any plain text is offered here.
 *
 * ## What it does not decide
 *
 * Money. The confirmation calls `ReceiptDispositionService.creditToWallet`, the one credit
 * path, whose guard charges `receipts.review` AND `users.wallet.credit` again and whose
 * conditional UPDATE is what makes approve, reject and credit exclusive. The capture's own
 * permission checks are the same two keys, so an administrator who may not credit cannot
 * open a capture either — deny by default at every step, not only the last.
 */
export class ReceiptCreditCaptureService {
  constructor(private readonly deps: ReceiptCreditCaptureServiceDeps) {}

  /** The credit button: open a capture for this administrator and this payment. */
  async open(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly paymentId: string;
    },
  ): Promise<CaptureOpenResult> {
    const paymentId = this.paymentId(input.paymentId);
    const adminId = this.adminIdOf(actor);
    const denial = {
      action: 'payment.receipt_credit_capture',
      entityType: 'Payment',
      entityId: paymentId,
    };
    await this.authorize(scope, actor, RECEIPT_CREDIT_REVIEW_PERMISSION, denial);
    await this.authorize(scope, actor, RECEIPT_CREDIT_WALLET_PERMISSION, denial);

    const requestHash = hashRequest({ paymentId, bot: input.botInstanceId, open: true });
    const replayed = await this.deps.idempotency.find<{ captureId: string }>(
      scope,
      CAPTURE_NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );
    if (replayed !== null) {
      const subject = await this.subjectOf(scope, replayed.result.captureId);
      if (subject !== null) return { outcome: 'OPENED', ...subject };
    }

    return this.mutate(scope, actor, denial, async (tx) => {
      await this.deps.captures.lockForAdmin(scope, input.botInstanceId, adminId, tx);
      const payment = await this.deps.payments.findById(scope, paymentId, tx);
      if (payment === null) {
        throw errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.');
      }
      if (payment.method !== 'MANUAL_TRANSFER' || payment.state !== 'PENDING') {
        return { outcome: 'GONE' } as const;
      }
      // The credit refuses a transfer with no receipt; asking for an amount first would
      // be a question whose every answer is refused.
      if ((await this.deps.receipts.countForPayment(scope, paymentId, tx)) === 0) {
        throw errors.conflict(
          COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID,
          'This transfer carries no receipt to credit.',
          { state: payment.state, reason: 'NO_RECEIPT' },
        );
      }
      const now = this.deps.clock.now();
      const capture = await this.deps.captures.open(
        scope,
        {
          id: this.deps.ids.uuid(),
          botInstanceId: input.botInstanceId,
          adminId,
          paymentId,
          openedAt: now,
          expiresAt: new Date(now.getTime() + ADMIN_AMOUNT_CAPTURE_TTL_MS),
        },
        tx,
      );
      await rememberOnce(
        this.deps.idempotency,
        scope,
        CAPTURE_NAMESPACE,
        input.idempotencyKey,
        requestHash,
        { captureId: capture.id },
        tx,
      );
      const customer = await this.deps.customers.findById(scope, payment.customerId, tx);
      return { outcome: 'OPENED', capture, payment, customer } as const;
    });
  }

  /**
   * An administrator's plain message: an amount, IF their capture is waiting for one.
   *
   * `NO_CAPTURE` is the answer for almost every message an administrator sends, and it is
   * reached by a READ keyed on their own id, before any permission is charged — so an
   * administrator chatting to the bot is not recorded as denied something on every line.
   */
  async submitAmount(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly text: string;
    },
  ): Promise<CaptureAmountResult> {
    const adminId = this.adminIdOrNull(actor);
    if (adminId === null) return { outcome: 'NO_CAPTURE' };

    const requestHash = hashRequest({ bot: input.botInstanceId, text: input.text, amount: true });
    const replayed = await this.deps.idempotency.find<{ captureId: string }>(
      scope,
      CAPTURE_NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );
    if (replayed !== null) {
      const subject = await this.subjectOf(scope, replayed.result.captureId);
      if (subject !== null && subject.capture.amountMinor !== null) {
        const amount = money(subject.capture.amountMinor, subject.payment.amount.currency);
        return { outcome: 'ENTERED', amount, ...subject };
      }
    }

    const waiting = await this.deps.captures.findAwaitingAmount(
      scope,
      input.botInstanceId,
      adminId,
    );
    if (waiting === null) return { outcome: 'NO_CAPTURE' };

    const denial = {
      action: 'payment.receipt_credit_capture',
      entityType: 'Payment',
      entityId: waiting.paymentId,
    };
    return this.mutate(scope, actor, denial, async (tx) => {
      await this.deps.captures.lockForAdmin(scope, input.botInstanceId, adminId, tx);
      // Read again under the lock: two messages arriving together are one amount.
      const capture = await this.deps.captures.findAwaitingAmount(
        scope,
        input.botInstanceId,
        adminId,
        tx,
      );
      if (capture === null) return { outcome: 'NO_CAPTURE' } as const;

      const now = this.deps.clock.now();
      if (now.getTime() >= capture.expiresAt.getTime()) {
        await this.deps.captures.close(scope, capture.id, 'EXPIRED', now, tx);
        return { outcome: 'EXPIRED' } as const;
      }
      // A credit capture always names a payment (the table's target CHECK); the null branch is
      // the type's, not a state this purpose can reach.
      const payment =
        capture.paymentId === null
          ? null
          : await this.deps.payments.findById(scope, capture.paymentId, tx);
      if (payment === null || payment.state !== 'PENDING') {
        await this.deps.captures.close(scope, capture.id, 'SUPERSEDED', now, tx);
        return { outcome: 'GONE' } as const;
      }

      const amount = parseTypedAmount(input.text, payment.amount.currency);
      if (amount === null) return { outcome: 'INVALID', payment } as const;

      if (!(await this.deps.captures.recordAmount(scope, capture.id, amount.amountMinor, tx))) {
        return { outcome: 'NO_CAPTURE' } as const;
      }
      await rememberOnce(
        this.deps.idempotency,
        scope,
        CAPTURE_NAMESPACE,
        input.idempotencyKey,
        requestHash,
        { captureId: capture.id },
        tx,
      );
      const customer = await this.deps.customers.findById(scope, payment.customerId, tx);
      return {
        outcome: 'ENTERED',
        amount,
        capture: { ...capture, amountMinor: amount.amountMinor },
        payment,
        customer,
      } as const;
    });
  }

  /**
   * The confirm button: close the capture as CONFIRMED and credit its amount.
   *
   * Closed FIRST and credited after, under `receiptCreditCaptureKey`. A capture found
   * already CONFIRMED is credited again under the same key, which `creditToWallet`
   * answers with the first result — so a double tap is one credit, and a crash between
   * the close and the credit is finished by the next tap rather than stranded.
   */
  async confirm(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly captureId: string },
  ): Promise<CaptureConfirmResult> {
    const adminId = this.adminIdOf(actor);
    const captureId = this.captureId(input.captureId);
    const denial = {
      action: 'payment.receipt_credit_capture',
      entityType: 'AdminAmountCapture',
      entityId: captureId,
    };
    await this.authorize(scope, actor, RECEIPT_CREDIT_REVIEW_PERMISSION, denial);
    await this.authorize(scope, actor, RECEIPT_CREDIT_WALLET_PERMISSION, denial);

    const decided = await this.mutate(scope, actor, denial, async (tx) => {
      const found = await this.deps.captures.findById(scope, captureId, tx);
      if (found === null || found.adminId !== adminId) return { outcome: 'GONE' } as const;
      await this.deps.captures.lockForAdmin(scope, found.botInstanceId, adminId, tx);
      const capture = await this.deps.captures.findById(scope, captureId, tx);
      if (
        capture === null ||
        capture.purpose !== 'RECEIPT_CREDIT_AMOUNT' ||
        capture.amountMinor === null
      ) {
        return { outcome: 'GONE' } as const;
      }

      if (capture.closeReason === 'CONFIRMED') {
        return { outcome: 'CREDIT', capture, amountMinor: capture.amountMinor } as const;
      }
      if (capture.closeReason !== null) {
        return { outcome: 'CLOSED', reason: capture.closeReason } as const;
      }
      const now = this.deps.clock.now();
      if (now.getTime() >= capture.expiresAt.getTime()) {
        await this.deps.captures.close(scope, capture.id, 'EXPIRED', now, tx);
        return { outcome: 'CLOSED', reason: 'EXPIRED' } as const;
      }
      if (!(await this.deps.captures.close(scope, capture.id, 'CONFIRMED', now, tx))) {
        /*
         * Somebody closed it between the read and this write. The admin lock makes that
         * impossible for the cancel button, which takes the same lock; the answer is still
         * read back rather than assumed, because a close that did not happen must never
         * be followed by a credit.
         */
        const standing = await this.deps.captures.findById(scope, captureId, tx);
        if (standing?.closeReason === 'CONFIRMED' && standing.amountMinor !== null) {
          return {
            outcome: 'CREDIT',
            capture: standing,
            amountMinor: standing.amountMinor,
          } as const;
        }
        return { outcome: 'CLOSED', reason: standing?.closeReason ?? 'CANCELLED' } as const;
      }
      return { outcome: 'CREDIT', capture, amountMinor: capture.amountMinor } as const;
    });
    if (decided.outcome !== 'CREDIT') return decided;
    // The type's null branch only: a credit capture names a payment by the table's CHECK.
    if (decided.capture.paymentId === null) return { outcome: 'GONE' };

    const result = await this.deps.dispositions.creditToWallet(scope, actor, {
      idempotencyKey: receiptCreditCaptureKey(decided.capture.id),
      paymentId: decided.capture.paymentId,
      amountMinor: decided.amountMinor,
      note: CREDIT_NOTE,
    });
    return {
      outcome: 'CREDITED',
      amount: money(result.credit.amount.amountMinor, result.credit.amount.currency),
      result,
    };
  }

  /** The cancel button. Nothing has moved, and after this nothing will. */
  async cancel(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly captureId: string },
  ): Promise<CaptureCancelResult> {
    const adminId = this.adminIdOf(actor);
    const captureId = this.captureId(input.captureId);
    const denial = {
      action: 'payment.receipt_credit_capture',
      entityType: 'AdminAmountCapture',
      entityId: captureId,
    };
    await this.authorize(scope, actor, RECEIPT_CREDIT_REVIEW_PERMISSION, denial);

    return this.mutate(scope, actor, denial, async (tx) => {
      const found = await this.deps.captures.findById(scope, captureId, tx);
      if (
        found === null ||
        found.adminId !== adminId ||
        found.purpose !== 'RECEIPT_CREDIT_AMOUNT'
      ) {
        return { outcome: 'GONE' } as const;
      }
      /*
       * The SAME admin lock the confirm button takes, and the capture re-read under it.
       *
       * Without it a cancel and a confirm tapped together each read the capture open and
       * each wrote their close: the loser's conditional UPDATE matched nothing, and
       * whichever lost went on as if it had won — a confirm crediting a capture the
       * cancel had closed, or a cancel reporting "nothing moved" beside a credit (Codex,
       * PR #70). Under the lock the two are serial, and the second reads the first.
       */
      await this.deps.captures.lockForAdmin(scope, found.botInstanceId, adminId, tx);
      const capture = await this.deps.captures.findById(scope, captureId, tx);
      if (capture === null) return { outcome: 'GONE' } as const;
      if (capture.closeReason === 'CONFIRMED') return { outcome: 'CONFIRMED' } as const;
      // An already-closed capture is answered as cancelled: nothing will move either way,
      // and a redelivered cancel must read the same as the first.
      if (
        capture.closeReason === null &&
        !(await this.deps.captures.close(scope, capture.id, 'CANCELLED', this.deps.clock.now(), tx))
      ) {
        const standing = await this.deps.captures.findById(scope, captureId, tx);
        if (standing?.closeReason === 'CONFIRMED') return { outcome: 'CONFIRMED' } as const;
      }
      await rememberOnce(
        this.deps.idempotency,
        scope,
        CAPTURE_NAMESPACE,
        input.idempotencyKey,
        hashRequest({ captureId, cancel: true }),
        { captureId },
        tx,
      );
      return { outcome: 'CANCELLED' } as const;
    });
  }

  // -------------------------------------------------------------------------

  /**
   * The mutation wrapper every write here shares: `receipts.review` re-checked inside the
   * transaction, and the scope's activity read there too (`CLAUDE.md`: a stop can commit
   * between the surface's arrival and this transaction).
   */
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
      RECEIPT_CREDIT_REVIEW_PERMISSION,
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

  private async subjectOf(scope: TenantContext, captureId: string): Promise<CaptureSubject | null> {
    const capture = await this.deps.captures.findById(scope, captureId);
    if (capture === null || capture.paymentId === null) return null;
    const payment = await this.deps.payments.findById(scope, capture.paymentId);
    if (payment === null) return null;
    const customer = await this.deps.customers.findById(scope, payment.customerId);
    return { capture, payment, customer };
  }

  /** The administrator a capture belongs to. Only an administrator has one. */
  private adminIdOf(actor: ActorContext): string {
    const id = this.adminIdOrNull(actor);
    if (id !== null) return id;
    throw errors.permissionDenied(
      PLATFORM_ERROR_CODES.PERMISSION_DENIED,
      'Only an administrator can credit a receipt to a wallet.',
    );
  }

  private adminIdOrNull(actor: ActorContext): string | null {
    return (actor.type === 'WEB_ADMIN' || actor.type === 'TELEGRAM_ADMIN') && actor.id !== null
      ? actor.id
      : null;
  }

  private paymentId(candidate: string): PaymentId {
    const parsed = paymentIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.');
    }
    return parsed.data;
  }

  private captureId(candidate: string): string {
    const parsed = uuidV7Schema.safeParse(candidate);
    // An id that is not one names no capture: the same answer as another person's.
    return parsed.success ? parsed.data : '00000000-0000-7000-8000-000000000000';
  }

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
