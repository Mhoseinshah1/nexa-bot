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

/**
 * v0.8.2 hotfix: a process gives NO verdict in its first minute (a stall is neither opened
 * nor an inherited one closed).
 *
 * The worker's first heartbeat fires before most of its loops have been started — three of
 * them only after an awaited start-up sweep — and a loop that was never started reports
 * "not fresh". That read as a stall on every boot and was closed one beat later, so a
 * crash-looping worker posted a `job.loop_stalled` / `job.loop_recovered` pair per restart
 * for loops that had never had the chance to run. A loop genuinely not running after this
 * long is a real stall and is reported then.
 */
export const LOOP_BOOT_GRACE_MS = 60_000;

/**
 * v0.8.2 hotfix: a loop must stay fresh this long, continuously, before its condition is
 * CLOSED. This is the roll-up of a restart storm: a process that dies before the window
 * ends never closes the condition it inherited, so the next life's stall lands on the
 * still-open row (recorded, counted, and NOT announced again — only a reopened condition is
 * a new message), instead of closing and reopening it once per restart. It also keeps one
 * flapping loop to one episode: a stall that returns inside the window is the same stall.
 */
export const LOOP_RECOVERY_CONFIRM_MS = 60_000;

export interface LoopStatus {
  readonly name: string;
  /**
   * `true` stalled, `false` making progress (or switched off), and `null` UNKNOWN: no
   * verdict yet, as inside a restarted role's startup grace (Codex P2 on #258). UNKNOWN
   * opens nothing and CLOSES nothing — reading it as fresh resolved a stall the previous
   * life left open before this one had made a single successful pass, and the condition
   * reopened the moment the grace ran out.
   */
  readonly stalled: boolean | null;
}

/**
 * The process roles that report their loops (FIX-03 batch 2026-10-10).
 *
 * The worker was the only one until this batch, so a provisioner whose every settlement
 * lane threw, a monitor whose discovery threw and a recovery executor whose tick threw
 * each went stale in their own container's health check and said nothing anywhere an
 * operator reads. The role travels as `processRole` in the event's context, so the group
 * message names the process to look at, not only the loop.
 */
export type LoopReportingRole = 'worker' | 'provisioner' | 'monitor' | 'recovery' | 'migration';

const ROLE_LABEL: Readonly<Record<LoopReportingRole, string>> = {
  worker: 'Worker',
  provisioner: 'Provisioner',
  monitor: 'Monitor',
  recovery: 'Recovery',
  migration: 'Migration',
};

/**
 * Whether a loop of a role whose readiness has NO startup grace is stalled, for REPORTING.
 *
 * The provisioner, the monitor and the recovery executor all refuse readiness until their
 * first successful pass, deliberately (each one's file says why). Readiness and reporting
 * are different questions: a release that never becomes ready fails its rollout, which is
 * the signal; but a stall recorded on the very first heartbeat, before the first tick could
 * possibly have run, is a false alarm in the group on every restart. So a loop is reported
 * stalled only once it has had `graceMs` since it started to make progress, and never
 * while it is disabled (`startedAtMs` null — the operator switched it off).
 *
 * Inside the grace, a loop that has not yet made progress is UNKNOWN (`null`), not fresh:
 * a stall inherited from the previous life stays open until a pass actually succeeds.
 */
