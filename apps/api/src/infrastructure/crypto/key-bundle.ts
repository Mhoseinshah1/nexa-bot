import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { z } from 'zod';
import { NexaError, PLATFORM_ERROR_CODES } from '@nexa/contracts';
import { kekFingerprint, type KitKdfProfile } from './recovery-kit.js';

/**
 * The key bundle: the keyring keys a backup's secrets are sealed under, carried
 * INSIDE that backup, each wrapped under a key derived from the backup's password.
 *
 * WHY. A restore must need only the backup file and its password. Without this,
 * the secrets inside a dump (bot token, panel and gateway credentials, the backup
 * password itself) are sealed under the OLD server's key, and a server whose own
 * key merely shares the old one's id cut over into secrets nothing could read.
 *
 * WHAT IS WRAPPED. Each key on its own: scrypt(password, salt) → a 256-bit key,
 * one per bundle, with a fresh 32-byte salt; then AES-256-GCM per key with a
 * fresh 96-bit nonce and the associated data
 *
 *   "nexa.backup.key_bundle.v1\n" ‖ len‖backupId ‖ len‖keyId ‖ len‖fingerprint
 *
 * so a wrapped key moved into another backup's bundle, relabelled with another id
 * or claimed under another fingerprint fails its tag. The domain label is not the
 * Recovery Kit's (a kit authenticates its whole preamble), so a kit and a bundle
 * can never be taken for each other even under the same passphrase.
 *
 * NOTHING HERE IS PLAINTEXT KEY MATERIAL. The bundle holds ids, fingerprints
 * (one-way, `kekFingerprint`) and ciphertext. Nothing logs; no error carries a
 * cause or a detail.
 *
 * TENANT-AGNOSTIC ON PURPOSE. Pure functions: a password, a backup id and keys in,
 * a document out (and back). Nothing reads a database, a tenant or a keyring, so
 * the per-tenant backups of Phase 6B reuse them unchanged.
 */

/** The fixed name the bundle travels under inside a 7-Zip archive. */
export const KEY_BUNDLE_ENTRY = 'keys.json';

const BUNDLE_FORMAT = 1;
const BUNDLE_KIND = 'nexa.backup.key-bundle';
const SALT_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const KEY_BYTES = 32;
/** A bundle this large is not a bundle. Bounds the read before anything is parsed. */
export const KEY_BUNDLE_MAX_BYTES = 256 * 1024;
const MAX_KEYS = 64;

const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/);

/**
 * The reader's bounds on the KDF a FILE asks for: below them a bundle is not worth
 * protecting with, above them it is a request for gigabytes of memory.
 */
const bundleSchema = z
  .object({
    format: z.literal(BUNDLE_FORMAT),
    kind: z.literal(BUNDLE_KIND),
    backupId: z.string().min(1).max(128),
    kdf: z
      .object({
        algorithm: z.literal('scrypt'),
        log2N: z.number().int().min(10).max(20),
        r: z.number().int().min(1).max(16),
        p: z.number().int().min(1).max(16),
        salt: b64url,
      })
      .strict(),
    keys: z
      .array(
        z
          .object({
            keyId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
            fingerprint: z.string().regex(/^[0-9a-f]{32}$/),
            iv: b64url,
            wrapped: b64url,
            tag: b64url,
          })
          .strict(),
      )
      .max(MAX_KEYS),
  })
  .strict();

/** One key going into a bundle. 32 bytes; the caller owns and zeroes it. */
export interface BundleKey {
  readonly keyId: string;
  readonly material: Buffer;
}

/** One key out of a bundle, authenticated and fingerprint-checked. The caller zeroes it. */
export interface OpenedBundleKey extends BundleKey {
  readonly fingerprint: string;
}

function malformed(detail: string): NexaError {
  return new NexaError({
    kind: 'INTERNAL',
    code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_MALFORMED,
    message: `The keys inside a backup archive are not readable: ${detail}`,
  });
}

/**
 * ONE answer for a wrong password and a damaged byte, as for the archive itself.
 * A distinguishing error would tell whoever holds the file which guess was closer.
 */
function authFailed(): NexaError {
  return new NexaError({
    kind: 'INTERNAL',
    code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_AUTH_FAILED,
    message:
      'The keys inside a backup archive could not be opened: the password is not the one it ' +
      'was sealed with, or the archive is damaged.',
  });
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function aad(backupId: string, keyId: string, fingerprint: string): Buffer {
  return Buffer.concat([
    Buffer.from('nexa.backup.key_bundle.v1\n', 'utf8'),
    lengthPrefixed(backupId),
    lengthPrefixed(keyId),
    lengthPrefixed(fingerprint),
  ]);
}

/**
 * scrypt over the password's NFC UTF-8 bytes, as the Recovery Kit derives — so the
 * same password typed on two keyboards derives the same key. Not the kit's own
 * derivation: that one refuses to run beside another (a kit is opened by hand), and
 * a scheduled backup must not fail because somebody is importing a kit.
 */
async function derive(password: string, salt: Buffer, profile: KitKdfProfile): Promise<Buffer> {
  const N = 2 ** profile.log2N;
  const secret = Buffer.from(password.normalize('NFC'), 'utf8');
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        secret,
        salt,
        KEY_BYTES,
        { N, r: profile.r, p: profile.p, maxmem: 256 * N * profile.r + 1024 * 1024 },
        (error, key) => (error ? reject(error) : resolve(key)),
      );
    });
  } finally {
    secret.fill(0);
  }
}

