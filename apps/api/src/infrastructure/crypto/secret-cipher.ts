import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  NexaError,
  PLATFORM_ERROR_CODES,
  type EncryptedSecret,
  type SecretCipher,
  type SecretContext,
} from '@nexa/contracts';
import type { SecretKeyring } from './keyring.js';

/**
 * Envelope encryption for stored secrets.
 *
 * A fresh 256-bit data key encrypts each secret with AES-256-GCM. The data key
 * is itself wrapped with a key-encryption key from the keyring, and the key id
 * travels with the ciphertext.
 *
 * In the legacy system panel tokens were typed as plain chat messages, which
 * put them in Telegram's message history, the bot's update log and every backup
 * of both; and the panel detail page rendered a masked field followed by the
 * real secret in the DOM.
 *
 * ## v2
 *
 *   v2.<keyId>.<wrapIv>.<wrappedDataKey>.<wrapTag>.<iv>.<ciphertext>.<tag>
 *
 * Two things v1 did not have:
 *
 *   - **The payload is bound to its context.** `purpose | tenantId | entityId`
 *     is the payload's AEAD associated data, canonically encoded (see
 *     `canonicalAad`). It is NOT stored — it is recomputed from the caller's
 *     arguments at decrypt time, so a ciphertext copied into another row,
 *     another tenant or another column recomputes a different context and fails
 *     the authentication tag. That is the transplant defence, and it is the
 *     whole reason `SecretContext` is a required parameter.
 *   - **The header is bound to the wrap.** `v2|<keyId>` is the wrap's
 *     associated data, so neither the version nor the key label can be edited
 *     in the stored string without failing authentication.
 *
 * ## v1, still read
 *
 *   v1.<keyId>.<wrapIv>.<wrappedDataKey>.<wrapTag>.<iv>.<ciphertext>.<tag>
 *
 * Same layout, no associated data anywhere. It is read so that an installation
 * upgrades without a flag day, and it is worth being exact about what that
 * costs: **a v1 ciphertext remains transplantable**, because there is nothing
 * in it that says where it belongs. v2 does not retroactively protect v1 data.
 * Only re-encrypting every row and then refusing v1 does, and refusing v1 is a
 * later release. `acceptV1` exists so that switch is a configuration change
 * rather than a code change.
 *
 * ## What a failure is allowed to say
 *
 * Every authenticated-decryption failure raises ONE code, `SECRET_AUTH_FAILED`.
 * A wrong tenant, a wrong row, a wrong purpose, a flipped ciphertext bit and an
 * edited tag are indistinguishable at this boundary and must stay that way: a
 * caller that could tell them apart could ask which authenticated field was
 * wrong, one field at a time. An unknown key id and an unsupported version are
 * separate codes because they are not cryptographic outcomes — they say this
 * installation cannot attempt the value at all, which an operator needs to hear
 * precisely.
 */

const V1 = 'v1';
const V2 = 'v2';
const SEGMENTS = 8;
const GCM_IV_BYTES = 12;

/**
 * Domain separation, then every field length-prefixed.
 *
 * Length prefixes rather than a delimiter, because joining with one means
 * `("a|b","c")` and `("a","b|c")` produce the same associated data. Today every
 * field is a UUID or a value from a closed catalogue and no delimiter could
 * appear in one — which is a fact about today's data, not a property of the
 * encoding. This encoding is unambiguous by construction.
 *
 * The field set and their order are fixed by the version tag. Changing either
 * is `v3`, never a silent edit: every existing ciphertext authenticates the old
 * layout and would stop decrypting.
 */
