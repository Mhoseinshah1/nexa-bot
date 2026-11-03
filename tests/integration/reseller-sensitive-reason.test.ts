import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  RESELLER_ROUTES,
  RESELLER_TIER_ROUTES,
  SESSION_COOKIE_NAME,
  COMMERCE_ERROR_CODES,
  resellerHistoryResponseSchema,
  resellerResponseSchema,
  resellerTierResponseSchema,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type UserId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, testConfig } from './harness';

/**
 * NEXA-FIX-V096 PR-4 (OQ-V095-01): suspending a reseller, changing their tier (a demotion)
 * and a credit change each need a written reason of 3 to 500 characters. Refused without one
 * before anything is written; accepted with one and audited WITH it.
 */

const ORIGIN = 'https://admin.example.test';
const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const customerActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('reseller sensitive changes need a written reason', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let customerA: UserId;
  let customerA2: UserId;
  let n = 0;
  const key = (): string => `reseller-http-${(n += 1)}`;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    for (const [username, roleKeys, scope] of [['owner', ['owner'], tenantA]] as const) {
      await createAdmin(api.container, scope, {
        username,
        password: `the-${username}-password`,
        roleKeys: [...roleKeys],
      });
    }
    ownerCookie = await cookieFor('owner');

    customerA = await customer('950001', 'نیلوفر');
    customerA2 = await customer('950002', 'Behnam');
  });

  async function cookieFor(username: string): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password: `the-${username}-password` },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(response.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error(`No session cookie for ${username}: ${response.body}`);
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  async function customer(telegramUserId: string, firstName: string): Promise<UserId> {
    const { customer: record } = await api.container.customers.resolveFromUpdate(
      tenantA,
      customerActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: firstName },
        botInstanceId: BOT_A,
      },
    );
    return record.id;
  }

  const get = (path: string, cookie: string | null = ownerCookie) =>
    inject({
      method: 'GET',
      url: `${API_PREFIX}${path}`,
      headers: cookie === null ? { origin: ORIGIN } : { cookie, origin: ORIGIN },
    });
  const post = (path: string, payload: unknown, cookie: string | null = ownerCookie) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${path}`,
      headers: cookie === null ? { origin: ORIGIN } : { cookie, origin: ORIGIN },
      payload,
    });

  const tierBody = (overrides: Record<string, unknown> = {}) => ({
    idempotencyKey: key(),
    name: 'Gold',
    pricingMode: 'PERCENTAGE_DISCOUNT',
    discountPercentage: 20,
    // Zero, the only limit there is: reseller credit was removed (owner decision, 2026-10-01).
    creditLimit: { amount: '0', currency: 'IRT' },
    ...overrides,
  });

  const registerBody = (customerId: string, tierId: string, overrides = {}) => ({
    idempotencyKey: key(),
    customerId,
    tierId,
    pricingMode: 'TIER',
    discountPercentage: null,
    creditLimit: null,
    ...overrides,
  });

  const EVERYTHING = [
    { kind: 'OPERATION', subject: null },
    { kind: 'PRODUCT', subject: null },
    { kind: 'PANEL', subject: null },
    { kind: 'BOT', subject: null },
  ];

  async function createdTier(overrides: Record<string, unknown> = {}): Promise<string> {
    const response = await post(RESELLER_TIER_ROUTES.create, tierBody(overrides));
    expect(response.statusCode, response.body).toBe(201);
    return resellerTierResponseSchema.parse(response.json()).tier.id;
  }

  const REASON_REFUSAL = {
    error: { code: COMMERCE_ERROR_CODES.RESELLER_REASON_REQUIRED },
  };

  async function tier(name: string): Promise<string> {
    const response = await post(RESELLER_TIER_ROUTES.create, tierBody({ name }));
    expect(response.statusCode, response.body).toBe(201);
    return resellerTierResponseSchema.parse(response.json()).tier.id;
  }

  async function registered(): Promise<{ tierId: string; otherTierId: string }> {
    const tierId = await tier('Gold');
    const otherTierId = await tier('Silver');
    const response = await post(RESELLER_ROUTES.register, registerBody(customerA, tierId));
    expect(response.statusCode, response.body).toBe(201);
    return { tierId, otherTierId };
  }

  const updateBody = (tierId: string, overrides: Record<string, unknown> = {}) => ({
    idempotencyKey: key(),
    tierId,
    status: 'ACTIVE',
    pricingMode: 'TIER',
    discountPercentage: null,
    creditLimit: null,
    ...overrides,
  });

  async function updateAudits(): Promise<{ result: string; reason: string | null }[]> {
    const result = await api.container.database.db.execute(sql`
      SELECT result, reason FROM audit_logs
       WHERE action = 'reseller.update' AND entity_id = ${customerA}
       ORDER BY occurred_at, id`);
    return result.rows as { result: string; reason: string | null }[];
  }

  async function stored(): Promise<{ status: string; tier_id: string }> {
    const result = await api.container.database.db.execute(sql`
      SELECT status, tier_id FROM resellers WHERE customer_id = ${customerA}`);
    return result.rows[0] as { status: string; tier_id: string };
  }

  it('refuses a suspension without a usable reason and changes nothing', async () => {
    const { tierId } = await registered();
    const body = updateBody(tierId, { status: 'SUSPENDED' });
    for (const reason of [undefined, '', '   ', 'ab', '  ab  ', 'x'.repeat(501)]) {
      const response = await post(RESELLER_ROUTES.update(customerA), {
        ...body,
        ...(reason === undefined ? {} : { reason }),
      });
      expect(response.statusCode, `reason ${JSON.stringify(reason)}`).toBe(400);
      expect(response.json()).toMatchObject(REASON_REFUSAL);
    }
    expect((await stored()).status).toBe('ACTIVE');
    expect(await updateAudits()).toEqual([]);
  });

  it('accepts a suspension with a reason, audits it with the reason, and shows it in the history', async () => {
    const { tierId } = await registered();
    const body = updateBody(tierId, { status: 'SUSPENDED' });
    // The refused attempt did not use up the key: the same key carries the corrected request.
    expect((await post(RESELLER_ROUTES.update(customerA), body)).statusCode).toBe(400);
    const response = await post(RESELLER_ROUTES.update(customerA), {
      ...body,
      reason: '  مشتری بدحساب شد  ',
    });
    expect(response.statusCode, response.body).toBe(201);
    expect((await stored()).status).toBe('SUSPENDED');
    expect(await updateAudits()).toEqual([{ result: 'SUCCESS', reason: 'مشتری بدحساب شد' }]);

    const { entries } = resellerHistoryResponseSchema.parse(
      (await get(RESELLER_ROUTES.history(customerA))).json(),
    );
    expect(entries.find((e) => e.action === 'reseller.update')?.reason).toBe('مشتری بدحساب شد');
    expect(entries.find((e) => e.action === 'reseller.register')?.reason).toBeNull();
  });

  it('refuses a tier change (a demotion) without a reason, accepts it with one, audited', async () => {
    const { tierId, otherTierId } = await registered();
    const body = updateBody(otherTierId);
    const refused = await post(RESELLER_ROUTES.update(customerA), body);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject(REASON_REFUSAL);
    expect((await stored()).tier_id).toBe(tierId);

    const accepted = await post(RESELLER_ROUTES.update(customerA), {
      ...body,
      reason: 'تنزل به سطح پایین‌تر',
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect((await stored()).tier_id).toBe(otherTierId);
    expect(await updateAudits()).toEqual([{ result: 'SUCCESS', reason: 'تنزل به سطح پایین‌تر' }]);
  });

  it('refuses a credit change without a reason; with one it is still refused (credit was removed), nothing written', async () => {
    const { tierId } = await registered();
    const body = updateBody(tierId, { creditLimit: { amount: '5000', currency: 'IRT' } });
    const refused = await post(RESELLER_ROUTES.update(customerA), body);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject(REASON_REFUSAL);

    const withReason = await post(RESELLER_ROUTES.update(customerA), {
      ...body,
      reason: 'افزایش اعتبار',
    });
    expect(withReason.statusCode).toBe(400);
    expect(withReason.json()).toMatchObject({
      error: { code: COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID },
    });
    expect(await updateAudits()).toEqual([]);
  });

  it('needs no reason for a change that is none of the three: pricing, and reactivation', async () => {
    const { tierId } = await registered();
    const pricing = await post(
      RESELLER_ROUTES.update(customerA),
      updateBody(tierId, { pricingMode: 'LIST_PRICE' }),
    );
    expect(pricing.statusCode, pricing.body).toBe(201);
    const suspended = await post(RESELLER_ROUTES.update(customerA), {
      ...updateBody(tierId, { status: 'SUSPENDED' }),
      reason: 'تعلیق موقت',
    });
    expect(suspended.statusCode, suspended.body).toBe(201);
    const reactivated = await post(
      RESELLER_ROUTES.update(customerA),
      updateBody(tierId, { status: 'ACTIVE' }),
    );
    expect(reactivated.statusCode, reactivated.body).toBe(201);
    expect((await updateAudits()).map((a) => a.reason)).toEqual([null, 'تعلیق موقت', null]);
  });
});
