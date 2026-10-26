import {
  PERSONAL_DISCOUNT_STACKING,
  PRICING_PRECEDENCE,
  cashbackAmountMinor,
  clampDiscount,
  discountAmountMinor,
  money,
  type CashbackRuleStatus,
  type CurrencyCode,
  type DiscountKind,
  type DiscountRefusalReason,
  type DiscountStatus,
  type DiscountType,
  type DiscountablePurpose,
  type OrderPurpose,
  type PriceQuote,
  type PriceQuoteCashback,
  type PriceQuotePersonalDiscount,
  type PriceQuoteStep,
} from '@nexa/contracts';
import type { OrderTotalsRecord } from '../../orders/application/ports.js';

/**
 * The purposes that make a customer no longer a first-time buyer (Package D): a service
 * bought from the catalogue, or a custom one. A trial is not a purchase and a renewal is not
 * a first one. The first-purchase query counts exactly these, and every confirmation of one
 * of these takes the first-purchase lock — a confirmation that can enter the counted set but
 * skips the lock is the race the lock exists to close.
 */
export const FIRST_PURCHASE_PURPOSES: readonly OrderPurpose[] = ['NEW_SERVICE', 'CUSTOM_SERVICE'];

/**
 * The pricing engine (`docs/wp8-pricing-audit.md` P1, P2, P4, P5, P8).
 *
 * PURE: no database, no clock, no settings. Every fact it decides on is passed in, so
 * the same inputs give the same quote in the checkout, the confirmation re-check and
 * the operator's preview — "one evaluator with several callers", the shape eligibility
 * already has for panels. A predicate copied into each caller would disagree with itself
 * invisibly.
 *
 * It takes a BASE quote (the list price, one `BASE_PRICE` step, from
 * `order-pricing.ts`) and adds what the precedence table puts after it:
 * `PROMOTIONAL_DISCOUNT` steps, one per applied rule, and the cashback promise beside
 * the trace. It never re-derives the base: a draft re-quoted for a code keeps the price
 * it was shown, because the caller hands it the draft's own snapshot.
 */

/** A discount rule as the engine sees it. Every field is the row's, unchanged. */
export interface DiscountRule {
  readonly id: string;
  readonly kind: DiscountKind;
  readonly code: string | null;
  readonly label: string;
  readonly type: DiscountType;
  readonly value: bigint;
  readonly currency: CurrencyCode | null;
  readonly appliesTo: readonly DiscountablePurpose[];
  readonly productId: string | null;
  readonly categoryId: string | null;
  readonly customerId: string | null;
  readonly firstPurchaseOnly: boolean;
  readonly minimumSubtotal: bigint | null;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly totalLimit: number | null;
  readonly perCustomerLimit: number | null;
  readonly priority: number;
  readonly stackable: boolean;
  readonly status: DiscountStatus;
}

/**
 * How many LIVE redemptions a rule has — whose order is `AWAITING_PAYMENT` or `PAID` —
 * in total and for the customer being priced. Read by the caller, under the rule's lock
 * when it matters (confirmation), and passed in.
 */
export interface DiscountUsage {
  readonly live: number;
  readonly liveForCustomer: number;
}

export interface CashbackRule {
  readonly id: string;
  readonly label: string;
  readonly percent: number;
  readonly appliesTo: readonly DiscountablePurpose[];
  readonly productId: string | null;
  readonly categoryId: string | null;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly status: CashbackRuleStatus;
}

/**
 * Who and what is being priced.
 *
 * `customerId` is null only for the operator's preview without a customer. Then a rule
 * that depends on who the customer is — scoped to one, first-purchase, or limited per
 * customer — is reported `CUSTOMER_DEPENDENT` and left out, rather than assumed either
 * way. `isFirstPurchase` is null under the same condition.
 */
export interface PricingSubject {
  readonly purpose: DiscountablePurpose;
  readonly productId: string | null;
  readonly categoryId: string | null;
  readonly customerId: string | null;
  readonly isFirstPurchase: boolean | null;
  readonly now: Date;
}

