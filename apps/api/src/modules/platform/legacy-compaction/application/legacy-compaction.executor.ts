import {
  LEGACY_COMPACTION_ARCHIVE_TITLE,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type OperationalEventRecorder,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type { BackupOutcome } from '../../backup/application/backup.service.js';
import type { BackupRunPartRow } from '../../backup/application/ports.js';
import type { LegacyCompactionRepository, LegacyCompactionRow } from './ports.js';
import { COMPACTION_STRIP_KEYS, compactionDropTypes } from './read-map.js';

// ---------------------------------------------------------------------------
// The executor: the worker's half (its own file: the service has no loop)
// ---------------------------------------------------------------------------

export interface LegacyCompactionExecutorDeps {
  readonly repository: LegacyCompactionRepository;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  /** The backup pipeline: the same `run` every backup goes through. */
  readonly backup: {
    run(trigger: 'MANUAL', options: { readonly title: string }): Promise<BackupOutcome>;
  };
  readonly backupParts: (backupId: string) => Promise<readonly BackupRunPartRow[]>;
  readonly quiesced: () => Promise<boolean>;
  readonly actor: () => ActorContext;
  readonly leaseOwner: string;
  readonly batchSize: number;
  readonly tickIntervalMs: number;
  /** How often a long stage refreshes the lease. Default one minute. */
  readonly heartbeatIntervalMs?: number;
  /** Consecutive failures of one stage before the run is FAILED. Default three. */
  readonly maxStepAttempts?: number;
  readonly logger: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
  };
}

const LEASE_STALE_MS = 15 * 60_000;
const HEARTBEAT_MS = 60_000;
const MAX_STEP_ATTEMPTS = 3;

/**
 * Runs a REQUESTED compaction to the end, stage by stage, resumable at every batch.
 *
 * THE ORDER IS THE SAFETY. Nothing is deleted before ARCHIVING has produced a verified
 * backup whose EVERY part carries a Telegram message id; an archive that was not delivered
 * in full FAILS the run with nothing changed. Each later batch is one transaction holding
 * its rows, its cursor and ONE audit row, so a crash loses at most the batch in flight and
 * a restart (any replica, after the lease goes stale) resumes after the last commit.
 * Nothing runs while a recovery holds the installation.
 */
export class LegacyCompactionExecutor {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastTickAt: number | null = null;
  /** Consecutive failures of the stage a run is in, by `<run id>:<state>`. */
  private readonly failures = new Map<string, number>();

  constructor(private readonly deps: LegacyCompactionExecutorDeps) {}

