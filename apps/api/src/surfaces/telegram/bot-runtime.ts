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
  TemplateKey,
  TemplateValues,
  TenantContext,
} from '@nexa/contracts';
import type { CustomerService } from '../../modules/commerce/customers/application/customer.service.js';
import type {
  CustomerButton,
  CustomerMessenger,
} from '../../modules/commerce/messaging/application/ports.js';
import type { CustomerRecord } from '../../modules/commerce/customers/application/ports.js';
import type { ProductService } from '../../modules/commerce/catalog/application/product.service.js';
import type { OrderService } from '../../modules/commerce/orders/application/order.service.js';
import type { PaymentService } from '../../modules/commerce/payments/application/payment.service.js';
import type { WalletService } from '../../modules/commerce/wallet/application/wallet.service.js';

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
  /** Telegram's id for the tapped button, so the spinner can be stopped. */
  readonly callbackQueryId: string | null;
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
  readonly orders: OrderService;
  readonly payments: PaymentService;
  readonly wallet: WalletService;
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
  readonly sent: 'DELIVERED' | 'REFUSED' | 'UNKNOWN' | 'NOT_ATTEMPTED';
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
  [COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID]: 'bot.order.unavailable',
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
      sent,
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
    input: { readonly idempotencyKey: string },
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
    return { key: replyFor(command.intent, arrival), values: {}, buttons: [], orderId: null };
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
        buttons: [],
        orderId,
      };
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
