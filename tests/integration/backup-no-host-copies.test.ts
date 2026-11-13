import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  BACKUP_ARCHIVE_KEEP_ON_HOST_SETTING_KEY,
  BACKUP_PART_MAX_BYTES,
  BACKUP_ARCHIVE_REMOVED_AFTER_DELIVERY_CODE,
  type ActorContext,
} from '@nexa/contracts';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  testConfig,
  type TestContext,
} from './harness';
import {
  backupRunParts,
  backupRuns,
  recoveryRequests,
} from '../../apps/api/src/infrastructure/persistence/schema';
import { PostgresDatabaseTools } from '../../apps/api/src/modules/platform/backup/infrastructure/pg-tools';
import { planArchiveParts } from '../../apps/api/src/modules/platform/backup/infrastructure/archive-parts';
import { FilesystemBackupWorkspaces } from '../../apps/api/src/modules/platform/backup/infrastructure/workspace';
import { BackupService } from '../../apps/api/src/modules/platform/backup/application/backup.service';

/**
 * Owner decision 2026-11-11 — «بدون نگهداری» (`backup.archive_keep_on_host` = false).
 *
 * Once the Telegram backup group holds a run's archive in full, the archive and its working
 * directory leave the host — and NOTHING else does. Every rule is a predicate of
 * `deliveredCopyPruneCandidates`, so each "kept" case below is a real row in a real
 * database and a real directory on disk, removed (or not) by the container's own
 * housekeeping, which reads the setting on the installation tenant as production does.
 *
 * The rows are inserted directly, like `backup-retention.test.ts`: a state such as "run
 * FAILED after its parts were delivered" is one the pipeline reaches only on a crash at
 * CLEANUP, and the schema admits it. The confirmed-delivery path itself is driven end to end
 * by a real backup in the last case.
 */

const MIGRATOR = fileURLToPath(
  new URL('../../apps/api/src/infrastructure/persistence/migrate.ts', import.meta.url),
);

