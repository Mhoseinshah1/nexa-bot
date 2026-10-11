import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEGACY_TABLE_CLASSIFICATION,
  isNexaError,
  systemJobActor,
  type CorrelationId,
  type TenantContext,
} from '@nexa/contracts';
import { createContainer } from './container.js';
import {
  DSN_PASSWORD_REFUSAL,
  PACKAGE_SECRET_VALUE_REFUSAL,
  PASSWORD_FLAG_REFUSAL,
  hasUrlPassword,
  isPackageKeyText,
  isPasswordFlag,
} from './legacy-import-argv.js';
import { NxpkgError } from './infrastructure/nxpkg/errors.js';
import type { NxpkgSecret } from './infrastructure/nxpkg/crypto.js';
import {
  NxpkgImportRefused,
  validatePanelMappingAgainstTargets,
} from './modules/platform/legacy-importer/application/nxpkg-panel-binding.js';
import {
  NXPKG_PANEL_TARGETS_PATH,
  checkNxpkgForImport,
} from './modules/platform/legacy-importer/application/nxpkg-acceptance.js';
import { freshTargetProblems } from './modules/platform/legacy-importer/application/fresh-target.js';
import { nxpkgOwnershipHold } from './modules/platform/legacy-importer/application/nxpkg-ownership.js';
import {
  NxpkgLegacySourceConnector,
  nxpkgSourceConnector,
} from './modules/platform/legacy-importer/infrastructure/nxpkg-legacy-source.js';
import {
  readOwnershipRecords,
  verifyOwnershipDecisions,
} from './modules/platform/legacy-importer/infrastructure/nxpkg-ownership-decisions.js';
import {
  INVENTORY_USAGE,
  InventoryUsageError,
  inventoryExitCode,
  parseInventoryArgs,
  runInventory,
} from './legacy-import-inventory.js';
import {
  inventoryJson,
  inventoryMarkdown,
} from './modules/platform/legacy-importer/application/legacy-inventory.js';
import {
  PRODUCTS_EXPORT_USAGE,
  PRODUCTS_READ_USAGE,
  ProductsUsageError,
  mergeProductsIntoMap,
  parseProductsExportArgs,
  parseProductsReadArgs,
  productsReadExitCode,
  productsReadReport,
  runProductsRead,
} from './legacy-import-products.js';
import {
  INVOICES_READ_USAGE,
  InvoicesUsageError,
  invoicesReadExitCode,
  invoicesReadReport,
  parseInvoicesReadArgs,
  runInvoicesRead,
} from './legacy-import-invoices.js';
import { InvoiceArchiveRefused } from './modules/platform/legacy-importer/application/invoice-archive-ingest.js';
import { InvoiceArchiveStagingRefused } from './modules/platform/legacy-invoice-archive/application/legacy-invoice-archive.service.js';
import {
  REVIEW_USAGE,
  ReviewUsageError,
  parseReviewArgs,
  runReview,
} from './legacy-import-review.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import {
  runLegacyEvidence,
  type LegacyEvidence,
} from './modules/platform/legacy-importer/application/evidence-runner.js';
import {
  LegacyImportInterrupted,
  type LegacyImporterService,
} from './modules/platform/legacy-importer/application/legacy-importer.service.js';
import {
  PanelMappingRefused,
  parsePanelMapping,
  type PanelMapping,
} from './modules/platform/legacy-importer/application/panel-mapping.js';
import {
  ALLOW_PRODUCTION_FLAG,
  EVIDENCE_CLASSES,
  TARGET_ACK_ENV,
  decideEvidenceClass,
  type EvidenceClass,
  evaluateProductionGuard,
  type TargetIdentity,
} from './modules/platform/legacy-importer/application/production-guard.js';
import {
  reportJson,
  reportMarkdown,
  type LegacyImportReport,
} from './modules/platform/legacy-importer/application/report.js';
import {
  LegacySourceRefused,
  type LegacySourceConnector,
} from './modules/platform/legacy-importer/application/source-port.js';
import {
  readFromSession,
  type LegacySnapshot,
} from './modules/platform/legacy-importer/application/source-snapshot.js';
import {
  FixtureLegacySourceConnector,
  loadFixtureDataset,
} from './modules/platform/legacy-importer/infrastructure/fixture-legacy-source.js';
import {
  MysqlLegacySourceConnector,
  parseMysqlDsn,
} from './modules/platform/legacy-importer/infrastructure/mysql-legacy-source.js';
import { INVENTORY_MAX_PAGE_SIZE } from './modules/platform/providers/infrastructure/rickpanel-inventory.js';
import {
  CUTOVER_GATE_USAGE,
  CutoverUsageError,
  assertExpectationComplete,
  assertFreshMatches,
  cutoverExpectationOf,
  cutoverGateExitCode,
  cutoverGateText,
  freshCutoverFingerprints,
  parseCutoverGateArgs,
  readBytes,
  runCutoverGate,
  runFreezeChecker,
  sha256OfFile,
} from './legacy-import-cutover.js';
import { LegacyCutoverRefused } from './modules/platform/legacy-cutover/domain/cutover-rules.js';
import { takeLegacyInventory } from './modules/platform/legacy-importer/application/legacy-inventory.js';

/**
 * `legacy-import` — the P7 legacy importer (`docs/legacy-migration/importer.md`).
 *
 * Nothing has a default. `--mode`, `--tenant`, `--source`, `--target` and `--panel-map`
 * are each required, and a target that looks like production is refused unless BOTH
 * `--allow-production-target` and `NEXA_LEGACY_IMPORT_TARGET_ACK=<ack>` are present, the
 * ack being bound to that exact target and tenant (`production-guard.ts`). The refusals
 * are in `parseArgs` and `guardTarget`, which are pure and tested, and run before any
 * connection is opened.
 *
 * No password is ever accepted on the command line (argv is world-readable in /proc and
 * lands in shell history). A DSN carrying one comes from an environment variable the
 * operator NAMES: `--source env:LEGACY_MYSQL_DSN`, `--target env:NEXA_TARGET_DATABASE_URL`.
 */

export class UsageError extends Error {}

export const MODES = ['audit', 'dry-run', 'import', 'resume', 'reconcile', 'report'] as const;
export type Mode = (typeof MODES)[number];

