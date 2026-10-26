import { z } from 'zod';
import { moneySchema } from './money.js';
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
 * Phase 0 shipped the shape only. Phase 4B applied `BASE_PRICE`; WP8 adds
 * `PROMOTIONAL_DISCOUNT` and the cashback promise (`docs/wp8-pricing-audit.md`).
 */

export const PRICING_STEPS = [
  'BASE_PRICE',
  'TIER_PRICE',
  'PANEL_ADJUSTMENT',
  'CUSTOM_SERVICE_FORMULA',
  'USER_OVERRIDE',
  'PROMOTIONAL_DISCOUNT',
  /**
   * R10 D3: the customer's personal discount (owner spec, «تخفیف شخصی»). APPENDED rather
   * than inserted, so every stored trace keeps its meaning. It is an EXCLUSIVE alternative,
   * not a layer: a quote that carries it carries no reseller step and no promotional step —
   * see `PERSONAL_DISCOUNT_STACKING` below.
   */
  'PERSONAL_DISCOUNT',
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
  /*
   * R10 D3. Placed after the reseller layer and before the promotions because it competes
   * with what those produce; it ADJUSTS the list price it is taken off. The engine applies
   * it only INSTEAD of the steps around it, never with them (`PERSONAL_DISCOUNT_STACKING`).
   */
  { step: 'PERSONAL_DISCOUNT', effect: 'ADJUSTS' },
  { step: 'PROMOTIONAL_DISCOUNT', effect: 'ADJUSTS' },
];

/**
 * R10 D3 — the personal discount: a whole percent per customer, set by an operator from the
 * customer's page in the Web Admin, behind the `personal_discount` feature flag (off by
 * default).
 *
 * `0` is "none"; `100` is allowed and is floored at one minor unit payable exactly as a 100%
 * discount code is (`clampDiscount`, Payment File 02 §14 D4) — there is no zero-total
 * payment.
 */
export const PERSONAL_DISCOUNT_PERCENT_MIN = 0;
export const PERSONAL_DISCOUNT_PERCENT_MAX = 100;

/**
 * What a personal discount applies to: a purchase and a renewal (owner spec). NOT a wallet
 * top-up (which never reaches the pricing boundary), and by default not an add-on, a
 * custom service, a location change or a trial — each of those is its own price the owner
 * has not put under it (recorded as an open question).
 */
export const PERSONAL_DISCOUNT_PURPOSES = ['NEW_SERVICE', 'RENEW'] as const;
export type PersonalDiscountPurpose = (typeof PERSONAL_DISCOUNT_PURPOSES)[number];

/**
 * How a personal discount combines with everything else, stated as data (owner spec: "how
 * it stacks must be explicit, and recorded").
 *
 * `LARGER_SINGLE_WINS`: the engine prices the order the way it always has (the reseller
 * layer and the promotions, unchanged) AND, separately, as the list price minus the
 * personal percent. The strictly LOWER total wins; a tie keeps the ordinary quote. The two
 * are never combined — a personal discount is never taken off a reseller price or a
 * discounted price, and no code or automatic rule is taken off a personal price.
 */
export const PERSONAL_DISCOUNT_STACKING = 'LARGER_SINGLE_WINS' as const;

/**
 * What the decision came to, frozen on the quote.
 *
 * - `APPLIED` — the personal price was strictly lower and is the quote.
 * - `NOT_LARGER` — the ordinary quote was as low or lower and stands.
 * - `NOT_APPLICABLE` — the percent took nothing off (a one-unit price), so it competed with
 *   nothing.
 */
export const PERSONAL_DISCOUNT_OUTCOMES = ['APPLIED', 'NOT_LARGER', 'NOT_APPLICABLE'] as const;
export type PersonalDiscountOutcome = (typeof PERSONAL_DISCOUNT_OUTCOMES)[number];

/**
 * The personal-discount decision a quote was made with (R10 D3). Present only when the
 * customer had a non-zero percent, the flag was on and the purpose is one it applies to;
 * absent on every quote before R10 and on every quote it did not take part in.
 *
 * `competingTotal` is the OTHER candidate's total: the ordinary quote's when the personal
 * price won, the personal price when it did not. Both totals are therefore on the record.
 */
