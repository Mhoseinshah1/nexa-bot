import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdtemp, open, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLATFORM_ERROR_CODES, type BackupManifest } from '@nexa/contracts';
import {
  isSevenZipFile,
  openSevenZip,
  sealSevenZip,
  type SevenZipOptions,
} from '../../apps/api/src/modules/platform/backup/infrastructure/seven-zip';
import { planArchiveParts } from '../../apps/api/src/modules/platform/backup/infrastructure/archive-parts';
import { DualFormatBackupArchiver } from '../../apps/api/src/modules/platform/backup/infrastructure/archiver';
import type { SecretKeyring } from '../../apps/api/src/infrastructure/crypto/keyring';

/**
 * The 7-Zip backup archive (Round 4 PR-E, E4), against the REAL 7-Zip binary.
 *
 * Not a fake: the properties are 7-Zip's — AES-256 with encrypted headers, the CRC that
 * catches a damaged part, the multi-volume layout a `.001` is opened as — and a fake this
 * repository wrote could only prove it agrees with the adapter this repository wrote
 * (CLAUDE.md, "learned by running a real panel"). 7-Zip is a dependency of the image
 * (`Dockerfile`) and of CI; this suite FAILS rather than skips without it.
 */

const PASSWORD = 'correct horse battery staple';
const OPTIONS: SevenZipOptions = {
  binary: process.env['BACKUP_SEVEN_ZIP_BIN'] ?? '7z',
  level: 1,
  threads: 2,
  memoryBudgetMb: 1_000,
  memoryHeadroomMb: 0,
  readAvailableMb: async () => null,
  sealTimeoutMs: 300_000,
  openTimeoutMs: 300_000,
};

function manifestFor(checksum: string, bytes: number): BackupManifest {
  return {
    manifestVersion: 1,
    backupId: '0193a000-0000-7000-8000-000000000001',
    installationId: 'installation-1',
    createdAt: '2026-10-19T04:00:00.000Z',
    databaseName: 'nexa',
    postgresVersion: '16.13',
    pgDumpVersion: 'pg_dump (PostgreSQL) 16.13',
    dumpFormat: 'custom',
    dumpBytes: bytes,
    checksumAlgorithm: 'sha256',
    checksum,
    exclusions: [],
  };
}

async function sha256Of(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest('hex');
}

/** Writes each planned part as its own file — what a person downloads from Telegram. */
async function writeParts(
  archivePath: string,
  directory: string,
  parts: readonly { start: number; end: number; filename: string }[],
): Promise<string[]> {
  const paths: string[] = [];
  for (const part of parts) {
    const path = join(directory, part.filename);
    await pipeline(
      createReadStream(archivePath, { start: part.start, end: part.end - 1 }),
      createWriteStream(path),
    );
    paths.push(path);
  }
  return paths;
}

