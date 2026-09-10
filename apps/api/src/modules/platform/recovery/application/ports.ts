import type { AppliedMigration } from '../../../../infrastructure/persistence/migration-state.js';
import type {
  RecoveryFailureCode,
  RecoveryMigrationVerdict,
  RecoveryRestoreTest,
  RecoverySource,
  RecoveryStage,
  RecoveryState,
  RecoveryVerification,
} from '@nexa/contracts';

/**
 * What recovery needs from the world.
 *
 * Two of these ports exist because Backup V1's equivalents answer a slightly
 * different question, and `docs/disaster-recovery-audit.md` § MISSING-4 records
 * the difference: `verifyRestore` creates a scratch database, restores, counts
 * tables and DROPS it — correct for the pipeline, wrong twice over here,
 * because a recovery has to keep the candidate it will cut over to and has to
 * read its migration state. So the operations are separated and
 * `verifyRestore` is rebuilt on top of them. There is still one `pg_restore`
 * call site.
 */

/** A candidate database's structural facts, read after a restore. */
export interface DatabaseInspection {
  /** Tables in `public`. Zero is the failure, not the success. */
  readonly tableCount: number;
  /**
   * The rows of `__drizzle_migrations`, for `compareMigrations`.
   *
   * `null` when the table does not exist — which is a real and distinguishable
   * state, not an error: a dump from before the migrator existed, or a database
   * restored from something that was never this application. It maps to
   * `recovery.migration_state_unreadable` rather than to a verdict, because a
   * missing history is not the same claim as an empty one.
   */
  readonly migrations: readonly AppliedMigration[] | null;
}

/**
 * The PostgreSQL operations a restore is made of, each on its own.
 *
 * Every one of them goes through the SAME `run()` in `pg-tools.ts` — argv
 * arrays, the password only ever in the child's environment, bounded captured
 * output, a timeout with a SIGKILL backstop, and `assertOutsideTransaction`.
 * Nothing here opens its own subprocess.
 */
export interface RestoreEngine {
  /** The live database's name, for the refusals below. */
  readonly liveDatabase: string;
  /** Creates an EMPTY database. Refuses a name that is not a plain identifier. */
  createDatabase(name: string): Promise<void>;
  /** Drops it, with FORCE, and reports rather than throws if it could not. */
  dropDatabase(name: string): Promise<{ readonly dropped: boolean }>;
  /**
   * Restores `dumpPath` into `name`, having first confirmed `name` is empty.
   *
   * The emptiness check is not a courtesy: `pg_restore` into a populated
   * database produces a half-merged result that exits non-zero on the conflicts
   * and leaves behind whatever it created first — which looks, to somebody
   * restoring under pressure, like a restore that nearly worked.
   */
  restoreIntoEmpty(name: string, dumpPath: string): Promise<void>;
  /**
   * Is this file a `pg_dump` CUSTOM-format archive?
   *
   * The five-byte magic, read from the head of the file. Asked before a restore
   * is attempted so that "this is not a pg_dump archive" and "pg_restore refused
   * this pg_dump archive" are two different answers on the row — the manifest
   * declares `dumpFormat: 'custom'`, and this is the only check that the payload
   * it travelled with agrees.
   */
  isCustomFormatDump(dumpPath: string): Promise<boolean>;
  /** Table count and migration history. Opens no transaction on the candidate. */
  inspectDatabase(name: string): Promise<DatabaseInspection>;
  /**
   * Applies this release's pending migrations to a CANDIDATE database.
   *
   * Only ever a candidate. The live database's migrations are the migrator's
   * job at boot, and a recovery that migrated production would be writing to
   * the one database this whole design exists to leave alone.
   */
  migrateCandidate(name: string): Promise<void>;
  /**
   * The cutover. The only irreversible operation in this module.
   *
   * Revokes CONNECT, terminates every other backend on the live database,
   * renames the live database to `displacedName`, renames `candidateName` to
   * the live name, and restores the grants. Metadata-only, so the irreversible
   * window is milliseconds rather than the length of a restore, and the
   * outgoing database survives under `displacedName` — which is what makes a
   * rollback two more renames instead of another restore.
   */
  cutover(input: { readonly candidateName: string; readonly displacedName: string }): Promise<void>;
}

/**
 * Where an uploaded artifact lives while a recovery is alive.
 *
 * Separate from `BackupWorkspace` because that one names its directory after the
 * backup id, which a recovery cannot do: an upload arrives before anything knows
 * what it is. The directory name is random, the directory is 0700, the files are
 * 0600, and `discard` runs on every exit path including the failures.
 */
export interface RecoveryWorkspace {
  readonly directory: string;
  /** The ENCRYPTED archive as received. Never overwritten. */
  readonly archivePath: string;
  /** Where verification decrypts to. A plaintext database; removed early. */
  readonly dumpPath: string;
  /** Removes the plaintext dump alone, keeping the archive. */
  discardPlaintext(): Promise<readonly string[]>;
  /** Removes the whole directory. Returns what it could not remove. */
  discard(): Promise<readonly string[]>;
}

