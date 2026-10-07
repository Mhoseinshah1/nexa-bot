import type {
  LegacyProductParseNote,
  LegacyProductParsedField,
  LegacyProductReviewState,
  LegacyProductSourceConflict,
  TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/** One `legacy_product_reviews` row. */
export interface LegacyProductReviewRecord {
  readonly id: string;
  readonly codeProduct: string;
  readonly legacyProductId: string;
  readonly facts: readonly Readonly<Record<string, string | null>>[];
  readonly factsChecksum: string;
  readonly sourceConflict: LegacyProductSourceConflict | null;
  readonly title: string | null;
  readonly trafficBytes: bigint | null;
  readonly durationDays: number | null;
  readonly historicalPriceRaw: string | null;
  readonly historicalPriceMinor: bigint | null;
  readonly historicalPriceCurrency: 'IRT' | null;
  readonly parseNotes: Partial<Record<LegacyProductParsedField, LegacyProductParseNote>>;
  readonly liveInvoiceCount: number;
  readonly state: LegacyProductReviewState;
  readonly priorState: LegacyProductReviewState | null;
  readonly approvedProductId: string | null;
  readonly approvedFactsChecksum: string | null;
  readonly decisionReason: string | null;
  readonly decidedByAdminId: string | null;
  readonly decidedAt: Date | null;
  readonly readFingerprint: string;
  readonly sourceFingerprint: string;
  readonly missingSinceReadFingerprint: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A row with the title of the product it is approved to, for the list. */
export interface LegacyProductReviewListItem {
  readonly review: LegacyProductReviewRecord;
  readonly approvedProductTitle: string | null;
}

/** The source-derived columns a read writes. */
export type LegacyProductReviewSourceFields = Pick<
  LegacyProductReviewRecord,
  | 'legacyProductId'
  | 'facts'
  | 'factsChecksum'
  | 'sourceConflict'
  | 'title'
  | 'trafficBytes'
  | 'durationDays'
  | 'historicalPriceRaw'
  | 'historicalPriceMinor'
  | 'historicalPriceCurrency'
  | 'parseNotes'
  | 'liveInvoiceCount'
  | 'readFingerprint'
  | 'sourceFingerprint'
>;

/** The columns a conditional UPDATE may set. */
export type LegacyProductReviewChange = Partial<
  Omit<LegacyProductReviewRecord, 'id' | 'codeProduct' | 'version' | 'createdAt' | 'updatedAt'>
> & { readonly updatedAt: Date };

/**
 * The guard of a conditional UPDATE: the row must be in one of `from`, at `version`, and
 * (when given) hold `factsChecksum`. There is no unconditional setter.
 */
export interface LegacyProductReviewGuard {
  readonly from: readonly LegacyProductReviewState[];
  readonly version: number;
  readonly factsChecksum?: string;
}

export interface LegacyProductReviewListFilter {
  readonly states?: readonly LegacyProductReviewState[];
  readonly q?: string;
  /** Keyset: codes strictly after this one (byte order of the column's collation). */
  readonly after?: string;
  readonly limit: number;
}

export interface LegacyProductReviewRepository {
  findByCode(
    scope: TenantContext,
    code: string,
    tx: TransactionScope,
    options?: { readonly forUpdate?: boolean },
  ): Promise<LegacyProductReviewRecord | null>;
  findById(
    scope: TenantContext,
    id: string,
    tx?: TransactionScope,
    options?: { readonly forUpdate?: boolean },
  ): Promise<LegacyProductReviewRecord | null>;
  /** Insert-or-nothing on (tenant, code): null when another writer created it first. */
  insert(
    scope: TenantContext,
    row: Omit<LegacyProductReviewRecord, 'version'>,
    tx: TransactionScope,
  ): Promise<LegacyProductReviewRecord | null>;
  /** Conditional UPDATE: null when the guard does not hold (the row moved). Bumps the version. */
  update(
    scope: TenantContext,
    id: string,
    guard: LegacyProductReviewGuard,
    change: LegacyProductReviewChange,
    tx: TransactionScope,
  ): Promise<LegacyProductReviewRecord | null>;
  /**
   * Rows a completed read did not see and has not yet acknowledged: last read by another read,
   * and either never marked absent or marked by an EARLIER read.
   */
  absentFrom(
    scope: TenantContext,
    readFingerprint: string,
    limit: number,
    tx?: TransactionScope,
  ): Promise<readonly LegacyProductReviewRecord[]>;
  list(
    scope: TenantContext,
    filter: LegacyProductReviewListFilter,
  ): Promise<readonly LegacyProductReviewListItem[]>;
  /** One row with its approved product's title. */
  findItem(scope: TenantContext, id: string): Promise<LegacyProductReviewListItem | null>;
  /** Every row of the tenant, by code. The legacy catalogue is small; the export reads it whole. */
  all(scope: TenantContext): Promise<readonly LegacyProductReviewRecord[]>;
  /** Whether the product exists in this tenant (approve-existing). */
  productExists(scope: TenantContext, productId: string, tx: TransactionScope): Promise<boolean>;
}
