import type {
  CurrencyCode,
  CustomServiceRuleDimension,
  CustomServiceRuleLevel,
  Money,
  OrderId,
  TenantContext,
} from '@nexa/contracts';
import type { CustomServiceRule } from '../domain/custom-service-pricing.js';

/**
 * Package D's persistence ports (`docs/package-d-custom-service-audit.md`). Every method is
 * tenant-scoped; every write takes the caller's transaction.
 */

export interface CustomServiceRuleRecord extends CustomServiceRule {
  readonly label: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CustomServiceRuleWrite {
  readonly dimension: CustomServiceRuleDimension;
  readonly label: string | null;
  readonly minUnits: bigint;
  readonly maxUnits: bigint;
  readonly unitPrice: Money;
  readonly customerId: string | null;
  readonly resellerTierId: string | null;
  readonly panelId: string | null;
  readonly enabled: boolean;
}

/** The most rules one tenant may hold: a bound on a list every custom request reads whole. */
export const CUSTOM_SERVICE_MAX_RULES = 500;

export interface CustomServiceRuleRepository {
  /** Every rule of the tenant, bounded by `CUSTOM_SERVICE_MAX_RULES`. */
  list(scope: TenantContext, tx?: unknown): Promise<readonly CustomServiceRuleRecord[]>;
  findById(scope: TenantContext, id: string, tx?: unknown): Promise<CustomServiceRuleRecord | null>;
  /**
   * The tenant's rules lock, EXCLUSIVE: every operator write takes it before it reads the
   * rules it checks overlap against, so two concurrent saves cannot both pass.
   */
  lockForWrite(scope: TenantContext, tx: unknown): Promise<void>;
  /**
   * The same lock, SHARED: a draft and a confirmation take it before they select, so no
   * rule write can commit between the selection and the transaction that relies on it.
   */
  lockForRead(scope: TenantContext, tx: unknown): Promise<void>;
  insert(
    scope: TenantContext,
    input: { readonly id: string; readonly write: CustomServiceRuleWrite; readonly now: Date },
    tx: unknown,
  ): Promise<CustomServiceRuleRecord>;
  update(
    scope: TenantContext,
    id: string,
    write: CustomServiceRuleWrite,
    now: Date,
    tx: unknown,
  ): Promise<CustomServiceRuleRecord | null>;
  delete(scope: TenantContext, id: string, tx: unknown): Promise<boolean>;
}

export interface CustomServiceLocationRecord {
  readonly panelId: string;
  readonly panelName: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CustomServiceLocationRepository {
  list(scope: TenantContext, tx?: unknown): Promise<readonly CustomServiceLocationRecord[]>;
  /** One location, read FOR SHARE inside a transaction, so an edit waits for the reader. */
  find(
    scope: TenantContext,
    panelId: string,
    tx?: unknown,
  ): Promise<CustomServiceLocationRecord | null>;
  upsert(
    scope: TenantContext,
    input: {
      readonly panelId: string;
      readonly label: string;
      readonly enabled: boolean;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<{ readonly record: CustomServiceLocationRecord; readonly created: boolean }>;
  delete(scope: TenantContext, panelId: string, tx: unknown): Promise<boolean>;
}

/** What a custom order was priced by (brief D6). Written once; a trigger refuses a change. */
export interface OrderCustomServiceTerms {
  readonly orderId: OrderId;
  readonly panelId: string;
  readonly locationLabel: string;
  readonly volumeUnits: bigint;
  readonly trafficBytes: bigint;
  readonly durationDays: number;
  readonly volumeRuleId: string;
  readonly volumeRuleLevel: CustomServiceRuleLevel;
  readonly pricePerGb: Money;
  readonly volumePrice: Money;
  readonly timeRuleId: string;
  readonly timeRuleLevel: CustomServiceRuleLevel;
  readonly pricePerDay: Money;
  readonly timePrice: Money;
  readonly basePrice: Money;
  readonly currency: CurrencyCode;
}

export interface OrderCustomServiceTermsRepository {
  insert(
    scope: TenantContext,
    terms: OrderCustomServiceTerms,
    now: Date,
    tx: unknown,
  ): Promise<void>;
  findByOrder(
    scope: TenantContext,
    orderId: string,
    tx?: unknown,
  ): Promise<OrderCustomServiceTerms | null>;
}
