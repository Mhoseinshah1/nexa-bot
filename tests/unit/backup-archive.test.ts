import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_ARCHIVE_MAGIC, type BackupManifest } from '@nexa/contracts';
import {
  checksumFile,
  openArchive,
  readArchiveHeader,
  sealArchive,
} from '../../apps/api/src/modules/platform/backup/infrastructure/archive';
import type { SecretKeyring } from '../../apps/api/src/infrastructure/crypto/keyring';

/**
 * The encrypted archive format.
 *
 * Every test here is a property a restore depends on, and each one is written
 * so that removing the rule it names makes it fail. The interesting half is not
 * "a round trip works" — it is the four ways an archive can be wrong and the
 * requirement that all four are refused rather than partially accepted.
 */

const KEY_A = 'ka';
const KEY_B = 'kb';

/** Changes one base64url character to another, keeping the length identical. */
function flip(value: string): string {
  const head = value[0] === 'A' ? 'B' : 'A';
  return head + value.slice(1);
}

function keyringWith(
  entries: readonly (readonly [string, Buffer])[],
  active: string,
): SecretKeyring {
  return { activeKeyId: active, keys: new Map(entries), format: 'canonical' };
}

describe('the backup archive format', () => {
  let dir: string;
  let keyA: Buffer;
  let keyB: Buffer;
  let ring: SecretKeyring;
  let dumpPath: string;
  let archivePath: string;
  let payload: Buffer;
  let checksum: string;
  let manifest: BackupManifest;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexa-archive-'));
    keyA = randomBytes(32);
    keyB = randomBytes(32);
    ring = keyringWith([[KEY_A, keyA]], KEY_A);
    dumpPath = join(dir, 'dump.pgcustom');
    archivePath = join(dir, 'archive.nxb');

    // Deliberately NOT valid UTF-8, and deliberately larger than one stream
    // chunk. `pg_dump`'s custom format is a compressed binary container: a
    // cipher that decoded it as a string would silently replace every invalid
    // sequence with U+FFFD, and a single-chunk payload would never exercise the
    // streaming split that separates the manifest from the dump.
    payload = Buffer.concat([
      Buffer.from([0x50, 0x47, 0x44, 0x4d, 0x50, 0xff, 0xfe, 0x00, 0x80]),
      randomBytes(400_000),
    ]);
    await writeFile(dumpPath, payload);
    checksum = (await checksumFile(dumpPath)).checksum;

    manifest = {
      manifestVersion: 1,
      backupId: '0192f000-0000-7000-8000-00000000aaaa',
      installationId: 'installation-under-test',
      createdAt: '2026-01-01T00:00:00.000Z',
      databaseName: 'nexa',
      postgresVersion: '16.13',
      pgDumpVersion: 'pg_dump (PostgreSQL) 16.13',
      dumpFormat: 'custom',
      dumpBytes: payload.length,
      checksumAlgorithm: 'sha256',
      checksum,
      exclusions: [],
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips binary bytes exactly, which the string cipher cannot', async () => {
    await sealArchive({ dumpPath, archivePath, manifest, keyring: ring });
    const out = join(dir, 'out.pgcustom');
    const opened = await openArchive({ archivePath, dumpPath: out, keyring: ring });

    // Byte-for-byte, not "same length" and not "same checksum" alone. The
    // failure this guards against — a UTF-8 round trip — changes both the
    // length and the content, so asserting the bytes is what proves it did not
    // happen.
    expect(await readFile(out)).toEqual(payload);
    expect(opened.dumpChecksum).toBe(checksum);
    expect(opened.dumpBytes).toBe(payload.length);
    expect(opened.manifest).toEqual(manifest);
  });

  it('never writes the plaintext dump into the archive', async () => {
    await sealArchive({ dumpPath, archivePath, manifest, keyring: ring });
    const archive = await readFile(archivePath);

    // The archive must not contain the plaintext anywhere. A recognisable
    // prefix is enough to prove it: if the payload had been written through, or
    // written beside the ciphertext, this run of bytes would be findable.
    expect(archive.includes(payload.subarray(0, 64))).toBe(false);
    // Nor may the manifest's own text leak into the cleartext preamble: it
    // names the database and the installation and travels inside the encrypted
    // region on purpose.
    expect(archive.includes(Buffer.from('installation-under-test', 'utf8'))).toBe(false);
    expect(archive.includes(Buffer.from('nexa_dev', 'utf8'))).toBe(false);
    // What IS in the clear is the magic and the header, and nothing else.
    expect(archive.subarray(0, 8).toString('ascii')).toBe(BACKUP_ARCHIVE_MAGIC);
  });

  it('puts no key material in the cleartext header', async () => {
    await sealArchive({ dumpPath, archivePath, manifest, keyring: ring });
    const { header } = await readArchiveHeader(archivePath);
    const archive = await readFile(archivePath);

    // The KEK itself must appear nowhere in the file, and neither must the data
    // key it wraps. The header carries the WRAPPED key, which is the point of
    // envelope encryption; a test that only checked the header's field names
    // would pass even if the raw key were beside them.
    expect(archive.includes(keyA)).toBe(false);
    expect(header.keyId).toBe(KEY_A);
    expect(Object.keys(header).sort()).toEqual(
      ['backupId', 'cipher', 'format', 'iv', 'keyId', 'wrapIv', 'wrapTag', 'wrappedKey'].sort(),
    );
  });

  it('refuses the wrong key', async () => {
    await sealArchive({ dumpPath, archivePath, manifest, keyring: ring });
    // Same key ID, different bytes: this is the case a key-id check alone would
    // wave through.
    const impostor = keyringWith([[KEY_A, keyB]], KEY_A);
    await expect(
      openArchive({ archivePath, dumpPath: join(dir, 'x'), keyring: impostor }),
    ).rejects.toMatchObject({ code: 'backup.archive_auth_failed' });
  });

  it('names the key it needs when the keyring does not hold it', async () => {
    await sealArchive({ dumpPath, archivePath, manifest, keyring: ring });
    const other = keyringWith([[KEY_B, keyB]], KEY_B);
    await expect(
      openArchive({ archivePath, dumpPath: join(dir, 'x'), keyring: other }),
    ).rejects.toMatchObject({ code: 'platform.secret_key_unknown' });
  });

  it('decrypts under a rotated keyring that still holds the archive key', async () => {
    await sealArchive({ dumpPath, archivePath, manifest, keyring: ring });
    // The rotation case, and the reason the archive names a key at all: B is
    // now active, A is retained. An archive taken before the rotation must
    // still open, or a rotation silently destroys every backup taken before it.
    const rotated = keyringWith(
      [
        [KEY_A, keyA],
        [KEY_B, keyB],
      ],
      KEY_B,
    );
    const opened = await openArchive({
      archivePath,
      dumpPath: join(dir, 'rot'),
      keyring: rotated,
    });
    expect(opened.dumpChecksum).toBe(checksum);
  });

  it('detects a single modified byte anywhere in the ciphertext', async () => {
    await sealArchive({ dumpPath, archivePath, manifest, keyring: ring });
    const original = await readFile(archivePath);

    // Three positions: just after the header, the middle, and the last byte
    // before the tag. One flipped bit in each. A check that only tested the
    // middle would miss an implementation that authenticated a prefix.
    const { payloadOffset, archiveBytes } = await readArchiveHeader(archivePath);
    const positions = [payloadOffset, Math.floor(archiveBytes / 2), archiveBytes - 17];
    for (const position of positions) {
      const corrupt = Buffer.from(original);
      corrupt[position] = (corrupt[position] ?? 0) ^ 0x01;
      const path = join(dir, `corrupt-${String(position)}.nxb`);
      await writeFile(path, corrupt);
      await expect(
        openArchive({ archivePath: path, dumpPath: join(dir, 'c'), keyring: ring }),
      ).rejects.toMatchObject({ code: 'backup.archive_auth_failed' });
    }
  });

  it('detects a modified authentication tag', async () => {
    await sealArchive({ dumpPath, archivePath, manifest, keyring: ring });
    const original = await readFile(archivePath);
    const corrupt = Buffer.from(original);
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 0xff;
    const path = join(dir, 'badtag.nxb');
    await writeFile(path, corrupt);
    await expect(
      openArchive({ archivePath: path, dumpPath: join(dir, 't'), keyring: ring }),
    ).rejects.toMatchObject({ code: 'backup.archive_auth_failed' });
  });

  it('detects truncation, including truncation that removes only the tag', async () => {
    await sealArchive({ dumpPath, archivePath, manifest, keyring: ring });
    const original = await readFile(archivePath);

    // Exactly-the-tag is the interesting case: the file is still a well-formed
    // header followed by a complete-looking ciphertext, and only the absence of
    // sixteen bytes says otherwise. A reader that took its tag from wherever the
    // file happened to end would decrypt this into a truncated database.
    for (const cut of [16, 1024, Math.floor(original.length / 2)]) {
      const path = join(dir, `trunc-${String(cut)}.nxb`);
      await writeFile(path, original.subarray(0, original.length - cut));
      await expect(
        openArchive({ archivePath: path, dumpPath: join(dir, 'tr'), keyring: ring }),
      ).rejects.toThrowError(/authenticate|truncated/i);
    }
  });

  it('refuses an edited header rather than decrypting under it', async () => {
    await sealArchive({ dumpPath, archivePath, manifest, keyring: ring });
    const original = await readFile(archivePath);
    const { payloadOffset } = await readArchiveHeader(archivePath);
    const headerText = original.subarray(8 + 4, payloadOffset).toString('utf8');

    // Same length, different content: the backup id in the header is changed to
    // another valid UUID. The header is the payload's associated data, so this
    // must fail authentication — not decrypt into a dump filed under the wrong
    // identity.
    const edited = Buffer.from(original);
    const swapped = headerText.replace('00000000aaaa', '00000000bbbb');
    expect(swapped).not.toBe(headerText);
    expect(swapped.length).toBe(headerText.length);
    edited.write(swapped, 8 + 4, 'utf8');
    const path = join(dir, 'edited.nxb');
    await writeFile(path, edited);
    await expect(
      openArchive({ archivePath: path, dumpPath: join(dir, 'e'), keyring: ring }),
    ).rejects.toMatchObject({ code: 'backup.archive_auth_failed' });
  });

  it('rejects a file that is not an archive before it tries any key', async () => {
    const junk = join(dir, 'junk.nxb');
    await writeFile(junk, randomBytes(4096));
    await expect(readArchiveHeader(junk)).rejects.toMatchObject({
      code: 'backup.archive_malformed',
    });
    // MALFORMED, not AUTH_FAILED. The distinction is what lets a restore tool
    // say "this is not a Nexa backup" without implying it tried a key.
    await expect(
      openArchive({ archivePath: junk, dumpPath: join(dir, 'j'), keyring: ring }),
    ).rejects.toMatchObject({ code: 'backup.archive_malformed' });
  });

  it('rejects an implausible header length without allocating it', async () => {
    const path = join(dir, 'huge-header.nxb');
    const header = Buffer.alloc(12);
    header.write(BACKUP_ARCHIVE_MAGIC, 0, 'ascii');
    header.writeUInt32BE(0xfffffff0, 8);
    await writeFile(path, Buffer.concat([header, randomBytes(64)]));
    await expect(readArchiveHeader(path)).rejects.toMatchObject({
      code: 'backup.archive_malformed',
    });
  });

  it('rejects a header from a format version this release cannot read', async () => {
    await sealArchive({ dumpPath, archivePath, manifest, keyring: ring });
    const original = await readFile(archivePath);
    const { payloadOffset } = await readArchiveHeader(archivePath);
    const edited = Buffer.from(original);
    const headerText = edited.subarray(12, payloadOffset).toString('utf8');
    const bumped = headerText.replace('"format":1', '"format":9');
    expect(bumped.length).toBe(headerText.length);
    edited.write(bumped, 12, 'utf8');
    const path = join(dir, 'future.nxb');
    await writeFile(path, edited);
    await expect(readArchiveHeader(path)).rejects.toMatchObject({
      code: 'backup.archive_malformed',
    });
  });

  it('gives every archive fresh key material and fresh nonces', async () => {
    const first = join(dir, 'one.nxb');
    const second = join(dir, 'two.nxb');
    await sealArchive({ dumpPath, archivePath: first, manifest, keyring: ring });
    await sealArchive({ dumpPath, archivePath: second, manifest, keyring: ring });

    const a = (await readArchiveHeader(first)).header;
    const b = (await readArchiveHeader(second)).header;

    // The NONCES, field by field, not merely "the files differ". Two archives
    // differ as soon as the data key is fresh, so a whole-file comparison stays
    // green with a hard-coded IV — which a falsification run confirmed. Under
    // AES-GCM a repeated nonce is the failure that costs the key rather than
    // the message, so it is asserted where it lives.
    expect(a.iv).not.toBe(b.iv);
    expect(a.wrapIv).not.toBe(b.wrapIv);
    // And the wrapped key differs, which is what proves the data key is
    // per-archive rather than derived from the KEK once.
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
    expect(await readFile(first)).not.toEqual(await readFile(second));
  });

  it('refuses an archive with ANY header field edited', async () => {
    // The real guarantee, and it is stated here rather than in a comment
    // because a comment claiming it went unchecked for a round: every header
    // field is cryptographically load-bearing, by one mechanism or another.
    // `keyId` and `backupId` are the key-unwrap's associated data, the three
    // wrap fields are the wrap itself, `iv` is the payload nonce, and `format`
    // and `cipher` are literals the schema pins. Editing any one is refused.
    // A keyring holding BOTH keys, so the `keyId` edit selects a key this
    // installation really has. Against a single-key ring it would fail as "no
    // such key", which is a configuration answer rather than a cryptographic
    // one and would not prove the field is bound.
    const both = keyringWith(
      [
        [KEY_A, keyA],
        [KEY_B, keyB],
      ],
      KEY_A,
    );
    await sealArchive({ dumpPath, archivePath, manifest, keyring: both });
    const original = await readFile(archivePath);
    const { payloadOffset, header } = await readArchiveHeader(archivePath);
    const headerText = original.subarray(12, payloadOffset).toString('utf8');

    // Same-length substitutions, so the length prefix stays honest and the only
    // thing that changed is the value.
    //
    // The expected CODE is part of each row, not a loose "it threw something".
    // A regex accepting either refusal let a real mutation survive: dropping
    // `backupId` and `keyId` from the key-unwrap's associated data still failed
    // the run, because the edited id was then caught downstream by the
    // manifest-versus-header comparison and reported as MALFORMED. Same red,
    // different mechanism, and the binding under test was gone. Pinning the
    // code per field is what makes each row name one rule.
    const AUTH = 'backup.archive_auth_failed';
    const MALFORMED = 'backup.archive_malformed';
    const edits: [keyof typeof header, string, string, string][] = [
      // Bound as the key-unwrap's associated data.
      ['backupId', '00000000aaaa', '00000000bbbb', AUTH],
      ['keyId', `"keyId":"${KEY_A}"`, `"keyId":"${KEY_B}"`, AUTH],
      // The wrap itself.
      ['wrapIv', `"wrapIv":"${header.wrapIv}"`, `"wrapIv":"${flip(header.wrapIv)}"`, AUTH],
      [
        'wrappedKey',
        `"wrappedKey":"${header.wrappedKey}"`,
        `"wrappedKey":"${flip(header.wrappedKey)}"`,
        AUTH,
      ],
      ['wrapTag', `"wrapTag":"${header.wrapTag}"`, `"wrapTag":"${flip(header.wrapTag)}"`, AUTH],
      // The payload nonce.
      ['iv', `"iv":"${header.iv}"`, `"iv":"${flip(header.iv)}"`, AUTH],
      // Literals the schema pins, so these are refused before any key is used.
      ['format', '"format":1', '"format":2', MALFORMED],
      ['cipher', '"cipher":"aes-256-gcm"', '"cipher":"aes-256-cbc"', MALFORMED],
    ];

    for (const [field, from, to, code] of edits) {
      expect(headerText).toContain(from);
      expect(to.length).toBe(from.length);
      const edited = Buffer.from(original);
      edited.write(headerText.replace(from, to), 12, 'utf8');
      const path = join(dir, `edited-${String(field)}.nxb`);
      await writeFile(path, edited);
      // Refused — by whichever mechanism protects that field. What must never
      // happen is that it decrypts into something the edit chose.
      await expect(
        openArchive({
          archivePath: path,
          dumpPath: join(dir, `o-${String(field)}`),
          keyring: both,
        }),
      ).rejects.toMatchObject({ code });
    }
  });

  it('carries an empty exclusion list, because nothing is excluded', async () => {
    // A property of the artifact, not of the code that made it. If an exclusion
    // is ever added, this fails and whoever added it has to state the reason in
    // the manifest where a restorer can read it.
    await sealArchive({ dumpPath, archivePath, manifest, keyring: ring });
    const opened = await openArchive({ archivePath, dumpPath: join(dir, 'x'), keyring: ring });
    expect(opened.manifest.exclusions).toEqual([]);
  });
});
