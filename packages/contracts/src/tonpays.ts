/**
 * TonPays, as its one page of documentation describes it (WP11A).
 *
 * Every value here is either read off `https://doc.tonpays.online/` or is a Nexa
 * product decision, and the two are labelled. `docs/tonpays-gateway-audit.md` §4 lists
 * what the documentation does NOT say and what this installation does instead — the
 * signature algorithm, a refund or cancel call, an inquiry by order id, the meaning of
 * the three amounts. None of them is invented here.
 */

/** Documented. The production URL; there is no documented sandbox and none is assumed. */
export const TONPAYS_BASE_URL = 'https://tonpays.online';

/** Documented. */
export const TONPAYS_CREATE_PATH = '/api/v1/invoices/create';
/** Documented: `POST /api/v1/invoices/check` with `{ invoice_id }`. */
export const TONPAYS_CHECK_PATH = '/api/v1/invoices/check';

/** Documented: the authentication header. The value is never logged or echoed. */
export const TONPAYS_API_KEY_HEADER = 'X-API-Key';

/** Documented: the webhook's delivery id header, used only to deduplicate. */
export const TONPAYS_DELIVERY_ID_HEADER = 'x-tonpays-delivery-id';

/**
 * Documented by TonPays support (2026-10-24): `X-TonPays-Signature: t=<unix seconds>,v1=<hex>`,
 * `v1 = hex(HMAC-SHA256(secret, "{t}." + raw_body))`. `t` is the SEND time of that delivery
 * attempt, so it bounds clock skew only; it is never a replay key. Sent only when a webhook
 * secret exists for the gateway in TonPays.
 */
export const TONPAYS_SIGNATURE_HEADER = 'x-tonpays-signature';
/** Documented: the largest clock difference, in seconds, between `t` and now. */
export const TONPAYS_WEBHOOK_TOLERANCE_SECONDS = 300;

/** Documented: `order_id` is at most twenty characters and unique for the account. */
export const TONPAYS_ORDER_ID_MAX_LENGTH = 20;

/** Documented: the invoice statuses. */
export const TONPAYS_STATUSES = [
  'pending',
  'processing',
  'completed',
  'need_action',
  // Custom Telegram API (Round 6): the transfer was less / more than the invoice.
  'action_required_less',
  'action_required_more',
  'rejected',
  'expired',
  'canceled',
] as const;
export type TonPaysStatus = (typeof TONPAYS_STATUSES)[number];

/** Documented: the error codes, carried as `{ detail: { code, message } }`. */
export const TONPAYS_ERROR_CODES = [
  'MISSING_API_KEY',
  'INVALID_API_KEY',
  'INACTIVE_API_KEY',
  'ACCOUNT_NOT_VERIFIED',
  'ACCOUNT_SUSPENDED',
  'STORE_INACTIVE',
  'DUPLICATE_ORDER_ID',
  'AMOUNT_TOO_LOW',
  'AMOUNT_TOO_HIGH',
  'INVALID_BUYER_CHAT_ID',
  'BUYER_IS_MERCHANT',
  'BUYER_SUSPENDED',
  'PAYER_RESERVE_FAILED',
  'WEB_PAY_URL_FAILED',
  'INVALID_CALLBACK_URL',
  'RATE_LIMIT_EXCEEDED',
  'INVOICE_NOT_FOUND',
  'ACCESS_DENIED',
] as const;
export type TonPaysErrorCode = (typeof TONPAYS_ERROR_CODES)[number];

/**
 * Codes the WEBSITE route's own error list does not name, and which it is handled for anyway.
 *
 * `WRONG_API_KEY_KIND` is documented on the Custom Telegram API
 * (`TONPAYS_TELEGRAM_ERROR_CODES`): the key sent is of the other kind. TonPays issues a
 * website key and a Custom Telegram key from one account, and an operator can paste
 * either into either route, so the website route can be answered with it too.
 *
 * Nexa decision (owner, 2026-10-18; `docs/tonpays-gateway-audit.md` §6): on the website
 * route it is CONFIGURATION, like on the Telegram route. Before, it was undocumented
 * for this route and therefore `REFUSED`, which told the customer their payment FAILED
 * and opened nothing for the operator, who was the only one who could fix it.
 */
export const TONPAYS_CROSS_ROUTE_ERROR_CODES = ['WRONG_API_KEY_KIND'] as const;
export type TonPaysCrossRouteErrorCode = (typeof TONPAYS_CROSS_ROUTE_ERROR_CODES)[number];

/**
 * The codes that describe the MERCHANT'S configuration, never the customer's payment.
 *
 * Nexa decision (brief §19): these are never presented to a customer as their payment
 * failing or succeeding. They open an operational condition for the operator, and the
 * customer is told the method is unavailable right now.
 */
