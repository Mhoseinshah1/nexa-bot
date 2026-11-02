import {
  GATEWAY_REFUND_CARD_MASK_PREFIX_DIGITS,
  GATEWAY_REFUND_CARD_MASK_SUFFIX_DIGITS,
  REFUND_CARD_DIGITS,
  REFUND_HOLDER_MAX_LENGTH,
  REFUND_HOLDER_MIN_LENGTH,
  TONPAYS_TELEGRAM_BUYER_CONFLICT_ERROR_CODES,
  TONPAYS_TELEGRAM_CANCEL_REFUSAL_ERROR_CODES,
  TONPAYS_TELEGRAM_CARD_CHANGE_COOLDOWN_SECONDS,
  TONPAYS_TELEGRAM_CONFIGURATION_ERROR_CODES,
  TONPAYS_TELEGRAM_INVOICE_ID_PATTERN,
  TONPAYS_TELEGRAM_RECEIPT_ERROR_CODES,
  TONPAYS_TELEGRAM_REJECT_REASONS_MAX,
  TONPAYS_TELEGRAM_REJECT_REASON_MAX_LENGTH,
  TONPAYS_TELEGRAM_REVIEW_INQUIRY_CADENCE,
  TONPAYS_TELEGRAM_STATUS_LESS,
  TONPAYS_TELEGRAM_STATUS_MORE,
  type GatewayProviderNeedKind,
  type PaymentGatewayProvider,
  type TemplateKey,
  type TonPaysTelegramErrorCode,
  type TonPaysTelegramReceiptMimeType,
} from '@nexa/contracts';
import type {
  GatewayCardChangeRecord,
  GatewayInvoiceRecord,
  GatewayProviderFacts,
  GatewayProviderRequestRecord,
  GatewayReceiptOutcome,
  GatewayReceiptSubmissionRecord,
} from '../application/gateway-invoice-ports.js';
import {
  CANCELLED_BY_CUSTOMER_STATUS,
  CANCELLED_BY_NEXA_STATUS,
  failureStatusOf,
} from './payment-failure-outcome.js';
import { classifyTonPaysError } from './tonpays.js';

/**
 * Round 11 A8: whether a create that ended `CREATE_FAILED` with `code` was the provider's own
 * readable rate-limit refusal on its last retry — no invoice was made, and the customer is told
 * the gateway is busy and may try again (`bot.payment.gateway_busy`), not that it is unavailable.
 * TonPays routes only: every other route keeps its own sentences.
 */
export function createEndedRateLimited(
  provider: PaymentGatewayProvider,
  code: string | null,
): boolean {
  if (code === null) return false;
  switch (provider) {
    case 'TONPAYS':
      return classifyTonPaysError(code) === 'RATE_LIMITED';
    case 'TONPAYS_TELEGRAM':
      return classifyTonPaysTelegramError(code) === 'RATE_LIMITED';
    default:
      return false;
  }
}

/**
 * The TonPays Telegram rules that decide anything, as pure functions
 * (`docs/tonpays-telegram-gateway-audit.md`). Pure for the reason `domain/tonpays.ts` gives:
 * a rule exercised only through a network and a database is a rule whose corners nobody
 * tests. `tests/unit/tonpays-telegram-adapter.test.ts` pins each.
 */

/**
 * Whether a receipt-upload answer is the provider's ACKNOWLEDGEMENT — the ONE thing that
 * may open the 24-hour provider review window (owner decision of 2026-10-01, audit §9.6.3 c).
 *
 * `ACCEPTED` AND (`receipt_received` is the JSON boolean `true`, OR the status is exactly
 * `processing`). Nothing else: not `UNKNOWN` (a timeout, a 5xx, an unreadable 2xx), not a
 * refusal, a rate limit or a not-found, not an `ACCEPTED` with neither signal, not the
 * string `"true"`, not a `paid` of any value — and never an INQUIRY reporting `processing`,
 * the customer's tap, a queued submission or a webhook, none of which reaches this function.
 * Whether `processing` can come without `receipt_received` is OQ-TPTG-18.
 */
export function receiptAcknowledged(outcome: GatewayReceiptOutcome): boolean {
  return (
    outcome.kind === 'ACCEPTED' &&
    (outcome.receiptReceived === true || outcome.status === 'processing')
  );
}

