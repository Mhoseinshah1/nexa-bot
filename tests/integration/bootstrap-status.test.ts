import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLogs,
  admins as adminsTable,
} from '../../apps/api/src/infrastructure/persistence/schema';
import { provisionInstallation } from '../../apps/api/src/provision-installation.cli';
import { createTestContext, resetDatabase, testConfig, type TestContext } from './harness';
import type { TenantContext } from '@nexa/contracts';

/**
 * Telling apart the three states an installer can find a database in.
 *
 * A real Ubuntu 24.04 install was interrupted between the owner being committed
 * and the release manifest being written. Everything was healthy; `botctl
 * version` said "no current release is recorded"; and the documented remedy — a
 * rerun — died at the bootstrap step with BOOTSTRAP_ALREADY_DONE, because
 * that fence cannot tell "I already did this" from "somebody else did".
 *
 * The fence is right and stays exactly as it was. What was missing was a
 * READ that answers the different question, and the evidence it reads is the
 * audit row `BootstrapOwnerService` writes in the SAME transaction as the
 * owner. That matters: a marker file the installer wrote after the CLI returned
 * would have been absent in precisely the interruption it exists to recognise.
 */
describe('bootstrap status', () => {
  let ctx: TestContext;
  const config = testConfig();
  let scope: TenantContext;

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await resetDatabase(ctx.container.database.db);
    const tenant = await provisionInstallation(config.DATABASE_URL, {
      slug: 'nexa',
      displayName: 'Nexa',
      locale: 'fa',
      timezone: 'Asia/Tehran',
      calendar: 'jalali',
      currency: 'IRT',
    });
    scope = { tenantId: tenant.tenantId, botInstanceId: null };
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const bootstrap = () =>
    ctx.container.bootstrapOwner.execute(scope, {
      username: 'mamad',
      displayName: 'Mamad Owner',
      password: 'correcthorsebattery',
    });

  it('is `none` on a freshly provisioned installation', async () => {
    expect(await ctx.container.bootstrapOwner.status(scope)).toBe('none');
  });

  it('is `bootstrapped` once this installation has created its owner', async () => {
    await bootstrap();
    expect(await ctx.container.bootstrapOwner.status(scope)).toBe('bootstrapped');
  });

  it('does not weaken the fence it exists beside', async () => {
    await bootstrap();
    // `status` says the installer may carry on. `execute` still refuses, and
    // that is the point: only the INSTALLER's next step changes, never who may
    // create an administrator.
    await expect(bootstrap()).rejects.toMatchObject({ code: 'bootstrap.already_completed' });
    expect(await ctx.container.database.db.select().from(adminsTable)).toHaveLength(1);
  });

  it('is `foreign` when administrators exist that this bootstrap did not create', async () => {
    await bootstrap();
    // The administrator stays; only the proof that BOOTSTRAP created them is
    // removed. `audit_logs` refuses DELETE, so this is done the only way it can
    // be — which is itself the reason the evidence is trustworthy in
    // production. Dropped to the raw connection deliberately.
    await ctx.container.database.db.execute(
      `ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_delete` as never,
    );
    await ctx.container.database.db
      .delete(auditLogs)
      .where(eq(auditLogs.action, 'admin.bootstrap'));
    await ctx.container.database.db.execute(
      `ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_delete` as never,
    );

    expect(await ctx.container.database.db.select().from(adminsTable)).toHaveLength(1);
    expect(
      await ctx.container.bootstrapOwner.status(scope),
      'an administered database with no record of this bootstrap was reported as our own',
    ).toBe('foreign');
  });
});