export type RuleOutcomeKind = 'APPLIED' | 'SKIPPED' | 'INELIGIBLE' | 'CUSTOMER_DEPENDENT';

export interface RuleOutcome {
  readonly rule: DiscountRule;
  readonly outcome: RuleOutcomeKind;
  readonly reason: DiscountRefusalReason | null;
  /** What the rule took off; zero unless `APPLIED`. */
  readonly amount: bigint;
}

export interface PricingInput {
  readonly base: OrderTotalsRecord;
  readonly subject: PricingSubject;
  /** Every live AUTOMATIC rule of the tenant; the engine decides which fire. */
  readonly automatic: readonly DiscountRule[];
  /**
   * The entered code: `undefined` when none was entered, `null` when one was entered and
   * matched no rule, otherwise the rule it matched.
   */
  readonly coded?: DiscountRule | null;
  readonly usage: ReadonlyMap<string, DiscountUsage>;
  readonly cashbackRules: readonly CashbackRule[];
  /**
   * R10 D3: the customer's personal discount, or absent/null when none takes part — no
   * customer, a zero percent, the `personal_discount` flag off, or a purpose outside
   * `PERSONAL_DISCOUNT_PURPOSES`. The caller decides all four; the engine only compares.
   *
   * `list` is the LIST-price base, BEFORE the reseller layer (`base` above may be the
   * reseller-layered one): the personal percent is taken off the list price, never off a
   * reseller's price — that would be the two stacked.
   */
  readonly personal?: {
    readonly percent: number;
    readonly list: OrderTotalsRecord;
  } | null;
}

export interface PricingResult {
  readonly totals: OrderTotalsRecord;
  readonly outcomes: readonly RuleOutcome[];
  /** Null when no code was entered. */
  readonly code: {
    readonly accepted: boolean;
    readonly reason: DiscountRefusalReason | null;
  } | null;
}

/**
 * Whether one rule may apply to one subject, and if not, why.
 *
 * `null` means eligible. `'CUSTOMER_DEPENDENT'` means the answer needs a customer the
 * caller did not have. Otherwise the first reason that refuses it, in a FIXED order —
 * the order is part of the contract with the operator's preview, which shows one reason,
 * and a reason that depended on iteration order would change between two previews of
 * the same rule.
 *
 * Exported for the unit tests that pin the order. Confirmation does NOT re-run it; it
 * re-decides only what can change after a quote, with `redemptionRefusal` below.
 */
export function discountEligibility(
  rule: DiscountRule,
  subject: PricingSubject,
  subtotal: bigint,
  currency: CurrencyCode,
  usage: DiscountUsage,
): DiscountRefusalReason | 'CUSTOMER_DEPENDENT' | null {
  if (rule.status !== 'ACTIVE') return 'INACTIVE';
  // Half-open `[starts_at, ends_at)`, as every interval in this codebase is.
  if (rule.startsAt !== null && subject.now.getTime() < rule.startsAt.getTime()) {
    return 'NOT_STARTED';
  }
  if (rule.endsAt !== null && subject.now.getTime() >= rule.endsAt.getTime()) return 'ENDED';
  if (!rule.appliesTo.includes(subject.purpose)) return 'PURPOSE';
  if (rule.productId !== null && rule.productId !== subject.productId) return 'PRODUCT';
  if (rule.categoryId !== null && rule.categoryId !== subject.categoryId) return 'CATEGORY';
  if (rule.type === 'FIXED_AMOUNT' && rule.currency !== currency) return 'CURRENCY';
  if (rule.minimumSubtotal !== null && subtotal < rule.minimumSubtotal) {
    return 'MINIMUM_SUBTOTAL';
  }
  if (rule.totalLimit !== null && usage.live >= rule.totalLimit) return 'TOTAL_LIMIT';

  // Everything below needs to know who the customer is.
  if (rule.customerId !== null) {
    if (subject.customerId === null) return 'CUSTOMER_DEPENDENT';
    if (rule.customerId !== subject.customerId) return 'CUSTOMER';
  }
  if (rule.firstPurchaseOnly) {
    // `discounts_first_purchase_check` already confines the flag to NEW_SERVICE rules,
    // and PURPOSE above already refused every other purpose.
    if (subject.isFirstPurchase === null) return 'CUSTOMER_DEPENDENT';
    if (!subject.isFirstPurchase) return 'FIRST_PURCHASE';
  }
  if (rule.perCustomerLimit !== null) {
    if (subject.customerId === null) return 'CUSTOMER_DEPENDENT';
    if (usage.liveForCustomer >= rule.perCustomerLimit) return 'CUSTOMER_LIMIT';
  }
  return null;
}

