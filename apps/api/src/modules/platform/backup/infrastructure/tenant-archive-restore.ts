import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  NexaError,
  PLATFORM_ERROR_CODES,
  TENANT_ARCHIVE_ERROR_CODES,
  tenantArchiveManifestSchema,
  type SecretCipher,
  type TenantArchiveManifest,
} from '@nexa/contracts';
import {
  KEY_BUNDLE_ENTRY,
  KEY_BUNDLE_MAX_BYTES,
  openKeyBundle,
  wipeBundleKeys,
} from '../../../../infrastructure/crypto/key-bundle.js';
import {
  createDatabase,
  type DatabaseHandle,
} from '../../../../infrastructure/persistence/database.js';
import type { ExpectedMigration } from '../../../../infrastructure/persistence/migration-state.js';
import {
  bufferWithin,
  decodeCopyLine,
  encodeCopyLine,
  insertRows,
  LineDigest,
  orderSelfReferenced,
  pinSession,
  readByCursor,
  readCatalogue,
  rowsOf,
  selectTenantRows,
  type SqlExecutor,
  type TableShape,
} from './tenant-archive-copy.js';
import { archiveCipher, canonicalRow, secretSlots } from './tenant-archive-secrets.js';
import { SHARED_AGGREGATE_TYPES } from '../application/tenant-archive-inventory.js';
import { extractSevenZipEntry, listSevenZipEntries, type SevenZipOptions } from './seven-zip.js';

/**
 * Phase 6B (ADR-0039 § 3, § 5): opening a tenant archive and proving it in a scratch database.
 *
 * `openTenantArchive` is THE reader — the pipeline's VERIFY_RESTORE and every restore call it,
 * so what is verified is what a restore reads. The scratch database is created EMPTY on the
 * verification server, migrated to the ARCHIVE's head (the target ships every earlier
 * migration), loaded part by part, re-read with the same pinned session and ORDER BY, and
 * compared byte for byte with the manifest; then every secret in it is decrypted under the
 * archive key with its own context. A scratch is never the live database.
 */

const MANIFEST_ENTRY = 'manifest.json';
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const DATA_ENTRY = /^data\/[0-9]{4}-[a-z_][a-z0-9_]*\.copy$/;

function malformed(detail: string): NexaError {
  return new NexaError({
    kind: 'INTERNAL',
    code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_MALFORMED,
    message: `A tenant archive is not readable: ${detail}`,
  });
}

function verificationFailed(detail: string, details?: Record<string, unknown>): NexaError {
  return new NexaError({
    kind: 'INTERNAL',
    code: TENANT_ARCHIVE_ERROR_CODES.VERIFICATION_FAILED,
    message: `A tenant archive did not verify: ${detail}`,
    ...(details === undefined ? {} : { details }),
  });
}

export interface OpenedTenantArchive {
  readonly manifest: TenantArchiveManifest;
  /** Where each part was extracted: `directory/<manifest file>`. */
  readonly directory: string;
  /** The archive key's cipher. The caller wipes `keyMaterial` when done. */
  readonly cipher: SecretCipher;
  readonly keyMaterial: Buffer;
}

/**
 * Opens the ENCRYPTED archive with `password` into `directory`: lists it, refuses any entry its
 * format never writes, reads the manifest and the key bundle (exactly the archive key the
 * manifest names), and extracts every part through a SHA-256 that must equal the manifest's.
 */
