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

  constructor(
    private readonly fx: Pick<FxService, 'refreshIfDue'>,
    private readonly options: {
      readonly scope: () => TenantContext | null;
      readonly baseAsset: FxBaseAsset;
      readonly intervalMs: number;
      readonly passBoundMs: number;
      readonly now: () => number;
      readonly logger: {
        info: (context: Record<string, unknown>, message: string) => void;
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
      const outcome = await this.fx.refreshIfDue(scope, this.options.baseAsset);
      if (outcome !== 'NOT_DUE' && outcome !== 'DISABLED') {
        this.options.logger.info({ outcome }, 'fx refresh pass');
      }
      this.progress.record(this.options.now());
    } catch (error) {
      this.options.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'fx refresh pass failed',
      );
    } finally {
      this.running = false;
    }
  }
}
