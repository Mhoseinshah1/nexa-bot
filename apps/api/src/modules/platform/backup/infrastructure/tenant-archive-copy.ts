import { createHash, randomBytes, type Hash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { NexaError, PLATFORM_ERROR_CODES, TENANT_ARCHIVE_ERROR_CODES } from '@nexa/contracts';
import {
  tenantArchiveClassOf,
  tenantRowPredicate,
} from '../application/tenant-archive-inventory.js';

/**
 * Phase 6B (ADR-0039 § 2): the row format of a tenant archive, and the catalogue it is read by.
 *
 * ONE ROW, ONE LINE, in PostgreSQL's text COPY format: each column's text output (`col::text`,
 * so exactly what the type's output function prints) escaped as `COPY … TO` escapes it, joined
 * by tabs, NULL as `\N`. The session is pinned (UTC, ISO dates, `extra_float_digits = 3`, hex
 * bytea) so the bytes are a function of the data alone, which is what makes the per-table
 * SHA-256 a verification and not a coincidence: the export, the scratch re-read and the
 * restored copy all print the same line for the same row.
 *
 * Why not `COPY` on the wire: the driver has no COPY stream (no dependency is added for it),
 * and `COPY FROM` is refused on a table with row-level security for a role that does not
 * bypass it (ADR-0039 § 4). The FILES are COPY text format all the same — `psql \copy` loads
 * them — and they are loaded here by batched, typed INSERTs.
 */

/** A drizzle executor: the pool, a transaction, or one checkout. */
export interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

export async function rowsOf<T>(executor: SqlExecutor, query: SQL): Promise<T[]> {
  const result = (await executor.execute(query)) as { rows: T[] };
  return result.rows;
}

/** The session settings every read of an archive's rows runs under (transaction-local). */
export async function pinSession(executor: SqlExecutor): Promise<void> {
  await executor.execute(sql`
    SELECT set_config('TimeZone', 'UTC', true),
           set_config('DateStyle', 'ISO, YMD', true),
           set_config('IntervalStyle', 'postgres', true),
           set_config('extra_float_digits', '3', true),
           set_config('bytea_output', 'hex', true)`);
}

const ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\v': '\\v',
};
const UNESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
};

/** One value as COPY text prints it. */
export function encodeCopyField(value: string | null): string {
  if (value === null) return '\\N';
  return value.replace(/[\\\b\f\n\r\t\v]/g, (char) => ESCAPES[char] ?? char);
}

/** One line (without its newline) back into values. Refuses an escape COPY never writes. */
export function decodeCopyLine(line: string): (string | null)[] {
  return line.split('\t').map((field) => {
    if (field === '\\N') return null;
    return field.replace(/\\(.)/g, (_match, char: string) => {
      const out = UNESCAPES[char];
      if (out === undefined) {
        throw new NexaError({
          kind: 'INTERNAL',
          code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_MALFORMED,
          message: 'A tenant archive part holds an escape its format never writes.',
        });
      }
      return out;
    });
  });
}

export function encodeCopyLine(values: readonly (string | null)[]): string {
  return `${values.map(encodeCopyField).join('\t')}\n`;
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export interface ColumnShape {
  readonly name: string;
  /** `format_type`: the cast a typed INSERT uses. */
  readonly type: string;
  /** `GENERATED ALWAYS AS IDENTITY`: the INSERT says `OVERRIDING SYSTEM VALUE`. */
  readonly identityAlways: boolean;
  readonly identity: boolean;
}

export interface SelfReference {
  /** The referencing columns, and the referenced ones, in constraint order. */
  readonly from: readonly string[];
  readonly to: readonly string[];
}

export interface TableShape {
  readonly name: string;
  /** Every stored column (never a generated one), in `attnum` order. */
  readonly columns: readonly ColumnShape[];
  /** The ORDER BY: the primary key, or every column when there is none. */
  readonly orderBy: readonly string[];
  readonly selfReferences: readonly SelfReference[];
}

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

export function ident(name: string): SQL {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new NexaError({
      kind: 'INTERNAL',
      code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_MALFORMED,
      message: 'A table or column name is not a plain identifier.',
    });
  }
  return sql.raw(`"${name}"`);
}

