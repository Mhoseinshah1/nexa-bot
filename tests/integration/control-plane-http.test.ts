import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  CONTROL_ROUTES,
  featureFlagListResponseSchema,
  notificationDetailResponseSchema,
  operationalEventListResponseSchema,
  previewTemplateResponseSchema,
  SESSION_COOKIE_NAME,
  featureFlagWriteResponseSchema,
  settingListResponseSchema,
  settingWriteResponseSchema,
  templateListResponseSchema,
  templateRevisionListResponseSchema,
  templateViewSchema,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, testConfig } from './harness';

/**
 * The control plane over real HTTP.
 *
 * Driven through Fastify's `inject`. Two things matter here beyond the happy
 * path: that responses match the frozen schemas the web admin parses with, and
 * that an AUTHENTICATED but unprivileged caller is refused just as firmly as an
 * anonymous one. UI hiding is not authorization, and this is where that is
 * proven rather than asserted.
 */

const ORIGIN = 'https://admin.example.test';

describe('control plane HTTP surface', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let supportCookie: string;

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
    api.container.setInstallationTenant(tenantA.tenantId);

    await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    // `support` deliberately holds neither settings.edit nor templates.edit.
    await createAdmin(api.container, tenantA, {
      username: 'support',
      password: 'the-support-password',
      roleKeys: ['support'],
    });

    ownerCookie = await cookieFor('owner', 'the-owners-real-password');
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
  const idempotencyKey = () => `test-key-${(keyCounter += 1)}-${Date.now()}`;

  describe('settings', () => {
    it('returns every registered setting with its value, source and zero meaning', async () => {
      const response = await get(CONTROL_ROUTES.settings, ownerCookie);
      expect(response.statusCode).toBe(200);

      const body = settingListResponseSchema.parse(response.json());
      const destination = body.settings.find(
        (setting) => setting.key === 'ops.notifications.telegram_chat_id',
      );

      // Readable by rule. Roughly fifteen legacy settings screens never echo the
      // value they are about to replace, and the meaning of an empty one is
      // documented for exactly two settings in the whole product.
      expect(destination?.source).toBe('DEFAULT');
      expect(destination?.value).toBe('');
      expect(destination?.zeroMeaning).toBe('DISABLES');
      expect(destination?.version).toBeNull();
    });

    it('writes a value and returns the persisted row', async () => {
      const response = await post(
        CONTROL_ROUTES.setting('ops.notifications.max_attempts'),
        ownerCookie,
        { value: 3, expectedVersion: null, idempotencyKey: idempotencyKey() },
      );
      expect(response.statusCode).toBe(201);

      const body = settingWriteResponseSchema.parse(response.json());
      expect(body.setting.value).toBe(3);
      expect(body.setting.source).toBe('TENANT');
      expect(body.setting.version).toBe(1);
      expect(body.changed).toBe(true);

      // And it is readable afterwards, which is the whole rule.
      const readBack = settingListResponseSchema.parse(
        (await get(CONTROL_ROUTES.settings, ownerCookie)).json(),
      );
      expect(readBack.settings.find((s) => s.key === 'ops.notifications.max_attempts')?.value).toBe(
        3,
      );
    });

    it('says so when a write changes nothing', async () => {
      // "A no-op says so." The legacy screens answer success either way, and
      // one repair path said it three times while the product stayed broken.
      const key = CONTROL_ROUTES.setting('ops.notifications.max_attempts');
      await post(key, ownerCookie, {
        value: 3,
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
      });
      const again = await post(key, ownerCookie, {
        value: 3,
        expectedVersion: 1,
        idempotencyKey: idempotencyKey(),
      });

      const body = settingWriteResponseSchema.parse(again.json());
      expect(body.changed).toBe(false);
      // And the version did not move, because nothing was written.
      expect(body.setting.version).toBe(1);
    });

    it('refuses an unknown key rather than storing it', async () => {
      // The legacy settings write is an FSM prompt that takes whatever arrives
      // next, which is how an ordinary chat message overwrote a production
      // gateway setting (INCIDENT-FIN-001).
      const response = await post(CONTROL_ROUTES.setting('something.invented'), ownerCookie, {
        value: 'anything',
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'control.unknown_key' } });
    });

    it('refuses a value that does not match the declaration', async () => {
      const response = await post(
        CONTROL_ROUTES.setting('ops.notifications.max_attempts'),
        ownerCookie,
        { value: 99, expectedVersion: null, idempotencyKey: idempotencyKey() },
      );
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'control.invalid_value' } });
    });

    it('refuses a stale expectation instead of silently overwriting', async () => {
      const key = CONTROL_ROUTES.setting('ops.notifications.max_attempts');
      await post(key, ownerCookie, {
        value: 3,
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
      });

      // A second administrator who read version 1, while somebody else already
      // moved it on. In the legacy system the second save simply wins.
      await post(key, ownerCookie, {
        value: 4,
        expectedVersion: 1,
        idempotencyKey: idempotencyKey(),
      });
      const stale = await post(key, ownerCookie, {
        value: 5,
        expectedVersion: 1,
        idempotencyKey: idempotencyKey(),
      });

      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: { code: 'control.version_conflict' } });
    });

    it('refuses an authenticated caller who lacks settings.edit', async () => {
      // `support` can read (settings.view is not in its seed either, so this is
      // refused on the read too) — the point is that authentication is not
      // authorization.
      const response = await post(
        CONTROL_ROUTES.setting('ops.notifications.max_attempts'),
        supportCookie,
        { value: 3, expectedVersion: null, idempotencyKey: idempotencyKey() },
      );
      expect(response.statusCode).toBe(403);
    });

    it('refuses an anonymous caller', async () => {
      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${CONTROL_ROUTES.settings}`,
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('feature flags', () => {
    it('returns each flag with its configuration, marked inert while it is off', async () => {
      const body = featureFlagListResponseSchema.parse(
        (await get(CONTROL_ROUTES.features, ownerCookie)).json(),
      );
      const ops = body.flags.find((flag) => flag.key === 'ops_notifications');

      expect(ops?.enabled).toBe(false);
      expect(ops?.blastRadius).toBe('TENANT_WIDE');
      // The legacy pair sits on two screens with nothing saying the flag makes
      // the value do nothing. Here they arrive together and say it.
      expect(ops?.configuration.length).toBeGreaterThan(0);
      expect(ops?.configuration.every((setting) => setting.inert)).toBe(true);
    });

    it('refuses a tenant-wide toggle with no typed confirmation', async () => {
      const response = await post(CONTROL_ROUTES.feature('ops_notifications'), ownerCookie, {
        enabled: true,
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'control.confirmation_required' } });
    });

    it('accepts a confirmed toggle and stops marking the configuration inert', async () => {
      const response = await post(CONTROL_ROUTES.feature('ops_notifications'), ownerCookie, {
        enabled: true,
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
        confirmKey: 'ops_notifications',
        reason: 'Turning alerts on for the first time.',
      });
      expect(response.statusCode).toBe(201);

      const body = featureFlagWriteResponseSchema.parse(response.json());
      expect(body.flag.enabled).toBe(true);
      expect(body.changed).toBe(true);
      expect(body.flag.configuration.every((setting) => !setting.inert)).toBe(true);
    });
  });

  describe('templates', () => {
    const key = 'bot.ping.reply';

    it('returns raw bodies, never rendered ones', async () => {
      const body = templateListResponseSchema.parse(
        (await get(CONTROL_ROUTES.templates, ownerCookie)).json(),
      );
      const ping = body.templates.find((template) => template.key === key);

      // The placeholder survives. In the legacy system the edit screen shows the
      // RENDERED string, so the raw template cannot be read back from the screen
      // that edits it (TBR-TXT-004).
      expect(ping?.body).toContain('{correlationId}');
      expect(ping?.defaultBody).toContain('{correlationId}');
      expect(ping?.overrideBody).toBeNull();
      expect(ping?.source).toBe('DEFAULT');
    });

    it('refuses a body using a token the key does not declare', async () => {
      const response = await post(CONTROL_ROUTES.template(key), ownerCookie, {
        body: 'سلام {correlationI}',
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'control.template_invalid' } });
    });

    it('refuses a body that drops a required placeholder', async () => {
      const response = await post(CONTROL_ROUTES.template(key), ownerCookie, {
        body: 'سلام',
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
      });
      expect(response.statusCode).toBe(400);
    });

    it('stores an override, records a revision, and reverts by removing it', async () => {
      const set = await post(CONTROL_ROUTES.template(key), ownerCookie, {
        body: 'درود {correlationId}',
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
      });
      expect(set.statusCode).toBe(201);
      const stored = templateViewSchema.parse(set.json());
      expect(stored.source).toBe('TENANT');
      expect(stored.overrideBody).toBe('درود {correlationId}');
      expect(stored.version).toBe(1);

      const reverted = templateViewSchema.parse(
        (
          await post(CONTROL_ROUTES.templateRevert(key), ownerCookie, {
            expectedVersion: 1,
            idempotencyKey: idempotencyKey(),
          })
        ).json(),
      );

      // Reverting REMOVES the override. It does not copy today's default into
      // tenant storage, which is what lets an improved default reach them later.
      expect(reverted.source).toBe('DEFAULT');
      expect(reverted.overrideBody).toBeNull();
      expect(reverted.version).toBeNull();

      // And the history survives the revert, including the revert itself.
      const revisions = templateRevisionListResponseSchema.parse(
        (await get(CONTROL_ROUTES.templateRevisions(key), ownerCookie)).json(),
      );
      expect(revisions.revisions.map((r) => r.action)).toEqual(['REVERT', 'SET']);
      expect(revisions.revisions.find((r) => r.action === 'SET')?.body).toBe(
        'درود {correlationId}',
      );
      expect(revisions.revisions.find((r) => r.action === 'REVERT')?.body).toBeNull();
    });

    it('refuses a revert when there is nothing to revert', async () => {
      const response = await post(CONTROL_ROUTES.templateRevert(key), ownerCookie, {
        expectedVersion: 1,
        idempotencyKey: idempotencyKey(),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: { code: 'control.template_not_overridden' },
      });
    });

    it('stores a string value as a string, not as whatever JSON it resembles', async () => {
      // Regression. A bare string handed to a jsonb column was passed through as
      // already-serialized JSON, so '-1001234567890' became the NUMBER
      // -1001234567890, failed its own z.string() schema on the way back, and
      // the resolver fell back to the default — while the API answered 201.
      const digits = await post(
        CONTROL_ROUTES.setting('ops.notifications.telegram_chat_id'),
        ownerCookie,
        { value: '-1001234567890', expectedVersion: null, idempotencyKey: idempotencyKey() },
      );
      expect(digits.statusCode).toBe(201);
      expect(digits.json()).toMatchObject({
        setting: { value: '-1001234567890', source: 'TENANT' },
        changed: true,
      });

      const readBack = settingListResponseSchema.parse(
        (await get(CONTROL_ROUTES.settings, ownerCookie)).json(),
      );
      expect(
        readBack.settings.find((s) => s.key === 'ops.notifications.telegram_chat_id')?.value,
      ).toBe('-1001234567890');
    });

    it('previews with caller-supplied values and stores nothing', async () => {
      const preview = previewTemplateResponseSchema.parse(
        (
          await post(CONTROL_ROUTES.templatePreview(key), ownerCookie, {
            body: 'سلام {correlationId}',
            values: { correlationId: 'abc-123' },
          })
        ).json(),
      );
      expect(preview.rendered).toBe('سلام abc-123');

      // The stored body is untouched: previewing is not saving. Saving what the
      // preview shows is the legacy failure this design exists to prevent.
      const after = templateListResponseSchema.parse(
        (await get(CONTROL_ROUTES.templates, ownerCookie)).json(),
      );
      expect(after.templates.find((t) => t.key === key)?.overrideBody).toBeNull();
    });

    it('reports which placeholders a preview left unresolved', async () => {
      const preview = previewTemplateResponseSchema.parse(
        (
          await post(CONTROL_ROUTES.templatePreview(key), ownerCookie, {
            body: 'سلام {correlationId}',
            values: {},
          })
        ).json(),
      );
      expect(preview.unresolved).toEqual(['correlationId']);
      expect(preview.rendered).toContain('{correlationId}');
    });

    it('refuses an authenticated caller without templates.edit', async () => {
      const response = await post(CONTROL_ROUTES.template(key), supportCookie, {
        body: 'سلام {correlationId}',
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('the operational log', () => {
    it('is readable, filtered, by a caller holding opslog.view', async () => {
      await api.container.opsLog.record(tenantA, {
        code: 'panel.unreachable',
        severity: 'ERROR',
        message: 'down',
        dedupeKey: 'panel:1',
      });

      const body = operationalEventListResponseSchema.parse(
        (await get(`${CONTROL_ROUTES.opsLog}?severity=ERROR`, ownerCookie)).json(),
      );
      expect(body.events.map((event) => event.code)).toContain('panel.unreachable');
      expect(body.events[0]?.resolvedAt).toBeNull();
    });
  });

  describe('the notification test-send', () => {
    it('refuses when no destination is configured', async () => {
      const response = await post(CONTROL_ROUTES.notificationTest, ownerCookie, {});
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'control.destination_not_configured' },
      });
    });

    it('queues an intent once a destination exists', async () => {
      await post(CONTROL_ROUTES.setting('ops.notifications.telegram_chat_id'), ownerCookie, {
        value: '-1001234567890',
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
      });

      const response = await post(CONTROL_ROUTES.notificationTest, ownerCookie, {});
      expect(response.statusCode).toBe(201);

      const body = notificationDetailResponseSchema.parse(response.json());
      expect(body.notification.kind).toBe('OPERATIONS_TEST');
      expect(body.notification.status).toBe('PENDING');
      // Nothing has been attempted yet: creating the intent and sending it are
      // separate, and the second happens in the worker.
      expect(body.attempts).toEqual([]);

      // The response says where it is going only by not saying: the destination
      // identifies an internal operations channel and is not on this seam.
      expect(JSON.stringify(body)).not.toContain('-1001234567890');
    });
  });
});
