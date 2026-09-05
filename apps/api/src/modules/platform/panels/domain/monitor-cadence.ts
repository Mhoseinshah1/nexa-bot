import { PANEL_HEALTH_FRESH_FOR_MS, PROVIDER_FAILURE_RETRYABLE } from '@nexa/contracts';
import type { MonitorDeferralReason, PanelHealthState, ProviderFailureKind } from '@nexa/contracts';

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
 * The largest healthy cadence that can still keep a panel's health fresh,
 * given how long a due panel may wait for its turn.
 *
 * `PANEL_HEALTH_FRESH_FOR_MS` is what a surface calls stale. Worst-case refresh
 * is NOT just the interval: it is the interval, plus the deterministic spread,
 * plus however long the panel waits after becoming eligible for a tick to pick
 * it up. The first version of this bound forgot the last term, so a
 * twelve-minute cadence with a ten-minute tick was accepted and every panel
 * spent part of every cycle displayed as stale — which makes the staleness flag
 * mean "the monitor is slow" instead of "this answer is old".
 *
 * The spread is inside the bound, so this holds for the LAST panel in the
 * fleet rather than the average one.
 */
export function maxHealthyIntervalMs(tickMs: number): number {
  return Math.floor((PANEL_HEALTH_FRESH_FOR_MS - tickMs) / (1 + MONITOR_SPREAD_FRACTION));
}

/**
 * Whether a configuration keeps every healthy panel inside the freshness
 * window. The schema refuses the combinations this rejects.
 */
export function healthyCadenceFitsFreshness(healthyIntervalMs: number, tickMs: number): boolean {
  return healthyIntervalMs * (1 + MONITOR_SPREAD_FRACTION) + tickMs < PANEL_HEALTH_FRESH_FOR_MS;
}

/**
 * The smallest interval a NON-RETRYABLE failure may be retried at, whatever the
 * configuration says.
 *
 * Thirty minutes, and it is not a tuning preference. A rejected credential
 * retried at one minute, then two, then four, then eight is still an automated
 * login hammer pointed at the operator's own panel — 3X-UI v3.7.0 locks an
 * IP-and-username pair after enough failures, so a "safe" backoff that starts
 * fast still spends the operator's lockout budget before it slows down.
 *
 * A floor rather than a default, because a default is a thing a configuration
 * can defeat and the reason this exists is precisely that it must not be
 * defeatable. The schema refuses a smaller configured value AND this clamps, so
 * neither a bad config nor a caller building a cadence object directly can get
 * under it.
 */
export const MONITOR_NONRETRYABLE_FLOOR_MS = 30 * 60 * 1000;

/**
 * How long a stable preflight refusal defers a panel.
 *
 * Stable means nothing can change the answer until an operator changes the
 * panel: no credential to send, an address the policy refuses, a status the
 * loop may not touch, a tenant the job may not act for. Retrying those on the
 * healthy cadence is a busy loop that spends the tenant's fairness slot to
 * learn nothing — and an operator who fixes the cause does not wait it out,
 * because every one of those fixes is a write that makes the panel eligible
 * immediately.
 *
 * The transient ones — a cooldown, a spent budget — come back on their own and
 * earn a short deferral instead.
 */
export const MONITOR_STABLE_DEFERRAL_MS = 60 * 60 * 1000;
export const MONITOR_TRANSIENT_DEFERRAL_MS = 60 * 1000;

/** Which deferrals are stable, and therefore long. */
export function deferralIntervalMs(reason: MonitorDeferralReason): number {
  switch (reason) {
    case 'COOLDOWN':
    case 'BUDGET_EXHAUSTED':
      return MONITOR_TRANSIENT_DEFERRAL_MS;
    case 'CREDENTIALS_MISSING':
    case 'TARGET_BLOCKED':
    case 'STATUS_NOT_PROBEABLE':
    case 'NOT_AUTHORIZED':
      return MONITOR_STABLE_DEFERRAL_MS;
  }
}

/**
 * The failure streak a new probe should build on.
 *
 * Reads the stored HEALTH, not just the stored counter, and that is the whole
 * point. The counter lives in the scheduler's own table, which an older release
 * does not know about: roll back, let that release complete a successful manual
 * probe — it writes the health row and leaves the counter untouched — then roll
 * forward, and the next failure would inherit a streak from before a success
 * that has since been recorded. A panel that just worked would back off as if
 * it had been failing for hours.
 *
 * So the counter is only believed while the latest health still describes a
 * failure. Health is provider truth and the counter is bookkeeping; when they
 * disagree, truth wins.
 */
export function effectivePreviousFailures(
  previousState: PanelHealthState | null,
  storedStreak: number,
): number {
  if (previousState === null) return 0;
  const failing = previousState === 'UNREACHABLE' || previousState === 'AUTH_FAILED';
  return failing ? Math.max(0, storedStreak) : 0;
}

/**
 * When a panel that is not ACTIVE becomes eligible: effectively never.
 *
 * A concrete far-future timestamp rather than PostgreSQL's `'infinity'`, and
 * the reason is prosaic. `node-postgres` parses an infinite timestamptz to the
 * NUMBER `Infinity`, not to a `Date` — so a column typed `Date` in the
 * repository would hand callers something that is not one, and the type would
 * be a lie that only shows up at runtime. JavaScript's own maximum date is no
 * good either: it serialises to year 275760, which PostgreSQL refuses outright.
 *
 * Year 9999 sorts after everything a scheduler will ever compare it against and
 * survives both round trips intact.
 */
export const SCHEDULE_SUSPENDED_AT = new Date('9999-12-31T23:59:59.000Z');

/** What the cadence needs to know about the probe that just finished. */
export interface CadenceInput {
  readonly checkedAt: Date;
  readonly failure: ProviderFailureKind | null;
  /** The counter as it stood BEFORE this probe. Zero when nothing is stored. */
  readonly previousConsecutiveFailures: number;
}

export interface ProbeSchedule {
  readonly consecutiveFailures: number;
  readonly nextEligibleAt: Date;
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
  if (PROVIDER_FAILURE_RETRYABLE[failure]) return cadence.retryableIntervalMs;
  // Clamped, not merely defaulted. The schema refuses a smaller configured
  // value; this refuses one that reached the policy by any other route.
  return Math.max(MONITOR_NONRETRYABLE_FLOOR_MS, cadence.nonRetryableIntervalMs);
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
    nextEligibleAt: new Date(input.checkedAt.getTime() + interval + spread),
  };
}
