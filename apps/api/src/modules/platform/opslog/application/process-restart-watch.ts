import {
  OPS_ERROR_CLASS_POLICY,
  PROCESS_RESTART_STORM_CODE,
  PROCESS_RESTART_STORM_ENDED_CODE,
  PROCESS_RESTART_STORM_MIN_RESTARTS,
  PROCESS_RESTART_STORM_WINDOW_MS,
  PROCESS_RUN_STABLE_AFTER_MS,
  type Clock,
  type OperationalEventRecorder,
  type TenantContext,
} from '@nexa/contracts';
import { recordQuietly } from './error-events.js';
import {
  recordBoot,
  recordStable,
  recordStopped,
  restartStormConditionKey,
  type ProcessRunStore,
} from './process-run-state.js';

/** How often a young life asks whether it has become stable. */
export const PROCESS_RUN_CHECK_INTERVAL_MS = 10_000;

/**
 * R11 A3: reports a process role that is being restarted over and over, each life shorter
 * than `PROCESS_RUN_STABLE_AFTER_MS`.
 *
 * Why it exists. The loop-stall watchdog gives a process no verdict in its first minute
 * (v0.8.2 hotfix, so a restarting worker does not post a stalled/recovered pair per boot),
 * and a process that dies in seconds never reaches its second. The container runtime
 * restarts it, so no health check stays red either. Until this, a role that crashed every
 * thirteen seconds was visible only to an operator reading `docker ps`.
 *
 * How. The memory that survives a crash is the `process_runs` row, not this object:
 *
 * - at boot the role reads how its previous life ended (`recordBoot`): crashed young
 *   (neither stable nor stopped on purpose) lengthens the streak, anything else clears it;
 * - when the streak reaches `PROCESS_RESTART_STORM_MIN_RESTARTS` inside
 *   `PROCESS_RESTART_STORM_WINDOW_MS`, `process.restart_storm` is recorded under ONE
 *   dedupe key per role. The recorder announces a condition only when its row is new or
 *   resolved, so the 4th, the 40th restart and a restart of a process that never learned it
 *   had announced all land on the open row as a count: ONE message per episode;
 * - a life that stays up `PROCESS_RUN_STABLE_AFTER_MS` ends the episode: the streak is
 *   cleared and, if the condition is open (read from the rows, not from memory), the
 *   `process.restart_storm_ended` recovery is recorded. A later storm is a new episode and a
 *   new message;
 * - `stop()` (SIGTERM, handled) marks the life as stopped on purpose, so an operator's
 *   `botctl restart` is not a crash.
 *
 * Never throws and never blocks a role from starting: every write is best-effort and logged.
 * A database that is down when a role boots is a role that cannot work anyway; the next boot
 * that reaches it counts from the row it finds.
 */
export class ProcessRestartWatch {
  private timer: { stop(): void } | null = null;
  private bornAt = 0;
  private started = false;
  private stableMarked = false;
  private runId = '';

  constructor(
    private readonly deps: {
      readonly role: string;
      readonly store: ProcessRunStore;
      readonly recorder: Pick<OperationalEventRecorder, 'record'>;
      readonly conditions: {
        openConditions(scope: TenantContext, dedupeKeys: readonly string[]): Promise<string[]>;
      };
      readonly scope: () => TenantContext | null;
      readonly clock: Clock;
      readonly newRunId: () => string;
      readonly logger: { warn: (context: Record<string, unknown>, message: string) => void };
      /** Starts the periodic check; the default is an unref'd `setInterval`. Tests pass their own. */
      readonly every?: (run: () => void, ms: number) => { stop(): void };
      /** Overrides the contract's numbers; production never sets them. */
      readonly stableAfterMs?: number;
      readonly minRestarts?: number;
      readonly windowMs?: number;
    },
  ) {}

