import {
  COMMERCE_ERROR_CODES,
  orderCodeOf,
  paymentTrackingCode,
  isNexaError,
  currencyCodeSchema,
  money,
  plainAmount,
  SERVICE_NOTE_CLEAR_TOKEN,
  SERVICE_NOTE_MAX_LENGTH,
  SERVICE_SEARCH_MAX_LENGTH,
  PAYMENT_GATEWAY_DESCRIPTORS,
  TONPAYS_TELEGRAM_STATUS_LESS,
  TONPAYS_TELEGRAM_STATUS_MORE,
  TETRAPAY_AMOUNT_OUT_OF_RANGE_STORED,
  TETRAPAY_DAILY_LIMIT_STORED,
  formatCustomServiceVolume,
} from '@nexa/contracts';
import type {
  ClientAppPlatform,
  PaymentGatewayProvider,
  ActorContext,
  BotInstanceId,
  CustomerArrival,
  Money,
  OrderPurpose,
  PaymentId,
  TemplateKey,
  TemplateValues,
  TenantContext,
  UserId,
  InlineButtonKey,
} from '@nexa/contracts';
import type { InboundReceiptFile } from '../../modules/commerce/payments/application/receipt-ports.js';
import type { PaymentRecord } from '../../modules/commerce/payments/application/ports.js';
import {
  RECEIPT_REVIEW_NOTE_MAX,
  reviewNoteOf,
} from '../../modules/commerce/payments/application/receipt-review-caption.js';
import type {
  CustomerButton,
  CustomerSendOutcome,
  CustomerSendResult,
} from '../../modules/commerce/messaging/application/ports.js';
import type { CustomerRecord } from '../../modules/commerce/customers/application/ports.js';
import {
  inlineDataLabel,
  inlineLabel,
} from '../../modules/commerce/messaging/application/inline-buttons.js';
import type { OrderRecord } from '../../modules/commerce/orders/application/ports.js';
import {
  FX_UNAVAILABLE_REASON,
  type GatewayAttempt,
  type ManualTransferInstruction,
} from '../../modules/commerce/payments/application/payment.service.js';
import type {
  GatewayAttemptView,
  GatewayCardFacts,
} from '../../modules/commerce/payments/application/gateway-payment.service.js';
import type {
  GatewayInvoiceRecord,
  GatewayProviderRequestRecord,
} from '../../modules/commerce/payments/application/gateway-invoice-ports.js';
import {
  cancelAvailable,
  cardChangeOffered,
  customerMessageKeyOfError,
  decideCardChange,
  isBuyerConflictCode,
  receiptUploadAvailable,
  refundCardAvailable,
  remainderReceiptAvailable,
} from '../../modules/commerce/payments/domain/tonpays-telegram.js';
import { gatewaySettlementDeadline } from '../../modules/commerce/payments/domain/settlement.js';
import type { CustomerServiceOperation } from '../../modules/commerce/provisioning/application/provisioning.service.js';
import { SERVICE_CARD_CALLBACK_PREFIX } from '../../modules/commerce/provisioning/application/delivery.service.js';
import type { CustomerCaptureRecord } from '../../modules/commerce/customers/application/customer-capture-ports.js';
import type { CardMessageRef } from '../../modules/commerce/provisioning/application/operation-card.js';
import type {
  TopupRoute,
  WalletTopupFlowService,
} from '../../modules/commerce/payments/application/wallet-topup-flow.service.js';
import type { StartGreetingKey } from '../../modules/commerce/messaging/application/start-greeting.js';
import { amountToTransfer } from '../../modules/commerce/payments/domain/amount-to-transfer.js';
import {
  CARD_INVOICE_ROW,
  cardInvoiceAmountValues,
  cardInvoiceCardValues,
  copyCardNumberButton,
  copyRialAmountButton,
} from './card-invoice.js';
import type { ServiceRecord } from '../../modules/commerce/provisioning/application/ports.js';
import type { TelegramWizardRecord } from '../../modules/commerce/messaging/application/telegram-message-state.js';
import {
  REVIEW_TAP_INTENTS,
  WIZARD_GATES,
  callbackOriginOf,
  typedMessageOf,
  type CallbackOrigin,
  type WizardDirective,
} from './wizard-state.js';
import type { InboundTicketFile } from '../../modules/commerce/tickets/application/ticket.service.js';
import {
  CANCEL_ORDER_ASK_CALLBACK_PREFIX,
  CANCEL_ORDER_CALLBACK_PREFIX,
  CANCEL_PAY_ASK_CALLBACK_PREFIX,
  CANCEL_PAY_CALLBACK_PREFIX,
  CATALOG_BROWSE_MAX_PAGE,
  CATALOG_PAGE_CALLBACK_PREFIX,
  CATEGORY_CALLBACK_PREFIX,
  CUSTOM_SERVICE_CALLBACK_DATA,
  CUSTOM_SERVICE_LOCATION_CALLBACK_PREFIX,
  DISCOUNT_CODE_ENTER_CALLBACK_PREFIX,
  DISCOUNT_CODE_REMOVE_CALLBACK_PREFIX,
  GATEWAY_CANCEL_ASK_CALLBACK_PREFIX,
  GATEWAY_CANCEL_CALLBACK_PREFIX,
  GATEWAY_CARD_CHANGE_CALLBACK_PREFIX,
  GATEWAY_CHECK_CALLBACK_PREFIX,
  GATEWAY_RECEIPT_CALLBACK_PREFIX,
  GATEWAY_REFUND_CARD_CALLBACK_PREFIX,
  GATEWAY_ROUTE_PAY_CALLBACK_PREFIX,
  MANUAL_PAY_CALLBACK_PREFIX,
  ORDER_CALLBACK_PREFIX,
  PAY_METHODS_CALLBACK_PREFIX,
  PAY_METHODS_CLOSE_CALLBACK_PREFIX,
  PAY_SENT_CALLBACK_PREFIX,
  PAY_SWITCH_CARD_CALLBACK_PREFIX,
  TOPUP_CLOSE_CALLBACK_PREFIX,
  TOPUP_MENU_CALLBACK_PREFIX,
  TOPUP_PICK_CALLBACK_PREFIX,
  TOPUP_ROUTE_CALLBACK_PREFIX,
  USERNAME_AUTOMATIC_CALLBACK_PREFIX,
  USERNAME_CUSTOM_CALLBACK_PREFIX,
  WALLET_PAY_CALLBACK_PREFIX,
} from './runtime/callbacks.js';
import type { BotRuntimeDeps } from './runtime/deps.js';
import {
  type MainMenuRoutes,
  intentOf,
  isCallbackQueryUpdate,
  privateChatIdOf,
  startPayloadOf,
  updateIdOf,
} from './runtime/intent-of.js';
import { BOT_INTENTS, type BotCommand, type BotIntent } from './runtime/intents.js';
import { mainMenuButton } from './runtime/keyboards.js';
import { refusal } from './runtime/refusals.js';
import {
  type BotTurnResult,
  type PendingReply,
  blockedReply,
  editSent,
  replyFor,
  staleCallbackReply,
  withBlockedSupportButton,
} from './runtime/replies.js';
import * as startMenuFlow from './runtime/start-menu-flow.js';
import {
  MEMBERSHIP_EXEMPT_INTENTS,
  membershipRequired,
  termsRequired,
  termsAcceptedReply,
  termsStaleReply,
} from './runtime/start-menu-flow.js';
import * as serviceCardFlow from './runtime/service-card-flow.js';
import {
  serviceListButton,
  backToListButton,
  cardMessageOf,
  backToServiceButton,
  inCard,
} from './runtime/service-card-flow.js';
import * as serviceRequestsFlow from './runtime/service-requests-flow.js';
import * as serviceActionsFlow from './runtime/service-actions-flow.js';
import * as supportFlow from './runtime/support-flow.js';
import * as trialFlow from './runtime/trial-flow.js';
import * as referralFlow from './runtime/referral-flow.js';
import * as tutorialFlow from './runtime/tutorial-flow.js';
import * as adminFlow from './runtime/admin-flow.js';
import * as adminReviewFlow from './runtime/admin-review-flow.js';
import { hasAnyPanelSection } from './runtime/admin-common.js';
export {
  tutorialChoice,
  clientAppPlatformScreen,
  clientAppScreen,
} from './runtime/tutorial-flow.js';
export { serviceListButton, cardMessageOf } from './runtime/service-card-flow.js';
export { LOCATION_TARGETS_SHOWN } from './runtime/service-actions-flow.js';
export {
  termsAcceptedReply,
  termsStaleReply,
  marketingPreferenceButton,
} from './runtime/start-menu-flow.js';
export { BOT_INTENTS } from './runtime/intents.js';
export type { BotIntent, BotCommand } from './runtime/intents.js';
export {
  encodeIdPair,
  decodeIdPair,
  ORDER_CALLBACK_PREFIX,
  CONFIRM_CALLBACK_PREFIX,
  WALLET_PAY_CALLBACK_PREFIX,
  MANUAL_PAY_CALLBACK_PREFIX,
  GATEWAY_PAY_CALLBACK_PREFIX,
  GATEWAY_CHECK_CALLBACK_PREFIX,
  GATEWAY_RECEIPT_CALLBACK_PREFIX,
  GATEWAY_CARD_CHANGE_CALLBACK_PREFIX,
  GATEWAY_CANCEL_ASK_CALLBACK_PREFIX,
  GATEWAY_CANCEL_CALLBACK_PREFIX,
  GATEWAY_REFUND_CARD_CALLBACK_PREFIX,
  GATEWAY_ROUTE_PAY_CALLBACK_PREFIX,
  TICKETS_CALLBACK_DATA,
  TICKET_NEW_CALLBACK_DATA,
  TICKET_CATEGORY_CALLBACK_PREFIX,
  TICKET_VIEW_CALLBACK_PREFIX,
  TICKET_REPLY_CALLBACK_PREFIX,
  TICKET_CLOSE_ASK_CALLBACK_PREFIX,
  TICKET_CLOSE_CALLBACK_PREFIX,
  PAY_METHODS_CALLBACK_PREFIX,
  PAY_METHODS_CLOSE_CALLBACK_PREFIX,
  CANCEL_PAY_ASK_CALLBACK_PREFIX,
  CANCEL_PAY_CALLBACK_PREFIX,
  PAY_SENT_CALLBACK_PREFIX,
  PAY_SWITCH_CARD_CALLBACK_PREFIX,
  CANCEL_ORDER_ASK_CALLBACK_PREFIX,
  CANCEL_ORDER_CALLBACK_PREFIX,
  TOPUP_MENU_CALLBACK_PREFIX,
  TOPUP_PICK_CALLBACK_PREFIX,
  REFERRAL_INVITE_CALLBACK_PREFIX,
  SERVICE_CALLBACK_PREFIX,
  SERVICES_PAGE_CALLBACK_PREFIX,
  SERVICE_RESEND_CALLBACK_PREFIX,
  SERVICE_SUSPEND_CALLBACK_PREFIX,
  SERVICE_RESUME_CALLBACK_PREFIX,
  SERVICE_SUSPEND_CONFIRM_CALLBACK_PREFIX,
  SERVICE_RESUME_CONFIRM_CALLBACK_PREFIX,
  SERVICE_TERMINATE_ASK_CALLBACK_PREFIX,
  SERVICE_TERMINATE_CALLBACK_PREFIX,
  SERVICE_ROTATE_ASK_CALLBACK_PREFIX,
  SERVICE_ROTATE_CALLBACK_PREFIX,
  SERVICE_RENEW_CALLBACK_PREFIX,
  SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX,
  SERVICE_ADD_TIME_CALLBACK_PREFIX,
  SERVICE_BUY_TRAFFIC_CALLBACK_PREFIX,
  SERVICE_BUY_TIME_CALLBACK_PREFIX,
  SERVICE_ACTION_CONFIRM_CALLBACK_PREFIX,
  SERVICE_ADD_DEVICES_CALLBACK_PREFIX,
  SERVICE_BUY_DEVICES_CALLBACK_PREFIX,
  encodeDeviceQuantity,
  decodeDeviceQuantity,
  SERVICE_CHANGE_LOCATION_CALLBACK_PREFIX,
  SERVICE_LOCATION_TARGET_CALLBACK_PREFIX,
  SERVICE_LOCATION_CONFIRM_CALLBACK_PREFIX,
  USERNAME_CUSTOM_CALLBACK_PREFIX,
  USERNAME_AUTOMATIC_CALLBACK_PREFIX,
  DISCOUNT_CODE_ENTER_CALLBACK_PREFIX,
  DISCOUNT_CODE_REMOVE_CALLBACK_PREFIX,
  MAIN_MENU_CALLBACK_DATA,
  MARKETING_OPT_OUT_CALLBACK_DATA,
  MARKETING_OPT_IN_CALLBACK_DATA,
  MEMBERSHIP_CHECK_CALLBACK_DATA,
  TERMS_ACCEPT_CALLBACK_PREFIX,
  TUTORIAL_PLATFORM_CALLBACK_PREFIX,
  CLIENT_APP_CALLBACK_PREFIX,
  TOPUP_ROUTE_CALLBACK_PREFIX,
  TOPUP_CLOSE_CALLBACK_PREFIX,
  SERVICES_LIST_PAGE_CALLBACK_PREFIX,
  SERVICES_SEARCH_CALLBACK_DATA,
  SERVICE_REFRESH_CALLBACK_PREFIX,
  SERVICE_FILES_CALLBACK_PREFIX,
  SERVICE_NOTE_CALLBACK_PREFIX,
  SERVICE_RENEW_QUOTE_CALLBACK_PREFIX,
  SERVICE_RENEW_PLAN_CALLBACK_PREFIX,
  REFERRAL_GIFT_CALLBACK_DATA,
  WALLET_OPEN_CALLBACK_DATA,
  CATALOG_OPEN_CALLBACK_DATA,
  ADMIN_PANEL_CALLBACK_PREFIX,
  ADMIN_RECEIPTS_CALLBACK_PREFIX,
  ADMIN_RECEIPT_CALLBACK_PREFIX,
  SERVICE_REFUND_ASK_CALLBACK_PREFIX,
  SERVICE_REFUND_CONFIRM_CALLBACK_PREFIX,
  SERVICE_TRANSFER_ASK_CALLBACK_PREFIX,
  SERVICE_TRANSFER_CONFIRM_CALLBACK_PREFIX,
  ADMIN_REFUND_REQUEST_APPROVE_CALLBACK_PREFIX,
  ADMIN_REFUND_REQUEST_REJECT_CALLBACK_PREFIX,
  ADMIN_REFUND_REQUEST_APPROVE_CONFIRM_CALLBACK_PREFIX,
  ADMIN_REFUND_REQUEST_APPROVE_CANCEL_CALLBACK_PREFIX,
  ADMIN_APPROVE_CALLBACK_PREFIX,
  ADMIN_REJECT_CALLBACK_PREFIX,
  ADMIN_SECTION_CALLBACK_PREFIX,
  ADMIN_CREDIT_CALLBACK_PREFIX,
  ADMIN_CREDIT_CONFIRM_CALLBACK_PREFIX,
  ADMIN_CREDIT_CANCEL_CALLBACK_PREFIX,
  ADMIN_BLOCK_ASK_CALLBACK_PREFIX,
  ADMIN_BLOCK_OPEN_CALLBACK_PREFIX,
  ADMIN_BLOCK_CONFIRM_CALLBACK_PREFIX,
  ADMIN_BLOCK_CANCEL_CALLBACK_PREFIX,
  ADMIN_REJECT_CONFIRM_CALLBACK_PREFIX,
  ADMIN_REJECT_CANCEL_CALLBACK_PREFIX,
  ADMIN_REVOKE_CALLBACK_PREFIX,
  ADMIN_SERVICES_CALLBACK_PREFIX,
  ADMIN_SERVICES_BROWSE_CALLBACK_DATA,
  ADMIN_SERVICES_BROWSE_PAGE_CALLBACK_PREFIX,
  ADMIN_SERVICE_CALLBACK_PREFIX,
  ADMIN_SERVICE_SYNC_CALLBACK_PREFIX,
  ADMIN_SERVICE_RESEND_CALLBACK_PREFIX,
  ADMIN_SERVICE_RETRY_CALLBACK_PREFIX,
  ADMIN_SERVICE_RECONCILE_CALLBACK_PREFIX,
  ADMIN_SERVICE_SUSPEND_CALLBACK_PREFIX,
  ADMIN_SERVICE_RESUME_CALLBACK_PREFIX,
  ADMIN_SERVICE_TERMINATE_ASK_CALLBACK_PREFIX,
  ADMIN_SERVICE_TERMINATE_CALLBACK_PREFIX,
  ADMIN_SERVICE_ROTATE_ASK_CALLBACK_PREFIX,
  ADMIN_SERVICE_ROTATE_CALLBACK_PREFIX,
  rotationStamp,
  ADMIN_PANELS_CALLBACK_PREFIX,
  ADMIN_PANEL_DETAIL_CALLBACK_PREFIX,
  ADMIN_PANEL_TEST_CALLBACK_PREFIX,
  ADMIN_PANEL_ENABLE_CALLBACK_PREFIX,
  ADMIN_PANEL_DISABLE_CALLBACK_PREFIX,
  ADMIN_PANEL_ARCHIVE_ASK_CALLBACK_PREFIX,
  ADMIN_PANEL_ARCHIVE_CALLBACK_PREFIX,
  ADMIN_PANELS_PAGE_CALLBACK_PREFIX,
  ADMIN_REMINDERS_CALLBACK_PREFIX,
  ADMIN_REMINDER_EDIT_CALLBACK_PREFIX,
  ADMIN_REMINDER_SET_CALLBACK_PREFIX,
  ADMIN_ADMIN_CALLBACK_PREFIX,
  ADMIN_ADMIN_STATUS_CALLBACK_PREFIX,
  ADMIN_CUSTOMERS_CALLBACK_PREFIX,
  ADMIN_CUSTOMER_CALLBACK_PREFIX,
  ADMIN_USERNAME_CALLBACK_PREFIX,
  ADMIN_CATEGORIES_CALLBACK_PREFIX,
  ADMIN_CATEGORY_CALLBACK_PREFIX,
  ADMIN_CATEGORY_PRODUCTS_CALLBACK_PREFIX,
  ADMIN_CATEGORY_PICK_CALLBACK_PREFIX,
  ADMIN_CATEGORY_ASSIGN_CALLBACK_PREFIX,
  ADMIN_USERNAME_TOGGLE_CALLBACK_PREFIX,
  ADMIN_USERNAME_STRATEGY_CALLBACK_PREFIX,
  REMINDER_SETTING_CODES,
  CATALOG_BROWSE_MAX_PAGE,
  CATALOG_PAGE_CALLBACK_PREFIX,
  CATEGORY_CALLBACK_PREFIX,
  TRIAL_CALLBACK_DATA,
  TRIAL_PANEL_CALLBACK_PREFIX,
  CUSTOM_SERVICE_CALLBACK_DATA,
  CUSTOM_SERVICE_LOCATION_CALLBACK_PREFIX,
  parseCatalogPage,
  TRANSFER_CONFIRM_VERSION_MAX,
  transferConfirmData,
  decodeTransferConfirm,
} from './runtime/callbacks.js';
export type { ReminderSettingCode } from './runtime/callbacks.js';
export {
  startPayloadOf,
  updateIdOf,
  intentOf,
  privateChatIdOf,
  isCallbackQueryUpdate,
} from './runtime/intent-of.js';
export type { MainMenuRoutes } from './runtime/intent-of.js';
export type {
  CustomServiceSurface,
  BotRuntimeDeps,
  TicketDeskPort,
  CaptureReadTransaction,
  PaymentRouteSource,
  SupportScreenSource,
  ProductDisplaySource,
  PanelLocationLabelSource,
  ReferralGiftSource,
  TenantMediaSource,
  TelegramAdminPort,
  AdminRosterEntry,
} from './runtime/deps.js';
export {
  blockedReply,
  withBlockedSupportButton,
  editSent,
  replyFor,
  staleCallbackReply,
} from './runtime/replies.js';
export type { BotTurnResult, PendingReply, LeadMessage } from './runtime/replies.js';
export { REFUSAL_REPLIES, refusalValuesFor } from './runtime/refusals.js';
export { notificationButtons } from './runtime/keyboards.js';
export {
  receiptReviewButtons,
  refundRequestReviewButtons,
  creditRefusal,
} from './runtime/admin-review-flow.js';

/**
 * `sv:<service id>` — R3: the service card, edited into the message the tap came from.
 * Declared beside the delivery lane's buttons since round N (F4), which draws it too.
 */
export { SERVICE_CARD_CALLBACK_PREFIX };

/**
 * The intents `adminTurn` owns, so `act` has one branch rather than nineteen.
 *
 * DERIVED from the name rather than listed, and that is the fix for a defect rather
 * than a tidy-up: it was a hand-kept copy of a naming convention, and Phase 6A added
 * ten `ADMIN_*` intents to `BOT_INTENTS`, wired every one into `adminTurn`'s switch,
 * and did not add them here. `act` never routed them, so an administrator who pressed
 * the services buttons got the unknown-input reply — the exact answer a customer gets,
 * which is why nothing about it looked broken.
 *
 * The convention is total: every intent this runtime routes to the management panel is
 * named `ADMIN_…`, and nothing else is. A new section now reaches the panel by being
 * named, which is one fewer list to forget.
 */
const ADMIN_INTENTS: ReadonlySet<BotIntent> = new Set<BotIntent>(
  BOT_INTENTS.filter((intent) => intent.startsWith('ADMIN_')),
);

/**
 * How many products one `/catalog` answer shows.
 *
 * A BOUND, not a page. `listCatalog` reports `hasMore` and this surface drops it on the
 * floor, so a tenant with more than twenty sellable products shows twenty and says
 * nothing about the rest. That is a real limit and it is stated here rather than left to
 * be discovered: how a customer reaches a long catalogue over Telegram — a next button,
 * categories, a search — is a product decision with no evidence behind it in
 * `docs/research/`, and `docs/open-questions.md` carries it rather than this file
 * guessing. Twenty is above any catalogue the research shows.
 */
export const CATALOG_PAGE_SIZE = 20;

/**
 * How many rows one page of the CATEGORISED catalogue shows, at either level.
 *
 * A page, not a bound — unlike `CATALOG_PAGE_SIZE` above, which this browse replaces for
 * customers. Eight because a Telegram inline keyboard is read on a phone: eight rows plus
 * a navigation row fits one screen, and a page the customer has to scroll to find the
 * Next button on is a page they give up on.
 */
export const CATALOG_BROWSE_PAGE_SIZE = 8;

/*
 * The reviewer's caption is built by ONE application function the pull item and the push
 * share (`receipt-review-caption.ts`); these are re-exported for the tests that pin them.
 */
export { RECEIPT_REVIEW_NOTE_MAX, reviewNoteOf };

/**
 * A receipt's refusal (roadmap E6). The shared table, except a receipt that arrived after its
 * window closed: while the payment can still take one, the sentence that says "press the
 * button below" carries that button — the same «پرداخت را انجام دادم | ارسال رسید» tap that
 * opened the first window, which opens a new one (`signalTransferSent`, a new key). The prompt
 * edited the invoice's own button away, so without it the remedy named a button that was
 * nowhere. A payment that can no longer take a receipt is told so instead of being sent to a
 * button that would refuse.
 */
function receiptRefusal(error: unknown): PendingReply {
  if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.RECEIPT_WINDOW_EXPIRED) {
    const paymentId = error.details?.['paymentId'];
    const next = error.details?.['next'];
    const reference = error.details?.['reference'];
    // Past its deadline but holding a receipt: still waiting for a reviewer, never "closed".
    if (next === 'UNDER_REVIEW') {
      return {
        key: 'bot.payment.received_for_review',
        // Already the public tracking code (`ReceiptService`), never the stored reference.
        values: typeof reference === 'string' ? { reference } : {},
        buttons: [],
        orderId: null,
      };
    }
    if (typeof paymentId !== 'string' || next !== 'REOPEN') {
      return { key: 'bot.payment.not_pending', values: {}, buttons: [], orderId: null };
    }
    return {
      key: 'bot.payment.receipt_expired',
      values: {},
      buttons: [
        { ...inlineLabel('payment.sent'), data: `${PAY_SENT_CALLBACK_PREFIX}${paymentId}` },
      ],
      orderId: null,
    };
  }
  return refusal(error);
}

/** The external gateway cannot be used right now (WP11A): never the customer's failure. */
function gatewayUnavailable(): PendingReply {
  return {
    key: 'bot.payment.gateway_unavailable',
    values: {},
    buttons: [mainMenuButton()],
    orderId: null,
  };
}

/**
 * A refusal of an external-gateway request. The route being off, unconfigured or unable
 * to take this amount is "unavailable" (the shared table would answer a top-up sentence
 * for `PAYMENT_GATEWAY_UNAVAILABLE`); everything else goes through the shared table.
 */
function gatewayRefusal(error: unknown): PendingReply {
  if (!isNexaError(error)) return refusal(error);
  /*
   * Package FX: a route priced by the central exchange rate, with no usable rate right
   * now (every source down past the stale limit, or the feature off). Its own sentence,
   * because the remedy differs from a route that is off: try again shortly, or pay
   * another way. It names no source and no figure.
   */
  if (
    error.code === COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE &&
    typeof error.details === 'object' &&
    error.details !== null &&
    (error.details as { reason?: unknown }).reason === FX_UNAVAILABLE_REASON
  ) {
    return {
      key: 'bot.payment.fx_unavailable',
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
    };
  }
  if (
    error.code === COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE ||
    error.code === COMMERCE_ERROR_CODES.PAYMENT_METHOD_UNAVAILABLE ||
    error.code === COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_AMOUNT_REJECTED
  ) {
    return gatewayUnavailable();
  }
  return refusal(error);
}

/**
 * A customer's withdrawal of a transfer, refused (Payment File 02 §9, D1).
 *
 * `ORDER_TRANSFER_UNDER_REVIEW` from `withdrawPending` means a RECEIPT is filed against
 * the payment, and the shared table's sentence for that code is about cancelling an ORDER
 * — false for a wallet top-up, which has none. So this one refusal gets a sentence about
 * the payment; every other goes through the shared table unchanged.
 */
export function withdrawalRefusal(error: unknown): PendingReply {
  if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.ORDER_TRANSFER_UNDER_REVIEW) {
    return { key: 'bot.payment.withdraw_under_review', values: {}, buttons: [], orderId: null };
  }
  return refusal(error);
}

/**
 * One turn of the customer-facing bot.
 *
 * The ORDER is the contract, and it is the same order `CLAUDE.md` fixes for the backup
 * pipeline and ADR-0028 fixes for recovery:
 *
 *   1. resolve and commit the state change — the customer exists, their profile is
 *      fresh, `last_seen_at` has moved;
 *   2. THEN send, outside any transaction.
 *
 * Never the other way round and never in one transaction. A send inside the transaction
 * could be rolled back after Telegram had delivered it, and a failed send must not undo
 * the fact that the customer arrived. `telegramSend` asserts the second half of that by
 * refusing to run inside a transaction at all.
 *
 * Nothing here throws for a send failure. A throw becomes a non-2xx, a non-2xx makes
 * Telegram redeliver the update, and a redelivered update whose only problem was a
 * failed reply is an unbounded loop that bumps `last_seen_at` for ever.
 */
export class BotRuntime {
  constructor(readonly deps: BotRuntimeDeps) {}

  /**
   * The route table for this update (R1): the shared defaults, then this tenant's current
   * labels over them. Read only for a TEXT message — a keyboard tap is text, and nothing
   * else consults the table, so a callback or a file pays for no template rendering.
   */
  async menuFor(scope: TenantContext, update: unknown): Promise<MainMenuRoutes> {
    const text = (update as { message?: { text?: unknown } } | null)?.message?.text;
    if (typeof text !== 'string' || this.deps.menuRoutes === undefined) return this.deps.mainMenu;
    return new Map([...this.deps.mainMenu, ...(await this.deps.menuRoutes.routesFor(scope))]);
  }