export async function openTenantArchive(input: {
  readonly archivePath: string;
  readonly password: string;
  readonly directory: string;
  readonly sevenZip: SevenZipOptions;
  /**
   * Security review of PR-1: bounds that do NOT come from the archive. The parts a manifest
   * declares may total at most `maxExtractedBytes`, and must fit the free space of the work
   * volume (`freeBytes`, null when unknown) with `headroomBytes` to spare; otherwise nothing
   * is extracted. Each part is then cut off at its declared size.
   */
  readonly limits: {
    readonly maxExtractedBytes: number;
    readonly headroomBytes: number;
    readonly freeBytes: () => Promise<number | null>;
  };
}): Promise<OpenedTenantArchive> {
  const entries = await listSevenZipEntries({
    archivePath: input.archivePath,
    password: input.password,
    options: input.sevenZip,
  });
  for (const entry of entries) {
    if (
      entry !== MANIFEST_ENTRY &&
      entry !== KEY_BUNDLE_ENTRY &&
      entry !== 'data' &&
      !DATA_ENTRY.test(entry)
    ) {
      throw malformed('it holds an entry this format never writes');
    }
  }
  if (!entries.includes(MANIFEST_ENTRY) || !entries.includes(KEY_BUNDLE_ENTRY)) {
    throw malformed('it has no manifest or no key bundle');
  }
  await mkdir(join(input.directory, 'data'), { recursive: true, mode: 0o700 });
  const extract = (entry: string, maxBytes?: number) =>
    extractSevenZipEntry({
      archivePath: input.archivePath,
      password: input.password,
      entry,
      destination: join(input.directory, entry),
      options: input.sevenZip,
      ...(maxBytes === undefined ? {} : { maxBytes }),
    });

  await extract(MANIFEST_ENTRY, MANIFEST_MAX_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(input.directory, MANIFEST_ENTRY), 'utf8'));
  } catch {
    throw malformed('the manifest is not JSON');
  }
  const manifest = tenantArchiveManifestSchema.safeParse(parsed);
  if (!manifest.success)
    throw malformed('the manifest does not match the format this release reads');

  await extract(KEY_BUNDLE_ENTRY, KEY_BUNDLE_MAX_BYTES);
  const keys = await openKeyBundle({
    bundle: await readFile(join(input.directory, KEY_BUNDLE_ENTRY)),
    password: input.password,
    backupId: manifest.data.archiveId,
  });
  const key = keys.find((candidate) => candidate.keyId === manifest.data.secrets.archiveKeyId);
  if (keys.length !== 1 || key === undefined) {
    wipeBundleKeys(keys);
    throw malformed('its key bundle does not hold exactly the archive key');
  }

  try {
    const declared = manifest.data.tables.reduce((sum, table) => sum + table.bytes, 0);
    if (declared > input.limits.maxExtractedBytes) {
      throw malformed('it declares more data than this installation restores');
    }
    const free = await input.limits.freeBytes();
    if (free !== null && declared + input.limits.headroomBytes > free) {
      throw new NexaError({
        kind: 'PRECONDITION_FAILED',
        code: PLATFORM_ERROR_CODES.BACKUP_DISK_INSUFFICIENT,
        message: 'There is not enough free disk space to open this tenant archive.',
        details: { declaredBytes: declared, freeBytes: free },
      });
    }
    const files = new Set(manifest.data.tables.map((table) => table.file));
    for (const entry of entries) {
      if (DATA_ENTRY.test(entry) && !files.has(entry))
        throw malformed('a part is not in the manifest');
    }
    for (const table of manifest.data.tables) {
      if (!entries.includes(table.file)) throw malformed(`the part of ${table.name} is missing`);
      const got = await extract(table.file, table.bytes);
      if (got.sha256 !== table.sha256 || got.bytes !== table.bytes) {
        throw new NexaError({
          kind: 'INTERNAL',
          code: PLATFORM_ERROR_CODES.BACKUP_CHECKSUM_MISMATCH,
          message: 'A tenant archive part does not match its manifest.',
          details: { table: table.name },
        });
      }
    }
  } catch (error) {
    wipeBundleKeys(keys);
    throw error;
  }
  return {
    manifest: manifest.data,
    directory: input.directory,
    cipher: archiveCipher(key.keyId, key.material),
    keyMaterial: key.material,
  };
}

// ---------------------------------------------------------------------------
// The schema-version policy (ADR-0039 § 3)
// ---------------------------------------------------------------------------

export type ArchiveHeadVerdict = 'EQUAL' | 'OLDER' | 'NEWER' | 'DIVERGED';

/**
 * The archive's head against this release's journal. NEWER when the archive applied more
 * migrations than this release ships; DIVERGED when the migration at the archive's index is
 * not the one it names (same number, other content); otherwise EQUAL or OLDER.
 */
export function compareArchiveHead(
  head: TenantArchiveManifest['migrations'],
  expected: readonly ExpectedMigration[],
): ArchiveHeadVerdict {
  if (head.count > expected.length) return 'NEWER';
  const at = expected[head.count - 1];
  if (
    at === undefined ||
    at.tag !== head.lastTag ||
    at.hash !== head.lastHash ||
    at.when !== head.lastWhen
  ) {
    return 'DIVERGED';
  }
  return head.count === expected.length ? 'EQUAL' : 'OLDER';
}

/** The Persian refusal for a newer archive (ADR-0039 § 3), word for word. */
export const TENANT_ARCHIVE_HEAD_NEWER_REASON = 'اول نکسای مقصد را به‌روز کنید';

