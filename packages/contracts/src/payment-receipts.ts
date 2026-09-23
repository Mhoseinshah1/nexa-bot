/**
 * The proof a customer offers that they made a transfer.
 *
 * ## What this reverses, and what it does not
 *
 * Owner revision 17 said a payment receipt is not stored, archived or displayed. The
 * Payment UX addendum received during Phase 5A reverses that half: the invoice's action
 * button starts a receipt-submission flow for that exact payment, and the customer is
 * asked to upload an image or a file.
 *
 * It does NOT reverse the review model, and the addendum says so itself — *"settlement
 * still requires the existing authorized operator confirmation"*. So
 * `PAYMENT_EVIDENCE_KINDS` stays `OPERATOR_REVIEW`, an upload confirms nothing, and a
 * receipt is what a reviewer LOOKS at rather than what a payment rests on. `OQ-4C-03`
 * carries the full record.
 *
 * ## Where the bytes live
 *
 * At Telegram. This installation stores the BINDING — which tenant, which bot, which
 * customer, which payment — and the two identifiers Telegram gives it; the Web Admin
 * fetches the image through the API, which holds the bot token.
 *
 * That is a real limitation and it is written down rather than discovered: a backup
 * carries the binding and not the image, and a revoked bot token makes an old file
 * unfetchable. The alternative is a blob store this deployment does not have, and
 * inventing one to avoid writing this paragraph would be the worse trade.
 */

/**
 * What a customer can send that counts as a receipt.
 *
 * Two, and the list is closed. A photo is what most customers send; a document is what a
 * banking app's PDF export produces. Everything else a Telegram message can carry — a
 * voice note, a location, a contact, a sticker — is NOT a receipt, and the routing
 * treats it exactly as it treats any other message it does not understand.
 */
export const PAYMENT_RECEIPT_KINDS = ['PHOTO', 'DOCUMENT'] as const;
export type PaymentReceiptKind = (typeof PAYMENT_RECEIPT_KINDS)[number];

/**
 * How long the window to upload stays open, from the tap.
 *
 * Bounded by the PAYMENT's own deadline as well, and whichever is sooner wins: a window
 * outliving the payment it belongs to would accept evidence for something already
 * expired, which is a receipt an operator cannot act on.
 *
 * Thirty minutes because that is roughly how long it takes to open a banking app, make a
 * transfer, screenshot it and come back — the same reasoning
 * `PAYMENT_WINDOW_MINUTES_MIN` uses from the other end.
 */
export const RECEIPT_CAPTURE_MINUTES = 30;

/**
 * How many receipts one payment may hold.
 *
 * A rail rather than a policy. A customer who sends a blurred screenshot and then a
 * clear one is doing something ordinary and both belong to the reviewer; a client
 * looping on the upload is not, and without a bound it would write rows until the
 * window closed.
 */
export const PAYMENT_RECEIPT_MAX_PER_PAYMENT = 5;

/**
 * Why a capture window is no longer open.
 *
 * `closed_at` alone would answer "not open" and not "what happened", and the three cases
 * send an operator to different places.
 *
 * - `RECEIVED` — the window did its job: the payment now holds every receipt it may
 *   hold. NOT stamped by the first file. A customer who sends a blurred screenshot and
 *   then a clear one is doing something ordinary, and closing on the first arrival would
 *   answer the second with "nothing was expected" — which is the refusal for a file
 *   nobody asked for, and would be a lie here. So the window stays open until
 *   `PAYMENT_RECEIPT_MAX_PER_PAYMENT` is reached, and the bound is what closes it.
 * - `SUPERSEDED` — the customer opened a window on a different payment. Their doing,
 *   which is why it is not `EXPIRED`.
 * - `EXPIRED` — the deadline passed. Stamped when a late file arrives, so the row says
 *   what happened rather than merely no longer matching an open-window query.
 */
export const RECEIPT_CAPTURE_CLOSE_REASONS = ['RECEIVED', 'SUPERSEDED', 'EXPIRED'] as const;
export type ReceiptCaptureCloseReason = (typeof RECEIPT_CAPTURE_CLOSE_REASONS)[number];

/**
 * The largest receipt this installation will download from Telegram.
 *
 * A BOUND on what one reviewer's click can pull into the API process, not a limit on
 * what a customer may send: Telegram accepts photos up to 10 MB and documents far
 * larger, and a `getFile` on a 2 GB document would be answered by reading 2 GB into
 * memory to hand to a browser. Twenty megabytes is well above any screenshot or
 * banking-app PDF and well below what an operator clicking twice could do to the
 * process.
 *
 * Checked TWICE, and the second time is the one that matters: against Telegram's
 * declared `file_size` before the download starts, and against the bytes actually
 * received — because a declared size is a claim and the stream is the fact.
 */
export const PAYMENT_RECEIPT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * The bound on the customer's own caption stored beside a receipt (Payment File 02 §10,
 * `docs/payments-file02-design.md` D3).
 *
 * Telegram's own limit on a media caption, so a caption Telegram delivered always fits.
 * Stored trimmed; an empty caption is stored as no caption. It is customer text: it is
 * rendered into the reviewer's caption and nowhere else, and never logged.
 */
export const RECEIPT_CAPTION_MAX_LENGTH = 1024;

/**
 * A receipt caption as it is stored: trimmed, empty as null, and bounded to
 * `RECEIPT_CAPTION_MAX_LENGTH` CODE POINTS.
 *
 * Code points rather than `String.length`, because `payment_receipts_caption_check`
 * measures with PostgreSQL's `length`, which counts characters, and slicing UTF-16 units
 * could split a surrogate pair. Anything that is not a string is no caption.
 */
export function normalizeReceiptCaption(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const points = Array.from(trimmed);
  return points.length <= RECEIPT_CAPTION_MAX_LENGTH
    ? trimmed
    : points.slice(0, RECEIPT_CAPTION_MAX_LENGTH).join('').trimEnd();
}

/**
 * One receipt, as a reviewer sees it listed.
 *
 * `fileId` is deliberately ABSENT. It is what `getFile` takes, it is bot-scoped, and
 * handing it to a browser would let anything that achieved script execution on the admin
 * page fetch the file directly from Telegram with the installation's own bot. The Web
 * Admin asks this API for the bytes by RECEIPT id and the API holds the token, which is
 * the same rule `bot_instance.bot_token` has had since Phase 0.
 */
export interface PaymentReceiptView {
  readonly id: string;
  readonly kind: PaymentReceiptKind;
  /** Stable across re-sends of the same file. What the dedupe is keyed on. */
  readonly fileUniqueId: string;
  readonly mimeType: string | null;
  readonly fileSize: number | null;
  readonly fileName: string | null;
  readonly createdAt: string;
}
