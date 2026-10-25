import type { TenantContext } from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import type { NightlyReportService } from './nightly-report.service.js';
import { guardedTick } from '../../../../infrastructure/lifecycle/loop-guard.js';

/**
 * How often the nightly report pass runs. A minute: a pass that finds nothing due costs the
 * settings reads and, once a report's time has come, one indexed lookup per enabled type, and
 * the report time is given to the minute (`ops.log.nightly_report_time`).
 */
export const NIGHTLY_REPORT_INTERVAL_MS = 60_000;

/**
 * The timer that drives the nightly reports, and the readiness it earns.
 *
 * Its OWN FILE, for the reason `ServiceReminderLoop` gives: `worker-health-coverage.test.ts`
 * marks every class in a file that declares `isFresh` as freshness-bearing. It runs in the
 * WORKER and dials nothing — every figure is a read of the ledger and the orders.
 *
 * Progress is recorded when a pass COMPLETES, including one that found nothing due — the
 * successful answer almost all of the time. A pass that THREW records nothing, so a report
 * that stopped being posted makes the worker report itself stale instead of staying silent.
 */
export class NightlyReportLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly progress: LoopProgress;

  constructor(
    private readonly reports: NightlyReportService,
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
    this.timer = setInterval(
      guardedTick('nightly-reports', () => this.tick(), this.options.logger),
      this.options.intervalMs,
    );
    this.timer.unref?.();
  }

  /** Stops the timer and waits for a pass already inside its transaction. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
    this.progress.end();
  }

  /** One pass; public so a test can drive exactly one. Re-entrancy is refused, not queued. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const scope = this.options.scope();
      // No tenant yet is a healthy pass that did nothing: there is nothing to report on.
      if (scope === null) {
        this.progress.record(this.options.now());
        return;
      }
      const queued = await this.reports.runOnce(scope);
      if (queued > 0) this.options.logger.info({ queued }, 'queued the nightly reports');
      this.progress.record(this.options.now());
    } catch (error: unknown) {
      this.options.logger.error({ error }, 'nightly report pass failed');
    } finally {
      this.running = false;
    }
  }
}
