import {
  asId,
  LEGACY_MIGRATION_APPROVAL_TTL_MS,
  systemJobActor,
  validInventoryHold,
  type Clock,
  type CorrelationId,
  type LegacyMigrationBlocker,
  type LegacyMigrationApplyReport,
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
  LEGACY_MIGRATION_APPLY_WINDOW_MS,
  LEGACY_MIGRATION_MAX_APPLY_ATTEMPTS,
  LEGACY_MIGRATION_MAX_STEP_ATTEMPTS,
  LEGACY_MIGRATION_ORPHAN_IDLE_MS,
  phaseReached,
  reportDigest,
  digestsEqual,
  errorKind,
} from '../domain/import-lifecycle.js';
import { LEGACY_MIGRATION_KEY_PURPOSE } from './legacy-migration.service.js';
import { timedSection } from '../../legacy-importer/application/section-timing.js';
import {
  exactMatchReport,
  exactMatchRowsFromWire,
} from '../../legacy-materialize/application/exact-match.js';
import {
  LegacyMigrationBlocked,
  LegacyMigrationNotWired,
  LegacyMigrationRetry,
  LegacyMigrationStepFailure,
  type BackupPort,
  type BotLinkPort,
  type FreshTargetGuard,
  type HistoryIngestPort,
  type LegacyNxpkgImportPatch,
  type LegacyNxpkgImportRepository,
  type LegacyNxpkgImportRow,
  type MaterializePort,
  type MigrationRunner,
  type MigrationStepContext,
  type MigrationWorkspaces,
  type PackageSecret,
  type PackageVerifier,
} from './ports.js';
import { guardedTick } from '../../../../infrastructure/lifecycle/loop-guard.js';

