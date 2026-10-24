import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BackupOrphanSweep,
  decideOrphanDirectory,
  type BackupOrphanRunFacts,
  type BackupOrphanRunReader,
} from '../../apps/api/src/modules/platform/backup/application/backup-orphan-sweep';
import { FilesystemBackupRunDirectories } from '../../apps/api/src/modules/platform/backup/infrastructure/run-directories';

/**
 * The orphan sweep (Round 8, B1): what it may remove, and — the half that matters — what
 * it must never touch: a run whose lease is live, a RUNNING row, a directory with no row,
 * files written recently, a run a recovery names, and the archive of a good backup.
 *
 * The decision is tested condition by condition; the filesystem half against a real
 * directory, because a fake directory would only agree with the fake sweep.
 */

const NOW = new Date('2026-03-01T09:00:00.000Z');
const MINUTE = 60_000;
const STALE = 15 * MINUTE;
const OLD = new Date(NOW.getTime() - 60 * MINUTE);

function facts(over: Partial<BackupOrphanRunFacts> = {}): BackupOrphanRunFacts {
  return {
    id: 'a0000000-0000-4000-8000-000000000001',
    state: 'FAILED',
    stage: 'DUMP',
    leaseHeartbeatAt: OLD,
    verifiedAt: null,
    failureCode: 'backup.tool_failed',
    ...over,
  };
}

function decide(
  row: BackupOrphanRunFacts | null,
  over: { lastWrittenAt?: Date; protectedIds?: string[]; exceptId?: string | null } = {},
) {
  return decideOrphanDirectory({
    directory: {
      id: 'a0000000-0000-4000-8000-000000000001',
      lastWrittenAt: over.lastWrittenAt ?? OLD,
    },
    row,
    now: NOW,
    minAgeMs: STALE,
    leaseStaleAfterMs: STALE,
    protectedIds: new Set(over.protectedIds ?? []),
    exceptId: over.exceptId ?? null,
  });
}

describe('decideOrphanDirectory', () => {
  it('removes the whole directory of a FAILED run that ended before verification', () => {
    for (const stage of ['DUMP', 'CHECKSUM', 'ENCRYPT', 'VERIFY_RESTORE'] as const) {
      expect(decide(facts({ stage }))).toBe('REMOVE_DIRECTORY');
    }
  });

  it('never touches a RUNNING run, whatever its lease says', () => {
    expect(decide(facts({ state: 'RUNNING' }))).toBe('KEEP');
  });

  it('never touches a run whose lease is still live', () => {
    expect(decide(facts({ leaseHeartbeatAt: new Date(NOW.getTime() - 5 * MINUTE) }))).toBe('KEEP');
  });

  it('never touches files written within the window, whatever the row says', () => {
    expect(decide(facts(), { lastWrittenAt: new Date(NOW.getTime() - 5 * MINUTE) })).toBe('KEEP');
  });

  it('never touches a directory this database has no row for', () => {
    expect(decide(null)).toBe('KEEP');
  });

  it('never touches a run an unfinished recovery names, or the caller’s own', () => {
    expect(decide(facts(), { protectedIds: [facts().id] })).toBe('KEEP');
    expect(decide(facts(), { exceptId: facts().id })).toBe('KEEP');
  });

  it('keeps the archive of a SUCCEEDED run and of one that had verified', () => {
    expect(decide(facts({ state: 'SUCCEEDED', stage: 'CLEANUP', verifiedAt: OLD }))).toBe(
      'REMOVE_PLAINTEXT',
    );
    // Killed mid-delivery: no verified_at (only finish writes it), but it passed verification.
    expect(decide(facts({ stage: 'DELIVER' }))).toBe('REMOVE_PLAINTEXT');
    expect(decide(facts({ stage: 'CLEANUP', verifiedAt: OLD }))).toBe('REMOVE_PLAINTEXT');
  });

  it('keeps the archive of a run reclaimed as abandoned: a restored database always holds one', () => {
    // The dump captured the run that took it while it was RUNNING at DUMP. After a restore
    // that row is reclaimed, and its directory holds the verified archive restored from.
    expect(decide(facts({ stage: 'DUMP', failureCode: 'backup.lease_expired' }))).toBe(
      'REMOVE_PLAINTEXT',
    );
  });
});

