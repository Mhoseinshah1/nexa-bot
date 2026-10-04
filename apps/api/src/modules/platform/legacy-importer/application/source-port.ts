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

export const LEGACY_SOURCE_TABLES = ['user', 'invoice', 'product'] as const;
export type LegacySourceTableName = (typeof LEGACY_SOURCE_TABLES)[number];

/** Each table's primary key — the canonical row order is its bytes. */
export const LEGACY_PRIMARY_KEYS: Readonly<Record<LegacySourceTableName, string>> = {
  user: 'id',
  invoice: 'id_invoice',
  product: 'id',
};

/**
 * Columns the importer cannot decide without. A source missing one is refused before any
 * row is read (`SOURCE_SCHEMA_MISSING_COLUMN`), never read around.
 *
 * Evidence: the program's queries (`docs/legacy-migration/sql-evidence.md` Q1–Q7) name
 * every one of these; `id_invoice` and `product.id` are the primary keys of the public
 * MirzaBot source (`mahdiMGF2/botmirzapanel` @ 92c0ed06, `table.php`).
 */
export const LEGACY_REQUIRED_COLUMNS: Readonly<Record<LegacySourceTableName, readonly string[]>> = {
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
};

/**
 * Columns read when present and null when absent. None of them decides money, identity,
 * a panel or a trial: `agent` is reported (resellers are out of Phase 1), `number` is
 * classified and never written, `username` is profile metadata.
 */
export const LEGACY_OPTIONAL_COLUMNS: Readonly<Record<LegacySourceTableName, readonly string[]>> = {
  user: ['agent', 'number', 'username'],
  invoice: [],
  product: ['agent'],
};

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
      | 'SOURCE_UNREADABLE',
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

/** Canonical order: UTF-8 bytes of the key, ascending — `ORDER BY CAST(pk AS BINARY)`. */
export function compareKeyBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
