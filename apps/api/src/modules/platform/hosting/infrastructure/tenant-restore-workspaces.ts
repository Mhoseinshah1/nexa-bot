import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TenantRestoreWorkspaces } from '../application/tenant-restore-admin.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Phase 6B PR-2: uploaded hosted archives, `RECOVERY_WORK_DIR/tenant-restores/<restoreId>/` —
 * the volume the API (upload, dry run) and the recovery role (apply) share. Directories are
 * 0700, files 0600, every path DERIVED from a validated uuid and constant names.
 */
export class FilesystemTenantRestoreWorkspaces implements TenantRestoreWorkspaces {
  constructor(private readonly root: string) {}

  private get base(): string {
    return join(this.root, 'tenant-restores');
  }

  private directory(restoreId: string): string {
    if (!UUID.test(restoreId)) throw new Error('a restore workspace is named by a uuid');
    return join(this.base, restoreId);
  }

  async create(restoreId: string): Promise<{ readonly archivePath: string }> {
    const directory = this.directory(restoreId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return { archivePath: join(directory, 'archive.7z') };
  }

  open(restoreId: string) {
    const directory = this.directory(restoreId);
    const passwordPath = join(directory, 'password.sealed');
    return {
      archivePath: join(directory, 'archive.7z'),
      scratchDirectory: join(directory, 'work'),
      exists: async () => {
        try {
          return (await stat(join(directory, 'archive.7z'))).isFile();
        } catch {
          return false;
        }
      },
      writeSealedPassword: async (sealed: string) => {
        await writeFile(passwordPath, sealed, { mode: 0o600 });
      },
      readSealedPassword: async () => {
        try {
          return await readFile(passwordPath, 'utf8');
        } catch {
          return null;
        }
      },
      remove: async () => {
        try {
          await rm(directory, { recursive: true, force: true });
          return true;
        } catch {
          return false;
        }
      },
    };
  }

  async list(): Promise<readonly { readonly restoreId: string; readonly lastWrittenAt: Date }[]> {
    let names: string[];
    try {
      names = await readdir(this.base);
    } catch {
      return [];
    }
    const out: { restoreId: string; lastWrittenAt: Date }[] = [];
    for (const name of names) {
      if (!UUID.test(name)) continue;
      try {
        const stats = await stat(join(this.base, name));
        if (stats.isDirectory()) out.push({ restoreId: name, lastWrittenAt: stats.mtime });
      } catch {
        // Gone between the listing and the stat: nothing to sweep.
      }
    }
    return out;
  }
}
