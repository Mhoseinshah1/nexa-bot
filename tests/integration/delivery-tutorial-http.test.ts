import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  DELIVERY_TUTORIAL_ROUTES,
  PANEL_ERROR_CODES,
  SESSION_COOKIE_NAME,
  deliveryTutorialResponseSchema,
  errorResponseSchema,
  updateDeliveryTutorialResponseSchema,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  testConfig,
} from './harness';

/**
 * Phase 2 item 5: the panel tutorial's routes over HTTP. Every response parses against its
 * contract schema, and the server — not the Web Admin's buttons — refuses what a role may not
 * do. `delivery-tutorial.test.ts` holds the rules; this holds the surface.
 */
const ORIGIN = 'https://admin.example.test';
const TEXT = 'کاربر گرامی، اتصال سرویس فقط از طریق Sing-box امکان‌پذیر است. {icon:warning}';

describe('panel tutorial HTTP surface', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let observerCookie: string;
  let panelId: string;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    const config = testConfig();
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  });

  afterAll(async () => {
    await api?.close();
  });

  async function cookieFor(username: string): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password: `the-${username}-password` },
    });
    const header = String(response.headers['set-cookie'] ?? '');
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(header);
    if (match === null) throw new Error(`No session cookie for ${username}: ${response.body}`);
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    for (const [username, role] of [
      ['owner', 'owner'],
      ['observer', 'observer'],
    ] as const) {
      await createAdmin(api.container, tenantA, {
        username,
        password: `the-${username}-password`,
        roleKeys: [role],
      });
    }
    ownerCookie = await cookieFor('owner');
    observerCookie = await cookieFor('observer');
    const owner = adminActorFor(
      await createAdmin(api.container, tenantA, { username: 'panel-owner', roleKeys: ['owner'] }),
    );
    const created = await api.container.panels.create(tenantA, owner, {
      name: 'Rick',
      providerType: 'rickpanel',
      baseUrl: 'https://rick.example.test',
      credentials: { username: 'rick', password: 'rick-password' },
      activation: {},
      idempotencyKey: 'panel-http-tutorial',
    });
    panelId = created.view.panel.id;
  });

  const get = (path: string, cookie: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: { cookie, origin: ORIGIN } });
  const post = (path: string, cookie: string, payload: unknown) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${path}`,
      headers: { cookie, origin: ORIGIN },
      payload,
    });

  it('reads on panels.view, writes on panels.edit, and refuses a stale or invalid body', async () => {
    const route = DELIVERY_TUTORIAL_ROUTES.tutorial(panelId);
    const unconfigured = await get(route, observerCookie);
    expect(unconfigured.statusCode).toBe(200);
    expect(deliveryTutorialResponseSchema.parse(unconfigured.json())).toEqual({
      tutorial: {
        panelId,
        mode: 'DISABLED',
        text: null,
        videoClientAppId: null,
        appliesToPurchase: true,
        appliesToTrial: true,
        revision: 0,
        updatedAt: null,
      },
      videoOptions: [],
    });

    const body = {
      idempotencyKey: 'tutorial-http-1',
      expectedRevision: 0,
      mode: 'TEXT',
      text: TEXT,
      videoClientAppId: null,
      appliesToPurchase: true,
      appliesToTrial: true,
    };
    const refused = await post(route, observerCookie, body);
    expect(refused.statusCode).toBe(403);
    const saved = await post(route, ownerCookie, body);
    expect(saved.statusCode).toBe(201);
    expect(updateDeliveryTutorialResponseSchema.parse(saved.json())).toMatchObject({
      changed: true,
      tutorial: { mode: 'TEXT', text: TEXT, revision: 1 },
    });

    const stale = await post(route, ownerCookie, { ...body, idempotencyKey: 'tutorial-http-2' });
    expect(stale.statusCode).toBe(409);
    expect(errorResponseSchema.parse(stale.json()).error.code).toBe(
      PANEL_ERROR_CODES.DELIVERY_TUTORIAL_STALE,
    );

    const markup = await post(route, ownerCookie, {
      ...body,
      idempotencyKey: 'tutorial-http-3',
      expectedRevision: 1,
      text: '<tg-emoji emoji-id="5368324170671202286">🔥</tg-emoji>',
    });
    expect(markup.statusCode).toBe(400);
  });
});
