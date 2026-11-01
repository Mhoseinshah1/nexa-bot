import {
  exactMatchCoreRows,
  exactMatchReport,
} from '../../legacy-materialize/application/exact-match.js';
import type { UsersWalletsSection } from '../../legacy-importer/application/users-wallets-reconciliation.js';
import { readFile } from 'node:fs/promises';
import {
  isNexaError,
  LEGACY_IMPORT_ERROR_CODES,
  LEGACY_MIGRATION_PROVIDER_INVENTORY_CHURN,
  LEGACY_MIGRATION_INVENTORY_HOLD_VERSION,
  LEGACY_MIGRATION_PROVIDER_INVENTORY_INCOMPLETE,
  LEGACY_MIGRATION_PROVIDER_INVENTORY_QUARANTINED,
  LEGACY_MIGRATION_PROVIDER_INVENTORY_UNRESOLVED,
  LEGACY_NXPKG_ERROR_CODES,
  legacyInventoryPanelDiagnosticsSchema,
  legacyMigrationDryRunInventoryIncomplete,
  validInventoryHold,
  type ActorContext,
  type LegacyInventoryPanelDiagnostics,
  type LegacyMigrationAdoptReport,
  type LegacyMigrationApplyReport,
  type LegacyMigrationCodeCount,
  type LegacyMigrationCutoverValues,
  type UnitOfWork,
  type LegacyMigrationDryRunReport,
  type LegacyMigrationInventoryHold,
  type LegacyMigrationOwnershipSummary,
  type LegacyMigrationPanelTarget,
  type LegacyMigrationSectionCounts,
  type LegacyMigrationVerifyReport,
  type LegacyNxpkgErrorCode,
  type LegacyTableClass,
  type TenantContext,
} from '@nexa/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { errorKind } from '../domain/import-lifecycle.js';
import { SERVICE_CANDIDATE_CATEGORIES } from '../../legacy-importer/application/decisions.js';
import { PLAN_DIGEST_FORMAT_OUTDATED } from '../../legacy-importer/application/plan.js';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { runInventory } from '../../../../legacy-import-inventory.js';
import { freshCutoverFingerprints } from '../../../../legacy-import-cutover.js';
import type { LegacyCutoverService } from '../../legacy-cutover/application/legacy-cutover.service.js';
import { stopSalesHolds } from '../../legacy-cutover/domain/cutover-rules.js';
import {
  classifyTarget,
  evaluateProductionGuard,
  TARGET_ACK_ENV as TARGET_ACK_ENV_NAME,
  type TARGET_ACK_ENV,
  type TargetIdentity,
} from '../../legacy-importer/application/production-guard.js';
import { legacyImportRuns } from '../../../../infrastructure/persistence/schema.js';
import { NxpkgError } from '../../../../infrastructure/nxpkg/errors.js';
import type { NxpkgPackage } from '../../../../infrastructure/nxpkg/reader.js';
import type { LegacyImporterService } from '../../legacy-importer/application/legacy-importer.service.js';
import type { LegacyImportReport } from '../../legacy-importer/application/report.js';
import type { LegacySnapshot } from '../../legacy-importer/application/source-snapshot.js';
import {
  readImportV1Identity,
  readLegacySnapshot,
} from '../../legacy-importer/application/source-snapshot.js';
import {
  crossCheckConverterMoney,
  perCustomerMismatches,
  PER_CUSTOMER_MISMATCH_KEYS,
  walletExpectation,
  walletHistoryVerdicts,
  type PerCustomerTally,
  type WalletExpectation,
  type WalletHistoryVerdicts,
} from '../../legacy-importer/application/converter-wallet-crosscheck.js';
import { PanelMappingRefused } from '../../legacy-importer/application/panel-mapping.js';
import {
  LEGACY_LIVE_STATUSES,
  LegacySourceRefused,
  type LegacySourceSession,
} from '../../legacy-importer/application/source-port.js';
import {
  checkNxpkgForImport,
  NXPKG_PANEL_TARGETS_PATH,
} from '../../legacy-importer/application/nxpkg-acceptance.js';
import {
  buildPanelMappingFromTargets,
  NxpkgImportRefused,
} from '../../legacy-importer/application/nxpkg-panel-binding.js';
import {
  nxpkgOwnershipHold,
  type NxpkgOwnershipHold,
  type VerifiedOwnershipDecisions,
} from '../../legacy-importer/application/nxpkg-ownership.js';
import {
  checkFreshTarget,
  tenantPanelFacts,
} from '../../legacy-importer/infrastructure/nxpkg-fresh-target.js';
import {
  nxpkgSourceConnector,
  type NxpkgLegacySourceConnector,
} from '../../legacy-importer/infrastructure/nxpkg-legacy-source.js';
import type { NxpkgCoverageEntry } from '../../legacy-importer/application/nxpkg-table-accounting.js';
import {
  readOwnershipRecords,
  verifyOwnershipDecisions,
} from '../../legacy-importer/infrastructure/nxpkg-ownership-decisions.js';
import type { LegacyHistoryIngest } from '../../legacy-history/application/legacy-history-ingest.js';
import {
  timedSection,
  type SectionTimingLogger,
} from '../../legacy-importer/application/section-timing.js';
import {
  LegacyMigrationBlocked,
  LegacyMigrationRetry,
  LegacyMigrationStepFailure,
  type FreshTargetGuard,
  type HistoryIngestPort,
  type MigrationRunner,
  type MigrationStepContext,
  type PackageVerifier,
} from '../application/ports.js';

/**
 * The REAL `legacy-migration` ports over the `.nxpkg` reader, `NxpkgLegacySourceConnector` and
 * the existing legacy importer (`docs/legacy-migration/nxpkg-importer.md` §1, §3–§7).
 *
 * ONE PATH. Every importer mode runs through the CLI's own `runMode`, with the arguments the
 * CLI would have parsed, so the production guard, the evidence class, the expected-fingerprint
 * binding and the cutover gate are the same code the operator's terminal runs — never a second
 * reading of them here. `runMode` is loaded lazily: the CLI module imports the container, and a
 * static import from inside the container's graph would be a cycle.
 *
 * Each call opens the package into its own private directory under the step's `workDir` and
 * closes it (deleting the decrypted payload) in its `finally`, whatever happens.
 *
 * Refusals become `LegacyMigrationStepFailure` with the contract's code: a reader error keeps
 * its own (`NXPKG_WRONG_KEY`, …), an acceptance or binding refusal its own, and an importer
 * refusal (a usage, source, mapping, archive or cutover refusal) is `IMPORT_FAILED` — its
 * reason goes to the log, never to the row; a SOURCE refusal also leaves its own code, and
 * the `table.column` names of a schema refusal, in the row's refusal counts
 * (`sourceRefusalCounts`). An INTERRUPTED import is rethrown untouched, so
 * the executor resumes it rather than failing it.
 */
