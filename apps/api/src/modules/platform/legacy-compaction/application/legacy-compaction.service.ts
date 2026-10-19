import {
  errors,
  LEGACY_COMPACTION_ARCHIVE_TITLE,
  LEGACY_COMPACTION_CONFIRMATION_PHRASE,
  PLATFORM_ERROR_CODES,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type IdGenerator,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../access/application/authorized-mutation.js';
import type { SessionRepository } from '../../identity/application/ports.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import { rememberOnce } from '../../idempotency/application/remember-once.js';
import type { BackupOutcome } from '../../backup/application/backup.service.js';
import type { BackupRunPartRow } from '../../backup/application/ports.js';
import type { LegacyCompactionRepository, LegacyCompactionRow } from './ports.js';
import { COMPACTION_STRIP_KEYS, compactionDropTypes } from './read-map.js';

/**
 * «فشرده‌سازی داده‌های ربات قبلی» (Round 4 PR-E, E1).
 *
 * The REQUEST is the owner's: `legacy.migration.apply` (CRITICAL, the permission that started
 * the import), the typed phrase, a completed import and none in flight, and never twice (it
 * is one-time). It writes one REQUESTED row and an audit row, and nothing else: the work is
 * the worker's (`LegacyCompactionExecutor`), never this request's.
 */

export const LEGACY_COMPACTION_PERMISSION: PermissionKey = 'legacy.migration.apply';
const VIEW_PERMISSION: PermissionKey = 'legacy.migration.view';

export interface LegacyCompactionServiceDeps {
  readonly repository: LegacyCompactionRepository;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
}

export class LegacyCompactionService {
  constructor(private readonly deps: LegacyCompactionServiceDeps) {}

  async status(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<{ available: boolean; run: LegacyCompactionRow | null }> {
    await this.authorize(scope, actor, VIEW_PERMISSION, 'legacy.compaction.status');
    const [readiness, run, completed] = await Promise.all([
      this.deps.repository.importReadiness(scope.tenantId),
      this.deps.repository.latest(scope.tenantId),
      this.deps.repository.completedExists(scope.tenantId),
    ]);
    const active = run !== null && run.state !== 'COMPLETED' && run.state !== 'FAILED';
    return {
      available: readiness.completed && !readiness.inFlight && !active && !completed,
      run,
    };
  }

  async request(
    scope: TenantContext,
    actor: ActorContext,
    command: { readonly idempotencyKey: string; readonly phrase: string },
  ): Promise<LegacyCompactionRow> {
    await this.authorize(scope, actor, LEGACY_COMPACTION_PERMISSION, 'legacy.compaction.request');
    if (command.phrase.trim() !== LEGACY_COMPACTION_CONFIRMATION_PHRASE) {
      throw errors.validation(
        PLATFORM_ERROR_CODES.LEGACY_COMPACTION_PHRASE_INVALID,
        `Type ${LEGACY_COMPACTION_CONFIRMATION_PHRASE} exactly to confirm.`,
      );
    }
    const requestHash = 'legacy.compaction.request.v1';
    const replay = await this.deps.idempotency.find<{ id: string }>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay) {
      const row = await this.deps.repository.latest(scope.tenantId);
      if (row !== null) return row;
    }
    const id = this.deps.ids.uuid();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      LEGACY_COMPACTION_PERMISSION,
      { action: 'legacy.compaction.request', entityType: 'LegacyCompaction', entityId: null },
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.notFound(
            PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
            'This scope is not accepting work.',
          );
        }
        // Decided INSIDE the transaction: an import approved a moment ago is in flight.
        const readiness = await this.deps.repository.importReadiness(scope.tenantId, tx.tx);
        if (!readiness.completed || readiness.inFlight) {
          throw errors.conflict(
            PLATFORM_ERROR_CODES.LEGACY_COMPACTION_UNAVAILABLE,
            'The legacy data can be compacted only after an import has completed and while none is running.',
          );
        }
        if (await this.deps.repository.completedExists(scope.tenantId, tx.tx)) {
          throw errors.conflict(
            PLATFORM_ERROR_CODES.LEGACY_COMPACTION_ACTIVE,
            'The legacy data has already been compacted.',
          );
        }
        const now = this.deps.clock.now();
        const created = await this.deps.repository.create(
          {
            id,
            tenantId: scope.tenantId,
            now,
            adminId: actor.type === 'WEB_ADMIN' ? actor.id : null,
            label: actor.label,
          },
          tx.tx,
        );
        if (!created) {
          throw errors.conflict(
            PLATFORM_ERROR_CODES.LEGACY_COMPACTION_ACTIVE,
            'A compaction of the legacy data is already running.',
          );
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'legacy.compaction.request',
            entityType: 'LegacyCompaction',
            entityId: id,
            before: null,
            after: { state: 'REQUESTED', dropTypes: [...compactionDropTypes()] },
            reason: 'The owner confirmed the irreversible compaction of the legacy data.',
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          { id },
          tx,
        );
      },
    );
    const row = await this.deps.repository.latest(scope.tenantId);
    if (row === null) throw new Error('a compaction row could not be read back');
    return row;
  }

  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    permission: PermissionKey,
    action: string,
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (denied) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        permission,
        { action, entityType: 'LegacyCompaction', entityId: null },
        denied,
      );
      throw denied;
    }
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }
}

// ---------------------------------------------------------------------------
// The executor: the worker's half
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
  readonly logger: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
  };
}

const LEASE_STALE_MS = 15 * 60_000;

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
      const next = await this.step(run);
      if (next === 'WAIT') return run;
      run = await this.deps.repository.latest(run.tenantId);
    }
    return run;
  }

  private async step(run: LegacyCompactionRow): Promise<'NEXT' | 'WAIT'> {
    const scope: TenantContext = { tenantId: run.tenantId as never, botInstanceId: null };
    const owner = this.deps.leaseOwner;
    const now = () => this.deps.clock.now();
    switch (run.state) {
      case 'REQUESTED': {
        const readiness = await this.deps.repository.importReadiness(run.tenantId);
        if (!readiness.completed || readiness.inFlight) {
          await this.fail(run, 'legacy_compaction.import_not_completed');
          return 'NEXT';
        }
        await this.deps.repository.advance({
          id: run.id,
          leaseOwner: owner,
          from: 'REQUESTED',
          to: 'ARCHIVING',
          now: now(),
        });
        return 'NEXT';
      }
      case 'ARCHIVING': {
        // A previous tick's archive is re-checked, never re-taken.
        let backupId = run.archiveBackupId;
        if (backupId === null) {
          const outcome = await this.deps.backup.run('MANUAL', {
            title: LEGACY_COMPACTION_ARCHIVE_TITLE,
          });
          if (outcome.kind === 'BUSY') return 'WAIT';
          backupId = outcome.run.id;
          if (outcome.run.state !== 'SUCCEEDED' || outcome.run.verifiedAt === null) {
            await this.fail(run, 'legacy_compaction.archive_failed', backupId);
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
        await this.deps.repository.vacuum();
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
      | 'legacy_compaction.import_not_completed',
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
      'legacy compaction stopped; nothing was deleted',
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
