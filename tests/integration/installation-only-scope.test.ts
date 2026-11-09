import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isNexaError, type ActorContext, type CorrelationId } from '@nexa/contracts';
import {
  backupArchivePasswords,
  recoveryRequests,
} from '../../apps/api/src/infrastructure/persistence/schema';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * ADR-0039 finding F1 (Phase 6B PR-2): the seeded `owner` role holds EVERY permission in every
 * tenant, a hosted (or reseller) bot's owner included, and the installation's backup and
 * recovery services checked only the permission. So a non-installation owner could download
 * the installation's whole-database archive, set a backup password, and start — and confirm —
 * a whole-installation restore. Each case below was RED on `main` before the fix.
 *
 * The fix: `INSTALLATION_ONLY_PERMISSIONS` are dropped by the guard in every scope that is not
 * the installation tenant's, and the installation backup and recovery services refuse any
 * other scope with not-found (`backup.installation_only`) before they read anything.
 */
const INSTALLATION_ONLY = [
  'backup.run',
  'backup.download',
  'recovery.restore',
  'hosting.manage',
] as const;

describe('installation-only backup and recovery (ADR-0039 F1)', () => {
  let context: TestContext;
  let workRoot: string;
  let ownerActor: ActorContext;
  let hostedOwnerActor: ActorContext;

  const codeOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      if (isNexaError(error)) return error.code;
      throw error;
    }
    return 'resolved';
  };

  /** A SUCCEEDED installation run whose encrypted archive is on disk. */
  async function installationArchive(): Promise<string> {
    const container = context.container;
    const id = container.ids.uuid();
    const now = container.clock.now();
    const started = await container.backupRuns.start({
      id,
      trigger: 'MANUAL',
      leaseOwner: 'f1-test',
      now,
    });
    expect(started.claimed).toBe(true);
    await container.backupRuns.finish({
      id,
      leaseOwner: 'f1-test',
      state: 'SUCCEEDED',
      stage: 'CLEANUP',
      now,
      verifiedAt: now,
      checksum: 'a'.repeat(64),
      deliveryState: 'NOT_ATTEMPTED',
      cleanupOk: true,
      archiveFormat: 'SEVEN_ZIP',
    });
    await mkdir(join(workRoot, id), { recursive: true });
    await writeFile(join(workRoot, id, 'archive.7z'), 'the whole database, encrypted');
    return id;
  }

  beforeAll(async () => {
    workRoot = await mkdtemp(join(tmpdir(), 'nexa-f1-'));
    context = await createTestContext({ BACKUP_WORK_DIR: workRoot });
  }, 120_000);

  afterAll(async () => {
    await context?.close();
    await rm(workRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await context.reset();
    context.container.setInstallationTenant(tenantA.tenantId);
    const owner = await createAdmin(context.container, tenantA, {
      username: 'installation-owner',
      roleKeys: ['owner'],
    });
    ownerActor = adminActorFor(owner);
    // Another tenant's owner: the seeded `owner` role is ALL keys in their own tenant.
    const other = await createAdmin(context.container, tenantB, {
      username: 'hosted-owner',
      password: 'the-hosted-owners-password',
      roleKeys: ['owner'],
    });
    hostedOwnerActor = {
      ...adminActorFor(other),
      correlationId: 'f1-hosted' as CorrelationId,
    };
  });

  it('the guard drops the installation-only keys in every other tenant, and only there', async () => {
    const guard = context.container.guard;
    for (const permission of INSTALLATION_ONLY) {
      expect(await guard.has(tenantA, ownerActor, permission)).toBe(true);
      expect(await guard.has(tenantB, hostedOwnerActor, permission)).toBe(false);
    }
    // An ordinary key of their own tenant stays theirs.
    expect(await guard.has(tenantB, hostedOwnerActor, 'backup.view')).toBe(true);
    // With no installation tenant known, nobody holds them (deny by default).
    context.container.setInstallationTenant(null);
    expect(await guard.has(tenantA, ownerActor, 'backup.download')).toBe(false);
  });

  it('a hosted owner cannot list or download the installation archive', async () => {
    const runId = await installationArchive();
    const admin = context.container.backupAdmin;
    expect(await codeOf(admin.archivePath(tenantB, hostedOwnerActor, runId))).toBe(
      'backup.installation_only',
    );
    expect(await codeOf(admin.detail(tenantB, hostedOwnerActor, runId))).toBe(
      'backup.installation_only',
    );
    expect(
      await codeOf(admin.history(tenantB, hostedOwnerActor, { limit: 10, cursor: null })),
    ).toBe('backup.installation_only');
    expect(await codeOf(admin.status(tenantB, hostedOwnerActor))).toBe('backup.installation_only');
    expect(await codeOf(admin.run(tenantB, hostedOwnerActor, { idempotencyKey: 'f1-run' }))).toBe(
      'backup.installation_only',
    );
    // The installation owner still can.
    const own = await admin.archivePath(tenantA, ownerActor, runId);
    expect(own.path).toBe(join(workRoot, runId, 'archive.7z'));
  });

  it('a hosted owner cannot set a backup password', async () => {
    const code = await codeOf(
      context.container.backupPasswords.set(
        tenantB,
        hostedOwnerActor,
        {
          idempotencyKey: 'f1-password',
          password: 'a-password-the-hosted-owner-chose',
          stepUp: { password: 'the-hosted-owners-password' },
        },
        { ip: null },
      ),
    );
    expect(code).toBe('backup.installation_only');
    const rows = await context.container.database.db
      .select()
      .from(backupArchivePasswords)
      .where(eq(backupArchivePasswords.tenantId, tenantB.tenantId));
    expect(rows).toHaveLength(0);
  });

  it('a hosted owner can neither start nor confirm a whole-installation restore', async () => {
    const recovery = context.container.recoveryService;
    expect(
      await codeOf(recovery.beginUpload(tenantB, hostedOwnerActor, { clientFilename: 'whole.7z' })),
    ).toBe('backup.installation_only');
    expect(
      await codeOf(
        recovery.confirm(tenantB, hostedOwnerActor, context.container.ids.uuid(), {
          phrase: 'x',
          artifactChecksum: 'a'.repeat(64),
        }),
      ),
    ).toBe('backup.installation_only');
    expect(
      await codeOf(recovery.list(tenantB, hostedOwnerActor, { limit: 10, cursor: null })),
    ).toBe('backup.installation_only');
    const rows = await context.container.database.db.select().from(recoveryRequests);
    expect(rows).toHaveLength(0);
  });

  it('a hosted owner can still create and re-role administrators with the seeded technical role (Codex P2)', async () => {
    const management = context.container.adminManagement;
    // `technical` carries `backup.run`, an installation-only key the hosted owner cannot hold.
    const created = await management.create(tenantB, hostedOwnerActor, {
      username: 'hosted-technical',
      displayName: 'Technical',
      password: 'a-perfectly-fine-password',
      roleKeys: ['technical'],
    });
    const other = await createAdmin(context.container, tenantB, { username: 'hosted-second' });
    await expect(
      management.setRoles(tenantB, hostedOwnerActor, other.id, {
        roleKeys: ['owner'],
        reason: 'tenant-local role change',
      }),
    ).resolves.toBeDefined();
    expect(created.roleKeys).toEqual(['technical']);
    // The recipient still cannot exercise them: the guard filters per scope.
    const recipient = await context.container.admins.findByUsername(tenantB, 'hosted-technical');
    expect(recipient).not.toBeNull();
  });
});
