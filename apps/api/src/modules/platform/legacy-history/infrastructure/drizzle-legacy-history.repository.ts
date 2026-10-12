import { and, count, countDistinct, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { LegacyHistoryRecordType, TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  legacyHistoryRecords,
  legacyImportMap,
  legacyInvoiceArchive,
  legacyNxpkgImports,
  legacyWalletDebts,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  LegacyHistoryRecordRow,
  LegacyHistoryRepository,
  NewLegacyHistoryRecord,
} from '../application/ports.js';

/** Rows per INSERT: 10 columns × 1000 stays far under PostgreSQL's 65 535 binds. */
const INSERT_CHUNK = 1000;

/**
 * `legacy_history_records` in PostgreSQL. Append-only: INSERT … ON CONFLICT DO NOTHING and
 * SELECTs, nothing else — the table's triggers refuse UPDATE and DELETE for every role.
 */
export class DrizzleLegacyHistoryRepository implements LegacyHistoryRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: TransactionScope): Executor {
    return tx?.tx ?? this.db;
  }

  async packageImportIdOf(
    scope: TenantContext,
    nxpkgImportId: string,
    tx?: TransactionScope,
  ): Promise<string | null | undefined> {
    const rows = await this.exec(tx)
      .select({ packageImportId: legacyNxpkgImports.packageImportId })
      .from(legacyNxpkgImports)
      .where(
        and(
          eq(legacyNxpkgImports.tenantId, requireTenantId(scope)),
          eq(legacyNxpkgImports.id, nxpkgImportId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : row.packageImportId;
  }

  async insertMany(
    scope: TenantContext,
    nxpkgImportId: string,
    packageImportId: string,
    rows: readonly NewLegacyHistoryRecord[],
    now: Date,
    tx: TransactionScope,
  ): Promise<ReadonlySet<string>> {
    const tenantId = requireTenantId(scope);
    const inserted = new Set<string>();
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      const written = await this.exec(tx)
        .insert(legacyHistoryRecords)
        .values(
          chunk.map((row) => ({
            id: row.id,
            tenantId,
            nxpkgImportId,
            packageImportId,
            recordType: row.recordType,
            idempotencyKey: row.idempotencyKey,
            legacyUserId: row.legacyUserId,
            customerId: row.customerId,
            occurredAt: row.occurredAt,
            payload: row.payload,
            createdAt: now,
          })),
        )
        .onConflictDoNothing({
          target: [
            legacyHistoryRecords.tenantId,
            legacyHistoryRecords.packageImportId,
            legacyHistoryRecords.idempotencyKey,
          ],
        })
        .returning({ key: legacyHistoryRecords.idempotencyKey });
      for (const row of written) inserted.add(row.key);
    }
    return inserted;
  }

  async existingKeys(
    scope: TenantContext,
    packageImportId: string,
    keys: readonly string[],
    tx?: TransactionScope,
  ): Promise<ReadonlySet<string>> {
    if (keys.length === 0) return new Set();
    const rows = await this.exec(tx)
      .select({ key: legacyHistoryRecords.idempotencyKey })
      .from(legacyHistoryRecords)
      .where(
        and(
          eq(legacyHistoryRecords.tenantId, requireTenantId(scope)),
          eq(legacyHistoryRecords.packageImportId, packageImportId),
          inArray(legacyHistoryRecords.idempotencyKey, [...keys]),
        ),
      );
    return new Set(rows.map((row) => row.key));
  }

  async customersByLegacyUser(
    scope: TenantContext,
    legacyUserIds: readonly string[],
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, string>> {
    if (legacyUserIds.length === 0) return new Map();
    const rows = await this.exec(tx)
      .select({ legacyId: legacyImportMap.legacyId, customerId: legacyImportMap.entityId })
      .from(legacyImportMap)
      .where(
        and(
          eq(legacyImportMap.tenantId, requireTenantId(scope)),
          eq(legacyImportMap.legacyTable, 'user'),
          eq(legacyImportMap.status, 'IMPORTED'),
          eq(legacyImportMap.entityType, 'CUSTOMER'),
          inArray(legacyImportMap.legacyId, [...legacyUserIds]),
        ),
      );
    const out = new Map<string, string>();
    for (const row of rows) {
      if (row.customerId !== null) out.set(row.legacyId, row.customerId);
    }
    return out;
  }

  async listForCustomer(
    scope: TenantContext,
    customer: { readonly id: string; readonly telegramUserId: string },
    type: LegacyHistoryRecordType | null,
    offset: number,
    limit: number,
  ): Promise<readonly LegacyHistoryRecordRow[]> {
    const rows = await this.db
      .select()
      .from(legacyHistoryRecords)
      .where(
        and(
          this.ofCustomer(scope, customer),
          type === null ? undefined : eq(legacyHistoryRecords.recordType, type),
        ),
      )
      .orderBy(
        sql`${legacyHistoryRecords.occurredAt} DESC NULLS LAST`,
        desc(legacyHistoryRecords.createdAt),
        desc(legacyHistoryRecords.id),
      )
      .offset(offset)
      .limit(limit);
    return rows.map((row) => ({
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
    }));
  }

  async countsForCustomer(
    scope: TenantContext,
    customer: { readonly id: string; readonly telegramUserId: string },
  ): Promise<ReadonlyMap<LegacyHistoryRecordType, number>> {
    const rows = await this.db
      .select({ type: legacyHistoryRecords.recordType, n: count() })
      .from(legacyHistoryRecords)
      .where(this.ofCustomer(scope, customer))
      .groupBy(legacyHistoryRecords.recordType);
    return new Map(rows.map((row) => [row.type as LegacyHistoryRecordType, Number(row.n)]));
  }

  async invoiceArchiveCount(scope: TenantContext, telegramUserId: string): Promise<number> {
    const rows = await this.db
      .select({ n: countDistinct(legacyInvoiceArchive.invoiceKey) })
      .from(legacyInvoiceArchive)
      .where(
        and(
          eq(legacyInvoiceArchive.tenantId, requireTenantId(scope)),
          eq(legacyInvoiceArchive.legacyUserId, telegramUserId),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  async walletDebtCount(scope: TenantContext, customerId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(legacyWalletDebts)
      .where(
        and(
          eq(legacyWalletDebts.tenantId, requireTenantId(scope)),
          eq(legacyWalletDebts.customerId, customerId),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  /** Linked to the customer, or not linked to anyone and filed under its Telegram id. */
  private ofCustomer(
    scope: TenantContext,
    customer: { readonly id: string; readonly telegramUserId: string },
  ) {
    return and(
      eq(legacyHistoryRecords.tenantId, requireTenantId(scope)),
      or(
        eq(legacyHistoryRecords.customerId, customer.id),
        and(
          isNull(legacyHistoryRecords.customerId),
          eq(legacyHistoryRecords.legacyUserId, customer.telegramUserId),
        ),
      ),
    );
  }
}
