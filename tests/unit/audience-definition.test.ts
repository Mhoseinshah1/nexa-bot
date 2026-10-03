import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  audienceDefinitionSchema,
  canonicalAudienceDefinition,
  canonicalAudienceJson,
  broadcastOutcome,
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

  /*
   * Broadcast V2 (program §19): the tag and active-service dimensions are APPENDED to the
   * canonical form only when they narrow anything, so every definition the previous release
   * could write keeps its exact JSON and sha256 — a draft saved, or an audience frozen,
   * before the upgrade still matches the hash it was confirmed under.
   */
  it('keeps the canonical JSON and hash of a definition that uses no Broadcast V2 dimension', () => {
    // The literal the previous release produced for `{ version: 1 }`, written out by hand.
    const previous =
      '{"version":1,"customerIds":null,"customerStatus":"ACTIVE","segment":null,"purchase":"ANY",' +
      '"registeredFrom":null,"registeredBefore":null,"accountAgeMinDays":null,' +
      '"accountAgeMaxDays":null,"lastPurchaseFrom":null,"lastPurchaseBefore":null,' +
      '"noPurchaseForDays":null,"walletBalance":null,"trial":"ANY","referral":"ANY","service":null}';
    expect(canonicalAudienceJson({ version: 1 })).toBe(previous);
    expect(canonicalAudienceJson({ version: 1, tags: null, activeService: 'ANY' })).toBe(previous);
    expect(
      createHash('sha256')
        .update(canonicalAudienceJson({ version: 1 }))
        .digest('hex'),
    ).toBe(createHash('sha256').update(previous).digest('hex'));
  });

  it('appends tags and active service, sorted, after every earlier key', () => {
    const tagA = '01900000-0000-7000-8000-0000000000c1';
    const tagB = '01900000-0000-7000-8000-0000000000c2';
    const one = canonicalAudienceJson({
      version: 1,
      activeService: 'NONE',
      tags: { noneOf: [tagB], anyOf: [tagA, tagA] },
    });
    const two = canonicalAudienceJson({
      version: 1,
      tags: { anyOf: [tagA], noneOf: [tagB] },
      activeService: 'NONE',
    });
    expect(one).toBe(two);
    const keys = Object.keys(JSON.parse(one) as Record<string, unknown>);
    expect(keys.slice(-3)).toEqual(['service', 'tags', 'activeService']);
    expect(JSON.parse(one).tags).toEqual({ anyOf: [tagA], noneOf: [tagB] });
  });

  it('refuses an empty tag criterion and a tag both required and excluded', () => {
    const tag = '01900000-0000-7000-8000-0000000000c1';
    for (const input of [
      { version: 1, tags: {} },
      { version: 1, tags: { anyOf: [tag], noneOf: [tag] } },
      { version: 1, activeService: 'SOMETIMES' },
    ]) {
      expect(audienceDefinitionSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });
});

describe('broadcastOutcome', () => {
  const counts = (sent: number, failed = 0, unreachable = 0, unconfirmed = 0) => ({
    sent,
    failed,
    unreachable,
    unconfirmed,
  });

  it('is null until the broadcast is COMPLETED', () => {
    for (const state of ['DRAFT', 'SCHEDULED', 'SENDING', 'PAUSED', 'CANCELLED'] as const) {
      expect(broadcastOutcome(state, counts(0, 5))).toBeNull();
    }
  });

  it('reads delivered, partial and failed from the recipient counts', () => {
    expect(broadcastOutcome('COMPLETED', counts(10))).toBe('DELIVERED');
    expect(broadcastOutcome('COMPLETED', counts(0))).toBe('DELIVERED');
    expect(broadcastOutcome('COMPLETED', counts(9, 1))).toBe('PARTIAL');
    expect(broadcastOutcome('COMPLETED', counts(9, 0, 0, 1))).toBe('PARTIAL');
    expect(broadcastOutcome('COMPLETED', counts(0, 2, 3))).toBe('FAILED');
    // An unconfirmed send is never claimed as delivered.
    expect(broadcastOutcome('COMPLETED', counts(0, 0, 0, 4))).toBe('FAILED');
  });
});
