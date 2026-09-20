import {
  EXPIRY_REMINDER_KINDS,
  SERVICE_REMINDER_NOTIFICATION_KINDS,
  SERVICE_REMINDER_SWEEP_LIMIT,
  expiryReminderDue,
  usageRemindersReached,
  type Clock,
  type FeatureFlagKey,
  type IdGenerator,
  type ScopeContext,
  type ServiceReminderKind,
  type ServiceReminderThresholds,
  type SettingKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { CustomerNotifier } from '../../messaging/application/customer-notifier.js';
import type {
  ServiceReminderCandidate,
  ServiceReminderRepository,
  ServiceReminderSnapshot,
} from './service-reminder.ports.js';

/**
 * The two readers this lane needs, narrowed to the one method each.
 *
 * Declared here rather than imported from `control`, so the sweep cannot WRITE a
 * setting or a flag from a background loop. The container binds them to
 * `SettingsResolver` and `FeatureFlagsService`, which is where the permission checks,
 * the audit and the validation live.
 */
export interface ReminderSettingsReader {
  valueOf<T>(scope: ScopeContext, key: SettingKey, tx?: unknown): Promise<T>;
}
export interface ReminderFeatureReader {
  isEnabled(scope: ScopeContext, key: FeatureFlagKey, tx?: unknown): Promise<boolean>;
}

const DAY_MS = 86_400_000;

/** What one pass did, for the loop's log and for a test. */
export interface ServiceReminderReport {
  readonly expiry: number;
  readonly usage: number;
}

export interface ServiceReminderServiceDeps {
  readonly reminders: ServiceReminderRepository;
  readonly settings: ReminderSettingsReader;
  readonly features: ReminderFeatureReader;
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
      const thresholds = await this.thresholds(scope, tx);
      const expiry = await this.sweepExpiry(scope, now, thresholds, tx);
      const usage = await this.sweepUsage(scope, now, thresholds, tx);
      return { expiry, usage };
    });
  }

  /**
   * The tenant's own thresholds, read fresh on every pass.
   *
   * Never cached across passes, and that is what `RUNTIME` mutability means: an
   * operator who changes three days to five must not have to wait for a deploy, and a
   * cache here would be a second copy of a value the registry already owns.
   *
   * The flags come from the SAME transaction as the settings and as the writes below,
   * for the reason every read in this codebase shares its transaction with the write it
   * informs: a flag turned off while a pass was mid-flight would otherwise send the
   * messages it was turned off to stop.
   */
  private async thresholds(
    scope: TenantContext,
    tx: TransactionScope,
  ): Promise<ServiceReminderThresholds> {
    const [
      expiryEnabled,
      expiredNoticeEnabled,
      usageEnabled,
      expiryFirstDays,
      expirySecondDays,
      usageFirstPercent,
      usageSecondPercent,
      usageFinalPercent,
    ] = await Promise.all([
      this.deps.features.isEnabled(scope, 'service_expiry_reminders', tx),
      this.deps.features.isEnabled(scope, 'service_expired_notice', tx),
      this.deps.features.isEnabled(scope, 'service_usage_reminders', tx),
      this.deps.settings.valueOf<number>(scope, 'reminders.expiry_first_days', tx),
      this.deps.settings.valueOf<number>(scope, 'reminders.expiry_second_days', tx),
      this.deps.settings.valueOf<number>(scope, 'reminders.usage_first_percent', tx),
      this.deps.settings.valueOf<number>(scope, 'reminders.usage_second_percent', tx),
      this.deps.settings.valueOf<number>(scope, 'reminders.usage_final_percent', tx),
    ]);
    return {
      expiryEnabled,
      expiredNoticeEnabled,
      usageEnabled,
      expiryFirstDays,
      expirySecondDays,
      usageFirstPercent,
      usageSecondPercent,
      usageFinalPercent,
    };
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
    thresholds: ServiceReminderThresholds,
    tx: TransactionScope,
  ): Promise<number> {
    /* Both switches off: no query, no candidates, nothing to be made stale. */
    if (!thresholds.expiryEnabled && !thresholds.expiredNoticeEnabled) return 0;
    /*
     * The window NARROWS when advance warnings are off.
     *
     * With `service_expiry_reminders` off and only the expired notice on, a service
     * three days out is not a candidate for anything, and asking for it would hand the
     * pass two hundred rows it must then skip — every fifteen minutes, in front of the
     * services that do need something. `now` is the whole window in that case.
     */
    const firstDays = thresholds.expiryEnabled ? thresholds.expiryFirstDays : 0;
    const candidates = await this.deps.reminders.listExpiryCandidates(
      scope,
      {
        now,
        secondAt: new Date(now.getTime() + thresholds.expirySecondDays * DAY_MS),
        firstAt: new Date(now.getTime() + firstDays * DAY_MS),
      },
      SERVICE_REMINDER_SWEEP_LIMIT,
      tx,
    );

    let sent = 0;
    for (const candidate of candidates) {
      const due = expiryReminderDue(candidate.expiresAt, now, thresholds);
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
      /*
       * A kind whose switch is off is RECORDED and not sent, rather than skipped.
       *
       * Skipping would leave the service a candidate for ever: it would come back on
       * every pass, occupy a slot in a bounded sweep, and starve the services behind it.
       * Recording also settles what happens on a later re-enable, and settles it the
       * way an operator would want: turning the expired notice back on does not
       * suddenly post "your service expired" to everyone whose service lapsed while it
       * was off.
       */
      const announce =
        due === 'EXPIRED' ? thresholds.expiredNoticeEnabled : thresholds.expiryEnabled;
      if (await this.raise(scope, candidate, upTo, announce ? due : null, now, tx)) sent += 1;
    }
    return sent;
  }

  /** The three that are about the allowance. Same shape, same reasoning. */
  private async sweepUsage(
    scope: TenantContext,
    now: Date,
    thresholds: ServiceReminderThresholds,
    tx: TransactionScope,
  ): Promise<number> {
    /* Off means no query at all, for the reason the expiry half gives. */
    if (!thresholds.usageEnabled) return 0;
    const candidates = await this.deps.reminders.listUsageCandidates(
      scope,
      {
        lowest: thresholds.usageFirstPercent,
        high: thresholds.usageSecondPercent,
        full: thresholds.usageFinalPercent,
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
        thresholds,
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
    /** The one kind to announce, or `null` when its switch is off and it is only recorded. */
    announce: ServiceReminderKind | null,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const snapshot = this.snapshot(candidate, now);
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
          snapshot,
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

  /**
   * What the message will say, frozen now.
   *
   * `remainingDays` rounds UP, so a service with eleven hours left is "one day" rather
   * than "zero days" — a sentence that says zero days and is not the expired notice is
   * a sentence a customer cannot act on. Past the deadline it is zero, and the expired
   * template does not render it.
   *
   * `usedBytes` is the figure that was on the row, which the usage query only accepts
   * from a service whose panel has actually answered. Nothing here substitutes a zero
   * for a figure nobody has read.
   */
  private snapshot(candidate: ServiceReminderCandidate, now: Date): ServiceReminderSnapshot {
    const msLeft =
      candidate.expiresAt === null ? null : candidate.expiresAt.getTime() - now.getTime();
    return {
      serviceLabel: candidate.providerUsername,
      remainingDays: msLeft === null ? null : Math.max(0, Math.ceil(msLeft / DAY_MS)),
      usedBytes: candidate.trafficUsedBytes,
    };
  }
}
