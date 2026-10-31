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
import {
  ORDER_END_ANSWER_STEPS,
  orderScreenSettleMs,
} from '../../../modules/commerce/messaging/application/order-screen-answer.js';
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
 * The order's ending at `now`: EXPIRED once the sweep moved it; CANCELLED once withdrawn; and
 * a DRAFT past its price hold, which nothing will ever sweep (`OrderRepository.expireDue`
 * covers `AWAITING_PAYMENT` only) and which `OrderService.confirm` refuses from that instant.
 *
 * An `AWAITING_PAYMENT` order past its deadline is NOT read as ended (Codex, #354). Its
 * deadline alone does not decide it: `DrizzleOrderRepository.expireDue` keeps an order whose
 * payment is still live — a transfer whose receipt is under review, a TonPays attempt in a
 * provider review, an `UNKNOWN` money-probably-sent — so an operator can still confirm it.
 * Drawing «⏳ مهلت پرداخت این سفارش به پایان رسید» with «🔁 سفارش دوباره» on such an order would
 * invite a customer who has already paid to pay again. The sweep is the one judge of that, so
 * only its outcome — the order's own `EXPIRED` state — is trusted here; until it runs (at most
 * a minute) a tap is answered by the caller's refusal, as before A11.
 */
function endingOf(order: OrderRecord, now: Date): OrderEnding | null {
  if (order.state === 'EXPIRED') return 'EXPIRED';
  if (order.state === 'CANCELLED') return 'CANCELLED';
  if (
    order.state === 'DRAFT' &&
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
    // A definite 429 puts the message back on the step it was tapped at (Codex, #354).
    wizard: { kind: 'ORDER', step: 'CLOSED', subjectId: order.id, reopenOnRateLimit: true },
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
 * reply. Through `WizardInvoiceScreens.answerOrder` — the lane's FIX-08 edit — WITH the lane's
 * settle window (Codex, #354): this turn owns the question, not the order's payment message.
 * Another writer may still have an edit of that message in flight — the gateway worker's
 * `refresh` after it moved the invoice, a tap whose landing already cleared its hold — and an
 * edit landing after the cancelled screen would put the payment instructions and buttons
 * back. So while the message is settling (`WAIT`), the answer is DEFERRED: the
 * `ORDER_CANCELLED` row is queued for the end of the window, the lane edits the message once
 * it is left alone (or sends once), and the spent question is removed now.
 *
 * Returns the reply: nothing (`key: null`) when the order's message took the screen or the
 * answer was deferred, else the same screen EDITED onto the question message (sent once as a
 * new message when Telegram cannot edit that one either), with the `ORDER_CANCELLED` lane
 * fallback for a rate limit.
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
  let order: OrderRecord | null;
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
    let answered: Awaited<ReturnType<typeof answer>>;
    try {
      answered = await answer.call(
        rt.deps.invoiceScreens,
        scope,
        orderId,
        { chatId: tapped.chatId, botInstanceId: tapped.botInstanceId as BotInstanceId },
        rt.deps.orderScreenSettleMs ?? orderScreenSettleMs(0),
        content,
        ORDER_END_ANSWER_STEPS,
      );
    } catch {
      answered = null;
    }
    if (answered !== null && 'kind' in answered) {
      // Still settling: the lane answers on the message once it is left alone.
      if (await deferToLane(rt, scope, customer, orderId, answered.until)) {
        await retireQuestion(rt, scope, tapped);
        return { key: null, values: {}, buttons: [], orderId: null };
      }
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

/**
 * Queues the order's `ORDER_CANCELLED` notice, due when the message's settle window ends. The
 * row is the durable answer: one per order (`customer_notifications_subject_key`), rendered
 * from the order, edited onto its message by the lane under the same settle rule. False when
 * it could not be queued — the turn then answers on the question itself, as it would have.
 */
async function deferToLane(
  rt: BotRuntime,
  scope: TenantContext,
  customer: Pick<CustomerRecord, 'id'>,
  orderId: string,
  until: Date,
): Promise<boolean> {
  try {
    const wait = Math.max(0, until.getTime() - rt.deps.clock.now().getTime());
    await rt.deps.queueRateLimitedFact(scope, customer.id, 'ORDER_CANCELLED', orderId, wait);
    return true;
  } catch {
    return false;
  }
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
