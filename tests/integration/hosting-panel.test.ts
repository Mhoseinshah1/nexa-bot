import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  BACKUP_SCHEDULE_SETTING_KEYS,
  HOSTING_CODE_LOCKOUT_SECONDS,
  HOSTING_ERROR_CODES,
  HOSTING_SECTION_SESSION_TTL_SECONDS,
  IDENTITY_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  TELEGRAM_SECRET_TOKEN_HEADER,
  isNexaError,
  systemJobActor,
  type ActorContext,
  type CorrelationId,
  type TenantContext,
} from '@nexa/contracts';
import type { ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  adminPermissionOverrides,
  admins,
  auditLogs,
  botInstances,
  hostedBots,
  hostingTotpFactors,
  operationalEvents,
  outboxMessages,
  tenants,
} from '../../apps/api/src/infrastructure/persistence/schema';
import {
  totpForStep,
  totpStepAt,
} from '../../apps/api/src/modules/platform/identity/application/totp';
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

const ORIGIN = 'https://admin.hosting.test';
const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-hosting';
const OWNER_PASSWORD = 'the-owners-own-password';
const HOSTED_PASSWORD = 'the-hosted-owners-password';

/**
 * Phase 6A PR-3 (D1) — the creator panel against the real app and a real database: the
 * owner-only guard, the section's own second factor and 12-hour session, the fresh code on
 * every sensitive action, every action, the expiry sweep, and that a stopped hosted bot is
 * really stopped (write paths, webhook, Web Admin sign-in and sessions).
 *
 * The app connects as `nexa_app` (ADR-0037, the harness's `createApiApp`), so every statement
 * the panel makes is bound by row-level security; the fixtures and the cross-tenant reads
 * back are the owner's handle (`container.database`).
 *
 * The clock is the container's own, moved forward by the cases: every code is a fresh
 * 30-second step (the replay rule refuses a step twice), and the 12-hour expiry and the
 * 15-minute lock are crossed by moving it.
 */
