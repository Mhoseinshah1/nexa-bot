import { describe, expect, it } from 'vitest';
import {
  adoptedServiceState,
  adoptionReviewFlag,
  adoptionRequestHash,
} from '../../apps/api/src/modules/commerce/legacy-adoption/application/legacy-adoption.service';
import type { LegacyAdoptionCommand } from '../../apps/api/src/modules/commerce/legacy-adoption/application/legacy-adoption-ports';

/** Migration P6 — the two pure rules of the adoption (`docs/migration-p6-service-adoption.md` §5, §7). */
describe('adoptedServiceState', () => {
  it('maps every RickPanel state; on_hold and an unrecognised one are ACTIVE and flagged', () => {
    expect(adoptedServiceState('active')).toBe('ACTIVE');
    expect(adoptedServiceState('limited')).toBe('ACTIVE');
    expect(adoptedServiceState('disabled')).toBe('SUSPENDED');
    expect(adoptedServiceState('expired')).toBe('EXPIRED');
    expect(adoptedServiceState('on_hold')).toBe('ACTIVE');
    expect(adoptedServiceState('UNKNOWN')).toBe('ACTIVE');
  });

  it('flags exactly the two states it could not read as knowledge, and nothing else', () => {
    expect(adoptionReviewFlag('on_hold')).toBe('PANEL_STATE_ON_HOLD');
    expect(adoptionReviewFlag('UNKNOWN')).toBe('PANEL_STATE_UNKNOWN');
    for (const state of ['active', 'limited', 'disabled', 'expired'] as const) {
      expect(adoptionReviewFlag(state)).toBeNull();
    }
  });
});

describe('adoptionRequestHash', () => {
  const base: LegacyAdoptionCommand = {
    runId: '01a00000-0000-7000-8000-000000000001',
    legacyInvoiceKey: 'abcd1234',
    sourceChecksum: 'a'.repeat(64),
    telegramUserId: '12345',
    match: { kind: 'ELIGIBLE', panelId: 'p', username: 'u', providerUsername: 'u' },
    runtime: {
      state: 'active',
      usage: { usedBytes: 1n, totalBytes: 2n, expiresAt: new Date(0) },
      observedAt: new Date(1000),
      subscriptionUrl: null,
    },
    productId: 'x',
    legacyPurchasedAt: null,
    idempotencyKey: 'k1',
  };

  it('ignores the idempotency key and sees every other field', () => {
    expect(adoptionRequestHash({ ...base, idempotencyKey: 'k2' })).toBe(adoptionRequestHash(base));
    expect(adoptionRequestHash({ ...base, productId: 'y' })).not.toBe(adoptionRequestHash(base));
    expect(adoptionRequestHash({ ...base, sourceChecksum: 'b'.repeat(64) })).not.toBe(
      adoptionRequestHash(base),
    );
    const runtime = base.runtime as NonNullable<LegacyAdoptionCommand['runtime']>;
    expect(adoptionRequestHash({ ...base, runtime: { ...runtime, state: 'disabled' } })).not.toBe(
      adoptionRequestHash(base),
    );
    expect(
      adoptionRequestHash({
        ...base,
        runtime: { ...runtime, usage: { usedBytes: 9n, totalBytes: 2n, expiresAt: new Date(0) } },
      }),
    ).not.toBe(adoptionRequestHash(base));
  });
});
