import type {
  CurrencyCode,
  Money,
  OrderPurpose,
  OrderState,
  ResellerEntitlementDimension,
  ResellerGrantKind,
  ResellerMinimumNoticeKind,
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
  /** Round N R2: the tier's monthly minimum sales; null (or zero) for none. */
  readonly monthlyMinimum: Money | null;
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
  /**
   * Round N R2: the reseller's own monthly minimum. Null inherits the tier's; a zero amount
   * is an explicit "no minimum for this reseller".
   */
  readonly monthlyMinimum: Money | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Round N R1: a reseller's own entitlement override — the dimensions it overrides and its
 * grants of them. Empty `dimensions` is "no override": the tier's grants apply unchanged.
 */
export interface ResellerOverrideRecord {
  readonly dimensions: readonly ResellerEntitlementDimension[];
  readonly grants: readonly ResellerTierGrantRecord[];
}

/** Round N R2: one monthly-minimum notice, the subject of its notification. */
export interface ResellerMinimumNoticeWrite {
  readonly id: string;
  readonly customerId: string;
  readonly kind: ResellerMinimumNoticeKind;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly minimum: Money;
  readonly achieved: bigint;
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

/**
 * One row of a reseller's purchase history (WP14 D2): the snapshot as confirmation wrote
 * it, beside the order's CURRENT state and purpose. The margin is deliberately not here
 * (`docs/wp14-reseller-phase2-audit.md` §3).
 */
export interface ResellerPurchaseRecord {
  readonly orderId: string;
  readonly orderState: OrderState;
  readonly purpose: OrderPurpose;
  readonly tierName: string;
  readonly layer: ResellerPriceLayer;
  readonly percent: number | null;
  readonly listAmount: bigint;
  readonly costAmount: bigint;
  readonly promotionAmount: bigint;
  readonly saleAmount: bigint;
  readonly currency: CurrencyCode;
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

  /**
   * `SELECT … FOR SHARE` on the tier row: what a commercial transaction reads the tier
   * under, so a writer holding `lockTier` waits for it to commit, and it waits for one.
   */
  shareTier(scope: TenantContext, id: string, tx: unknown): Promise<ResellerTierRecord | null>;

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

  /**
   * `SELECT … FOR UPDATE` on the reseller row: what an operator's update reads its
   * before-image through, so two concurrent updates serialise and the second audits the
   * first's after-image as its before rather than the row both of them started from.
   */
  lockByCustomer(
    scope: TenantContext,
    customerId: string,
    tx: unknown,
  ): Promise<ResellerRecord | null>;

  /** `SELECT … FOR SHARE` on the reseller row; an operator's update waits for it. */
  shareByCustomer(
    scope: TenantContext,
    customerId: string,
    tx: unknown,
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

  // -- Round N: overrides and the monthly minimum ------------------------------------

  /** The reseller's entitlement override; empty dimensions when there is none. */
  overridesOf(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<ResellerOverrideRecord>;

  /** Replaces the whole override set. The caller holds the reseller row's lock. */
  replaceOverrides(
    scope: TenantContext,
    customerId: string,
    override: ResellerOverrideRecord,
    now: Date,
    tx: unknown,
  ): Promise<void>;

  /** Sets a tier's minimum (null for none). Null when no tier has this id. */
  setTierMinimum(
    scope: TenantContext,
    tierId: string,
    minimum: Money | null,
    now: Date,
    tx: unknown,
  ): Promise<ResellerTierRecord | null>;

  /** Sets a reseller's own minimum (null inherits). Null when the customer is no reseller. */
  setMinimum(
    scope: TenantContext,
    customerId: string,
    minimum: Money | null,
    now: Date,
    tx: unknown,
  ): Promise<ResellerRecord | null>;

  /**
   * Every reseller of the tenant with its tier, oldest first, at most `limit` — the monthly
   * progress read and the notice sweep. `activeOnly` keeps ACTIVE resellers only.
   */
  listAll(
    scope: TenantContext,
    filter: { readonly activeOnly: boolean },
    limit: number,
    tx?: unknown,
  ): Promise<readonly ResellerListing[]>;

  /** The notices already raised for a month, as `${customerId}:${kind}`. */
  noticesIn(
    scope: TenantContext,
    periodStart: Date,
    tx: unknown,
  ): Promise<ReadonlySet<string>>;

  /**
   * Records one notice, or `false` when this (reseller, kind, month) already has one — the
   * unique key is the arbiter between replicas.
   */
  raiseNotice(
    scope: TenantContext,
    notice: ResellerMinimumNoticeWrite,
    now: Date,
    tx: unknown,
  ): Promise<boolean>;

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

  /** A reseller's purchase snapshots, newest first, keyset on `(created_at, order_id)`. */
  listPurchases(
    scope: TenantContext,
    resellerCustomerId: string,
    limit: number,
    cursor: ResellerCursor | null,
  ): Promise<{
    readonly items: readonly ResellerPurchaseRecord[];
    readonly next: ResellerCursor | null;
  }>;
}
