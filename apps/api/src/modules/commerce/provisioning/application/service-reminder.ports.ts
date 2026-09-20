import type { ServiceReminderKind, TenantContext, UserId } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * A service one reminder pass may have something to say about.
 *
 * Five fields and no more. The sweep needs the customer to address the message, the
 * deadline and the allowance to decide what is due, and the id to name the row — it
 * has no business with a subscription URL or a provider client id, and a background
 * loop that held them is a background loop that could log them.
 */
export interface ServiceReminderCandidate {
  readonly serviceId: string;
  readonly customerId: UserId;
  readonly expiresAt: Date | null;
  readonly trafficLimitBytes: bigint;
  readonly trafficUsedBytes: bigint;
}

/** One occurrence, as the sweep asks for it to be written. */
export interface ServiceReminderRaise {
  readonly id: string;
  readonly serviceId: string;
  readonly kind: ServiceReminderKind;
  readonly basisExpiresAt: Date | null;
  readonly basisTrafficLimitBytes: bigint;
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
   * The boundaries are parameters, computed by the caller from `EXPIRY_REMINDER_DAYS`,
   * so the thresholds have one home. The query is a COURTESY FILTER in the sense
   * `CLAUDE.md` uses for catalogue eligibility: it exists to make each pass finite and
   * to guarantee forward progress, and the caller re-decides every row with
   * `expiryReminderDue` rather than trusting what came back.
   */
  listExpiryCandidates(
    scope: TenantContext,
    bounds: {
      readonly now: Date;
      readonly oneDayAt: Date;
      readonly threeDaysAt: Date;
    },
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly ServiceReminderCandidate[]>;

  /**
   * Services past the LOWEST usage threshold with the highest reached kind not yet
   * raised for their current period.
   *
   * Same contract as above: the percentages arrive as parameters from
   * `USAGE_REMINDER_PERCENT` and the caller re-decides with `usageRemindersReached`.
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
