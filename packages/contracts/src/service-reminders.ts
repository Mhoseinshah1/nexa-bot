import { z } from 'zod';
import type { CustomerNotificationKind } from './customer-notifications.js';

/**
 * The six moments a customer is told something about a service they already own.
 *
 * A reminder is unlike everything else the customer notification lane carries, and the
 * difference decides the whole design. Every other kind is a fact that happens ONCE per
 * subject for ever — an order is rejected once, a refund credited once — so
 * `customer_notifications_subject_key`, unique on `(tenant, kind, subject)`, is exactly
 * the right guarantee.
 *
 * A reminder is once per PERIOD. A service renewed twice crosses "three days left"
 * three times, and keying on the service would deliver the first and silently swallow
 * the other two. So a reminder occurrence is a ROW — `service_reminders` — and that row
 * is what the notification names.
 */
export const SERVICE_REMINDER_KINDS = [
  'EXPIRING_3D',
  'EXPIRING_1D',
  'EXPIRED',
  'USAGE_80',
  'USAGE_95',
  'USAGE_100',
] as const;
export type ServiceReminderKind = (typeof SERVICE_REMINDER_KINDS)[number];
export const serviceReminderKindSchema = z.enum(SERVICE_REMINDER_KINDS);

/** The three that are about the clock. */
export const EXPIRY_REMINDER_KINDS = ['EXPIRING_3D', 'EXPIRING_1D', 'EXPIRED'] as const;
/** The three that are about the traffic allowance. */
export const USAGE_REMINDER_KINDS = ['USAGE_80', 'USAGE_95', 'USAGE_100'] as const;

/**
 * How long before the deadline each expiry reminder fires, in whole days.
 *
 * `EXPIRED` is zero — it fires once the deadline has passed, not before it. The owner
 * named these three; they are constants rather than settings because a threshold an
 * operator can move is a threshold whose stored reminders were raised against a rule
 * that no longer exists, and `service_reminders` has no column for which rule produced
 * a row.
 */
export const EXPIRY_REMINDER_DAYS: Readonly<
  Record<(typeof EXPIRY_REMINDER_KINDS)[number], number>
> = {
  EXPIRING_3D: 3,
  EXPIRING_1D: 1,
  EXPIRED: 0,
};

/**
 * The fraction of the allowance each usage reminder fires at, in PERCENT.
 *
 * Integers rather than floats, and compared by integer arithmetic —
 * `used * 100 >= limit * threshold` — because `usedBytes / limitBytes` on `bigint`
 * values large enough to matter is exactly the float this codebase refuses for money
 * and refuses here for the same reason: the comparison has to be exact at the boundary,
 * and 0.7999999999999999 is a customer not told.
 */
export const USAGE_REMINDER_PERCENT: Readonly<
  Record<(typeof USAGE_REMINDER_KINDS)[number], number>
> = {
  USAGE_80: 80,
  USAGE_95: 95,
  USAGE_100: 100,
};

/**
 * Has this service used at least `percent` of its allowance?
 *
 * Integer arithmetic on `bigint`, for the reason above. An UNLIMITED allowance — the
 * sentinel zero `catalog.ts` chose — has no percentage, so it is never reached: an
 * unlimited service cannot be 80% of the way through an allowance it does not have,
 * and dividing by it would be a crash rather than a reminder.
 */
export function usageReached(usedBytes: bigint, limitBytes: bigint, percent: number): boolean {
  if (limitBytes <= 0n) return false;
  return usedBytes * 100n >= limitBytes * BigInt(percent);
}

/**
 * The reminder kinds this service's usage has reached, highest first.
 *
 * HIGHEST FIRST and one per pass is the rule the caller follows: a service that jumps
 * from 70% to 100% between two syncs should be told it has run out, not told it is at
 * 80% and then, an hour later, at 95%. The lower thresholds are still recorded as
 * raised so they never fire retroactively for the same period.
 */
