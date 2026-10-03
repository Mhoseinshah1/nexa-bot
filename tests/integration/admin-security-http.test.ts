import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_SECURITY_ROUTES,
  accountSecurityResponseSchema,
  adminSessionListResponseSchema,
  API_PREFIX,
  AUTH_ROUTES,
  backupCodesResponseSchema,
  IDENTITY_ERROR_CODES,
  loginOutcomeResponseSchema,
  loginResponseSchema,
  resetAdminSecondFactorResponseSchema,
  revokeOtherSessionsResponseSchema,
  revokeOwnSessionResponseSchema,
  SECOND_FACTOR_COOKIE_NAME,
  securityEventListResponseSchema,
  SESSION_COOKIE_NAME,
  totpEnrolResponseSchema,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  totpForStep,
  totpStepAt,
} from '../../apps/api/src/modules/platform/identity/application/totp';
import { createAdmin, migrateOnce, resetDatabase, tenantA, testConfig } from './harness';

/**
 * Phase D2 over real HTTP: the challenge cookie, the second step, the account-security
 * routes, a revoked cookie refused, Origin enforced on every write, and nothing secret
 * in any response that is not the one that creates it — nor in a log line.
 */

const ORIGIN = 'https://admin.example.test';
const OWNER_PASSWORD = 'the-owners-real-password';

