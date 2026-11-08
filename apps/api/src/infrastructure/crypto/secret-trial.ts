import {
  NexaError,
  PLATFORM_ERROR_CODES,
  type SecretCipher,
  type SecretPurpose,
} from '@nexa/contracts';
import { SECRET_COLUMNS, type SecretColumn } from './secret-registry.js';
import { AesGcmSecretCipher, envelopeVersion } from './secret-cipher.js';
import { activeKeyOnly, type SecretKeyring } from './keyring.js';

/**
 * Whether stored secrets can actually be READ — by decrypting them.
 *
 * The question used to be answered by key id: "does this installation hold a key
 * called X?". Ids are labels, and two installations made on the same day both
 * called their key `install-<date>` with different bytes; the restore said yes, cut
 * over, and every secret then failed authentication. Only an authenticated
 * decryption says a value is readable, so this decrypts every stored value (the
 * counts are small: tokens, credentials, a few TOTP secrets) and reports.
 *
 * Used by a recovery's restore test (against the scratch database), by its executor
 * (against the candidate, before and after the rewrap), by `botctl restore`, and —
 * read-only, against the live database — by `botctl secrets verify`/`status`.
 *
 * WHAT IT TOUCHES. Exactly the connection it is given, and on it exactly the tables
 * and columns `SECRET_COLUMNS` names. A recovery hands it a connection to the
 * restored database, never the live one (`PgCandidateKeyStore` refuses the live
 * name), so it reads the restored installation's rows and nothing else.
 *
 * WHAT IT RETURNS. Counts, and the identity of each unreadable row (purpose, table,
 * entity id, tenant id) so a later step can clear or list exactly those. Never a
 * value, a ciphertext, a key or an error message from a cipher.
 */

