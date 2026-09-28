import {
  MAX_MONEY_AMOUNT_MINOR,
  CUSTOM_SERVICE_RULE_LEVELS,
  CUSTOM_SERVICE_VOLUME_UNITS_PER_GB,
  PRICING_PRECEDENCE,
  money,
  zero,
  type CurrencyCode,
  type CustomServiceRuleDimension,
  type CustomServiceRuleLevel,
  type Money,
  type PriceQuote,
  type PriceQuoteStep,
} from '@nexa/contracts';

/**
 * Package D — the custom service's pricing, pure (`docs/package-d-custom-service-audit.md`
 * §4, §5). No I/O: the application layer reads the rules and hands them here, so the
 * selection, the arithmetic and the quote trace are one function each, testable without a
 * database and callable identically by the draft and by the confirmation that re-decides.
 */

/** A rule as selection needs it. */
export interface CustomServiceRule {
  readonly id: string;
  readonly dimension: CustomServiceRuleDimension;
  readonly minUnits: bigint;
  readonly maxUnits: bigint;
  readonly unitPrice: Money;
  readonly customerId: string | null;
  readonly resellerTierId: string | null;
  readonly panelId: string | null;
  readonly enabled: boolean;
}

/**
 * Who is asking, and for which panel.
 *
 * `tierId` is the customer's reseller tier when they are an ACTIVE reseller and null
 * otherwise — null IS the ordinary customers' tier, the one a rule with neither a
 * customer nor a tier is written for.
 */
export interface CustomServiceSubject {
  readonly customerId: string;
  readonly tierId: string | null;
  readonly panelId: string;
}

/** Which level a rule sits at FOR THIS SUBJECT, or null when it cannot apply to them. */
export function ruleLevelFor(
  rule: CustomServiceRule,
  subject: CustomServiceSubject,
): CustomServiceRuleLevel | null {
  if (rule.panelId !== null && rule.panelId !== subject.panelId) return null;
  const anyPanel = rule.panelId === null;
  if (rule.customerId !== null) {
    if (rule.customerId !== subject.customerId) return null;
    return anyPanel ? 'CUSTOMER_ALL_PANELS' : 'CUSTOMER_PANEL';
  }
  // A tier rule: the reseller tier it names, or — naming none — the ordinary customers.
  if (rule.resellerTierId !== subject.tierId) return null;
  return anyPanel ? 'TIER_ALL_PANELS' : 'TIER_PANEL';
}

export type RuleSelection =
  | {
      readonly kind: 'SELECTED';
      readonly rule: CustomServiceRule;
      readonly level: CustomServiceRuleLevel;
    }
  | { readonly kind: 'NO_RULE' }
  | {
      readonly kind: 'AMBIGUOUS';
      readonly level: CustomServiceRuleLevel;
      readonly ruleIds: readonly string[];
    };

/**
 * The rule that prices one dimension of one request (brief D3).
 *
 * Walks the four levels most specific first and takes the FIRST level with an enabled
 * rule of this dimension whose inclusive range contains `units`. Within that level exactly
 * one rule must match: two is a state validation refuses, but a restore or a hand edit can
 * still produce it, and the answer then is AMBIGUOUS — the service is unavailable — never
 * a sum and never whichever row came back first.
 */
export function selectCustomServiceRule(
  rules: readonly CustomServiceRule[],
  dimension: CustomServiceRuleDimension,
  units: bigint,
  subject: CustomServiceSubject,
): RuleSelection {
  for (const level of CUSTOM_SERVICE_RULE_LEVELS) {
    const matches = rules.filter(
      (rule) =>
        rule.enabled &&
        rule.dimension === dimension &&
        units >= rule.minUnits &&
        units <= rule.maxUnits &&
        ruleLevelFor(rule, subject) === level,
    );
    if (matches.length === 1) return { kind: 'SELECTED', rule: matches[0]!, level };
    if (matches.length > 1) {
      return { kind: 'AMBIGUOUS', level, ruleIds: matches.map((rule) => rule.id).sort() };
    }
  }
  return { kind: 'NO_RULE' };
}

/**
 * Whether any enabled rule of `dimension` could price this subject at all, for some value
 * — the courtesy the location list is filtered by. Selection decides for the real figure.
 */
