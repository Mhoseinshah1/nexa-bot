import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { ScopeBound } from '../../../../infrastructure/persistence/database-scope.js';
import { backupRuns } from '../../../../infrastructure/persistence/schema.js';
import type { BackupRunRow } from '../application/ports.js';
import { toRow } from './drizzle-backup-run.repository.js';

/** The subject's TENANT runs: never the installation's, never another hosted bot's. */
function of(subjectTenantId: string) {
  return and(
    eq(backupRuns.archiveScope, 'TENANT'),
    eq(backupRuns.subjectTenantId, subjectTenantId),
  );
}

/**
 * Phase 6B PR-2 (ADR-0039 § 7): the reads and the retention mark of ONE hosted tenant's
 * archive runs — `backup_runs` rows of `archive_scope = 'TENANT'` naming it as their subject.
 *
 * `backup_runs` carries no tenant (ADR-0037's list), so every method is on the system path
 * under `DrizzleHostedArchiveRuns.<method>` (pinned in `tests/unit/system-path-allowlist.ts`),
 * and every statement names the subject tenant: the installation's own runs and other hosted
 * bots' are never in an answer here, and the installation's history and retention never see
 * these (`INSTALLATION_RUN` in `DrizzleBackupRunRepository`).
 */
@ScopeBound({ installation: true })
export class DrizzleHostedArchiveRuns {
  constructor(private readonly db: Database) {}

  /** Newest first. */
  async recent(subjectTenantId: string, limit: number): Promise<readonly BackupRunRow[]> {
    const rows = await this.db
      .select()
      .from(backupRuns)
      .where(of(subjectTenantId))
      .orderBy(desc(backupRuns.startedAt), desc(backupRuns.id))
      .limit(limit);
    return rows.map(toRow);
  }

  /** One run of this subject, or null (another tenant's, the installation's, or none). */
  async byId(subjectTenantId: string, id: string): Promise<BackupRunRow | null> {
    const [row] = await this.db
      .select()
      .from(backupRuns)
      .where(and(of(subjectTenantId), eq(backupRuns.id, id)))
      .limit(1);
    return row === undefined ? null : toRow(row);
  }

  /** The start of the newest FINISHED run of this subject: the schedule's last attempt. */
  async lastAttemptAt(subjectTenantId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ startedAt: backupRuns.startedAt })
      .from(backupRuns)
      .where(and(of(subjectTenantId), isNotNull(backupRuns.finishedAt)))
      .orderBy(desc(backupRuns.startedAt))
      .limit(1);
    return row?.startedAt ?? null;
  }

  /** The newest VERIFIED success of this subject (the hosted owner's «last backup»). */
  async lastVerifiedAt(subjectTenantId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ verifiedAt: backupRuns.verifiedAt })
      .from(backupRuns)
      .where(
        and(
          of(subjectTenantId),
          eq(backupRuns.state, 'SUCCEEDED'),
          isNotNull(backupRuns.verifiedAt),
        ),
      )
      .orderBy(desc(backupRuns.startedAt))
      .limit(1);
    return row?.verifiedAt ?? null;
  }

  /**
   * This subject's verified archives beyond the newest `keep`, oldest first, still on disk:
   * what its own retention removes. The newest verified one is never among them (`keep` ≥ 1).
   */
  async pruneCandidates(subjectTenantId: string, keep: number): Promise<readonly BackupRunRow[]> {
    const rows = await this.db
      .select()
      .from(backupRuns)
      .where(
        and(
          of(subjectTenantId),
          eq(backupRuns.state, 'SUCCEEDED'),
          isNotNull(backupRuns.verifiedAt),
          isNull(backupRuns.archivePrunedAt),
        ),
      )
      .orderBy(desc(backupRuns.startedAt), desc(backupRuns.id))
      .offset(Math.max(1, keep));
    return rows.map(toRow).reverse();
  }

  /** Stamps a removed archive; only a finished run of this subject. */
  async markPruned(subjectTenantId: string, id: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(backupRuns)
      .set({ archivePrunedAt: now })
      .where(
        and(
          of(subjectTenantId),
          eq(backupRuns.id, id),
          isNull(backupRuns.archivePrunedAt),
          sql`${backupRuns.state} <> 'RUNNING'`,
        ),
      )
      .returning({ id: backupRuns.id });
    return rows.length > 0;
  }
}