describe('the 7-Zip backup archive (E4)', () => {
  let dir: string;
  let dumpPath: string;
  let dumpChecksum: string;
  let dumpBytes: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexa-7z-'));
    dumpPath = join(dir, 'dump.pgcustom');
    // Incompressible AND compressible bytes, so the archive spans several small parts.
    const body = Buffer.concat([
      Buffer.from('PGDMP'),
      randomBytes(300 * 1024),
      Buffer.from('COPY public.customers FROM stdin;\n'.repeat(4000)),
    ]);
    await writeFile(dumpPath, body);
    dumpChecksum = createHash('sha256').update(body).digest('hex');
    dumpBytes = body.length;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seal(password = PASSWORD): Promise<string> {
    const archivePath = join(dir, 'archive.7z');
    await sealSevenZip({
      dumpPath,
      archivePath,
      manifest: manifestFor(dumpChecksum, dumpBytes),
      password,
      options: OPTIONS,
    });
    return archivePath;
  }

  it('round-trips: the dump and its manifest come back, checksummed, with the password', async () => {
    const archivePath = await seal();
    expect(await isSevenZipFile(archivePath)).toBe(true);
    // The staging manifest beside the dump is gone again.
    await expect(stat(join(dir, 'manifest.json'))).rejects.toThrow();
    const opened = await openSevenZip({
      archivePath,
      dumpPath: join(dir, 'out.pgcustom'),
      passwords: [PASSWORD],
      options: OPTIONS,
    });
    expect(opened.dumpChecksum).toBe(dumpChecksum);
    expect(opened.dumpBytes).toBe(dumpBytes);
    expect(opened.manifest.checksum).toBe(dumpChecksum);
    expect(await sha256Of(join(dir, 'out.pgcustom'))).toBe(dumpChecksum);
  });

  it('encrypts the HEADERS: without the password not even the entry names are listed', async () => {
    const archivePath = await seal();
    let listing: string;
    try {
      listing = execFileSync(OPTIONS.binary, ['l', archivePath], {
        input: '\n',
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      listing = String((error as { stdout?: string }).stdout ?? '');
    }
    expect(listing).not.toContain('dump.pgcustom');
    expect(listing).not.toContain('manifest.json');
    // And the plaintext is nowhere in the file.
    const bytes = await readFile(archivePath);
    expect(bytes.includes(Buffer.from('COPY public.customers'))).toBe(false);
  });

  it('split/join round-trip: the parts open from the .001, and their concatenation opens too', async () => {
    const archivePath = await seal();
    const { size } = await stat(archivePath);
    const partBytes = 64 * 1024;
    const parts = await planArchiveParts({
      archivePath,
      partBytes,
      filename: 'nexa-backup.7z',
    });
    expect(parts.length).toBe(Math.ceil(size / partBytes));
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((part) => part.bytes <= partBytes)).toBe(true);
    expect(parts.map((part) => part.filename.slice(-4))).toEqual(
      parts.map((_, index) => `.${String(index + 1).padStart(3, '0')}`),
    );
    const partsDir = await mkdtemp(join(dir, 'parts-'));
    const paths = await writeParts(archivePath, partsDir, parts);
    // Each downloaded part matches the digest the summary message lists.
    for (const [index, path] of paths.entries()) {
      expect(await sha256Of(path)).toBe(parts[index]?.sha256);
    }
    // 7-Zip opens the set from the first volume — the owner's Windows instruction.
    const fromVolumes = await openSevenZip({
      archivePath: paths[0] ?? '',
      dumpPath: join(dir, 'from-volumes.pgcustom'),
      passwords: [PASSWORD],
      options: OPTIONS,
    });
    expect(fromVolumes.dumpChecksum).toBe(dumpChecksum);
    // The Web Admin and `botctl restore` join them: the concatenation IS the archive.
    const joined = join(dir, 'joined.bin');
    const out = createWriteStream(joined);
    for (const path of paths) {
      await pipeline(createReadStream(path), out, { end: false });
    }
    await new Promise<void>((resolve) => out.end(resolve));
    expect(await sha256Of(joined)).toBe(await sha256Of(archivePath));
    const fromJoined = await openSevenZip({
      archivePath: joined,
      dumpPath: join(dir, 'from-joined.pgcustom'),
      passwords: [PASSWORD],
      options: OPTIONS,
    });
    expect(fromJoined.dumpChecksum).toBe(dumpChecksum);
  });

  it('refuses a wrong password with the one auth-failed answer', async () => {
    const archivePath = await seal();
    await expect(
      openSevenZip({
        archivePath,
        dumpPath: join(dir, 'out.pgcustom'),
        passwords: ['not the password'],
        options: OPTIONS,
      }),
    ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_AUTH_FAILED });
    await expect(stat(join(dir, 'out.pgcustom'))).rejects.toThrow();
  });

  it('tries every candidate password in order, and says which opened it', async () => {
    const archivePath = await seal();
    const opened = await openSevenZip({
      archivePath,
      dumpPath: join(dir, 'out.pgcustom'),
      passwords: ['newer password', PASSWORD],
      options: OPTIONS,
    });
    expect(opened.passwordIndex).toBe(1);
    expect(opened.dumpChecksum).toBe(dumpChecksum);
  });

  it('refuses a set with a missing part as malformed, from the .001 and from a short join', async () => {
    const archivePath = await seal();
    const parts = await planArchiveParts({ archivePath, partBytes: 64 * 1024, filename: 'b.7z' });
    const partsDir = await mkdtemp(join(dir, 'parts-'));
    const paths = await writeParts(archivePath, partsDir, parts);
    await rm(paths[1] ?? '');
    await expect(
      openSevenZip({
        archivePath: paths[0] ?? '',
        dumpPath: join(dir, 'out.pgcustom'),
        passwords: [PASSWORD],
        options: OPTIONS,
      }),
    ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_MALFORMED });
    // The last part missing from a joined upload: the archive's own index is gone.
    const short = join(dir, 'short.bin');
    const out = createWriteStream(short);
    for (const path of paths.filter((_, index) => index !== 1 && index < paths.length - 1)) {
      await pipeline(createReadStream(path), out, { end: false });
    }
    await new Promise<void>((resolve) => out.end(resolve));
    await expect(
      openSevenZip({
        archivePath: short,
        dumpPath: join(dir, 'out2.pgcustom'),
        passwords: [PASSWORD],
        options: OPTIONS,
      }),
    ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_MALFORMED });
  });

  it('refuses a corrupted part (7-Zip CRC) and leaves no partial dump behind', async () => {
    const archivePath = await seal();
    const parts = await planArchiveParts({ archivePath, partBytes: 64 * 1024, filename: 'b.7z' });
    const partsDir = await mkdtemp(join(dir, 'parts-'));
    const paths = await writeParts(archivePath, partsDir, parts);
    const handle = await open(paths[2] ?? '', 'r+');
    await handle.write(Buffer.from([0xde, 0xad, 0xbe, 0xef]), 0, 4, 1000);
    await handle.close();
    // Its digest no longer matches the summary's, which is how an operator spots it first.
    expect(await sha256Of(paths[2] ?? '')).not.toBe(parts[2]?.sha256);
    await expect(
      openSevenZip({
        archivePath: paths[0] ?? '',
        dumpPath: join(dir, 'out.pgcustom'),
        passwords: [PASSWORD],
        options: OPTIONS,
      }),
    ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_AUTH_FAILED });
    await expect(stat(join(dir, 'out.pgcustom'))).rejects.toThrow();
  });

  it('never puts the password in argv: it travels on stdin', async () => {
    // A wrapper that records its arguments, then runs the real 7-Zip with them.
    const log = join(dir, 'argv.log');
    const wrapper = join(dir, '7z-wrapper.sh');
    await writeFile(
      wrapper,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec ${OPTIONS.binary} "$@"\n`,
    );
    await chmod(wrapper, 0o700);
    const wrapped = { ...OPTIONS, binary: wrapper };
    const archivePath = join(dir, 'wrapped.7z');
    await sealSevenZip({
      dumpPath,
      archivePath,
      manifest: manifestFor(dumpChecksum, dumpBytes),
      password: PASSWORD,
      options: wrapped,
    });
    await openSevenZip({
      archivePath,
      dumpPath: join(dir, 'out.pgcustom'),
      passwords: [PASSWORD],
      options: wrapped,
    });
    const argv = await readFile(log, 'utf8');
    expect(argv).toMatch(/^a /m);
    expect(argv).toMatch(/^l /m);
    expect(argv).toMatch(/^x /m);
    expect(argv).toContain('-mhe=on');
    expect(argv).not.toContain(PASSWORD);
    expect(argv).not.toMatch(/-p\S/);
  });

  it('the ONE open picks the container by magic bytes: keyring NXB without a password, 7z with one', async () => {
    const keyring = {
      activeKeyId: 'k1',
      keys: new Map([['k1', randomBytes(32)]]),
      format: 'canonical',
    } as SecretKeyring;
    let stored: { id: string; password: string }[] = [];
    const archiver = new DualFormatBackupArchiver(
      keyring,
      {
        current: async () => stored[0] ?? null,
        all: async () => stored,
      },
      OPTIONS,
    );
    const manifest = manifestFor(dumpChecksum, dumpBytes);
    // No password stored: the keyring container, exactly as before E4.
    expect(await archiver.nextFormat()).toBe('NXB');
    const nxb = await archiver.seal({
      dumpPath,
      archivePath: join(dir, 'archive.nxb'),
      sevenZipPath: join(dir, 'archive.7z'),
      manifest,
    });
    expect(nxb.format).toBe('NXB');
    expect(nxb.archivePath).toBe(join(dir, 'archive.nxb'));
    // A password set: the next seal is a 7z under it.
    stored = [{ id: 'p2', password: PASSWORD }];
    expect(await archiver.nextFormat()).toBe('SEVEN_ZIP');
    const sevenZip = await archiver.seal({
      dumpPath,
      archivePath: join(dir, 'archive.nxb'),
      sevenZipPath: join(dir, 'archive.7z'),
      manifest,
    });
    expect(sevenZip).toMatchObject({ format: 'SEVEN_ZIP', passwordId: 'p2', keyId: null });
    // A replaced password is superseded, not lost: an older archive still opens.
    stored = [{ id: 'p3', password: 'a newer password entirely' }, ...stored];
    const fromNxb = await archiver.open({
      archivePath: join(dir, 'archive.nxb'),
      dumpPath: join(dir, 'a'),
    });
    const from7z = await archiver.open({
      archivePath: join(dir, 'archive.7z'),
      dumpPath: join(dir, 'b'),
    });
    expect(fromNxb).toMatchObject({ format: 'NXB', dumpChecksum });
    expect(from7z).toMatchObject({ format: 'SEVEN_ZIP', dumpChecksum });
    // An explicit password (an uploaded archive) is the only one tried.
    await expect(
      archiver.open({
        archivePath: join(dir, 'archive.7z'),
        dumpPath: join(dir, 'c'),
        passwords: ['nope'],
      }),
    ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_AUTH_FAILED });
  });
});

/*
 * A > 2 GiB dump, streamed (E4). The dump is a SPARSE file, so it occupies no disk, and
 * the extraction goes to /dev/null, so it occupies none either; what is measured is that
 * nothing in seal, open or the part planner holds the dump in memory. A whole-buffer
 * implementation would need more than 2 GiB of heap and fail this bound by an order of
 * magnitude.
 */
describe('a > 2 GiB dump (E4)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexa-7z-big-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('seals, plans parts over and opens a 2.1 GiB dump with bounded memory', async () => {
    const size = Math.floor(2.1 * 1024 * 1024 * 1024);
    const dumpPath = join(dir, 'dump.pgcustom');
    await writeFile(dumpPath, '');
    await truncate(dumpPath, size);
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 50);
    try {
      // The parts planner streams the 2.1 GiB file itself (as it would an archive).
      const planned = await planArchiveParts({
        archivePath: dumpPath,
        partBytes: 45 * 1024 * 1024,
        filename: 'big.7z',
      });
      expect(planned.length).toBe(Math.ceil(size / (45 * 1024 * 1024)));
      expect(planned.reduce((sum, part) => sum + part.bytes, 0)).toBe(size);
      const zeros45 = createHash('sha256')
        .update(Buffer.alloc(45 * 1024 * 1024))
        .digest('hex');
      expect(planned[0]?.sha256).toBe(zeros45);

      const archivePath = join(dir, 'archive.7z');
      await sealSevenZip({
        dumpPath,
        archivePath,
        manifest: manifestFor('0'.repeat(64), size),
        password: PASSWORD,
        options: OPTIONS,
      });
      const opened = await openSevenZip({
        archivePath,
        dumpPath: '/dev/null',
        passwords: [PASSWORD],
        options: OPTIONS,
      });
      expect(opened.dumpBytes).toBe(size);
    } finally {
      clearInterval(sampler);
    }
    // Generous: the bound is about not holding 2 GiB, not about tuning.
    expect(peak - baseline).toBeLessThan(256 * 1024 * 1024);
  }, 600_000);
});