/** How a documented TonPays Telegram error code is handled (audit §11). */
export type TonPaysTelegramErrorClass =
  /** The merchant's own configuration; never presented as the customer's payment. */
  | 'CONFIGURATION'
  /** Definitely not processed; may be asked again later, bounded. */
  | 'RATE_LIMITED'
  /** An invoice may already exist under this order id. Never re-keyed. */
  | 'AMBIGUOUS'
  /** The invoice id is not known to the provider. Never read as paid or failed. */
  | 'NOT_FOUND'
  /** The provider refused the receipt IMAGE (type, size); another photo may be sent. */
  | 'RECEIPT_REFUSED'
  /** The provider refused this request; an undocumented code lands here, stored verbatim. */
  | 'REFUSED';

export function classifyTonPaysTelegramError(code: string): TonPaysTelegramErrorClass {
  if ((TONPAYS_TELEGRAM_CONFIGURATION_ERROR_CODES as readonly string[]).includes(code)) {
    return 'CONFIGURATION';
  }
  if ((TONPAYS_TELEGRAM_RECEIPT_ERROR_CODES as readonly string[]).includes(code)) {
    return 'RECEIPT_REFUSED';
  }
  switch (code) {
    case 'RATE_LIMIT_EXCEEDED':
      return 'RATE_LIMITED';
    case 'DUPLICATE_ORDER_ID':
      return 'AMBIGUOUS';
    case 'INVOICE_NOT_FOUND':
      return 'NOT_FOUND';
    default:
      return 'REFUSED';
  }
}

/**
 * Whether a provider-supplied invoice id may be placed in a URL PATH (audit §9.2): an
 * allow-list, never escaping alone. An id outside it is never sent anywhere.
 */
export function isSafeInvoiceId(invoiceId: string): boolean {
  return TONPAYS_TELEGRAM_INVOICE_ID_PATTERN.test(invoiceId);
}

/**
 * The image type a receipt's MAGIC BYTES say it is (`OQ-TPTG-07`): JPEG, PNG, WebP or GIF —
 * the four the provider's current document lists — or null. Never Telegram's declared type and
 * never a file name — both are claims.
 */
export function sniffReceiptImage(bytes: Uint8Array): TonPaysTelegramReceiptMimeType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((byte, index) => bytes[index] === byte)) {
    return 'image/png';
  }
  // WebP: `RIFF` <4-byte size> `WEBP`.
  const ascii = (from: number, text: string): boolean =>
    bytes.length >= from + text.length &&
    [...text].every((char, index) => bytes[from + index] === char.charCodeAt(0));
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  // GIF: `GIF87a` or `GIF89a`.
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  return null;
}

/** The file name a sniffed type travels under in the multipart part. */
export function receiptFileName(mimeType: TonPaysTelegramReceiptMimeType): string {
  switch (mimeType) {
    case 'image/png':
      return 'receipt.png';
    case 'image/webp':
      return 'receipt.webp';
    case 'image/gif':
      return 'receipt.gif';
    case 'image/jpeg':
      return 'receipt.jpg';
  }
}

/**
 * When the next background inquiry is due during a provider review (audit §9.6.5), after one
 * answered at `at`: thirty seconds for the first ten minutes (FIX-06), two minutes to the first
 * hour, ten until the sixth, thirty until the
 * end — and one last question fifteen seconds before the review deadline, so an approval in
 * the final minutes is not lost to the cadence. Null once nothing remains to ask for.
 */
export function reviewInquiryNextAt(
  reviewStartedAt: Date,
  reviewUntil: Date,
  at: Date,
  /** FIX-06: the step's deterministic jitter (`inquiry-schedule.ts`); none by default. */
  jitter: (ms: number) => number = (ms) => ms,
): Date | null {
  const since = at.getTime() - reviewStartedAt.getTime();
  const step =
    TONPAYS_TELEGRAM_REVIEW_INQUIRY_CADENCE.find((band) => since < band.untilMs)?.intervalMs ??
    TONPAYS_TELEGRAM_REVIEW_INQUIRY_CADENCE[TONPAYS_TELEGRAM_REVIEW_INQUIRY_CADENCE.length - 1]!
      .intervalMs;
  const next = new Date(at.getTime() + jitter(step));
  if (next.getTime() < reviewUntil.getTime() - 15_000) return next;
  const last = new Date(reviewUntil.getTime() - 15_000);
  return last.getTime() > at.getTime() ? last : null;
}

