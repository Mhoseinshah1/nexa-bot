import { readFile } from 'node:fs/promises';
import {
  isNexaError,
  LEGACY_IMPORT_ERROR_CODES,
  LEGACY_NXPKG_ERROR_CODES,
  type ActorContext,
  type LegacyMigrationApplyReport,
  type LegacyMigrationCodeCount,
  type LegacyMigrationCutoverValues,
  type UnitOfWork,
  type LegacyMigrationDryRunReport,
  type LegacyMigrationOwnershipSummary,
  type LegacyMigrationPanelTarget,
  type LegacyMigrationSectionCounts,
  type LegacyMigrationVerifyReport,
  type LegacyNxpkgErrorCode,
  type TenantContext,
} from '@nexa/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { errorKind } from '../domain/import-lifecycle.js';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { runInventory } from '../../../../legacy-import-inventory.js';
import { freshCutoverFingerprints } from '../../../../legacy-import-cutover.js';
import type { LegacyCutoverService } from '../../legacy-cutover/application/legacy-cutover.service.js';
import { stopSalesHolds } from '../../legacy-cutover/domain/cutover-rules.js';
import {
  classifyTarget,
  evaluateProductionGuard,
  type TARGET_ACK_ENV,
  type TargetIdentity,
} from '../../legacy-importer/application/production-guard.js';
import { legacyImportRuns } from '../../../../infrastructure/persistence/schema.js';
import { NxpkgError } from '../../../../infrastructure/nxpkg/errors.js';
import type { NxpkgPackage } from '../../../../infrastructure/nxpkg/reader.js';
import type { LegacyImporterService } from '../../legacy-importer/application/legacy-importer.service.js';
import type { LegacyImportReport } from '../../legacy-importer/application/report.js';
import type { LegacySnapshot } from '../../legacy-importer/application/source-snapshot.js';
import { readImportV1Identity } from '../../legacy-importer/application/source-snapshot.js';
import { PanelMappingRefused } from '../../legacy-importer/application/panel-mapping.js';
import { LegacySourceRefused } from '../../legacy-importer/application/source-port.js';
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
import {
  readOwnershipRecords,
  verifyOwnershipDecisions,
} from '../../legacy-importer/infrastructure/nxpkg-ownership-decisions.js';
import type { LegacyHistoryIngest } from '../../legacy-history/application/legacy-history-ingest.js';
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
 * reason goes to the log, never to the row. An INTERRUPTED import is rethrown untouched, so
 * the executor resumes it rather than failing it.
 */
