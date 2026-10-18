import { discountSourceRef as catalogDiscountSourceRef } from '../application/catalog-records.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { IdGenerator, TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  discountRedemptions,
  discounts,
  legacyHistoryRecords,
  orders,
} from '../../../../infrastructure/persistence/schema.js';
import {
  redemptionFingerprint,
  type DiscountUsageHistoryRepository,
  type ImportedOrderFact,
  type RedemptionWrite,
} from '../application/discount-usage-history.step.js';
import { MIRZA_SOURCE } from '../application/materialize-support.js';
import type { MaterializeContext } from '../application/ports.js';

/**
 * `discount_redemptions` for imported usage. The table has no `source` column of its own: a
 * redemption is Mirza's because its order is (`orders.source = 'MIRZA'`, origin
 * `LEGACY_HISTORY`), and its identity is the table's own `(order, discount)` unique key.
 */
export class DrizzleDiscountUsageHistoryRepository implements DiscountUsageHistoryRepository {
  constructor(
    private readonly db: Database,
    private readonly ids: IdGenerator,
  ) {}

  private exec(tx?: TransactionScope): Executor {
    return tx?.tx ?? this.db;
  }

  async discountsByCodeRef(
    scope: TenantContext,
    nxpkgImportId: string,
    codeRefs: readonly string[],
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    if (codeRefs.length === 0) return out;
    const tenantId = requireTenantId(scope);
    const records = await this.exec(tx)
      .select({
        codeRef: sql<string>`${legacyHistoryRecords.payload}->>'code_ref'`,
        key: legacyHistoryRecords.idempotencyKey,
      })
      .from(legacyHistoryRecords)
      .where(
        and(
          eq(legacyHistoryRecords.tenantId, tenantId),
          eq(legacyHistoryRecords.nxpkgImportId, nxpkgImportId),
          eq(legacyHistoryRecords.recordType, 'discount'),
          inArray(sql`${legacyHistoryRecords.payload}->>'code_ref'`, [...new Set(codeRefs)]),
        ),
      );
    const refByCodeRef = new Map<string, string>();
    // The catalogue's own rule for a discount's ref (one function, never a second derivation).
    for (const r of records) refByCodeRef.set(r.codeRef, catalogDiscountSourceRef(r.key));
    if (refByCodeRef.size === 0) return out;
    const found = await this.exec(tx)
      .select({ id: discounts.id, sourceRef: discounts.sourceRef })
      .from(discounts)
      .where(
        and(
          eq(discounts.tenantId, tenantId),
          eq(discounts.source, MIRZA_SOURCE),
          inArray(discounts.sourceRef, [...refByCodeRef.values()]),
        ),
      );
    const idByRef = new Map(found.map((d) => [d.sourceRef, d.id]));
    for (const [codeRef, ref] of refByCodeRef) {
      const id = idByRef.get(ref);
      if (id !== undefined) out.set(codeRef, id);
    }
    return out;
  }

  async ordersBySourceRef(
    scope: TenantContext,
    sourceRefs: readonly string[],
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, ImportedOrderFact>> {
    const out = new Map<string, ImportedOrderFact>();
    if (sourceRefs.length === 0) return out;
    const rows = await this.exec(tx)
      .select({
        id: orders.id,
        sourceRef: orders.sourceRef,
        customerId: orders.customerId,
        currency: orders.currency,
        settledAt: orders.settledAt,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, requireTenantId(scope)),
          eq(orders.source, MIRZA_SOURCE),
          inArray(orders.sourceRef, [...new Set(sourceRefs)]),
        ),
      );
    for (const row of rows) {
      if (row.sourceRef === null) continue;
      out.set(row.sourceRef, {
        id: row.id,
        customerId: row.customerId,
        currency: row.currency,
        at: row.settledAt ?? row.createdAt,
      });
    }
    return out;
  }

  async insert(
    scope: TenantContext,
    rows: readonly RedemptionWrite[],
    _ctx: MaterializeContext,
    tx: TransactionScope,
  ): Promise<ReadonlySet<string>> {
    const tenantId = requireTenantId(scope);
    const inserted = new Set<string>();
    for (const row of rows) {
      const done = await this.exec(tx)
        .insert(discountRedemptions)
        .values({
          id: this.ids.uuid(),
          tenantId,
          discountId: row.discountId,
          customerId: row.customerId,
          orderId: row.orderId,
          amount: row.amountMinor,
          currency: row.currency,
          createdAt: row.createdAt,
        })
        .onConflictDoNothing()
        .returning({ id: discountRedemptions.id });
      if (done.length > 0) inserted.add(row.sourceRef);
    }
    return inserted;
  }

  async fingerprints(
    scope: TenantContext,
    wanted: readonly RedemptionWrite[],
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    for (const w of wanted) {
      const [row] = await this.exec(tx)
        .select()
        .from(discountRedemptions)
        .where(
          and(
            eq(discountRedemptions.tenantId, requireTenantId(scope)),
            eq(discountRedemptions.orderId, w.orderId),
            eq(discountRedemptions.discountId, w.discountId),
          ),
        );
      if (row !== undefined) {
        out.set(
          w.sourceRef,
          redemptionFingerprint({
            discountId: row.discountId,
            orderId: row.orderId,
            customerId: row.customerId,
            amountMinor: row.amount,
            currency: row.currency,
            createdAt: row.createdAt,
          }),
        );
      }
    }
    return out;
  }

  async totals(scope: TenantContext) {
    const [row] = await this.db
      .select({ rows: sql<number>`count(*)::int` })
      .from(discountRedemptions)
      .innerJoin(
        orders,
        and(
          eq(orders.tenantId, discountRedemptions.tenantId),
          eq(orders.id, discountRedemptions.orderId),
        ),
      )
      .where(
        and(
          eq(discountRedemptions.tenantId, requireTenantId(scope)),
          eq(orders.source, MIRZA_SOURCE),
        ),
      );
    return { rows: row?.rows ?? 0, sumMinor: null };
  }
}
