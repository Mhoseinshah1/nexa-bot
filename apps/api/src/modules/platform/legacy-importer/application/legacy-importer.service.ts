import {
  COMMERCE_ERROR_CODES,
  LEGACY_IMPORT_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  errors,
  isNexaError,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type CurrencyCode,
  type IdGenerator,
  type LegacyImportMapStatus,
  isLegacyImportKey,
  LEGACY_SERVICE_OUTCOMES,
  LEGACY_SERVICE_REVIEW_AUDIT_ACTIONS,
  type LegacyReadSetName,
  type LegacyServiceApprovalRefusal,
  type LegacyServiceOutcome,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../access/application/authorized-mutation.js';
import type { OutboxWriter } from '../../eventing/infrastructure/outbox-writer.js';
import type { SessionRepository } from '../../identity/application/ports.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  LegacyImportMapRecord,
  LegacyImportRepository,
  LegacyImportRunRecord,
} from '../../legacy-import/application/legacy-import-ports.js';
import {
  buildUsersWalletsSection,
  type UsersWalletsSection,
} from './users-wallets-reconciliation.js';
import {
  isReviewClosedToRerun,
  resumeDecision,
} from '../../legacy-import/application/legacy-import-ports.js';
import type { MigrationOpeningBalanceService } from '../../../commerce/wallet/application/migration-opening-balance.service.js';
import type { LegacyTrialEligibilityService } from '../../../commerce/trials/application/legacy-trial-eligibility.service.js';
import type { LegacyProductService } from '../../../commerce/catalog/application/legacy-product.service.js';
import type { LegacyProductReviewService } from '../../../commerce/legacy-product-review/application/legacy-product-review.service.js';
import {
  readLegacyProducts,
  type ProductsReadInput,
  type ProductsReadOutcome,
} from './products-ingest.js';
import {
  readLegacyInvoiceArchive,
  type InvoiceArchiveIngest,
  type InvoicesReadInput,
  type InvoicesReadOutcome,
} from './invoice-archive-ingest.js';
import { legacyProfileUsername, type ServiceCandidateCategory } from './decisions.js';
import { crossCheckEvidence, type LegacyEvidence } from './evidence-runner.js';
import {
  PanelMappingRefused,
  panelMappingCompleteness,
  type PanelMappingCompleteness,
  validatePanelMappingAgainstTenant,
  validateProductMappingAgainstTenant,
  type PanelMapping,
} from './panel-mapping.js';
import { decideAllServices, inventoryIndexes, planLegacyImport, type LegacyPlan } from './plan.js';
import type {
  LegacyAdoptionPort,
  LegacyCustomerWriter,
  LegacyImporterDestination,
  LegacyInventoryPort,
  LegacyImportProcessLease,
  LegacyImportProcessLock,
  LegacyInventoryRead,
  LegacyReadSetRun,
  LegacyReadSetRunRepository,
  LegacyRunInputs,
  LegacyRunInputsRepository,
  RecordedDebt,
} from './ports.js';
import { buildFinalReport } from './final-report.js';
import { buildFinalReportV2 } from './final-report-v2.js';
import type { LegacyInventory } from './legacy-inventory.js';
import { decideEvidenceClass, type EvidenceClass } from './production-guard.js';
import { LEGACY_REPORT_FORMAT, type LegacyImportReport, type LegacyReportMode } from './report.js';
import { sha256Hex, type LegacySnapshot } from './source-snapshot.js';
import { productMapAgainstReview, productMapRefusalMessage } from './product-map-review.js';
import {
  approvalGate,
  buildServiceOutcomesSection,
  candidateEvidence,
  candidateOutcome,
  claimsByName,
  observedAtFor,
  recordableCode,
  recordableKey,
  type ApprovalGate,
  type EligibleResult,
  type ServiceOutcomesSection,
} from './service-outcomes.js';
import type { ServiceReviewInputs } from './plan.js';
import type {
  LegacyServiceCandidateRecord,
  LegacyServiceCandidateStore,
} from '../../legacy-service-review/application/ports.js';
import {
  evidenceHash,
  initialReviewState,
  isAdoptedOutcome,
  isMaterialChange,
  reviewStateAfterRun,
} from '../../legacy-service-review/domain/candidate-rules.js';
import type { LegacyCutoverService } from '../../legacy-cutover/application/legacy-cutover.service.js';
import {
  LegacyCutoverRefused,
  type CutoverDecision,
  type CutoverExpectation,
} from '../../legacy-cutover/domain/cutover-rules.js';
import { USER_STATUS_READ_SET } from './read-set.js';

/** The `user-status` read set's recorded name (OQ-LWD-07). */
const USER_STATUS_READ_SET_NAME: LegacyReadSetName = 'user-status';

/**
 * Migration P7 — the legacy importer (`docs/legacy-migration/importer.md`).
 *
 * Six modes over one snapshot of the legacy source:
 *
 * - `audit` — reads the source, NEXA and the provider (read-only inventory) and reports
 *   the plan and the SQL evidence. Writes NOTHING, not even a run row.
 * - `dryRun` — the complete decision logic, counted on a `DRY_RUN` run row
 *   (`recordDryRunDecision`). No business write.
 * - `apply` — `import` (a new `APPLY` run) and `resume` (the RUNNING one, same source
 *   fingerprint, same panel mapping). Phases in the program's order: customers → opening
 *   balances → trial state → products → P6 adoption → summary. Each phase writes through
 *   the existing service that owns its rows, every one idempotent by a key derived from
 *   the legacy identity, so a resume re-walks every phase and duplicates nothing.
 * - `reconcile` — the source against NEXA against the provider, with the wallet equation.
 * - `report` — Item 16's aggregate report from what NEXA now holds.
 *
 * The provider is touched only through `LegacyInventoryPort`, which can only read.
 *
 * Interruptions: an error inside a phase leaves the run RUNNING and is rethrown naming the
 * run. That is the same state a killed process leaves, so there is ONE recovery for both:
 * `resume`. Nothing is half-written in a way a resume cannot finish — every phase's writes
 * are idempotent and the customer phase writes its customers and their map rows in one
 * transaction per batch.
 */

/** What the importer's own writes are charged to: `SYSTEM_JOB` holds exactly this. */
export const LEGACY_IMPORT_PERMISSION: PermissionKey = 'maintenance.run';

/** NEXA's currency for a legacy Toman balance. Any other selling currency is refused. */
export const LEGACY_BALANCE_CURRENCY = 'IRT';

const CUSTOMER_BATCH = 200;
const DRY_RUN_BATCH = 1000;

export interface LegacyImporterDeps {
  readonly destination: LegacyImporterDestination;
  readonly runs: LegacyImportRepository;
  readonly runInputs: LegacyRunInputsRepository;
  /** Mirza migration PR1: read set observations (`legacy_read_set_runs`). */
  readonly readSetRuns: LegacyReadSetRunRepository;
  /** Mirza migration PR2: the legacy product review the `products` read set is ingested into. */
  readonly productReview: Pick<LegacyProductReviewService, 'ingestBatch' | 'markAbsent'>;
  /** Mirza PR3: the legacy invoice archive's ingest steps (`invoices-read`). */
  readonly invoiceArchive: InvoiceArchiveIngest;
  readonly customers: LegacyCustomerWriter;
  readonly inventory: LegacyInventoryPort;
  readonly openings: Pick<MigrationOpeningBalanceService, 'post'>;
  readonly trials: Pick<LegacyTrialEligibilityService, 'preserveForImport'>;
  readonly products: Pick<
    LegacyProductService,
    'ensureShapeForImport' | 'resolveTariffMatchForImport'
  >;
  /** P6. Null until agent ADOPT's service is wired; eligible candidates are then PENDING. */
  readonly adoption: LegacyAdoptionPort | null;
  /** Mirza PR5: the service candidates — one outcome per live invoice, and the review's approvals. */
  readonly serviceCandidates: LegacyServiceCandidateStore;
  /**
   * Mirza PR6: the owner's cutover approvals, read inside the start transaction of a gated
   * import (`decideImport`), and the facts the final report v2 reads (`reportFacts`).
   */
  readonly cutover: Pick<LegacyCutoverService, 'decideImport' | 'reportFacts'>;
  /** WP-D3: one applying process per tenant; a second import or resume is refused. */
  readonly processLock: LegacyImportProcessLock;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly scopeActivity: ScopeActivityReader;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly codeVersion: string | null;
}

export interface LegacyImportInput {
  readonly scope: TenantContext;
  readonly actor: ActorContext;
  readonly snapshot: LegacySnapshot;
  readonly mapping: PanelMapping;
  /**
   * Mirza PR5: whether the target is production-like (the CLI's guard decides it). A STORED
   * approval is resumed without the source that made it, so its synthetic flag is checked
   * against this before any run acts on it. Absent = production-like: fail closed.
   */
  readonly productionLikeTarget?: boolean;
}

/**
 * Mirza PR6 — the cutover gate, as an import is given it: every `--expected-*` value (null
 * where none was given). The gate APPLIES to an import or resume whenever the target is
 * explicitly production-like (`productionLikeTarget: true`) or this is present (the CLI's
 * `--cutover-gate`, to rehearse it on staging); where it applies, an absent expectation is
 * an incomplete one and is refused.
 */
export interface LegacyCutoverGateInput {
  readonly expectation: CutoverExpectation;
}

/** Test seam: called after each phase of `apply`. A throw here is an interruption. */
export type ApplyPhase = 'customers' | 'openings' | 'trials' | 'products' | 'adoption';

export class LegacyImportInterrupted extends Error {
  constructor(
    readonly runId: string,
    readonly phase: ApplyPhase,
    override readonly cause: unknown,
  ) {
    super(
      `Legacy import run ${runId} was interrupted in the ${phase} phase and is still RUNNING. ` +
        'Re-run with --mode resume against the same source and mapping.',
    );
  }
}

/** Mirza PR5: the operator's review of service candidates, as this run read it. */
interface PreparedReview {
  /** Candidate rows of this snapshot's live invoices, by invoice key. */
  readonly candidates: ReadonlyMap<string, LegacyServiceCandidateRecord>;
  /** Every approval waiting (ADOPT_APPROVED) or claimed (ADOPTING), live or not. */
  readonly approvals: readonly LegacyServiceCandidateRecord[];
  /** Each approval's gate, by candidate id. */
  readonly gates: ReadonlyMap<string, ApprovalGate>;
  /** What the plan uses: accepted approvals' panels; invoices kept as history. */
  readonly inputs: ServiceReviewInputs;
}

interface Prepared {
  readonly plan: LegacyPlan;
  readonly review: PreparedReview;
  readonly inventories: ReadonlyMap<string, LegacyInventoryRead>;
  readonly salesCurrency: string;
  /** What NEXA had recorded when the plan was made: signed openings, debt magnitudes. */
  readonly existingOpenings: ReadonlyMap<string, bigint>;
  readonly existingDebts: ReadonlyMap<string, RecordedDebt>;
}

