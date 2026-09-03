import { and, asc, eq, gt } from 'drizzle-orm';
import type { SecretPurpose } from '@nexa/contracts';
import type { Database, Executor } from '../persistence/database.js';
import { botInstances } from '../persistence/schema.js';

/**
 * Every encrypted column in the schema, named once.
 *
 * This is the list `secrets status`, `secrets rewrap` and `secrets retire-check`
 * walk. A column that is not here is invisible to all three: it would never be
 * re-encrypted, it would never appear in a version count, and — worst — key
 * retirement would report that nothing depends on a key while that column still
 * did. The registry IS the coverage claim.
 *
 * So it is not left to memory. `tests/unit/secret-registry.test.ts` reads the
 * Drizzle schema, finds every column whose name ends in `_ciphertext`, and
 * fails when one is missing from here. Adding an encrypted column without
 * adding an entry breaks the build.
 *
 * Each entry carries its own queries as closures rather than exposing raw
 * column handles. A generic walker over heterogeneous tables ends up casting
 * away Drizzle's types at exactly the place where naming the wrong column would
 * be silent — the update. Here each entry is typed against its own table and
 * the callers need no casts at all.
 */

export interface SecretRow {
  readonly id: string;
  readonly tenantId: string;
  readonly ciphertext: string;
  readonly keyId: string;
}

export interface SecretColumn {
  readonly purpose: SecretPurpose;
  /** For operator output. The physical names, as they appear in the database. */
  readonly table: string;
  readonly ciphertextColumn: string;
  readonly keyIdColumn: string;

  /** Every stored envelope and its recorded key id. For counting, never decrypting. */
  all(db: Database): Promise<{ ciphertext: string; keyId: string }[]>;
  /** One page of ids after `cursor`, ascending. Keyset, so concurrent updates cannot shift it. */
  page(db: Database, cursor: string | null, limit: number): Promise<string[]>;
  /** The row, locked for the length of the transaction. */
  lock(tx: Executor, id: string): Promise<SecretRow | null>;
  /**
   * Replaces the envelope only if it is still the one that was read.
   *
   * Returns false when a concurrent business write got there first, so a stale
   * re-encryption of a replaced value is never written. `updated_at` is not
   * touched: re-encrypting a stored value is cryptographic maintenance, not a
   * change to the entity, and a timestamp that moved would say otherwise.
   */
  replace(
    tx: Executor,
    id: string,
    expectedCiphertext: string,
    next: { ciphertext: string; keyId: string },
  ): Promise<boolean>;
}

const botInstanceToken: SecretColumn = {
  purpose: 'bot_instance.token',
  table: 'bot_instances',
  ciphertextColumn: 'token_ciphertext',
  keyIdColumn: 'token_key_id',

  async all(db) {
    return db
      .select({ ciphertext: botInstances.tokenCiphertext, keyId: botInstances.tokenKeyId })
      .from(botInstances);
  },

  async page(db, cursor, limit) {
    const rows = await db
      .select({ id: botInstances.id })
      .from(botInstances)
      .where(cursor === null ? undefined : gt(botInstances.id, cursor))
      .orderBy(asc(botInstances.id))
      .limit(limit);
    return rows.map((row) => row.id);
  },

  async lock(tx, id) {
    const [row] = await tx
      .select({
        id: botInstances.id,
        tenantId: botInstances.tenantId,
        ciphertext: botInstances.tokenCiphertext,
        keyId: botInstances.tokenKeyId,
      })
      .from(botInstances)
      .where(eq(botInstances.id, id))
      .for('update')
      .limit(1);
    return row ?? null;
  },

  async replace(tx, id, expectedCiphertext, next) {
    const updated = await tx
      .update(botInstances)
      .set({ tokenCiphertext: next.ciphertext, tokenKeyId: next.keyId })
      .where(and(eq(botInstances.id, id), eq(botInstances.tokenCiphertext, expectedCiphertext)))
      .returning({ id: botInstances.id });
    return updated.length > 0;
  },
};

export const SECRET_COLUMNS: readonly SecretColumn[] = [botInstanceToken];
