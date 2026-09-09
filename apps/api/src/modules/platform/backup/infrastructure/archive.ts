import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  BACKUP_ARCHIVE_FORMAT_VERSION,
  BACKUP_ARCHIVE_MAGIC,
  backupArchiveHeaderSchema,
  backupManifestSchema,
  NexaError,
  PLATFORM_ERROR_CODES,
  type BackupArchiveHeader,
  type BackupManifest,
} from '@nexa/contracts';
import type { SecretKeyring } from '../../../../infrastructure/crypto/keyring.js';

/**
 * The encrypted backup archive: a streaming, authenticated container for a
 * file that does not fit in memory.
 *
 * A separate implementation from `AesGcmSecretCipher`, and the separation was
 * measured rather than assumed. That cipher cannot carry a dump for three
 * independent reasons, any one of which is fatal:
 *
 *   - its port is `encrypt(plaintext: string)`. A `pg_dump` custom-format
 *     archive is binary, and the round trip through a string is lossy: it
 *     decodes with `'utf8'`, so every byte sequence that is not valid UTF-8 is
 *     replaced by U+FFFD. A 64-byte gzip buffer comes back 96 bytes long.
 *   - its envelope is `base64url`, and Node's `Buffer.toString` throws above
 *     `MAX_STRING_LENGTH`. Any payload over about 384 MiB cannot be encoded at
 *     all, which is a size a real installation's database reaches.
 *   - it holds the whole plaintext, the whole ciphertext and the whole base64
 *     envelope in memory at once — three copies of the database.
 *
 * What IS reused is everything that makes that cipher trustworthy and none of
 * what makes it string-shaped: the same keyring, so one active key encrypts and
 * every held key can decrypt and a rotation is an overlap; the same
 * envelope-encryption structure, a per-archive random data key wrapped under
 * the KEK; the same AES-256-GCM; and the same discipline of binding associated
 * data so that a header somebody edited fails authentication rather than
 * steering the decryption.
 *
 * THE FILE LAYOUT
 *
 *   magic          8 bytes, ASCII `NEXABAK1`
 *   headerLength   uint32 big-endian
 *   header         `headerLength` bytes of UTF-8 JSON
 *   ciphertext     to end-of-file minus 16
 *   tag            16 bytes, the GCM authentication tag
 *
 * The tag is a TRAILER because GCM only produces it after the last byte is
 * encrypted, and holding a whole dump to move sixteen bytes to the front is
 * the memory cost this class exists to avoid. Decryption reads it first — the
 * archive is a file, so its end is one seek away.
 *
 * The header is cleartext by necessity: it names the KEK and carries the
 * wrapped data key and the nonce, all of which a reader needs before it can
 * decrypt anything. It is therefore the payload's associated data, so editing
 * it — pointing at a different key, changing the backup id, swapping the nonce
 * — makes the payload fail to authenticate instead of decrypting into
 * something else.
 *
 * THE PLAINTEXT LAYOUT, inside the encrypted region
 *
 *   manifestLength uint32 big-endian
 *   manifest       `manifestLength` bytes of UTF-8 JSON
 *   dump           the `pg_dump` custom-format archive, byte for byte
 *
 * The manifest is inside because it names the installation and the database.
 * The checksum it carries is over the DUMP alone, which is what makes it
 * verifiable against a restored file years later.
 */

const MAGIC = Buffer.from(BACKUP_ARCHIVE_MAGIC, 'ascii');
const LENGTH_PREFIX_BYTES = 4;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const DATA_KEY_BYTES = 32;

/**
 * A header this large is not a header. Bounds the allocation a restore tool
 * makes from a length field it has not authenticated yet — the one number in
 * this format that is read before anything can be checked.
 */
const MAX_HEADER_BYTES = 64 * 1024;

/** Same argument, for the manifest — though that one IS authenticated first. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

function wrapAad(backupId: string, keyId: string): Buffer {
  return Buffer.from(`nexa.backup.wrap.v1|${backupId}|${keyId}`, 'utf8');
}

function u32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function b64(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function unb64(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

/**
 * The one error every authenticated failure produces, whatever the cause.
 *
 * Deliberately uniform. A wrong key, a truncated file, a flipped byte and an
 * edited header are the same answer — "this did not authenticate" — and an
 * error that distinguished them would be telling whoever holds the archive
 * which of their guesses was closer.
 */
