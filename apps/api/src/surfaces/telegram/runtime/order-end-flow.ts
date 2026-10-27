// R11 A11 (owner request: order-expiry edit-in-place): an unpaid order that ENDED — its
// window closed, or the customer cancelled it — answered on the order's own message.
import {
  COMMERCE_ERROR_CODES,
  isNexaError,
  type ActorContext,
  type BotInstanceId,
  type TemplateKey,
  type TenantContext,
} from '@nexa/contracts';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import { ORDER_END_ANSWER_STEPS } from '../../../modules/commerce/messaging/application/order-screen-answer.js';
import { orderEndScreen } from '../../../modules/commerce/messaging/application/order-end-screen.js';
import type { OrderRecord } from '../../../modules/commerce/orders/application/ports.js';
import type { CardMessageRef } from '../../../modules/commerce/provisioning/application/operation-card.js';
import { orderEndButtons } from './keyboards.js';
import type { PendingReply } from './replies.js';
import type { BotRuntime } from '../bot-runtime.js';

/** Which ending an order is in, as the customer sees it, or null when it has not ended. */
type OrderEnding = 'EXPIRED' | 'CANCELLED';

const ENDING_KEYS: Readonly<Record<OrderEnding, TemplateKey>> = {
  EXPIRED: 'bot.order.expired_screen',
  CANCELLED: 'bot.order.cancelled_screen',
};

/**
 * The order's ending at `now`: EXPIRED once the sweep moved it, and also while it is still
 * unpaid past its own deadline (the sweep has not reached it yet — the same instant
 * `orderAwaitingPayment` refuses a payment with `ORDER_EXPIRED`); CANCELLED once withdrawn.
 */
function endingOf(order: OrderRecord, now: Date): OrderEnding | null {
  if (order.state === 'EXPIRED') return 'EXPIRED';
  if (order.state === 'CANCELLED') return 'CANCELLED';
  if (
    (order.state === 'DRAFT' || order.state === 'AWAITING_PAYMENT') &&
    order.expiresAt !== null &&
    now.getTime() >= order.expiresAt.getTime()
  ) {
    return 'EXPIRED';
  }
  return null;
}

/** The ended screen's content: the summary, re-order and the main menu, nothing that pays. */
function endedContent(
  order: OrderRecord,
  ending: OrderEnding,
): {
  readonly templateKey: TemplateKey;
  readonly values: PendingReply['values'];
  readonly buttons: readonly CustomerButton[];
} {
  const screen = orderEndScreen(order);
  return {
    templateKey: ENDING_KEYS[ending],
    values: screen.values,
    buttons: orderEndButtons(screen.reorder),
  };
}

/**
 * A tap on a pay or confirm button of an order that has ended, answered by EDITING the tapped
 * message into the ended screen — never by a new «مهلت این سفارش به پایان رسیده است» under it.
 *
 * Before: every such tap — the pre-invoice's confirm on a draft past its hold, a pay button on
 * an order past its deadline (or already swept) — answered `bot.order.expired` or
 * `bot.order.not_awaiting_payment` as a bare refusal, which the wizard sends as a NEW message,
 * so three taps on a stale screen were three expiry messages minutes apart. Now the answer is
 * the screen itself, landed `CLOSED` on the tapped message: its card, copy and pay buttons are
 * gone, so it cannot be tapped into another one.
 *
 * Null for every other refusal, and for an order that has not ended (or cannot be read as this
 * customer's) — the caller's refusal stands. Writes nothing: the order is read, not moved.
 */
export async function orderEndedRefusal(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: Pick<CustomerRecord, 'id'>,
  orderId: string,
  error: unknown,
): Promise<PendingReply | null> {
  if (
    !isNexaError(error) ||
    (error.code !== COMMERCE_ERROR_CODES.ORDER_EXPIRED &&
      error.code !== COMMERCE_ERROR_CODES.ORDER_STATE_INVALID)
  ) {
    return null;
  }
  let order: OrderRecord;
  try {
    order = await rt.deps.orders.orderForCustomer(scope, actor, {
      customerId: customer.id,
      orderId,
    });
  } catch {
    // Not this customer's, or unreadable: the ordinary refusal answers it.
    return null;
  }
  return endedOrderScreen(rt, order);
}

