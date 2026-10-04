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
  LegacyImportRepository,
  LegacyImportRunRecord,
} from '../../legacy-import/application/legacy-import-ports.js';
import {
  isReviewClosedToRerun,
  resumeDecision,
} from '../../legacy-import/application/legacy-import-ports.js';
import type { MigrationOpeningBalanceService } from '../../../commerce/wallet/application/migration-opening-balance.service.js';
import type { LegacyTrialEligibilityService } from '../../../commerce/trials/application/legacy-trial-eligibility.service.js';
import type { LegacyProductService } from '../../../commerce/catalog/application/legacy-product.service.js';
import { legacyProfileUsername, type ServiceCandidateCategory } from './decisions.js';
import { crossCheckEvidence, type LegacyEvidence } from './evidence-runner.js';
import { validatePanelMappingAgainstTenant, type PanelMapping } from './panel-mapping.js';
import { decideAllServices, inventoryIndexes, planLegacyImport, type LegacyPlan } from './plan.js';
import type {
  LegacyAdoptionPort,
  LegacyCustomerWriter,
  LegacyImporterDestination,
  LegacyInventoryPort,
  LegacyInventoryRead,
  LegacyRunInputs,
  LegacyRunInputsRepository,
} from './ports.js';
import { buildFinalReport } from './final-report.js';
import { decideEvidenceClass, type EvidenceClass } from './production-guard.js';
import { LEGACY_REPORT_FORMAT, type LegacyImportReport, type LegacyReportMode } from './report.js';
import { sha256Hex, type LegacySnapshot } from './source-snapshot.js';

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

interface Prepared {
  readonly plan: LegacyPlan;
  readonly inventories: ReadonlyMap<string, LegacyInventoryRead>;
  readonly salesCurrency: string;
}

