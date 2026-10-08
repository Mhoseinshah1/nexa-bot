import { createHash } from 'node:crypto';
import {
  IMPORT_READ_SET_V1,
  LEGACY_LIVE_STATUSES,
  LEGACY_OPTIONAL_COLUMNS,
  LEGACY_REQUIRED_COLUMNS,
  LEGACY_SOURCE_TABLES,
  LegacySourceRefused,
  type LegacyCell,
  type LegacySchemaColumn,
  type LegacySourceConnector,
  type LegacySourceDescriptor,
  type LegacySourceSession,
  type LegacySourceTableName,
} from './source-port.js';
import { classifyLegacyPhone, type LegacyPhoneClass } from './decisions.js';

/**
 * Migration P7 — one read of the legacy source, and its fingerprint
 * (`docs/legacy-migration/importer.md` §Fingerprint).
 *
 * Everything the importer decides comes from ONE snapshot: one READ ONLY session, every
 * table streamed once in canonical order, the fingerprint computed over the same bytes the
 * decisions are made from. A second session would be a second snapshot, and a resume
 * compares fingerprints precisely so that two snapshots are never interleaved.
 *
 * ## The fingerprint (v1)
 *
 * `sha256(JSON{ v, schema, tables: { <table>: { rows, columns, digest } } })` where
 *
 * - `schema` is the SHA-256 of the sorted `table.column:data_type` lines of the three
 *   source tables (a column added, dropped or retyped changes it);
 * - each table's `digest` is the SHA-256 of its fingerprint columns' header line followed
 *   by one JSON line per row, in primary-key byte order;
 * - the fingerprint columns are the columns the importer READS, minus `user.number`, which
 *   decides nothing and is never written.
 *
 * Safe to print and store: a digest over a whole table reveals no row, and the output is
 * counts and hashes only — no id, no username, no phone, no balance.
 */

export const LEGACY_FINGERPRINT_VERSION = IMPORT_READ_SET_V1.fingerprintVersion;

/** Columns read for decisions but kept out of the fingerprint (and of every report). */
const NOT_FINGERPRINTED: ReadonlySet<string> = new Set(IMPORT_READ_SET_V1.notFingerprinted);

export interface LegacyUserRow {
  readonly id: string;
  readonly balance: LegacyCell;
  readonly limitUsertest: LegacyCell;
  readonly agent: LegacyCell;
  readonly username: LegacyCell;
  /** The legacy phone, CLASSIFIED and then dropped: the value itself is never kept. */
  readonly phone: LegacyPhoneClass;
  /** SHA-256 of the facts the import decides from: the `legacy_import_map.checksum`. */
  readonly checksum: string;
}

export interface LegacyInvoiceRow {
  readonly idInvoice: string;
  readonly idUser: LegacyCell;
  readonly username: LegacyCell;
  readonly status: LegacyCell;
  readonly isTest: LegacyCell;
  readonly codePanel: LegacyCell;
  readonly codeProduct: LegacyCell;
  readonly volume: LegacyCell;
  readonly serviceTime: LegacyCell;
  readonly timeUnit: LegacyCell;
  readonly isCustom: LegacyCell;
  readonly checksum: string;
}

export interface LegacyTableEvidence {
  readonly rows: number;
  readonly columns: readonly string[];
  readonly digest: string;
}

