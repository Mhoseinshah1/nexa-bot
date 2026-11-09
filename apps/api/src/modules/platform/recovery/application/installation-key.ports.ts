import type { InstallationKeySource } from '@nexa/contracts';
import type { ExtraKey } from '../../../../infrastructure/crypto/keyring.js';
import type {
  SecretExemption,
  SecretRewrapReport,
  SecretRowQueryable,
  SecretTrialReport,
} from '../../../../infrastructure/crypto/secret-trial.js';
import type {
  SecretClearingInput,
  SecretClearingReport,
} from '../../../../infrastructure/crypto/secret-clearing.js';

/**
 * Ports for the decrypt-only keys an installation still holds from a Recovery Kit it
 * imported before the kit was removed (SFR A1), and for the recovery's view of the keyring.
 *
 * Nothing imports a key any more; `installation_keys` is read (the keyring loader, the
 * executor's carry and tombstones, `secrets rewrap`) and never grows. In their own file
 * rather than in `ports.ts` because they describe a keyring, not a recovery request.
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
  /** Runs `fn` on a short-lived connection to `database`, which must not be the live one. */
  use<T>(database: string, fn: (db: SecretRowQueryable) => Promise<T>): Promise<T>;
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
  /**
   * Trial-decrypts every stored secret in `database` (a scratch or candidate, never
   * the live one) with every key this installation holds — configured, imported —
   * plus `extraKeys`, the keys a self-contained archive carried for THIS recovery.
   * Read-only. Replaces the old id-only `missingFrom`: an id is a label, and two
   * installations can give one label to different keys.
   */
  trialDecrypt(database: string, extraKeys?: readonly ExtraKey[]): Promise<SecretTrialReport>;
  /**
   * Re-encrypts every stored secret in the CANDIDATE under this installation's
   * active key (reading with held keys plus `extraKeys`), then proves every one now
   * reads under the active key alone. Throws when either step did not converge.
   */
  rewrapUnderActiveKey(
    database: string,
    extraKeys?: readonly ExtraKey[],
    /** Rows a clearing deliberately left unreadable (a stopped bot's token). */
    exempt?: SecretExemption,
  ): Promise<SecretRewrapReport>;
  /**
   * §2.3 choice 2: in the CANDIDATE, makes each of `unreadable` read as not set and
   * records a `secret_reentry_items` row for it, in one transaction
   * (`clearUnreadableSecrets`). Throws `SecretClearingRefused` for a value that cannot
   * be cleared without moving money or losing a readable value.
   */
  clearUnreadable(database: string, input: SecretClearingInput): Promise<SecretClearingReport>;
  /**
   * The archive's bundled keys, sealed for the EXECUTOR (another process) under this
   * installation's configured active key and bound to the recovery id — so they can
   * wait in the recovery's workspace without the backup password ever being stored.
   */
  sealForExecutor(recoveryId: string, keys: readonly ExtraKey[]): string;
  /** The reverse of `sealForExecutor`. Throws when the file does not open for this recovery. */
  openForExecutor(recoveryId: string, sealed: string): ExtraKey[];
  /**
   * Writes this installation's imported keys (and tombstones) into a candidate.
   * Returns the ids of keys that arrive with the restore and were never imported here.
   */
  carryInto(database: string): Promise<readonly string[]>;
}
