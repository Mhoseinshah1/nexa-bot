import { copyFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isNexaError,
  type ActorContext,
  type CorrelationId,
  type TenantContext,
} from '@nexa/contracts';
import type { ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  admins,
  auditLogs,
  backupRuns,
  heavyJobTickets,
  hostedBotBackupPolicies,
  tenantRestores,
} from '../../apps/api/src/infrastructure/persistence/schema';
import {
  totpForStep,
  totpStepAt,
} from '../../apps/api/src/modules/platform/identity/application/totp';
import {
  adminActorFor,
  createAdmin,
  createApiApp,
  migrateOnce,
  resetDatabase,
  tenantA,
  testConfig,
  type SeededAdmin,
} from './harness';

const OWNER_PASSWORD = 'the-owners-own-password';
const ARCHIVE_PASSWORD = 'a hosted archive password';

/**
 * Phase 6B PR-2 (ADR-0039 § 7) against the real app, a real database and real 7-Zip: the
 * owner's per-bot password and schedule behind a fresh code, the hosted owner reaching none of
 * it, a requested archive taken by the WORKER's pass through the heavy-job queue (never the
 * request), its download, the bot's own retention, the owner's installation history never
 * listing it, and «بازیابی ربات از فایل» refusing — and removing — an archive of a bot that is
 * already here. The app connects as `nexa_app` (row-level security on).
 */
