import { describe, expect, it } from 'vitest';
import {
  audienceDefinitionSchema,
  canonicalAudienceDefinition,
  canonicalAudienceJson,
} from '@nexa/contracts';

/**
 * The audience definition's ONE spelling (round N): a preview and a launch compare hashes of
 * this JSON, so two spellings of the same audience must serialise identically and every
 * default must be filled in the same order.
 */
describe('canonicalAudienceDefinition', () => {
  const tierA = '01900000-0000-7000-8000-0000000000a1';
  const tierB = '01900000-0000-7000-8000-0000000000b2';

  it('fills every default, so an empty definition is a complete one', () => {
    expect(canonicalAudienceDefinition({ version: 1 })).toEqual({
      version: 1,
      customerIds: null,
      customerStatus: 'ACTIVE',
      segment: null,
      purchase: 'ANY',
      registeredFrom: null,
      registeredBefore: null,
      accountAgeMinDays: null,
      accountAgeMaxDays: null,
      lastPurchaseFrom: null,
      lastPurchaseBefore: null,
      noPurchaseForDays: null,
      walletBalance: null,
      trial: 'ANY',
      referral: 'ANY',
      service: null,
    });
  });

  it('sorts and de-duplicates lists, lower-cases ids and normalises instants', () => {
    const one = canonicalAudienceJson({
      version: 1,
      segment: { ordinary: false, resellerTierIds: [tierB, tierA.toUpperCase(), tierB] },
      registeredFrom: '2026-03-01T03:30:00+03:30',
      service: { states: ['EXPIRED', 'ACTIVE', 'ACTIVE'] },
    });
    const two = canonicalAudienceJson({
      service: { states: ['ACTIVE', 'EXPIRED'] },
      registeredFrom: '2026-03-01T00:00:00.000Z',
      segment: { resellerTierIds: [tierA, tierB], ordinary: false },
      version: 1,
    });
    expect(one).toBe(two);
    expect(JSON.parse(one).registeredFrom).toBe('2026-03-01T00:00:00.000Z');
  });

  it('refuses empty ranges, unknown keys and a segment that selects nobody', () => {
    const bad = [
      { version: 1, segment: { ordinary: false, resellerTierIds: [] } },
      {
        version: 1,
        registeredFrom: '2026-03-02T00:00:00Z',
        registeredBefore: '2026-03-01T00:00:00Z',
      },
      { version: 1, walletBalance: { currency: 'IRT', minMinor: '10', maxMinor: '5' } },
      { version: 1, walletBalance: { currency: 'IRT' } },
      { version: 1, purchase: 'NEVER_PURCHASED', lastPurchaseFrom: '2026-03-01T00:00:00Z' },
      { version: 1, service: { expired: true, expiringWithinHours: 5 } },
      { version: 1, somethingElse: true },
      { version: 2 },
    ];
    for (const input of bad) {
      expect(audienceDefinitionSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });
});
