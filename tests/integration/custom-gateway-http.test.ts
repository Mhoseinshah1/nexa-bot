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
import { MockCustomBridge } from '../support/mock-custom-bridge';
import { createAdmin, migrateOnce, resetDatabase, tenantA, testConfig } from './harness';

/**
 * The custom gateway over HTTP (`docs/protocols/custom-gateway.md`): the Web Admin's write-only
 * secret and bridge-address routes, the enable refusals, and the public callback route's answers
 * — 200 for a verified callback (also for one naming nothing that exists), 401 for a bad or
 * stale signature, 400 for a body/header delivery-id mismatch, 403 for a sender outside the
 * allow-list. Callbacks are signed by the reference bridge with the secret stored here.
 */
const ORIGIN = 'https://admin.example.test';
const SECRET = 'cgw_http_SECRET_never_echoed_0d7e44b1a9c3f2';
const BASE = 'https://bridge.example/nexa';

describe('the custom gateway over HTTP', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let keyCounter = 0;
  const idempotencyKey = () => `cg-http-${(keyCounter += 1)}-${Date.now()}`;

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
  const get = (path: string) =>
    inject({
      method: 'GET',
      url: `${API_PREFIX}${path}`,
      headers: { cookie: ownerCookie, origin: ORIGIN },
    });

  async function configure(allowlist: readonly string[] = []) {
    const secret = await post(PAYMENT_GATEWAY_ROUTES.credential('CUSTOM'), {
      idempotencyKey: idempotencyKey(),
      apiKey: SECRET,
    });
    expect(secret.statusCode).toBe(201);
    expect(secret.body).not.toContain(SECRET);
    const endpoint = await post(PAYMENT_GATEWAY_ROUTES.endpoint('CUSTOM'), {
      idempotencyKey: idempotencyKey(),
      baseUrl: BASE,
      ipAllowlist: allowlist,
    });
    expect(endpoint.statusCode).toBe(201);
    return endpoint;
  }

  it('is DISABLED by default; enabling needs the secret, then the bridge address; the secret is never returned', async () => {
    const listed = paymentGatewayListResponseSchema.parse(
      (await get(PAYMENT_GATEWAY_ROUTES.list)).json(),
    );
    const custom = listed.gateways.find((gateway) => gateway.provider === 'CUSTOM');
    expect(custom).toMatchObject({
      status: 'DISABLED',
      credential: { required: true, setAt: null, webhookSecretSupported: false },
      endpoint: { baseUrl: null, ipAllowlist: [] },
    });
    // Every other route carries no endpoint at all.
    expect(listed.gateways.find((gateway) => gateway.provider === 'TONPAYS')?.endpoint).toBeNull();

    const noSecret = await post(PAYMENT_GATEWAY_ROUTES.status('CUSTOM'), {
      idempotencyKey: idempotencyKey(),
      status: 'ACTIVE',
    });
    expect(noSecret.statusCode).toBe(409);
    expect(noSecret.json().error.details).toMatchObject({ reason: 'CREDENTIAL_MISSING' });
    await post(PAYMENT_GATEWAY_ROUTES.credential('CUSTOM'), {
      idempotencyKey: idempotencyKey(),
      apiKey: SECRET,
    });
    const noEndpoint = await post(PAYMENT_GATEWAY_ROUTES.status('CUSTOM'), {
      idempotencyKey: idempotencyKey(),
      status: 'ACTIVE',
    });
    expect(noEndpoint.statusCode).toBe(409);
    expect(noEndpoint.json().error.details).toMatchObject({ reason: 'ENDPOINT_MISSING' });

    const http = await post(PAYMENT_GATEWAY_ROUTES.endpoint('CUSTOM'), {
      idempotencyKey: idempotencyKey(),
      baseUrl: 'http://bridge.example',
      ipAllowlist: [],
    });
    expect(http.statusCode).toBe(400);
    const saved = await post(PAYMENT_GATEWAY_ROUTES.endpoint('CUSTOM'), {
      idempotencyKey: idempotencyKey(),
      baseUrl: `${BASE}/`,
      ipAllowlist: ['203.0.113.0/24'],
    });
    expect(saved.json().gateway.endpoint).toEqual({
      baseUrl: BASE,
      ipAllowlist: ['203.0.113.0/24'],
    });
    const enabled = await post(PAYMENT_GATEWAY_ROUTES.status('CUSTOM'), {
      idempotencyKey: idempotencyKey(),
      status: 'ACTIVE',
    });
    expect(enabled.statusCode).toBe(201);
    const whileOn = await post(PAYMENT_GATEWAY_ROUTES.endpoint('CUSTOM'), {
      idempotencyKey: idempotencyKey(),
      baseUrl: 'https://elsewhere.example',
      ipAllowlist: [],
    });
    expect(whileOn.statusCode).toBe(409);
    expect(whileOn.json().error.details).toMatchObject({ reason: 'ENDPOINT_CHANGE_WHILE_ACTIVE' });
    expect((await get(PAYMENT_GATEWAY_ROUTES.list)).body).not.toContain(SECRET);
  });

  describe('the callback route', () => {
    const url = () => `/payments/webhook/custom/${String(tenantA.tenantId)}`;
    const bridge = () => new MockCustomBridge({ secret: SECRET, now: () => new Date() });
    const send = (
      signed: { body: string; headers: Record<string, string> },
      extra: Record<string, string> = {},
    ) =>
      inject({
        method: 'POST',
        url: url(),
        headers: { ...signed.headers, ...extra },
        payload: signed.body,
      });

    it('answers a verified callback 200 (even for an invoice it does not know), a forged or stale one 401', async () => {
      await configure();
      const ok = await send(
        bridge().callback('cg_NOTHINGHERE0000000000000000', { deliveryId: 'dlv-1' }),
      );
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ ok: true });
      const forged = await send(
        bridge().callback('cg_NOTHINGHERE0000000000000000', {
          deliveryId: 'dlv-2',
          secret: 'another-secret-another-secret-another',
        }),
      );
      expect(forged.statusCode).toBe(401);
      const stale = await send(
        bridge().callback('cg_NOTHINGHERE0000000000000000', {
          deliveryId: 'dlv-3',
          t: Math.floor(Date.now() / 1000) - 301,
        }),
      );
      expect(stale.statusCode).toBe(401);
      const unsigned = await send(
        bridge().callback('cg_NOTHINGHERE0000000000000000', { deliveryId: 'dlv-4' }),
        { 'x-nexa-bridge-signature': '' },
      );
      expect(unsigned.statusCode).toBe(401);
    });

    it('refuses a delivery id header that is not the body’s (400)', async () => {
      await configure();
      const signed = bridge().callback('cg_NOTHINGHERE0000000000000000', { deliveryId: 'dlv-a' });
      expect((await send(signed, { 'x-nexa-delivery-id': 'dlv-b' })).statusCode).toBe(400);
    });

    it('refuses a sender outside the allow-list (403) before the signature is read', async () => {
      // `inject` comes from 127.0.0.1.
      await configure(['203.0.113.0/24']);
      const signed = bridge().callback('cg_NOTHINGHERE0000000000000000', { deliveryId: 'dlv-ip' });
      expect((await send(signed)).statusCode).toBe(403);
      // On the list: answered.
      await post(PAYMENT_GATEWAY_ROUTES.endpoint('CUSTOM'), {
        idempotencyKey: idempotencyKey(),
        baseUrl: BASE,
        ipAllowlist: ['127.0.0.1'],
      });
      expect((await send(signed)).statusCode).toBe(200);
    });
  });
});
