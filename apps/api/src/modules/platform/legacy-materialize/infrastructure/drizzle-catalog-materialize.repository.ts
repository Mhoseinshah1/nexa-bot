import { and, asc, eq, inArray, like, sql } from 'drizzle-orm';
import type { TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  discounts,
  legacyHistoryRecords,
  legacyImportMap,
  legacyNxpkgImports,
  panels,
  productCategories,
  products,
  resellerTierGrants,
  resellerTiers,
  resellers,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  CatalogTotals,
  DiscountsRepository,
  NewDiscountRow,
  NewProductRow,
  NewResellerRow,
  ProductFacts,
  ProductsRepository,
  ResellersRepository,
} from '../application/catalog-ports.js';
import {
  categoryKey,
  recOf,
  type HistoryRow,
  type MirzaAgentTier,
} from '../application/catalog-records.js';

const CHUNK = 500;
const EVERY = '*';
/** Everything a tier needs to let its resellers buy what an ordinary customer can: no narrower. */
const FULL_GRANTS = [
  { kind: 'OPERATION', subject: EVERY },
  { kind: 'CATEGORY', subject: EVERY },
  { kind: 'PANEL', subject: EVERY },
  { kind: 'BOT', subject: EVERY },
] as const;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/**
 * The catalogue steps' persistence: products, resellers and discount codes of the one-time
 * Mirza import, in PostgreSQL. INSERT … ON CONFLICT DO NOTHING and SELECTs. Nothing here
 * touches `wallet_entries`, the outbox, a notification or a provider — those tables are not
 * imported by this file, and a test pins that they stay empty.
 */
