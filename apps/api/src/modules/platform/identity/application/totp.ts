import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TOTP_PARAMETERS } from '@nexa/contracts';

/**
 * RFC 6238 TOTP over RFC 4226 HOTP, on `node:crypto` alone.
 *
 * No dependency: the algorithm is an HMAC, a dynamic truncation and a modulus, and a
 * library for it is more surface in the process that holds every key-encryption key than
 * the thirty lines it would save. The RFC's own test vectors pin it
 * (`tests/unit/admin-totp.test.ts`).
 *
 * Pure and clock-free: every function takes the instant it is asked about, because the
 * Clock port belongs to the caller.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, upper case, no padding — what authenticator apps expect to be typed. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Strict inverse of `base32Encode`. Throws on any character outside the alphabet. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Not a base32 string.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh shared secret: 160 bits from the CSPRNG, base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_PARAMETERS.secretBytes));
}

/** The 30-second step an instant falls in. */
export function totpStepAt(at: Date): number {
  return Math.floor(at.getTime() / 1000 / TOTP_PARAMETERS.periodSeconds);
}

/** RFC 4226 §5.3: HMAC-SHA-1 over the 8-byte big-endian counter, dynamically truncated. */
export function hotp(key: Uint8Array, counter: number, digits: number = TOTP_PARAMETERS.digits) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The code for one step of a base32 secret. */
export function totpForStep(secret: string, step: number): string {
  return hotp(base32Decode(secret), step);
}

/**
 * The step a presented code belongs to, or null.
 *
 * Accepts the current step and `skewSteps` either side, and ONLY a step strictly after
 * `lastUsedStep` — the replay rule. The caller must still record the returned step with
 * a conditional write (`consumeStep`), because two requests can both get here with the
 * same code; this function decides whether a code is acceptable, and the database
 * decides which of two acceptable requests used it.
 *
 * Every candidate is compared, in constant time, whatever an earlier one answered: the
 * loop does not leave early on a match, so its timing does not say which step matched.
 */
export function matchTotp(
  secret: string,
  code: string,
  at: Date,
  lastUsedStep: number | null,
): number | null {
  if (!/^[0-9]+$/.test(code) || code.length !== TOTP_PARAMETERS.digits) return null;
  const key = base32Decode(secret);
  const now = totpStepAt(at);
  const presented = Buffer.from(code, 'utf8');
  let matched: number | null = null;
  for (let offset = -TOTP_PARAMETERS.skewSteps; offset <= TOTP_PARAMETERS.skewSteps; offset += 1) {
    const step = now + offset;
    if (step < 0) continue;
    const expected = Buffer.from(hotp(key, step), 'utf8');
    const equal = timingSafeEqual(expected, presented);
    if (equal && (lastUsedStep === null || step > lastUsedStep)) {
      matched = matched === null ? step : Math.max(matched, step);
    }
  }
  return matched;
}

/**
 * The `otpauth://` URI authenticator apps import (the Key Uri Format). The parameters are
 * spelled out even though they are the defaults, so an app that reads them agrees with
 * the server and one that ignores them is already on the defaults.
 */
export function otpauthUri(input: {
  readonly issuer: string;
  readonly account: string;
  readonly secret: string;
}): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const query = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: TOTP_PARAMETERS.algorithm,
    digits: String(TOTP_PARAMETERS.digits),
    period: String(TOTP_PARAMETERS.periodSeconds),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