describe('the orphan sweep against a real directory', () => {
  let root: string;
  const ids = {
    killed: 'b0000000-0000-4000-8000-000000000001',
    failedOwn: 'b0000000-0000-4000-8000-000000000008',
    live: 'b0000000-0000-4000-8000-000000000002',
    running: 'b0000000-0000-4000-8000-000000000003',
    newestGood: 'b0000000-0000-4000-8000-000000000004',
    noRow: 'b0000000-0000-4000-8000-000000000005',
    fresh: 'b0000000-0000-4000-8000-000000000006',
    restoring: 'b0000000-0000-4000-8000-000000000007',
  };
  const rows: BackupOrphanRunFacts[] = [
    facts({ id: ids.killed, stage: 'VERIFY_RESTORE', failureCode: 'backup.lease_expired' }),
    // Failed by its own process, whose removal did not happen (the `catch` never got there).
    facts({ id: ids.failedOwn, stage: 'ENCRYPT' }),
    // Real time, like the sweep's clock below: this run's heartbeat is a minute old.
    facts({ id: ids.live, leaseHeartbeatAt: new Date(Date.now() - MINUTE) }),
    facts({ id: ids.running, state: 'RUNNING' }),
    facts({ id: ids.newestGood, state: 'SUCCEEDED', stage: 'CLEANUP', verifiedAt: OLD }),
    facts({ id: ids.fresh }),
    facts({ id: ids.restoring }),
  ];
  const pruned: string[] = [];
  const reader: BackupOrphanRunReader = {
    async orphanRunFacts(asked) {
      return rows.filter((one) => asked.includes(one.id));
    },
    async markArchivePruned(input) {
      pruned.push(input.id);
      return true;
    },
  };

  async function runDirectory(id: string, files: string[], writtenAt: Date): Promise<void> {
    const directory = join(root, id);
    await mkdir(directory, { recursive: true });
    for (const name of files) {
      await writeFile(join(directory, name), `${name} bytes`);
      await utimes(join(directory, name), writtenAt, writtenAt);
    }
    await utimes(directory, writtenAt, writtenAt);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexa-orphan-sweep-'));
    pruned.length = 0;
    const all = ['dump.pgcustom', 'verify.pgcustom', 'archive.7z'];
    for (const id of [ids.killed, ids.failedOwn, ids.live, ids.running, ids.noRow, ids.restoring]) {
      await runDirectory(id, all, OLD);
    }
    await runDirectory(ids.newestGood, ['archive.7z', 'dump.pgcustom'], OLD);
    await runDirectory(ids.fresh, all, new Date());
    await mkdir(join(root, '.cli-verify-abc'));
    await writeFile(join(root, '.cli-verify-abc', 'dump.pgcustom'), 'x');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function sweeper(): BackupOrphanSweep {
    return new BackupOrphanSweep({
      directories: new FilesystemBackupRunDirectories(root),
      runs: reader,
      // Real time, because file modification times are: OLD (2026-03-01) is months before
      // it, and the "fresh" directory is written as the test starts.
      clock: { now: () => new Date() },
      protectedByRecovery: async () => [ids.restoring],
      logger: { warn() {}, error() {} },
    });
  }

  it('removes killed runs’ plaintext and an unproven run whole, and keeps the newest good archive', async () => {
    const result = await sweeper().sweep({ exceptId: ids.running });

    expect(result.directories).toEqual([ids.failedOwn]);
    expect(pruned).toEqual([ids.failedOwn]);
    expect(result.survived).toEqual([]);
    const left = new Set(await readdir(root));
    expect(left.has(ids.failedOwn)).toBe(false);
    // The reclaimed run: its 2 GB of plaintext goes, its archive is retention's.
    expect(await readdir(join(root, ids.killed))).toEqual(['archive.7z']);
    for (const kept of [ids.live, ids.running, ids.noRow, ids.fresh, ids.restoring]) {
      expect(left.has(kept)).toBe(true);
      expect(await readdir(join(root, kept))).toHaveLength(3);
    }
    // The newest good backup: its leftover plaintext goes, its archive never.
    expect(await readdir(join(root, ids.newestGood))).toEqual(['archive.7z']);
    expect([...result.files].sort()).toEqual(
      [
        join(root, ids.killed, 'dump.pgcustom'),
        join(root, ids.killed, 'verify.pgcustom'),
        join(root, ids.newestGood, 'dump.pgcustom'),
      ].sort(),
    );
    // A CLI scratch directory is not a run's: the housekeeping sweep owns it.
    expect(left.has('.cli-verify-abc')).toBe(true);
  });

  it('a missing root is nothing to sweep, not a failure', async () => {
    await rm(root, { recursive: true, force: true });
    expect(await sweeper().sweep()).toEqual({ directories: [], files: [], survived: [] });
  });
});