/** The smallest thing both `pg.Client` and `pg.Pool` are: a parameterised query. */
export interface SecretRowQueryable {
  query<R = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** One stored value that did not decrypt with any key held. Identity only. */
export interface UnreadableSecret {
  readonly purpose: SecretPurpose;
  readonly table: string;
  readonly column: string;
  /** The entity the AEAD context names (the row id; the panel id for panel credentials). */
  readonly entityId: string;
  readonly tenantId: string;
}

export interface SecretPurposeTrial {
  readonly purpose: SecretPurpose;
  readonly readable: number;
  readonly unreadable: number;
}

export interface SecretTrialReport {
  /** One entry per registry column present in the database, in registry order. */
  readonly byPurpose: readonly SecretPurposeTrial[];
  /** Every row that failed, in registry order. */
  readonly unreadable: readonly UnreadableSecret[];
  readonly readableTotal: number;
  readonly unreadableTotal: number;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function quoted(name: string): string {
  if (!IDENTIFIER.test(name))
    throw new Error(`unexpected identifier in the secret registry: ${name}`);
  return `"${name}"`;
}

interface StoredSecret {
  readonly id: string;
  readonly tenant_id: string;
  readonly ciphertext: string;
  readonly key_id: string | null;
}

/**
 * The column's stored values, or null when the database predates the column (a
 * restored candidate not yet migrated). A column that exists while the entity or
 * tenant column the registry names does not is a registry error, and THROWS:
 * silently skipping it would report a column as fully readable that was never read.
 */
async function storedValues(
  db: SecretRowQueryable,
  column: SecretColumn,
): Promise<readonly StoredSecret[] | null> {
  const present = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2::text[])`,
    [
      column.table,
      [column.ciphertextColumn, column.keyIdColumn, column.entityIdColumn, 'tenant_id'],
    ],
  );
  const names = new Set(present.rows.map((row) => row.column_name));
  if (!names.has(column.ciphertextColumn)) return null;
  for (const required of [column.keyIdColumn, column.entityIdColumn, 'tenant_id']) {
    if (!names.has(required)) {
      throw new Error(`${column.table} has ${column.ciphertextColumn} but no ${required}`);
    }
  }
  const { rows } = await db.query<StoredSecret>(
    `SELECT ${quoted(column.entityIdColumn)}::text AS id, tenant_id::text AS tenant_id,
            ${quoted(column.ciphertextColumn)} AS ciphertext, ${quoted(column.keyIdColumn)} AS key_id
       FROM ${quoted(column.table)}
      WHERE ${quoted(column.ciphertextColumn)} IS NOT NULL
      ORDER BY 1`,
  );
  return rows;
}

function readable(cipher: SecretCipher, column: SecretColumn, row: StoredSecret): boolean {
  try {
    cipher.decrypt(
      { keyId: row.key_id ?? '', ciphertext: row.ciphertext },
      { purpose: column.purpose, tenantId: row.tenant_id, entityId: row.id },
    );
    return true;
  } catch {
    // Every refusal counts the same: a failed tag, an unknown key id, an envelope
    // this release does not read, a column that disagrees with its envelope. Each
    // one is a value this installation cannot use, and none is reported further.
    return false;
  }
}

/**
 * Trial-decrypts every stored secret on `db` with `cipher`. Read-only.
 *
 * Every row, not a sample: one key id can cover rows sealed under two different
 * keys (that is the incident), so one row per id proves nothing about the next.
 */
export async function trialDecryptSecrets(
  db: SecretRowQueryable,
  cipher: SecretCipher,
): Promise<SecretTrialReport> {
  const byPurpose: SecretPurposeTrial[] = [];
  const unreadable: UnreadableSecret[] = [];
  let readableTotal = 0;
  for (const column of SECRET_COLUMNS) {
    const rows = await storedValues(db, column);
    if (rows === null) continue;
    let ok = 0;
    let failed = 0;
    for (const row of rows) {
      if (readable(cipher, column, row)) {
        ok += 1;
        continue;
      }
      failed += 1;
      unreadable.push({
        purpose: column.purpose,
        table: column.table,
        column: column.ciphertextColumn,
        entityId: row.id,
        tenantId: row.tenant_id,
      });
    }
    readableTotal += ok;
    byPurpose.push({ purpose: column.purpose, readable: ok, unreadable: failed });
  }
  return { byPurpose, unreadable, readableTotal, unreadableTotal: unreadable.length };
}

/**
 * The per-purpose failures, for the request row and the Web Admin: purposes with at
 * least one unreadable value, merged (three panel columns are three purposes already).
 */
export function unreadableCounts(
  report: SecretTrialReport,
): { readonly purpose: SecretPurpose; readonly count: number }[] {
  const counts = new Map<SecretPurpose, number>();
  for (const entry of report.byPurpose) {
    if (entry.unreadable > 0) {
      counts.set(entry.purpose, (counts.get(entry.purpose) ?? 0) + entry.unreadable);
    }
  }
  return [...counts.entries()].map(([purpose, count]) => ({ purpose, count }));
}

/** Names rows a rewrap and its proof leave alone. Identity only. */
export type SecretExemption = (row: {
  readonly purpose: SecretPurpose;
  readonly table: string;
  readonly entityId: string;
}) => boolean;

/** An exemption for exactly these rows. */
export function exemptRows(
  rows: readonly { purpose: SecretPurpose; table: string; entityId: string }[],
): SecretExemption {
  const keys = new Set(rows.map((row) => `${row.purpose}|${row.table}|${row.entityId}`));
  return (row) => keys.has(`${row.purpose}|${row.table}|${row.entityId}`);
}

export interface SecretRewrapReport {
  /** Re-encrypted under the active key. */
  readonly rewrapped: number;
  /** Already v2 under the active key, and proven so by decrypting with it alone. */
  readonly alreadyCurrent: number;
  /** Could not be read with any key, or changed under the update. Nothing was written. */
  readonly failed: number;
}

/**
 * Re-encrypts every stored secret on `db` under `keyring`'s ACTIVE key.
 *
 * For a database that is NOT serving (a recovery's candidate, a `botctl restore`
 * target): each row is one compare-and-set UPDATE on the ciphertext that was read,
 * so a row is never half-written and a concurrent write is never overwritten.
 *
 * The skip test is a DECRYPTION with the active key alone, not the envelope's key
 * id: in the incident every row already named the active key's id and was sealed
 * under somebody else's bytes, and an id-only skip would have left all of them.
 *
 * No audit row per value: the database being rewritten is not the one being served,
 * and its own audit trail is restored history. The caller records the totals on the
 * recovery (or prints them), which is the auditable fact.
 */
export async function rewrapSecretsUnderActiveKey(
  db: SecretRowQueryable,
  keyring: SecretKeyring,
  acceptV1: boolean,
  /**
   * Rows deliberately left as they are: the unreadable values a restore was told to
   * clear and could only DISABLE (a bot token: the column is NOT NULL, so the bot is
   * stopped and its token waits to be re-entered). Not read, not rewritten, not counted.
   */
  exempt: SecretExemption = () => false,
): Promise<SecretRewrapReport> {
  const full = new AesGcmSecretCipher(keyring, acceptV1);
  const activeOnly = new AesGcmSecretCipher(activeKeyOnly(keyring), false);
  let rewrapped = 0;
  let alreadyCurrent = 0;
  let failed = 0;
  for (const column of SECRET_COLUMNS) {
    const rows = await storedValues(db, column);
    if (rows === null) continue;
    for (const row of rows) {
      if (exempt({ purpose: column.purpose, table: column.table, entityId: row.id })) continue;
      const context = { purpose: column.purpose, tenantId: row.tenant_id, entityId: row.id };
      const stored = { keyId: row.key_id ?? '', ciphertext: row.ciphertext };
      if (
        envelopeVersion(row.ciphertext) === 'v2' &&
        row.key_id === keyring.activeKeyId &&
        readable(activeOnly, column, row)
      ) {
        alreadyCurrent += 1;
        continue;
      }
      let plaintext: string;
      try {
        plaintext = full.decrypt(stored, context);
      } catch {
        failed += 1;
        continue;
      }
      const next = full.encrypt(plaintext, context);
      const updated = await db.query(
        `UPDATE ${quoted(column.table)}
            SET ${quoted(column.ciphertextColumn)} = $1, ${quoted(column.keyIdColumn)} = $2
          WHERE ${quoted(column.entityIdColumn)}::text = $3
            AND ${quoted(column.ciphertextColumn)} = $4`,
        [next.ciphertext, next.keyId, row.id, row.ciphertext],
      );
      if (updated.rowCount === 1) rewrapped += 1;
      else failed += 1;
    }
  }
  return { rewrapped, alreadyCurrent, failed };
}

/**
 * Rewraps, then PROVES the result: every stored secret must now decrypt under the
 * active key alone. Throws (with counts only) when anything failed either step —
 * the caller treats that as "do not serve this database".
 */
export async function rewrapAndProve(
  db: SecretRowQueryable,
  keyring: SecretKeyring,
  acceptV1: boolean,
  exempt: SecretExemption = () => false,
): Promise<SecretRewrapReport & { readonly proof: SecretTrialReport }> {
  const rewrap = await rewrapSecretsUnderActiveKey(db, keyring, acceptV1, exempt);
  const proof = await trialDecryptSecrets(
    db,
    new AesGcmSecretCipher(activeKeyOnly(keyring), false),
  );
  // An exempt row is unreadable by definition; anything else unreadable is a failure.
  const stillUnreadable = proof.unreadable.filter((row) => !exempt(row));
  if (rewrap.failed > 0 || stillUnreadable.length > 0) {
    throw new NexaError({
      kind: 'INTERNAL',
      code: PLATFORM_ERROR_CODES.SECRET_AUTH_FAILED,
      message:
        `Re-encrypting the restored secrets under the active key did not converge: ` +
        `${String(rewrap.failed)} could not be re-encrypted, ${String(stillUnreadable.length)} ` +
        'do not read under the active key.',
      details: { unreadable: unreadableCounts(proof) },
    });
  }
  return { ...rewrap, proof };
}
