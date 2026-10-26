import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { CUSTOM_GATEWAY_SIGNATURE_TOLERANCE_SECONDS } from '@nexa/contracts';
import { customBridgeSignedPrefix, customRequestStringToSign } from '../domain/custom-gateway.js';
import { parseTimestampedSignature } from './timestamped-webhook-signature.js';

/**
 * The custom gateway's signatures (`docs/protocols/custom-gateway.md` §4, §5).
 *
 * ONE per-route secret (lead decision, the owner's "a per-gateway secret"), three directions,
 * each with its own signed-string prefix so a signature made for one can never verify as
 * another:
 *
 * - Nexa → bridge: `X-Nexa-Signature: v1=<hex>` over
 *   `NEXA-CGW-V1-REQUEST\nMETHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256`;
 * - bridge → Nexa, a 2xx RESPONSE: `X-Nexa-Bridge-Signature: t=<unix>,v1=<hex>` over
 *   `NEXA-CGW-V1-RESPONSE\n<t>\n<the request's nonce>\n` + the raw body bytes;
 * - bridge → Nexa, a CALLBACK: the same header over `NEXA-CGW-V1-CALLBACK\n<t>\n` + raw bytes.
 *
 * The bridge's header is parsed by the shared timestamped core (`t=`, any number of `v1=` for
 * rotation, one `t` only, unknown keys ignored); the comparison is constant-time and EVERY `v1`
 * is compared, none short-circuiting; `t` must be within 300 s of now, either way, and is never
 * a dedupe key (that is the callback's `delivery_id`). Nothing here logs or says why.
 */

/** Lower-case hex SHA-256 of bytes (of the empty string for no body). */
export function sha256Hex(body: Uint8Array | string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** The `X-Nexa-Signature` value for one request Nexa sends. */
export function signNexaRequest(
  secret: string,
  input: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly timestamp: string;
    readonly nonce: string;
    /** The EXACT bytes sent; '' for no body. */
    readonly body: string;
  },
): string {
  const text = customRequestStringToSign({
    method: input.method,
    path: input.path,
    timestamp: input.timestamp,
    nonce: input.nonce,
    bodySha256: sha256Hex(input.body),
  });
  return `v1=${createHmac('sha256', secret).update(text, 'utf8').digest('hex')}`;
}

/** The hex HMAC a bridge makes of a response or callback. Used by the verifier and by tests. */
export function bridgeSignatureOf(
  secret: string,
  direction: 'response' | 'callback',
  t: string,
  rawBody: Uint8Array,
  requestNonce: string | null = null,
): string {
  return createHmac('sha256', secret)
    .update(
      Buffer.concat([
        Buffer.from(customBridgeSignedPrefix(direction, t, requestNonce), 'utf8'),
        Buffer.from(rawBody),
      ]),
    )
    .digest('hex');
}

/**
 * Whether `header` is the secret's signature of `rawBody` for `direction`, fresh at `now`.
 * Never throws. An empty secret, no bytes or a malformed header verify nothing.
 */
export function verifyBridgeSignature(
  secret: string,
  direction: 'response' | 'callback',
  rawBody: Uint8Array | null,
  header: string | undefined,
  now: Date,
  requestNonce: string | null = null,
  toleranceSeconds: number = CUSTOM_GATEWAY_SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  if (secret.length === 0 || rawBody === null) return false;
  if (direction === 'response' && (requestNonce === null || requestNonce === '')) return false;
  const parsed = parseTimestampedSignature(header);
  if (parsed === null) return false;
  const skewSeconds = Math.abs(Math.floor(now.getTime() / 1000) - Number(parsed.t));
  if (!Number.isFinite(skewSeconds) || skewSeconds > toleranceSeconds) return false;
  const expected = Buffer.from(
    bridgeSignatureOf(secret, direction, parsed.t, rawBody, requestNonce),
    'hex',
  );
  let matched = false;
  for (const candidate of parsed.v1) {
    const received = Buffer.from(candidate, 'hex');
    // Both are 32 bytes by construction; every candidate is compared, none short-circuits.
    if (expected.length === received.length && timingSafeEqual(expected, received)) {
      matched = true;
    }
  }
  return matched;
}
