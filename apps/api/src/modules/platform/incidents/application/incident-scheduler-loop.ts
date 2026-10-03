import type { TenantContext } from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import type { IncidentService } from './incident.service.js';

/**
 * The timer that starts scheduled maintenance windows (Phase E3), in the WORKER. Its own
 * file for the reason `BroadcastLoop` gives (`worker-health-coverage.test.ts`). Progress is
 * recorded when a pass completes, including one that started nothing.
 */
export class IncidentSchedulerLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly progress: LoopProgress;

  constructor(
    private readonly incidents: Pick<IncidentService, 'startDue'>,
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
    this.progress = new LoopProgress(Math.max(options.intervalMs * 3, 180_000));
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
      if (scope !== null) {
        const started = await this.incidents.startDue(scope);
        if (started > 0) this.options.logger.info({ started }, 'scheduled incidents started');
      }
      this.progress.record(this.options.now());
    } catch (error: unknown) {
      this.options.logger.error(
        { err: error instanceof Error ? error.name : 'unknown' },
        'incident scheduler pass failed',
      );
    } finally {
      this.running = false;
    }
  }
}