  async handle(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
      readonly telegramUserId: string;
      readonly from: unknown;
    },
  ): Promise<BotTurnResult> {
    const command = intentOf(input.update, await this.menuFor(scope, input.update));
    const { intent } = command;

    /*
     * 0. Anti-spam (WP20, brief §3.4), before any work.
     *
     * Every interaction is counted — text, commands (`/start` included), button presses,
     * media — once per `update_id`, so Telegram redelivering an update does not count it
     * twice. Counted whatever it claims to be: an intent is only what the update SAYS, and
     * exempting admin-shaped callbacks would let any customer flood with `C:<uuid>` taps
     * uncounted. Who is an administrator is decided below, by the binding, and only once
     * the limit is crossed — so the ordinary turn pays for no extra lookup.
     *
     * Fails open: when the counter cannot be read the verdict is ALLOWED.
     */
    // One reader of `update_id` for the runtime (shared with WP19's prompt ordering).
    const numericUpdateId = updateIdOf(input.update);
    const updateId = numericUpdateId === undefined ? null : String(numericUpdateId);
    const counted =
      this.deps.antiSpam === undefined || updateId === null
        ? null
        : await this.deps.antiSpam.observe(scope, {
            botInstanceId: input.botInstanceId,
            telegramUserId: input.telegramUserId,
            updateId,
          });

    /*
     * 1. The state change, committed.
     *
     * Runs for every intent this runtime SEES, not only `/start`. The customer's
     * existence and their `last_seen_at` are facts about any contact, and a "last seen"
     * that only moved on `/start` would be a column an operator reads as activity and
     * is not.
     *
     * One update never reaches here: `/ping`, which the webhook answers and returns
     * from. That is an idempotency-key collision rather than a product decision, and
     * `webhook.controller.ts` states it where the `return` is — named here too, because
     * "every intent" is the sentence a reader would otherwise take as complete.
     */
    const resolved = await this.deps.customers.resolveFromUpdate(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      telegramUserId: input.telegramUserId,
      from: input.from,
      botInstanceId: input.botInstanceId,
      // A referral link's code, on the `/start` it opened (WP9 F2). Null on anything else.
      startPayload: intent === 'START' ? startPayloadOf(input.update) : null,
    });
    let { customer, arrival } = resolved;

    /*
     * A bound administrator is staff, not a customer, and anti-spam is a rule about
     * customers (brief §3.4). Asked of the binding — the one authority on who is an
     * administrator — and only when the count has crossed the limit.
     */
    const spam =
      counted !== null &&
      counted.verdict !== 'ALLOWED' &&
      (await this.deps.telegramAdmins?.resolve(scope, input.telegramUserId, actor.correlationId)) !=
        null
        ? null
        : counted;

    /*
     * The 21st interaction, or a later one whose block has not landed yet, blocks the
     * customer (brief §3.5) through the one block path there is, with the owner's reason,
     * as `SYSTEM_JOB`. Conditional on ACTIVE, so concurrent triggers change the row once
     * and an administrator's block that got there first keeps its own reason. The
     * triggering update then takes the BLOCKED branch below: it never reaches `act`, so it
     * cannot start any commercial work.
     */
    let blockedThisTurn = false;
    if (spam !== null && spam.verdict !== 'ALLOWED' && arrival !== 'BLOCKED') {
      const outcome = await this.deps.customers.blockForSpam(scope, actor, {
        idempotencyKey: `${input.idempotencyKey}:anti-spam`,
        customerId: customer.id,
        interactions: spam.count ?? 0,
      });
      customer = outcome.customer;
      arrival = 'BLOCKED';
      blockedThisTurn = outcome.changed;
    }

    /*
     * 2. The commercial work, still before any send.
     *
     * A BLOCKED customer never reaches it: `replyFor` answers `bot.blocked` whatever they
     * asked for, and this is gated on the same condition rather than on its own copy of
     * the rule. The order service refuses a blocked customer too — that is the
     * authoritative check, inside the transaction, and this one exists so the surface
     * does not ask for work it already knows will be refused.
     *
     * ADMIN INTENTS ARE EXEMPT, and the exemption is the identity model rather than a
     * convenience.
     *
     * A Telegram account that is bound as an administrator is ALSO resolved as a customer
     * here, because it is the same account. Customer standing and administrator standing
     * are independent in this product — `docs/research` records the legacy system
     * treating them as "mutually blind", and Phase 4A kept them separate deliberately. So
     * a blanket `bot.blocked` meant that blocking somebody's PURCHASES silently revoked
     * their management panel: the intent never reached `adminTurn`, and the only way back
     * was to unblock the customer, which is not what the operator who pressed Block
     * decided.
     *
     * Blocking is still enforced for everything a customer can do. This routes the admin
     * intents to the one door that resolves the binding, and `adminTurn` returning null —
     * a blocked customer who is NOT an administrator, including one crafting `D:<uuid>` —
     * falls back to the same `bot.blocked` as before. Authority is not granted here: every
     * admin action re-checks its own permission inside its own transaction.
     */
    // File 01 §9: the reason stored on THIS customer's own row, read as this turn resolved it.
    const blocked: PendingReply =
      arrival === 'BLOCKED'
        ? withBlockedSupportButton(
            blockedReply(customer),
            (await this.deps.support.partsFor(scope)).supportUrl,
          )
        : blockedReply(customer);
    /*
     * A blocked customer's plain message still reaches their amount capture when they are
     * an administrator with one open — the same exemption the admin intents have, for the
     * same reason: blocking somebody's purchases is not revoking their panel.
     */
    const blockedAdminText =
      arrival === 'BLOCKED' && command.intent === 'USERNAME_TEXT' && command.args?.[0] !== undefined
        ? await this.adminCaptureText(scope, actor, command.args[0], input)
        : null;
    /*
     * R2 (items 3 and 5): the two gates a tap passes BEFORE any work runs.
     *
     * A receipt-review tap on a message already finalised into its decision is answered —
     * `answerCallbackQuery`, below — and nothing else: the decision is never asked for a
     * second time, and no message is sent or edited.
     *
     * A wizard tap claims its message: honoured only while the message still shows the
     * screen the button belongs to and no other turn holds it. A stale tap is answered the
     * same way, so a double tap or an old keyboard cannot move the wizard backward or repeat
     * a draft, a payment or an invoice. The services behind every step still re-decide their
     * own writes under their own locks; this only stops the surface asking twice.
     */
    const origin = callbackOriginOf(input.update);
    const state = this.deps.messageState;
    const reviewRecord =
      state !== undefined && origin !== null && REVIEW_TAP_INTENTS.has(command.intent)
        ? await state.findReview(scope, this.refOf(input.botInstanceId, origin))
        : null;
    /*
     * Retention (docs/telegram-retention.md): a review tap on a message with NO row, at or
     * below the chat's purge horizon, is a tap on a message whose row the sweep removed —
     * which it does only once the payment is terminal. Answered and nothing else, like a
     * finalised one: the decision is never asked for again.
     */
    const retiredReview =
      state !== undefined &&
      origin !== null &&
      reviewRecord === null &&
      REVIEW_TAP_INTENTS.has(command.intent) &&
      (await state.reviewTapIsRetired(scope, this.refOf(input.botInstanceId, origin)));
    const repeatedReview = (reviewRecord?.finalisedAt ?? null) !== null || retiredReview;
    const gate = WIZARD_GATES.get(command.intent);
    let claim: TelegramWizardRecord | null = null;
    let staleWizard = false;
    if (state !== undefined && gate !== undefined && origin !== null && arrival !== 'BLOCKED') {
      const claimed = await state.claim(scope, actor, {
        ref: this.refOf(input.botInstanceId, origin),
        kind: gate.kind,
        adoptAs: gate.adoptAs,
        from: gate.from,
        updateKey: input.idempotencyKey,
      });
      if (claimed.outcome === 'CLAIMED') claim = claimed.wizard;
      else if (claimed.outcome === 'STALE') {
        // Lenient only for a CLOSED wizard; a message another turn still holds is swallowed.
        staleWizard = gate.lenient !== true || claimed.held === true;
      }
    }
    /*
     * F1 (round N): a repeated review tap is still answered and nothing else — but with the
     * truthful notice of what was decided (e.g. «این پرداخت قبلاً تأیید شده است.»).
     */
    const repeatToast =
      repeatedReview && reviewRecord !== null
        ? await this.repeatedReviewToast(scope, actor, input.telegramUserId, reviewRecord.paymentId)
        : {};
    let answered: PendingReply;
    try {
      answered =
        repeatedReview || staleWizard
          ? { key: null, values: {}, buttons: [], orderId: null, ...repeatToast }
          : arrival === 'BLOCKED'
            ? (blockedAdminText ??
              (ADMIN_INTENTS.has(command.intent)
                ? await this.adminTurn(scope, actor, command, input)
                : null) ??
              // Round N close (§D): a blocked customer's /stop is still their preference.
              // Blocking stops what they can BUY; it does not make a promotion welcome, and
              // a MARKETING send to an audience that admits blocked customers reads this row.
              (command.intent === 'MARKETING_OPT_OUT' || command.intent === 'MARKETING_OPT_IN'
                ? await this.marketingPreference(
                    scope,
                    actor,
                    customer,
                    command.intent === 'MARKETING_OPT_OUT',
                    input.idempotencyKey,
                  )
                : null) ??
              blocked)
            : await this.guardedAct(scope, actor, command, customer, arrival, input);
    } catch (error) {
      // A turn that failed gives its claim back rather than freezing the message for its lease.
      if (state !== undefined && claim !== null) {
        await state.release(scope, actor, claim).catch(() => false);
      }
      throw error;
    }
    /*
     * A blocked customer who is still over the limit is not answered (brief §3.5: protect
     * the transport from outbound amplification). Only the interaction that TOOK the block
     * is told why; every other one past the limit sends nothing, so a flood cannot become
     * one reply per message. A button press is still answered below — `stopSpinner` — so
     * no spinner hangs. Once the customer slows down, each message is answered with the
     * stored reason again.
     *
     * The turn that took the block, whatever its verdict — not "the 21st". The 21st may be
     * a `/ping`, which the webhook answers without blocking, or a turn that failed before
     * its block committed, and the block then lands on a later one; silencing that one
     * blocked the customer without a word. And under concurrency the 21st can lose the
     * block to a later turn, so answering the 21st as well would tell them twice.
     */
    const reply: PendingReply =
      spam !== null &&
      spam.verdict !== 'ALLOWED' &&
      arrival === 'BLOCKED' &&
      answered === blocked &&
      !blockedThisTurn
        ? { key: null, values: {}, buttons: [], orderId: null }
        : answered;

    const chatId = privateChatIdOf(input.update);
    // R2: a reply that sends nothing gives its wizard claim back unchanged.
    if (state !== undefined && claim !== null && (reply.key === null || chatId === null)) {
      await state.release(scope, actor, claim);
    }

    /*
     * 3. The reply, after the commit, and only into a private chat.
     *
     * A REDELIVERED update replies AGAIN, and that is a decision rather than an
     * oversight. Every durable effect above is idempotent — the customer row, the
     * audit rows, the order, the `OrderConfirmed` event — so a replay repeats none of
     * them. The reply cannot join them: Telegram's `sendMessage` has no idempotency
     * key, so "exactly once" is not on offer and the choice is between a duplicate
     * message and a missing one.
     *
     * Telegram redelivers precisely when it did not see a 200, which includes the
     * case where the first turn committed and the send never happened. Suppressing
     * the reply on a replay would leave that customer staring at nothing, for ever,
     * with nothing anywhere saying so — the invisible failure this codebase exists
     * to remove. A second copy of the same summary is visible and self-correcting.
     *
     * What would change this is persisting the SEND OUTCOME and re-sending only when
     * the first one was not `DELIVERED`. That needs a second durable write after the
     * commit, which is a mechanism rather than a line. Nothing sent here costs money
     * to duplicate: the most a customer sees twice is one order summary naming the
     * SAME order, because the idempotency key is the update's.
     *
     * One stated exception: a filed receipt (A10, `submitReceipt`) answers its redelivery
     * with NOTHING — the PO's instruction is one new message per payment, keyed on its first
     * receipt row.
     */
    if (reply.key === null || chatId === null) {
      await this.stopSpinner(scope, command, input.botInstanceId, reply.toast);
      return {
        intent,
        arrival,
        customerId: customer.id,
        replyKey: reply.key,
        orderId: reply.orderId,
        sent: 'NOT_ATTEMPTED',
      };
    }

    /*
     * R2 (item 3): a receipt decision edits the ORIGINAL review message — and the prompts it
     * opened — in place. Null means there was nothing recorded to edit, and the reply goes
     * out as it always did.
     */
    if (state !== undefined && origin !== null && reply.review?.outcome !== undefined) {
      const reviewed = await this.finaliseReview(
        scope,
        actor,
        reply,
        origin,
        input.botInstanceId,
        input.telegramUserId,
      );
      if (reviewed !== null) {
        await this.stopSpinner(scope, command, input.botInstanceId);
        return {
          intent,
          arrival,
          customerId: customer.id,
          replyKey: reply.key,
          orderId: reply.orderId,
          sent: reviewed,
        };
      }
    }

    /*
     * R2 (item 5): a wizard step is the SAME message, edited. Null means the reply is its own
     * message after all — a refusal the customer must be able to come back from, a typed
     * answer no wizard was waiting for — and it goes out as it always did.
     */
    if (state !== undefined && (claim !== null || reply.wizard?.anchor !== undefined)) {
      const edited = await this.editWizard(scope, actor, reply, claim, origin, chatId, input);
      if (edited !== null) {
        if (edited === 'DELIVERED' && reply.followUpKey !== undefined) {
          await this.deps.messenger.send(scope, {
            chatId,
            templateKey: reply.followUpKey,
            values: {},
            botInstanceId: input.botInstanceId,
          });
        }
        if (edited === 'RATE_LIMITED' && reply.fallback !== undefined) {
          await this.deps.queueRateLimitedFact(
            scope,
            customer.id,
            reply.fallback.kind,
            reply.fallback.subjectId,
            undefined,
          );
        }
        await this.stopSpinner(scope, command, input.botInstanceId, reply.toast);
        return {
          intent,
          arrival,
          customerId: customer.id,
          replyKey: reply.key,
          orderId: reply.orderId,
          sent: edited,
        };
      }
    }
    // A reply that is its own message after all: a receipt prompt's origin is still recorded.
    if (
      state !== undefined &&
      origin !== null &&
      reply.review?.origin !== undefined &&
      reply.review.paymentId !== null
    ) {
      await state.recordReview(scope, actor, {
        ref: this.refOf(input.botInstanceId, origin),
        paymentId: reply.review.paymentId,
        role: reply.review.origin,
        hasMedia: origin.media,
      });
    }

    // R2: whether the reply went out as text, so a file's text fallback is recorded as text.
    let wentAsText = false;
    const asText = () => {
      wentAsText = true;
      return this.deps.messenger.send(scope, {
        chatId,
        templateKey: reply.key as TemplateKey,
        values: reply.values,
        botInstanceId: input.botInstanceId,
        ...(reply.buttons.length === 0 ? {} : { buttons: reply.buttons }),
        ...(reply.keyboard === undefined ? {} : { keyboard: reply.keyboard }),
      });
    };
    /*
     * A reply that IS a file (§10's single review message) goes as the file with this
     * reply as its caption, and falls back to text only on a definite refusal — see
     * `PendingReply.media` for why not on the other two outcomes.
     */
    for (const lead of reply.lead ?? []) {
      let led =
        lead.kind === 'TEXT'
          ? await this.deps.messenger.send(scope, {
              chatId,
              templateKey: lead.key,
              values: lead.values,
              botInstanceId: input.botInstanceId,
            })
          : await this.deps.messenger.sendFile(scope, {
              chatId,
              botInstanceId: input.botInstanceId,
              kind: 'PHOTO',
              source: {
                kind: 'BYTES',
                bytes: lead.bytes,
                fileName: lead.fileName,
                mimeType: lead.mimeType,
              },
              ...(lead.caption !== undefined
                ? {
                    caption: { templateKey: lead.caption.key, values: lead.caption.values },
                    // Whole or not at all: a cut invite loses the link at its end.
                    captionWhole: true as const,
                  }
                : {}),
            });
      /*
       * R1: a CAPTIONED photo is a message, not a decoration (`LeadMessage.caption`).
       * Refused — a broken image, a caption over Telegram's bound — its words go out as
       * text, so the invite still arrives. UNKNOWN is not refused: it may have arrived,
       * and a second copy of the invite would be the duplicate the lane exists to avoid.
       */
      if (lead.kind === 'PHOTO_BYTES' && lead.caption !== undefined) {
        /*
         * Too long to be a caption (a tenant's longer invite; Codex, PR #111): the banner
         * goes bare and the invite follows as its own text, whole, link included. Two
         * messages rather than one cut one — the text is what a customer forwards, and a
         * forwarded invite without its link invites nobody. The bare banner is decorative
         * again, so its own failure is ignored.
         */
        if (led.outcome === 'REFUSED' && led.reason === 'CAPTION_OVER_BOUND') {
          await this.deps.messenger.sendFile(scope, {
            chatId,
            botInstanceId: input.botInstanceId,
            kind: 'PHOTO',
            source: {
              kind: 'BYTES',
              bytes: lead.bytes,
              fileName: lead.fileName,
              mimeType: lead.mimeType,
            },
          });
        }
        if (led.outcome === 'REFUSED') {
          led = await this.deps.messenger.send(scope, {
            chatId,
            templateKey: lead.caption.key,
            values: lead.caption.values,
            botInstanceId: input.botInstanceId,
          });
        }
        if (led.outcome === 'DELIVERED' || led.outcome === 'UNKNOWN') continue;
        await this.stopSpinner(scope, command, input.botInstanceId);
        return {
          intent,
          arrival,
          customerId: customer.id,
          replyKey: reply.key,
          orderId: reply.orderId,
          sent: led.outcome,
        };
      }
      if (led.outcome !== 'DELIVERED') {
        /*
         * A photo lead is the referral banner or a client app's picture (HF-A10): an
         * image an operator uploaded, which a structurally broken file or a transient
         * refusal can keep from going out on every request. The screen behind it — the
         * link, the gift, the statistics; the app's links and guide — is what the
         * customer asked for, so a picture that fails is dropped and the reply goes on. A TEXT lead is an earlier part of the one message, and a
         * keyboard without the text it belongs to is worse than no reply.
         */
        if (lead.kind === 'PHOTO_BYTES') continue;
        await this.stopSpinner(scope, command, input.botInstanceId);
        return {
          intent,
          arrival,
          customerId: customer.id,
          replyKey: reply.key,
          orderId: reply.orderId,
          sent: led.outcome,
        };
      }
    }
    /*
     * R3: a reply that edits the tapped message in place. The card-shaped replies only:
     * no lead and no media, which an `editMessageText` could not carry.
     */
    const editTarget =
      reply.edit === true && reply.media === undefined && (reply.lead ?? []).length === 0
        ? cardMessageOf(input.update, input.botInstanceId)
        : null;
    let sent =
      editTarget !== null
        ? await this.editOrSend(scope, editTarget, reply, asText)
        : reply.media === undefined
          ? await asText()
          : await this.deps.messenger.sendFile(scope, {
              chatId,
              botInstanceId: reply.media.botInstanceId,
              kind: reply.media.kind,
              source: { kind: 'FILE_ID', fileId: reply.media.fileId },
              caption: { templateKey: reply.key, values: reply.values },
              ...(reply.media.captionWhole === true ? { captionWhole: true as const } : {}),
              ...(reply.buttons.length === 0 ? {} : { buttons: reply.buttons }),
            });
    /*
     * A4: a whole-or-nothing caption over the bound — a long tutorial guide. The file goes
     * bare, decorative again, so its own outcome is ignored; the reply then goes as text below.
     */
    if (
      reply.media?.captionWhole === true &&
      sent.outcome === 'REFUSED' &&
      sent.reason === 'CAPTION_OVER_BOUND'
    ) {
      await this.deps.messenger.sendFile(scope, {
        chatId,
        botInstanceId: reply.media.botInstanceId,
        kind: reply.media.kind,
        source: { kind: 'FILE_ID', fileId: reply.media.fileId },
      });
    }
    if (reply.media !== undefined && sent.outcome === 'REFUSED') sent = await asText();
    /*
     * R2: a new message that IS a wizard screen or a review message is recorded against its
     * Telegram id, so the next tap on it — or the decision taken on it — edits it in place.
     */
    const sentAsFile = reply.media !== undefined && !wentAsText;
    if (state !== undefined && sent.outcome === 'DELIVERED' && sent.messageId !== undefined) {
      const ref = {
        // A receipt goes out from the bot that RECEIVED it, and its taps come back there.
        botInstanceId:
          sentAsFile && reply.media !== undefined ? reply.media.botInstanceId : input.botInstanceId,
        chatId,
        messageId: sent.messageId,
      };
      if (reply.wizard !== undefined && reply.wizard.placement !== 'NEW') {
        await state.register(scope, actor, {
          ref,
          landing: {
            kind: reply.wizard.kind,
            step: reply.wizard.step,
            subjectId: reply.wizard.subjectId ?? null,
            paymentId: reply.wizard.paymentId ?? null,
          },
        });
      }
      if (reply.review?.sent !== undefined && reply.review.paymentId !== null) {
        await state.recordReview(scope, actor, {
          ref,
          paymentId: reply.review.paymentId,
          role: reply.review.sent,
          hasMedia: sentAsFile,
        });
      }
    }
    for (const attachment of reply.attachments ?? []) {
      await this.deps.messenger.sendFile(scope, {
        chatId,
        botInstanceId: attachment.botInstanceId,
        kind: attachment.kind,
        source: { kind: 'FILE_ID', fileId: attachment.fileId },
      });
    }

    /*
     * The follow-up, after the answer and only if the answer went out.
     *
     * `docs/phase4h-audit.md` §5: a customer who had paid saw `bot.order.settled` and
     * then nothing at all until the subscription link arrived, however long that took.
     * This is the sentence for that window.
     *
     * Its outcome is NOT the turn's, and that asymmetry is the point. The turn reports
     * whether the customer was told the thing that mattered — that their money arrived
     * — and a failed note about provisioning must not make a successful settlement look
     * like a failed send in the operational log. The customer meets the same fact again
     * when the link arrives, or through `bot.service.provision_delayed` if it does not.
     */
    if (reply.followUpKey !== undefined && sent.outcome === 'DELIVERED') {
      await this.deps.messenger.send(scope, {
        chatId,
        templateKey: reply.followUpKey,
        values: {},
        botInstanceId: input.botInstanceId,
      });
    }

    /*
     * A rate-limited FACT goes on the lane rather than being lost.
     *
     * `OQ-4H-01`. The durable write has already committed by the time this runs —
     * the transfer claim is recorded, the order is cancelled — and Telegram
     * answered 429. Telegram does not redeliver the update and nothing here
     * rescheduled the reply, so the customer was left believing nothing happened.
     * For a transfer that means sending the money twice.
     *
     * ONLY on `RATE_LIMITED`, and the narrowness is the design:
     *
     * - `DELIVERED` needs nothing.
     * - `REFUSED` is Telegram saying it will never accept this — a blocked bot, a
     *   dead chat — and queueing a second copy would produce a row the dispatcher
     *   burns attempts on for a destination that is gone.
     * - `UNKNOWN` is the one this must not touch. The send may have arrived; the
     *   lane's own `UNCONFIRMED` state exists because a retried "your payment was
     *   rejected" is a customer wondering which message is true, and this would
     *   be that mistake one layer up.
     *
     * The enqueue is idempotent by `customer_notifications_subject_key`, so a
     * customer who taps twice and is limited twice still hears once. It is also
     * the only write here and it happens AFTER the business transaction closed,
     * so nothing is held open across a Telegram call.
     */
    if (sent.outcome === 'RATE_LIMITED' && reply.fallback !== undefined) {
      await this.deps.queueRateLimitedFact(
        scope,
        customer.id,
        reply.fallback.kind,
        reply.fallback.subjectId,
        sent.retryAfterMs,
      );
    }

    // After the real answer, not before it. The spinner is cosmetic and its failure is
    // silent; putting it first would let a slow acknowledgement delay the message the
    // customer is actually waiting for.
    await this.stopSpinner(scope, command, input.botInstanceId, reply.toast);

    return {
      intent,
      arrival,
      customerId: customer.id,
      replyKey: reply.key,
      orderId: reply.orderId,
      sent: sent.outcome,
    };
  }

  /** Forwarder: the body lives in `runtime/admin-flow.ts` (R9 split). */
  adminTurn(
    scope: TenantContext,
    actor: ActorContext,
    command: BotCommand,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
      readonly telegramUserId: string;
    },
  ): Promise<PendingReply | null> {
    return adminFlow.adminTurn(this, scope, actor, command, input);
  }

  /**
   * Whether this turn's Telegram account is an administrator with a panel.
   *
   * Used for ONE thing — whether `/start` draws the panel row — and it makes the same
   * resolution the actions make, so the keyboard cannot promise a section the guard
   * would refuse. It answers false for every case `adminTurn` treats as "not an
   * administrator", including an ACTIVE administrator holding neither panel permission.
   */
  async isAdmin(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly telegramUserId: string },
  ): Promise<boolean> {
    const admins = this.deps.telegramAdmins;
    if (admins === undefined) return false;
    const identity = await admins.resolve(scope, input.telegramUserId, actor.correlationId);
    if (identity === null) return false;
    /*
     * The SAME list `adminTurn` gates on, and now literally the same one.
     *
     * The rule has always been that the keyboard must not promise a panel the turn
     * would refuse, and must not withhold one from an administrator who has a section.
     * It was two hand-kept copies, and they had already diverged over the reminders
     * section — see `PANEL_SECTION_PERMISSIONS` for what that cost.
     */
    return hasAnyPanelSection(identity.permissions);
  }

  /** Forwarder: the body lives in `runtime/admin-flow.ts` (R9 split). */
  adminCaptureText(
    scope: TenantContext,
    actor: ActorContext,
    text: string,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly telegramUserId: string;
      readonly update?: unknown;
    },
  ): Promise<PendingReply | null> {
    return adminFlow.adminCaptureText(this, scope, actor, text, input);
  }

  /**
   * The mandatory channel membership guard (Package B, audit §2.6), in front of `act` and
   * nowhere else — one guard, not a check copied into each handler.
   *
   * Runs after the customer is resolved and counted, so a `/start ref-…` still attributes
   * and anti-spam still sees the interaction; only the business action is withheld. Exempt:
   * the management panel, support and help (`/paysupport` opens support), and the check
   * itself. A bound administrator is never locked out, and the binding is asked only when
   * something is missing, so an ordinary turn pays for no extra lookup.
   *
   * The check button answers the MAIN MENU on a pass. It never replays what the customer
   * first asked for: a purchase, a payment or a termination is not something a membership
   * check may run.
   */
  async guardedAct(
    scope: TenantContext,
    actor: ActorContext,
    command: BotCommand,
    customer: CustomerRecord,
    arrival: CustomerArrival,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
      readonly telegramUserId: string;
    },
  ): Promise<PendingReply> {
    const checking = command.intent === 'MEMBERSHIP_CHECK';
    const safe: BotCommand = checking
      ? { intent: 'MAIN_MENU', targetId: null, callbackQueryId: command.callbackQueryId }
      : command;
    const membership = this.deps.membership;
    if (
      membership === undefined ||
      /*
       * Customer 360 (§11.4): an operator's per-customer exemption, read from the row this
       * update resolved — so it is enforced HERE, at the one gate, and an exemption lifted
       * a moment ago applies to the very next update. Telegram is not asked at all.
       */
      customer.channelMembershipExemptAt !== null ||
      (!checking &&
        (MEMBERSHIP_EXEMPT_INTENTS.has(command.intent) || ADMIN_INTENTS.has(command.intent)))
    ) {
      return this.termsGatedAct(scope, actor, safe, customer, arrival, input);
    }
    const missing = await membership.missingRequired(scope, {
      botInstanceId: input.botInstanceId,
      telegramUserId: input.telegramUserId,
      fresh: checking,
    });
    if (
      missing.length === 0 ||
      (await this.deps.telegramAdmins?.resolve(scope, input.telegramUserId, actor.correlationId)) !=
        null
    ) {
      return this.termsGatedAct(scope, actor, safe, customer, arrival, input);
    }
    return membershipRequired(
      checking ? 'bot.channels.still_missing' : 'bot.channels.join_required',
      missing,
    );
  }

  /**
   * The terms and rules gate (program §6), the second half of the ONE central guard: it
   * runs only behind the membership gate, and `act` is reached only through it. Not a check
   * copied into handlers — a handler cannot forget it, and a crafted callback for any
   * customer action meets it like a tapped one.
   *
   * While enforcement is on and the customer has not accepted the CURRENT published
   * version, every customer intent is answered with that version and its accept button
   * instead. Exempt, as from the membership gate: support, help, the promotional opt-out
   * and the management panel; a bound administrator is never stopped. The requirement is
   * asked only for an intent that would be gated, so the exempt ones pay for no lookup.
   *
   * The accept button is the only way through. It names the version it was drawn under:
   * that version is recorded only while it is still the current one, and a button under an
   * older message answers with the version that replaced it. After acceptance the terms
   * message is edited into the accepted text with the way to the main menu (Batch 01 item
   * 1) — never a replay of what they first asked for, and never a second message.
   */
  async termsGatedAct(
    scope: TenantContext,
    actor: ActorContext,
    command: BotCommand,
    customer: CustomerRecord,
    arrival: CustomerArrival,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
      readonly telegramUserId: string;
    },
  ): Promise<PendingReply> {
    const terms = this.deps.terms;
    if (command.intent === 'TERMS_ACCEPT') {
      return this.acceptTerms(scope, actor, command, customer, arrival, input);
    }
    if (
      terms === undefined ||
      MEMBERSHIP_EXEMPT_INTENTS.has(command.intent) ||
      ADMIN_INTENTS.has(command.intent)
    ) {
      return this.act(scope, actor, command, customer, arrival, input);
    }
    const required = await terms.requirement(scope, customer.id);
    if (
      required === null ||
      (await this.deps.telegramAdmins?.resolve(scope, input.telegramUserId, actor.correlationId)) !=
        null
    ) {
      return this.act(scope, actor, command, customer, arrival, input);
    }
    return termsRequired('bot.terms.required', required);
  }

  async acceptTerms(
    scope: TenantContext,
    actor: ActorContext,
    command: BotCommand,
    customer: CustomerRecord,
    arrival: CustomerArrival,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
      readonly telegramUserId: string;
    },
  ): Promise<PendingReply> {
    const menu: BotCommand = {
      intent: 'MAIN_MENU',
      targetId: null,
      callbackQueryId: command.callbackQueryId,
    };
    const terms = this.deps.terms;
    if (terms === undefined || command.targetId === null) {
      return this.act(scope, actor, menu, customer, arrival, input);
    }
    // The update's key is already spent by `resolveFromUpdate` under this surface: the
    // acceptance is a second command of the same turn, so it takes the turn's sub-key.
    const accepted = await terms.accept(scope, actor, {
      idempotencyKey: `${input.idempotencyKey}:terms`,
      customerId: customer.id,
      termsVersionId: command.targetId,
      botInstanceId: input.botInstanceId,
    });
    if (accepted.outcome === 'STALE') {
      /*
       * Nothing was recorded. When a newer version replaced the one shown, it is shown now
       * with its own button — whatever enforcement says, because the customer asked to
       * accept the rules and the rules they would be accepting are these. When nothing is
       * published any more, there is nothing to accept: the main menu.
       */
      return accepted.current === null
        ? this.act(scope, actor, menu, customer, arrival, input)
        : termsStaleReply(accepted.current);
    }
    /*
     * Batch 01 item 1: the terms message the customer tapped is EDITED into the accepted
     * text — no second message. A repeated tap or a redelivered update edits it into the
     * same text again, which Telegram answers "message is not modified" and the messenger
     * counts as delivered, so nothing is sent then either.
     */
    return termsAcceptedReply();
  }

  /**
   * What this intent produces, as a reply that has not been sent yet.
   *
   * Every branch returns; there is no fallthrough that leaves a customer unanswered,
   * which is the failure mode the legacy bot has for anything it does not recognise.
   */
  async act(
    scope: TenantContext,
    actor: ActorContext,
    command: BotCommand,
    customer: CustomerRecord,
    arrival: CustomerArrival,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
      /**
       * WHO sent it, by Telegram's numeric id.
       *
       * Carried because the management panel resolves an administrator from it, and
       * never used as a fact about a customer — `resolveFromUpdate` already turned it
       * into a row before this runs. Never a username: usernames are reassignable and a
       * customer can choose one that looks like an administrator's.
       */
      readonly telegramUserId: string;
    },
  ): Promise<PendingReply> {
    /*
     * Item 12 (C4): a TAPPED button this runtime could not read — a MirzaBot keyboard still
     * in a chat after cutover (same token), a keyboard from an older release, or data a
     * client truncated or made up. `intentOf` already refused to map it onto any action;
     * this answers it truthfully: the button is no longer active, and here is the main
     * menu. Decided first, so no handler below ever sees it, and with nothing read from the
     * data. A typed message nobody recognises keeps `bot.unknown_command`.
     */
    if (command.intent === 'UNSUPPORTED' && isCallbackQueryUpdate(input.update)) {
      return staleCallbackReply();
    }
    if (command.intent === 'CATALOG') return this.catalogue(scope, actor, 0, customer);
    if (command.intent === 'CATALOG_PAGE') {
      return this.catalogue(scope, actor, command.page ?? 0, customer);
    }
    if (command.intent === 'TRIAL_CLAIM') {
      return this.beginTrial(scope, actor, customer, input.idempotencyKey);
    }
    if (command.intent === 'TRIAL_PANEL' && command.targetId !== null) {
      return this.claimTrial(scope, actor, customer, command.targetId, input.idempotencyKey);
    }
    if (command.intent === 'CUSTOM_SERVICE_MENU') {
      return this.customServiceMenu(scope, actor, customer);
    }
    if (command.intent === 'CUSTOM_SERVICE_LOCATION' && command.targetId !== null) {
      return this.customServiceLocation(scope, actor, customer, command.targetId, {
        idempotencyKey: input.idempotencyKey,
        botInstanceId: input.botInstanceId,
      });
    }
    if (command.intent === 'CATEGORY' && command.targetId !== null) {
      return this.categoryPage(scope, actor, command.targetId, command.page ?? 0, customer.id);
    }
    if (command.intent === 'ORDER' && command.targetId !== null) {
      return this.draft(
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'CONFIRM' && command.targetId !== null) {
      return this.confirm(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    if (command.intent === 'USERNAME_CUSTOM' && command.targetId !== null) {
      return this.customUsername(
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'USERNAME_AUTOMATIC' && command.targetId !== null) {
      return this.automaticUsername(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    if (command.intent === 'DISCOUNT_CODE_ENTER' && command.targetId !== null) {
      return this.enterDiscountCode(
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'DISCOUNT_CODE_REMOVE' && command.targetId !== null) {
      return this.removeDiscountCode(
        scope,
        actor,
        command.targetId,
        customer,
        input.idempotencyKey,
      );
    }
    /*
     * The one intent produced by an ordinary message, and the one place this surface
     * asks the database what an ordinary message meant.
     *
     * `args[0]` is the raw text, untouched: `isValidCustomUsername` is asked of the raw
     * input, and a surface that trimmed it first would be deciding what the customer
     * typed. `NO_WINDOW` returns the same fallback any unrecognised string has always
     * got, which is what makes routing plain text here safe.
     */
    if (command.intent === 'USERNAME_TEXT') {
      const text = command.args?.[0];
      /*
       * An administrator's amount capture is asked FIRST, and only answers for a sender
       * whose own capture is waiting (Payment File 02 §12). A customer's username window
       * is theirs as a customer; the two never read the same message, because a capture
       * that answers returns here and one that does not falls through untouched.
       */
      const amount =
        text === undefined ? null : await this.adminCaptureText(scope, actor, text, input);
      if (amount !== null) return amount;
      /*
       * The customer's own text window next (customer UX completion §N): an amount, a
       * search term or a note, whichever prompt they saw last. A window that is not
       * open answers NO_WINDOW and the message goes on to the order windows untouched.
       */
      const captured =
        text === undefined ? null : await this.capturedText(scope, actor, customer, text, input);
      if (captured !== null) return captured;
      if (text !== undefined) {
        return this.typedUsername(
          scope,
          actor,
          text,
          customer,
          input.botInstanceId,
          input.idempotencyKey,
        );
      }
    }
    if (command.intent === 'WALLET') return this.walletBalance(scope, actor, customer);
    if (command.intent === 'MARKETING_OPT_OUT' || command.intent === 'MARKETING_OPT_IN') {
      return this.marketingPreference(
        scope,
        actor,
        customer,
        command.intent === 'MARKETING_OPT_OUT',
        input.idempotencyKey,
      );
    }
    if (
      command.intent === 'MAIN_MENU' ||
      command.intent === 'HELP' ||
      command.intent === 'SUPPORT'
    ) {
      if (command.intent !== 'MAIN_MENU') return this.supportScreen(scope, customer);
      return {
        ...(await this.startGreeting(scope, actor, customer, 'bot.start.welcome_back')),
        buttons: [],
        orderId: null,
        keyboard: (await this.isAdmin(scope, actor, input)) ? 'MAIN_MENU_ADMIN' : 'MAIN_MENU',
      };
    }
    // WP-A7: the customer's support tickets.
    const ticketed = await this.ticketTurn(scope, actor, command, customer, input);
    if (ticketed !== null) return ticketed;
    if (command.intent === 'TUTORIAL') return this.tutorialChoice(scope, customer);
    if (command.intent === 'TUTORIAL_PLATFORM' && command.targetId !== null) {
      return this.tutorialPlatform(scope, customer, command.targetId as ClientAppPlatform);
    }
    if (command.intent === 'CLIENT_APP' && command.targetId !== null) {
      return this.clientApp(scope, customer, command.targetId, input.botInstanceId);
    }
    if (command.intent === 'SERVICE_CONNECTED' && command.targetId !== null) {
      // Acknowledged, and NOTHING is written: the customer told us a fact about their
      // own device, and a row saying so would be a claim this installation cannot check.
      const owned = await this.ownedService(scope, customer, command.targetId);
      return {
        key: owned === null ? 'bot.service.not_found' : 'bot.service.connected_ack',
        values: {},
        buttons: [mainMenuButton()],
        orderId: null,
      };
    }
    if (command.intent === 'TOPUP_MENU') {
      return this.topupBegin(scope, actor, customer, input.botInstanceId, input.idempotencyKey);
    }
    if (
      command.intent === 'TOPUP_ROUTE' &&
      command.targetId !== null &&
      command.secondaryId != null
    ) {
      return this.topupRoute(
        scope,
        actor,
        customer,
        command.targetId,
        command.secondaryId as PaymentGatewayProvider,
      );
    }
    if (command.intent === 'TOPUP_CLOSE' && command.targetId !== null) {
      return this.topupClose(scope, actor, customer, command.targetId);
    }
    if (command.intent === 'SERVICES_SEARCH') {
      return this.servicesSearchBegin(
        scope,
        actor,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'SERVICE_REFRESH' && command.targetId !== null) {
      return this.serviceRefresh(scope, actor, customer, command.targetId, input.idempotencyKey);
    }
    if (command.intent === 'SERVICE_CARD' && command.targetId !== null) {
      const card = await this.openServiceCard(scope, actor, customer, command.targetId);
      /*
       * Owner spec §2.3: a stale tap — a service transferred, refunded or never theirs —
       * still edits the list's message, and keeps the way back to the list on it, so the
       * customer is never left on a dead end where their list was.
       */
      return card.key === 'bot.service.not_found'
        ? { ...card, buttons: [backToListButton()], edit: true }
        : { ...card, edit: true };
    }
    /*
     * Round N (F4): every screen a service card's button opens is edited INTO the card's
     * message (`inCard`), and its way back (`sv:`) draws the same card in place again.
     */
    if (command.intent === 'SERVICE_NOTE' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await this.serviceNoteBegin(
          scope,
          actor,
          customer,
          command.targetId,
          input.botInstanceId,
          input.idempotencyKey,
        ),
      );
    }
    if (command.intent === 'SERVICE_RENEW_QUOTE' && command.targetId !== null) {
      // The quote opens the payment wizard, which is its own message (R2).
      return this.commercialQuote(scope, actor, customer, command.targetId, 'RENEW', null, input);
    }
    if (
      command.intent === 'SERVICE_RENEW_PLAN' &&
      command.targetId !== null &&
      command.secondaryId != null
    ) {
      // An imported service's chosen plan; the draft re-decides it against the panel's plans.
      return this.commercialQuote(
        scope,
        actor,
        customer,
        command.targetId,
        'RENEW',
        null,
        input,
        undefined,
        undefined,
        command.secondaryId,
      );
    }
    if (command.intent === 'REFERRAL_GIFT') {
      return this.referralGift(scope, actor, customer, input.idempotencyKey);
    }
    if (command.intent === 'REFERRAL_INVITE') {
      return this.referralInvite(scope, actor, customer, input.botInstanceId, input.idempotencyKey);
    }
    if (command.intent === 'TOPUP_PICK' && command.targetId !== null) {
      return this.topupPick(
        scope,
        actor,
        command.targetId,
        customer,
        input.idempotencyKey,
        input.botInstanceId,
      );
    }
    if (command.intent === 'PAY_WALLET' && command.targetId !== null) {
      return this.walletPayment(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    if (command.intent === 'PAY_MANUAL' && command.targetId !== null) {
      return this.manualPayment(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    if (command.intent === 'PAY_METHODS' && command.targetId !== null) {
      return this.paymentMethods(scope, actor, command.targetId, customer);
    }
    if (command.intent === 'PAY_METHODS_CLOSE' && command.targetId !== null) {
      const back = await this.paymentMethodsBack(scope, actor, command.targetId, customer);
      if (back !== null) return back;
      return {
        ...(await this.startGreeting(scope, actor, customer, 'bot.start.welcome_back')),
        buttons: [],
        orderId: null,
        keyboard: (await this.isAdmin(scope, actor, input)) ? 'MAIN_MENU_ADMIN' : 'MAIN_MENU',
      };
    }
    /*
     * A rail with no adapter, answered rather than simulated.
     *
     * No button offers it — `paymentButtons` draws only what can be performed — so this
     * is reached by a customer holding an older message, and it is the one place that
     * answer is produced. Nothing here pretends money moved.
     */
    if (command.intent === 'PAY_GATEWAY' && command.targetId !== null) {
      return this.gatewayPayment(
        scope,
        actor,
        command.targetId,
        customer,
        input.idempotencyKey,
        (command.secondaryId as PaymentGatewayProvider | undefined) ?? null,
      );
    }
    if (
      (command.intent === 'GATEWAY_CHECK' || command.intent === 'GATEWAY_RETURN') &&
      command.targetId !== null
    ) {
      // A return is the same question as a tap on «بررسی وضعیت»: the payment's own state, read
      // now, with a verify brought forward - and answered as closed for anyone else's payment.
      return this.gatewayCheck(scope, command.targetId, customer);
    }
    if (command.intent === 'GATEWAY_RECEIPT' && command.targetId !== null) {
      return this.gatewayReceipt(scope, actor, command.targetId, customer, input.botInstanceId);
    }
    if (command.intent === 'GATEWAY_CARD_CHANGE' && command.targetId !== null) {
      return this.gatewayCardChange(
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'GATEWAY_CANCEL_ASK' && command.targetId !== null) {
      return this.gatewayCancelAsk(scope, command.targetId, customer, input.botInstanceId);
    }
    if (command.intent === 'GATEWAY_CANCEL' && command.targetId !== null) {
      return this.gatewayCancel(
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'GATEWAY_REFUND_CARD' && command.targetId !== null) {
      return this.gatewayRefundCardPrompt(
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
        updateIdOf(input.update),
      );
    }
    if (command.intent === 'PAY_CANCEL_ASK' && command.targetId !== null) {
      return this.cancelPaymentAsk(scope, command.targetId, customer);
    }
    if (command.intent === 'PAY_CANCEL' && command.targetId !== null) {
      return this.cancelPayment(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    if (command.intent === 'RECEIPT_UPLOAD' && command.file != null) {
      /*
       * WP-A7: a file answers a ticket window when that is the prompt the customer saw last;
       * otherwise it is a receipt, exactly as before.
       */
      const ticketFile = await this.ticketFile(scope, actor, customer, command.file, input);
      if (ticketFile !== null) return ticketFile;
      /*
       * TonPays Telegram (§8.3): a provider receipt window open for this customer IN THIS
       * BOT takes the file; its payment, provider and invoice come from the window's row.
       * Never the manual review queue. No window: the manual flow, exactly as before.
       */
      const providerReceipt = await this.gatewayReceiptPhoto(
        scope,
        actor,
        customer,
        input.botInstanceId,
        command.file,
      );
      if (providerReceipt !== null) return providerReceipt;
      return this.submitReceipt(
        scope,
        actor,
        customer,
        input.botInstanceId,
        privateChatIdOf(input.update),
        command.file,
        input.idempotencyKey,
      );
    }
    if (
      command.intent === 'PAY_SWITCH_CARD' &&
      command.targetId !== null &&
      command.secondaryId != null
    ) {
      return this.switchCard(
        scope,
        actor,
        command.targetId,
        Number(command.secondaryId),
        customer,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'PAY_SENT' && command.targetId !== null) {
      return this.signalTransferSent(
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'ORDER_CANCEL_ASK' && command.targetId !== null) {
      return this.cancelOrderAsk(scope, command.targetId, customer);
    }
    if (command.intent === 'ORDER_CANCEL' && command.targetId !== null) {
      return this.cancelOrder(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    if (command.intent === 'SERVICE_RENEW' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await this.renewMenu(scope, actor, customer, command.targetId),
      );
    }
    if (command.intent === 'SERVICE_ADD_TRAFFIC' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await this.addonChoice(scope, actor, customer, command.targetId, 'ADD_TRAFFIC'),
      );
    }
    if (command.intent === 'SERVICE_ADD_TIME' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await this.addonChoice(scope, actor, customer, command.targetId, 'ADD_TIME'),
      );
    }
    if (
      command.intent === 'SERVICE_BUY_TRAFFIC' &&
      command.targetId !== null &&
      command.secondaryId != null
    ) {
      return this.commercialQuote(
        scope,
        actor,
        customer,
        command.targetId,
        'ADD_TRAFFIC',
        command.secondaryId,
        input,
      );
    }
    if (
      command.intent === 'SERVICE_BUY_TIME' &&
      command.targetId !== null &&
      command.secondaryId != null
    ) {
      return this.commercialQuote(
        scope,
        actor,
        customer,
        command.targetId,
        'ADD_TIME',
        command.secondaryId,
        input,
      );
    }
    if (command.intent === 'SERVICE_ADD_DEVICES' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await this.devicesChoice(scope, actor, customer, command.targetId),
      );
    }
    if (
      command.intent === 'SERVICE_BUY_DEVICES' &&
      command.targetId !== null &&
      command.secondaryId != null &&
      command.quantity !== undefined
    ) {
      return this.commercialQuote(
        scope,
        actor,
        customer,
        command.targetId,
        'ADD_DEVICES',
        command.secondaryId,
        input,
        command.quantity,
      );
    }
    if (command.intent === 'SERVICE_CHANGE_LOCATION' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await this.locationChoice(scope, actor, customer, command.targetId),
      );
    }
    if (
      command.intent === 'SERVICE_LOCATION_TARGET' &&
      command.targetId !== null &&
      command.secondaryId != null
    ) {
      return inCard(
        command.targetId,
        await this.locationTarget(
          scope,
          actor,
          customer,
          command.targetId,
          command.secondaryId,
          input,
        ),
      );
    }
    if (
      command.intent === 'SERVICE_LOCATION_CONFIRM' &&
      command.targetId !== null &&
      command.secondaryId != null
    ) {
      return inCard(
        command.targetId,
        await this.locationRequest(
          scope,
          actor,
          customer,
          command.targetId,
          command.secondaryId,
          input,
        ),
      );
    }
    if (command.intent === 'SERVICE_ACTION_CONFIRM' && command.targetId !== null) {
      return this.commercialConfirm(scope, actor, customer, command.targetId, input);
    }
    if (command.intent === 'SERVICES') return this.services(scope, customer, 1);
    if (command.intent === 'SERVICES_PAGE') {
      // A keyset token from a message older than the paged list lands on page 1: the
      // token names a position in an ordering this list no longer uses.
      // Owner spec §2.3: a page, and «back to the list» from a card, EDIT the tapped
      // message — the list, the card and the list again are one message.
      return { ...(await this.services(scope, customer, command.page ?? 1)), edit: true };
    }
    if (command.intent === 'SERVICE' && command.targetId !== null) {
      return this.openServiceCard(scope, actor, customer, command.targetId);
    }
    if (command.intent === 'SERVICE_RESEND' && command.targetId !== null) {
      return this.serviceResend(scope, customer, command.targetId, input);
    }
    if (command.intent === 'SERVICE_FILES' && command.targetId !== null) {
      return this.serviceFiles(scope, actor, customer, command.targetId, input);
    }
    /*
     * B8: the switch's first tap draws the question IN the card and plans nothing — on any
     * card, so an old message's `u:` / `e:` can no longer act on one tap either.
     */
    if (command.intent === 'SERVICE_SUSPEND' && command.targetId !== null) {
      return this.serviceToggleAsk(scope, actor, customer, command.targetId, 'SUSPEND');
    }
    if (command.intent === 'SERVICE_RESUME' && command.targetId !== null) {
      return this.serviceToggleAsk(scope, actor, customer, command.targetId, 'RESUME');
    }
    if (command.intent === 'SERVICE_SUSPEND_CONFIRM' && command.targetId !== null) {
      return this.serviceAction(
        scope,
        actor,
        customer,
        command.targetId,
        'SUSPEND',
        input.idempotencyKey,
        cardMessageOf(input.update, input.botInstanceId),
      );
    }
    if (command.intent === 'SERVICE_RESUME_CONFIRM' && command.targetId !== null) {
      return this.serviceAction(
        scope,
        actor,
        customer,
        command.targetId,
        'RESUME',
        input.idempotencyKey,
        cardMessageOf(input.update, input.botInstanceId),
      );
    }
    /*
     * WP15 G1: a customer cannot terminate a service. Both taps are still RECOGNISED —
     * a message drawn before this release still carries the buttons, and a bookmark or
     * a replayed callback carries the data — and both answer the same refusal a service
     * that cannot do something already gives. Neither looks the service up, plans an
     * operation or contacts anything: the refusal is about the customer, not the row.
     */
    if (command.intent === 'SERVICE_TERMINATE_ASK' || command.intent === 'SERVICE_TERMINATE') {
      return { key: 'bot.service.capability_unsupported', values: {}, buttons: [], orderId: null };
    }
    if (command.intent === 'SERVICE_ROTATE_ASK' && command.targetId !== null) {
      return this.serviceRotateAsk(scope, customer, command.targetId);
    }
    if (command.intent === 'SERVICE_REFUND_ASK' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await this.serviceRefundAsk(scope, customer, command.targetId),
      );
    }
    if (command.intent === 'SERVICE_REFUND_CONFIRM' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await this.serviceRefundConfirm(
          scope,
          actor,
          customer,
          command.targetId,
          input.botInstanceId,
          input.idempotencyKey,
          updateIdOf(input.update),
        ),
      );
    }
    if (command.intent === 'SERVICE_TRANSFER_ASK' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await this.serviceTransferAsk(scope, actor, customer, command.targetId, input),
      );
    }
    if (
      command.intent === 'SERVICE_TRANSFER_CONFIRM' &&
      command.targetId !== null &&
      typeof command.secondaryId === 'string' &&
      command.ownershipVersion !== undefined
    ) {
      return inCard(
        command.targetId,
        await this.serviceTransferConfirm(
          scope,
          actor,
          customer,
          command.targetId,
          {
            recipientTelegramUserId: command.secondaryId,
            ownershipVersion: command.ownershipVersion,
          },
          input,
        ),
      );
    }
    if (command.intent === 'SERVICE_ROTATE' && command.targetId !== null) {
      /*
       * Suffixed, as every other write that shares a turn with `resolveFromUpdate` is
       * (`docs/wp6-audit.md` §4): the bare update key is already spent in that turn.
       */
      return this.serviceRotate(
        scope,
        actor,
        customer,
        command.targetId,
        `${input.idempotencyKey}:rotate`,
        cardMessageOf(input.update, input.botInstanceId),
      );
    }
    /*
     * The main menu rides on `/start`, and on nothing else.
     *
     * Real v0.2.0 staging acceptance is what put it here: the bot registered five
     * commands with Telegram and an ordinary customer still had to know to type a
     * slash. Telegram keeps a `ReplyKeyboardMarkup` shown until something replaces it,
     * so attaching it once — to the first message anybody ever receives — is enough,
     * and attaching it to every reply would fight the inline keyboards the contextual
     * flows use.
     *
     * A BLOCKED customer gets `bot.blocked` and NO keyboard: the reply above returns
     * before this, and drawing a menu for somebody who may not use it is the untruthful
     * surface this codebase keeps refusing.
     */
    /*
     * The management panel, and it is reached through ONE door.
     *
     * Every admin intent lands here, whoever sent it, and `adminTurn` resolves the
     * Telegram account's binding before it decides anything. A customer who crafts
     * `D:<uuid>` reaches this line, resolves to no administrator, and falls through to
     * the same unsupported-input reply below that any other unrecognised string gets.
     */
    if (ADMIN_INTENTS.has(command.intent)) {
      const reply = await this.adminTurn(scope, actor, command, input);
      if (reply !== null) return reply;
    }

    const key = replyFor(command.intent, arrival);
    /*
     * Item 12 (C4): a TAPPED button that reached this fallback — an admin-shaped callback
     * from somebody who is not (or no longer) an administrator with that section, as well
     * as the unreadable ones decided at the top of `act` — gets the same stale-button
     * answer. One answer for every button this account cannot use, so the reply is not an
     * oracle for which callback shapes are management routes.
     */
    if (key === 'bot.unknown_command' && isCallbackQueryUpdate(input.update)) {
      return staleCallbackReply();
    }
    /*
     * The admin row is added for a Telegram account that resolves to an administrator,
     * and the resolution is the SAME one every admin action makes. A keyboard is not
     * authority — the actions re-check — but a button nobody behind it can use is the
     * untruthful surface this codebase keeps refusing.
     */
    const menu =
      command.intent === 'START'
        ? ({
            keyboard: (await this.isAdmin(scope, actor, input)) ? 'MAIN_MENU_ADMIN' : 'MAIN_MENU',
          } as const)
        : {};
    // R6 item 3: only the two greetings take variables, and only this customer's own.
    const greeting =
      key === 'bot.start.welcome' || key === 'bot.start.welcome_back'
        ? await this.startGreeting(scope, actor, customer, key)
        : { key, values: {} };
    return { ...greeting, buttons: [], orderId: null, ...menu };
  }

  startGreeting(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    key: StartGreetingKey,
  ): Promise<{ readonly key: TemplateKey; readonly values: TemplateValues }> {
    return startMenuFlow.startGreeting(this, scope, actor, customer, key);
  }

  services(
    scope: TenantContext,
    customer: CustomerRecord,
    pageNumber: number,
  ): Promise<PendingReply> {
    return serviceCardFlow.services(this, scope, customer, pageNumber);
  }

  /** Public: the provisioner edits the card through this (`container.ts`). */
  serviceCardFor(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    serviceId: string,
    notice?: TemplateKey,
  ): Promise<{
    readonly key: TemplateKey;
    readonly values: TemplateValues;
    readonly buttons: readonly CustomerButton[];
  } | null> {
    return serviceCardFlow.serviceCardFor(this, scope, actor, customerId, serviceId, notice);
  }

  serviceDetail(
    scope: TenantContext,
    actor: ActorContext,
    customer: Pick<CustomerRecord, 'id'>,
    serviceId: string,
    options?: {
      readonly working?: boolean;
      readonly notice?: TemplateKey;
      /** Track 3 §1: drawn from stored figures; the status names when they were read. */
      readonly lastUpdatedAt?: Date;
    },
  ): Promise<PendingReply> {
    return serviceCardFlow.serviceDetail(this, scope, actor, customer, serviceId, options);
  }

  addonChoice(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    kind: 'ADD_TRAFFIC' | 'ADD_TIME',
  ): Promise<PendingReply> {
    return serviceActionsFlow.addonChoice(this, scope, actor, customer, serviceId, kind);
  }

  devicesChoice(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<PendingReply> {
    return serviceActionsFlow.devicesChoice(this, scope, actor, customer, serviceId);
  }

  locationChoice(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<PendingReply> {
    return serviceActionsFlow.locationChoice(this, scope, actor, customer, serviceId);
  }

  locationTarget(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    locationId: string,
    input: { readonly idempotencyKey: string },
  ): Promise<PendingReply> {
    return serviceActionsFlow.locationTarget(
      this,
      scope,
      actor,
      customer,
      serviceId,
      locationId,
      input,
    );
  }

  locationRequest(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    locationId: string,
    input: {
      readonly idempotencyKey: string;
      readonly update?: unknown;
      readonly botInstanceId?: BotInstanceId;
    },
  ): Promise<PendingReply> {
    return serviceActionsFlow.locationRequest(
      this,
      scope,
      actor,
      customer,
      serviceId,
      locationId,
      input,
    );
  }

  commercialQuote(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    kind: 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME' | 'ADD_DEVICES' | 'CHANGE_LOCATION',
    addonId: string | null,
    input: { readonly idempotencyKey: string },
    quantity?: number,
    locationId?: string,
    planId?: string,
  ): Promise<PendingReply> {
    return serviceActionsFlow.commercialQuote(
      this,
      scope,
      actor,
      customer,
      serviceId,
      kind,
      addonId,
      input,
      quantity,
      locationId,
      planId,
    );
  }

  commercialConfirm(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    orderId: string,
    input: { readonly idempotencyKey: string },
  ): Promise<PendingReply> {
    return serviceActionsFlow.commercialConfirm(this, scope, actor, customer, orderId, input);
  }

  serviceResend(
    scope: TenantContext,
    customer: CustomerRecord,
    serviceId: string,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
    },
  ): Promise<PendingReply> {
    return serviceCardFlow.serviceResend(this, scope, customer, serviceId, input);
  }

  serviceFiles(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    input: { readonly botInstanceId: BotInstanceId; readonly update: unknown },
  ): Promise<PendingReply> {
    return serviceCardFlow.serviceFiles(this, scope, actor, customer, serviceId, input);
  }

  serviceAction(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    type: CustomerServiceOperation,
    idempotencyKey: string,
    card: CardMessageRef | null,
  ): Promise<PendingReply> {
    return serviceCardFlow.serviceAction(
      this,
      scope,
      actor,
      customer,
      serviceId,
      type,
      idempotencyKey,
      card,
    );
  }

  serviceToggleAsk(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    type: 'SUSPEND' | 'RESUME',
  ): Promise<PendingReply> {
    return serviceCardFlow.serviceToggleAsk(this, scope, actor, customer, serviceId, type);
  }

  serviceRotateAsk(
    scope: TenantContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<PendingReply> {
    return serviceActionsFlow.serviceRotateAsk(this, scope, customer, serviceId);
  }

  serviceRotate(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    idempotencyKey: string,
    card?: CardMessageRef | null,
  ): Promise<PendingReply> {
    return serviceActionsFlow.serviceRotate(
      this,
      scope,
      actor,
      customer,
      serviceId,
      idempotencyKey,
      card,
    );
  }

  /**
   * A plain message offered to the customer's own text window, if one is open: a top-up
   * amount, a search term or a note, by the window's PURPOSE. Null means no window read
   * it and the message goes on to the order windows.
   */
  async capturedText(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    text: string,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update?: unknown;
    },
  ): Promise<PendingReply | null> {
    const updateId = updateIdOf(input.update);
    const read = await this.deps.captures.readText(scope, actor, {
      idempotencyKey: `${input.idempotencyKey}:capture-text`,
      botInstanceId: input.botInstanceId,
      customerId: customer.id,
      text,
      ...(updateId === undefined ? {} : { updateId }),
    });
    if (read.outcome !== 'READ') return null;
    const { capture } = read;
    if (capture.purpose === 'TOPUP_AMOUNT') {
      const result = await this.deps.topup.recordAmountText(scope, {
        customerId: customer.id,
        captureId: capture.id,
        text,
      });
      return this.topupAmountReply(scope, result, capture.id);
    }
    if (capture.purpose === 'SERVICE_SEARCH') {
      const query = text.trim();
      if (query.length === 0 || Array.from(query).length > SERVICE_SEARCH_MAX_LENGTH) {
        return {
          key: 'bot.service.search_invalid',
          values: {},
          buttons: [backToListButton()],
          orderId: null,
        };
      }
      const found = await this.deps.services.searchForCustomer(scope, customer.id, query);
      if (found.length === 0) {
        return {
          key: 'bot.service.search_none',
          values: {},
          buttons: [backToListButton()],
          orderId: null,
        };
      }
      const now = this.deps.clock.now();
      return {
        key: 'bot.service.search_results',
        values: { query: query.toLowerCase() },
        buttons: [...found.map((service) => serviceListButton(service, now)), backToListButton()],
        orderId: null,
      };
    }
    if (capture.purpose === 'GATEWAY_REFUND_CARD') {
      return this.gatewayRefundCardText(scope, actor, customer, capture, text, input);
    }
    if (capture.purpose === 'SERVICE_REFUND_REASON') {
      return this.serviceRefundReason(scope, actor, customer, capture.subjectId, text, input);
    }
    if (capture.purpose === 'SERVICE_TRANSFER_RECIPIENT') {
      return this.serviceTransferRecipient(scope, actor, customer, capture.subjectId, text, input);
    }
    // WP-A7: a new ticket's first message, or a reply to one.
    if (capture.purpose === 'TICKET_NEW_MESSAGE' || capture.purpose === 'TICKET_REPLY') {
      return this.ticketSubmit(scope, actor, customer, capture, text, null, input);
    }
    if (capture.purpose === 'CUSTOM_SERVICE_VOLUME' || capture.purpose === 'CUSTOM_SERVICE_DAYS') {
      return this.customServiceFigure(scope, actor, customer, capture, text, input);
    }
    // SERVICE_NOTE: the window names the service; the write re-checks ownership.
    if (capture.subjectId === null) return null;
    try {
      const cleared = text.trim() === SERVICE_NOTE_CLEAR_TOKEN;
      const saved = await this.deps.services.setCustomerNote(
        scope,
        actor,
        customer.id,
        capture.subjectId,
        cleared ? null : text,
      );
      /*
       * Round N (F4): the answer IS the service card, with the note as it now stands and the
       * saved/cleared line under its status — one message showing the result, not a sentence
       * and a button back to it. A new message, because a typed answer carries no reference
       * to the card that asked for it (the smallest fallback for a typed step).
       */
      return this.serviceDetail(scope, actor, customer, capture.subjectId, {
        notice: saved.note === null ? 'bot.service.note_cleared' : 'bot.service.note_saved',
      });
    } catch (error) {
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.CAPTURE_INPUT_INVALID) {
        return {
          key: 'bot.service.note_invalid',
          values: { max: SERVICE_NOTE_MAX_LENGTH },
          buttons: [backToServiceButton(capture.subjectId)],
          orderId: null,
        };
      }
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND) {
        return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
      }
      return refusal(error);
    }
  }

  /** The answer to a recorded (or refused) top-up amount: the route chooser, or why not. */
  async topupAmountReply(
    scope: TenantContext,
    result: Awaited<ReturnType<WalletTopupFlowService['recordAmountText']>>,
    captureId: string,
  ): Promise<PendingReply> {
    const reply = await this.topupAmountScreen(scope, result, captureId);
    /*
     * R2: a TYPED amount continues the wizard that asked for it — anchored on the amount
     * screen of this capture. A tapped preset has its claim and ignores the anchor.
     */
    return {
      ...reply,
      wizard: {
        ...(reply.wizard ?? { kind: 'TOPUP', step: 'NOTICE' }),
        anchor: { steps: ['AMOUNT'], subjectId: captureId },
      },
    };
  }

  async topupAmountScreen(
    scope: TenantContext,
    result: Awaited<ReturnType<WalletTopupFlowService['recordAmountText']>>,
    captureId: string,
  ): Promise<PendingReply> {
    const amountStep: WizardDirective = { kind: 'TOPUP', step: 'AMOUNT', subjectId: captureId };
    const close = {
      ...inlineLabel('list.close'),
      data: `${TOPUP_CLOSE_CALLBACK_PREFIX}${captureId}`,
    };
    if (result.outcome === 'GONE') {
      return { key: 'bot.wallet.topup_expired', values: {}, buttons: [], orderId: null };
    }
    if (result.outcome === 'INVALID') {
      return {
        key: 'bot.wallet.topup_amount_invalid',
        values: {},
        buttons: [close],
        orderId: null,
        wizard: amountStep,
      };
    }
    if (result.outcome === 'BELOW_MINIMUM') {
      return {
        key: 'bot.wallet.topup_below_minimum',
        values: { minimum: result.minimum },
        buttons: [close],
        orderId: null,
        wizard: amountStep,
      };
    }
    if (result.outcome === 'ABOVE_MAXIMUM') {
      return {
        key: 'bot.wallet.topup_above_maximum',
        values: { maximum: result.maximum },
        buttons: [close],
        orderId: null,
        wizard: amountStep,
      };
    }
    return this.topupChooser(scope, captureId, result.routes);
  }

  /**
   * «💳 روش پرداخت خود را انتخاب نمایید»: one button per route the amount may be paid
   * through, in the operator's order, with the route's gift when it has one. The buttons
   * carry the capture id and the provider — identifiers, never the amount.
   */
  async topupChooser(
    scope: TenantContext,
    captureId: string,
    routes: readonly TopupRoute[],
  ): Promise<PendingReply> {
    const close = {
      ...inlineLabel('list.close'),
      data: `${TOPUP_CLOSE_CALLBACK_PREFIX}${captureId}`,
    };
    const methods: WizardDirective = { kind: 'TOPUP', step: 'METHODS', subjectId: captureId };
    if (routes.length === 0) {
      return {
        key: 'bot.wallet.topup_none_available',
        values: {},
        buttons: [close],
        orderId: null,
        wizard: methods,
      };
    }
    const buttons: CustomerButton[] = [];
    for (const route of routes) {
      const name = await this.deps.screens.routeName(scope, route);
      buttons.push({
        ...(route.topupCashbackPercent > 0
          ? inlineLabel('payment.route_gift', { name, percent: route.topupCashbackPercent })
          : inlineLabel('payment.route', { name })),
        data: `${TOPUP_ROUTE_CALLBACK_PREFIX}${captureId}.${route.provider}`,
      });
    }
    buttons.push(close);
    return {
      key: 'bot.wallet.topup_method_prompt',
      values: {},
      buttons,
      orderId: null,
      wizard: methods,
    };
  }

  async topupRoute(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    captureId: string,
    provider: PaymentGatewayProvider,
  ): Promise<PendingReply> {
    try {
      const chosen = await this.deps.topup.choose(scope, actor, {
        customerId: customer.id,
        captureId,
        provider,
      });
      if (chosen.outcome === 'GONE') {
        return { key: 'bot.wallet.topup_expired', values: {}, buttons: [], orderId: null };
      }
      if (chosen.outcome === 'NOT_OFFERED') {
        return this.topupChooser(scope, captureId, chosen.routes);
      }
      if (chosen.outcome === 'GATEWAY_REQUESTED') {
        return await this.gatewayAttemptReply(chosen.attempt, null, scope);
      }
      return this.transferInstruction(scope, chosen.instruction, null);
    } catch (error) {
      return refusal(error);
    }
  }

  async topupClose(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    captureId: string,
  ): Promise<PendingReply> {
    await this.deps.topup.close(scope, actor, { customerId: customer.id, captureId });
    return {
      key: 'bot.wallet.topup_closed',
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
      wizard: { kind: 'TOPUP', step: 'CLOSED' },
    };
  }

  servicesSearchBegin(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    return serviceCardFlow.servicesSearchBegin(
      this,
      scope,
      actor,
      customer,
      botInstanceId,
      idempotencyKey,
    );
  }

  openServiceCard(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<PendingReply> {
    return serviceCardFlow.openServiceCard(this, scope, actor, customer, serviceId);
  }

  serviceRefresh(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    return serviceCardFlow.serviceRefresh(this, scope, actor, customer, serviceId, idempotencyKey);
  }

  serviceRefundAsk(
    scope: TenantContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<PendingReply> {
    return serviceRequestsFlow.serviceRefundAsk(this, scope, customer, serviceId);
  }

  serviceRefundConfirm(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
    updateId: bigint | undefined,
  ): Promise<PendingReply> {
    return serviceRequestsFlow.serviceRefundConfirm(
      this,
      scope,
      actor,
      customer,
      serviceId,
      botInstanceId,
      idempotencyKey,
      updateId,
    );
  }

  serviceRefundReason(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string | null,
    text: string,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update?: unknown;
    },
  ): Promise<PendingReply | null> {
    return serviceRequestsFlow.serviceRefundReason(
      this,
      scope,
      actor,
      customer,
      serviceId,
      text,
      input,
    );
  }

  serviceTransferAsk(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update?: unknown;
    },
  ): Promise<PendingReply> {
    return serviceRequestsFlow.serviceTransferAsk(this, scope, actor, customer, serviceId, input);
  }

  serviceTransferRecipient(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string | null,
    text: string,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update?: unknown;
    },
  ): Promise<PendingReply | null> {
    return serviceRequestsFlow.serviceTransferRecipient(
      this,
      scope,
      actor,
      customer,
      serviceId,
      text,
      input,
    );
  }

  serviceTransferConfirm(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    confirmed: { readonly recipientTelegramUserId: string; readonly ownershipVersion: number },
    input: { readonly idempotencyKey: string; readonly botInstanceId: BotInstanceId },
  ): Promise<PendingReply> {
    return serviceRequestsFlow.serviceTransferConfirm(
      this,
      scope,
      actor,
      customer,
      serviceId,
      confirmed,
      input,
    );
  }

  serviceNoteBegin(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    return serviceCardFlow.serviceNoteBegin(
      this,
      scope,
      actor,
      customer,
      serviceId,
      botInstanceId,
      idempotencyKey,
    );
  }

  renewMenu(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<PendingReply> {
    return serviceActionsFlow.renewMenu(this, scope, actor, customer, serviceId);
  }

  referralGift(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    return referralFlow.referralGift(this, scope, actor, customer, idempotencyKey);
  }

  ticketTurn(
    scope: TenantContext,
    actor: ActorContext,
    command: BotCommand,
    customer: CustomerRecord,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update?: unknown;
    },
  ): Promise<PendingReply | null> {
    return supportFlow.ticketTurn(this, scope, actor, command, customer, input);
  }

  ticketFile(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    file: InboundReceiptFile,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update?: unknown;
    },
  ): Promise<PendingReply | null> {
    return supportFlow.ticketFile(this, scope, actor, customer, file, input);
  }

  ticketSubmit(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    capture: CustomerCaptureRecord,
    text: string | null,
    file: InboundTicketFile | null,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update?: unknown;
    },
  ): Promise<PendingReply | null> {
    return supportFlow.ticketSubmit(this, scope, actor, customer, capture, text, file, input);
  }

  marketingPreference(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    optedOut: boolean,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    return startMenuFlow.marketingPreference(
      this,
      scope,
      actor,
      customer,
      optedOut,
      idempotencyKey,
    );
  }

  supportScreen(scope: TenantContext, customer: CustomerRecord): Promise<PendingReply> {
    return supportFlow.supportScreen(this, scope, customer);
  }

  tutorialChoice(scope: TenantContext, customer: CustomerRecord): Promise<PendingReply> {
    return tutorialFlow.tutorialChoiceReply(this, scope, customer);
  }

  tutorialPlatform(
    scope: TenantContext,
    customer: CustomerRecord,
    platform: ClientAppPlatform,
  ): Promise<PendingReply> {
    return tutorialFlow.tutorialPlatform(this, scope, customer, platform);
  }

  clientApp(
    scope: TenantContext,
    customer: CustomerRecord,
    appId: string,
    botInstanceId: BotInstanceId,
  ): Promise<PendingReply> {
    return tutorialFlow.clientApp(this, scope, customer, appId, botInstanceId);
  }

  ownedService(
    scope: TenantContext,
    customer: Pick<CustomerRecord, 'id'>,
    serviceId: string,
  ): Promise<ServiceRecord | null> {
    return serviceCardFlow.ownedService(this, scope, customer, serviceId);
  }

  /**
   * The catalogue: a heading and one button per product.
   *
   * The product list cannot be interpolated into `bot.catalog.heading` — it declares no
   * placeholders, and a template is not a list renderer. So the products are BUTTONS,
   * whose labels are the tenant's own data and whose `callback_data` is the id. That is
   * also why the empty case is a different KEY rather than the same message with nothing
   * under it: `bot.catalog.empty` says why there is nothing, and an empty list reads as
   * a failure.
   */
  /**
   * One page of the CATEGORY list — the first of the two steps (OQ-4B-01).
   *
   * What reaches this list is decided entirely in SQL, ahead of LIMIT/OFFSET: tenant,
   * category status and visibility, and non-emptiness by EXISTS over products that are
   * themselves listed, priced and on an eligible panel. Nothing here filters what came
   * back — §6.4 forbids fetching a page and then trimming it, which is the shape that
   * emptied this catalogue three times at three different thresholds.
   *
   * Next and Previous are drawn only when TRUE: Previous when this is not the first
   * page, Next when the query read a row beyond this one. `hasMore` is a fact about the
   * data, not an inference from a count.
   *
   * A page past the end — a stale button after categories were withdrawn — recovers to
   * the first page rather than showing an empty list with a Previous button. That is a
   * navigation recovery and selects nothing: the customer taps again from what exists.
   */
  async catalogue(
    scope: TenantContext,
    actor: ActorContext,
    page: number,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    const { items, hasMore } = await this.deps.products.browseCategories(
      scope,
      actor,
      CATALOG_BROWSE_PAGE_SIZE,
      page * CATALOG_BROWSE_PAGE_SIZE,
      // Whose catalogue: a reseller's tier decides what they see (WP9-B R6).
      customer.id,
    );
    /*
     * No trial here (F5). A trial is not something a customer buys or browses to: it is
     * its own main-menu action («🧪 دریافت سرویس تست», `/trial`), drawn while a panel
     * offers one. The purchase flow — categories, products, plans — sells, and only sells.
     *
     * The custom service (Package D), on the first page only: drawn when at least one
     * location could price this customer now. A courtesy — every step after the tap
     * decides again. Unlike the trial it IS a way to buy, so it stays.
     */
    /*
     * B1: the entry is the LAST item of the category list — below every category, never
     * above them — so it sits on the final page, after the categories and before the
     * paging row. Drawn where the list ends (no further page), not on page 0.
     */
    const lastPage = !hasMore || page >= CATALOG_BROWSE_MAX_PAGE;
    const trailing: CustomerButton[] = [];
    if (lastPage && (await this.customServiceOffered(scope, actor, customer))) {
      trailing.push({
        ...inlineLabel('catalog.custom_service'),
        data: CUSTOM_SERVICE_CALLBACK_DATA,
      });
    }
    if (items.length === 0) {
      if (page > 0) return this.catalogue(scope, actor, 0, customer);
      return { key: 'bot.catalog.empty', values: {}, buttons: trailing, orderId: null };
    }
    const buttons: CustomerButton[] = [];
    buttons.push(
      ...items.map((category) => ({
        // Operator text, exactly as a product title is. The emoji is optional and its
        // absence renders as an ordinary category — §6.1.
        ...inlineDataLabel('catalog.category', {
          kind: 'TEXT',
          text: category.emoji === null ? category.name : `${category.emoji} ${category.name}`,
        }),
        data: `${CATEGORY_CALLBACK_PREFIX}${category.id}.0`,
        // UX Batch 01, item 2: the category's own colour; the route above is unchanged.
        category: category.id,
      })),
      ...trailing,
    );
    if (page > 0) {
      buttons.push({
        ...inlineLabel('catalog.previous_page'),
        data: `${CATALOG_PAGE_CALLBACK_PREFIX}${page - 1}`,
      });
    }
    if (hasMore && page < CATALOG_BROWSE_MAX_PAGE) {
      buttons.push({
        ...inlineLabel('catalog.next_page'),
        data: `${CATALOG_PAGE_CALLBACK_PREFIX}${page + 1}`,
      });
    }
    return {
      key: 'bot.catalog.categories_heading',
      values: {},
      buttons,
      orderId: null,
      wizard: { kind: 'ORDER', step: 'CATEGORIES' },
    };
  }

  /** Whether to draw the custom-service button (Package D): some location prices this customer. */
  async customServiceOffered(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
  ): Promise<boolean> {
    if (this.deps.customService === undefined) return false;
    return (await this.deps.customService.offeredLocations(scope, actor, customer.id)).length > 0;
  }

  /** The custom-service button: the locations, each by the label the operator wrote. */
  async customServiceMenu(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    const locations =
      this.deps.customService === undefined
        ? []
        : await this.deps.customService.offeredLocations(scope, actor, customer.id);
    if (locations.length === 0) {
      return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
    }
    return {
      key: 'bot.custom_service.locations',
      values: {},
      buttons: locations.map((location) => ({
        ...inlineDataLabel('custom_service.location', { kind: 'TEXT', text: location.label }),
        data: `${CUSTOM_SERVICE_LOCATION_CALLBACK_PREFIX}${location.panelId}`,
      })),
      orderId: null,
    };
  }

  /** A location was tapped: re-decided, then the volume question and its window. */
  async customServiceLocation(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    panelId: string,
    input: { readonly idempotencyKey: string; readonly botInstanceId: BotInstanceId },
  ): Promise<PendingReply> {
    if (this.deps.customService === undefined) {
      return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
    }
    const begun = await this.deps.customService.begin(scope, actor, {
      idempotencyKey: `${input.idempotencyKey}:custom-service-volume`,
      botInstanceId: input.botInstanceId,
      customerId: customer.id,
      panelId,
    });
    if (begun.outcome === 'UNAVAILABLE') {
      return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
    }
    return {
      key: 'bot.custom_service.ask_volume',
      values: { location: begun.location.label, ...volumeRangeValues(begun.range) },
      buttons: [],
      orderId: null,
    };
  }

  /**
   * A figure a custom-service window read (Package D): the volume, then the days, then
   * the draft and the ordinary username step and pre-invoice.
   */
  async customServiceFigure(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    capture: CustomerCaptureRecord,
    text: string,
    input: { readonly idempotencyKey: string; readonly botInstanceId: BotInstanceId },
  ): Promise<PendingReply> {
    const flow = this.deps.customService;
    if (flow === undefined || capture.customerId !== customer.id) {
      return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
    }
    if (capture.purpose === 'CUSTOM_SERVICE_VOLUME') {
      const volume = await flow.recordVolume(scope, actor, {
        capture,
        text,
        botInstanceId: input.botInstanceId,
      });
      if (volume.outcome === 'INVALID') {
        // B1: the wrong input is named and the allowed range repeated. No range means the
        // window is no longer one this customer can price: the one unavailable sentence.
        if (volume.range === null) {
          return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
        }
        return {
          key: 'bot.custom_service.invalid_volume',
          values: volumeRangeValues(volume.range),
          buttons: [],
          orderId: null,
        };
      }
      if (volume.outcome === 'UNPRICED') {
        return {
          key: 'bot.custom_service.volume_unpriced',
          values: {},
          buttons: [],
          orderId: null,
        };
      }
      if (volume.outcome === 'UNAVAILABLE') {
        return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
      }
      return {
        key: 'bot.custom_service.ask_days',
        values: { volumeBytes: volume.volumeBytes, ...daysRangeValues(volume.range) },
        buttons: [],
        orderId: null,
      };
    }
    try {
      const days = await flow.recordDays(scope, actor, { capture, text });
      if (days.outcome === 'INVALID') {
        if (days.range === null) {
          return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
        }
        return {
          key: 'bot.custom_service.invalid_days',
          values: daysRangeValues(days.range),
          buttons: [],
          orderId: null,
        };
      }
      if (days.outcome === 'UNPRICED') {
        return { key: 'bot.custom_service.days_unpriced', values: {}, buttons: [], orderId: null };
      }
      if (days.outcome === 'UNAVAILABLE') {
        return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
      }
      return this.afterDraft(
        scope,
        actor,
        days.order,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    } catch (error) {
      return refusal(error);
    }
  }

  beginTrial(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    return trialFlow.beginTrial(this, scope, actor, customer, idempotencyKey);
  }

  claimTrial(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    panelId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    return trialFlow.claimTrial(this, scope, actor, customer, panelId, idempotencyKey);
  }

  /**
   * One page of the products inside one category — the second step.
   *
   * The category id comes from a button, so it may be stale: withdrawn, hidden, emptied
   * or another tenant's since the list was drawn. None of that is decided HERE. The
   * query carries the category's own status and visibility predicates and the tenant,
   * so every one of those cases reaches this handler as an empty page — and an empty
   * first page is answered with `bot.catalog.category_empty` and a way back, which is
   * the truthful outcome whichever of them it was.
   *
   * A product button carries the PRODUCT'S id. Tapping it goes through `createDraft`,
   * which re-reads the product and its category inside its own transaction and refuses
   * what is no longer orderable — so a button older than a withdrawal is refused with a
   * sentence rather than honoured, and nothing a position in this page could mean is
   * ever looked up.
   */
  async categoryPage(
    scope: TenantContext,
    actor: ActorContext,
    categoryId: string,
    page: number,
    /** Whose catalogue: a reseller's tier decides what they see (WP9-B R6). */
    customerId: string,
  ): Promise<PendingReply> {
    const { items, hasMore } = await this.deps.products.browseCategory(
      scope,
      actor,
      categoryId,
      CATALOG_BROWSE_PAGE_SIZE,
      page * CATALOG_BROWSE_PAGE_SIZE,
      customerId,
    );
    const back: CustomerButton = {
      ...inlineLabel('catalog.back_to_categories'),
      data: `${CATALOG_PAGE_CALLBACK_PREFIX}0`,
    };
    if (items.length === 0) {
      if (page > 0) return this.categoryPage(scope, actor, categoryId, 0, customerId);
      return {
        key: 'bot.catalog.category_empty',
        values: {},
        buttons: [back],
        orderId: null,
        wizard: { kind: 'ORDER', step: 'PRODUCTS' },
      };
    }
    const buttons: CustomerButton[] = [];
    for (const product of items) {
      // The SQL returns only priced products; a null here would mean the read model
      // changed under this surface. Skipped rather than drawn without an amount,
      // because a plan whose price a customer cannot see is one they cannot consent to.
      if (product.price === null) continue;
      buttons.push({
        ...inlineDataLabel('catalog.product', {
          kind: 'TEXT',
          text: product.title,
          amount: product.price,
        }),
        data: `${ORDER_CALLBACK_PREFIX}${product.id}`,
        // R4 PR-F (F2): the plan table of a rich message; an ordinary message ignores it.
        planFacts: {
          trafficBytes: product.specification.trafficBytes,
          durationDays: product.specification.durationDays,
        },
      });
    }
    if (page > 0) {
      buttons.push({
        ...inlineLabel('catalog.previous_page'),
        data: `${CATEGORY_CALLBACK_PREFIX}${categoryId}.${page - 1}`,
      });
    }
    if (hasMore && page < CATALOG_BROWSE_MAX_PAGE) {
      buttons.push({
        ...inlineLabel('catalog.next_page'),
        data: `${CATEGORY_CALLBACK_PREFIX}${categoryId}.${page + 1}`,
      });
    }
    buttons.push(back);
    return {
      key: 'bot.catalog.heading',
      values: {},
      buttons,
      orderId: null,
      wizard: { kind: 'ORDER', step: 'PRODUCTS' },
    };
  }

  /**
   * The summary a customer confirms, with the name their service will carry.
   *
   * One builder for every path that reaches it — the draft, the two mode buttons and
   * the typed name — because the summary is the thing the customer AGREES to, and four
   * copies of it are four chances for one of them to show a figure the order does not
   * have. `username` is omitted rather than blanked when there is none: the placeholder
   * is optional, so a body that renders it simply does not, and a body a tenant
   * overrode before this step existed is unaffected.
   */
  async preinvoice(
    scope: TenantContext,
    actor: ActorContext,
    order: OrderRecord,
    customer: CustomerRecord,
    username: string | null,
  ): Promise<PendingReply> {
    const discounted = order.totals.discount.amountMinor > 0n;
    const cashback = order.totals.quote.cashback;
    // A purchase shows the plan's allowance; an action on an existing service does not.
    const commercial = order.purpose !== 'NEW_SERVICE' && order.purpose !== 'CUSTOM_SERVICE';
    // Marketing display data for the plan being bought or renewed; a package has none.
    const display =
      order.purpose === 'ADD_TRAFFIC' ||
      order.purpose === 'ADD_TIME' ||
      order.purpose === 'ADD_DEVICES' ||
      order.purpose === 'CHANGE_LOCATION'
        ? null
        : await this.deps.productDisplay.displayFor(scope, order.line.productId);
    // WP-A6: a paid move states from where and to where, from its frozen change request.
    const locationChange =
      order.purpose === 'CHANGE_LOCATION'
        ? await this.deps.commercial.locationChangeFor(scope, actor, customer.id, order.id)
        : null;
    /*
     * WP-A5: an extra-users order states what it bought from its own frozen line — the
     * count, the price of one, and the limit before and after, the target being what
     * `line_device_limit` holds.
     */
    const target = order.line.specification.deviceLimit;
    const devices =
      order.purpose === 'ADD_DEVICES' && target !== null
        ? {
            quantity: order.line.quantity,
            unitPrice: order.line.unitPrice,
            currentLimit: target - order.line.quantity,
            targetLimit: target,
          }
        : null;
    const balance = await this.deps.wallet.balanceForCustomer(scope, actor, customer.id);
    // A custom service shows what it was priced from, from the order's frozen terms.
    const custom =
      order.purpose === 'CUSTOM_SERVICE'
        ? await this.deps.customService?.termsFor(scope, order.id)
        : undefined;
    const screen = await this.deps.screens.preinvoice(scope, {
      // PR-C: the order's public code, the one the customer quotes and every log prints.
      orderCode: orderCodeOf(order),
      custom:
        custom === undefined || custom === null
          ? null
          : {
              location: custom.locationLabel,
              volumeBytes: custom.trafficBytes,
              pricePerGb: custom.pricePerGb,
              volumePrice: custom.volumePrice,
              durationDays: custom.durationDays,
              pricePerDay: custom.pricePerDay,
              timePrice: custom.timePrice,
            },
      devices,
      locationChange,
      serviceUsername: username,
      productName: order.line.title,
      durationDays:
        order.purpose === 'ADD_TRAFFIC' ||
        order.purpose === 'ADD_DEVICES' ||
        order.purpose === 'CHANGE_LOCATION'
          ? null
          : order.line.specification.durationDays,
      total: order.totals.total,
      trafficBytes: commercial ? null : order.line.specification.trafficBytes,
      addedTrafficBytes:
        order.purpose === 'ADD_TRAFFIC' ? order.line.specification.trafficBytes : null,
      discount: discounted
        ? { subtotal: order.totals.subtotal, discount: order.totals.discount }
        : null,
      cashback: cashback === undefined ? null : cashback.amount,
      locations: display?.displayLocations ?? [],
      features: display?.displayFeatures ?? [],
      // B1: the one editable customer-facing description, in place of the two blocks.
      description: display?.description ?? null,
      walletBalance: money(balance.amountMinor, balance.currency),
    });
    const routes = await this.orderRouteButtons(scope, customer.id, order.id, order.totals.total);
    return {
      key: screen.key,
      values: screen.values,
      buttons: preinvoiceButtons(order, routes.length > 0),
      orderId: order.id,
      wizard: { kind: 'ORDER', step: 'PREINVOICE', subjectId: order.id },
    };
  }

  /**
   * The summary again, for a draft whose quote just changed under a code.
   *
   * The username is read back rather than carried, because the code turn does not know
   * it: the window that brought the code names only the order.
   */
  async repricedSummary(
    scope: TenantContext,
    actor: ActorContext,
    order: OrderRecord,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    const step = await this.deps.orders.usernameStep(scope, actor, {
      customerId: customer.id,
      orderId: order.id,
    });
    return this.preinvoice(scope, actor, order, customer, step.reservation?.username ?? null);
  }

  /** Opens the code window for one draft and asks for the code. */
  async enterDiscountCode(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    botInstanceId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      await this.deps.orders.beginDiscountCodeEntry(scope, actor, {
        idempotencyKey: `${idempotencyKey}:discount-entry`,
        botInstanceId,
        customerId: customer.id,
        orderId,
      });
      return {
        key: 'bot.discount.ask',
        values: {},
        buttons: [],
        orderId,
        wizard: { kind: 'ORDER', step: 'DISCOUNT', subjectId: orderId },
      };
    } catch (error) {
      return refusal(error);
    }
  }

  /** Takes the code off a draft: the draft is re-quoted from its own snapshot. */
  async removeDiscountCode(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const order = await this.deps.orders.applyDiscountCode(scope, actor, {
        idempotencyKey: `${idempotencyKey}:discount-remove`,
        customerId: customer.id,
        orderId,
        code: null,
      });
      return this.repricedSummary(scope, actor, order, customer);
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * An ordinary message the username window did not claim. A code only if the code
   * window says so; otherwise the fallback every unrecognised message has always had.
   */
  async typedDiscountCode(
    scope: TenantContext,
    actor: ActorContext,
    text: string,
    customer: CustomerRecord,
    botInstanceId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const result = await this.deps.orders.submitTypedDiscountCode(scope, actor, {
        idempotencyKey: `${idempotencyKey}:discount-text`,
        botInstanceId,
        customerId: customer.id,
        text,
      });
      if (result.outcome === 'NO_WINDOW') {
        return { key: 'bot.unknown_command', values: {}, buttons: [], orderId: null };
      }
      const summary = await this.repricedSummary(scope, actor, result.order, customer);
      // R2: the wizard that asked for the code shows the re-priced pre-invoice.
      return {
        ...summary,
        wizard: {
          kind: 'ORDER',
          step: 'PREINVOICE',
          subjectId: result.order.id,
          anchor: { steps: ['DISCOUNT'], subjectId: result.order.id },
        },
      };
    } catch (error) {
      // `DISCOUNT_CODE_REJECTED` through the shared table: one sentence for every reason,
      // and the window left open by the rolled-back transaction — on ITS order's wizard.
      const refused = refusal(error);
      const orderId =
        (await this.deps.answerWindowOrder?.(scope, botInstanceId, customer.id, 'DISCOUNT')) ??
        null;
      return {
        ...refused,
        wizard: {
          kind: 'ORDER',
          step: 'DISCOUNT',
          anchor: { steps: ['DISCOUNT'], subjectId: orderId },
        },
      };
    }
  }

  /**
   * What to show once a draft exists: the summary, or the username question first.
   *
   * The question is skipped in two cases and both are deliberate. A name already
   * reserved — a redelivered tap, a customer who came back — goes straight to the
   * summary carrying it, because asking again would suggest the first answer did not
   * take. And a panel offering only RANDOM has no question to ask: one button is a tap
   * that teaches nothing, so the name is drawn and the summary shows it.
   *
   * A panel offering only CUSTOM still shows this screen rather than opening the
   * window unasked. The window makes an ordinary message mean something, and opening
   * one the customer did not ask for is the half of INCIDENT-FIN-001 that is about
   * surprise rather than duration.
   */
  async afterDraft(
    scope: TenantContext,
    actor: ActorContext,
    order: OrderRecord,
    customer: CustomerRecord,
    botInstanceId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const step = await this.deps.orders.usernameStep(scope, actor, {
      customerId: customer.id,
      orderId: order.id,
    });
    if (step.reservation !== null) {
      return this.preinvoice(scope, actor, order, customer, step.reservation.username);
    }
    if (step.modes.length === 0) return this.preinvoice(scope, actor, order, customer, null);
    /*
     * ONE mode is not a question, whichever mode it is.
     *
     * An earlier version made an exception for CUSTOM: a single AUTOMATIC button was
     * skipped, but a single CUSTOM button was still drawn, on the reasoning that
     * opening a typing window the customer did not ask for is the surprise half of
     * INCIDENT-FIN-001. The owner overruled that, and the overruling is right — what
     * INCIDENT-FIN-001 is about is a window that outlives its question and swallows an
     * unrelated message. This window is opened BY the purchase the customer is in the
     * middle of, it names that one order, and it says in full what it is waiting for.
     *
     * What the exception actually produced was a screen offering one button, which
     * teaches the customer nothing and costs them a tap.
     */
    if (step.modes.length === 1) {
      return step.modes[0] === 'AUTOMATIC'
        ? this.automaticUsername(scope, actor, order.id, customer, idempotencyKey)
        : this.customUsername(scope, actor, order.id, customer, botInstanceId, idempotencyKey);
    }

    const buttons: CustomerButton[] = [];
    if (step.modes.includes('CUSTOM')) {
      buttons.push({
        ...inlineLabel('username.custom'),
        data: `${USERNAME_CUSTOM_CALLBACK_PREFIX}${order.id}`,
      });
    }
    if (step.modes.includes('AUTOMATIC')) {
      buttons.push({
        ...inlineLabel('username.automatic'),
        data: `${USERNAME_AUTOMATIC_CALLBACK_PREFIX}${order.id}`,
      });
    }
    return {
      key: 'bot.username.choose',
      values: {},
      buttons,
      orderId: order.id,
      wizard: { kind: 'ORDER', step: 'USERNAME', subjectId: order.id },
    };
  }

  /** The installation draws a name, and the summary shows the one it drew. */
  async automaticUsername(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const reservation = await this.deps.orders.chooseUsername(scope, actor, {
        idempotencyKey: `${idempotencyKey}:username`,
        customerId: customer.id,
        orderId,
        choice: { mode: 'AUTOMATIC' },
      });
      /*
       * The CUSTOMER's read, not the operator's. `get` charges `orders.view`, which a
       * customer turn does not hold — so it threw here AFTER the reservation had
       * committed, and the customer saw nothing at all.
       */
      const order = await this.deps.orders.orderForCustomer(scope, actor, {
        customerId: customer.id,
        orderId,
      });
      return this.preinvoice(scope, actor, order, customer, reservation.username);
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * Open the typing window and state the whole rule.
   *
   * The rule is sent in FULL, once, before the customer types, which is why
   * `bot.username.invalid` names no clause: a refusal that said which rule was broken
   * would add nothing they were not already told and would turn each attempt into a
   * probe of the validator.
   */
  async customUsername(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    botInstanceId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      await this.deps.orders.beginUsernameEntry(scope, actor, {
        idempotencyKey: `${idempotencyKey}:username-entry`,
        botInstanceId,
        customerId: customer.id,
        orderId,
      });
      return {
        key: 'bot.username.instructions',
        values: {},
        buttons: [],
        orderId,
        wizard: { kind: 'ORDER', step: 'USERNAME', subjectId: orderId },
      };
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * An ordinary message, which is a username only if a window says so.
   *
   * `NO_WINDOW` is the answer for almost every message this bot receives, and it
   * returns the same fallback the surface has always given. That is the whole safety
   * argument for routing plain text here at all: the decision is the database's, the
   * default is unchanged, and nothing about this path can reach anything but one draft
   * order of one customer.
   */
  async typedUsername(
    scope: TenantContext,
    actor: ActorContext,
    text: string,
    customer: CustomerRecord,
    botInstanceId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const result = await this.deps.orders.submitTypedUsername(scope, actor, {
        idempotencyKey: `${idempotencyKey}:username-text`,
        botInstanceId,
        customerId: customer.id,
        text,
      });
      if (result.outcome === 'NO_WINDOW') {
        // Not a username. Perhaps a discount code; otherwise the fallback it always got.
        return this.typedDiscountCode(scope, actor, text, customer, botInstanceId, idempotencyKey);
      }
      // The customer's read. See `automaticUsername` for what `get` did here.
      const order = await this.deps.orders.orderForCustomer(scope, actor, {
        customerId: customer.id,
        orderId: result.reservation.orderId,
      });
      const summary = await this.preinvoice(
        scope,
        actor,
        order,
        customer,
        result.reservation.username,
      );
      // R2: the wizard that asked for the name shows the pre-invoice.
      return {
        ...summary,
        wizard: {
          kind: 'ORDER',
          step: 'PREINVOICE',
          subjectId: order.id,
          anchor: { steps: ['USERNAME'], subjectId: order.id },
        },
      };
    } catch (error) {
      /*
       * Every refusal through the shared table, and NOTHING about the window.
       *
       * The two the customer can act on — an invalid name and a taken one — leave the
       * window OPEN, because `submitTypedUsername` closes it only for an accepted
       * name, so they type another and are answered again.
       *
       * They used to be mapped by two branches here rather than in `REFUSAL_REPLIES`,
       * which meant the same refusal arriving through the AUTOMATIC path had no entry
       * at all and `refusal` rethrew it. One table for all five is what makes the two
       * paths answer alike.
       */
      /*
       * R2: shown in the wizard that asked; the window stays open, so the step does too. The
       * refusal names no order, so the open window is asked which one: with two purchases
       * open, the chat's most recently touched USERNAME wizard may be the OTHER order's.
       */
      const refused = refusal(error);
      const orderId =
        (await this.deps.answerWindowOrder?.(scope, botInstanceId, customer.id, 'USERNAME')) ??
        null;
      return {
        ...refused,
        wizard: {
          kind: 'ORDER',
          step: 'USERNAME',
          anchor: { steps: ['USERNAME'], subjectId: orderId },
        },
      };
    }
  }

  /** The summary a customer confirms. Every figure comes from the ORDER, never the tap. */
  async draft(
    scope: TenantContext,
    actor: ActorContext,
    productId: string,
    customer: CustomerRecord,
    botInstanceId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const order = await this.deps.orders.createDraft(scope, actor, {
        // Suffixed, and the suffix is load-bearing. `resolveFromUpdate` already consumed
        // the bare update key in the `TELEGRAM` namespace, and presenting it again with
        // a different payload is `platform.idempotency_payload_mismatch` — the exact
        // collision `webhook.controller.ts` records for `/ping`. The update's identity is
        // still the base; this names the second command WITHIN that update.
        idempotencyKey: `${idempotencyKey}:draft`,
        customerId: customer.id,
        productId,
      });
      return this.afterDraft(scope, actor, order, customer, botInstanceId, idempotencyKey);
    } catch (error) {
      return refusal(error);
    }
  }

  /** DRAFT to AWAITING_PAYMENT, and the message that says what that means. */
  async confirm(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const order = await this.deps.orders.confirm(scope, actor, {
        idempotencyKey: `${idempotencyKey}:confirm`,
        customerId: customer.id,
        orderId,
      });
      return this.awaitingPaymentReply(scope, customer, order);
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * The awaiting-payment message: what is owed, until when, and the buttons that pay it.
   * One builder for a confirmed purchase, a confirmed commercial action and the selector's
   * «❌ بستن لیست», so the three can never draw different buttons for the same order.
   */
  async awaitingPaymentReply(
    scope: TenantContext,
    customer: CustomerRecord,
    order: OrderRecord,
  ): Promise<PendingReply> {
    return {
      key: 'bot.order.awaiting_payment',
      /*
       * What is owed, until when, and — since 4C — the buttons that pay it.
       *
       * The sentence here used to say there was no way to pay, which was true when
       * this message was written and false the moment `paymentButtons` was attached
       * below. The deadline it renders is now enforced where the money moves:
       * `orderAwaitingPayment` refuses a tap after `expiresAt`, so «اعتبار تا» is a
       * fact rather than decoration on a button that worked for ever.
       *
       * `expiresAt` is required by the key's declaration, and an order that reached
       * AWAITING_PAYMENT always has one — the draft carried it. The fallback is the
       * renderer's rule rather than a guess: a missing required value throws in the
       * resolver, which is better than a customer reading a literal `{expiresAt}`.
       */
      values: {
        total: order.totals.total,
        ...(order.expiresAt === null ? {} : { expiresAt: order.expiresAt }),
      },
      buttons: paymentButtons(
        order.id,
        (await this.orderRouteButtons(scope, customer.id, order.id, order.totals.total)).length > 0,
      ),
      orderId: order.id,
      wizard: { kind: 'ORDER', step: 'AWAITING_PAYMENT', subjectId: order.id },
    };
  }

  /**
   * The customer's own balance, derived from the ledger every time it is asked for.
   *
   * There is no balance column to read and no cache to go stale — `balanceOf` sums the
   * entries. `bot.wallet.balance` declares exactly one placeholder and this supplies
   * exactly that.
   */
  async walletBalance(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    const balance = await this.deps.wallet.balanceForCustomer(scope, actor, customer.id);
    const counters = await this.deps.counters.counters(scope, customer.id);
    /*
     * The referral COUNT stays on the account summary: it is a fact about this customer
     * that Mirza's /wallet shows too (the one referral surface its research VERIFIED). The
     * referral BUTTON does not (F5): the wallet carries wallet operations only, and the
     * program is reached from its own main-menu button and `/referral`.
     */
    const referralCount =
      this.deps.referralGifts === undefined
        ? 0
        : (await this.deps.referralGifts.stats(scope, customer.id)).referralCount;
    const reseller =
      this.deps.resellers === undefined
        ? null
        : await this.deps.resellers.standing(scope, customer.id, undefined);
    const fundable =
      (await this.deps.routes.routesFor(scope, customer.id, 'WALLET_TOPUP', null)).length > 0;
    const summary = await this.deps.screens.walletSummary(scope, {
      telegramId: customer.telegramUserId,
      displayName: displayNameOf(customer),
      registeredAt: customer.createdAt,
      balance: money(balance.amountMinor, balance.currency),
      serviceCount: counters.services,
      paidInvoiceCount: counters.paidInvoices,
      referralCount,
      group: reseller === null ? 'CUSTOMER' : 'RESELLER',
      // Owner spec §3: when the screen was drawn, not when anything happened.
      now: this.deps.clock.now(),
    });
    return {
      key: summary.key,
      values: summary.values,
      buttons: [
        /*
         * R8-C2: no separate «کپی شناسه» button. The numeric id is in <code> in the summary
         * (`bot.wallet.summary` is TELEGRAM_HTML), so a tap on the text copies it.
         */
        ...(fundable
          ? [
              {
                ...inlineLabel('wallet.topup'),
                data: TOPUP_MENU_CALLBACK_PREFIX,
              },
            ]
          : []),
        mainMenuButton(),
      ],
      orderId: null,
    };
  }

  referralInvite(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    return referralFlow.referralInvite(this, scope, actor, customer, botInstanceId, idempotencyKey);
  }

  /**
   * The offered amounts, one button each, read when the tap arrives.
   *
   * No amount is baked into the message that drew this: a customer scrolling back to an
   * old balance and tapping gets today's presets, not the ones that were configured when
   * it was sent. The refusal when nothing is offered is the same one the service gives,
   * so a customer who taps a button that has since become unfundable is told the same
   * thing either way.
   */
  async topupBegin(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const offered = await this.deps.routes.routesFor(scope, customer.id, 'WALLET_TOPUP', null);
    if (offered.length === 0) {
      return {
        key: 'bot.wallet.topup_unavailable',
        values: {},
        buttons: [mainMenuButton()],
        orderId: null,
      };
    }
    const begun = await this.deps.topup.begin(scope, actor, {
      customerId: customer.id,
      botInstanceId,
      idempotencyKey: `${idempotencyKey}:topup-begin`,
    });
    // The presets, when configured, are shortcuts that record the figure on the same
    // capture the typed path uses; they are not a second flow.
    const presets = await this.deps.payments.topupPresets(scope);
    return {
      key: 'bot.wallet.topup_amount_prompt',
      values: {
        ...(begun.minimum === null ? {} : { minimum: begun.minimum }),
        ...(begun.maximum === null ? {} : { maximum: begun.maximum }),
      },
      buttons: [
        ...presets.map((preset) => ({
          ...inlineDataLabel('wallet.topup_amount', { kind: 'AMOUNT', amount: preset }),
          data: `${TOPUP_PICK_CALLBACK_PREFIX}${preset.amountMinor.toString()}`,
        })),
        {
          ...inlineLabel('list.close'),
          data: `${TOPUP_CLOSE_CALLBACK_PREFIX}${begun.capture.id}`,
        },
      ],
      orderId: null,
      wizard: { kind: 'TOPUP', step: 'AMOUNT', subjectId: begun.capture.id },
    };
  }

  /**
   * A chosen amount becomes an invoice — the SAME invoice an order's transfer produces.
   *
   * `renderTransferInstruction` is shared, so the customer gets the structured
   * card-to-card destination, the two copy buttons and the combined
   * «پرداخت را انجام دادم | ارسال رسید» button that 5A and 5R built. A top-up has no
   * order, so nothing here names one.
   */
  async topupPick(
    scope: TenantContext,
    actor: ActorContext,
    amountMinor: string,
    customer: CustomerRecord,
    idempotencyKey: string,
    botInstanceId: BotInstanceId,
  ): Promise<PendingReply> {
    const presets = await this.deps.payments.topupPresets(scope);
    const preset = presets.find((candidate) => candidate.amountMinor.toString() === amountMinor);
    if (preset === undefined) {
      return {
        key: 'bot.wallet.topup_refused',
        values: {},
        buttons: [],
        orderId: null,
        wizard: { kind: 'TOPUP', step: 'NOTICE' },
      };
    }
    const begun = await this.deps.topup.begin(scope, actor, {
      customerId: customer.id,
      botInstanceId,
      idempotencyKey: `${idempotencyKey}:topup-pick`,
    });
    const result = await this.deps.topup.recordAmount(scope, {
      customerId: customer.id,
      captureId: begun.capture.id,
      amount: preset,
    });
    return this.topupAmountReply(scope, result, begun.capture.id);
  }

  /**
   * Paying for an order from the wallet. The tap carries the ORDER ID AND NOTHING ELSE.
   *
   * Every figure that decides how much money moves is read by the service inside the
   * transaction that moves it — the amount and currency from the order's frozen
   * snapshot, the owner from the order row, the state by the conditional UPDATE. Nothing
   * this surface passes could change any of them: it has an id and a customer, and the
   * customer comes from the resolved Telegram user rather than from the tap.
   *
   * The success reply is `bot.order.settled`, which says the payment was confirmed and
   * the order is paid. It does NOT say a service is being prepared, because nothing in
   * this release prepares one.
   */
  async walletPayment(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      /*
       * From the pre-invoice a DRAFT is paid in one tap: the balance is read FIRST, and a
       * shortfall answers without confirming anything — a reservation held for money
       * that is not there is a slot nobody can buy until it lapses. Then the confirm
       * (which reserves and redeems) and the settlement, each under its own key, each
       * exactly-once on replay.
       */
      const before = await this.deps.orders.orderForCustomer(scope, actor, {
        customerId: customer.id,
        orderId,
      });
      if (before.state === 'DRAFT') {
        const balance = await this.deps.wallet.balanceForCustomer(scope, actor, customer.id);
        if (
          balance.currency !== before.totals.total.currency ||
          balance.amountMinor < before.totals.total.amountMinor
        ) {
          const shortfall = money(
            balance.currency === before.totals.total.currency
              ? before.totals.total.amountMinor - balance.amountMinor
              : before.totals.total.amountMinor,
            before.totals.total.currency,
          );
          return {
            key: 'bot.wallet.insufficient',
            values: { shortfall },
            buttons: [topupButton(), mainMenuButton()],
            orderId,
            // R2: its own message, so the pre-invoice stays payable after a top-up.
            wizard: WALLET_SHORT,
          };
        }
        await this.confirmDraft(scope, actor, before, customer, idempotencyKey);
      }
      const { order } = await this.deps.payments.settleFromWallet(scope, actor, customer.id, {
        // Suffixed within the update's own key, the shape `draft` and `confirm` use: the
        // bare key was consumed by `resolveFromUpdate`, and presenting it again with a
        // different payload is an idempotency payload mismatch. A REDELIVERED update
        // recomputes this same suffix, which is what makes the replay produce one debit.
        idempotencyKey: `${idempotencyKey}:wallet-pay`,
        orderId,
      });
      /*
       * R2 (items 5 and 11): the wizard is CLOSED here, in place and with no buttons, and
       * what follows is a NEW message — the delivery of a new service, or the renewal's own
       * result from the notification lane. A renewal is not closed with the generic "order
       * paid" sentence: its payment message says the renewal is on its way.
       */
      return {
        key: settledKeyFor(order.purpose),
        values: {},
        buttons: [],
        orderId: order.id,
        ...followUpForSettlement(order.purpose),
        wizard: { kind: 'ORDER', step: 'CLOSED', subjectId: order.id },
      };
    } catch (error) {
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.ORDER_TRANSFER_UNDER_REVIEW) {
        return {
          key: 'bot.payment.transfer_under_review',
          values: {},
          buttons: [],
          orderId,
          wizard: WALLET_SHORT,
        };
      }
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS) {
        const shortfall = shortfallOf(error.details);
        if (shortfall !== null) {
          return {
            key: 'bot.wallet.insufficient',
            values: { shortfall },
            buttons: [topupButton(), mainMenuButton()],
            orderId,
            wizard: WALLET_SHORT,
          };
        }
      }
      return refusal(error);
    }
  }

  /**
   * DRAFT → AWAITING_PAYMENT through the lane that owns the order's purpose: a new
   * service through `OrderService.confirm`, a renewal or a package through
   * `CommercialActionService.confirm`. Both are exactly-once under the update's key.
   */
  async confirmDraft(
    scope: TenantContext,
    actor: ActorContext,
    order: OrderRecord,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<OrderRecord> {
    if (order.purpose === 'NEW_SERVICE' || order.purpose === 'CUSTOM_SERVICE') {
      return this.deps.orders.confirm(scope, actor, {
        idempotencyKey: `${idempotencyKey}:confirm`,
        customerId: customer.id,
        orderId: order.id,
      });
    }
    return this.deps.commercial.confirm(scope, actor, customer.id, {
      orderId: order.id,
      idempotencyKey: `${idempotencyKey}:action_confirm`,
    });
  }

  /**
   * Choosing to pay out of band: a PENDING payment, WHERE to send the money, and the
   * code to quote.
   *
   * No money moves and nothing settles. Every figure comes from what the service
   * committed — the total from the order's frozen snapshot, the reference GENERATED
   * because a customer who could choose it could choose somebody else's, and the bank
   * details from `payment_destinations`, which was written in the same transaction as
   * the payment and can never be edited afterwards.
   *
   * That last one is the whole of 5A. Before it, this message said «طبق راهنمای
   * فروشنده» — follow the seller's instructions — and the only place an operator could
   * put a card number was inside an overridden copy of this very template, where editing
   * it rewrote what every already-issued instruction said.
   *
   * A payment issued BEFORE 5A has no snapshot, and falls back to the old key. That is
   * not a lesser rendering of the same thing: it is the only thing this installation can
   * truthfully say about a payment whose destination was never recorded.
   */
  async manualPayment(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const before = await this.deps.orders.orderForCustomer(scope, actor, {
        customerId: customer.id,
        orderId,
      });
      if (before.state === 'DRAFT') {
        await this.confirmDraft(scope, actor, before, customer, idempotencyKey);
      }
      const instruction = await this.deps.payments.requestManualTransfer(
        scope,
        actor,
        customer.id,
        { idempotencyKey: `${idempotencyKey}:manual-pay`, orderId },
      );
      return this.transferInstruction(scope, instruction, orderId);
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * One button per payment route offered for paying this order, in the operator's order —
   * what «🧾 ثبت پرداخت» opens, and whether it is drawn at all.
   *
   * Built from the routes rather than from a list of providers, so a route added later
   * appears here without a change: each is dispatched by what its DESCRIPTOR says it
   * settles through. `GATEWAY` taps `gp:<order>.<provider>` (TonPays, Stars, any external
   * route); `MANUAL_TRANSFER` taps `m:<order>`, the card-to-card instruction and then the
   * receipt flow. A route that settles any other way has no order tap and is not drawn.
   *
   * Card-to-card keeps the offer rule it always had: `manualTransferOffered` (the route
   * switched on for purchases AND an enabled account to pay into), not the per-customer
   * thresholds — whether those apply to an order payment is `OQ-5C-01`. So it is drawn
   * where the operator ordered it when `routesFor` lists it, and last otherwise.
   *
   * Every button carries identifiers only. Each tap re-decides its route on the server.
   */
  async orderRouteButtons(
    scope: TenantContext,
    customerId: UserId,
    orderId: string,
    amount: Money,
  ): Promise<readonly CustomerButton[]> {
    const routes = await this.deps.routes.routesFor(scope, customerId, 'SERVICE_PURCHASE', amount);
    const manualOffered = await this.deps.payments.manualTransferOffered(scope);
    const buttons: CustomerButton[] = [];
    let manualDrawn = false;
    for (const route of routes) {
      let data: string | null = null;
      if (route.descriptor.settlesVia === 'GATEWAY') {
        data = `${GATEWAY_ROUTE_PAY_CALLBACK_PREFIX}${orderId}.${route.provider}`;
      } else if (
        route.descriptor.settlesVia === 'MANUAL_TRANSFER' &&
        manualOffered &&
        !manualDrawn
      ) {
        data = `${MANUAL_PAY_CALLBACK_PREFIX}${orderId}`;
        manualDrawn = true;
      }
      if (data === null) continue;
      buttons.push(routeButton(await this.deps.screens.routeName(scope, route), data));
    }
    if (manualOffered && !manualDrawn) {
      const name = await this.deps.screens.routeName(scope, {
        provider: 'MANUAL_TRANSFER',
        displayName: null,
      });
      buttons.push(routeButton(name, `${MANUAL_PAY_CALLBACK_PREFIX}${orderId}`));
    }
    return buttons;
  }

  /**
   * «💰 روش پرداخت خود را انتخاب نمایید» for one order: the routes `orderRouteButtons`
   * offers, then «❌ بستن لیست».
   *
   * Writes nothing. The order is read as THIS customer's, so another customer's id
   * answers the refusal, and an order no longer payable (paid, cancelled, expired) answers
   * `bot.order.not_awaiting_payment`. No payment attempt exists until a route is tapped.
   */
  async paymentMethods(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    try {
      const order = await this.deps.orders.orderForCustomer(scope, actor, {
        customerId: customer.id,
        orderId,
      });
      const close: CustomerButton = {
        ...inlineLabel('list.close'),
        data: `${PAY_METHODS_CLOSE_CALLBACK_PREFIX}${order.id}`,
      };
      if (order.state !== 'DRAFT' && order.state !== 'AWAITING_PAYMENT') {
        return {
          key: 'bot.order.not_awaiting_payment',
          values: {},
          buttons: [mainMenuButton()],
          orderId: order.id,
        };
      }
      const routes = await this.orderRouteButtons(scope, customer.id, order.id, order.totals.total);
      if (routes.length === 0) {
        return {
          key: 'bot.wallet.topup_none_available',
          values: {},
          buttons: [close],
          orderId: order.id,
          wizard: { kind: 'ORDER', step: 'METHODS', subjectId: order.id },
        };
      }
      return {
        key: 'bot.wallet.topup_method_prompt',
        values: {},
        buttons: [...routes, close],
        orderId: order.id,
        wizard: { kind: 'ORDER', step: 'METHODS', subjectId: order.id },
      };
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * «❌ بستن لیست» on an order's selector: the screen the customer opened it from, or null
   * for the main menu. Writes nothing and creates no payment.
   *
   * An order awaiting payment answers its awaiting-payment message again; a new purchase
   * still in DRAFT answers its pre-invoice again. Anything else — a commercial draft, an
   * order that was paid, cancelled or expired meanwhile — answers the main menu.
   */
  async paymentMethodsBack(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
  ): Promise<PendingReply | null> {
    try {
      const order = await this.deps.orders.orderForCustomer(scope, actor, {
        customerId: customer.id,
        orderId,
      });
      if (order.state === 'AWAITING_PAYMENT') {
        return this.awaitingPaymentReply(scope, customer, order);
      }
      if (
        order.state === 'DRAFT' &&
        (order.purpose === 'NEW_SERVICE' || order.purpose === 'CUSTOM_SERVICE')
      ) {
        return this.repricedSummary(scope, actor, order, customer);
      }
      return null;
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * Paying an order through an external gateway (WP11A). The tap carries the ORDER ID.
   *
   * The route is the first external route offered for this order, in the operator's
   * order — decided BEFORE a draft is confirmed, so a customer shown a stale button does
   * not reserve a slot for a payment they cannot make. Then the service opens (or hands
   * back) the attempt; the provider invoice is created by the worker, never while
   * Telegram waits, so the first answer is usually "being prepared" with a check button.
   *
   * A route that cannot be used right now is answered as unavailable, never as the
   * customer's payment failing (brief §19).
   */
  async gatewayPayment(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
    /** The route the customer tapped (`gp:`), or null for the older `g:` button. */
    provider: PaymentGatewayProvider | null,
  ): Promise<PendingReply> {
    try {
      const before = await this.deps.orders.orderForCustomer(scope, actor, {
        customerId: customer.id,
        orderId,
      });
      const route = (
        await this.deps.routes.routesFor(
          scope,
          customer.id,
          'SERVICE_PURCHASE',
          before.totals.total,
        )
      ).find(
        (candidate) =>
          candidate.descriptor.settlesVia === 'GATEWAY' &&
          (provider === null || candidate.provider === provider),
      );
      // R2: in the wizard, a way back to the other methods rather than a dead end.
      if (route === undefined) {
        return { ...gatewayUnavailable(), buttons: [payMethodsButton(orderId), mainMenuButton()] };
      }
      if (before.state === 'DRAFT') {
        await this.confirmDraft(scope, actor, before, customer, idempotencyKey);
      }
      const attempt = await this.deps.payments.requestGatewayPayment(scope, actor, customer.id, {
        idempotencyKey: `${idempotencyKey}:gateway-pay`,
        orderId,
        provider: route.provider,
      });
      return await this.gatewayAttemptReply(attempt, orderId, scope);
    } catch (error) {
      const refused = gatewayRefusal(error);
      return refused.key === 'bot.payment.gateway_unavailable'
        ? { ...refused, buttons: [payMethodsButton(orderId), mainMenuButton()] }
        : refused;
    }
  }

  /**
   * "Check my payment" (WP11A): the stored state, and the next inquiry brought forward.
   * Another customer's payment, or one that is not a gateway attempt, is answered as a
   * closed attempt — never with anything about it.
   */
  async gatewayCheck(
    scope: TenantContext,
    paymentId: string,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    const view = await this.deps.gateway.attemptFor(scope, customer.id, paymentId);
    if (view === null) {
      return {
        key: 'bot.payment.gateway_closed',
        values: {},
        buttons: [mainMenuButton()],
        orderId: null,
      };
    }
    await this.deps.gateway.requestCheck(scope, view);
    return this.gatewayAttemptReply({ ...view, reissued: true }, view.payment.orderId, scope);
  }

  /** An external-gateway attempt, as the customer sees it: `gatewayAttemptScreen`, now. */
  async gatewayAttemptReply(
    attempt: GatewayAttempt | GatewayAttemptView,
    orderId: string | null,
    scope: TenantContext,
  ): Promise<PendingReply> {
    const facts = await this.deps.gateway.cardFactsFor(scope, attempt.invoice);
    return gatewayAttemptScreen(attempt, orderId, this.deps.clock.now(), facts);
  }

  /**
   * «📤 ارسال فیش واریزی» (TonPays Telegram, §8.3): opens the payment-scoped receipt window
   * and asks for ONE photo, as its own message — the payment message stays as it is. Refused
   * (re-decided against the rows) with the attempt's current screen: closed, in review, a
   * receipt already on its way. The tap extends nothing.
   */
  async gatewayReceipt(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
  ): Promise<PendingReply> {
    const view = await this.deps.gateway.attemptFor(scope, customer.id, paymentId);
    /*
     * TPTG-19: another customer's payment, another bot's attempt, or no such lane is
     * answered as closed — never with anything about the attempt.
     */
    if (
      view === null ||
      view.invoice.botInstanceId !== botInstanceId ||
      this.deps.gatewayReceipts === undefined
    ) {
      return {
        key: 'bot.payment.gateway_closed',
        values: {},
        buttons: [mainMenuButton()],
        orderId: null,
      };
    }
    const window = await this.deps.gatewayReceipts.openReceiptCapture(scope, actor, {
      customerId: customer.id,
      paymentId: view.payment.id,
      botInstanceId,
    });
    if (window === null) return this.refusedCardTap(scope, view);
    return {
      key: 'bot.payment.gateway_receipt_prompt',
      values: { closesAt: window.expiresAt },
      buttons: [mainMenuButton()],
      orderId: view.payment.orderId,
      wizard: {
        kind: view.payment.orderId === null ? 'TOPUP' : 'ORDER',
        step: 'INVOICE',
        paymentId: view.payment.id,
        placement: 'NEW',
      },
    };
  }

  /**
   * «🔄 تعویض کارت» (TonPays Telegram, §8.2): a request row the worker sends; the payment
   * message is redrawn in place ("changing card…") and the worker edits the new card in.
   * Refused locally while one is in flight, during the cooldown or once exhausted — the
   * current screen is redrawn, which no longer carries the button.
   */
  async gatewayCardChange(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const view = await this.deps.gateway.attemptFor(scope, customer.id, paymentId);
    /*
     * TPTG-19: another customer's payment, another bot's attempt, or no such lane is
     * answered as closed — never with anything about the attempt.
     */
    if (
      view === null ||
      view.invoice.botInstanceId !== botInstanceId ||
      this.deps.gatewayReceipts === undefined
    ) {
      return {
        key: 'bot.payment.gateway_closed',
        values: {},
        buttons: [mainMenuButton()],
        orderId: null,
      };
    }
    const requested = await this.deps.gatewayReceipts.requestCardChange(scope, actor, {
      customerId: customer.id,
      paymentId: view.payment.id,
      botInstanceId,
      idempotencyKey: `${idempotencyKey}:card-change`,
    });
    const fresh = (await this.deps.gateway.attemptFor(scope, customer.id, paymentId)) ?? view;
    if (requested) {
      return this.gatewayAttemptReply({ ...fresh, reissued: true }, fresh.payment.orderId, scope);
    }
    /*
     * R8 A2: the button is drawn during a cooldown, so a press inside one is answered with the
     * seconds left and the invoice stays exactly as it is — the manual switch's answer
     * (R5C-1). The refusal itself was decided under the payment's lock; this only explains it.
     */
    if (fresh.payment.state === 'PENDING') {
      const facts = await this.deps.gateway.cardFactsFor(scope, fresh.invoice);
      const decision = decideCardChange(
        fresh.invoice,
        facts?.latestChange ?? null,
        this.deps.clock.now(),
        facts?.changeAllowance ?? null,
      );
      if (decision.kind === 'COOLDOWN') {
        return {
          key: null,
          values: {},
          buttons: [],
          orderId: null,
          toast: {
            key: 'bot.payment.switch_card_cooldown',
            values: { seconds: decision.retryAfterSeconds },
          },
        };
      }
    }
    return this.refusedCardTap(scope, fresh);
  }

  /**
   * «❌ لغو فاکتور» (Round 6): the question first. Writes nothing. Offered only while the
   * cancel can be asked for (a `pending` invoice, the customer window, nothing in flight);
   * otherwise the attempt's current screen is redrawn. The confirm button carries the
   * destructive prefix; «🔎» is the way back.
   */
  async gatewayCancelAsk(
    scope: TenantContext,
    paymentId: string,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
  ): Promise<PendingReply> {
    const view = await this.deps.gateway.attemptFor(scope, customer.id, paymentId);
    if (
      view === null ||
      view.invoice.botInstanceId !== botInstanceId ||
      this.deps.gatewayReceipts === undefined
    ) {
      return {
        key: 'bot.payment.gateway_closed',
        values: {},
        buttons: [mainMenuButton()],
        orderId: null,
      };
    }
    const offered = await this.deps.gatewayReceipts.cancelOffered(scope, {
      customerId: customer.id,
      paymentId: view.payment.id,
      botInstanceId,
    });
    if (!offered) return this.refusedCardTap(scope, view);
    return {
      key: 'bot.payment.gateway_cancel_confirm',
      values: { reference: paymentTrackingCode(view.payment) },
      buttons: [
        {
          ...inlineLabel('payment.gateway_cancel_confirm'),
          data: `${GATEWAY_CANCEL_CALLBACK_PREFIX}${view.payment.id}`,
        },
        cardCheck(view.payment.id),
      ],
      orderId: view.payment.orderId,
      wizard: {
        kind: view.payment.orderId === null ? 'TOPUP' : 'ORDER',
        step: 'INVOICE',
        paymentId: view.payment.id,
      },
    };
  }

  /**
   * The confirmed cancel (Round 6): a request row the worker sends; the payment message is
   * redrawn as "cancelling…" and the worker edits the result in. Re-decided against the rows
   * under the payment's lock; a refusal redraws the attempt as it stands.
   */
  async gatewayCancel(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const view = await this.deps.gateway.attemptFor(scope, customer.id, paymentId);
    if (
      view === null ||
      view.invoice.botInstanceId !== botInstanceId ||
      this.deps.gatewayReceipts === undefined
    ) {
      return {
        key: 'bot.payment.gateway_closed',
        values: {},
        buttons: [mainMenuButton()],
        orderId: null,
      };
    }
    const requested = await this.deps.gatewayReceipts.requestCancel(scope, actor, {
      customerId: customer.id,
      paymentId: view.payment.id,
      botInstanceId,
      idempotencyKey: `${idempotencyKey}:gateway-cancel`,
    });
    const fresh = (await this.deps.gateway.attemptFor(scope, customer.id, paymentId)) ?? view;
    return requested
      ? this.gatewayAttemptReply({ ...fresh, reissued: true }, fresh.payment.orderId, scope)
      : this.refusedCardTap(scope, fresh);
  }

  /**
   * «💳 ثبت کارت بازگشت وجه» (Round 6): opens the text window that reads the refund card and
   * asks for it as its own message. Offered only for an overpaid invoice whose refund is not
   * already pending or in flight.
   */
  async gatewayRefundCardPrompt(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
    updateId: bigint | undefined,
  ): Promise<PendingReply> {
    const view = await this.deps.gateway.attemptFor(scope, customer.id, paymentId);
    if (
      view === null ||
      view.invoice.botInstanceId !== botInstanceId ||
      this.deps.gatewayReceipts === undefined
    ) {
      return {
        key: 'bot.payment.gateway_closed',
        values: {},
        buttons: [mainMenuButton()],
        orderId: null,
      };
    }
    const offered = await this.deps.gatewayReceipts.refundCardOffered(scope, {
      customerId: customer.id,
      paymentId: view.payment.id,
      botInstanceId,
    });
    if (!offered) return this.refusedCardTap(scope, view);
    await this.deps.captures.open(scope, actor, {
      idempotencyKey: `${idempotencyKey}:refund-card-open`,
      botInstanceId,
      customerId: customer.id,
      purpose: 'GATEWAY_REFUND_CARD',
      subjectId: view.payment.id,
      // The card must be typed after this tap.
      ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
    });
    return {
      key: 'bot.payment.gateway_refund_card_prompt',
      values: { reference: paymentTrackingCode(view.payment) },
      buttons: [cardCheck(view.payment.id), mainMenuButton()],
      orderId: view.payment.orderId,
      wizard: {
        kind: view.payment.orderId === null ? 'TOPUP' : 'ORDER',
        step: 'INVOICE',
        paymentId: view.payment.id,
        placement: 'NEW',
      },
    };
  }

  /**
   * The customer's answer to the refund-card prompt (Round 6): two lines, validated locally,
   * sealed and queued. The text is used for exactly that and is never logged, echoed or stored
   * — the reply shows the card masked. A bad format reopens the window, so the next message is
   * still read.
   */
  async gatewayRefundCardText(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    capture: { readonly subjectId: string | null },
    text: string,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update?: unknown;
    },
  ): Promise<PendingReply | null> {
    const paymentId = capture.subjectId;
    if (paymentId === null || this.deps.gatewayReceipts === undefined) return null;
    const view = await this.deps.gateway.attemptFor(scope, customer.id, paymentId);
    if (view === null || view.invoice.botInstanceId !== input.botInstanceId) {
      return {
        key: 'bot.payment.gateway_closed',
        values: {},
        buttons: [mainMenuButton()],
        orderId: null,
      };
    }
    const result = await this.deps.gatewayReceipts.requestRefund(scope, actor, {
      customerId: customer.id,
      paymentId: view.payment.id,
      botInstanceId: input.botInstanceId,
      idempotencyKey: `${input.idempotencyKey}:gateway-refund`,
      text,
    });
    const reference = paymentTrackingCode(view.payment);
    if (result === 'INVALID') {
      const updateId = updateIdOf(input.update);
      await this.deps.captures.open(scope, actor, {
        idempotencyKey: `${input.idempotencyKey}:refund-card-reopen`,
        botInstanceId: input.botInstanceId,
        customerId: customer.id,
        purpose: 'GATEWAY_REFUND_CARD',
        subjectId: view.payment.id,
        ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
      });
      return {
        key: 'bot.payment.gateway_refund_card_invalid',
        values: {},
        buttons: [cardCheck(view.payment.id), mainMenuButton()],
        orderId: view.payment.orderId,
      };
    }
    if (result === 'REFUSED') return this.refusedCardTap(scope, view);
    const refunds = await this.deps.gateway.cardFactsFor(scope, view.invoice);
    return {
      key: 'bot.payment.gateway_refund_requested',
      values: {
        reference,
        ...(refunds?.latestRefund?.refundCardMasked == null
          ? {}
          : { maskedCard: refunds.latestRefund.refundCardMasked }),
      },
      buttons: [cardCheck(view.payment.id), mainMenuButton()],
      orderId: view.payment.orderId,
    };
  }

  /**
   * A refused `gr:`/`gk:` (TPTG-19): a payment still PENDING (a receipt already on its way, a
   * cooldown) or in review / UNKNOWN is redrawn as it stands — the review screens included;
   * anything else that is no longer payable answers `gateway_closed` and nothing more.
   */
  refusedCardTap(
    scope: TenantContext,
    view: GatewayAttemptView,
  ): Promise<PendingReply> | PendingReply {
    if (view.payment.state === 'PENDING' || view.payment.state === 'UNKNOWN') {
      return this.gatewayAttemptReply({ ...view, reissued: true }, view.payment.orderId, scope);
    }
    return {
      key: 'bot.payment.gateway_closed',
      values: { reference: paymentTrackingCode(view.payment) },
      buttons: [mainMenuButton()],
      orderId: null,
    };
  }

  /**
   * A photo for an open provider receipt window in THIS bot (§8.3), or null when none is
   * open — the caller then runs the manual flow exactly as before.
   */
  async gatewayReceiptPhoto(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    file: InboundReceiptFile,
  ): Promise<PendingReply | null> {
    if (this.deps.gatewayReceipts === undefined) return null;
    /*
     * FIX-02 (Codex review of #253): the window's payment, read BEFORE the photo can close it,
     * so a photo that arrives after the window's deadline is answered with the code the
     * invoice carried. Only a read; `receivePhoto` decides everything, again, under its lock.
     */
    const window = await this.deps.gatewayReceipts.openCaptureFor(
      scope,
      botInstanceId,
      customer.id,
    );
    const result = await this.deps.gatewayReceipts.receivePhoto(scope, actor, {
      customerId: customer.id,
      botInstanceId,
      file,
    });
    const reply = (key: TemplateKey): PendingReply => ({
      key,
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
    });
    switch (result) {
      case 'NO_WINDOW':
        return null;
      case 'QUEUED':
      case 'DUPLICATE':
        return reply('bot.payment.gateway_receipt_queued');
      case 'ALREADY_SENT':
        return reply('bot.payment.gateway_receipt_already_sent');
      case 'PHOTO_ONLY':
        return reply('bot.payment.gateway_receipt_photo_only');
      case 'TOO_LARGE':
        return reply('bot.payment.gateway_receipt_too_large');
      case 'CLOSED':
        return {
          ...reply('bot.payment.gateway_closed'),
          values: await this.ownedTrackingCode(scope, customer, botInstanceId, window?.paymentId),
        };
    }
  }

  /**
   * FIX-02: `{ reference }` for a gateway attempt that is THIS customer's, in THIS bot — the
   * ownership check `attemptFor` makes — else `{}`, whose optional line is then dropped. A
   * payment that is not theirs is never named (TPTG-19).
   */
  async ownedTrackingCode(
    scope: TenantContext,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    paymentId: string | undefined,
  ): Promise<TemplateValues> {
    if (paymentId === undefined) return {};
    const view = await this.deps.gateway.attemptFor(scope, customer.id, paymentId);
    if (view === null || view.invoice.botInstanceId !== botInstanceId) return {};
    return { reference: paymentTrackingCode(view.payment) };
  }

  /**
   * The transfer invoice, rendered once for every payment that needs one.
   *
   * Shared by the order path and the wallet top-up path — the owner's 5B instruction is
   * to reuse this UX rather than build a second one, and sharing the FUNCTION is what
   * makes that structural: a change to the destination block, the copy buttons or the
   * receipt button reaches both, and neither can drift into telling a customer something
   * the other does not.
   *
   * `orderId` is null for a top-up. It travels on the reply rather than being read off
   * the payment because the messenger uses it for correlation, and a top-up correlates
   * to no order.
   */
  async transferInstruction(
    scope: TenantContext,
    { payment, destination }: ManualTransferInstruction,
    orderId: string | null,
  ): Promise<PendingReply> {
    /*
     * The two copy controls, and they exist only when there is a snapshot to copy from.
     *
     * `copy_text` is Telegram's own clipboard button: no callback data, no handler,
     * nothing reaches this server when one is tapped. The amount is copied as BARE
     * digits — `plainAmount`, not `formatMoney` — because a banking app rejects
     * «۱٬۵۰۰٬۰۰۰ تومان` and accepts `1500000`.
     *
     * `row: 0` puts them side by side above the actions, which is the layout the owner
     * specified after staging acceptance.
     */
    /*
     * R8 A2: the owner-approved card invoice's first row — the amount in RIAL digits (what
     * must be TRANSFERRED: the payable, with any customer fee, R6 item 4) and the card's
     * sixteen digits without spaces.
     */
    const copies: CustomerButton[] =
      destination === null
        ? []
        : [
            copyRialAmountButton(amountToTransfer(payment)),
            copyCardNumberButton(destination.cardNumber),
          ];

    const switchOffer =
      destination === null || this.deps.cardSwitch === undefined
        ? null
        : await this.deps.cardSwitch.offer(scope, payment);
    const switchCard: CustomerButton[] =
      switchOffer === null || !switchOffer.offered
        ? []
        : [
            {
              ...inlineLabel('payment.switch_card'),
              data: `${PAY_SWITCH_CARD_CALLBACK_PREFIX}${payment.id}.${String(switchOffer.sequence)}`,
              row: CARD_INVOICE_ROW.SWITCH,
            },
          ];

    return {
      key:
        destination === null
          ? 'bot.payment.manual_instructions'
          : 'bot.payment.transfer_instructions',
      values: {
        // R6 item 4: the PAYABLE (principal plus the customer fee when the route charges
        // one). The principal and the fee are shown apart, from this payment's own snapshot.
        total: amountToTransfer(payment),
        ...(payment.customerFee !== null && payment.customerFee.fee.amountMinor > 0n
          ? { principal: payment.amount, fee: payment.customerFee.fee }
          : {}),
        reference: paymentTrackingCode(payment),
        // R8 A2: the amount in rial (Toman beside it) and the deadline's time of day.
        ...cardInvoiceAmountValues(amountToTransfer(payment)),
        ...(payment.expiresAt === null ? {} : { expiresTime: payment.expiresAt }),
        /*
         * Composed behind the application layer, by the renderer this surface is
         * handed. A surface may not resolve the catalogue — `check-boundaries.sh`
         * refuses an `@nexa/i18n` import here — and the four destination lines are
         * catalogue text like any other.
         */
        ...(destination === null
          ? {}
          : { destination: await this.deps.destinations.render(scope, destination) }),
      },
      /*
       * The way out, beside the instructions that created the obligation.
       *
       * It names the PAYMENT rather than the order, which is the only id here that
       * identifies what a withdrawal would close: an order can have had several
       * payments over its life, and this message is about one of them.
       *
       * It carries the ASK prefix. Tapping it closes nothing — it answers with a
       * question and one further button — because this message stays in the chat for
       * ever and a customer who has already transferred the money is one mis-touch
       * away from closing the payment it was against.
       */
      buttons: [
        ...copies,
        /*
         * The step the instructions now tell them to take.
         *
         * The Persian used to end «سپس رسید را ارسال نمایید» — send the receipt — and
         * no surface in this product accepts one (owner revision 17). So a customer
         * who had transferred the money had nothing to do and nothing to say, and
         * `bot.payment.received_for_review` was a frozen sentence with no producer.
         *
         * The owner's 5A addendum reverses that revision and asks for this label to
         * become «✅ پرداخت را انجام دادم | ارسال رسید», which is what 5R made it: one
         * button whose tap records the claim AND opens the upload window. The label is
         * a template key, so the catalogue carries the wording and this carries the
         * intent.
         *
         * First among the actions, before the withdrawal: it is what most customers
         * who come back to this message want, and the destructive one should not be
         * the nearest thumb.
         */
        /*
         * R4 A1: «🔄 تغییر شماره کارت», only while another enabled card exists and the press
         * limit (when the owner set one) is not reached. Its tap re-decides all of that under
         * the payment's lock; drawing it authorises nothing.
         */
        ...switchCard,
        {
          ...inlineLabel('payment.sent'),
          data: `${PAY_SENT_CALLBACK_PREFIX}${payment.id}`,
          ...(destination === null ? {} : { row: CARD_INVOICE_ROW.ACTIONS }),
        },
        {
          ...inlineLabel('payment.cancel'),
          data: `${CANCEL_PAY_ASK_CALLBACK_PREFIX}${payment.id}`,
          ...(destination === null ? {} : { row: CARD_INVOICE_ROW.ACTIONS }),
        },
        // R8 A2: the way home, on its own last row.
        ...(destination === null ? [] : [mainMenuButton()]),
      ],
      orderId,
      // R2: the invoice screen of the order's (or the top-up's) wizard.
      wizard: {
        kind: orderId === null ? 'TOPUP' : 'ORDER',
        step: 'INVOICE',
        paymentId: payment.id,
        ...(orderId === null ? {} : { subjectId: orderId }),
      },
    };
  }

  /**
   * Withdrawing a pending transfer the customer decided not to make.
   *
   * The button that reaches this is attached to `bot.payment.manual_instructions` — the
   * message that gave them the reference — so it sits beside the thing it undoes. That
   * message lives in the chat for ever, which is exactly why the service re-reads the
   * state rather than trusting the tap: a customer scrolling back to it a week later
   * gets `bot.payment.not_pending`, not a second withdrawal of something already closed.
   *
   * The reply does NOT say the order is gone, because it is not: a withdrawal closes the
   * payment and leaves the order open until its own deadline, so the customer may pay
   * from their wallet instead. `bot.payment.cancelled` says so.
   */
  /**
   * The question between the cancel button and the withdrawal.
   *
   * It writes nothing and closes nothing. Its only job is to say what is about to
   * happen and offer the ONE button that carries the destructive prefix —
   * `serviceRotateAsk` is the same shape one aggregate over.
   *
   * The payment is re-read here rather than trusted from whichever message was tapped:
   * a customer whose payment an operator has since rejected, or the sweep has expired,
   * is told it is no longer pending instead of being shown a question whose answer
   * would be refused.
   */
  async cancelPaymentAsk(
    scope: TenantContext,
    paymentId: string,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    const payment = await this.deps.payments.pendingTransferForCustomer(
      scope,
      customer.id,
      paymentId,
    );
    if (payment === null) {
      return { key: 'bot.payment.not_pending', values: {}, buttons: [], orderId: null };
    }
    return {
      key: 'bot.payment.cancel_confirm',
      // FIX-02: the question replaces the invoice; the code it carried stays on the message.
      values: { reference: paymentTrackingCode(payment) },
      buttons: [
        {
          ...inlineLabel('payment.cancel_confirm'),
          data: `${CANCEL_PAY_CALLBACK_PREFIX}${payment.id}`,
        },
      ],
      orderId: null,
    };
  }

  async cancelPayment(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      await this.deps.payments.withdrawPending(scope, actor, customer.id, {
        idempotencyKey: `${idempotencyKey}:cancel-pay`,
        paymentId,
      });
      return { key: 'bot.payment.cancelled', values: {}, buttons: [], orderId: null };
    } catch (error) {
      return withdrawalRefusal(error);
    }
  }

  /**
   * The customer saying they have sent the transfer, AND asking to send its receipt.
   *
   * ONE tap for both, which is what the Payment UX addendum fixes: the button reads
   * «✅ پرداخت را انجام دادم | ارسال رسید» and `signalTransferSent` stamps the claim
   * and opens the upload window in the same transaction. Two buttons would be two ways
   * to reach one action, and a customer who pressed only the first would have a window
   * open with no idea it was there.
   *
   * It still moves no money and no state. `bot.payment.receipt_prompt` says exactly
   * what is true — the claim is recorded, nothing has been received or verified, and
   * the file may be sent now — and the caution `bot.payment.received_for_review`
   * carries applies to it word for word.
   *
   * Two replies, because `receiptWindow` is genuinely null in two cases: a redelivered
   * tap whose window has since closed, and a payment already past its own deadline,
   * where asking for evidence nobody can act on would be the wrong thing to do. Those
   * get the older sentence, which is true without promising an upload.
   *
   * No button on either. The instructions message above still carries both, which is
   * where a customer who wants to withdraw after all will look — and re-offering "I
   * have sent it" under a message saying it is recorded invites a second tap.
   */
  /**
   * R4 A1: «🔄 تغییر شماره کارت». The answer is the SAME invoice, edited in place (the tap's
   * wizard gate, `from: ['INVOICE']`), drawn from what the service recorded: the new card when
   * one was switched to, the card recorded now when nothing was (a second tap of one keyboard,
   * the limit reached). The payment, its amount and its tracking code are the invoice's own.
   * A payment no longer an open card-to-card invoice is answered as a stale payment tap is.
   */
  async switchCard(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    expectedSequence: number,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    if (this.deps.cardSwitch === undefined) return staleCallbackReply();
    try {
      const result = await this.deps.cardSwitch.switchCard(scope, actor, customer.id, {
        idempotencyKey: `${idempotencyKey}:card-switch`,
        paymentId,
        expectedSequence,
      });
      /*
       * R5C-1: a press that came too early is a notice on the button and nothing else — the
       * invoice stays exactly as it is. A press over a limit is the same notice, and the
       * invoice is redrawn (below) without the button the limit has taken away.
       */
      if (result.outcome === 'COOLDOWN') {
        return {
          key: null,
          values: {},
          buttons: [],
          orderId: null,
          toast: {
            key: 'bot.payment.switch_card_cooldown',
            values: { seconds: result.retryAfterSeconds },
          },
        };
      }
      const refused =
        result.outcome === 'UNCHANGED' && result.reason === 'LIMIT'
          ? { toast: { key: 'bot.payment.switch_card_refused' as const, values: {} } }
          : {};
      const instruction = result.instruction;
      if (instruction === null) {
        return {
          key: 'bot.payment.not_pending',
          values: {},
          buttons: [mainMenuButton()],
          orderId: null,
        };
      }
      return {
        ...(await this.transferInstruction(scope, instruction, instruction.payment.orderId)),
        ...refused,
      };
    } catch (error) {
      return refusal(error);
    }
  }

  async signalTransferSent(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const { payment, receiptWindow } = await this.deps.payments.signalTransferSent(
        scope,
        actor,
        customer.id,
        { idempotencyKey: `${idempotencyKey}:pay-sent`, paymentId, botInstanceId },
      );
      /*
       * Owner spec §2.4: the tap EDITS the invoice it was on (its claim, `PAY_SENT`'s gate).
       * The card details and the copy buttons go with the old screen; the wizard keeps its
       * kind and its order, and names the payment so the receipt can find this message.
       */
      const screen = (step: 'RECEIPT_WAIT' | 'RECEIPT_REVIEW'): WizardDirective => ({
        kind: payment.orderId === null ? 'TOPUP' : 'ORDER',
        step,
        paymentId: payment.id,
        ...(payment.orderId === null ? {} : { subjectId: payment.orderId }),
      });
      if (receiptWindow === null) {
        return {
          key: 'bot.payment.received_for_review',
          // Roadmap E6: the code the invoice carried stays on the message that replaces it.
          values: { reference: paymentTrackingCode(payment) },
          // Nothing more to do on this message: no button, as the receipt's final state.
          buttons: [],
          orderId: null,
          fallback: { kind: 'PAYMENT_TRANSFER_RECORDED', subjectId: paymentId },
          wizard: screen('RECEIPT_REVIEW'),
        };
      }
      return {
        key: 'bot.payment.receipt_prompt',
        /*
         * A NUMBER, not a string. `minutes` is declared `type: 'NUMBER'`, and the
         * resolver VALIDATES values against the declaration — a string refused the
         * whole render, which the webhook then swallowed: the claim committed and the
         * customer was told nothing at all after tapping the button.
         */
        values: {
          minutes: receiptWindow.minutes,
          // FIX-02: this edits the invoice — the code it carried stays on the message.
          reference: paymentTrackingCode(payment),
        },
        /*
         * Owner spec §2.4, state 2: the receipt is asked for, with no card details and no
         * copy buttons. The withdrawal stays — the invoice it replaced offered it, and a
         * customer who did not pay after all must still be able to close the payment.
         */
        buttons: [
          {
            ...inlineLabel('payment.cancel'),
            data: `${CANCEL_PAY_ASK_CALLBACK_PREFIX}${payment.id}`,
          },
        ],
        orderId: null,
        wizard: { ...screen('RECEIPT_WAIT'), receiptPrompt: { customerId: customer.id } },
        /*
         * The fallback is the CLAIM, not the prompt.
         *
         * `PAYMENT_TRANSFER_RECORDED` is what the notification lane can say, and it is
         * the half that matters when the interactive reply could not be delivered: a
         * customer who does not learn their claim is on record sends the money again.
         * Asking for a receipt through a lane whose messages arrive minutes later
         * would ask for one after the window it names had closed.
         */
        fallback: { kind: 'PAYMENT_TRANSFER_RECORDED', subjectId: paymentId },
      };
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * A file the customer sent while a window was open for them.
   *
   * What it attaches to is decided by the WINDOW, never by anything in the update: the
   * row names one payment, and `ReceiptService` re-reads that payment's state and owner
   * inside the transaction that files the row. So a client that invents a file reaches a
   * payment only if a window for that customer on that bot is genuinely open, and a
   * customer who sends a screenshot at random is told nothing was expected.
   *
   * A10 (pre-support brief §10, superseding owner spec §2.4 "state 3"): the invoice is
   * edited up to the receipt and no further message is sent until one arrives. On the FIRST
   * receipt filed for the payment, two things happen, in this order:
   *
   * 1. the invoice (at the prompt, or already final) is edited into its final, button-less
   *    state — `bot.payment.received_for_review`, which names the claim and not the file;
   * 2. ONE new message goes out: `bot.payment.receipt_received`, the brief's two sentences.
   *
   * "First" is `ReceiptService`'s answer, decided in the transaction that inserted the
   * payment's first row and FALSE on an idempotent replay — so a redelivered update, a
   * second file, the same file sent again and the fifth file all send nothing new. That is
   * durable state, not memory: two replicas, a restart between deliveries and two files
   * racing all read the same rows. A further receipt still re-asserts the invoice's final
   * state (an edit Telegram answers "not modified" when nothing changed), which is not a new
   * message.
   *
   * No fallback. The notification lane's kinds are a closed set with no payload, and
   * there is no frozen kind that means "your receipt arrived" — inventing one to cover
   * a failed interactive send is what ADR-0030 §1 refuses.
   */
  async submitReceipt(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    chatId: string | null,
    file: InboundReceiptFile,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const submitted = await this.deps.receipts.submit(scope, actor, customer.id, {
        idempotencyKey: `${idempotencyKey}:receipt`,
        botInstanceId,
        file,
      });
      /*
       * No poke from here (WP10 follow-up §3). Filing the receipt wrote a
       * `PaymentReceiptSubmitted` event in the same transaction, and the administrators'
       * push is that event's consumer and its own lane — durable with the receipt, never
       * able to cost the customer this answer, and not lost by a crash after the commit.
       */
      /*
       * BEST EFFORT, and that is load-bearing. The receipt has committed: a throw here (the
       * wizard row's write refused by a recovery quiesce, a guard, a lost connection) would
       * fail the turn, and its redelivery answers `first: false` — so the one new message
       * would never go out, or a refusal would be shown for a receipt that was filed. The
       * invoice keeps its prompt instead, and the failure is logged rather than swallowed.
       */
      if (chatId !== null) {
        try {
          await this.finaliseReceiptInvoice(
            scope,
            actor,
            botInstanceId,
            chatId,
            customer.id,
            submitted.paymentId,
            idempotencyKey,
          );
        } catch (error) {
          this.deps.logger?.error(
            { err: error, paymentId: submitted.paymentId, tenantId: scope.tenantId },
            'receipt invoice finalisation failed; the receipt is filed and its message still goes',
          );
        }
      }
      if (!submitted.first) return { key: null, values: {}, buttons: [], orderId: null };
      return { key: 'bot.payment.receipt_received', values: {}, buttons: [], orderId: null };
    } catch (error) {
      return receiptRefusal(error);
    }
  }

  /**
   * A10: the invoice of THIS payment in this chat, waiting at the receipt prompt (or already
   * final), edited into its final state with NO button — no status check, no resend, no
   * cancel, no copy, no card details. Either kind (`ORDER` or `TOPUP`).
   *
   * Claimed through `claimLatest`, which skips a wizard another turn holds: the
   * «پرداخت را انجام دادم» turn lands its prompt HELD until the prompt is on the message
   * (Codex 4170910529), and `settleReceiptPrompt` ends that message in this same state once
   * it releases the hold. With no such message — an invoice from before R2, or one already
   * moved on — nothing is edited, and the new message alone answers the receipt. A refused
   * edit is not re-sent as a new message: the new message is the one the customer is owed.
   */
  async finaliseReceiptInvoice(
    scope: TenantContext,
    actor: ActorContext,
    botInstanceId: BotInstanceId,
    chatId: string,
    customerId: UserId,
    paymentId: PaymentId,
    updateKey: string,
  ): Promise<void> {
    const state = this.deps.messageState;
    if (state === undefined) return;
    const target = await state.claimLatest(scope, actor, {
      botInstanceId,
      chatId,
      kind: null,
      steps: ['RECEIPT_WAIT', 'RECEIPT_REVIEW'],
      subjectId: null,
      paymentId,
      updateKey,
    });
    if (target === null) return;
    const landed = await state.land(scope, actor, target, {
      kind: target.kind,
      step: 'RECEIPT_REVIEW',
      subjectId: target.subjectId,
      paymentId,
      updateKey,
    });
    if (!landed) return;
    await editSent(
      this.deps.messenger,
      scope,
      {
        chatId: target.chatId,
        messageId: target.messageId,
        botInstanceId: target.botInstanceId,
        templateKey: RECEIPT_INVOICE_FINAL_KEY,
        values: await this.receiptInvoiceFinalValues(scope, actor, customerId, paymentId),
        buttons: [],
      },
      false,
    );
  }

  /**
   * Roadmap E6: what the invoice's final state renders — the payment's tracking code, so the
   * one code the customer quotes is still in the chat after the invoice that first carried
   * it is edited. An unreadable code drops the line (the template's optional token), never
   * the edit.
   */
  async receiptInvoiceFinalValues(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    paymentId: PaymentId,
  ): Promise<TemplateValues> {
    /*
     * Never the reason the edit does not happen (review of PR #243, m4): the wizard is
     * already marked final when this runs, so a throw here would leave the prompt on the
     * message with nothing left to retry it. An unreadable code drops the line instead.
     */
    try {
      const reference = await this.deps.receipts.trackingCodeForCustomer(
        scope,
        actor,
        customerId,
        paymentId,
      );
      return reference === null ? {} : { reference };
    } catch (error) {
      this.deps.logger?.error(
        { err: error, paymentId, tenantId: scope.tenantId },
        'reading the tracking code for the final invoice failed; edited without it',
      );
      return {};
    }
  }

  /**
   * The question between the cancel-order button and the cancellation.
   *
   * `cancelPaymentAsk` one aggregate over is the same shape and states the reasons: it
   * writes nothing, it offers the ONE button carrying the destructive prefix, and it
   * re-reads rather than trusting whichever message was tapped.
   *
   * The re-read goes through `awaitingPaymentForCustomer`, NOT `orders.get`. That one
   * is the operator's read and checks `orders.view`, which this turn does not hold —
   * a job actor holds `maintenance.run` and nothing else (see the job permission list
   * in `packages/contracts/src/permissions.ts`, named there rather than here because
   * `check:boundaries` refuses a surface that so much as mentions it) — so the first
   * version of this method refused every customer who tapped the button. Nothing
   * asserting only that the BUTTON was drawn would have noticed.
   *
   * Ownership and state are both compared against the ROW, so a customer holding
   * somebody else's order id is answered exactly as one holding an id that does not
   * exist. The cancellation re-checks both inside its own transaction; this check is
   * about not drawing a question, not about authorization.
   */
  async cancelOrderAsk(
    scope: TenantContext,
    orderId: string,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    try {
      const order = await this.deps.orders.awaitingPaymentForCustomer(scope, customer.id, orderId);
      if (order === null) {
        return { key: 'bot.order.not_awaiting_payment', values: {}, buttons: [], orderId: null };
      }
      return {
        key: 'bot.order.cancel_confirm',
        values: {},
        buttons: [
          {
            ...inlineLabel('order.cancel_confirm'),
            data: `${CANCEL_ORDER_CALLBACK_PREFIX}${order.id}`,
          },
        ],
        orderId: order.id,
      };
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * The customer withdrawing their own unpaid order.
   *
   * `ORDER_MACHINE`'s `CANCEL` edge reaching a surface at last —
   * `docs/phase4h-audit.md` §3 measured that 4G made it writable and left it with no
   * caller, and `bot.order.cancelled` a frozen sentence with nowhere to be sent from.
   *
   * The reply says the ORDER is gone and says nothing about a payment, although the
   * service withdrew any pending transfer in the same transaction. That is not an
   * omission: a customer who reaches this has been told about the order, which is the
   * thing they acted on, and a second sentence about a reference they were about to
   * stop using is noise. The refusal when they HAVE claimed to pay is the case where
   * the payment matters, and it has its own key.
   */
  async cancelOrder(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      await this.deps.orders.cancelByCustomer(scope, actor, {
        idempotencyKey: `${idempotencyKey}:cancel-order`,
        customerId: customer.id,
        orderId,
      });
      return {
        key: 'bot.order.cancelled',
        values: {},
        buttons: [],
        orderId: null,
        // The order is gone. A customer who does not learn that keeps waiting for
        // a service that will never be made.
        fallback: { kind: 'ORDER_CANCELLED', subjectId: orderId },
      };
    } catch (error) {
      return refusal(error);
    }
  }

  /** Best effort, after the answer, and never allowed to fail the turn. */
  /** R2: the tapped message, by its identity. */
  refOf(
    botInstanceId: BotInstanceId,
    origin: CallbackOrigin,
  ): { botInstanceId: BotInstanceId; chatId: string; messageId: number } {
    return { botInstanceId, chatId: origin.chatId, messageId: origin.messageId };
  }

  /**
   * R2 (item 5): shows a wizard step by EDITING the wizard's message.
   *
   * The message is the tapped one (`claim`), or — for a typed answer — the chat's latest
   * wizard waiting at the step that asked for it (`reply.wizard.anchor`), in which case the
   * customer's own typed message is deleted once the wizard shows the next step, so the
   * wizard stays the last thing in the chat.
   *
   * Null hands the reply back to the ordinary send: nothing was waiting for a typed answer,
   * or the reply must be its own message (`placement: 'NEW'`, a main-menu keyboard, a file).
   *
   * The landing is written BEFORE the edit, so a tap on the new keyboard finds the new
   * screen. When Telegram refuses the edit outright (a message it will not edit any more),
   * the smallest fallback is taken: the same screen as a NEW message, and the wizard moves
   * onto it. A landing overtaken by the gateway worker — which has the fresher invoice —
   * answers nothing: the worker's edit is the one the message keeps.
   */
  async editWizard(
    scope: TenantContext,
    actor: ActorContext,
    reply: PendingReply,
    claim: TelegramWizardRecord | null,
    origin: CallbackOrigin | null,
    chatId: string,
    input: {
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
      readonly idempotencyKey: string;
    },
  ): Promise<CustomerSendOutcome | 'NOT_ATTEMPTED' | null> {
    const state = this.deps.messageState;
    if (state === undefined || reply.key === null) return null;
    const directive = reply.wizard;
    let target = claim;
    let typed = false;
    if (target === null) {
      if (directive?.anchor === undefined) return null;
      target = await state.claimLatest(scope, actor, {
        botInstanceId: input.botInstanceId,
        chatId,
        kind: directive.anchor.anyKind === true ? null : directive.kind,
        steps: directive.anchor.steps,
        subjectId: directive.anchor.subjectId ?? null,
        paymentId: directive.anchor.paymentId ?? null,
        updateKey: input.idempotencyKey,
      });
      if (target === null) return null;
      typed = true;
    }
    /*
     * Its own message after all: a reply the handler marked so; one that needs the reply
     * keyboard, a file or a lead (Telegram edits none of them into a text message); and a
     * bare refusal no handler drew for the wizard — a product withdrawn, a code refused —
     * which must not replace the screen the customer can still choose from with a dead end.
     */
    if (
      directive?.placement === 'NEW' ||
      (directive === undefined && reply.buttons.length === 0) ||
      reply.keyboard !== undefined ||
      reply.media !== undefined ||
      reply.lead !== undefined
    ) {
      await state.release(scope, actor, target);
      return null;
    }
    const loading = directive?.invoicePending === true && directive.paymentId != null;
    const prompt =
      directive?.receiptPrompt !== undefined && directive.paymentId != null
        ? { customerId: directive.receiptPrompt.customerId, paymentId: directive.paymentId }
        : null;
    const landed = await state.land(scope, actor, target, {
      kind:
        directive === undefined || directive.anchor?.anyKind === true
          ? target.kind
          : directive.kind,
      step: directive?.step ?? 'NOTICE',
      subjectId: directive?.subjectId !== undefined ? directive.subjectId : target.subjectId,
      paymentId: directive?.paymentId !== undefined ? directive.paymentId : target.paymentId,
      updateKey: input.idempotencyKey,
      // The loading screen is landed at INVOICE_LOADING and HELD until it is marked below; the
      // receipt prompt is held until it is on the message (Codex 4170910529).
      ...(loading || prompt !== null ? { hold: true } : {}),
    });
    if (!landed) return 'NOT_ATTEMPTED';
    let edited = await editSent(
      this.deps.messenger,
      scope,
      {
        chatId: target.chatId,
        messageId: target.messageId,
        botInstanceId: target.botInstanceId,
        templateKey: reply.key,
        values: reply.values,
        buttons: reply.buttons,
      },
      !typed && origin !== null && origin.media,
    );
    if (edited.outcome === 'REFUSED') {
      edited = await this.deps.messenger.send(scope, {
        chatId: target.chatId,
        templateKey: reply.key,
        values: reply.values,
        botInstanceId: target.botInstanceId,
        ...(reply.buttons.length === 0 ? {} : { buttons: reply.buttons }),
      });
      if (edited.outcome === 'DELIVERED' && edited.messageId !== undefined) {
        await state.move(scope, actor, target.id, edited.messageId);
      }
    }
    if (typed && edited.outcome === 'DELIVERED') {
      const own = typedMessageOf(input.update);
      if (own !== null && this.deps.messenger.remove !== undefined) {
        await this.deps.messenger.remove(scope, {
          chatId: own.chatId,
          messageId: own.messageId,
          botInstanceId: input.botInstanceId,
        });
      }
    }
    /*
     * R2 (item 4): the invoice is still being created in the worker. The loading screen was
     * landed at `INVOICE_LOADING`, a step the worker never moves from — so an outcome the
     * worker committed while this turn was editing cannot be edited in and then buried under
     * the loading screen. Only NOW that the loading edit has been asked for is THIS wizard
     * marked `INVOICE_PENDING` (which clears the hold), and the attempt read again: whichever
     * of this turn and the worker moves the mark first edits the message into the invoice or
     * the attempt's end, so neither waits for a status-check tap.
     */
    if (prompt !== null) await this.settleReceiptPrompt(scope, actor, target, prompt);
    if (loading && directive.paymentId != null) {
      await state.moveAll(
        scope,
        actor,
        { paymentId: directive.paymentId, id: target.id },
        ['INVOICE_LOADING'],
        'INVOICE_PENDING',
      );
      await this.deps.invoiceScreens?.refresh(scope, directive.paymentId);
    }
    return edited.outcome;
  }

  /**
   * Owner spec §2.4 (Codex 4170910529): the receipt prompt is on the message. Release its
   * hold FIRST — from here a receipt's own turn can claim it and draw the final state — and
   * THEN ask whether a receipt was filed meanwhile; if so, move the prompt on to the final
   * state (one conditional move: a receipt turn that got there first leaves nothing to move)
   * and edit it, with no button. A receipt filed before the release found the message held
   * and edited nothing (its one new message went out regardless — A10); this is what still
   * ends the invoice in its final state. It sends no new message: that is the receipt
   * turn's, keyed on the receipt being the payment's first.
   */
  async settleReceiptPrompt(
    scope: TenantContext,
    actor: ActorContext,
    target: TelegramWizardRecord,
    prompt: { readonly customerId: string; readonly paymentId: string },
  ): Promise<void> {
    const state = this.deps.messageState;
    if (state === undefined) return;
    const where = { paymentId: prompt.paymentId, id: target.id };
    await state.moveAll(scope, actor, where, ['RECEIPT_WAIT'], 'RECEIPT_WAIT');
    const filed = await this.deps.receipts.filedForCustomer(
      scope,
      actor,
      prompt.customerId as UserId,
      prompt.paymentId as PaymentId,
    );
    if (!filed) return;
    const moved = await state.moveAll(scope, actor, where, ['RECEIPT_WAIT'], 'RECEIPT_REVIEW');
    if (moved.length === 0) return;
    const values = await this.receiptInvoiceFinalValues(
      scope,
      actor,
      prompt.customerId as UserId,
      prompt.paymentId as PaymentId,
    );
    for (const wizard of moved) {
      await editSent(
        this.deps.messenger,
        scope,
        {
          chatId: wizard.chatId,
          messageId: wizard.messageId,
          botInstanceId: wizard.botInstanceId,
          templateKey: RECEIPT_INVOICE_FINAL_KEY,
          values,
          buttons: [],
        },
        false,
      );
    }
  }

  /** Forwarder: the body lives in `runtime/admin-review-flow.ts` (R9 split). */
  finaliseReview(
    scope: TenantContext,
    actor: ActorContext,
    reply: PendingReply,
    origin: CallbackOrigin,
    botInstanceId: BotInstanceId,
    telegramUserId: string,
  ): Promise<CustomerSendOutcome | 'NOT_ATTEMPTED' | null> {
    return adminReviewFlow.finaliseReview(
      this,
      scope,
      actor,
      reply,
      origin,
      botInstanceId,
      telegramUserId,
    );
  }

  /** Forwarder: the body lives in `runtime/admin-review-flow.ts` (R9 split). */
  repeatedReviewToast(
    scope: TenantContext,
    actor: ActorContext,
    telegramUserId: string,
    paymentId: string,
  ): Promise<Pick<PendingReply, 'toast'>> {
    return adminReviewFlow.repeatedReviewToast(this, scope, actor, telegramUserId, paymentId);
  }

  async stopSpinner(
    scope: TenantContext,
    command: BotCommand,
    botInstanceId: BotInstanceId,
    toast?: PendingReply['toast'],
  ): Promise<void> {
    if (command.callbackQueryId === null) return;
    await this.deps.messenger.acknowledge(scope, {
      callbackQueryId: command.callbackQueryId,
      botInstanceId,
      ...(toast === undefined ? {} : { toast: { templateKey: toast.key, values: toast.values } }),
    });
  }

  /**
   * R3: edits the tapped message into this reply; when Telegram cannot edit it (deleted,
   * too old, a photo with no text to edit), sends the same reply once as a new message.
   * `UNKNOWN` and `RATE_LIMITED` are not followed by a send: the edit may have landed, or
   * a send would meet the same refusal.
   */
  async editOrSend(
    scope: TenantContext,
    target: CardMessageRef,
    reply: PendingReply,
    asText: () => Promise<CustomerSendResult>,
  ): Promise<CustomerSendResult> {
    const edit = this.deps.messenger.edit;
    if (edit === undefined || reply.key === null) return asText();
    const edited = await edit.call(this.deps.messenger, scope, {
      chatId: target.chatId,
      messageId: target.messageId,
      botInstanceId: target.botInstanceId,
      templateKey: reply.key,
      values: reply.values,
      buttons: reply.buttons,
    });
    return edited.outcome === 'REFUSED' ? asText() : edited;
  }
}

/**
 * R5C-1 item 4: the sentence the payment message carries once the wallet has paid. A renewal
 * and a package say the action is on its way (the same message is then edited into the result:
 * the renewal's result, or the package's receipt); everything else keeps `bot.order.settled`.
 */
export function settledKeyFor(purpose: OrderPurpose): TemplateKey {
  if (purpose === 'RENEW') return 'bot.service.renew_paid';
  if (purpose === 'ADD_TRAFFIC' || purpose === 'ADD_TIME') return 'bot.service.addon_paid';
  return 'bot.order.settled';
}

/**
 * What follows `bot.order.settled`, if anything.
 *
 * A pure function of the ORDER PURPOSE, exported for the same reason `replyFor` is:
 * the decision is testable without a database or a Telegram server, and a rule that
 * can only be reached through a webhook is a rule the suite cannot distinguish from
 * its absence. It could be: no test in this repository settles a RENEW over Telegram,
 * so an unconditional follow-up stayed green until this function existed.
 *
 * `NEW_SERVICE` is the only purpose that PROVISIONS. `orderPurposeTargetsExistingService` states
 * the same rule from the other side and `COMMERCIAL_ORDER_PURPOSES` derives itself by
 * exclusion, so a purpose added without thought lands on the safe side — as one that
 * does not provision. A renewal settles and CHANGES a service that already exists;
 * telling that customer their service is being created describes something that is not
 * happening, and they would then wait for a link that is never coming because they
 * already have it.
 *
 * The three commercial purposes are not silent either: they answer with
 * `bot.service.action_requested` through their own path, and 4H's outcome announcer
 * tells them how it turned out.
 */
export function followUpForSettlement(purpose: OrderPurpose): {
  readonly followUpKey?: TemplateKey;
} {
  return purpose === 'NEW_SERVICE' || purpose === 'CUSTOM_SERVICE'
    ? { followUpKey: 'bot.service.provisioning' }
    : {};
}

/** Re-exported so the controller need not know the record shape to log an outcome. */
export type { CustomerRecord };

/**
 * The payment methods this installation can actually perform RIGHT NOW, as buttons.
 *
 * `WALLET` always, `MANUAL_TRANSFER` only when the tenant has an enabled destination. A
 * gateway button is NOT drawn, and that is the rule `provider.ts` records applied to
 * money: Marzban's descriptor advertising fourteen operations no code could perform was
 * rejected, because what a product publishes is how it tells a user what it can do.
 *
 * Each button carries the ORDER ID and nothing else. There is no amount in a callback
 * and no place to put one.
 */
/**
 * The pre-invoice's buttons (§D), in the approved order: wallet; «🧾 ثبت پرداخت», which
 * opens the selector of every route offered for the order (card-to-card and each external
 * route live THERE, not here); the discount code on a new order still in DRAFT; back to
 * the main menu. A cancel is not here: a DRAFT expires on its own, and the cancel button
 * lives on the awaiting-payment message.
 */
/** One route in a payment-method selector: the route's customer-facing name, and its tap. */
function routeButton(name: string, data: string): CustomerButton {
  return {
    ...inlineLabel('payment.route', { name }),
    data,
  };
}

/**
 * «🧾 ثبت پرداخت»: opens the order's payment-method selector (`pm:`). It is the generic
 * entry to every route, never card-to-card itself; drawn only when at least one route is
 * offered for the order, because a selector with nothing in it is a button with no outcome.
 */
function payMethodsButton(orderId: string): CustomerButton {
  return {
    ...inlineLabel('payment.methods'),
    data: `${PAY_METHODS_CALLBACK_PREFIX}${orderId}`,
  };
}

/**
 * The Stars summary for one attempt, from its snapshot: principal, fee and payable in the
 * sales currency, and the Stars the invoice asks for. With no fee the payable is all three.
 */
function starsInvoiceBody(
  payment: PaymentRecord,
  stars: bigint,
): Pick<PendingReply, 'key' | 'values'> {
  const fee = payment.customerFee;
  const expiresAt = payment.expiresAt ?? new Date(0);
  // FIX-02: the payment's one public code, on the invoice before anything is paid.
  const reference = paymentTrackingCode(payment);
  if (fee !== null && fee.fee.amountMinor > 0n) {
    return {
      key:
        payment.orderId === null
          ? 'bot.payment.stars_invoice_topup_fee'
          : 'bot.payment.stars_invoice_order_fee',
      values: {
        principal: payment.amount,
        fee: fee.fee,
        payable: fee.payable,
        stars,
        expiresAt,
        reference,
      },
    };
  }
  return {
    key:
      payment.orderId === null
        ? 'bot.payment.stars_invoice_topup'
        : 'bot.payment.stars_invoice_order',
    values: { payable: fee?.payable ?? payment.amount, stars, expiresAt, reference },
  };
}

function preinvoiceButtons(order: OrderRecord, routesOffered: boolean): readonly CustomerButton[] {
  return [
    {
      ...inlineLabel('payment.wallet'),
      data: `${WALLET_PAY_CALLBACK_PREFIX}${order.id}`,
    },
    ...(routesOffered ? [payMethodsButton(order.id)] : []),
    ...(order.state === 'DRAFT' &&
    (order.purpose === 'NEW_SERVICE' || order.purpose === 'CUSTOM_SERVICE')
      ? [
          order.discountCode === null
            ? {
                ...inlineLabel('discount.enter'),
                data: `${DISCOUNT_CODE_ENTER_CALLBACK_PREFIX}${order.id}`,
              }
            : {
                ...inlineLabel('discount.remove'),
                data: `${DISCOUNT_CODE_REMOVE_CALLBACK_PREFIX}${order.id}`,
              },
        ]
      : []),
    mainMenuButton(),
  ];
}

/**
 * «🔎 بررسی وضعیت» on a TonPays Telegram screen: the same `gc:` tap, its own label.
 */
function cardCheck(paymentId: string): CustomerButton {
  return {
    ...inlineLabel('payment.gateway_card_check'),
    data: `${GATEWAY_CHECK_CALLBACK_PREFIX}${paymentId}`,
  };
}

/**
 * A created TonPays Telegram attempt in its customer window (`docs/tonpays-telegram-gateway-
 * audit.md` §8.1): the payable from the payment's own snapshot, TonPays' transfer figure when
 * it differs (labelled as TonPays', never what Nexa settles), the CURRENT card, the deadline,
 * and the three actions — each drawn only while the rule behind it allows it, and each
 * re-decided against the rows when tapped. Never says paid.
 */
function cardTransferScreen(
  payment: PaymentRecord,
  invoice: GatewayInvoiceRecord,
  orderId: string | null,
  at: Date,
  facts: GatewayCardFacts | null,
): PendingReply {
  const kind = payment.orderId === null ? ('TOPUP' as const) : ('ORDER' as const);
  const retry: CustomerButton =
    payment.orderId === null ? topupButton() : payMethodsButton(payment.orderId);
  const wizard = { kind, step: 'INVOICE' as const, paymentId: payment.id };
  // FIX-02: every screen of this attempt quotes the same public code.
  const reference = paymentTrackingCode(payment);
  if (invoice.creationErrorCode !== null) {
    // Created without a card: it cannot be paid from here, and a new attempt is the way on.
    return {
      key: 'bot.payment.gateway_card_missing',
      values: { reference },
      buttons: [retry, mainMenuButton()],
      orderId,
      wizard: { kind, step: 'NOTICE', paymentId: payment.id },
    };
  }
  const expiresAt = payment.expiresAt ?? new Date(0);
  const fee = payment.customerFee;
  const payable = fee?.payable ?? payment.amount;
  const submissions = facts?.submissions ?? [];
  const latest = facts?.latestChange ?? null;
  const windowOpen =
    payment.state === 'PENDING' &&
    (payment.providerReviewUntil ?? null) === null &&
    payment.expiresAt !== null &&
    at.getTime() < payment.expiresAt.getTime();
  // R8 A2: the owner-approved rows — copies, the card switch, receipt and cancel, main menu.
  const receipt: CustomerButton = {
    ...inlineLabel('payment.gateway_receipt'),
    data: `${GATEWAY_RECEIPT_CALLBACK_PREFIX}${payment.id}`,
    row: CARD_INVOICE_ROW.ACTIONS,
  };
  const change: CustomerButton = {
    ...inlineLabel('payment.gateway_change_card'),
    data: `${GATEWAY_CARD_CHANGE_CALLBACK_PREFIX}${payment.id}`,
    row: CARD_INVOICE_ROW.SWITCH,
  };
  const cancelRequest = facts?.latestCancel ?? null;
  const cancel: CustomerButton = {
    ...inlineLabel('payment.gateway_cancel'),
    data: `${GATEWAY_CANCEL_ASK_CALLBACK_PREFIX}${payment.id}`,
    row: CARD_INVOICE_ROW.ACTIONS,
  };
  /*
   * R6 item 2: TonPays approves automatically only on the EXACT amount it named (its odd
   * `final_amount`), so that is what the customer is told and what the copy button carries.
   * When TonPays named none, the exact amount IS what Nexa asked for - `sentAmount`, the
   * payable in the provider's own unit (Toman), never the payment-currency payable (an IRR
   * payment would show rial as Toman). R8 A2: shown in RIAL (Toman beside it) and copied as
   * bare rial digits. It is display and clipboard only: what Nexa settles, credits and
   * refunds is still the payment's own principal.
   */
  const exact = money(
    invoice.finalAmount !== null ? invoice.finalAmount : invoice.sentAmount,
    invoice.providerUnit === 'IRR' ? 'IRR' : 'IRT',
  );
  const transferAmount = plainAmount(exact);
  const copyExact = copyRialAmountButton(exact);
  const copyCard = invoice.cardNumber === null ? null : copyCardNumberButton(invoice.cardNumber);
  /*
   * R8 A2: «🔄 تعویض کارت» is drawn while a change is allowed now OR after a cooldown — the
   * invoice is drawn the moment its card arrives, inside the first minute, so a button that
   * waited for the cooldown to pass was never on the screen. The tap decides again under the
   * payment's lock and answers a cooldown with the seconds left. The owner's R5C-1 limits
   * (`changeAllowance`) bound it like the manual switch.
   */
  const menu = mainMenuButton();
  const actions = [
    copyExact,
    ...(copyCard === null ? [] : [copyCard]),
    ...(facts !== null &&
    windowOpen &&
    cardChangeOffered(invoice, latest, at, facts.changeAllowance ?? null)
      ? [change]
      : []),
    ...(facts !== null && windowOpen && receiptUploadAvailable(invoice, submissions)
      ? [receipt]
      : []),
    ...(facts !== null && windowOpen && cancelAvailable(invoice, cancelRequest, submissions)
      ? [cancel]
      : []),
    menu,
  ];
  const copies = (button: CustomerButton): boolean => button !== copyExact && button !== copyCard;
  const brief = {
    payable,
    transferAmount,
    expiresAt,
    expiresTime: expiresAt,
    reference,
    ...cardInvoiceAmountValues(exact),
  };
  // Round 6: a cancel with the provider, or one it refused / lost and no inquiry has answered since.
  if (cancelRequest !== null) {
    const cancelKey = cancelNoticeKey(cancelRequest, invoice);
    if (cancelKey !== null) {
      return {
        key: cancelKey,
        values: { reference },
        buttons: [cardCheck(payment.id), mainMenuButton()],
        orderId,
        wizard,
      };
    }
  }
  const newest = submissions.at(-1) ?? null;
  // A receipt on its way, accepted without a review, or whose answer was lost: shown as sent.
  if (
    newest !== null &&
    (newest.state === 'QUEUED' ||
      newest.state === 'SENDING' ||
      newest.state === 'ACCEPTED' ||
      (newest.state === 'UNKNOWN' && newest.inquiryResolvedAt === null))
  ) {
    return {
      key: 'bot.payment.gateway_card_receipt_sent',
      values: brief,
      buttons: actions,
      orderId,
      wizard,
    };
  }
  // TonPays itself says the receipt is being checked (an inquiry, not an acknowledgement).
  if (invoice.providerStatus === 'processing') {
    return {
      key: 'bot.payment.gateway_card_receipt_sent',
      values: brief,
      buttons: actions,
      orderId,
      wizard,
    };
  }
  if (latest !== null && (latest.state === 'REQUESTED' || latest.state === 'SENT')) {
    return {
      key: 'bot.payment.gateway_card_changing',
      values: brief,
      // No copy buttons: the new card may carry a new exact amount, copied once it shows.
      buttons: actions.filter(copies),
      orderId,
      wizard,
    };
  }
  if (invoice.cardNumber === null) {
    // The last card change's answer was lost: no card is shown, never a stale one.
    return {
      key: 'bot.payment.gateway_card_unconfirmed',
      values: brief,
      // No card is shown, so no exact amount is offered for copying either. Its text offers a
      // status check, so the check stays on this one screen.
      buttons: [
        ...actions.filter((button) => copies(button) && button !== menu),
        cardCheck(payment.id),
        menu,
      ],
      orderId,
      wizard,
    };
  }
  const card = {
    cardNumber: invoice.cardNumber,
    ...cardInvoiceCardValues(invoice.cardNumber),
    ...(invoice.cardName === null ? {} : { cardName: invoice.cardName }),
  };
  if (newest !== null && (newest.state === 'REFUSED' || newest.state === 'ABANDONED')) {
    // Round 6: the provider's own words for an empty image or a receipt it could not match.
    const refusedKey = customerMessageKeyOfError(newest.errorCode);
    return {
      key:
        refusedKey === 'bot.payment.gateway_card_receipt_empty' ||
        refusedKey === 'bot.payment.gateway_card_receipt_invoice'
          ? refusedKey
          : 'bot.payment.gateway_card_receipt_refused',
      values: { ...brief, ...card },
      buttons: actions,
      orderId,
      wizard,
    };
  }
  return {
    key: 'bot.payment.gateway_card_invoice',
    values: {
      ...brief,
      ...card,
      ...(fee !== null && fee.fee.amountMinor > 0n
        ? { principal: payment.amount, fee: fee.fee }
        : {}),
    },
    buttons: actions,
    orderId,
    wizard,
  };
}

/**
 * An external-gateway attempt, as the customer sees it (brief §11, §23) — and, since R2
 * (item 4), the SAME screen whether the turn draws it or the gateway worker edits the wizard
 * message into it once the invoice is ready (`WizardInvoiceScreens`). A pure function of the
 * attempt and the moment, so the two can never show different things for one attempt.
 *
 * Only a CONFIRMED payment is ever called paid, and a payment is CONFIRMED only by the
 * gateway's own inquiry through the one settlement path. The link is the invoice's web link
 * when the gateway returned one, else its Telegram link; nothing is fabricated.
 *
 * Every screen that ends the attempt without an invoice — refused, not approved, closed, or
 * a create whose answer was lost — says so truthfully and offers a way back to choosing how
 * to pay (the order's method selector, or the top-up's amount), never a retry of THIS
 * attempt: an attempt whose create is unknown is never created again (TonPays rule three).
 */
/**
 * The notice a customer's cancel request leaves on the invoice (Round 6): "cancelling…" while
 * it is with the provider; the provider's refusal or a lost answer until the next inquiry has
 * answered (that inquiry says what the invoice is now, and replaces the notice). A request that
 * was applied, rate-limited, or answered before the latest inquiry leaves none.
 */
function cancelNoticeKey(
  request: GatewayProviderRequestRecord,
  invoice: Pick<GatewayInvoiceRecord, 'lastInquiryAt'>,
): TemplateKey | null {
  if (request.state === 'REQUESTED' || request.state === 'SENT') {
    return 'bot.payment.gateway_cancel_requested';
  }
  const answeredSince =
    request.decidedAt !== null &&
    invoice.lastInquiryAt !== null &&
    invoice.lastInquiryAt.getTime() >= request.decidedAt.getTime();
  if (answeredSince) return null;
  if (request.state === 'UNKNOWN') return 'bot.payment.gateway_cancel_unknown';
  if (request.state === 'REFUSED') {
    const key = customerMessageKeyOfError(request.errorCode);
    // Only the cancel refusals have a sentence of their own here; others change nothing.
    return key !== null &&
      (key.startsWith('bot.payment.gateway_cancel_not_allowed_') ||
        key === 'bot.payment.gateway_not_pending')
      ? key
      : null;
  }
  return null;
}

/**
 * An under- or overpaid TonPays Telegram invoice (Round 6): `action_required_less` shows the
 * remainder, the card to pay it to (tap-to-copy buttons for the card and the exact amount) and
 * «📤 ارسال رسید مابقی»; `action_required_more` asks for the refund card. Null for any other
 * status — and for one whose settlement deadline has passed. Every figure is TonPays' own
 * instruction to the customer; none of it is what Nexa settles, credits or refunds.
 */
function providerNeedScreen(
  payment: PaymentRecord,
  invoice: GatewayInvoiceRecord,
  orderId: string | null,
  at: Date,
  facts: GatewayCardFacts,
): PendingReply | null {
  const less = invoice.providerStatus === TONPAYS_TELEGRAM_STATUS_LESS;
  const more = invoice.providerStatus === TONPAYS_TELEGRAM_STATUS_MORE;
  if (!less && !more) return null;
  const deadline = gatewaySettlementDeadline(payment);
  if (payment.state !== 'PENDING' || deadline === null || at.getTime() >= deadline.getTime()) {
    return null;
  }
  const kind = payment.orderId === null ? ('TOPUP' as const) : ('ORDER' as const);
  const wizard = { kind, step: 'INVOICE' as const, paymentId: payment.id };
  const reference = paymentTrackingCode(payment);
  const provider = facts.providerFacts ?? null;
  const base = { expiresAt: deadline, reference };
  const tail = [cardCheck(payment.id), mainMenuButton()];
  const submissions = facts.submissions;
  if (less) {
    const shortfall =
      provider?.remainingAmount == null
        ? {}
        : { shortfall: money(provider.remainingAmount, 'IRT') };
    // Only a receipt aimed at the REMAINDER invoice says the remainder was paid: the original's
    // accepted receipt is how the shortfall was found, not an answer to it.
    const remainderNewest =
      provider?.remainingInvoiceId == null
        ? null
        : (submissions
            .filter((one) => one.providerInvoiceId === provider.remainingInvoiceId)
            .at(-1) ?? null);
    const sending =
      (remainderNewest !== null &&
        (remainderNewest.state === 'QUEUED' ||
          remainderNewest.state === 'SENDING' ||
          remainderNewest.state === 'ACCEPTED' ||
          (remainderNewest.state === 'UNKNOWN' && remainderNewest.inquiryResolvedAt === null))) ||
      provider?.remainingReceiptReceived === true;
    if (sending) {
      return {
        key: 'bot.payment.gateway_card_underpaid_receipt_sent',
        values: { ...base, ...shortfall },
        buttons: tail,
        orderId,
        wizard,
      };
    }
    if (
      provider === null ||
      provider.remainingAmount === null ||
      provider.remainingCardNumber === null ||
      provider.remainingInvoiceId === null
    ) {
      // TonPays said "less" without a usable remainder: nothing is invented.
      return {
        key: 'bot.payment.gateway_card_underpaid_unavailable',
        values: base,
        buttons: tail,
        orderId,
        wizard,
      };
    }
    const amount = money(provider.remainingAmount, 'IRT');
    const offerReceipt = remainderReceiptAvailable(invoice, provider, submissions);
    return {
      key: 'bot.payment.gateway_card_underpaid',
      values: {
        ...base,
        shortfall: amount,
        cardNumber: provider.remainingCardNumber,
        ...(provider.remainingCardHolder === null
          ? {}
          : { cardName: provider.remainingCardHolder }),
      },
      buttons: [
        { ...inlineLabel('payment.copy_card'), copyText: provider.remainingCardNumber, row: 0 },
        { ...inlineLabel('payment.copy_amount'), copyText: plainAmount(amount), row: 0 },
        ...(offerReceipt
          ? [
              {
                ...inlineLabel('payment.gateway_remainder_receipt'),
                data: `${GATEWAY_RECEIPT_CALLBACK_PREFIX}${payment.id}`,
              },
            ]
          : []),
        ...tail,
      ],
      orderId,
      wizard,
    };
  }
  // action_required_more
  const refundAmount =
    provider?.refundAmount == null ? {} : { refundAmount: money(provider.refundAmount, 'IRT') };
  const latest = facts.latestRefund ?? null;
  const masked = latest?.refundCardMasked == null ? {} : { maskedCard: latest.refundCardMasked };
  const retryCard: CustomerButton = {
    ...inlineLabel('payment.gateway_refund_card'),
    data: `${GATEWAY_REFUND_CARD_CALLBACK_PREFIX}${payment.id}`,
  };
  if (
    (latest !== null && (latest.state === 'REQUESTED' || latest.state === 'SENT')) ||
    provider?.refundPending === true ||
    latest?.state === 'APPLIED'
  ) {
    return {
      key: 'bot.payment.gateway_card_overpaid_pending',
      values: { ...base, ...refundAmount, ...masked },
      buttons: tail,
      orderId,
      wizard,
    };
  }
  if (latest !== null && latest.state === 'UNKNOWN') {
    return {
      key: 'bot.payment.gateway_refund_unknown',
      values: { reference },
      buttons: [retryCard, ...tail],
      orderId,
      wizard,
    };
  }
  if (latest !== null && latest.state === 'REFUSED') {
    const key = customerMessageKeyOfError(latest.errorCode);
    if (
      key === 'bot.payment.gateway_refund_not_allowed' ||
      key === 'bot.payment.gateway_refund_already_open'
    ) {
      return { key, values: { reference }, buttons: tail, orderId, wizard };
    }
    if (
      key === 'bot.payment.gateway_refund_card_refused' ||
      key === 'bot.payment.gateway_refund_holder_refused'
    ) {
      return { key, values: { reference }, buttons: [retryCard, ...tail], orderId, wizard };
    }
  }
  return {
    key: 'bot.payment.gateway_card_overpaid',
    values: { ...base, ...refundAmount },
    buttons: [...(refundCardAvailable(invoice, provider, latest) ? [retryCard] : []), ...tail],
    orderId,
    wizard,
  };
}

/**
 * A FAILED card-transfer attempt that deserves its own words (Round 6): one the customer
 * cancelled, one TonPays rejected WITH reasons (shown as TonPays worded them, sanitised), and
 * a create TonPays refused because the buyer already holds an open invoice (the invoice that
 * blocks is one tap away when Nexa knows it). Null for everything else.
 */
function failedCardScreen(
  payment: PaymentRecord,
  invoice: GatewayInvoiceRecord,
  orderId: string | null,
  facts: GatewayCardFacts | null,
  screen: (
    key: TemplateKey,
    buttons: readonly CustomerButton[],
    step: WizardDirective['step'],
    pending?: boolean,
  ) => PendingReply,
): PendingReply | null {
  if (PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].invoiceForm !== 'CARD_TRANSFER') return null;
  const retry: CustomerButton =
    payment.orderId === null ? topupButton() : payMethodsButton(payment.orderId);
  if (facts?.latestCancel?.state === 'APPLIED') {
    return screen('bot.payment.gateway_cancelled', [retry], 'NOTICE');
  }
  if (invoice.creationState === 'CREATE_FAILED' && isBuyerConflictCode(invoice.creationErrorCode)) {
    const key = customerMessageKeyOfError(invoice.creationErrorCode);
    if (key === null) return null;
    const open = facts?.openElsewherePaymentId ?? null;
    return screen(
      key,
      [
        ...(open === null
          ? []
          : [
              {
                ...inlineLabel('payment.gateway_open_invoice'),
                data: `${GATEWAY_CHECK_CALLBACK_PREFIX}${open}`,
              },
            ]),
        retry,
      ],
      'NOTICE',
    );
  }
  const reasons = facts?.providerFacts?.rejectReasons ?? [];
  if (reasons.length > 0) {
    return {
      ...screen('bot.payment.gateway_card_rejected', [retry], 'NOTICE'),
      values: { reasons: reasons.join('\n'), reference: paymentTrackingCode(payment) },
    };
  }
  return null;
}

/**
 * The review-window and needs-review sentences per provider, for a route whose own words
 * differ from TonPays Telegram's receipt wording (NOWPayments: coins confirming on chain,
 * `docs/nowpayments-gateway-audit.md` §5.8). A provider absent here keeps the original keys.
 */
const PROVIDER_REVIEW_SCREEN_KEYS: Partial<
  Record<
    PaymentGatewayProvider,
    { readonly inReview: TemplateKey; readonly unresolved: TemplateKey }
  >
> = {
  NOWPAYMENTS: {
    inReview: 'bot.payment.nowpayments_in_review',
    unresolved: 'bot.payment.nowpayments_review_unresolved',
  },
  /*
   * CentralPay has no review window (`docs/centralpay-gateway-audit.md` §5.8): it reaches
   * UNKNOWN only when a verify did not match the payment, which its own sentence says.
   */
  CENTRALPAY: {
    inReview: 'bot.payment.gateway_in_review',
    unresolved: 'bot.payment.centralpay_review_unresolved',
  },
  /*
   * TetraPay has no review window either: it reaches UNKNOWN only when a verify said `paid` for
   * an amount, order id or receipt that does not match the payment, which its own sentence says.
   */
  TETRAPAY: {
    inReview: 'bot.payment.gateway_in_review',
    unresolved: 'bot.payment.tetrapay_review_unresolved',
  },
};

/**
 * The label of the URL button that opens a provider's invoice page. NOWPayments carries the
 * owner's «💳 پرداخت با ارز دیجیتال» under its OWN key, isolated so the central inline-button
 * registry can take it over as `payment.nowpayments_open` without touching any other route;
 * CentralPay's «💳 پرداخت با CentralPay» is isolated the same way (`payment.centralpay_open`).
 */
const PROVIDER_PAY_BUTTON_KEYS: Partial<Record<PaymentGatewayProvider, InlineButtonKey>> = {
  NOWPAYMENTS: 'payment.nowpayments_open',
  CENTRALPAY: 'payment.centralpay_open',
};

/**
 * The screen for a TetraPay create refusal the customer can act on, or null for any other code.
 * Pure: the code is what the attempt recorded (`tetrapay.DAILY_LIMIT_REACHED`, or
 * `tetrapay.AMOUNT_OUT_OF_RANGE:<min Toman>:<max Toman>` with 0 for a bound not stated).
 */
export function tetrapayRefusalScreen(
  code: string | null,
  reference: string,
  retry: CustomerButton,
  orderId: string | null,
  kind: 'ORDER' | 'TOPUP',
  paymentId: string,
): PendingReply | null {
  if (code === null) return null;
  const wizard = { kind, step: 'NOTICE' as const, paymentId };
  if (code === TETRAPAY_DAILY_LIMIT_STORED) {
    return {
      key: 'bot.payment.tetrapay_daily_limit',
      values: { reference },
      buttons: [retry, mainMenuButton()],
      orderId,
      wizard,
    };
  }
  const range = new RegExp(
    `^${TETRAPAY_AMOUNT_OUT_OF_RANGE_STORED.replace('.', '\\.')}:(\\d{1,18}):(\\d{1,18})$`,
    'u',
  ).exec(code);
  if (range === null) return null;
  const min = BigInt(range[1] ?? '0');
  const max = BigInt(range[2] ?? '0');
  return {
    key: 'bot.payment.tetrapay_amount_out_of_range',
    // A bound the provider did not state (0) is left out, and its line is dropped with it.
    values: {
      reference,
      ...(min > 0n ? { min: money(min, 'IRT') } : {}),
      ...(max > 0n ? { max: money(max, 'IRT') } : {}),
    },
    buttons: [retry, mainMenuButton()],
    orderId,
    wizard,
  };
}

export function gatewayAttemptScreen(
  attempt: GatewayAttempt | GatewayAttemptView,
  orderId: string | null,
  at: Date,
  /**
   * A card-transfer attempt's card-change and receipt facts (TonPays Telegram, §8.1); null
   * for every other route — and absent, the card screen offers neither the receipt nor the
   * card-change button, never a stale one.
   */
  cardFacts: GatewayCardFacts | null = null,
): PendingReply {
  const { payment, invoice } = attempt;
  const kind = payment.orderId === null ? ('TOPUP' as const) : ('ORDER' as const);
  /*
   * FIX-02: the payment's ONE public tracking code, on every screen of this attempt — the
   * preparing screen, the invoice, the review and every end — computed from the payment's
   * own stored reference, so a re-render, a worker edit or a replayed tap shows the same code.
   */
  const reference = paymentTrackingCode(payment);
  const check: CustomerButton = {
    ...inlineLabel('payment.gateway_check'),
    data: `${GATEWAY_CHECK_CALLBACK_PREFIX}${payment.id}`,
  };
  const retry: CustomerButton =
    payment.orderId === null ? topupButton() : payMethodsButton(payment.orderId);
  const screen = (
    key: TemplateKey,
    buttons: readonly CustomerButton[],
    step: WizardDirective['step'],
    pending = false,
  ): PendingReply => ({
    key,
    values: { reference },
    buttons: [...buttons, mainMenuButton()],
    orderId,
    wizard: {
      kind,
      step,
      paymentId: payment.id,
      ...(pending ? { invoicePending: true } : {}),
    },
  });
  if (payment.state === 'CONFIRMED') return screen('bot.payment.gateway_confirmed', [], 'CLOSED');
  /*
   * R5A item 4: the gateway approved after the payment closed and the amount went to the
   * wallet. Decided BEFORE the unresolved / closed / failed screens below, which would all
   * still tell this customer the payment is open, expired or lost. It offers no way to pay.
   */
  if (invoice.outcome === 'LATE_CREDITED') {
    return screen('bot.payment.gateway_late_credited_screen', [], 'CLOSED');
  }
  /*
   * TonPays Telegram, the owner's review window (§8.1, §9.6.6), decided BEFORE the "closed"
   * test below: a payment whose receipt the provider is reviewing is not closed, and one
   * whose review ended unresolved has neither failed nor closed. Neither invites a new
   * payment, a new receipt or a card change. Both stay `INVOICE` so the worker's edit of the
   * outcome (confirmed, failed) replaces them in place.
   */
  const reviewKeys = PROVIDER_REVIEW_SCREEN_KEYS[invoice.provider] ?? {
    inReview: 'bot.payment.gateway_in_review',
    unresolved: 'bot.payment.gateway_review_unresolved',
  };
  if (payment.state === 'UNKNOWN') {
    return screen(reviewKeys.unresolved, [], 'INVOICE');
  }
  /*
   * Round 6: an under- or overpaid invoice is never shown as plain open (or "in review"): it
   * has a next step, decided from what the provider's latest inquiry said. Before the review
   * and closed tests because a review window may be what the invoice is inside when the
   * provider finds the mismatch.
   */
  if (cardFacts !== null && invoice.creationState === 'CREATED') {
    const needed = providerNeedScreen(payment, invoice, orderId, at, cardFacts);
    if (needed !== null) return needed;
  }
  const reviewUntil = payment.providerReviewUntil ?? null;
  if (payment.state === 'PENDING' && reviewUntil !== null) {
    if (reviewUntil.getTime() > at.getTime()) {
      return {
        key: reviewKeys.inReview,
        values: {
          payable: payment.customerFee?.payable ?? payment.amount,
          reviewUntil,
          reference,
        },
        buttons: [cardCheck(payment.id), mainMenuButton()],
        orderId,
        wizard: { kind, step: 'INVOICE', paymentId: payment.id },
      };
    }
    // Lapsed and not yet swept: the same truth the sweep is about to record.
    return screen(reviewKeys.unresolved, [], 'INVOICE');
  }
  /*
   * TetraPay's two create refusals a customer can act on: the daily limit (the route is hidden
   * until 00:00 Tehran) and an amount outside the provider's range (its own bounds, in Toman).
   * Read from the code the attempt recorded; every other refusal keeps the generic sentence.
   */
  const refusal =
    invoice.creationState === 'CREATE_FAILED'
      ? tetrapayRefusalScreen(
          invoice.creationErrorCode,
          reference,
          retry,
          orderId,
          kind,
          payment.id,
        )
      : null;
  if (refusal !== null && (payment.state === 'FAILED' || payment.state === 'PENDING')) {
    return refusal;
  }
  if (payment.state === 'FAILED') {
    // Round 6: the customer's own cancel, a rejection with reasons, a buyer with another invoice.
    const failed = failedCardScreen(payment, invoice, orderId, cardFacts, screen);
    if (failed !== null) return failed;
    // A create the gateway refused is "unavailable"; an invoice it did not approve failed.
    return screen(
      invoice.creationState === 'CREATE_FAILED'
        ? 'bot.payment.gateway_unavailable'
        : 'bot.payment.gateway_failed',
      [retry],
      'NOTICE',
    );
  }
  if (
    payment.state !== 'PENDING' ||
    payment.expiresAt === null ||
    payment.expiresAt.getTime() <= at.getTime()
  ) {
    return screen('bot.payment.gateway_closed', [retry], 'NOTICE');
  }
  /*
   * Telegram Stars (Package A): the invoice is its own Telegram message, sent by this bot —
   * Telegram cannot turn a text message into an invoice, so it follows this one. The summary
   * shows the principal, the fee when there is one, the payable in the sales currency and the
   * Stars asked for — all from THIS attempt's snapshot — while the invoice is being sent and
   * once it has been.
   *
   * B12: no «check payment status» button here. A Stars payment settles from Telegram's own
   * `successful_payment`, never from a status read, so the button could only ever answer
   * "still waiting"; the invoice message's Pay button (Telegram's own, the first and only
   * button of an invoice sent with no keyboard) is the one action, and the way back stays.
   */
  if (
    PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].invoiceCredential === 'BOT_TOKEN' &&
    (invoice.creationState === 'CREATING' || invoice.creationState === 'CREATED')
  ) {
    return {
      ...starsInvoiceBody(payment, invoice.sentAmount),
      buttons: [mainMenuButton()],
      orderId,
      wizard: { kind, step: 'INVOICE', paymentId: payment.id },
    };
  }
  /*
   * The loading screen: the worker edits this very message into the invoice once it exists.
   * Landed at `INVOICE_LOADING` and marked `INVOICE_PENDING` by the turn once its edit has
   * been asked for (`editWizard`). It carries the check button, gated from both, so a
   * worker edit that did not land is one tap from the current attempt.
   */
  if (invoice.creationState === 'CREATING') {
    return screen('bot.payment.gateway_preparing', [check], 'INVOICE_LOADING', true);
  }
  /*
   * F3 (round N): each end says what actually happened, and each offers a way on that opens
   * a NEW attempt — none of these is an open attempt (`findOpenAttempt`), so the retry is
   * never handed this one back.
   *
   * - A create the gateway REFUSED is "unavailable" even while its payment is still PENDING
   *   (the failure's own write did not land): it was a refusal, never a lost answer.
   * - An invoice the gateway reported CREATED with no link a customer can open: its answer
   *   was received, so it is not "the answer was lost".
   * - Only a create whose answer really was lost (`CREATE_UNKNOWN`) is `gateway_unknown`.
   */
  if (invoice.creationState === 'CREATE_FAILED') {
    const failed = failedCardScreen(payment, invoice, orderId, cardFacts, screen);
    if (failed !== null) return failed;
    return screen('bot.payment.gateway_unavailable', [retry], 'NOTICE');
  }
  if (
    PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].invoiceForm === 'CARD_TRANSFER' &&
    invoice.creationState === 'CREATED'
  ) {
    return cardTransferScreen(payment, invoice, orderId, at, cardFacts);
  }
  const link = invoice.webInvoiceUrl ?? invoice.invoiceUrl;
  if (invoice.creationState === 'CREATED' && link === null) {
    return screen('bot.payment.gateway_no_link', [retry], 'NOTICE');
  }
  if (invoice.creationState !== 'CREATED' || link === null) {
    return screen('bot.payment.gateway_unknown', [retry], 'NOTICE');
  }
  /*
   * A route that charges a customer fee shows the three figures apart (WP18): the
   * principal — the order amount, or the top-up the wallet receives — the gateway fee, and
   * the payable the invoice asks for. From THIS attempt's snapshot, never the route's
   * current rate. With no fee the single amount is already all three.
   */
  const fee = payment.customerFee;
  const invoiceBody: Pick<PendingReply, 'key' | 'values'> =
    fee !== null && fee.fee.amountMinor > 0n
      ? {
          key:
            payment.orderId === null
              ? 'bot.payment.gateway_invoice_topup_fee'
              : 'bot.payment.gateway_invoice_order_fee',
          values: {
            principal: payment.amount,
            fee: fee.fee,
            payable: fee.payable,
            expiresAt: payment.expiresAt,
            reference,
          },
        }
      : {
          key: 'bot.payment.gateway_invoice',
          values: { total: payment.amount, expiresAt: payment.expiresAt, reference },
        };
  return {
    ...invoiceBody,
    buttons: [
      {
        ...inlineLabel(PROVIDER_PAY_BUTTON_KEYS[invoice.provider] ?? 'payment.gateway_pay'),
        url: link,
      },
      check,
      mainMenuButton(),
    ],
    orderId,
    wizard: { kind, step: 'INVOICE', paymentId: payment.id },
  };
}

/**
 * A10: the invoice's FINAL text once a receipt is on the payment, edited in, with no button.
 * The claim's sentence — recorded, nothing received or verified, a person will check — and
 * NOT `bot.payment.receipt_received`, which is the one new message the first receipt sends:
 * the same two sentences twice, one above the other, would be noise.
 */
const RECEIPT_INVOICE_FINAL_KEY: TemplateKey = 'bot.payment.received_for_review';

/**
 * R2: a wallet refusal the customer acts on and comes back from — too little balance, a
 * transfer already under review — goes out as its OWN message, so the pre-invoice it answers
 * stays on screen and payable once they have topped up.
 */
const WALLET_SHORT: WizardDirective = { kind: 'ORDER', step: 'PREINVOICE', placement: 'NEW' };

/** The one trial refusal, with the way back to the main menu. */
/** The GB bounds a custom-service volume question and its refusal quote (B1). */
export function volumeRangeValues(range: { readonly min: bigint; readonly max: bigint }): {
  minGb: string;
  maxGb: string;
} {
  return {
    minGb: formatCustomServiceVolume(range.min),
    maxGb: formatCustomServiceVolume(range.max),
  };
}

/** The day bounds a custom-service days question and its refusal quote (B1). */
export function daysRangeValues(range: { readonly min: bigint; readonly max: bigint }): {
  minDays: string;
  maxDays: string;
} {
  return { minDays: range.min.toString(), maxDays: range.max.toString() };
}

function topupButton(): CustomerButton {
  return {
    ...inlineLabel('wallet.topup'),
    data: TOPUP_MENU_CALLBACK_PREFIX,
  };
}

/** First and last name, else the username, else the numeric id — never blank. */
function displayNameOf(customer: CustomerRecord): string {
  const name = [customer.firstName, customer.lastName]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' ')
    .trim();
  if (name.length > 0) return name;
  if (customer.username !== null && customer.username.trim().length > 0) return customer.username;
  return customer.telegramUserId;
}

function paymentButtons(orderId: string, routesOffered: boolean): readonly CustomerButton[] {
  return [
    {
      ...inlineLabel('payment.wallet'),
      data: `${WALLET_PAY_CALLBACK_PREFIX}${orderId}`,
    },
    /*
     * «🧾 ثبت پرداخت», opening the selector of every route offered for the order —
     * card-to-card, each external route. Drawn only when there is at least one: a
     * card-to-card route with no enabled account to pay into is not offered
     * (`manualTransferOffered`), so a selector drawn regardless could hold nothing.
     *
     * The read can be a moment stale; each route's own tap re-decides it on the server.
     */
    ...(routesOffered ? [payMethodsButton(orderId)] : []),
    /*
     * The way out, beside the two ways in.
     *
     * Before 4H a customer who changed their mind had exactly one option — never pay —
     * and the order sat `AWAITING_PAYMENT` until a sweep expired it, which is the state
     * `docs/phase4h-audit.md` §3 records as the CANCEL edge having no caller at all.
     *
     * It carries the ASK prefix. Tapping it closes nothing: this message stays in the
     * chat for ever and `ORDER_MACHINE` has no edge out of CANCELLED, so a mis-touch
     * would take the customer's quoted price with it.
     */
    {
      ...inlineLabel('order.cancel'),
      data: `${CANCEL_ORDER_ASK_CALLBACK_PREFIX}${orderId}`,
    },
  ];
}

/**
 * The shortfall the service put on the refusal, or null.
 *
 * Parsed rather than cast, because `details` is `Record<string, unknown>` and a template
 * that declares a MONEY placeholder will refuse a string. Returning null on anything
 * unexpected sends the customer the generic refusal instead of a message with a hole in
 * it — the shortfall is a number they act on, and a wrong one is worse than none.
 */
function shortfallOf(details: Record<string, unknown> | undefined): Money | null {
  const minor = details?.shortfallMinor;
  const currency = details?.currency;
  if (typeof minor !== 'string' || !/^\d{1,19}$/u.test(minor)) return null;
  const parsed = currencyCodeSchema.safeParse(currency);
  if (!parsed.success) return null;
  return money(BigInt(minor), parsed.data);
}
