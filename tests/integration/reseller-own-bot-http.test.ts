import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  RESELLER_API_PREFIX,
  RESELLER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { startFakeTelegramBotApi, type FakeTelegramBotApi } from '../support/fake-telegram-bot-api';
import {
  adminActorFor,
  createAdmin,
  createApiApp,
  migrateOnce,
  resetDatabase,
  SEED_IDS,
  tenantA,
  testConfig,
  type SeededAdmin,
} from './harness';

/**
 * PR-6 «ربات اختصاصی» on the reseller web panel, over HTTP against the real app and database.
 *
 * Proves the controller is only a door: the flag off is 404 like every reseller route; the admin
 * cookie never authorises it; the offer follows the fee setting; a filed request comes back with
 * its token masked; and another reseller can neither see, cancel nor pay it — the same 404 as a
 * request that does not exist (the ownership filter is the application's, reached through here).
 */

const ORIGIN = 'https://admin.example.test';
const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const FEE = 500_000n;
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0';

const systemActor = (id: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: id as CorrelationId,
});

describe('«ربات اختصاصی» on the reseller panel (PR-6)', () => {
  let api: ApiApp;
  let telegram: FakeTelegramBotApi;
  let owner: SeededAdmin;
  let ownerActor: ActorContext;
  let reseller: UserId;
  let other: UserId;
  let keys = 0;
  let address = '10.0.0.1';

  const db = () => api.container.database.db;
  const key = () => `rob-key-${String((keys += 1)).padStart(6, '0')}-${randomUUID().slice(0, 8)}`;
  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject({ remoteAddress: address, ...options } as never);

  beforeAll(async () => {
    telegram = await startFakeTelegramBotApi();
    const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN, TELEGRAM_API_BASE_URL: telegram.url });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await telegram?.close();
  });

  beforeEach(async () => {
    address = `10.${String(Math.floor(Math.random() * 200))}.${String(Math.floor(Math.random() * 200))}.${String(1 + Math.floor(Math.random() * 200))}`;
    await resetDatabase(db());
    await seed(db(), api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    owner = await createAdmin(api.container, tenantA, {
      username: 'rob-owner',
      roleKeys: ['owner'],
    });
    ownerActor = adminActorFor(owner);
    reseller = await customer('951001', 'سارا');
    other = await customer('951002', 'نیما');
    const tier = await api.container.resellersAdmin.createTier(tenantA, ownerActor, {
      idempotencyKey: key(),
      write: {
        name: 'طلایی',
        pricingMode: 'LIST_PRICE',
        discountPercentage: null,
        creditLimit: money(0n, 'IRT'),
      },
    });
    for (const id of [reseller, other]) {
      await api.container.resellersAdmin.register(tenantA, ownerActor, {
        idempotencyKey: key(),
        customerId: id,
        write: {
          tierId: tier.id,
          pricingMode: 'TIER',
          discountPercentage: null,
          creditLimit: null,
        },
      });
    }
    await setFlag('reseller_web_panel', true);
  });

  async function customer(tg: string, name: string): Promise<UserId> {
    const resolved = await api.container.customers.resolveFromUpdate(tenantA, systemActor(tg), {
      intake: 'INTERNAL',
      idempotencyKey: `resolve-${tg}`,
      telegramUserId: tg,
      from: { id: Number(tg), first_name: name },
      botInstanceId: BOT_A,
    });
    return resolved.customer.id;
  }

  async function setFlag(flag: string, enabled: boolean, scope: TenantContext = tenantA) {
    const current = await api.container.featureFlagResolver.resolve(scope, flag as never);
    await api.container.featureFlags.set(scope, ownerActor, {
      key: flag as never,
      enabled,
      expectedVersion: current.version,
      idempotencyKey: key(),
      reason: 'own bot test',
    });
  }

  async function setFee(amountMinor: bigint) {
    const { rows } = await db().execute(
      sql`SELECT version FROM setting_values
           WHERE tenant_id = ${tenantA.tenantId} AND setting_key = 'hosting.reseller_bot_monthly_fee'`,
    );
    await api.container.settingsService.set(tenantA, ownerActor, {
      key: 'hosting.reseller_bot_monthly_fee',
      value: { amountMinor: amountMinor.toString(), currency: 'IRT' },
      expectedVersion: (rows[0] as { version: number } | undefined)?.version ?? null,
      idempotencyKey: key(),
    } as never);
  }

  /** A signed-in reseller: the bot's one-time link, exchanged for the panel cookie. */
  async function signedIn(customerId: UserId): Promise<string> {
    const issued = await api.container.resellerWeb.access.issueLink(tenantA, systemActor('l'), {
      customerId,
      botInstanceId: BOT_A,
    });
    if (issued.kind !== 'ISSUED') throw new Error(`no link: ${issued.kind}`);
    const token = /#token=([A-Za-z0-9_-]+)$/u.exec(issued.url)?.[1] as string;
    const response = await inject({
      method: 'POST',
      url: `${RESELLER_API_PREFIX}/auth/exchange`,
      headers: { origin: ORIGIN, 'user-agent': UA },
      payload: { token },
    });
    expect(response.statusCode, response.body).toBe(200);
    const raw = String(response.headers['set-cookie'] ?? '');
    return new RegExp(`${RESELLER_SESSION_COOKIE_NAME}=([^;]+)`).exec(raw)?.[1] as string;
  }

  const call = (
    cookie: string | null,
    method: 'GET' | 'POST',
    path: string,
    options: { payload?: unknown; idempotencyKey?: string } = {},
  ) =>
    inject({
      method,
      url: `${RESELLER_API_PREFIX}${path}`,
      headers: {
        origin: ORIGIN,
        'user-agent': UA,
        ...(cookie === null ? {} : { cookie: `${RESELLER_SESSION_COOKIE_NAME}=${cookie}` }),
        ...(method === 'GET' ? {} : { 'idempotency-key': options.idempotencyKey ?? randomUUID() }),
      },
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    });
  const codeOf = (response: { json: () => unknown }) =>
    (response.json() as { error?: { code?: string } }).error?.code;
  type View = { id: string; state: string; tokenMasked: string; botUsername: string };
  type Overview = {
    offer: { offered: boolean; fee: { amountMinor: string } | null; canRequest: boolean };
    requests: View[];
  };

  it('does not exist while the flag is off, like every reseller route', async () => {
    await setFee(FEE);
    const cookie = await signedIn(reseller);
    expect((await call(cookie, 'GET', '/own-bot')).statusCode).toBe(200);
    await setFlag('reseller_web_panel', false);
    for (const [method, path] of [
      ['GET', '/own-bot'],
      ['POST', '/own-bot/requests'],
      ['POST', `/own-bot/requests/${randomUUID()}/cancel`],
      ['POST', `/own-bot/requests/${randomUUID()}/pay`],
    ] as const) {
      const response = await call(cookie, method, path, { payload: {} });
      expect(response.statusCode, `${method} ${path}`).toBe(404);
      expect(codeOf(response)).toBe('reseller_web.unavailable');
    }
  });

  it('refuses the Web Admin cookie: only a reseller session opens it', async () => {
    const login = await inject({
      method: 'POST',
      url: `${API_PREFIX}/auth/login`,
      headers: { origin: ORIGIN },
      payload: { username: owner.username, password: owner.password },
    });
    expect(login.statusCode).toBe(201);
    const adminCookie = /nexa_admin_session=([^;]+)/u.exec(
      String(login.headers['set-cookie']),
    )?.[1] as string;
    for (const cookie of [
      `${SESSION_COOKIE_NAME}=${adminCookie}`,
      `${RESELLER_SESSION_COOKIE_NAME}=${adminCookie}`,
    ]) {
      const response = await inject({
        method: 'GET',
        url: `${RESELLER_API_PREFIX}/own-bot`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(401);
      expect(codeOf(response)).toBe('reseller_web.session_invalid');
    }
  });

  it('follows the fee: not offered while unset, then a request filed with its token masked', async () => {
    const cookie = await signedIn(reseller);
    const unset = (await call(cookie, 'GET', '/own-bot')).json() as Overview;
    expect(unset.offer).toMatchObject({ offered: false, fee: null, canRequest: false });
    const botToken = telegram.createBot({ id: 7_300_000_001, username: 'sara_shop_bot' });
    const refused = await call(cookie, 'POST', '/own-bot/requests', {
      payload: { botToken, domain: null },
    });
    expect(codeOf(refused)).toBe('reseller_bot.not_offered');

    await setFee(FEE);
    const offered = (await call(cookie, 'GET', '/own-bot')).json() as Overview;
    expect(offered.offer).toMatchObject({ offered: true, canRequest: true });
    expect(offered.offer.fee?.amountMinor).toBe(FEE.toString());

    const idempotencyKey = randomUUID();
    const filed = await call(cookie, 'POST', '/own-bot/requests', {
      payload: { botToken, domain: 'shop.example.com' },
      idempotencyKey,
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const view = filed.json() as View;
    expect(view).toMatchObject({ state: 'PENDING', botUsername: 'sara_shop_bot' });
    expect(filed.body).not.toContain(botToken);
    expect(view.tokenMasked).not.toBe(botToken);
    // The same press again is the same request, not a second one.
    const replay = await call(cookie, 'POST', '/own-bot/requests', {
      payload: { botToken, domain: 'shop.example.com' },
      idempotencyKey,
    });
    expect((replay.json() as View).id).toBe(view.id);
    const listed = (await call(cookie, 'GET', '/own-bot')).json() as Overview;
    expect(listed.requests.map((one) => one.id)).toEqual([view.id]);
    expect(listed.offer.canRequest).toBe(false);
    // The body is the panel's contract: no key in it, a malformed one is refused.
    const malformed = await call(cookie, 'POST', '/own-bot/requests', { payload: { domain: 1 } });
    expect(malformed.statusCode).toBe(400);
    expect(codeOf(malformed)).toBe('reseller_web.request_invalid');
  });

  it('another reseller can neither see, cancel nor pay the request; its owner cancels it', async () => {
    await setFee(FEE);
    const mine = await signedIn(reseller);
    const theirs = await signedIn(other);
    const botToken = telegram.createBot({ id: 7_300_000_002, username: 'sara_two_bot' });
    const filed = (
      await call(mine, 'POST', '/own-bot/requests', { payload: { botToken } })
    ).json() as View;

    const seen = (await call(theirs, 'GET', '/own-bot')).json() as Overview;
    expect(seen.requests).toEqual([]);
    for (const action of ['cancel', 'pay'] as const) {
      const response = await call(theirs, 'POST', `/own-bot/requests/${filed.id}/${action}`);
      expect(response.statusCode, action).toBe(404);
      expect(codeOf(response)).toBe('reseller_bot.request_not_found');
      // …the same answer as an id that does not exist, or is not an id at all.
      for (const id of [randomUUID(), 'not-an-id']) {
        const none = await call(theirs, 'POST', `/own-bot/requests/${id}/${action}`);
        expect(none.statusCode).toBe(404);
        expect(codeOf(none)).toBe('reseller_bot.request_not_found');
      }
    }
    expect(((await call(mine, 'GET', '/own-bot')).json() as Overview).requests[0]?.state).toBe(
      'PENDING',
    );

    // Its owner: paying a request the owner has not approved charges nothing; cancelling works.
    const unpaid = await call(mine, 'POST', `/own-bot/requests/${filed.id}/pay`);
    expect(unpaid.statusCode).toBe(409);
    expect(codeOf(unpaid)).toBe('reseller_bot.state_conflict');
    const cancelled = await call(mine, 'POST', `/own-bot/requests/${filed.id}/cancel`);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((cancelled.json() as View).state).toBe('CANCELLED');
    const { rows } = await db().execute(
      sql`SELECT count(*)::int AS n FROM wallet_entries WHERE reason = 'HOSTED_BOT_FEE'`,
    );
    expect((rows[0] as { n: number }).n).toBe(0);
  });
});
