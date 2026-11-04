import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileCutoverJournal,
  type CutoverJournalIo,
} from '../../apps/api/src/modules/platform/recovery/infrastructure/cutover-journal';
import { CutoverJournalUnreadable } from '../../apps/api/src/modules/platform/recovery/application/ports';
import {
  RecoveryExecutor,
  type RecoveryExecutorDeps,
} from '../../apps/api/src/modules/platform/recovery/application/recovery-executor';

/**
 * The cutover journal is the only trace of a cutover in progress that a
 * database rename cannot move (ADR-0028 § 4). These cases are about the file
 * surviving a crash mid-write, and about a file that did NOT survive being
 * reported to a person rather than skipped or guessed at.
 */

const ID = '01900000-0000-7000-8000-0000000000d1';
const NOW = new Date('2026-11-03T10:00:00.000Z');

const NODE_IO: CutoverJournalIo = {
  mkdir: fsp.mkdir,
  open: fsp.open,
  rename: fsp.rename,
  readFile: fsp.readFile,
  readdir: fsp.readdir,
  rm: fsp.rm,
};

function entry(phase: 'ABOUT_TO_RENAME' | 'RENAMED_OUT' | 'RENAMED') {
  return {
    recoveryId: ID,
    phase,
    liveDatabase: 'nexa',
    candidateDatabase: 'nexa_candidate_d1',
    displacedDatabase: 'nexa_pre_restore_d1',
    at: NOW,
  };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexa-cutover-journal-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('writing the cutover journal', () => {
  it('replaces the previous journal and leaves no temp file behind', async () => {
    const journal = new FileCutoverJournal(root);
    await journal.write(entry('ABOUT_TO_RENAME'));
    await journal.write(entry('RENAMED'));
    expect(await journal.read(ID)).toEqual({
      status: 'PRESENT',
      entry: {
        phase: 'RENAMED',
        displacedDatabase: 'nexa_pre_restore_d1',
        candidateDatabase: 'nexa_candidate_d1',
      },
    });
    expect(await readdir(root)).toEqual([`cutover-${ID}.json`]);
    expect(await journal.pending()).toEqual([ID]);
  });

  it('leaves the previous journal intact when the write fails half-way', async () => {
    await new FileCutoverJournal(root).write(entry('ABOUT_TO_RENAME'));
    const before = await readFile(join(root, `cutover-${ID}.json`), 'utf8');

    // A write that gets half of the bytes out and then dies — what an OOM kill
    // or a full disk does to a file being written.
    const halfWay: CutoverJournalIo = {
      ...NODE_IO,
      open: (async (...args: Parameters<typeof fsp.open>) => {
        const handle = await fsp.open(...args);
        const realWriteFile = handle.writeFile.bind(handle);
        return Object.assign(handle, {
          writeFile: async (data: string) => {
            await realWriteFile(data.slice(0, Math.floor(data.length / 2)));
            throw errno('EIO');
          },
        });
      }) as typeof fsp.open,
    };
    const journal = new FileCutoverJournal(root, halfWay);

    await expect(journal.write(entry('RENAMED'))).rejects.toThrow('EIO');

    expect(await readFile(join(root, `cutover-${ID}.json`), 'utf8')).toBe(before);
    expect((await journal.read(ID)).status).toBe('PRESENT');
    // The half-written temp file is gone, and was never a journal to `pending()`.
    expect(await readdir(root)).toEqual([`cutover-${ID}.json`]);
  });

  it('leaves the previous journal intact when the rename fails', async () => {
    await new FileCutoverJournal(root).write(entry('ABOUT_TO_RENAME'));
    const before = await readFile(join(root, `cutover-${ID}.json`), 'utf8');
    const journal = new FileCutoverJournal(root, {
      ...NODE_IO,
      rename: (async () => {
        throw errno('EIO');
      }) as typeof fsp.rename,
    });

    await expect(journal.write(entry('RENAMED'))).rejects.toThrow('EIO');

    expect(await readFile(join(root, `cutover-${ID}.json`), 'utf8')).toBe(before);
    expect(await readdir(root)).toEqual([`cutover-${ID}.json`]);
  });

  it('fsyncs the temp file before the rename and the directory after it', async () => {
    const order: string[] = [];
    const journal = new FileCutoverJournal(root, {
      ...NODE_IO,
      open: (async (...args: Parameters<typeof fsp.open>) => {
        const handle = await fsp.open(...args);
        const realSync = handle.sync.bind(handle);
        const target = String(args[0]) === root ? 'dir' : 'temp';
        return Object.assign(handle, {
          sync: async () => {
            order.push(`sync:${target}`);
            await realSync();
          },
        });
      }) as typeof fsp.open,
      rename: (async (...args: Parameters<typeof fsp.rename>) => {
        order.push('rename');
        await fsp.rename(...args);
      }) as typeof fsp.rename,
    });
    await journal.write(entry('RENAMED'));
    expect(order).toEqual(['sync:temp', 'rename', 'sync:dir']);
  });
});

describe('reading the cutover journal', () => {
  it('lists nothing when the directory does not exist', async () => {
    expect(await new FileCutoverJournal(join(root, 'never-created')).pending()).toEqual([]);
  });

  it('refuses to answer "no journals" when the directory cannot be listed', async () => {
    const journal = new FileCutoverJournal(root, {
      ...NODE_IO,
      readdir: (async () => {
        throw errno('EACCES');
      }) as unknown as typeof fsp.readdir,
    });
    const failure = await journal.pending().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CutoverJournalUnreadable);
    expect((failure as CutoverJournalUnreadable).location).toBe(root);
  });

  it('tells an absent journal apart from one that cannot be read', async () => {
    expect(await new FileCutoverJournal(root).read(ID)).toEqual({ status: 'ABSENT' });

    await writeFile(join(root, `cutover-${ID}.json`), '{}', { mode: 0o600 });
    const journal = new FileCutoverJournal(root, {
      ...NODE_IO,
      readFile: (async () => {
        throw errno('EIO');
      }) as unknown as typeof fsp.readFile,
    });
    expect(await journal.read(ID)).toMatchObject({
      status: 'UNREADABLE',
      file: join(root, `cutover-${ID}.json`),
    });
  });

  it('reports a truncated journal as unreadable, not absent', async () => {
    await new FileCutoverJournal(root).write(entry('RENAMED'));
    const file = join(root, `cutover-${ID}.json`);
    const whole = await readFile(file, 'utf8');
    await writeFile(file, whole.slice(0, 40));
    expect(await new FileCutoverJournal(root).read(ID)).toMatchObject({
      status: 'UNREADABLE',
      file,
    });
  });
});

