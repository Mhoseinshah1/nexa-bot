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

/**
 * The same one step, for an add-on.
 *
 * A separate function rather than a parameter on `quoteProduct`, because the two quote
 * different THINGS and the difference shows up in the trace: `PriceQuote.productId` is
 * `null` here, which the contract already admits, and the rule label names the package
 * rather than a plan. A shared function taking "a thing with a price" would have made
 * the trace say `BASE_PRICE` with a product id that belonged to something else.
 *
 * `effect` is read from `PRICING_PRECEDENCE` for the reason `quoteProduct` states: a
 * contract change to the precedence table has to show up in this trace rather than
 * silently disagreeing with it.
 */
export const ADDON_PRICE_RULE_LABEL = "The package's list price";

export function quoteAddon(price: Money, quotedAt: Date): OrderTotalsRecord {
  const basePrecedence = PRICING_PRECEDENCE[0];
  if (basePrecedence === undefined || basePrecedence.step !== 'BASE_PRICE') {
    throw new Error('PRICING_PRECEDENCE no longer begins with BASE_PRICE.');
  }

  const currency = price.currency;
  const subtotal = money(price.amountMinor, currency);
  // The clamp, for the reason `quoteProduct` routes through it: one place computes a
  // total, so one place cannot forget that a total is never negative.
  const discountMinor = clampDiscount(subtotal.amountMinor, 0n);
  const total = money(subtotal.amountMinor - discountMinor, currency);

  const step: PriceQuoteStep = {
    step: 'BASE_PRICE',
    effect: basePrecedence.effect,
    ruleId: null,
    ruleLabel: ADDON_PRICE_RULE_LABEL,
    amountBefore: zero(currency),
    amountAfter: subtotal,
  };

  return {
    subtotal,
    discount: money(discountMinor, currency),
    total,
    currency,
    // `productId: null` — an add-on is not a product, and the contract's own type says
    // a quote may name none.
    quote: {
      productId: null,
      quotedAt: quotedAt.toISOString(),
      currency,
      finalAmount: total,
      trace: [step],
    },
  };
}

/**
 * The rule label a trial's quote carries. Constant for the reason
 * `BASE_PRICE_RULE_LABEL` is: it is read back by a support conversation.
 */
export const TRIAL_RULE_LABEL = 'A trial: nothing is charged';

/**
 * A trial's quote: zero, with a real trace.
 *
 * `pricing.ts` calls a quote without a trace not a quote, so the one step that applied
 * is recorded — `BASE_PRICE`, replacing nothing with nothing, under a label that says
 * why. Not a discount of the product's price: a trial product usually HAS no price, and
 * a 100% `PROMOTIONAL_DISCOUNT` would put a discount on the books that no rule granted.
 *
 * `orderIsFreeTrial` (the `GRANT` guard) and `orders_trial_is_free_check` both require
 * the total this returns to be zero; this is the one place that produces it.
 */
export function quoteTrial(
  product: ProductRecord,
  currency: Money['currency'],
  quotedAt: Date,
): OrderTotalsRecord {
  const basePrecedence = PRICING_PRECEDENCE[0];
  if (basePrecedence === undefined || basePrecedence.step !== 'BASE_PRICE') {
    throw new Error('PRICING_PRECEDENCE no longer begins with BASE_PRICE.');
  }
  const nothing = zero(currency);
  const step: PriceQuoteStep = {
    step: 'BASE_PRICE',
    effect: basePrecedence.effect,
    ruleId: null,
    ruleLabel: TRIAL_RULE_LABEL,
    amountBefore: nothing,
    amountAfter: nothing,
  };
  return {
    subtotal: nothing,
    discount: nothing,
    total: nothing,
    currency,
    quote: {
      productId: product.id,
      quotedAt: quotedAt.toISOString(),
      currency,
      finalAmount: nothing,
      trace: [step],
    },
  };
}
