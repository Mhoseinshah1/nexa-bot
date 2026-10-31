// Paying for an order: the methods screen, the wallet, a gateway attempt and its check.
// Moved verbatim out of bot-runtime.ts; BotRuntime keeps a forwarder for every one a router calls.
import {
  type ActorContext,
  COMMERCE_ERROR_CODES,
  currencyCodeSchema,
  isNexaError,
  money,
  type Money,
  type OrderPurpose,
  type PaymentGatewayProvider,
  type TemplateKey,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import { inlineLabel } from '../../../modules/commerce/messaging/application/inline-buttons.js';
import type { OrderRecord } from '../../../modules/commerce/orders/application/ports.js';
import {
  FX_UNAVAILABLE_REASON,
  type GatewayAttempt,
} from '../../../modules/commerce/payments/application/payment.service.js';
import type { GatewayAttemptView } from '../../../modules/commerce/payments/application/gateway-payment.service.js';
import type { WizardDirective } from '../wizard-state.js';
import {
  CANCEL_ORDER_ASK_CALLBACK_PREFIX,
  GATEWAY_ROUTE_PAY_CALLBACK_PREFIX,
  MANUAL_PAY_CALLBACK_PREFIX,
  INPUT_BACK_CALLBACK_PREFIX,
  PAY_METHODS_CLOSE_CALLBACK_PREFIX,
  WALLET_PAY_CALLBACK_PREFIX,
} from './callbacks.js';
import { mainMenuButton } from './keyboards.js';
import { endedOrderScreen, liveOrderInReview, orderEndedRefusal } from './order-end-flow.js';
import { refusal } from './refusals.js';
import type { PendingReply } from './replies.js';
import { gatewayAttemptScreen, payMethodsButton, topupButton } from './payment-screens.js';
import { unreceiptedTransfer } from './card-receipt-flow.js';
import { repricedSummary } from './purchase-flow.js';
import type { BotRuntime } from '../bot-runtime.js';

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
 * R12 F3 item 7: «🔙 بازگشت به پیش‌فاکتور» under the wallet shortfall — after the customer tops
 * up (the top-up is its own flow), the way back to the order they were paying is one tap, not a
 * hunt through the chat. The same `ib:` route as the typed-input prompts: it closes any open
 * text window and draws the order's current screen; it pays nothing.
 */
export function preinvoiceBackButton(orderId: string): CustomerButton {
  return { ...inlineLabel('order.input_back'), data: `${INPUT_BACK_CALLBACK_PREFIX}${orderId}` };
}

/**
 * The awaiting-payment message: what is owed, until when, and the buttons that pay it.
 * One builder for a confirmed purchase, a confirmed commercial action and the selector's
 * «❌ بستن لیست», so the three can never draw different buttons for the same order.
 */
export async function awaitingPaymentReply(
  rt: BotRuntime,
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
      (await orderRouteButtons(rt, scope, customer.id, order.id, order.totals.total)).length > 0,
    ),
    orderId: order.id,
    wizard: { kind: 'ORDER', step: 'AWAITING_PAYMENT', subjectId: order.id },
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
export async function walletPayment(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  orderId: string,
  customer: CustomerRecord,
  idempotencyKey: string,
): Promise<PendingReply> {
  try {
    /*
     * From the pre-invoice a DRAFT is paid in one tap. `CheckoutService.payFromWallet`
     * reads the balance FIRST and answers a shortfall without confirming anything, then
     * confirms and settles, each step under its own suffix of the update's key: the bare
     * key was consumed by `resolveFromUpdate`, and a REDELIVERED update recomputes the
     * same suffixes, which is what makes the replay produce one debit.
     */
    const before = await rt.deps.orders.orderForCustomer(scope, actor, {
      customerId: customer.id,
      orderId,
    });
    const paid = await rt.deps.checkout.payFromWallet(
      scope,
      actor,
      customer.id,
      before,
      idempotencyKey,
    );
    if (paid.outcome === 'SHORT') {
      return {
        key: 'bot.wallet.insufficient',
        values: { shortfall: paid.shortfall },
        buttons: [topupButton(), preinvoiceBackButton(orderId), mainMenuButton()],
        orderId,
        // R2: its own message, so the pre-invoice stays payable after a top-up.
        wizard: WALLET_SHORT,
      };
    }
    const { order } = paid;
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
          buttons: [topupButton(), preinvoiceBackButton(orderId), mainMenuButton()],
          orderId,
          wizard: WALLET_SHORT,
        };
      }
    }
    // R11 A11: an order past its deadline, swept or cancelled — answered ON the tapped screen.
    return (await orderEndedRefusal(rt, scope, actor, customer, orderId, error)) ?? refusal(error);
  }
}