/**
 * R8 A2 (R5C-1): the owner's three limits on a card switch, as the TonPays card change reads
 * them — the same settings, and the same meaning, as the manual card-to-card switch
 * (`CARD_SWITCH_SETTING_KEYS`), with what this payment has already used of them.
 */
export interface CardChangeAllowance {
  readonly limits: {
    /** Most changes one payment may have. Zero: the button is never offered. */
    readonly maxSwitches: number;
    /** Seconds to wait after the last change. Zero: none. */
    readonly cooldownSeconds: number;
    /** Most DISTINCT cards one payment may show, the first included. */
    readonly maxDistinctCards: number;
  };
  /** Changes that may have changed the card: requested, sent, applied, or lost (UNKNOWN). */
  readonly switches: number;
  /** When the latest of those was requested; null when there is none. */
  readonly lastSwitchAt: Date | null;
  /** Distinct card numbers this payment has shown (`gateway_invoice_cards`). */
  readonly distinctCards: number;
}

/**
 * Whether the customer may ask for another card (audit §8.1, §8.2), and if not, whether only
 * for now.
 *
 * - `UNAVAILABLE`: not now and not by waiting — the provider has not said yes (`show_change_card`
 *   false, exhausted, an under- or overpaid invoice, an invoice not created), a request is
 *   already in flight, or the owner's switch or distinct-card limit is used up. TonPays picks
 *   the next card itself, so a change once the distinct-card limit is reached could show a
 *   card the owner did not allow: refused.
 * - `COOLDOWN`: allowed, after `retryAfterSeconds` — the provider's stated cooldown, else sixty
 *   seconds from the card last shown (or from the last lost change, whose card is hidden), and
 *   the owner's cooldown from the last change, whichever ends last.
 * - `AVAILABLE`: now.
 *
 * The button is DRAWN for `COOLDOWN` as well as `AVAILABLE` (R8 A2: the invoice is drawn the
 * moment its card arrives, so a button hidden for the first minute was never seen); the tap
 * re-decides this under the payment's lock and answers a cooldown with the seconds left.
 * `allowance` null applies the provider's rules alone.
 */
export type CardChangeDecision =
  | { readonly kind: 'AVAILABLE' }
  | { readonly kind: 'COOLDOWN'; readonly retryAfterSeconds: number }
  | { readonly kind: 'UNAVAILABLE' };

type CardChangeInvoiceFacts = Pick<
  GatewayInvoiceRecord,
  | 'cardChangeShown'
  | 'cardChangeExhausted'
  | 'cardChangeCooldownUntil'
  | 'cardReceivedAt'
  | 'creationState'
> & { readonly providerStatus?: string | null };

type CardChangeLatest = Pick<GatewayCardChangeRecord, 'state' | 'requestedAt' | 'decidedAt'> | null;

export function decideCardChange(
  invoice: CardChangeInvoiceFacts,
  latest: CardChangeLatest,
  now: Date,
  allowance: CardChangeAllowance | null = null,
): CardChangeDecision {
  const unavailable = { kind: 'UNAVAILABLE' } as const;
  if (invoice.creationState !== 'CREATED') return unavailable;
  // Round 6: an invoice that was under- or overpaid has a next step of its own; another card
  // for the ORIGINAL transfer is not it.
  if (invoice.providerStatus === TONPAYS_TELEGRAM_STATUS_LESS) return unavailable;
  if (invoice.providerStatus === TONPAYS_TELEGRAM_STATUS_MORE) return unavailable;
  if (invoice.cardChangeShown === false || invoice.cardChangeExhausted === true) {
    return unavailable;
  }
  if (latest !== null && (latest.state === 'REQUESTED' || latest.state === 'SENT')) {
    return unavailable;
  }
  if (allowance !== null) {
    if (allowance.switches >= allowance.limits.maxSwitches) return unavailable;
    if (allowance.distinctCards >= allowance.limits.maxDistinctCards) return unavailable;
  }
  const readyAt: number[] = [];
  if (invoice.cardChangeCooldownUntil !== null) {
    readyAt.push(invoice.cardChangeCooldownUntil.getTime());
  }
  const localFrom =
    latest !== null && latest.state === 'UNKNOWN'
      ? (latest.decidedAt ?? latest.requestedAt)
      : invoice.cardReceivedAt;
  if (localFrom !== null) {
    readyAt.push(localFrom.getTime() + TONPAYS_TELEGRAM_CARD_CHANGE_COOLDOWN_SECONDS * 1000);
  }
  if (
    allowance !== null &&
    allowance.lastSwitchAt !== null &&
    allowance.limits.cooldownSeconds > 0
  ) {
    readyAt.push(allowance.lastSwitchAt.getTime() + allowance.limits.cooldownSeconds * 1000);
  }
  const remainingMs = Math.max(0, ...readyAt.map((at) => at - now.getTime()));
  return remainingMs > 0
    ? { kind: 'COOLDOWN', retryAfterSeconds: Math.ceil(remainingMs / 1000) }
    : { kind: 'AVAILABLE' };
}