export function anyRuleFor(
  rules: readonly CustomServiceRule[],
  dimension: CustomServiceRuleDimension,
  subject: CustomServiceSubject,
): boolean {
  return rules.some(
    (rule) => rule.enabled && rule.dimension === dimension && ruleLevelFor(rule, subject) !== null,
  );
}

/**
 * The volume price: `volume_units × price_per_GB / 100`, rounded to the minor unit, half
 * up. Exact: the only division is by 100, done once on integers, and
 * `order_custom_service_terms_volume_amount_check` states the same formula in SQL.
 */
export function customServiceVolumePrice(volumeUnits: bigint, pricePerGb: bigint): bigint {
  const half = CUSTOM_SERVICE_VOLUME_UNITS_PER_GB / 2n;
  return (volumeUnits * pricePerGb + half) / CUSTOM_SERVICE_VOLUME_UNITS_PER_GB;
}

/** The time price: `days × price_per_day`. */
export function customServiceTimePrice(days: number, pricePerDay: bigint): bigint {
  return BigInt(days) * pricePerDay;
}

/** Everything a priced custom request is, before any discount. */
export interface CustomServicePrice {
  readonly volumeRule: CustomServiceRule;
  readonly volumeLevel: CustomServiceRuleLevel;
  readonly timeRule: CustomServiceRule;
  readonly timeLevel: CustomServiceRuleLevel;
  readonly volumeUnits: bigint;
  readonly durationDays: number;
  readonly volumePrice: Money;
  readonly timePrice: Money;
  readonly basePrice: Money;
}

export type CustomServicePricing =
  | { readonly kind: 'PRICED'; readonly price: CustomServicePrice }
  | {
      readonly kind: 'UNAVAILABLE';
      /** For the audit row; the customer is told one sentence for every reason. */
      readonly reason:
        | 'NO_VOLUME_RULE'
        | 'NO_TIME_RULE'
        | 'AMBIGUOUS_VOLUME_RULE'
        | 'AMBIGUOUS_TIME_RULE'
        | 'CURRENCY_MISMATCH';
    };

/**
 * Selects both rules and computes the price (brief D3, D4).
 *
 * `currency` is the tenant's sales currency: a rule written in another one cannot price a
 * sale, so it is UNAVAILABLE rather than silently mixed into a total.
 */
export function priceCustomService(
  rules: readonly CustomServiceRule[],
  subject: CustomServiceSubject,
  volumeUnits: bigint,
  durationDays: number,
  currency: CurrencyCode,
): CustomServicePricing {
  const volume = selectCustomServiceRule(rules, 'VOLUME', volumeUnits, subject);
  if (volume.kind === 'NO_RULE') return { kind: 'UNAVAILABLE', reason: 'NO_VOLUME_RULE' };
  if (volume.kind === 'AMBIGUOUS') {
    return { kind: 'UNAVAILABLE', reason: 'AMBIGUOUS_VOLUME_RULE' };
  }
  const time = selectCustomServiceRule(rules, 'TIME', BigInt(durationDays), subject);
  if (time.kind === 'NO_RULE') return { kind: 'UNAVAILABLE', reason: 'NO_TIME_RULE' };
  if (time.kind === 'AMBIGUOUS') return { kind: 'UNAVAILABLE', reason: 'AMBIGUOUS_TIME_RULE' };
  if (volume.rule.unitPrice.currency !== currency || time.rule.unitPrice.currency !== currency) {
    return { kind: 'UNAVAILABLE', reason: 'CURRENCY_MISMATCH' };
  }

  const volumePrice = money(
    customServiceVolumePrice(volumeUnits, volume.rule.unitPrice.amountMinor),
    currency,
  );
  const timePrice = money(
    customServiceTimePrice(durationDays, time.rule.unitPrice.amountMinor),
    currency,
  );
  return {
    kind: 'PRICED',
    price: {
      volumeRule: volume.rule,
      volumeLevel: volume.level,
      timeRule: time.rule,
      timeLevel: time.level,
      volumeUnits,
      durationDays,
      volumePrice,
      timePrice,
      basePrice: money(volumePrice.amountMinor + timePrice.amountMinor, currency),
    },
  };
}