/** A type for a cast: only what `format_type` prints for this schema's columns. */
function castType(type: string): SQL {
  if (!/^[a-z_][a-z0-9_ ]*(\([0-9, ]+\))?(\[\])*$/.test(type)) {
    throw new NexaError({
      kind: 'INTERNAL',
      code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_MALFORMED,
      message: 'A column type is not one this release can name.',
    });
  }
  return sql.raw(type);
}

/** Every base table of `public` with its stored columns, key and self-references. */
export async function readCatalogue(executor: SqlExecutor): Promise<Map<string, TableShape>> {
  const columns = await rowsOf<{
    table_name: string;
    column_name: string;
    type: string;
    identity: string;
  }>(
    executor,
    sql`SELECT c.relname AS table_name, a.attname AS column_name,
               format_type(a.atttypid, a.atttypmod) AS type, a.attidentity AS identity
          FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
           AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
         ORDER BY c.relname, a.attnum`,
  );
  const keys = await rowsOf<{ table_name: string; columns: string[] }>(
    executor,
    sql`SELECT c.relname AS table_name,
               array_agg(a.attname ORDER BY k.ordinality)::text[] AS columns
          FROM pg_index x
          JOIN pg_class c ON c.oid = x.indrelid
          CROSS JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ordinality)
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
         WHERE x.indisprimary AND c.relnamespace = 'public'::regnamespace
         GROUP BY c.relname`,
  );
  const selfRefs = await rowsOf<{ table_name: string; from_cols: string[]; to_cols: string[] }>(
    executor,
    sql`SELECT c.relname AS table_name,
               ARRAY(SELECT a.attname FROM unnest(k.conkey) WITH ORDINALITY u(n, o)
                       JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n
                      ORDER BY u.o)::text[] AS from_cols,
               ARRAY(SELECT a.attname FROM unnest(k.confkey) WITH ORDINALITY u(n, o)
                       JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.n
                      ORDER BY u.o)::text[] AS to_cols
          FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
         WHERE k.contype = 'f' AND k.conrelid = k.confrelid
           AND c.relnamespace = 'public'::regnamespace`,
  );
  const keyOf = new Map(keys.map((row) => [row.table_name, row.columns]));
  const tables = new Map<string, ColumnShape[]>();
  for (const row of columns) {
    const list = tables.get(row.table_name) ?? [];
    list.push({
      name: row.column_name,
      type: row.type,
      identity: row.identity !== '',
      identityAlways: row.identity === 'a',
    });
    tables.set(row.table_name, list);
  }
  const out = new Map<string, TableShape>();
  for (const [name, cols] of tables) {
    out.set(name, {
      name,
      columns: cols,
      orderBy: keyOf.get(name) ?? cols.map((column) => column.name),
      selfReferences: selfRefs
        .filter((row) => row.table_name === name)
        .map((row) => ({ from: row.from_cols, to: row.to_cols })),
    });
  }
  return out;
}

/**
 * The TENANT tables present, parents first (Kahn's order over the foreign keys among them,
 * ties by name, self-references ignored — their rows are ordered by `orderSelfReferenced`).
 * Refuses a table the inventory does not classify (`tenant_archive.unclassified_table`).
 */
