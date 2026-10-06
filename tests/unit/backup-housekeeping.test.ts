import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackupManifest, OperationalEventInput } from '@nexa/contracts';
import {
  BackupHousekeeping,
  requiredFreeBytes,
  type BackupHousekeepingDeps,
} from '../../apps/api/src/modules/platform/backup/application/backup-housekeeping';
import type {
  BackupDebrisSweep,
  BackupRunRow,
} from '../../apps/api/src/modules/platform/backup/application/ports';
import {
  CLI_SCRATCH_PREFIX,
  FilesystemBackupDebris,
  FilesystemBackupWorkspaces,
  privateScratchDirectory,
} from '../../apps/api/src/modules/platform/backup/infrastructure/workspace';
import {
  checksumFile,
  openArchive,
  sealArchive,
} from '../../apps/api/src/modules/platform/backup/infrastructure/archive';

/**
 * Backup housekeeping (Program E5): archive retention, the plaintext-debris
 * sweep, the disk-space condition and the overdue condition.
 *
 * The decisions are tested against fakes; the filesystem half against a real
 * directory under `mkdtemp`, with file times set explicitly, because "a file
 * nobody has written for the grace window" is a property of the filesystem and
 * not of this code's intentions.
 */

const NOW = new Date('2026-10-06T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GIB = 1024 * 1024 * 1024;

function row(overrides: Partial<BackupRunRow> = {}): BackupRunRow {
  return {
    id: '0192f000-0000-7000-8000-000000000001',
    trigger: 'SCHEDULED',
    state: 'SUCCEEDED',
    stage: 'CLEANUP',
    startedAt: NOW,
    finishedAt: NOW,
    leaseOwner: 'worker:x',
    leaseHeartbeatAt: NOW,
    dumpBytes: 100n,
    archiveBytes: 110n,
    checksum: 'a'.repeat(64),
    verifiedAt: NOW,
    deliveryState: 'SUCCEEDED',
    deliveryAttemptedAt: NOW,
    deliveryDetail: null,
    failureCode: null,
    failureMessage: null,
    cleanupOk: true,
    cleanupDetail: null,
    archivePrunedAt: null,
    ...overrides,
  };
}

interface World {
  now: number;
  quiesced: boolean;
  schedule: { enabled: boolean; intervalMs: number };
  retention: { keepCount: number; keepDays: number };
  protectedIds: string[];
  candidates: { id: string; state: 'SUCCEEDED' | 'FAILED' }[];
  candidateQueries: Parameters<BackupHousekeepingDeps['runs']['archivePruneCandidates']>[0][];
  stamped: string[];
  removed: string[];
  removeSurvives: Set<string>;
  running: string[];
  sweep: BackupDebrisSweep;
  sweepInputs: { olderThan: Date; skipIds: ReadonlySet<string> }[];
  free: number | null;
  latestVerified: BackupRunRow | null;
  latestFinished: BackupRunRow | null;
  lastSucceededAt: Date | null;
  open: Set<string>;
  recorded: OperationalEventInput[];
}

function world(): World {
  return {
    now: NOW.getTime(),
    quiesced: false,
    schedule: { enabled: true, intervalMs: DAY },
    retention: { keepCount: 14, keepDays: 30 },
    protectedIds: [],
    candidates: [],
    candidateQueries: [],
    stamped: [],
    removed: [],
    removeSurvives: new Set(),
    running: [],
    sweep: { removed: [], survived: [], pending: 0 },
    sweepInputs: [],
    free: 100 * GIB,
    latestVerified: row(),
    latestFinished: row(),
    lastSucceededAt: NOW,
    open: new Set(),
    recorded: [],
  };
}

function housekeeping(w: World, scoped = true): BackupHousekeeping {
  return new BackupHousekeeping({
    runs: {
      lastSucceededAt: async () => w.lastSucceededAt,
      archivePruneCandidates: async (input) => {
        w.candidateQueries.push(input);
        return w.candidates;
      },
      markArchivePruned: async ({ id }) => {
        w.stamped.push(id);
        return true;
      },
      runningIds: async () => w.running,
      latestFinished: async () => w.latestFinished,
      latestVerified: async () => w.latestVerified,
    },
    debris: {
      removeRunDirectory: async (id) => {
        w.removed.push(id);
        return w.removeSurvives.has(id) ? [`/b/${id}`] : [];
      },
      sweepPlaintext: async (input) => {
        w.sweepInputs.push(input);
        return w.sweep;
      },
      freeBytes: async () => w.free,
    },
    clock: { now: () => new Date(w.now) },
    opsLog: {
      async record(_scope, event) {
        w.recorded.push(event);
        return {
          id: 'e',
          code: event.code,
          severity: event.severity,
          message: event.message,
          occurrenceCount: 1,
          firstSeenAt: NOW,
          lastSeenAt: NOW,
          isNew: true,
          reopened: false,
        };
      },
    },
    scope: () => (scoped ? { tenantId: 't1' as never, botInstanceId: null } : null),
    conditionOpen: async (code) => w.open.has(code),
    quiesced: async () => w.quiesced,
    schedule: async () => w.schedule,
    retention: async () => w.retention,
    protectedByRecovery: async () => w.protectedIds,
    plaintextGraceMs: DAY,
    diskFloorBytes: GIB,
    tickIntervalMs: 15 * 60_000,
    initialDelayMs: 1_000,
    logger: { info() {}, warn() {}, error() {} },
  });
}

const codes = (w: World): string[] => w.recorded.map((event) => event.code);

describe('backup housekeeping: archive retention', () => {
  it('asks the run table with the settings in force and the recovery-protected ids', async () => {
    const w = world();
    w.retention = { keepCount: 3, keepDays: 7 };
    w.protectedIds = ['0192f000-0000-7000-8000-0000000000aa'];
    await housekeeping(w).pruneArchives();
    expect(w.candidateQueries).toHaveLength(1);
    expect(w.candidateQueries[0]).toMatchObject({
      keepCount: 3,
      protectedIds: ['0192f000-0000-7000-8000-0000000000aa'],
    });
    // keep-days measured from NOW, in whole days.
    expect(w.candidateQueries[0]?.finishedBefore.toISOString()).toBe(
      new Date(NOW.getTime() - 7 * DAY).toISOString(),
    );
  });

  it('removes each candidate directory and only THEN stamps the row', async () => {
    const w = world();
    w.candidates = [
      { id: '0192f000-0000-7000-8000-000000000011', state: 'SUCCEEDED' },
      { id: '0192f000-0000-7000-8000-000000000012', state: 'FAILED' },
    ];
    const pruned = await housekeeping(w).pruneArchives();
    expect(pruned).toBe(2);
    expect(w.removed).toEqual(w.candidates.map((c) => c.id));
    expect(w.stamped).toEqual(w.candidates.map((c) => c.id));
  });

  it('never stamps a row whose directory survived, so the row purge cannot orphan it', async () => {
    const w = world();
    const id = '0192f000-0000-7000-8000-000000000013';
    w.candidates = [{ id, state: 'SUCCEEDED' }];
    w.removeSurvives.add(id);
    expect(await housekeeping(w).pruneArchives()).toBe(0);
    expect(w.stamped).toEqual([]);
  });

  it('does nothing at all while a recovery holds the installation', async () => {
    const w = world();
    w.quiesced = true;
    w.candidates = [{ id: '0192f000-0000-7000-8000-000000000014', state: 'SUCCEEDED' }];
    w.sweep = { removed: [], survived: ['/b/x/dump.pgcustom'], pending: 0 };
    w.free = 1;
    w.lastSucceededAt = new Date(NOW.getTime() - 30 * DAY);
    const result = await housekeeping(w).pass();
    expect(result.skipped).toBe(true);
    expect(w.candidateQueries).toEqual([]);
    expect(w.removed).toEqual([]);
    expect(w.sweepInputs).toEqual([]);
    expect(w.recorded).toEqual([]);
  });
});

describe('backup housekeeping: plaintext debris and the cleanup condition', () => {
  it('skips the directories of RUNNING runs and uses the grace window', async () => {
    const w = world();
    w.running = ['0192f000-0000-7000-8000-000000000021'];
    await housekeeping(w).sweepDebris();
    expect(w.sweepInputs[0]?.skipIds.has('0192f000-0000-7000-8000-000000000021')).toBe(true);
    expect(w.sweepInputs[0]?.olderThan.getTime()).toBe(NOW.getTime() - DAY);
  });

  it('opens backup.cleanup_failed when plaintext could not be removed, without its path', async () => {
    const w = world();
    w.sweep = { removed: [], survived: ['/b/secret-dir/dump.pgcustom'], pending: 0 };
    await housekeeping(w).sweepDebris();
    const event = w.recorded.find((e) => e.code === 'backup.cleanup_failed');
    expect(event?.dedupeKey).toBe('backup.cleanup');
    expect(event?.message).not.toContain('secret-dir');
  });

  it('closes an open cleanup condition only when the host is clean', async () => {
    // Clean, open, and the newest run cleaned up: closed.
    const clean = world();
    clean.open.add('backup.cleanup_failed');
    await housekeeping(clean).sweepDebris();
    expect(codes(clean)).toEqual(['backup.cleanup_ok']);
    expect(clean.recorded[0]?.recoversCode).toBe('backup.cleanup_failed');

    // Plaintext still inside the grace window: NOT clean yet.
    const pending = world();
    pending.open.add('backup.cleanup_failed');
    pending.sweep = { removed: [], survived: [], pending: 1 };
    await housekeeping(pending).sweepDebris();
    expect(codes(pending)).toEqual([]);

    // The newest run left a scratch database: NOT clean.
    const leaked = world();
    leaked.open.add('backup.cleanup_failed');
    leaked.latestFinished = row({ cleanupOk: false });
    await housekeeping(leaked).sweepDebris();
    expect(codes(leaked)).toEqual([]);

    // Nothing open: nothing recorded.
    const healthy = world();
    await housekeeping(healthy).sweepDebris();
    expect(codes(healthy)).toEqual([]);
  });
});

describe('backup housekeeping: disk space', () => {
  it('estimates the next run from the last verified one, with a floor', () => {
    expect(requiredFreeBytes(null, GIB)).toBe(GIB);
    expect(requiredFreeBytes({ dumpBytes: 10n, archiveBytes: 10n }, GIB)).toBe(GIB);
    const big = 4 * GIB;
    expect(requiredFreeBytes({ dumpBytes: BigInt(big), archiveBytes: BigInt(big) }, GIB)).toBe(
      Math.ceil(3 * big * 1.5),
    );
  });

  it('opens below the requirement and closes above it only when open', async () => {
    const w = world();
    w.latestVerified = row({ dumpBytes: BigInt(2 * GIB), archiveBytes: BigInt(2 * GIB) });
    // needs (2*2 + 2) * 1.5 = 9 GiB
    w.free = 8 * GIB;
    await housekeeping(w).checkDisk();
    expect(codes(w)).toEqual(['backup.disk_threshold_exceeded']);
    expect(w.recorded[0]?.dedupeKey).toBe('backup.disk');

    w.recorded = [];
    w.free = 10 * GIB;
    await housekeeping(w).checkDisk();
    expect(codes(w)).toEqual([]);

    w.open.add('backup.disk_threshold_exceeded');
    await housekeeping(w).checkDisk();
    expect(codes(w)).toEqual(['backup.disk_threshold_ok']);
    expect(w.recorded[0]?.recoversCode).toBe('backup.disk_threshold_exceeded');
  });

  it('says nothing when the backup root does not exist yet', async () => {
    const w = world();
    w.free = null;
    await housekeeping(w).checkDisk();
    expect(w.recorded).toEqual([]);
  });
});

describe('backup housekeeping: the overdue condition', () => {
  it('opens when the schedule is on and the last verified backup is older than two intervals', async () => {
    const w = world();
    w.lastSucceededAt = new Date(NOW.getTime() - 2 * DAY - 1);
    await housekeeping(w).checkOverdue();
    expect(codes(w)).toEqual(['backup.interval_exceeded']);
    expect(w.recorded[0]?.dedupeKey).toBe('backup.interval');
  });

  it('is not overdue at exactly the tolerance, nor when the schedule is off', async () => {
    const atLimit = world();
    atLimit.lastSucceededAt = new Date(NOW.getTime() - 2 * DAY);
    await housekeeping(atLimit).checkOverdue();
    expect(codes(atLimit)).toEqual([]);

    const off = world();
    off.schedule = { enabled: false, intervalMs: DAY };
    off.lastSucceededAt = new Date(NOW.getTime() - 300 * DAY);
    await housekeeping(off).checkOverdue();
    expect(codes(off)).toEqual([]);
  });

  it('recovers when a fresh verified backup lands, or when the schedule is switched off', async () => {
    const fresh = world();
    fresh.open.add('backup.interval_exceeded');
    await housekeeping(fresh).checkOverdue();
    expect(codes(fresh)).toEqual(['backup.interval_ok']);
    expect(fresh.recorded[0]?.recoversCode).toBe('backup.interval_exceeded');

    const off = world();
    off.open.add('backup.interval_exceeded');
    off.schedule = { enabled: false, intervalMs: DAY };
    off.lastSucceededAt = new Date(NOW.getTime() - 300 * DAY);
    await housekeeping(off).checkOverdue();
    expect(codes(off)).toEqual(['backup.interval_ok']);
  });

  it('measures a never-backed-up installation from when it started watching', async () => {
    const w = world();
    w.lastSucceededAt = null;
    const watcher = housekeeping(w);
    await watcher.checkOverdue();
    expect(codes(w)).toEqual([]);
    w.now = NOW.getTime() + 2 * DAY + 1;
    await watcher.checkOverdue();
    expect(codes(w)).toEqual(['backup.interval_exceeded']);
  });

  it('records nothing when no tenant is provisioned', async () => {
    const w = world();
    w.lastSucceededAt = new Date(NOW.getTime() - 30 * DAY);
    await housekeeping(w, false).checkOverdue();
    expect(w.recorded).toEqual([]);
  });
});

describe('the backup volume on disk', () => {
  let root: string;
  let previousUmask: number;

  beforeEach(async () => {
    // Permissive, so a mode below is the code's choice and not the environment's.
    previousUmask = process.umask(0);
    root = await mkdtemp(join(tmpdir(), 'nexa-housekeeping-'));
  });

  afterEach(async () => {
    process.umask(previousUmask);
    await rm(root, { recursive: true, force: true });
  });

  const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

  it('creates run workspaces 0700 and writes the archive and the decrypted dump 0600', async () => {
    const workRoot = join(root, 'backups');
    const id = '0192f000-0000-7000-8000-000000000031';
    const workspace = await new FilesystemBackupWorkspaces(workRoot).create(id);
    expect(await mode(join(workRoot, id))).toBe(0o700);

    await writeFile(workspace.dumpPath, randomBytes(2048));
    const checksum = (await checksumFile(workspace.dumpPath)).checksum;
    const keyring = {
      activeKeyId: 'k',
      keys: new Map([['k', randomBytes(32)]]),
      format: 'canonical' as const,
    };
    const manifest: BackupManifest = {
      manifestVersion: 1,
      backupId: id,
      installationId: 'i',
      createdAt: NOW.toISOString(),
      databaseName: 'nexa',
      postgresVersion: '16.13',
      pgDumpVersion: 'pg_dump (PostgreSQL) 16.13',
      dumpFormat: 'custom',
      dumpBytes: 2048,
      checksumAlgorithm: 'sha256',
      checksum,
      exclusions: [],
    };
    await sealArchive({
      dumpPath: workspace.dumpPath,
      archivePath: workspace.archivePath,
      manifest,
      keyring,
    });
    expect(await mode(workspace.archivePath)).toBe(0o600);
    await openArchive({
      archivePath: workspace.archivePath,
      dumpPath: workspace.verifyDumpPath,
      keyring,
    });
    expect(await mode(workspace.verifyDumpPath)).toBe(0o600);
  });

  it('gives a CLI command a 0700 directory under the backup root, never /tmp', async () => {
    const workRoot = join(root, 'not-yet-created');
    const directory = await privateScratchDirectory(workRoot, 'verify');
    expect(directory.startsWith(join(workRoot, CLI_SCRATCH_PREFIX))).toBe(true);
    expect(await mode(directory)).toBe(0o700);
    expect(await mode(workRoot)).toBe(0o700);
  });

  it('removes only plaintext nobody wrote for the grace window, never an archive or a running run', async () => {
    const old = new Date(NOW.getTime() - 2 * DAY);
    const recent = new Date(NOW.getTime() - HOUR);
    const abandoned = '0192f000-0000-7000-8000-000000000041';
    const fresh = '0192f000-0000-7000-8000-000000000042';
    const running = '0192f000-0000-7000-8000-000000000043';
    for (const id of [abandoned, fresh, running]) {
      await mkdir(join(root, id));
      await writeFile(join(root, id, 'archive.nxb'), 'ciphertext');
      await writeFile(join(root, id, 'dump.pgcustom'), 'PGDMP plaintext');
    }
    await writeFile(join(root, abandoned, 'verify.pgcustom'), 'PGDMP plaintext');
    await utimes(join(root, abandoned, 'dump.pgcustom'), old, old);
    await utimes(join(root, abandoned, 'verify.pgcustom'), old, old);
    await utimes(join(root, fresh, 'dump.pgcustom'), recent, recent);
    await utimes(join(root, running, 'dump.pgcustom'), old, old);
    const cliOld = join(root, `${CLI_SCRATCH_PREFIX}verify-old`);
    const cliNew = join(root, `${CLI_SCRATCH_PREFIX}restore-new`);
    await mkdir(cliOld);
    await mkdir(cliNew);
    await writeFile(join(cliOld, 'dump.pgcustom'), 'PGDMP');
    await utimes(cliOld, old, old);
    await utimes(cliNew, recent, recent);
    // A directory that is not a run's is not this sweep's business.
    await mkdir(join(root, 'lost+found'));
    await writeFile(join(root, 'lost+found', 'dump.pgcustom'), 'x');
    await utimes(join(root, 'lost+found', 'dump.pgcustom'), old, old);

    const sweep = await new FilesystemBackupDebris(root).sweepPlaintext({
      olderThan: new Date(NOW.getTime() - DAY),
      skipIds: new Set([running]),
    });

    expect(sweep.survived).toEqual([]);
    expect([...sweep.removed].sort()).toEqual(
      [
        join(root, abandoned, 'dump.pgcustom'),
        join(root, abandoned, 'verify.pgcustom'),
        cliOld,
      ].sort(),
    );
    expect(sweep.pending).toBe(2); // the fresh dump and the fresh CLI directory
    expect(await readdir(join(root, abandoned))).toEqual(['archive.nxb']);
    expect((await readdir(join(root, fresh))).sort()).toEqual(['archive.nxb', 'dump.pgcustom']);
    expect((await readdir(join(root, running))).sort()).toEqual(['archive.nxb', 'dump.pgcustom']);
    expect(await readdir(join(root, 'lost+found'))).toEqual(['dump.pgcustom']);
  });

  it('removes a run directory by id, and refuses anything that is not a run id', async () => {
    const id = '0192f000-0000-7000-8000-000000000051';
    await mkdir(join(root, id));
    await writeFile(join(root, id, 'archive.nxb'), 'x');
    const debris = new FilesystemBackupDebris(root);
    expect(await debris.removeRunDirectory(id)).toEqual([]);
    expect(await readdir(root)).toEqual([]);
    // `..` is not a backup id; nothing outside the root may be named.
    expect(await debris.removeRunDirectory('..')).toEqual([join(root, '..')]);
  });

  it('reports free bytes on the volume, and null for a root that does not exist', async () => {
    expect(await new FilesystemBackupDebris(root).freeBytes()).toBeGreaterThan(0);
    expect(await new FilesystemBackupDebris(join(root, 'missing')).freeBytes()).toBeNull();
  });
});
