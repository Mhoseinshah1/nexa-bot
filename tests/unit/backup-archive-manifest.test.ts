import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_ARCHIVE_FORMAT_VERSION,
  BACKUP_ARCHIVE_MAGIC,
  PLATFORM_ERROR_CODES,
  type BackupManifest,
} from '@nexa/contracts';
import { openArchive } from '../../apps/api/src/modules/platform/backup/infrastructure/archive';
import type { SecretKeyring } from '../../apps/api/src/infrastructure/crypto/keyring';

/**
 * The manifest checks inside `openArchive` (E4: "invalid manifest").
 *
 * `sealArchive` cannot produce any of these archives — it derives the header
 * from the manifest and always writes valid JSON — so until this file the four
 * branches after authentication were untested, and B15 (manifest and header
 * naming different backups) was recorded as "could not be falsified".
 *
 * So the archive is assembled HERE, by hand, with the same primitives the
 * format documents (`archive.ts`): a random data key wrapped under the keyring's
 * KEK with the wrap AAD, the preamble as the payload's AAD, and an arbitrary
 * plaintext. Every archive below AUTHENTICATES — it is exactly what a second,
 * buggy writer with the right key would produce — which is what makes the
 * manifest checks, rather than the tag, the thing under test. The last case
 * proves the order: a tag flip on the same crafted file is an authentication
 * failure, never a manifest complaint.
 */

const KEY_ID = 'k1';
const BACKUP_ID = '0192f000-0000-7000-8000-00000000beef';

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function manifestFor(backupId: string, dump: Buffer): BackupManifest {
  return {
    manifestVersion: 1,
    backupId,
    installationId: 'installation-under-test',
    createdAt: '2026-01-01T00:00:00.000Z',
    databaseName: 'nexa',
    postgresVersion: '16.13',
    pgDumpVersion: 'pg_dump (PostgreSQL) 16.13',
    dumpFormat: 'custom',
    dumpBytes: dump.length,
    checksumAlgorithm: 'sha256',
    checksum: 'a'.repeat(64),
    exclusions: [],
  };
}

/**
 * A NEXABAK1 archive whose encrypted region is `plaintext`, verbatim — the
 * manifest length prefix included, so a test can make it lie.
 */
function craft(kek: Buffer, plaintext: Buffer, headerBackupId = BACKUP_ID): Buffer {
  const dataKey = randomBytes(32);
  const wrapIv = randomBytes(12);
  const wrap = createCipheriv('aes-256-gcm', kek, wrapIv);
  wrap.setAAD(Buffer.from(`nexa.backup.wrap.v1|${headerBackupId}|${KEY_ID}`, 'utf8'));
  const wrappedKey = Buffer.concat([wrap.update(dataKey), wrap.final()]);
  const wrapTag = wrap.getAuthTag();
  const iv = randomBytes(12);
  const header = Buffer.from(
    JSON.stringify({
      format: BACKUP_ARCHIVE_FORMAT_VERSION,
      backupId: headerBackupId,
      keyId: KEY_ID,
      wrapIv: wrapIv.toString('base64url'),
      wrappedKey: wrappedKey.toString('base64url'),
      wrapTag: wrapTag.toString('base64url'),
      iv: iv.toString('base64url'),
      cipher: 'aes-256-gcm',
    }),
    'utf8',
  );
  const preamble = Buffer.concat([
    Buffer.from(BACKUP_ARCHIVE_MAGIC, 'ascii'),
    u32(header.length),
    header,
  ]);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(preamble);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([preamble, ciphertext, cipher.getAuthTag()]);
}

/** The plaintext a correct writer produces: length, manifest, dump. */
function framed(manifest: Buffer, dump: Buffer, declaredLength = manifest.length): Buffer {
  return Buffer.concat([u32(declaredLength), manifest, dump]);
}

