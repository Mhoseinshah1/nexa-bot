import {
  COMMERCE_ERROR_CODES,
  customMenuIdOfRoute,
  isNexaError,
  SERVICE_NOTE_CLEAR_TOKEN,
  SERVICE_NOTE_MAX_LENGTH,
  SERVICE_SEARCH_MAX_LENGTH,
} from '@nexa/contracts';
import type {
  ClientAppPlatform,
  PaymentGatewayProvider,
  ActorContext,
  BotInstanceId,
  CustomerArrival,
  TemplateKey,
  TemplateValues,
  TenantContext,
  UserId,
} from '@nexa/contracts';
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
import { SERVICE_CARD_CALLBACK_PREFIX } from '../../modules/commerce/provisioning/application/delivery.service.js';
import type { CardMessageRef } from '../../modules/commerce/provisioning/application/operation-card.js';
import type { TelegramWizardRecord } from '../../modules/commerce/messaging/application/telegram-message-state.js';
import {
  REVIEW_TAP_INTENTS,
  WIZARD_GATES,
  callbackOriginOf,
  typedMessageOf,
  type CallbackOrigin,
} from './wizard-state.js';
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
  type ReplyMediaBytes,
  blockedReply,
  editSent,
  replyFor,
  staleCallbackReply,
  withBlockedSupportButton,
  inPlace,
} from './runtime/replies.js';
import * as customButtonFlow from './runtime/custom-button-flow.js';
import * as orderEndFlow from './runtime/order-end-flow.js';
import { withWayOn } from './runtime/way-on.js';
import * as startMenuFlow from './runtime/start-menu-flow.js';
import * as captchaFlow from './runtime/captcha-flow.js';
import { CAPTCHA_EXEMPT_INTENTS } from './runtime/captcha-flow.js';
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
import * as autoRenewFlow from './runtime/auto-renew-flow.js';
import * as serviceActionsFlow from './runtime/service-actions-flow.js';
import * as supportFlow from './runtime/support-flow.js';
import * as trialFlow from './runtime/trial-flow.js';
import * as referralFlow from './runtime/referral-flow.js';
import * as tutorialFlow from './runtime/tutorial-flow.js';
import * as adminFlow from './runtime/admin-flow.js';
import * as adminReviewFlow from './runtime/admin-review-flow.js';
import { hasAnyPanelSection } from './runtime/admin-common.js';
import * as purchaseFlow from './runtime/purchase-flow.js';
import * as checkoutFlow from './runtime/checkout-flow.js';
import * as cardReceiptFlow from './runtime/card-receipt-flow.js';
import * as topupFlow from './runtime/topup-flow.js';
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
  INPUT_BACK_CALLBACK_PREFIX,
  INPUT_CANCEL_CALLBACK_DATA,
  ORDER_PAYMENT_STATUS_CALLBACK_PREFIX,
  CUSTOM_SERVICE_BACK_CALLBACK_DATA,
  TOPUP_MENU_CALLBACK_PREFIX,
  TOPUP_PICK_CALLBACK_PREFIX,
  GIFT_CARD_CALLBACK_DATA,
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
  START_CAPTCHA_CALLBACK_PREFIX,
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
  WALLET_HISTORY_CALLBACK_PREFIX,
  WALLET_OPEN_CALLBACK_DATA,
  CATALOG_OPEN_CALLBACK_DATA,
  ADMIN_PANEL_CALLBACK_PREFIX,
  ADMIN_RECEIPTS_CALLBACK_PREFIX,
  ADMIN_RECEIPT_CALLBACK_PREFIX,
  SERVICE_REFUND_ASK_CALLBACK_PREFIX,
  SERVICE_REFUND_CONFIRM_CALLBACK_PREFIX,
  SERVICE_TRANSFER_ASK_CALLBACK_PREFIX,
  SERVICE_TRANSFER_CONFIRM_CALLBACK_PREFIX,
  SERVICE_AUTO_RENEW_ASK_CALLBACK_PREFIX,
  SERVICE_AUTO_RENEW_CONFIRM_CALLBACK_PREFIX,
  SERVICE_AUTO_RENEW_OFF_CALLBACK_PREFIX,
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
  REORDER_CATEGORY_CALLBACK_PREFIX,
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
export { tetrapayRefusalScreen, gatewayAttemptScreen } from './runtime/payment-screens.js';
export {
  CATALOG_PAGE_SIZE,
  CATALOG_BROWSE_PAGE_SIZE,
  volumeRangeValues,
  daysRangeValues,
} from './runtime/purchase-flow.js';
export { settledKeyFor, followUpForSettlement } from './runtime/checkout-flow.js';
export { withdrawalRefusal } from './runtime/card-receipt-flow.js';

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