/**
 * Whether a rule the confirmed quote applied may still be REDEEMED (P6).
 *
 * Only what time and other customers can change is re-decided: the rule is still
 * `ACTIVE`, `now` is inside its window, its limits still have room, and a first-purchase
 * rule's customer still has no other live purchase. The SCOPE — purpose, product,
 * category, customer, currency, minimum — was decided against the order's own frozen
 * snapshot when the quote was made, and an operator retuning a rule's scope after the
 * customer saw the summary is honoured exactly as retuning its value is: the quote
 * stands. `null` means it may be redeemed.
 */
export function redemptionRefusal(
  rule: DiscountRule,
  now: Date,
  usage: DiscountUsage,
  isFirstPurchase: boolean,
): DiscountRefusalReason | null {
  if (rule.status !== 'ACTIVE') return 'INACTIVE';
  if (rule.startsAt !== null && now.getTime() < rule.startsAt.getTime()) return 'NOT_STARTED';
  if (rule.endsAt !== null && now.getTime() >= rule.endsAt.getTime()) return 'ENDED';
  if (rule.totalLimit !== null && usage.live >= rule.totalLimit) return 'TOTAL_LIMIT';
  if (rule.perCustomerLimit !== null && usage.liveForCustomer >= rule.perCustomerLimit) {
    return 'CUSTOMER_LIMIT';
  }
  if (rule.firstPurchaseOnly && !isFirstPurchase) return 'FIRST_PURCHASE';
  return null;
}

/**
 * The deterministic candidate order: priority DESCENDING, then id ASCENDING.
 *
 * Ids are UUIDv7, so among equal priorities the OLDER rule comes first. Never the order
 * the rows came back in: "iteration order must never decide price".
 */
export function byPrecedence(a: DiscountRule, b: DiscountRule): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const NO_USAGE: DiscountUsage = { live: 0, liveForCustomer: 0 };

function personalStep(): (typeof PRICING_PRECEDENCE)[number] {
  const step = PRICING_PRECEDENCE.find((s) => s.step === 'PERSONAL_DISCOUNT');
  if (step === undefined) {
    // Frozen data, as `discountStep` says: a table that stopped naming the step is a table
    // this engine no longer understands, and a silent fallback would mint prices.
    throw new Error('PRICING_PRECEDENCE no longer declares PERSONAL_DISCOUNT.');
  }
  return step;
}

/**
 * The personal discount percent an order's frozen quote was PRICED with (R10 D3), or null.
 *
 * Read from the quote's own decision and trace — never from the customer's percent today,
 * which may have changed since — so every surface that shows the invoice names the same
 * figure the order is charged.
 */
export function personalDiscountPercentOf(quote: PriceQuote): number | null {
  const decision = quote.personalDiscount;
  if (decision === undefined || decision.outcome !== 'APPLIED') return null;
  return quote.trace.some((step) => step.step === 'PERSONAL_DISCOUNT') ? decision.percent : null;
}

/** The label a `PERSONAL_DISCOUNT` step carries: a constant, like the base step's. */
export const PERSONAL_DISCOUNT_RULE_LABEL = "The customer's personal discount";

