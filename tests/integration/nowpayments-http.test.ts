import { createHmac } from 'node:crypto';
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
import { sortDeep } from '../../apps/api/src/modules/commerce/payments/infrastructure/nowpayments-signature';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  testConfig,
} from './harness';

/**
 * NOWPayments over HTTP (`docs/nowpayments-gateway-audit.md` §5.6–§5.7):
 *
 * - the API key and the IPN secret each go in through their own write-only route, and no
 *   response — the route's answer, the list — carries either back;
 * - the route cannot be switched on without both;
 * - the public webhook hands the `x-nowpayments-sig` header to verification: an unsigned
 *   or wrongly signed notification is answered `{ ok: true }` and dropped, and a correctly
 *   signed one is verified (the "unverified" condition it raised is recovered);
 * - the credential check refuses a route that offers none, and a route with no key, before
 *   any provider call.
 */
const ORIGIN = 'https://admin.example.test';
const API_KEY = 'np_live_http_key_never_echoed_8c2a';
const IPN_SECRET = 'np_http_ipn_secret_never_echoed_19ff';

describe('NOWPayments over HTTP', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let keyCounter = 0;
  const idempotencyKey = () => `np-http-${(keyCounter += 1)}-${Date.now()}`;

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
    const admin = await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    // A route priced only by the central rate is switched on only while that rate is on
    // (spec §8, #143); this file is about NOWPayments' own preconditions, so the rate is on.
    const centralFx = await api.container.featureFlagResolver.resolve(tenantA, 'central_fx');
    await api.container.featureFlags.set(tenantA, adminActorFor(admin), {
      key: 'central_fx',
      enabled: true,
      expectedVersion: centralFx.version,
      idempotencyKey: idempotencyKey(),
      reason: 'NOWPayments HTTP integration test.',
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

  const openConditions = async () =>
    (
      (
        await api.container.database.db.execute(
          sql`SELECT code FROM operational_events WHERE tenant_id = ${tenantA.tenantId} AND resolved_at IS NULL`,
        )
      ).rows as { code: string }[]
    ).map((row) => row.code);

  it('stores the key and the IPN secret write-only, and enables only with both', async () => {
    const early = await post(PAYMENT_GATEWAY_ROUTES.webhookSecret('NOWPAYMENTS'), {
      idempotencyKey: idempotencyKey(),
      secret: IPN_SECRET,
    });
    expect(early.statusCode).toBe(409);
    expect(early.body).not.toContain(IPN_SECRET);

    const key = await post(PAYMENT_GATEWAY_ROUTES.credential('NOWPAYMENTS'), {
      idempotencyKey: idempotencyKey(),
      apiKey: API_KEY,
    });
    expect(key.statusCode).toBe(201);
    expect(key.body).not.toContain(API_KEY);
    expect(key.json().gateway.credential).toMatchObject({
      required: true,
      webhookSecretRequired: true,
      webhookSecretSetAt: null,
    });

    const refused = await post(PAYMENT_GATEWAY_ROUTES.status('NOWPAYMENTS'), {
      idempotencyKey: idempotencyKey(),
      status: 'ACTIVE',
    });
    expect(refused.statusCode).toBe(409);

    const secret = await post(PAYMENT_GATEWAY_ROUTES.webhookSecret('NOWPAYMENTS'), {
      idempotencyKey: idempotencyKey(),
      secret: `  ${IPN_SECRET}  `,
    });
    expect(secret.statusCode).toBe(201);
    expect(secret.body).not.toContain(IPN_SECRET);
    expect(secret.json().gateway.credential.webhookSecretSetAt).not.toBeNull();

    const enabled = await post(PAYMENT_GATEWAY_ROUTES.status('NOWPAYMENTS'), {
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
    expect(listed.body).not.toContain(IPN_SECRET);
    const nowpayments = paymentGatewayListResponseSchema
      .parse(listed.json())
      .gateways.find((gateway) => gateway.provider === 'NOWPAYMENTS');
    expect(nowpayments?.status).toBe('ACTIVE');

    // A route that signs nothing takes no secret.
    const tonpays = await post(PAYMENT_GATEWAY_ROUTES.webhookSecret('TONPAYS'), {
      idempotencyKey: idempotencyKey(),
      secret: IPN_SECRET,
    });
    expect(tonpays.statusCode).toBe(400);
  });

  it('refuses a credential check for a route that offers none, or has no key, before any call', async () => {
    const tonpays = await post(PAYMENT_GATEWAY_ROUTES.check('TONPAYS'), {
      idempotencyKey: idempotencyKey(),
    });
    expect(tonpays.statusCode).toBe(400);
    const keyless = await post(PAYMENT_GATEWAY_ROUTES.check('NOWPAYMENTS'), {
      idempotencyKey: idempotencyKey(),
    });
    expect(keyless.statusCode).toBe(409);
  });

  it('hands the signature header to verification: unsigned is dropped, signed is verified', async () => {
    await post(PAYMENT_GATEWAY_ROUTES.credential('NOWPAYMENTS'), {
      idempotencyKey: idempotencyKey(),
      apiKey: API_KEY,
    });
    await post(PAYMENT_GATEWAY_ROUTES.webhookSecret('NOWPAYMENTS'), {
      idempotencyKey: idempotencyKey(),
      secret: IPN_SECRET,
    });
    const body = {
      payment_id: 5077125051,
      invoice_id: 4522625843,
      order_id: 'NPUNKNOWNUNKNOWNUNKN',
      payment_status: 'finished',
      price_amount: 10,
      price_currency: 'usd',
    };
    const url = `/payments/webhook/nowpayments/${String(tenantA.tenantId)}`;
    const unsigned = await inject({ method: 'POST', url, payload: body });
    expect(unsigned.statusCode).toBe(200);
    expect(unsigned.json()).toEqual({ ok: true });
    expect(await openConditions()).toContain('payments.gateway_webhook_unverified');

    const signature = createHmac('sha512', IPN_SECRET)
      .update(JSON.stringify(sortDeep(body)))
      .digest('hex');
    const verified = await inject({
      method: 'POST',
      url,
      headers: { 'x-nowpayments-sig': signature },
      payload: body,
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toEqual({ ok: true });
    // Verification succeeded (the condition recovered); the unknown order wrote nothing.
    expect(await openConditions()).not.toContain('payments.gateway_webhook_unverified');

    // A verified body that is not a notification is a 400, like every malformed webhook.
    const junk = { hello: 'world' };
    const malformed = await inject({
      method: 'POST',
      url,
      headers: {
        'x-nowpayments-sig': createHmac('sha512', IPN_SECRET)
          .update(JSON.stringify(sortDeep(junk)))
          .digest('hex'),
      },
      payload: junk,
    });
    expect(malformed.statusCode).toBe(400);
  });
});
