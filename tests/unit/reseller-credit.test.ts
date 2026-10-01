import { describe, expect, it } from 'vitest';
import {
  RESELLER_DEFAULT_CREDIT_LIMIT_MINOR,
  money,
  resellerRegisterSchema,
  resellerTierWriteSchema,
  resellerUpdateSchema,
  type ResellerStatus,
} from '@nexa/contracts';
import {
  creditAllowanceOf,
  creditFigures,
  creditStateOf,
  effectiveLimitOf,
  type CreditTerms,
} from '../../apps/api/src/modules/commerce/resellers/domain/reseller-credit';
import { canCover } from '../../apps/api/src/modules/commerce/wallet/domain/balance';

/**
 * Reseller credit, REMOVED (owner decision, 2026-10-01: no reseller debt, no credit
 * purchases; `docs/reseller-phase3-closure.md` §3).
 *
 * Settlement (`ResellerService.creditAllowance`), the operator's credit view and the
 * resellers report all call `creditAllowanceOf`, so the rule below is a rule of what a
 * purchase may do, not only of what an operator is shown: nothing below zero, ever.
 */

const terms = (overrides: Partial<CreditTerms> = {}): CreditTerms => ({
  status: 'ACTIVE',
  ownLimit: null,
  tierLimit: money(100_000n, 'IRT'),
  ...overrides,
});

describe('effectiveLimitOf (the STORED limit, which grants nothing)', () => {
  it('is the tier’s limit when the reseller has none of their own', () => {
    expect(effectiveLimitOf(terms())).toEqual({ limit: money(100_000n, 'IRT'), source: 'TIER' });
  });

  it('is the reseller’s own limit when set, including zero', () => {
    for (const own of [0n, 30_000n, 500_000n]) {
      expect(effectiveLimitOf(terms({ ownLimit: money(own, 'IRT') }))).toEqual({
        limit: money(own, 'IRT'),
        source: 'RESELLER',
      });
    }
  });
});

describe('creditStateOf and creditAllowanceOf: credit was removed', () => {
  it('is CREDIT_REMOVED and an allowance of zero, the only answers there are', () => {
    expect(creditStateOf()).toBe('CREDIT_REMOVED');
    expect(creditAllowanceOf()).toBe(0n);
    expect(RESELLER_DEFAULT_CREDIT_LIMIT_MINOR).toBe(0n);
  });

  it('lets no stored limit, status or currency take a wallet below zero', () => {
    for (const status of ['ACTIVE', 'SUSPENDED'] as ResellerStatus[]) {
      for (const own of [null, money(30_000n, 'IRT'), money(5_000n, 'USD')]) {
        // The terms a row stored before the decision may still hold: they decide nothing.
        expect(effectiveLimitOf(terms({ status, ownLimit: own })).limit.amountMinor > 0n).toBe(
          true,
        );
        expect(canCover(0n, 1n, creditAllowanceOf())).toBe(false);
        expect(canCover(1_000n, 1_001n, creditAllowanceOf())).toBe(false);
        expect(canCover(1_000n, 1_000n, creditAllowanceOf())).toBe(true);
      }
    }
  });
});

describe('every reseller write schema refuses a non-zero credit limit', () => {
  const tierId = '01890a5d-ac96-774b-bcce-b302099a8057';
  const customerId = '01890a5d-ac96-774b-bcce-b302099a8058';
  const limit = (amount: string) => ({ amount, currency: 'IRT' as const });
  const tier = (amount: string) => ({
    idempotencyKey: 'tier-key-1',
    name: 'Gold',
    pricingMode: 'LIST_PRICE',
    discountPercentage: null,
    creditLimit: limit(amount),
  });
  const register = (creditLimit: ReturnType<typeof limit> | null) => ({
    idempotencyKey: 'register-key-1',
    customerId,
    tierId,
    pricingMode: 'TIER',
    discountPercentage: null,
    creditLimit,
  });
  const update = (creditLimit: ReturnType<typeof limit> | null) => ({
    idempotencyKey: 'update-key-1',
    status: 'ACTIVE',
    tierId,
    pricingMode: 'TIER',
    discountPercentage: null,
    creditLimit,
  });

  it('accepts zero, and null where the field is nullable', () => {
    expect(resellerTierWriteSchema.safeParse(tier('0')).success).toBe(true);
    expect(resellerRegisterSchema.safeParse(register(null)).success).toBe(true);
    expect(resellerRegisterSchema.safeParse(register(limit('0'))).success).toBe(true);
    expect(resellerUpdateSchema.safeParse(update(null)).success).toBe(true);
    expect(resellerUpdateSchema.safeParse(update(limit('0'))).success).toBe(true);
  });

  it('refuses one minor unit and anything above, on all three writes', () => {
    for (const amount of ['1', '100000', '1000000000000']) {
      const refusals = [
        resellerTierWriteSchema.safeParse(tier(amount)),
        resellerRegisterSchema.safeParse(register(limit(amount))),
        resellerUpdateSchema.safeParse(update(limit(amount))),
      ];
      for (const result of refusals) {
        expect(result.success).toBe(false);
        expect(JSON.stringify(result.error?.issues)).toContain('Reseller credit was removed');
      }
    }
  });
});

describe('creditFigures', () => {
  it('reads a positive balance as no credit in use', () => {
    expect(creditFigures(5_000n, 100_000n)).toEqual({
      creditInUse: 0n,
      availableToSpend: 105_000n,
      overLimitBy: 0n,
    });
  });

  it('reads a negative balance as the credit in use (a legacy debt, with no allowance now)', () => {
    expect(creditFigures(-80_000n, 100_000n)).toEqual({
      creditInUse: 80_000n,
      availableToSpend: 20_000n,
      overLimitBy: 0n,
    });
  });

  it('reports what a lowered limit or a suspension no longer covers, never below zero', () => {
    expect(creditFigures(-80_000n, 50_000n)).toEqual({
      creditInUse: 80_000n,
      availableToSpend: -30_000n,
      overLimitBy: 30_000n,
    });
    // The allowance is zero now: a legacy debt is all over the limit, and nothing is
    // available beyond the (negative) balance.
    expect(creditFigures(-80_000n, creditAllowanceOf())).toEqual({
      creditInUse: 80_000n,
      availableToSpend: -80_000n,
      overLimitBy: 80_000n,
    });
    expect(creditFigures(0n, 0n)).toEqual({
      creditInUse: 0n,
      availableToSpend: 0n,
      overLimitBy: 0n,
    });
  });

  it('agrees with canCover at the frontier: availableToSpend passes, one more does not', () => {
    for (const [balance, allowance] of [
      [0n, 100_000n],
      [-80_000n, 100_000n],
      [12_345n, 0n],
      [-1n, 1n],
    ] as const) {
      const { availableToSpend } = creditFigures(balance, allowance);
      if (availableToSpend > 0n) {
        expect(canCover(balance, availableToSpend, allowance)).toBe(true);
      }
      expect(canCover(balance, availableToSpend + 1n, allowance)).toBe(false);
    }
  });
});