function archiveAuthFailed(detail: string): NexaError {
  return new NexaError({
    kind: 'INTERNAL',
    code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_AUTH_FAILED,
    message:
      `A backup archive failed authenticated decryption (${detail}). The archive, its key, or ` +
      'the header it carries does not match what it was encrypted for.',
  });
}

function archiveMalformed(detail: string): NexaError {
  return new NexaError({
    kind: 'INTERNAL',
    code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_MALFORMED,
    message: `A backup archive is not in a readable format: ${detail}`,
  });
}

function keyFor(keyring: SecretKeyring, keyId: string): Buffer {
  const key = keyring.keys.get(keyId);
  if (key === undefined) {
    throw new NexaError({
      kind: 'CONFIGURATION',
      code: PLATFORM_ERROR_CODES.SECRET_KEY_UNKNOWN,
      message:
        `A backup archive names key "${keyId}", which this installation does not hold. Add it to ` +
        'SECRETS_KEYS — an archive outlives the key rotation that retired its key.',
      details: { requiredKeyId: keyId, configuredKeyIds: [...keyring.keys.keys()] },
    });
  }
  return key;
}

export interface SealResult {
  /** Bytes written to the archive file, header and tag included. */
  readonly archiveBytes: number;
  /** Which KEK the data key was wrapped under. */
  readonly keyId: string;
}

/**
 * Encrypts `dumpPath` plus its manifest into `archivePath`.
 *
 * Streams. Memory is bounded by the pipe's high-water mark, not by the size of
 * the database, which is the whole reason this exists.
 */
export async function sealArchive(input: {
  readonly dumpPath: string;
  readonly archivePath: string;
  readonly manifest: BackupManifest;
  readonly keyring: SecretKeyring;
}): Promise<SealResult> {
  const { dumpPath, archivePath, manifest, keyring } = input;
  const backupId = manifest.backupId;
  const keyId = keyring.activeKeyId;
  const kek = keyFor(keyring, keyId);

  const dataKey = randomBytes(DATA_KEY_BYTES);
  try {
    const wrapIv = randomBytes(GCM_IV_BYTES);
    const wrapCipher = createCipheriv('aes-256-gcm', kek, wrapIv);
    wrapCipher.setAAD(wrapAad(backupId, keyId));
    const wrappedKey = Buffer.concat([wrapCipher.update(dataKey), wrapCipher.final()]);
    const wrapTag = wrapCipher.getAuthTag();

    const iv = randomBytes(GCM_IV_BYTES);
    const header: BackupArchiveHeader = {
      format: BACKUP_ARCHIVE_FORMAT_VERSION,
      backupId,
      keyId,
      wrapIv: b64(wrapIv),
      wrappedKey: b64(wrappedKey),
      wrapTag: b64(wrapTag),
      iv: b64(iv),
      cipher: 'aes-256-gcm',
    };
    const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
    if (headerBytes.length > MAX_HEADER_BYTES) {
      throw archiveMalformed('the header this installation produced exceeds its own ceiling');
    }
    const preamble = Buffer.concat([MAGIC, u32(headerBytes.length), headerBytes]);

    const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
    cipher.setAAD(preamble);

    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    const out = createWriteStream(archivePath, { mode: 0o600 });

    // The preamble is cleartext and goes in ahead of the cipher, so it is
    // written directly rather than through the pipeline.
    await new Promise<void>((resolve, reject) => {
      out.write(preamble, (error) => (error ? reject(error) : resolve()));
    });

    // Manifest first, then the dump, both through the same cipher, so the
    // manifest is inside the authenticated encrypted region with the bytes it
    // describes.
    const plaintext = Readable.from(
      (async function* () {
        yield u32(manifestBytes.length);
        yield manifestBytes;
        for await (const chunk of createReadStream(dumpPath)) yield chunk as Buffer;
      })(),
    );

    await pipeline(plaintext, cipher, out, { end: false });

    const tag = cipher.getAuthTag();
    await new Promise<void>((resolve, reject) => {
      out.end(tag, () => resolve());
      out.once('error', reject);
    });

    const { size } = await stat(archivePath);
    return { archiveBytes: size, keyId };
  } finally {
    // The data key is the one value in this function that must not outlive it.
    dataKey.fill(0);
  }
}

/**
 * Reads and validates the cleartext preamble WITHOUT decrypting anything.
 *
 * Restore tooling calls this first so it can refuse an archive it cannot read —
 * a future format version, a file that is not one of ours, a truncated
 * download — before it asks for a key or touches a database.
 */
