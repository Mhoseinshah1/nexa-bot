import { z } from 'zod';

/**
 * WP-A9: the two automated customer reminders that are not about a service.
 *
 * - **A payment or order about to lapse** — "your invoice closes in ten minutes". Bounded:
 *   at most ONE per payment and ONE per order, by `customer_notifications_subject_key`,
 *   and only for a flow the customer can still complete.
 * - **A wallet balance that fell below the tenant's threshold** — once per crossing, and
 *   armed again only after the balance has been back at or above the threshold.
 *
 * Both travel on the customer notification lane (ADR 0030) with a precondition, so a
 * reminder whose condition stopped holding between the enqueue and the send — the
 * transfer was made, the wallet was topped up — is SUPERSEDED rather than sent.
 */

/**
 * The least time a pending reminder may be ENQUEUED before its deadline, in minutes.
 *
 * A reminder is delivered by a second lane on its own one-minute poll, and the send-time
 * precondition supersedes it once the deadline has passed. So a reminder enqueued with
 * under a minute left, and picked up by a poll that ran just before it committed, would be
 * superseded unsent — a valid configuration delivering nothing, in silence (Codex review
 * #1 of PR #100, C1). Three minutes covers the producer's own cadence, the delivery
 * lane's, and a minute of slack; `tests/unit/wp-a9-reminders.test.ts` pins the relation to
 * both loop intervals, so shortening either cannot quietly break it.
 */
export const PENDING_PAYMENT_REMINDER_MIN_NOTICE_MINUTES = 3;

/**
 * How many minutes before its deadline a pending payment or order is reminded about.
 *
 * The ceiling is thirty, because `PAYMENT_WINDOW_MINUTES_MAX` is sixty: a reminder further
 * out than half the longest window an operator may configure would arrive while the
 * customer is still reading the instructions it reminds them of.
 *
 * The floor is FIVE, not one, and the reason is the notice above: a reminder is due only
 * between the lead and `PENDING_PAYMENT_REMINDER_MIN_NOTICE_MINUTES`, and that window must
 * be wider than the producer's one-minute cadence or a pass may never land in it. With a
 * floor of five the narrowest window is two minutes. The floor was one when WP-A9 first
 * shipped; a stored value below five no longer parses, so the registry's own tightened-
 * bound rule applies — the default is in force, a WARN operational event says so, and the
 * Web Admin shows the row as a stored value that needs saving again.
 */
export const PENDING_PAYMENT_REMINDER_MINUTES_MIN = 5;
export const PENDING_PAYMENT_REMINDER_MINUTES_MAX = 30;

/**
 * The youngest attempt a pending reminder may be sent about, in minutes.
 *
 * Five, `PAYMENT_WINDOW_MINUTES_MIN`. A payment opened four minutes ago whose window is
 * ten is inside a ten-minute lead from the moment it exists; reminding at once would send
 * "your invoice is about to close" on top of the invoice itself. With this floor such an
 * attempt is reminded at its fifth minute, and one whose window is only five minutes
 * long is never reminded at all — which is right, because there is nothing to remind.
 */
export const PENDING_PAYMENT_REMINDER_MIN_AGE_MINUTES = 5;

/** The bound on one pending-reminder pass, per half. Oldest deadline first. */
export const PENDING_PAYMENT_REMINDER_SWEEP_LIMIT = 200;

/** The bound on one wallet low-balance pass. */
export const WALLET_LOW_BALANCE_SWEEP_LIMIT = 200;

/**
 * Whether a pending attempt is inside its reminder window: at most `leadMinutes` and at
 * least `PENDING_PAYMENT_REMINDER_MIN_NOTICE_MINUTES` before its deadline.
 *
 * An attempt closer to its deadline than the notice is NOT reminded: the message could not
 * be delivered before the send-time re-check supersedes it, and the expiry sweep will tell
 * the customer the attempt closed instead. That is a deliberate outcome, and with the
 * setting's floor above the notice every attempt passes through the window first.
 */
