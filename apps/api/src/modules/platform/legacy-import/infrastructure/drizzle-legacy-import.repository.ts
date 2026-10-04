import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  LEGACY_IMPORT_ERROR_CODES,
  LEGACY_REVIEW_RESOLUTION_STATE,
  errors,
  isLegacyReviewReasonCode,
  type ActorType,
  type LegacyImportEntityType,
  type LegacyImportMapStatus,
  type LegacyImportReasonCode,
  type LegacyImportRunFailureCode,
  type LegacyImportRunMode,
  type LegacyImportRunStatus,
  type LegacyReviewReasonCode,
  type LegacyReviewResolutionCode,
  type LegacyReviewState,
  type TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  legacyImportMap,
  legacyImportRuns,
} from '../../../../infrastructure/persistence/schema.js';
import {
  LEGACY_IMPORT_REVIEW_PAGE_MAX,
  assertCodeVersion,
  assertLegacyKey,
  assertSha256,
  decideMapWrite,
  reviewAfterWrite,
  type LegacyImportMapRecord,
  type LegacyImportMapWrite,
  type LegacyImportMapWriteOutcome,
  type LegacyImportRepository,
  type LegacyImportReviewPage,
  type LegacyImportRunRecord,
  type LegacyImportStartOutcome,
  type LegacyImportSummaryRow,
  type LegacyReviewActorRef,
  type LegacyReviewCountRow,
  type LegacyReviewTransitionOutcome,
} from '../application/legacy-import-ports.js';

type RunRow = typeof legacyImportRuns.$inferSelect;
type MapRow = typeof legacyImportMap.$inferSelect;

/**
 * `legacy_import_runs` / `legacy_import_map` in PostgreSQL. Every statement names the tenant
 * in its WHERE clause, including the primary-key lookups, so another tenant's run or row
 * never leaves the database and can never be written through.
 */
