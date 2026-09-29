import { describe, expect, it } from 'vitest';
import {
  TOKEN_REPLACEMENT_LEASE_FLOOR_MS,
  tokenReplacementLeaseMs,
} from '../../apps/api/src/modules/platform/tenancy/domain/token-replacement-lease';

/**
 * Codex F2 — the token-replacement claim must outlive the calls it covers. Seven
 * sequential Telegram calls at the configured timeout, plus a margin, never under five
 * minutes; at the config schema's 120 s ceiling a fixed five-minute lease would lapse
 * mid-replacement.
 */
describe('the token-replacement lease', () => {
  it('is five minutes at the default timeout', () => {
    expect(tokenReplacementLeaseMs(10_000)).toBe(TOKEN_REPLACEMENT_LEASE_FLOOR_MS);
    expect(TOKEN_REPLACEMENT_LEASE_FLOOR_MS).toBe(5 * 60_000);
  });

  it('outlives seven calls at the 120 s ceiling the config allows', () => {
    const lease = tokenReplacementLeaseMs(120_000);
    expect(lease).toBe(7 * 120_000 + 60_000);
    expect(lease).toBeGreaterThan(7 * 120_000);
    expect(lease).toBeGreaterThan(TOKEN_REPLACEMENT_LEASE_FLOOR_MS);
  });
});
