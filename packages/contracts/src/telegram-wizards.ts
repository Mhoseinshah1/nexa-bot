/**
 * R2 (v0.3.5 real-test items 3–5): the vocabulary of the Telegram messages this installation
 * EDITS IN PLACE rather than answering with a new message per step.
 *
 * Two kinds of message are tracked, and each is pinned by a CHECK constraint:
 *
 *   - a customer's WIZARD message — the purchase or the wallet top-up — whose one Telegram
 *     message evolves from step to step (`telegram_wizards`);
 *   - an administrator's RECEIPT REVIEW message, and the prompts a decision opens from it,
 *     which are edited into the decision's result once it is taken (`telegram_review_messages`).
 *
 * Presentation state, never business state: an order, a payment and a capture decide what
 * may happen, and these rows only decide WHICH MESSAGE shows it and whether a tapped button
 * still belongs to the screen that message shows.
 */

/**
 * Which flow a wizard message belongs to.
 *
 * - `ORDER` — buying: category, product, username, pre-invoice, payment method, invoice.
 *   The payment screens of any order (a renewal's too) are this kind.
 * - `TOPUP` — funding the wallet: amount, method, invoice.
 */
export const TELEGRAM_WIZARD_KINDS = ['ORDER', 'TOPUP'] as const;
export type TelegramWizardKind = (typeof TELEGRAM_WIZARD_KINDS)[number];

/**
 * The screen a wizard message currently SHOWS.
 *
 * A tapped button is honoured only when the message it hangs off still shows the screen the
 * button belongs to; anything else is a stale tap and is answered without effect. That is
 * the rule that stops a double tap, or a keyboard Telegram had not yet replaced, from moving
 * the wizard backward or repeating an operation.
 *
 * - `INVOICE_LOADING` is the loading screen a turn has LANDED but not yet marked: the
 *   landing is written before the edit, so for that moment the message may still show the
 *   previous screen. The gateway worker never moves a message from here — an outcome it
 *   committed meanwhile would be edited in and then overwritten by the turn's loading edit —
 *   so the turn, once its loading edit has been asked for, moves it to `INVOICE_PENDING`
 *   itself and re-reads the attempt.
 * - `INVOICE_PENDING` is `INVOICE` whose provider invoice is still being created in the
 *   worker: the message shows the loading state, and whichever of the worker and the turn
 *   moves it on first (one conditional UPDATE) edits it into the invoice or the end.
 * - `NOTICE` is a sentence the flow ended on (a refusal, an unavailable route); its buttons,
 *   if any, restart a step.
 * - `CLOSED` is terminal: the wizard was paid, withdrawn or finalised, and no button of it is
 *   honoured again.
 */
export const TELEGRAM_WIZARD_STEPS = [
  'CATEGORIES',
  'PRODUCTS',
  'USERNAME',
  'DISCOUNT',
  'PREINVOICE',
  'AWAITING_PAYMENT',
  'METHODS',
  'AMOUNT',
  'INVOICE_LOADING',
  'INVOICE_PENDING',
  'INVOICE',
  'NOTICE',
  'CLOSED',
] as const;
export type TelegramWizardStep = (typeof TELEGRAM_WIZARD_STEPS)[number];

/**
 * What a tracked receipt-review message is.
 *
 * - `REVIEW` — the receipt itself (its file with the facts as caption, or the facts as text)
 *   and the decision buttons. Edited into the one-line result.
 * - `PROMPT` — a message a decision opened: the reason or amount prompt, the confirmation that
 *   restates it. Its buttons are removed once the decision is taken.
 */
export const TELEGRAM_REVIEW_MESSAGE_ROLES = ['REVIEW', 'PROMPT'] as const;
export type TelegramReviewMessageRole = (typeof TELEGRAM_REVIEW_MESSAGE_ROLES)[number];

/**
 * The outcome a review message is edited into. `BLOCKED` decides nothing about the payment:
 * the receipt stays in the review queue.
 */
export const TELEGRAM_REVIEW_OUTCOMES = ['APPROVED', 'REJECTED', 'BLOCKED', 'CREDITED'] as const;
export type TelegramReviewOutcome = (typeof TELEGRAM_REVIEW_OUTCOMES)[number];

// --- Retention (docs/telegram-retention.md) ------------------------------------------------

/**
 * How long a tracked message's row is kept after it was last touched before the retention
 * sweep may remove it — and only then if nothing live still names it (a lease, a payment
 * that is still `PENDING` or `UNKNOWN`, an order that is still `DRAFT` or
 * `AWAITING_PAYMENT`). See `docs/telegram-retention.md` for the rules row by row.
 *
 * A CONSTANT, not a setting, for the reason `TICKET_REPLY_FILE_RETENTION_DAYS` is one: the
 * safety argument for a stale tap after cleanup is the chat's purge horizon, which is exact
 * whatever this value is, so an operator gains nothing by tuning it — and every existing
 * retention period in this installation is a constant or a deployment variable, never a
 * per-tenant setting. Thirty days is far past every window a row serves: a payment attempt
 * ends within an hour, a draft's price hold within the order expiry, and Telegram redelivers
 * an update for at most a day.
 */
export const TELEGRAM_MESSAGE_STATE_RETENTION_DAYS = 30;

/**
 * The Telegram-message retention sweep has failed three ticks in a row — `TELEGRAM_MESSAGE_RETENTION_FAILURE_THRESHOLD` in the loop (the database
 * refused its delete, its transaction timed out). One condition per tenant — the dedupe key
 * is the code — written when the streak reaches its threshold and then at most once an
 * hour while it lasts, so a sweep that fails every tick is ONE row whose counter climbs,
 * never a row per tick. Nothing business-critical waits on the sweep; the condition says
 * the two presentation tables are growing again. Recovered by
 * `TELEGRAM_MESSAGE_RETENTION_RECOVERED_CODE` on the next tick that completes.
 */
export const TELEGRAM_MESSAGE_RETENTION_FAILING_CODE = 'telegram.message_retention_failing';
export const TELEGRAM_MESSAGE_RETENTION_RECOVERED_CODE = 'telegram.message_retention_recovered';