export interface ApplyTallies {
  customers: {
    created: number;
    /** Of `created`: blocked in MirzaBot, so created BLOCKED (OQ-LWD-07). */
    createdBlocked: number;
    matchedExisting: number;
    manualReviewRecorded: number;
    sourceChanged: number;
    entityMismatch: number;
    reviewClosed: number;
  };
  openings: {
    POSTED: number;
    ALREADY_POSTED: number;
    ZERO_NO_ENTRY: number;
    CONFLICT: number;
    postedSumMinor: bigint;
    /** Mirza PR4 (owner decision 6): negative balances recorded as legacy debts, no entry. */
    DEBT_RECORDED: number;
    DEBT_ALREADY_RECORDED: number;
    /** Σ magnitude of the debts THIS run recorded. */
    debtRecordedSumMinor: bigint;
    /** A ledger DEBIT opening from before owner decision 6: left as it is, never doubled. */
    PRIOR_DEBIT_OPENING: number;
  };
  trials: {
    APPLIED: number;
    REPLAYED: number;
    CONFLICT: number;
    decisions: Record<string, number>;
  };
  products: {
    created: number;
    existing: number;
    unmappable: number;
    tariff: Record<string, number>;
  };
  services: {
    categories: Record<ServiceCandidateCategory, number>;
    /** The invoice map rows the importer wrote, by outcome; and what it could not write yet. */
    map: {
      INSERTED: number;
      UPDATED: number;
      UNCHANGED: number;
      REFUSED: number;
      reviewClosed: number;
      keyInvalid: number;
    };
    adoption: {
      wired: boolean;
      ADOPTED: number;
      ALREADY_ADOPTED: number;
      REVIEW_CLOSED: number;
      MANUAL_REVIEW: number;
      SKIPPED: number;
      FAILED: number;
      /** ALREADY_ADOPTED whose source row changed since adoption: a person's question. */
      alreadyAdoptedSourceChanged: number;
      reviewReasons: Record<string, number>;
      PENDING: number;
      /** Mirza PR5: eligible, and a person kept it as history — never handed to (or by) P6. */
      KEPT_AS_HISTORY: number;
    };
    /** Mirza PR5: the ONE outcome each live invoice got this run (Σ = live invoices). */
    outcomes: Record<LegacyServiceOutcome, number>;
    /** Mirza PR5: the candidate rows this run wrote. */
    candidates: {
      INSERTED: number;
      UPDATED: number;
      UNCHANGED: number;
      /** A row of the other source class (synthetic vs real): never written over. */
      sourceClassMismatch: number;
      /** A key no row can hold (a NUL, or beyond the archive's bound). */
      unrecordable: number;
    };
    /** Mirza PR5: the operators' ADOPT approvals this run met. */
    approvals: {
      executed: number;
      refused: Record<string, number>;
      /** Not acted on and not changed (synthetic on a production-like target; other class). */
      left: Record<string, number>;
      /** Reopened by a person between the run's read and its claim: not executed. */
      claimLost: number;
      /**
       * A refusal the run decided but did not record: a person reopened the approval first
       * (the version-guarded settle lost). Never counted as a refusal.
       */
      withdrawnDuringRun: number;
      /** P6 said "adopted" and the map does not hold the service: settled OPEN, attention. */
      unconfirmed: number;
      /** A claim (ADOPTING) this run could not execute, released back to ADOPT_APPROVED. */
      released: number;
    };
  };
}

/**
 * What an APPLY run left unapplied, failed or in conflict. Any of it makes the verdict
 * `COMPLETED_WITH_FAILURES` (exit 3): a run that leaves money, a trial or a service undone
 * is never reported as success. A row a person closed (REVIEW_CLOSED) and a row recorded
 * for review are decisions, not failures, and are not counted here.
 */
