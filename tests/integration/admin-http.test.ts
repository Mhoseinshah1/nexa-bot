import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_ROUTES,
  adminListResponseSchema,
  adminSessionListResponseSchema,
  API_PREFIX,
  AUTH_ROUTES,
  loginResponseSchema,
  roleListResponseSchema,
  SESSION_COOKIE_NAME,
  sessionResponseSchema,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, tenantB, testConfig } from './harness';

/**
 * The admin surface over real HTTP.
 *
 * Driven through Fastify's `inject`, so no port is bound. What matters here is
 * the seam: that an unauthenticated call is refused, that an AUTHENTICATED but
 * unprivileged call is refused just as firmly, and that the responses match the
 * frozen schemas the web admin parses with.
 */

const ORIGIN = 'https://admin.example.test';

describe('admin HTTP surface', () => {
  let api: ApiApp;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  });

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    // The tenant is resolved at boot; re-seeding replaces the rows, so the
    // installation tenant is re-resolved to match.
    api.container.setInstallationTenant(tenantA.tenantId);

    await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    await createAdmin(api.container, tenantA, {
      username: 'support',
      password: 'the-support-password',
      roleKeys: ['support'],
    });
  });

  async function login(username: string, password: string) {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password },
    });
    return response;
  }

  /**
   * The session, as a browser gets it: out of the Set-Cookie header.
   *
   * The login body deliberately carries no credential, so there is nowhere else
   * to read it from — which is the property under test.
   */
  function sessionCookieFrom(response: { headers: Record<string, unknown> }): string {
    const header = String(response.headers['set-cookie'] ?? '');
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(header);
    if (match === null) throw new Error('No session cookie was set.');
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  async function cookieFor(username: string, password: string): Promise<string> {
    return sessionCookieFrom(await login(username, password));
  }

  /** An authenticated request as the browser makes it: cookie plus Origin. */
  const asAdmin = (cookie: string) => ({ cookie, origin: ORIGIN });

  describe('login', () => {
    it('returns a session matching the frozen schema', async () => {
      const response = await login('owner', 'the-owners-real-password');
      expect(response.statusCode).toBe(201);

      const body = loginResponseSchema.parse(response.json());
      expect(body.admin.username).toBe('owner');
      expect(body.permissions).toContain('admins.edit');
      // The response carries no password material of any kind.
      expect(JSON.stringify(body)).not.toContain('the-owners-real-password');
      expect('token' in body).toBe(false);
    });

    it('returns no session credential in the body', async () => {
      // The whole point of HttpOnly. If the same token also arrives as JSON,
      // any script on the page can read it by calling login again, and the
      // cookie flag has bought nothing.
      const response = await login('owner', 'the-owners-real-password');
      const raw = response.body;
      const body = JSON.parse(raw) as Record<string, unknown>;

      expect(body).not.toHaveProperty('token');
      expect(body).not.toHaveProperty('sessionToken');
      expect(body).not.toHaveProperty('sessionId');
      expect(Object.keys(body).sort()).toEqual(['admin', 'expiresAt', 'permissions']);

      // And the cookie's token appears nowhere in the payload, under any key.
      const cookieToken = decodeURIComponent(
        sessionCookieFrom(response).slice(`${SESSION_COOKIE_NAME}=`.length),
      );
      expect(raw).not.toContain(cookieToken);
      // The stored form must not leak either.
      expect(raw).not.toContain(createHash('sha256').update(cookieToken, 'utf8').digest('hex'));
    });

    it('sets an httpOnly, SameSite=Strict session cookie', async () => {
      const response = await login('owner', 'the-owners-real-password');
      const cookie = String(response.headers['set-cookie']);

      expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
      expect(cookie).toContain('HttpOnly');
      // Strict rather than Lax: this cookie authorises administrative writes.
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/');
    });

    it('answers 401 with one generic message for any bad credential', async () => {
      for (const [username, password] of [
        ['owner', 'wrong-password'],
        ['nobody', 'wrong-password'],
      ] as const) {
        const response = await login(username, password);
        expect(response.statusCode).toBe(401);
        const body = response.json() as { error: { message: string; code: string } };
        expect(body.error.code).toBe('auth.invalid_credentials');
        expect(body.error.message).toBe('The username or password is incorrect.');
      }
    });

    it('rejects a malformed payload as a validation error, not a 500', async () => {
      const response = await inject({
        method: 'POST',
        url: `${API_PREFIX}${AUTH_ROUTES.login}`,
        headers: { origin: ORIGIN },
        payload: { username: 12345 },
      });
      expect(response.statusCode).toBe(400);
      expect((response.json() as { error: { kind: string } }).error.kind).toBe('VALIDATION');
    });
  });

  describe('unauthenticated calls', () => {
    it('refuses every admin endpoint with 401', async () => {
      const calls = [
        { method: 'GET', url: `${API_PREFIX}${ADMIN_ROUTES.list}` },
        { method: 'GET', url: `${API_PREFIX}${ADMIN_ROUTES.rolesCatalog}` },
        { method: 'GET', url: `${API_PREFIX}${AUTH_ROUTES.session}` },
        {
          method: 'POST',
          url: `${API_PREFIX}${ADMIN_ROUTES.create}`,
          headers: { origin: ORIGIN },
          payload: {
            username: 'intruder',
            displayName: 'Intruder',
            password: 'a-perfectly-fine-password',
            roleKeys: ['owner'],
          },
        },
      ];

      for (const call of calls) {
        const response = await inject(call);
        expect(response.statusCode).toBe(401);
      }
    });

    it('answers 401, not 500, for a malformed cookie value', async () => {
      // `decodeURIComponent('%')` throws. An unhandled throw here would turn a
      // rejected credential into a server error — a worse answer, and one that
      // says a client-controlled header reaches the error path.
      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${ADMIN_ROUTES.list}`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=%` },
      });
      expect(response.statusCode).toBe(401);
    });

    it('takes the first of duplicate session cookies', async () => {
      const cookie = await cookieFor('owner', 'the-owners-real-password');
      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${AUTH_ROUTES.session}`,
        headers: { cookie: `${cookie}; ${SESSION_COOKIE_NAME}=${'z'.repeat(43)}` },
      });
      expect(response.statusCode).toBe(200);
    });

    it('refuses a forged session cookie', async () => {
      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${ADMIN_ROUTES.list}`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${'x'.repeat(43)}` },
      });
      expect(response.statusCode).toBe(401);
    });

    it('does not accept a bearer token, even a real session’s', async () => {
      // The cookie is the only transport. Bearer was removed with the token
      // from the login body: nothing can obtain one to present, so accepting
      // the header would be a way in that no legitimate client can use.
      const cookie = await cookieFor('owner', 'the-owners-real-password');
      const rawToken = cookie.slice(`${SESSION_COOKIE_NAME}=`.length);

      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${ADMIN_ROUTES.list}`,
        headers: { authorization: `Bearer ${decodeURIComponent(rawToken)}` },
      });
      expect(response.statusCode).toBe(401);
    });

    it('creates no administrator as a side effect of a refused call', async () => {
      await inject({
        method: 'POST',
        url: `${API_PREFIX}${ADMIN_ROUTES.create}`,
        headers: { origin: ORIGIN },
        payload: {
          username: 'intruder',
          displayName: 'Intruder',
          password: 'a-perfectly-fine-password',
          roleKeys: ['owner'],
        },
      });
      expect(await api.container.admins.findCredentialsByUsername(tenantA, 'intruder')).toBeNull();
    });
  });

  describe('authenticated but unauthorized calls', () => {
    it('refuses with 403, not 401 — the caller is known, just not permitted', async () => {
      const cookie = await cookieFor('support', 'the-support-password');

      const response = await inject({
        method: 'POST',
        url: `${API_PREFIX}${ADMIN_ROUTES.create}`,
        headers: asAdmin(cookie),
        payload: {
          username: 'newcomer',
          displayName: 'Newcomer',
          password: 'a-perfectly-fine-password',
          roleKeys: ['support'],
        },
      });

      expect(response.statusCode).toBe(403);
      expect((response.json() as { error: { kind: string } }).error.kind).toBe('PERMISSION_DENIED');
      expect(await api.container.admins.findCredentialsByUsername(tenantA, 'newcomer')).toBeNull();
    });

    it('records the denial on create even when the body is nonsense', async () => {
      /*
       * `create` was the odd arm of its own file.
       *
       * `setStatus` and `setRoles` both authorize and then parse; only
       * `create` was inverted — the one that mints a NEW CREDENTIAL with roles
       * attached, "the most privileged act on this surface" by its own
       * comment. A `ZodError` is a 400 that never reaches the guard, so an
       * authenticated caller without `admins.edit` who posted `{nonsense}` was
       * answered 400 and left NO `access.permission_denied` and NO DENIED
       * audit row, where the same caller posting a well-formed body left both.
       *
       * The round before this one moved the five panel writes for exactly this
       * reason and stated in three documents that the panel service was "the
       * last to follow a rule the others kept". It was not: this was, in the
       * module with the highest blast radius, in a file that already did it
       * correctly twice.
       */
      const cookie = await cookieFor('support', 'the-support-password');
      /*
       * BOTH ledgers, because one cannot see the other's recorder disappear.
       *
       * The first version of this test counted only the audit rows while its
       * own docblock and commit message claimed "+1 and +1" — and deleting
       * `permission-guard`'s operational-event write left it fully green. The
       * sibling panel test was rewritten in the same commit for exactly that
       * reason and this one was written to the older standard.
       */
      const counts = async (): Promise<{ audit: number; events: number }> => {
        const rows = await api.container.database.db.execute(
          sql`SELECT
                (SELECT count(*)::int FROM audit_logs WHERE after ? 'deniedPermission') AS audit,
                (SELECT count(*)::int FROM operational_events
                  WHERE code = 'access.permission_denied') AS events`,
        );
        const row = rows.rows[0] as { audit: number; events: number };
        return { audit: Number(row.audit), events: Number(row.events) };
      };
      const send = (payload: unknown) =>
        inject({
          method: 'POST',
          url: `${API_PREFIX}${ADMIN_ROUTES.create}`,
          headers: asAdmin(cookie),
          payload,
        });

      const beforeBad = await counts();
      expect((await send({ nonsense: true })).statusCode, 'a malformed body').toBe(403);
      const afterBad = await counts();
      const bad = afterBad.audit - beforeBad.audit;
      const badEvents = afterBad.events - beforeBad.events;

      const beforeGood = await counts();
      expect(
        (
          await send({
            username: 'newcomer2',
            displayName: 'Newcomer Two',
            password: 'a-perfectly-fine-password',
            roleKeys: ['support'],
          })
        ).statusCode,
        'a well-formed body',
      ).toBe(403);
      const afterGood = await counts();
      const good = afterGood.audit - beforeGood.audit;
      const goodEvents = afterGood.events - beforeGood.events;

      // EXACT, and one and one, for each of the two single requests above.
      // The floor these replace (`toBeGreaterThan(0)` plus bad === good) could
      // not see a doubled event — both requests doubled alike — which is how
      // OQ-3D-03 hid behind this test as well. Identity's early refusal is
      // `assertMayAttempt` (audit row only) plus the guard's own event, so it
      // was one and one already; pinned so a change to either recorder
      // cannot double it or drop it unnoticed.
      expect(bad, 'DENIED audit rows for ONE malformed denial').toBe(1);
      expect(badEvents, 'operational events for ONE malformed denial').toBe(1);
      expect(good, 'DENIED audit rows for ONE well-formed denial').toBe(1);
      expect(goodEvents, 'operational events for ONE well-formed denial').toBe(1);
      // And no administrator was created by either.
      expect(await api.container.admins.findCredentialsByUsername(tenantA, 'newcomer2')).toBeNull();
    });

    it('refuses reading the admin list without admins.view', async () => {
      const cookie = await cookieFor('support', 'the-support-password');
      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${ADMIN_ROUTES.list}`,
        headers: asAdmin(cookie),
      });
      expect(response.statusCode).toBe(403);
    });

    it('permits the same call for an owner', async () => {
      const cookie = await cookieFor('owner', 'the-owners-real-password');
      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${ADMIN_ROUTES.list}`,
        headers: asAdmin(cookie),
      });

      expect(response.statusCode).toBe(200);
      const body = adminListResponseSchema.parse(response.json());
      expect(body.admins.map((admin) => admin.username).sort()).toEqual(['owner', 'support']);
      // The list carries no credential material.
      expect(JSON.stringify(body)).not.toContain('scrypt$');
    });
  });

  describe('session lifecycle', () => {
    it('describes the signed-in administrator', async () => {
      const cookie = await cookieFor('support', 'the-support-password');
      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${AUTH_ROUTES.session}`,
        headers: asAdmin(cookie),
      });

      expect(response.statusCode).toBe(200);
      const body = sessionResponseSchema.parse(response.json());
      expect(body.admin.username).toBe('support');
      expect(body.permissions).not.toContain('admins.edit');
    });

    it('stops accepting the token after logout, and clears the cookie', async () => {
      const cookie = await cookieFor('owner', 'the-owners-real-password');

      const logout = await inject({
        method: 'POST',
        url: `${API_PREFIX}${AUTH_ROUTES.logout}`,
        headers: asAdmin(cookie),
      });
      expect(logout.statusCode).toBe(201);
      expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');

      const after = await inject({
        method: 'GET',
        url: `${API_PREFIX}${AUTH_ROUTES.session}`,
        headers: asAdmin(cookie),
      });
      expect(after.statusCode).toBe(401);
    });

    it('clears the cookie after a password change, and the session is dead', async () => {
      const cookie = await cookieFor('support', 'the-support-password');

      const changed = await inject({
        method: 'POST',
        url: `${API_PREFIX}${AUTH_ROUTES.password}`,
        headers: asAdmin(cookie),
        payload: {
          currentPassword: 'the-support-password',
          newPassword: 'an-entirely-different-password',
        },
      });
      expect(changed.statusCode).toBe(201);
      // Not the revocation — that committed with the password. This stops the
      // browser presenting a credential the server will now refuse.
      expect(String(changed.headers['set-cookie'])).toContain('Max-Age=0');

      const after = await inject({
        method: 'GET',
        url: `${API_PREFIX}${AUTH_ROUTES.session}`,
        headers: { cookie },
      });
      expect(after.statusCode).toBe(401);

      // And the new password works.
      const again = await login('support', 'an-entirely-different-password');
      expect(again.statusCode).toBe(201);
    });

    it('authenticates from the cookie alone', async () => {
      const cookie = await cookieFor('owner', 'the-owners-real-password');
      const withCookie = await inject({
        method: 'GET',
        url: `${API_PREFIX}${AUTH_ROUTES.session}`,
        headers: { cookie },
      });
      expect(withCookie.statusCode).toBe(200);
    });
  });

  describe('CSRF defence', () => {
    it('refuses a cookie-authenticated write from an unlisted origin', async () => {
      // SameSite is enforced by the browser; the Origin check does not depend
      // on the browser behaving.
      const cookie = await cookieFor('owner', 'the-owners-real-password');

      const forged = await inject({
        method: 'POST',
        url: `${API_PREFIX}${ADMIN_ROUTES.create}`,
        headers: { cookie, origin: 'https://evil.example.test' },
        payload: {
          username: 'newcomer',
          displayName: 'Newcomer',
          password: 'a-perfectly-fine-password',
          roleKeys: ['support'],
        },
      });

      expect(forged.statusCode).toBe(403);
      expect(await api.container.admins.findCredentialsByUsername(tenantA, 'newcomer')).toBeNull();
    });

    it('refuses a write with no Origin at all', async () => {
      // Fails closed. An absent Origin is not evidence of a same-origin caller.
      const cookie = await cookieFor('owner', 'the-owners-real-password');
      const response = await inject({
        method: 'POST',
        url: `${API_PREFIX}${ADMIN_ROUTES.create}`,
        headers: { cookie },
        payload: {
          username: 'newcomer',
          displayName: 'Newcomer',
          password: 'a-perfectly-fine-password',
          roleKeys: ['support'],
        },
      });
      expect(response.statusCode).toBe(403);
    });

    it('permits the same write from the configured origin', async () => {
      const cookie = await cookieFor('owner', 'the-owners-real-password');
      const response = await inject({
        method: 'POST',
        url: `${API_PREFIX}${ADMIN_ROUTES.create}`,
        headers: asAdmin(cookie),
        payload: {
          username: 'newcomer',
          displayName: 'Newcomer',
          password: 'a-perfectly-fine-password',
          roleKeys: ['support'],
        },
      });
      expect(response.statusCode).toBe(201);
    });
  });

  describe('security headers', () => {
    it('sets them on an admin response', async () => {
      const cookie = await cookieFor('owner', 'the-owners-real-password');
      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${ADMIN_ROUTES.rolesCatalog}`,
        headers: asAdmin(cookie),
      });

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(String(response.headers['content-security-policy'])).toContain("default-src 'none'");
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      // An authenticated response must not sit in a shared or back-forward cache.
      expect(String(response.headers['cache-control'])).toContain('no-store');
    });

    it('omits HSTS outside production', async () => {
      // Sending it from a plain-HTTP dev server would pin a developer's browser
      // to HTTPS on localhost.
      const response = await inject({ method: 'GET', url: '/health/live' });
      expect(response.headers['strict-transport-security']).toBeUndefined();
    });

    it('returns the role catalog in the frozen shape', async () => {
      const cookie = await cookieFor('owner', 'the-owners-real-password');
      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${ADMIN_ROUTES.rolesCatalog}`,
        headers: asAdmin(cookie),
      });
      const body = roleListResponseSchema.parse(response.json());
      expect(body.roles.some((role) => role.key === 'owner' && role.isSystem)).toBe(true);
    });
  });

  describe('the Telegram binding', () => {
    /*
     * Web Admin → System → Administrators, over HTTP.
     *
     * This route exists because an installation can already hold an owner with
     * no binding — v0.2.5 created them that way — and the only other way to bind
     * an administrator, the bot's `/link`, has to be sent by an administrator who
     * is already bound. Every rule below is `setTelegramBinding`'s, reached
     * through the controller: authentication, tenant scope from the session,
     * the escalation gates, uniqueness, the audit row, origin protection.
     */
    const bindingOf = async (id: string): Promise<string | null> => {
      const rows = await api.container.database.db.execute<{ telegram_user_id: string | null }>(
        sql`SELECT telegram_user_id FROM admins WHERE id = ${id}`,
      );
      return rows.rows[0]?.telegram_user_id ?? null;
    };
    const bindingAudits = async () =>
      (
        await api.container.database.db.execute<{
          entity_id: string;
          before: unknown;
          after: unknown;
          result: string;
          reason: string | null;
        }>(
          sql`SELECT entity_id, before, after, result, reason FROM audit_logs
               WHERE action = 'admin.telegram_binding' ORDER BY occurred_at ASC, id ASC`,
        )
      ).rows;
    const idOf = async (username: string): Promise<string> => {
      const rows = await api.container.database.db.execute<{ id: string }>(
        sql`SELECT id FROM admins WHERE username = ${username} AND tenant_id = ${tenantA.tenantId}`,
      );
      const id = rows.rows[0]?.id;
      if (id === undefined) throw new Error(`no administrator ${username}`);
      return id;
    };
    const bind = (
      cookie: string,
      id: string,
      telegramUserId: string | null,
      reason = 'staging owner',
    ) =>
      inject({
        method: 'POST',
        url: `${API_PREFIX}${ADMIN_ROUTES.telegram(id)}`,
        headers: asAdmin(cookie),
        payload: { telegramUserId, reason },
      });

    it('connects an existing unbound owner, then replaces and removes the binding', async () => {
      // A second owner, unbound — the v0.2.5 state — connected by the first.
      // Binding an OWNER takes `admins.permissions.edit` as well, which the
      // signed-in owner holds.
      await createAdmin(api.container, tenantA, { username: 'unbound-owner', roleKeys: ['owner'] });
      const target = await idOf('unbound-owner');
      expect(await bindingOf(target)).toBeNull();
      const cookie = await cookieFor('owner', 'the-owners-real-password');

      const connected = await bind(cookie, target, '123456789');
      expect(connected.statusCode).toBe(201);
      expect(connected.json()).toMatchObject({ id: target, telegramUserId: '123456789' });
      expect(await bindingOf(target)).toBe('123456789');

      // And the binding is LIVE on the next Telegram update: the resolver
      // names the owner, with the owner's permissions, and no restart.
      const resolved = await api.container.telegramAdmins.resolve(
        tenantA,
        '123456789',
        'binding-http' as never,
      );
      expect(resolved?.admin.id).toBe(target);
      expect(resolved?.permissions.has('receipts.review' as never)).toBe(true);

      const replaced = await bind(cookie, target, '987654321', 'new phone');
      expect(replaced.statusCode).toBe(201);
      expect(await bindingOf(target)).toBe('987654321');
      expect(
        await api.container.telegramAdmins.resolve(tenantA, '123456789', 'binding-http' as never),
      ).toBeNull();

      const removed = await bind(cookie, target, null, 'left the company');
      expect(removed.statusCode).toBe(201);
      expect(removed.json()).toMatchObject({ id: target, telegramUserId: null });
      expect(await bindingOf(target)).toBeNull();
      // Revocation takes effect on the next update — there is no cached authority.
      expect(
        await api.container.telegramAdmins.resolve(tenantA, '987654321', 'binding-http' as never),
      ).toBeNull();
      // The account and its roles are untouched: only the channel was removed.
      expect(await api.container.admins.roleKeysFor(tenantA, target as never)).toEqual(['owner']);
    });

    it('records the audit row with the id before and after, and the reason', async () => {
      await createAdmin(api.container, tenantA, { username: 'audited', roleKeys: ['support'] });
      const target = await idOf('audited');
      const cookie = await cookieFor('owner', 'the-owners-real-password');

      expect((await bind(cookie, target, '555000111', 'first phone')).statusCode).toBe(201);
      expect((await bind(cookie, target, '555000222', 'second phone')).statusCode).toBe(201);
      expect((await bind(cookie, target, null, 'gone')).statusCode).toBe(201);

      const audits = (await bindingAudits()).filter((row) => row.entity_id === target);
      expect(audits.map((row) => [row.before, row.after, row.reason, row.result])).toEqual([
        [{ telegramUserId: null }, { telegramUserId: '555000111' }, 'first phone', 'SUCCESS'],
        [
          { telegramUserId: '555000111' },
          { telegramUserId: '555000222' },
          'second phone',
          'SUCCESS',
        ],
        [{ telegramUserId: '555000222' }, { telegramUserId: null }, 'gone', 'SUCCESS'],
      ]);
    });

    it('refuses a duplicate binding as a conflict, not a 500, and changes nothing', async () => {
      await createAdmin(api.container, tenantA, {
        username: 'already-bound',
        roleKeys: ['support'],
        telegramUserId: '777000111',
      });
      await createAdmin(api.container, tenantA, {
        username: 'wants-it-too',
        roleKeys: ['support'],
      });
      const target = await idOf('wants-it-too');
      const cookie = await cookieFor('owner', 'the-owners-real-password');

      const refused = await bind(cookie, target, '777000111');
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: { code: 'admin.telegram_id_taken' } });
      expect(await bindingOf(target)).toBeNull();
      expect(await bindingOf(await idOf('already-bound'))).toBe('777000111');
    });

    it('refuses a malformed id as a validation error, before the row is touched', async () => {
      await createAdmin(api.container, tenantA, { username: 'malformed', roleKeys: ['support'] });
      const target = await idOf('malformed');
      const cookie = await cookieFor('owner', 'the-owners-real-password');
      for (const bad of ['mamad', '@mamad', '-5', '12 34', '0123', '']) {
        const refused = await bind(cookie, target, bad);
        expect(refused.statusCode, `"${bad}" was not refused`).toBe(400);
      }
      expect(await bindingOf(target)).toBeNull();
      expect(await bindingAudits()).toHaveLength(0);
    });

    it('refuses an unauthorized caller with 403, and a caller from another tenant with 404', async () => {
      await createAdmin(api.container, tenantA, { username: 'target-a', roleKeys: ['support'] });
      const target = await idOf('target-a');

      // `support` holds no `admins.edit`: refused, recorded, nothing written.
      const support = await cookieFor('support', 'the-support-password');
      const denied = await bind(support, target, '123456789');
      expect(denied.statusCode).toBe(403);
      expect(await bindingOf(target)).toBeNull();

      // An owner of tenant B, signed in through the same API, cannot reach a
      // tenant A administrator: the scope is the SESSION's, and the target is
      // simply not found in it.
      await createAdmin(api.container, tenantB, {
        username: 'owner-b',
        password: 'the-owner-b-password',
        roleKeys: ['owner'],
      });
      api.container.setInstallationTenant(tenantB.tenantId);
      let crossTenant;
      try {
        const cookieB = await cookieFor('owner-b', 'the-owner-b-password');
        crossTenant = await bind(cookieB, target, '123456789');
      } finally {
        api.container.setInstallationTenant(tenantA.tenantId);
      }
      expect(crossTenant.statusCode).toBe(404);
      expect(await bindingOf(target)).toBeNull();
      expect((await bindingAudits()).filter((row) => row.result === 'SUCCESS')).toHaveLength(0);
    });

    it('resets another administrator\u2019s password, ends their sessions, and leaks nothing', async () => {
      await createAdmin(api.container, tenantA, {
        username: 'forgetful',
        password: 'the-forgetful-password',
        roleKeys: ['support'],
      });
      const target = await idOf('forgetful');

      // Two live sessions for the target, so "revoked" is a COUNT and not a
      // boolean wearing a number.
      const theirs = await cookieFor('forgetful', 'the-forgetful-password');
      await cookieFor('forgetful', 'the-forgetful-password');
      const owner = await cookieFor('owner', 'the-owners-real-password');

      const listed = await inject({
        method: 'GET',
        url: `${API_PREFIX}${ADMIN_ROUTES.sessions(target)}`,
        headers: asAdmin(owner),
      });
      expect(listed.statusCode).toBe(200);
      const sessions = adminSessionListResponseSchema.parse(listed.json()).sessions;
      expect(sessions).toHaveLength(2);
      /*
       * The RAW body, not the parsed one. A zod object strips keys it does not
       * declare, so asserting on the parse result would prove only that the
       * schema is narrow — and a mutation that added `token_hash` to the
       * repository projection survived exactly that assertion. What reaches a
       * browser is what the controller returned, which is this string.
       *
       * Not the token, not a hash of it, not a masked stand-in: `********` can
       * be resubmitted, and a hash is the thing a session cookie is compared
       * against.
       */
      expect(listed.body).not.toMatch(/token|hash|secret/i);
      // And none of them is the OWNER's own session, which is a different
      // administrator's and not this route's to show.
      expect(sessions.every((one) => !one.current)).toBe(true);

      const reset = await inject({
        method: 'POST',
        url: `${API_PREFIX}${ADMIN_ROUTES.password(target)}`,
        headers: asAdmin(owner),
        payload: { newPassword: 'a-brand-new-password', reason: 'they forgot it' },
      });
      expect(reset.statusCode).toBe(201);
      const body = reset.json();
      expect(body).toMatchObject({ sessionsRevoked: 2, admin: { id: target } });
      // The RESPONSE carries no credential either — not the password that was
      // just set, not a hash, not a confirmation of what it was set to.
      expect(JSON.stringify(body)).not.toMatch(/a-brand-new-password|hash|password_hash/);

      // The old sessions are dead, the old password is dead, the new one works.
      const stale = await inject({
        method: 'GET',
        url: `${API_PREFIX}${ADMIN_ROUTES.list}`,
        headers: asAdmin(theirs),
      });
      expect(stale.statusCode).toBe(401);
      expect((await login('forgetful', 'the-forgetful-password')).statusCode).toBe(401);
      expect((await login('forgetful', 'a-brand-new-password')).statusCode).toBe(201);

      // The audit row records that a rotation happened and NOT what it was to.
      const rows = await api.container.database.db.execute<{ after: unknown }>(
        sql`SELECT after FROM audit_logs
            WHERE action = 'admin.password_reset' AND entity_id = ${target} AND result = 'SUCCESS'`,
      );
      expect(rows.rows).toHaveLength(1);
      /*
       * And the DOMAIN EVENT, which is not the audit row and not a substitute
       * for it (ADR-0006). `AdminPasswordChanged`'s frozen payload has carried
       * `bySelf` since Phase 1 — the contract anticipated an operator path
       * before one existed — and writing only the audit row left every outbox
       * consumer unable to see that this credential changed at all.
       */
      const events = await api.container.database.db.execute<{ payload: { bySelf: boolean } }>(
        sql`SELECT payload FROM outbox_messages
            WHERE event_type = 'AdminPasswordChanged' AND aggregate_id = ${target}`,
      );
      expect(events.rows.map((row) => row.payload)).toEqual([{ bySelf: false }]);
      /*
       * `rotated` and `endedSignIns`, NOT `passwordRotated` and
       * `sessionsRevoked`. The audit writer redacts any key containing
       * `password` or `session`, so the obvious names wrote `[redacted]` twice
       * and the row lost both facts it carries. This assertion is what caught
       * that, and pinning the KEYS is what stops the next rename undoing it.
       */
      expect(rows.rows[0]?.after).toEqual({ rotated: true, endedSignIns: 2 });
    });

    it('refuses a reset of the caller\u2019s own password, and one by an unprivileged caller', async () => {
      const ownerId = await idOf('owner');
      const owner = await cookieFor('owner', 'the-owners-real-password');

      // Self-service rotation takes the CURRENT password, and that proof is the
      // whole of its security. This route does not ask for one, so it must not
      // be a way around it.
      const self = await inject({
        method: 'POST',
        url: `${API_PREFIX}${ADMIN_ROUTES.password(ownerId)}`,
        headers: asAdmin(owner),
        payload: { newPassword: 'no-current-password-needed', reason: 'shortcut' },
      });
      // 409, the same answer every other self-modification refusal gives: the
      // caller is permitted and the TARGET is the problem, which is a conflict
      // rather than a denial.
      expect(self.statusCode).toBe(409);
      expect((await login('owner', 'the-owners-real-password')).statusCode).toBe(201);

      await createAdmin(api.container, tenantA, {
        username: 'reset-target',
        roleKeys: ['support'],
      });
      const target = await idOf('reset-target');
      const support = await cookieFor('support', 'the-support-password');
      const denied = await inject({
        method: 'POST',
        url: `${API_PREFIX}${ADMIN_ROUTES.password(target)}`,
        headers: asAdmin(support),
        payload: { newPassword: 'not-yours-to-set', reason: 'escalation' },
      });
      expect(denied.statusCode).toBe(403);

      // Reading somebody's sessions is a read, and takes `admins.view` — which
      // `support` does not hold either.
      expect(
        (
          await inject({
            method: 'GET',
            url: `${API_PREFIX}${ADMIN_ROUTES.sessions(target)}`,
            headers: asAdmin(support),
          })
        ).statusCode,
      ).toBe(403);

      // Nothing was written by either refusal.
      expect(
        (
          await api.container.database.db.execute(
            sql`SELECT 1 FROM audit_logs WHERE action = 'admin.password_reset' AND result = 'SUCCESS'`,
          )
        ).rows,
      ).toHaveLength(0);
    });

    it('counts only LIVE sessions as ended, never expired rows it also owns', async () => {
      /*
       * The number the operator acts on.
       *
       * Sessions are retained after they expire, so an account accumulates
       * unrevoked-but-dead rows. `revokeAllForAdmin` used to update and count
       * those, while `listForAdmin` filtered them out — so one screen could
       * show no live sessions above a message claiming several were ended, and
       * an operator asking "is that person still signed in" got a yes from a
       * row that expired last week.
       */
      await createAdmin(api.container, tenantA, {
        username: 'long-history',
        password: 'the-history-password',
        roleKeys: ['support'],
      });
      const target = await idOf('long-history');
      await cookieFor('long-history', 'the-history-password');

      // Three rows that are unrevoked and long dead, beside the one live one.
      await api.container.database.db.execute(sql`
        INSERT INTO admin_sessions (id, tenant_id, admin_id, token_hash, issued_at, expires_at, last_seen_at)
        SELECT gen_random_uuid(), ${tenantA.tenantId}, ${target},
               md5(n::text || 'expired-session-fixture'),
               now() - interval '40 days', now() - interval '39 days', now() - interval '39 days'
        FROM generate_series(1, 3) AS n`);

      const owner = await cookieFor('owner', 'the-owners-real-password');
      const listed = await inject({
        method: 'GET',
        url: `${API_PREFIX}${ADMIN_ROUTES.sessions(target)}`,
        headers: asAdmin(owner),
      });
      expect(adminSessionListResponseSchema.parse(listed.json()).sessions).toHaveLength(1);

      const revoked = await inject({
        method: 'POST',
        url: `${API_PREFIX}${ADMIN_ROUTES.revokeSessions(target)}`,
        headers: asAdmin(owner),
        payload: { reason: 'lost laptop' },
      });
      expect(revoked.json(), 'the count included sessions that had already expired').toEqual({
        revoked: 1,
      });

      // And the expired rows were left alone rather than stamped as revoked,
      // which would be a false record: they were not revoked, they ran out.
      const stale = await api.container.database.db.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM admin_sessions
        WHERE admin_id = ${target} AND revoked_at IS NULL AND expires_at <= now()`);
      expect(stale.rows[0]?.n).toBe('3');
    });

    it('answers a RETRIED creation with the administrator the first attempt made', async () => {
      /*
       * `mutations.retry` re-sends a write the server did not answer. Create has
       * no natural no-op, so without a key the retry finds the username taken
       * and the operator is told the creation FAILED — for an account that
       * exists holding the credential they just chose.
       */
      const owner = await cookieFor('owner', 'the-owners-real-password');
      const body = {
        username: 'retried-admin',
        displayName: 'Retried',
        password: 'the-retried-password',
        roleKeys: ['support'],
        idempotencyKey: 'create-retry-0001',
      };
      const create = (payload: Record<string, unknown>) =>
        inject({
          method: 'POST',
          url: `${API_PREFIX}${ADMIN_ROUTES.create}`,
          headers: asAdmin(owner),
          payload,
        });

      const first = await create(body);
      expect(first.statusCode).toBe(201);
      const id = (first.json() as { id: string }).id;

      const retry = await create(body);
      expect(retry.statusCode, 'the retry was reported as a failure').toBe(201);
      expect((retry.json() as { id: string }).id).toBe(id);

      // ONE administrator, not two, and one audit row.
      const rows = await api.container.database.db.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM admins
        WHERE tenant_id = ${tenantA.tenantId} AND username = 'retried-admin'`);
      expect(rows.rows[0]?.n).toBe('1');

      // A DIFFERENT administrator under the same key is a caller bug and is
      // refused as a payload mismatch rather than answered with the first one.
      const reused = await create({ ...body, username: 'someone-else' });
      expect(reused.statusCode).toBe(409);
      expect(await api.container.admins.findByUsername(tenantA, 'someone-else')).toBeNull();
    });

    it('refuses a reset that would hand the caller authority they do not hold', async () => {
      /*
       * `admins.edit` is not enough, and this is the case that says why.
       *
       * Setting somebody\u2019s password is TAKING THEIR ACCOUNT: whoever does it can
       * sign in as them afterwards. So it is bound by the same question as
       * re-enabling a disabled administrator \u2014 "may you BECOME this one" \u2014 and an
       * actor holding `admins.edit` but not what the target holds is refused.
       *
       * Without that bound this route is the escalation path `UNK-ADM-005` names,
       * reached with a permission the Mirza research found every one of its four
       * production administrators holding. The mutation that removed the bound
       * survived every other case in this file, which is why this one exists.
       */
      await createAdmin(api.container, tenantA, {
        username: 'roster-manager',
        password: 'the-manager-password',
        roleKeys: ['support'],
      });
      await createAdmin(api.container, tenantA, {
        username: 'better-armed',
        password: 'the-armed-password',
        roleKeys: ['support'],
      });
      const manager = await idOf('roster-manager');
      const target = await idOf('better-armed');
      await api.container.database.db.execute(sql`
        INSERT INTO admin_permission_overrides (tenant_id, admin_id, permission_key, effect, reason)
        VALUES
          (${tenantA.tenantId}, ${manager}, 'admins.edit', 'GRANT', 'Administers the roster.'),
          (${tenantA.tenantId}, ${target}, 'backup.run', 'GRANT', 'Runs the backups.')`);

      const cookie = await cookieFor('roster-manager', 'the-manager-password');
      const refused = await inject({
        method: 'POST',
        url: `${API_PREFIX}${ADMIN_ROUTES.password(target)}`,
        headers: asAdmin(cookie),
        payload: { newPassword: 'becoming-somebody-else', reason: 'escalation' },
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({
        error: { code: 'admin.privilege_escalation_denied' },
      });

      // Nothing was taken: the old password still works and the account is theirs.
      expect((await login('better-armed', 'the-armed-password')).statusCode).toBe(201);
      expect((await login('better-armed', 'becoming-somebody-else')).statusCode).toBe(401);

      // The NEGATIVE half. The same manager may reset an administrator who holds
      // nothing they do not, so the rule above is a bound and not a blanket ban
      // that a test would be satisfied by either way.
      await createAdmin(api.container, tenantA, {
        username: 'equally-armed',
        password: 'the-equal-password',
        roleKeys: ['support'],
      });
      const peer = await idOf('equally-armed');
      const allowed = await inject({
        method: 'POST',
        url: `${API_PREFIX}${ADMIN_ROUTES.password(peer)}`,
        headers: asAdmin(cookie),
        payload: { newPassword: 'a-legitimate-reset', reason: 'they forgot it' },
      });
      expect(allowed.statusCode).toBe(201);
      expect((await login('equally-armed', 'a-legitimate-reset')).statusCode).toBe(201);
    });

    it('revokes sessions without touching the password, and lets an actor end their own', async () => {
      await createAdmin(api.container, tenantA, {
        username: 'revokable',
        password: 'the-revokable-password',
        roleKeys: ['support'],
      });
      const target = await idOf('revokable');
      const theirs = await cookieFor('revokable', 'the-revokable-password');
      const owner = await cookieFor('owner', 'the-owners-real-password');

      const revoked = await inject({
        method: 'POST',
        url: `${API_PREFIX}${ADMIN_ROUTES.revokeSessions(target)}`,
        headers: asAdmin(owner),
        payload: { reason: 'lost laptop' },
      });
      expect(revoked.statusCode).toBe(201);
      expect(revoked.json()).toEqual({ revoked: 1 });

      // The session is gone.
      expect(
        (
          await inject({
            method: 'GET',
            url: `${API_PREFIX}${ADMIN_ROUTES.list}`,
            headers: asAdmin(theirs),
          })
        ).statusCode,
      ).toBe(401);

      // A second call finds nothing left, and says zero rather than failing.
      // Checked BEFORE the password is exercised: signing in again would create
      // a session, and this assertion would then be measuring the test.
      expect(
        (
          await inject({
            method: 'POST',
            url: `${API_PREFIX}${ADMIN_ROUTES.revokeSessions(target)}`,
            headers: asAdmin(owner),
            payload: { reason: 'again' },
          })
        ).json(),
      ).toEqual({ revoked: 0 });

      // And the PASSWORD is untouched: this is not a reset.
      expect((await login('revokable', 'the-revokable-password')).statusCode).toBe(201);

      /*
       * Revoking your OWN sessions is allowed, and is the one place this
       * differs from the password route. Signing every device out is something
       * an administrator may do to themselves — it takes authority AWAY, so the
       * self-modification refusal that protects an account from its holder does
       * not apply. The call ends the very session making it, which is why the
       * response is checked before the cookie is used again.
       */
      const ownerId = await idOf('owner');
      const own = await inject({
        method: 'POST',
        url: `${API_PREFIX}${ADMIN_ROUTES.revokeSessions(ownerId)}`,
        headers: asAdmin(owner),
        payload: { reason: 'signing out everywhere' },
      });
      expect(own.statusCode).toBe(201);
      expect(
        (
          await inject({
            method: 'GET',
            url: `${API_PREFIX}${ADMIN_ROUTES.list}`,
            headers: asAdmin(owner),
          })
        ).statusCode,
      ).toBe(401);
    });

    it('refuses a REPLAYED self sign-out at authentication, having already done it', async () => {
      /*
       * What actually happens, pinned because an earlier version of the service
       * claimed something else.
       *
       * `revokeSessions` used to skip its session-liveness check for the
       * caller's own id, on the reasoning that a replayed second click should
       * report zero rather than "your session is invalid". That branch cannot
       * fire: the session is resolved by the controller BEFORE the service is
       * called, so a replay is refused at authentication and never reaches the
       * transaction. A mutation that removed the branch changed nothing, which
       * is how it was found; the branch is gone and this is the behaviour.
       *
       * It is the right answer anyway. The first call did the work and said so;
       * the second arrives with a credential that is no longer one.
       */
      const ownerId = await idOf('owner');
      const cookie = await cookieFor('owner', 'the-owners-real-password');
      const first = await inject({
        method: 'POST',
        url: `${API_PREFIX}${ADMIN_ROUTES.revokeSessions(ownerId)}`,
        headers: asAdmin(cookie),
        payload: { reason: 'signing out everywhere' },
      });
      expect(first.json()).toEqual({ revoked: 1 });

      const replay = await inject({
        method: 'POST',
        url: `${API_PREFIX}${ADMIN_ROUTES.revokeSessions(ownerId)}`,
        headers: asAdmin(cookie),
        payload: { reason: 'signing out everywhere' },
      });
      expect(replay.statusCode).toBe(401);
    });

    it('will not let another tenant read or end an administrator\u2019s sessions', async () => {
      await createAdmin(api.container, tenantA, {
        username: 'cross-target',
        password: 'the-cross-password',
        roleKeys: ['support'],
      });
      const target = await idOf('cross-target');
      await cookieFor('cross-target', 'the-cross-password');
      await createAdmin(api.container, tenantB, {
        username: 'owner-b-sessions',
        password: 'the-owner-b-password',
        roleKeys: ['owner'],
      });

      api.container.setInstallationTenant(tenantB.tenantId);
      let listed;
      let revoked;
      let reset;
      try {
        const cookieB = await cookieFor('owner-b-sessions', 'the-owner-b-password');
        listed = await inject({
          method: 'GET',
          url: `${API_PREFIX}${ADMIN_ROUTES.sessions(target)}`,
          headers: asAdmin(cookieB),
        });
        revoked = await inject({
          method: 'POST',
          url: `${API_PREFIX}${ADMIN_ROUTES.revokeSessions(target)}`,
          headers: asAdmin(cookieB),
          payload: { reason: 'not mine' },
        });
        reset = await inject({
          method: 'POST',
          url: `${API_PREFIX}${ADMIN_ROUTES.password(target)}`,
          headers: asAdmin(cookieB),
          payload: { newPassword: 'taking-this-account', reason: 'not mine' },
        });
      } finally {
        api.container.setInstallationTenant(tenantA.tenantId);
      }
      expect(listed.statusCode).toBe(404);
      expect(revoked.statusCode).toBe(404);
      expect(reset.statusCode).toBe(404);

      // The session survived and so did the password: a 404 that had already
      // done the work would be the worst of both.
      expect((await login('cross-target', 'the-cross-password')).statusCode).toBe(201);
    });

    it('refuses a cookie-authenticated binding from an unlisted origin', async () => {
      await createAdmin(api.container, tenantA, {
        username: 'origin-target',
        roleKeys: ['support'],
      });
      const target = await idOf('origin-target');
      const cookie = await cookieFor('owner', 'the-owners-real-password');
      const response = await inject({
        method: 'POST',
        url: `${API_PREFIX}${ADMIN_ROUTES.telegram(target)}`,
        headers: { cookie, origin: 'https://evil.example.test' },
        payload: { telegramUserId: '123456789', reason: 'csrf' },
      });
      expect(response.statusCode).toBe(403);
      expect(await bindingOf(target)).toBeNull();
    });
  });
});