export interface LegacySnapshot {
  readonly label: string;
  readonly descriptor: LegacySourceDescriptor;
  readonly fingerprint: string;
  readonly schemaHash: string;
  readonly tables: Readonly<Record<LegacySourceTableName, LegacyTableEvidence>>;
  readonly users: readonly LegacyUserRow[];
  /** Users with a test invoice in ANY status — Q2's `had_trial`. */
  readonly trialUsers: ReadonlySet<string>;
  /** Invoices whose `Status` is one of `LEGACY_LIVE_STATUSES`: the service candidates. */
  readonly liveInvoices: readonly LegacyInvoiceRow[];
  readonly productCodes: ReadonlySet<string>;
  /**
   * The source carries the SYNTHETIC marker (`nexa_synthetic_fixture`). Forces the report's
   * evidence class to `synthetic` and is refused against a production-like target.
   */
  readonly synthetic: boolean;
  readonly syntheticLabel: string | null;
  /** `user.Balance`'s DATA_TYPE (Q4's reading note asks for it): schema evidence. */
  readonly balanceColumnType: string | null;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The schema hash: sorted `table.column:data_type` over the three source tables. */
export function legacySchemaHash(columns: readonly LegacySchemaColumn[]): string {
  const tables: ReadonlySet<string> = new Set(LEGACY_SOURCE_TABLES);
  const lines = columns
    .filter((c) => tables.has(c.table))
    .map((c) => `${c.table}.${c.column}:${c.dataType.toLowerCase()}`)
    .sort();
  return sha256Hex(lines.join('\n'));
}

/** A row's checksum: SHA-256 of its decision facts, as canonical JSON. */
export function legacyRowChecksum(kind: string, facts: readonly LegacyCell[]): string {
  return sha256Hex(`${kind}:${JSON.stringify(facts)}`);
}

/** Which of a table's wanted columns the source has; a missing REQUIRED one is refused. */
export function presentColumns(
  columns: readonly LegacySchemaColumn[],
  table: LegacySourceTableName,
): readonly string[] {
  const have = new Set(columns.filter((c) => c.table === table).map((c) => c.column));
  if (have.size === 0) {
    throw new LegacySourceRefused('SOURCE_SCHEMA_MISSING_TABLE', `table ${table} is absent`);
  }
  const missing = LEGACY_REQUIRED_COLUMNS[table].filter((c) => !have.has(c));
  if (missing.length > 0) {
    throw new LegacySourceRefused(
      'SOURCE_SCHEMA_MISSING_COLUMN',
      `${table}: ${missing.map((m) => `${table}.${m}`).join(', ')}`,
    );
  }
  return [
    ...LEGACY_REQUIRED_COLUMNS[table],
    ...LEGACY_OPTIONAL_COLUMNS[table].filter((c) => have.has(c)),
  ];
}

/**
 * A table's digest: SHA-256 of the fingerprinted columns' JSON header line, then one JSON
 * line per row, in the order the rows arrive (the session's canonical order). Shared by
 * the v1 import read set and every versioned read set (`read-set.ts`), so "the same rows,
 * the same digest" is one implementation. `excluded` names `table.column`s read but kept
 * out; v1's is `IMPORT_READ_SET_V1.notFingerprinted`, a read set's is empty (its allowlist
 * IS what it fingerprints).
 */
export class TableDigest {
  private readonly hash = createHash('sha256');
  private count = 0;
  private readonly keep: readonly number[];
  readonly fingerprintColumns: readonly string[];

  constructor(
    table: string,
    columns: readonly string[],
    excluded: ReadonlySet<string> = NOT_FINGERPRINTED,
  ) {
    this.keep = columns
      .map((c, i) => (excluded.has(`${table}.${c}`) ? -1 : i))
      .filter((i) => i >= 0);
    this.fingerprintColumns = this.keep.map((i) => columns[i] as string);
    this.hash.update(`${JSON.stringify(this.fingerprintColumns)}\n`);
  }

  add(row: readonly LegacyCell[]): void {
    this.count += 1;
    this.hash.update(`${JSON.stringify(this.keep.map((i) => row[i] ?? null))}\n`);
  }

