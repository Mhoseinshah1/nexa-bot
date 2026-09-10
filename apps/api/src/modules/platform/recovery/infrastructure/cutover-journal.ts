import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recoveryIdSchema } from '@nexa/contracts';
import type { CutoverJournal } from '../application/ports.js';

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
  constructor(private readonly root: string) {}

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
    phase: 'ABOUT_TO_RENAME' | 'RENAMED';
    liveDatabase: string;
    candidateDatabase: string;
    displacedDatabase: string;
    at: Date;
  }): Promise<void> {
    const path = this.path(entry.recoveryId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ ...entry, at: entry.at.toISOString() }, null, 2), {
      mode: 0o600,
    });
  }

  async read(
    recoveryId: string,
  ): Promise<{ phase: 'ABOUT_TO_RENAME' | 'RENAMED'; displacedDatabase: string } | null> {
    let raw: string;
    try {
      raw = await readFile(this.path(recoveryId), 'utf8');
    } catch {
      // Absent is an ANSWER — no cutover was ever begun for this recovery — and
      // it is the common case, since most recoveries never reach that stage.
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as { phase?: unknown; displacedDatabase?: unknown };
      if (
        (parsed.phase !== 'ABOUT_TO_RENAME' && parsed.phase !== 'RENAMED') ||
        typeof parsed.displacedDatabase !== 'string'
      ) {
        return null;
      }
      return { phase: parsed.phase, displacedDatabase: parsed.displacedDatabase };
    } catch {
      // A journal we cannot parse is treated as absent, which is the SAFE
      // reading: the executor then re-checks the databases themselves rather
      // than acting on a half-written file. A partially written JSON file is
      // exactly what a crash mid-write leaves.
      return null;
    }
  }
}
