import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  COMMERCE_ERROR_CODES,
  SESSION_COOKIE_NAME,
  TRIAL_ROUTES,
  errorResponseSchema,
  trialAllowanceResponseSchema,
  trialOverrideListResponseSchema,
  trialResetListResponseSchema,
  trialResetPreviewResponseSchema,
} from '@nexa/contracts';
import type { BotInstanceId, UserId } from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { createAdmin, migrateOnce, resetDatabase, tenantA, testConfig } from './harness';

/**
 * The trial routes over HTTP (WP6-B): every response parses against its contract schema,
 * and the server — not the Web Admin's buttons — refuses what a role may not do.
 * `trial-admin.test.ts` holds the rules; this holds the surface.
 */

const ORIGIN = 'https://admin.example.test';

describe('trial HTTP surface', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let operatorCookie: string;
  let observerCookie: string;
  let customerId: UserId;

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

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    for (const [username, role] of [
      ['owner', 'owner'],
      ['operator', 'operator'],
      ['observer', 'observer'],
    ] as const) {
      await createAdmin(api.container, tenantA, {
        username,
        password: `the-${username}-password`,
        roleKeys: [role],
      });
    }
    ownerCookie = await cookieFor('owner');
    operatorCookie = await cookieFor('operator');
    observerCookie = await cookieFor('observer');

    const resolution = await new DrizzleCustomerRepository(api.container.database.db).resolve(
      tenantA,
      {
        id: api.container.ids.uuid() as UserId,
        telegramUserId: '970001',
        profile: { username: null, firstName: 'Sara', lastName: null, languageCode: null },
        botInstanceId: SEED_IDS.botA1 as unknown as BotInstanceId,
        now: api.container.clock.now(),
      },
    );
    customerId = resolution.customer.id;
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

  const get = (path: string, cookie: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: { cookie, origin: ORIGIN } });
  const post = (path: string, cookie: string, payload: unknown) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${path}`,
      headers: { cookie, origin: ORIGIN },
      payload,
    });

  let key = 0;
  const idempotencyKey = () => `trial-http-${(key += 1)}-${Date.now()}`;

  it('reads, sets and removes an override, echoing the stored value', async () => {
    const read = await get(TRIAL_ROUTES.allowance(customerId), observerCookie);
    expect(read.statusCode).toBe(200);
    expect(trialAllowanceResponseSchema.parse(read.json()).trial).toMatchObject({
      override: null,
      globalLimit: 1,
      effectiveLimit: 1,
      used: 0,
      remaining: 1,
      featureEnabled: false,
    });

    const set = await post(TRIAL_ROUTES.setOverride(customerId), operatorCookie, {
      idempotencyKey: idempotencyKey(),
      limit: 4,
      reason: 'a loyal customer',
    });
    expect(set.statusCode).toBe(201);
    expect(trialAllowanceResponseSchema.parse(set.json()).trial).toMatchObject({
      override: { limit: 4 },
      effectiveLimit: 4,
    });

    const list = await get(TRIAL_ROUTES.overrides, observerCookie);
    expect(list.statusCode).toBe(200);
    const rows = trialOverrideListResponseSchema.parse(list.json()).overrides;
    expect(rows.map((row) => [row.customer.id, row.limit, row.used, row.remaining])).toEqual([
      [customerId, 4, 0, 4],
    ]);

    const removed = await post(TRIAL_ROUTES.removeOverride(customerId), operatorCookie, {
      idempotencyKey: idempotencyKey(),
    });
    expect(removed.statusCode).toBe(201);
    expect(trialAllowanceResponseSchema.parse(removed.json()).trial.override).toBeNull();
  });

  it('refuses each write to a role that does not hold its permission', async () => {
    const override = await post(TRIAL_ROUTES.setOverride(customerId), observerCookie, {
      idempotencyKey: idempotencyKey(),
      limit: 4,
    });
    expect(override.statusCode).toBe(403);

    expect((await get(TRIAL_ROUTES.resetPreview, operatorCookie)).statusCode).toBe(403);
    const reset = await post(TRIAL_ROUTES.resets, operatorCookie, {
      idempotencyKey: idempotencyKey(),
      expectedGrants: 1,
      reason: 'not an owner',
    });
    expect(reset.statusCode).toBe(403);
  });

  it('previews for the owner, and refuses a reset with nothing to reset', async () => {
    const preview = await get(TRIAL_ROUTES.resetPreview, ownerCookie);
    expect(preview.statusCode).toBe(200);
    expect(trialResetPreviewResponseSchema.parse(preview.json()).preview).toEqual({
      affectedGrants: 0,
      affectedCustomers: 0,
      sample: [],
    });

    const reset = await post(TRIAL_ROUTES.resets, ownerCookie, {
      idempotencyKey: idempotencyKey(),
      expectedGrants: 1,
      reason: 'nothing to do',
    });
    expect(reset.statusCode).toBeGreaterThanOrEqual(400);
    expect(errorResponseSchema.parse(reset.json()).error.code).toBe(
      COMMERCE_ERROR_CODES.TRIAL_RESET_NOTHING,
    );

    const history = await get(TRIAL_ROUTES.resets, observerCookie);
    expect(history.statusCode).toBe(200);
    expect(trialResetListResponseSchema.parse(history.json())).toEqual({
      resets: [],
      nextCursor: null,
    });
  });

  it('refuses a malformed body at the boundary', async () => {
    const response = await post(TRIAL_ROUTES.setOverride(customerId), operatorCookie, {
      idempotencyKey: idempotencyKey(),
      limit: 101,
    });
    expect(response.statusCode).toBe(400);
    const blank = await post(TRIAL_ROUTES.resets, ownerCookie, {
      idempotencyKey: idempotencyKey(),
      expectedGrants: 1,
      reason: '',
    });
    expect(blank.statusCode).toBe(400);
  });
});
