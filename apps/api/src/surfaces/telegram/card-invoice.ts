import { plainAmount, toPersianDigits, type Money } from '@nexa/contracts';
import { inlineLabel } from '../../modules/commerce/messaging/application/inline-buttons.js';
import type { CustomerButton } from '../../modules/commerce/messaging/application/ports.js';
import {
  cardNumberToCopy,
  groupedCardNumber,
} from '../../modules/commerce/payments/domain/card-number.js';
import { transferFigures } from '../../modules/commerce/payments/domain/transfer-figures.js';

/**
 * R8 A2: the owner-approved card-to-card invoice, shared by the TonPays Telegram card screen
 * and the manual card-to-card invoice so the two cannot present one amount two ways.
 *
 *     🧾 فاکتور کارت‌به‌کارت
 *     مبلغ قابل واریز:
 *     <b>۲۵۰٬۹۹۰ ریال</b>
 *     (معادل ۲۵٬۰۹۹ تومان)
 *     …
 *     [📋 کپی مبلغ (ریال)] [💳 کپی شماره کارت]
 *     [🔄 تعویض کارت]                       (only while a switch is allowed)
 *     [📤 ارسال رسید] [❌ لغو فاکتور]
 *     [🏠 منوی اصلی]
 *
 * Every figure here is display and clipboard only. The amount handed in is already what the
 * customer must transfer; what Nexa settles, credits and refunds is the payment's principal.
 */

/** The keyboard rows, in the order they are drawn. The main-menu button keeps its own row. */
export const CARD_INVOICE_ROW = { COPY: 0, SWITCH: 1, ACTIONS: 2 } as const;

/**
 * `{amountRial}` and `{amountToman}`. `amountToman` is omitted when the amount is not a whole
 * toman (its line is then dropped). A currency that is neither — no sales currency is
 * (`SALES_CURRENCY_CODES`) — is shown as its plain figure rather than failing the render.
 */
export function cardInvoiceAmountValues(amount: Money): {
  readonly amountRial: string;
  readonly amountToman?: string;
} {
  const figures = transferFigures(amount);
  if (figures === null) return { amountRial: toPersianDigits(plainAmount(amount)) };
  return {
    amountRial: figures.amountRial,
    ...(figures.amountToman === null ? {} : { amountToman: figures.amountToman }),
  };
}

/** `{cardGrouped}`: four groups of four, or the card exactly as sent. */
export function cardInvoiceCardValues(cardNumber: string): { readonly cardGrouped: string } {
  return { cardGrouped: groupedCardNumber(cardNumber) };
}

/** «📋 کپی مبلغ (ریال)»: the amount in RIAL, bare ASCII digits, no separators. */
export function copyRialAmountButton(amount: Money): CustomerButton {
  return {
    ...inlineLabel('payment.copy_transfer_amount'),
    copyText: transferFigures(amount)?.copyRial ?? plainAmount(amount),
    row: CARD_INVOICE_ROW.COPY,
  };
}

/** «💳 کپی شماره کارت»: the sixteen digits without spaces (the card as sent otherwise). */
export function copyCardNumberButton(cardNumber: string): CustomerButton {
  return {
    ...inlineLabel('payment.copy_card'),
    copyText: cardNumberToCopy(cardNumber),
    row: CARD_INVOICE_ROW.COPY,
  };
}
