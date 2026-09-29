import type { TenantContext } from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';

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
  private readonly lastRunAt = new Map<string, number>();

  constructor(
    private readonly sweeps: readonly CustomerReminderSweep[],
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

  /** Whether a tick has completed recently enough. See `LoopProgress`. */
  isFresh(nowMs: number): boolean {
    return this.progress.isFresh(nowMs);
  }

  start(): void {
    if (this.timer !== null) return;
    this.progress.begin(this.options.now());
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref?.();
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
      const scope = this.options.scope();
      if (scope === null) {
        this.progress.record(this.options.now());
        return;
      }
      let failed = false;
      for (const sweep of this.sweeps) {
        const at = this.options.now();
        const last = this.lastRunAt.get(sweep.name);
        if (last !== undefined && at - last < sweep.everyMs) continue;
        try {
          const told = await sweep.runOnce(scope);
          this.lastRunAt.set(sweep.name, at);
          if (told > 0) this.options.logger.info({ sweep: sweep.name, told }, 'queued reminders');
        } catch (error: unknown) {
          failed = true;
          this.options.logger.error({ error, sweep: sweep.name }, 'customer reminder sweep failed');
        }
      }
      if (!failed) this.progress.record(this.options.now());
    } finally {
      this.running = false;
    }
  }
}
