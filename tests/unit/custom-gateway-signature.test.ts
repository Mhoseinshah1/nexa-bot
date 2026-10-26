import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  bridgeSignatureOf,
  sha256Hex,
  signNexaRequest,
  verifyBridgeSignature,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/custom-gateway-signature';

/**
 * The custom gateway's signatures (`docs/protocols/custom-gateway.md` §4, §5), recomputed here
 * from the document's own description with `node:crypto` — never with the code under test — so
 * the strings a bridge must build are pinned, not merely self-consistent.
 */

const SECRET = 'cgw_secret_for_tests_only_0123456789abcdef';
const NOW = new Date('2026-10-26T09:41:00Z');
const T = String(Math.floor(NOW.getTime() / 1000));
const BODY = Buffer.from('{"invoice_id":"cg_X","status":"PAID"}', 'utf8');
const hmac = (secret: string, text: string | Buffer) =>
  createHmac('sha256', secret).update(text).digest('hex');

describe('Nexa → bridge (§4)', () => {
  it('signs NEXA-CGW-V1-REQUEST, the method, the protocol path, t, nonce and the body hash', () => {
    const body = '{"a":1}';
    const text = [
      'NEXA-CGW-V1-REQUEST',
      'POST',
      '/v1/payments',
      '1793007660',
      'ff'.repeat(16),
      createHash('sha256').update(body).digest('hex'),
    ].join('\n');
    expect(
      signNexaRequest(SECRET, {
        method: 'POST',
        path: '/v1/payments',
        timestamp: '1793007660',
        nonce: 'ff'.repeat(16),
        body,
      }),
    ).toBe(`v1=${hmac(SECRET, text)}`);
  });

  it('a GET hashes the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('bridge → Nexa (§5)', () => {
  const callbackHeader = (secret = SECRET, t = T, body = BODY) =>
    `t=${t},v1=${hmac(secret, Buffer.concat([Buffer.from(`NEXA-CGW-V1-CALLBACK\n${t}\n`), body]))}`;
  const responseHeader = (nonce: string, secret = SECRET, t = T, body = BODY) =>
    `t=${t},v1=${hmac(
      secret,
      Buffer.concat([Buffer.from(`NEXA-CGW-V1-RESPONSE\n${t}\n${nonce}\n`), body]),
    )}`;

  it('verifies a callback signed over its prefix, t and the raw bytes', () => {
    expect(verifyBridgeSignature(SECRET, 'callback', BODY, callbackHeader(), NOW)).toBe(true);
    expect(bridgeSignatureOf(SECRET, 'callback', T, BODY)).toBe(callbackHeader().split(',v1=')[1]);
  });

  it('refuses another secret, another body, a missing header and an empty secret', () => {
    expect(
      verifyBridgeSignature(SECRET, 'callback', BODY, callbackHeader('other-secret'), NOW),
    ).toBe(false);
    expect(
      verifyBridgeSignature(
        SECRET,
        'callback',
        Buffer.from(`${BODY.toString()} `),
        callbackHeader(),
        NOW,
      ),
    ).toBe(false);
    expect(verifyBridgeSignature(SECRET, 'callback', BODY, undefined, NOW)).toBe(false);
    expect(verifyBridgeSignature('', 'callback', BODY, callbackHeader(''), NOW)).toBe(false);
    expect(verifyBridgeSignature(SECRET, 'callback', null, callbackHeader(), NOW)).toBe(false);
  });

  it('refuses a t more than 300 s off in either direction, and accepts 300 exactly', () => {
    const at = (offset: number) => String(Number(T) + offset);
    expect(
      verifyBridgeSignature(SECRET, 'callback', BODY, callbackHeader(SECRET, at(300)), NOW),
    ).toBe(true);
    expect(
      verifyBridgeSignature(SECRET, 'callback', BODY, callbackHeader(SECRET, at(-300)), NOW),
    ).toBe(true);
    expect(
      verifyBridgeSignature(SECRET, 'callback', BODY, callbackHeader(SECRET, at(301)), NOW),
    ).toBe(false);
    expect(
      verifyBridgeSignature(SECRET, 'callback', BODY, callbackHeader(SECRET, at(-301)), NOW),
    ).toBe(false);
  });

  it('refuses two t values, and accepts rotation: ANY v1 that verifies, wherever it stands', () => {
    const good = callbackHeader().split(',')[1] as string;
    expect(verifyBridgeSignature(SECRET, 'callback', BODY, `t=${T},t=${T},${good}`, NOW)).toBe(
      false,
    );
    const stale = `v1=${'0'.repeat(64)}`;
    expect(verifyBridgeSignature(SECRET, 'callback', BODY, `t=${T},${good},${stale}`, NOW)).toBe(
      true,
    );
    expect(verifyBridgeSignature(SECRET, 'callback', BODY, `t=${T},${stale},${good}`, NOW)).toBe(
      true,
    );
    expect(verifyBridgeSignature(SECRET, 'callback', BODY, `t=${T},v0=abc,${good}`, NOW)).toBe(
      true,
    );
  });

  it('domain separation: a callback signature is not a response signature, nor the reverse', () => {
    const nonce = 'ab'.repeat(16);
    expect(verifyBridgeSignature(SECRET, 'response', BODY, callbackHeader(), NOW, nonce)).toBe(
      false,
    );
    expect(verifyBridgeSignature(SECRET, 'callback', BODY, responseHeader(nonce), NOW)).toBe(false);
    expect(verifyBridgeSignature(SECRET, 'response', BODY, responseHeader(nonce), NOW, nonce)).toBe(
      true,
    );
  });

  it('a response is bound to its request’s nonce: a recorded answer does not answer another request', () => {
    const header = responseHeader('ab'.repeat(16));
    expect(verifyBridgeSignature(SECRET, 'response', BODY, header, NOW, 'cd'.repeat(16))).toBe(
      false,
    );
    expect(verifyBridgeSignature(SECRET, 'response', BODY, header, NOW, null)).toBe(false);
    // Even a response signed over an EMPTY nonce line never verifies without the request's nonce.
    const emptyNonce = `t=${T},v1=${hmac(
      SECRET,
      Buffer.concat([Buffer.from(`NEXA-CGW-V1-RESPONSE\n${T}\n\n`), BODY]),
    )}`;
    expect(verifyBridgeSignature(SECRET, 'response', BODY, emptyNonce, NOW, null)).toBe(false);
    expect(verifyBridgeSignature(SECRET, 'response', BODY, emptyNonce, NOW, '')).toBe(false);
  });
});
