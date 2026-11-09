import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  HOSTED_ENTER_TOKEN_TTL_SECONDS,
  HOSTING_ERROR_CODES,
  HOSTING_SECTION_SESSION_TTL_SECONDS,
  IDENTITY_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  isNexaError,
  type ActorContext,
  type CorrelationId,
  type TenantContext,
} from '@nexa/contracts';
import type { ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  adminSessions,
  admins,
  auditLogs,
  hostedBotActivations,
  hostingEnterTokens,
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
  testConfig,
  type SeededAdmin,
} from './harness';

const ORIGIN = 'https://admin.hosting.test';
const OWNER_PASSWORD = 'the-owners-own-password';
const HOSTED_PASSWORD = 'the-hosted-owners-password';
const DOMAIN = 'shop.hosted-enter.test';
const OTHER_DOMAIN = 'other.hosted-enter.test';

/**
 * Phase 6B PR-5 — «ورود به پنل» (D5; ADR-0039 § 9) against the real app and database, the app
 * connected as `nexa_app` with row-level security on (the harness's `createApiApp`), so every
 * cross-tenant statement must take its pinned system-path reason or fail.
 *
 * Proves: the token is single-use, expires by the `Clock`, and is bound to its audience (the
 * hosted tenant AND its domain); the entered session writes NO row to the hosted tenant's audit
 * log (several write paths and a denial), its rows going to the owner's log instead; it cannot
 * change the tenant's admins, second factors or secrets; the HOST principal cannot sign in and
 * its admins cannot touch it; and the session ends with the section session (close, replace,
 * expiry), with the owner's own Web Admin session, and on «خروج».
 */
