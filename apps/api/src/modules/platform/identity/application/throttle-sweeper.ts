import type { Clock, Logger } from '@nexa/contracts';
import type { LoginThrottleRepository } from './ports.js';

/**
 * Removes login-throttle rows nothing is counting any more.
 *
 * The throttle inserts a durable row for every previously unseen username or
 * IP, and resets an expired one only when that exact subject is used again. So
 * an unauthenticated caller submitting an endless stream of distinct usernames
 * — or arriving from a rotating IPv6 range — grows the table for good, and
 * nothing else ever removes those rows. A limiter that an attacker can turn
 * into unbounded storage is not much of a limiter.
 *
 * It runs in the WORKER rather than on the login path: sweeping there would put
 * a delete in front of every sign-in to solve a problem that is slow-moving by
 * nature. A row is only removed once its counting window has elapsed AND its
 * lockout has expired, so a sweep can never shorten a lockout somebody is
 * serving.
 */
export interface ThrottleSweeperOptions {
  /** How often to sweep. */
  readonly intervalMs: number;
  /** How long a finished row is kept before removal. */
  readonly retentionSeconds: number;
  /** Rows per sweep, so one pass stays short. */
  readonly batchSize: number;
}

export class ThrottleSweeper {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly throttle: LoginThrottleRepository,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly options: ThrottleSweeperOptions,
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
    // Let an in-flight sweep finish rather than leaving a half-done delete.
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  /** One pass. Exposed so a test can run it without waiting for the timer. */
  async sweep(): Promise<number> {
    return this.throttle.purgeExpired(
      this.clock.now(),
      this.options.retentionSeconds,
      this.options.batchSize,
    );
  }

  private async tick(): Promise<void> {
    // Overlapping sweeps would delete the same rows twice and achieve nothing.
    if (this.running) return;
    this.running = true;
    try {
      const removed = await this.sweep();
      if (removed > 0) this.logger.info({ removed }, 'expired login throttle rows removed');
    } catch (error) {
      // Housekeeping must never take the worker down: the next tick retries.
      this.logger.error({ err: error }, 'login throttle sweep failed');
    } finally {
      this.running = false;
    }
  }
}
