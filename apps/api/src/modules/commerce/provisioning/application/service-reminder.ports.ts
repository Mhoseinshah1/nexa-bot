import type { ServiceReminderKind, TenantContext, UserId } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * The period a reminder was raised against, as the DATABASE renders it.
 *
 * `expiresAt` is TEXT and not a `Date`, and that is load-bearing rather than lazy.
 * Postgres stores `timestamptz` to the microsecond; a JavaScript `Date` holds
 * milliseconds. Reading a deadline into a `Date` and writing it back as the basis
 * would store a value a thousandth of a second away from the column it was copied
 * from, `IS NOT DISTINCT FROM` would be false for ever, and the candidate query would
 * hand the same service back on every pass — a customer told they have three days
 * left, every fifteen minutes, until they blocked the bot.
 *
 * So the text crosses the boundary untouched and is cast back on the way in. It is
 * opaque: nothing outside the repository parses it or compares it.
 */
export interface ServiceReminderBasis {
  readonly expiresAt: string | null;
  readonly trafficLimitBytes: bigint;
}

/**
 * A service one reminder pass may have something to say about.
 *
 * The sweep needs the customer to address the message, the deadline and the allowance
 * to decide what is due, the basis to write, and the id to name the row — and nothing
 * else. It has no business with a subscription URL or a provider client id, and a
 * background loop that held them is a background loop that could log them.
 *
 * `expiresAt` is the millisecond-truncated `Date` the THRESHOLD decision uses, which is
 * all a comparison against "three days from now" needs. The exact value lives in
 * `basis` and is never reconstructed from this one.
 */
export interface ServiceReminderCandidate {
  readonly serviceId: string;
  readonly customerId: UserId;
  /** The account name on the panel. What the customer is shown, and all they are shown. */
  readonly providerUsername: string;
  readonly expiresAt: Date | null;
  /**
   * WP-A9: local midnight of the expiry's calendar day in the tenant's display timezone,
   * as the candidate query computed it — the boundary `expiryReminderDue` uses for
   * `EXPIRY_DAY`. Null with no deadline, and in the usage query, which has no use for it.
   */
  readonly expiryDayStartsAt: Date | null;
  readonly trafficLimitBytes: bigint;
  readonly trafficUsedBytes: bigint;
  readonly basis: ServiceReminderBasis;
  /**
   * Round 4 PR-H: what the service already WAS when an import created it, for the period
   * it is in now — or null for a native service, and for an imported one whose period has
   * since moved (a renewal, added traffic). See `service_reminder_baselines` and
   * `importedReminderKinds`. Absent is null.
   */
  readonly importBaseline?: ServiceImportBaseline | null;
  /**
   * Round 5A-2: an imported service (`source <> 'NEXA'`) with NO baseline row. Nothing can say
   * what it already was when the import created it, so the sweep records what it reached and
   * announces none of it (`reconcileImportedBaselines` writes the row; until it has, silence).
   * Absent is false.
   */
  readonly importUnproven?: boolean;
}

/**
 * Round 4 PR-H: an imported service's baseline, as the candidate query resolved it for the
 * service's CURRENT period.
 *
 * `at` is when the import created the service. `usedBytes` is the figure the import read,
 * or null when nothing was measured. The baseline applies only while the period is the
 * imported one — the deadline AND the allowance; the query returns null for the whole
 * baseline otherwise.
 */
export interface ServiceImportBaseline {
  readonly at: Date;
  readonly usedBytes: bigint | null;
}

/**
 * What the customer's message will say, frozen when the reminder is raised.
 *
 * Written to `service_reminders` and read back by the dispatcher at send time, rather
 * than re-read from `services` then. The two moments are minutes apart on a good day
 * and a queue-length apart on a bad one, and a renewal or a usage sync in between would
 * give the customer a sentence whose numbers contradict the threshold that produced it.
 */
export interface ServiceReminderSnapshot {
  readonly serviceLabel: string;
  /** Whole days left, for the expiry kinds. Null for the usage kinds, which show none. */
  readonly remainingDays: number | null;
  readonly usedBytes: bigint;
}

/** One occurrence, as the sweep asks for it to be written. */
export interface ServiceReminderRaise {
  readonly id: string;
  readonly serviceId: string;
  readonly kind: ServiceReminderKind;
  readonly basis: ServiceReminderBasis;
  readonly snapshot: ServiceReminderSnapshot;
}

/**
 * The reminder lane's own storage.
 *
 * Separate from `ServiceRepository` deliberately, and the reason is the reason every
 * narrow port in this module gives: `ServiceRepository` can suspend, terminate and
 * overwrite usage, and a loop whose only job is to say "three days left" has no need
 * of any of it. The two candidate queries read `services`; they cannot write it.
 */
