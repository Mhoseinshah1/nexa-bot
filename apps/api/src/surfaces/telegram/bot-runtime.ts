import {
  COMMERCE_ERROR_CODES,
  isNexaError,
  currencyCodeSchema,
  money,
  uuidV7Schema,
} from '@nexa/contracts';
import type {
  ActorContext,
  BotInstanceId,
  CustomerArrival,
  Money,
  OrderId,
  TemplateKey,
  TemplateValues,
  TenantContext,
} from '@nexa/contracts';
import type { CustomerService } from '../../modules/commerce/customers/application/customer.service.js';
import type {
  CustomerButton,
  CustomerSendOutcome,
  CustomerMessenger,
} from '../../modules/commerce/messaging/application/ports.js';
import type { CustomerRecord } from '../../modules/commerce/customers/application/ports.js';
import type { ProductService } from '../../modules/commerce/catalog/application/product.service.js';
import type { CommercialActionService } from '../../modules/commerce/commercial/application/commercial-action.service.js';
import type { OrderService } from '../../modules/commerce/orders/application/order.service.js';
import type { PaymentService } from '../../modules/commerce/payments/application/payment.service.js';
import type { WalletService } from '../../modules/commerce/wallet/application/wallet.service.js';
import { ProvisioningService } from '../../modules/commerce/provisioning/application/provisioning.service.js';
import type { CustomerServiceOperation } from '../../modules/commerce/provisioning/application/provisioning.service.js';
import type { DeliveryService } from '../../modules/commerce/provisioning/application/delivery.service.js';
import type { ServiceRecord } from '../../modules/commerce/provisioning/application/ports.js';

/**
 * What the customer asked for.
 *
 * A tiny closed vocabulary rather than a parsed command string, decided at the
 * boundary and never passed onward as text. Phase 4A handles `/start` and answers
 * everything else with the unsupported-input fallback; later subphases add members.
 *
 * There is no FSM and no conversation state. The legacy system's prompt capture
 * swallowed an ordinary message and overwrote a production gateway setting
 * (INCIDENT-FIN-001), which is what a stateful prompt does when it outlives the
 * question it was asked for.
 */
export const BOT_INTENTS = [
  'START',
  'CATALOG',
  'ORDER',
  'CONFIRM',
  'WALLET',
  'PAY_WALLET',
  'PAY_MANUAL',
  'PAY_GATEWAY',
  'PAY_CANCEL_ASK',
  'PAY_CANCEL',
  'SERVICES',
  'SERVICE',
  'SERVICE_RESEND',
  'SERVICE_SUSPEND',
  'SERVICE_RESUME',
  'SERVICE_TERMINATE_ASK',
  'SERVICE_TERMINATE',
  'SERVICE_RENEW',
  'SERVICE_ADD_TRAFFIC',
  'SERVICE_ADD_TIME',
  'SERVICE_BUY_TRAFFIC',
  'SERVICE_BUY_TIME',
  'SERVICE_ACTION_CONFIRM',
  'HELP',
  'UNSUPPORTED',
] as const;
export type BotIntent = (typeof BOT_INTENTS)[number];

/**
 * The intent and the ONE id it refers to.
 *
 * `ORDER` and `CONFIRM` arrive as button taps and name a product or an order. The id is
 * carried as a separate, VALIDATED field rather than as the raw callback string, so
 * nothing downstream re-parses it — and it is checked as a UUID here, at the boundary,
 * because `callback_data` is client-supplied text and a customer can send any of it.
 *
 * This is not conversation state. There is still no FSM: everything the runtime needs is
 * in the update it is handling, which is what makes a redelivery a replay instead of a
 * step in a half-finished dialogue. INCIDENT-FIN-001 is what a stateful prompt does when
 * it outlives the question it was asked for.
 */
export interface BotCommand {
  readonly intent: BotIntent;
  readonly targetId: string | null;
  /**
   * A SECOND identifier, for the one callback that needs two.
   *
   * Buying a package names both the service it is for and the package itself, and
   * neither can be inferred from the other: the customer owns the service and CHOOSES
   * the package. With no conversation state there is nowhere else to keep the first
   * while they pick the second — that absence is deliberate, and `INCIDENT-FIN-001` is
   * what a stateful prompt does when it outlives its question.
   *
   * Still an identifier and never a quantity. `encodeIdPair` is what makes two of them
   * fit in Telegram's 64 bytes, and both come back through the same UUID validation the
   * single-id path uses.
   */
  readonly secondaryId?: string | null;
  /** Telegram's id for the tapped button, so the spinner can be stopped. */
  readonly callbackQueryId: string | null;
}

/**
 * Two UUIDs in 45 bytes, because `callback_data` holds 64 and two of them spell 73.
 *
 * Raw base64url of the thirty-two bytes the pair actually is — not hex, which spells
 * sixty-six and still would not fit, and not a shortened id, which would stop being the
 * id. An encoding, not a token: it carries no authority, it is not signed, and nothing
 * downstream trusts it. Both halves are re-validated as UUIDs and then checked against
 * rows — the service against the customer who owns it, the package against the kind the
 * path is for.
 *
 * `callback_ref`, the registry table Phase 0 planned for exactly this, was dropped by
 * `0002_drop_callback_refs` for having no producer and no reader. This needs no row: the
 * two ids ARE the message, so there is nothing to look up.
 */
export function encodeIdPair(first: string, second: string): string {
  const bytes = Buffer.concat([uuidBytes(first), uuidBytes(second)]);
  return bytes.toString('base64url');
}

