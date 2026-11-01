// Reading the intent out of a Telegram update.
// Moved verbatim out of bot-runtime.ts, which still re-exports every name it exported.
import {
  ADMIN_MENU_COMMAND,
  BROADCAST_ACTIONS,
  BROADCAST_ACTION_CALLBACK,
  BROADCAST_ACTION_COMMANDS,
  type BroadcastAction,
  REFERRAL_MENU_COMMAND,
  TRIAL_MENU_COMMAND,
  USAGE_REMINDER_PERCENT_MAX,
  USAGE_REMINDER_PERCENT_MIN,
  clientAppPlatformSchema,
  customMenuIdOfRoute,
  normalizeReceiptCaption,
  parseSupportAiStartPayload,
  paymentGatewayProviderSchema,
  uuidV7Schema,
  type SupportAiDeepLinkFlow,
} from '@nexa/contracts';
import type { InboundReceiptFile } from '../../../modules/commerce/payments/application/receipt-ports.js';
import { paymentIdOfTetrapayStart } from '../../../modules/commerce/payments/domain/tetrapay.js';
import {
  CONNECTED_CALLBACK_PREFIX,
  SERVICE_CARD_CALLBACK_PREFIX,
  SUPPORT_CALLBACK_DATA,
  TUTORIAL_CALLBACK_DATA,
} from '../../../modules/commerce/provisioning/application/delivery.service.js';
import { decodeKeysetToken } from '../keyset-token.js';
import { adminTutorialCallback, tutorialVideoOf } from '../admin-tutorial-video.js';
import {
  ADMIN_ADMIN_CALLBACK_PREFIX,
  ADMIN_ADMIN_STATUS_CALLBACK_PREFIX,
  ADMIN_APPROVE_CALLBACK_PREFIX,
  ADMIN_BLOCK_ASK_CALLBACK_PREFIX,
  ADMIN_BLOCK_CANCEL_CALLBACK_PREFIX,
  ADMIN_BLOCK_CONFIRM_CALLBACK_PREFIX,
  ADMIN_BLOCK_OPEN_CALLBACK_PREFIX,
  ADMIN_CATEGORIES_CALLBACK_PREFIX,
  ADMIN_CATEGORY_ASSIGN_CALLBACK_PREFIX,
  ADMIN_CATEGORY_CALLBACK_PREFIX,
  ADMIN_CATEGORY_CODES,
  ADMIN_CATEGORY_PICK_CALLBACK_PREFIX,
  ADMIN_CATEGORY_PRODUCTS_CALLBACK_PREFIX,
  ADMIN_CREDIT_CALLBACK_PREFIX,
  ADMIN_CREDIT_CANCEL_CALLBACK_PREFIX,
  ADMIN_CREDIT_CONFIRM_CALLBACK_PREFIX,
  ADMIN_CUSTOMERS_CALLBACK_PREFIX,
  ADMIN_CUSTOMER_CALLBACK_PREFIX,
  ADMIN_CUSTOMER_CODES,
  ADMIN_PANELS_CALLBACK_PREFIX,
  ADMIN_PANELS_PAGE_CALLBACK_PREFIX,
  ADMIN_PANEL_ARCHIVE_ASK_CALLBACK_PREFIX,
  ADMIN_PANEL_ARCHIVE_CALLBACK_PREFIX,
  ADMIN_PANEL_CALLBACK_PREFIX,
  ADMIN_PANEL_DETAIL_CALLBACK_PREFIX,
  ADMIN_PANEL_DISABLE_CALLBACK_PREFIX,
  ADMIN_PANEL_ENABLE_CALLBACK_PREFIX,
  ADMIN_PANEL_TEST_CALLBACK_PREFIX,
  ADMIN_RECEIPTS_CALLBACK_PREFIX,
  ADMIN_RECEIPT_CALLBACK_PREFIX,
  ADMIN_REFUND_REQUEST_APPROVE_CALLBACK_PREFIX,
  ADMIN_REFUND_REQUEST_APPROVE_CANCEL_CALLBACK_PREFIX,
  ADMIN_REFUND_REQUEST_APPROVE_CONFIRM_CALLBACK_PREFIX,
  ADMIN_REFUND_REQUEST_REJECT_CALLBACK_PREFIX,
  ADMIN_REJECT_CALLBACK_PREFIX,
  ADMIN_REJECT_CANCEL_CALLBACK_PREFIX,
  ADMIN_REJECT_CONFIRM_CALLBACK_PREFIX,
  ADMIN_REMINDERS_CALLBACK_PREFIX,
  ADMIN_REMINDER_EDIT_CALLBACK_PREFIX,
  ADMIN_REMINDER_SET_CALLBACK_PREFIX,
  ADMIN_REVOKE_CALLBACK_PREFIX,
  ADMIN_SECTION_CALLBACK_PREFIX,
  ADMIN_SERVICES_BROWSE_CALLBACK_DATA,
  ADMIN_SERVICES_BROWSE_PAGE_CALLBACK_PREFIX,
  ADMIN_SERVICES_CALLBACK_PREFIX,
  ADMIN_SERVICE_CALLBACK_PREFIX,
  ADMIN_SERVICE_RECONCILE_CALLBACK_PREFIX,
  ADMIN_SERVICE_RESEND_CALLBACK_PREFIX,
  ADMIN_SERVICE_RESUME_CALLBACK_PREFIX,
  ADMIN_SERVICE_RETRY_CALLBACK_PREFIX,
  ADMIN_SERVICE_ROTATE_ASK_CALLBACK_PREFIX,
  ADMIN_SERVICE_ROTATE_CALLBACK_PREFIX,
  ADMIN_SERVICE_SUSPEND_CALLBACK_PREFIX,
  ADMIN_SERVICE_SYNC_CALLBACK_PREFIX,
  ADMIN_SERVICE_TERMINATE_ASK_CALLBACK_PREFIX,
  ADMIN_SERVICE_TERMINATE_CALLBACK_PREFIX,
  ADMIN_USERNAME_CALLBACK_PREFIX,
  ADMIN_USERNAME_STRATEGY_CALLBACK_PREFIX,
  ADMIN_USERNAME_TOGGLE_CALLBACK_PREFIX,
  CANCEL_ORDER_ASK_CALLBACK_PREFIX,
  CANCEL_ORDER_CALLBACK_PREFIX,
  CUSTOM_SERVICE_BACK_CALLBACK_DATA,
  INPUT_BACK_CALLBACK_PREFIX,
  INPUT_CANCEL_CALLBACK_DATA,
  ORDER_PAYMENT_STATUS_CALLBACK_PREFIX,
  CANCEL_PAY_ASK_CALLBACK_PREFIX,
  CANCEL_PAY_CALLBACK_PREFIX,
  CATALOG_OPEN_CALLBACK_DATA,
  CATALOG_PAGE_CALLBACK_PREFIX,
  CATEGORY_CALLBACK_PREFIX,
  CLIENT_APP_CALLBACK_PREFIX,
  CONFIRM_CALLBACK_PREFIX,
  CUSTOM_SERVICE_CALLBACK_DATA,
  CUSTOM_SERVICE_LOCATION_CALLBACK_PREFIX,
  DISCOUNT_CODE_ENTER_CALLBACK_PREFIX,
  DISCOUNT_CODE_REMOVE_CALLBACK_PREFIX,
  GATEWAY_CANCEL_ASK_CALLBACK_PREFIX,
  GATEWAY_CANCEL_CALLBACK_PREFIX,
  GATEWAY_CARD_CHANGE_CALLBACK_PREFIX,
  GATEWAY_CHECK_CALLBACK_PREFIX,
  GATEWAY_PAY_CALLBACK_PREFIX,
  GATEWAY_RECEIPT_CALLBACK_PREFIX,
  GATEWAY_REFUND_CARD_CALLBACK_PREFIX,
  GATEWAY_ROUTE_PAY_CALLBACK_PREFIX,
  MAIN_MENU_CALLBACK_DATA,
  MANUAL_PAY_CALLBACK_PREFIX,
  MARKETING_OPT_IN_CALLBACK_DATA,
  MARKETING_OPT_OUT_CALLBACK_DATA,
  MEMBERSHIP_CHECK_CALLBACK_DATA,
  ORDER_CALLBACK_PREFIX,
  REORDER_CATEGORY_CALLBACK_PREFIX,
  PAY_METHODS_CALLBACK_PREFIX,
  PAY_METHODS_CLOSE_CALLBACK_PREFIX,
  PAY_SENT_CALLBACK_PREFIX,
  PAY_SWITCH_CARD_CALLBACK_PREFIX,
  REFERRAL_GIFT_CALLBACK_DATA,
  REFERRAL_INVITE_CALLBACK_PREFIX,
  ROTATION_STAMP_PATTERN,
  SERVICES_LIST_PAGE_CALLBACK_PREFIX,
  SERVICES_PAGE_CALLBACK_PREFIX,
  SERVICES_SEARCH_CALLBACK_DATA,
  SERVICE_ACTION_CONFIRM_CALLBACK_PREFIX,
  SERVICE_ADD_DEVICES_CALLBACK_PREFIX,
  SERVICE_ADD_TIME_CALLBACK_PREFIX,
  SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX,
  SERVICE_BUY_DEVICES_CALLBACK_PREFIX,
  SERVICE_BUY_TIME_CALLBACK_PREFIX,
  SERVICE_BUY_TRAFFIC_CALLBACK_PREFIX,
  SERVICE_CALLBACK_PREFIX,
  SERVICE_CHANGE_LOCATION_CALLBACK_PREFIX,
  SERVICE_FILES_CALLBACK_PREFIX,
  SERVICE_LOCATION_CONFIRM_CALLBACK_PREFIX,
  SERVICE_LOCATION_TARGET_CALLBACK_PREFIX,
  SERVICE_NOTE_CALLBACK_PREFIX,
  SERVICE_REFRESH_CALLBACK_PREFIX,
  SERVICE_REFUND_ASK_CALLBACK_PREFIX,
  SERVICE_REFUND_CONFIRM_CALLBACK_PREFIX,
  SERVICE_RENEW_CALLBACK_PREFIX,
  SERVICE_RENEW_PLAN_CALLBACK_PREFIX,
  SERVICE_RENEW_QUOTE_CALLBACK_PREFIX,
  SERVICE_RESEND_CALLBACK_PREFIX,
  SERVICE_RESUME_CALLBACK_PREFIX,
  SERVICE_RESUME_CONFIRM_CALLBACK_PREFIX,
  SERVICE_ROTATE_ASK_CALLBACK_PREFIX,
  SERVICE_ROTATE_CALLBACK_PREFIX,
  SERVICE_SUSPEND_CALLBACK_PREFIX,
  SERVICE_SUSPEND_CONFIRM_CALLBACK_PREFIX,
  SERVICE_TERMINATE_ASK_CALLBACK_PREFIX,
  SERVICE_TERMINATE_CALLBACK_PREFIX,
  SERVICE_TRANSFER_ASK_CALLBACK_PREFIX,
  SERVICE_AUTO_RENEW_ASK_CALLBACK_PREFIX,
  SERVICE_AUTO_RENEW_CONFIRM_CALLBACK_PREFIX,
  SERVICE_AUTO_RENEW_OFF_CALLBACK_PREFIX,
  SERVICE_TRANSFER_CONFIRM_CALLBACK_PREFIX,
  TERMS_ACCEPT_CALLBACK_PREFIX,
  START_CAPTCHA_CALLBACK_PREFIX,
  TICKETS_CALLBACK_DATA,
  TICKET_CATEGORY_CALLBACK_PREFIX,
  TICKET_CLOSE_ASK_CALLBACK_PREFIX,
  TICKET_CLOSE_CALLBACK_PREFIX,
  TICKET_NEW_CALLBACK_DATA,
  TICKET_REPLY_CALLBACK_PREFIX,
  TICKET_VIEW_CALLBACK_PREFIX,
  TOPUP_CLOSE_CALLBACK_PREFIX,
  TOPUP_MENU_CALLBACK_PREFIX,
  GIFT_CARD_CALLBACK_DATA,
  TOPUP_PICK_CALLBACK_PREFIX,
  TOPUP_ROUTE_CALLBACK_PREFIX,
  TRIAL_CALLBACK_DATA,
  TRIAL_PANEL_CALLBACK_PREFIX,
  TUTORIAL_PLATFORM_CALLBACK_PREFIX,
  USERNAME_AUTOMATIC_CALLBACK_PREFIX,
  USERNAME_CUSTOM_CALLBACK_PREFIX,
  WALLET_HISTORY_CALLBACK_PREFIX,
  WALLET_OPEN_CALLBACK_DATA,
  WALLET_PAY_CALLBACK_PREFIX,
  decodeAutoRenewConfirm,
  decodeDeviceQuantity,
  decodeIdPair,
  decodeServiceLocationPair,
  decodeTransferConfirm,
  isAdminCategoryCode,
  isAdminCustomerCode,
  isAdminStatusCode,
  isReminderSettingCode,
  isUsernameStrategyCode,
  isUsernameToggleField,
  parseCatalogPage,
} from './callbacks.js';
import type { BotCommand, BotIntent } from './intents.js';

