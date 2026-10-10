import {
  asId,
  systemJobActor,
  type Clock,
  type CorrelationId,
  type LegacyMigrationBlocker,
  type LegacyMigrationCodeCount,
  type LegacyMigrationPhase,
  type LegacyMigrationProgress,
  type LegacyNxpkgErrorCode,
  type LegacyNxpkgImportStatus,
  type SecretCipher,
  type TenantContext,
} from '@nexa/contracts';
import {
  isLegacyMigrationTerminal,
  LEGACY_MIGRATION_KEY_IDLE_MS_DEFAULT,
  LEGACY_MIGRATION_KEY_IDLE_STATUSES,
  LEGACY_MIGRATION_LEASE_HEARTBEAT_MS,
  LEGACY_MIGRATION_LEASE_MS,
  LEGACY_MIGRATION_MAX_APPLY_ATTEMPTS,
  LEGACY_MIGRATION_MAX_STEP_ATTEMPTS,
  phaseReached,
  reportDigest,
  digestsEqual,
  errorKind,
} from '../domain/import-lifecycle.js';
import { LEGACY_MIGRATION_KEY_PURPOSE } from './legacy-migration.service.js';
import {
  LegacyMigrationBlocked,
  LegacyMigrationNotWired,
  LegacyMigrationRetry,
  LegacyMigrationStepFailure,
  type BackupPort,
  type FreshTargetGuard,
  type HistoryIngestPort,
  type LegacyNxpkgImportPatch,
  type LegacyNxpkgImportRepository,
  type LegacyNxpkgImportRow,
  type MigrationRunner,
  type MigrationStepContext,
  type MigrationWorkspaces,
  type PackageSecret,
  type PackageVerifier,
} from './ports.js';

export interface LegacyMigrationExecutorDeps {
  readonly repository: LegacyNxpkgImportRepository;
  readonly workspaces: MigrationWorkspaces;
  readonly cipher: SecretCipher;
  readonly verifier: PackageVerifier;
  readonly runner: MigrationRunner;
  readonly freshTarget: FreshTargetGuard;
  readonly history: HistoryIngestPort;
  readonly backup: BackupPort;
  readonly clock: Clock;
  readonly correlation: () => CorrelationId;
  /** `${role}:${hostname()}`: two replicas hold distinguishable leases. */
  readonly leaseOwner: string;
  readonly tickIntervalMs: number;
  /** `LEGACY_MIGRATION_ENABLED`. Off: the loop ticks (and is healthy) and claims nothing. */
  readonly enabled: boolean;
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
  /**
   * `LEGACY_MIGRATION_RETAIN_PACKAGE`: keep a terminal import's encrypted package and
   * decisions file. Off (the default): the sweep deletes both.
   */
  readonly retainPackage?: boolean;
  /** `LEGACY_MIGRATION_KEY_IDLE_MS`: a key idle this long in VERIFIED / DRY_RUN_DONE is erased. */
  readonly keyIdleMs?: number;
  readonly logger: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
  };
}

/** The lease was released or taken while this process worked: write nothing more. */
class LeaseLost extends Error {
  constructor() {
    super('The legacy migration lease is no longer this process’s.');
    this.name = 'LeaseLost';
  }
}

