import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { LegacyHistoryRecordType, TenantContext } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  legacyHistoryRecords as h,
  legacyServiceCandidates,
  services,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  LegacyHistoryRecordRow,
  LegacyInactivePanelRow,
  LegacyRecordsRepository,
} from '../application/ports.js';

/**
 * Tenant-wide reads of `legacy_history_records` (SELECT only; the table is append-only).
 *
 * The invoice-keyed lookup spells its two predicates exactly as the suggested partial
 * expression indexes do (`payload->'invoice_relation'->>'invoice_key'` for operations and
 * cancellation requests, `payload->>'invoice_key'` for ownership), so the planner can use
 * them; without the indexes it is a scan of the tenant's records.
 */
export class DrizzleLegacyRecordsRepository implements LegacyRecordsRepository {
  constructor(private readonly db: Database) {}

  async countsByType(
    scope: TenantContext,
  ): Promise<readonly { type: string; records: number; unlinked: number }[]> {
    const rows = await this.db
      .select({
        type: h.recordType,
        records: count(),
        unlinked: sql<number>`count(*) filter (where ${h.customerId} is null)`,
      })
      .from(h)
      .where(eq(h.tenantId, requireTenantId(scope)))
      .groupBy(h.recordType);
    return rows.map((row) => ({
      type: row.type,
      records: Number(row.records),
      unlinked: Number(row.unlinked),
    }));
  }

  async inactivePanels(scope: TenantContext): Promise<readonly LegacyInactivePanelRow[]> {
    const status = sql<string | null>`${h.payload}->'status'->>'normalized'`;
    const rows = await this.db
      .select({
        code: sql<string | null>`${h.payload}->>'code_panel'`,
        name: sql<string | null>`${h.payload}->>'name_panel'`,
        panelType: sql<string | null>`${h.payload}->'panel_type'->>'normalized'`,
        status,
      })
      .from(h)
      .where(
        and(
          eq(h.tenantId, requireTenantId(scope)),
          eq(h.recordType, 'panel_registry'),
          sql`${status} is distinct from 'ACTIVE'`,
        ),
      )
      .orderBy(sql`${h.payload}->>'code_panel'`, asc(h.id));
    return rows.map((row) => ({
      code: row.code ?? '',
      name: row.name,
      panelType: row.panelType,
      status: row.status ?? 'UNKNOWN',
    }));
  }

  async listRecords(
    scope: TenantContext,
    filter: {
      readonly type: LegacyHistoryRecordType | null;
      readonly linked: boolean | null;
      readonly after: string | null;
    },
    limit: number,
  ): Promise<readonly LegacyHistoryRecordRow[]> {
    const rows = await this.db
      .select()
      .from(h)
      .where(
        and(
          eq(h.tenantId, requireTenantId(scope)),
          filter.type === null ? undefined : eq(h.recordType, filter.type),
          filter.linked === null
            ? undefined
            : filter.linked
              ? isNotNull(h.customerId)
              : isNull(h.customerId),
          filter.after === null ? undefined : gt(h.id, filter.after),
        ),
      )
      .orderBy(asc(h.id))
      .limit(limit);
    return rows.map(toRow);
  }

  async invoiceKeysOfService(scope: TenantContext, serviceId: string): Promise<readonly string[]> {
    const tenantId = requireTenantId(scope);
    const c = legacyServiceCandidates;
    const rows = await this.db
      .select({ invoiceKey: c.invoiceKey })
      .from(c)
      .innerJoin(services, and(eq(services.tenantId, c.tenantId), eq(services.id, c.serviceId)))
      .where(and(eq(c.tenantId, tenantId), eq(c.serviceId, serviceId)))
      .orderBy(asc(c.invoiceKey));
    return rows.map((row) => row.invoiceKey);
  }

  async recordsOfInvoices(
    scope: TenantContext,
    invoiceKeys: readonly string[],
    limit: number,
  ): Promise<readonly LegacyHistoryRecordRow[]> {
    if (invoiceKeys.length === 0) return [];
    const keys = [...invoiceKeys];
    const rows = await this.db
      .select()
      .from(h)
      .where(
        and(
          eq(h.tenantId, requireTenantId(scope)),
          or(
            and(
              inArray(h.recordType, ['service_operation', 'service_cancellation_request']),
              inArray(sql<string>`${h.payload}->'invoice_relation'->>'invoice_key'`, keys),
            ),
            and(
              eq(h.recordType, 'service_ownership'),
              inArray(sql<string>`${h.payload}->>'invoice_key'`, keys),
            ),
          ),
        ),
      )
      .orderBy(sql`${h.occurredAt} DESC NULLS LAST`, desc(h.id))
      .limit(limit);
    return rows.map(toRow);
  }
}

function toRow(row: typeof h.$inferSelect): LegacyHistoryRecordRow {
  return {
    id: row.id,
    nxpkgImportId: row.nxpkgImportId,
    packageImportId: row.packageImportId,
    recordType: row.recordType as LegacyHistoryRecordType,
    idempotencyKey: row.idempotencyKey,
    legacyUserId: row.legacyUserId,
    customerId: row.customerId,
    occurredAt: row.occurredAt,
    payload: row.payload as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}
