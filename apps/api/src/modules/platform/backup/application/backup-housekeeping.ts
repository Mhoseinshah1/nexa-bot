import {
  BACKUP_OVERDUE_TOLERANCE,
  type Clock,
  type OperationalEventRecorder,
  type ScopeContext,
} from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import type {
  BackupArchiveRetentionStore,
  BackupDebrisStore,
  BackupRunRepository,
} from './ports.js';

/**
 * The backup pipeline's housekeeping, in the worker (Program E5).
 *
 * Four jobs that each close a way for "the backups are fine" to be false while
 * nothing says so. None of them takes a backup, and none of them changes what a
 * backup IS: the six stages, the lock and the verification are `BackupService`'s
 * and stay there.
 *
 *   1. ARCHIVE RETENTION. Archive files were never removed, so `BACKUP_WORK_DIR`
 *      only grew, and a run row purged after a year orphaned its directory for
 *      ever. A directory is removed only when the run table says it may be
 *      (`archivePruneCandidates`, where every exclusion lives), THEN the row is
 *      stamped — and the row purge waits for that stamp, so the two retentions
 *      cannot disagree about a file.
 *   2. PLAINTEXT DEBRIS. A run abandoned mid-dump (lease reclaimed) keeps its
 *      plaintext by design — its process may still be writing it — and a CLI
 *      `verify`/`restore` killed before its `finally` leaves a `.cli-*` scratch
 *      directory. Both are removed once nothing has written them for the grace
 *      window, which is longer than any dump or restore can run.
 *   3. DISK SPACE on the backup volume, against what the next run needs.
 *   4. OVERDUE: the schedule is on and the last VERIFIED backup is older than
 *      its interval times `BACKUP_OVERDUE_TOLERANCE`.
 *
 * NOT DURING A RECOVERY. The pass asks the same `quiesced` predicate the
 * scheduler and the CLI ask, and does nothing while a recovery holds the
 * installation: deleting files beside a restore, or raising "overdue" because
 * the recovery is (correctly) refusing backups, would be wrong in both
 * directions.
 *
 * Conditions are opened on every pass that observes them (the recorder dedupes
 * onto one row) and closed ONLY when open, so a healthy installation records
 * nothing at all — the recorder always inserts a recovery row, and a quarter-
 * hourly "still fine" would bury the log.
 */
export interface BackupHousekeepingDeps {
  readonly runs: Pick<BackupRunRepository, 'lastSucceededAt'> & BackupArchiveRetentionStore;
  readonly debris: BackupDebrisStore;
  readonly clock: Clock;
  readonly opsLog: OperationalEventRecorder;
  readonly scope: () => ScopeContext | null;
  /** Whether the installation's condition of this code is open now. */
  readonly conditionOpen: (code: string) => Promise<boolean>;
  /**
   * Whether one leftover a run recorded in `cleanup_detail` still exists: an
   * absolute path on disk, or a scratch database by name. Anything else (a
   * sentence, from a reclaimed run) is covered by the debris sweep and answers
   * false.
   */
  readonly leftoverExists: (leftover: string) => Promise<boolean>;
  /** `Container.recoveryQuiesced`: the one predicate every backup trigger asks. */
  readonly quiesced: () => Promise<boolean>;
  /** `BackupSchedulePolicy.effective`, the value the scheduler acts on. */
  readonly schedule: () => Promise<{ readonly enabled: boolean; readonly intervalMs: number }>;
  /** The archive retention settings in force now. */
  readonly retention: () => Promise<{ readonly keepCount: number; readonly keepDays: number }>;
  /**
   * Backup run ids an in-progress recovery refers to — its pre-restore backup,
   * and a local run whose archive it is restoring. Never pruned.
   */
  readonly protectedByRecovery: () => Promise<readonly string[]>;
  /**
   * How long a plaintext file must have gone unwritten before it is debris.
   * Longer than the dump and restore timeouts together, so a live process can
   * never be the writer of a file this removes.
   */
  readonly plaintextGraceMs: number;
  /** Below this many free bytes the volume is low whatever the estimate says. */
  readonly diskFloorBytes: number;
  readonly tickIntervalMs: number;
  readonly initialDelayMs: number;
  readonly logger: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
  };
}