export interface NxpkgMigrationAdapterDeps {
  readonly db: Database;
  /**
   * The importer, given the executor step's signal: its live RickPanel read stops on a lost
   * lease (between attempts and during the pause), before the import's first write.
   */
  readonly importer: (signal?: AbortSignal) => LegacyImporterService;
  readonly history: () => LegacyHistoryIngest;
  /** The owner's cutover approvals and the stop-sales sample (`/legacy-cutover`). */
  readonly cutover: () => LegacyCutoverService;
  readonly uow: UnitOfWork<TransactionScope>;
  /**
   * This installation's own database, as the importer's production guard identifies a target
   * (null when its URL does not parse: production-like, the conservative answer).
   */
  readonly target: TargetIdentity | null;
  /**
   * The `migration` PROCESS's environment, read the way the CLI reads its own: `NODE_ENV` and
   * `NEXA_LEGACY_IMPORT_TARGET_ACK`. Never from the database or a request.
   */
  readonly guardEnv: () => {
    readonly NODE_ENV?: string | undefined;
    readonly [TARGET_ACK_ENV]?: string | undefined;
  };
  /** Reads the decisions file. Injected so a test can give bytes without a disk. */
  readonly readDecisions?: (path: string) => Promise<Uint8Array>;
  readonly logger: {
    /** Per-section timing lines (`section-timing.ts`), when the logger takes them. */
    info?(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
  };
}

type Context = Omit<MigrationStepContext, 'panelBindings'> & {
  readonly panelBindings?: MigrationStepContext['panelBindings'];
};

/** What one opened step holds while it runs. */
interface Opened {
  readonly connector: NxpkgLegacySourceConnector;
  readonly pkg: NxpkgPackage;
}

export class NxpkgMigrationAdapters
  implements PackageVerifier, MigrationRunner, FreshTargetGuard, HistoryIngestPort
{
  constructor(private readonly deps: NxpkgMigrationAdapterDeps) {}

  /** The logger's `info`, when it has one, for the per-section timing lines. */
  private get timing(): SectionTimingLogger | undefined {
    const info = this.deps.logger.info?.bind(this.deps.logger);
    return info === undefined ? undefined : { info };
  }

  /** The importer's own classification of this database, under this process's environment. */
  private get productionLikeTarget(): boolean {
    return (
      this.deps.target === null ||
      classifyTarget(this.deps.target, this.deps.guardEnv()).productionLike
    );
  }

  // --- the production-like gates (the CLI's, unchanged) -----------------------------------

  /**
   * On a production-like target, every gate the CLI applies, decided BEFORE the package is
   * opened: the target acknowledgement from this process's environment (`guardTarget`'s
   * `evaluateProductionGuard`; the owner's CRITICAL web approval stands where the CLI's typed
   * `--allow-production-target` would, and the env acknowledgement is still required), and,
   * for the apply, an unrevoked owner approval of the dry run's seven values
   * (`LegacyCutoverService.decideImport`, the importer's own evaluator) and active stop-sales
   * (`stopSalesHolds`). The importer decides all of it again inside its start transaction.
   */
  async precheck(
    context: MigrationStepContext,
    step: 'DRY_RUN' | 'TARGET' | 'APPLY' | 'ADOPT',
  ): Promise<void> {
    // The "adopt approved" lane waits (still ADOPT_REQUESTED, cancellable) while another run
    // is RUNNING — anywhere, production-like or not. Its own interrupted run of this source is
    // the one exception: the importer resumes it. The importer decides all of it again.
    if (step === 'ADOPT') await this.laneNotBesideAnotherRun(context);
    if (!this.productionLikeTarget) return;
    const synthetic = context.verifyReport?.synthetic ?? true;
    if (synthetic) {
      // Never allowed, acknowledged or not (the evidence-class rule).
      throw new LegacyMigrationStepFailure(
        'IMPORT_FAILED',
        'A synthetic package is never imported into a production-like database.',
      );
    }
    // Phase 7: the dry run writes no customer and no money; the acknowledgement arms the apply.
    // The "adopt approved" lane (§4b) writes no customer and no money either, and is no
    // import: it executes approvals made in this database, and the importer binds it to the
    // finished import of this very source. A synthetic package is refused here as for both.
    if (step === 'DRY_RUN' || step === 'ADOPT') return;
    // The acknowledgement is asked ONCE, before the first write (TARGET). An APPLY — the first
    // attempt's, right after TARGET, and every resume's — trusts that stored decision (review
    // M3): failing a partly written import because an environment changed between two
    // attempts would strand it, and the owner's acknowledgement is on the row anyway.
    if (step === 'TARGET') {
      // The approval refuses a dry run that planned on an incomplete live RickPanel read
      // (`LegacyMigrationService.approve`); asked again here, before the protective backup
      // and the freeze, for an approval recorded by a release that did not refuse it.
      // One-sided by nature (nothing was read yet to compare with): `dryrun:` alone. The
      // invoices the report's inventory hold quarantines are not counted; an old report has none.
      const unread = legacyMigrationDryRunInventoryIncomplete(
        context.dryRunReport?.warnings,
        context.dryRunReport?.inventoryHold,
      );
      if (unread > 0) {
        throw new LegacyMigrationStepFailure(
          'DRY_RUN_MISMATCH',
          'The approved dry run planned on an incomplete RickPanel inventory.',
          { counts: [{ code: 'dryrun:panels:inventory_incomplete', count: unread }] },
        );
      }
      // Without the plan's digest the import could not be bound to the approved plan at all.
      // Not only `null`: a report stored by a release before the field existed has no key, and
      // `runMode` would then hand the importer no digest to compare (fail closed on either).
      if (
        context.dryRunReport !== null &&
        typeof context.dryRunReport.planTalliesDigest !== 'string'
      ) {
        throw new LegacyMigrationStepFailure(
          'DRY_RUN_MISMATCH',
          'The approved dry run reported no plan digest to bind the import to.',
          { counts: [{ code: 'dryrun:plan:digest_missing', count: 1 }] },
        );
      }
      if (!this.acknowledged(context)) throw new LegacyMigrationBlocked('TARGET_ACK_MISSING');
      return;
    }

    const values = context.dryRunReport?.cutover;
    if (values === undefined) throw new LegacyMigrationBlocked('CUTOVER_APPROVAL_MISSING');
    const cutover = this.deps.cutover();
    const decision = await this.deps.uow.run(context.scope, (tx) =>
      cutover.decideImport(
        context.scope,
        { expectation: values, snapshotSynthetic: false, productionLikeTarget: true },
        tx,
      ),
    );
    if (!decision.ok) {
      this.deps.logger.warn(
        { importId: context.importId, code: decision.code },
        'no owner cutover approval matches this package yet',
      );
      throw new LegacyMigrationBlocked('CUTOVER_APPROVAL_MISSING');
    }
    if (!stopSalesHolds(await cutover.stopSalesFacts(context.scope)).holds) {
      throw new LegacyMigrationBlocked('STOP_SALES_NOT_ACTIVE');
    }
  }

  /** `precheck('ADOPT')`: another RUNNING run is a transient wait, never a verdict. */
  private async laneNotBesideAnotherRun(context: MigrationStepContext): Promise<void> {
    const running = await this.deps.importer(context.signal).runningRunRecord(context.scope);
    if (
      running !== null &&
      !(
        running.mode === 'ADOPT_APPROVED' && running.sourceFingerprint === context.sourceFingerprint
      )
    ) {
      throw new LegacyMigrationRetry('RUN_CONFLICT');
    }
  }

  /**
   * The importer's own guard (`evaluateProductionGuard`), asked with each acknowledgement there
   * is: the owner's, given with the approval and stored on the import (Phase 7, the restore
   * page — the service required it to be this installation's own when it stored it, and it is
   * asked again here against THIS process's target and tenant), and this process's environment
   * (the CLI and the rehearsal kit, unchanged). Either, bound to this target and tenant, is
   * the acknowledgement; neither is none.
   */
  private acknowledged(context: MigrationStepContext): boolean {
    const target = this.deps.target;
    if (target === null) return false;
    const env = this.deps.guardEnv();
    const candidates = [
      env[TARGET_ACK_ENV_NAME],
      ...(context.targetAck === null ? [] : [context.targetAck]),
    ];
    return candidates.some(
      (ack) =>
        ack !== undefined &&
        ack !== '' &&
        evaluateProductionGuard({
          target,
          tenantId: context.scope.tenantId,
          env: { NODE_ENV: env.NODE_ENV, [TARGET_ACK_ENV_NAME]: ack },
          allowProductionFlag: true,
          syntheticSource: false,
        }).allowed,
    );
  }

  // --- verify (§1, §7) --------------------------------------------------------------------

  async verify(context: Context): Promise<LegacyMigrationVerifyReport> {
    return this.withPackage(context, async ({ connector, pkg }) => {
      const acceptance = await checkNxpkgForImport(pkg);
      if (!acceptance.ok) {
        const first = acceptance.problems[0];
        this.deps.logger.warn(
          { importId: context.importId, problems: acceptance.problems.map((p) => p.code) },
          'a Mirza package was refused at verification',
        );
        throw new LegacyMigrationStepFailure(
          first?.code ?? 'NXPKG_CONTAINER_INVALID',
          'The package is not importable.',
        );
      }
      const decisions = await this.decisions(context, pkg);
      const session = await connector.open();
      let fingerprint: string;
      let liveByCodePanel: ReadonlyMap<string, number>;
      try {
        fingerprint = (await readImportV1Identity(session)).fingerprint;
        liveByCodePanel = await liveServicesByCodePanel(session);
      } finally {
        await session.close();
      }
      const panelTargets = await selectedTargets(pkg, liveByCodePanel);
      const packageImportId = connector.identity.importId;
      if (packageImportId === null) {
        throw new LegacyMigrationStepFailure('NXPKG_CONTAINER_INVALID', 'No package import id.');
      }
      // The history archive's planner and its FIRST pass (every record validated, keys unique,
      // no live flag), writing nothing: a package whose history the apply would refuse fails
      // HERE, before anyone reviews a dry run of it.
      await this.historyCounts(context, pkg, packageImportId);
      return {
        packageImportId,
        sourceFingerprint: fingerprint,
        packageSchemaVersion: connector.identity.contractVersion,
        converterVersion: connector.identity.converterVersion,
        synthetic: connector.syntheticMarker !== null,
        panelTargets,
        recordCounts: connector.catalog.tables
          .map((table) => ({ code: table.name, count: table.rows }))
          .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
        decisions:
          decisions === null
            ? null
            : {
                entriesDigest: decisions.entriesDigest,
                auditHead: decisions.auditHead,
                items: decisions.summary.items,
                proven: decisions.summary.PROVEN,
                adminApprovedUnverified: decisions.summary.ADMIN_APPROVED_UNVERIFIED,
                pending: decisions.summary.PENDING,
                rejected: decisions.summary.REJECTED,
                quarantined: decisions.summary.QUARANTINED,
                stale: decisions.summary.stale,
              },
      };
    });
  }

  // --- fresh target (§6) ------------------------------------------------------------------

  async check(scope: TenantContext, sourceFingerprint: string | null) {
    const result = await checkFreshTarget(this.deps.db, scope.tenantId, { sourceFingerprint });
    return result.fresh
      ? ({ fresh: true } as const)
      : ({ fresh: false, counts: nonZero(result.counts) } as const);
  }

  // --- the importer ------------------------------------------------------------------------

  /**
   * The importer's dry run, the read-set FINGERPRINTS (digest only: nothing recorded, nothing
   * ingested — H4), the history counted with `dryRun`, and the converter's own operational
   * totals compared with the importer's plan (M8).
   */
  async dryRun(context: MigrationStepContext) {
    return this.withPackage(context, async (opened) => {
      const fingerprint = requireFingerprint(context);
      const timing = this.timing;
      const observed = await timedSection(timing, 'dry_run.read_sets', () =>
        this.observeReadSets(context, opened.connector, fingerprint),
      );
      const run = await timedSection(timing, 'dry_run.importer', () =>
        this.run('dry-run', context, opened),
      );
      const history = await timedSection(timing, 'dry_run.history', () =>
        this.history(context, opened.pkg, true),
      );
      const tallies = (run.report.sections['plan'] ?? {}) as PlanShape;
      const converter = await converterTotals(opened.pkg);
      const absent = this.compareWithConverter(context, converter, tallies);
      // The importer's own reading of the snapshot's money, by customer: the converter's
      // records are compared with it one by one (money, so a difference blocks like the
      // totals do), and the wallet-history verdicts are counted against it.
      const expectation = await timedSection(timing, 'dry_run.wallet_expectation', () =>
        this.walletExpectationOf(context, opened, run.snapshot),
      );
      if (converter !== null) {
        await timedSection(timing, 'dry_run.converter_customers', () =>
          this.compareCustomersWithConverter(context, opened, expectation, tallies),
        );
      }
      const walletHistory = await timedSection(timing, 'dry_run.wallet_history', () =>
        this.walletHistoryOf(context, opened, expectation),
      );
      const cutover: LegacyMigrationCutoverValues = {
        sourceFingerprint: fingerprint,
        panelMapFingerprint: (await this.binding(context, opened.pkg)).mapping.fingerprint,
        inventoryFingerprint: observed.inventoryFingerprint,
        productsFingerprint: observed.productsFingerprint,
        invoiceArchiveFingerprint: observed.invoiceArchiveFingerprint,
        freezeProofSha256: opened.pkg.payloadSha256,
        finalDumpSha256: opened.pkg.fileSha256,
      };
      const digest = run.report.sections['planTalliesDigest'];
      const holdSection = run.report.sections['ownershipHold'] as
        { readonly changedCategory?: unknown } | undefined;
      return {
        report: {
          ...dryRunReportOf(run.report, tallies, run.hold, run.decisions, history, {
            invoiceArchiveRows: observed.invoiceArchiveRows,
            holdChangedCategory:
              typeof holdSection?.changedCategory === 'number' ? holdSection.changedCategory : null,
            converterTotalsAbsent: absent,
            walletHistory,
            inventoryVerdict: observed.inventoryVerdict,
            tables: observed.tables,
            coverage: opened.connector.coverage,
          }),
          cutover,
          planTalliesDigest:
            typeof digest === 'string' && /^[0-9a-f]{64}$/u.test(digest) ? digest : null,
        },
        legacyRunId: runIdOf(run.report),
      };
    });
  }

  /**
   * The APPROVED reads (design §4: products and invoice archive before the import, the
   * UNRESOLVED_RETAINED invariant; the inventory a cutover approval binds), each bound to the
   * fingerprint the approved dry run observed. Ingested and RECORDED here, at the apply's
   * start — never by the dry run.
   */
  async recordReadSets(context: MigrationStepContext): Promise<void> {
    await this.withPackage(context, async ({ connector }) => {
      const fingerprint = requireFingerprint(context);
      const approved = context.dryRunReport?.cutover;
      if (approved === undefined || approved.sourceFingerprint !== fingerprint) {
        throw new LegacyMigrationStepFailure(
          'DRY_RUN_MISMATCH',
          'The apply has no approved dry run of this source.',
        );
      }
      const importer = this.deps.importer(context.signal);
      const common = {
        scope: context.scope,
        actor: context.actor,
        connector,
        expectedFingerprint: fingerprint,
        productionLikeTarget: this.productionLikeTarget,
      };
      context.signal.throwIfAborted();
      const timing = this.timing;
      const inventory = await timedSection(timing, 'apply.read_sets.inventory', () =>
        runInventory(
          importer,
          connector,
          { expectedFingerprint: fingerprint },
          {
            scope: context.scope,
            actor: context.actor,
            productionLikeTarget: this.productionLikeTarget,
          },
        ),
      );
      if (inventory.inventory.fingerprint !== approved.inventoryFingerprint) {
        throw new LegacyMigrationStepFailure(
          'DRY_RUN_MISMATCH',
          'The inventory read now is not the one the approved dry run observed.',
        );
      }
      if (inventory.recorded === null) {
        throw new LegacyMigrationStepFailure(
          'IMPORT_FAILED',
          'The inventory read set was not recorded.',
        );
      }
      context.signal.throwIfAborted();
      // `expected*` = the approved fingerprint: the read ingests and records only when it
      // reads exactly that; anything else is refused before a row is written.
      await timedSection(timing, 'apply.read_sets.products', () =>
        importer.readProducts({
          ...common,
          expectedProductsFingerprint: approved.productsFingerprint,
        }),
      );
      context.signal.throwIfAborted();
      await timedSection(timing, 'apply.read_sets.invoice_archive', () =>
        importer.readInvoiceArchive({
          ...common,
          expectedInvoiceArchiveFingerprint: approved.invoiceArchiveFingerprint,
        }),
      );
    });
  }

  async apply(
    context: MigrationStepContext,
    input: { readonly mode: 'IMPORT' | 'RESUME'; readonly approvedDryRunSha256: string },
  ) {
    return this.withPackage(context, async (opened) => {
      // RESUME is what the executor asks after a crash; what the importer is asked depends on
      // what the crash left: its RUNNING run is resumed; with none, either the crash came
      // before the run started (the target is still fresh: IMPORT), or after it finished (the
      // finished run of this source IS the outcome — never a second import).
      let mode: 'import' | 'resume' = 'import';
      if (input.mode === 'RESUME') {
        if ((await this.deps.importer(context.signal).runningRun(context.scope)) !== null) {
          mode = 'resume';
        } else if (
          !(
            await checkFreshTarget(this.deps.db, context.scope.tenantId, {
              sourceFingerprint: requireFingerprint(context),
            })
          ).fresh
        ) {
          const finished = await this.finishedApplyRun(context);
          if (finished === null) {
            throw new LegacyMigrationStepFailure(
              'IMPORT_FAILED',
              'The apply was interrupted and left no run to resume or finish.',
            );
          }
          return finished;
        }
      }
      context.signal.throwIfAborted();
      const run = await this.run(mode, context, opened);
      const verdict = run.report.verdict ?? 'UNKNOWN';
      if (verdict === 'BLOCKED') {
        throw new LegacyMigrationStepFailure('IMPORT_FAILED', 'The import was blocked.');
      }
      const legacyRunId = runIdOf(run.report);
      if (legacyRunId === null) {
        throw new LegacyMigrationStepFailure('IMPORT_FAILED', 'The import reported no run.');
      }
      return { legacyRunId, importerVerdict: verdict };
    });
  }

  /**
   * The "adopt approved" lane (`service-review.md` §4b), through the CLI's own `runMode` like
   * every other mode: the package opened again, its panel map and ownership hold made exactly
   * as for its import, and the importer's `adoptApproved` bound to the finished import's run
   * and the inventory hold its approved dry run recorded. Counts and codes come back.
   */
  async adoptApproved(
    context: MigrationStepContext,
    input: {
      readonly importLegacyRunId: string;
      readonly inventoryHold: { readonly digest: string; readonly invoices: number } | null;
    },
  ): Promise<LegacyMigrationAdoptReport> {
    return this.withPackage(context, async (opened) => {
      const run = await this.run('adopt-approved', context, opened, {
        inventoryHold: input.inventoryHold,
        expectedApplyRunId: input.importLegacyRunId,
      });
      const report = run.report;
      const approvals = (report.sections['approvals'] ?? {}) as {
        readonly met?: unknown;
        readonly executed?: unknown;
        readonly stillUnresolved?: unknown;
        readonly refused?: unknown;
        readonly left?: unknown;
        readonly claimLost?: unknown;
        readonly withdrawnDuringRun?: unknown;
        readonly unconfirmed?: unknown;
        readonly released?: unknown;
      };
      const provider = (report.sections['provider'] ?? {}) as {
        readonly panelsRead?: unknown;
        readonly reads?: unknown;
        readonly refusedWrites?: unknown;
      };
      return {
        verdict: report.verdict ?? 'UNKNOWN',
        legacyRunId: runIdOf(report),
        importLegacyRunId: input.importLegacyRunId,
        approvals: countOf(approvals.met),
        adopted: countOf(approvals.executed),
        stillUnresolved: countOf(approvals.stillUnresolved),
        refused: codeCountsOf(approvals.refused),
        left: codeCountsOf(approvals.left),
        claimLost: countOf(approvals.claimLost),
        withdrawnDuringRun: countOf(approvals.withdrawnDuringRun),
        unconfirmed: countOf(approvals.unconfirmed),
        released: countOf(approvals.released),
        panelsRead: countOf(provider.panelsRead),
        providerReads: countOf(provider.reads),
        // Requests refused before sending: zero by construction (a read-only port).
        providerWrites: countOf(provider.refusedWrites),
      };
    });
  }

  async reconcile(context: MigrationStepContext) {
    return this.withPackage(context, async (opened) => {
      const run = await this.run('reconcile', context, opened);
      return {
        verdict: run.report.verdict === 'RECONCILED' ? 'RECONCILED' : 'DISCREPANCY',
      } as const;
    });
  }

  async finalReport(
    context: MigrationStepContext,
    input: {
      readonly importerVerdict: string;
      readonly reconcileVerdict: 'RECONCILED' | 'DISCREPANCY';
      readonly history: readonly { readonly code: string; readonly count: number }[];
    },
  ): Promise<LegacyMigrationApplyReport> {
    return this.withPackage(context, async (opened) => {
      const run = await this.run('report', context, opened);
      // `--report-schema 2`: the v2 document is `finalV2` (`final` is the closed v1 core and
      // carries no verdict of its own). Its verdict is the AND of every section and of the
      // seven invariants; the report's own verdict also folds in the v1 checks.
      const v2 = (run.report as { finalV2?: unknown }).finalV2 as
        | {
            verdict?: { holds?: unknown; failedSections?: unknown; failedInvariants?: unknown };
          }
        | undefined;
      const usersWallets = (v2 as { sections?: { usersWallets?: UsersWalletsSection } } | undefined)
        ?.sections?.usersWallets;
      const strings = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
      const holds =
        v2?.verdict?.holds === true &&
        typeof run.report.verdict === 'string' &&
        !run.report.verdict.endsWith('_WITH_DISCREPANCY');
      return {
        importerVerdict: input.importerVerdict,
        reconcileVerdict: input.reconcileVerdict,
        reportHolds: holds,
        failedInvariants: strings(v2?.verdict?.failedInvariants),
        failedSections: strings(v2?.verdict?.failedSections),
        sections: input.history.map((h) => ({
          section: `history:${h.code}`,
          source: h.count,
          imported: 0,
          archived: h.count,
          skipped: 0,
          quarantined: 0,
        })),
        history: [...input.history],
        // The exact-match report's core rows (every Mirza user, every unit of Balance), from
        // the importer's own users-and-wallets section; the executor adds the history steps'.
        ...(usersWallets === undefined
          ? {}
          : { exactMatch: exactMatchReport(exactMatchCoreRows(usersWallets)) }),
      };
    });
  }

  // --- history (§5) ----------------------------------------------------------------------

  async ingest(context: MigrationStepContext) {
    return this.withPackage(context, async ({ pkg }) => ({
      counts: await this.history(context, pkg, false),
    }));
  }

  // --- internals --------------------------------------------------------------------------

  private async withPackage<T>(context: Context, fn: (opened: Opened) => Promise<T>): Promise<T> {
    let connector: NxpkgLegacySourceConnector;
    try {
      connector = await nxpkgSourceConnector(context.packagePath, context.secret, context.workDir, {
        signal: context.signal,
      });
    } catch (error) {
      throw this.classify(error, context);
    }
    try {
      const pkg = connector.pkg;
      if (pkg === null)
        throw new LegacyMigrationStepFailure('NXPKG_CONTAINER_INVALID', 'no package');
      // The bytes opened are the bytes uploaded, verified and approved.
      if (pkg.fileSha256 !== context.packageSha256) {
        throw new LegacyMigrationStepFailure(
          'PACKAGE_CHANGED',
          'The package is not the uploaded one.',
        );
      }
      return await fn({ connector, pkg });
    } catch (error) {
      throw this.classify(error, context);
    } finally {
      await connector.close();
    }
  }

  private async decisions(
    context: Context,
    pkg: NxpkgPackage,
  ): Promise<VerifiedOwnershipDecisions | null> {
    if (context.decisionsPath === null) return null;
    const read = this.deps.readDecisions ?? ((path: string) => readFile(path));
    return verifyOwnershipDecisions(await read(context.decisionsPath), pkg, context.secret);
  }

  /** Runs one importer mode through the CLI's own `runMode`, with the package's ownership hold. */
  private async run(
    mode: 'dry-run' | 'import' | 'resume' | 'reconcile' | 'report' | 'adopt-approved',
    context: Context,
    { connector, pkg }: Opened,
    /**
     * The "adopt approved" lane only: the inventory hold of the FINISHED import's approved dry
     * run (the lane row was never dry-run), and that import's run the lane is bound to.
     */
    lane?: {
      readonly inventoryHold: { readonly digest: string; readonly invoices: number } | null;
      readonly expectedApplyRunId: string;
    },
  ): Promise<{
    report: LegacyImportReport;
    hold: NxpkgOwnershipHold | null;
    decisions: VerifiedOwnershipDecisions | null;
    /** The snapshot the importer read and fingerprinted for this run (review H P2-1). */
    snapshot: LegacySnapshot | null;
  }> {
    const cli = await import('../../../../legacy-import.cli.js');
    const mapping = await this.mapping(context, pkg);
    const decisions = await this.decisions(context, pkg);
    const { facts } = await readOwnershipRecords(pkg);
    let hold: NxpkgOwnershipHold | null = null;
    let read: LegacySnapshot | null = null;
    const fingerprint = requireFingerprint(context);
    const synthetic = connector.syntheticMarker !== null;
    const evidence = synthetic ? 'synthetic' : this.productionLikeTarget ? 'production' : 'staging';
    const args = cli.parseArgs([
      mode,
      '--tenant',
      context.scope.tenantId,
      // Named, never dialled: `runMode` writes through the container it is given.
      '--target',
      'nexa_migration_role',
      '--panel-map',
      'package-panel-targets',
      '--source',
      `nxpkg:${context.packagePath}`,
      '--package-key-env',
      'LEGACY_MIGRATION_PACKAGE_KEY',
      '--evidence-class',
      evidence,
      // Every write is bound to the source verification recorded (the CLI takes the flag for
      // the writing modes; every other mode's source is compared below).
      ...(mode === 'import' || mode === 'resume' ? ['--expected-fingerprint', fingerprint] : []),
      // Production-like: the other six values the owner's approval binds, exactly as the CLI's
      // flags carry them, so `runMode` applies the cutover gate it applies to the operator.
      ...((mode === 'import' || mode === 'resume') && this.productionLikeTarget
        ? cutoverFlags(context.dryRunReport?.cutover)
        : []),
      ...(mode === 'report' ? ['--report-schema', '2'] : []),
    ]);
    const report = await cli.runMode(
      this.deps.importer(context.signal),
      args,
      connector,
      mapping,
      `legacy-migration:${context.importId}`,
      {
        tenantId: context.scope.tenantId,
        productionLikeTarget: this.productionLikeTarget,
        // M7: the hold is bound into the run with the decisions file it came from.
        ownershipDecisionsDigest: decisions?.entriesDigest ?? null,
        // DRY_RUN_MISMATCH: an import starts only on the plan the owner approved — the
        // APPROVED dry run's tallies digest (the executor checked the approval binds this
        // very report). A resume continues its own run and is not asked.
        ...(mode === 'import' && context.dryRunReport?.planTalliesDigest != null
          ? { dryRunTalliesDigest: context.dryRunReport.planTalliesDigest }
          : {}),
        // The inventory hold: every mode after the dry run is decided under the APPROVED
        // dry run's hold (the importer reads its keys back by this digest). A report without
        // one (or not exactly v1) gives none: an unresolved name then refuses, as before.
        ...(lane !== undefined
          ? {
              expectedApplyRunId: lane.expectedApplyRunId,
              ...(lane.inventoryHold === null ? {} : { inventoryHold: lane.inventoryHold }),
            }
          : mode !== 'dry-run' && validInventoryHold(context.dryRunReport?.inventoryHold)
            ? {
                inventoryHold: {
                  digest: context.dryRunReport.inventoryHold.digest,
                  invoices: context.dryRunReport.inventoryHold.invoices,
                },
              }
            : {}),
        ownershipHoldFor: (snapshot: LegacySnapshot) => {
          read = snapshot;
          hold = nxpkgOwnershipHold({
            records: facts,
            decisions,
            liveInvoices: snapshot.liveInvoices,
            otherInvoices: snapshot.otherInvoices,
          });
          return Promise.resolve(hold.hold);
        },
      },
    );
    if (report === null) {
      throw new LegacyMigrationStepFailure(
        'IMPORT_FAILED',
        `The importer's ${mode} returned nothing.`,
      );
    }
    const source = report.sections['source'] as { fingerprint?: unknown } | undefined;
    if (source !== undefined && source.fingerprint !== fingerprint) {
      throw new LegacyMigrationStepFailure(
        'PACKAGE_CHANGED',
        'The snapshot read is not the source verification recorded.',
      );
    }
    return { report, hold, decisions, snapshot: read };
  }

  /** The panel map from the package's targets and the operator's bindings (§1). */
  private async mapping(context: Context, pkg: NxpkgPackage): Promise<string> {
    return (await this.binding(context, pkg)).text;
  }

  private async binding(context: Context, pkg: NxpkgPackage) {
    const targets: Record<string, unknown>[] = [];
    if (pkg.has(NXPKG_PANEL_TARGETS_PATH)) {
      for await (const record of pkg.iterJsonl(NXPKG_PANEL_TARGETS_PATH)) targets.push(record);
    }
    return buildPanelMappingFromTargets({
      tenantId: context.scope.tenantId,
      targets,
      bindings: Object.fromEntries(
        (context.panelBindings ?? []).map((b) => [b.codePanel, b.panelId]),
      ),
      tenantPanels: await tenantPanelFacts(this.deps.db, context.scope.tenantId),
    });
  }

  /**
   * The three read sets a cutover approval binds, each observed then RECORDED for this source
   * (`legacy_read_set_runs`): the inventory (`runInventory`, the CLI's own), the products and
   * the invoice archive (the UNRESOLVED_RETAINED invariant needs the archive before the import).
   */
  private async readSets(
    context: Context,
    connector: NxpkgLegacySourceConnector,
    fingerprint: string,
  ): Promise<
    Pick<
      LegacyMigrationCutoverValues,
      'inventoryFingerprint' | 'productsFingerprint' | 'invoiceArchiveFingerprint'
    >
  > {
    const importer = this.deps.importer(context.signal);
    const common = {
      scope: context.scope,
      actor: context.actor,
      connector,
      expectedFingerprint: fingerprint,
      productionLikeTarget: this.productionLikeTarget,
    };
    const products = await importer.readProducts({ ...common, expectedProductsFingerprint: null });
    await importer.readProducts({ ...common, expectedProductsFingerprint: products.fingerprint });
    const invoices = await importer.readInvoiceArchive({
      ...common,
      expectedInvoiceArchiveFingerprint: null,
    });
    await importer.readInvoiceArchive({
      ...common,
      expectedInvoiceArchiveFingerprint: invoices.fingerprint,
    });
    const inventory = await runInventory(
      importer,
      connector,
      { expectedFingerprint: fingerprint },
      {
        scope: context.scope,
        actor: context.actor,
        productionLikeTarget: this.productionLikeTarget,
      },
    );
    // The cutover gate refuses an import whose fresh inventory is not COMPLETE (every legacy
    // table classified in a reviewed commit). Said at the dry run, so no owner approves a
    // package the gate will refuse at the apply.
    if (this.productionLikeTarget && inventory.inventory.verdict !== 'COMPLETE') {
      this.deps.logger.warn(
        {
          importId: context.importId,
          verdict: inventory.inventory.verdict,
          unclassified: unclassifiedTables(inventory.inventory.tables),
        },
        'the package inventory is not complete; a production-like import would be refused',
      );
      throw new LegacyMigrationStepFailure(
        'IMPORT_FAILED',
        inventoryIncomplete(inventory.inventory),
      );
    }
    if (inventory.recorded === null) {
      throw new LegacyMigrationStepFailure(
        'IMPORT_FAILED',
        'The inventory read set was not recorded.',
      );
    }
    return {
      inventoryFingerprint: inventory.inventory.fingerprint,
      productsFingerprint: products.fingerprint,
      invoiceArchiveFingerprint: invoices.fingerprint,
    };
  }

  private async history(
    context: Context,
    pkg: NxpkgPackage,
    dryRun: boolean,
  ): Promise<LegacyMigrationCodeCount[]> {
    if (context.packageImportId === null) {
      throw new LegacyMigrationStepFailure('NXPKG_CONTAINER_INVALID', 'No package import id.');
    }
    return dryRun
      ? this.historyCounts(context, pkg, context.packageImportId)
      : this.historyIngest(context, pkg, context.packageImportId, false);
  }

  /** The ingest's planner and its validating first pass, writing nothing (`dryRun`). */
  private historyCounts(
    context: Context,
    pkg: NxpkgPackage,
    packageImportId: string,
  ): Promise<LegacyMigrationCodeCount[]> {
    return this.historyIngest(context, pkg, packageImportId, true);
  }

  private async historyIngest(
    context: Context,
    pkg: NxpkgPackage,
    packageImportId: string,
    dryRun: boolean,
  ): Promise<LegacyMigrationCodeCount[]> {
    const result = await this.deps.history().ingest(context.scope, context.actor as ActorContext, {
      nxpkgImportId: context.importId,
      packageImportId,
      source: pkg,
      dryRun,
      signal: context.signal,
    });
    return Object.entries(result.sections)
      .map(([code, counts]) => ({ code, count: counts?.source ?? 0 }))
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  }

  /** The latest finished APPLY run of this source, when a crash came after it completed. */
  private async finishedApplyRun(
    context: Context,
  ): Promise<{ legacyRunId: string; importerVerdict: string } | null> {
    const [row] = await this.deps.db
      .select({ id: legacyImportRuns.id, status: legacyImportRuns.status })
      .from(legacyImportRuns)
      .where(
        and(
          eq(legacyImportRuns.tenantId, context.scope.tenantId),
          eq(legacyImportRuns.mode, 'APPLY'),
          eq(legacyImportRuns.sourceFingerprint, requireFingerprint(context)),
        ),
      )
      .orderBy(desc(legacyImportRuns.startedAt))
      .limit(1);
    if (row === undefined || row.status !== 'COMPLETED') return null;
    // The run's STATUS is not the importer's verdict (COMPLETED_WITH_FAILURES and
    // COMPLETED_ADOPTION_PENDING_P6 are COMPLETED runs). What it left for a person is read
    // back from its finish record; without the verdict itself the outcome is never called
    // clean: the executor reports COMPLETED_WITH_DISCREPANCY for a person to read.
    const facts = await this.deps
      .cutover()
      .reportFacts(context.scope, requireFingerprint(context), row.id);
    const attention = facts.applyOutcome?.attention['total'] ?? null;
    return {
      legacyRunId: row.id,
      importerVerdict:
        attention !== null && attention > 0
          ? 'COMPLETED_WITH_FAILURES'
          : 'COMPLETED_VERDICT_NOT_RECORDED',
    };
  }

  /**
   * The read sets' fingerprints, OBSERVED only (`expected = null`: a digest, nothing written
   * anywhere — no product review, no invoice archive, no read-set run) and the inventory
   * taken the same way. The approved reads that record them run at the apply's start.
   */
  private async observeReadSets(
    context: Context,
    connector: NxpkgLegacySourceConnector,
    fingerprint: string,
  ): Promise<{
    readonly inventoryFingerprint: string;
    readonly productsFingerprint: string;
    readonly invoiceArchiveFingerprint: string;
    readonly invoiceArchiveRows: number;
    readonly inventoryVerdict: string;
    readonly tables: readonly InventoryTableLine[];
  }> {
    const importer = this.deps.importer(context.signal);
    const fresh = await freshCutoverFingerprints(importer, connector, fingerprint, {
      scope: context.scope,
      actor: context.actor,
      productionLikeTarget: this.productionLikeTarget,
    });
    // The cutover gate refuses an import whose fresh inventory is not COMPLETE (every legacy
    // table classified in a reviewed commit). Said at the dry run, so no owner approves a
    // package the gate will refuse at the apply.
    if (fresh.inventory.verdict !== 'COMPLETE') {
      this.deps.logger.warn(
        {
          importId: context.importId,
          verdict: fresh.inventory.verdict,
          unclassified: unclassifiedTables(fresh.inventory.tables),
        },
        'the package inventory is not complete; a production-like import would be refused',
      );
      if (this.productionLikeTarget) {
        throw new LegacyMigrationStepFailure('IMPORT_FAILED', inventoryIncomplete(fresh.inventory));
      }
    }
    // A second observation, for the row count the dry run reports (a digest read as well).
    const invoices = await importer.readInvoiceArchive({
      scope: context.scope,
      actor: context.actor,
      connector,
      expectedFingerprint: fingerprint,
      productionLikeTarget: this.productionLikeTarget,
      expectedInvoiceArchiveFingerprint: null,
    });
    if (invoices.fingerprint !== fresh.invoiceArchive.fingerprint) {
      throw new LegacyMigrationStepFailure(
        'PACKAGE_CHANGED',
        'The invoice archive read twice from one package differs.',
      );
    }
    return {
      inventoryFingerprint: fresh.inventory.fingerprint,
      productsFingerprint: fresh.products.fingerprint,
      invoiceArchiveFingerprint: fresh.invoiceArchive.fingerprint,
      invoiceArchiveRows: invoices.rows.invoice,
      inventoryVerdict: fresh.inventory.verdict,
      tables: fresh.inventory.tables.map((t) => ({ name: t.name, class: t.class, rows: t.rows })),
    };
  }

  /**
   * M8: the converter's operational records against the importer's plan. Customers
   * (`records/customers.jsonl`) = the plan's importable users; openings
   * (`records/wallet_opening_balances.jsonl`) = its positive balances, count and sum; debts
   * (`records/legacy_debts.jsonl`, magnitudes) = its negative balances. Any difference is
   * `DRY_RUN_MISMATCH` with both numbers. A package without the files (an older converter, or
   * a test package) is compared with nothing: refused on a production-like target, reported
   * as a warning elsewhere. Returns whether the files were absent.
   */
  private compareWithConverter(
    context: Context,
    converter: ConverterTotals | null,
    plan: PlanShape,
  ): boolean {
    if (converter === null) {
      if (this.productionLikeTarget) {
        throw new LegacyMigrationStepFailure(
          'DRY_RUN_MISMATCH',
          'The package carries no converter totals to compare the plan with.',
        );
      }
      return true;
    }
    const importer = {
      customers: BigInt(n(plan.customers?.importable)),
      openings: BigInt(n(plan.wallet?.positive?.count)),
      openingsSum: bigintOf(plan.wallet?.positive?.sumMinor),
      debts: BigInt(n(plan.wallet?.negative?.count)),
      debtsSum: -bigintOf(plan.wallet?.negative?.sumMinor),
    };
    const pairs: [string, bigint, bigint][] = [
      ['customers', converter.customers, importer.customers],
      ['wallet_openings', converter.openings.count, importer.openings],
      ['wallet_openings_sum_minor', converter.openings.sumMinor, importer.openingsSum],
      ['legacy_debts', converter.debts.count, importer.debts],
      ['legacy_debts_sum_minor', converter.debts.sumMinor, importer.debtsSum],
    ];
    const differ = pairs.filter(([, a, b]) => a !== b);
    if (differ.length === 0) return false;
    const counts: LegacyMigrationCodeCount[] = [];
    for (const [code, a, b] of differ) {
      for (const [side, value] of [
        ['converter', a],
        ['importer', b],
      ] as const) {
        // A count must fit the contract's integer; a sum that does not is logged only.
        if (value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
          counts.push({ code: `${side}:${code}`, count: Number(value) });
        }
      }
    }
    this.deps.logger.warn(
      {
        importId: context.importId,
        differ: differ.map(([code, a, b]) => ({
          code,
          converter: a.toString(),
          importer: b.toString(),
        })),
      },
      "the converter's totals and the importer's plan disagree; the dry run is refused",
    );
    throw new LegacyMigrationStepFailure(
      'DRY_RUN_MISMATCH',
      "The converter's operational totals differ from the importer's plan.",
      { counts },
    );
  }

  /**
   * The importer's per-customer money for THIS source (the fingerprint the dry run is bound to),
   * from the snapshot the run itself read — a production backup is not read a second time
   * (review H P2-1) — or, when the run handed none over, from a fresh read. Either way it is
   * held to the verified fingerprint.
   */
  private async walletExpectationOf(
    context: Context,
    opened: Opened,
    read: LegacySnapshot | null,
  ): Promise<WalletExpectation> {
    const snapshot = read ?? (await readLegacySnapshot(opened.connector));
    if (snapshot.fingerprint !== requireFingerprint(context)) {
      throw new LegacyMigrationStepFailure(
        'PACKAGE_CHANGED',
        'The snapshot read for the per-customer comparison is not the verified source.',
      );
    }
    return walletExpectation(snapshot.users);
  }

  /**
   * M8, per customer: `wallet_opening_balances.jsonl` and `legacy_debts.jsonl` against the
   * importer's expectation, by Telegram id. Equal totals can hide two customers' amounts
   * swapped, a credit moved to somebody else, or a record for the wrong person — each one money
   * credited to the wrong wallet. Any mismatch is `DRY_RUN_MISMATCH`, exactly as a total that
   * differs is, with the counts (never an id or an amount). The expectation is also held to
   * the plan's own totals: two answers to "what does this source credit" would be one too many.
   */
  private async compareCustomersWithConverter(
    context: Context,
    { pkg }: Opened,
    expectation: WalletExpectation,
    plan: PlanShape,
  ): Promise<void> {
    const planDiffers =
      BigInt(expectation.totals.openings.count) !== BigInt(n(plan.wallet?.positive?.count)) ||
      expectation.totals.openings.sumMinor !== bigintOf(plan.wallet?.positive?.sumMinor) ||
      BigInt(expectation.totals.debts.count) !== BigInt(n(plan.wallet?.negative?.count)) ||
      expectation.totals.debts.sumMinor !== -bigintOf(plan.wallet?.negative?.sumMinor);
    const openings = await crossCheckConverterMoney(
      expectation.openings,
      pkg.iterJsonl(OPENINGS_PATH),
      'legacy:opening:',
    );
    const debts = await crossCheckConverterMoney(
      expectation.debts,
      pkg.iterJsonl(DEBTS_PATH),
      'legacy:debt:',
    );
    if (!planDiffers && perCustomerMismatches(openings) + perCustomerMismatches(debts) === 0) {
      return;
    }
    const counts: LegacyMigrationCodeCount[] = [
      ...perCustomerCounts('wallet_openings', openings),
      ...perCustomerCounts('legacy_debts', debts),
      ...(planDiffers ? [{ code: 'per_customer:plan_totals_differ', count: 1 }] : []),
    ];
    this.deps.logger.warn(
      { importId: context.importId, counts },
      "the converter's money records disagree with the importer customer by customer; the dry run is refused",
    );
    throw new LegacyMigrationStepFailure(
      'DRY_RUN_MISMATCH',
      "The converter's per-customer money records differ from the importer's plan.",
      { counts },
    );
  }

  /**
   * The converter's wallet-history verdicts (`wallet_history_checks.jsonl`,
   * `wallet_difference_analysis.jsonl`): archived as history and NEVER applied — the snapshot
   * `Balance` is the opening figure. Their contradictions are REPORTED as dry-run warnings.
   * Only a record whose own reading of the snapshot cell differs from the importer's blocks
   * (`DRY_RUN_MISMATCH`): then the figure every opening is taken from is itself in dispute.
   */
  private async walletHistoryOf(
    context: Context,
    { pkg }: Opened,
    expectation: WalletExpectation,
  ): Promise<WalletHistoryVerdicts> {
    const verdicts = await walletHistoryVerdicts(
      expectation.snapshot,
      pkg.has(WALLET_HISTORY_CHECKS_PATH) ? pkg.iterJsonl(WALLET_HISTORY_CHECKS_PATH) : null,
      pkg.has(WALLET_DIFFERENCES_PATH) ? pkg.iterJsonl(WALLET_DIFFERENCES_PATH) : null,
    );
    if (verdicts.notMatching + verdicts.differences > 0) {
      this.deps.logger.warn(
        {
          importId: context.importId,
          notMatching: verdicts.notMatching,
          differences: verdicts.differences,
        },
        'the wallet history contradicts some snapshot balances; the snapshot balance stays the opening figure',
      );
    }
    if (verdicts.snapshotDisagrees > 0) {
      throw new LegacyMigrationStepFailure(
        'DRY_RUN_MISMATCH',
        "The converter's reading of the snapshot balance differs from the importer's.",
        {
          counts: [
            { code: 'wallet_history:snapshot_disagrees', count: verdicts.snapshotDisagrees },
          ],
        },
      );
    }
    return verdicts;
  }

  /** A refusal becomes a step verdict with its contract code; anything else passes through. */
  private classify(error: unknown, context: Context): unknown {
    if (error instanceof LegacyMigrationStepFailure) return error;
    if (error instanceof LegacyMigrationRetry) return error;
    // Only the code and the error's type are logged: a refusal's message can name a path or
    // a value from the package (L3).
    const fail = (code: LegacyNxpkgErrorCode, counts?: readonly LegacyMigrationCodeCount[]) => {
      this.deps.logger.warn(
        { importId: context.importId, code, err: errorKind(error) },
        'a Mirza package step refused',
      );
      return new LegacyMigrationStepFailure(code, 'The package step refused.', {
        cause: error,
        ...(counts === undefined ? {} : { counts }),
      });
    };
    if (error instanceof NxpkgError) return fail(error.code);
    if (error instanceof NxpkgImportRefused) {
      // The importer's DRY_RUN_MISMATCH carries the import's own tallies: set beside the
      // approved dry run's, only the numbers that MOVED are kept, both sides of each.
      if (
        error.code === 'DRY_RUN_MISMATCH' &&
        error.counts !== null &&
        context.dryRunReport !== null
      ) {
        return fail(error.code, mismatchCounts(context.dryRunReport, error.counts));
      }
      return fail(
        error.code,
        error.counts === null
          ? undefined
          : Object.entries(nonZero(error.counts)).map(([code, count]) => ({ code, count })),
      );
    }
    if (error instanceof PanelMappingRefused) return fail('PANEL_TARGET_MISMATCH');
    if (error instanceof LegacySourceRefused)
      return fail('IMPORT_FAILED', sourceRefusalCounts(error));
    if (error instanceof Error && error.name === 'LegacyImportInterrupted') return error;
    if (isNexaError(error) && error.code === LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT) {
      if (isTransientRunConflict(error.message)) {
        return new LegacyMigrationRetry('RUN_CONFLICT', { cause: error });
      }
      return fail('IMPORT_FAILED');
    }
    // Any other typed refusal that names its contract code (`LegacyHistoryIngestRefused`, …).
    const code = (error as { code?: unknown } | null)?.code;
    if (
      error instanceof Error &&
      typeof code === 'string' &&
      (LEGACY_NXPKG_ERROR_CODES as readonly string[]).includes(code)
    ) {
      return fail(code as LegacyNxpkgErrorCode);
    }
    // A CLI refusal (usage, guard, archive, cutover): the importer said no, nothing written.
    if (
      error instanceof Error &&
      [
        'UsageError',
        'InvoiceArchiveRefused',
        'InvoiceArchiveStagingRefused',
        'LegacyCutoverRefused',
        'InventoryUsageError',
      ].includes(error.constructor.name)
    ) {
      return fail('IMPORT_FAILED');
    }
    return error;
  }
}

/**
 * What the owner sees of a source refusal beside `IMPORT_FAILED`: its own code (a fixed
 * vocabulary), and for a schema refusal one `CODE:table.column` per column named
 * (`LegacySourceRefused.columns`: identifiers from NEXA's read definitions, never a value).
 * The detail sentence itself stays in no row (L3).
 */
export function sourceRefusalCounts(error: LegacySourceRefused): LegacyMigrationCodeCount[] {
  if (error.columns.length === 0) return [{ code: error.code, count: 1 }];
  return [...new Set(error.columns)].map((column) => ({
    code: `${error.code}:${column}`,
    count: 1,
  }));
}

/**
 * The importer's `RUN_CONFLICT`s that pass on their own: another process holds the tenant's
 * importer claim (the CLI, or a replica whose lease expired while its importer still ran), or
 * another run is RUNNING. Every other `RUN_CONFLICT` (another mapping, a changed source, a
 * different ownership hold, …) is a verdict. Matched on the importer's own fixed sentences.
 */
export const TRANSIENT_RUN_CONFLICT_PREFIXES = [
  'Another importer process is applying',
  "Another importer process holds this tenant's import claim",
  'Another legacy import run is RUNNING for this tenant',
  'A concurrent legacy import run started and finished',
  "The importer's claim on this tenant was lost",
] as const;

export function isTransientRunConflict(message: string): boolean {
  return TRANSIENT_RUN_CONFLICT_PREFIXES.some((prefix) => message.startsWith(prefix));
}

/** The CLI's `--expected-*` flags for the six values beside the source (production-like). */
function cutoverFlags(values: LegacyMigrationCutoverValues | undefined): string[] {
  if (values === undefined) return [];
  return [
    '--expected-panel-map-fingerprint',
    values.panelMapFingerprint,
    '--expected-inventory-fingerprint',
    values.inventoryFingerprint,
    '--expected-products-fingerprint',
    values.productsFingerprint,
    '--expected-invoice-archive-fingerprint',
    values.invoiceArchiveFingerprint,
    '--expected-freeze-proof-sha256',
    values.freezeProofSha256,
    '--expected-final-dump-sha256',
    values.finalDumpSha256,
  ];
}

function requireFingerprint(context: Context): string {
  if (context.sourceFingerprint === null) {
    throw new LegacyMigrationStepFailure('NXPKG_CONTAINER_INVALID', 'No verified fingerprint.');
  }
  return context.sourceFingerprint;
}

/**
 * The live legacy services the import places, per `code_panel`: invoices whose `Status` is
 * one of `LEGACY_LIVE_STATUSES` (exact) and whose `is_test` is 0 — the same "live real"
 * invoices the panel-mapping completeness rule counts (`panelMappingCompleteness`). The
 * operator reads this beside each target while choosing its NEXA panel (Codex review on
 * #278: it was a constant 0).
 */
async function liveServicesByCodePanel(
  session: LegacySourceSession,
): Promise<ReadonlyMap<string, number>> {
  // Described AND carried by the snapshot's rows file (`readableColumns`): a column only the
  // catalogue lists cannot be read, so it counts as absent here as it does for the importer.
  const readable = session.readableColumns?.('invoice') ?? null;
  const present = new Set(
    (await session.columns())
      .filter((c) => c.table === 'invoice' && (readable === null || readable.has(c.column)))
      .map((c) => c.column),
  );
  const out = new Map<string, number>();
  if (!present.has('code_panel') || !present.has('Status') || !present.has('is_test')) return out;
  const live: ReadonlySet<string> = new Set(LEGACY_LIVE_STATUSES);
  for await (const [code, status, isTest] of session.rows('invoice', [
    'code_panel',
    'Status',
    'is_test',
  ])) {
    if (status === null || status === undefined || !live.has(status)) continue;
    if (isTest?.trim() !== '0') continue;
    const key = code?.trim() ?? '';
    if (key === '') continue;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/** The package's SELECTED RickPanel targets: what the operator binds (others stay unresolved). */
async function selectedTargets(
  pkg: NxpkgPackage,
  liveByCodePanel: ReadonlyMap<string, number>,
): Promise<LegacyMigrationPanelTarget[]> {
  const out: LegacyMigrationPanelTarget[] = [];
  if (!pkg.has(NXPKG_PANEL_TARGETS_PATH)) return out;
  for await (const record of pkg.iterJsonl(NXPKG_PANEL_TARGETS_PATH)) {
    const code = record['code_panel'];
    const target = record['target'] as Record<string, unknown> | null | undefined;
    if (typeof code !== 'string' || target === null || target === undefined) continue;
    out.push({
      codePanel: code,
      providerType: typeof target['provider_type'] === 'string' ? target['provider_type'] : '',
      services: liveByCodePanel.get(code.trim()) ?? 0,
    });
  }
  return out;
}

/** A non-negative safe integer from a report section, or 0. */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** A `{ code: count }` section as sorted code counts (non-zero only). */
function codeCountsOf(value: unknown): LegacyMigrationCodeCount[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value as Record<string, unknown>)
    .map(([code, count]) => ({ code, count: countOf(count) }))
    .filter((row) => row.count > 0)
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

function runIdOf(report: LegacyImportReport): string | null {
  const run = report.sections['run'] as { id?: unknown } | undefined;
  return typeof run?.id === 'string' ? run.id : null;
}

interface PlanShape {
  readonly customers?: {
    readonly source?: number;
    readonly importable?: number;
    readonly new?: number;
    readonly existing?: number;
    readonly invalidIdentity?: number;
    readonly manualReview?: Readonly<Record<string, number>>;
  };
  readonly wallet?: {
    readonly currency?: string;
    readonly positive?: { readonly count?: number; readonly sumMinor?: bigint | string | number };
    readonly negative?: { readonly count?: number; readonly sumMinor?: bigint | string | number };
    readonly openings?: Readonly<Record<string, number>>;
    readonly debitOpenings?: Readonly<Record<string, number>>;
  };
  readonly trials?: Readonly<Record<string, number>>;
  readonly products?: {
    readonly distinctShapes?: number;
    readonly existingShapes?: number;
    readonly newShapes?: number;
    readonly unmappable?: Readonly<Record<string, number>>;
    readonly predictedTariff?: Readonly<Record<string, number>>;
  };
  readonly services?: {
    readonly candidates?: number;
    readonly categories?: Readonly<Record<string, number>>;
  };
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Minor units as the importer reported them: a bigint, a safe integer, or a decimal string. */
function bigintOf(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?(0|[1-9][0-9]*)$/u.test(v)) return BigInt(v);
  // Never a guessed 0: an amount nobody can read is a refusal (L5).
  throw new LegacyMigrationStepFailure(
    'IMPORT_FAILED',
    'The importer reported an unreadable amount.',
  );
}

/** Money stays a decimal string of minor units (L5). */
const minor = (v: unknown): string => bigintOf(v).toString();

const sum = (record: Readonly<Record<string, number>> | undefined, keys?: readonly string[]) =>
  Object.entries(record ?? {})
    .filter(([key]) => keys === undefined || keys.includes(key))
    .reduce((a, [, b]) => a + n(b), 0);

const byCode = (a: { readonly code: string }, b: { readonly code: string }) =>
  a.code < b.code ? -1 : a.code > b.code ? 1 : 0;

function nonZero(counts: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0));
}

/** The trial plans that write an override; the rest leave NEXA's policy (or a decision) alone. */
const TRIAL_WRITES = ['LEGACY_NO_TRIALS', 'LEGACY_TRIAL_CONSUMED', 'LEGACY_LIMIT_UNREADABLE'];

interface InventoryTableLine {
  readonly name: string;
  readonly class: LegacyTableClass;
  readonly rows: number | null;
}

/** The unclassified tables' NAMES (never a row): what the operator must have classified. */
function unclassifiedTables(tables: readonly InventoryTableLine[]): string[] {
  return tables.filter((t) => t.class === 'UNCLASSIFIED').map((t) => t.name);
}

function inventoryIncomplete(inventory: {
  readonly verdict: string;
  readonly tables: readonly InventoryTableLine[];
}): string {
  const names = unclassifiedTables(inventory.tables);
  const listed = names.slice(0, 20).join(', ');
  return names.length === 0
    ? `The inventory is not complete (${inventory.verdict}).`
    : `The inventory is not complete: ${String(names.length)} unclassified table(s): ${listed}${names.length > 20 ? ', …' : ''}.`;
}

/**
 * One legacy table's accounting line, `table:<NEXA class>:<name>` (`nxpkg-importer.md` §5a). With the package's
 * coverage row: the converter's own breakdown, placed by where NEXA puts it — a supported
 * table's exported rows are imported; a history table's carried rows are archived; review
 * rows are quarantined (a person's queue); an excluded table's rows are skipped. Without
 * one: the row count only. An UNCLASSIFIED table's rows are all quarantined.
 */
function tableSection(
  table: InventoryTableLine,
  coverage: NxpkgCoverageEntry | undefined,
): LegacyMigrationSectionCounts {
  const rows = table.rows ?? 0;
  const line = (counts: Omit<LegacyMigrationSectionCounts, 'section' | 'source'>) => ({
    section: `table:${table.class}:${table.name}`,
    source: rows,
    ...counts,
  });
  if (table.class === 'UNCLASSIFIED') {
    return line({ imported: 0, archived: 0, skipped: 0, quarantined: rows });
  }
  if (table.class === 'SECRETS_MANUAL' || table.class === 'OWNER_DECISION') {
    return line({ imported: 0, archived: 0, skipped: rows, quarantined: 0 });
  }
  if (coverage === undefined) {
    return line({ imported: 0, archived: 0, skipped: 0, quarantined: 0 });
  }
  return table.class === 'SUPPORTED'
    ? line({
        imported: coverage.exported,
        archived: coverage.archived,
        skipped: coverage.skipped,
        quarantined: coverage.review,
      })
    : line({
        imported: 0,
        archived: coverage.exported + coverage.archived,
        skipped: coverage.skipped,
        quarantined: coverage.review,
      });
}

function providerPanels(report: LegacyImportReport): unknown[] {
  const provider = report.sections['provider'] as { readonly panels?: unknown } | undefined;
  return Array.isArray(provider?.panels) ? (provider.panels as unknown[]) : [];
}

/**
 * How many production panels the importer's provider section reports without a complete
 * read. Exported for its own test.
 */
export function providerIncomplete(report: LegacyImportReport): number {
  // Fail closed: anything that is not a panel read reported exactly complete counts — except
  // a per-name read that HELD and left needed names unresolved, whose invoices the inventory
  // hold quarantines (`PROVIDER_INVENTORY_UNRESOLVED` / `_QUARANTINED` report it).
  return providerPanels(report).filter(readFailed).length;
}

/**
 * A provider panel line whose READ failed. `complete: false` with reason `UNRESOLVED` and a
 * resolution object is a read that held (the importer's `inventoryReadFailed`); every other
 * line not exactly `complete: true` failed.
 */
function readFailed(p: unknown): boolean {
  const panel = p as { complete?: unknown; reason?: unknown; resolution?: unknown } | null;
  if (panel?.complete === true) return false;
  // Held only when the per-name read found a gap-free decision walk (review H P1).
  return !(
    panel?.reason === 'UNRESOLVED' &&
    typeof panel.resolution === 'object' &&
    panel.resolution !== null &&
    !Array.isArray(panel.resolution) &&
    (panel.resolution as { gapFree?: unknown }).gapFree === true
  );
}

/**
 * The incomplete panels by WHY (`TOTAL_CHANGED`, `COUNT_MISMATCH`, `WALKS_DIFFER`, a failure
 * kind such as `TIMEOUT`, …), as `PROVIDER_INVENTORY_INCOMPLETE:<reason>` warnings: what tells
 * a panel that moved during the walk from a list that never adds up. A reason outside the
 * closed shape is `UNKNOWN`, never echoed. Exported for its own test.
 */
export function providerIncompleteReasons(report: LegacyImportReport): LegacyMigrationCodeCount[] {
  const byReason = new Map<string, number>();
  for (const p of providerPanels(report)) {
    const panel = p as { complete?: unknown; reason?: unknown } | null;
    if (!readFailed(p)) continue;
    const reason = closedReason(panel?.reason);
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  return [...byReason].map(([reason, count]) => ({
    code: `${LEGACY_MIGRATION_PROVIDER_INVENTORY_INCOMPLETE}:${reason}`,
    count,
  }));
}

/** A reason in the closed shape, or `UNKNOWN`: a provider string is never echoed. */
function closedReason(value: unknown): string {
  return typeof value === 'string' && /^[A-Z][A-Z_]{0,39}$/u.test(value) ? value : 'UNKNOWN';
}

/** A count the report can carry: a safe non-negative integer, else 0 (never trusted further). */
function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * The production panels that changed while read and whose needed usernames the importer
 * decided one by one (a non-null `resolution`): `PROVIDER_INVENTORY_CHURN` (how many panels),
 * one `PROVIDER_INVENTORY_CHURN:<reason>` per reason, and `PROVIDER_INVENTORY_UNRESOLVED`
 * (needed names no gap-free walk decided, when any). Informational: the invoices those names
 * leave `INVENTORY_INCOMPLETE` are the inventory hold's (`PROVIDER_INVENTORY_QUARANTINED`),
 * quarantined rather than blocking; only a report WITHOUT the hold blocks on them.
 * Counts only, never a name. Exported for its own test.
 */
export function providerChurnWarnings(report: LegacyImportReport): LegacyMigrationCodeCount[] {
  let panels = 0;
  let unresolved = 0;
  const byReason = new Map<string, number>();
  for (const p of providerPanels(report)) {
    const resolution = (p as { resolution?: unknown } | null)?.resolution;
    if (typeof resolution !== 'object' || resolution === null || Array.isArray(resolution)) {
      continue;
    }
    const r = resolution as { reason?: unknown; unresolved?: unknown };
    // A panel the backup asks nothing of was never read: it did not change while read.
    if (r.reason === 'NOTHING_NEEDED') continue;
    // A panel that held still but whose rows carry no usable creation time did not change
    // either (Codex): its undecided names are counted, never reported as churn.
    if (r.reason === 'NO_CREATION_TIME') {
      unresolved += safeCount(r.unresolved);
      continue;
    }
    panels += 1;
    const reason = closedReason(r.reason);
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    unresolved += safeCount(r.unresolved);
  }
  if (panels === 0) {
    return unresolved > 0
      ? [{ code: LEGACY_MIGRATION_PROVIDER_INVENTORY_UNRESOLVED, count: unresolved }]
      : [];
  }
  return [
    { code: LEGACY_MIGRATION_PROVIDER_INVENTORY_CHURN, count: panels },
    ...[...byReason].map(([reason, count]) => ({
      code: `${LEGACY_MIGRATION_PROVIDER_INVENTORY_CHURN}:${reason}`,
      count,
    })),
    ...(unresolved > 0
      ? [{ code: LEGACY_MIGRATION_PROVIDER_INVENTORY_UNRESOLVED, count: unresolved }]
      : []),
  ];
}

/**
 * The per-name panel reads' DIAGNOSTICS, one entry per production panel whose needed names were
 * decided one at a time (`docs/rickpanel-inventory.md` §Diagnostics): why each walk was or was
 * not gap-free and decisive, and why each unresolved name stayed so. Every entry is re-validated
 * against the contract's schema — closed codes, counts, a panel id — and one that does not fit
 * is left out rather than passed through: nothing a provider sent is echoed. A panel the backup
 * asked nothing of was never read and has none. Diagnostics only; no rule reads them.
 * Exported for its own test.
 */
export function providerDiagnostics(report: LegacyImportReport): LegacyInventoryPanelDiagnostics[] {
  const out: LegacyInventoryPanelDiagnostics[] = [];
  for (const p of providerPanels(report)) {
    const panel = p as {
      panelId?: unknown;
      resolution?: { reason?: unknown; needed?: unknown; unresolved?: unknown } | null;
      diagnostics?: { perName?: Record<string, unknown> } | null;
    } | null;
    const resolution = panel?.resolution;
    const perName = panel?.diagnostics?.perName;
    if (typeof resolution !== 'object' || resolution === null) continue;
    if (resolution.reason === 'NOTHING_NEEDED') continue;
    if (typeof perName !== 'object' || perName === null) continue;
    const parsed = legacyInventoryPanelDiagnosticsSchema.safeParse({
      panelId: panel?.panelId,
      reason: closedReason(resolution.reason),
      needed: safeCount(resolution.needed),
      unresolved: safeCount(resolution.unresolved),
      decisionWalk: perName['decisionWalk'],
      unresolvedByCause: perName['unresolvedByCause'],
      walks: perName['walks'],
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * The dry run's provider warnings: `PROVIDER_INVENTORY_INCOMPLETE` (how many production panels)
 * and one `PROVIDER_INVENTORY_INCOMPLETE:<reason>` per reason, when a read was not complete;
 * then the churn warnings of the panels resolved one name at a time (`providerChurnWarnings`).
 * None when every read was one complete snapshot. Exported for its own test.
 */
export function providerWarnings(report: LegacyImportReport): LegacyMigrationCodeCount[] {
  const incomplete = providerIncomplete(report);
  return [
    ...(incomplete === 0
      ? []
      : [
          { code: LEGACY_MIGRATION_PROVIDER_INVENTORY_INCOMPLETE, count: incomplete },
          ...providerIncompleteReasons(report),
        ]),
    ...providerChurnWarnings(report),
  ];
}

/**
 * What a `DRY_RUN_MISMATCH` refusal records: each number the import's plan and the approved
 * dry run's report both carry, where the two differ — `dryrun:<key>` and `apply:<key>` side by
 * side (zeros kept, so a pair always reads as one; the TARGET gate's `dryrun:` count, refused
 * before anything was read, is the one unpaired shape). When the digest moved and no compared
 * number did, the change is in what the counts do not show (which invoice adopts which
 * account, a trial, a status): said as `plan:changed_beyond_compared_counts`. Counts only.
 * Exported for its own test.
 */
export function mismatchCounts(
  dryRun: Pick<LegacyMigrationDryRunReport, 'sections' | 'warnings' | 'inventoryHold'>,
  applyCounts: Readonly<Record<string, number>>,
): LegacyMigrationCodeCount[] {
  // The approval's digest is an earlier format of this same plan: nothing moved but the format.
  if (applyCounts[PLAN_DIGEST_FORMAT_OUTDATED] !== undefined) {
    return [{ code: PLAN_DIGEST_FORMAT_OUTDATED, count: 1 }];
  }
  const section = (name: string) => dryRun.sections.find((x) => x.section === name);
  const warning = (code: string) =>
    dryRun.warnings.filter((w) => w.code === code).reduce((a, w) => a + w.count, 0);
  const dry = new Map<string, number | undefined>([
    [
      'customers:importable',
      section('customers') === undefined
        ? undefined
        : n(section('customers')?.imported) + n(section('customers:existing')?.source),
    ],
    ['customers:new', section('customers')?.imported],
    ['wallet:positive', section('wallet_openings')?.source],
    ['wallet:negative', section('wallet_debit_openings')?.source],
    ['products:distinct_shapes', section('products')?.source],
    [
      'panels:inventory_incomplete',
      legacyMigrationDryRunInventoryIncomplete(dryRun.warnings, dryRun.inventoryHold),
    ],
    ['services:ADOPTION_ELIGIBLE', section('services')?.imported],
  ]);
  // The approved hold, when the report carries one: how many it held, and none unheld.
  if (validInventoryHold(dryRun.inventoryHold)) {
    dry.set('inventory_hold:invoices', dryRun.inventoryHold.invoices);
    dry.set('inventory_hold:unheld', 0);
    // The approved hold is, by definition, the one its dry run recorded: an apply that cannot
    // read its keys back under its digest says `apply:inventory_hold:verified` 0.
    dry.set('inventory_hold:verified', 1);
  }
  for (const category of SERVICE_CANDIDATE_CATEGORIES) {
    if (category !== 'ADOPTION_ELIGIBLE') dry.set(`services:${category}`, warning(category));
  }
  const out: LegacyMigrationCodeCount[] = [];
  for (const [code, value] of Object.entries(applyCounts).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (!code.startsWith('apply:')) continue;
    const key = code.slice('apply:'.length);
    const before = dry.get(key);
    if (before === undefined || before === value) continue;
    out.push({ code: `dryrun:${key}`, count: before }, { code, count: value });
  }
  if (out.length === 0) out.push({ code: 'plan:changed_beyond_compared_counts', count: 1 });
  return out;
}

/** The importer's dry run, summarised as the contract's counts. Never a row. Exported for its own test. */
export function dryRunReportOf(
  report: LegacyImportReport,
  plan: PlanShape,
  hold: NxpkgOwnershipHold | null,
  decisions: VerifiedOwnershipDecisions | null,
  history: readonly LegacyMigrationCodeCount[],
  extra: {
    readonly invoiceArchiveRows: number;
    /** The importer's count of held invoices it would otherwise have adopted, if reported. */
    readonly holdChangedCategory: number | null;
    readonly converterTotalsAbsent: boolean;
    /** The converter's wallet-history verdicts, counted (absent: not read). */
    readonly walletHistory?: WalletHistoryVerdicts | null;
    /** The package inventory: every legacy table, its class and rows (§5a). */
    readonly inventoryVerdict: string;
    readonly tables: readonly InventoryTableLine[];
    readonly coverage: ReadonlyMap<string, NxpkgCoverageEntry> | null;
  },
): Omit<LegacyMigrationDryRunReport, 'cutover' | 'planTalliesDigest'> {
  const inventoryHold = inventoryHoldOf(report);
  // L5: the currency is the importer's, stated — never assumed. A Fresh Migration's ledger is
  // Toman (IRT): legacy balances are Toman, and the importer's audit blocks any other.
  const currency = plan.wallet?.currency;
  if (typeof currency !== 'string' || currency.length === 0) {
    throw new LegacyMigrationStepFailure('IMPORT_FAILED', 'The importer reported no currency.');
  }
  if (currency !== 'IRT') {
    throw new LegacyMigrationStepFailure('NXPKG_MONEY_UNIT', 'The wallet currency is not IRT.');
  }
  const customers = plan.customers ?? {};
  const manual = sum(customers.manualReview);
  const categories = plan.services?.categories ?? {};
  const eligible = n(categories['ADOPTION_ELIGIBLE']);
  const candidates = n(plan.services?.candidates);
  // M9: quarantined = the holds that CHANGED a category (an eligible invoice held back), as
  // the importer counted them; without that count, at most every AMBIGUOUS_OWNERSHIP invoice.
  const changed =
    extra.holdChangedCategory ??
    Math.min(hold?.hold.size ?? 0, n(categories['AMBIGUOUS_OWNERSHIP']));
  const openings = plan.wallet?.openings ?? {};
  const debits = plan.wallet?.debitOpenings ?? {};
  const credit = (k: string) => n(openings[k]) - n(debits[k]);
  const trials = plan.trials ?? {};
  const products = plan.products ?? {};
  const historyTotal = history.reduce((a, h) => a + h.count, 0);
  const sections: LegacyMigrationSectionCounts[] = [
    {
      section: 'customers',
      source: n(customers.source),
      imported: n(customers.new),
      archived: 0,
      skipped: n(customers.existing) + n(customers.invalidIdentity),
      quarantined: manual,
    },
    // Fresh Migration: an existing customer cannot be (the fresh guard), but it is reported
    // apart from a legacy row whose identity is invalid — two different facts.
    {
      section: 'customers:existing',
      source: n(customers.existing),
      imported: 0,
      archived: 0,
      skipped: n(customers.existing),
      quarantined: 0,
    },
    {
      section: 'customers:invalid_identity',
      source: n(customers.invalidIdentity),
      imported: 0,
      archived: 0,
      skipped: n(customers.invalidIdentity),
      quarantined: 0,
    },
    {
      section: 'wallet_openings',
      source: n(plan.wallet?.positive?.count),
      imported: credit('POST'),
      archived: 0,
      skipped: credit('ALREADY_POSTED'),
      quarantined: credit('CONFLICT'),
    },
    // Owner decision 2026-10-17: a negative balance is a DEBIT opening, not a legacy debt.
    {
      section: 'wallet_debit_openings',
      source: n(plan.wallet?.negative?.count),
      imported: n(debits['POST']),
      archived: 0,
      skipped: n(debits['ALREADY_POSTED']),
      quarantined: n(debits['CONFLICT']),
    },
    {
      section: 'trials',
      source: sum(trials),
      imported: sum(trials, TRIAL_WRITES),
      archived: 0,
      skipped: sum(trials) - sum(trials, TRIAL_WRITES),
      quarantined: 0,
    },
    {
      section: 'products',
      source: n(products.distinctShapes),
      imported: n(products.newShapes),
      archived: 0,
      skipped: n(products.existingShapes),
      // A shape with no (or several) current tariffs stays UNRESOLVED: manual review.
      quarantined:
        n(products.predictedTariff?.['NO_CURRENT_TARIFF']) +
        n(products.predictedTariff?.['AMBIGUOUS_TARIFF']),
    },
    {
      section: 'invoice_archive',
      source: extra.invoiceArchiveRows,
      imported: 0,
      archived: extra.invoiceArchiveRows,
      skipped: 0,
      quarantined: 0,
    },
    {
      section: 'services',
      source: candidates,
      imported: eligible,
      archived: Math.max(0, candidates - eligible - changed),
      skipped: 0,
      quarantined: changed,
    },
    {
      section: 'history',
      source: historyTotal,
      imported: 0,
      archived: historyTotal,
      skipped: 0,
      quarantined: 0,
    },
    ...history.map((h) => ({
      section: `history:${h.code}`,
      source: h.count,
      imported: 0,
      archived: h.count,
      skipped: 0,
      quarantined: 0,
    })),
    ...extra.tables.map((t) => tableSection(t, extra.coverage?.get(t.name))),
  ];
  const reasons = hold?.reasons ?? {};
  const ownership: LegacyMigrationOwnershipSummary = {
    decisionsProvided: decisions !== null,
    proven: hold?.proven.size ?? 0,
    adminApprovedUnverified: hold?.attested.size ?? 0,
    quarantined: n(reasons.DECISION_QUARANTINED),
    rejected: n(reasons.DECISION_REJECTED),
    pending: n(reasons.DECISION_PENDING),
    stale: n(reasons.DECISION_STALE),
  };
  const warnings = [
    ...Object.entries(categories)
      .filter(([code, count]) => code !== 'ADOPTION_ELIGIBLE' && n(count) > 0)
      .map(([code, count]) => ({ code, count: n(count) })),
    ...Object.entries(products.unmappable ?? {})
      .filter(([, count]) => n(count) > 0)
      .map(([code, count]) => ({ code: `PRODUCT_${code}`, count: n(count) })),
    ...(extra.holdChangedCategory === null && (hold?.hold.size ?? 0) > 0
      ? [{ code: 'OWNERSHIP_HOLD_CHANGED_NOT_REPORTED', count: hold?.hold.size ?? 0 }]
      : []),
    ...(extra.converterTotalsAbsent ? [{ code: 'CONVERTER_TOTALS_ABSENT', count: 1 }] : []),
    // The wallet history's contradictions with the snapshot balance: reported, never applied.
    ...walletHistoryWarnings(extra.walletHistory ?? null),
    // The invoices the inventory hold quarantines: kept as history and an OPEN review
    // candidate, never adopted; not a blocker (the contract rule subtracts them).
    ...(inventoryHold !== undefined && inventoryHold.invoices > 0
      ? [{ code: LEGACY_MIGRATION_PROVIDER_INVENTORY_QUARANTINED, count: inventoryHold.invoices }]
      : []),
    // The production panels whose LIVE RickPanel inventory was not complete. Their invoices
    // are the services' INVENTORY_INCOMPLETE, and the import reads the panel again: if it
    // comes out different — complete, or another set of accounts — the plan is another plan
    // and APPLY refuses DRY_RUN_MISMATCH. Said here, so no owner approves a plan without
    // knowing that; a production-like target refuses to approve it at all. Then the panels
    // that changed while read and were decided one needed name at a time (CHURN): not a
    // blocker in itself — a name left unresolved is its invoice's INVENTORY_INCOMPLETE, which
    // the inventory hold quarantines (`PROVIDER_INVENTORY_QUARANTINED`, below).
    ...providerWarnings(report),
    // Said on every target, not only where it refuses (a staging dry run must show it too).
    // Its own code: `INVENTORY_INCOMPLETE` is the services category (a panel's live read).
    ...(extra.inventoryVerdict === 'COMPLETE'
      ? []
      : [
          {
            code: 'TABLE_INVENTORY_INCOMPLETE',
            count: Math.max(1, extra.tables.filter((t) => t.class === 'UNCLASSIFIED').length),
          },
        ]),
  ].sort(byCode);
  const diagnostics = providerDiagnostics(report);
  return {
    importerVerdict: report.verdict ?? 'DRY_RUN',
    sections,
    warnings,
    quarantine: Object.entries({ ...(customers.manualReview ?? {}), ...reasons })
      .filter(([, count]) => n(count) > 0)
      .map(([code, count]) => ({ code, count: n(count) }))
      .sort(byCode),
    // A Fresh Migration starts from an empty ledger: "before" is zero by the §6 guard.
    wallets: {
      currency,
      customers: n(plan.wallet?.positive?.count),
      beforeTotalMinor: '0',
      afterTotalMinor: minor(plan.wallet?.positive?.sumMinor ?? 0n),
    },
    // Magnitudes, as the legacy debt record stores them and the converter writes them.
    debts: {
      currency,
      count: n(plan.wallet?.negative?.count),
      totalMinor: (-bigintOf(plan.wallet?.negative?.sumMinor ?? 0n)).toString(),
    },
    ownership,
    // Why each per-name panel read decided what it did (diagnostics only; absent when none).
    ...(diagnostics.length === 0 ? {} : { providerDiagnostics: diagnostics }),
    ...(inventoryHold === undefined ? {} : { inventoryHold }),
  };
}

/**
 * The importer dry run's inventory hold (`sections.inventoryHold`), as the contract's v1 shape,
 * or undefined when the importer reported none or anything other than a COMPUTED hold with
 * nothing unheld (a dry run is never given one). Undefined fails closed: every
 * `INVENTORY_INCOMPLETE` service then blocks a production-like approval, as before.
 */
function inventoryHoldOf(report: LegacyImportReport): LegacyMigrationInventoryHold | undefined {
  const section = report.sections['inventoryHold'] as
    { invoices?: unknown; digest?: unknown; given?: unknown; unheld?: unknown } | undefined;
  if (section === undefined || section.given !== false || section.unheld !== 0) return undefined;
  const hold = {
    version: LEGACY_MIGRATION_INVENTORY_HOLD_VERSION,
    invoices: section.invoices,
    digest: section.digest,
  };
  return validInventoryHold(hold) ? hold : undefined;
}

// --- the converter's own totals (M8) ---------------------------------------------------------

const CUSTOMERS_PATH = 'records/customers.jsonl';
const OPENINGS_PATH = 'records/wallet_opening_balances.jsonl';
const DEBTS_PATH = 'records/legacy_debts.jsonl';
const WALLET_HISTORY_CHECKS_PATH = 'records/wallet_history_checks.jsonl';
const WALLET_DIFFERENCES_PATH = 'records/wallet_difference_analysis.jsonl';

/** One money file's per-customer mismatches as the contract's counts (non-zero only). */
function perCustomerCounts(file: string, tally: PerCustomerTally): LegacyMigrationCodeCount[] {
  return PER_CUSTOMER_MISMATCH_KEYS.filter((k) => tally[k] > 0).map((k) => ({
    code: `per_customer:${file}:${k}`,
    count: tally[k],
  }));
}

/**
 * The wallet-history verdicts as dry-run warnings: how many checks do not confirm the snapshot
 * balance (and by verdict), how many differences the converter analysed (and by cause), and
 * the records that could not be set beside a source row. Counts and codes only.
 */
export function walletHistoryWarnings(
  verdicts: WalletHistoryVerdicts | null,
): LegacyMigrationCodeCount[] {
  if (verdicts === null) return [];
  const out: LegacyMigrationCodeCount[] = [];
  const add = (code: string, count: number) => {
    if (count > 0) out.push({ code, count });
  };
  add('WALLET_HISTORY_NOT_MATCHING_SNAPSHOT', verdicts.notMatching);
  for (const [verdict, count] of Object.entries(verdicts.byVerdict)) {
    if (verdict !== 'MATCHES_SNAPSHOT') add(`WALLET_HISTORY_CHECK:${verdict}`, count);
  }
  add('WALLET_DIFFERENCE_ANALYSED', verdicts.differences);
  for (const [cause, count] of Object.entries(verdicts.byCause)) {
    add(`WALLET_DIFFERENCE:${cause}`, count);
  }
  add('WALLET_HISTORY_OPENING_NOT_SNAPSHOT', verdicts.openingNotSnapshot);
  add('WALLET_HISTORY_UNKNOWN_CUSTOMER', verdicts.unknownCustomer);
  return out;
}

interface ConverterTotals {
  readonly customers: bigint;
  readonly openings: { readonly count: bigint; readonly sumMinor: bigint };
  readonly debts: { readonly count: bigint; readonly sumMinor: bigint };
}

/**
 * What the converter itself wrote as operational records: null when the package carries none
 * of the three files (an older converter); a refusal when it carries only some, or a record
 * whose type, currency or amount is not what the content contract says.
 */
async function converterTotals(pkg: NxpkgPackage): Promise<ConverterTotals | null> {
  const present = [CUSTOMERS_PATH, OPENINGS_PATH, DEBTS_PATH].map((path) => pkg.has(path));
  if (present.every((p) => !p)) return null;
  if (!present.every(Boolean)) {
    throw new LegacyMigrationStepFailure(
      'DRY_RUN_MISMATCH',
      'The package carries only some of its operational record files.',
    );
  }
  let customers = 0n;
  for await (const record of pkg.iterJsonl(CUSTOMERS_PATH)) {
    if (record['record_type'] !== 'customer') {
      throw new LegacyMigrationStepFailure('NXPKG_TAMPERED', 'A customer record has another type.');
    }
    customers += 1n;
  }
  const money = async (path: string, type: string) => {
    let count = 0n;
    let total = 0n;
    for await (const record of pkg.iterJsonl(path)) {
      if (record['record_type'] !== type) {
        throw new LegacyMigrationStepFailure('NXPKG_TAMPERED', 'A money record has another type.');
      }
      const amount = record['amount_minor'];
      if (
        record['currency'] !== 'IRT' ||
        typeof amount !== 'string' ||
        !/^(0|[1-9][0-9]*)$/u.test(amount)
      ) {
        throw new LegacyMigrationStepFailure(
          'NXPKG_MONEY_UNIT',
          'A money record is not IRT minor units.',
        );
      }
      count += 1n;
      total += BigInt(amount);
    }
    return { count, sumMinor: total };
  };
  return {
    customers,
    openings: await money(OPENINGS_PATH, 'wallet_opening_balance'),
    debts: await money(DEBTS_PATH, 'legacy_debt'),
  };
}