describe('an authenticated archive whose manifest is wrong', () => {
  let dir: string;
  let kek: Buffer;
  let keyring: SecretKeyring;
  let dump: Buffer;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexa-manifest-'));
    kek = randomBytes(32);
    keyring = { activeKeyId: KEY_ID, keys: new Map([[KEY_ID, kek]]), format: 'canonical' };
    dump = Buffer.concat([Buffer.from('PGDMP'), randomBytes(5000)]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function open(archive: Buffer) {
    const archivePath = join(dir, 'archive.nxb');
    await writeFile(archivePath, archive);
    return openArchive({ archivePath, dumpPath: join(dir, 'dump.pgcustom'), keyring });
  }

  const malformed = (detail: RegExp) =>
    expect.objectContaining({
      code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_MALFORMED,
      message: expect.stringMatching(detail),
    });

  it('opens a correctly framed crafted archive — the positive control for this harness', async () => {
    const manifest = Buffer.from(JSON.stringify(manifestFor(BACKUP_ID, dump)), 'utf8');
    const opened = await open(craft(kek, framed(manifest, dump)));
    expect(opened.manifest.backupId).toBe(BACKUP_ID);
    expect(opened.dumpBytes).toBe(dump.length);
    expect(await readFile(join(dir, 'dump.pgcustom'))).toEqual(dump);
  });

  it('refuses a manifest that is not JSON', async () => {
    const notJson = Buffer.from('{"manifestVersion": 1, this is not json', 'utf8');
    await expect(open(craft(kek, framed(notJson, dump)))).rejects.toEqual(
      malformed(/the manifest is not JSON/),
    );
  });

  it('refuses JSON that does not match the manifest schema', async () => {
    const { checksum: _dropped, ...withoutChecksum } = manifestFor(BACKUP_ID, dump);
    void _dropped;
    const missing = Buffer.from(JSON.stringify(withoutChecksum), 'utf8');
    await expect(open(craft(kek, framed(missing, dump)))).rejects.toEqual(
      malformed(/does not match the schema/),
    );
    const wrongFormat = Buffer.from(
      JSON.stringify({ ...manifestFor(BACKUP_ID, dump), dumpFormat: 'plain' }),
      'utf8',
    );
    await expect(open(craft(kek, framed(wrongFormat, dump)))).rejects.toEqual(
      malformed(/does not match the schema/),
    );
  });

  it('refuses a declared manifest length that runs past the payload', async () => {
    const manifest = Buffer.from(JSON.stringify(manifestFor(BACKUP_ID, dump)), 'utf8');
    // Plausible (under the 1 MiB ceiling) and longer than everything that follows.
    const overrun = framed(manifest, Buffer.alloc(0), manifest.length + 4096);
    await expect(open(craft(kek, overrun))).rejects.toEqual(
      malformed(/shorter than its own manifest/),
    );
  });

  it('refuses an implausible declared manifest length — only AFTER authentication', async () => {
    const manifest = Buffer.from(JSON.stringify(manifestFor(BACKUP_ID, dump)), 'utf8');
    const implausible = framed(manifest, dump, 2 * 1024 * 1024);
    await expect(open(craft(kek, implausible))).rejects.toEqual(
      malformed(/authenticated, and the declared manifest length/),
    );
    const zero = framed(manifest, dump, 0);
    await expect(open(craft(kek, zero))).rejects.toEqual(
      malformed(/declared manifest length \(0\)/),
    );
  });

  it('refuses a manifest that names a different backup from its header (B15)', async () => {
    const other = '0192f000-0000-7000-8000-00000000f00d';
    const manifest = Buffer.from(JSON.stringify(manifestFor(other, dump)), 'utf8');
    await expect(open(craft(kek, framed(manifest, dump), BACKUP_ID))).rejects.toEqual(
      malformed(/name different backups/),
    );
  });

  it('authenticates BEFORE it reads the manifest: a tag flip on a bad manifest is an auth failure', async () => {
    const notJson = Buffer.from('not json at all', 'utf8');
    const archive = craft(kek, framed(notJson, dump));
    archive[archive.length - 1] = (archive[archive.length - 1] ?? 0) ^ 0x01;
    await expect(open(archive)).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_AUTH_FAILED,
    });
  });
});
