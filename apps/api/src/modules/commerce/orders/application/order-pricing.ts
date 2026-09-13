import {
  PRICING_PRECEDENCE,
  clampDiscount,
  money,
  zero,
  type Money,
  type PriceQuote,
  type PriceQuoteStep,
} from '@nexa/contracts';
import type { ProductRecord } from '../../catalog/application/ports.js';
import type { OrderTotalsRecord } from './ports.js';

/**
 * The rule label a `BASE_PRICE` step carries when nothing but the list price applied.
 *
 * A constant rather than a literal at the call site: it is written into every order's
 * quote trace and read back by a support conversation, so it must be the same string
 * for every order priced this way.
 */
export const BASE_PRICE_RULE_LABEL = "The product's list price";

/**
 * The pricing engine, at the only step Phase 4B owns.
 *
 * `PRICING_PRECEDENCE` declares six steps and this applies exactly one of them.
 * The other five are tiers, panel adjustments, custom formulas, per-user overrides and
 * promotional discounts — every one of which belongs to a phase that does not exist,
 * and each of which would need a rule table, a precedence test and an operator surface
 * before it could be believed. Implementing a step with no rules behind it would put a
 * step into the trace that says a rule fired when none did.
 *
 * What this DOES do is produce a real quote with a real trace. `pricing.ts` calls the
 * trace mandatory — "a quote without a trace is not a quote" — so the one step that
 * genuinely applied is recorded with `ruleId: null`, which the contract defines as
 * "the step applied a default". A later phase adds steps AFTER this one; it never has
 * to go back and invent the base step's provenance.
 *
 * `effect` is read from `PRICING_PRECEDENCE` rather than written as `'REPLACES'` here,
 * so a contract change to the precedence table shows up in this trace instead of
 * silently disagreeing with it.
 */
export function quoteProduct(
  product: ProductRecord,
  price: Money,
  quantity: number,
  quotedAt: Date,
): OrderTotalsRecord {
  const basePrecedence = PRICING_PRECEDENCE[0];
  if (basePrecedence === undefined || basePrecedence.step !== 'BASE_PRICE') {
    // The precedence table is frozen data and BASE_PRICE leads it. If that ever stops
    // being true, this engine is pricing against a table it no longer understands, and
    // failing loudly is the only honest option — a silent fallback would mint prices.
    throw new Error('PRICING_PRECEDENCE no longer begins with BASE_PRICE.');
  }

  const currency = price.currency;
  const subtotal = money(price.amountMinor * BigInt(quantity), currency);

  /*
   * Zero discount, and not a step.
   *
   * `PROMOTIONAL_DISCOUNT` is a step that did not fire, and a trace entry for a step
   * that did not fire is noise that later reads as evidence a discount was considered.
   * The clamp is still applied, because `clampDiscount` is the contract's statement
   * that a total is never negative and routing through it here means the one place
   * that computes an order total cannot be the place that forgets.
   */
  const discountMinor = clampDiscount(subtotal.amountMinor, 0n);
  const total = money(subtotal.amountMinor - discountMinor, currency);

  const step: PriceQuoteStep = {
    step: 'BASE_PRICE',
    effect: basePrecedence.effect,
    ruleId: null,
    ruleLabel: BASE_PRICE_RULE_LABEL,
    amountBefore: zero(currency),
    amountAfter: subtotal,
  };

  const quote: PriceQuote = {
    productId: product.id,
    quotedAt: quotedAt.toISOString(),
    currency,
    finalAmount: total,
    trace: [step],
  };

  return { subtotal, discount: money(discountMinor, currency), total, currency, quote };
}
