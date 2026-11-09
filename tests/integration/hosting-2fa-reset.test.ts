import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  HOSTING_ERROR_CODES,
  IDENTITY_ERROR_CODES,
  isNexaError,
  type ActorContext,
  type CorrelationId,
} from '@nexa/contracts';
import type { ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  auditLogs,
  hostingRecoveryCodes,
  hostingSessions,
  hostingTotpFactors,
} from '../../apps/api/src/infrastructure/persistence/schema';
import {
  totpForStep,
  totpStepAt,
} from '../../apps/api/src/modules/platform/identity/application/totp';
import { ServerHostingFactorRecovery } from '../../apps/api/src/modules/platform/hosting/application/server-hosting-factor-recovery';
import { DrizzleHostingRepository } from '../../apps/api/src/modules/platform/hosting/infrastructure/drizzle-hosting.repository';
import {
  parseHostingResetArgs,
  HostingResetArgsError,
} from '../../apps/api/src/admin-hosting-2fa-reset.cli';
import {
  createAdmin,
  createApiApp,
  migrateOnce,
  resetDatabase,
  tenantA,
  tenantB,
  testConfig,
  type SeededAdmin,
} from './harness';

const OWNER_PASSWORD = 'the-owners-own-password';

/**
 * PR-6 (Phase 6B): `botctl admin reset-hosting-2fa` — the owner's way back when the
 * «میزبانی‌ها» section's own factor and recovery codes are both lost. The service is the
 * whole behaviour; the CLI only parses arguments and builds it (the same split as
 * `admin:2fa-reset`).
 */
describe('hosting section factor recovery (server CLI service)', () => {
  let api: ApiApp;
  let owner: SeededAdmin;
  let ownerActor: ActorContext;
  let recovery: ServerHostingFactorRecovery;
  // The clock is frozen, mid-step, so a code is always for the step it was made in.
  let clockMs = 0;

  const code = (secret: string) => {
    clockMs += 30_000;
    return totpForStep(secret, totpStepAt(api.container.clock.now()));
  };

  async function signIn(admin: SeededAdmin, scope = tenantA) {
    const result = await api.container.auth.login(
      scope,
      { type: 'API', id: null, label: null, surface: 'WEB', correlationId: 'c' as CorrelationId },
      { username: admin.username, password: admin.password },
      { ip: null, userAgent: null },
    );
    return {
      type: 'WEB_ADMIN',
      id: admin.id,
      label: admin.username,
      surface: 'WEB',
      correlationId: 'test-correlation' as CorrelationId,
      sessionId: result.session.id,
    } as ActorContext;
  }

  async function openPanel() {
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

  const reset = (username: string, reason = 'lost phone, identity checked in person') =>
    recovery.resetFromServer(tenantA, { username, reason });
  const db = () => api.container.database.db;
  const codeOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (isNexaError(error)) return error.code;
      throw error;
    }
    throw new Error('expected a refusal');
  };

  beforeAll(async () => {
    const config = testConfig();
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
    const clock = api.container.clock as { now: () => Date };
    const base = Math.floor(Date.now() / 30_000) * 30_000 + 10_000;
    clock.now = () => new Date(base + clockMs);
    recovery = new ServerHostingFactorRecovery({
      uow: api.container.uow,
      repository: new DrizzleHostingRepository(api.container.database.db),
      admins: api.container.admins,
      audit: api.container.audit,
      clock: api.container.clock,
      ids: api.container.ids,
    });
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    clockMs = 0;
    await resetDatabase(db());
    await seed(db(), api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    owner = await createAdmin(api.container, tenantA, {
      username: 'panel-owner',
      password: OWNER_PASSWORD,
      roleKeys: ['owner'],
    });
    ownerActor = await signIn(owner);
  });

  it('removes the factor, the recovery codes and the section sessions, audits it, and lets the owner enrol again', async () => {
    const panel = await openPanel();
    expect(await db().select().from(hostingTotpFactors)).toHaveLength(1);
    expect((await db().select().from(hostingRecoveryCodes)).length).toBeGreaterThan(0);

    const result = await reset(' Panel-Owner ');
    expect(result).toMatchObject({ hadFactor: true, endedSectionSessions: 1 });
    expect(result.recoveryCodesRemoved).toBeGreaterThan(0);

    expect(await db().select().from(hostingTotpFactors)).toHaveLength(0);
    expect(await db().select().from(hostingRecoveryCodes)).toHaveLength(0);
    const sessions = await db().select().from(hostingSessions);
    expect(sessions.every((row) => row.revokedAt !== null)).toBe(true);
    // The old section token no longer opens anything.
    expect(await codeOf(api.container.hosting.list(tenantA, ownerActor, panel.token))).toBe(
      HOSTING_ERROR_CODES.SECTION_SESSION_REQUIRED,
    );
    // The Web Admin session is untouched: the status card still answers.
    expect((await api.container.hostingSection.status(tenantA, ownerActor, null)).factor).toBe(
      'NONE',
    );

    const rows = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'hosting.totp_reset'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: tenantA.tenantId,
      entityId: owner.id,
      actorType: 'SYSTEM_JOB',
      result: 'SUCCESS',
      reason: 'lost phone, identity checked in person',
    });
    expect(rows[0]!.after).toMatchObject({ via: 'SERVER_CLI', state: 'NONE' });
    // Never in another tenant's log.
    expect(
      await db()
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.action, 'hosting.totp_reset'), eq(auditLogs.tenantId, tenantB.tenantId)),
        ),
    ).toHaveLength(0);

    // A fresh enrolment works.
    const again = await openPanel();
    expect(again.secret).not.toBe(panel.secret);
  });

  it('also clears a pending enrolment, and a repeat with no factor is recorded as a no-op', async () => {
    await api.container.hostingSection.enrol(
      tenantA,
      ownerActor,
      { password: OWNER_PASSWORD },
      { ip: null },
    );
    expect(await reset('panel-owner')).toMatchObject({ hadFactor: true });
    expect(await reset('panel-owner')).toMatchObject({ hadFactor: false, recoveryCodesRemoved: 0 });
    expect(
      await db().select().from(auditLogs).where(eq(auditLogs.action, 'hosting.totp_reset')),
    ).toHaveLength(2);
  });

  it('refuses an unknown administrator, a non-owner and a missing reason, changing nothing', async () => {
    const operator = await createAdmin(api.container, tenantA, {
      username: 'panel-operator',
      roleKeys: ['operator'],
    });
    await openPanel();
    expect(await codeOf(reset('nobody'))).toBe(IDENTITY_ERROR_CODES.ADMIN_NOT_FOUND);
    expect(await codeOf(reset(operator.username))).toBe(HOSTING_ERROR_CODES.OWNER_ONLY);
    await expect(reset('panel-owner', '  ')).rejects.toThrow();
    expect(await db().select().from(hostingTotpFactors)).toHaveLength(1);
    expect(
      await db().select().from(auditLogs).where(eq(auditLogs.action, 'hosting.totp_reset')),
    ).toHaveLength(0);
  });

  it('parses its arguments strictly', () => {
    expect(parseHostingResetArgs(['--username', 'o', '--reason', 'lost'])).toEqual({
      username: 'o',
      reason: 'lost',
    });
    for (const argv of [
      [],
      ['--username', 'o'],
      ['--username', 'o', '--reason', ' '],
      ['--username', 'o', '--reason', 'x', '--tenant', 'hosted'],
      ['--username', '--reason', 'x'],
    ]) {
      expect(() => parseHostingResetArgs(argv)).toThrow(HostingResetArgsError);
    }
  });
});
