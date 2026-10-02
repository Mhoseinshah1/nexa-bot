import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';
import {
  NexaError,
  PLATFORM_ERROR_CODES,
  RECOVERY_KIT_FORMAT_VERSION,
  RECOVERY_KIT_MAGIC,
  RECOVERY_KIT_MAX_BYTES,
  RECOVERY_KIT_PASSPHRASE_MAX_LENGTH,
  RECOVERY_KIT_PASSPHRASE_MIN_LENGTH,
  recoveryKitHeaderSchema,
  recoveryKitPayloadSchema,
  type RecoveryKitHeader,
} from '@nexa/contracts';

/**
 * The Recovery Kit file: every KEK an installation holds, sealed under a key
 * derived from a passphrase. The format contract is `@nexa/contracts`
 * `recovery-kit.ts` and `docs/recovery-kit-format.md`; this is its one reader
 * and its one writer.
 *
 * WHY IT IS SHAPED LIKE THE ARCHIVE. `archive.ts` already settled the questions
 * a sealed file raises — a cleartext header the reader needs before it can
 * decrypt, bound to the payload as associated data so editing it fails the tag;
 * one authentication error for every cause; nothing parsed out of a plaintext
 * before the tag has verified it. A kit is a few kilobytes, so it is sealed in
 * memory rather than streamed, and nothing else about those decisions changes.
 *
 * WHAT A FAILURE IS ALLOWED TO SAY. Three answers and no more:
 *
 *   - MALFORMED: not a kit, or a kit no reader should attempt (bounds), or —
 *     after authentication — a payload whose own contents disagree. Nothing
 *     about the passphrase is implied.
 *   - UNSUPPORTED_VERSION: a format this release does not read.
 *   - AUTH_FAILED: the passphrase is wrong OR a byte is damaged. AES-GCM cannot
 *     tell those apart and this function must not try: an error that could
 *     would be a passphrase oracle.
 *
 * Nothing here logs, and no error carries a cause or a detail: OpenSSL's
 * messages distinguish what this boundary must not, and a detail object is
 * where somebody would eventually put the passphrase.
 */

const MAGIC = Buffer.from(RECOVERY_KIT_MAGIC, 'ascii');
const LENGTH_PREFIX_BYTES = 4;
const GCM_TAG_BYTES = 16;
const GCM_IV_BYTES = 12;
const SALT_BYTES = 32;
const KEY_BYTES = 32;
/** A header this large is not a header. Bounds the one allocation made from an unauthenticated length. */
const MAX_HEADER_BYTES = 16 * 1024;

/** The KDF cost a WRITER uses. A reader accepts whatever the bounds allow. */
export interface KitKdfProfile {
  readonly log2N: number;
  readonly r: number;
  readonly p: number;
}

/**
 * scrypt N = 2^17, r = 8, p = 4: 128 MiB — the same memory a login spends,
 * because a kit is exported on the same small server — and four times the work.
 * A kit is an offline target, so the work factor is what an attacker holding
 * the file pays per guess.
 */
export const PRODUCTION_KIT_KDF: KitKdfProfile = { log2N: 17, r: 8, p: 4 };

/**
 * Deliberately weak, for the test suite. Selected by `PASSWORD_HASH_PROFILE=fast`,
 * which the config schema refuses in production — the same switch, for the same
 * reason, that keeps a self-hosted install left on `development` from storing
 * passwords at a thousandth of the intended cost.
 */
export const FAST_KIT_KDF: KitKdfProfile = { log2N: 10, r: 8, p: 1 };

/** One key, as it goes into or comes out of a kit. */
export interface KitKey {
  readonly keyId: string;
  /** 32 bytes. The caller zeroes it when done. */
  readonly material: Buffer;
}

export interface OpenedKit {
  readonly header: RecoveryKitHeader;
  readonly keys: readonly (KitKey & { readonly fingerprint: string })[];
}

/**
 * A key's fingerprint, as the contract defines it.
 *
 * Domain-separated so it can never equal any other hash this codebase takes of
 * the same bytes, and truncated to 128 bits because it is a thing people compare
 * by eye.
 */
export function kekFingerprint(material: Buffer): string {
  return createHash('sha256')
    .update('nexa.kek.fingerprint.v1\n', 'utf8')
    .update(material)
    .digest('hex')
    .slice(0, 32);
}

function malformed(message: string): NexaError {
  return new NexaError({
    kind: 'VALIDATION',
    code: PLATFORM_ERROR_CODES.RECOVERY_KIT_MALFORMED,
    message: `This is not a usable Recovery Kit: ${message}`,
  });
}

function authFailed(): NexaError {
  return new NexaError({
    kind: 'VALIDATION',
    code: PLATFORM_ERROR_CODES.RECOVERY_KIT_AUTH_FAILED,
    message:
      'The Recovery Kit could not be opened. Either the passphrase is not the one it was ' +
      'exported with, or the file has been damaged.',
  });
}

