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
import { DrizzleGatewayCredentialStore } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-credentials';
import { tonpaysSignatureOf } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-signature';
import { GATEWAY_WEBHOOK_BODY_LIMIT_BYTES } from '../../apps/api/src/surfaces/gateway/webhook.controller';
import { createAdmin, migrateOnce, resetDatabase, tenantA, testConfig } from './harness';

/**
 * WP11A over HTTP: the Web Admin's gateway routes and the public TonPays webhook.
 *
 * - the API key goes in through its own write-only route, and no response ever carries
 *   it back — not the credential route's answer, not the list;
 * - a route that needs a key cannot be switched on without one;
 * - the webhook answers `{ ok: true }` whether or not anything it names exists, refuses a
 *   body that is not a notification, reads no more than its own small limit, and names
 *   only external routes of the closed catalogue.
 */
const ORIGIN = 'https://admin.example.test';
const API_KEY = 'tp_live_http_key_never_echoed_5b1e';

describe('TonPays over HTTP', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let keyCounter = 0;
  const idempotencyKey = () => `tp-http-${(keyCounter += 1)}-${Date.now()}`;

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

  it('stores the key write-only, never returns it, and refuses to enable the route without one', async () => {
    const refused = await post(PAYMENT_GATEWAY_ROUTES.status('TONPAYS'), {
      idempotencyKey: idempotencyKey(),
      status: 'ACTIVE',
    });
    expect(refused.statusCode).toBe(409);

    const stored = await post(PAYMENT_GATEWAY_ROUTES.credential('TONPAYS'), {
      idempotencyKey: idempotencyKey(),
      apiKey: `  ${API_KEY}  `,
    });
    expect(stored.statusCode).toBe(201);
    expect(stored.body).not.toContain(API_KEY);
    expect(stored.json().gateway.credential.setAt).not.toBeNull();

    const enabled = await post(PAYMENT_GATEWAY_ROUTES.status('TONPAYS'), {
      idempotencyKey: idempotencyKey(),
      status: 'ACTIVE',
    });
    expect(enabled.statusCode).toBe(201);

    const listed = await get(PAYMENT_GATEWAY_ROUTES.list);
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(API_KEY);
    const parsedList = paymentGatewayListResponseSchema.parse(listed.json());
    const tonpays = parsedList.gateways.find((gateway) => gateway.provider === 'TONPAYS');
    expect(tonpays).toMatchObject({ status: 'ACTIVE', credential: { required: true } });
    // The wallet top-up readiness travels with the list: the active, keyed route has no blocker.
    expect(parsedList.walletTopup?.available).toBe(true);
    expect(
      parsedList.walletTopup?.routes.find((route) => route.provider === 'TONPAYS')?.blockers,
    ).toEqual([]);
    // The key was trimmed at the ends, and the stored value is exactly the key.
    const store = new DrizzleGatewayCredentialStore(
      api.container.database.db,
      api.container.cipher,
      () => api.container.ids.uuid(),
    );
    expect(await store.read(tenantA, 'TONPAYS')).toBe(API_KEY);
  });

  it('refuses a key for a route that takes none, and a key that is not a header value', async () => {
    const manual = await post(PAYMENT_GATEWAY_ROUTES.credential('MANUAL_TRANSFER'), {
      idempotencyKey: idempotencyKey(),
      apiKey: API_KEY,
    });
    expect(manual.statusCode).toBe(400);
    const spaced = await post(PAYMENT_GATEWAY_ROUTES.credential('TONPAYS'), {
      idempotencyKey: idempotencyKey(),
      apiKey: 'has a space',
    });
    expect(spaced.statusCode).toBe(400);
    expect(spaced.body).not.toContain('has a space');
  });

  it('answers the webhook the same way whether or not what it names exists', async () => {
    const body = {
      invoice_id: 'TP-UNKNOWN',
      order_id: 'NXUNKNOWNUNKNOWNUNKN',
      status: 'completed',
      paid: true,
      delivery_id: 'd-1',
    };
    for (const tenant of [String(tenantA.tenantId), '00000000-0000-7000-8000-000000000000', 'x']) {
      const response = await inject({
        method: 'POST',
        url: `/payments/webhook/tonpays/${tenant}`,
        headers: { 'x-tonpays-signature': 'unverifiable', 'x-api-key': 'whatever' },
        payload: body,
      });
      expect(response.statusCode, tenant).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    }
    const malformed = await inject({
      method: 'POST',
      url: `/payments/webhook/tonpays/${String(tenantA.tenantId)}`,
      payload: { hello: 'world' },
    });
    expect(malformed.statusCode).toBe(400);
    const manual = await inject({
      method: 'POST',
      url: `/payments/webhook/manual_transfer/${String(tenantA.tenantId)}`,
      payload: body,
    });
    expect(manual.statusCode).toBe(404);
    const huge = await inject({
      method: 'POST',
      url: `/payments/webhook/tonpays/${String(tenantA.tenantId)}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ ...body, padding: 'x'.repeat(GATEWAY_WEBHOOK_BODY_LIMIT_BYTES) }),
    });
    expect(huge.statusCode).toBe(413);
  });

  it('R7: with a webhook secret stored the route answers 401 to an unsigned, bad or stale webhook and 200 to a signed one', async () => {
    const WHSEC = 'tp_whsec_http_secret_never_echoed_91c4';
    await post(PAYMENT_GATEWAY_ROUTES.credential('TONPAYS'), {
      idempotencyKey: idempotencyKey(),
      apiKey: API_KEY,
    });
    const stored = await post(PAYMENT_GATEWAY_ROUTES.webhookSecret('TONPAYS'), {
      idempotencyKey: idempotencyKey(),
      secret: WHSEC,
    });
    expect(stored.statusCode).toBe(201);
    expect(stored.body).not.toContain(WHSEC);
    const listed = await get(PAYMENT_GATEWAY_ROUTES.list);
    expect(listed.body).not.toContain(WHSEC);
    const tonpays = paymentGatewayListResponseSchema
      .parse(listed.json())
      .gateways.find((gateway) => gateway.provider === 'TONPAYS');
    expect(tonpays?.credential.webhookSecretSupported).toBe(true);
    expect(tonpays?.credential.webhookSecretSetAt).not.toBeNull();

    const raw =
      '{"invoice_id":"TP-UNKNOWN","order_id":"NXUNKNOWNUNKNOWNUNKN","status":"completed","paid":true,"delivery_id":"TP-UNKNOWN:completed:1","description":"پرداخت"}';
    const url = `/payments/webhook/tonpays/${String(tenantA.tenantId)}`;
    const t = Math.floor(Date.now() / 1000);
    const signed = (at: number) =>
      `t=${String(at)},v1=${tonpaysSignatureOf(WHSEC, String(at), Buffer.from(raw, 'utf8'))}`;
    const send = (signature: string | undefined) =>
      inject({
        method: 'POST',
        url,
        headers: {
          'content-type': 'application/json',
          'x-tonpays-delivery-id': 'TP-UNKNOWN:completed:1',
          ...(signature === undefined ? {} : { 'x-tonpays-signature': signature }),
        },
        payload: raw,
      });
    expect((await send(undefined)).statusCode).toBe(401);
    expect((await send(`t=${String(t)},v1=${'a'.repeat(64)}`)).statusCode).toBe(401);
    expect((await send(signed(t - 301))).statusCode).toBe(401);
    expect((await send(signed(t - 299))).statusCode).toBe(200);
    expect((await send(signed(t))).json()).toEqual({ ok: true });

    const [rejected] = (
      await api.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM operational_events
            WHERE code = 'tonpays.webhook.signature_rejected'`,
      )
    ).rows as { n: number }[];
    expect(rejected?.n).toBe(1);
  });
});
