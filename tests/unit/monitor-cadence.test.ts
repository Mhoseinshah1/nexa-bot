import { describe, expect, it } from 'vitest';
import {
  PANEL_HEALTH_FRESH_FOR_MS,
  PROVIDER_FAILURE_KINDS,
  PROVIDER_FAILURE_RETRYABLE,
} from '@nexa/contracts';
import type { ProviderFailureKind } from '@nexa/contracts';
import {
  MONITOR_MAX_BACKOFF_STEPS,
  MONITOR_MAX_HEALTHY_INTERVAL_MS,
  MONITOR_MAX_INTERVAL_MS,
  MONITOR_SPREAD_FRACTION,
  backoffMultiplier,
  baseIntervalMs,
  scheduleAfterProbe,
  stableSpreadMs,
  type MonitorCadence,
} from '../../apps/api/src/modules/platform/panels/domain/monitor-cadence';
import { configSchema } from '../../apps/api/src/infrastructure/config/config.schema';

/**
 * The cadence policy: when the background monitor may probe a panel again.
 *
 * The interesting property is not "does it wait" but "does it wait LONGER for
 * the failures that repeating cannot fix". A deterministic rejection retried at
 * the healthy cadence is a credential-stuffing loop pointed at the operator's
 * own panel, and 3X-UI v3.7.0 locks an IP-and-username pair after enough
 * attempts.
 */

const CADENCE: MonitorCadence = {
  healthyIntervalMs: 10 * 60 * 1000,
  retryableIntervalMs: 2 * 60 * 1000,
  nonRetryableIntervalMs: 60 * 60 * 1000,
};

const PANEL = '01920000-0000-7000-8000-000000000001';
const AT = new Date('2026-01-01T00:00:00.000Z');

function schedule(failure: ProviderFailureKind | null, previousConsecutiveFailures = 0) {
  return scheduleAfterProbe(CADENCE, PANEL, {
    checkedAt: AT,
    failure,
    previousConsecutiveFailures,
  });
}

/** The delay a schedule implies, spread included. */
function delayOf(failure: ProviderFailureKind | null, previous = 0): number {
  return schedule(failure, previous).nextProbeAt.getTime() - AT.getTime();
}

