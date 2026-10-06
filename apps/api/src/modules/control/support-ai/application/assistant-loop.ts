import {
  SUPPORT_AI_LIMITS,
  SUPPORT_AI_VISION_FETCH_TIMEOUT_MS,
  SUPPORT_AI_VISION_MAX_IMAGES,
  type SupportAiJobKind,
  type TenantContext,
} from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import type { SupportAssistService } from './support-assist.service.js';
import type { SupportAutoReplyService } from './support-auto-reply.service.js';
import type { SupportLearningService } from '../../support-knowledge/application/support-learning.service.js';
import {
  SUPPORT_ASSISTANT_WATCH_INTERVAL_MS,
  type SupportAssistantLiveness,
} from './assistant-watch.js';

export const ASSISTANT_INTERVAL_MS = 2_000;
/** The bounds a job's worst case is derived from. */
export interface AssistantJobBounds {
  /** Fallbacks after the primary step. */
  readonly maxFallbacks: number;
  /** The longest provider timeout the configuration allows. */
  readonly providerTimeoutMs: number;
  /** TB6: customer images fetched per job, each in two Telegram legs (`getFile`, the file). */
  readonly visionMaxImages: number;
  readonly visionFetchTimeoutMs: number;
}

/**
 * The worst case of producing ONE job: every step of the chain (the primary and up to
 * `maxFallbacks` fallbacks) timing out at the longest timeout the configuration allows, after
 * every image download has spent both of its legs' timeouts (PR #201 review, N2).
 */
export function assistantJobWorstCaseMs(bounds: AssistantJobBounds): number {
  return (
    (1 + bounds.maxFallbacks) * bounds.providerTimeoutMs +
    bounds.visionMaxImages * 2 * bounds.visionFetchTimeoutMs
  );
}

/**
 * A claimed job is leased for its worst case plus a margin (the context build, the transcript
 * read and the result write), so a second replica never re-claims a job still being produced
 * (PR #200 review, finding 4). Derived, so raising a bound raises the lease with it.
 */
export function assistantLeaseMs(bounds: AssistantJobBounds): number {
  return assistantJobWorstCaseMs(bounds) + 2 * 60_000;
}

