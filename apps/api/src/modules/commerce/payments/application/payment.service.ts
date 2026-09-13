import {
  COMMERCE_ERROR_CODES,
  ORDER_MACHINE,
  PAYMENT_PAGE_DEFAULT,
  PAYMENT_PAGE_MAX,
  SELF_CONTAINED_PAYMENT_METHODS,
  errors,
  nextState,
  orderIdSchema,
  paymentIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationId,
  type OperationalEventRecorder,
  type OrderId,
  type PaymentId,
  type PaymentMethod,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
  type UserId,
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
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { OrderRecord, OrderRepository } from '../../orders/application/ports.js';
import type { CustomerRepository } from '../../customers/application/ports.js';
import type { WalletRepository } from '../../wallet/application/ports.js';
import { canCover, shortfallMinor } from '../../wallet/domain/balance.js';
import { settlementRefusal } from '../domain/settlement.js';
import type {
  PaymentCursor,
  PaymentPage,
  PaymentRecord,
  PaymentRepository,
  PaymentSearch,
} from './ports.js';

/** What an operator needs to read the payment list and a payment's detail. */
export const PAYMENT_VIEW_PERMISSION: PermissionKey = 'payments.view';

/**
 * What confirming an out-of-band transfer acts under.
 *
 * `receipts.review`, which is the frozen permission for exactly this and is HIGH. The
 * legacy receipt review records neither the reviewer nor the time (`UNK-PR-010`), so
 * "was this approved by a human" is unanswerable there; here the permission is charged,
 * the administrator is stored on the row and the timestamp is frozen by a trigger.
 */
export const PAYMENT_REVIEW_PERMISSION: PermissionKey = 'receipts.review';

/**
 * What a CUSTOMER-initiated payment command acts under.
 *
 * `maintenance.run`, the same key `ORDER_PLACE_PERMISSION` uses and for the reason
 * recorded there: this is system work triggered by a customer, `SYSTEM_JOB` holds that
 * one key and nothing else, and the check is MADE rather than skipped because
 * authorization is never decided by looking at an actor's type.
 */
export const PAYMENT_PLACE_PERMISSION: PermissionKey = 'maintenance.run';

/** The surface a customer's payment command arrives through. A constant, not a parameter. */
const CUSTOMER_NAMESPACE = 'TELEGRAM' as const;
/** The surface an operator's confirmation arrives through. */
const OPERATOR_NAMESPACE = 'WEB' as const;

export interface PaymentServiceDeps {
  readonly repository: PaymentRepository;
  readonly orders: OrderRepository;
  readonly wallet: WalletRepository;
  /**
   * Read to refuse a BLOCKED customer INSIDE the transaction that would move their money.
   *
   * `OrderService` has held this since 4B and payments did not, which left a block
   * stopping a customer placing new orders while leaving them free to spend the balance
   * on the ones they already had. The surface checks on arrival and an operator can
   * block between that check and this write — `REFUSAL_REPLIES` already says exactly
   * that for the order codes, and the sentence was false for the payment codes beside
   * them.
   */
  readonly customers: CustomerRepository;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Derives a payment's reference from an idempotency key. See `referenceFor`. */
  readonly operationId: (idempotencyKey: string) => OperationId;
}

/**
 * What a customer's payment command carries. An ORDER ID AND NOTHING ELSE.
 *
 * There is deliberately no amount, no currency and no customer here, and that absence
 * IS the invariant: a Telegram callback is an intent and an identifier, never a
 * quantity. Every figure that decides how much money moves is re-read from the database
 * inside the transaction that moves it — the amount and currency from
 * `orders.total_amount` and `orders.currency`, which `nexa_orders_snapshot_guard` froze
 * at confirmation, and the owner from the order row rather than from the update.
 *
 * A field added here would be a field a client could set.
 */
export interface PaymentIntent {
  readonly idempotencyKey: string;
  readonly orderId: string;
}

/** What an operator's confirmation carries. Also no amount — see `PaymentRepository.confirm`. */
export interface ManualConfirmation {
  readonly idempotencyKey: string;
  readonly note: string;
}

export interface PaymentListQuery {
  readonly limit?: number;
  readonly cursor?: PaymentCursor;
  readonly search: PaymentSearch;
}

/** The administrator behind an actor, or null for a flow. `confirmed_by_admin_id` is an FK. */
function adminIdOf(actor: ActorContext): string | null {
  return actor.type === 'WEB_ADMIN' || actor.type === 'TELEGRAM_ADMIN' ? actor.id : null;
}

/**
 * Payments, and the settlement they fund.
 *
 * Two customer paths and one operator path, and every one of them commits the money,
 * the payment and the order state in ONE transaction. There is no arrangement of
 * failures that leaves money moved and an order unpaid, or an order paid and no money:
 * a partial commit is not a state this code can be in, because there is no second
 * commit to fail.
 *
 * **No external network call happens inside any of these transactions.** There is
 * nothing to call — the two rails this release implements need no third party, which is
 * why they are the two. A gateway is refused rather than simulated.
 *
 * ## What this does NOT do
 *
 * It moves an order to `PAID` and stops. Nothing here provisions, activates, creates a
 * server or touches a panel, and no message it sends may say otherwise — the phase that
 * does those things is a later one, and a product that claims an effect that did not
 * happen is the defect class this codebase is organised around.
 */
export class PaymentService {
  constructor(private readonly deps: PaymentServiceDeps) {}

  /** A page of payments for an operator. Reading money is `payments.view`. */
  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: PaymentListQuery,
  ): Promise<PaymentPage> {
    await this.deps.guard.check(scope, actor, PAYMENT_VIEW_PERMISSION);
    const limit = Math.min(Math.max(query.limit ?? PAYMENT_PAGE_DEFAULT, 1), PAYMENT_PAGE_MAX);
    return this.deps.repository.list(scope, query.search, limit, query.cursor ?? null);
  }

  async get(scope: TenantContext, actor: ActorContext, id: string): Promise<PaymentRecord> {
    await this.deps.guard.check(scope, actor, PAYMENT_VIEW_PERMISSION);
    const payment = await this.deps.repository.findById(scope, this.paymentId(id));
    if (payment === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.');
    }
    return payment;
  }

  /**
   * A customer settling an order from their own wallet balance.
   *
   * The whole movement is one transaction: the `PURCHASE` debit, the payment, its
   * confirmation on `WALLET_DEBIT` evidence, and the order's `SETTLE`. `LGR-BR-002`
   * measures the rule the debit follows — a legacy wallet purchase where
   * `موجودی قبل − موجودی بعد = قیمت نهایی` exactly — and `settlementIsFunded` is what
   * enforces it here rather than a comment.
   *
   * The amount is `orders.total_amount`. It is not re-priced, and re-pricing is not
   * merely forbidden: `nexa_orders_snapshot_guard` froze the total when the order was
   * confirmed, so the number cannot have changed since the customer agreed to it.
   */
  async settleFromWallet(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    intent: PaymentIntent,
  ): Promise<{ readonly payment: PaymentRecord; readonly order: OrderRecord }> {
    const orderId = this.orderId(intent.orderId);
    const denial = { action: 'payment.wallet_settle', entityType: 'Order', entityId: orderId };
    await this.authorize(scope, actor, PAYMENT_PLACE_PERMISSION, denial);

    const requestHash = hashRequest({ customerId, orderId });
    const replay = await this.replayed(
      scope,
      CUSTOMER_NAMESPACE,
      intent.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return replay;

    const now = this.deps.clock.now();
    const reference = this.referenceFor(intent.idempotencyKey, 'wallet');
    const paymentId = this.deps.ids.uuid() as PaymentId;

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PAYMENT_PLACE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);

        /*
         * The customer row FIRST, and everything authoritative is read AFTER it.
         *
         * Two reasons, and the second was found by review rather than by design.
         *
         * An admin debit racing this purchase must not let both take the last of the
         * money. The ledger is append-only and gives two appends nothing to contend
         * on, so the serialisation point is the customer row — see
         * `WalletRepository.lockCustomer`.
         *
         * And the ORDER must be read inside that serialised window, not before it. It
         * used to be read first: two taps on one order both saw `AWAITING_PAYMENT`, the
         * loser then blocked here, and resumed holding an order row that had since been
         * PAID. It went on to pass `canCover`, append a second debit and only fail at
         * `payments_order_confirmed_key` — a raw 23505 nothing maps, which the webhook
         * swallows, so the customer who double-tapped got silence. Reading after the
         * lock makes the loser see `PAID` and refuse in the ordinary way.
         */
        if (!(await this.deps.wallet.lockCustomer(scope, customerId, tx))) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
        }
        await this.assertCustomerMayPay(scope, customerId, tx);

        /*
         * Everything the callback could have carried is discarded in favour of this
         * row: the amount, the currency, the owner, the state and the deadline. A
         * tampered or stale callback fails at MUTATION time rather than at render time.
         */
        const order = await this.orderAwaitingPayment(
          scope,
          orderId,
          customerId,
          tx,
          now,
          'REFUSE_AFTER_DEADLINE',
        );
        const total = order.totals.total;

        const balance = await this.deps.wallet.balanceOf(scope, customerId, total.currency, tx);
        if (!canCover(balance.amountMinor, total.amountMinor)) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS,
            'This wallet does not hold enough to pay for that order.',
            {
              shortfallMinor: shortfallMinor(balance.amountMinor, total.amountMinor).toString(),
              // The CURRENCY travels with the figure, always. A shortfall without one is
              // a bare number, and `bot.wallet.insufficient` declares a MONEY
              // placeholder precisely so a customer is never shown one.
              currency: total.currency,
            },
          );
        }

        const payment = await this.deps.repository.create(
          scope,
          {
            id: paymentId,
            customerId,
            orderId,
            method: 'WALLET',
            amount: total,
            reference,
            expiresAt: null,
            now,
          },
          tx,
        );

        /*
         * The DEBIT names the payment, and its reference is derived from the same
         * idempotency key with a different role suffix.
         *
         * So a retry of this command recomputes both references, and both the payment
         * insert and the ledger insert land on a unique index that already holds their
         * row. One command, two idempotent writes, no process memory.
         */
        const { entry, inserted } = await this.deps.wallet.append(
          scope,
          {
            id: this.deps.ids.uuid(),
            customerId,
            direction: 'DEBIT',
            reason: 'PURCHASE',
            amount: total,
            reference: this.referenceFor(intent.idempotencyKey, 'purchase'),
            orderId,
            paymentId: payment.id,
            note: null,
            now,
          },
          tx,
        );

        const confirmed = await this.confirmAndSettle(
          scope,
          actor,
          tx,
          payment,
          order,
          {
            evidenceKind: 'WALLET_DEBIT',
            evidenceNote: null,
            confirmedByAdminId: null,
            confirmedAt: now,
          },
          now,
          // The SAME action its refusals carry. See `confirmAndSettle`'s `action`.
          denial.action,
        );

        /*
         * The event follows the MOVEMENT, not the command succeeding.
         *
         * `inserted` is false when this transaction re-read an entry that was already
         * there. On THIS path that is currently unreachable, and the gate is defensive:
         * the entry and the order's settlement commit together, so an existing entry
         * implies a PAID order and `orderAwaitingPayment` refuses before reaching here.
         * The falsification records it as such — mutating it away leaves the suite
         * green, for the same reason W06, T06 and H01 do.
         *
         * It is written anyway because the rule is the same one `WalletService.adjust`
         * needs and `OrderService` applies to `OrderConfirmed` with `changed`: the
         * event follows the movement. A later phase that separates the debit from the
         * settlement would make this reachable, and a gate added then would be a gate
         * somebody had to notice was missing.
         */
        if (inserted) {
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
        }

        await rememberOnce(
          this.deps.idempotency,
          scope,
          CUSTOMER_NAMESPACE,
          intent.idempotencyKey,
          requestHash,
          { paymentId: confirmed.payment.id },
          tx,
        );
        return confirmed;
      },
    );
  }

  /**
   * A customer choosing to pay out of band, which creates a PENDING payment and
   * nothing else.
   *
   * No money moves here and no order settles. What the customer gets is the reference
   * to quote — `bot.payment.manual_instructions` declares exactly `{total}` and
   * `{reference}` — and what an operator gets is a row in a review queue. This is the
   * mechanism the research actually documents, and the human in the loop is its point.
   *
   * The reference is GENERATED. `payments.reference` is described in the schema as
   * *"never customer-supplied"*, because a customer who could choose it could choose
   * somebody else's.
   */
  async requestManualTransfer(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    intent: PaymentIntent,
  ): Promise<PaymentRecord> {
    const orderId = this.orderId(intent.orderId);
    const denial = { action: 'payment.manual_request', entityType: 'Order', entityId: orderId };
    await this.authorize(scope, actor, PAYMENT_PLACE_PERMISSION, denial);

    const requestHash = hashRequest({ customerId, orderId, method: 'MANUAL_TRANSFER' });
    const replayed = await this.deps.idempotency.find<{ paymentId: string }>(
      scope,
      CUSTOMER_NAMESPACE,
      intent.idempotencyKey,
      requestHash,
    );
    if (replayed !== null) {
      const existing = await this.deps.repository.findById(
        scope,
        replayed.result.paymentId as PaymentId,
      );
      if (existing !== null) return existing;
    }

    const now = this.deps.clock.now();
    const reference = this.referenceFor(intent.idempotencyKey, 'manual');
    const paymentId = this.deps.ids.uuid() as PaymentId;

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PAYMENT_PLACE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.assertCustomerMayPay(scope, customerId, tx);
        const order = await this.orderAwaitingPayment(
          scope,
          orderId,
          customerId,
          tx,
          now,
          'REFUSE_AFTER_DEADLINE',
        );

        /*
         * ONE pending transfer per order, because two are indistinguishable to everybody.
         *
         * The idempotency key is the UPDATE's, so a second tap is a different key, a
         * different derived reference and — without this — a second PENDING row. Nothing
         * in the schema forbade it: `payments_order_confirmed_key` is partial on
         * CONFIRMED. The customer would hold two codes for one order, transfer the money
         * quoting one of them, and the operator would see two identical pending rows with
         * no way to tell which the bank reference names. Confirming either settles the
         * order and strands the other PENDING for ever — there is no cancel, fail or
         * expire path in this release.
         *
         * Answering with the EXISTING payment rather than refusing is what makes the
         * second tap useful: the customer gets the same reference and the same amount
         * back, which is what they were reaching for.
         */
        const pending = await this.deps.repository.list(
          scope,
          { orderId, state: 'PENDING', method: 'MANUAL_TRANSFER' },
          1,
          null,
          tx,
        );
        const already = pending.items[0];
        /*
         * NOT an early return: the audit row and the idempotency row below are the point.
         *
         * Returning here would leave this command unaudited and its key unremembered,
         * so the NEXT redelivery of this very update would take the create path again —
         * which is the defect this block exists to close, reintroduced one line above it.
         */
        const payment =
          already ??
          (await this.deps.repository.create(
            scope,
            {
              id: paymentId,
              customerId,
              orderId,
              method: 'MANUAL_TRANSFER',
              // The order's frozen total, never a figure the request carried.
              amount: order.totals.total,
              reference,
              /*
               * The order's own deadline, carried onto the payment.
               *
               * Not a new window invented here: the order already has one and a payment
               * that outlived it would be an instruction to send money for something
               * that can no longer be bought.
               */
              expiresAt: order.expiresAt,
              now,
            },
            tx,
          ));

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'payment.manual_request',
            entityType: 'Payment',
            entityId: payment.id,
            before: null,
            after: {
              orderId,
              method: payment.method,
              state: payment.state,
              amountMinor: payment.amount.amountMinor.toString(),
              currency: payment.amount.currency,
              reference: payment.reference,
              /*
               * Whether this command issued a code or read back the one already open.
               * Same ACTION either way — one command, one name, the rule S2 records —
               * and the difference stated in the row rather than by splitting it.
               */
              reissued: already !== undefined,
            },
            result: 'SUCCESS',
          },
          tx,
        );

        await rememberOnce(
          this.deps.idempotency,
          scope,
          CUSTOMER_NAMESPACE,
          intent.idempotencyKey,
          requestHash,
          { paymentId: payment.id },
          tx,
        );
        return payment;
      },
    );
  }

  /**
   * An operator confirming that an out-of-band transfer arrived.
   *
   * The confirmation carries a NOTE and nothing else. It cannot restate the amount —
   * `confirmPaymentRequestSchema` has no such field, `PaymentRepository.confirm` takes
   * no such parameter, and `nexa_payments_confirmation_guard` would refuse the write.
   * Three layers, because an operator able to adjust the amount at approval time is an
   * operator able to approve a different payment from the one the customer made.
   *
   * The settlement is in the same transaction, so an approved receipt and a paid order
   * are one fact rather than two that can disagree.
   */
  async confirmManualTransfer(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    input: ManualConfirmation,
  ): Promise<{ readonly payment: PaymentRecord; readonly order: OrderRecord | null }> {
    const paymentId = this.paymentId(id);
    const denial = { action: 'payment.confirm', entityType: 'Payment', entityId: paymentId };
    await this.authorize(scope, actor, PAYMENT_REVIEW_PERMISSION, denial);

    const requestHash = hashRequest({ paymentId, note: input.note });
    const replayed = await this.deps.idempotency.find<{ paymentId: string }>(
      scope,
      OPERATOR_NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );
    if (replayed !== null) {
      const existing = await this.deps.repository.findById(scope, paymentId);
      if (existing !== null) {
        return { payment: existing, order: await this.orderOf(scope, existing) };
      }
    }

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PAYMENT_REVIEW_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);

        const payment = await this.deps.repository.findById(scope, paymentId, tx);
        if (payment === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.');
        }
        this.assertMethodAvailable(payment.method);

        /*
         * Already CONFIRMED is the end state the caller asked for, not an error.
         *
         * Two operators pressing approve, or one pressing it twice, must not be told
         * the payment is broken. What they must NOT get is a second confirmation, and
         * they cannot: `confirm` is a conditional UPDATE on `state = 'PENDING'` and
         * `payments_order_confirmed_key` allows at most one CONFIRMED payment per order.
         */
        if (payment.state === 'CONFIRMED') {
          return { payment, order: await this.orderOf(scope, payment, tx) };
        }
        if (payment.state !== 'PENDING') {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID,
            'This payment can no longer be confirmed.',
          );
        }
        if (payment.orderId === null) {
          // Nothing in this release creates one; the refusal is here so that the phase
          // which does has to decide what it settles rather than inherit an answer.
          throw errors.conflict(
            COMMERCE_ERROR_CODES.SETTLEMENT_NOT_FUNDED,
            'This payment names no order.',
            { reason: 'PAYMENT_NAMES_NO_ORDER' },
          );
        }

        const order = await this.orderAwaitingPayment(
          scope,
          payment.orderId,
          payment.customerId,
          tx,
          now,
          'OPERATOR_MAY_CONFIRM_LATE',
        );

        return this.confirmAndSettle(
          scope,
          actor,
          tx,
          payment,
          order,
          {
            evidenceKind: 'OPERATOR_REVIEW',
            evidenceNote: input.note,
            confirmedByAdminId: adminIdOf(actor),
            confirmedAt: now,
          },
          now,
          denial.action,
          { idempotencyKey: input.idempotencyKey, requestHash, namespace: OPERATOR_NAMESPACE },
        );
      },
    );
  }

  /**
   * Confirm the payment, check the guard, settle the order. In that order, once.
   *
   * The ONE place `SETTLE` is taken, so there is one place to read to know what a paid
   * order means. The guard runs on the CONFIRMED payment and the re-read order rather
   * than on what the caller believed: `settlementIsFunded` is an assertion about two
   * rows, and letting it run on values a caller assembled would make it an assertion
   * about a caller.
   */
  private async confirmAndSettle(
    scope: TenantContext,
    actor: ActorContext,
    tx: TransactionScope,
    payment: PaymentRecord,
    order: OrderRecord,
    confirmation: {
      readonly evidenceKind: 'WALLET_DEBIT' | 'OPERATOR_REVIEW';
      readonly evidenceNote: string | null;
      readonly confirmedByAdminId: string | null;
      readonly confirmedAt: Date;
    },
    now: Date,
    /**
     * The audit ACTION, supplied by the caller rather than fixed here.
     *
     * One command must not be split across two action names. `settleFromWallet` audits
     * its refusals as `payment.wallet_settle`, so its success has to say the same thing
     * — and a wallet settlement is a different act from an operator approving a
     * transfer, so they must not share a name either. Phase 4B has the identical defect
     * on record as M36: the pre-replay denial wrote `order.create` while success wrote
     * `order.draft_create`, and the rows that went missing were exactly the refusals.
     */
    action: string,
    remember?: {
      readonly idempotencyKey: string;
      readonly requestHash: string;
      readonly namespace: 'WEB' | 'TELEGRAM';
    },
  ): Promise<{ readonly payment: PaymentRecord; readonly order: OrderRecord }> {
    const moved = await this.deps.repository.confirm(scope, payment.id, confirmation, now, tx);
    if (!moved) {
      /*
       * Another confirmation of this payment committed first.
       *
       * Not an error to the caller and not a second settlement either: the row is
       * re-read and returned as it now stands. The conditional UPDATE is what made the
       * race safe; this branch is only how the winner's result is reported to the loser.
       */
      const current = await this.deps.repository.findById(scope, payment.id, tx);
      if (current === null) {
        throw errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.');
      }
      const settled = await this.deps.orders.findById(scope, order.id, tx);
      return { payment: current, order: settled ?? order };
    }

    const confirmed = await this.deps.repository.findById(scope, payment.id, tx);
    if (confirmed === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.');
    }

    const refusal = settlementRefusal(order, confirmed);
    if (refusal !== null) {
      /*
       * The guard refused, so the WHOLE transaction rolls back — the confirmation and
       * the debit with it.
       *
       * That is the only honest outcome: a confirmed payment that funds nothing is a
       * customer's money recorded as having bought something it did not buy. Throwing
       * here is what makes "money moved but the order did not" unrepresentable.
       */
      throw errors.conflict(
        COMMERCE_ERROR_CODES.SETTLEMENT_NOT_FUNDED,
        'This payment does not fund that order.',
        { reason: refusal },
      );
    }

    /*
     * `payments_confirmed_check` makes this true — `(state = 'CONFIRMED') =
     * (confirmed_at IS NOT NULL AND evidence_kind IS NOT NULL)` — and the guard above
     * has already established the state. Restated here because the TYPE cannot see a
     * database constraint, and the honest way to narrow it is a check that would fire
     * if the constraint were ever dropped, rather than a cast that would not.
     */
    if (confirmed.evidenceKind === null) {
      throw new Error(`payment ${confirmed.id} is CONFIRMED with no evidence kind.`);
    }

    const to = nextState(ORDER_MACHINE, 'AWAITING_PAYMENT', 'SETTLE');
    if (to === null) {
      throw new Error('ORDER_MACHINE no longer allows SETTLE from AWAITING_PAYMENT.');
    }

    const changed = await this.deps.orders.transition(
      scope,
      order.id,
      'AWAITING_PAYMENT',
      to,
      { settledAt: now },
      now,
      tx,
    );
    if (!changed) {
      /*
       * The order moved out of `AWAITING_PAYMENT` between the read and this UPDATE.
       *
       * A confirmed payment against an order that is no longer awaiting one is exactly
       * what `settlementIsFunded` exists to refuse, so this rolls back with the same
       * refusal the guard would have given had it seen the newer row.
       */
      throw errors.conflict(
        COMMERCE_ERROR_CODES.SETTLEMENT_NOT_FUNDED,
        'That order is no longer awaiting payment.',
        { reason: 'ORDER_NOT_AWAITING_PAYMENT' },
      );
    }

    const settled = await this.deps.orders.findById(scope, order.id, tx);
    if (settled === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND, 'Unknown order.');
    }

    await this.deps.audit.record(
      scope,
      actor,
      {
        action,
        entityType: 'Payment',
        entityId: confirmed.id,
        before: { state: payment.state },
        after: {
          state: confirmed.state,
          evidenceKind: confirmed.evidenceKind,
          orderId: settled.id,
          orderState: settled.state,
          amountMinor: confirmed.amount.amountMinor.toString(),
          currency: confirmed.amount.currency,
        },
        result: 'SUCCESS',
      },
      tx,
    );

    await this.deps.outbox.write(tx, actor, {
      eventType: 'PaymentConfirmed',
      aggregateType: 'Payment',
      aggregateId: confirmed.id,
      payload: {
        customerId: confirmed.customerId,
        orderId: confirmed.orderId,
        method: confirmed.method,
        evidenceKind: confirmed.evidenceKind,
        amountMinor: confirmed.amount.amountMinor.toString(),
        currency: confirmed.amount.currency,
      },
    });

    await this.deps.outbox.write(tx, actor, {
      eventType: 'OrderSettled',
      aggregateType: 'Order',
      aggregateId: settled.id,
      payload: {
        customerId: settled.customerId,
        // Required by the frozen event, and it is always present: an order settles
        // only through a confirmed payment, which is what `settlementIsFunded` says.
        paymentId: confirmed.id,
        totalMinor: settled.totals.total.amountMinor.toString(),
        currency: settled.totals.currency,
      },
    });

    if (remember !== undefined) {
      await rememberOnce(
        this.deps.idempotency,
        scope,
        remember.namespace,
        remember.idempotencyKey,
        remember.requestHash,
        { paymentId: confirmed.id },
        tx,
      );
    }

    return { payment: confirmed, order: settled };
  }

  /**
   * The order this command is about, re-read and validated INSIDE the transaction.
   *
   * Three checks, and the order of the first two matters: another customer's order is
   * UNKNOWN rather than FORBIDDEN, because a distinct refusal would answer "does order
   * X exist" for anybody willing to guess ids — the rule `OrderService.confirm` states,
   * applied where money is at stake.
   */
  private async orderAwaitingPayment(
    scope: TenantContext,
    orderId: OrderId,
    customerId: UserId,
    tx: TransactionScope,
    now: Date,
    /*
     * Whether the order's own deadline refuses this caller, spelled out at every call
     * site rather than inferred.
     *
     * A CUSTOMER may not start paying for an order whose stated deadline has passed.
     * An OPERATOR confirming a transfer that already arrived is the opposite case:
     * the money is in the bank, and refusing the confirmation because the deadline
     * lapsed while the receipt sat in the queue would strand it — 4C has no refund
     * path, which is what OQ-4C-02 is about. So the operator lane is allowed to be
     * late, deliberately and by name.
     */
    deadline: 'REFUSE_AFTER_DEADLINE' | 'OPERATOR_MAY_CONFIRM_LATE',
  ): Promise<OrderRecord> {
    const order = await this.deps.orders.findById(scope, orderId, tx);
    if (order === null || order.customerId !== customerId) {
      throw errors.notFound(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND, 'Unknown order.');
    }
    if (order.state !== 'AWAITING_PAYMENT') {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
        'That order is not awaiting payment.',
      );
    }
    /*
     * The deadline the CUSTOMER was shown, enforced where the money moves.
     *
     * `bot.order.awaiting_payment` renders «اعتبار تا: {expiresAt}» and 4C attaches the
     * two pay buttons to that same message. Those buttons live in the chat for ever, so
     * without this the sentence is false: a tap weeks later settled the order at a price
     * quoted with an expiry the customer had been told, and on the manual rail it
     * printed bank instructions for an order whose own `expires_at` was long past.
     *
     * The comparison is `>=` and against the ORDER's own column, which is the value the
     * customer read — not a second window invented here. `OrderService.confirm` refuses
     * a stale DRAFT the same way one state earlier; this is the same rule at the state
     * where it had been missing.
     *
     * This does NOT move the order to `EXPIRED` — nothing sweeps, which is the half of
     * OQ-4C-01 that stays open. Refusing is what 4C can do without inventing a window.
     */
    if (
      deadline === 'REFUSE_AFTER_DEADLINE' &&
      order.expiresAt !== null &&
      now.getTime() >= order.expiresAt.getTime()
    ) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.ORDER_EXPIRED,
        'The time allowed to pay for that order has passed.',
      );
    }
    return order;
  }

  /**
   * A BLOCKED customer moves no money, checked INSIDE the committing transaction.
   *
   * `OrderService.assertCustomerMayOrder` is the same rule at order creation, and this
   * is the half that was missing: a block stopped a customer placing new orders while
   * leaving them free to spend their balance on orders they already had. A surface
   * checks on arrival and an operator can block in between, which is why the check
   * belongs here rather than at the surface.
   *
   * Only the two CUSTOMER-initiated paths call it. An operator confirming a transfer
   * that already arrived is a different act by a different actor, and refusing it would
   * strand real money with no refund path in this release — see OQ-4C-02.
   */
  private async assertCustomerMayPay(
    scope: TenantContext,
    customerId: UserId,
    tx: TransactionScope,
  ): Promise<void> {
    const customer = await this.deps.customers.findById(scope, customerId, tx);
    if (customer === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
    }
    if (customer.status === 'BLOCKED') {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.CUSTOMER_BLOCKED,
        'This account cannot pay for orders.',
      );
    }
  }

  private async orderOf(
    scope: TenantContext,
    payment: PaymentRecord,
    tx?: TransactionScope,
  ): Promise<OrderRecord | null> {
    if (payment.orderId === null) return null;
    return this.deps.orders.findById(scope, payment.orderId, tx);
  }

  /**
   * A rail this installation can actually perform, or a refusal.
   *
   * `GATEWAY` is refused and NOT simulated. There is no adapter, and a fake one would
   * be the Marzban descriptor defect with money attached — a product advertising an
   * operation no code can perform.
   */
  private assertMethodAvailable(method: PaymentMethod): void {
    if (!SELF_CONTAINED_PAYMENT_METHODS.includes(method)) {
      throw errors.preconditionFailed(
        COMMERCE_ERROR_CODES.PAYMENT_METHOD_UNAVAILABLE,
        'This installation cannot take a payment that way.',
      );
    }
  }

  /** The committed result of an identical earlier command, or null. */
  private async replayed(
    scope: TenantContext,
    namespace: 'WEB' | 'TELEGRAM',
    idempotencyKey: string,
    requestHash: string,
  ): Promise<{ readonly payment: PaymentRecord; readonly order: OrderRecord } | null> {
    const found = await this.deps.idempotency.find<{ paymentId: string }>(
      scope,
      namespace,
      idempotencyKey,
      requestHash,
    );
    if (found === null) return null;
    const payment = await this.deps.repository.findById(scope, found.result.paymentId as PaymentId);
    if (payment === null) return null;
    const order = await this.orderOf(scope, payment);
    if (order === null) return null;
    return { payment, order };
  }

  /**
   * A payment's reference, DERIVED from the idempotency key and never generated.
   *
   * The role suffix is what lets ONE command produce a payment and a ledger entry
   * without their references colliding, and lets a retry recompute both. `operation.ts`
   * states the property: the same key yields the same id in any process, after any
   * restart, with no lookup.
   */
  private referenceFor(idempotencyKey: string, role: string): string {
    return `${this.deps.operationId(idempotencyKey)}:${role}`;
  }

  /** Charges the permission before the replay, and audits the refusal. */
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

  private orderId(candidate: string): OrderId {
    const parsed = orderIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not an order id.',
      );
    }
    return parsed.data;
  }

  private paymentId(candidate: string): PaymentId {
    const parsed = paymentIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a payment id.',
      );
    }
    return parsed.data;
  }
}
