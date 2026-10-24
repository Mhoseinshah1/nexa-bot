/**
 * A CPU quota for the backup's heavy tools (Round 8, B5).
 *
 * WHY THIS AND NOT A CGROUP. `nice` only orders processes that compete; on a 2-vCPU host with
 * an idle bot it lets 7-Zip hold both cores for 13 minutes. A real limit has to come from the
 * kernel (cgroup v2 `cpu.max`, `systemd-run -p CPUQuota`) or from `cpulimit`. None of those is
 * available inside the production container: it runs no systemd, the cgroup tree is mounted
 * read-only for an unprivileged process, and `cpulimit` is not in the image. What every
 * container does allow is a process signalling its own child, so the limit is the one
 * `cpulimit` itself implements: a duty cycle of SIGSTOP / SIGCONT over a short period.
 *
 * WHAT IT BOUNDS. The tool's CPU time over any period is at most `percent / 100` of the period,
 * for however many threads it has; the tool cannot opt out, and nothing is installed. Combined
 * with `-mmt=1` (one thread) a quota of 70 is 70 percent of ONE core, which leaves the other
 * vCPU entirely to the bot.
 *
 * THE TRADE-OFFS, stated so they are not rediscovered. (1) Wall time grows by 100/percent:
 * a step that needs 100 CPU-seconds takes about 143 s at 70. (2) The stopped process still
 * holds its memory, so the limit lowers CPU and not memory. (3) It bounds the CLIENT process:
 * the PostgreSQL SERVER's work for `pg_restore` (index builds) is bounded separately by the
 * session settings in `VERIFY_RESTORE_PGOPTIONS`. (4) A stopped process receives SIGTERM only
 * once it is continued, so `release` always continues it before anything kills it.
 */

/** The slice of a child process the throttle needs: tests give it a fake. */
export interface ThrottledChild {
  kill(signal: NodeJS.Signals): boolean;
}

export interface CpuThrottle {
  /** Stops throttling and leaves the process RUNNING. Idempotent. Call before killing it. */
  release(): void;
}

export interface CpuThrottleTimers {
  setTimeout(callback: () => void, ms: number): { unref?: () => void };
  clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: CpuThrottleTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/** One duty-cycle period. Short enough to be smooth, long enough that signals cost nothing. */
export const CPU_QUOTA_PERIOD_MS = 100;

/** The running and stopped parts of one period for `percent` of one core. */
export function cpuDutyCycle(
  percent: number,
  periodMs: number = CPU_QUOTA_PERIOD_MS,
): { readonly runMs: number; readonly stopMs: number } {
  const bounded = Math.min(100, Math.max(1, percent));
  const runMs = Math.max(1, Math.round((periodMs * bounded) / 100));
  return { runMs, stopMs: periodMs - runMs };
}

/** A limit at or above this is no limit: the tool is not touched. */
export const CPU_QUOTA_UNLIMITED = 100;

/**
 * Throttles `child` to `percent` of one core until `release` (or the process ends).
 * At 100 or more it does nothing and sends no signal.
 */
export function startCpuThrottle(
  child: ThrottledChild,
  percent: number,
  options: { readonly periodMs?: number; readonly timers?: CpuThrottleTimers } = {},
): CpuThrottle {
  if (!(percent < CPU_QUOTA_UNLIMITED)) return { release: () => undefined };
  const timers = options.timers ?? REAL_TIMERS;
  const { runMs, stopMs } = cpuDutyCycle(percent, options.periodMs);
  let released = false;
  let handle: unknown = null;

  const signal = (name: NodeJS.Signals): void => {
    try {
      child.kill(name);
    } catch {
      // The process is already gone; the next close/release ends the loop.
    }
  };
  const run = (): void => {
    if (released) return;
    signal('SIGCONT');
    handle = timers.setTimeout(stop, runMs);
    (handle as { unref?: () => void }).unref?.();
  };
  const stop = (): void => {
    if (released) return;
    signal('SIGSTOP');
    handle = timers.setTimeout(run, stopMs);
    (handle as { unref?: () => void }).unref?.();
  };
  // The tool starts running, so its first slice is a run slice.
  handle = timers.setTimeout(stop, runMs);
  (handle as { unref?: () => void }).unref?.();

  return {
    release: () => {
      if (released) return;
      released = true;
      if (handle !== null) timers.clearTimeout(handle);
      // Always continue: a process released while stopped would otherwise never see SIGTERM.
      signal('SIGCONT');
    },
  };
}

/** A configured quota as one log/describe string (`cpu-limit=70%`). */
export function describeCpuQuota(percent: number): string {
  return percent < CPU_QUOTA_UNLIMITED ? `cpu-limit=${String(percent)}%` : 'cpu-limit=none';
}

/** Where a tool reads the quota from, per spawn: the Web Admin setting is live. */
export type CpuLimitProvider = () => Promise<number>;

/** Resolves a provider, failing OPEN to the default rather than blocking a backup. */
export async function resolveCpuLimit(
  provider: CpuLimitProvider | undefined,
  fallback: number,
): Promise<number> {
  if (provider === undefined) return CPU_QUOTA_UNLIMITED;
  try {
    const value = await provider();
    return Number.isFinite(value) && value >= 1 ? Math.min(100, Math.floor(value)) : fallback;
  } catch {
    return fallback;
  }
}
