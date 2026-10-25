import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MINIAPP_INIT_DATA_CLOCK_SKEW_SECONDS } from '@nexa/contracts';
import {
  dataCheckString,
  hashesMatch,
  parseInitData,
  verifyInitData,
} from '../../apps/api/src/modules/commerce/miniapp/domain/init-data';
import {
  checkReceiptImage,
  sniffReceiptImage,
} from '../../apps/api/src/modules/commerce/miniapp/domain/receipt-image';

/**
 * Round 9, C5: Telegram Mini App `initData` verification, against Telegram's own algorithm
 * written out independently here (secret = HMAC_SHA256("WebAppData", token); hash =
 * HMAC_SHA256(secret, sorted data-check-string)) — so a verifier that agreed only with a
 * signer from the same file would fail.
 */

const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmn';
const OTHER_TOKEN = '987654321:AAAnotherBotsTokenForTests_zyxwvuts';
const NOW = new Date('2026-10-25T12:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);

/** Telegram's signer, independently: what the client would receive. */
function sign(fields: Record<string, string>, token = TOKEN): string {
  const check = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  const params = new URLSearchParams({ ...fields, hash });
  return params.toString();
}

const user = JSON.stringify({
  id: 4242,
  first_name: 'Ali',
  username: 'ali_test',
  language_code: 'fa',
});
const launch = (overrides: Record<string, string> = {}, token = TOKEN) =>
  sign(
    {
      query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
      user,
      auth_date: String(NOW_S - 30),
      signature: 'c2lnbmF0dXJl',
      ...overrides,
    },
    token,
  );

const verify = (raw: string, token = TOKEN, maxAgeSeconds = 3600) =>
  verifyInitData({ raw, botToken: token, now: NOW, maxAgeSeconds });

describe('verifyInitData', () => {
  it('accepts a launch Telegram signed with this bot token, and reads the user from it', () => {
    const verdict = verify(launch());
    expect(verdict.outcome).toBe('VALID');
    if (verdict.outcome !== 'VALID') return;
    expect(verdict.user.id).toBe(4242);
    expect(verdict.from['username']).toBe('ali_test');
    expect(verdict.authDate.getTime()).toBe((NOW_S - 30) * 1000);
    expect(verdict.hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('refuses a tampered field: the hash no longer covers what was sent', () => {
    const raw = launch().replace('ali_test', 'ali_tast');
    expect(verify(raw).outcome).toBe('INVALID');
  });

  it('refuses a tampered hash, and one hex digit is enough', () => {
    const raw = launch();
    const params = new URLSearchParams(raw);
    const hash = params.get('hash') as string;
    params.set('hash', `${hash.slice(0, -1)}${hash.endsWith('0') ? '1' : '0'}`);
    expect(verify(params.toString()).outcome).toBe('INVALID');
  });

  it('refuses a launch of ANOTHER bot: initData names no bot, and the token is what proves one', () => {
    expect(verify(launch({}, OTHER_TOKEN)).outcome).toBe('INVALID');
    expect(verify(launch(), OTHER_TOKEN).outcome).toBe('INVALID');
  });

  it('refuses a stale auth_date, at the window and not one second inside it', () => {
    expect(verify(launch({ auth_date: String(NOW_S - 3600) })).outcome).toBe('VALID');
    expect(verify(launch({ auth_date: String(NOW_S - 3601) })).outcome).toBe('EXPIRED');
    // The setting is what bounds it.
    expect(verify(launch({ auth_date: String(NOW_S - 120) }), TOKEN, 60).outcome).toBe('EXPIRED');
  });

  it('refuses an auth_date in the future beyond the clock skew', () => {
    const skew = MINIAPP_INIT_DATA_CLOCK_SKEW_SECONDS;
    expect(verify(launch({ auth_date: String(NOW_S + skew) })).outcome).toBe('VALID');
    expect(verify(launch({ auth_date: String(NOW_S + skew + 1) })).outcome).toBe('EXPIRED');
  });

  it('refuses a missing hash, a malformed hash, a repeated field and a malformed query', () => {
    const raw = launch();
    const noHash = new URLSearchParams(raw);
    noHash.delete('hash');
    expect(verify(noHash.toString()).outcome).toBe('INVALID');
    const upper = new URLSearchParams(raw);
    upper.set('hash', (upper.get('hash') as string).toUpperCase());
    expect(verify(upper.toString()).outcome).toBe('INVALID');
    expect(verify(`${raw}&user=${encodeURIComponent(user)}`).outcome).toBe('INVALID');
    expect(verify('%E0%A4%A').outcome).toBe('INVALID');
    expect(verify('').outcome).toBe('INVALID');
  });

  it('refuses a signed launch whose user is not a person: no user, a bot, a non-numeric id', () => {
    expect(verify(sign({ auth_date: String(NOW_S) })).outcome).toBe('INVALID');
    expect(
      verify(launch({ user: JSON.stringify({ id: 1, is_bot: true, first_name: 'b' }) })).outcome,
    ).toBe('INVALID');
    expect(verify(launch({ user: JSON.stringify({ id: '4242' }) })).outcome).toBe('INVALID');
    expect(verify(launch({ user: '{not json' })).outcome).toBe('INVALID');
  });

  it('builds the data-check-string Telegram documents: sorted, hash excluded, newline-joined', () => {
    const fields = parseInitData('b=2&hash=x&a=1&c=3');
    expect(fields).not.toBeNull();
    expect(dataCheckString(fields as ReadonlyMap<string, string>)).toBe('a=1\nb=2\nc=3');
  });

  it('compares hashes in full: equal only when every byte is equal', () => {
    const a = 'a'.repeat(64);
    expect(hashesMatch(a, a)).toBe(true);
    expect(hashesMatch(a, `${'a'.repeat(63)}b`)).toBe(false);
    expect(hashesMatch(a, 'a'.repeat(62))).toBe(false);
  });
});

describe('receipt image check', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0]);
  const pdf = new TextEncoder().encode('%PDF-1.7 fake');

  it('knows the three types by their magic numbers and nothing else', () => {
    expect(sniffReceiptImage(jpeg)).toBe('image/jpeg');
    expect(sniffReceiptImage(png)).toBe('image/png');
    expect(sniffReceiptImage(webp)).toBe('image/webp');
    expect(sniffReceiptImage(pdf)).toBeNull();
    expect(sniffReceiptImage(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  it('accepts a declared type the bytes agree with', () => {
    expect(checkReceiptImage({ bytes: png, declaredMimeType: 'image/png', maxBytes: 100 })).toEqual(
      {
        outcome: 'ACCEPTED',
        mimeType: 'image/png',
      },
    );
  });

  it('refuses a spoofed type: a PDF declared as a JPEG, a PNG declared as a JPEG', () => {
    expect(
      checkReceiptImage({ bytes: pdf, declaredMimeType: 'image/jpeg', maxBytes: 100 }),
    ).toEqual({
      outcome: 'REFUSED',
      reason: 'NOT_AN_IMAGE',
    });
    expect(
      checkReceiptImage({ bytes: png, declaredMimeType: 'image/jpeg', maxBytes: 100 }),
    ).toEqual({
      outcome: 'REFUSED',
      reason: 'TYPE_MISMATCH',
    });
  });

  it('refuses an empty file and one over the cap, at the cap and not a byte inside it', () => {
    expect(
      checkReceiptImage({ bytes: new Uint8Array(), declaredMimeType: 'image/png', maxBytes: 10 })
        .outcome,
    ).toBe('REFUSED');
    expect(
      checkReceiptImage({ bytes: png, declaredMimeType: 'image/png', maxBytes: png.length })
        .outcome,
    ).toBe('ACCEPTED');
    expect(
      checkReceiptImage({ bytes: png, declaredMimeType: 'image/png', maxBytes: png.length - 1 }),
    ).toEqual({
      outcome: 'REFUSED',
      reason: 'TOO_LARGE',
    });
  });
});
