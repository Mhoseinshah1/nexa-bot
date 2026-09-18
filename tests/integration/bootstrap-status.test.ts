import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLogs,
  adminRoles as adminRolesTable,
  admins as adminsTable,
} from '../../apps/api/src/infrastructure/persistence/schema';
import { provisionInstallation } from '../../apps/api/src/provision-installation.cli';
import { createTestContext, resetDatabase, testConfig, type TestContext } from './harness';
import { IDENTITY_ERROR_CODES, type CorrelationId, type TenantContext } from '@nexa/contracts';

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
    scope = { tenantId: tenant.tenantId as TenantContext['tenantId'], botInstanceId: null };
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const bootstrap = (telegramUserId = '800001') =>
    ctx.container.bootstrapOwner.execute(scope, {
      username: 'mamad',
      displayName: 'Mamad Owner',
      password: 'correcthorsebattery',
      telegramUserId,
    });

  const adminRows = () => ctx.container.database.db.select().from(adminsTable);
  const bootstrapAudits = () =>
    ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'admin.bootstrap'));

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

  // -------------------------------------------------------------------------
  // The owner is BOUND to a Telegram numeric id, or is not created at all.
  //
  // v0.2.5 staging: the owner was created with `telegram_user_id = NULL`, and
  // `/link` — the one command that binds an administrator — can only be sent
  // by an administrator who is already bound. The first Telegram administrator
  // of a fresh installation therefore needed a direct database UPDATE.
  // -------------------------------------------------------------------------

  it('creates the owner, the owner role, the Telegram binding and the bootstrap record together', async () => {
    const created = await bootstrap('123456789');
    expect(created.telegramUserId).toBe('123456789');

    const rows = await adminRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.telegramUserId).toBe('123456789');
    expect(rows[0]?.status).toBe('ACTIVE');
    const roles = await ctx.container.database.db
      .select()
      .from(adminRolesTable)
      .where(eq(adminRolesTable.adminId, rows[0]!.id));
    expect(roles).toHaveLength(1);

    // The binding is on the bootstrap's own audit row — the record the
    // installer reads back — so "who could reach the bot on day one" has an
    // answer in the ledger.
    const audits = await bootstrapAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.after).toMatchObject({
      username: 'mamad',
      roleKeys: ['owner'],
      telegramUserId: '123456789',
    });

    // And the binding is live: the Telegram resolver names the owner, with
    // the owner's permissions — the receipt reviewers among them — so the
    // admin menu and receipt notices reach this account without a restart.
    const identity = await ctx.container.telegramAdmins.resolve(
      scope,
      '123456789',
      'bootstrap-binding' as CorrelationId,
    );
    expect(identity?.admin.username).toBe('mamad');
    expect(identity?.permissions.has('receipts.review')).toBe(true);
    const reviewers = await ctx.container.telegramAdmins.reviewers(
      scope,
      'receipts.review',
      'bootstrap-binding' as CorrelationId,
    );
    expect(reviewers.map((one) => one.admin.telegramUserId)).toEqual(['123456789']);
  });

  it('refuses a Telegram id that is not a numeric id, and creates nothing', async () => {
    for (const bad of ['mamad', '@mamad', '-5', '12 34', '0123', '', '1'.repeat(20)]) {
      await expect(bootstrap(bad), `"${bad}" was accepted`).rejects.toThrow();
    }
    expect(await adminRows()).toHaveLength(0);
    expect(await bootstrapAudits()).toHaveLength(0);
    expect(await ctx.container.bootstrapOwner.status(scope)).toBe('none');
  });

  it('creates none of it when any part of it fails', async () => {
    // A fault injected AFTER the owner row is written and BEFORE the role,
    // the audit row and the outbox event: exactly the interruption that would
    // leave a half-made owner if the parts were committed one at a time. The
    // service holds the same repository instance the container exposes.
    const failing = vi
      .spyOn(ctx.container.roles, 'setAdminRoles')
      .mockRejectedValueOnce(new Error('injected: the role assignment failed'));
    try {
      await expect(bootstrap('123456789')).rejects.toThrow('injected');
    } finally {
      failing.mockRestore();
    }

    expect(await adminRows(), 'the owner row survived a failed bootstrap').toHaveLength(0);
    expect(await bootstrapAudits(), 'the bootstrap was recorded without an owner').toHaveLength(0);
    expect(await ctx.container.bootstrapOwner.status(scope)).toBe('none');

    // And the installer's rerun then creates the complete owner, atomically.
    const created = await bootstrap('123456789');
    expect(created.telegramUserId).toBe('123456789');
    expect(await ctx.container.bootstrapOwner.status(scope)).toBe('bootstrapped');
  });

  it('never rebinds or duplicates the owner on a rerun', async () => {
    await bootstrap('123456789');
    // The rerun with a DIFFERENT id: refused by the fence, and the binding the
    // first run wrote is exactly what it was.
    await expect(bootstrap('987654321')).rejects.toMatchObject({
      code: IDENTITY_ERROR_CODES.BOOTSTRAP_ALREADY_DONE,
    });
    const rows = await adminRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.telegramUserId).toBe('123456789');
    expect(await bootstrapAudits()).toHaveLength(1);
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
