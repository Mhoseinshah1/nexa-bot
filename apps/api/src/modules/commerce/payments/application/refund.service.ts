import {
  COMMERCE_ERROR_CODES,
  ORDER_MACHINE,
  REFUND_METHOD_SUPPORT,
  errors,
  money,
  paymentIdSchema,
  refundIdSchema,
  refundFitsWithin,
  refundMayTransition,
  refundableMinor,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type Money,
  type OperationalEventRecorder,
  type OrderId,
  type PaymentId,
  type PermissionKey,
  type RefundChannel,
  type RefundId,
  type TenantContext,
  type UnitOfWork,
  nextState,
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
import type { WalletRepository } from '../../wallet/application/ports.js';
import type { OrderRepository } from '../../orders/application/ports.js';
import { UnfulfilledOrderReporter } from '../../orders/application/unfulfilled-order-reporter.js';
import type { PaymentRecord, PaymentRepository } from './ports.js';
import type { RefundRecord, RefundRepository } from './refund-ports.js';

/**
 * A path segment turned into an identifier, or a 404.
 *
 * Every id here names a `uuid` column. A cast satisfies the compiler and leaves the
 * string exactly as it arrived, so `/payments/not-a-uuid/refunds` reached PostgreSQL and
 * came back as `invalid input syntax for type uuid` — a 500 describing the database, for
 * a request whose only fault is naming nothing. NOT_FOUND is the truthful answer, and it
 * is the same answer a well-formed id for a row in another tenant already gets, which is
 * what stops this from telling an unauthorized caller which ids exist.
 */
function parseIdentifier<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  value: string,
  what: 'payment' | 'refund',
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data === undefined) {
    throw what === 'payment'
      ? errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.')
      : errors.notFound(COMMERCE_ERROR_CODES.REFUND_NOT_FOUND, 'Unknown refund.');
  }
  return parsed.data;
}

export const REFUND_VIEW_PERMISSION = 'refunds.view' satisfies PermissionKey;
export const REFUND_ISSUE_PERMISSION = 'refunds.issue' satisfies PermissionKey;

export interface RefundServiceDeps {
  readonly repository: RefundRepository;
  /** The payment READ, narrowed: this module reverses payments and must not decide them. */
  readonly payments: Pick<PaymentRepository, 'findById'>;
  /**
   * The ledger, for the one channel that moves money inside this process.
   *
   * `append` and `lockCustomer` only. `append` is idempotent at the database — an
   * `ON CONFLICT (tenant_id, reference) DO NOTHING` that re-reads on conflict — which is
   * what bounds a given refund to ONE credit; the repeated command itself is stopped
   * earlier, by the idempotency store. Nothing here may read a balance to decide
   * anything: a refund is bounded by the PAYMENT, never by what the wallet holds.
   */
  readonly wallet: Pick<WalletRepository, 'append' | 'lockCustomer'>;
  /**
   * The order WRITE, narrowed to the one edge a refund drives.
   *
   * A refund that completes against a `PAID_UNFULFILLED` order must close it — see
   * `closeUnfulfilledOrder`. Narrowed to `findById` and `transition` so this module
   * cannot grow into a second place orders are managed from.
   */
  readonly orders: Pick<OrderRepository, 'findById' | 'transition'>;
  /** To close the condition the settlement opened, when the money goes back instead. */
  readonly unfulfilled: UnfulfilledOrderReporter;
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

/** What one command was asked to do, so a replay answers with the same refund. */
interface RefundResult {
  readonly refundId: string;
}

/** A payment's refund history and the server's own arithmetic over it. */
export interface RefundLedgerView {
  readonly refunds: readonly RefundRecord[];
  readonly paid: Money;
  readonly consumedMinor: bigint;
  readonly refundableMinor: bigint;
  /** False when the payment cannot be refunded AT ALL, whatever the amount. */
  readonly refundable: boolean;
}

/**
 * Money going back.
 *
 * Three commands — request, complete, fail — and the split is the design rather than a
 * decomposition of it. Requesting decides money SHOULD go back and reserves the amount;
 * completing records that it HAS gone back. Collapsing them would mean a manual refund
 * marking itself done the moment an operator pressed a button, which is the one thing
 * this whole lifecycle exists to prevent.
 *
 * ## What bounds a refund
 *
 * The CONFIRMED payment, and nothing else. Not the wallet balance — a customer who has
 * spent their refund is still owed it — and not anything the browser sent. The
 * refundable amount is `paid - consumed`, computed inside the transaction AFTER the
 * payment row is locked, which is what makes it hold under concurrency.
 *
 * ## The wallet credit lands exactly once
 *
 * Two mechanisms, and it is worth being precise about which does what, because a
 * mutation test showed the plausible account of this to be wrong.
 *
 * A REPLAY never reaches the ledger at all: `replay` answers a repeated idempotency key
 * with the refund already written. What the ledger guarantees is narrower and still
 * necessary — the reference is `${refundId}:refund`, DERIVED, so the ledger's unique
 * `(tenant_id, reference)` makes at most one credit exist for a given refund whatever
 * reaches it. That is what turns "one credit per refund" from a property of this code
 * path into a property of the data, and an integration test appends a second entry with
 * that reference by hand to prove it holds against a writer this class does not control.
 *
 * The original debit is never touched either way: a reversal is a new append-only entry,
 * which is `CLAUDE.md`'s rule and the reason the legacy mutable balance column is the
 * failure it names.
 */
export class RefundService {
  constructor(private readonly deps: RefundServiceDeps) {}

