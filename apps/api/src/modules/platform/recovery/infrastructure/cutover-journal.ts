import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { recoveryIdSchema } from '@nexa/contracts';
import {
  CutoverJournalUnreadable,
  type CutoverJournal,
  type CutoverJournalRead,
} from '../application/ports.js';

/**
 * The file operations the journal uses, so a test can make one of them fail
 * half-way. Production passes nothing and gets `node:fs/promises`.
 */
export interface CutoverJournalIo {
  readonly mkdir: typeof fsp.mkdir;
  readonly open: typeof fsp.open;
  readonly rename: typeof fsp.rename;
  readonly readFile: typeof fsp.readFile;
  readonly readdir: typeof fsp.readdir;
  readonly rm: typeof fsp.rm;
}

const NODE_IO: CutoverJournalIo = {
  mkdir: fsp.mkdir,
  open: fsp.open,
  rename: fsp.rename,
  readFile: fsp.readFile,
  readdir: fsp.readdir,
  rm: fsp.rm,
};

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The one piece of recovery state that is not in the database.
 *
 * ADR-0028 § 4. The recovery row lives in the live database — which is what
 * makes it survive a browser close, an API restart and an executor restart — and
 * the live database is renamed away at cutover. Between the two `ALTER DATABASE`
 * statements there is a real window (they cannot be in a transaction), and an
 * executor that dies inside it comes back with no way to know which side of the
 * rename it was on: the old database may or may not still answer to its old
 * name, and the row that would have said so is inside whichever database it
 * finds.
 *
 * So this file is written immediately before and immediately after the renames.
 * It is the only thing that can answer "was the cutover done" for a process that
 * has just restarted, and it is a plain file because a plain file is the one
 * thing on the host that a database rename cannot move.
 *
 * IT HOLDS NO SECRETS. Ids, database names, a phase and a timestamp — nothing
 * here that `\l` would not show an operator anyway. Written 0600 regardless,
 * because the correct permission for a file in the installation's data root does
 * not depend on an argument about what is in it.
 */
export class FileCutoverJournal implements CutoverJournal {
  constructor(
    private readonly root: string,
    private readonly io: CutoverJournalIo = NODE_IO,
  ) {}

  private path(recoveryId: string): string {
    // The id is a path component, so it is validated as a UUIDv7 rather than
    // escaped. A validated id cannot contain a separator, a dot segment or a
    // NUL, which makes traversal impossible instead of handled.
    const parsed = recoveryIdSchema.safeParse(recoveryId);
    if (!parsed.success) {
      throw new Error('A cutover journal path was built from something that is not a recovery id.');
    }
    return join(this.root, `cutover-${parsed.data}.json`);
  }

  async write(entry: {
    recoveryId: string;
    phase: 'ABOUT_TO_RENAME' | 'RENAMED_OUT' | 'RENAMED';
    liveDatabase: string;
    candidateDatabase: string;
    displacedDatabase: string;
    at: Date;
  }): Promise<void> {
    const path = this.path(entry.recoveryId);
    await this.io.mkdir(this.root, { recursive: true, mode: 0o700 });
    /*
     * ATOMICALLY: a temp file in the same directory, fsync, rename, fsync of the
     * directory. The previous version rewrote the journal in place, and a crash
     * during that write — an OOM kill is plausible on this host — truncated the
     * only trace of a cutover in progress. `rename` within one directory replaces
     * the name in one step, so a reader sees the old journal or the new one and
     * never half of either. The temp name does not match `cutover-*.json`, so
     * `pending()` never mistakes a leftover for a journal.
     */
    const temp = join(this.root, `.cutover-${entry.recoveryId}.${randomUUID()}.tmp`);
    const body = JSON.stringify({ ...entry, at: entry.at.toISOString() }, null, 2);
    try {
      const file = await this.io.open(temp, 'wx', 0o600);
      try {
        await file.writeFile(body, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await this.io.rename(temp, path);
    } catch (error) {
      // The previous journal is untouched; only the temp file is ours to remove.
      await this.io.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    // The rename is durable only once the directory entry is.
    const dir = await this.io.open(this.root, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }

  /**
   * Every recovery id this journal holds a file for.
   *
   * The reason `read` alone was not enough, and the reason it went uncalled for
   * a whole branch: `read` takes a recovery id, and a process that restarted
   * mid-cutover HAS NO ID. The row that would name it is inside the database the
   * cutover renamed away, and the restored database carries the backup's rows.
   * Discovery has to come from the one thing a rename cannot move, which is this
   * directory.
   */
  async pending(): Promise<readonly string[]> {
    let names: string[];
    try {
      names = await this.io.readdir(this.root);
    } catch (error) {
      // No directory is no journals, which is the ordinary case on an
      // installation that has never run a recovery. Anything else — a
      // permission, an I/O error — is NOT "no journals": answering `[]` there
      // would hide a cutover in progress behind the same answer as nothing.
      if (errorCode(error) === 'ENOENT') return [];
      throw new CutoverJournalUnreadable(this.root, messageOf(error));
    }
    return names
      .filter((name) => name.startsWith('cutover-') && name.endsWith('.json'))
      .map((name) => name.slice('cutover-'.length, -'.json'.length));
  }

  /** Removes a journal once its facts are recorded where an operator reads them. */
  async clear(recoveryId: string): Promise<void> {
    await this.io.rm(this.path(recoveryId), { force: true });
  }

  async read(recoveryId: string): Promise<CutoverJournalRead> {
    // A name `pending()` returned that is not a recovery id is still a file in
    // the journal directory, and it is reported rather than skipped. `readdir`
    // names never contain a separator, so this join stays inside the root.
    if (!recoveryIdSchema.safeParse(recoveryId).success) {
      return {
        status: 'UNREADABLE',
        file: join(this.root, `cutover-${recoveryId}.json`),
        reason: 'the file name does not carry a recovery id',
      };
    }
    const file = this.path(recoveryId);
    let raw: string;
    try {
      raw = await this.io.readFile(file, 'utf8');
    } catch (error) {
      // Absent is an ANSWER — no cutover was ever begun for this recovery, or
      // its journal was cleared since it was listed. Every other failure is
      // not: the file is there and says something nobody has read.
      if (errorCode(error) === 'ENOENT') return { status: 'ABSENT' };
      return { status: 'UNREADABLE', file, reason: messageOf(error) };
    }
    let parsed: { phase?: unknown; displacedDatabase?: unknown; candidateDatabase?: unknown };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch (error) {
      // A partially written JSON file is exactly what a crash mid-write left
      // before the write was atomic. It is reported, never acted on: the
      // database names it might have held are not guessed from the remains.
      return { status: 'UNREADABLE', file, reason: `not valid JSON: ${messageOf(error)}` };
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      (parsed.phase !== 'ABOUT_TO_RENAME' &&
        parsed.phase !== 'RENAMED_OUT' &&
        parsed.phase !== 'RENAMED') ||
      typeof parsed.displacedDatabase !== 'string' ||
      typeof parsed.candidateDatabase !== 'string'
    ) {
      return { status: 'UNREADABLE', file, reason: 'not a cutover journal entry' };
    }
    return {
      status: 'PRESENT',
      entry: {
        phase: parsed.phase,
        displacedDatabase: parsed.displacedDatabase,
        candidateDatabase: parsed.candidateDatabase,
      },
    };
  }
}