export function usageRemindersReached(
  usedBytes: bigint,
  limitBytes: bigint,
): readonly (typeof USAGE_REMINDER_KINDS)[number][] {
  return [...USAGE_REMINDER_KINDS]
    .sort((a, b) => USAGE_REMINDER_PERCENT[b] - USAGE_REMINDER_PERCENT[a])
    .filter((kind) => usageReached(usedBytes, limitBytes, USAGE_REMINDER_PERCENT[kind]));
}

/**
 * The expiry reminder due for a service whose deadline is `expiresAt`, or null.
 *
 * The MOST URGENT one only, for the reason `usageRemindersReached` orders by size: a
 * service whose reminder lane was down for two days should be told it expires tomorrow,
 * not told it expires in three days. The one it skipped is recorded as raised so it
 * cannot fire afterwards and contradict the one that was sent.
 *
 * A service with no deadline — unlimited validity — is never due. `expiresAt` is
 * nullable exactly for that case, and a null is not "expired long ago".
 */
export function expiryReminderDue(
  expiresAt: Date | null,
  now: Date,
): (typeof EXPIRY_REMINDER_KINDS)[number] | null {
  if (expiresAt === null) return null;
  const msLeft = expiresAt.getTime() - now.getTime();
  if (msLeft <= 0) return 'EXPIRED';
  const daysLeft = msLeft / 86_400_000;
  if (daysLeft <= EXPIRY_REMINDER_DAYS.EXPIRING_1D) return 'EXPIRING_1D';
  if (daysLeft <= EXPIRY_REMINDER_DAYS.EXPIRING_3D) return 'EXPIRING_3D';
  return null;
}

/**
 * How many services one reminder pass examines.
 *
 * The same bound `PAYMENT_EXPIRY_SWEEP_LIMIT` is, and for the same reason: a tenant
 * whose services all lapse on one midnight must not turn a single tick into ten
 * thousand rows in one transaction. Candidates are ordered by deadline, so the next
 * pass continues where this one stopped.
 */
export const SERVICE_REMINDER_SWEEP_LIMIT = 200;

/**
 * Which notification kind each reminder kind produces.
 *
 * An explicit map rather than `` `SERVICE_${kind}` ``, even though every pair happens
 * to line up today. The two vocabularies belong to different layers — one names a row
 * in `service_reminders`, the other a member of a closed set pinned by a CHECK
 * constraint — and a derived name would make renaming either one silently produce a
 * kind the database refuses, at runtime, in a background loop.
 */
export const SERVICE_REMINDER_NOTIFICATION_KINDS: Readonly<
  Record<ServiceReminderKind, CustomerNotificationKind>
> = {
  EXPIRING_3D: 'SERVICE_EXPIRING_3D',
  EXPIRING_1D: 'SERVICE_EXPIRING_1D',
  EXPIRED: 'SERVICE_EXPIRED',
  USAGE_80: 'SERVICE_USAGE_80',
  USAGE_95: 'SERVICE_USAGE_95',
  USAGE_100: 'SERVICE_USAGE_100',
};

/**
 * The service states a reminder may be raised for, per family.
 *
 * Expiry includes `EXPIRED`, because the `EXPIRED` reminder is the one that fires after
 * the sweep has already moved the row — the two run in different process roles and in
 * either order, so requiring the service to still be ACTIVE would make the message a
 * race.
 *
 * Usage does NOT. A service whose window has closed is no longer consuming anything,
 * and telling its owner they are at ninety-five percent of an allowance they can no
 * longer use is a message with nothing to do. Neither family includes
 * `PENDING_PROVISION` or `UNRECONCILED` — there is no account yet, or it is not known
 * whether there is one — nor `TERMINATED`, which is where a service goes to stop being
 * anybody's concern.
 */
export const EXPIRY_REMINDER_STATES = ['ACTIVE', 'SUSPENDED', 'EXPIRED'] as const;
export const USAGE_REMINDER_STATES = ['ACTIVE', 'SUSPENDED'] as const;
