import {
  JOB_LOOP_RECOVERED_CODE,
  JOB_LOOP_STALLED_CODE,
  OPS_ERROR_CLASS_POLICY,
  type Clock,
  type OperationalEventRecorder,
  type TenantContext,
} from '@nexa/contracts';
import { recordQuietly } from './error-events.js';

/** The dedupe key of one loop's stalled condition. One function: the format IS the identity. */
export function loopStallConditionKey(loop: string): string {
  return `${JOB_LOOP_STALLED_CODE}:${loop}`;
}

/** How often a loop that STAYS stalled is recorded again (its counter grows; no new message). */
export const LOOP_STALL_RERECORD_MS = 5 * 60_000;

export interface LoopStatus {
  readonly name: string;
  readonly stalled: boolean;
}

/**
 * FIX-05: the worker's job and loop failures, reported at the one chokepoint that sees all
 * of them — the heartbeat's `stalledLoops`.
 *
 * Every loop catches its own pass's failure and logs it; a pass that throws records no
 * progress, so a loop whose every pass fails goes STALE, and the heartbeat already names
 * it. Until now that name reached only the process log and the container's health status,
 * and the operator found out when something downstream did not happen. This turns it into
 * a condition in the operations log: opened when a loop is stalled, closed by
 * `job.loop_recovered` when it is fresh again.
 *
 * Never throws and never blocks the heartbeat: the caller does not await it, and every
 * write is `recordQuietly`. A process that restarts with a condition another process (or
 * its own previous life) opened finds it once, on its first observation, and closes it if
 * the loop is fresh here.
 */
export class LoopStallReporter {
  private readonly recordedAt = new Map<string, number>();
  private startupChecked = false;
  private running = false;

  constructor(
    private readonly deps: {
      readonly recorder: Pick<OperationalEventRecorder, 'record'>;
      readonly conditions: {
        openConditions(scope: TenantContext, dedupeKeys: readonly string[]): Promise<string[]>;
      };
      readonly scope: () => TenantContext | null;
      readonly clock: Clock;
      readonly logger: { warn: (context: Record<string, unknown>, message: string) => void };
    },
  ) {}

  async observe(loops: readonly LoopStatus[]): Promise<void> {
    // One observation at a time: a slow database must not stack heartbeats' worth of them.
    if (this.running) return;
    this.running = true;
    try {
      await this.observeOnce(loops);
    } catch (error: unknown) {
      this.deps.logger.warn(
        { error: error instanceof Error ? error.name : 'unknown' },
        'loop stall reporting failed; the heartbeat is unaffected',
      );
    } finally {
      this.running = false;
    }
  }

  private async observeOnce(loops: readonly LoopStatus[]): Promise<void> {
    const scope = this.deps.scope();
    if (scope === null) return;
    const now = this.deps.clock.now().getTime();

    for (const loop of loops) {
      if (!loop.stalled) continue;
      const last = this.recordedAt.get(loop.name);
      if (last !== undefined && now - last < LOOP_STALL_RERECORD_MS) continue;
      const recorded = await recordQuietly(
        this.deps.recorder,
        scope,
        {
          code: JOB_LOOP_STALLED_CODE,
          severity: OPS_ERROR_CLASS_POLICY.ERROR.storedSeverity,
          message: `Worker loop "${loop.name}" has stopped making progress.`,
          dedupeKey: loopStallConditionKey(loop.name),
          context: { kind: loop.name, state: 'STALLED' },
        },
        this.deps.logger,
      );
      if (recorded !== null) this.recordedAt.set(loop.name, now);
    }

    // Recoveries: the ones this process opened, and — once, on its first observation —
    // any another process left open for a loop that is fresh here.
    const fresh = loops.filter((loop) => !loop.stalled).map((loop) => loop.name);
    let toClose = fresh.filter((name) => this.recordedAt.has(name));
    if (!this.startupChecked) {
      const inherited: string[] = [];
      for (const name of fresh) {
        if (this.recordedAt.has(name)) continue;
        const open = await this.deps.conditions.openConditions(scope, [
          loopStallConditionKey(name),
        ]);
        if (open.includes(JOB_LOOP_STALLED_CODE)) inherited.push(name);
      }
      this.startupChecked = true;
      toClose = [...toClose, ...inherited];
    }
    for (const name of toClose) {
      const recorded = await recordQuietly(
        this.deps.recorder,
        scope,
        {
          code: JOB_LOOP_RECOVERED_CODE,
          severity: OPS_ERROR_CLASS_POLICY.INFO.storedSeverity,
          message: `Worker loop "${name}" is making progress again.`,
          context: { kind: name, state: 'FRESH' },
          recoversCode: JOB_LOOP_STALLED_CODE,
          recoversDedupeKey: loopStallConditionKey(name),
        },
        this.deps.logger,
      );
      if (recorded !== null) this.recordedAt.delete(name);
    }
  }
}
