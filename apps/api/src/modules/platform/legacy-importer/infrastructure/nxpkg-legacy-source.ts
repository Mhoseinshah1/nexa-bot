import { createReadStream, lstatSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isLegacyTableRowReadable } from '@nexa/contracts';
import { parseStrictJson } from '../../../../infrastructure/nxpkg/canonical-json.js';
import type { NxpkgSecret } from '../../../../infrastructure/nxpkg/crypto.js';
import { isSafeRelpath } from '../../../../infrastructure/nxpkg/manifest.js';
import {
  openNxpkg,
  type NxpkgOpenOptions,
  type NxpkgPackage,
} from '../../../../infrastructure/nxpkg/reader.js';
import {
  NXPKG_CATALOG_PATH,
  assertNxpkgTableHeader,
  nxpkgRowCells,
  parseNxpkgSourceCatalog,
  type NxpkgSnapshotTable,
  type NxpkgSourceCatalog,
} from '../application/nxpkg-source-catalog.js';
import {
  EvidenceUnsupported,
  LEGACY_IDENTIFIER_PATTERN,
  LEGACY_OPTIONAL_COLUMNS,
  LEGACY_REQUIRED_COLUMNS,
  LEGACY_SOURCE_TABLES,
  LegacySourceRefused,
  compareKeyBytes,
  type LegacyCatalogColumn,
  type LegacyCell,
  type LegacySchemaColumn,
  type LegacySourceConnector,
  type LegacySourceDescriptor,
  type LegacySourceSession,
  type LegacySourceTableName,
  type LegacyTableInfo,
} from '../application/source-port.js';

/**
 * Mirza `.nxpkg` importer — the legacy source, read from a converter package instead of a
 * live MySQL (`docs/legacy-migration/nxpkg-importer.md` §3).
 *
 * The package carries a raw snapshot of the three tables the importer reads
 * (`application/nxpkg-source-catalog.ts`), so the EXISTING importer runs over it unchanged
 * and recomputes its own fingerprints and decisions: the v1 import read set, `user-status`,
 * `products` and `invoice-archive` all read through this session exactly as they would read
 * MySQL.
 *
 * What it promises, like `fixture-legacy-source.ts` and `mysql-legacy-source.ts`:
 *
 * - rows in the canonical order (primary-key UTF-8 bytes ascending). The converter wrote them
 *   that way; this adapter does not re-sort, it CHECKS while streaming — a key out of order,
 *   repeated or NULL fails the read closed, as does a row count that disagrees with the
 *   catalogue. Nothing is held in memory but the previous key;
 * - only the snapshot's tables and columns: a table the snapshot does not carry, a column its
 *   rows file does not list, a table the table catalogue does not let a read set read
 *   (`isLegacyTableRowReadable`) and a non-identifier are refused — never answered with NULLs.
 *   A column the CATALOGUE lists but the rows file does not carry is refused too: the importer
 *   asks only for columns `columns()` reports (`presentColumns`), and a column it is told
 *   exists must be read, not invented;
 * - `aggregate` throws `EvidenceUnsupported` (a package has no SQL engine);
 * - `syntheticMarker()` is the catalogue's `synthetic_marker`: the label of NEXA's marker
 *   table when the dumped database had one, null for a real backup. The snapshot's synthetic
 *   flag, the evidence class and the production guard all follow it.
 *
 * The package is authenticated before this adapter exists (`openNxpkg` verifies every chunk
 * and every checksum), and `iterJsonl` re-checks each file's SHA-256 at its end.
 */

/** What the adapter needs of a package: three reads. `NxpkgPackage` is one. */
export interface NxpkgSnapshotFiles {
  has(rel: string): boolean;
  readJson(rel: string): Promise<unknown>;
  iterJsonl(rel: string): AsyncIterable<Record<string, unknown>>;
}

export interface NxpkgSourceIdentity {
  /** `manifest.converter.version`. */
  readonly converterVersion: string;
  /** `manifest.package_schema_version`. */
  readonly contractVersion: string;
  /** `manifest.import_id`: a converter digest, safe to print; null for a bare directory. */
  readonly importId: string | null;
}

export const NXPKG_ENGINE = 'NXPKG' as const;

/** The limits a package is opened with unless the caller gives its own. */
export const NXPKG_DEFAULT_OPEN_LIMITS: Omit<NxpkgOpenOptions, 'workDir' | 'signal'> = {
  maxPayloadBytes: 8 * 1024 * 1024 * 1024,
  maxFiles: 20_000,
  maxFileBytes: 4 * 1024 * 1024 * 1024,
};

