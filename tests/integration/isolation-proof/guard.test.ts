import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  HOSTED_ACTIVATION_LINK_TTL_SECONDS,
  HOSTED_ACTIVATION_ROUTES,
  HOSTED_DOMAIN_CHECK_PATH,
  HOSTING_ACTIVATION_ERROR_CODES,
  HOSTING_ACTIVATION_ROUTES,
  HOSTING_SESSION_COOKIE_NAME,
  MINIAPP_API_PREFIX,
  MINIAPP_ROUTES,
  miniAppPath,
} from '@nexa/contracts';
import {
  generateActivationToken,
  hashActivationToken,
} from '../../../apps/api/src/modules/platform/hosting/domain/activation-link';
import {
  totpForStep,
  totpStepAt,
} from '../../../apps/api/src/modules/platform/identity/application/totp';
import {
  buildWorld,
  fingerprints,
  leaks,
  ORIGIN,
  PASSWORD,
  type TenantLabel,
  type World,
} from './fixtures';

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
 * PR-4 (#416, hosted-bot activation) — its surfaces, proven against the same three-tenant world.
 *
 * Both hosted tenants get a finished activation (domain, DNS, SSL, webhook marks), written
 * directly as the owner: the marks are what the DNS/HTTPS/Telegram steps would have left, and
 * `hosted-activation.test.ts` proves the steps themselves. What this block proves is the
 * tenant boundary on top of them:
 *
 *  - Host → tenant sign-in: a login addressed to H1's verified domain mints an H1 session and
 *    nothing else; the same credentials on H2's domain, the installation's own host and an
 *    unknown host are refused; H1's credentials never mint a PRIMARY session, nor a PRIMARY
 *    owner's an H1 session on H1's domain.
 *  - The one-time link: H1's link redeemed on H2's domain or the installation's host is
 *    refused and stays unspent; a spent or expired link opens nothing; redeeming on H1's
 *    domain changes H1's owner row and no admin row of H2 or the PRIMARY.
 *  - The creator panel's activation routes refuse H1's owner addressing H2 — with no section
 *    session, and with the installation owner's section cookie replayed — while the
 *    installation owner's own section reads H2 (the route works; the refusal is the boundary).
 *  - The edge's certificate `ask` answers 200 for verified hosted domains only.
 */
describe('isolation proof (PR-5) — PR-4 activation surfaces', () => {
  let world: World;
  const H1_DOMAIN = 'h1.isolation-hosted.test';
  const H2_DOMAIN = 'h2.isolation-hosted.test';
  /** The installation's own name (from WEB_ADMIN_ORIGINS): reserved, never a hosted domain. */
  const INSTALLATION_HOST = new URL(ORIGIN).hostname;
  const UNKNOWN_HOST = 'unknown.isolation-elsewhere.test';
  const NEW_PASSWORD = 'the-hosted-owners-chosen-password';

  const db = () => world.api.container.database.db;
  const t = (label: TenantLabel) => world.tenants[label];
  const sessionCounts = async () =>
    Object.fromEntries(
      (
        await db().execute(
          sql`SELECT tenant_id, count(*)::int AS n FROM admin_sessions GROUP BY tenant_id`,
        )
      ).rows.map((row) => [(row as { tenant_id: string }).tenant_id, (row as { n: number }).n]),
    ) as Record<string, number>;
  const adminRowsOf = async (tenantId: string) =>
    JSON.stringify(
      (
        await db().execute(
          sql`SELECT to_jsonb(a) AS row FROM admins a WHERE tenant_id = ${tenantId} ORDER BY id`,
        )
      ).rows,
    );
  const linkRow = async (id: string) =>
    (
      await db().execute(
        sql`SELECT used_at, revoked_at FROM hosted_bot_activation_links WHERE id = ${id}`,
      )
    ).rows[0] as { used_at: unknown; revoked_at: unknown };
  /**
   * A hosted domain's page sends its own Origin; any other host is given the installation's
   * allowed Origin, so the request passes the CSRF check and reaches the tenant resolution.
   */
  const hostHeaders = (host: string) => ({
    host,
    origin: host === H1_DOMAIN || host === H2_DOMAIN ? `https://${host}` : ORIGIN,
  });
  const login = (host: string, username: string, password = PASSWORD) =>
    world.inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: hostHeaders(host),
      payload: { username, password },
    });
  const redeem = (host: string, token: string, username = 'h1-chosen-owner') =>
    world.inject({
      method: 'POST',
      url: `${API_PREFIX}${HOSTED_ACTIVATION_ROUTES.redeem}`,
      headers: hostHeaders(host),
      payload: { token, username, password: NEW_PASSWORD },
    });
  const errorCode = (response: { json(): unknown }) =>
    (response.json() as { error?: { code?: string } }).error?.code;
  const sessionCookie = (response: { headers: Record<string, unknown> }) =>
    /nexa_admin_session=([^;]+)/.exec(String(response.headers['set-cookie'] ?? ''))?.[1];

  /** A link row for a hosted tenant, as `issueLink` writes it (only the hash is stored). */
  async function linkFor(
    label: TenantLabel,
    shape: { usedAt?: Date; createdAt?: Date; expiresAt?: Date } = {},
  ): Promise<{ id: string; token: string }> {
    const id = world.api.container.ids.uuid();
    const token = generateActivationToken();
    const createdAt = shape.createdAt ?? new Date();
    const expiresAt =
      shape.expiresAt ?? new Date(createdAt.getTime() + HOSTED_ACTIVATION_LINK_TTL_SECONDS * 1000);
    const usedAt = shape.usedAt === undefined ? null : shape.usedAt.toISOString();
    await db().execute(sql`INSERT INTO hosted_bot_activation_links
        (id, tenant_id, hosted_tenant_id, token_hash, created_by_admin_id, created_at, expires_at,
         used_at)
      VALUES (${id}, ${t('PRIMARY').tenantId}, ${t(label).tenantId}, ${hashActivationToken(token)},
              ${t('PRIMARY').owner.id}, ${createdAt.toISOString()}, ${expiresAt.toISOString()},
              ${usedAt})`);
    return { id, token };
  }

  beforeAll(async () => {
    world = await buildWorld();
    // Both hosted tenants' activations, every step's mark earned on their own domain.
    for (const [label, domain] of [
      ['HOSTED_1', H1_DOMAIN],
      ['HOSTED_2', H2_DOMAIN],
    ] as const) {
      await db().execute(sql`INSERT INTO hosted_bot_activations
          (tenant_id, hosted_tenant_id, bot_instance_id, domain, token_verified_at,
           dns_verified_at, tls_verified_at, webhook_registered_at, created_at, updated_at)
        VALUES (${t('PRIMARY').tenantId}, ${t(label).tenantId}, ${t(label).botId}, ${domain},
                now(), now(), now(), now(), now(), now())`);
    }
  }, 180_000);

  afterAll(async () => {
    await world?.close();
  });

  it('Host → tenant sign-in signs in to the addressed hosted tenant only', async () => {
    const before = await sessionCounts();
    const response = await login(H1_DOMAIN, t('HOSTED_1').owner.username);
    expect(response.statusCode, response.body).toBe(201);
    const token = sessionCookie(response);
    expect(token).toBeDefined();
    // One new session, in H1; none in the PRIMARY or H2.
    const after = await sessionCounts();
    expect(after[t('HOSTED_1').tenantId]).toBe((before[t('HOSTED_1').tenantId] ?? 0) + 1);
    expect(after[t('PRIMARY').tenantId]).toBe(before[t('PRIMARY').tenantId]);
    expect(after[t('HOSTED_2').tenantId]).toBe(before[t('HOSTED_2').tenantId]);
    const cookie = `nexa_admin_session=${token as string}`;
    const session = await world.inject({
      method: 'GET',
      url: `${API_PREFIX}${AUTH_ROUTES.session}`,
      headers: { host: H1_DOMAIN, cookie },
    });
    expect(session.statusCode, session.body).toBe(200);
    expect((session.json() as { admin: { id: string } }).admin.id).toBe(t('HOSTED_1').owner.id);
    // …and it reads H1's rows, never the PRIMARY's or H2's.
    const users = await world.inject({
      method: 'GET',
      url: `${API_PREFIX}/users`,
      headers: { host: H1_DOMAIN, cookie },
    });
    expect(users.statusCode, users.body).toBe(200);
    expect(users.body).toContain(t('HOSTED_1').marker);
    expect(leaks(users.body, t('PRIMARY'))).toEqual([]);
    expect(leaks(users.body, t('HOSTED_2'))).toEqual([]);
  });

  it('a hosted owner’s credentials on another tenant’s or the installation’s host are refused', async () => {
    const before = await sessionCounts();
    const h1 = t('HOSTED_1').owner.username;
    for (const host of [H2_DOMAIN, INSTALLATION_HOST, UNKNOWN_HOST]) {
      const response = await login(host, h1);
      expect(response.statusCode, `${host}: ${response.body}`).toBe(401);
      expect(sessionCookie(response), host).toBeUndefined();
    }
    // A PRIMARY owner's credentials on H1's (and H2's) domain do not mint a hosted session.
    for (const host of [H1_DOMAIN, H2_DOMAIN]) {
      const response = await login(host, t('PRIMARY').owner.username);
      expect(response.statusCode, `${host}: ${response.body}`).toBe(401);
      expect(sessionCookie(response), host).toBeUndefined();
    }
    expect(await sessionCounts()).toEqual(before);
    // Control: the PRIMARY owner still signs in on the installation's host, to the PRIMARY.
    const primary = await login(INSTALLATION_HOST, t('PRIMARY').owner.username);
    expect(primary.statusCode, primary.body).toBe(201);
    const after = await sessionCounts();
    expect(after[t('PRIMARY').tenantId]).toBe((before[t('PRIMARY').tenantId] ?? 0) + 1);
    expect(after[t('HOSTED_1').tenantId]).toBe(before[t('HOSTED_1').tenantId]);
  });

  it('a one-time activation link redeemed on another tenant’s domain is refused and unspent', async () => {
    const admins = async () => ({
      PRIMARY: await adminRowsOf(t('PRIMARY').tenantId),
      HOSTED_1: await adminRowsOf(t('HOSTED_1').tenantId),
      HOSTED_2: await adminRowsOf(t('HOSTED_2').tenantId),
    });
    const before = await admins();
    const link = await linkFor('HOSTED_1');
    // Carried to H2's verified domain, the installation's host or an unknown one: dead there.
    for (const host of [H2_DOMAIN, INSTALLATION_HOST, UNKNOWN_HOST]) {
      const response = await redeem(host, link.token);
      expect(response.statusCode, `${host}: ${response.body}`).not.toBe(200);
      expect(errorCode(response), host).toBe(HOSTING_ACTIVATION_ERROR_CODES.LINK_INVALID);
      expect((await linkRow(link.id)).used_at, host).toBeNull();
    }
    // A spent link and an expired one open nothing, even on H1's own domain.
    const spent = await linkFor('HOSTED_1', { usedAt: new Date(Date.now() - 60_000) });
    const reused = await redeem(H1_DOMAIN, spent.token);
    expect(errorCode(reused), reused.body).toBe(HOSTING_ACTIVATION_ERROR_CODES.LINK_USED);
    const expired = await linkFor('HOSTED_1', {
      createdAt: new Date(Date.now() - 2 * HOSTED_ACTIVATION_LINK_TTL_SECONDS * 1000),
      expiresAt: new Date(Date.now() - 60_000),
    });
    const late = await redeem(H1_DOMAIN, expired.token);
    expect(errorCode(late), late.body).toBe(HOSTING_ACTIVATION_ERROR_CODES.LINK_EXPIRED);
    expect((await linkRow(expired.id)).used_at).toBeNull();
    expect(await admins()).toEqual(before);

    // On H1's own domain it works, and sets H1's owner — no admin row of H2 or the PRIMARY.
    const ok = await redeem(H1_DOMAIN, link.token);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await linkRow(link.id)).used_at).not.toBeNull();
    const after = await admins();
    expect(after.PRIMARY).toBe(before.PRIMARY);
    expect(after.HOSTED_2).toBe(before.HOSTED_2);
    expect(
      (await db().execute(sql`SELECT id, tenant_id FROM admins WHERE username = 'h1-chosen-owner'`))
        .rows,
    ).toEqual([{ id: t('HOSTED_1').owner.id, tenant_id: t('HOSTED_1').tenantId }]);
    // The chosen credentials sign in on H1's domain only.
    expect((await login(H1_DOMAIN, 'h1-chosen-owner', NEW_PASSWORD)).statusCode).toBe(201);
    expect((await login(H2_DOMAIN, 'h1-chosen-owner', NEW_PASSWORD)).statusCode).toBe(401);
    expect((await login(INSTALLATION_HOST, 'h1-chosen-owner', NEW_PASSWORD)).statusCode).toBe(401);
  });

  it('the activation routes refuse a hosted owner’s session for another hosted tenant', async () => {
    const primary = t('PRIMARY');
    const h1 = t('HOSTED_1');
    const h2 = t('HOSTED_2');
    // The installation owner opens the creator panel's section (the two-step code).
    const enrolment = await world.api.container.hostingSection.enrol(
      primary.scope,
      primary.ownerActor,
      { password: PASSWORD },
      { ip: null },
    );
    const opened = await world.api.container.hostingSection.activate(
      primary.scope,
      primary.ownerActor,
      { code: totpForStep(enrolment.secret, totpStepAt(world.api.container.clock.now())) },
    );
    const section = `${HOSTING_SESSION_COOKIE_NAME}=${opened.opened.token}`;
    const activationOf = async (tenantId: string) =>
      JSON.stringify([
        (
          await db().execute(
            sql`SELECT to_jsonb(a) AS row FROM hosted_bot_activations a
                 WHERE hosted_tenant_id = ${tenantId}`,
          )
        ).rows,
        (
          await db().execute(
            sql`SELECT id, used_at, revoked_at FROM hosted_bot_activation_links
                 WHERE hosted_tenant_id = ${tenantId} ORDER BY id`,
          )
        ).rows,
      ]);
    const path = (route: string, step = 'domain') =>
      `${API_PREFIX}${route.replace(':tenantId', h2.tenantId).replace(':step', step)}`;
    const statusUrl = path(HOSTING_ACTIVATION_ROUTES.status);

    // Control: the installation owner's own section reads H2's activation.
    const control = await world.inject({
      method: 'GET',
      url: statusUrl,
      headers: { host: INSTALLATION_HOST, cookie: `${primary.cookie}; ${section}` },
    });
    expect(control.statusCode, control.body).toBe(200);
    expect((control.json() as { hostedTenantId: string }).hostedTenantId).toBe(h2.tenantId);

    const before = await activationOf(h2.tenantId);
    const telegramCalls = world.telegram.calls.length;
    // H1's owner, on H1's own domain and on the installation's host, with no section and with
    // the installation owner's section cookie replayed beside their own session.
    const attempts: { method: string; url: string; payload?: Record<string, unknown> }[] = [
      { method: 'GET', url: statusUrl },
      {
        method: 'POST',
        url: path(HOSTING_ACTIVATION_ROUTES.configure),
        payload: {
          idempotencyKey: world.key(),
          proof: { code: '000000' },
          botToken: h1.botToken,
          domain: 'stolen.isolation-hosted.test',
        },
      },
      {
        method: 'POST',
        url: path(HOSTING_ACTIVATION_ROUTES.runStep, 'webhook'),
        payload: { idempotencyKey: world.key() },
      },
      {
        method: 'POST',
        url: path(HOSTING_ACTIVATION_ROUTES.link),
        payload: { idempotencyKey: world.key(), proof: { code: '000000' } },
      },
    ];
    for (const host of [H1_DOMAIN, INSTALLATION_HOST]) {
      for (const cookie of [h1.cookie, `${h1.cookie}; ${section}`]) {
        for (const attempt of attempts) {
          const response = await world.inject({
            ...attempt,
            headers: { ...hostHeaders(host), cookie },
          });
          const what = `${host} ${attempt.method} ${attempt.url}${cookie === h1.cookie ? '' : ' +section'}`;
          expect([401, 403], `${what}: ${response.body}`).toContain(response.statusCode);
          expect(leaks(response.body, h2), what).toEqual([]);
          expect(response.body, what).not.toContain(H2_DOMAIN);
        }
      }
    }
    expect(await activationOf(h2.tenantId)).toBe(before);
    expect(world.telegram.calls.length).toBe(telegramCalls);
  });

  it('the certificate ask answers 200 for verified hosted domains only', async () => {
    const ask = (domain: string) =>
      world.inject({
        method: 'GET',
        url: `${HOSTED_DOMAIN_CHECK_PATH}?domain=${encodeURIComponent(domain)}`,
      });
    expect((await ask(H1_DOMAIN)).statusCode).toBe(200);
    expect((await ask(H2_DOMAIN)).statusCode).toBe(200);
    for (const other of [
      UNKNOWN_HOST,
      INSTALLATION_HOST,
      `x.${H1_DOMAIN}`,
      `${H2_DOMAIN}.evil.test`,
      'stolen.isolation-hosted.test',
    ]) {
      expect((await ask(other)).statusCode, other).not.toBe(200);
    }
    // H2's domain un-verified (its marks cleared, as a later failed DNS check leaves them):
    // no certificate for it, while H1's still gets one.
    await db().execute(sql`UPDATE hosted_bot_activations
        SET dns_verified_at = NULL, tls_verified_at = NULL, webhook_registered_at = NULL
      WHERE hosted_tenant_id = ${t('HOSTED_2').tenantId}`);
    try {
      expect((await ask(H2_DOMAIN)).statusCode).not.toBe(200);
      expect((await ask(H1_DOMAIN)).statusCode).toBe(200);
    } finally {
      await db().execute(sql`UPDATE hosted_bot_activations
          SET dns_verified_at = now(), tls_verified_at = now(), webhook_registered_at = now()
        WHERE hosted_tenant_id = ${t('HOSTED_2').tenantId}`);
    }
    expect((await ask(H2_DOMAIN)).statusCode).toBe(200);
  });
});
