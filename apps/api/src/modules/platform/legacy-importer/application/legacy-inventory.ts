import {
  classifyLegacyTable,
  legacyReadSetFingerprintVersion,
  type LegacyReadSetName,
  type LegacyTableClass,
} from '@nexa/contracts';
import { assertApprovedSource } from './read-set.js';
import {
  LEGACY_IDENTIFIER_PATTERN,
  compareKeyBytes,
  type LegacySourceConnector,
  type LegacySourceDescriptor,
  type LegacySourceSession,
} from './source-port.js';
import { readImportV1Identity, sha256Hex, type LegacyImportV1Identity } from './source-snapshot.js';

/**
 * Mirza migration PR1 — the inventory of EVERY table of the legacy database
 * (`docs/legacy-migration/table-inventory.md`, CLI `legacy-import inventory`).
 *
 * Read-only and value-free: for each table, its name, its class from the reviewed catalogue
 * (`LEGACY_TABLE_CLASSIFICATION`), its column count, a hash of its `name:data_type` lines,
 * its EXACT row count (`COUNT(*)` inside the snapshot, never `TABLE_ROWS`), its storage
 * engine, charset and collation, and its text columns' charsets. Never a row value.
 *
 * The inventory is a read set of its own, `legacy-read-set:inventory:v1`, whose fingerprint
 * covers what the SOURCE says (shape, counts, charsets) — never NEXA's classes, which are a
 * NEXA decision and change by commit, not by source. It runs in one READ ONLY session that
 * also recomputes the v1 import fingerprint, and with `--expected-fingerprint` refuses a
 * source other than the approved one before any table is counted.
 *
 * The verdict fails closed: an UNCLASSIFIED table, a view, or a name no statement can carry
 * keeps it from COMPLETE, and an inventory not bound to an approved v1 fingerprint is
 * reported, never recorded.
 */

export const INVENTORY_READ_SET_NAME: LegacyReadSetName = 'inventory';
export const INVENTORY_READ_SET_VERSION = 1;
export const INVENTORY_FINGERPRINT_VERSION = legacyReadSetFingerprintVersion(
  INVENTORY_READ_SET_NAME,
  INVENTORY_READ_SET_VERSION,
);

/** The only storage engine whose rows the consistent snapshot covers. */
const SNAPSHOT_ENGINE = 'innodb';
/** The charset the importer's connection reads as; anything else may arrive as mojibake. */
const EXPECTED_CHARSET = 'utf8mb4';

export type LegacyInventoryTableFinding =
  /** A view (or anything but a base table): not counted, not a source of rows. */
  | 'NOT_A_BASE_TABLE'
  /** The name is not a plain identifier, so no statement here may name it. */
  | 'TABLE_NAME_UNSUPPORTED'
  /** No reviewed class: nothing may read its rows. */
  | 'UNCLASSIFIED'
  /** Not InnoDB: its rows are not under the session's consistent snapshot. */
  | 'NOT_SNAPSHOT_CONSISTENT'
  /** The table or a text column is not utf8mb4: decide before any read set keeps text. */
  | 'NOT_UTF8MB4';

const BLOCKING: ReadonlySet<LegacyInventoryTableFinding> = new Set([
  'NOT_A_BASE_TABLE',
  'TABLE_NAME_UNSUPPORTED',
]);

export interface LegacyInventoryTable {
  readonly name: string;
  readonly class: LegacyTableClass;
  readonly tableType: string;
  readonly storageEngine: string | null;
  readonly charset: string | null;
  readonly collation: string | null;
  /** Distinct charsets of the table's text columns, sorted; empty when it has none. */
  readonly columnCharsets: readonly string[];
  readonly columns: number;
  /** SHA-256 of the sorted `name:data_type` lines of the table's columns. */
  readonly columnsHash: string;
  /** Exact `COUNT(*)`; null when the table could not be counted (see findings). */
  readonly rows: number | null;
  readonly findings: readonly LegacyInventoryTableFinding[];
}

export type LegacyInventoryVerdict =
  /** Every table classified and counted, the session bound to the approved v1 source. */
  | 'COMPLETE'
  /** A table could not be inventoried (a view, an unsupported name). */
  | 'BLOCKED'
  /** At least one table has no reviewed class. */
  | 'UNCLASSIFIED_TABLES'
  /** No `--expected-fingerprint`: printed for review, not bound, never recorded. */
  | 'FINGERPRINT_UNBOUND';

export interface LegacyInventory {
  readonly fingerprintVersion: string;
  readonly fingerprint: string;
  readonly synthetic: boolean;
  readonly engine: LegacySourceDescriptor['engine'];
  readonly importV1: {
    readonly fingerprint: string;
    readonly schemaHash: string;
    readonly expected: string | null;
    readonly bound: boolean;
  };
  readonly tables: readonly LegacyInventoryTable[];
  /** Catalogue entries the source does not have (the marker, on real data). */
  readonly classifiedAbsent: readonly string[];
  readonly totals: {
    readonly tables: number;
    readonly rows: number;
    readonly byClass: Readonly<Record<LegacyTableClass, number>>;
  };
  /**
   * The freeze proof's statement: `CHECKSUM TABLE` over EVERY base table the source has —
   * a superset of every read set's tables, so nothing a read set reads can change between
   * the freeze and the switch unnoticed. Null when a table name cannot be put in it.
   */
  readonly freezeChecksum: string | null;
  readonly verdict: LegacyInventoryVerdict;
}