/**
 * One button per payment route offered for paying this order, in the operator's order —
 * what «🧾 ثبت پرداخت» opens, and whether it is drawn at all.
 *
 * Which routes, and in what order, is `CheckoutService.orderRoutes` — the same list the
 * mini app shows. Drawn here by kind: a `GATEWAY` route taps `gp:<order>.<provider>`
 * (TonPays, Stars, any external route); card to card taps `m:<order>`, the card-to-card
 * instruction and then the receipt flow.
 *
 * Every button carries identifiers only. Each tap re-decides its route on the server.
 */
export async function orderRouteButtons(
  rt: BotRuntime,
  scope: TenantContext,
  customerId: UserId,
  orderId: string,
  amount: Money,
): Promise<readonly CustomerButton[]> {
  const routes = await rt.deps.checkout.orderRoutes(scope, customerId, amount);
  return routes.map((route) =>
    routeButton(
      route.name,
      route.kind === 'GATEWAY'
        ? `${GATEWAY_ROUTE_PAY_CALLBACK_PREFIX}${orderId}.${route.provider}`
        : `${MANUAL_PAY_CALLBACK_PREFIX}${orderId}`,
    ),
  );
}

/**
 * The refusal of the payment-method selector (`pm:`) and of its «❌ بستن لیست» (`px:`).
 *
 * An order that does not exist and one that belongs to another customer arrive as the
 * same `ORDER_NOT_FOUND`, and both are answered as an order that is not awaiting payment:
 * the sentence a tap on this very button already gets for the customer's own cancelled or
 * paid order, so the answer neither says whether the id exists nor claims — as
 * `bot.order.unavailable` does — that a PRODUCT can no longer be bought. With the main
 * menu under it, because the message the customer tapped is the one that is stale. Every
 * other refusal goes through the shared table, as before.
 */
function orderListRefusal(error: unknown): PendingReply {
  if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.ORDER_NOT_FOUND) {
    return {
      key: 'bot.order.not_awaiting_payment',
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
    };
  }
  return refusal(error);
}

/**
 * «💰 روش پرداخت خود را انتخاب نمایید» for one order: the routes `orderRouteButtons`
 * offers, then «❌ بستن لیست».
 *
 * Writes nothing. The order is read as THIS customer's, so another customer's id
 * answers `orderListRefusal`, and an order no longer payable (paid, cancelled, expired) answers
 * `bot.order.not_awaiting_payment`. No payment attempt exists until a route is tapped.
 */
