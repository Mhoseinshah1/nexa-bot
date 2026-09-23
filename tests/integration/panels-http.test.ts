import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  CONTROL_ERROR_CODES,
  PANEL_ERROR_CODES,
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
  validatePanelConnection,
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
    // ONLY what this release has an ADAPTER for, which is the whole point of
    // the endpoint reading the registry rather than the descriptor catalogue:
    // for one release `sanaei` was in the catalogue with no adapter, and
    // advertising it would have offered a configuration every create rejects.
    // Phase 3B implemented it, so it is listed now — and it is listed because
    // the adapter exists, not because the name does.
    expect(body.providers.map((provider) => provider.key).sort()).toEqual([
      'marzban',
      // Listed because `RickpanelAdapter` exists and is registered, not because
      // the contract names the type: a provider with no adapter is a provider
      // this endpoint must not offer an operator.
      'rickpanel',
      'sanaei',
    ]);
    // A catalogue of code: every tenant sees the same list, and it describes
    // what an adapter declares rather than what a panel row happens to say.
    const marzban = body.providers.find((provider) => provider.key === 'marzban');
    expect(marzban?.credentialShape).toBe('USERNAME_PASSWORD');
    // EXACT, not "more than zero". A length assertion passes whatever the list
    // contains, which is how a catalogue advertising fourteen unimplemented
    // operations stayed green for a release.
    expect(marzban?.capabilities).toEqual([
      'HEALTH_CHECK',
      'CREATE_USER',
      'READ_USAGE',
      'DELIVER_SUBSCRIPTION_LINK',
      // The three that arrived only after `tests/acceptance/real-panel-marzban.test.ts`
      // drove the shipped adapter against a real v0.8.4. Implement, prove, THEN
      // advertise — and this endpoint is where advertising happens.
      'DISABLE_USER',
      'ENABLE_USER',
      'DELETE_USER',
      // And the commercial three, by the same route: A8 of that same acceptance drove
      // `applyAllowance` against the binary before any of these appeared here.
      'RENEW_USER',
      'ADD_VOLUME',
      'ADD_TIME',
    ]);
  });

  it('publishes for EVERY provider only what this release can execute', () => {
    // The catalogue is where a capability becomes a public claim. Written over
    // the whole response rather than per provider, so a provider added later
    // cannot advertise an unimplemented operation without failing here.
    return get(PANEL_ROUTES.providers, ownerCookie).then((response) => {
      const body = providerListResponseSchema.parse(response.json());
      expect(body.providers.length).toBeGreaterThan(0);
      /*
       * PER PROVIDER, and no longer the same list for both.
       *
       * The two used to publish an identical four, and the comment here said a
       * provider that later implemented a fifth would have to say so. This is that
       * case: `SanaeiAdapter.createUser` writes `limitIp` from the order's frozen
       * `deviceLimit` and `MarzbanAdapter.createUser` never reads the field, so
       * `LIMIT_DEVICES` is Sanaei's and only Sanaei's. Keeping one shared list would
       * mean this endpoint publishes a claim about Marzban that its adapter does not
       * honour, which is the whole failure this catalogue test exists to catch.
       */
      const PUBLISHED: Record<string, readonly string[]> = {
        marzban: [
          'HEALTH_CHECK',
          'CREATE_USER',
          'READ_USAGE',
          'DELIVER_SUBSCRIPTION_LINK',
          'DISABLE_USER',
          'ENABLE_USER',
          'DELETE_USER',
          'RENEW_USER',
          'ADD_VOLUME',
          'ADD_TIME',
        ],
        /*
         * Marzban's ten and one more, and NOT because RickPanel is a Marzban.
         *
         * The two are separate provider types precisely because they mean
         * different things by the same routes — `docs/rickpanel-adapter-audit.md`.
         * The lists shared ten entries because `RickpanelAdapter` implemented the
         * same ten operations, and they were written out separately so that one
         * moving would not silently move the other. That is what happened: rotation
         * moved RickPanel's list and left Marzban's where it was.
         *
         * `LIMIT_DEVICES` is absent: the RickPanel contract describes no field
         * for a device limit, so the adapter sends none and the endpoint must
         * not publish a promise nothing keeps. That asymmetry with Sanaei is the
         * whole reason this map is per provider.
         */
        rickpanel: [
          'HEALTH_CHECK',
          'CREATE_USER',
          'READ_USAGE',
          'DELIVER_SUBSCRIPTION_LINK',
          'DISABLE_USER',
          'ENABLE_USER',
          'DELETE_USER',
          'RENEW_USER',
          'ADD_VOLUME',
          'ADD_TIME',
          // The one RickPanel has and Marzban does not: `revoke_sub`, measured on the
          // owner's panel and proven per call by a read-back
          // (`docs/rickpanel-rotate-audit.md`). Named absent for the other two below.
          'ROTATE_SUBSCRIPTION_LINK',
        ],
        sanaei: [
          'HEALTH_CHECK',
          'CREATE_USER',
          'READ_USAGE',
          'DELIVER_SUBSCRIPTION_LINK',
          'LIMIT_DEVICES',
        ],
      };
      for (const provider of body.providers) {
        expect(PUBLISHED[provider.key], `${provider.key} has no expected list`).toBeDefined();
        expect(provider.capabilities, provider.key).toEqual(PUBLISHED[provider.key]);
        // And the ones with no code behind them are named, not inferred by omission —
        // a complement computed from the descriptor would pass whichever side a
        // capability moved to.
        for (const unimplemented of [
          'RESET_USAGE',
          'DELIVER_RAW_CONFIGS',
          'DELIVER_CONFIG_FILE',
          'INACTIVE_ACCOUNT_INBOUND',
        ]) {
          expect(provider.capabilities, `${provider.key}.${unimplemented}`).not.toContain(
            unimplemented,
          );
        }
        /*
         * Rotation left the shared list above when RickPanel gained it, so it is named
         * here on the two sides that still lack it — for the reason the management
         * three are named below.
         */
        if (provider.key !== 'rickpanel') {
          expect(provider.capabilities, `${provider.key}.ROTATE_SUBSCRIPTION_LINK`).not.toContain(
            'ROTATE_SUBSCRIPTION_LINK',
          );
        }
        /*
         * The management three, checked on the side that does NOT have them.
         *
         * They left the list above because Marzban implements them, and moving them out
         * without naming them here would have turned a checked absence into an
         * unchecked one for the provider the deferral is about. `docs/providers/sanaei-3xui.md`
         * records why 3X-UI does not have them: nobody has established how v3.7.0
         * disables, re-enables or deletes a client, so the product does not claim it.
         */
        if (provider.key === 'sanaei') {
          /*
           * Six now, not three. `RENEW_USER`, `ADD_VOLUME` and `ADD_TIME` joined the
           * Marzban side in Phase 4F and left this list for the same reason the
           * management three did: a capability that moves out of the shared
           * "unimplemented" list has to be named on the side that still lacks it, or a
           * checked absence quietly becomes an unchecked one for the provider the
           * owner's deferral is actually about.
           */
          for (const deferred of [
            'DISABLE_USER',
            'ENABLE_USER',
            'DELETE_USER',
            'RENEW_USER',
            'ADD_VOLUME',
            'ADD_TIME',
          ]) {
            expect(provider.capabilities, `sanaei.${deferred}`).not.toContain(deferred);
          }
        }
        // `LIMIT_DEVICES` is checked on the side it is NOT implemented, by name, for
        // the same reason: a provider that starts publishing it without writing the
        // field fails here.
        if (provider.key === 'marzban') {
          expect(provider.capabilities, 'marzban.LIMIT_DEVICES').not.toContain('LIMIT_DEVICES');
        }
      }
    });
  });

  it('gives a Marzban panel summary the same truthful capability set', async () => {
    // The per-panel view is a second code path onto the same descriptor, and a
    // summary that disagreed with the catalogue would be the split brain this
    // codebase exists to avoid.
    const created = await createPanel(ownerCookie, {
      name: 'Marzban surface',
      credentials: { username: USERNAME, password: PASSWORD },
    });
    expect(created.statusCode).toBe(201);
    const body = panelResponseSchema.parse(created.json());
    expect(body.panel.capabilities).toEqual([
      'HEALTH_CHECK',
      'CREATE_USER',
      'READ_USAGE',
      'DELIVER_SUBSCRIPTION_LINK',
      'DISABLE_USER',
      'ENABLE_USER',
      'DELETE_USER',
      'RENEW_USER',
      'ADD_VOLUME',
      'ADD_TIME',
    ]);
    // Named on the side that still lacks it: Marzban publishes ten and not eleven.
    expect(body.panel.capabilities).not.toContain('ROTATE_SUBSCRIPTION_LINK');
  });

  it('publishes for Sanaei only the capabilities this release implements', () => {
    // The named case, kept beside the generic one above: a regression that
    // somehow left other providers correct would still name Sanaei here.
    // This endpoint is where a capability becomes a public claim: whatever is
    // listed here is what the product tells an operator it can do. Phase 3B
    // implemented authentication, connection testing and a read-only health probe
    // for 3X-UI; Phase 4D added creating a client, reading its traffic and handing
    // back a subscription link. Anything beyond those four would be an
    // advertisement with no implementation behind it.
    return get(PANEL_ROUTES.providers, ownerCookie).then((response) => {
      const body = providerListResponseSchema.parse(response.json());
      const sanaei = body.providers.find((provider) => provider.key === 'sanaei');
      expect(sanaei?.capabilities).toEqual([
        'HEALTH_CHECK',
        'CREATE_USER',
        'READ_USAGE',
        'DELIVER_SUBSCRIPTION_LINK',
        // `createUser` writes `limitIp` from the order's frozen `deviceLimit`, and has
        // since Phase 4D. The descriptor understated it until the provisioner began
        // refusing device-limited orders on panels that cannot apply one.
        'LIMIT_DEVICES',
      ]);
      for (const unimplemented of [
        'RENEW_USER',
        'ADD_VOLUME',
        'ADD_TIME',
        'DELETE_USER',
        'DISABLE_USER',
        'ENABLE_USER',
      ]) {
        expect(sanaei?.capabilities, unimplemented).not.toContain(unimplemented);
      }
    });
  });

  it('gives a Sanaei panel summary the same truthful capability set', async () => {
    // The per-panel view reads the same descriptor as the catalogue. Asserted
    // separately because they are two code paths, and a panel summary that
    // disagreed with the catalogue would be the split brain this codebase
    // exists to avoid.
    const created = await createPanel(ownerCookie, {
      name: 'Sanaei surface',
      providerType: 'sanaei',
      credentials: { apiToken: 'a-token-for-the-surface-test' },
    });
    expect(created.statusCode).toBe(201);
    const body = panelResponseSchema.parse(created.json());
    expect(body.panel.capabilities).toEqual([
      'HEALTH_CHECK',
      'CREATE_USER',
      'READ_USAGE',
      'DELIVER_SUBSCRIPTION_LINK',
      'LIMIT_DEVICES',
    ]);
    expect(body.panel.capabilities).not.toContain('RENEW_USER');
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
    // SANAEI, because all three credential kinds have to be stored for this to
    // cover all three — and Marzban's shape does not name an API token, so the
    // service now refuses one for it. A panel whose provider accepts every kind
    // is the only fixture that can prove none of them comes back.
    const created = panelResponseSchema.parse(
      (
        await createPanel(ownerCookie, {
          name: 'Frankfurt 3X',
          providerType: 'sanaei',
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

  /**
   * T12 — a credential the provider's shape cannot use is REFUSED, at the
   * service, not merely hidden by the form.
   *
   * The descriptor was fetched, displayed and never acted on, so a Marzban
   * panel accepted an API token: stored, encrypted, audited — and then ignored
   * by `toProviderCredentials`, which reads only the fields the shape names. So
   * every connection test afterwards reported credentials missing about a
   * secret the operator had just successfully saved. Enforced on the server
   * because the form is not the authority and an API client bypasses it.
   */
  /**
   * The archive, both halves of it: a panel that leaves the list must still be
   * findable, and a panel that comes back must be able to.
   */
  describe('provider activation', () => {
    /*
     * The field that decides where every customer's subscription link points.
     *
     * `panels.activation` was readable by the provisioner and writable by nobody, so
     * every 3X-UI panel answered `ACTIVATION_INCOMPLETE` for ever and no service could
     * be provisioned onto one. Then it was writable and unreadable, which is the
     * write-only settings defect `docs/conventions.md` names — with the audit recording
     * only WHICH fields were given, on the ground that the panel read answers the rest.
     * These cases are what makes that ground true.
     */
    it('round-trips an activation through the write and the read', async () => {
      const created = panelResponseSchema.parse(
        (
          await createPanel(ownerCookie, {
            name: 'Activated',
            providerType: 'sanaei',
            activation: { subscriptionDomain: 'sub.example.test', inboundId: 3 },
          })
        ).json(),
      );
      expect(created.panel.activation).toEqual({
        subscriptionDomain: 'sub.example.test',
        inboundId: 3,
      });

      const read = panelResponseSchema.parse(
        (await get(PANEL_ROUTES.detail(created.panel.id), ownerCookie)).json(),
      );
      expect(read.panel.activation, 'readable without overwriting it').toEqual({
        subscriptionDomain: 'sub.example.test',
        inboundId: 3,
      });

      // An edit replaces it, and the new value is readable too.
      await post(PANEL_ROUTES.update(created.panel.id), ownerCookie, {
        activation: { subscriptionDomain: 'other.example.test', inboundId: 9 },
        idempotencyKey: idempotencyKey(),
      });
      const edited = panelResponseSchema.parse(
        (await get(PANEL_ROUTES.detail(created.panel.id), ownerCookie)).json(),
      );
      expect(edited.panel.activation).toEqual({
        subscriptionDomain: 'other.example.test',
        inboundId: 9,
      });

      // Absent leaves it; null clears it. The same three states credentials have.
      await post(PANEL_ROUTES.update(created.panel.id), ownerCookie, {
        name: 'Renamed',
        idempotencyKey: idempotencyKey(),
      });
      expect(
        panelResponseSchema.parse(
          (await get(PANEL_ROUTES.detail(created.panel.id), ownerCookie)).json(),
        ).panel.activation,
        'a rename does not erase the subscription domain',
      ).toEqual({ subscriptionDomain: 'other.example.test', inboundId: 9 });

      await post(PANEL_ROUTES.update(created.panel.id), ownerCookie, {
        activation: null,
        idempotencyKey: idempotencyKey(),
      });
      expect(
        panelResponseSchema.parse(
          (await get(PANEL_ROUTES.detail(created.panel.id), ownerCookie)).json(),
        ).panel.activation,
      ).toBeNull();
    });

    it('refuses an activation that is not this provider’s shape', async () => {
      /*
       * Parsed against `PANEL_ACTIVATION_SCHEMAS[providerType]`, never the union.
       *
       * Marzban's fields on a 3X-UI panel would otherwise be stored and only refused at
       * the first provision — when a customer has already paid and is waiting.
       */
      const refused = await createPanel(ownerCookie, {
        name: 'Wrong shape',
        providerType: 'sanaei',
        activation: { proxyProtocols: ['vless'] },
      });
      expect(refused.statusCode).toBe(400);
      /*
       * And it NAMES the fields, which is the difference between a refusal an operator
       * can act on and one they have to guess at.
       */
      expect(refused.json()).toMatchObject({
        error: {
          code: 'panel.request_invalid',
          details: {
            issues: [{ path: 'subscriptionDomain' }, { path: 'inboundId' }] as unknown,
          },
        },
      });

      const badDomain = await createPanel(ownerCookie, {
        name: 'Bad domain',
        providerType: 'sanaei',
        // A full URL, which would let a panel row name an origin the URL policy never saw.
        activation: { subscriptionDomain: 'https://sub.example.test/x', inboundId: 1 },
      });
      expect(badDomain.statusCode).toBe(400);
    });

    it('never returns an activation to a caller who may not read the panel', async () => {
      const created = panelResponseSchema.parse(
        (
          await createPanel(ownerCookie, {
            name: 'Scoped',
            providerType: 'sanaei',
            activation: { subscriptionDomain: 'sub.example.test', inboundId: 1 },
          })
        ).json(),
      );
      /*
       * `support` holds no `panels.view`, so the refusal happens before any projection.
       *
       * Asserted as an absence of the VALUE and not only as a 403, because the field
       * this test is about is the one an operator would not notice leaking.
       */
      const denied = await get(PANEL_ROUTES.detail(created.panel.id), supportCookie);
      expect(denied.statusCode).toBe(403);
      expect(JSON.stringify(denied.json())).not.toContain('sub.example.test');
    });
  });

  describe('the archive', () => {
    const archive = (id: string) =>
      post(PANEL_ROUTES.status(id), ownerCookie, {
        status: 'ARCHIVED',
        idempotencyKey: idempotencyKey(),
      });
    const restore = (id: string, extra: Record<string, unknown> = {}) =>
      post(PANEL_ROUTES.status(id), ownerCookie, {
        status: 'DISABLED',
        idempotencyKey: idempotencyKey(),
        ...extra,
      });
    const listOf = async (query = '') =>
      panelListResponseSchema.parse(
        (await get(`${PANEL_ROUTES.list}${query}`, ownerCookie)).json(),
      );

    it('drops an archived panel from the working fleet and keeps it in the archive', async () => {
      const live = panelResponseSchema.parse(
        (await createPanel(ownerCookie, { name: 'Live' })).json(),
      );
      const gone = panelResponseSchema.parse(
        (await createPanel(ownerCookie, { name: 'Retired' })).json(),
      );
      const archivedResponse = await archive(gone.panel.id);
      if (![200, 201].includes(archivedResponse.statusCode))
        console.log('DEBUG archive:', archivedResponse.body);
      expect([200, 201]).toContain(archivedResponse.statusCode);

      // The default list is the working fleet, and says nothing about the rest.
      const working = await listOf();
      expect(working.panels.map((row) => row.name)).toEqual(['Live']);

      // The archive is its own list, and contains ONLY the archived panel —
      // not the live one as well, which is what `includeArchived: true` would
      // have produced and is a different, less useful answer.
      const archived = await listOf('?archived=only');
      expect(archived.panels.map((row) => row.name)).toEqual(['Retired']);
      expect(archived.panels[0]?.status).toBe('ARCHIVED');
      expect(live.panel.id).not.toBe(gone.panel.id);
    });

    it('pages the archive with its own cursor', async () => {
      const ids: string[] = [];
      for (const name of ['A1', 'A2', 'A3']) {
        const created = panelResponseSchema.parse(
          (await createPanel(ownerCookie, { name })).json(),
        );
        ids.push(created.panel.id);
        await archive(created.panel.id);
      }

      const first = await listOf('?archived=only&limit=2');
      expect(first.panels).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = await listOf(
        `?archived=only&limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      );
      expect(second.panels).toHaveLength(1);
      expect(second.nextCursor).toBeNull();

      // Every archived panel appeared exactly once across the two pages.
      const walked = [...first.panels, ...second.panels].map((row) => row.id).sort();
      expect(walked).toEqual([...ids].sort());
    });

    /**
     * A cursor from one list applied to the other, and what really happens.
     *
     * The first version of this test archived nothing, so `crossed.panels` was
     * empty and its `for … expect` loop ran ZERO assertions while claiming the
     * server "refuses" a crossed cursor. It does not refuse: the cursor is an
     * opaque `(created_at, id)` keyset and the status predicate is applied
     * independently, so a crossed cursor SILENTLY SKIPS every archived row
     * older than it. That is the behaviour, it is why the Web Admin binds its
     * cursor trail to the mode it was minted in, and a test asserting a guard
     * that does not exist would have made the next reader believe the surface
     * did not need one.
     */
    it('silently skips archived rows older than a cursor minted by the live list', async () => {
      // An archived panel FIRST, so it is older than everything below it.
      const retired = panelResponseSchema.parse(
        (await createPanel(ownerCookie, { name: 'Retired and old' })).json(),
      );
      await archive(retired.panel.id);
      for (const name of ['L1', 'L2']) await createPanel(ownerCookie, { name });

      // It is in the archive when asked properly.
      const proper = await listOf('?archived=only');
      expect(proper.panels.map((row) => row.id)).toEqual([retired.panel.id]);

      // A cursor minted by the LIVE list names a row created after it.
      const liveFirst = await listOf('?limit=1');
      expect(liveFirst.nextCursor).not.toBeNull();

      const crossed = await listOf(
        `?archived=only&cursor=${encodeURIComponent(liveFirst.nextCursor as string)}`,
      );
      // The predicate still holds — no live panel leaks into the archive...
      for (const row of crossed.panels) expect(row.status).toBe('ARCHIVED');
      // ...but the archived panel is GONE, because the keyset walked past it.
      // This is the row an operator opened the archive to restore.
      expect(crossed.panels.map((row) => row.id)).not.toContain(retired.panel.id);
    });

    /**
     * The dead end, end to end.
     *
     * `panels_tenant_name_live_key` is UNIQUE `(tenant_id, name)` WHERE the
     * panel is not archived, so archiving RELEASES the name and a live panel
     * may take it. Restoring then re-enters that index. Before this, `setStatus`
     * had no name check at all: the collision arrived as a raw 23505, and
     * `update` refuses every edit to an archived panel — so the operator could
     * neither restore it nor rename it out of the way.
     */
    it('answers a modelled conflict when a restored name was taken, never a raw database error', async () => {
      const original = panelResponseSchema.parse(
        (await createPanel(ownerCookie, { name: 'Frankfurt A' })).json(),
      );
      await archive(original.panel.id);

      // The name is genuinely released: another live panel takes it.
      const claimant = await createPanel(ownerCookie, { name: 'Frankfurt A' });
      expect(claimant.statusCode).toBe(201);

      const conflict = await restore(original.panel.id);
      expect(conflict.statusCode).toBe(409);
      const body = conflict.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe(PANEL_ERROR_CODES.PANEL_NAME_TAKEN);
      // A modelled refusal that tells the operator what to do, not a 500.
      expect(body.error.message).toMatch(/different name/i);
    });

    it('restores under a replacement name, and the rename lands with the status', async () => {
      const original = panelResponseSchema.parse(
        (await createPanel(ownerCookie, { name: 'Frankfurt A' })).json(),
      );
      await archive(original.panel.id);
      await createPanel(ownerCookie, { name: 'Frankfurt A' });

      const restored = await restore(original.panel.id, { name: 'Frankfurt A (restored)' });
      expect([200, 201]).toContain(restored.statusCode);
      const view = panelResponseSchema.parse(restored.json());
      // BOTH halves, from the one response: the status moved and the name moved.
      expect(view.panel.status).toBe('DISABLED');
      expect(view.panel.name).toBe('Frankfurt A (restored)');

      // And it is in the working fleet again, under the new name.
      const working = await listOf();
      expect(working.panels.map((row) => row.name).sort()).toEqual([
        'Frankfurt A',
        'Frankfurt A (restored)',
      ]);
    });

    it('commits neither half when the replacement name is itself taken', async () => {
      const original = panelResponseSchema.parse(
        (await createPanel(ownerCookie, { name: 'Frankfurt A' })).json(),
      );
      await archive(original.panel.id);
      await createPanel(ownerCookie, { name: 'Taken' });

      const refused = await restore(original.panel.id, { name: 'Taken' });
      expect(refused.statusCode).toBe(409);

      // STILL archived, and still under its own name. A status change that
      // committed while the rename failed would leave a restored panel the
      // operator did not ask for.
      const after = panelResponseSchema.parse(
        (await get(PANEL_ROUTES.detail(original.panel.id), ownerCookie)).json(),
      );
      expect(after.panel.status).toBe('ARCHIVED');
      expect(after.panel.name).toBe('Frankfurt A');
    });

    /**
     * A restore that renames must SAY so, in both records.
     *
     * The audit row recorded only the status, so the one write an operator
     * would later need explained — who renamed this panel, and from what — was
     * recorded nowhere. And the operational event named `before.panel.name`,
     * which at that moment identifies a DIFFERENT, live panel: a log line
     * pointing at somebody else's machine.
     */
    it('records the rename in the audit row and names the panel as it now is', async () => {
      const original = panelResponseSchema.parse(
        (await createPanel(ownerCookie, { name: 'Frankfurt A' })).json(),
      );
      await archive(original.panel.id);
      await createPanel(ownerCookie, { name: 'Frankfurt A' });
      const restored = await restore(original.panel.id, { name: 'Frankfurt A (restored)' });
      expect([200, 201]).toContain(restored.statusCode);

      const audit = await api.container.database.db.execute(
        sql`SELECT before, after FROM audit_logs
             WHERE entity_id = ${original.panel.id} AND action = 'panel.status'
             ORDER BY occurred_at DESC LIMIT 1`,
      );
      const row = (audit.rows as { before: unknown; after: unknown }[])[0];
      expect(row?.before).toMatchObject({ name: 'Frankfurt A', status: 'ARCHIVED' });
      expect(row?.after).toMatchObject({ name: 'Frankfurt A (restored)', status: 'DISABLED' });

      const events = await api.container.database.db.execute(
        sql`SELECT message, context FROM operational_events
             WHERE code = 'panel.health.restored' ORDER BY last_seen_at DESC LIMIT 1`,
      );
      const event = (events.rows as { message: string; context: Record<string, unknown> }[])[0];
      // The name it HAS, not the one another panel now owns.
      expect(event?.message).toContain('Frankfurt A (restored)');
      expect(event?.context).toMatchObject({ panelName: 'Frankfurt A (restored)' });
    });

    it('refuses a replacement name on a transition that is not a restore', async () => {
      const panel = panelResponseSchema.parse(
        (await createPanel(ownerCookie, { name: 'Live one' })).json(),
      );
      // A rename smuggled into an ordinary status change is refused rather
      // than silently dropped — a discarded write is one the operator believes.
      const refused = await post(PANEL_ROUTES.status(panel.panel.id), ownerCookie, {
        status: 'DISABLED',
        name: 'Renamed by the back door',
        idempotencyKey: idempotencyKey(),
      });
      expect(refused.statusCode).toBe(400);

      const after = panelResponseSchema.parse(
        (await get(PANEL_ROUTES.detail(panel.panel.id), ownerCookie)).json(),
      );
      expect(after.panel.name).toBe('Live one');
    });

    it('still refuses an ordinary edit to an archived panel', async () => {
      const panel = panelResponseSchema.parse(
        (await createPanel(ownerCookie, { name: 'Retired again' })).json(),
      );
      await archive(panel.panel.id);

      const refused = await post(PANEL_ROUTES.update(panel.panel.id), ownerCookie, {
        name: 'Renamed while archived',
        idempotencyKey: idempotencyKey(),
      });
      expect(refused.statusCode).toBe(412);
      expect((refused.json() as { error: { code: string } }).error.code).toBe(
        PANEL_ERROR_CODES.PANEL_ARCHIVED,
      );
    });

    /**
     * Two operators restoring into the same free name at once.
     *
     * The pre-check runs inside the row lock, but the two requests lock
     * DIFFERENT rows, so the check alone cannot serialise them — the partial
     * unique index is what does. Whatever the interleaving, one must succeed
     * and the other must be a modelled refusal: an unhandled 23505 reaching the
     * error filter as a 500 is the outcome this whole finding is about.
     */
    it('never lets two competing restores escape as an unmodelled database error', async () => {
      const first = panelResponseSchema.parse(
        (await createPanel(ownerCookie, { name: 'Contested one' })).json(),
      );
      const second = panelResponseSchema.parse(
        (await createPanel(ownerCookie, { name: 'Contested two' })).json(),
      );
      await archive(first.panel.id);
      await archive(second.panel.id);

      const [a, b] = await Promise.all([
        restore(first.panel.id, { name: 'The same name' }),
        restore(second.panel.id, { name: 'The same name' }),
      ]);

      const succeeded = [a, b].filter((response) => [200, 201].includes(response.statusCode));
      const refused = [a, b].filter((response) => response.statusCode === 409);
      expect(succeeded, 'exactly one restore must succeed').toHaveLength(1);
      expect(refused, 'the loser is a modelled conflict').toHaveLength(1);
      for (const response of [a, b]) {
        expect(response.statusCode, 'no unmodelled database error escaped').not.toBe(500);
      }
    });
  });

  describe('the provider credential shape', () => {
    it('refuses an API token on a provider that authenticates with a password', async () => {
      const response = await createPanel(ownerCookie, {
        name: 'Marzban with a token',
        providerType: 'marzban',
        credentials: { username: USERNAME, password: PASSWORD, apiToken: 'tok-unusable-1' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'panel.credential_unsupported' },
      });
      // And no panel was written: a refusal is not a partial create.
      const list = panelListResponseSchema.parse(
        (await get(PANEL_ROUTES.list, ownerCookie)).json(),
      );
      expect(list.panels.map((one) => one.name)).not.toContain('Marzban with a token');
    });

    it('accepts the same token on a provider whose shape names it', async () => {
      // The other direction, so the rule is a shape check and not a blanket ban.
      const response = await createPanel(ownerCookie, {
        name: 'Sanaei with a token',
        providerType: 'sanaei',
        credentials: { apiToken: 'tok-usable-1' },
      });
      expect(response.statusCode).toBe(201);
    });

    /**
     * Codex, reviews seven and eight; fixed on the owner's instruction. Every
     * field of the credential object was optional, so `{}` — and, because
     * unknown keys are stripped, `{ api_token: "…" }` — was a valid write: the
     * service upserted a row with every column untouched, made the panel
     * probe-eligible, recorded a SUCCESS replacement naming no kinds, and
     * reported success. A write that names no credential is refused before it
     * reaches the lock, and leaves the credential row, the schedule and the
     * audit log exactly as they were. Null keeps its meaning; a create that
     * omits the object still means "no credentials".
     */
    it('refuses a credential write that names no credential, and writes nothing for it', async () => {
      const created = panelResponseSchema.parse(
        (
          await createPanel(ownerCookie, {
            name: 'Marzban with nothing to replace',
            providerType: 'marzban',
            credentials: { username: USERNAME, password: PASSWORD },
          })
        ).json(),
      );
      const db = api.container.database.db;
      const snapshot = async () => {
        const detail = panelResponseSchema.parse(
          (await get(PANEL_ROUTES.detail(created.panel.id), ownerCookie)).json(),
        );
        const schedule = await db.execute(
          sql`SELECT next_eligible_at, updated_at FROM panel_monitor_schedule WHERE panel_id = ${created.panel.id}`,
        );
        const audit = await db.execute(
          sql`SELECT count(*)::int AS n FROM audit_logs
               WHERE entity_id = ${created.panel.id} AND action = 'panel.credentials.replace'`,
        );
        return {
          credentials: detail.panel.credentials,
          schedule: schedule.rows[0],
          replacements: (audit.rows[0] as { n: number }).n,
        };
      };
      const before = await snapshot();

      for (const credentials of [{}, { api_token: 'tok-misspelled' }, { Username: 'x' }]) {
        const response = await post(PANEL_ROUTES.credentials(created.panel.id), ownerCookie, {
          credentials,
          idempotencyKey: idempotencyKey(),
        });
        const label = JSON.stringify(credentials);
        expect(response.statusCode, `${label} was not refused`).toBe(400);
        expect(response.json(), label).toMatchObject({ error: { kind: 'VALIDATION' } });
      }
      // Nothing moved: not the credential timestamps, not the schedule, not the
      // audit log. A refusal that had already written would be cosmetic.
      expect(await snapshot()).toEqual(before);

      // The same object on CREATE is refused the same way...
      const emptyOnCreate = await createPanel(ownerCookie, {
        name: 'Created with an empty credential object',
        credentials: {},
      });
      expect(emptyOnCreate.statusCode).toBe(400);
      expect(emptyOnCreate.json()).toMatchObject({ error: { kind: 'VALIDATION' } });
      // ...while OMITTING it is still a panel with no credentials...
      const withoutCredentials = await createPanel(ownerCookie, {
        name: 'Created with no credential object',
      });
      expect(withoutCredentials.statusCode).toBe(201);
      // ...and null keeps its meaning: a deliberate removal, accepted and applied.
      const removed = await post(PANEL_ROUTES.credentials(created.panel.id), ownerCookie, {
        credentials: { password: null },
        idempotencyKey: idempotencyKey(),
      });
      expect(removed.statusCode).toBeLessThan(400);
      const after = panelResponseSchema.parse(
        (await get(PANEL_ROUTES.detail(created.panel.id), ownerCookie)).json(),
      );
      expect(after.panel.credentials.password.configured).toBe(false);
      expect(after.panel.credentials.username.configured).toBe(true);
    });

    it('refuses the same credential on the ROTATE path, not only on create', async () => {
      const created = panelResponseSchema.parse(
        (
          await createPanel(ownerCookie, {
            name: 'Marzban rotating',
            providerType: 'marzban',
            credentials: { username: USERNAME, password: PASSWORD },
          })
        ).json(),
      );

      const rotated = await post(PANEL_ROUTES.credentials(created.panel.id), ownerCookie, {
        credentials: { apiToken: 'tok-unusable-2' },
        idempotencyKey: idempotencyKey(),
      });
      expect(rotated.statusCode).toBe(400);
      expect(rotated.json()).toMatchObject({
        error: { code: 'panel.credential_unsupported' },
      });

      // Nothing was stored for it, so the refusal is real rather than cosmetic.
      const after = panelResponseSchema.parse(
        (await get(PANEL_ROUTES.detail(created.panel.id), ownerCookie)).json(),
      );
      expect(after.panel.credentials.apiToken.configured).toBe(false);
      expect(after.panel.credentials.apiToken.lastReplacedAt).toBeNull();
      // ...and the credentials that ARE in the shape are untouched.
      expect(after.panel.credentials.password.configured).toBe(true);
    });

    /**
     * Initial credentials are a CREDENTIAL write.
     *
     * `setCredentials` is guarded by `panels.credentials.rotate`, which is
     * CRITICAL and separate from `panels.edit`. Create wrote
     * `command.credentials` under `panels.edit` alone — so an operator refused
     * when replacing a panel's password could set one by creating a panel. A
     * boundary one endpoint enforces and another does not is not a boundary.
     */
    it('refuses initial credentials from an actor who may not rotate them', async () => {
      // `technical` holds panels.view and panels.edit, not panels.credentials.rotate.
      const response = await post(PANEL_ROUTES.create, technicalCookie, {
        name: 'Created with secrets',
        providerType: 'marzban',
        baseUrl: 'https://panel.example.test',
        credentials: { username: USERNAME, password: PASSWORD },
        idempotencyKey: idempotencyKey(),
      });
      expect(response.statusCode).toBe(403);
      // And nothing was written: the refusal is not a partial create.
      const list = panelListResponseSchema.parse(
        (await get(PANEL_ROUTES.list, ownerCookie)).json(),
      );
      expect(list.panels.map((one) => one.name)).not.toContain('Created with secrets');
    });

    it('lets the same actor create a panel WITHOUT credentials', async () => {
      // The other direction: creating a panel and leaving its secrets to
      // somebody who holds the permission stays a `panels.edit` operation.
      const response = await post(PANEL_ROUTES.create, technicalCookie, {
        name: 'Created without secrets',
        providerType: 'marzban',
        baseUrl: 'https://panel.example.test',
        idempotencyKey: idempotencyKey(),
      });
      expect([200, 201], response.body).toContain(response.statusCode);
    });

    it('still allows REMOVING a credential outside the shape', async () => {
      // `null` means remove, and removing something the provider cannot use is
      // not a claim that it is usable — refusing it would strand a value stored
      // before this rule existed.
      const created = panelResponseSchema.parse(
        (
          await createPanel(ownerCookie, {
            name: 'Marzban clearing',
            providerType: 'marzban',
            credentials: { username: USERNAME, password: PASSWORD },
          })
        ).json(),
      );
      const cleared = await post(PANEL_ROUTES.credentials(created.panel.id), ownerCookie, {
        credentials: { apiToken: null },
        idempotencyKey: idempotencyKey(),
      });
      expect(cleared.statusCode).toBeLessThan(400);
    });
  });

  it('answers a malformed panel identifier with a 4xx, not a 500', async () => {
    // C13. `panels.id` is a `uuid` column, so a path segment that is not one
    // reached PostgreSQL as `invalid input syntax for type uuid` and came back
    // as an internal error with a stack in the log. Every panel route had it.
    for (const path of [
      PANEL_ROUTES.detail('not-a-uuid'),
      PANEL_ROUTES.update('not-a-uuid'),
      PANEL_ROUTES.credentials('not-a-uuid'),
      PANEL_ROUTES.status('not-a-uuid'),
      PANEL_ROUTES.test('not-a-uuid'),
    ]) {
      const response =
        path === PANEL_ROUTES.detail('not-a-uuid')
          ? await get(path, ownerCookie)
          : await post(path, ownerCookie, {
              idempotencyKey: idempotencyKey(),
              name: 'x',
              status: 'ACTIVE',
              credentials: {},
            });
      expect(response.statusCode, `${path} did not answer 4xx`).toBeGreaterThanOrEqual(400);
      expect(response.statusCode, `${path} answered a server error`).toBeLessThan(500);
      expect(response.json()).toMatchObject({ error: { kind: 'VALIDATION' } });
    }
  });

  it('refuses a malformed cursor with a 400 rather than restarting the traversal', async () => {
    /*
     * OWNER DECISION. A cursor this server did not mint is a 400.
     *
     * This test previously asserted the OPPOSITE — 200 with page one — and
     * asserted it strictly, so it is the falsification of the old rule as well
     * as the test for the new one. The old behaviour hid a client defect
     * behind a successful-looking response: a truncated or invented cursor
     * dropped the keyset predicate, the endpoint answered the first page, and
     * a paging client looped on it for ever with nothing anywhere saying so.
     *
     *   absent → first page · valid → next page · anything else → 400
     *
     * The same rule `/ops-log` and `/notifications` have always followed, and
     * the one the Web Admin client's docblock claimed all along.
     *
     * The id half still matters for the reason it always did: it reaches a
     * `uuid` column, so before it was validated `not-a-uuid:x` was a driver
     * error and a 500. A 400 and a 500 are different answers to different
     * questions and this asserts the first exactly.
     */
    const created = panelResponseSchema.parse((await createPanel(ownerCookie)).json());
    // TWO panels, so page one has a successor and the honoured-cursor
    // assertion at the end is not vacuous.
    await createPanel(ownerCookie, { name: 'Second panel for the cursor walk' });
    const firstPage = panelListResponseSchema.parse(
      (await get(`${PANEL_ROUTES.list}?limit=1`, ownerCookie)).json(),
    );
    expect(firstPage.panels).toHaveLength(1);

    const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
    const cursors = [
      // Not base64url at all.
      '!!!not base64!!!',
      // Decodes, but has no separator.
      b64('nothing-to-split-on'),
      // An empty id.
      b64(':2024-01-01T00:00:00.000Z'),
      // The shape of the bug: an id that is not a uuid.
      b64('not-a-uuid:2024-01-01T00:00:00.000Z'),
      b64(`../../etc/passwd:2024-01-01T00:00:00.000Z`),
      // A real uuid with a timestamp that is not one.
      b64(`${created.panel.id}:not-a-time`),
      b64(`${created.panel.id}:`),
      // In range for a JavaScript Date and OUT of range for `timestamptz`,
      // which raises 22008 at the cast — the same 500 by another route.
      b64(`${created.panel.id}:-005000-01-01T00:00:00.000000Z`),
      b64(`${created.panel.id}:275760-09-13T00:00:00.000000Z`),
      // YEAR ZERO. Four digits, so the shape regex passes it, and PostgreSQL
      // has no year zero — the one four-digit rendering it refuses, and the
      // one the "the four-digit year is load-bearing" docblock did not cover.
      b64(`${created.panel.id}:0000-01-01T00:00:00.000000Z`),
      // A date JavaScript rolls over and PostgreSQL refuses.
      b64(`${created.panel.id}:2026-02-30T00:00:00.000000Z`),
      b64(`${created.panel.id}:2026-13-01T00:00:00.000000Z`),
      // The right shape, the wrong precision: this API issues microseconds.
      b64(`${created.panel.id}:2026-01-01T00:00:00.000Z`),
      // Empty.
      '',
      // TRUNCATED — a real cursor with its tail cut off, which is the shape
      // the owner's decision names and the one a client actually produces.
      firstPage.nextCursor!.slice(0, Math.floor(firstPage.nextCursor!.length / 2)),
      // NONCANONICAL spellings of a REAL cursor. `Buffer.from(x, 'base64url')`
      // skips characters it cannot decode, so each of these decoded to the
      // original tuple and was answered with a 200 — a value this server never
      // issued, accepted. A cursor is ours only if it re-encodes to itself.
      `${firstPage.nextCursor!}!`,
      `${firstPage.nextCursor!.slice(0, 4)}*${firstPage.nextCursor!.slice(4)}`,
      `${firstPage.nextCursor!}=`,
    ];

    // The count is CITED — in `client.ts` and twice in the falsification
    // record — and it drifted: two places said thirteen, the commit message
    // said fifteen, and the fixture held fourteen. A number in prose that no
    // test asserts is a claim about testing with nothing behind it, so the
    // fixture now states its own size and a citation cannot go stale in
    // silence.
    expect(cursors, 'the cited malformed-cursor count changed').toHaveLength(18);

    for (const cursor of cursors) {
      const response = await get(
        `${PANEL_ROUTES.list}?limit=1&cursor=${encodeURIComponent(cursor)}`,
        ownerCookie,
      );
      const label = `cursor ${JSON.stringify(cursor.slice(0, 40))}`;
      // 400 EXACTLY, not merely 4xx, and never a 500: the first would let a
      // future 404 or 422 pass, the second is the driver error this validation
      // exists to stop.
      expect(response.statusCode, `${label} was not refused with a 400`).toBe(400);
      // A STABLE, machine-readable shape. A client that cannot tell "your
      // cursor is bad" from "you may not read this" is back to guessing.
      expect(response.json(), label).toMatchObject({
        error: { kind: 'VALIDATION', code: CONTROL_ERROR_CODES.INVALID_VALUE },
      });
      // And it did NOT quietly answer with data. This is the assertion that
      // makes the old behaviour impossible rather than merely unasserted.
      expect(response.json().panels, `${label} answered with a page anyway`).toBeUndefined();
    }

    /*
     * "Syntactically decodable but invalid" is where the owner's rule says
     * `400 where applicable`, and this is the case where it is NOT.
     *
     * A well-formed uuid at a well-formed instant naming no row is not a
     * malformed cursor — it is a legitimate POSITION whose row may simply have
     * been archived or deleted between two page requests, which is ordinary.
     * Refusing it would turn a routine race into an error the operator cannot
     * act on. It decodes, reaches the query, matches nothing, and the walk ends:
     * a 200 with an empty page and a null cursor.
     *
     * Asserted separately and deliberately, because conflating "I cannot read
     * this" with "this names nothing" is what would make the 400 loop above
     * pass for the wrong reason.
     */
    const unknownRow = panelListResponseSchema.parse(
      (
        await get(
          `${PANEL_ROUTES.list}?limit=1&cursor=${encodeURIComponent(
            Buffer.from(`${created.panel.id}:2099-01-01T00:00:00.000000Z`, 'utf8').toString(
              'base64url',
            ),
          )}`,
          ownerCookie,
        )
      ).json(),
    );
    expect(unknownRow.panels, 'a decodable cursor past the end is an empty page').toHaveLength(0);
    expect(unknownRow.nextCursor).toBeNull();

    // An OVERSIZED cursor is refused by the request schema at 512 characters,
    // before `decodeCursor` sees it — the same 400, by a different route and
    // with a DIFFERENT CODE. Asserted rather than folded into the loop,
    // because a test that accepted either answer would not notice if the two
    // rules swapped — and the code is asserted too, because the schema is now
    // the only length bound: the decoder carried a second copy that could not
    // fire, so nothing but this pins which refusal an oversize cursor gets.
    const oversize = await get(
      `${PANEL_ROUTES.list}?limit=1&cursor=${'A'.repeat(4_096)}`,
      ownerCookie,
    );
    expect(oversize.statusCode).toBe(400);
    expect(oversize.json()).toMatchObject({
      // The literal the error filter maps a `ZodError` to. Not a contract
      // constant — stated here rather than invented, because inventing one
      // would be a contract change wearing a test's clothes.
      error: { kind: 'VALIDATION', code: 'request.invalid' },
    });

    // A cursor this API issued is still honoured, so the validation did not
    // simply refuse everything.
    expect(firstPage.nextCursor).not.toBeNull();
    const second = panelListResponseSchema.parse(
      (
        await get(
          `${PANEL_ROUTES.list}?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
          ownerCookie,
        )
      ).json(),
    );
    expect(second.panels.map((panel) => panel.id)).not.toEqual(
      firstPage.panels.map((panel) => panel.id),
    );
    // And no cursor at all is still the first page, which is the third arm of
    // the rule and the one a regression would silently take with it.
    const restart = panelListResponseSchema.parse(
      (await get(`${PANEL_ROUTES.list}?limit=1`, ownerCookie)).json(),
    );
    expect(restart.panels.map((panel) => panel.id)).toEqual(
      firstPage.panels.map((panel) => panel.id),
    );
  });

  it("does not let a cursor naming another tenant's row reach it", async () => {
    /*
     * Tenant isolation survives the new refusal, shaped the way this file
     * already shapes it: there is no session in which tenant B is the scope
     * (login resolves against the installation tenant), so the hostile case is
     * tenant A's real, fully privileged owner presenting a cursor built from
     * tenant B's real panel id.
     *
     * It DECODES — a well-formed uuid at a well-formed instant — so it is not
     * a 400, and that is the point: the refusal added for malformed cursors
     * must not be mistaken for the thing that keeps tenants apart. The keyset
     * is tenant-scoped, so the walk simply finds nothing of B's.
     */
    const mine = panelResponseSchema.parse((await createPanel(ownerCookie)).json());
    const theirs = await api.container.panels.create(tenantB, adminActorFor(ownerB), {
      name: 'A panel belonging to the other tenant',
      providerType: 'marzban',
      baseUrl: 'https://other.example/api',
      credentials: { username: 'u', password: 'p' },
      idempotencyKey: 'cursor-isolation-b',
    });

    const cursor = Buffer.from(
      `${theirs.view.panel.id}:2020-01-01T00:00:00.000000Z`,
      'utf8',
    ).toString('base64url');
    const response = await get(
      `${PANEL_ROUTES.list}?limit=5&cursor=${encodeURIComponent(cursor)}`,
      ownerCookie,
    );
    // Decodable, so a 200 — not the 400 a malformed cursor gets.
    expect(response.statusCode).toBe(200);
    const body = panelListResponseSchema.parse(response.json());
    expect(
      body.panels.map((panel) => panel.id),
      "tenant B's panel must not appear in tenant A's page",
    ).not.toContain(theirs.view.panel.id);
    // And A's own row is still reachable, so the walk was not simply empty for
    // an unrelated reason.
    expect(body.panels.map((panel) => panel.id)).toContain(mine.panel.id);
  });

  it('refuses an unprivileged but authenticated caller', async () => {
    const created = panelResponseSchema.parse((await createPanel(ownerCookie)).json());

    expect((await get(PANEL_ROUTES.list, supportCookie)).statusCode).toBe(403);
    expect((await get(PANEL_ROUTES.detail(created.panel.id), supportCookie)).statusCode).toBe(403);
    expect((await createPanel(supportCookie, { name: 'Nope' })).statusCode).toBe(403);
  });

  it('does not decide 400-before-403 by a rule, and the cases are pinned one by one', async () => {
    /*
     * There is NO rule here. That is the finding, and it took three tries.
     *
     * The cursor refusal made the question visible: an unprivileged caller who
     * appends an unreadable cursor gets 400, where the same caller with no
     * cursor gets 403 and its `access.permission_denied` record — a security
     * fact about people that an operator is meant to be able to find.
     *
     * The first answer was "this is uniform, `limit=abc` does the same and so
     * does every other surface". FALSE: `POST /settings/:key`,
     * `POST /features/:key`, `POST /templates/:key` and `GET /panels/:id` hand
     * the raw value to the service, which authorizes first.
     *
     * The second answer was "a QUERY STRING is parsed in the controller and a
     * PATH PARAMETER or BODY is handed to the service". Also FALSE, in BOTH
     * directions, and each counter-example is on an endpoint that sentence
     * named. `GET /notifications/:id` parses `uuidV7Schema` in the controller
     * (`control.controller.ts`), so a malformed path id is 400 before the
     * guard. And `/ops-log` splits inside itself: `limit`, `since` and
     * `beforeId` are parsed in the controller, while `scope`, `severity` and
     * `code` reach `OpsLogService.list`, which calls `guard.check` BEFORE
     * `opsLogQuerySchema.parse` — so `?scope=BOGUS` is a 403 and `?limit=abc`
     * a 400, from the same caller against the same endpoint.
     *
     * FOUR rounds, four rules, four counter-examples — and "per-PARAMETER" was
     * the fourth of them. It is per (parameter, MALFORMATION): `singleValued`
     * refuses a REPEATED key in the controller, so `?scope=ALL&scope=ALL` is a
     * 400 from a caller for whom `?scope=BOGUS` is a 403. The sibling test in
     * `web-admin-v2.test.ts` pins that pair.
     *
     * This paragraph is the reason the correction is worth reading twice: the
     * round that corrected "per-PARAMETER" corrected it in the OTHER file and
     * left this one asserting the superseded rule — one file over, in the
     * sentence written to close exactly that.
     *
     * So this test states no rule. It pins the cases that exist here, in both
     * directions. The case that killed the LAST rule — a repeated key — lives
     * in the sibling file, because this endpoint has no service-parsed
     * parameter to contrast one against. And the consequence is written down
     * as an open question rather than argued away a FIFTH time (OQ-3D-02):
     * the fifth counter-example was that `PanelService` parsed every write
     * body before authorizing, which is fixed and pinned by
     * `records the denial even when the body is nonsense` below.
     *
     * What is genuinely true, and worth keeping: a 400 tells the caller
     * nothing about what they may read. The exposure is the missing audit
     * record, not a disclosure.
     */
    const denied = await get(PANEL_ROUTES.list, supportCookie);
    expect(denied.statusCode, 'a readable request from an unprivileged caller').toBe(403);

    // Refused BEFORE the guard: parsed in the controller.
    for (const query of ['limit=abc', 'cursor=not-a-cursor', 'archived=maybe']) {
      const response = await get(`${PANEL_ROUTES.list}?${query}`, supportCookie);
      expect(response.statusCode, `${query} did not pre-empt the guard`).toBe(400);
      // And no page: refusing early may not become answering early.
      expect(response.json().panels, `${query} answered with a page`).toBeUndefined();
    }

    // The same three from a privileged caller: still 400, so the refusal is
    // about the request rather than about the actor.
    for (const query of ['limit=abc', 'cursor=not-a-cursor', 'archived=maybe']) {
      expect(
        (await get(`${PANEL_ROUTES.list}?${query}`, ownerCookie)).statusCode,
        `${query} from a privileged caller`,
      ).toBe(400);
    }

    // Refused AFTER the guard: handed to the service. One route down, which is
    // what falsified the rule this test used to assert.
    expect(
      (await get(PANEL_ROUTES.detail('not-a-uuid'), supportCookie)).statusCode,
      'a malformed path id from an unprivileged caller',
    ).toBe(403);
    expect(
      (await get(PANEL_ROUTES.detail('not-a-uuid'), ownerCookie)).statusCode,
      'a malformed path id from a privileged caller',
    ).toBe(400);
  });

  it('records the denial even when the body is nonsense', async () => {
    /*
     * The fifth counter-example, and the one that was an audit hole.
     *
     * Every write on `PanelService` parsed the body BEFORE it authorized, and
     * a `ZodError` is a 400 that never reaches the guard. So an authenticated
     * caller without `panels.edit` who posted `{nonsense:true}` got a 400 and
     * left NO `access.permission_denied` row, while the same caller posting a
     * well-formed body got a 403 and did. That code is in
     * `MANAGEMENT_ONE_SHOT_CODES` because it is a security fact about people,
     * and it was suppressible by sending rubbish — including on
     * `POST /panels/:id/credentials`, the CRITICAL permission here.
     *
     * The claim it falsified was this file's own: "a PATH PARAMETER or BODY is
     * handed to the service, WHICH AUTHORIZES FIRST". True of the three
     * control endpoints that sentence named, false of every panel body
     * endpoint — correct where the author was looking and wrong one module
     * over, for the fifth time on this question.
     *
     * So this asserts the RECORD, not just the status. A test that only
     * checked the status could not tell 403-with-a-row from 403-without-one,
     * and the row is the whole point.
     */
    const created = panelResponseSchema.parse((await createPanel(ownerCookie)).json());
    const denials = async (): Promise<number> => {
      const rows = await api.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM operational_events WHERE code = 'access.permission_denied'`,
      );
      return Number((rows.rows[0] as { n: number }).n);
    };
    const id = created.panel.id;
    const routes = (body: (route: string) => unknown) =>
      [
        [PANEL_ROUTES.create, body('create')],
        [PANEL_ROUTES.update(id), body('update')],
        [PANEL_ROUTES.credentials(id), body('credentials')],
        [PANEL_ROUTES.status(id), body('status')],
        [PANEL_ROUTES.test(id), body('test')],
      ] as const;

    /** Which of the five a route is, so the well-formed body matches it. */
    const routeName = (route: string, panelId: string): string => {
      if (route === PANEL_ROUTES.create) return 'create';
      if (route === PANEL_ROUTES.credentials(panelId)) return 'credentials';
      if (route === PANEL_ROUTES.status(panelId)) return 'status';
      if (route === PANEL_ROUTES.test(panelId)) return 'test';
      return 'update';
    };

    const wellFormed = (route: string): unknown => {
      const key = idempotencyKey();
      if (route === 'create') {
        return {
          name: 'Denied create',
          providerType: 'marzban',
          baseUrl: 'https://panel.example.test',
          idempotencyKey: key,
        };
      }
      if (route === 'update') return { name: 'Denied update', idempotencyKey: key };
      if (route === 'credentials') {
        return { credentials: { password: PASSWORD }, idempotencyKey: key };
      }
      if (route === 'status') return { status: 'DISABLED', idempotencyKey: key };
      return { idempotencyKey: key };
    };

    /*
     * PER ROUTE, and with an ABSOLUTE floor as well as the comparison.
     *
     * The first version compared one aggregate delta against the other and
     * claimed to assert "the RECORD, not just the status". It did not: a
     * mutation that removed `recordMutationDenial` from the credentials path
     * left the whole file green, because BOTH loops lose the same rows and
     * `malformed === wellFormed` still held. A comparison cannot see a change
     * that affects both sides of it — the only thing discriminating was the
     * `toBe(403)` inside the loops, which is not what the docblock said.
     *
     * So each route is measured on its own — before, ONE denied request,
     * after — against BOTH ledgers: the operational events an operator reads
     * on the alerts page, and the DENIED audit row.
     *
     * The counts are EXACT, and they are ONE and ONE. For a round they were
     * pinned at TWO events and one audit row, because that is what a denial
     * wrote: `permission-guard` recorded the event when no transaction was
     * passed, and `recordMutationDenial` recorded it again. Pinning the
     * doubled count was truthful about the code and wrong about the system —
     * `access.permission_denied` never resolves, so an operator counting
     * denials counted double, permanently (OQ-3D-03, now closed). The guard
     * is the single authority now: it marks the error it throws when it wrote
     * the event, and `recordMutationDenial` writes one only when the guard
     * could not, which is inside a transaction.
     *
     * Exact on purpose. A floor cannot tell one recorder from two — that is
     * how the duplicate survived every earlier assertion — and it cannot tell
     * "the surviving recorder was removed" from "the duplicate was removed".
     * `toBe(1)` fails both ways: at 0 the denial vanished, at 2 it doubled.
     *
     * This is the PRE-TRANSACTION path, which is what these five routes take.
     * The in-transaction path is pinned at the unit level in
     * `authorization.test.ts`, where the guard's marker can be set either way.
     */
    const auditDenials = async (): Promise<number> => {
      const rows = await api.container.database.db.execute(
        // A refusal is an audit row whose `after` names the permission it was
        // refused. There is no `outcome` column: `recordMutationDenial`
        // encodes the refusal in the payload.
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE after ? 'deniedPermission'`,
      );
      return Number((rows.rows[0] as { n: number }).n);
    };

    const measure = async (route: string, body: unknown, label: string) => {
      const beforeEvents = await denials();
      const beforeAudit = await auditDenials();
      expect((await post(route, supportCookie, body)).statusCode, `${route} ${label}`).toBe(403);
      return {
        events: (await denials()) - beforeEvents,
        audit: (await auditDenials()) - beforeAudit,
      };
    };

    for (const [route, malformedBody] of routes(() => ({ nonsense: true }))) {
      const bad = await measure(route, malformedBody, 'malformed');
      const good = await measure(route, wellFormed(routeName(route, id)), 'well-formed');

      expect(bad.events, `${route}: operational events for ONE malformed denial`).toBe(1);
      expect(bad.audit, `${route}: DENIED audit rows for ONE malformed denial`).toBe(1);
      expect(good.events, `${route}: operational events for ONE well-formed denial`).toBe(1);
      expect(good.audit, `${route}: DENIED audit rows for ONE well-formed denial`).toBe(1);
      expect(bad.events, `${route}: a malformed body suppressed the event`).toBe(good.events);
      expect(bad.audit, `${route}: a malformed body suppressed the audit row`).toBe(good.audit);
    }
  });

  it('records the CREDENTIALS denial on create, even with a malformed body', async () => {
    /*
     * The gap the previous round left inside the file it fixed.
     *
     * `create`'s second guard — `panels.credentials.rotate`, the CRITICAL
     * permission — is gated on `parsed.credentials !== undefined`, so it
     * necessarily ran after the parse. An actor holding `panels.edit` but not
     * the rotate permission could therefore post credentials WITH a malformed
     * idempotency key, be answered 400, and leave no record; the same body
     * with a valid key was a 403 with both. Measured on the round that said
     * "fixed at all five sites".
     *
     * The first guard cannot see it: `supportCookie` holds no panel
     * permission at all and is refused before ever reaching the second, which
     * is why the sibling test above is blind to this cell. `technical` is the
     * actor that has one and not the other.
     */
    const denials = async (): Promise<number> => {
      const rows = await api.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE after ? 'deniedPermission'`,
      );
      return Number((rows.rows[0] as { n: number }).n);
    };
    const body = (idempotencyKey: unknown) => ({
      name: 'Credentials on create',
      providerType: 'marzban',
      baseUrl: 'https://panel.example.test',
      credentials: { password: PASSWORD },
      idempotencyKey,
    });

    /*
     * The PRECONDITION, asserted rather than described.
     *
     * This test is only about the second guard, and it is only about it while
     * `technical` holds `panels.edit` and not `panels.credentials.rotate`. If
     * that ever changes in `packages/contracts/src/permissions.ts`, both
     * requests below are refused at the FIRST guard and every assertion still
     * passes — measured: with `panels.edit` removed from the role AND the
     * raw-shape guard deleted, this test went green under exactly the
     * regression it exists to catch. So the two halves of the precondition are
     * checked here, in this test, where the reader is.
     */
    expect(
      (await createPanel(technicalCookie, { name: 'Technical may create' })).statusCode,
      'technical must hold panels.edit for this test to be about the second guard',
    ).toBe(201);

    const beforeBad = await denials();
    const refusal = await post(PANEL_ROUTES.create, technicalCookie, body('short'));
    expect(refusal.statusCode, 'a malformed key must not turn the CRITICAL denial into a 400').toBe(
      403,
    );
    expect(
      refusal.json().error.details?.permission,
      'the refusal must name the CREDENTIALS permission, not panels.edit',
    ).toBe('panels.credentials.rotate');
    const bad = (await denials()) - beforeBad;

    const beforeGood = await denials();
    expect(
      (await post(PANEL_ROUTES.create, technicalCookie, body(idempotencyKey()))).statusCode,
    ).toBe(403);
    const good = (await denials()) - beforeGood;

    expect(bad, 'a malformed body left no denial record').toBeGreaterThan(0);
    expect(bad, 'a malformed body suppressed the credentials denial').toBe(good);
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

    // Re-enabling needs a connection test that vouches for the panel's current
    // identity. Written through the production digest rather than the HTTP test
    // route, because this case's subject is the PROJECTION and standing up a
    // reachable fake panel to prove it would be a second suite's worth of
    // machinery for one precondition.
    await validatePanelConnection(api.container, tenantA, id);

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
    // HEALTHY, which is what the probe above actually stored — and a STRONGER
    // statement of the rule than the `UNCHECKED` this asserted before the panel
    // had to be validated to be enabled. `DISABLED` was projected OVER a real
    // stored state and re-enabling revealed it unchanged, which is precisely
    // what "projected rather than stored" means; the old version could not tell
    // a projection from a panel that had simply never been probed.
    expect(enabled.panel.health.state).toBe('HEALTHY');
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
    //
    // 127.0.0.2 rather than 127.0.0.1, and the difference is load-bearing: this
    // suite's database and cache answer on 127.0.0.1, so that address is on the
    // infrastructure denylist and a panel may not point at it. Any other
    // loopback address is an ordinary refused connection.
    const created = panelResponseSchema.parse(
      (
        await createPanel(ownerCookie, {
          name: 'Nothing listening',
          baseUrl: 'http://127.0.0.2:9',
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
