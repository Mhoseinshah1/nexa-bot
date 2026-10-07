import { and, asc, desc, eq, gt, inArray, like, sql } from 'drizzle-orm';
import {
  legacyServiceEvidenceSchema,
  type LegacyServiceOutcome,
  type LegacyServiceReviewState,
  type TenantContext,
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
  legacyServiceCandidates,
} from '../../../../infrastructure/persistence/schema.js';
import { legacyInvoiceLockName } from '../../legacy-import/application/legacy-import-ports.js';
import type {
  LegacyServiceArchiveSummary,
  LegacyServiceCandidateFilter,
  LegacyServiceCandidateRecord,
  LegacyServiceCandidateRepository,
  LegacyServiceOutcomeWrite,
  LegacyServiceReviewChange,
} from '../application/ports.js';

type Row = typeof legacyServiceCandidates.$inferSelect;
const t = legacyServiceCandidates;

/** Lookups by key are chunked: a run decides every live invoice. */
const KEY_CHUNK = 1000;

function toRecord(row: Row): LegacyServiceCandidateRecord {
  return {
    id: row.id,
    invoiceKey: row.invoiceKey,
    runId: row.runId,
    sourceFingerprint: row.sourceFingerprint,
    synthetic: row.synthetic,
    invoiceChecksum: row.invoiceChecksum,
    outcome: row.outcome as LegacyServiceOutcome,
    blocker: row.blocker,
    // Parsed, never cast: a row that does not hold the evidence shape is a broken invariant.
    evidence: legacyServiceEvidenceSchema.parse(row.evidence),
    evidenceHash: row.evidenceHash,
    panelCode: row.panelCode,
    productCode: row.productCode,
    archiveId: row.archiveId,
    serviceId: row.serviceId,
    reviewState: row.reviewState as LegacyServiceReviewState,
    approvedPanelId: row.approvedPanelId,
    approvedChecksum: row.approvedChecksum,
    approvedOutcome: row.approvedOutcome as LegacyServiceOutcome | null,
    lastApprovalRefusal: row.lastApprovalRefusal,
    decisionReason: row.decisionReason,
    decidedByAdminId: row.decidedByAdminId,
    decidedAt: row.decidedAt,
    observedAt: row.observedAt,
    version: row.version,
    firstDecidedAt: row.firstDecidedAt,
    updatedAt: row.updatedAt,
  };
}

