import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { NexaError, PLATFORM_ERROR_CODES } from '@nexa/contracts';
import type { RecoveryWorkspace, RecoveryWorkspaceFactory } from '../application/ports.js';

/**
 * Where an uploaded archive lives while a recovery is alive.
 *
 * Modelled on `FilesystemBackupWorkspaces` and deliberately NOT the same class,
 * because the naming rule is the opposite one. A backup workspace is named after
 * the backup id, which the pipeline knows before it starts. An upload arrives
 * before anything knows what it is — the filename is attacker-chosen, the
 * declared type is attacker-chosen, and the manifest is inside an encrypted
 * region nothing has authenticated yet — so the directory name is RANDOM and
 * derived from nothing the caller sent.
 *
 * Under the installation's own data root rather than `/tmp`, for the reason the
 * backup workspace states: what lands here decrypts to a database with the
 * encryption taken off, and `/tmp` is world-traversable on a default host,
 * cleaned by a timer nobody here controls, and frequently a tmpfs a real
 * database will not fit in.
 */
export class FilesystemRecoveryWorkspaces implements RecoveryWorkspaceFactory {
  constructor(private readonly root: string) {}

  async create(recoveryId: string): Promise<RecoveryWorkspace> {
    // The recovery id is in the name so debris is attributable, and the random
    // suffix is what makes the path unguessable. Both: an id alone would let
    // anybody who has seen a recovery id in a URL predict a path, and a random
    // name alone would leave an operator unable to tell which directory belongs
    // to which failed recovery.
    const directory = join(this.root, `${recoveryId}-${randomBytes(8).toString('hex')}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new DirectoryRecoveryWorkspace(directory);
  }

  /**
   * Re-opens a workspace the executor did not create.
   *
   * The upload happens in the API process and the execution happens in the
   * recovery executor, so the path travels through the database row. It is
   * therefore treated as untrusted on the way back in — not because an
   * administrator wrote it, but because a column is a place a value can arrive
   * from somewhere else, and "it was ours when we stored it" is a property of
   * today's writers.
   */
  open(directory: string): RecoveryWorkspace {
    const root = resolve(this.root);
    const target = resolve(directory);
    // The root ITSELF is not a workspace, and permitting it was a `rm -rf` of
    // every other pending upload waiting to be reached through a column: `open`
    // takes a path read back out of `workspace_path`, and `discard` removes the
    // directory it is given. Nothing legitimate resolves here — every real
    // workspace carries a random suffix — so equality is refused with the rest.
    if (!target.startsWith(root + sep)) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_TOOL_FAILED,
        message: 'A recovery workspace path is outside the recovery root.',
      });
    }
    return new DirectoryRecoveryWorkspace(target);
  }
}

class DirectoryRecoveryWorkspace implements RecoveryWorkspace {
  readonly archivePath: string;
  readonly dumpPath: string;

  constructor(readonly directory: string) {
    // Fixed names inside a random directory. Nothing from the request reaches a
    // path component, which is what makes traversal not a question here rather
    // than a sanitiser somebody has to get right.
    this.archivePath = join(directory, 'upload.nxb');
    this.dumpPath = join(directory, 'decrypted.pgcustom');
  }

  async discardPlaintext(): Promise<readonly string[]> {
    return removeAll([this.dumpPath]);
  }

  async discard(): Promise<readonly string[]> {
    return removeAll([this.directory]);
  }
}

/**
 * Removes each path and reports what survived, rather than throwing.
 *
 * The same rule the backup workspace follows and for the same reason: a cleanup
 * failure must not mask the outcome of the operation that produced it, and must
 * not vanish either. What is left behind here is an encrypted archive and
 * possibly a plaintext database, so the caller records the paths and an operator
 * is told.
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
