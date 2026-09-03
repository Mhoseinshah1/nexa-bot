import { and, asc, eq, gt, isNotNull } from 'drizzle-orm';
import type { SecretPurpose } from '@nexa/contracts';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Database, Executor } from '../persistence/database.js';
import { botInstances, panelCredentials } from '../persistence/schema.js';

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

/**
 * The three panel credential columns.
 *
 * They share a table and a row, so `id` is the panel id for all three and the
 * PURPOSE is the only thing separating their AEAD contexts. That is what makes
 * a password ciphertext moved into the username column fail to decrypt, and it
 * is why `panel.username`, `panel.password` and `panel.api_token` are three
 * purposes rather than one.
 *
 * Built by a factory because the three differ only in which column they name —
 * but the UPDATE is passed in as a closure written at each call site rather
 * than assembled from a column name here. That is not style. Drizzle's `.set()`
 * keys on the TypeScript property (`usernameCiphertext`), while a column
 * handle's `.name` is the SQL identifier (`username_ciphertext`); building the
 * update from the latter type-checks, compiles, and silently updates nothing.
 * A rewrap would then report success for every row and re-encrypt none of them,
 * which is the worst available outcome — `secrets status` would keep showing
 * the old key and nobody could explain why. Written per call site, the field
 * names are checked against the table.
 *
 * The read predicates take `AnyPgColumn`, which is the one place a handle is
 * held loosely. A wrong column there produces a wrong COUNT, which `secrets
 * status` shows; a wrong column in the update produces silent data loss.
 */
interface PanelCredentialColumn {
  readonly ciphertext: AnyPgColumn;
  readonly keyId: AnyPgColumn;
  readonly ciphertextName: string;
  readonly keyIdName: string;
  /** Written at the call site, so Drizzle checks the field names against the table. */
  readonly toUpdate: (next: {
    ciphertext: string;
    keyId: string;
  }) => Partial<typeof panelCredentials.$inferInsert>;
}

function panelCredentialColumn(
  purpose: SecretPurpose,
  columns: PanelCredentialColumn,
): SecretColumn {
  return {
    purpose,
    table: 'panel_credentials',
    ciphertextColumn: columns.ciphertextName,
    keyIdColumn: columns.keyIdName,

    async all(db) {
      const rows = await db
        .select({ ciphertext: columns.ciphertext, keyId: columns.keyId })
        .from(panelCredentials)
        .where(isNotNull(columns.ciphertext));
      // A row with this credential unset is not a stored secret and must not be
      // counted as one: `secrets status` would report more envelopes than
      // exist, and `retire-check` would count a dependency on a key that
      // nothing is actually using — which is the one direction that error must
      // never go, because it would block a retirement that was safe.
      return rows.flatMap((row) =>
        typeof row.ciphertext === 'string' && typeof row.keyId === 'string'
          ? [{ ciphertext: row.ciphertext, keyId: row.keyId }]
          : [],
      );
    },

    async page(db, cursor, limit) {
      const rows = await db
        .select({ id: panelCredentials.panelId })
        .from(panelCredentials)
        .where(
          cursor === null
            ? isNotNull(columns.ciphertext)
            : and(isNotNull(columns.ciphertext), gt(panelCredentials.panelId, cursor)),
        )
        .orderBy(asc(panelCredentials.panelId))
        .limit(limit);
      return rows.map((row) => row.id);
    },

    async lock(tx, id) {
      const [row] = await tx
        .select({
          id: panelCredentials.panelId,
          tenantId: panelCredentials.tenantId,
          ciphertext: columns.ciphertext,
          keyId: columns.keyId,
        })
        .from(panelCredentials)
        .where(eq(panelCredentials.panelId, id))
        .for('update')
        .limit(1);
      if (row === undefined) return null;
      // Locked, and this particular credential is not set on it. Not an error:
      // a panel with a password and no API token is ordinary.
      if (typeof row.ciphertext !== 'string' || typeof row.keyId !== 'string') return null;
      return { id: row.id, tenantId: row.tenantId, ciphertext: row.ciphertext, keyId: row.keyId };
    },

    async replace(tx, id, expectedCiphertext, next) {
      const updated = await tx
        .update(panelCredentials)
        .set(columns.toUpdate(next))
        .where(and(eq(panelCredentials.panelId, id), eq(columns.ciphertext, expectedCiphertext)))
        .returning({ id: panelCredentials.panelId });
      return updated.length > 0;
    },
  };
}

const panelUsername = panelCredentialColumn('panel.username', {
  ciphertext: panelCredentials.usernameCiphertext,
  keyId: panelCredentials.usernameKeyId,
  ciphertextName: 'username_ciphertext',
  keyIdName: 'username_key_id',
  toUpdate: (next) => ({ usernameCiphertext: next.ciphertext, usernameKeyId: next.keyId }),
});

const panelPassword = panelCredentialColumn('panel.password', {
  ciphertext: panelCredentials.passwordCiphertext,
  keyId: panelCredentials.passwordKeyId,
  ciphertextName: 'password_ciphertext',
  keyIdName: 'password_key_id',
  toUpdate: (next) => ({ passwordCiphertext: next.ciphertext, passwordKeyId: next.keyId }),
});

const panelApiToken = panelCredentialColumn('panel.api_token', {
  ciphertext: panelCredentials.apiTokenCiphertext,
  keyId: panelCredentials.apiTokenKeyId,
  ciphertextName: 'api_token_ciphertext',
  keyIdName: 'api_token_key_id',
  toUpdate: (next) => ({ apiTokenCiphertext: next.ciphertext, apiTokenKeyId: next.keyId }),
});

export const SECRET_COLUMNS: readonly SecretColumn[] = [
  botInstanceToken,
  panelUsername,
  panelPassword,
  panelApiToken,
];
