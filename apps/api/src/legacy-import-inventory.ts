import {
  LEGACY_TABLE_CLASSIFICATION,
  type ActorContext,
  type TenantContext,
} from '@nexa/contracts';
import {
  DSN_PASSWORD_REFUSAL,
  PASSWORD_FLAG_REFUSAL,
  hasUrlPassword,
  isPasswordFlag,
} from './legacy-import-argv.js';
import {
  INVENTORY_READ_SET_NAME,
  INVENTORY_READ_SET_VERSION,
  takeLegacyInventory,
  type LegacyInventory,
} from './modules/platform/legacy-importer/application/legacy-inventory.js';
import type { LegacyImporterService } from './modules/platform/legacy-importer/application/legacy-importer.service.js';
import type { LegacyReadSetRun } from './modules/platform/legacy-importer/application/ports.js';
import { decideEvidenceClass } from './modules/platform/legacy-importer/application/production-guard.js';
import type { LegacySourceConnector } from './modules/platform/legacy-importer/application/source-port.js';

/**
 * `legacy-import inventory` — every table of the legacy database, classified and counted,
 * with no row value (Mirza migration PR1, `docs/legacy-migration/table-inventory.md`).
 *
 * READ-ONLY on the source (one READ ONLY session, write probe refused, exact `COUNT(*)`
 * inside its snapshot). On the target it writes at most ONE thing: with
 * `--expected-fingerprint` matching the v1 fingerprint the same session recomputed, the
 * inventory's read-set fingerprint is recorded in `legacy_read_set_runs` (insert-or-nothing,
 * audited, `maintenance.run`). Without it the inventory is printed, verdict
 * `FINGERPRINT_UNBOUND`, and nothing is written at all. A mismatch is refused before any
 * table is counted (exit 65). No `--panel-map`: the inventory decides nothing about panels.
 *
 * Exit: 0 COMPLETE; 3 BLOCKED, UNCLASSIFIED_TABLES or FINGERPRINT_UNBOUND; 65 a refused
 * source; 64 usage; 1 anything else.
 */

export class InventoryUsageError extends Error {}

export const INVENTORY_USAGE = [
  'usage: legacy-import inventory --tenant TENANT --source SOURCE --target TARGET',
  '                               [--expected-fingerprint HEX] [--format md|json]',
  '                               [--source-password-env NAME] [--allow-production-target]',
  '',
  '  Every table of the legacy database: name, class, column count, hash of its',
  '  name:data_type list, EXACT COUNT(*), engine, charset, collation. Never a value.',
  '  --expected-fingerprint HEX  the approved v1 source fingerprint (audit prints it). The',
  '                              same session recomputes it; a mismatch is refused (exit 65).',
  '                              With a match the inventory fingerprint is recorded in',
  '                              legacy_read_set_runs; without the flag nothing is written.',
  '  SOURCE and TARGET as for the import modes (env:NAME, mysql://…, fixture:PATH).',
  '  Exit 0 only when every table is classified and the fingerprint is bound.',
].join('\n');

export interface InventoryArgs {
  readonly tenant: string;
  readonly source: string;
  readonly sourcePasswordEnv: string | null;
  readonly target: string;
  readonly expectedFingerprint: string | null;
  readonly format: 'md' | 'json';
  readonly allowProductionTarget: boolean;
}

