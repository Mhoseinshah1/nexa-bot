import type {
  TelegramReviewOutcome,
  TelegramWizardKind,
  TelegramWizardStep,
  TemplateKey,
  TenantContext,
} from '@nexa/contracts';

/**
 * R2 (v0.3.5 real-test items 3–5): the surface's half of editing a flow in place.
 *
 * Kept out of `bot-runtime.ts` so the gate table and the directive shapes can be read — and
 * tested — on their own. Nothing here writes: `TelegramMessageStateService` does, and
 * `BotRuntime.handle` decides when.
 */

/** The message a tapped button hangs off, in a PRIVATE chat. */
export interface CallbackOrigin {
  readonly chatId: string;
  readonly messageId: number;
  /**
   * The message carries a file (a photo or a document) whose caption is its text — a
   * reviewer's receipt. Telegram cannot turn it into a text message, so its CAPTION is what
   * an edit changes.
   */
  readonly media: boolean;
}

/**
 * Where a tapped button came from, or null when this is not a tap in a private chat.
 *
 * Read strictly, like every identity on this surface: a message id that is not a positive
 * safe integer is not an id, and an edit keyed on one would touch nothing or the wrong thing.
 */
export function callbackOriginOf(update: unknown): CallbackOrigin | null {
  const message = (
    update as {
      callback_query?: {
        message?: {
          message_id?: unknown;
          chat?: { id?: unknown; type?: unknown };
          photo?: unknown;
          document?: unknown;
          caption?: unknown;
        };
      };
    } | null
  )?.callback_query?.message;
  if (message === undefined || message === null) return null;
  const chat = message.chat;
  if (chat === undefined || chat === null || chat.type !== 'private') return null;
  if (typeof chat.id !== 'number' && typeof chat.id !== 'string') return null;
  const id = message.message_id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
  const media =
    (Array.isArray(message.photo) && message.photo.length > 0) ||
    (message.document !== undefined && message.document !== null) ||
    typeof message.caption === 'string';
  return { chatId: String(chat.id), messageId: id, media };
}

/**
 * The customer's own TYPED message in a private chat — the answer a wizard step asked for —
 * so it can be removed once the wizard message above it shows the next step. Null otherwise.
 */
export function typedMessageOf(update: unknown): { chatId: string; messageId: number } | null {
  const message = (
    update as {
      message?: { message_id?: unknown; chat?: { id?: unknown; type?: unknown }; text?: unknown };
    } | null
  )?.message;
  if (message === undefined || message === null || typeof message.text !== 'string') return null;
  const chat = message.chat;
  if (chat === undefined || chat === null || chat.type !== 'private') return null;
  if (typeof chat.id !== 'number' && typeof chat.id !== 'string') return null;
  const id = message.message_id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
  return { chatId: String(chat.id), messageId: id };
}

/**
 * Which screen of which wizard a reply SHOWS, set by the handler that built it.
 *
 * A reply with no directive, answering a claimed wizard tap, lands on `NOTICE`: a refusal
 * or a sentence the flow ended on, edited into the message.
 */
export interface WizardDirective {
  readonly kind: TelegramWizardKind;
  readonly step: TelegramWizardStep;
  /** The order (ORDER) or amount capture (TOPUP) the screen is about. */
  readonly subjectId?: string | null;
  /** The payment an invoice screen shows. */
  readonly paymentId?: string | null;
  /**
   * `NEW`: this reply goes out as its OWN message and the wizard stays on the screen it
   * shows — a refusal the customer must be able to act on and come back from (the wallet is
   * short: they top up and pay from the same pre-invoice).
   */
  readonly placement?: 'NEW';
  /**
   * This reply answers a TYPED message: edit the chat's latest wizard waiting at one of
   * `steps` (for `subjectId`, when named) rather than the tapped one — there is none.
   */
  readonly anchor?: {
    readonly steps: readonly TelegramWizardStep[];
    readonly subjectId?: string | null;
  };
  /**
   * The invoice this screen shows is still being created by the gateway worker. The loading
   * screen is landed at `INVOICE_LOADING` — held, and never moved by the worker — and once
   * its edit has been asked for it is marked `INVOICE_PENDING` and re-read, so exactly one
   * of this turn and the worker edits it into the invoice or the attempt's end.
   */
  readonly invoicePending?: boolean;
}

/**
 * What a reply does to the administrators' receipt-review messages (item 3).
 *
 * - `origin` records the TAPPED message (the receipt, or a prompt) against the payment, so
 *   the decision can find it.
 * - `sent` records the message THIS reply is sent as — the receipt opened from the queue, a
 *   prompt, a confirmation that restates the typed reason.
 * - `outcome` is a decision taken (or one found already taken): the tapped message is edited
 *   in place into this reply, and every other recorded message of the payment is edited into
 *   the decision's final record (a receipt, `bot.admin.review_final` since F1) or loses its
 *   buttons (a prompt) — once: a message already finalised is never edited again, and a tap
 *   on one is answered with its disposition's notice and nothing else.
 */
export interface ReviewDirective {
  /** Null when the payment is read from the tapped message's own record. */
  readonly paymentId: string | null;
  readonly origin?: 'REVIEW' | 'PROMPT';
  readonly sent?: 'REVIEW' | 'PROMPT';
  readonly outcome?: TelegramReviewOutcome | 'GONE';
}

/**
 * The label a receipt message's final record leads with, per outcome (F1: the owner's four
 * exact labels) — and, alone, what it becomes when the record cannot be read, or for `GONE`.
 */
