import {
  systemJobActor,
  TELEGRAM_MESSAGE_RETENTION_FAILING_CODE,
  TELEGRAM_MESSAGE_RETENTION_RECOVERED_CODE,
  type CorrelationId,
  type IdGenerator,
  type OperationalEventInput,
  type OperationalEventRecorder,
  type TenantContext,
} from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import type { TelegramMessageStateService } from './telegram-message-state.js';

/** Hourly, like the identity and ticket-file sweepers: the rows it removes are long dead. */
export const TELEGRAM_MESSAGE_RETENTION_INTERVAL_MS = 3_600_000;
/** After boot, so a worker that restarts often still sweeps; never during startup. */
export const TELEGRAM_MESSAGE_RETENTION_INITIAL_DELAY_MS = 150_000;
/** Rows per table per transaction, so no single statement or lock set is large. */
export const TELEGRAM_MESSAGE_RETENTION_BATCH = 500;
/** Batches per tick: the pass is always bounded, and the next tick continues a backlog. */
export const TELEGRAM_MESSAGE_RETENTION_MAX_BATCHES = 40;
/** Consecutive failed ticks before the condition is written: one bad hour is not news. */
export const TELEGRAM_MESSAGE_RETENTION_FAILURE_THRESHOLD = 3;
/** While failing, the condition is written at most this often (its counter climbs). */
export const TELEGRAM_MESSAGE_RETENTION_FAILURE_RECORD_INTERVAL_MS = 3_600_000;

/** The operations-log reader's one question, as `AntiSpamService` asks it. */
export interface RetentionConditionReader {
  openConditions(scope: TenantContext, dedupeKeys: readonly string[]): Promise<string[]>;
}

/**
 * The retention lane for `telegram_wizards` and `telegram_review_messages`
 * (`docs/telegram-retention.md`), in the WORKER.
 *
 * Every rule that makes a deletion safe lives in the repository's query and in the gates
 * that read the purge horizon — never here. This only decides HOW OFTEN and HOW MUCH: a
 * tick drains bounded batches until one comes back short (the backlog is gone) or the
 * ceiling is reached (the next tick continues), each batch its own short transaction under
 * `maintenance.run` as `SYSTEM_JOB`, scope-checked inside it. Two replicas ticking at once
 * is the ordinary rolling-update case: the candidates are taken `SKIP LOCKED`, so each
 * deletes a disjoint set, and the horizon only ever rises.
 *
 * Its own file for the reason `CustomerReminderLoop`'s docblock gives
 * (`worker-health-coverage.test.ts` marks every class in a file containing `isFresh`).
 * Progress is recorded only when a tick COMPLETES, so a lane whose every pass fails turns
 * the worker's readiness stale; and a failure streak becomes ONE operational condition,
 * written at the threshold and then at most hourly — the log is told the tables are
 * growing again, not told so every tick.
 */
export class TelegramMessageRetentionLoop {
  private timer: NodeJS.Timeout | null = null;
  private firstRun: NodeJS.Timeout | null = null;
  private running = false;
  private readonly progress: LoopProgress;
  private consecutiveFailures = 0;
  /** When THIS process last wrote the failing condition; null when it has not. */
  private failureRecordedAt: number | null = null;
  /**
   * Whether this process has asked the log, since it started, for a failing condition
   * another process left open — a replica replaced mid-streak takes its memory with it.
   */
  private lookedForOpenCondition = false;

  constructor(
    private readonly service: Pick<TelegramMessageStateService, 'purgeExpired'>,
    private readonly options: {
      readonly scope: () => TenantContext | null;
      readonly intervalMs: number;
      readonly initialDelayMs: number;
      readonly batchSize: number;
      readonly maxBatchesPerTick: number;
      readonly now: () => number;
      readonly ids: Pick<IdGenerator, 'uuid'>;
      readonly opsLog: Pick<OperationalEventRecorder, 'record'>;
      readonly conditions?: RetentionConditionReader;
      readonly logger: {
        info: (context: Record<string, unknown>, message: string) => void;
        warn: (context: Record<string, unknown>, message: string) => void;
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
    this.firstRun = setTimeout(() => void this.tick(), this.options.initialDelayMs);
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.firstRun.unref?.();
    this.timer.unref?.();
  }

  /** Stops the timers and waits for a tick already inside a transaction. */
  async stop(): Promise<void> {
    if (this.firstRun !== null) {
      clearTimeout(this.firstRun);
      this.firstRun = null;
    }
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
    this.progress.end();
  }

  /** One tick. Public so a test drives exactly one; overlapping calls do nothing. */
  async tick(): Promise<{ readonly wizards: number; readonly reviews: number } | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const scope = this.options.scope();
      if (scope === null) {
        this.progress.record(this.options.now());
        return { wizards: 0, reviews: 0 };
      }
      let removed: { readonly wizards: number; readonly reviews: number };
      try {
        removed = await this.drain(scope);
      } catch (error: unknown) {
        await this.failed(scope, error);
        return null;
      }
      this.progress.record(this.options.now());
      await this.succeeded(scope);
      if (removed.wizards + removed.reviews > 0) {
        this.options.logger.info(removed, 'telegram message state removed by retention');
      }
      return removed;
    } finally {
      this.running = false;
    }
  }

