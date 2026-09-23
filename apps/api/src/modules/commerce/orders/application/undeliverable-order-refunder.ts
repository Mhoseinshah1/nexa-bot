import {
  AUTOMATIC_REFUND_REASON,
  ORDER_MACHINE,
  nextState,
  type ActorContext,
  type Clock,
  type OperationalEventRecorder,
  type OrderId,
  type OrderState,
  type TenantContext,
} from '@nexa/contracts';
import type { CustomerNotifier } from '../../messaging/application/customer-notifier.js';
import type { OrderUsernameLane } from '../../provisioning/application/username-lane.js';
import type { PanelSalesGate } from '../../../platform/panels/application/panel-sales-gate.js';
import type { RefundService } from '../../payments/application/refund.service.js';
import type { PaymentRecord } from '../../payments/application/ports.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { OrderRecord } from './ports.js';
import type { OrderRepository } from './ports.js';

/**
 * What an operator reads when this installation gave money back by itself.
 *
 * INFO and not WARN, which is a deliberate answer to a question this branch got
 * wrong once. An order that could not be delivered is a FACT with no outstanding
 * work: the money is back, the customer has been told, and nothing is owed. The
 * thing an operator must actually fix — a panel at capacity, a panel unhealthy, a
 * provisioner that cannot reach one — already raises its own ERROR condition with
 * its own recovery, from `PanelSalesGate` and from the provisioner. A second
 * unresolvable WARN per refunded order would rebuild, in the operations log, the
 * queue-that-only-grows the `PAID_UNFULFILLED` state was removed for.
 */
export const ORDER_REFUNDED_CODE = 'order.refunded_undeliverable';

/** One row per ORDER: a replayed refund increments a counter rather than adding an item. */
export function undeliverableConditionKey(orderId: string): string {
  return `${ORDER_REFUNDED_CODE}:${orderId}`;
}

export interface UndeliverableOrderRefunderDeps {
  /**
   * The order WRITE, narrowed to the one edge this drives.
   *
   * `findById` and `transition` only, so the lane that gives money back cannot grow
   * into a second place orders are managed from.
   */
  readonly orders: Pick<OrderRepository, 'findById' | 'transition'>;
  /**
   * The money, and nothing else. One method, because there is one credit path.
   *
   * `RefundService.refundUndeliverable` locks the payment, sums what is already
   * committed and writes at most one ledger entry. This module never appends to the
   * wallet itself — a second writer would be a second answer to "how much did we
   * give back".
   */
  readonly refunds: Pick<RefundService, 'refundUndeliverable'>;
  /**
   * Gives the capacity slot back, if one is still held.
   *
   * Idempotent by construction (`capacity.release` deletes by order id and reports
   * whether a row was there), which is why this is safe on a path that may run after
   * `PanelSalesGate.consume` already released the hold. It is called anyway rather
   * than reasoned about: `consume` returns early WITHOUT releasing when the panel row
   * has gone, and a hold nobody released occupies a slot until it expires — a panel
   * that filled up would refuse the next customer because of the order it had just
   * refunded.
   */
  readonly panelSales: Pick<PanelSalesGate, 'release'>;
  /**
   * Gives the USERNAME back, on the same terms as the slot.
   *
   * The only path that may. A name is held for ever once `funded_at` is stamped —
   * expiry alone is not release, because a funded name belongs to a service somebody
   * is holding — so the ONE thing that can free a funded name is the discovery that
   * the service will never exist. That is exactly this transaction, and it is the
   * same transaction that gives the money back, so a customer never ends up without
   * either their service or their name while their money is gone.
   *
   * Idempotent, like the slot: `release` deletes by order id and reports whether a
   * row was there, so a legacy order that never reserved one is a false and not an
   * error.
   */
  readonly usernames: Pick<OrderUsernameLane, 'release'>;
  /**
   * Gives a TRIAL back, on the same terms as the slot and the name.
   *
   * A trial order that could not be delivered must not count against the customer's
   * limit — plan §7.1, `docs/wp6-audit.md` A4 — and this is the transaction that has
   * just established it never will be. Idempotent: `release` stamps only a grant not
   * already released and reports whether it did.
   */
  readonly trials: {
    release(
      scope: TenantContext,
      orderId: string,
      at: Date,
      tx: TransactionScope,
    ): Promise<boolean>;
  };
  /** Tells the customer, in the transaction that made it true. */
  readonly notifier: CustomerNotifier;
  readonly opsLog: OperationalEventRecorder;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/**
 * The second of an order's two terminal outcomes: the money goes back.
 *
 * ONE collaborator rather than five calls at each site, because there are two sites
 * in two modules — settlement discovering it cannot deliver, and the provisioner
 * discovering the same thing after the fact — and every part has to happen at both.
 * The predecessor of this class paired `strand` with `resolve` for the same reason,
 * and the asymmetry it was written to make visible is exactly the one that killed
 * the design it served: a condition opened by one module and closed by another.
 *
 * Everything joins the CALLER's transaction. The state change, the ledger entry, the
 * released slot, the event and the customer's message are one commit or none. A
 * process that died between the transition and the credit would leave an order
 * marked REFUNDED with the money still taken, which is the one outcome worse than
 * the state this replaced.
 *
 * ## Idempotent at three levels, and none is the other's excuse
 *
 *   - the order transition is conditional on `from`, so two callers racing produce
 *     one winner and one no-op;
 *   - `refundUndeliverable` locks the payment and returns `null` when nothing is
 *     left to give back, so a replay past the transition credits nothing;
 *   - `customer_notifications_subject_key` is unique on (tenant, kind, subject) and
 *     the enqueue is `ON CONFLICT DO NOTHING`, so the customer is told once.
 */
export class UndeliverableOrderRefunder {
  constructor(private readonly deps: UndeliverableOrderRefunderDeps) {}

