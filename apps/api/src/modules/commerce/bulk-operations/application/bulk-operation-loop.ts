import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import type { BulkOperationProcessor } from './bulk-operation-processor.js';
import { guardedTick } from '../../../../infrastructure/lifecycle/loop-guard.js';
import {
  forEachLoopTenant,
  type LoopTenantScope,
} from '../../../../infrastructure/lifecycle/tenant-pass.js';

/**
 * How often the mass-operation lane runs. Each pass processes up to `BULK_PASS_LIMIT` items,
 * each in its own transaction, then settles grants whose provider operation ended.
 */
export const BULK_OPERATION_INTERVAL_MS = 5_000;

/**
 * The timer that drives the mass-operation lane (round N, B2), in its own file for the reason
 * `CustomerNotificationLoop` gives. It runs in the WORKER: it writes ledger entries and PLANS
 * provisioning operations; the provisioner role executes them. Progress is recorded when a
 * pass completes, so a lane whose every pass fails makes the worker unhealthy.
 */
export class BulkOperationLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly progress: LoopProgress;

  constructor(
    private readonly processor: BulkOperationProcessor,
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
    this.progress = new LoopProgress(Math.max(options.intervalMs, 60_000));
  }

  isFresh(nowMs: number): boolean {
    return this.progress.isFresh(nowMs);
  }

  start(): void {
    if (this.timer !== null) return;
    this.progress.begin(this.options.now());
    this.timer = setInterval(
      guardedTick('bulk-operations', () => this.tick(), this.options.logger),
      this.options.intervalMs,
    );
    this.timer.unref?.();
  }

  /** Stops the timer and waits for a pass in flight: an item's transaction commits or not. */
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
      // Once per tenant (Phase 6A PR-6); no tenant yet is a healthy pass that did nothing.
      await forEachLoopTenant(this.options.scope, async (scope) => {
        const report = await this.processor.pass(scope);
        if (
          report.credited + report.planned + report.skipped + report.settled + report.completed >
          0
        ) {
          this.options.logger.info({ tenantId: scope.tenantId, ...report }, 'bulk operation pass');
        }
      });
      this.progress.record(this.options.now());
    } catch (error: unknown) {
      this.options.logger.error(
        { err: error instanceof Error ? error.name : 'unknown' },
        'bulk operation pass failed',
      );
    } finally {
      this.running = false;
    }
  }
}