  /** Bounded batches until both tables come back short, or the ceiling. */
  async drain(scope: TenantContext): Promise<{ wizards: number; reviews: number }> {
    let wizards = 0;
    let reviews = 0;
    for (let batch = 0; batch < this.options.maxBatchesPerTick; batch += 1) {
      const actor = systemJobActor(
        'telegram-message-retention',
        this.options.ids.uuid() as CorrelationId,
      );
      const pass = await this.service.purgeExpired(scope, actor, this.options.batchSize);
      wizards += pass.wizards;
      reviews += pass.reviews;
      if (pass.wizards < this.options.batchSize && pass.reviews < this.options.batchSize) {
        return { wizards, reviews };
      }
    }
    this.options.logger.warn(
      { wizards, reviews, maxBatchesPerTick: this.options.maxBatchesPerTick },
      'telegram message retention hit its per-tick ceiling with work remaining',
    );
    return { wizards, reviews };
  }

  private async failed(scope: TenantContext, error: unknown): Promise<void> {
    this.consecutiveFailures += 1;
    this.options.logger.error(
      { error, consecutiveFailures: this.consecutiveFailures },
      'telegram message retention tick failed',
    );
    if (this.consecutiveFailures < TELEGRAM_MESSAGE_RETENTION_FAILURE_THRESHOLD) return;
    const now = this.options.now();
    if (
      this.failureRecordedAt !== null &&
      now - this.failureRecordedAt < TELEGRAM_MESSAGE_RETENTION_FAILURE_RECORD_INTERVAL_MS
    ) {
      return;
    }
    this.failureRecordedAt = now;
    await this.recordQuietly(scope, {
      code: TELEGRAM_MESSAGE_RETENTION_FAILING_CODE,
      severity: 'WARN',
      message:
        'The Telegram message-state retention sweep keeps failing; its two tables are growing.',
      context: {
        consecutiveFailures: this.consecutiveFailures,
        error: error instanceof Error ? error.message : String(error),
      },
      dedupeKey: TELEGRAM_MESSAGE_RETENTION_FAILING_CODE,
    });
  }

  private async succeeded(scope: TenantContext): Promise<void> {
    this.consecutiveFailures = 0;
    let open = this.failureRecordedAt !== null;
    if (!open && !this.lookedForOpenCondition && this.options.conditions !== undefined) {
      this.lookedForOpenCondition = true;
      try {
        const codes = await this.options.conditions.openConditions(scope, [
          TELEGRAM_MESSAGE_RETENTION_FAILING_CODE,
        ]);
        open = codes.includes(TELEGRAM_MESSAGE_RETENTION_FAILING_CODE);
      } catch (error: unknown) {
        this.options.logger.warn(
          { error },
          'telegram message retention could not look for an open condition',
        );
      }
    }
    if (!open) return;
    const recorded = await this.recordQuietly(scope, {
      code: TELEGRAM_MESSAGE_RETENTION_RECOVERED_CODE,
      severity: 'INFO',
      message: 'The Telegram message-state retention sweep completed again.',
      // Its own key: the recorder dedupes on the key alone, so a recovery written under
      // the failure's key would land ON the failure row rather than resolve it.
      dedupeKey: TELEGRAM_MESSAGE_RETENTION_RECOVERED_CODE,
      recoversCode: TELEGRAM_MESSAGE_RETENTION_FAILING_CODE,
      recoversDedupeKey: TELEGRAM_MESSAGE_RETENTION_FAILING_CODE,
    });
    // Kept when the recovery could not be written, so the next good tick tries again.
    if (recorded) this.failureRecordedAt = null;
  }

  /** Housekeeping never fails because the operations log could not be written. */
  private async recordQuietly(
    scope: TenantContext,
    event: OperationalEventInput,
  ): Promise<boolean> {
    try {
      await this.options.opsLog.record(scope, event);
      return true;
    } catch (error: unknown) {
      this.options.logger.warn({ error }, 'telegram message retention condition not recorded');
      return false;
    }
  }
}
