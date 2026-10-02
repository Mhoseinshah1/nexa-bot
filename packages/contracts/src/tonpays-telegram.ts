import { TONPAYS_BASE_URL } from './tonpays.js';

/**
 * TonPays' Custom Telegram gateway (`TONPAYS_TELEGRAM`), as the owner's transcription of its
 * documentation describes it (`docs/tonpays-telegram-gateway-audit.md` §2), and the Nexa
 * decisions around it (§9.6, the owner's decision of 2026-10-01).
 *
 * Every value is labelled DOCUMENTED (the transcription, nothing added) or NEXA (a product
 * decision). What the transcription does not say is an open question
 * (`docs/open-questions.md`, `OQ-TPTG-*`) and is NOT invented here. Nothing in this file has
 * been accepted against the real provider (`OQ-WP10-01`).
 */

/** Documented: the same production origin as the website API. No sandbox is assumed. */
export const TONPAYS_TELEGRAM_BASE_URL = TONPAYS_BASE_URL;

/** Documented: `POST`, JSON `{ amount, order_id, buyer_chat_id, callback_url? }`. */
export const TONPAYS_TELEGRAM_CREATE_PATH = '/api/custom/v1/invoices/telegram/create';
/** Documented: `GET /api/custom/v1/invoices/check/{invoice_id}` — the id is IN THE PATH. */
export const TONPAYS_TELEGRAM_CHECK_PATH_PREFIX = '/api/custom/v1/invoices/check/';
/** Documented: `POST /api/custom/v1/invoices/{invoice_id}/change-card` and `/receipt`. */
export const TONPAYS_TELEGRAM_INVOICE_PATH_PREFIX = '/api/custom/v1/invoices/';
export const TONPAYS_TELEGRAM_CHANGE_CARD_SUFFIX = '/change-card';
export const TONPAYS_TELEGRAM_RECEIPT_SUFFIX = '/receipt';
/** Documented: the multipart field the receipt image travels in. */
export const TONPAYS_TELEGRAM_RECEIPT_FIELD = 'file';

/**
 * NEXA: a provider-supplied invoice id is placed in a URL PATH, so it is refused unless it
 * matches this allow-list — and is still `encodeURIComponent`-ed (audit §9.2).
 */
export const TONPAYS_TELEGRAM_INVOICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * Documented: "max 5 MB". Whether that is 5,000,000 or 5 × 2^20 bytes is not said
 * (`OQ-TPTG-07`), so Nexa takes the SMALLER reading: an image Nexa accepts is never one the
 * provider's own bound refuses.
 */
export const TONPAYS_TELEGRAM_RECEIPT_MAX_BYTES = 5_000_000;

/**
 * NEXA (`OQ-TPTG-07`): "image" is all the documentation says. Telegram re-encodes a photo
 * to JPEG; a receipt is sent only when its magic bytes are JPEG or PNG.
 */
export const TONPAYS_TELEGRAM_RECEIPT_MIME_TYPES = ['image/jpeg', 'image/png'] as const;
export type TonPaysTelegramReceiptMimeType = (typeof TONPAYS_TELEGRAM_RECEIPT_MIME_TYPES)[number];

/** Documented: the nine error codes of the custom API. */
export const TONPAYS_TELEGRAM_ERROR_CODES = [
  'WRONG_API_KEY_KIND',
  'GATEWAY_NOT_APPROVED',
  'MISSING_API_KEY',
  'INVALID_API_KEY',
  'DUPLICATE_ORDER_ID',
  'INVALID_RECEIPT_TYPE',
  'RECEIPT_TOO_LARGE',
  'RATE_LIMIT_EXCEEDED',
  'INVOICE_NOT_FOUND',
] as const;
export type TonPaysTelegramErrorCode = (typeof TONPAYS_TELEGRAM_ERROR_CODES)[number];

/**
 * NEXA (audit §11): the codes that describe the MERCHANT'S configuration — never the
 * customer's payment. `WRONG_API_KEY_KIND` means the website key was stored for the
 * Telegram route (or the reverse). The customer is told the method is unavailable, and
 * `payments.gateway_misconfigured` opens for this route.
 */
export const TONPAYS_TELEGRAM_CONFIGURATION_ERROR_CODES: readonly TonPaysTelegramErrorCode[] = [
  'WRONG_API_KEY_KIND',
  'GATEWAY_NOT_APPROVED',
  'MISSING_API_KEY',
  'INVALID_API_KEY',
];

/** NEXA (audit §11): the provider refused the IMAGE, not the payment. */
export const TONPAYS_TELEGRAM_RECEIPT_ERROR_CODES: readonly TonPaysTelegramErrorCode[] = [
  'INVALID_RECEIPT_TYPE',
  'RECEIPT_TOO_LARGE',
];

/**
 * NEXA (audit §9.5, `OQ-TPTG-10`): the custom API's rate limit is undocumented. Every call
 * this route makes (create, inquiry, change card, receipt) takes this budget; with the
 * website route's 50 the two together stay near the website's documented 60/min should the
 * provider count per account. Background inquiries may use the smaller share.
 */
export const TONPAYS_TELEGRAM_CALL_BUDGET_PER_MINUTE = 25;
export const TONPAYS_TELEGRAM_INQUIRY_BUDGET_PER_MINUTE = 15;

/**
 * NEXA (`OQ-TPTG-01`): `NT` + eighteen Crockford base32 characters — exactly the documented
 * maximum of twenty, and recognisably not a website (`NX`) order id.
 */
export const TONPAYS_TELEGRAM_ORDER_ID_PREFIX = 'NT';