export async function readArchiveHeader(archivePath: string): Promise<{
  readonly header: BackupArchiveHeader;
  readonly preamble: Buffer;
  readonly payloadOffset: number;
  readonly archiveBytes: number;
}> {
  const { size } = await stat(archivePath);
  const handle = await open(archivePath, 'r');
  try {
    const fixed = Buffer.allocUnsafe(MAGIC.length + LENGTH_PREFIX_BYTES);
    const { bytesRead } = await handle.read(fixed, 0, fixed.length, 0);
    if (bytesRead < fixed.length) throw archiveMalformed('shorter than a header');
    if (!fixed.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw archiveMalformed('the magic bytes are not a Nexa backup archive');
    }

    const headerLength = fixed.readUInt32BE(MAGIC.length);
    if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
      throw archiveMalformed(`the declared header length (${headerLength}) is not plausible`);
    }

    const payloadOffset = fixed.length + headerLength;
    // A header cannot be valid if the payload it introduces cannot exist. The
    // tag is mandatory, so a file this short is truncated whatever it says.
    if (size < payloadOffset + GCM_TAG_BYTES) {
      throw archiveMalformed('truncated: the file ends inside its own header or tag');
    }

    const headerBytes = Buffer.allocUnsafe(headerLength);
    const read = await handle.read(headerBytes, 0, headerLength, fixed.length);
    if (read.bytesRead < headerLength) throw archiveMalformed('truncated inside the header');

    let parsed: unknown;
    try {
      parsed = JSON.parse(headerBytes.toString('utf8'));
    } catch {
      throw archiveMalformed('the header is not JSON');
    }
    const header = backupArchiveHeaderSchema.safeParse(parsed);
    if (!header.success) {
      throw archiveMalformed(
        `the header does not match the format this release reads (format ${BACKUP_ARCHIVE_FORMAT_VERSION})`,
      );
    }

    return {
      header: header.data,
      preamble: Buffer.concat([fixed, headerBytes]),
      payloadOffset,
      archiveBytes: size,
    };
  } finally {
    await handle.close();
  }
}

export interface OpenResult {
  readonly manifest: BackupManifest;
  /** SHA-256 of the DECRYPTED dump, as written. Compare against the manifest. */
  readonly dumpChecksum: string;
  readonly dumpBytes: number;
}

/**
 * Decrypts `archivePath` into `dumpPath` and returns what it contained.
 *
 * This is the REAL restore path, used verbatim by the pipeline's own
 * verification stage and by the operator's restore command. There is one
 * implementation on purpose: a verification that decrypted by some other route
 * would be proving a path nobody restores through.
 *
 * Nothing here trusts the archive before the tag has authenticated it. The
 * decipher's `final()` is what enforces that, so the manifest is parsed from a
 * complete, authenticated plaintext and never from a partial stream — a
 * streaming parse would be acting on attacker-chosen bytes before the tag was
 * checked, which is the classic misuse of authenticated encryption.
 */
