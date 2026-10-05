import { SUPPORT_AI_LIMITS, type TenantContext } from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import type { SupportAssistService } from './support-assist.service.js';

export const ASSISTANT_INTERVAL_MS = 2_000;
/**
 * The worst case of producing ONE job: every step of the chain (the primary and up to
 * `maxFallbacks` fallbacks) timing out at the longest timeout the configuration allows.
 */
export const ASSISTANT_JOB_WORST_CASE_MS =
  (1 + SUPPORT_AI_LIMITS.maxFallbacks) * SUPPORT_AI_LIMITS.timeoutMs.max;
/**
 * A claimed job is leased for its worst case plus a margin (the context build, the transcript
 * read and the result write), so a second replica never re-claims a job still being produced
 * (PR #200 review, finding 4). Derived, so raising a bound raises the lease with it.
 */
export const ASSISTANT_LEASE_MS = ASSISTANT_JOB_WORST_CASE_MS + 2 * 60_000;
/** Jobs per pass, claimed and produced ONE at a time. */
export const ASSISTANT_BATCH = 4;
/** A job claimed this many times without a result is failed rather than retried for ever. */
export const ASSISTANT_MAX_ATTEMPTS = 3;
const RETENTION_INTERVAL_MS = 10 * 60_000;

/**
 * TB5 — the `assistant` process role's loop (ADR-0034 §7).
 *
 * Provider calls are outbound HTTPS with decrypted third-party keys and multi-second latency;
 * they run HERE, never in the api (a request thread) or the worker (the notification lanes),
 * for the reason the provisioner and the monitor are their own roles. The loop claims one
 * QUEUED job at a time with a lease, produces it OUTSIDE any transaction, and records the
 * result with a conditional write — a job discarded meanwhile is never resurrected. Every
 * write (claim, result, retention) checks scope activity in its own transaction.
 */
export class AssistantLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRetentionAt = 0;
  private reportedNoScope = false;
  private readonly progress: LoopProgress;

  constructor(
    private readonly assist: Pick<
      SupportAssistService,
      'claimNext' | 'produce' | 'abandon' | 'purgeExpired'
    >,
    private readonly options: {
      readonly scope: () => TenantContext | null;
      readonly intervalMs: number;
      readonly now: () => Date;
      readonly logger: {
        info: (context: Record<string, unknown>, message: string) => void;
        error: (context: Record<string, unknown>, message: string) => void;
      };
    },
  ) {
    // Progress is recorded after every job, and one job can take its worst case: a window
    // sized to the tick cadence (6 s) reported a working assistant as dead during any real
    // provider call (PR #200 review, finding 3). Sized like the incident scheduler's.
    this.progress = new LoopProgress(Math.max(options.intervalMs * 3, ASSISTANT_LEASE_MS), 1);
  }

  isFresh(nowMs: number): boolean {
    return this.progress.isFresh(nowMs);
  }

  start(): void {
    if (this.timer !== null) return;
    this.progress.begin(this.options.now().getTime());
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

  /** One pass. Public so a test drives exactly one. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const scope = this.options.scope();
      if (scope === null) {
        if (!this.reportedNoScope) {
          this.options.logger.info({}, 'assistant: no installation tenant yet; idle');
          this.reportedNoScope = true;
        }
        this.progress.record(this.options.now().getTime());
        return;
      }
      const counts: Record<string, number> = {};
      let claimed = 0;
      while (claimed < ASSISTANT_BATCH) {
        const at = this.options.now();
        const job = await this.assist.claimNext(
          scope,
          at,
          new Date(at.getTime() + ASSISTANT_LEASE_MS),
        );
        if (job === null) break;
        claimed += 1;
        // `attempts` already counts this claim: a job that keeps dying mid-call fails instead.
        const state =
          job.attempts > ASSISTANT_MAX_ATTEMPTS
            ? await this.assist.abandon(scope, job)
            : await this.assist.produce(scope, job);
        counts[state] = (counts[state] ?? 0) + 1;
        this.progress.record(this.options.now().getTime());
        if (state === 'INACTIVE') break;
      }
      const now = this.options.now();
      if (now.getTime() - this.lastRetentionAt >= RETENTION_INTERVAL_MS) {
        counts.purged = await this.assist.purgeExpired(scope, now);
        this.lastRetentionAt = now.getTime();
      }
      if (claimed > 0) this.options.logger.info({ claimed, ...counts }, 'assistant pass');
      this.progress.record(this.options.now().getTime());
    } catch (error: unknown) {
      this.options.logger.error({ err: error }, 'assistant pass failed');
    } finally {
      this.running = false;
    }
  }
}
