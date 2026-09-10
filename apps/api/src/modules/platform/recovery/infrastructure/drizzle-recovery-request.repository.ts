import { and, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import {
  NexaError,
  PLATFORM_ERROR_CODES,
  RECOVERY_ACTIVE_DESTRUCTIVE_STATES,
  isDestructiveRecoveryState,
  quiescesInstallation,
  type RecoveryFailureCode,
  type RecoveryRestoreTest,
  type RecoverySource,
  type RecoveryStage,
  type RecoveryState,
  type RecoveryVerification,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { recoveryRequests } from '../../../../infrastructure/persistence/schema.js';
import { isUniqueViolation } from '../../../../infrastructure/persistence/sqlstate.js';
import type {
  RecoveryCursor,
  RecoveryPage,
  RecoveryPatch,
  RecoveryRequestRepository,
  RecoveryRequestRow,
} from '../application/ports.js';

/**
 * The recovery request table.
 *
 * Two things about this repository are load-bearing and easy to lose.
 *
 * EVERY STATE CHANGE IS A CONDITIONAL UPDATE. There is no `setState`, and the
 * `from` states are in the WHERE clause rather than checked by a caller who read
 * the row a moment ago. That is what makes a replayed confirmation, a
 * double-clicked button and a second executor replica all safe by the same
 * mechanism: the loser's UPDATE matches nothing and returns `false`, rather than
 * overwriting a decision somebody else already made. A read-then-write would be
 * a race in every one of those cases.
 *
 * THE DESTRUCTIVE EXCLUSION IS THE DATABASE'S, not this class's.
 * `recovery_requests_single_destructive_idx` is a partial unique index over a
 * constant, so a transition INTO a destructive state raises 23505 when one is
 * already running — across processes, with nothing agreeing on anything. This
 * repository turns that into a truthful refusal; it does not implement the rule.
 */

type Row = typeof recoveryRequests.$inferSelect;

function toRow(row: Row): RecoveryRequestRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    source: row.source as RecoverySource,
    state: row.state as RecoveryState,
    stage: row.stage as RecoveryStage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
    requestedByAdminId: row.requestedByAdminId,
    requestedByLabel: row.requestedByLabel,
    correlationId: row.correlationId,
    leaseOwner: row.leaseOwner,
    leaseHeartbeatAt: row.leaseHeartbeatAt,
    workspacePath: row.workspacePath,
    uploadBytes: row.uploadBytes,
    uploadSha256: row.uploadSha256,
    clientFilename: row.clientFilename,
    backupId: row.backupId,
    artifactChecksum: row.artifactChecksum,
    archiveKeyId: row.archiveKeyId,
    verifiedAt: row.verifiedAt,
    verification: row.verification as RecoveryVerification | null,
    restoreTest: row.restoreTest as RecoveryRestoreTest | null,
    confirmedAt: row.confirmedAt,
    confirmedByAdminId: row.confirmedByAdminId,
    confirmedSessionId: row.confirmedSessionId,
    confirmedChecksum: row.confirmedChecksum,
    confirmationExpiresAt: row.confirmationExpiresAt,
    preRestoreBackupId: row.preRestoreBackupId,
    candidateDatabase: row.candidateDatabase,
    displacedDatabase: row.displacedDatabase,
    cutoverAt: row.cutoverAt,
    failureCode: row.failureCode as RecoveryFailureCode | null,
  };
}

