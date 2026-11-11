import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  RESELLER_API_PREFIX,
  RESELLER_SESSION_COOKIE_NAME,
  RESELLER_WEB_CALLBACK,
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
import {
  totpForStep,
  totpStepAt,
} from '../../apps/api/src/modules/platform/identity/application/totp';
import {
  hashLinkToken,
  hashResellerSessionToken,
} from '../../apps/api/src/modules/commerce/reseller-panel/domain/access-tokens';
import { resellerCookie } from '../../apps/api/src/surfaces/reseller/reseller-request';
import {
  adminActorFor,
  createAdmin,
  createApiApp,
  migrateOnce,
  resetDatabase,
  SEED_IDS,
  tenantA,
  tenantB,
  testConfig,
  type SeededAdmin,
} from './harness';

/**
 * PR-4 §5.1 / §5.4 — the reseller web panel's way in, against the real app over HTTP, the
 * real database as `nexa_app` (row-level security on) and a socket standing in for Telegram.
 *
 * Proves: the bot's button and its one-time link (flag, ACTIVE reseller, five an hour); the
 * link is single use, expires, is bound to its tenant, refuses a suspended reseller and a
 * switched-off panel; the two cookies never authorise each other's routes; the 2FA step; the
 * new-device notice once per device; session revoke / revoke-all; the admin's forced sign-out.
 */

const ORIGIN = 'https://admin.example.test';
const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const RESELLER_TG = '941001';
const OTHER_TG = '941002';
const UA_CHROME =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const UA_FIREFOX =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0';

const systemActor = (id: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: id as CorrelationId,
});

