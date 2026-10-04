import type { TenantContext } from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import type { BusinessOutboundService } from './business-outbound.service.js';

/**
 * How often the business outbound lane runs. Short, because an operator pressing send in the
 * Web Admin is waiting to see the message leave; a pass with nothing due is one indexed read.
 */
export const BUSINESS_OUTBOUND_INTERVAL_MS = 3_000;

/**
 * TB2 — drives `BusinessOutboundService.deliverDue` in the worker, with
 * `CustomerNotificationLoop`'s shape and for its reasons: re-entrancy refused, `stop()` waits
 * for the pass in flight (a stop that returned mid-send would strand a stamped row), and
 * progress recorded only for a pass that completed, so readiness goes stale if every pass
 * fails.
 */
export class BusinessOutboundLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly progress: LoopProgress;

  constructor(
    private readonly lane: BusinessOutboundService,
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

  /** One pass. Public so a test drives exactly one. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const scope = this.options.scope();
      if (scope === null) {
        this.progress.record(this.options.now());
        return;
      }
      const report = await this.lane.deliverDue(scope);
      if (report.claimed > 0 || report.stranded > 0 || report.purged > 0) {
        this.options.logger.info({ ...report }, 'business outbound lane pass');
      }
      this.progress.record(this.options.now());
    } catch (error: unknown) {
      this.options.logger.error({ err: error }, 'business outbound lane pass failed');
    } finally {
      this.running = false;
    }
  }
}
