import type {
  LegacyCutoverApprovalKind,
  LegacyCutoverBinding,
  LegacyProductReviewState,
  LegacyReadSetName,
  TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CutoverApplyRunFacts } from '../domain/cutover-rules.js';

/**
 * Mirza migration PR6 — the cutover approval, as stored (`legacy_cutover_approvals` with its
 * revocation, if any). Fingerprints, digests, NEXA ids and times only.
 */
export interface LegacyCutoverApprovalRecord extends LegacyCutoverBinding {
  readonly id: string;
  readonly kind: LegacyCutoverApprovalKind;
  readonly priorSourceFingerprint: string | null;
  readonly synthetic: boolean;
  readonly reason: string;
  readonly approvedByAdminId: string;
  readonly approvedAt: Date;
  readonly revocation: {
    readonly revokedByAdminId: string;
    readonly revokedAt: Date;
    readonly reason: string;
  } | null;
}

export interface NewLegacyCutoverApproval extends LegacyCutoverBinding {
  readonly id: string;
  readonly kind: LegacyCutoverApprovalKind;
  readonly priorSourceFingerprint: string | null;
  readonly synthetic: boolean;
  readonly reason: string;
  readonly approvedByAdminId: string;
  readonly approvedAt: Date;
}

/** One recorded read set observation (`legacy_read_set_runs`), as an approval binds it. */
export interface LegacyCutoverReadSetRecord {
  readonly id: string;
  readonly readSet: LegacyReadSetName;
  readonly fingerprintVersion: string;
  readonly readSetFingerprint: string;
  readonly sourceFingerprint: string;
  readonly synthetic: boolean;
  readonly tableCount: number;
  readonly rowCount: bigint;
  readonly recordedAt: Date;
}

