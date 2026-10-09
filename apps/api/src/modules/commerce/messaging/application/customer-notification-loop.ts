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
 * TWO SECONDS (FIX-03, 2026-10-09). It was one minute — "the same one minute
 * `PAYMENT_EXPIRY_INTERVAL_MS` uses" — and that minute is what the owner read between
 * «your payment was approved by the gateway» and the message with the amount and the
 * tracking code. The approval is the gateway worker's edit of the invoice message, made in
 * the pass that committed the credit; the amount is `WALLET_TOPUP_CREDITED`, enqueued in
 * the credit's own transaction and due at once, and it then waited up to a whole interval
 * for this timer. Every kind this lane carries is a fact the customer should already have,
 * so "as promptly as is cheap" was always the rule; a minute was simply not prompt.
 *
 * Still a constant rather than a config key: there is nothing an operator would tune it
 * for. The gateway lane runs every three seconds and the broadcast lane every second; an
 * idle pass here is a handful of indexed statements against partial indexes built for
 * exactly these queries (`docs/payment-settlement-latency.md` counts them). Faster than the
 * gateway lane, so the final message follows the approval it confirms rather than trailing
 * it by a gateway interval.
 *
 * What it does NOT change: the lane's health tolerance (`CUSTOMER_NOTIFICATION_STALE_AFTER_MS`),
 * the retry back-off, the 429 rule (the later of Telegram's `retry_after` and the back-off),
 * the lease, or the rule that an unknown send is never repeated. Those are per row, not per
 * pass, and none of them was ever derived from this number.
 */
export const CUSTOMER_NOTIFICATION_INTERVAL_MS = 2_000;

/**
 * How long the lane may go without completing a pass before the worker reports it stalled:
 * three minutes, which is what three one-minute intervals always gave it.
 *
 * Stated in TIME, not in intervals, so the faster cadence above does not shrink it. A pass
 * sends its batch one message after another, and a backlog after an outage can hold one
 * pass for a minute; three two-second intervals would call that a stalled loop, stop the
 * heartbeat and roll a healthy release back — the failure `gatewayLoopSlackIntervals`
 * exists to avoid for the gateway lane.
 */
export const CUSTOMER_NOTIFICATION_STALE_AFTER_MS = 180_000;

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
    this.progress = new LoopProgress(
      options.intervalMs,
      Math.max(1, Math.ceil(CUSTOMER_NOTIFICATION_STALE_AFTER_MS / options.intervalMs)),
    );
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