/** The four administrator callbacks, prefix to intent. Each carries one UUIDv7. */
const ADMIN_REFUND_REQUEST_CALLBACKS: readonly (readonly [string, BotIntent])[] = [
  [ADMIN_REFUND_REQUEST_APPROVE_CALLBACK_PREFIX, 'ADMIN_REFUND_REQUEST_APPROVE'],
  [ADMIN_REFUND_REQUEST_REJECT_CALLBACK_PREFIX, 'ADMIN_REFUND_REQUEST_REJECT'],
  [ADMIN_REFUND_REQUEST_APPROVE_CONFIRM_CALLBACK_PREFIX, 'ADMIN_REFUND_REQUEST_CONFIRM'],
  [ADMIN_REFUND_REQUEST_APPROVE_CANCEL_CALLBACK_PREFIX, 'ADMIN_REFUND_REQUEST_CANCEL'],
];

/** Block User's prefixes, as a table so a prefix cannot point at the wrong intent. */
const ADMIN_BLOCK_CALLBACKS: readonly (readonly [string, BotIntent])[] = [
  [ADMIN_BLOCK_ASK_CALLBACK_PREFIX, 'ADMIN_BLOCK_ASK'],
  [ADMIN_BLOCK_OPEN_CALLBACK_PREFIX, 'ADMIN_BLOCK_OPEN'],
  [ADMIN_BLOCK_CONFIRM_CALLBACK_PREFIX, 'ADMIN_BLOCK_CONFIRM'],
  [ADMIN_BLOCK_CANCEL_CALLBACK_PREFIX, 'ADMIN_BLOCK_CANCEL'],
  [ADMIN_REJECT_CONFIRM_CALLBACK_PREFIX, 'ADMIN_REJECT_CONFIRM'],
  [ADMIN_REJECT_CANCEL_CALLBACK_PREFIX, 'ADMIN_REJECT_CANCEL'],
];

const ADMIN_PANEL_CALLBACKS: readonly (readonly [string, BotIntent])[] = [
  [ADMIN_PANEL_DETAIL_CALLBACK_PREFIX, 'ADMIN_PANEL_DETAIL'],
  [ADMIN_PANEL_TEST_CALLBACK_PREFIX, 'ADMIN_PANEL_TEST'],
  [ADMIN_PANEL_ENABLE_CALLBACK_PREFIX, 'ADMIN_PANEL_ENABLE'],
  [ADMIN_PANEL_DISABLE_CALLBACK_PREFIX, 'ADMIN_PANEL_DISABLE'],
  [ADMIN_PANEL_ARCHIVE_ASK_CALLBACK_PREFIX, 'ADMIN_PANEL_ARCHIVE_ASK'],
  /*
   * LAST, and the row that makes this a table rather than seven `if`s: a mis-wiring
   * here would make the ASKING callback the one that archives, which is the same
   * one-character mistake `ADMIN_SERVICE_CALLBACKS` names in its own comment.
   */
  [ADMIN_PANEL_ARCHIVE_CALLBACK_PREFIX, 'ADMIN_PANEL_ARCHIVE'],
  [ADMIN_USERNAME_CALLBACK_PREFIX, 'ADMIN_USERNAME'],
];

const ADMIN_SERVICE_CALLBACKS: readonly (readonly [string, BotIntent])[] = [
  [ADMIN_SERVICE_CALLBACK_PREFIX, 'ADMIN_SERVICE'],
  [ADMIN_SERVICE_SYNC_CALLBACK_PREFIX, 'ADMIN_SERVICE_SYNC'],
  [ADMIN_SERVICE_RESEND_CALLBACK_PREFIX, 'ADMIN_SERVICE_RESEND'],
  [ADMIN_SERVICE_RETRY_CALLBACK_PREFIX, 'ADMIN_SERVICE_RETRY'],
  [ADMIN_SERVICE_RECONCILE_CALLBACK_PREFIX, 'ADMIN_SERVICE_RECONCILE'],
  [ADMIN_SERVICE_SUSPEND_CALLBACK_PREFIX, 'ADMIN_SERVICE_SUSPEND'],
  [ADMIN_SERVICE_RESUME_CALLBACK_PREFIX, 'ADMIN_SERVICE_RESUME'],
  [ADMIN_SERVICE_TERMINATE_ASK_CALLBACK_PREFIX, 'ADMIN_SERVICE_TERMINATE_ASK'],
  [ADMIN_SERVICE_TERMINATE_CALLBACK_PREFIX, 'ADMIN_SERVICE_TERMINATE'],
  [ADMIN_SERVICE_ROTATE_ASK_CALLBACK_PREFIX, 'ADMIN_SERVICE_ROTATE_ASK'],
  // `rb:` is not here: it carries a stamp as well as an id, so it is decoded before this
  // table is consulted — see `adminServiceRotateCommand`.
];

/**
 * The rotating callback, or null when `data` is not one.
 *
 * Validated here and nowhere later: the id as a UUIDv7, the stamp as twelve hex
 * characters. Anything else is UNSUPPORTED, including the bare `rb:<id>` an older
 * keyboard would have carried — a confirmation with no stamp confirms nothing.
 */
function adminServiceRotateCommand(data: string, id: string | null): BotCommand | null {
  if (!data.startsWith(ADMIN_SERVICE_ROTATE_CALLBACK_PREFIX)) return null;
  const unsupported: BotCommand = { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
  const [rawId, stamp, ...rest] = data
    .slice(ADMIN_SERVICE_ROTATE_CALLBACK_PREFIX.length)
    .split('.');
  const service = uuidV7Schema.safeParse(rawId);
  if (rest.length > 0 || stamp === undefined || !ROTATION_STAMP_PATTERN.test(stamp)) {
    return unsupported;
  }
  if (!service.success) return unsupported;
  return {
    intent: 'ADMIN_SERVICE_ROTATE',
    targetId: service.data,
    args: [stamp],
    callbackQueryId: id,
  };
}

/**
 * Reads the intent out of an update.
 *
 * Reads through passthrough fields rather than a modelled `message` shape, exactly as
 * `isPingCommand` already does: `telegramUpdateSchema` states what this installation
 * depends on and the rest of an update stays unmodelled on purpose. Anything unexpected
 * is `UNSUPPORTED`, which is a real answer and not an error.
 *
 * The command is matched on the FIRST token only, so `/start payload` is still `/start` —
 * Telegram's deep links put a payload there and 4F's referral codes arrive that way.
 * The payload itself is deliberately NOT returned here: nothing in 4A consumes it, and a
 * field nothing consumes is a field that gets logged.
 */
/**
 * What a tap on the persistent main menu sends, and the command it means.
 *
 * Telegram delivers a `ReplyKeyboardMarkup` tap as an ORDINARY TEXT MESSAGE whose body
 * is the button's label. There is no `callback_data`, no signature and no id — which is
 * why the menu carries no authority and every contextual action stays on the callback
 * architecture with its validated identifier and its ownership check.
 *
 * PASSED IN rather than read here, because a surface may not reach the catalogue: the
 * boundary check refuses `@nexa/i18n` in `surfaces/`, and its reason is this exact
 * shape — a surface that renders text itself is a second renderer beside the template
 * resolver. The composition root builds this map from the same catalogue the messenger
 * draws the keyboard from, so the string that is drawn and the string that is matched
 * come from one place and cannot disagree.
 *
 * Matched on the EXACT string. No case folding and no fuzzy match: an unknown text is
 * `UNSUPPORTED` exactly as it was before this existed.
 */
export type MainMenuRoutes = ReadonlyMap<string, string>;

/** No menu configured. The slash commands still answer; nothing else changes. */
const NO_MENU: MainMenuRoutes = new Map();

/**
 * The payload of a `/start`, or null when this update is not one or carries none.
 *
 * Read ONLY for the referral program, which reads it only on the update that creates the
 * customer (WP9 F2); `intentOf` still drops it, so nothing else can grow a dependency on
 * it. Bounded to Telegram's own limit — a start parameter is at most 64 characters of
 * `[A-Za-z0-9_-]` — so a hand-crafted message cannot carry anything larger or stranger
 * into a service.
 */
export function startPayloadOf(update: unknown): string | null {
  const text = (update as { message?: { text?: unknown } } | null)?.message?.text;
  if (typeof text !== 'string') return null;
  const match = /^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{1,64})\s*$/.exec(text);
  return match?.[1] ?? null;
}

