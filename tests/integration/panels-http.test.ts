import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  PANEL_ROUTES,
  panelListResponseSchema,
  panelResponseSchema,
  providerListResponseSchema,
  SESSION_COOKIE_NAME,
  testPanelResponseSchema,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  tenantB,
  testConfig,
} from './harness';

/**
 * Panels over real HTTP.
 *
 * The service-level suite proves the rules; this proves the WIRE. Three things
 * only exist at this layer and each has bitten a real product:
 *
 *   - the response projection, which is the one place a stored credential could
 *     become JSON;
 *   - authorization for an authenticated but unprivileged caller, because UI
 *     hiding is not authorization;
 *   - tenant scope taken from the SESSION rather than from anything the caller
 *     can type, which is what makes another tenant's panel id useless.
 */

const ORIGIN = 'https://admin.example.test';
const PASSWORD = 'http-layer-secret-value-Zx91';
const USERNAME = 'http-layer-username-Kw42';

describe('panel HTTP surface', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let supportCookie: string;
  let technicalCookie: string;
  let ownerB: Awaited<ReturnType<typeof createAdmin>>;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    // Loopback is allowed so one test can point a panel at a closed local port
    // and drive a REAL probe end to end. Production refuses this value at boot.
    const config = testConfig({
      WEB_ADMIN_ORIGINS: ORIGIN,
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
    });
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
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    // panels.view and panels.edit, but NOT panels.credentials.rotate.
    await createAdmin(api.container, tenantA, {
      username: 'technical',
      password: 'the-technical-password',
      roleKeys: ['technical'],
    });
    // No panel permission at all.
    await createAdmin(api.container, tenantA, {
      username: 'support',
      password: 'the-support-password',
      roleKeys: ['support'],
    });
    // Tenant B's owner exists in the database but CANNOT log in here: HTTP
    // login resolves against the installation tenant (ADR-0001, one install per
    // customer), so there is no session in which tenant B is the scope. That is
    // itself the strongest form of the isolation, and it is why the hostile
    // test below is shaped the way it is — tenant A's real, fully privileged
    // owner naming tenant B's real panel id.
    ownerB = await createAdmin(api.container, tenantB, {
      username: 'owner_b',
      password: 'the-other-owners-password',
      roleKeys: ['owner'],
    });

    ownerCookie = await cookieFor('owner', 'the-owners-real-password');
    technicalCookie = await cookieFor('technical', 'the-technical-password');
    supportCookie = await cookieFor('support', 'the-support-password');
  });

  async function cookieFor(username: string, password: string): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password },
    });
    const header = String(response.headers['set-cookie'] ?? '');
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(header);
    if (match === null) throw new Error(`No session cookie for ${username}.`);
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  const asAdmin = (cookie: string) => ({ cookie, origin: ORIGIN });
  const get = (path: string, cookie: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: asAdmin(cookie) });
  const post = (path: string, cookie: string, payload: unknown) =>
    inject({ method: 'POST', url: `${API_PREFIX}${path}`, headers: asAdmin(cookie), payload });

  let keyCounter = 0;
  const idempotencyKey = () => `http-key-${(keyCounter += 1)}-${Date.now()}`;

  async function createPanel(cookie: string, overrides: Record<string, unknown> = {}) {
    const response = await post(PANEL_ROUTES.create, cookie, {
      name: 'Frankfurt',
      providerType: 'marzban',
      baseUrl: 'https://panel.example.test',
      idempotencyKey: idempotencyKey(),
      ...overrides,
    });
    return response;
  }

  // -------------------------------------------------------------------------

  it('lists the providers this release can actually operate', async () => {
    const response = await get(PANEL_ROUTES.providers, ownerCookie);
    expect(response.statusCode).toBe(200);

    const body = providerListResponseSchema.parse(response.json());
    expect(body.providers.map((provider) => provider.key).sort()).toEqual(['marzban', 'sanaei']);
    // A catalogue of code: every tenant sees the same list, and it describes
    // what an adapter declares rather than what a panel row happens to say.
    const marzban = body.providers.find((provider) => provider.key === 'marzban');
    expect(marzban?.credentialShape).toBe('USERNAME_PASSWORD');
    expect(marzban?.capabilities.length).toBeGreaterThan(0);
  });

  it('creates a panel and returns credential STATE, never a value', async () => {
    const response = await createPanel(ownerCookie, {
      credentials: { username: USERNAME, password: PASSWORD },
    });
    expect(response.statusCode).toBe(201);

    const body = panelResponseSchema.parse(response.json());
    expect(body.panel.name).toBe('Frankfurt');
    expect(body.panel.providerName).toBe('Marzban');
    expect(body.panel.credentials.password.configured).toBe(true);
    expect(body.panel.credentials.password.lastReplacedAt).toEqual(expect.any(String));
    expect(body.panel.credentials.apiToken.configured).toBe(false);
    expect(body.panel.credentials.apiToken.lastReplacedAt).toBeNull();

    // Never checked, so the projected state says so rather than inventing a row.
    expect(body.panel.health.state).toBe('UNCHECKED');
    expect(body.panel.health.checkedAt).toBeNull();
    expect(body.panel.health.stale).toBe(false);

    // The whole rule, asserted against the raw payload rather than the parsed
    // object: no value, and no masked stand-in that could be resubmitted as one.
    expect(response.body).not.toContain(PASSWORD);
    expect(response.body).not.toContain(USERNAME);
    expect(response.body).not.toContain('****');
  });

  it('never returns a credential on any read path', async () => {
    const created = panelResponseSchema.parse(
      (
        await createPanel(ownerCookie, {
          credentials: { username: USERNAME, password: PASSWORD, apiToken: 'tok-http-9182' },
        })
      ).json(),
    );
    const id = created.panel.id;

    for (const response of [
      await get(PANEL_ROUTES.list, ownerCookie),
      await get(PANEL_ROUTES.detail(id), ownerCookie),
      await post(PANEL_ROUTES.update(id), ownerCookie, {
        name: 'Renamed',
        idempotencyKey: idempotencyKey(),
      }),
      await post(PANEL_ROUTES.credentials(id), ownerCookie, {
        credentials: { password: 'a-new-password-value-71' },
        idempotencyKey: idempotencyKey(),
      }),
      await post(PANEL_ROUTES.status(id), ownerCookie, {
        status: 'DISABLED',
        idempotencyKey: idempotencyKey(),
      }),
    ]) {
      expect(response.statusCode).toBeLessThan(400);
      for (const secret of [PASSWORD, USERNAME, 'tok-http-9182', 'a-new-password-value-71']) {
        expect(response.body, `a credential reached ${response.statusCode}`).not.toContain(secret);
      }
    }
  });

  it('refuses an unprivileged but authenticated caller', async () => {
    const created = panelResponseSchema.parse((await createPanel(ownerCookie)).json());

    expect((await get(PANEL_ROUTES.list, supportCookie)).statusCode).toBe(403);
    expect((await get(PANEL_ROUTES.detail(created.panel.id), supportCookie)).statusCode).toBe(403);
    expect((await createPanel(supportCookie, { name: 'Nope' })).statusCode).toBe(403);
  });

  it('refuses an anonymous caller', async () => {
    const response = await inject({
      method: 'GET',
      url: `${API_PREFIX}${PANEL_ROUTES.list}`,
      headers: { origin: ORIGIN },
    });
    expect(response.statusCode).toBe(401);
  });

  it('separates editing from rotating over HTTP', async () => {
    const created = panelResponseSchema.parse(
      (await createPanel(ownerCookie, { credentials: { password: PASSWORD } })).json(),
    );
    const id = created.panel.id;

    expect(
      (
        await post(PANEL_ROUTES.update(id), technicalCookie, {
          name: 'Renamed by technical',
          idempotencyKey: idempotencyKey(),
        })
      ).statusCode,
    ).toBe(201);

    expect(
      (
        await post(PANEL_ROUTES.credentials(id), technicalCookie, {
          credentials: { password: 'should-not-be-allowed' },
          idempotencyKey: idempotencyKey(),
        })
      ).statusCode,
    ).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Cross-tenant, over HTTP, with the id known to exist
  // -------------------------------------------------------------------------

  it('hides another tenant panel from every endpoint that names it', async () => {
    // Tenant B's panel, created through the service because tenant B has no way
    // to reach HTTP at all. Its id is a real, existing UUID.
    const foreign = await api.container.panels.create(tenantB, adminActorFor(ownerB), {
      name: 'Tenant B panel',
      providerType: 'marzban',
      baseUrl: 'https://other.example.test',
      credentials: { password: PASSWORD },
      idempotencyKey: idempotencyKey(),
    });
    const id = foreign.view.panel.id;

    // Tenant A's OWNER: every panel permission there is, and a real panel id.
    // The only thing they lack is the tenant, which is read from their session
    // and not from anything they can type.
    const responses = {
      read: await get(PANEL_ROUTES.detail(id), ownerCookie),
      update: await post(PANEL_ROUTES.update(id), ownerCookie, {
        name: 'stolen',
        idempotencyKey: idempotencyKey(),
      }),
      credentials: await post(PANEL_ROUTES.credentials(id), ownerCookie, {
        credentials: { password: 'taken-over' },
        idempotencyKey: idempotencyKey(),
      }),
      status: await post(PANEL_ROUTES.status(id), ownerCookie, {
        status: 'ARCHIVED',
        idempotencyKey: idempotencyKey(),
      }),
      test: await post(PANEL_ROUTES.test(id), ownerCookie, {
        idempotencyKey: idempotencyKey(),
      }),
    };

    for (const [name, response] of Object.entries(responses)) {
      // 404 rather than 403, and identically to an id that never existed: a
      // distinguishable "forbidden" turns any panel id into an oracle for
      // whether it exists somewhere on the installation.
      expect(response.statusCode, `${name} did not answer 404`).toBe(404);
      expect(response.body).not.toContain(PASSWORD);
    }

    // Tenant A's list never contained it, and all five left tenant B's panel
    // exactly as it was.
    expect(
      panelListResponseSchema.parse((await get(PANEL_ROUTES.list, ownerCookie)).json()).panels,
    ).toEqual([]);
    const after = await api.container.panels.get(tenantB, adminActorFor(ownerB), id);
    expect(after.panel.name).toBe('Tenant B panel');
    expect(after.panel.status).toBe('ACTIVE');
    expect(after.credentials.passwordSetAt).toBeInstanceOf(Date);
  });

  it('answers a nonexistent id exactly as it answers another tenant id', async () => {
    const missing = '01900000-0000-7000-8000-0000000fffff';
    expect((await get(PANEL_ROUTES.detail(missing), ownerCookie)).statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Health and status over the wire
  // -------------------------------------------------------------------------

  it('projects DISABLED health from the panel status rather than storing it', async () => {
    const created = panelResponseSchema.parse((await createPanel(ownerCookie)).json());
    const id = created.panel.id;

    const disabled = panelResponseSchema.parse(
      (
        await post(PANEL_ROUTES.status(id), ownerCookie, {
          status: 'DISABLED',
          idempotencyKey: idempotencyKey(),
        })
      ).json(),
    );
    expect(disabled.panel.status).toBe('DISABLED');
    expect(disabled.panel.health.state).toBe('DISABLED');

    // Re-enabling restores the underlying state with no health write, which is
    // the point of projecting it.
    const enabled = panelResponseSchema.parse(
      (
        await post(PANEL_ROUTES.status(id), ownerCookie, {
          status: 'ACTIVE',
          idempotencyKey: idempotencyKey(),
        })
      ).json(),
    );
    expect(enabled.panel.health.state).toBe('UNCHECKED');
  });

  it('refuses to test a panel that has no credentials', async () => {
    const created = panelResponseSchema.parse((await createPanel(ownerCookie)).json());
    const response = await post(PANEL_ROUTES.test(created.panel.id), ownerCookie, {
      idempotencyKey: idempotencyKey(),
    });
    expect(response.statusCode).toBe(412);
    expect(response.json()).toMatchObject({ error: { code: 'panel.credentials_missing' } });
  });

  it('reports a real probe failure as normalized health, with nothing raw in it', async () => {
    // A base URL that resolves to a loopback address with nothing listening.
    // The probe genuinely runs: this exercises the client, the adapter's error
    // normalization and the health write together, with no fake in the path.
    const created = panelResponseSchema.parse(
      (
        await createPanel(ownerCookie, {
          name: 'Nothing listening',
          baseUrl: 'http://127.0.0.1:9',
          credentials: { username: USERNAME, password: PASSWORD },
        })
      ).json(),
    );

    const response = await post(PANEL_ROUTES.test(created.panel.id), ownerCookie, {
      idempotencyKey: idempotencyKey(),
    });
    expect(response.statusCode).toBe(201);

    const body = testPanelResponseSchema.parse(response.json());
    expect(body.probed).toBe(true);
    expect(body.panel.health.state).toBe('UNREACHABLE');
    // A normalized kind, not an errno, not a stack, not a request dump.
    expect(body.panel.health.failure).toBe('UNREACHABLE');
    expect(body.panel.health.lastHealthyAt).toBeNull();
    expect(response.body).not.toContain(PASSWORD);
    expect(response.body).not.toContain(USERNAME);
    expect(response.body).not.toContain('ECONNREFUSED');

    // A failed probe changes health and nothing else. The legacy system's
    // nearest equivalent deleted service records on a provider error.
    expect(body.panel.status).toBe('ACTIVE');
    expect(body.panel.credentials.password.configured).toBe(true);
  });

  it('refuses a blocked target at create time with a code an operator can act on', async () => {
    const response = await createPanel(ownerCookie, {
      baseUrl: 'http://169.254.169.254/latest/meta-data/',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'panel.target_blocked' } });
  });

  it('refuses a URL carrying embedded credentials', async () => {
    const response = await createPanel(ownerCookie, {
      baseUrl: 'https://admin:hunter2@panel.example.test',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'panel.url_invalid' } });
    // And the refusal does not echo the credential back.
    expect(response.body).not.toContain('hunter2');
  });
});