describe('«ورود به پنل» (phase 6B PR-5)', () => {
  let api: ApiApp;
  let offsetMs = 0;
  let baseMs = 0;
  let keys = 0;
  let owner: SeededAdmin;
  let ownerActor: ActorContext;
  let ownerToken: string;

  const db = () => api.container.database.db;
  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);
  const key = () => `enter-key-${String((keys += 1))}`;
  const now = () => api.container.clock.now();
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

  async function signIn(admin: SeededAdmin, scope: TenantContext) {
    const result = await api.container.auth.login(
      scope,
      { type: 'API', id: null, label: null, surface: 'WEB', correlationId: 'c' as CorrelationId },
      { username: admin.username, password: admin.password },
      { ip: null, userAgent: null },
    );
    const actor: ActorContext = {
      type: 'WEB_ADMIN',
      id: admin.id,
      label: admin.username,
      surface: 'WEB',
      correlationId: 'test-correlation' as CorrelationId,
      sessionId: result.session.id,
    };
    return { actor, token: result.token };
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

  /** A hosted bot whose domain is DNS- and TLS-verified (the activation's marks, set directly). */
  async function hostedBot(panel: { secret: string; token: string }, slug: string, domain: string) {
    const created = await api.container.hosting.create(tenantA, ownerActor, panel.token, {
      idempotencyKey: key(),
      proof: { code: code(panel.secret) },
      slug,
      displayName: `Bot ${slug}`,
      adminUsername: `${slug}-admin`,
      adminDisplayName: 'Hosted owner',
      adminPassword: HOSTED_PASSWORD,
      expiresAt: null,
    });
    const id = created.bot.tenantId;
    await db().insert(hostedBotActivations).values({
      tenantId: tenantA.tenantId,
      hostedTenantId: id,
      domain,
      dnsVerifiedAt: now(),
      tlsVerifiedAt: now(),
      createdAt: now(),
      updatedAt: now(),
    });
    return id;
  }

  const mint = (panel: { secret: string; token: string }, id: string, actor = ownerActor) =>
    api.container.hostingEnter.mint(tenantA, actor, panel.token, id, {
      idempotencyKey: key(),
      proof: { code: code(panel.secret) },
    });
  const tokenOf = (url: string | null) => /#token=(.+)$/.exec(url ?? '')?.[1] as string;

  /** Redeem over HTTP on `host`; answers the status and the session cookie it set. */
  async function redeem(host: string, token: string) {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}/auth/enter`,
      headers: { host, origin: `https://${host}` },
      payload: { token },
    });
    const header = response.headers['set-cookie'];
    const cookies = Array.isArray(header) ? header : header === undefined ? [] : [header];
    const cookie = cookies
      .map((value) => /^nexa_admin_session=([^;]+)/.exec(String(value))?.[1])
      .find((value) => value !== undefined && value !== '');
    const body = response.json() as { error?: { code?: string } };
    return { status: response.statusCode, code: body.error?.code, cookie: cookie ?? null };
  }

  async function entered(panel: { secret: string; token: string }, id: string) {
    const minted = await mint(panel, id);
    const opened = await redeem(DOMAIN, tokenOf(minted.url));
    expect(opened.status).toBe(201);
    const token = decodeURIComponent(opened.cookie as string);
    const resolved = await api.container.auth.authenticate(token);
    const actor: ActorContext = {
      type: 'WEB_ADMIN',
      id: resolved.admin.id,
      label: resolved.admin.username,
      surface: 'WEB',
      correlationId: 'entered-correlation' as CorrelationId,
      sessionId: resolved.session.id,
      ...(resolved.impersonation === null ? {} : { impersonation: resolved.impersonation }),
    };
    return { token, actor, scope: { tenantId: id as never, botInstanceId: null } as TenantContext };
  }

  const hostedAudit = (id: string) =>
    db().select().from(auditLogs).where(eq(auditLogs.tenantId, id));

  beforeAll(async () => {
    const config = testConfig({
      WEB_ADMIN_ORIGINS: ORIGIN,
      HOSTED_BOTS_CREATE_ENABLED: 'true',
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
    const clock = api.container.clock as { now: () => Date };
    baseMs = Math.floor(Date.now() / 30_000) * 30_000 + 10_000;
    clock.now = () => new Date(baseMs + offsetMs);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    offsetMs = 0;
    await resetDatabase(db());
    await seed(db(), api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    owner = await createAdmin(api.container, tenantA, {
      username: 'enter-owner',
      password: OWNER_PASSWORD,
      roleKeys: ['owner'],
    });
    const signedIn = await signIn(owner, tenantA);
    ownerActor = signedIn.actor;
    ownerToken = signedIn.token;
  });

  describe('the token', () => {
    it('is minted with a fresh code into the OWNER’s log, opens the hosted domain, and is single-use', async () => {
      const panel = await openPanel();
      const id = await hostedBot(panel, 'alpha', DOMAIN);
      const minted = await mint(panel, id);
      expect(minted.url).toMatch(
        new RegExp(`^https://${DOMAIN.replace(/\./g, '\\.')}/enter#token=`),
      );
      const token = tokenOf(minted.url);
      // Only the hash is stored, and the owner's log names the act — never the token.
      const [row] = await db().select().from(hostingEnterTokens);
      expect(row?.tokenHash).not.toBe(token);
      expect(row?.tenantId).toBe(tenantA.tenantId);
      expect(row?.expiresAt.getTime()).toBe(
        (row?.createdAt.getTime() ?? 0) + HOSTED_ENTER_TOKEN_TTL_SECONDS * 1000,
      );
      const ownerRows = await db()
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.tenantId, tenantA.tenantId), eq(auditLogs.action, 'hosting.enter')),
        );
      expect(ownerRows).toHaveLength(1);
      expect(JSON.stringify(ownerRows)).not.toContain(token);
      // The HOST principal exists now, password-less.
      const [host] = await db()
        .select()
        .from(admins)
        .where(and(eq(admins.tenantId, id), eq(admins.kind, 'HOST')));
      expect(host?.passwordHash).toBeNull();

      const first = await redeem(DOMAIN, token);
      expect(first.status).toBe(201);
      expect(first.cookie).not.toBeNull();
      const again = await redeem(DOMAIN, token);
      expect(again.status).toBe(401);
      expect(again.code).toBe(HOSTING_ERROR_CODES.ENTER_TOKEN_INVALID);
      expect(again.cookie).toBeNull();
    });

    it('expires after 15 minutes by the Clock', async () => {
      const panel = await openPanel();
      const id = await hostedBot(panel, 'alpha', DOMAIN);
      const token = tokenOf((await mint(panel, id)).url);
      offsetMs += HOSTED_ENTER_TOKEN_TTL_SECONDS * 1000;
      const late = await redeem(DOMAIN, token);
      expect(late.code).toBe(HOSTING_ERROR_CODES.ENTER_TOKEN_INVALID);
      const [row] = await db().select().from(hostingEnterTokens);
      expect(row?.usedAt).toBeNull();
    });

    it('is bound to its audience: another hosted bot’s domain, the owner’s host and an unknown host refuse it', async () => {
      const panel = await openPanel();
      const id = await hostedBot(panel, 'alpha', DOMAIN);
      await hostedBot(panel, 'beta', OTHER_DOMAIN);
      const token = tokenOf((await mint(panel, id)).url);
      // An unknown host is refused before the token is looked at (its Origin is no hosted
      // domain's); it spends nothing either.
      const unknown = await inject({
        method: 'POST',
        url: `${API_PREFIX}/auth/enter`,
        headers: { host: 'unknown.example.com', origin: 'https://unknown.example.com' },
        payload: { token },
      });
      expect(unknown.statusCode).toBe(403);
      for (const host of [OTHER_DOMAIN, 'admin.hosting.test']) {
        const response = await inject({
          method: 'POST',
          url: `${API_PREFIX}/auth/enter`,
          headers: { host, origin: host === 'admin.hosting.test' ? ORIGIN : `https://${host}` },
          payload: { token },
        });
        expect(response.statusCode, host).toBe(401);
        expect((response.json() as { error: { code: string } }).error.code).toBe(
          HOSTING_ERROR_CODES.ENTER_TOKEN_INVALID,
        );
      }
      // Still good on its own domain: the refusals spent nothing.
      expect((await redeem(DOMAIN, token)).status).toBe(201);
    });

    it('is bound to the DOMAIN it was minted for: moving the bot to another name kills it', async () => {
      const panel = await openPanel();
      const id = await hostedBot(panel, 'alpha', DOMAIN);
      const token = tokenOf((await mint(panel, id)).url);
      const moved = 'moved.hosted-enter.test';
      await db()
        .update(hostedBotActivations)
        .set({ domain: moved })
        .where(eq(hostedBotActivations.hostedTenantId, id));
      expect((await redeem(moved, token)).code).toBe(HOSTING_ERROR_CODES.ENTER_TOKEN_INVALID);
    });

    it('needs an active bot with a verified domain; a replay answers no second token', async () => {
      const panel = await openPanel();
      const created = await api.container.hosting.create(tenantA, ownerActor, panel.token, {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
        slug: 'bare',
        displayName: 'Bare',
        adminUsername: 'bare-admin',
        adminDisplayName: 'Bare owner',
        adminPassword: HOSTED_PASSWORD,
        expiresAt: null,
      });
      expect(await codeOf(mint(panel, created.bot.tenantId))).toBe(
        HOSTING_ERROR_CODES.ENTER_DOMAIN_REQUIRED,
      );
      const id = await hostedBot(panel, 'alpha', DOMAIN);
      const idempotencyKey = key();
      const first = await api.container.hostingEnter.mint(tenantA, ownerActor, panel.token, id, {
        idempotencyKey,
        proof: { code: code(panel.secret) },
      });
      const replay = await api.container.hostingEnter.mint(tenantA, ownerActor, panel.token, id, {
        idempotencyKey,
        proof: { code: code(panel.secret) },
      });
      expect(first.url).not.toBeNull();
      expect(replay).toEqual({ url: null, expiresAt: null, replayed: true });
      expect(await db().select().from(hostingEnterTokens)).toHaveLength(1);
    });
  });

  describe('the entered session', () => {
    it('shows the banner flag over HTTP, and writes NO row to the hosted tenant’s audit log', async () => {
      const panel = await openPanel();
      const id = await hostedBot(panel, 'alpha', DOMAIN);
      const before = (await hostedAudit(id)).length;
      const session = await entered(panel, id);

      const described = await inject({
        method: 'GET',
        url: `${API_PREFIX}/auth/session`,
        headers: {
          host: DOMAIN,
          cookie: `nexa_admin_session=${encodeURIComponent(session.token)}`,
        },
      });
      expect(described.statusCode).toBe(200);
      const body = described.json() as {
        impersonation: { ownerUsername: string } | null;
        permissions: string[];
        admin: { kind: string };
      };
      expect(body.impersonation).toEqual({ ownerUsername: owner.username });
      expect(body.admin.kind).toBe('HOST');
      expect(body.permissions).toContain('settings.edit');
      expect(body.permissions).not.toContain('admins.edit');
      expect(body.permissions).not.toContain('backup.download');

      // Several write paths the entered session can make, and one it is denied: a ping (the
      // reference write path), an admin create (denied: admins.edit), and its own sign-out.
      await api.container.recordPing.execute(session.scope, session.actor, {
        source: 'test',
        idempotencyKey: key(),
      });
      expect(
        await codeOf(
          api.container.adminManagement.create(session.scope, session.actor, {
            username: 'sneaky-admin',
            displayName: 'Sneaky',
            password: 'a-perfectly-fine-password',
            roleKeys: ['owner'],
            idempotencyKey: key(),
          }),
        ),
      ).toBe(PLATFORM_ERROR_CODES.PERMISSION_DENIED);
      const exit = await inject({
        method: 'POST',
        url: `${API_PREFIX}/auth/logout`,
        headers: {
          host: DOMAIN,
          origin: `https://${DOMAIN}`,
          cookie: `nexa_admin_session=${encodeURIComponent(session.token)}`,
        },
      });
      expect(exit.statusCode).toBe(201);

      // Nothing in the hosted tenant's log — not the opening, not the ping, not the denial,
      // not the exit.
      expect((await hostedAudit(id)).length).toBe(before);
      const owners = await db()
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.tenantId, tenantA.tenantId), eq(auditLogs.actedInTenantId, id)));
      const actions = owners.map((row) => `${row.action}:${row.result}`);
      expect(actions).toEqual(
        expect.arrayContaining([
          'hosting.enter_opened:SUCCESS',
          'system.ping:SUCCESS',
          'auth.logout:SUCCESS',
        ]),
      );
      expect(owners.some((row) => row.result === 'DENIED')).toBe(true);
      for (const row of owners) {
        expect(row.actorId).toBe(owner.id);
        expect(row.actorLabel).toBe(owner.username);
      }
    });

    it('cannot change the tenant’s admins, second factors, passwords or secrets', async () => {
      const panel = await openPanel();
      const id = await hostedBot(panel, 'alpha', DOMAIN);
      const { scope, actor } = await entered(panel, id);
      const [hostedOwner] = await db()
        .select()
        .from(admins)
        .where(and(eq(admins.tenantId, id), eq(admins.kind, 'OPERATOR')));
      const refusals = {
        disable: await codeOf(
          api.container.adminManagement.setStatus(
            scope,
            actor,
            hostedOwner?.id as never,
            {
              status: 'DISABLED',
              reason: 'entered session tries to lock the owner out',
              idempotencyKey: key(),
            } as never,
          ),
        ),
        enrol2fa: await codeOf(
          api.container.accountSecurity.enrolTotp(scope, actor, { password: 'x' }, { ip: null }),
        ),
        password: await codeOf(
          api.container.adminManagement.changeOwnPassword(
            scope,
            actor,
            { currentPassword: 'x', newPassword: 'another-long-password' },
            { ip: null },
          ),
        ),
        gatewayKey: await codeOf(
          api.container.paymentGateways.setCredential(scope, actor, {
            idempotencyKey: key(),
            provider: 'TONPAYS',
            apiKey: 'tp_live_should_never_land',
          }),
        ),
        botToken: await codeOf(
          api.container.botManagement.replaceToken(scope, actor, {
            idempotencyKey: key(),
            botId: '01900000-0000-7000-8000-00000000abcd',
            token: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          }),
        ),
      };
      expect(refusals.disable).toBe(PLATFORM_ERROR_CODES.PERMISSION_DENIED);
      expect(refusals.enrol2fa).toBe(IDENTITY_ERROR_CODES.IMPERSONATION_FORBIDDEN);
      expect(refusals.password).toBe(IDENTITY_ERROR_CODES.IMPERSONATION_FORBIDDEN);
      expect(refusals.gatewayKey).toBe(IDENTITY_ERROR_CODES.IMPERSONATION_FORBIDDEN);
      expect(refusals.botToken).toBe(IDENTITY_ERROR_CODES.IMPERSONATION_FORBIDDEN);
    });

    it('the HOST principal cannot sign in, and the tenant’s own owner cannot touch it', async () => {
      const panel = await openPanel();
      const id = await hostedBot(panel, 'alpha', DOMAIN);
      await entered(panel, id);
      const [host] = await db()
        .select()
        .from(admins)
        .where(and(eq(admins.tenantId, id), eq(admins.kind, 'HOST')));
      const hostedScope: TenantContext = { tenantId: id as never, botInstanceId: null };
      const login = await inject({
        method: 'POST',
        url: `${API_PREFIX}/auth/login`,
        headers: { host: DOMAIN, origin: `https://${DOMAIN}` },
        payload: { username: host?.username, password: 'anything-at-all-here' },
      });
      expect(login.statusCode).toBe(401);
      expect((login.json() as { error: { code: string } }).error.code).toBe(
        IDENTITY_ERROR_CODES.AUTH_INVALID_CREDENTIALS,
      );

      const hostedOwner = await signIn(
        { id: '', username: 'alpha-admin', password: HOSTED_PASSWORD } as never,
        hostedScope,
      ).catch(() => null);
      const [ownerRow] = await db()
        .select()
        .from(admins)
        .where(and(eq(admins.tenantId, id), eq(admins.username, 'alpha-admin')));
      const ownerActorThere: ActorContext = {
        type: 'WEB_ADMIN',
        id: ownerRow?.id as string,
        label: 'alpha-admin',
        surface: 'WEB',
        correlationId: 'c' as CorrelationId,
        ...(hostedOwner === null ? {} : { sessionId: hostedOwner.actor.sessionId as string }),
      };
      expect(
        await codeOf(
          api.container.adminManagement.setStatus(
            hostedScope,
            ownerActorThere,
            host?.id as never,
            {
              status: 'DISABLED',
              reason: 'the hosted owner tries to remove the host',
              idempotencyKey: key(),
            } as never,
          ),
        ),
      ).toBe(IDENTITY_ERROR_CODES.ADMIN_NOT_FOUND);
      // And beneath the service, the database refuses whatever path asks.
      await expect(
        db().execute(sql`UPDATE admins SET display_name = 'mine now' WHERE id = ${host?.id}`),
      ).rejects.toThrow();
      await expect(db().execute(sql`DELETE FROM admins WHERE id = ${host?.id}`)).rejects.toThrow();
      await expect(
        db().execute(sql`UPDATE admins SET kind = 'HOST' WHERE id = ${ownerRow?.id}`),
      ).rejects.toThrow();
    });
  });

  describe('it ends with the section session', () => {
    async function isLive(token: string): Promise<boolean> {
      try {
        await api.container.auth.authenticate(token);
        return true;
      } catch (error) {
        if (isNexaError(error) && error.code === IDENTITY_ERROR_CODES.AUTH_SESSION_INVALID) {
          return false;
        }
        throw error;
      }
    }

    it('when the owner closes the section — revoked at once', async () => {
      const panel = await openPanel();
      const id = await hostedBot(panel, 'alpha', DOMAIN);
      const { token } = await entered(panel, id);
      expect(await isLive(token)).toBe(true);
      await api.container.hostingSection.closeSession(tenantA, ownerActor);
      const live = await db()
        .select()
        .from(adminSessions)
        .where(and(eq(adminSessions.tenantId, id), isNull(adminSessions.revokedAt)));
      expect(live).toHaveLength(0);
      expect(await isLive(token)).toBe(false);
    });

    it('when the section expires', async () => {
      const panel = await openPanel();
      const id = await hostedBot(panel, 'alpha', DOMAIN);
      const { token } = await entered(panel, id);
      offsetMs += HOSTING_SECTION_SESSION_TTL_SECONDS * 1000;
      expect(await isLive(token)).toBe(false);
    });

    it('when the owner signs out of his own Web Admin', async () => {
      const panel = await openPanel();
      const id = await hostedBot(panel, 'alpha', DOMAIN);
      const { token } = await entered(panel, id);
      const signedOut = await api.container.auth.authenticate(ownerToken);
      await api.container.auth.logout(tenantA, ownerActor, signedOut.session.id);
      expect(await isLive(token)).toBe(false);
    });

    it('on «خروج»', async () => {
      const panel = await openPanel();
      const id = await hostedBot(panel, 'alpha', DOMAIN);
      const { token, scope, actor } = await entered(panel, id);
      await api.container.auth.logout(scope, actor, actor.sessionId as never);
      expect(await isLive(token)).toBe(false);
    });

    it('a token whose section closed before it was redeemed opens nothing', async () => {
      const panel = await openPanel();
      const id = await hostedBot(panel, 'alpha', DOMAIN);
      const token = tokenOf((await mint(panel, id)).url);
      await api.container.hostingSection.closeSession(tenantA, ownerActor);
      expect((await redeem(DOMAIN, token)).code).toBe(HOSTING_ERROR_CODES.ENTER_TOKEN_INVALID);
    });
  });
});
