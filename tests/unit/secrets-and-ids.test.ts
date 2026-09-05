import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CALLBACK_REF_LENGTH, callbackRefSchema, uuidV7Schema } from '@nexa/contracts';
import {
  AesGcmSecretCipher,
  canonicalAad,
} from '../../apps/api/src/infrastructure/crypto/secret-cipher';
import type { SecretKeyring } from '../../apps/api/src/infrastructure/crypto/keyring';
import { Uuidv7IdGenerator } from '../../apps/api/src/infrastructure/ids';
import {
  isSensitiveKey,
  normaliseKey,
  redactRecord,
  redactSecrets,
} from '../../apps/api/src/infrastructure/redaction';

const KEK_A = Buffer.alloc(32, 1).toString('base64');
const KEK_B = Buffer.alloc(32, 2).toString('base64');

const TENANT_A = '0192f000-0000-7000-8000-00000000000a';
const TENANT_B = '0192f000-0000-7000-8000-00000000000b';
const BOT_A = '0192f000-0000-7000-8000-0000000000a1';
const BOT_B = '0192f000-0000-7000-8000-0000000000b1';

const ring = (entries: Record<string, string>): SecretKeyring => ({
  activeKeyId: Object.keys(entries)[0]!,
  keys: new Map(Object.entries(entries).map(([id, key]) => [id, Buffer.from(key, 'base64')])),
  format: 'canonical',
});

const ctx = () => ({ purpose: 'bot_instance.token', tenantId: TENANT_A, entityId: BOT_A }) as const;