  /** A payment's refunds, with what is left to refund. Charges `refunds.view`. */
  async ledgerFor(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: PaymentId,
  ): Promise<RefundLedgerView> {
    await this.deps.guard.check(scope, actor, REFUND_VIEW_PERMISSION);
    const payment = await this.requirePayment(scope, paymentId);
    const rows = await this.deps.repository.listForPayment(scope, paymentId);

    /*
     * Summed HERE from the rows just read rather than by a second query, so the list and
     * the total on the screen beneath it cannot disagree. The transactional read that
     * BOUNDS a refund is `consumptionFor`, under a lock; this one renders.
     */
    const consumedMinor = rows
      .filter((refund) => refund.state !== 'FAILED')
      .reduce((total, refund) => total + refund.amount.amountMinor, 0n);

    return {
      refunds: rows,
      paid: payment.amount,
      consumedMinor,
      refundableMinor: refundableMinor(payment.amount.amountMinor, consumedMinor),
      refundable: this.refundabilityOf(payment) === null,
    };
  }

  /**
   * Records that money should go back, and moves it if the channel can.
   *
   * The whole of the bound is in here, in this order, and the order is the correctness:
   *
   * 1. authorize, before the replay lookup — a replay returns a ROW, and an unauthorized
   *    caller who guessed a key would be handed financial evidence;
   * 2. LOCK the payment, so the sum below is a decision rather than an observation;
   * 3. sum what is already consumed, inside that lock;
   * 4. `refundFitsWithin`, which is the one arithmetic rule;
   * 5. write the refund, and for the wallet channel the ledger entry in the SAME
   *    transaction — so there is no window in which a refund exists and the money has
   *    not moved, nor one in which the money moved and no refund records it.
   */
  async request(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly paymentId: string;
      readonly amountMinor: bigint;
      readonly reason: string;
    },
  ): Promise<RefundRecord> {
    /*
     * PARSED here, not cast.
     *
     * `payments.id` is a `uuid` column. A cast satisfies TypeScript and nothing else, so
     * a malformed `/payments/:paymentId/refunds` segment reached PostgreSQL and came back
     * as `invalid input syntax for type uuid` — a 500 for an identifier that simply does
     * not name anything, which is a 404. The wire schema now parses it too; this is the
     * copy that protects a caller which is not the HTTP surface.
     */
    const paymentId = parseIdentifier(paymentIdSchema, input.paymentId, 'payment');
    const denial = { action: 'refund.request', entityType: 'Payment', entityId: paymentId };
    await this.authorize(scope, actor, REFUND_ISSUE_PERMISSION, denial);

    const requestHash = hashRequest({
      paymentId,
      // A decimal string: `bigint` has no JSON form, and two requests differing only in
      // amount must not hash identically — the second would be answered with the first.
      amountMinor: input.amountMinor.toString(),
      reason: input.reason,
    });
    const replayed = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();
    const refundId = this.deps.ids.uuid() as RefundId;

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      REFUND_ISSUE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);

