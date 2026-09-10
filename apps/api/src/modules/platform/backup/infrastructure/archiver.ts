import type { BackupManifest } from '@nexa/contracts';
import type { SecretKeyring } from '../../../../infrastructure/crypto/keyring.js';
import type { BackupArchiver } from '../application/ports.js';
import { checksumFile, openArchive, sealArchive } from './archive.js';

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
  }): Promise<{ archiveBytes: number; keyId: string }> {
    return sealArchive({ ...input, keyring: this.keyring });
  }

  async open(input: { archivePath: string; dumpPath: string }): Promise<{
    manifest: BackupManifest;
    dumpChecksum: string;
    dumpBytes: number;
  }> {
    return openArchive({ ...input, keyring: this.keyring });
  }

  async checksum(path: string): Promise<{ checksum: string; bytes: number }> {
    return checksumFile(path);
  }
}
