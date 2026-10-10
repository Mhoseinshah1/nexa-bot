import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { uuidV7Schema } from '@nexa/contracts';
import type { MigrationImportFiles, MigrationWorkspaces } from '../application/ports.js';

/**
 * Where the `.nxpkg` imports live on the installation's disk (`LEGACY_MIGRATION_WORK_DIR`).
 *
 * ```
 * <root>/<import id>/                      0700
 * <root>/<import id>/package.nxpkg         0600, written by the upload (flags 'wx')
 * <root>/<import id>/ownership-decisions-<sha256>.json
 * <root>/<import id>/step-<random>/        0700, ONE step's decrypted content, removed after it
 * ```
 *
 * The `migration` role also sweeps this root at start and on every tick: every `step-*`
 * directory of a terminal import (or of a directory no import row names) is removed, and at a
 * terminal state the package and decisions files are removed unless
 * `LEGACY_MIGRATION_RETAIN_PACKAGE` is on (`LegacyMigrationExecutor.sweep`).
 *
 * Nothing from a request reaches a path component: the import id is validated as a uuid
 * before any path is built, the file names are constants, and the step suffix is random.
 * Every path this class removes is checked to lie strictly inside the root.
 */
const PACKAGE_FILE = 'package.nxpkg';
const STEP_PREFIX = 'step-';
const DECISIONS_PREFIX = 'ownership-decisions-';
const UPLOAD_PREFIX = 'upload-';
const UPLOAD_SUFFIX = '.partial';

export class FilesystemMigrationWorkspaces implements MigrationWorkspaces {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async create(importId: string): Promise<MigrationImportFiles> {
    const files = this.filesOf(importId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // Not recursive: an existing directory for a fresh id is something unexpected, and
    // writing into it would be worse than failing.
    await mkdir(files.directory, { mode: 0o700 });
    // The umask can only narrow `mode`; set it exactly anyway, so the claim is not a hope.
    await chmod(files.directory, 0o700);
    return files;
  }

  filesOf(importId: string): MigrationImportFiles {
    const directory = this.inside(join(this.root, validId(importId)));
    return { directory, packagePath: join(directory, PACKAGE_FILE) };
  }

  decisionsUploadPath(importId: string): string {
    const { directory } = this.filesOf(importId);
    return join(directory, `${UPLOAD_PREFIX}${randomBytes(8).toString('hex')}${UPLOAD_SUFFIX}`);
  }

  decisionsPath(importId: string, sha256: string): string {
    if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new Error('A decisions digest must be hex.');
    const { directory } = this.filesOf(importId);
    return join(directory, `${DECISIONS_PREFIX}${sha256}.json`);
  }

  async promote(from: string, to: string): Promise<void> {
    await rename(this.inside(from), this.inside(to));
  }

  async removeFile(path: string): Promise<void> {
    await rm(this.inside(path), { force: true });
  }

  async discard(importId: string): Promise<void> {
    await rm(this.filesOf(importId).directory, { recursive: true, force: true });
  }

  async stepDirectory(importId: string): Promise<string> {
    const { directory } = this.filesOf(importId);
    const step = join(directory, `${STEP_PREFIX}${randomBytes(12).toString('hex')}`);
    await mkdir(step, { mode: 0o700 });
    await chmod(step, 0o700);
    return step;
  }

  async discardStep(path: string): Promise<void> {
    const target = this.inside(path);
    if (!target.split(sep).at(-1)?.startsWith(STEP_PREFIX)) {
      throw new Error('Only a step directory is discarded here.');
    }
    await rm(target, { recursive: true, force: true });
  }

  async discardStaleSteps(importId: string): Promise<number> {
    const { directory } = this.filesOf(importId);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return 0;
    }
    const stale = entries.filter((name) => name.startsWith(STEP_PREFIX));
    for (const name of stale) {
      await rm(join(directory, name), { recursive: true, force: true });
    }
    return stale.length;
  }

  async importDirectories(): Promise<readonly string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory() && uuidV7Schema.safeParse(entry.name).success)
      .map((entry) => entry.name);
  }

  async discardPackageFiles(importId: string): Promise<number> {
    const { directory } = this.filesOf(importId);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return 0;
    }
    const doomed = entries.filter(
      (name) =>
        name === PACKAGE_FILE ||
        name.startsWith(DECISIONS_PREFIX) ||
        (name.startsWith(UPLOAD_PREFIX) && name.endsWith(UPLOAD_SUFFIX)),
    );
    for (const name of doomed) await rm(join(directory, name), { force: true });
    return doomed.length;
  }

  async digest(path: string): Promise<{ readonly sha256: string; readonly bytes: number }> {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(this.inside(path))) {
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      hash.update(buffer);
    }
    return { sha256: hash.digest('hex'), bytes };
  }

  /** A path strictly inside the root, or a refusal. The root itself is not a workspace. */
  private inside(path: string): string {
    const target = resolve(path);
    if (!target.startsWith(this.root + sep)) {
      throw new Error('A legacy migration path is outside LEGACY_MIGRATION_WORK_DIR.');
    }
    return target;
  }
}

function validId(importId: string): string {
  if (!uuidV7Schema.safeParse(importId).success) {
    throw new Error('A legacy migration import id must be a uuid v7.');
  }
  return importId.toLowerCase();
}
