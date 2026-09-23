import type {
  CurrencyCode,
  Money,
  ResellerGrantKind,
  ResellerOverrideMode,
  ResellerPriceLayer,
  ResellerPricingMode,
  ResellerStatus,
  TenantContext,
} from '@nexa/contracts';

/**
 * The reseller module's persistence (`docs/wp9-reseller-audit.md`).
 *
 * Every method carries the tenant. Methods that take a `tx` run inside the caller's
 * transaction; those without are reads for the operator's surfaces.
 */

export interface ResellerTierGrantRecord {
  readonly kind: ResellerGrantKind;
  /** Null grants every subject of its kind — stored as `'*'`. */
  readonly subject: string | null;
}

export interface ResellerTierRecord {
  readonly id: string;
  readonly name: string;
  readonly pricingMode: ResellerPricingMode;
  readonly discountPercentage: number | null;
  readonly creditLimit: Money;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ResellerTierListing extends ResellerTierRecord {
  readonly grants: readonly ResellerTierGrantRecord[];
  readonly resellerCount: number;
}

export interface ResellerRecord {
  readonly id: string;
  readonly customerId: string;
  readonly tierId: string;
  readonly status: ResellerStatus;
  readonly pricingMode: ResellerOverrideMode;
  readonly discountPercentage: number | null;
  /** The reseller's own limit, or null for the tier's. */
  readonly creditLimit: Money | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ResellerListing extends ResellerRecord {
  readonly telegramUserId: string;
  readonly displayName: string | null;
  readonly tier: ResellerTierRecord;
}

export interface ResellerCursor {
  readonly createdAt: string;
  readonly id: string;
}

/** The terms a reseller order was confirmed on (R9). */
export interface OrderResellerTermsRecord {
  readonly orderId: string;
  readonly resellerCustomerId: string;
  readonly tierId: string;
  readonly tierName: string;
  readonly layer: ResellerPriceLayer;
  readonly percent: number | null;
  readonly listAmount: bigint;
  readonly costAmount: bigint;
  readonly promotionAmount: bigint;
  readonly saleAmount: bigint;
  readonly marginAmount: bigint;
  readonly currency: CurrencyCode;
  readonly botInstanceId: string | null;
  readonly createdAt: Date;
}

export interface TierWrite {
  readonly name: string;
  readonly pricingMode: ResellerPricingMode;
  readonly discountPercentage: number | null;
  readonly creditLimit: Money;
}

export interface ResellerWrite {
  readonly tierId: string;
  readonly status: ResellerStatus;
  readonly pricingMode: ResellerOverrideMode;
  readonly discountPercentage: number | null;
  readonly creditLimit: Money | null;
}

export interface ResellerRepository {
  // -- Tiers --------------------------------------------------------------------

  /** False when another tier of this tenant already has the name, in any case. */
  createTier(
    scope: TenantContext,
    input: TierWrite & { readonly id: string; readonly now: Date },
    tx: unknown,
  ): Promise<boolean>;

  /** `null` when no tier has this id; `'NAME_TAKEN'` when the new name is another's. */
  updateTier(
    scope: TenantContext,
    id: string,
    input: TierWrite & { readonly now: Date },
    tx: unknown,
  ): Promise<ResellerTierRecord | 'NAME_TAKEN' | null>;

  findTier(scope: TenantContext, id: string, tx?: unknown): Promise<ResellerTierRecord | null>;

  /** `SELECT … FOR UPDATE` on the tier row, so a grants write and a reader agree. */
  lockTier(scope: TenantContext, id: string, tx: unknown): Promise<ResellerTierRecord | null>;

  grantsOf(
    scope: TenantContext,
    tierId: string,
    tx?: unknown,
  ): Promise<readonly ResellerTierGrantRecord[]>;

  /** Replaces the tier's whole grant set. The caller holds the tier's lock. */
  replaceGrants(
    scope: TenantContext,
    tierId: string,
    grants: readonly ResellerTierGrantRecord[],
    now: Date,
    tx: unknown,
  ): Promise<void>;

  listTiers(scope: TenantContext): Promise<readonly ResellerTierListing[]>;

  // -- Resellers ------------------------------------------------------------------

  /** False when the customer is already a reseller. */
  register(
    scope: TenantContext,
    input: ResellerWrite & { readonly id: string; readonly customerId: string; readonly now: Date },
    tx: unknown,
  ): Promise<boolean>;

  update(
    scope: TenantContext,
    customerId: string,
    input: ResellerWrite & { readonly now: Date },
    tx: unknown,
  ): Promise<ResellerRecord | null>;

  findByCustomer(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<ResellerRecord | null>;

  findListing(scope: TenantContext, customerId: string): Promise<ResellerListing | null>;

  list(
    scope: TenantContext,
    filter: {
      readonly status?: ResellerStatus;
      readonly tierId?: string;
      readonly search?: string;
    },
    limit: number,
    cursor: ResellerCursor | null,
  ): Promise<{ readonly items: readonly ResellerListing[]; readonly next: ResellerCursor | null }>;

  // -- Purchase terms ------------------------------------------------------------

  /** Idempotent per order. True when this call wrote the row. */
  recordTerms(
    scope: TenantContext,
    input: Omit<OrderResellerTermsRecord, 'createdAt'> & { readonly now: Date },
    tx: unknown,
  ): Promise<boolean>;

  findTerms(
    scope: TenantContext,
    orderId: string,
    tx?: unknown,
  ): Promise<OrderResellerTermsRecord | null>;
}
