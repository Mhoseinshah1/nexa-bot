import type { TenantContext } from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import {
  RECEIPT_PUSH_SWEEP_LIMIT,
  type ReceiptReviewPushService,
} from './receipt-review-push.service.js';
import { guardedTick } from '../../../../infrastructure/lifecycle/loop-guard.js';
import {
  forEachLoopTenant,
  isReportedTenantFailure,
  reportedTenantFailure,
  type LoopTenantScope,
} from '../../../../infrastructure/lifecycle/tenant-pass.js';

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
      /**
       * WP19: the refund-request review cards, driven by the same pass. The same lane shape
       * to the same administrators through the same bot, so it shares this timer and its
       * readiness rather than adding a second loop to the worker.
       */
      readonly refundRequests?: {
        deliverDue(
          scope: TenantContext,
          limit: number,
        ): Promise<{ readonly claimed: number; readonly reaped: number }>;
      };
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
    this.progress = new LoopProgress(options.intervalMs);
  }

  isFresh(nowMs: number): boolean {
    return this.progress.isFresh(nowMs);
  }

  start(): void {
    if (this.timer !== null) return;
    this.progress.begin(this.options.now());
    this.timer = setInterval(
      guardedTick('receipt-review-push', () => this.tick(), this.options.logger),
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
      // Once per tenant (Phase 6A PR-6); no tenant yet is a healthy pass that did nothing.
      await forEachLoopTenant(this.options.scope, async (scope) => {
        /*
         * The two lanes each run on their own (Codex review of #83, round 12). The refund
         * cards used to run after the receipts inside one `try`, so a receipt pass that failed
         * on every tick kept every refund card queued behind it, although the cards' own
         * repository and sender were healthy. A failure is logged under its own lane and still
         * costs the tick its progress, so readiness stays honest.
         */
        let failed = false;
        try {
          const report = await this.lane.deliverDue(scope, RECEIPT_PUSH_SWEEP_LIMIT);
          if (report.claimed > 0 || report.reaped > 0) {
            this.options.logger.info(
              { tenantId: scope.tenantId, ...report },
              'receipt pushes dispatched',
            );
          }
        } catch (error: unknown) {
          failed = true;
          this.options.logger.error(
            { tenantId: scope.tenantId, err: error },
            'receipt push pass failed',
          );
        }
        if (this.options.refundRequests !== undefined) {
          try {
            const cards = await this.options.refundRequests.deliverDue(
              scope,
              RECEIPT_PUSH_SWEEP_LIMIT,
            );
            if (cards.claimed > 0 || cards.reaped > 0) {
              this.options.logger.info(
                { tenantId: scope.tenantId, ...cards },
                'refund request cards dispatched',
              );
            }
          } catch (error: unknown) {
            failed = true;
            this.options.logger.error(
              { tenantId: scope.tenantId, err: error },
              'refund request card pass failed',
            );
          }
        }
        // Logged above, lane by lane; this tenant's pass is not progress.
        if (failed) throw reportedTenantFailure('a receipt review push lane failed');
      });
      this.progress.record(this.options.now());
    } catch (error: unknown) {
      if (!isReportedTenantFailure(error)) {
        this.options.logger.error({ err: error }, 'receipt push pass failed');
      }
    } finally {
      this.running = false;
    }
  }
}