export interface NxpkgMigrationAdapterDeps {
  readonly db: Database;
  readonly importer: () => LegacyImporterService;
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
  async precheck(context: MigrationStepContext, step: 'DRY_RUN' | 'APPLY'): Promise<void> {
    if (!this.productionLikeTarget) return;
    const synthetic = context.verifyReport?.synthetic ?? true;
    if (synthetic) {
      // Never allowed, acknowledged or not (the evidence-class rule).
      throw new LegacyMigrationStepFailure(
        'IMPORT_FAILED',
        'A synthetic package is never imported into a production-like database.',
      );
    }
    const target = this.deps.target;
    const verdict =
      target === null
        ? { allowed: false as const }
        : evaluateProductionGuard({
            target,
            tenantId: context.scope.tenantId,
            env: this.deps.guardEnv(),
            allowProductionFlag: true,
            syntheticSource: false,
          });
    if (!verdict.allowed) throw new LegacyMigrationBlocked('TARGET_ACK_MISSING');
    if (step === 'DRY_RUN') return;

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
      try {
        fingerprint = (await readImportV1Identity(session)).fingerprint;
      } finally {
        await session.close();
      }
      const panelTargets = await selectedTargets(pkg);
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
      const observed = await this.observeReadSets(context, opened.connector, fingerprint);
      const run = await this.run('dry-run', context, opened);
      const history = await this.history(context, opened.pkg, true);
      const tallies = (run.report.sections['plan'] ?? {}) as PlanShape;
      const converter = await converterTotals(opened.pkg);
      const absent = this.compareWithConverter(context, converter, tallies);
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
      const importer = this.deps.importer();
      const common = {
        scope: context.scope,
        actor: context.actor,
        connector,
        expectedFingerprint: fingerprint,
        productionLikeTarget: this.productionLikeTarget,
      };
      context.signal.throwIfAborted();
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
      await importer.readProducts({
        ...common,
        expectedProductsFingerprint: approved.productsFingerprint,
      });
      context.signal.throwIfAborted();
      await importer.readInvoiceArchive({
        ...common,
        expectedInvoiceArchiveFingerprint: approved.invoiceArchiveFingerprint,
      });
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
        if ((await this.deps.importer().runningRun(context.scope)) !== null) {
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
    mode: 'dry-run' | 'import' | 'resume' | 'reconcile' | 'report',
    context: Context,
    { connector, pkg }: Opened,
  ): Promise<{
    report: LegacyImportReport;
    hold: NxpkgOwnershipHold | null;
    decisions: VerifiedOwnershipDecisions | null;
  }> {
    const cli = await import('../../../../legacy-import.cli.js');
    const mapping = await this.mapping(context, pkg);
    const decisions = await this.decisions(context, pkg);
    const { facts } = await readOwnershipRecords(pkg);
    let hold: NxpkgOwnershipHold | null = null;
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
      this.deps.importer(),
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
        ownershipHoldFor: (snapshot: LegacySnapshot) => {
          hold = nxpkgOwnershipHold({
            records: facts,
            decisions,
            liveInvoices: snapshot.liveInvoices,
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
    return { report, hold, decisions };
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
    const importer = this.deps.importer();
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
        { importId: context.importId, verdict: inventory.inventory.verdict },
        'the package inventory is not complete; a production-like import would be refused',
      );
      throw new LegacyMigrationStepFailure('IMPORT_FAILED', 'The inventory is not complete.');
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
  }> {
    const importer = this.deps.importer();
    const fresh = await freshCutoverFingerprints(importer, connector, fingerprint, {
      scope: context.scope,
      actor: context.actor,
      productionLikeTarget: this.productionLikeTarget,
    });
    // The cutover gate refuses an import whose fresh inventory is not COMPLETE (every legacy
    // table classified in a reviewed commit). Said at the dry run, so no owner approves a
    // package the gate will refuse at the apply.
    if (this.productionLikeTarget && fresh.inventory.verdict !== 'COMPLETE') {
      this.deps.logger.warn(
        { importId: context.importId, verdict: fresh.inventory.verdict },
        'the package inventory is not complete; a production-like import would be refused',
      );
      throw new LegacyMigrationStepFailure('IMPORT_FAILED', 'The inventory is not complete.');
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
      return fail(
        error.code,
        error.counts === null
          ? undefined
          : Object.entries(nonZero(error.counts)).map(([code, count]) => ({ code, count })),
      );
    }
    if (error instanceof PanelMappingRefused) return fail('PANEL_TARGET_MISMATCH');
    if (error instanceof LegacySourceRefused) return fail('IMPORT_FAILED');
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

/** The package's SELECTED RickPanel targets: what the operator binds (others stay unresolved). */
async function selectedTargets(pkg: NxpkgPackage): Promise<LegacyMigrationPanelTarget[]> {
  const out: LegacyMigrationPanelTarget[] = [];
  if (!pkg.has(NXPKG_PANEL_TARGETS_PATH)) return out;
  for await (const record of pkg.iterJsonl(NXPKG_PANEL_TARGETS_PATH)) {
    const code = record['code_panel'];
    const target = record['target'] as Record<string, unknown> | null | undefined;
    if (typeof code !== 'string' || target === null || target === undefined) continue;
    out.push({
      codePanel: code,
      providerType: typeof target['provider_type'] === 'string' ? target['provider_type'] : '',
      services: 0,
    });
  }
  return out;
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

/** The importer's dry run, summarised as the contract's counts. Never a row. */
function dryRunReportOf(
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
  },
): Omit<LegacyMigrationDryRunReport, 'cutover' | 'planTalliesDigest'> {
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
      imported: n(openings['POST']),
      archived: 0,
      skipped: n(openings['ALREADY_POSTED']),
      quarantined: n(openings['CONFLICT']) + n(openings['PRIOR_DEBIT_OPENING']),
    },
    {
      section: 'legacy_debts',
      source: n(plan.wallet?.negative?.count),
      imported: n(openings['RECORD_DEBT']),
      archived: 0,
      skipped: n(openings['DEBT_ALREADY_RECORDED']),
      quarantined: 0,
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
  ].sort(byCode);
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
  };
}

// --- the converter's own totals (M8) ---------------------------------------------------------

const CUSTOMERS_PATH = 'records/customers.jsonl';
const OPENINGS_PATH = 'records/wallet_opening_balances.jsonl';
const DEBTS_PATH = 'records/legacy_debts.jsonl';

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
