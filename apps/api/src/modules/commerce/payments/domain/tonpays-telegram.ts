import {
  TONPAYS_TELEGRAM_CARD_CHANGE_COOLDOWN_SECONDS,
  TONPAYS_TELEGRAM_CONFIGURATION_ERROR_CODES,
  TONPAYS_TELEGRAM_INVOICE_ID_PATTERN,
  TONPAYS_TELEGRAM_RECEIPT_ERROR_CODES,
  TONPAYS_TELEGRAM_REVIEW_INQUIRY_CADENCE,
  type TonPaysTelegramReceiptMimeType,
} from '@nexa/contracts';
import type {
  GatewayCardChangeRecord,
  GatewayInvoiceRecord,
  GatewayReceiptOutcome,
  GatewayReceiptSubmissionRecord,
} from '../application/gateway-invoice-ports.js';

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
 * The image type a receipt's MAGIC BYTES say it is (`OQ-TPTG-07`): JPEG or PNG, or null.
 * Never Telegram's declared type and never a file name — both are claims.
 */
export function sniffReceiptImage(bytes: Uint8Array): TonPaysTelegramReceiptMimeType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((byte, index) => bytes[index] === byte)) {
    return 'image/png';
  }
  return null;
}

/**
 * When the next background inquiry is due during a provider review (audit §9.6.5), after one
 * answered at `at`: two minutes for the first hour, ten until the sixth, thirty until the
 * end — and one last question fifteen seconds before the review deadline, so an approval in
 * the final minutes is not lost to the cadence. Null once nothing remains to ask for.
 */
export function reviewInquiryNextAt(
  reviewStartedAt: Date,
  reviewUntil: Date,
  at: Date,
): Date | null {
  const since = at.getTime() - reviewStartedAt.getTime();
  const step =
    TONPAYS_TELEGRAM_REVIEW_INQUIRY_CADENCE.find((band) => since < band.untilMs)?.intervalMs ??
    TONPAYS_TELEGRAM_REVIEW_INQUIRY_CADENCE[TONPAYS_TELEGRAM_REVIEW_INQUIRY_CADENCE.length - 1]!
      .intervalMs;
  const next = new Date(at.getTime() + step);
  if (next.getTime() < reviewUntil.getTime() - 15_000) return next;
  const last = new Date(reviewUntil.getTime() - 15_000);
  return last.getTime() > at.getTime() ? last : null;
}

/**
 * Whether the customer may ask for another card NOW (audit §8.1, §8.2): the provider has not
 * said no or exhausted, no request is in flight, and the cooldown has passed — the
 * provider's own when it stated one, else sixty seconds from the card last shown (or from
 * the last lost change, whose card is hidden). The tap re-decides this against the row.
 */
export function cardChangeAvailable(
  invoice: Pick<
    GatewayInvoiceRecord,
    | 'cardChangeShown'
    | 'cardChangeExhausted'
    | 'cardChangeCooldownUntil'
    | 'cardReceivedAt'
    | 'creationState'
  >,
  latest: Pick<GatewayCardChangeRecord, 'state' | 'requestedAt' | 'decidedAt'> | null,
  now: Date,
): boolean {
  if (invoice.creationState !== 'CREATED') return false;
  if (invoice.cardChangeShown === false || invoice.cardChangeExhausted === true) return false;
  if (latest !== null && (latest.state === 'REQUESTED' || latest.state === 'SENT')) return false;
  if (invoice.cardChangeCooldownUntil !== null && now < invoice.cardChangeCooldownUntil) {
    return false;
  }
  const localFrom =
    latest !== null && latest.state === 'UNKNOWN'
      ? (latest.decidedAt ?? latest.requestedAt)
      : invoice.cardReceivedAt;
  if (
    localFrom !== null &&
    now.getTime() < localFrom.getTime() + TONPAYS_TELEGRAM_CARD_CHANGE_COOLDOWN_SECONDS * 1000
  ) {
    return false;
  }
  return true;
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
