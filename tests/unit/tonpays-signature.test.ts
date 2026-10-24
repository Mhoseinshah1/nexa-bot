import { describe, expect, it } from 'vitest';
import {
  tonpaysSignatureOf,
  verifyTonPaysWebhook,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-signature';

/**
 * `X-TonPays-Signature: t=<unix seconds>,v1=<hex>` (TonPays support, 2026-10-24):
 * `v1 = hex(HMAC-SHA256(secret, "{t}." + raw_body))`, |now - t| <= 300 s. The scheme is the
 * shared core's; this pins TonPays' wrapper (its tolerance, its names) and its fixed vector.
 */
const SECRET = 'tp_whsec_synthetic_secret_value_0123456789';
const NOW = new Date('2026-10-24T10:21:50.000Z');
const T = Math.floor(NOW.getTime() / 1000);
const RAW = Buffer.from(
  '{"invoice_id":"INV1","status":"completed","delivery_id":"INV1:completed:1727200000","description":"پرداخت موفق ۱۲۳"}',
  'utf8',
);
const header = (t: number, raw: Uint8Array = RAW, secret = SECRET) =>
  `t=${String(t)},v1=${tonpaysSignatureOf(secret, String(t), raw)}`;

describe('the TonPays webhook signature', () => {
  it('is HMAC-SHA256 of "t.body" keyed by the secret, hex (a fixed vector)', () => {
    // printf '1727605304.{"a":1}' | openssl dgst -sha256 -hmac 'whsec_test' -hex
    expect(tonpaysSignatureOf('whsec_test', '1727605304', Buffer.from('{"a":1}'))).toBe(
      '455fa8919840e5944747e7a805c06f7f2e55ca3d95af7c09492ef937cb78bffe',
    );
  });

  it('verifies a valid signature over raw bytes holding unescaped Persian', () => {
    expect(verifyTonPaysWebhook(SECRET, RAW, header(T), NOW)).toBe(true);
  });

  it('refuses the same JSON re-serialised with spaces or \\u escapes under the original signature', () => {
    const original = header(T);
    const text = RAW.toString('utf8');
    const spaced = Buffer.from(JSON.stringify(JSON.parse(text), null, 1));
    const escaped = Buffer.from(
      text.replace('پرداخت', '\\u067e\\u0631\\u062f\\u0627\\u062e\\u062a'),
    );
    expect(verifyTonPaysWebhook(SECRET, spaced, original, NOW)).toBe(false);
    expect(verifyTonPaysWebhook(SECRET, escaped, original, NOW)).toBe(false);
  });

  it('allows 300 s of skew in either direction and refuses 301 s', () => {
    expect(verifyTonPaysWebhook(SECRET, RAW, header(T - 299), NOW)).toBe(true);
    expect(verifyTonPaysWebhook(SECRET, RAW, header(T + 299), NOW)).toBe(true);
    expect(verifyTonPaysWebhook(SECRET, RAW, header(T - 301), NOW)).toBe(false);
    expect(verifyTonPaysWebhook(SECRET, RAW, header(T + 301), NOW)).toBe(false);
  });

  it('refuses bad hex, a wrong length, a missing v1, a missing t and an absent header', () => {
    expect(verifyTonPaysWebhook(SECRET, RAW, `t=${String(T)},v1=${'z'.repeat(64)}`, NOW)).toBe(
      false,
    );
    expect(verifyTonPaysWebhook(SECRET, RAW, `t=${String(T)},v1=${'a'.repeat(63)}`, NOW)).toBe(
      false,
    );
    expect(verifyTonPaysWebhook(SECRET, RAW, `t=${String(T)}`, NOW)).toBe(false);
    expect(verifyTonPaysWebhook(SECRET, RAW, `v1=${'a'.repeat(64)}`, NOW)).toBe(false);
    expect(verifyTonPaysWebhook(SECRET, RAW, undefined, NOW)).toBe(false);
    expect(verifyTonPaysWebhook(SECRET, null, header(T), NOW)).toBe(false);
    expect(verifyTonPaysWebhook('', RAW, header(T), NOW)).toBe(false);
  });

  it('tolerates extra comma-separated keys and refuses a wrong secret', () => {
    expect(verifyTonPaysWebhook(SECRET, RAW, `${header(T)},v0=whatever`, NOW)).toBe(true);
    expect(verifyTonPaysWebhook(SECRET, RAW, header(T, RAW, 'other-secret'), NOW)).toBe(false);
  });
});
