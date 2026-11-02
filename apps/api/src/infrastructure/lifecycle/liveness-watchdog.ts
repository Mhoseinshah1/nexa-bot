import { Worker } from 'node:worker_threads';
import type { Logger } from '@nexa/contracts';

/**
 * A role that is alive but no longer working exits, so Docker restarts it (R12 F2 item 3).
 *
 * Every background role writes a heartbeat file only after a real check (a database round
 * trip and its loops' progress), and the container's health check reads its age. That made
 * a hung role UNHEALTHY — and nothing more. Compose's `restart: unless-stopped` restarts a
 * container whose process EXITS; it never restarts one that is merely unhealthy. So a
 * worker wedged on a lock, a monitor whose loop stopped, an API whose event loop was
 * blocked stayed exactly like that, healthy-looking to everything but the health column,
 * until an operator noticed.
 *
 * This closes it, in two steps, from a separate THREAD — because the hang that matters most
 * is the one where the main thread cannot run any timer of its own:
 *
 *   1. When nothing has `touch()`ed for `maxSilenceMs` (the role passes N heartbeat
 *      intervals), the thread asks the main thread to leave. A main thread that is merely
 *      failing its checks is still responsive: it logs why and exits(1).
 *   2. If the process is still alive `graceMs` later and the main thread never took the
 *      request, it is blocked and cannot act on it, so the thread writes one line straight
 *      to stderr (a synchronous write: the logger lives on the blocked thread) and SIGKILLs
 *      the process. A main thread that took the request is never killed: it is leaving.
 *
 * Either way the container's PID 1 (tini) sees its child die and the container exits, and
 * Docker restarts it. The operator is still told: `ProcessRestartWatch` records the
 * restart (and a storm of them) in the operations log, and the stalled-loop reporter has
 * already reported the loop that stopped, before the exit.
 *
 * NOT ARMED until the first `touch()`. A role that has never once been healthy is not
 * "hung-but-alive": it is failing to start, which `botctl update`'s readiness gate and the
 * health column already report — and a restart loop would not fix a missing table.
 *
 * Time is `process.hrtime` — monotonic, and the same clock on both threads — so a wall-clock
 * step from NTP can neither trigger nor mask an exit.
 */

export interface LivenessWatchdogOptions {
  /** The role's name, for the log line. */
  readonly role: string;
  /** Silence after which the process is asked to exit. */
  readonly maxSilenceMs: number;
  /** After asking, how long until the process is killed. */
  readonly graceMs: number;
  readonly logger: Logger;
  /** How the main thread leaves when asked. `process.exit` in production. */
  readonly exit: (code: number) => void;
}

export interface LivenessWatchdog {
  /** The role did its work just now. */
  touch(): void;
  /** Stops watching: a role that is shutting down must not be killed for going quiet. */
  stop(): void;
}

/**
 * The watching thread, as source. Plain CommonJS with only built-ins, because it runs from
 * a string (`eval: true`) and must not depend on how the application was built. Exported
 * so a test can run it beside a main thread that really blocks.
 */
export const LIVENESS_WATCHDOG_THREAD_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { writeSync } = require('node:fs');
const stamp = new BigInt64Array(workerData.shared);
const maxSilence = BigInt(workerData.maxSilenceMs) * 1000000n;
const grace = BigInt(workerData.graceMs) * 1000000n;
let askedAt = null;
setInterval(() => {
  const last = Atomics.load(stamp, 0);
  if (last === 0n) return;
  const now = process.hrtime.bigint();
  if (now - last <= maxSilence) {
    askedAt = null;
    return;
  }
  const silentMs = Number((now - last) / 1000000n);
  if (askedAt === null) {
    askedAt = now;
    parentPort.postMessage({ type: 'unresponsive', silentMs });
    return;
  }
  // The main thread took the request (it is not blocked), so it is leaving by itself.
  if (Atomics.load(stamp, 1) !== 0n) return;
  if (now - askedAt >= grace) {
    try {
      writeSync(2, JSON.stringify({ level: 'fatal', role: workerData.role, silentMs,
        msg: 'liveness watchdog: the main thread did not exit when asked; killing the process so the container is restarted' }) + '\\n');
    } catch (error) {
      void error;
    }
    process.kill(process.pid, 'SIGKILL');
  }
}, workerData.checkEveryMs);
`;

export function startLivenessWatchdog(options: LivenessWatchdogOptions): LivenessWatchdog {
  // [0] the last touch (hrtime ns; 0 = not armed), [1] set once the main thread has taken
  // an exit request — a thread that can run its handler is not blocked and must not be killed.
  const shared = new SharedArrayBuffer(16);
  const stamp = new BigInt64Array(shared);
  let stopped = false;
  const worker = new Worker(LIVENESS_WATCHDOG_THREAD_SOURCE, {
    eval: true,
    workerData: {
      shared,
      role: options.role,
      maxSilenceMs: options.maxSilenceMs,
      graceMs: options.graceMs,
      checkEveryMs: Math.max(25, Math.min(1_000, Math.floor(options.maxSilenceMs / 8))),
    },
  });
  // The watchdog must never be the thing that keeps a finished process alive.
  worker.unref();
  worker.on('message', (message: { type?: string; silentMs?: number }) => {
    if (stopped || message.type !== 'unresponsive') return;
    Atomics.store(stamp, 1, 1n);
    options.logger.error(
      { role: options.role, silentMs: message.silentMs, maxSilenceMs: options.maxSilenceMs },
      'liveness watchdog: no successful heartbeat for too long; exiting so the container is restarted',
    );
    options.exit(1);
  });
  // A watchdog that cannot run is reported and leaves the role running: it is a safety net,
  // and failing to start one must not take down a role that is working.
  worker.on('error', (error) => {
    options.logger.warn({ role: options.role, err: String(error) }, 'liveness watchdog stopped');
  });

  return {
    touch() {
      if (!stopped) Atomics.store(stamp, 0, process.hrtime.bigint());
    },
    stop() {
      stopped = true;
      Atomics.store(stamp, 0, 0n);
      void worker.terminate();
    },
  };
}
