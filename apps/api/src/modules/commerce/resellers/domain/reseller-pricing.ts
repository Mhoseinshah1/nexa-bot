import {
  PRICING_PRECEDENCE,
  money,
  resellerReductionMinor,
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
 * The layer REPLACES the list subtotal: the reduction comes off the list SUBTOTAL, and the
 * result becomes the new subtotal AND the total the promotions then apply to. The discount
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
  const reduction = resellerReductionMinor(base.subtotal.amountMinor, terms.percent);
  if (step === null || reduction === 0n) return base;

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