export function applyAttention(tallies: ApplyTallies) {
  const counts = {
    customerSourceChanged: tallies.customers.sourceChanged,
    customerEntityMismatch: tallies.customers.entityMismatch,
    openingConflict: tallies.openings.CONFLICT,
    // A rehearsal target that ran the code before owner decision 6 holds a ledger DEBIT the
    // decision forbids. Never rewritten here — and never reported as success either.
    priorDebitOpening: tallies.openings.PRIOR_DEBIT_OPENING,
    trialConflict: tallies.trials.CONFLICT,
    invoiceMapRefused: tallies.services.map.REFUSED,
    adoptionFailed: tallies.services.adoption.FAILED,
    adoptedSourceChanged: tallies.services.adoption.alreadyAdoptedSourceChanged,
    // Mirza PR5: an outcome that could not be recorded, or an approval a person must look at.
    candidateSourceClassMismatch: tallies.services.candidates.sourceClassMismatch,
    candidateUnrecordable: tallies.services.candidates.unrecordable,
    approvalLeft: Object.values(tallies.services.approvals.left).reduce((a, b) => a + b, 0),
    approvalUnconfirmed: tallies.services.approvals.unconfirmed,
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { ...counts, total };
}

/**
 * Mirza PR6 — what an APPLY run left for a person, as its finish audit row records it and the
 * final report v2 reads it back: the approval counters (PR5, `withdrawnDuringRun` and
 * `unconfirmed` among them) and every attention count. Counts only.
 */
export function applyOutcomeRecord(
  tallies: ApplyTallies,
  attention: ReturnType<typeof applyAttention>,
) {
  const a = tallies.services.approvals;
  return {
    serviceApprovals: {
      executed: a.executed,
      refused: Object.values(a.refused).reduce((x, y) => x + y, 0),
      left: Object.values(a.left).reduce((x, y) => x + y, 0),
      claimLost: a.claimLost,
      withdrawnDuringRun: a.withdrawnDuringRun,
      unconfirmed: a.unconfirmed,
      released: a.released,
    },
    attention,
  };
}

/** G10's blocker sentence, or null when every live real code_panel is accounted for. */
export function incompletePanelMapMessage(completeness: PanelMappingCompleteness): string | null {
  const unmapped = Object.entries(completeness.unmapped);
  if (unmapped.length === 0) return null;
  return (
    `the panel map does not account for ${unmapped.length} live code_panel value(s) ` +
    `(${unmapped.map(([code, n]) => `${JSON.stringify(code)}: ${n} invoice(s)`).join(', ')}); ` +
    'map each, list it as a test or missing panel, or declare it in unresolvedPanels with a reason'
  );
}

export class LegacyImporterService {
  constructor(private readonly deps: LegacyImporterDeps) {}

  // --- shared preparation ---------------------------------------------------------------

  /**
   * Everything a mode decides from: the tenant's panels checked against the mapping, NEXA's
   * current state for the snapshot's users and shapes, and each production panel's
   * inventory (read-only). No write.
   */
  async prepare(
    scope: TenantContext,
    snapshot: LegacySnapshot,
    mapping: PanelMapping,
    productionLikeTarget = true,
    options: { readonly forApply?: boolean } = {},
  ): Promise<Prepared> {
    const { destination } = this.deps;
    if (!(await destination.tenantExists(scope))) {
      throw errors.notFound(PLATFORM_ERROR_CODES.TENANT_NOT_FOUND, 'No such tenant.');
    }
    validateProductMappingAgainstTenant(
      mapping,
      await destination.productIds(scope, [...mapping.products.values()]),
    );
    // aud5 F5 = aud6 F1 (PR2 Departure 9): an APPLY never attaches an invoice or a service
    // to a product the approved legacy product review does not export for this source's
    // CURRENT products read. Decided before any provider read and before any write.
    if (options.forApply === true && mapping.products.size > 0) {
      const verdict = productMapAgainstReview(
        mapping.products,
        await destination.productReviewRows(scope),
        await destination.latestProductsReadFingerprint(scope, snapshot.fingerprint),
      );
      const refusal = productMapRefusalMessage(verdict);
      if (refusal !== null) throw new PanelMappingRefused([refusal]);
    }
    validatePanelMappingAgainstTenant(
      mapping,
      await destination.panels(scope, mapping.policy.productionPanelIds),
    );
    const salesCurrency = await destination.salesCurrency(scope);

    const telegramIds = snapshot.users
      .map((u) => u.id)
      .filter((id) => /^[1-9][0-9]{0,18}$/u.test(id));
    const existingCustomers = await destination.customersByTelegramIds(scope, telegramIds);
    const existingIds = [...existingCustomers.values()];
    const [existingOpenings, existingDebts, trialOverrides, trialDecided, tariffCandidates] =
      await Promise.all([
        destination.openingsByTelegramId(scope),
        destination.debtsByTelegramId(scope),
        destination.trialOverrides(scope, existingIds),
        destination.trialDecided(scope, existingIds),
        destination.tariffCandidates(scope),
      ]);

    const inventories = new Map<string, LegacyInventoryRead>();
    for (const panelId of mapping.policy.productionPanelIds) {
      inventories.set(panelId, await this.deps.inventory.read(scope, panelId));
    }
    const review = await this.prepareReview(scope, snapshot, mapping, productionLikeTarget);

    // Shape keys first (from a plan with no shapes known), then the real plan.
    const draft = planLegacyImport({
      snapshot,
      mapping,
      salesCurrency,
      existingCustomers,
      existingOpenings,
      existingDebts,
      trialOverrides,
      trialDecided,
      existingShapes: new Map(),
      tariffCandidates,
      inventories,
      review: review.inputs,
    });
    const existingShapes = await destination.shapesByKey(
      scope,
      draft.shapes.map((s) => s.key),
    );
    const plan = planLegacyImport({
      snapshot,
      mapping,
      salesCurrency,
      existingCustomers,
      existingOpenings,
      existingDebts,
      trialOverrides,
      trialDecided,
      existingShapes,
      tariffCandidates,
      inventories,
      review: review.inputs,
    });
    return { plan, review, inventories, salesCurrency, existingOpenings, existingDebts };
  }

  /**
   * Mirza PR5 — the candidates of this snapshot's live invoices and every stored approval,
   * each approval through its gate (synthetic against the target first; bound to this row;
   * the panel mapped explicitly). Reads only: claiming is the apply's, under its lock.
   */
  private async prepareReview(
    scope: TenantContext,
    snapshot: LegacySnapshot,
    mapping: PanelMapping,
    productionLikeTarget: boolean,
  ): Promise<PreparedReview> {
    const live = new Map(snapshot.liveInvoices.map((i) => [i.idInvoice, i]));
    const keys = [...live.keys()].filter(recordableKey);
    const candidates = new Map(
      (await this.deps.serviceCandidates.findByInvoiceKeys(scope, keys)).map((c) => [
        c.invoiceKey,
        c,
      ]),
    );
    const approvals = await this.deps.serviceCandidates.listApprovals(scope);
    const gates = new Map<string, ApprovalGate>();
    const operatorPanels = new Map<string, string>();
    for (const approval of approvals) {
      const gate = approvalGate(approval, live.get(approval.invoiceKey), {
        mapping,
        productionLikeTarget,
        snapshotSynthetic: snapshot.synthetic,
      });
      gates.set(approval.id, gate);
      if (gate.kind === 'ACCEPT' && gate.panelId !== null) {
        operatorPanels.set(approval.invoiceKey, gate.panelId);
      }
    }
    const keptAsHistory = new Set(
      [...candidates.values()]
        // A row of another source class is never acted on (nor its decision taken over).
        .filter((c) => c.reviewState === 'KEPT_AS_HISTORY' && c.synthetic === snapshot.synthetic)
        .map((c) => c.invoiceKey),
    );
    return { candidates, approvals, gates, inputs: { operatorPanels, keptAsHistory } };
  }

  private providerSection(prepared: Prepared) {
    const counts = this.deps.inventory.requestCounts();
    return {
      panels: prepared.plan.inventories,
      reads: counts.reads,
      refusedWrites: counts.refusedWrites,
      /** Rows per list page the double walk asked for (clamped as the walk clamps it). */
      inventoryPageSize: this.deps.inventory.pageSize(),
      /** Sent writes. Zero by construction: the port holds no method that can send one. */
      writes: 0,
    };
  }

  private sourceSection(snapshot: LegacySnapshot) {
    return {
      label: snapshot.label,
      engine: snapshot.descriptor.engine,
      version: snapshot.descriptor.version,
      readOnlyProof: snapshot.descriptor.readOnlyProof,
      fingerprint: snapshot.fingerprint,
      schemaHash: snapshot.schemaHash,
      tables: snapshot.tables,
      /** OQ-LWD-07: the `user-status` read set this snapshot decided statuses from. */
      userStatus: snapshot.userStatus,
    };
  }

  private mappingSection(mapping: PanelMapping) {
    return {
      fingerprint: mapping.fingerprint,
      mappedCodes: mapping.file.panels.length,
      testCodes: mapping.file.testPanels.length,
      declaredMissingCodes: mapping.file.missingPanels.length,
      declaredUnresolvedCodes: mapping.unresolved.size,
      productionPanels: mapping.policy.productionPanelIds,
    };
  }

  private report(
    mode: LegacyReportMode,
    scope: TenantContext,
    snapshot: LegacySnapshot | null,
    startedAt: Date,
    sections: Record<string, unknown>,
    verdict: string | null,
  ): LegacyImportReport {
    const now = this.deps.clock.now();
    return {
      format: LEGACY_REPORT_FORMAT,
      mode,
      synthetic: snapshot?.synthetic === true,
      generatedAt: now.toISOString(),
      durationMs: Math.max(0, now.getTime() - startedAt.getTime()),
      tenantId: scope.tenantId,
      codeVersion: this.deps.codeVersion,
      sections,
      verdict,
    };
  }

  // --- audit ---------------------------------------------------------------------------

  async audit(
    input: LegacyImportInput & { readonly evidence: LegacyEvidence },
  ): Promise<LegacyImportReport> {
    const startedAt = this.deps.clock.now();
    const prepared = await this.prepare(
      input.scope,
      input.snapshot,
      input.mapping,
      input.productionLikeTarget,
    );
    const blockers: string[] = [];
    if (prepared.salesCurrency !== LEGACY_BALANCE_CURRENCY) {
      blockers.push(`sales currency is ${prepared.salesCurrency}; legacy balances are Toman (IRT)`);
    }
    for (const panel of prepared.plan.inventories) {
      if (!panel.complete)
        blockers.push(`inventory of panel ${panel.panelId} is incomplete (${panel.reason ?? '?'})`);
    }
    // WP-D2 / G10: every live real code_panel is mapped, a test panel, declared missing,
    // or declared unresolved with a reason. A code the map does not account for blocks.
    const completeness = panelMappingCompleteness(input.snapshot.liveInvoices, input.mapping);
    const incomplete = incompletePanelMapMessage(completeness);
    if (incomplete !== null) blockers.push(incomplete);
    return this.report(
      'AUDIT',
      input.scope,
      input.snapshot,
      startedAt,
      {
        source: this.sourceSection(input.snapshot),
        panelMapping: { ...this.mappingSection(input.mapping), completeness },
        provider: this.providerSection(prepared),
        plan: prepared.plan.tallies,
        evidence: input.evidence,
        crossChecks: crossCheckEvidence(input.evidence, input.snapshot, prepared.plan),
        blockers,
      },
      blockers.length === 0 ? 'READY_FOR_DRY_RUN' : 'BLOCKED',
    );
  }

  // --- dry run -------------------------------------------------------------------------

  async dryRun(input: LegacyImportInput): Promise<LegacyImportReport> {
    const { scope, actor, snapshot, mapping } = input;
    const startedAt = this.deps.clock.now();
    const prepared = await this.prepare(scope, snapshot, mapping, input.productionLikeTarget);
    const runId = this.deps.ids.uuid();
    await this.mutate(scope, actor, 'legacy_import.run.start', runId, async (tx) => {
      const outcome = await this.deps.runs.startOrResume(
        scope,
        {
          id: runId,
          mode: 'DRY_RUN',
          sourceFingerprint: snapshot.fingerprint,
          codeVersion: this.deps.codeVersion,
          now: this.deps.clock.now(),
        },
        tx,
      );
      await this.recordInputs(scope, runId, snapshot, mapping, prepared.salesCurrency, tx);
      await this.auditRun(scope, actor, 'legacy_import.run.start', outcome.run, mapping, tx);
    });

    const statuses: LegacyImportMapStatus[] = [];
    for (const u of prepared.plan.users) {
      statuses.push(u.decision.kind === 'IMPORT' ? 'IMPORTED' : 'MANUAL_REVIEW');
    }
    for (const s of prepared.plan.services) {
      // The status the import would record: P6's IMPORTED for an eligible row, the map
      // decision otherwise, and MANUAL_REVIEW for a key the map cannot hold.
      const d = s.decision;
      statuses.push(
        d.category === 'ADOPTION_ELIGIBLE' ? 'IMPORTED' : (d.map?.status ?? 'MANUAL_REVIEW'),
      );
    }
    for (let i = 0; i < statuses.length; i += DRY_RUN_BATCH) {
      const batch = statuses.slice(i, i + DRY_RUN_BATCH);
      await this.mutate(scope, actor, 'legacy_import.run.dry_run_batch', runId, async (tx) => {
        const now = this.deps.clock.now();
        for (const status of batch)
          await this.deps.runs.recordDryRunDecision(scope, runId, status, now, tx);
        await this.deps.runs.checkpoint(scope, runId, i + batch.length, now, tx);
      });
    }
    const finished = await this.finish(scope, actor, runId, mapping, { status: 'COMPLETED' });
    return this.report(
      'DRY_RUN',
      scope,
      snapshot,
      startedAt,
      {
        run: runSection(finished),
        source: this.sourceSection(snapshot),
        panelMapping: this.mappingSection(mapping),
        provider: this.providerSection(prepared),
        plan: prepared.plan.tallies,
      },
      'NO_BUSINESS_WRITE',
    );
  }

  // --- import / resume -----------------------------------------------------------------

  async apply(
    input: LegacyImportInput & {
      readonly mode: 'IMPORT' | 'RESUME';
      readonly afterPhase?: (phase: ApplyPhase) => Promise<void> | void;
      readonly cutoverGate?: LegacyCutoverGateInput;
    },
  ): Promise<LegacyImportReport> {
    // Claimed BEFORE anything is read, held until the last write: a second process is
    // refused at once instead of walking the same rows beside this one.
    const lease = await this.deps.processLock.tryAcquire(input.scope.tenantId);
    if (lease === null) {
      throw errors.conflict(
        LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT,
        "Another importer process is applying this tenant's import right now. Wait for it to finish. " +
          'A process that died holds nothing: its claim ended with its database connection, so a resume after a crash is never refused here.',
      );
    }
    try {
      return await this.applyClaimed(input, lease);
    } finally {
      await lease.release();
    }
  }

  private async applyClaimed(
    input: LegacyImportInput & {
      readonly mode: 'IMPORT' | 'RESUME';
      readonly afterPhase?: (phase: ApplyPhase) => Promise<void> | void;
      readonly cutoverGate?: LegacyCutoverGateInput;
    },
    lease: LegacyImportProcessLease,
  ): Promise<LegacyImportReport> {
    const { scope, actor, snapshot, mapping } = input;
    const startedAt = this.deps.clock.now();
    // Mirza PR6: the cutover gate, decided FIRST — before the inventory walk reads a single
    // provider page — and again inside the start transaction, where it is authoritative.
    const gate = cutoverGateOf(input);
    if (gate !== null) {
      await this.deps.uow.run(scope, (tx) => this.requireCutover(input, gate, tx));
    }
    const prepared = await this.prepare(scope, snapshot, mapping, input.productionLikeTarget, {
      forApply: true,
    });
    // G10, the same predicate as the audit, decided again NOW: an import never starts on
    // a map that forgets a live code_panel — whatever the audit said earlier.
    const incomplete = incompletePanelMapMessage(
      panelMappingCompleteness(snapshot.liveInvoices, mapping),
    );
    if (incomplete !== null) throw new PanelMappingRefused([incomplete]);
    if (prepared.salesCurrency !== LEGACY_BALANCE_CURRENCY) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        `The tenant sells in ${prepared.salesCurrency}; legacy balances are Toman (IRT) and are never converted.`,
      );
    }
    const preImport = await this.deps.destination.walletTotals(scope, prepared.salesCurrency, {
      excludeOpenings: true,
    });
    const runId = this.deps.ids.uuid();
    const run = await this.mutate(scope, actor, 'legacy_import.run.start', runId, async (tx) => {
      const cutover = gate === null ? null : await this.requireCutover(input, gate, tx);
      const outcome = await this.deps.runs.startOrResume(
        scope,
        {
          id: runId,
          mode: 'APPLY',
          sourceFingerprint: snapshot.fingerprint,
          codeVersion: this.deps.codeVersion,
          now: this.deps.clock.now(),
        },
        tx,
      );
      if (input.mode === 'IMPORT' && outcome.kind === 'RESUMED') {
        throw errors.conflict(
          LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT,
          `Run ${outcome.run.id} from this source is still RUNNING (interrupted). Use --mode resume.`,
        );
      }
      if (input.mode === 'RESUME' && outcome.kind === 'STARTED') {
        throw errors.conflict(
          LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT,
          'There is no RUNNING import of this source to resume. Use --mode import.',
        );
      }
      await this.bindUserStatus(scope, actor, snapshot, tx);
      const stored = await this.recordInputs(
        scope,
        outcome.run.id,
        snapshot,
        mapping,
        prepared.salesCurrency,
        tx,
        preImport,
      );
      if (stored.panelMappingFingerprint !== mapping.fingerprint) {
        throw errors.conflict(
          LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT,
          `Run ${outcome.run.id} was started under a different panel mapping; resume needs the same mapping file.`,
        );
      }
      await this.auditRun(
        scope,
        actor,
        outcome.kind === 'RESUMED' ? 'legacy_import.run.resume' : 'legacy_import.run.start',
        outcome.run,
        mapping,
        tx,
        cutover === null
          ? undefined
          : {
              cutover: {
                cutoverApprovalId: cutover.approvalId,
                rerunApprovalIds: cutover.rerunApprovalIds,
                supersededSources: cutover.supersededSources,
              },
            },
      );
      return outcome.run;
    });

    const tallies: ApplyTallies = {
      customers: {
        created: 0,
        createdBlocked: 0,
        matchedExisting: 0,
        manualReviewRecorded: 0,
        sourceChanged: 0,
        entityMismatch: 0,
        reviewClosed: 0,
      },
      openings: {
        POSTED: 0,
        ALREADY_POSTED: 0,
        ZERO_NO_ENTRY: 0,
        CONFLICT: 0,
        postedSumMinor: 0n,
        DEBT_RECORDED: 0,
        DEBT_ALREADY_RECORDED: 0,
        debtRecordedSumMinor: 0n,
        PRIOR_DEBIT_OPENING: 0,
      },
      trials: { APPLIED: 0, REPLAYED: 0, CONFLICT: 0, decisions: {} },
      products: { created: 0, existing: 0, unmappable: 0, tariff: {} },
      services: {
        categories: {} as Record<ServiceCandidateCategory, number>,
        map: {
          INSERTED: 0,
          UPDATED: 0,
          UNCHANGED: 0,
          REFUSED: 0,
          reviewClosed: 0,
          keyInvalid: 0,
        },
        adoption: {
          wired: this.deps.adoption !== null,
          ADOPTED: 0,
          ALREADY_ADOPTED: 0,
          REVIEW_CLOSED: 0,
          MANUAL_REVIEW: 0,
          SKIPPED: 0,
          FAILED: 0,
          alreadyAdoptedSourceChanged: 0,
          reviewReasons: {},
          PENDING: 0,
          KEPT_AS_HISTORY: 0,
        },
        outcomes: Object.fromEntries(LEGACY_SERVICE_OUTCOMES.map((o) => [o, 0])) as Record<
          LegacyServiceOutcome,
          number
        >,
        candidates: {
          INSERTED: 0,
          UPDATED: 0,
          UNCHANGED: 0,
          sourceClassMismatch: 0,
          unrecordable: 0,
        },
        approvals: {
          executed: 0,
          refused: {},
          left: {},
          claimLost: 0,
          withdrawnDuringRun: 0,
          unconfirmed: 0,
          released: 0,
        },
      },
    };
    let phase: ApplyPhase = 'customers';
    const hook = async (p: ApplyPhase) => {
      if (input.afterPhase !== undefined) await input.afterPhase(p);
      // Between phases: a claim whose session ended may already be someone else's.
      // Stopping here leaves the run RUNNING — the ordinary interruption a resume finishes.
      if (lease.isLost()) {
        throw new Error('the process claim was lost (its database session ended); stopping');
      }
    };
    try {
      if (lease.isLost()) {
        throw new Error('the process claim was lost (its database session ended); stopping');
      }
      const imported = await this.customersPhase(scope, actor, run.id, prepared.plan, tallies);
      await hook('customers');
      phase = 'openings';
      await this.openingsPhase(scope, actor, run.id, snapshot, prepared, imported, tallies);
      await hook('openings');
      phase = 'trials';
      await this.trialsPhase(scope, actor, run.id, prepared, snapshot, imported, tallies);
      await hook('trials');
      phase = 'products';
      const shapeIds = await this.productsPhase(scope, actor, run.id, prepared, tallies);
      await hook('products');
      phase = 'adoption';
      await this.adoptionPhase(
        scope,
        actor,
        run.id,
        prepared,
        snapshot,
        mapping,
        imported,
        shapeIds,
        tallies,
      );
      await hook('adoption');
    } catch (error) {
      throw new LegacyImportInterrupted(run.id, phase, error);
    }
    const attention = applyAttention(tallies);
    // Mirza PR6: the counts a person must see are recorded with the run's finish, so the
    // final report v2 READS them (`applyRun` section) instead of assuming a clean run.
    const finished = await this.finish(
      scope,
      actor,
      run.id,
      mapping,
      { status: 'COMPLETED' },
      { applyOutcome: applyOutcomeRecord(tallies, attention) },
    );
    const adoptionPending = tallies.services.adoption.PENDING > 0;
    return this.report(
      input.mode,
      scope,
      snapshot,
      startedAt,
      {
        run: runSection(finished),
        source: this.sourceSection(snapshot),
        panelMapping: this.mappingSection(mapping),
        provider: this.providerSection(prepared),
        plan: prepared.plan.tallies,
        applied: tallies,
        attention,
      },
      attention.total > 0
        ? 'COMPLETED_WITH_FAILURES'
        : adoptionPending
          ? 'COMPLETED_ADOPTION_PENDING_P6'
          : 'COMPLETED',
    );
  }

  resolveTenant(ref: string): Promise<string | null> {
    return this.deps.destination.resolveTenantId(ref);
  }

  runningRun(scope: TenantContext): Promise<string | null> {
    return this.deps.destination.runningRun(scope);
  }

  /**
   * Mirza migration PR1 — records one read set observation (`legacy_read_set_runs`): the
   * read set's fingerprint and the v1 source fingerprint the SAME read-only session
   * recomputed and found equal to the approved value. The caller has already compared
   * them; this writes nothing else, and observing the same thing twice writes no second row.
   * Charged to `maintenance.run` like every importer write; the tenant must still accept
   * work, read inside the transaction.
   */
  async recordReadSetRun(
    scope: TenantContext,
    actor: ActorContext,
    observation: Omit<LegacyReadSetRun, 'id' | 'recordedAt' | 'codeVersion'>,
  ): Promise<{ readonly run: LegacyReadSetRun; readonly created: boolean }> {
    const id = this.deps.ids.uuid();
    return this.mutate(
      scope,
      actor,
      'legacy_import.read_set.record',
      id,
      async (tx) => {
        const outcome = await this.deps.readSetRuns.recordReadSetRun(
          scope,
          {
            ...observation,
            id,
            codeVersion: this.deps.codeVersion,
            recordedAt: this.deps.clock.now(),
          },
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'legacy_import.read_set.record',
            entityType: 'LegacyReadSetRun',
            entityId: outcome.run.id,
            before: null,
            after: {
              readSet: outcome.run.readSet,
              fingerprintVersion: outcome.run.fingerprintVersion,
              readSetFingerprint: outcome.run.readSetFingerprint,
              sourceFingerprint: outcome.run.sourceFingerprint,
              created: outcome.created,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        return outcome;
      },
      'LegacyReadSetRun',
    );
  }

  /**
   * Mirza migration PR2 — `legacy-import products-read` (`products-ingest.ts`): digest the
   * `products` read set for approval, or, with that approval, ingest it into the legacy
   * product review under this tenant's importer claim and record the read set run.
   */
  readProducts(input: ProductsReadInput): Promise<ProductsReadOutcome> {
    return readLegacyProducts(
      {
        processLock: this.deps.processLock,
        review: this.deps.productReview,
        recordReadSetRun: (scope, actor, observation) =>
          this.recordReadSetRun(scope, actor, observation),
      },
      input,
    );
  }

  /**
   * Mirza migration PR3 — `legacy-import invoices-read` (`invoice-archive-ingest.ts`): digest
   * the `invoice-archive` read set for approval, or, with that approval, stage it, verify it
   * and append its revisions to the legacy invoice archive under this tenant's importer
   * claim, and record the read set run.
   */
  readInvoiceArchive(input: InvoicesReadInput): Promise<InvoicesReadOutcome> {
    return readLegacyInvoiceArchive(
      {
        processLock: this.deps.processLock,
        archive: this.deps.invoiceArchive,
        recordReadSetRun: (scope, actor, observation) =>
          this.recordReadSetRun(scope, actor, observation),
      },
      input,
    );
  }

  /** Aborts the tenant's RUNNING run (any mode). The operator's exit from a stuck run. */
  async abortRunning(scope: TenantContext, actor: ActorContext, runId: string): Promise<void> {
    await this.mutate(scope, actor, 'legacy_import.run.abort', runId, async (tx) => {
      const run = await this.deps.runs.finish(
        scope,
        runId,
        { status: 'ABORTED' },
        this.deps.clock.now(),
        tx,
      );
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'legacy_import.run.abort',
          entityType: 'LegacyImportRun',
          entityId: run.id,
          before: { status: 'RUNNING' },
          after: { status: run.status },
          result: 'SUCCESS',
        },
        tx,
      );
    });
  }

  private async customersPhase(
    scope: TenantContext,
    actor: ActorContext,
    runId: string,
    plan: LegacyPlan,
    tallies: ApplyTallies,
  ): Promise<Map<string, { telegramUserId: string; customerId: string }>> {
    const imported = new Map<string, { telegramUserId: string; customerId: string }>();
    const rows = plan.users.filter((u) => u.decision.kind !== 'INVALID_IDENTITY');
    let seen = 0;
    for (let i = 0; i < rows.length; i += CUSTOMER_BATCH) {
      const batch = rows.slice(i, i + CUSTOMER_BATCH);
      const written = await this.mutate(
        scope,
        actor,
        'legacy_import.customers',
        runId,
        async (tx) => {
          const local: { legacyId: string; telegramUserId: string; customerId: string }[] = [];
          const priors = new Map(
            (
              await this.deps.runs.findByLegacyKeys(
                scope,
                'user',
                batch.map((b) => b.row.id),
                tx,
              )
            ).map((r) => [r.legacyId, r]),
          );
          const now = this.deps.clock.now();
          for (const planned of batch) {
            const { row, decision } = planned;
            if (decision.kind === 'MANUAL_REVIEW') {
              const outcome = await this.deps.runs.recordDecision(
                scope,
                {
                  runId,
                  legacyTable: 'user',
                  legacyId: row.id,
                  checksum: row.checksum,
                  decision: { status: 'MANUAL_REVIEW', reasonCode: decision.mapReason },
                  now,
                },
                tx,
              );
              if (outcome.kind === 'REFUSED' && outcome.reason === 'REVIEW_CLOSED') {
                tallies.customers.reviewClosed += 1;
              } else if (outcome.kind === 'REFUSED') {
                tallies.customers.entityMismatch += 1;
              } else {
                tallies.customers.manualReviewRecorded += 1;
              }
              continue;
            }
            if (decision.kind !== 'IMPORT') continue;
            const prior = priors.get(row.id);
            // Decided BEFORE any write, so a refused row leaves no customer behind: a row a
            // person closed is counted and never retried; source drift under an imported row
            // is a person's question.
            const resume = resumeDecision(prior ?? null, row.checksum);
            if (resume === 'REVIEW_CLOSED') {
              tallies.customers.reviewClosed += 1;
              continue;
            }
            if (resume === 'SOURCE_CHANGED') {
              tallies.customers.sourceChanged += 1;
              continue;
            }
            const { customerId, created } = await this.deps.customers.insertIfAbsent(
              scope,
              {
                id: this.deps.ids.uuid(),
                telegramUserId: decision.telegramUserId,
                username: legacyProfileUsername(row.username),
                // OQ-LWD-07: a MirzaBot ban survives the cutover. Applies only to a customer
                // this statement creates; an existing customer's status is never touched.
                status: decision.blocked ? 'BLOCKED' : 'ACTIVE',
                now,
              },
              tx,
            );
            const outcome = await this.deps.runs.recordDecision(
              scope,
              {
                runId,
                legacyTable: 'user',
                legacyId: row.id,
                checksum: row.checksum,
                decision: {
                  status: 'IMPORTED',
                  entityType: 'CUSTOMER',
                  entityId: customerId,
                  reasonCode: created
                    ? decision.openingKind === 'NEGATIVE'
                      ? 'NEGATIVE_BALANCE'
                      : null
                    : // A rerun meets the customer it created itself: keep that row's own
                      // reason, or a rerun would relabel every created customer "existing".
                      prior?.status === 'IMPORTED' && prior.entityId === customerId
                      ? prior.reasonCode
                      : 'EXISTING_CUSTOMER',
                },
                now,
              },
              tx,
            );
            if (outcome.kind === 'REFUSED') {
              // Provenance is never rewritten. A customer this statement just created must
              // not outlive the refusal, so the batch rolls back and the run is interrupted.
              if (created) {
                throw errors.conflict(
                  LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT,
                  `A legacy user's map row refused its new customer (${outcome.reason}).`,
                );
              }
              if (outcome.reason === 'REVIEW_CLOSED') tallies.customers.reviewClosed += 1;
              else if (outcome.reason === 'IMPORTED_SOURCE_CHANGED')
                tallies.customers.sourceChanged += 1;
              else tallies.customers.entityMismatch += 1;
              continue;
            }
            if (created) {
              tallies.customers.created += 1;
              if (decision.blocked) tallies.customers.createdBlocked += 1;
              await this.deps.audit.record(
                scope,
                actor,
                {
                  action: 'customer.legacy_imported',
                  entityType: 'Customer',
                  entityId: customerId,
                  before: null,
                  after: {
                    source: 'LEGACY_MIGRATION',
                    runId,
                    status: decision.blocked ? 'BLOCKED' : 'ACTIVE',
                  },
                  result: 'SUCCESS',
                },
                tx,
              );
              await this.deps.outbox.write(tx, actor, {
                eventType: 'CustomerImported',
                aggregateType: 'Customer',
                aggregateId: customerId,
                payload: {
                  source: 'LEGACY_MIGRATION',
                  runId,
                },
              });
            } else {
              tallies.customers.matchedExisting += 1;
            }
            local.push({ legacyId: row.id, telegramUserId: decision.telegramUserId, customerId });
          }
          seen += batch.length;
          await this.deps.runs.checkpoint(scope, runId, seen, now, tx);
          return local;
        },
      );
      for (const w of written)
        imported.set(w.legacyId, { telegramUserId: w.telegramUserId, customerId: w.customerId });
    }
    return imported;
  }

  private async openingsPhase(
    scope: TenantContext,
    actor: ActorContext,
    runId: string,
    snapshot: LegacySnapshot,
    prepared: Prepared,
    imported: ReadonlyMap<string, { telegramUserId: string; customerId: string }>,
    tallies: ApplyTallies,
  ): Promise<void> {
    for (const planned of prepared.plan.users) {
      if (planned.decision.kind !== 'IMPORT') continue;
      const who = imported.get(planned.row.id);
      if (who === undefined) continue;
      try {
        const outcome = await this.deps.openings.post(scope, actor, {
          customerId: who.customerId,
          telegramUserId: who.telegramUserId,
          legacyBalanceMinor: planned.decision.balanceMinor,
          currency: prepared.salesCurrency as CurrencyCode,
          // A negative balance is recorded as a legacy debt, with the snapshot it came from.
          provenance: {
            runId,
            sourceFingerprint: snapshot.fingerprint,
            rowChecksum: planned.row.checksum,
            synthetic: snapshot.synthetic,
          },
        });
        tallies.openings[outcome.kind] += 1;
        if (outcome.kind === 'POSTED') tallies.openings.postedSumMinor += outcome.signedAmountMinor;
        if (outcome.kind === 'DEBT_RECORDED') {
          tallies.openings.debtRecordedSumMinor += outcome.amountMinor;
        }
      } catch (error) {
        if (
          isNexaError(error) &&
          error.code === PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH
        ) {
          tallies.openings.CONFLICT += 1;
          continue;
        }
        throw error;
      }
    }
  }

  private async trialsPhase(
    scope: TenantContext,
    actor: ActorContext,
    runId: string,
    prepared: Prepared,
    snapshot: LegacySnapshot,
    imported: ReadonlyMap<string, { telegramUserId: string; customerId: string }>,
    tallies: ApplyTallies,
  ): Promise<void> {
    for (const planned of prepared.plan.users) {
      if (planned.decision.kind !== 'IMPORT') continue;
      const who = imported.get(planned.row.id);
      if (who === undefined) continue;
      try {
        const result = await this.deps.trials.preserveForImport(scope, actor, {
          idempotencyKey: `legacy-import:trial:${runId}:${who.customerId}`,
          customerId: who.customerId,
          legacy: {
            limitUsertest: planned.row.limitUsertest,
            hadTrial: snapshot.trialUsers.has(planned.row.id),
          },
        });
        tallies.trials[result.outcome] += 1;
        tallies.trials.decisions[result.record.decision] =
          (tallies.trials.decisions[result.record.decision] ?? 0) + 1;
      } catch (error) {
        if (
          isNexaError(error) &&
          error.code === PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH
        ) {
          tallies.trials.CONFLICT += 1;
          continue;
        }
        throw error;
      }
    }
  }

  private async productsPhase(
    scope: TenantContext,
    actor: ActorContext,
    runId: string,
    prepared: Prepared,
    tallies: ApplyTallies,
  ): Promise<Map<string, { id: string; resolved: boolean }>> {
    const shapes = new Map<string, { id: string; resolved: boolean }>();
    for (const planned of prepared.plan.shapes) {
      const ensured = await this.deps.products.ensureShapeForImport(scope, actor, {
        idempotencyKey: `legacy-import:shape:${sha256Hex(planned.key)}`,
        legacy: planned.input,
      });
      if (ensured.outcome === 'UNMAPPABLE') {
        tallies.products.unmappable += 1;
        continue;
      }
      if (ensured.outcome === 'CREATED') tallies.products.created += 1;
      else tallies.products.existing += 1;
      // Every run resolves again (once per run: the key carries it), so a public tariff
      // that changed since the last run refreshes the hidden product's price. The #177
      // rules are the shape service's: MATCH only, purchasable tariffs only, and no tariff
      // or several leave a RESOLVED shape as it is (reported, never withdrawn here). A
      // tariff an OPERATOR stated is a decision, never overwritten by a match.
      let resolved = ensured.shape.tariffStatus === 'RESOLVED';
      if (ensured.shape.resolution === 'OPERATOR_STATED') {
        tallies.products.tariff['OPERATOR_STATED_KEPT'] =
          (tallies.products.tariff['OPERATOR_STATED_KEPT'] ?? 0) + 1;
      } else {
        const result = await this.deps.products.resolveTariffMatchForImport(scope, actor, {
          idempotencyKey: `legacy-import:tariff:${ensured.shape.id}:${runId}`,
          shapeId: ensured.shape.id,
        });
        tallies.products.tariff[result.finding] =
          (tallies.products.tariff[result.finding] ?? 0) + 1;
        resolved = result.shape.tariffStatus === 'RESOLVED';
      }
      shapes.set(planned.key, { id: ensured.shape.id, resolved });
    }
    return shapes;
  }

  private async adoptionPhase(
    scope: TenantContext,
    actor: ActorContext,
    runId: string,
    prepared: Prepared,
    snapshot: LegacySnapshot,
    mapping: PanelMapping,
    imported: ReadonlyMap<string, { telegramUserId: string; customerId: string }>,
    shapes: ReadonlyMap<string, { id: string; resolved: boolean }>,
    tallies: ApplyTallies,
  ): Promise<void> {
    const importedUsers = new Map(
      [...imported.entries()].map(([legacyId, w]) => [legacyId, w.telegramUserId]),
    );
    const review = prepared.review;
    const keptAsHistory = review.inputs.keptAsHistory ?? new Set<string>();

    // Mirza PR5, step 1: the operators' ADOPT approvals. A stored approval is resumed
    // without the source that made it, so its gate (synthetic against the target first) was
    // decided in `prepare`; here it is left, refused, or CLAIMED (ADOPT_APPROVED → ADOPTING,
    // a conditional UPDATE at its version — a person's reopen in between wins). A claim a
    // crashed run left ADOPTING is executed again: the adoption is idempotent per invoice.
    const executing = new Map<string, LegacyServiceCandidateRecord>();
    const operatorPanels = new Map<string, string>();
    if (this.deps.adoption === null) {
      // No adoption step: nothing can be executed. A claim an earlier run left ADOPTING is
      // released back to ADOPT_APPROVED, so it is never stuck where no person can reopen it.
      for (const approval of review.approvals) {
        if (approval.reviewState !== 'ADOPTING') continue;
        if (await this.releaseClaim(scope, actor, runId, approval, 'ADOPTION_NOT_WIRED')) {
          tallies.services.approvals.released += 1;
        }
      }
    } else {
      for (const approval of review.approvals) {
        const gate = review.gates.get(approval.id);
        if (gate === undefined) continue;
        if (gate.kind === 'LEAVE') {
          tallies.services.approvals.left[gate.why] =
            (tallies.services.approvals.left[gate.why] ?? 0) + 1;
          // Not executed — and a claim an earlier run left is released, never stuck.
          if (
            approval.reviewState === 'ADOPTING' &&
            (await this.releaseClaim(scope, actor, runId, approval, gate.why))
          ) {
            tallies.services.approvals.released += 1;
          }
          await this.mutate(scope, actor, 'legacy_import.service_approval', runId, (tx) =>
            this.auditApproval(
              scope,
              actor,
              LEGACY_SERVICE_REVIEW_AUDIT_ACTIONS.approvalSyntheticRefused,
              approval,
              { runId, why: gate.why },
              tx,
            ),
          );
          continue;
        }
        if (gate.kind === 'REFUSE') {
          if (await this.settleApproval(scope, actor, runId, approval, { refusal: gate.refusal })) {
            tallies.services.approvals.refused[gate.refusal] =
              (tallies.services.approvals.refused[gate.refusal] ?? 0) + 1;
          } else {
            tallies.services.approvals.withdrawnDuringRun += 1;
          }
          continue;
        }
        const claimed =
          approval.reviewState === 'ADOPTING'
            ? approval
            : await this.mutate(scope, actor, 'legacy_import.service_approval', runId, (tx) =>
                this.deps.serviceCandidates.transition(
                  scope,
                  approval.id,
                  { from: ['ADOPT_APPROVED'], version: approval.version },
                  { reviewState: 'ADOPTING', updatedAt: this.deps.clock.now() },
                  tx,
                ),
              );
        if (claimed === null) {
          tallies.services.approvals.claimLost += 1;
          continue;
        }
        executing.set(claimed.invoiceKey, claimed);
        if (gate.panelId !== null) operatorPanels.set(claimed.invoiceKey, gate.panelId);
      }
    }

    // Step 2: decide every live invoice — the claimed approvals on the operator's panel,
    // everything else exactly as before (owner decision 8: no panel is never searched).
    const decided = decideAllServices(
      snapshot,
      mapping,
      inventoryIndexes(mapping, prepared.inventories),
      importedUsers,
      (key) => (shapes.get(key)?.resolved === true ? 'RESOLVED' : 'UNRESOLVED'),
      { operatorPanels, keptAsHistory },
    );
    tallies.services.categories = { ...decided.categories };

    // What the map said BEFORE this run wrote anything: an adopted invoice stays adopted.
    const prior = new Map<string, LegacyImportMapRecord>();
    const mapKeys = decided.services
      .map((s) => s.invoice.idInvoice)
      .filter((k) => isLegacyImportKey('invoice', k));
    for (let i = 0; i < mapKeys.length; i += CUSTOMER_BATCH) {
      const rows = await this.deps.runs.findByLegacyKeys(
        scope,
        'invoice',
        mapKeys.slice(i, i + CUSTOMER_BATCH),
      );
      for (const row of rows) prior.set(row.legacyId, row);
    }

    // Every decision the importer itself made is recorded on the invoice's map row, in
    // batches, each batch one transaction with its checkpoint.
    const toRecord = decided.services.flatMap(({ invoice, decision }) => {
      if (decision.category === 'ADOPTION_ELIGIBLE') return [];
      if (decision.map === null) {
        // INVOICE_KEY_INVALID: the map cannot hold the key, so it is counted, not a row.
        tallies.services.map.keyInvalid += 1;
        return [];
      }
      return [{ invoice, rule: decision.map }];
    });
    for (let i = 0; i < toRecord.length; i += CUSTOMER_BATCH) {
      const batch = toRecord.slice(i, i + CUSTOMER_BATCH);
      await this.mutate(scope, actor, 'legacy_import.invoices', runId, async (tx) => {
        const now = this.deps.clock.now();
        for (const { invoice, rule } of batch) {
          const outcome = await this.deps.runs.recordDecision(
            scope,
            {
              runId,
              legacyTable: 'invoice',
              legacyId: invoice.idInvoice,
              checksum: invoice.checksum,
              decision: rule,
              now,
            },
            tx,
          );
          // A row a person closed (DISMISSED, or RESOLVED other than RETRY_AFTER_FIX) is
          // refused REVIEW_CLOSED: counted, never retried, never overwritten.
          if (outcome.kind === 'REFUSED' && outcome.reason === 'REVIEW_CLOSED') {
            tallies.services.map.reviewClosed += 1;
          } else {
            tallies.services.map[outcome.kind] += 1;
          }
        }
      });
    }

    // An eligible invoice whose map row a person closed is not handed to P6, nor one a
    // person kept as history (P6 also re-reads that under the invoice lock).
    const eligibleResults = new Map<string, EligibleResult>();
    for (const { invoice, decision } of decided.services) {
      if (decision.category !== 'ADOPTION_ELIGIBLE') continue;
      const before = prior.get(invoice.idInvoice);
      if (before !== undefined && isReviewClosedToRerun(before)) {
        tallies.services.adoption.REVIEW_CLOSED += 1;
        continue;
      }
      if (keptAsHistory.has(invoice.idInvoice)) {
        tallies.services.adoption.KEPT_AS_HISTORY += 1;
        eligibleResults.set(invoice.idInvoice, { kind: 'KEPT_AS_HISTORY' });
        continue;
      }
      if (this.deps.adoption === null) {
        tallies.services.adoption.PENDING += 1;
        eligibleResults.set(invoice.idInvoice, { kind: 'PENDING' });
        continue;
      }
      const who = invoice.idUser === null ? undefined : imported.get(invoice.idUser);
      if (who === undefined) continue;
      const product =
        decision.product.kind === 'NAMED_PRODUCT'
          ? decision.product
          : { ...decision.product, shapeId: shapes.get(decision.product.shapeKey)?.id ?? '' };
      // The runtime facts of the account, from the same complete walk the match came from.
      // Absent (it cannot be, for an ELIGIBLE match) is null, which P6 answers FAILED.
      const read = prepared.inventories.get(decision.panelId);
      const facts =
        read !== undefined && read.ok && read.complete
          ? read.runtime.get(decision.providerUsername)
          : undefined;
      const outcome = await this.deps.adoption.adopt(scope, actor, {
        runId,
        legacyInvoiceId: invoice.idInvoice,
        checksum: invoice.checksum,
        telegramUserId: who.telegramUserId,
        customerId: who.customerId,
        panelId: decision.panelId,
        providerUsername: decision.providerUsername,
        product,
        runtime:
          facts === undefined || read === undefined || !read.ok || !read.complete
            ? null
            : {
                state: facts.state,
                usage: facts.usage,
                observedAt: read.observedAt,
                subscriptionUrl: facts.subscriptionUrl,
              },
      });
      eligibleResults.set(invoice.idInvoice, { kind: 'ADOPTION', outcome });
      // P6 wrote the invoice's map row for every one of these; P7 records nothing here.
      tallies.services.adoption[outcome.kind] += 1;
      if (outcome.kind === 'ALREADY_ADOPTED' && outcome.sourceChanged) {
        tallies.services.adoption.alreadyAdoptedSourceChanged += 1;
      }
      if (outcome.kind === 'MANUAL_REVIEW') {
        tallies.services.adoption.reviewReasons[outcome.reason] =
          (tallies.services.adoption.reviewReasons[outcome.reason] ?? 0) + 1;
      }
    }

    // Step 3: every live invoice's ONE outcome. "Adopted" is what the MAP says after the
    // adoption, read now — never the adoption's word alone: the map row is written in the same
    // transaction as the service, so it is the record a candidate may point at.
    const claimedAdopted = [...eligibleResults]
      .filter(([, r]) => r.kind === 'ADOPTION' && isAdoptedOutcomeKind(r.outcome.kind))
      .map(([key]) => key);
    const confirmed = new Map<string, string>();
    for (let i = 0; i < claimedAdopted.length; i += CUSTOMER_BATCH) {
      const rows = await this.deps.runs.findByLegacyKeys(
        scope,
        'invoice',
        claimedAdopted.slice(i, i + CUSTOMER_BATCH),
      );
      for (const row of rows) {
        if (row.status === 'IMPORTED' && row.entityType === 'SERVICE' && row.entityId !== null) {
          confirmed.set(row.legacyId, row.entityId);
        }
      }
    }
    const outcomes = new Map(
      decided.services.map(({ invoice, decision }) => {
        const key = invoice.idInvoice;
        const o = candidateOutcome(decision, prior.get(key), eligibleResults.get(key) ?? null);
        if (!isAdoptedOutcome(o.outcome)) return [key, o] as const;
        const before = prior.get(key);
        const mapped =
          confirmed.get(key) ??
          (before?.status === 'IMPORTED' && before.entityType === 'SERVICE'
            ? before.entityId
            : null);
        // The adoption said "adopted" and the map does not: never recorded as a service.
        if (mapped === null) {
          return [
            key,
            { outcome: 'ADOPTION_ELIGIBLE', blocker: 'ADOPTION_UNCONFIRMED', serviceId: null },
          ] as const;
        }
        return [key, { ...o, serviceId: mapped }] as const;
      }),
    );
    for (const o of outcomes.values()) tallies.services.outcomes[o.outcome] += 1;

    // Step 4: settle each claimed approval — ADOPTED with its service, or back to OPEN with
    // the outcome that refused it. Never left claimed by a run that finished.
    for (const [key, claimed] of executing) {
      const o = outcomes.get(key);
      if (o !== undefined && isAdoptedOutcome(o.outcome) && o.serviceId !== null) {
        if (
          await this.settleApproval(scope, actor, runId, claimed, {
            adopted: { outcome: o.outcome, serviceId: o.serviceId },
          })
        ) {
          tallies.services.approvals.executed += 1;
        } else {
          tallies.services.approvals.withdrawnDuringRun += 1;
        }
        continue;
      }
      // Every other answer settles back to OPEN with an explicit code — no claimed approval
      // outlives the run that claimed it. ADOPTION_ELIGIBLE here can only mean P6 said
      // "adopted" and the map does not confirm it (the adoption step is wired, and a claimed
      // approval is never kept as history): a broken invariant, counted as attention.
      const refusal: LegacyServiceApprovalRefusal =
        o === undefined
          ? 'NOT_LIVE'
          : o.outcome === 'ADOPTION_ELIGIBLE' || isAdoptedOutcome(o.outcome)
            ? 'ADOPTION_UNCONFIRMED'
            : (o.outcome as LegacyServiceApprovalRefusal);
      if (refusal === 'ADOPTION_UNCONFIRMED') tallies.services.approvals.unconfirmed += 1;
      if (await this.settleApproval(scope, actor, runId, claimed, { refusal })) {
        tallies.services.approvals.refused[refusal] =
          (tallies.services.approvals.refused[refusal] ?? 0) + 1;
      } else {
        tallies.services.approvals.withdrawnDuringRun += 1;
      }
    }

    // Step 5: record every outcome on the invoice's candidate row, in batches.
    await this.recordCandidates(
      scope,
      actor,
      runId,
      prepared,
      snapshot,
      mapping,
      decided.services,
      outcomes,
      importedUsers,
      keptAsHistory,
      operatorPanels,
      shapes,
      tallies,
    );
  }

  /** Mirza PR5 — the candidate rows: insert, or re-decide under the row lock. */
  private async recordCandidates(
    scope: TenantContext,
    actor: ActorContext,
    runId: string,
    prepared: Prepared,
    snapshot: LegacySnapshot,
    mapping: PanelMapping,
    services: LegacyPlan['services'],
    outcomes: ReadonlyMap<string, ReturnType<typeof candidateOutcome>>,
    importedUsers: ReadonlyMap<string, string>,
    keptAsHistory: ReadonlySet<string>,
    operatorPanels: ReadonlyMap<string, string>,
    shapes: ReadonlyMap<string, { id: string; resolved: boolean }>,
    tallies: ApplyTallies,
  ): Promise<void> {
    const ctx = {
      mapping,
      inventories: prepared.inventories,
      userIds: new Set(snapshot.users.map((u) => u.id)),
      importedUsers,
      productCodes: snapshot.productCodes,
      tariffOf: (key: string) =>
        shapes.get(key)?.resolved === true ? ('RESOLVED' as const) : ('UNRESOLVED' as const),
      claimsByName: claimsByName(snapshot.liveInvoices, keptAsHistory),
    };
    const recordable = services.filter(({ invoice }) => {
      if (recordableKey(invoice.idInvoice)) return true;
      tallies.services.candidates.unrecordable += 1;
      return false;
    });
    for (let i = 0; i < recordable.length; i += CUSTOMER_BATCH) {
      const batch = recordable.slice(i, i + CUSTOMER_BATCH);
      await this.mutate(scope, actor, 'legacy_import.service_candidates', runId, async (tx) => {
        const now = this.deps.clock.now();
        const keys = batch.map((s) => s.invoice.idInvoice);
        const existing = new Map(
          (
            await this.deps.serviceCandidates.findByInvoiceKeys(scope, keys, tx, {
              forUpdate: true,
            })
          ).map((c) => [c.invoiceKey, c]),
        );
        const archive = await this.deps.serviceCandidates.latestArchiveIds(scope, keys, tx);
        const counts: Record<string, number> = {};
        for (const { invoice, decision } of batch) {
          const o = outcomes.get(invoice.idInvoice);
          if (o === undefined) continue;
          const evidence = candidateEvidence(invoice, ctx);
          const panelOfDecision =
            decision.category === 'ADOPTION_ELIGIBLE'
              ? decision.panelId
              : (operatorPanels.get(invoice.idInvoice) ?? evidence.mappedPanelId);
          const facts = {
            runId,
            sourceFingerprint: snapshot.fingerprint,
            invoiceChecksum: invoice.checksum,
            outcome: o.outcome,
            blocker: o.blocker,
            evidence,
            evidenceHash: evidenceHash(evidence),
            panelCode: recordableCode(invoice.codePanel),
            productCode: recordableCode(invoice.codeProduct),
            archiveId: archive.get(invoice.idInvoice) ?? null,
            serviceId: o.serviceId,
            observedAt: observedAtFor(panelOfDecision, prepared.inventories),
          };
          const before = existing.get(invoice.idInvoice);
          if (before === undefined) {
            await this.deps.serviceCandidates.insert(
              scope,
              {
                ...facts,
                id: this.deps.ids.uuid(),
                invoiceKey: invoice.idInvoice,
                synthetic: snapshot.synthetic,
                reviewState: initialReviewState(o.outcome),
                now,
              },
              tx,
            );
            tallies.services.candidates.INSERTED += 1;
            counts[o.outcome] = (counts[o.outcome] ?? 0) + 1;
            continue;
          }
          // A real snapshot never writes over test data, nor test data over a real decision.
          if (before.synthetic !== snapshot.synthetic) {
            tallies.services.candidates.sourceClassMismatch += 1;
            continue;
          }
          const reviewState = reviewStateAfterRun(before, o.outcome);
          const bump = isMaterialChange(before, { ...facts, reviewState });
          if (!bump && before.runId === runId) {
            tallies.services.candidates.UNCHANGED += 1;
            continue;
          }
          const written = await this.deps.serviceCandidates.updateOutcome(
            scope,
            before.id,
            before.version,
            { ...facts, reviewState, bump, updatedAt: now },
            tx,
          );
          if (written === null) {
            throw new Error('a legacy service candidate moved under its row lock');
          }
          tallies.services.candidates.UPDATED += 1;
          counts[o.outcome] = (counts[o.outcome] ?? 0) + 1;
        }
        // One audit row per batch: counts by outcome, never a key or a name.
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: LEGACY_SERVICE_REVIEW_AUDIT_ACTIONS.recorded,
            entityType: 'LegacyImportRun',
            entityId: runId,
            before: null,
            after: { written: counts },
            result: 'SUCCESS',
          },
          tx,
        );
      });
    }
  }

  /**
   * Mirza PR5 — an approval leaves ADOPT_APPROVED/ADOPTING: to ADOPTED with its service, or
   * back to OPEN with the code that refused it. A conditional UPDATE at its version; audited
   * with codes and ids only.
   */
  private async settleApproval(
    scope: TenantContext,
    actor: ActorContext,
    runId: string,
    approval: LegacyServiceCandidateRecord,
    result:
      | { readonly refusal: LegacyServiceApprovalRefusal }
      | {
          readonly adopted: {
            readonly outcome: LegacyServiceOutcome;
            readonly serviceId: string;
          };
        },
  ): Promise<boolean> {
    return this.mutate(scope, actor, 'legacy_import.service_approval', runId, async (tx) => {
      const now = this.deps.clock.now();
      const cleared = { approvedPanelId: null, approvedChecksum: null, approvedOutcome: null };
      const settled = await this.deps.serviceCandidates.transition(
        scope,
        approval.id,
        { from: ['ADOPT_APPROVED', 'ADOPTING'], version: approval.version },
        'adopted' in result
          ? {
              ...cleared,
              reviewState: 'ADOPTED',
              outcome: result.adopted.outcome,
              blocker: null,
              serviceId: result.adopted.serviceId,
              lastApprovalRefusal: null,
              updatedAt: now,
            }
          : {
              ...cleared,
              reviewState: 'OPEN',
              lastApprovalRefusal: result.refusal,
              updatedAt: now,
            },
        tx,
      );
      // A person moved it first (a reopen): their decision stands; nothing is recorded here.
      if (settled === null) return false;
      await this.auditApproval(
        scope,
        actor,
        'adopted' in result
          ? LEGACY_SERVICE_REVIEW_AUDIT_ACTIONS.approvalExecuted
          : LEGACY_SERVICE_REVIEW_AUDIT_ACTIONS.approvalRefused,
        approval,
        'adopted' in result
          ? { runId, serviceId: result.adopted.serviceId, outcome: result.adopted.outcome }
          : { runId, refusal: result.refusal },
        tx,
      );
      return true;
    });
  }

  /**
   * A claim (ADOPTING) this run will not execute goes back to ADOPT_APPROVED: the operator's
   * approval still stands, a later run may execute it, and a person may reopen it meanwhile.
   */
  private async releaseClaim(
    scope: TenantContext,
    actor: ActorContext,
    runId: string,
    approval: LegacyServiceCandidateRecord,
    why: string,
  ): Promise<boolean> {
    return this.mutate(scope, actor, 'legacy_import.service_approval', runId, async (tx) => {
      const released = await this.deps.serviceCandidates.transition(
        scope,
        approval.id,
        { from: ['ADOPTING'], version: approval.version },
        { reviewState: 'ADOPT_APPROVED', updatedAt: this.deps.clock.now() },
        tx,
      );
      if (released === null) return false;
      await this.auditApproval(
        scope,
        actor,
        LEGACY_SERVICE_REVIEW_AUDIT_ACTIONS.approvalReleased,
        approval,
        { runId, why },
        tx,
      );
      return true;
    });
  }

  private async auditApproval(
    scope: TenantContext,
    actor: ActorContext,
    action: string,
    approval: LegacyServiceCandidateRecord,
    after: Record<string, unknown>,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.audit.record(
      scope,
      actor,
      {
        action,
        entityType: 'LegacyServiceCandidate',
        entityId: approval.id,
        before: {
          reviewState: approval.reviewState,
          approvedPanelId: approval.approvedPanelId,
          approvedOutcome: approval.approvedOutcome,
          synthetic: approval.synthetic,
          version: approval.version,
        },
        after,
        result: 'SUCCESS',
      },
      tx,
    );
  }

  // --- reconcile -----------------------------------------------------------------------

  async reconcile(input: LegacyImportInput): Promise<LegacyImportReport> {
    const { scope, snapshot, mapping } = input;
    const startedAt = this.deps.clock.now();
    const { run, inputs } = await this.runMadeFrom(scope, snapshot, mapping, 'reconcile');
    const prepared = await this.prepare(scope, snapshot, mapping, input.productionLikeTarget);
    const { destination } = this.deps;
    const tallies = prepared.plan.tallies;
    const [wallet, openings, native, trials, shapes] = await Promise.all([
      destination.walletTotals(scope, inputs.walletCurrency),
      destination.openingAggregates(scope),
      destination.walletTotals(scope, inputs.walletCurrency, { excludeOpenings: true }),
      destination.trialDecisionCounts(scope),
      destination.shapeStatusCounts(scope),
    ]);
    // Movement is measured against the SAME boundary as the pre-import total: both are the
    // non-opening total (`excludeOpenings`), so an entry is either in the pre-import figure
    // or in the movement, never in neither, whenever it committed (before the run row, or
    // concurrently with that measurement). There is no timestamp boundary to fall between.
    const movement = native.totalMinor - inputs.preImportWalletTotalMinor;
    const importable = prepared.plan.users.filter((u) => u.decision.kind === 'IMPORT');
    const present = await destination.customersByTelegramIds(
      scope,
      importable.map((u) => (u.decision.kind === 'IMPORT' ? u.decision.telegramUserId : '')),
    );
    // Owner decision 6: only POSITIVE legacy balances reach the ledger; a negative one is a
    // legacy debt beside it. So the wallet moves by Σ positive, and Σ |negative| is debts.
    const expectedWallet = inputs.preImportWalletTotalMinor + tallies.wallet.positive.sumMinor;
    const categorySum = Object.values(tallies.services.categories).reduce((a, b) => a + b, 0);
    const [debts, usersWallets] = await Promise.all([
      destination.debtAggregates(scope),
      this.usersWalletsSection(scope, snapshot, prepared, inputs.walletCurrency),
    ]);
    // Mirza PR5: the candidate rows this reconcile READ (in `prepare`), against the snapshot.
    const serviceOutcomes = this.serviceOutcomesSection(snapshot, run.id, prepared);
    const counts = this.deps.inventory.requestCounts();
    const checks = [
      check(
        'services.outcomes.closure',
        'every live legacy invoice (service candidate) assigned exactly one deterministic outcome by this run',
        true,
        serviceOutcomes.invariant.holds,
      ),
      check(
        'wallet.equation',
        'pre-import NEXA total + Σ positive legacy Balance (+ non-opening movement since the run) = current total',
        expectedWallet + movement,
        wallet.totalMinor,
      ),
      check(
        'wallet.openings_sum',
        'Σ migration openings = Σ positive legacy Balance of imported users',
        tallies.wallet.positive.sumMinor,
        openings.sumMinor,
      ),
      check(
        'wallet.openings_count',
        'one opening per positive imported balance',
        tallies.wallet.positive.count,
        openings.count,
      ),
      check(
        'wallet.no_debit_opening',
        'no ledger DEBIT opening: a negative legacy balance is never a ledger entry',
        0,
        openings.negative,
      ),
      check(
        'wallet.debts_sum',
        'Σ legacy debts = Σ |negative legacy Balance| of imported users',
        -tallies.wallet.negative.sumMinor,
        debts.sumMinor,
      ),
      check(
        'wallet.debts_count',
        'one legacy debt per negative imported balance',
        tallies.wallet.negative.count,
        debts.count,
      ),
      check(
        'wallet.no_duplicate_opening',
        'no customer holds two openings',
        true,
        openings.perCustomerMax <= 1,
      ),
      check(
        'customers.present',
        'every importable legacy user is a NEXA customer',
        importable.length,
        present.size,
      ),
      check(
        'customers.categories',
        'source users = importable + manual review + invalid identity',
        tallies.customers.source,
        tallies.customers.importable +
          tallies.customers.manualReview.BALANCE_UNREADABLE +
          tallies.customers.manualReview.BALANCE_OUT_OF_RANGE +
          tallies.customers.manualReview.DUPLICATE_SOURCE_ID +
          tallies.customers.manualReview.STATUS_UNKNOWN +
          tallies.customers.invalidIdentity,
      ),
      check(
        'users_wallets.section',
        'the users-and-wallets section holds (U1–U7)',
        true,
        usersWallets.holds,
      ),
      check(
        'trials.decided',
        'every imported customer has a trial decision',
        importable.length,
        Object.values(trials).reduce((a, b) => a + b, 0),
      ),
      check(
        'services.closure',
        'every live invoice is in exactly one category',
        tallies.services.candidates,
        categorySum,
      ),
      check('provider.writes', 'provider requests that were not reads', 0, counts.refusedWrites),
      check(
        'provider.complete',
        'every production panel inventory complete',
        prepared.plan.inventories.length,
        prepared.plan.inventories.filter((p) => p.complete).length,
      ),
    ];
    const ok = checks.every((c) => c.ok);
    return this.report(
      'RECONCILE',
      scope,
      snapshot,
      startedAt,
      {
        run: runSection(run),
        source: this.sourceSection(snapshot),
        panelMapping: this.mappingSection(mapping),
        provider: this.providerSection(prepared),
        wallet: {
          currency: inputs.walletCurrency,
          preImportTotalMinor: inputs.preImportWalletTotalMinor,
          legacySumMinor: tallies.wallet.legacySumMinor,
          nonOpeningMovementSinceRunMinor: movement,
          expectedTotalMinor: expectedWallet + movement,
          actualTotalMinor: wallet.totalMinor,
          openings,
          negativeLegacyBalances: tallies.wallet.negative,
          legacyDebts: debts,
          note:
            'An opening balance is not revenue: it is filed as OPENING_BALANCE and read by no sales figure. ' +
            'A negative legacy balance is a legacy debt held for the owner, never a ledger entry and never collected.',
        },
        usersWallets,
        trials,
        products: shapes,
        services: {
          candidates: tallies.services.candidates,
          categories: tallies.services.categories,
        },
        serviceOutcomes,
        checks,
      },
      ok ? 'RECONCILED' : 'DISCREPANCY',
    );
  }

  // --- report --------------------------------------------------------------------------

  /**
   * Item 16's report for the tenant's latest APPLY run (`final-report.ts`): the run, its
   * inputs, what NEXA holds now and a fresh plan over the same snapshot. Read only.
   */
  async finalReport(
    input: LegacyImportInput & {
      readonly evidenceClass: EvidenceClass;
      /**
       * Mirza PR6: a fresh inventory, read by a session bound to this snapshot's source
       * (`takeLegacyInventory` with the snapshot's fingerprint). Without one the v2 report's
       * inventory section says `read: false` and does not hold — never assumed.
       */
      readonly inventory?: LegacyInventory | null;
      /**
       * Which document's verdict the report carries: 2 (default) the AND of every v2 section
       * and invariant; 1 the closed v1 document with PR4's and PR5's sections, exactly as before
       * PR6 — a consumer of version 1 keeps version 1's verdict, and no v2 document is built.
       */
      readonly reportSchema?: 1 | 2;
    },
  ): Promise<LegacyImportReport> {
    const { scope, snapshot, mapping } = input;
    // The label a caller asks for is checked against the source's own marker HERE too, so
    // no caller of the service — the CLI or another — can call a synthetic run staging.
    const label = decideEvidenceClass({
      claim: input.evidenceClass,
      syntheticSource: snapshot.synthetic,
      productionLikeTarget: input.evidenceClass === 'production',
    });
    if (!label.ok) throw errors.conflict(LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT, label.message);
    const startedAt = this.deps.clock.now();
    const { run, inputs } = await this.runMadeFrom(scope, snapshot, mapping, 'report');
    const { destination } = this.deps;
    const prepared = await this.prepare(scope, snapshot, mapping, input.productionLikeTarget);
    const currency = inputs.walletCurrency;
    const [openings, trials, shapes, map, native, actual, resumes, tenantSlug] = await Promise.all([
      destination.openingAggregates(scope),
      destination.trialDecisionCounts(scope),
      destination.shapeFacts(scope, run.startedAt),
      this.deps.runs.summarize(scope),
      destination.walletTotals(scope, currency, { excludeOpenings: true }),
      destination.walletTotals(scope, currency),
      destination.auditCount(scope, 'legacy_import.run.resume', run.id),
      destination.tenantSlug(scope),
    ]);
    const eligible = { IMPORTED: 0, SKIPPED: 0, MANUAL_REVIEW: 0, FAILED: 0, undecided: 0 };
    const eligibleKeys = prepared.plan.services
      .filter((s) => s.decision.category === 'ADOPTION_ELIGIBLE')
      .map((s) => s.invoice.idInvoice);
    for (let i = 0; i < eligibleKeys.length; i += CUSTOMER_BATCH) {
      const keys = eligibleKeys.slice(i, i + CUSTOMER_BATCH);
      const rows = await this.deps.runs.findByLegacyKeys(scope, 'invoice', keys);
      for (const row of rows) eligible[row.status] += 1;
      eligible.undecided += keys.length - rows.length;
    }
    const counts = this.deps.inventory.requestCounts();
    const final = buildFinalReport({
      eligible,
      generatedAt: this.deps.clock.now(),
      evidenceClass: input.evidenceClass,
      tenantSlug,
      run,
      inputs,
      resumes,
      snapshot,
      plan: prepared.plan.tallies,
      map,
      openings,
      walletCurrency: currency,
      nativeTotalMinor: native.totalMinor,
      actualTotalMinor: actual.totalMinor,
      trials,
      shapes,
      provider: {
        reads: counts.reads,
        refusedWrites: counts.refusedWrites,
        inventoriesComplete: prepared.plan.inventories.every((p) => p.complete),
      },
    });
    // Mirza PR4: beside the closed v1 final report, never inside it (its schema is closed);
    // PR6 folds this section into schema version 2. Its checks (U1–U8) are part of the
    // verdict (Codex on #233): a failed U-check — a synthetic debt beside a real snapshot,
    // a DEBIT opening, a per-user mismatch — is a discrepancy, never COMPLETED.
    const usersWallets = await this.usersWalletsSection(scope, snapshot, prepared, currency);
    // Mirza PR5: beside the closed v1 report too; PR6 folds it into schema version 2. Its
    // closure is part of the verdict, as the users-and-wallets checks are.
    const serviceOutcomes = this.serviceOutcomesSection(snapshot, run.id, prepared);
    // Mirza PR6: version 2 carries the closed v1 document unchanged as `core` and folds in
    // every section; its verdict is the AND of all of them and of the seven invariants.
    if (input.reportSchema === 1) {
      const v1Holds = reportHolds(final, usersWallets, serviceOutcomes);
      return {
        ...this.report('REPORT', scope, snapshot, startedAt, final, run.status),
        verdict: `${run.status}${v1Holds ? '' : '_WITH_DISCREPANCY'}`,
        final,
        usersWallets,
        serviceOutcomes,
      };
    }
    const finalV2 = buildFinalReportV2({
      core: final,
      usersWallets,
      serviceOutcomes,
      snapshot,
      inventory: input.inventory ?? null,
      facts: await this.deps.cutover.reportFacts(scope, snapshot.fingerprint, run.id),
      openingsPerCustomerMax: openings.perCustomerMax,
    });
    const holds = reportHolds(final, usersWallets, serviceOutcomes) && finalV2.verdict.holds;
    return {
      ...this.report('REPORT', scope, snapshot, startedAt, final, run.status),
      verdict: `${run.status}${holds ? '' : '_WITH_DISCREPANCY'}`,
      final,
      finalV2,
      usersWallets,
      serviceOutcomes,
    };
  }

  // --- helpers -------------------------------------------------------------------------

  /** Mirza PR5 — the `serviceOutcomes` section: the rows `prepare` read, nothing assumed. */
  private serviceOutcomesSection(
    snapshot: LegacySnapshot,
    runId: string,
    prepared: Prepared,
  ): ServiceOutcomesSection {
    return buildServiceOutcomesSection({ snapshot, runId, rows: prepared.review.candidates });
  }

  /**
   * Mirza PR4 — the users-and-wallets section (`users-wallets-reconciliation.ts`): the
   * plan's users against their map rows and what NEXA recorded. Read only.
   */
  private async usersWalletsSection(
    scope: TenantContext,
    snapshot: LegacySnapshot,
    prepared: Prepared,
    currency: string,
  ): Promise<UsersWalletsSection> {
    const ids = [...new Set(prepared.plan.users.map((u) => u.row.id))].filter((id) =>
      /^[1-9][0-9]{0,19}$/u.test(id),
    );
    const mapRows = new Map<string, LegacyImportMapRecord>();
    for (let i = 0; i < ids.length; i += CUSTOMER_BATCH) {
      const rows = await this.deps.runs.findByLegacyKeys(
        scope,
        'user',
        ids.slice(i, i + CUSTOMER_BATCH),
      );
      for (const row of rows) mapRows.set(row.legacyId, row);
    }
    const [openingTotals, debtTotals] = await Promise.all([
      this.deps.destination.openingAggregates(scope),
      this.deps.destination.debtAggregates(scope),
    ]);
    return buildUsersWalletsSection({
      sourceFingerprint: snapshot.fingerprint,
      synthetic: snapshot.synthetic,
      currency,
      users: prepared.plan.users,
      mapRows,
      openings: prepared.existingOpenings,
      debts: new Map([...prepared.existingDebts].map(([id, d]) => [id, d.amountMinor])),
      openingTotals,
      debtTotals,
    });
  }

  /**
   * The tenant's latest APPLY run, as reconcile and report may read it: made from THIS
   * snapshot (source fingerprint) and THIS mapping (the fingerprint recorded in its inputs).
   * Either differing would compare one input with what another produced. Reconcile also
   * needs the run COMPLETED: a RUNNING run's phases are half done, and an ABORTED one is not
   * the import. The report may describe either, and says which in its verdict.
   */
  private async runMadeFrom(
    scope: TenantContext,
    snapshot: LegacySnapshot,
    mapping: PanelMapping,
    purpose: 'reconcile' | 'report',
  ): Promise<{ readonly run: LegacyImportRunRecord; readonly inputs: LegacyRunInputs }> {
    const run = await this.latestApplyRun(scope);
    if (purpose === 'reconcile' && run.status !== 'COMPLETED') {
      throw errors.conflict(
        LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT,
        run.status === 'RUNNING'
          ? `Run ${run.id} is RUNNING, not COMPLETED: resume it (--mode resume) or abort it (--abort-running) first.`
          : `Run ${run.id} is ${run.status}, not COMPLETED: there is no finished import to reconcile; run an import first.`,
      );
    }
    if (run.sourceFingerprint !== snapshot.fingerprint) {
      throw errors.conflict(
        LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT,
        `The source changed since run ${run.id} (fingerprint differs); ${purpose} compares one snapshot with what it produced.`,
      );
    }
    const inputs = await this.deps.runInputs.find(scope, run.id);
    if (inputs === null) {
      throw errors.notFound(
        LEGACY_IMPORT_ERROR_CODES.RUN_NOT_FOUND,
        `Run ${run.id} has no recorded inputs.`,
      );
    }
    if (inputs.panelMappingFingerprint !== mapping.fingerprint) {
      throw errors.conflict(
        LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT,
        `Run ${run.id} was made under a different panel mapping; ${purpose} needs the same mapping file.`,
      );
    }
    return { run, inputs };
  }

  /**
   * Mirza PR6 — the cutover gate's decision for this import, read-only, in its own
   * transaction: what `legacy-import cutover-gate` reports. A gated `apply` decides the same
   * thing again inside its start transaction (`requireCutover`).
   */
  async cutoverDecision(
    input: LegacyImportInput & { readonly cutoverGate?: LegacyCutoverGateInput },
  ): Promise<CutoverDecision> {
    const gate = cutoverGateOf({ ...input, productionLikeTarget: true });
    if (gate === null) throw new Error('unreachable: a production-like gate always applies');
    return this.deps.uow.run(input.scope, (tx) => this.decideCutover(input, gate, tx));
  }

  /** The decision, or a `LegacyCutoverRefused` (exit 65, nothing written). */
  private async requireCutover(
    input: LegacyImportInput,
    gate: LegacyCutoverGateInput,
    tx: TransactionScope,
  ): Promise<Extract<CutoverDecision, { ok: true }>> {
    const decision = await this.decideCutover(input, gate, tx);
    if (!decision.ok) throw new LegacyCutoverRefused(decision.code, decision.message);
    return decision;
  }

  /**
   * The one evaluator over what `tx` reads. The expectation's source and panel map must also
   * be the snapshot's and the mapping's: an approval binds what is imported, not what was
   * typed.
   */
  private async decideCutover(
    input: LegacyImportInput,
    gate: LegacyCutoverGateInput,
    tx: TransactionScope,
  ): Promise<CutoverDecision> {
    const { expectation } = gate;
    if (
      expectation.sourceFingerprint !== null &&
      expectation.sourceFingerprint !== input.snapshot.fingerprint
    ) {
      return {
        ok: false,
        code: 'APPROVAL_MISSING',
        message: `the snapshot's source fingerprint is ${input.snapshot.fingerprint}, not the expected ${expectation.sourceFingerprint}. Nothing was written.`,
        detail: ['sourceFingerprint'],
      };
    }
    if (
      expectation.panelMapFingerprint !== null &&
      expectation.panelMapFingerprint !== input.mapping.fingerprint
    ) {
      return {
        ok: false,
        code: 'APPROVAL_MISSING',
        message: `the panel mapping fingerprint is ${input.mapping.fingerprint}, not the expected ${expectation.panelMapFingerprint}. Nothing was written.`,
        detail: ['panelMapFingerprint'],
      };
    }
    return this.deps.cutover.decideImport(
      input.scope,
      {
        expectation,
        snapshotSynthetic: input.snapshot.synthetic,
        productionLikeTarget: input.productionLikeTarget === true,
      },
      tx,
    );
  }

  private async latestApplyRun(scope: TenantContext): Promise<LegacyImportRunRecord> {
    const latest = await this.deps.destination.latestRun(scope, 'APPLY');
    const run = latest === null ? null : await this.deps.runs.findRun(scope, latest.id);
    if (run === null) {
      throw errors.notFound(
        LEGACY_IMPORT_ERROR_CODES.RUN_NOT_FOUND,
        'This tenant has no import run.',
      );
    }
    return run;
  }

  private async mutate<T>(
    scope: TenantContext,
    actor: ActorContext,
    action: string,
    runId: string,
    fn: (tx: TransactionScope) => Promise<T>,
    entityType = 'LegacyImportRun',
  ): Promise<T> {
    return runAuthorizedMutation(
      {
        uow: this.deps.uow,
        guard: this.deps.guard,
        audit: this.deps.audit,
        opsLog: this.deps.opsLog,
        sessions: this.deps.sessions,
        clock: this.deps.clock,
      },
      scope,
      actor,
      LEGACY_IMPORT_PERMISSION,
      { action, entityType, entityId: runId },
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        return fn(tx);
      },
    );
  }

  /**
   * OQ-LWD-07 — binds the `user-status` read set this snapshot decided statuses from to its
   * v1 source fingerprint, inside the run's start transaction. The v1 fingerprint does not
   * cover `User_Status`, so two reads of "the same" approved source can disagree about who is
   * blocked; a run (or a resume) never mixes them. A source that already has a DIFFERENT
   * user-status observation is refused, and nothing is written; otherwise this one is
   * recorded in `legacy_read_set_runs` (insert-or-nothing) and audited.
   */
  private async bindUserStatus(
    scope: TenantContext,
    actor: ActorContext,
    snapshot: LegacySnapshot,
    tx: TransactionScope,
  ): Promise<void> {
    const status = snapshot.userStatus;
    const recorded = await this.deps.readSetRuns.readSetFingerprintsOf(
      scope,
      USER_STATUS_READ_SET_NAME,
      USER_STATUS_READ_SET.version,
      snapshot.fingerprint,
      tx,
    );
    const other = recorded.filter((f) => f !== status.fingerprint);
    if (other.length > 0) {
      throw errors.conflict(
        LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT,
        `This source (${snapshot.fingerprint}) was imported with ${status.fingerprintVersion} ` +
          `${other.join(', ')}, and reads ${status.fingerprint} now: a legacy User_Status ` +
          'changed under an unchanged v1 fingerprint. Freeze the source and take a new snapshot; nothing was written.',
      );
    }
    const userTable = status.tables['user'];
    const outcome = await this.deps.readSetRuns.recordReadSetRun(
      scope,
      {
        id: this.deps.ids.uuid(),
        readSet: USER_STATUS_READ_SET_NAME,
        readSetVersion: USER_STATUS_READ_SET.version,
        fingerprintVersion: status.fingerprintVersion,
        readSetFingerprint: status.fingerprint,
        sourceFingerprint: snapshot.fingerprint,
        sourceSchemaHash: snapshot.schemaHash,
        sourceEngine: snapshot.descriptor.engine,
        synthetic: snapshot.synthetic,
        tableCount: Object.keys(status.tables).length,
        rowCount: BigInt(userTable?.rows ?? 0),
        codeVersion: this.deps.codeVersion,
        recordedAt: this.deps.clock.now(),
      },
      tx,
    );
    if (!outcome.created) return;
    await this.deps.audit.record(
      scope,
      actor,
      {
        action: 'legacy_import.read_set.record',
        entityType: 'LegacyReadSetRun',
        entityId: outcome.run.id,
        before: null,
        after: {
          readSet: outcome.run.readSet,
          fingerprintVersion: outcome.run.fingerprintVersion,
          readSetFingerprint: outcome.run.readSetFingerprint,
          sourceFingerprint: outcome.run.sourceFingerprint,
          created: true,
        },
        result: 'SUCCESS',
      },
      tx,
    );
  }

  private async recordInputs(
    scope: TenantContext,
    runId: string,
    snapshot: LegacySnapshot,
    mapping: PanelMapping,
    currency: string,
    tx: TransactionScope,
    preImport?: { readonly totalMinor: bigint; readonly customers: number },
  ): Promise<LegacyRunInputs> {
    const totals =
      preImport ??
      (await this.deps.destination.walletTotals(scope, currency, { excludeOpenings: true }));
    return this.deps.runInputs.record(
      scope,
      {
        runId,
        sourceEngine: snapshot.descriptor.engine,
        sourceSchemaHash: snapshot.schemaHash,
        panelMappingFingerprint: mapping.fingerprint,
        walletCurrency: currency,
        preImportWalletTotalMinor: totals.totalMinor,
        preImportCustomers: totals.customers,
        recordedAt: this.deps.clock.now(),
      },
      tx,
    );
  }

  private async auditRun(
    scope: TenantContext,
    actor: ActorContext,
    action: string,
    run: LegacyImportRunRecord,
    mapping: PanelMapping,
    tx: TransactionScope,
    extra?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.deps.audit.record(
      scope,
      actor,
      {
        action,
        entityType: 'LegacyImportRun',
        entityId: run.id,
        before: null,
        after: {
          mode: run.mode,
          status: run.status,
          sourceFingerprint: run.sourceFingerprint,
          panelMappingFingerprint: mapping.fingerprint,
          // Mirza PR6: the approval (and re-run acknowledgements) a gated import ran under
          // (start), and what the run left for a person (finish) — counts only.
          ...(extra ?? {}),
        },
        result: 'SUCCESS',
      },
      tx,
    );
  }

  private async finish(
    scope: TenantContext,
    actor: ActorContext,
    runId: string,
    mapping: PanelMapping,
    outcome: { readonly status: 'COMPLETED' | 'ABORTED' },
    extra?: Readonly<Record<string, unknown>>,
  ): Promise<LegacyImportRunRecord> {
    return this.mutate(scope, actor, 'legacy_import.run.finish', runId, async (tx) => {
      const run = await this.deps.runs.finish(scope, runId, outcome, this.deps.clock.now(), tx);
      await this.auditRun(scope, actor, 'legacy_import.run.finish', run, mapping, tx, extra);
      return run;
    });
  }
}