/** Whether the customer may ask for another card NOW (`decideCardChange` is `AVAILABLE`). */
export function cardChangeAvailable(
  invoice: CardChangeInvoiceFacts,
  latest: CardChangeLatest,
  now: Date,
  allowance: CardChangeAllowance | null = null,
): boolean {
  return decideCardChange(invoice, latest, now, allowance).kind === 'AVAILABLE';
}

/** Whether «🔄 تعویض کارت» is DRAWN: available now, or after a cooldown the tap explains. */
export function cardChangeOffered(
  invoice: CardChangeInvoiceFacts,
  latest: CardChangeLatest,
  now: Date,
  allowance: CardChangeAllowance | null = null,
): boolean {
  return decideCardChange(invoice, latest, now, allowance).kind !== 'UNAVAILABLE';
}

/**
 * Whether the customer may send a receipt NOW (audit §8.3): nothing in flight, no unresolved
 * lost upload, the provider's last word is `pending` (or it has said nothing yet), and no
 * review has started — the customer window itself is checked by the caller against the
 * payment row under its lock.
 */
export function receiptUploadAvailable(
  invoice: Pick<GatewayInvoiceRecord, 'providerStatus' | 'creationState'>,
  submissions: readonly Pick<GatewayReceiptSubmissionRecord, 'state' | 'inquiryResolvedAt'>[],
): boolean {
  if (invoice.creationState !== 'CREATED') return false;
  if (invoice.providerStatus !== null && invoice.providerStatus !== 'pending') return false;
  return !submissions.some(
    (one) =>
      one.state === 'QUEUED' ||
      one.state === 'SENDING' ||
      (one.state === 'UNKNOWN' && one.inquiryResolvedAt === null),
  );
}

// ---------------------------------------------------------------------------------------
// Round 6: underpayment, overpayment, cancel, refund, a buyer who already holds an invoice.
// Every function below is pure, and none of them decides whether money counts — only the
// inquiry's `completed` + `paid === true` does (`tonpaysVerdict`).
// ---------------------------------------------------------------------------------------

/** The next step an inquiry's STATUS names, or null for any other status (including unknown). */
export function providerNeedOfStatus(status: string): GatewayProviderNeedKind | null {
  if (status === TONPAYS_TELEGRAM_STATUS_LESS) return 'LESS';
  if (status === TONPAYS_TELEGRAM_STATUS_MORE) return 'MORE';
  return null;
}

/**
 * R9 C1: whether the inquiry's `need_action_kind` (document p. 14/17: `less` / `more`) agrees
 * with the next step its STATUS names. The status decides which next step it is — it is the
 * documented field the rest of the route keys on — and the kind is read as a CROSS-CHECK:
 * absent or null says nothing; any other value (a different kind, a word nobody documented,
 * a non-string) means the answer contradicts itself, and none of its remainder or refund
 * details is trusted (no card, no amount, no remainder invoice). Nothing here approves.
 *
 * `status: need_action` (the older transcription) with a kind is NOT read as a next step:
 * the current document names `action_required_less` / `_more` for that, and what the
 * combination would mean is undocumented (`OQ-TPTG-27`). It stays an open status.
 */
export function needActionKindAgrees(need: GatewayProviderNeedKind | null, kind: unknown): boolean {
  if (need === null || kind === undefined || kind === null) return true;
  if (typeof kind !== 'string') return false;
  return kind.trim().toLowerCase() === (need === 'LESS' ? 'less' : 'more');
}

