import { createHash } from 'node:crypto';

/**
 * A key-encryption key's fingerprint, and the cost of deriving a key from a password.
 *
 * Both used to live beside the Recovery Kit file format, removed in SFR A1. They outlive it:
 * the fingerprint names a key without showing it (the bundled keys of a self-contained backup,
 * `installation_keys`, `botctl secrets status`), and the derivation profile is what wraps a
 * backup's bundled keys under its backup password.
 */

/** The scrypt cost a WRITER uses. A reader accepts the profiles `key-bundle.ts` lists. */
export interface KdfProfile {
  readonly log2N: number;
  readonly r: number;
  readonly p: number;
}

/**
 * scrypt N = 2^17, r = 8, p = 4: 128 MiB — the same memory a login spends — and four times
 * the work. A backup file is an offline target, so the work factor is what an attacker holding
 * it pays per guess of its password.
 */
export const PRODUCTION_KDF: KdfProfile = { log2N: 17, r: 8, p: 4 };

/**
 * Deliberately weak, for the test suite. Selected by `PASSWORD_HASH_PROFILE=fast`, which the
 * config schema refuses in production.
 */
export const FAST_KDF: KdfProfile = { log2N: 10, r: 8, p: 1 };

/**
 * A key's fingerprint: the first 32 hex digits of SHA-256("nexa.kek.fingerprint.v1\n" || key).
 *
 * Domain-separated so it can never equal any other hash this codebase takes of the same bytes,
 * and truncated to 128 bits because it is a thing people compare by eye.
 */
export function kekFingerprint(material: Buffer): string {
  return createHash('sha256')
    .update('nexa.kek.fingerprint.v1\n', 'utf8')
    .update(material)
    .digest('hex')
    .slice(0, 32);
}
