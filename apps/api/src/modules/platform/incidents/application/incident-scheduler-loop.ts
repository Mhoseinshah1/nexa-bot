import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import type { IncidentService } from './incident.service.js';
import { guardedTick } from '../../../../infrastructure/lifecycle/loop-guard.js';
import {
  forEachLoopTenant,
  type LoopTenantScope,
} from '../../../../infrastructure/lifecycle/tenant-pass.js';

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
      /** Phase 6A PR-6: every active tenant's pass (`TenantFanOut`), or one fixed scope. */
      readonly scope: LoopTenantScope;
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
    this.timer = setInterval(
      guardedTick('incident-scheduler', () => this.tick(), this.options.logger),
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

  /** One pass; re-entrancy refused, public so a test drives exactly one. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Once per tenant (Phase 6A PR-6): an incident is a tenant's own record.
      await forEachLoopTenant(this.options.scope, async (scope) => {
        const started = await this.incidents.startDue(scope);
        if (started > 0) {
          this.options.logger.info(
            { tenantId: scope.tenantId, started },
            'scheduled incidents started',
          );
        }
      });
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
