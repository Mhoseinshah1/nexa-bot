import type {
  LegacyServiceEvidence,
  LegacyServiceOutcome,
  LegacyServiceReviewState,
  TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * Mirza migration PR5 — one `legacy_service_candidates` row: a live legacy invoice the
 * importer considered as a service, its ONE outcome, the evidence behind it, and the
 * operator's review. Codes, NEXA ids, counts and hashes only.
 */
export interface LegacyServiceCandidateRecord {
  readonly id: string;
  readonly invoiceKey: string;
  readonly runId: string;
  readonly sourceFingerprint: string;
  readonly synthetic: boolean;
  readonly invoiceChecksum: string;
  readonly outcome: LegacyServiceOutcome;
  readonly blocker: string | null;
  readonly evidence: LegacyServiceEvidence;
  readonly evidenceHash: string;
  readonly panelCode: string | null;
  readonly productCode: string | null;
  readonly archiveId: string | null;
  readonly serviceId: string | null;
  readonly reviewState: LegacyServiceReviewState;
  readonly approvedPanelId: string | null;
  readonly approvedChecksum: string | null;
  readonly approvedOutcome: LegacyServiceOutcome | null;
  readonly lastApprovalRefusal: string | null;
  readonly decisionReason: string | null;
  readonly decidedByAdminId: string | null;
  readonly decidedAt: Date | null;
  readonly observedAt: Date | null;
  readonly version: number;
  readonly firstDecidedAt: Date;
  readonly updatedAt: Date;
}

/** What one import run decided about one live invoice: the facts the importer owns. */
export interface LegacyServiceOutcomeWrite {
  readonly id: string;
  readonly invoiceKey: string;
  readonly runId: string;
  readonly sourceFingerprint: string;
  readonly synthetic: boolean;
  readonly invoiceChecksum: string;
  readonly outcome: LegacyServiceOutcome;
  readonly blocker: string | null;
  readonly evidence: LegacyServiceEvidence;
  readonly evidenceHash: string;
  readonly panelCode: string | null;
  readonly productCode: string | null;
  readonly serviceId: string | null;
  readonly observedAt: Date | null;
  readonly now: Date;
}

/** The review columns a transition sets (and the importer's outcome on settle). */
export interface LegacyServiceReviewChange {
  readonly reviewState: LegacyServiceReviewState;
  readonly approvedPanelId?: string | null;
  readonly approvedChecksum?: string | null;
  readonly approvedOutcome?: LegacyServiceOutcome | null;
  readonly lastApprovalRefusal?: string | null;
  readonly decisionReason?: string | null;
  readonly decidedByAdminId?: string | null;
  readonly decidedAt?: Date | null;
  /** Set only by the importer settling an executed approval. */
  readonly outcome?: LegacyServiceOutcome;
  readonly blocker?: string | null;
  readonly serviceId?: string | null;
  readonly updatedAt: Date;
}

export interface LegacyServiceCandidateFilter {
  readonly outcome?: LegacyServiceOutcome;
  readonly reviewState?: LegacyServiceReviewState;
  readonly panelCode?: string;
  readonly productCode?: string;
  /** The invoice key or its beginning, verbatim (case-sensitive). */
  readonly invoiceIdPrefix?: string;
  /** Keyset: ids strictly after this one (uuid v7: first-decided order). */
  readonly after?: string;
  readonly limit: number;
}

/** The non-personal fields of an invoice archive revision (PR3), for the detail view. */
export interface LegacyServiceArchiveSummary {
  readonly id: string;
  readonly revision: number;
  readonly classification: string;
  readonly status: string | null;
  readonly panelCode: string | null;
  readonly productCode: string | null;
  readonly productName: string | null;
  readonly priceRaw: string | null;
  readonly priceMinor: bigint | null;
  readonly soldAt: Date | null;
  readonly sourceFingerprint: string;
}

/**
 * The importer's side (`maintenance.run`, migration-only): read the candidates of a batch of
 * invoices, record outcomes, and claim and settle the approvals it executes.
 */
export interface LegacyServiceCandidateStore {
  findByInvoiceKeys(
    scope: TenantContext,
    keys: readonly string[],
    tx?: TransactionScope,
    options?: { readonly forUpdate?: boolean },
  ): Promise<readonly LegacyServiceCandidateRecord[]>;
  /** Every candidate with an approval waiting or claimed, in id order. */
  listApprovals(scope: TenantContext): Promise<readonly LegacyServiceCandidateRecord[]>;
  /** The latest VISIBLE archive revision id of each key (its run COMPLETED). */
  latestArchiveIds(
    scope: TenantContext,
    keys: readonly string[],
    tx: TransactionScope,
  ): Promise<ReadonlyMap<string, string>>;
  insert(
    scope: TenantContext,
    row: LegacyServiceOutcomeWrite & {
      readonly archiveId: string | null;
      readonly reviewState: LegacyServiceReviewState;
    },
    tx: TransactionScope,
  ): Promise<LegacyServiceCandidateRecord>;
  /** The importer's re-decision: a conditional UPDATE at `version` (null when it moved). */
  updateOutcome(
    scope: TenantContext,
    id: string,
    version: number,
    change: {
      readonly runId: string;
      readonly sourceFingerprint: string;
      readonly invoiceChecksum: string;
      readonly outcome: LegacyServiceOutcome;
      readonly blocker: string | null;
      readonly evidence: LegacyServiceEvidence;
      readonly evidenceHash: string;
      readonly panelCode: string | null;
      readonly productCode: string | null;
      readonly archiveId: string | null;
      readonly serviceId: string | null;
      readonly reviewState: LegacyServiceReviewState;
      readonly observedAt: Date | null;
      readonly bump: boolean;
      readonly updatedAt: Date;
    },
    tx: TransactionScope,
  ): Promise<LegacyServiceCandidateRecord | null>;
  /**
   * The one review write (the operator's decisions; the importer's claim and settle of an
   * approval): a conditional UPDATE naming the `from` states AND the version, which advances
   * by one. Null when the row is not in `from` at `version`.
   */
  transition(
    scope: TenantContext,
    id: string,
    guard: { readonly from: readonly LegacyServiceReviewState[]; readonly version: number },
    change: LegacyServiceReviewChange,
    tx: TransactionScope,
  ): Promise<LegacyServiceCandidateRecord | null>;
}

export interface LegacyServiceCandidateRepository extends LegacyServiceCandidateStore {
  findById(
    scope: TenantContext,
    id: string,
    tx?: TransactionScope,
    options?: { readonly forUpdate?: boolean },
  ): Promise<LegacyServiceCandidateRecord | null>;
  list(
    scope: TenantContext,
    filter: LegacyServiceCandidateFilter,
  ): Promise<readonly LegacyServiceCandidateRecord[]>;
  /** Counts by outcome and by review state (absent = zero). */
  aggregate(scope: TenantContext): Promise<{
    readonly byOutcome: Readonly<Partial<Record<LegacyServiceOutcome, number>>>;
    readonly byReviewState: Readonly<Partial<Record<LegacyServiceReviewState, number>>>;
  }>;
  archiveSummary(
    scope: TenantContext,
    archiveId: string,
  ): Promise<LegacyServiceArchiveSummary | null>;
  /**
   * The invoice's transaction-scoped advisory lock — the one P6's adoption takes first — so
   * a decision on the candidate and an adoption of the invoice are serialised.
   */
  lockInvoice(scope: TenantContext, invoiceKey: string, tx: TransactionScope): Promise<void>;
  /** The importer's map row for the invoice, codes only. */
  importOutcome(
    scope: TenantContext,
    invoiceKey: string,
    tx?: TransactionScope,
  ): Promise<{
    readonly status: string;
    readonly reasonCode: string | null;
    readonly reviewState: string | null;
  } | null>;
}
