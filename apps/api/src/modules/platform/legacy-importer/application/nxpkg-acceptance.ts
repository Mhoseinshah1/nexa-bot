import type { LegacyNxpkgErrorCode } from '@nexa/contracts';
import { NXPKG_CATALOG_PATH, parseNxpkgSourceCatalog } from './nxpkg-source-catalog.js';
import { LEGACY_SOURCE_TABLES } from './source-port.js';

/**
 * Mirza `.nxpkg` importer — may this package be imported at all? (`docs/legacy-migration/
 * nxpkg-importer.md` §1, after the container checks `openNxpkg` already made.)
 *
 * Every check is fail closed and reports a CODE from `LEGACY_NXPKG_ERROR_CODES` with a fixed
 * detail naming at most a file, a field or a flag — never a record value:
 *
 * | check | code |
 * |---|---|
 * | `package_schema` is `nexa.migration.mirza`, major 1, version `>= 1.4.0` (plain `x.y.z`) | `NXPKG_UNSUPPORTED_VERSION` |
 * | `import_id` and `source_fingerprint` present | `NXPKG_CONTAINER_INVALID` |
 * | `readiness == "ready"`, `blockers == []` | `NXPKG_NOT_READY` |
 * | `source/catalog.json` valid, with `user`, `invoice`, `product` rows files | `NXPKG_SOURCE_SNAPSHOT_MISSING` |
 * | `money` is `{declared_unit: toman, currency: IRT, rescaled: false}` | `NXPKG_MONEY_UNIT` |
 * | every `legacy_panel_target.target` is `rickpanel` / `RickPanel` | `PANEL_TARGET_MISMATCH` |
 * | no `records/**.jsonl` record carries a live-state flag other than `false` | `NXPKG_LIVE_FLAG` |
 *
 * The live-flag scan streams every record file once; nothing is kept but counts.
 */

/** What the checks read of an opened package. `NxpkgPackage` is one. */
export interface NxpkgContent {
  readonly manifest: Readonly<Record<string, unknown>>;
  files(): readonly { readonly path: string }[];
  has(rel: string): boolean;
  readJson(rel: string): Promise<unknown>;
  iterJsonl(rel: string): AsyncIterable<Record<string, unknown>>;
}

export interface NxpkgAcceptanceProblem {
  readonly code: LegacyNxpkgErrorCode;
  readonly detail: string;
}

export interface NxpkgAcceptance {
  readonly ok: boolean;
  readonly problems: readonly NxpkgAcceptanceProblem[];
}

/** The lowest content contract the importer reads: the source snapshot arrived in 1.4.0. */
export const NXPKG_MIN_CONTRACT = [1, 4, 0] as const;
export const NXPKG_PACKAGE_SCHEMA = 'nexa.migration.mirza';
export const NXPKG_PANEL_TARGETS_PATH = 'records/panel_target_mapping.jsonl';

/**
 * The live-state flags of the converter's contract (`PACKAGE_CONTRACT.md` "Fields every record
 * has"), plus the three it fixes to false on specific records (`services_reprovisioned`,
 * `credentials_in_package` on panel targets, `role_active` on agent state). Present means
 * `false`; anything else — `true`, a string, a number, null — refuses the package.
 */
export const NXPKG_LIVE_FLAGS: readonly string[] = [
  'affects_wallet',
  'creates_payment',
  'creates_order',
  'counts_as_revenue',
  'enters_live_payment_state_machine',
  'triggers_service',
  'provision',
  'applies_to_live_state',
  'applied_to_balance',
  'activates_role',
  'grants_credit',
  'redeemable',
  'auto_create',
  'services_reprovisioned',
  'credentials_in_package',
  'role_active',
];
const LIVE_FLAGS: ReadonlySet<string> = new Set(NXPKG_LIVE_FLAGS);

const PLAIN_SEMVER = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/u;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether `version` is a plain `1.x.y` at or above 1.4.0. */
export function isSupportedNxpkgContract(version: unknown): boolean {
  if (typeof version !== 'string') return false;
  const m = PLAIN_SEMVER.exec(version);
  if (m === null) return false;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [, minMinor, minPatch] = NXPKG_MIN_CONTRACT;
  if (major !== 1) return false;
  return minor !== minMinor ? minor > minMinor : patch >= minPatch;
}

