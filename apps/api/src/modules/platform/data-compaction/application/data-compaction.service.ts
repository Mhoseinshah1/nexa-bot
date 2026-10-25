import {
  DATA_COMPACTION_CLASS_SETTING,
  DATA_COMPACTION_CLASSES,
  DATA_COMPACTION_SETTING_KEYS,
  isNexaError,
  PLATFORM_ERROR_CODES,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type DataCompactionClass,
  type DataCompactionMode,
  type DataCompactionPreview,
  type DataCompactionStopReason,
  type DataCompactionTrigger,
  type IdGenerator,
  type OperationalEventRecorder,
  type PermissionKey,
  type ScopeContext,
  type SettingKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import { recordMutationDenial } from '../../access/application/authorized-mutation.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import {
  CLASS_STEPS,
  type ClassCutoffs,
  type DataCompactionRepository,
  type DataCompactionRunRow,
  type InFlightProbe,
  type TableCounts,
} from './ports.js';

/**
 * The data compaction (Round 9 C3): what runs a pass, for the worker and for the CLI, and the
 * Web Admin's read-only preview.
 *
 * A PASS, in order:
 *
 *  1. the permission, deny by default — `maintenance.run`, which the worker's SYSTEM_JOB holds
 *     and the owner holds; a denial is audited before it is rethrown;
 *  2. nothing starts while a recovery or a backup is in flight (`inFlight`): the restore
 *     decides what the database holds, and a backup is the file a restore will read;
 *  3. one transaction: the scope is still accepting work, an abandoned RUNNING pass is FAILED
 *     (never adopted), the mode and the days are read, the cutoffs fixed, and the RUNNING row
 *     written (one per tenant, by a partial unique index);
 *  4. DRY_RUN: the counts are written onto that row and it completes — nothing is deleted;
 *     APPLY: keyset batches, EACH ITS OWN TRANSACTION through the unit of work (so the
 *     recovery quiesce refuses it), each re-checking scope activity inside, naming its pass
 *     for 0278's guard, deleting at most one batch of parents with their children, adding its
 *     counts to the run row and writing ONE audit row — so a crash loses at most the batch in
 *     flight, and a re-run removes only what is still eligible (idempotent);
 *  5. the run row ends COMPLETED, or STOPPED with the reason it stopped.
 */

export const DATA_COMPACTION_PERMISSION: PermissionKey = 'maintenance.run';
const DAY_MS = 24 * 3_600_000;
/** A RUNNING pass whose heartbeat is older than this was abandoned by its process. */
export const DATA_COMPACTION_STALE_MS = 30 * 60_000;

export interface DataCompactionServiceDeps {
  readonly repository: DataCompactionRepository;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly scopeActivity: ScopeActivityReader;
  readonly settings: { valueOf<T>(scope: ScopeContext, key: SettingKey, tx?: unknown): Promise<T> };
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly inFlight: InFlightProbe;
  readonly batchSize: number;
  /** Ceiling on batches in one pass, so a pass is always bounded; the next continues. */
  readonly maxBatchesPerPass: number;
}

export type DataCompactionOutcome =
  /** Nothing started: something else holds the installation, or the scope is stopped. */
  | { readonly kind: 'BLOCKED'; readonly reason: DataCompactionStopReason }
  /** Another pass of this tenant is RUNNING. */
  | { readonly kind: 'BUSY' }
  /** The CLI's confirmation named a different number of rows than are eligible now. */
  | { readonly kind: 'COUNT_MISMATCH'; readonly eligibleRows: number; readonly counts: TableCounts }
  | { readonly kind: 'RAN'; readonly run: DataCompactionRunRow };

export interface DataCompactionRunCommand {
  readonly trigger: DataCompactionTrigger;
  /** `SETTING` reads `retention.compaction_mode`; the CLI passes its own explicit choice. */
  readonly mode: DataCompactionMode | 'SETTING';
  /** APPLY only: the total the operator confirmed; a different eligible total refuses. */
  readonly expectRows?: number;
}

