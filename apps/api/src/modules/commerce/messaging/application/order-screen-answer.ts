import type { BotInstanceId, TelegramWizardStep } from '@nexa/contracts';
import type { TelegramWizardRecord } from './telegram-message-state.js';

/**
 * FIX-08 (batch 2026-10-10): a paid order's OUTCOME answered on the order's own payment
 * message, by editing it, instead of a second message under it.
 *
 * Before: the pre-invoice (or invoice) was edited to «پرداخت انجام شد؛ نتیجه در پیام
 * جداگانه…» and the notification lane then sent the result — «سرویس تمدید شد…», «درخواست
 * شما روی سرور اعمال شد» — as a NEW message. Two messages for one purchase. Now the lane's
 * delivery of that same notification row EDITS the payment message into the result.
 *
 * Nothing about the lane's durability changes, which is why this is safe to do with a
 * financial notice:
 *
 *   - the row is still claimed and stamped (`markSendStarted`) BEFORE the Telegram call, so
 *     two dispatcher replicas, a redelivery and a crash still produce at most one answer;
 *   - the edit is ONE Telegram request with the send's outcomes, recorded exactly as a send
 *     is: DELIVERED (Telegram's «message is not modified» included), a 429 back on the queue
 *     with no attempt spent (and an edit, unlike a send, is safe to repeat), UNKNOWN left
 *     UNCONFIRMED and never retried — not as an edit and not as a send;
 *   - an edit Telegram definitely refuses (the message was deleted, is too old, is not a text
 *     message) falls back to the SEND the lane always made, once. The customer is never left
 *     without the notice.
 *
 * ## The one race, and the settle window
 *
 * Another writer may still be putting its OWN text on that message: the customer's tap lands
 * the screen first and edits it afterwards, and the gateway worker moves the invoice and then
 * edits it. If the lane's edit landed in between, that late edit would bury the result under
 * «پرداخت انجام شد…» and the notice would be lost on a message recorded DELIVERED. So the lane
 * answers on the message only once it has been left alone for `settleMs` — the messenger's own
 * request timeout, the longest any such edit can still be in flight — and while a turn holds
 * it (`busy_until`). Until then the row is put back, with no attempt spent and no stamp, like
 * a quiet-hours hold.
 *
 * ## Which message, and which not
 *
 * The order's most recently touched `ORDER` wizard, in the customer's own chat, drawn by the
 * bot the notification goes through. Not a screen the gateway worker is still building
 * (`INVOICE_LOADING`, `INVOICE_PENDING`), and not the card-transfer receipt screens
 * (`RECEIPT_WAIT`, `RECEIPT_REVIEW`): a receipt is decided hours later by a person, and its
 * «received, under review» and the later result are two real facts — kept as two messages.
 */
export const ORDER_SCREEN_ANSWER_STEPS: readonly TelegramWizardStep[] = [
  'USERNAME',
  'DISCOUNT',
  'PREINVOICE',
  'AWAITING_PAYMENT',
  'METHODS',
  'INVOICE',
  'NOTICE',
  'CLOSED',
];

/**
 * The settle window for a messenger whose requests time out after `requestTimeoutMs`: the
 * longest another writer's edit of the message can still be in flight, plus a margin for the
 * write that preceded it. With the default 10 s timeout, an outcome waits at most ~12 s
 * after the customer's own tap — the provisioner's call to the panel is usually longer.
 */
export function orderScreenSettleMs(requestTimeoutMs: number): number {
  return Math.max(0, requestTimeoutMs) + ORDER_SCREEN_SETTLE_MARGIN_MS;
}
export const ORDER_SCREEN_SETTLE_MARGIN_MS = 2_000;

export type OrderScreenReadiness =
  /** No message to answer on: the lane sends, as it always did. */
  | { readonly kind: 'NONE' }
  /** A message to answer on, still being written by someone else: come back at `until`. */
  | { readonly kind: 'WAIT'; readonly until: Date }
  | { readonly kind: 'READY'; readonly wizard: TelegramWizardRecord };

/** Another writer still has the order's payment message: the lane comes back at `until`. */
export type OrderScreenWait = Extract<OrderScreenReadiness, { readonly kind: 'WAIT' }>;

/** The pure decision. `latest` is the order's most recently touched wizard. */
export function orderScreenReadiness(
  latest: TelegramWizardRecord | null,
  destination: { readonly chatId: string; readonly botInstanceId: BotInstanceId },
  now: Date,
  settleMs: number,
): OrderScreenReadiness {
  if (latest === null || latest.kind !== 'ORDER') return { kind: 'NONE' };
  if (!ORDER_SCREEN_ANSWER_STEPS.includes(latest.step)) return { kind: 'NONE' };
  // Only the customer's own chat, through the bot the notice goes through.
  if (latest.chatId !== destination.chatId) return { kind: 'NONE' };
  if (latest.botInstanceId !== destination.botInstanceId) return { kind: 'NONE' };
  const held =
    latest.busyUntil !== null && latest.busyUntil.getTime() > now.getTime()
      ? latest.busyUntil.getTime()
      : 0;
  const settled = latest.updatedAt.getTime() + Math.max(0, settleMs);
  const until = Math.max(held, settled);
  if (until > now.getTime()) return { kind: 'WAIT', until: new Date(until) };
  return { kind: 'READY', wizard: latest };
}
