import { describe, expect, it } from 'vitest';
import {
  PERSONAL_DISCOUNT_PURPOSES,
  PERSONAL_DISCOUNT_STACKING,
  money,
  priceQuoteWireSchema,
  type PriceQuoteStep,
} from '@nexa/contracts';
import {
  PERSONAL_DISCOUNT_RULE_LABEL,
  applyAdjustments,
  personalDiscountPercentOf,
  type CashbackRule,
  type DiscountRule,
  type PricingInput,
  type PricingSubject,
} from '../../apps/api/src/modules/commerce/pricing/domain/pricing-engine';
import { personalDiscountApplies } from '../../apps/api/src/modules/commerce/pricing/application/pricing.service';
import {
  applyResellerLayer,
  type ResellerPricingTerms,
} from '../../apps/api/src/modules/commerce/resellers/domain/reseller-pricing';
import { priceQuoteToWire } from '../../apps/api/src/modules/commerce/orders/application/order-pricing';
import type { OrderTotalsRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';

/**
 * R10 D3 — the personal discount inside the one pricing engine.
 *
 * The rule (owner spec, lead's decision): today's quote is computed UNCHANGED, and
 * separately the list price minus the personal percent; the strictly lower total wins, a
 * tie keeps today's quote, the two are never stacked, and the decision is frozen on the
 * quote. Each case names the rule it pins; the integration suite proves it reaches an order.
 */

const NOW = new Date('2026-10-26T12:00:00.000Z');
const PRODUCT = '01900000-0000-7000-8000-00000000a001';
const CUSTOMER = '01900000-0000-7000-8000-00000000u001';

function id(n: number): string {
  return `01900000-0000-7000-8000-${n.toString().padStart(12, '0')}`;
}

function rule(overrides: Partial<DiscountRule> = {}): DiscountRule {
  return {
    id: id(1),
    kind: 'AUTOMATIC',
    code: null,
    label: 'rule',
    type: 'PERCENTAGE',
    value: 10n,
    currency: null,
    appliesTo: ['NEW_SERVICE', 'RENEW'],
    productId: null,
    categoryId: null,
    customerId: null,
    firstPurchaseOnly: false,
    minimumSubtotal: null,
    startsAt: null,
    endsAt: null,
    totalLimit: null,
    perCustomerLimit: null,
    priority: 0,
    stackable: false,
    status: 'ACTIVE',
    ...overrides,
  };
}

const CASHBACK: CashbackRule = {
  id: id(900),
  label: 'cashback',
  percent: 10,
  appliesTo: ['NEW_SERVICE', 'RENEW'],
  productId: null,
  categoryId: null,
  startsAt: null,
  endsAt: null,
  status: 'ACTIVE',
};

const SUBJECT: PricingSubject = {
  purpose: 'NEW_SERVICE',
  productId: PRODUCT,
  categoryId: null,
  customerId: CUSTOMER,
  isFirstPurchase: false,
  now: NOW,
};

function list(amount: bigint): OrderTotalsRecord {
  const step: PriceQuoteStep = {
    step: 'BASE_PRICE',
    effect: 'REPLACES',
    ruleId: null,
    ruleLabel: 'base',
    amountBefore: money(amount, 'IRT'),
    amountAfter: money(amount, 'IRT'),
  };
  return {
    subtotal: money(amount, 'IRT'),
    discount: money(0n, 'IRT'),
    total: money(amount, 'IRT'),
    currency: 'IRT',
    quote: {
      productId: PRODUCT,
      quotedAt: NOW.toISOString(),
      currency: 'IRT',
      finalAmount: money(amount, 'IRT'),
      trace: [step],
    },
  } as unknown as OrderTotalsRecord;
}

function terms(overrides: Partial<ResellerPricingTerms> = {}): ResellerPricingTerms {
  return {
    resellerId: id(500),
    customerId: CUSTOMER,
    tierId: id(501),
    tierName: 'tier',
    layer: 'TIER',
    percent: 20,
    fixedPrice: null,
    ...overrides,
  };
}

function input(
  amount: bigint,
  options: {
    percent?: number | null;
    automatic?: DiscountRule[];
    coded?: DiscountRule | null | undefined;
    reseller?: ResellerPricingTerms | null;
    cashback?: boolean;
  } = {},
): PricingInput {
  const listBase = list(amount);
  const base =
    options.reseller === undefined || options.reseller === null
      ? listBase
      : applyResellerLayer(listBase, options.reseller);
  return {
    base,
    subject: SUBJECT,
    automatic: options.automatic ?? [],
    ...(options.coded === undefined ? {} : { coded: options.coded }),
    usage: new Map(),
    cashbackRules: options.cashback === true ? [CASHBACK] : [],
    personal:
      options.percent === undefined || options.percent === null
        ? null
        : { percent: options.percent, list: listBase },
  };
}

const steps = (result: ReturnType<typeof applyAdjustments>) =>
  result.totals.quote.trace.map((s) => s.step);

describe('personal discount: the engine', () => {
  it('with no personal discount, or a zero percent, prices exactly as before (byte-identical)', () => {
    const automatic = [rule({ value: 15n })];
    const { personal: _none, ...without } = input(100_000n, { automatic });
    const before = applyAdjustments(without);
    expect(applyAdjustments(input(100_000n, { automatic }))).toEqual(before);
    expect(applyAdjustments(input(100_000n, { automatic, percent: 0 }))).toEqual(before);
    // Not even an empty decision on the quote: a stored quote it took no part in is unchanged.
    expect(
      'personalDiscount' in applyAdjustments(input(100_000n, { percent: 0 })).totals.quote,
    ).toBe(false);
  });

  it('applies the personal price when it is strictly lower, on the LIST price, alone', () => {
    const result = applyAdjustments(
      input(100_000n, { percent: 30, automatic: [rule({ value: 10n })] }),
    );
    expect(result.totals.total.amountMinor).toBe(70_000n);
    expect(result.totals.subtotal.amountMinor).toBe(100_000n);
    expect(result.totals.discount.amountMinor).toBe(30_000n);
    expect(steps(result)).toEqual(['BASE_PRICE', 'PERSONAL_DISCOUNT']);
    const step = result.totals.quote.trace[1];
    expect(step).toMatchObject({
      ruleId: null,
      ruleLabel: PERSONAL_DISCOUNT_RULE_LABEL,
      effect: 'ADJUSTS',
    });
    expect(step?.amountBefore.amountMinor).toBe(100_000n);
    expect(step?.amountAfter.amountMinor).toBe(70_000n);
    expect(result.totals.quote.finalAmount.amountMinor).toBe(70_000n);
    // The decision, with the losing ordinary total on the record.
    expect(result.totals.quote.personalDiscount).toEqual({
      percent: 30,
      outcome: 'APPLIED',
      competingTotal: money(90_000n, 'IRT'),
      rule: PERSONAL_DISCOUNT_STACKING,
    });
    // The automatic rule that would have applied is reported as not combinable.
    expect(result.outcomes.map((o) => [o.outcome, o.reason, o.amount])).toEqual([
      ['SKIPPED', 'NOT_COMBINABLE', 0n],
    ]);
  });

  it('keeps the ordinary quote when it is lower, and records the personal price it beat', () => {
    const automatic = [rule({ value: 40n })];
    const ordinary = applyAdjustments(input(100_000n, { automatic }));
    const result = applyAdjustments(input(100_000n, { percent: 30, automatic }));
    expect(result.totals.total.amountMinor).toBe(60_000n);
    expect(result.totals.quote.trace).toEqual(ordinary.totals.quote.trace);
    expect(result.outcomes).toEqual(ordinary.outcomes);
    expect(result.totals.quote.personalDiscount).toEqual({
      percent: 30,
      outcome: 'NOT_LARGER',
      competingTotal: money(70_000n, 'IRT'),
      rule: PERSONAL_DISCOUNT_STACKING,
    });
  });

  it('a TIE keeps the ordinary quote', () => {
    const automatic = [rule({ value: 30n })];
    const result = applyAdjustments(input(100_000n, { percent: 30, automatic }));
    expect(result.totals.total.amountMinor).toBe(70_000n);
    expect(steps(result)).toEqual(['BASE_PRICE', 'PROMOTIONAL_DISCOUNT']);
    expect(result.totals.quote.personalDiscount?.outcome).toBe('NOT_LARGER');
  });

  it('refuses an accepted code with the one not-combinable reason when the personal price wins', () => {
    const coded = rule({ id: id(2), kind: 'CODE', code: 'TEN', value: 10n });
    const result = applyAdjustments(input(100_000n, { percent: 25, coded }));
    expect(result.code).toEqual({ accepted: false, reason: 'NOT_COMBINABLE' });
    expect(result.totals.total.amountMinor).toBe(75_000n);
    // And a code larger than the personal discount is accepted, the personal one losing.
    const big = rule({ id: id(3), kind: 'CODE', code: 'FIFTY', value: 50n });
    const won = applyAdjustments(input(100_000n, { percent: 25, coded: big }));
    expect(won.code).toEqual({ accepted: true, reason: null });
    expect(won.totals.total.amountMinor).toBe(50_000n);
    expect(won.totals.quote.personalDiscount?.outcome).toBe('NOT_LARGER');
  });

  it('is never taken off a reseller price: it competes with it, on the list', () => {
    // Reseller 20% off → 80 000. Personal 30% of LIST → 70 000 wins; not 30% of 80 000.
    const won = applyAdjustments(input(100_000n, { percent: 30, reseller: terms() }));
    expect(won.totals.total.amountMinor).toBe(70_000n);
    expect(won.totals.subtotal.amountMinor).toBe(100_000n);
    expect(steps(won)).toEqual(['BASE_PRICE', 'PERSONAL_DISCOUNT']);
    expect(won.totals.quote.personalDiscount?.competingTotal.amountMinor).toBe(80_000n);
    // Personal 10% → 90 000 loses to the reseller's 80 000, which stands untouched.
    const lost = applyAdjustments(input(100_000n, { percent: 10, reseller: terms() }));
    expect(lost.totals.total.amountMinor).toBe(80_000n);
    expect(steps(lost)).toEqual(['BASE_PRICE', 'TIER_PRICE']);
  });

  it('floors a 100% personal discount at one minor unit payable, exactly as a 100% code', () => {
    const personal = applyAdjustments(input(10_000n, { percent: 100 }));
    const code = applyAdjustments(
      input(10_000n, { coded: rule({ kind: 'CODE', code: 'ALL', value: 100n }) }),
    );
    expect(personal.totals.total.amountMinor).toBe(1n);
    expect(personal.totals.total.amountMinor).toBe(code.totals.total.amountMinor);
    expect(personal.totals.discount.amountMinor).toBe(9_999n);
  });

  it('rounds the percent in the customer’s favour, like a percentage rule', () => {
    // 33% of 1 001 is 330.33: the discount is 331, the price 670 — whole minor units.
    const result = applyAdjustments(input(1_001n, { percent: 33 }));
    expect(result.totals.total.amountMinor).toBe(670n);
    const asRule = applyAdjustments(input(1_001n, { automatic: [rule({ value: 33n })] }));
    expect(result.totals.total.amountMinor).toBe(asRule.totals.total.amountMinor);
  });

  it('records NOT_APPLICABLE when there is nothing to take off a one-unit price', () => {
    const result = applyAdjustments(input(1n, { percent: 50 }));
    expect(result.totals.total.amountMinor).toBe(1n);
    expect(steps(result)).toEqual(['BASE_PRICE']);
    expect(result.totals.quote.personalDiscount?.outcome).toBe('NOT_APPLICABLE');
  });

  it('promises cashback on the personal total, the final payable', () => {
    const result = applyAdjustments(input(100_000n, { percent: 30, cashback: true }));
    expect(result.totals.quote.cashback?.amount.amountMinor).toBe(7_000n);
  });

  it('cross product: the total is min(ordinary, personal) and the two are never stacked', () => {
    const resellers: (ResellerPricingTerms | null)[] = [
      null,
      terms(),
      terms({ layer: 'OVERRIDE', percent: 35 }),
      terms({ percent: null, fixedPrice: money(55_000n, 'IRT') }),
    ];
    const automatics: DiscountRule[][] = [
      [],
      [rule({ value: 10n })],
      [rule({ value: 10n, stackable: true }), rule({ id: id(4), value: 20n, stackable: true })],
      [rule({ type: 'FIXED_AMOUNT', value: 25_000n, currency: 'IRT' })],
    ];
    const codes: (DiscountRule | undefined)[] = [
      undefined,
      rule({ id: id(7), kind: 'CODE', code: 'C', value: 15n, stackable: true }),
    ];
    let cases = 0;
    for (const reseller of resellers) {
      for (const automatic of automatics) {
        for (const coded of codes) {
          for (const percent of [1, 5, 20, 33, 45, 60, 100]) {
            const ordinary = applyAdjustments({
              ...input(100_000n, { automatic, coded, reseller }),
              personal: null,
            });
            const result = applyAdjustments(
              input(100_000n, { automatic, coded, reseller, percent }),
            );
            const off = (100_000n * BigInt(percent) + 99n) / 100n;
            const personalTotal = 100_000n - (off >= 100_000n ? 99_999n : off);
            const expected =
              personalTotal < ordinary.totals.total.amountMinor
                ? personalTotal
                : ordinary.totals.total.amountMinor;
            expect(result.totals.total.amountMinor, `${percent}%`).toBe(expected);
            const kinds = steps(result);
            if (kinds.includes('PERSONAL_DISCOUNT')) {
              expect(kinds).toEqual(['BASE_PRICE', 'PERSONAL_DISCOUNT']);
              expect(result.outcomes.every((o) => o.outcome !== 'APPLIED')).toBe(true);
            } else {
              expect(result.totals).toEqual({
                ...ordinary.totals,
                quote: { ...ordinary.totals.quote, personalDiscount: expect.anything() },
              });
            }
            cases += 1;
          }
        }
      }
    }
    expect(cases).toBe(4 * 4 * 2 * 7);
  });
});

describe('personal discount: purposes, the frozen record and the wire', () => {
  it('applies to purchases and renewals only — never a top-up, an add-on or a custom service', () => {
    expect([...PERSONAL_DISCOUNT_PURPOSES]).toEqual(['NEW_SERVICE', 'RENEW']);
    expect(personalDiscountApplies('NEW_SERVICE')).toBe(true);
    expect(personalDiscountApplies('RENEW')).toBe(true);
    for (const purpose of [
      'ADD_TRAFFIC',
      'ADD_TIME',
      'ADD_DEVICES',
      'CHANGE_LOCATION',
      'CUSTOM_SERVICE',
      'TRIAL',
      'WALLET_TOPUP',
    ]) {
      expect(personalDiscountApplies(purpose), purpose).toBe(false);
    }
  });

  it('names the percent an order was PRICED with, from the frozen quote alone', () => {
    const won = applyAdjustments(input(100_000n, { percent: 30 })).totals.quote;
    const lost = applyAdjustments(
      input(100_000n, { percent: 30, automatic: [rule({ value: 50n })] }),
    ).totals.quote;
    expect(personalDiscountPercentOf(won)).toBe(30);
    expect(personalDiscountPercentOf(lost)).toBeNull();
    expect(personalDiscountPercentOf(list(100n).quote)).toBeNull();
  });

  it('stores the decision on the wire and parses a quote stored before it existed', () => {
    const quote = applyAdjustments(input(100_000n, { percent: 30 })).totals.quote;
    const wire = priceQuoteWireSchema.parse(JSON.parse(JSON.stringify(priceQuoteToWire(quote))));
    expect(wire.personalDiscount).toEqual({
      percent: 30,
      outcome: 'APPLIED',
      competingTotal: { amountMinor: '100000', currency: 'IRT' },
      rule: 'LARGER_SINGLE_WINS',
    });
    const old = priceQuoteToWire(list(100n).quote);
    expect('personalDiscount' in old).toBe(false);
    expect(priceQuoteWireSchema.safeParse(old).success).toBe(true);
  });
});