describe('creator panel «میزبانی‌ها» (phase 6A PR-3)', () => {
  let api: ApiApp;
  let offsetMs = 0;
  let keys = 0;
  let owner: SeededAdmin;
  let ownerActor: ActorContext;
  let operatorActor: ActorContext;
  let hostedOwnerActor: ActorContext;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);
  const key = () => `hosting-key-${String((keys += 1))}`;
  const now = () => api.container.clock.now();
  /** A code for a step no earlier code used. */
  const code = (secret: string) => {
    offsetMs += 30_000;
    return totpForStep(secret, totpStepAt(now()));
  };
  const codeOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      if (isNexaError(error)) return error.code;
      throw error;
    }
    throw new Error('expected a refusal');
  };

  async function signIn(
    admin: SeededAdmin,
    scope: TenantContext = tenantA,
  ): Promise<{ actor: ActorContext; token: string }> {
    const result = await api.container.auth.login(
      scope,
      { type: 'API', id: null, label: null, surface: 'WEB', correlationId: 'c' as CorrelationId },
      { username: admin.username, password: admin.password },
      { ip: null, userAgent: null },
    );
    return {
      token: result.token,
      actor: {
        type: 'WEB_ADMIN',
        id: admin.id,
        label: admin.username,
        surface: 'WEB',
        correlationId: 'test-correlation' as CorrelationId,
        sessionId: result.session.id,
      },
    };
  }

  /** Enrols and activates the section factor: answers its secret, codes and section token. */
  async function openPanel(actor: ActorContext = ownerActor) {
    const enrolment = await api.container.hostingSection.enrol(
      tenantA,
      actor,
      { password: OWNER_PASSWORD },
      { ip: null },
    );
    const activated = await api.container.hostingSection.activate(tenantA, actor, {
      code: code(enrolment.secret),
    });
    return {
      secret: enrolment.secret,
      recoveryCodes: activated.recoveryCodes,
      token: activated.opened.token,
    };
  }

  async function createBot(
    panel: { secret: string; token: string },
    slug = 'hosted-one',
    extra: Record<string, unknown> = {},
  ) {
    return api.container.hosting.create(tenantA, ownerActor, panel.token, {
      idempotencyKey: key(),
      proof: { code: code(panel.secret) },
      slug,
      displayName: `Bot ${slug}`,
      adminUsername: `${slug}-admin`,
      adminDisplayName: 'Hosted owner',
      adminPassword: HOSTED_PASSWORD,
      expiresAt: null,
      ...extra,
    });
  }

  const tenantRow = async (id: string) =>
    (await api.container.database.db.select().from(tenants).where(eq(tenants.id, id)))[0];

  beforeAll(async () => {
    const config = testConfig({
      WEB_ADMIN_ORIGINS: ORIGIN,
      HOSTED_BOTS_CREATE_ENABLED: 'true',
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
    const clock = api.container.clock as { now: () => Date };
    const real = clock.now.bind(clock);
    clock.now = () => new Date(real().getTime() + offsetMs);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    offsetMs = 0;
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    owner = await createAdmin(api.container, tenantA, {
      username: 'panel-owner',
      password: OWNER_PASSWORD,
      roleKeys: ['owner'],
    });
    ownerActor = (await signIn(owner)).actor;
    // An installation operator handed the key itself through a GRANT override.
    const operator = await createAdmin(api.container, tenantA, {
      username: 'panel-operator',
      roleKeys: ['operator'],
    });
    await api.container.database.db.insert(adminPermissionOverrides).values({
      tenantId: tenantA.tenantId,
      adminId: operator.id,
      permissionKey: 'hosting.manage',
      effect: 'GRANT',
      reason: 'test: a delegated key must not open the owner’s section',
    });
    operatorActor = (await signIn(operator)).actor;
    // Another tenant's owner: holds EVERY key, hosting.manage included, in their tenant.
    const other = await createAdmin(api.container, tenantB, {
      username: 'other-owner',
      roleKeys: ['owner'],
    });
    hostedOwnerActor = (await signIn(other, tenantB)).actor;
  });

  describe('the owner-only guard', () => {
    it('refuses another tenant’s owner, a non-owner installation admin and a job — audited', async () => {
      const panel = await openPanel();
      for (const [actor, scope] of [
        [hostedOwnerActor, tenantB],
        [operatorActor, tenantA],
        [systemJobActor('probe', 'c' as CorrelationId), tenantA],
      ] as const) {
        expect(await codeOf(api.container.hostingSection.status(scope, actor, null))).toBe(
          HOSTING_ERROR_CODES.OWNER_ONLY,
        );
        // Even with the owner's own section token, nothing opens.
        expect(await codeOf(api.container.hosting.list(scope, actor, panel.token))).toBe(
          HOSTING_ERROR_CODES.OWNER_ONLY,
        );
        expect(
          await codeOf(
            api.container.hostingSection.enrol(scope, actor, { password: 'x' }, { ip: null }),
          ),
        ).toBe(HOSTING_ERROR_CODES.OWNER_ONLY);
      }
      // A hosted owner aiming at the installation scope is refused as well (by the guard:
      // they are no administrator there at all).
      await expect(
        api.container.hosting.list(tenantA, hostedOwnerActor, panel.token),
      ).rejects.toMatchObject({
        kind: 'PERMISSION_DENIED',
      });
      const denied = await api.container.database.db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, 'hosting.list'), eq(auditLogs.result, 'DENIED')));
      expect(denied.length).toBe(4);
      // The owner himself is let in.
      expect((await api.container.hosting.list(tenantA, ownerActor, panel.token)).bots).toEqual([]);
    });
  });

  describe('the section’s second factor', () => {
    it('enrols with the password, seals the secret, activates with a code and opens the section', async () => {
      expect(
        await codeOf(
          api.container.hostingSection.enrol(
            tenantA,
            ownerActor,
            { password: 'wrong-password!!' },
            { ip: null },
          ),
        ),
      ).not.toBe('');
      const enrolment = await api.container.hostingSection.enrol(
        tenantA,
        ownerActor,
        { password: OWNER_PASSWORD },
        { ip: null },
      );
      expect(enrolment.otpauthUri).toMatch(/^otpauth:\/\/totp\/Nexa%20Hosting:panel-owner\?/);
      expect(enrolment.qrPngDataUrl).toMatch(/^data:image\/png;base64,/);
      const [stored] = await api.container.database.db.select().from(hostingTotpFactors);
      expect(stored?.totpSecretCiphertext).not.toContain(enrolment.secret);
      expect(stored?.state).toBe('PENDING');

      expect(
        await codeOf(
          api.container.hostingSection.activate(tenantA, ownerActor, { code: '000000' }),
        ),
      ).toBe(HOSTING_ERROR_CODES.CODE_REJECTED);
      const activated = await api.container.hostingSection.activate(tenantA, ownerActor, {
        code: code(enrolment.secret),
      });
      expect(activated.recoveryCodes).toHaveLength(10);
      const status = await api.container.hostingSection.status(
        tenantA,
        ownerActor,
        activated.opened.token,
      );
      expect(status.factor).toBe('ACTIVE');
      expect(status.recoveryCodesRemaining).toBe(10);
      expect(status.session).not.toBeNull();
      // Enrolling again while active is refused.
      expect(
        await codeOf(
          api.container.hostingSection.enrol(
            tenantA,
            ownerActor,
            { password: OWNER_PASSWORD },
            { ip: null },
          ),
        ),
      ).toBe(HOSTING_ERROR_CODES.SECOND_FACTOR_ACTIVE);
    });

    it('a pending enrolment can be finished only from the Web Admin session that saw it', async () => {
      const enrolment = await api.container.hostingSection.enrol(
        tenantA,
        ownerActor,
        { password: OWNER_PASSWORD },
        { ip: null },
      );
      const elsewhere = (await signIn(owner)).actor;
      expect(
        await codeOf(
          api.container.hostingSection.activate(tenantA, elsewhere, {
            code: code(enrolment.secret),
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.ENROLMENT_EXPIRED);
    });

    it('the section session lasts 12 hours by the Clock and is bound to its Web Admin session', async () => {
      const panel = await openPanel();
      expect(await codeOf(api.container.hosting.list(tenantA, ownerActor, null))).toBe(
        HOSTING_ERROR_CODES.SECTION_SESSION_REQUIRED,
      );
      // The same section cookie presented from another sign-in of the same owner opens nothing.
      const elsewhere = (await signIn(owner)).actor;
      expect(await codeOf(api.container.hosting.list(tenantA, elsewhere, panel.token))).toBe(
        HOSTING_ERROR_CODES.SECTION_SESSION_REQUIRED,
      );
      offsetMs += (HOSTING_SECTION_SESSION_TTL_SECONDS - 60) * 1000;
      await api.container.hosting.list(tenantA, ownerActor, panel.token);
      offsetMs += 61 * 1000;
      expect(await codeOf(api.container.hosting.list(tenantA, ownerActor, panel.token))).toBe(
        HOSTING_ERROR_CODES.SECTION_SESSION_REQUIRED,
      );
    });

    it('a recovery code opens the section once; regenerating kills the old set', async () => {
      const panel = await openPanel();
      const first = panel.recoveryCodes[0] as string;
      const opened = await api.container.hostingSection.openSession(tenantA, ownerActor, {
        proof: { backupCode: first },
      });
      await api.container.hosting.list(tenantA, ownerActor, opened.opened.token);
      expect(
        await codeOf(
          api.container.hostingSection.openSession(tenantA, ownerActor, {
            proof: { backupCode: first },
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.CODE_REJECTED);
      const fresh = await api.container.hostingSection.regenerateRecoveryCodes(
        tenantA,
        ownerActor,
        opened.opened.token,
        { proof: { code: code(panel.secret) } },
      );
      expect(fresh.recoveryCodes).toHaveLength(10);
      expect(
        await codeOf(
          api.container.hostingSection.openSession(tenantA, ownerActor, {
            proof: { backupCode: panel.recoveryCodes[1] as string },
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.CODE_REJECTED);
      await api.container.hostingSection.openSession(tenantA, ownerActor, {
        proof: { backupCode: fresh.recoveryCodes[0] as string },
      });
      // The Web Admin sign-in factor's codes and the section's are different sets: a section
      // code never verifies as anything else, and status counts the section's own.
      const status = await api.container.hostingSection.status(tenantA, ownerActor, null);
      expect(status.recoveryCodesRemaining).toBe(9);
    });

    it('five wrong codes lock the section’s codes for 15 minutes, even a right one; then it resets', async () => {
      const panel = await openPanel();
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        expect(
          await codeOf(
            api.container.hostingSection.openSession(tenantA, ownerActor, {
              proof: { code: '123456' },
            }),
          ),
        ).toBe(HOSTING_ERROR_CODES.CODE_REJECTED);
      }
      expect(
        await codeOf(
          api.container.hostingSection.openSession(tenantA, ownerActor, {
            proof: { code: '123456' },
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.CODE_ATTEMPTS_LOCKED);
      // Locked: a correct code and an unused recovery code are refused too.
      expect(
        await codeOf(
          api.container.hostingSection.openSession(tenantA, ownerActor, {
            proof: { code: code(panel.secret) },
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.CODE_ATTEMPTS_LOCKED);
      expect(
        await codeOf(
          api.container.hostingSection.openSession(tenantA, ownerActor, {
            proof: { backupCode: panel.recoveryCodes[0] as string },
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.CODE_ATTEMPTS_LOCKED);
      const status = await api.container.hostingSection.status(tenantA, ownerActor, null);
      expect(status.lockedUntil).not.toBeNull();

      offsetMs += HOSTING_CODE_LOCKOUT_SECONDS * 1000;
      await api.container.hostingSection.openSession(tenantA, ownerActor, {
        proof: { code: code(panel.secret) },
      });
      const [factor] = await api.container.database.db.select().from(hostingTotpFactors);
      expect(factor?.failedAttempts).toBe(0);
      expect(factor?.lockedUntil).toBeNull();
      const failed = await api.container.database.db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, 'hosting.session_open'), eq(auditLogs.result, 'FAILED')));
      expect(failed.length).toBe(7);
    });
  });

  describe('sensitive actions re-ask for a fresh code', () => {
    it('refuses an action with no code, a wrong code, or the code already used — and changes nothing', async () => {
      const panel = await openPanel();
      const created = await createBot(panel);
      const id = created.bot.tenantId;
      const suspend = (proof: unknown) =>
        api.container.hosting.suspend(tenantA, ownerActor, panel.token, id, {
          idempotencyKey: key(),
          proof,
        });
      await expect(suspend(undefined)).rejects.toThrow();
      expect(await codeOf(suspend({ code: '000000' }))).toBe(HOSTING_ERROR_CODES.CODE_REJECTED);
      // The step the creation itself spent.
      const spent = totpForStep(panel.secret, totpStepAt(now()));
      expect(await codeOf(suspend({ code: spent }))).toBe(HOSTING_ERROR_CODES.CODE_REJECTED);
      expect((await tenantRow(id))?.status).toBe('ACTIVE');
      // An open section is not a code: a fresh one is still required, and then it works.
      await suspend({ code: code(panel.secret) });
      expect((await tenantRow(id))?.status).toBe('STOPPED');
    });
  });

  describe('the actions', () => {
    it('creates a HOSTED tenant with its own Web Admin owner, audited in the owner’s log only', async () => {
      const panel = await openPanel();
      const idempotencyKey = key();
      const proof = { code: code(panel.secret) };
      const input = {
        idempotencyKey,
        proof,
        slug: 'hosted-one',
        displayName: 'Hosted One',
        adminUsername: 'hosted-admin',
        adminDisplayName: 'Hosted owner',
        adminPassword: HOSTED_PASSWORD,
        expiresAt: null,
      };
      const created = await api.container.hosting.create(tenantA, ownerActor, panel.token, input);
      expect(created.replayed).toBe(false);
      expect(created.bot).toMatchObject({
        slug: 'hosted-one',
        state: 'ACTIVE',
        tenantStatus: 'ACTIVE',
        customerCount: 0,
        webAdmin: { username: 'hosted-admin' },
        telegramBot: null,
        expiresAt: null,
      });
      expect(created.bot.resources.length).toBeGreaterThan(0);
      const id = created.bot.tenantId;
      const row = await tenantRow(id);
      expect(row).toMatchObject({
        kind: 'HOSTED',
        parentTenantId: tenantA.tenantId,
        status: 'ACTIVE',
      });
      // Nothing was written to the hosted tenant's own audit log by the creation (D5).
      expect(
        await api.container.database.db.select().from(auditLogs).where(eq(auditLogs.tenantId, id)),
      ).toHaveLength(0);
      // Its own owner can sign in to its own tenant.
      const hostedAdmin = (
        await api.container.database.db.select().from(admins).where(eq(admins.tenantId, id))
      )[0];
      expect(
        await api.container.admins.roleKeysFor(
          { tenantId: id as never, botInstanceId: null },
          hostedAdmin?.id as never,
        ),
      ).toEqual(['owner']);
      await signIn(
        { id: hostedAdmin?.id as never, username: 'hosted-admin', password: HOSTED_PASSWORD },
        { tenantId: id as never, botInstanceId: null },
      );
      // Audited in the installation's log; nothing in the hosted tenant's (D5).
      const audit = await api.container.database.db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, 'hosting.create'), eq(auditLogs.result, 'SUCCESS')));
      expect(audit).toHaveLength(1);
      expect(audit[0]?.tenantId).toBe(tenantA.tenantId);
      expect(JSON.stringify(audit[0])).not.toContain(HOSTED_PASSWORD);
      const events = await api.container.database.db
        .select()
        .from(outboxMessages)
        .where(eq(outboxMessages.aggregateId, id));
      expect(events.map((event) => event.eventType)).toEqual(['TenantCreated']);

      // A replay of the same key answers the first result without a new code or a new tenant.
      const replay = await api.container.hosting.create(tenantA, ownerActor, panel.token, input);
      expect(replay.replayed).toBe(true);
      expect(replay.bot.tenantId).toBe(id);
      // A taken slug is refused.
      expect(await codeOf(createBot(panel, 'hosted-one'))).toBe(HOSTING_ERROR_CODES.SLUG_TAKEN);
      const list = await api.container.hosting.list(tenantA, ownerActor, panel.token);
      expect(list.bots.map((bot) => bot.tenantId)).toEqual([id]);
      expect(list.create).toEqual({ enabled: true, refusal: null });

      // The fail-closed tenant guard (#411): a new HOSTED tenant is never the installation's
      // PRIMARY, and its creation never re-resolves the role's own tenant.
      expect((await api.container.tenants.findPrimary())?.id).toBe(tenantA.tenantId);
      await expect(api.container.installationTenantGuard.verify()).resolves.toBe(tenantA.tenantId);
    });

    it('suspension really stops the bot: write paths, webhook, Web Admin sign-in and sessions', async () => {
      const panel = await openPanel();
      const created = await createBot(panel);
      const id = created.bot.tenantId;
      const hostedScope: TenantContext = { tenantId: id as never, botInstanceId: null };
      const hostedAdminRow = (
        await api.container.database.db.select().from(admins).where(eq(admins.tenantId, id))
      )[0];
      const hostedAdmin: SeededAdmin = {
        id: hostedAdminRow?.id as never,
        username: hostedAdminRow?.username as string,
        password: HOSTED_PASSWORD,
      };
      const session = await signIn(hostedAdmin, hostedScope);
      const botId = api.container.ids.uuid();
      await api.container.database.db.insert(botInstances).values({
        id: botId,
        tenantId: id,
        username: 'hosted_one_bot',
        status: 'ACTIVE',
        tokenCiphertext: 'not-a-real-token',
        tokenKeyId: 'test-1',
      });
      const writeSetting = () =>
        api.container.settingsService.set(hostedScope, session.actor, {
          key: BACKUP_SCHEDULE_SETTING_KEYS.enabled,
          value: false,
          expectedVersion: null,
          idempotencyKey: key(),
        });

      await api.container.hosting.suspend(tenantA, ownerActor, panel.token, id, {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
        reason: 'test',
      });
      expect((await tenantRow(id))?.status).toBe('STOPPED');
      expect(await api.container.tenants.scopeIsActive(hostedScope)).toBe(false);
      // Refused INSIDE its transaction by ScopeActivityReader, whatever the session says.
      expect(await codeOf(writeSetting())).toBe(PLATFORM_ERROR_CODES.TENANT_NOT_FOUND);
      expect(await codeOf(api.container.auth.authenticate(session.token))).toBe(
        IDENTITY_ERROR_CODES.AUTH_TENANT_SUSPENDED,
      );
      await expect(signIn(hostedAdmin, hostedScope)).rejects.toThrow();
      const webhook = await inject({
        method: 'POST',
        url: `/telegram/webhook/${botId}`,
        headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
        payload: {
          update_id: 1,
          message: { message_id: 1, date: 1, chat: { id: 7, type: 'private' }, text: '/start' },
        },
      });
      expect(webhook.statusCode).toBe(404);
      expect(webhook.json().error.code).toBe(PLATFORM_ERROR_CODES.TENANT_NOT_FOUND);
      const changed = await api.container.database.db
        .select()
        .from(outboxMessages)
        .where(
          and(
            eq(outboxMessages.aggregateId, id),
            eq(outboxMessages.eventType, 'HostedBotStateChanged'),
          ),
        );
      expect(changed).toHaveLength(1);

      // Activated again: everything is back.
      const activated = await api.container.hosting.activate(tenantA, ownerActor, panel.token, id, {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
      });
      expect(activated.bot.state).toBe('ACTIVE');
      await api.container.auth.authenticate(session.token);
      await signIn(hostedAdmin, hostedScope);
      await writeSetting();
      // Activating an ACTIVE bot is a state conflict, refused before a code is spent.
      expect(
        await codeOf(
          api.container.hosting.activate(tenantA, ownerActor, panel.token, id, {
            idempotencyKey: key(),
            proof: { code: '000000' },
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.STATE_CONFLICT);
    });

    it('deletes softly (restorable), and purges only a deleted bot with its slug typed', async () => {
      const panel = await openPanel();
      const id = (await createBot(panel)).bot.tenantId;
      const act = (action: 'delete' | 'activate') =>
        api.container.hosting[action](tenantA, ownerActor, panel.token, id, {
          idempotencyKey: key(),
          proof: { code: code(panel.secret) },
        });
      expect(
        await codeOf(
          api.container.hosting.purge(tenantA, ownerActor, panel.token, id, {
            idempotencyKey: key(),
            proof: { code: code(panel.secret) },
            confirmSlug: 'hosted-one',
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.STATE_CONFLICT);
      const deleted = await act('delete');
      expect(deleted.bot).toMatchObject({ state: 'DELETED', tenantStatus: 'DISABLED' });
      expect(deleted.bot.deletedAt).not.toBeNull();
      expect((await act('activate')).bot).toMatchObject({ state: 'ACTIVE', deletedAt: null });
      await act('delete');

      const preview = await api.container.hosting.purgePreview(
        tenantA,
        ownerActor,
        panel.token,
        id,
      );
      expect(preview.confirmSlug).toBe('hosted-one');
      expect(preview.counts.admins).toBe(1);
      expect(
        await codeOf(
          api.container.hosting.purge(tenantA, ownerActor, panel.token, id, {
            idempotencyKey: key(),
            proof: { code: code(panel.secret) },
            confirmSlug: 'hosted-ONE',
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.PURGE_CONFIRMATION_MISMATCH);
      const purged = await api.container.hosting.purge(tenantA, ownerActor, panel.token, id, {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
        confirmSlug: 'hosted-one',
      });
      expect(purged).toMatchObject({ erasure: 'PENDING', bot: { state: 'PURGED' } });
      expect(await codeOf(act('activate'))).toBe(HOSTING_ERROR_CODES.STATE_CONFLICT);
      // A purged hosted tenant leaves the installation's own tenant where it was (#411).
      await expect(api.container.installationTenantGuard.verify()).resolves.toBe(tenantA.tenantId);
    });

    it('sets and clears an expiry date; the limits editor changes a limit to «نامحدود»', async () => {
      const panel = await openPanel();
      const id = (await createBot(panel)).bot.tenantId;
      const at = new Date(now().getTime() + 7 * 24 * 3600 * 1000).toISOString();
      const set = await api.container.hosting.setExpiry(tenantA, ownerActor, panel.token, id, {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
        expiresAt: at,
      });
      expect(set.bot.expiresAt).toBe(at);
      const cleared = await api.container.hosting.setExpiry(tenantA, ownerActor, panel.token, id, {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
        expiresAt: null,
      });
      expect(cleared.bot.expiresAt).toBeNull();

      const changed = await api.container.hosting.setLimit(tenantA, ownerActor, panel.token, id, {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
        resource: 'UPDATE_CONCURRENCY',
        limit: { mode: 'UNLIMITED' },
      });
      expect(
        changed.tenant.limits.find((limit) => limit.resource === 'UPDATE_CONCURRENCY')?.limit,
      ).toEqual({
        mode: 'UNLIMITED',
      });
      // Without a fresh code, PR-2's limit is not reached through the panel.
      expect(
        await codeOf(
          api.container.hosting.setLimit(tenantA, ownerActor, panel.token, id, {
            idempotencyKey: key(),
            proof: { code: '000000' },
            resource: 'UPDATE_CONCURRENCY',
            limit: null,
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.CODE_REJECTED);
      const limits = await api.container.hosting.limits(tenantA, ownerActor, panel.token);
      expect(limits.tenants.some((tenant) => tenant.tenantId === id)).toBe(true);
      // An unknown tenant is not a hosted bot.
      expect(
        await codeOf(
          api.container.hosting.setLimit(tenantA, ownerActor, panel.token, tenantB.tenantId, {
            idempotencyKey: key(),
            proof: { code: code(panel.secret) },
            resource: 'UPDATE_CONCURRENCY',
            limit: null,
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.BOT_NOT_FOUND);
    });

    it('«ورود به پنل» is a typed stub for 6B; the server card reads the host', async () => {
      const panel = await openPanel();
      const id = (await createBot(panel)).bot.tenantId;
      expect(
        await codeOf(
          api.container.hosting.enter(tenantA, ownerActor, panel.token, id, {
            proof: { code: code(panel.secret) },
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.ENTER_NOT_IMPLEMENTED);
      const server = await api.container.hosting.server(tenantA, ownerActor, panel.token);
      expect(server.cpu.cores).toBeGreaterThan(0);
      expect(server.memory.totalBytes).toBeGreaterThan(0);
      expect(server.estimate.liveHostedBots).toBe(1);
      expect(server.estimate.formula).toContain('75');
    });
  });

  describe('the expiry sweep', () => {
    it('expires an ACTIVE bot once its date passes, tells the owner’s group once, and is idempotent', async () => {
      const panel = await openPanel();
      const at = new Date(now().getTime() + 3600_000).toISOString();
      const id = (await createBot(panel, 'expiring', { expiresAt: at })).bot.tenantId;
      const suspendedId = (await createBot(panel, 'suspended', { expiresAt: at })).bot.tenantId;
      await api.container.hosting.suspend(tenantA, ownerActor, panel.token, suspendedId, {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
      });
      expect(await api.container.hostedBotExpiry.runOnce(tenantA)).toBe(0);
      offsetMs += 3600_000;
      expect(await api.container.hostedBotExpiry.runOnce(tenantA)).toBe(1);
      expect(await api.container.hostedBotExpiry.runOnce(tenantA)).toBe(0);
      expect((await tenantRow(id))?.status).toBe('STOPPED');
      const [row] = await api.container.database.db
        .select()
        .from(hostedBots)
        .where(eq(hostedBots.hostedTenantId, id));
      expect(row?.state).toBe('EXPIRED');
      const [other] = await api.container.database.db
        .select()
        .from(hostedBots)
        .where(eq(hostedBots.hostedTenantId, suspendedId));
      expect(other?.state).toBe('SUSPENDED');
      const told = await api.container.database.db
        .select()
        .from(operationalEvents)
        .where(eq(operationalEvents.code, 'hosting.bot_expired'));
      expect(told).toHaveLength(1);
      expect(told[0]?.tenantId).toBe(tenantA.tenantId);
      const audit = await api.container.database.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'hosting.expire'));
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actorType).toBe('SYSTEM_JOB');

      // Activating needs a date in the future (or none) first.
      const activate = () =>
        api.container.hosting.activate(tenantA, ownerActor, panel.token, id, {
          idempotencyKey: key(),
          proof: { code: code(panel.secret) },
        });
      expect(await codeOf(activate())).toBe(HOSTING_ERROR_CODES.EXPIRY_PASSED);
      await api.container.hosting.setExpiry(tenantA, ownerActor, panel.token, id, {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
        expiresAt: null,
      });
      expect((await activate()).bot.state).toBe('ACTIVE');
      expect(await api.container.hostedBotExpiry.runOnce(tenantA)).toBe(0);
    });
  });

  describe('over HTTP', () => {
    function cookieFrom(
      response: { headers: Record<string, unknown> },
      name: string,
    ): string | null {
      const header = response.headers['set-cookie'];
      const all = Array.isArray(header) ? header.map(String) : [String(header ?? '')];
      for (const line of all) {
        const match = new RegExp(`(?:^|\\s)${name}=([^;]+)`).exec(line);
        if (match !== null && match[1] !== '') return `${name}=${match[1] as string}`;
      }
      return null;
    }

    it('the sidebar key is shown to the installation owner only, not to a delegated operator', async () => {
      // The session's permission list is chrome; `hosting.manage` is drawn for the owner alone.
      const shown = async (username: string, password: string) => {
        const login = await inject({
          method: 'POST',
          url: `${API_PREFIX}/auth/login`,
          headers: { origin: ORIGIN },
          payload: { username, password },
        });
        expect(login.statusCode).toBe(201);
        const cookie = cookieFrom(login, 'nexa_admin_session') as string;
        const session = await inject({
          method: 'GET',
          url: `${API_PREFIX}/auth/session`,
          headers: { cookie, origin: ORIGIN },
        });
        expect(session.statusCode).toBe(200);
        return {
          login: (login.json() as { permissions: string[] }).permissions,
          session: (session.json() as { permissions: string[] }).permissions,
        };
      };
      const ownerSees = await shown(owner.username, OWNER_PASSWORD);
      expect(ownerSees.login).toContain('hosting.manage');
      expect(ownerSees.session).toContain('hosting.manage');
      const delegated = await createAdmin(api.container, tenantA, {
        username: 'panel-delegated',
        password: 'the-delegated-password',
        roleKeys: ['operator'],
      });
      await api.container.database.db.insert(adminPermissionOverrides).values({
        tenantId: tenantA.tenantId,
        adminId: delegated.id,
        permissionKey: 'hosting.manage',
        effect: 'GRANT',
        reason: 'test: a delegated key is not drawn',
      });
      const delegatedSees = await shown('panel-delegated', 'the-delegated-password');
      expect(delegatedSees.login).not.toContain('hosting.manage');
      expect(delegatedSees.session).not.toContain('hosting.manage');
    });

    it('the section cookie is issued on activation and required beside the session cookie', async () => {
      const login = await inject({
        method: 'POST',
        url: `${API_PREFIX}/auth/login`,
        headers: { origin: ORIGIN },
        payload: { username: owner.username, password: OWNER_PASSWORD },
      });
      const session = cookieFrom(login, 'nexa_admin_session') as string;
      expect(session).not.toBeNull();
      const as = (cookie: string) => ({ cookie, origin: ORIGIN });
      const status = await inject({
        method: 'GET',
        url: `${API_PREFIX}/hosting/status`,
        headers: as(session),
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        factor: 'NONE',
        session: null,
        create: { enabled: true },
      });
      const enrol = await inject({
        method: 'POST',
        url: `${API_PREFIX}/hosting/2fa/enrol`,
        headers: as(session),
        payload: { password: OWNER_PASSWORD },
      });
      expect(enrol.statusCode).toBe(200);
      expect(enrol.headers['cache-control']).toBe('no-store');
      const activate = await inject({
        method: 'POST',
        url: `${API_PREFIX}/hosting/2fa/activate`,
        headers: as(session),
        payload: { code: code(enrol.json().secret as string) },
      });
      expect(activate.statusCode).toBe(200);
      const section = cookieFrom(activate, 'nexa_hosting') as string;
      expect(section).not.toBeNull();
      const without = await inject({
        method: 'GET',
        url: `${API_PREFIX}/hosting/bots`,
        headers: as(session),
      });
      expect(without.statusCode).toBe(401);
      expect(without.json().error.code).toBe(HOSTING_ERROR_CODES.SECTION_SESSION_REQUIRED);
      const withIt = await inject({
        method: 'GET',
        url: `${API_PREFIX}/hosting/bots`,
        headers: as(`${session}; ${section}`),
      });
      expect(withIt.statusCode).toBe(200);
      expect(withIt.json()).toMatchObject({ bots: [] });
      const close = await inject({
        method: 'POST',
        url: `${API_PREFIX}/hosting/session/close`,
        headers: as(`${session}; ${section}`),
      });
      expect(close.statusCode).toBe(200);
      const after = await inject({
        method: 'GET',
        url: `${API_PREFIX}/hosting/bots`,
        headers: as(`${session}; ${section}`),
      });
      expect(after.statusCode).toBe(401);
    });
  });
});