/**
 * The most a rule may charge across its whole range: `max_units × unit_price` in minor
 * units, for either dimension (Codex, PR #88).
 *
 * The HTTP schema accepts any positive integer, and a price that is individually storable
 * can still overflow once it is multiplied by up to 102,400,000 hundredths of a GB or 3,650
 * days. The overflow would surface as a database error at draft time instead of a field
 * error when the rule is written. `order_custom_service_terms` also computes
 * `volume_hundredths * price_per_gb` in SQL `bigint`, so that product itself has to fit.
 *
 * A quarter of the money ceiling keeps each component under it, keeps the sum of the two
 * under half of it, and leaves room for the fee and totals above the base. Checked when a
 * rule is written: the order is then bounded by what its rules allowed.
 */
export const CUSTOM_SERVICE_RULE_AMOUNT_CEILING = MAX_MONEY_AMOUNT_MINOR / 4n;

/** Whether a rule's price across its whole range fits `CUSTOM_SERVICE_RULE_AMOUNT_CEILING`. */
export function ruleAmountFits(maxUnits: bigint, unitPriceMinor: bigint): boolean {
  return maxUnits * unitPriceMinor <= CUSTOM_SERVICE_RULE_AMOUNT_CEILING;
}

/** The labels the two formula steps carry in a quote's trace. Constants, like the list price's. */
export const CUSTOM_SERVICE_VOLUME_STEP_LABEL = 'Custom service: volume × price per GB';
export const CUSTOM_SERVICE_TIME_STEP_LABEL = 'Custom service: days × price per day';

/**
 * The base of a custom order's quote: two `CUSTOM_SERVICE_FORMULA` steps, one per rule.
 *
 * The step `PRICING_PRECEDENCE` reserved for exactly this, so the trace names both rules
 * that fired rather than a `BASE_PRICE` with no rule behind it. The first replaces nothing
 * with the volume price; the second takes the running total to the base. `effect` is read
 * from the precedence table, as the list price's step reads its own.
 *
 * A draft re-quoted for a discount code is rebuilt from its OWN snapshot — the two prices
 * stored in `order_custom_service_terms` — through this same function, never from today's
 * rules.
 */
export function customServiceBaseQuote(input: {
  readonly volumeRuleId: string;
  readonly volumePrice: Money;
  readonly timeRuleId: string;
  readonly timePrice: Money;
  readonly quotedAt: Date;
}): {
  readonly subtotal: Money;
  readonly discount: Money;
  readonly total: Money;
  readonly currency: CurrencyCode;
  readonly quote: PriceQuote;
} {
  const precedence = PRICING_PRECEDENCE.find((entry) => entry.step === 'CUSTOM_SERVICE_FORMULA');
  if (precedence === undefined) {
    // Frozen data. Pricing against a table that no longer has the step would mint prices.
    throw new Error('PRICING_PRECEDENCE no longer has CUSTOM_SERVICE_FORMULA.');
  }
  const currency = input.volumePrice.currency;
  const base = money(input.volumePrice.amountMinor + input.timePrice.amountMinor, currency);
  const steps: PriceQuoteStep[] = [
    {
      step: 'CUSTOM_SERVICE_FORMULA',
      effect: precedence.effect,
      ruleId: input.volumeRuleId,
      ruleLabel: CUSTOM_SERVICE_VOLUME_STEP_LABEL,
      amountBefore: zero(currency),
      amountAfter: input.volumePrice,
    },
    {
      step: 'CUSTOM_SERVICE_FORMULA',
      effect: precedence.effect,
      ruleId: input.timeRuleId,
      ruleLabel: CUSTOM_SERVICE_TIME_STEP_LABEL,
      amountBefore: input.volumePrice,
      amountAfter: base,
    },
  ];
  return {
    subtotal: base,
    discount: zero(currency),
    total: base,
    currency,
    quote: {
      productId: null,
      quotedAt: input.quotedAt.toISOString(),
      currency,
      finalAmount: base,
      trace: steps,
    },
  };
}

/**
 * Whether two rules would overlap (brief D2): both enabled, the same dimension, the same
 * specificity key, and intersecting inclusive ranges. Used by the operator's write path,
 * under a per-tenant lock, against every other rule of the tenant.
 */
export function rulesOverlap(a: CustomServiceRule, b: CustomServiceRule): boolean {
  return (
    a.id !== b.id &&
    a.enabled &&
    b.enabled &&
    a.dimension === b.dimension &&
    a.customerId === b.customerId &&
    a.resellerTierId === b.resellerTierId &&
    a.panelId === b.panelId &&
    a.minUnits <= b.maxUnits &&
    b.minUnits <= a.maxUnits
  );
}