/** The columns a patch may touch, translated once. */
function patchColumns(patch: RecoveryPatch): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  const assign = <K extends keyof RecoveryPatch>(key: K, column: string): void => {
    if (patch[key] !== undefined) set[column] = patch[key];
  };
  assign('stage', 'stage');
  assign('workspacePath', 'workspacePath');
  assign('uploadBytes', 'uploadBytes');
  assign('uploadSha256', 'uploadSha256');
  assign('clientFilename', 'clientFilename');
  assign('backupId', 'backupId');
  assign('artifactChecksum', 'artifactChecksum');
  assign('archiveKeyId', 'archiveKeyId');
  assign('verifiedAt', 'verifiedAt');
  assign('verification', 'verification');
  assign('restoreTest', 'restoreTest');
  assign('confirmedAt', 'confirmedAt');
  assign('confirmedByAdminId', 'confirmedByAdminId');
  assign('confirmedSessionId', 'confirmedSessionId');
  assign('confirmedChecksum', 'confirmedChecksum');
  assign('confirmationExpiresAt', 'confirmationExpiresAt');
  assign('preRestoreBackupId', 'preRestoreBackupId');
  assign('candidateDatabase', 'candidateDatabase');
  assign('displacedDatabase', 'displacedDatabase');
  assign('cutoverAt', 'cutoverAt');
  assign('failureCode', 'failureCode');
  assign('leaseOwner', 'leaseOwner');
  return set;
}