function identityOf(manifest: unknown): NxpkgSourceIdentity {
  const m = manifest as Record<string, unknown> | null;
  const converter = m?.['converter'] as Record<string, unknown> | undefined;
  const version = converter?.['version'];
  const contract = m?.['package_schema_version'];
  const importId = m?.['import_id'];
  if (typeof version !== 'string' || typeof contract !== 'string') {
    throw new LegacySourceRefused(
      'SOURCE_UNREADABLE',
      'the package manifest does not name its converter and contract versions',
    );
  }
  return {
    converterVersion: version,
    contractVersion: contract,
    importId: typeof importId === 'string' && /^[0-9a-f]{8,64}$/u.test(importId) ? importId : null,
  };
}

export class NxpkgLegacySourceConnector implements LegacySourceConnector {
  readonly label: string;
  readonly descriptor: LegacySourceDescriptor;
  private closed = false;

  private constructor(
    private readonly files: NxpkgSnapshotFiles,
    readonly catalog: NxpkgSourceCatalog,
    readonly identity: NxpkgSourceIdentity,
    private readonly release: () => Promise<void>,
    /** The opened package this connector owns (`nxpkgSourceConnector`), else null. */
    readonly pkg: NxpkgPackage | null,
  ) {
    this.label = identity.importId === null ? 'nxpkg package' : `nxpkg import ${identity.importId}`;
    this.descriptor = {
      engine: NXPKG_ENGINE,
      version: `mirza2nexa ${identity.converterVersion} / contract ${identity.contractVersion}`,
      readOnlyProof: { kind: 'NOT_APPLICABLE' },
    };
  }

  /**
   * Over snapshot files already authenticated (an opened package, or a test's directory).
   * Reads and checks `source/catalog.json` now; a package without it is refused.
   */
  static async fromFiles(
    files: NxpkgSnapshotFiles,
    identity: NxpkgSourceIdentity,
    owned: { readonly release: () => Promise<void>; readonly pkg: NxpkgPackage } | null = null,
  ): Promise<NxpkgLegacySourceConnector> {
    if (!files.has(NXPKG_CATALOG_PATH)) {
      throw new LegacySourceRefused(
        'SOURCE_SCHEMA_MISSING_TABLE',
        'the package carries no source snapshot (source/catalog.json, contract >= 1.4.0)',
      );
    }
    const catalog = parseNxpkgSourceCatalog(await files.readJson(NXPKG_CATALOG_PATH));
    for (const spec of catalog.snapshotTables.values()) {
      if (!files.has(spec.file)) {
        throw new LegacySourceRefused(
          'SOURCE_SCHEMA_MISSING_TABLE',
          `the package lists ${spec.table} in its snapshot but carries no rows file for it`,
        );
      }
    }
    return new NxpkgLegacySourceConnector(
      files,
      catalog,
      identity,
      owned?.release ?? (() => Promise.resolve()),
      owned?.pkg ?? null,
    );
  }

  /** Over an opened package. `close()` here does NOT close the package: its owner does. */
  static fromPackage(pkg: NxpkgPackage): Promise<NxpkgLegacySourceConnector> {
    return NxpkgLegacySourceConnector.fromFiles(pkg, identityOf(pkg.manifest));
  }

  /** Over an extracted package directory (its `manifest.json` and `source/`). */
  static async fromDirectory(dir: string): Promise<NxpkgLegacySourceConnector> {
    const files = directorySnapshotFiles(dir);
    return NxpkgLegacySourceConnector.fromFiles(
      files,
      identityOf(await files.readJson('manifest.json')),
    );
  }

  /** The catalogue's synthetic marker: a label for a synthetic source, null for a real one. */
  get syntheticMarker(): string | null {
    return this.catalog.syntheticMarker;
  }