export function pendingReminderDue(
  createdAt: Date,
  expiresAt: Date,
  now: Date,
  leadMinutes: number,
): boolean {
  const left = expiresAt.getTime() - now.getTime();
  if (left < PENDING_PAYMENT_REMINDER_MIN_NOTICE_MINUTES * 60_000) return false;
  if (left > leadMinutes * 60_000) return false;
  return now.getTime() - createdAt.getTime() >= PENDING_PAYMENT_REMINDER_MIN_AGE_MINUTES * 60_000;
}

/**
 * Whole minutes left before a deadline, rounded UP and never below one.
 *
 * Up, for the reason `remainingDays` rounds up: "zero minutes" in a message that is not
 * the expiry notice is a sentence the customer cannot act on.
 */
export function minutesLeft(expiresAt: Date, now: Date): number {
  return Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 60_000));
}

/*
 * ## Quiet hours (HF-A9)
 *
 * The owner's instruction: a reminder that falls due inside the tenant's quiet window is
 * NOT dropped — it is held until the window ends, in the tenant's own timezone, and it is
 * not sent then if what it reminds about has stopped being true in the meantime. No
 * duplicate is created by holding it.
 *
 * The window is two wall-clock times, `HH:MM`, read in `tenants.display_timezone` — the
 * same zone the day-of expiry rung and every rendered date use, so "quiet from 23:00" and
 * "expires today" agree about what a local day is. The switch is the feature flag
 * `reminder_quiet_hours` and the two times are its settings: a flag is a boolean and its
 * parameters are settings, and neither registry grows a field that belongs to the other.
 *
 * WHERE it applies is `CUSTOMER_NOTIFICATION_QUIET_HOURS` in `customer-notifications.ts`:
 * reminders only, never a transactional reply or a payment outcome. HOW it is held is the
 * lane's own deferral — the notification row's `next_attempt_at` moves to the window's
 * end — so the row, its subject and `customer_notifications_subject_key` are untouched and
 * nothing new is written.
 */

/** `HH:MM`, 24-hour, `00:00` to `23:59`. Two digits each, so the text sorts as the time. */
export const QUIET_HOURS_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** A quiet-hours boundary as the registry stores it. */
export const quietHoursTimeSchema = z
  .string()
  .regex(
    QUIET_HOURS_TIME_PATTERN,
    'A quiet-hours time is HH:MM on a 24-hour clock, 00:00 to 23:59.',
  );

/**
 * The minute of the day a boundary names, `0` to `1439`, or `null` for a text that is not
 * one. The ONE parser, so the dispatcher and the Web Admin cannot read `8:00` differently:
 * both refuse it, because the schema does.
 */
export function quietHoursMinuteOfDay(text: string): number | null {
  if (!QUIET_HOURS_TIME_PATTERN.test(text)) return null;
  return Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));
}

/**
 * Whether a local minute of the day falls inside the window `[start, end)`.
 *
 * HALF-OPEN, like every interval in this product: at `start` it is quiet, at `end` it is
 * not — the minute the window ends is the minute a held reminder is sent.
 *
 * A window whose start is LATER than its end crosses midnight (`23:00`–`08:00` is quiet
 * from 23:00 to midnight and from midnight to 08:00). A window whose start EQUALS its end
 * is empty, never "all day": the write guard refuses it (`refuseQuietHours`), and a value
 * that reached a reader anyway must not hold every reminder for ever.
 */
export function quietHoursContains(minuteOfDay: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return minuteOfDay >= start && minuteOfDay < end;
  return minuteOfDay >= start || minuteOfDay < end;
}

/**
 * Why a proposed pair of boundaries is refused, or `null` if it is sound.
 *
 * Only equality is refused: it would be a window of no length, which an operator who typed
 * it almost certainly did not mean — and "all day" is not a quiet window, it is the flag
 * switched off with reminders piling up behind it. Persian, because it reaches an operator
 * verbatim, like `refuseReminderThresholds`.
 */
export function refuseQuietHours(start: string, end: string): string | null {
  if (start === end) {
    return 'ساعت شروع و پایان ساعات سکوت نمی‌توانند یکسان باشند.';
  }
  return null;
}