export interface RecoveryWorkspaceFactory {
  create(recoveryId: string): Promise<RecoveryWorkspace>;
  /** Re-opens an existing workspace by its recorded path, for the executor. */
  open(directory: string): RecoveryWorkspace;
}

/**
 * The cutover journal: the one piece of recovery state that is NOT in the
 * database, because the database is what is being replaced.
 *
 * ADR-0028 § 4. The recovery row lives in the live database, which is what makes
 * it survive a browser close, an API restart and an executor restart — and the
 * live database is renamed away at cutover, while the restored candidate's own
 * `recovery_requests` holds the rows that were in the BACKUP. So the executor
 * writes here immediately before and after the renames, and that file is what
 * makes the rename itself crash-recoverable.
 *
 * It holds ids, database names, timestamps and a stage. No secrets: there is
 * nothing here a `\l` would not show an operator anyway.
 */
export interface CutoverJournal {
  write(entry: {
    readonly recoveryId: string;
    readonly phase: 'ABOUT_TO_RENAME' | 'RENAMED';
    readonly liveDatabase: string;
    readonly candidateDatabase: string;
    readonly displacedDatabase: string;
    readonly at: Date;
  }): Promise<void>;
  /** Reads a recovery's journal, for an executor that restarted mid-cutover. */
  read(recoveryId: string): Promise<{
    readonly phase: 'ABOUT_TO_RENAME' | 'RENAMED';
    readonly displacedDatabase: string;
  } | null>;
}

/** One recovery request row, as the application sees it. */
export interface RecoveryRequestRow {
  readonly id: string;
  readonly tenantId: string;
  readonly source: RecoverySource;
  readonly state: RecoveryState;
  readonly stage: RecoveryStage;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly finishedAt: Date | null;
  readonly requestedByAdminId: string | null;
  readonly requestedByLabel: string | null;
  readonly correlationId: string | null;
  readonly leaseOwner: string | null;
  readonly leaseHeartbeatAt: Date | null;
  readonly workspacePath: string | null;
  readonly uploadBytes: bigint | null;
  readonly uploadSha256: string | null;
  readonly clientFilename: string | null;
  readonly backupId: string | null;
  readonly artifactChecksum: string | null;
  readonly archiveKeyId: string | null;
  readonly verifiedAt: Date | null;
  readonly verification: RecoveryVerification | null;
  readonly restoreTest: RecoveryRestoreTest | null;
  readonly confirmedAt: Date | null;
  readonly confirmedByAdminId: string | null;
  readonly confirmedSessionId: string | null;
  readonly confirmedChecksum: string | null;
  readonly confirmationExpiresAt: Date | null;
  readonly preRestoreBackupId: string | null;
  readonly candidateDatabase: string | null;
  readonly displacedDatabase: string | null;
  readonly cutoverAt: Date | null;
  readonly failureCode: RecoveryFailureCode | null;
}

/** A keyset page of recovery requests. */
export interface RecoveryPage {
  readonly rows: readonly RecoveryRequestRow[];
  readonly nextCursor: string | null;
}

export interface RecoveryCursor {
  readonly createdAt: Date;
  readonly id: string;
}

/**
 * What may change about a request, and nothing else.
 *
 * Deliberately not `Partial<RecoveryRequestRow>`: `id`, `tenant_id`, `source`
 * and `created_at` are identity and must not be reachable from an update, and a
 * partial of the whole row would make them reachable.
 */
export interface RecoveryPatch {
  readonly stage?: RecoveryStage;
  readonly workspacePath?: string | null;
  readonly uploadBytes?: bigint | null;
  readonly uploadSha256?: string | null;
  readonly clientFilename?: string | null;
  readonly backupId?: string | null;
  readonly artifactChecksum?: string | null;
  readonly archiveKeyId?: string | null;
  readonly verifiedAt?: Date | null;
  readonly verification?: RecoveryVerification | null;
  readonly restoreTest?: RecoveryRestoreTest | null;
  readonly confirmedAt?: Date | null;
  readonly confirmedByAdminId?: string | null;
  readonly confirmedSessionId?: string | null;
  readonly confirmedChecksum?: string | null;
  readonly confirmationExpiresAt?: Date | null;
  readonly preRestoreBackupId?: string | null;
  readonly candidateDatabase?: string | null;
  readonly displacedDatabase?: string | null;
  readonly cutoverAt?: Date | null;
  readonly failureCode?: RecoveryFailureCode | null;
  readonly leaseOwner?: string | null;
}

