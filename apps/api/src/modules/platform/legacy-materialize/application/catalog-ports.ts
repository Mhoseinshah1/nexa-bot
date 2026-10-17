import type { TenantContext } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { HistoryRow, MirzaAgentTier } from './catalog-records.js';

/**
 * What the catalogue steps (products, resellers, discount codes) read and write. One port, one
 * Drizzle implementation: a step never reaches the database any other way, so nothing it
 * writes can pass through a business service, an outbox or the ledger.
 *
 * Writes take the caller's transaction. Reads without one are for `match`, which is read only.
 */

export interface PackageRows {
  /** The package's archived records of one type, in idempotency-key byte order. */
  rows(
    scope: TenantContext,
    nxpkgImportId: string,
    recordType: string,
    tx?: TransactionScope,
  ): Promise<readonly HistoryRow[]>;
  /** `code_panel` → NEXA panel id, as the operator bound them for this import. */
  panelBindings(
    scope: TenantContext,
    nxpkgImportId: string,
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, string>>;
  /** The subset of `ids` that are panels of this tenant. */
  panelIdsOf(
    scope: TenantContext,
    ids: readonly string[],
    tx?: TransactionScope,
  ): Promise<ReadonlySet<string>>;
  /** Telegram id → customer id, through the importer's map. */
  customersByTelegram(
    scope: TenantContext,
    telegramUserIds: readonly string[],
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, string>>;
}

export interface NewProductRow {
  readonly id: string;
  readonly sourceRef: string;
  readonly title: string;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly audience: 'EVERYONE' | 'RESELLERS_ONLY' | 'HIDDEN';
  readonly panelId: string | null;
  readonly categoryId: string | null;
  readonly durationDays: number;
  readonly trafficBytes: bigint;
  readonly priceMinor: bigint | null;
}

export interface ProductFacts {
  readonly trafficBytes: bigint;
  readonly durationDays: number;
}

export interface CatalogTotals {
  readonly rows: number;
  readonly sumMinor: bigint;
}

export interface ProductsRepository extends PackageRows {
  productsBySourceRef(
    scope: TenantContext,
    refs: readonly string[],
    tx: TransactionScope,
  ): Promise<ReadonlyMap<string, ProductFacts>>;
  /** The ids of the products the import created, by `source_ref`. Read only. */
  productIdsBySourceRef(
    scope: TenantContext,
    refs: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  /** Every category of the tenant, by `lower(btrim(name))`. */
  categoryIdsByKey(scope: TenantContext, tx: TransactionScope): Promise<Map<string, string>>;
  insertCategory(
    scope: TenantContext,
    row: { readonly id: string; readonly name: string },
    now: Date,
    tx: TransactionScope,
  ): Promise<void>;
  /** Inserts what is not there; returns the refs it wrote. */
  insertProducts(
    scope: TenantContext,
    rows: readonly NewProductRow[],
    now: Date,
    tx: TransactionScope,
  ): Promise<ReadonlySet<string>>;
  // read only, for `match`
  mirzaProductTotals(scope: TenantContext): Promise<CatalogTotals>;
  categoryKeys(scope: TenantContext): Promise<ReadonlySet<string>>;
}

export interface NewResellerRow {
  readonly id: string;
  readonly sourceRef: string;
  readonly customerId: string;
  readonly tierId: string;
  readonly percent: number | null;
  readonly capMinor: bigint | null;
  readonly detail: Record<string, unknown>;
}

export interface ResellersRepository extends PackageRows {
  /** The NEXA tier a Mirza tier becomes; created (with full grants) when it is missing. */
  ensureTier(
    scope: TenantContext,
    tier: MirzaAgentTier,
    name: string,
    ids: { tierId: string },
    now: Date,
    tx: TransactionScope,
  ): Promise<string>;
  resellersBySourceRef(
    scope: TenantContext,
    refs: readonly string[],
    tx: TransactionScope,
  ): Promise<ReadonlyMap<string, { readonly customerId: string }>>;
  /** Customers (of those given) that already have a reseller row, by whatever route. */
  resellerCustomers(
    scope: TenantContext,
    customerIds: readonly string[],
    tx?: TransactionScope,
  ): Promise<ReadonlySet<string>>;
  insertResellers(
    scope: TenantContext,
    rows: readonly NewResellerRow[],
    now: Date,
    tx: TransactionScope,
  ): Promise<ReadonlySet<string>>;
  // read only, for `match`
  mirzaResellerTotals(scope: TenantContext): Promise<CatalogTotals & { readonly levels: number }>;
  mirzaResellerRefs(scope: TenantContext): Promise<ReadonlySet<string>>;
}

export interface NewDiscountRow {
  readonly id: string;
  readonly sourceRef: string;
  readonly code: string;
  readonly label: string;
  readonly type: 'PERCENTAGE' | 'FIXED_AMOUNT';
  readonly value: bigint;
  readonly currency: 'IRT' | null;
  readonly appliesTo: readonly string[];
  readonly firstPurchaseOnly: boolean;
  readonly totalLimit: number | null;
  readonly perCustomerLimit: number | null;
  readonly endsAt: Date | null;
  readonly detail: Record<string, unknown>;
}

export interface DiscountsRepository extends PackageRows {
  discountsBySourceRef(
    scope: TenantContext,
    refs: readonly string[],
    tx: TransactionScope,
  ): Promise<ReadonlyMap<string, { readonly type: string; readonly value: bigint }>>;
  /** Every code the tenant holds, so a new one never collides. */
  takenCodes(scope: TenantContext, tx: TransactionScope): Promise<Set<string>>;
  insertDiscounts(
    scope: TenantContext,
    rows: readonly NewDiscountRow[],
    now: Date,
    tx: TransactionScope,
  ): Promise<ReadonlySet<string>>;
  // read only, for `match`
  mirzaDiscountRefs(scope: TenantContext): Promise<ReadonlySet<string>>;
}