/** `LIKE` with the pattern's own metacharacters escaped: a prefix, verbatim. */
function prefixPattern(prefix: string): string {
  return `${prefix.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;
}

/**
 * Mirza migration PR5 — `legacy_service_candidates`. Every statement is tenant-scoped. The
 * importer inserts and re-decides; the review moves only by a conditional UPDATE naming its
 * from-states and the version. There is no DELETE (0230 refuses one).
 */
export class DrizzleLegacyServiceCandidateRepository implements LegacyServiceCandidateRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: TransactionScope): Executor {
    return tx?.tx ?? this.db;
  }

  async findById(
    scope: TenantContext,
    id: string,
    tx?: TransactionScope,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<LegacyServiceCandidateRecord | null> {
    const tenantId = requireTenantId(scope);
    const query = this.exec(tx)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.id, id)))
      .limit(1);
    const rows = options.forUpdate === true ? await query.for('update') : await query;
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async findByInvoiceKeys(
    scope: TenantContext,
    keys: readonly string[],
    tx?: TransactionScope,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<readonly LegacyServiceCandidateRecord[]> {
    const tenantId = requireTenantId(scope);
    const out: LegacyServiceCandidateRecord[] = [];
    const unique = [...new Set(keys)];
    for (let i = 0; i < unique.length; i += KEY_CHUNK) {
      const chunk = unique.slice(i, i + KEY_CHUNK);
      const query = this.exec(tx)
        .select()
        .from(t)
        .where(and(eq(t.tenantId, tenantId), inArray(t.invoiceKey, chunk)))
        // Row locks in one order, so two writers of one batch never deadlock.
        .orderBy(asc(t.id));
      const rows = options.forUpdate === true ? await query.for('update') : await query;
      out.push(...rows.map(toRecord));
    }
    return out;
  }

  async listApprovals(scope: TenantContext): Promise<readonly LegacyServiceCandidateRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), inArray(t.reviewState, ['ADOPT_APPROVED', 'ADOPTING'])))
      .orderBy(asc(t.id));
    return rows.map(toRecord);
  }

  async latestArchiveIds(
    scope: TenantContext,
    keys: readonly string[],
    tx: TransactionScope,
  ): Promise<ReadonlyMap<string, string>> {
    const tenantId = requireTenantId(scope);
    const a = legacyInvoiceArchive;
    const r = legacyInvoiceArchiveRuns;
    const out = new Map<string, string>();
    const unique = [...new Set(keys)];
    for (let i = 0; i < unique.length; i += KEY_CHUNK) {
      const chunk = unique.slice(i, i + KEY_CHUNK);
      const rows = await this.exec(tx)
        .selectDistinctOn([a.invoiceKey], { invoiceKey: a.invoiceKey, id: a.id })
        .from(a)
        .innerJoin(r, and(eq(r.tenantId, a.tenantId), eq(r.id, a.runId)))
        .where(
          and(eq(a.tenantId, tenantId), inArray(a.invoiceKey, chunk), eq(r.state, 'COMPLETED')),
        )
        .orderBy(a.invoiceKey, desc(a.revision));
      for (const row of rows) out.set(row.invoiceKey, row.id);
    }
    return out;
  }

  async insert(
    scope: TenantContext,
    row: LegacyServiceOutcomeWrite & {
      readonly archiveId: string | null;
      readonly reviewState: LegacyServiceReviewState;
    },
    tx: TransactionScope,
  ): Promise<LegacyServiceCandidateRecord> {
    const tenantId = requireTenantId(scope);
    const inserted = await this.exec(tx)
      .insert(t)
      .values({
        id: row.id,
        tenantId,
        invoiceKey: row.invoiceKey,
        runId: row.runId,
        sourceFingerprint: row.sourceFingerprint,
        synthetic: row.synthetic,
        invoiceChecksum: row.invoiceChecksum,
        outcome: row.outcome,
        blocker: row.blocker,
        evidence: row.evidence,
        evidenceHash: row.evidenceHash,
        panelCode: row.panelCode,
        productCode: row.productCode,
        archiveId: row.archiveId,
        serviceId: row.serviceId,
        reviewState: row.reviewState,
        observedAt: row.observedAt,
        version: 1,
        firstDecidedAt: row.now,
        updatedAt: row.now,
      })
      .returning();
    if (inserted[0] === undefined)
      throw new Error('legacy service candidate insert returned nothing');
    return toRecord(inserted[0]);
  }

  async updateOutcome(
    scope: TenantContext,
    id: string,
    version: number,
    change: Parameters<LegacyServiceCandidateRepository['updateOutcome']>[3],
    tx: TransactionScope,
  ): Promise<LegacyServiceCandidateRecord | null> {
    const tenantId = requireTenantId(scope);
    const updated = await this.exec(tx)
      .update(t)
      .set({
        runId: change.runId,
        sourceFingerprint: change.sourceFingerprint,
        invoiceChecksum: change.invoiceChecksum,
        outcome: change.outcome,
        blocker: change.blocker,
        evidence: change.evidence,
        evidenceHash: change.evidenceHash,
        panelCode: change.panelCode,
        productCode: change.productCode,
        archiveId: change.archiveId,
        serviceId: change.serviceId,
        reviewState: change.reviewState,
        observedAt: change.observedAt,
        version: change.bump ? sql`${t.version} + 1` : t.version,
        updatedAt: change.updatedAt,
      })
      .where(and(eq(t.tenantId, tenantId), eq(t.id, id), eq(t.version, version)))
      .returning();
    return updated[0] === undefined ? null : toRecord(updated[0]);
  }

  async transition(
    scope: TenantContext,
    id: string,
    guard: { readonly from: readonly LegacyServiceReviewState[]; readonly version: number },
    change: LegacyServiceReviewChange,
    tx: TransactionScope,
  ): Promise<LegacyServiceCandidateRecord | null> {
    const tenantId = requireTenantId(scope);
    const set: Record<string, unknown> = {
      reviewState: change.reviewState,
      updatedAt: change.updatedAt,
      version: sql`${t.version} + 1`,
    };
    if (change.approvedPanelId !== undefined) set.approvedPanelId = change.approvedPanelId;
    if (change.approvedChecksum !== undefined) set.approvedChecksum = change.approvedChecksum;
    if (change.approvedOutcome !== undefined) set.approvedOutcome = change.approvedOutcome;
    if (change.lastApprovalRefusal !== undefined) {
      set.lastApprovalRefusal = change.lastApprovalRefusal;
    }
    if (change.decisionReason !== undefined) set.decisionReason = change.decisionReason;
    if (change.decidedByAdminId !== undefined) set.decidedByAdminId = change.decidedByAdminId;
    if (change.decidedAt !== undefined) set.decidedAt = change.decidedAt;
    if (change.outcome !== undefined) set.outcome = change.outcome;
    if (change.blocker !== undefined) set.blocker = change.blocker;
    if (change.serviceId !== undefined) set.serviceId = change.serviceId;
    const updated = await this.exec(tx)
      .update(t)
      .set(set as Partial<typeof t.$inferInsert>)
      .where(
        and(
          eq(t.tenantId, tenantId),
          eq(t.id, id),
          inArray(t.reviewState, [...guard.from]),
          eq(t.version, guard.version),
        ),
      )
      .returning();
    return updated[0] === undefined ? null : toRecord(updated[0]);
  }

  async list(
    scope: TenantContext,
    filter: LegacyServiceCandidateFilter,
  ): Promise<readonly LegacyServiceCandidateRecord[]> {
    const tenantId = requireTenantId(scope);
    const where = [eq(t.tenantId, tenantId)];
    if (filter.outcome !== undefined) where.push(eq(t.outcome, filter.outcome));
    if (filter.reviewState !== undefined) where.push(eq(t.reviewState, filter.reviewState));
    if (filter.panelCode !== undefined) where.push(eq(t.panelCode, filter.panelCode));
    if (filter.productCode !== undefined) where.push(eq(t.productCode, filter.productCode));
    if (filter.invoiceIdPrefix !== undefined) {
      where.push(like(t.invoiceKey, prefixPattern(filter.invoiceIdPrefix)));
    }
    if (filter.after !== undefined) where.push(gt(t.id, filter.after));
    const rows = await this.db
      .select()
      .from(t)
      .where(and(...where))
      .orderBy(asc(t.id))
      .limit(filter.limit);
    return rows.map(toRecord);
  }

  async aggregate(scope: TenantContext): Promise<{
    readonly byOutcome: Readonly<Partial<Record<LegacyServiceOutcome, number>>>;
    readonly byReviewState: Readonly<Partial<Record<LegacyServiceReviewState, number>>>;
  }> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select({ outcome: t.outcome, reviewState: t.reviewState, n: sql<number>`count(*)::int` })
      .from(t)
      .where(eq(t.tenantId, tenantId))
      .groupBy(t.outcome, t.reviewState);
    const byOutcome: Partial<Record<LegacyServiceOutcome, number>> = {};
    const byReviewState: Partial<Record<LegacyServiceReviewState, number>> = {};
    for (const row of rows) {
      const o = row.outcome as LegacyServiceOutcome;
      const s = row.reviewState as LegacyServiceReviewState;
      byOutcome[o] = (byOutcome[o] ?? 0) + row.n;
      byReviewState[s] = (byReviewState[s] ?? 0) + row.n;
    }
    return { byOutcome, byReviewState };
  }

  async archiveSummary(
    scope: TenantContext,
    archiveId: string,
  ): Promise<LegacyServiceArchiveSummary | null> {
    const tenantId = requireTenantId(scope);
    const a = legacyInvoiceArchive;
    const rows = await this.db
      .select({
        id: a.id,
        revision: a.revision,
        classification: a.classification,
        status: a.status,
        panelCode: a.panelCode,
        productCode: a.productCode,
        productName: a.productName,
        priceRaw: a.priceRaw,
        priceMinor: a.priceMinor,
        soldAt: a.soldAt,
        sourceFingerprint: a.sourceFingerprint,
      })
      .from(a)
      .where(and(eq(a.tenantId, tenantId), eq(a.id, archiveId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async lockInvoice(scope: TenantContext, invoiceKey: string, tx: TransactionScope): Promise<void> {
    const tenantId = requireTenantId(scope);
    await tx.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${legacyInvoiceLockName(tenantId, invoiceKey)}, 0))`,
    );
  }

  async importOutcome(
    scope: TenantContext,
    invoiceKey: string,
    tx?: TransactionScope,
  ): Promise<{
    readonly status: string;
    readonly reasonCode: string | null;
    readonly reviewState: string | null;
  } | null> {
    const tenantId = requireTenantId(scope);
    const m = legacyImportMap;
    const rows = await this.exec(tx)
      .select({ status: m.status, reasonCode: m.reasonCode, reviewState: m.reviewState })
      .from(m)
      .where(
        and(eq(m.tenantId, tenantId), eq(m.legacyTable, 'invoice'), eq(m.legacyId, invoiceKey)),
      )
      .limit(1);
    return rows[0] ?? null;
  }
}