/** Whether a create refusal is the provider saying the buyer already holds an open invoice. */
export function isBuyerConflictCode(code: string | null): boolean {
  return (
    code !== null &&
    (TONPAYS_TELEGRAM_BUYER_CONFLICT_ERROR_CODES as readonly string[]).includes(code)
  );
}

/**
 * Whether a create that the provider refused with `BUYER_HAS_PENDING_INVOICE` may be tried
 * once more after the customer's own pending invoice was cancelled. Only that code, and only
 * when the attempt's previous refusal was not already that code — `TONPAYS_TELEGRAM_BUYER_
 * CONFLICT_RETRY_MAX` is one. The refusal is a readable 4xx saying no invoice was made, so
 * the same order id is sent again; any other refusal, and a second of this one, is final.
 */
export function buyerConflictRetryAllowed(
  code: string,
  previousCreationErrorCode: string | null,
): boolean {
  return code === 'BUYER_HAS_PENDING_INVOICE' && previousCreationErrorCode !== code;
}

/** Whether a cancel refusal is one of the provider's "not pending any more" answers. */
export function isCancelRefusalCode(code: string | null): boolean {
  return (
    code !== null &&
    (TONPAYS_TELEGRAM_CANCEL_REFUSAL_ERROR_CODES as readonly string[]).includes(code)
  );
}

/**
 * The customer-facing template for each documented error code (Round 6 item 4): every code in
 * `TONPAYS_TELEGRAM_ERROR_CODES` has a Persian message, and a unit test pins that none is
 * missing. A configuration code is the MERCHANT's problem and says the method is unavailable;
 * the rest say what the customer can do. A code the documentation does not name has no entry
 * and is shown the generic "unavailable" sentence by the caller — never its raw text.
 */
export const TONPAYS_TELEGRAM_ERROR_TEMPLATES: Readonly<
  Record<TonPaysTelegramErrorCode, TemplateKey>
> = {
  WRONG_API_KEY_KIND: 'bot.payment.gateway_unavailable',
  GATEWAY_NOT_APPROVED: 'bot.payment.gateway_unavailable',
  MISSING_API_KEY: 'bot.payment.gateway_unavailable',
  INVALID_API_KEY: 'bot.payment.gateway_unavailable',
  DUPLICATE_ORDER_ID: 'bot.payment.gateway_unknown',
  INVALID_RECEIPT_TYPE: 'bot.payment.gateway_card_receipt_refused',
  RECEIPT_TOO_LARGE: 'bot.payment.gateway_receipt_too_large',
  RATE_LIMIT_EXCEEDED: 'bot.payment.gateway_unavailable',
  INVOICE_NOT_FOUND: 'bot.payment.gateway_closed',
  INVOICE_ID_MISMATCH: 'bot.payment.gateway_card_receipt_invoice',
  NOT_PENDING: 'bot.payment.gateway_not_pending',
  REMAINDER_INVOICE_MISSING: 'bot.payment.gateway_card_receipt_invoice',
  EMPTY_RECEIPT: 'bot.payment.gateway_card_receipt_empty',
  CANCEL_NOT_ALLOWED_PROCESSING: 'bot.payment.gateway_cancel_not_allowed_processing',
  CANCEL_NOT_ALLOWED_NEED_ACTION_LESS: 'bot.payment.gateway_cancel_not_allowed_less',
  CANCEL_NOT_ALLOWED_NEED_ACTION_MORE: 'bot.payment.gateway_cancel_not_allowed_more',
  BUYER_HAS_PENDING_INVOICE: 'bot.payment.gateway_buyer_pending',
  BUYER_HAS_PROCESSING_INVOICE: 'bot.payment.gateway_buyer_processing',
  BUYER_HAS_NEED_ACTION_LESS: 'bot.payment.gateway_buyer_less',
  BUYER_HAS_NEED_ACTION_MORE: 'bot.payment.gateway_buyer_more',
  REFUND_NOT_ALLOWED: 'bot.payment.gateway_refund_not_allowed',
  INVALID_REFUND_CARD: 'bot.payment.gateway_refund_card_refused',
  INVALID_REFUND_HOLDER: 'bot.payment.gateway_refund_holder_refused',
  REFUND_ALREADY_OPEN: 'bot.payment.gateway_refund_already_open',
};