  /**
   * Refund `order` in full and close it. True when THIS call did it.
   *
   * `from` is named by the caller rather than read off the row, because the two
   * lanes reach here from different states and a conditional UPDATE that guessed
   * would be a conditional UPDATE that matched something else. Settlement comes from
   * `AWAITING_PAYMENT`, in the transaction that confirmed the payment; the
   * provisioner comes from `PAID`, after the service it planned turned out to be
   * impossible.
   *
   * `false` means somebody else moved the order first — a concurrent refund, or a
   * settlement that won. Nothing is written, and the caller must not report a refund
   * it did not perform.
   */
  async refund(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly order: OrderRecord;
      readonly from: Extract<OrderState, 'AWAITING_PAYMENT' | 'PAID'>;
      /**
       * The money to give back — and `null` ONLY for a trial, which moved none.
       *
       * A null is accepted for an order whose purpose is `TRIAL` and whose total is
       * zero (`orderIsFreeTrial`, and `orders_trial_is_free_check` beneath it), and
       * declined for anything else: a priced order with no confirmed payment is the
       * broken database `refundPurchase` describes, and "refund" it by closing the
       * order would be telling a customer they were paid back with nothing credited.
       */
      readonly payment: PaymentRecord | null;
      /** WHY it could not be delivered — a closed vocabulary, never a provider's text. */
      readonly reason: string;
      readonly now: Date;
      /**
       * An operator condition this refund ANSWERS, if the caller opened one.
       *
       * Carried into the event row this method already writes rather than recorded
       * as a second one: both would be `ORDER_REFUNDED_CODE`, and the same fact
       * twice in an operations log is what that log exists not to be.
       *
       * The provisioner passes `provisioning.stalled` for the service it has just
       * terminated. That ERROR's only recoveries are DELIVERIES of that service, so
       * nothing left could ever close it and every definitive failure added one to a
       * queue that only grew — the shape the two-outcome decision deleted. Found by
       * Codex. The settlement lane passes nothing: it refunds before any service
       * exists, so there is no condition open.
       */
      readonly recovers?: {
        readonly code: string;
        readonly dedupeKey: string;
      };
    },
    tx: TransactionScope,
  ): Promise<boolean> {
    const { order, from, payment, reason, now, recovers } = input;
    const orderId = order.id as OrderId;
    const trial = isFreeTrial(order);
    if (payment === null && !trial) return false;

    const to = nextState(ORDER_MACHINE, from, 'REFUND');
    if (to === null) {
      throw new Error(`ORDER_MACHINE no longer allows REFUND from ${from}.`);
    }

    const moved = await this.deps.orders.transition(
      scope,
      orderId,
      from,
      to,
      {
        /*
         * `settledAt` on the settlement lane only. `orders_settled_at_check` is an
         * equality over the settled states and `REFUNDED` is one of them, so the
         * stamp has to exist — and on the provisioner lane it already does, written
         * when the order reached `PAID`. Passing it there would overwrite when the
         * money arrived with when we gave it back.
         */
        ...(from === 'AWAITING_PAYMENT' ? { settledAt: now } : {}),
        refundedAt: now,
      },
      now,
      tx,
    );
    if (!moved) return false;

    /*
     * The slot, before the money, and before anything that could throw on its own
     * account. A refunded order holds nothing.
     */
    await this.deps.panelSales.release(scope, orderId, tx);
    // And the name, for the same reason and in the same breath. A refunded order
    // holds nothing — not a slot, and not a name somebody else could be using.
    await this.deps.usernames.release(scope, orderId, tx);
    // And the trial allowance, so an undelivered trial does not count. A no-op for
    // every order that is not a trial: only a trial order has a grant.
    if (trial) await this.deps.trials.release(scope, orderId, now, tx);

    /*
     * The one credit path, skipped only when there is nothing to credit. A trial's
     * total is zero and `RefundService` would refuse a zero refund anyway
     * (`refunds_amount_check`), so the absence of a payment is not a shortcut
     * around the ledger — it is the ledger having nothing to say.
     */
    const refund =
      payment === null
        ? null
        : await this.deps.refunds.refundUndeliverable(scope, actor, { payment, now }, tx);
    const credited = refund?.amount ?? order.totals.total;

    await this.deps.opsLog.record(
      scope,
      {
        code: ORDER_REFUNDED_CODE,
        severity: 'INFO',
        message: trial
          ? `trial order ${orderId} could not be delivered (${reason}); the trial was given back and does not count`
          : `order ${orderId} could not be delivered (${reason}) and was refunded to the customer's wallet`,
        dedupeKey: undeliverableConditionKey(orderId),
        context: {
          orderId,
          customerId: order.customerId,
          panelId: order.line.panelId,
          purpose: order.purpose,
          reason,
          amountMinor: credited.amountMinor.toString(),
          currency: credited.currency,
        },
        ...(recovers === undefined
          ? {}
          : { recoversCode: recovers.code, recoversDedupeKey: recovers.dedupeKey }),
        correlationId: actor.correlationId,
      },
      tx,
    );

    await this.deps.outbox.write(tx, actor, {
      eventType: 'OrderRefunded',
      aggregateType: 'Order',
      aggregateId: orderId,
      payload: {
        customerId: order.customerId,
        amountMinor: credited.amountMinor.toString(),
        currency: credited.currency,
        reason: AUTOMATIC_REFUND_REASON,
      },
    });

    /*
     * The answer is deliberately not checked. A customer with no durable bot link
     * has nobody to tell, and `rejectManualTransfer` states the rule this shares: a
     * messaging concern may not veto a decision about money. The refund is on the
     * ledger either way, and `/wallet` shows it.
     */
    await this.deps.notifier.notify(
      scope,
      order.customerId,
      // A trial moved no money, so "refunded to your wallet" would be false.
      trial ? 'TRIAL_NOT_DELIVERED' : 'ORDER_REFUNDED_TO_WALLET',
      orderId,
      now,
      tx,
    );

    return true;
  }
}

/**
 * `orderIsFreeTrial`, the guard on the order machine's `GRANT` edge, read back off a
 * stored order: purpose `TRIAL` AND a zero total. Both, because either alone is a
 * different thing — a zero-total purchase would be a pricing bug, and a priced trial is
 * what `orders_trial_is_free_check` exists to make impossible.
 */
export function isFreeTrial(order: Pick<OrderRecord, 'purpose' | 'totals'>): boolean {
  return order.purpose === 'TRIAL' && order.totals.total.amountMinor === 0n;
}
