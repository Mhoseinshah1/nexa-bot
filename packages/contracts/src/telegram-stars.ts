/**
 * Telegram Stars (post-WP20 brief, Package A; `docs/package-a-telegram-stars-audit.md`).
 *
 * Every value here is either Telegram Bot API semantics or a Nexa product decision, and the
 * two are labelled.
 */

/** Bot API: the currency code of Telegram Stars, for digital goods and services. */
export const TELEGRAM_STARS_CURRENCY = 'XTR';

/**
 * Bot API: an invoice's `payload` is 1–128 bytes. Nexa's payload is an opaque random id of
 * this many hex characters, naming no customer, order, token or secret.
 */
export const TELEGRAM_STARS_PAYLOAD_HEX_LENGTH = 32;

/**
 * Nexa: how long a Stars attempt lives from its creation, with no grace. The same seventy
 * minutes as the other external route, so a customer meets one rule.
 */
export const TELEGRAM_STARS_ATTEMPT_LIFETIME_MINUTES = 70;

/**
 * Nexa: pre-checkout stops approving this long before the attempt's deadline. Telegram
 * charges between the approval and `successful_payment`, and a payment recorded after the
 * deadline settles nothing — so approval ends early rather than at the edge.
 */
export const TELEGRAM_STARS_PRE_CHECKOUT_MARGIN_MS = 2 * 60_000;

/**
 * How long an APPROVED pre-checkout holds its payment against cancellation (Codex review of
 * #85). Telegram charges right after the approval, so for this long the payment may not be
 * cancelled, withdrawn or replaced by a wallet payment: `successful_payment` is on its way.
 * Equal to the margin above, so a hold taken at the last approvable moment ends exactly at
 * the attempt's deadline and never keeps an expired attempt open.
 */
export const TELEGRAM_STARS_CHECKOUT_HOLD_MS = TELEGRAM_STARS_PRE_CHECKOUT_MARGIN_MS;

/**
 * Nexa: the per-minute Telegram calls one tenant's Stars route allows itself for invoices.
 * There are no inquiries: approval is recorded, not asked for.
 */
export const TELEGRAM_STARS_CALL_BUDGET_PER_MINUTE = 20;

/**
 * The Stars for a payable, by the owner's rule: `ceil(payable / rate)`, in `bigint` only.
 *
 * `payableMinor` is the sales currency's minor units (principal plus the WP18 fee), and
 * `rateMinor` is how many of them one Star is worth. A positive payable is at least one
 * Star. The rounding excess is not money Nexa holds: nothing stores it as principal, fee,
 * credit or anything refundable. Null for a non-positive payable or rate.
 */
export function telegramStarsFor(payableMinor: bigint, rateMinor: bigint): bigint | null {
  if (payableMinor <= 0n || rateMinor <= 0n) return null;
  return (payableMinor + rateMinor - 1n) / rateMinor;
}
