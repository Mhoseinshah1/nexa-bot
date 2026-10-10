import type {
  ActorContext,
  LegacyMigrationBlocker,
  LegacyMigrationApplyReport,
  LegacyMigrationBackupOutcome,
  LegacyMigrationDryRunReport,
  LegacyMigrationPanelBinding,
  LegacyMigrationProgress,
  LegacyMigrationVerifyReport,
  LegacyNxpkgErrorCode,
  LegacyNxpkgImportStatus,
  LegacyNxpkgKeyKind,
  TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * Mirza `.nxpkg` importer — the ports of the `legacy-migration` module
 * (`docs/legacy-migration/nxpkg-importer.md`).
 *
 * The module owns the lifecycle row, the upload, the sealed key and the `migration` role's
 * loop. It does NOT open a package or import anything itself: verification, the dry run, the
 * apply, the history archive and the post-import backup are the five ports below, each
 * implemented elsewhere and wired in `container.ts`. A port nothing implements yet is wired
 * to an adapter that throws `LegacyMigrationNotWired` — the executor treats that as "not
 * this tick", never as a verdict about the package.
 */

// --- the lifecycle row ----------------------------------------------------------------------

export interface LegacyNxpkgImportRow {
  readonly id: string;
  readonly tenantId: string;
  readonly status: LegacyNxpkgImportStatus;
  readonly errorCode: LegacyNxpkgErrorCode | null;
  readonly fileName: string;
  /** The encrypted package on this installation's disk. Never leaves the server. */
  readonly filePath: string;
  readonly fileSha256: string;
  readonly fileBytes: bigint;
  readonly packageImportId: string | null;
  readonly packageSourceFingerprint: string | null;
  readonly packageSchemaVersion: string | null;
  readonly converterVersion: string | null;
  readonly manifestSummary: unknown;
  /** The sealed key (`legacy_migration.package_key`). NULL once terminal. */
  readonly keyCiphertext: string | null;
  readonly keyKeyId: string | null;
  readonly keyKind: LegacyNxpkgKeyKind | null;
  readonly decisionsFilePath: string | null;
  readonly decisionsSummary: unknown;
  readonly panelBindings: readonly LegacyMigrationPanelBinding[] | null;
  readonly verifyReport: LegacyMigrationVerifyReport | null;
  readonly dryRunReport: LegacyMigrationDryRunReport | null;
  readonly dryRunSha256: string | null;
  readonly approvedDryRunSha256: string | null;
  readonly applyReport: LegacyMigrationApplyReport | null;
  readonly dryRunLegacyRunId: string | null;
  readonly applyLegacyRunId: string | null;
  readonly backupRunId: string | null;
  readonly progress: LegacyMigrationProgress;
  readonly requestedByAdminId: string;
  readonly approvedByAdminId: string | null;
  readonly approvedAt: Date | null;
  readonly claimedBy: string | null;
  readonly leaseUntil: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly finishedAt: Date | null;
}

/** The columns a transition or a patch may write. `undefined` leaves a column alone. */
export interface LegacyNxpkgImportPatch {
  readonly errorCode?: LegacyNxpkgErrorCode | null;
  readonly packageImportId?: string | null;
  readonly packageSourceFingerprint?: string | null;
  readonly packageSchemaVersion?: string | null;
  readonly converterVersion?: string | null;
  readonly manifestSummary?: unknown;
  readonly keyCiphertext?: string | null;
  readonly keyKeyId?: string | null;
  readonly keyKind?: LegacyNxpkgKeyKind | null;
  readonly decisionsFilePath?: string | null;
  readonly decisionsSummary?: unknown;
  readonly panelBindings?: readonly LegacyMigrationPanelBinding[] | null;
  readonly verifyReport?: LegacyMigrationVerifyReport | null;
  readonly dryRunReport?: LegacyMigrationDryRunReport | null;
  readonly dryRunSha256?: string | null;
  readonly approvedDryRunSha256?: string | null;
  readonly approvedByAdminId?: string | null;
  readonly approvedAt?: Date | null;
  readonly applyReport?: LegacyMigrationApplyReport | null;
  readonly dryRunLegacyRunId?: string | null;
  readonly applyLegacyRunId?: string | null;
  readonly backupRunId?: string | null;
  readonly progress?: LegacyMigrationProgress;
}

export interface NewLegacyNxpkgImport {
  readonly id: string;
  readonly tenantId: string;
  readonly fileName: string;
  readonly filePath: string;
  readonly fileSha256: string;
  readonly fileBytes: bigint;
  readonly requestedByAdminId: string;
  readonly now: Date;
}

export interface LegacyNxpkgTransition {
  readonly id: string;
  /** Present for an operator's command (the row must belong to this tenant). */
  readonly tenantId?: string;
  readonly from: readonly LegacyNxpkgImportStatus[];
  readonly to: LegacyNxpkgImportStatus;
  readonly now: Date;
  readonly patch?: LegacyNxpkgImportPatch;
  /**
   * The executor's lease guard: the row must still be held by this owner. A process whose
   * lease was released while it worked writes nothing afterwards.
   */
  readonly leaseOwner?: string;
  /** An operator's command: refused while any worker holds the row. */
  readonly unowned?: boolean;
  /** Release the lease with this write (a step ended). Always released on a terminal. */
  readonly releaseLease?: boolean;
  /** The approval's binding: `dry_run_sha256` must still be exactly this. */
  readonly expectDryRunSha256?: string;
}

/**
 * `legacy_nxpkg_imports`. Every state change is `transition` — a conditional UPDATE naming its
 * `from` states, returning whether it matched. There is no `setState`.
 *
 * A transition into a TERMINAL state also, in the same statement, erases the sealed key
 * (`key_ciphertext`, `key_key_id`), releases the lease and stamps `finished_at`; one into a
 * failure state requires `errorCode`, and any other clears it. The CHECK constraints say the
 * same, so a caller that forgets is refused by the database, not trusted.
 */
export interface LegacyNxpkgImportRepository {
  /** Throws a CONFLICT (`legacy_migration.already_active`) when a non-terminal import exists. */
  insert(input: NewLegacyNxpkgImport, tx?: TransactionScope): Promise<LegacyNxpkgImportRow>;
  /** Scoped; `lock` takes the row lock (inside a transaction only). */
  byId(
    tenantId: string,
    id: string,
    options?: { readonly tx?: TransactionScope; readonly lock?: boolean },
  ): Promise<LegacyNxpkgImportRow | null>;
  /** For the executor, which acts for the installation on a row it claimed. */
  byIdUnscoped(id: string): Promise<LegacyNxpkgImportRow | null>;
  /** The tenant's non-terminal import, if any. */
  active(tenantId: string, tx?: TransactionScope): Promise<LegacyNxpkgImportRow | null>;
  /** Newest first, keyset on id (uuid v7). One row more than asked, so the caller sees a next page. */
  page(input: {
    readonly tenantId: string;
    readonly limit: number;
    readonly before: string | null;
  }): Promise<readonly LegacyNxpkgImportRow[]>;
  transition(input: LegacyNxpkgTransition, tx?: TransactionScope): Promise<boolean>;
  /** Writes columns without moving the status; the same guards as `transition`. */
  patch(
    input: Omit<LegacyNxpkgTransition, 'to' | 'releaseLease'>,
    tx?: TransactionScope,
  ): Promise<boolean>;
  /**
   * Takes the lease on one import with work (`LEGACY_MIGRATION_WORK_STATUSES`) whose lease is
   * free, or is this owner's own after a restart. One conditional UPDATE over a
   * `FOR UPDATE SKIP LOCKED` pick, so two replicas never take the same row.
   */
  claim(input: {
    readonly leaseOwner: string;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<LegacyNxpkgImportRow | null>;
  /** Extends this owner's lease; false when the row is no longer this owner's. */
  heartbeat(input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<boolean>;
  /** Gives this owner's lease back without moving the status. */
  release(input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly now: Date;
  }): Promise<void>;
  /**
   * Releases every lease that expired before `now`, returning the rows. RELEASED, not
   * failed — unlike `recovery_requests.reclaimStale`: see `LegacyMigrationExecutor`.
   */
  reclaimStale(input: { readonly now: Date }): Promise<readonly LegacyNxpkgImportRow[]>;
}

// --- the filesystem ---------------------------------------------------------------------------

/** Where one import's files live. Paths are built from the validated import id only. */
export interface MigrationImportFiles {
  readonly directory: string;
  readonly packagePath: string;
}

export interface MigrationWorkspaces {
  /** Creates `<root>/<id>` (0700). Refuses an id that is not a uuid, or a directory that exists. */
  create(importId: string): Promise<MigrationImportFiles>;
  /** The paths of an existing import. */
  filesOf(importId: string): MigrationImportFiles;
  /** A fresh path for an incoming decisions file inside the import's directory. */
  decisionsUploadPath(importId: string): string;
  /** The content-addressed final path of a decisions file. */
  decisionsPath(importId: string, sha256: string): string;
  /** Moves an uploaded decisions file into place. */
  promote(from: string, to: string): Promise<void>;
  /** Removes one file, ignoring a missing one. */
  removeFile(path: string): Promise<void>;
  /** Removes an import's whole directory (an abandoned upload). */
  discard(importId: string): Promise<void>;
  /**
   * A private (0700) directory for ONE step's decrypted content. The caller removes it with
   * `discardStep` when the step ends, whatever the outcome.
   */
  stepDirectory(importId: string): Promise<string>;
  discardStep(path: string): Promise<void>;
  /** Removes every step directory an earlier (crashed) process left behind. */
  discardStaleSteps(importId: string): Promise<number>;
  /** SHA-256 (hex) and size of a file, streamed. */
  digest(path: string): Promise<{ readonly sha256: string; readonly bytes: number }>;
}

// --- the five ports the `migration` role drives ---------------------------------------------

/** The package key as given — the shape the `.nxpkg` reader takes. */
export type PackageSecret = { readonly keyFileText: string } | { readonly passphrase: string };

/** Everything a step needs. `workDir` is private to the step and removed after it. */
export interface MigrationStepContext {
  readonly scope: TenantContext;
  readonly actor: ActorContext;
  readonly importId: string;
  /** The package's own `manifest.import_id`, once verification recorded it. */
  readonly packageImportId: string | null;
  /** The source fingerprint verification recorded: what every later step binds to. */
  readonly sourceFingerprint: string | null;
  readonly packagePath: string;
  readonly packageSha256: string;
  readonly secret: PackageSecret;
  readonly workDir: string;
  readonly decisionsPath: string | null;
  readonly panelBindings: readonly LegacyMigrationPanelBinding[];
  /** What verification and the dry run recorded (null before each). */
  readonly verifyReport: LegacyMigrationVerifyReport | null;
  readonly dryRunReport: LegacyMigrationDryRunReport | null;
  /** Aborted when the lease is lost (cancelled, or taken over): stop and write nothing more. */
  readonly signal: AbortSignal;
}

/** A refusal with a code from `LEGACY_NXPKG_ERROR_CODES`: the step's verdict. */
export class LegacyMigrationStepFailure extends Error {
  constructor(
    readonly code: LegacyNxpkgErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LegacyMigrationStepFailure';
  }
}

/**
 * The step is WAITING on an operator (a production-like target's acknowledgement, cutover
 * approval or stop-sales). Not a verdict: the executor records the blocker on the row's
 * progress, releases the lease, and the import stays where it is.
 */
export class LegacyMigrationBlocked extends Error {
  constructor(readonly blocker: LegacyMigrationBlocker) {
    super(`The legacy migration is waiting: ${blocker}.`);
    this.name = 'LegacyMigrationBlocked';
  }
}

/**
 * A port with no implementation in this build. Not a verdict: the executor releases the
 * lease and leaves the row where it was, so wiring the adapter is all it takes to continue.
 */
export class LegacyMigrationNotWired extends Error {
  readonly code = 'legacy_migration.not_wired';
  constructor(readonly port: string) {
    super(`The legacy migration port ${port} is not wired in this build.`);
    this.name = 'LegacyMigrationNotWired';
  }
}

/**
 * Opens the package with the key and proves it (design §1): container, payload, manifest,
 * readiness, source snapshot, money unit, panel targets, live flags — and, when a decisions
 * file is present, the decisions (§7). Throws `LegacyMigrationStepFailure` with the §1 code.
 */
export interface PackageVerifier {
  verify(
    context: Omit<MigrationStepContext, 'panelBindings'>,
  ): Promise<LegacyMigrationVerifyReport>;
}

/** Design §6: the tenant holds no operational data. Panels may exist. */
export interface FreshTargetGuard {
  check(
    scope: TenantContext,
  ): Promise<
    | { readonly fresh: true }
    | { readonly fresh: false; readonly counts: Readonly<Record<string, number>> }
  >;
}

/**
 * The EXISTING legacy importer over the package (`NxpkgLegacySourceConnector`), run exactly as
 * the CLI sequence runs it (`docs/legacy-migration/rehearsal.md`), programmatically.
 */
export interface MigrationRunner {
  /**
   * Before a dry run (`DRY_RUN`) and before every apply attempt (`APPLY`): on a production-like
   * target, the gates the CLI applies — the process's target acknowledgement, and for the apply
   * the owner's cutover approval of the dry run's seven values and active stop-sales. Throws
   * `LegacyMigrationBlocked` (waiting) or `LegacyMigrationStepFailure` (never allowed: a
   * synthetic package against a production-like target). Anywhere else, nothing.
   */
  precheck(context: MigrationStepContext, step: 'DRY_RUN' | 'APPLY'): Promise<void>;
  /** Read sets + `importer.dryRun`. Writes no customer, balance or service. */
  dryRun(context: MigrationStepContext): Promise<{
    readonly report: LegacyMigrationDryRunReport;
    readonly legacyRunId: string | null;
  }>;
  /**
   * `importer.apply`. `IMPORT` the first time; `RESUME` after a crash — the importer resumes
   * its RUNNING `legacy_import_runs` row (`importer.md` §6), and when it holds none for this
   * package (the crash came before the run started) it starts the IMPORT, whose start
   * transaction re-checks the fresh target. The apply's own re-checks (fresh target, panel
   * binding, approved digest) refuse with a `LegacyMigrationStepFailure`.
   */
  apply(
    context: MigrationStepContext,
    input: { readonly mode: 'IMPORT' | 'RESUME'; readonly approvedDryRunSha256: string },
  ): Promise<{ readonly legacyRunId: string; readonly importerVerdict: string }>;
  reconcile(context: MigrationStepContext): Promise<{
    readonly verdict: 'RECONCILED' | 'DISCREPANCY';
  }>;
  /** The v2 final report, summarised for the import row. */
  finalReport(
    context: MigrationStepContext,
    input: {
      readonly importerVerdict: string;
      readonly reconcileVerdict: 'RECONCILED' | 'DISCREPANCY';
      readonly history: readonly { readonly code: string; readonly count: number }[];
    },
  ): Promise<LegacyMigrationApplyReport>;
}

/** Archives every non-operational record type (design §5), idempotently by key. */
export interface HistoryIngestPort {
  ingest(context: MigrationStepContext): Promise<{
    readonly counts: readonly { readonly code: string; readonly count: number }[];
  }>;
}

/** The standard backup after a completed import, honouring the recovery quiesce. */
export interface BackupPort {
  runAfterImport(): Promise<{
    readonly outcome: LegacyMigrationBackupOutcome;
    readonly runId: string | null;
  }>;
}
