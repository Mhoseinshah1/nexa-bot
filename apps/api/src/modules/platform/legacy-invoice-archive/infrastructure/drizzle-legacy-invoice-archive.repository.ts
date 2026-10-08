import { and, asc, desc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import type {
  LegacyInvoiceArchiveClass,
  LegacyInvoiceArchiveRunFailure,
  LegacyInvoiceArchiveRunState,
  LegacyInvoiceParseNote,
  LegacyInvoiceProductRef,
  LegacyInvoiceRevisionReason,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  legacyImportMap,
  legacyInvoiceArchive,
  legacyInvoiceArchiveRuns,
  legacyInvoiceArchiveStaging,
} from '../../../../infrastructure/persistence/schema.js';
import type { LatestRevision, LegacyInvoiceRawRow } from '../domain/invoice-archive-row.js';
import type {
  LegacyInvoiceArchiveFilter,
  LegacyInvoiceArchivePromotionStep,
  LegacyInvoiceArchiveRecord,
  LegacyInvoiceArchiveRepository,
  LegacyInvoiceArchiveRevisionRecord,
  LegacyInvoiceArchiveRun,
  LegacyInvoiceArchiveRunChange,
  LegacyInvoiceImportOutcome,
  NewLegacyInvoiceArchiveRow,
  NewLegacyInvoiceArchiveRun,
  StagedLegacyInvoice,
} from '../application/ports.js';

type RunRow = typeof legacyInvoiceArchiveRuns.$inferSelect;
type ArchiveRow = typeof legacyInvoiceArchive.$inferSelect;

/** Rows per INSERT statement: 32 columns × 1000 stays well under PostgreSQL's 65 535 binds. */
const INSERT_CHUNK = 1000;

function toRun(row: RunRow): LegacyInvoiceArchiveRun {
  return {
    id: row.id,
    tenantId: row.tenantId,
    state: row.state as LegacyInvoiceArchiveRunState,
    failureCode: row.failureCode as LegacyInvoiceArchiveRunFailure | null,
    readSetVersion: row.readSetVersion,
    readSetFingerprint: row.readSetFingerprint,
    sourceFingerprint: row.sourceFingerprint,
    sourceSchemaHash: row.sourceSchemaHash,
    sourceEngine: row.sourceEngine,
    synthetic: row.synthetic,
    sourceInvoiceRows: row.sourceInvoiceRows,
    sourceUserRows: row.sourceUserRows,
    sourceProductRows: row.sourceProductRows,
    promotedThrough: row.promotedThrough,
    promotedRows: row.promotedRows,
    insertedNew: row.insertedNew,
    insertedRevision: row.insertedRevision,
    unchanged: row.unchanged,
    missingInSnapshot: row.missingInSnapshot,
    archiveInvoicesAfter: row.archiveInvoicesAfter,
    codeVersion: row.codeVersion,
    startedAt: row.startedAt,
    verifiedAt: row.verifiedAt,
    finishedAt: row.finishedAt,
    updatedAt: row.updatedAt,
  };
}

function toRecord(row: ArchiveRow): LegacyInvoiceArchiveRecord {
  return {
    id: row.id,
    runId: row.runId,
    invoiceKey: row.invoiceKey,
    revision: row.revision,
    revisionReason: row.revisionReason as LegacyInvoiceRevisionReason,
    keyShapeEvidenced: row.keyShapeEvidenced,
    rawRow: row.rawRow as LegacyInvoiceRawRow,
    rowChecksum: row.rowChecksum,
    archiveChecksum: row.archiveChecksum,
    classification: row.classification as LegacyInvoiceArchiveClass,
    live: row.live,
    status: row.status,
    isTest: row.isTest,
    legacyUserId: row.legacyUserId,
    ownerPresent: row.ownerPresent,
    username: row.username,
    panelCode: row.panelCode,
    productCode: row.productCode,
    productRef: row.productRef as LegacyInvoiceProductRef,
    productName: row.productName,
    priceRaw: row.priceRaw,
    priceMinor: row.priceMinor,
    priceCurrency: row.priceCurrency,
    priceNote: row.priceNote as LegacyInvoiceParseNote | null,
    soldAtRaw: row.soldAtRaw,
    soldAt: row.soldAt,
    soldAtNote: row.soldAtNote as LegacyInvoiceParseNote | null,
    readSetFingerprint: row.readSetFingerprint,
    sourceFingerprint: row.sourceFingerprint,
    normalizationVersion: row.normalizationVersion,
    archivedAt: row.archivedAt,
  };
}

/** `%`, `_` and `\` typed into a search are literal characters, not patterns. */
function prefixPattern(text: string): string {
  return `${text.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;
}

/** The revision's run is COMPLETED: only then is a revision visible to a reader. */
const VISIBLE: SQL = sql`EXISTS (SELECT 1 FROM legacy_invoice_archive_runs vr
  WHERE vr.tenant_id = ${legacyInvoiceArchive.tenantId} AND vr.id = ${legacyInvoiceArchive.runId}
    AND vr.state = 'COMPLETED')`;

/** No VISIBLE revision of the same invoice is newer: this is the latest a reader sees. */
const LATEST_VISIBLE: SQL = sql`NOT EXISTS (SELECT 1 FROM legacy_invoice_archive nb
  JOIN legacy_invoice_archive_runs nr ON nr.tenant_id = nb.tenant_id AND nr.id = nb.run_id
    AND nr.state = 'COMPLETED'
  WHERE nb.tenant_id = ${legacyInvoiceArchive.tenantId}
    AND nb.invoice_key = ${legacyInvoiceArchive.invoiceKey}
    AND nb.revision > ${legacyInvoiceArchive.revision})`;

export class DrizzleLegacyInvoiceArchiveRepository implements LegacyInvoiceArchiveRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: TransactionScope): Executor {
    return tx?.tx ?? this.db;
  }

  // --- runs ----------------------------------------------------------------------------

  async openRun(
    scope: TenantContext,
    tx?: TransactionScope,
  ): Promise<LegacyInvoiceArchiveRun | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(legacyInvoiceArchiveRuns)
      .where(
        and(
          eq(legacyInvoiceArchiveRuns.tenantId, tenantId),
          inArray(legacyInvoiceArchiveRuns.state, ['STAGING', 'VERIFIED']),
        ),
      )
      .limit(1);
    return rows[0] === undefined ? null : toRun(rows[0]);
  }

  async findRun(
    scope: TenantContext,
    id: string,
    tx?: TransactionScope,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<LegacyInvoiceArchiveRun | null> {
    const tenantId = requireTenantId(scope);
    const query = this.exec(tx)
      .select()
      .from(legacyInvoiceArchiveRuns)
      .where(
        and(eq(legacyInvoiceArchiveRuns.tenantId, tenantId), eq(legacyInvoiceArchiveRuns.id, id)),
      )
      .limit(1);
    const rows = options.forUpdate === true ? await query.for('update') : await query;
    return rows[0] === undefined ? null : toRun(rows[0]);
  }

  async insertRun(
    scope: TenantContext,
    run: NewLegacyInvoiceArchiveRun,
    tx: TransactionScope,
  ): Promise<LegacyInvoiceArchiveRun | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(legacyInvoiceArchiveRuns)
      .values({
        id: run.id,
        tenantId,
        state: 'STAGING',
        readSetVersion: run.readSetVersion,
        readSetFingerprint: run.readSetFingerprint,
        sourceFingerprint: run.sourceFingerprint,
        sourceSchemaHash: run.sourceSchemaHash,
        sourceEngine: run.sourceEngine,
        synthetic: run.synthetic,
        codeVersion: run.codeVersion,
        startedAt: run.now,
        updatedAt: run.now,
      })
      // The one-open-run partial unique index: a second open run inserts nothing.
      .onConflictDoNothing()
      .returning();
    return rows[0] === undefined ? null : toRun(rows[0]);
  }

  async transitionRun(
    scope: TenantContext,
    id: string,
    from: readonly LegacyInvoiceArchiveRunState[],
    change: LegacyInvoiceArchiveRunChange,
    tx: TransactionScope,
  ): Promise<LegacyInvoiceArchiveRun | null> {
    const tenantId = requireTenantId(scope);
    const set: Partial<typeof legacyInvoiceArchiveRuns.$inferInsert> =
      change.state === 'VERIFIED'
        ? {
            state: 'VERIFIED',
            sourceInvoiceRows: change.sourceInvoiceRows,
            sourceUserRows: change.sourceUserRows,
            sourceProductRows: change.sourceProductRows,
            verifiedAt: change.now,
            updatedAt: change.now,
          }
        : change.state === 'COMPLETED'
          ? {
              state: 'COMPLETED',
              missingInSnapshot: change.missingInSnapshot,
              archiveInvoicesAfter: change.archiveInvoicesAfter,
              finishedAt: change.now,
              updatedAt: change.now,
            }
          : {
              state: 'FAILED',
              failureCode: change.failureCode,
              finishedAt: change.now,
              updatedAt: change.now,
            };
    const rows = await this.exec(tx)
      .update(legacyInvoiceArchiveRuns)
      .set(set)
      .where(
        and(
          eq(legacyInvoiceArchiveRuns.tenantId, tenantId),
          eq(legacyInvoiceArchiveRuns.id, id),
          inArray(legacyInvoiceArchiveRuns.state, [...from]),
        ),
      )
      .returning();
    return rows[0] === undefined ? null : toRun(rows[0]);
  }

  async advancePromotion(
    scope: TenantContext,
    id: string,
    step: LegacyInvoiceArchivePromotionStep,
    tx: TransactionScope,
  ): Promise<LegacyInvoiceArchiveRun | null> {
    const tenantId = requireTenantId(scope);
    const t = legacyInvoiceArchiveRuns;
    const rows = await this.exec(tx)
      .update(t)
      .set({
        promotedThrough: step.through,
        promotedRows: sql`${t.promotedRows} + ${step.promoted}`,
        insertedNew: sql`${t.insertedNew} + ${step.insertedNew}`,
        insertedRevision: sql`${t.insertedRevision} + ${step.insertedRevision}`,
        unchanged: sql`${t.unchanged} + ${step.unchanged}`,
        updatedAt: step.now,
      })
      .where(
        and(
          eq(t.tenantId, tenantId),
          eq(t.id, id),
          eq(t.state, 'VERIFIED'),
          step.expectedThrough === null
            ? sql`${t.promotedThrough} IS NULL`
            : eq(t.promotedThrough, step.expectedThrough),
        ),
      )
      .returning();
    return rows[0] === undefined ? null : toRun(rows[0]);
  }

  async listRuns(scope: TenantContext, limit: number): Promise<readonly LegacyInvoiceArchiveRun[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(legacyInvoiceArchiveRuns)
      .where(eq(legacyInvoiceArchiveRuns.tenantId, tenantId))
      .orderBy(desc(legacyInvoiceArchiveRuns.startedAt), desc(legacyInvoiceArchiveRuns.id))
      .limit(limit);
    return rows.map(toRun);
  }

  // --- staging -------------------------------------------------------------------------

  async stageInvoices(
    scope: TenantContext,
    runId: string,
    rows: readonly StagedLegacyInvoice[],
    tx: TransactionScope,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    let inserted = 0;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      const written = await this.exec(tx)
        .insert(legacyInvoiceArchiveStaging)
        .values(
          chunk.map((row) => ({
            runId,
            tenantId,
            sourceTable: 'invoice',
            sourceKey: row.invoiceKey,
            lookup: null,
            cells: row.cells,
            rowChecksum: row.rowChecksum,
          })),
        )
        .onConflictDoNothing()
        .returning({ key: legacyInvoiceArchiveStaging.sourceKey });
      inserted += written.length;
    }
    return inserted;
  }

  async stageKeys(
    scope: TenantContext,
    runId: string,
    table: 'user' | 'product',
    rows: readonly { readonly key: string; readonly lookup: string | null }[],
    tx: TransactionScope,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    let inserted = 0;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      const written = await this.exec(tx)
        .insert(legacyInvoiceArchiveStaging)
        .values(
          chunk.map((row) => ({
            runId,
            tenantId,
            sourceTable: table,
            sourceKey: row.key,
            lookup: row.lookup,
            cells: null,
            rowChecksum: null,
          })),
        )
        .onConflictDoNothing()
        .returning({ key: legacyInvoiceArchiveStaging.sourceKey });
      inserted += written.length;
    }
    return inserted;
  }

  async stagedCounts(
    scope: TenantContext,
    runId: string,
    tx: TransactionScope,
  ): Promise<{ readonly invoice: bigint; readonly user: bigint; readonly product: bigint }> {
    const tenantId = requireTenantId(scope);
    const s = legacyInvoiceArchiveStaging;
    const rows = await this.exec(tx)
      .select({ table: s.sourceTable, n: sql<string>`count(*)::text` })
      .from(s)
      .where(and(eq(s.tenantId, tenantId), eq(s.runId, runId)))
      .groupBy(s.sourceTable);
    const of = (table: string) => BigInt(rows.find((row) => row.table === table)?.n ?? '0');
    return { invoice: of('invoice'), user: of('user'), product: of('product') };
  }

  async stagedInvoicesAfter(
    scope: TenantContext,
    runId: string,
    after: string | null,
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly StagedLegacyInvoice[]> {
    const tenantId = requireTenantId(scope);
    const s = legacyInvoiceArchiveStaging;
    const rows = await this.exec(tx)
      .select({ key: s.sourceKey, cells: s.cells, rowChecksum: s.rowChecksum })
      .from(s)
      .where(
        and(
          eq(s.runId, runId),
          eq(s.sourceTable, 'invoice'),
          eq(s.tenantId, tenantId),
          ...(after === null ? [] : [gt(s.sourceKey, after)]),
        ),
      )
      // The primary key's order (run, table, key): the cursor compares in the same collation.
      .orderBy(asc(s.sourceKey))
      .limit(limit);
    return rows.map((row) => ({
      invoiceKey: row.key,
      cells: row.cells as LegacyInvoiceRawRow,
      rowChecksum: row.rowChecksum as string,
    }));
  }

  private async presentLookups(
    scope: TenantContext,
    runId: string,
    table: 'user' | 'product',
    values: readonly string[],
    tx: TransactionScope,
  ): Promise<ReadonlySet<string>> {
    const tenantId = requireTenantId(scope);
    if (values.length === 0) return new Set();
    const s = legacyInvoiceArchiveStaging;
    const rows = await this.exec(tx)
      .selectDistinct({ lookup: s.lookup })
      .from(s)
      .where(
        and(
          eq(s.runId, runId),
          eq(s.sourceTable, table),
          eq(s.tenantId, tenantId),
          inArray(s.lookup, [...values]),
        ),
      );
    return new Set(rows.flatMap((row) => (row.lookup === null ? [] : [row.lookup])));
  }

  presentUsers(
    scope: TenantContext,
    runId: string,
    ids: readonly string[],
    tx: TransactionScope,
  ): Promise<ReadonlySet<string>> {
    return this.presentLookups(scope, runId, 'user', ids, tx);
  }

  presentProductCodes(
    scope: TenantContext,
    runId: string,
    codes: readonly string[],
    tx: TransactionScope,
  ): Promise<ReadonlySet<string>> {
    return this.presentLookups(scope, runId, 'product', codes, tx);
  }

  async deleteStaging(scope: TenantContext, runId: string, tx: TransactionScope): Promise<number> {
    const tenantId = requireTenantId(scope);
    const s = legacyInvoiceArchiveStaging;
    const result = await this.exec(tx)
      .delete(s)
      .where(and(eq(s.tenantId, tenantId), eq(s.runId, runId)));
    return result.rowCount ?? 0;
  }

  // --- archive -------------------------------------------------------------------------

  async latestRevisions(
    scope: TenantContext,
    keys: readonly string[],
    tx: TransactionScope,
  ): Promise<ReadonlyMap<string, LatestRevision>> {
    const tenantId = requireTenantId(scope);
    if (keys.length === 0) return new Map();
    const a = legacyInvoiceArchive;
    const rows = await this.exec(tx)
      .selectDistinctOn([a.invoiceKey], {
        key: a.invoiceKey,
        revision: a.revision,
        rowChecksum: a.rowChecksum,
        archiveChecksum: a.archiveChecksum,
      })
      .from(a)
      .where(and(eq(a.tenantId, tenantId), inArray(a.invoiceKey, [...keys])))
      .orderBy(a.invoiceKey, desc(a.revision));
    return new Map(
      rows.map((row) => [
        row.key,
        {
          revision: row.revision,
          rowChecksum: row.rowChecksum,
          archiveChecksum: row.archiveChecksum,
        },
      ]),
    );
  }

  async insertRevisions(
    scope: TenantContext,
    rows: readonly NewLegacyInvoiceArchiveRow[],
    tx: TransactionScope,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      // A plain INSERT: a second writer of the same (tenant, key, revision) fails loudly on
      // `legacy_invoice_archive_revision_key`, never overwrites.
      await this.exec(tx)
        .insert(legacyInvoiceArchive)
        .values(
          chunk.map((row) => ({
            id: row.id,
            tenantId,
            runId: row.runId,
            invoiceKey: row.invoiceKey,
            revision: row.revision,
            revisionReason: row.revisionReason,
            keyShapeEvidenced: row.keyShapeEvidenced,
            rawRow: row.rawRow,
            rowChecksum: row.rowChecksum,
            archiveChecksum: row.archiveChecksum,
            classification: row.classification,
            live: row.live,
            status: row.status,
            isTest: row.isTest,
            legacyUserId: row.legacyUserId,
            ownerPresent: row.ownerPresent,
            username: row.username,
            panelCode: row.panelCode,
            productCode: row.productCode,
            productRef: row.productRef,
            productName: row.productName,
            priceRaw: row.priceRaw,
            priceMinor: row.priceMinor,
            priceCurrency: row.priceCurrency,
            priceNote: row.priceNote,
            soldAtRaw: row.soldAtRaw,
            soldAt:
              row.soldAtEpochSeconds === null ? null : new Date(row.soldAtEpochSeconds * 1000),
            soldAtNote: row.soldAtNote,
            readSetFingerprint: row.readSetFingerprint,
            sourceFingerprint: row.sourceFingerprint,
            normalizationVersion: row.normalizationVersion,
            archivedAt: row.archivedAt,
          })),
        );
    }
  }

  async countMissingFromRun(
    scope: TenantContext,
    runId: string,
    tx: TransactionScope,
  ): Promise<bigint> {
    const tenantId = requireTenantId(scope);
    const result = await this.exec(tx).execute<{ n: string }>(sql`
      SELECT count(DISTINCT a.invoice_key)::text AS n
        FROM legacy_invoice_archive a
       WHERE a.tenant_id = ${tenantId}
         AND NOT EXISTS (
               SELECT 1 FROM legacy_invoice_archive_staging s
                WHERE s.run_id = ${runId} AND s.source_table = 'invoice'
                  AND s.source_key = a.invoice_key)`);
    return BigInt(result.rows[0]?.n ?? '0');
  }

  async countArchivedInvoices(scope: TenantContext, tx: TransactionScope): Promise<bigint> {
    const tenantId = requireTenantId(scope);
    const result = await this.exec(tx).execute<{ n: string }>(sql`
      SELECT count(DISTINCT invoice_key)::text AS n
        FROM legacy_invoice_archive WHERE tenant_id = ${tenantId}`);
    return BigInt(result.rows[0]?.n ?? '0');
  }

  // --- reads ---------------------------------------------------------------------------

  async list(
    scope: TenantContext,
    filter: LegacyInvoiceArchiveFilter,
    after: string | null,
    limit: number,
  ): Promise<readonly LegacyInvoiceArchiveRecord[]> {
    return (await this.listStatement(scope, filter, after, limit)).map(toRecord);
  }

  /**
   * The list's statement, exposed so `legacy-invoice-archive-plan.test.ts` asks the planner
   * about the query production sends, not a retyped one. Every filter is an equality or a
   * prefix on a tenant-led index; the keyset is `invoice_key > cursor` in the same order.
   */
  listStatement(
    scope: TenantContext,
    filter: LegacyInvoiceArchiveFilter,
    after: string | null,
    limit: number,
  ) {
    const tenantId = requireTenantId(scope);
    const a = legacyInvoiceArchive;
    const conditions: SQL[] = [eq(a.tenantId, tenantId), VISIBLE, LATEST_VISIBLE];
    if (filter.invoiceIdPrefix !== undefined) {
      conditions.push(sql`${a.invoiceKey} LIKE ${prefixPattern(filter.invoiceIdPrefix)}`);
    }
    if (filter.legacyUserId !== undefined) conditions.push(eq(a.legacyUserId, filter.legacyUserId));
    if (filter.usernamePrefix !== undefined) {
      conditions.push(
        sql`lower(${a.username}) LIKE ${prefixPattern(filter.usernamePrefix.toLowerCase())}`,
      );
    }
    if (filter.status !== undefined) conditions.push(eq(a.status, filter.status));
    if (filter.panelCode !== undefined) conditions.push(eq(a.panelCode, filter.panelCode));
    if (filter.productCode !== undefined) conditions.push(eq(a.productCode, filter.productCode));
    if (filter.classification !== undefined) {
      conditions.push(eq(a.classification, filter.classification));
    }
    if (filter.isTest !== undefined) conditions.push(eq(a.isTest, filter.isTest));
    if (after !== null) conditions.push(gt(a.invoiceKey, after));
    return this.db
      .select()
      .from(a)
      .where(and(...conditions))
      .orderBy(asc(a.invoiceKey))
      .limit(limit);
  }

  async findVisible(scope: TenantContext, id: string): Promise<LegacyInvoiceArchiveRecord | null> {
    const tenantId = requireTenantId(scope);
    const a = legacyInvoiceArchive;
    const rows = await this.db
      .select()
      .from(a)
      .where(and(eq(a.tenantId, tenantId), eq(a.id, id), VISIBLE))
      .limit(1);
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async revisionsOf(
    scope: TenantContext,
    invoiceKey: string,
  ): Promise<readonly LegacyInvoiceArchiveRevisionRecord[]> {
    const tenantId = requireTenantId(scope);
    const a = legacyInvoiceArchive;
    const r = legacyInvoiceArchiveRuns;
    const rows = await this.db
      .select({
        id: a.id,
        revision: a.revision,
        revisionReason: a.revisionReason,
        classification: a.classification,
        rowChecksum: a.rowChecksum,
        sourceFingerprint: a.sourceFingerprint,
        readSetFingerprint: a.readSetFingerprint,
        runId: a.runId,
        archivedAt: a.archivedAt,
        state: r.state,
      })
      .from(a)
      .innerJoin(r, and(eq(r.tenantId, a.tenantId), eq(r.id, a.runId)))
      .where(and(eq(a.tenantId, tenantId), eq(a.invoiceKey, invoiceKey)))
      .orderBy(asc(a.revision));
    return rows.map((row) => ({
      id: row.id,
      revision: row.revision,
      revisionReason: row.revisionReason as LegacyInvoiceRevisionReason,
      classification: row.classification as LegacyInvoiceArchiveClass,
      rowChecksum: row.rowChecksum,
      sourceFingerprint: row.sourceFingerprint,
      readSetFingerprint: row.readSetFingerprint,
      runId: row.runId,
      archivedAt: row.archivedAt,
      visible: row.state === 'COMPLETED',
    }));
  }

  async importOutcome(
    scope: TenantContext,
    invoiceKey: string,
  ): Promise<LegacyInvoiceImportOutcome | null> {
    const tenantId = requireTenantId(scope);
    const m = legacyImportMap;
    const rows = await this.db
      .select({
        status: m.status,
        reasonCode: m.reasonCode,
        reviewState: m.reviewState,
        entityType: m.entityType,
      })
      .from(m)
      .where(
        and(eq(m.tenantId, tenantId), eq(m.legacyTable, 'invoice'), eq(m.legacyId, invoiceKey)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async summary(scope: TenantContext): Promise<{
    readonly invoices: number;
    readonly revisions: number;
    readonly classes: Readonly<Partial<Record<LegacyInvoiceArchiveClass, number>>>;
  }> {
    const tenantId = requireTenantId(scope);
    const a = legacyInvoiceArchive;
    const byClass = await this.db
      .select({ classification: a.classification, n: sql<number>`count(*)::int` })
      .from(a)
      .where(and(eq(a.tenantId, tenantId), VISIBLE, LATEST_VISIBLE))
      .groupBy(a.classification);
    const revisions = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(a)
      .where(and(eq(a.tenantId, tenantId), VISIBLE));
    const classes: Partial<Record<LegacyInvoiceArchiveClass, number>> = {};
    let invoices = 0;
    for (const row of byClass) {
      classes[row.classification as LegacyInvoiceArchiveClass] = row.n;
      invoices += row.n;
    }
    return { invoices, revisions: revisions[0]?.n ?? 0, classes };
  }
}
