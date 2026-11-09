import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BackupRunDirectory,
  BackupRunDirectoryStore,
} from '../application/backup-orphan-sweep.js';
import {
  HOSTED_DIRECTORY,
  HOSTED_PLAINTEXT,
  newestWrite,
  PLAINTEXT_FILES,
  RUN_DIRECTORY,
} from './workspace.js';

/**
 * The filesystem half of the orphan sweep (Round 8, B1). Lists, measures and removes;
 * WHICH directory may go is `decideOrphanDirectory`'s, from the run table.
 *
 * Only directories named by a run id are listed — `<root>/<runId>/` for an installation run
 * and `<root>/hosted/<tenantId>/<runId>/` for a tenant archive run (security review of PR
 * #447, finding 2) — never a CLI scratch directory, never a recovery workspace, never
 * anything else an operator put under the root.
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
      const one = await this.measure(join(this.root, entry), entry, null);
      if (one !== null) found.push(one);
    }
    const hosted = join(this.root, HOSTED_DIRECTORY);
    for (const tenantId of await readdir(hosted).catch(() => [] as string[])) {
      if (!RUN_DIRECTORY.test(tenantId)) continue;
      for (const runId of await readdir(join(hosted, tenantId)).catch(() => [] as string[])) {
        if (!RUN_DIRECTORY.test(runId)) continue;
        const one = await this.measure(join(hosted, tenantId, runId), runId, tenantId);
        if (one !== null) found.push(one);
      }
    }
    return found;
  }

  private async measure(
    path: string,
    id: string,
    subjectTenantId: string | null,
  ): Promise<BackupRunDirectory | null> {
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isDirectory()) return null;
    // The NEWEST of the directory and every file in it: a directory's own mtime moves only
    // when an entry is added or removed, so a dump being streamed into it would look old. A
    // tenant run writes two levels further down (`plain/data/<part>`).
    const newest = await newestWrite(path, info.mtimeMs, subjectTenantId === null ? 1 : 3);
    return { id, lastWrittenAt: new Date(newest), subjectTenantId };
  }

  /** The run's own directory, or null when a name in it is not a UUID (`..`, the root). */
  private pathOf(directory: BackupRunDirectory): string | null {
    if (!RUN_DIRECTORY.test(directory.id)) return null;
    if (directory.subjectTenantId === null) return join(this.root, directory.id);
    if (!RUN_DIRECTORY.test(directory.subjectTenantId)) return null;
    return join(this.root, HOSTED_DIRECTORY, directory.subjectTenantId, directory.id);
  }

  async removeRunDirectory(directory: BackupRunDirectory): Promise<readonly string[]> {
    const path = this.pathOf(directory);
    // Only ever a run's own directory, named by its id: never `..`, never the root.
    if (path === null) return [join(this.root, directory.id)];
    return (await removeEach([path])).survived;
  }

  async removeRunPlaintext(
    directory: BackupRunDirectory,
  ): Promise<{ readonly removed: readonly string[]; readonly survived: readonly string[] }> {
    const path = this.pathOf(directory);
    if (path === null) return { removed: [], survived: [join(this.root, directory.id)] };
    const names = directory.subjectTenantId === null ? PLAINTEXT_FILES : HOSTED_PLAINTEXT;
    const present: string[] = [];
    for (const name of names) {
      const file = join(path, name);
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
