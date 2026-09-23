import {
  money,
  proportionalTargetMinor,
  systemJobActor,
  type ActorContext,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type OrderId,
  type PaymentId,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { WalletRepository } from '../../wallet/application/ports.js';
import type { PaymentRepository } from '../../payments/application/ports.js';
import type { RefundRecord, RefundRepository } from '../../payments/application/refund-ports.js';
import type { ReferralCommissionRepository } from './ports.js';

export interface ReferralCommissionServiceDeps {
  readonly commissions: ReferralCommissionRepository;
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
 * A referral commission, from promise to credit to reversal (`docs/wp9-referral-audit.md`
 * F7, F8, F9).
 *
 * The same lane and the same three guards as `CashbackService`, deliberately: the money
 * rule is the same one — earned once, at delivery, and given back in proportion when the
 * payment is — and a second shape for it would be a second answer. What differs is WHOSE
 * wallet: a commission is credited to the REFERRER and taken back from the referrer, so
 * the lock that serialises it is the referrer's.
 *
 * ## Lock order
 *
 * The referrer's wallet lock, then the commission row. A refund reaches the reversal
 * after its own payment or refund lock and the REFEREE's wallet lock (its credit and the
 * cashback reversal), and a referrer always registered before their referee (F2), so no
 * transaction takes an older customer's lock and then a newer one's: there is no cycle.
 */
export class ReferralCommissionService {
  constructor(private readonly deps: ReferralCommissionServiceDeps) {}

  /** Decides up to `limit` answered commissions, oldest first. Returns how many it moved. */
  async settleDue(scope: TenantContext, limit: number): Promise<number> {
    const due = await this.deps.commissions.due(scope, limit);
    let moved = 0;
    for (const item of due) {
      if (await this.settle(scope, item.orderId)) moved += 1;
    }
    return moved;
  }

  /**
   * One commission, decided: `EARNED` if its order was delivered, `VOID` if the order ended
   * without delivery or its referral has already been paid under first-order scope,
   * untouched while the order is in flight.
   *
   * A stopped scope earns nothing now and loses nothing: the row stays `PENDING`.
   */
  async settle(scope: TenantContext, orderId: string): Promise<boolean> {
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return false;

      const found = await this.deps.commissions.findByOrder(scope, orderId, tx);
      if (found === null || found.state !== 'PENDING') return false;

      await this.deps.wallet.lockCustomer(scope, found.referrerId as UserId, tx);
      const commission = await this.deps.commissions.lockByOrder(scope, orderId, tx);
      if (commission === null || commission.state !== 'PENDING') return false;

      const answer = await this.deps.commissions.dueFor(scope, orderId, tx);
      if (answer === null) return false;

      const now = this.deps.clock.now();
      if (!answer.delivered) {
        // Cancelled, expired, or refunded because it could not be delivered: nothing was
        // ever credited, so nothing is reversed.
        return this.deps.commissions.void(scope, commission.id, now, tx);
      }

      /*
       * First-order scope, decided HERE and under the referrer's lock (F7).
       *
       * Every commission of one referral is earned under the same referrer's lock, so two
       * of the referee's orders delivered at the same moment are decided one after the
       * other, and the second finds the first `EARNED`. The partial unique index is the
       * same rule in the database, for a writer that forgets to take the lock.
       */
      if (
        commission.scope === 'FIRST_PAID_ORDER' &&
        (await this.deps.commissions.hasEarnedForReferral(
          scope,
          commission.referralId,
          commission.id,
          tx,
        ))
      ) {
        return this.deps.commissions.void(scope, commission.id, now, tx);
      }

      const payment = await this.deps.payments.findConfirmedForOrder(scope, orderId as OrderId, tx);
      if (payment === null) {
        // Delivered with no confirmed payment: a trial never gets here (it is never
        // promised), so this is a database the settlement guard says cannot exist. VOID
        // rather than PENDING, which the earner would return first on every tick for ever.
        return this.deps.commissions.void(scope, commission.id, now, tx);
      }

      const refunded = await this.completedRefunds(scope, payment.id, tx);
      const earned = proportionalTargetMinor(
        commission.amount.amountMinor,
        payment.amount.amountMinor,
        refunded,
      );

      const actor = this.actor();
      let entryId: string | null = null;
      if (earned > 0n) {
        const { entry, inserted } = await this.deps.wallet.append(
          scope,
          {
            id: this.deps.ids.uuid(),
            customerId: commission.referrerId as UserId,
            direction: 'CREDIT',
            reason: 'REFERRAL_COMMISSION',
            amount: money(earned, commission.amount.currency),
            reference: `${orderId}:referral`,
            orderId: orderId as OrderId,
            paymentId: payment.id,
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

      const moved = await this.deps.commissions.earn(
        scope,
        commission.id,
        { earnedAmount: earned, entryId, now },
        tx,
      );
      if (moved && earned > 0n) {
        await this.deps.outbox.write(tx, actor, {
          eventType: 'ReferralRewarded',
          aggregateType: 'Referral',
          aggregateId: commission.referralId,
          payload: {
            referrerId: commission.referrerId,
            refereeId: commission.refereeId,
            trigger:
              commission.scope === 'FIRST_PAID_ORDER'
                ? 'ON_FIRST_PAID_ORDER'
                : 'ON_EVERY_PAID_ORDER',
            amountMinor: earned.toString(),
            currency: commission.amount.currency,
            orderId,
          },
        });
      }
      return moved;
    });
  }

  /**
   * Takes back the share of an earned commission a COMPLETED refund made owed (F8).
   *
   * Called INSIDE the refund's own transaction, at the moment it reaches `COMPLETED`, after
   * the refund's credit and the cashback reversal. `due` comes from the cumulative
   * formula, so a series of partial refunds reverses exactly what a single full one would;
   * what the referrer's balance cannot give is recorded as `unrecovered`, never collected,
   * and the balance never goes below zero. One reversal per refund.
   */
  async reverseForRefund(
    scope: TenantContext,
    actor: ActorContext,
    refund: RefundRecord,
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    if (refund.state !== 'COMPLETED' || refund.orderId === null) return;

    const found = await this.deps.commissions.findByOrder(scope, refund.orderId, tx);
    if (found === null || found.state === 'VOID') return;

    /*
     * Judged only AFTER the referrer's lock, never before — `CashbackService`'s lesson
     * (WP8-16). A `PENDING` read unlocked can be an earner that is, at this instant,
     * holding that lock and crediting the full amount from a refund total that does not
     * include this one. Under the lock, a commission still `PENDING` means the earner has
     * not run, and when it does it reads this refund as `COMPLETED` and earns less.
     */
    await this.deps.wallet.lockCustomer(scope, found.referrerId as UserId, tx);
    const commission = await this.deps.commissions.lockByOrder(scope, refund.orderId, tx);
    if (commission === null || commission.state !== 'EARNED' || commission.earnedAmount === null) {
      return;
    }

    const payment = await this.deps.payments.findById(scope, refund.paymentId as PaymentId, tx);
    if (payment === null) return;

    const refunded = await this.completedRefunds(scope, payment.id, tx);
    const target = proportionalTargetMinor(
      commission.amount.amountMinor,
      payment.amount.amountMinor,
      refunded,
    );
    const alreadyDue = (await this.deps.commissions.reversals(scope, commission.id, tx)).reduce(
      (sum, r) => sum + r.due,
      0n,
    );
    const due = commission.earnedAmount - target - alreadyDue;
    if (due <= 0n) return;

    const currency = commission.amount.currency;
    const balance = await this.deps.wallet.balanceOf(
      scope,
      commission.referrerId as UserId,
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
          customerId: commission.referrerId as UserId,
          direction: 'DEBIT',
          reason: 'REFERRAL_COMMISSION_REVERSAL',
          amount: money(recovered, currency),
          reference: `${refund.id}:referral-reversal`,
          orderId: refund.orderId as OrderId,
          paymentId: payment.id,
          reversesEntryId: commission.earnedEntryId,
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

    const wrote = await this.deps.commissions.recordReversal(
      scope,
      {
        id: this.deps.ids.uuid(),
        commissionId: commission.id,
        orderId: refund.orderId,
        referrerId: commission.referrerId,
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
        eventType: 'ReferralCommissionReversed',
        aggregateType: 'Referral',
        aggregateId: commission.referralId,
        payload: {
          referrerId: commission.referrerId,
          refereeId: commission.refereeId,
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
    return systemJobActor('referral', this.deps.ids.uuid() as CorrelationId);
  }
}
