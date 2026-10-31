// Card-to-card payment: the transfer instruction, receipts, switching card, withdrawing a
// payment, and the TonPays card actions (receipt, card change, cancel, refund card).
// Moved verbatim out of bot-runtime.ts; BotRuntime keeps a forwarder for every one a router calls.
import {
  type ActorContext,
  type BotInstanceId,
  COMMERCE_ERROR_CODES,
  isNexaError,
  type PaymentId,
  paymentTrackingCode,
  type TemplateKey,
  type TemplateValues,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { InboundReceiptFile } from '../../../modules/commerce/payments/application/receipt-ports.js';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import { inlineLabel } from '../../../modules/commerce/messaging/application/inline-buttons.js';
import type { ManualTransferInstruction } from '../../../modules/commerce/payments/application/payment.service.js';
import type { GatewayAttemptView } from '../../../modules/commerce/payments/application/gateway-payment.service.js';
import {
  cancelTapRefusal,
  decideCardChange,
} from '../../../modules/commerce/payments/domain/tonpays-telegram.js';
import { amountToTransfer } from '../../../modules/commerce/payments/domain/amount-to-transfer.js';
import {
  CARD_INVOICE_ROW,
  cardInvoiceAmountValues,
  copyCardNumberButton,
  copyRialAmountButton,
} from '../card-invoice.js';
import type { TelegramWizardRecord } from '../../../modules/commerce/messaging/application/telegram-message-state.js';
import type { WizardDirective } from '../wizard-state.js';
import {
  CANCEL_PAY_ASK_CALLBACK_PREFIX,
  CANCEL_PAY_CALLBACK_PREFIX,
  GATEWAY_CANCEL_CALLBACK_PREFIX,
  PAY_SENT_CALLBACK_PREFIX,
  PAY_SWITCH_CARD_CALLBACK_PREFIX,
} from './callbacks.js';
import { updateIdOf } from './intent-of.js';
import { mainMenuButton } from './keyboards.js';
import { refusal } from './refusals.js';
import { editSent, type PendingReply, staleCallbackReply } from './replies.js';
import { cardCheck } from './payment-screens.js';
import { gatewayAttemptReply } from './checkout-flow.js';
import { orderEndedRefusal } from './order-end-flow.js';
import type { BotRuntime } from '../bot-runtime.js';

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
export async function manualPayment(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  orderId: string,
  customer: CustomerRecord,
  idempotencyKey: string,
): Promise<PendingReply> {
  try {
    const before = await rt.deps.orders.orderForCustomer(scope, actor, {
      customerId: customer.id,
      orderId,
    });
    const instruction = await rt.deps.checkout.payByCard(
      scope,
      actor,
      customer.id,
      before,
      idempotencyKey,
    );
    return transferInstruction(rt, scope, instruction, orderId);
  } catch (error) {
    // R11 A11: an order that ended is answered ON the tapped screen, not by a new message.
    return (await orderEndedRefusal(rt, scope, actor, customer, orderId, error)) ?? refusal(error);
  }
}

/**
 * «📤 ارسال فیش واریزی» (TonPays Telegram, §8.3): opens the payment-scoped receipt window
 * and asks for ONE photo, as its own message — the payment message stays as it is. Refused
 * (re-decided against the rows) with the attempt's current screen: closed, in review, a
 * receipt already on its way. The tap extends nothing.
 */
export async function gatewayReceipt(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  paymentId: string,
  customer: CustomerRecord,
  botInstanceId: BotInstanceId,
): Promise<PendingReply> {
  const view = await rt.deps.gateway.attemptFor(scope, customer.id, paymentId);
  /*
   * TPTG-19: another customer's payment, another bot's attempt, or no such lane is
   * answered as closed — never with anything about the attempt.
   */
  if (
    view === null ||
    view.invoice.botInstanceId !== botInstanceId ||
    rt.deps.gatewayReceipts === undefined
  ) {
    return {
      key: 'bot.payment.gateway_closed',
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
    };
  }
  const window = await rt.deps.gatewayReceipts.openReceiptCapture(scope, actor, {
    customerId: customer.id,
    paymentId: view.payment.id,
    botInstanceId,
  });
  if (window === null) return refusedCardTap(rt, scope, view);
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
export async function gatewayCardChange(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  paymentId: string,
  customer: CustomerRecord,
  botInstanceId: BotInstanceId,
  idempotencyKey: string,
): Promise<PendingReply> {
  const view = await rt.deps.gateway.attemptFor(scope, customer.id, paymentId);
  /*
   * TPTG-19: another customer's payment, another bot's attempt, or no such lane is
   * answered as closed — never with anything about the attempt.
   */
  if (
    view === null ||
    view.invoice.botInstanceId !== botInstanceId ||
    rt.deps.gatewayReceipts === undefined
  ) {
    return {
      key: 'bot.payment.gateway_closed',
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
    };
  }
  const requested = await rt.deps.gatewayReceipts.requestCardChange(scope, actor, {
    customerId: customer.id,
    paymentId: view.payment.id,
    botInstanceId,
    idempotencyKey: `${idempotencyKey}:card-change`,
  });
  const fresh = (await rt.deps.gateway.attemptFor(scope, customer.id, paymentId)) ?? view;
  if (requested) {
    return gatewayAttemptReply(rt, { ...fresh, reissued: true }, fresh.payment.orderId, scope);
  }
  /*
   * R8 A2: the button is drawn during a cooldown, so a press inside one is answered with the
   * seconds left and the invoice stays exactly as it is — the manual switch's answer
   * (R5C-1). The refusal itself was decided under the payment's lock; this only explains it.
   */
  if (fresh.payment.state === 'PENDING') {
    const facts = await rt.deps.gateway.cardFactsFor(scope, fresh.invoice);
    const decision = decideCardChange(
      fresh.invoice,
      facts?.latestChange ?? null,
      rt.deps.clock.now(),
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
  return refusedCardTap(rt, scope, fresh);
}

/**
 * «❌ لغو فاکتور» (Round 6): the question first. Writes nothing. Offered only while the
 * cancel can be asked for (a `pending` invoice, the customer window, nothing in flight);
 * otherwise the attempt's current screen is redrawn. The confirm button carries the
 * destructive prefix; «🔎» is the way back.
 */
export async function gatewayCancelAsk(
  rt: BotRuntime,
  scope: TenantContext,
  paymentId: string,
  customer: CustomerRecord,
  botInstanceId: BotInstanceId,
): Promise<PendingReply> {
  const view = await rt.deps.gateway.attemptFor(scope, customer.id, paymentId);
  if (
    view === null ||
    view.invoice.botInstanceId !== botInstanceId ||
    rt.deps.gatewayReceipts === undefined
  ) {
    return {
      key: 'bot.payment.gateway_closed',
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
    };
  }
  const offered = await rt.deps.gatewayReceipts.cancelOffered(scope, {
    customerId: customer.id,
    paymentId: view.payment.id,
    botInstanceId,
  });
  if (!offered) return refusedCancelTap(rt, scope, view);
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
export async function gatewayCancel(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  paymentId: string,
  customer: CustomerRecord,
  botInstanceId: BotInstanceId,
  idempotencyKey: string,
): Promise<PendingReply> {
  const view = await rt.deps.gateway.attemptFor(scope, customer.id, paymentId);
  if (
    view === null ||
    view.invoice.botInstanceId !== botInstanceId ||
    rt.deps.gatewayReceipts === undefined
  ) {
    return {
      key: 'bot.payment.gateway_closed',
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
    };
  }
  const requested = await rt.deps.gatewayReceipts.requestCancel(scope, actor, {
    customerId: customer.id,
    paymentId: view.payment.id,
    botInstanceId,
    idempotencyKey: `${idempotencyKey}:gateway-cancel`,
  });
  const fresh = (await rt.deps.gateway.attemptFor(scope, customer.id, paymentId)) ?? view;
  return requested
    ? gatewayAttemptReply(rt, { ...fresh, reissued: true }, fresh.payment.orderId, scope)
    : refusedCancelTap(rt, scope, fresh);
}

/**
 * R11 A8: a cancel tap that was refused (`gq:` or `gz:`). A cancel button may still be on screen
 * after the invoice's fate is known — a lost cancel answer keeps it drawn (owner), and an older
 * message keeps whatever it had. A PAID invoice is refused in so many words and nothing moves;
 * one Nexa KNOWS was cancelled says «فاکتور قبلاً لغو شده»; anything else redraws the attempt
 * as it stands. Reads only: the refusal itself was decided under the payment's lock.
 */
async function refusedCancelTap(
  rt: BotRuntime,
  scope: TenantContext,
  view: GatewayAttemptView,
): Promise<PendingReply> {
  const facts = await rt.deps.gateway.cardFactsFor(scope, view.invoice);
  const reference = paymentTrackingCode(view.payment);
  switch (cancelTapRefusal(view.payment, view.invoice, facts?.latestCancel ?? null)) {
    case 'PAID':
      return {
        key: 'bot.payment.gateway_not_pending',
        values: { reference },
        buttons: [cardCheck(view.payment.id), mainMenuButton()],
        orderId: null,
      };
    case 'ALREADY_CANCELLED':
      return {
        key: 'bot.payment.gateway_cancel_already_cancelled',
        values: { reference },
        buttons: [mainMenuButton()],
        orderId: null,
      };
    case null:
      return refusedCardTap(rt, scope, view);
  }
}

/**
 * «💳 ثبت کارت بازگشت وجه» (Round 6): opens the text window that reads the refund card and
 * asks for it as its own message. Offered only for an overpaid invoice whose refund is not
 * already pending or in flight.
 */
export async function gatewayRefundCardPrompt(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  paymentId: string,
  customer: CustomerRecord,
  botInstanceId: BotInstanceId,
  idempotencyKey: string,
  updateId: bigint | undefined,
): Promise<PendingReply> {
  const view = await rt.deps.gateway.attemptFor(scope, customer.id, paymentId);
  if (
    view === null ||
    view.invoice.botInstanceId !== botInstanceId ||
    rt.deps.gatewayReceipts === undefined
  ) {
    return {
      key: 'bot.payment.gateway_closed',
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
    };
  }
  const offered = await rt.deps.gatewayReceipts.refundCardOffered(scope, {
    customerId: customer.id,
    paymentId: view.payment.id,
    botInstanceId,
  });
  if (!offered) return refusedCardTap(rt, scope, view);
  await rt.deps.captures.open(scope, actor, {
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
export async function gatewayRefundCardText(
  rt: BotRuntime,
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
  if (paymentId === null || rt.deps.gatewayReceipts === undefined) return null;
  const view = await rt.deps.gateway.attemptFor(scope, customer.id, paymentId);
  if (view === null || view.invoice.botInstanceId !== input.botInstanceId) {
    return {
      key: 'bot.payment.gateway_closed',
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
    };
  }
  const result = await rt.deps.gatewayReceipts.requestRefund(scope, actor, {
    customerId: customer.id,
    paymentId: view.payment.id,
    botInstanceId: input.botInstanceId,
    idempotencyKey: `${input.idempotencyKey}:gateway-refund`,
    text,
  });
  const reference = paymentTrackingCode(view.payment);
  if (result === 'INVALID') {
    const updateId = updateIdOf(input.update);
    await rt.deps.captures.open(scope, actor, {
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
  if (result === 'REFUSED') return refusedCardTap(rt, scope, view);
  const refunds = await rt.deps.gateway.cardFactsFor(scope, view.invoice);
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
export function refusedCardTap(
  rt: BotRuntime,
  scope: TenantContext,
  view: GatewayAttemptView,
): Promise<PendingReply> | PendingReply {
  if (view.payment.state === 'PENDING' || view.payment.state === 'UNKNOWN') {
    return gatewayAttemptReply(rt, { ...view, reissued: true }, view.payment.orderId, scope);
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
export async function gatewayReceiptPhoto(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  botInstanceId: BotInstanceId,
  file: InboundReceiptFile,
): Promise<PendingReply | null> {
  if (rt.deps.gatewayReceipts === undefined) return null;
  /*
   * FIX-02 (Codex review of #253): the window's payment, read BEFORE the photo can close it,
   * so a photo that arrives after the window's deadline is answered with the code the
   * invoice carried. Only a read; `receivePhoto` decides everything, again, under its lock.
   */
  const window = await rt.deps.gatewayReceipts.openCaptureFor(scope, botInstanceId, customer.id);
  const result = await rt.deps.gatewayReceipts.receivePhoto(scope, actor, {
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
        values: await ownedTrackingCode(rt, scope, customer, botInstanceId, window?.paymentId),
      };
  }
}

/**
 * FIX-02: `{ reference }` for a gateway attempt that is THIS customer's, in THIS bot — the
 * ownership check `attemptFor` makes — else `{}`, whose optional line is then dropped. A
 * payment that is not theirs is never named (TPTG-19).
 */
export async function ownedTrackingCode(
  rt: BotRuntime,
  scope: TenantContext,
  customer: CustomerRecord,
  botInstanceId: BotInstanceId,
  paymentId: string | undefined,
): Promise<TemplateValues> {
  if (paymentId === undefined) return {};
  const view = await rt.deps.gateway.attemptFor(scope, customer.id, paymentId);
  if (view === null || view.invoice.botInstanceId !== botInstanceId) return {};
  return { reference: paymentTrackingCode(view.payment) };
}

/**
 * R12 F3 (lead review): a customer's own PENDING card-to-card transfer with NO receipt filed,
 * drawn as its own invoice again — the amount, the card and «📤 ارسال رسید» — so a customer who
 * may already have transferred sends the receipt for THIS payment instead of being told it is
 * "being checked" (nothing is) or being handed a second reference. Null for every other
 * payment: a gateway attempt, one with a receipt filed, one no longer pending, another
 * customer's. Reads only; the invoice is read from the payment's own issued snapshot.
 */
export async function unreceiptedTransfer(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: Pick<CustomerRecord, 'id'>,
  paymentId: string,
): Promise<PendingReply | null> {
  const instruction = await rt.deps.payments.pendingTransferInstructionForCustomer(
    scope,
    customer.id,
    paymentId,
  );
  if (instruction === null) return null;
  const filed = await rt.deps.receipts.filedForCustomer(
    scope,
    actor,
    customer.id,
    instruction.payment.id,
  );
  return filed ? null : transferInstruction(rt, scope, instruction, instruction.payment.orderId);
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
export async function transferInstruction(
  rt: BotRuntime,
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
    destination === null || rt.deps.cardSwitch === undefined
      ? null
      : await rt.deps.cardSwitch.offer(scope, payment);
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
        : { destination: await rt.deps.destinations.render(scope, destination) }),
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
export async function cancelPaymentAsk(
  rt: BotRuntime,
  scope: TenantContext,
  paymentId: string,
  customer: CustomerRecord,
): Promise<PendingReply> {
  const payment = await rt.deps.payments.pendingTransferForCustomer(scope, customer.id, paymentId);
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

export async function cancelPayment(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  paymentId: string,
  customer: CustomerRecord,
  idempotencyKey: string,
): Promise<PendingReply> {
  try {
    await rt.deps.payments.withdrawPending(scope, actor, customer.id, {
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
export async function switchCard(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  paymentId: string,
  expectedSequence: number,
  customer: CustomerRecord,
  idempotencyKey: string,
): Promise<PendingReply> {
  if (rt.deps.cardSwitch === undefined) return staleCallbackReply();
  try {
    const result = await rt.deps.cardSwitch.switchCard(scope, actor, customer.id, {
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
      ...(await transferInstruction(rt, scope, instruction, instruction.payment.orderId)),
      ...refused,
    };
  } catch (error) {
    return refusal(error);
  }
}

export async function signalTransferSent(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  paymentId: string,
  customer: CustomerRecord,
  botInstanceId: BotInstanceId,
  idempotencyKey: string,
): Promise<PendingReply> {
  try {
    const { payment, receiptWindow } = await rt.deps.payments.signalTransferSent(
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
export async function submitReceipt(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  botInstanceId: BotInstanceId,
  chatId: string | null,
  file: InboundReceiptFile,
  idempotencyKey: string,
): Promise<PendingReply> {
  try {
    const submitted = await rt.deps.receipts.submit(scope, actor, customer.id, {
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
        await finaliseReceiptInvoice(
          rt,
          scope,
          actor,
          botInstanceId,
          chatId,
          customer.id,
          submitted.paymentId,
          idempotencyKey,
        );
      } catch (error) {
        rt.deps.logger?.error(
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
export async function finaliseReceiptInvoice(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  botInstanceId: BotInstanceId,
  chatId: string,
  customerId: UserId,
  paymentId: PaymentId,
  updateKey: string,
): Promise<void> {
  const state = rt.deps.messageState;
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
    rt.deps.messenger,
    scope,
    {
      chatId: target.chatId,
      messageId: target.messageId,
      botInstanceId: target.botInstanceId,
      templateKey: RECEIPT_INVOICE_FINAL_KEY,
      values: await receiptInvoiceFinalValues(rt, scope, actor, customerId, paymentId),
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
export async function receiptInvoiceFinalValues(
  rt: BotRuntime,
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
    const reference = await rt.deps.receipts.trackingCodeForCustomer(
      scope,
      actor,
      customerId,
      paymentId,
    );
    return reference === null ? {} : { reference };
  } catch (error) {
    rt.deps.logger?.error(
      { err: error, paymentId, tenantId: scope.tenantId },
      'reading the tracking code for the final invoice failed; edited without it',
    );
    return {};
  }
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
export async function settleReceiptPrompt(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  target: TelegramWizardRecord,
  prompt: { readonly customerId: string; readonly paymentId: string },
): Promise<void> {
  const state = rt.deps.messageState;
  if (state === undefined) return;
  const where = { paymentId: prompt.paymentId, id: target.id };
  await state.moveAll(scope, actor, where, ['RECEIPT_WAIT'], 'RECEIPT_WAIT');
  const filed = await rt.deps.receipts.filedForCustomer(
    scope,
    actor,
    prompt.customerId as UserId,
    prompt.paymentId as PaymentId,
  );
  if (!filed) return;
  const moved = await state.moveAll(scope, actor, where, ['RECEIPT_WAIT'], 'RECEIPT_REVIEW');
  if (moved.length === 0) return;
  const values = await receiptInvoiceFinalValues(
    rt,
    scope,
    actor,
    prompt.customerId as UserId,
    prompt.paymentId as PaymentId,
  );
  for (const wizard of moved) {
    await editSent(
      rt.deps.messenger,
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

/**
 * A10: the invoice's FINAL text once a receipt is on the payment, edited in, with no button.
 * The claim's sentence — recorded, nothing received or verified, a person will check — and
 * NOT `bot.payment.receipt_received`, which is the one new message the first receipt sends:
 * the same two sentences twice, one above the other, would be noise.
 */
const RECEIPT_INVOICE_FINAL_KEY: TemplateKey = 'bot.payment.received_for_review';