describe('admin security over HTTP', () => {
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
    api.container.setInstallationTenant(tenantA.tenantId);
    await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: OWNER_PASSWORD,
      roleKeys: ['owner'],
    });
    await createAdmin(api.container, tenantA, {
      username: 'helper',
      password: 'the-helpers-password',
      roleKeys: ['support'],
    });
  });

  function cookieFrom(response: { headers: Record<string, unknown> }, name: string): string | null {
    const header = response.headers['set-cookie'];
    const all = Array.isArray(header) ? header.map(String) : [String(header ?? '')];
    for (const line of all) {
      const match = new RegExp(`(?:^|\\s)${name}=([^;]+)`).exec(line);
      if (match !== null && match[1] !== '') return `${name}=${match[1] as string}`;
    }
    return null;
  }

  const login = (username: string, password: string) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password },
    });

  const as = (cookie: string) => ({ cookie, origin: ORIGIN });
  const code = (secret: string, steps = 0) =>
    totpForStep(secret, totpStepAt(api.container.clock.now()) + steps);

  async function signedIn(username = 'owner', password = OWNER_PASSWORD): Promise<string> {
    const response = await login(username, password);
    const cookie = cookieFrom(response, SESSION_COOKIE_NAME);
    if (cookie === null) throw new Error(`no session cookie: ${response.body}`);
    return cookie;
  }

  async function enable(cookie: string) {
    const enrol = await inject({
      method: 'POST',
      url: `${API_PREFIX}${ACCOUNT_SECURITY_ROUTES.totpEnrol}`,
      headers: as(cookie),
      payload: { password: OWNER_PASSWORD },
    });
    expect(enrol.statusCode).toBe(200);
    expect(enrol.headers['cache-control']).toBe('no-store');
    const enrolment = totpEnrolResponseSchema.parse(enrol.json());
    const activate = await inject({
      method: 'POST',
      url: `${API_PREFIX}${ACCOUNT_SECURITY_ROUTES.totpActivate}`,
      headers: as(cookie),
      payload: { code: code(enrolment.secret, -1) },
    });
    expect(activate.statusCode).toBe(200);
    expect(activate.headers['cache-control']).toBe('no-store');
    return { secret: enrolment.secret, ...backupCodesResponseSchema.parse(activate.json()) };
  }

  it('signs in through a challenge cookie and a code, never setting a session early', async () => {
    const { secret } = await enable(await signedIn());

    const first = await login('owner', OWNER_PASSWORD);
    expect(first.statusCode).toBe(201);
    const body = loginOutcomeResponseSchema.parse(first.json());
    expect('secondFactorRequired' in body && body.secondFactorRequired).toBe(true);
    expect(cookieFrom(first, SESSION_COOKIE_NAME)).toBeNull();
    const challenge = cookieFrom(first, SECOND_FACTOR_COOKIE_NAME);
    expect(challenge).not.toBeNull();
    expect(String(first.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(first.headers['set-cookie'])).toContain('SameSite=Strict');
    // The challenge is not a session.
    const probe = await inject({
      method: 'GET',
      url: `${API_PREFIX}${AUTH_ROUTES.session}`,
      headers: { cookie: challenge!.replace(SECOND_FACTOR_COOKIE_NAME, SESSION_COOKIE_NAME) },
    });
    expect(probe.statusCode).toBe(401);

    // No Origin: refused before anything is checked.
    const noOrigin = await inject({
      method: 'POST',
      url: `${API_PREFIX}${ACCOUNT_SECURITY_ROUTES.loginSecondFactor}`,
      headers: { cookie: challenge! },
      payload: { code: code(secret) },
    });
    expect(noOrigin.statusCode).toBe(403);

    const wrong = await inject({
      method: 'POST',
      url: `${API_PREFIX}${ACCOUNT_SECURITY_ROUTES.loginSecondFactor}`,
      headers: as(challenge!),
      payload: { code: code(secret) === '000000' ? '111111' : '000000' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe(IDENTITY_ERROR_CODES.AUTH_SECOND_FACTOR_INVALID);

    const second = await inject({
      method: 'POST',
      url: `${API_PREFIX}${ACCOUNT_SECURITY_ROUTES.loginSecondFactor}`,
      headers: as(challenge!),
      payload: { code: code(secret) },
    });
    expect(second.statusCode).toBe(201);
    const signedBody = loginResponseSchema.parse(second.json());
    expect(signedBody.admin.username).toBe('owner');
    expect(JSON.stringify(second.json())).not.toContain('token');
    const session = cookieFrom(second, SESSION_COOKIE_NAME);
    expect(session).not.toBeNull();
    // The challenge cookie is cleared.
    expect(String(second.headers['set-cookie'])).toMatch(
      new RegExp(`${SECOND_FACTOR_COOKIE_NAME}=;`),
    );

    const me = await inject({
      method: 'GET',
      url: `${API_PREFIX}${AUTH_ROUTES.session}`,
      headers: { cookie: session! },
    });
    expect(me.statusCode).toBe(200);
  });

  it('refuses the second step with no challenge cookie', async () => {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${ACCOUNT_SECURITY_ROUTES.loginSecondFactor}`,
      headers: { origin: ORIGIN },
      payload: { code: '123456' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe(IDENTITY_ERROR_CODES.AUTH_CHALLENGE_INVALID);
  });

  it('reports the overview, lists sessions, and revokes: a revoked cookie is refused', async () => {
    const old = await signedIn();
    const current = await signedIn();

    const overview = await inject({
      method: 'GET',
      url: `${API_PREFIX}${ACCOUNT_SECURITY_ROUTES.overview}`,
      headers: { cookie: current },
    });
    expect(accountSecurityResponseSchema.parse(overview.json()).totp.state).toBe('DISABLED');

    const list = adminSessionListResponseSchema.parse(
      (
        await inject({
          method: 'GET',
          url: `${API_PREFIX}${ACCOUNT_SECURITY_ROUTES.sessions}`,
          headers: { cookie: current },
        })
      ).json(),
    );
    expect(list.sessions).toHaveLength(2);
    const other = list.sessions.find((row) => !row.current)!;

    // Origin is enforced on the write.
    const forged = await inject({
      method: 'POST',
      url: `${API_PREFIX}${ACCOUNT_SECURITY_ROUTES.revokeSession(other.id)}`,
      headers: { cookie: current, origin: 'https://evil.example' },
    });
    expect(forged.statusCode).toBe(403);

    const revoked = await inject({
      method: 'POST',
      url: `${API_PREFIX}${ACCOUNT_SECURITY_ROUTES.revokeSession(other.id)}`,
      headers: as(current),
    });
    expect(revokeOwnSessionResponseSchema.parse(revoked.json())).toEqual({
      revoked: true,
      current: false,
    });
    const refused = await inject({
      method: 'GET',
      url: `${API_PREFIX}${AUTH_ROUTES.session}`,
      headers: { cookie: old },
    });
    expect(refused.statusCode).toBe(401);

    // Revoking the CURRENT one signs out and clears the cookie.
    const self = list.sessions.find((row) => row.current)!;
    const out = await inject({
      method: 'POST',
      url: `${API_PREFIX}${ACCOUNT_SECURITY_ROUTES.revokeSession(self.id)}`,
      headers: as(current),
    });
    expect(revokeOwnSessionResponseSchema.parse(out.json()).current).toBe(true);
    expect(String(out.headers['set-cookie'])).toMatch(new RegExp(`${SESSION_COOKIE_NAME}=;`));
  });

  it('revoke-others keeps the current session over HTTP', async () => {
    const a = await signedIn();
    const current = await signedIn();
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${ACCOUNT_SECURITY_ROUTES.revokeOtherSessions}`,
      headers: as(current),
    });
    expect(revokeOtherSessionsResponseSchema.parse(response.json()).revoked).toBe(1);
    expect(
      (
        await inject({
          method: 'GET',
          url: `${API_PREFIX}${AUTH_ROUTES.session}`,
          headers: { cookie: a },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await inject({
          method: 'GET',
          url: `${API_PREFIX}${AUTH_ROUTES.session}`,
          headers: { cookie: current },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('an unauthenticated caller reaches nothing', async () => {
    for (const [method, url] of [
      ['GET', ACCOUNT_SECURITY_ROUTES.overview],
      ['GET', ACCOUNT_SECURITY_ROUTES.sessions],
      ['GET', ACCOUNT_SECURITY_ROUTES.events],
      ['POST', ACCOUNT_SECURITY_ROUTES.totpEnrol],
      ['POST', ACCOUNT_SECURITY_ROUTES.revokeOtherSessions],
    ] as const) {
      const response = await inject({
        method,
        url: `${API_PREFIX}${url}`,
        headers: { origin: ORIGIN },
      });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('lets the owner reset a helper over HTTP and refuses the helper the same', async () => {
    const ownerCookie = await signedIn();
    const helperCookie = await signedIn('helper', 'the-helpers-password');
    const ids = await api.container.admins.list(tenantA);
    const helper = ids.find((admin) => admin.username === 'helper')!;
    const ownerId = ids.find((admin) => admin.username === 'owner')!.id;

    const denied = await inject({
      method: 'POST',
      url: `${API_PREFIX}${ACCOUNT_SECURITY_ROUTES.adminSecondFactorReset(ownerId)}`,
      headers: as(helperCookie),
      payload: { reason: 'try' },
    });
    expect(denied.statusCode).toBe(403);

    const done = await inject({
      method: 'POST',
      url: `${API_PREFIX}${ACCOUNT_SECURITY_ROUTES.adminSecondFactorReset(helper.id)}`,
      headers: as(ownerCookie),
      payload: { reason: 'lost phone' },
    });
    expect(done.statusCode).toBe(201);
    const body = resetAdminSecondFactorResponseSchema.parse(done.json());
    expect(body.hadSecondFactor).toBe(false);
    expect(body.sessionsRevoked).toBe(1);
  });

  it('puts no secret in any response but its own, and none in a log line', async () => {
    const logged: string[] = [];
    const logger = api.container.logger as unknown as Record<string, (...args: unknown[]) => void>;
    const spies = (['trace', 'debug', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        logged.push(JSON.stringify(args));
      }),
    );
    try {
      const cookie = await signedIn();
      const { secret, backupCodes } = await enable(cookie);
      const responses: string[] = [];
      for (const url of [
        ACCOUNT_SECURITY_ROUTES.overview,
        ACCOUNT_SECURITY_ROUTES.sessions,
        ACCOUNT_SECURITY_ROUTES.events,
      ]) {
        responses.push(
          (await inject({ method: 'GET', url: `${API_PREFIX}${url}`, headers: { cookie } })).body,
        );
      }
      // A wrong proof's error echoes nothing it was given.
      responses.push(
        (
          await inject({
            method: 'POST',
            url: `${API_PREFIX}${ACCOUNT_SECURITY_ROUTES.totpDisable}`,
            headers: as(cookie),
            payload: { password: OWNER_PASSWORD, backupCode: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' },
          })
        ).body,
      );
      responses.push(
        (
          await inject({
            method: 'POST',
            url: `${API_PREFIX}${ACCOUNT_SECURITY_ROUTES.totpDisable}`,
            headers: as(cookie),
            payload: { password: OWNER_PASSWORD, code: 'abc' },
          })
        ).body,
      );
      const events = securityEventListResponseSchema.parse(JSON.parse(responses[2]!));
      expect(events.events.length).toBeGreaterThan(0);

      const all = [...responses, ...logged].join('\n');
      for (const needle of [secret, OWNER_PASSWORD, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', ...backupCodes]) {
        expect(all).not.toContain(needle);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