describe('hosted-bot backups (phase 6B PR-2)', () => {
  let api: ApiApp;
  let workRoot: string;
  let recoveryRoot: string;
  let offsetMs = 0;
  let baseMs = 0;
  let keys = 0;
  let owner: SeededAdmin;
  let ownerActor: ActorContext;
  let panel: { secret: string; token: string };

  const key = () => `hosted-backup-key-${String((keys += 1))}`;
  const now = () => api.container.clock.now();
  const code = (secret: string) => {
    offsetMs += 30_000;
    return totpForStep(secret, totpStepAt(now()));
  };
  const proof = () => ({ code: code(panel.secret) });
  const codeOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      if (isNexaError(error)) return error.code;
      throw error;
    }
    return 'resolved';
  };

  async function signIn(admin: SeededAdmin): Promise<ActorContext> {
    const result = await api.container.auth.login(
      tenantA,
      { type: 'API', id: null, label: null, surface: 'WEB', correlationId: 'c' as CorrelationId },
      { username: admin.username, password: admin.password },
      { ip: null, userAgent: null },
    );
    return { ...adminActorFor(admin), sessionId: result.session.id };
  }

  async function openPanel(): Promise<{ secret: string; token: string }> {
    const enrolment = await api.container.hostingSection.enrol(
      tenantA,
      ownerActor,
      { password: OWNER_PASSWORD },
      { ip: null },
    );
    const activated = await api.container.hostingSection.activate(tenantA, ownerActor, {
      code: code(enrolment.secret),
    });
    return { secret: enrolment.secret, token: activated.opened.token };
  }

  async function createBot(slug: string): Promise<{ id: string; scope: TenantContext }> {
    const created = await api.container.hosting.create(tenantA, ownerActor, panel.token, {
      idempotencyKey: key(),
      proof: proof(),
      slug,
      displayName: `Bot ${slug}`,
      adminUsername: `${slug}-admin`,
      adminDisplayName: 'Hosted owner',
      adminPassword: 'the-hosted-owners-password',
      expiresAt: null,
    });
    const id = created.bot.tenantId;
    return { id, scope: { tenantId: id as never, botInstanceId: null } };
  }

  async function hostedOwnerOf(hostedTenantId: string): Promise<ActorContext> {
    const [row] = await api.container.database.db
      .select({ id: admins.id, username: admins.username })
      .from(admins)
      .where(eq(admins.tenantId, hostedTenantId));
    if (row === undefined) throw new Error('no hosted owner');
    return {
      type: 'WEB_ADMIN',
      id: row.id,
      label: row.username,
      surface: 'WEB',
      correlationId: 'hosted-owner' as CorrelationId,
    };
  }

  beforeAll(async () => {
    workRoot = await mkdtemp(join(tmpdir(), 'nexa-hosted-backups-'));
    recoveryRoot = await mkdtemp(join(tmpdir(), 'nexa-hosted-restores-'));
    const config = testConfig({
      WEB_ADMIN_ORIGINS: 'https://admin.hosting.test',
      HOSTED_BOTS_CREATE_ENABLED: 'true',
      BACKUP_WORK_DIR: workRoot,
      RECOVERY_WORK_DIR: recoveryRoot,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
    const clock = api.container.clock as { now: () => Date };
    baseMs = Math.floor(Date.now() / 30_000) * 30_000 + 10_000;
    clock.now = () => new Date(baseMs + offsetMs);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await rm(workRoot, { recursive: true, force: true });
    await rm(recoveryRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    offsetMs = 0;
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    owner = await createAdmin(api.container, tenantA, {
      username: 'backup-owner',
      password: OWNER_PASSWORD,
      roleKeys: ['owner'],
    });
    ownerActor = await signIn(owner);
    panel = await openPanel();
  });

  it('the owner sets the password and the schedule with a fresh code; the hosted owner reaches neither', async () => {
    const bot = await createBot('backup-one');
    const backups = api.container.hostedBackups;
    const initial = await backups.view(tenantA, ownerActor, panel.token, bot.id);
    expect(initial.policy).toEqual({
      enabled: true,
      dailyTime: '04:30',
      keep: 7,
      passwordSetAt: null,
      runRequestedAt: null,
    });
    // No password: «بکاپ الان» is refused, and nothing is recorded.
    expect(
      await codeOf(
        backups.requestRun(tenantA, ownerActor, panel.token, bot.id, {
          idempotencyKey: key(),
          proof: proof(),
        }),
      ),
    ).toBe('hosting.backup_password_required');
    // A wrong code changes nothing.
    expect(
      await codeOf(
        backups.setPassword(tenantA, ownerActor, panel.token, bot.id, {
          idempotencyKey: key(),
          proof: { code: '000000' },
          password: ARCHIVE_PASSWORD,
        }),
      ),
    ).toBe('hosting.code_rejected');
    const set = await backups.setPassword(tenantA, ownerActor, panel.token, bot.id, {
      idempotencyKey: key(),
      proof: proof(),
      password: ARCHIVE_PASSWORD,
    });
    expect(set.policy.passwordSetAt).not.toBeNull();
    const scheduled = await backups.setSchedule(tenantA, ownerActor, panel.token, bot.id, {
      idempotencyKey: key(),
      proof: proof(),
      enabled: false,
      dailyTime: '03:15',
      keep: 2,
    });
    expect(scheduled.policy).toMatchObject({ enabled: false, dailyTime: '03:15', keep: 2 });

    // Stored in the INSTALLATION tenant, sealed: never the password itself.
    const [policy] = await api.container.database.db
      .select()
      .from(hostedBotBackupPolicies)
      .where(eq(hostedBotBackupPolicies.hostedTenantId, bot.id));
    expect(policy?.tenantId).toBe(tenantA.tenantId);
    expect(policy?.passwordCiphertext).not.toContain(ARCHIVE_PASSWORD);
    // Audited in the owner's log, and nothing in the hosted tenant's.
    const hostedAudit = await api.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, bot.id));
    expect(hostedAudit.filter((row) => row.action.startsWith('hosting.backup'))).toEqual([]);
    const ownerAudit = await api.container.database.db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.tenantId, tenantA.tenantId), eq(auditLogs.entityId, bot.id)));
    expect(ownerAudit.map((row) => row.action)).toEqual(
      expect.arrayContaining(['hosting.backup_password_set', 'hosting.backup_schedule_set']),
    );

    // The hosted bot's own owner — every key in his own tenant — reaches none of it.
    const hosted = await hostedOwnerOf(bot.id);
    // Thunks: each refusal is awaited as it is made (no rejection left unobserved).
    for (const attempt of [
      () => backups.view(bot.scope, hosted, null, bot.id),
      () =>
        backups.setPassword(bot.scope, hosted, null, bot.id, {
          idempotencyKey: key(),
          proof: { code: '123456' },
          password: 'the hosted owner chose this',
        }),
      () =>
        backups.download(bot.scope, hosted, null, bot.id, api.container.ids.uuid(), {
          proof: { code: '123456' },
        }),
    ]) {
      expect(await codeOf(attempt())).toBe('hosting.owner_only');
    }
    expect(
      await codeOf(
        api.container.backupPasswords.set(
          bot.scope,
          hosted,
          {
            idempotencyKey: key(),
            password: 'the hosted owner chose this',
            stepUp: { password: 'the-hosted-owners-password' },
          },
          { ip: null },
        ),
      ),
    ).toBe('backup.installation_only');
    expect(await codeOf(api.container.backupAdmin.status(bot.scope, hosted))).toBe(
      'backup.installation_only',
    );
    // His own page: managed by the host, the host's switch, no archive yet.
    expect(await backups.ownView(bot.scope, hosted)).toEqual({
      managedByHost: true,
      enabled: false,
      lastBackupAt: null,
    });
    expect(await codeOf(backups.ownView(tenantA, ownerActor))).toBe('platform.tenant_not_found');
  }, 120_000);

  it('a requested archive is taken by the worker pass through the queue, kept N, downloaded with a code; the owner history never lists it', async () => {
    const bot = await createBot('backup-two');
    const backups = api.container.hostedBackups;
    await backups.setPassword(tenantA, ownerActor, panel.token, bot.id, {
      idempotencyKey: key(),
      proof: proof(),
      password: ARCHIVE_PASSWORD,
    });
    await backups.setSchedule(tenantA, ownerActor, panel.token, bot.id, {
      idempotencyKey: key(),
      proof: proof(),
      enabled: false,
      dailyTime: '04:30',
      keep: 1,
    });
    // The schedule is off and nothing was requested: the pass takes nothing.
    expect((await backups.runDue()).ran).toEqual([]);

    const archiveRuns = async () =>
      api.container.database.db
        .select()
        .from(backupRuns)
        .where(eq(backupRuns.subjectTenantId, bot.id));

    const takeOne = async () => {
      const requested = await backups.requestRun(tenantA, ownerActor, panel.token, bot.id, {
        idempotencyKey: key(),
        proof: proof(),
      });
      expect(requested.policy.runRequestedAt).not.toBeNull();
      // The request takes nothing itself: the archive is the worker's.
      expect((await archiveRuns()).filter((run) => run.finishedAt === null)).toEqual([]);
      const pass = await backups.runDue();
      expect(pass).toMatchObject({ ran: [bot.id], failed: [], deferred: false });
      offsetMs += 60_000;
    };
    await takeOne();
    const [first] = await archiveRuns();
    expect(first).toMatchObject({
      archiveScope: 'TENANT',
      state: 'SUCCEEDED',
      trigger: 'MANUAL',
      // No hosted group: kept on this server, never the owner's topic.
      deliveryState: 'NOT_ATTEMPTED',
    });
    expect(first?.verifiedAt).not.toBeNull();
    // Through the heavy-job queue, as the hosted tenant's BACKUP ticket.
    const tickets = await api.container.database.db
      .select()
      .from(heavyJobTickets)
      .where(eq(heavyJobTickets.tenantId, bot.id));
    expect(tickets.map((ticket) => ticket.kind)).toContain('BACKUP');
    const firstFile = join(workRoot, 'hosted', bot.id, first!.id, 'archive.7z');
    expect((await stat(firstFile)).isFile()).toBe(true);
    // Done: the request is cleared, and a second pass takes nothing.
    expect(
      (await backups.view(tenantA, ownerActor, panel.token, bot.id)).policy.runRequestedAt,
    ).toBe(null);
    expect((await backups.runDue()).ran).toEqual([]);

    // The owner's installation history and detail never show a hosted archive.
    const history = await api.container.backupAdmin.history(tenantA, ownerActor, {
      limit: 50,
      cursor: null,
    });
    expect(history.runs.map((view) => view.run.id)).not.toContain(first!.id);
    expect(await codeOf(api.container.backupAdmin.detail(tenantA, ownerActor, first!.id))).toBe(
      'backup.run_missing',
    );

    // The download: a fresh code, the derived path, audited in the owner's log.
    const download = await backups.download(tenantA, ownerActor, panel.token, bot.id, first!.id, {
      proof: proof(),
    });
    expect(download.path).toBe(firstFile);
    expect(download.filename).toBe(`nexa-hosted-${bot.id}-${first!.id}.7z`);
    // Keep 1: the second archive retires the first, never the newest.
    await takeOne();
    const runs = (await archiveRuns()).sort(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
    );
    expect(runs).toHaveLength(2);
    expect(runs[0]?.archivePrunedAt).not.toBeNull();
    expect(runs[1]?.archivePrunedAt).toBeNull();
    await expect(stat(firstFile)).rejects.toThrow();
    const view = await backups.view(tenantA, ownerActor, panel.token, bot.id);
    expect(view.archives.map((archive) => [archive.id, archive.available])).toEqual([
      [runs[1]!.id, true],
      [runs[0]!.id, false],
    ]);
    expect(
      await codeOf(
        backups.download(tenantA, ownerActor, panel.token, bot.id, first!.id, { proof: proof() }),
      ),
    ).toBe('hosting.archive_not_found');
    // The hosted owner's page now shows the last backup's time.
    const hosted = await hostedOwnerOf(bot.id);
    expect((await backups.ownView(bot.scope, hosted)).lastBackupAt).toBe(
      runs[1]!.verifiedAt!.toISOString(),
    );

    // «بازیابی ربات از فایل» of an archive whose bot is already here: refused in the dry run,
    // its upload removed at once (A3), the row FAILED, nothing written.
    const restoreAdmin = api.container.tenantRestoreAdmin;
    const upload = await restoreAdmin.beginUpload(tenantA, ownerActor, panel.token);
    await copyFile(join(workRoot, 'hosted', bot.id, runs[1]!.id, 'archive.7z'), upload.archivePath);
    expect(
      await codeOf(
        restoreAdmin.dryRun(tenantA, ownerActor, panel.token, upload.restoreId, {
          proof: proof(),
          password: ARCHIVE_PASSWORD,
        }),
      ),
    ).toBe('tenant_archive.tenant_exists');
    expect(await readdir(join(recoveryRoot, 'tenant-restores'))).toEqual([]);
    const [restore] = await api.container.database.db
      .select()
      .from(tenantRestores)
      .where(eq(tenantRestores.id, upload.restoreId));
    expect(restore).toMatchObject({ state: 'FAILED', failureCode: 'tenant_archive.tenant_exists' });
  }, 600_000);
});
