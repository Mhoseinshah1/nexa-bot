/**
 * WP20 — messaging reliability and anti-spam (owner's brief §3).
 *
 * Two families of rule live here because both are about one question: what the
 * installation does when a message, in either direction, will not go through cleanly.
 * Every number below is the owner's, word for word. None is a setting, because a setting
 * is a way to change an owner decision from a form.
 */

/**
 * The delay before the next attempt after the Nth real failure (brief §3.1): 5 s, 15 s,
 * 60 s, 5 min, 15 min, then an hour for every later one.
 */
export const DELIVERY_RETRY_SCHEDULE_MS = [5_000, 15_000, 60_000, 300_000, 900_000] as const;

/** The cap every later failure waits. */
export const DELIVERY_RETRY_CAP_MS = 3_600_000;

/**
 * After this many real failed attempts a message is no longer retried automatically
 * (brief §3.2). It is kept, shown in the system diagnostics and announced once as an
 * operational event; it is never deleted and never marked done by a control.
 */
export const DELIVERY_MAX_FAILED_ATTEMPTS = 12;

/**
 * How long to wait after `failures` real failures (1 for the first).
 *
 * When the provider said how long to wait (`retry_after`), the LATER of the two is used:
 * never earlier than the provider asked, never earlier than the local schedule. Never
 * zero, whatever the provider answered, so a failure cannot become a hot loop.
 */
export function deliveryRetryDelayMs(failures: number, providerRetryAfterMs?: number): number {
  const index = Math.max(Math.trunc(failures), 1) - 1;
  const local = DELIVERY_RETRY_SCHEDULE_MS[index] ?? DELIVERY_RETRY_CAP_MS;
  const provider =
    providerRetryAfterMs !== undefined && Number.isFinite(providerRetryAfterMs)
      ? Math.max(providerRetryAfterMs, 0)
      : 0;
  return Math.max(local, provider);
}

/**
 * The outbox message that reached `DELIVERY_MAX_FAILED_ATTEMPTS`. Recorded once per
 * message (the message id is the dedupe key), because each such message is its own fact
 * for an operator to read, not a condition that recovers.
 */
export const OUTBOX_MESSAGE_EXHAUSTED_CODE = 'outbox.message_exhausted';

// --- Anti-spam (brief §3.4–§3.5) ----------------------------------------------------------

/** The rolling window inbound interactions are counted in. */
export const ANTI_SPAM_WINDOW_MS = 10_000;

/**
 * Interactions 1–20 in the window are allowed; the 21st blocks the customer. "More than
 * 20", never "20 or more".
 */
export const ANTI_SPAM_MAX_INTERACTIONS = 20;

/**
 * The reason stored on the customer's row and shown to an administrator, word for word
 * (brief §3.5). It is also how the runtime recognises an anti-spam block when it chooses
 * the customer's reply, so it is a constant rather than a sentence anybody retypes.
 */
export const ANTI_SPAM_BLOCK_REASON = 'ارسال بیش از حد پیام در بازه کوتاه (اسپم)';

/**
 * Anti-spam could not count because its store (Redis) did not answer. Anti-spam fails
 * OPEN: nobody is blocked on a guess, and this condition says the protection is off.
 * Recovered by `ANTI_SPAM_RECOVERED_CODE` when the store answers again.
 */
export const ANTI_SPAM_UNAVAILABLE_CODE = 'antispam.unavailable';
export const ANTI_SPAM_RECOVERED_CODE = 'antispam.recovered';
