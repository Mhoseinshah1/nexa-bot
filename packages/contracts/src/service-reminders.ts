import { z } from 'zod';
import type { CustomerNotificationKind } from './customer-notifications.js';

/**
 * The eight moments a customer is told something about a service they already own
 * (six since Phase 6C, two more since WP-A9).
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
  /*
   * WP-A9: two more expiry SLOTS, appended so every stored row keeps its meaning.
   *
   * The brief's schedule is 7, 3 and 1 days before and the day of expiry. The two slots
   * that already existed keep exactly the meaning a tenant's stored values give them —
   * `EXPIRY_FIRST` is `reminders.expiry_first_days` (3 by default) and `EXPIRY_SECOND` is
   * `_second_days` (1) — and the two new ones sit on either side of them:
   *
   *   - `EXPIRY_EARLY`, the week-out warning, further out than FIRST
   *     (`reminders.expiry_early_days`, 7 by default, 0 turns it off);
   *   - `EXPIRY_DAY`, "your service expires today", once the expiry's own calendar day has
   *     begun in the tenant's display timezone and before the deadline itself.
   *
   * Added rather than renamed or re-slotted, because a kind is a CHECK-pinned value in two
   * tables: re-meaning `EXPIRY_FIRST` as "seven days" would re-label every occurrence
   * already stored under it.
   */
  'EXPIRY_EARLY',
  'EXPIRY_DAY',
] as const;
export type ServiceReminderKind = (typeof SERVICE_REMINDER_KINDS)[number];
export const serviceReminderKindSchema = z.enum(SERVICE_REMINDER_KINDS);

/**
 * The five that are about the clock, LEAST URGENT FIRST (three before WP-A9).
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
export const EXPIRY_REMINDER_KINDS = [
  'EXPIRY_EARLY',
  'EXPIRY_FIRST',
  'EXPIRY_SECOND',
  'EXPIRY_DAY',
  'EXPIRED',
] as const;
export type ExpiryReminderKind = (typeof EXPIRY_REMINDER_KINDS)[number];
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

/**
 * The week-out slot's floor, which is ZERO: zero turns that one warning off (WP-A9).
 *
 * The two older slots cannot be switched off one at a time — their family flag is the
 * switch — and a tenant that had configured three and one days had no fourth warning to
 * lose. The new slot must not impose one on them unasked for ever, so it alone has an
 * "off" value. Its ceiling is the shared one.
 */
export const EXPIRY_EARLY_REMINDER_DAYS_MIN = 0;

/**
 * How long before the deadline the day-of rung begins AT THE LATEST, in milliseconds.
 *
 * The rung normally begins at local midnight of the expiry's date. A service expiring a
 * few minutes after that midnight would then have a rung shorter than the fifteen-minute
 * sweep: one pass returns `EXPIRY_SECOND`, the next finds the deadline passed and returns
 * `EXPIRED`, and the enabled day-of reminder is recorded as passed without ever being sent
 * (Codex review #1 of PR #100, C2). So the rung begins at the EARLIER of local midnight and
 * `expiresAt - EXPIRY_DAY_MIN_NOTICE_MS` — twenty minutes: one sweep interval, one delivery
 * poll and slack, so a sweep running on time always lands in the rung with at least five
 * minutes left, and the send-time re-check (deadline still ahead) passes.
 * `tests/unit/wp-a9-reminders.test.ts` pins the relation to both loop intervals.
 *
 * What is still deliberate: a worker that is DOWN for the whole rung reaches the deadline
 * first, and then "expires today" is never sent — it would be false. The prefix records
 * the rung as passed and the expired notice is what the customer receives.
 */
export const EXPIRY_DAY_MIN_NOTICE_MS = 20 * 60_000;

/** Where the day-of rung begins: see `EXPIRY_DAY_MIN_NOTICE_MS`. */
export function expiryDayRungStart(localDayStart: Date, expiresAt: Date): Date {
  return new Date(
    Math.min(localDayStart.getTime(), expiresAt.getTime() - EXPIRY_DAY_MIN_NOTICE_MS),
  );
}

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
  /** WP-A9: whether "your service expires today" is sent (`service_expiry_day_reminder`). */
  readonly expiryDayEnabled: boolean;
  /** WP-A9: the week-out slot, in days. Zero is off. */
  readonly expiryEarlyDays: number;
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
  expiryDayEnabled: true,
  /*
   * WP-A9: 7, 3, 1 and the day itself — the owner's schedule. The two middle numbers are
   * unchanged, so a tenant that stored either keeps the warning it configured.
   */
  expiryEarlyDays: 7,
  expiryFirstDays: 3,
  expirySecondDays: 1,
  usageEnabled: true,
  /*
   * WP-A9: 20%, 10% and 5% REMAINING, which is 80, 90 and 95 percent USED.
   *
   * The three keys have always stored the percentage USED, and they still do: a tenant
   * that stored 80, 95 or 100 keeps exactly the moment it chose, because nothing reads a
   * stored value any differently. What moved is the DEFAULT, from 80/95/100 to 80/90/95,
   * and the operator-facing presentation, which now speaks in "remaining"
   * (`usageRemainingPercent`) — see `reminders.usage_first_percent`.
   */
  usageFirstPercent: 80,
  usageSecondPercent: 90,
  usageFinalPercent: 95,
};