/** One dedupe key per condition, installation-wide, like `backup.run`. */
const KEYS = {
  cleanup: 'backup.cleanup',
  disk: 'backup.disk',
  interval: 'backup.interval',
} as const;

/** A batch bound, so one pass is never an unbounded walk over a decade of runs. */
const PRUNE_BATCH = 200;

/**
 * Peak bytes a run holds on the volume, from the last verified run: the dump,
 * the verification's decrypted copy and the archive coexist during
 * VERIFY_RESTORE. Times one and a half, because a database grows between runs.
 */
export function requiredFreeBytes(
  latest: { readonly dumpBytes: bigint | null; readonly archiveBytes: bigint | null } | null,
  floorBytes: number,
): number {
  if (latest === null) return floorBytes;
  const dump = Number(latest.dumpBytes ?? 0n);
  const archive = Number(latest.archiveBytes ?? 0n);
  return Math.max(floorBytes, Math.ceil((2 * dump + archive) * 1.5));
}

export interface HousekeepingPassResult {
  readonly skipped: boolean;
  readonly pruned: number;
  readonly debrisRemoved: number;
}

export class BackupHousekeeping {
  private timer: NodeJS.Timeout | null = null;
  private firstRun: NodeJS.Timeout | null = null;
  private running = false;
  private readonly progress: LoopProgress;
  /**
   * When this process began watching. The overdue clock for an installation that
   * has NEVER produced a verified backup: "no backup since we started looking"
   * is the most that can honestly be said, and the scheduler takes the first
   * backup immediately, so this only fires when that first one never lands.
   */
  private readonly watchingSince: number;
  /** Directories the last retention pass selected and could not remove. */
  private retentionSurvivors = 0;

  constructor(private readonly deps: BackupHousekeepingDeps) {
    this.progress = new LoopProgress(deps.tickIntervalMs);
    this.watchingSince = deps.clock.now().getTime();
  }

  start(): void {
    if (this.timer !== null) return;
    this.progress.begin(this.deps.clock.now().getTime());
    this.firstRun = setTimeout(() => void this.tick(), this.deps.initialDelayMs);
    this.timer = setInterval(() => void this.tick(), this.deps.tickIntervalMs);
    this.firstRun.unref?.();
    this.timer.unref?.();
  }

  stop(): void {
    if (this.firstRun !== null) clearTimeout(this.firstRun);
    if (this.timer !== null) clearInterval(this.timer);
    this.firstRun = null;
    this.timer = null;
    this.progress.end();
  }

  isFresh(nowMs: number): boolean {
    return this.progress.isFresh(nowMs);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.pass();
    } catch (error) {
      this.deps.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'backup housekeeping pass failed',
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * One pass of all four jobs. Exposed so a test can run it without a timer.
   *
   * Each job is isolated: a failure in one is logged and the others still run,
   * because an unreadable disk must not stop the overdue alert that would tell
   * somebody. Progress is recorded only when every job completed, so a job that
   * fails on every pass makes the worker's health check say so.
   */
  async pass(): Promise<HousekeepingPassResult> {
    if (await this.deps.quiesced()) {
      this.deps.logger.info({}, 'backup housekeeping skipped; a recovery holds the installation');
      this.progress.record(this.deps.clock.now().getTime());
      return { skipped: true, pruned: 0, debrisRemoved: 0 };
    }
    let failed = false;
    const guard = async <T>(name: string, job: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await job();
      } catch (error) {
        failed = true;
        this.deps.logger.error(
          { job: name, err: error instanceof Error ? error.message : String(error) },
          'a backup housekeeping job failed',
        );
        return fallback;
      }
    };
    const pruned = await guard('archive-retention', () => this.pruneArchives(), 0);
    const debrisRemoved = await guard('plaintext-debris', () => this.sweepDebris(), 0);
    await guard('disk-space', () => this.checkDisk(), undefined);
    await guard('overdue', () => this.checkOverdue(), undefined);
    if (!failed) this.progress.record(this.deps.clock.now().getTime());
    return { skipped: false, pruned, debrisRemoved };
  }