export function canonicalAad(context: SecretContext): Buffer {
  const parts: Buffer[] = [Buffer.from('nexa.secret.aad.v2\n', 'utf8')];
  for (const field of [context.purpose, context.tenantId, context.entityId]) {
    const bytes = Buffer.from(field, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length, 0);
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
}

function wrapAad(version: string, keyId: string): Buffer {
  return Buffer.from(`${version}|${keyId}`, 'utf8');
}

function b64(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function unb64(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

/**
 * The one error every authenticated failure produces.
 *
 * No `details`, no `cause`. A cause here would carry OpenSSL's own message into
 * a log line, and a details object is where somebody would eventually put the
 * context that failed to match.
 */
function authFailed(): NexaError {
  return new NexaError({
    kind: 'INTERNAL',
    code: PLATFORM_ERROR_CODES.SECRET_AUTH_FAILED,
    message:
      'A stored secret failed authenticated decryption. The value, its key, or the row it belongs ' +
      'to does not match what it was encrypted for.',
  });
}

export class AesGcmSecretCipher implements SecretCipher {
  constructor(
    private readonly keyring: SecretKeyring,
    /**
     * Whether v1 ciphertext may still be read.
     *
     * True for the compatibility release. Flipped to false only once
     * `secrets status` reports no v1 rows anywhere — until then, turning it off
     * makes an installation unable to read its own secrets.
     */
    private readonly acceptV1: boolean,
  ) {}

  private key(keyId: string): Buffer {
    const key = this.keyring.keys.get(keyId);
    if (key === undefined) {
      throw new NexaError({
        kind: 'CONFIGURATION',
        code: PLATFORM_ERROR_CODES.SECRET_KEY_UNKNOWN,
        message:
          `A stored secret names key "${keyId}", which this installation does not hold. Add it to ` +
          'SECRETS_KEYS — a retired key still has ciphertext depending on it.',
        details: { requiredKeyId: keyId, configuredKeyIds: [...this.keyring.keys.keys()] },
      });
    }
    return key;
  }

  encrypt(plaintext: string, context: SecretContext): EncryptedSecret {
    const keyId = this.keyring.activeKeyId;
    const kek = this.key(keyId);
    const dataKey = randomBytes(32);

    try {
      const wrapIv = randomBytes(GCM_IV_BYTES);
      const wrapCipher = createCipheriv('aes-256-gcm', kek, wrapIv);
      wrapCipher.setAAD(wrapAad(V2, keyId));
      const wrappedDataKey = Buffer.concat([wrapCipher.update(dataKey), wrapCipher.final()]);
      const wrapTag = wrapCipher.getAuthTag();

      const iv = randomBytes(GCM_IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
      cipher.setAAD(canonicalAad(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();

      return {
        keyId,
        ciphertext: [
          V2,
          keyId,
          b64(wrapIv),
          b64(wrappedDataKey),
          b64(wrapTag),
          b64(iv),
          b64(ciphertext),
          b64(tag),
        ].join('.'),
      };
    } finally {
      dataKey.fill(0);
    }
  }

  decrypt(secret: EncryptedSecret, context: SecretContext): string {
    const parts = secret.ciphertext.split('.');
    const version = parts[0];

    if (parts.length !== SEGMENTS || (version !== V1 && version !== V2)) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.SECRET_VERSION_UNSUPPORTED,
        message:
          'A stored secret is not in a recognised envelope format. It may have been written by a ' +
          'newer release, or truncated.',
      });
    }
    if (version === V1 && !this.acceptV1) {
      throw new NexaError({
        kind: 'CONFIGURATION',
        code: PLATFORM_ERROR_CODES.SECRET_VERSION_UNSUPPORTED,
        message:
          'A v1 secret was found and v1 acceptance is disabled. Re-encrypt with ' +
          '`botctl secrets rewrap` before disabling it, or re-enable SECRETS_ACCEPT_V1.',
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

    // The column and the envelope must agree, and the check is not decoration.
    //
    // `secrets status` and key retirement count dependencies using the STORED
    // COLUMN, because counting them means a GROUP BY rather than decrypting
    // every row. A row whose column says one key while its envelope says
    // another would therefore let a key be retired while a ciphertext still
    // needs it. Refused here, and never quietly repaired on a read: a silent
    // repair on the read path is a write nobody asked for, and it would erase
    // the evidence that something wrote the row inconsistently.
    if (keyId !== secret.keyId) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.SECRET_KEY_ID_MISMATCH,
        message:
          `A stored secret records key "${secret.keyId}" but its envelope names "${keyId}". Key ` +
          'retirement counts the recorded value, so this row must be corrected before any key is ' +
          'retired.',
        details: { recordedKeyId: secret.keyId, envelopeKeyId: keyId },
      });
    }

    const kek = this.key(keyId);
    let dataKey: Buffer | null = null;
    try {
      const unwrap = createDecipheriv('aes-256-gcm', kek, unb64(wrapIv));
      // v1 wrapped without associated data; v2 binds its header.
      if (version === V2) unwrap.setAAD(wrapAad(V2, keyId));
      unwrap.setAuthTag(unb64(wrapTag));
      dataKey = Buffer.concat([unwrap.update(unb64(wrappedDataKey)), unwrap.final()]);

      const decipher = createDecipheriv('aes-256-gcm', dataKey, unb64(iv));
      // v1 has no context to check. This is exactly the property that makes a
      // v1 row transplantable, and exactly why v1 acceptance is temporary.
      if (version === V2) decipher.setAAD(canonicalAad(context));
      decipher.setAuthTag(unb64(tag));
      return Buffer.concat([decipher.update(unb64(ciphertext)), decipher.final()]).toString('utf8');
    } catch {
      // Swallowed deliberately: the underlying message distinguishes causes
      // this boundary must not distinguish.
      throw authFailed();
    } finally {
      dataKey?.fill(0);
    }
  }

  /**
   * A stable display form derived from the ciphertext, computed server-side. It
   * reveals nothing about the plaintext and never round-trips to it.
   *
   * Stable only while the stored value is. Re-encrypting a secret changes it,
   * so it confirms that two operators are looking at the same stored value now
   * — it is not an identifier and nothing may persist it across a rewrap.
   */
  mask(secret: EncryptedSecret): string {
    const digest = createHash('sha256').update(secret.ciphertext).digest('hex');
    return `••••••••${digest.slice(0, 6)}`;
  }
}

export const SECRET_CIPHER = Symbol('SECRET_CIPHER');

/** The envelope version of a stored value, without decrypting it. */
export function envelopeVersion(ciphertext: string): string {
  const version = ciphertext.split('.', 1)[0] ?? '';
  return version === V1 || version === V2 ? version : 'unknown';
}

/** The key id an envelope names, without decrypting it. */
export function envelopeKeyId(ciphertext: string): string | null {
  const parts = ciphertext.split('.');
  return parts.length === SEGMENTS ? (parts[1] ?? null) : null;
}
