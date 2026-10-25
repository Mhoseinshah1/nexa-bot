import type { FxBaseAsset, TenantContext } from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import type { FxService } from './fx.service.js';

/**
 * How often the worker asks whether the central rate is due a refresh. The POLICY knob
 * is `fx.fresh_ttl_seconds`, which decides when a quote is due; this is only how
 * promptly the installation notices, and it is a fraction of the shortest TTL an
 * operator may configure so a quote is never seen as fresh for long after it is not.
 */
export const FX_REFRESH_INTERVAL_MS = 10_000;

/**
 * How long the loop waits before its next DIAL after N consecutive failed passes: the
 * first failure retries at the normal interval, then 30 s, 1 m, 5 m and 10 m, the last
 * being the cap. A stored quote or a pass that found nothing due resets it. A ticking
 * timer still runs every interval and records progress; only the dialling is spaced.
 *
 * In-process state, on purpose: this loop has one writer per process, the lease on the
 * quote row is what serialises replicas, and a restart that forgets the streak merely
 * dials once at the normal interval and backs off again. Per-SOURCE backoff, which must
 * agree across replicas, is stored (`FX_SOURCE_BACKOFF_MS` in the service).
 */
export const FX_REFRESH_BACKOFF_MS: readonly number[] = [
  FX_REFRESH_INTERVAL_MS,
  30_000,
  60_000,
  300_000,
  600_000,
];

/** Slack: the longest a pass may take (both sources, each its whole timeout) plus three intervals. */
export function fxLoopSlackIntervals(intervalMs: number, passBoundMs: number): number {
  return Math.ceil(passBoundMs / intervalMs) + 3;
}

/**
 * The timer that keeps the central exchange rate fresh, and the readiness it earns
 * (package FX). Its own file for the reason `PaymentExpiryLoop` gives:
 * `worker-health-coverage.test.ts` marks every class in a file holding an `isFresh`.
 *
 * It runs in the WORKER, the one role that dials providers on a timer. A pass that found
 * the quote still fresh, or the feature off, is a completed pass and records progress:
 * "nothing was due" is the healthy answer most of the time. A pass that threw records
 * nothing, so a lane whose every pass fails goes stale and the worker's readiness says so.
 */
export class FxRefreshLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly progress: LoopProgress;
  private failureStreak = 0;
  /** True while the last dialled pass threw: backoff skips then do not count as progress. */
  private lastPassThrew = false;
  private nextDialAt = 0;
  /** The delay last warned about, so a warning is written once per backoff step. */
  private warnedDelayMs: number | null = null;

  constructor(
    private readonly fx: Pick<FxService, 'refreshIfDue'>,
    private readonly options: {
      readonly scope: () => TenantContext | null;
      readonly baseAsset: FxBaseAsset;
      readonly intervalMs: number;
      readonly passBoundMs: number;
      readonly now: () => number;
      /** Wait after the Nth consecutive failed pass; the last entry is the cap. */
      readonly backoffMs?: readonly number[];
      readonly logger: {
        info: (context: Record<string, unknown>, message: string) => void;
        warn?: (context: Record<string, unknown>, message: string) => void;
        error: (context: Record<string, unknown>, message: string) => void;
      };
    },
  ) {
    this.progress = new LoopProgress(
      options.intervalMs,
      fxLoopSlackIntervals(options.intervalMs, options.passBoundMs),
    );
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

  private backOff(reason: string | null): void {
    const steps = this.options.backoffMs ?? FX_REFRESH_BACKOFF_MS;
    this.failureStreak += 1;
    const delayMs =
      steps[Math.min(this.failureStreak, steps.length) - 1] ?? this.options.intervalMs;
    this.nextDialAt = this.options.now() + delayMs;
    // At most one warning per backoff step; the operational log carries the outage itself.
    if (this.warnedDelayMs === delayMs) return;
    this.warnedDelayMs = delayMs;
    // Called ON the logger, never detached from it: `(logger.warn ?? logger.info)(…)` called
    // the method with no `this`, PinoLogger's `this.emit` threw, and v0.8.2's worker
    // crash-looped on the first failed pass (tests/unit/fx-refresh-loop-real-logger.test.ts).
    const context = {
      outcome: 'FAILED',
      reason,
      consecutiveFailures: this.failureStreak,
      nextAttemptInMs: delayMs,
    };
    const { logger } = this.options;
    if (logger.warn !== undefined) logger.warn(context, 'fx refresh failing; backing off');
    else logger.info(context, 'fx refresh failing; backing off');
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
      if (this.options.now() < this.nextDialAt) {
        // Backing off after a reported failure is a completed pass that dialled nothing.
        // After a THROWN pass it is not: the loop must keep reading as stale.
        if (!this.lastPassThrew) this.progress.record(this.options.now());
        return;
      }
      const { outcome, reason } = await this.fx.refreshIfDue(scope, this.options.baseAsset);
      this.lastPassThrew = false;
      if (outcome === 'FAILED') {
        this.backOff(reason);
      } else {
        this.failureStreak = 0;
        this.nextDialAt = 0;
        this.warnedDelayMs = null;
        if (outcome !== 'NOT_DUE' && outcome !== 'DISABLED') {
          this.options.logger.info({ outcome, reason }, 'fx refresh pass');
        }
      }
      this.progress.record(this.options.now());
    } catch (error) {
      // A pass that THROWS backs off exactly like one that reports FAILED, and logs once per
      // step: otherwise a persistent fault dials and logs every tick.
      this.lastPassThrew = true;
      this.backOff(error instanceof Error ? error.message : String(error));
    } finally {
      this.running = false;
    }
  }
}
