import { describe, expect, it } from 'vitest';
import { money, type PriceQuoteStep } from '@nexa/contracts';
import {
  applyAdjustments,
  byPrecedence,
  chooseCashback,
  discountEligibility,
  redemptionRefusal,
  type CashbackRule,
  type DiscountRule,
  type PricingSubject,
} from '../../apps/api/src/modules/commerce/pricing/domain/pricing-engine';
import type { OrderTotalsRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';

/**
 * The pricing engine, as a pure function (`docs/wp8-pricing-audit.md` P2, P4, P5, P8).
 *
 * Each case names the rule it pins. The integration suites prove the engine's answer
 * reaches an order; these prove the answer itself, including the orderings a database
 * would hide — which reason is reported first, which of two equal rules wins, what a
 * discount does to the one after it.
 */

const NOW = new Date('2026-09-01T12:00:00.000Z');
const PRODUCT = '01900000-0000-7000-8000-00000000a001';
const CATEGORY = '01900000-0000-7000-8000-00000000c001';
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
    appliesTo: ['NEW_SERVICE'],
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

function cashback(overrides: Partial<CashbackRule> = {}): CashbackRule {
  return {
    id: id(900),
    label: 'cashback',
    percent: 10,
    appliesTo: ['NEW_SERVICE'],
    productId: null,
    categoryId: null,
    startsAt: null,
    endsAt: null,
    status: 'ACTIVE',
    ...overrides,
  };
}

const SUBJECT: PricingSubject = {
  purpose: 'NEW_SERVICE',
  productId: PRODUCT,
  categoryId: CATEGORY,
  customerId: CUSTOMER,
  isFirstPurchase: true,
  now: NOW,
};

function base(amount: bigint): OrderTotalsRecord {
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

const NONE = { live: 0, liveForCustomer: 0 };

function price(
  amount: bigint,
  automatic: DiscountRule[],
  options: {
    coded?: DiscountRule | null;
    cashbackRules?: CashbackRule[];
    subject?: Partial<PricingSubject>;
  } = {},
) {
  return applyAdjustments({
    base: base(amount),
    subject: { ...SUBJECT, ...options.subject },
    automatic,
    ...(options.coded === undefined ? {} : { coded: options.coded }),
    usage: new Map(),
    cashbackRules: options.cashbackRules ?? [],
  });
}

const applied = (result: ReturnType<typeof price>) =>
  result.totals.quote.trace.filter((s) => s.step === 'PROMOTIONAL_DISCOUNT').map((s) => s.ruleId);

describe('eligibility', () => {
  it('reports ONE reason, in a fixed order, whatever else is also wrong', () => {
    const everythingWrong = rule({
      status: 'INACTIVE',
      endsAt: new Date(NOW.getTime() - 1),
      appliesTo: ['RENEW'],
      productId: id(77),
    });
    expect(discountEligibility(everythingWrong, SUBJECT, 100n, 'IRT', NONE)).toBe('INACTIVE');
    expect(
      discountEligibility({ ...everythingWrong, status: 'ACTIVE' }, SUBJECT, 100n, 'IRT', NONE),
    ).toBe('ENDED');
    expect(
      discountEligibility(
        { ...everythingWrong, status: 'ACTIVE', endsAt: null },
        SUBJECT,
        100n,
        'IRT',
        NONE,
      ),
    ).toBe('PURPOSE');
  });

  it('treats the window as half-open: open at its start, closed at its end', () => {
    expect(discountEligibility(rule({ startsAt: NOW }), SUBJECT, 100n, 'IRT', NONE)).toBeNull();
    expect(discountEligibility(rule({ endsAt: NOW }), SUBJECT, 100n, 'IRT', NONE)).toBe('ENDED');
    expect(
      discountEligibility(
        rule({ startsAt: new Date(NOW.getTime() + 1) }),
        SUBJECT,
        100n,
        'IRT',
        NONE,
      ),
    ).toBe('NOT_STARTED');
  });

  it('refuses a fixed amount in another currency, and a subtotal under the minimum', () => {
    expect(
      discountEligibility(
        rule({ type: 'FIXED_AMOUNT', value: 5n, currency: 'USD' }),
        SUBJECT,
        100n,
        'IRT',
        NONE,
      ),
    ).toBe('CURRENCY');
    expect(discountEligibility(rule({ minimumSubtotal: 101n }), SUBJECT, 100n, 'IRT', NONE)).toBe(
      'MINIMUM_SUBTOTAL',
    );
    expect(
      discountEligibility(rule({ minimumSubtotal: 100n }), SUBJECT, 100n, 'IRT', NONE),
    ).toBeNull();
  });

  it('counts limits as reached AT the limit', () => {
    expect(
      discountEligibility(rule({ totalLimit: 2 }), SUBJECT, 100n, 'IRT', {
        live: 2,
        liveForCustomer: 0,
      }),
    ).toBe('TOTAL_LIMIT');
    expect(
      discountEligibility(rule({ perCustomerLimit: 1 }), SUBJECT, 100n, 'IRT', {
        live: 1,
        liveForCustomer: 1,
      }),
    ).toBe('CUSTOMER_LIMIT');
    expect(
      discountEligibility(rule({ totalLimit: 2 }), SUBJECT, 100n, 'IRT', {
        live: 1,
        liveForCustomer: 1,
      }),
    ).toBeNull();
  });

  it('says CUSTOMER_DEPENDENT, never yes or no, for a customer rule with no customer', () => {
    const anonymous = { ...SUBJECT, customerId: null, isFirstPurchase: null };
    for (const r of [
      rule({ customerId: CUSTOMER }),
      rule({ firstPurchaseOnly: true }),
      rule({ perCustomerLimit: 1 }),
    ]) {
      expect(discountEligibility(r, anonymous, 100n, 'IRT', NONE)).toBe('CUSTOMER_DEPENDENT');
    }
    // A rule that does not depend on the customer is decided without one.
    expect(discountEligibility(rule(), anonymous, 100n, 'IRT', NONE)).toBeNull();
  });

  it('refuses another customer’s rule and a repeat purchase’s first-purchase rule', () => {
    expect(discountEligibility(rule({ customerId: id(55) }), SUBJECT, 100n, 'IRT', NONE)).toBe(
      'CUSTOMER',
    );
    expect(
      discountEligibility(
        rule({ firstPurchaseOnly: true }),
        { ...SUBJECT, isFirstPurchase: false },
        100n,
        'IRT',
        NONE,
      ),
    ).toBe('FIRST_PURCHASE');
  });
});

describe('redemption at confirmation re-decides only what can change after a quote', () => {
  it('ignores scope, which the quote already decided against the frozen snapshot', () => {
    // An operator narrowing the rule to another product after the quote does not undo it.
    expect(redemptionRefusal(rule({ productId: id(88) }), NOW, NONE, true)).toBeNull();
  });

  it('refuses a withdrawn rule, a closed window, a spent limit and a lost first purchase', () => {
    expect(redemptionRefusal(rule({ status: 'INACTIVE' }), NOW, NONE, true)).toBe('INACTIVE');
    expect(redemptionRefusal(rule({ endsAt: NOW }), NOW, NONE, true)).toBe('ENDED');
    expect(
      redemptionRefusal(rule({ totalLimit: 1 }), NOW, { live: 1, liveForCustomer: 0 }, true),
    ).toBe('TOTAL_LIMIT');
    expect(
      redemptionRefusal(rule({ perCustomerLimit: 1 }), NOW, { live: 1, liveForCustomer: 1 }, true),
    ).toBe('CUSTOMER_LIMIT');
    expect(redemptionRefusal(rule({ firstPurchaseOnly: true }), NOW, NONE, false)).toBe(
      'FIRST_PURCHASE',
    );
  });
});

describe('precedence and stacking', () => {
  it('orders by priority descending, then by the older id', () => {
    const rules = [
      rule({ id: id(3), priority: 1 }),
      rule({ id: id(2), priority: 5 }),
      rule({ id: id(1), priority: 5 }),
    ];
    expect([...rules].sort(byPrecedence).map((r) => r.id)).toEqual([id(1), id(2), id(3)]);
  });

  it('never lets the order the rows arrived in decide the price', () => {
    const a = rule({ id: id(1), priority: 5, value: 10n });
    const b = rule({ id: id(2), priority: 5, value: 40n });
    expect(price(1_000n, [a, b]).totals.total.amountMinor).toBe(
      price(1_000n, [b, a]).totals.total.amountMinor,
    );
    expect(applied(price(1_000n, [b, a]))).toEqual([id(1)]);
  });

  it('applies one rule when the first is not stackable', () => {
    const result = price(1_000n, [
      rule({ id: id(1), priority: 9, stackable: false, value: 10n }),
      rule({ id: id(2), priority: 1, stackable: true, value: 10n }),
    ]);
    expect(applied(result)).toEqual([id(1)]);
    expect(result.outcomes.find((o) => o.rule.id === id(2))).toMatchObject({
      outcome: 'SKIPPED',
      reason: 'NOT_COMBINABLE',
    });
  });

  it('compounds stackable percentages on the running amount', () => {
    const result = price(1_000n, [
      rule({ id: id(1), priority: 9, stackable: true, value: 50n }),
      rule({ id: id(2), priority: 5, stackable: true, value: 50n }),
    ]);
    // 1 000 → 500 → 250, not 1 000 − 500 − 500.
    expect(result.totals.total.amountMinor).toBe(250n);
    expect(result.totals.discount.amountMinor).toBe(750n);
  });

  it('skips a rule whose turn comes when nothing is left, rather than recording a zero step', () => {
    const result = price(1_000n, [
      rule({ id: id(1), priority: 9, stackable: true, value: 100n }),
      rule({ id: id(2), priority: 5, stackable: true, value: 10n }),
    ]);
    expect(result.totals.total.amountMinor).toBe(0n);
    expect(applied(result)).toEqual([id(1)]);
  });

  it('never goes below zero, and rounds a percentage up for the customer', () => {
    expect(
      price(10n, [rule({ type: 'FIXED_AMOUNT', value: 999n, currency: 'IRT' })]).totals.total
        .amountMinor,
    ).toBe(0n);
    // 33% of 1 001 = 330.33 → 331 off.
    expect(price(1_001n, [rule({ value: 33n })]).totals.discount.amountMinor).toBe(331n);
  });

  it('reads a CODE rule passed as automatic as nothing at all', () => {
    const smuggled = rule({ kind: 'CODE', code: 'SECRET', value: 90n });
    expect(price(1_000n, [smuggled]).totals.total.amountMinor).toBe(1_000n);
  });
});

describe('an entered code', () => {
  it('is UNKNOWN_CODE when it matched no rule', () => {
    expect(price(1_000n, [], { coded: null }).code).toEqual({
      accepted: false,
      reason: 'UNKNOWN_CODE',
    });
  });

  it('is refused as NOT_COMBINABLE when a higher-priority non-stackable rule took the order', () => {
    const result = price(1_000n, [rule({ id: id(1), priority: 9 })], {
      coded: rule({ id: id(2), kind: 'CODE', code: 'C', priority: 1, stackable: true }),
    });
    expect(result.code).toEqual({ accepted: false, reason: 'NOT_COMBINABLE' });
    expect(applied(result)).toEqual([id(1)]);
  });

  it('is undecided — refused with no reason — when its answer depends on an absent customer', () => {
    // A stand-in reason here would tell an operator a live rule is INACTIVE.
    const result = price(1_000n, [], {
      coded: rule({ id: id(2), kind: 'CODE', code: 'C', perCustomerLimit: 1 }),
      subject: { customerId: null, isFirstPurchase: null },
    });
    expect(result.code).toEqual({ accepted: false, reason: null });
    expect(result.outcomes[0]).toMatchObject({ outcome: 'CUSTOMER_DEPENDENT' });
  });

  it('is accepted and applied when it wins', () => {
    const result = price(1_000n, [], {
      coded: rule({ id: id(2), kind: 'CODE', code: 'C', value: 25n }),
    });
    expect(result.code).toEqual({ accepted: true, reason: null });
    expect(result.totals.total.amountMinor).toBe(750n);
  });
});

describe('cashback', () => {
  it('takes the highest percent, then the older rule, and never stacks', () => {
    const chosen = chooseCashback(
      [
        cashback({ id: id(903), percent: 5 }),
        cashback({ id: id(902), percent: 12 }),
        cashback({ id: id(901), percent: 12 }),
      ],
      SUBJECT,
      1_000n,
      'IRT',
    );
    expect(chosen).toMatchObject({ ruleId: id(901), percent: 12 });
    expect(chosen?.amount.amountMinor).toBe(120n);
  });

  it('is computed on the FINAL total, rounded down', () => {
    const result = price(1_001n, [rule({ value: 50n })], {
      cashbackRules: [cashback({ percent: 7 })],
    });
    // 1 001 − 501 = 500; 7% of 500 is 35.
    expect(result.totals.quote.cashback?.amount.amountMinor).toBe(35n);
  });

  it('promises nothing on a zero total — a trial, or an order discounted to nothing', () => {
    expect(chooseCashback([cashback()], SUBJECT, 0n, 'IRT')).toBeNull();
  });

  it('promises nothing when the figure rounds to zero', () => {
    expect(chooseCashback([cashback({ percent: 1 })], SUBJECT, 99n, 'IRT')).toBeNull();
  });

  it('respects status, window, purpose, product and category', () => {
    for (const r of [
      cashback({ status: 'INACTIVE' }),
      cashback({ endsAt: NOW }),
      cashback({ startsAt: new Date(NOW.getTime() + 1) }),
      cashback({ appliesTo: ['RENEW'] }),
      cashback({ productId: id(71) }),
      cashback({ categoryId: id(72) }),
    ]) {
      expect(chooseCashback([r], SUBJECT, 1_000n, 'IRT')).toBeNull();
    }
  });
});
