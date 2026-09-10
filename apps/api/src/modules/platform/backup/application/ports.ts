import type {
  BackupDeliveryState,
  BackupManifest,
  BackupRunState,
  BackupStage,
  BackupTrigger,
} from '@nexa/contracts';

/**
 * What the backup pipeline needs from the world, named by what it needs rather
 * than by what provides it.
 *
 * The application service below these is a sequence of stages and a set of
 * rules about which failures are fatal. It runs no process, opens no socket and
 * writes no file; every one of those is an adapter, which is what lets the
 * pipeline's rules be tested without a Telegram account and lets the archive be
 * tested without a scheduler.
 */

export interface DumpOutcome {
  readonly databaseName: string;
  readonly pgDumpVersion: string;
}

export interface VerifyOutcome {
  readonly ok: boolean;
  /** Named so a leaked scratch database is reportable rather than mysterious. */
  readonly scratchDatabase: string;
  /** Tables in `public` after the restore. Zero is a failure, not a success. */
  readonly tableCount: number;
  readonly detail: string | null;
}

export interface RestoreTarget {
  readonly database: string;
}

export interface DatabaseTools {
  readonly databaseName: string;
  pgDumpVersion(): Promise<string>;
  /** The SERVER's version, which decides whether a restore is a downgrade. */
  serverVersion(): Promise<string>;
  /** Custom-format dump of the whole database to `destination`. */
  dump(destination: string): Promise<DumpOutcome>;
  /**
   * Creates an EMPTY scratch database, restores `dumpPath` into it, checks that
   * something arrived, and drops it. Never touches the live database.
   */
  verifyRestore(dumpPath: string): Promise<VerifyOutcome>;
  /** The operator's restore. Refuses the live database as a target. */
  restoreInto(target: RestoreTarget, dumpPath: string): Promise<void>;
  /** Scratch databases whose DROP failed, for the cleanup stage to report. */
  readonly leaked: readonly string[];
}

/**
 * Where a run's files live while it runs, and the promise that they stop.
 *
 * `cleanup` runs on EVERY exit — success, failure, and the failure of the
 * cleanup itself — because the plaintext dump is the one artifact in this
 * pipeline that is a database with the encryption taken off. A run that dies at
 * the encrypt stage and leaves it behind has produced exactly the thing the
 * encryption was for.
 */
export interface BackupWorkspace {
  readonly dumpPath: string;
  readonly archivePath: string;
  /**
   * Where verification decrypts to — a second path, not `dumpPath`.
   *
   * HYGIENE, not a correctness rule, and it is labelled that way because the
   * first version of this comment claimed otherwise: it said sharing the path
   * would make the verification tautological. It would not. The decrypted bytes
   * are compared against a checksum taken BEFORE the encryption, so an archive
   * that decrypted to the wrong thing is caught whichever file it lands in —
   * and a falsification run confirmed it, with the two paths collapsed into one
   * and the whole integration suite still green.
   *
   * What it actually buys is not destroying an input while it is still held,
   * which keeps a failed decrypt from leaving one truncated file where two
   * distinct artifacts were.
   */
  readonly verifyDumpPath: string;
  /** Removes the plaintext dump. Returns what it could not remove. */
  discardPlaintext(): Promise<readonly string[]>;
  /** Removes everything, archive included. */
  discardAll(): Promise<readonly string[]>;
}

export interface BackupWorkspaceFactory {
  create(backupId: string): Promise<BackupWorkspace>;
}

/**
 * The delivery attempt's THREE outcomes, which is the point of this port.
 *
 * `OUTCOME_UNKNOWN` is not an error type. It is the honest answer when bytes
 * left this host and no verdict came back, and a transport that collapsed it
 * into either of the other two would be inventing a fact.
 */
export type DeliveryAttempt =
  | { readonly state: 'SUCCEEDED'; readonly detail: string | null }
  | { readonly state: 'FAILED_DEFINITIVE'; readonly detail: string }
  | { readonly state: 'OUTCOME_UNKNOWN'; readonly detail: string };

export interface BackupDelivery {
  /** Whether a destination is configured at all. */
  readonly configured: boolean;
  /**
   * Sends the encrypted archive as a document, with `caption`.
   *
   * The caption carries the backup's identity, size, checksum and verification
   * result and nothing else — no token, no connection string, no chat payload.
   */
  sendDocument(input: {
    readonly archivePath: string;
    readonly filename: string;
    readonly caption: string;
  }): Promise<DeliveryAttempt>;
  /**
   * Sends a message with no document.
   *
   * Used when the archive is above Telegram's ceiling: the group is told the
   * backup exists, is verified, and where it is — which is ADR-0011's third
   * compensating control, and is not the same thing as a failed delivery.
   */
  sendMessage(text: string): Promise<DeliveryAttempt>;
}

export interface BackupRunRow {
  readonly id: string;
  readonly trigger: BackupTrigger;
  readonly state: BackupRunState;
  readonly stage: BackupStage;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly leaseOwner: string;
  readonly leaseHeartbeatAt: Date;
  readonly dumpBytes: bigint | null;
  readonly archiveBytes: bigint | null;
  readonly checksum: string | null;
  readonly verifiedAt: Date | null;
  readonly deliveryState: BackupDeliveryState;
  readonly deliveryAttemptedAt: Date | null;
  readonly deliveryDetail: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly cleanupOk: boolean;
  readonly cleanupDetail: string | null;
}

