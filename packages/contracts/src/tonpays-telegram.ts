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
/** Documented (Round 6): `POST /api/custom/v1/invoices/{invoice_id}/cancel`, no body. */
export const TONPAYS_TELEGRAM_CANCEL_SUFFIX = '/cancel';
/**
 * Documented (Round 6): `POST /api/custom/v1/invoices/{invoice_id}/refund` with the JSON body
 * `{ invoice_id, card_number, card_holder }` — and NO amount: the provider knows what it owes.
 */
export const TONPAYS_TELEGRAM_REFUND_SUFFIX = '/refund';

/**
 * Documented (Round 6): the two statuses an inquiry reports when the customer's transfer did
 * not match the invoice. Neither is an approval — only `completed` with `paid === true` is
 * (`tonpaysVerdict`) — so each is an OPEN status that carries a next step for the customer.
 * `need_action` (the older transcription) stays an open status too.
 */
export const TONPAYS_TELEGRAM_STATUS_LESS = 'action_required_less';
export const TONPAYS_TELEGRAM_STATUS_MORE = 'action_required_more';
/** Documented: the multipart field the receipt image travels in. */
export const TONPAYS_TELEGRAM_RECEIPT_FIELD = 'file';

/**
 * NEXA: a provider-supplied invoice id is placed in a URL PATH, so it is refused unless it
 * matches this allow-list — and is still `encodeURIComponent`-ed (audit §9.2).
 */
export const TONPAYS_TELEGRAM_INVOICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * Documented: "max 10 MB" (the provider's current API document, adopted 2026-10-18; it
 * said 5 MB when the route was built). Whether that is 10,000,000 or 10 × 2^20 bytes is not
 * said (`OQ-TPTG-07`), so Nexa takes the SMALLER reading: an image Nexa accepts is never one
 * the provider's own bound refuses.
 */
export const TONPAYS_TELEGRAM_RECEIPT_MAX_BYTES = 10_000_000;

/**
 * Documented (Round 6): the receipt types the provider accepts — JPEG, PNG, WebP and GIF.
 * NEXA: the type is decided by the file's MAGIC BYTES, never by Telegram's declared type or a
 * file name. Telegram re-encodes a photo to JPEG, so WebP and GIF can only arrive as an image
 * sent as a document; those are accepted when the declared type is one of these, and sniffed
 * again before anything is uploaded.
 */
export const TONPAYS_TELEGRAM_RECEIPT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;
export type TonPaysTelegramReceiptMimeType = (typeof TONPAYS_TELEGRAM_RECEIPT_MIME_TYPES)[number];

/**
 * Documented (TonPays API document, custom Telegram error table, page 20): the error codes of
 * the custom API. The first nine are the original transcription; the rest are the Round 6
 * additions for cancel, refund, a buyer who already holds an open invoice, and the
 * receipt/remainder checks — the table in full, 24 codes. A code outside it is `REFUSED` and
 * stored verbatim.
 */
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
  'INVOICE_ID_MISMATCH',
  'NOT_PENDING',
  'REMAINDER_INVOICE_MISSING',
  'EMPTY_RECEIPT',
  'CANCEL_NOT_ALLOWED_PROCESSING',
  'CANCEL_NOT_ALLOWED_NEED_ACTION_LESS',
  'CANCEL_NOT_ALLOWED_NEED_ACTION_MORE',
  'BUYER_HAS_PENDING_INVOICE',
  'BUYER_HAS_PROCESSING_INVOICE',
  'BUYER_HAS_NEED_ACTION_LESS',
  'BUYER_HAS_NEED_ACTION_MORE',
  'REFUND_NOT_ALLOWED',
  'INVALID_REFUND_CARD',
  'INVALID_REFUND_HOLDER',
  'REFUND_ALREADY_OPEN',
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
  'EMPTY_RECEIPT',
];

/**
 * Round 6: the buyer already holds an open invoice with the provider, so a create is refused —
 * definitely not processed. `PENDING` is the one Nexa may resolve itself (cancel the customer's
 * OWN pending invoice and retry the create once); the other three name an invoice that cannot
 * be cancelled, so the customer is shown that invoice and its next step instead.
 */
export const TONPAYS_TELEGRAM_BUYER_CONFLICT_ERROR_CODES: readonly TonPaysTelegramErrorCode[] = [
  'BUYER_HAS_PENDING_INVOICE',
  'BUYER_HAS_PROCESSING_INVOICE',
  'BUYER_HAS_NEED_ACTION_LESS',
  'BUYER_HAS_NEED_ACTION_MORE',
];

