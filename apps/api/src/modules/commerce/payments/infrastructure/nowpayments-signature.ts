import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The NOWPayments IPN signature (`docs/nowpayments-gateway-audit.md` §2, §5.6).
 *
 * Documented: the `x-nowpayments-sig` header is the lowercase hex HMAC-SHA512, keyed by the
 * store's IPN secret, of the notification body with its keys sorted, serialised as
 * JavaScript's `JSON.stringify` does. The reference gives two spellings of "sorted":
 *
 * - **recursive** — every object at every depth sorted by key (the current reference's
 *   `sortObject`). Bodies with a nested `fee` object depend on it;
 * - **top-level replacer** — `JSON.stringify(params, Object.keys(params).sort())`, the
 *   reference's original Node example, whose key list also filters nested objects.
 *
 * Both are accepted. Each needs the secret to produce, so accepting the second widens
 * nothing an attacker can do; refusing it would drop real notifications signed that way.
 * The body is the PARSED JSON — the serialisation is re-derived from it, exactly as the
 * provider derives it from its own object, so the raw bytes' whitespace never matters.
 *
 * The comparison is constant-time over equal-length digests. A header that is not 128 hex
 * characters, a missing header, a body that is not a JSON object, or an empty secret is
 * refused before any HMAC is computed. Nothing here logs, and nothing returns why.
 */

const SIGNATURE_TEXT = /^[0-9a-fA-F]{128}$/u;

/** Every object at every depth with its keys sorted; arrays keep their order. */
export function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** The serialisations the provider may have signed, in the order they are tried. */
export function canonicalIpnBodies(body: Record<string, unknown>): readonly string[] {
  const recursive = JSON.stringify(sortDeep(body));
  const replacer = JSON.stringify(body, Object.keys(body).sort());
  return recursive === replacer ? [recursive] : [recursive, replacer];
}

export function ipnSignatureOf(secret: string, canonical: string): string {
  return createHmac('sha512', secret).update(canonical, 'utf8').digest('hex');
}

/** Whether `signature` is the IPN secret's signature of `body`. Never throws. */
export function verifyIpnSignature(
  secret: string,
  body: unknown,
  signature: string | undefined,
): boolean {
  if (secret.length === 0) return false;
  if (typeof signature !== 'string' || !SIGNATURE_TEXT.test(signature)) return false;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const received = Buffer.from(signature.toLowerCase(), 'hex');
  let matched = false;
  for (const canonical of canonicalIpnBodies(body as Record<string, unknown>)) {
    const expected = Buffer.from(ipnSignatureOf(secret, canonical), 'hex');
    // Both are 64 bytes by construction; every candidate is compared, none short-circuits.
    if (expected.length === received.length && timingSafeEqual(expected, received)) {
      matched = true;
    }
  }
  return matched;
}
