import { PANEL_HEALTH_FRESH_FOR_MS, PROVIDER_FAILURE_RETRYABLE } from '@nexa/contracts';
import type { ProviderFailureKind } from '@nexa/contracts';

/**
 * When the background monitor may probe a panel again.
 *
 * A pure function of the probe that just finished, the panel's id and three
 * configured intervals. No clock, no database, no provider — so the whole
 * cadence policy, including the part that stops Nexa hammering an operator's
 * credentials, is decided by something a unit test can call directly.
 *
 * It lives here rather than in the discovery SQL deliberately. The alternative
 * was a CASE expression over state, failure kind and three parameters,
 * evaluated on every row of every tick: not indexable, and duplicated the
 * moment anything else needed to know when a panel is next due.
 */
export interface MonitorCadence {
  /** Between probes of a panel that answered. */
  readonly healthyIntervalMs: number;
  /** After a failure that trying again could plausibly resolve. */
  readonly retryableIntervalMs: number;
  /**
   * After a failure that trying again cannot resolve.
   *
   * Rejected credentials, a refused target, a TLS failure, a response this
   * provider does not produce. Retrying any of them on the healthy cadence is
   * not monitoring; against `AUTHENTICATION_FAILED` it is a slow credential
   * stuffing loop pointed at the operator's own panel, and 3X-UI v3.7.0 locks
   * an IP-and-username pair after enough attempts.
   */
  readonly nonRetryableIntervalMs: number;
}

/**
 * How far the backoff may double: 1x, 2x, 4x, 8x, and then flat forever.
 *
 * Bounded on purpose. An unbounded doubling reaches "next year" in a fortnight,
 * so a panel an operator repaired would stay unmonitored — the monitor would
 * have quietly given up on exactly the panels most likely to need watching. A
 * repaired panel does not have to wait for its backoff either: replacing a
 * credential or an address makes it due immediately, which is what the
 * configuration comparison in discovery is for.
 */
export const MONITOR_MAX_BACKOFF_STEPS = 4;

/**
 * The hard ceiling on any computed interval, however the backoff multiplies.
 *
 * A panel is looked at least once a day no matter what state it is in.
 */
export const MONITOR_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The fraction of an interval a panel's deterministic spread may add.
 *
 * The anti-herd mechanism, and it is derived from the panel's id rather than
 * drawn at random. Random jitter regenerated on every process restart gives a
 * fleet that re-clusters after each deploy — every panel probed once at boot,
 * every panel due again together one interval later. A spread keyed on the
 * panel id survives restarts, replicas and rollbacks, because none of those
 * change the id.
 */
export const MONITOR_SPREAD_FRACTION = 0.1;

/**
 * The largest healthy cadence that can still keep a panel's health fresh.
 *
 * `PANEL_HEALTH_FRESH_FOR_MS` is what a surface calls stale. A healthy cadence
 * at or above it would guarantee that every panel is reported stale at some
 * point in every cycle no matter how well it is behaving, which makes the
 * staleness flag mean "the monitor is slow" instead of "this answer is old".
 * The spread is inside the bound, so the ceiling holds for the LAST panel in
 * the fleet, not the average one.
 */
export const MONITOR_MAX_HEALTHY_INTERVAL_MS = Math.floor(
  PANEL_HEALTH_FRESH_FOR_MS / (1 + MONITOR_SPREAD_FRACTION),
);

/** What the cadence needs to know about the probe that just finished. */
export interface CadenceInput {
  readonly checkedAt: Date;
  readonly failure: ProviderFailureKind | null;
  /** The counter as it stood BEFORE this probe. Zero when nothing is stored. */
  readonly previousConsecutiveFailures: number;
}

export interface ProbeSchedule {
  readonly consecutiveFailures: number;
  readonly nextProbeAt: Date;
}

/**
 * The base interval this outcome earns, before backoff and spread.
 *
 * Retryability is read from `PROVIDER_FAILURE_RETRYABLE` rather than restated
 * here. A new failure kind therefore cannot be silently monitored at the
 * aggressive cadence by an author who added it to the taxonomy and did not
 * think about this file: the contract's own table decides.
 */
export function baseIntervalMs(
  cadence: MonitorCadence,
  failure: ProviderFailureKind | null,
): number {
  if (failure === null) return cadence.healthyIntervalMs;
  return PROVIDER_FAILURE_RETRYABLE[failure]
    ? cadence.retryableIntervalMs
    : cadence.nonRetryableIntervalMs;
}

/** 1, 2, 4, 8, 8, 8 … — doubling per consecutive failure, then flat. */
export function backoffMultiplier(consecutiveFailures: number): number {
  if (consecutiveFailures <= 1) return 1;
  const steps = Math.min(consecutiveFailures - 1, MONITOR_MAX_BACKOFF_STEPS - 1);
  return 2 ** steps;
}

/**
 * A panel's own offset within a window, in [0, windowMs).
 *
 * FNV-1a over the panel id: deterministic, stable across processes and
 * restarts, and spread evenly enough over UUIDs that two panels created a
 * millisecond apart do not share a slot. Nothing here needs to be
 * unpredictable — it needs to be the SAME every time.
 */
export function stableSpreadMs(panelId: string, windowMs: number): number {
  if (windowMs <= 0) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < panelId.length; i += 1) {
    hash ^= panelId.charCodeAt(i);
    // FNV prime, as 32-bit multiply-and-wrap.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return Math.floor((hash / 0x100000000) * windowMs);
}

/** When this panel is next due, and what its failure streak now stands at. */
export function scheduleAfterProbe(
  cadence: MonitorCadence,
  panelId: string,
  input: CadenceInput,
): ProbeSchedule {
  const consecutiveFailures =
    input.failure === null ? 0 : Math.max(0, input.previousConsecutiveFailures) + 1;
  const interval = Math.min(
    MONITOR_MAX_INTERVAL_MS,
    baseIntervalMs(cadence, input.failure) * backoffMultiplier(consecutiveFailures),
  );
  const spread = stableSpreadMs(panelId, Math.floor(interval * MONITOR_SPREAD_FRACTION));
  return {
    consecutiveFailures,
    nextProbeAt: new Date(input.checkedAt.getTime() + interval + spread),
  };
}