/**
 * Phase 4 PR-3 — the bot intent a support-AI deep link opens: an EXISTING intent each, with the
 * id the link carries as its target. Null when the payload is not one (an ordinary `/start`, a
 * referral code, anything malformed): the customer gets the start screen as before.
 */
const SUPPORT_AI_DEEP_LINK_INTENTS: Readonly<Record<SupportAiDeepLinkFlow, BotIntent>> = {
  buy: 'CATALOG',
  category: 'REORDER_CATEGORY',
  renew: 'SERVICE_RENEW',
  addTraffic: 'SERVICE_ADD_TRAFFIC',
  addTime: 'SERVICE_ADD_TIME',
  changeLocation: 'SERVICE_CHANGE_LOCATION',
  rotate: 'SERVICE_ROTATE_ASK',
  service: 'SERVICE',
  trial: 'TRIAL_CLAIM',
  topup: 'TOPUP_MENU',
};

export function supportAiStartCommandOf(payload: string | null): BotCommand | null {
  const link = parseSupportAiStartPayload(payload);
  if (link === null) return null;
  return {
    intent: SUPPORT_AI_DEEP_LINK_INTENTS[link.flow],
    targetId: link.id,
    callbackQueryId: null,
  };
}

/**
 * The update's Telegram `update_id`, which increases per bot (WP19). A refund-request prompt
 * reads only messages newer than the tap that opened it, so a redelivered older message can
 * never become its amount or reason. Undefined when absent or not a non-negative integer.
 */
export function updateIdOf(update: unknown): bigint | undefined {
  const raw = (update as { update_id?: unknown } | null)?.update_id;
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? BigInt(raw) : undefined;
}