/** Round 6: a cancel the provider refused because the invoice is no longer `pending`. */
export const TONPAYS_TELEGRAM_CANCEL_REFUSAL_ERROR_CODES: readonly TonPaysTelegramErrorCode[] = [
  'CANCEL_NOT_ALLOWED_PROCESSING',
  'CANCEL_NOT_ALLOWED_NEED_ACTION_LESS',
  'CANCEL_NOT_ALLOWED_NEED_ACTION_MORE',
  'NOT_PENDING',
];

/** Round 6: a refund the provider refused. */
export const TONPAYS_TELEGRAM_REFUND_REFUSAL_ERROR_CODES: readonly TonPaysTelegramErrorCode[] = [
  'REFUND_NOT_ALLOWED',
  'INVALID_REFUND_CARD',
  'INVALID_REFUND_HOLDER',
  'REFUND_ALREADY_OPEN',
];

/**
 * Round 6: a create is retried ONCE after the customer's own pending invoice was cancelled
 * to make room (`BUYER_HAS_PENDING_INVOICE`). The refusal is a readable 4xx — no invoice was
 * made — so the same order id may be sent again; a second such refusal is final.
 */
export const TONPAYS_TELEGRAM_BUYER_CONFLICT_RETRY_MAX = 1;

/** Round 6: the most `reject_reasons` kept and the longest one, after sanitising. */
export const TONPAYS_TELEGRAM_REJECT_REASONS_MAX = 10;
export const TONPAYS_TELEGRAM_REJECT_REASON_MAX_LENGTH = 200;

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
 * acknowledgement. About a hundred and thirteen calls over a whole review; the last inquiry
 * before the review deadline is scheduled fifteen seconds before it, as for the customer window.
 *
 * FIX-06 (batch 2026-10-10): every 30 s for the first ten minutes — the provider usually
 * decides a receipt soon after acknowledging it, and the customer is waiting — then 120 s to the
 * hour as before. The route's limit is still undocumented (`OQ-TPTG-10`), so this changes WHEN
 * the route's unchanged 15-a-minute inquiry budget is spent, never how much of it: one review
 * asks at most twice a minute, and scheduled asks may use 12 of the 15, the rest kept for a tap
 * or a webhook.
 */
export const TONPAYS_TELEGRAM_REVIEW_INQUIRY_CADENCE: readonly {
  readonly untilMs: number;
  readonly intervalMs: number;
}[] = [
  { untilMs: 600_000, intervalMs: 30_000 },
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

/**
 * Round 6: what the customer asked the PROVIDER to do for an invoice, as a request row the
 * gateway worker sends (never while Telegram waits).
 *
 * - `CANCEL` — `POST /{id}/cancel`; only a `pending` invoice can be cancelled.
 * - `REFUND` — `POST /{id}/refund` for an overpayment (`action_required_more`), with the
 *   customer's refund card; the provider decides the amount, Nexa sends none.
 */
export const GATEWAY_PROVIDER_REQUEST_KINDS = ['CANCEL', 'REFUND'] as const;
export type GatewayProviderRequestKind = (typeof GATEWAY_PROVIDER_REQUEST_KINDS)[number];

/**
 * The same six states, and the same rules, as `GATEWAY_CARD_CHANGE_STATES`: `SENT` is stamped
 * and committed BEFORE the call, a row reclaimed with the stamp set is `UNKNOWN` and is never
 * sent again, and only the provider's own `RATE_LIMIT_EXCEEDED` is `RATE_LIMITED`.
 */
export const GATEWAY_PROVIDER_REQUEST_STATES = [
  'REQUESTED',
  'SENT',
  'APPLIED',
  'REFUSED',
  'RATE_LIMITED',
  'UNKNOWN',
] as const;
export type GatewayProviderRequestState = (typeof GATEWAY_PROVIDER_REQUEST_STATES)[number];

/** Which next step an inquiry told the customer they owe: the rest of the money, or a refund card. */
export const GATEWAY_PROVIDER_NEED_KINDS = ['LESS', 'MORE'] as const;
export type GatewayProviderNeedKind = (typeof GATEWAY_PROVIDER_NEED_KINDS)[number];

/**
 * Round 6 (refund card, validated locally BEFORE anything is stored or sent): sixteen digits
 * (the provider's document shows `6037991234567890`, which does not pass Luhn, so no checksum
 * is applied) and a holder name of letters and spaces (`Ali Rezaei` in the document). The
 * provider validates again (`INVALID_REFUND_CARD`, `INVALID_REFUND_HOLDER`).
 */
export const REFUND_CARD_DIGITS = 16;
export const REFUND_HOLDER_MIN_LENGTH = 3;
export const REFUND_HOLDER_MAX_LENGTH = 64;

/** The ciphertext of a refund request's card and holder is wiped when its send is stamped. */
export const GATEWAY_REFUND_CARD_MASK_PREFIX_DIGITS = 6;
export const GATEWAY_REFUND_CARD_MASK_SUFFIX_DIGITS = 4;
