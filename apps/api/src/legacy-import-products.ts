import type { ActorContext, TenantContext } from '@nexa/contracts';
import {
  DSN_PASSWORD_REFUSAL,
  PASSWORD_FLAG_REFUSAL,
  hasUrlPassword,
  isPasswordFlag,
} from './legacy-import-argv.js';
import type {
  LegacyProductExport,
  LegacyProductMapEntry,
} from './modules/commerce/legacy-product-review/application/legacy-product-review.service.js';
import type { LegacyImporterService } from './modules/platform/legacy-importer/application/legacy-importer.service.js';
import {
  PanelMappingRefused,
  canonicalPanelMapping,
  parsePanelMapping,
  type PanelMappingFile,
} from './modules/platform/legacy-importer/application/panel-mapping.js';
import type { ProductsReadOutcome } from './modules/platform/legacy-importer/application/products-ingest.js';
import { READ_SET_MAX_BATCH } from './modules/platform/legacy-importer/application/read-set.js';
import type { LegacySourceConnector } from './modules/platform/legacy-importer/application/source-port.js';
import { sha256Hex } from './modules/platform/legacy-importer/application/source-snapshot.js';

/**
 * Mirza migration PR2 — the two legacy product review commands
 * (`docs/legacy-product-review-design.md` §7, §9; `docs/legacy-migration/importer.md`).
 *
 * `legacy-import products-read` — the legacy `product` table through the `products` read set:
 *   - with `--expected-fingerprint` only: prints the products read set fingerprint for the
 *     owner to approve. Writes NOTHING. Exit 3 (not yet approved).
 *   - with `--expected-products-fingerprint` too: refuses (65, nothing written) unless the
 *     same read-only session's v1 fingerprint and products fingerprint both equal their
 *     approvals, then writes review rows in batches (`maintenance.run`, audited,
 *     idempotent) and records the read set run. Exit 0.
 *
 * `legacy-import products-export` — prints the `products` section of the importer's panel
 *   map from rows approved against the facts the APPROVED products read saw. Read-only; it
 *   never writes the map file. With `--panel-map FILE` it prints the whole map with that
 *   section replaced and its new fingerprint — which the owner approves as for any map
 *   change — and refuses (65) a map whose hand-written entry contradicts a review row.
 */

export class ProductsUsageError extends Error {}

export const PRODUCTS_READ_USAGE = [
  'usage: legacy-import products-read --tenant TENANT --source SOURCE --target TARGET',
  '                                   --expected-fingerprint HEX',
  '                                   [--expected-products-fingerprint HEX] [--batch-size N]',
  '                                   [--format md|json] [--source-password-env NAME]',
  '                                   [--allow-production-target]',
  '',
  '  Reads the legacy product table (the `products` read set) into the legacy product',
  '  review. Without --expected-products-fingerprint it only prints that fingerprint for',
  '  approval and writes nothing (exit 3). With it, both fingerprints are checked in the',
  '  same read-only session before any write (a mismatch is exit 65, nothing written).',
  `  --batch-size N   review rows per transaction, 1-${String(READ_SET_MAX_BATCH)} (default 1000).`,
].join('\n');

export const PRODUCTS_EXPORT_USAGE = [
  'usage: legacy-import products-export --tenant TENANT --target TARGET',
  '                                     --expected-products-fingerprint HEX',
  '                                     [--panel-map FILE] [--allow-production-target]',
  '',
  '  Prints the panel map `products` section: every review row APPROVED against the facts',
  '  the approved products read saw, sorted by code. PENDING, REJECTED, SOURCE_CHANGED,',
  '  absent and duplicated codes are not exported (counted on stderr). Read-only.',
  '  --panel-map FILE  print that map with its `products` replaced, and its new fingerprint.',
  '                    A map entry contradicting a review row is refused (exit 65).',
].join('\n');

