import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../../apps/api/src/infrastructure/nxpkg/canonical-json';
import {
  LEGACY_PRIMARY_KEYS,
  compareKeyBytes,
  type LegacySourceTableName,
} from '../../apps/api/src/modules/platform/legacy-importer/application/source-port';
import type { LegacyFixtureDataset } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import type { FileSource } from './nxpkg/writer';

/**
 * TEST-ONLY — the converter's 1.4.0 SOURCE SNAPSHOT of a synthetic legacy dataset
 * (`source/catalog.json` + `source/tables/{user,invoice,product}.jsonl`), built the way
 * `mirza2nexa/source_snapshot.py` builds it: every table in the catalogue, sorted by UTF-8
 * name; the allowlisted columns present, in the allowlist's order; rows sorted by primary-key
 * bytes. It exists so a test can put the SAME rows in front of the fixture adapter and the
 * `.nxpkg` adapter and compare what the importer computes from each. NOT EVIDENCE.
 */

/** `source_snapshot.ALLOWLIST` (mirza-to-nexa 0.6.0), verbatim. */
export const CONVERTER_SNAPSHOT_ALLOWLIST: Readonly<
  Record<LegacySourceTableName, readonly string[]>
> = {
  user: ['id', 'Balance', 'limit_usertest', 'agent', 'number', 'username', 'User_Status'],
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
    'Service_location',
    'time_sell',
    'name_product',
    'note',
    'refral',
    'time_cron',
    'notifctions',
  ],
  product: [
    'id',
    'code_product',
    'name_product',
    'price_product',
    'Volume_constraint',
    'Service_time',
    'Location',
    'Category',
    'category',
    'agent',
    'note',
    'data_limit_reset',
    'one_buy_status',
    'hide_panel',
  ],
};

const TEXT_TYPES = new Set([
  'char',
  'varchar',
  'tinytext',
  'text',
  'mediumtext',
  'longtext',
  'enum',
  'set',
]);

export interface SnapshotParts {
  readonly catalog: Record<string, unknown>;
  readonly tables: Readonly<Record<LegacySourceTableName, Record<string, unknown>[]>>;
}

/** The catalogue and the three rows files (header line first) for `dataset`. */
export function snapshotOfDataset(
  dataset: LegacyFixtureDataset,
  options: { readonly syntheticMarker?: string | null } = {},
): SnapshotParts {
  const names = [...new Set(dataset.schema.map((c) => c.table))].sort((a, b) =>
    compareKeyBytes(a, b),
  );
  const tables = names.map((name) => ({
    name,
    table_type: 'BASE TABLE',
    storage_engine: dataset.storageEngine ?? null,
    charset: dataset.tableCharset ?? null,
    collation: dataset.tableCollation ?? null,
    rows: (dataset.tables[name] ?? []).length,
    columns: dataset.schema
      .filter((c) => c.table === name)
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((c) => ({
        column: c.column,
        data_type: c.dataType,
        ordinal: c.ordinal,
        charset: TEXT_TYPES.has(c.dataType) ? (dataset.tableCharset ?? null) : null,
      })),
  }));
  const files = {} as Record<LegacySourceTableName, Record<string, unknown>[]>;
  const snapshotTables: Record<string, unknown> = {};
  for (const table of ['user', 'invoice', 'product'] as const) {
    const present = new Set(dataset.schema.filter((c) => c.table === table).map((c) => c.column));
    const columns = CONVERTER_SNAPSHOT_ALLOWLIST[table].filter((c) => present.has(c));
    const pk = LEGACY_PRIMARY_KEYS[table];
    const rows = [...(dataset.tables[table] ?? [])].sort((a, b) =>
      compareKeyBytes(a[pk] ?? '', b[pk] ?? ''),
    );
    files[table] = [
      { columns, format: 'm2n.source-table.v1', primary_key: pk, table },
      ...rows.map((row) => ({ c: columns.map((c) => row[c] ?? null) })),
    ];
    snapshotTables[table] = {
      file: `source/tables/${table}.jsonl`,
      primary_key: pk,
      columns,
      rows: rows.length,
    };
  }
  const hasMarker = names.includes('nexa_synthetic_fixture');
  return {
    catalog: {
      format: 'm2n.source-catalog.v1',
      snapshot_version: 1,
      synthetic_marker:
        options.syntheticMarker !== undefined
          ? options.syntheticMarker
          : hasMarker
            ? dataset.label
            : null,
      engine_hint: 'MARIADB',
      tables,
      snapshot_tables: snapshotTables,
    },
    tables: files,
  };
}

/** The writer's `files` for a package carrying `parts` (plus any other files given). */
export function snapshotPackageFiles(
  parts: SnapshotParts,
  extra: Record<string, FileSource> = {},
): Record<string, FileSource> {
  return {
    'source/catalog.json': { json: parts.catalog },
    'source/tables/user.jsonl': { records: parts.tables.user },
    'source/tables/invoice.jsonl': { records: parts.tables.invoice },
    'source/tables/product.jsonl': { records: parts.tables.product },
    ...extra,
  };
}

/** The extracted-directory form: `manifest.json`, the catalogue and the rows files. */
export async function writeSnapshotDirectory(
  dir: string,
  parts: SnapshotParts,
  manifest: Record<string, unknown>,
): Promise<void> {
  await mkdir(join(dir, 'source', 'tables'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), canonicalJson(manifest));
  await writeFile(join(dir, 'source', 'catalog.json'), canonicalJson(parts.catalog));
  for (const table of ['user', 'invoice', 'product'] as const) {
    const lines = parts.tables[table].map((r) => `${canonicalJson(r).toString('utf8')}\n`);
    await writeFile(join(dir, 'source', 'tables', `${table}.jsonl`), lines.join(''));
  }
}

/** The manifest fields a 1.4.0 package that passes `checkNxpkgForImport` carries. */
export const READY_MANIFEST: Readonly<Record<string, unknown>> = {
  package_schema_version: '1.4.0',
  readiness: 'ready',
  blockers: [],
  money: { declared_unit: 'toman', currency: 'IRT', rescaled: false },
  converter: { name: 'mirza2nexa', version: '0.6.0' },
};
