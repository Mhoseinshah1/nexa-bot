import { canonicalJson } from './canonical-json.js';
import { containerInvalid, tampered, unsupportedVersion } from './errors.js';

/**
 * The payload contract (`payload_format = "zip-v1"`) — a port of the converter's
 * `mirza2nexa/nxpkg/manifest.py`. Content-schema rules beyond the container (readiness,
 * money unit, the minimum contract version the importer needs) belong to the importer, not
 * here: this reader accepts every `1.x.y`, as the converter's reader does.
 */

export const PACKAGE_SCHEMA = 'nexa.migration.mirza';
export const SUPPORTED_SCHEMA_MAJOR = 1;
export const PAYLOAD_FORMAT = 'zip-v1';
export const TARGET = 'nexa';
export const MANIFEST_NAME = 'manifest.json';
export const CHECKSUMS_NAME = 'checksums.json';
export const RESERVED_NAMES: ReadonlySet<string> = new Set([MANIFEST_NAME, CHECKSUMS_NAME]);

/**
 * Python's `SEMVER_RE`, restricted to ASCII digits and without `$`'s tolerance of one
 * trailing newline — both stricter than the Python reader, never looser.
 */
export const SEMVER_RE =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SEG = '[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}';
const RELPATH_RE = new RegExp(`^${SEG}(?:/${SEG}){0,7}$`);
const SHA256_RE = /^[0-9a-f]{64}$/;

export interface NxpkgFileEntry {
  sha256: string;
  size: number;
  /** Line count for `*.jsonl`, null for other files. */
  records: number | null;
}

export interface NxpkgManifest {
  package_schema: typeof PACKAGE_SCHEMA;
  package_schema_version: string;
  import_id: string;
  source_fingerprint: string;
  converter: { name: string; version: string; [k: string]: unknown };
  created_at: string;
  compatibility: { min_importer_version: string; target: typeof TARGET; [k: string]: unknown };
  files: Record<string, NxpkgFileEntry>;
  payload_format: typeof PAYLOAD_FORMAT;
  [field: string]: unknown;
}

export interface NxpkgChecksums {
  algorithm: 'sha256';
  files: Record<string, NxpkgFileEntry>;
}

/** Python `validate_relpath`: a simple relative POSIX path, nothing else. */
export function isSafeRelpath(relpath: unknown): relpath is string {
  if (typeof relpath !== 'string' || !RELPATH_RE.test(relpath)) return false;
  return relpath.split('/').every((seg) => seg !== '.' && seg !== '..' && !seg.endsWith('.'));
}

export function semverMajor(v: string): number {
  const m = SEMVER_RE.exec(v);
  if (!m) throw new RangeError('not a semver string');
  return Number(m[1]);
}

/** Compare two semver strings by major.minor.patch (pre-release/build ignored). */
export function compareSemverCore(a: string, b: string): number {
  const pa = SEMVER_RE.exec(a);
  const pb = SEMVER_RE.exec(b);
  if (!pa || !pb) throw new RangeError('not a semver string');
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Python `validate_file_entries(err=PackageTampered)`. */
export function validateFileEntries(
  files: unknown,
): asserts files is Record<string, NxpkgFileEntry> {
  if (!isPlainObject(files)) throw tampered('file_list_not_object');
  for (const [name, entry] of Object.entries(files)) {
    if (!isSafeRelpath(name)) throw tampered('file_list_unsafe_path');
    if (!isPlainObject(entry)) throw tampered('file_entry');
    const keys = Object.keys(entry).sort();
    if (keys.length !== 3 || keys[0] !== 'records' || keys[1] !== 'sha256' || keys[2] !== 'size') {
      throw tampered('file_entry');
    }
    if (typeof entry['sha256'] !== 'string' || !SHA256_RE.test(entry['sha256'])) {
      throw tampered('file_entry_sha256');
    }
    if (!isInt(entry['size']) || entry['size'] < 0) throw tampered('file_entry_size');
    const rec = entry['records'];
    if (rec !== null && !(isInt(rec) && rec >= 0)) throw tampered('file_entry_records');
  }
}

/**
 * The version gate the converter's reader applies BEFORE checking any content, so a future
 * package reads as unsupported rather than tampered.
 */
export function gateManifestVersion(m: unknown): void {
  if (!isPlainObject(m)) throw tampered('manifest_not_object');
  const v = m['package_schema_version'];
  if (typeof v !== 'string' || !SEMVER_RE.test(v)) {
    throw containerInvalid('manifest_package_schema_version');
  }
  if (semverMajor(v) !== SUPPORTED_SCHEMA_MAJOR) throw unsupportedVersion('package_schema_major');
  if (m['payload_format'] !== PAYLOAD_FORMAT) throw unsupportedVersion('payload_format');
}

/** Python `validate_manifest` (reader side, after authentication). */
export function validateManifest(m: unknown): asserts m is NxpkgManifest {
  const bad = (why: string) => containerInvalid(`manifest_${why}`);
  if (!isPlainObject(m)) throw bad('not_object');
  for (const f of [
    'package_schema',
    'package_schema_version',
    'import_id',
    'source_fingerprint',
    'converter',
    'created_at',
    'compatibility',
  ]) {
    if (!(f in m)) throw bad('missing_field');
  }
  if (m['package_schema'] !== PACKAGE_SCHEMA) throw bad('package_schema');
  const v = m['package_schema_version'];
  if (typeof v !== 'string' || !SEMVER_RE.test(v)) throw bad('package_schema_version');
  if (semverMajor(v) !== SUPPORTED_SCHEMA_MAJOR) throw unsupportedVersion('package_schema_major');
  for (const f of ['import_id', 'source_fingerprint', 'created_at']) {
    const s = m[f];
    if (typeof s !== 'string' || s.length === 0) throw bad(f);
  }
  const conv = m['converter'];
  if (
    !isPlainObject(conv) ||
    typeof conv['name'] !== 'string' ||
    typeof conv['version'] !== 'string'
  ) {
    throw bad('converter');
  }
  const comp = m['compatibility'];
  if (!isPlainObject(comp) || comp['target'] !== TARGET) throw bad('compatibility_target');
  const miv = comp['min_importer_version'];
  if (typeof miv !== 'string' || !SEMVER_RE.test(miv)) throw bad('min_importer_version');
  if (m['payload_format'] !== PAYLOAD_FORMAT) throw unsupportedVersion('payload_format');
  if (!('files' in m)) throw bad('files_missing');
  validateFileEntries(m['files']);
  for (const name of Object.keys(m['files'] as object)) {
    if (RESERVED_NAMES.has(name)) throw tampered('manifest_lists_reserved_file');
  }
}

/** Python `dict ==` for two JSON values of the same canonical shape. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a).equals(canonicalJson(b));
}
