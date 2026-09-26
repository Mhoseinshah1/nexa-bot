import { describe, expect, it } from 'vitest';
import { money, type ResellerStatus } from '@nexa/contracts';
import {
  creditAllowanceOf,
  creditFigures,
  creditStateOf,
  effectiveLimitOf,
  type CreditTerms,
} from '../../apps/api/src/modules/commerce/resellers/domain/reseller-credit';
import { canCover } from '../../apps/api/src/modules/commerce/wallet/domain/balance';

/**
 * R8, the one statement of the allowance (`docs/wp14-reseller-phase2-audit.md` D1, D5).
 *
 * Settlement (`ResellerService.creditAllowance`) and the operator's credit view both call
 * `creditAllowanceOf`, so each rule below is a rule of what a purchase may do, not only of
 * what an operator is shown.
 */

const terms = (overrides: Partial<CreditTerms> = {}): CreditTerms => ({
  status: 'ACTIVE',
  ownLimit: null,
  tierLimit: money(100_000n, 'IRT'),
  ...overrides,
});

describe('effectiveLimitOf', () => {
  it('is the tier’s limit when the reseller has none of their own', () => {
    expect(effectiveLimitOf(terms())).toEqual({ limit: money(100_000n, 'IRT'), source: 'TIER' });
  });

  it('is the reseller’s own limit when set, in either direction, including zero', () => {
    for (const own of [0n, 30_000n, 500_000n]) {
      expect(effectiveLimitOf(terms({ ownLimit: money(own, 'IRT') }))).toEqual({
        limit: money(own, 'IRT'),
        source: 'RESELLER',
      });
    }
  });
});

describe('creditStateOf and creditAllowanceOf', () => {
  it('applies the effective limit to an ACTIVE reseller in its own currency', () => {
    expect(creditStateOf(terms(), 'IRT')).toBe('CREDIT_APPLIES');
    expect(creditAllowanceOf(terms(), 'IRT')).toBe(100_000n);
    expect(creditAllowanceOf(terms({ ownLimit: money(30_000n, 'IRT') }), 'IRT')).toBe(30_000n);
  });

  it('gives a SUSPENDED reseller no credit, whatever the limit (R1)', () => {
    const suspended = terms({ status: 'SUSPENDED' as ResellerStatus });
    expect(creditStateOf(suspended, 'IRT')).toBe('RESELLER_SUSPENDED');
    expect(creditAllowanceOf(suspended, 'IRT')).toBe(0n);
  });

  it('gives no credit for a zero limit, and a zero own limit overrides a positive tier limit', () => {
    expect(creditStateOf(terms({ tierLimit: money(0n, 'IRT') }), 'IRT')).toBe('NO_LIMIT');
    const zeroOwn = terms({ ownLimit: money(0n, 'IRT') });
    expect(creditStateOf(zeroOwn, 'IRT')).toBe('NO_LIMIT');
    expect(creditAllowanceOf(zeroOwn, 'IRT')).toBe(0n);
  });

  it('gives no credit for a debit in another currency than the limit’s', () => {
    expect(creditStateOf(terms(), 'USD')).toBe('CURRENCY_MISMATCH');
    expect(creditAllowanceOf(terms(), 'USD')).toBe(0n);
    const usd = terms({ ownLimit: money(5_000n, 'USD') });
    expect(creditAllowanceOf(usd, 'IRT')).toBe(0n);
    expect(creditAllowanceOf(usd, 'USD')).toBe(5_000n);
  });

  it('reports suspension before the limit, so a suspended zero-limit reseller reads as suspended', () => {
    expect(creditStateOf(terms({ status: 'SUSPENDED', tierLimit: money(0n, 'IRT') }), 'USD')).toBe(
      'RESELLER_SUSPENDED',
    );
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

  it('reads a negative balance as the credit in use', () => {
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
    expect(creditFigures(-80_000n, 0n).overLimitBy).toBe(80_000n);
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
