import type { Money } from './money.js';
import type { ProductId } from './ids.js';

/**
 * The price quote.
 *
 * One engine computes prices, and it returns a quote carrying every step it
 * applied and the rule that fired at each step. The trace is mandatory, not
 * optional: a price that cannot be explained cannot be defended to a customer
 * or debugged by an engineer. The quote is snapshotted onto the order and never
 * recomputed.
 *
 * IMPORTANT: the legacy system has no pricing precedence to reproduce —
 * `PRICING_PRECEDENCE = UNKNOWN` (SBR-033), and its custom-pricing rules have no
 * priority, no enabled flag and no date scope, with overlaps by design. The step
 * order below is therefore OUR DESIGN DECISION and is pending owner sign-off
 * (see docs/open-questions.md, O-1). It is data, so changing it is a contract
 * change with a visible test diff.
 *
 * Phase 0 ships the shape only. The engine is Phase 4.
 */

export const PRICING_STEPS = [
  'BASE_PRICE',
  'TIER_PRICE',
  'PANEL_ADJUSTMENT',
  'CUSTOM_SERVICE_FORMULA',
  'USER_OVERRIDE',
  'PROMOTIONAL_DISCOUNT',
] as const;
export type PricingStep = (typeof PRICING_STEPS)[number];

/**
 * How a step combines with what came before it.
 * REPLACES discards the running total; ADJUSTS modifies it.
 */
export const STEP_EFFECTS = ['REPLACES', 'ADJUSTS'] as const;
export type StepEffect = (typeof STEP_EFFECTS)[number];

/**
 * The proposed precedence, in order. PENDING OWNER SIGN-OFF.
 *
 * Wallet application and cashback are deliberately absent: they are settlement
 * concerns, not price changes. Conflating them is how the legacy system ends up
 * with a "final price" label that means two different things in two message
 * families.
 */
export const PRICING_PRECEDENCE: readonly { step: PricingStep; effect: StepEffect }[] = [
  { step: 'BASE_PRICE', effect: 'REPLACES' },
  { step: 'TIER_PRICE', effect: 'REPLACES' },
  { step: 'PANEL_ADJUSTMENT', effect: 'ADJUSTS' },
  { step: 'CUSTOM_SERVICE_FORMULA', effect: 'REPLACES' },
  { step: 'USER_OVERRIDE', effect: 'REPLACES' },
  { step: 'PROMOTIONAL_DISCOUNT', effect: 'ADJUSTS' },
];

export interface PriceQuoteStep {
  readonly step: PricingStep;
  readonly effect: StepEffect;
  /** The rule that fired, by stable id. Null when the step applied a default. */
  readonly ruleId: string | null;
  readonly ruleLabel: string;
  readonly amountBefore: Money;
  readonly amountAfter: Money;
}

export interface PriceQuote {
  readonly productId: ProductId | null;
  readonly quotedAt: string;
  readonly currency: Money['currency'];
  readonly finalAmount: Money;
  /** Mandatory. A quote without a trace is not a quote. */
  readonly trace: readonly PriceQuoteStep[];
}

/** At most one discount code per order. Stacking is a margin decision, not a default. */
export const MAX_DISCOUNT_CODES_PER_ORDER = 1;