export async function tenantLoadOrder(
  executor: SqlExecutor,
  catalogue: ReadonlyMap<string, TableShape>,
): Promise<string[]> {
  const unclassified = [...catalogue.keys()].filter(
    (table) => tenantArchiveClassOf(table) === null,
  );
  if (unclassified.length > 0) {
    throw new NexaError({
      kind: 'PRECONDITION_FAILED',
      code: TENANT_ARCHIVE_ERROR_CODES.UNCLASSIFIED_TABLE,
      message: 'The database holds a table this release does not classify for tenant archives.',
      details: { tables: unclassified.sort() },
    });
  }
  const tenant = [...catalogue.keys()].filter((t) => tenantArchiveClassOf(t) === 'TENANT').sort();
  const edges = await rowsOf<{ child: string; parent: string }>(
    executor,
    sql`SELECT DISTINCT c.relname AS child, p.relname AS parent
          FROM pg_constraint k
          JOIN pg_class c ON c.oid = k.conrelid
          JOIN pg_class p ON p.oid = k.confrelid
         WHERE k.contype = 'f' AND k.conrelid <> k.confrelid
           AND c.relnamespace = 'public'::regnamespace`,
  );
  const inSet = new Set(tenant);
  const parents = new Map<string, Set<string>>(tenant.map((t) => [t, new Set<string>()]));
  for (const edge of edges) {
    if (inSet.has(edge.child) && inSet.has(edge.parent)) parents.get(edge.child)?.add(edge.parent);
  }
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < tenant.length) {
    const ready = tenant.find(
      (t) => !done.has(t) && [...(parents.get(t) ?? [])].every((p) => done.has(p)),
    );
    if (ready === undefined) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: TENANT_ARCHIVE_ERROR_CODES.UNCLASSIFIED_TABLE,
        message: 'The foreign keys among tenant tables form a cycle; no load order exists.',
      });
    }
    order.push(ready);
    done.add(ready);
  }
  return order;
}

/** `SELECT col::text AS c0, … FROM t WHERE <tenant rows> ORDER BY <key>` for `columns`. */
export function selectTenantRows(
  shape: TableShape,
  columns: readonly string[],
  tenantId: string,
): SQL {
  const predicate = tenantRowPredicate(shape.name).split('$1');
  const where = sql.join(
    predicate.map((part) => sql.raw(part)),
    sql`${tenantId}::uuid`,
  );
  return sql`SELECT ${sql.join(
    columns.map((column, index) => sql`${ident(column)}::text AS ${sql.raw(`c${String(index)}`)}`),
    sql`, `,
  )} FROM ${ident(shape.name)} WHERE ${where} ORDER BY ${sql.join(
    shape.orderBy.map((column) => ident(column)),
    sql`, `,
  )}`;
}

/**
 * Reads `query` through a cursor in pages, inside the caller's transaction, handing each page's
 * rows (as arrays, in column order) to `onRows`. Never the whole table in memory.
 */
export async function readByCursor(
  executor: SqlExecutor,
  query: SQL,
  width: number,
  onRows: (rows: (string | null)[][]) => Promise<void>,
  pageSize = 500,
): Promise<void> {
  const cursor = sql.raw(`nexa_tarc_${randomBytes(6).toString('hex')}`);
  await executor.execute(sql`DECLARE ${cursor} NO SCROLL CURSOR FOR ${query}`);
  try {
    for (;;) {
      const page = await rowsOf<Record<string, string | null>>(
        executor,
        sql`FETCH ${sql.raw(String(pageSize))} FROM ${cursor}`,
      );
      if (page.length === 0) break;
      await onRows(
        page.map((row) =>
          Array.from({ length: width }, (_unused, index) => row[`c${String(index)}`] ?? null),
        ),
      );
      if (page.length < pageSize) break;
    }
  } finally {
    await executor.execute(sql`CLOSE ${cursor}`);
  }
}

/** A running SHA-256 and byte count over a table's lines. */
export class LineDigest {
  private readonly hash: Hash = createHash('sha256');
  bytes = 0;
  rows = 0;
  add(line: string): void {
    const buffer = Buffer.from(line, 'utf8');
    this.hash.update(buffer);
    this.bytes += buffer.length;
    this.rows += 1;
  }
  hex(): string {
    return this.hash.digest('hex');
  }
}

/** Parameters per INSERT statement, well under PostgreSQL's 65535. */
const MAX_PARAMETERS = 20_000;
/** Bytes of values per INSERT statement: a page of blobs stays a bounded statement. */
const MAX_STATEMENT_BYTES = 8 * 1024 * 1024;

