import type { TenantContext } from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import type { PaymentExpiryService } from './payment-expiry.service.js';

/**
 * The timer that drives the payment and order expiry sweep, and the readiness it earns.
 *
 * Its OWN FILE, not merely its own class, for the reason `ProvisionerLoop`'s docblock
 * gives: `worker-health-coverage.test.ts` marks every class declared in a file
 * containing an `isFresh` as freshness-bearing, and a file holding one loop-bearing
 * class and one that is not is a file where "which of these must a role start" stops
 * being answerable by reading.
 *
 * It runs in the WORKER rather than the provisioner. Nothing here dials anything: the
 * sweep is two conditional UPDATEs and an audit row per moved row, and the provisioner
 * exists precisely so that a wedged panel cannot delay work that needs no panel.
 *
 * Progress is recorded when a pass COMPLETES, including a pass that moved nothing —
 * unlike the provisioner, whose `IDLE` is a signal to sleep rather than a claim about
 * health. Here "there was nothing due" is the successful answer most of the time, and a
 * loop that only counted non-empty passes would report a perfectly healthy installation
 * with no expiring orders as stale within minutes.
 *
 * A pass that THREW records nothing, which is the half that matters: a sweep whose
 * every transaction fails is an installation where orders stop expiring, and the
 * worker's readiness is how that becomes visible instead of silent.
 */
/**
 * How often the sweep runs.
 *
 * A constant rather than a config key, and one minute rather than the hour the
 * identity sweepers use. `PAYMENT_WINDOW_MINUTES_MIN` is five, so a one-minute cadence
 * means a closed payment is never seen as live for more than a fifth of the shortest
 * window an operator is allowed to configure — and the cost of a pass that finds
 * nothing is two indexed lookups against partial indexes built for exactly this query.
 *
 * Not configurable because there is nothing an operator would tune it for: the policy
 * knob is `sales.payment_window_minutes`, which decides WHEN a payment is due to close.
 * How promptly this installation notices is an implementation detail, and a second knob
 * would let an operator set an hour's window and a two-hour sweep, which is a window of
 * ninety minutes wearing the label of one hour.
 */
export const PAYMENT_EXPIRY_INTERVAL_MS = 60_000;

export class PaymentExpiryLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly progress: LoopProgress;

  constructor(
    private readonly sweep: PaymentExpiryService,
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
   * Stops the timer and waits for a pass already inside its transaction.
   *
   * ASYNC, and the await is the point. SIGTERM arrives, the shutdown coordinator calls
   * this and then `container.shutdown()` closes the pool — so a synchronous stop leaves
   * an expiry transaction holding a connection that is about to be pulled out from
   * under it. The transaction is atomic, so nothing half-writes; what happens is that a
   * pass which had already moved rows loses them, logs an error on the way out, and the
   * work waits for the next boot. On every rolling deploy.
   *
   * `RetentionSweeper.stop` is the same shape for the same reason, and the container
   * awaits it. The provisioner's loop is synchronous, which is a difference this file
   * is not the place to resolve: that process is structured around a provider call that
   * may outlive any shutdown budget, and this one is two statements against the
   * database.
   */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Let an in-flight pass commit rather than having its connection closed under it.
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
    // A stopped loop makes no claim. `LoopProgress.end` is what stops a draining
    // worker looking like a working one for a whole slack window.
    this.progress.end();
  }

  /**
   * One pass.
   *
   * Re-entrancy is refused rather than queued: a pass that overran its interval is one
   * still holding a transaction, and a second would contend for the same rows. It would
   * not double-expire anything — every statement names its source state — but it would
   * spend a connection to discover that.
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
       * No tenant yet is a healthy pass that did nothing, not a failure.
       *
       * The installation's tenant is a ROW, so a worker booted before `pnpm provision`
       * has none — and an installation with no tenant has no payments to expire, so
       * this loop is doing its job exactly. Reporting it stale would make a fresh
       * install unhealthy for a reason the operator cannot act on, which is the
       * "different lie" `LoopProgress` names.
       */
      if (scope === null) {
        this.progress.record(this.options.now());
        return;
      }
      const report = await this.sweep.runOnce(scope);
      if (report.payments > 0 || report.orders > 0) {
        this.options.logger.info({ ...report }, 'expired unpaid payments and orders');
      }
      this.progress.record(this.options.now());
    } catch (error: unknown) {
      /*
       * Swallowed so one bad pass does not kill the worker, and NOT recorded as
       * progress so readiness goes stale if every pass keeps failing. Those two
       * together are what make the heartbeat honest — `ProvisionerLoop` states the
       * same pair.
       */
      this.options.logger.error({ error }, 'payment expiry sweep failed');
    } finally {
      this.running = false;
    }
  }
}
