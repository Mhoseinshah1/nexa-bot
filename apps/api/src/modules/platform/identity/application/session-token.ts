import { createHash, randomBytes } from 'node:crypto';

/**
 * Session tokens.
 *
 * 32 bytes from the CSPRNG, base64url. Not a UUID and not derived from the
 * admin id: a session token is a bearer credential, so it must be
 * unguessable and must carry no information about who holds it.
 *
 * Only the SHA-256 is stored. A plain hash is right here, unlike for passwords:
 * the input is already 256 bits of uniform randomness, so there is nothing to
 * brute-force and a slow KDF would only add latency to every authenticated
 * request. The property that matters is that a database read cannot be replayed
 * as a login, and a hash gives that.
 */

export const SESSION_TOKEN_BYTES = 32;

export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