export interface ServiceReminderRepository {
  /**
   * Services inside the widest expiry threshold with the DUE kind not yet raised for
   * their current deadline.
   *
   * The boundaries are parameters, computed by the caller from the TENANT'S OWN
   * settings, so no threshold is written in this file or in the SQL it sends. The query is a COURTESY FILTER in the sense
   * `CLAUDE.md` uses for catalogue eligibility: it exists to make each pass finite and
   * to guarantee forward progress, and the caller re-decides every row with
   * `expiryReminderDue` rather than trusting what came back.
   */
  listExpiryCandidates(
    scope: TenantContext,
    bounds: {
      readonly now: Date;
      /** The tenant's SECOND, more urgent threshold as a moment. */
      readonly secondAt: Date;
      /** Its first. */
      readonly firstAt: Date;
      /**
       * WP-A9: the window. Nothing further out than this is a candidate. The week-out
       * slot's moment when that slot is live, else `firstAt` — or less when advance
       * warnings are off. A row inside the window but past `firstAt` is due `EXPIRY_EARLY`.
       */
      readonly windowAt: Date;
    },
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly ServiceReminderCandidate[]>;

  /**
   * Services past the LOWEST usage threshold with the highest reached kind not yet
   * raised for their current period.
   *
   * Same contract as above: the percentages arrive as parameters resolved from the
   * tenant's settings, and the caller re-decides with `usageRemindersReached`.
   */
  listUsageCandidates(
    scope: TenantContext,
    percent: { readonly lowest: number; readonly high: number; readonly full: number },
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly ServiceReminderCandidate[]>;

  /**
   * Writes one occurrence, and answers whether THIS call is the one that wrote it.
   *
   * `false` is a normal outcome, not an error: two worker replicas is the ordinary case
   * on every rolling update and both will find the same due service. The conditional
   * insert is the decision — the winner goes on to enqueue the notification inside the
   * same transaction, the loser enqueues nothing.
   */
  raise(
    scope: TenantContext,
    row: ServiceReminderRaise,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * One service as the two candidate queries would read it, WHATEVER its state and
   * whatever the thresholds — or null when it is not this tenant's.
   *
   * For the burst seed (Migration P6, `docs/migration-p6-service-adoption.md` §6): an
   * adopted service arrives part-way through its period, and the seed must decide which
   * thresholds are already behind it from the same columns, the same exact basis text and
   * the same tenant-timezone day boundary the sweep will later use — a second
   * computation of any of them is a second answer to "has this one passed".
   *
   * `usageMeasured` is `usage_synced_at IS NOT NULL`: the usage query refuses a service
   * whose figure nobody has read, and the seed follows it.
   */
  seedCandidate(
    scope: TenantContext,
    serviceId: string,
    tx: TransactionScope,
  ): Promise<(ServiceReminderCandidate & { readonly usageMeasured: boolean }) | null>;

  /**
   * Round 4 PR-H: records the service's import baseline — the moment, the basis and the
   * measured figure the seed decided from. Written once: `ON CONFLICT DO NOTHING` on the
   * service, so a rerun of the adoption keeps the FIRST baseline, which is the import's.
   * Answers whether this call wrote it.
   */
  recordBaseline(
    scope: TenantContext,
    baseline: {
      readonly serviceId: string;
      readonly at: Date;
      readonly basis: ServiceReminderBasis;
      readonly usedBytes: bigint | null;
    },
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Round 5A item 1: resolves to `SUPERSEDED` — unsent, no attempt spent, the lane's own
   * `PENDING -> SUPERSEDED` transition and nothing else — up to `limit` queued usage notices
   * on imported services that describe a state the import already held
   * (`importedUnmeasuredUsageNotice`). Rows already claimed for a send are left alone.
   * Returns the notices moved, by kind, so the caller can audit the batch.
   */
  supersedeImportedUsageNotices(
    scope: TenantContext,
    limit: number,
    now: Date,
    tx: TransactionScope,
  ): Promise<readonly { readonly kind: string; readonly customerId: string }[]>;

  /**
   * Round 5A-2 item 1: up to `limit` imported services (`source <> 'NEXA'`) with NO baseline
   * row, in id order after `afterId` (keyset — resumable, never an offset), read exactly as
   * `seedCandidate` reads one, and row-locked `SKIP LOCKED` so two replicas never wait on
   * each other. A row another transaction holds is left for a later pass.
   */
  listUnbaselinedImported(
    scope: TenantContext,
    afterId: string | null,
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly (ServiceReminderCandidate & { readonly usageMeasured: boolean })[]>;

  /**
   * Round 5A-2 item 3: `PENDING -> SUPERSEDED` (unsent, no attempt spent, nothing deleted,
   * claimed rows untouched) for up to `limit` queued service-reminder notices of EVERY
   * reminder kind that `importedServiceNoticeRefused` refuses at send time — the same
   * definition, so a row moved here is one the dispatcher would have refused.
   */
  supersedeImportedServiceNotices(
    scope: TenantContext,
    limit: number,
    now: Date,
    tx: TransactionScope,
  ): Promise<readonly { readonly kind: string; readonly customerId: string }[]>;
}

/**
 * What a queued reminder notification needs to say, read back at send time.
 *
 * A NARROW port for the dispatcher, and narrow in the direction that matters: it can
 * read one reminder occurrence by id and nothing else. The lane that sends customer
 * messages has no business reaching into `services`, and the values it renders are the
 * ones the sweep froze rather than whatever is true now.
 *
 * `null` means the subject is gone. The dispatcher treats that as a message it cannot
 * render rather than as a message with blank figures — a sentence with an empty service
 * name is worse than one not sent.
 */
export interface ServiceReminderSnapshotReader {
  snapshotOf(
    scope: TenantContext,
    reminderId: string,
  ): Promise<
    | (ServiceReminderSnapshot & {
        readonly basisExpiresAt: Date | null;
        readonly basisTrafficLimitBytes: bigint;
        /** R12 F3 item 1: the service the reminder is about, for the button under it. */
        readonly serviceId?: string;
      })
    | null
  >;
}
