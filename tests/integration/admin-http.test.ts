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
    const config = api.container.config;
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, config.SECRETS_KEK, config.SECRETS_KEK_ID);
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

  async function tokenFor(username: string, password: string): Promise<string> {
    const response = await login(username, password);
    return loginResponseSchema.parse(response.json()).token;
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}`, origin: ORIGIN });

  describe('login', () => {
    it('returns a session matching the frozen schema', async () => {
      const response = await login('owner', 'the-owners-real-password');
      expect(response.statusCode).toBe(201);

      const body = loginResponseSchema.parse(response.json());
      expect(body.admin.username).toBe('owner');
      expect(body.permissions).toContain('admins.edit');
      // The response carries no password material of any kind.
      expect(JSON.stringify(body)).not.toContain('the-owners-real-password');
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

    it('refuses a forged or expired-looking token', async () => {
      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${ADMIN_ROUTES.list}`,
        headers: bearer('x'.repeat(43)),
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
      const token = await tokenFor('support', 'the-support-password');

      const response = await inject({
        method: 'POST',
        url: `${API_PREFIX}${ADMIN_ROUTES.create}`,
        headers: bearer(token),
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
      const token = await tokenFor('support', 'the-support-password');
      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${ADMIN_ROUTES.list}`,
        headers: bearer(token),
      });
      expect(response.statusCode).toBe(403);
    });

    it('permits the same call for an owner', async () => {
      const token = await tokenFor('owner', 'the-owners-real-password');
      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${ADMIN_ROUTES.list}`,
        headers: bearer(token),
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
      const token = await tokenFor('support', 'the-support-password');
      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${AUTH_ROUTES.session}`,
        headers: bearer(token),
      });

      expect(response.statusCode).toBe(200);
      const body = sessionResponseSchema.parse(response.json());
      expect(body.admin.username).toBe('support');
      expect(body.permissions).not.toContain('admins.edit');
    });

    it('stops accepting the token after logout, and clears the cookie', async () => {
      const token = await tokenFor('owner', 'the-owners-real-password');

      const logout = await inject({
        method: 'POST',
        url: `${API_PREFIX}${AUTH_ROUTES.logout}`,
        headers: bearer(token),
      });
      expect(logout.statusCode).toBe(201);
      expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');

      const after = await inject({
        method: 'GET',
        url: `${API_PREFIX}${AUTH_ROUTES.session}`,
        headers: bearer(token),
      });
      expect(after.statusCode).toBe(401);
    });

    it('authenticates by cookie as well as by bearer token', async () => {
      const response = await login('owner', 'the-owners-real-password');
      const token = loginResponseSchema.parse(response.json()).token;

      const withCookie = await inject({
        method: 'GET',
        url: `${API_PREFIX}${AUTH_ROUTES.session}`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` },
      });
      expect(withCookie.statusCode).toBe(200);
    });
  });

  describe('CSRF defence', () => {
    it('refuses a cookie-authenticated write from an unlisted origin', async () => {
      // SameSite is enforced by the browser; the Origin check does not depend
      // on the browser behaving.
      const response = await login('owner', 'the-owners-real-password');
      const token = loginResponseSchema.parse(response.json()).token;

      const forged = await inject({
        method: 'POST',
        url: `${API_PREFIX}${ADMIN_ROUTES.create}`,
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
          origin: 'https://evil.example.test',
        },
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

    it('permits a bearer-authenticated write from any origin', async () => {
      // A cross-origin page cannot set an Authorization header, so there is
      // nothing for the Origin check to defend here.
      const token = await tokenFor('owner', 'the-owners-real-password');
      const response = await inject({
        method: 'POST',
        url: `${API_PREFIX}${ADMIN_ROUTES.create}`,
        headers: { authorization: `Bearer ${token}`, origin: 'https://elsewhere.example.test' },
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
      const token = await tokenFor('owner', 'the-owners-real-password');
      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${ADMIN_ROUTES.rolesCatalog}`,
        headers: bearer(token),
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
      const token = await tokenFor('owner', 'the-owners-real-password');
      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${ADMIN_ROUTES.rolesCatalog}`,
        headers: bearer(token),
      });
      const body = roleListResponseSchema.parse(response.json());
      expect(body.roles.some((role) => role.key === 'owner' && role.isSystem)).toBe(true);
    });
  });
});
