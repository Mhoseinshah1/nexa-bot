import {
  BACKUP_LEASE_STALE_AFTER_MS,
  type BackupRunState,
  type BackupStage,
  type Clock,
} from '@nexa/contracts';

/**
 * Removes what a KILLED run left in its working directory (Round 8, B1).
 *
 * A run that fails removes its own workspace in its `catch`/`finally`. A run whose PROCESS
 * died — the worker SIGKILLed or OOM-killed mid-dump, the container stopped by an update —
 * cannot, and before this its files waited for the housekeeping debris sweep, which leaves
 * plaintext alone for a day (`plaintextGraceMs`) and archives for the retention window
 * (30 days). On a small host that was 2.4 GB of `dump.pgcustom`/`verify.pgcustom` per kill,
 * and the next run failed for the disk the last one had left full.
 *
 * WHAT IT MAY TOUCH. ADR-0025: a stale lease is taken over by FAILING the abandoned run,
 * never by adopting it, because its files belong to a process that may still be writing
 * them. So a directory is touched only when ALL of these hold, and each is a separate test
 * (`decideOrphanDirectory`):
 *
 *   - the run has a row in THIS database, and the row is terminal (never RUNNING, whatever
 *     its lease says: a RUNNING row is reclaimed by `reclaimStale` first, which FAILS it);
 *   - the row's lease heartbeat is older than `BACKUP_LEASE_STALE_AFTER_MS`, the same window
 *     after which the installation already presumes the owner gone;
 *   - nothing in the directory has been written for `minAgeMs`: a writer that is still
 *     alive — a paused VM that resumed — touches its files, and those are left alone;
 *   - no unfinished recovery names the run.
 *
 * A directory with NO row is never touched here: it may belong to another installation
 * sharing the volume, or be a pre-restore backup the restored database has no row for. The
 * housekeeping debris sweep handles its plaintext on its own, longer, grace.
 *
 * WHAT IT REMOVES. Plaintext — `dump.pgcustom`, `verify.pgcustom`, the 7-Zip manifest — is
 * what fills a disk (2.4 GB a run on the evidence's host), and it is removed from every
 * directory that passes the tests above. The ARCHIVE is removed only with the whole directory
 * of a FAILED run that its own process failed before verification passed (stage DUMP to
 * VERIFY_RESTORE, no `verified_at`, not reclaimed) — the run whose own `catch` would have
 * removed exactly that. Everything else keeps its archive for retention to decide:
 *
 *   - a SUCCEEDED run, so the newest good archive is outside this sweep's reach by
 *     construction, not by a keep count;
 *   - a FAILED run that had verified (it failed at DELIVER or CLEANUP);
 *   - a run RECLAIMED as abandoned (`backup.lease_expired`). Its row cannot say how far it
 *     got — only `finish` writes `verified_at` — and a restored database ALWAYS holds such a
 *     row: the dump captured the run that took it while it was RUNNING, so after a restore
 *     that row is reclaimed with stage DUMP while its directory holds the verified archive
 *     the installation was restored from.
 *
 * Run at worker start and inside `BackupService.run` right after the run claimed the
 * one-backup lock, when no other run of this installation can be in flight.
 */

/** A run directory under the backup root, with the newest write time of it and its files. */
export interface BackupRunDirectory {
  readonly id: string;
  readonly lastWrittenAt: Date;
}

export interface BackupRunDirectoryStore {
  /** Directories named by a run id (a UUID). Never a CLI scratch directory. */
  listRunDirectories(): Promise<readonly BackupRunDirectory[]>;
  /** Removes one run's directory, archive included. Returns what survived. */
  removeRunDirectory(backupId: string): Promise<readonly string[]>;
  /** Removes one run directory's plaintext files, never its archive. */
  removeRunPlaintext(
    backupId: string,
  ): Promise<{ readonly removed: readonly string[]; readonly survived: readonly string[] }>;
}

export interface BackupOrphanRunFacts {
  readonly id: string;
  readonly state: BackupRunState;
  /** The stage it was in when it ended: a run that never reached DELIVER never verified. */
  readonly stage: BackupStage;
  /** `backup.lease_expired` for a run reclaimed as abandoned. */
  readonly failureCode: string | null;
  readonly leaseHeartbeatAt: Date;
  readonly verifiedAt: Date | null;
}

export interface BackupOrphanRunReader {
  /** The rows of these ids that exist. */
  orphanRunFacts(ids: readonly string[]): Promise<readonly BackupOrphanRunFacts[]>;
  /** Conditional: never a RUNNING row, never twice. */
  markArchivePruned(input: { readonly id: string; readonly now: Date }): Promise<boolean>;
}

/**
 * The stages before verification passed. A run that ended in one of them has no proven
 * archive. A run that reached DELIVER had one — and a run killed mid-delivery has no
 * `verified_at` (only `finish` writes it) while Telegram may hold some of its parts, so its
 * local copy is what an operator reconciles against: it keeps its archive.
 */
