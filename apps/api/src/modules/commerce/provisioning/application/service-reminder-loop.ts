import type { TenantContext } from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import type { ServiceReminderService } from './service-reminder.service.js';

/**
 * How often the reminder sweep runs.
 *
 * Fifteen minutes, and a constant rather than a config key for the reason
 * `PAYMENT_EXPIRY_INTERVAL_MS` gives: the policy knobs are the thresholds, and how
 * promptly this installation notices crossing one is an implementation detail. A second
 * knob would let an operator set a one-day reminder and a six-hour sweep, which is a
 * reminder that can arrive eighteen hours into the last day.
 *
 * Fifteen rather than the payment sweep's one, because the shortest threshold here is a
 * DAY, so a quarter hour is a sixtieth of it — while a pass that finds nothing costs two
 * indexed queries against `services` per tenant, and running them sixty times as often
 * would buy an accuracy nobody can perceive.
 */
export const SERVICE_REMINDER_INTERVAL_MS = 900_000;

/**
 * The timer that drives the expiry and usage reminder sweep, and the readiness it earns.
 *
 * Its OWN FILE for the reason `PaymentExpiryLoop`'s docblock gives:
 * `worker-health-coverage.test.ts` marks every class declared in a file containing an
 * `isFresh` as freshness-bearing, so a file holding one loop-bearing class and one that
 * is not is a file where "which of these must a role start" stops being answerable by
 * reading.
 *
 * It runs in the WORKER. Nothing here dials a panel — both halves read columns
 * `SYNC_USAGE` and the commercial actions already maintain — and the provisioner exists
 * precisely so that a wedged panel cannot delay work that needs no panel.
 *
 * Progress is recorded when a pass COMPLETES, including a pass that found nothing due,
 * which is the successful answer most of the time. A pass that THREW records nothing,
 * and that is the half that matters: a sweep whose every transaction fails is an
 * installation where nobody is warned before their service lapses, and the worker's
 * readiness is how that becomes visible instead of silent.
 */
export class ServiceReminderLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly progress: LoopProgress;

  constructor(
    private readonly sweep: ServiceReminderService,
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
   * ASYNC, and the await is the point, for the reason `PaymentExpiryLoop.stop` states:
   * the shutdown coordinator calls this and then closes the pool, so a synchronous stop
   * would pull the connection out from under a transaction that had already written
   * reminder rows. Nothing half-commits — the pass is atomic — but the work would be
   * lost and redone, with an error logged, on every rolling deploy.
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
   * still holding a transaction, and a second would contend for the same rows. It would
   * not double-send anything — the unique constraint on the occurrence is what decides
   * that — but it would spend a connection to discover so.
   *
   * Public so a test can drive exactly one pass and assert what it did. A test that
   * waits for a timer passes on a slow machine for the wrong reason.
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
       * has none — and an installation with no tenant has no services to remind anybody
       * about, so this loop is doing its job exactly.
       */
      if (scope === null) {
        this.progress.record(this.options.now());
        return;
      }
      const report = await this.sweep.runOnce(scope);
      if (report.expiry > 0 || report.usage > 0) {
        this.options.logger.info({ ...report }, 'raised service reminders');
      }
      this.progress.record(this.options.now());
    } catch (error: unknown) {
      /*
       * Swallowed so one bad pass does not kill the worker, and NOT recorded as
       * progress so readiness goes stale if every pass keeps failing. Those two
       * together are what make the heartbeat honest.
       */
      this.options.logger.error({ error }, 'service reminder sweep failed');
    } finally {
      this.running = false;
    }
  }
}