  /** Job 1. The run table decides; the directory goes; then the row says so. */
  async pruneArchives(): Promise<number> {
    const { keepCount, keepDays } = await this.deps.retention();
    const now = this.deps.clock.now();
    const candidates = await this.deps.runs.archivePruneCandidates({
      finishedBefore: new Date(now.getTime() - keepDays * 24 * 3_600_000),
      keepCount,
      protectedIds: await this.deps.protectedByRecovery(),
      limit: PRUNE_BATCH,
    });
    let pruned = 0;
    let survivedDirectories = 0;
    for (const candidate of candidates) {
      const survived = await this.deps.debris.removeRunDirectory(candidate.id);
      if (survived.length > 0) {
        // NOT stamped: the row must keep saying the directory may be on disk, or
        // the row purge would take it and orphan whatever survived.
        this.deps.logger.error(
          { backupId: candidate.id, survived },
          'archive retention could not remove a backup directory',
        );
        survivedDirectories += 1;
        continue;
      }
      if (await this.deps.runs.markArchivePruned({ id: candidate.id, now })) pruned += 1;
    }
    if (pruned > 0) {
      this.deps.logger.info(
        { pruned, keepCount, keepDays },
        'backup archives removed by retention',
      );
    }
    // Reported through the EXISTING cleanup condition rather than a new code: a
    // directory retention could not remove is something left on this host that
    // should not be. The sweep will not close the condition after such a pass.
    this.retentionSurvivors = survivedDirectories;
    if (survivedDirectories > 0) {
      await this.record({
        code: 'backup.cleanup_failed',
        severity: 'ERROR',
        message: `${String(survivedDirectories)} backup directory(ies) archive retention selected could not be removed.`,
        context: { retentionSurvivors: survivedDirectories },
        dedupeKey: KEYS.cleanup,
      });
    }
    return pruned;
  }

  /** Job 2. Plaintext nothing has written for the grace window, and CLI scratch. */
  async sweepDebris(): Promise<number> {
    const now = this.deps.clock.now();
    const running = new Set(await this.deps.runs.runningIds());
    const sweep = await this.deps.debris.sweepPlaintext({
      olderThan: new Date(now.getTime() - this.deps.plaintextGraceMs),
      skipIds: running,
    });
    if (sweep.removed.length > 0) {
      this.deps.logger.warn(
        { removed: sweep.removed },
        'removed plaintext a backup or a CLI command left behind',
      );
    }
    if (sweep.survived.length > 0) {
      this.deps.logger.error(
        { survived: sweep.survived },
        'plaintext a backup left behind could not be removed',
      );
      await this.record({
        code: 'backup.cleanup_failed',
        severity: 'ERROR',
        message:
          `${String(sweep.survived.length)} plaintext backup artifact(s) on this host could ` +
          'not be removed by the debris sweep.',
        context: { survived: sweep.survived.length },
        dedupeKey: KEYS.cleanup,
      });
      return sweep.removed.length;
    }
    /*
     * CLOSED only when the host is actually clean: nothing survived, nothing is
     * still inside the grace window, and nothing any run recorded as left behind
     * still exists.
     */
    if (
      sweep.pending === 0 &&
      this.retentionSurvivors === 0 &&
      (await this.deps.conditionOpen('backup.cleanup_failed'))
    ) {
      // Every leftover ANY run recorded — a plaintext path, a leaked scratch
      // database — must be gone, not merely the newest run's. A clean run after a
      // dirty one says nothing about the dirty one's files or databases.
      const remaining: string[] = [];
      for (const leftover of await this.deps.runs.recordedLeftovers()) {
        if (await this.deps.leftoverExists(leftover)) remaining.push(leftover);
      }
      if (remaining.length > 0) {
        this.deps.logger.warn(
          { remaining },
          'backup cleanup condition stays open: recorded leftovers still exist',
        );
      } else {
        await this.record({
          code: 'backup.cleanup_ok',
          severity: 'INFO',
          message: 'No plaintext backup artifact remains on this host.',
          context: { removed: sweep.removed.length },
          recoversCode: 'backup.cleanup_failed',
          recoversDedupeKey: KEYS.cleanup,
        });
      }
    }
    return sweep.removed.length;
  }

