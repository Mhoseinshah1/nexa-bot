import { describe, expect, it } from 'vitest';
import { money } from '@nexa/contracts';
import {
  isCreditChange,
  resellerReasonMissing,
  sensitiveResellerChanges,
  usableResellerReason,
} from '../../apps/api/src/modules/commerce/resellers/domain/sensitive-change';

const stored = { status: 'ACTIVE', tierId: 'tier-a' } as const;
const write = { status: 'ACTIVE', tierId: 'tier-a', creditLimit: null } as const;

describe('which reseller changes need a written reason (OQ-V095-01)', () => {
  it('names suspension, a tier change and a credit change, and nothing else', () => {
    expect(sensitiveResellerChanges(stored, write)).toEqual([]);
    expect(sensitiveResellerChanges(stored, { ...write, status: 'SUSPENDED' })).toEqual([
      'SUSPEND',
    ]);
    expect(sensitiveResellerChanges(stored, { ...write, tierId: 'tier-b' })).toEqual([
      'TIER_CHANGE',
    ]);
    expect(
      sensitiveResellerChanges(stored, { ...write, creditLimit: money(5000n, 'IRT') }),
    ).toEqual(['CREDIT_CHANGE']);
    // Zero is the stored limit, so it is no change; reactivating is not a suspension.
    expect(sensitiveResellerChanges(stored, { ...write, creditLimit: money(0n, 'IRT') })).toEqual(
      [],
    );
    expect(sensitiveResellerChanges({ status: 'SUSPENDED', tierId: 'tier-a' }, write)).toEqual([]);
    // Already suspended and staying suspended is not a new suspension.
    expect(
      sensitiveResellerChanges(
        { status: 'SUSPENDED', tierId: 'tier-a' },
        { ...write, status: 'SUSPENDED' },
      ),
    ).toEqual([]);
    expect(isCreditChange(null)).toBe(false);
  });

  it('accepts a reason of 3 to 500 characters once trimmed, and no other', () => {
    expect(usableResellerReason('  abc  ')).toBe('abc');
    expect(usableResellerReason('x'.repeat(500))).toBe('x'.repeat(500));
    for (const bad of [undefined, '', '   ', 'ab', ' ab ', 'x'.repeat(501)]) {
      expect(usableResellerReason(bad), String(bad)).toBeNull();
    }
    // Counted in characters, not UTF-16 units: three emoji are three characters.
    expect(usableResellerReason('😀😀😀')).toBe('😀😀😀');
  });

  it('refuses a sensitive change without a usable reason, and lets any other through', () => {
    expect(resellerReasonMissing(['SUSPEND'], undefined)).toBe(true);
    expect(resellerReasonMissing(['TIER_CHANGE'], 'ab')).toBe(true);
    expect(resellerReasonMissing(['CREDIT_CHANGE', 'SUSPEND'], '   ')).toBe(true);
    expect(resellerReasonMissing(['SUSPEND'], 'دلیل')).toBe(false);
    expect(resellerReasonMissing([], undefined)).toBe(false);
  });
});
