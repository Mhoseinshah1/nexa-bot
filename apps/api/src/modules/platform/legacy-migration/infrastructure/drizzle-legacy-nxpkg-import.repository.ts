import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  errors,
  LEGACY_MIGRATION_HTTP_ERROR_CODES,
  LEGACY_NXPKG_TERMINAL_STATUSES,
  type LegacyMigrationApplyReport,
  type LegacyMigrationDryRunReport,
  type LegacyMigrationPanelBinding,
  type LegacyMigrationProgress,
  type LegacyMigrationVerifyReport,
  type LegacyNxpkgErrorCode,
  type LegacyNxpkgImportStatus,
  type LegacyNxpkgKeyKind,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { legacyNxpkgImports } from '../../../../infrastructure/persistence/schema.js';
import { isUniqueViolation } from '../../../../infrastructure/persistence/sqlstate.js';
import {
  EMPTY_LEGACY_MIGRATION_PROGRESS,
  isLegacyMigrationFailure,
  isLegacyMigrationTerminal,
  LEGACY_MIGRATION_WORK_STATUSES,
} from '../domain/import-lifecycle.js';
import type {
  LegacyNxpkgImportPatch,
  LegacyNxpkgImportRepository,
  LegacyNxpkgImportRow,
  LegacyNxpkgTransition,
  NewLegacyNxpkgImport,
} from '../application/ports.js';

/**
 * `legacy_nxpkg_imports`, modelled on `DrizzleRecoveryRequestRepository`.
 *
 * EVERY STATE CHANGE IS A CONDITIONAL UPDATE naming its `from` states, so a replayed command,
 * a double-click and two `migration` replicas are all safe by one mechanism: the loser's
 * UPDATE matches nothing and returns `false`.
 *
 * ONE ACTIVE IMPORT PER TENANT is the database's rule (`legacy_nxpkg_imports_one_active_idx`),
 * not this class's; `insert` only turns its 23505 into a truthful refusal.
 *
 * A TERMINAL transition erases the sealed key in the same statement that records the
 * outcome. Not a separate cleanup: a key that outlives its import by one failed statement is
 * a key held for nothing.
 */

const t = legacyNxpkgImports;
type Row = typeof t.$inferSelect;

const EMPTY_PROGRESS = EMPTY_LEGACY_MIGRATION_PROGRESS;

function toRow(row: Row): LegacyNxpkgImportRow {
  const progress = (row.progress ?? {}) as Partial<LegacyMigrationProgress>;
  return {
    id: row.id,
    tenantId: row.tenantId,
    status: row.status as LegacyNxpkgImportStatus,
    errorCode: row.errorCode as LegacyNxpkgErrorCode | null,
    fileName: row.fileName,
    filePath: row.filePath,
    fileSha256: row.fileSha256,
    fileBytes: row.fileBytes,
    packageImportId: row.packageImportId,
    packageSourceFingerprint: row.packageSourceFingerprint,
    packageSchemaVersion: row.packageSchemaVersion,
    converterVersion: row.converterVersion,
    manifestSummary: row.manifestSummary,
    keyCiphertext: row.keyCiphertext,
    keyKeyId: row.keyKeyId,
    keyKind: row.keyKind as LegacyNxpkgKeyKind | null,
    decisionsFilePath: row.decisionsFilePath,
    decisionsSummary: row.decisionsSummary,
    panelBindings: row.panelBindings as readonly LegacyMigrationPanelBinding[] | null,
    verifyReport: row.verifyReport as LegacyMigrationVerifyReport | null,
    dryRunReport: row.dryRunReport as LegacyMigrationDryRunReport | null,
    dryRunSha256: row.dryRunSha256,
    approvedDryRunSha256: row.approvedDryRunSha256,
    applyReport: row.applyReport as LegacyMigrationApplyReport | null,
    dryRunLegacyRunId: row.dryRunLegacyRunId,
    applyLegacyRunId: row.applyLegacyRunId,
    backupRunId: row.backupRunId,
    progress: { ...EMPTY_PROGRESS, ...progress },
    requestedByAdminId: row.requestedByAdminId,
    approvedByAdminId: row.approvedByAdminId,
    approvedAt: row.approvedAt,
    claimedBy: row.claimedBy,
    leaseUntil: row.leaseUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
  };
}

/** The columns a patch may touch, translated once. */
function patchColumns(patch: LegacyNxpkgImportPatch): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) set[key] = value;
  }
  return set;
}

