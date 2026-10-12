import type { LegacyTableClassification } from '@nexa/contracts';
import { LEGACY_IDENTIFIER_PATTERN, LegacySourceRefused } from './source-port.js';

/**
 * Mirza `.nxpkg` importer — every legacy table accounted for, from the package's own
 * coverage report (`docs/legacy-migration/nxpkg-importer.md` §5a).
 *
 * The frozen catalogue (`LEGACY_TABLE_CLASSIFICATION`) names the tables NEXA's read sets READ:
 * `user`, `invoice`, `product`. A real Mirza backup has about fifty more. On the MySQL path
 * each stays `UNCLASSIFIED` until a reviewed commit classifies it, and the inventory is never
 * COMPLETE. A package is different: the converter has ALREADY decided every table, with
 * evidence, in its own reviewed catalogue, and says what it did with each in
 * `reports/coverage.json` — authenticated by the package's AEAD like every other file. The
 * converter refuses to write a package with a non-empty uncatalogued table
 * (`UNCLASSIFIED_TABLE`) or with a catalogued table whose rows are not all accounted
 * (`COVERAGE_INCOMPLETE`).
 *
 * So for a package, and ONLY for a table the frozen catalogue does not name, NEXA derives a
 * class from that report by a fixed rule, and fails closed on anything else:
 *
 * | converter class                     | condition                                     | NEXA class       |
 * | ----------------------------------- | --------------------------------------------- | ---------------- |
 * | ARCHIVE / REVIEW / CONFIGURATION    | rows equal the source catalogue's, all rows   | `ARCHIVE`        |
 * |                                     | accounted, not `blocked`                      |                  |
 * | EXCLUDED, sensitivity `secret`      | rows equal; nothing carried                   | `SECRETS_MANUAL` |
 * | EXCLUDED, any other sensitivity     | rows equal; nothing carried                   | `OWNER_DECISION` |
 * | none (unknown to the converter)     | EMPTY in the source catalogue                 | `OWNER_DECISION` |
 * | anything else — OPERATIONAL outside | —                                             | `UNCLASSIFIED`   |
 * |   the catalogue, a row count that   |                                               |                  |
 * |   disagrees, rows not accounted,    |                                               |                  |
 * |   no coverage row at all            |                                               |                  |
 *
 * `ARCHIVE` here means what the class says everywhere: read-only history. The converter carried
 * the table's allowlisted rows as `records/…` history, which NEXA ingests into
 * `legacy_history_records` (never a balance, an order, a payment, a service or a role). No
 * read set reads such a table's rows from a package: the package carries none outside its
 * history files.
 */

export const NXPKG_COVERAGE_PATH = 'reports/coverage.json';

const CONVERTER_CLASSES = [
  'OPERATIONAL',
  'ARCHIVE',
  'REVIEW',
  'CONFIGURATION',
  'EXCLUDED',
] as const;
type ConverterClass = (typeof CONVERTER_CLASSES)[number];
const HISTORY_CLASSES: ReadonlySet<ConverterClass> = new Set([
  'ARCHIVE',
  'REVIEW',
  'CONFIGURATION',
]);

/** One table's line of the converter's coverage report, as NEXA reads it. */
export interface NxpkgCoverageEntry {
  readonly table: string;
  readonly converterClass: ConverterClass | null;
  readonly status: string;
  readonly rows: number;
  readonly exported: number;
  readonly archived: number;
  readonly review: number;
  readonly skipped: number;
  readonly accountedRows: number;
  readonly sensitivity: string | null;
  /** The converter's one-line reason (its catalogue's), for the report; never decides. */
  readonly reason: string | null;
}

const refuse = (detail: string): LegacySourceRefused =>
  new LegacySourceRefused('SOURCE_UNREADABLE', `the package coverage report ${detail}`);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function count(row: Record<string, unknown>, key: string, table: string): number {
  const value = row[key] ?? 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw refuse(`gives ${table} a ${key} that is not a non-negative integer`);
  }
  return value;
}

function optionalText(row: Record<string, unknown>, key: string, table: string): string | null {
  const value = row[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 2000) {
    throw refuse(`gives ${table} a ${key} that is not a short string`);
  }
  return value;
}

/**
 * `reports/coverage.json`, strictly: `{"tables": [...]}`, one row per table, each table once,
 * its counts non-negative integers and its class one of the converter's five (or null for a
 * table the converter does not know). Fields this reader does not use are ignored — the
 * report is the converter's, and its extra facts (columns, redactions) are for people.
 */
