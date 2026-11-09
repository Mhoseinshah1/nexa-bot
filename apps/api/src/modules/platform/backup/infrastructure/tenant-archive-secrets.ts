import type { SecretCipher, SecretPurpose } from '@nexa/contracts';
import { AesGcmSecretCipher } from '../../../../infrastructure/crypto/secret-cipher.js';
import { SECRET_COLUMNS } from '../../../../infrastructure/crypto/secret-registry.js';

/**
 * Phase 6B (ADR-0039 § 2): a tenant archive's secrets are sealed under ONE fresh 256-bit
 * ARCHIVE key, never under this server's keyring, with the same `SecretContext` (purpose,
 * tenant id, entity id) — ids are kept, so the AAD stays valid. The archive key is wrapped by
 * the hosted bot's backup password in `keys.json`; it opens this tenant's secrets and nothing
 * else, so one leaked hosted password is never a key to every tenant's secrets.
 *
 * The secret columns are `SECRET_REGISTRY`'s — the registry is the coverage claim, and
 * `secret-registry.test.ts` fails when an encrypted column is missing from it.
 */

/** The archive key's id: `archive-<archiveId>` (an envelope id holds no `.` or `:`). */
export function archiveKeyId(archiveId: string): string {
  return `archive-${archiveId}`;
}

/** A cipher holding exactly the archive key, encrypting with it. v2 only. */
export function archiveCipher(keyId: string, material: Buffer): SecretCipher {
  return new AesGcmSecretCipher(
    { activeKeyId: keyId, keys: new Map([[keyId, material]]), format: 'canonical' },
    false,
  );
}

/** One encrypted column of a table, by its position in the row the archive reads. */
export interface SecretSlot {
  readonly purpose: SecretPurpose;
  readonly ciphertext: number;
  readonly keyId: number;
  readonly entityId: number;
  readonly tenantId: number;
}

/** The encrypted columns of `table` among `columns` (positions), from the registry. */
export function secretSlots(table: string, columns: readonly string[]): SecretSlot[] {
  const out: SecretSlot[] = [];
  for (const entry of SECRET_COLUMNS) {
    if (entry.table !== table) continue;
    const slot = {
      purpose: entry.purpose,
      ciphertext: columns.indexOf(entry.ciphertextColumn),
      keyId: columns.indexOf(entry.keyIdColumn),
      entityId: columns.indexOf(entry.entityIdColumn),
      tenantId: columns.indexOf('tenant_id'),
    };
    if (Object.values(slot).some((value) => value === -1)) {
      throw new Error(`the secret column ${table}.${entry.ciphertextColumn} is not readable`);
    }
    out.push(slot);
  }
  return out;
}

/**
 * Re-seals every secret of `row` from `from` to `to`, in place of the stored envelope and key
 * id, with the row's own context. A NULL envelope stays NULL. Returns the purposes it touched.
 */
export function resealRow(
  row: (string | null)[],
  slots: readonly SecretSlot[],
  from: SecretCipher,
  to: SecretCipher,
): SecretPurpose[] {
  const touched: SecretPurpose[] = [];
  for (const slot of slots) {
    const ciphertext = row[slot.ciphertext];
    const keyId = row[slot.keyId];
    if (ciphertext === null || ciphertext === undefined || keyId === null || keyId === undefined) {
      continue;
    }
    const context = {
      purpose: slot.purpose,
      tenantId: row[slot.tenantId] ?? '',
      entityId: row[slot.entityId] ?? '',
    };
    const plaintext = from.decrypt({ ciphertext, keyId }, context);
    const sealed = to.encrypt(plaintext, context);
    row[slot.ciphertext] = sealed.ciphertext;
    row[slot.keyId] = sealed.keyId;
    touched.push(slot.purpose);
  }
  return touched;
}

/**
 * The CANONICAL form of a row (ADR-0039 § 8): each secret decrypted with `cipher` and its key
 * id dropped, so the same plaintext under the source key, the archive key and the target's
 * active key reads the same. For digests only — never written anywhere.
 */
export function canonicalRow(
  row: readonly (string | null)[],
  slots: readonly SecretSlot[],
  cipher: SecretCipher,
): (string | null)[] {
  const out = [...row];
  for (const slot of slots) {
    const ciphertext = row[slot.ciphertext];
    const keyId = row[slot.keyId];
    if (ciphertext === null || ciphertext === undefined || keyId === null || keyId === undefined) {
      continue;
    }
    out[slot.ciphertext] = cipher.decrypt(
      { ciphertext, keyId },
      {
        purpose: slot.purpose,
        tenantId: row[slot.tenantId] ?? '',
        entityId: row[slot.entityId] ?? '',
      },
    );
    out[slot.keyId] = null;
  }
  return out;
}
