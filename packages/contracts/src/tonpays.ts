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

/** Documented: `order_id` is at most twenty characters and unique for the account. */
export const TONPAYS_ORDER_ID_MAX_LENGTH = 20;

/** Documented: the invoice statuses. */
export const TONPAYS_STATUSES = [
  'pending',
  'processing',
  'completed',
  'need_action',
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
 * The codes that describe the MERCHANT'S configuration, never the customer's payment.
 *
 * Nexa decision (brief §19): these are never presented to a customer as their payment
 * failing or succeeding. They open an operational condition for the operator, and the
 * customer is told the method is unavailable right now.
 */
export const TONPAYS_CONFIGURATION_ERROR_CODES: readonly TonPaysErrorCode[] = [
  'MISSING_API_KEY',
  'INVALID_API_KEY',
  'INACTIVE_API_KEY',
  'ACCOUNT_NOT_VERIFIED',
  'ACCOUNT_SUSPENDED',
  'STORE_INACTIVE',
  'ACCESS_DENIED',
  'INVALID_CALLBACK_URL',
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
