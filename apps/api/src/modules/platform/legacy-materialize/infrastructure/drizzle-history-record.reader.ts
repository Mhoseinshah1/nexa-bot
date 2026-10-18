import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import type { TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  legacyHistoryRecords,
  legacyImportMap,
} from '../../../../infrastructure/persistence/schema.js';
import type { HistoryRecord, HistoryRecordReader } from '../application/materialize-support.js';

/** The archive (`legacy_history_records`) and the importer's customer map, read only. */
export class DrizzleHistoryRecordReader implements HistoryRecordReader {
  constructor(private readonly db: Database) {}

  private exec(tx?: TransactionScope): Executor {
    return tx?.tx ?? this.db;
  }

  async page(
    scope: TenantContext,
    nxpkgImportId: string,
    recordType: string,
    afterId: string | null,
    limit: number,
    tx?: TransactionScope,
  ): Promise<readonly HistoryRecord[]> {
    const rows = await this.exec(tx)
      .select()
      .from(legacyHistoryRecords)
      .where(
        and(
          eq(legacyHistoryRecords.tenantId, requireTenantId(scope)),
          eq(legacyHistoryRecords.nxpkgImportId, nxpkgImportId),
          eq(legacyHistoryRecords.recordType, recordType),
          afterId === null ? undefined : gt(legacyHistoryRecords.id, afterId),
        ),
      )
      .orderBy(asc(legacyHistoryRecords.id))
      .limit(limit);
    return rows.map(toRecord);
  }

  async byIds(
    scope: TenantContext,
    nxpkgImportId: string,
    ids: readonly string[],
    tx?: TransactionScope,
  ): Promise<readonly HistoryRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.exec(tx)
      .select()
      .from(legacyHistoryRecords)
      .where(
        and(
          eq(legacyHistoryRecords.tenantId, requireTenantId(scope)),
          eq(legacyHistoryRecords.nxpkgImportId, nxpkgImportId),
          inArray(legacyHistoryRecords.id, [...ids]),
        ),
      );
    return rows.map(toRecord);
  }

  async customersByLegacyUser(
    scope: TenantContext,
    legacyUserIds: readonly string[],
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    if (legacyUserIds.length === 0) return out;
    const rows = await this.exec(tx)
      .select({ legacyId: legacyImportMap.legacyId, customerId: legacyImportMap.entityId })
      .from(legacyImportMap)
      .where(
        and(
          eq(legacyImportMap.tenantId, requireTenantId(scope)),
          eq(legacyImportMap.legacyTable, 'user'),
          eq(legacyImportMap.status, 'IMPORTED'),
          eq(legacyImportMap.entityType, 'CUSTOMER'),
          inArray(legacyImportMap.legacyId, [...new Set(legacyUserIds)]),
        ),
      );
    for (const row of rows) if (row.customerId !== null) out.set(row.legacyId, row.customerId);
    return out;
  }
}

function toRecord(row: typeof legacyHistoryRecords.$inferSelect): HistoryRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    legacyUserId: row.legacyUserId,
    customerId: row.customerId,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
    payload: row.payload as Record<string, unknown>,
  };
}