export class DrizzleLegacyNxpkgImportRepository implements LegacyNxpkgImportRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: TransactionScope): Executor {
    return tx?.tx ?? this.db;
  }

  async insert(input: NewLegacyNxpkgImport, tx?: TransactionScope): Promise<LegacyNxpkgImportRow> {
    try {
      const [row] = await this.exec(tx)
        .insert(t)
        .values({
          id: input.id,
          tenantId: input.tenantId,
          // Always UPLOADED: a row that could be created further along would be a row whose
          // verification nothing performed.
          status: 'UPLOADED',
          fileName: input.fileName,
          filePath: input.filePath,
          fileSha256: input.fileSha256,
          fileBytes: input.fileBytes,
          progress: EMPTY_PROGRESS,
          requestedByAdminId: input.requestedByAdminId,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      if (row === undefined) throw new Error('legacy_nxpkg_imports insert returned nothing');
      return toRow(row);
    } catch (error) {
      // Named index, never a bare 23505: the primary key violating would be a different fact.
      if (isUniqueViolation(error, 'legacy_nxpkg_imports_one_active_idx')) {
        throw errors.conflict(
          LEGACY_MIGRATION_HTTP_ERROR_CODES.ALREADY_ACTIVE,
          'Another Mirza package import of this installation is not finished. One at a time.',
        );
      }
      throw error;
    }
  }

  async byId(
    tenantId: string,
    id: string,
    options: { readonly tx?: TransactionScope; readonly lock?: boolean } = {},
  ): Promise<LegacyNxpkgImportRow | null> {
    // The tenant is IN the predicate, so another tenant's id reads exactly like a missing one.
    const query = this.exec(options.tx)
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
      .limit(1);
    const [row] = options.lock === true ? await query.for('update') : await query;
    return row === undefined ? null : toRow(row);
  }

  async byIdUnscoped(id: string): Promise<LegacyNxpkgImportRow | null> {
    const [row] = await this.db.select().from(t).where(eq(t.id, id)).limit(1);
    return row === undefined ? null : toRow(row);
  }

  async active(tenantId: string, tx?: TransactionScope): Promise<LegacyNxpkgImportRow | null> {
    const [row] = await this.exec(tx)
      .select()
      .from(t)
      .where(
        and(eq(t.tenantId, tenantId), notInArray(t.status, [...LEGACY_NXPKG_TERMINAL_STATUSES])),
      )
      .limit(1);
    return row === undefined ? null : toRow(row);
  }

  async page(input: {
    readonly tenantId: string;
    readonly limit: number;
    readonly before: string | null;
  }): Promise<readonly LegacyNxpkgImportRow[]> {
    const predicates: SQL[] = [eq(t.tenantId, input.tenantId)];
    if (input.before !== null) predicates.push(lt(t.id, input.before));
    const rows = await this.db
      .select()
      .from(t)
      .where(and(...predicates))
      .orderBy(desc(t.id))
      .limit(input.limit + 1);
    return rows.map(toRow);
  }

  private guards(input: Omit<LegacyNxpkgTransition, 'to' | 'now' | 'patch'>): SQL[] {
    const predicates: SQL[] = [eq(t.id, input.id), inArray(t.status, [...input.from])];
    if (input.tenantId !== undefined) predicates.push(eq(t.tenantId, input.tenantId));
    // The lease guard, exactly as the recovery executor's: a process whose lease was
    // released while it worked must write nothing afterwards.
    if (input.leaseOwner !== undefined) predicates.push(eq(t.claimedBy, input.leaseOwner));
    if (input.unowned === true) predicates.push(isNull(t.claimedBy));
    if (input.expectDryRunSha256 !== undefined) {
      predicates.push(eq(t.dryRunSha256, input.expectDryRunSha256));
    }
    return predicates;
  }

  async transition(input: LegacyNxpkgTransition, tx?: TransactionScope): Promise<boolean> {
    const terminal = isLegacyMigrationTerminal(input.to);
    const patch = input.patch ?? {};
    if (isLegacyMigrationFailure(input.to) && (patch.errorCode ?? null) === null) {
      throw new Error(`A transition to ${input.to} needs an error code.`);
    }
    const set: Record<string, unknown> = {
      ...patchColumns(patch),
      status: input.to,
      updatedAt: input.now,
      // The CHECK ties these together: a terminal state without a finish time, or a live one
      // with it, is refused by the database.
      finishedAt: terminal ? input.now : null,
      errorCode: isLegacyMigrationFailure(input.to) ? patch.errorCode : null,
    };
    if (terminal) {
      // The key is erased with the outcome, in the same statement (design §0.6). `key_kind`
      // stays: it records WHAT was given, which is not the secret.
      set['keyCiphertext'] = null;
      set['keyKeyId'] = null;
    }
    if (terminal || input.releaseLease === true) {
      set['claimedBy'] = null;
      set['leaseUntil'] = null;
    }
    const updated = await this.exec(tx)
      .update(t)
      .set(set)
      .where(and(...this.guards(input)))
      .returning({ id: t.id });
    return updated.length > 0;
  }

  async patch(
    input: Omit<LegacyNxpkgTransition, 'to' | 'releaseLease'>,
    tx?: TransactionScope,
  ): Promise<boolean> {
    const updated = await this.exec(tx)
      .update(t)
      .set({ ...patchColumns(input.patch ?? {}), updatedAt: input.now })
      .where(and(...this.guards(input)))
      .returning({ id: t.id });
    return updated.length > 0;
  }

  async claim(input: {
    readonly leaseOwner: string;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<LegacyNxpkgImportRow | null> {
    const work = sql.join(
      LEGACY_MIGRATION_WORK_STATUSES.map((status) => sql`${status}`),
      sql`, `,
    );
    /*
     * ONE statement. The pick is `FOR UPDATE SKIP LOCKED`, so a second replica skips the row
     * this one is taking rather than waiting for it, and the outer predicate repeats the
     * lease test so a row re-leased between the pick and the write is not taken twice.
     *
     * A row is work only while its key is held: there is nothing to open the package with.
     * (An UPLOADED row before the key is given; any other after an idle key was erased —
     * L4 — until the operator gives it again.) Except APPLYING: its key is erased before the
     * post-import backup is requested, and what is left (the backup, the outcome) needs none.
     */
    const result = await this.db.execute<{ id: string }>(sql`
      UPDATE ${t}
         SET claimed_by = ${input.leaseOwner},
             lease_until = ${input.leaseUntil},
             updated_at = ${input.now}
       WHERE id = (
               SELECT candidate.id FROM ${t} AS candidate
                WHERE candidate.status IN (${work})
                  AND (candidate.key_ciphertext IS NOT NULL OR candidate.status = 'APPLYING')
                  AND (candidate.claimed_by IS NULL OR candidate.claimed_by = ${input.leaseOwner})
                ORDER BY candidate.created_at ASC, candidate.id ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
             )
         AND (claimed_by IS NULL OR claimed_by = ${input.leaseOwner})
      RETURNING id`);
    const id = result.rows[0]?.id;
    return id === undefined ? null : this.byIdUnscoped(id);
  }

  async heartbeat(input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<boolean> {
    const updated = await this.db
      .update(t)
      .set({ leaseUntil: input.leaseUntil })
      .where(and(eq(t.id, input.id), eq(t.claimedBy, input.leaseOwner)))
      .returning({ id: t.id });
    return updated.length > 0;
  }

  async release(input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly now: Date;
  }): Promise<void> {
    await this.db
      .update(t)
      .set({ claimedBy: null, leaseUntil: null, updatedAt: input.now })
      .where(and(eq(t.id, input.id), eq(t.claimedBy, input.leaseOwner)));
  }

  async reclaimStale(input: { readonly now: Date }): Promise<readonly LegacyNxpkgImportRow[]> {
    const rows = await this.db
      .update(t)
      .set({ claimedBy: null, leaseUntil: null, updatedAt: input.now })
      .where(
        and(
          inArray(t.status, [...LEGACY_MIGRATION_WORK_STATUSES]),
          isNotNull(t.leaseUntil),
          lt(t.leaseUntil, input.now),
        ),
      )
      .returning();
    return rows.map(toRow);
  }

  async expireIdleKeys(input: {
    readonly now: Date;
    readonly idleBefore: Date;
    readonly statuses: readonly LegacyNxpkgImportStatus[];
  }): Promise<readonly string[]> {
    if (input.statuses.length === 0) return [];
    // `key_kind` stays, as at a terminal state: it records WHAT was given, not the secret.
    const rows = await this.db
      .update(t)
      .set({ keyCiphertext: null, keyKeyId: null, updatedAt: input.now })
      .where(
        and(
          inArray(t.status, [...input.statuses]),
          isNotNull(t.keyCiphertext),
          isNull(t.claimedBy),
          lt(t.updatedAt, input.idleBefore),
        ),
      )
      .returning({ id: t.id });
    return rows.map((row) => row.id);
  }
}