/*
 * The reviewer's caption is built by ONE application function the pull item and the push
 * share (`receipt-review-caption.ts`); these are re-exported for the tests that pin them.
 */
export { RECEIPT_REVIEW_NOTE_MAX, reviewNoteOf };

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
    const tenantRoutes = await this.deps.menuRoutes.routesFor(scope);
    const merged = new Map([...this.deps.mainMenu, ...tenantRoutes]);
    /*
     * R10 D2: an owner's label never takes over a label the shared table already routes (a
     * button's older default label, the management panel's): the tenant's routes are laid
     * over the shared ones so a RENAMED registry button wins, but a custom value (`mb:<id>`)
     * does not.
     */
    for (const [label, value] of tenantRoutes) {
      const shared = this.deps.mainMenu.get(label);
      if (shared !== undefined && customMenuIdOfRoute(value) !== null) merged.set(label, shared);
    }
    return merged;
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
        ? await adminFlow.adminCaptureText(this, scope, actor, command.args[0], input)
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
        ? await adminReviewFlow.repeatedReviewToast(
            this,
            scope,
            actor,
            input.telegramUserId,
            reviewRecord.paymentId,
          )
        : {};
    let answered: PendingReply;
    try {
      answered =
        repeatedReview || staleWizard
          ? { key: null, values: {}, buttons: [], orderId: null, ...repeatToast }
          : arrival === 'BLOCKED'
            ? (blockedAdminText ??
              (ADMIN_INTENTS.has(command.intent)
                ? await adminFlow.adminTurn(this, scope, actor, command, input)
                : null) ??
              // Round N close (§D): a blocked customer's /stop is still their preference.
              // Blocking stops what they can BUY; it does not make a promotion welcome, and
              // a MARKETING send to an audience that admits blocked customers reads this row.
              (command.intent === 'MARKETING_OPT_OUT' || command.intent === 'MARKETING_OPT_IN'
                ? await startMenuFlow.marketingPreference(
                    this,
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
    const unfinished: PendingReply =
      spam !== null &&
      spam.verdict !== 'ALLOWED' &&
      arrival === 'BLOCKED' &&
      answered === blocked &&
      !blockedThisTurn
        ? { key: null, values: {}, buttons: [], orderId: null }
        : answered;
    // R12 F3 item 3: no dead ends. A customer reply with no button gets its way on; the
    // management panel's own replies are the operator's and are left as they are.
    const reply: PendingReply = ADMIN_INTENTS.has(command.intent)
      ? unfinished
      : withWayOn(unfinished);

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
      const reviewed = await adminReviewFlow.finaliseReview(
        this,
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
        : reply.mediaBytes !== undefined
          ? /*
             * R10 D2: an owner-defined button's file, uploaded from the bytes the installation
             * holds. A definite refusal (a broken image, a caption over the bound) falls back
             * to the same reply as text, so the tap is always answered; UNKNOWN and rate
             * limits are not retried as text (the file may have arrived).
             */
            await this.sendMediaBytes(
              scope,
              chatId,
              input.botInstanceId,
              reply,
              reply.mediaBytes,
              asText,
            )
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
   *
   * R10 D5 (a): the `/start` captcha stands IN FRONT of the membership gate, as the first
   * check of the chain: a customer created while `start_captcha` was on, who has not yet
   * answered, is shown the question whatever they asked for (`captcha-flow.ts`). Exempt: the
   * management panel, the promotional opt-out and opt-in, and a bound administrator. The
   * right answer continues down the chain as the customer's first `/start`.
   */
  async guardedAct(
    scope: TenantContext,
    actor: ActorContext,
    asked: BotCommand,
    customer: CustomerRecord,
    arrivedAs: CustomerArrival,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
      readonly telegramUserId: string;
    },
  ): Promise<PendingReply> {
    let command = asked;
    let arrival = arrivedAs;
    if (!ADMIN_INTENTS.has(asked.intent) && !CAPTCHA_EXEMPT_INTENTS.has(asked.intent)) {
      const captcha = await captchaFlow.captchaGate(
        this,
        scope,
        actor,
        asked,
        customer,
        arrivedAs,
        input,
      );
      if (captcha.kind === 'HOLD') return captcha.reply;
      ({ command, arrival } = captcha);
    }
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
    if (command.intent === 'CUSTOM_MENU_BUTTON' && command.targetId !== null) {
      return customButtonFlow.customButtonTap(this, scope, input.botInstanceId, command.targetId);
    }
    if (command.intent === 'CATALOG')
      return purchaseFlow.catalogue(this, scope, actor, 0, customer);
    if (command.intent === 'CATALOG_PAGE') {
      return purchaseFlow.catalogue(this, scope, actor, command.page ?? 0, customer);
    }
    if (command.intent === 'TRIAL_CLAIM') {
      return trialFlow.beginTrial(this, scope, actor, customer, input.idempotencyKey);
    }
    if (command.intent === 'TRIAL_PANEL' && command.targetId !== null) {
      return trialFlow.claimTrial(
        this,
        scope,
        actor,
        customer,
        command.targetId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'CUSTOM_SERVICE_MENU') {
      return purchaseFlow.customServiceMenu(this, scope, actor, customer);
    }
    if (command.intent === 'CUSTOM_SERVICE_LOCATION' && command.targetId !== null) {
      return purchaseFlow.customServiceLocation(this, scope, actor, customer, command.targetId, {
        idempotencyKey: input.idempotencyKey,
        botInstanceId: input.botInstanceId,
      });
    }
    if (command.intent === 'CATEGORY' && command.targetId !== null) {
      return purchaseFlow.categoryPage(
        this,
        scope,
        actor,
        command.targetId,
        command.page ?? 0,
        customer.id,
      );
    }
    // R11 A11: «🔁 سفارش دوباره» — the ended order's category, read-only, as a new message.
    if (command.intent === 'REORDER_CATEGORY' && command.targetId !== null) {
      return purchaseFlow.categoryPage(this, scope, actor, command.targetId, 0, customer.id);
    }
    if (command.intent === 'ORDER' && command.targetId !== null) {
      return purchaseFlow.draft(
        this,
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'CONFIRM' && command.targetId !== null) {
      return purchaseFlow.confirm(
        this,
        scope,
        actor,
        command.targetId,
        customer,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'USERNAME_CUSTOM' && command.targetId !== null) {
      return purchaseFlow.customUsername(
        this,
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'USERNAME_AUTOMATIC' && command.targetId !== null) {
      return purchaseFlow.automaticUsername(
        this,
        scope,
        actor,
        command.targetId,
        customer,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'DISCOUNT_CODE_ENTER' && command.targetId !== null) {
      return purchaseFlow.enterDiscountCode(
        this,
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'DISCOUNT_CODE_REMOVE' && command.targetId !== null) {
      return purchaseFlow.removeDiscountCode(
        this,
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
        text === undefined
          ? null
          : await adminFlow.adminCaptureText(this, scope, actor, text, input);
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
        return purchaseFlow.typedUsername(
          this,
          scope,
          actor,
          text,
          customer,
          input.botInstanceId,
          input.idempotencyKey,
        );
      }
    }
    if (command.intent === 'WALLET') return topupFlow.walletBalance(this, scope, actor, customer);
    if (command.intent === 'WALLET_HISTORY') {
      return topupFlow.walletHistory(this, scope, actor, customer, command.cursor ?? null);
    }
    if (command.intent === 'MARKETING_OPT_OUT' || command.intent === 'MARKETING_OPT_IN') {
      return startMenuFlow.marketingPreference(
        this,
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
      if (command.intent !== 'MAIN_MENU') return supportFlow.supportScreen(this, scope, customer);
      return this.mainMenuReply(scope, actor, customer, input);
    }
    // WP-A7: the customer's support tickets.
    const ticketed = await supportFlow.ticketTurn(this, scope, actor, command, customer, input);
    if (ticketed !== null) return inPlace(ticketed);
    if (command.intent === 'TUTORIAL')
      return inPlace(await tutorialFlow.tutorialChoiceReply(this, scope, customer));
    if (command.intent === 'TUTORIAL_PLATFORM' && command.targetId !== null) {
      return inPlace(
        await tutorialFlow.tutorialPlatform(
          this,
          scope,
          customer,
          command.targetId as ClientAppPlatform,
        ),
      );
    }
    if (command.intent === 'CLIENT_APP' && command.targetId !== null) {
      // NOT `inPlace`: an app's guide is its own NEW message (spec A4) — with a video it is a
      // file, and without one it stays the single text message it always was.
      return tutorialFlow.clientApp(this, scope, customer, command.targetId, input.botInstanceId);
    }
    if (command.intent === 'SERVICE_CONNECTED' && command.targetId !== null) {
      // Acknowledged, and NOTHING is written: the customer told us a fact about their
      // own device, and a row saying so would be a claim this installation cannot check.
      const owned = await serviceCardFlow.ownedService(this, scope, customer, command.targetId);
      return {
        key: owned === null ? 'bot.service.not_found' : 'bot.service.connected_ack',
        values: {},
        buttons: [mainMenuButton()],
        orderId: null,
      };
    }
    if (command.intent === 'GIFT_CARD') {
      return topupFlow.giftCardBegin(
        this,
        scope,
        actor,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'TOPUP_MENU') {
      return topupFlow.topupBegin(
        this,
        scope,
        actor,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (
      command.intent === 'TOPUP_ROUTE' &&
      command.targetId !== null &&
      command.secondaryId != null
    ) {
      return topupFlow.topupRoute(
        this,
        scope,
        actor,
        customer,
        command.targetId,
        command.secondaryId as PaymentGatewayProvider,
      );
    }
    if (command.intent === 'TOPUP_CLOSE' && command.targetId !== null) {
      return topupFlow.topupClose(this, scope, actor, customer, command.targetId);
    }
    if (command.intent === 'SERVICES_SEARCH') {
      return serviceCardFlow.servicesSearchBegin(
        this,
        scope,
        actor,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'SERVICE_REFRESH' && command.targetId !== null) {
      return serviceCardFlow.serviceRefresh(
        this,
        scope,
        actor,
        customer,
        command.targetId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'SERVICE_CARD' && command.targetId !== null) {
      const card = await serviceCardFlow.openServiceCard(
        this,
        scope,
        actor,
        customer,
        command.targetId,
      );
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
        await serviceCardFlow.serviceNoteBegin(
          this,
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
      return serviceActionsFlow.commercialQuote(
        this,
        scope,
        actor,
        customer,
        command.targetId,
        'RENEW',
        null,
        input,
      );
    }
    if (
      command.intent === 'SERVICE_RENEW_PLAN' &&
      command.targetId !== null &&
      command.secondaryId != null
    ) {
      // An imported service's chosen plan; the draft re-decides it against the panel's plans.
      return serviceActionsFlow.commercialQuote(
        this,
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
      return inPlace(
        await referralFlow.referralGift(this, scope, actor, customer, input.idempotencyKey),
      );
    }
    if (command.intent === 'REFERRAL_INVITE') {
      return inPlace(
        await referralFlow.referralInvite(
          this,
          scope,
          actor,
          customer,
          input.botInstanceId,
          input.idempotencyKey,
        ),
      );
    }
    if (command.intent === 'TOPUP_PICK' && command.targetId !== null) {
      return topupFlow.topupPick(
        this,
        scope,
        actor,
        command.targetId,
        customer,
        input.idempotencyKey,
        input.botInstanceId,
      );
    }
    if (command.intent === 'PAY_WALLET' && command.targetId !== null) {
      return checkoutFlow.walletPayment(
        this,
        scope,
        actor,
        command.targetId,
        customer,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'PAY_MANUAL' && command.targetId !== null) {
      return cardReceiptFlow.manualPayment(
        this,
        scope,
        actor,
        command.targetId,
        customer,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'PAY_METHODS' && command.targetId !== null) {
      return checkoutFlow.paymentMethods(this, scope, actor, command.targetId, customer);
    }
    if (command.intent === 'PAY_METHODS_CLOSE' && command.targetId !== null) {
      const back = await checkoutFlow.paymentMethodsBack(
        this,
        scope,
        actor,
        command.targetId,
        customer,
      );
      if (back !== null) return back;
      return {
        ...(await startMenuFlow.startGreeting(
          this,
          scope,
          actor,
          customer,
          'bot.start.welcome_back',
        )),
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
      return checkoutFlow.gatewayPayment(
        this,
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
      return checkoutFlow.gatewayCheck(this, scope, actor, command.targetId, customer);
    }
    if (command.intent === 'GATEWAY_RECEIPT' && command.targetId !== null) {
      return cardReceiptFlow.gatewayReceipt(
        this,
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
      );
    }
    if (command.intent === 'GATEWAY_CARD_CHANGE' && command.targetId !== null) {
      return cardReceiptFlow.gatewayCardChange(
        this,
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'GATEWAY_CANCEL_ASK' && command.targetId !== null) {
      return cardReceiptFlow.gatewayCancelAsk(
        this,
        scope,
        command.targetId,
        customer,
        input.botInstanceId,
      );
    }
    if (command.intent === 'GATEWAY_CANCEL' && command.targetId !== null) {
      return cardReceiptFlow.gatewayCancel(
        this,
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'GATEWAY_REFUND_CARD' && command.targetId !== null) {
      return cardReceiptFlow.gatewayRefundCardPrompt(
        this,
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
      return cardReceiptFlow.cancelPaymentAsk(this, scope, command.targetId, customer);
    }
    if (command.intent === 'PAY_CANCEL' && command.targetId !== null) {
      return cardReceiptFlow.cancelPayment(
        this,
        scope,
        actor,
        command.targetId,
        customer,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'RECEIPT_UPLOAD' && command.file != null) {
      /*
       * WP-A7: a file answers a ticket window when that is the prompt the customer saw last;
       * otherwise it is a receipt, exactly as before.
       */
      const ticketFile = await supportFlow.ticketFile(
        this,
        scope,
        actor,
        customer,
        command.file,
        input,
      );
      if (ticketFile !== null) return ticketFile;
      /*
       * TonPays Telegram (§8.3): a provider receipt window open for this customer IN THIS
       * BOT takes the file; its payment, provider and invoice come from the window's row.
       * Never the manual review queue. No window: the manual flow, exactly as before.
       */
      const providerReceipt = await cardReceiptFlow.gatewayReceiptPhoto(
        this,
        scope,
        actor,
        customer,
        input.botInstanceId,
        command.file,
      );
      if (providerReceipt !== null) return providerReceipt;
      return cardReceiptFlow.submitReceipt(
        this,
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
      return cardReceiptFlow.switchCard(
        this,
        scope,
        actor,
        command.targetId,
        Number(command.secondaryId),
        customer,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'PAY_SENT' && command.targetId !== null) {
      return cardReceiptFlow.signalTransferSent(
        this,
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'ORDER_CANCEL_ASK' && command.targetId !== null) {
      return purchaseFlow.cancelOrderAsk(this, scope, command.targetId, customer);
    }
    // R12 F3 item 2: leaving a typed-input prompt closes its window, then answers.
    if (command.intent === 'INPUT_BACK' && command.targetId !== null) {
      const abandoned = await purchaseFlow.abandonTextEntry(this, scope, actor, customer, input);
      if (abandoned !== null) return abandoned;
      const draft = await purchaseFlow.inputBack(this, scope, actor, command.targetId, customer);
      if (draft === 'MENU') return this.mainMenuReply(scope, actor, customer, input);
      if (draft !== null) return draft;
      const back = await checkoutFlow.paymentMethodsBack(
        this,
        scope,
        actor,
        command.targetId,
        customer,
      );
      if (back !== null) return back;
      return this.mainMenuReply(scope, actor, customer, input);
    }
    if (command.intent === 'ORDER_PAYMENT_STATUS' && command.targetId !== null) {
      return orderEndFlow.orderPaymentStatus(this, scope, actor, customer, command.targetId);
    }
    if (command.intent === 'INPUT_CANCEL') {
      const abandoned = await purchaseFlow.abandonTextEntry(this, scope, actor, customer, input);
      return abandoned ?? this.mainMenuReply(scope, actor, customer, input);
    }
    if (command.intent === 'CUSTOM_SERVICE_BACK') {
      const abandoned = await purchaseFlow.abandonTextEntry(this, scope, actor, customer, input);
      return abandoned ?? purchaseFlow.customServiceMenu(this, scope, actor, customer);
    }
    if (command.intent === 'ORDER_CANCEL' && command.targetId !== null) {
      return purchaseFlow.cancelOrder(
        this,
        scope,
        actor,
        command.targetId,
        customer,
        input.idempotencyKey,
        cardMessageOf(input.update, input.botInstanceId),
      );
    }
    if (command.intent === 'SERVICE_RENEW' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await serviceActionsFlow.renewMenu(this, scope, actor, customer, command.targetId),
      );
    }
    if (command.intent === 'SERVICE_ADD_TRAFFIC' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await serviceActionsFlow.addonChoice(
          this,
          scope,
          actor,
          customer,
          command.targetId,
          'ADD_TRAFFIC',
        ),
      );
    }
    if (command.intent === 'SERVICE_ADD_TIME' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await serviceActionsFlow.addonChoice(
          this,
          scope,
          actor,
          customer,
          command.targetId,
          'ADD_TIME',
        ),
      );
    }
    if (
      command.intent === 'SERVICE_BUY_TRAFFIC' &&
      command.targetId !== null &&
      command.secondaryId != null
    ) {
      return serviceActionsFlow.commercialQuote(
        this,
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
      return serviceActionsFlow.commercialQuote(
        this,
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
        await serviceActionsFlow.devicesChoice(this, scope, actor, customer, command.targetId),
      );
    }
    if (
      command.intent === 'SERVICE_BUY_DEVICES' &&
      command.targetId !== null &&
      command.secondaryId != null &&
      command.quantity !== undefined
    ) {
      return serviceActionsFlow.commercialQuote(
        this,
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
        await serviceActionsFlow.locationChoice(this, scope, actor, customer, command.targetId),
      );
    }
    if (
      command.intent === 'SERVICE_LOCATION_TARGET' &&
      command.targetId !== null &&
      command.secondaryId != null
    ) {
      return inCard(
        command.targetId,
        await serviceActionsFlow.locationTarget(
          this,
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
        await serviceActionsFlow.locationRequest(
          this,
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
      return serviceActionsFlow.commercialConfirm(
        this,
        scope,
        actor,
        customer,
        command.targetId,
        input,
      );
    }
    if (command.intent === 'SERVICES') return serviceCardFlow.services(this, scope, customer, 1);
    if (command.intent === 'SERVICES_PAGE') {
      // A keyset token from a message older than the paged list lands on page 1: the
      // token names a position in an ordering this list no longer uses.
      // Owner spec §2.3: a page, and «back to the list» from a card, EDIT the tapped
      // message — the list, the card and the list again are one message.
      return {
        ...(await serviceCardFlow.services(this, scope, customer, command.page ?? 1)),
        edit: true,
      };
    }
    if (command.intent === 'SERVICE' && command.targetId !== null) {
      return serviceCardFlow.openServiceCard(this, scope, actor, customer, command.targetId);
    }
    if (command.intent === 'SERVICE_RESEND' && command.targetId !== null) {
      return serviceCardFlow.serviceResend(this, scope, actor, customer, command.targetId, input);
    }
    if (command.intent === 'SERVICE_FILES' && command.targetId !== null) {
      return serviceCardFlow.serviceFiles(this, scope, actor, customer, command.targetId, input);
    }
    /*
     * B8: the switch's first tap draws the question IN the card and plans nothing — on any
     * card, so an old message's `u:` / `e:` can no longer act on one tap either.
     */
    if (command.intent === 'SERVICE_SUSPEND' && command.targetId !== null) {
      return serviceCardFlow.serviceToggleAsk(
        this,
        scope,
        actor,
        customer,
        command.targetId,
        'SUSPEND',
      );
    }
    if (command.intent === 'SERVICE_RESUME' && command.targetId !== null) {
      return serviceCardFlow.serviceToggleAsk(
        this,
        scope,
        actor,
        customer,
        command.targetId,
        'RESUME',
      );
    }
    if (command.intent === 'SERVICE_SUSPEND_CONFIRM' && command.targetId !== null) {
      return serviceCardFlow.serviceAction(
        this,
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
      return serviceCardFlow.serviceAction(
        this,
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
      return serviceActionsFlow.serviceRotateAsk(this, scope, customer, command.targetId);
    }
    if (command.intent === 'SERVICE_REFUND_ASK' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await serviceRequestsFlow.serviceRefundAsk(this, scope, customer, command.targetId),
      );
    }
    if (command.intent === 'SERVICE_REFUND_CONFIRM' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await serviceRequestsFlow.serviceRefundConfirm(
          this,
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
    // Round 10, D1: «تمدید خودکار» — ask (records nothing), confirm, off.
    if (command.intent === 'SERVICE_AUTO_RENEW_ASK' && command.targetId !== null) {
      return autoRenewFlow.autoRenewAsk(this, scope, actor, customer, command.targetId);
    }
    if (
      (command.intent === 'SERVICE_AUTO_RENEW_CONFIRM' ||
        command.intent === 'SERVICE_AUTO_RENEW_OFF') &&
      command.targetId !== null
    ) {
      return autoRenewFlow.autoRenewSet(
        this,
        scope,
        actor,
        customer,
        command.targetId,
        command.intent === 'SERVICE_AUTO_RENEW_CONFIRM',
        input.idempotencyKey,
        command.shownTotal ?? null,
      );
    }
    if (command.intent === 'SERVICE_TRANSFER_ASK' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await serviceRequestsFlow.serviceTransferAsk(
          this,
          scope,
          actor,
          customer,
          command.targetId,
          input,
        ),
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
        await serviceRequestsFlow.serviceTransferConfirm(
          this,
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
      return serviceActionsFlow.serviceRotate(
        this,
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
      const reply = await adminFlow.adminTurn(this, scope, actor, command, input);
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
        ? await startMenuFlow.startGreeting(this, scope, actor, customer, key)
        : { key, values: {} };
    return { ...greeting, buttons: [], orderId: null, ...menu };
  }

  /** The main menu: the returning customer's greeting with the main keyboard. */
  async mainMenuReply(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    input: { readonly telegramUserId: string },
  ): Promise<PendingReply> {
    return {
      ...(await startMenuFlow.startGreeting(
        this,
        scope,
        actor,
        customer,
        'bot.start.welcome_back',
      )),
      buttons: [],
      orderId: null,
      keyboard: (await this.isAdmin(scope, actor, input)) ? 'MAIN_MENU_ADMIN' : 'MAIN_MENU',
    };
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
      return topupFlow.topupAmountReply(this, scope, result, capture.id);
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
    // R10 D4: a gift card code. The window is closed RECEIVED by the read; the text is hashed.
    if (capture.purpose === 'GIFT_CARD_CODE') {
      return topupFlow.giftCardText(this, scope, actor, customer, text, input);
    }
    if (capture.purpose === 'GATEWAY_REFUND_CARD') {
      return cardReceiptFlow.gatewayRefundCardText(
        this,
        scope,
        actor,
        customer,
        capture,
        text,
        input,
      );
    }
    if (capture.purpose === 'SERVICE_REFUND_REASON') {
      return serviceRequestsFlow.serviceRefundReason(
        this,
        scope,
        actor,
        customer,
        capture.subjectId,
        text,
        input,
      );
    }
    if (capture.purpose === 'SERVICE_TRANSFER_RECIPIENT') {
      return serviceRequestsFlow.serviceTransferRecipient(
        this,
        scope,
        actor,
        customer,
        capture.subjectId,
        text,
        input,
      );
    }
    // WP-A7: a new ticket's first message, or a reply to one.
    if (capture.purpose === 'TICKET_NEW_MESSAGE' || capture.purpose === 'TICKET_REPLY') {
      return supportFlow.ticketSubmit(this, scope, actor, customer, capture, text, null, input);
    }
    if (capture.purpose === 'CUSTOM_SERVICE_VOLUME' || capture.purpose === 'CUSTOM_SERVICE_DAYS') {
      return purchaseFlow.customServiceFigure(this, scope, actor, customer, capture, text, input);
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
      return serviceCardFlow.serviceDetail(this, scope, actor, customer, capture.subjectId, {
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
    // R11 A11 (Codex, #354): a definite 429 left the message as it was; so is its wizard.
    if (
      edited.outcome === 'RATE_LIMITED' &&
      directive?.reopenOnRateLimit === true &&
      target.step !== directive.step
    ) {
      await state.moveBack(scope, actor, { ...target, version: target.version + 1 }, target.step);
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
    if (prompt !== null)
      await cardReceiptFlow.settleReceiptPrompt(this, scope, actor, target, prompt);
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
   * R10 D2: sends an owner-defined button's file from the bytes this installation holds, with
   * the reply as its caption when it is one. A definite REFUSAL — a structurally broken image,
   * a caption over Telegram's bound — falls back to the same reply as text, so the tap is never
   * left unanswered; `UNKNOWN` and `RATE_LIMITED` are returned as they are (the file may have
   * arrived, and a text would meet the same refusal).
   */
  async sendMediaBytes(
    scope: TenantContext,
    chatId: string,
    botInstanceId: BotInstanceId,
    reply: PendingReply,
    media: ReplyMediaBytes,
    asText: () => Promise<CustomerSendResult>,
  ): Promise<CustomerSendResult> {
    const sent = await this.deps.messenger.sendFile(scope, {
      chatId,
      botInstanceId,
      kind: media.kind,
      source: {
        kind: 'BYTES',
        bytes: media.bytes,
        fileName: media.fileName,
        mimeType: media.mimeType,
      },
      ...(media.captioned && reply.key !== null
        ? {
            caption: { templateKey: reply.key, values: reply.values },
            // Whole or not at all: a cut caption is a different message.
            captionWhole: true as const,
          }
        : {}),
      ...(reply.buttons.length === 0 ? {} : { buttons: reply.buttons }),
    });
    if (sent.outcome !== 'REFUSED') return sent;
    /*
     * Over the caption bound the file goes bare and the words follow as their own text; any
     * other refusal sends the words alone. A bare file's own outcome is decorative here.
     */
    if (media.captioned && sent.reason === 'CAPTION_OVER_BOUND') {
      await this.deps.messenger.sendFile(scope, {
        chatId,
        botInstanceId,
        kind: media.kind,
        source: {
          kind: 'BYTES',
          bytes: media.bytes,
          fileName: media.fileName,
          mimeType: media.mimeType,
        },
      });
    }
    return asText();
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

/** Re-exported so the controller need not know the record shape to log an outcome. */
export type { CustomerRecord };