export interface ApplyTallies {
  customers: {
    created: number;
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
      PENDING: number;
    };
  };
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
  ): Promise<Prepared> {
    const { destination } = this.deps;
    if (!(await destination.tenantExists(scope))) {
      throw errors.notFound(PLATFORM_ERROR_CODES.TENANT_NOT_FOUND, 'No such tenant.');
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
    const [existingOpenings, trialOverrides, trialDecided, tariffCandidates] = await Promise.all([
      destination.openingsByTelegramId(scope),
      destination.trialOverrides(scope, existingIds),
      destination.trialDecided(scope, existingIds),
      destination.tariffCandidates(scope),
    ]);

    const inventories = new Map<string, LegacyInventoryRead>();
    for (const panelId of mapping.policy.productionPanelIds) {
      inventories.set(panelId, await this.deps.inventory.read(scope, panelId));
    }

    // Shape keys first (from a plan with no shapes known), then the real plan.
    const draft = planLegacyImport({
      snapshot,
      mapping,
      salesCurrency,
      existingCustomers,
      existingOpenings,
      trialOverrides,
      trialDecided,
      existingShapes: new Map(),
      tariffCandidates,
      inventories,
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
      trialOverrides,
      trialDecided,
      existingShapes,
      tariffCandidates,
      inventories,
    });
    return { plan, inventories, salesCurrency };
  }

  private providerSection(prepared: Prepared) {
    const counts = this.deps.inventory.requestCounts();
    return {
      panels: prepared.plan.inventories,
      reads: counts.reads,
      refusedWrites: counts.refusedWrites,
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
    };
  }

  private mappingSection(mapping: PanelMapping) {
    return {
      fingerprint: mapping.fingerprint,
      mappedCodes: mapping.file.panels.length,
      testCodes: mapping.file.testPanels.length,
      declaredMissingCodes: mapping.file.missingPanels.length,
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
    const prepared = await this.prepare(input.scope, input.snapshot, input.mapping);
    const blockers: string[] = [];
    if (prepared.salesCurrency !== LEGACY_BALANCE_CURRENCY) {
      blockers.push(`sales currency is ${prepared.salesCurrency}; legacy balances are Toman (IRT)`);
    }
    for (const panel of prepared.plan.inventories) {
      if (!panel.complete)
        blockers.push(`inventory of panel ${panel.panelId} is incomplete (${panel.reason ?? '?'})`);
    }
    return this.report(
      'AUDIT',
      input.scope,
      input.snapshot,
      startedAt,
      {
        source: this.sourceSection(input.snapshot),
        panelMapping: this.mappingSection(input.mapping),
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
    const prepared = await this.prepare(scope, snapshot, mapping);
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
    },
  ): Promise<LegacyImportReport> {
    const { scope, actor, snapshot, mapping } = input;
    const startedAt = this.deps.clock.now();
    const prepared = await this.prepare(scope, snapshot, mapping);
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
      );
      return outcome.run;
    });

    const tallies: ApplyTallies = {
      customers: {
        created: 0,
        matchedExisting: 0,
        manualReviewRecorded: 0,
        sourceChanged: 0,
        entityMismatch: 0,
        reviewClosed: 0,
      },
      openings: { POSTED: 0, ALREADY_POSTED: 0, ZERO_NO_ENTRY: 0, CONFLICT: 0, postedSumMinor: 0n },
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
          PENDING: 0,
        },
      },
    };
    let phase: ApplyPhase = 'customers';
    const hook = async (p: ApplyPhase) => {
      if (input.afterPhase !== undefined) await input.afterPhase(p);
    };
    try {
      const imported = await this.customersPhase(scope, actor, run.id, prepared.plan, tallies);
      await hook('customers');
      phase = 'openings';
      await this.openingsPhase(scope, actor, prepared, imported, tallies);
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
    const finished = await this.finish(scope, actor, run.id, mapping, { status: 'COMPLETED' });
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
      },
      adoptionPending ? 'COMPLETED_ADOPTION_PENDING_P6' : 'COMPLETED',
    );
  }

  resolveTenant(ref: string): Promise<string | null> {
    return this.deps.destination.resolveTenantId(ref);
  }

  runningRun(scope: TenantContext): Promise<string | null> {
    return this.deps.destination.runningRun(scope);
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
              await this.deps.audit.record(
                scope,
                actor,
                {
                  action: 'customer.legacy_imported',
                  entityType: 'Customer',
                  entityId: customerId,
                  before: null,
                  after: { source: 'LEGACY_MIGRATION', runId },
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
        });
        tallies.openings[outcome.kind] += 1;
        if (outcome.kind === 'POSTED') tallies.openings.postedSumMinor += outcome.signedAmountMinor;
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
      let resolved = ensured.shape.tariffStatus === 'RESOLVED';
      if (!resolved) {
        const result = await this.deps.products.resolveTariffMatchForImport(scope, actor, {
          idempotencyKey: `legacy-import:tariff:${ensured.shape.id}:${runId}`,
          shapeId: ensured.shape.id,
        });
        tallies.products.tariff[result.finding] =
          (tallies.products.tariff[result.finding] ?? 0) + 1;
        resolved = result.shape.tariffStatus === 'RESOLVED';
      } else {
        tallies.products.tariff['ALREADY_RESOLVED'] =
          (tallies.products.tariff['ALREADY_RESOLVED'] ?? 0) + 1;
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
    const decided = decideAllServices(
      snapshot,
      mapping,
      inventoryIndexes(mapping, prepared.inventories),
      importedUsers,
      (key) => (shapes.get(key)?.resolved === true ? 'RESOLVED' : 'UNRESOLVED'),
    );
    tallies.services.categories = { ...decided.categories };
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

    // An eligible invoice whose map row a person closed is not handed to P6.
    const eligible = decided.services.filter((s) => s.decision.category === 'ADOPTION_ELIGIBLE');
    const closed = new Set<string>();
    for (let i = 0; i < eligible.length; i += CUSTOMER_BATCH) {
      const keys = eligible.slice(i, i + CUSTOMER_BATCH).map((s) => s.invoice.idInvoice);
      for (const row of await this.deps.runs.findByLegacyKeys(scope, 'invoice', keys)) {
        if (isReviewClosedToRerun(row)) closed.add(row.legacyId);
      }
    }
    for (const { invoice, decision } of decided.services) {
      if (decision.category !== 'ADOPTION_ELIGIBLE') continue;
      if (closed.has(invoice.idInvoice)) {
        tallies.services.adoption.REVIEW_CLOSED += 1;
        continue;
      }
      if (this.deps.adoption === null) {
        tallies.services.adoption.PENDING += 1;
        continue;
      }
      const who = invoice.idUser === null ? undefined : imported.get(invoice.idUser);
      if (who === undefined) continue;
      const product =
        decision.product.kind === 'NAMED_PRODUCT'
          ? decision.product
          : { ...decision.product, shapeId: shapes.get(decision.product.shapeKey)?.id ?? '' };
      const outcome = await this.deps.adoption.adopt(scope, actor, {
        runId,
        legacyInvoiceId: invoice.idInvoice,
        checksum: invoice.checksum,
        telegramUserId: who.telegramUserId,
        customerId: who.customerId,
        panelId: decision.panelId,
        providerUsername: decision.providerUsername,
        product,
      });
      tallies.services.adoption[outcome.kind] += 1;
    }
  }

  // --- reconcile -----------------------------------------------------------------------

  async reconcile(input: LegacyImportInput): Promise<LegacyImportReport> {
    const { scope, snapshot, mapping } = input;
    const startedAt = this.deps.clock.now();
    const run = await this.latestApplyRun(scope);
    if (run.sourceFingerprint !== snapshot.fingerprint) {
      throw errors.conflict(
        LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT,
        `The source changed since run ${run.id} (fingerprint differs); reconcile compares one snapshot with what it produced.`,
      );
    }
    const inputs = await this.deps.runInputs.find(scope, run.id);
    if (inputs === null)
      throw errors.notFound(
        LEGACY_IMPORT_ERROR_CODES.RUN_NOT_FOUND,
        `Run ${run.id} has no recorded inputs.`,
      );
    const prepared = await this.prepare(scope, snapshot, mapping);
    const { destination } = this.deps;
    const tallies = prepared.plan.tallies;
    const [wallet, openings, movement, trials, shapes] = await Promise.all([
      destination.walletTotals(scope, inputs.walletCurrency),
      destination.openingAggregates(scope),
      destination.nonOpeningMovementSince(scope, inputs.walletCurrency, run.startedAt),
      destination.trialDecisionCounts(scope),
      destination.shapeStatusCounts(scope),
    ]);
    const importable = prepared.plan.users.filter((u) => u.decision.kind === 'IMPORT');
    const present = await destination.customersByTelegramIds(
      scope,
      importable.map((u) => (u.decision.kind === 'IMPORT' ? u.decision.telegramUserId : '')),
    );
    const expectedWallet = inputs.preImportWalletTotalMinor + tallies.wallet.legacySumMinor;
    const categorySum = Object.values(tallies.services.categories).reduce((a, b) => a + b, 0);
    const nonZero = tallies.wallet.positive.count + tallies.wallet.negative.count;
    const counts = this.deps.inventory.requestCounts();
    const checks = [
      check(
        'wallet.equation',
        'pre-import NEXA total + Σ legacy Balance (+ non-opening movement since the run) = current total',
        expectedWallet + movement,
        wallet.totalMinor,
      ),
      check(
        'wallet.openings_sum',
        'Σ migration openings = Σ legacy Balance of imported users',
        tallies.wallet.legacySumMinor,
        openings.sumMinor,
      ),
      check(
        'wallet.openings_count',
        'one opening per non-zero imported balance',
        nonZero,
        openings.count,
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
          tallies.customers.invalidIdentity,
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
          note: 'An opening balance is not revenue: it is filed as OPENING_BALANCE and read by no sales figure.',
        },
        trials,
        products: shapes,
        services: {
          candidates: tallies.services.candidates,
          categories: tallies.services.categories,
        },
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
    input: LegacyImportInput & { readonly evidenceClass: EvidenceClass },
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
    const run = await this.latestApplyRun(scope);
    const inputs = await this.deps.runInputs.find(scope, run.id);
    const { destination } = this.deps;
    const prepared = await this.prepare(scope, snapshot, mapping);
    const currency = inputs?.walletCurrency ?? prepared.salesCurrency;
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
    const counts = this.deps.inventory.requestCounts();
    const final = buildFinalReport({
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
    const holds = final.reconciliation.every((r) => r.holds);
    return {
      ...this.report('REPORT', scope, snapshot, startedAt, final, run.status),
      verdict: `${run.status}${holds ? '' : '_WITH_DISCREPANCY'}`,
      final,
    };
  }

  // --- helpers -------------------------------------------------------------------------

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
      { action, entityType: 'LegacyImportRun', entityId: runId },
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
  ): Promise<LegacyImportRunRecord> {
    return this.mutate(scope, actor, 'legacy_import.run.finish', runId, async (tx) => {
      const run = await this.deps.runs.finish(scope, runId, outcome, this.deps.clock.now(), tx);
      await this.auditRun(scope, actor, 'legacy_import.run.finish', run, mapping, tx);
      return run;
    });
  }
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