export function intentOf(update: unknown, menu: MainMenuRoutes = NO_MENU): BotCommand {
  const callback = (update as { callback_query?: { id?: unknown; data?: unknown } } | null)
    ?.callback_query;
  if (callback !== undefined && callback !== null) {
    const id = typeof callback.id === 'string' ? callback.id : null;
    const data = typeof callback.data === 'string' ? callback.data : '';
    /*
     * Validated here, not cast.
     *
     * `callback_data` is whatever the client sent. Telegram signs nothing about it, so a
     * modified client can put any string after the prefix — and the two services below
     * take an id. A malformed one is UNSUPPORTED, which answers the customer, rather
     * than a 500 at the `uuid` cast or a refusal that names the column.
     */
    /*
     * The two catalogue callbacks, before every single-letter prefix.
     *
     * Order does not matter today — no single-letter prefix is a prefix of `cg:` or
     * `ck:` — and they are placed first anyway, because if one ever were, the failure
     * would be silent: a tap routed to confirm an order instead of turning a page.
     */
    /*
     * R4 A6: a broadcast's in-bot action button, `bc:<ACTION>`. The action is a closed code,
     * validated here, and it becomes EXACTLY the command its main-menu entry stands for —
     * parsed by this same function from that command's text — so a broadcast button has no
     * handler of its own: «خرید سرویس» under a broadcast and «🛒 خرید اشتراک» on the keyboard
     * are one route. Nothing here authorises anything; the command's own branch decides.
     */
    if (data.startsWith(BROADCAST_ACTION_CALLBACK)) {
      const action = data.slice(BROADCAST_ACTION_CALLBACK.length);
      if (!(BROADCAST_ACTIONS as readonly string[]).includes(action)) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      const routed = intentOf({
        message: { text: BROADCAST_ACTION_COMMANDS[action as BroadcastAction] },
      });
      return { ...routed, callbackQueryId: id };
    }
    if (data === TRIAL_CALLBACK_DATA) {
      return { intent: 'TRIAL_CLAIM', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(TRIAL_PANEL_CALLBACK_PREFIX)) {
      const panel = uuidV7Schema.safeParse(data.slice(TRIAL_PANEL_CALLBACK_PREFIX.length));
      if (!panel.success) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'TRIAL_PANEL', targetId: panel.data, callbackQueryId: id };
    }
    if (data === CUSTOM_SERVICE_CALLBACK_DATA) {
      return { intent: 'CUSTOM_SERVICE_MENU', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(CUSTOM_SERVICE_LOCATION_CALLBACK_PREFIX)) {
      const panel = uuidV7Schema.safeParse(
        data.slice(CUSTOM_SERVICE_LOCATION_CALLBACK_PREFIX.length),
      );
      if (!panel.success) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'CUSTOM_SERVICE_LOCATION', targetId: panel.data, callbackQueryId: id };
    }
    if (data.startsWith(CATALOG_PAGE_CALLBACK_PREFIX)) {
      const page = parseCatalogPage(data.slice(CATALOG_PAGE_CALLBACK_PREFIX.length));
      if (page === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'CATALOG_PAGE', targetId: null, page, callbackQueryId: id };
    }
    if (data.startsWith(REORDER_CATEGORY_CALLBACK_PREFIX)) {
      const category = uuidV7Schema.safeParse(data.slice(REORDER_CATEGORY_CALLBACK_PREFIX.length));
      if (!category.success) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'REORDER_CATEGORY', targetId: category.data, callbackQueryId: id };
    }
    if (data.startsWith(CATEGORY_CALLBACK_PREFIX)) {
      const [rawId, rawPage, ...rest] = data.slice(CATEGORY_CALLBACK_PREFIX.length).split('.');
      const page = rawPage === undefined ? null : parseCatalogPage(rawPage);
      const category = uuidV7Schema.safeParse(rawId);
      if (rest.length > 0 || page === null || !category.success) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      return { intent: 'CATEGORY', targetId: category.data, page, callbackQueryId: id };
    }
    /*
     * The customer UX completion's two-letter routes, before the one-letter ones for
     * the reason the catalogue's are: none shadows another today, and placing them
     * first keeps that true if a one-letter prefix is ever added that would.
     */
    if (data === MARKETING_OPT_OUT_CALLBACK_DATA) {
      return { intent: 'MARKETING_OPT_OUT', targetId: null, callbackQueryId: id };
    }
    if (data === MARKETING_OPT_IN_CALLBACK_DATA) {
      return { intent: 'MARKETING_OPT_IN', targetId: null, callbackQueryId: id };
    }
    if (data === MAIN_MENU_CALLBACK_DATA) {
      return { intent: 'MAIN_MENU', targetId: null, callbackQueryId: id };
    }
    // R12 F3 item 2: the buttons under a typed-input prompt.
    if (data === INPUT_CANCEL_CALLBACK_DATA) {
      return { intent: 'INPUT_CANCEL', targetId: null, callbackQueryId: id };
    }
    if (data === CUSTOM_SERVICE_BACK_CALLBACK_DATA) {
      return { intent: 'CUSTOM_SERVICE_BACK', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(ORDER_PAYMENT_STATUS_CALLBACK_PREFIX)) {
      return callbackCommand(
        'ORDER_PAYMENT_STATUS',
        data.slice(ORDER_PAYMENT_STATUS_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(INPUT_BACK_CALLBACK_PREFIX)) {
      return callbackCommand('INPUT_BACK', data.slice(INPUT_BACK_CALLBACK_PREFIX.length), id);
    }
    // R12 F3 item 7: the wallet history, its newest page or the page after a keyset token.
    if (data.startsWith(WALLET_HISTORY_CALLBACK_PREFIX)) {
      const token = data.slice(WALLET_HISTORY_CALLBACK_PREFIX.length);
      if (token === '') {
        return { intent: 'WALLET_HISTORY', targetId: null, callbackQueryId: id };
      }
      const cursor = decodeKeysetToken(token);
      if (cursor === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'WALLET_HISTORY', targetId: null, cursor, callbackQueryId: id };
    }
    // Owner spec §2.2: the wallet-credit message's two next actions.
    if (data === WALLET_OPEN_CALLBACK_DATA) {
      return { intent: 'WALLET', targetId: null, callbackQueryId: id };
    }
    if (data === CATALOG_OPEN_CALLBACK_DATA) {
      return { intent: 'CATALOG', targetId: null, callbackQueryId: id };
    }
    if (data === MEMBERSHIP_CHECK_CALLBACK_DATA) {
      return { intent: 'MEMBERSHIP_CHECK', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(TERMS_ACCEPT_CALLBACK_PREFIX)) {
      const version = uuidV7Schema.safeParse(data.slice(TERMS_ACCEPT_CALLBACK_PREFIX.length));
      if (!version.success) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'TERMS_ACCEPT', targetId: version.data, callbackQueryId: id };
    }
    // R10 D5 (a): `hc:<question uuid>:<0-3>` — a question and a position, nothing else.
    if (data.startsWith(START_CAPTCHA_CALLBACK_PREFIX)) {
      const answer = /^([0-9a-f-]{36}):([0-3])$/u.exec(
        data.slice(START_CAPTCHA_CALLBACK_PREFIX.length),
      );
      const question = uuidV7Schema.safeParse(answer?.[1]);
      if (answer === null || !question.success) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      return {
        intent: 'CAPTCHA_ANSWER',
        targetId: question.data,
        choice: Number(answer[2]),
        callbackQueryId: id,
      };
    }
    if (data === TUTORIAL_CALLBACK_DATA) {
      return { intent: 'TUTORIAL', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(TUTORIAL_PLATFORM_CALLBACK_PREFIX)) {
      // WP-A10 widened the vocabulary by `OTHER` and kept the first five in order, so a
      // `to:<platform>` already sitting in a customer's chat parses exactly as it did.
      const platform = clientAppPlatformSchema.safeParse(
        data.slice(TUTORIAL_PLATFORM_CALLBACK_PREFIX.length),
      );
      if (!platform.success) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'TUTORIAL_PLATFORM', targetId: platform.data, callbackQueryId: id };
    }
    if (data.startsWith(CLIENT_APP_CALLBACK_PREFIX)) {
      return callbackCommand('CLIENT_APP', data.slice(CLIENT_APP_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(CONNECTED_CALLBACK_PREFIX)) {
      return callbackCommand('SERVICE_CONNECTED', data.slice(CONNECTED_CALLBACK_PREFIX.length), id);
    }
    // WP-A7: the ticket desk, before the one-letter prefixes.
    const ticket = ticketCallbackCommand(data, id);
    if (ticket !== null) return ticket;
    if (data === SUPPORT_CALLBACK_DATA) {
      return { intent: 'SUPPORT', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(TOPUP_ROUTE_CALLBACK_PREFIX)) {
      const [rawId, rawProvider, ...rest] = data
        .slice(TOPUP_ROUTE_CALLBACK_PREFIX.length)
        .split('.');
      const capture = uuidV7Schema.safeParse(rawId);
      const provider = paymentGatewayProviderSchema.safeParse(rawProvider);
      if (rest.length > 0 || !capture.success || !provider.success) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      return {
        intent: 'TOPUP_ROUTE',
        targetId: capture.data,
        secondaryId: provider.data,
        callbackQueryId: id,
      };
    }
    if (data.startsWith(TOPUP_CLOSE_CALLBACK_PREFIX)) {
      return callbackCommand('TOPUP_CLOSE', data.slice(TOPUP_CLOSE_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(SERVICES_LIST_PAGE_CALLBACK_PREFIX)) {
      const page = parseCatalogPage(data.slice(SERVICES_LIST_PAGE_CALLBACK_PREFIX.length));
      if (page === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'SERVICES_PAGE', targetId: null, page, callbackQueryId: id };
    }
    if (data === SERVICES_SEARCH_CALLBACK_DATA) {
      return { intent: 'SERVICES_SEARCH', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(SERVICE_REFRESH_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_REFRESH',
        data.slice(SERVICE_REFRESH_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_NOTE_CALLBACK_PREFIX)) {
      return callbackCommand('SERVICE_NOTE', data.slice(SERVICE_NOTE_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(SERVICE_CARD_CALLBACK_PREFIX)) {
      return callbackCommand('SERVICE_CARD', data.slice(SERVICE_CARD_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(SERVICE_RENEW_QUOTE_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_RENEW_QUOTE',
        data.slice(SERVICE_RENEW_QUOTE_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_RENEW_PLAN_CALLBACK_PREFIX)) {
      // Two ids, through the same validation the add-on pair takes: a malformed pair is
      // UNSUPPORTED, never a half-read that renews from a plan nobody named.
      const pair = decodeIdPair(data.slice(SERVICE_RENEW_PLAN_CALLBACK_PREFIX.length));
      if (pair === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      const service = uuidV7Schema.safeParse(pair.first);
      const plan = uuidV7Schema.safeParse(pair.second);
      if (!service.success || !plan.success) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      return {
        intent: 'SERVICE_RENEW_PLAN',
        targetId: service.data,
        secondaryId: plan.data,
        callbackQueryId: id,
      };
    }
    if (data === REFERRAL_GIFT_CALLBACK_DATA) {
      return { intent: 'REFERRAL_GIFT', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(ORDER_CALLBACK_PREFIX)) {
      return callbackCommand('ORDER', data.slice(ORDER_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(CONFIRM_CALLBACK_PREFIX)) {
      return callbackCommand('CONFIRM', data.slice(CONFIRM_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(WALLET_PAY_CALLBACK_PREFIX)) {
      return callbackCommand('PAY_WALLET', data.slice(WALLET_PAY_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(MANUAL_PAY_CALLBACK_PREFIX)) {
      return callbackCommand('PAY_MANUAL', data.slice(MANUAL_PAY_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(PAY_METHODS_CALLBACK_PREFIX)) {
      return callbackCommand('PAY_METHODS', data.slice(PAY_METHODS_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(PAY_METHODS_CLOSE_CALLBACK_PREFIX)) {
      return callbackCommand(
        'PAY_METHODS_CLOSE',
        data.slice(PAY_METHODS_CLOSE_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(GATEWAY_ROUTE_PAY_CALLBACK_PREFIX)) {
      const [rawId, rawProvider, ...rest] = data
        .slice(GATEWAY_ROUTE_PAY_CALLBACK_PREFIX.length)
        .split('.');
      const order = uuidV7Schema.safeParse(rawId);
      const provider = paymentGatewayProviderSchema.safeParse(rawProvider);
      if (rest.length > 0 || !order.success || !provider.success) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      return {
        intent: 'PAY_GATEWAY',
        targetId: order.data,
        secondaryId: provider.data,
        callbackQueryId: id,
      };
    }
    if (data.startsWith(GATEWAY_PAY_CALLBACK_PREFIX)) {
      return callbackCommand('PAY_GATEWAY', data.slice(GATEWAY_PAY_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(GATEWAY_RECEIPT_CALLBACK_PREFIX)) {
      return callbackCommand(
        'GATEWAY_RECEIPT',
        data.slice(GATEWAY_RECEIPT_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(GATEWAY_CARD_CHANGE_CALLBACK_PREFIX)) {
      return callbackCommand(
        'GATEWAY_CARD_CHANGE',
        data.slice(GATEWAY_CARD_CHANGE_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(GATEWAY_CANCEL_ASK_CALLBACK_PREFIX)) {
      return callbackCommand(
        'GATEWAY_CANCEL_ASK',
        data.slice(GATEWAY_CANCEL_ASK_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(GATEWAY_CANCEL_CALLBACK_PREFIX)) {
      return callbackCommand(
        'GATEWAY_CANCEL',
        data.slice(GATEWAY_CANCEL_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(GATEWAY_REFUND_CARD_CALLBACK_PREFIX)) {
      return callbackCommand(
        'GATEWAY_REFUND_CARD',
        data.slice(GATEWAY_REFUND_CARD_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(GATEWAY_CHECK_CALLBACK_PREFIX)) {
      return callbackCommand('GATEWAY_CHECK', data.slice(GATEWAY_CHECK_CALLBACK_PREFIX.length), id);
    }
    /*
     * ASK before the destructive prefix, and they are different letters so the order
     * cannot matter today. Fixed anyway for the reason the resend/service pair states:
     * if one ever became a prefix of the other every tap would route to whichever
     * branch came first, and here that is the difference between showing a customer a
     * question and closing the payment their money is against.
     */
    if (data.startsWith(CANCEL_PAY_ASK_CALLBACK_PREFIX)) {
      return callbackCommand(
        'PAY_CANCEL_ASK',
        data.slice(CANCEL_PAY_ASK_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(CANCEL_PAY_CALLBACK_PREFIX)) {
      return callbackCommand('PAY_CANCEL', data.slice(CANCEL_PAY_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(PAY_SENT_CALLBACK_PREFIX)) {
      return callbackCommand('PAY_SENT', data.slice(PAY_SENT_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(PAY_SWITCH_CARD_CALLBACK_PREFIX)) {
      return paySwitchCardCommand(data.slice(PAY_SWITCH_CARD_CALLBACK_PREFIX.length), id);
    }
    /*
     * The menu carries no target, so it is matched on the WHOLE string. `callbackCommand`
     * validates its slice as a uuid and would refuse an empty one, which is right for
     * every other prefix here and wrong for this: the tap means "show me the amounts".
     */
    if (data === TOPUP_MENU_CALLBACK_PREFIX) {
      return { intent: 'TOPUP_MENU', targetId: null, callbackQueryId: id };
    }
    if (data === GIFT_CARD_CALLBACK_DATA) {
      return { intent: 'GIFT_CARD', targetId: null, callbackQueryId: id };
    }
    if (data === REFERRAL_INVITE_CALLBACK_PREFIX) {
      return { intent: 'REFERRAL_INVITE', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(TOPUP_PICK_CALLBACK_PREFIX)) {
      /*
       * DIGITS, and the shape is validated here rather than parsed in the handler: the
       * data is client-supplied, so anything that is not a plain positive integer is
       * UNSUPPORTED — which answers the customer — instead of reaching `BigInt()` and
       * throwing a SyntaxError inside a transaction. The length bound stops a
       * megabyte-long number being converted at all; `PAYMENT_AMOUNT_MAX_MINOR` is
       * thirteen digits, and the service refuses anything not on the preset list anyway.
       */
      const raw = data.slice(TOPUP_PICK_CALLBACK_PREFIX.length);
      if (!/^[1-9]\d{0,19}$/.test(raw)) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      return { intent: 'TOPUP_PICK', targetId: raw, callbackQueryId: id };
    }
    /* ASK before the destructive one, exactly as the payment pair above is ordered. */
    if (data.startsWith(CANCEL_ORDER_ASK_CALLBACK_PREFIX)) {
      return callbackCommand(
        'ORDER_CANCEL_ASK',
        data.slice(CANCEL_ORDER_ASK_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(CANCEL_ORDER_CALLBACK_PREFIX)) {
      return callbackCommand('ORDER_CANCEL', data.slice(CANCEL_ORDER_CALLBACK_PREFIX.length), id);
    }
    /*
     * The resend prefix is tested BEFORE the service prefix.
     *
     * `'r:'` and `'s:'` share no first character, so today the order is irrelevant — it
     * is fixed anyway because the failure it prevents is silent: a prefix that is a
     * prefix of another routes every tap to whichever branch comes first, and the
     * customer gets the wrong screen with nothing anywhere saying so.
     */
    if (data.startsWith(SERVICE_FILES_CALLBACK_PREFIX)) {
      return callbackCommand('SERVICE_FILES', data.slice(SERVICE_FILES_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(SERVICE_RESEND_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_RESEND',
        data.slice(SERVICE_RESEND_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_SUSPEND_CONFIRM_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_SUSPEND_CONFIRM',
        data.slice(SERVICE_SUSPEND_CONFIRM_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_RESUME_CONFIRM_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_RESUME_CONFIRM',
        data.slice(SERVICE_RESUME_CONFIRM_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_SUSPEND_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_SUSPEND',
        data.slice(SERVICE_SUSPEND_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_RESUME_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_RESUME',
        data.slice(SERVICE_RESUME_CALLBACK_PREFIX.length),
        id,
      );
    }
    /*
     * Retired, and still parsed (WP15 G1): a stale TERMINATE tap must reach the handler
     * that refuses it, not fall through to the unknown-callback path or to a prefix a
     * later release gives these letters.
     */
    if (data.startsWith(SERVICE_TERMINATE_ASK_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_TERMINATE_ASK',
        data.slice(SERVICE_TERMINATE_ASK_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_TERMINATE_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_TERMINATE',
        data.slice(SERVICE_TERMINATE_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_REFUND_ASK_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_REFUND_ASK',
        data.slice(SERVICE_REFUND_ASK_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_REFUND_CONFIRM_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_REFUND_CONFIRM',
        data.slice(SERVICE_REFUND_CONFIRM_CALLBACK_PREFIX.length),
        id,
      );
    }
    // Round 10, D1: automatic renewal — ask, confirm, off.
    if (data.startsWith(SERVICE_AUTO_RENEW_ASK_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_AUTO_RENEW_ASK',
        data.slice(SERVICE_AUTO_RENEW_ASK_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_AUTO_RENEW_CONFIRM_CALLBACK_PREFIX)) {
      const confirmed = decodeAutoRenewConfirm(data);
      if (confirmed === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return {
        intent: 'SERVICE_AUTO_RENEW_CONFIRM',
        targetId: confirmed.serviceId,
        shownTotal: confirmed.shown,
        callbackQueryId: id,
      };
    }
    if (data.startsWith(SERVICE_AUTO_RENEW_OFF_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_AUTO_RENEW_OFF',
        data.slice(SERVICE_AUTO_RENEW_OFF_CALLBACK_PREFIX.length),
        id,
      );
    }
    /* Ask before act, for the reason the terminate pair states. */
    if (data.startsWith(SERVICE_TRANSFER_ASK_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_TRANSFER_ASK',
        data.slice(SERVICE_TRANSFER_ASK_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_TRANSFER_CONFIRM_CALLBACK_PREFIX)) {
      const pair = decodeTransferConfirm(data);
      if (pair === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return {
        intent: 'SERVICE_TRANSFER_CONFIRM',
        targetId: pair.serviceId,
        secondaryId: pair.recipientTelegramUserId,
        ownershipVersion: pair.ownershipVersion,
        callbackQueryId: id,
      };
    }
    /* Ask before act, for the reason the terminate pair above states. */
    if (data.startsWith(SERVICE_ROTATE_ASK_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_ROTATE_ASK',
        data.slice(SERVICE_ROTATE_ASK_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_ROTATE_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_ROTATE',
        data.slice(SERVICE_ROTATE_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_RENEW_CALLBACK_PREFIX)) {
      return callbackCommand('SERVICE_RENEW', data.slice(SERVICE_RENEW_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_ADD_TRAFFIC',
        data.slice(SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_ADD_TIME_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_ADD_TIME',
        data.slice(SERVICE_ADD_TIME_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_ADD_DEVICES_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_ADD_DEVICES',
        data.slice(SERVICE_ADD_DEVICES_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_CHANGE_LOCATION_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_CHANGE_LOCATION',
        data.slice(SERVICE_CHANGE_LOCATION_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (
      data.startsWith(SERVICE_LOCATION_TARGET_CALLBACK_PREFIX) ||
      data.startsWith(SERVICE_LOCATION_CONFIRM_CALLBACK_PREFIX)
    ) {
      const chosen = decodeServiceLocationPair(data.slice(3));
      if (chosen === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return {
        intent: data.startsWith(SERVICE_LOCATION_TARGET_CALLBACK_PREFIX)
          ? 'SERVICE_LOCATION_TARGET'
          : 'SERVICE_LOCATION_CONFIRM',
        targetId: chosen.serviceId,
        secondaryId: chosen.locationId,
        callbackQueryId: id,
      };
    }
    if (data.startsWith(SERVICE_BUY_DEVICES_CALLBACK_PREFIX)) {
      const chosen = decodeDeviceQuantity(data);
      if (chosen === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return {
        intent: 'SERVICE_BUY_DEVICES',
        targetId: chosen.serviceId,
        secondaryId: chosen.addonId,
        quantity: chosen.quantity,
        callbackQueryId: id,
      };
    }
    if (
      data.startsWith(SERVICE_BUY_TRAFFIC_CALLBACK_PREFIX) ||
      data.startsWith(SERVICE_BUY_TIME_CALLBACK_PREFIX)
    ) {
      const buying = data.startsWith(SERVICE_BUY_TRAFFIC_CALLBACK_PREFIX)
        ? ('SERVICE_BUY_TRAFFIC' as const)
        : ('SERVICE_BUY_TIME' as const);
      /*
       * The one callback carrying two ids, and both go through the SAME validation the
       * single-id path uses. A malformed pair is `UNSUPPORTED`, not a 500 at a `uuid`
       * cast, and not a half-read that would buy a package for a service nobody named.
       */
      const pair = decodeIdPair(data.slice(2));
      if (pair === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      const service = uuidV7Schema.safeParse(pair.first);
      const addon = uuidV7Schema.safeParse(pair.second);
      if (!service.success || !addon.success) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      return {
        intent: buying,
        targetId: service.data,
        secondaryId: addon.data,
        callbackQueryId: id,
      };
    }
    if (data.startsWith(USERNAME_CUSTOM_CALLBACK_PREFIX)) {
      return callbackCommand(
        'USERNAME_CUSTOM',
        data.slice(USERNAME_CUSTOM_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(USERNAME_AUTOMATIC_CALLBACK_PREFIX)) {
      return callbackCommand(
        'USERNAME_AUTOMATIC',
        data.slice(USERNAME_AUTOMATIC_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(DISCOUNT_CODE_ENTER_CALLBACK_PREFIX)) {
      return callbackCommand(
        'DISCOUNT_CODE_ENTER',
        data.slice(DISCOUNT_CODE_ENTER_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(DISCOUNT_CODE_REMOVE_CALLBACK_PREFIX)) {
      return callbackCommand(
        'DISCOUNT_CODE_REMOVE',
        data.slice(DISCOUNT_CODE_REMOVE_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_ACTION_CONFIRM_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_ACTION_CONFIRM',
        data.slice(SERVICE_ACTION_CONFIRM_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICES_PAGE_CALLBACK_PREFIX)) {
      /*
       * The one callback that carries a POSITION rather than an identifier.
       *
       * Decoded here, which is the same place `callbackCommand` validates a uuid and
       * for the same reason: a crafted token must be UNSUPPORTED at the boundary rather
       * than an invalid cast inside a query. Nothing is authorized by it — the list is
       * scoped to the tenant and to the customer resolved from the update — so the
       * decode is about shape, not trust.
       */
      const cursor = decodeKeysetToken(data.slice(SERVICES_PAGE_CALLBACK_PREFIX.length));
      if (cursor === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'SERVICES_PAGE', targetId: null, cursor, callbackQueryId: id };
    }
    if (data.startsWith(SERVICE_CALLBACK_PREFIX)) {
      return callbackCommand('SERVICE', data.slice(SERVICE_CALLBACK_PREFIX.length), id);
    }
    /*
     * The panel's three screens carry no target, so they match the WHOLE string — the
     * same rule the top-up menu states. The three that act carry one uuid and go
     * through `callbackCommand`, which validates it: a crafted id is UNSUPPORTED here
     * rather than a 500 at a cast, and an id belonging to another tenant finds nothing
     * because every repository read is tenant-scoped.
     */
    if (data === ADMIN_PANEL_CALLBACK_PREFIX) {
      return { intent: 'ADMIN_PANEL', targetId: null, callbackQueryId: id };
    }
    if (data === ADMIN_SERVICES_CALLBACK_PREFIX) {
      return { intent: 'ADMIN_SERVICES', targetId: null, callbackQueryId: id };
    }
    /*
     * The page branch FIRST, then the bare browse.
     *
     * `H:b` is a prefix of `H:b:<token>`, so the equality check below could not run
     * first without swallowing every paged tap. The queue's own `H:` is matched by
     * equality above and is unaffected by either.
     */
    if (data.startsWith(ADMIN_SERVICES_BROWSE_PAGE_CALLBACK_PREFIX)) {
      /*
       * Decoded HERE, for the reason `ADMIN_PANELS_PAGE_CALLBACK_PREFIX` states: a
       * crafted token must be UNSUPPORTED at the boundary rather than an invalid cast
       * inside a query. Nothing is authorized by it — the list is tenant-scoped and
       * `services.view` is charged in the handler — so the decode is about shape.
       */
      const cursor = decodeKeysetToken(
        data.slice(ADMIN_SERVICES_BROWSE_PAGE_CALLBACK_PREFIX.length),
      );
      if (cursor === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'ADMIN_SERVICES_BROWSE_PAGE', targetId: null, cursor, callbackQueryId: id };
    }
    if (data === ADMIN_SERVICES_BROWSE_CALLBACK_DATA) {
      return { intent: 'ADMIN_SERVICES_BROWSE', targetId: null, callbackQueryId: id };
    }
    if (data === ADMIN_PANELS_CALLBACK_PREFIX) {
      return { intent: 'ADMIN_PANELS', targetId: null, callbackQueryId: id };
    }
    if (data === ADMIN_REMINDERS_CALLBACK_PREFIX) {
      return { intent: 'ADMIN_REMINDERS', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(ADMIN_REMINDER_EDIT_CALLBACK_PREFIX)) {
      /*
       * The setting code, validated HERE against the closed map.
       *
       * `callback_data` is client-supplied text, so an unknown code must be UNSUPPORTED
       * at the boundary rather than a settings key assembled from it downstream. The
       * same rule the UUID paths above follow, for the same reason.
       */
      const code = data.slice(ADMIN_REMINDER_EDIT_CALLBACK_PREFIX.length);
      if (!isReminderSettingCode(code)) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      return { intent: 'ADMIN_REMINDER_EDIT', targetId: code, callbackQueryId: id };
    }
    if (data.startsWith(ADMIN_REMINDER_SET_CALLBACK_PREFIX)) {
      const [code, raw] = data.slice(ADMIN_REMINDER_SET_CALLBACK_PREFIX.length).split(':');
      /*
       * BOTH halves validated, and the value against the widest bound any of the five
       * keys declares rather than against the option list.
       *
       * The list is what a tap can produce; the bound is what the contract permits. A
       * value outside the bound is a crafted callback and is refused here; one inside
       * it but not on the list is still checked by the key's own schema and by the
       * combination guard, so nothing downstream trusts this number — it is only
       * stopped from being a string, a float or a megabyte of digits.
       */
      const value = raw === undefined ? Number.NaN : Number(raw);
      if (
        code === undefined ||
        !isReminderSettingCode(code) ||
        !Number.isInteger(value) ||
        value < USAGE_REMINDER_PERCENT_MIN ||
        value > USAGE_REMINDER_PERCENT_MAX
      ) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      return {
        intent: 'ADMIN_REMINDER_SET',
        targetId: code,
        args: [String(value)],
        callbackQueryId: id,
      };
    }
    if (data.startsWith(ADMIN_PANELS_PAGE_CALLBACK_PREFIX)) {
      /*
       * The panels section's own page button, decoded HERE for the reason
       * `SERVICES_PAGE_CALLBACK_PREFIX` states: a crafted token must be UNSUPPORTED at
       * the boundary rather than an invalid cast inside a query. Nothing is authorized
       * by it — the list is tenant-scoped and `panels.view` is charged in the handler
       * — so the decode is about shape, not trust.
       */
      const cursor = decodeKeysetToken(data.slice(ADMIN_PANELS_PAGE_CALLBACK_PREFIX.length));
      if (cursor === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'ADMIN_PANELS_PAGE', targetId: null, cursor, callbackQueryId: id };
    }
    if (data.startsWith(ADMIN_USERNAME_TOGGLE_CALLBACK_PREFIX)) {
      /*
       * `<field>:<value>:<panelId>`, all three validated HERE.
       *
       * `callback_data` is client-supplied text. An unknown field, a value that is
       * not one of the two, or a panel id that is not a uuid must be UNSUPPORTED at
       * the boundary rather than something assembled downstream — the same rule the
       * reminder codes above follow. The panel id itself is checked by
       * `callbackCommand`, which is why it is passed through it.
       */
      const [field, value, panelId] = data
        .slice(ADMIN_USERNAME_TOGGLE_CALLBACK_PREFIX.length)
        .split(':');
      if (
        field === undefined ||
        !isUsernameToggleField(field) ||
        (value !== '0' && value !== '1') ||
        panelId === undefined
      ) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      const command = callbackCommand('ADMIN_USERNAME_TOGGLE', panelId, id);
      return command.targetId === null ? command : { ...command, args: [field, value] };
    }
    if (data.startsWith(ADMIN_USERNAME_STRATEGY_CALLBACK_PREFIX)) {
      const [code, panelId] = data.slice(ADMIN_USERNAME_STRATEGY_CALLBACK_PREFIX.length).split(':');
      if (code === undefined || !isUsernameStrategyCode(code) || panelId === undefined) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      const command = callbackCommand('ADMIN_USERNAME_STRATEGY', panelId, id);
      return command.targetId === null ? command : { ...command, args: [code] };
    }
    for (const [prefix, intent] of ADMIN_PANEL_CALLBACKS) {
      if (data.startsWith(prefix)) return callbackCommand(intent, data.slice(prefix.length), id);
    }
    /*
     * The services section's id-carrying callbacks, all through `callbackCommand`.
     *
     * A table rather than nine `if`s, because nine near-identical branches is nine
     * chances to point a prefix at the wrong intent — and the one that matters is the
     * last row, where a mis-wiring would make the ASKING callback the destructive one.
     */
    const rotate = adminServiceRotateCommand(data, id);
    if (rotate !== null) return rotate;
    for (const [prefix, intent] of ADMIN_SERVICE_CALLBACKS) {
      if (data.startsWith(prefix)) return callbackCommand(intent, data.slice(prefix.length), id);
    }
    if (data === ADMIN_RECEIPTS_CALLBACK_PREFIX) {
      return { intent: 'ADMIN_RECEIPTS', targetId: null, callbackQueryId: id };
    }
    if (data === ADMIN_SECTION_CALLBACK_PREFIX) {
      return { intent: 'ADMIN_SECTION', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(ADMIN_RECEIPT_CALLBACK_PREFIX)) {
      return callbackCommand('ADMIN_RECEIPT', data.slice(ADMIN_RECEIPT_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(ADMIN_CREDIT_CALLBACK_PREFIX)) {
      return callbackCommand('ADMIN_CREDIT', data.slice(ADMIN_CREDIT_CALLBACK_PREFIX.length), id);
    }
    for (const [prefix, intent] of ADMIN_REFUND_REQUEST_CALLBACKS) {
      if (data.startsWith(prefix)) return callbackCommand(intent, data.slice(prefix.length), id);
    }
    if (data.startsWith(ADMIN_CREDIT_CONFIRM_CALLBACK_PREFIX)) {
      return callbackCommand(
        'ADMIN_CREDIT_CONFIRM',
        data.slice(ADMIN_CREDIT_CONFIRM_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(ADMIN_CREDIT_CANCEL_CALLBACK_PREFIX)) {
      return callbackCommand(
        'ADMIN_CREDIT_CANCEL',
        data.slice(ADMIN_CREDIT_CANCEL_CALLBACK_PREFIX.length),
        id,
      );
    }
    for (const [prefix, intent] of ADMIN_BLOCK_CALLBACKS) {
      if (data.startsWith(prefix)) return callbackCommand(intent, data.slice(prefix.length), id);
    }
    if (data.startsWith(ADMIN_APPROVE_CALLBACK_PREFIX)) {
      return callbackCommand('ADMIN_APPROVE', data.slice(ADMIN_APPROVE_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(ADMIN_REJECT_CALLBACK_PREFIX)) {
      return callbackCommand('ADMIN_REJECT', data.slice(ADMIN_REJECT_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(ADMIN_REVOKE_CALLBACK_PREFIX)) {
      return callbackCommand('ADMIN_REVOKE', data.slice(ADMIN_REVOKE_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(ADMIN_ADMIN_CALLBACK_PREFIX)) {
      return callbackCommand('ADMIN_ADMIN', data.slice(ADMIN_ADMIN_CALLBACK_PREFIX.length), id);
    }
    if (data === ADMIN_CUSTOMERS_CALLBACK_PREFIX) {
      return { intent: 'ADMIN_CUSTOMERS', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(ADMIN_CUSTOMERS_CALLBACK_PREFIX)) {
      /*
       * The same prefix carrying a POSITION, decoded HERE for the reason
       * `ADMIN_PANELS_PAGE_CALLBACK_PREFIX` states: a crafted token must be UNSUPPORTED
       * at the boundary rather than an invalid cast inside a query. The bare-prefix
       * branch above runs FIRST, so `8:` alone is never offered to the decoder.
       */
      const cursor = decodeKeysetToken(data.slice(ADMIN_CUSTOMERS_CALLBACK_PREFIX.length));
      if (cursor === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'ADMIN_CUSTOMERS_PAGE', targetId: null, cursor, callbackQueryId: id };
    }
    if (data.startsWith(ADMIN_CUSTOMER_CALLBACK_PREFIX)) {
      const [code, customerId] = data.slice(ADMIN_CUSTOMER_CALLBACK_PREFIX.length).split(':');
      if (code === undefined || !isAdminCustomerCode(code) || customerId === undefined) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      /*
       * The TABLE picks the intent. A chain of comparisons here would be the place a
       * read and a block could be transposed, and the uuid still goes through
       * `callbackCommand` so a malformed one is refused before either is chosen.
       */
      return callbackCommand(ADMIN_CUSTOMER_CODES[code], customerId, id);
    }
    if (data.startsWith(ADMIN_ADMIN_STATUS_CALLBACK_PREFIX)) {
      const [code, adminId] = data.slice(ADMIN_ADMIN_STATUS_CALLBACK_PREFIX.length).split(':');
      /*
       * The code is validated HERE, at the boundary, exactly as the username toggles
       * are: an unreadable callback is UNSUPPORTED and never becomes an intent, so the
       * handler receives one of the two statuses or is not reached. A cast downstream
       * would be a third place the vocabulary is spelled out.
       */
      if (code === undefined || !isAdminStatusCode(code) || adminId === undefined) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      const command = callbackCommand('ADMIN_ADMIN_STATUS', adminId, id);
      return command.targetId === null ? command : { ...command, args: [code] };
    }
    const categories = adminCategoryCommand(data, id);
    if (categories !== null) return categories;
    // Spec §7: the client apps section's callbacks, validated in their own module.
    const tutorials = adminTutorialCallback(data);
    if (tutorials !== null) return { ...tutorials, callbackQueryId: id };
    return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
  }

  /*
   * Spec §7: a VIDEO message. Offered only to an administrator's open «تنظیم ویدیو» prompt;
   * from anybody else it reaches `adminTurn`, resolves to no prompt or no administrator, and
   * is answered like any message this bot does not understand — which is what a video was.
   */
  const video = tutorialVideoOf((update as { message?: unknown } | null)?.message);
  if (video !== null) {
    return { intent: 'ADMIN_APP_VIDEO_UPLOAD', targetId: null, callbackQueryId: null, video };
  }
  /*
   * A FILE before the text, because a photo message has no `text` at all — Telegram
   * puts any accompanying words in `caption`, which this deliberately ignores.
   *
   * Reading through passthrough fields, as the rest of this function does: nothing about
   * the file is trusted as a fact about money, and an update whose file shape is not one
   * of the two this installation accepts falls through to the text path and then to
   * `UNSUPPORTED`, exactly as it did before this existed.
   */
  const file = receiptFileOf((update as { message?: unknown } | null)?.message);
  if (file !== null) {
    return { intent: 'RECEIPT_UPLOAD', targetId: null, callbackQueryId: null, file };
  }

  const text = (update as { message?: { text?: unknown } } | null)?.message?.text;
  if (typeof text !== 'string') return UNSUPPORTED;
  /*
   * A menu tap first, and it is matched on the WHOLE message rather than its first
   * word: the labels contain spaces, and `خرید اشتراک` split on whitespace is not a
   * command. Resolving to the slash command it stands for is what makes the button and
   * the command literally the same path rather than two that agree today.
   */
  const trimmed = text.trim();
  /*
   * R10 D2: an owner-defined button. The label map's VALUE is `mb:<id>` and that is all that
   * routes it: the typed text is looked up as a LABEL and never read as a value, so a customer
   * who types `mb:<id>` themselves reaches nothing (and a slash command is never a label).
   * A registry label wins a collision before this is reached, because `routesFor` never maps
   * a label that is already a registry one to a custom value.
   */
  const customId = trimmed.startsWith('/') ? null : customMenuIdOfRoute(menu.get(trimmed));
  if (customId !== null) {
    return { intent: 'CUSTOM_MENU_BUTTON', targetId: customId, callbackQueryId: null };
  }
  /*
   * A slash command is never a menu label (Codex, PR #111). Since R1 a tenant names its
   * buttons, and a button labelled `/start` would otherwise turn every `/start` — the
   * referral deep link's included — into whatever that button stands for.
   */
  const asCommand = trimmed.startsWith('/') ? trimmed : (menu.get(trimmed) ?? trimmed);
  const first = asCommand.split(/\s+/)[0]?.toLowerCase();
  // `/start@somebot` is what Telegram sends in a group. Stripped, because the bot it
  // names is the bot that received it.
  const command = first?.split('@')[0];
  if (command === '/start') {
    /*
     * TetraPay's `callback_url` is `https://t.me/<bot>?start=tp-<payment id>`. The payload is
     * parsed STRICTLY (`tp-` and a UUID) and names a payment only: ownership is decided on the
     * server when the screen is drawn, and an unknown or foreign one is answered as closed.
     */
    const returned = paymentIdOfTetrapayStart(startPayloadOf(update) ?? '');
    if (returned !== null) {
      return { intent: 'GATEWAY_RETURN', targetId: returned, callbackQueryId: null };
    }
    /*
     * Phase 4 PR-3 — a support-AI deep link (`sai-<flow>[-<uuid>]`): the Business chat's button
     * opens the bot's OWN flow for it, as its own button would. Parsed strictly; the id is only
     * an identifier — ownership, availability and every rule are decided by that flow's handler
     * exactly as for a tap, and nothing is done but showing its first screen.
     */
    const deepLink = supportAiStartCommandOf(startPayloadOf(update));
    if (deepLink !== null) return deepLink;
    return { intent: 'START', targetId: null, callbackQueryId: null };
  }
  if (command === '/catalog') return { intent: 'CATALOG', targetId: null, callbackQueryId: null };
  if (command === '/wallet') return { intent: 'WALLET', targetId: null, callbackQueryId: null };
  if (command === '/services') {
    return { intent: 'SERVICES', targetId: null, callbackQueryId: null };
  }
  /*
   * The command that makes the other four findable.
   *
   * `docs/phase4h-audit.md` §9: the bot answered four commands, registered none with
   * Telegram, and `bot.start.welcome` named only `/catalog` — so `/wallet` and
   * `/services` were reachable only by guessing. `BOT_COMMANDS` is what both this and
   * `setMyCommands` render, so the menu and the help cannot disagree.
   */
  if (command === '/help') return { intent: 'HELP', targetId: null, callbackQueryId: null };
  /*
   * `/paysupport` (Package A): Telegram requires a bot that sells for Stars to answer it.
   * It opens the same support screen the menu's support entry does — no new ticketing.
   */
  if (command === '/paysupport') {
    return { intent: 'SUPPORT', targetId: null, callbackQueryId: null };
  }
  /*
   * Round N close (§D): `/stop`, the command Telegram users know for "stop messaging me".
   * It stops MARKETING broadcasts and nothing else; the reply says so and offers the way back.
   */
  if (command === '/stop') {
    return { intent: 'MARKETING_OPT_OUT', targetId: null, callbackQueryId: null };
  }
  // WP-A7: the customer's support tickets — the menu's ticket button routes here.
  if (command === '/tickets') {
    return { intent: 'TICKETS', targetId: null, callbackQueryId: null };
  }
  /*
   * `/apps` and «📱 دانلود برنامه و آموزش اتصال» (WP-A10) open the connection guide's
   * platform choice — the same `TUTORIAL` the delivery card's «📚 مشاهده آموزش استفاده»
   * (`tu:`) opens, so there is one guide and three ways into it.
   */
  if (command === '/apps') return { intent: 'TUTORIAL', targetId: null, callbackQueryId: null };
  /*
   * R1: «🧪 دریافت سرویس تست» and «👥 زیرمجموعه‌گیری». Not registered with
   * `setMyCommands` (see `TRIAL_MENU_COMMAND`); reachable by the button and by typing, and
   * each answers from its feature's own state — the same two paths the pre-F5 catalogue
   * trial button (`tr:`) and wallet referral button (`rf:`) still take from old messages.
   */
  if (command === `/${TRIAL_MENU_COMMAND}`) {
    return { intent: 'TRIAL_CLAIM', targetId: null, callbackQueryId: null };
  }
  if (command === `/${REFERRAL_MENU_COMMAND}`) {
    return { intent: 'REFERRAL_INVITE', targetId: null, callbackQueryId: null };
  }
  /*
   * The management panel's three text entries (Phase 5T).
   *
   * `/admin` is deliberately NOT registered with `setMyCommands` — Telegram's command
   * list is per bot, not per user, so registering it would advertise the panel to every
   * customer. It is reachable by the keyboard button an administrator gets and by
   * typing it; both answer the same way, and a customer who types it resolves to no
   * administrator and gets this function's fallback.
   *
   * The two that carry arguments split on whitespace and validate nothing here: what
   * makes `123456789` a Telegram account and `owner` an administrator is a question for
   * the services that look them up.
   */
  if (command === `/${ADMIN_MENU_COMMAND}`) {
    return { intent: 'ADMIN_PANEL', targetId: null, callbackQueryId: null };
  }
  /*
   * Exact lookup, Phase 6A: `/service <id>`.
   *
   * A command carrying its argument rather than a prompt that captures the next
   * message, for the reason `/link` and `/role` state — INCIDENT-FIN-001 is what a
   * stateful prompt does when it outlives the question it was asked for. Not registered
   * with `setMyCommands` for the same reason `/admin` is not: the command list is per
   * bot rather than per user, so registering it would advertise the panel to every
   * customer.
   */
  if (command === '/service') {
    return {
      intent: 'ADMIN_SERVICE',
      targetId: null,
      args: asCommand.trim().split(/\s+/).slice(1),
      callbackQueryId: null,
    };
  }
  /*
   * `/panel_prefix <panel id> <prefix>` and `/panel_template <panel id> <template>`.
   *
   * Commands rather than a prompt, for the reason `/link` and `/role` state. The
   * template argument is joined back with single spaces AFTER the split, so a
   * template is one token in practice — and a template containing a space is refused
   * by the grammar anyway, since a space is not in the permitted character class.
   * Nothing is validated here: what makes a string a legal prefix or template is the
   * shared evaluator's question, and answering it twice is how two answers diverge.
   */
  if (command === '/panel_prefix' || command === '/panel_template') {
    const args = asCommand.trim().split(/\s+/).slice(1);
    return {
      intent: command === '/panel_prefix' ? 'ADMIN_USERNAME_PREFIX' : 'ADMIN_USERNAME_TEMPLATE',
      targetId: null,
      args,
      callbackQueryId: null,
    };
  }
  /*
   * Exact lookup, WP2: `/customer <telegram id>`.
   *
   * The numeric Telegram id, because that is what a support conversation quotes — not
   * the internal uuid, which nobody outside the Web Admin has ever seen. Nothing is
   * validated here: what makes a string a Telegram account is a question for the service
   * that looks it up, and the boundary splitting a command's words cannot know which of
   * them was meant to be an id.
   *
   * Not registered with `setMyCommands`, for the reason `/admin` and `/service` are not:
   * Telegram's command list is per bot rather than per user, so registering it would
   * advertise the management panel to every customer.
   */
  if (command === '/customer') {
    return {
      intent: 'ADMIN_CUSTOMER_FIND',
      targetId: null,
      args: asCommand.trim().split(/\s+/).slice(1),
      callbackQueryId: null,
    };
  }
  /*
   * `/category_new <name>`, `/category_rename <id> <name>`, `/category_emoji <id> <emoji>`.
   *
   * Commands carrying their argument, for the reason `/panel_prefix` states. Nothing is
   * validated here: a name's length and an emoji's shape are `ProductCategoryService`'s
   * questions, answered once for both surfaces. Not registered with `setMyCommands`, for
   * the reason `/admin` is not.
   */
  if (
    command === '/category_new' ||
    command === '/category_rename' ||
    command === '/category_emoji'
  ) {
    return {
      intent:
        command === '/category_new'
          ? 'ADMIN_CATEGORY_NEW'
          : command === '/category_rename'
            ? 'ADMIN_CATEGORY_RENAME'
            : 'ADMIN_CATEGORY_EMOJI',
      targetId: null,
      args: asCommand.trim().split(/\s+/).slice(1),
      callbackQueryId: null,
    };
  }
  if (command === '/link' || command === '/role') {
    const args = asCommand.trim().split(/\s+/).slice(1);
    return {
      intent: command === '/link' ? 'ADMIN_LINK' : 'ADMIN_ROLE',
      targetId: null,
      args,
      callbackQueryId: null,
    };
  }
  /*
   * Anything else MIGHT be a username, and only the database knows.
   *
   * This is the last branch on purpose: every command above is matched first, so a
   * `/start` typed while a window is open is still `/start`. The text is carried
   * UNTOUCHED — not trimmed, not lowercased — because `isValidCustomUsername` is asked
   * of the raw input and a surface that tidied it first would be deciding what the
   * customer typed.
   *
   * It is `USERNAME_TEXT` rather than `UNSUPPORTED` only as a routing label. The
   * handler asks whether a window is open and, for almost every message, is told no
   * and answers exactly as `UNSUPPORTED` always did.
   */
  return { intent: 'USERNAME_TEXT', targetId: null, args: [text], callbackQueryId: null };
}

const UNSUPPORTED: BotCommand = { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: null };

/**
 * The receipt inside a message, or null when there is not one.
 *
 * Two shapes and the list is closed, because `PAYMENT_RECEIPT_KINDS` is: a photo is
 * what most customers send and a document is what a banking app's PDF export produces.
 * Everything else a message can carry — a voice note, a location, a contact, a sticker,
 * a video — is NOT a receipt and is answered exactly as any other message this bot does
 * not understand.
 *
 * The photo arrives as an array of sizes. The LARGEST is chosen by `file_size`, and by
 * width where a size reports none: Telegram documents the array as ascending and
 * trusting that means trusting a client to order its own upload, which is the class of
 * assumption this file exists to avoid. A reviewer looking for a transfer reference
 * needs the biggest one there is.
 *
 * `file_size` is read as a NUMBER from the wire and carried as `bigint`, because it
 * reaches a `bigint` column and `payment_receipts_size_check` refuses a non-positive
 * one — so a zero or a negative becomes null here rather than a constraint violation
 * two layers down.
 */
function receiptFileOf(message: unknown): InboundReceiptFile | null {
  if (typeof message !== 'object' || message === null) return null;
  const record = message as Record<string, unknown>;
  const telegramMessageId =
    typeof record['message_id'] === 'number' && Number.isSafeInteger(record['message_id'])
      ? BigInt(record['message_id'])
      : null;

  const photo = record['photo'];
  if (Array.isArray(photo) && photo.length > 0) {
    const largest = largestPhoto(photo);
    if (largest !== null) {
      return {
        kind: 'PHOTO',
        fileId: largest.fileId,
        fileUniqueId: largest.fileUniqueId,
        // A photo size carries neither, and Telegram re-encodes it: claiming a type
        // this installation did not observe would be a fabricated fact about a file.
        mimeType: null,
        fileName: null,
        fileSize: largest.fileSize,
        telegramMessageId,
        // The customer's own caption, stored for the reviewer (D3) and never logged.
        caption: normalizeReceiptCaption(record['caption']),
      };
    }
  }

  const document = record['document'];
  if (typeof document === 'object' && document !== null) {
    const fields = document as Record<string, unknown>;
    const fileId = fields['file_id'];
    const fileUniqueId = fields['file_unique_id'];
    if (typeof fileId === 'string' && typeof fileUniqueId === 'string') {
      return {
        kind: 'DOCUMENT',
        fileId,
        fileUniqueId,
        mimeType: typeof fields['mime_type'] === 'string' ? fields['mime_type'] : null,
        fileName: typeof fields['file_name'] === 'string' ? fields['file_name'] : null,
        fileSize: positiveSize(fields['file_size']),
        telegramMessageId,
        caption: normalizeReceiptCaption(record['caption']),
      };
    }
  }
  return null;
}

/**
 * The biggest usable size in a `photo` array, ranked by PIXELS with bytes as the
 * tie-breaker.
 *
 * Two comparable numbers, never one of each. Ranking by `file_size` where it exists and
 * by width where it does not compares byte counts against pixel counts: a 5 KB thumbnail
 * ranks 5000 and a 1920-pixel original with no declared size ranks 1920, so the
 * thumbnail wins and the receipt an operator opens is unreadable. Telegram documents
 * `file_size` as optional on a `PhotoSize`, so that is not a hypothetical shape.
 *
 * Pixels first because they are what makes a receipt legible, and `width * height`
 * rather than width alone because a wide, short crop is not a bigger image. Bytes break
 * a tie only among equal dimensions, which is where they mean compression rather than
 * size.
 */
function largestPhoto(sizes: readonly unknown[]): {
  readonly fileId: string;
  readonly fileUniqueId: string;
  readonly fileSize: bigint | null;
} | null {
  let best: {
    fileId: string;
    fileUniqueId: string;
    fileSize: bigint | null;
    pixels: number;
    bytes: number;
  } | null = null;
  for (const candidate of sizes) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const fields = candidate as Record<string, unknown>;
    const fileId = fields['file_id'];
    const fileUniqueId = fields['file_unique_id'];
    if (typeof fileId !== 'string' || typeof fileUniqueId !== 'string') continue;
    const size = positiveSize(fields['file_size']);
    const width = dimension(fields['width']);
    const height = dimension(fields['height']);
    // A missing dimension is 1 rather than 0, so a size with no dimensions at all is
    // still comparable — ranked last among anything that declared them, not discarded.
    const pixels = Math.max(1, width) * Math.max(1, height);
    const bytes = size === null ? 0 : Number(size);
    if (best === null || pixels > best.pixels || (pixels === best.pixels && bytes > best.bytes)) {
      best = { fileId, fileUniqueId, fileSize: size, pixels, bytes };
    }
  }
  return best === null
    ? null
    : { fileId: best.fileId, fileUniqueId: best.fileUniqueId, fileSize: best.fileSize };
}

/** A declared pixel count, or 0. Non-integers and negatives are not dimensions. */
function dimension(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** A declared byte count, or null. Zero and negatives are null: the CHECK refuses them. */
function positiveSize(value: unknown): bigint | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? BigInt(value)
    : null;
}

/** A tap on a button, with its id checked before anything is asked to look it up. */
/**
 * R4 A1: `pk:<paymentId>.<sequence>`, validated here: a UUIDv7 and a sequence of at most four
 * digits. Anything else is UNSUPPORTED before a handler sees it.
 */
function paySwitchCardCommand(raw: string, callbackQueryId: string | null): BotCommand {
  const [rawId, rawSequence, ...rest] = raw.split('.');
  const parsed = uuidV7Schema.safeParse(rawId);
  if (
    rest.length > 0 ||
    !parsed.success ||
    rawSequence === undefined ||
    !/^\d{1,4}$/u.test(rawSequence)
  ) {
    return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId };
  }
  return {
    intent: 'PAY_SWITCH_CARD',
    targetId: parsed.data,
    secondaryId: String(Number(rawSequence)),
    callbackQueryId,
  };
}

function callbackCommand(
  intent: BotIntent,
  rawId: string,
  callbackQueryId: string | null,
): BotCommand {
  const parsed = uuidV7Schema.safeParse(rawId);
  if (!parsed.success) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId };
  return { intent, targetId: parsed.data, callbackQueryId };
}

/**
 * WP-A7 — the ticket desk's seven callbacks, or null when `data` is none of them. Every id is
 * validated here; anything malformed is UNSUPPORTED before a handler sees it.
 */
function ticketCallbackCommand(data: string, id: string | null): BotCommand | null {
  if (data === TICKETS_CALLBACK_DATA)
    return { intent: 'TICKETS', targetId: null, callbackQueryId: id };
  if (data === TICKET_NEW_CALLBACK_DATA) {
    return { intent: 'TICKET_NEW', targetId: null, callbackQueryId: id };
  }
  const routes: readonly (readonly [string, BotIntent])[] = [
    [TICKET_CATEGORY_CALLBACK_PREFIX, 'TICKET_CATEGORY'],
    [TICKET_VIEW_CALLBACK_PREFIX, 'TICKET_VIEW'],
    [TICKET_REPLY_CALLBACK_PREFIX, 'TICKET_REPLY'],
    [TICKET_CLOSE_ASK_CALLBACK_PREFIX, 'TICKET_CLOSE_ASK'],
    [TICKET_CLOSE_CALLBACK_PREFIX, 'TICKET_CLOSE'],
  ];
  for (const [prefix, intent] of routes) {
    if (data.startsWith(prefix)) return callbackCommand(intent, data.slice(prefix.length), id);
  }
  return null;
}

/**
 * The categories section's five callbacks, or null when `data` is none of them.
 *
 * Every payload is validated HERE and nowhere later: a page through `parseCatalogPage`,
 * an id through `uuidV7Schema`, a code through `ADMIN_CATEGORY_CODES`, a pair through
 * `decodeIdPair` and then both halves as UUIDv7s, a product-list position through
 * `decodeKeysetToken`. Anything that fails is UNSUPPORTED, so a handler receives a
 * well-formed command or is not reached — and none of this authorizes anything: the
 * service charges the permission.
 */
function adminCategoryCommand(data: string, id: string | null): BotCommand | null {
  const unsupported: BotCommand = { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
  if (data.startsWith(ADMIN_CATEGORIES_CALLBACK_PREFIX)) {
    const page = parseCatalogPage(data.slice(ADMIN_CATEGORIES_CALLBACK_PREFIX.length));
    return page === null
      ? unsupported
      : { intent: 'ADMIN_CATEGORIES', targetId: null, page, callbackQueryId: id };
  }
  if (data.startsWith(ADMIN_CATEGORY_CALLBACK_PREFIX)) {
    const [code, categoryId, ...rest] = data
      .slice(ADMIN_CATEGORY_CALLBACK_PREFIX.length)
      .split(':');
    if (code === undefined || !isAdminCategoryCode(code) || categoryId === undefined) {
      return unsupported;
    }
    return rest.length > 0
      ? unsupported
      : callbackCommand(ADMIN_CATEGORY_CODES[code], categoryId, id);
  }
  if (data.startsWith(ADMIN_CATEGORY_PRODUCTS_CALLBACK_PREFIX)) {
    const raw = data.slice(ADMIN_CATEGORY_PRODUCTS_CALLBACK_PREFIX.length);
    if (raw === '') {
      return {
        intent: 'ADMIN_CATEGORY_PRODUCTS',
        targetId: null,
        cursor: null,
        callbackQueryId: id,
      };
    }
    const cursor = decodeKeysetToken(raw);
    return cursor === null
      ? unsupported
      : { intent: 'ADMIN_CATEGORY_PRODUCTS', targetId: null, cursor, callbackQueryId: id };
  }
  if (data.startsWith(ADMIN_CATEGORY_PICK_CALLBACK_PREFIX)) {
    const [rawId, rawPage, ...rest] = data
      .slice(ADMIN_CATEGORY_PICK_CALLBACK_PREFIX.length)
      .split('.');
    const page = rawPage === undefined ? null : parseCatalogPage(rawPage);
    const product = uuidV7Schema.safeParse(rawId);
    if (rest.length > 0 || page === null || !product.success) return unsupported;
    return { intent: 'ADMIN_CATEGORY_PICK', targetId: product.data, page, callbackQueryId: id };
  }
  if (data.startsWith(ADMIN_CATEGORY_ASSIGN_CALLBACK_PREFIX)) {
    const pair = decodeIdPair(data.slice(ADMIN_CATEGORY_ASSIGN_CALLBACK_PREFIX.length));
    if (pair === null) return unsupported;
    const product = uuidV7Schema.safeParse(pair.first);
    const category = uuidV7Schema.safeParse(pair.second);
    if (!product.success || !category.success) return unsupported;
    return {
      intent: 'ADMIN_CATEGORY_ASSIGN',
      targetId: product.data,
      secondaryId: category.data,
      callbackQueryId: id,
    };
  }
  return null;
}

/**
 * The customer's chat id for a private conversation.
 *
 * Telegram's private chat id IS the user id, but the update carries both and they can
 * differ — in a group, `chat.id` is the group. A reply to a group chat would publish a
 * customer's balance to everyone in it, so this prefers the chat id only when the chat
 * is private and otherwise has no answer.
 */
export function privateChatIdOf(update: unknown): string | null {
  const shaped = update as {
    message?: { chat?: { id?: unknown; type?: unknown } };
    // A tapped button carries the message it was attached to, and that message carries
    // the chat. Read second, so a real `message` still wins for an ordinary command.
    callback_query?: { message?: { chat?: { id?: unknown; type?: unknown } } };
  } | null;
  const chat = shaped?.message?.chat ?? shaped?.callback_query?.message?.chat;
  if (chat === undefined || chat === null) return null;
  if (chat.type !== 'private') return null;
  return typeof chat.id === 'number' || typeof chat.id === 'string' ? String(chat.id) : null;
}

/**
 * Whether this update is a tapped inline button (a `callback_query`), whatever its data.
 * Read through the passthrough fields, as `intentOf` does.
 */
export function isCallbackQueryUpdate(update: unknown): boolean {
  const callback = (update as { callback_query?: unknown } | null)?.callback_query;
  return typeof callback === 'object' && callback !== null;
}
