import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PLATFORM_ERROR_CODES } from '@nexa/contracts';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  testConfig,
  type TestContext,
} from './harness';
import { SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { PostgresDatabaseTools } from '../../apps/api/src/modules/platform/backup/infrastructure/pg-tools';
import {
  FilesystemBackupDebris,
  FilesystemBackupWorkspaces,
} from '../../apps/api/src/modules/platform/backup/infrastructure/workspace';
import { planArchiveParts } from '../../apps/api/src/modules/platform/backup/infrastructure/archive-parts';
import { BackupService } from '../../apps/api/src/modules/platform/backup/application/backup.service';
import { BackupHousekeeping } from '../../apps/api/src/modules/platform/backup/application/backup-housekeeping';
import type { DeliveryAttempt } from '../../apps/api/src/modules/platform/backup/application/ports';

/**
 * Round 4 PR-E (E4) against a real database, real `pg_dump`/`pg_restore` and the real
 * 7-Zip binary: the owner-set password, the 7-Zip archive, its parts, and the rule that a
 * local copy is removed only once EVERY part has a recorded Telegram message id.
 *
 * Only the Telegram transport is substituted; what it receives is asserted from the
 * archive on disk.
 */

const MIGRATOR = fileURLToPath(
  new URL('../../apps/api/src/infrastructure/persistence/migrate.ts', import.meta.url),
);
const OWNER_PASSWORD = 'the-owners-account-password';
const BACKUP_PASSWORD = 'a backup password the owner chose';

describe('backup parts, the 7-Zip archive and local-copy retention (E4)', () => {
  let context: TestContext;
  let workDir: string;
  let bodies: Buffer[];
  /** Outcomes per sendDocument call, in order; then SUCCEEDED with a message id. */
  let outcomes: DeliveryAttempt[];
  let messages: string[];

  beforeAll(async () => {
    context = await createTestContext();
  }, 60_000);

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
    context.container.setInstallationTenant(SEED_IDS.tenantA as never);
    workDir = await mkdtemp(join(tmpdir(), 'nexa-backup-parts-'));
    bodies = [];
    outcomes = [];
    messages = [];
    return async () => {
      await rm(workDir, { recursive: true, force: true });
    };
  });

  function service(partBytes: number): BackupService {
    const config = testConfig();
    let calls = 0;
    return new BackupService({
      runs: context.container.backupRuns,
      tools: new PostgresDatabaseTools({
        databaseUrl: config.DATABASE_URL,
        dumpTimeoutMs: 120_000,
        restoreTimeoutMs: 120_000,
        migratorEntrypoint: MIGRATOR,
      }),
      // The container's archiver: it reads the stored password for itself.
      archiver: context.container.backupArchiver,
      workspaces: new FilesystemBackupWorkspaces(workDir),
      delivery: {
        configured: true,
        async sendDocument(input) {
          const whole = await readFile(input.archivePath);
          bodies.push(
            input.range === undefined ? whole : whole.subarray(input.range.start, input.range.end),
          );
          calls += 1;
          return outcomes.shift() ?? { state: 'SUCCEEDED', detail: null, messageId: 1000 + calls };
        },
        async sendMessage(text) {
          messages.push(text);
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
      parts: { plan: (input) => planArchiveParts({ ...input, partBytes }) },
      restoreCommand: 'botctl restore --target <db> <parts>',
    });
  }

  async function setPassword(): Promise<void> {
    const owner = await createAdmin(context.container, tenantA, {
      username: 'backup-owner',
      password: OWNER_PASSWORD,
      roleKeys: ['owner'],
    });
    await context.container.backupPasswords.set(
      tenantA,
      adminActorFor(owner),
      {
        idempotencyKey: `set-${randomBytes(6).toString('hex')}`,
        password: BACKUP_PASSWORD,
        stepUp: { password: OWNER_PASSWORD },
      },
      { ip: null },
    );
  }

  async function completedRun(partBytes: number) {
    const outcome = await service(partBytes).run('MANUAL');
    if (outcome.kind !== 'COMPLETED') throw new Error('expected a completed run');
    return outcome.run;
  }

  it('with a password set, writes a 7-Zip archive that opens with that password alone', async () => {
    await setPassword();
    const status = await context.container.backupPasswords.status(tenantA);
    expect(status.configured).toBe(true);
    // The stored row holds ciphertext, never the password.
    const raw = await context.container.database.db.execute(
      `SELECT row_to_json(t)::text AS body FROM backup_archive_passwords t` as never,
    );
    expect(JSON.stringify(raw)).not.toContain(BACKUP_PASSWORD);

    const run = await completedRun(16 * 1024);
    expect(run.state).toBe('SUCCEEDED');
    expect(run.archiveFormat).toBe('SEVEN_ZIP');
    expect(run.archiveSealId).not.toBeNull();
    expect(run.partCount).toBeGreaterThan(1);
    const archivePath = join(workDir, run.id, 'archive.7z');
    const archive = await readFile(archivePath);
    // The first part is the start of a 7z; the parts concatenate to the verified archive.
    expect(bodies[0]?.subarray(0, 6)).toEqual(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]));
    expect(Buffer.concat(bodies)).toEqual(archive);
    // No keyring archive was written beside it.
    await expect(stat(join(workDir, run.id, 'archive.nxb'))).rejects.toThrow();
    // 7-Zip itself, with the password and nothing else, tests it clean.
    const tested = execFileSync('7z', ['t', archivePath], {
      input: `${BACKUP_PASSWORD}\n`,
      encoding: 'utf8',
    });
    expect(tested).toContain('Everything is Ok');
    // The summary names the owner's restore instruction.
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('فایل ‎.001 را با 7-Zip باز کنید');
  }, 240_000);

  it('refuses to set a password without the account-password step-up', async () => {
    const owner = await createAdmin(context.container, tenantA, {
      username: 'backup-owner-2',
      password: OWNER_PASSWORD,
      roleKeys: ['owner'],
    });
    await expect(
      context.container.backupPasswords.set(
        tenantA,
        adminActorFor(owner),
        {
          idempotencyKey: 'set-wrong-step-up',
          password: BACKUP_PASSWORD,
          stepUp: { password: 'not the account password' },
        },
        { ip: null },
      ),
    ).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_PASSWORD_REAUTHENTICATION_FAILED,
    });
    expect((await context.container.backupPasswords.status(tenantA)).configured).toBe(false);
  }, 60_000);

  // Review of #300: a retry of a committed request is answered before the step-up, whose
  // one-time proof (a TOTP step, a backup code) the first request already spent. A wrong
  // account password stands in for that spent proof here.
  it('replays a committed change without asking for the spent step-up again', async () => {
    const owner = await createAdmin(context.container, tenantA, {
      username: 'backup-owner-3',
      password: OWNER_PASSWORD,
      roleKeys: ['owner'],
    });
    const command = (stepUpPassword: string) => ({
      idempotencyKey: 'set-then-retry',
      password: BACKUP_PASSWORD,
      stepUp: { password: stepUpPassword },
    });
    const first = await context.container.backupPasswords.set(
      tenantA,
      adminActorFor(owner),
      command(OWNER_PASSWORD),
      { ip: null },
    );
    const retry = await context.container.backupPasswords.set(
      tenantA,
      adminActorFor(owner),
      command('a proof that is no longer valid'),
      { ip: null },
    );
    expect(retry).toEqual({ setAt: first.setAt, replayed: true });
    // A NEW key still needs the step-up.
    await expect(
      context.container.backupPasswords.set(
        tenantA,
        adminActorFor(owner),
        { ...command('a proof that is no longer valid'), idempotencyKey: 'a-new-change' },
        { ip: null },
      ),
    ).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_PASSWORD_REAUTHENTICATION_FAILED,
    });
  }, 60_000);

  it('refuses a holder without backup.download before any step-up', async () => {
    const operator = await createAdmin(context.container, tenantA, {
      username: 'backup-operator',
      password: OWNER_PASSWORD,
      roleKeys: ['operator'],
    });
    await expect(
      context.container.backupPasswords.set(
        tenantA,
        adminActorFor(operator),
        {
          idempotencyKey: 'set-no-permission',
          password: BACKUP_PASSWORD,
          stepUp: { password: OWNER_PASSWORD },
        },
        { ip: null },
      ),
    ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.PERMISSION_DENIED });
  }, 60_000);

  /*
   * THE RULE: a local copy goes only once EVERY part has a recorded Telegram message id.
   * Four runs: delivered in full, delivered in part (an unknown second part), "ok" with no
   * message id, and delivered in full again. With zero local copies kept, only the two
   * full deliveries lose their directory.
   */
  it('removes a local copy only after every part has a recorded message id', async () => {
    const full = await completedRun(16 * 1024);
    outcomes = [
      { state: 'SUCCEEDED', detail: null, messageId: 1 },
      { state: 'OUTCOME_UNKNOWN', detail: 'HTTP 502' },
    ];
    const partial = await completedRun(16 * 1024);
    outcomes = Array.from({ length: 50 }, () => ({
      state: 'SUCCEEDED' as const,
      detail: null,
      messageId: null,
    }));
    const noIds = await completedRun(16 * 1024);
    outcomes = [];
    const newest = await completedRun(16 * 1024);
    expect(partial.deliveryState).toBe('OUTCOME_UNKNOWN');
    expect(noIds.deliveryState).toBe('SUCCEEDED');

    const housekeeping = (keep: number) =>
      new BackupHousekeeping({
        runs: context.container.backupRuns,
        debris: new FilesystemBackupDebris(workDir),
        clock: context.container.clock,
        opsLog: context.container.opsLog,
        scope: () => tenantA,
        conditionOpen: async () => false,
        leftoverExists: async () => false,
        quiesced: async () => false,
        schedule: async () => ({ enabled: false, intervalMs: 86_400_000 }),
        // The other retention is out of the way: it keeps everything here.
        retention: async () => ({ keepCount: 1000, keepDays: 3650 }),
        localCopies: async () => keep,
        protectedByRecovery: async () => [],
        plaintextGraceMs: 86_400_000,
        diskFloorBytes: 0,
        tickIntervalMs: 60_000,
        initialDelayMs: 60_000,
        logger: { info() {}, warn() {}, error() {} },
      });

    const exists = async (id: string) =>
      stat(join(workDir, id)).then(
        () => true,
        () => false,
      );

    // Keep one: the newest full delivery stays, the older full one goes.
    expect(await housekeeping(1).pruneDeliveredCopies()).toBe(1);
    expect(await exists(full.id)).toBe(false);
    expect(await exists(newest.id)).toBe(true);
    // Keep none: the newest full delivery goes too — and NOTHING else, ever.
    expect(await housekeeping(0).pruneDeliveredCopies()).toBe(1);
    expect(await exists(newest.id)).toBe(false);
    expect(await exists(partial.id)).toBe(true);
    expect(await exists(noIds.id)).toBe(true);
    expect(await housekeeping(0).pruneDeliveredCopies()).toBe(0);

    const stamped = await context.container.backupRuns.byId(full.id);
    expect(stamped?.archivePrunedAt).not.toBeNull();
    const kept = await context.container.backupRuns.byId(partial.id);
    expect(kept?.archivePrunedAt).toBeNull();
  }, 300_000);

  it('a run an unfinished recovery names keeps its local copy', async () => {
    const run = await completedRun(16 * 1024);
    const candidates = await context.container.backupRuns.deliveredCopyPruneCandidates({
      keepDelivered: 0,
      protectedIds: [run.id],
      limit: 10,
    });
    expect(candidates).toEqual([]);
    const unprotected = await context.container.backupRuns.deliveredCopyPruneCandidates({
      keepDelivered: 0,
      protectedIds: [],
      limit: 10,
    });
    expect(unprotected.map((candidate) => candidate.id)).toEqual([run.id]);
  }, 180_000);
});