export function totalOf(counts: TableCounts): number {
  return Object.values(counts).reduce<number>((sum, n) => sum + (n ?? 0), 0);
}

function addInto(target: Record<string, number>, add: TableCounts): void {
  for (const [table, n] of Object.entries(add)) {
    if (n !== undefined && n > 0) target[table] = (target[table] ?? 0) + n;
  }
}

export class DataCompactionService {
  constructor(private readonly deps: DataCompactionServiceDeps) {}

  /** The Web Admin's dry run: counts per class at today's cutoffs. Writes nothing. */
  async preview(scope: TenantContext, actor: ActorContext): Promise<DataCompactionPreview> {
    await this.authorize(scope, actor, 'data.compaction.preview');
    const now = this.deps.clock.now();
    const blockedBy = await this.deps.inFlight();
    const read = await this.deps.uow.runSnapshot(scope, async (tx) => {
      const mode = await this.mode(scope, tx);
      const days = await this.days(scope, tx);
      const cutoffs = cutoffsAt(now, days);
      const classes = [];
      for (const cls of DATA_COMPACTION_CLASSES) {
        classes.push({
          class: cls,
          retentionDays: days[cls],
          cutoff: cutoffs[cls].toISOString(),
          counts: await this.countClass(scope.tenantId, cls, cutoffs[cls], tx),
        });
      }
      return { mode, classes };
    });
    const last = await this.deps.repository.latest(scope.tenantId);
    return {
      mode: read.mode,
      blockedBy,
      classes: read.classes.map((entry) => ({ ...entry, counts: { ...entry.counts } })),
      lastRun:
        last === null
          ? null
          : {
              id: last.id,
              trigger: last.trigger,
              mode: last.mode,
              state: last.state,
              startedAt: last.startedAt.toISOString(),
              finishedAt: last.finishedAt === null ? null : last.finishedAt.toISOString(),
              counts: { ...last.counts },
              stopReason: last.stopReason,
            },
    };
  }

  /** One pass. See the class comment for the order, which is the safety. */
  async run(
    scope: TenantContext,
    actor: ActorContext,
    command: DataCompactionRunCommand,
  ): Promise<DataCompactionOutcome> {
    await this.authorize(scope, actor, 'data.compaction.run');
    const blocked = await this.deps.inFlight();
    if (blocked !== null) return { kind: 'BLOCKED', reason: blocked };

    const runId = this.deps.ids.uuid();
    const begun = await this.begin(scope, actor, command, runId);
    if (begun.kind !== 'STARTED') return begun;
    if (begun.mode === 'APPLY') await this.apply(scope, actor, runId, begun.cutoffs);
    const run = await this.deps.repository.latest(scope.tenantId);
    if (run === null || run.id !== runId)
      throw new Error('a compaction run could not be read back');
    return { kind: 'RAN', run };
  }

  /** Step 3 of a pass: one transaction that fixes the mode and cutoffs and writes the row. */
  private async begin(
    scope: TenantContext,
    actor: ActorContext,
    command: DataCompactionRunCommand,
    runId: string,
  ) {
    try {
      return await this.beginInTransaction(scope, actor, command, runId);
    } catch (error) {
      // The quiesce refused the transaction itself: nothing was written, nothing starts.
      if (isNexaError(error) && error.code === PLATFORM_ERROR_CODES.RECOVERY_QUIESCED) {
        return { kind: 'BLOCKED', reason: 'RECOVERY_IN_FLIGHT' } as const;
      }
      throw error;
    }
  }

