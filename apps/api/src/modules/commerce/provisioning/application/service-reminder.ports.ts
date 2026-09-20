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
  readonly trafficLimitBytes: bigint;
  readonly trafficUsedBytes: bigint;
  readonly basis: ServiceReminderBasis;
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
      /** Its first. Also the window: nothing further out than this is a candidate. */
      readonly firstAt: Date;
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
      })
    | null
  >;
}
