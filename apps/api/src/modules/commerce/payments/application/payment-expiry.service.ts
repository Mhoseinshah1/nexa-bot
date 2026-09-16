import {
  systemJobActor,
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
import type { CustomerNotifier } from '../../messaging/application/customer-notifier.js';
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
  /**
   * The lane that tells the customer.
   *
   * `OQ-4G-01`'s answer. 4G made three outcomes reachable and a customer was told about
   * exactly one of them — the withdrawal they performed themselves. An expiry happens
   * while they are not looking, and before this the only way they found out was tapping
   * a dead button.
   *
   * Enqueued INSIDE this transaction, so a notification cannot exist without the expiry
   * that caused it, nor the expiry without the notification.
   */
  readonly notifier: CustomerNotifier;
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
 * that hits its bound leaves behind an order that still has a live payment — the
 * harmless half-state — rather than an expired order with a live instruction to send
 * money for it, which is the one a customer could act on.
 *
 * **The ordering alone does not achieve that, and an earlier version of this paragraph
 * claimed it did.** The two halves are separately bounded and separately ordered, so a
 * backlog larger than the bound moves two unrelated subsets: four hundred orders due at
 * one midnight, two hundred payments taken by payment id and two hundred orders by
 * order id, and the overlap is chance. What makes the sentence true is a predicate —
 * `DrizzleOrderRepository.expireDue` refuses an order that still has a PENDING payment
 * — and the ordering is what makes that predicate cost nothing in the ordinary case.
 *
 * ## Each row is expired by its OWN deadline
 *
 * A payment's is the earlier of `sales.payment_window_minutes` and its order's, so under
 * the defaults — both sixty minutes — the two coincide and a lapsed transfer takes its
 * order with it in the same pass. They diverge only when a tenant sets a longer order
 * window, and then the payment closes while the order stays `AWAITING_PAYMENT` for the
 * rest of the window the customer was shown.
 *
 * That is the NARROW reading of the owner's rule, which says the payment and the order
 * must both be expired or cancelled after the payment deadline. `OQ-4G-05` records the
 * other reading and why this one shipped: nothing is stranded under it — the customer
 * can start another transfer or pay from their wallet at the quoted price, inside the
 * deadline they were given — and the wide reading would take an order away from somebody
 * who still had days of it left, on the strength of one clause nobody has disambiguated.
 *
 * ## What this does NOT do
 *
 * **It never touches a CONFIRMED payment or a PAID order.** Both statements name their
 * source state, and the order half carries a `NOT EXISTS` over confirmed payments as
 * well — redundant today, and kept because the failure it guards is an order somebody
 * PAID FOR being marked expired. See `DrizzleOrderRepository.expireDue`, which
 * distinguishes that one from the live-payment predicate beside it, which is not
 * redundant at all.
 *
 * **It sends nothing, and it still does not.** This paragraph used to end "the customer
 * meets the outcome the next time they act on the payment", which 4H made false: the
 * sweep now ENQUEUES two customer notifications, one per half, through `CustomerNotifier`
 * and inside this transaction. What has not changed is the boundary the old paragraph
 * was really about — nothing here calls Telegram. A send from inside a sweep is a
 * network call inside a transaction and a message whose failure nobody records; the
 * worker's own lane (ADR 0030) sends these later, outside every transaction, and records
 * all three outcomes.
 *
 * ## Why an operator's late confirmation is now refused
 *
 * `confirmManualTransfer` passes `OPERATOR_MAY_CONFIRM_LATE`, which exempts an operator
 * from the ORDER's deadline so that money already in the bank is not stranded by a
 * receipt that sat in the queue. That exemption still stands and it is now BOUNDED:
 * once this sweep has expired the payment, `confirm` finds it no longer PENDING and
 * refuses. That is the owner's rule applied, not an oversight — and the remedy for
 * money that did arrive is a wallet credit (`users.wallet.credit`,
 * `POST /users/:id/wallet/adjust`), which is audited, reversible by a second adjustment
 * and does not require reopening a closed payment.
 *
 * That key is held by `owner` and `finance`, and NOT by `receipt_reviewer`, whose whole
 * grant is `receipts.view` and `receipts.review`. So the operator most likely to meet
 * this case is the one who cannot perform the remedy, and an installation that
 * separates those roles has to route it. Said here rather than left to be discovered.
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
      /*
       * A stopped tenant is a pass with nothing to do, NOT a failed one.
       *
       * The check stays where it is — inside the transaction, before either write —
       * because a surface checks on arrival and a stop can commit in between. What
       * changed is the answer: this used to THROW, and the loop deliberately records no
       * progress for a pass that threw, so an operator who stopped a tenant made the
       * worker report itself unhealthy three minutes later. `worker` is in
       * `NEXA_READY_SERVICES`, so `botctl update` would then fail its readiness wait and
       * back the release out — after the migration had run — and the error would point
       * at the release rather than at the stop.
       *
       * `ProvisionerService.runOnce` already answers this exact condition with `IDLE`
       * rather than an exception, and the retention sweepers do not consult activity at
       * all. A stopped tenant's rows simply wait; nothing about them decays, and the
       * loop that leaves them alone is doing its job rather than failing at it.
       */
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
        return { payments: 0, orders: 0 };
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
        await this.deps.notifier.notify(
          scope,
          payment.customerId,
          'PAYMENT_EXPIRED',
          payment.id,
          now,
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
        await this.deps.notifier.notify(
          scope,
          order.customerId,
          'ORDER_EXPIRED',
          order.id,
          now,
          tx,
        );
      }

      return { payments: payments.length, orders: orders.length };
    });
  }
}