/** The Persian message for a stored provider error code, or null when it is not a documented one. */
export function customerMessageKeyOfError(code: string | null): TemplateKey | null {
  if (code === null) return null;
  return (TONPAYS_TELEGRAM_ERROR_TEMPLATES as Readonly<Record<string, TemplateKey>>)[code] ?? null;
}

// --- reject reasons -----------------------------------------------------------------------

/**
 * `reject_reasons` as the provider sent them, made safe to store and to show. The shape is not
 * in the supplied documentation (`OQ-TPTG-21`), so this reads the three it plausibly is — an
 * array of strings, an array of objects carrying a text field, or one string — and treats
 * anything else as NO INFORMATION (an empty list), never as a reason and never as an error.
 * Each reason has control characters and markup brackets removed, whitespace collapsed, and is
 * cut at the bound; the list is deduplicated and capped.
 */
export function parseRejectReasons(raw: unknown): readonly string[] {
  const items: unknown[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const out: string[] = [];
  for (const item of items.slice(0, TONPAYS_TELEGRAM_REJECT_REASONS_MAX * 2)) {
    let text: unknown = item;
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      text = record['message'] ?? record['text'] ?? record['reason'] ?? record['code'];
    }
    if (typeof text !== 'string') continue;
    const clean = text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    if (clean.length === 0) continue;
    const bounded = Array.from(clean).slice(0, TONPAYS_TELEGRAM_REJECT_REASON_MAX_LENGTH).join('');
    if (!out.includes(bounded)) out.push(bounded);
    if (out.length >= TONPAYS_TELEGRAM_REJECT_REASONS_MAX) break;
  }
  return out;
}

/**
 * A reason that is a MACHINE token (`low_balance`, `RECEIPT_UNREADABLE`) and not prose: the
 * only kind the payment history may carry, because its entries hold no free text.
 */
export function rejectReasonCodes(reasons: readonly string[]): readonly string[] {
  return reasons.filter((one) => /^[A-Za-z0-9_.:-]{1,64}$/u.test(one));
}

// --- the refund card ----------------------------------------------------------------------

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** ASCII digits for a Persian or Arabic-Indic digit, every other character unchanged. */
export function asciiDigits(text: string): string {
  return Array.from(text)
    .map((char) => {
      const persian = PERSIAN_DIGITS.indexOf(char);
      if (persian >= 0) return String(persian);
      const arabic = ARABIC_DIGITS.indexOf(char);
      return arabic >= 0 ? String(arabic) : char;
    })
    .join('');
}

export interface RefundCardInput {
  /** Sixteen ASCII digits. Held in memory for one sealing and never logged. */
  readonly cardNumber: string;
  readonly cardHolder: string;
}

/**
 * The customer's two-line answer — the card number, then the holder — validated locally
 * (Round 6 item 2). Null when it is not exactly that: two non-empty lines, a sixteen-digit
 * number (spaces and hyphens inside it tolerated, Persian digits read) and a
 * holder of three to sixty-four letters and spaces with no digit in it.
 */
export function parseRefundCardInput(text: string): RefundCardInput | null {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 2) return null;
  const numberText = asciiDigits(lines[0]!).replace(/[\s-]/gu, '');
  if (!/^\d{16}$/u.test(numberText) || numberText.length !== REFUND_CARD_DIGITS) return null;
  const holder = lines[1]!.replace(/\s+/gu, ' ');
  const length = Array.from(holder).length;
  if (length < REFUND_HOLDER_MIN_LENGTH || length > REFUND_HOLDER_MAX_LENGTH) return null;
  if (!/^[\p{L}\p{M}‌ ]+$/u.test(holder)) return null;
  if (Array.from(holder).filter((char) => /\p{L}/u.test(char)).length < 2) return null;
  return { cardNumber: numberText, cardHolder: holder };
}

/**
 * The only form of a refund card that is ever stored or shown: the first six and last four
 * digits, the rest hidden. A number of any other length is hidden whole.
 */