/**
 * A usage threshold as the operator reads it: the percentage REMAINING (WP-A9).
 *
 * The inverse is the same subtraction, so the Web Admin converts both ways with this one
 * function and the stored "used" value is never shown or typed as such.
 */
export function usageRemainingPercent(usedPercent: number): number {
  return USAGE_REMINDER_PERCENT_MAX - usedPercent;
}

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
    /*
     * Both framings in one sentence (WP-A9): the stored numbers are percent USED and
     * ascend, and the Web Admin shows percent REMAINING, which descends. An operator on
     * either surface must be able to read which way the three have to go.
     */
    return 'آستانه‌های مصرف حجم باید به‌ترتیب صعودی و بدون تکرار باشند؛ یعنی هر هشدار با حجم باقی‌ماندهٔ کمتری از هشدار قبلی ارسال شود.';
  }
  return null;
}

/**
 * Why a proposed week-out threshold is refused, or `null` if it is sound (WP-A9).
 *
 * Asked ONLY when `reminders.expiry_early_days` itself is written, never when one of the
 * five older keys is — and that asymmetry is the backward compatibility. A tenant that
 * stored ten and five days before this slot existed has an early default of seven that
 * sits inside its first warning; refusing every later edit of the five older keys until
 * somebody visited the new one would make a tenant's own stored configuration
 * uneditable on upgrade. Instead such a slot is simply never due on its own: the sweep
 * reaches FIRST before it, records it as passed, and the Web Admin says so beside it.
 */
export function refuseEarlyReminderDays(earlyDays: number, firstDays: number): string | null {
  if (earlyDays !== 0 && earlyDays <= firstDays) {
    return 'یادآور هفتگی باید زودتر از یادآور اول باشد (روز بیشتری داشته باشد)، یا برای خاموش کردن آن صفر بگذارید.';
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
  thresholds: Pick<
    ServiceReminderThresholds,
    'expiryEarlyDays' | 'expiryFirstDays' | 'expirySecondDays'
  >,
): Readonly<Record<ExpiryReminderKind, number>> {
  return {
    EXPIRY_EARLY: thresholds.expiryEarlyDays,
    EXPIRY_FIRST: thresholds.expiryFirstDays,
    EXPIRY_SECOND: thresholds.expirySecondDays,
    // The day of expiry is a CALENDAR day, not a count; see `expiryReminderDue`.
    EXPIRY_DAY: 0,
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
  thresholds: Pick<
    ServiceReminderThresholds,
    'expiryEarlyDays' | 'expiryFirstDays' | 'expirySecondDays'
  >,
  /**
   * WP-A9: the instant the day-of rung begins — local midnight of the expiry date in the
   * tenant's display timezone, or `EXPIRY_DAY_MIN_NOTICE_MS` before the deadline when that
   * is earlier (`expiryDayRungStart`). `null` for a service with no deadline.
   *
   * A PARAMETER rather than computed here, because the candidate query computes it too
   * (`date_trunc('day', … AT TIME ZONE tz)`), and two computations of one boundary are
   * two answers the day a daylight-saving change lands between them. The repository
   * selects it beside the row and this function uses that value, so the filter and the
   * decision cannot disagree. A calendar changes nothing here: a Jalali day and a
   * Gregorian day begin at the same local midnight.
   */
  dayStartsAt: Date | null = null,
): ExpiryReminderKind | null {
  if (expiresAt === null) return null;
  const msLeft = expiresAt.getTime() - now.getTime();
  if (msLeft <= 0) return 'EXPIRED';
  if (dayStartsAt !== null && dayStartsAt.getTime() <= now.getTime()) return 'EXPIRY_DAY';
  const daysLeft = msLeft / 86_400_000;
  if (daysLeft <= thresholds.expirySecondDays) return 'EXPIRY_SECOND';
  if (daysLeft <= thresholds.expiryFirstDays) return 'EXPIRY_FIRST';
  /*
   * Zero is OFF, and a week-out slot that is not further out than FIRST is never due on
   * its own: FIRST is reached first and records it as passed. See `refuseEarlyReminderDays`.
   */
  if (thresholds.expiryEarlyDays > 0 && daysLeft <= thresholds.expiryEarlyDays) {
    return 'EXPIRY_EARLY';
  }
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
  EXPIRY_EARLY: 'SERVICE_EXPIRY_EARLY',
  EXPIRY_DAY: 'SERVICE_EXPIRY_DAY',
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