  /** Releases what the connector owns (the decrypted package, for `nxpkgSourceConnector`). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.release();
  }

  open(): Promise<LegacySourceSession> {
    if (this.closed) return Promise.reject(new Error('the nxpkg source is closed'));
    const { catalog, files, descriptor } = this;
    let closed = false;
    const live = () => {
      if (closed || this.closed) throw new Error('the nxpkg session is closed');
    };
    const projection = (spec: NxpkgSnapshotTable, columns: readonly string[]): number[] =>
      columns.map((c) => {
        const index = spec.columns.indexOf(c);
        if (index === -1) {
          throw new LegacySourceRefused(
            'SOURCE_SCHEMA_MISSING_COLUMN',
            `${spec.table}.${c} is not in the package's rows file`,
          );
        }
        return index;
      });
    const session: LegacySourceSession = {
      descriptor,
      columns: () => {
        live();
        const out: LegacySchemaColumn[] = [];
        for (const table of catalog.tables) {
          if (!(LEGACY_SOURCE_TABLES as readonly string[]).includes(table.name)) continue;
          for (const c of table.columns) {
            out.push({
              table: table.name,
              column: c.column,
              dataType: c.dataType,
              ordinal: c.ordinal,
            });
          }
        }
        return Promise.resolve(out);
      },
      rows: (table: LegacySourceTableName, columns: readonly string[]) => {
        live();
        if (!(LEGACY_SOURCE_TABLES as readonly string[]).includes(table)) {
          throw new Error('not a legacy source table');
        }
        // The v1 vocabulary, as the MySQL adapter holds it: nothing else is ever asked for.
        const vocabulary = new Set([
          ...LEGACY_REQUIRED_COLUMNS[table],
          ...LEGACY_OPTIONAL_COLUMNS[table],
        ]);
        if (!columns.every((c) => vocabulary.has(c))) {
          throw new Error('a column outside the v1 import read set was requested');
        }
        const spec = catalog.snapshotTables.get(table);
        if (spec === undefined) {
          throw new LegacySourceRefused(
            'SOURCE_SCHEMA_MISSING_TABLE',
            `the package snapshot carries no rows of ${table}`,
          );
        }
        return streamRows(files, spec, projection(spec, columns), live);
      },
      tables: () => {
        live();
        return Promise.resolve(
          catalog.tables.map((t): LegacyTableInfo => ({
            name: t.name,
            tableType: t.tableType,
            storageEngine: t.storageEngine,
            charset: t.charset,
            collation: t.collation,
          })),
        );
      },
      catalogColumns: () => {
        live();
        return Promise.resolve(
          catalog.tables.flatMap((t) =>
            t.columns.map((c): LegacyCatalogColumn => ({
              table: t.name,
              column: c.column,
              dataType: c.dataType,
              ordinal: c.ordinal,
              charset: c.charset,
            })),
          ),
        );
      },
      countRows: (table: string) => {
        live();
        const described = catalog.tables.find((t) => t.name === table);
        if (described === undefined) return Promise.reject(new Error('not a table of this source'));
        return Promise.resolve(described.rows);
      },
      readSetRows: (table: string, primaryKey: string, columns: readonly string[]) => {
        live();
        if (
          !LEGACY_IDENTIFIER_PATTERN.test(table) ||
          !LEGACY_IDENTIFIER_PATTERN.test(primaryKey) ||
          !columns.every((c) => LEGACY_IDENTIFIER_PATTERN.test(c))
        ) {
          throw new LegacySourceRefused('SOURCE_TABLE_NOT_READABLE', 'a name is not an identifier');
        }
        if (!isLegacyTableRowReadable(table)) {
          throw new LegacySourceRefused(
            'SOURCE_TABLE_NOT_READABLE',
            `the table catalogue does not let a read set read rows of ${table}`,
          );
        }
        if (columns.length === 0) throw new Error('a read set reads at least one column');
        const spec = (LEGACY_SOURCE_TABLES as readonly string[]).includes(table)
          ? catalog.snapshotTables.get(table as LegacySourceTableName)
          : undefined;
        if (spec === undefined) {
          throw new LegacySourceRefused(
            'SOURCE_TABLE_NOT_READABLE',
            `the package snapshot carries no rows of ${table}`,
          );
        }
        if (primaryKey !== spec.primaryKey) {
          // Another key would be another order: the digest would not be the engine's.
          throw new LegacySourceRefused(
            'SOURCE_UNREADABLE',
            `the package snapshot orders ${table} by its own primary key only`,
          );
        }
        return streamRows(files, spec, projection(spec, columns), live);
      },
      aggregate: () => Promise.reject(new EvidenceUnsupported()),
      syntheticMarker: () => {
        live();
        return Promise.resolve(catalog.syntheticMarker);
      },
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };
    return Promise.resolve(session);
  }
}

/**
 * Streams one rows file, checking as it goes: the header first, then every row's shape, its
 * key non-null and strictly after the previous one in UTF-8 byte order (so also unique), and
 * at the end the count the catalogue promised. Yields each row projected onto `indexes`.
 */
async function* streamRows(
  files: NxpkgSnapshotFiles,
  spec: NxpkgSnapshotTable,
  indexes: readonly number[],
  live: () => void,
): AsyncGenerator<readonly LegacyCell[]> {
  const pk = spec.columns.indexOf(spec.primaryKey);
  let header = false;
  let previous: string | null = null;
  let rows = 0;
  for await (const line of files.iterJsonl(spec.file)) {
    live();
    if (!header) {
      assertNxpkgTableHeader(line, spec);
      header = true;
      continue;
    }
    const cells = nxpkgRowCells(line, spec);
    const key = cells[pk] ?? null;
    if (key === null) {
      throw new LegacySourceRefused(
        'SOURCE_UNREADABLE',
        `the package's ${spec.table} rows file holds a row without a primary key`,
      );
    }
    if (previous !== null && compareKeyBytes(previous, key) >= 0) {
      throw new LegacySourceRefused(
        'SOURCE_UNREADABLE',
        `the package's ${spec.table} rows are not in strictly ascending primary-key byte order ` +
          '(a key is out of order or repeated)',
      );
    }
    previous = key;
    rows += 1;
    yield indexes.map((i) => cells[i] ?? null);
  }
  if (!header) {
    throw new LegacySourceRefused(
      'SOURCE_UNREADABLE',
      `the package's ${spec.table} rows file is empty`,
    );
  }
  if (rows !== spec.rows) {
    throw new LegacySourceRefused(
      'SOURCE_UNREADABLE',
      `the package's ${spec.table} rows file holds another number of rows than its catalogue`,
    );
  }
}

/**
 * An EXTRACTED package directory as snapshot files: the same three reads, from plain files.
 * Only safe relative paths, only regular files (a symlink is refused), each line strict JSON.
 * It verifies nothing about authenticity: the caller extracted it from a verified package.
 */
export function directorySnapshotFiles(dir: string): NxpkgSnapshotFiles {
  const path = (rel: string): string => {
    if (!isSafeRelpath(rel)) {
      throw new LegacySourceRefused('SOURCE_UNREADABLE', 'an unsafe path inside the package');
    }
    return join(dir, ...rel.split('/'));
  };
  const regular = async (rel: string): Promise<string> => {
    const p = path(rel);
    const st = await lstat(p);
    if (!st.isFile()) {
      throw new LegacySourceRefused('SOURCE_UNREADABLE', 'a package file is not a regular file');
    }
    return p;
  };
  const known = new Map<string, boolean>();
  return {
    has: (rel) => {
      if (!isSafeRelpath(rel)) return false;
      const cached = known.get(rel);
      if (cached !== undefined) return cached;
      // Synchronous by contract; checked again (and as a regular file) when read.
      let exists: boolean;
      try {
        exists = lstatSync(path(rel)).isFile();
      } catch {
        exists = false;
      }
      known.set(rel, exists);
      return exists;
    },
    readJson: async (rel) => parseJsonOrRefuse(await readFile(await regular(rel))),
    iterJsonl: (rel) =>
      (async function* () {
        const stream = createReadStream(await regular(rel));
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            const value = parseJsonOrRefuse(Buffer.from(line, 'utf8'));
            if (typeof value !== 'object' || value === null || Array.isArray(value)) {
              throw new LegacySourceRefused('SOURCE_UNREADABLE', 'a JSONL line is not an object');
            }
            yield value as Record<string, unknown>;
          }
        } finally {
          lines.close();
          stream.destroy();
        }
      })(),
  };
}

function parseJsonOrRefuse(data: Buffer): unknown {
  try {
    return parseStrictJson(data);
  } catch {
    throw new LegacySourceRefused('SOURCE_UNREADABLE', 'a package file is not strict JSON');
  }
}

/**
 * Opens and authenticates the package at `path` with the operator's secret, decrypting into
 * a private directory under `workDir`, and returns a connector over its snapshot. The
 * connector OWNS the decrypted package: `close()` deletes it. A package that does not open,
 * or carries no valid snapshot, leaves nothing behind.
 *
 * The secret is used once, here, and never stored on the connector.
 */
export async function nxpkgSourceConnector(
  path: string,
  secret: NxpkgSecret,
  workDir: string,
  limits: Partial<Omit<NxpkgOpenOptions, 'workDir'>> = {},
): Promise<NxpkgLegacySourceConnector> {
  const pkg = await openNxpkg(path, secret, { ...NXPKG_DEFAULT_OPEN_LIMITS, ...limits, workDir });
  try {
    return await NxpkgLegacySourceConnector.fromFiles(pkg, identityOf(pkg.manifest), {
      release: () => pkg.close(),
      pkg,
    });
  } catch (error) {
    await pkg.close();
    throw error;
  }
}
