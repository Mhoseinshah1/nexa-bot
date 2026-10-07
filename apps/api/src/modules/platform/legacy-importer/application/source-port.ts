/**
 * Migration P7 — the legacy source, as the importer may see it
 * (`docs/legacy-migration/importer.md` §Source).
 *
 * The legacy MirzaBot database is SOURCE DATA ONLY. This port is shaped so that nothing
 * written against it can change the source:
 *
 * - A session is one READ ONLY transaction over one consistent snapshot. The adapter
 *   proves, when the session opens, that a write is refused (`readOnlyProof`), and refuses
 *   to hand out a session otherwise.
 * - Rows come from a closed set of tables and a closed set of columns, every value as text
 *   (`CAST(… AS CHAR)`), in one canonical order: the primary key's bytes. The same order
 *   in every adapter is what makes the fingerprint an identity rather than an accident of
 *   an engine's collation.
 * - `aggregate` exists for the Item 1 evidence runner only, and only the fixed catalogue in
 *   `sql-evidence.ts` is passed to it. It runs inside the same READ ONLY transaction.
 *
 * No method takes a table or column name a caller made up: `LegacySourceTable` and the
 * column lists below are the vocabulary.
 */

/**
 * The import read set, FROZEN as v1 (`legacy-source-fingerprint:v1`).
 *
 * Every value below is an input to the source fingerprint the owner approves
 * (`source-snapshot.ts`): the tables, their primary keys, the columns read, the column kept
 * out. Adding a column, a table or an exclusion here changes the fingerprint of EVERY
 * source — an approval would silently stop matching. So nothing here moves: a new read of
 * the legacy database is a separate, versioned read set (`read-set.ts`,
 * `legacy-read-set:<name>:v<n>`) with its own allowlist and its own fingerprint, and
 * `tests/unit/legacy-import-read-set-v1.test.ts` pins this object and the synthetic v1
 * fingerprint literally, so an edit fails CI rather than an approval in production.
 *
 * Deep-frozen: a caller that mutates an array at run time throws instead of changing v1.
 */
export const IMPORT_READ_SET_V1 = deepFreeze({
  fingerprintVersion: 'legacy-source-fingerprint:v1',
  tables: ['user', 'invoice', 'product'],
  /** Each table's primary key — the canonical row order is its bytes. */
  primaryKeys: {
    user: 'id',
    invoice: 'id_invoice',
    product: 'id',
  },
  /**
   * Columns the importer cannot decide without. A source missing one is refused before any
   * row is read (`SOURCE_SCHEMA_MISSING_COLUMN`), never read around.
   *
   * Evidence: the program's queries (`docs/legacy-migration/sql-evidence.md` Q1–Q7) name
   * every one of these; `id_invoice` and `product.id` are the primary keys of the public
   * MirzaBot source (`mahdiMGF2/botmirzapanel` @ 92c0ed06, `table.php`).
   */
  requiredColumns: {
    user: ['id', 'Balance', 'limit_usertest'],
    invoice: [
      'id_invoice',
      'id_user',
      'username',
      'Status',
      'is_test',
      'code_panel',
      'code_product',
      'Volume',
      'Service_time',
      'time_unit',
      'is_custom',
      'price_product',
    ],
    product: ['id', 'code_product'],
  },
  /**
   * Columns read when present and null when absent. None of them decides money, identity,
   * a panel or a trial: `agent` is reported (resellers are out of Phase 1), `number` is
   * classified and never written, `username` is profile metadata.
   */
  optionalColumns: {
    user: ['agent', 'number', 'username'],
    invoice: [],
    product: ['agent'],
  },
  /** Columns read for decisions but kept out of the fingerprint (and of every report). */
  notFingerprinted: ['user.number'],
} as const);

export const LEGACY_SOURCE_TABLES = IMPORT_READ_SET_V1.tables;
export type LegacySourceTableName = (typeof LEGACY_SOURCE_TABLES)[number];

/** Each table's primary key — the canonical row order is its bytes. */
export const LEGACY_PRIMARY_KEYS: Readonly<Record<LegacySourceTableName, string>> =
  IMPORT_READ_SET_V1.primaryKeys;

/** The v1 required columns (`IMPORT_READ_SET_V1.requiredColumns`). */
export const LEGACY_REQUIRED_COLUMNS: Readonly<Record<LegacySourceTableName, readonly string[]>> =
  IMPORT_READ_SET_V1.requiredColumns;

/** The v1 optional columns (`IMPORT_READ_SET_V1.optionalColumns`). */
export const LEGACY_OPTIONAL_COLUMNS: Readonly<Record<LegacySourceTableName, readonly string[]>> =
  IMPORT_READ_SET_V1.optionalColumns;

type DeepReadonly<T> = T extends readonly unknown[] | Record<string, unknown>
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** The invoice statuses the program calls live (Q1, Q6, Q7). Compared exactly. */
export const LEGACY_LIVE_STATUSES = [
  'active',
  'disabled',
  'disabledn',
  'disablebyadmin',
  'end_of_volume',
] as const;

/** The table a SYNTHETIC dataset loads to say so (`tests/fixtures/legacy/synthetic-legacy.ts`). */
export const LEGACY_SYNTHETIC_MARKER_TABLE = 'nexa_synthetic_fixture';