export function maskRefundCard(cardNumber: string): string {
  if (!/^\d+$/u.test(cardNumber) || cardNumber.length !== REFUND_CARD_DIGITS) return '****';
  const hidden =
    cardNumber.length -
    GATEWAY_REFUND_CARD_MASK_PREFIX_DIGITS -
    GATEWAY_REFUND_CARD_MASK_SUFFIX_DIGITS;
  return (
    cardNumber.slice(0, GATEWAY_REFUND_CARD_MASK_PREFIX_DIGITS) +
    '*'.repeat(hidden) +
    cardNumber.slice(-GATEWAY_REFUND_CARD_MASK_SUFFIX_DIGITS)
  );
}

// --- what the customer may do now ---------------------------------------------------------

const inFlight = (state: string): boolean => state === 'REQUESTED' || state === 'SENT';

/** A receipt submission still on its way, or lost and not yet resolved by an inquiry. */
function receiptBusy(
  submissions: readonly Pick<GatewayReceiptSubmissionRecord, 'state' | 'inquiryResolvedAt'>[],
): boolean {
  return submissions.some(
    (one) =>
      one.state === 'QUEUED' ||
      one.state === 'SENDING' ||
      (one.state === 'UNKNOWN' && one.inquiryResolvedAt === null),
  );
}

/**
 * Whether «❌ لغو فاکتور» may be drawn and accepted NOW. Only a `pending` invoice can be
 * cancelled (the provider says so, and Nexa does not ask for what it knows will be refused):
 * created, the provider's last word `pending` or none, not reported paid, no review started, no
 * cancel in flight or already applied, no receipt on its way — a receipt moves the invoice to
 * `processing`, where a cancel is refused. The customer window itself is checked by the caller
 * under the payment's lock.
 *
 * R11 A8 (owner): a cancel whose answer was LOST (`UNKNOWN`: a timeout, a 5xx, a bare 429) or
 * that the provider rate-limited does NOT count as cancelled. While the invoice is still open as
 * far as Nexa knows, the customer may ask again — a NEW request row, never Nexa repeating the
 * lost one by itself (`cancelRetryNotBefore` spaces it; the in-flight index keeps one at a time;
 * the provider refuses a second cancel of a cancelled invoice, and only the inquiry decides).
 */
export function cancelAvailable(
  invoice: Pick<GatewayInvoiceRecord, 'providerStatus' | 'creationState' | 'providerInvoiceId'> &
    Partial<Pick<GatewayInvoiceRecord, 'providerPaid'>>,
  latestCancel: Pick<GatewayProviderRequestRecord, 'state'> | null,
  submissions: readonly Pick<GatewayReceiptSubmissionRecord, 'state' | 'inquiryResolvedAt'>[],
): boolean {
  if (invoice.creationState !== 'CREATED' || invoice.providerInvoiceId === null) return false;
  if (invoice.providerStatus !== null && invoice.providerStatus !== 'pending') return false;
  // Paid is never cancelled, whatever the status field says.
  if (invoice.providerPaid === true) return false;
  if (latestCancel !== null && inFlight(latestCancel.state)) return false;
  // The provider cancelled it: there is nothing left to cancel.
  if (latestCancel !== null && latestCancel.state === 'APPLIED') return false;
  return !receiptBusy(submissions) && !submissions.some((one) => one.state === 'ACCEPTED');
}

/**
 * R11 A8: the spacing between a cancel that did not go through as asked (its answer lost, or
 * the provider's own rate limit) and the customer's next one. Not a limiter — the TonPays client
 * paces every call per credential — only the reason a retry tapped at once is not sent into the
 * same trouble a second later.
 */
export const CANCEL_RETRY_BACKOFF_SECONDS = 30;

/**
 * R11 A8: when a customer's NEW cancel request may first be sent, written as the row's
 * `claimed_until` so the worker leaves it until then; null when it may go at once. Only after a
 * lost (`UNKNOWN`) or rate-limited previous cancel, counted from when that one was decided.
 */
export function cancelRetryNotBefore(
  previous: Pick<GatewayProviderRequestRecord, 'state' | 'decidedAt' | 'requestedAt'> | null,
  now: Date,
): Date | null {
  if (previous === null) return null;
  if (previous.state !== 'UNKNOWN' && previous.state !== 'RATE_LIMITED') return null;
  const from = (previous.decidedAt ?? previous.requestedAt).getTime();
  const at = from + CANCEL_RETRY_BACKOFF_SECONDS * 1000;
  return at > now.getTime() ? new Date(at) : null;
}

