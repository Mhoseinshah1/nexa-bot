import { mkdir, mkdtemp, readdir, rm, stat, statfs, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BackupDebrisStore,
  BackupDebrisSweep,
  BackupWorkspace,
  BackupWorkspaceFactory,
} from '../application/ports.js';

/**
 * The prefix of a directory the operator's CLI decrypts into.
 *
 * `backup verify` and `backup restore` used to decrypt into `os.tmpdir()` — the
 * container's `/tmp`, outside the 0700 volume — where a SIGKILL left a plaintext
 * database until the container was recreated. They now decrypt into a private
 * directory UNDER the backup root, named with this prefix so the debris sweep
 * can recognise one a killed command left behind, and so nothing that walks run
 * directories (the retained-archive scanner, retention) mistakes it for a run.
 */
export const CLI_SCRATCH_PREFIX = '.cli-';

/**
 * The plaintext files a run directory can hold. Never the archive. `manifest.json` is the
 * 7-Zip seal's staging copy of the manifest (E4) — metadata, but plaintext of the dump's kind.
 */
export const PLAINTEXT_FILES = ['dump.pgcustom', 'verify.pgcustom', 'manifest.json'] as const;

/** A run directory is named by its UUID backup id; anything else is not a run's. */
export const RUN_DIRECTORY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Phase 6B (ADR-0039): a tenant archive run works in `<root>/hosted/<tenantId>/<runId>/`, and its
 * plaintext is two directories there — the exported parts and the verification's extraction
 * (`tenant-archive-engine.ts`). Never `archive.7z`, which retention decides.
 */
export const HOSTED_DIRECTORY = 'hosted';
export const HOSTED_PLAINTEXT = ['plain', 'verify'] as const;

/**
 * Creates a fresh 0700 directory under the backup root for one CLI command.
 *
 * `mkdtemp` creates it 0700 and with an unpredictable name; the root is created
 * 0700 if it is missing, exactly as the pipeline's own workspace factory does.
 * There is deliberately NO fallback to `/tmp`: a root that cannot be written is
 * an error the operator sees, not a reason to put plaintext somewhere worse.
 */
export async function privateScratchDirectory(root: string, purpose: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return mkdtemp(join(root, `${CLI_SCRATCH_PREFIX}${purpose}-`));
}

/**
 * The filesystem half of archive retention and the plaintext-debris sweep.
 *
 * Every decision about WHICH run may lose its directory is made by the caller
 * from the run table; this only removes, scans and measures. The one judgement
 * made here is the age test for plaintext, and it is made on the FILE's own
 * modification time: a file nobody has written for longer than the grace is not
 * being written, whatever any row says.
 */
export class FilesystemBackupDebris implements BackupDebrisStore {
  constructor(private readonly root: string) {}

  async removeRunDirectory(backupId: string): Promise<readonly string[]> {
    // Only ever a run's own directory, named by its id. A malformed id would
    // otherwise be a path relative to the root — `..` included.
    if (!RUN_DIRECTORY.test(backupId)) return [join(this.root, backupId)];
    return removeAll([join(this.root, backupId)]);
  }