describe('the v2 envelope', () => {
  const keyring = ring({ 'key-1': KEK_A });
  const cipher = new AesGcmSecretCipher(keyring, true);

  const context = {
    purpose: 'bot_instance.token',
    tenantId: TENANT_A,
    entityId: BOT_A,
  } as const;

  /** Any refusal, without asking the cipher WHY — see `authFailed`. */
  const refused = (run: () => unknown, code: string): void => {
    try {
      run();
    } catch (error) {
      expect((error as { code?: string }).code).toBe(code);
      // Whatever the reason, the message must not carry the value or the key.
      expect(JSON.stringify(error)).not.toContain('123456:AAH-bot-token');
      return;
    }
    throw new Error('the value was accepted');
  };

  it('round-trips under the context it was encrypted for', () => {
    const secret = cipher.encrypt('123456:AAH-bot-token', context);
    expect(cipher.decrypt(secret, context)).toBe('123456:AAH-bot-token');
    expect(secret.keyId).toBe('key-1');
    expect(secret.ciphertext.startsWith('v2.key-1.')).toBe(true);
  });

  it('never stores the plaintext in the ciphertext', () => {
    const secret = cipher.encrypt('123456:AAH-bot-token', context);
    expect(secret.ciphertext).not.toContain('AAH-bot-token');
  });

  it('produces a different ciphertext each time for the same plaintext', () => {
    const a = cipher.encrypt('same', context);
    const b = cipher.encrypt('same', context);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  // --- Transplant -----------------------------------------------------------
  //
  // The three shapes of the attack v1 had no answer to. Each asserts only that
  // the value is REFUSED: none of them asks the cipher which field was wrong,
  // because a cipher that could answer that would be an oracle to walk one
  // field at a time.

  it('refuses a ciphertext moved to another tenant', () => {
    const secret = cipher.encrypt('123456:AAH-bot-token', context);
    refused(
      () => cipher.decrypt(secret, { ...context, tenantId: TENANT_B }),
      'platform.secret_auth_failed',
    );
  });

  it('refuses a ciphertext moved to another row', () => {
    const secret = cipher.encrypt('123456:AAH-bot-token', context);
    refused(
      () => cipher.decrypt(secret, { ...context, entityId: BOT_B }),
      'platform.secret_auth_failed',
    );
  });

  it('refuses a ciphertext read for another purpose', () => {
    const secret = cipher.encrypt('123456:AAH-bot-token', context);
    // Only one purpose exists, so this is the shape the catalogue will take
    // when a second one arrives; the AAD encodes it either way.
    const other = { ...context, purpose: 'provider.credential' as never };
    refused(() => cipher.decrypt(secret, other), 'platform.secret_auth_failed');
  });

  it('gives the same answer for a flipped bit as for a wrong row', () => {
    // The property, stated directly: corruption and a wrong context are one
    // outcome at this boundary.
    const secret = cipher.encrypt('123456:AAH-bot-token', context);
    const tampered = { ...secret, ciphertext: `${secret.ciphertext.slice(0, -4)}AAAA` };
    refused(() => cipher.decrypt(tampered, context), 'platform.secret_auth_failed');
  });

  // --- Header ---------------------------------------------------------------

  it('refuses an envelope whose key label was rewritten', () => {
    const secret = cipher.encrypt('123456:AAH-bot-token', ctx());
    const twoKeys = new AesGcmSecretCipher(ring({ 'key-1': KEK_A, 'key-2': KEK_A }), true);
    // Same key material under two labels, so the unwrap itself would succeed;
    // only the header AAD refuses it.
    const relabelled = {
      keyId: 'key-2',
      ciphertext: secret.ciphertext.replace('v2.key-1.', 'v2.key-2.'),
    };
    refused(() => twoKeys.decrypt(relabelled, ctx()), 'platform.secret_auth_failed');
  });

  it('refuses a v2 envelope relabelled as v1', () => {
    const secret = cipher.encrypt('123456:AAH-bot-token', context);
    const downgraded = { ...secret, ciphertext: secret.ciphertext.replace(/^v2\./, 'v1.') };
    refused(() => cipher.decrypt(downgraded, context), 'platform.secret_auth_failed');
  });

  it('refuses a row whose recorded key id is not the one in its envelope', () => {
    // Not a cryptographic outcome and not reported as one. Retirement counts
    // the recorded column, so a row that lies about its key could let a key be
    // retired while a ciphertext still needs it.
    const secret = cipher.encrypt('123456:AAH-bot-token', context);
    refused(
      () => cipher.decrypt({ ...secret, keyId: 'key-2' }, context),
      'platform.secret_key_id_mismatch',
    );
  });

  // --- Fail closed ----------------------------------------------------------

  it('refuses an envelope naming a key this installation does not hold', () => {
    const stranger = new AesGcmSecretCipher(ring({ 'key-9': KEK_B }), true);
    const secret = cipher.encrypt('123456:AAH-bot-token', context);
    refused(() => stranger.decrypt(secret, context), 'platform.secret_key_unknown');
  });

  it('refuses an unknown version and a malformed envelope', () => {
    const secret = cipher.encrypt('123456:AAH-bot-token', context);
    for (const ciphertext of [
      secret.ciphertext.replace(/^v2\./, 'v3.'),
      secret.ciphertext.split('.').slice(0, 7).join('.'),
      `${secret.ciphertext}.extra`,
      'not-an-envelope',
      '',
    ]) {
      refused(
        () => cipher.decrypt({ keyId: 'key-1', ciphertext }, context),
        'platform.secret_version_unsupported',
      );
    }
  });

  it('masks server-side without revealing the plaintext', () => {
    // Masking in the browser is not masking: the legacy panel page rendered
    // dots followed by the real stored secret in the DOM.
    const masked = cipher.mask(cipher.encrypt('123456:AAH-bot-token', context));
    expect(masked).not.toContain('AAH');
    expect(masked.startsWith('••••••••')).toBe(true);
  });
});

describe('the v1 envelope, still read', () => {
  const context = ctx();

  /**
   * A v1 value, produced the way v1 produced them: no associated data anywhere.
   * Written here rather than imported, because the point of the test is that
   * bytes from the PREVIOUS release still decrypt after this one ships.
   */
  const v1 = (plaintext: string, kekBase64: string, keyId: string) => {
    const kek = Buffer.from(kekBase64, 'base64');
    const dataKey = randomBytes(32);
    const wrapIv = randomBytes(12);
    const wrap = createCipheriv('aes-256-gcm', kek, wrapIv);
    const wrapped = Buffer.concat([wrap.update(dataKey), wrap.final()]);
    const wrapTag = wrap.getAuthTag();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const b = (buffer: Buffer) => buffer.toString('base64url');
    return {
      keyId,
      ciphertext: ['v1', keyId, b(wrapIv), b(wrapped), b(wrapTag), b(iv), b(body), b(tag)].join(
        '.',
      ),
    };
  };

  it('decrypts with a key from the keyring even when another key is active', () => {
    // The property v1 did not have. v1 refused any ciphertext whose key id was
    // not the single configured one, so rotating the key made every existing
    // row permanently unreadable — the `key_id` column recorded which key was
    // used and nothing could act on it.
    const cipher = new AesGcmSecretCipher(
      {
        activeKeyId: 'key-2',
        keys: new Map([
          ['key-1', Buffer.from(KEK_A, 'base64')],
          ['key-2', Buffer.from(KEK_B, 'base64')],
        ]),
        format: 'canonical',
      },
      true,
    );
    const old = v1('123456:AAH-bot-token', KEK_A, 'key-1');
    expect(cipher.decrypt(old, context)).toBe('123456:AAH-bot-token');
    // And a NEW write goes to the active key, as v2.
    expect(cipher.encrypt('fresh', context).keyId).toBe('key-2');
  });

  it('ignores the context, which is exactly why it is temporary', () => {
    // Stated as a test rather than only as a comment. A v1 ciphertext IS
    // transplantable, v2 does not retroactively protect it, and only refusing
    // v1 does.
    const cipher = new AesGcmSecretCipher(ring({ 'key-1': KEK_A }), true);
    const old = v1('123456:AAH-bot-token', KEK_A, 'key-1');
    expect(cipher.decrypt(old, { ...context, tenantId: TENANT_B })).toBe('123456:AAH-bot-token');
  });

  it('is refused entirely when v1 acceptance is disabled', () => {
    const cipher = new AesGcmSecretCipher(ring({ 'key-1': KEK_A }), false);
    const old = v1('123456:AAH-bot-token', KEK_A, 'key-1');
    try {
      cipher.decrypt(old, context);
      throw new Error('a v1 value was accepted with v1 acceptance off');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('platform.secret_version_unsupported');
    }
  });
});

describe('the canonical associated data', () => {
  it('separates fields unambiguously', () => {
    // The collision a delimiter would allow. Joining with `|` makes
    // ("a|b","c") and ("a","b|c") the same associated data; length prefixes
    // make them different by construction. Today no field could contain the
    // delimiter — which is a fact about today's data, not about the encoding.
    const left = canonicalAad({
      purpose: 'bot_instance.token',
      tenantId: 'a|b',
      entityId: 'c',
    } as never);
    const right = canonicalAad({
      purpose: 'bot_instance.token',
      tenantId: 'a',
      entityId: 'b|c',
    } as never);
    expect(left.equals(right)).toBe(false);
  });

  it('is domain-separated and stable', () => {
    const aad = canonicalAad(ctx());
    expect(aad.subarray(0, 19).toString('utf8')).toBe('nexa.secret.aad.v2\n');
    expect(canonicalAad(ctx()).equals(aad)).toBe(true);
  });
});

describe('identifiers', () => {
  const ids = new Uuidv7IdGenerator();

  it('generates valid UUIDv7 values', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(() => uuidV7Schema.parse(ids.uuid())).not.toThrow();
    }
  });

  it('generates time-sortable ids', () => {
    const first = ids.uuid();
    const second = ids.uuid();
    expect(first <= second).toBe(true);
  });

  it('generates callback references of the declared length and alphabet', () => {
    for (let i = 0; i < 50; i += 1) {
      const ref = ids.callbackRef();
      expect(ref).toHaveLength(CALLBACK_REF_LENGTH);
      expect(() => callbackRefSchema.parse(ref)).not.toThrow();
    }
  });

  it('generates distinct callback references', () => {
    const refs = new Set(Array.from({ length: 200 }, () => ids.callbackRef()));
    expect(refs.size).toBe(200);
  });
});