/**
 * NEXA, the owner's decision of 2026-10-01 (audit §9.6): a receipt TonPays ACKNOWLEDGES
 * before the attempt's 70-minute deadline opens a provider review window of this length,
 * from the acknowledgement, written once and frozen. It generates
 * `payments_provider_review_check`.
 */
export const TONPAYS_TELEGRAM_REVIEW_WINDOW_HOURS = 24;
export const TONPAYS_TELEGRAM_REVIEW_WINDOW_MS = TONPAYS_TELEGRAM_REVIEW_WINDOW_HOURS * 3_600_000;

/**
 * NEXA (audit §9.6.5): the inquiry interval during a review, by time since the
 * acknowledgement. About ninety-eight calls over a whole review; the last inquiry before the
 * review deadline is scheduled fifteen seconds before it, as for the customer window.
 */
export const TONPAYS_TELEGRAM_REVIEW_INQUIRY_CADENCE: readonly {
  readonly untilMs: number;
  readonly intervalMs: number;
}[] = [
  { untilMs: 3_600_000, intervalMs: 120_000 },
  { untilMs: 6 * 3_600_000, intervalMs: 600_000 },
  { untilMs: TONPAYS_TELEGRAM_REVIEW_WINDOW_MS, intervalMs: 1_800_000 },
];

/** NEXA (audit §9.6.5): the customer's 🔎 tap brings an inquiry forward no sooner than this in review. */
export const TONPAYS_TELEGRAM_REVIEW_CHECK_SPACING_MS = 60_000;

/** NEXA (audit §7.4): a receipt capture window lasts this long, capped at the payment's deadline. */
export const TONPAYS_TELEGRAM_RECEIPT_CAPTURE_MINUTES = 10;

/**
 * Documented: the provider's card-change engine has a sixty-second cooldown. NEXA: until the
 * provider has said otherwise, the bot offers a change no sooner than this after the card it
 * last showed, and a lost answer is never re-sent — a new tap after this is a new request.
 */
export const TONPAYS_TELEGRAM_CARD_CHANGE_COOLDOWN_SECONDS = 60;

/** NEXA (audit §9.1): a rate-limited receipt upload is re-queued at most this many times. */
export const TONPAYS_TELEGRAM_RECEIPT_MAX_ATTEMPTS = 3;

/** NEXA (`OQ-TPTG-06`): the card's format is undocumented; only its length is bounded. */
export const GATEWAY_CARD_NUMBER_MAX_LENGTH = 64;
export const GATEWAY_CARD_NAME_MAX_LENGTH = 128;

/** Where a shown card came from: the create answer, or a change-card answer. */
export const GATEWAY_CARD_SOURCES = ['CREATE', 'CHANGE_CARD'] as const;
export type GatewayCardSource = (typeof GATEWAY_CARD_SOURCES)[number];

/**
 * A customer's card-change request (audit §7.3), claimed and sent by the gateway worker.
 *
 * - `REQUESTED` — written by the tap; nothing sent.
 * - `SENT` — the send was stamped and committed BEFORE the call. A row reclaimed here is
 *   `UNKNOWN` and never re-sent.
 * - `APPLIED` — the provider answered with a new card, now current.
 * - `REFUSED` — a readable refusal (incl. `INVOICE_NOT_FOUND`); the card is unchanged.
 * - `RATE_LIMITED` — the provider's own `RATE_LIMIT_EXCEEDED` on a 4xx: not processed.
 * - `UNKNOWN` — the answer was lost. The current card is HIDDEN (the provider may have
 *   retired it); a later tap is a new, explicit request, never a retry.
 */
export const GATEWAY_CARD_CHANGE_STATES = [
  'REQUESTED',
  'SENT',
  'APPLIED',
  'REFUSED',
  'RATE_LIMITED',
  'UNKNOWN',
] as const;
export type GatewayCardChangeState = (typeof GATEWAY_CARD_CHANGE_STATES)[number];

/**
 * A receipt the customer sent for the provider (audit §7.5). Never a `payment_receipts` row.
 *
 * - `QUEUED` — written by the turn that received the photo; nothing downloaded or sent.
 * - `SENDING` — claimed, and the send stamped and committed before the upload. A row
 *   reclaimed with the stamp set is `UNKNOWN` and is never re-uploaded.
 * - `ACCEPTED` — the provider answered the upload. Its `paid` and `receipt_received` are
 *   metadata; only `receiptAcknowledged` decides whether a review window opens.
 * - `REFUSED` — a readable refusal (image type, size, configuration, not found).
 * - `UNKNOWN` — the answer was lost. Never re-uploaded blindly (`OQ-TPTG-08`).
 * - `ABANDONED` — never sent: the deadline passed, the payment closed, the file could not be
 *   fetched or is not an image, or the rate-limit retries ran out.
 */
export const GATEWAY_RECEIPT_SUBMISSION_STATES = [
  'QUEUED',
  'SENDING',
  'ACCEPTED',
  'REFUSED',
  'UNKNOWN',
  'ABANDONED',
] as const;
export type GatewayReceiptSubmissionState = (typeof GATEWAY_RECEIPT_SUBMISSION_STATES)[number];

/** Why a provider receipt capture window closed (audit §7.4). */
export const GATEWAY_RECEIPT_CAPTURE_CLOSE_REASONS = [
  'RECEIVED',
  'SUPERSEDED',
  'EXPIRED',
  'PAYMENT_CLOSED',
] as const;
export type GatewayReceiptCaptureCloseReason =
  (typeof GATEWAY_RECEIPT_CAPTURE_CLOSE_REASONS)[number];