export function decodeIdPair(encoded: string): { first: string; second: string } | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, 'base64url');
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  return { first: uuidFrom(bytes.subarray(0, 16)), second: uuidFrom(bytes.subarray(16, 32)) };
}

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function uuidFrom(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The callback-data prefixes. One letter each, because Telegram caps `callback_data` at
 * 64 BYTES and a UUID is 36 of them.
 */
export const ORDER_CALLBACK_PREFIX = 'p:';
export const CONFIRM_CALLBACK_PREFIX = 'c:';
/**
 * The payment-method taps. Each names an ORDER and nothing else.
 *
 * That is the trust boundary, not an encoding detail: a callback is an INTENT and an
 * IDENTIFIER, never a quantity. There is no prefix here that could carry an amount, a
 * currency or a customer, so a modified client has nothing to tamper with beyond the
 * order id — and an id that is not theirs, or not awaiting payment, fails at MUTATION
 * time against the row rather than at render time against what the tap claimed.
 */
export const WALLET_PAY_CALLBACK_PREFIX = 'w:';
export const MANUAL_PAY_CALLBACK_PREFIX = 'm:';
/**
 * A rail this installation does not have.
 *
 * The button is NOT drawn — `paymentButtons` offers only what can be performed — and the
 * prefix exists anyway, because a customer holding an older message can still tap one.
 * Answering it with `bot.payment.unconfigured` is the honest reply; letting it fall
 * through to `bot.unknown_command` would tell them they typed something wrong.
 */
export const GATEWAY_PAY_CALLBACK_PREFIX = 'g:';

/**
 * Withdrawing a pending out-of-band payment. It names the PAYMENT, not the order.
 *
 * The only customer callback in this file that carries a payment id, and it has to: a
 * withdrawal names the thing being withdrawn, and an order can have had several
 * payments over its life. The id is still only an IDENTIFIER — the owner, the state and
 * the money are all re-read inside the transaction, which is what makes a guessed id
 * useless rather than dangerous.
 */
export const CANCEL_PAY_ASK_CALLBACK_PREFIX = 'x:';

/**
 * The second tap, and the only prefix that actually withdraws anything.
 *
 * TWO taps, because the first one sits on the message that told the customer to go and
 * transfer money and that message stays in their chat for ever. A customer who has
 * already paid and mis-touches it would otherwise have closed the payment their
 * transfer was against — permanently, since `PAYMENT_MACHINE` has no edge out of
 * `CANCELLED` and migration 0052 freezes the row — and nothing would tell the operator.
 *
 * `SERVICE_TERMINATE_ASK_CALLBACK_PREFIX` and its partner are the same pair for the
 * same reason, and that precedent is why this is not an invention: a destructive tap a
 * customer can reach by scrolling is asked about, not performed.
 */
export const CANCEL_PAY_CALLBACK_PREFIX = 'z:';
/**
 * A tap on one of the customer's own services, and a request to send its link again.
 *
 * Both name a SERVICE id and nothing else, which is the same trust boundary the payment
 * prefixes state: a callback is an intent and an identifier, never a quantity and never
 * a subscription. The link a resend produces is read from the row, so a modified client
 * has nothing to tamper with beyond the id — and an id that is not theirs fails at
 * `getForCustomer`, against the row, with the same answer an id that does not exist
 * gets.
 */
export const SERVICE_CALLBACK_PREFIX = 's:';
export const SERVICE_RESEND_CALLBACK_PREFIX = 'r:';

/**
 * The three management actions, and the two halves of ending a service.
 *
 * Four prefixes for three operations, because TERMINATE is TWO taps: `t:` opens the
 * confirmation and `k:` is the only callback in this surface that plans one. Nothing
 * about which operation to perform is parsed out of the payload — the type is decided
 * by WHICH prefix matched, and each is a fixed two-character string. A modified client
 * can change the id after the colon and nothing else, and an id that is not theirs is
 * refused against the row.
 *
 * The letters are arbitrary, as `p:` for an order and `c:` for a confirmation already
 * are; what matters is that no prefix is a prefix of another, which `intentOf` relies
 * on and a unit test pins.
 */
export const SERVICE_SUSPEND_CALLBACK_PREFIX = 'u:';
export const SERVICE_RESUME_CALLBACK_PREFIX = 'e:';
export const SERVICE_TERMINATE_ASK_CALLBACK_PREFIX = 't:';
export const SERVICE_TERMINATE_CALLBACK_PREFIX = 'k:';
/*
 * The five commercial prefixes.
 *
 * `n:`, `v:` and `h:` each open a QUOTE and buy nothing — they name a service. `a:` and
 * `b:` name a service AND a package, and they are TWO prefixes rather than one because
 * the KIND has to come from which button was pressed: with one shared prefix the kind
 * would have to be read off the package the customer chose, and then the check that an
 * `ADD_TIME` package cannot be bought through the extra-traffic path would be checking
 * a value against itself. `q:` names the order the quote produced and is the only one
 * that commits.
 *
 * None of them carries a price, a quantity or a duration, which is the rule the whole
 * prefix table exists to make structural: a callback is an intent and an identifier.
 * `v:` and `h:` are single letters for the reason the others are — `callback_data` is
 * capped at 64 bytes and a UUID is 36 of them.
 */
export const SERVICE_RENEW_CALLBACK_PREFIX = 'n:';
export const SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX = 'v:';
export const SERVICE_ADD_TIME_CALLBACK_PREFIX = 'h:';
export const SERVICE_BUY_TRAFFIC_CALLBACK_PREFIX = 'a:';
export const SERVICE_BUY_TIME_CALLBACK_PREFIX = 'b:';
export const SERVICE_ACTION_CONFIRM_CALLBACK_PREFIX = 'q:';

/**
 * How many services one `/services` answer shows.
 *
 * A BOUND, not a page, and stated for the same reason `CATALOG_PAGE_SIZE` is: a customer
 * with more than twenty services sees twenty and is told nothing about the rest. How a
 * customer reaches a long list over Telegram is a product decision with no evidence
 * behind it in `docs/research/`, and `docs/open-questions.md` carries it rather than
 * this file guessing.
 */
export const SERVICES_PAGE_SIZE = 20;

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
export function intentOf(update: unknown): BotCommand {
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
    if (data.startsWith(GATEWAY_PAY_CALLBACK_PREFIX)) {
      return callbackCommand('PAY_GATEWAY', data.slice(GATEWAY_PAY_CALLBACK_PREFIX.length), id);
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
    /*
     * The resend prefix is tested BEFORE the service prefix.
     *
     * `'r:'` and `'s:'` share no first character, so today the order is irrelevant — it
     * is fixed anyway because the failure it prevents is silent: a prefix that is a
     * prefix of another routes every tap to whichever branch comes first, and the
     * customer gets the wrong screen with nothing anywhere saying so.
     */
    if (data.startsWith(SERVICE_RESEND_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_RESEND',
        data.slice(SERVICE_RESEND_CALLBACK_PREFIX.length),
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
     * The ASK prefix is tested before the TERMINATE prefix, and they are different
     * letters so the order cannot matter today. It is fixed anyway for the reason the
     * resend/service pair states: if one ever became a prefix of the other, every tap
     * would route to whichever branch came first — and here that would be the
     * difference between showing a customer a question and deleting their account.
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
    if (data.startsWith(SERVICE_ACTION_CONFIRM_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_ACTION_CONFIRM',
        data.slice(SERVICE_ACTION_CONFIRM_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_CALLBACK_PREFIX)) {
      return callbackCommand('SERVICE', data.slice(SERVICE_CALLBACK_PREFIX.length), id);
    }
    return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
  }

  const text = (update as { message?: { text?: unknown } } | null)?.message?.text;
  if (typeof text !== 'string') return UNSUPPORTED;
  const first = text.trim().split(/\s+/)[0]?.toLowerCase();
  // `/start@somebot` is what Telegram sends in a group. Stripped, because the bot it
  // names is the bot that received it.
  const command = first?.split('@')[0];
  if (command === '/start') return { intent: 'START', targetId: null, callbackQueryId: null };
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
  return UNSUPPORTED;
}

const UNSUPPORTED: BotCommand = { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: null };

/** A tap on a button, with its id checked before anything is asked to look it up. */
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

export interface BotRuntimeDeps {
  readonly customers: CustomerService;
  readonly messenger: CustomerMessenger;
  readonly products: ProductService;
  readonly commercial: CommercialActionService;
  readonly orders: OrderService;
  readonly payments: PaymentService;
  readonly wallet: WalletService;
  readonly services: ProvisioningService;
  readonly delivery: DeliveryService;
  /**
   * The plan a service was SOLD as, from the order's frozen snapshot.
   *
   * A narrow port rather than `OrderService`, for the reason the provisioner's
   * `PurchaseSnapshotReader` gives one: handing this surface the order service would
   * also hand a customer-facing runtime the ability to confirm and cancel orders.
   *
   * From the ORDER and never from the product. `nexa_orders_snapshot_guard` froze the
   * title at confirmation, so it is the only copy that still says what the customer
   * agreed to — a product renamed since would otherwise rewrite what somebody was
   * told they bought, which is the legacy defect where renaming a product rewrote
   * past reports, applied to something the customer can read back.
   */
  readonly purchaseTitle: (scope: TenantContext, orderId: OrderId) => Promise<string | null>;
}

/**
 * What a handled update produced.
 *
 * Returned rather than logged, so the webhook controller decides what to do with it and
 * the tests can assert it. `sent` is deliberately not a boolean: a reply that may or may
 * not have arrived is a third thing, and the messenger already distinguishes it.
 */
export interface BotTurnResult {
  readonly intent: BotIntent;
  readonly arrival: CustomerArrival | null;
  readonly customerId: string | null;
  readonly replyKey: TemplateKey | null;
  /** The order this turn created or confirmed, when it was one of those. */
  readonly orderId: string | null;
  readonly sent: CustomerSendOutcome | 'NOT_ATTEMPTED';
}

/**
 * A reply that has been decided and not yet sent.
 *
 * Assembled BEFORE any network call, so the whole turn is: commit, decide, send. A
 * branch that sent from inside its own decision would be a second send path, and the
 * `resolve -> commit -> reply` order is the one rule this surface exists to keep.
 */
interface PendingReply {
  readonly key: TemplateKey | null;
  readonly values: TemplateValues;
  readonly buttons: readonly CustomerButton[];
  readonly orderId: string | null;
}

/**
 * A refusal the customer can be told about.
 *
 * The three product codes collapse to ONE message, deliberately: the operational log and
 * the Web Admin name which of withdrawn, unpriced and unbound it was, and the customer
 * can act on none of them. "This plan has no panel" tells them about our configuration.
 *
 * Anything NOT in this map is re-thrown. That is the important half — a bug in the order
 * path must not be reported to a customer as "this is unavailable", which would make
 * every failure look like an ordinary product state and leave nothing in the operational
 * log. The webhook's catch records it and still answers 200.
 */
const REFUSAL_REPLIES: Readonly<Record<string, TemplateKey>> = {
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_PURCHASABLE]: 'bot.order.unavailable',
  // The SAME sentence as the others, deliberately. A customer told "this is for
  // resellers" learns a tenant's pricing structure from a refusal.
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_FOR_AUDIENCE]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_PRICED]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_FULFILLABLE]: 'bot.order.unavailable',
  // An order that is gone, or that belongs to somebody else — the service answers both
  // the same way on purpose, so this does too.
  [COMMERCE_ERROR_CODES.ORDER_NOT_FOUND]: 'bot.order.unavailable',
  /*
   * The ORDER, not the product. `bot.order.unavailable` says a PLAN cannot be bought,
   * and the ordinary way to reach this code is a customer tapping the pay button a
   * second time on the message they just paid from — the buttons stay in the chat
   * after settlement. Telling somebody who has just been debited that their service is
   * unavailable is the class of untruth 4C rewrote `bot.order.settled` to remove.
   */
  [COMMERCE_ERROR_CODES.ORDER_STATE_INVALID]: 'bot.order.not_awaiting_payment',
  [COMMERCE_ERROR_CODES.ORDER_EXPIRED]: 'bot.order.expired',
  // Reachable despite the surface's own check: an operator can block a customer between
  // the resolve and the order write, and the service refuses it inside the transaction.
  [COMMERCE_ERROR_CODES.CUSTOMER_BLOCKED]: 'bot.blocked',
  /*
   * A rail this installation cannot perform. NAMED rather than hidden — the button is
   * not drawn, and a customer holding an older message still gets a sentence that says
   * what happened instead of "unknown command".
   */
  [COMMERCE_ERROR_CODES.PAYMENT_METHOD_UNAVAILABLE]: 'bot.payment.unconfigured',
  /*
   * The order is still live and this rail cannot be used inside what is left of it.
   *
   * Its own key rather than `bot.order.expired`, because the two say different things
   * to the same customer: that one means the window has closed, this one means it is
   * about to and a transfer started now could not be confirmed afterwards. The remedy
   * is the same — order again — and saying which is which is what stops a customer
   * transferring money against a reference that dies before it arrives.
   */
  [COMMERCE_ERROR_CODES.PAYMENT_WINDOW_TOO_SHORT]: 'bot.payment.window_too_short',
  [COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND]: 'bot.order.unavailable',
  /*
   * The payment, not the order. Its own key since 4G made the state reachable.
   *
   * A customer meets this by scrolling back to a message that was live when it was
   * sent and pressing the button on it — after the sweep expired the payment, after an
   * operator rejected it, or after they withdrew it themselves. Answering "this service
   * is not available" reads as a fault in the product; saying the payment is no longer
   * pending says what happened.
   */
  [COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID]: 'bot.payment.not_pending',
  /*
   * The guard refused. ONE sentence for every reason it gives, exactly as the product
   * refusals collapse: the customer can act on none of "the amount does not match", "the
   * currency does not match" and "another customer's payment", and each of them tells
   * them something about our data. The `reason` detail is in the audit row and the
   * operational log, which is where it is useful.
   */
  [COMMERCE_ERROR_CODES.SETTLEMENT_NOT_FUNDED]: 'bot.order.unavailable',
  /*
   * This entry is for `WALLET_CURRENCY_UNSUPPORTED`, and the comment here used to
   * describe a DIFFERENT code — it explained a fallback for
   * `WALLET_INSUFFICIENT_FUNDS`, which is not the key below and is not in this map.
   *
   * What is actually true of each:
   *
   * - `WALLET_INSUFFICIENT_FUNDS` is answered inside `walletPayment`, because
   *   `bot.wallet.insufficient` renders the shortfall and this map carries no values.
   *   It has NO entry here, so if that handler could not read the shortfall the turn
   *   would reach `refusal`'s `throw` and the customer would get no reply. It cannot
   *   today: the service always attaches a positive `shortfallMinor` bounded by
   *   `PAYMENT_AMOUNT_MAX_MINOR` and a valid `currency`, which is exactly what
   *   `shortfallOf` parses. Left as is rather than given a key that would exist for an
   *   unreachable branch — but stated, because the previous comment implied a
   *   protection that is not here.
   * - `WALLET_CURRENCY_UNSUPPORTED` has no Telegram producer at all: only
   *   `WalletService.adjust` raises it and no customer path calls that. It stays
   *   listed because an unlisted code is the failure mode, not a tidy absence.
   */
  [COMMERCE_ERROR_CODES.WALLET_CURRENCY_UNSUPPORTED]: 'bot.order.unavailable',
  /*
   * The commercial refusals, split exactly where the CUSTOMER's next step differs.
   *
   * `SERVICE_ACTION_NOT_ALLOWED` is the service's own state — a terminated service
   * cannot be renewed, a suspended one cannot be topped up — and that is something the
   * customer can act on, so it says so.
   *
   * `SERVICE_ACTION_UNAVAILABLE` and the two add-on refusals are CONFIGURATION: nothing
   * is offered, the plan was withdrawn, the package was deactivated between the list
   * and the tap. One sentence for all three, because the customer's next step is the
   * same and naming which would describe an operator's configuration to them — the same
   * reasoning `PRODUCT_NOT_FOR_AUDIENCE` follows above. The operational log and the
   * audit row carry the distinction an operator needs.
   *
   * `PANEL_NOT_OPERABLE` used to be absent here, with a comment saying it "stays with
   * 4E's `bot.service.capability_unsupported`". That was FALSE, and the falsehood is
   * worth recording because it is the shape this map exists to prevent: 4E answers the
   * code inside `serviceAction`, which the commercial handlers never pass through. They
   * go to `refusal`, an unmapped code reaches its `throw`, and the customer who tapped
   * a renewal button drawn before the operator disabled the panel got no reply at all —
   * the exact "unknown code, no answer" failure the `WALLET_INSUFFICIENT_FUNDS` note
   * above spells out. It is the SAME sentence 4E uses, reached the ordinary way.
   *
   * `SERVICE_ACTION_IN_PROGRESS` is the one TRANSIENT refusal in this group and gets
   * its own sentence for that reason: every other answer here means "not for you" or
   * "not offered", and this one means "try again in a moment". Telling a customer whose
   * renewal is seconds from being applied that the action is unavailable would send
   * them to support over a wait.
   */
  [COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED]: 'bot.service.action_not_allowed',
  [COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE]: 'bot.service.action_unavailable',
  [COMMERCE_ERROR_CODES.ADDON_NOT_FOUND]: 'bot.service.action_unavailable',
  [COMMERCE_ERROR_CODES.ADDON_NOT_PURCHASABLE]: 'bot.service.action_unavailable',
  [COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE]: 'bot.service.capability_unsupported',
  [COMMERCE_ERROR_CODES.SERVICE_ACTION_IN_PROGRESS]: 'bot.service.action_in_progress',
  /*
   * A renewal priced in a unit this store has stopped selling.
   *
   * Reachable from a callback drawn before `sales.currency` moved: `availableFor` and
   * `offer` both filter on it now, and neither un-draws a message already in the chat.
   * The configuration sentence, because that is what it is.
   */
  [COMMERCE_ERROR_CODES.PRODUCT_CURRENCY_UNSUPPORTED]: 'bot.service.action_unavailable',
};