describe('backup without copies on the server (backup.archive_keep_on_host)', () => {
  let context: TestContext;
  let workRoot: string;
  let owner: ActorContext;
  let keys = 0;
  const key = () => `keep-on-host-${(keys += 1)}-${Date.now()}`;

  beforeAll(async () => {
    workRoot = await mkdtemp(join(tmpdir(), 'nexa-no-host-copies-'));
    context = await createTestContext({ BACKUP_WORK_DIR: workRoot });
  }, 60_000);

  afterAll(async () => {
    await context?.close();
    await rm(workRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await context.reset();
    context.container.setInstallationTenant(tenantA.tenantId);
    owner = adminActorFor(
      await createAdmin(context.container, tenantA, { username: 'owner', roleKeys: ['owner'] }),
    );
    await rm(workRoot, { recursive: true, force: true });
    await mkdir(workRoot, { recursive: true });
  });

  const db = () => context.container.database.db;
  let minute = 0;
  const at = () => new Date(Date.UTC(2026, 10, 1, 0, (minute += 1)));

  /** Stores the switch through the ordinary, audited settings write. */
  async function keepOnHost(value: boolean, scope = tenantA, actor = owner): Promise<void> {
    const current = await context.container.settingsService.get(
      scope,
      actor,
      BACKUP_ARCHIVE_KEEP_ON_HOST_SETTING_KEY,
    );
    await context.container.settingsService.set(scope, actor, {
      key: BACKUP_ARCHIVE_KEEP_ON_HOST_SETTING_KEY,
      value,
      expectedVersion: current.version,
      idempotencyKey: key(),
    });
  }

  type PartSpec = {
    state: 'SUCCEEDED' | 'FAILED_DEFINITIVE' | 'OUTCOME_UNKNOWN';
    messageId: bigint | null;
  };
  const delivered: PartSpec = { state: 'SUCCEEDED', messageId: 77n };

  /** One run row, its part rows, and its directory with an archive in it. */
  async function run(
    input: {
      state?: 'SUCCEEDED' | 'FAILED' | 'RUNNING';
      verified?: boolean;
      deliveryState?: 'SUCCEEDED' | 'FAILED_DEFINITIVE' | 'OUTCOME_UNKNOWN' | 'NOT_ATTEMPTED';
      parts?: PartSpec[];
      partCount?: number;
      tenantArchive?: boolean;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    const state = input.state ?? 'SUCCEEDED';
    const startedAt = at();
    const parts = input.parts ?? [delivered, delivered];
    await db()
      .insert(backupRuns)
      .values({
        id,
        trigger: 'SCHEDULED',
        archiveScope: input.tenantArchive === true ? 'TENANT' : 'INSTALLATION',
        subjectTenantId: input.tenantArchive === true ? tenantB.tenantId : null,
        state,
        stage: state === 'RUNNING' ? 'DELIVER' : 'CLEANUP',
        startedAt,
        finishedAt: state === 'RUNNING' ? null : startedAt,
        leaseOwner: 'test',
        leaseHeartbeatAt: startedAt,
        verifiedAt: input.verified === false ? null : startedAt,
        deliveryState: input.deliveryState ?? 'SUCCEEDED',
        cleanupOk: true,
        archiveFormat: 'SEVEN_ZIP',
        partCount: input.partCount ?? parts.length,
      } as never);
    let rangeStart = 0n;
    for (const [index, part] of parts.entries()) {
      await db()
        .insert(backupRunParts)
        .values({
          backupId: id,
          partNumber: index + 1,
          filename: `nexa.7z.00${String(index + 1)}`,
          rangeStart,
          bytes: 10n,
          sha256: 'c'.repeat(64),
          deliveryState: part.state,
          deliveryAttemptedAt: startedAt,
          telegramMessageId: part.messageId,
        } as never);
      rangeStart += 10n;
    }
    await mkdir(join(workRoot, id), { recursive: true });
    await writeFile(join(workRoot, id, 'archive.7z'), randomBytes(32));
    return id;
  }

  const onDisk = (id: string) =>
    stat(join(workRoot, id)).then(
      () => true,
      () => false,
    );
  const pruneNow = () => context.container.backupHousekeeping.pruneDeliveredCopies();
  const removalLines = async () =>
    (
      await db().execute<{ backup_id: string; message: string }>(
        sql`SELECT context->>'backupId' AS backup_id, message FROM operational_events
             WHERE code = ${BACKUP_ARCHIVE_REMOVED_AFTER_DELIVERY_CODE} ORDER BY message`,
      )
    ).rows;

  it('defaults to true: today’s pruning, the newest delivered copy stays, and no removal line', async () => {
    const older = await run();
    const newest = await run();
    // `backup.local_copies_keep` default 1: the older delivered copy goes, as before.
    expect(await pruneNow()).toBe(1);
    expect(await onDisk(older)).toBe(false);
    expect(await onDisk(newest)).toBe(true);
    expect(await removalLines()).toEqual([]);
  });

  it('off: a confirmed delivery leaves the host — the newest verified archive too — with one ops line naming the run', async () => {
    await keepOnHost(false);
    const older = await run();
    const newest = await run();
    expect(await pruneNow()).toBe(2);
    expect(await onDisk(older)).toBe(false);
    expect(await onDisk(newest)).toBe(false);
    for (const id of [older, newest]) {
      expect((await context.container.backupRuns.byId(id))?.archivePrunedAt).not.toBeNull();
    }
    const lines = await removalLines();
    expect(lines.map((line) => line.backup_id).sort()).toEqual([older, newest].sort());
    for (const line of lines) expect(line.message).toContain(line.backup_id);
    // Nothing left to remove: a second pass removes and reports nothing more.
    expect(await pruneNow()).toBe(0);
    expect(await removalLines()).toHaveLength(2);
  });

  describe('off: NEVER removed, and kept for the keep-count / keep-days pruning', () => {
    beforeEach(async () => {
      await keepOnHost(false);
    });

    /** Each kept case beside one confirmed run, so the pass is proven to have run. */
    async function keptBeside(kept: string): Promise<void> {
      const confirmed = await run();
      expect(await pruneNow()).toBe(1);
      expect(await onDisk(confirmed)).toBe(false);
      expect(await onDisk(kept)).toBe(true);
      expect((await context.container.backupRuns.byId(kept))?.archivePrunedAt).toBeNull();
      expect((await removalLines()).map((line) => line.backup_id)).toEqual([confirmed]);
    }

    it('a run-level FAILED delivery', async () => {
      await keptBeside(await run({ deliveryState: 'FAILED_DEFINITIVE' }));
    });

    it('a part whose delivery FAILED (no message id)', async () => {
      await keptBeside(
        await run({ parts: [delivered, { state: 'FAILED_DEFINITIVE', messageId: null }] }),
      );
    });

    it('an UNKNOWN delivery outcome', async () => {
      await keptBeside(
        await run({
          deliveryState: 'OUTCOME_UNKNOWN',
          parts: [delivered, { state: 'OUTCOME_UNKNOWN', messageId: null }],
        }),
      );
    });

    it('a part answered SUCCEEDED without a message id', async () => {
      await keptBeside(await run({ parts: [delivered, { state: 'SUCCEEDED', messageId: null }] }));
    });

    it('a run whose recorded parts are fewer than its part count', async () => {
      await keptBeside(await run({ parts: [delivered], partCount: 2 }));
    });

    it('a run still in flight', async () => {
      await keptBeside(await run({ state: 'RUNNING' }));
    });

    it('a run that FAILED after its parts were delivered', async () => {
      await keptBeside(await run({ state: 'FAILED' }));
    });

    it('a run whose verification did not pass', async () => {
      await keptBeside(await run({ verified: false }));
    });

    it('a run an unfinished recovery names', async () => {
      const named = await run();
      const now = at();
      await db()
        .insert(recoveryRequests)
        .values({
          id: randomUUID(),
          tenantId: tenantA.tenantId,
          source: 'UPLOAD',
          state: 'RESTORE_TEST_PASSED',
          stage: 'AWAIT_CONFIRMATION',
          createdAt: now,
          updatedAt: now,
          backupId: named,
        } as never);
      await keptBeside(named);
    });

    it('a hosted bot’s archive', async () => {
      await keptBeside(await run({ tenantArchive: true }));
    });
  });

  it('right after a run: never a recovery’s emergency (PRE_RESTORE) backup, which no recovery names yet', async () => {
    await keepOnHost(false);
    const emergency = await run();
    // The recovery names its emergency backup only after the run returns, so nothing
    // protects it by id at this moment.
    await context.container.backupHousekeeping.afterRun({ trigger: 'PRE_RESTORE' });
    expect(await onDisk(emergency)).toBe(true);
    expect(await removalLines()).toEqual([]);
    // Any other run's afterRun removes the confirmed copy at once.
    await context.container.backupHousekeeping.afterRun({ trigger: 'MANUAL' });
    expect(await onDisk(emergency)).toBe(false);
  });

  it('is read on the installation tenant only: another tenant’s false changes nothing', async () => {
    const ownerB = adminActorFor(
      await createAdmin(context.container, tenantB, { username: 'owner-b', roleKeys: ['owner'] }),
    );
    await keepOnHost(false, tenantB, ownerB);
    await run();
    const newest = await run();
    expect(await pruneNow()).toBe(1);
    expect(await onDisk(newest)).toBe(true);
    expect(await removalLines()).toEqual([]);
  });

  it('switching back to true restores nothing and stops removing the newest copy', async () => {
    await keepOnHost(false);
    const gone = await run();
    expect(await pruneNow()).toBe(1);
    await keepOnHost(true);
    expect(await onDisk(gone)).toBe(false);
    const fresh = await run();
    expect(await pruneNow()).toBe(0);
    expect(await onDisk(fresh)).toBe(true);
  });

  it('changing the setting is audited', async () => {
    await keepOnHost(false);
    await keepOnHost(true);
    const audit = await db().execute<{ before: unknown; after: unknown }>(
      sql`SELECT before, after FROM audit_logs
           WHERE action = 'settings.set' AND entity_id = ${BACKUP_ARCHIVE_KEEP_ON_HOST_SETTING_KEY}
           ORDER BY occurred_at, id`,
    );
    expect(audit.rows.map((row) => (row.after as { value: unknown }).value)).toEqual([false, true]);
  });

  it('end to end: a real backup whose delivery is confirmed leaves nothing on the host', async () => {
    await keepOnHost(false);
    const config = testConfig();
    const received: Buffer[] = [];
    const service = new BackupService({
      // NEXA-BACKUP-DELIVERY: a resend's pause never really waits in a test.
      sleep: async () => {},
      runs: context.container.backupRuns,
      tools: new PostgresDatabaseTools({
        databaseUrl: config.DATABASE_URL,
        dumpTimeoutMs: 120_000,
        restoreTimeoutMs: 120_000,
        migratorEntrypoint: MIGRATOR,
      }),
      archiver: context.container.backupArchiver,
      workspaces: new FilesystemBackupWorkspaces(workRoot),
      delivery: {
        configured: true,
        async sendDocument(input) {
          const { readFile } = await import('node:fs/promises');
          received.push(await readFile(input.archivePath));
          return { state: 'SUCCEEDED', detail: null, messageId: 4242 };
        },
        async sendMessage() {
          return { state: 'SUCCEEDED', detail: null, messageId: 1 };
        },
      },
      clock: context.container.clock,
      ids: context.container.ids,
      installationId: () => 'integration-installation',
      opsLog: context.container.opsLog,
      quietOpsLog: context.container.opsLog,
      scope: () => tenantA,
      logger: { info() {}, warn() {}, error() {} },
      leaseOwner: `test:${randomBytes(4).toString('hex')}`,
      parts: { plan: (input) => planArchiveParts({ ...input, partBytes: BACKUP_PART_MAX_BYTES }) },
      restoreCommand: 'botctl restore --target <db> <archive>',
      // The container's own housekeeping, reading the stored setting.
      afterSuccess: async () => {
        await context.container.backupHousekeeping.pruneDeliveredCopies();
      },
    });
    const outcome = await service.run('MANUAL');
    if (outcome.kind !== 'COMPLETED') throw new Error('expected a completed run');
    expect({ state: outcome.run.state, failure: outcome.run.failureCode }).toEqual({
      state: 'SUCCEEDED',
      failure: null,
    });
    expect(outcome.run.deliveryState).toBe('SUCCEEDED');
    expect(received.length).toBeGreaterThan(0);
    // Right after the confirmed delivery: no archive file and no working directory.
    expect(await onDisk(outcome.run.id)).toBe(false);
    expect((await removalLines()).map((line) => line.backup_id)).toEqual([outcome.run.id]);
    // And the Web Admin says so: the archive is not downloadable from this host.
    const view = await context.container.backupAdmin.detail(
      tenantA as never,
      owner,
      outcome.run.id,
    );
    expect(view.archiveAvailable).toBe(false);
  }, 300_000);
});
