import type { TenantContext, TenantId } from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import { guardedTick } from '../../../../infrastructure/lifecycle/loop-guard.js';
import {
  forEachLoopTenant,
  isReportedTenantFailure,
  reportedTenantFailure,
  type LoopTenantScope,
} from '../../../../infrastructure/lifecycle/tenant-pass.js';
import { phasedSweepDue } from '../../../platform/capacity/domain/schedule-offset.js';

/**
 * How often the loop wakes.
 *
 * One minute, the payment expiry sweep's cadence and for its reason: the pending-payment
 * reminder's lead is measured in MINUTES (at least one, ten by default), and a sweep that
 * woke every fifteen would deliver a ten-minute warning after the window had closed.
 */
export const CUSTOMER_REMINDER_INTERVAL_MS = 60_000;

/** One sweep the loop drives, and the least time between two of its passes. */
export interface CustomerReminderSweep {
  readonly name: string;
  /**
   * At most one pass per this many milliseconds. The wallet sweep derives running balances
   * over the tenant's ledger, so it runs every fifteen minutes rather than every minute; a
   * fall below a threshold is not a deadline, and a quarter hour is prompt for it.
   */
  readonly everyMs: number;
  /** One pass. Returns how many customers it told, for the log. */
  runOnce(scope: TenantContext): Promise<number>;
}

/**
 * WP-A9: the timer that drives the pending-payment and wallet low-balance reminders.
 *
 * Its OWN FILE for the reason `ServiceReminderLoop`'s docblock gives
 * (`worker-health-coverage.test.ts` marks every class in a file containing `isFresh`).
 * It runs in the WORKER: nothing here dials a panel or Telegram — both sweeps read the
 * database and enqueue onto the customer notification lane, which sends later, outside
 * every transaction.
 *
 * Progress is recorded when a tick COMPLETES, including a tick in which nothing was due
 * and a tick in which a sweep was skipped because its own interval had not elapsed. A tick
 * in which any sweep THREW records nothing, so a lane whose every pass fails turns the
 * worker's readiness stale instead of failing in silence.
 *
 * The per-sweep interval is decided in-process, and that is safe here for the reason it
 * would not be for a probe: it decides only HOW OFTEN a sweep looks, never WHETHER a
 * customer is told. Every "told once" is a unique key in the database, so two replicas
 * running both sweeps on the same minute is the ordinary rolling-update case and costs one
 * redundant query.
 */
export class CustomerReminderLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly progress: LoopProgress;
  /**
   * When each sweep last ran, PER TENANT (Phase 6A PR-6): one loop serves every active bot,
   * and one bot's pass must never consume another bot's due time.
   */
  private readonly lastRunAt = new Map<TenantId, Map<string, number>>();

  constructor(
    private readonly sweeps: readonly CustomerReminderSweep[],
    private readonly options: {
      /** Phase 6A PR-6: every active tenant's pass (`TenantFanOut`), or one fixed scope. */
      readonly scope: LoopTenantScope;
      readonly intervalMs: number;
      readonly now: () => number;
      /**
       * Phase 6A PR-2: the bot's own phase within each sweep's interval
       * (`scheduleOffsetMs`), so fifty bots' sweeps do not all fire the same minute. 0 (the
       * owner's own bot, and the default) keeps "every `everyMs` since the last run".
       */
      readonly offsetMs?: (scope: TenantContext, sweep: string, everyMs: number) => number;
      readonly logger: {
        info: (context: Record<string, unknown>, message: string) => void;
        error: (context: Record<string, unknown>, message: string) => void;
      };
    },
  ) {
    this.progress = new LoopProgress(options.intervalMs);
  }

  /** Whether a tick has completed recently enough. See `LoopProgress`. */
  isFresh(nowMs: number): boolean {
    return this.progress.isFresh(nowMs);
  }

  start(): void {
    if (this.timer !== null) return;
    this.progress.begin(this.options.now());
    this.timer = setInterval(
      guardedTick('customer-reminders', () => this.tick(), this.options.logger),
      this.options.intervalMs,
    );
    this.timer.unref?.();
  }

  private lastRunOf(tenantId: TenantId): Map<string, number> {
    let runs = this.lastRunAt.get(tenantId);
    if (runs === undefined) {
      runs = new Map<string, number>();
      this.lastRunAt.set(tenantId, runs);
    }
    return runs;
  }

  /** Stops the timer and waits for a tick already inside a transaction. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
    this.progress.end();
  }

  /**
   * One tick: every sweep whose own interval has elapsed, in order.
   *
   * Each sweep is its own try, so one failing lane does not starve the other; the tick is
   * recorded as progress only if none of them threw. Public so a test drives exactly one.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Once per tenant (Phase 6A PR-6); no tenant yet is a healthy tick that did nothing.
      await forEachLoopTenant(this.options.scope, async (scope) => {
        const lastRunAt = this.lastRunOf(scope.tenantId);
        let failed = false;
        for (const sweep of this.sweeps) {
          const at = this.options.now();
          const last = lastRunAt.get(sweep.name);
          const offset = this.options.offsetMs?.(scope, sweep.name, sweep.everyMs) ?? 0;
          if (offset === 0) {
            if (last !== undefined && at - last < sweep.everyMs) continue;
          } else if (!phasedSweepDue(at, last ?? null, sweep.everyMs, offset)) {
            continue;
          }
          try {
            const told = await sweep.runOnce(scope);
            lastRunAt.set(sweep.name, at);
            if (told > 0) {
              this.options.logger.info(
                { tenantId: scope.tenantId, sweep: sweep.name, told },
                'queued reminders',
              );
            }
          } catch (error: unknown) {
            failed = true;
            this.options.logger.error(
              { tenantId: scope.tenantId, error, sweep: sweep.name },
              'customer reminder sweep failed',
            );
          }
        }
        // Logged above, sweep by sweep; this tenant's tick is not progress.
        if (failed) throw reportedTenantFailure('a customer reminder sweep failed');
      });
      this.progress.record(this.options.now());
    } catch (error: unknown) {
      if (!isReportedTenantFailure(error)) {
        this.options.logger.error({ error }, 'customer reminder tick failed');
      }
    } finally {
      this.running = false;
    }
  }
}
