import {
  LEGACY_SHA256_PATTERN,
  isLegacyTableRowReadable,
  legacyReadSetFingerprintVersion,
} from '@nexa/contracts';
import {
  LEGACY_IDENTIFIER_PATTERN,
  LegacySourceRefused,
  type LegacyCatalogColumn,
  type LegacyCell,
  type LegacySourceConnector,
  type LegacySourceSession,
} from './source-port.js';
import {
  TableDigest,
  readImportV1Identity,
  sha256Hex,
  type LegacyImportV1Identity,
  type LegacyTableEvidence,
} from './source-snapshot.js';

/**
 * Mirza migration PR1 — versioned READ SETS of the legacy source
 * (`docs/legacy-migration/importer.md` §Read sets).
 *
 * The v1 import read set is frozen (`IMPORT_READ_SET_V1`): widening it would change the
 * fingerprint the owner approved. Anything else NEXA reads from the legacy database is a
 * separate read set, defined here once, with:
 *
 * - its OWN allowlist — tables, each with its primary key and the exact columns read (plus
 *   optional ones read when present). A table must be one the catalogue lets a read set read
 *   (`SUPPORTED` or `ARCHIVE`); a `SECRETS_MANUAL`, `OWNER_DECISION` or `UNCLASSIFIED`
 *   table is refused at definition AND by the adapter;
 * - its OWN fingerprint, `legacy-read-set:<name>:v<version>`:
 *   `sha256(JSON{ v, [synthetic], schema, tables: { <table>: { rows, columns, digest } } })`,
 *   where `schema` is the SHA-256 of the sorted `table.column:data_type` lines of EVERY
 *   column of the read set's tables (read or not — as v1 does), and each digest is v1's
 *   `TableDigest` over the read columns in v1's primary-key byte order;
 * - the SAME snapshot as the approved source: `withBoundReadSetSession` recomputes the v1
 *   import fingerprint inside the read set's own READ ONLY session and refuses
 *   (`SOURCE_FINGERPRINT_MISMATCH`) unless it equals the approved value. Approval stays one
 *   value for the source; each read set prints its own fingerprint for its own approval.
 *
 * Rows are streamed and handed to the caller in bounded batches; the reader keeps none.
 *
 * ## For later read sets
 *
 *     export const PRODUCTS_READ_SET = defineLegacyReadSet({
 *       name: 'products', version: 1,
 *       tables: [{ table: 'product', primaryKey: 'id',
 *                  columns: ['id', 'code_product', …], optionalColumns: ['agent', …] }],
 *     });
 *     await withBoundReadSetSession(connector, approvedV1, async (session, v1) => {
 *       const result = await readLegacyReadSet(session, PRODUCTS_READ_SET, {
 *         batchSize: 500,
 *         onBatch: async (batch) => { … decide / write batch.rows … },
 *       });
 *       // result.fingerprint: compare with --expected-products-fingerprint, record it.
 *     });
 *
 * The name must also join `LEGACY_READ_SET_NAMES` (a contract change) before its run can be
 * recorded in `legacy_read_set_runs`.
 */

export interface LegacyReadSetTableSpec {
  readonly table: string;
  /** Unique and non-null in the source; the rows' canonical order is its bytes. */
  readonly primaryKey: string;
  /** Read always; a source missing one is refused (`SOURCE_SCHEMA_MISSING_COLUMN`). */
  readonly columns: readonly string[];
  /** Read when the source has them; absent ones are left out of the digest's header. */
  readonly optionalColumns?: readonly string[];
}

export interface LegacyReadSetDefinition {
  readonly name: string;
  readonly version: number;
  readonly fingerprintVersion: string;
  readonly tables: readonly LegacyReadSetTableSpec[];
}

/** The largest batch a caller may ask for: what one consumer may hold at once. */
export const READ_SET_MAX_BATCH = 5000;
export const READ_SET_DEFAULT_BATCH = 1000;

