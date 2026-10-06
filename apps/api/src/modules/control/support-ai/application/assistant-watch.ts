import {
  SUPPORT_ASSISTANT_RUNNING_CODE,
  SUPPORT_ASSISTANT_STALL_SECONDS,
  SUPPORT_ASSISTANT_STALLED_CODE,
  type Clock,
  type OperationalEventRecorder,
  type ScopeContext,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { DrizzleSupportAiJobRepository } from '../infrastructure/drizzle-support-ai-job.repository.js';

/** The one open row of the condition: an installation has one assistant role. */
export const SUPPORT_ASSISTANT_STALLED_DEDUPE_KEY = `${SUPPORT_ASSISTANT_STALLED_CODE}:watch`;

/** How often the worker looks, and how often a running assistant may close the condition. */
export const SUPPORT_ASSISTANT_WATCH_INTERVAL_MS = 30_000;

/**
 * D5 — the worker's look at the `assistant` role, from the outside.
 *
 * The assistant's heartbeat is a file inside its own container (its Docker healthcheck), which
 * no other role can read. What another role CAN read is the work it leaves undone: an Assist
 * draft or an automatic job due for `SUPPORT_ASSISTANT_STALL_SECONDS` with no live lease, while
 * no job at all holds one. A live lease is a running assistant mid-call — a busy one, not a dead
 * one (the burst capacity note in the runbook is about that case) — so it never raises this.
 *
 * Decided from the job rows, in a transaction that checks scope activity first: a stopped
 * tenant's jobs are not claimed by design, and that is not a stalled assistant.
 */
export class SupportAssistantWatch {
  constructor(
    private readonly deps: {
      readonly jobs: Pick<DrizzleSupportAiJobRepository, 'assistantBacklog'>;
      readonly opsLog: OperationalEventRecorder;
      readonly uow: UnitOfWork<TransactionScope>;
      readonly scopeActivity: ScopeActivityReader;
      readonly clock: Clock;
    },
  ) {}

  async check(scope: ScopeContext): Promise<'STALLED' | 'OK' | 'INACTIVE'> {
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 'INACTIVE';
      const now = this.deps.clock.now();
      const backlog = await this.deps.jobs.assistantBacklog(
        scope,
        now,
        new Date(now.getTime() - SUPPORT_ASSISTANT_STALL_SECONDS * 1_000),
        tx,
      );
      if (backlog.overdue === 0 || backlog.leased > 0) return 'OK';
      await this.deps.opsLog.record(
        scope,
        {
          code: SUPPORT_ASSISTANT_STALLED_CODE,
          severity: 'WARN',
          message:
            'The support assistant is not running: AI drafts and automatic replies are waiting unclaimed. Check the assistant service (botctl status, botctl logs assistant).',
          dedupeKey: SUPPORT_ASSISTANT_STALLED_DEDUPE_KEY,
          context: {
            waiting: backlog.overdue,
            oldestDueAt: backlog.oldestDueAt?.toISOString() ?? null,
          },
        },
        tx,
      );
      return 'STALLED';
    });
  }
}

/**
 * D5 — the assistant's own proof that it is running: once a pass of its loop completes, it
 * closes the worker's condition if one is open. The read of the condition is in the same
 * transaction as the recovery it decides (`OperationalConditionReader`), so two passes that
 * both saw it open write one recovery row between them (deduplicated).
 */
export class SupportAssistantLiveness {
  constructor(
    private readonly deps: {
      readonly conditions: {
        tenantConditionIsOpen(
          tenantId: string,
          code: string,
          tx?: TransactionScope,
        ): Promise<boolean>;
      };
      readonly opsLog: OperationalEventRecorder;
      readonly uow: UnitOfWork<TransactionScope>;
      readonly scopeActivity: ScopeActivityReader;
    },
  ) {}

  /** True when this call recorded the recovery. */
  async alive(scope: TenantContext): Promise<boolean> {
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return false;
      if (
        !(await this.deps.conditions.tenantConditionIsOpen(
          scope.tenantId,
          SUPPORT_ASSISTANT_STALLED_CODE,
          tx,
        ))
      ) {
        return false;
      }
      await this.deps.opsLog.record(
        scope,
        {
          code: SUPPORT_ASSISTANT_RUNNING_CODE,
          severity: 'INFO',
          message: 'The support assistant is running again.',
          dedupeKey: `${SUPPORT_ASSISTANT_RUNNING_CODE}:assistant`,
          recoversCode: SUPPORT_ASSISTANT_STALLED_CODE,
          recoversDedupeKey: SUPPORT_ASSISTANT_STALLED_DEDUPE_KEY,
        },
        tx,
      );
      return true;
    });
  }
}

/**
 * Drives `SupportAssistantWatch.check` in the WORKER, with `BusinessOutboundLoop`'s shape:
 * re-entrancy refused, `stop()` waits for the pass in flight, progress recorded only for a pass
 * that completed.
 */
export class SupportAssistantWatchLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly progress: LoopProgress;

  constructor(
    private readonly watch: Pick<SupportAssistantWatch, 'check'>,
    private readonly options: {
      readonly scope: () => TenantContext | null;
      readonly intervalMs: number;
      readonly now: () => number;
      readonly logger: {
        warn: (context: Record<string, unknown>, message: string) => void;
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

  /** One pass. Public so a test drives exactly one. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const scope = this.options.scope();
      if (scope !== null && (await this.watch.check(scope)) === 'STALLED') {
        this.options.logger.warn({}, 'support assistant: due AI work is waiting unclaimed');
      }
      this.progress.record(this.options.now());
    } catch (error: unknown) {
      this.options.logger.error({ err: error }, 'support assistant watch pass failed');
    } finally {
      this.running = false;
    }
  }
}
