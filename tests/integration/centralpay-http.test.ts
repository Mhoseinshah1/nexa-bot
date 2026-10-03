import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  PAYMENT_GATEWAY_ROUTES,
  SESSION_COOKIE_NAME,
  paymentGatewayListResponseSchema,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, testConfig } from './harness';

/**
 * CentralPay over HTTP (`docs/centralpay-gateway-audit.md` §5.6–§5.7):
 *
 * - the API key and the verify key each go in through their own write-only route, and no
 *   response — the route's answer, the list — carries either back;
 * - the route cannot be switched on without both;
 * - no webhook route exists for it;
 * - the public browser-return GET redirects to the tenant's bot whatever the order id —
 *   it says nothing about which attempts exist, is never cached, and settles nothing.
 */
const ORIGIN = 'https://admin.example.test';
const API_KEY = 'cp_http_link_key_never_echoed_3b7d';
const VERIFY_KEY = 'cp_http_verify_key_never_echoed_a1c4';

describe('CentralPay over HTTP', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let keyCounter = 0;
  const idempotencyKey = () => `cp-http-${(keyCounter += 1)}-${Date.now()}`;

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
    const login = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner', password: 'the-owners-real-password' },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(login.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error('no session cookie');
    ownerCookie = `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  });

  const post = (path: string, payload: unknown) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${path}`,
      headers: { cookie: ownerCookie, origin: ORIGIN },
      payload,
    });

  it('stores the API key and the verify key write-only, and enables only with both', async () => {
    const early = await post(PAYMENT_GATEWAY_ROUTES.verifyKey('CENTRALPAY'), {
      idempotencyKey: idempotencyKey(),
      verifyKey: VERIFY_KEY,
    });
    expect(early.statusCode).toBe(409);
    expect(early.body).not.toContain(VERIFY_KEY);

    const key = await post(PAYMENT_GATEWAY_ROUTES.credential('CENTRALPAY'), {
      idempotencyKey: idempotencyKey(),
      apiKey: API_KEY,
    });
    expect(key.statusCode).toBe(201);
    expect(key.body).not.toContain(API_KEY);
    expect(key.json().gateway.credential).toMatchObject({
      required: true,
      verifyKeyRequired: true,
      verifyKeySetAt: null,
      webhookSecretRequired: false,
    });
    // No public origin is registered here, so no return URL can be generated yet.
    expect(key.json().gateway.callbackUrl).toBeNull();

    const refused = await post(PAYMENT_GATEWAY_ROUTES.status('CENTRALPAY'), {
      idempotencyKey: idempotencyKey(),
      status: 'ACTIVE',
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain('VERIFY_KEY_MISSING');

    const verify = await post(PAYMENT_GATEWAY_ROUTES.verifyKey('CENTRALPAY'), {
      idempotencyKey: idempotencyKey(),
      verifyKey: `  ${VERIFY_KEY}  `,
    });
    expect(verify.statusCode).toBe(201);
    expect(verify.body).not.toContain(VERIFY_KEY);
    expect(verify.json().gateway.credential.verifyKeySetAt).not.toBeNull();

    const enabled = await post(PAYMENT_GATEWAY_ROUTES.status('CENTRALPAY'), {
      idempotencyKey: idempotencyKey(),
      status: 'ACTIVE',
    });
    expect(enabled.statusCode).toBe(201);

    const listed = await inject({
      method: 'GET',
      url: `${API_PREFIX}${PAYMENT_GATEWAY_ROUTES.list}`,
      headers: { cookie: ownerCookie, origin: ORIGIN },
    });
    expect(listed.body).not.toContain(API_KEY);
    expect(listed.body).not.toContain(VERIFY_KEY);
    const centralpay = paymentGatewayListResponseSchema
      .parse(listed.json())
      .gateways.find((gateway) => gateway.provider === 'CENTRALPAY');
    expect(centralpay?.status).toBe('ACTIVE');

    // A route with no separate verify key takes none; CentralPay offers no credential check.
    const tonpays = await post(PAYMENT_GATEWAY_ROUTES.verifyKey('TONPAYS'), {
      idempotencyKey: idempotencyKey(),
      verifyKey: VERIFY_KEY,
    });
    expect(tonpays.statusCode).toBe(400);
    const check = await post(PAYMENT_GATEWAY_ROUTES.check('CENTRALPAY'), {
      idempotencyKey: idempotencyKey(),
    });
    expect(check.statusCode).toBe(400);
  });

  it('has no webhook, and its browser return redirects to the bot whatever it names', async () => {
    const webhook = await inject({
      method: 'POST',
      url: `/payments/webhook/centralpay/${String(tenantA.tenantId)}`,
      payload: { orderId: 1234567890, success: true },
    });
    expect(webhook.statusCode).toBe(404);

    // The tenant's first active bot, by its STORED username (no Telegram call on a GET).
    const [bot] = (
      await api.container.database.db.execute(
        sql`SELECT username FROM bot_instances WHERE tenant_id = ${tenantA.tenantId}
              AND status = 'ACTIVE' ORDER BY created_at, id LIMIT 1`,
      )
    ).rows as { username: string }[];
    expect(bot?.username).toBeDefined();
    const url = (orderId: string) =>
      `/payments/return/centralpay/${String(tenantA.tenantId)}?orderId=${orderId}`;
    for (const orderId of ['1234567890', 'junk', '']) {
      const back = await inject({ method: 'GET', url: url(orderId) });
      expect(back.statusCode).toBe(302);
      expect(back.headers.location).toBe(`https://t.me/${String(bot?.username)}`);
      expect(back.headers['cache-control']).toBe('no-store');
    }
    // An unknown tenant has no bot to name, and is answered without one.
    const stranger = await inject({
      method: 'GET',
      url: '/payments/return/centralpay/00000000-0000-4000-8000-00000000dead?orderId=1',
    });
    expect(stranger.statusCode).toBe(200);
    expect(stranger.json()).toEqual({ ok: true });
    // A route that is not a browser-return route has no return URL.
    const tonpays = await inject({
      method: 'GET',
      url: `/payments/return/tonpays/${String(tenantA.tenantId)}?orderId=1`,
    });
    expect(tonpays.statusCode).toBe(404);
  });
});