function discountStep(): (typeof PRICING_PRECEDENCE)[number] {
  const step = PRICING_PRECEDENCE.find((s) => s.step === 'PROMOTIONAL_DISCOUNT');
  if (step === undefined) {
    // The precedence table is frozen data. If it stops naming this step, the engine is
    // pricing against a table it no longer understands, and failing is the only honest
    // answer — a silent fallback would mint prices.
    throw new Error('PRICING_PRECEDENCE no longer declares PROMOTIONAL_DISCOUNT.');
  }
  return step;
}

/**
 * Applies the discounts and the cashback promise to a base quote.
 *
 * P4, in order:
 * 1. Candidates are every eligible AUTOMATIC rule plus the entered code's rule.
 * 2. They are ordered by `byPrecedence`.
 * 3. The first applies. Each later one applies only if it and every rule already
 *    applied are `stackable`.
 * 4. Each discount is computed on the RUNNING amount and clamped, so stacked percentages
 *    compound and the payable amount is never negative.
 *
 * An entered code that is ineligible, or eligible and skipped, is reported
 * `accepted: false` with its reason; the caller decides whether that is a refusal (the
 * customer's code) or a line in a report (the operator's preview). A rule whose turn
 * comes when nothing is left to take off is SKIPPED rather than recorded as a zero step:
 * `discount_redemptions_amount_check` refuses a zero redemption, and a trace entry that
 * changed nothing reads later as a discount somebody granted.
 */
export function applyAdjustments(input: PricingInput): PricingResult {
  const ordinary = applyOrdinary(input);
  const personal = input.personal;
  if (personal === undefined || personal === null || personal.percent <= 0) return ordinary;
  return choosePersonal(input, ordinary, personal);
}

/**
 * The personal discount against the ordinary quote (R10 D3, owner spec; the lead's rule).
 *
 * `LARGER_SINGLE_WINS`, never stacked:
 * 1. The ordinary quote is what `applyOrdinary` produced — the reseller layer and every
 *    promotion, exactly as before this existed.
 * 2. The personal candidate is the LIST total minus the percent, rounded in the
 *    customer's favour like a percentage rule (`discountAmountMinor`) and floored at one
 *    minor unit payable like every discount (`clampDiscount`, D4: no zero total exists).
 *    One `PERSONAL_DISCOUNT` step on the list base; no reseller step, no promotion.
 * 3. The candidate wins only when its total is STRICTLY lower. A tie keeps the ordinary
 *    quote: it is what the customer would have paid anyway, and the ordinary quote is the
 *    one with the reseller's terms and the promotions' redemptions on the record.
 *
 * Either way the decision is recorded on the quote (`personalDiscount`): the percent, who
 * won, and the OTHER candidate's total, so both figures are on the order for good.
 *
 * When the personal price wins, every promotion that would have applied is reported
 * `SKIPPED` / `NOT_COMBINABLE`, and an entered code is refused with that reason: the
 * customer sees the one sentence every code refusal gets (a code's reason is an oracle).
 * Cashback is chosen again on the personal total — its basis is always the final payable.
 */
