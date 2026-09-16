import type { TenantContext } from '@nexa/contracts';
import { CUSTOMER_NOTIFICATION_SWEEP_LIMIT } from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import type { CustomerNotificationService } from './customer-notification.service.js';

/**
 * The timer that drives the customer notification lane, and the readiness it earns.
 *
 * Its OWN FILE, not merely its own class, for the reason `ProvisionerLoop` and
 * `PaymentExpiryLoop` both give: `worker-health-coverage.test.ts` marks every class
 * declared in a file containing an `isFresh` as freshness-bearing, and a file holding
 * one loop-bearing class and one that is not is a file where "which of these must a role
 * start" stops being answerable by reading.
 *
 * It runs in the WORKER. It sends, so it must not share a process with anything holding
 * a business transaction — but it also must not be in the provisioner, whose whole
 * reason for existing is that a wedged panel cannot delay work needing no panel. A
 * notification needs no panel.
 *
 * Progress is recorded when a pass COMPLETES, including a pass that sent nothing.
 * "Nothing was due" is the healthy answer most of the time here, and a loop that only
 * counted non-empty passes would report a perfectly healthy installation stale within
 * minutes. A pass that THREW records nothing, which is the half that matters: a lane
 * whose every transaction fails is an installation where customers stop being told, and
 * the worker's readiness is how that becomes visible instead of silent.
 */

/**
 * How often the lane runs.
 *
 * A constant rather than a config key, and the same one minute
 * `PAYMENT_EXPIRY_INTERVAL_MS` uses. There is nothing an operator would tune it for:
 * every kind this lane carries is a fact the customer should already have, so the only
 * defensible cadence is "as promptly as is cheap", and a pass that finds nothing is one
 * indexed lookup against a partial index built for exactly this query.
 */
export const CUSTOMER_NOTIFICATION_INTERVAL_MS = 60_000;

export class CustomerNotificationLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly progress: LoopProgress;

  constructor(
    private readonly lane: CustomerNotificationService,
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

  /** Whether a pass has completed recently enough. See `LoopProgress`. */
  isFresh(nowMs: number): boolean {
    return this.progress.isFresh(nowMs);
  }

  start(): void {
    if (this.timer !== null) return;
    this.progress.begin(this.options.now());
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    // Never hold the event loop open for a housekeeping timer.
    this.timer.unref?.();
  }

  /**
   * Stops the timer and waits for a pass already in flight.
   *
   * ASYNC, and the await is the point — the same shape `PaymentExpiryLoop.stop` and
   * `RetentionSweeper.stop` have, and the container awaits all three. A synchronous stop
   * returns while a pass is mid-send, `container.shutdown()` closes the pool, and a row
   * that was stamped `send_started_at` but never recorded becomes a stranded send that
   * the next boot resolves to `UNCONFIRMED` — a customer silently not told, on every
   * rolling deploy.
   */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
    // A stopped loop makes no claim.
    this.progress.end();
  }

  /**
   * One pass.
   *
   * Re-entrancy is refused rather than queued: a pass that overran its interval is one
   * still sending, and a second would claim rows the first has leased.
   *
   * Public so a test can drive exactly one pass and assert what it did. A timer-driven
   * private tick can only be observed by waiting, and a test that waits for a loop
   * passes on a slow machine for the wrong reason.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const scope = this.options.scope();
      /*
       * No tenant yet is a healthy pass that did nothing.
       *
       * The installation's tenant is a ROW, so a worker booted before `pnpm provision`
       * has none — and an installation with no tenant has no customers to tell, so this
       * loop is doing its job exactly. Reporting it stale would make a fresh install
       * unhealthy for a reason the operator cannot act on.
       */
      if (scope === null) {
        this.progress.record(this.options.now());
        return;
      }
      const report = await this.lane.deliverDue(scope, CUSTOMER_NOTIFICATION_SWEEP_LIMIT);
      if (report.claimed > 0) {
        this.options.logger.info({ ...report }, 'customer notifications dispatched');
      }
      this.progress.record(this.options.now());
    } catch (error: unknown) {
      /*
       * Swallowed so one bad pass does not kill the worker, and NOT recorded as
       * progress so readiness goes stale if every pass keeps failing. Those two together
       * are what make the heartbeat honest.
       */
      this.options.logger.error({ err: error }, 'customer notification pass failed');
    } finally {
      this.running = false;
    }
  }
}