export const ASSISTANT_JOB_BOUNDS: AssistantJobBounds = {
  maxFallbacks: SUPPORT_AI_LIMITS.maxFallbacks,
  providerTimeoutMs: SUPPORT_AI_LIMITS.timeoutMs.max,
  visionMaxImages: SUPPORT_AI_VISION_MAX_IMAGES,
  visionFetchTimeoutMs: SUPPORT_AI_VISION_FETCH_TIMEOUT_MS,
};
export const ASSISTANT_JOB_WORST_CASE_MS = assistantJobWorstCaseMs(ASSISTANT_JOB_BOUNDS);
export const ASSISTANT_LEASE_MS = assistantLeaseMs(ASSISTANT_JOB_BOUNDS);
/** Jobs per pass, claimed and produced ONE at a time. */
export const ASSISTANT_BATCH = 4;
/** A job claimed this many times without a result is failed rather than retried for ever. */
export const ASSISTANT_MAX_ATTEMPTS = 3;
/** TB8: learning jobs per pass. Lower than drafts: nobody is waiting on a lesson. */
export const ASSISTANT_LEARNING_BATCH = 2;
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
  private lastAliveAt = 0;
  private reportedNoScope = false;
  private readonly progress: LoopProgress;

  constructor(
    private readonly assist: Pick<
      SupportAssistService,
      'claimNext' | 'produce' | 'abandon' | 'purgeExpired'
    >,
    private readonly options: {
      /** TB7: the producer of AUTO_DECISION jobs. Without it, such a job is never claimed. */
      readonly auto?: Pick<SupportAutoReplyService, 'produce' | 'giveUp'>;
      /** TB8: the producer of learning jobs. Without it, no learning job is ever claimed. */
      readonly learning?: Pick<SupportLearningService, 'runDue' | 'purge'>;
      /** D5: closes the worker's "assistant stalled" condition once a pass completes. */
      readonly liveness?: Pick<SupportAssistantLiveness, 'alive'>;
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
      const auto = this.options.auto;
      // TB7: an AUTO_DECISION job is claimed only when its producer is wired.
      const kinds: readonly SupportAiJobKind[] =
        auto === undefined ? ['ASSIST_DRAFT'] : ['ASSIST_DRAFT', 'AUTO_DECISION'];
      const counts: Record<string, number> = {};
      let claimed = 0;
      while (claimed < ASSISTANT_BATCH) {
        const at = this.options.now();
        const job = await this.assist.claimNext(
          scope,
          at,
          new Date(at.getTime() + ASSISTANT_LEASE_MS),
          kinds,
        );
        if (job === null) break;
        claimed += 1;
        if (job.kind === 'AUTO_DECISION' && auto !== undefined) {
          // A job that keeps dying mid-call is repeated failure: it hands off, never loops.
          const outcome =
            job.attempts > ASSISTANT_MAX_ATTEMPTS
              ? await auto.giveUp(scope, job)
              : await auto.produce(scope, job);
          counts[outcome] = (counts[outcome] ?? 0) + 1;
          this.progress.record(this.options.now().getTime());
          // A stopped tenant: the job was left untouched, and so is the rest of the pass.
          if (outcome === 'INACTIVE') break;
          continue;
        }
        // `attempts` already counts this claim: a job that keeps dying mid-call fails instead.
        const state =
          job.attempts > ASSISTANT_MAX_ATTEMPTS
            ? await this.assist.abandon(scope, job)
            : await this.assist.produce(scope, job);
        counts[state] = (counts[state] ?? 0) + 1;
        this.progress.record(this.options.now().getTime());
        if (state === 'INACTIVE') break;
      }
      // TB8: learning jobs, after the conversations' own jobs — a customer waits on those. ONE
      // per claim, each leased from the moment it is claimed (TB5 review, finding 4): a batch
      // leased up front would wait out its lease behind its sibling's provider call.
      const learning = this.options.learning;
      let learned = 0;
      if (learning !== undefined) {
        for (let pass = 0; pass < ASSISTANT_LEARNING_BATCH; pass += 1) {
          const at = this.options.now();
          const learningCounts = await learning.runDue(scope, {
            now: at,
            leaseUntil: new Date(at.getTime() + ASSISTANT_LEASE_MS),
            limit: 1,
          });
          let ran = 0;
          for (const [label, n] of Object.entries(learningCounts)) {
            counts[label] = (counts[label] ?? 0) + n;
            ran += n;
          }
          if (ran === 0) break;
          learned += ran;
          this.progress.record(this.options.now().getTime());
        }
      }
      const now = this.options.now();
      if (now.getTime() - this.lastRetentionAt >= RETENTION_INTERVAL_MS) {
        counts.purged = await this.assist.purgeExpired(scope, now);
        if (learning !== undefined) counts.purged_candidates = await learning.purge(scope, now);
        this.lastRetentionAt = now.getTime();
      }
      if (claimed > 0 || learned > 0)
        this.options.logger.info({ claimed, ...counts }, 'assistant pass');
      // D5: a completed pass is the proof the worker cannot see — at most every watch interval.
      const liveness = this.options.liveness;
      if (
        liveness !== undefined &&
        now.getTime() - this.lastAliveAt >= SUPPORT_ASSISTANT_WATCH_INTERVAL_MS
      ) {
        if (await liveness.alive(scope)) {
          this.options.logger.info({}, 'assistant: running again; the stalled condition closed');
        }
        this.lastAliveAt = now.getTime();
      }
      this.progress.record(this.options.now().getTime());
    } catch (error: unknown) {
      this.options.logger.error({ err: error }, 'assistant pass failed');
    } finally {
      this.running = false;
    }
  }
}