  private async beginInTransaction(
    scope: TenantContext,
    actor: ActorContext,
    command: DataCompactionRunCommand,
    runId: string,
  ) {
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
        return { kind: 'BLOCKED', reason: 'SCOPE_INACTIVE' } as const;
      }
      const now = this.deps.clock.now();
      await this.deps.repository.failAbandoned(
        tx.tx,
        scope.tenantId,
        new Date(now.getTime() - DATA_COMPACTION_STALE_MS),
        now,
      );
      const mode = command.mode === 'SETTING' ? await this.mode(scope, tx) : command.mode;
      const cutoffs = cutoffsAt(now, await this.days(scope, tx));
      const eligible: Record<string, number> = {};
      if (mode === 'DRY_RUN' || command.expectRows !== undefined) {
        for (const cls of DATA_COMPACTION_CLASSES) {
          addInto(eligible, await this.countClass(scope.tenantId, cls, cutoffs[cls], tx));
        }
      }
      if (mode === 'APPLY' && command.expectRows !== undefined) {
        const eligibleRows = totalOf(eligible);
        if (eligibleRows !== command.expectRows) {
          return { kind: 'COUNT_MISMATCH', eligibleRows, counts: eligible } as const;
        }
      }
      const started = await this.deps.repository.start(tx.tx, {
        id: runId,
        tenantId: scope.tenantId,
        trigger: command.trigger,
        mode,
        now,
        cutoffs,
      });
      if (!started) return { kind: 'BUSY' } as const;
      const iso = Object.fromEntries(
        DATA_COMPACTION_CLASSES.map((cls) => [cls, cutoffs[cls].toISOString()]),
      );
      if (mode === 'DRY_RUN') {
        await this.deps.repository.advance(tx.tx, { id: runId, add: eligible, now });
        await this.deps.repository.finish(tx.tx, {
          id: runId,
          to: 'COMPLETED',
          reason: null,
          now,
        });
      }
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: mode === 'DRY_RUN' ? 'data.compaction.dry_run' : 'data.compaction.started',
          entityType: 'DataCompaction',
          entityId: runId,
          before: null,
          after: {
            trigger: command.trigger,
            mode,
            cutoffs: iso,
            ...(mode === 'DRY_RUN' ? { eligible } : {}),
          },
          result: 'SUCCESS',
        },
        tx,
      );
      return { kind: 'STARTED', mode, cutoffs } as const;
    });
  }

  private async apply(
    scope: TenantContext,
    actor: ActorContext,
    runId: string,
    cutoffs: ClassCutoffs,
  ): Promise<void> {
    let batches = 0;
    let stop: DataCompactionStopReason | null = null;
    const removed: Record<string, number> = {};
    try {
      outer: for (const cls of DATA_COMPACTION_CLASSES) {
        for (const step of CLASS_STEPS[cls]) {
          let cursor: string | null = null;
          for (;;) {
            if (batches >= this.deps.maxBatchesPerPass) {
              stop = 'BATCH_CEILING';
              break outer;
            }
            const held = await this.deps.inFlight();
            if (held !== null) {
              stop = held;
              break outer;
            }
            const after: string | null = cursor;
            const done = await this.deps.uow.run(scope, async (tx) => {
              if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return null;
              await this.deps.repository.authorise(tx.tx, runId);
              const batch = await this.deps.repository.deleteBatch(tx.tx, {
                tenantId: scope.tenantId,
                step,
                cutoff: cutoffs[cls],
                after,
                limit: this.deps.batchSize,
              });
              if (batch.parents === 0) return batch;
              const moved = await this.deps.repository.advance(tx.tx, {
                id: runId,
                add: batch.counts,
                now: this.deps.clock.now(),
              });
              // The run is no longer RUNNING (failed as abandoned by another pass): this batch
              // rolls back with nothing removed.
              if (!moved) throw new Error('the compaction run is no longer running');
              // ONE audit row per batch: the class, the rows per table and the cursor.
              await this.deps.audit.record(
                scope,
                actor,
                {
                  action: 'data.compaction.batch',
                  entityType: 'DataCompaction',
                  entityId: runId,
                  before: null,
                  after: { class: cls, step, rows: { ...batch.counts }, cursor: batch.last },
                  result: 'SUCCESS',
                },
                tx,
              );
              return batch;
            });
            if (done === null) {
              stop = 'SCOPE_INACTIVE';
              break outer;
            }
            batches += 1;
            addInto(removed, done.counts);
            if (done.parents < this.deps.batchSize || done.last === null) break;
            cursor = done.last;
          }
        }
      }
    } catch (error) {
      if (isNexaError(error) && error.code === PLATFORM_ERROR_CODES.RECOVERY_QUIESCED) {
        // The quiesce refused the batch. The run row cannot be written now either; the next
        // pass after the recovery FAILS it as abandoned (it is never adopted).
        return;
      }
      await this.close(scope, actor, runId, 'FAILED', 'ERROR', removed);
      throw error;
    }
    await this.close(scope, actor, runId, stop === null ? 'COMPLETED' : 'STOPPED', stop, removed);
  }

  private async close(
    scope: TenantContext,
    actor: ActorContext,
    runId: string,
    to: 'COMPLETED' | 'STOPPED' | 'FAILED',
    reason: DataCompactionStopReason | null,
    removed: Record<string, number>,
  ): Promise<void> {
    try {
      await this.deps.uow.run(scope, async (tx) => {
        const closed = await this.deps.repository.finish(tx.tx, {
          id: runId,
          to,
          reason,
          now: this.deps.clock.now(),
        });
        if (!closed) return;
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'data.compaction.finished',
            entityType: 'DataCompaction',
            entityId: runId,
            before: null,
            after: { state: to, stopReason: reason, removed },
            result: to === 'FAILED' ? 'FAILED' : 'SUCCESS',
          },
          tx,
        );
      });
    } catch (error) {
      // A quiesce that began after the last batch: left RUNNING, failed as abandoned later.
      if (isNexaError(error) && error.code === PLATFORM_ERROR_CODES.RECOVERY_QUIESCED) return;
      throw error;
    }
  }

  private async countClass(
    tenantId: string,
    cls: DataCompactionClass,
    cutoff: Date,
    tx: TransactionScope,
  ): Promise<TableCounts> {
    const counts: Record<string, number> = {};
    for (const step of CLASS_STEPS[cls]) {
      addInto(counts, await this.deps.repository.count(tx.tx, tenantId, step, cutoff));
    }
    return counts;
  }

  private async mode(scope: TenantContext, tx: TransactionScope): Promise<DataCompactionMode> {
    return this.deps.settings.valueOf<DataCompactionMode>(
      scope,
      DATA_COMPACTION_SETTING_KEYS.mode,
      tx,
    );
  }

  private async days(
    scope: TenantContext,
    tx: TransactionScope,
  ): Promise<Record<DataCompactionClass, number>> {
    const out = {} as Record<DataCompactionClass, number>;
    for (const cls of DATA_COMPACTION_CLASSES) {
      out[cls] = await this.deps.settings.valueOf<number>(
        scope,
        DATA_COMPACTION_CLASS_SETTING[cls],
        tx,
      );
    }
    return out;
  }

  private async authorize(scope: TenantContext, actor: ActorContext, action: string) {
    try {
      await this.deps.guard.check(scope, actor, DATA_COMPACTION_PERMISSION);
    } catch (denied) {
      await recordMutationDenial(
        { opsLog: this.deps.opsLog, audit: this.deps.audit, guard: this.deps.guard },
        scope,
        actor,
        DATA_COMPACTION_PERMISSION,
        { action, entityType: 'DataCompaction', entityId: null },
        denied,
      );
      throw denied;
    }
  }
}

/** `now − days`, per class. A row is eligible when its stamp is strictly before this. */
export function cutoffsAt(now: Date, days: Record<DataCompactionClass, number>): ClassCutoffs {
  const out = {} as Record<DataCompactionClass, Date>;
  for (const cls of DATA_COMPACTION_CLASSES) {
    out[cls] = new Date(now.getTime() - days[cls] * DAY_MS);
  }
  return out;
}