const TEXT_DATA_TYPES: ReadonlySet<string> = new Set([
  'char',
  'varchar',
  'tinytext',
  'text',
  'mediumtext',
  'longtext',
  'enum',
  'set',
]);

/** The inventory of the session's source, without the v1 binding. Reads no row value. */
export async function readLegacyInventoryTables(
  session: LegacySourceSession,
): Promise<{ readonly tables: readonly LegacyInventoryTable[]; readonly synthetic: boolean }> {
  const listed = [...(await session.tables())].sort((a, b) => compareKeyBytes(a.name, b.name));
  const columns = await session.catalogColumns();
  const synthetic = (await session.syntheticMarker()) !== null;
  const tables: LegacyInventoryTable[] = [];
  for (const info of listed) {
    const own = columns.filter((c) => c.table === info.name);
    const findings: LegacyInventoryTableFinding[] = [];
    const nameOk = LEGACY_IDENTIFIER_PATTERN.test(info.name);
    const baseTable = info.tableType === 'BASE TABLE';
    if (!baseTable) findings.push('NOT_A_BASE_TABLE');
    if (!nameOk) findings.push('TABLE_NAME_UNSUPPORTED');
    const classification = classifyLegacyTable(info.name);
    if (classification.class === 'UNCLASSIFIED') findings.push('UNCLASSIFIED');
    if (baseTable && (info.storageEngine ?? '').toLowerCase() !== SNAPSHOT_ENGINE) {
      findings.push('NOT_SNAPSHOT_CONSISTENT');
    }
    const columnCharsets = [
      ...new Set(
        own
          .filter((c) => TEXT_DATA_TYPES.has(c.dataType.toLowerCase()) || c.charset !== null)
          .map((c) => c.charset ?? 'UNKNOWN'),
      ),
    ].sort();
    if (
      (info.charset !== null && info.charset !== EXPECTED_CHARSET) ||
      columnCharsets.some((c) => c !== EXPECTED_CHARSET)
    ) {
      findings.push('NOT_UTF8MB4');
    }
    const rows = baseTable && nameOk ? await session.countRows(info.name) : null;
    tables.push({
      name: info.name,
      class: classification.class,
      tableType: info.tableType,
      storageEngine: info.storageEngine,
      charset: info.charset,
      collation: info.collation,
      columnCharsets,
      columns: own.length,
      columnsHash: sha256Hex(
        own
          .map((c) => `${c.column}:${c.dataType.toLowerCase()}`)
          .sort()
          .join('\n'),
      ),
      rows,
      findings,
    });
  }
  return { tables, synthetic };
}

/**
 * The inventory's own fingerprint: what the SOURCE says about every table, in name byte
 * order. Classes and findings are NEXA's reading of it and are left out.
 */
export function inventoryFingerprint(
  tables: readonly LegacyInventoryTable[],
  synthetic: boolean,
): string {
  return sha256Hex(
    JSON.stringify({
      v: INVENTORY_FINGERPRINT_VERSION,
      ...(synthetic ? { synthetic: true } : {}),
      tables: tables.map((t) => ({
        name: t.name,
        type: t.tableType,
        engine: t.storageEngine,
        charset: t.charset,
        collation: t.collation,
        columnCharsets: t.columnCharsets,
        columns: t.columns,
        columnsHash: t.columnsHash,
        rows: t.rows,
      })),
    }),
  );
}