export interface PriceQuotePersonalDiscount {
  readonly percent: number;
  readonly outcome: PersonalDiscountOutcome;
  readonly competingTotal: Money;
  readonly rule: typeof PERSONAL_DISCOUNT_STACKING;
}

export interface PriceQuoteStep {
  readonly step: PricingStep;
  readonly effect: StepEffect;
  /** The rule that fired, by stable id. Null when the step applied a default. */
  readonly ruleId: string | null;
  readonly ruleLabel: string;
  readonly amountBefore: Money;
  readonly amountAfter: Money;
}

/**
 * The cashback promised with a quote (WP8 P8).
 *
 * Beside the trace and never in it: cashback does not change what the customer pays, so
 * a step for it would make `finalAmount` and the last step's `amountAfter` disagree, or
 * make one of them wrong. It is the rule that fired, the percent it had then, and the
 * amount it came to on `finalAmount` — all snapshotted, because the rule may be retuned
 * before the order is delivered.
 */
export interface PriceQuoteCashback {
  readonly ruleId: string;
  readonly ruleLabel: string;
  readonly percent: number;
  readonly amount: Money;
}

export interface PriceQuote {
  readonly productId: ProductId | null;
  readonly quotedAt: string;
  readonly currency: Money['currency'];
  readonly finalAmount: Money;
  /** Mandatory. A quote without a trace is not a quote. */
  readonly trace: readonly PriceQuoteStep[];
  /** Absent when no cashback rule applied, including on every quote written before WP8. */
  readonly cashback?: PriceQuoteCashback;
  /** R10 D3: absent unless a personal discount took part in the decision. */
  readonly personalDiscount?: PriceQuotePersonalDiscount;
}

/** At most one discount code per order. Stacking is a margin decision, not a default. */
export const MAX_DISCOUNT_CODES_PER_ORDER = 1;

/**
 * The quote as it is STORED, and the shape it is parsed back through.
 *
 * `orders.quote` is `jsonb`, and a `Money` cannot be written to JSON: `amountMinor` is
 * a `bigint` and `JSON.stringify` throws on one. So the stored form carries every
 * amount as the decimal STRING `moneySchema` already defines — the same reason that
 * schema exists, and not a second convention invented for this table.
 *
 * It is a schema rather than an interface because a `jsonb` column is the one place a
 * document can come back malformed without anything having been wrong at write time: a
 * restore, a hand-edit, or an older writer. Parsing on read means a quote that cannot
 * be believed is a refusal and not a total rendered from `undefined`.
 */
export const priceQuoteStepWireSchema = z.object({
  step: z.enum(PRICING_STEPS),
  effect: z.enum(STEP_EFFECTS),
  ruleId: z.string().nullable(),
  ruleLabel: z.string(),
  amountBefore: moneySchema,
  amountAfter: moneySchema,
});

export const priceQuoteCashbackWireSchema = z.object({
  ruleId: z.string(),
  ruleLabel: z.string(),
  percent: z.number().int().min(1).max(100),
  amount: moneySchema,
});

export const priceQuotePersonalDiscountWireSchema = z.object({
  percent: z.number().int().min(1).max(PERSONAL_DISCOUNT_PERCENT_MAX),
  outcome: z.enum(PERSONAL_DISCOUNT_OUTCOMES),
  competingTotal: moneySchema,
  rule: z.literal(PERSONAL_DISCOUNT_STACKING),
});

export const priceQuoteWireSchema = z.object({
  productId: z.string().nullable(),
  quotedAt: z.iso.datetime(),
  currency: moneySchema.shape.currency,
  finalAmount: moneySchema,
  /** Mandatory, and non-empty: `PriceQuote` calls a quote without a trace not a quote. */
  trace: z.array(priceQuoteStepWireSchema).min(1),
  /**
   * Optional, so every quote stored before WP8 still parses — a stored document is read
   * back through this schema, and a new required field would turn every historical order
   * into a refusal.
   */
  cashback: priceQuoteCashbackWireSchema.optional(),
  /** R10 D3. Optional for the same reason: every quote stored before it still parses. */
  personalDiscount: priceQuotePersonalDiscountWireSchema.optional(),
});

export type PriceQuoteWire = z.infer<typeof priceQuoteWireSchema>;
