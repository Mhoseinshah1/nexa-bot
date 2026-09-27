import { TELEGRAM_STARS_CURRENCY, TELEGRAM_STARS_PRE_CHECKOUT_MARGIN_MS } from '@nexa/contracts';

/**
 * What a Stars payment update is checked against (Package A, audit §2.5–§2.6). Every
 * value is Nexa's own row except `update`, which is what Telegram sent.
 */
export interface StarsCheckFacts {
  readonly invoice: {
    readonly botInstanceId: string | null;
    readonly sentAmount: bigint;
    readonly providerUnit: string;
  };
  readonly payment: {
    readonly state: string;
    readonly expiresAt: Date | null;
    readonly orderId: string | null;
  };
  /** Null: the attempt's customer no longer exists in this tenant. */
  readonly customer: { readonly telegramUserId: string; readonly status: string } | null;
  /** The order's state for an order payment; null for a top-up, or a missing order. */
  readonly orderState: string | null;
  /** The bot whose webhook delivered the update. */
  readonly botInstanceId: string;
  readonly update: {
    readonly payerTelegramUserId: string;
    readonly currency: string;
    readonly totalAmount: bigint;
  };
  readonly now: Date;
}

/**
 * Why an update does not belong to the attempt it names. The same checks for pre-checkout
 * and for `successful_payment`: the bot, the payer, the currency and the amount.
 */
export type StarsIdentityMismatch = 'WRONG_BOT' | 'WRONG_PAYER' | 'WRONG_CURRENCY' | 'WRONG_AMOUNT';

export function starsIdentityMismatch(facts: StarsCheckFacts): StarsIdentityMismatch | null {
  if (facts.invoice.botInstanceId === null || facts.invoice.botInstanceId !== facts.botInstanceId) {
    return 'WRONG_BOT';
  }
  if (
    facts.customer === null ||
    facts.customer.telegramUserId !== facts.update.payerTelegramUserId
  ) {
    return 'WRONG_PAYER';
  }
  if (
    facts.update.currency !== TELEGRAM_STARS_CURRENCY ||
    facts.invoice.providerUnit !== TELEGRAM_STARS_CURRENCY
  ) {
    return 'WRONG_CURRENCY';
  }
  if (facts.update.totalAmount !== facts.invoice.sentAmount) return 'WRONG_AMOUNT';
  return null;
}

export type StarsPreCheckoutRefusal =
  StarsIdentityMismatch | 'CUSTOMER_BLOCKED' | 'NOT_PENDING' | 'TOO_LATE' | 'ORDER_CLOSED';

/**
 * Whether Nexa may let Telegram charge the customer now (`answerPreCheckoutQuery`).
 *
 * The identity checks, and then whether the attempt could still be SETTLED: a PENDING
 * payment with at least the margin before its deadline, whose order (if it has one) is
 * still awaiting payment, for a customer who is not blocked. The margin is the one piece of
 * judgement — Telegram charges between this answer and `successful_payment`, and a payment
 * that lands after the deadline settles nothing — so approval stops early rather than at
 * the deadline. Null: approve.
 */
export function starsPreCheckoutRefusal(facts: StarsCheckFacts): StarsPreCheckoutRefusal | null {
  const mismatch = starsIdentityMismatch(facts);
  if (mismatch !== null) return mismatch;
  if (facts.customer !== null && facts.customer.status === 'BLOCKED') return 'CUSTOMER_BLOCKED';
  if (facts.payment.state !== 'PENDING') return 'NOT_PENDING';
  if (
    facts.payment.expiresAt === null ||
    facts.now.getTime() + TELEGRAM_STARS_PRE_CHECKOUT_MARGIN_MS > facts.payment.expiresAt.getTime()
  ) {
    return 'TOO_LATE';
  }
  if (facts.payment.orderId !== null && facts.orderState !== 'AWAITING_PAYMENT') {
    return 'ORDER_CLOSED';
  }
  return null;
}
