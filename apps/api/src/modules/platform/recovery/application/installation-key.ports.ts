import type { InstallationKeySource } from '@nexa/contracts';

/**
 * Ports for the Recovery Kit's key lifecycle (ADR-0032).
 *
 * In their own file rather than in `ports.ts` because they describe a keyring,
 * not a recovery request — the recovery module is merely where the only reader
 * of an imported key (a restore) lives.
 */

/** One imported key, as stored. `wrappedMaterial` is ciphertext; nothing here is a key. */
export interface InstallationKeyRow {
  readonly id: string;
  readonly keyId: string;
  readonly fingerprint: string;
  /** Null on a TOMBSTONE — a removed key, kept so a restore cannot revive it. */
  readonly wrappedMaterial: string | null;
  readonly wrappedUnderKeyId: string | null;
  readonly source: InstallationKeySource;
  readonly kitId: string | null;
  readonly importedAt: Date;
  readonly importedByAdminId: string | null;
  readonly importedByLabel: string | null;
  readonly removedAt: Date | null;
  readonly removedByLabel: string | null;
  /** Set when the row came back inside a restored backup rather than an import here. */
  readonly restoredAt: Date | null;
}

export interface InstallationKeyRepository {
  /** Every stored key. On the pool, or inside the caller's transaction. */
  all(tx?: unknown): Promise<readonly InstallationKeyRow[]>;
  /**
   * Serialises every writer of this table for the rest of the transaction.
   *
   * A transaction-scoped advisory lock rather than a row lock, because the
   * thing being decided — "is this id free, does this key collide" — is about
   * rows that do not exist yet.
   */
  lock(tx: unknown): Promise<void>;
  /**
   * Writes an imported key, or revives a tombstone of the same id. Never
   * overwrites a LIVE row; returns false if one is there.
   */
  upsertImported(tx: unknown, row: InstallationKeyRow): Promise<boolean>;
  /**
   * Removes a key by turning its row into a TOMBSTONE: the wrapped bytes are
   * erased, the id and fingerprint kept. Only if the row still holds the key
   * that was checked. A deleted row would let a restore of an older backup
   * bring the key straight back.
   */
  tombstone(
    tx: unknown,
    keyId: string,
    fingerprint: string,
    at: Date,
    byLabel: string,
  ): Promise<boolean>;
  /** Replaces a row's wrap, only if it is still the one that was read. For `secrets rewrap`. */
  rewrap(
    tx: unknown,
    keyId: string,
    expectedWrapped: string,
    next: { wrappedMaterial: string; wrappedUnderKeyId: string },
  ): Promise<boolean>;
  /**
   * Stored SECRETS by the key id their envelope records, across every encrypted
   * column `SECRET_COLUMNS` names — the same walk `secrets retire-check` counts.
   */
  secretCountsByKeyId(tx?: unknown): Promise<ReadonlyMap<string, number>>;
  /** Workspaces of recoveries that have not finished. Paths on this host, never shown. */
  openRecoveryWorkspaces(tx?: unknown): Promise<readonly string[]>;
}

/** One encrypted archive still on this server's disk, as its cleartext header and name describe it. */
export interface RetainedArchive {
  /** The key that sealed it. */
  readonly keyId: string;
  /** When it was taken: the UUIDv7 backup id's own timestamp, else the file's mtime. */
  readonly takenAt: Date;
}

/**
 * The encrypted archives still on this server's disk.
 *
 * Read from each archive's CLEARTEXT header, which names its key without
 * anything being decrypted. Never a path.
 */
export interface RetainedArchiveScanner {
  /**
   * Every archive on disk, and how many could NOT be read.
   *
   * FAIL CLOSED. Only a CONFIRMED-absent archive is no dependency: a directory
   * holding an archive whose header cannot be read (an I/O error, a permission,
   * an upload still arriving) is counted as `unreadable`, and the caller treats
   * each one as a dependency of every key. Throws when the root itself cannot be
   * listed for any reason other than not existing.
   */
  retainedArchives(): Promise<{
    readonly archives: readonly RetainedArchive[];
    readonly unreadable: number;
  }>;
  /**
   * The key a single archive (a recovery's upload) names; null only when the file
   * is confirmed ABSENT. Throws when it exists and cannot be read.
   */
  archiveKeyId(archivePath: string): Promise<string | null>;
}

/**
 * The two things a recovery needs to do to a database that is NOT the live one.
 *
 * Both refuse the live database by name. They exist because a restored
 * candidate is the OLD installation's database: it holds the keys that
 * installation imported, not the ones this installation holds now, and its
 * secrets are sealed under whatever key the old installation was using.
 */
export interface CandidateKeyStore {
  /**
   * Every key id the database's stored secrets name. Tolerates a database whose
   * schema predates a column (a candidate not yet migrated forward).
   */
  referencedKeyIds(database: string): Promise<readonly string[]>;
  /**
   * Writes this installation's imported keys into the candidate, so they survive
   * the cutover that replaces the table holding them.
   *
   * A row the candidate already holds under the same id with the SAME
   * fingerprint is replaced by this installation's wrap (which this installation
   * can open). Under the same id with a DIFFERENT fingerprint, it throws: two
   * different keys answering to one name in one database is exactly the
   * ambiguity a cutover must not carry into production.
   *
   * TOMBSTONES are carried too: a key removed here and present in the
   * candidate (because the backup predates the removal) is erased there, so a
   * restore cannot revive it.
   *
   * Returns the ids of keys the CANDIDATE holds that this installation never
   * had — keys that will come back with the restore. They are stamped
   * `restored_at` in the candidate, for the list and the audit.
   */
  carryInto(database: string, rows: readonly InstallationKeyRow[]): Promise<readonly string[]>;
}

/**
 * What a RECOVERY needs from the keyring, as one port.
 *
 * Both halves of a recovery use it: the operator's restore-test (refresh, then
 * ask what the scratch database needs) and the executor (refresh, carry the
 * keys into the candidate, ask again). One port, so the question "does this
 * installation hold every key the restored database needs" has one answer.
 */
export interface RecoveryKeyCoverage {
  /** Re-reads `installation_keys` into this process's keyring. Never empties it on failure. */
  refresh(): Promise<void>;
  /** Key ids the database's stored secrets name that this installation does not hold. */
  missingFrom(database: string): Promise<readonly string[]>;
  /**
   * Writes this installation's imported keys (and tombstones) into a candidate.
   * Returns the ids of keys that arrive with the restore and were never imported here.
   */
  carryInto(database: string): Promise<readonly string[]>;
}
