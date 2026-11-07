import type { FxBaseAsset, TenantContext, TenantId } from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import type { FxService } from './fx.service.js';
import { guardedTick } from '../../../../infrastructure/lifecycle/loop-guard.js';
import {
  forEachLoopTenant,
  isReportedTenantFailure,
  reportedTenantFailure,
  type LoopTenantScope,
} from '../../../../infrastructure/lifecycle/tenant-pass.js';

/** One tenant's dial back-off (Phase 6A PR-6: one per tenant, never shared). */
interface FxBackoffState {
  failureStreak: number;
  /** True while the last dialled pass threw: backoff skips then do not count as progress. */
  lastPassThrew: boolean;
  nextDialAt: number;
  /** The delay last warned about, so a warning is written once per backoff step. */
  warnedDelayMs: number | null;
}

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
  /**
   * The back-off, per tenant (Phase 6A PR-6): one bot's failing sources must not space out
   * another bot's dials, nor its recovery reset another's streak.
   */
  private readonly backoff = new Map<TenantId, FxBackoffState>();

  constructor(
    private readonly fx: Pick<FxService, 'refreshIfDue'>,
    private readonly options: {
      /** Phase 6A PR-6: every active tenant's pass (`TenantFanOut`), or one fixed scope. */
      readonly scope: LoopTenantScope;
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
    this.timer = setInterval(
      guardedTick('fx-refresh', () => this.tick(), this.options.logger),
      this.options.intervalMs,
    );
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

  private stateOf(tenantId: TenantId): FxBackoffState {
    let state = this.backoff.get(tenantId);
    if (state === undefined) {
      state = { failureStreak: 0, lastPassThrew: false, nextDialAt: 0, warnedDelayMs: null };
      this.backoff.set(tenantId, state);
    }
    return state;
  }

  private backOff(scope: TenantContext, state: FxBackoffState, reason: string | null): void {
    const steps = this.options.backoffMs ?? FX_REFRESH_BACKOFF_MS;
    state.failureStreak += 1;
    const delayMs =
      steps[Math.min(state.failureStreak, steps.length) - 1] ?? this.options.intervalMs;
    state.nextDialAt = this.options.now() + delayMs;
    // At most one warning per backoff step; the operational log carries the outage itself.
    if (state.warnedDelayMs === delayMs) return;
    state.warnedDelayMs = delayMs;
    // Called ON the logger, never detached from it: `(logger.warn ?? logger.info)(…)` called
    // the method with no `this`, PinoLogger's `this.emit` threw, and v0.8.2's worker
    // crash-looped on the first failed pass (tests/unit/fx-refresh-loop-real-logger.test.ts).
    const context = {
      tenantId: scope.tenantId,
      outcome: 'FAILED',
      reason,
      consecutiveFailures: state.failureStreak,
      nextAttemptInMs: delayMs,
    };
    const { logger } = this.options;
    if (logger.warn !== undefined) logger.warn(context, 'fx refresh failing; backing off');
    else logger.info(context, 'fx refresh failing; backing off');
  }

  /**
   * One tenant's pass. Throws (a reported failure: already backed off and warned about) when
   * this tenant's pass is not progress — a dial that threw, or a back-off skip after one.
   */
  private async passFor(scope: TenantContext): Promise<void> {
    const state = this.stateOf(scope.tenantId);
    if (this.options.now() < state.nextDialAt) {
      // Backing off after a reported failure is a completed pass that dialled nothing.
      // After a THROWN pass it is not: the loop must keep reading as stale.
      if (state.lastPassThrew) throw reportedTenantFailure('fx refresh backing off after a throw');
      return;
    }
    let result: Awaited<ReturnType<FxService['refreshIfDue']>>;
    try {
      result = await this.fx.refreshIfDue(scope, this.options.baseAsset);
    } catch (error) {
      // A pass that THROWS backs off exactly like one that reports FAILED, and logs once per
      // step: otherwise a persistent fault dials and logs every tick.
      state.lastPassThrew = true;
      this.backOff(scope, state, error instanceof Error ? error.message : String(error));
      throw reportedTenantFailure('fx refresh pass threw');
    }
    const { outcome, reason } = result;
    state.lastPassThrew = false;
    if (outcome === 'FAILED') {
      this.backOff(scope, state, reason);
    } else {
      state.failureStreak = 0;
      state.nextDialAt = 0;
      state.warnedDelayMs = null;
      if (outcome !== 'NOT_DUE' && outcome !== 'DISABLED') {
        this.options.logger.info({ tenantId: scope.tenantId, outcome, reason }, 'fx refresh pass');
      }
    }
  }

  /** One pass. Re-entrancy is refused rather than queued. Public so a test can drive it. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Once per tenant (Phase 6A PR-6); no tenant yet is a healthy pass that did nothing.
      await forEachLoopTenant(this.options.scope, (scope) => this.passFor(scope));
      this.progress.record(this.options.now());
    } catch (error) {
      // A tenant's failure was backed off and warned about in `passFor`; anything else (the
      // read of the active tenants) is logged here. Neither is progress.
      if (!isReportedTenantFailure(error)) {
        this.options.logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          'fx refresh pass failed',
        );
      }
    } finally {
      this.running = false;
    }
  }
}
