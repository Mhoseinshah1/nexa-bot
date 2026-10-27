import { PROCESS_RESTART_STORM_CODE, PROCESS_RESTART_STORM_WINDOW_MS } from '@nexa/contracts';

/** The dedupe key of one role's restart-storm condition. One function: the format IS the identity. */
export function restartStormConditionKey(role: string): string {
  return `${PROCESS_RESTART_STORM_CODE}:${role}`;
}

/**
 * What is remembered of a role's LATEST life. Persisted (`process_runs`), because the whole
 * point is what a process that has died cannot tell its successor.
 */
export interface ProcessRunRecord {
  readonly runId: string;
  readonly startedAt: Date;
  /** Set once the life has stayed up a full minute. */
  readonly stableAt: Date | null;
  /** Set by a clean shutdown: the operator stopped it, it did not crash. */
  readonly stoppedAt: Date | null;
  /** Crashed lives in the unbroken streak, as of this life's boot. */
  readonly restarts: number;
  /** When the first crashed life of the streak began; null exactly when `restarts` is 0. */
  readonly restartsSince: Date | null;
}

/**
 * Whether a life ended in a CRASH: it neither reached the stable mark nor was stopped on
 * purpose. A life still running on another replica looks the same here; one row per role
 * is the deployment model (a replica count above one is not a supported shape for the
 * background roles, `docs/deployment.md`).
 */
export function endedYoung(previous: ProcessRunRecord): boolean {
  return previous.stableAt === null && previous.stoppedAt === null;
}

/**
 * The record a boot writes, given the role's previous life (null on the very first boot).
 *
 * - the previous life crashed young: the streak grows by one — or starts again at one when
 *   the streak's first crashed life began more than `PROCESS_RESTART_STORM_WINDOW_MS` ago;
 * - the previous life was stable, or was stopped on purpose, or there is none: no streak.
 *
 * Only this function decides what a restart is, so the in-memory store the unit tests use
 * and the database store the roles use cannot disagree about it.
 */
export function recordBoot(
  previous: ProcessRunRecord | null,
  runId: string,
  now: Date,
  windowMs: number = PROCESS_RESTART_STORM_WINDOW_MS,
): ProcessRunRecord {
  let restarts = 0;
  let restartsSince: Date | null = null;
  if (previous !== null && endedYoung(previous)) {
    const continuing =
      previous.restarts > 0 &&
      previous.restartsSince !== null &&
      now.getTime() - previous.restartsSince.getTime() <= windowMs;
    restarts = continuing ? previous.restarts + 1 : 1;
    restartsSince = continuing ? previous.restartsSince : previous.startedAt;
  }
  return { runId, startedAt: now, stableAt: null, stoppedAt: null, restarts, restartsSince };
}

/** The stable mark: the life stayed up long enough, so the streak ends. */
export function recordStable(current: ProcessRunRecord, now: Date): ProcessRunRecord {
  return { ...current, stableAt: now, restarts: 0, restartsSince: null };
}

/** The clean-stop mark: an operator's stop is not a crash and ends the streak. */
export function recordStopped(current: ProcessRunRecord, now: Date): ProcessRunRecord {
  return { ...current, stoppedAt: now, restarts: 0, restartsSince: null };
}

/**
 * The latest life of each role. `transact` is the one atomic step: read the role's row,
 * hand it to `change`, write what comes back. A change that returns null writes nothing.
 * The database store takes a row lock; the unit tests' store is a map.
 */
export interface ProcessRunStore {
  transact(
    role: string,
    change: (previous: ProcessRunRecord | null) => ProcessRunRecord | null,
  ): Promise<ProcessRunRecord | null>;
}
