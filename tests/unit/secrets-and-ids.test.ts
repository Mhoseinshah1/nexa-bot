import { describe, expect, it } from 'vitest';
import { CALLBACK_REF_LENGTH, callbackRefSchema, uuidV7Schema } from '@nexa/contracts';
import { AesGcmSecretCipher } from '../../apps/api/src/infrastructure/crypto/secret-cipher';
import { Uuidv7IdGenerator } from '../../apps/api/src/infrastructure/ids';
import { redactSensitive } from '../../apps/api/src/modules/platform/audit/infrastructure/drizzle-audit-writer';

const KEK_A = Buffer.alloc(32, 1).toString('base64');
const KEK_B = Buffer.alloc(32, 2).toString('base64');

describe('envelope encryption', () => {
  const cipher = new AesGcmSecretCipher(KEK_A, 'key-1');

  it('round-trips a secret', () => {
    const secret = cipher.encrypt('123456:AAH-bot-token');
    expect(cipher.decrypt(secret)).toBe('123456:AAH-bot-token');
  });

  it('never stores the plaintext in the ciphertext', () => {
    const secret = cipher.encrypt('123456:AAH-bot-token');
    expect(secret.ciphertext).not.toContain('AAH-bot-token');
    expect(secret.keyId).toBe('key-1');
  });

  it('produces a different ciphertext each time for the same plaintext', () => {
    const a = cipher.encrypt('same');
    const b = cipher.encrypt('same');
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('fails loudly under the wrong key rather than returning nonsense', () => {
    const secret = cipher.encrypt('sensitive');
    const other = new AesGcmSecretCipher(KEK_B, 'key-1');
    expect(() => other.decrypt(secret)).toThrow();
  });

  it('names the key a secret needs when the active key differs', () => {
    const secret = cipher.encrypt('sensitive');
    const rotated = new AesGcmSecretCipher(KEK_B, 'key-2');
    expect(() => rotated.decrypt(secret)).toThrowError(/key-1/);
  });

  it('rejects a tampered ciphertext', () => {
    const secret = cipher.encrypt('sensitive');
    const tampered = { ...secret, ciphertext: `${secret.ciphertext.slice(0, -4)}AAAA` };
    expect(() => cipher.decrypt(tampered)).toThrow();
  });

  it('masks server-side without revealing the plaintext', () => {
    // Masking in the browser is not masking: the legacy panel page rendered
    // dots followed by the real stored secret in the DOM.
    const masked = cipher.mask(cipher.encrypt('123456:AAH-bot-token'));
    expect(masked).not.toContain('AAH');
    expect(masked.startsWith('••••••••')).toBe(true);
  });

  it('rejects a key-encryption key of the wrong size', () => {
    expect(() => new AesGcmSecretCipher('c2hvcnQ=', 'key-1')).toThrow();
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

describe('audit redaction', () => {
  it('replaces secret-shaped values before they reach the audit log', () => {
    const redacted = redactSensitive({
      username: 'acme_bot',
      token: '123456:AAH',
      nested: { apiKey: 'abc', keep: 1 },
    });
    expect(redacted).toEqual({
      username: 'acme_bot',
      token: '[redacted]',
      nested: { apiKey: '[redacted]', keep: 1 },
    });
  });

  it('passes null through', () => {
    expect(redactSensitive(null)).toBeNull();
  });
});
