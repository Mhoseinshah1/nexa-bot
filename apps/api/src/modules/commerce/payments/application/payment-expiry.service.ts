import {
  errors,
  systemJobActor,
  COMMERCE_ERROR_CODES,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { OrderRepository } from '../../orders/application/ports.js';
import type { PaymentRepository } from './ports.js';

/**
 * How many rows one pass moves, per kind.
 *
 * The same bound `SERVICE_EXPIRY_SWEEP_LIMIT` is, and for the reason it gives: a tenant
 * whose orders all lapse on one midnight must not turn a single tick into ten thousand
 * rows held in one transaction. The candidates are ordered by deadline, so the next
 * pass continues where this one stopped rather than starting again at the top.
 */
export const PAYMENT_EXPIRY_SWEEP_LIMIT = 200;

/** What one pass did, for the loop's log and for a test. */
export interface PaymentExpiryReport {
  readonly payments: number;
  readonly orders: number;
}

export interface PaymentExpiryServiceDeps {
  readonly payments: PaymentRepository;
  readonly orders: OrderRepository;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * The sweep that closes an unpaid order and the payment instruction it issued.
 *
 * This is what `OQ-4C-01` was waiting for. That question recorded the gap and the
 * owner's rule in the same breath — «مهلت پرداخت حداکثر یک ساعت است و پس از آن پرداخت و
 * سفارش باید منقضی یا لغو شوند. این قاعده باید در دامنه و سرور اجرا شود، نه با یک تایمر
 * در مرورگر» — at most one hour, after which the payment AND the order must be expired
 * or cancelled, enforced in the domain and on the server rather than by a browser
 * timer. What 4C lacked was somewhere to put the number, not the number.
 *
 * Until now the deadline was only ever a REFUSAL. `orderAwaitingPayment` compares it to
 * the clock and throws `ORDER_EXPIRED`, which stops a customer paying at a stale quote
 * and leaves the row saying it is awaiting payment for ever. An operator looking at a
 * month-old order could not tell it from one raised this morning.
 *
 * ## Payments first, then orders
 *
 * A payment's deadline is the earlier of its own window and its order's, so a payment
 * always expires no later than the order it names. Taking payments first means a tick
 * that hits its bound leaves behind an order that still has a live payment — which is
 * the consistent half-state — rather than an expired order with a live instruction to
 * send money for it, which is the one a customer could act on.
 *
 * ## What this does NOT do
 *
 * **It never touches a CONFIRMED payment or a PAID order.** Both statements name their
 * source state, and the order half carries a redundant `NOT EXISTS` over confirmed
 * payments as well — see `DrizzleOrderRepository.expireDue` for why a redundant
 * predicate is worth its cost when the failure it guards is an order somebody paid for
 * being marked expired.
 *
 * **It sends nothing.** A customer is not told here, and that is a deliberate boundary
 * rather than an omission: there is no durable per-customer notification lane in this
 * release — `DeliveryService` is service-delivery's own, keyed on a `services` column —
 * and a best-effort send from inside the sweep would be a message whose failure nobody
 * records. The customer meets the outcome the next time they act on the payment, where
 * `bot.payment.not_pending` says what happened. `docs/open-questions.md` carries the
 * notification as 4H's.
 *
 * ## Why an operator's late confirmation is now refused
 *
 * `confirmManualTransfer` passes `OPERATOR_MAY_CONFIRM_LATE`, which exempts an operator
 * from the ORDER's deadline so that money already in the bank is not stranded by a
 * receipt that sat in the queue. That exemption still stands and it is now BOUNDED:
 * once this sweep has expired the payment, `confirm` finds it no longer PENDING and
 * refuses. That is the owner's rule applied, not an oversight — and the remedy for
 * money that did arrive is the wallet credit an operator already has
 * (`users.wallet.credit`, `POST /users/:id/wallet/adjust`), which is audited, reversible
 * by a second adjustment and does not require reopening a closed payment.
 */
export class PaymentExpiryService {
  constructor(private readonly deps: PaymentExpiryServiceDeps) {}

  private actor(): ActorContext {
    return systemJobActor('payment-expiry', this.deps.ids.uuid() as CorrelationId);
  }

  /**
   * One pass. Returns what it moved so the loop can pace itself and a test can assert.
   *
   * Both halves in ONE transaction, because a payment expired without its order is a
   * customer who cannot pay and an order that still says they can.
   *
   * The scope-activity check is inside that transaction and before either write, for
   * the reason `CLAUDE.md` gives: a surface checks on arrival and a stop can commit in
   * between, so the check that counts is the one sharing a transaction with the write.
   * A stopped tenant's rows simply wait; nothing about them decays.
   */
  async runOnce(scope: TenantContext): Promise<PaymentExpiryReport> {
    const now = this.deps.clock.now();
    const actor = this.actor();

    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
        throw errors.conflict(
          COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
          'This installation has stopped accepting work.',
        );
      }

      const payments = await this.deps.payments.expireDue(
        scope,
        now,
        PAYMENT_EXPIRY_SWEEP_LIMIT,
        tx,
      );
      for (const payment of payments) {
        /*
         * An AUDIT row and no operational event, the same call `ProvisionerService`'s
         * service expiry makes and for the reason recorded there: an audit row is a
         * mutation with a before and an after, and an operational event is a condition
         * an operator must act on. A payment window closing is the product working.
         * Recording it as an operator condition is how `/admin/logs` became a feed.
         */
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'payment.expire',
            entityType: 'Payment',
            entityId: payment.id,
            before: { state: 'PENDING', expiresAt: payment.expiresAt?.toISOString() ?? null },
            after: { state: payment.state, orderId: payment.orderId },
            result: 'SUCCESS',
          },
          tx,
        );
      }

      const orders = await this.deps.orders.expireDue(scope, now, PAYMENT_EXPIRY_SWEEP_LIMIT, tx);
      for (const order of orders) {
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'order.expire',
            entityType: 'Order',
            entityId: order.id,
            before: {
              state: 'AWAITING_PAYMENT',
              expiresAt: order.expiresAt?.toISOString() ?? null,
            },
            after: { state: order.state },
            result: 'SUCCESS',
          },
          tx,
        );
      }

      return { payments: payments.length, orders: orders.length };
    });
  }
}