describe('redaction', () => {
  it('replaces secret-shaped values at every depth', () => {
    expect(
      redactSecrets({
        username: 'acme_bot',
        token: '123456:AAH',
        nested: { apiKey: 'abc', keep: 1, deeper: { botToken: 'x', fine: 2 } },
      }),
    ).toEqual({
      username: 'acme_bot',
      token: '[redacted]',
      nested: { apiKey: '[redacted]', keep: 1, deeper: { botToken: '[redacted]', fine: 2 } },
    });
  });

  it('traverses arrays', () => {
    // A credential inside a list is still a credential. The previous
    // implementation copied arrays verbatim, so a list of bot instances wrote
    // its tokens to the audit log in cleartext.
    expect(redactSecrets({ bots: [{ username: 'a', token: '123456:AAH-real' }] })).toEqual({
      bots: [{ username: 'a', token: '[redacted]' }],
    });
  });

  it('redacts a key it cannot assess rather than passing it through', () => {
    // A homoglyph normalises to something that matches no fragment (`tken`),
    // and a non-Latin key normalises to nothing at all. Both are unreadable, so
    // both fail closed. A false positive costs a log line; a false negative
    // costs a secret.
    expect(normaliseKey('tоken')).not.toContain('token'); // Cyrillic о
    expect(isSensitiveKey('tоken')).toBe(true);
    expect(isSensitiveKey('توکن')).toBe(true);
    expect(redactSecrets({ tоken: 'secret-value' })).toEqual({ tоken: '[redacted]' });
    // Plain ASCII that genuinely is not sensitive stays readable.
    expect(isSensitiveKey('displayName')).toBe(false);
  });

  it('still matches keys that carry digits or separators', () => {
    expect(isSensitiveKey('Token-1')).toBe(true);
    expect(isSensitiveKey('api_key')).toBe(true);
    expect(isSensitiveKey('bot_token_2')).toBe(true);
    expect(isSensitiveKey('username')).toBe(false);
  });

  it('survives a cyclic value instead of throwing inside a transaction', () => {
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic.self = cyclic;
    expect(() => redactSecrets(cyclic)).not.toThrow();
    expect((redactSecrets(cyclic) as { self: unknown }).self).toBe('[circular]');
  });

  it('truncates beyond a bounded depth', () => {
    let deep: Record<string, unknown> = { value: 'bottom' };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    expect(JSON.stringify(redactSecrets(deep))).toContain('[truncated]');
  });

  it('passes null through', () => {
    expect(redactRecord(null)).toBeNull();
  });
});
