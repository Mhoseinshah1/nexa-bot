import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type {
  LegacyCutoverApprovalKind,
  LegacyProductReviewState,
  LegacyReadSetName,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  legacyCutoverApprovalRevocations,
  legacyCutoverApprovals,
  legacyImportRuns,
  legacyReadSetRuns,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  LegacyCutoverApplyOutcome,
  LegacyCutoverApplyRunRecord,
  LegacyCutoverApprovalRecord,
  LegacyCutoverArchiveFacts,
  LegacyCutoverDuplicateFacts,
  LegacyCutoverProductRow,
  LegacyCutoverReadSetRecord,
  LegacyCutoverRepository,
  LegacyCutoverStopSalesFacts,
  NewLegacyCutoverApproval,
} from '../application/ports.js';

const a = legacyCutoverApprovals;
const r = legacyCutoverApprovalRevocations;

type ApprovalRow = typeof a.$inferSelect;
type RevocationRow = typeof r.$inferSelect;

function toApproval(
  row: ApprovalRow,
  revocation: RevocationRow | null,
): LegacyCutoverApprovalRecord {
  return {
    id: row.id,
    kind: row.kind as LegacyCutoverApprovalKind,
    sourceFingerprint: row.sourceFingerprint,
    panelMapFingerprint: row.panelMapFingerprint,
    inventoryFingerprint: row.inventoryFingerprint,
    productsFingerprint: row.productsFingerprint,
    invoiceArchiveFingerprint: row.invoiceArchiveFingerprint,
    freezeProofSha256: row.freezeProofSha256,
    finalDumpSha256: row.finalDumpSha256,
    priorSourceFingerprint: row.priorSourceFingerprint,
    synthetic: row.synthetic,
    reason: row.reason,
    approvedByAdminId: row.approvedByAdminId,
    approvedAt: row.approvedAt,
    revocation:
      revocation === null
        ? null
        : {
            revokedByAdminId: revocation.revokedByAdminId,
            revokedAt: revocation.revokedAt,
            reason: revocation.reason,
          },
  };
}

function toReadSet(row: typeof legacyReadSetRuns.$inferSelect): LegacyCutoverReadSetRecord {
  return {
    id: row.id,
    readSet: row.readSet as LegacyReadSetName,
    fingerprintVersion: row.fingerprintVersion,
    readSetFingerprint: row.readSetFingerprint,
    sourceFingerprint: row.sourceFingerprint,
    synthetic: row.synthetic,
    tableCount: row.tableCount,
    rowCount: row.rowCount,
    recordedAt: row.recordedAt,
  };
}