/**
 * Wraps `keys` under `password` for the backup `backupId`. Returns the bundle's bytes
 * (JSON). Refuses an empty password, a key that is not 32 usable bytes, and the same
 * key twice; the same id with different bytes is allowed — that is the case the
 * bundle exists for.
 */
export async function sealKeyBundle(input: {
  readonly keys: readonly BundleKey[];
  readonly password: string;
  readonly backupId: string;
  readonly profile: KitKdfProfile;
}): Promise<Buffer> {
  if (input.password.length === 0) throw malformed('a key bundle needs a password');
  if (input.keys.length > MAX_KEYS) throw malformed('too many keys');
  const seen = new Set<string>();
  const prepared = input.keys.map((key) => {
    if (key.material.length !== KEY_BYTES || key.material.every((byte) => byte === 0)) {
      throw malformed(`key "${key.keyId}" is not a usable 32-byte key`);
    }
    const fingerprint = kekFingerprint(key.material);
    if (seen.has(`${key.keyId}|${fingerprint}`)) throw malformed('the same key appears twice');
    seen.add(`${key.keyId}|${fingerprint}`);
    return { ...key, fingerprint };
  });
  const salt = randomBytes(SALT_BYTES);
  const wrappingKey = await derive(input.password, salt, input.profile);
  try {
    const document = {
      format: BUNDLE_FORMAT,
      kind: BUNDLE_KIND,
      backupId: input.backupId,
      kdf: {
        algorithm: 'scrypt' as const,
        log2N: input.profile.log2N,
        r: input.profile.r,
        p: input.profile.p,
        salt: salt.toString('base64url'),
      },
      keys: prepared.map((key) => {
        const iv = randomBytes(GCM_IV_BYTES);
        const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv);
        cipher.setAAD(aad(input.backupId, key.keyId, key.fingerprint));
        const wrapped = Buffer.concat([cipher.update(key.material), cipher.final()]);
        return {
          keyId: key.keyId,
          fingerprint: key.fingerprint,
          iv: iv.toString('base64url'),
          wrapped: wrapped.toString('base64url'),
          tag: cipher.getAuthTag().toString('base64url'),
        };
      }),
    };
    // The writer holds itself to the reader's schema.
    bundleSchema.parse(document);
    return Buffer.from(JSON.stringify(document), 'utf8');
  } finally {
    wrappingKey.fill(0);
  }
}

/**
 * Opens a bundle with `password`, for the backup `backupId`. Every key returned has
 * authenticated and matches its own fingerprint. All or nothing: one key that fails
 * fails the bundle, and every buffer already opened is zeroed first.
 */
export async function openKeyBundle(input: {
  readonly bundle: Buffer;
  readonly password: string;
  readonly backupId: string;
}): Promise<readonly OpenedBundleKey[]> {
  if (input.bundle.length > KEY_BUNDLE_MAX_BYTES) throw malformed('it exceeds the size ceiling');
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.bundle.toString('utf8'));
  } catch {
    throw malformed('it is not JSON');
  }
  const document = bundleSchema.safeParse(parsed);
  if (!document.success) throw malformed('it does not match the format this release reads');
  // Bound into every key's associated data as well; refused here so a bundle from
  // another backup says so rather than failing as a wrong password.
  if (document.data.backupId !== input.backupId) {
    throw malformed('it belongs to a different backup');
  }
  const salt = Buffer.from(document.data.kdf.salt, 'base64url');
  if (salt.length !== SALT_BYTES) throw malformed('its salt is not 32 bytes');

  const wrappingKey = await derive(input.password, salt, document.data.kdf);
  const opened: OpenedBundleKey[] = [];
  try {
    for (const entry of document.data.keys) {
      let material: Buffer;
      try {
        const decipher = createDecipheriv(
          'aes-256-gcm',
          wrappingKey,
          Buffer.from(entry.iv, 'base64url'),
          { authTagLength: GCM_TAG_BYTES },
        );
        decipher.setAAD(aad(input.backupId, entry.keyId, entry.fingerprint));
        decipher.setAuthTag(Buffer.from(entry.tag, 'base64url'));
        material = Buffer.concat([
          decipher.update(Buffer.from(entry.wrapped, 'base64url')),
          decipher.final(),
        ]);
      } catch {
        throw authFailed();
      }
      opened.push({ keyId: entry.keyId, fingerprint: entry.fingerprint, material });
      if (material.length !== KEY_BYTES || kekFingerprint(material) !== entry.fingerprint) {
        throw malformed(`key "${entry.keyId}" does not match its own fingerprint`);
      }
    }
    return opened;
  } catch (error) {
    for (const key of opened) key.material.fill(0);
    throw error;
  } finally {
    wrappingKey.fill(0);
  }
}

/** Zeroes every key's bytes. For the caller's `finally`. */
export function wipeBundleKeys(keys: readonly { readonly material: Buffer }[] | null): void {
  if (keys === null) return;
  for (const key of keys) key.material.fill(0);
}