export type LegacySourceEngine = 'MYSQL' | 'MARIADB' | 'SYNTHETIC_FIXTURE';

export interface LegacySchemaColumn {
  readonly table: string;
  readonly column: string;
  /** `information_schema.COLUMNS.DATA_TYPE`, lowercased (`varchar`, `int`, …). */
  readonly dataType: string;
  readonly ordinal: number;
}

/**
 * One table of the legacy database, as `information_schema.TABLES` describes it — metadata
 * only. Read by the inventory (`legacy-inventory.ts`) for EVERY table, classified or not.
 */
export interface LegacyTableInfo {
  readonly name: string;
  /** `BASE TABLE`, `VIEW`, `SYSTEM VIEW`, … as the engine reports it. */
  readonly tableType: string;
  /** `InnoDB`, `MyISAM`, …; null for a view. Only InnoDB is read under the snapshot. */
  readonly storageEngine: string | null;
  /** The table's default character set, from its collation; null when unknown. */
  readonly charset: string | null;
  readonly collation: string | null;
}

/** A column of ANY table, with its own character set (null for a non-text column). */
export interface LegacyCatalogColumn extends LegacySchemaColumn {
  readonly charset: string | null;
}

export interface LegacySourceDescriptor {
  readonly engine: LegacySourceEngine;
  /** The server's version string; for a fixture, the fixture's own label. */
  readonly version: string;
  /**
   * How the session proved it cannot write: the probe statement was refused with this
   * code. `NOT_APPLICABLE` only for a fixture, which has no write path at all.
   */
  readonly readOnlyProof:
    { readonly kind: 'WRITE_REFUSED'; readonly code: string } | { readonly kind: 'NOT_APPLICABLE' };
}

export type LegacyCell = string | null;

export interface LegacySourceSession {
  readonly descriptor: LegacySourceDescriptor;
  /** Every column of the three source tables, as the engine describes them. */
  columns(): Promise<readonly LegacySchemaColumn[]>;
  /**
   * The table's rows, projected onto `columns` (each must exist), every value as text, in
   * the canonical order (primary key bytes ascending).
   */
  rows(
    table: LegacySourceTableName,
    columns: readonly string[],
  ): AsyncIterable<readonly LegacyCell[]>;
  /**
   * Every table of the source database, metadata only (no row is read). Inside the same
   * READ ONLY snapshot as everything else the session reads.
   */
  tables(): Promise<readonly LegacyTableInfo[]>;
  /**
   * Every column of every table of the source database. A separate method from `columns()`
   * on purpose: `columns()` is an input of the v1 fingerprint and stays exactly what it is.
   */
  catalogColumns(): Promise<readonly LegacyCatalogColumn[]>;
  /**
   * The EXACT row count of one table `tables()` lists — `COUNT(*)` inside the snapshot,
   * never `information_schema.TABLES.TABLE_ROWS`, which InnoDB only estimates.
   */
  countRows(table: string): Promise<number>;
  /**
   * The rows of one table of a READ SET (`read-set.ts`), projected onto `columns`, every
   * value as text, in the same canonical order as `rows` (primary key bytes ascending).
   * The adapter refuses a table the catalogue does not let a read set read
   * (`isLegacyTableRowReadable`) and a name that is not a plain identifier; the read set
   * definition is what restricts the columns. Streamed: never the whole table in memory.
   */
  readSetRows(
    table: string,
    primaryKey: string,
    columns: readonly string[],
  ): AsyncIterable<readonly LegacyCell[]>;
  /**
   * One evidence query from the fixed catalogue. Throws `EvidenceUnsupported` on an engine
   * with no SQL (a fixture).
   */
  aggregate(sql: string): Promise<readonly Record<string, LegacyCell>[]>;
  /**
   * The SYNTHETIC marker, if the source carries one: the label stored in
   * `nexa_synthetic_fixture`, which every synthetic dataset loads beside its tables. A real
   * archive has no such table, so null. Read inside the same snapshot as the rows.
   */
  syntheticMarker(): Promise<string | null>;
  /** Rolls the READ ONLY transaction back and releases the connection. */
  close(): Promise<void>;
}

export interface LegacySourceConnector {
  /** A short, credential-free description for reports: engine, host, database. */
  readonly label: string;
  open(): Promise<LegacySourceSession>;
}

export class EvidenceUnsupported extends Error {
  constructor() {
    super('This legacy source has no SQL engine; the evidence queries cannot run against it.');
  }
}

/** Raised when a source cannot be read as the importer needs it. Carries a CODE, never data. */
export class LegacySourceRefused extends Error {
  constructor(
    readonly code:
      | 'SOURCE_NOT_READ_ONLY'
      | 'SOURCE_SCHEMA_MISSING_TABLE'
      | 'SOURCE_SCHEMA_MISSING_COLUMN'
      | 'SOURCE_UNREADABLE'
      /** A read set asked for rows the table catalogue does not let it read. */
      | 'SOURCE_TABLE_NOT_READABLE'
      /** The snapshot is not the source the operator approved (`--expected-fingerprint`). */
      | 'SOURCE_FINGERPRINT_MISMATCH',
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

/** Canonical order: UTF-8 bytes of the key, ascending — `ORDER BY CAST(pk AS BINARY)`. */
export function compareKeyBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** A table or column name a read set or the inventory may put into a statement. */
export const LEGACY_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
