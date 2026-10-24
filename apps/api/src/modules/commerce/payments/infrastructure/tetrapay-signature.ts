import { TETRAPAY_WEBHOOK_TOLERANCE_SECONDS } from '@nexa/contracts';
import {
  parseTimestampedSignature,
  timestampedSignatureOf,
  verifyTimestampedWebhook,
  type ParsedTimestampedSignature,
} from './timestamped-webhook-signature.js';

/**
 * The TetraPay webhook signature (`docs/tetrapay-gateway-audit.md` §5.6): `X-TetraPay-Signature:
 * t=<unix>,v1=<hex>` over the raw bytes, keyed by the endpoint's `whsec_` secret exactly as the
 * operator copied it (documentation §7). The scheme itself lives in
 * `timestamped-webhook-signature.ts`, shared with TonPays; this is TetraPay's 300 s wrapper.
 */
export type ParsedTetraPaySignature = ParsedTimestampedSignature;
export const parseTetraPaySignature = parseTimestampedSignature;
export const tetrapaySignatureOf = timestampedSignatureOf;

/** Whether `header` is the secret's signature of `rawBody`, fresh at `now`. Never throws. */
export function verifyTetraPayWebhook(
  secret: string,
  rawBody: Uint8Array | null,
  header: string | undefined,
  now: Date,
  toleranceSeconds: number = TETRAPAY_WEBHOOK_TOLERANCE_SECONDS,
): boolean {
  return verifyTimestampedWebhook(secret, rawBody, header, now, toleranceSeconds);
}