        /*
         * The lock BEFORE the sum, which is the whole of the concurrency story.
         *
         * Two requests for the full amount of one payment both read the same consumed
         * total without it, both pass `refundFitsWithin`, and the payment refunds twice.
         * The PAYMENT row is the lock because the bound is per payment — two refunds of
         * different payments never wait for each other.
         */
        const locked = await this.deps.repository.lockPayment(scope, paymentId, tx);
        if (!locked) {
          throw errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.');
        }

        const payment = await this.requirePayment(scope, paymentId, tx);
        const unrefundable = this.refundabilityOf(payment);
        if (unrefundable !== null) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.REFUND_NOT_PERMITTED,
            'This payment cannot be refunded.',
            { reason: unrefundable },
          );
        }

        const consumption = await this.deps.repository.consumptionFor(scope, paymentId, tx);
        /*
         * A currency witness, asserted rather than assumed.
         *
         * Every refund of this payment is in the payment's own currency by construction,
         * so a disagreement here means a row nothing in this code could have written —
         * and summing across denominations would be the implicit conversion at a rate
         * nobody chose that `FBR-010` and the money model both refuse. Fail closed.
         */
        if (consumption.currency !== null && consumption.currency !== payment.amount.currency) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.REFUND_NOT_PERMITTED,
            'This payment has refunds in another currency.',
            { reason: 'CURRENCY_MISMATCH' },
          );
        }

        if (
          !refundFitsWithin({
            paidMinor: payment.amount.amountMinor,
            consumedMinor: consumption.consumedMinor,
            requestedMinor: input.amountMinor,
          })
        ) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.REFUND_EXCEEDS_REFUNDABLE,
            'That is more than this payment has left to refund.',
            {
              refundableMinor: refundableMinor(
                payment.amount.amountMinor,
                consumption.consumedMinor,
              ).toString(),
              currency: payment.amount.currency,
            },
          );
        }

        const channel = REFUND_METHOD_SUPPORT[payment.method].channel;
        const amount = money(input.amountMinor, payment.amount.currency);
        const immediate = channel === 'WALLET_CREDIT';

        const created = await this.deps.repository.create(
          scope,
          {
            id: refundId,
            paymentId,
            customerId: payment.customerId,
            orderId: payment.orderId,
            /*
             * The wallet channel is born COMPLETED because the ledger entry commits in
             * this same transaction — the ledger IS the wallet, so there is no later
             * moment at which the money arrives. The manual channel is born
             * AWAITING_EXTERNAL, and a person is what moves it on.
             */
            state: immediate ? 'COMPLETED' : 'AWAITING_EXTERNAL',
            channel,
            amount,
            reason: input.reason,
            requestedByAdminId: this.adminIdOf(actor),
            completedByAdminId: immediate ? this.adminIdOf(actor) : null,
            completedAt: immediate ? now : null,
            now,
          },
          tx,
        );

        if (immediate) {
          await this.creditWallet(scope, created, actor, now, tx);
          await this.closeUnfulfilledOrder(scope, actor, created, now, tx);
        }

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'refund.request',
            entityType: 'Refund',
            entityId: created.id,
            before: null,
            after: auditView(created),
            result: 'SUCCESS',
          },
          tx,
        );
        await this.remember(scope, input.idempotencyKey, requestHash, created.id, tx);
        return created;
      },
    );
  }

  /**
   * Records that the external transfer actually happened.
   *
   * The manual channel's second step, and the reason `AWAITING_EXTERNAL` exists. Only an
   * operator with `refunds.issue` may say this, because saying it is the only evidence
   * the money left: this installation has no bank API, and inventing one would be the
   * silent-success defect with money attached.
   *
   * A refund already COMPLETED is answered WITH the refund rather than refused — that is
   * the end state the caller asked for, which is the rule `PAYMENT_STATE_INVALID` states
   * about a confirmation. A FAILED one is refused, because reviving it would release an
   * amount that is already accounted for.
   */
  async complete(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly refundId: string;
      readonly note: string;
      readonly externalReference: string | null;
    },
  ): Promise<RefundRecord> {
    // Parsed rather than cast, for the reason `request` states about `paymentId`.
    const refundId = parseIdentifier(refundIdSchema, input.refundId, 'refund');
    const denial = { action: 'refund.complete', entityType: 'Refund', entityId: refundId };
    await this.authorize(scope, actor, REFUND_ISSUE_PERMISSION, denial);

    const requestHash = hashRequest({
      refundId,
      note: input.note,
      externalReference: input.externalReference,
    });
    const replayed = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      REFUND_ISSUE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.requireRefundForUpdate(scope, refundId, tx);

        // Already there. Answered with the refund, and NO audit row — an audit entry for
        // a change that did not happen is the legacy activity feed.
        if (before.state === 'COMPLETED') {
          await this.remember(scope, input.idempotencyKey, requestHash, refundId, tx);
          return before;
        }
        if (!refundMayTransition(before.state, 'COMPLETED')) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.REFUND_STATE_INVALID,
            'This refund can no longer be completed.',
            { state: before.state },
          );
        }

        const after = await this.deps.repository.transition(
          scope,
          refundId,
          {
            from: before.state,
            to: 'COMPLETED',
            completedByAdminId: this.adminIdOf(actor),
            completedAt: now,
            externalReference: input.externalReference,
            completionNote: input.note,
          },
          now,
          tx,
        );
        if (after === null) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.REFUND_STATE_INVALID,
            'Another operator changed this refund while the request was in flight.',
            { reason: 'STATE_RACE' },
          );
        }

        await this.closeUnfulfilledOrder(scope, actor, after, now, tx);

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'refund.complete',
            entityType: 'Refund',
            entityId: refundId,
            before: auditView(before),
            after: auditView(after),
            result: 'SUCCESS',
          },
          tx,
        );
        await this.remember(scope, input.idempotencyKey, requestHash, refundId, tx);
        return after;
      },
    );
  }

  /**
   * Abandons a refund, RELEASING its amount back to the refundable balance.
   *
   * The honest alternative to deleting a row. A refund that should not have happened
   * stays visible and terminal, and the payment becomes refundable again by the sum
   * rather than by the evidence disappearing — which is the over-refund achieved by
   * destroying the record, and why 0073 forbids DELETE outright.
   *
   * A COMPLETED refund cannot be failed: the money is gone, and saying otherwise would
   * free an amount that has already left. The database refuses it too.
   */
  async fail(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly refundId: string;
      readonly note: string;
    },
  ): Promise<RefundRecord> {
    // Parsed rather than cast, for the reason `request` states about `paymentId`.
    const refundId = parseIdentifier(refundIdSchema, input.refundId, 'refund');
    const denial = { action: 'refund.fail', entityType: 'Refund', entityId: refundId };
    await this.authorize(scope, actor, REFUND_ISSUE_PERMISSION, denial);

    const requestHash = hashRequest({ refundId, note: input.note, intent: 'FAIL' });
    const replayed = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      REFUND_ISSUE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.requireRefundForUpdate(scope, refundId, tx);

        if (before.state === 'FAILED') {
          await this.remember(scope, input.idempotencyKey, requestHash, refundId, tx);
          return before;
        }
        if (!refundMayTransition(before.state, 'FAILED')) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.REFUND_STATE_INVALID,
            'A completed refund cannot be abandoned. The money has already gone back.',
            { state: before.state },
          );
        }

        const after = await this.deps.repository.transition(
          scope,
          refundId,
          { from: before.state, to: 'FAILED', completionNote: input.note },
          now,
          tx,
        );
        if (after === null) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.REFUND_STATE_INVALID,
            'Another operator changed this refund while the request was in flight.',
            { reason: 'STATE_RACE' },
          );
        }

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'refund.fail',
            entityType: 'Refund',
            entityId: refundId,
            before: auditView(before),
            after: auditView(after),
            result: 'SUCCESS',
          },
          tx,
        );
        await this.remember(scope, input.idempotencyKey, requestHash, refundId, tx);
        return after;
      },
    );
  }

  // -------------------------------------------------------------------------

  /**
   * One append-only ledger entry, whose reference is derived from the refund.
   *
   * `${refundId}:refund` — derived, never supplied, so the ledger's unique
   * `(tenant_id, reference)` admits at most one credit for this refund. Not because a
   * replay arrives here — it does not, `replay` answers that first — but because the
   * one-to-one between a refund and its credit becomes a constraint rather than an
   * intention, and holds against any writer. The top-up path derives
   * `${paymentId}:topup` for the same reason.
   *
   * `lockCustomer` first, matching every other write to this ledger. A credit cannot
   * overdraw so it does not strictly need the serialisation, but taking the lock in one
   * order everywhere is what keeps two movements of one wallet from deadlocking.
   */
  private async creditWallet(
    scope: TenantContext,
    refund: RefundRecord,
    actor: ActorContext,
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    const present = await this.deps.wallet.lockCustomer(scope, refund.customerId, tx);
    if (!present) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
    }
    await this.deps.wallet.append(
      scope,
      {
        id: this.deps.ids.uuid(),
        customerId: refund.customerId,
        direction: 'CREDIT',
        reason: 'REFUND',
        amount: refund.amount,
        reference: `${refund.id}:refund`,
        orderId: refund.orderId,
        paymentId: refund.paymentId,
        actorAdminId: this.adminIdOf(actor),
        note: refund.reason,
        now,
      },
      tx,
    );
  }

  /**
   * The money went back, so the order stops waiting to be fulfilled.
   *
   * Codex C4-N1 on PR #50. `PAID_UNFULFILLED -> REFUNDED on REFUND` was a declared
   * edge of `ORDER_MACHINE` that NOTHING drove, so a refunded stranded order kept its
   * state, kept its open ERROR condition, and stayed acceptable to
   * `OrderFulfilmentService.fulfil` — which would have created the service after the
   * customer's money had already been returned. Both losses, on one order.
   *
   * ## Why COMPLETED rather than "a refund exists"
   *
   * Requesting a manual refund is a DECISION; the bank transfer has not happened, and
   * `fail` can still undo it. An operator who finds the panel working again in that
   * window may legitimately fulfil instead. So this runs where the refund actually
   * becomes effective, and there are exactly two such places: the wallet channel, born
   * `COMPLETED` because the ledger entry commits in the same transaction, and
   * `complete`, which is a person saying the transfer left.
   *
   * ## Why any completed refund closes it, not only a full one
   *
   * A `PAID_UNFULFILLED` order has no service, so there is nothing a partial refund
   * could be partial payment FOR. Leaving such an order open to `fulfil` because only
   * some of the money went back is the reading that costs a customer; closing it leaves
   * the operator the ordinary remedy of refunding the rest. `settled_at` and the
   * `unfulfilled_*` stamps all survive, so what happened stays readable.
   *
   * Anything else — a `PAID` order, a top-up with no order at all — is left alone. A
   * refund against a delivered service is a financial record and not a lifecycle event,
   * and changing that is not this finding's business.
   */
  private async closeUnfulfilledOrder(
    scope: TenantContext,
    actor: ActorContext,
    refund: RefundRecord,
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    if (refund.state !== 'COMPLETED' || refund.orderId === null) return;

    const orderId = refund.orderId as OrderId;
    const order = await this.deps.orders.findById(scope, orderId, tx);
    if (order === null || order.state !== 'PAID_UNFULFILLED') return;

    const to = nextState(ORDER_MACHINE, 'PAID_UNFULFILLED', 'REFUND');
    if (to === null) {
      throw new Error('ORDER_MACHINE no longer allows REFUND from PAID_UNFULFILLED.');
    }
    /*
     * Conditional on the state we read, like every other transition in this codebase:
     * a `fulfil` that committed between the read and this UPDATE wins, and this one
     * writes nothing rather than dragging a fulfilled order into REFUNDED.
     */
    const moved = await this.deps.orders.transition(
      scope,
      orderId,
      'PAID_UNFULFILLED',
      to,
      { refundedAt: now },
      now,
      tx,
    );
    if (!moved) return;

    await this.deps.unfulfilled.resolve(
      scope,
      { id: orderId, correlationId: actor.correlationId },
      `refunded (${refund.id})`,
      tx,
    );
  }

  /**
   * Why this payment cannot be refunded at all, or null when it can.
   *
   * Three facts, and none of them is something a different amount would fix — which is
   * what separates them from `REFUND_EXCEEDS_REFUNDABLE`. Returned as a reason string
   * for the detail rather than thrown, so both the read path (which renders
   * `refundable: false`) and the write path (which refuses) use one decision.
   */
  private refundabilityOf(payment: PaymentRecord): string | null {
    if (payment.state !== 'CONFIRMED') return 'PAYMENT_NOT_SETTLED';
    /*
     * A wallet TOP-UP is not refundable through this service, and the reason is where its
     * money already went. Confirming a top-up appended a `TOPUP_RECEIPT` credit to the
     * customer's wallet. The channel below is derived from the payment METHOD alone, so a
     * top-up paid by bank transfer resolved to `EXTERNAL_MANUAL` — and an operator could
     * return the money through the bank while the customer kept, and could still spend,
     * the credit. One transfer, paid back twice.
     *
     * Reversing the credit instead is not a mechanical fix: the customer may have spent
     * it, and whether a wallet may go negative is `UNK-UM-005`, still open. So a top-up is
     * refused here — where the read path renders `refundable: false` for the same reason
     * — and `OQ-5H-04` records the decision that would make one refundable.
     */
    if (!REFUND_METHOD_SUPPORT[payment.method].supported) return 'CHANNEL_UNSUPPORTED';
    // After the channel: a method with no reversal channel at all is the more fundamental
    // refusal, and it is the one an operator can do nothing about.
    if (payment.orderId === null) return 'TOPUP_CREDITED_TO_WALLET';
    return null;
  }

  private async requirePayment(
    scope: TenantContext,
    id: PaymentId,
    tx?: unknown,
  ): Promise<PaymentRecord> {
    const payment = await this.deps.payments.findById(scope, id, tx);
    if (payment === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.');
    }
    return payment;
  }

  private async requireRefundForUpdate(
    scope: TenantContext,
    id: RefundId,
    tx: TransactionScope,
  ): Promise<RefundRecord> {
    const refund = await this.deps.repository.findByIdForUpdate(scope, id, tx);
    if (refund === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.REFUND_NOT_FOUND, 'Unknown refund.');
    }
    return refund;
  }

  /** The administrator behind this actor, or null for one that is not an administrator. */
  private adminIdOf(actor: ActorContext): string | null {
    return actor.type === 'WEB_ADMIN' || actor.type === 'TELEGRAM_ADMIN' ? actor.id : null;
  }

  private async replay(
    scope: TenantContext,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<RefundRecord | null> {
    const found = await this.deps.idempotency.find<RefundResult>(
      scope,
      'WEB',
      idempotencyKey,
      requestHash,
    );
    if (found === null) return null;
    return this.deps.repository.findById(scope, found.result.refundId as RefundId);
  }

  private async remember(
    scope: TenantContext,
    idempotencyKey: string,
    requestHash: string,
    refundId: RefundId,
    tx: TransactionScope,
  ): Promise<void> {
    await rememberOnce(
      this.deps.idempotency,
      scope,
      'WEB',
      idempotencyKey,
      requestHash,
      { refundId } satisfies RefundResult,
      tx,
    );
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
}

/**
 * Every field a before/after pair needs to answer what changed.
 *
 * The amount is a STRING because an audit payload is JSON and a `bigint` does not
 * survive it. The channel is here even though it never changes: an audit row is read on
 * its own, and one that omitted it would leave a reader unable to tell a wallet reversal
 * from a bank transfer somebody had to make by hand.
 */
function auditView(refund: RefundRecord): Record<string, unknown> {
  return {
    paymentId: refund.paymentId,
    customerId: refund.customerId,
    state: refund.state,
    channel: refund.channel,
    amountMinor: refund.amount.amountMinor.toString(),
    currency: refund.amount.currency,
    reason: refund.reason,
    requestedByAdminId: refund.requestedByAdminId,
    completedByAdminId: refund.completedByAdminId,
    externalReference: refund.externalReference,
    completionNote: refund.completionNote,
  };
}

/** The channel a payment method refunds through, for a surface that needs to say so. */
export function refundChannelFor(method: PaymentRecord['method']): RefundChannel {
  return REFUND_METHOD_SUPPORT[method].channel;
}
