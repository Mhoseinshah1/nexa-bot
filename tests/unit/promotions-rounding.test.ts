import { describe, expect, it } from 'vitest';
import {
  cashbackAmountMinor,
  cashbackTargetMinor,
  discountAmountMinor,
  isDiscountablePurpose,
  DISCOUNTABLE_PURPOSES,
  ORDER_PURPOSES,
} from '@nexa/contracts';

/**
 * The rounding rules of `docs/wp8-pricing-audit.md` P5, pinned at their boundaries.
 *
 * Each direction is the one that keeps a stated percentage true from the customer's
 * side: a discount is rounded UP (they pay at most what was promised), cashback is
 * rounded DOWN (it is never more than what was promised), and a reversal is computed
 * from the cumulative refunded amount so partial refunds cannot drift.
 */
describe('discount rounding', () => {
  it('rounds a percentage discount up to the minor unit', () => {
    // 10% of 1005 is 100.5: the customer pays 904, never 905.
    expect(discountAmountMinor('PERCENTAGE', 1005n, 10n)).toBe(101n);
    // An exact figure is not rounded at all.
    expect(discountAmountMinor('PERCENTAGE', 1000n, 10n)).toBe(100n);
    // 1% of 1 is a hundredth of a unit, and the customer gets the unit.
    expect(discountAmountMinor('PERCENTAGE', 1n, 1n)).toBe(1n);
  });

  it('never takes more than the whole subtotal for a percentage', () => {
    for (const subtotal of [1n, 7n, 99n, 101n, 12_345n, 9_999_999_999n]) {
      for (const percent of [1n, 33n, 50n, 99n, 100n]) {
        const off = discountAmountMinor('PERCENTAGE', subtotal, percent);
        expect(off).toBeLessThanOrEqual(subtotal);
        // And the customer pays at most (100 - p)% of the subtotal.
        expect((subtotal - off) * 100n).toBeLessThanOrEqual(subtotal * (100n - percent));
      }
    }
  });
});

describe('cashback rounding', () => {
  it('rounds cashback down, so it never exceeds the stated percentage', () => {
    expect(cashbackAmountMinor(1005n, 10)).toBe(100n);
    expect(cashbackAmountMinor(1000n, 10)).toBe(100n);
    expect(cashbackAmountMinor(9n, 10)).toBe(0n);
    expect(cashbackAmountMinor(0n, 10)).toBe(0n);
    expect(cashbackAmountMinor(500n, 100)).toBe(500n);
  });

  it('reverses in full at a full refund, and partial reversals sum to exactly the whole', () => {
    const promised = 333n;
    const paid = 10_000n;
    expect(cashbackTargetMinor(promised, paid, 0n)).toBe(promised);
    expect(cashbackTargetMinor(promised, paid, paid)).toBe(0n);

    // Three uneven partial refunds: each reversal is the drop in the cumulative target.
    let refunded = 0n;
    let reversed = 0n;
    for (const part of [1_234n, 5_000n, 3_766n]) {
      const before = cashbackTargetMinor(promised, paid, refunded);
      refunded += part;
      const after = cashbackTargetMinor(promised, paid, refunded);
      expect(after).toBeLessThanOrEqual(before);
      reversed += before - after;
    }
    expect(refunded).toBe(paid);
    expect(reversed).toBe(promised);
  });

  it('never goes negative when more than the payment is reported refunded', () => {
    expect(cashbackTargetMinor(100n, 1000n, 2000n)).toBe(0n);
  });
});

describe('discountable purposes', () => {
  it('are the order purposes minus TRIAL, and a trial is never discountable', () => {
    expect(isDiscountablePurpose('TRIAL')).toBe(false);
    expect([...DISCOUNTABLE_PURPOSES].sort()).toEqual(
      ORDER_PURPOSES.filter((p) => p !== 'TRIAL').sort(),
    );
  });
});