/** Counts, per flag, the values other than `false` anywhere inside one record. */
function liveFlagsIn(value: unknown, found: Map<string, number>, depth = 0): void {
  if (depth > 64) {
    found.set('(too deep)', (found.get('(too deep)') ?? 0) + 1);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) liveFlagsIn(v, found, depth + 1);
    return;
  }
  if (!isObject(value)) return;
  for (const [k, v] of Object.entries(value)) {
    if (LIVE_FLAGS.has(k) && v !== false) found.set(k, (found.get(k) ?? 0) + 1);
    if (typeof v === 'object' && v !== null) liveFlagsIn(v, found, depth + 1);
  }
}

export async function checkNxpkgForImport(pkg: NxpkgContent): Promise<NxpkgAcceptance> {
  const problems: NxpkgAcceptanceProblem[] = [];
  const add = (code: LegacyNxpkgErrorCode, detail: string) => problems.push({ code, detail });
  const m = pkg.manifest;

  // --- version -------------------------------------------------------------------------
  if (m['package_schema'] !== NXPKG_PACKAGE_SCHEMA) {
    add('NXPKG_UNSUPPORTED_VERSION', 'manifest.package_schema is not nexa.migration.mirza');
  }
  if (!isSupportedNxpkgContract(m['package_schema_version'])) {
    add(
      'NXPKG_UNSUPPORTED_VERSION',
      'manifest.package_schema_version is not a plain 1.x.y at or above 1.4.0',
    );
  }
  for (const field of ['import_id', 'source_fingerprint'] as const) {
    const v = m[field];
    if (typeof v !== 'string' || v.trim() === '') {
      add('NXPKG_CONTAINER_INVALID', `manifest.${field} is missing`);
    }
  }

  // --- readiness -----------------------------------------------------------------------
  if (m['readiness'] !== 'ready') add('NXPKG_NOT_READY', 'manifest.readiness is not "ready"');
  const blockers = m['blockers'];
  if (!Array.isArray(blockers) || blockers.length > 0) {
    add('NXPKG_NOT_READY', 'manifest.blockers is not an empty list');
  }

  // --- money ---------------------------------------------------------------------------
  const money = m['money'];
  if (
    !isObject(money) ||
    money['declared_unit'] !== 'toman' ||
    money['currency'] !== 'IRT' ||
    money['rescaled'] !== false
  ) {
    add('NXPKG_MONEY_UNIT', 'manifest.money is not unrescaled Toman (IRT)');
  }

  // --- the source snapshot -------------------------------------------------------------
  if (!pkg.has(NXPKG_CATALOG_PATH)) {
    add('NXPKG_SOURCE_SNAPSHOT_MISSING', `${NXPKG_CATALOG_PATH} is missing`);
  } else {
    try {
      const catalog = parseNxpkgSourceCatalog(await pkg.readJson(NXPKG_CATALOG_PATH));
      for (const table of LEGACY_SOURCE_TABLES) {
        const spec = catalog.snapshotTables.get(table);
        if (spec === undefined || !pkg.has(spec.file)) {
          add('NXPKG_SOURCE_SNAPSHOT_MISSING', `source/tables/${table}.jsonl is missing`);
        }
      }
    } catch {
      add(
        'NXPKG_SOURCE_SNAPSHOT_MISSING',
        `${NXPKG_CATALOG_PATH} is not a valid snapshot catalogue`,
      );
    }
  }

  // --- panel targets: RickPanel only ---------------------------------------------------
  if (pkg.has(NXPKG_PANEL_TARGETS_PATH)) {
    let refused = 0;
    for await (const record of pkg.iterJsonl(NXPKG_PANEL_TARGETS_PATH)) {
      if (record['record_type'] !== 'legacy_panel_target') {
        refused += 1;
        continue;
      }
      const target = record['target'];
      if (target === null) continue;
      if (
        !isObject(target) ||
        target['provider_type'] !== 'rickpanel' ||
        target['provider_display_name'] !== 'RickPanel'
      ) {
        refused += 1;
      }
    }
    if (refused > 0) {
      add(
        'PANEL_TARGET_MISMATCH',
        `${String(refused)} panel target record(s) are not a RickPanel (rickpanel) target`,
      );
    }
  }

  // --- live-state flags ----------------------------------------------------------------
  for (const { path } of pkg.files()) {
    if (!path.startsWith('records/') || !path.endsWith('.jsonl')) continue;
    const found = new Map<string, number>();
    for await (const record of pkg.iterJsonl(path)) liveFlagsIn(record, found);
    for (const [flag, n] of [...found].sort(([a], [b]) => (a < b ? -1 : 1))) {
      add('NXPKG_LIVE_FLAG', `${path}: ${String(n)} record(s) carry ${flag} other than false`);
    }
  }

  return { ok: problems.length === 0, problems };
}