export class DrizzleLegacyImportRepository implements LegacyImportRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async startOrResume(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly mode: LegacyImportRunMode;
      readonly sourceFingerprint: string;
      readonly codeVersion: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<LegacyImportStartOutcome> {
    const tenantId = requireTenantId(scope);
    assertSha256(input.sourceFingerprint, 'source fingerprint');
    assertCodeVersion(input.codeVersion);
    const db = this.exec(tx);

    const resumeOrRefuse = (running: RunRow): LegacyImportStartOutcome => {
      // Only an APPLY run resumes: its progress is the map, keyed by legacy row, so a
      // re-processed row is UNCHANGED. A dry run's progress is counters, which a re-run
      // would inflate.
      if (
        running.mode === 'APPLY' &&
        running.sourceFingerprint === input.sourceFingerprint &&
        running.mode === input.mode
      ) {
        return { kind: 'RESUMED', run: toRun(running) };
      }
      throw errors.conflict(
        LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT,
        'Another legacy import run is RUNNING for this tenant (a different source or mode, or a dry run, which never resumes).',
        { runId: running.id },
      );
    };

    const running = await this.lockRunning(db, tenantId);
    if (running !== null) return resumeOrRefuse(running);

    // An id already spent on a finished run is not a fresh start, and not a resume either.
    const sameId = await db
      .select({ id: legacyImportRuns.id })
      .from(legacyImportRuns)
      .where(and(eq(legacyImportRuns.tenantId, tenantId), eq(legacyImportRuns.id, input.id)));
    if (sameId.length > 0) {
      throw errors.conflict(
        LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT,
        'This run id belongs to a run that has already finished; a new run needs a new id.',
        { runId: input.id },
      );
    }

    const inserted = await db
      .insert(legacyImportRuns)
      .values({
        id: input.id,
        tenantId,
        mode: input.mode,
        status: 'RUNNING',
        sourceFingerprint: input.sourceFingerprint,
        codeVersion: input.codeVersion,
        startedAt: input.now,
        lastProgressAt: input.now,
      })
      // The partial unique index is the arbiter: a concurrent start that won is waited for
      // and then read, rather than aborting this transaction with a unique violation.
      .onConflictDoNothing({ target: legacyImportRuns.tenantId, where: sql`status = 'RUNNING'` })
      .returning();
    const row = inserted[0];
    if (row !== undefined) return { kind: 'STARTED', run: toRun(row) };

    const winner = await this.lockRunning(db, tenantId);
    if (winner === null) {
      // The winner finished between its insert and this read. Starting again is a caller
      // decision, not something to do silently here.
      throw errors.conflict(
        LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT,
        'A concurrent legacy import run started and finished; retry the start.',
      );
    }
    return resumeOrRefuse(winner);
  }

  private async lockRunning(db: Executor, tenantId: string): Promise<RunRow | null> {
    const rows = await db
      .select()
      .from(legacyImportRuns)
      .where(and(eq(legacyImportRuns.tenantId, tenantId), eq(legacyImportRuns.status, 'RUNNING')))
      .for('update');
    return rows[0] ?? null;
  }

  async findRun(
    scope: TenantContext,
    runId: string,
    tx?: unknown,
  ): Promise<LegacyImportRunRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(legacyImportRuns)
      .where(and(eq(legacyImportRuns.tenantId, tenantId), eq(legacyImportRuns.id, runId)));
    const row = rows[0];
    return row === undefined ? null : toRun(row);
  }

  async checkpoint(
    scope: TenantContext,
    runId: string,
    rowsSeen: number,
    now: Date,
    tx: unknown,
  ): Promise<LegacyImportRunRecord> {
    const tenantId = requireTenantId(scope);
    if (!Number.isSafeInteger(rowsSeen) || rowsSeen < 0) {
      throw errors.validation(LEGACY_IMPORT_ERROR_CODES.INVALID, 'rows seen must be a count');
    }
    const rows = await this.exec(tx)
      .update(legacyImportRuns)
      .set({
        rowsSeen: sql`GREATEST(${legacyImportRuns.rowsSeen}, ${rowsSeen})`,
        lastProgressAt: sql`GREATEST(${legacyImportRuns.lastProgressAt}, ${now})`,
      })
      .where(
        and(
          eq(legacyImportRuns.tenantId, tenantId),
          eq(legacyImportRuns.id, runId),
          eq(legacyImportRuns.status, 'RUNNING'),
        ),
      )
      .returning();
    const row = rows[0];
    if (row === undefined) return this.refuseRun(scope, runId, tx);
    return toRun(row);
  }

  async finish(
    scope: TenantContext,
    runId: string,
    outcome:
      | { readonly status: 'COMPLETED' | 'ABORTED' }
      | { readonly status: 'FAILED'; readonly failureCode: LegacyImportRunFailureCode },
    now: Date,
    tx: unknown,
  ): Promise<LegacyImportRunRecord> {
    const tenantId = requireTenantId(scope);
    const db = this.exec(tx);
    // Lock FIRST, count AFTERWARDS. Every map write holds this row FOR SHARE until it
    // commits, so this lock waits for the in-flight ones; the count is then a NEW
    // statement, whose snapshot sees them. A subquery inside the UPDATE would use the
    // snapshot from before the wait and snapshot counters that omit the last writes.
    const locked = await db
      .select({ id: legacyImportRuns.id, mode: legacyImportRuns.mode })
      .from(legacyImportRuns)
      .where(
        and(
          eq(legacyImportRuns.tenantId, tenantId),
          eq(legacyImportRuns.id, runId),
          eq(legacyImportRuns.status, 'RUNNING'),
        ),
      )
      .for('update');
    const lockedRun = locked[0];
    if (lockedRun === undefined) return this.refuseRun(scope, runId, tx);

    // A dry run's counters were incremented decision by decision; it has no map rows, and
    // counting them would overwrite its result with zeros.
    const counters =
      lockedRun.mode === 'DRY_RUN' ? {} : await this.countMapRows(db, tenantId, runId);

    const rows = await db
      .update(legacyImportRuns)
      .set({
        status: outcome.status,
        failureCode: outcome.status === 'FAILED' ? outcome.failureCode : null,
        // Never before the run's own recorded progress, whatever the caller's clock says.
        finishedAt: sql`GREATEST(${legacyImportRuns.startedAt}, ${legacyImportRuns.lastProgressAt}, ${now})`,
        lastProgressAt: sql`GREATEST(${legacyImportRuns.lastProgressAt}, ${now})`,
        ...counters,
      })
      .where(
        and(
          eq(legacyImportRuns.tenantId, tenantId),
          eq(legacyImportRuns.id, runId),
          eq(legacyImportRuns.status, 'RUNNING'),
        ),
      )
      .returning();
    const row = rows[0];
    if (row === undefined) return this.refuseRun(scope, runId, tx);
    return toRun(row);
  }

  private async countMapRows(
    db: Executor,
    tenantId: string,
    runId: string,
  ): Promise<{
    rowsImported: number;
    rowsSkipped: number;
    rowsManualReview: number;
    rowsFailed: number;
  }> {
    const counts = await db
      .select({
        imported: sql<number>`count(*) FILTER (WHERE ${legacyImportMap.status} = 'IMPORTED')::int`,
        skipped: sql<number>`count(*) FILTER (WHERE ${legacyImportMap.status} = 'SKIPPED')::int`,
        manualReview: sql<number>`count(*) FILTER (WHERE ${legacyImportMap.status} = 'MANUAL_REVIEW')::int`,
        failed: sql<number>`count(*) FILTER (WHERE ${legacyImportMap.status} = 'FAILED')::int`,
      })
      .from(legacyImportMap)
      .where(and(eq(legacyImportMap.tenantId, tenantId), eq(legacyImportMap.runId, runId)));
    const c = counts[0] ?? { imported: 0, skipped: 0, manualReview: 0, failed: 0 };
    return {
      rowsImported: c.imported,
      rowsSkipped: c.skipped,
      rowsManualReview: c.manualReview,
      rowsFailed: c.failed,
    };
  }

  async recordDryRunDecision(
    scope: TenantContext,
    runId: string,
    status: LegacyImportMapStatus,
    now: Date,
    tx: unknown,
  ): Promise<LegacyImportRunRecord> {
    const tenantId = requireTenantId(scope);
    const column = {
      IMPORTED: legacyImportRuns.rowsImported,
      SKIPPED: legacyImportRuns.rowsSkipped,
      MANUAL_REVIEW: legacyImportRuns.rowsManualReview,
      FAILED: legacyImportRuns.rowsFailed,
    }[status];
    const key = {
      IMPORTED: 'rowsImported',
      SKIPPED: 'rowsSkipped',
      MANUAL_REVIEW: 'rowsManualReview',
      FAILED: 'rowsFailed',
    }[status] as 'rowsImported' | 'rowsSkipped' | 'rowsManualReview' | 'rowsFailed';
    // One conditional UPDATE: the row lock it takes serialises it with `finish`, and the
    // predicate refuses an APPLY run or a finished one.
    const rows = await this.exec(tx)
      .update(legacyImportRuns)
      .set({
        [key]: sql`${column} + 1`,
        lastProgressAt: sql`GREATEST(${legacyImportRuns.lastProgressAt}, ${now})`,
      })
      .where(
        and(
          eq(legacyImportRuns.tenantId, tenantId),
          eq(legacyImportRuns.id, runId),
          eq(legacyImportRuns.status, 'RUNNING'),
          eq(legacyImportRuns.mode, 'DRY_RUN'),
        ),
      )
      .returning();
    const row = rows[0];
    if (row === undefined) return this.refuseRun(scope, runId, tx);
    return toRun(row);
  }

  async recordDecision(
    scope: TenantContext,
    write: LegacyImportMapWrite,
    tx: unknown,
  ): Promise<LegacyImportMapWriteOutcome> {
    const tenantId = requireTenantId(scope);
    assertLegacyKey(write.legacyTable, write.legacyId);
    assertSha256(write.checksum, 'checksum');
    // Item 9: a review row carries a review reason (the CHECK says so too; this makes the
    // refusal a typed error before SQL).
    if (
      write.decision.status === 'MANUAL_REVIEW' &&
      !isLegacyReviewReasonCode(write.decision.reasonCode)
    ) {
      throw errors.validation(
        LEGACY_IMPORT_ERROR_CODES.INVALID,
        'a manual-review decision carries a closed review reason',
      );
    }
    const db = this.exec(tx);

    // The run must be RUNNING, APPLY and THIS tenant's — read under FOR SHARE so a
    // concurrent finish waits for this write before it snapshots its counters.
    const runs = await db
      .select({ status: legacyImportRuns.status, mode: legacyImportRuns.mode })
      .from(legacyImportRuns)
      .where(and(eq(legacyImportRuns.tenantId, tenantId), eq(legacyImportRuns.id, write.runId)))
      .for('share');
    const run = runs[0];
    if (run === undefined) {
      throw errors.notFound(LEGACY_IMPORT_ERROR_CODES.RUN_NOT_FOUND, 'No such legacy import run.');
    }
    if (run.status !== 'RUNNING' || run.mode !== 'APPLY') {
      throw errors.conflict(
        LEGACY_IMPORT_ERROR_CODES.RUN_NOT_WRITABLE,
        'Only a RUNNING APPLY run writes legacy import map rows.',
        { status: run.status, mode: run.mode },
      );
    }

    const d = write.decision;
    const values = {
      runId: write.runId,
      checksum: write.checksum,
      status: d.status,
      reasonCode: d.reasonCode,
      entityType: d.status === 'IMPORTED' ? d.entityType : null,
      entityId: d.status === 'IMPORTED' ? d.entityId : null,
    };

    const inserted = await db
      .insert(legacyImportMap)
      .values({
        tenantId,
        legacyTable: write.legacyTable,
        legacyId: write.legacyId,
        ...values,
        // Item 9: every row enters review OPEN.
        reviewState: d.status === 'MANUAL_REVIEW' ? 'OPEN' : null,
        attempts: 1,
        createdAt: write.now,
        updatedAt: write.now,
      })
      .onConflictDoNothing({
        target: [legacyImportMap.tenantId, legacyImportMap.legacyTable, legacyImportMap.legacyId],
      })
      .returning();
    const fresh = inserted[0];
    if (fresh !== undefined) return { kind: 'INSERTED', record: toMap(fresh) };

    const key = and(
      eq(legacyImportMap.tenantId, tenantId),
      eq(legacyImportMap.legacyTable, write.legacyTable),
      eq(legacyImportMap.legacyId, write.legacyId),
    );
    const existingRows = await db.select().from(legacyImportMap).where(key).for('update');
    const existingRow = existingRows[0];
    if (existingRow === undefined) {
      // Unreachable: the conflicting row is never deleted. Refuse rather than guess.
      throw errors.internal(LEGACY_IMPORT_ERROR_CODES.INVALID, 'legacy import map row vanished');
    }
    const existing = toMap(existingRow);
    const verdict = decideMapWrite(existing, { checksum: write.checksum, decision: d });
    if (verdict === 'UNCHANGED') return { kind: 'UNCHANGED', record: existing };
    if (verdict !== 'UPDATE') return { kind: 'REFUSED', reason: verdict, record: existing };

    // Item 9: what the row's review becomes. A rerun only reaches here for an OPEN review,
    // a retry-resolved one, or a row not in review: `decideMapWrite` refused the rest.
    const review = reviewAfterWrite(existing, d.status);
    const updated = await db
      .update(legacyImportMap)
      .set({
        ...values,
        attempts: sql`${legacyImportMap.attempts} + 1`,
        updatedAt: sql`GREATEST(${legacyImportMap.updatedAt}, ${write.now})`,
        reviewState: review.reviewState,
        reviewResolutionCode: null,
        reviewedAt: null,
        reviewedByActorType: null,
        reviewedByActorId: null,
        ...(review.reopened
          ? { reviewReopenedCount: sql`${legacyImportMap.reviewReopenedCount} + 1` }
          : {}),
      })
      // From-state named as well as locked: the verdict was decided from THIS status and
      // review state, and a write from any other is not the write that was decided.
      .where(
        and(
          key,
          eq(legacyImportMap.status, existing.status),
          existing.reviewState === null
            ? isNull(legacyImportMap.reviewState)
            : eq(legacyImportMap.reviewState, existing.reviewState),
        ),
      )
      .returning();
    const row = updated[0];
    if (row === undefined) {
      throw errors.internal(LEGACY_IMPORT_ERROR_CODES.INVALID, 'legacy import map row vanished');
    }
    return { kind: 'UPDATED', record: toMap(row) };
  }

  async findByLegacyKeys(
    scope: TenantContext,
    legacyTable: string,
    legacyIds: readonly string[],
    tx?: unknown,
  ): Promise<readonly LegacyImportMapRecord[]> {
    const tenantId = requireTenantId(scope);
    if (legacyIds.length === 0) return [];
    for (const id of legacyIds) assertLegacyKey(legacyTable, id);
    const rows = await this.exec(tx)
      .select()
      .from(legacyImportMap)
      .where(
        and(
          eq(legacyImportMap.tenantId, tenantId),
          eq(legacyImportMap.legacyTable, legacyTable),
          inArray(legacyImportMap.legacyId, [...legacyIds]),
        ),
      )
      .orderBy(asc(legacyImportMap.legacyId));
    return rows.map(toMap);
  }

  async summarize(scope: TenantContext, tx?: unknown): Promise<readonly LegacyImportSummaryRow[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({
        legacyTable: legacyImportMap.legacyTable,
        status: legacyImportMap.status,
        reasonCode: legacyImportMap.reasonCode,
        count: sql<number>`count(*)::int`,
      })
      .from(legacyImportMap)
      .where(eq(legacyImportMap.tenantId, tenantId))
      .groupBy(legacyImportMap.legacyTable, legacyImportMap.status, legacyImportMap.reasonCode)
      .orderBy(
        asc(legacyImportMap.legacyTable),
        asc(legacyImportMap.status),
        sql`${legacyImportMap.reasonCode} ASC NULLS FIRST`,
      );
    return rows.map((r) => ({
      legacyTable: r.legacyTable,
      status: r.status as LegacyImportMapStatus,
      reasonCode: r.reasonCode as LegacyImportReasonCode | null,
      count: r.count,
    }));
  }

  async listManualReview(
    scope: TenantContext,
    query: {
      readonly legacyTable?: string;
      readonly reasonCode?: LegacyImportReasonCode;
      readonly reviewState?: LegacyReviewState;
      readonly runId?: string;
      readonly after?: { readonly legacyTable: string; readonly legacyId: string };
      readonly limit: number;
    },
    tx?: unknown,
  ): Promise<LegacyImportReviewPage> {
    const tenantId = requireTenantId(scope);
    const limit = Math.min(Math.max(1, Math.trunc(query.limit)), LEGACY_IMPORT_REVIEW_PAGE_MAX);
    const conditions: SQL[] = [
      eq(legacyImportMap.tenantId, tenantId),
      eq(legacyImportMap.status, 'MANUAL_REVIEW'),
    ];
    if (query.legacyTable !== undefined) {
      conditions.push(eq(legacyImportMap.legacyTable, query.legacyTable));
    }
    if (query.reasonCode !== undefined) {
      conditions.push(eq(legacyImportMap.reasonCode, query.reasonCode));
    }
    if (query.reviewState !== undefined) {
      conditions.push(eq(legacyImportMap.reviewState, query.reviewState));
    }
    if (query.runId !== undefined) {
      conditions.push(eq(legacyImportMap.runId, query.runId));
    }
    if (query.after !== undefined) {
      conditions.push(
        sql`(${legacyImportMap.legacyTable}, ${legacyImportMap.legacyId}) > (${query.after.legacyTable}, ${query.after.legacyId})`,
      );
    }
    const rows = await this.exec(tx)
      .select()
      .from(legacyImportMap)
      .where(and(...conditions))
      .orderBy(asc(legacyImportMap.legacyTable), asc(legacyImportMap.legacyId))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map(toMap);
    const last = items[items.length - 1];
    return {
      items,
      next:
        rows.length > limit && last !== undefined
          ? { legacyTable: last.legacyTable, legacyId: last.legacyId }
          : null,
    };
  }

  async countReview(
    scope: TenantContext,
    query: { readonly runId?: string },
    tx?: unknown,
  ): Promise<readonly LegacyReviewCountRow[]> {
    const tenantId = requireTenantId(scope);
    const conditions: SQL[] = [
      eq(legacyImportMap.tenantId, tenantId),
      eq(legacyImportMap.status, 'MANUAL_REVIEW'),
    ];
    if (query.runId !== undefined) conditions.push(eq(legacyImportMap.runId, query.runId));
    const rows = await this.exec(tx)
      .select({
        legacyTable: legacyImportMap.legacyTable,
        reasonCode: legacyImportMap.reasonCode,
        reviewState: legacyImportMap.reviewState,
        count: sql<number>`count(*)::int`,
      })
      .from(legacyImportMap)
      .where(and(...conditions))
      .groupBy(legacyImportMap.legacyTable, legacyImportMap.reasonCode, legacyImportMap.reviewState)
      .orderBy(
        asc(legacyImportMap.legacyTable),
        asc(legacyImportMap.reasonCode),
        asc(legacyImportMap.reviewState),
      );
    return rows.map((r) => ({
      legacyTable: r.legacyTable,
      reasonCode: r.reasonCode as LegacyReviewReasonCode,
      reviewState: r.reviewState as LegacyReviewState,
      count: r.count,
    }));
  }

  async resolveReview(
    scope: TenantContext,
    input: {
      readonly legacyTable: string;
      readonly legacyId: string;
      readonly expectedReasonCode: LegacyReviewReasonCode;
      readonly resolutionCode: LegacyReviewResolutionCode;
      readonly actor: LegacyReviewActorRef;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<LegacyReviewTransitionOutcome> {
    const tenantId = requireTenantId(scope);
    assertLegacyKey(input.legacyTable, input.legacyId);
    if (!isLegacyReviewReasonCode(input.expectedReasonCode)) {
      throw errors.validation(LEGACY_IMPORT_ERROR_CODES.INVALID, 'not a review reason');
    }
    const to = LEGACY_REVIEW_RESOLUTION_STATE[input.resolutionCode];
    if (to === undefined) {
      throw errors.validation(LEGACY_IMPORT_ERROR_CODES.INVALID, 'not a review resolution');
    }
    const db = this.exec(tx);
    const key = this.mapKey(tenantId, input.legacyTable, input.legacyId);
    // ONE conditional UPDATE naming its from-state: in review, OPEN, and still held for the
    // reason the caller saw. A second resolver, a reopen or a rerun that moved the row first
    // makes this match nothing; it is then classified below, never applied.
    const rows = await db
      .update(legacyImportMap)
      .set({
        reviewState: to,
        reviewResolutionCode: input.resolutionCode,
        reviewedAt: input.now,
        reviewedByActorType: input.actor.type,
        reviewedByActorId: input.actor.id,
        updatedAt: sql`GREATEST(${legacyImportMap.updatedAt}, ${input.now})`,
      })
      .where(
        and(
          key,
          eq(legacyImportMap.status, 'MANUAL_REVIEW'),
          eq(legacyImportMap.reviewState, 'OPEN'),
          eq(legacyImportMap.reasonCode, input.expectedReasonCode),
        ),
      )
      .returning();
    const changed = rows[0];
    if (changed !== undefined) return { kind: 'CHANGED', from: 'OPEN', record: toMap(changed) };

    const current = await this.readKey(db, key);
    if (current === null) return { kind: 'NOT_FOUND' };
    if (current.status !== 'MANUAL_REVIEW') return { kind: 'NOT_IN_REVIEW', record: current };
    if (
      current.reviewState === to &&
      current.reviewResolutionCode === input.resolutionCode &&
      current.reasonCode === input.expectedReasonCode
    ) {
      return { kind: 'UNCHANGED', record: current };
    }
    return { kind: 'CONFLICT', record: current };
  }

  async reopenReview(
    scope: TenantContext,
    input: { readonly legacyTable: string; readonly legacyId: string; readonly now: Date },
    tx: unknown,
  ): Promise<LegacyReviewTransitionOutcome> {
    const tenantId = requireTenantId(scope);
    assertLegacyKey(input.legacyTable, input.legacyId);
    const db = this.exec(tx);
    const key = this.mapKey(tenantId, input.legacyTable, input.legacyId);
    // The from-state is read with the row lock so the outcome can name it; the UPDATE names
    // it again, so a transition that slipped in between matches nothing.
    const before = await this.readKey(db, key, true);
    if (before === null) return { kind: 'NOT_FOUND' };
    if (before.status !== 'MANUAL_REVIEW') return { kind: 'NOT_IN_REVIEW', record: before };
    if (before.reviewState === 'OPEN') return { kind: 'UNCHANGED', record: before };
    const from = before.reviewState;
    if (from !== 'RESOLVED' && from !== 'DISMISSED') return { kind: 'CONFLICT', record: before };
    const rows = await db
      .update(legacyImportMap)
      .set({
        reviewState: 'OPEN',
        reviewResolutionCode: null,
        reviewedAt: null,
        reviewedByActorType: null,
        reviewedByActorId: null,
        reviewReopenedCount: sql`${legacyImportMap.reviewReopenedCount} + 1`,
        updatedAt: sql`GREATEST(${legacyImportMap.updatedAt}, ${input.now})`,
      })
      .where(
        and(
          key,
          eq(legacyImportMap.status, 'MANUAL_REVIEW'),
          eq(legacyImportMap.reviewState, from),
        ),
      )
      .returning();
    const changed = rows[0];
    if (changed === undefined) {
      const current = await this.readKey(db, key);
      return current === null ? { kind: 'NOT_FOUND' } : { kind: 'CONFLICT', record: current };
    }
    return { kind: 'CHANGED', from, record: toMap(changed) };
  }

  private mapKey(tenantId: string, legacyTable: string, legacyId: string): SQL {
    return and(
      eq(legacyImportMap.tenantId, tenantId),
      eq(legacyImportMap.legacyTable, legacyTable),
      eq(legacyImportMap.legacyId, legacyId),
    ) as SQL;
  }

  private async readKey(
    db: Executor,
    key: SQL,
    lock = false,
  ): Promise<LegacyImportMapRecord | null> {
    const query = db.select().from(legacyImportMap).where(key);
    const rows = lock ? await query.for('update') : await query;
    const row = rows[0];
    return row === undefined ? null : toMap(row);
  }

  private async refuseRun(scope: TenantContext, runId: string, tx: unknown): Promise<never> {
    const run = await this.findRun(scope, runId, tx);
    if (run === null) {
      throw errors.notFound(LEGACY_IMPORT_ERROR_CODES.RUN_NOT_FOUND, 'No such legacy import run.');
    }
    throw errors.conflict(
      LEGACY_IMPORT_ERROR_CODES.RUN_NOT_WRITABLE,
      'The legacy import run is no longer RUNNING.',
      { status: run.status },
    );
  }
}

function toRun(row: RunRow): LegacyImportRunRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    mode: row.mode as LegacyImportRunMode,
    status: row.status as LegacyImportRunStatus,
    sourceFingerprint: row.sourceFingerprint,
    codeVersion: row.codeVersion,
    failureCode: row.failureCode as LegacyImportRunFailureCode | null,
    rowsSeen: row.rowsSeen,
    rowsImported: row.rowsImported,
    rowsSkipped: row.rowsSkipped,
    rowsManualReview: row.rowsManualReview,
    rowsFailed: row.rowsFailed,
    startedAt: row.startedAt,
    lastProgressAt: row.lastProgressAt,
    finishedAt: row.finishedAt,
  };
}

function toMap(row: MapRow): LegacyImportMapRecord {
  return {
    tenantId: row.tenantId,
    legacyTable: row.legacyTable,
    legacyId: row.legacyId,
    runId: row.runId,
    checksum: row.checksum,
    status: row.status as LegacyImportMapStatus,
    reasonCode: row.reasonCode as LegacyImportReasonCode | null,
    entityType: row.entityType as LegacyImportEntityType | null,
    entityId: row.entityId,
    attempts: row.attempts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    reviewState: row.reviewState as LegacyReviewState | null,
    reviewResolutionCode: row.reviewResolutionCode as LegacyReviewResolutionCode | null,
    reviewedAt: row.reviewedAt,
    reviewedByActorType: row.reviewedByActorType as ActorType | null,
    reviewedByActorId: row.reviewedByActorId,
    reviewReopenedCount: row.reviewReopenedCount,
  };
}