/**
 * Mirza `.nxpkg` importer — the `migration` process role's loop
 * (`docs/legacy-migration/nxpkg-importer.md` §4).
 *
 * One tick: release leases that went stale, claim ONE import with work, run its step under a
 * heartbeated lease, release. The steps:
 *
 * ```
 * UPLOADED → VERIFYING → VERIFIED | VERIFY_FAILED                 (PackageVerifier)
 * DRY_RUN_REQUESTED → DRY_RUN_RUNNING → DRY_RUN_DONE | DRY_RUN_FAILED   (fresh target, MigrationRunner.dryRun)
 * APPROVED → APPLYING → COMPLETED | COMPLETED_WITH_DISCREPANCY | FAILED
 *   APPLY_PRECHECK  approved digest = dry run digest, package SHA-256 unchanged, fresh target
 *   APPLY_IMPORT    MigrationRunner.apply (IMPORT, or RESUME after a crash)
 *   HISTORY         HistoryIngestPort.ingest (idempotent by key)
 *   RECONCILE       MigrationRunner.reconcile
 *   REPORT          MigrationRunner.finalReport (v2)
 *   BACKUP          BackupPort.runAfterImport (the standard backup; quiesce honoured)
 * ```
 *
 * Every write is a lease-guarded conditional UPDATE; one that matches nothing means the row is
 * no longer this process's (cancelled, or taken over) and the step stops.
 *
 * CRASH: RESUMED, NOT FAILED — and that is the difference from `RecoveryExecutor.reclaimStale`.
 * A recovery's abandoned run owns a candidate database another process may still be writing,
 * so adopting it would merge two partial restores. Here nothing is owned by the dead process:
 * VERIFY and the DRY RUN are read-only and simply run again, and the APPLY is the existing
 * importer, whose resume (`importer.md` §6) exists precisely to continue an interrupted run
 * from its own `legacy_import_runs` row and idempotency keys (`legacy:opening:<tg>`). Failing
 * an interrupted apply would strand a half-imported tenant with no path forward; resuming it
 * finishes the same writes exactly once. The phase bookmark in `progress` makes the resume
 * continue from where it got to, and the history ingest continues by idempotency key.
 *
 * DECRYPTED CONTENT lives only in a private 0700 step directory created for one step and
 * removed in its `finally`; a crashed process's step directories are removed before the next
 * step on that import. The key is decrypted per step, never logged, and erased from the row by
 * the terminal transition.
 *
 * A PORT THAT IS NOT WIRED (`LegacyMigrationNotWired`) is not a verdict: the lease is released
 * and the row stays where it was, so the import continues once the adapter is wired. An error
 * no port classified is treated the same way (the step runs again next tick) — but every
 * step is BOUNDED: VERIFY and the DRY RUN after `LEGACY_MIGRATION_MAX_STEP_ATTEMPTS` starts,
 * an apply after `LEGACY_MIGRATION_MAX_APPLY_ATTEMPTS`, are failed (`IMPORT_FAILED`).
 *
 * TRANSIENT IS NOT A VERDICT EITHER. `LegacyMigrationRetry` (another importer process holds the
 * tenant: `RUN_CONFLICT`) and a lost lease release the step without failing it and without
 * counting the attempt; it runs again later. A step whose lease is lost is ABORTED through
 * the context's signal, so a worker that lost its import stops instead of racing the one
 * that took it over (the importer's own process lock refuses the second writer meanwhile).
 *
 * COMPLETED means all three: the importer's verdict is exactly `COMPLETED`, the reconcile is
 * RECONCILED and the v2 final report holds. Anything else that finished is
 * COMPLETED_WITH_DISCREPANCY — written, and for a person to read.
 *
 * HOUSEKEEPING, at start and on every tick: every `step-*` directory of a terminal import (or
 * of a directory no import names) is removed, and a terminal import's package and decisions
 * file too unless `retainPackage`; a sealed key idle in VERIFIED or DRY_RUN_DONE for
 * `keyIdleMs` is erased (the operator gives it again). The key is also erased BEFORE the
 * post-import backup is requested, so no backup ever contains it.
 */
export class LegacyMigrationExecutor {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastTickAt: number | null = null;

