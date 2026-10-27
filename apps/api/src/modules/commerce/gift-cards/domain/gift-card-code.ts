import { createHash, randomBytes } from 'node:crypto';
import {
  GIFT_CARD_CODE_ALPHABET,
  GIFT_CARD_CODE_GROUP_SIZE,
  GIFT_CARD_CODE_INPUT_MAX_LENGTH,
  GIFT_CARD_CODE_LENGTH,
} from '@nexa/contracts';

/**
 * A gift card's code: generated, normalised, hashed. Pure, apart from the CSPRNG default.
 *
 * ## Uniform symbols, by rejection
 *
 * The alphabet has 30 symbols and a byte has 256 values. `byte % 30` would favour the first 16
 * symbols (256 = 8 × 30 + 16), so a byte is used only when it is below 240 (8 × 30) and any
 * other byte is discarded — each symbol then has probability exactly 1/30, and 20 of them are
 * log2(30^20) ≈ 98.1 bits. With ~6% of bytes discarded, 32 bytes almost always suffice; the
 * loop draws more when they do not.
 *
 * ## Only the hash is stored
 *
 * SHA-256 over a domain tag, the tenant and the normalised code — the `backup-codes.ts`
 * pattern. Plain SHA-256 is right for the reason a session token's is: 98 bits of uniform
 * randomness leave nothing to brute-force offline, and a slow KDF would only add latency to
 * every redemption. The tenant is in the input, so the same code could never match in
 * another tenant even in principle.
 */

const ALPHABET = GIFT_CARD_CODE_ALPHABET;
/** The largest multiple of the alphabet size that fits a byte: bytes at or above it are discarded. */
const REJECT_AT = Math.floor(256 / ALPHABET.length) * ALPHABET.length;

/**
 * Persian and Arabic-Indic digits, folded to ASCII: a customer on a Persian keyboard types
 * «۲» for 2. Only the digits the alphabet uses survive the later check anyway.
 */
const DIGIT_FOLD: Readonly<Record<string, string>> = Object.fromEntries([
  ...[...'۰۱۲۳۴۵۶۷۸۹'].map((digit, value) => [digit, String(value)]),
  ...[...'٠١٢٣٤٥٦٧٨٩'].map((digit, value) => [digit, String(value)]),
]);

/** Separators a typed or pasted code may carry: whitespace, dashes, zero-width and bidi marks. */
const SEPARATORS = /[\s\-_\u2010-\u2015\u2212\u200b-\u200f\u2066-\u2069\u202a-\u202e\ufeff]/gu;

/** One fresh code, NORMALISED (20 symbols, no separators). */
export function generateGiftCardCode(
  random: (size: number) => Uint8Array = (size) => randomBytes(size),
): string {
  let code = '';
  while (code.length < GIFT_CARD_CODE_LENGTH) {
    for (const byte of random(32)) {
      if (byte >= REJECT_AT) continue;
      code += ALPHABET[byte % ALPHABET.length];
      if (code.length === GIFT_CARD_CODE_LENGTH) break;
    }
  }
  return code;
}

/** `ABCD-EFGH-JKMN-PQRS-TVWX`, the form printed in the export. Takes a NORMALISED code. */
export function formatGiftCardCode(normalised: string): string {
  const groups: string[] = [];
  for (let at = 0; at < normalised.length; at += GIFT_CARD_CODE_GROUP_SIZE) {
    groups.push(normalised.slice(at, at + GIFT_CARD_CODE_GROUP_SIZE));
  }
  return groups.join('-');
}

/**
 * The canonical form of a typed code, or null when it cannot be one of ours.
 *
 * Forgiven: case, separators where the grouping was, surrounding whitespace, a pasted line
 * break, Persian and Arabic-Indic digits. NOT forgiven: a symbol outside the alphabet (O, 0,
 * I, 1, L, U are not in it, so a guess at what was meant would be a guess at another code).
 * Never throws: a malformed code is a refused code. Input longer than
 * `GIFT_CARD_CODE_INPUT_MAX_LENGTH` is refused before it is read.
 */
export function normaliseGiftCardCode(input: string): string | null {
  if (input.length > GIFT_CARD_CODE_INPUT_MAX_LENGTH) return null;
  let folded = '';
  for (const char of input.replace(SEPARATORS, '')) folded += DIGIT_FOLD[char] ?? char;
  folded = folded.toUpperCase();
  if (folded.length !== GIFT_CARD_CODE_LENGTH) return null;
  for (const char of folded) if (!ALPHABET.includes(char)) return null;
  return folded;
}

/** The stored form: hex SHA-256, bound to the tenant. Takes a NORMALISED code. */
export function hashGiftCardCode(tenantId: string, normalised: string): string {
  return createHash('sha256')
    .update(`nexa.gift_card.v1\n${tenantId}\n${normalised}`, 'utf8')
    .digest('hex');
}

/** The last four symbols, for support: enough to find a code with its holder, never the code. */
export function giftCardLast4(normalised: string): string {
  return normalised.slice(-4);
}