  start(): void {
    if (this.timer !== null) return;
    this.lastTickAt = this.deps.clock.now().getTime();
    this.timer = setInterval(() => void this.tick(), this.deps.tickIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  isFresh(nowMs: number): boolean {
    if (this.ticking) return true;
    return this.lastTickAt !== null && nowMs - this.lastTickAt <= this.deps.tickIntervalMs * 3;
  }

  async tick(): Promise<LegacyCompactionRow | null> {
    if (this.ticking) return null;
    this.ticking = true;
    try {
      if (await this.deps.quiesced()) {
        this.lastTickAt = this.deps.clock.now().getTime();
        return null;
      }
      const now = this.deps.clock.now();
      const run = await this.deps.repository.claim({
        leaseOwner: this.deps.leaseOwner,
        now,
        staleBefore: new Date(now.getTime() - LEASE_STALE_MS),
      });
      this.lastTickAt = this.deps.clock.now().getTime();
      if (run === null) return null;
      return await this.drive(run);
    } catch (error) {
      this.deps.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'legacy compaction tick failed',
      );
      return null;
    } finally {
      this.ticking = false;
    }
  }

  /** Every remaining stage of one run, in order. Returns the run as it ended this tick. */
  async drive(start: LegacyCompactionRow): Promise<LegacyCompactionRow | null> {
    let run: LegacyCompactionRow | null = start;
    while (run !== null && run.state !== 'COMPLETED' && run.state !== 'FAILED') {
      // A lease another replica took over (this one stalled past the stale window) is no
      // longer this process's run: stop, rather than drive a row whose writes now fail and
      // repeat a stage (a second archive backup) for ever.
      if (run.leaseOwner !== this.deps.leaseOwner) return run;
      const key = `${run.id}:${run.state}`;
      let next: 'NEXT' | 'WAIT';
      try {
        next = await this.step(run);
        this.failures.delete(key);
      } catch (error) {
        await this.stepFailed(run, key, error);
        return this.deps.repository.latest(run.tenantId);
      }
      if (next === 'WAIT') return run;
      run = await this.deps.repository.latest(run.tenantId);
    }
    return run;
  }

  /**
   * A stage that threw. Retried on the next tick, but not for ever: a deterministic failure
   * (VACUUM FULL on a volume without room, say) would otherwise keep the run active, the
   * one-active index refusing a replacement, and the worker green. After `maxStepAttempts`
   * consecutive failures the run is FAILED with `legacy_compaction.step_failed`, by the same
   * conditional update as every other change, so only the lease holder can do it.
   */
  private async stepFailed(run: LegacyCompactionRow, key: string, error: unknown): Promise<void> {
    const attempts = (this.failures.get(key) ?? 0) + 1;
    this.deps.logger.error(
      {
        compactionId: run.id,
        state: run.state,
        attempts,
        err: error instanceof Error ? error.message : String(error),
      },
      'a legacy compaction stage failed',
    );
    if (attempts < (this.deps.maxStepAttempts ?? MAX_STEP_ATTEMPTS)) {
      this.failures.set(key, attempts);
      return;
    }
    this.failures.delete(key);
    await this.fail(run, 'legacy_compaction.step_failed');
  }

  /** A long stage, with the lease refreshed while it runs so no replica takes it over. */
  private async heartbeating<T>(run: LegacyCompactionRow, work: () => Promise<T>): Promise<T> {
    const beat = setInterval(() => {
      void this.deps.repository
        .heartbeat({ id: run.id, leaseOwner: this.deps.leaseOwner, now: this.deps.clock.now() })
        .catch((error: unknown) => {
          this.deps.logger.warn(
            { compactionId: run.id, err: error instanceof Error ? error.message : String(error) },
            'a legacy compaction heartbeat failed',
          );
        });
    }, this.deps.heartbeatIntervalMs ?? HEARTBEAT_MS);
    beat.unref();
    try {
      return await work();
    } finally {
      clearInterval(beat);
    }
  }

  private async step(run: LegacyCompactionRow): Promise<'NEXT' | 'WAIT'> {
    const scope: TenantContext = { tenantId: run.tenantId as never, botInstanceId: null };
    const owner = this.deps.leaseOwner;
    const now = () => this.deps.clock.now();
    switch (run.state) {
      case 'REQUESTED': {
        // Decided under the lock an import's start takes: from here until the run ends, no
        // import of this tenant can begin (`legacy-import-exclusion.ts`).
        const begun = await this.deps.repository.beginArchiving({
          id: run.id,
          tenantId: run.tenantId,
          leaseOwner: owner,
          now: now(),
        });
        if (begun === 'IMPORT_NOT_READY') {
          await this.fail(run, 'legacy_compaction.import_not_completed');
        }
        return 'NEXT';
      }
      case 'ARCHIVING': {
        // A previous tick's archive is re-checked, never re-taken.
        let backupId = run.archiveBackupId;
        if (backupId === null) {
          const outcome = await this.heartbeating(run, () =>
            this.deps.backup.run('MANUAL', { title: LEGACY_COMPACTION_ARCHIVE_TITLE }),
          );
          if (outcome.kind === 'BUSY') return 'WAIT';
          backupId = outcome.run.id;
          if (outcome.run.state !== 'SUCCEEDED' || outcome.run.verifiedAt === null) {
            // The reason the card can name: the archive's 7-Zip had too little memory.
            const memory =
              outcome.run.failureCode === 'backup.tool_oom_killed' ||
              outcome.run.failureCode === 'backup.memory_insufficient';
            await this.fail(
              run,
              memory ? 'legacy_compaction.archive_out_of_memory' : 'legacy_compaction.archive_failed',
              backupId,
            );
            return 'NEXT';
          }
        }
        // THE GATE: every part has a recorded Telegram message id.
        const parts = await this.deps.backupParts(backupId);
        const delivered =
          parts.length > 0 &&
          parts.every(
            (part) => part.deliveryState === 'SUCCEEDED' && part.telegramMessageId !== null,
          );
        if (!delivered) {
          await this.fail(run, 'legacy_compaction.archive_not_delivered', backupId);
          return 'NEXT';
        }
        await this.deps.repository.advance({
          id: run.id,
          leaseOwner: owner,
          from: 'ARCHIVING',
          to: 'MEASURING',
          now: now(),
          archiveBackupId: backupId,
        });
        await this.notice(scope, run, 'archived', { backupId, parts: parts.length });
        return 'NEXT';
      }
      case 'MEASURING': {
        const before = await this.deps.repository.measure(run.tenantId);
        await this.deps.repository.advance({
          id: run.id,
          leaseOwner: owner,
          from: 'MEASURING',
          to: 'DROPPING',
          now: now(),
          before,
          cursor: null,
        });
        return 'NEXT';
      }
      case 'DROPPING':
        return this.batched(run, scope, 'DROPPING', 'DEDUPING', (tx, after) =>
          this.deps.repository.deleteDropBatch(tx, {
            tenantId: run.tenantId,
            types: compactionDropTypes(),
            after,
            limit: this.deps.batchSize,
          }),
        );
      case 'DEDUPING':
        return this.batched(run, scope, 'DEDUPING', 'STRIPPING', (tx, after) =>
          this.deps.repository.dedupBatch(tx, {
            tenantId: run.tenantId,
            after,
            limit: this.deps.batchSize,
          }),
        );
      case 'STRIPPING':
        return this.batched(run, scope, 'STRIPPING', 'VACUUMING', (tx, after) =>
          this.deps.repository.stripBatch(tx, {
            tenantId: run.tenantId,
            keys: COMPACTION_STRIP_KEYS,
            after,
            limit: this.deps.batchSize,
          }),
        );
      case 'VACUUMING': {
        await this.notice(scope, run, 'maintenance', {});
        await this.heartbeating(run, () => this.deps.repository.vacuum());
        const after = await this.deps.repository.measure(run.tenantId);
        await this.deps.repository.advance({
          id: run.id,
          leaseOwner: owner,
          from: 'VACUUMING',
          to: 'COMPLETED',
          now: now(),
          after,
        });
        await this.notice(scope, run, 'completed', {
          deleted: String(run.deleted),
          deduplicated: String(run.deduplicated),
          stripped: String(run.stripped),
        });
        return 'NEXT';
      }
      default:
        return 'WAIT';
    }
  }

  /**
   * One stage as keyset batches: each batch, its cursor and ONE audit row commit together,
   * inside the unit of work (so the recovery quiesce refuses it) and after the scope check.
   */
  private async batched(
    run: LegacyCompactionRow,
    scope: TenantContext,
    from: 'DROPPING' | 'DEDUPING' | 'STRIPPING',
    to: 'DEDUPING' | 'STRIPPING' | 'VACUUMING',
    batch: (
      tx: TransactionScope['tx'],
      after: string | null,
    ) => Promise<{ count: number; last: string | null }>,
  ): Promise<'NEXT' | 'WAIT'> {
    let cursor = run.cursor;
    for (;;) {
      if (await this.deps.quiesced()) return 'WAIT';
      const result = await this.deps.uow.run(scope, async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return null;
        await this.deps.repository.authorise(tx.tx, run.id);
        const done = await batch(tx.tx, cursor);
        const now = this.deps.clock.now();
        if (done.last === null) {
          await this.deps.repository.advance(
            { id: run.id, leaseOwner: this.deps.leaseOwner, from, to, now, cursor: null },
            tx.tx,
          );
          return done;
        }
        const moved = await this.deps.repository.advance(
          {
            id: run.id,
            leaseOwner: this.deps.leaseOwner,
            from,
            to: from,
            now,
            cursor: done.last,
            ...(from === 'DROPPING' ? { addDeleted: done.count } : {}),
            ...(from === 'DEDUPING' ? { addDeduplicated: done.count } : {}),
            ...(from === 'STRIPPING' ? { addStripped: done.count } : {}),
          },
          tx.tx,
        );
        // A lease lost to another replica: this batch rolls back with nothing changed.
        if (!moved) throw new Error('the compaction lease moved; this batch is not this process’s');
        // ONE audit row per batch: the stage, how many, and the cursor. Never a value.
        await this.deps.audit.record(
          scope,
          this.deps.actor(),
          {
            action: 'legacy.compaction.batch',
            entityType: 'LegacyCompaction',
            entityId: run.id,
            before: null,
            after: { stage: from, rows: done.count, cursor: done.last },
            result: 'SUCCESS',
          },
          tx,
        );
        return done;
      });
      if (result === null) return 'WAIT';
      if (result.last === null) return 'NEXT';
      cursor = result.last;
    }
  }