export const USAGE = [
  'usage: legacy-import MODE --tenant TENANT --source SOURCE --target TARGET --panel-map FILE',
  '                     [--evidence-class synthetic|staging|production]',
  '                     [--format md|json] [--out DIR] [--inventory-page-size N]',
  '                     [--abort-running] [--source-password-env NAME]',
  '                     [--expected-fingerprint HEX] [--expected-panel-map-fingerprint HEX]',
  '                     [--expected-inventory-fingerprint HEX] [--expected-products-fingerprint HEX]',
  '                     [--expected-invoice-archive-fingerprint HEX]',
  '                     [--expected-freeze-proof-sha256 HEX] [--expected-final-dump-sha256 HEX]',
  '                     [--cutover-gate] [--report-schema 1|2]',
  '                     [--package-key-env NAME | --package-passphrase-env NAME]',
  '                     [--package-work-dir DIR] [--ownership-decisions FILE]',
  '                     [--expected-plan-tallies-digest HEX]',
  `                     [${ALLOW_PRODUCTION_FLAG}]`,
  '',
  '  MODE     audit | dry-run | import | resume | reconcile | report  (or --mode MODE)',
  '  TENANT   the tenant uuid, or its slug',
  '  SOURCE   env:NAME                 a mysql:// DSN read from the environment variable NAME',
  '           mysql://USER@HOST:PORT/DB  (no password here; add --source-password-env NAME)',
  '           fixture:PATH             a SYNTHETIC dataset (tests and rehearsal code checks only)',
  '           nxpkg:PATH               a Mirza2Nexa .nxpkg package (contract >= 1.4.0), opened with',
  '                                    --package-key-env NAME (the key file text) or',
  '                                    --package-passphrase-env NAME; never a key on argv',
  '  TARGET   env:NAME                 the NEXA postgres:// URL read from the variable NAME',
  '           postgres://USER@HOST:PORT/DB  (no password here; PGPASSWORD is honoured)',
  '           DBNAME                   the database DATABASE_URL names, typed out to confirm it',
  '',
  '  Review queue (terminal only): legacy-import review counts|list|resolve|reopen …',
  '  Table inventory (read-only):   legacy-import inventory --tenant … --source … --target …',
  '  Legacy product review:         legacy-import products-read|products-export --help',
  '  Legacy invoice archive:        legacy-import invoices-read --help',
  '  The final cutover gate:        legacy-import cutover-gate --help',
  '',
  `  --inventory-page-size N             rows per RickPanel list page, 1-${String(INVENTORY_MAX_PAGE_SIZE)}. Default here:`,
  `                                      ${String(INVENTORY_MAX_PAGE_SIZE)}, the reader's maximum (fewest provider reads, shortest`,
  '                                      double walk). The walk still fails closed on any change.',
  '  --out DIR                           also write the report there. A failure to write it',
  '                                      (after the report was computed) exits 73.',
  '',
  '  --expected-fingerprint HEX          import/resume: the source fingerprint the owner',
  '                                      approved (from audit); anything else is refused, exit 65.',
  '                                      REQUIRED against a production-like target.',
  '  --expected-panel-map-fingerprint HEX  import/resume: the same for the panel mapping file.',
  '',
  '  The CUTOVER GATE (Mirza PR6) applies to import/resume against a production-like target,',
  '  and anywhere with --cutover-gate (to rehearse it on staging). It needs all seven values —',
  '  --expected-fingerprint, --expected-panel-map-fingerprint, --expected-inventory-fingerprint,',
  '  --expected-products-fingerprint, --expected-invoice-archive-fingerprint,',
  '  --expected-freeze-proof-sha256, --expected-final-dump-sha256 — re-reads the three read sets',
  '  (every table classified, each fingerprint as approved), and refuses (exit 65, nothing',
  '  written) without an unrevoked owner approval (Web Admin) matching all seven, or over an',
  "  earlier import of another source without the owner's re-run acknowledgement",
  '  (SOURCE_SUPERSEDED).',
  "  --expected-plan-tallies-digest HEX  import: the approved dry run's planTalliesDigest; a",
  '                                      plan with other tallies is refused (DRY_RUN_MISMATCH).',
  '',
  '  nxpkg: every mode first re-checks the package (checkNxpkgForImport) and accepts the',
  '  --panel-map only if it is exactly the map the package targets make with its bindings;',
  '  dry-run and import refuse a target that is not fresh (FRESH_TARGET_NOT_EMPTY), and',
  '  import decides that again inside the transaction that starts the run.',
  '  --report-schema 1|2                 report: the final report version --format json prints',
  '                                      (default 2; 1 is the closed v1 document, unchanged).',
  '',
  '  Nothing that decides WHAT is imported defaults. A production-like target also needs',
  `  ${ALLOW_PRODUCTION_FLAG} AND ${TARGET_ACK_ENV}=<ack printed by the refusal>.`,
].join('\n');

export interface Args {
  readonly mode: Mode;
  /** As given: a tenant uuid or slug. Resolved against the target before any write. */
  readonly tenant: string;
  readonly source: string;
  readonly sourcePasswordEnv: string | null;
  readonly target: string;
  readonly panelMap: string;
  readonly out: string | null;
  readonly allowProductionTarget: boolean;
  readonly abortRunning: boolean;
  /** Rows per RickPanel list page: the operator's value, or the CLI default. */
  readonly inventoryPageSize: number;
  /** Whether `inventoryPageSize` was typed by the operator or is the CLI default. */
  readonly inventoryPageSizeSource: InventoryPageSizeSource;
  readonly format: 'md' | 'json';
  /** Required for import, resume and report; checked against the source's marker. */
  readonly evidenceClass: EvidenceClass | null;
  /**
   * import/resume: the source fingerprint the owner approved. The snapshot must equal it or
   * nothing is written (exit 65). Required against a production-like target.
   */
  readonly expectedFingerprint: string | null;
  /** import/resume: the same, for the panel mapping file's fingerprint. Optional. */
  readonly expectedPanelMapFingerprint: string | null;
  /** import/resume (Mirza PR6): the other five values a cutover approval binds. */
  readonly expectedInventoryFingerprint: string | null;
  readonly expectedProductsFingerprint: string | null;
  readonly expectedInvoiceArchiveFingerprint: string | null;
  readonly expectedFreezeProofSha256: string | null;
  readonly expectedFinalDumpSha256: string | null;
  /** import/resume: apply the cutover gate on a target that is not production-like. */
  readonly cutoverGate: boolean;
  /** report: the final report version `--format json` prints. */
  readonly reportSchema: 1 | 2;
  /** `nxpkg:` only: the variable holding the package key file's text. */
  readonly packageKeyEnv?: string | null;
  /** `nxpkg:` only: the variable holding the package passphrase. */
  readonly packagePassphraseEnv?: string | null;
  /** `nxpkg:` only: where the package is decrypted (a private 0700 directory inside). */
  readonly packageWorkDir?: string | null;
  /** `nxpkg:` only: the converter's signed `ownership-decisions.json`. */
  readonly ownershipDecisions?: string | null;
  /** import: the approved dry run's `planTalliesDigest` (DRY_RUN_MISMATCH otherwise). */
  readonly expectedPlanTalliesDigest?: string | null;
}

/**
 * The CLI's inventory page size when `--inventory-page-size` is omitted: the reader's own
 * maximum, so the bound and the default can never drift apart. The LIBRARY default
 * (`INVENTORY_DEFAULT_PAGE_SIZE`, 50) is unchanged for every other caller.
 *
 * Why the maximum here: a migration walks the whole live inventory TWICE and requires the
 * two walks to agree (`listAll`, fail-closed `TOTAL_CHANGED`). The longer the walk, the
 * likelier a live panel changes under it. In the real Mirza rehearsal, 50-row pages took
 * ~500 provider reads and ended BLOCKED with TOTAL_CHANGED; 200-row pages took ~130 and
 * reached READY_FOR_DRY_RUN. Fewer reads is also less exposure of the live provider. The
 * consistency check itself is untouched: a panel that changes mid-walk still blocks.
 */
export const LEGACY_IMPORT_DEFAULT_INVENTORY_PAGE_SIZE = INVENTORY_MAX_PAGE_SIZE;
export type InventoryPageSizeSource = 'CLI_DEFAULT' | 'OPERATOR';
const POSITIVE_INTEGER = /^[1-9][0-9]{0,8}$/u;

export const EXPECTED_FINGERPRINT_FLAG = '--expected-fingerprint';
export const EXPECTED_PANEL_MAP_FINGERPRINT_FLAG = '--expected-panel-map-fingerprint';
const SHA256_HEX = /^[0-9a-f]{64}$/u;

