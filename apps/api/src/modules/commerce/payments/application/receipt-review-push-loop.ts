import type { TenantContext } from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import {
  RECEIPT_PUSH_SWEEP_LIMIT,
  type ReceiptReviewPushService,
} from './receipt-review-push.service.js';

/**
 * How often the receipt push lane looks for work. Shorter than the customer lane's minute: a
 * receipt is a person waiting for a reviewer, and the push is what tells the reviewer.
 */
export const RECEIPT_PUSH_INTERVAL_MS = 10_000;

/**
 * The timer around `ReceiptReviewPushService.deliverDue`, the `CustomerNotificationLoop`
 * shape: one pass at a time, a failed pass logged and the next one run, freshness reported to
 * the worker's health, and the installation's own tenant as the scope.
 */
export class ReceiptReviewPushLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly progress: LoopProgress;

  constructor(
    private readonly lane: ReceiptReviewPushService,
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
    this.progress = new LoopProgress(options.intervalMs);
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

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const scope = this.options.scope();
      if (scope === null) {
        this.progress.record(this.options.now());
        return;
      }
      const report = await this.lane.deliverDue(scope, RECEIPT_PUSH_SWEEP_LIMIT);
      if (report.claimed > 0 || report.reaped > 0) {
        this.options.logger.info({ ...report }, 'receipt pushes dispatched');
      }
      this.progress.record(this.options.now());
    } catch (error: unknown) {
      this.options.logger.error({ err: error }, 'receipt push pass failed');
    } finally {
      this.running = false;
    }
  }
}
