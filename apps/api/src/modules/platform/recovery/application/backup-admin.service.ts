import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  errors,
  PLATFORM_ERROR_CODES,
  uuidV7Schema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type PermissionKey,
  type TenantContext,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import { recordMutationDenial } from '../../access/application/authorized-mutation.js';
import type { BackupRunRepository, BackupRunRow } from '../../backup/application/ports.js';
import type { BackupService } from '../../backup/application/backup.service.js';
import type { RecoveryRequestRepository } from './ports.js';

/**
 * The Web Admin's view of the backup pipeline.
 *
 * A thin, AUTHORISED layer over `BackupRunRepository` and `BackupService`, and
 * thin is the point: it starts no backup of its own, takes no lock of its own and
 * knows nothing about stages. `run` calls exactly the method the scheduler and
 * the CLI call.
 *
 * It exists at all for three things the repository deliberately does not do —
 * check a permission, enforce the installation scope, and decide whether an
 * archive is still on disk. The last one is the only non-obvious one: the
 * repository must not touch the filesystem, and the surface must not build a
 * path, so the decision lives here.
 */

export const BACKUP_VIEW: PermissionKey = 'backup.view';
export const BACKUP_RUN: PermissionKey = 'backup.run';
export const BACKUP_DOWNLOAD: PermissionKey = 'backup.download';

export interface BackupAdminServiceDeps {
  readonly runs: BackupRunRepository;
  readonly recoveries: RecoveryRequestRepository;
  readonly backup: BackupService;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: { record(scope: unknown, event: unknown): Promise<unknown> };
  readonly clock: Clock;
  /** `BACKUP_WORK_DIR`. Used to DERIVE a path, never to accept one. */
  readonly workRoot: string;
  readonly scheduleEnabled: boolean;
  readonly intervalMs: number;
}

/** A run, plus whether its encrypted archive is still downloadable. */
export interface BackupRunView {
  readonly run: BackupRunRow;
  readonly archiveAvailable: boolean;
}

export interface BackupStatusView {
  readonly scheduleEnabled: boolean;
  readonly intervalMs: number;
  readonly lastSucceededAt: Date | null;
  readonly running: BackupRunView | null;
  readonly unknownDeliveries: number;
  readonly quiesced: boolean;
}

export class BackupAdminService {
  constructor(private readonly deps: BackupAdminServiceDeps) {}

  async status(scope: TenantContext, actor: ActorContext): Promise<BackupStatusView> {
    await this.authorize(scope, actor, BACKUP_VIEW, {
      action: 'backup.status',
      entityType: 'Backup',
      entityId: null,
    });
    const [lastSucceededAt, running, unknownDeliveries, lock] = await Promise.all([
      this.deps.runs.lastSucceededAt(),
      this.deps.runs.active(),
      this.deps.runs.countUnknownDeliveries(),
      this.deps.recoveries.installationLock(),
    ]);
    return {
      scheduleEnabled: this.deps.scheduleEnabled,
      intervalMs: this.deps.intervalMs,
      lastSucceededAt,
      running: running === null ? null : await this.withAvailability(running),
      unknownDeliveries,
      // Reported here as well as on the recovery page, because an operator
      // wondering why "take a backup now" is refused looks at the backup card
      // first. One read, from the same predicate the write gate uses.
      quiesced: lock !== null && lock.quiescing,
    };
  }

  async history(
    scope: TenantContext,
    actor: ActorContext,
    input: { limit: number; cursor: { startedAt: Date; id: string } | null },
  ): Promise<{ runs: readonly BackupRunView[]; nextCursor: string | null }> {
    await this.authorize(scope, actor, BACKUP_VIEW, {
      action: 'backup.history',
      entityType: 'Backup',
      entityId: null,
    });
    const page = await this.deps.runs.page(input);
    return {
      runs: await Promise.all(page.rows.map((run) => this.withAvailability(run))),
      nextCursor: page.nextCursor,
    };
  }

