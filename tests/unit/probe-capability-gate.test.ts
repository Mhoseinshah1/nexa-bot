import { describe, expect, it } from 'vitest';
import {
  deferralIntervalMs,
  MONITOR_STABLE_DEFERRAL_MS,
  MONITOR_TRANSIENT_DEFERRAL_MS,
} from '../../apps/api/src/modules/platform/panels/domain/monitor-cadence';
import { MONITOR_DEFERRAL_REASONS } from '@nexa/contracts';

/**
 * The capability gate's SCHEDULING half — item E-1.
 *
 * `supports()` has existed on both adapters since Phase 3B with no production
 * caller: `attemptProbe` probed unconditionally, so the capability array was
 * published to the Web Admin as a promise the product makes while nothing on the
 * server consulted it. The gate is vacuous today, because both registered
 * providers declare `HEALTH_CHECK`, and that is exactly when it is cheap to
 * install — after a provider that cannot health-check exists, the gap is
 * discovered through a panel whose health never updates.
 *
 * What a unit test can prove is the part a vacuous gate still gets wrong: how the
 * scheduler treats the refusal. `tests/integration/panels.test.ts` covers the
 * refusal path itself against a real database and a real adapter.
 */
describe('the capability refusal defers on the STABLE cadence', () => {
  it('is in the contract, so a scheduler row can record it', () => {
    // The refusal needs a deferral reason or the monitor cannot write down why it
    // skipped the panel — and a panel with no recorded reason stays due, is the
    // earliest due row on the next tick, and occupies its tenant's fairness slot
    // while doing nothing. That is the Phase 3C defect this enum exists for.
    expect(MONITOR_DEFERRAL_REASONS).toContain('CAPABILITY_UNSUPPORTED');
  });

  it('is STABLE, not transient', () => {
    /*
     * The most stable reason in the list: it is a property of the ADAPTER, which
     * is code, so it cannot change without a release. Treating it as transient
     * would retry it on the short cadence for ever — a busy loop against a panel
     * nothing can ever probe, spending its tenant's fairness slot on each pass.
     */
    expect(deferralIntervalMs('CAPABILITY_UNSUPPORTED')).toBe(MONITOR_STABLE_DEFERRAL_MS);
    // And the other direction, so this is not "every reason is stable".
    expect(deferralIntervalMs('COOLDOWN')).toBe(MONITOR_TRANSIENT_DEFERRAL_MS);
    expect(MONITOR_STABLE_DEFERRAL_MS).toBeGreaterThan(MONITOR_TRANSIENT_DEFERRAL_MS);
  });

  it('gives every deferral reason an interval', () => {
    // Total, and the switch is exhaustive so this is a compile-time property as
    // well. Asserted at runtime too, because a `default` added later would make
    // the compiler stop enforcing it while this keeps failing.
    for (const reason of MONITOR_DEFERRAL_REASONS) {
      expect(deferralIntervalMs(reason), reason).toBeGreaterThan(0);
    }
  });
});
