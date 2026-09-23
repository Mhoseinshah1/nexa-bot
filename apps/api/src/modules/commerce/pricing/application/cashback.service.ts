import {
  cashbackTargetMinor,
  money,
  systemJobActor,
  type ActorContext,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type TenantContext,
  type UnitOfWork,
  type UserId,
  type OrderId,
  type PaymentId,
} from '@nexa/contracts';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { WalletRepository } from '../../wallet/application/ports.js';
import type { PaymentRepository } from '../../payments/application/ports.js';
import type { RefundRepository } from '../../payments/application/refund-ports.js';
import type { RefundRecord } from '../../payments/application/refund-ports.js';
import type { OrderCashbackRecord, OrderCashbackRepository } from './ports.js';

export interface CashbackServiceDeps {
  readonly orderCashback: OrderCashbackRepository;
  readonly wallet: Pick<WalletRepository, 'append' | 'lockCustomer' | 'balanceOf'>;
  readonly payments: Pick<PaymentRepository, 'findConfirmedForOrder' | 'findById'>;
  readonly refunds: Pick<RefundRepository, 'listForPayment'>;
  readonly outbox: OutboxWriter;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * An order's cashback, from promise to credit to reversal (`docs/wp8-pricing-audit.md` P9).
 *
 * ## Where earning happens: a lane, not thirteen call sites
 *
 * The provisioner moves an operation to `SUCCEEDED` in thirteen places. A hook in each is
 * thirteen chances to forget one, so the earner does not hook: `settleDue` finds every
 * `PENDING` promise whose order has an answer — delivered or ended — and decides each in
 * its own transaction. The provisioner loop drives it on every tick, right after the
 * drain that delivers, so the delay is one tick. A crash between the delivery and the
 * credit costs a tick, never the credit: the promise is still `PENDING`.
 *
 * ## Exactly once
 *
 * Three things, each sufficient: the promise moves `PENDING -> EARNED` by a conditional
 * UPDATE; the credit's reference is `${orderId}:cashback`, unique per tenant; and both are
 * in one transaction under the customer's wallet lock. Two earners reaching one promise
 * serialise on that lock, and the second finds it `EARNED`.
 *
 * ## Lock order
 *
 * The customer's wallet lock, then the promise row. A refund's reversal takes the same
 * two in the same order after its own payment or refund lock, and this service never
 * locks a payment or a refund, so no cycle exists.
 */
export class CashbackService {
  constructor(private readonly deps: CashbackServiceDeps) {}

  /** Decides up to `limit` answered promises, oldest first. Returns how many it moved. */
  async settleDue(scope: TenantContext, limit: number): Promise<number> {
    const due = await this.deps.orderCashback.due(scope, limit);
    let moved = 0;
    for (const item of due) {
      if (await this.settle(scope, item.orderId)) moved += 1;
    }
    return moved;
  }