  async detail(scope: TenantContext, actor: ActorContext, id: string): Promise<BackupRunView> {
    await this.authorize(scope, actor, BACKUP_VIEW, {
      action: 'backup.detail',
      entityType: 'Backup',
      entityId: id,
    });
    return this.withAvailability(await this.requireRun(id));
  }

  /**
   * Takes a backup now, through the SAME pipeline as the scheduler.
   *
   * `trigger: 'MANUAL'` is the only difference between this and a scheduled run,
   * and it is a recorded field rather than a branch. A second execution path for
   * "the operator pressed the button" is how the unattended backup — the one that
   * matters — comes to differ from the watched one in exactly the property nobody
   * tests.
   *
   * `BUSY` is a RETURN VALUE, not an exception: one backup at a time is the
   * installation's invariant, and a second presser being told "already running,
   * since 09:14" is that invariant working.
   */
  async run(
    scope: TenantContext,
    actor: ActorContext,
    input: { idempotencyKey: string },
  ): Promise<{ outcome: 'COMPLETED' | 'BUSY'; run: BackupRunView }> {
    await this.authorize(scope, actor, BACKUP_RUN, {
      action: 'backup.run',
      entityType: 'Backup',
      entityId: null,
    });

    /*
     * REFUSED BEFORE IT STARTS, if a recovery holds the installation.
     *
     * The write gate is the authority and stays the authority — it is consulted
     * inside every transaction, which is what makes a quiesce that commits
     * mid-backup effective. But it is not sufficient HERE, and the difference is
     * not theoretical: a six-stage pipeline whose individual writes are refused
     * one at a time does not stop. It dumps, encrypts, verifies by restoring, and
     * returns COMPLETED, while the operational event that was supposed to record
     * it falls back to its degraded path because the gate refused the
     * notification beside it. The operator is told a backup was taken during a
     * restore, and a row says so.
     *
     * So the arrival is checked too, the same way every other surface checks
     * scope activity on arrival AND inside the transaction. The check here is
     * racy by construction — a recovery can begin quiescing a millisecond later —
     * and that is precisely why the gate exists underneath it.
     *
     * The scheduler is NOT given this check: it is the pre-restore backup's own
     * path too, and that one runs in the recovery lane before the window opens.
     */
    const lock = await this.deps.recoveries.installationLock();
    if (lock !== null && lock.quiescing) {
      throw errors.conflict(
        PLATFORM_ERROR_CODES.RECOVERY_QUIESCED,
        'This installation is being restored and is not taking backups. The recovery takes its own.',
        { recoveryId: lock.recoveryId },
      );
    }

    const outcome = await this.deps.backup.run('MANUAL');
    const row = outcome.kind === 'BUSY' ? outcome.holder : outcome.run;

    /*
     * The audit row is written for the PRESS, not for the backup.
     *
     * So a refused attempt and an accepted one both leave a trace, and so the
     * row names the administrator rather than `SYSTEM_JOB` — the pipeline's own
     * operational event is what records the RUN, and it is recorded by the
     * service under the installation scope with no actor. Two records of two
     * different facts; a single one would have to choose which to lose.
     *
     * `idempotencyKey` is recorded and deliberately not enforced as a key. A
     * backup is not idempotent in the sense the idempotency store means: the
     * same key replayed a day later must take a NEW backup, because the database
     * has moved on, and a store that returned the first run's id would report a
     * day-old artifact as this press's result. The installation's one-at-a-time
     * lock is what makes a double-click safe, and it is enforced by PostgreSQL.
     */
    await this.deps.audit.record(scope, actor, {
      action: 'backup.run_requested',
      entityType: 'Backup',
      entityId: row.id,
      before: null,
      after: { outcome: outcome.kind, state: row.state, idempotencyKey: input.idempotencyKey },
      result: outcome.kind === 'BUSY' ? 'DENIED' : 'SUCCESS',
    });

    return { outcome: outcome.kind, run: await this.withAvailability(row) };
  }