  /** Records this life, announces a storm if this boot makes one, and arms the stability check. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const now = this.deps.clock.now();
    this.bornAt = now.getTime();
    this.runId = this.deps.newRunId();
    try {
      const mine = await this.deps.store.transact(this.deps.role, (previous) =>
        recordBoot(
          previous,
          this.runId,
          now,
          this.deps.windowMs ?? PROCESS_RESTART_STORM_WINDOW_MS,
        ),
      );
      if (
        mine !== null &&
        mine.restarts >= (this.deps.minRestarts ?? PROCESS_RESTART_STORM_MIN_RESTARTS)
      ) {
        await this.announce(mine.restarts);
      }
    } catch (error: unknown) {
      this.warn(error, 'process run could not be recorded; restart detection skips this boot');
    }
    const every =
      this.deps.every ??
      ((run, ms) => {
        const handle = setInterval(run, ms);
        // Never the reason the process stays alive.
        handle.unref();
        return { stop: () => clearInterval(handle) };
      });
    this.timer = every(() => void this.check(), PROCESS_RUN_CHECK_INTERVAL_MS);
  }

  /**
   * The stability check, on a timer. Once this life has been up the whole stable window it
   * ends the streak and the episode, and the timer stops. A failed write is tried again on
   * the next tick: the episode is not over until its recovery is recorded.
   */
  async check(): Promise<void> {
    const now = this.deps.clock.now();
    if (now.getTime() - this.bornAt < (this.deps.stableAfterMs ?? PROCESS_RUN_STABLE_AFTER_MS)) {
      return;
    }
    try {
      if (!this.stableMarked) {
        await this.deps.store.transact(this.deps.role, (current) =>
          current !== null && current.runId === this.runId ? recordStable(current, now) : null,
        );
        this.stableMarked = true;
      }
      if (await this.endEpisode()) this.disarm();
    } catch (error: unknown) {
      this.warn(error, 'process run stability could not be recorded; tried again shortly');
    }
  }

  /** A clean shutdown: this life is an operator's stop, not a crash. */
  async stop(): Promise<void> {
    this.disarm();
    if (!this.started) return;
    const now = this.deps.clock.now();
    try {
      await this.deps.store.transact(this.deps.role, (current) =>
        current !== null && current.runId === this.runId ? recordStopped(current, now) : null,
      );
    } catch (error: unknown) {
      this.warn(error, 'process stop could not be recorded; the next boot may count it as a crash');
    }
  }

  private disarm(): void {
    this.timer?.stop();
    this.timer = null;
  }

  private async announce(restarts: number): Promise<void> {
    const scope = this.deps.scope();
    if (scope === null) return;
    const windowMs = this.deps.windowMs ?? PROCESS_RESTART_STORM_WINDOW_MS;
    await recordQuietly(
      this.deps.recorder,
      scope,
      {
        code: PROCESS_RESTART_STORM_CODE,
        severity: OPS_ERROR_CLASS_POLICY.ERROR.storedSeverity,
        message: `Process "${this.deps.role}" keeps restarting: ${String(restarts)} restarts inside ${String(Math.round(windowMs / 60_000))} minutes, each life shorter than ${String(Math.round((this.deps.stableAfterMs ?? PROCESS_RUN_STABLE_AFTER_MS) / 1000))} seconds.`,
        dedupeKey: restartStormConditionKey(this.deps.role),
        context: {
          processRole: this.deps.role,
          state: 'RESTARTING',
          restarts,
          windowMinutes: Math.round(windowMs / 60_000),
        },
      },
      this.deps.logger,
    );
  }

  /** True when there is nothing left to close: no open condition, or its recovery is recorded. */
  private async endEpisode(): Promise<boolean> {
    const scope = this.deps.scope();
    if (scope === null) return true;
    const key = restartStormConditionKey(this.deps.role);
    const open = await this.deps.conditions.openConditions(scope, [key]);
    if (!open.includes(PROCESS_RESTART_STORM_CODE)) return true;
    const recorded = await recordQuietly(
      this.deps.recorder,
      scope,
      {
        code: PROCESS_RESTART_STORM_ENDED_CODE,
        severity: OPS_ERROR_CLASS_POLICY.INFO.storedSeverity,
        message: `Process "${this.deps.role}" has stayed up; it is no longer restarting.`,
        context: { processRole: this.deps.role, state: 'STABLE' },
        recoversCode: PROCESS_RESTART_STORM_CODE,
        recoversDedupeKey: key,
      },
      this.deps.logger,
    );
    return recorded !== null;
  }

  private warn(error: unknown, message: string): void {
    this.deps.logger.warn(
      { role: this.deps.role, error: error instanceof Error ? error.name : 'unknown' },
      message,
    );
  }
}
