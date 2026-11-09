import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { sql, type SQL } from 'drizzle-orm';
import {
  DATA_EXPORT_ERROR_CODES,
  DATA_EXPORT_README_NAME,
  errors,
  PLATFORM_ERROR_CODES,
} from '@nexa/contracts';
import type { DatabaseHandle } from '../../../../infrastructure/persistence/database.js';
import { withDatabaseScope } from '../../../../infrastructure/persistence/database-scope.js';
import {
  ident,
  pinSession,
  readByCursor,
  readCatalogue,
  rowsOf,
  type SqlExecutor,
} from '../../backup/infrastructure/tenant-archive-copy.js';
import {
  DATA_EXPORT_DATASETS,
  WALLET_BALANCES_DATASET,
  type ExportColumn,
  type ExportDataset,
} from '../application/data-export-inventory.js';
import { buildDataExportReadme } from '../application/data-export-readme.js';
import { csvCell, csvField, csvLine, UTF8_BOM } from './csv.js';
import { ZipFileWriter } from './zip-file-writer.js';

/**
 * Phase 6B PR-3 (ADR-0039, the open data export): writes ONE tenant's export ZIP.
 *
 * ONE SNAPSHOT: every file is read in one `REPEATABLE READ READ ONLY` transaction, so the
 * ZIP is one instant of the tenant (a payment cannot be in `payments.csv` and its wallet
 * entry missing from the ledger). BOUND AND NAMED: the transaction runs under the tenant's
 * scope (as `nexa_app`, row-level security binds every statement to `app.current_tenant_id`)
 * AND every statement names the tenant in its own predicate, so a missed predicate returns
 * nothing rather than another tenant's rows.
 *
 * An ALLOW-LIST: the statements select exactly the columns `DATA_EXPORT_DATASETS` exports,
 * never `SELECT *`, so a column nobody has decided is never written.
 */

export interface DataExportWriterInput {
  readonly database: DatabaseHandle;
  readonly tenantId: string;
  /** The final path; the file is written beside it as `<path>.part` and renamed when whole. */
  readonly path: string;
  readonly generatedAt: Date;
}

export interface DataExportWritten {
  readonly bytes: number;
  readonly sha256: string;
  /** Rows written per file (the README is not counted). */
  readonly rows: Readonly<Record<string, number>>;
}

const TIMESTAMP_TEXT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** The SELECT list expression of one exported column: text, ISO UTC for an instant. */
function expression(column: ExportColumn): SQL {
  const name = ident(column.name);
  return column.kind === 'timestamp'
    ? sql`to_char(${name} AT TIME ZONE 'UTC', ${sql.raw(TIMESTAMP_TEXT)})`
    : sql`${name}::text`;
}

function datasetQuery(dataset: ExportDataset, tenantId: string): SQL {
  return sql`SELECT ${sql.join(
    dataset.columns.map(
      (column, index) => sql`${expression(column)} AS ${sql.raw(`c${String(index)}`)}`,
    ),
    sql`, `,
  )} FROM ${ident(dataset.table)} WHERE tenant_id = ${tenantId}::uuid ORDER BY ${sql.join(
    dataset.orderBy.map((column) => ident(column)),
    sql`, `,
  )}`;
}

/**
 * Each customer's balance per currency, summed from the ledger: the balance is never stored.
 * CREDIT adds, DEBIT subtracts; `bigint` sums, exact.
 */
function balancesQuery(tenantId: string): SQL {
  return sql`SELECT customer_id::text AS c0, currency AS c1,
                    SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END)::text AS c2,
                    count(*)::text AS c3,
                    to_char(max(created_at) AT TIME ZONE 'UTC', ${sql.raw(TIMESTAMP_TEXT)}) AS c4
               FROM wallet_entries WHERE tenant_id = ${tenantId}::uuid
              GROUP BY customer_id, currency ORDER BY customer_id, currency`;
}

async function writeCsv(
  zip: ZipFileWriter,
  executor: SqlExecutor,
  file: string,
  columns: readonly ExportColumn[],
  query: SQL,
): Promise<number> {
  let rows = 0;
  await zip.addEntry(file, async (push) => {
    await push(UTF8_BOM);
    await push(csvLine(columns.map((column) => csvField(column.name))));
    await readByCursor(executor, query, columns.length, async (page) => {
      const lines = page.map((row) =>
        csvLine(row.map((value, index) => csvCell(columns[index]?.kind ?? 'text', value))),
      );
      rows += page.length;
      await push(lines.join(''));
    });
  });
  return rows;
}

export async function writeDataExport(input: DataExportWriterInput): Promise<DataExportWritten> {
  await mkdir(dirname(input.path), { recursive: true, mode: 0o700 });
  const partial = `${input.path}.part`;
  const zip = new ZipFileWriter(partial);
  const scope = { tenantId: input.tenantId as never, botInstanceId: null };
  const rows: Record<string, number> = {};
  try {
    await withDatabaseScope(scope, () =>
      input.database.db.transaction(
        async (tx) => {
          await pinSession(tx);
          const tenant = (
            await rowsOf<{ slug: string; display_name: string }>(
              tx,
              sql`SELECT slug, display_name FROM tenants WHERE id = ${input.tenantId}::uuid`,
            )
          )[0];
          if (tenant === undefined) {
            throw errors.notFound(
              PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
              'The tenant is not visible to the export.',
            );
          }
          // The inventory's columns must exist in the live table: a column the database
          // lacks is a release mismatch, never a silently shorter file.
          const catalogue = await readCatalogue(tx);
          for (const dataset of DATA_EXPORT_DATASETS) {
            const live = new Set(catalogue.get(dataset.table)?.columns.map((c) => c.name) ?? []);
            for (const column of dataset.columns) {
              if (!live.has(column.name)) {
                throw errors.internal(
                  DATA_EXPORT_ERROR_CODES.FAILED,
                  `The export names a column the database does not have: ${dataset.table}.${column.name}`,
                );
              }
            }
          }
          for (const dataset of DATA_EXPORT_DATASETS) {
            rows[dataset.file] = await writeCsv(
              zip,
              tx,
              dataset.file,
              dataset.columns,
              datasetQuery(dataset, input.tenantId),
            );
            // The wallets are the ledger's total, right after the ledger itself.
            if (dataset.table === 'wallet_entries') {
              rows[WALLET_BALANCES_DATASET.file] = await writeCsv(
                zip,
                tx,
                WALLET_BALANCES_DATASET.file,
                WALLET_BALANCES_DATASET.columns,
                balancesQuery(input.tenantId),
              );
            }
          }
          const readme = buildDataExportReadme({
            tenantDisplayName: tenant.display_name,
            tenantSlug: tenant.slug,
            generatedAt: input.generatedAt.toISOString(),
            rows,
          });
          await zip.addEntry(DATA_EXPORT_README_NAME, async (push) => push(readme));
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      ),
    );
    await zip.finish();
  } catch (error) {
    await zip.abort();
    await rm(partial, { force: true });
    throw error;
  }
  const hash = createHash('sha256');
  await pipeline(createReadStream(partial), hash);
  await rename(partial, input.path);
  return { bytes: zip.bytes, sha256: hash.digest('hex'), rows };
}