/**
 * R11 A8: what a tap on a cancel button that may no longer be offered says, when it has
 * something better to say than redrawing the screen:
 *
 * - `PAID`: the payment is CONFIRMED, or the provider reported the invoice paid — refused,
 *   never cancelled, and nothing moves (`bot.payment.gateway_not_pending`).
 * - `ALREADY_CANCELLED`: Nexa KNOWS the invoice was cancelled — a cancel the provider applied,
 *   an inquiry that read `canceled`, or the payment failed as cancelled («فاکتور قبلاً لغو شده»).
 *   A cancel whose answer was lost is not knowledge: it is not cancelled.
 * - null: anything else; the caller redraws the attempt as it stands.
 */
export function cancelTapRefusal(
  payment: { readonly state: string; readonly resolutionNote: string | null },
  invoice: Pick<GatewayInvoiceRecord, 'providerStatus'> &
    Partial<Pick<GatewayInvoiceRecord, 'providerPaid'>>,
  latestCancel: Pick<GatewayProviderRequestRecord, 'state'> | null,
): 'PAID' | 'ALREADY_CANCELLED' | null {
  if (payment.state === 'CONFIRMED' || invoice.providerPaid === true) return 'PAID';
  if (latestCancel !== null && latestCancel.state === 'APPLIED') return 'ALREADY_CANCELLED';
  if (invoice.providerStatus === 'canceled') return 'ALREADY_CANCELLED';
  if (payment.state === 'FAILED') {
    const status = failureStatusOf(payment.resolutionNote);
    if (
      status === CANCELLED_BY_CUSTOMER_STATUS ||
      status === CANCELLED_BY_NEXA_STATUS ||
      status === 'canceled'
    ) {
      return 'ALREADY_CANCELLED';
    }
  }
  return null;
}

/**
 * Whether a receipt for the REMAINDER may be sent NOW: the provider reports an underpayment
 * and a remainder invoice, has not said it already has the remainder's receipt, and no upload
 * is on its way. (The ordinary receipt button is for a `pending` invoice only.)
 */
export function remainderReceiptAvailable(
  invoice: Pick<GatewayInvoiceRecord, 'providerStatus' | 'creationState'>,
  facts: Pick<
    GatewayProviderFacts,
    'need' | 'remainingInvoiceId' | 'remainingReceiptReceived'
  > | null,
  submissions: readonly Pick<GatewayReceiptSubmissionRecord, 'state' | 'inquiryResolvedAt'>[],
): boolean {
  if (invoice.creationState !== 'CREATED') return false;
  if (invoice.providerStatus !== TONPAYS_TELEGRAM_STATUS_LESS) return false;
  if (facts === null || facts.need !== 'LESS' || facts.remainingInvoiceId === null) return false;
  if (facts.remainingReceiptReceived === true) return false;
  return !receiptBusy(submissions);
}

/**
 * Whether the refund-card button may be drawn and accepted NOW: the provider reports an
 * overpayment, a refund is not already pending, and none of ours is in flight. After a
 * refusal or a lost answer the customer may register again — a new, explicit request, never
 * an automatic one; the provider's `REFUND_ALREADY_OPEN` guards a double.
 */
export function refundCardAvailable(
  invoice: Pick<GatewayInvoiceRecord, 'providerStatus' | 'creationState'>,
  facts: Pick<GatewayProviderFacts, 'need' | 'refundPending'> | null,
  latestRefund: Pick<GatewayProviderRequestRecord, 'state' | 'errorCode'> | null,
): boolean {
  if (invoice.creationState !== 'CREATED') return false;
  if (invoice.providerStatus !== TONPAYS_TELEGRAM_STATUS_MORE) return false;
  if (facts === null || facts.need !== 'MORE' || facts.refundPending === true) return false;
  if (latestRefund === null) return true;
  if (inFlight(latestRefund.state)) return false;
  // A refund the provider already holds, or one it will not make, is not asked for again.
  if (latestRefund.state === 'APPLIED') return false;
  if (
    latestRefund.errorCode === 'REFUND_ALREADY_OPEN' ||
    latestRefund.errorCode === 'REFUND_NOT_ALLOWED'
  ) {
    return false;
  }
  return true;
}
