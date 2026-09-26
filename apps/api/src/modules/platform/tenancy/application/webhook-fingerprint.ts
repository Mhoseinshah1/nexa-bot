import { createHash } from 'node:crypto';

/**
 * The one-way digest stored beside a webhook registration.
 *
 * SHA-256 hex of the secret, and nothing reads it back: the only question asked
 * of it is "is this the same secret as the one that was registered". A stored
 * plaintext would be a second copy of a credential that lives in exactly one
 * file today.
 *
 * Its own module because two callers ask that question — the bootstrap, which
 * writes the digest, and the Web Admin's bot view (WP13), which compares it —
 * and a second SHA-256 of the same secret would be a second answer to it.
 */
export function webhookSecretFingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}
