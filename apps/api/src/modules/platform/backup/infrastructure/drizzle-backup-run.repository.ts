import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type {
  BackupDeliveryState,
  BackupRunState,
  BackupStage,
  BackupTrigger,
} from '@nexa/contracts';
import { NexaError, PLATFORM_ERROR_CODES } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { backupRuns } from '../../../../infrastructure/persistence/schema.js';
import { isUniqueViolation } from '../../../../infrastructure/persistence/sqlstate.js';
import type { BackupRunRepository, BackupRunRow, StartOutcome } from '../application/ports.js';

/**
 * The backup run table, and the installation's backup lock.
 *
 * The lock is `backup_runs_single_active_idx` — a partial unique index over a
 * constant, permitting one `state = 'RUNNING'` row in the whole table. So
 * `start` is an ordinary INSERT: it either succeeds, in which case this process
 * holds the installation, or it raises a 23505, in which case somebody else
 * does. Nothing here polls, and no two processes have to agree on anything.
 *
 * Every write is guarded on `lease_owner` as well as `id`. A run whose lease
 * was reclaimed while it was still working must not be able to write to its own
 * row afterwards: the row now belongs to the takeover, and a late `finish` from
 * the abandoned process would overwrite a FAILED with a SUCCEEDED — reporting
 * success for a run whose lock somebody else has since taken.
 */

type Row = typeof backupRuns.$inferSelect;

function toRow(row: Row): BackupRunRow {
  return {
    id: row.id,
    trigger: row.trigger as BackupTrigger,
    state: row.state as BackupRunState,
    stage: row.stage as BackupStage,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    leaseOwner: row.leaseOwner,
    leaseHeartbeatAt: row.leaseHeartbeatAt,
    dumpBytes: row.dumpBytes,
    archiveBytes: row.archiveBytes,
    checksum: row.checksum,
    verifiedAt: row.verifiedAt,
    deliveryState: row.deliveryState as BackupDeliveryState,
    deliveryAttemptedAt: row.deliveryAttemptedAt,
    deliveryDetail: row.deliveryDetail,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    cleanupOk: row.cleanupOk,
    cleanupDetail: row.cleanupDetail,
  };
}

export class DrizzleBackupRunRepository implements BackupRunRepository {
  constructor(private readonly db: Database) {}

  async start(input: {
    id: string;
    trigger: BackupTrigger;
    leaseOwner: string;
    now: Date;
  }): Promise<StartOutcome> {
    try {
      const [row] = await this.db
        .insert(backupRuns)
        .values({
          id: input.id,
          trigger: input.trigger,
          state: 'RUNNING',
          stage: 'DUMP',
          startedAt: input.now,
          finishedAt: null,
          leaseOwner: input.leaseOwner,
          leaseHeartbeatAt: input.now,
          deliveryState: 'NOT_ATTEMPTED',
          cleanupOk: true,
        })
        .returning();
      if (row === undefined) {
        throw new NexaError({
          kind: 'INTERNAL',
          code: PLATFORM_ERROR_CODES.BACKUP_RUN_MISSING,
          message: 'The backup run row was inserted and returned nothing.',
        });
      }
      return { claimed: true, run: toRow(row) };
    } catch (error) {
      // Named constraint, not a bare 23505: the primary key can also violate
      // uniqueness, and reporting a duplicate id as "a backup is running" would
      // be a confident wrong answer rather than an honest error.
      if (!isUniqueViolation(error, 'backup_runs_single_active_idx')) throw error;

      const holder = await this.active();
      if (holder === null) {
        // The holder finished between our INSERT failing and this read. Rare,
        // real, and not something to paper over by retrying the insert here —
        // the caller decides whether to start again, and reporting BUSY with a
        // stale-but-true holder would be inventing a row.
        throw new NexaError({
          kind: 'CONFLICT',
          code: PLATFORM_ERROR_CODES.BACKUP_ALREADY_RUNNING,
          message:
            'Another backup held the lock when this one tried to start, and had released it by ' +
            'the time we looked. Try again.',
        });
      }
      return { claimed: false, reason: 'BUSY', holder };
    }
  }

  private async active(): Promise<BackupRunRow | null> {
    const [row] = await this.db
      .select()
      .from(backupRuns)
      .where(eq(backupRuns.state, 'RUNNING'))
      .limit(1);
    return row === undefined ? null : toRow(row);
  }