export async function openArchive(input: {
  readonly archivePath: string;
  readonly dumpPath: string;
  readonly keyring: SecretKeyring;
}): Promise<OpenResult> {
  const { archivePath, dumpPath, keyring } = input;
  const { header, preamble, payloadOffset, archiveBytes } = await readArchiveHeader(archivePath);

  const kek = keyFor(keyring, header.keyId);
  const tagOffset = archiveBytes - GCM_TAG_BYTES;

  const handle = await open(archivePath, 'r');
  let tag: Buffer;
  try {
    tag = Buffer.allocUnsafe(GCM_TAG_BYTES);
    const { bytesRead } = await handle.read(tag, 0, GCM_TAG_BYTES, tagOffset);
    if (bytesRead < GCM_TAG_BYTES) throw archiveMalformed('truncated: no authentication tag');
  } finally {
    await handle.close();
  }

  let dataKey: Buffer;
  try {
    const unwrap = createDecipheriv('aes-256-gcm', kek, unb64(header.wrapIv));
    unwrap.setAAD(wrapAad(header.backupId, header.keyId));
    unwrap.setAuthTag(unb64(header.wrapTag));
    dataKey = Buffer.concat([unwrap.update(unb64(header.wrappedKey)), unwrap.final()]);
  } catch {
    throw archiveAuthFailed('the data key did not unwrap under this key');
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', dataKey, unb64(header.iv));
    decipher.setAAD(preamble);
    decipher.setAuthTag(tag);

    // A single decipher, two consumers of its output: the manifest header at
    // the front, then the dump. The prefix is buffered — it is four bytes plus
    // a manifest — and everything after it goes straight to disk.
    const digest = createHash('sha256');
    const out = createWriteStream(dumpPath, { mode: 0o600 });
    let dumpBytes = 0;
    let prefix = Buffer.alloc(0);
    // A holder rather than a `let`. The split generator below assigns it from
    // inside a closure, and TypeScript's flow analysis cannot see that, so a
    // plain `let` narrows to `null` at every use after the guard.
    const found: { manifest: Buffer | null; badLength: boolean } = {
      manifest: null,
      badLength: false,
    };
    let manifestLength = -1;

    const source = createReadStream(archivePath, {
      start: payloadOffset,
      end: tagOffset - 1,
    });

    const split = async function* (
      chunks: AsyncIterable<Buffer>,
    ): AsyncGenerator<Buffer, void, undefined> {
      for await (const chunk of chunks) {
        let rest = chunk;
        if (found.manifest === null && !found.badLength) {
          prefix = Buffer.concat([prefix, rest]);
          if (manifestLength < 0) {
            if (prefix.length < LENGTH_PREFIX_BYTES) continue;
            manifestLength = prefix.readUInt32BE(0);
            if (manifestLength === 0 || manifestLength > MAX_MANIFEST_BYTES) {
              // NOTHING IS TRUSTED YET. These four bytes came out of the
              // decipher and the authentication tag has not been checked, so a
              // throw here would be acting on attacker-chosen plaintext — and
              // it did: a single flipped bit in the first ciphertext byte
              // reported a malformed archive instead of a failed
              // authentication, which is both the wrong answer and an oracle.
              //
              // So the length is only RECORDED as implausible. The stream is
              // drained to the sink so the pipeline still reaches the
              // decipher's `final()`, which either raises the authentication
              // failure that is the real answer, or proves the bytes are
              // genuinely ours and the archive genuinely malformed.
              found.badLength = true;
              rest = prefix;
              prefix = Buffer.alloc(0);
            }
          }
          if (!found.badLength) {
            if (prefix.length < LENGTH_PREFIX_BYTES + manifestLength) continue;
            found.manifest = prefix.subarray(
              LENGTH_PREFIX_BYTES,
              LENGTH_PREFIX_BYTES + manifestLength,
            );
            rest = prefix.subarray(LENGTH_PREFIX_BYTES + manifestLength);
            prefix = Buffer.alloc(0);
          }
        }
        if (rest.length > 0) {
          dumpBytes += rest.length;
          digest.update(rest);
          yield rest;
        }
      }
    };

    try {
      await pipeline(source, decipher, split, out);
    } catch (error) {
      // `pipeline` surfaces the decipher's `final()` here. GCM reports a bad
      // tag as a plain `Error: Unsupported state or unable to authenticate
      // data`, which covers a wrong key, a modified byte and a truncated file
      // alike — and all three are the same answer.
      if (error instanceof NexaError) throw error;
      throw archiveAuthFailed('the payload did not authenticate');
    }

    // Reached only once `final()` has authenticated the payload, so everything
    // below is a statement about bytes we wrote, not about bytes somebody sent.
    if (found.badLength) {
      throw archiveMalformed(
        `authenticated, and the declared manifest length (${manifestLength}) is not plausible`,
      );
    }
    if (found.manifest === null) {
      throw archiveMalformed('authenticated, but shorter than its own manifest');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(found.manifest.toString('utf8'));
    } catch {
      throw archiveMalformed('the manifest is not JSON');
    }
    const manifest = backupManifestSchema.safeParse(parsed);
    if (!manifest.success) {
      throw archiveMalformed('the manifest does not match the schema this release reads');
    }
    if (manifest.data.backupId !== header.backupId) {
      // Both are authenticated, so this is not an attack — it is a bug in
      // whatever wrote the archive, and a restore that ignored it would report
      // one backup id while restoring another.
      throw archiveMalformed('the manifest and the header name different backups');
    }

    return {
      manifest: manifest.data,
      dumpChecksum: digest.digest('hex'),
      dumpBytes,
    };
  } finally {
    dataKey.fill(0);
  }
}

/** SHA-256 over a file, streamed. The checksum the manifest carries. */
export async function checksumFile(path: string): Promise<{ checksum: string; bytes: number }> {
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    digest.update(buffer);
  }
  return { checksum: digest.digest('hex'), bytes };
}