export class DrizzleRecoveryRequestRepository implements RecoveryRequestRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    id: string;
    tenantId: string;
    source: RecoverySource;
    stage: RecoveryStage;
    requestedByAdminId: string | null;
    requestedByLabel: string | null;
    correlationId: string | null;
    now: Date;
  }): Promise<RecoveryRequestRow> {
    const [row] = await this.db
      .insert(recoveryRequests)
      .values({
        id: input.id,
        tenantId: input.tenantId,
        source: input.source,
        // Always `UPLOADED`: the machine's initial state, and the only state a
        // request may be created in. A request that could be created already
        // verified would be a request whose verification nothing performed.
        state: 'UPLOADED',
        stage: input.stage,
        createdAt: input.now,
        updatedAt: input.now,
        requestedByAdminId: input.requestedByAdminId,
        requestedByLabel: input.requestedByLabel,
        correlationId: input.correlationId,
      })
      .returning();
    if (row === undefined) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.RECOVERY_REFUSED,
        message: 'The recovery request row was inserted and returned nothing.',
      });
    }
    return toRow(row);
  }

  async transition(input: {
    id: string;
    from: readonly RecoveryState[];
    to: RecoveryState;
    now: Date;
    patch?: RecoveryPatch;
    finished?: boolean;
    leaseOwner?: string;
  }): Promise<boolean> {
    const terminal = input.to === 'SUCCEEDED' || input.to === 'FAILED';
    const predicates = [
      eq(recoveryRequests.id, input.id),
      inArray(recoveryRequests.state, [...input.from]),
    ];
    if (input.leaseOwner !== undefined) {
      // The lease guard, exactly as `backup_runs` uses one. A process whose
      // lease was reclaimed while it was still working must write nothing
      // afterwards: the row belongs to the takeover now, and a late SUCCEEDED
      // landing on a row somebody else already failed would report success for
      // an operation that was abandoned.
      predicates.push(eq(recoveryRequests.leaseOwner, input.leaseOwner));
    }
    try {
      const updated = await this.db
        .update(recoveryRequests)
        .set({
          state: input.to,
          updatedAt: input.now,
          // The CHECK constraint ties these together, so this is not a
          // convenience: a terminal state without a finish time, or a live one
          // with it, is refused by the database.
          finishedAt: terminal ? input.now : null,
          ...patchColumns(input.patch ?? {}),
        })
        .where(and(...predicates))
        .returning({ id: recoveryRequests.id });
      return updated.length > 0;
    } catch (error) {
      // Named constraint, never a bare 23505: the primary key can also violate
      // uniqueness, and reporting that as "a recovery is already running" would
      // be a confident wrong answer.
      if (isUniqueViolation(error, 'recovery_requests_single_destructive_idx')) {
        throw new NexaError({
          kind: 'CONFLICT',
          code: PLATFORM_ERROR_CODES.RECOVERY_ALREADY_ACTIVE,
          message:
            'Another recovery is already restoring this installation. One destructive recovery ' +
            'runs at a time.',
        });
      }
      throw error;
    }
  }

  /**
   * The upload phase's write: no lease, and refuses one that has an owner.
   *
   * `lease_owner IS NULL` is in the predicate rather than left implicit. Without
   * it this method would be a way to write to a request an executor is actively
   * restoring with, from the API process, which is precisely what the lease
   * guard on `progress` exists to prevent.
   */
  async progressUnowned(input: {
    id: string;
    stage: RecoveryStage;
    now: Date;
    patch?: RecoveryPatch;
  }): Promise<void> {
    await this.db
      .update(recoveryRequests)
      .set({
        stage: input.stage,
        updatedAt: input.now,
        ...patchColumns(input.patch ?? {}),
      })
      .where(and(eq(recoveryRequests.id, input.id), sql`${recoveryRequests.leaseOwner} IS NULL`));
  }

  async progress(input: {
    id: string;
    stage: RecoveryStage;
    leaseOwner: string;
    now: Date;
    patch?: RecoveryPatch;
  }): Promise<void> {
    await this.db
      .update(recoveryRequests)
      .set({
        stage: input.stage,
        leaseHeartbeatAt: input.now,
        updatedAt: input.now,
        ...patchColumns(input.patch ?? {}),
      })
      .where(
        and(eq(recoveryRequests.id, input.id), eq(recoveryRequests.leaseOwner, input.leaseOwner)),
      );
  }

  async heartbeat(input: { id: string; leaseOwner: string; now: Date }): Promise<void> {
    await this.db
      .update(recoveryRequests)
      .set({ leaseHeartbeatAt: input.now })
      .where(
        and(eq(recoveryRequests.id, input.id), eq(recoveryRequests.leaseOwner, input.leaseOwner)),
      );
  }

  /**
   * One request, SCOPED.
   *
   * The tenant is in the predicate rather than compared after the read, so a
   * caller cannot forget the comparison and so the answer for another scope's id
   * is indistinguishable from the answer for an id that does not exist. That
   * distinction is the disclosure: a permission-denied for an id that exists
   * somewhere else tells the caller it exists somewhere else.
   */
  async byId(tenantId: string, id: string): Promise<RecoveryRequestRow | null> {
    const [row] = await this.db
      .select()
      .from(recoveryRequests)
      .where(and(eq(recoveryRequests.id, id), eq(recoveryRequests.tenantId, tenantId)))
      .limit(1);
    return row === undefined ? null : toRow(row);
  }

  /**
   * One request, unscoped, for the EXECUTOR.
   *
   * The executor acts for the installation rather than for an administrator: it
   * has already been handed the row by `claimConfirmed`, and re-reading it under
   * a tenant it would have to derive from that same row would be a scope check
   * against itself. Named `Unscoped` so a surface cannot reach for it by
   * accident and a reviewer sees it in a diff.
   */
  async byIdUnscoped(id: string): Promise<RecoveryRequestRow | null> {
    const [row] = await this.db
      .select()
      .from(recoveryRequests)
      .where(eq(recoveryRequests.id, id))
      .limit(1);
    return row === undefined ? null : toRow(row);
  }

  async page(input: {
    tenantId: string;
    limit: number;
    cursor: RecoveryCursor | null;
  }): Promise<RecoveryPage> {
    const predicates = [eq(recoveryRequests.tenantId, input.tenantId)];
    if (input.cursor !== null) {
      // A ROW comparison, not `created_at < x OR (created_at = x AND id < y)`
      // spelled out: the tuple form is what the btree can use as an index
      // condition, and the spelled-out form is what silently degrades to a sort.
      predicates.push(
        sql`(${recoveryRequests.createdAt}, ${recoveryRequests.id}) < (${input.cursor.createdAt}, ${input.cursor.id})`,
      );
    }
    // One row more than asked for, which is how the caller learns there IS a
    // next page without a second COUNT query that could disagree with this one.
    const rows = await this.db
      .select()
      .from(recoveryRequests)
      .where(and(...predicates))
      .orderBy(desc(recoveryRequests.createdAt), desc(recoveryRequests.id))
      .limit(input.limit + 1);

    const page = rows.slice(0, input.limit).map(toRow);
    const last = page.at(-1);
    const nextCursor =
      rows.length > input.limit && last !== undefined
        ? `${last.createdAt.toISOString()}|${last.id}`
        : null;
    return { rows: page, nextCursor };
  }

  /**
   * Takes the lease on the one confirmed request that is ready to execute.
   *
   * A single conditional UPDATE, so two executor replicas is not a race: the
   * state is in the predicate, the row lock serialises them, and the second
   * one's UPDATE matches nothing. `RESTORE_REQUESTED` only — a request further
   * along already has an owner, and one earlier has not been confirmed.
   *
   * The lease owner is set here rather than by the caller afterwards, because a
   * claim and a lease taken in two statements is a window in which a third
   * process sees an owner-less request in a destructive state.
   */
  async claimConfirmed(input: {
    leaseOwner: string;
    now: Date;
  }): Promise<RecoveryRequestRow | null> {
    const [row] = await this.db
      .update(recoveryRequests)
      .set({ leaseOwner: input.leaseOwner, leaseHeartbeatAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(recoveryRequests.state, 'RESTORE_REQUESTED'),
          sql`${recoveryRequests.leaseOwner} IS NULL`,
        ),
      )
      .returning();
    return row === undefined ? null : toRow(row);
  }

  /**
   * Re-claims a request this lease already owns.
   *
   * The executor-restart case. A process that comes back with the same identity
   * finds its own in-flight request rather than waiting for its own lease to go
   * stale — which would take fifteen minutes with the installation quiesced.
   */
  async claimOwn(input: { leaseOwner: string; now: Date }): Promise<RecoveryRequestRow | null> {
    const [row] = await this.db
      .update(recoveryRequests)
      .set({ leaseHeartbeatAt: input.now })
      .where(
        and(
          eq(recoveryRequests.leaseOwner, input.leaseOwner),
          inArray(recoveryRequests.state, [...RECOVERY_ACTIVE_DESTRUCTIVE_STATES]),
        ),
      )
      .returning();
    return row === undefined ? null : toRow(row);
  }

  /**
   * Fails requests whose lease has gone stale, releasing the exclusion.
   *
   * Closed, never adopted — the same rule as an abandoned backup, and here it
   * matters more: an abandoned recovery may own a candidate database that a
   * process is still restoring into, and a second restorer writing into it is
   * how two partial restores become one plausible-looking database.
   *
   * Returns the rows, not a count, because the caller has to name their debris:
   * a candidate database and a workspace directory are left where they are, and
   * an operator who is not told their names cannot clean them up.
   */
  async reclaimStale(input: {
    staleBefore: Date;
    now: Date;
  }): Promise<readonly RecoveryRequestRow[]> {
    const rows = await this.db
      .update(recoveryRequests)
      .set({
        state: 'FAILED',
        finishedAt: input.now,
        updatedAt: input.now,
        failureCode: 'recovery.lease_expired',
      })
      .where(
        and(
          inArray(recoveryRequests.state, [...RECOVERY_ACTIVE_DESTRUCTIVE_STATES]),
          sql`${recoveryRequests.leaseHeartbeatAt} IS NOT NULL`,
          lt(recoveryRequests.leaseHeartbeatAt, input.staleBefore),
        ),
      )
      .returning();
    return rows.map(toRow);
  }

  /**
   * Whether a destructive recovery holds the installation right now.
   *
   * ONE read answering two questions, because they are two questions about the
   * same row: whether a second recovery may start, and whether durable writes
   * are refused. Computing them from separate queries is how they come to
   * disagree — and the disagreement would be between "a database is about to be
   * renamed" and "writes are allowed".
   *
   * Takes the caller's transaction when it has one. The write gate consults this
   * INSIDE the transaction it is about to permit, so a quiesce that commits
   * between a check and a write cannot be overtaken.
   */
  async installationLock(
    tx?: unknown,
  ): Promise<{ destructive: boolean; quiescing: boolean; recoveryId: string | null } | null> {
    /*
     * The caller's transaction, UNWRAPPED.
     *
     * Callers hand this a `TransactionScope` — `{ tx, scope }` — and not a raw
     * executor, because that is what the unit of work's callback receives and
     * what every other `tx?: unknown` parameter in this codebase is given.
     * `DrizzleAuditWriter` does exactly this, and the first version here did not:
     * it cast the scope straight to an `Executor`, which produced
     * `executor.select is not a function` on every write in the suite.
     */
    const executor: Executor = (tx as TransactionScope | undefined)?.tx ?? this.db;
    const [row] = await executor
      .select({ id: recoveryRequests.id, state: recoveryRequests.state })
      .from(recoveryRequests)
      .where(inArray(recoveryRequests.state, [...RECOVERY_ACTIVE_DESTRUCTIVE_STATES]))
      .limit(1);
    if (row === undefined) return null;
    const state = row.state as RecoveryState;
    return {
      destructive: isDestructiveRecoveryState(state),
      quiescing: quiescesInstallation(state),
      recoveryId: row.id,
    };
  }

  /**
   * Writes the whole row into whatever database is live now. See the port.
   *
   * Every column, because this is the only write that has to reconstruct a row
   * rather than advance one: there is nothing in the target to merge with.
   */
  async reassert(row: RecoveryRequestRow): Promise<void> {
    const values = {
      id: row.id,
      tenantId: row.tenantId,
      source: row.source,
      state: row.state,
      stage: row.stage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      finishedAt: row.finishedAt,
      requestedByAdminId: row.requestedByAdminId,
      requestedByLabel: row.requestedByLabel,
      correlationId: row.correlationId,
      leaseOwner: row.leaseOwner,
      leaseHeartbeatAt: row.leaseHeartbeatAt,
      workspacePath: row.workspacePath,
      uploadBytes: row.uploadBytes,
      uploadSha256: row.uploadSha256,
      clientFilename: row.clientFilename,
      backupId: row.backupId,
      artifactChecksum: row.artifactChecksum,
      archiveKeyId: row.archiveKeyId,
      verifiedAt: row.verifiedAt,
      verification: row.verification,
      restoreTest: row.restoreTest,
      confirmedAt: row.confirmedAt,
      confirmedByAdminId: row.confirmedByAdminId,
      confirmedSessionId: row.confirmedSessionId,
      confirmedChecksum: row.confirmedChecksum,
      confirmationExpiresAt: row.confirmationExpiresAt,
      preRestoreBackupId: row.preRestoreBackupId,
      candidateDatabase: row.candidateDatabase,
      displacedDatabase: row.displacedDatabase,
      cutoverAt: row.cutoverAt,
      failureCode: row.failureCode,
    };
    /*
     * `requested_by_admin_id` and `confirmed_by_admin_id` are deliberately NOT
     * foreign keys on this table, which is what makes this write possible: the
     * administrator who confirmed a recovery may not exist in the database being
     * restored — they could have been created after the backup was taken — and a
     * constraint would make the re-assert fail at the one moment it cannot.
     *
     * `tenant_id` IS a foreign key, and that one is safe: the installation's
     * primary tenant is in every backup of it, because it is what the backup is
     * a backup OF.
     */
    await this.db.transaction(async (tx) => {
      /*
       * FIRST, close any OTHER destructive row this database came with.
       *
       * The rows in the restored database are the backup's rows, and a backup
       * taken while some recovery was in flight carries that recovery in a
       * destructive state — `PRE_RESTORE_BACKUP` for certain, because the
       * mandatory pre-restore backup is taken while the row is in exactly that
       * state and the dump excludes nothing. Restoring a `PRE_RESTORE` archive,
       * which is precisely what a rollback restores, therefore lands a row in
       * `recovery_requests_single_destructive_idx`'s predicate — and the upsert
       * below, which writes `RESTARTING`, then raises 23505 on that partial index
       * rather than on the primary key. `onConflictDoUpdate` targets `id` and
       * does not cover it, so a SUCCESSFUL cutover ended as
       * `recovery.internal`, with the row written by the failure path claiming
       * no cutover had happened.
       *
       * Those rows are snapshot artefacts by definition: they describe a
       * recovery that was in flight when the backup was taken, which cannot be in
       * flight now — this executor holds the only destructive lease. They are
       * FAILED rather than deleted, because a row an operator can read and date is
       * worth more than a clean table.
       */
      await tx
        .update(recoveryRequests)
        .set({
          state: 'FAILED',
          stage: 'CLEANUP',
          failureCode: 'recovery.lease_expired',
          finishedAt: row.updatedAt,
          updatedAt: row.updatedAt,
          leaseOwner: null,
          leaseHeartbeatAt: null,
        })
        .where(
          and(
            ne(recoveryRequests.id, row.id),
            inArray(recoveryRequests.state, [...RECOVERY_ACTIVE_DESTRUCTIVE_STATES]),
          ),
        );

      await tx
        .insert(recoveryRequests)
        .values(values)
        .onConflictDoUpdate({ target: recoveryRequests.id, set: values });
    });
  }

  /**
   * Bounded retention, the same shape as `backup_runs` — exclusions in the
   * QUERY, not in the caller, because a predicate a caller has to remember is a
   * predicate some caller will not.
   *
   * Two classes of row are excluded, and both are correctness rather than
   * preference:
   *
   *   - anything not FINISHED. A live request in a destructive state IS the
   *     installation's recovery exclusion, and deleting one would let a second
   *     destructive recovery start while the first is still renaming databases.
   *     The finish-time test already covers this because the CHECK makes the two
   *     equivalent; the state is named anyway, so a reader does not have to know
   *     about that constraint to see the lock is safe.
   *   - any row that NAMES A DISPLACED DATABASE, whether or not it records a
   *     cutover. That name is the only record of where the data production used
   *     to hold went — deleting one leaves an operator with a
   *     `nexa_pre_restore_*` database on their disk and nothing that says what it
   *     is or whether it may be dropped. Kept indefinitely, like an unresolved
   *     `OUTCOME_UNKNOWN` delivery, and for the same reason: it is the only trace
   *     of a thing somebody still has to decide about.
   *
   *     `cutover_at` alone is not the test, because a cutover that renamed the
   *     outgoing database and failed to rename the candidate into place has the
   *     displaced name and NO cutover — the `RENAMED_OUT` window. Keying retention
   *     on `cutover_at` would purge exactly the row describing the worst state
   *     this operation can end in.
   */
  async purgeFinishedBefore(cutoff: Date, limit: number): Promise<number> {
    const rows = await this.db
      .delete(recoveryRequests)
      .where(
        and(
          sql`${recoveryRequests.finishedAt} IS NOT NULL`,
          lt(recoveryRequests.finishedAt, cutoff),
          sql`${recoveryRequests.state} NOT IN (${sql.join(
            RECOVERY_ACTIVE_DESTRUCTIVE_STATES.map((state) => sql`${state}`),
            sql`, `,
          )})`,
          sql`${recoveryRequests.cutoverAt} IS NULL`,
          sql`${recoveryRequests.displacedDatabase} IS NULL`,
          sql`${recoveryRequests.id} IN (
            SELECT candidate.id FROM ${recoveryRequests} AS candidate
             WHERE candidate.finished_at IS NOT NULL
               AND candidate.finished_at < ${cutoff}
               AND candidate.cutover_at IS NULL
               AND candidate.displaced_database IS NULL
             ORDER BY candidate.finished_at ASC, candidate.id ASC
             LIMIT ${limit}
          )`,
        ),
      )
      .returning({ id: recoveryRequests.id });
    return rows.length;
  }
}

/** Parses a page cursor, or refuses it. Exported so a surface can validate. */
export function parseRecoveryCursor(raw: string): RecoveryCursor | null {
  const separator = raw.indexOf('|');
  if (separator <= 0) return null;
  const at = new Date(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (Number.isNaN(at.getTime())) return null;
  return { createdAt: at, id };
}