function toRun(row: typeof legacyImportRuns.$inferSelect): LegacyCutoverApplyRunRecord {
  return {
    id: row.id,
    status: row.status,
    sourceFingerprint: row.sourceFingerprint,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

const big = (value: string | number | null | undefined): bigint => BigInt(value ?? 0);
const num = (value: string | number | null | undefined): number => Number(value ?? 0);

/**
 * Mirza migration PR6 — the cutover approvals (append-only, `0233`) and the read-only facts
 * the cutover gate and the final report v2 read. Every statement is tenant-scoped; there is
 * no UPDATE and no DELETE here.
 */
export class DrizzleLegacyCutoverRepository implements LegacyCutoverRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: TransactionScope): Executor {
    return tx?.tx ?? this.db;
  }

  async insertApproval(
    scope: TenantContext,
    approval: NewLegacyCutoverApproval,
    tx: TransactionScope,
  ): Promise<LegacyCutoverApprovalRecord> {
    const tenantId = requireTenantId(scope);
    const [row] = await tx.tx
      .insert(a)
      .values({ ...approval, tenantId })
      .returning();
    if (row === undefined) throw new Error('the cutover approval was not written');
    return toApproval(row, null);
  }

  async insertRevocation(
    scope: TenantContext,
    revocation: {
      readonly id: string;
      readonly approvalId: string;
      readonly reason: string;
      readonly revokedByAdminId: string;
      readonly revokedAt: Date;
    },
    tx: TransactionScope,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await tx.tx.insert(r).values({ ...revocation, tenantId });
  }

  async findApproval(
    scope: TenantContext,
    id: string,
    tx?: TransactionScope,
  ): Promise<LegacyCutoverApprovalRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ approval: a, revocation: r })
      .from(a)
      .leftJoin(r, and(eq(r.tenantId, a.tenantId), eq(r.approvalId, a.id)))
      .where(and(eq(a.tenantId, tenantId), eq(a.id, id)));
    const row = rows[0];
    return row === undefined ? null : toApproval(row.approval, row.revocation);
  }

  async approvalsForSource(
    scope: TenantContext,
    sourceFingerprint: string,
    tx?: TransactionScope,
  ): Promise<readonly LegacyCutoverApprovalRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ approval: a, revocation: r })
      .from(a)
      .leftJoin(r, and(eq(r.tenantId, a.tenantId), eq(r.approvalId, a.id)))
      .where(and(eq(a.tenantId, tenantId), eq(a.sourceFingerprint, sourceFingerprint)))
      .orderBy(asc(a.id));
    return rows.map((row) => toApproval(row.approval, row.revocation));
  }

  async listApprovals(
    scope: TenantContext,
    page: { readonly after?: string; readonly limit: number },
  ): Promise<readonly LegacyCutoverApprovalRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select({ approval: a, revocation: r })
      .from(a)
      .leftJoin(r, and(eq(r.tenantId, a.tenantId), eq(r.approvalId, a.id)))
      .where(
        and(eq(a.tenantId, tenantId), page.after === undefined ? undefined : gt(a.id, page.after)),
      )
      .orderBy(asc(a.id))
      .limit(page.limit);
    return rows.map((row) => toApproval(row.approval, row.revocation));
  }

  async lockTenantApprovals(scope: TenantContext, tx: TransactionScope): Promise<void> {
    const tenantId = requireTenantId(scope);
    await tx.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`legacy-cutover-approvals:${tenantId}`}, 0))`,
    );
  }

  async findReadSetRun(
    scope: TenantContext,
    readSet: LegacyReadSetName,
    readSetFingerprint: string,
    sourceFingerprint: string,
    tx?: TransactionScope,
  ): Promise<LegacyCutoverReadSetRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(legacyReadSetRuns)
      .where(
        and(
          eq(legacyReadSetRuns.tenantId, tenantId),
          eq(legacyReadSetRuns.readSet, readSet),
          eq(legacyReadSetRuns.readSetFingerprint, readSetFingerprint),
          eq(legacyReadSetRuns.sourceFingerprint, sourceFingerprint),
        ),
      )
      .orderBy(asc(legacyReadSetRuns.id))
      .limit(1);
    return rows[0] === undefined ? null : toReadSet(rows[0]);
  }

  async latestReadSetRun(
    scope: TenantContext,
    readSet: LegacyReadSetName,
    sourceFingerprint: string,
  ): Promise<LegacyCutoverReadSetRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(legacyReadSetRuns)
      .where(
        and(
          eq(legacyReadSetRuns.tenantId, tenantId),
          eq(legacyReadSetRuns.readSet, readSet),
          eq(legacyReadSetRuns.sourceFingerprint, sourceFingerprint),
        ),
      )
      .orderBy(sql`${legacyReadSetRuns.recordedAt} DESC, ${legacyReadSetRuns.id} DESC`)
      .limit(1);
    return rows[0] === undefined ? null : toReadSet(rows[0]);
  }

  async listReadSetRuns(
    scope: TenantContext,
    page: { readonly after?: string; readonly limit: number },
  ): Promise<readonly LegacyCutoverReadSetRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(legacyReadSetRuns)
      .where(
        and(
          eq(legacyReadSetRuns.tenantId, tenantId),
          page.after === undefined ? undefined : gt(legacyReadSetRuns.id, page.after),
        ),
      )
      .orderBy(asc(legacyReadSetRuns.id))
      .limit(page.limit);
    return rows.map(toReadSet);
  }

  async applyRuns(
    scope: TenantContext,
    tx?: TransactionScope,
  ): Promise<readonly LegacyCutoverApplyRunRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(legacyImportRuns)
      .where(and(eq(legacyImportRuns.tenantId, tenantId), eq(legacyImportRuns.mode, 'APPLY')))
      .orderBy(asc(legacyImportRuns.startedAt), asc(legacyImportRuns.id));
    return rows.map(toRun);
  }

  async listApplyRuns(
    scope: TenantContext,
    page: { readonly after?: string; readonly limit: number },
  ): Promise<readonly LegacyCutoverApplyRunRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(legacyImportRuns)
      .where(
        and(
          eq(legacyImportRuns.tenantId, tenantId),
          eq(legacyImportRuns.mode, 'APPLY'),
          page.after === undefined ? undefined : gt(legacyImportRuns.id, page.after),
        ),
      )
      .orderBy(asc(legacyImportRuns.id))
      .limit(page.limit);
    return rows.map(toRun);
  }

  async productReviewRows(scope: TenantContext): Promise<readonly LegacyCutoverProductRow[]> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute<{
      code_product: string;
      state: string;
      read_fingerprint: string;
      source_fingerprint: string;
      missing_since_read_fingerprint: string | null;
      source_conflict: string | null;
      approved_product_id: string | null;
      approved_facts_checksum: string | null;
      facts_checksum: string;
    }>(sql`
      SELECT code_product, state, read_fingerprint, source_fingerprint,
             missing_since_read_fingerprint, source_conflict, approved_product_id,
             approved_facts_checksum, facts_checksum
        FROM legacy_product_reviews
       WHERE tenant_id = ${tenantId}
       ORDER BY code_product COLLATE "C"
    `);
    return result.rows.map((row) => ({
      codeProduct: row.code_product,
      state: row.state as LegacyProductReviewState,
      readFingerprint: row.read_fingerprint,
      sourceFingerprint: row.source_fingerprint,
      missingSinceReadFingerprint: row.missing_since_read_fingerprint,
      sourceConflict: row.source_conflict,
      approvedProductId: row.approved_product_id,
      approvedFactsChecksum: row.approved_facts_checksum,
      factsChecksum: row.facts_checksum,
    }));
  }

  async latestCompletedArchiveRun(
    scope: TenantContext,
    sourceFingerprint: string,
  ): Promise<LegacyCutoverArchiveFacts | null> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute<{
      id: string;
      read_set_fingerprint: string;
      synthetic: boolean;
      source_invoice_rows: string | null;
      promoted_rows: string;
      inserted_new: string;
      inserted_revision: string;
      unchanged: string;
      missing_in_snapshot: string | null;
      archive_invoices_after: string | null;
      archived_now: string;
    }>(sql`
      SELECT r.id, r.read_set_fingerprint, r.synthetic, r.source_invoice_rows::text,
             r.promoted_rows::text, r.inserted_new::text, r.inserted_revision::text,
             r.unchanged::text, r.missing_in_snapshot::text, r.archive_invoices_after::text,
             (SELECT count(DISTINCT x.invoice_key)
                FROM legacy_invoice_archive x
                JOIN legacy_invoice_archive_runs xr
                  ON xr.tenant_id = x.tenant_id AND xr.id = x.run_id AND xr.state = 'COMPLETED'
               WHERE x.tenant_id = r.tenant_id)::text AS archived_now
        FROM legacy_invoice_archive_runs r
       WHERE r.tenant_id = ${tenantId} AND r.source_fingerprint = ${sourceFingerprint}
         AND r.state = 'COMPLETED'
       ORDER BY r.finished_at DESC, r.id DESC
       LIMIT 1
    `);
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      runId: row.id,
      readSetFingerprint: row.read_set_fingerprint,
      synthetic: row.synthetic,
      sourceInvoiceRows: big(row.source_invoice_rows),
      promotedRows: big(row.promoted_rows),
      insertedNew: big(row.inserted_new),
      insertedRevision: big(row.inserted_revision),
      unchanged: big(row.unchanged),
      missingInSnapshot: big(row.missing_in_snapshot),
      archiveInvoicesAfter: big(row.archive_invoices_after),
      archivedInvoicesNow: big(row.archived_now),
    };
  }

  async duplicateFacts(scope: TenantContext): Promise<LegacyCutoverDuplicateFacts> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute<{
      debts: string | null;
      customers: string | null;
      invoices_per_service: string | null;
      adoption_orders: string;
      mapped_services: string;
      repeated_revisions: string;
    }>(sql`
      SELECT
        (SELECT max(n) FROM (SELECT count(*) AS n FROM legacy_wallet_debts
                              WHERE tenant_id = ${tenantId} GROUP BY customer_id) d)::text AS debts,
        (SELECT max(n) FROM (SELECT count(*) AS n FROM customers
                              WHERE tenant_id = ${tenantId} GROUP BY telegram_user_id) c)::text AS customers,
        (SELECT max(n) FROM (SELECT count(*) AS n FROM legacy_import_map
                              WHERE tenant_id = ${tenantId} AND legacy_table = 'invoice'
                                AND status = 'IMPORTED' AND entity_type = 'SERVICE'
                              GROUP BY entity_id) m)::text AS invoices_per_service,
        (SELECT count(*) FROM orders
          WHERE tenant_id = ${tenantId} AND origin = 'LEGACY_ADOPTION')::text AS adoption_orders,
        (SELECT count(DISTINCT entity_id) FROM legacy_import_map
          WHERE tenant_id = ${tenantId} AND legacy_table = 'invoice'
            AND status = 'IMPORTED' AND entity_type = 'SERVICE')::text AS mapped_services,
        (SELECT count(*) FROM (
            SELECT archive_checksum,
                   lag(archive_checksum) OVER (PARTITION BY invoice_key ORDER BY revision) AS before
              FROM legacy_invoice_archive WHERE tenant_id = ${tenantId}) v
          WHERE v.before = v.archive_checksum)::text AS repeated_revisions
    `);
    const row = result.rows[0];
    return {
      debtsPerCustomerMax: num(row?.debts),
      customersPerTelegramIdMax: num(row?.customers),
      invoicesPerAdoptedServiceMax: num(row?.invoices_per_service),
      adoptionOrders: num(row?.adoption_orders),
      mappedAdoptedServices: num(row?.mapped_services),
      archiveRepeatedRevisions: num(row?.repeated_revisions),
    };
  }

  async stopSalesFacts(scope: TenantContext): Promise<LegacyCutoverStopSalesFacts> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute<{
      incidents: string;
      panels: string;
      panels_open: string;
      gateways: string;
      gateways_active: string;
    }>(sql`
      SELECT
        (SELECT count(*) FROM incidents WHERE tenant_id = ${tenantId} AND kind = 'MAINTENANCE'
            AND status = 'ACTIVE' AND stop_sales)::text AS incidents,
        (SELECT count(*) FROM panels WHERE tenant_id = ${tenantId} AND status = 'ACTIVE')::text AS panels,
        (SELECT count(*) FROM panels WHERE tenant_id = ${tenantId} AND status = 'ACTIVE'
            AND drained_at IS NULL)::text AS panels_open,
        (SELECT count(*) FROM payment_gateways WHERE tenant_id = ${tenantId})::text AS gateways,
        (SELECT count(*) FROM payment_gateways WHERE tenant_id = ${tenantId}
            AND status = 'ACTIVE')::text AS gateways_active
    `);
    const row = result.rows[0];
    return {
      activeStopSalesIncidents: num(row?.incidents),
      activePanels: num(row?.panels),
      activePanelsNotDrained: num(row?.panels_open),
      gateways: num(row?.gateways),
      gatewaysActive: num(row?.gateways_active),
    };
  }

  async applyOutcome(
    scope: TenantContext,
    runId: string,
  ): Promise<LegacyCutoverApplyOutcome | null> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute<{ outcome: unknown }>(sql`
      SELECT after -> 'applyOutcome' AS outcome FROM audit_logs
       WHERE tenant_id = ${tenantId} AND action = 'legacy_import.run.finish'
         AND entity_id = ${runId} AND result = 'SUCCESS'
       ORDER BY occurred_at DESC, id DESC
       LIMIT 1
    `);
    return countsOf(result.rows[0]?.outcome);
  }

  async runCutoverApprovalId(scope: TenantContext, runId: string): Promise<string | null> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute<{ approval_id: unknown }>(sql`
      SELECT after -> 'cutover' ->> 'cutoverApprovalId' AS approval_id FROM audit_logs
       WHERE tenant_id = ${tenantId} AND action = 'legacy_import.run.start'
         AND entity_id = ${runId} AND result = 'SUCCESS'
       ORDER BY occurred_at DESC, id DESC
       LIMIT 1
    `);
    const value = result.rows[0]?.approval_id;
    return typeof value === 'string' && APPROVAL_ID.test(value) ? value : null;
  }
}

/** A recorded approval id: a lowercase uuid, or nothing. */
const APPROVAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The recorded counts, parsed: two objects of non-negative integers, or nothing at all. */
function countsOf(value: unknown): LegacyCutoverApplyOutcome | null {
  const record = (v: unknown): Record<string, number> | null => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(k) || !Number.isInteger(n) || (n as number) < 0) {
        return null;
      }
      out[k] = n as number;
    }
    return out;
  };
  if (value === null || typeof value !== 'object') return null;
  const { serviceApprovals, attention } = value as Record<string, unknown>;
  const a = record(serviceApprovals);
  const b = record(attention);
  return a === null || b === null ? null : { serviceApprovals: a, attention: b };
}