export class DrizzleCatalogMaterializeRepository
  implements ProductsRepository, ResellersRepository, DiscountsRepository
{
  constructor(private readonly db: Database) {}

  private exec(tx?: TransactionScope): Executor {
    return tx?.tx ?? this.db;
  }

  // -- the package ---------------------------------------------------------------------------

  async rows(
    scope: TenantContext,
    nxpkgImportId: string,
    recordType: string,
    tx?: TransactionScope,
  ): Promise<readonly HistoryRow[]> {
    const found = await this.exec(tx)
      .select({
        key: legacyHistoryRecords.idempotencyKey,
        legacyUserId: legacyHistoryRecords.legacyUserId,
        customerId: legacyHistoryRecords.customerId,
        payload: legacyHistoryRecords.payload,
      })
      .from(legacyHistoryRecords)
      .where(
        and(
          eq(legacyHistoryRecords.tenantId, requireTenantId(scope)),
          eq(legacyHistoryRecords.nxpkgImportId, nxpkgImportId),
          eq(legacyHistoryRecords.recordType, recordType),
        ),
      )
      .orderBy(sql`${legacyHistoryRecords.idempotencyKey} COLLATE "C"`);
    return found.map((r) => ({
      idempotencyKey: r.key,
      legacyUserId: r.legacyUserId,
      customerId: r.customerId,
      payload: recOf(r.payload),
    }));
  }

  async panelBindings(
    scope: TenantContext,
    nxpkgImportId: string,
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, string>> {
    const found = await this.exec(tx)
      .select({ bindings: legacyNxpkgImports.panelBindings })
      .from(legacyNxpkgImports)
      .where(
        and(
          eq(legacyNxpkgImports.tenantId, requireTenantId(scope)),
          eq(legacyNxpkgImports.id, nxpkgImportId),
        ),
      )
      .limit(1);
    const out = new Map<string, string>();
    for (const [code, id] of Object.entries(recOf(found[0]?.bindings))) {
      if (typeof id === 'string') out.set(code, id);
    }
    return out;
  }

  async panelIdsOf(
    scope: TenantContext,
    ids: readonly string[],
    tx?: TransactionScope,
  ): Promise<ReadonlySet<string>> {
    if (ids.length === 0) return new Set();
    const found = await this.exec(tx)
      .select({ id: panels.id })
      .from(panels)
      .where(and(eq(panels.tenantId, requireTenantId(scope)), inArray(panels.id, [...ids])));
    return new Set(found.map((r) => r.id));
  }

  async customersByTelegram(
    scope: TenantContext,
    telegramUserIds: readonly string[],
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    for (const part of chunks(telegramUserIds)) {
      const found = await this.exec(tx)
        .select({ legacyId: legacyImportMap.legacyId, customerId: legacyImportMap.entityId })
        .from(legacyImportMap)
        .where(
          and(
            eq(legacyImportMap.tenantId, requireTenantId(scope)),
            eq(legacyImportMap.legacyTable, 'user'),
            eq(legacyImportMap.status, 'IMPORTED'),
            eq(legacyImportMap.entityType, 'CUSTOMER'),
            inArray(legacyImportMap.legacyId, part),
          ),
        );
      for (const r of found) if (r.customerId !== null) out.set(r.legacyId, r.customerId);
    }
    return out;
  }

  // -- products ------------------------------------------------------------------------------

  async productsBySourceRef(
    scope: TenantContext,
    refs: readonly string[],
    tx: TransactionScope,
  ): Promise<ReadonlyMap<string, ProductFacts>> {
    const out = new Map<string, ProductFacts>();
    for (const part of chunks(refs)) {
      const found = await this.exec(tx)
        .select({
          ref: products.sourceRef,
          trafficBytes: products.trafficBytes,
          durationDays: products.durationDays,
        })
        .from(products)
        .where(
          and(eq(products.tenantId, requireTenantId(scope)), inArray(products.sourceRef, part)),
        );
      for (const r of found) {
        if (r.ref !== null) {
          out.set(r.ref, { trafficBytes: r.trafficBytes, durationDays: r.durationDays });
        }
      }
    }
    return out;
  }

  async productIdsBySourceRef(
    scope: TenantContext,
    refs: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    for (const part of chunks(refs)) {
      const found = await this.db
        .select({ ref: products.sourceRef, id: products.id })
        .from(products)
        .where(
          and(eq(products.tenantId, requireTenantId(scope)), inArray(products.sourceRef, part)),
        );
      for (const r of found) if (r.ref !== null) out.set(r.ref, r.id);
    }
    return out;
  }

  async categoryIdsByKey(scope: TenantContext, tx: TransactionScope): Promise<Map<string, string>> {
    const found = await this.exec(tx)
      .select({ id: productCategories.id, name: productCategories.name })
      .from(productCategories)
      .where(eq(productCategories.tenantId, requireTenantId(scope)))
      .orderBy(asc(productCategories.createdAt), asc(productCategories.id));
    const out = new Map<string, string>();
    for (const r of found) {
      const key = categoryKey(r.name);
      if (!out.has(key)) out.set(key, r.id);
    }
    return out;
  }

  async insertCategory(
    scope: TenantContext,
    row: { readonly id: string; readonly name: string },
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    await this.exec(tx)
      .insert(productCategories)
      .values({
        id: row.id,
        tenantId: requireTenantId(scope),
        name: row.name,
        status: 'ACTIVE',
        visibility: 'VISIBLE',
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      });
  }

  async insertProducts(
    scope: TenantContext,
    rows: readonly NewProductRow[],
    now: Date,
    tx: TransactionScope,
  ): Promise<ReadonlySet<string>> {
    const tenantId = requireTenantId(scope);
    const written = new Set<string>();
    for (const part of chunks(rows)) {
      const inserted = await this.exec(tx)
        .insert(products)
        .values(
          part.map((r) => ({
            id: r.id,
            tenantId,
            title: r.title,
            status: r.status,
            audience: r.audience,
            sortOrder: 0,
            panelId: r.panelId,
            categoryId: r.categoryId,
            durationDays: r.durationDays,
            trafficBytes: r.trafficBytes,
            priceAmount: r.priceMinor,
            priceCurrency: r.priceMinor === null ? null : 'IRT',
            createdAt: now,
            updatedAt: now,
            source: 'MIRZA',
            sourceRef: r.sourceRef,
          })),
        )
        .onConflictDoNothing()
        .returning({ ref: products.sourceRef });
      for (const r of inserted) if (r.ref !== null) written.add(r.ref);
    }
    return written;
  }

  async mirzaProductTotals(scope: TenantContext): Promise<CatalogTotals> {
    const [row] = await this.db
      .select({
        n: sql<string>`count(*)::text`,
        sum: sql<string>`coalesce(sum(${products.priceAmount}), 0)::text`,
      })
      .from(products)
      .where(
        and(
          eq(products.tenantId, requireTenantId(scope)),
          eq(products.source, 'MIRZA'),
          like(products.sourceRef, 'product:%'),
        ),
      );
    return { rows: Number(row?.n ?? 0), sumMinor: BigInt(row?.sum ?? '0') };
  }

  async categoryKeys(scope: TenantContext): Promise<ReadonlySet<string>> {
    const found = await this.db
      .select({ name: productCategories.name })
      .from(productCategories)
      .where(eq(productCategories.tenantId, requireTenantId(scope)));
    return new Set(found.map((r) => categoryKey(r.name)));
  }

  // -- resellers -----------------------------------------------------------------------------

  async ensureTier(
    scope: TenantContext,
    _tier: MirzaAgentTier,
    name: string,
    ids: { tierId: string },
    now: Date,
    tx: TransactionScope,
  ): Promise<string> {
    const tenantId = requireTenantId(scope);
    const existing = await this.exec(tx)
      .select({ id: resellerTiers.id })
      .from(resellerTiers)
      .where(
        and(
          eq(resellerTiers.tenantId, tenantId),
          sql`lower(${resellerTiers.name}) = lower(${name})`,
        ),
      )
      .limit(1);
    if (existing[0] !== undefined) return existing[0].id;
    await this.exec(tx).insert(resellerTiers).values({
      id: ids.tierId,
      tenantId,
      name,
      // The tier prices at LIST: Mirza's per-tier prices are unproven and are not applied.
      pricingMode: 'LIST_PRICE',
      discountPercentage: null,
      creditLimitAmount: 0n,
      creditLimitCurrency: 'IRT',
      createdAt: now,
      updatedAt: now,
    });
    // Deny-by-default would lock every imported agent out of buying anything. The grants are
    // exactly what an ordinary customer can already do — one wildcard per dimension — so the
    // owner narrows them on the tier page; the import widens nothing beyond list-price buying.
    await this.exec(tx)
      .insert(resellerTierGrants)
      .values(FULL_GRANTS.map((g) => ({ tenantId, tierId: ids.tierId, ...g, createdAt: now })));
    return ids.tierId;
  }

  async resellersBySourceRef(
    scope: TenantContext,
    refs: readonly string[],
    tx: TransactionScope,
  ): Promise<ReadonlyMap<string, { readonly customerId: string }>> {
    const out = new Map<string, { customerId: string }>();
    for (const part of chunks(refs)) {
      const found = await this.exec(tx)
        .select({ ref: resellers.sourceRef, customerId: resellers.customerId })
        .from(resellers)
        .where(
          and(eq(resellers.tenantId, requireTenantId(scope)), inArray(resellers.sourceRef, part)),
        );
      for (const r of found) if (r.ref !== null) out.set(r.ref, { customerId: r.customerId });
    }
    return out;
  }

  async resellerCustomers(
    scope: TenantContext,
    customerIds: readonly string[],
    tx?: TransactionScope,
  ): Promise<ReadonlySet<string>> {
    const out = new Set<string>();
    for (const part of chunks(customerIds)) {
      const found = await this.exec(tx)
        .select({ customerId: resellers.customerId })
        .from(resellers)
        .where(
          and(eq(resellers.tenantId, requireTenantId(scope)), inArray(resellers.customerId, part)),
        );
      for (const r of found) out.add(r.customerId);
    }
    return out;
  }

  async insertResellers(
    scope: TenantContext,
    rows: readonly NewResellerRow[],
    now: Date,
    tx: TransactionScope,
  ): Promise<ReadonlySet<string>> {
    const tenantId = requireTenantId(scope);
    const written = new Set<string>();
    for (const part of chunks(rows)) {
      const inserted = await this.exec(tx)
        .insert(resellers)
        .values(
          part.map((r) => ({
            id: r.id,
            tenantId,
            customerId: r.customerId,
            tierId: r.tierId,
            status: 'ACTIVE',
            pricingMode: r.percent === null ? 'TIER' : 'PERCENTAGE_DISCOUNT',
            discountPercentage: r.percent,
            // No own credit limit: the tier's (zero) stands, and no write may store another.
            creditLimitAmount: null,
            creditLimitCurrency: null,
            monthlyMinimumAmount: null,
            monthlyMinimumCurrency: null,
            importedPurchaseCapMinor: r.capMinor,
            importedPurchaseCapCurrency: r.capMinor === null ? null : 'IRT',
            sourceDetail: r.detail,
            createdAt: now,
            updatedAt: now,
            source: 'MIRZA',
            sourceRef: r.sourceRef,
          })),
        )
        .onConflictDoNothing()
        .returning({ ref: resellers.sourceRef });
      for (const r of inserted) if (r.ref !== null) written.add(r.ref);
    }
    return written;
  }

  async mirzaResellerTotals(
    scope: TenantContext,
  ): Promise<CatalogTotals & { readonly levels: number }> {
    const [row] = await this.db
      .select({
        n: sql<string>`count(*)::text`,
        sum: sql<string>`coalesce(sum(${resellers.importedPurchaseCapMinor}), 0)::text`,
        levels: sql<string>`coalesce(sum(jsonb_array_length(${resellers.sourceDetail}->'tierPriceLevels'->'levels')), 0)::text`,
      })
      .from(resellers)
      .where(and(eq(resellers.tenantId, requireTenantId(scope)), eq(resellers.source, 'MIRZA')));
    return {
      rows: Number(row?.n ?? 0),
      sumMinor: BigInt(row?.sum ?? '0'),
      levels: Number(row?.levels ?? 0),
    };
  }

  async mirzaResellerRefs(scope: TenantContext): Promise<ReadonlySet<string>> {
    const found = await this.db
      .select({ ref: resellers.sourceRef })
      .from(resellers)
      .where(and(eq(resellers.tenantId, requireTenantId(scope)), eq(resellers.source, 'MIRZA')));
    return new Set(found.flatMap((r) => (r.ref === null ? [] : [r.ref])));
  }

  // -- discounts -----------------------------------------------------------------------------

  async discountsBySourceRef(
    scope: TenantContext,
    refs: readonly string[],
    tx: TransactionScope,
  ): Promise<ReadonlyMap<string, { readonly type: string; readonly value: bigint }>> {
    const out = new Map<string, { type: string; value: bigint }>();
    for (const part of chunks(refs)) {
      const found = await this.exec(tx)
        .select({ ref: discounts.sourceRef, type: discounts.type, value: discounts.value })
        .from(discounts)
        .where(
          and(eq(discounts.tenantId, requireTenantId(scope)), inArray(discounts.sourceRef, part)),
        );
      for (const r of found) if (r.ref !== null) out.set(r.ref, { type: r.type, value: r.value });
    }
    return out;
  }

  async takenCodes(scope: TenantContext, tx: TransactionScope): Promise<Set<string>> {
    const found = await this.exec(tx)
      .select({ code: discounts.code })
      .from(discounts)
      .where(eq(discounts.tenantId, requireTenantId(scope)));
    return new Set(found.flatMap((r) => (r.code === null ? [] : [r.code])));
  }

  async insertDiscounts(
    scope: TenantContext,
    rows: readonly NewDiscountRow[],
    now: Date,
    tx: TransactionScope,
  ): Promise<ReadonlySet<string>> {
    const tenantId = requireTenantId(scope);
    const written = new Set<string>();
    for (const part of chunks(rows)) {
      const inserted = await this.exec(tx)
        .insert(discounts)
        .values(
          part.map((r) => ({
            id: r.id,
            tenantId,
            kind: 'CODE',
            code: r.code,
            label: r.label,
            type: r.type,
            // Never ACTIVE: an imported code is a bearer secret that Mirza already issued.
            // The owner reads it, then switches it on.
            status: 'INACTIVE',
            value: r.value,
            currency: r.currency,
            appliesTo: [...r.appliesTo],
            firstPurchaseOnly: r.firstPurchaseOnly,
            endsAt: r.endsAt,
            totalRedemptionsLimit: r.totalLimit,
            perCustomerLimit: r.perCustomerLimit,
            sourceDetail: r.detail,
            createdAt: now,
            updatedAt: now,
            source: 'MIRZA',
            sourceRef: r.sourceRef,
          })),
        )
        .onConflictDoNothing()
        .returning({ ref: discounts.sourceRef });
      for (const r of inserted) if (r.ref !== null) written.add(r.ref);
    }
    return written;
  }

  async mirzaDiscountRefs(scope: TenantContext): Promise<ReadonlySet<string>> {
    const found = await this.db
      .select({ ref: discounts.sourceRef })
      .from(discounts)
      .where(and(eq(discounts.tenantId, requireTenantId(scope)), eq(discounts.source, 'MIRZA')));
    return new Set(found.flatMap((r) => (r.ref === null ? [] : [r.ref])));
  }
}