  async progress(input: {
    id: string;
    stage: BackupStage;
    leaseOwner: string;
    now: Date;
  }): Promise<void> {
    await this.db
      .update(backupRuns)
      .set({ stage: input.stage, leaseHeartbeatAt: input.now })
      .where(
        and(
          eq(backupRuns.id, input.id),
          eq(backupRuns.leaseOwner, input.leaseOwner),
          eq(backupRuns.state, 'RUNNING'),
        ),
      );
  }

  async heartbeat(input: { id: string; leaseOwner: string; now: Date }): Promise<void> {
    await this.db
      .update(backupRuns)
      .set({ leaseHeartbeatAt: input.now })
      .where(
        and(
          eq(backupRuns.id, input.id),
          eq(backupRuns.leaseOwner, input.leaseOwner),
          eq(backupRuns.state, 'RUNNING'),
        ),
      );
  }

  async finish(input: {
    id: string;
    leaseOwner: string;
    state: 'SUCCEEDED' | 'FAILED';
    stage: BackupStage;
    now: Date;
    dumpBytes?: bigint | null;
    archiveBytes?: bigint | null;
    checksum?: string | null;
    verifiedAt?: Date | null;
    deliveryState: BackupDeliveryState;
    deliveryAttemptedAt?: Date | null;
    deliveryDetail?: string | null;
    failureCode?: string | null;
    failureMessage?: string | null;
    cleanupOk: boolean;
    cleanupDetail?: string | null;
  }): Promise<void> {
    await this.db
      .update(backupRuns)
      .set({
        state: input.state,
        stage: input.stage,
        finishedAt: input.now,
        leaseHeartbeatAt: input.now,
        dumpBytes: input.dumpBytes ?? null,
        archiveBytes: input.archiveBytes ?? null,
        checksum: input.checksum ?? null,
        verifiedAt: input.verifiedAt ?? null,
        deliveryState: input.deliveryState,
        deliveryAttemptedAt: input.deliveryAttemptedAt ?? null,
        deliveryDetail: input.deliveryDetail ?? null,
        failureCode: input.failureCode ?? null,
        failureMessage: input.failureMessage ?? null,
        cleanupOk: input.cleanupOk,
        cleanupDetail: input.cleanupDetail ?? null,
      })
      .where(
        and(
          eq(backupRuns.id, input.id),
          // The lease guard. A process whose lease was reclaimed writes nothing
          // — its row belongs to the takeover now, and a late SUCCEEDED landing
          // on a row somebody else already failed would report success for a
          // run that was abandoned.
          eq(backupRuns.leaseOwner, input.leaseOwner),
          eq(backupRuns.state, 'RUNNING'),
        ),
      );
  }

  /**
   * Fails runs whose lease has gone stale, releasing the lock.
   *
   * A single conditional UPDATE, so two processes reclaiming at once is not a
   * race: `state = 'RUNNING'` is in the predicate, the row lock serialises them,
   * and the second one's UPDATE matches nothing.
   *
   * The abandoned run is CLOSED, never adopted. Its workspace belongs to a
   * process that may still be running — a paused VM, a stopped container about
   * to resume — and a second writer to the same dump path is how two partial
   * dumps become one plausible-looking corrupt archive. The files are left
   * where they are and named on the row, because deleting another process's
   * open output is the other way to corrupt it.
   */
  async reclaimStale(input: { staleBefore: Date; now: Date }): Promise<number> {
    const reclaimed = await this.db
      .update(backupRuns)
      .set({
        state: 'FAILED',
        finishedAt: input.now,
        failureCode: 'backup.lease_expired',
        failureMessage:
          'This run stopped reporting progress and its lease expired. The process that owned it ' +
          'is presumed gone; its workspace was left in place rather than removed by another process.',
        cleanupOk: false,
        cleanupDetail: 'workspace not removed: the owning process did not report',
      })
      .where(
        and(eq(backupRuns.state, 'RUNNING'), lt(backupRuns.leaseHeartbeatAt, input.staleBefore)),
      )
      .returning({ id: backupRuns.id });
    return reclaimed.length;
  }

  async latest(limit: number): Promise<readonly BackupRunRow[]> {
    const rows = await this.db
      .select()
      .from(backupRuns)
      .orderBy(desc(backupRuns.startedAt), desc(backupRuns.id))
      .limit(limit);
    return rows.map(toRow);
  }

