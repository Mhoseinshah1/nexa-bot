import type { BackupArchiveFormat, BackupManifest } from '@nexa/contracts';
import { dirname, join } from 'node:path';
import type { SecretKeyring } from '../../../../infrastructure/crypto/keyring.js';
import {
  openKeyBundle,
  sealKeyBundle,
  wipeBundleKeys,
  type BundleKey,
} from '../../../../infrastructure/crypto/key-bundle.js';
import type { KitKdfProfile } from '../../../../infrastructure/crypto/recovery-kit.js';
import type {
  BackupArchivePasswordSource,
  BackupArchiver,
  BundledKeyMaterial,
} from '../application/ports.js';
import { checksumFile, openArchive, sealArchive } from './archive.js';
import {
  assertSevenZipMemory,
  isSevenZipFile,
  openSevenZip,
  sealSevenZip,
  type SevenZipOptions,
} from './seven-zip.js';

/**
 * Binds the archive format to this installation's keyring.
 *
 * The whole adapter. `archive.ts` holds the format and the cryptography and
 * knows nothing about where a key comes from; this is the seam where the
 * installation's configured keys arrive, which is what lets the format be
 * tested against keyrings a real installation would never have — a rotated
 * one, one missing the key an archive names, one holding only the wrong key.
 */
export class KeyringBackupArchiver implements BackupArchiver {
  constructor(private readonly keyring: SecretKeyring) {}

  async seal(input: {
    dumpPath: string;
    archivePath: string;
    manifest: BackupManifest;
  }): Promise<{ archiveBytes: number; keyId: string; format: BackupArchiveFormat }> {
    const sealed = await sealArchive({ ...input, keyring: this.keyring });
    return { ...sealed, format: 'NXB' };
  }

  async open(input: { archivePath: string; dumpPath: string }): Promise<{
    manifest: BackupManifest;
    dumpChecksum: string;
    dumpBytes: number;
    format: BackupArchiveFormat;
  }> {
    return { ...(await openArchive({ ...input, keyring: this.keyring })), format: 'NXB' };
  }

  async checksum(path: string): Promise<{ checksum: string; bytes: number }> {
    return checksumFile(path);
  }
}

/**
 * Both containers behind the ONE `open` (E4).
 *
 * SEAL: a 7-Zip archive under the owner-set backup password when one is stored, else the
 * keyring `NXB` exactly as before — an installation that never sets a password keeps the
 * archive it always had. Decided per seal, from the database, so setting a password applies
 * to the next run with no restart.
 *
 * OPEN: by the file's own magic bytes, never by its name (an upload's name is a label). The
 * pipeline's VERIFY_RESTORE, the Web Admin recovery, the recovery executor and the CLI all
 * come through here, so what is verified and what is restored are opened by one function,
 * whichever container it is (ADR-0025).
 */
/**
 * What a 7z seal carries besides the dump: the keys its secrets are sealed under.
 *
 * `keys` returns COPIES the archiver zeroes after wrapping — never the keyring's own
 * buffers, which other readers are using.
 */
export interface KeyBundleSource {
  keys(): Promise<readonly BundleKey[]>;
  readonly profile: KitKdfProfile;
}

export class DualFormatBackupArchiver implements BackupArchiver {
  private readonly keyringArchiver: KeyringBackupArchiver;

  constructor(
    keyring: SecretKeyring,
    private readonly passwords: BackupArchivePasswordSource,
    private readonly sevenZip: SevenZipOptions,
    /**
     * Self-contained backups: without it a 7z carries no keys (the CLI's offline
     * tools, which only open). The pipeline's archiver always has one.
     */
    private readonly keyBundle?: KeyBundleSource,
  ) {
    this.keyringArchiver = new KeyringBackupArchiver(keyring);
  }

