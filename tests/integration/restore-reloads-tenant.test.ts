import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ActorContext, CorrelationId } from '@nexa/contracts';
import { createContainer, type Container } from '../../apps/api/src/container';
import { runMigrations } from '../../apps/api/src/infrastructure/persistence/migrate';
import { tenants, recoveryRequests } from '../../apps/api/src/infrastructure/persistence/schema';
import { FileCutoverJournal } from '../../apps/api/src/modules/platform/recovery/infrastructure/cutover-journal';
import { isTenantForeignKeyViolation } from '../../apps/api/src/infrastructure/lifecycle/installation-tenant-guard';
import { createAdmin, testConfig } from './harness';

/**
 * A backup from install A restored on install B: the restored database has A's tenant, and
 * every role still holds B's, cached at startup. The real server showed the Web Admin login
 * answering "wrong password" (the login throttle insert violated the tenant foreign key)
 * and the recovery role looping on failed `recovery_requests` inserts until restarted.
 *
 * Simulated by swapping the PRIMARY tenant row under a running container: the cached id
 * is gone and another primary exists, which is what the cutover leaves behind.
 *
 * Own database, own prefix; dropped at the end.
 */
const OLD = '01a1ad67-0000-7000-8000-000000000001';
const NEW = '01a1af9d-0000-7000-8000-000000000002';

const from = { ip: '203.0.113.10', userAgent: 'vitest' };
const anonymous: ActorContext = {
  type: 'API',
  id: null,
  label: null,
  surface: 'WEB',
  correlationId: 'test-correlation' as CorrelationId,
};

describe('a restore that brings a different tenant', () => {
  const dbName = `nexa_tenantguard_${randomBytes(6).toString('hex')}`;
  let container: Container;
  let recoveryRoot: string;

  const maintenance = async (sql: string): Promise<void> => {
    const url = new URL(testConfig().DATABASE_URL);
    url.pathname = '/postgres';
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };

  const tenantRow = (id: string) => ({
    id,
    kind: 'PRIMARY' as const,
    parentTenantId: null,
    slug: `slug-${id.slice(0, 8)}`,
    displayName: 'Store',
    status: 'ACTIVE' as const,
    locale: 'fa',
    displayTimezone: 'Asia/Tehran',
    calendar: 'jalali' as const,
    currency: 'IRT' as const,
  });

  beforeAll(async () => {
    await maintenance(`CREATE DATABASE "${dbName}"`);
    const url = new URL(testConfig().DATABASE_URL);
    url.pathname = `/${dbName}`;
    await runMigrations(url.toString());
    recoveryRoot = await mkdtemp(join(tmpdir(), 'nexa-tenantguard-'));
    container = createContainer(
      testConfig({ DATABASE_URL: url.toString(), RECOVERY_WORK_DIR: recoveryRoot }),
      'recovery',
    );
    await container.database.db.insert(tenants).values(tenantRow(OLD));
    container.setInstallationTenant(OLD as never);
  });

  afterAll(async () => {
    await container.shutdown().catch(() => undefined);
    await container.database.close().catch(() => undefined);
    await rm(recoveryRoot, { recursive: true, force: true });
    await maintenance(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  it('login fails on the stale tenant, then works once the guard re-resolved it', async () => {
    // The restore: the database now holds the OTHER installation's tenant and its admins.
    await container.database.db.delete(tenants).where(eq(tenants.id, OLD));
    await container.database.db.insert(tenants).values(tenantRow(NEW));
    const newScope = { tenantId: NEW as never, botInstanceId: null };
    const admin = await createAdmin(container, newScope, { username: 'restored-owner' });

    const attempt = () =>
      container.auth.signIn(
        { tenantId: container.installationTenantId as never, botInstanceId: null },
        anonymous,
        { username: admin.username, password: admin.password },
        from,
      );

    // The bug, reproduced: the cached tenant names nothing and the write is refused.
    const failure = await attempt().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure, 'login on a stale tenant should fail on the tenant foreign key').not.toBeNull();
    expect(isTenantForeignKeyViolation(failure)).toBe(true);

    // What the web error filter does with that failure; the guard never retries it itself.
    container.installationTenantGuard.onWriteError(failure);
    await container.installationTenantGuard.verify();
    expect(container.installationTenantId).toBe(NEW);

    const outcome = await attempt();
    expect(outcome.kind).not.toBe('FAILED');
    expect(outcome.kind === 'SIGNED_IN' || outcome.kind === 'SECOND_FACTOR_REQUIRED').toBe(true);
  });

  it('the recovery role records a completed cutover once, under the live tenant, without a loop', async () => {
    // Back to the stale state: the process still holds a tenant that is gone.
    container.setInstallationTenant(OLD as never);
    const reassert = vi.spyOn(container.recoveryRequests, 'reassert');
    const recoveryId = '0192f000-0000-7000-8000-00000000f001';
    await new FileCutoverJournal(recoveryRoot).write({
      recoveryId,
      phase: 'RENAMED',
      liveDatabase: dbName,
      candidateDatabase: 'nexa_candidate_x',
      displacedDatabase: 'nexa_pre_restore_x',
      at: new Date(),
    });

    for (let tick = 0; tick < 3; tick += 1) await container.recoveryExecutor.tick();

    expect(container.installationTenantId).toBe(NEW);
    const rows = await container.database.db
      .select({ tenantId: recoveryRequests.tenantId, state: recoveryRequests.state })
      .from(recoveryRequests)
      .where(eq(recoveryRequests.id, recoveryId));
    expect(rows).toEqual([{ tenantId: NEW, state: 'FAILED' }]);
    // Written once; the journal was cleared, so later ticks do not touch it again. A loop
    // would show here as one failing insert per tick.
    expect(reassert).toHaveBeenCalledTimes(1);
    expect(container.recoveryExecutor.isFresh(container.clock.now().getTime())).toBe(true);
  });
});
