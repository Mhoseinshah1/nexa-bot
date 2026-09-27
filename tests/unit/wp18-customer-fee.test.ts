import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_FEE_BASIS_POINTS_MAX,
  NOTIFICATION_KINDS,
  formatBasisPointsPercent,
  gatewayCustomerFeeMinor,
  parsePercentBasisPoints,
  paymentGatewayConfigSchema,
} from '@nexa/contracts';

/**
 * WP18 — the customer gateway fee's arithmetic and its one typed-rate parser
 * (`docs/wp18-gateway-fee-financial-log-audit.md` §2, O2 and O4).
 */
describe('gatewayCustomerFeeMinor', () => {
  it('is the owner’s example: 5 % of 200,000 is 10,000, so the payable is 210,000', () => {
    const fee = gatewayCustomerFeeMinor(200_000n, 500);
    expect(fee).toBe(10_000n);
    expect(200_000n + fee).toBe(210_000n);
  });

  it('rounds half-up to the minor unit', () => {
    expect(gatewayCustomerFeeMinor(1n, 5_000)).toBe(1n); // 0.5 → 1
    expect(gatewayCustomerFeeMinor(1n, 4_999)).toBe(0n); // 0.4999 → 0
    expect(gatewayCustomerFeeMinor(3n, 1_667)).toBe(1n); // 0.5001 → 1
    expect(gatewayCustomerFeeMinor(3n, 1_666)).toBe(0n); // 0.4998 → 0
    expect(gatewayCustomerFeeMinor(100_001n, 5_000)).toBe(50_001n); // 50000.5 → 50001
    expect(gatewayCustomerFeeMinor(99n, 1)).toBe(0n); // 0.0099 → 0
    expect(gatewayCustomerFeeMinor(50n, 1)).toBe(0n); // 0.005 → 0
    expect(gatewayCustomerFeeMinor(5_000n, 1)).toBe(1n); // 0.5 → 1
  });

  it('is zero at 0 %, the principal at 100 %, and exact far beyond 2^53', () => {
    expect(gatewayCustomerFeeMinor(123_456_789n, 0)).toBe(0n);
    expect(gatewayCustomerFeeMinor(123_456_789n, 10_000)).toBe(123_456_789n);
    // 2^53 + 1 is the first integer a double cannot hold: half of it is ….5, half-up ….7.
    const beyond = 9_007_199_254_740_993n;
    expect(gatewayCustomerFeeMinor(beyond, 5_000)).toBe(4_503_599_627_370_497n);
    // What the float arithmetic this rule forbids would have produced instead.
    expect(Math.round(Number(beyond) * 0.5)).toBe(4_503_599_627_370_496);
  });

  it('refuses a rate outside 0..10000 or not an integer, and a negative principal', () => {
    expect(() => gatewayCustomerFeeMinor(1n, -1)).toThrow(RangeError);
    expect(() => gatewayCustomerFeeMinor(1n, CUSTOMER_FEE_BASIS_POINTS_MAX + 1)).toThrow(
      RangeError,
    );
    expect(() => gatewayCustomerFeeMinor(1n, 1.5)).toThrow(RangeError);
    expect(() => gatewayCustomerFeeMinor(-1n, 1)).toThrow(RangeError);
  });
});

describe('parsePercentBasisPoints', () => {
  it.each([
    ['0', 0],
    ['5', 500],
    ['5.2', 520],
    ['5.25', 525],
    ['0.01', 1],
    ['100', 10_000],
    ['100.00', 10_000],
    ['  7.5 ', 750],
    ['12%', 1_200],
    ['۵٫۲۵', 525],
    ['۵.۲۵', 525],
    ['٥٫٢٥', 525],
  ])('accepts %j as %d basis points', (typed, basisPoints) => {
    expect(parsePercentBasisPoints(typed)).toBe(basisPoints);
  });

  it.each(['', '5.', '.5', '5.123', '-1', '+1', '1e2', '100.01', '101', '1,5', 'abc', '5..2'])(
    'refuses %j rather than rounding it',
    (typed) => {
      expect(parsePercentBasisPoints(typed)).toBeNull();
    },
  );

  it('round-trips every rate the column can hold: what is saved reopens as itself', () => {
    for (let basisPoints = 0; basisPoints <= CUSTOMER_FEE_BASIS_POINTS_MAX; basisPoints += 1) {
      expect(parsePercentBasisPoints(formatBasisPointsPercent(basisPoints))).toBe(basisPoints);
    }
    expect(formatBasisPointsPercent(525)).toBe('5.25');
    expect(formatBasisPointsPercent(520)).toBe('5.2');
    expect(formatBasisPointsPercent(500)).toBe('5');
    expect(formatBasisPointsPercent(1)).toBe('0.01');
  });
});

describe('the route config', () => {
  const base = {
    minAmountMinor: 0n,
    maxAmountMinor: 0n,
    eligibility: {
      activateAfterPayments: 0,
      deactivateAfterPayments: 0,
      activateAfterAccountDays: 0,
    },
    sortOrder: 0,
    topupCashbackPercent: 0,
  };

  it('keeps an absent fee absent, so a save that does not mention it cannot switch it off', () => {
    expect(paymentGatewayConfigSchema.parse(base).customerFeeBasisPoints).toBeUndefined();
    expect(
      paymentGatewayConfigSchema.parse({ ...base, customerFeeBasisPoints: 525 })
        .customerFeeBasisPoints,
    ).toBe(525);
  });

  it('refuses a fee above 100 %, below zero, or fractional in basis points', () => {
    for (const bad of [10_001, -1, 5.5]) {
      expect(
        paymentGatewayConfigSchema.safeParse({ ...base, customerFeeBasisPoints: bad }).success,
      ).toBe(false);
    }
  });
});

/**
 * The financial log adds no notification kind (Codex review of #82).
 *
 * `notificationSchema.kind` is a strict enum. A row whose kind the previous release does
 * not know makes that release's Web Admin refuse the whole notifications page after a
 * rollback, so the financial log writes `OPERATIONAL_EVENT` under an `ops.financial.*`
 * template key. These are the kinds the release before WP18 knows. Widening the list is
 * a staged change (the reader first, the writer in a later release), never part of a
 * feature — `docs/conventions.md`, "A widened enum is write-compatible, not
 * reader-compatible".
 */
describe('notification kinds', () => {
  it('are exactly the kinds the release before WP18 can read', () => {
    expect([...NOTIFICATION_KINDS]).toEqual([
      'OPERATIONAL_EVENT',
      'OPERATIONS_TEST',
      'RECEIPT_AWAITING_REVIEW',
    ]);
  });
});