  constructor(private readonly deps: LegacyMigrationExecutorDeps) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), this.deps.tickIntervalMs);
    this.timer.unref();
    // Housekeeping at once: decrypted directories a crashed process left are not kept until
    // the first interval.
    if (this.deps.enabled) {
      void this.housekeeping().catch((error: unknown) => {
        this.deps.logger.error({ err: errorKind(error) }, 'legacy migration housekeeping failed');
      });
    }
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The loop is alive: a step in flight counts (its LEASE heartbeat is what proves that
   * step alive), and between steps the last tick must be within three intervals.
   */
  isFresh(nowMs: number): boolean {
    if (this.ticking) return true;
    if (this.lastTickAt === null) return false;
    return nowMs - this.lastTickAt <= this.deps.tickIntervalMs * 3;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (!this.deps.enabled) {
        this.lastTickAt = this.deps.clock.now().getTime();
        return;
      }
      await this.reclaimAbandoned();
      await this.housekeeping();
      const now = this.deps.clock.now();
      const claimed = await this.deps.repository.claim({
        leaseOwner: this.deps.leaseOwner,
        now,
        leaseUntil: this.leaseUntil(now),
      });
      this.lastTickAt = this.deps.clock.now().getTime();
      if (claimed === null) return;
      await this.run(claimed);
    } catch (error) {
      // Never fatal to the loop; `lastTickAt` is not advanced, so failing ticks show in health.
      this.deps.logger.error({ err: errorKind(error) }, 'legacy migration tick failed');
    } finally {
      this.ticking = false;
    }
  }

  /**
   * The sweep and the key expiry. Each failure is logged by kind and never stops the tick:
   * the next tick sweeps again.
   */
  async housekeeping(): Promise<void> {
    await this.sweep().catch((error: unknown) => {
      this.deps.logger.error({ err: errorKind(error) }, 'the legacy migration sweep failed');
    });
    await this.expireIdleKeys().catch((error: unknown) => {
      this.deps.logger.error({ err: errorKind(error) }, 'the legacy migration key expiry failed');
    });
  }

  /**
   * Removes what a finished import no longer needs: its decrypted step directories always,
   * its package and decisions file unless `retainPackage`. A directory no import row names
   * (an upload that never became a row, or a row of another installation's database) loses
   * its step directories only: an upload in flight has its package there and no row yet.
   */
  private async sweep(): Promise<void> {
    for (const id of await this.deps.workspaces.importDirectories()) {
      const row = await this.deps.repository.byIdUnscoped(id);
      if (row !== null && !isLegacyMigrationTerminal(row.status)) continue;
      const steps = await this.deps.workspaces.discardStaleSteps(id);
      const files =
        row !== null && this.deps.retainPackage !== true
          ? await this.deps.workspaces.discardPackageFiles(id)
          : 0;
      if (steps > 0 || files > 0) {
        this.deps.logger.info(
          { importId: id, stepDirectories: steps, packageFiles: files, orphan: row === null },
          'removed the files of a finished legacy migration',
        );
      }
    }
  }

  /** Erases a sealed key left waiting on a person longer than the idle period (L4). */
  private async expireIdleKeys(): Promise<void> {
    const now = this.deps.clock.now();
    const idleMs = this.deps.keyIdleMs ?? LEGACY_MIGRATION_KEY_IDLE_MS_DEFAULT;
    const expired = await this.deps.repository.expireIdleKeys({
      now,
      idleBefore: new Date(now.getTime() - idleMs),
      statuses: LEGACY_MIGRATION_KEY_IDLE_STATUSES,
    });
    for (const importId of expired) {
      this.deps.logger.warn(
        { importId, idleMs },
        'a legacy migration package key was idle too long and is erased; give it again to continue',
      );
    }
  }

  /** Releases leases whose process stopped heartbeating. Released, never failed: see above. */
  private async reclaimAbandoned(): Promise<void> {
    const released = await this.deps.repository.reclaimStale({ now: this.deps.clock.now() });
    for (const row of released) {
      this.deps.logger.warn(
        { importId: row.id, status: row.status, phase: row.progress.phase },
        'a legacy migration step was abandoned by a process that stopped heartbeating; it will be resumed',
      );
    }
  }

  /** Runs the claimed import's step under a heartbeated lease. */
  private async run(row: LegacyNxpkgImportRow): Promise<void> {
    const abort = new AbortController();
    const heartbeat = setInterval(() => {
      const now = this.deps.clock.now();
      void this.deps.repository
        .heartbeat({
          id: row.id,
          leaseOwner: this.deps.leaseOwner,
          now,
          leaseUntil: this.leaseUntil(now),
        })
        .then((held) => {
          if (!held) abort.abort(new LeaseLost());
        })
        .catch((error: unknown) => {
          this.deps.logger.warn(
            { importId: row.id, err: errorKind(error) },
            'a legacy migration lease heartbeat failed',
          );
        });
    }, this.deps.heartbeatMs ?? LEGACY_MIGRATION_LEASE_HEARTBEAT_MS);
    heartbeat.unref();

    try {
      const stale = await this.deps.workspaces.discardStaleSteps(row.id);
      if (stale > 0) {
        this.deps.logger.warn(
          { importId: row.id, stale },
          'removed decrypted step directories a crashed process left behind',
        );
      }
      switch (row.status) {
        case 'UPLOADED':
        case 'VERIFYING':
          await this.verify(row, abort.signal);
          break;
        case 'DRY_RUN_REQUESTED':
        case 'DRY_RUN_RUNNING':
          await this.dryRun(row, abort.signal);
          break;
        case 'APPROVED':
        case 'APPLYING':
          await this.apply(row, abort.signal);
          break;
        default:
          // Not work (a claim predicate would have to be wrong to get here): give it back.
          await this.release(row.id);
      }
    } catch (error) {
      if (error instanceof LeaseLost || abort.signal.aborted) {
        this.deps.logger.warn(
          { importId: row.id },
          'a legacy migration step stopped: the import is no longer this process’s',
        );
        return;
      }
      if (error instanceof LegacyMigrationBlocked) {
        this.deps.logger.warn(
          { importId: row.id, status: row.status, blocker: error.blocker },
          'a legacy migration is waiting on an operator',
        );
        await this.recordBlocker(row.id, error.blocker);
        await this.release(row.id);
        return;
      }
      if (error instanceof LegacyMigrationRetry) {
        this.deps.logger.warn(
          { importId: row.id, status: row.status, reason: error.reason },
          'a legacy migration step will run again: another importer process holds the tenant',
        );
        await this.release(row.id);
        return;
      }
      if (error instanceof LegacyMigrationNotWired) {
        this.deps.logger.error(
          { importId: row.id, status: row.status, port: error.port },
          'a legacy migration port is not wired; the import waits where it is',
        );
      } else {
        this.deps.logger.error(
          { importId: row.id, status: row.status, err: errorKind(error) },
          'a legacy migration step failed unexpectedly; it will run again',
        );
      }
      await this.release(row.id);
    } finally {
      clearInterval(heartbeat);
    }
  }

  // --- VERIFY ----------------------------------------------------------------------------

  private async verify(claimed: LegacyNxpkgImportRow, signal: AbortSignal): Promise<void> {
    let row = claimed;
    if (row.status === 'UPLOADED') {
      row = await this.advance(row, ['UPLOADED'], 'VERIFYING', {
        progress: { ...row.progress, phase: 'VERIFY', verifyAttempts: 1 },
      });
    } else {
      // A VERIFYING row claimed again: a crash, or an error nobody classified. Bounded.
      if (row.progress.verifyAttempts >= LEGACY_MIGRATION_MAX_STEP_ATTEMPTS) {
        this.deps.logger.error(
          { importId: row.id, attempts: row.progress.verifyAttempts },
          'a legacy migration verification was started too many times and is failed',
        );
        await this.fail(row, ['VERIFYING'], 'VERIFY_FAILED', 'IMPORT_FAILED');
        return;
      }
      row = await this.bookmark(row, { verifyAttempts: row.progress.verifyAttempts + 1 });
    }
    try {
      await this.withStep(row, signal, async (context) => {
        try {
          await this.assertPackageUnchanged(row);
          const report = await this.deps.verifier.verify(context);
          await this.advance(
            row,
            ['VERIFYING'],
            'VERIFIED',
            {
              verifyReport: report,
              packageImportId: report.packageImportId,
              packageSourceFingerprint: report.sourceFingerprint,
              packageSchemaVersion: report.packageSchemaVersion,
              converterVersion: report.converterVersion,
              manifestSummary: { synthetic: report.synthetic, recordCounts: report.recordCounts },
            },
            { release: true },
          );
        } catch (error) {
          if (!(error instanceof LegacyMigrationStepFailure)) throw error;
          await this.fail(row, ['VERIFYING'], 'VERIFY_FAILED', error.code, error.counts);
        }
      });
    } catch (error) {
      if (error instanceof LegacyMigrationRetry) {
        await this.uncount(row, { verifyAttempts: row.progress.verifyAttempts - 1 });
      }
      throw error;
    }
  }

  // --- DRY RUN ---------------------------------------------------------------------------

  private async dryRun(claimed: LegacyNxpkgImportRow, signal: AbortSignal): Promise<void> {
    let row = claimed;
    if (
      row.status === 'DRY_RUN_RUNNING' &&
      row.progress.dryRunAttempts >= LEGACY_MIGRATION_MAX_STEP_ATTEMPTS
    ) {
      this.deps.logger.error(
        { importId: row.id, attempts: row.progress.dryRunAttempts },
        'a legacy migration dry run was started too many times and is failed',
      );
      await this.fail(row, ['DRY_RUN_RUNNING'], 'DRY_RUN_FAILED', 'IMPORT_FAILED');
      return;
    }
    try {
      await this.withStep(row, signal, async (context) => {
        try {
          // A production-like target's gates come FIRST: while one is missing the import
          // waits in DRY_RUN_REQUESTED (still cancellable) with the blocker on its progress.
          await this.deps.runner.precheck(context, 'DRY_RUN');
          if (row.status === 'DRY_RUN_REQUESTED') {
            row = await this.advance(row, ['DRY_RUN_REQUESTED'], 'DRY_RUN_RUNNING', {
              progress: {
                ...row.progress,
                phase: 'DRY_RUN',
                refusalCounts: [],
                blocker: null,
                dryRunAttempts: 1,
              },
            });
          } else {
            row = await this.bookmark(row, {
              blocker: null,
              dryRunAttempts: row.progress.dryRunAttempts + 1,
            });
          }
          await this.assertPackageUnchanged(row);
          await this.assertFreshTarget(row, ['DRY_RUN_RUNNING']);
          const { report, legacyRunId } = await this.deps.runner.dryRun(context);
          await this.advance(
            row,
            ['DRY_RUN_RUNNING'],
            'DRY_RUN_DONE',
            {
              dryRunReport: report,
              dryRunSha256: reportDigest(report),
              dryRunLegacyRunId: legacyRunId,
            },
            { release: true },
          );
        } catch (error) {
          if (!(error instanceof LegacyMigrationStepFailure)) throw error;
          await this.fail(
            row,
            ['DRY_RUN_REQUESTED', 'DRY_RUN_RUNNING'],
            'DRY_RUN_FAILED',
            error.code,
            error.counts,
          );
        }
      });
    } catch (error) {
      if (error instanceof LegacyMigrationRetry && row.status === 'DRY_RUN_RUNNING') {
        await this.uncount(row, { dryRunAttempts: row.progress.dryRunAttempts - 1 });
      }
      throw error;
    }
  }

  // --- APPLY -----------------------------------------------------------------------------

  private async apply(claimed: LegacyNxpkgImportRow, signal: AbortSignal): Promise<void> {
    let row = claimed;
    // The import, the history, the reconcile and the report are done and recorded; the key is
    // already erased. Only the backup is left: no package is opened, no gate is asked again.
    if (row.status === 'APPLYING' && phaseReached(row.progress.phase, 'BACKUP')) {
      await this.finish(row);
      return;
    }
    // A crash LOOP is a verdict an owner must read, not a process that retries for ever. (An
    // APPLYING row with no key before BACKUP cannot be continued either.)
    if (
      row.status === 'APPLYING' &&
      (row.progress.applyAttempts >= LEGACY_MIGRATION_MAX_APPLY_ATTEMPTS ||
        row.keyCiphertext === null)
    ) {
      this.deps.logger.error(
        { importId: row.id, attempts: row.progress.applyAttempts, phase: row.progress.phase },
        'a legacy migration apply was resumed too many times and is failed',
      );
      await this.fail(row, ['APPLYING'], 'FAILED', 'IMPORT_FAILED');
      return;
    }
    const resumed = phaseReached(row.progress.phase, 'APPLY_IMPORT');
    let counted = false;
    try {
      await this.withStep(row, signal, async (context) => {
        try {
          if (!resumed) {
            // Before anything is written, and on every attempt until the import starts:
            //   1. the target acknowledgement (production-like; never a synthetic package);
            //   2. the approval is bound to THIS dry run of THIS file;
            //   3. the fresh target;
            //   4. the APPROVED reads — the read sets ingested and recorded, each bound to the
            //      fingerprint the approved dry run observed (the dry run itself wrote none);
            //   5. the owner's cutover approval of the seven values and stop-sales
            //      (production-like), which needs the read sets of step 4 recorded.
            await this.deps.runner.precheck(context, 'DRY_RUN');
            this.assertApprovedDigest(row);
            await this.assertPackageUnchanged(row);
            await this.assertFreshTarget(row, [row.status]);
            await this.deps.runner.recordReadSets(context);
          }
          // Production-like: before the first write AND before every resume. Missing → the
          // import waits (APPROVED stays cancellable) with the blocker recorded; the
          // importer's own gate decides again inside its transaction.
          await this.deps.runner.precheck(context, 'APPLY');
          if (row.status === 'APPROVED') {
            row = await this.advance(row, ['APPROVED'], 'APPLYING', {
              progress: { ...row.progress, phase: 'APPLY_PRECHECK', blocker: null },
            });
          } else if (row.progress.blocker !== null) {
            row = await this.bookmark(row, { blocker: null });
          }
          row = await this.bookmark(row, { applyAttempts: row.progress.applyAttempts + 1 });
          counted = true;

          // Re-checked on every attempt, the first and every resume: the approval is bound
          // to THIS dry run of THIS file, whatever happened in between.
          this.assertApprovedDigest(row);
          await this.assertPackageUnchanged(row);
          if (!resumed) row = await this.bookmark(row, { phase: 'APPLY_IMPORT' });

          if (!phaseReached(row.progress.phase, 'HISTORY')) {
            // A verdict recorded by an attempt that crashed before the HISTORY bookmark is the
            // outcome: the import is not asked again.
            if (row.progress.importerVerdict === null || row.applyLegacyRunId === null) {
              const outcome = await this.deps.runner.apply(context, {
                mode: resumed ? 'RESUME' : 'IMPORT',
                approvedDryRunSha256: row.approvedDryRunSha256 ?? '',
              });
              // Recorded at once, on its own: a crash before the next bookmark keeps it.
              row = await this.bookmark(
                row,
                { importerVerdict: outcome.importerVerdict },
                { applyLegacyRunId: outcome.legacyRunId },
              );
            }
            row = await this.bookmark(row, { phase: 'HISTORY' });
          }
          if (!phaseReached(row.progress.phase, 'RECONCILE')) {
            const archived = await this.deps.history.ingest(context);
            row = await this.bookmark(row, { phase: 'RECONCILE', history: [...archived.counts] });
          }
          if (!phaseReached(row.progress.phase, 'REPORT')) {
            const reconciled = await this.deps.runner.reconcile(context);
            row = await this.bookmark(row, {
              phase: 'REPORT',
              reconcileVerdict: reconciled.verdict,
            });
          }
          const report = await this.deps.runner.finalReport(context, {
            importerVerdict: row.progress.importerVerdict ?? 'UNKNOWN',
            reconcileVerdict: row.progress.reconcileVerdict ?? 'DISCREPANCY',
            history: row.progress.history,
          });
          // The key is erased WITH the BACKUP bookmark — before the backup is requested, so
          // the backup never holds it, and a crash from here on needs no key: the backup is
          // all that is left.
          row = await this.bookmark(
            row,
            { phase: 'BACKUP' },
            { applyReport: report, keyCiphertext: null, keyKeyId: null },
          );
        } catch (error) {
          if (!(error instanceof LegacyMigrationStepFailure)) throw error;
          await this.fail(row, ['APPROVED', 'APPLYING'], 'FAILED', error.code, error.counts);
        }
      });
    } catch (error) {
      if (error instanceof LegacyMigrationRetry && counted) {
        await this.uncount(row, { applyAttempts: row.progress.applyAttempts - 1 });
      }
      throw error;
    }
    if (row.status === 'APPLYING' && phaseReached(row.progress.phase, 'BACKUP')) {
      await this.finish(row);
    }
  }

  /**
   * The standard backup, then the outcome. COMPLETED only when the importer said exactly
   * `COMPLETED`, the reconcile RECONCILED and the v2 report holds.
   */
  private async finish(row: LegacyNxpkgImportRow): Promise<void> {
    const backup = await this.backup(row);
    await this.advance(row, ['APPLYING'], completedStatusOf(row), {
      backupRunId: backup.runId,
      progress: { ...row.progress, backup: backup.outcome },
    });
  }

  /** The standard backup. Its failure is recorded on the row, never a failed import. */
  private async backup(row: LegacyNxpkgImportRow) {
    try {
      return await this.deps.backup.runAfterImport();
    } catch (error) {
      if (error instanceof LegacyMigrationNotWired) throw error;
      this.deps.logger.error(
        { importId: row.id, err: errorKind(error) },
        'the backup after a legacy migration failed; the import itself is complete',
      );
      return { outcome: 'FAILED' as const, runId: null };
    }
  }

  // --- checks ----------------------------------------------------------------------------

  private assertApprovedDigest(row: LegacyNxpkgImportRow): void {
    if (
      row.approvedDryRunSha256 === null ||
      row.dryRunSha256 === null ||
      !digestsEqual(row.approvedDryRunSha256, row.dryRunSha256)
    ) {
      throw new LegacyMigrationStepFailure(
        'DRY_RUN_MISMATCH',
        'The approved dry run digest is not the import’s dry run digest.',
      );
    }
  }

  private async assertPackageUnchanged(row: LegacyNxpkgImportRow): Promise<void> {
    const { sha256 } = await this.deps.workspaces.digest(row.filePath);
    if (!digestsEqual(sha256, row.fileSha256)) {
      throw new LegacyMigrationStepFailure(
        'PACKAGE_CHANGED',
        'The stored package is not the one that was uploaded.',
      );
    }
  }

  private async assertFreshTarget(
    row: LegacyNxpkgImportRow,
    from: readonly LegacyNxpkgImportStatus[],
  ): Promise<void> {
    const fresh = await this.deps.freshTarget.check(scopeOf(row), row.packageSourceFingerprint);
    if (fresh.fresh) return;
    const refusalCounts = Object.entries(fresh.counts)
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    // Recorded BEFORE the failure, on the same lease, so the operator sees what is in the way.
    const recorded = await this.deps.repository.patch({
      id: row.id,
      from,
      leaseOwner: this.deps.leaseOwner,
      now: this.deps.clock.now(),
      patch: { progress: { ...row.progress, refusalCounts } },
    });
    if (!recorded) throw new LeaseLost();
    throw new LegacyMigrationStepFailure(
      'FRESH_TARGET_NOT_EMPTY',
      'The tenant already holds operational data. Nothing is deleted to make room.',
    );
  }

  // --- the step and the row --------------------------------------------------------------

  /**
   * Runs one step in a private directory with the key decrypted for it, and removes the
   * directory whatever happens. The key exists in memory for the step only.
   */
  private async withStep(
    row: LegacyNxpkgImportRow,
    signal: AbortSignal,
    fn: (context: MigrationStepContext) => Promise<void>,
  ): Promise<void> {
    const workDir = await this.deps.workspaces.stepDirectory(row.id);
    try {
      await fn({
        scope: scopeOf(row),
        actor: systemJobActor('legacy-migration', this.deps.correlation()),
        importId: row.id,
        packageImportId: row.packageImportId,
        sourceFingerprint: row.packageSourceFingerprint,
        packagePath: row.filePath,
        packageSha256: row.fileSha256,
        secret: this.secretOf(row),
        workDir,
        decisionsPath: row.decisionsFilePath,
        panelBindings: row.panelBindings ?? [],
        verifyReport: row.verifyReport,
        dryRunReport: row.dryRunReport,
        signal,
      });
    } finally {
      await this.deps.workspaces.discardStep(workDir).catch((error: unknown) => {
        // Loud: this is decrypted package content left on disk. The next step on this import
        // removes it (`discardStaleSteps`), and the log names the import, never the path.
        this.deps.logger.error(
          { importId: row.id, err: errorKind(error) },
          'a decrypted legacy migration step directory could not be removed',
        );
      });
    }
  }

  private secretOf(row: LegacyNxpkgImportRow): PackageSecret {
    if (row.keyCiphertext === null || row.keyKeyId === null || row.keyKind === null) {
      throw new Error('The import holds no package key.');
    }
    const plaintext = this.deps.cipher.decrypt(
      { keyId: row.keyKeyId, ciphertext: row.keyCiphertext },
      // REBUILT from the row's tenant and id, never read from a stored context.
      { purpose: LEGACY_MIGRATION_KEY_PURPOSE, tenantId: row.tenantId, entityId: row.id },
    );
    return row.keyKind === 'KEY_FILE' ? { keyFileText: plaintext } : { passphrase: plaintext };
  }

  /** A lease-guarded transition; the row as it now is. */
  private async advance(
    row: LegacyNxpkgImportRow,
    from: readonly LegacyNxpkgImportStatus[],
    to: LegacyNxpkgImportStatus,
    patch: LegacyNxpkgImportPatch,
    options: { readonly release?: boolean } = {},
  ): Promise<LegacyNxpkgImportRow> {
    const moved = await this.deps.repository.transition({
      id: row.id,
      from,
      to,
      now: this.deps.clock.now(),
      leaseOwner: this.deps.leaseOwner,
      releaseLease: options.release === true,
      patch,
    });
    if (!moved) throw new LeaseLost();
    this.deps.logger.info({ importId: row.id, from: row.status, to }, 'legacy migration advanced');
    return this.reread(row.id);
  }

  /** Records progress (and optionally columns) without moving the status. */
  private async bookmark(
    row: LegacyNxpkgImportRow,
    progress: Partial<LegacyMigrationProgress> & { readonly phase?: LegacyMigrationPhase },
    patch: LegacyNxpkgImportPatch = {},
  ): Promise<LegacyNxpkgImportRow> {
    const recorded = await this.deps.repository.patch({
      id: row.id,
      from: [row.status],
      leaseOwner: this.deps.leaseOwner,
      now: this.deps.clock.now(),
      patch: { ...patch, progress: { ...row.progress, ...progress } },
    });
    if (!recorded) throw new LeaseLost();
    return this.reread(row.id);
  }

  private async fail(
    row: LegacyNxpkgImportRow,
    from: readonly LegacyNxpkgImportStatus[],
    to: 'VERIFY_FAILED' | 'DRY_RUN_FAILED' | 'FAILED',
    code: LegacyNxpkgErrorCode,
    counts: readonly LegacyMigrationCodeCount[] | null = null,
  ): Promise<void> {
    this.deps.logger.warn({ importId: row.id, to, code }, 'a legacy migration step refused');
    const current = await this.reread(row.id);
    await this.advance(current, from, to, {
      errorCode: code,
      // What the refusal measured (M8: the converter's totals beside the importer's), kept
      // on the row so the operator reads both numbers.
      ...(counts === null ? {} : { progress: { ...current.progress, refusalCounts: [...counts] } }),
    });
  }

  /**
   * Gives back an attempt a TRANSIENT refusal took (`LegacyMigrationRetry`): waiting for
   * another importer process is not a crash, and must not fail the import at the bound.
   */
  private async uncount(
    row: LegacyNxpkgImportRow,
    progress: Partial<
      Pick<LegacyMigrationProgress, 'verifyAttempts' | 'dryRunAttempts' | 'applyAttempts'>
    >,
  ): Promise<void> {
    const current = await this.deps.repository.byIdUnscoped(row.id);
    if (current === null) return;
    const clamped = Object.fromEntries(
      Object.entries(progress).map(([key, value]) => [key, Math.max(0, value)]),
    );
    await this.deps.repository
      .patch({
        id: row.id,
        from: [current.status],
        leaseOwner: this.deps.leaseOwner,
        now: this.deps.clock.now(),
        patch: { progress: { ...current.progress, ...clamped } },
      })
      .catch((error: unknown) => {
        this.deps.logger.warn(
          { importId: row.id, err: errorKind(error) },
          'a legacy migration attempt could not be given back',
        );
      });
  }

  /** Records what the import waits for, on this process's lease, without moving the status. */
  private async recordBlocker(id: string, blocker: LegacyMigrationBlocker): Promise<void> {
    const current = await this.deps.repository.byIdUnscoped(id);
    if (current === null || current.progress.blocker === blocker) return;
    await this.deps.repository.patch({
      id,
      from: [current.status],
      leaseOwner: this.deps.leaseOwner,
      now: this.deps.clock.now(),
      patch: { progress: { ...current.progress, blocker } },
    });
  }

  private async release(id: string): Promise<void> {
    await this.deps.repository
      .release({ id, leaseOwner: this.deps.leaseOwner, now: this.deps.clock.now() })
      .catch((error: unknown) => {
        this.deps.logger.error({ importId: id, err: errorKind(error) }, 'a lease release failed');
      });
  }

  private async reread(id: string): Promise<LegacyNxpkgImportRow> {
    const row = await this.deps.repository.byIdUnscoped(id);
    if (row === null) throw new LeaseLost();
    return row;
  }

  private leaseUntil(now: Date): Date {
    return new Date(now.getTime() + (this.deps.leaseMs ?? LEGACY_MIGRATION_LEASE_MS));
  }
}

function scopeOf(row: LegacyNxpkgImportRow): TenantContext {
  return { tenantId: asId<'TenantId'>(row.tenantId), botInstanceId: null };
}

/**
 * COMPLETED only when all three hold: the importer's own verdict is exactly `COMPLETED` (not
 * `COMPLETED_WITH_FAILURES`, `COMPLETED_ADOPTION_PENDING_P6`, or a verdict reconstructed after
 * a crash), the reconcile is RECONCILED, and the v2 final report holds.
 */
export function completedStatusOf(
  row: Pick<LegacyNxpkgImportRow, 'progress' | 'applyReport'>,
): 'COMPLETED' | 'COMPLETED_WITH_DISCREPANCY' {
  return row.progress.importerVerdict === 'COMPLETED' &&
    row.progress.reconcileVerdict === 'RECONCILED' &&
    row.applyReport?.reportHolds === true
    ? 'COMPLETED'
    : 'COMPLETED_WITH_DISCREPANCY';
}
