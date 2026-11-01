import { systemJobActor, type CorrelationId, type TenantContext } from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import { guardedTick } from '../../../../infrastructure/lifecycle/loop-guard.js';
import type {
  KnowledgeAutoRefreshResult,
  SupportKnowledgeBuildService,
} from './support-knowledge-build.service.js';

/** How often the worker looks for a change to the owner's content. */
export const SUPPORT_KNOWLEDGE_REFRESH_INTERVAL_MS = 60_000;
/** A change is applied once it has been STABLE this long (Phase 4 PR-2: two minutes). */
export const SUPPORT_KNOWLEDGE_REFRESH_DEBOUNCE_MS = 2 * 60_000;
/**
 * The nightly pass: the first tick in this UTC hour each UTC day (23:00 UTC is 02:30 in Tehran),
 * which applies whatever the debounce has not, without waiting for it.
 */
export const SUPPORT_KNOWLEDGE_NIGHTLY_HOUR_UTC = 23;
/** The job name the refresh acts as (`systemJobActor`). */
export const SUPPORT_KNOWLEDGE_REFRESH_JOB = 'support-knowledge-refresh';

/** What one pass decided. */
export type KnowledgeRefreshTick =
  | { readonly action: 'IDLE' }
  | { readonly action: 'WAITING'; readonly since: number }
  | { readonly action: 'REFRESHED'; readonly result: KnowledgeAutoRefreshResult };

/**
 * Phase 4 PR-2 — the debounce, pure: given the signature of the change pending now (null for
 * none), the one first seen and when, and the time, whether to refresh now. A change is refreshed
 * once the SAME signature has been pending for `SUPPORT_KNOWLEDGE_REFRESH_DEBOUNCE_MS` — an
 * owner still editing keeps moving the signature, and the clock restarts — or at once by the
 * nightly pass.
 */
export function refreshDecision(input: {
  readonly signature: string | null;
  readonly seen: { readonly signature: string; readonly since: number } | null;
  readonly now: number;
  readonly nightly: boolean;
}): 'IDLE' | 'WAIT' | 'REFRESH' {
  if (input.signature === null) return 'IDLE';
  if (input.nightly) return 'REFRESH';
  if (input.seen === null || input.seen.signature !== input.signature) return 'WAIT';
  return input.now - input.seen.since >= SUPPORT_KNOWLEDGE_REFRESH_DEBOUNCE_MS ? 'REFRESH' : 'WAIT';
}

/**
 * Phase 4 PR-2 — the automatic knowledge refresh, in the WORKER role (no new role): every minute
 * it asks the build service what change the owner's content would make
 * (`pendingRefreshSignature`, a read; nothing while `support.knowledge.auto_refresh` is off), and
 * refreshes (`autoRefresh`, as `SYSTEM_JOB`) once that change has been stable for two minutes, or
 * on the nightly pass. The debounce memory is in-process: a restart only restarts the wait.
 * `BusinessOutboundLoop`'s shape: re-entrancy refused, `stop()` waits for the pass in flight,
 * progress recorded only for a pass that completed. It sends no customer anything.
 */
export class SupportKnowledgeRefreshLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private seen: { signature: string; since: number } | null = null;
  private lastNightly: string | null = null;
  private readonly progress: LoopProgress;

  constructor(
    private readonly build: Pick<
      SupportKnowledgeBuildService,
      'pendingRefreshSignature' | 'autoRefresh'
    >,
    private readonly options: {
      readonly scope: () => TenantContext | null;
      readonly intervalMs: number;
      readonly now: () => Date;
      readonly correlationId: () => string;
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
    this.timer = setInterval(
      guardedTick('support-knowledge-refresh', () => this.tick(), this.options.logger),
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

  /** One pass. Public so a test drives exactly one. */
  async tick(): Promise<KnowledgeRefreshTick> {
    if (this.running) return { action: 'IDLE' };
    this.running = true;
    try {
      const outcome = await this.pass();
      this.progress.record(this.options.now().getTime());
      return outcome;
    } catch (error: unknown) {
      this.options.logger.error({ err: error }, 'support knowledge refresh pass failed');
      return { action: 'IDLE' };
    } finally {
      this.running = false;
    }
  }

  private async pass(): Promise<KnowledgeRefreshTick> {
    const scope = this.options.scope();
    if (scope === null) return { action: 'IDLE' };
    const now = this.options.now();
    const day = now.toISOString().slice(0, 10);
    const nightly =
      now.getUTCHours() === SUPPORT_KNOWLEDGE_NIGHTLY_HOUR_UTC && this.lastNightly !== day;
    const signature = await this.build.pendingRefreshSignature(scope);
    const decision = refreshDecision({ signature, seen: this.seen, now: now.getTime(), nightly });
    if (nightly) this.lastNightly = day;
    if (decision === 'IDLE') {
      this.seen = null;
      return { action: 'IDLE' };
    }
    if (decision === 'WAIT') {
      if (this.seen === null || this.seen.signature !== signature) {
        this.seen = { signature: signature ?? '', since: now.getTime() };
      }
      return { action: 'WAITING', since: this.seen.since };
    }
    const result = await this.build.autoRefresh(
      scope,
      systemJobActor(SUPPORT_KNOWLEDGE_REFRESH_JOB, this.options.correlationId() as CorrelationId),
    );
    this.seen = null;
    if (result.outcome === 'REFRESHED') {
      this.options.logger.info(
        { applied: result.applied, conflicted: result.conflicted, capped: result.capped },
        'support knowledge refreshed from the owner content',
      );
    }
    return { action: 'REFRESHED', result };
  }
}
