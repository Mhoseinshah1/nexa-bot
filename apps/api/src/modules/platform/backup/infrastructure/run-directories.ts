import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BackupRunDirectory,
  BackupRunDirectoryStore,
} from '../application/backup-orphan-sweep.js';
import { PLAINTEXT_FILES, RUN_DIRECTORY } from './workspace.js';

/**
 * The filesystem half of the orphan sweep (Round 8, B1). Lists, measures and removes;
 * WHICH directory may go is `decideOrphanDirectory`'s, from the run table.
 *
 * Only directories named by a run id are listed — never a CLI scratch directory, never a
 * recovery workspace, never anything else an operator put under the root.
 */
export class FilesystemBackupRunDirectories implements BackupRunDirectoryStore {
  constructor(private readonly root: string) {}

  async listRunDirectories(): Promise<readonly BackupRunDirectory[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      if (isAbsent(error)) return [];
      throw error;
    }
    const found: BackupRunDirectory[] = [];
    for (const entry of entries) {
      if (!RUN_DIRECTORY.test(entry)) continue;
      const path = join(this.root, entry);
      const info = await stat(path).catch(() => null);
      if (info === null || !info.isDirectory()) continue;
      // The NEWEST of the directory and every file in it: a directory's own mtime moves only
      // when an entry is added or removed, so a dump being streamed into it would look old.
      let newest = info.mtimeMs;
      for (const name of await readdir(path).catch(() => [] as string[])) {
        const file = await stat(join(path, name)).catch(() => null);
        if (file !== null && file.mtimeMs > newest) newest = file.mtimeMs;
      }
      found.push({ id: entry, lastWrittenAt: new Date(newest) });
    }
    return found;
  }

  async removeRunDirectory(backupId: string): Promise<readonly string[]> {
    const path = join(this.root, backupId);
    // Only ever a run's own directory, named by its id: never `..`, never the root.
    if (!RUN_DIRECTORY.test(backupId)) return [path];
    return (await removeEach([path])).survived;
  }

  async removeRunPlaintext(
    backupId: string,
  ): Promise<{ readonly removed: readonly string[]; readonly survived: readonly string[] }> {
    if (!RUN_DIRECTORY.test(backupId))
      return { removed: [], survived: [join(this.root, backupId)] };
    const present: string[] = [];
    for (const name of PLAINTEXT_FILES) {
      const file = join(this.root, backupId, name);
      if ((await stat(file).catch(() => null)) !== null) present.push(file);
    }
    return removeEach(present);
  }
}

async function removeEach(
  paths: readonly string[],
): Promise<{ removed: readonly string[]; survived: readonly string[] }> {
  const removed: string[] = [];
  const survived: string[] = [];
  for (const path of paths) {
    try {
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      survived.push(path);
    }
  }
  return { removed, survived };
}

function isAbsent(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
