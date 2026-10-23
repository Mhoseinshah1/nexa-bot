import { describe, expect, it } from 'vitest';
import {
  parseTetraPaySignature,
  tetrapaySignatureOf,
  verifyTetraPayWebhook,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/tetrapay-signature';

/**
 * The webhook signature (documentation §7): `X-TetraPay-Signature: t=<unix>,v1=<hex>`, with
 * `v1 = hex(HMAC-SHA256(key = whsec_ secret, message = t + "." + raw_body))`, constant-time,
 * and |now - t| <= 300 s.
 */

const SECRET = 'whsec_synthetic_secret_value_0123456789';
const NOW = new Date('2026-09-29T10:21:50.000Z');
const T = String(Math.floor(NOW.getTime() / 1000));
// The documentation's example body, byte for byte, with its odd spacing: only raw bytes verify.
const RAW = Buffer.from(
  '{\n"event": "payment.paid",\n"event_id": "6f1c2a9e-3b7d-4e21-9a0c-5d8e4f7b1a23",\n"token": "q9Xk2VbR7tLmN4pA8sWcYg",\n"status": "paid",\n"order_id": "ORD-10482",\n"amount": "12500000"\n}',
  'utf8',
);
const header = (t: string, secret = SECRET, raw: Uint8Array = RAW) =>
  `t=${t},v1=${tetrapaySignatureOf(secret, t, raw)}`;

describe('the TetraPay webhook signature', () => {
  it('verifies a valid signature over the raw bytes', () => {
    expect(verifyTetraPayWebhook(SECRET, RAW, header(T), NOW)).toBe(true);
  });

  it('is HMAC-SHA256 of "t.body" with the secret as the key, hex', () => {
    // Independently derived with `openssl dgst -sha256 -hmac`: a fixed vector, not our own function.
    // printf '1727605304.{"a":1}' | openssl dgst -sha256 -hmac 'whsec_test' -hex
    const vector = tetrapaySignatureOf('whsec_test', '1727605304', Buffer.from('{"a":1}'));
    expect(vector).toBe('455fa8919840e5944747e7a805c06f7f2e55ca3d95af7c09492ef937cb78bffe');
  });

  it('rejects a body changed by one byte, and a body re-serialised from parsed JSON', () => {
    const tampered = Buffer.from(RAW.toString('utf8').replace('12500000', '12500001'));
    expect(verifyTetraPayWebhook(SECRET, tampered, header(T), NOW)).toBe(false);
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(RAW.toString('utf8'))));
    expect(verifyTetraPayWebhook(SECRET, reserialised, header(T), NOW)).toBe(false);
  });

  it('rejects the wrong secret, an empty secret, and no raw body at all', () => {
    expect(verifyTetraPayWebhook('whsec_other', RAW, header(T), NOW)).toBe(false);
    expect(verifyTetraPayWebhook('', RAW, header(T, ''), NOW)).toBe(false);
    expect(verifyTetraPayWebhook(SECRET, null, header(T), NOW)).toBe(false);
  });

  it('is stale beyond 300 seconds in either direction, and fresh at exactly 300', () => {
    const at = (seconds: number) => String(Math.floor(NOW.getTime() / 1000) + seconds);
    expect(verifyTetraPayWebhook(SECRET, RAW, header(at(-300)), NOW)).toBe(true);
    expect(verifyTetraPayWebhook(SECRET, RAW, header(at(300)), NOW)).toBe(true);
    expect(verifyTetraPayWebhook(SECRET, RAW, header(at(-301)), NOW)).toBe(false);
    expect(verifyTetraPayWebhook(SECRET, RAW, header(at(301)), NOW)).toBe(false);
  });

  it('does not accept a valid signature under a different t (t is part of the signed text)', () => {
    const v1 = tetrapaySignatureOf(SECRET, T, RAW);
    const other = String(Number(T) + 1);
    expect(verifyTetraPayWebhook(SECRET, RAW, `t=${other},v1=${v1}`, NOW)).toBe(false);
  });

  it('rejects malformed headers', () => {
    const v1 = tetrapaySignatureOf(SECRET, T, RAW);
    for (const bad of [
      undefined,
      '',
      `v1=${v1}`,
      `t=${T}`,
      `t=${T},v1=zz`,
      `t=abc,v1=${v1}`,
      `t=${T},t=${T},v1=${v1}`,
      `t=${T},v1=${v1.slice(0, 62)}`,
      `t=${T} v1=${v1}`,
    ]) {
      expect(verifyTetraPayWebhook(SECRET, RAW, bad, NOW)).toBe(false);
    }
  });

  it('accepts any one of several v1 values (a rotation) and ignores other schemes', () => {
    const good = tetrapaySignatureOf(SECRET, T, RAW);
    const stale = tetrapaySignatureOf('whsec_old', T, RAW);
    expect(parseTetraPaySignature(`t=${T},v0=ignored,v1=${stale},v1=${good}`)?.v1).toHaveLength(2);
    expect(verifyTetraPayWebhook(SECRET, RAW, `t=${T},v1=${stale},v1=${good}`, NOW)).toBe(true);
  });
});