export const TONPAYS_CONFIGURATION_ERROR_CODES: readonly (
  TonPaysErrorCode | TonPaysCrossRouteErrorCode
)[] = [
  'MISSING_API_KEY',
  'INVALID_API_KEY',
  'INACTIVE_API_KEY',
  'ACCOUNT_NOT_VERIFIED',
  'ACCOUNT_SUSPENDED',
  'STORE_INACTIVE',
  'ACCESS_DENIED',
  'INVALID_CALLBACK_URL',
  'WRONG_API_KEY_KIND',
];

/**
 * Documented: 60 create/inquiry requests per minute, 120 per IP per minute.
 *
 * Nexa decision: stay BELOW the documented ceiling, across every replica, with a floor
 * reserved for creates so a backlog of background inquiries can never stop a customer
 * getting an invoice.
 */
export const TONPAYS_DOCUMENTED_REQUESTS_PER_MINUTE = 60;
export const TONPAYS_CALL_BUDGET_PER_MINUTE = 50;
export const TONPAYS_INQUIRY_BUDGET_PER_MINUTE = 40;

/**
 * Round 11 A8 (owner report: TonPays answered HTTP 429 to invoice creates twice in one minute).
 *
 * Nexa decision: every TonPays call — create, check, change card, receipt, cancel, refund, on
 * either route — first takes a token from ONE client-side token bucket per API key, in the
 * TonPays HTTP client itself, so no caller can reach the provider around it. The bucket refills
 * at `calls_per_minute` and holds at most `burst` tokens; a 429 from the provider closes it for
 * the provider's `Retry-After`, else an exponential, jittered back-off
 * (`TONPAYS_RATE_LIMIT_BACKOFF_*`). The per-minute budget above stays as the cross-replica bound.
 *
 * Conservative defaults: the two routes together (30 + 15) stay under the documented 60 a minute
 * even if TonPays counts both keys against one account (`OQ-WP11A-02`: per key, store or account
 * is undocumented), and a burst of three keeps one worker pass from firing a volley.
 */
export const TONPAYS_PACING_SETTING_KEYS = {
  TONPAYS: 'payments.tonpays.calls_per_minute',
  TONPAYS_TELEGRAM: 'payments.tonpays_telegram.calls_per_minute',
} as const;
export const TONPAYS_PACING_BURST_SETTING_KEY = 'payments.tonpays.burst' as const;
export const TONPAYS_CALLS_PER_MINUTE_MIN = 1;
/** Never above the documented ceiling. */
export const TONPAYS_CALLS_PER_MINUTE_MAX = TONPAYS_DOCUMENTED_REQUESTS_PER_MINUTE;
export const TONPAYS_CALLS_PER_MINUTE_DEFAULT = 30;
export const TONPAYS_TELEGRAM_CALLS_PER_MINUTE_DEFAULT = 15;
export const TONPAYS_PACING_BURST_MIN = 1;
export const TONPAYS_PACING_BURST_MAX = 10;
export const TONPAYS_PACING_BURST_DEFAULT = 3;
/** A 429 with no `Retry-After`: 5 s, doubling per consecutive 429, at most five minutes, ±20 %. */
export const TONPAYS_RATE_LIMIT_BACKOFF_BASE_MS = 5_000;
export const TONPAYS_RATE_LIMIT_BACKOFF_CAP_MS = 5 * 60_000;
export const TONPAYS_RATE_LIMIT_BACKOFF_JITTER_RATIO = 0.2;
/** The longest `Retry-After` honoured: a provider cannot park the route for longer. */
export const TONPAYS_RETRY_AFTER_MAX_MS = 60 * 60_000;

/**
 * Nexa decision (brief §3): a TonPays attempt lives exactly seventy minutes from the
 * creation of the internal payment, with no grace period. After it, nothing settles
 * automatically.
 *
 * Deliberately NOT `sales.payment_window_minutes`, whose owner-set ceiling of sixty
 * minutes bounds how long a MANUAL transfer's bank details stay live. This is a fixed
 * rule for one gateway, and it neither reads nor widens that setting.
 */
export const TONPAYS_ATTEMPT_LIFETIME_MINUTES = 70;

/**
 * Nexa decision: the provider's amount unit. TonPays documents `amount` as TOMAN, and
 * this installation sells in `IRT` (Toman) or `IRR` (Rial). One Toman is ten Rial by
 * definition — a unit, not an exchange rate — so an IRR amount is sent only when it is a
 * whole number of Toman, and refused otherwise rather than rounded.
 */
export const TONPAYS_AMOUNT_UNIT = 'IRT' as const;