/**
 * Validates and deep-freezes a read set definition. Throws on anything that would make the
 * read ambiguous or unsafe: a bad name or version, a table the catalogue does not let a read
 * set read, a non-identifier, a duplicate, or a primary key that is not read.
 */
export function defineLegacyReadSet(input: {
  readonly name: string;
  readonly version: number;
  readonly tables: readonly LegacyReadSetTableSpec[];
}): LegacyReadSetDefinition {
  const fingerprintVersion = legacyReadSetFingerprintVersion(input.name, input.version);
  if (input.tables.length === 0) throw new Error('a read set reads at least one table');
  const seenTables = new Set<string>();
  const tables = input.tables.map((spec) => {
    const optional = spec.optionalColumns ?? [];
    for (const name of [spec.table, spec.primaryKey, ...spec.columns, ...optional]) {
      if (!LEGACY_IDENTIFIER_PATTERN.test(name)) {
        throw new Error(`read set ${input.name}: ${JSON.stringify(name)} is not an identifier`);
      }
    }
    if (seenTables.has(spec.table)) {
      throw new Error(`read set ${input.name}: table ${spec.table} is listed twice`);
    }
    seenTables.add(spec.table);
    if (!isLegacyTableRowReadable(spec.table)) {
      throw new Error(
        `read set ${input.name}: the table catalogue does not let a read set read ${spec.table}`,
      );
    }
    const all = [...spec.columns, ...optional];
    if (new Set(all).size !== all.length) {
      throw new Error(`read set ${input.name}: ${spec.table} lists a column twice`);
    }
    if (!spec.columns.includes(spec.primaryKey)) {
      throw new Error(`read set ${input.name}: ${spec.table} must read its primary key`);
    }
    return Object.freeze({
      table: spec.table,
      primaryKey: spec.primaryKey,
      columns: Object.freeze([...spec.columns]),
      optionalColumns: Object.freeze([...optional]),
    });
  });
  return Object.freeze({
    name: input.name,
    version: input.version,
    fingerprintVersion,
    tables: Object.freeze(tables),
  });
}

export interface LegacyReadSetBatch {
  readonly table: string;
  /** The columns of every row of this batch, in order (required, then present optional). */
  readonly columns: readonly string[];
  readonly rows: readonly (readonly LegacyCell[])[];
}

export interface LegacyReadSetResult {
  readonly name: string;
  readonly version: number;
  readonly fingerprintVersion: string;
  readonly fingerprint: string;
  readonly schemaHash: string;
  readonly synthetic: boolean;
  readonly tables: Readonly<Record<string, LegacyTableEvidence>>;
}

/** The read set's schema hash: sorted `table.column:data_type` of ALL its tables' columns. */
export function readSetSchemaHash(
  definition: LegacyReadSetDefinition,
  columns: readonly LegacyCatalogColumn[],
): string {
  const tables: ReadonlySet<string> = new Set(definition.tables.map((t) => t.table));
  const lines = columns
    .filter((c) => tables.has(c.table))
    .map((c) => `${c.table}.${c.column}:${c.dataType.toLowerCase()}`)
    .sort();
  return sha256Hex(lines.join('\n'));
}

export function readSetFingerprint(
  definition: LegacyReadSetDefinition,
  schemaHash: string,
  tables: Readonly<Record<string, LegacyTableEvidence>>,
  synthetic: boolean,
): string {
  return sha256Hex(
    JSON.stringify({
      v: definition.fingerprintVersion,
      ...(synthetic ? { synthetic: true } : {}),
      schema: schemaHash,
      // In the definition's order, whatever order the evidence object was built in.
      tables: Object.fromEntries(definition.tables.map((t) => [t.table, tables[t.table]])),
    }),
  );
}

const NOTHING_EXCLUDED: ReadonlySet<string> = new Set();

/**
 * Reads one read set inside the session's snapshot: refuses a missing table or required
 * column before any row, then streams each table in primary-key byte order through its
 * digest, handing the rows to `onBatch` at most `batchSize` at a time and awaiting it before
 * reading on. Nothing is kept here; the caller decides what a batch becomes.
 */