function choosePersonal(
  input: PricingInput,
  ordinary: PricingResult,
  personal: { readonly percent: number; readonly list: OrderTotalsRecord },
): PricingResult {
  const list = personal.list;
  const currency = list.currency;
  if (currency !== ordinary.totals.currency) {
    // The reseller layer and the promotions never change the currency; reaching here is a
    // caller that handed the engine two different orders.
    throw new Error('A personal discount is compared only within one currency.');
  }
  const listTotal = list.total.amountMinor;
  const off = clampDiscount(
    listTotal,
    discountAmountMinor('PERCENTAGE', listTotal, BigInt(personal.percent)),
  );
  const ordinaryTotal = ordinary.totals.total;

  const decision = (
    outcome: PriceQuotePersonalDiscount['outcome'],
    competingTotal: bigint,
  ): PriceQuotePersonalDiscount => ({
    percent: personal.percent,
    outcome,
    competingTotal: money(competingTotal, currency),
    rule: PERSONAL_DISCOUNT_STACKING,
  });

  if (off <= 0n) {
    // A one-unit price: nothing to take off, so nothing competed. Still recorded.
    return withPersonal(ordinary, decision('NOT_APPLICABLE', listTotal));
  }
  const personalTotal = listTotal - off;
  if (personalTotal >= ordinaryTotal.amountMinor) {
    return withPersonal(ordinary, decision('NOT_LARGER', personalTotal));
  }

  const step = personalStep();
  const total = money(personalTotal, currency);
  const cashback = chooseCashback(input.cashbackRules, input.subject, personalTotal, currency);
  const outcomes = ordinary.outcomes.map((o) =>
    o.outcome === 'APPLIED'
      ? { ...o, outcome: 'SKIPPED' as const, reason: 'NOT_COMBINABLE' as const, amount: 0n }
      : o,
  );
  const code =
    ordinary.code === null
      ? null
      : ordinary.code.accepted
        ? { accepted: false, reason: 'NOT_COMBINABLE' as const }
        : ordinary.code;
  return {
    totals: {
      subtotal: list.subtotal,
      discount: money(list.subtotal.amountMinor - personalTotal, currency),
      total,
      currency,
      quote: {
        productId: list.quote.productId,
        quotedAt: list.quote.quotedAt,
        currency,
        finalAmount: total,
        trace: [
          ...list.quote.trace,
          {
            step: step.step,
            effect: step.effect,
            ruleId: null,
            ruleLabel: PERSONAL_DISCOUNT_RULE_LABEL,
            amountBefore: list.total,
            amountAfter: total,
          },
        ],
        ...(cashback === null ? {} : { cashback }),
        personalDiscount: decision('APPLIED', ordinaryTotal.amountMinor),
      },
    },
    outcomes,
    code,
  };
}

function withPersonal(result: PricingResult, personal: PriceQuotePersonalDiscount): PricingResult {
  return {
    ...result,
    totals: {
      ...result.totals,
      quote: { ...result.totals.quote, personalDiscount: personal },
    },
  };
}