describe('the reseller web panel — access (PR-4)', () => {
  let api: ApiApp;
  let telegram: Server;
  let sent: { url: string; body: Record<string, unknown> }[];
  let owner: SeededAdmin;
  let ownerActor: ActorContext;
  let reseller: UserId;
  let other: UserId;
  let tierId: string;
  let baseMs = 0;
  let offsetMs = 0;
  let keys = 0;
  /** A fresh client address per case: the per-IP sign-in budget is Redis's, across runs. */
  let address = '10.0.0.1';

  const db = () => api.container.database.db;
  const key = () => `rw-key-${String((keys += 1)).padStart(6, '0')}-${randomUUID().slice(0, 8)}`;
  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject({ remoteAddress: address, ...options } as never);

  beforeAll(async () => {
    sent = [];
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          body = {};
        }
        sent.push({ url: request.url ?? '', body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 9 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const bound = telegram.address();
    if (bound === null || typeof bound === 'string') throw new Error('no address');
    const config = testConfig({
      WEB_ADMIN_ORIGINS: ORIGIN,
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(bound.port)}`,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
    const clock = api.container.clock as { now: () => Date };
    baseMs = Math.floor(Date.now() / 30_000) * 30_000 + 5_000;
    clock.now = () => new Date(baseMs + offsetMs);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    telegram.closeAllConnections();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  beforeEach(async () => {
    offsetMs = 0;
    sent = [];
    address = `10.${String(Math.floor(Math.random() * 200))}.${String(Math.floor(Math.random() * 200))}.${String(1 + Math.floor(Math.random() * 200))}`;
    await resetDatabase(db());
    await seed(db(), api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    owner = await createAdmin(api.container, tenantA, {
      username: 'rw-owner',
      roleKeys: ['owner'],
    });
    ownerActor = adminActorFor(owner);
    reseller = await customer(RESELLER_TG, 'سارا');
    other = await customer(OTHER_TG, 'نیما');
    const tier = await api.container.resellersAdmin.createTier(tenantA, ownerActor, {
      idempotencyKey: key(),
      write: {
        name: 'طلایی',
        pricingMode: 'LIST_PRICE',
        discountPercentage: null,
        creditLimit: money(0n, 'IRT'),
      },
    });
    tierId = tier.id;
    for (const id of [reseller, other]) {
      await api.container.resellersAdmin.register(tenantA, ownerActor, {
        idempotencyKey: key(),
        customerId: id,
        write: { tierId, pricingMode: 'TIER', discountPercentage: null, creditLimit: null },
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
      reason: 'reseller panel test',
    });
  }

  async function suspend(customerId: UserId) {
    await api.container.resellersAdmin.update(tenantA, ownerActor, {
      idempotencyKey: key(),
      customerId,
      reason: 'تعلیق در آزمون',
      write: {
        tierId,
        status: 'SUSPENDED',
        pricingMode: 'TIER',
        discountPercentage: null,
        creditLimit: null,
      },
    });
  }

  /** The link the bot's tap would send, from the service the tap calls. */
  async function link(customerId: UserId = reseller): Promise<string> {
    const issued = await api.container.resellerWeb.access.issueLink(tenantA, systemActor('l'), {
      customerId,
      botInstanceId: BOT_A,
    });
    if (issued.kind !== 'ISSUED') throw new Error(`no link: ${issued.kind}`);
    return issued.url;
  }
  const tokenOf = (url: string) => /#token=([A-Za-z0-9_-]+)$/u.exec(url)?.[1] as string;

  async function exchange(token: string, userAgent = UA_CHROME) {
    const response = await inject({
      method: 'POST',
      url: `${RESELLER_API_PREFIX}/auth/exchange`,
      headers: { origin: ORIGIN, 'user-agent': userAgent },
      payload: { token },
    });
    const header = response.headers['set-cookie'];
    const raw = Array.isArray(header) ? header.join('\n') : String(header ?? '');
    const cookie = new RegExp(`${RESELLER_SESSION_COOKIE_NAME}=([^;]+)`).exec(raw)?.[1] ?? null;
    const body = response.json() as { state?: string; error?: { code?: string } };
    return { status: response.statusCode, body, code: body.error?.code, cookie, raw };
  }

  async function signedIn(userAgent = UA_CHROME, customerId: UserId = reseller): Promise<string> {
    const opened = await exchange(tokenOf(await link(customerId)), userAgent);
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    return opened.cookie as string;
  }

  const call = (cookie: string | null, method: string, path: string, payload?: unknown) =>
    inject({
      method,
      url: `${RESELLER_API_PREFIX}${path}`,
      headers: {
        origin: ORIGIN,
        'user-agent': UA_CHROME,
        ...(cookie === null ? {} : { cookie: `${RESELLER_SESSION_COOKIE_NAME}=${cookie}` }),
        ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }),
      },
      ...(payload === undefined ? {} : { payload }),
    });
  const codeOf = (response: { json: () => unknown }) =>
    (response.json() as { error?: { code?: string } }).error?.code;

  const tap = (data: string, tg = RESELLER_TG) =>
    api.container.botRuntime.handle(tenantA, systemActor('bot'), {
      idempotencyKey: `rw-update-${randomUUID()}`,
      botInstanceId: BOT_A,
      update: {
        update_id: Math.floor(Math.random() * 1e9),
        callback_query: {
          id: `cbq-${randomUUID()}`,
          from: { id: Number(tg), is_bot: false, first_name: 'سارا' },
          data,
          message: {
            message_id: 5,
            date: 0,
            chat: { id: Number(tg), type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId: tg,
      from: { id: Number(tg), first_name: 'سارا' },
    });
  const buttonsOf = (body: Record<string, unknown>) =>
    (
      (body['reply_markup'] as { inline_keyboard?: { callback_data?: string; url?: string }[][] })
        ?.inline_keyboard ?? []
    ).flat();
  const walletButtons = async () => {
    sent = [];
    await tap('wo:');
    return sent.flatMap((one) => buttonsOf(one.body));
  };

  // =========================================================================
  // The bot's button and the one-time link
  // =========================================================================

  describe('the bot', () => {
    it('offers «ورود به پنل وب» only to an ACTIVE reseller while the flag is on, and the tap sends a one-time link', async () => {
      expect(
        (await walletButtons()).some((one) => one.callback_data === RESELLER_WEB_CALLBACK),
      ).toBe(true);
      // An ordinary customer is never offered it.
      await suspend(reseller);
      expect(
        (await walletButtons()).some((one) => one.callback_data === RESELLER_WEB_CALLBACK),
      ).toBe(false);
      await api.container.resellersAdmin.update(tenantA, ownerActor, {
        idempotencyKey: key(),
        customerId: reseller,
        reason: 'برگرداندن',
        write: {
          tierId,
          status: 'ACTIVE',
          pricingMode: 'TIER',
          discountPercentage: null,
          creditLimit: null,
        },
      });
      await setFlag('reseller_web_panel', false);
      expect(
        (await walletButtons()).some((one) => one.callback_data === RESELLER_WEB_CALLBACK),
      ).toBe(false);
      await setFlag('reseller_web_panel', true);

      sent = [];
      const turn = await tap(RESELLER_WEB_CALLBACK);
      expect(turn.replyKey).toBe('bot.reseller_web.link');
      const url = sent
        .flatMap((one) => buttonsOf(one.body))
        .find((one) => one.url !== undefined)?.url;
      expect(url).toMatch(/^https:\/\/admin\.example\.test\/r\/login#token=[A-Za-z0-9_-]{43}$/u);
      // Only the hash is stored; the audit row names the link, never the token.
      const token = tokenOf(url as string);
      const rows = await db().execute<{ token_hash: string }>(
        sql`SELECT token_hash FROM reseller_web_login_tokens`,
      );
      expect(rows.rows).toEqual([{ token_hash: hashLinkToken(token) }]);
      const audit = await db().execute<{ after: unknown }>(
        sql`SELECT after FROM audit_logs WHERE action = 'reseller_web.link_issued'`,
      );
      expect(JSON.stringify(audit.rows)).not.toContain(token);
      expect(JSON.stringify(audit.rows)).not.toContain(hashLinkToken(token));
    });

    it('issues at most five links an hour per reseller', async () => {
      for (let i = 0; i < 5; i += 1) await link();
      const sixth = await api.container.resellerWeb.access.issueLink(tenantA, systemActor('l'), {
        customerId: reseller,
        botInstanceId: BOT_A,
      });
      expect(sixth.kind).toBe('RATE_LIMITED');
      // Another reseller's budget is their own.
      await link(other);
      offsetMs += 3601_000;
      await link();
    });
  });

  // =========================================================================
  // The exchange
  // =========================================================================

  describe('the link', () => {
    it('opens one session, once: a refresh after use is «already opened»', async () => {
      const token = tokenOf(await link());
      const first = await exchange(token);
      expect(first.status).toBe(200);
      expect(first.body.state).toBe('ACTIVE');
      expect(first.raw).toMatch(/HttpOnly/u);
      expect(first.raw).toMatch(/SameSite=Strict/u);
      expect(first.raw).toMatch(/Path=\//u);
      const again = await exchange(token);
      expect(again.status).toBe(401);
      expect(again.code).toBe('reseller_web.link_used');
      expect((await call(first.cookie, 'GET', '/me')).statusCode).toBe(200);
    });

    it('expires after ten minutes', async () => {
      const token = tokenOf(await link());
      offsetMs += 600_000;
      const late = await exchange(token);
      expect(late.status).toBe(401);
      expect(late.code).toBe('reseller_web.link_expired');
    });

    it('is bound to its tenant: another tenant’s link is invalid on this host', async () => {
      const foreign = await db().execute<{ id: string }>(
        sql`SELECT id FROM customers WHERE tenant_id = ${tenantB.tenantId} LIMIT 1`,
      );
      let customerB = foreign.rows[0]?.id;
      if (customerB === undefined) {
        const resolved = await api.container.customers.resolveFromUpdate(
          tenantB,
          systemActor('b'),
          {
            intake: 'INTERNAL',
            idempotencyKey: 'resolve-b',
            telegramUserId: '941099',
            from: { id: 941099, first_name: 'B' },
            botInstanceId: SEED_IDS.botB1 as BotInstanceId,
          },
        );
        customerB = resolved.customer.id;
      }
      const token = 'B'.repeat(43);
      const now = api.container.clock.now();
      await db().execute(sql`
        INSERT INTO reseller_web_login_tokens
          (id, tenant_id, customer_id, bot_instance_id, token_hash, created_at, expires_at)
        VALUES (${randomUUID()}, ${tenantB.tenantId}, ${customerB}, ${SEED_IDS.botB1},
                ${hashLinkToken(token)}, ${now.toISOString()},
                ${new Date(now.getTime() + 600_000).toISOString()})`);
      const opened = await exchange(token);
      expect(opened.status).toBe(401);
      expect(opened.code).toBe('reseller_web.link_invalid');
      const sessions = await db().execute(sql`SELECT 1 FROM reseller_web_sessions`);
      expect(sessions.rows).toHaveLength(0);
    });

    it('refuses a SUSPENDED reseller at the exchange, and ends an open session at the next request', async () => {
      const cookie = await signedIn();
      const token = tokenOf(await link());
      await suspend(reseller);
      const refused = await exchange(token);
      expect(refused.status).toBe(401);
      expect(refused.code).toBe('reseller_web.link_invalid');
      const me = await call(cookie, 'GET', '/me');
      expect(me.statusCode).toBe(401);
      expect(codeOf(me)).toBe('reseller_web.session_invalid');
    });

    it('does not exist while the flag is off — the exchange and every route answer 404', async () => {
      const cookie = await signedIn();
      const token = tokenOf(await link());
      await setFlag('reseller_web_panel', false);
      const refused = await exchange(token);
      expect(refused.status).toBe(404);
      expect(refused.code).toBe('reseller_web.unavailable');
      const me = await call(cookie, 'GET', '/me');
      expect(me.statusCode).toBe(404);
      expect((await call(null, 'GET', '/dashboard')).statusCode).toBe(404);
      const issued = await api.container.resellerWeb.access.issueLink(tenantA, systemActor('l'), {
        customerId: reseller,
        botInstanceId: BOT_A,
      });
      expect(issued.kind).toBe('UNAVAILABLE');
      await setFlag('reseller_web_panel', true);
      expect((await call(cookie, 'GET', '/me')).statusCode).toBe(200);
    });

    it('refuses a write from another origin, and limits sign-in attempts per address', async () => {
      const evil = await inject({
        method: 'POST',
        url: `${RESELLER_API_PREFIX}/auth/exchange`,
        headers: { origin: 'https://evil.example' },
        payload: { token: 'A'.repeat(43) },
      });
      expect(evil.statusCode).toBe(403);
      const codes: number[] = [];
      for (let i = 0; i < 22; i += 1) codes.push((await exchange('C'.repeat(43))).status);
      expect(codes.slice(0, 20).every((status) => status === 401)).toBe(true);
      expect(codes.slice(20)).toEqual([429, 429]);
    });
  });

  // =========================================================================
  // Two cookies, two surfaces
  // =========================================================================

  describe('cookie separation', () => {
    it('an admin session never authorises a reseller route, and the reseller cookie never an admin route', async () => {
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
      const resellerToken = await signedIn();

      // The admin cookie, under its own name, on a reseller route.
      const asAdmin = await inject({
        method: 'GET',
        url: `${RESELLER_API_PREFIX}/me`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${adminCookie}` },
      });
      expect(asAdmin.statusCode).toBe(401);
      expect(codeOf(asAdmin)).toBe('reseller_web.session_invalid');
      // …and its token under the reseller cookie's name: a different hash space.
      const smuggled = await call(adminCookie, 'GET', '/me');
      expect(smuggled.statusCode).toBe(401);

      // The reseller cookie on an admin route, and its token under the admin name.
      for (const cookie of [
        `${RESELLER_SESSION_COOKIE_NAME}=${resellerToken}`,
        `${SESSION_COOKIE_NAME}=${resellerToken}`,
      ]) {
        const response = await inject({
          method: 'GET',
          url: `${API_PREFIX}/auth/session`,
          headers: { cookie },
        });
        expect(response.statusCode).toBe(401);
      }
      // Each works on its own surface.
      expect((await call(resellerToken, 'GET', '/me')).statusCode).toBe(200);
      const own = await inject({
        method: 'GET',
        url: `${API_PREFIX}/auth/session`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${adminCookie}` },
      });
      expect(own.statusCode).toBe(200);
    });

    it('the production cookie is __Host-, Secure, HttpOnly, SameSite=Strict', () => {
      const cookie = resellerCookie(true, 'tok', new Date(0));
      expect(cookie).toMatch(/^__Host-nexa_reseller_session=tok; /u);
      for (const part of ['Path=/', 'HttpOnly', 'SameSite=Strict', 'Secure']) {
        expect(cookie.split('; ')).toContain(part);
      }
      expect(cookie).not.toMatch(/Domain=/u);
    });
  });

  // =========================================================================
  // Two-step sign-in
  // =========================================================================

  describe('2FA', () => {
    const code = (secret: string) => {
      offsetMs += 30_000;
      return totpForStep(secret, totpStepAt(api.container.clock.now()));
    };

    it('a reseller with TOTP gets a code step after the link; nothing else works until it passes', async () => {
      const cookie = await signedIn();
      const enrol = await call(cookie, 'POST', '/security/totp/enrol');
      expect(enrol.statusCode, enrol.body).toBe(200);
      const { secret } = enrol.json() as { secret: string };
      const activated = await call(cookie, 'POST', '/security/totp/activate', {
        code: code(secret),
      });
      expect(activated.statusCode, activated.body).toBe(200);
      // The secret is sealed, never stored in clear.
      const stored = await db().execute(
        sql`SELECT totp_secret_ciphertext FROM reseller_web_totp_factors`,
      );
      expect(JSON.stringify(stored.rows)).not.toContain(secret);

      const opened = await exchange(tokenOf(await link()));
      expect(opened.status).toBe(200);
      expect(opened.body.state).toBe('SECOND_FACTOR_REQUIRED');
      const blocked = await call(opened.cookie, 'GET', '/me');
      expect(blocked.statusCode).toBe(401);
      expect(codeOf(blocked)).toBe('reseller_web.second_factor_required');
      const wrong = await call(opened.cookie, 'POST', '/auth/second-factor', { code: '000000' });
      expect(wrong.statusCode).toBe(401);
      expect(codeOf(wrong)).toBe('reseller_web.second_factor_invalid');
      const right = await call(opened.cookie, 'POST', '/auth/second-factor', {
        code: code(secret),
      });
      expect(right.statusCode, right.body).toBe(200);
      expect((await call(opened.cookie, 'GET', '/me')).statusCode).toBe(200);
    });

    it('five wrong codes end the pending session', async () => {
      const cookie = await signedIn();
      const { secret } = (await call(cookie, 'POST', '/security/totp/enrol')).json() as {
        secret: string;
      };
      await call(cookie, 'POST', '/security/totp/activate', { code: code(secret) });
      const opened = await exchange(tokenOf(await link()));
      for (let i = 0; i < 5; i += 1) {
        await call(opened.cookie, 'POST', '/auth/second-factor', { code: '000000' });
      }
      const late = await call(opened.cookie, 'POST', '/auth/second-factor', { code: code(secret) });
      expect(late.statusCode).toBe(401);
      expect(codeOf(late)).toBe('reseller_web.session_invalid');
    });

    async function withTotp(): Promise<{ cookie: string; secret: string }> {
      const cookie = await signedIn();
      const { secret } = (await call(cookie, 'POST', '/security/totp/enrol')).json() as {
        secret: string;
      };
      const on = await call(cookie, 'POST', '/security/totp/activate', { code: code(secret) });
      expect(on.statusCode, on.body).toBe(200);
      return { cookie, secret };
    }

    const attemptsOf = async (cookie: string | null) =>
      (
        await db().execute<{ second_factor_attempts: number; ended_at: string | null }>(
          sql`SELECT second_factor_attempts, ended_at FROM reseller_web_sessions
               WHERE token_hash = ${hashResellerSessionToken(decodeURIComponent(cookie ?? ''))}`,
        )
      ).rows[0];

    it('parallel wrong codes never exceed the bound: counted under the session lock', async () => {
      await withTotp();
      const opened = await exchange(tokenOf(await link()));
      const answers = await Promise.all(
        Array.from({ length: 12 }, () =>
          call(opened.cookie, 'POST', '/auth/second-factor', { code: '000000' }),
        ),
      );
      expect(answers.every((answer) => answer.statusCode === 401)).toBe(true);
      const row = await attemptsOf(opened.cookie);
      expect(row?.second_factor_attempts).toBe(5);
      expect(row?.ended_at).not.toBeNull();
      const denied = await db().execute(
        sql`SELECT 1 FROM audit_logs WHERE action = 'reseller_web.second_factor' AND result = 'DENIED'`,
      );
      expect(denied.rows).toHaveLength(5);
    });

    it('turning 2FA off honours the replay rule: a code already used cannot turn it off', async () => {
      const { secret } = await withTotp();
      const opened = await exchange(tokenOf(await link()));
      const used = code(secret);
      expect(
        (await call(opened.cookie, 'POST', '/auth/second-factor', { code: used })).statusCode,
      ).toBe(200);
      const replayed = await call(opened.cookie, 'POST', '/security/totp/disable', { code: used });
      expect(replayed.statusCode).toBe(401);
      expect(codeOf(replayed)).toBe('reseller_web.second_factor_invalid');
      const factor = await db().execute(sql`SELECT state FROM reseller_web_totp_factors`);
      expect(factor.rows).toEqual([{ state: 'ACTIVE' }]);
      const fresh = await call(opened.cookie, 'POST', '/security/totp/disable', {
        code: code(secret),
      });
      expect(fresh.statusCode, fresh.body).toBe(200);
      expect((await db().execute(sql`SELECT 1 FROM reseller_web_totp_factors`)).rows).toHaveLength(
        0,
      );
    });

    it('turning 2FA off has the same attempt bound: parallel wrong codes end the session at five', async () => {
      const { cookie } = await withTotp();
      const answers = await Promise.all(
        Array.from({ length: 12 }, () =>
          call(cookie, 'POST', '/security/totp/disable', { code: '000000' }),
        ),
      );
      expect(answers.every((answer) => answer.statusCode === 401)).toBe(true);
      const row = await attemptsOf(cookie);
      expect(row?.second_factor_attempts).toBe(5);
      expect(row?.ended_at).not.toBeNull();
      expect((await call(cookie, 'GET', '/me')).statusCode).toBe(401);
      const factor = await db().execute(sql`SELECT state FROM reseller_web_totp_factors`);
      expect(factor.rows).toEqual([{ state: 'ACTIVE' }]);
    });

    it('turning 2FA on has a bound too: parallel wrong activation codes delete the pending factor', async () => {
      const cookie = await signedIn();
      expect((await call(cookie, 'POST', '/security/totp/enrol')).statusCode).toBe(200);
      const answers = await Promise.all(
        Array.from({ length: 12 }, () =>
          call(cookie, 'POST', '/security/totp/activate', { code: '000000' }),
        ),
      );
      expect(answers.every((answer) => answer.statusCode >= 400)).toBe(true);
      expect((await db().execute(sql`SELECT 1 FROM reseller_web_totp_factors`)).rows).toHaveLength(
        0,
      );
    });

    it('enrolment needs a fresh sign-in', async () => {
      const cookie = await signedIn();
      offsetMs += 16 * 60_000;
      const stale = await call(cookie, 'POST', '/security/totp/enrol');
      expect(stale.statusCode).toBe(409);
      expect(codeOf(stale)).toBe('reseller_web.second_factor_state');
    });
  });

  // =========================================================================
  // «اعلان ورود جدید»
  // =========================================================================

  describe('the new-device notice', () => {
    const notices = async () =>
      (
        await db().execute(
          sql`SELECT 1 FROM customer_notifications WHERE kind = 'RESELLER_WEB_NEW_DEVICE'`,
        )
      ).rows.length;

    it('is raised once per new device, and not at all while the reseller turned it off', async () => {
      await signedIn(UA_CHROME);
      expect(await notices()).toBe(1);
      await signedIn(UA_CHROME);
      expect(await notices(), 'the same browser on the same network is not new').toBe(1);
      const cookie = await signedIn(UA_FIREFOX);
      expect(await notices()).toBe(2);
      const off = await call(cookie, 'PUT', '/settings/notifications', { newDeviceAlert: false });
      expect(off.statusCode, off.body).toBe(200);
      await signedIn('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605 Safari/605');
      expect(await notices()).toBe(2);
      // The session keeps the network, never the address.
      const kept = await db().execute<{ network: string | null }>(
        sql`SELECT DISTINCT network FROM reseller_web_sessions`,
      );
      expect(kept.rows.map((row) => row.network)).toEqual([address.replace(/\.\d+$/u, '.x')]);
    });
  });

  // =========================================================================
  // Sessions
  // =========================================================================

  describe('sessions', () => {
    it('lists the reseller’s own, revokes one, and «خروج از همهٔ دستگاه‌ها» ends all', async () => {
      const first = await signedIn(UA_CHROME);
      const second = await signedIn(UA_FIREFOX);
      const othersSession = await signedIn(UA_CHROME, other);
      const listed = (await call(first, 'GET', '/security/sessions')).json() as {
        items: { id: string; current: boolean; device: string }[];
      };
      expect(listed.items).toHaveLength(2);
      expect(listed.items.filter((item) => item.current)).toHaveLength(1);
      const secondId = listed.items.find((item) => !item.current)?.id as string;
      // Another reseller's session id is "not found".
      const othersId = (
        (await call(othersSession, 'GET', '/security/sessions')).json() as {
          items: { id: string }[];
        }
      ).items[0]?.id as string;
      const foreign = await call(first, 'POST', `/security/sessions/${othersId}/revoke`);
      expect(foreign.statusCode).toBe(404);
      expect((await call(othersSession, 'GET', '/me')).statusCode).toBe(200);

      expect((await call(first, 'POST', `/security/sessions/${secondId}/revoke`)).statusCode).toBe(
        200,
      );
      expect((await call(second, 'GET', '/me')).statusCode).toBe(401);
      expect((await call(first, 'GET', '/me')).statusCode).toBe(200);

      const third = await signedIn(UA_FIREFOX);
      const all = await call(first, 'POST', '/security/sessions/revoke-all');
      expect(all.statusCode).toBe(200);
      expect((await call(first, 'GET', '/me')).statusCode).toBe(401);
      expect((await call(third, 'GET', '/me')).statusCode).toBe(401);
      expect((await call(othersSession, 'GET', '/me')).statusCode).toBe(200);
    });

    it('ends after 30 idle days and after 90 days whatever', async () => {
      const cookie = await signedIn();
      offsetMs += 29 * 86_400_000;
      expect((await call(cookie, 'GET', '/me')).statusCode).toBe(200);
      offsetMs += 29 * 86_400_000;
      expect((await call(cookie, 'GET', '/me')).statusCode).toBe(200);
      offsetMs += 31 * 86_400_000;
      expect((await call(cookie, 'GET', '/me')).statusCode, 'idle').toBe(401);
      const fresh = await signedIn();
      for (let day = 0; day < 89; day += 10) {
        offsetMs += 10 * 86_400_000;
        if ((await call(fresh, 'GET', '/me')).statusCode !== 200) break;
      }
      offsetMs += 2 * 86_400_000;
      expect((await call(fresh, 'GET', '/me')).statusCode, 'absolute').toBe(401);
    });

    it('lists the reseller’s own activity, newest first', async () => {
      const cookie = await signedIn();
      await call(cookie, 'PUT', '/settings/notifications', { ticketReply: false });
      const page = (await call(cookie, 'GET', '/security/activity')).json() as {
        items: { action: string }[];
      };
      expect(page.items.map((item) => item.action)).toEqual([
        'reseller_web.preferences',
        'reseller_web.login',
      ]);
      // Another reseller sees none of it.
      const others = await signedIn(UA_CHROME, other);
      const theirs = (await call(others, 'GET', '/security/activity')).json() as {
        items: { action: string }[];
      };
      expect(theirs.items.map((item) => item.action)).toEqual(['reseller_web.login']);
    });
  });

  // =========================================================================
  // The Web Admin's drawer
  // =========================================================================

  describe('the admin drawer', () => {
    it('shows the last sign-in and forces a sign-out everywhere, with a reason, audited', async () => {
      const login = await inject({
        method: 'POST',
        url: `${API_PREFIX}/auth/login`,
        headers: { origin: ORIGIN },
        payload: { username: owner.username, password: owner.password },
      });
      const adminCookie = `${SESSION_COOKIE_NAME}=${
        /nexa_admin_session=([^;]+)/u.exec(String(login.headers['set-cookie']))?.[1] as string
      }`;
      const admin = (method: string, path: string, payload?: unknown) =>
        inject({
          method,
          url: `${API_PREFIX}${path}`,
          headers: { origin: ORIGIN, cookie: adminCookie },
          ...(payload === undefined ? {} : { payload }),
        });
      const before = (await admin('GET', `/resellers/${reseller}/web-panel`)).json() as {
        lastLoginAt: string | null;
      };
      expect(before.lastLoginAt).toBeNull();
      const a = await signedIn(UA_CHROME);
      const b = await signedIn(UA_FIREFOX);
      const summary = (await admin('GET', `/resellers/${reseller}/web-panel`)).json() as {
        lastLoginAt: string | null;
        activeSessions: number;
      };
      expect(summary.activeSessions).toBe(2);
      expect(summary.lastLoginAt).not.toBeNull();

      const noReason = await admin('POST', `/resellers/${reseller}/web-panel/force-logout`, {
        idempotencyKey: key(),
      });
      expect(noReason.statusCode).toBe(400);
      const forced = await admin('POST', `/resellers/${reseller}/web-panel/force-logout`, {
        idempotencyKey: key(),
        reason: 'گوشی نماینده گم شده است',
      });
      expect(forced.statusCode, forced.body).toBe(201);
      expect((forced.json() as { ended: number }).ended).toBe(2);
      expect((await call(a, 'GET', '/me')).statusCode).toBe(401);
      expect((await call(b, 'GET', '/me')).statusCode).toBe(401);
      const audited = await db().execute<{ after: { reason: string } }>(
        sql`SELECT after FROM audit_logs WHERE action = 'reseller_web.force_logout'`,
      );
      expect(audited.rows[0]?.after.reason).toBe('گوشی نماینده گم شده است');
      // The reseller's own cookie does not reach the admin route.
      const own = await signedIn();
      const refused = await inject({
        method: 'POST',
        url: `${API_PREFIX}/resellers/${reseller}/web-panel/force-logout`,
        headers: { origin: ORIGIN, cookie: `${RESELLER_SESSION_COOKIE_NAME}=${own}` },
        payload: { idempotencyKey: key(), reason: 'x'.repeat(10) },
      });
      expect(refused.statusCode).toBe(401);
    });
  });

  // =========================================================================
  // Every route: the census
  // =========================================================================

  it('every reseller route refuses no cookie with 401, and every write from another origin with 403', async () => {
    const routes = api.routes.filter((route) => route.url.startsWith(`${RESELLER_API_PREFIX}/`));
    expect(routes.length).toBeGreaterThan(30);
    for (const route of routes) {
      const url = route.url.replace(/:[A-Za-z]+/gu, '0190a0b0-0000-7000-8000-000000000001');
      for (const method of route.methods.filter((one) => one !== 'HEAD')) {
        const anonymous = await inject({ method, url, headers: { origin: ORIGIN } });
        const expected = url.endsWith('/auth/exchange') ? [400, 401] : [401];
        expect(expected, `${method} ${url}`).toContain(anonymous.statusCode);
        if (method !== 'GET') {
          const evil = await inject({ method, url, headers: { origin: 'https://evil.example' } });
          expect(evil.statusCode, `${method} ${url} from another origin`).toBe(403);
        }
      }
    }
  });
});