export async function paymentMethods(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  orderId: string,
  customer: CustomerRecord,
): Promise<PendingReply> {
  try {
    const order = await rt.deps.orders.orderForCustomer(scope, actor, {
      customerId: customer.id,
      orderId,
    });
    const close: CustomerButton = {
      ...inlineLabel('list.close'),
      data: `${PAY_METHODS_CLOSE_CALLBACK_PREFIX}${order.id}`,
    };
    // R11 A11: an order that ended (expired, cancelled) shows its ended screen in place.
    const ended = endedOrderScreen(rt, order);
    if (ended !== null) return ended;
    // R12 F3 item 9: past its deadline only because a payment is still live — not payable again.
    const review = await liveOrderInReview(rt, scope, actor, customer, order);
    if (review !== null) return review;
    if (order.state !== 'DRAFT' && order.state !== 'AWAITING_PAYMENT') {
      return {
        key: 'bot.order.not_awaiting_payment',
        values: {},
        buttons: [mainMenuButton()],
        orderId: order.id,
      };
    }
    const routes = await orderRouteButtons(rt, scope, customer.id, order.id, order.totals.total);
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
    return orderListRefusal(error);
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
export async function paymentMethodsBack(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  orderId: string,
  customer: CustomerRecord,
): Promise<PendingReply | null> {
  try {
    const order = await rt.deps.orders.orderForCustomer(scope, actor, {
      customerId: customer.id,
      orderId,
    });
    if (order.state === 'AWAITING_PAYMENT') {
      return awaitingPaymentReply(rt, scope, customer, order);
    }
    if (
      order.state === 'DRAFT' &&
      (order.purpose === 'NEW_SERVICE' || order.purpose === 'CUSTOM_SERVICE')
    ) {
      return repricedSummary(rt, scope, actor, order, customer);
    }
    return null;
  } catch (error) {
    return orderListRefusal(error);
  }
}

/**
 * Paying an order through an external gateway (WP11A). The tap carries the ORDER ID.
 *
 * `CheckoutService.payByGateway`: the route is the tapped one (or the first external route
 * offered, for the older `g:`) among those offered for this order — decided BEFORE a draft
 * is confirmed, so a customer shown a stale button does not reserve a slot for a payment
 * they cannot make. Then the service opens (or hands back) the attempt; the provider
 * invoice is created by the worker, never while Telegram waits, so the first answer is
 * usually "being prepared" with a check button.
 *
 * A route that cannot be used right now is answered as unavailable, never as the
 * customer's payment failing (brief §19).
 */
export async function gatewayPayment(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  orderId: string,
  customer: CustomerRecord,
  idempotencyKey: string,
  /** The route the customer tapped (`gp:`), or null for the older `g:` button. */
  provider: PaymentGatewayProvider | null,
): Promise<PendingReply> {
  try {
    const before = await rt.deps.orders.orderForCustomer(scope, actor, {
      customerId: customer.id,
      orderId,
    });
    const paid = await rt.deps.checkout.payByGateway(
      scope,
      actor,
      customer.id,
      before,
      idempotencyKey,
      provider,
    );
    // R2: in the wizard, a way back to the other methods rather than a dead end.
    if (paid.outcome === 'NOT_OFFERED') {
      return { ...gatewayUnavailable(), buttons: [payMethodsButton(orderId), mainMenuButton()] };
    }
    return await gatewayAttemptReply(rt, paid.attempt, orderId, scope);
  } catch (error) {
    // R11 A11: an order that ended is answered ON the tapped screen, not by a new message.
    const ended = await orderEndedRefusal(rt, scope, actor, customer, orderId, error);
    if (ended !== null) return ended;
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
export async function gatewayCheck(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  paymentId: string,
  customer: CustomerRecord,
): Promise<PendingReply> {
  const view = await rt.deps.gateway.attemptFor(scope, customer.id, paymentId);
  if (view === null) {
    /*
     * R12 F3 (lead review): «🧾 مشاهدهٔ فاکتور باز» also names a card-to-card transfer (the
     * pending-payment reminder's button). Its own invoice while no receipt is filed; once one
     * is, that it was received and is being reviewed. Never a new payment.
     */
    const transfer = await unreceiptedTransfer(rt, scope, actor, customer, paymentId);
    if (transfer !== null) return transfer;
    if (
      (await rt.deps.payments.pendingTransferForCustomer(scope, customer.id, paymentId)) !== null
    ) {
      return {
        key: 'bot.payment.receipt_received',
        values: {},
        buttons: [mainMenuButton()],
        orderId: null,
      };
    }
    return {
      key: 'bot.payment.gateway_closed',
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
    };
  }
  await rt.deps.gateway.requestCheck(scope, view);
  return gatewayAttemptReply(rt, { ...view, reissued: true }, view.payment.orderId, scope);
}

/** An external-gateway attempt, as the customer sees it: `gatewayAttemptScreen`, now. */
export async function gatewayAttemptReply(
  rt: BotRuntime,
  attempt: GatewayAttempt | GatewayAttemptView,
  orderId: string | null,
  scope: TenantContext,
): Promise<PendingReply> {
  const facts = await rt.deps.gateway.cardFactsFor(scope, attempt.invoice);
  return gatewayAttemptScreen(attempt, orderId, rt.deps.clock.now(), facts);
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
 * R2: a wallet refusal the customer acts on and comes back from — too little balance, a
 * transfer already under review — goes out as its OWN message, so the pre-invoice it answers
 * stays on screen and payable once they have topped up.
 */
const WALLET_SHORT: WizardDirective = { kind: 'ORDER', step: 'PREINVOICE', placement: 'NEW' };

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
