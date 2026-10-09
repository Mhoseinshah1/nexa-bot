/**
 * How long a customer notification waited, and whether that is an anomaly (FIX-03).
 *
 * The owner read «approved by the gateway» at 09:37 and the amount with its tracking code at
 * about 09:39. Every stage between those two messages already leaves a timestamp — the
 * payment's `confirmed_at`, the notification's `created_at` (the same transaction, so the
 * same instant), its `send_started_at` stamp, its `resolved_at` — but nothing put them side
 * by side, so "where did the two minutes go" had no answer short of reading code.
 * `docs/payment-settlement-latency.md` carries the query over the persisted columns; this is
 * the same breakdown for the dispatcher's own log line, computed where all three instants
 * are in hand.
 *
 * Pure, and clamped at zero: a clock that stepped back between two readings must not produce
 * a negative wait that an alert would read as "faster than instant".
 */

/**
 * Above this, a FIRST attempt waited longer than a healthy lane makes it wait.
 *
 * Derived from the cadence, not chosen for comfort: a fact committed just after a pass waits
 * one interval (`CUSTOMER_NOTIFICATION_INTERVAL_MS`, two seconds) plus the pass's own
 * database work, measured at well under a second against a local database. Ten seconds is
 * five intervals — room for a busy database and a pass that is sending a small backlog — and
 * a sixth of the one-minute wait the old cadence produced, which it would have flagged on
 * every second message.
 *
 * Exceeding it is not always OURS to fix, and the log line says which: a Telegram 429 is
 * honoured at the later of its `retry_after` and the lane's own back-off (WP20), a stopped
 * worker sends nothing, and a backlog after an outage drains at the sweep limit per pass.
 * Those are reported, never hidden and never "sped up".
 */
export const CUSTOMER_NOTIFICATION_LATENCY_WARN_MS = 10_000;

export interface NotificationLatency {
  /** From the producer's commit (`created_at`) to the dispatcher's send stamp. */
  readonly queuedMs: number;
  /** The Telegram call itself: the stamp to the observed outcome. */
  readonly sendMs: number;
  /** Commit to outcome. */
  readonly totalMs: number;
}

export function notificationLatency(
  createdAt: Date,
  sendStartedAt: Date,
  outcomeAt: Date,
): NotificationLatency {
  const queuedMs = Math.max(0, sendStartedAt.getTime() - createdAt.getTime());
  const sendMs = Math.max(0, outcomeAt.getTime() - sendStartedAt.getTime());
  return { queuedMs, sendMs, totalMs: Math.max(0, outcomeAt.getTime() - createdAt.getTime()) };
}

/**
 * Whether this wait is an anomaly worth a warning.
 *
 * Only a row no refusal has touched is judged (`attempts` counts observed refusals). A retry
 * after a refusal waits the lane's back-off by design, and warning on it would be a second,
 * misleading alarm. A 429 spends NO attempt (ADR 0030 §2), so the send after a rate limit IS
 * judged — deliberately: that wait is Telegram's, and FIX-03 asks for an external delay to
 * be visible rather than absorbed. The line carries the outcome, so it reads as what it is.
 *
 * And only an IMMEDIATE kind. A reminder (`CUSTOMER_NOTIFICATION_QUIET_HOURS`) may be held
 * all night by the tenant's quiet window, which is the rule working, not a delay.
 */
export function notificationLatencyIsSlow(
  latency: NotificationLatency,
  attemptsBefore: number,
  immediate: boolean,
): boolean {
  return (
    immediate && attemptsBefore === 0 && latency.queuedMs > CUSTOMER_NOTIFICATION_LATENCY_WARN_MS
  );
}