  async sweepPlaintext(input: {
    readonly olderThan: Date;
    readonly skipIds: ReadonlySet<string>;
  }): Promise<BackupDebrisSweep> {
    const removed: string[] = [];
    const survived: string[] = [];
    let pending = 0;
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      if (isAbsent(error)) return { removed, survived, pending };
      throw error;
    }
    const cutoff = input.olderThan.getTime();
    for (const entry of entries) {
      const path = join(this.root, entry);
      if (entry.startsWith(CLI_SCRATCH_PREFIX)) {
        const info = await stat(path).catch(() => null);
        if (info === null || !info.isDirectory()) continue;
        // The NEWEST of the directory and everything in it. A directory's own
        // mtime changes only when an entry is added or removed, so a CLI restore
        // streaming a large dump into it for an hour leaves the directory "old"
        // while its file is being written that minute.
        if ((await newestWrite(path, info.mtimeMs, 1)) >= cutoff) {
          pending += 1;
          continue;
        }
        const left = await removeAll([path]);
        if (left.length === 0) removed.push(path);
        else survived.push(...left);
        continue;
      }
      if (entry === HOSTED_DIRECTORY) {
        const hosted = await this.sweepHostedPlaintext(path, cutoff, input.skipIds);
        removed.push(...hosted.removed);
        survived.push(...hosted.survived);
        pending += hosted.pending;
        continue;
      }
      // A RUNNING run's directory is being written. Skipped by id, whatever the
      // file times say — the age test is the second guard, not the only one.
      if (!RUN_DIRECTORY.test(entry) || input.skipIds.has(entry)) continue;
      for (const name of PLAINTEXT_FILES) {
        const file = join(path, name);
        const info = await stat(file).catch(() => null);
        if (info === null) continue;
        if (info.mtimeMs >= cutoff) {
          pending += 1;
          continue;
        }
        const left = await removeAll([file]);
        if (left.length === 0) removed.push(file);
        else survived.push(...left);
      }
    }
    return { removed, survived, pending };
  }

  /**
   * Security review of PR #447, finding 2: the plaintext a KILLED tenant archive run left in
   * `hosted/<tenantId>/<runId>/{plain,verify}`, on the same terms as an installation run's —
   * a RUNNING run skipped by id, and nothing written inside for the grace window.
   */
  private async sweepHostedPlaintext(
    hosted: string,
    cutoff: number,
    skipIds: ReadonlySet<string>,
  ): Promise<BackupDebrisSweep> {
    const removed: string[] = [];
    const survived: string[] = [];
    let pending = 0;
    for (const tenantId of await readdir(hosted).catch(() => [] as string[])) {
      if (!RUN_DIRECTORY.test(tenantId)) continue;
      for (const runId of await readdir(join(hosted, tenantId)).catch(() => [] as string[])) {
        if (!RUN_DIRECTORY.test(runId) || skipIds.has(runId)) continue;
        for (const name of HOSTED_PLAINTEXT) {
          const directory = join(hosted, tenantId, runId, name);
          const info = await stat(directory).catch(() => null);
          if (info === null) continue;
          if ((await newestWrite(directory, info.mtimeMs, 2)) >= cutoff) {
            pending += 1;
            continue;
          }
          const left = await removeAll([directory]);
          if (left.length === 0) removed.push(directory);
          else survived.push(...left);
        }
      }
    }
    return { removed, survived, pending };
  }

  /** Free and total bytes of the backup volume, or null when the root does not exist. */
  async volume(): Promise<{ readonly freeBytes: number; readonly totalBytes: number } | null> {
    try {
      const info = await statfs(this.root);
      return {
        freeBytes: Number(info.bavail) * Number(info.bsize),
        totalBytes: Number(info.blocks) * Number(info.bsize),
      };
    } catch (error) {
      if (isAbsent(error)) return null;
      throw error;
    }
  }

  async freeBytes(): Promise<number | null> {
    try {
      const info = await statfs(this.root);
      return Number(info.bavail) * Number(info.bsize);
    } catch (error) {
      if (isAbsent(error)) return null;
      throw error;
    }
  }
}

/**
 * The latest mtime among a directory and its entries, `depth` levels down (1: its direct
 * entries). A tenant archive's parts are written two levels below its run directory.
 */
export async function newestWrite(directory: string, own: number, depth: number): Promise<number> {
  let newest = own;
  if (depth <= 0) return newest;
  const names = await readdir(directory).catch(() => [] as string[]);
  for (const name of names) {
    const path = join(directory, name);
    const info = await stat(path).catch(() => null);
    if (info === null) continue;
    const at = info.isDirectory() ? await newestWrite(path, info.mtimeMs, depth - 1) : info.mtimeMs;
    if (at > newest) newest = at;
  }
  return newest;
}

/**
 * Keeps a CLI scratch directory looking alive while its command runs.
 *
 * `pg_restore` READS the decrypted dump for as long as the restore takes and
 * writes nothing into the directory, so without this a restore longer than the
 * debris sweep's grace would have its plaintext removed from under it. Touched
 * every minute; the timer is unref'd and stopped by the caller's `finally`.
 */
export function keepScratchAlive(directory: string, everyMs = 60_000): { stop(): void } {
  const timer = setInterval(() => {
    const now = new Date();
    void utimes(directory, now, now).catch(() => undefined);
  }, everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

function isAbsent(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

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
  readonly sevenZipPath: string;
  readonly verifyDumpPath: string;

  constructor(private readonly directory: string) {
    this.dumpPath = join(directory, 'dump.pgcustom');
    this.archivePath = join(directory, 'archive.nxb');
    // E4: the 7-Zip archive, when a backup password is set. One or the other exists.
    this.sevenZipPath = join(directory, 'archive.7z');
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
    return removeAll([this.dumpPath, this.verifyDumpPath, join(this.directory, 'manifest.json')]);
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

/**
 * A finished installation run's archive on this host (NEXA-BACKUP-DELIVERY's re-delivery),
 * DERIVED from the run id and the work root, never accepted from a caller: an id that is not
 * a run directory name is null. The file name is the workspace's own constant.
 */
export function runArchivePath(
  workRoot: string,
  run: { readonly id: string; readonly archiveFormat: string | null },
): string | null {
  if (!RUN_DIRECTORY.test(run.id)) return null;
  return join(workRoot, run.id, run.archiveFormat === 'SEVEN_ZIP' ? 'archive.7z' : 'archive.nxb');
}