/**
 * Inserts `rows` (values in `columns` order) into `shape.name` with typed casts, in batches.
 * `OVERRIDING SYSTEM VALUE` when the table has an always-identity column: the archive's values
 * are kept.
 */
export async function insertRows(
  executor: SqlExecutor,
  shape: TableShape,
  columns: readonly string[],
  rows: readonly (readonly (string | null)[])[],
): Promise<void> {
  if (rows.length === 0) return;
  const types = columns.map((column) => {
    const found = shape.columns.find((c) => c.name === column);
    if (found === undefined) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_MALFORMED,
        message: 'A tenant archive part names a column its table does not have.',
        details: { table: shape.name, column },
      });
    }
    return castType(found.type);
  });
  const overriding = shape.columns.some(
    (column) => column.identityAlways && columns.includes(column.name),
  );
  let batch: (readonly (string | null)[])[] = [];
  let bytes = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const values = sql.join(
      batch.map(
        (row) =>
          sql`(${sql.join(
            row.map((value, index) => sql`${value}::${types[index] ?? sql.raw('text')}`),
            sql`, `,
          )})`,
      ),
      sql`, `,
    );
    await executor.execute(
      sql`INSERT INTO ${ident(shape.name)} (${sql.join(
        columns.map((column) => ident(column)),
        sql`, `,
      )}) ${overriding ? sql`OVERRIDING SYSTEM VALUE ` : sql``}VALUES ${values}`,
    );
    batch = [];
    bytes = 0;
  };
  for (const row of rows) {
    if (row.length !== columns.length) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_MALFORMED,
        message: 'A tenant archive row does not have its table’s column count.',
        details: { table: shape.name },
      });
    }
    const size = row.reduce((sum, value) => sum + (value?.length ?? 0), 0);
    if (
      batch.length > 0 &&
      ((batch.length + 1) * columns.length > MAX_PARAMETERS || bytes + size > MAX_STATEMENT_BYTES)
    ) {
      await flush();
    }
    batch.push(row);
    bytes += size;
  }
  await flush();
}

/**
 * Orders a self-referencing table's rows so every referenced row comes first: a row waits
 * until each of its references is NULL, outside the set, or already placed. A cycle among the
 * rows (which the constraint itself makes impossible to have inserted) is refused.
 */
export function orderSelfReferenced(
  shape: TableShape,
  columns: readonly string[],
  rows: readonly (readonly (string | null)[])[],
): (readonly (string | null)[])[] {
  if (shape.selfReferences.length === 0) return [...rows];
  const at = (name: string) => columns.indexOf(name);
  const keyOf = (row: readonly (string | null)[], names: readonly string[]): string | null => {
    const parts = names.map((name) => row[at(name)] ?? null);
    return parts.some((part) => part === null) ? null : parts.join('\u0000');
  };
  const present = new Set<string>();
  for (const reference of shape.selfReferences) {
    for (const row of rows) {
      const key = keyOf(row, reference.to);
      if (key !== null) present.add(`${reference.to.join(',')}|${key}`);
    }
  }
  const placed = new Set<string>();
  const out: (readonly (string | null)[])[] = [];
  let pending = [...rows];
  while (pending.length > 0) {
    const next: (readonly (string | null)[])[] = [];
    for (const row of pending) {
      const ready = shape.selfReferences.every((reference) => {
        const key = keyOf(row, reference.from);
        const label = `${reference.to.join(',')}|${key ?? ''}`;
        return key === null || !present.has(label) || placed.has(label);
      });
      if (!ready) {
        next.push(row);
        continue;
      }
      out.push(row);
      for (const reference of shape.selfReferences) {
        const key = keyOf(row, reference.to);
        if (key !== null) placed.add(`${reference.to.join(',')}|${key}`);
      }
    }
    if (next.length === pending.length) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_MALFORMED,
        message: 'A self-referencing table in a tenant archive holds a reference cycle.',
        details: { table: shape.name },
      });
    }
    pending = next;
  }
  return out;
}