  private async fail(
    run: LegacyCompactionRow,
    code:
      | 'legacy_compaction.archive_failed'
      | 'legacy_compaction.archive_not_delivered'
      | 'legacy_compaction.archive_out_of_memory'
      | 'legacy_compaction.import_not_completed'
      | 'legacy_compaction.step_failed',
    backupId?: string,
  ): Promise<void> {
    await this.deps.repository.advance({
      id: run.id,
      leaseOwner: this.deps.leaseOwner,
      from: run.state,
      to: 'FAILED',
      now: this.deps.clock.now(),
      failureCode: code,
      ...(backupId === undefined ? {} : { archiveBackupId: backupId }),
    });
    this.deps.logger.warn(
      { compactionId: run.id, code },
      run.state === 'REQUESTED' || run.state === 'ARCHIVING' || run.state === 'MEASURING'
        ? 'legacy compaction stopped; nothing was deleted'
        : 'legacy compaction stopped at a failing stage; its archive backup holds what was there',
    );
  }

  /** What the operations group is told. Never a value from a record. */
  private async notice(
    scope: TenantContext,
    run: LegacyCompactionRow,
    what: 'archived' | 'maintenance' | 'completed',
    context: Record<string, unknown>,
  ): Promise<void> {
    // Under the catalogued `maintenance.` prefix (a SYSTEM fact).
    const codes = {
      archived: 'maintenance.legacy_compaction_archived',
      maintenance: 'maintenance.legacy_compaction_vacuum',
      completed: 'maintenance.legacy_compaction_completed',
    } as const;
    const messages = {
      archived:
        'The legacy archive backup was delivered in full; compacting the legacy data begins.',
      maintenance:
        'Maintenance: the legacy history tables are being rewritten (VACUUM FULL). The legacy ' +
        'history pages wait until it finishes.',
      completed: 'The compaction of the legacy data completed.',
    } as const;
    try {
      await this.deps.opsLog.record(scope, {
        code: codes[what],
        severity: 'INFO',
        message: messages[what],
        context: { compactionId: run.id, ...context },
      });
    } catch (error) {
      this.deps.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'could not record a legacy compaction notice',
      );
    }
  }
}