export interface LegacyMigrationExecutorDeps {
  readonly repository: LegacyNxpkgImportRepository;
  readonly workspaces: MigrationWorkspaces;
  readonly cipher: SecretCipher;
  readonly verifier: PackageVerifier;
  readonly runner: MigrationRunner;
  readonly freshTarget: FreshTargetGuard;
  readonly history: HistoryIngestPort;
  /** The one-time import: the history into the normal tables, and its exact-match rows. */
  readonly materialize: MaterializePort;
  /** The one-time import: the imported customers linked to the tenant's active bot. */
  readonly botLink: BotLinkPort;
  readonly backup: BackupPort;
  /**
   * Phase 7 — mutual exclusion: a disaster recovery is confirmed and not finished
   * (`recovery_requests` in a destructive state). An import is not started while one is.
   */
  readonly recoveryActive: () => Promise<boolean>;
  /**
   * Phase 7 (review H1): when the latest NEXA restore cut over, or null. An unfinished import
   * created before it came back with the restored backup and is closed, never continued.
   */
  readonly latestCutoverAt: () => Promise<Date | null>;
  /**
   * Phase 7 — the write freeze's one exemption (`runAsLegacyMigration`): runs the apply as
   * THIS import's own writer, so its writes pass the installation-wide freeze its APPLYING
   * row holds, and nothing else's do.
   */
  readonly asImportWriter: <T>(importId: string, fn: () => Promise<T>) => Promise<T>;
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
 * ADOPT_REQUESTED → ADOPT_RUNNING → ADOPT_DONE | FAILED            (the "adopt approved" lane)
 *   ADOPT           MigrationRunner.adoptApproved, bound to the finished import of the source
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
 * counting the attempt; it runs again later — EXCEPT while APPLYING (Phase 7, review H3):
 * there the installation is frozen, so every attempt counts from its start and the bound
 * fails the import rather than holding the freeze for ever. A step whose lease is lost is ABORTED through
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
    const tick = guardedTick('legacy-migration-executor', () => this.tick(), this.deps.logger);
    this.timer = setInterval(tick, this.deps.tickIntervalMs);
    this.timer.unref();
    // A tick at once (its housekeeping included): decrypted directories a crashed process left
    // are not kept until the first interval, and the role's heartbeat — which requires this
    // loop fresh — is fresh from the start rather than after an interval.
    tick();
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
      await this.supersedeRestored();
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
   * its step directories only while it is still being written — an upload in flight has its
   * package there and no row yet — and is removed whole once nothing has written to it for
   * `LEGACY_MIGRATION_ORPHAN_IDLE_MS`: an upload whose process died before its row was
   * inserted, which no request will ever clean up.
   */
  private async sweep(): Promise<void> {
    for (const id of await this.deps.workspaces.importDirectories()) {
      const row = await this.deps.repository.byIdUnscoped(id);
      if (row !== null && !isLegacyMigrationTerminal(row.status)) continue;
      if (row === null && (await this.orphanAbandoned(id))) {
        await this.deps.workspaces.discard(id);
        this.deps.logger.warn(
          { importId: id },
          'removed an abandoned legacy migration upload (no import row, idle a day)',
        );
        continue;
      }
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

  private async orphanAbandoned(importId: string): Promise<boolean> {
    const written = await this.deps.workspaces.lastWrittenAt(importId);
    if (written === null) return false;
    return this.deps.clock.now().getTime() - written.getTime() >= LEGACY_MIGRATION_ORPHAN_IDLE_MS;
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

  /**
   * Phase 7 (review H1), the backstop to the recovery executor's own sweep: an unfinished
   * import created before the latest NEXA restore's cutover came back WITH that restore (the
   * protective backup is taken while the import is APPROVED). Continuing it would import again
   * (or hold the installation frozen); it is closed `SUPERSEDED_BY_RESTORE`, before any claim.
   */
  private async supersedeRestored(): Promise<void> {
    const cutoverAt = await this.deps.latestCutoverAt();
    if (cutoverAt === null) return;
    const closed = await this.deps.repository.supersedeBefore({
      before: cutoverAt,
      now: this.deps.clock.now(),
    });
    for (const importId of closed) {
      this.deps.logger.warn(
        { importId },
        'a legacy migration from before a NEXA restore was closed instead of being continued',
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
    const beat = (): Promise<void> => {
      const now = this.deps.clock.now();
      return this.deps.repository
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
    };
    const heartbeat = setInterval(
      guardedTick('legacy-migration-heartbeat', beat, this.deps.logger),
      this.deps.heartbeatMs ?? LEGACY_MIGRATION_LEASE_HEARTBEAT_MS,
    );
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
          // Every write of the apply (the importer's, the history's, the cutover gate's) runs
          // as this import's own writer: the only writer its APPLYING freeze lets through.
          await this.deps.asImportWriter(row.id, () => this.apply(row, abort.signal));
          break;
        case 'ADOPT_REQUESTED':
        case 'ADOPT_RUNNING':
          // NOT as an import writer: the lane holds no freeze and passes none. While any
          // import is APPLYING (or a restore quiesces), its writes are refused like any other.
          await this.adopt(row, abort.signal);
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
          'a legacy migration step will run again later (another importer process, a running backup or a recovery holds it)',
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
    if (row.progress.dryRunAttempts >= LEGACY_MIGRATION_MAX_STEP_ATTEMPTS) {
      this.deps.logger.error(
        { importId: row.id, attempts: row.progress.dryRunAttempts },
        'a legacy migration dry run was started too many times and is failed',
      );
      await this.fail(
        row,
        ['DRY_RUN_REQUESTED', 'DRY_RUN_RUNNING'],
        'DRY_RUN_FAILED',
        'IMPORT_FAILED',
      );
      return;
    }
    // Every start is counted BEFORE the step's workspace is made, in DRY_RUN_REQUESTED as well
    // (Codex review on #278): a work directory that cannot be created (a full, missing or
    // unwritable volume) fails `withStep` before its callback runs, and a start counted only
    // inside it left the row DRY_RUN_REQUESTED with no attempt, retried on every tick for ever
    // while the one-active index held every other import back. The request resets the count
    // (`requestDryRun`); waiting on an operator or on another process gives the start back.
    row = await this.bookmark(row, {
      blocker: null,
      dryRunAttempts: row.progress.dryRunAttempts + 1,
    });
    try {
      await this.withStep(row, signal, async (context) => {
        try {
          // A production-like target's gates come FIRST: a synthetic package is refused there.
          // (Phase 7: the dry run no longer waits for the target acknowledgement — it writes no
          // customer and no money; the owner's approval carries the acknowledgement that arms
          // the apply.)
          await this.deps.runner.precheck(context, 'DRY_RUN');
          if (row.status === 'DRY_RUN_REQUESTED') {
            row = await this.advance(row, ['DRY_RUN_REQUESTED'], 'DRY_RUN_RUNNING', {
              progress: { ...row.progress, phase: 'DRY_RUN', refusalCounts: [], blocker: null },
            });
          }
          await this.assertPackageUnchanged(row);
          await this.assertFreshTarget(row, ['DRY_RUN_RUNNING']);
          const { report, legacyRunId } = await timedSection(this.deps.logger, 'dry_run', () =>
            this.deps.runner.dryRun(context),
          );
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
      if (error instanceof LegacyMigrationRetry || error instanceof LegacyMigrationBlocked) {
        await this.uncount(row, { dryRunAttempts: row.progress.dryRunAttempts - 1 });
      }
      throw error;
    }
  }

  // --- ADOPT APPROVED (`service-review.md` §4b) ------------------------------------------

  /**
   * The "adopt approved" lane: a re-upload of a package whose import of this tenant FINISHED,
   * verified, executes the operators' ADOPT approvals of that source through the importer's
   * `adoptApproved` (every guard of §4b is the importer's). Here, before the package is
   * opened for it:
   *
   * - bounded like the dry run (`LEGACY_MIGRATION_MAX_STEP_ATTEMPTS`), every start counted;
   * - a production-like target refuses a synthetic package (`precheck('ADOPT')`);
   * - a confirmed restore, or ANY import APPLYING (the installation-wide write freeze): the
   *   lane WAITS, with the blocker shown — it never runs as an import's writer, so its writes
   *   would be refused anyway;
   * - the package is the uploaded one, and a finished import of its source exists: the lane is
   *   bound to THAT import's apply run and to the inventory hold its approved dry run recorded.
   *
   * Another run RUNNING or another importer process is transient (`LegacyMigrationRetry`, not
   * counted); a refusal is FAILED with its code (`ADOPT_REFUSED`, …), nothing adopted; an
   * interruption runs again and the importer resumes its own lane run.
   */
  private async adopt(claimed: LegacyNxpkgImportRow, signal: AbortSignal): Promise<void> {
    let row = claimed;
    if (row.progress.adoptAttempts >= LEGACY_MIGRATION_MAX_STEP_ATTEMPTS) {
      this.deps.logger.error(
        { importId: row.id, attempts: row.progress.adoptAttempts },
        'an adopt-approved lane was started too many times and is failed',
      );
      await this.fail(row, ['ADOPT_REQUESTED', 'ADOPT_RUNNING'], 'FAILED', 'IMPORT_FAILED');
      return;
    }
    row = await this.bookmark(row, {
      blocker: null,
      adoptAttempts: row.progress.adoptAttempts + 1,
    });
    try {
      await this.withStep(row, signal, async (context) => {
        try {
          await this.deps.runner.precheck(context, 'ADOPT');
          if (await this.deps.recoveryActive()) throw new LegacyMigrationBlocked('RECOVERY_ACTIVE');
          if ((await this.deps.repository.applyingImportId()) !== null) {
            throw new LegacyMigrationBlocked('ANOTHER_IMPORT_APPLYING');
          }
          await this.assertPackageUnchanged(row);
          const source = row.packageSourceFingerprint;
          const imported =
            source === null
              ? null
              : await this.deps.repository.latestCompletedOf(row.tenantId, source);
          if (imported === null || imported.applyLegacyRunId === null) {
            throw new LegacyMigrationStepFailure(
              'ADOPT_REFUSED',
              'No finished import of this package’s source exists on this tenant.',
            );
          }
          if (row.status === 'ADOPT_REQUESTED') {
            row = await this.advance(row, ['ADOPT_REQUESTED'], 'ADOPT_RUNNING', {
              progress: { ...row.progress, phase: 'ADOPT', refusalCounts: [], blocker: null },
            });
          }
          const hold = imported.dryRunReport?.inventoryHold;
          const report = await this.deps.runner.adoptApproved(context, {
            importLegacyRunId: imported.applyLegacyRunId,
            inventoryHold: validInventoryHold(hold)
              ? { digest: hold.digest, invoices: hold.invoices }
              : null,
          });
          await this.advance(
            row,
            ['ADOPT_RUNNING'],
            'ADOPT_DONE',
            { adoptReport: report, adoptLegacyRunId: report.legacyRunId },
            { release: true },
          );
        } catch (error) {
          if (!(error instanceof LegacyMigrationStepFailure)) throw error;
          await this.fail(
            row,
            ['ADOPT_REQUESTED', 'ADOPT_RUNNING'],
            'FAILED',
            error.code,
            error.counts,
          );
        }
      });
    } catch (error) {
      if (error instanceof LegacyMigrationRetry || error instanceof LegacyMigrationBlocked) {
        await this.uncount(row, { adoptAttempts: row.progress.adoptAttempts - 1 });
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
    const nowMs = this.deps.clock.now().getTime();
    if (row.status === 'APPLYING') {
      // A crash LOOP is a verdict an owner must read, not a process that retries for ever —
      // and while APPLYING the whole installation is frozen, so the bound is what lifts it.
      // (An APPLYING row with no key before BACKUP cannot be continued either; nor one still
      // being resumed past the wall-clock window.)
      const expired =
        row.approvedAt === null ||
        nowMs - row.approvedAt.getTime() > LEGACY_MIGRATION_APPLY_WINDOW_MS;
      if (
        row.progress.applyAttempts >= LEGACY_MIGRATION_MAX_APPLY_ATTEMPTS ||
        row.keyCiphertext === null ||
        expired
      ) {
        this.deps.logger.error(
          {
            importId: row.id,
            attempts: row.progress.applyAttempts,
            phase: row.progress.phase,
            expired,
          },
          'a legacy migration apply was resumed too many times (or too long) and is failed',
        );
        await this.fail(row, ['APPLYING'], 'FAILED', 'IMPORT_FAILED');
        return;
      }
      // COUNTED HERE, before anything else can throw (review H3): an attempt that dies in a
      // precheck, the step directory, the key, the read sets or a port that is not wired is
      // still an attempt, so a fault that repeats reaches the bound instead of holding the
      // freeze for ever. A transient refusal (`LegacyMigrationRetry`) counts too while
      // APPLYING, for the same reason.
      row = await this.bookmark(row, { applyAttempts: row.progress.applyAttempts + 1 });
    } else if (
      row.approvedAt === null ||
      nowMs - row.approvedAt.getTime() > LEGACY_MIGRATION_APPROVAL_TTL_MS
    ) {
      // An approval means "now": one left waiting past the TTL (a blocker, a recovery, an
      // executor that was off) is not the owner's decision about today. Nothing was written.
      this.deps.logger.warn(
        { importId: row.id, approvedAt: row.approvedAt?.toISOString() ?? null },
        'a legacy migration approval expired before the import started',
      );
      await this.fail(row, ['APPROVED'], 'FAILED', 'APPROVAL_EXPIRED');
      return;
    }
    const resumed = phaseReached(row.progress.phase, 'APPLY_IMPORT');
    await this.withStep(row, signal, async (context) => {
      try {
        if (!resumed) {
          // Before anything is written, and on every attempt until the import starts:
          //   1. the target acknowledgement (production-like; never a synthetic package);
          //   2. the approval is bound to THIS dry run of THIS file;
          //   3. the fresh target;
          //   4. (Phase 7, once) no recovery holds the installation, then the MANDATORY
          //      protective backup — verified, or the import is FAILED with nothing written —
          //      and, in the same UPDATE that records it, APPROVED → APPLYING: from here the
          //      installation is frozen for every writer but this import;
          //   5. the APPROVED reads — the read sets ingested and recorded, each bound to the
          //      fingerprint the approved dry run observed (the dry run itself wrote none);
          //   6. the owner's cutover approval of the seven values and stop-sales
          //      (production-like), which needs the read sets of step 5 recorded.
          await timedSection(this.deps.logger, 'apply.precheck', async () => {
            await this.deps.runner.precheck(context, 'TARGET');
            this.assertApprovedDigest(row);
            await this.assertPackageUnchanged(row);
            await this.assertFreshTarget(row, [row.status]);
          });
          if (row.status === 'APPROVED') {
            const approved = row;
            row = await timedSection(this.deps.logger, 'apply.protective_backup', () =>
              this.protect(approved),
            );
          }
          await timedSection(this.deps.logger, 'apply.read_sets', () =>
            this.deps.runner.recordReadSets(context),
          );
        }
        // Production-like: before the first write AND before every resume. The importer's
        // own gate decides again inside its transaction. A blocker here is met while
        // APPLYING, i.e. while the installation is frozen — see the catch below.
        await this.deps.runner.precheck(context, 'APPLY');
        if (row.progress.blocker !== null) {
          row = await this.bookmark(row, { blocker: null });
        }

        // Re-checked on every attempt, the first and every resume: the approval is bound
        // to THIS dry run of THIS file, whatever happened in between.
        this.assertApprovedDigest(row);
        await this.assertPackageUnchanged(row);
        if (!resumed) row = await this.bookmark(row, { phase: 'APPLY_IMPORT' });

        if (!phaseReached(row.progress.phase, 'HISTORY')) {
          // A verdict recorded by an attempt that crashed before the HISTORY bookmark is the
          // outcome: the import is not asked again.
          if (row.progress.importerVerdict === null || row.applyLegacyRunId === null) {
            const approvedDryRunSha256 = row.approvedDryRunSha256 ?? '';
            const outcome = await timedSection(this.deps.logger, 'apply.import', () =>
              this.deps.runner.apply(context, {
                mode: resumed ? 'RESUME' : 'IMPORT',
                approvedDryRunSha256,
              }),
            );
            // Recorded at once, on its own: a crash before the next bookmark keeps it.
            row = await this.bookmark(
              row,
              { importerVerdict: outcome.importerVerdict },
              { applyLegacyRunId: outcome.legacyRunId },
            );
          }
          row = await this.bookmark(row, { phase: 'HISTORY' });
        }
        if (!phaseReached(row.progress.phase, 'MATERIALIZE')) {
          const archived = await timedSection(
            this.deps.logger,
            'apply.history',
            () => this.deps.history.ingest(context),
            (a) => a.counts.reduce((sum, c) => sum + c.count, 0),
          );
          row = await this.bookmark(row, {
            phase: 'MATERIALIZE',
            history: [...archived.counts],
          });
        }
        // The two one-time-import phases are decided by their OWN progress field, not only by
        // the phase order: an import a previous release left APPLYING at RECONCILE, REPORT or
        // later never recorded them, and the ordinal check alone would take them as done
        // (Codex on #288). A phase bookmark never moves backwards.
        const atLeast = (phase: LegacyMigrationPhase): LegacyMigrationPhase =>
          phaseReached(row.progress.phase, phase) ? (row.progress.phase ?? phase) : phase;
        if (row.progress.materialize === undefined) {
          // Every step is idempotent: a resumed phase runs them all again and writes nothing
          // twice. Nothing it writes is money, a message or a provider call.
          const materialized = await timedSection(
            this.deps.logger,
            'apply.materialize',
            () => this.deps.materialize.apply(context),
            (m) => m.reduce((sum, o) => sum + o.written + o.alreadyPresent, 0),
          );
          row = await this.bookmark(row, {
            phase: atLeast('BOT_LINK'),
            materialize: [...materialized],
          });
        }
        if (row.progress.botLink === undefined) {
          const linked = await timedSection(this.deps.logger, 'apply.bot_link', () =>
            this.deps.botLink.link(context),
          );
          row = await this.bookmark(row, { phase: atLeast('RECONCILE'), botLink: linked });
        }
        if (!phaseReached(row.progress.phase, 'REPORT')) {
          const reconciled = await timedSection(this.deps.logger, 'apply.reconcile', () =>
            this.deps.runner.reconcile(context),
          );
          row = await this.bookmark(row, {
            phase: 'REPORT',
            reconcileVerdict: reconciled.verdict,
          });
        }
        const verdicts = {
          importerVerdict: row.progress.importerVerdict ?? 'UNKNOWN',
          reconcileVerdict: row.progress.reconcileVerdict ?? 'DISCREPANCY',
          history: row.progress.history,
        } as const;
        const core = await timedSection(this.deps.logger, 'apply.final_report', () =>
          this.deps.runner.finalReport(context, verdicts),
        );
        // The exact-match report: the importer's own rows (users, balances) and every
        // history step's. COMPLETE needs every one of them to hold.
        const exactMatch = exactMatchReport([
          ...exactMatchRowsFromWire(core.exactMatch?.rows ?? []),
          ...exactMatchRowsFromWire(
            await timedSection(this.deps.logger, 'apply.exact_match', () =>
              this.deps.materialize.match(context),
            ),
          ),
        ]);
        const report: LegacyMigrationApplyReport = {
          ...core,
          materialize: row.progress.materialize ?? [],
          botLink: row.progress.botLink ?? null,
          exactMatch,
        };
        // The key is erased WITH the BACKUP bookmark — before the backup is requested, so
        // the backup never holds it, and a crash from here on needs no key: the backup is
        // all that is left.
        row = await this.bookmark(
          row,
          { phase: 'BACKUP' },
          { applyReport: report, keyCiphertext: null, keyKeyId: null },
        );
      } catch (error) {
        if (error instanceof LegacyMigrationBlocked && row.status === 'APPLYING') {
          // WAITING IS NOT AN OPTION ONCE APPLYING: the installation is frozen, so the very
          // operator write that could clear the blocker (a cutover approval, stop-sales) is
          // refused, and an import that waited would hold the freeze for ever. It is FAILED
          // instead, the blocker kept on its progress; the protective backup is the undo.
          this.deps.logger.error(
            { importId: row.id, blocker: error.blocker, phase: row.progress.phase },
            'a legacy migration met a blocker while the installation was frozen and is failed',
          );
          const current = await this.reread(row.id);
          await this.advance(current, ['APPLYING'], 'FAILED', {
            errorCode: 'IMPORT_FAILED',
            progress: { ...current.progress, blocker: error.blocker },
          });
          return;
        }
        if (!(error instanceof LegacyMigrationStepFailure)) throw error;
        await this.fail(row, ['APPROVED', 'APPLYING'], 'FAILED', error.code, error.counts);
      }
    });
    if (row.status === 'APPLYING' && phaseReached(row.progress.phase, 'BACKUP')) {
      await this.finish(row);
    }
  }

  /**
   * Phase 7 — before the import's first write: no recovery may hold the installation, and
   * the MANDATORY protective backup (`BackupPort.runBeforeImport`, the pipeline's
   * `PRE_RESTORE`) must be TAKEN — succeeded AND verified. Its run id is recorded in the SAME
   * conditional UPDATE that moves the import APPROVED → APPLYING (the freeze), so an APPLYING
   * row always names its backup and a resumed one never takes a second (it never comes back
   * here: only an APPROVED row does).
   *
   * - a recovery is confirmed and not finished, or another import is APPLYING: the import
   *   WAITS with the blocker shown (`RECOVERY_ACTIVE`, `ANOTHER_IMPORT_APPLYING`), still
   *   APPROVED; another backup holds the pipeline: it runs again later
   *   (`LegacyMigrationRetry`), still APPROVED;
   * - any other outcome, or an error from the pipeline: FAILED `PRE_IMPORT_BACKUP_FAILED`,
   *   nothing imported. No override, as for the recovery's emergency backup.
   */
  private async protect(row: LegacyNxpkgImportRow): Promise<LegacyNxpkgImportRow> {
    // Shown, not silent (review M1/M4): the import WAITS, still APPROVED and cancellable, with
    // the reason on its progress — a confirmed NEXA restore, or another import (any tenant)
    // holding the one installation-wide freeze. The partial unique index is the database's
    // rule for the second; this check spares a protective backup that could not be used.
    if (await this.deps.recoveryActive()) throw new LegacyMigrationBlocked('RECOVERY_ACTIVE');
    const applying = await this.deps.repository.applyingImportId();
    if (applying !== null && applying !== row.id) {
      throw new LegacyMigrationBlocked('ANOTHER_IMPORT_APPLYING');
    }
    let backup: Awaited<ReturnType<BackupPort['runBeforeImport']>>;
    try {
      backup = await this.deps.backup.runBeforeImport();
    } catch (error) {
      if (error instanceof LegacyMigrationNotWired) throw error;
      this.deps.logger.error(
        { importId: row.id, err: errorKind(error) },
        'the protective backup before a legacy migration failed',
      );
      throw new LegacyMigrationStepFailure(
        'PRE_IMPORT_BACKUP_FAILED',
        'The protective backup before the import did not run.',
        { cause: error },
      );
    }
    if (backup.outcome === 'BUSY') throw new LegacyMigrationRetry('BACKUP_BUSY');
    if (backup.outcome !== 'TAKEN' || backup.runId === null) {
      this.deps.logger.error(
        { importId: row.id, outcome: backup.outcome, backupRunId: backup.runId },
        'the protective backup before a legacy migration was not taken and verified',
      );
      throw new LegacyMigrationStepFailure(
        'PRE_IMPORT_BACKUP_FAILED',
        'The protective backup before the import was not taken and verified.',
      );
    }
    this.deps.logger.info(
      { importId: row.id, backupRunId: backup.runId },
      'the protective backup before a legacy migration is taken; the installation is frozen for the import',
    );
    // The FIRST attempt is counted in the same write (review H3): from here every error
    // counts toward the bound, however early in the attempt it comes.
    return this.advance(row, ['APPROVED'], 'APPLYING', {
      preImportBackupRunId: backup.runId,
      progress: {
        ...row.progress,
        phase: 'APPLY_PRECHECK',
        blocker: null,
        applyAttempts: row.progress.applyAttempts + 1,
      },
    });
  }

  /**
   * The standard backup, then the outcome. COMPLETED only when the importer said exactly
   * `COMPLETED`, the reconcile RECONCILED and the v2 report holds.
   */
  private async finish(row: LegacyNxpkgImportRow): Promise<void> {
    const backup = await timedSection(this.deps.logger, 'apply.backup', () => this.backup(row));
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
        targetAck: row.targetAck,
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
      Pick<
        LegacyMigrationProgress,
        'verifyAttempts' | 'dryRunAttempts' | 'applyAttempts' | 'adoptAttempts'
      >
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
    row.applyReport?.reportHolds === true &&
    // The one-time import is COMPLETE only when no difference is left unexplained.
    row.applyReport.exactMatch?.holds === true
    ? 'COMPLETED'
    : 'COMPLETED_WITH_DISCREPANCY';
}
