import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  HEALTH_ROUTES,
  IDENTITY_ERROR_CODES,
  MINIAPP_API_PREFIX,
  SESSION_COOKIE_NAME,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, testConfig } from './harness';

/**
 * R12 F2 item 1: the Origin check (CSRF layer 2) runs on EVERY Web Admin write, and every
 * Web Admin route refuses a request with no session.
 *
 * Enumerated, not listed. The routes come from `ApiApp.routes`, which the bootstrap's own
 * `onRoute` hook records, so a controller added tomorrow is in this sweep the day it is
 * registered. Before the shared `authenticateAdmin`, sixty-one copied `authenticate()`
 * methods ran the check only when a call site passed `{ write: true }`, and fourteen
 * controllers — bots and the token route, wallet adjustments, refunds, gateway credentials,
 * resellers, gift cards, the menu builders, payments reconcile, the FX refresh — never did.
 *
 * The exemptions below are the whole list of routes that are NOT the authenticated admin,
 * each with its reason; a route that is neither admin nor exempt fails the census.
 */

const ORIGIN = 'https://admin.example.test';
const EVIL = 'https://evil.example';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Admin-prefixed routes that are anonymous by design. */
const ANONYMOUS_ADMIN_ROUTES = new Set([
  // Signing in is how a session is obtained; both steps check the Origin first themselves.
  `POST ${API_PREFIX}${AUTH_ROUTES.login}`,
  `POST ${API_PREFIX}${AUTH_ROUTES.login}/second-factor`,
  // Development only (never registered in production): the RecordPing reference write path,
  // acting as SYSTEM_JOB. `dev-system-endpoint.test.ts` pins where it is mounted.
  `POST ${API_PREFIX}/system/ping`,
]);

/** Prefixes that are not the Web Admin at all, each with its own authentication. */
const NON_ADMIN_PREFIXES = [
  // Liveness and readiness are anonymous; /health/info checks the session itself.
  '/health/',
  // Telegram's secret-token header, checked before the body is read.
  '/telegram/webhook/',
  // Gateway webhooks are hints that schedule an inquiry; a return is a redirect.
  '/payments/webhook/',
  '/payments/return/',
  // The customer mini app: Telegram initData and its own bearer session.
  MINIAPP_API_PREFIX,
  '/miniapp',
];

function concrete(url: string): string {
  // Authentication runs before any parameter is parsed, so any well-formed value will do.
  return url.replace(/:[A-Za-z0-9_]+/g, '0190a0b0-0000-7000-8000-000000000001');
}

describe('every Web Admin route: a session, and an allowed Origin on every write', () => {
  let api: ApiApp;
  let cookie: string;
  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    const login = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner', password: 'the-owners-real-password' },
    });
    const header = login.headers['set-cookie'];
    const lines = Array.isArray(header) ? header.map(String) : [String(header ?? '')];
    const match = lines
      .map((line) => new RegExp(`(?:^|\\s)${SESSION_COOKIE_NAME}=([^;]+)`).exec(line))
      .find((m) => m !== null);
    if (!match?.[1]) throw new Error(`no session cookie: ${login.body}`);
    cookie = `${SESSION_COOKIE_NAME}=${match[1]}`;
  });

  afterAll(async () => {
    await api?.close();
  });

  function adminRoutes(): { method: string; url: string }[] {
    const out: { method: string; url: string }[] = [];
    for (const route of api.routes) {
      for (const method of route.methods) {
        if (method === 'HEAD' || method === 'OPTIONS') continue;
        if (!route.url.startsWith(`${API_PREFIX}/`)) continue;
        if (ANONYMOUS_ADMIN_ROUTES.has(`${method} ${route.url}`)) continue;
        out.push({ method, url: route.url });
      }
    }
    return out;
  }

  it('knows every registered route: Web Admin, or a named exemption', () => {
    const unknown = api.routes
      .filter((route) => !route.url.startsWith(`${API_PREFIX}/`))
      .filter((route) => !NON_ADMIN_PREFIXES.some((prefix) => route.url.startsWith(prefix)))
      .filter((route) => route.url !== HEALTH_ROUTES.live)
      .map((route) => `${route.methods.join(',')} ${route.url}`);
    expect(unknown).toEqual([]);
    // The sweep below is only as good as its population: a few hundred admin routes, of
    // which well over a hundred write.
    expect(adminRoutes().length).toBeGreaterThan(300);
    expect(adminRoutes().filter((r) => WRITE_METHODS.has(r.method)).length).toBeGreaterThan(150);
  });

  it('refuses a write from a foreign Origin with 403, on every write route', async () => {
    const accepted: string[] = [];
    for (const { method, url } of adminRoutes()) {
      if (!WRITE_METHODS.has(method)) continue;
      const response = await inject({
        method,
        url: concrete(url),
        headers: { cookie, origin: EVIL },
        payload: {},
      });
      const code = (response.json() as { error?: { code?: string } }).error?.code;
      if (response.statusCode !== 403 || code !== IDENTITY_ERROR_CODES.AUTH_ORIGIN_REJECTED) {
        accepted.push(`${method} ${url} -> ${response.statusCode} ${code ?? ''}`);
      }
    }
    expect(accepted).toEqual([]);
  });

  it('refuses a write with no Origin at all with 403', async () => {
    const accepted: string[] = [];
    for (const { method, url } of adminRoutes()) {
      if (!WRITE_METHODS.has(method)) continue;
      const response = await inject({
        method,
        url: concrete(url),
        headers: { cookie },
        payload: {},
      });
      if (response.statusCode !== 403) accepted.push(`${method} ${url} -> ${response.statusCode}`);
    }
    expect(accepted).toEqual([]);
  });

  it('refuses every route without a session with 401, from the right Origin', async () => {
    const accepted: string[] = [];
    for (const { method, url } of adminRoutes()) {
      const response = await inject({
        method,
        url: concrete(url),
        headers: { origin: ORIGIN },
        ...(WRITE_METHODS.has(method) ? { payload: {} } : {}),
      });
      if (response.statusCode !== 401) accepted.push(`${method} ${url} -> ${response.statusCode}`);
    }
    expect(accepted).toEqual([]);
  });

  it('still lets a read through with no Origin header (a GET is never a CSRF write)', async () => {
    const response = await inject({
      method: 'GET',
      url: `${API_PREFIX}${AUTH_ROUTES.session}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
  });
});