  /** The key bundle for one seal, wrapped under `password`; the copies are zeroed here. */
  private async bundleFor(password: string, backupId: string): Promise<Buffer | undefined> {
    if (this.keyBundle === undefined) return undefined;
    const keys = await this.keyBundle.keys();
    try {
      return await sealKeyBundle({ keys, password, backupId, profile: this.keyBundle.profile });
    } finally {
      for (const key of keys) key.material.fill(0);
    }
  }

  async seal(input: {
    dumpPath: string;
    archivePath: string;
    sevenZipPath?: string;
    manifest: BackupManifest;
  }): Promise<{
    archiveBytes: number;
    keyId: string | null;
    format: BackupArchiveFormat;
    archivePath: string;
    passwordId: string | null;
  }> {
    const password = await this.passwords.current();
    if (password === null) {
      const sealed = await this.keyringArchiver.seal(input);
      return { ...sealed, archivePath: input.archivePath, passwordId: null };
    }
    const archivePath = input.sevenZipPath ?? join(dirname(input.archivePath), 'archive.7z');
    const keyBundle = await this.bundleFor(password.password, input.manifest.backupId);
    const sealed = await sealSevenZip({
      dumpPath: input.dumpPath,
      archivePath,
      manifest: input.manifest,
      password: password.password,
      options: this.sevenZip,
      ...(keyBundle === undefined ? {} : { keyBundle }),
    });
    return {
      archiveBytes: sealed.archiveBytes,
      keyId: null,
      format: 'SEVEN_ZIP',
      archivePath,
      passwordId: password.id,
    };
  }

  async nextFormat(): Promise<BackupArchiveFormat> {
    return (await this.passwords.current()) === null ? 'NXB' : 'SEVEN_ZIP';
  }

  async preflight(): Promise<void> {
    if ((await this.passwords.current()) === null) return;
    await assertSevenZipMemory(this.sevenZip);
  }

  /** The keyring container only — the recovery's re-seal of a verified upload (E4). */
  async sealKeyring(input: {
    dumpPath: string;
    archivePath: string;
    manifest: BackupManifest;
  }): Promise<{ archiveBytes: number; keyId: string }> {
    return this.keyringArchiver.seal(input);
  }

  async open(input: {
    archivePath: string;
    dumpPath: string;
    passwords?: readonly string[];
    withBundledKeys?: boolean;
  }): Promise<{
    manifest: BackupManifest;
    dumpChecksum: string;
    dumpBytes: number;
    format: BackupArchiveFormat;
    bundledKeys: readonly BundledKeyMaterial[] | null;
    hadKeyBundle: boolean;
  }> {
    if (!(await isSevenZipFile(input.archivePath))) {
      return {
        ...(await this.keyringArchiver.open(input)),
        bundledKeys: null,
        hadKeyBundle: false,
      };
    }
    const passwords =
      input.passwords !== undefined && input.passwords.length > 0
        ? input.passwords
        : (await this.passwords.all()).map((entry) => entry.password);
    const opened = await openSevenZip({
      archivePath: input.archivePath,
      dumpPath: input.dumpPath,
      passwords,
      options: this.sevenZip,
    });
    let bundledKeys: readonly BundledKeyMaterial[] | null = null;
    if (opened.keyBundle !== null) {
      // The SAME password that opened the archive: a bundle is never opened with a
      // password the archive itself did not accept.
      const keys = await openKeyBundle({
        bundle: opened.keyBundle,
        password: passwords[opened.passwordIndex] ?? '',
        backupId: opened.manifest.backupId,
      });
      if (input.withBundledKeys === true) bundledKeys = keys;
      else wipeBundleKeys(keys);
    }
    return {
      manifest: opened.manifest,
      dumpChecksum: opened.dumpChecksum,
      dumpBytes: opened.dumpBytes,
      format: 'SEVEN_ZIP',
      bundledKeys,
      hadKeyBundle: opened.keyBundle !== null,
    };
  }

  async checksum(path: string): Promise<{ checksum: string; bytes: number }> {
    return checksumFile(path);
  }
}
