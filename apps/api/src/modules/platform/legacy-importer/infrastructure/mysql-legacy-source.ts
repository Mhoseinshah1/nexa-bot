import mysqlCallback from 'mysql2';
import type mysql from 'mysql2/promise';
import { assertOutsideTransaction } from '../../../../infrastructure/transaction-boundary.js';
import {
  LEGACY_OPTIONAL_COLUMNS,
  LEGACY_PRIMARY_KEYS,
  LEGACY_REQUIRED_COLUMNS,
  LEGACY_SOURCE_TABLES,
  LEGACY_SYNTHETIC_MARKER_TABLE,
  LegacySourceRefused,
  type LegacyCell,
  type LegacySchemaColumn,
  type LegacySourceConnector,
  type LegacySourceDescriptor,
  type LegacySourceSession,
  type LegacySourceTableName,
} from '../application/source-port.js';

/**
 * Migration P7 — the legacy MirzaBot MySQL/MariaDB source, READ ONLY
 * (`docs/legacy-migration/importer.md` §Source).
 *
 * Three walls, the same three `sql-evidence.md` asks a person to put up by hand:
 *
 * 1. **The account** — the runbook's `oldbot_ro`, `GRANT SELECT` only. Not enforceable from
 *    here; the operator creates it.
 * 2. **The transaction** — `SET SESSION TRANSACTION READ ONLY`, then
 *    `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY`: every statement of the
 *    session reads one snapshot, and a write fails with
 *    `ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION` even if the grant were wrong.
 * 3. **The proof** — before any row is read, the session sends a write that could change
 *    nothing even if it ran (`UPDATE user SET id = id WHERE 1 = 0`) and REQUIRES it to be
 *    refused, by the read-only transaction or by the grant. A session where it is not
 *    refused is closed and the run stops with `SOURCE_NOT_READ_ONLY`. The probe is the
 *    runtime half of "prove a write is refused"; the opt-in MariaDB suite is the test half.
 *
 * And no free-form SQL from a caller: rows are read from the closed table/column vocabulary
 * of the port, and `aggregate` is called with the fixed evidence catalogue only.
 * `multipleStatements` is off, so not even that catalogue could smuggle a second statement.
 *
 * The connection comes only from an explicit DSN the CLI was given (`--source`), never from
 * a default host, a default database or an ambient variable the operator did not name.
 */

export interface MysqlSourceOptions {
  readonly host: string | null;
  readonly port: number | null;
  readonly socketPath: string | null;
  readonly user: string;
  readonly password: string | null;
  readonly database: string;
}

/** Error codes that mean "this write was refused", by the transaction or by the grant. */
const WRITE_REFUSED_CODES: ReadonlySet<string> = new Set([
  'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION',
  'ER_TABLEACCESS_DENIED_ERROR',
  'ER_COLUMNACCESS_DENIED_ERROR',
  'ER_DBACCESS_DENIED_ERROR',
  'ER_SPECIFIC_ACCESS_DENIED_ERROR',
  'ER_OPTION_PREVENTS_STATEMENT',
]);

/**
 * `mysql://user[:password]@host[:port]/database[?socket=/path]`. The password, when the
 * CLI allows one here at all, came from an environment variable the operator named.
 */
export function parseMysqlDsn(dsn: string): MysqlSourceOptions {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new LegacySourceRefused('SOURCE_UNREADABLE', 'the source DSN is not a URL');
  }
  if (url.protocol !== 'mysql:' && url.protocol !== 'mariadb:') {
    throw new LegacySourceRefused('SOURCE_UNREADABLE', 'the source DSN must be mysql://…');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ''));
  if (database === '' || database.includes('/')) {
    throw new LegacySourceRefused('SOURCE_UNREADABLE', 'the source DSN must name one database');
  }
  if (url.username === '') {
    throw new LegacySourceRefused('SOURCE_UNREADABLE', 'the source DSN must name a user');
  }
  const socket = url.searchParams.get('socket');
  for (const key of url.searchParams.keys()) {
    if (key !== 'socket') {
      throw new LegacySourceRefused('SOURCE_UNREADABLE', `unsupported DSN parameter ${key}`);
    }
  }
  return {
    host: url.hostname === '' ? null : url.hostname,
    port: url.port === '' ? null : Number(url.port),
    socketPath: socket,
    user: decodeURIComponent(url.username),
    password: url.password === '' ? null : decodeURIComponent(url.password),
    database,
  };
}

/** A credential-free label: engine, where, which database. Never the user or password. */
export function mysqlSourceLabel(options: MysqlSourceOptions): string {
  const where =
    options.socketPath !== null
      ? 'socket'
      : `${options.host ?? 'localhost'}:${String(options.port ?? 3306)}`;
  return `mysql ${where}/${options.database}`;
}

function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(name)) {
    throw new Error('not an identifier the legacy vocabulary contains');
  }
  return `\`${name}\``;
}

function cellOf(value: unknown): LegacyCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  return String(value as string);
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : null;
}

export class MysqlLegacySourceConnector implements LegacySourceConnector {
  readonly label: string;

  constructor(private readonly options: MysqlSourceOptions) {
    this.label = mysqlSourceLabel(options);
  }