export function refuseHead(verdict: ArchiveHeadVerdict): void {
  if (verdict === 'NEWER') {
    throw new NexaError({
      kind: 'PRECONDITION_FAILED',
      code: TENANT_ARCHIVE_ERROR_CODES.HEAD_NEWER,
      message: TENANT_ARCHIVE_HEAD_NEWER_REASON,
    });
  }
  if (verdict === 'DIVERGED') {
    throw new NexaError({
      kind: 'PRECONDITION_FAILED',
      code: TENANT_ARCHIVE_ERROR_CODES.HEAD_DIVERGED,
      message: 'The archive was taken under a migration history this release does not share.',
    });
  }
}

/**
 * Migrates `databaseUrl` (a SCRATCH database) to the first `count` migrations of `folder`: the
 * migrator runs against a copy of the folder whose journal is truncated there.
 */
export async function migrateScratchTo(input: {
  readonly databaseUrl: string;
  readonly liveDatabase: string;
  readonly folder: string;
  readonly expected: readonly ExpectedMigration[];
  readonly count: number;
  readonly workDirectory: string;
}): Promise<void> {
  if (new URL(input.databaseUrl).pathname.replace(/^\//, '') === input.liveDatabase) {
    throw new NexaError({
      kind: 'VALIDATION',
      code: PLATFORM_ERROR_CODES.BACKUP_UNSAFE_RESTORE_TARGET,
      message: 'Refusing to migrate the live database as a scratch.',
    });
  }
  let folder = input.folder;
  if (input.count < input.expected.length) {
    folder = join(input.workDirectory, `migrations-${String(input.count)}`);
    await mkdir(join(folder, 'meta'), { recursive: true, mode: 0o700 });
    const journal = JSON.parse(
      await readFile(join(input.folder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: unknown[] };
    await writeFile(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, input.count) }),
    );
    for (const migration of input.expected.slice(0, input.count)) {
      await copyFile(
        join(input.folder, `${migration.tag}.sql`),
        join(folder, `${migration.tag}.sql`),
      );
    }
  }
  const handle = createDatabase(input.databaseUrl, 1);
  try {
    await migrate(handle.db, { migrationsFolder: folder });
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Scratch: load, verify, count
// ---------------------------------------------------------------------------

async function* partLines(path: string): AsyncGenerator<string> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) yield line;
}

/** Loads every part, in the manifest's order, into the scratch (as its owner: no RLS there). */
export async function loadScratch(
  scratch: DatabaseHandle,
  opened: OpenedTenantArchive,
): Promise<void> {
  const catalogue = await readCatalogue(scratch.db);
  await scratch.db.transaction(async (tx) => {
    await pinSession(tx);
    for (const table of opened.manifest.tables) {
      const shape = catalogue.get(table.name);
      if (shape === undefined)
        throw verificationFailed('a table of the archive is not in its schema', {
          table: table.name,
        });
      const columns = table.columns.map((column) => column.name);
      const selfReferencing = shape.selfReferences.length > 0;
      let batch: (string | null)[][] = [];
      const buffered = { bytes: 0 };
      for await (const line of partLines(join(opened.directory, table.file))) {
        if (selfReferencing) {
          bufferWithin(batch, [decodeCopyLine(line)], buffered, table.name);
          continue;
        }
        batch.push(decodeCopyLine(line));
        if (batch.length >= 500) {
          await insertRows(tx, shape, columns, batch);
          batch = [];
        }
      }
      await insertRows(
        tx,
        shape,
        columns,
        selfReferencing ? orderSelfReferenced(shape, columns, batch) : batch,
      );
    }
  });
}

/** The tenant's rows of `shape` (`columns`), as lines, with `transform` applied to each row. */
async function digestTable(
  executor: SqlExecutor,
  shape: TableShape,
  columns: readonly string[],
  tenantId: string,
  transform?: (row: (string | null)[]) => (string | null)[],
  lockRows = false,
): Promise<LineDigest> {
  const digest = new LineDigest();
  const select = selectTenantRows(shape, columns, tenantId);
  await readByCursor(
    executor,
    lockRows ? sql`${select} FOR UPDATE` : select,
    columns.length,
    async (rows) => {
      for (const row of rows)
        digest.add(encodeCopyLine(transform === undefined ? row : transform(row)));
    },
  );
  return digest;
}

/**
 * Re-reads every table of the scratch exactly as the export read it and compares count and
 * SHA-256 with the manifest (a lost row, a changed value and a wrong column order all fail);
 * then decrypts every secret under the archive key with its context.
 */
