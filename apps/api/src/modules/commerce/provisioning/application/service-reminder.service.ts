import {
  COMMERCE_ERROR_CODES,
  errors,
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

/**
 * What a burst seed decided (`seedPassedThresholds`).
 *
 * `passed` — every kind already behind the service against its current basis, least
 * urgent first within each family. `seeded` — the subset THIS call wrote; a rerun writes
 * nothing and returns `[]` here with the same `passed`.
 */
export interface ServiceReminderSeed {
  readonly passed: readonly ServiceReminderKind[];
  readonly seeded: readonly ServiceReminderKind[];
}

/**
 * The thresholds already behind a service NOW — the one decision the burst seed makes,
 * pure so a unit test can pin every branch.
 *
 * Built from the sweep's own two functions and its own prefix rule, so "passed" here and
 * "due" there cannot disagree: the expiry kinds are `EXPIRY_REMINDER_KINDS` up to and
 * including `expiryReminderDue`; the usage kinds are `usageRemindersReached`, and only
 * for a measured figure.
 */
export function passedReminderKinds(
  candidate: Pick<
    ServiceReminderCandidate,
    'expiresAt' | 'expiryDayStartsAt' | 'trafficLimitBytes' | 'trafficUsedBytes'
  > & { readonly usageMeasured: boolean },
  now: Date,
  thresholds: ServiceReminderThresholds,
): {
  readonly expiry: readonly ServiceReminderKind[];
  readonly usage: readonly ServiceReminderKind[];
} {
  const due = expiryReminderDue(candidate.expiresAt, now, thresholds, candidate.expiryDayStartsAt);
  const expiry =
    due === null ? [] : EXPIRY_REMINDER_KINDS.slice(0, EXPIRY_REMINDER_KINDS.indexOf(due) + 1);
  const usage = candidate.usageMeasured
    ? [
        ...usageRemindersReached(
          candidate.trafficUsedBytes,
          candidate.trafficLimitBytes,
          thresholds,
        ),
      ].reverse()
    : [];
  return { expiry, usage };
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
 * **Thresholds are the tenant's settings** (the owner's correction to Phase 6C), read
 * per pass. A row is keyed on the PERIOD, not on the number that produced it, so moving a
 * threshold never re-sends a reminder already raised for the period.
 *
 * ## WP-A9
 *
 * Five expiry slots (7, 3 and 1 days before, the day itself, and after), three usage
 * slots at 20%, 10% and 5% remaining by default. "The day itself" is the expiry's
 * calendar day in the TENANT'S display timezone, derived by the candidate query from
 * `tenants.display_timezone` and handed to `expiryReminderDue` with the row, so the
 * filter and the decision use one boundary. And every reminder is re-checked at SEND
 * time by the notification lane's subject reader: a renewal, a traffic top-up or a
 * termination between the raise and the send supersedes the message.
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
   * Migration P6, Item 8 — burst protection for a service that arrives mid-period.
   *
   * An adopted legacy service is born already near its expiry, past several usage
   * thresholds, or expired. To the sweep it would look like a service whose thresholds
   * were all crossed since its last pass, and every adopted service would be told
   * something on the first pass after the import — thousands of "your service expired"
   * and "95% used" messages about periods the legacy bot already handled. This records
   * every threshold that is ALREADY behind the service as raised, against its CURRENT
   * basis, with no notification — exactly what the sweep does for the kinds below the one
   * it announces, so it is the existing lane's own record, not a second reminder system.
   *
   * - Expiry: the whole prefix of `EXPIRY_REMINDER_KINDS` up to the kind
   *   `expiryReminderDue` returns now (the sweep's `upTo`).
   * - Usage: every kind `usageRemindersReached` returns, when the figure was measured
   *   (`usage_synced_at`), as the usage query requires.
   *
   * Thresholds are the tenant's settings, read in THIS transaction. Flags are NOT
   * consulted: a family switched off today and on tomorrow must not then announce a
   * crossing that happened before the service was adopted — the reason the sweep records
   * a switched-off expiry kind instead of skipping it.
   *
   * What still fires: every threshold not yet behind the service, against this basis, and
   * everything in a new period (a renewal or added traffic moves the basis, and the rows
   * written here no longer match it).
   *
   * Runs inside the CALLER's transaction (the adoption's), which has already read scope
   * activity; it reads it again, because a step that writes must not rely on its caller
   * having remembered. Idempotent: every write is the sweep's own `ON CONFLICT DO NOTHING`
   * on the period key, so a rerun, or two adoptions racing, write each row once.
   * `seeded` lists the kinds THIS call wrote.
   */
  async seedPassedThresholds(
    scope: TenantContext,
    serviceId: string,
    tx: TransactionScope,
  ): Promise<ServiceReminderSeed> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
    }
    const candidate = await this.deps.reminders.seedCandidate(scope, serviceId, tx);
    if (candidate === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
    }
    const now = this.deps.clock.now();
    const thresholds = await this.thresholds(scope, tx);
    const passed = passedReminderKinds(candidate, now, thresholds);
    const snapshot = this.snapshot(candidate, now);
    const seeded: ServiceReminderKind[] = [];
    for (const kind of [...passed.expiry, ...passed.usage]) {
      const written = await this.deps.reminders.raise(
        scope,
        {
          id: this.deps.ids.uuid(),
          serviceId: candidate.serviceId,
          kind,
          basis: candidate.basis,
          snapshot,
        },
        now,
        tx,
      );
      if (written) seeded.push(kind);
    }
    return { passed: [...passed.expiry, ...passed.usage], seeded };
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
    // One after another, never `Promise.all`: every read shares ONE transaction's client,
    // and concurrent queries on one pg client are queued in an order nobody chose
    // (deprecated in pg 8, an error in pg 9). The flags first, then the settings.
    const { features, settings } = this.deps;
    const expiryEnabled = await features.isEnabled(scope, 'service_expiry_reminders', tx);
    const expiredNoticeEnabled = await features.isEnabled(scope, 'service_expired_notice', tx);
    const expiryDayEnabled = await features.isEnabled(scope, 'service_expiry_day_reminder', tx);
    const usageEnabled = await features.isEnabled(scope, 'service_usage_reminders', tx);
    const expiryEarlyDays = await settings.valueOf<number>(
      scope,
      'reminders.expiry_early_days',
      tx,
    );
    const expiryFirstDays = await settings.valueOf<number>(
      scope,
      'reminders.expiry_first_days',
      tx,
    );
    const expirySecondDays = await settings.valueOf<number>(
      scope,
      'reminders.expiry_second_days',
      tx,
    );
    const usageFirstPercent = await settings.valueOf<number>(
      scope,
      'reminders.usage_first_percent',
      tx,
    );
    const usageSecondPercent = await settings.valueOf<number>(
      scope,
      'reminders.usage_second_percent',
      tx,
    );
    const usageFinalPercent = await settings.valueOf<number>(
      scope,
      'reminders.usage_final_percent',
      tx,
    );
    return {
      expiryEnabled,
      expiredNoticeEnabled,
      expiryDayEnabled,
      usageEnabled,
      expiryEarlyDays,
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
    /* Every switch off: no query, no candidates, nothing to be made stale. */
    if (
      !thresholds.expiryEnabled &&
      !thresholds.expiredNoticeEnabled &&
      !thresholds.expiryDayEnabled
    ) {
      return 0;
    }
    /*
     * The window NARROWS when advance warnings are off.
     *
     * With `service_expiry_reminders` off and only the expired notice on, a service
     * three days out is not a candidate for anything, and asking for it would hand the
     * pass two hundred rows it must then skip — every fifteen minutes, in front of the
     * services that do need something. `now` is the whole window in that case.
     *
     * WP-A9: the window is the furthest ENABLED moment. With advance warnings on it is the
     * week-out slot when that one is live (non-zero and further out than FIRST), else
     * FIRST. With them off but "expires today" on, it is the second threshold — at least a
     * day, which contains every expiry whose calendar day has begun.
     */
    const earlyLive =
      thresholds.expiryEarlyDays > 0 && thresholds.expiryEarlyDays > thresholds.expiryFirstDays;
    const windowDays = thresholds.expiryEnabled
      ? earlyLive
        ? thresholds.expiryEarlyDays
        : thresholds.expiryFirstDays
      : thresholds.expiryDayEnabled
        ? thresholds.expirySecondDays
        : 0;
    const candidates = await this.deps.reminders.listExpiryCandidates(
      scope,
      {
        now,
        secondAt: new Date(now.getTime() + thresholds.expirySecondDays * DAY_MS),
        firstAt: new Date(now.getTime() + thresholds.expiryFirstDays * DAY_MS),
        windowAt: new Date(now.getTime() + windowDays * DAY_MS),
      },
      SERVICE_REMINDER_SWEEP_LIMIT,
      tx,
    );

    let sent = 0;
    for (const candidate of candidates) {
      const due = expiryReminderDue(
        candidate.expiresAt,
        now,
        thresholds,
        candidate.expiryDayStartsAt,
      );
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
        due === 'EXPIRED'
          ? thresholds.expiredNoticeEnabled
          : due === 'EXPIRY_DAY'
            ? thresholds.expiryDayEnabled
            : thresholds.expiryEnabled;
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