function refusal(error: unknown): PendingReply {
  const key = isNexaError(error) ? REFUSAL_REPLIES[error.code] : undefined;
  if (key === undefined) throw error;
  return { key, values: {}, buttons: [], orderId: null };
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
  constructor(private readonly deps: BotRuntimeDeps) {}

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
    const command = intentOf(input.update);
    const { intent } = command;

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
    const { customer, arrival } = await this.deps.customers.resolveFromUpdate(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      telegramUserId: input.telegramUserId,
      from: input.from,
      botInstanceId: input.botInstanceId,
    });

    /*
     * 2. The commercial work, still before any send.
     *
     * A BLOCKED customer never reaches it: `replyFor` answers `bot.blocked` whatever
     * they asked for, and this is gated on the same condition rather than on its own
     * copy of the rule. The order service refuses a blocked customer too — that is the
     * authoritative check, inside the transaction, and this one exists so the surface
     * does not ask for work it already knows will be refused.
     */
    const reply =
      arrival === 'BLOCKED'
        ? { key: 'bot.blocked' as TemplateKey, values: {}, buttons: [], orderId: null }
        : await this.act(scope, actor, command, customer, arrival, input);

    const chatId = privateChatIdOf(input.update);

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
     */
    if (reply.key === null || chatId === null) {
      await this.stopSpinner(scope, command, input.botInstanceId);
      return {
        intent,
        arrival,
        customerId: customer.id,
        replyKey: reply.key,
        orderId: reply.orderId,
        sent: 'NOT_ATTEMPTED',
      };
    }

    const sent = await this.deps.messenger.send(scope, {
      chatId,
      templateKey: reply.key,
      values: reply.values,
      botInstanceId: input.botInstanceId,
      ...(reply.buttons.length === 0 ? {} : { buttons: reply.buttons }),
    });

    // After the real answer, not before it. The spinner is cosmetic and its failure is
    // silent; putting it first would let a slow acknowledgement delay the message the
    // customer is actually waiting for.
    await this.stopSpinner(scope, command, input.botInstanceId);

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
   * What this intent produces, as a reply that has not been sent yet.
   *
   * Every branch returns; there is no fallthrough that leaves a customer unanswered,
   * which is the failure mode the legacy bot has for anything it does not recognise.
   */
  private async act(
    scope: TenantContext,
    actor: ActorContext,
    command: BotCommand,
    customer: CustomerRecord,
    arrival: CustomerArrival,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
    },
  ): Promise<PendingReply> {
    if (command.intent === 'CATALOG') return this.catalogue(scope, actor);
    if (command.intent === 'ORDER' && command.targetId !== null) {
      return this.draft(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    if (command.intent === 'CONFIRM' && command.targetId !== null) {
      return this.confirm(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    if (command.intent === 'WALLET') return this.walletBalance(scope, actor, customer);
    if (command.intent === 'PAY_WALLET' && command.targetId !== null) {
      return this.walletPayment(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    if (command.intent === 'PAY_MANUAL' && command.targetId !== null) {
      return this.manualPayment(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    /*
     * A rail with no adapter, answered rather than simulated.
     *
     * No button offers it — `paymentButtons` draws only what can be performed — so this
     * is reached by a customer holding an older message, and it is the one place that
     * answer is produced. Nothing here pretends money moved.
     */
    if (command.intent === 'PAY_GATEWAY') {
      return { key: 'bot.payment.unconfigured', values: {}, buttons: [], orderId: null };
    }
    if (command.intent === 'PAY_CANCEL_ASK' && command.targetId !== null) {
      return this.cancelPaymentAsk(scope, command.targetId, customer);
    }
    if (command.intent === 'PAY_CANCEL' && command.targetId !== null) {
      return this.cancelPayment(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    if (command.intent === 'SERVICE_RENEW' && command.targetId !== null) {
      return this.commercialQuote(scope, actor, customer, command.targetId, 'RENEW', null, input);
    }
    if (command.intent === 'SERVICE_ADD_TRAFFIC' && command.targetId !== null) {
      return this.addonChoice(scope, actor, customer, command.targetId, 'ADD_TRAFFIC');
    }
    if (command.intent === 'SERVICE_ADD_TIME' && command.targetId !== null) {
      return this.addonChoice(scope, actor, customer, command.targetId, 'ADD_TIME');
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
    if (command.intent === 'SERVICE_ACTION_CONFIRM' && command.targetId !== null) {
      return this.commercialConfirm(scope, actor, customer, command.targetId, input);
    }
    if (command.intent === 'SERVICES') return this.services(scope, customer);
    if (command.intent === 'SERVICE' && command.targetId !== null) {
      return this.serviceDetail(scope, actor, customer, command.targetId);
    }
    if (command.intent === 'SERVICE_RESEND' && command.targetId !== null) {
      return this.serviceResend(scope, customer, command.targetId, input);
    }
    if (command.intent === 'SERVICE_SUSPEND' && command.targetId !== null) {
      return this.serviceAction(
        scope,
        actor,
        customer,
        command.targetId,
        'SUSPEND',
        input.idempotencyKey,
      );
    }
    if (command.intent === 'SERVICE_RESUME' && command.targetId !== null) {
      return this.serviceAction(
        scope,
        actor,
        customer,
        command.targetId,
        'RESUME',
        input.idempotencyKey,
      );
    }
    if (command.intent === 'SERVICE_TERMINATE_ASK' && command.targetId !== null) {
      return this.serviceTerminateAsk(scope, customer, command.targetId);
    }
    if (command.intent === 'SERVICE_TERMINATE' && command.targetId !== null) {
      return this.serviceAction(
        scope,
        actor,
        customer,
        command.targetId,
        'TERMINATE',
        input.idempotencyKey,
      );
    }
    return { key: replyFor(command.intent, arrival), values: {}, buttons: [], orderId: null };
  }

  /**
   * The customer's own services: a heading and one button each.
   *
   * The same shape as the catalogue and for the same reason — `bot.service.list_heading`
   * declares no placeholders and a template is not a list renderer — so the services are
   * BUTTONS whose `callback_data` is the id. The empty case is a different KEY rather
   * than the heading with nothing under it, because an empty list reads as a failure
   * and `bot.service.list_empty` says what it actually is.
   *
   * `listForCustomer` takes the customer id from the RESOLVED customer row, never from
   * anything the update carried, so there is no id here for a modified client to change.
   */
  private async services(scope: TenantContext, customer: CustomerRecord): Promise<PendingReply> {
    const page = await this.deps.services.listForCustomer(scope, customer.id, SERVICES_PAGE_SIZE);
    if (page.items.length === 0) {
      return { key: 'bot.service.list_empty', values: {}, buttons: [], orderId: null };
    }
    const buttons: CustomerButton[] = [];
    for (const service of page.items) {
      /*
       * The label is the plan as it was SOLD, from the order's frozen snapshot.
       *
       * A service whose order snapshot cannot be read is skipped rather than labelled
       * with its id or its state: a button a customer cannot identify is a button they
       * cannot safely tap, and the id is not a name. Unreachable through any path in
       * this release — the composite foreign key requires the order — and skipped
       * rather than defaulted because every default available here is a claim about
       * what somebody bought.
       */
      const title = await this.deps.purchaseTitle(scope, service.orderId);
      if (title === null) continue;
      buttons.push({
        label: { kind: 'TEXT', text: title },
        data: `${SERVICE_CALLBACK_PREFIX}${service.id}`,
      });
    }
    if (buttons.length === 0) {
      return { key: 'bot.service.list_empty', values: {}, buttons: [], orderId: null };
    }
    return { key: 'bot.service.list_heading', values: {}, buttons, orderId: null };
  }

  /**
   * One service, as its owner sees it.
   *
   * `getForCustomer` compares ownership against the row rather than filtering the query,
   * so an id that is not theirs and an id that does not exist both arrive here as
   * `SERVICE_NOT_FOUND` — and both answer `bot.service.not_found`. Keeping them the same
   * answer is what stops this being an oracle for guessing service ids.
   *
   * The usage figure is reported WITH the moment it was read. A figure with no `asOf` is
   * a figure a customer reads as live, and `usage_synced_at` is null until the first
   * `SYNC_USAGE` succeeds — so the template gets an absent `syncedAt` rather than a
   * fabricated one, which is the whole reason that placeholder is not required.
   */
  private async serviceDetail(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<PendingReply> {
    const service = await this.ownedService(scope, customer, serviceId);
    if (service === null) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    const title = await this.deps.purchaseTitle(scope, service.orderId);
    if (title === null) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }

    /*
     * The resend button is offered only when a resend would do something.
     *
     * `ProvisioningService.isDeliverable` is the authority — a live state AND a
     * subscription URL — and drawing the button otherwise would offer a customer an
     * action that answers with a refusal. Not drawing it is NOT the security control:
     * `redeliver` checks ownership against the row and `deliver` refuses a service with
     * no configuration, and both still run if somebody taps an older message.
     */
    const buttons: CustomerButton[] = ProvisioningService.isDeliverable(service)
      ? [
          {
            label: { kind: 'TEMPLATE', key: 'bot.service.resend_button' },
            data: `${SERVICE_RESEND_CALLBACK_PREFIX}${service.id}`,
          },
        ]
      : [];

    /*
     * The management buttons, offered only where tapping one would do something.
     *
     * `customerActionsFor` answers with both conditions applied: the service must be in
     * a state the operation is legal from, and the PANEL must declare the capability.
     * A 3X-UI-backed service gets an empty list, because this release cannot disable,
     * re-enable or delete a client there — and a product that draws a button it cannot
     * honour is the legacy defect this codebase keeps naming.
     *
     * Not drawing the button is not the control. `requestFromCustomer` re-checks
     * ownership, the state and the capability when the tap arrives, so a customer
     * scrolling back to an older message is refused rather than served.
     */
    for (const action of await this.deps.services.customerActionsFor(scope, service)) {
      if (action === 'SUSPEND') {
        buttons.push({
          label: { kind: 'TEMPLATE', key: 'bot.service.suspend_button' },
          data: `${SERVICE_SUSPEND_CALLBACK_PREFIX}${service.id}`,
        });
      }
      if (action === 'RESUME') {
        buttons.push({
          label: { kind: 'TEMPLATE', key: 'bot.service.resume_button' },
          data: `${SERVICE_RESUME_CALLBACK_PREFIX}${service.id}`,
        });
      }
      if (action === 'TERMINATE') {
        /*
         * The terminate button opens a QUESTION and carries the ask prefix.
         *
         * `SERVICE_TERMINATE_CALLBACK_PREFIX` is never written here, and that is the
         * confirmation step made structural rather than remembered: the only place the
         * destructive callback is produced is the confirmation screen below, so there
         * is no message anywhere in this product whose single tap ends a service.
         */
        buttons.push({
          label: { kind: 'TEMPLATE', key: 'bot.service.terminate_button' },
          data: `${SERVICE_TERMINATE_ASK_CALLBACK_PREFIX}${service.id}`,
        });
      }
    }

    /*
     * The commercial buttons, offered on the same terms as the management ones: the
     * state must allow it, the panel must declare the capability, AND there must be
     * something configured to sell. `availableFor` applies all three — a renewal whose
     * plan has been withdrawn, or an extra-traffic button with no package behind it, is
     * a button whose tap is a refusal.
     *
     * Each opens a QUOTE and buys nothing. There is no callback anywhere in this surface
     * that takes a customer's money in one tap, which is the same structural rule the
     * terminate confirmation follows.
     */
    for (const action of await this.deps.commercial.availableFor(scope, actor, service)) {
      if (action === 'RENEW') {
        buttons.push({
          label: { kind: 'TEMPLATE', key: 'bot.service.renew_button' },
          data: `${SERVICE_RENEW_CALLBACK_PREFIX}${service.id}`,
        });
      }
      if (action === 'ADD_TRAFFIC') {
        buttons.push({
          label: { kind: 'TEMPLATE', key: 'bot.service.add_traffic_button' },
          data: `${SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX}${service.id}`,
        });
      }
      if (action === 'ADD_TIME') {
        buttons.push({
          label: { kind: 'TEMPLATE', key: 'bot.service.add_time_button' },
          data: `${SERVICE_ADD_TIME_CALLBACK_PREFIX}${service.id}`,
        });
      }
    }

    return {
      key: 'bot.service.detail',
      values: {
        productTitle: title,
        // Localised by the surface, per the placeholder's own description. The state is
        // a closed vocabulary, so this is a lookup and not a string a tenant can edit.
        state: service.state,
        usedTrafficBytes: service.trafficUsedBytes,
        totalTrafficBytes: service.trafficLimitBytes,
        ...(service.expiresAt === null ? {} : { expiresAt: service.expiresAt }),
        ...(service.usageSyncedAt === null ? {} : { syncedAt: service.usageSyncedAt }),
      },
      buttons,
      orderId: null,
    };
  }

  /**
   * A customer asking for their configuration again.
   *
   * The remedy `UNCONFIRMED` and `FAILED` were designed around: an announcement whose
   * outcome was never observed leaves a customer with nothing, and until now they had
   * no way to recover it themselves. `DeliveryService.redeliver` is what sends it —
   * through the SAME `markSendStarted` stamp and the same delivery accounting the
   * automatic lane uses, so a customer-requested send and a swept one cannot race each
   * other into two messages.
   *
   * This returns `key: null`, which `handle` reads as "nothing further to send". The
   * delivery service has already sent the subscription; a second message here would be
   * the runtime and the delivery lane both answering the same tap.
   */
  /**
   * The packages a customer may buy for one service, as buttons.
   *
   * A read and nothing else — no order, no row, no money. Each button carries the
   * service AND the package, because with no conversation state there is nowhere to
   * keep the first while the customer chooses the second, and neither can be inferred
   * from the other: they OWN the service and CHOOSE the package.
   *
   * The amount and the price are rendered from the row the operator configured, and
   * neither travels in the callback. What comes back is two identifiers.
   */
  private async addonChoice(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    kind: 'ADD_TRAFFIC' | 'ADD_TIME',
  ): Promise<PendingReply> {
    let offer;
    try {
      offer = await this.deps.commercial.offer(scope, actor, customer.id, serviceId, kind);
    } catch (error) {
      return refusal(error);
    }

    const prefix =
      kind === 'ADD_TRAFFIC'
        ? SERVICE_BUY_TRAFFIC_CALLBACK_PREFIX
        : SERVICE_BUY_TIME_CALLBACK_PREFIX;
    return {
      key: 'bot.service.addon_choice',
      values: {},
      /*
       * Unpriced rows are dropped rather than rendered at zero.
       *
       * `listOfferable` already filters them out in SQL, so this cannot fire — and it
       * is a filter rather than a `?? zero` because `catalog.ts` says an absent price
       * means unsellable and never free. A zero here would offer a customer a package
       * for nothing, which is the one way to be wrong that money cannot be taken back
       * from.
       */
      buttons: offer.addons
        .filter((addon): addon is typeof addon & { price: Money } => addon.price !== null)
        .map((addon) => ({
          label: {
            kind: 'TEMPLATE' as const,
            key: 'bot.service.addon_option' as const,
            values: {
              // A MONEY value, rendered by the catalogue with its currency. A bare
              // number is the legacy defect where one template said تومان and its twin
              // ریال for the same figure, a factor of ten apart.
              title: addon.title,
              price: addon.price,
            },
          },
          data: `${prefix}${encodeIdPair(serviceId, addon.id)}`,
        })),
      orderId: null,
    };
  }

  /**
   * The quote a customer answers: what this action buys, and what it costs.
   *
   * It writes a DRAFT order and its invoice line — both in one transaction — and
   * commits the customer to nothing. The number shown is the number the order was
   * written with, and it is never re-taken: confirming re-checks that the service and
   * the package are still eligible and leaves the price exactly as the customer saw it.
   *
   * `idempotencyKey` is the update's, so Telegram redelivering the same tap produces
   * the same draft rather than a second one.
   */
  private async commercialQuote(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    kind: 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME',
    addonId: string | null,
    input: { readonly idempotencyKey: string },
  ): Promise<PendingReply> {
    try {
      const { order } = await this.deps.commercial.draft(scope, actor, customer.id, {
        serviceId,
        kind,
        ...(addonId === null ? {} : { addonId }),
        idempotencyKey: `${input.idempotencyKey}:${kind.toLowerCase()}`,
      });
      return {
        key: 'bot.service.action_quote',
        values: {
          // The order's own line snapshot, which is what was quoted — the plan's title
          // for a renewal, the package's for a quantity purchase.
          productTitle: order.line.title,
          total: order.totals.total,
          /*
           * WHAT is being bought, beside what it costs, and from the same frozen line.
           *
           * A title is free text an operator wrote: «بسته ویژه» encodes no allowance at
           * all. This screen is the one the customer answers, so it is where the figures
           * have to be — exactly as `bot.order.summary` carries them for a product, and
           * for the same reason a product's catalogue button does not.
           */
          trafficBytes: order.line.specification.trafficBytes,
          durationDays: order.line.specification.durationDays,
        },
        buttons: [
          {
            label: { kind: 'TEMPLATE', key: 'bot.service.action_confirm_button' },
            data: `${SERVICE_ACTION_CONFIRM_CALLBACK_PREFIX}${order.id}`,
          },
        ],
        orderId: order.id,
      };
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * The customer answering the quote: DRAFT to AWAITING_PAYMENT, then the payment
   * buttons.
   *
   * The same two steps a product purchase takes, and deliberately the same screen after
   * them — `paymentButtons` is shared, so wallet and manual transfer work on a
   * commercial order without knowing it is one.
   */
  private async commercialConfirm(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    orderId: string,
    input: { readonly idempotencyKey: string },
  ): Promise<PendingReply> {
    try {
      const order = await this.deps.commercial.confirm(scope, actor, customer.id, {
        orderId,
        idempotencyKey: `${input.idempotencyKey}:action_confirm`,
      });
      return {
        key: 'bot.order.awaiting_payment',
        values: {
          total: order.totals.total,
          ...(order.expiresAt === null ? {} : { expiresAt: order.expiresAt }),
        },
        buttons: paymentButtons(order.id),
        orderId: order.id,
      };
    } catch (error) {
      return refusal(error);
    }
  }

  private async serviceResend(
    scope: TenantContext,
    customer: CustomerRecord,
    serviceId: string,
    input: { readonly botInstanceId: BotInstanceId; readonly update: unknown },
  ): Promise<PendingReply> {
    const service = await this.ownedService(scope, customer, serviceId);
    if (service === null) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    const chatId = privateChatIdOf(input.update);
    if (chatId === null) {
      /*
       * A tap from somewhere that is not a private chat.
       *
       * Refused with the same answer as an unknown service rather than sent to the
       * chat the service was FIRST delivered to: a subscription link is a bearer
       * capability, and delivering it anywhere other than where it was asked for is
       * how one lands in a group.
       */
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    try {
      await this.deps.delivery.redeliver(scope, service, customer.id, chatId, input.botInstanceId);
      return { key: null, values: {}, buttons: [], orderId: null };
    } catch {
      /*
       * Every refusal `deliver` can produce, as one customer-facing answer.
       *
       * `SERVICE_NOT_DELIVERABLE` carries a `reason` — NO_SUBSCRIPTION, SCOPE_INACTIVE,
       * SEND_IN_PROGRESS — and its own docblock says a surface maps them to a template
       * key. They are mapped to ONE here because a customer can act on none of them
       * and because the third is a race whose honest description is "try again in a
       * moment", which is what a service that answers nothing already tells them.
       * `bot.service.provisioning` is the closest true sentence for a service that has
       * no link yet and it is NOT used, because it would be wrong for the other two.
       */
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
  }

  /**
   * The one screen between a customer and the deletion of their provider account.
   *
   * It plans nothing, writes nothing and contacts nothing. Its only job is to say what
   * is about to happen, name the service in words the customer recognises, and offer
   * the ONE button that carries the destructive prefix.
   *
   * The ability is re-checked here rather than trusted from whichever message was
   * tapped: a customer whose service has since expired, or whose panel an operator
   * disabled, is told it cannot be done instead of being shown a question whose answer
   * would be refused.
   */
  private async serviceTerminateAsk(
    scope: TenantContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<PendingReply> {
    const service = await this.ownedService(scope, customer, serviceId);
    if (service === null) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    const title = await this.deps.purchaseTitle(scope, service.orderId);
    if (title === null) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    const actions = await this.deps.services.customerActionsFor(scope, service);
    if (!actions.includes('TERMINATE')) {
      return { key: 'bot.service.capability_unsupported', values: {}, buttons: [], orderId: null };
    }
    return {
      key: 'bot.service.terminate_confirm',
      values: { productTitle: title },
      buttons: [
        {
          label: { kind: 'TEMPLATE', key: 'bot.service.terminate_confirm_button' },
          data: `${SERVICE_TERMINATE_CALLBACK_PREFIX}${service.id}`,
        },
      ],
      orderId: null,
    };
  }

  /**
   * A customer asking for one of the three management actions on their own service.
   *
   * The TYPE is a literal chosen by which callback prefix matched, never parsed out of
   * the payload. That is the property worth stating: nothing a client sends can turn a
   * tap on "pause" into a terminate, because the only thing that crosses the boundary
   * is a service id.
   *
   * What this does is PLAN an operation. The provisioner claims it on its next tick and
   * calls the panel; this surface never touches a provider, which is why the reply says
   * the request was recorded rather than that it is done. Saying "your service is
   * paused" here would be a claim about somebody else's machine, made before anything
   * was asked of it.
   *
   * Every refusal `requestFromCustomer` can produce is answered BY NAME, and the
   * mapping is a closed list rather than a catch-all. `SERVICE_NOT_FOUND` is the same
   * answer an id that is not theirs gets. The other three — a state the action is not
   * legal from, a panel that cannot perform it, a tenant that has stopped — are one
   * sentence, because that sentence is true for all of them, none is the customer's to
   * fix, and telling them apart would describe an operator's panel to a customer.
   *
   * Anything ELSE is re-thrown, and that is the part worth stating. A catch-all here
   * would answer a database failure with "this action is not available for your
   * service" — a false statement about the customer's panel, made to hide an outage,
   * and indistinguishable from the three real refusals in every log this installation
   * keeps. The runtime's own error path exists for the unknown case.
   */
  private async serviceAction(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    type: CustomerServiceOperation,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      await this.deps.services.requestFromCustomer(scope, actor, customer.id, serviceId, type, {
        idempotencyKey,
      });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND) {
        return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
      }
      const refusals: readonly unknown[] = [
        COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
        COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE,
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
      ];
      if (!refusals.includes(code)) throw error;
      return { key: 'bot.service.capability_unsupported', values: {}, buttons: [], orderId: null };
    }
    return { key: 'bot.service.action_requested', values: {}, buttons: [], orderId: null };
  }

  /** One of the customer's own services, or null. Never anybody else's, never a throw. */
  private async ownedService(
    scope: TenantContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<ServiceRecord | null> {
    try {
      return await this.deps.services.getForCustomer(scope, customer.id, serviceId);
    } catch {
      // `SERVICE_NOT_FOUND` for an id that is not theirs and one that does not exist
      // alike. Caught rather than propagated because a surface answers a customer.
      return null;
    }
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
  private async catalogue(scope: TenantContext, actor: ActorContext): Promise<PendingReply> {
    const { items } = await this.deps.products.browse(scope, actor, CATALOG_PAGE_SIZE);
    if (items.length === 0) {
      return { key: 'bot.catalog.empty', values: {}, buttons: [], orderId: null };
    }
    const buttons: CustomerButton[] = [];
    for (const product of items) {
      // `browse` returns only priced products — that is one of its four predicates — so
      // a null price here would mean the read model had changed under this surface.
      // Skipped rather than rendered as a button with no amount, because a plan whose
      // price a customer cannot see is a plan they cannot consent to.
      if (product.price === null) continue;
      buttons.push({
        label: { kind: 'TEXT', text: product.title, amount: product.price },
        data: `${ORDER_CALLBACK_PREFIX}${product.id}`,
      });
    }
    return { key: 'bot.catalog.heading', values: {}, buttons, orderId: null };
  }

  /** The summary a customer confirms. Every figure comes from the ORDER, never the tap. */
  private async draft(
    scope: TenantContext,
    actor: ActorContext,
    productId: string,
    customer: CustomerRecord,
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
      return {
        key: 'bot.order.summary',
        // From the ORDER's own snapshot, not from the product and not from the callback
        // data. `templates.ts` says so in terms: "Every figure in it comes from the price
        // quote, never from callback data."
        values: {
          productTitle: order.line.title,
          total: order.totals.total,
          durationDays: order.line.specification.durationDays,
          trafficBytes: order.line.specification.trafficBytes,
        },
        buttons: [
          {
            label: { kind: 'TEMPLATE', key: 'bot.order.confirm_button' },
            data: `${CONFIRM_CALLBACK_PREFIX}${order.id}`,
          },
        ],
        orderId: order.id,
      };
    } catch (error) {
      return refusal(error);
    }
  }

  /** DRAFT to AWAITING_PAYMENT, and the message that says what that means. */
  private async confirm(
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
        buttons: paymentButtons(order.id),
        orderId: order.id,
      };
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * The customer's own balance, derived from the ledger every time it is asked for.
   *
   * There is no balance column to read and no cache to go stale — `balanceOf` sums the
   * entries. `bot.wallet.balance` declares exactly one placeholder and this supplies
   * exactly that.
   */
  private async walletBalance(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    const balance = await this.deps.wallet.balanceForCustomer(scope, actor, customer.id);
    return {
      key: 'bot.wallet.balance',
      values: { balance: money(balance.amountMinor, balance.currency) },
      buttons: [],
      orderId: null,
    };
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
  private async walletPayment(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const { order } = await this.deps.payments.settleFromWallet(scope, actor, customer.id, {
        // Suffixed within the update's own key, the shape `draft` and `confirm` use: the
        // bare key was consumed by `resolveFromUpdate`, and presenting it again with a
        // different payload is an idempotency payload mismatch. A REDELIVERED update
        // recomputes this same suffix, which is what makes the replay produce one debit.
        idempotencyKey: `${idempotencyKey}:wallet-pay`,
        orderId,
      });
      return { key: 'bot.order.settled', values: {}, buttons: [], orderId: order.id };
    } catch (error) {
      /*
       * Insufficient funds is answered HERE rather than through `REFUSAL_REPLIES`,
       * because the reply needs the shortfall and that map carries no values.
       *
       * The shortfall comes from the ERROR's detail, which the service computed from the
       * ledger inside its transaction — not recomputed here, which would be a second
       * statement of the same subtraction reading a balance from a different moment.
       *
       * What is deliberately NOT offered: a top-up for the difference. That would need a
       * standalone top-up with an authoritative amount, and `docs/phase4c-audit.md`
       * records why there is none — combining a shortfall with a configured minimum is a
       * financial product rule no contract states. The customer is told what is missing
       * and left to act on it.
       */
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS) {
        const shortfall = shortfallOf(error.details);
        if (shortfall !== null) {
          return {
            key: 'bot.wallet.insufficient',
            values: { shortfall },
            buttons: [],
            orderId,
          };
        }
      }
      return refusal(error);
    }
  }

  /**
   * Choosing to pay out of band: a PENDING payment, the amount, and the code to quote.
   *
   * No money moves and nothing settles. `bot.payment.manual_instructions` declares
   * `{total}` and `{reference}` and both come from the payment the service created — the
   * total from the order's frozen snapshot, the reference GENERATED, because a customer
   * who could choose it could choose somebody else's.
   *
   * The instructions themselves are tenant copy. This installation ships no bank details
   * and invents none, which the key's own description says.
   */
  private async manualPayment(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const payment = await this.deps.payments.requestManualTransfer(scope, actor, customer.id, {
        idempotencyKey: `${idempotencyKey}:manual-pay`,
        orderId,
      });
      return {
        key: 'bot.payment.manual_instructions',
        values: { total: payment.amount, reference: payment.reference },
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
          {
            label: { kind: 'TEMPLATE', key: 'bot.payment.cancel_button' },
            data: `${CANCEL_PAY_ASK_CALLBACK_PREFIX}${payment.id}`,
          },
        ],
        orderId,
      };
    } catch (error) {
      return refusal(error);
    }
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
   * `serviceTerminateAsk` is the same shape one aggregate over.
   *
   * The payment is re-read here rather than trusted from whichever message was tapped:
   * a customer whose payment an operator has since rejected, or the sweep has expired,
   * is told it is no longer pending instead of being shown a question whose answer
   * would be refused.
   */
  private async cancelPaymentAsk(
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
      values: {},
      buttons: [
        {
          label: { kind: 'TEMPLATE', key: 'bot.payment.cancel_confirm_button' },
          data: `${CANCEL_PAY_CALLBACK_PREFIX}${payment.id}`,
        },
      ],
      orderId: null,
    };
  }

  private async cancelPayment(
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
      return refusal(error);
    }
  }

  /** Best effort, after the answer, and never allowed to fail the turn. */
  private async stopSpinner(
    scope: TenantContext,
    command: BotCommand,
    botInstanceId: BotInstanceId,
  ): Promise<void> {
    if (command.callbackQueryId === null) return;
    await this.deps.messenger.acknowledge(scope, {
      callbackQueryId: command.callbackQueryId,
      botInstanceId,
    });
  }
}

/**
 * Which template answers this turn.
 *
 * A pure function of the intent and the arrival, so the decision is testable without a
 * database or a Telegram server — and so the blocked case cannot be forgotten by one
 * branch. BLOCKED wins over everything: a blocked customer gets the block message
 * whatever they asked for, because every other answer is a service they are not
 * entitled to.
 *
 * `UNSUPPORTED` for an ACTIVE customer gets the existing `bot.unknown_command`, which
 * Phase 1 already declared — a new key for the same sentence would be a second string to
 * keep in step.
 */
export function replyFor(intent: BotIntent, arrival: CustomerArrival): TemplateKey | null {
  if (arrival === 'BLOCKED') return 'bot.blocked';
  if (intent === 'START') {
    return arrival === 'FIRST_SEEN' ? 'bot.start.welcome' : 'bot.start.welcome_back';
  }
  if (intent === 'HELP') return 'bot.help';
  return 'bot.unknown_command';
}

/** Re-exported so the controller need not know the record shape to log an outcome. */
export type { CustomerRecord };

/**
 * The payment methods this installation can actually perform, as buttons.
 *
 * `WALLET` and `MANUAL_TRANSFER`, which is exactly `SELF_CONTAINED_PAYMENT_METHODS`. A
 * gateway button is NOT drawn, and that is the rule `provider.ts` records applied to
 * money: Marzban's descriptor advertising fourteen operations no code could perform was
 * rejected, because what a product publishes is how it tells a user what it can do.
 *
 * Each button carries the ORDER ID and nothing else. There is no amount in a callback
 * and no place to put one.
 */
function paymentButtons(orderId: string): readonly CustomerButton[] {
  return [
    {
      label: { kind: 'TEMPLATE', key: 'bot.payment.wallet_button' },
      data: `${WALLET_PAY_CALLBACK_PREFIX}${orderId}`,
    },
    {
      label: { kind: 'TEMPLATE', key: 'bot.payment.manual_button' },
      data: `${MANUAL_PAY_CALLBACK_PREFIX}${orderId}`,
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