const VALUE_FLAGS = new Set([
  '--mode',
  '--expected-fingerprint',
  '--expected-panel-map-fingerprint',
  '--expected-inventory-fingerprint',
  '--expected-products-fingerprint',
  '--expected-invoice-archive-fingerprint',
  '--expected-freeze-proof-sha256',
  '--expected-final-dump-sha256',
  '--report-schema',
  '--tenant',
  '--source',
  '--source-password-env',
  '--target',
  '--panel-map',
  '--out',
  '--inventory-page-size',
  '--format',
  '--evidence-class',
  '--package-key-env',
  '--package-passphrase-env',
  '--package-work-dir',
  '--ownership-decisions',
  '--expected-plan-tallies-digest',
]);
const BOOLEAN_FLAGS = new Set([ALLOW_PRODUCTION_FLAG, '--abort-running', '--cutover-gate']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/u;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/u;

export function parseArgs(argv: readonly string[]): Args {
  // A package key's text is refused wherever it stands — as a flag's value too.
  if (argv.some(isPackageKeyText)) throw new UsageError(PACKAGE_SECRET_VALUE_REFUSAL);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  // The mode may lead, positionally (`legacy-import import --tenant …`), or be `--mode`.
  let start = 0;
  const first = argv[0];
  if (first !== undefined && !first.startsWith('--')) {
    if (!(MODES as readonly string[]).includes(first)) {
      throw new UsageError(`The mode must be one of ${MODES.join(', ')}.\n\n${USAGE}`);
    }
    values.set('--mode', first);
    start = 1;
  }
  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (isPasswordFlag(arg)) throw new UsageError(PASSWORD_FLAG_REFUSAL);
    if (BOOLEAN_FLAGS.has(arg)) {
      flags.add(arg);
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) throw new UsageError(`Unknown argument ${arg}.\n\n${USAGE}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) throw new UsageError(`${arg} needs a value.`);
    if (values.has(arg)) throw new UsageError(`${arg} is given twice.`);
    values.set(arg, next);
    i += 1;
  }
  const required = (flag: string, why: string): string => {
    const value = values.get(flag);
    if (value === undefined)
      throw new UsageError(`${flag} is required: ${why}. There is no default.\n\n${USAGE}`);
    return value;
  };
  const mode = required('--mode', 'which of the six modes to run');
  if (!(MODES as readonly string[]).includes(mode))
    throw new UsageError(`--mode must be one of ${MODES.join(', ')}.`);
  const tenant = required('--tenant', 'the tenant to import into');
  if (!UUID.test(tenant) && !SLUG.test(tenant)) {
    throw new UsageError('--tenant must be a lowercase tenant uuid or slug.');
  }
  const source = required('--source', 'the legacy database to read');
  const target = required('--target', 'the NEXA database to write');
  const panelMap = required('--panel-map', 'the explicit code_panel → panel mapping file');

  if (hasUrlPassword(source) || hasUrlPassword(target)) {
    throw new UsageError(DSN_PASSWORD_REFUSAL);
  }
  for (const spec of [source, target]) {
    if (spec.startsWith('env:') && !ENV_NAME.test(spec.slice(4))) {
      throw new UsageError(`${spec} does not name an environment variable.`);
    }
  }
  if (!/^(env:|mysql:\/\/|mariadb:\/\/|fixture:|nxpkg:)/u.test(source)) {
    throw new UsageError('--source must be env:NAME, mysql://…, fixture:PATH or nxpkg:PATH.');
  }
  const nxpkg = source.startsWith('nxpkg:');
  if (nxpkg && source.length === 'nxpkg:'.length) {
    throw new UsageError('--source nxpkg: needs the package path.');
  }
  const packageKeyEnv = values.get('--package-key-env') ?? null;
  const packagePassphraseEnv = values.get('--package-passphrase-env') ?? null;
  const packageWorkDir = values.get('--package-work-dir') ?? null;
  const ownershipDecisions = values.get('--ownership-decisions') ?? null;
  for (const name of [packageKeyEnv, packagePassphraseEnv]) {
    if (name !== null && !ENV_NAME.test(name)) {
      throw new UsageError('--package-key-env / --package-passphrase-env name a variable.');
    }
  }
  if (nxpkg && (packageKeyEnv === null) === (packagePassphraseEnv === null)) {
    throw new UsageError(
      '--source nxpkg: needs exactly one of --package-key-env NAME or --package-passphrase-env NAME.',
    );
  }
  if (
    !nxpkg &&
    (packageKeyEnv !== null ||
      packagePassphraseEnv !== null ||
      packageWorkDir !== null ||
      ownershipDecisions !== null)
  ) {
    throw new UsageError(
      '--package-key-env, --package-passphrase-env, --package-work-dir and --ownership-decisions apply to an nxpkg: source only.',
    );
  }
  if (!/^(env:|postgres:\/\/|postgresql:\/\/)/u.test(target) && !DATABASE_NAME.test(target)) {
    throw new UsageError('--target must be env:NAME, postgres://… or a database name.');
  }
  const evidenceClass = values.get('--evidence-class') ?? null;
  if (evidenceClass !== null && !(EVIDENCE_CLASSES as readonly string[]).includes(evidenceClass)) {
    throw new UsageError(`--evidence-class must be one of ${EVIDENCE_CLASSES.join(', ')}.`);
  }
  if (evidenceClass === null && (mode === 'import' || mode === 'resume' || mode === 'report')) {
    throw new UsageError(
      `--evidence-class is required for ${mode}: synthetic, staging or production. It is checked ` +
        'against the source (a SYNTHETIC-marked source is synthetic, nothing else).',
    );
  }
  const format = values.get('--format') ?? 'md';
  if (format !== 'md' && format !== 'json') throw new UsageError('--format must be md or json.');
  const sourcePasswordEnv = values.get('--source-password-env') ?? null;
  if (
    sourcePasswordEnv !== null &&
    (!ENV_NAME.test(sourcePasswordEnv) || !/^(mysql|mariadb):\/\//u.test(source))
  ) {
    throw new UsageError(
      '--source-password-env names a variable and applies to a literal mysql:// source only.',
    );
  }
  const abortRunning = flags.has('--abort-running');
  if (abortRunning && mode !== 'resume')
    throw new UsageError('--abort-running applies to --mode resume only.');
  const rawPage = values.get('--inventory-page-size');
  // Digits only: `parseInt` would read `50abc` as 50 and `1e3` as 1.
  const inventoryPageSize =
    rawPage === undefined
      ? LEGACY_IMPORT_DEFAULT_INVENTORY_PAGE_SIZE
      : POSITIVE_INTEGER.test(rawPage)
        ? Number(rawPage)
        : Number.NaN;
  if (
    !Number.isInteger(inventoryPageSize) ||
    inventoryPageSize < 1 ||
    inventoryPageSize > INVENTORY_MAX_PAGE_SIZE
  ) {
    throw new UsageError(
      `--inventory-page-size must be a whole number between 1 and ${String(INVENTORY_MAX_PAGE_SIZE)}.`,
    );
  }
  const expected = (flag: string): string | null => {
    const value = values.get(flag) ?? null;
    if (value === null) return null;
    if (mode !== 'import' && mode !== 'resume') {
      throw new UsageError(`${flag} applies to import and resume only.`);
    }
    if (!SHA256_HEX.test(value)) {
      throw new UsageError(
        `${flag} is a SHA-256 as 64 lowercase hex characters, as audit prints it.`,
      );
    }
    return value;
  };
  const expectedFingerprint = expected(EXPECTED_FINGERPRINT_FLAG);
  const expectedPanelMapFingerprint = expected(EXPECTED_PANEL_MAP_FINGERPRINT_FLAG);
  const cutoverGate = flags.has('--cutover-gate');
  if (cutoverGate && mode !== 'import' && mode !== 'resume') {
    throw new UsageError('--cutover-gate applies to import and resume only.');
  }
  const expectedPlanTalliesDigest = values.get('--expected-plan-tallies-digest') ?? null;
  if (expectedPlanTalliesDigest !== null) {
    if (mode !== 'import') {
      throw new UsageError('--expected-plan-tallies-digest applies to import only.');
    }
    if (!SHA256_HEX.test(expectedPlanTalliesDigest)) {
      throw new UsageError(
        '--expected-plan-tallies-digest is a SHA-256 as 64 lowercase hex characters, as the dry run prints it.',
      );
    }
  }
  const rawSchema = values.get('--report-schema');
  if (rawSchema !== undefined && mode !== 'report') {
    throw new UsageError('--report-schema applies to report only.');
  }
  if (rawSchema !== undefined && rawSchema !== '1' && rawSchema !== '2') {
    throw new UsageError('--report-schema must be 1 or 2.');
  }
  return {
    mode: mode as Mode,
    tenant,
    expectedFingerprint,
    expectedPanelMapFingerprint,
    expectedInventoryFingerprint: expected('--expected-inventory-fingerprint'),
    expectedProductsFingerprint: expected('--expected-products-fingerprint'),
    expectedInvoiceArchiveFingerprint: expected('--expected-invoice-archive-fingerprint'),
    expectedFreezeProofSha256: expected('--expected-freeze-proof-sha256'),
    expectedFinalDumpSha256: expected('--expected-final-dump-sha256'),
    cutoverGate,
    reportSchema: rawSchema === '1' ? 1 : 2,
    source,
    sourcePasswordEnv,
    target,
    panelMap,
    out: values.get('--out') ?? null,
    allowProductionTarget: flags.has(ALLOW_PRODUCTION_FLAG),
    abortRunning,
    inventoryPageSize,
    inventoryPageSizeSource: rawPage === undefined ? 'CLI_DEFAULT' : 'OPERATOR',
    format,
    evidenceClass: evidenceClass as EvidenceClass | null,
    packageKeyEnv,
    packagePassphraseEnv,
    packageWorkDir,
    ownershipDecisions,
    expectedPlanTalliesDigest,
  };
}

/**
 * The target URL. A bare database NAME is a confirmation, not a default: it must equal the
 * database `DATABASE_URL` names, so the operator has typed out where the writes go.
 */
export function resolveTarget(spec: string, env: NodeJS.ProcessEnv): string {
  if (!DATABASE_NAME.test(spec) || spec.includes(':')) return resolveSpec(spec, env);
  const url = env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new UsageError(`--target ${spec} names a database; DATABASE_URL must point at it.`);
  }
  const named = targetIdentity(url).database;
  if (named !== spec) {
    throw new UsageError(
      `--target ${spec} does not match DATABASE_URL, which names "${named}". Refusing to guess.`,
    );
  }
  return url;
}

/** Resolves `env:NAME` from the environment, refusing an unset variable. */
export function resolveSpec(spec: string, env: NodeJS.ProcessEnv): string {
  if (!spec.startsWith('env:')) return spec;
  const value = env[spec.slice(4)];
  if (value === undefined || value === '') throw new UsageError(`${spec.slice(4)} is not set.`);
  return value;
}

export function targetIdentity(url: string): TargetIdentity {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError('The target is not a URL.');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new UsageError('The target must be a postgres:// URL.');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (database === '') throw new UsageError('The target URL must name a database.');
  return { host: parsed.hostname || 'localhost', port: parsed.port || '5432', database };
}

/**
 * The guard, as the CLI applies it. Throws `UsageError` with the refusal.
 *
 * A source is synthetic when it is a `fixture:`, OR when the caller has read the source's own
 * marker and says so (`syntheticSource: true` — an `.nxpkg` package whose catalogue carries
 * NEXA's synthetic marker). The flag can only ADD the refusal: a `fixture:` source is
 * synthetic whatever it says, and a real package (marker null) is guarded as any real source.
 */
export function guardTarget(
  args: Pick<Args, 'tenant' | 'allowProductionTarget'> & {
    readonly source?: string;
    readonly syntheticSource?: boolean;
  },
  targetUrl: string,
  env: NodeJS.ProcessEnv,
): TargetIdentity & { readonly productionLike: boolean } {
  const identity = targetIdentity(targetUrl);
  const verdict = evaluateProductionGuard({
    target: identity,
    tenantId: args.tenant,
    env: { NODE_ENV: env['NODE_ENV'], [TARGET_ACK_ENV]: env[TARGET_ACK_ENV] },
    allowProductionFlag: args.allowProductionTarget,
    syntheticSource:
      (args.source?.startsWith('fixture:') ?? false) || args.syntheticSource === true,
  });
  if (!verdict.allowed) throw new UsageError(verdict.message);
  return { ...identity, productionLike: verdict.productionLike };
}

/**
 * The package secret, read from the variable the operator named — never from argv. An unset
 * or empty variable is refused; the value is returned for one `openNxpkg` call and kept
 * nowhere else.
 */
export function packageSecretFromEnv(
  args: Pick<Args, 'packageKeyEnv' | 'packagePassphraseEnv'>,
  env: NodeJS.ProcessEnv,
): NxpkgSecret {
  const name = args.packageKeyEnv ?? args.packagePassphraseEnv ?? null;
  if (name === null) {
    throw new UsageError('--package-key-env or --package-passphrase-env is required.');
  }
  const value = env[name];
  if (value === undefined || value === '') throw new UsageError(`${name} is not set.`);
  return args.packageKeyEnv != null ? { keyFileText: value } : { passphrase: value };
}

/**
 * The `.nxpkg` source for the orchestration (`legacy-migration`) and the CLI: opens and
 * authenticates the package, decrypting it into a private directory under `workDir`, and
 * returns a connector that owns it (`close()` deletes it). See `nxpkg-legacy-source.ts`.
 */
export { nxpkgSourceConnector };

async function sourceConnector(
  args: Pick<Args, 'source' | 'sourcePasswordEnv'> &
    Partial<Pick<Args, 'packageKeyEnv' | 'packagePassphraseEnv' | 'packageWorkDir'>>,
  env: NodeJS.ProcessEnv,
): Promise<LegacySourceConnector> {
  if (args.source.startsWith('nxpkg:')) {
    return nxpkgSourceConnector(
      args.source.slice('nxpkg:'.length),
      packageSecretFromEnv(
        {
          packageKeyEnv: args.packageKeyEnv ?? null,
          packagePassphraseEnv: args.packagePassphraseEnv ?? null,
        },
        env,
      ),
      args.packageWorkDir ?? tmpdir(),
    );
  }
  if (args.source.startsWith('fixture:')) {
    return new FixtureLegacySourceConnector(
      await loadFixtureDataset(args.source.slice('fixture:'.length)),
    );
  }
  const dsn = resolveSpec(args.source, env);
  const options = parseMysqlDsn(dsn);
  const password =
    args.sourcePasswordEnv === null ? options.password : (env[args.sourcePasswordEnv] ?? null);
  return new MysqlLegacySourceConnector({ ...options, password });
}

/** The report's metadata about this invocation (`LegacyImportReport.invocation`). */
export function withInvocation(
  report: LegacyImportReport,
  args: Pick<Args, 'inventoryPageSize' | 'inventoryPageSizeSource'>,
): LegacyImportReport {
  return {
    ...report,
    invocation: {
      inventoryPageSize: args.inventoryPageSize,
      inventoryPageSizeSource: args.inventoryPageSizeSource,
    },
  };
}

/** What the CLI hands `container.legacyImporter`: always an explicit page size. */
export function importerOptions(args: Pick<Args, 'inventoryPageSize'>): {
  readonly inventoryPageSize: number;
} {
  return { inventoryPageSize: args.inventoryPageSize };
}

/**
 * Exit code for a report that was COMPUTED but could not be written to `--out`
 * (sysexits `EX_CANTCREAT`). Distinct from 1 and 65 on purpose: the source, the target and
 * the verdict are not in question — only the file.
 */
export const REPORT_NOT_WRITTEN_EXIT = 73;
/** The uid the NEXA image runs as (`Dockerfile`: `USER node`, uid 1000). */
export const IMAGE_UID = 1000;

/** `--out` could not be written after the report was computed and printed. */
export class ReportNotWritten extends Error {
  override readonly name = 'ReportNotWritten';
  constructor(
    readonly mode: string,
    readonly verdict: string | null,
    readonly path: string,
    /** The errno code (`EACCES`, `EROFS`, …), or `UNKNOWN`. Never the driver's message. */
    readonly code: string,
    readonly written: readonly string[],
    readonly uid: number | null,
  ) {
    super(reportNotWrittenMessage(mode, verdict, path, code, written, uid));
  }
}

const ERRNO_CODE = /^E[A-Z0-9]{1,15}$/u;
const ERRNO_MEANING: Readonly<Record<string, string>> = {
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  EROFS: 'read-only file system',
  ENOENT: 'no such file or directory',
  ENOTDIR: 'a component of the path is not a directory',
  EEXIST: 'a file is in the way',
  EISDIR: 'the path is a directory',
  ENOSPC: 'no space left on the device',
  EDQUOT: 'disk quota exceeded',
};

export function reportNotWrittenMessage(
  mode: string,
  verdict: string | null,
  path: string,
  code: string,
  written: readonly string[],
  uid: number | null,
): string {
  const meaning = ERRNO_MEANING[code];
  const who = uid === null ? 'this process' : `this process (uid ${String(uid)})`;
  return [
    `REPORT NOT WRITTEN (exit ${String(REPORT_NOT_WRITTEN_EXIT)}). The ${mode} report WAS computed — ` +
      `verdict ${verdict ?? '(none for this mode)'} — and printed to stdout, but it ` +
      `could not be written to --out.`,
    `  path:  ${path}`,
    `  error: ${code}${meaning === undefined ? '' : ` (${meaning})`}`,
    ...(written.length === 0 ? [] : [`  already written: ${written.join(', ')}`]),
    'This is a failure to SAVE the report, not a failure of the source, the target or the ' +
      'audit: the verdict above stands.',
    `Remedy (${who} could not write there; the NEXA image runs as uid ${String(IMAGE_UID)}, ` +
      '`node`, and must not be run as root to work around it):',
    '  - capture stdout on the HOST instead of --out:  … --format json > /host/writable/audit.json',
    `  - or mount a host directory owned by uid ${String(IMAGE_UID)}:  ` +
      `sudo install -d -o ${String(IMAGE_UID)} -g ${String(IMAGE_UID)} -m 700 /srv/nexa-legacy-reports, ` +
      'then -v /srv/nexa-legacy-reports:/results and --out /results',
  ].join('\n');
}

/** What `emit` touches. The CLI uses the process and `node:fs`; a test injects a failure. */
export interface ReportIo {
  stdout(text: string): void;
  stderr(text: string): void;
  mkdir(path: string): Promise<unknown>;
  writeFile(path: string, data: string): Promise<void>;
  /** The effective uid, for the remedy; null where the platform has none. */
  readonly uid: number | null;
}

const PROCESS_IO: ReportIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  mkdir: (path) => mkdir(path, { recursive: true }),
  writeFile: (path, data) => writeFile(path, data, { mode: 0o600 }),
  uid: typeof process.getuid === 'function' ? process.getuid() : null,
};

function errnoCode(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  return ERRNO_CODE.test(code) ? code : 'UNKNOWN';
}

/**
 * Prints the report, then — with `--out` — writes it. The report is on stdout BEFORE any
 * file is attempted, so a failure to write cannot lose it; that failure is a
 * `ReportNotWritten` naming the path and the errno code, never a bare `Error EACCES`
 * that reads like the audit failed.
 */
export async function emit(
  report: LegacyImportReport,
  out: string | null,
  format: 'md' | 'json',
  io: ReportIo = PROCESS_IO,
): Promise<void> {
  const markdown = reportMarkdown(report);
  // `report --format json` prints the Item 16 document alone, so a harness can parse
  // stdout; every other mode prints its own report.
  // Mirza PR6: version 2 when it was built (the default), else the v1 document.
  const document = report.finalV2 ?? report.final;
  const json =
    document === undefined ? reportJson(report) : `${JSON.stringify(document, null, 2)}\n`;
  io.stdout(format === 'json' ? json : markdown);
  if (out === null) return;
  const stem = `legacy-import-${report.mode.toLowerCase()}-${report.generatedAt.replace(/[:.]/gu, '-')}`;
  const written: string[] = [];
  let path = out;
  try {
    await io.mkdir(out);
    for (const [file, text] of [
      [join(out, `${stem}.json`), json],
      [join(out, `${stem}.md`), markdown],
    ] as const) {
      path = file;
      await io.writeFile(file, text);
      written.push(file);
    }
  } catch (error) {
    throw new ReportNotWritten(
      report.mode,
      report.verdict,
      path,
      errnoCode(error),
      written,
      io.uid,
    );
  }
  io.stderr(`report written to ${join(out, stem)}.{json,md}\n`);
}

/** Exit code for a finished mode: 0 clean, 3 finished with something a person must decide. */
export function exitCodeFor(report: LegacyImportReport): number {
  if (report.verdict === 'BLOCKED' || report.verdict === 'DISCREPANCY') return 3;
  if (report.verdict === 'COMPLETED_ADOPTION_PENDING_P6') return 3;
  // Unapplied, failed or conflicting rows (`applyAttention`): never a success.
  if (report.verdict === 'COMPLETED_WITH_FAILURES') return 3;
  if (report.verdict?.endsWith('_WITH_DISCREPANCY') === true) return 3;
  return 0;
}

export async function runMode(
  importer: LegacyImporterService,
  args: Args,
  connector: LegacySourceConnector,
  mappingText: string,
  actorCorrelation: string,
  context: {
    readonly tenantId: string;
    readonly productionLikeTarget: boolean;
    /**
     * `.nxpkg` only: the live invoices the package's ownership evidence holds back from
     * adoption, decided from THIS snapshot (`nxpkgOwnershipHoldFor`).
     */
    readonly ownershipHoldFor?: (snapshot: LegacySnapshot) => Promise<ReadonlySet<string>>;
    /**
     * `.nxpkg` only: the verified ownership decisions file's `entries_digest`, or null without
     * one. Bound with the hold into the run (`ownership_hold_digest`, M7).
     */
    readonly ownershipDecisionsDigest?: string | null;
    /**
     * import: the approved dry run's `planTalliesDigest` (`sections.planTalliesDigest`); the
     * import refuses another plan (`DRY_RUN_MISMATCH`). Overrides `--expected-plan-tallies-digest`.
     */
    readonly dryRunTalliesDigest?: string;
  },
): Promise<LegacyImportReport | null> {
  const scope: TenantContext = { tenantId: context.tenantId as never, botInstanceId: null };
  const actor = systemJobActor(`legacy-import:${args.mode}`, actorCorrelation as CorrelationId);
  const mapping = parsePanelMapping(mappingText, context.tenantId);
  const writes = args.mode === 'import' || args.mode === 'resume';
  // The owner's approval is bound to ONE source: against a production-like target an
  // import or resume without it is refused before the source is even opened.
  if (writes && context.productionLikeTarget && args.expectedFingerprint === null) {
    throw new UsageError(
      `${EXPECTED_FINGERPRINT_FLAG} is required for ${args.mode} against a production-like ` +
        'target: pass the source fingerprint the owner approved (audit prints it).',
    );
  }
  // Mirza PR6: the cutover gate. Against a production-like target every import and resume is
  // gated; elsewhere `--cutover-gate` asks for it. All seven values or nothing is even read.
  const gated = writes && (context.productionLikeTarget || args.cutoverGate);
  const expectation = cutoverExpectationOf(args);
  if (gated) assertExpectationComplete(expectation);
  if (
    args.expectedPanelMapFingerprint !== null &&
    args.expectedPanelMapFingerprint !== mapping.fingerprint
  ) {
    throw new PanelMappingRefused([
      `the panel mapping fingerprint is ${mapping.fingerprint}, but ` +
        `${EXPECTED_PANEL_MAP_FINGERPRINT_FLAG} is ${args.expectedPanelMapFingerprint}: this is ` +
        'not the mapping file that was approved. Nothing was written.',
    ]);
  }

  // `.nxpkg` (H2): whoever calls — the operator's CLI or the migration worker — every mode
  // re-checks the package and takes the panel map only as the package's targets make it.
  const nxpkg = connector instanceof NxpkgLegacySourceConnector;
  if (connector instanceof NxpkgLegacySourceConnector) {
    await assertNxpkgImportable(importer, scope, connector, mapping);
  }

  const session = await connector.open();
  let evidence: LegacyEvidence | null = null;
  let snapshot;
  try {
    // The evidence and the rows come from ONE snapshot, so the cross-checks compare like
    // with like.
    if (args.mode === 'audit') evidence = await runLegacyEvidence(session);
    snapshot = await readFromSession(connector.label, session);
  } finally {
    await session.close();
  }
  // The evidence class is decided against the source's OWN marker, read in the same
  // snapshot: a synthetic dataset loaded into MariaDB is synthetic whatever is claimed.
  const label = decideEvidenceClass({
    claim: args.evidenceClass,
    syntheticSource: snapshot.synthetic,
    productionLikeTarget: context.productionLikeTarget,
  });
  if (!label.ok) throw new UsageError(label.message);
  // Compared with the snapshot that is about to be imported, before any write.
  if (args.expectedFingerprint !== null && args.expectedFingerprint !== snapshot.fingerprint) {
    throw new LegacySourceRefused(
      'SOURCE_FINGERPRINT_MISMATCH',
      `the source fingerprint is ${snapshot.fingerprint}, but ${EXPECTED_FINGERPRINT_FLAG} is ` +
        `${args.expectedFingerprint}: this is not the source that was approved. Nothing was written.`,
    );
  }
  // Mirza PR5: the target's class travels with the input, so a stored approval's synthetic
  // flag is checked against it before any run acts on it.
  // `.nxpkg` (§6): a dry run or an import only into a fresh tenant — a courtesy read here,
  // decided again by the import inside the transaction that starts its run.
  if (nxpkg && (args.mode === 'dry-run' || args.mode === 'import')) {
    const fresh = await importer.freshTarget(scope, snapshot.fingerprint);
    if (!fresh.fresh) {
      throw new NxpkgImportRefused(
        'FRESH_TARGET_NOT_EMPTY',
        [
          'the tenant already holds operational data; nothing is deleted to make room',
          ...freshTargetProblems(fresh),
        ],
        fresh.counts,
      );
    }
  }
  const ownershipHold =
    context.ownershipHoldFor === undefined ? undefined : await context.ownershipHoldFor(snapshot);
  const input = {
    scope,
    actor,
    snapshot,
    mapping,
    productionLikeTarget: context.productionLikeTarget,
    ...(ownershipHold === undefined
      ? {}
      : { ownershipHold, ownershipDecisionsDigest: context.ownershipDecisionsDigest ?? null }),
  };
  const dryRunTalliesDigest = context.dryRunTalliesDigest ?? args.expectedPlanTalliesDigest ?? null;
  const readContext = { scope, actor, productionLikeTarget: context.productionLikeTarget };
  if (gated) {
    // A FRESH read of every read set the approval binds, by sessions bound to this source:
    // every table classified, every fingerprint the approved one — before anything is written.
    assertFreshMatches(
      await freshCutoverFingerprints(importer, connector, snapshot.fingerprint, readContext),
      expectation,
    );
  }
  switch (args.mode) {
    case 'audit':
      return importer.audit({
        ...input,
        evidence: evidence ?? { available: false, reason: 'SOURCE_ENGINE_NOT_SQL' },
      });
    case 'dry-run':
      return importer.dryRun(input);
    case 'import':
      return importer.apply({
        ...input,
        mode: 'IMPORT',
        ...(nxpkg ? { freshTarget: true } : {}),
        ...(dryRunTalliesDigest === null ? {} : { dryRunTalliesDigest }),
        ...(gated ? { cutoverGate: { expectation } } : {}),
      });
    case 'resume':
      return importer.apply({
        ...input,
        mode: 'RESUME',
        ...(gated ? { cutoverGate: { expectation } } : {}),
      });
    case 'reconcile':
      return importer.reconcile(input);
    case 'report': {
      // Mirza PR6: version 2 reads a fresh inventory in a session bound to THIS snapshot's
      // source, so its inventory section lists what was read, never what usually is.
      const inventory =
        args.reportSchema === 2
          ? await takeLegacyInventory(
              connector,
              snapshot.fingerprint,
              Object.keys(LEGACY_TABLE_CLASSIFICATION),
            )
          : null;
      return importer.finalReport({
        ...input,
        evidenceClass: label.evidenceClass,
        inventory,
        reportSchema: args.reportSchema,
      });
    }
  }
}

/**
 * `.nxpkg` only: the ownership hold resolver `runMode` calls with its snapshot — the package's
 * `records/service_ownership.jsonl`, and the converter's signed `ownership-decisions.json` when
 * one is given (verified FIRST, before the snapshot is read: a bad file refuses the run).
 */
export async function nxpkgOwnershipHoldFor(
  connector: NxpkgLegacySourceConnector,
  decisions: { readonly bytes: Uint8Array; readonly secret: NxpkgSecret } | null,
): Promise<(snapshot: LegacySnapshot) => Promise<ReadonlySet<string>>> {
  return (await nxpkgOwnershipEvidence(connector, decisions)).holdFor;
}

/**
 * `nxpkgOwnershipHoldFor`, and the verified decisions file's `entries_digest` (null without
 * one) that `runMode` binds into the run with the hold (`ownershipDecisionsDigest`).
 */
export async function nxpkgOwnershipEvidence(
  connector: NxpkgLegacySourceConnector,
  decisions: { readonly bytes: Uint8Array; readonly secret: NxpkgSecret } | null,
): Promise<{
  readonly holdFor: (snapshot: LegacySnapshot) => Promise<ReadonlySet<string>>;
  readonly decisionsDigest: string | null;
}> {
  const pkg = connector.pkg;
  if (pkg === null) throw new UsageError('the nxpkg source has no opened package');
  const verified =
    decisions === null
      ? null
      : await verifyOwnershipDecisions(decisions.bytes, pkg, decisions.secret);
  const { facts } = await readOwnershipRecords(pkg);
  return {
    holdFor: (snapshot) =>
      Promise.resolve(
        nxpkgOwnershipHold({
          records: facts,
          decisions: verified,
          liveInvoices: snapshot.liveInvoices,
        }).hold,
      ),
    decisionsDigest: verified?.entriesDigest ?? null,
  };
}

/**
 * `.nxpkg`: the package may be imported (`checkNxpkgForImport`, §1) and the panel map is
 * exactly the one its targets make with the map's bindings (`validatePanelMappingAgainstTargets`).
 * Both refuse with `NxpkgImportRefused` (exit 65) before the snapshot is read.
 */
async function assertNxpkgImportable(
  importer: LegacyImporterService,
  scope: TenantContext,
  connector: NxpkgLegacySourceConnector,
  mapping: PanelMapping,
): Promise<void> {
  const pkg = connector.pkg;
  if (pkg === null) throw new UsageError('the nxpkg source has no opened package');
  const acceptance = await checkNxpkgForImport(pkg);
  const first = acceptance.problems[0];
  if (!acceptance.ok && first !== undefined) {
    throw new NxpkgImportRefused(
      first.code,
      acceptance.problems.map((p) => `${p.code}: ${p.detail}`),
    );
  }
  const targets: Record<string, unknown>[] = [];
  if (pkg.has(NXPKG_PANEL_TARGETS_PATH)) {
    for await (const record of pkg.iterJsonl(NXPKG_PANEL_TARGETS_PATH)) targets.push(record);
  }
  validatePanelMappingAgainstTargets({
    tenantId: scope.tenantId,
    targets,
    mapping,
    tenantPanels: await importer.panelFacts(
      scope,
      mapping.file.panels.map((p) => p.panelId),
    ),
  });
}

/** `legacy-import review …`: the Manual Review Queue, on the operator's terminal only. */
async function reviewMain(argv: readonly string[]): Promise<void> {
  const args = parseReviewArgs(argv);
  const env = process.env;
  const targetUrl = resolveTarget(args.target, env);
  guardTarget(args, targetUrl, env);
  const container = createContainer(loadConfig({ ...env, DATABASE_URL: targetUrl }), 'worker');
  try {
    const tenantId = await container.legacyImporter().resolveTenant(args.tenant);
    if (tenantId === null) throw new UsageError(`No tenant ${args.tenant} in the target.`);
    await runReview(
      container.legacyReviewQueue,
      args,
      { tenantId: tenantId as never, botInstanceId: null },
      systemJobActor(`legacy-import:review-${args.action}`, container.ids.uuid() as CorrelationId),
      () => `cli-review:${container.ids.uuid()}`,
      (line) => process.stdout.write(`${line}\n`),
    );
  } finally {
    await container.shutdown();
  }
}

/**
 * `legacy-import inventory …`: every legacy table, classified and counted, no values
 * (`legacy-import-inventory.ts`). Returns the exit code.
 */
async function inventoryMain(argv: readonly string[]): Promise<number> {
  const args = parseInventoryArgs(argv);
  const env = process.env;
  const targetUrl = resolveTarget(args.target, env);
  const target = guardTarget(args, targetUrl, env);
  const connector = await sourceConnector(args, env);
  const container = createContainer(loadConfig({ ...env, DATABASE_URL: targetUrl }), 'worker');
  try {
    const importer = container.legacyImporter();
    const tenantId = await importer.resolveTenant(args.tenant);
    if (tenantId === null) throw new UsageError(`No tenant ${args.tenant} in the target.`);
    const outcome = await runInventory(importer, connector, args, {
      scope: { tenantId: tenantId as never, botInstanceId: null },
      actor: systemJobActor('legacy-import:inventory', container.ids.uuid() as CorrelationId),
      productionLikeTarget: target.productionLike,
    });
    process.stdout.write(
      args.format === 'json'
        ? inventoryJson(outcome.inventory)
        : inventoryMarkdown(outcome.inventory),
    );
    process.stderr.write(
      outcome.recorded === null
        ? 'inventory NOT recorded: no --expected-fingerprint, so it is not bound to an approved source.\n'
        : `inventory recorded in legacy_read_set_runs: ${outcome.recorded.run.id}` +
            `${outcome.recorded.created ? '' : ' (already recorded; nothing new written)'}\n`,
    );
    return inventoryExitCode(outcome.inventory);
  } finally {
    await container.shutdown();
  }
}

/**
 * `legacy-import products-read …` (Mirza PR2, `legacy-import-products.ts`): the legacy product
 * table into the legacy product review, bound to both approvals. Returns the exit code.
 */
async function productsReadMain(argv: readonly string[]): Promise<number> {
  const args = parseProductsReadArgs(argv);
  const env = process.env;
  const targetUrl = resolveTarget(args.target, env);
  const target = guardTarget(args, targetUrl, env);
  const connector = await sourceConnector(args, env);
  const container = createContainer(loadConfig({ ...env, DATABASE_URL: targetUrl }), 'worker');
  try {
    const importer = container.legacyImporter();
    const tenantId = await importer.resolveTenant(args.tenant);
    if (tenantId === null) throw new UsageError(`No tenant ${args.tenant} in the target.`);
    const outcome = await runProductsRead(importer, connector, args, {
      scope: { tenantId: tenantId as never, botInstanceId: null },
      actor: systemJobActor('legacy-import:products-read', container.ids.uuid() as CorrelationId),
      productionLikeTarget: target.productionLike,
    });
    process.stdout.write(productsReadReport(outcome, args.format));
    return productsReadExitCode(outcome);
  } finally {
    await container.shutdown();
  }
}

/**
 * `legacy-import invoices-read …` (Mirza PR3, `legacy-import-invoices.ts`): every legacy
 * invoice into the append-only legacy invoice archive, bound to both approvals. Returns the
 * exit code.
 */
async function invoicesReadMain(argv: readonly string[]): Promise<number> {
  const args = parseInvoicesReadArgs(argv);
  const env = process.env;
  const targetUrl = resolveTarget(args.target, env);
  const target = guardTarget(args, targetUrl, env);
  const connector = await sourceConnector(args, env);
  const container = createContainer(loadConfig({ ...env, DATABASE_URL: targetUrl }), 'worker');
  try {
    const importer = container.legacyImporter();
    const tenantId = await importer.resolveTenant(args.tenant);
    if (tenantId === null) throw new UsageError(`No tenant ${args.tenant} in the target.`);
    const outcome = await runInvoicesRead(importer, connector, args, {
      scope: { tenantId: tenantId as never, botInstanceId: null },
      actor: systemJobActor('legacy-import:invoices-read', container.ids.uuid() as CorrelationId),
      productionLikeTarget: target.productionLike,
    });
    process.stdout.write(invoicesReadReport(outcome, args.format));
    return invoicesReadExitCode(outcome);
  } finally {
    await container.shutdown();
  }
}

/**
 * `legacy-import products-export …` (Mirza PR2): the panel map `products` section from the
 * approved review rows. Read-only on every database; it never writes the map file.
 */
async function productsExportMain(argv: readonly string[]): Promise<number> {
  const args = parseProductsExportArgs(argv);
  const env = process.env;
  const targetUrl = resolveTarget(args.target, env);
  guardTarget(args, targetUrl, env);
  const mapText =
    args.panelMap === null
      ? null
      : await readFile(args.panelMap, 'utf8').catch(() => {
          throw new UsageError(`The panel mapping file ${args.panelMap ?? ''} cannot be read.`);
        });
  const container = createContainer(loadConfig({ ...env, DATABASE_URL: targetUrl }), 'worker');
  try {
    const tenantId = await container.legacyImporter().resolveTenant(args.tenant);
    if (tenantId === null) throw new UsageError(`No tenant ${args.tenant} in the target.`);
    const scope = { tenantId: tenantId as never, botInstanceId: null };
    const actor = systemJobActor(
      'legacy-import:products-export',
      container.ids.uuid() as CorrelationId,
    );
    const exported = await container.legacyProductReviews.exportMapping(
      scope,
      actor,
      args.expectedProductsFingerprint,
    );
    process.stderr.write(
      `exported ${String(exported.products.length)} code(s) from products read ${exported.readSetFingerprint}; ` +
        `not exported: ${JSON.stringify(exported.notExported)}\n`,
    );
    if (mapText === null) {
      process.stdout.write(`${JSON.stringify({ products: exported.products }, null, 2)}\n`);
      return 0;
    }
    const reviewed = await container.legacyProductReviews.reviewedCodes(scope, actor);
    const merged = mergeProductsIntoMap(mapText, tenantId, exported, reviewed);
    process.stdout.write(`${JSON.stringify(merged.file, null, 2)}\n`);
    process.stderr.write(
      `panel map fingerprint with these products: ${merged.fingerprint} — a NEW value the owner approves.\n`,
    );
    return 0;
  } finally {
    await container.shutdown();
  }
}

/**
 * `legacy-import cutover-gate …` (Mirza PR6, `legacy-import-cutover.ts`): the final gate,
 * every step in order. Read-only on every database. Returns the exit code.
 */
async function cutoverGateMain(argv: readonly string[]): Promise<number> {
  const args = parseCutoverGateArgs(argv);
  const env = process.env;
  const targetUrl = resolveTarget(args.target, env);
  const target = guardTarget(args, targetUrl, env);
  const mappingText = await readFile(args.panelMap, 'utf8').catch(() => {
    throw new CutoverUsageError(`The panel mapping file ${args.panelMap} cannot be read.`);
  });
  const connector = await sourceConnector(args, env);
  const container = createContainer(loadConfig({ ...env, DATABASE_URL: targetUrl }), 'worker');
  try {
    const importer = container.legacyImporter();
    const tenantId = await importer.resolveTenant(args.tenant);
    if (tenantId === null) throw new UsageError(`No tenant ${args.tenant} in the target.`);
    const scope: TenantContext = { tenantId: tenantId as never, botInstanceId: null };
    const report = await runCutoverGate(
      {
        importer,
        stopSalesFacts: () => container.legacyCutover.stopSalesFacts(scope),
        connector,
        readSnapshot: async () => {
          const session = await connector.open();
          try {
            return await readFromSession(connector.label, session);
          } finally {
            await session.close();
          }
        },
        runChecker: runFreezeChecker,
        readBytes,
        hashFile: sha256OfFile,
        now: () => container.clock.now(),
      },
      args,
      {
        scope,
        actor: systemJobActor('legacy-import:cutover-gate', container.ids.uuid() as CorrelationId),
        mapping: parsePanelMapping(mappingText, tenantId),
        productionLikeTarget: target.productionLike,
      },
    );
    process.stdout.write(cutoverGateText(report, args.format));
    return cutoverGateExitCode(report);
  } finally {
    await container.shutdown();
  }
}

/** `--help` / `-h` anywhere: the usage on stdout and exit 0 (a usage ERROR stays 64 on stderr). */
export function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

/**
 * The process's one exit. `exitCode` is set first; then stdout and stderr are drained (an
 * empty write's callback runs once everything written before it has been taken by the
 * pipe); only then does the process exit. A `process.exit()` while a pipe still holds
 * output discards it — a piped report cut at 64 KiB — so nothing else calls it. The
 * explicit exit after the drain remains so a stray handle cannot hang the operator's shell.
 */
export async function exitAfterDrain(code: number): Promise<never> {
  process.exitCode = code;
  const drain = (stream: NodeJS.WriteStream) =>
    new Promise<void>((done) => {
      if (stream.destroyed || !stream.writable) {
        done();
        return;
      }
      stream.write('', () => done());
    });
  await drain(process.stdout);
  await drain(process.stderr);
  process.exit(code);
}

/** The exit code for an error that escaped `main`, after printing what may be printed. */
export function exitCodeForError(error: unknown): number {
  if (
    error instanceof UsageError ||
    error instanceof ReviewUsageError ||
    error instanceof InventoryUsageError ||
    error instanceof ProductsUsageError ||
    error instanceof InvoicesUsageError ||
    error instanceof CutoverUsageError
  ) {
    console.error(error.message);
    return 64;
  }
  if (
    error instanceof PanelMappingRefused ||
    error instanceof LegacySourceRefused ||
    error instanceof InvoiceArchiveRefused ||
    error instanceof InvoiceArchiveStagingRefused ||
    error instanceof LegacyCutoverRefused ||
    error instanceof NxpkgImportRefused
  ) {
    console.error(error.message);
    return 65;
  }
  if (error instanceof NxpkgError) {
    // A fixed sentence and a code: never a path inside the package, never key material.
    console.error(`${error.code}: ${error.message}`);
    return 65;
  }
  if (error instanceof ReportNotWritten) {
    console.error(error.message);
    return REPORT_NOT_WRITTEN_EXIT;
  }
  if (error instanceof LegacyImportInterrupted) {
    console.error(error.message);
    const cause = error.cause;
    console.error(
      isNexaError(cause)
        ? `cause: ${cause.code}`
        : `cause: ${cause instanceof Error ? cause.name : 'unknown'}`,
    );
    return 4;
  }
  if (isNexaError(error)) {
    console.error(`${error.code}: ${error.message}`);
    return 1;
  }
  // The name and an engine code only: a driver's message can quote the row it choked on.
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  console.error(`${error instanceof Error ? error.name : 'unknown error'} ${code}`.trim());
  return 1;
}

/**
 * Runs one invocation and RETURNS its exit code: it never exits itself, so every `finally`
 * (the container's shutdown above all) runs before `exitAfterDrain`.
 */
async function main(): Promise<number> {
  if (wantsHelp(process.argv.slice(2))) {
    const usage =
      process.argv[2] === 'review'
        ? REVIEW_USAGE
        : process.argv[2] === 'inventory'
          ? INVENTORY_USAGE
          : process.argv[2] === 'products-read'
            ? PRODUCTS_READ_USAGE
            : process.argv[2] === 'products-export'
              ? PRODUCTS_EXPORT_USAGE
              : process.argv[2] === 'invoices-read'
                ? INVOICES_READ_USAGE
                : process.argv[2] === 'cutover-gate'
                  ? CUTOVER_GATE_USAGE
                  : USAGE;
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  if (process.argv[2] === 'inventory') return inventoryMain(process.argv.slice(3));
  if (process.argv[2] === 'products-read') return productsReadMain(process.argv.slice(3));
  if (process.argv[2] === 'products-export') return productsExportMain(process.argv.slice(3));
  if (process.argv[2] === 'invoices-read') return invoicesReadMain(process.argv.slice(3));
  if (process.argv[2] === 'cutover-gate') return cutoverGateMain(process.argv.slice(3));
  if (process.argv[2] === 'review') {
    await reviewMain(process.argv.slice(3));
    return 0;
  }
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;
  const targetUrl = resolveTarget(args.target, env);
  const target = guardTarget(args, targetUrl, env);
  const mappingText = await readFile(args.panelMap, 'utf8').catch(() => {
    throw new UsageError(`The panel mapping file ${args.panelMap} cannot be read.`);
  });
  const connector = await sourceConnector(args, env);
  try {
    return await runMain(args, env, targetUrl, target, mappingText, connector);
  } finally {
    if (connector instanceof NxpkgLegacySourceConnector) await connector.close();
  }
}

async function runMain(
  args: Args,
  env: NodeJS.ProcessEnv,
  targetUrl: string,
  guarded: ReturnType<typeof guardTarget>,
  mappingText: string,
  connector: LegacySourceConnector,
): Promise<number> {
  let target = guarded;
  let ownershipHoldFor: ((snapshot: LegacySnapshot) => Promise<ReadonlySet<string>>) | undefined;
  let ownershipDecisionsDigest: string | null = null;
  if (connector instanceof NxpkgLegacySourceConnector) {
    // The package's own marker, now that it is open: a SYNTHETIC package is refused against a
    // production-like target exactly as a fixture is, before anything else is read.
    target = guardTarget(
      { ...args, syntheticSource: connector.syntheticMarker !== null },
      targetUrl,
      env,
    );
    const decisions =
      args.ownershipDecisions == null
        ? null
        : {
            bytes: await readFile(args.ownershipDecisions).catch(() => {
              throw new UsageError('The ownership decisions file cannot be read.');
            }),
            secret: packageSecretFromEnv(args, env),
          };
    const evidence = await nxpkgOwnershipEvidence(connector, decisions);
    ownershipHoldFor = evidence.holdFor;
    ownershipDecisionsDigest = evidence.decisionsDigest;
  }

  const container = createContainer(loadConfig({ ...env, DATABASE_URL: targetUrl }), 'worker');
  try {
    const importer = container.legacyImporter(importerOptions(args));
    const tenantId = await importer.resolveTenant(args.tenant);
    if (tenantId === null) throw new UsageError(`No tenant ${args.tenant} in the target.`);
    // Parsed before the source is opened: a malformed mapping costs no legacy read.
    parsePanelMapping(mappingText, tenantId);
    if (args.abortRunning) {
      const scope: TenantContext = { tenantId: tenantId as never, botInstanceId: null };
      const runs = await importer.runningRun(scope);
      if (runs === null) {
        process.stdout.write('No run is RUNNING for this tenant.\n');
        return 0;
      }
      await importer.abortRunning(
        scope,
        systemJobActor('legacy-import:abort', container.ids.uuid() as CorrelationId),
        runs,
      );
      process.stdout.write(`Run ${runs} ABORTED.\n`);
      return 0;
    }
    const report = await runMode(importer, args, connector, mappingText, container.ids.uuid(), {
      tenantId,
      productionLikeTarget: target.productionLike,
      ...(ownershipHoldFor === undefined ? {} : { ownershipHoldFor, ownershipDecisionsDigest }),
    });
    if (report === null) return 0;
    const reported = withInvocation(report, args);
    await emit(reported, args.out, args.format);
    return exitCodeFor(reported);
  } finally {
    await container.shutdown();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main().then(exitAfterDrain, (error: unknown) => exitAfterDrain(exitCodeForError(error)));
}
