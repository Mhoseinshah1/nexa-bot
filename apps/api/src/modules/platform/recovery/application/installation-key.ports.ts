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
  readonly wrappedMaterial: string;
  readonly wrappedUnderKeyId: string;
  readonly source: InstallationKeySource;
  readonly kitId: string | null;
  readonly importedAt: Date;
  readonly importedByAdminId: string | null;
  readonly importedByLabel: string | null;
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
  insert(tx: unknown, row: InstallationKeyRow): Promise<void>;
  /** Deletes the row only if it still holds the bytes that were checked. */
  deleteIfUnchanged(tx: unknown, keyId: string, fingerprint: string): Promise<boolean>;
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

/**
 * Which key sealed each encrypted archive that is still on this server's disk.
 *
 * Read from each archive's CLEARTEXT header, which names its key without
 * anything being decrypted. A count by key id; never a path.
 */
export interface RetainedArchiveScanner {
  retainedArchiveKeyIds(): Promise<ReadonlyMap<string, number>>;
  /** The key a single archive (a recovery's upload) names, or null when unreadable. */
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
   */
  carryInto(database: string, rows: readonly InstallationKeyRow[]): Promise<void>;
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
  /** Writes this installation's imported keys into a candidate. Returns how many. */
  carryInto(database: string): Promise<number>;
}
