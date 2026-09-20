import {
  EXPIRY_REMINDER_DAYS,
  EXPIRY_REMINDER_KINDS,
  SERVICE_REMINDER_NOTIFICATION_KINDS,
  SERVICE_REMINDER_SWEEP_LIMIT,
  USAGE_REMINDER_PERCENT,
  expiryReminderDue,
  usageRemindersReached,
  type Clock,
  type IdGenerator,
  type ServiceReminderKind,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { CustomerNotifier } from '../../messaging/application/customer-notifier.js';
import type {
  ServiceReminderCandidate,
  ServiceReminderRepository,
} from './service-reminder.ports.js';

const DAY_MS = 86_400_000;

/** What one pass did, for the loop's log and for a test. */
export interface ServiceReminderReport {
  readonly expiry: number;
  readonly usage: number;
}

export interface ServiceReminderServiceDeps {
  readonly reminders: ServiceReminderRepository;
  readonly notifier: CustomerNotifier;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * The lane that tells a customer their service is running out — of days, or of traffic.
 *
 * ## Why it dials nothing
 *
 * Both halves read columns this installation already maintains. `expires_at` is written
 * by the create and by every commercial action; `traffic_used_bytes` is written by
 * `SYNC_USAGE`, which is the operation that already talks to panels on a cadence. A
 * reminder sweep that asked a panel would be a second usage-read lane with its own
 * budget, its own failure modes and its own opinion of the figure — and the figure it
 * disagreed with would be the one the customer is shown on their service page.
 *
 * So this runs in the WORKER, beside the payment expiry sweep, for the reason that
 * sweep gives: nothing here needs a panel, and a wedged panel must not delay work that
 * does not.
 *
 * ## One reminder per pass per service, most urgent first
 *
 * A service that crossed two thresholds since the last pass is told about the more
 * urgent one and the other is RECORDED as raised without being sent. Two messages an
 * hour apart, the second less alarming than the first, is a lane contradicting itself;
 * recording the skipped kind is what stops it firing afterwards and doing exactly that.
 *
 * ## What is NOT here
 *
 * **No audit row.** `docs/conventions.md` keeps audit for a mutation with a before and
 * an after of a domain entity, and raising a reminder changes no entity. The durable
 * record is the pair this transaction writes: the `service_reminders` row says what was
 * decided and against which period, and the `customer_notifications` row carries the
 * delivery through to a recorded outcome. An audit entry would be a third copy of a
 * fact two tables already hold.
 *
 * **No operational event.** A service reaching the end of what somebody bought is the
 * product working, not a condition an operator must act on. That is the distinction
 * that keeps the operations log from becoming `/admin/logs`.
 *
 * **No settings.** The three days and the three percentages are constants, for the
 * reason `EXPIRY_REMINDER_DAYS` records: a threshold an operator can move is a
 * threshold whose already-raised rows were decided under a rule that no longer exists,
 * and `service_reminders` has no column saying which rule produced a row.
 */
export class ServiceReminderService {
  constructor(private readonly deps: ServiceReminderServiceDeps) {}

  /**
   * One pass.
   *
   * ONE transaction for both halves, and every write in it: the reminder row and the
   * notification that names it commit together or not at all. A reminder row without
   * its notification is a customer who will never be told and a lane that believes it
   * already has; a notification without its row is a message with a subject that does
   * not exist.
   *
   * The scope-activity check is inside the transaction and before either half, for the
   * reason `CLAUDE.md` gives: a surface checks on arrival and a stop can commit in
   * between. A stopped tenant is a pass that did nothing, NOT a failed one — the same
   * answer `PaymentExpiryService` gives, and for the same reason, which is that
   * `LoopProgress` records no progress for a pass that threw and an operator who
   * stopped a tenant would otherwise make the worker report itself unhealthy.
   */
  async runOnce(scope: TenantContext): Promise<ServiceReminderReport> {
    const now = this.deps.clock.now();

    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
        return { expiry: 0, usage: 0 };
      }
      const expiry = await this.sweepExpiry(scope, now, tx);
      const usage = await this.sweepUsage(scope, now, tx);
      return { expiry, usage };
    });
  }

  /**
   * The three that are about the clock.
   *
   * The boundaries handed to the repository are derived HERE from
   * `EXPIRY_REMINDER_DAYS`, so the numbers live in the contract and the query has only
   * timestamps. Each row that comes back is then re-decided by `expiryReminderDue`: the
   * query is a filter that makes the pass finite, and the function is the authority.
   * They agree today, and the day somebody changes one of them the disagreement is a
   * skipped reminder rather than a wrong one.
   */
  private async sweepExpiry(
    scope: TenantContext,
    now: Date,
    tx: TransactionScope,
  ): Promise<number> {
    const candidates = await this.deps.reminders.listExpiryCandidates(
      scope,
      {
        now,
        oneDayAt: new Date(now.getTime() + EXPIRY_REMINDER_DAYS.EXPIRING_1D * DAY_MS),
        threeDaysAt: new Date(now.getTime() + EXPIRY_REMINDER_DAYS.EXPIRING_3D * DAY_MS),
      },
      SERVICE_REMINDER_SWEEP_LIMIT,
      tx,
    );

    let sent = 0;
    for (const candidate of candidates) {
      const due = expiryReminderDue(candidate.expiresAt, now);
      if (due === null) continue;
      /*
       * Everything from the least urgent up to and including the due kind.
       *
       * `EXPIRY_REMINDER_KINDS` is declared least-urgent-first, so the slice up to the
       * due kind is exactly the set that is no longer in the future. Writing the whole
       * prefix is what stops a lane that was down for two days sending "three days
       * left" after "expires tomorrow".
       */
      const upTo = EXPIRY_REMINDER_KINDS.slice(0, EXPIRY_REMINDER_KINDS.indexOf(due) + 1);
      if (await this.raise(scope, candidate, upTo, due, now, tx)) sent += 1;
    }
    return sent;
  }

  /** The three that are about the allowance. Same shape, same reasoning. */
  private async sweepUsage(scope: TenantContext, now: Date, tx: TransactionScope): Promise<number> {
    const candidates = await this.deps.reminders.listUsageCandidates(
      scope,
      {
        lowest: USAGE_REMINDER_PERCENT.USAGE_80,
        high: USAGE_REMINDER_PERCENT.USAGE_95,
        full: USAGE_REMINDER_PERCENT.USAGE_100,
      },
      SERVICE_REMINDER_SWEEP_LIMIT,
      tx,
    );

    let sent = 0;
    for (const candidate of candidates) {
      /* Highest first, so `[0]` is the one the customer hears about. */
      const reached = usageRemindersReached(
        candidate.trafficUsedBytes,
        candidate.trafficLimitBytes,
      );
      const due = reached[0];
      if (due === undefined) continue;
      if (await this.raise(scope, candidate, reached, due, now, tx)) sent += 1;
    }
    return sent;
  }

  /**
   * Writes every kind in `kinds` and enqueues a notification for `announce` alone.
   *
   * Returns whether the customer was told. `false` covers both losers: another replica
   * wrote the `announce` row first, or the customer has no durable bot link and there
   * is nobody to send to — and neither is an error, so neither aborts the pass.
   *
   * The reminder row is written BEFORE the notification and the notification names its
   * id. That order is not cosmetic: the id must exist before it can be a subject, and
   * the pair must be in one transaction so that neither can exist alone.
   */
  private async raise(
    scope: TenantContext,
    candidate: ServiceReminderCandidate,
    kinds: readonly ServiceReminderKind[],
    announce: ServiceReminderKind,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    let told = false;
    for (const kind of kinds) {
      const id = this.deps.ids.uuid();
      const written = await this.deps.reminders.raise(
        scope,
        {
          id,
          serviceId: candidate.serviceId,
          kind,
          basis: candidate.basis,
        },
        now,
        tx,
      );
      if (!written || kind !== announce) continue;
      told = await this.deps.notifier.notify(
        scope,
        candidate.customerId,
        SERVICE_REMINDER_NOTIFICATION_KINDS[kind],
        id,
        now,
        tx,
      );
    }
    return told;
  }
}
