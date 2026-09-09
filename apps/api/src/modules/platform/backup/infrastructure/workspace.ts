import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackupWorkspace, BackupWorkspaceFactory } from '../application/ports.js';

/**
 * Where a run's files live, and the promise that they stop living there.
 *
 * One directory per run, named by the backup id, created with mode 0700. Not a
 * shared scratch directory with per-run filenames: a directory can be removed
 * in one call whatever it ended up containing, and a partial dump from a run
 * that was killed cannot be mistaken for — or overwritten by — the next run's.
 *
 * Under the installation's own data root rather than `/tmp`. A dump is the
 * database with the encryption taken off, and `/tmp` is world-traversable on a
 * default Ubuntu host, cleaned by a timer nobody here controls, and frequently
 * a tmpfs that a real database will not fit in.
 */
export class FilesystemBackupWorkspaces implements BackupWorkspaceFactory {
  constructor(private readonly root: string) {}

  async create(backupId: string): Promise<BackupWorkspace> {
    const directory = join(this.root, backupId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new DirectoryWorkspace(directory);
  }
}

class DirectoryWorkspace implements BackupWorkspace {
  readonly dumpPath: string;
  readonly archivePath: string;
  readonly verifyDumpPath: string;

  constructor(private readonly directory: string) {
    this.dumpPath = join(directory, 'dump.pgcustom');
    this.archivePath = join(directory, 'archive.nxb');
    // A second path, so a failed decrypt does not truncate the dump that is
    // still being held. Hygiene rather than a correctness rule — see the port.
    this.verifyDumpPath = join(directory, 'verify.pgcustom');
  }

  /**
   * Removes the plaintext dumps and keeps the encrypted archive.
   *
   * Called as soon as verification passes, not at the end. Between then and
   * delivery the pipeline talks to Telegram, which is the longest and least
   * predictable stage in the run, and there is no reason for the unencrypted
   * database to still be on disk while it happens.
   */
  async discardPlaintext(): Promise<readonly string[]> {
    return removeAll([this.dumpPath, this.verifyDumpPath]);
  }

  /** Removes the whole directory, archive included. */
  async discardAll(): Promise<readonly string[]> {
    return removeAll([this.directory]);
  }
}

/**
 * Removes each path and reports what survived, rather than throwing.
 *
 * A cleanup failure must not mask the outcome of the run that produced it —
 * but it must not vanish either. What is left behind is plaintext database
 * bytes, so the caller records the paths on the run row and an operator is
 * told; that is the opposite of the empty catch the boundary check bans.
 */
async function removeAll(paths: readonly string[]): Promise<readonly string[]> {
  const survivors: string[] = [];
  for (const path of paths) {
    try {
      await rm(path, { recursive: true, force: true });
    } catch {
      survivors.push(path);
    }
  }
  return survivors;
}
