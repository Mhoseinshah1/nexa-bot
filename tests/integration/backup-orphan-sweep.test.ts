import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_PART_MAX_BYTES, type Clock, type OperationalEventRecorder } from '@nexa/contracts';
import { planArchiveParts } from '../../apps/api/src/modules/platform/backup/infrastructure/archive-parts';
import { PostgresDatabaseTools } from '../../apps/api/src/modules/platform/backup/infrastructure/pg-tools';
import { FilesystemBackupWorkspaces } from '../../apps/api/src/modules/platform/backup/infrastructure/workspace';
import { FilesystemBackupRunDirectories } from '../../apps/api/src/modules/platform/backup/infrastructure/run-directories';
import { BackupService } from '../../apps/api/src/modules/platform/backup/application/backup.service';
import { BackupScheduler } from '../../apps/api/src/modules/platform/backup/application/backup-scheduler';
import { BackupOrphanSweep } from '../../apps/api/src/modules/platform/backup/application/backup-orphan-sweep';
import { createTestContext, testConfig, type TestContext } from './harness';
import { SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';

/**
 * Round 8, B1 and B4, against the real run table, the real one-backup lock, the real
 * operational-event recorder and a real directory (the evidence: a 17.8 GB backup volume of
 * leftovers from killed runs, and a failed scheduled run retried every five minutes).
 */

const MIGRATOR = fileURLToPath(
  new URL('../../apps/api/src/infrastructure/persistence/migrate.ts', import.meta.url),
);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

class FakeClock implements Clock {
  constructor(private ms: number) {}
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

describe('backup cleanup and retries against a real database', () => {
  let context: TestContext;
  let workDir: string;

  beforeAll(async () => {
    context = await createTestContext();
  }, 60_000);

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
    workDir = await mkdtemp(join(tmpdir(), 'nexa-backup-r8-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function service(
    options: {
      workDir?: string;
      clock?: Clock;
      opsLog?: OperationalEventRecorder;
      sweep?: boolean;
    } = {},
  ): BackupService {
    const config = testConfig();
    const clock = options.clock ?? context.container.clock;
    const opsLog = options.opsLog ?? context.container.opsLog;
    return new BackupService({
      runs: context.container.backupRuns,
      tools: new PostgresDatabaseTools({
        databaseUrl: config.DATABASE_URL,
        dumpTimeoutMs: 120_000,
        restoreTimeoutMs: 120_000,
        migratorEntrypoint: MIGRATOR,
      }),
      archiver: context.container.backupArchiver,
      workspaces: new FilesystemBackupWorkspaces(options.workDir ?? workDir),
      delivery: {
        configured: false,
        async sendDocument() {
          return { state: 'FAILED_DEFINITIVE', detail: 'not in a test' };
        },
        async sendMessage() {
          return { state: 'FAILED_DEFINITIVE', detail: 'not in a test' };
        },
      },
      clock,
      ids: context.container.ids,
      installationId: () => 'integration-installation',
      opsLog,
      quietOpsLog: opsLog,
      scope: () => ({ tenantId: SEED_IDS.tenantA as never, botInstanceId: null }),
      logger: { info() {}, warn() {}, error() {} },
      leaseOwner: `test:${randomBytes(4).toString('hex')}`,
      parts: {
        plan: (input) => planArchiveParts({ ...input, partBytes: BACKUP_PART_MAX_BYTES }),
      },
      restoreCommand: 'botctl restore --target <db> <parts>',
      ...(options.sweep === false ? {} : { orphanSweep: sweep(clock) }),
    });
  }

  function sweep(clock: Clock = context.container.clock): BackupOrphanSweep {
    return new BackupOrphanSweep({
      directories: new FilesystemBackupRunDirectories(workDir),
      runs: context.container.backupRuns,
      clock,
      protectedByRecovery: async () => [],
      logger: { warn() {}, error() {} },
    });
  }

  /** A run directory as a killed process leaves it: plaintext and a half-written archive. */
  async function leftovers(id: string, writtenAt: Date, names: readonly string[]): Promise<void> {
    const directory = join(workDir, id);
    await mkdir(directory, { recursive: true });
    for (const name of names) {
      await writeFile(join(directory, name), randomBytes(1024));
      await utimes(join(directory, name), writtenAt, writtenAt);
    }
    await utimes(directory, writtenAt, writtenAt);
  }

  const KILLED_FILES = ['dump.pgcustom', 'verify.pgcustom', 'archive.7z'] as const;

  it('the next run reclaims a KILLED run and removes its plaintext, keeping its archive', async () => {
    const hourAgo = new Date(context.container.clock.now().getTime() - HOUR);
    const claim = await context.container.backupRuns.start({
      id: context.container.ids.uuid(),
      trigger: 'SCHEDULED',
      leaseOwner: 'a-worker-that-was-killed',
      now: hourAgo,
    });
    if (!claim.claimed) throw new Error('unreachable');
    await leftovers(claim.run.id, hourAgo, KILLED_FILES);

    const outcome = await service().run('MANUAL');
    if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
    expect(outcome.run.state).toBe('SUCCEEDED');

    const killed = await context.container.backupRuns.byId(claim.run.id);
    expect(killed?.failureCode).toBe('backup.lease_expired');
    // A reclaimed row cannot say whether its archive verified (a restored database holds one
    // whose archive is the one restored from), so the archive is retention's; the 2 GB of
    // plaintext is gone now rather than in a day.
    expect(await readdir(join(workDir, claim.run.id))).toEqual(['archive.7z']);
    expect(killed?.archivePrunedAt).toBeNull();
    const left = await readdir(workDir);
    // The new run's own directory, holding its verified archive, is untouched.
    expect(left).toContain(outcome.run.id);
    expect(
      (await readdir(join(workDir, outcome.run.id))).some((f) => f.startsWith('archive')),
    ).toBe(true);
  }, 180_000);

  it('the start-up sweep skips a live lease, a fresh write and a directory with no row', async () => {
    const now = context.container.clock.now();
    const hourAgo = new Date(now.getTime() - HOUR);
    // A run in flight in another process: RUNNING, heartbeat a minute old, files old (a
    // verification's pg_restore READS its dump for a long time and writes nothing).
    const live = await context.container.backupRuns.start({
      id: context.container.ids.uuid(),
      trigger: 'SCHEDULED',
      leaseOwner: 'another-worker',
      now: new Date(now.getTime() - MINUTE),
    });
    if (!live.claimed) throw new Error('unreachable');
    await leftovers(live.run.id, hourAgo, KILLED_FILES);
    // No row in this database: another installation's, or a pre-restore backup's.
    const stranger = context.container.ids.uuid();
    await leftovers(stranger, hourAgo, KILLED_FILES);

    const result = await sweep().sweep();
    expect(result).toEqual({ directories: [], files: [], survived: [] });
    expect((await readdir(join(workDir, live.run.id))).sort()).toEqual([...KILLED_FILES].sort());
    expect((await readdir(join(workDir, stranger))).sort()).toEqual([...KILLED_FILES].sort());

    // The same rows once the other process is gone: its run reclaimed (FAILED), its lease
    // stale — but a file written a moment ago (a paused writer that resumed) is still kept.
    await context.container.database.db.execute(
      sql`UPDATE backup_runs SET lease_heartbeat_at = ${hourAgo} WHERE id = ${live.run.id}::uuid`,
    );
    expect(
      await context.container.backupRuns.reclaimStale({
        staleBefore: new Date(now.getTime() - 15 * MINUTE),
        now,
      }),
    ).toBe(1);
    await writeFile(join(workDir, live.run.id, 'dump.pgcustom'), 'still being written');
    expect((await sweep().sweep()).directories).toEqual([]);
    await utimes(join(workDir, live.run.id, 'dump.pgcustom'), hourAgo, hourAgo);
    const swept = await sweep().sweep();
    expect([...swept.files].sort()).toEqual(
      [
        join(workDir, live.run.id, 'dump.pgcustom'),
        join(workDir, live.run.id, 'verify.pgcustom'),
      ].sort(),
    );
    expect(await readdir(join(workDir, live.run.id))).toEqual(['archive.7z']);
    expect((await readdir(join(workDir, stranger))).sort()).toEqual([...KILLED_FILES].sort());
  }, 60_000);

  it('removes the whole directory of a run its own process failed before verification', async () => {
    const hourAgo = new Date(context.container.clock.now().getTime() - HOUR);
    const claim = await context.container.backupRuns.start({
      id: context.container.ids.uuid(),
      trigger: 'SCHEDULED',
      leaseOwner: 'a-worker',
      now: hourAgo,
    });
    if (!claim.claimed) throw new Error('unreachable');
    await context.container.backupRuns.finish({
      id: claim.run.id,
      leaseOwner: 'a-worker',
      state: 'FAILED',
      stage: 'ENCRYPT',
      now: hourAgo,
      deliveryState: 'NOT_ATTEMPTED',
      failureCode: 'backup.tool_failed',
      failureMessage: 'exited 2',
      cleanupOk: false,
      cleanupDetail: 'workspace survived',
    });
    await leftovers(claim.run.id, hourAgo, KILLED_FILES);

    const result = await sweep().sweep();
    expect(result.directories).toEqual([claim.run.id]);
    expect(await readdir(workDir)).toEqual([]);
    expect((await context.container.backupRuns.byId(claim.run.id))?.archivePrunedAt).not.toBeNull();
  }, 60_000);

  it('never removes the newest good archive, only the plaintext beside it', async () => {
    const outcome = await service().run('MANUAL');
    if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
    expect(outcome.run.state).toBe('SUCCEEDED');
    const id = outcome.run.id;
    const hourAgo = new Date(context.container.clock.now().getTime() - HOUR);
    // Its lease long stale, its files old, and a plaintext dump left beside the archive.
    await context.container.database.db.execute(
      sql`UPDATE backup_runs SET lease_heartbeat_at = ${hourAgo} WHERE id = ${id}::uuid`,
    );
    await leftovers(id, hourAgo, ['dump.pgcustom']);
    for (const name of await readdir(join(workDir, id))) {
      await utimes(join(workDir, id, name), hourAgo, hourAgo);
    }
    const archives = (await readdir(join(workDir, id))).filter((f) => f.startsWith('archive'));
    expect(archives.length).toBe(1);

    const result = await sweep().sweep();
    expect(result.directories).toEqual([]);
    expect(result.files).toEqual([join(workDir, id, 'dump.pgcustom')]);
    expect(await readdir(join(workDir, id))).toEqual(archives);
    expect((await context.container.backupRuns.byId(id))?.archivePrunedAt).toBeNull();
  }, 180_000);

  it('a failing schedule backs off instead of retrying every tick, and alerts once', async () => {
    // The disk-full shape: the work directory cannot be written, so every run fails at its
    // first stage within a second — the evidence's `backup.tool_failed` ~30 s into a dump.
    const blocker = join(workDir, 'not-a-directory');
    await writeFile(blocker, 'occupying the path the work root needs');
    const clock = new FakeClock(context.container.clock.now().getTime());
    let announced = 0;
    let occurrences = 0;
    // The REAL recorder; this counts what the Telegram projector would announce, which is a
    // new or reopened condition and nothing else (`operational-event-projector.ts`).
    const opsLog: OperationalEventRecorder = {
      async record(scope, event, tx) {
        const recorded = await context.container.opsLog.record(scope, event, tx);
        if (event.code === 'backup.run_failed') {
          occurrences += 1;
          if (recorded.isNew || recorded.reopened) announced += 1;
        }
        return recorded;
      },
    };
    const failing = service({ workDir: join(blocker, 'runs'), clock, opsLog, sweep: false });
    const scheduler = new BackupScheduler({
      service: failing,
      runs: context.container.backupRuns,
      quiesced: async () => false,
      clock,
      schedule: async () => ({ enabled: true, intervalMs: 24 * HOUR, dailyTime: null }),
      tickIntervalMs: 5 * MINUTE,
      runHeartbeatAt: () => null,
      runStaleAfterMs: 15 * MINUTE,
      logger: { info() {}, warn() {}, error() {} },
    });

    // Six hours of five-minute ticks: 72 ticks, which used to be 72 failed runs.
    const started = clock.now().getTime();
    for (let tick = 0; tick < 72; tick += 1) {
      await scheduler.tick();
      clock.advance(5 * MINUTE);
    }
    const rows = await context.container.database.db.execute<{ started_at: Date }>(
      sql`SELECT started_at FROM backup_runs ORDER BY started_at`,
    );
    const offsets = rows.rows.map((row) => new Date(row.started_at).getTime() - started);
    expect(offsets).toEqual([0, 30 * MINUTE, 90 * MINUTE, 210 * MINUTE]);
    expect(occurrences).toBe(4);
    expect(announced).toBe(1);
    const events = await context.container.database.db.execute<{ occurrence_count: number }>(
      sql`SELECT occurrence_count FROM operational_events WHERE code = 'backup.run_failed'`,
    );
    expect(events.rows.map((row) => Number(row.occurrence_count))).toEqual([4]);
  }, 120_000);
});