  async byId(id: string): Promise<BackupRunRow | null> {
    const [row] = await this.db.select().from(backupRuns).where(eq(backupRuns.id, id)).limit(1);
    return row === undefined ? null : toRow(row);
  }

  /**
   * Runs whose delivery outcome was never observed.
   *
   * The reconciliation surface for `OUTCOME_UNKNOWN`. Nothing in V1 acts on
   * this automatically, and that is the design: resending a document Telegram
   * may already hold is a decision, and the state exists precisely because the
   * system does not know enough to make it. What it does is stop the unknown
   * from being invisible.
   */
  async withUnknownDelivery(limit: number): Promise<readonly BackupRunRow[]> {
    const rows = await this.db
      .select()
      .from(backupRuns)
      .where(eq(backupRuns.deliveryState, 'OUTCOME_UNKNOWN'))
      .orderBy(desc(backupRuns.startedAt), desc(backupRuns.id))
      .limit(limit);
    return rows.map(toRow);
  }

  /**
   * Removes finished runs old enough to have no operational value left.
   *
   * Bounded, because the caller drains in batches: an unbounded DELETE is one
   * long statement holding one connection.
   *
   * `ctid IN (SELECT ... LIMIT n)` is the same shape the session sweeper uses.
   * Two sweepers running at once is safe without any coordination: a DELETE of a
   * row another transaction has already deleted simply matches nothing, so the
   * worst case is a batch that removes fewer rows than it asked for — and the
   * caller drains until a batch comes back short, which is still correct. No
   * lock, no advisory anything, no assumption that one replica is running.
   *
   * Ordered OLDEST FIRST. Without an order a bounded batch takes an arbitrary
   * subset, so a table whose eligible backlog exceeds one pass would have rows
   * removed in no particular order and the oldest could survive indefinitely.
   */
  async purgeFinishedBefore(cutoff: Date, limit: number): Promise<number> {
    const rows = await this.db
      .delete(backupRuns)
      .where(
        sql`ctid IN (
          SELECT ctid FROM ${backupRuns} AS candidate
          WHERE candidate.finished_at IS NOT NULL
            AND candidate.finished_at < ${cutoff}
            -- A RUNNING row is the installation's backup lock. The finish-time
            -- test above already excludes every one of them, because the CHECK
            -- constraint makes the two equivalent. The state is named anyway: a
            -- reader must not have to know about that constraint to see that the
            -- lock is safe, and a future state that carries a finish time must
            -- not quietly become eligible.
            AND candidate.state <> 'RUNNING'
            -- An upload Telegram may have accepted and whose answer was lost.
            -- Nothing resends and nothing resolves it automatically, so this row
            -- is the only record that an archive may be in a chat.
            AND candidate.delivery_state <> 'OUTCOME_UNKNOWN'
            -- The most recent SUCCEEDED run: the scheduler reads it to decide
            -- whether a backup is due.
            AND candidate.id <> COALESCE(
              (SELECT newest.id FROM ${backupRuns} AS newest
                WHERE newest.state = 'SUCCEEDED'
                ORDER BY newest.started_at DESC, newest.id DESC
                LIMIT 1),
              '00000000-0000-0000-0000-000000000000'::uuid
            )
            -- And the most recent run of any state: the one being diagnosed.
            AND candidate.id <> COALESCE(
              (SELECT newest.id FROM ${backupRuns} AS newest
                ORDER BY newest.started_at DESC, newest.id DESC
                LIMIT 1),
              '00000000-0000-0000-0000-000000000000'::uuid
            )
          ORDER BY candidate.finished_at ASC, candidate.id ASC
          LIMIT ${limit}
        )`,
      )
      .returning({ id: backupRuns.id });
    return rows.length;
  }

  /** The most recent run that actually produced a verified artifact. */
  async lastSucceededAt(): Promise<Date | null> {
    const [row] = await this.db
      .select({ startedAt: backupRuns.startedAt })
      .from(backupRuns)
      .where(and(eq(backupRuns.state, 'SUCCEEDED'), sql`${backupRuns.verifiedAt} IS NOT NULL`))
      .orderBy(desc(backupRuns.startedAt))
      .limit(1);
    return row === undefined ? null : row.startedAt;
  }
}
