import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  NexaError,
  PLATFORM_ERROR_CODES,
  type EncryptedSecret,
  type SecretCipher,
} from '@nexa/contracts';

/**
 * Envelope encryption for stored secrets.
 *
 * A fresh 256-bit data key encrypts each secret with AES-256-GCM. The data key
 * is itself wrapped with the key-encryption key from configuration, and the KEK
 * id travels with the ciphertext so keys can rotate without a flag day.
 *
 * Phase 0 has exactly one secret to protect — the Telegram bot token on
 * `bot_instances` — but it is a real secret, so it is encrypted from the first
 * migration. In the legacy system panel tokens were typed as plain chat
 * messages, which put them in Telegram's message history, the bot's update log
 * and every backup of both; and the panel detail page rendered a masked field
 * followed by the real secret in the DOM.
 *
 * Ciphertext format (all base64url, dot-separated):
 *   v1.<keyId>.<wrapIv>.<wrappedDataKey>.<wrapTag>.<iv>.<ciphertext>.<tag>
 */

const VERSION = 'v1';
const GCM_IV_BYTES = 12;

function b64(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function unb64(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

export class AesGcmSecretCipher implements SecretCipher {
  private readonly kek: Buffer;

  constructor(
    kekBase64: string,
    private readonly keyId: string,
  ) {
    this.kek = Buffer.from(kekBase64, 'base64');
    if (this.kek.length !== 32) {
      throw new NexaError({
        kind: 'CONFIGURATION',
        code: PLATFORM_ERROR_CODES.CONFIG_INVALID,
        message: 'SECRETS_KEK must decode to exactly 32 bytes.',
      });
    }
  }

  encrypt(plaintext: string): EncryptedSecret {
    const dataKey = randomBytes(32);

    const wrapIv = randomBytes(GCM_IV_BYTES);
    const wrapCipher = createCipheriv('aes-256-gcm', this.kek, wrapIv);
    const wrappedDataKey = Buffer.concat([wrapCipher.update(dataKey), wrapCipher.final()]);
    const wrapTag = wrapCipher.getAuthTag();

    const iv = randomBytes(GCM_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    dataKey.fill(0);

    return {
      keyId: this.keyId,
      ciphertext: [
        VERSION,
        this.keyId,
        b64(wrapIv),
        b64(wrappedDataKey),
        b64(wrapTag),
        b64(iv),
        b64(ciphertext),
        b64(tag),
      ].join('.'),
    };
  }

  decrypt(secret: EncryptedSecret): string {
    const parts = secret.ciphertext.split('.');
    if (parts.length !== 8 || parts[0] !== VERSION) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.SECRET_DECRYPT_FAILED,
        message: 'Stored secret is not in the expected envelope format.',
      });
    }
    const [, keyId, wrapIv, wrappedDataKey, wrapTag, iv, ciphertext, tag] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];

    if (keyId !== this.keyId) {
      throw new NexaError({
        kind: 'CONFIGURATION',
        code: PLATFORM_ERROR_CODES.SECRET_DECRYPT_FAILED,
        message: `Secret was encrypted with key "${keyId}" but the active key is "${this.keyId}". Rotate or restore the previous key.`,
        details: { requiredKeyId: keyId, activeKeyId: this.keyId },
      });
    }

    try {
      const unwrap = createDecipheriv('aes-256-gcm', this.kek, unb64(wrapIv));
      unwrap.setAuthTag(unb64(wrapTag));
      const dataKey = Buffer.concat([unwrap.update(unb64(wrappedDataKey)), unwrap.final()]);

      const decipher = createDecipheriv('aes-256-gcm', dataKey, unb64(iv));
      decipher.setAuthTag(unb64(tag));
      const plaintext = Buffer.concat([
        decipher.update(unb64(ciphertext)),
        decipher.final(),
      ]).toString('utf8');

      dataKey.fill(0);
      return plaintext;
    } catch (cause) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.SECRET_DECRYPT_FAILED,
        message:
          'Failed to decrypt stored secret. The key may be wrong or the value tampered with.',
        cause,
      });
    }
  }

  /**
   * A stable display form derived from the ciphertext, computed server-side.
   * It reveals nothing about the plaintext and never round-trips to it.
   */
  mask(secret: EncryptedSecret): string {
    const digest = createHash('sha256').update(secret.ciphertext).digest('hex');
    return `••••••••${digest.slice(0, 6)}`;
  }
}

export const SECRET_CIPHER = Symbol('SECRET_CIPHER');