const UNVERIFIED_STAGES: ReadonlySet<BackupStage> = new Set([
  'DUMP',
  'CHECKSUM',
  'ENCRYPT',
  'VERIFY_RESTORE',
]);

/** What `reclaimStale` writes on a run it closed as abandoned. */
const BACKUP_LEASE_EXPIRED_CODE = 'backup.lease_expired';

export type OrphanDecision = 'KEEP' | 'REMOVE_PLAINTEXT' | 'REMOVE_DIRECTORY';

/** Files untouched for this long, on a run whose lease is stale, have no live writer. */
export const BACKUP_ORPHAN_MIN_AGE_MS = BACKUP_LEASE_STALE_AFTER_MS;

/** The one decision, pure, so each of its conditions is tested on its own. */
export function decideOrphanDirectory(input: {
  readonly directory: BackupRunDirectory;
  readonly row: BackupOrphanRunFacts | null;
  readonly now: Date;
  readonly minAgeMs: number;
  readonly leaseStaleAfterMs: number;
  readonly protectedIds: ReadonlySet<string>;
  readonly exceptId: string | null;
}): OrphanDecision {
  const { directory, row, now } = input;
  if (directory.id === input.exceptId) return 'KEEP';
  if (input.protectedIds.has(directory.id)) return 'KEEP';
  if (row === null) return 'KEEP';
  if (row.state === 'RUNNING') return 'KEEP';
  if (now.getTime() - row.leaseHeartbeatAt.getTime() <= input.leaseStaleAfterMs) return 'KEEP';
  if (now.getTime() - directory.lastWrittenAt.getTime() < input.minAgeMs) return 'KEEP';
  if (
    row.state === 'FAILED' &&
    row.verifiedAt === null &&
    UNVERIFIED_STAGES.has(row.stage) &&
    row.failureCode !== BACKUP_LEASE_EXPIRED_CODE
  ) {
    return 'REMOVE_DIRECTORY';
  }
  return 'REMOVE_PLAINTEXT';
}

export interface BackupOrphanSweepResult {
  /** Run directories removed whole (FAILED, never verified). */
  readonly directories: readonly string[];
  /** Plaintext files removed from directories whose archive stays. */
  readonly files: readonly string[];
  /** What it tried to remove and could not. */
  readonly survived: readonly string[];
}

export interface BackupOrphanSweepDeps {
  readonly directories: BackupRunDirectoryStore;
  readonly runs: BackupOrphanRunReader;
  readonly clock: Clock;
  /** Run ids an unfinished recovery refers to. Never touched. */
  readonly protectedByRecovery: () => Promise<readonly string[]>;
  readonly minAgeMs?: number;
  readonly leaseStaleAfterMs?: number;
  readonly logger: {
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
  };
}

export class BackupOrphanSweep {
  constructor(private readonly deps: BackupOrphanSweepDeps) {}

  /**
   * One pass. `exceptId` is the caller's own run, whose directory it is about to write.
   * Throws only when the root or the table cannot be read; a file that will not go is
   * reported in `survived`.
   */
  async sweep(input: { readonly exceptId?: string } = {}): Promise<BackupOrphanSweepResult> {
    const directories: string[] = [];
    const files: string[] = [];
    const survived: string[] = [];
    const found = await this.deps.directories.listRunDirectories();
    if (found.length === 0) return { directories, files, survived };
    const rows = new Map(
      (await this.deps.runs.orphanRunFacts(found.map((one) => one.id))).map((row) => [row.id, row]),
    );
    const protectedIds = new Set(await this.deps.protectedByRecovery());
    const now = this.deps.clock.now();
    for (const directory of found) {
      const decision = decideOrphanDirectory({
        directory,
        row: rows.get(directory.id) ?? null,
        now,
        minAgeMs: this.deps.minAgeMs ?? BACKUP_ORPHAN_MIN_AGE_MS,
        leaseStaleAfterMs: this.deps.leaseStaleAfterMs ?? BACKUP_LEASE_STALE_AFTER_MS,
        protectedIds,
        exceptId: input.exceptId ?? null,
      });
      if (decision === 'REMOVE_DIRECTORY') {
        const left = await this.deps.directories.removeRunDirectory(directory.id);
        if (left.length > 0) {
          survived.push(...left);
          continue;
        }
        directories.push(directory.id);
        // The row says the directory is gone, so the run-row purge may take it later.
        await this.deps.runs.markArchivePruned({ id: directory.id, now });
      } else if (decision === 'REMOVE_PLAINTEXT') {
        const outcome = await this.deps.directories.removeRunPlaintext(directory.id);
        files.push(...outcome.removed);
        survived.push(...outcome.survived);
      }
    }
    if (directories.length > 0 || files.length > 0) {
      this.deps.logger.warn(
        { directories, files },
        'removed what killed backup runs left in their working directories',
      );
    }
    if (survived.length > 0) {
      this.deps.logger.error(
        { survived },
        'files a killed backup run left behind could not be removed',
      );
    }
    return { directories, files, survived };
  }
}
