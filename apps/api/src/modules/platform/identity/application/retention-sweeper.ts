import type { Clock, Logger } from '@nexa/contracts';

/**
 * Worker-side housekeeping for identity tables that grow on their own.
 *
 * Two tables here accumulate rows an unauthenticated or barely-authenticated
 * caller can create at will, and neither is cleaned by the paths that write it:
 *
 *   - `admin_login_throttle` inserts a durable row for every previously unseen
 *     username or IP, and resets an expired one only when that exact subject is
 *     used again. An endless stream of distinct usernames — or a rotating IPv6
 *     range — grows it for good.
 *   - `admin_sessions` gains a row per successful login, and logout and
 *     rotation only mark rows revoked. Nothing removed them, so a single valid
 *     credential signed in repeatedly grows the table for the life of the
 *     installation. A limiter or a session table an attacker can turn into
 *     unbounded storage is not much of either.
 *
 * It runs in the WORKER, not on the request path: putting a delete in front of
 * every sign-in is a poor answer to slow accumulation.
 *
 * A tick DRAINS rather than taking a single batch. One capped batch per hour is
 * a cleanup RATE, and a rate below the rate rows arrive at still grows without
 * bound — a caller producing more distinct subjects per hour than the batch
 * size simply outruns it. So a tick keeps taking batches until one comes back
 * short, which means the eligible backlog is gone. `maxBatchesPerTick` bounds
 * the pass so housekeeping can never monopolise the worker or a connection; a
 * tick that hits the ceiling says so and the next one continues.
 */
export interface RetentionTask {
  /** Names the task in logs. */
  readonly name: string;
  /** Deletes at most `limit` eligible rows; returns how many it removed. */
  purge(now: Date, limit: number): Promise<number>;
}

export interface RetentionSweeperOptions {
  /** How often to sweep. */
  readonly intervalMs: number;
  /** Rows per batch, so no single statement is long. */
  readonly batchSize: number;
  /** Ceiling on batches in one tick, so a pass is always bounded. */
  readonly maxBatchesPerTick: number;
}

export class RetentionSweeper {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly task: RetentionTask,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly options: RetentionSweeperOptions,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    // Never hold the process open for a housekeeping timer.
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Let an in-flight sweep finish rather than leaving a half-done drain.
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  /**
   * One pass: batches until the backlog is drained or the ceiling is reached.
   *
   * Exposed so a test can run it without waiting for the timer.
   */
  async sweep(): Promise<number> {
    let removed = 0;
    for (let batch = 0; batch < this.options.maxBatchesPerTick; batch += 1) {
      const n = await this.task.purge(this.clock.now(), this.options.batchSize);
      removed += n;
      // A short batch means nothing eligible is left. A full one means there
      // may be more, so keep going rather than waiting out the interval.
      if (n < this.options.batchSize) return removed;
    }
    this.logger.warn(
      { task: this.task.name, removed, maxBatchesPerTick: this.options.maxBatchesPerTick },
      'retention sweep hit its per-tick ceiling with work remaining',
    );
    return removed;
  }

  private async tick(): Promise<void> {
    // Overlapping sweeps would contend for the same rows and achieve nothing.
    if (this.running) return;
    this.running = true;
    try {
      const removed = await this.sweep();
      if (removed > 0) this.logger.info({ task: this.task.name, removed }, 'expired rows removed');
    } catch (error) {
      // Housekeeping must never take the worker down: the next tick retries.
      this.logger.error({ task: this.task.name, err: error }, 'retention sweep failed');
    } finally {
      this.running = false;
    }
  }
}
