import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  CONTROL_ROUTES,
  monitorProfileResponseSchema,
  operationalEventListResponseSchema,
  SESSION_COOKIE_NAME,
  settingListResponseSchema,
  settingWriteResponseSchema,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, testConfig } from './harness';

/**
 * Phase 3D, over real HTTP and a real database.
 *
 * Three things the browser tests cannot prove: that the management scope is
 * applied in SQL so a PAGE of results is a page of matching rows, that the four
 * new settings round-trip through the registry and the audit, and that the
 * monitor profile reports the deployment's own configuration.
 */

const ORIGIN = 'https://admin.example.test';

describe('the Web Admin V2 surface', () => {
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
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);

    await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    // `receipt_reviewer` holds neither `opslog.view` nor `panels.view`.
    await createAdmin(api.container, tenantA, {
      username: 'reviewer',
      password: 'the-reviewers-password',
      roleKeys: ['receipt_reviewer'],
    });

    ownerCookie = await cookieFor('owner', 'the-owners-real-password');
    supportCookie = await cookieFor('reviewer', 'the-reviewers-password');
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
  const idempotencyKey = () => `phase3d-${(keyCounter += 1)}-${Date.now()}`;

  // -------------------------------------------------------------------------
  // Owner revision 21 — the management scope
  // -------------------------------------------------------------------------

  describe('the management scope', () => {
    async function recordEvents(): Promise<void> {
      // Nine routine events and one management event, recorded in that order so
      // the management row is the OLDEST. A browser-side filter over a page of
      // five would show nothing at all and page past it.
      for (let index = 0; index < 9; index += 1) {
        await api.container.opsLog.record(tenantA, {
          code: 'panel.health.unreachable',
          severity: 'ERROR',
          message: `panel ${index} is unreachable`,
          dedupeKey: `panel:${index}`,
        });
      }
      await api.container.opsLog.record(tenantA, {
        code: 'admin.roles_change',
        severity: 'WARN',
        message: 'roles changed',
        dedupeKey: 'admin:1',
      });
    }

    it('returns only management codes, and returns them on the first page', async () => {
      await recordEvents();

      const body = operationalEventListResponseSchema.parse(
        (await get(`${CONTROL_ROUTES.opsLog}?scope=MANAGEMENT&limit=5`, ownerCookie)).json(),
      );

      expect(body.events.map((event) => event.code)).toEqual(['admin.roles_change']);
      // The point of applying it in SQL: `limit` bounds the MATCHING rows, so
      // the one management event is on the first page even though nine routine
      // events were recorded after it.
      expect(body.events).toHaveLength(1);
    });

    it('still returns the whole stream without the scope', async () => {
      await recordEvents();

      const body = operationalEventListResponseSchema.parse(
        (await get(`${CONTROL_ROUTES.opsLog}?limit=50`, ownerCookie)).json(),
      );
      expect(body.events).toHaveLength(10);
      expect(body.events.some((event) => event.code === 'panel.health.unreachable')).toBe(true);
    });

    it('matches an administrator code the enumeration does not list, by prefix', async () => {
      await api.container.opsLog.record(tenantA, {
        code: 'admin.some_future_change',
        severity: 'WARN',
        message: 'something new happened to an administrator',
        dedupeKey: 'admin:future',
      });

      const body = operationalEventListResponseSchema.parse(
        (await get(`${CONTROL_ROUTES.opsLog}?scope=MANAGEMENT`, ownerCookie)).json(),
      );
      expect(body.events.map((event) => event.code)).toContain('admin.some_future_change');
    });

    it('refuses an unknown scope rather than silently widening to the whole log', async () => {
      // A fall-back to ALL would show the alerts page the routine stream it
      // exists to exclude, and nothing would say so.
      const response = await get(`${CONTROL_ROUTES.opsLog}?scope=EVERYTHING`, ownerCookie);
      expect(response.statusCode).toBe(400);
    });

    it('refuses a caller without opslog.view, scope or no scope', async () => {
      expect(
        (await get(`${CONTROL_ROUTES.opsLog}?scope=MANAGEMENT`, supportCookie)).statusCode,
      ).toBe(403);
      expect((await get(CONTROL_ROUTES.opsLog, supportCookie)).statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Owner revisions 1, 22, 23, 24 — the four new settings
  // -------------------------------------------------------------------------

  describe('the settings the owner revisions add', () => {
    it('reports whether anything reads each key', async () => {
      const body = settingListResponseSchema.parse(
        (await get(CONTROL_ROUTES.settings, ownerCookie)).json(),
      );
      const byKey = new Map(body.settings.map((setting) => [setting.key, setting]));

      for (const key of [
        'sales.currency',
        'support.accounts',
        'telegram.channels',
        'wallet.topup.minimum',
      ]) {
        expect(byKey.get(key)?.consumer, key).toBe('PLANNED');
      }
      expect(byKey.get('ops.notifications.max_attempts')?.consumer).toBe('ACTIVE');
    });

    it('round-trips an ordered list of support accounts', async () => {
      const response = await post(CONTROL_ROUTES.setting('support.accounts'), ownerCookie, {
        value: ['@Support1', '@Support2', '@Support3'],
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
      });
      // 201: this creates the row. A replacement answers 200.
      expect(response.statusCode).toBe(201);

      const written = settingWriteResponseSchema.parse(response.json());
      expect(written.changed).toBe(true);
      // Order survives the round trip. It is data, not a rendering choice.
      expect(written.setting.value).toEqual(['@Support1', '@Support2', '@Support3']);

      const list = settingListResponseSchema.parse(
        (await get(CONTROL_ROUTES.settings, ownerCookie)).json(),
      );
      expect(list.settings.find((s) => s.key === 'support.accounts')?.value).toEqual([
        '@Support1',
        '@Support2',
        '@Support3',
      ]);
    });

    it('rejects a malformed handle and a repeat, at the server', async () => {
      for (const value of [['not-a-handle'], ['@Support1', '@support1'], ['@ab']]) {
        const response = await post(CONTROL_ROUTES.setting('support.accounts'), ownerCookie, {
          value,
          expectedVersion: null,
          idempotencyKey: idempotencyKey(),
        });
        expect(response.statusCode, JSON.stringify(value)).toBe(400);
      }
    });

    it('round-trips channels with their required-membership flag', async () => {
      const response = await post(CONTROL_ROUTES.setting('telegram.channels'), ownerCookie, {
        value: [
          { handle: '@Channel1', mandatory: true },
          { handle: '@NewsChannel', mandatory: false },
        ],
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
      });
      expect(response.statusCode).toBe(201);
      expect(settingWriteResponseSchema.parse(response.json()).setting.value).toEqual([
        { handle: '@Channel1', mandatory: true },
        { handle: '@NewsChannel', mandatory: false },
      ]);
    });

    it('refuses a channel with no answer to the membership question', async () => {
      const response = await post(CONTROL_ROUTES.setting('telegram.channels'), ownerCookie, {
        value: [{ handle: '@Channel1' }],
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
      });
      expect(response.statusCode).toBe(400);
    });

    it('stores the top-up minimum as an amount and a currency, and refuses a bare number', async () => {
      const ok = await post(CONTROL_ROUTES.setting('wallet.topup.minimum'), ownerCookie, {
        value: { amountMinor: '20000', currency: 'IRT' },
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
      });
      expect(ok.statusCode).toBe(201);

      const bare = await post(CONTROL_ROUTES.setting('wallet.topup.minimum'), ownerCookie, {
        value: 20000,
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
      });
      expect(bare.statusCode).toBe(400);
    });

    it('accepts Toman and Rial as the store currency and nothing else', async () => {
      // Every control-plane POST answers 201, replacement included — Nest's
      // default for @Post, and what the rest of this suite asserts. Worth
      // knowing rather than worth changing: the status is part of a shipped
      // API, and a create/replace distinction nobody currently reads is not
      // reason enough to move it.
      const first = await post(CONTROL_ROUTES.setting('sales.currency'), ownerCookie, {
        value: 'IRR',
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
      });
      expect(first.statusCode).toBe(201);
      const created = settingWriteResponseSchema.parse(first.json());
      expect(created.setting.value).toBe('IRR');

      const second = await post(CONTROL_ROUTES.setting('sales.currency'), ownerCookie, {
        value: 'IRT',
        expectedVersion: created.setting.version,
        idempotencyKey: idempotencyKey(),
      });
      expect(second.statusCode).toBe(201);
      expect(settingWriteResponseSchema.parse(second.json()).setting.value).toBe('IRT');

      // The catalogue in money.ts carries USD, EUR and USDT for a converted
      // payment quote. A STORE currency is a different question, and widening
      // it is a contract change to make when a gateway settles in one of them.
      const rejected = await post(CONTROL_ROUTES.setting('sales.currency'), ownerCookie, {
        value: 'USD',
        expectedVersion: settingWriteResponseSchema.parse(second.json()).setting.version,
        idempotencyKey: idempotencyKey(),
      });
      expect(rejected.statusCode).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Owner revision 18 — the monitor profile
  // -------------------------------------------------------------------------

  describe('the monitor profile', () => {
    it('reports the cadence and the capacity this deployment actually has', async () => {
      const response = await get(CONTROL_ROUTES.systemMonitor, ownerCookie);
      expect(response.statusCode).toBe(200);

      const { monitor } = monitorProfileResponseSchema.parse(response.json());
      expect(monitor.healthyIntervalMs).toBe(
        api.container.config.PANEL_MONITOR_HEALTHY_INTERVAL_MS,
      );
      expect(monitor.probeTenantLimit).toBe(api.container.config.PANEL_PROBE_TENANT_LIMIT);
      // Computed on the server, by the same functions the capacity conditions
      // use, so the screen and the alarm cannot disagree about a fleet fitting.
      expect(monitor.tenantFreshPanelCeiling).toBeGreaterThan(0);
      expect(monitor.installationFreshPanelCeiling).toBeGreaterThan(0);
    });

    it('refuses a caller without panels.view', async () => {
      expect((await get(CONTROL_ROUTES.systemMonitor, supportCookie)).statusCode).toBe(403);
    });

    it('refuses an anonymous caller', async () => {
      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${CONTROL_ROUTES.systemMonitor}`,
        headers: { origin: ORIGIN },
      });
      expect(response.statusCode).toBe(401);
    });
  });
});