export function parseNxpkgCoverage(value: unknown): ReadonlyMap<string, NxpkgCoverageEntry> {
  if (!isObject(value) || !Array.isArray(value['tables'])) throw refuse('is not {"tables": [...]}');
  const out = new Map<string, NxpkgCoverageEntry>();
  for (const row of value['tables']) {
    if (!isObject(row)) throw refuse('has a row that is not an object');
    const table = row['table'];
    if (typeof table !== 'string' || !LEGACY_IDENTIFIER_PATTERN.test(table)) {
      throw refuse('names a table that is not a legacy identifier');
    }
    if (out.has(table)) throw refuse(`lists ${table} twice`);
    const klass = row['class'];
    if (klass !== null && !(CONVERTER_CLASSES as readonly unknown[]).includes(klass)) {
      throw refuse(`gives ${table} an unknown class`);
    }
    const status = row['status'];
    if (typeof status !== 'string' || !/^[a-z_]{1,32}$/u.test(status)) {
      throw refuse(`gives ${table} no status`);
    }
    out.set(table, {
      table,
      converterClass: klass as ConverterClass | null,
      status,
      rows: count(row, 'rows', table),
      exported: count(row, 'exported', table),
      archived: count(row, 'archived', table),
      review: count(row, 'review', table),
      skipped: count(row, 'skipped', table),
      accountedRows: count(row, 'accounted_rows', table),
      sensitivity: optionalText(row, 'sensitivity', table),
      reason: optionalText(row, 'reason', table),
    });
  }
  return out;
}

const UNCLASSIFIED = (reason: string): Readonly<LegacyTableClassification> =>
  Object.freeze({ class: 'UNCLASSIFIED', reason, evidence: NXPKG_COVERAGE_PATH });

/**
 * The class a package earns a table the frozen catalogue does not name — the rule in the
 * header, and nothing else. `catalogRows` is the table's exact row count in the package's
 * source catalogue (`source/catalog.json`); the two reports must agree.
 */
export function classifyFromCoverage(
  entry: NxpkgCoverageEntry | undefined,
  catalogRows: number,
): Readonly<LegacyTableClassification> {
  if (entry === undefined) {
    return UNCLASSIFIED('The package coverage report has no row for this table.');
  }
  if (entry.rows !== catalogRows) {
    return UNCLASSIFIED(
      'The package coverage report and source catalogue disagree on the row count.',
    );
  }
  const evidence = `${NXPKG_COVERAGE_PATH}: converter class ${entry.converterClass ?? 'none'}, status ${entry.status}, ${String(entry.accountedRows)} of ${String(entry.rows)} rows accounted`;
  if (entry.converterClass === null) {
    return entry.rows === 0
      ? Object.freeze({
          class: 'OWNER_DECISION',
          reason:
            'An EMPTY table the converter does not know: there is no row to carry; what the table is stays the owner’s question.',
          evidence,
        })
      : UNCLASSIFIED('A non-empty table the converter does not know.');
  }
  if (HISTORY_CLASSES.has(entry.converterClass)) {
    if (entry.status === 'blocked' || entry.accountedRows !== entry.rows) {
      return UNCLASSIFIED('The converter did not account for every row of this table.');
    }
    return Object.freeze({
      class: 'ARCHIVE',
      reason:
        'Carried by the converter as read-only history records (records/…), ingested into legacy_history_records; never a balance, order, payment, service or role.',
      evidence,
    });
  }
  if (entry.converterClass === 'EXCLUDED') {
    if (entry.exported + entry.archived + entry.review > 0) {
      return UNCLASSIFIED('An excluded table that nevertheless reports carried rows.');
    }
    return Object.freeze(
      entry.sensitivity === 'secret'
        ? {
            class: 'SECRETS_MANUAL',
            reason:
              'Excluded by the converter as secret-bearing: not carried; anything needed from it is re-entered in NEXA by a person.',
            evidence,
          }
        : {
            class: 'OWNER_DECISION',
            reason:
              'Excluded by the converter (its catalogue states why): not carried; counted, never migrated.',
            evidence,
          },
    );
  }
  // OPERATIONAL outside the frozen catalogue: the converter would have NEXA act on a table
  // NEXA has no read set for. Never.
  return UNCLASSIFIED('An operational table NEXA has no reviewed read set for.');
}
