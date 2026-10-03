import { createHash, randomBytes } from 'node:crypto';
import { BACKUP_CODE_COUNT } from '@nexa/contracts';

/**
 * Backup codes: 80 bits each, from the CSPRNG, in Crockford's base32.
 *
 * Crockford's alphabet has no I, L, O or U, so a code copied off paper cannot be
 * misread as another one, and the normaliser forgives the confusions people actually
 * make — a lower-case letter, a dash or space where the grouping was, O for zero, I or L
 * for one. Sixteen characters, shown as four groups of four.
 *
 * Only the hash is stored (`admin_backup_codes`). Plain SHA-256 is right for the reason
 * a session token's is: 80 bits of uniform randomness leaves nothing to brute-force, and
 * a slow KDF would only add latency. Domain-separated and bound to the tenant and the
 * administrator, so the same code could not verify on another account even in principle.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 16;

function encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** `ABCD-EFGH-JKMN-PQRS`, the form displayed and printed. */
export function formatBackupCode(normalised: string): string {
  return normalised.match(/.{1,4}/g)?.join('-') ?? normalised;
}

/** One fresh code, in its display form. */
export function generateBackupCode(): string {
  // 10 bytes = 80 bits = exactly 16 Crockford characters.
  return formatBackupCode(encode(randomBytes(10)));
}

/** A full generation, display form. Distinct by construction at 80 bits; checked anyway. */
export function generateBackupCodes(count: number = BACKUP_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(generateBackupCode());
  return [...codes];
}

/**
 * The canonical form of a typed code, or null when it cannot be one of ours.
 * Never throws: a malformed code is simply a wrong code.
 */
export function normaliseBackupCode(input: string): string | null {
  const folded = input
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (folded.length !== CODE_LENGTH) return null;
  for (const char of folded) if (!CROCKFORD.includes(char)) return null;
  return folded;
}

/** The stored form. Takes a NORMALISED code. */
export function hashBackupCode(tenantId: string, adminId: string, normalised: string): string {
  return createHash('sha256')
    .update(`nexa.backup_code.v1\n${tenantId}\n${adminId}\n${normalised}`, 'utf8')
    .digest('hex');
}
