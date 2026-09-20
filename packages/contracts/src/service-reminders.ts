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
  'EXPIRY_FIRST',
  'EXPIRY_SECOND',
  'EXPIRED',
  'USAGE_FIRST',
  'USAGE_SECOND',
  'USAGE_FINAL',
] as const;
export type ServiceReminderKind = (typeof SERVICE_REMINDER_KINDS)[number];
export const serviceReminderKindSchema = z.enum(SERVICE_REMINDER_KINDS);

/**
 * The three that are about the clock, LEAST URGENT FIRST.
 *
 * The order is read by the sweep, which writes the whole prefix up to the kind it is
 * sending, so that a lane which was down for two days cannot say "expires tomorrow"
 * and then, an hour later, "three days left".
 *
 * A SLOT, not a threshold. `EXPIRING_3D` was the first name these carried, and it was
 * wrong the moment the owner confirmed Mirza's crons were configurable (CBR-003,
 * CBR-011: a capability is «a flag plus a configuration record», and the six cron
 * screens take a scalar). A kind is stored in a row and pinned by a CHECK constraint;
 * a threshold is a tenant's setting and moves. Naming the row after the number would
 * make an operator changing three days to five either rewrite history or produce a
 * kind the database refuses.
 */
export const EXPIRY_REMINDER_KINDS = ['EXPIRY_FIRST', 'EXPIRY_SECOND', 'EXPIRED'] as const;
/** The three that are about the traffic allowance, lowest first. Slots, as above. */
export const USAGE_REMINDER_KINDS = ['USAGE_FIRST', 'USAGE_SECOND', 'USAGE_FINAL'] as const;

/**
 * The bounds a configured expiry threshold is checked against, in whole days.
 *
 * Owner's numbers. One day is the floor because a reminder due in less than a day is
 * one a fifteen-minute sweep may deliver after the service has already lapsed; thirty
 * is the ceiling because a warning a month out is not a warning.
 */
export const EXPIRY_REMINDER_DAYS_MIN = 1;
export const EXPIRY_REMINDER_DAYS_MAX = 30;

/** The bounds a configured usage threshold is checked against, in percent. */
export const USAGE_REMINDER_PERCENT_MIN = 1;
export const USAGE_REMINDER_PERCENT_MAX = 100;

/**
 * The thresholds one tenant's reminders fire at, resolved from settings.
 *
 * Read per pass and never cached across one, because an operator's edit has to take
 * effect without a restart — `RUNTIME` mutability, which the registry declares and
 * this honours.
 *
 * The flags are separate from the numbers for the reason `features.ts` gives and
 * CBR-003 found: a capability is a flag PLUS a configuration record, and a
 * `map[string]bool` cannot hold the second. Turning a family off therefore leaves its
 * numbers exactly where they were, and turning it back on restores them — there is no
 * code path that could reset them, because nothing writes them but an administrator.
 */
export interface ServiceReminderThresholds {
  readonly expiryEnabled: boolean;
  readonly expiredNoticeEnabled: boolean;
  readonly expiryFirstDays: number;
  readonly expirySecondDays: number;
  readonly usageEnabled: boolean;
  readonly usageFirstPercent: number;
  readonly usageSecondPercent: number;
  readonly usageFinalPercent: number;
}

/** The registry's defaults, as one object, so a test and a fixture agree with it. */
export const SERVICE_REMINDER_DEFAULTS: ServiceReminderThresholds = {
  expiryEnabled: true,
  expiredNoticeEnabled: true,
  expiryFirstDays: 3,
  expirySecondDays: 1,
  usageEnabled: true,
  usageFirstPercent: 80,
  usageSecondPercent: 95,
  usageFinalPercent: 100,
};

/**
 * Why a proposed combination of thresholds is refused, or `null` if it is sound.
 *
 * ONE function, called by the settings guard that vetoes each of the five keys and by
 * nothing else. Per-key zod schemas can bound a number and cannot say that the first
 * expiry threshold must be further out than the second — and a rule spread across five
 * schemas is a rule that disagrees with itself the first time one of them is edited.
 *
 * The messages are Persian because they are shown to an administrator, on both
 * surfaces, exactly as written. A refusal that says only "invalid" is the legacy
 * `⭕️ ورودی نا معتبر` (BC-SB-004), which tells an operator nothing about which of the
 * five numbers is wrong or why.
 */
