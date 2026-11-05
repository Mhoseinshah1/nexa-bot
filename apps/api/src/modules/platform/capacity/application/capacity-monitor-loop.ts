import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import { guardedTick } from '../../../../infrastructure/lifecycle/loop-guard.js';
import type { CapacityMonitor } from './capacity-monitor.js';

/** How often the server's disk, memory and worker lag are checked. */
export const CAPACITY_MONITOR_INTERVAL_MS = 60_000;

/**
 * The worker's timer over `CapacityMonitor`. Its own file because it carries `isFresh`
 * (`worker-health-coverage.test.ts`). A pass that threw records no progress, so a monitor
 * that cannot read the server goes stale rather than silent.
 */
export class CapacityMonitorLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly progress: LoopProgress;

  constructor(
    private readonly monitor: Pick<CapacityMonitor, 'check'>,
    private readonly options: {
      readonly intervalMs: number;
      readonly now: () => number;
      readonly quiesced: () => Promise<boolean>;
      readonly logger: {
        info: (context: Record<string, unknown>, message: string) => void;
        error: (context: Record<string, unknown>, message: string) => void;
      };
    },
  ) {
    this.progress = new LoopProgress(options.intervalMs);
  }

  isFresh(nowMs: number): boolean {
    return this.progress.isFresh(nowMs);
  }

  start(): void {
    if (this.timer !== null) return;
    this.progress.begin(this.options.now());
    this.timer = setInterval(
      guardedTick('capacity-monitor', () => this.tick(), this.options.logger),
      this.options.intervalMs,
    );
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
    this.progress.end();
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Idle during a recovery, like every lane that writes.
      if (!(await this.options.quiesced())) await this.monitor.check();
      this.progress.record(this.options.now());
    } catch (error: unknown) {
      this.options.logger.error({ err: error }, 'capacity monitor pass failed');
    } finally {
      this.running = false;
    }
  }
}