  /**
   * The path of an archive an authorised administrator may download.
   *
   * Returns a PATH rather than a stream, because opening a file is a surface's
   * job and deciding whether it may be opened is this one's. What matters is the
   * direction the path travels: it is DERIVED from a validated run id and the
   * configured work root, and never accepted from the caller. There is no
   * argument here an operator can aim at another file.
   *
   * Three refusals, and the third is the one that needs saying: the run must
   * exist, it must have produced an archive at all, and the archive must still be
   * there. The local artifact is not retained for ever — ADR-0011's control 5 is
   * still not in V1 — so "gone" is an ordinary outcome rather than an error, and
   * the surface renders it as «فایل محلی دیگر موجود نیست» instead of a failure.
   */
  async archivePath(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<{ path: string; filename: string; bytes: number }> {
    await this.authorize(scope, actor, BACKUP_DOWNLOAD, {
      action: 'backup.download',
      entityType: 'Backup',
      entityId: id,
    });
    const run = await this.requireRun(id);
    const path = this.pathFor(run.id);
    if (path === null) {
      throw errors.notFound(
        PLATFORM_ERROR_CODES.BACKUP_RUN_MISSING,
        'This backup produced no archive.',
      );
    }
    const bytes = await this.archiveBytes(run);
    if (bytes === null) {
      throw errors.notFound(
        PLATFORM_ERROR_CODES.BACKUP_RUN_MISSING,
        'The local archive for this backup is no longer on this host.',
      );
    }

    // CRITICAL, and therefore audited on the attempt rather than on success
    // alone. An archive leaving this host is the whole database; the row that
    // says who took it is the only thing that will exist afterwards.
    await this.deps.audit.record(scope, actor, {
      action: 'backup.archive_downloaded',
      entityType: 'Backup',
      entityId: run.id,
      before: null,
      after: { bytes, checksum: run.checksum },
      reason: 'An administrator downloaded an encrypted backup archive.',
      result: 'SUCCESS',
    });

    // The filename is BUILT from the run id, not from anything stored. A
    // `Content-Disposition` assembled from a stored string is a header-injection
    // surface, and a uuid cannot carry a quote, a newline or a semicolon.
    return { path, filename: `nexa-backup-${run.id}.nxb`, bytes };
  }

  /** Whether this run's archive is still on disk, for the list and the detail. */
  private async withAvailability(run: BackupRunRow): Promise<BackupRunView> {
    return { run, archiveAvailable: (await this.archiveBytes(run)) !== null };
  }

  private async archiveBytes(run: BackupRunRow): Promise<number | null> {
    const path = this.pathFor(run.id);
    if (path === null) return null;
    try {
      const stats = await stat(path);
      return stats.isFile() ? stats.size : null;
    } catch {
      // Absent is an ANSWER, and the common one: nothing prunes
      // `BACKUP_WORK_DIR` in V1, but a failed run discards its whole workspace
      // and an operator may have removed one by hand.
      return null;
    }
  }

  /**
   * The archive path for a run id, or null if the id is not one.
   *
   * The id is VALIDATED as a UUIDv7 rather than escaped, which is what makes
   * traversal impossible rather than handled: a validated v7 uuid cannot contain
   * a separator, a dot segment or a NUL. The filename inside the directory is the
   * constant the workspace uses.
   */
  private pathFor(id: string): string | null {
    if (!uuidV7Schema.safeParse(id).success) return null;
    return join(this.deps.workRoot, id, 'archive.nxb');
  }

  private async requireRun(id: string): Promise<BackupRunRow> {
    if (!uuidV7Schema.safeParse(id).success) {
      throw errors.notFound(PLATFORM_ERROR_CODES.BACKUP_RUN_MISSING, 'No such backup run.');
    }
    const run = await this.deps.runs.byId(id);
    if (run === null) {
      throw errors.notFound(PLATFORM_ERROR_CODES.BACKUP_RUN_MISSING, 'No such backup run.');
    }
    return run;
  }

  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    permission: PermissionKey,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (denied) {
      await recordMutationDenial(
        { guard: this.deps.guard, audit: this.deps.audit, opsLog: this.deps.opsLog as never },
        scope,
        actor,
        permission,
        denial,
        denied,
      );
      throw denied;
    }
  }
}