export interface LegacyCutoverApplyRunRecord extends CutoverApplyRunFacts {
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

/** The legacy product review rows, as the report's products section counts them. */
export interface LegacyCutoverProductRow {
  readonly codeProduct: string;
  readonly state: LegacyProductReviewState;
  readonly readFingerprint: string;
  readonly sourceFingerprint: string;
  readonly missingSinceReadFingerprint: string | null;
  readonly sourceConflict: string | null;
  readonly approvedProductId: string | null;
  readonly approvedFactsChecksum: string | null;
  readonly factsChecksum: string;
}

/** The latest COMPLETED invoice archive run of one source, with the archive it left. */
export interface LegacyCutoverArchiveFacts {
  readonly runId: string;
  readonly readSetFingerprint: string;
  readonly synthetic: boolean;
  readonly sourceInvoiceRows: bigint;
  readonly promotedRows: bigint;
  readonly insertedNew: bigint;
  readonly insertedRevision: bigint;
  readonly unchanged: bigint;
  readonly missingInSnapshot: bigint;
  readonly archiveInvoicesAfter: bigint;
  /** Distinct archived invoices visible now (revisions of COMPLETED runs). */
  readonly archivedInvoicesNow: bigint;
}

/**
 * The duplicate-effect counters a re-run must keep at their bound (report v2 invariant
 * RERUN_NO_DUPLICATES). Each one is read from the destination, never inferred.
 */
export interface LegacyCutoverDuplicateFacts {
  /** The most legacy debts any one customer holds (0 or 1). */
  readonly debtsPerCustomerMax: number;
  /** The most customers sharing one Telegram id (0 or 1). */
  readonly customersPerTelegramIdMax: number;
  /** The most legacy invoices mapped to one adopted service (0 or 1). */
  readonly invoicesPerAdoptedServiceMax: number;
  /** LEGACY_ADOPTION orders, and services the map says were adopted: equal, or a duplicate. */
  readonly adoptionOrders: number;
  readonly mappedAdoptedServices: number;
  /** Archive revisions whose archive checksum equals the revision before them (0). */
  readonly archiveRepeatedRevisions: number;
}

/** What `stop_sales` looks like in the destination right now (cutover gate step 1). */
export interface LegacyCutoverStopSalesFacts {
  /** ACTIVE MAINTENANCE incidents with `stop_sales` on. */
  readonly activeStopSalesIncidents: number;
  readonly activePanels: number;
  /** ACTIVE panels that are not drained: each could still sell. */
  readonly activePanelsNotDrained: number;
  readonly gateways: number;
  /** Payment gateways still ACTIVE: each could still take a payment or a top-up. */
  readonly gatewaysActive: number;
}

export interface LegacyCutoverRepository {
  insertApproval(
    scope: TenantContext,
    approval: NewLegacyCutoverApproval,
    tx: TransactionScope,
  ): Promise<LegacyCutoverApprovalRecord>;
  insertRevocation(
    scope: TenantContext,
    revocation: {
      readonly id: string;
      readonly approvalId: string;
      readonly reason: string;
      readonly revokedByAdminId: string;
      readonly revokedAt: Date;
    },
    tx: TransactionScope,
  ): Promise<void>;
  findApproval(
    scope: TenantContext,
    id: string,
    tx?: TransactionScope,
  ): Promise<LegacyCutoverApprovalRecord | null>;
  /** Every approval of the tenant for this source (and its revocation). */
  approvalsForSource(
    scope: TenantContext,
    sourceFingerprint: string,
    tx?: TransactionScope,
  ): Promise<readonly LegacyCutoverApprovalRecord[]>;
  listApprovals(
    scope: TenantContext,
    page: { readonly after?: string; readonly limit: number },
  ): Promise<readonly LegacyCutoverApprovalRecord[]>;
  /**
   * Serialises every approval write of one tenant: an approval's "an identical unrevoked
   * one exists" check and its insert are one decision, made under this lock.
   */
  lockTenantApprovals(scope: TenantContext, tx: TransactionScope): Promise<void>;
  /** The recorded read set observation (tenant, read set, fingerprint, source), if any. */
  findReadSetRun(
    scope: TenantContext,
    readSet: LegacyReadSetName,
    readSetFingerprint: string,
    sourceFingerprint: string,
    tx?: TransactionScope,
  ): Promise<LegacyCutoverReadSetRecord | null>;
  /** The latest recorded observation of a read set bound to this source, if any. */
  latestReadSetRun(
    scope: TenantContext,
    readSet: LegacyReadSetName,
    sourceFingerprint: string,
  ): Promise<LegacyCutoverReadSetRecord | null>;
  listReadSetRuns(
    scope: TenantContext,
    page: { readonly after?: string; readonly limit: number },
  ): Promise<readonly LegacyCutoverReadSetRecord[]>;
  /** Every APPLY run of the tenant. */
  applyRuns(
    scope: TenantContext,
    tx?: TransactionScope,
  ): Promise<readonly LegacyCutoverApplyRunRecord[]>;
  listApplyRuns(
    scope: TenantContext,
    page: { readonly after?: string; readonly limit: number },
  ): Promise<readonly LegacyCutoverApplyRunRecord[]>;
  productReviewRows(scope: TenantContext): Promise<readonly LegacyCutoverProductRow[]>;
  latestCompletedArchiveRun(
    scope: TenantContext,
    sourceFingerprint: string,
  ): Promise<LegacyCutoverArchiveFacts | null>;
  duplicateFacts(scope: TenantContext): Promise<LegacyCutoverDuplicateFacts>;
  /** In `tx` when given: a gated import samples it inside its start and finish (aud6 F2). */
  stopSalesFacts(scope: TenantContext, tx?: TransactionScope): Promise<LegacyCutoverStopSalesFacts>;
  /**
   * What the run's finish audit row recorded it left for a person (`applyOutcome`), or null
   * when the run has no such row (not finished, or finished by a release before PR6).
   */
  applyOutcome(scope: TenantContext, runId: string): Promise<LegacyCutoverApplyOutcome | null>;
  /** The CUTOVER approval id the run's start audit row recorded, or null (an ungated run). */
  runCutoverApprovalId(scope: TenantContext, runId: string): Promise<string | null>;
}

/** An APPLY run's recorded leftovers (PR5's approval counters and every attention count). */
export interface LegacyCutoverApplyOutcome {
  readonly serviceApprovals: Readonly<Record<string, number>>;
  readonly attention: Readonly<Record<string, number>>;
}
