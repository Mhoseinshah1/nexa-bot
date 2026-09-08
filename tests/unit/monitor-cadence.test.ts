import { describe, expect, it } from 'vitest';
import {
  PANEL_HEALTH_FRESH_FOR_MS,
  PROVIDER_FAILURE_KINDS,
  PROVIDER_FAILURE_RETRYABLE,
} from '@nexa/contracts';
import type { ProviderFailureKind } from '@nexa/contracts';
import {
  MONITOR_MAX_BACKOFF_STEPS,
  maxHealthyIntervalMs,
  healthyCadenceFitsFreshness,
  effectivePreviousFailures,
  budgetDeferralIntervalMs,
  deferralIntervalMs,
  MONITOR_BUDGET_DEFERRAL_CAP_MS,
  MONITOR_NONRETRYABLE_FLOOR_MS,
  MONITOR_STABLE_DEFERRAL_MS,
  MONITOR_TRANSIENT_DEFERRAL_MS,
  MONITOR_MAX_INTERVAL_MS,
  MONITOR_SPREAD_FRACTION,
  backoffMultiplier,
  baseIntervalMs,
  scheduleAfterProbe,
  schedulerFreshPanelUpperBound,
  stableSpreadMs,
  tenantBudgetFreshPanelUpperBound,
  tenantTurnFreshTenantUpperBound,
  type MonitorCadence,
} from '../../apps/api/src/modules/platform/panels/domain/monitor-cadence';

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
  return schedule(failure, previous).nextEligibleAt.getTime() - AT.getTime();
}

