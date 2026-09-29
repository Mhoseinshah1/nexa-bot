import {
  PENDING_PAYMENT_REMINDER_MIN_AGE_MINUTES,
  PENDING_PAYMENT_REMINDER_MIN_NOTICE_MINUTES,
  PENDING_PAYMENT_REMINDER_SWEEP_LIMIT,
  pendingReminderDue,
  type Clock,
  type FeatureFlagKey,
  type ScopeContext,
  type SettingKey,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { CustomerNotifier } from '../../messaging/application/customer-notifier.js';

/** One attempt a reminder may be owed for: a payment or an order, by id. */
export interface PendingReminderCandidate {
  readonly id: string;
  readonly customerId: UserId;
  /** When the attempt began: the payment's creation, or the order's confirmation. */
  readonly openedAt: Date;
  readonly expiresAt: Date;
}

/**
 * The lane's two candidate queries. Read-only: this lane changes no payment and no order,
 * it only enqueues a notification about one.
 *
 * Both are COURTESY FILTERS in the sense `ServiceReminderRepository` uses: they make a pass
 * finite and skip what has already been told (a notification row naming the attempt
 * exists), and the service re-decides every row with `pendingReminderDue`.
 */
export interface PendingPaymentReminderRepository {
  /**
   * PENDING manual transfers inside the lead, opened long enough ago, that the customer has
   * not acted on — no receipt, no "I have paid" — and that no reminder names yet.
   */
  listPaymentCandidates(
    scope: TenantContext,
    bounds: {
      readonly now: Date;
      /** The latest deadline still worth a reminder: `PENDING_PAYMENT_REMINDER_MIN_NOTICE_MINUTES` out. */
      readonly noticeAt: Date;
      readonly leadAt: Date;
      readonly openedBefore: Date;
    },
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly PendingReminderCandidate[]>;
  /**
   * Orders AWAITING_PAYMENT inside the lead, with a price, confirmed long enough ago, with no
   * payment under way, confirmed or unresolved, and that no reminder names yet.
   */
  listOrderCandidates(
    scope: TenantContext,
    bounds: {
      readonly now: Date;
      /** The latest deadline still worth a reminder: `PENDING_PAYMENT_REMINDER_MIN_NOTICE_MINUTES` out. */
      readonly noticeAt: Date;
      readonly leadAt: Date;
      readonly openedBefore: Date;
    },
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly PendingReminderCandidate[]>;
}

export interface PendingPaymentReminderDeps {
  readonly reminders: PendingPaymentReminderRepository;
  /** Readers only, for the reason `ReminderSettingsReader` gives: a loop that cannot write. */
  readonly settings: {
    valueOf<T>(scope: ScopeContext, key: SettingKey, tx?: unknown): Promise<T>;
  };
  readonly features: {
    isEnabled(scope: ScopeContext, key: FeatureFlagKey, tx?: unknown): Promise<boolean>;
  };
  readonly notifier: CustomerNotifier;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
}

/** What one pass enqueued. */
export interface PendingPaymentReminderReport {
  readonly payments: number;
  readonly orders: number;
}

/**
 * WP-A9: "your invoice closes in ten minutes" — once, and only while it can still be paid.
 *
 * ## Bounded, by construction
 *
 * The subject is the payment or the order itself, so `customer_notifications_subject_key`
 * allows ONE `PAYMENT_PENDING_REMINDER` per payment and one `ORDER_PENDING_REMINDER` per
 * order for ever: a restart, a retry, a second replica and a redelivered pass all land on
 * the same key. And the candidate queries skip an attempt a reminder already names, so a
 * pass with nothing new to say writes nothing — there is no row per scan.
 *
 * ## Which attempts
 *
 * A MANUAL TRANSFER only. It is the flow where the customer holds instructions and has not
 * yet acted; a wallet payment settles in the transaction that creates it. A GATEWAY
 * attempt is deliberately excluded: its payment may already have been taken on the
 * provider's side and be waiting on the inquiry that alone decides (`CLAUDE.md`, TonPays),
 * and "please pay before the deadline" to a customer who has paid is an invitation to pay
 * twice. An order is reminded only while no payment for it is PENDING, CONFIRMED or UNKNOWN.
 *
 * Never an attempt the customer has already acted on (a receipt, or the "I have paid"
 * signal), never one that is settled, cancelled or expired, never one opened less than
 * `PENDING_PAYMENT_REMINDER_MIN_AGE_MINUTES` ago, and never one with less than
 * `PENDING_PAYMENT_REMINDER_MIN_NOTICE_MINUTES` left — a reminder the delivery lane could
 * not send before the deadline supersedes it. All of it is re-checked at SEND time by
 * the notification lane's subject reader, which supersedes a reminder that stopped holding.
 *
 * ## What is NOT here
 *
 * No audit row and no operational event, for the reasons `ServiceReminderService` gives:
 * nothing about a payment changes, and a reminder is the product working.
 */
export class PendingPaymentReminderService {
  constructor(private readonly deps: PendingPaymentReminderDeps) {}

  async runOnce(scope: TenantContext): Promise<PendingPaymentReminderReport> {
    const now = this.deps.clock.now();
    return this.deps.uow.run(scope, async (tx) => {
      // A stopped tenant is a pass that did nothing, never a throw — see `ServiceReminderService`.
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
        return { payments: 0, orders: 0 };
      }
      if (!(await this.deps.features.isEnabled(scope, 'payment_pending_reminders', tx))) {
        return { payments: 0, orders: 0 };
      }
      const lead = await this.deps.settings.valueOf<number>(
        scope,
        'reminders.payment_pending_minutes',
        tx,
      );
      const bounds = {
        now,
        noticeAt: new Date(now.getTime() + PENDING_PAYMENT_REMINDER_MIN_NOTICE_MINUTES * 60_000),
        leadAt: new Date(now.getTime() + lead * 60_000),
        openedBefore: new Date(now.getTime() - PENDING_PAYMENT_REMINDER_MIN_AGE_MINUTES * 60_000),
      };

      const payments = await this.remind(
        scope,
        await this.deps.reminders.listPaymentCandidates(
          scope,
          bounds,
          PENDING_PAYMENT_REMINDER_SWEEP_LIMIT,
          tx,
        ),
        'PAYMENT_PENDING_REMINDER',
        now,
        lead,
        tx,
      );
      const orders = await this.remind(
        scope,
        await this.deps.reminders.listOrderCandidates(
          scope,
          bounds,
          PENDING_PAYMENT_REMINDER_SWEEP_LIMIT,
          tx,
        ),
        'ORDER_PENDING_REMINDER',
        now,
        lead,
        tx,
      );
      return { payments, orders };
    });
  }

  private async remind(
    scope: TenantContext,
    candidates: readonly PendingReminderCandidate[],
    kind: 'PAYMENT_PENDING_REMINDER' | 'ORDER_PENDING_REMINDER',
    now: Date,
    lead: number,
    tx: TransactionScope,
  ): Promise<number> {
    let told = 0;
    for (const candidate of candidates) {
      // The query is the filter; this is the authority.
      if (!pendingReminderDue(candidate.openedAt, candidate.expiresAt, now, lead)) continue;
      if (
        await this.deps.notifier.notify(scope, candidate.customerId, kind, candidate.id, now, tx)
      ) {
        told += 1;
      }
    }
    return told;
  }
}
