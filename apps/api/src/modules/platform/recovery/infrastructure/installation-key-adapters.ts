import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';
import { readArchiveHeader } from '../../backup/infrastructure/archive.js';
import { assertNotLiveTarget } from '../../backup/infrastructure/pg-tools.js';
import { SECRET_COLUMNS } from '../../../../infrastructure/crypto/secret-registry.js';
import {
  resolveStoredKeys,
  type InstallationKeyring,
} from '../../../../infrastructure/crypto/installation-keyring.js';
import type {
  CandidateKeyStore,
  InstallationKeyRepository,
  InstallationKeyRow,
  RecoveryKeyCoverage,
  RetainedArchive,
  RetainedArchiveScanner,
} from '../application/installation-key.ports.js';

/**
 * The adapters behind the Recovery Kit's key lifecycle. See ADR-0032.
 */

/**
 * Reads archive HEADERS under `BACKUP_WORK_DIR`. Decrypts nothing.
 *
 * The layout is the backup workspace's own — `<root>/<backup id>/archive.nxb` —
 * and an entry that is not a readable archive is skipped rather than counted:
 * a half-written archive from a run that was killed names no key anybody needs.
 */
export class FilesystemRetainedArchiveScanner implements RetainedArchiveScanner {
  constructor(private readonly backupRoot: string) {}

  async retainedArchives(): Promise<{
    readonly archives: readonly RetainedArchive[];
    readonly unreadable: number;
  }> {
    const archives: RetainedArchive[] = [];
    let unreadable = 0;
    let entries: string[];
    try {
      entries = await readdir(this.backupRoot);
    } catch (error) {
      // No directory is no archives. ANY other failure — a permission, an I/O
      // error — is not an answer, and is thrown so the caller fails closed.
      if (isAbsent(error)) return { archives, unreadable };
      throw error;
    }
    for (const entry of entries) {
      const path = join(this.backupRoot, entry, 'archive.nxb');
      try {
        const keyId = await this.archiveKeyId(path);
        if (keyId === null) continue;
        archives.push({ keyId, takenAt: await takenAt(entry, path) });
      } catch {
        // Present and unreadable: counted, never skipped. A key is removable only
        // when every archive here is known not to need it.
        unreadable += 1;
      }
    }
    return { archives, unreadable };
  }

  async archiveKeyId(archivePath: string): Promise<string | null> {
    try {
      return (await readArchiveHeader(archivePath)).header.keyId;
    } catch (error) {
      // Absent is the ONE failure that means "no archive". A malformed header, a
      // truncated upload and an I/O error all mean "cannot tell" — thrown.
      if (isAbsent(error)) return null;
      throw error;
    }
  }
}

/** Whether a filesystem error says the thing is not there (rather than unreadable). */
function isAbsent(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * When an archive was taken: the UUIDv7 backup id names it to the millisecond,
 * because the workspace directory IS the backup id. A directory not named that
 * way falls back to the file's modification time.
 */
async function takenAt(directoryName: string, archivePath: string): Promise<Date> {
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(directoryName)
  ) {
    const hex = directoryName.replace(/-/g, '').slice(0, 12);
    return new Date(Number.parseInt(hex, 16));
  }
  return (await stat(archivePath)).mtime;
}