export function stalledAfterGrace(input: {
  readonly fresh: boolean;
  readonly startedAtMs: number | null;
  readonly nowMs: number;
  readonly graceMs: number;
}): boolean | null {
  if (input.fresh || input.startedAtMs === null) return false;
  // Inside the grace there is no verdict either way: UNKNOWN, never "fresh".
  return input.nowMs - input.startedAtMs > input.graceMs ? true : null;
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
 *
 * The state machine, per loop (v0.8.2 hotfix against the restart-storm noise):
 *
 * - process age below LOOP_BOOT_GRACE_MS: no verdict at all, nothing opened, nothing closed;
 * - stalled: `job.loop_stalled` is recorded on the loop's one condition row. It is announced
 *   only when that row is new or resolved; while the stall lasts it is re-recorded, silently
 *   and counted, every LOOP_STALL_RERECORD_MS;
 * - fresh for less than LOOP_RECOVERY_CONFIRM_MS in an unbroken run: still the same episode;
 * - fresh for that long: `job.loop_recovered` is recorded and resolves the row;
 * - UNKNOWN (null): neither opens nor closes, and ends a run of fresh observations.
 *
 * The condition row is the memory that survives a restart; the grace and the confirmation
 * window are what keep a process that dies young from closing and reopening it.
 */
export class LoopStallReporter {
  private readonly recordedAt = new Map<string, number>();
  /**
   * Stalls another process left open, found by the startup check, that this process has not
   * yet managed to close. Kept until the recovery is RECORDED (Codex P2 on #251): marking
   * them handled when found meant one failed write left the condition open for good.
   */
  private readonly inherited = new Set<string>();
  /**
   * The loops whose inherited condition has been looked for. Per loop, and only once a loop
   * is KNOWN fresh: a loop still UNKNOWN on the first observation (inside its grace) is
   * looked for when it first makes progress, not never.
   */
  private readonly startupChecked = new Set<string>();
  /** When each loop was first seen fresh in the CURRENT unbroken run of fresh observations. */
  private readonly freshSince = new Map<string, number>();
  private readonly bornAt: number;
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
      /** Which process this is; named in the message and in the context. */
      readonly role: LoopReportingRole;
      /** Overrides `LOOP_BOOT_GRACE_MS`; production never sets it. */
      readonly bootGraceMs?: number;
      /** Overrides `LOOP_RECOVERY_CONFIRM_MS`; production never sets it. */
      readonly recoveryConfirmMs?: number;
    },
  ) {
    this.bornAt = deps.clock.now().getTime();
  }

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
    // No verdict while this process is young (see LOOP_BOOT_GRACE_MS). Not even a close.
    if (now - this.bornAt < (this.deps.bootGraceMs ?? LOOP_BOOT_GRACE_MS)) return;

    // An unbroken run of fresh observations: anything else (stalled or UNKNOWN) ends it.
    for (const loop of loops) {
      if (loop.stalled !== false) this.freshSince.delete(loop.name);
      else if (!this.freshSince.has(loop.name)) this.freshSince.set(loop.name, now);
    }

    for (const loop of loops) {
      if (loop.stalled !== true) continue;
      const last = this.recordedAt.get(loop.name);
      if (last !== undefined && now - last < LOOP_STALL_RERECORD_MS) continue;
      const recorded = await recordQuietly(
        this.deps.recorder,
        scope,
        {
          code: JOB_LOOP_STALLED_CODE,
          severity: OPS_ERROR_CLASS_POLICY.ERROR.storedSeverity,
          message: `${ROLE_LABEL[this.deps.role]} loop "${loop.name}" has stopped making progress.`,
          dedupeKey: loopStallConditionKey(loop.name),
          context: { kind: loop.name, state: 'STALLED', processRole: this.deps.role },
        },
        this.deps.logger,
      );
      if (recorded !== null) this.recordedAt.set(loop.name, now);
    }

    // Recoveries: the ones this process opened, and — once per loop, the first time it is
    // KNOWN fresh — any another process left open. An UNKNOWN loop is neither. Only a loop
    // that has stayed fresh for the whole confirmation window (LOOP_RECOVERY_CONFIRM_MS).
    const confirmMs = this.deps.recoveryConfirmMs ?? LOOP_RECOVERY_CONFIRM_MS;
    const fresh = loops
      .filter((loop) => loop.stalled === false)
      .map((loop) => loop.name)
      .filter((name) => now - (this.freshSince.get(name) ?? now) >= confirmMs);
    for (const name of fresh) {
      if (this.startupChecked.has(name)) continue;
      if (!this.recordedAt.has(name)) {
        const open = await this.deps.conditions.openConditions(scope, [
          loopStallConditionKey(name),
        ]);
        if (open.includes(JOB_LOOP_STALLED_CODE)) this.inherited.add(name);
      }
      this.startupChecked.add(name);
    }
    const toClose = fresh.filter((name) => this.recordedAt.has(name) || this.inherited.has(name));
    for (const name of toClose) {
      const recorded = await recordQuietly(
        this.deps.recorder,
        scope,
        {
          code: JOB_LOOP_RECOVERED_CODE,
          severity: OPS_ERROR_CLASS_POLICY.INFO.storedSeverity,
          message: `${ROLE_LABEL[this.deps.role]} loop "${name}" is making progress again.`,
          context: { kind: name, state: 'FRESH', processRole: this.deps.role },
          recoversCode: JOB_LOOP_STALLED_CODE,
          recoversDedupeKey: loopStallConditionKey(name),
        },
        this.deps.logger,
      );
      if (recorded !== null) {
        this.recordedAt.delete(name);
        this.inherited.delete(name);
      }
    }
  }
}

/**
 * What the reporter is told about each loop the heartbeat knows (Codex P2 on #251).
 *
 * EVERY loop, enabled or not. A disabled loop is never stalled — the heartbeat does not
 * consult it, and its freshness thunk is never called here either — but it IS reported, as
 * not stalled, so a stall that opened while it ran is closed once an operator switches it
 * off. Passing only enabled loops left such a condition open for ever.
 */
export function loopStatusesForReporting(
  loops: readonly (readonly [name: string, enabled: boolean, ...rest: unknown[]])[],
  stalled: readonly string[],
): LoopStatus[] {
  return loops.map(([name, enabled]) => ({ name, stalled: enabled && stalled.includes(name) }));
}
