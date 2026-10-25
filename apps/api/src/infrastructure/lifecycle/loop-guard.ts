/**
 * The one way a background loop's timer runs its tick.
 *
 * Every loop in every role used to start its pass as `setInterval(() => void this.tick(), …)`.
 * Each `tick()` catches what its own work throws, but nothing caught what the CATCH threw:
 * in v0.8.2 the FX loop's back-off warning threw (a logger method called detached from its
 * object), the catch block logged the same way and threw again, the promise `void` had
 * discarded rejected, and Node 22 exits on an unhandled rejection — so one failing exchange
 * rate source crash-looped the whole worker every thirteen seconds, and every other lane in
 * it with it.
 *
 * A guarded tick catches a synchronous throw and a rejection alike, logs ONE line naming
 * the loop, and counts the failure against that loop alone. It never rethrows, so the
 * timer keeps firing and the other loops keep theirs. It records no progress — the loop's
 * own `LoopProgress.record` is the last line of a pass that completed, and a pass that
 * threw did not reach it — so the worker's readiness still names THIS loop as stale.
 *
 * The counter is in-process and per loop name, read by `loopTickFailures`. It is not a
 * metric: the operational signal for a lane that keeps failing is the stale loop itself.
 */

/** Structural, so a loop's own narrow logger type is enough. */
export interface LoopGuardLogger {
  error(context: Record<string, unknown>, message: string): void;
}

const failures = new Map<string, number>();

/** How many of `name`'s ticks have thrown in this process. */
export function loopTickFailures(name: string): number {
  return failures.get(name) ?? 0;
}

/**
 * Runs one tick of the loop `name`. The promise it returns never rejects and the call
 * never throws, whatever `tick` or `logger` does.
 */
export async function runGuardedTick(
  name: string,
  tick: () => unknown,
  logger: LoopGuardLogger,
): Promise<void> {
  try {
    await tick();
  } catch (error) {
    const count = (failures.get(name) ?? 0) + 1;
    failures.set(name, count);
    reportFailure(name, count, error, logger);
  }
}

/**
 * The timer callback for the loop `name`: `setInterval(guardedTick('relay', () =>
 * this.tick(), logger), ms)`. Returns nothing, so there is no promise left to reject.
 */
export function guardedTick(
  name: string,
  tick: () => unknown,
  logger: LoopGuardLogger,
): () => void {
  return () => {
    void runGuardedTick(name, tick, logger);
  };
}

function reportFailure(name: string, count: number, error: unknown, logger: LoopGuardLogger): void {
  try {
    // The error OBJECT, so the redacting logger renders its message, stack and cause.
    logger.error({ loop: name, failures: count, err: error }, 'background loop tick threw');
  } catch {
    // The logger itself is what failed — which is exactly the v0.8.2 incident. Say which
    // loop on stderr, with nothing from the error: an unredacted message could carry a
    // secret, and the loop's name and count are all this line needs.
    try {
      process.stderr.write(`background loop tick threw and could not be logged: ${name}\n`);
    } catch {
      // Nothing is left to report to. The counter above has still moved, and swallowing
      // here is the point: a guard that can throw is the bug it exists to stop.
    }
  }
}