  /** Job 3. Free space on the volume against what the next run will hold at once. */
  async checkDisk(): Promise<void> {
    const free = await this.deps.debris.freeBytes();
    // No directory yet is no backups yet: the first run creates it, and the
    // pipeline's own failure is the alert if it cannot.
    if (free === null) return;
    const required = requiredFreeBytes(
      await this.deps.runs.latestVerified(),
      this.deps.diskFloorBytes,
    );
    if (free < required) {
      await this.record({
        code: 'backup.disk_threshold_exceeded',
        severity: 'WARN',
        message:
          `The backup volume has ${String(free)} bytes free and the next backup needs about ` +
          `${String(required)}.`,
        context: { freeBytes: free, requiredBytes: required },
        dedupeKey: KEYS.disk,
      });
      return;
    }
    if (await this.deps.conditionOpen('backup.disk_threshold_exceeded')) {
      await this.record({
        code: 'backup.disk_threshold_ok',
        severity: 'INFO',
        message: 'The backup volume has room for the next backup again.',
        context: { freeBytes: free, requiredBytes: required },
        recoversCode: 'backup.disk_threshold_exceeded',
        recoversDedupeKey: KEYS.disk,
      });
    }
  }

  /** Job 4. The schedule is on and nothing verified has landed for too long. */
  async checkOverdue(): Promise<void> {
    const schedule = await this.deps.schedule();
    const now = this.deps.clock.now().getTime();
    const last = await this.deps.runs.lastSucceededAt();
    const since = last === null ? this.watchingSince : last.getTime();
    const limitMs = schedule.intervalMs * BACKUP_OVERDUE_TOLERANCE;
    // A schedule switched OFF is not overdue: it is a decision, and an open
    // condition saying otherwise would be about a schedule that no longer exists.
    const overdue = schedule.enabled && now - since > limitMs;
    if (overdue) {
      await this.record({
        code: 'backup.interval_exceeded',
        severity: 'ERROR',
        message:
          last === null
            ? 'Automatic backups are on and no verified backup has completed since this worker ' +
              'started watching.'
            : `Automatic backups are on and the last verified backup completed at ` +
              `${last.toISOString()}, more than ${String(BACKUP_OVERDUE_TOLERANCE)} intervals ago.`,
        context: {
          lastVerifiedAt: last === null ? null : last.toISOString(),
          intervalMs: schedule.intervalMs,
          tolerance: BACKUP_OVERDUE_TOLERANCE,
        },
        dedupeKey: KEYS.interval,
      });
      return;
    }
    if (await this.deps.conditionOpen('backup.interval_exceeded')) {
      await this.record({
        code: 'backup.interval_ok',
        severity: 'INFO',
        message: schedule.enabled
          ? 'A verified backup has landed within the schedule again.'
          : 'Automatic backups were switched off, so none is overdue.',
        context: { lastVerifiedAt: last === null ? null : last.toISOString() },
        recoversCode: 'backup.interval_exceeded',
        recoversDedupeKey: KEYS.interval,
      });
    }
  }

  /** Records a condition when there is an installation to address it to. Never throws. */
  private async record(event: {
    code: string;
    severity: 'INFO' | 'WARN' | 'ERROR';
    message: string;
    context: Record<string, unknown>;
    dedupeKey?: string;
    recoversCode?: string;
    recoversDedupeKey?: string;
  }): Promise<void> {
    const scope = this.deps.scope();
    if (scope === null) {
      this.deps.logger.warn(
        { code: event.code },
        'no installation tenant is provisioned, so this backup condition was not recorded',
      );
      return;
    }
    try {
      await this.deps.opsLog.record(scope, event);
    } catch (error) {
      this.deps.logger.error(
        { code: event.code, reason: error instanceof Error ? error.message : String(error) },
        'failed to record a backup housekeeping condition',
      );
    }
  }
}
