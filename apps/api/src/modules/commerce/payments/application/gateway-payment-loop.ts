import type { TenantContext } from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import type { GatewayPaymentService } from './gateway-payment.service.js';

/**
 * How often the gateway lane runs (WP11A §5.7).
 *
 * Three seconds, because the customer is waiting for the first answer: they chose the
 * gateway and were told the invoice is being prepared. A pass that finds nothing is two
 * indexed lookups against partial indexes built for exactly these queries; a pass that
 * finds work is bounded by its batch sizes and by the tenant's per-minute call budget,
 * which is what actually protects the provider.
 */
export const GATEWAY_PAYMENT_INTERVAL_MS = 3_000;

/**
 * The timer that drives the external-gateway lane, and the readiness it earns.
 *
 * Its OWN FILE for the reason `PaymentExpiryLoop` gives (`worker-health-coverage.test.ts`
 * marks every class in a file containing `isFresh` as freshness-bearing). It runs in the
 * WORKER: the calls it makes are to a payment provider, outside every transaction, and
 * never while a customer's Telegram request waits.
 *
 * Progress is recorded when a pass COMPLETES, including one that did nothing; a pass
 * that threw records nothing, so a lane whose every pass fails goes stale and the
 * worker's readiness says so.
 */
export class GatewayPaymentLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly progress: LoopProgress;

  constructor(
    private readonly lane: GatewayPaymentService,
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

  /** Stops the timer and waits for a pass in flight, so its records are not cut off. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
    this.progress.end();
  }

  /** One pass. Re-entrancy is refused rather than queued. Public so a test can drive it. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const scope = this.options.scope();
      if (scope === null) {
        this.progress.record(this.options.now());
        return;
      }
      const report = await this.lane.runOnce(scope);
      if (
        report.created + report.createFailed + report.createUnknown + report.inquired > 0 ||
        report.budgetExhausted
      ) {
        this.options.logger.info({ ...report }, 'gateway payment pass');
      }
      this.progress.record(this.options.now());
    } catch (error: unknown) {
      this.options.logger.error(
        { error: error instanceof Error ? error.name : 'unknown' },
        'gateway payment pass failed',
      );
    } finally {
      this.running = false;
    }
  }
}
