import type { TenantContext } from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import type { DrizzleSupportAiJobRepository } from '../infrastructure/drizzle-support-ai-job.repository.js';
import type { SupportAssistService } from './support-assist.service.js';
import { SUPPORT_AI_DRAFT_RETENTION_DAYS } from '@nexa/contracts';

export const ASSISTANT_INTERVAL_MS = 2_000;
/** A claimed job is leased this long — longer than any provider timeout (≤ 120 s) plus margin. */
export const ASSISTANT_LEASE_MS = 5 * 60_000;
/** Jobs per pass. Small: each is a provider call of up to two minutes, made one at a time. */
export const ASSISTANT_BATCH = 4;
/** A job claimed this many times without a result is failed rather than retried for ever. */
export const ASSISTANT_MAX_ATTEMPTS = 3;
const RETENTION_INTERVAL_MS = 10 * 60_000;

/**
 * TB5 — the `assistant` process role's loop (ADR-0034 §7).
 *
 * Provider calls are outbound HTTPS with decrypted third-party keys and multi-second latency;
 * they run HERE, never in the api (a request thread) or the worker (the notification lanes),
 * for the reason the provisioner and the monitor are their own roles. The loop claims QUEUED
 * jobs with a lease, produces each draft OUTSIDE any transaction, and records the result with a
 * conditional write — a job discarded meanwhile is never resurrected.
 */
export class AssistantLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRetentionAt = 0;
  private readonly progress: LoopProgress;

  constructor(
    private readonly assist: Pick<SupportAssistService, 'produce'>,
    private readonly jobs: Pick<
      DrizzleSupportAiJobRepository,
      'claimDue' | 'markFailed' | 'purgeText'
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
    this.progress = new LoopProgress(options.intervalMs);
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
        this.progress.record(this.options.now().getTime());
        return;
      }
      const now = this.options.now();
      const claimed = await this.jobs.claimDue(
        scope,
        now,
        new Date(now.getTime() + ASSISTANT_LEASE_MS),
        ASSISTANT_BATCH,
      );
      const counts: Record<string, number> = {};
      for (const job of claimed) {
        // `attempts` already counts this claim: a job that keeps dying mid-call fails instead.
        if (job.attempts > ASSISTANT_MAX_ATTEMPTS) {
          await this.jobs.markFailed(scope, job.id, 'job.attempts_exhausted', this.options.now());
          counts.FAILED = (counts.FAILED ?? 0) + 1;
          continue;
        }
        const state = await this.assist.produce(scope, job);
        counts[state] = (counts[state] ?? 0) + 1;
      }
      if (now.getTime() - this.lastRetentionAt >= RETENTION_INTERVAL_MS) {
        const cutoff = new Date(now.getTime() - SUPPORT_AI_DRAFT_RETENTION_DAYS * 86_400_000);
        counts.purged = await this.jobs.purgeText(scope, cutoff, now, 500);
        this.lastRetentionAt = now.getTime();
      }
      if (claimed.length > 0)
        this.options.logger.info({ claimed: claimed.length, ...counts }, 'assistant pass');
      this.progress.record(this.options.now().getTime());
    } catch (error: unknown) {
      this.options.logger.error({ err: error }, 'assistant pass failed');
    } finally {
      this.running = false;
    }
  }
}
