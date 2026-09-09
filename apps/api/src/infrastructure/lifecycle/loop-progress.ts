/**
 * Whether a background loop is still doing its job.
 *
 * "The process exists" is not the claim a worker's health check should make.
 * Two loops already knew that and each grew its own answer — the panel
 * monitor's `iterationIsFresh` and the backup scheduler's `isFresh` — and three
 * more had no answer at all: the outbox relay, the two retention sweepers and
 * the notification dispatcher. This is the fourth copy, written once instead.
 *
 * The failure it exists to catch is not a loop that throws. A loop that throws
 * is loud. It is a loop that is ALIVE and achieving nothing:
 *
 *   - the relay's `processBatch` HANGS rather than throwing, so `scheduleNext`
 *     is never reached, `running` stays true so `start()` is a no-op, and
 *     nothing restarts it. The worker's heartbeat keeps writing, because
 *     `SELECT 1` on a different checkout still succeeds;
 *   - the dispatcher's every tick throws and is caught and rescheduled, for
 *     ever. That one drains the queue by which the installation reports
 *     anything being wrong, so the system silently loses its ability to say it
 *     is broken while its container reports healthy.
 *
 * THE STARTUP GRACE IS DELIBERATE, and it is why this is not simply
 * `lastProgressAt !== null`. Before a loop's first tick is even due, the
 * absence of progress is not evidence of failure — it is evidence of a process
 * that started three seconds ago. A strict rule would make the worker unhealthy
 * at boot for as long as its slowest loop's initial delay, and the retention
 * sweepers first run a minute in, against a container health check that gives up
 * after seventy seconds. Reporting a fresh deploy as unhealthy is not a truthful
 * health check; it is a different lie.
 *
 * So the clock starts at `start()`, and one slack window of silence after
 * starting is allowed. After the first completed tick the reading is purely
 * progress-based, which is the property that matters in the steady state.
 *
 * `record` is called ONLY on a tick that completed. Never in a catch — a
 * caught-and-logged failure is exactly the state this reports — and never while
 * stopping, so a draining worker is not reported as working.
 */
export class LoopProgress {
  private startedAt: number | null = null;
  private lastProgressAt: number | null = null;

  constructor(
    /** The loop's own cadence. Freshness is measured in multiples of this. */
    private readonly intervalMs: number,
    /**
     * How many intervals of silence are tolerated.
     *
     * Three, matching the panel monitor and the backup scheduler, so one slow
     * tick is not an outage. Lower would make a busy installation flap; higher
     * would take longer to notice a loop that has genuinely stopped.
     */
    private readonly slackIntervals = 3,
  ) {}

  /** The loop began. Starts the grace window. */
  begin(nowMs: number): void {
    this.startedAt = nowMs;
    this.lastProgressAt = null;
  }

  /** A tick completed. */
  record(nowMs: number): void {
    this.lastProgressAt = nowMs;
  }

  /**
   * The loop stopped, so it is no longer making a claim.
   *
   * Not fresh afterwards: a stopped loop that still reported fresh would let a
   * draining worker look like a working one for a whole slack window.
   */
  end(): void {
    this.startedAt = null;
    this.lastProgressAt = null;
  }

  isFresh(nowMs: number): boolean {
    const since = this.lastProgressAt ?? this.startedAt;
    if (since === null) return false;
    return nowMs - since <= this.intervalMs * this.slackIntervals;
  }
}