/** What a start attempt learned. `BUSY` is a fact, never an error to retry. */
export type StartOutcome =
  | { readonly claimed: true; readonly run: BackupRunRow }
  | { readonly claimed: false; readonly reason: 'BUSY'; readonly holder: BackupRunRow };

export interface BackupRunRepository {
  /**
   * Inserts a RUNNING row, or reports who already holds the lock.
   *
   * The exclusion is the partial unique index, so this is correct across
   * processes and replicas without any of them agreeing on anything.
   */
  start(input: {
    readonly id: string;
    readonly trigger: BackupTrigger;
    readonly leaseOwner: string;
    readonly now: Date;
  }): Promise<StartOutcome>;

  /** Advances the stage and refreshes the lease in one write. */
  progress(input: {
    readonly id: string;
    readonly stage: BackupStage;
    readonly leaseOwner: string;
    readonly now: Date;
  }): Promise<void>;

  /** Refreshes the lease without changing the stage. */
  heartbeat(input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly now: Date;
  }): Promise<void>;

  finish(input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly state: 'SUCCEEDED' | 'FAILED';
    readonly stage: BackupStage;
    readonly now: Date;
    readonly dumpBytes?: bigint | null;
    readonly archiveBytes?: bigint | null;
    readonly checksum?: string | null;
    readonly verifiedAt?: Date | null;
    readonly deliveryState: BackupDeliveryState;
    readonly deliveryAttemptedAt?: Date | null;
    readonly deliveryDetail?: string | null;
    readonly failureCode?: string | null;
    readonly failureMessage?: string | null;
    readonly cleanupOk: boolean;
    readonly cleanupDetail?: string | null;
  }): Promise<void>;

  /**
   * Fails a run whose lease has gone stale, so the lock is released.
   *
   * Takes over by CLOSING the abandoned run, never by adopting it: its
   * temporary files belong to a process that may still be writing them, and a
   * second writer to the same paths is how two partial dumps become one
   * plausible-looking corrupt archive. Returns how many it closed.
   */
  reclaimStale(input: { readonly staleBefore: Date; readonly now: Date }): Promise<number>;

  latest(limit: number): Promise<readonly BackupRunRow[]>;
  byId(id: string): Promise<BackupRunRow | null>;
  /** Runs whose delivery outcome was never observed. For reconciliation. */
  withUnknownDelivery(limit: number): Promise<readonly BackupRunRow[]>;
  /**
   * When a run last produced a VERIFIED artifact.
   *
   * The scheduler's due calculation reads this rather than counting from its
   * own start, so a worker that restarts every twenty minutes does not take a
   * backup every twenty minutes — and so a run that failed does not reset the
   * clock as though it had succeeded.
   */
  lastSucceededAt(): Promise<Date | null>;

  /**
   * Removes at most `limit` FINISHED runs that ended before `cutoff`.
   *
   * Returns how many it removed, so the caller can drain in batches.
   *
   * Four classes of row are excluded, and every one of them is a correctness
   * exclusion rather than a preference. They are in the QUERY, not in the
   * caller: a predicate a caller has to remember is a predicate some caller will
   * not. ADR-0027 records the decision; the query's own comments record why each
   * row stays.
   *
   *   - `state = 'RUNNING'`. That row IS the installation's backup lock — the
   *     partial unique index is over it — so deleting one releases a lock a
   *     process is still holding, and two concurrent dumps would then write the
   *     same paths.
   *   - `delivery_state = 'OUTCOME_UNKNOWN'`. Telegram may have accepted an
   *     upload whose response was lost. Nothing resends automatically and
   *     nothing resolves it automatically, so the row is the only record that
   *     an archive may be sitting in a chat; `withUnknownDelivery` is what an
   *     operator reconciles from. Retained until resolved, indefinitely.
   *   - the most recent SUCCEEDED run. `lastSucceededAt()` reads it to decide
   *     whether a backup is due, so removing it makes the scheduler believe no
   *     backup has ever succeeded — and take one immediately, on a schedule that
   *     is then wrong for ever after.
   *   - the most recent run of ANY state. That is the run an operator is looking
   *     at when something has just gone wrong, and a `backup.run_failed`
   *     condition with no run to inspect is an alert that cannot be actioned.
   */
  purgeFinishedBefore(cutoff: Date, limit: number): Promise<number>;
}

/**
 * The encrypted container, as a port.
 *
 * `open` is the REAL restore path: the pipeline's verification stage and the
 * operator's restore command both go through it, so a verification cannot pass
 * by decrypting through a route nobody restores through. That is the whole
 * reason it is one method on one port rather than two conveniences.
 */
export interface BackupArchiver {
  seal(input: {
    readonly dumpPath: string;
    readonly archivePath: string;
    readonly manifest: BackupManifest;
  }): Promise<{ readonly archiveBytes: number; readonly keyId: string }>;
  open(input: { readonly archivePath: string; readonly dumpPath: string }): Promise<{
    readonly manifest: BackupManifest;
    readonly dumpChecksum: string;
    readonly dumpBytes: number;
  }>;
  /** SHA-256 over a file, streamed. What the manifest's checksum is taken with. */
  checksum(path: string): Promise<{ readonly checksum: string; readonly bytes: number }>;
}

export interface BackupManifestInput {
  readonly backupId: string;
  readonly installationId: string;
  readonly createdAt: Date;
  readonly databaseName: string;
  readonly postgresVersion: string;
  readonly pgDumpVersion: string;
  readonly dumpBytes: number;
  readonly checksum: string;
}

export type { BackupManifest };