  done(): LegacyTableEvidence {
    return {
      rows: this.count,
      columns: this.fingerprintColumns,
      digest: this.hash.digest('hex'),
    };
  }
}

/** Streams one v1 table through its digest, handing each row to `onRow` as it passes. */
async function digestV1Table(
  session: LegacySourceSession,
  table: LegacySourceTableName,
  columns: readonly string[],
  onRow: (row: readonly LegacyCell[]) => void = () => undefined,
): Promise<LegacyTableEvidence> {
  const digest = new TableDigest(table, columns);
  for await (const row of session.rows(table, columns)) {
    digest.add(row);
    onRow(row);
  }
  return digest.done();
}

export function legacyFingerprint(
  schemaHash: string,
  tables: Readonly<Record<LegacySourceTableName, LegacyTableEvidence>>,
  synthetic = false,
): string {
  return sha256Hex(
    JSON.stringify({
      v: LEGACY_FINGERPRINT_VERSION,
      // Only when set, so a real archive's fingerprint is unchanged by the marker's
      // existence; a synthetic copy of the same rows never fingerprints as the real thing.
      ...(synthetic ? { synthetic: true } : {}),
      schema: schemaHash,
      tables: {
        user: tables.user,
        invoice: tables.invoice,
        product: tables.product,
      },
    }),
  );
}

const LIVE: ReadonlySet<string> = new Set(LEGACY_LIVE_STATUSES);

function cellOf(columns: readonly string[], row: readonly LegacyCell[], name: string): LegacyCell {
  const index = columns.indexOf(name);
  return index === -1 ? null : (row[index] ?? null);
}

/**
 * Reads the whole source once, inside the session's snapshot, and closes the session.
 * The session is closed on every path, including a refusal half-way through.
 */
export async function readLegacySnapshot(
  connector: LegacySourceConnector,
): Promise<LegacySnapshot> {
  const session = await connector.open();
  try {
    return await readFromSession(connector.label, session);
  } finally {
    await session.close();
  }
}

export async function readFromSession(
  label: string,
  session: LegacySourceSession,
): Promise<LegacySnapshot> {
  const schema = await session.columns();
  const syntheticLabel = await session.syntheticMarker();
  const schemaHash = legacySchemaHash(schema);
  const userColumns = presentColumns(schema, 'user');
  const invoiceColumns = presentColumns(schema, 'invoice');
  const productColumns = presentColumns(schema, 'product');

  const users: LegacyUserRow[] = [];
  const userEvidence = await digestV1Table(session, 'user', userColumns, (row) => {
    const id = cellOf(userColumns, row, 'id');
    if (id === null) return; // a NULL primary key cannot exist; counted in the digest anyway
    const balance = cellOf(userColumns, row, 'Balance');
    const limitUsertest = cellOf(userColumns, row, 'limit_usertest');
    const agent = cellOf(userColumns, row, 'agent');
    const username = cellOf(userColumns, row, 'username');
    users.push({
      id,
      balance,
      limitUsertest,
      agent,
      username,
      phone: classifyLegacyPhone(cellOf(userColumns, row, 'number')),
      checksum: '',
    });
  });

  const trialUsers = new Set<string>();
  const liveInvoices: LegacyInvoiceRow[] = [];
  const invoiceEvidence = await digestV1Table(session, 'invoice', invoiceColumns, (row) => {
    const cell = (name: string) => cellOf(invoiceColumns, row, name);
    const idUser = cell('id_user');
    const isTest = cell('is_test');
    if (idUser !== null && isTest !== null && isTest.trim() === '1') trialUsers.add(idUser);
    const status = cell('Status');
    if (status === null || !LIVE.has(status)) return;
    const facts = [
      cell('id_invoice'),
      idUser,
      cell('username'),
      status,
      isTest,
      cell('code_panel'),
      cell('code_product'),
      cell('Volume'),
      cell('Service_time'),
      cell('time_unit'),
      cell('is_custom'),
    ];
    liveInvoices.push({
      idInvoice: cell('id_invoice') ?? '',
      idUser,
      username: cell('username'),
      status,
      isTest,
      codePanel: cell('code_panel'),
      codeProduct: cell('code_product'),
      volume: cell('Volume'),
      serviceTime: cell('Service_time'),
      timeUnit: cell('time_unit'),
      isCustom: cell('is_custom'),
      checksum: legacyRowChecksum('invoice:v1', facts),
    });
  });

  const productCodes = new Set<string>();
  const productEvidence = await digestV1Table(session, 'product', productColumns, (row) => {
    const code = cellOf(productColumns, row, 'code_product');
    if (code !== null && code.trim() !== '') productCodes.add(code.trim());
  });

  // The user checksum needs had_trial, which is known only after the invoice scan.
  const withChecksums = users.map((u) => ({
    ...u,
    checksum: legacyRowChecksum('user:v1', [
      u.id,
      u.balance,
      u.limitUsertest,
      trialUsers.has(u.id) ? '1' : '0',
      u.username,
    ]),
  }));

  const tables = { user: userEvidence, invoice: invoiceEvidence, product: productEvidence };
  return {
    label,
    descriptor: session.descriptor,
    fingerprint: legacyFingerprint(schemaHash, tables, syntheticLabel !== null),
    synthetic: syntheticLabel !== null,
    syntheticLabel,
    schemaHash,
    tables,
    users: withChecksums,
    trialUsers,
    liveInvoices,
    productCodes,
    balanceColumnType:
      schema.find((c) => c.table === 'user' && c.column === 'Balance')?.dataType ?? null,
  };
}

/**
 * The v1 IDENTITY of the source the session reads — its fingerprint, schema hash and
 * per-table evidence — and nothing else. The same walk as `readFromSession` (same columns,
 * same digests, same order, same synthetic flag), keeping no row: the three tables stream
 * through their digests and are dropped. What a read set session recomputes, in its own
 * snapshot, to prove it reads the source the owner approved (`read-set.ts`).
 */
export interface LegacyImportV1Identity {
  readonly fingerprint: string;
  readonly schemaHash: string;
  readonly tables: Readonly<Record<LegacySourceTableName, LegacyTableEvidence>>;
  readonly synthetic: boolean;
  readonly engine: LegacySourceDescriptor['engine'];
}

export async function readImportV1Identity(
  session: LegacySourceSession,
): Promise<LegacyImportV1Identity> {
  const schema = await session.columns();
  const syntheticLabel = await session.syntheticMarker();
  const schemaHash = legacySchemaHash(schema);
  const userColumns = presentColumns(schema, 'user');
  const invoiceColumns = presentColumns(schema, 'invoice');
  const productColumns = presentColumns(schema, 'product');
  const tables = {
    user: await digestV1Table(session, 'user', userColumns),
    invoice: await digestV1Table(session, 'invoice', invoiceColumns),
    product: await digestV1Table(session, 'product', productColumns),
  };
  return {
    fingerprint: legacyFingerprint(schemaHash, tables, syntheticLabel !== null),
    schemaHash,
    tables,
    synthetic: syntheticLabel !== null,
    engine: session.descriptor.engine,
  };
}