export const REVIEW_OUTCOME_KEYS: Readonly<Record<TelegramReviewOutcome | 'GONE', TemplateKey>> = {
  APPROVED: 'bot.admin.review_approved',
  REJECTED: 'bot.admin.review_rejected',
  BLOCKED: 'bot.admin.review_blocked',
  CREDITED: 'bot.admin.review_credited',
  GONE: 'bot.admin.receipt_gone',
};

/**
 * The review taps that a FINALISED message answers with `answerCallbackQuery` alone: every
 * button a receipt message or one of its prompts carries. A repeated tap never reaches the
 * decision a second time.
 */
export const REVIEW_TAP_INTENTS: ReadonlySet<string> = new Set([
  'ADMIN_APPROVE',
  'ADMIN_REJECT',
  'ADMIN_REJECT_CONFIRM',
  'ADMIN_REJECT_CANCEL',
  'ADMIN_CREDIT',
  'ADMIN_CREDIT_CONFIRM',
  'ADMIN_CREDIT_CANCEL',
  'ADMIN_BLOCK_ASK',
  'ADMIN_BLOCK_OPEN',
  'ADMIN_BLOCK_CONFIRM',
  'ADMIN_BLOCK_CANCEL',
]);

/**
 * The gate each wizard button passes: which wizard it belongs to (null for a button both
 * carry), what a message nothing tracked yet is adopted as, and the screens the button is
 * drawn on. A tap is honoured only while its message still shows one of `from`.
 *
 * `from` is the SOURCE screen, never the destination: "back" buttons are ordinary buttons of
 * the screen they sit on, so an explicit back is honoured, while a button from a screen the
 * message no longer shows — a double tap, a keyboard Telegram had not yet replaced — cannot
 * move the wizard at all.
 */
export interface WizardGate {
  readonly kind: TelegramWizardKind | null;
  readonly adoptAs: TelegramWizardKind;
  readonly from: readonly TelegramWizardStep[];
}

const ORDER = (...from: TelegramWizardStep[]): WizardGate => ({
  kind: 'ORDER',
  adoptAs: 'ORDER',
  from,
});
const TOPUP = (...from: TelegramWizardStep[]): WizardGate => ({
  kind: 'TOPUP',
  adoptAs: 'TOPUP',
  from,
});

export const WIZARD_GATES: ReadonlyMap<string, WizardGate> = new Map<string, WizardGate>([
  // Purchase: category → product → username → pre-invoice → method → invoice.
  ['CATALOG_PAGE', ORDER('CATEGORIES', 'PRODUCTS')],
  ['CATEGORY', ORDER('CATEGORIES', 'PRODUCTS')],
  ['ORDER', ORDER('PRODUCTS')],
  ['USERNAME_CUSTOM', ORDER('USERNAME')],
  ['USERNAME_AUTOMATIC', ORDER('USERNAME')],
  ['DISCOUNT_CODE_ENTER', ORDER('PREINVOICE')],
  ['DISCOUNT_CODE_REMOVE', ORDER('PREINVOICE')],
  ['CONFIRM', ORDER('PREINVOICE')],
  ['PAY_WALLET', ORDER('PREINVOICE', 'AWAITING_PAYMENT')],
  // «🧾 ثبت پرداخت»: from the pre-invoice, the awaiting-payment screen, or a failed invoice.
  ['PAY_METHODS', ORDER('PREINVOICE', 'AWAITING_PAYMENT', 'NOTICE')],
  ['PAY_METHODS_CLOSE', ORDER('METHODS')],
  ['PAY_MANUAL', ORDER('METHODS', 'PREINVOICE', 'AWAITING_PAYMENT')],
  ['PAY_GATEWAY', ORDER('METHODS', 'PREINVOICE', 'AWAITING_PAYMENT')],
  // Wallet top-up: amount → method → invoice. Its entry is the wallet screen's button.
  ['TOPUP_MENU', TOPUP('NOTICE')],
  ['TOPUP_PICK', TOPUP('AMOUNT')],
  ['TOPUP_ROUTE', TOPUP('METHODS')],
  ['TOPUP_CLOSE', TOPUP('AMOUNT', 'METHODS')],
  /*
   * Both kinds' invoice carries the check button, and so does the loading screen. A loading
   * screen still `INVOICE_LOADING` is held by the turn that landed it until that turn marks
   * it; once the hold lapses (the turn died in between) the check tap is what recovers it.
   */
  [
    'GATEWAY_CHECK',
    {
      kind: null,
      adoptAs: 'ORDER',
      from: ['INVOICE_PENDING', 'INVOICE', 'INVOICE_LOADING'],
    },
  ],
  /*
   * TonPays Telegram (§8.1): the receipt and card-change buttons are drawn only on the card
   * invoice, which is an `INVOICE` screen. A tap from any other screen is stale.
   */
  ['GATEWAY_RECEIPT', { kind: null, adoptAs: 'ORDER', from: ['INVOICE'] }],
  ['GATEWAY_CARD_CHANGE', { kind: null, adoptAs: 'ORDER', from: ['INVOICE'] }],
]);

/**
 * What the runtime needs of the wizard and review-message state — `TelegramMessageStateService`
 * satisfies it structurally.
 */
export type { TelegramMessageStateService as MessageStatePort } from '../../modules/commerce/messaging/application/telegram-message-state.js';

/**
 * The invoice screens the gateway worker also edits (`WizardInvoiceScreens`). The runtime
 * calls it once its loading screen is on the message, so a ready invoice is never left
 * waiting for a tap on «بررسی وضعیت پرداخت».
 */
export interface InvoiceScreensPort {
  refresh(scope: TenantContext, paymentId: string): Promise<void>;
}
