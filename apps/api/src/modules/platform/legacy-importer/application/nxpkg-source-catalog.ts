import {
  LEGACY_IDENTIFIER_PATTERN,
  LEGACY_PRIMARY_KEYS,
  LEGACY_SOURCE_TABLES,
  LEGACY_SYNTHETIC_MARKER_TABLE,
  LegacySourceRefused,
  type LegacySourceTableName,
} from './source-port.js';

/**
 * Mirza `.nxpkg` importer — the package's raw SOURCE SNAPSHOT, as the importer may trust it
 * (`docs/legacy-migration/nxpkg-importer.md` §3; converter contract 1.4.0, `PACKAGE_CONTRACT.md`
 * §"Source snapshot", `mirza2nexa/source_snapshot.py`).
 *
 * `source/catalog.json` is what `information_schema` would have said about the dumped
 * database, and `source/tables/{user,invoice,product}.jsonl` are the rows of the three tables
 * the importer reads, as `CAST(col AS CHAR)` text in primary-key byte order. The package is
 * authenticated before any of this is read (`infrastructure/nxpkg/reader.ts`); this module
 * checks that what the converter wrote is the SHAPE the source port promises, and refuses
 * anything else — an unknown field, a snapshot table whose primary key is not the v1 one, a
 * row count that disagrees with the catalogue, a synthetic marker without its table.
 *
 * Every refusal is a `LegacySourceRefused` carrying a code and a fixed sentence: never a
 * cell value, never a key.
 */

export const NXPKG_CATALOG_PATH = 'source/catalog.json';
export const NXPKG_CATALOG_FORMAT = 'm2n.source-catalog.v1';
export const NXPKG_TABLE_FORMAT = 'm2n.source-table.v1';
export const NXPKG_SNAPSHOT_VERSION = 1;
export const NXPKG_ENGINE_HINTS = ['MYSQL', 'MARIADB'] as const;

/** The file a snapshot table's rows live in — the only path a catalogue may name. */
export function nxpkgTableFile(table: string): string {
  return `source/tables/${table}.jsonl`;
}

export interface NxpkgCatalogColumn {
  readonly column: string;
  readonly dataType: string;
  readonly ordinal: number;
  readonly charset: string | null;
}

export interface NxpkgCatalogTable {
  readonly name: string;
  readonly tableType: string;
  readonly storageEngine: string | null;
  readonly charset: string | null;
  readonly collation: string | null;
  /** The EXACT number of rows the dump inserts into the table (`COUNT(*)` after loading). */
  readonly rows: number;
  readonly columns: readonly NxpkgCatalogColumn[];
}

export interface NxpkgSnapshotTable {
  readonly table: LegacySourceTableName;
  readonly file: string;
  readonly primaryKey: string;
  /** The rows file's columns, in its fixed order — the only columns a read may project. */
  readonly columns: readonly string[];
  readonly rows: number;
}

export interface NxpkgSourceCatalog {
  readonly syntheticMarker: string | null;
  readonly engineHint: (typeof NXPKG_ENGINE_HINTS)[number] | null;
  readonly tables: readonly NxpkgCatalogTable[];
  readonly snapshotTables: ReadonlyMap<LegacySourceTableName, NxpkgSnapshotTable>;
}

const refuse = (detail: string): LegacySourceRefused =>
  new LegacySourceRefused('SOURCE_UNREADABLE', `the package source snapshot ${detail}`);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function exactKeys(o: Record<string, unknown>, keys: readonly string[], what: string): void {
  const own = Object.keys(o).sort();
  const want = [...keys].sort();
  if (own.length !== want.length || own.some((k, i) => k !== want[i])) {
    throw refuse(`${what} has an unexpected set of fields`);
  }
}

const nullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';
const count = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Parses `source/catalog.json` (already parsed as strict JSON). Fail closed on anything else. */
export function parseNxpkgSourceCatalog(json: unknown): NxpkgSourceCatalog {
  if (!isObject(json)) throw refuse('catalogue is not an object');
  exactKeys(
    json,
    ['format', 'snapshot_version', 'synthetic_marker', 'engine_hint', 'tables', 'snapshot_tables'],
    'catalogue',
  );
  if (json['format'] !== NXPKG_CATALOG_FORMAT) throw refuse('catalogue has an unknown format');
  if (json['snapshot_version'] !== NXPKG_SNAPSHOT_VERSION) {
    throw refuse('catalogue has an unsupported snapshot_version');
  }
  const marker = json['synthetic_marker'];
  if (!nullableString(marker) || marker === '') throw refuse('synthetic_marker is malformed');
  const hint = json['engine_hint'];
  if (hint !== null && !(NXPKG_ENGINE_HINTS as readonly unknown[]).includes(hint)) {
    throw refuse('engine_hint is not MYSQL, MARIADB or null');
  }

  const rawTables = json['tables'];
  if (!Array.isArray(rawTables)) throw refuse('tables is not a list');
  const tables: NxpkgCatalogTable[] = [];
  const byName = new Map<string, NxpkgCatalogTable>();
  for (const raw of rawTables) {
    if (!isObject(raw)) throw refuse('a table entry is not an object');
    exactKeys(
      raw,
      ['name', 'table_type', 'storage_engine', 'charset', 'collation', 'rows', 'columns'],
      'a table entry',
    );
    const name = raw['name'];
    if (typeof name !== 'string' || name === '') throw refuse('a table has no name');
    if (byName.has(name)) throw refuse('lists a table twice');
    if (typeof raw['table_type'] !== 'string') throw refuse('a table_type is not text');
    for (const f of ['storage_engine', 'charset', 'collation'] as const) {
      if (!nullableString(raw[f])) throw refuse(`a table's ${f} is malformed`);
    }
    if (!count(raw['rows'])) throw refuse('a table row count is not a whole number');
    const rawColumns = raw['columns'];
    if (!Array.isArray(rawColumns)) throw refuse('a table has no column list');
    const seen = new Set<string>();
    const columns = rawColumns.map((c, i): NxpkgCatalogColumn => {
      if (!isObject(c)) throw refuse('a column entry is not an object');
      exactKeys(c, ['column', 'data_type', 'ordinal', 'charset'], 'a column entry');
      const column = c['column'];
      const dataType = c['data_type'];
      if (typeof column !== 'string' || column === '' || seen.has(column)) {
        throw refuse('a column name is missing or repeated');
      }
      seen.add(column);
      if (typeof dataType !== 'string' || dataType === '' || dataType !== dataType.toLowerCase()) {
        throw refuse('a data_type is not lowercase text');
      }
      if (c['ordinal'] !== i + 1) throw refuse('column ordinals are not 1..n in order');
      if (!nullableString(c['charset'])) throw refuse("a column's charset is malformed");
      return { column, dataType, ordinal: i + 1, charset: c['charset'] };
    });
    const table: NxpkgCatalogTable = {
      name,
      tableType: raw['table_type'],
      storageEngine: raw['storage_engine'] as string | null,
      charset: raw['charset'] as string | null,
      collation: raw['collation'] as string | null,
      rows: raw['rows'],
      columns,
    };
    tables.push(table);
    byName.set(name, table);
  }

  // The marker is the TABLE's presence (mysql-legacy-source.ts syntheticMarker): a catalogue
  // that lists the table and says null, or names a label without it, is not one source.
  const markerTable = byName.has(LEGACY_SYNTHETIC_MARKER_TABLE);
  if (markerTable !== (marker !== null)) {
    throw refuse('synthetic_marker disagrees with the presence of the marker table');
  }

  const rawSnapshot = json['snapshot_tables'];
  if (!isObject(rawSnapshot)) throw refuse('snapshot_tables is not an object');
  const snapshotTables = new Map<LegacySourceTableName, NxpkgSnapshotTable>();
  for (const [key, raw] of Object.entries(rawSnapshot)) {
    if (!(LEGACY_SOURCE_TABLES as readonly string[]).includes(key)) {
      throw refuse('snapshot_tables names a table the importer does not read');
    }
    const table = key as LegacySourceTableName;
    if (!isObject(raw)) throw refuse('a snapshot table entry is not an object');
    exactKeys(raw, ['file', 'primary_key', 'columns', 'rows'], 'a snapshot table entry');
    if (raw['file'] !== nxpkgTableFile(table)) throw refuse('a snapshot table names another file');
    if (raw['primary_key'] !== LEGACY_PRIMARY_KEYS[table]) {
      throw refuse(`${table}'s primary key is not the v1 one`);
    }
    const columns = raw['columns'];
    if (
      !Array.isArray(columns) ||
      columns.length === 0 ||
      !columns.every((c) => typeof c === 'string' && LEGACY_IDENTIFIER_PATTERN.test(c)) ||
      new Set(columns).size !== columns.length
    ) {
      throw refuse(`${table}'s column list is malformed`);
    }
    if (!columns.includes(LEGACY_PRIMARY_KEYS[table])) {
      throw refuse(`${table}'s rows file does not carry its primary key`);
    }
    const described = byName.get(table);
    if (described === undefined) throw refuse(`${table} has rows but no catalogue entry`);
    const known = new Set(described.columns.map((c) => c.column));
    if (!(columns as string[]).every((c) => known.has(c))) {
      throw refuse(`${table}'s rows file carries a column the catalogue does not describe`);
    }
    if (!count(raw['rows'])) throw refuse(`${table}'s row count is not a whole number`);
    // Every row the dump inserts must be in the file: a row the converter could not
    // represent would otherwise vanish from the fingerprint without a trace.
    if (raw['rows'] !== described.rows) {
      throw refuse(`${table}'s rows file does not hold every row of the table`);
    }
    snapshotTables.set(table, {
      table,
      file: raw['file'],
      primaryKey: raw['primary_key'],
      columns: Object.freeze([...(columns as string[])]),
      rows: raw['rows'],
    });
  }

  return {
    syntheticMarker: marker,
    engineHint: hint as NxpkgSourceCatalog['engineHint'],
    tables,
    snapshotTables,
  };
}

