import {
  MAX_ORDER_QUANTITY,
  PRICING_PRECEDENCE,
  money,
  resellerReductionMinor,
  type CurrencyCode,
  type Money,
  type PriceQuoteStep,
  type PricingStep,
  type ResellerPriceLayer,
} from '@nexa/contracts';
import type { OrderTotalsRecord } from '../../orders/application/ports.js';

/** The reseller layer that prices a customer, as `PricingService` applies it (R3). */
export interface ResellerPricingTerms {
  /** The reseller ROW's id: the `USER_OVERRIDE` step's rule id. */
  readonly resellerId: string;
  readonly customerId: string;
  readonly tierId: string;
  readonly tierName: string;
  readonly layer: ResellerPriceLayer;
  readonly percent: number | null;
  /**
   * Round 4 PR-G: a `FIXED_PRICE_TABLE` tier's price for the product being priced, or null
   * when the layer is a rate (or the list price). Non-null only with layer `TIER`.
   */
  readonly fixedPrice: Money | null;
}

/**
 * What a price-table tier does with one product (Round 4 PR-G), decided from the table's
 * row, the product's list currency and the tier's «قیمت عادی برای محصولات بدون قیمت».
 *
 * - `PRICED` — the row's price, which the `TIER_PRICE` step replaces the subtotal with.
 * - `LIST` — no usable row and the tier sells unpriced products at the list price.
 * - `UNSELLABLE` — no usable row, and the tier does not: the product is not sold to it.
 *
 * A row in a currency other than the product's is NOT a price for it — never converted,
 * never compared across currencies — and reads exactly as no row.
 */
export type TierPriceDecision =
  | { readonly kind: 'PRICED'; readonly price: Money }
  | { readonly kind: 'LIST' }
  | { readonly kind: 'UNSELLABLE' };

export function decideTierPrice(
  row: Money | null,
  listCurrency: CurrencyCode,
  unpricedListFallback: boolean,
): TierPriceDecision {
  if (row !== null && row.currency === listCurrency && row.amountMinor > 0n) {
    return { kind: 'PRICED', price: row };
  }
  return unpricedListFallback ? { kind: 'LIST' } : { kind: 'UNSELLABLE' };
}

/**
 * What the reseller layer charges for a list subtotal: ONE statement, used by the quote
 * (`applyResellerLayer`), the confirmation's re-derivation (`recordPurchase`) and the price
 * a catalogue shows, so the three cannot disagree.
 *
 * A rate takes `resellerReductionMinor` off the list. A table price REPLACES it: the cost is
 * the tier's price for the line — one unit, since `MAX_ORDER_QUANTITY` is 1 (a line of more
 * units would need the quantity here) — and never more than the list price: a tier price
 * above list charges the list, so a reseller never pays more than an ordinary customer and
 * `order_reseller_terms`' `cost <= list` holds. A table price is at least one minor unit
 * (`reseller_tier_product_prices_amount_check`), so the cost is never zero.
 */
export function resellerCostMinor(listMinor: bigint, terms: ResellerPricingTerms): bigint {
  if (terms.fixedPrice !== null) {
    const fixed = terms.fixedPrice.amountMinor * BigInt(MAX_ORDER_QUANTITY);
    return fixed < listMinor ? fixed : listMinor;
  }
  return listMinor - resellerReductionMinor(listMinor, terms.percent);
}

/** The label a `USER_OVERRIDE` step carries: a constant, like the base step's. */
export const RESELLER_OVERRIDE_RULE_LABEL = "The reseller's own price";

function stepOf(layer: ResellerPriceLayer): PricingStep | null {
  if (layer === 'TIER') return 'TIER_PRICE';
  if (layer === 'OVERRIDE') return 'USER_OVERRIDE';
  return null;
}

/**
 * The reseller price, applied to a list-price base (`docs/wp9-reseller-audit.md` R3, R4).
 *
 * The layer REPLACES the list subtotal: the reseller cost (`resellerCostMinor` — a rate off
 * the list, or a price-table tier's price) becomes the new subtotal AND the total the
 * promotions then apply to. The discount
 * stays zero here — promotions are the only discount an order carries, so a reseller's
 * margin is never recorded as a customer discount.
 *
 * A layer that changes nothing adds no step: a step that did not fire reads later as
 * evidence that a rule was considered.
 */
export function applyResellerLayer(
  base: OrderTotalsRecord,
  terms: ResellerPricingTerms,
): OrderTotalsRecord {
  const step = stepOf(terms.layer);
  if (terms.fixedPrice !== null && terms.fixedPrice.currency !== base.currency) {
    // `decideTierPrice` refuses a row in another currency; reaching here is a caller that
    // skipped it, and pricing across currencies is a price nobody set.
    throw new Error('A tier price is applied only in the currency of the list price.');
  }
  const reduction = base.subtotal.amountMinor - resellerCostMinor(base.subtotal.amountMinor, terms);
  if (step === null || reduction <= 0n) return base;

  const precedence = PRICING_PRECEDENCE.find((p) => p.step === step);
  if (precedence === undefined) {
    // Frozen data; the precedence table declares both steps. If that stops being true this
    // is pricing against a table it no longer understands, and a silent fallback mints prices.
    throw new Error(`PRICING_PRECEDENCE no longer declares ${step}.`);
  }
  const currency = base.currency;
  const cost = money(base.subtotal.amountMinor - reduction, currency);
  const trace: PriceQuoteStep = {
    step,
    effect: precedence.effect,
    ruleId: step === 'TIER_PRICE' ? terms.tierId : terms.resellerId,
    ruleLabel: step === 'TIER_PRICE' ? terms.tierName : RESELLER_OVERRIDE_RULE_LABEL,
    amountBefore: base.subtotal,
    amountAfter: cost,
  };
  return {
    subtotal: cost,
    discount: money(0n, currency),
    total: cost,
    currency,
    quote: {
      ...base.quote,
      finalAmount: cost,
      trace: [...base.quote.trace, trace],
    },
  };
}

/**
 * What a quote says its reseller layer was: the step, its rule id and the cost it reached,
 * or null when no reseller step fired. The confirmation compares this with what the live
 * terms produce now (R9).
 */
export function quotedResellerLayer(
  trace: readonly PriceQuoteStep[],
): { readonly step: PricingStep; readonly ruleId: string | null; readonly cost: bigint } | null {
  const step = trace.find((s) => s.step === 'TIER_PRICE' || s.step === 'USER_OVERRIDE');
  if (step === undefined) return null;
  return { step: step.step, ruleId: step.ruleId, cost: step.amountAfter.amountMinor };
}