export interface ProductsReadArgs {
  readonly tenant: string;
  readonly source: string;
  readonly sourcePasswordEnv: string | null;
  readonly target: string;
  readonly expectedFingerprint: string;
  readonly expectedProductsFingerprint: string | null;
  readonly batchSize: number;
  readonly format: 'md' | 'json';
  readonly allowProductionTarget: boolean;
}

export interface ProductsExportArgs {
  readonly tenant: string;
  readonly target: string;
  readonly expectedProductsFingerprint: string;
  readonly panelMap: string | null;
  readonly allowProductionTarget: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/u;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

function parseFlags(
  argv: readonly string[],
  valueFlags: ReadonlySet<string>,
  usage: string,
): { readonly values: Map<string, string>; readonly allowProductionTarget: boolean } {
  const values = new Map<string, string>();
  let allowProductionTarget = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (isPasswordFlag(arg)) throw new ProductsUsageError(PASSWORD_FLAG_REFUSAL);
    if (arg === '--allow-production-target') {
      allowProductionTarget = true;
      continue;
    }
    if (!valueFlags.has(arg)) throw new ProductsUsageError(`Unknown argument ${arg}.\n\n${usage}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new ProductsUsageError(`${arg} needs a value.`);
    }
    if (values.has(arg)) throw new ProductsUsageError(`${arg} is given twice.`);
    values.set(arg, next);
    i += 1;
  }
  return { values, allowProductionTarget };
}

function required(values: Map<string, string>, flag: string, usage: string): string {
  const value = values.get(flag);
  if (value === undefined) {
    throw new ProductsUsageError(`${flag} is required. There is no default.\n\n${usage}`);
  }
  return value;
}

function checkTenant(tenant: string): void {
  if (!UUID.test(tenant) && !SLUG.test(tenant)) {
    throw new ProductsUsageError('--tenant must be a lowercase tenant uuid or slug.');
  }
}

function checkTarget(target: string): void {
  if (hasUrlPassword(target)) throw new ProductsUsageError(DSN_PASSWORD_REFUSAL);
  if (target.startsWith('env:') && !ENV_NAME.test(target.slice(4))) {
    throw new ProductsUsageError(`${target} does not name an environment variable.`);
  }
  if (!/^(env:|postgres:\/\/|postgresql:\/\/)/u.test(target) && !DATABASE_NAME.test(target)) {
    throw new ProductsUsageError('--target must be env:NAME, postgres://… or a database name.');
  }
}

function checkHash(flag: string, value: string): string {
  if (!SHA256_HEX.test(value)) {
    throw new ProductsUsageError(`${flag} is a SHA-256 as 64 lowercase hex characters.`);
  }
  return value;
}

export function parseProductsReadArgs(argv: readonly string[]): ProductsReadArgs {
  const { values, allowProductionTarget } = parseFlags(
    argv,
    new Set([
      '--tenant',
      '--source',
      '--source-password-env',
      '--target',
      '--expected-fingerprint',
      '--expected-products-fingerprint',
      '--batch-size',
      '--format',
    ]),
    PRODUCTS_READ_USAGE,
  );
  const tenant = required(values, '--tenant', PRODUCTS_READ_USAGE);
  checkTenant(tenant);
  const source = required(values, '--source', PRODUCTS_READ_USAGE);
  const target = required(values, '--target', PRODUCTS_READ_USAGE);
  if (hasUrlPassword(source)) throw new ProductsUsageError(DSN_PASSWORD_REFUSAL);
  if (source.startsWith('env:') && !ENV_NAME.test(source.slice(4))) {
    throw new ProductsUsageError(`${source} does not name an environment variable.`);
  }
  if (!/^(env:|mysql:\/\/|mariadb:\/\/|fixture:)/u.test(source)) {
    throw new ProductsUsageError('--source must be env:NAME, mysql://… or fixture:PATH.');
  }
  checkTarget(target);
  const sourcePasswordEnv = values.get('--source-password-env') ?? null;
  if (
    sourcePasswordEnv !== null &&
    (!ENV_NAME.test(sourcePasswordEnv) || !/^(mysql|mariadb):\/\//u.test(source))
  ) {
    throw new ProductsUsageError(
      '--source-password-env names a variable and applies to a literal mysql:// source only.',
    );
  }
  const expectedFingerprint = checkHash(
    '--expected-fingerprint',
    required(values, '--expected-fingerprint', PRODUCTS_READ_USAGE),
  );
  const productsFlag = values.get('--expected-products-fingerprint');
  const expectedProductsFingerprint =
    productsFlag === undefined ? null : checkHash('--expected-products-fingerprint', productsFlag);
  const batchText = values.get('--batch-size') ?? '1000';
  if (!/^[0-9]{1,5}$/u.test(batchText)) {
    throw new ProductsUsageError(`--batch-size is 1-${String(READ_SET_MAX_BATCH)}.`);
  }
  const batchSize = Number(batchText);
  if (batchSize < 1 || batchSize > READ_SET_MAX_BATCH) {
    throw new ProductsUsageError(`--batch-size is 1-${String(READ_SET_MAX_BATCH)}.`);
  }
  const format = values.get('--format') ?? 'md';
  if (format !== 'md' && format !== 'json') {
    throw new ProductsUsageError('--format must be md or json.');
  }
  return {
    tenant,
    source,
    sourcePasswordEnv,
    target,
    expectedFingerprint,
    expectedProductsFingerprint,
    batchSize,
    format,
    allowProductionTarget,
  };
}

export function parseProductsExportArgs(argv: readonly string[]): ProductsExportArgs {
  const { values, allowProductionTarget } = parseFlags(
    argv,
    new Set(['--tenant', '--target', '--expected-products-fingerprint', '--panel-map']),
    PRODUCTS_EXPORT_USAGE,
  );
  const tenant = required(values, '--tenant', PRODUCTS_EXPORT_USAGE);
  checkTenant(tenant);
  const target = required(values, '--target', PRODUCTS_EXPORT_USAGE);
  checkTarget(target);
  return {
    tenant,
    target,
    expectedProductsFingerprint: checkHash(
      '--expected-products-fingerprint',
      required(values, '--expected-products-fingerprint', PRODUCTS_EXPORT_USAGE),
    ),
    panelMap: values.get('--panel-map') ?? null,
    allowProductionTarget,
  };
}

/** Runs `products-read`; a SYNTHETIC source is never written to a production-like target. */
export async function runProductsRead(
  importer: Pick<LegacyImporterService, 'readProducts'>,
  connector: LegacySourceConnector,
  args: Pick<ProductsReadArgs, 'expectedFingerprint' | 'expectedProductsFingerprint' | 'batchSize'>,
  context: {
    readonly scope: TenantContext;
    readonly actor: ActorContext;
    readonly productionLikeTarget: boolean;
  },
): Promise<ProductsReadOutcome> {
  return importer.readProducts({
    scope: context.scope,
    actor: context.actor,
    connector,
    expectedFingerprint: args.expectedFingerprint,
    expectedProductsFingerprint: args.expectedProductsFingerprint,
    batchSize: args.batchSize,
    productionLikeTarget: context.productionLikeTarget,
  });
}

export function productsReadExitCode(outcome: ProductsReadOutcome): number {
  return outcome.written === null ? 3 : 0;
}

/** The outcome as text. Codes, hashes and counts only — never a legacy cell value. */
export function productsReadReport(outcome: ProductsReadOutcome, format: 'md' | 'json'): string {
  const body = {
    format: 'nexa-legacy-products-read/v1',
    synthetic: outcome.synthetic,
    sourceFingerprint: outcome.v1.fingerprint,
    fingerprintVersion: outcome.fingerprintVersion,
    productsFingerprint: outcome.fingerprint,
    productsSchemaHash: outcome.schemaHash,
    productRows: outcome.productRows,
    verdict: outcome.written === null ? 'NOT_APPROVED_NOTHING_WRITTEN' : 'INGESTED',
    ...(outcome.written === null
      ? {}
      : {
          counts: outcome.written.counts,
          skipped: outcome.written.skipped,
          readSetRun: {
            id: outcome.written.recorded.run.id,
            created: outcome.written.recorded.created,
          },
        }),
  };
  if (format === 'json') return `${JSON.stringify(body, null, 2)}\n`;
  const lines = [
    `# Legacy products read${outcome.synthetic ? ' (SYNTHETIC — not evidence)' : ''}`,
    '',
    `- source fingerprint (v1, approved): \`${body.sourceFingerprint}\``,
    `- products fingerprint (${body.fingerprintVersion}): \`${body.productsFingerprint}\``,
    `- product rows in the snapshot: ${String(body.productRows)}`,
    `- verdict: **${body.verdict}**`,
  ];
  if (outcome.written !== null) {
    const c = outcome.written.counts;
    lines.push(
      `- review rows: created ${String(c.created)}, unchanged ${String(c.unchanged)}, ` +
        `refreshed ${String(c.touched)} (reappeared ${String(c.reappeared)}), facts updated ` +
        `${String(c.factsUpdated)}, SOURCE_CHANGED ${String(c.sourceChanged)}, marked absent ` +
        `${String(c.markedMissing)}, still absent ${String(c.stillAbsent)}`,
      `- product rows not reviewable: empty code ${String(outcome.written.skipped.CODE_EMPTY)}, ` +
        `invalid code ${String(outcome.written.skipped.CODE_INVALID)}`,
      `- read set run: ${outcome.written.recorded.run.id}${outcome.written.recorded.created ? '' : ' (already recorded)'}`,
    );
  } else {
    lines.push(
      '',
      'Nothing was written. Approve the products fingerprint above, then run again with',
      '`--expected-products-fingerprint` set to it.',
    );
  }
  return `${lines.join('\n')}\n`;
}

export interface ProductsExportOutcome {
  readonly exported: LegacyProductExport;
  /** With `--panel-map`: the map with its `products` replaced, and that map's fingerprint. */
  readonly merged: { readonly file: PanelMappingFile; readonly fingerprint: string } | null;
}

/**
 * The panel map with its `products` section replaced by the export. A hand-written entry for
 * a code the review KNOWS must agree with the export (same product) or it is refused; an
 * entry for a code the review has no row for is kept as written.
 */
export function mergeProductsIntoMap(
  mapText: string,
  tenantId: string,
  exported: LegacyProductExport,
  reviewedCodes: ReadonlySet<string>,
): { readonly file: PanelMappingFile; readonly fingerprint: string } {
  const mapping = parsePanelMapping(mapText, tenantId);
  const byCode = new Map(exported.products.map((p) => [p.codeProduct, p.productId]));
  const problems: string[] = [];
  const kept: LegacyProductMapEntry[] = [];
  for (const entry of mapping.file.products) {
    if (!reviewedCodes.has(entry.codeProduct)) {
      kept.push(entry);
      continue;
    }
    const approved = byCode.get(entry.codeProduct);
    if (approved !== entry.productId) {
      problems.push(
        `code_product ${JSON.stringify(entry.codeProduct)} maps to ${entry.productId} in the map, ` +
          (approved === undefined
            ? 'but its review row is not approved for export'
            : `but its review row is approved to ${approved}`),
      );
    }
  }
  if (problems.length > 0) throw new PanelMappingRefused(problems);
  const products = [...kept, ...exported.products].sort((a, b) =>
    a.codeProduct < b.codeProduct ? -1 : a.codeProduct > b.codeProduct ? 1 : 0,
  );
  const file: PanelMappingFile = { ...mapping.file, products };
  return { file, fingerprint: sha256Hex(canonicalPanelMapping(file)) };
}
