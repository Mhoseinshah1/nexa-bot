import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_ROUTES,
  adminListResponseSchema,
  API_PREFIX,
  AUTH_ROUTES,
  loginResponseSchema,
  roleListResponseSchema,
  SESSION_COOKIE_NAME,
  sessionResponseSchema,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, testConfig } from './harness';

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
});