/** The connection string for a sibling database on the same cluster. */
function urlFor(databaseUrl: string, database: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

/**
 * Talks to a candidate or scratch database directly, with its own short-lived
 * connection.
 *
 * Its own `pg.Client` and not the pool: the pool belongs to the LIVE database,
 * and these statements must never reach it — `assertNotLiveTarget` refuses the
 * live name before a connection is opened, which makes that a property of this
 * class rather than of its callers.
 */
export class PgCandidateKeyStore implements CandidateKeyStore {
  constructor(
    private readonly databaseUrl: string,
    private readonly liveDatabase: string,
  ) {}

  private async withClient<T>(database: string, fn: (client: Client) => Promise<T>): Promise<T> {
    assertNotLiveTarget({ database }, this.liveDatabase);
    const client = new Client({ connectionString: urlFor(this.databaseUrl, database) });
    // A connection-level failure must not escape as an unhandled 'error' event.
    client.on('error', () => undefined);
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async referencedKeyIds(database: string): Promise<readonly string[]> {
    return this.withClient(database, async (client) => {
      const ids = new Set<string>();
      // The physical names come from the registry — constants in this codebase,
      // never input — and are still checked against the identifier grammar
      // before they are interpolated.
      for (const column of SECRET_COLUMNS) {
        for (const name of [column.table, column.keyIdColumn]) {
          if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unexpected identifier ${name}`);
        }
        const exists = await client.query<{ present: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
           ) AS present`,
          [column.table, column.keyIdColumn],
        );
        // A candidate restored from an older release may not have the column
        // yet. Nothing in it can then be sealed under any key.
        if (exists.rows[0]?.present !== true) continue;
        const { rows } = await client.query<{ key_id: string | null }>(
          `SELECT DISTINCT "${column.keyIdColumn}" AS key_id FROM "${column.table}"
            WHERE "${column.keyIdColumn}" IS NOT NULL`,
        );
        for (const row of rows) if (row.key_id !== null) ids.add(row.key_id);
      }
      return [...ids].sort();
    });
  }

  async carryInto(
    database: string,
    rows: readonly InstallationKeyRow[],
  ): Promise<readonly string[]> {
    return this.withClient(database, async (client) => {
      await client.query('BEGIN');
      try {
        for (const row of rows) {
          if (row.wrappedMaterial === null) {
            // A TOMBSTONE. The candidate predates the removal and may hold the key:
            // erase it there too, or the restore revives a key an operator
            // removed, unaudited. Only the SAME key (fingerprint) — a different key
            // under that name is not the one that was removed.
            await client.query(
              `INSERT INTO installation_keys
                 (id, key_id, fingerprint, wrapped_material, wrapped_under_key_id, source, kit_id,
                  imported_at, imported_by_admin_id, imported_by_label, removed_at, removed_by_label)
               VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6, $7, $8, $9, $10)
               ON CONFLICT (key_id) DO UPDATE
                 SET wrapped_material = NULL, wrapped_under_key_id = NULL,
                     removed_at = EXCLUDED.removed_at, removed_by_label = EXCLUDED.removed_by_label
               WHERE installation_keys.fingerprint = EXCLUDED.fingerprint`,
              [
                row.id,
                row.keyId,
                row.fingerprint,
                row.source,
                row.kitId,
                row.importedAt,
                row.importedByAdminId,
                row.importedByLabel,
                row.removedAt,
                row.removedByLabel,
              ],
            );
            continue;
          }
          // Same id and same key: this installation's wrap replaces the
          // candidate's, because this installation can open it (and a tombstone
          // of it in the candidate is lifted: this installation holds it now).
          // Same id and a different key: nothing is written, and the check below
          // refuses.
          await client.query(
            `INSERT INTO installation_keys
               (id, key_id, fingerprint, wrapped_material, wrapped_under_key_id, source, kit_id,
                imported_at, imported_by_admin_id, imported_by_label)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (key_id) DO UPDATE
               SET wrapped_material = EXCLUDED.wrapped_material,
                   wrapped_under_key_id = EXCLUDED.wrapped_under_key_id,
                   removed_at = NULL, removed_by_label = NULL
             WHERE installation_keys.fingerprint = EXCLUDED.fingerprint`,
            [
              row.id,
              row.keyId,
              row.fingerprint,
              row.wrappedMaterial,
              row.wrappedUnderKeyId,
              row.source,
              row.kitId,
              row.importedAt,
              row.importedByAdminId,
              row.importedByLabel,
            ],
          );
          const check = await client.query<{ fingerprint: string }>(
            'SELECT fingerprint FROM installation_keys WHERE key_id = $1',
            [row.keyId],
          );
          if (check.rows[0]?.fingerprint !== row.fingerprint) {
            throw new Error(
              `the restored database holds a different key under the id "${row.keyId}"`,
            );
          }
        }

        // What the restore brings that this installation never had: live rows in
        // the candidate matching nothing (id AND key) carried above. Stamped, so
        // the list says so and the executor audits it.
        const known = new Set(rows.map((row) => `${row.keyId}|${row.fingerprint}`));
        const candidateRows = await client.query<{ key_id: string; fingerprint: string }>(
          'SELECT key_id, fingerprint FROM installation_keys WHERE removed_at IS NULL',
        );
        const arrived = candidateRows.rows
          .filter((row) => !known.has(`${row.key_id}|${row.fingerprint}`))
          .map((row) => row.key_id)
          .sort();
        if (arrived.length > 0) {
          await client.query(
            'UPDATE installation_keys SET restored_at = now() WHERE key_id = ANY($1) AND restored_at IS NULL',
            [arrived],
          );
        }
        await client.query('COMMIT');
        return arrived;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }
}

/**
 * Keeps a process's `InstallationKeyring` in step with `installation_keys`.
 *
 * Loaded at boot (`resolveInstallationTenant`), after every import and removal
 * in the process that made it, before every archive is opened, and on a timer —
 * so a key imported through the API reaches the worker, the monitor, the
 * provisioner and the recovery executor within one interval, and a restored
 * database's keys reach every process that reconnects to it.
 *
 * A FAILED load changes nothing. A transient database error that emptied the
 * imported set would make every restored credential unreadable until the next
 * tick, which is a self-inflicted outage for no reason.
 */
export class InstallationKeyLoader {
  private timer: NodeJS.Timeout | null = null;
  private lastUnavailable = '';
  /**
   * Every reload runs after the one before it finishes. Two overlapping reloads
   * (the timer and an import, say) could otherwise finish out of order, and the
   * OLDER read would be applied last — re-adding a key just removed, or dropping
   * one just imported, until the next tick.
   */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly keyring: InstallationKeyring,
    private readonly repository: InstallationKeyRepository,
    private readonly logger: {
      warn(context: Record<string, unknown>, message: string): void;
      error(context: Record<string, unknown>, message: string): void;
    },
  ) {}

  refresh(): Promise<{ readonly loaded: number; readonly unavailable: readonly string[] }> {
    const next = this.chain.then(
      () => this.load(),
      () => this.load(),
    );
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<{
    readonly loaded: number;
    readonly unavailable: readonly string[];
  }> {
    const rows = await this.repository.all();
    const { resolved, unavailable } = resolveStoredKeys(
      rows.map((row) => ({
        keyId: row.keyId,
        fingerprint: row.fingerprint,
        wrappedMaterial: row.wrappedMaterial,
      })),
      this.keyring.configuredKeys,
    );
    // A stored id that a CONFIGURED key also answers to is never loaded — the
    // configuration is the authority. `resolveStoredKeys` skips them; they are
    // named here so the log says why a row in the list is not in use.
    const shadowed = rows
      .filter((row) => row.wrappedMaterial !== null && this.keyring.isConfigured(row.keyId))
      .map((row) => row.keyId);
    const refused = [...shadowed, ...this.keyring.replaceImported(resolved)];
    for (const material of resolved.values()) material.fill(0);

    // Said once per change, not once per tick: the ids only, never a reason
    // derived from a cipher error and never anything about the bytes.
    const signature = [...unavailable, ...refused.map((id) => `configured:${id}`)].join(',');
    if (signature !== this.lastUnavailable) {
      this.lastUnavailable = signature;
      if (signature !== '') {
        this.logger.warn(
          { unavailableKeyIds: unavailable, shadowedByConfiguredKeyIds: refused },
          'some imported decrypt-only keys could not be loaded',
        );
      }
    }
    return { loaded: this.keyring.importedKeys.size, unavailable };
  }

  /** Never throws; a failed tick is logged and the previous keys stay. */
  async refreshQuietly(): Promise<void> {
    try {
      await this.refresh();
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'could not reload imported decrypt-only keys; keeping the ones already loaded',
      );
    }
  }

  start(intervalMs: number): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.refreshQuietly(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

/** The recovery's view of the keyring. See `RecoveryKeyCoverage`. */
export class KeyringRecoveryKeyCoverage implements RecoveryKeyCoverage {
  constructor(
    private readonly keyring: InstallationKeyring,
    private readonly loader: InstallationKeyLoader,
    private readonly repository: InstallationKeyRepository,
    private readonly candidates: CandidateKeyStore,
  ) {}

  /**
   * NOT quiet. A recovery that could not reload the keys must stop, not continue
   * on a stale keyring: the executor would otherwise ask `missingFrom` of keys
   * this process still remembers while `carryInto` writes the table as it is —
   * and cut over to a database that needs a key the table no longer holds
   * (Codex review of #144).
   */
  async refresh(): Promise<void> {
    await this.loader.refresh();
  }

  async missingFrom(database: string): Promise<readonly string[]> {
    const referenced = await this.candidates.referencedKeyIds(database);
    return referenced.filter((keyId) => !this.keyring.keys.has(keyId));
  }

  async carryInto(database: string): Promise<readonly string[]> {
    return this.candidates.carryInto(database, await this.repository.all());
  }
}