export async function verifyScratch(
  scratch: DatabaseHandle,
  opened: OpenedTenantArchive,
): Promise<void> {
  const tenantId = opened.manifest.tenant.id;
  const catalogue = await readCatalogue(scratch.db);
  await scratch.db.transaction(
    async (tx) => {
      await pinSession(tx);
      for (const table of opened.manifest.tables) {
        const shape = catalogue.get(table.name);
        if (shape === undefined)
          throw verificationFailed('a table is missing', { table: table.name });
        const columns = table.columns.map((column) => column.name);
        const digest = await digestTable(tx, shape, columns, tenantId);
        if (digest.rows !== table.rows || digest.hex() !== table.sha256) {
          throw verificationFailed('a table does not match its manifest', {
            table: table.name,
            expectedRows: table.rows,
            actualRows: digest.rows,
          });
        }
        const slots = secretSlots(table.name, columns);
        if (slots.length === 0) continue;
        await readByCursor(
          tx,
          selectTenantRows(shape, columns, tenantId),
          columns.length,
          async (rows) => {
            for (const row of rows) canonicalRow(row, slots, opened.cipher);
          },
        );
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** The tenant's row count of every TENANT table in `tables`, read with their selectors. */
export async function tenantCounts(
  executor: SqlExecutor,
  catalogue: ReadonlyMap<string, TableShape>,
  tables: readonly string[],
  tenantId: string,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of tables) {
    const shape = catalogue.get(table);
    if (shape === undefined) continue;
    const select = selectTenantRows(shape, [shape.columns[0]?.name ?? 'tenant_id'], tenantId);
    const counted = await rowsOf<{ n: number }>(
      executor,
      sql`SELECT count(*)::int AS n FROM (${select}) AS rows`,
    );
    out[table] = counted[0]?.n ?? 0;
  }
  return out;
}

/**
 * The canonical digest of every table in `tables` (ADR-0039 § 8): secrets decrypted with
 * `cipher` and their key ids dropped, so rows sealed under different keys compare by plaintext.
 */
export async function canonicalDigests(
  executor: SqlExecutor,
  catalogue: ReadonlyMap<string, TableShape>,
  tables: readonly string[],
  tenantId: string,
  cipher: SecretCipher,
  options: {
    /**
     * Phase 6B replace: compare the outbox without the relay's bookkeeping (publication,
     * attempts, errors, retries) — a held bot's messages may still be relayed, which is not a
     * change of its data.
     */
    readonly ignoreRelayMarks?: boolean;
    /**
     * Phase 6B replace: every row read is locked `FOR UPDATE` until the transaction ends, so
     * nothing compared can change before it is deleted.
     */
    readonly lockRows?: boolean;
  } = {},
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of tables) {
    const shape = catalogue.get(table);
    if (shape === undefined) continue;
    const columns = shape.columns.map((column) => column.name);
    const slots = secretSlots(table, columns);
    const relay = ['published_at', 'attempts', 'last_error', 'next_attempt_at', 'exhausted_at']
      .map((c) => columns.indexOf(c))
      .filter((at) => at >= 0);
    // A shared aggregate's outbox sequence is the target's own after a restore (renumbered):
    // the canonical form compares the message, not the number the installation gave it.
    const type = columns.indexOf('aggregate_type');
    const sequence = columns.indexOf('sequence');
    // And an unpublished message lands exhausted (never relayed here): its delivery marks are
    // the target's, not the archive's, so they are compared out too.
    const published = columns.indexOf('published_at');
    const delivery = ['exhausted_at', 'last_error', 'next_attempt_at'].map((c) =>
      columns.indexOf(c),
    );
    const masked = (row: (string | null)[]): (string | null)[] => {
      if (table !== 'outbox_messages') return row;
      const out = [...row];
      if (SHARED_AGGREGATE_TYPES.includes(row[type] ?? '')) out[sequence] = null;
      if (row[published] === null) for (const at of delivery) out[at] = null;
      if (options.ignoreRelayMarks === true) for (const at of relay) out[at] = null;
      return out;
    };
    const digest = await digestTable(
      executor,
      shape,
      columns,
      tenantId,
      (row) => masked(canonicalRow(row, slots, cipher)),
      options.lockRows === true,
    );
    out[table] = `${String(digest.rows)}:${digest.hex()}`;
  }
  return out;
}

/** Runs `fn` with a handle on a scratch database (its owner's), closed afterwards. */
export async function withScratchHandle<T>(
  url: string,
  fn: (scratch: DatabaseHandle) => Promise<T>,
): Promise<T> {
  const handle = createDatabase(url, 2);
  try {
    return await fn(handle);
  } finally {
    await handle.close();
  }
}
