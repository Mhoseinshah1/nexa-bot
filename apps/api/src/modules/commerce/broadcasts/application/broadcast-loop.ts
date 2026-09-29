import type { TenantContext } from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import type { BroadcastDispatcher } from './broadcast-dispatcher.js';

/**
 * How often the broadcast lane runs: every second, because its pacing is per second
 * (`BROADCAST_SENDS_PER_SECOND` per bot, shared across replicas through the pacing row). A
 * pass that finds nothing is two indexed lookups against partial indexes built for them.
 */
export const BROADCAST_INTERVAL_MS = 1_000;

/**
 * The timer that drives the broadcast lane (round N), in its own file for the reason
 * `CustomerNotificationLoop` gives: `worker-health-coverage.test.ts` marks every class in a
 * file containing an `isFresh` as freshness-bearing.
 *
 * It runs in the WORKER: it sends, and needs no panel. Progress is recorded when a pass
 * COMPLETES, including one that sent nothing; a pass that threw records nothing, so a lane
 * whose every pass fails makes the worker unhealthy instead of silently not broadcasting.
 */
export class BroadcastLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly progress: LoopProgress;

  constructor(
    private readonly dispatcher: BroadcastDispatcher,
    private readonly options: {
      readonly scope: () => TenantContext | null;
      readonly intervalMs: number;
      readonly now: () => number;
      readonly logger: {
        info: (context: Record<string, unknown>, message: string) => void;
        error: (context: Record<string, unknown>, message: string) => void;
      };
    },
  ) {
    this.progress = new LoopProgress(Math.max(options.intervalMs, 60_000));
  }

  isFresh(nowMs: number): boolean {
    return this.progress.isFresh(nowMs);
  }

  start(): void {
    if (this.timer !== null) return;
    this.progress.begin(this.options.now());
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref?.();
  }

  /**
   * Stops the timer and waits for a pass in flight, so a stamped send is recorded rather than
   * left for the reaper to resolve UNCONFIRMED on every rolling deploy.
   */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
    this.progress.end();
  }

  /** One pass; re-entrancy refused, public so a test drives exactly one. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const scope = this.options.scope();
      if (scope === null) {
        this.progress.record(this.options.now());
        return;
      }
      const report = await this.dispatcher.pass(scope);
      if (report.claimed + report.started + report.completed + report.reaped > 0) {
        this.options.logger.info({ ...report }, 'broadcast pass');
      }
      this.progress.record(this.options.now());
    } catch (error: unknown) {
      this.options.logger.error(
        { err: error instanceof Error ? error.name : 'unknown' },
        'broadcast pass failed',
      );
    } finally {
      this.running = false;
    }
  }
}