const VALUE_FLAGS = new Set([
  '--tenant',
  '--source',
  '--source-password-env',
  '--target',
  '--expected-fingerprint',
  '--format',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/u;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

export function parseInventoryArgs(argv: readonly string[]): InventoryArgs {
  const values = new Map<string, string>();
  let allowProductionTarget = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (isPasswordFlag(arg)) throw new InventoryUsageError(PASSWORD_FLAG_REFUSAL);
    if (arg === '--allow-production-target') {
      allowProductionTarget = true;
      continue;
    }
    if (arg === '--out' || arg === '--panel-map') {
      throw new InventoryUsageError(
        `${arg} does not apply to inventory: it prints to stdout and reads no panel map.`,
      );
    }
    if (!VALUE_FLAGS.has(arg)) {
      throw new InventoryUsageError(`Unknown argument ${arg}.\n\n${INVENTORY_USAGE}`);
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new InventoryUsageError(`${arg} needs a value.`);
    }
    if (values.has(arg)) throw new InventoryUsageError(`${arg} is given twice.`);
    values.set(arg, next);
    i += 1;
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) {
      throw new InventoryUsageError(
        `${flag} is required. There is no default.\n\n${INVENTORY_USAGE}`,
      );
    }
    return value;
  };
  const tenant = required('--tenant');
  if (!UUID.test(tenant) && !SLUG.test(tenant)) {
    throw new InventoryUsageError('--tenant must be a lowercase tenant uuid or slug.');
  }
  const source = required('--source');
  const target = required('--target');
  if (hasUrlPassword(source) || hasUrlPassword(target)) {
    throw new InventoryUsageError(DSN_PASSWORD_REFUSAL);
  }
  for (const spec of [source, target]) {
    if (spec.startsWith('env:') && !ENV_NAME.test(spec.slice(4))) {
      throw new InventoryUsageError(`${spec} does not name an environment variable.`);
    }
  }
  if (!/^(env:|mysql:\/\/|mariadb:\/\/|fixture:)/u.test(source)) {
    throw new InventoryUsageError('--source must be env:NAME, mysql://… or fixture:PATH.');
  }
  if (!/^(env:|postgres:\/\/|postgresql:\/\/)/u.test(target) && !DATABASE_NAME.test(target)) {
    throw new InventoryUsageError('--target must be env:NAME, postgres://… or a database name.');
  }
  const sourcePasswordEnv = values.get('--source-password-env') ?? null;
  if (
    sourcePasswordEnv !== null &&
    (!ENV_NAME.test(sourcePasswordEnv) || !/^(mysql|mariadb):\/\//u.test(source))
  ) {
    throw new InventoryUsageError(
      '--source-password-env names a variable and applies to a literal mysql:// source only.',
    );
  }
  const expectedFingerprint = values.get('--expected-fingerprint') ?? null;
  if (expectedFingerprint !== null && !SHA256_HEX.test(expectedFingerprint)) {
    throw new InventoryUsageError(
      '--expected-fingerprint is a SHA-256 as 64 lowercase hex characters, as audit prints it.',
    );
  }
  const format = values.get('--format') ?? 'md';
  if (format !== 'md' && format !== 'json') {
    throw new InventoryUsageError('--format must be md or json.');
  }
  return {
    tenant,
    source,
    sourcePasswordEnv,
    target,
    expectedFingerprint,
    format,
    allowProductionTarget,
  };
}

export interface InventoryOutcome {
  readonly inventory: LegacyInventory;
  /** The recorded observation; null when the inventory was not bound (nothing written). */
  readonly recorded: { readonly run: LegacyReadSetRun; readonly created: boolean } | null;
}

/**
 * Takes the inventory and, only when it is bound to the approved v1 source, records its
 * fingerprint. A SYNTHETIC-marked source is never recorded against a production-like
 * target (the evidence-class rule every mode follows).
 */
export async function runInventory(
  importer: Pick<LegacyImporterService, 'recordReadSetRun'>,
  connector: LegacySourceConnector,
  args: Pick<InventoryArgs, 'expectedFingerprint'>,
  context: {
    readonly scope: TenantContext;
    readonly actor: ActorContext;
    readonly productionLikeTarget: boolean;
  },
): Promise<InventoryOutcome> {
  const inventory = await takeLegacyInventory(
    connector,
    args.expectedFingerprint,
    Object.keys(LEGACY_TABLE_CLASSIFICATION),
  );
  const label = decideEvidenceClass({
    claim: null,
    syntheticSource: inventory.synthetic,
    productionLikeTarget: context.productionLikeTarget,
  });
  if (!label.ok) throw new InventoryUsageError(label.message);
  if (!inventory.importV1.bound) return { inventory, recorded: null };
  const recorded = await importer.recordReadSetRun(context.scope, context.actor, {
    readSet: INVENTORY_READ_SET_NAME,
    readSetVersion: INVENTORY_READ_SET_VERSION,
    fingerprintVersion: inventory.fingerprintVersion,
    readSetFingerprint: inventory.fingerprint,
    sourceFingerprint: inventory.importV1.fingerprint,
    sourceSchemaHash: inventory.importV1.schemaHash,
    sourceEngine: inventory.engine,
    synthetic: inventory.synthetic,
    tableCount: inventory.totals.tables,
    rowCount: BigInt(inventory.totals.rows),
  });
  return { inventory, recorded };
}

export function inventoryExitCode(inventory: LegacyInventory): number {
  return inventory.verdict === 'COMPLETE' ? 0 : 3;
}