/**
 * The report's verdict holds only when every v1 equation, every users-and-wallets check
 * (PR4) and the service outcomes' closure (PR5) hold: a section beside the closed v1
 * document is part of the verdict, never decoration.
 */
export function reportHolds(
  final: { readonly reconciliation: readonly { readonly holds: boolean }[] },
  usersWallets: { readonly holds: boolean },
  serviceOutcomes: { readonly invariant: { readonly holds: boolean } },
): boolean {
  return (
    final.reconciliation.every((r) => r.holds) &&
    usersWallets.holds &&
    serviceOutcomes.invariant.holds
  );
}

function isAdoptedOutcomeKind(kind: string): boolean {
  return kind === 'ADOPTED' || kind === 'ALREADY_ADOPTED';
}

function runSection(run: LegacyImportRunRecord) {
  return {
    id: run.id,
    mode: run.mode,
    status: run.status,
    sourceFingerprint: run.sourceFingerprint,
    codeVersion: run.codeVersion,
    rowsSeen: run.rowsSeen,
    rowsImported: run.rowsImported,
    rowsSkipped: run.rowsSkipped,
    rowsManualReview: run.rowsManualReview,
    rowsFailed: run.rowsFailed,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

function check(
  id: string,
  what: string,
  expected: bigint | number | boolean,
  actual: bigint | number | boolean,
) {
  return { id, what, expected, actual, ok: expected === actual };
}

/**
 * Whether the cutover gate applies to this import, and with what: where the target is
 * explicitly production-like, or a gate was asked for. Where it applies without an
 * expectation, every value is missing — refused as incomplete, never skipped.
 */
export function cutoverGateOf(input: {
  readonly productionLikeTarget?: boolean;
  readonly cutoverGate?: LegacyCutoverGateInput;
}): LegacyCutoverGateInput | null {
  if (input.cutoverGate !== undefined) return input.cutoverGate;
  if (input.productionLikeTarget !== true) return null;
  return {
    expectation: {
      sourceFingerprint: null,
      panelMapFingerprint: null,
      inventoryFingerprint: null,
      productsFingerprint: null,
      invoiceArchiveFingerprint: null,
      freezeProofSha256: null,
      finalDumpSha256: null,
    },
  };
}
