import { TONPAYS_WEBHOOK_TOLERANCE_SECONDS } from '@nexa/contracts';
import {
  timestampedSignatureOf,
  verifyTimestampedWebhook,
} from './timestamped-webhook-signature.js';

/**
 * The TonPays webhook signature (`docs/tonpays-gateway-audit.md` §5.6, from TonPays support,
 * 2026-10-24): `X-TonPays-Signature: t=<unix seconds>,v1=<hex>`, `v1 = hex(HMAC-SHA256(secret,
 * "{t}." + raw_body))`. Identical to TetraPay's scheme, so this is a thin wrapper over the same
 * core. `t` is the SEND time of the attempt (a retry is re-signed with a fresh `t`), so the 300 s
 * window bounds clock skew only; the dedupe key is `X-TonPays-Delivery-Id`, never `t`.
 */
export const tonpaysSignatureOf = timestampedSignatureOf;

export function verifyTonPaysWebhook(
  secret: string,
  rawBody: Uint8Array | null,
  header: string | undefined,
  now: Date,
  toleranceSeconds: number = TONPAYS_WEBHOOK_TOLERANCE_SECONDS,
): boolean {
  return verifyTimestampedWebhook(secret, rawBody, header, now, toleranceSeconds);
}