/**
 * The ended screen for an order already read, landed `CLOSED` on the tapped message; null when
 * the order has not ended. For a handler that reads the order itself before deciding (the
 * payment-method selector), so a stale tap there is answered the same way.
 */
export function endedOrderScreen(rt: BotRuntime, order: OrderRecord): PendingReply | null {
  const ending = endingOf(order, rt.deps.clock.now());
  if (ending === null) return null;
  const content = endedContent(order, ending);
  return {
    key: content.templateKey,
    values: content.values,
    buttons: content.buttons,
    orderId: order.id,
    wizard: { kind: 'ORDER', step: 'CLOSED', subjectId: order.id },
  };
}

/**
 * The customer's cancellation, answered on the ORDER's own payment message: that message is
 * edited into the cancelled screen (summary kept, nothing that pays), the order's other open
 * screens lose their buttons, and the confirmation question the customer tapped is removed —
 * so the chat holds one message about this order, not a payment screen, a question and a
 * «سفارش لغو شد» under them.
 *
 * Called AFTER the cancellation committed, outside every transaction, like the router's own
 * reply. Through `WizardInvoiceScreens.answerOrder` — the lane's FIX-08 edit — with no settle
 * window: this turn is the writer, and a turn still HOLDING the message (a tap on it in
 * flight) makes it answer `WAIT`, which is treated as "not edited".
 *
 * Returns the reply: nothing (`key: null`) when the order's message took the screen, else the
 * same screen EDITED onto the question message (sent once as a new message when Telegram
 * cannot edit that one either), with the `ORDER_CANCELLED` lane fallback for a rate limit.
 */
export async function cancelledOrderReply(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: Pick<CustomerRecord, 'id'>,
  orderId: string,
  tapped: CardMessageRef | null,
): Promise<PendingReply> {
  const fallback = { kind: 'ORDER_CANCELLED' as const, subjectId: orderId };
  let order: OrderRecord | null = null;
  try {
    order = await rt.deps.orders.orderForCustomer(scope, actor, {
      customerId: customer.id,
      orderId,
    });
  } catch {
    order = null;
  }
  if (order === null || order.state !== 'CANCELLED') {
    // Not readable as cancelled (a race with nothing a customer can do): the plain sentence.
    return { key: 'bot.order.cancelled', values: {}, buttons: [], orderId: null, fallback };
  }
  const content = endedContent(order, 'CANCELLED');
  const answer = rt.deps.invoiceScreens?.answerOrder;
  if (answer !== undefined && tapped !== null) {
    let answered: Awaited<ReturnType<typeof answer>> = null;
    try {
      answered = await answer.call(
        rt.deps.invoiceScreens,
        scope,
        orderId,
        { chatId: tapped.chatId, botInstanceId: tapped.botInstanceId as BotInstanceId },
        0,
        content,
        ORDER_END_ANSWER_STEPS,
      );
    } catch {
      answered = null;
    }
    const edited =
      answered !== null &&
      !('kind' in answered) &&
      (answered.outcome === 'DELIVERED' || answered.outcome === 'UNKNOWN');
    if (edited) {
      // The question is spent: removed, or — when Telegram will not delete it — left buttonless.
      await retireQuestion(rt, scope, tapped);
      return { key: null, values: {}, buttons: [], orderId: null };
    }
  }
  return {
    key: content.templateKey,
    values: content.values,
    buttons: content.buttons,
    orderId: null,
    edit: true,
    fallback,
  };
}

async function retireQuestion(
  rt: BotRuntime,
  scope: TenantContext,
  tapped: CardMessageRef,
): Promise<void> {
  const ref = {
    chatId: tapped.chatId,
    messageId: tapped.messageId,
    botInstanceId: tapped.botInstanceId as BotInstanceId,
  };
  try {
    const removed = await rt.deps.messenger.remove?.(scope, ref);
    if (removed?.outcome === 'DELIVERED') return;
    await rt.deps.messenger.clearButtons?.(scope, ref);
  } catch {
    // Its one button re-checks the order on a tap, and the order is cancelled.
  }
}