export function refuseReminderThresholds(
  thresholds: Pick<
    ServiceReminderThresholds,
    | 'expiryFirstDays'
    | 'expirySecondDays'
    | 'usageFirstPercent'
    | 'usageSecondPercent'
    | 'usageFinalPercent'
  >,
): string | null {
  if (thresholds.expiryFirstDays <= thresholds.expirySecondDays) {
    return 'یادآور اول باید زودتر از یادآور دوم باشد؛ یعنی تعداد روز بیشتری داشته باشد.';
  }
  const { usageFirstPercent, usageSecondPercent, usageFinalPercent } = thresholds;
  if (usageSecondPercent <= usageFirstPercent || usageFinalPercent <= usageSecondPercent) {
    return 'آستانه‌های مصرف باید به‌ترتیب صعودی و بدون تکرار باشند.';
  }
  return null;
}

/**
 * The expiry thresholds as a kind-to-days map, most urgent last.
 *
 * `EXPIRED` is zero: it fires once the deadline has passed, not before it, and is
 * therefore not a configurable number — what an operator configures about it is
 * whether it is sent at all.
 */
export function expiryReminderDays(
  thresholds: Pick<ServiceReminderThresholds, 'expiryFirstDays' | 'expirySecondDays'>,
): Readonly<Record<(typeof EXPIRY_REMINDER_KINDS)[number], number>> {
  return {
    EXPIRY_FIRST: thresholds.expiryFirstDays,
    EXPIRY_SECOND: thresholds.expirySecondDays,
    EXPIRED: 0,
  };
}

/** The usage thresholds as a kind-to-percent map, lowest first. */
export function usageReminderPercent(
  thresholds: Pick<
    ServiceReminderThresholds,
    'usageFirstPercent' | 'usageSecondPercent' | 'usageFinalPercent'
  >,
): Readonly<Record<(typeof USAGE_REMINDER_KINDS)[number], number>> {
  return {
    USAGE_FIRST: thresholds.usageFirstPercent,
    USAGE_SECOND: thresholds.usageSecondPercent,
    USAGE_FINAL: thresholds.usageFinalPercent,
  };
}

/**
 * Has this service used at least `percent` of its allowance?
 *
 * Integers rather than floats, and compared by integer arithmetic —
 * `used * 100 >= limit * threshold` — because `usedBytes / limitBytes` on `bigint`
 * values large enough to matter is exactly the float this codebase refuses for money
 * and refuses here for the same reason: the comparison has to be exact at the
 * boundary, and 0.7999999999999999 is a customer not told.
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
  thresholds: Pick<
    ServiceReminderThresholds,
    'usageFirstPercent' | 'usageSecondPercent' | 'usageFinalPercent'
  >,
): readonly (typeof USAGE_REMINDER_KINDS)[number][] {
  const percent = usageReminderPercent(thresholds);
  return [...USAGE_REMINDER_KINDS]
    .sort((a, b) => percent[b] - percent[a])
    .filter((kind) => usageReached(usedBytes, limitBytes, percent[kind]));
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
  thresholds: Pick<ServiceReminderThresholds, 'expiryFirstDays' | 'expirySecondDays'>,
): (typeof EXPIRY_REMINDER_KINDS)[number] | null {
  if (expiresAt === null) return null;
  const msLeft = expiresAt.getTime() - now.getTime();
  if (msLeft <= 0) return 'EXPIRED';
  const daysLeft = msLeft / 86_400_000;
  if (daysLeft <= thresholds.expirySecondDays) return 'EXPIRY_SECOND';
  if (daysLeft <= thresholds.expiryFirstDays) return 'EXPIRY_FIRST';
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
  EXPIRY_FIRST: 'SERVICE_EXPIRY_FIRST',
  EXPIRY_SECOND: 'SERVICE_EXPIRY_SECOND',
  EXPIRED: 'SERVICE_EXPIRED',
  USAGE_FIRST: 'SERVICE_USAGE_FIRST',
  USAGE_SECOND: 'SERVICE_USAGE_SECOND',
  USAGE_FINAL: 'SERVICE_USAGE_FINAL',
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
