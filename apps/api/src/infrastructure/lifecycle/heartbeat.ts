import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '@nexa/contracts';
import { runGuardedTick } from './loop-guard.js';
import { startLivenessWatchdog, type LivenessWatchdog } from './liveness-watchdog.js';

/**
 * The worker's liveness, as something outside the process can read.
 *
 * The worker serves no HTTP, so its container had no health check, and a
 * worker in a crash loop — or alive with a blocked event loop, or alive and
 * unable to reach the database — was indistinguishable from a working one to
 * everything that decides whether a release is ready. "The container exists"
 * is not that signal, and was deliberately never used as one.
 *
 * This is: every `intervalMs` the worker runs a real check (a `SELECT 1`
 * through its own pool) and, only when that succeeds, writes the time into a
 * file. The container's health check reads the file's age. A process that
 * has died, stalled, or lost its database stops writing, and the file goes
 * stale within one interval. Written beside and renamed over, so a reader
 * never sees a half-written number.
 */
export interface HeartbeatOptions {
  readonly path: string;
  readonly intervalMs: number;
  /** A real check of the worker's ability to do its job. Must not throw. */
  readonly check: () => Promise<boolean>;
  readonly now: () => number;
  readonly logger: Logger;
  /**
   * R12 F2: leave the process after this many consecutive heartbeat intervals without a
   * successful beat, so Docker restarts it (`liveness-watchdog.ts`). 0 or absent: never —
   * the file goes stale and the container reports unhealthy, as before.
   */
  readonly exitAfterMissed?: number;
  /** The role's name, for the watchdog's log line. */
  readonly role?: string;
  /** How the process leaves when the watchdog asks. `process.exit` unless a test injects. */
  readonly exit?: (code: number) => void;
}

export interface Heartbeat {
  /** One beat, now. Exposed so a test and the first tick share one path. */
  beat(): Promise<boolean>;
  stop(): void;
}

export function startHeartbeat(options: HeartbeatOptions): Heartbeat {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const watchdog: LivenessWatchdog | null =
    options.exitAfterMissed !== undefined && options.exitAfterMissed > 0
      ? startLivenessWatchdog({
          role: options.role ?? 'unknown',
          maxSilenceMs: options.exitAfterMissed * options.intervalMs,
          // One more interval for a responsive main thread to act on the request; after
          // that it is blocked, and the watchdog kills it.
          graceMs: options.intervalMs,
          logger: options.logger,
          exit: options.exit ?? ((code) => process.exit(code)),
        })
      : null;

  const beat = async (): Promise<boolean> => {
    let ok = false;
    try {
      ok = await options.check();
    } catch (error) {
      options.logger.warn({ err: String(error) }, 'worker heartbeat check failed');
    }
    if (!ok || stopped) return false;
    try {
      writeHeartbeat(options.path, options.now());
      watchdog?.touch();
      return true;
    } catch (error) {
      options.logger.warn(
        { err: String(error), path: options.path },
        'worker heartbeat not written',
      );
      return false;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void runGuardedTick('heartbeat', beat, options.logger).finally(schedule);
    }, options.intervalMs);
    timer.unref?.();
  };

  void runGuardedTick('heartbeat', beat, options.logger).finally(schedule);

  return {
    beat,
    stop() {
      stopped = true;
      watchdog?.stop();
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function writeHeartbeat(path: string, at: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  writeFileSync(partial, `${at}\n`, { mode: 0o644 });
  renameSync(partial, path);
}

/**
 * Whether a heartbeat file says its writer was alive within `maxAgeMs` of
 * `now`. The container health check is this, inlined as a `node -e` one-liner
 * in compose.yml; keeping the rule here as well is what lets a test pin the
 * two to the same answer.
 */
export function heartbeatIsFresh(contents: string, now: number, maxAgeMs: number): boolean {
  const text = contents.trim();
  // `Number('')` is 0, which would make an EMPTY file a heartbeat from 1970
  // — fresh for ever under a `now - at <= max` test on a small `now`, and
  // wrong in every case. The compose one-liner makes the same check.
  if (text === '') return false;
  const at = Number(text);
  if (!Number.isFinite(at)) return false;
  return now - at <= maxAgeMs;
}
