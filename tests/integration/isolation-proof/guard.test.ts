import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  MINIAPP_API_PREFIX,
  MINIAPP_ROUTES,
  miniAppPath,
} from '@nexa/contracts';
import { buildWorld, fingerprints, leaks, ORIGIN, PASSWORD, type World } from './fixtures';

/**
 * Phase 6A PR-5 (D3) — the guard: a request bound to a hosted tenant never falls back to the
 * installation's PRIMARY.
 *
 * The installation tenant (`container.installationTenantId`) is the PRIMARY throughout, as on
 * a real install. A hosted tenant's session, statement, launch and stopped state must each
 * resolve to that hosted tenant or to nothing — never to the installation's rows, never to
 * the installation's scope. (The installation-tenant cache's own fail-closed rule for a
 * vanished hosted tenant is `tests/integration/installation-tenant-guard-rls.test.ts`.)
 */

describe('isolation proof (PR-5) — no fallback to the PRIMARY', () => {
  let world: World;

  beforeAll(async () => {
    world = await buildWorld();
  }, 180_000);

  afterAll(async () => {
    await world?.close();
  });

  const hosted = () => world.tenants.HOSTED_1;
  const primary = () => world.tenants.PRIMARY;
  const db = () => world.api.container.database.db;
  const sessionsOf = async (tenantId: string) =>
    (
      (
        await db().execute(
          sql`SELECT count(*)::int AS n FROM admin_sessions WHERE tenant_id = ${tenantId}`,
        )
      ).rows[0] as { n: number }
    ).n;
  const stopped = async <T>(fn: () => Promise<T>): Promise<T> => {
    await db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${hosted().tenantId}`);
    try {
      return await fn();
    } finally {
      await db().execute(sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${hosted().tenantId}`);
    }
  };

  it('a hosted session is scoped to the hosted tenant while the installation is the PRIMARY', async () => {
    expect(world.api.container.installationTenantId).toBe(primary().tenantId);
    for (const path of ['/users', '/products', '/orders', '/admins', '/settings']) {
      const response = await world.inject({
        method: 'GET',
        url: `${API_PREFIX}${path}`,
        headers: { cookie: hosted().cookie },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(leaks(response.body, primary()), path).toEqual([]);
    }
  });

  it('a hosted unit of work binds the hosted tenant in the database, not the installation', async () => {
    const bound = await world.api.container.uow.run(hosted().scope, (tx) =>
      (tx as { tx: { execute: (q: unknown) => Promise<{ rows: unknown[] }> } }).tx.execute(
        sql`SELECT current_setting('app.current_tenant_id') AS tenant, current_user AS role`,
      ),
    );
    expect(bound.rows[0]).toEqual({ tenant: hosted().tenantId, role: 'nexa_app' });
  });

  it('a hosted administrator’s credentials do not sign in to the installation', async () => {
    const before = await sessionsOf(primary().tenantId);
    const response = await world.inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: hosted().owner.username, password: PASSWORD },
    });
    expect(response.statusCode, response.body).toBe(401);
    expect(String(response.headers['set-cookie'] ?? '')).not.toMatch(/nexa_admin_session=[^;]/);
    expect(await sessionsOf(primary().tenantId)).toBe(before);
    expect(leaks(response.body, primary())).toEqual([]);
  });

  it('a STOPPED hosted tenant’s session is refused — it is not served the installation instead', async () => {
    await stopped(async () => {
      for (const path of ['/users', '/products', '/settings']) {
        const response = await world.inject({
          method: 'GET',
          url: `${API_PREFIX}${path}`,
          headers: { cookie: hosted().cookie },
        });
        expect([401, 403], `${path}: ${response.body}`).toContain(response.statusCode);
        expect(
          fingerprints(primary()).filter((needle) => response.body.includes(needle)),
          path,
        ).toEqual([]);
      }
    });
  });

  it('a STOPPED hosted tenant’s mini app launch mints nothing, in it or in the PRIMARY', async () => {
    const customers = async () =>
      (
        await db().execute(
          sql`SELECT tenant_id, count(*)::int AS n FROM customers GROUP BY tenant_id
               ORDER BY tenant_id`,
        )
      ).rows;
    const before = await customers();
    await stopped(async () => {
      const response = await world.inject({
        method: 'POST',
        url: `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES.session, {
          botInstanceId: hosted().botId,
        })}`,
        payload: { initData: 'user=%7B%22id%22%3A5%7D&auth_date=1&hash=00' },
      });
      expect([401, 404], response.body).toContain(response.statusCode);
    });
    expect(await customers()).toEqual(before);
  });
});

/*
 * PR-4 (#416, activation) — NOT on main yet. Its surfaces, once merged, belong in this proof:
 *
 *  - Host → tenant sign-in: a login addressed to hosted tenant H1's verified domain signs in
 *    to H1 only; the same credentials on H2's domain, on the installation's own host and on
 *    an unknown host are refused; H1's credentials never mint a PRIMARY session, and a
 *    PRIMARY owner's credentials on H1's domain never mint an H1 session.
 *  - The one-time activation link: H1's link redeemed on H2's domain (or the installation's)
 *    is refused and stays unspent; a spent or expired link opens nothing; redeeming sets H1's
 *    owner only (no admin row changes in H2 or the PRIMARY).
 *  - The creator panel's activation routes (`/hosting/bots/:tenantId/activation…`): a hosted
 *    owner's session (H1) addressing them for H2 is refused (owner-only), and the edge's
 *    certificate `ask` answers 200 for verified domains only.
 *
 * The lead enables this block once #416 merges, by replacing `describe.skip` with `describe`
 * and filling each case against #416's routes (HOSTING_ACTIVATION_ROUTES,
 * HOSTED_ACTIVATION_ROUTES, the login's `resolveHost`). Skipped with that reason, not
 * because anything fails: PR-4's code is not on main, and this PR must not depend on it.
 */
describe.skip('isolation proof (PR-5) — PR-4 activation surfaces (enable once #416 merges)', () => {
  it.todo('Host → tenant sign-in signs in to the addressed hosted tenant only');
  it.todo('a hosted owner’s credentials on another tenant’s or the installation’s host are refused');
  it.todo('a one-time activation link redeemed on another tenant’s domain is refused and unspent');
  it.todo('the activation routes refuse a hosted owner’s session for another hosted tenant');
  it.todo('the certificate ask answers 200 for verified hosted domains only');
});