  async open(): Promise<LegacySourceSession> {
    assertOutsideTransaction('The legacy MySQL source');
    let raw: mysqlCallback.Connection;
    let connection: mysql.Connection;
    try {
      raw = mysqlCallback.createConnection({
        ...(this.options.socketPath !== null
          ? { socketPath: this.options.socketPath }
          : { host: this.options.host ?? 'localhost', port: this.options.port ?? 3306 }),
        user: this.options.user,
        ...(this.options.password === null ? {} : { password: this.options.password }),
        database: this.options.database,
        charset: 'utf8mb4',
        multipleStatements: false,
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
        connectTimeout: 15_000,
      });
      // A fatal connection error is delivered as an EVENT; an unlistened one throws out of
      // the event loop. The pending query rejects with the same error, which is where it
      // is handled, so the listener only keeps the process alive to report it.
      raw.on('error', () => undefined);
      connection = raw.promise();
      await connection.connect();
    } catch (error) {
      throw new LegacySourceRefused(
        'SOURCE_UNREADABLE',
        `could not connect to the legacy source (${errorCode(error) ?? 'connection failed'})`,
      );
    }
    try {
      const descriptor = await this.enterReadOnlySnapshot(connection);
      return new MysqlLegacySourceSession(connection, raw, descriptor);
    } catch (error) {
      await connection.end().catch(() => undefined);
      throw error;
    }
  }

  private async enterReadOnlySnapshot(
    connection: mysql.Connection,
  ): Promise<LegacySourceDescriptor> {
    const [versionRows] = await connection.query<mysql.RowDataPacket[]>('SELECT VERSION() AS v');
    const version = cellOf(versionRows[0]?.['v']) ?? 'unknown';
    await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('SET SESSION TRANSACTION READ ONLY');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');

    // The proof. A statement that would change no row even if it ran, which MUST be refused.
    let refusedWith: string | null = null;
    try {
      await connection.query('UPDATE `user` SET `id` = `id` WHERE 1 = 0');
    } catch (error) {
      const code = errorCode(error);
      if (code !== null && WRITE_REFUSED_CODES.has(code)) refusedWith = code;
      else if (code === 'ER_NO_SUCH_TABLE') {
        throw new LegacySourceRefused('SOURCE_SCHEMA_MISSING_TABLE', 'table user is absent');
      } else {
        throw new LegacySourceRefused(
          'SOURCE_UNREADABLE',
          `the read-only probe failed unexpectedly (${code ?? 'unknown'})`,
        );
      }
    }
    if (refusedWith === null) {
      await connection.query('ROLLBACK').catch(() => undefined);
      throw new LegacySourceRefused(
        'SOURCE_NOT_READ_ONLY',
        'a write probe was ACCEPTED by the legacy source session; refusing to read from it',
      );
    }
    return {
      engine: /mariadb/iu.test(version) ? 'MARIADB' : 'MYSQL',
      version,
      readOnlyProof: { kind: 'WRITE_REFUSED', code: refusedWith },
    };
  }
}

class MysqlLegacySourceSession implements LegacySourceSession {
  private closed = false;

  constructor(
    private readonly connection: mysql.Connection,
    /** The same connection's callback face: the only one that streams rows. */
    private readonly raw: mysqlCallback.Connection,
    readonly descriptor: LegacySourceDescriptor,
  ) {}

  async columns(): Promise<readonly LegacySchemaColumn[]> {
    const [rows] = await this.connection.query<mysql.RowDataPacket[]>(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS d, ORDINAL_POSITION AS o
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?, ?)`,
      [...LEGACY_SOURCE_TABLES],
    );
    return rows.map((row) => ({
      table: cellOf(row['t']) ?? '',
      column: cellOf(row['c']) ?? '',
      dataType: (cellOf(row['d']) ?? '').toLowerCase(),
      ordinal: Number(cellOf(row['o']) ?? 0),
    }));
  }

  async *rows(
    table: LegacySourceTableName,
    columns: readonly string[],
  ): AsyncIterable<readonly LegacyCell[]> {
    if (!(LEGACY_SOURCE_TABLES as readonly string[]).includes(table)) {
      throw new Error('not a legacy source table');
    }
    const vocabulary = new Set([
      ...LEGACY_REQUIRED_COLUMNS[table],
      ...LEGACY_OPTIONAL_COLUMNS[table],
    ]);
    for (const column of columns) {
      if (!vocabulary.has(column)) throw new Error('not a column the importer reads');
    }
    const select = columns.map((c) => `CAST(${quoteIdentifier(c)} AS CHAR)`).join(', ');
    const sql =
      `SELECT ${select} FROM ${quoteIdentifier(table)} ` +
      `ORDER BY CAST(${quoteIdentifier(LEGACY_PRIMARY_KEYS[table])} AS BINARY)`;
    // Streamed: one ordered pass, never the whole table in one result buffer.
    const stream = this.raw.query({ sql, rowsAsArray: true }).stream();
    for await (const row of stream as AsyncIterable<unknown[]>) {
      yield row.map(cellOf);
    }
  }

  async syntheticMarker(): Promise<string | null> {
    const [tables] = await this.connection.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [LEGACY_SYNTHETIC_MARKER_TABLE],
    );
    if (Number(cellOf(tables[0]?.['n']) ?? 0) === 0) return null;
    // The table's presence is the marker; its label is what the report prints. An empty
    // or unlabelled marker table still marks the source synthetic: it is never real data.
    const [rows] = await this.connection.query<mysql.RowDataPacket[]>(
      `SELECT CAST(\`label\` AS CHAR) AS label FROM ${quoteIdentifier(LEGACY_SYNTHETIC_MARKER_TABLE)} LIMIT 1`,
    );
    return cellOf(rows[0]?.['label']) ?? 'SYNTHETIC (unlabelled marker)';
  }

  async aggregate(sql: string): Promise<readonly Record<string, LegacyCell>[]> {
    const [rows] = await this.connection.query<mysql.RowDataPacket[]>(sql);
    return rows.map((row) => {
      const out: Record<string, LegacyCell> = {};
      for (const [key, value] of Object.entries(row)) out[key] = cellOf(value);
      return out;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.connection.query('ROLLBACK');
    } finally {
      await this.connection.end();
    }
  }
}
