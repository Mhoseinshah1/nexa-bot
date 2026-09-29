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