export interface RecoveryRequestRepository {
  create(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly source: RecoverySource;
    readonly stage: RecoveryStage;
    readonly requestedByAdminId: string | null;
    readonly requestedByLabel: string | null;
    readonly correlationId: string | null;
    readonly now: Date;
  }): Promise<RecoveryRequestRow>;

  /**
   * Moves a request from `from` to `to`, or reports that it was not in `from`.
   *
   * A CONDITIONAL update, which is what makes every transition in this module
   * safe against a replay and against a second process: the state is in the
   * predicate, so the loser's UPDATE matches nothing and gets `false` back
   * rather than overwriting a decision somebody else made. This is the only way
   * a state changes — there is no `setState`.
   */
  transition(input: {
    readonly id: string;
    readonly from: readonly RecoveryState[];
    readonly to: RecoveryState;
    readonly now: Date;
    readonly patch?: RecoveryPatch;
    /** Required when `to` is terminal; refused otherwise by the CHECK. */
    readonly finished?: boolean;
    /** Guards the write on the lease, for executor-owned transitions. */
    readonly leaseOwner?: string;
  }): Promise<boolean>;

  /**
   * Advances the stage on a request that has NO lease yet.
   *
   * The upload phase runs in the API process, before any executor owns the
   * request, so there is no lease to guard the write with. A separate method
   * rather than an optional `leaseOwner`, because an optional one would make the
   * guard silently absent wherever a caller forgot to pass it — and the guard is
   * what stops an abandoned executor writing to a row the takeover now owns.
   *
   * Refuses a request that DOES have a lease: once an executor owns it, only the
   * owner writes.
   */
  progressUnowned(input: {
    readonly id: string;
    readonly stage: RecoveryStage;
    readonly now: Date;
    readonly patch?: RecoveryPatch;
  }): Promise<void>;

  /** Advances the stage and refreshes the lease in one write. */
  progress(input: {
    readonly id: string;
    readonly stage: RecoveryStage;
    readonly leaseOwner: string;
    readonly now: Date;
    readonly patch?: RecoveryPatch;
  }): Promise<void>;

  heartbeat(input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly now: Date;
  }): Promise<void>;

  byId(tenantId: string, id: string): Promise<RecoveryRequestRow | null>;
  /** Scope-free read, for the executor, which acts for the installation. */
  byIdUnscoped(id: string): Promise<RecoveryRequestRow | null>;
  page(input: {
    readonly tenantId: string;
    readonly limit: number;
    readonly cursor: RecoveryCursor | null;
  }): Promise<RecoveryPage>;

  /**
   * Claims the one confirmed request that is ready to execute.
   *
   * A conditional UPDATE that takes the lease, so two executor replicas cannot
   * both claim it — the second one's predicate no longer matches.
   */
  claimConfirmed(input: {
    readonly leaseOwner: string;
    readonly now: Date;
  }): Promise<RecoveryRequestRow | null>;

  /** Re-claims a request this lease already owns, after an executor restart. */
  claimOwn(input: {
    readonly leaseOwner: string;
    readonly now: Date;
  }): Promise<RecoveryRequestRow | null>;

  /**
   * Fails requests whose lease has gone stale, releasing the exclusion.
   *
   * Takes over by CLOSING, never by adopting: the abandoned request's candidate
   * database and workspace belong to a process that may still be writing them.
   * Returns the rows it closed so a caller can report them and name their
   * debris.
   */
  reclaimStale(input: {
    readonly staleBefore: Date;
    readonly now: Date;
  }): Promise<readonly RecoveryRequestRow[]>;

  /**
   * Whether a destructive recovery currently holds the installation, and
   * whether it is in a state that refuses writes.
   *
   * One read, two answers, because they are two different questions about the
   * same row and computing them separately is how they come to disagree.
   */
  installationLock(tx?: unknown): Promise<{
    readonly destructive: boolean;
    readonly quiescing: boolean;
    readonly recoveryId: string | null;
  } | null>;

  /**
   * Writes a request's whole state into whatever database is live NOW.
   *
   * The one method here that is an UPSERT rather than a conditional update, and
   * the reason is the cutover. ADR-0028 § 4: the row lives in the database the
   * cutover renames away, and the restored candidate carries the rows that were
   * in the BACKUP — which cannot include this recovery, because it had not
   * happened when the backup was taken. So immediately after the renames the
   * executor writes itself into the database it has just made production.
   *
   * Without this the recovery that produced a database leaves no trace in it, and
   * the executor's own next transition has no row to update — which is exactly
   * what happened: three integration cases failed with an absent row, against an
   * ADR that described this method as though it existed.
   *
   * `ON CONFLICT` because both outcomes are real: absent is the ordinary cutover
   * case, and present is the case where the restored artifact is a backup taken
   * DURING this same recovery — possible, because the mandatory pre-restore
   * backup is taken minutes earlier and an operator could in principle have
   * chosen it.
   */
  reassert(row: RecoveryRequestRow): Promise<void>;

  /** Bounded retention, same shape as `backup_runs`: exclusions in the QUERY. */
  purgeFinishedBefore(cutoff: Date, limit: number): Promise<number>;
}

/**
 * The migration verdict for a candidate, and the policy applied to it.
 *
 * A named type rather than a tuple because the two halves are read by different
 * code: the verdict goes on the row and into the response, and `permitted`
 * decides whether the executor proceeds.
 */
export interface CandidateCompatibility {
  readonly verdict: RecoveryMigrationVerdict;
  readonly applied: number;
  readonly expected: number;
  readonly permitted: boolean;
  /** Set when the verdict is BEHIND and migrating the candidate could fix it. */
  readonly migratable: boolean;
}
