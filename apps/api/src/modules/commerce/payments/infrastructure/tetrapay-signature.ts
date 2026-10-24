import { createHmac, timingSafeEqual } from 'node:crypto';
import { TETRAPAY_WEBHOOK_TOLERANCE_SECONDS } from '@nexa/contracts';

/**
 * The TetraPay webhook signature (`docs/tetrapay-gateway-audit.md` §5.6).
 *
 * Documented: `X-TetraPay-Signature: t=<unix>,v1=<hex>`, where `v1` is the lowercase hex
 * HMAC-SHA256, keyed by the endpoint's `whsec_` secret, of `t + "." + raw_body` — the body's
 * RAW BYTES, exactly as received. A body re-serialised from parsed JSON is not the bytes that
 * were signed, which is why the webhook route keeps the raw buffer (`bootstrap.ts`).
 *
 * Refused, all before any field of the body is read:
 *
 * - a missing or malformed header, a `t` that is not a plain integer of seconds, a header
 *   with more than one `t` (ambiguous which was signed), and no `v1` that is 64 hex digits;
 * - a `t` more than 300 seconds from now, in EITHER direction (a replayed old delivery, or a
 *   clock far ahead);
 * - an empty secret, and a body that is not bytes.
 *
 * The comparison is constant-time over equal-length digests, and EVERY `v1` is compared with
 * none short-circuiting. The key is the webhook secret exactly as the operator copied it,
 * `whsec_` prefix included (documentation §7: `key = webhook_secret (whsec_...)`). Nothing here
 * logs and nothing returns why.
 */

const V1_TEXT = /^[0-9a-fA-F]{64}$/u;
const T_TEXT = /^[0-9]{1,12}$/u;

export interface ParsedTetraPaySignature {
  /** `t` exactly as the header spelled it: it is part of the signed text. */
  readonly t: string;
  readonly v1: readonly string[];
}

export function parseTetraPaySignature(header: string | undefined): ParsedTetraPaySignature | null {
  if (typeof header !== 'string' || header.length === 0 || header.length > 512) return null;
  let t: string | null = null;
  const v1: string[] = [];
  for (const segment of header.split(',')) {
    const at = segment.indexOf('=');
    if (at <= 0) return null;
    const key = segment.slice(0, at).trim();
    const value = segment.slice(at + 1).trim();
    if (key === 't') {
      if (t !== null) return null;
      t = value;
    } else if (key === 'v1') {
      v1.push(value);
    }
    // An unknown scheme (`v0=…`) is ignored: only `v1` is ever compared.
  }
  if (t === null || !T_TEXT.test(t)) return null;
  const valid = v1.filter((one) => V1_TEXT.test(one));
  return valid.length === 0 ? null : { t, v1: valid };
}

/** The signature a secret makes of `t` and the raw body. Used by the verifier and by tests. */
export function tetrapaySignatureOf(secret: string, t: string, rawBody: Uint8Array): string {
  return createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${t}.`, 'utf8'), Buffer.from(rawBody)]))
    .digest('hex');
}

/** Whether `header` is the secret's signature of `rawBody`, fresh at `now`. Never throws. */
export function verifyTetraPayWebhook(
  secret: string,
  rawBody: Uint8Array | null,
  header: string | undefined,
  now: Date,
  toleranceSeconds: number = TETRAPAY_WEBHOOK_TOLERANCE_SECONDS,
): boolean {
  if (secret.length === 0 || rawBody === null) return false;
  const parsed = parseTetraPaySignature(header);
  if (parsed === null) return false;
  const skewSeconds = Math.abs(Math.floor(now.getTime() / 1000) - Number(parsed.t));
  if (!Number.isFinite(skewSeconds) || skewSeconds > toleranceSeconds) return false;
  let matched = false;
  const expected = Buffer.from(tetrapaySignatureOf(secret, parsed.t, rawBody), 'hex');
  for (const candidate of parsed.v1) {
    const received = Buffer.from(candidate, 'hex');
    // Both are 32 bytes by construction; every candidate is compared, none short-circuits.
    if (expected.length === received.length && timingSafeEqual(expected, received)) {
      matched = true;
    }
  }
  return matched;
}
