import type {
  LegacyInvoiceArchiveClass,
  LegacyInvoiceArchiveRunFailure,
  LegacyInvoiceArchiveRunState,
  LegacyInvoiceParseNote,
  LegacyInvoiceProductRef,
  LegacyInvoiceRevisionReason,
  TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { LatestRevision, LegacyInvoiceRawRow } from '../domain/invoice-archive-row.js';

/**
 * Mirza migration PR3 — what the legacy invoice archive needs from PostgreSQL. Every method
 * is tenant-scoped; every write takes the caller's transaction. Nothing here touches an
 * order, a payment, a wallet entry, a service or a report.
 */

export interface LegacyInvoiceArchiveRun {
  readonly id: string;
  readonly tenantId: string;
  readonly state: LegacyInvoiceArchiveRunState;
  readonly failureCode: LegacyInvoiceArchiveRunFailure | null;
  readonly readSetVersion: number;
  readonly readSetFingerprint: string;
  readonly sourceFingerprint: string;
  readonly sourceSchemaHash: string;
  readonly sourceEngine: string;
  readonly synthetic: boolean;
  readonly sourceInvoiceRows: bigint | null;
  readonly sourceUserRows: bigint | null;
  readonly sourceProductRows: bigint | null;
  readonly promotedThrough: string | null;
  readonly promotedRows: bigint;
  readonly insertedNew: bigint;
  readonly insertedRevision: bigint;
  readonly unchanged: bigint;
  readonly missingInSnapshot: bigint | null;
  readonly archiveInvoicesAfter: bigint | null;
  readonly codeVersion: string | null;
  readonly startedAt: Date;
  readonly verifiedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly updatedAt: Date;
}

export interface NewLegacyInvoiceArchiveRun {
  readonly id: string;
  readonly readSetVersion: number;
  readonly readSetFingerprint: string;
  readonly sourceFingerprint: string;
  readonly sourceSchemaHash: string;
  readonly sourceEngine: string;
  readonly synthetic: boolean;
  readonly codeVersion: string | null;
  readonly now: Date;
}

/** A conditional run change: applied only from the named states. */
export type LegacyInvoiceArchiveRunChange =
  | {
      readonly state: 'VERIFIED';
      readonly sourceInvoiceRows: bigint;
      readonly sourceUserRows: bigint;
      readonly sourceProductRows: bigint;
      readonly now: Date;
    }
  | {
      readonly state: 'COMPLETED';
      readonly missingInSnapshot: bigint;
      readonly archiveInvoicesAfter: bigint;
      readonly now: Date;
    }
  | {
      readonly state: 'FAILED';
      readonly failureCode: LegacyInvoiceArchiveRunFailure;
      readonly now: Date;
    };

/** One promoted batch: the new cursor and what the batch added to each counter. */
export interface LegacyInvoiceArchivePromotionStep {
  readonly expectedThrough: string | null;
  readonly through: string;
  readonly promoted: bigint;
  readonly insertedNew: bigint;
  readonly insertedRevision: bigint;
  readonly unchanged: bigint;
  readonly now: Date;
}

export interface StagedLegacyInvoice {
  readonly invoiceKey: string;
  readonly cells: LegacyInvoiceRawRow;
  readonly rowChecksum: string;
}

/** One revision as the archive writes it. */
export interface NewLegacyInvoiceArchiveRow {
  readonly id: string;
  readonly runId: string;
  readonly invoiceKey: string;
  readonly revision: number;
  readonly revisionReason: LegacyInvoiceRevisionReason;
  readonly keyShapeEvidenced: boolean;
  readonly rawRow: LegacyInvoiceRawRow;
  readonly rowChecksum: string;
  readonly archiveChecksum: string;
  readonly classification: LegacyInvoiceArchiveClass;
  readonly live: boolean;
  readonly status: string | null;
  readonly isTest: boolean | null;
  readonly legacyUserId: string | null;
  readonly ownerPresent: boolean;
  readonly username: string | null;
  readonly panelCode: string | null;
  readonly productCode: string | null;
  readonly productRef: LegacyInvoiceProductRef;
  readonly productName: string | null;
  readonly priceRaw: string | null;
  readonly priceMinor: bigint | null;
  readonly priceCurrency: string | null;
  readonly priceNote: LegacyInvoiceParseNote | null;
  readonly soldAtRaw: string | null;
  readonly soldAtEpochSeconds: number | null;
  readonly soldAtNote: LegacyInvoiceParseNote | null;
  readonly readSetFingerprint: string;
  readonly sourceFingerprint: string;
  readonly normalizationVersion: string;
  readonly archivedAt: Date;
}

/** One stored revision, as the reads return it. */
export interface LegacyInvoiceArchiveRecord extends Omit<
  NewLegacyInvoiceArchiveRow,
  'soldAtEpochSeconds'
> {
  readonly soldAt: Date | null;
}

export interface LegacyInvoiceArchiveRevisionRecord {
  readonly id: string;
  readonly revision: number;
  readonly revisionReason: LegacyInvoiceRevisionReason;
  readonly classification: LegacyInvoiceArchiveClass;
  readonly rowChecksum: string;
  readonly sourceFingerprint: string;
  readonly readSetFingerprint: string;
  readonly runId: string;
  readonly archivedAt: Date;
  readonly visible: boolean;
}

/** The archive's filters. Every one is an exact match or a prefix; all are ANDed. */
export interface LegacyInvoiceArchiveFilter {
  readonly invoiceIdPrefix?: string;
  readonly legacyUserId?: string;
  readonly usernamePrefix?: string;
  readonly status?: string;
  readonly panelCode?: string;
  readonly productCode?: string;
  readonly classification?: LegacyInvoiceArchiveClass;
  readonly isTest?: boolean;
}

export interface LegacyInvoiceImportOutcome {
  readonly status: string;
  readonly reasonCode: string | null;
  readonly reviewState: string | null;
  readonly entityType: string | null;
}

export interface LegacyInvoiceArchiveRepository {
  // --- runs ----------------------------------------------------------------------------
  /** The tenant's open run (STAGING or VERIFIED), if any. */
  openRun(scope: TenantContext, tx?: TransactionScope): Promise<LegacyInvoiceArchiveRun | null>;
  findRun(
    scope: TenantContext,
    id: string,
    tx?: TransactionScope,
    options?: { readonly forUpdate?: boolean },
  ): Promise<LegacyInvoiceArchiveRun | null>;
  /** Inserts a STAGING run; null when another run is open (the partial unique index). */
  insertRun(
    scope: TenantContext,
    run: NewLegacyInvoiceArchiveRun,
    tx: TransactionScope,
  ): Promise<LegacyInvoiceArchiveRun | null>;
  /** A conditional UPDATE: applied only when the run is in one of `from`. */
  transitionRun(
    scope: TenantContext,
    id: string,
    from: readonly LegacyInvoiceArchiveRunState[],
    change: LegacyInvoiceArchiveRunChange,
    tx: TransactionScope,
  ): Promise<LegacyInvoiceArchiveRun | null>;
  /** Advances the promotion cursor; only from VERIFIED and from `expectedThrough`. */
  advancePromotion(
    scope: TenantContext,
    id: string,
    step: LegacyInvoiceArchivePromotionStep,
    tx: TransactionScope,
  ): Promise<LegacyInvoiceArchiveRun | null>;
  listRuns(scope: TenantContext, limit: number): Promise<readonly LegacyInvoiceArchiveRun[]>;

  // --- staging -------------------------------------------------------------------------
  /** Inserts invoice rows; returns how many were new (a duplicate key inserts nothing). */
  stageInvoices(
    scope: TenantContext,
    runId: string,
    rows: readonly StagedLegacyInvoice[],
    tx: TransactionScope,
  ): Promise<number>;
  /** Inserts `user` ids or `product` keys with their lookup; returns how many were new. */
  stageKeys(
    scope: TenantContext,
    runId: string,
    table: 'user' | 'product',
    rows: readonly { readonly key: string; readonly lookup: string | null }[],
    tx: TransactionScope,
  ): Promise<number>;
  stagedCounts(
    scope: TenantContext,
    runId: string,
    tx: TransactionScope,
  ): Promise<{ readonly invoice: bigint; readonly user: bigint; readonly product: bigint }>;
  /** Staged invoices after the cursor, in the staging key's order. */
  stagedInvoicesAfter(
    scope: TenantContext,
    runId: string,
    after: string | null,
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly StagedLegacyInvoice[]>;
  /** Which of these legacy user ids the run's snapshot has. */
  presentUsers(
    scope: TenantContext,
    runId: string,
    ids: readonly string[],
    tx: TransactionScope,
  ): Promise<ReadonlySet<string>>;
  /** Which of these trimmed product codes the run's snapshot has. */
  presentProductCodes(
    scope: TenantContext,
    runId: string,
    codes: readonly string[],
    tx: TransactionScope,
  ): Promise<ReadonlySet<string>>;
  deleteStaging(scope: TenantContext, runId: string, tx: TransactionScope): Promise<number>;

  // --- archive -------------------------------------------------------------------------
  /** The highest revision of each key, whatever its run's state. */
  latestRevisions(
    scope: TenantContext,
    keys: readonly string[],
    tx: TransactionScope,
  ): Promise<ReadonlyMap<string, LatestRevision>>;
  insertRevisions(
    scope: TenantContext,
    rows: readonly NewLegacyInvoiceArchiveRow[],
    tx: TransactionScope,
  ): Promise<void>;
  /** Distinct archived invoice keys the run's staged snapshot does not have. */
  countMissingFromRun(scope: TenantContext, runId: string, tx: TransactionScope): Promise<bigint>;
  /** Distinct archived invoice keys, every revision's run included. */
  countArchivedInvoices(scope: TenantContext, tx: TransactionScope): Promise<bigint>;

  // --- reads (visible = the revision's run is COMPLETED) --------------------------------
  /** The latest VISIBLE revision of each matching invoice, keyset by invoice key. */
  list(
    scope: TenantContext,
    filter: LegacyInvoiceArchiveFilter,
    after: string | null,
    limit: number,
  ): Promise<readonly LegacyInvoiceArchiveRecord[]>;
  /** A visible revision by its row id. */
  findVisible(scope: TenantContext, id: string): Promise<LegacyInvoiceArchiveRecord | null>;
  revisionsOf(
    scope: TenantContext,
    invoiceKey: string,
  ): Promise<readonly LegacyInvoiceArchiveRevisionRecord[]>;
  /** The importer's map row for this invoice key, codes only; null when none. */
  importOutcome(
    scope: TenantContext,
    invoiceKey: string,
  ): Promise<LegacyInvoiceImportOutcome | null>;
  /** Aggregates of the latest visible revisions: counts only. */
  summary(scope: TenantContext): Promise<{
    readonly invoices: number;
    readonly revisions: number;
    readonly classes: Readonly<Partial<Record<LegacyInvoiceArchiveClass, number>>>;
  }>;
}