export async function readLegacyReadSet(
  session: LegacySourceSession,
  definition: LegacyReadSetDefinition,
  options: {
    readonly batchSize?: number;
    readonly onBatch?: (batch: LegacyReadSetBatch) => Promise<void> | void;
  } = {},
): Promise<LegacyReadSetResult> {
  const batchSize = options.batchSize ?? READ_SET_DEFAULT_BATCH;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > READ_SET_MAX_BATCH) {
    throw new Error(`a read set batch is 1-${String(READ_SET_MAX_BATCH)} rows`);
  }
  const catalog = await session.catalogColumns();
  const synthetic = (await session.syntheticMarker()) !== null;
  const schemaHash = readSetSchemaHash(definition, catalog);

  const plan = definition.tables.map((spec) => {
    const have = new Set(catalog.filter((c) => c.table === spec.table).map((c) => c.column));
    if (have.size === 0) {
      throw new LegacySourceRefused('SOURCE_SCHEMA_MISSING_TABLE', `table ${spec.table} is absent`);
    }
    const missing = spec.columns.filter((c) => !have.has(c));
    if (missing.length > 0) {
      throw new LegacySourceRefused(
        'SOURCE_SCHEMA_MISSING_COLUMN',
        `${spec.table}: ${missing.map((m) => `${spec.table}.${m}`).join(', ')}`,
      );
    }
    const columns = [...spec.columns, ...(spec.optionalColumns ?? []).filter((c) => have.has(c))];
    return { spec, columns };
  });

  const tables: Record<string, LegacyTableEvidence> = {};
  for (const { spec, columns } of plan) {
    const digest = new TableDigest(spec.table, columns, NOTHING_EXCLUDED);
    let batch: (readonly LegacyCell[])[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const rows = batch;
      batch = [];
      await options.onBatch?.({ table: spec.table, columns, rows });
    };
    for await (const row of session.readSetRows(spec.table, spec.primaryKey, columns)) {
      digest.add(row);
      batch.push(row);
      if (batch.length >= batchSize) await flush();
    }
    await flush();
    tables[spec.table] = digest.done();
  }

  return {
    name: definition.name,
    version: definition.version,
    fingerprintVersion: definition.fingerprintVersion,
    fingerprint: readSetFingerprint(definition, schemaHash, tables, synthetic),
    schemaHash,
    synthetic,
    tables,
  };
}

/** Refuses unless the session's v1 fingerprint is the approved one. Carries both values. */
export function assertApprovedSource(identity: LegacyImportV1Identity, expected: string): void {
  if (identity.fingerprint !== expected) {
    throw new LegacySourceRefused(
      'SOURCE_FINGERPRINT_MISMATCH',
      `the source fingerprint is ${identity.fingerprint}, but --expected-fingerprint is ` +
        `${expected}: this is not the source that was approved. Nothing was written.`,
    );
  }
}

/**
 * Opens ONE read-only session, recomputes the v1 import fingerprint in it, refuses unless it
 * equals `expectedFingerprint`, and only then hands the SAME session — the same snapshot —
 * to `work`. A read set run against a source other than the approved one never reads a row
 * of its own tables. The session is closed on every path.
 */
export async function withBoundReadSetSession<T>(
  connector: LegacySourceConnector,
  expectedFingerprint: string,
  work: (session: LegacySourceSession, v1: LegacyImportV1Identity) => Promise<T>,
): Promise<T> {
  if (!LEGACY_SHA256_PATTERN.test(expectedFingerprint)) {
    throw new Error('the approved fingerprint is a SHA-256 as 64 lowercase hex characters');
  }
  const session = await connector.open();
  try {
    const v1 = await readImportV1Identity(session);
    assertApprovedSource(v1, expectedFingerprint);
    return await work(session, v1);
  } finally {
    await session.close();
  }
}