/** Line 1 of a rows file must be exactly this header (canonical key order is irrelevant). */
export function assertNxpkgTableHeader(line: unknown, spec: NxpkgSnapshotTable): void {
  if (!isObject(line)) throw refuse(`${spec.table}'s rows file has no header`);
  exactKeys(line, ['columns', 'format', 'primary_key', 'table'], `${spec.table}'s header`);
  const columns = line['columns'];
  if (
    line['format'] !== NXPKG_TABLE_FORMAT ||
    line['table'] !== spec.table ||
    line['primary_key'] !== spec.primaryKey ||
    !Array.isArray(columns) ||
    columns.length !== spec.columns.length ||
    columns.some((c, i) => c !== spec.columns[i])
  ) {
    throw refuse(`${spec.table}'s rows file header disagrees with the catalogue`);
  }
}

/** One data line: `{"c": [string | null, …]}` with exactly one cell per header column. */
export function nxpkgRowCells(line: unknown, spec: NxpkgSnapshotTable): readonly (string | null)[] {
  if (!isObject(line)) throw refuse(`${spec.table}'s rows file holds a line that is not a row`);
  const keys = Object.keys(line);
  const cells = line['c'];
  if (
    keys.length !== 1 ||
    !Array.isArray(cells) ||
    cells.length !== spec.columns.length ||
    !cells.every(nullableString)
  ) {
    throw refuse(`${spec.table}'s rows file holds a malformed row`);
  }
  return cells;
}