describe('reconciling an unreadable cutover journal', () => {
  function executor(journalRoot: string, io: CutoverJournalIo = NODE_IO) {
    const state = {
      events: [] as {
        code: string;
        message: string;
        context: Record<string, unknown>;
        dedupeKey?: string;
      }[],
      errors: [] as Record<string, unknown>[],
      lookedUp: [] as string[],
      reasserted: 0,
    };
    const requests = {
      byIdUnscoped: async (id: string) => {
        state.lookedUp.push(id);
        return null;
      },
      reassert: async () => {
        state.reasserted += 1;
      },
      reclaimStale: async () => [],
      claimOwn: async () => null,
      claimConfirmed: async () => null,
    };
    const instance = new RecoveryExecutor({
      requests,
      journal: new FileCutoverJournal(journalRoot, io),
      clock: { now: () => NOW },
      opsLog: {
        record: async (_scope: unknown, event: (typeof state.events)[number]) => {
          state.events.push(event);
          return {} as never;
        },
      },
      scope: () => ({ tenantId: 't1', botInstanceId: null }),
      leaseOwner: 'recovery:this-host',
      tickIntervalMs: 60_000,
      logger: {
        info() {},
        warn() {},
        error(context: Record<string, unknown>) {
          state.errors.push(context);
        },
      },
    } as unknown as RecoveryExecutorDeps);
    return { instance, state };
  }

  it('raises one alert naming the file for a truncated journal and takes no action', async () => {
    await new FileCutoverJournal(root).write(entry('RENAMED'));
    const file = join(root, `cutover-${ID}.json`);
    const truncated = (await readFile(file, 'utf8')).slice(0, 40);
    await writeFile(file, truncated);

    const { instance, state } = executor(root);
    await instance.tick();
    await instance.tick();

    // Logged as an error, naming the file.
    expect(state.errors.some((context) => context['file'] === file)).toBe(true);
    // The alert: CRITICAL `recovery.run_failed`, which reaches the ops group,
    // naming the file and deduped on it — one open condition, not one per tick.
    expect(state.events).toHaveLength(2);
    for (const event of state.events) {
      expect(event.code).toBe('recovery.run_failed');
      expect(event.message).toContain(file);
      expect(event.context).toEqual({ journalFile: file });
      expect(event.dedupeKey).toBe(`recovery.journal.${file}`);
      // No database name is guessed from the remains of the file.
      expect(event.message).not.toMatch(/nexa_(candidate|pre_restore)/);
    }
    // No action: no row looked up or written, and the file left exactly as found.
    expect(state.lookedUp).toEqual([]);
    expect(state.reasserted).toBe(0);
    expect(await readFile(file, 'utf8')).toBe(truncated);
  });

  it('raises an alert naming the directory when the journal cannot be listed', async () => {
    const { instance, state } = executor(root, {
      ...NODE_IO,
      readdir: (async () => {
        throw errno('EACCES');
      }) as unknown as typeof fsp.readdir,
    });
    await instance.tick();
    expect(state.events).toHaveLength(1);
    expect(state.events[0]?.code).toBe('recovery.run_failed');
    expect(state.events[0]?.message).toContain(root);
    expect(state.events[0]?.context).toEqual({ journalFile: root });
  });

  it('raises nothing when there is no journal directory at all', async () => {
    const { instance, state } = executor(join(root, 'never-created'));
    await instance.tick();
    expect(state.events).toEqual([]);
    expect(state.errors).toEqual([]);
  });
});