describe('the monitor cadence', () => {
  it('reads retryability from the contract rather than restating it', () => {
    // Not a tautology: the point is that a NEW failure kind cannot be
    // monitored at the aggressive cadence by an author who added it to the
    // taxonomy and never opened this file. Every kind is covered because the
    // list is the contract's own.
    for (const kind of PROVIDER_FAILURE_KINDS) {
      const expected = PROVIDER_FAILURE_RETRYABLE[kind]
        ? CADENCE.retryableIntervalMs
        : CADENCE.nonRetryableIntervalMs;
      expect(baseIntervalMs(CADENCE, kind), kind).toBe(expected);
    }
    expect(baseIntervalMs(CADENCE, null)).toBe(CADENCE.healthyIntervalMs);
  });

  it('never retries an auth failure at the healthy cadence', () => {
    // The lockout rule, named explicitly. Both authentication kinds and every
    // other non-retryable failure wait at least the long interval — never the
    // healthy one, and never the retryable one.
    const nonRetryable = PROVIDER_FAILURE_KINDS.filter((k) => !PROVIDER_FAILURE_RETRYABLE[k]);
    expect(nonRetryable).toContain('AUTHENTICATION_FAILED');
    expect(nonRetryable).toContain('AUTHENTICATION_REQUIRES_INTERACTION');
    expect(nonRetryable).toContain('BLOCKED_TARGET');
    expect(nonRetryable).toContain('TLS_FAILED');
    expect(nonRetryable).toContain('MALFORMED_RESPONSE');
    expect(nonRetryable).toContain('UNSUPPORTED_CAPABILITY');
    for (const kind of nonRetryable) {
      expect(delayOf(kind, 0), kind).toBeGreaterThanOrEqual(CADENCE.nonRetryableIntervalMs);
      expect(delayOf(kind, 0), kind).toBeGreaterThan(CADENCE.healthyIntervalMs);
      expect(delayOf(kind, 0), kind).toBeGreaterThan(CADENCE.retryableIntervalMs);
    }
  });

  it('retries a retryable failure sooner than it re-probes a healthy panel', () => {
    expect(delayOf('TIMEOUT')).toBeLessThan(delayOf(null));
    expect(delayOf('UNREACHABLE')).toBeLessThan(delayOf(null));
    expect(delayOf('PROVIDER_ERROR')).toBeLessThan(delayOf(null));
  });

  it('resets the streak on success and advances it on failure', () => {
    expect(schedule(null, 7).consecutiveFailures).toBe(0);
    expect(schedule('TIMEOUT', 0).consecutiveFailures).toBe(1);
    expect(schedule('TIMEOUT', 3).consecutiveFailures).toBe(4);
    // A negative counter cannot be produced by this codebase; if one ever were,
    // it must not shorten the interval below the base.
    expect(schedule('TIMEOUT', -5).consecutiveFailures).toBe(1);
  });

  it('backs off by doubling and then stops doubling', () => {
    expect(backoffMultiplier(0)).toBe(1);
    expect(backoffMultiplier(1)).toBe(1);
    expect(backoffMultiplier(2)).toBe(2);
    expect(backoffMultiplier(3)).toBe(4);
    expect(backoffMultiplier(4)).toBe(8);
    // Bounded. An unbounded doubling reaches "next year" in a fortnight, so a
    // panel an operator repaired would stay unmonitored — the monitor would
    // have given up on exactly the panels most likely to need watching.
    expect(backoffMultiplier(5)).toBe(2 ** (MONITOR_MAX_BACKOFF_STEPS - 1));
    expect(backoffMultiplier(50)).toBe(2 ** (MONITOR_MAX_BACKOFF_STEPS - 1));
    expect(backoffMultiplier(5_000)).toBe(2 ** (MONITOR_MAX_BACKOFF_STEPS - 1));
  });

  it('caps every interval at a day, however long the streak', () => {
    const long: MonitorCadence = { ...CADENCE, nonRetryableIntervalMs: 20 * 60 * 60 * 1000 };
    const result = scheduleAfterProbe(long, PANEL, {
      checkedAt: AT,
      failure: 'AUTHENTICATION_FAILED',
      previousConsecutiveFailures: 99,
    });
    const delay = result.nextProbeAt.getTime() - AT.getTime();
    expect(delay).toBeLessThanOrEqual(
      MONITOR_MAX_INTERVAL_MS + MONITOR_MAX_INTERVAL_MS * MONITOR_SPREAD_FRACTION,
    );
    // And a panel is still looked at within about a day, rather than abandoned.
    expect(delay).toBeGreaterThanOrEqual(MONITOR_MAX_INTERVAL_MS);
  });

  it('spreads deterministically, so a restart does not re-cluster the fleet', () => {
    // Random jitter regenerated per process gives a fleet that re-clusters on
    // every deploy: probed once at boot, due again together one interval later.
    // A spread keyed on the panel id survives restarts, replicas and rollbacks.
    const first = schedule(null).nextProbeAt.getTime();
    for (let i = 0; i < 20; i += 1) {
      expect(schedule(null).nextProbeAt.getTime()).toBe(first);
    }
  });

  it('gives different panels different offsets', () => {
    const offsets = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      offsets.add(stableSpreadMs(`01920000-0000-7000-8000-${String(i).padStart(12, '0')}`, 60_000));
    }
    // Not a uniformity proof — a collision is legal. What would be a bug is a
    // hash that answers the same for everything, which is exactly what a
    // careless "spread" reduces to.
    expect(offsets.size).toBeGreaterThan(150);
  });

  it('keeps the spread inside its window and non-negative', () => {
    for (let i = 0; i < 500; i += 1) {
      const offset = stableSpreadMs(`panel-${i}`, 1_000);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(1_000);
    }
    expect(stableSpreadMs('anything', 0)).toBe(0);
    expect(stableSpreadMs('anything', -5)).toBe(0);
    expect(stableSpreadMs('', 1_000)).toBeGreaterThanOrEqual(0);
  });

  it('keeps a healthy panel fresh at the configured ceiling', () => {
    // The invariant that ties the cadence to the surface. `stale` is
    // `now - checkedAt > PANEL_HEALTH_FRESH_FOR_MS`; a healthy cadence at or
    // above that window would put every panel past it in every cycle, and the
    // staleness flag would mean "the monitor is slow" rather than "this answer
    // is old". The spread is INSIDE the bound, so this holds for the last panel
    // in the fleet and not just the average one.
    // The bound itself: interval plus spread must fit inside the window.
    expect(MONITOR_MAX_HEALTHY_INTERVAL_MS * (1 + MONITOR_SPREAD_FRACTION)).toBeLessThanOrEqual(
      PANEL_HEALTH_FRESH_FOR_MS,
    );

    // And the schema REFUSES anything above it, so no deployment can configure
    // its way past the invariant. This is the half that fails if somebody
    // raises the configured maximum without revisiting the freshness window.
    const ceiling = configSchema.shape.PANEL_MONITOR_HEALTHY_INTERVAL_MS;
    expect(() => ceiling.parse(String(MONITOR_MAX_HEALTHY_INTERVAL_MS + 1))).toThrow();
    // The configured ceiling is stricter still, and the default is inside it.
    expect(ceiling.parse(undefined)).toBeLessThanOrEqual(MONITOR_MAX_HEALTHY_INTERVAL_MS);

    const atCeiling: MonitorCadence = {
      ...CADENCE,
      healthyIntervalMs: MONITOR_MAX_HEALTHY_INTERVAL_MS,
    };
    const worst = Math.max(
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => {
        const result = scheduleAfterProbe(atCeiling, id, {
          checkedAt: AT,
          failure: null,
          previousConsecutiveFailures: 0,
        });
        return result.nextProbeAt.getTime() - AT.getTime();
      }),
    );
    expect(worst).toBeLessThan(PANEL_HEALTH_FRESH_FOR_MS);
  });
});