/**
 * The passphrase as bytes: NFC, then UTF-8.
 *
 * Normalised because the same Persian or accented passphrase typed on two
 * keyboards can arrive as two code-point sequences, and a kit that opened on
 * one machine and not the other would look exactly like a wrong passphrase.
 */
function passphraseBytes(passphrase: string): Buffer {
  return Buffer.from(passphrase.normalize('NFC'), 'utf8');
}

/** The rule a passphrase must meet to SEAL a kit. Reading applies no rule: the tag decides. */
export function passphraseProblem(passphrase: string): string | null {
  const length = [...passphrase.normalize('NFC')].length;
  if (length < RECOVERY_KIT_PASSPHRASE_MIN_LENGTH) {
    return `the passphrase must be at least ${String(RECOVERY_KIT_PASSPHRASE_MIN_LENGTH)} characters`;
  }
  if (length > RECOVERY_KIT_PASSPHRASE_MAX_LENGTH) return 'the passphrase is too long';
  if (passphrase.trim().length !== passphrase.length) {
    // A leading or trailing space is invisible in a form and in a password
    // manager, and is the commonest reason a correct-looking passphrase fails.
    return 'the passphrase must not begin or end with a space';
  }
  return null;
}

function deriveKey(passphrase: string, salt: Buffer, profile: KitKdfProfile): Promise<Buffer> {
  const N = 2 ** profile.log2N;
  return new Promise((resolve, reject) => {
    scrypt(
      passphraseBytes(passphrase),
      salt,
      KEY_BYTES,
      // Headroom over the 128 * N * r the algorithm needs; Node's 32 MiB default
      // would reject the production profile outright.
      { N, r: profile.r, p: profile.p, maxmem: 256 * N * profile.r + 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

function u32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

/**
 * Seals `payload` as a kit. The low-level writer.
 *
 * Exported for the FORMAT tests, which need authenticated kits that the public
 * writer refuses to produce — a duplicated key id, a fingerprint that is not its
 * key's. Every one of those is a shape a passphrase-holder could seal by hand,
 * and the reader's refusal of it is a rule that needs a test. Application code
 * calls `sealRecoveryKit`.
 */
export async function sealKitDocument(input: {
  readonly payload: unknown;
  readonly passphrase: string;
  readonly profile: KitKdfProfile;
  readonly kitId: string;
  readonly createdAt: Date;
}): Promise<Buffer> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(GCM_IV_BYTES);
  const header: RecoveryKitHeader = {
    format: RECOVERY_KIT_FORMAT_VERSION,
    kitId: input.kitId,
    createdAt: input.createdAt.toISOString(),
    kdf: {
      algorithm: 'scrypt',
      log2N: input.profile.log2N,
      r: input.profile.r,
      p: input.profile.p,
      salt: salt.toString('base64url'),
    },
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64url'),
  };
  // The writer holds itself to the reader's schema: a kit this function wrote
  // and the reader then refused would be discovered on the worst possible day.
  recoveryKitHeaderSchema.parse(header);
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const preamble = Buffer.concat([MAGIC, u32(headerBytes.length), headerBytes]);

  const key = await deriveKey(input.passphrase, salt, input.profile);
  const plaintext = Buffer.from(JSON.stringify(input.payload), 'utf8');
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(preamble);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const sealed = Buffer.concat([preamble, ciphertext, cipher.getAuthTag()]);
    if (sealed.length > RECOVERY_KIT_MAX_BYTES) throw malformed('it exceeds the size ceiling');
    return sealed;
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
}

/**
 * Seals `keys` into a kit. The writer application code uses.
 *
 * Refuses, before deriving anything, every shape the reader would refuse: a
 * passphrase below the floor, a duplicated key id, a key that is not 32 bytes
 * or is all zeroes.
 */
export async function sealRecoveryKit(input: {
  readonly keys: readonly KitKey[];
  readonly passphrase: string;
  readonly profile: KitKdfProfile;
  readonly kitId: string;
  readonly createdAt: Date;
}): Promise<Buffer> {
  const problem = passphraseProblem(input.passphrase);
  if (problem !== null) {
    throw new NexaError({
      kind: 'VALIDATION',
      code: PLATFORM_ERROR_CODES.RECOVERY_KIT_PASSPHRASE_REJECTED,
      message: `The Recovery Kit passphrase was refused: ${problem}.`,
    });
  }
  const seen = new Set<string>();
  for (const key of input.keys) {
    if (seen.has(key.keyId)) throw malformed(`key id "${key.keyId}" appears twice`);
    seen.add(key.keyId);
    if (key.material.length !== KEY_BYTES || key.material.every((byte) => byte === 0)) {
      throw malformed(`key "${key.keyId}" is not a usable 32-byte key`);
    }
  }
  const payload = {
    format: RECOVERY_KIT_FORMAT_VERSION,
    kitId: input.kitId,
    keys: input.keys.map((key) => ({
      keyId: key.keyId,
      material: key.material.toString('base64url'),
      fingerprint: kekFingerprint(key.material),
    })),
  };
  // Same rule as the header: never write what the reader would refuse.
  recoveryKitPayloadSchema.parse(payload);
  return sealKitDocument({
    payload,
    passphrase: input.passphrase,
    profile: input.profile,
    kitId: input.kitId,
    createdAt: input.createdAt,
  });
}

/**
 * Parses the cleartext preamble without deriving or decrypting anything.
 *
 * The order of the refusals is the contract: an implausible length before an
 * allocation, a VERSION before the schema — so a format-2 kit says "newer
 * format" rather than "malformed" — and the KDF bounds before any memory is
 * committed to a derivation a hostile header asked for.
 */
export function readRecoveryKitHeader(kit: Buffer): {
  readonly header: RecoveryKitHeader;
  readonly preamble: Buffer;
} {
  if (kit.length > RECOVERY_KIT_MAX_BYTES) throw malformed('it exceeds the size ceiling');
  if (kit.length < MAGIC.length + LENGTH_PREFIX_BYTES + GCM_TAG_BYTES) {
    throw malformed('it is shorter than a header');
  }
  if (!kit.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw malformed('the file does not begin with the Recovery Kit marker');
  }
  const headerLength = kit.readUInt32BE(MAGIC.length);
  const payloadOffset = MAGIC.length + LENGTH_PREFIX_BYTES + headerLength;
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
    throw malformed('the declared header length is not plausible');
  }
  if (kit.length < payloadOffset + GCM_TAG_BYTES) {
    throw malformed('the file ends inside its own header or tag');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      kit.subarray(MAGIC.length + LENGTH_PREFIX_BYTES, payloadOffset).toString('utf8'),
    );
  } catch {
    throw malformed('the header is not JSON');
  }
  const format =
    typeof parsed === 'object' && parsed !== null ? (parsed as { format?: unknown }).format : null;
  if (typeof format !== 'number') throw malformed('the header names no format version');
  if (format !== RECOVERY_KIT_FORMAT_VERSION) {
    throw new NexaError({
      kind: 'VALIDATION',
      code: PLATFORM_ERROR_CODES.RECOVERY_KIT_UNSUPPORTED_VERSION,
      message:
        `This Recovery Kit is format ${String(format)}, and this release reads format ` +
        `${String(RECOVERY_KIT_FORMAT_VERSION)} only. Open it with the release that exported it.`,
    });
  }
  const header = recoveryKitHeaderSchema.safeParse(parsed);
  if (!header.success) {
    throw malformed(
      'the header does not match format 1, or its key-derivation cost is out of bounds',
    );
  }
  return { header: header.data, preamble: kit.subarray(0, payloadOffset) };
}

/**
 * Opens a kit. Every key it returns has been authenticated, parsed against the
 * strict payload schema, de-duplicated and fingerprint-checked.
 *
 * Nothing in the payload is looked at before `final()` has verified the tag —
 * the plaintext is a complete, authenticated buffer by the time it is parsed.
 */
export async function openRecoveryKit(kit: Buffer, passphrase: string): Promise<OpenedKit> {
  const { header, preamble } = readRecoveryKitHeader(kit);
  const salt = Buffer.from(header.kdf.salt, 'base64url');
  const iv = Buffer.from(header.iv, 'base64url');
  const tag = kit.subarray(kit.length - GCM_TAG_BYTES);
  const ciphertext = kit.subarray(preamble.length, kit.length - GCM_TAG_BYTES);

  const key = await deriveKey(passphrase, salt, header.kdf);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(preamble);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Swallowed deliberately: the underlying message is the oracle.
    throw authFailed();
  } finally {
    key.fill(0);
  }

  // Authenticated from here. Everything below is a statement about bytes the
  // passphrase-holder sealed, so a refusal is MALFORMED and never AUTH_FAILED.
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext.toString('utf8'));
    } catch {
      throw malformed('the sealed contents are not JSON');
    }
    const payload = recoveryKitPayloadSchema.safeParse(parsed);
    if (!payload.success) {
      throw malformed('the sealed contents do not match format 1');
    }
    if (payload.data.kitId !== header.kitId) {
      throw malformed('the sealed contents belong to a different kit');
    }

    const seen = new Set<string>();
    const keys: (KitKey & { fingerprint: string })[] = [];
    try {
      for (const entry of payload.data.keys) {
        // Refused rather than last-wins: which of two different keys under one
        // id a kit "means" is not a question a reader should answer.
        if (seen.has(entry.keyId)) throw malformed(`key id "${entry.keyId}" appears twice`);
        seen.add(entry.keyId);
        const material = Buffer.from(entry.material, 'base64url');
        keys.push({ keyId: entry.keyId, material, fingerprint: entry.fingerprint });
        if (material.length !== KEY_BYTES || material.every((byte) => byte === 0)) {
          throw malformed(`key "${entry.keyId}" is not a usable 32-byte key`);
        }
        if (kekFingerprint(material) !== entry.fingerprint) {
          throw malformed(`key "${entry.keyId}" does not match its own fingerprint`);
        }
      }
    } catch (error) {
      for (const key of keys) key.material.fill(0);
      throw error;
    }
    return { header, keys };
  } finally {
    plaintext.fill(0);
  }
}