/** `CHECKSUM TABLE` over every base table, in name byte order; null if one cannot be named. */
export function freezeChecksumStatement(tables: readonly LegacyInventoryTable[]): string | null {
  const base = tables.filter((t) => t.tableType === 'BASE TABLE');
  if (base.length === 0 || base.some((t) => !LEGACY_IDENTIFIER_PATTERN.test(t.name))) return null;
  return `CHECKSUM TABLE ${base.map((t) => `\`${t.name}\``).join(', ')};`;
}

export function decideInventoryVerdict(
  tables: readonly LegacyInventoryTable[],
  bound: boolean,
): LegacyInventoryVerdict {
  if (tables.some((t) => t.findings.some((f) => BLOCKING.has(f)))) return 'BLOCKED';
  if (tables.some((t) => t.class === 'UNCLASSIFIED')) return 'UNCLASSIFIED_TABLES';
  if (!bound) return 'FINGERPRINT_UNBOUND';
  return 'COMPLETE';
}

export function assembleInventory(input: {
  readonly v1: LegacyImportV1Identity;
  readonly expected: string | null;
  readonly tables: readonly LegacyInventoryTable[];
  readonly synthetic: boolean;
  readonly catalogue: readonly string[];
}): LegacyInventory {
  const bound = input.expected !== null && input.expected === input.v1.fingerprint;
  const byClass = {
    SUPPORTED: 0,
    ARCHIVE: 0,
    SECRETS_MANUAL: 0,
    OWNER_DECISION: 0,
    UNCLASSIFIED: 0,
  } satisfies Record<LegacyTableClass, number>;
  for (const t of input.tables) byClass[t.class] += 1;
  const present = new Set(input.tables.map((t) => t.name));
  return {
    fingerprintVersion: INVENTORY_FINGERPRINT_VERSION,
    fingerprint: inventoryFingerprint(input.tables, input.synthetic),
    synthetic: input.synthetic,
    engine: input.v1.engine,
    importV1: {
      fingerprint: input.v1.fingerprint,
      schemaHash: input.v1.schemaHash,
      expected: input.expected,
      bound,
    },
    tables: input.tables,
    classifiedAbsent: input.catalogue.filter((name) => !present.has(name)).sort(compareKeyBytes),
    totals: {
      tables: input.tables.length,
      rows: input.tables.reduce((sum, t) => sum + (t.rows ?? 0), 0),
      byClass,
    },
    freezeChecksum: freezeChecksumStatement(input.tables),
    verdict: decideInventoryVerdict(input.tables, bound),
  };
}

/**
 * Takes the inventory in ONE read-only session: the v1 import identity first (refused at
 * once, before any table is counted, when `expected` is given and differs), then every
 * table. The session is closed on every path.
 */
export async function takeLegacyInventory(
  connector: LegacySourceConnector,
  expected: string | null,
  catalogue: readonly string[],
): Promise<LegacyInventory> {
  const session = await connector.open();
  try {
    const v1 = await readImportV1Identity(session);
    if (expected !== null) assertApprovedSource(v1, expected);
    const { tables, synthetic } = await readLegacyInventoryTables(session);
    return assembleInventory({ v1, expected, tables, synthetic, catalogue });
  } finally {
    await session.close();
  }
}

/** Every table a frozen or versioned read set reads must be in the freeze checksum. */
export function freezeCovers(inventory: LegacyInventory, readTables: readonly string[]): boolean {
  const statement = inventory.freezeChecksum;
  if (statement === null) return false;
  return readTables.every((t) => statement.includes(`\`${t}\``));
}

// --- rendering --------------------------------------------------------------------------

/** Inert text: the table names are the source's, so nothing in them may become markup. */
function inert(text: string): string {
  return text.replace(/[^A-Za-z0-9_.:;,() *-]/gu, '?');
}

export function inventoryJson(inventory: LegacyInventory): string {
  return `${JSON.stringify({ format: 'nexa-legacy-inventory/v1', ...inventory }, null, 2)}\n`;
}

export function inventoryMarkdown(inventory: LegacyInventory): string {
  const v1 = inventory.importV1;
  const lines = [
    '# Legacy table inventory',
    '',
    `- read set: ${inventory.fingerprintVersion}${inventory.synthetic ? ' (SYNTHETIC source)' : ''}`,
    `- inventory fingerprint: ${inventory.fingerprint}`,
    `- source engine: ${inventory.engine}`,
    `- v1 import fingerprint: ${v1.fingerprint}`,
    `- v1 schema hash: ${v1.schemaHash}`,
    `- v1 check: ${
      v1.expected === null
        ? 'NOT BOUND (no --expected-fingerprint; nothing is recorded)'
        : v1.bound
          ? 'MATCH (--expected-fingerprint)'
          : 'MISMATCH'
    }`,
    `- verdict: **${inventory.verdict}**`,
    `- tables: ${String(inventory.totals.tables)}, rows: ${String(inventory.totals.rows)}`,
    `- by class: ${Object.entries(inventory.totals.byClass)
      .map(([k, v]) => `${k} ${String(v)}`)
      .join(', ')}`,
    '',
    '| table | class | type | engine | charset | collation | column charsets | columns | columns hash | rows | findings |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...inventory.tables.map(
      (t) =>
        `| ${inert(t.name)} | ${t.class} | ${inert(t.tableType)} | ${inert(t.storageEngine ?? '-')} | ` +
        `${inert(t.charset ?? '-')} | ${inert(t.collation ?? '-')} | ${inert(t.columnCharsets.join(',') || '-')} | ` +
        `${String(t.columns)} | ${t.columnsHash.slice(0, 16)} | ${t.rows === null ? '-' : String(t.rows)} | ` +
        `${t.findings.join(', ') || '-'} |`,
    ),
    '',
    `Classified but absent from this source: ${inventory.classifiedAbsent.map(inert).join(', ') || 'none'}`,
    '',
    'Freeze proof (run as the SELECT-only account at the freeze and on the restored copy;',
    'scripts/legacy-freeze-checksum.sql generates the same statement on the legacy host):',
    '',
    '```sql',
    inventory.freezeChecksum === null
      ? '-- cannot be generated: a table name is not a plain identifier'
      : // Built only from names that passed LEGACY_IDENTIFIER_PATTERN; nothing to neutralise.
        inventory.freezeChecksum,
    '```',
    '',
  ];
  return `${lines.join('\n')}\n`;
}