describe('the monitor cadence', () => {
  it('reads retryability from the contract rather than restating it', () => {
    // Not a tautology: the point is that a NEW failure kind cannot be
    // monitored at the aggressive cadence by an author who added it to the
    // taxonomy and never opened this file. Every kind is covered because the
    // list is the contract's own.
    for (const kind of PROVIDER_FAILURE_KINDS) {
      // `RATE_LIMITED` is the one kind the policy names, and it is listed here
      // rather than derived so that ADDING a second such exception has to be
      // written down twice. It is retryable and still waits the long interval:
      // the panel has just said this installation calls it too often.
      const expected =
        PROVIDER_FAILURE_RETRYABLE[kind] && kind !== 'RATE_LIMITED'
          ? CADENCE.retryableIntervalMs
          : CADENCE.nonRetryableIntervalMs;
      expect(baseIntervalMs(CADENCE, kind), kind).toBe(expected);
    }
    expect(baseIntervalMs(CADENCE, null)).toBe(CADENCE.healthyIntervalMs);
  });

  it('answers a rate limit by calling less often, not sooner', () => {
    // The finding this exists for: a 429 folded into PROVIDER_ERROR was
    // retryable, so the panel that had just said "too many requests" was
    // re-dialled at the SHORTEST failure cadence the monitor has.
    expect(delayOf('RATE_LIMITED', 0)).toBeGreaterThan(delayOf('PROVIDER_ERROR', 0));
    expect(delayOf('RATE_LIMITED', 0)).toBeGreaterThan(delayOf('TIMEOUT', 0));
    expect(delayOf('RATE_LIMITED', 0)).toBeGreaterThanOrEqual(CADENCE.nonRetryableIntervalMs);
    // And the streak still doubles on top of it, so a panel that keeps saying
    // so is called less and less.
    expect(delayOf('RATE_LIMITED', 2)).toBeGreaterThan(delayOf('RATE_LIMITED', 0));
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
    const delay = result.nextEligibleAt.getTime() - AT.getTime();
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
    const first = schedule(null).nextEligibleAt.getTime();
    for (let i = 0; i < 20; i += 1) {
      expect(schedule(null).nextEligibleAt.getTime()).toBe(first);
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

  it('keeps a healthy panel fresh, tick delay included', () => {
    // The invariant that ties the cadence to the surface. `stale` is
    // `now - checkedAt > PANEL_HEALTH_FRESH_FOR_MS`, and worst-case refresh is
    // the interval PLUS the deterministic spread PLUS however long a panel that
    // has just become eligible waits for a tick to pick it up.
    //
    // The first version of this bound forgot the last term, so a twelve-minute
    // cadence with a ten-minute tick was accepted and every panel spent part of
    // every cycle displayed as stale — which makes the staleness flag mean "the
    // monitor is slow" rather than "this answer is old".
    const tick = 30_000;
    const ceiling = maxHealthyIntervalMs(tick);
    expect(healthyCadenceFitsFreshness(ceiling, tick)).toBe(true);
    expect(healthyCadenceFitsFreshness(ceiling + 60_000, tick)).toBe(false);

    /*
     * At EVERY tick, not the one this test happened to pick.
     *
     * The two functions were parallel formulas for one rule and disagreed
     * wherever floating point said they did: `720000 * 1.1` is
     * `792000.0000000001`, so at `tick = 108000` the schema refused 720001,
     * advised "at most 720000", and refused 720000 too — the process would not
     * boot and the instruction it printed could not be followed. Asserting one
     * tick could not see it, and `tick = 30_000` is not one of the ticks that
     * breaks.
     *
     * Both halves are asserted, because a ceiling that is merely ACCEPTED can
     * be had by returning 1. It has to be the largest accepted value.
     */
    for (let coarse = 1_000; coarse <= 600_000; coarse += 997) {
      const advised = maxHealthyIntervalMs(coarse);
      expect(
        healthyCadenceFitsFreshness(advised, coarse),
        `tick ${coarse}: the schema advises ${advised} and then refuses it`,
      ).toBe(true);
      expect(
        healthyCadenceFitsFreshness(advised + 1, coarse),
        `tick ${coarse}: ${advised} is not the largest interval that fits`,
      ).toBe(false);
    }

    // A long tick shrinks what a healthy interval may be, which is the whole
    // reason this cannot live on either field alone.
    expect(maxHealthyIntervalMs(10 * 60 * 1000)).toBeLessThan(maxHealthyIntervalMs(30_000));
    expect(healthyCadenceFitsFreshness(12 * 60 * 1000, 30_000)).toBe(true);
    expect(healthyCadenceFitsFreshness(12 * 60 * 1000, 10 * 60 * 1000)).toBe(false);

    // And the worst panel in a fleet at the ceiling still lands inside the
    // window once its own spread is added.
    const atCeiling: MonitorCadence = { ...CADENCE, healthyIntervalMs: ceiling };
    const worst = Math.max(
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => {
        const result = scheduleAfterProbe(atCeiling, id, {
          checkedAt: AT,
          failure: null,
          previousConsecutiveFailures: 0,
        });
        return result.nextEligibleAt.getTime() - AT.getTime();
      }),
    );
    expect(worst + tick).toBeLessThan(PANEL_HEALTH_FRESH_FOR_MS);
  });

  /**
   * T21 — the THIRD capacity bound, and the one nothing reported.
   *
   * Two panel ceilings say how many PANELS can be kept fresh. Neither says how
   * many TENANTS the fairness rotation can reach: a tick claims at most
   * `tenantsPerTick`, so across a freshness window it visits
   * `tenantsPerTick x (interval / tick)` of them, and a tenant beyond that
   * waits longer than the interval for its first probe of the cycle. A hundred
   * single-panel tenants is a hundred panels — far under the 900-panel
   * scheduler ceiling — so nothing else in the system says the rotation cannot
   * keep up.
   */
  describe('the tenant-turn bound', () => {
    it('is the rotation arithmetic, at the shipped defaults', () => {
      // 10 tenants a tick, a 30s tick, a 3-minute interval.
      expect(tenantTurnFreshTenantUpperBound(10, 30_000, 3 * 60 * 1000)).toBe(60);
    });

    it('shrank when the healthy interval did, which is how it went unnoticed', () => {
      // The ten-minute cadence this project shipped before reached 200 tenants
      // on the same fairness dial; three minutes reaches 60. Nothing about
      // `PANEL_MONITOR_TENANTS_PER_TICK` changed, and no capacity condition
      // fires on a fleet that small.
      expect(tenantTurnFreshTenantUpperBound(10, 30_000, 10 * 60 * 1000)).toBe(200);
      expect(tenantTurnFreshTenantUpperBound(10, 30_000, 3 * 60 * 1000)).toBeLessThan(
        tenantTurnFreshTenantUpperBound(10, 30_000, 10 * 60 * 1000),
      );
    });

    it('scales with the fairness dial and with a shorter tick', () => {
      expect(tenantTurnFreshTenantUpperBound(20, 30_000, 3 * 60 * 1000)).toBe(120);
      expect(tenantTurnFreshTenantUpperBound(10, 15_000, 3 * 60 * 1000)).toBe(120);
    });

    it('rounds DOWN, because a partial turn is not a turn', () => {
      // 10 x (100s / 30s) = 33.3 — thirty-three tenants get a turn, not
      // thirty-four. Rounding up would report capacity the rotation lacks.
      expect(tenantTurnFreshTenantUpperBound(10, 30_000, 100_000)).toBe(33);
    });

    it('is independent of the two PANEL ceilings, which is the whole point', () => {
      // One tenant, one panel each, a hundred tenants: comfortably inside both
      // panel bounds and outside this one.
      const tenants = 100;
      const panels = tenants;
      expect(
        schedulerFreshPanelUpperBound(150, 30_000, 3 * 60 * 1000),
        'the fleet fits the scheduler',
      ).toBeGreaterThan(panels);
      expect(
        tenantBudgetFreshPanelUpperBound(100, 5 * 60 * 1000, 3 * 60 * 1000),
        'and fits every tenant budget',
      ).toBeGreaterThanOrEqual(1);
      expect(
        tenantTurnFreshTenantUpperBound(10, 30_000, 3 * 60 * 1000),
        'and still cannot be reached in one window',
      ).toBeLessThan(tenants);
    });
  });

  it('will not retry a rejected credential inside the lockout floor', () => {
    // The floor is a floor, not a default. A cadence object built directly —
    // by a test, a future caller, a configuration route that has not been
    // written yet — cannot get under it, because the policy clamps as well as
    // the schema refusing.
    const reckless: MonitorCadence = { ...CADENCE, nonRetryableIntervalMs: 60_000 };
    expect(baseIntervalMs(reckless, 'AUTHENTICATION_FAILED')).toBe(MONITOR_NONRETRYABLE_FLOOR_MS);
    expect(baseIntervalMs(reckless, 'TLS_FAILED')).toBe(MONITOR_NONRETRYABLE_FLOOR_MS);
    // A retryable failure is unaffected: those are the ones that fix
    // themselves, and slowing them down would only make outages look longer.
    expect(baseIntervalMs(reckless, 'TIMEOUT')).toBe(CADENCE.retryableIntervalMs);

    const result = scheduleAfterProbe(reckless, PANEL, {
      checkedAt: AT,
      failure: 'AUTHENTICATION_FAILED',
      previousConsecutiveFailures: 0,
    });
    expect(result.nextEligibleAt.getTime() - AT.getTime()).toBeGreaterThanOrEqual(
      MONITOR_NONRETRYABLE_FLOOR_MS,
    );
  });

  it('believes the failure counter only while health still says failure', () => {
    // The rollback-and-forward rule. The counter lives in the scheduler's own
    // table, which an older release does not know about: roll back, let that
    // release complete a successful manual probe — it writes the health row and
    // leaves the counter behind — then roll forward, and the next failure would
    // inherit a streak from before a success that has since been recorded.
    expect(effectivePreviousFailures('UNREACHABLE', 4)).toBe(4);
    expect(effectivePreviousFailures('AUTH_FAILED', 4)).toBe(4);
    // Health says it worked. The counter is stale bookkeeping and is discarded.
    expect(effectivePreviousFailures('HEALTHY', 4)).toBe(0);
    expect(effectivePreviousFailures('DEGRADED', 4)).toBe(0);
    // No health at all is no evidence of a streak.
    expect(effectivePreviousFailures(null, 4)).toBe(0);
    // A negative counter cannot be produced by this codebase; if one ever were,
    // it must not shorten an interval.
    expect(effectivePreviousFailures('UNREACHABLE', -3)).toBe(0);
  });

  it('defers a stable refusal far longer than a transient one', () => {
    // A panel with no credential and a panel whose tenant is briefly out of
    // budget are not the same problem. The first cannot change until an
    // operator changes it — and every such change makes the panel eligible
    // immediately — so retrying it on a short cadence is a busy loop that
    // spends the tenant's fairness slot to learn nothing.
    for (const stable of [
      'CREDENTIALS_MISSING',
      'TARGET_BLOCKED',
      'STATUS_NOT_PROBEABLE',
      'NOT_AUTHORIZED',
    ] as const) {
      expect(deferralIntervalMs(stable), stable).toBe(MONITOR_STABLE_DEFERRAL_MS);
    }
    for (const transient of ['COOLDOWN', 'BUDGET_EXHAUSTED'] as const) {
      expect(deferralIntervalMs(transient), transient).toBe(MONITOR_TRANSIENT_DEFERRAL_MS);
    }
    expect(MONITOR_STABLE_DEFERRAL_MS).toBeGreaterThan(MONITOR_TRANSIENT_DEFERRAL_MS * 10);
  });

  it('defers a spent budget until the token it is waiting for, bounded', () => {
    // The refusal knows exactly when the next background token arrives. A flat
    // one-minute deferral made a tenant configured for a handful of probes a
    // day wake every exhausted panel sixty times an hour for half a day, each
    // time spending a claim and a due-scan slot to be refused again.
    expect(budgetDeferralIntervalMs(12 * 60 * 60 * 1000)).toBe(MONITOR_BUDGET_DEFERRAL_CAP_MS);
    expect(budgetDeferralIntervalMs(90 * 60 * 1000)).toBe(90 * 60 * 1000);
    expect(budgetDeferralIntervalMs(90_500.4)).toBe(90_501);

    // The floor: never NEARER than the flat interval this replaces, so the
    // change cannot make the loop busier than it was.
    expect(budgetDeferralIntervalMs(0)).toBe(MONITOR_TRANSIENT_DEFERRAL_MS);
    expect(budgetDeferralIntervalMs(1)).toBe(MONITOR_TRANSIENT_DEFERRAL_MS);
    expect(budgetDeferralIntervalMs(-5)).toBe(MONITOR_TRANSIENT_DEFERRAL_MS);

    // And the cap, because the interval is computed from CONFIGURATION: a
    // mis-set refill rate could otherwise name a date years out, stranding a
    // panel where no operator would think to look — and produce an invalid
    // Date rather than a schedule.
    for (const absurd of [Number.MAX_SAFE_INTEGER, 1e30, Infinity, NaN]) {
      const interval = budgetDeferralIntervalMs(absurd);
      expect(interval, String(absurd)).toBeLessThanOrEqual(MONITOR_BUDGET_DEFERRAL_CAP_MS);
      expect(Number.isNaN(new Date(Date.now() + interval).getTime()), String(absurd)).toBe(false);
    }
  });
});
