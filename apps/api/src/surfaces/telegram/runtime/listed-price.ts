import type { Money } from '@nexa/contracts';
import type { ListedPersonalDiscount } from '../../../modules/commerce/pricing/application/pricing.service.js';
import type { CustomerCallbackButton } from '../../../modules/commerce/messaging/application/ports.js';

/**
 * R11 A9 — how a bot price list draws a line the customer's personal discount wins.
 *
 * The figures are the application's: `personalDiscount` is set by
 * `PricingService.personalListPrices`, the boundary the line's draft is priced at, so its
 * `price` IS the invoice's. This file decides nothing about money; it only puts the two
 * figures where the messenger draws them — the discounted price in the label, and the price
 * it replaces (what the list showed before) with the percent on the button. The messenger
 * writes the button with the discounted price only and «(N٪ تخفیف)» (R11 hotfix); the price
 * it replaces is drawn struck through only in the rich plan table. A line it does not win is
 * drawn exactly as before.
 */
interface ListedLine {
  readonly price: Money | null;
  readonly personalDiscount: ListedPersonalDiscount | null;
}

/** The price a line's label carries: the quote's when the personal discount wins it. */
export function listedPrice(line: ListedLine & { readonly price: Money }): Money {
  return line.personalDiscount === null ? line.price : line.personalDiscount.price;
}

/** The button field the messenger tags by (the rich table strikes); nothing otherwise. */
export function personalDiscountOf(
  line: ListedLine,
): Pick<CustomerCallbackButton, 'personalDiscount'> {
  if (line.personalDiscount === null || line.price === null) return {};
  return {
    personalDiscount: { listPrice: line.price, percent: line.personalDiscount.percent },
  };
}