/** The quote as it was before R10 D3: the reseller-layered base, then the promotions. */
function applyOrdinary(input: PricingInput): PricingResult {
  const { base, subject } = input;
  const currency = base.currency;
  const subtotal = base.subtotal.amountMinor;
  const usageOf = (rule: DiscountRule): DiscountUsage => input.usage.get(rule.id) ?? NO_USAGE;

  const outcomes = new Map<string, RuleOutcome>();
  const eligible: DiscountRule[] = [];

  const consider = (rule: DiscountRule): void => {
    const verdict = discountEligibility(rule, subject, subtotal, currency, usageOf(rule));
    if (verdict === null) {
      eligible.push(rule);
    } else if (verdict === 'CUSTOMER_DEPENDENT') {
      outcomes.set(rule.id, { rule, outcome: 'CUSTOMER_DEPENDENT', reason: null, amount: 0n });
    } else {
      outcomes.set(rule.id, { rule, outcome: 'INELIGIBLE', reason: verdict, amount: 0n });
    }
  };

  for (const rule of input.automatic) {
    // A code rule passed in `automatic` by mistake would apply with no code typed; the
    // engine refuses to read it that way rather than trusting every caller's query.
    if (rule.kind === 'AUTOMATIC') consider(rule);
  }
  const coded = input.coded;
  if (coded !== undefined && coded !== null && !outcomes.has(coded.id)) {
    if (coded.kind === 'CODE') consider(coded);
  }

  eligible.sort(byPrecedence);

  const step = discountStep();
  const trace: PriceQuoteStep[] = [...base.quote.trace];
  let running: bigint = base.total.amountMinor;
  let stackOpen = true;
  let first = true;

  for (const rule of eligible) {
    const combinable = first || (stackOpen && rule.stackable);
    if (!combinable || running <= 0n) {
      outcomes.set(rule.id, { rule, outcome: 'SKIPPED', reason: 'NOT_COMBINABLE', amount: 0n });
      continue;
    }
    const off = clampDiscount(running, discountAmountMinor(rule.type, running, rule.value));
    if (off <= 0n) {
      outcomes.set(rule.id, { rule, outcome: 'SKIPPED', reason: 'NOT_COMBINABLE', amount: 0n });
      continue;
    }
    const after = running - off;
    trace.push({
      step: step.step,
      effect: step.effect,
      ruleId: rule.id,
      ruleLabel: rule.label,
      amountBefore: money(running, currency),
      amountAfter: money(after, currency),
    });
    outcomes.set(rule.id, { rule, outcome: 'APPLIED', reason: null, amount: off });
    running = after;
    stackOpen = stackOpen && rule.stackable;
    first = false;
  }

  const total = money(running, currency);
  const discount = money(subtotal - running, currency);
  const cashback = chooseCashback(input.cashbackRules, subject, running, currency);

  const code =
    coded === undefined
      ? null
      : coded === null
        ? { accepted: false, reason: 'UNKNOWN_CODE' as const }
        : (() => {
            const outcome = outcomes.get(coded.id);
            if (outcome?.outcome === 'APPLIED') return { accepted: true, reason: null };
            /*
             * Not applied, and the reason is the rule's own — never a stand-in. A code
             * whose answer depends on a customer the preview was not given is not
             * refused for any reason in the vocabulary: it is undecided, so the reason is
             * null and the rule's CUSTOMER_DEPENDENT outcome says why. A checkout always
             * has a customer and never reaches this branch.
             */
            if (outcome === undefined || outcome.outcome === 'CUSTOMER_DEPENDENT') {
              return { accepted: false, reason: null };
            }
            return { accepted: false, reason: outcome.reason };
          })();

  return {
    totals: {
      subtotal: base.subtotal,
      discount,
      total,
      currency,
      quote: {
        productId: base.quote.productId,
        quotedAt: base.quote.quotedAt,
        currency,
        finalAmount: total,
        trace,
        ...(cashback === null ? {} : { cashback }),
      },
    },
    outcomes: [
      ...eligible.map((r) => outcomes.get(r.id)).filter((o): o is RuleOutcome => o !== undefined),
      ...[...outcomes.values()].filter((o) => !eligible.includes(o.rule)),
    ],
    code,
  };
}

/**
 * The cashback rule that applies, and what it comes to (P8).
 *
 * The eligible rule with the HIGHEST percent, then the older one — `O-6`'s fallback,
 * "max wins". Never stacked. Basis is the final payable amount, so a fully discounted
 * order earns nothing, and a figure that rounds to zero is no promise at all.
 */
export function chooseCashback(
  rules: readonly CashbackRule[],
  subject: PricingSubject,
  totalMinor: bigint,
  currency: CurrencyCode,
): PriceQuoteCashback | null {
  if (totalMinor <= 0n) return null;
  let best: CashbackRule | null = null;
  for (const rule of rules) {
    if (!cashbackEligible(rule, subject)) continue;
    if (
      best === null ||
      rule.percent > best.percent ||
      (rule.percent === best.percent && rule.id < best.id)
    ) {
      best = rule;
    }
  }
  if (best === null) return null;
  const amount = cashbackAmountMinor(totalMinor, best.percent);
  if (amount <= 0n) return null;
  return {
    ruleId: best.id,
    ruleLabel: best.label,
    percent: best.percent,
    amount: money(amount, currency),
  };
}

export function cashbackEligible(rule: CashbackRule, subject: PricingSubject): boolean {
  if (rule.status !== 'ACTIVE') return false;
  if (rule.startsAt !== null && subject.now.getTime() < rule.startsAt.getTime()) return false;
  if (rule.endsAt !== null && subject.now.getTime() >= rule.endsAt.getTime()) return false;
  if (!rule.appliesTo.includes(subject.purpose)) return false;
  if (rule.productId !== null && rule.productId !== subject.productId) return false;
  if (rule.categoryId !== null && rule.categoryId !== subject.categoryId) return false;
  return true;
}