  /**
   * One promise, decided: `EARNED` if its order was delivered, `VOID` if the order ended
   * without delivery, untouched while the order is still in flight.
   *
   * Reads scope activity inside the transaction, as every write path does. A stopped
   * scope earns nothing now and loses nothing: the promise stays `PENDING` and is decided
   * when the scope resumes.
   */
  async settle(scope: TenantContext, orderId: string): Promise<boolean> {
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return false;

      const found = await this.deps.orderCashback.findByOrder(scope, orderId, tx);
      if (found === null || found.state !== 'PENDING') return false;

      await this.deps.wallet.lockCustomer(scope, found.customerId as UserId, tx);
      const promise = await this.deps.orderCashback.lockByOrder(scope, orderId, tx);
      if (promise === null || promise.state !== 'PENDING') return false;

      const answer = await this.deps.orderCashback.dueFor(scope, orderId, tx);
      if (answer === null) return false;

      const now = this.deps.clock.now();
      if (!answer.delivered) {
        // The order ended without delivery: cancelled, expired, or refunded because it
        // could not be delivered. Nothing was ever credited, so nothing is reversed.
        return this.deps.orderCashback.void(scope, promise.id, now, tx);
      }

      const payment = await this.deps.payments.findConfirmedForOrder(
        scope,
        orderId as OrderId,
        tx,
      );
      if (payment === null) {
        /*
         * Delivered, with no confirmed payment behind it: a trial never gets here (its
         * quote promises nothing), so this is a database the settlement guard says
         * cannot exist. VOID rather than left PENDING, because a PENDING row the earner
         * cannot decide is returned first on every tick, for ever, ahead of every
         * promise it could.
         */
        return this.deps.orderCashback.void(scope, promise.id, now, tx);
      }

      const refunded = await this.completedRefunds(scope, payment.id, tx);
      const earned = cashbackTargetMinor(
        promise.amount.amountMinor,
        payment.amount.amountMinor,
        refunded,
      );

      let entryId: string | null = null;
      const actor = this.actor();
      if (earned > 0n) {
        const { entry, inserted } = await this.deps.wallet.append(
          scope,
          {
            id: this.deps.ids.uuid(),
            customerId: promise.customerId as UserId,
            direction: 'CREDIT',
            reason: 'CASHBACK_PURCHASE',
            amount: money(earned, promise.amount.currency),
            reference: `${orderId}:cashback`,
            orderId: orderId as OrderId,
            paymentId: payment.id,
            note: promise.ruleLabel,
            now,
          },
          tx,
        );
        entryId = entry.id;
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
      }

      const moved = await this.deps.orderCashback.earn(
        scope,
        promise.id,
        { earnedAmount: earned, entryId, now },
        tx,
      );
      if (moved && earned > 0n) {
        await this.deps.outbox.write(tx, actor, {
          eventType: 'CashbackEarned',
          aggregateType: 'Order',
          aggregateId: orderId,
          payload: {
            customerId: promise.customerId,
            orderId,
            amountMinor: earned.toString(),
            currency: promise.amount.currency,
          },
        });
      }
      return moved;
    });
  }

  /**
   * Takes back the share of earned cashback a COMPLETED refund made owed (P9).
   *
   * Called INSIDE the refund's own transaction, at the moment it reaches `COMPLETED`: a
   * wallet refund is born completed and its credit has just been written, so the balance
   * read here already includes it; a manual refund completes later, and this runs then.
   *
   * `due` comes from the cumulative formula, so a series of partial refunds reverses
   * exactly what a single full one would. What the balance cannot give is recorded as
   * `unrecovered` — the balance never goes negative and history is never edited. One
   * reversal per refund, so a replayed completion takes nothing twice.
   */
  async reverseForRefund(
    scope: TenantContext,
    actor: ActorContext,
    refund: RefundRecord,
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    if (refund.state !== 'COMPLETED' || refund.orderId === null) return;

    const found = await this.deps.orderCashback.findByOrder(scope, refund.orderId, tx);
    if (found === null || found.state === 'VOID') return;

    /*
     * The state is judged only AFTER the customer's lock, never before. A `PENDING` read
     * unlocked can be an earner that is, at this instant, holding that lock and crediting
     * the full amount from a refund total that does not yet include this one; returning
     * early here would leave that credit unreversed for ever. Under the lock, a promise
     * still `PENDING` means the earner has not run, and when it does it reads this
     * refund as `COMPLETED` and earns the reduced amount.
     */
    await this.deps.wallet.lockCustomer(scope, found.customerId as UserId, tx);
    const promise = await this.deps.orderCashback.lockByOrder(scope, refund.orderId, tx);
    if (promise === null || promise.state !== 'EARNED' || promise.earnedAmount === null) return;

    const payment = await this.deps.payments.findById(scope, refund.paymentId as PaymentId, tx);
    if (payment === null) return;

    const refunded = await this.completedRefunds(scope, payment.id, tx);
    const target = cashbackTargetMinor(
      promise.amount.amountMinor,
      payment.amount.amountMinor,
      refunded,
    );
    const alreadyDue = (await this.deps.orderCashback.reversals(scope, promise.id, tx)).reduce(
      (sum, r) => sum + r.due,
      0n,
    );
    const due = promise.earnedAmount - target - alreadyDue;
    if (due <= 0n) return;

    const currency = promise.amount.currency;
    const balance = await this.deps.wallet.balanceOf(
      scope,
      promise.customerId as UserId,
      currency,
      tx,
    );
    const available = balance.amountMinor > 0n ? balance.amountMinor : 0n;
    const recovered = due < available ? due : available;
    const unrecovered = due - recovered;

    let entryId: string | null = null;
    if (recovered > 0n) {
      const { entry, inserted } = await this.deps.wallet.append(
        scope,
        {
          id: this.deps.ids.uuid(),
          customerId: promise.customerId as UserId,
          direction: 'DEBIT',
          reason: 'CASHBACK_REVERSAL',
          amount: money(recovered, currency),
          reference: `${refund.id}:cashback-reversal`,
          orderId: refund.orderId as OrderId,
          paymentId: payment.id,
          reversesEntryId: promise.earnedEntryId,
          now,
        },
        tx,
      );
      entryId = entry.id;
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
    }

    const wrote = await this.deps.orderCashback.recordReversal(
      scope,
      {
        id: this.deps.ids.uuid(),
        orderCashbackId: promise.id,
        orderId: refund.orderId,
        customerId: promise.customerId,
        refundId: refund.id,
        due,
        recovered,
        unrecovered,
        currency,
        walletEntryId: entryId,
        now,
      },
      tx,
    );
    if (wrote) {
      await this.deps.outbox.write(tx, actor, {
        eventType: 'CashbackReversed',
        aggregateType: 'Order',
        aggregateId: refund.orderId,
        payload: {
          customerId: promise.customerId,
          orderId: refund.orderId,
          refundId: refund.id,
          dueMinor: due.toString(),
          recoveredMinor: recovered.toString(),
          unrecoveredMinor: unrecovered.toString(),
          currency,
        },
      });
    }
  }

  /** What an order's cashback amounts to so far, for the operator's view. */
  async summaryFor(
    scope: TenantContext,
    orderId: string,
  ): Promise<{
    readonly promise: OrderCashbackRecord;
    readonly reversed: bigint;
    readonly unrecovered: bigint;
  } | null> {
    const promise = await this.deps.orderCashback.findByOrder(scope, orderId);
    if (promise === null) return null;
    const reversals = await this.deps.orderCashback.reversals(scope, promise.id);
    return {
      promise,
      reversed: reversals.reduce((sum, r) => sum + r.due, 0n),
      unrecovered: reversals.reduce((sum, r) => sum + r.unrecovered, 0n),
    };
  }

  /** The sum of this payment's COMPLETED refunds: money that has actually gone back. */
  private async completedRefunds(
    scope: TenantContext,
    paymentId: PaymentId,
    tx: TransactionScope,
  ): Promise<bigint> {
    const refunds = await this.deps.refunds.listForPayment(scope, paymentId, tx);
    return refunds
      .filter((r) => r.state === 'COMPLETED')
      .reduce((sum, r) => sum + r.amount.amountMinor, 0n);
  }

  private actor(): ActorContext {
    return systemJobActor('cashback', this.deps.ids.uuid() as CorrelationId);
  }
}
