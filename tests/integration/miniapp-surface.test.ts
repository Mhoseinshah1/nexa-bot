import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  MINIAPP_API_PREFIX,
  MINIAPP_ROUTES,
  MINIAPP_RECEIPT_MAX_BYTES,
  miniAppCardInstructionSchema,
  miniAppMeResponseSchema,
  miniAppOrderSchema,
  miniAppPath,
  miniAppPaymentRoutesResponseSchema,
  miniAppServiceDetailSchema,
  miniAppServiceOfferSchema,
  miniAppServicesResponseSchema,
  miniAppWalletEntriesSchema,
  miniAppPaymentListSchema,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { MINIAPP_DOCUMENT_CSP } from '../../apps/api/src/surfaces/miniapp/static.controller';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  testConfig,
  validatePanelConnection,
  type TestContext,
} from './harness';

/**
 * Round 9, C5: the customer Mini App surface over real HTTP, against a real PostgreSQL, a
 * deterministic Marzban on a socket and a socket standing in for Telegram.
 *
 * What only this layer can show: that a session is minted from a VERIFIED launch and from
 * nothing else; that every route answers only for the session's own customer (another
 * customer's order, service, payment and ticket are "not found"); that the bot's gates hold;
 * and that a purchase and a renewal through the mini app move exactly the money, write
 * exactly the ledger and raise exactly the operations events the bot's path does — with the
 * mini app recorded as their source.
 */

const BOT_A1 = SEED_IDS.botA1 as BotInstanceId;
const BOT_A2 = SEED_IDS.botA2 as BotInstanceId;
const TOKEN_A1 = '000000:seed-token-acme-1';
const TOKEN_A2 = '000000:seed-token-acme-2';
const GIB = 1024n ** 3n;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

/** Telegram's own signer, independently of the verifier under test. */
function initDataFor(
  user: { id: number; first_name: string },
  options: { token?: string; authDate?: number; extra?: Record<string, string> } = {},
): string {
  const fields: Record<string, string> = {
    query_id: `q-${String(user.id)}-${String(Math.random()).slice(2, 10)}`,
    user: JSON.stringify(user),
    auth_date: String(options.authDate ?? Math.floor(Date.now() / 1000)),
    ...options.extra,
  };
  const check = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData')
    .update(options.token ?? TOKEN_A1)
    .digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

/** A minimal valid PNG header followed by filler: what a phone screenshot starts with. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

describe('the mini-app surface', () => {
  let ctx: TestContext;
  let api: ApiApp;
  let telegram: Server;
  let sent: { url: string; body: Record<string, unknown> }[];
  let photoSeq = 0;
  /** Runs while Telegram "holds" a sendPhoto, before it answers: the upload's network time. */
  let duringPhoto: (() => Promise<void>) | null = null;
  let panel: FakeMarzban | undefined;
  let owner: ActorContext;
  let keySeq = 0;
  /** A stand-in build of apps/miniapp: the API serves whatever `MINIAPP_DIST_DIR` holds. */
  const distDir = mkdtempSync(join(tmpdir(), 'nexa-miniapp-dist-'));

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);
  const key = () => `mini-key-${String((keySeq += 1)).padStart(6, '0')}-abcdef`;

  beforeAll(async () => {
    sent = [];
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => void answer());
      const answer = async () => {
        const raw = Buffer.concat(chunks);
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        } catch {
          body = { multipart: raw.length };
        }
        const url = request.url ?? '';
        sent.push({ url, body });
        response.writeHead(200, { 'content-type': 'application/json' });
        if (url.endsWith('/sendPhoto')) {
          photoSeq += 1;
          if (duringPhoto !== null) await duringPhoto();
          response.end(
            JSON.stringify({
              ok: true,
              result: {
                message_id: 500 + photoSeq,
                photo: [
                  { file_id: `small-${String(photoSeq)}`, file_unique_id: `s-${String(photoSeq)}` },
                  {
                    file_id: `FILE-${String(photoSeq)}`,
                    file_unique_id: `UNIQ-${String(photoSeq)}`,
                  },
                ],
              },
            }),
          );
          return;
        }
        response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
      };
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    mkdirSync(join(distDir, 'assets'));
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>mini</title>');
    writeFileSync(join(distDir, 'assets', 'index-abc123.js'), 'console.log(1);');
    writeFileSync(join(distDir, 'assets', 'index-abc123.js.map'), '{}');
    const env = {
      MINIAPP_DIST_DIR: distDir,
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    };
    ctx = await createTestContext(env);
    api = await createApiApp(testConfig(env));
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await ctx?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
    rmSync(distDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await panel?.close();
    panel = undefined;
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    api.container.setInstallationTenant(tenantA.tenantId);
    sent = [];
    photoSeq = 0;
    duringPhoto = null;
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'mini-owner', roleKeys: ['owner'] }),
    );
    await setFlag('mini_app', true);
  });

  async function setFlag(flag: string, enabled: boolean) {
    const current = await ctx.container.featureFlagResolver.resolve(tenantA, flag as never);
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: flag as never,
      enabled,
      expectedVersion: current.version,
      idempotencyKey: key(),
      reason: 'mini-app integration test',
    });
  }

  // --- HTTP helpers --------------------------------------------------------------------

  const mint = (botId: string, initData: string) =>
    inject({
      method: 'POST',
      url: `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES.session, { botInstanceId: botId })}`,
      payload: { initData },
    });

  async function sessionFor(telegramUserId: number, firstName = 'مشتری'): Promise<string> {
    const response = await mint(BOT_A1, initDataFor({ id: telegramUserId, first_name: firstName }));
    expect(response.statusCode, response.body).toBe(201);
    return (JSON.parse(response.body) as { token: string }).token;
  }

  const call = (
    token: string,
    method: 'GET' | 'POST' | 'PUT',
    route: string,
    params: Record<string, string> = {},
    payload?: unknown,
  ) =>
    inject({
      method,
      url: `${MINIAPP_API_PREFIX}${miniAppPath(route, params)}`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': key() }),
      },
      ...(payload === undefined ? {} : { payload }),
    });

  const customerIdOf = async (telegramUserId: number): Promise<UserId> => {
    const rows = await ctx.container.database.db.execute<{ id: string }>(
      sql`SELECT id FROM customers WHERE tenant_id = ${tenantA.tenantId}
            AND telegram_user_id = ${String(telegramUserId)}`,
    );
    const id = rows.rows[0]?.id;
    if (id === undefined) throw new Error('no customer');
    return id as UserId;
  };

  const credit = (customerId: UserId, amountMinor: bigint) =>
    ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: key(),
      direction: 'CREDIT',
      amountMinor,
      currency: 'IRT',
      note: 'fixture',
    });

  // --- catalogue fixtures ----------------------------------------------------------------

  async function marzbanPanel(): Promise<string> {
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: key(),
    });
    const id = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, id);
    return id;
  }

  async function product(panelId: string, price = 250_000n): Promise<ProductId> {
    const products = new DrizzleProductRepository(ctx.container.database.db);
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 50n * GIB, deviceLimit: null },
        price: money(price, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return created.id;
  }

  // =====================================================================================
  // Authentication
  // =====================================================================================

  describe('session from initData', () => {
    it('mints one session from a valid launch and resolves the customer the bot would', async () => {
      const response = await mint(BOT_A1, initDataFor({ id: 700001, first_name: 'سارا' }));
      expect(response.statusCode, response.body).toBe(201);
      const { token } = JSON.parse(response.body) as { token: string };
      const me = await call(token, 'GET', MINIAPP_ROUTES.me);
      expect(me.statusCode, me.body).toBe(200);
      const parsed = miniAppMeResponseSchema.parse(JSON.parse(me.body));
      expect(parsed.customer.firstName).toBe('سارا');
      expect(parsed.gate).toBeNull();
      expect(parsed.wallet?.balance).toEqual({ amountMinor: '0', currency: 'IRT' });
      // The same row the bot's resolution keys on (tenant, telegram id), first contact via bot A1.
      const rows = await ctx.container.database.db.execute<{ first_bot_instance_id: string }>(
        sql`SELECT first_bot_instance_id FROM customers WHERE telegram_user_id = '700001'`,
      );
      expect(rows.rows).toEqual([{ first_bot_instance_id: BOT_A1 }]);
      // The mint is audited under the mini app's surface.
      const audited = await ctx.container.database.db.execute<{ source_surface: string }>(
        sql`SELECT source_surface FROM audit_logs WHERE action = 'miniapp.session.mint'`,
      );
      expect(audited.rows).toEqual([{ source_surface: 'MINI_APP' }]);
    });

    it('refuses a tampered hash and a tampered field', async () => {
      const raw = initDataFor({ id: 700002, first_name: 'a' });
      const params = new URLSearchParams(raw);
      const hash = params.get('hash') as string;
      params.set('hash', `${hash.slice(0, -1)}${hash.endsWith('0') ? '1' : '0'}`);
      const tamperedHash = await mint(BOT_A1, params.toString());
      expect(tamperedHash.statusCode).toBe(401);
      expect(tamperedHash.body).toContain('miniapp.init_data_invalid');
      const tamperedUser = await mint(BOT_A1, raw.replace('700002', '700003'));
      expect(tamperedUser.statusCode).toBe(401);
      expect(tamperedUser.body).toContain('miniapp.init_data_invalid');
      const created = await ctx.container.database.db.execute(
        sql`SELECT 1 FROM customers WHERE telegram_user_id IN ('700002', '700003')`,
      );
      expect(created.rows, 'no customer is created for a forged launch').toHaveLength(0);
    });

    it('refuses a stale auth_date, per the setting', async () => {
      const stale = await mint(
        BOT_A1,
        initDataFor(
          { id: 700004, first_name: 'a' },
          { authDate: Math.floor(Date.now() / 1000) - 3700 },
        ),
      );
      expect(stale.statusCode).toBe(401);
      expect(stale.body).toContain('miniapp.init_data_expired');
    });

    it('refuses a launch of another bot: signed with A2, presented to A1, and the reverse', async () => {
      const otherBot = await mint(
        BOT_A1,
        initDataFor({ id: 700005, first_name: 'a' }, { token: TOKEN_A2 }),
      );
      expect(otherBot.statusCode).toBe(401);
      expect(otherBot.body).toContain('miniapp.init_data_invalid');
      await ctx.container.database.db.execute(
        sql`UPDATE bot_instances SET status = 'ACTIVE' WHERE id = ${BOT_A2}`,
      );
      const reverse = await mint(BOT_A2, initDataFor({ id: 700005, first_name: 'a' }));
      expect(reverse.statusCode).toBe(401);
    });

    it('mints ONE session per launch: the same initData again is refused as replayed', async () => {
      const raw = initDataFor({ id: 700006, first_name: 'a' });
      expect((await mint(BOT_A1, raw)).statusCode).toBe(201);
      const again = await mint(BOT_A1, raw);
      expect(again.statusCode).toBe(401);
      expect(again.body).toContain('miniapp.init_data_replayed');
      const rows = await ctx.container.database.db.execute(sql`SELECT 1 FROM miniapp_sessions`);
      expect(rows.rows).toHaveLength(1);
    });

    it('refuses a token after its session expired, and a token with a wrong secret', async () => {
      const token = await sessionFor(700007);
      expect((await call(token, 'GET', MINIAPP_ROUTES.me)).statusCode).toBe(200);
      const wrong = `${token.slice(0, token.indexOf('.') + 1)}${'A'.repeat(43)}`;
      const refusedWrong = await call(wrong, 'GET', MINIAPP_ROUTES.me);
      expect(refusedWrong.statusCode).toBe(401);
      expect(refusedWrong.body).toContain('miniapp.session_invalid');
      await ctx.container.database.db.execute(
        sql`UPDATE miniapp_sessions SET created_at = now() - interval '2 hours',
              expires_at = now() - interval '1 second'`,
      );
      const expired = await call(token, 'GET', MINIAPP_ROUTES.me);
      expect(expired.statusCode).toBe(401);
      expect(expired.body).toContain('miniapp.session_invalid');
      expect((await call('', 'GET', MINIAPP_ROUTES.me)).statusCode).toBe(401);
    });

    it('does not exist while the mini_app flag is off: the session route and the document 404', async () => {
      const token = await sessionFor(700008);
      await setFlag('mini_app', false);
      const refused = await mint(BOT_A1, initDataFor({ id: 700009, first_name: 'a' }));
      expect(refused.statusCode).toBe(404);
      expect(refused.body).toContain('miniapp.unavailable');
      // A session minted while it was on ends with the flag.
      expect((await call(token, 'GET', MINIAPP_ROUTES.me)).statusCode).toBe(401);
      expect((await inject({ method: 'GET', url: `/miniapp/${BOT_A1}/` })).statusCode).toBe(404);
    });
  });

  describe('the document', () => {
    it("is served for a live bot under the mini app's own CSP, framable only by Telegram", async () => {
      for (const path of [
        `/miniapp/${BOT_A1}`,
        `/miniapp/${BOT_A1}/`,
        `/miniapp/${BOT_A1}/store`,
      ]) {
        const page = await inject({ method: 'GET', url: path });
        expect(page.statusCode, path).toBe(200);
        expect(page.body).toContain('<title>mini</title>');
        expect(page.headers['content-security-policy']).toBe(MINIAPP_DOCUMENT_CSP);
        expect(
          page.headers['x-frame-options'],
          'the API default would forbid Telegram',
        ).toBeUndefined();
        expect(page.headers['cache-control']).toBe('no-store');
      }
      expect(MINIAPP_DOCUMENT_CSP).toContain("script-src 'self' https://telegram.org");
      expect(MINIAPP_DOCUMENT_CSP).toContain("style-src 'self'");
      expect(MINIAPP_DOCUMENT_CSP).not.toContain('unsafe');
    });

    it('serves the build and nothing else: no source map, no path outside it, no unknown bot', async () => {
      const asset = await inject({ method: 'GET', url: '/miniapp/assets/index-abc123.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toContain('text/javascript');
      expect(asset.headers['cache-control']).toContain('immutable');
      for (const url of [
        '/miniapp/assets/index-abc123.js.map',
        '/miniapp/assets/..%2Findex.html',
        '/miniapp/assets/%2E%2E%2F%2E%2E%2Fpackage.json',
        `/miniapp/${ctx.container.ids.uuid()}/`,
        '/miniapp/not-a-bot/',
      ]) {
        expect((await inject({ method: 'GET', url })).statusCode, url).toBe(404);
      }
    });
  });

  // =====================================================================================
  // Gates
  // =====================================================================================

  describe('the bot gates', () => {
    it('a blocked customer is held: /me says so, and every gated route refuses', async () => {
      const token = await sessionFor(700101);
      await ctx.container.customers.block(tenantA, owner, {
        idempotencyKey: key(),
        customerId: await customerIdOf(700101),
        reason: 'test',
      });
      const me = miniAppMeResponseSchema.parse(
        JSON.parse((await call(token, 'GET', MINIAPP_ROUTES.me)).body),
      );
      expect(me.gate).toEqual({ kind: 'BLOCKED' });
      expect(me.wallet, 'nothing behind a gate is read').toBeNull();
      for (const route of [
        MINIAPP_ROUTES.categories,
        MINIAPP_ROUTES.services,
        MINIAPP_ROUTES.wallet,
      ]) {
        const refused = await call(token, 'GET', route);
        expect(refused.statusCode, route).toBe(403);
        expect(refused.body).toContain('miniapp.gate_required');
      }
    });

    it('unaccepted published terms hold the customer until accepted through the same service', async () => {
      const draft = await api.container.terms.createDraft(tenantA, owner, {
        idempotencyKey: key(),
        title: 'قوانین',
        body: 'متن قوانین',
      });
      const version = await api.container.terms.publish(tenantA, owner, {
        idempotencyKey: key(),
        id: draft.id,
        expectedRevision: draft.revision,
      });
      await setFlag('terms_enforcement', true);
      const token = await sessionFor(700102);
      const me = miniAppMeResponseSchema.parse(
        JSON.parse((await call(token, 'GET', MINIAPP_ROUTES.me)).body),
      );
      expect(me.gate).toMatchObject({ kind: 'TERMS', terms: { versionId: version.id } });
      expect((await call(token, 'GET', MINIAPP_ROUTES.categories)).statusCode).toBe(403);
      const accepted = await call(
        token,
        'POST',
        MINIAPP_ROUTES.termsAccept,
        {},
        {
          termsVersionId: version.id,
        },
      );
      expect(accepted.statusCode, accepted.body).toBe(201);
      expect(miniAppMeResponseSchema.parse(JSON.parse(accepted.body)).gate).toBeNull();
      expect((await call(token, 'GET', MINIAPP_ROUTES.categories)).statusCode).toBe(200);
    });
  });

  // =====================================================================================
  // Purchase and renewal: the same money, ledger and operations log as the bot
  // =====================================================================================

  describe('purchase and renewal, against the bot path', () => {
    /** Every outbox event consumed, so the operations-log consumers have queued their lines. */
    async function drainRelay(): Promise<void> {
      for (let round = 0; round < 50; round += 1) {
        const result = await api.container.relay.processBatch();
        if (result.claimed === 0) return;
      }
      throw new Error('the relay did not drain');
    }

    /** What the operations log was asked to print in the window: its template keys, in order. */
    async function opsLogSince(marker: Date): Promise<string[]> {
      await drainRelay();
      const rows = await ctx.container.database.db.execute<{ template_key: string }>(
        sql`SELECT template_key FROM notifications
             WHERE created_at >= ${marker.toISOString()}::timestamptz
             ORDER BY template_key`,
      );
      return rows.rows.map((row) => row.template_key);
    }

    async function opsCodesSince(marker: Date): Promise<string[]> {
      const rows = await ctx.container.database.db.execute<{ code: string }>(
        sql`SELECT code FROM operational_events WHERE first_seen_at >= ${marker.toISOString()}::timestamptz
            ORDER BY code`,
      );
      return rows.rows.map((row) => row.code);
    }

    async function ledgerOf(customerId: UserId) {
      const rows = await ctx.container.database.db.execute<{
        direction: string;
        reason: string;
        amount: string;
      }>(
        sql`SELECT direction, reason, amount::text FROM wallet_entries
             WHERE customer_id = ${customerId} AND reason <> 'ADMIN_CREDIT'
             ORDER BY created_at, id`,
      );
      return rows.rows;
    }

    async function ordersOf(customerId: UserId) {
      const rows = await ctx.container.database.db.execute<{
        purpose: string;
        state: string;
        subtotal_amount: string;
        discount_amount: string;
        total_amount: string;
        source_surface: string | null;
      }>(
        sql`SELECT purpose, state, subtotal_amount::text, discount_amount::text,
                   total_amount::text, source_surface
              FROM orders WHERE customer_id = ${customerId} ORDER BY created_at, id`,
      );
      return rows.rows;
    }

    async function paymentsOf(customerId: UserId) {
      const rows = await ctx.container.database.db.execute<{
        method: string;
        state: string;
        amount: string;
        source_surface: string | null;
      }>(
        sql`SELECT method, state, amount::text, source_surface FROM payments
             WHERE customer_id = ${customerId} ORDER BY created_at, id`,
      );
      return rows.rows;
    }

    const tapFor = (telegramUserId: number) => {
      let seq = telegramUserId * 100;
      return (data: string) => {
        seq += 1;
        return {
          idempotencyKey: `bot-update-${String(seq)}`,
          botInstanceId: BOT_A1,
          update: {
            update_id: seq,
            callback_query: {
              id: `cbq-${String(seq)}`,
              from: { id: telegramUserId, is_bot: false, first_name: 'ربات' },
              data,
              message: {
                message_id: seq,
                date: 0,
                chat: { id: telegramUserId, type: 'private' },
                from: { id: 999999, is_bot: true, first_name: 'Nexa' },
              },
            },
          },
          telegramUserId: String(telegramUserId),
          from: { id: telegramUserId, first_name: 'ربات' },
        };
      };
    };

    it('buys and renews through the mini app exactly as through the bot', async () => {
      const panelId = await marzbanPanel();
      const productId = await product(panelId);
      const services = new DrizzleServiceRepository(ctx.container.database.db);
      // An operations destination, so the purchase and renewal log lines are queued.
      await setFlag('ops_notifications', true);
      await drainRelay();

      // --- the bot path, customer 1 ------------------------------------------------------
      const botUser = 700201;
      const tap = tapFor(botUser);
      const botMarker = ctx.container.clock.now();
      const botCustomer = (
        await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
          idempotencyKey: 'resolve-bot-user',
          telegramUserId: String(botUser),
          from: { id: botUser, first_name: 'ربات' },
          botInstanceId: BOT_A1,
        })
      ).customer.id;
      await credit(botCustomer, 1_000_000n);
      await ctx.container.botRuntime.handle(tenantA, systemActor('bot'), tap(`p:${productId}`));
      const [botDraft] = await ordersOf(botCustomer);
      expect(botDraft?.state).toBe('DRAFT');
      const botOrderId = (
        await ctx.container.database.db.execute<{ id: string }>(
          sql`SELECT id FROM orders WHERE customer_id = ${botCustomer}`,
        )
      ).rows[0]?.id as string;
      await ctx.container.botRuntime.handle(tenantA, systemActor('bot'), tap(`w:${botOrderId}`));
      await ctx.container.provisionerLoop.tick();
      const botService = await services.findByOrderId(tenantA, botOrderId as never);
      expect(botService?.state).toBe('ACTIVE');
      await ctx.container.botRuntime.handle(
        tenantA,
        systemActor('bot'),
        tap(`nr:${botService?.id ?? ''}`),
      );
      const botRenewId = (
        await ctx.container.database.db.execute<{ id: string }>(
          sql`SELECT id FROM orders WHERE customer_id = ${botCustomer} AND purpose = 'RENEW'`,
        )
      ).rows[0]?.id as string;
      await ctx.container.botRuntime.handle(tenantA, systemActor('bot'), tap(`w:${botRenewId}`));
      await ctx.container.provisionerLoop.tick();
      const botLog = await opsLogSince(botMarker);
      const botCodes = await opsCodesSince(botMarker);

      // --- the mini-app path, customer 2 --------------------------------------------------
      const miniMarker = ctx.container.clock.now();
      const token = await sessionFor(700202);
      const miniCustomer = await customerIdOf(700202);
      await credit(miniCustomer, 1_000_000n);

      const categories = await call(token, 'GET', MINIAPP_ROUTES.categories);
      expect(categories.statusCode, categories.body).toBe(200);
      const listed = await call(token, 'GET', MINIAPP_ROUTES.category, {
        categoryId: SEED_IDS.categoryA,
      });
      expect(JSON.parse(listed.body).items.map((one: { id: string }) => one.id)).toContain(
        productId,
      );

      const created = await call(token, 'POST', MINIAPP_ROUTES.orders, {}, { productId });
      expect(created.statusCode, created.body).toBe(201);
      const draft = miniAppOrderSchema.parse(JSON.parse(created.body));
      expect(draft).toMatchObject({ state: 'DRAFT', purpose: 'NEW_SERVICE' });
      expect(draft.total).toEqual({ amountMinor: '250000', currency: 'IRT' });

      const routes = miniAppPaymentRoutesResponseSchema.parse(
        JSON.parse(
          (await call(token, 'GET', MINIAPP_ROUTES.orderRoutes, { orderId: draft.id })).body,
        ),
      );
      expect(routes.wallet).toMatchObject({ sufficient: true, shortfall: null });

      const paid = await call(token, 'POST', MINIAPP_ROUTES.orderPayWallet, { orderId: draft.id });
      expect(paid.statusCode, paid.body).toBe(201);
      await ctx.container.provisionerLoop.tick();

      const list = miniAppServicesResponseSchema.parse(
        JSON.parse((await call(token, 'GET', MINIAPP_ROUTES.services)).body),
      );
      expect(list.total).toBe(1);
      const serviceId = list.items[0]?.id as string;
      const detail = miniAppServiceDetailSchema.parse(
        JSON.parse((await call(token, 'GET', MINIAPP_ROUTES.service, { serviceId })).body),
      );
      expect(detail.state).toBe('ACTIVE');
      expect(detail.subscriptionUrl).not.toBeNull();
      expect(detail.actions).toContain('RENEW');
      const qr = await call(token, 'GET', MINIAPP_ROUTES.serviceQr, { serviceId });
      expect(qr.statusCode).toBe(200);
      expect(qr.headers['content-type']).toBe('image/png');

      const offer = miniAppServiceOfferSchema.parse(
        JSON.parse(
          (await call(token, 'GET', MINIAPP_ROUTES.serviceOffer, { serviceId, kind: 'RENEW' }))
            .body,
        ),
      );
      expect(offer.options[0]?.price).toEqual({ amountMinor: '250000', currency: 'IRT' });
      const quote = await call(
        token,
        'POST',
        MINIAPP_ROUTES.serviceQuote,
        { serviceId },
        { kind: 'RENEW' },
      );
      expect(quote.statusCode, quote.body).toBe(201);
      const renewal = miniAppOrderSchema.parse(JSON.parse(quote.body));
      const renewed = await call(token, 'POST', MINIAPP_ROUTES.orderPayWallet, {
        orderId: renewal.id,
      });
      expect(renewed.statusCode, renewed.body).toBe(201);
      await ctx.container.provisionerLoop.tick();
      const miniLog = await opsLogSince(miniMarker);
      const miniCodes = await opsCodesSince(miniMarker);

      // --- the same money, the same ledger, the same records, the same operations log -----
      const strip = <T extends { source_surface: string | null }>(rows: T[]) =>
        rows.map(({ source_surface: _ignored, ...rest }) => rest);
      expect(strip(await ordersOf(miniCustomer))).toEqual(strip(await ordersOf(botCustomer)));
      expect(strip(await paymentsOf(miniCustomer))).toEqual(strip(await paymentsOf(botCustomer)));
      expect(await ledgerOf(miniCustomer)).toEqual(await ledgerOf(botCustomer));
      expect(await ledgerOf(miniCustomer)).toEqual([
        { direction: 'DEBIT', reason: 'PURCHASE', amount: '250000' },
        { direction: 'DEBIT', reason: 'PURCHASE', amount: '250000' },
      ]);
      expect(miniCodes).toEqual(botCodes);
      expect(miniLog, 'the same operations-log lines').toEqual(botLog);
      expect(miniLog.length, 'the purchase and the renewal are logged').toBeGreaterThan(0);
      const miniService = await services.findById(tenantA, serviceId);
      expect(miniService?.state).toBe('ACTIVE');
      expect(miniService?.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 55 * 86_400_000);

      // --- and the mini app is recorded as the source of every one of its rows ------------
      expect((await ordersOf(miniCustomer)).map((row) => row.source_surface)).toEqual([
        'MINI_APP',
        'MINI_APP',
      ]);
      expect((await paymentsOf(miniCustomer)).map((row) => row.source_surface)).toEqual([
        'MINI_APP',
        'MINI_APP',
      ]);
      expect((await ordersOf(botCustomer)).map((row) => row.source_surface)).toEqual([
        'TELEGRAM',
        'TELEGRAM',
      ]);
      // The audit rows of the mini app's purchase and renewal carry MINI_APP — the column the
      // operations log's «منبع: مینی‌اپ» line is derived from (C2) — and the bot's do not.
      const audited = async (customerId: UserId) =>
        (
          await ctx.container.database.db.execute<{ surface: string }>(
            sql`SELECT DISTINCT a.source_surface AS surface FROM audit_logs a
                  JOIN orders o ON a.entity_id = o.id::text
                 WHERE o.customer_id = ${customerId}`,
          )
        ).rows.map((row) => row.surface);
      expect(await audited(miniCustomer)).toEqual(['MINI_APP']);
      expect(await audited(botCustomer)).toEqual(['TELEGRAM']);
    }, 60_000);

    it('refuses a wallet payment the balance does not cover, before confirming anything', async () => {
      const panelId = await marzbanPanel();
      const productId = await product(panelId);
      const token = await sessionFor(700203);
      const created = miniAppOrderSchema.parse(
        JSON.parse((await call(token, 'POST', MINIAPP_ROUTES.orders, {}, { productId })).body),
      );
      const refused = await call(token, 'POST', MINIAPP_ROUTES.orderPayWallet, {
        orderId: created.id,
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.body).toContain('commerce.wallet_insufficient_funds');
      expect(refused.body).toContain('"shortfallMinor":"250000"');
      const order = miniAppOrderSchema.parse(
        JSON.parse((await call(token, 'GET', MINIAPP_ROUTES.order, { orderId: created.id })).body),
      );
      expect(order.state, 'the draft was not confirmed').toBe('DRAFT');
    });
  });

  // =====================================================================================
  // Card to card, the receipt upload, the payment and wallet history
  // =====================================================================================

  describe('card to card and the receipt', () => {
    async function cardInstruction(token: string) {
      const panelId = await marzbanPanel();
      const productId = await product(panelId);
      const created = miniAppOrderSchema.parse(
        JSON.parse((await call(token, 'POST', MINIAPP_ROUTES.orders, {}, { productId })).body),
      );
      const card = await call(token, 'POST', MINIAPP_ROUTES.orderPayCard, { orderId: created.id });
      expect(card.statusCode, card.body).toBe(201);
      return miniAppCardInstructionSchema.parse(JSON.parse(card.body));
    }

    const upload = (token: string, paymentId: string, bytes: Buffer, mimeType: string) =>
      call(
        token,
        'POST',
        MINIAPP_ROUTES.paymentReceipt,
        { paymentId },
        {
          mimeType,
          imageBase64: bytes.toString('base64'),
        },
      );

    it('gives the card and the exact amount, and files an uploaded receipt like the bot does', async () => {
      const token = await sessionFor(700301);
      const instruction = await cardInstruction(token);
      expect(instruction.amount).toEqual({ amountMinor: '250000', currency: 'IRT' });
      // v0.8.2 hotfix: shown as the bot's card invoice shows it — rial, Toman in brackets —
      // and copied as the same rial digits.
      expect(instruction).toMatchObject({
        amountRial: '۲٬۵۰۰٬۰۰۰',
        amountToman: '۲۵۰٬۰۰۰',
        copyAmount: '2500000',
      });
      expect(instruction.destination?.cardNumber).toMatch(/^\d{16}$/u);

      const filed = await upload(token, instruction.paymentId, PNG, 'image/png');
      expect(filed.statusCode, filed.body).toBe(201);
      expect(JSON.parse(filed.body)).toMatchObject({ filed: true, first: true });

      // The bytes went to Telegram through the customer's bot, into their own chat, and
      // that message was removed again: no message is left behind.
      const photo = sent.find((one) => one.url.endsWith('/sendPhoto'));
      expect(photo?.url).toContain(`/bot${TOKEN_A1}/sendPhoto`);
      const removed = sent.find((one) => one.url.endsWith('/deleteMessage'));
      expect(removed?.body).toMatchObject({ chat_id: '700301' });

      // The receipt row has the bot path's shape for a photo, against this payment.
      const receipts = await ctx.container.database.db.execute<Record<string, unknown>>(
        sql`SELECT payment_id, bot_instance_id, kind, file_id, file_unique_id, mime_type, file_name,
                   caption FROM payment_receipts`,
      );
      expect(receipts.rows).toEqual([
        {
          payment_id: instruction.paymentId,
          bot_instance_id: BOT_A1,
          kind: 'PHOTO',
          file_id: 'FILE-1',
          file_unique_id: 'UNIQ-1',
          mime_type: null,
          file_name: null,
          caption: null,
        },
      ]);
      // The same receipt sent the bot's way, by another customer: the same kind of row,
      // the same audit action and the same event. Only what Telegram's own message carries
      // differs — its message id and its declared size, which the upload's deleted message
      // does not have to give.
      const botUser = 700399;
      const botCustomer = (
        await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
          idempotencyKey: 'resolve-receipt-bot',
          telegramUserId: String(botUser),
          from: { id: botUser, first_name: 'ربات' },
          botInstanceId: BOT_A1,
        })
      ).customer.id;
      let seq = 900_000;
      const update = (payload: Record<string, unknown>) => {
        seq += 1;
        return {
          idempotencyKey: `receipt-bot-${String(seq)}`,
          botInstanceId: BOT_A1,
          update: { update_id: seq, ...payload },
          telegramUserId: String(botUser),
          from: { id: botUser, first_name: 'ربات' },
        };
      };
      const botTap = (data: string) =>
        update({
          callback_query: {
            id: `cbq-${String(seq + 1)}`,
            from: { id: botUser, is_bot: false, first_name: 'ربات' },
            data,
            message: {
              message_id: seq + 1,
              date: 0,
              chat: { id: botUser, type: 'private' },
              from: { id: 999999, is_bot: true, first_name: 'Nexa' },
            },
          },
        });
      const productRow = await ctx.container.database.db.execute<{ id: string }>(
        sql`SELECT id FROM products LIMIT 1`,
      );
      await ctx.container.botRuntime.handle(
        tenantA,
        systemActor('bot'),
        botTap(`p:${productRow.rows[0]?.id ?? ''}`),
      );
      const botOrder = (
        await ctx.container.database.db.execute<{ id: string }>(
          sql`SELECT id FROM orders WHERE customer_id = ${botCustomer}`,
        )
      ).rows[0]?.id as string;
      await ctx.container.botRuntime.handle(tenantA, systemActor('bot'), botTap(`m:${botOrder}`));
      const botPayment = (
        await ctx.container.database.db.execute<{ id: string }>(
          sql`SELECT id FROM payments WHERE customer_id = ${botCustomer}`,
        )
      ).rows[0]?.id as string;
      await ctx.container.botRuntime.handle(tenantA, systemActor('bot'), botTap(`i:${botPayment}`));
      await ctx.container.botRuntime.handle(
        tenantA,
        systemActor('bot'),
        update({
          message: {
            message_id: 4242,
            date: 0,
            chat: { id: botUser, type: 'private' },
            from: { id: botUser, is_bot: false, first_name: 'ربات' },
            photo: [
              {
                file_id: 'BOT-SMALL',
                file_unique_id: 'bot-s',
                file_size: 100,
                width: 90,
                height: 90,
              },
              {
                file_id: 'BOT-FILE',
                file_unique_id: 'bot-u',
                file_size: 9000,
                width: 900,
                height: 900,
              },
            ],
          },
        }),
      );
      const shapes = await ctx.container.database.db.execute<Record<string, unknown>>(
        sql`SELECT kind, mime_type, file_name, caption, bot_instance_id FROM payment_receipts
             ORDER BY created_at`,
      );
      expect(shapes.rows).toHaveLength(2);
      expect(shapes.rows[1], 'the bot path files the same shape').toEqual(shapes.rows[0]);
      const audits = await ctx.container.database.db.execute<{ action: string; surface: string }>(
        sql`SELECT action, source_surface AS surface FROM audit_logs
             WHERE entity_id IN (${instruction.paymentId}, ${botPayment})
               AND action LIKE 'payment.receipt%' ORDER BY occurred_at`,
      );
      expect(audits.rows).toHaveLength(2);
      expect(audits.rows[1]?.action, 'the same audit action').toBe(audits.rows[0]?.action);
      expect(audits.rows.map((row) => row.surface)).toEqual(['MINI_APP', 'TELEGRAM']);
      const events = await ctx.container.database.db.execute<{ event_type: string }>(
        sql`SELECT event_type FROM outbox_messages WHERE event_type LIKE 'PaymentReceipt%'`,
      );
      expect(events.rows.map((row) => row.event_type)).toEqual([
        'PaymentReceiptSubmitted',
        'PaymentReceiptSubmitted',
      ]);

      const status = await call(token, 'GET', MINIAPP_ROUTES.payment, {
        paymentId: instruction.paymentId,
      });
      expect(JSON.parse(status.body)).toMatchObject({
        method: 'MANUAL_TRANSFER',
        state: 'PENDING',
        transferPending: true,
        receiptFiled: true,
      });
    });

    it('a retried upload with the same key is filed once, and Telegram is asked once', async () => {
      const token = await sessionFor(700302);
      const instruction = await cardInstruction(token);
      const fixedKey = key();
      const send = () =>
        inject({
          method: 'POST',
          url: `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES.paymentReceipt, {
            paymentId: instruction.paymentId,
          })}`,
          headers: { authorization: `Bearer ${token}`, 'idempotency-key': fixedKey },
          payload: { mimeType: 'image/png', imageBase64: PNG.toString('base64') },
        });
      expect((await send()).statusCode).toBe(201);
      const again = await send();
      expect(again.statusCode, again.body).toBe(201);
      expect(JSON.parse(again.body)).toMatchObject({ first: false });
      expect(sent.filter((one) => one.url.endsWith('/sendPhoto'))).toHaveLength(1);
      const count = await ctx.container.database.db.execute(sql`SELECT 1 FROM payment_receipts`);
      expect(count.rows).toHaveLength(1);
    });

    it('refuses a wrong type, a spoofed type, an oversized image — before Telegram is asked', async () => {
      const token = await sessionFor(700303);
      const instruction = await cardInstruction(token);
      const pdf = Buffer.from('%PDF-1.7 not a picture');
      const notImage = await upload(token, instruction.paymentId, pdf, 'application/pdf');
      expect(notImage.statusCode).toBe(400);
      expect(notImage.body).toContain('NOT_AN_IMAGE');
      const spoofed = await upload(token, instruction.paymentId, pdf, 'image/jpeg');
      expect(spoofed.statusCode).toBe(400);
      expect(spoofed.body).toContain('NOT_AN_IMAGE');
      const mismatch = await upload(token, instruction.paymentId, PNG, 'image/jpeg');
      expect(mismatch.statusCode).toBe(400);
      expect(mismatch.body).toContain('TYPE_MISMATCH');
      const big = Buffer.concat([PNG, Buffer.alloc(MINIAPP_RECEIPT_MAX_BYTES + 1 - PNG.length)]);
      const oversized = await upload(token, instruction.paymentId, big, 'image/png');
      expect(oversized.statusCode).toBe(400);
      expect(oversized.body).toContain('TOO_LARGE');
      expect(sent.filter((one) => one.url.endsWith('/sendPhoto'))).toHaveLength(0);
      const count = await ctx.container.database.db.execute(sql`SELECT 1 FROM payment_receipts`);
      expect(count.rows).toHaveLength(0);
    });

    it('refuses — never redirects — an upload whose window moved to another payment mid-upload', async () => {
      const token = await sessionFor(700310);
      const topup = async (amountMinor: string) => {
        const response = await call(
          token,
          'POST',
          MINIAPP_ROUTES.walletTopup,
          {},
          { amount: { amountMinor, currency: 'IRT' }, provider: 'MANUAL_TRANSFER' },
        );
        expect(response.statusCode, response.body).toBe(201);
        return (JSON.parse(response.body) as { instruction: { paymentId: string } }).instruction
          .paymentId;
      };
      const paymentA = (await cardInstruction(token)).paymentId;
      const paymentB = await topup('120000');
      expect(paymentB).not.toBe(paymentA);

      // While Telegram holds the upload for A, the same customer taps «I paid» for B: the
      // receipt window is re-opened for B before A's file reaches the receipt service.
      let moved = 0;
      duringPhoto = async () => {
        duringPhoto = null;
        const tap = await call(token, 'POST', MINIAPP_ROUTES.paymentTransferSent, {
          paymentId: paymentB,
        });
        expect(tap.statusCode, tap.body).toBeLessThan(300);
        moved += 1;
      };
      const refused = await upload(token, paymentA, PNG, 'image/png');
      expect(moved, 'the window really moved during the upload').toBe(1);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(JSON.parse(refused.body)).toMatchObject({
        error: { code: 'miniapp.receipt_refused', details: { reason: 'WINDOW_MOVED' } },
      });

      // Nothing was filed — not against A, and above all not against B.
      const receipts = await ctx.container.database.db.execute(
        sql`SELECT payment_id FROM payment_receipts`,
      );
      expect(receipts.rows).toEqual([]);
      const submitted = await ctx.container.database.db.execute(
        sql`SELECT 1 FROM outbox_messages WHERE event_type = 'PaymentReceiptSubmitted'`,
      );
      expect(submitted.rows).toHaveLength(0);
      // The upload's message was still removed from the customer's chat.
      const removed = sent.filter((one) => one.url.endsWith('/deleteMessage'));
      expect(removed).toHaveLength(1);
      expect(removed[0]?.body).toMatchObject({ chat_id: '700310' });

      // The customer's retry for A (a new request) re-opens the window for A and files there.
      const retried = await upload(token, paymentA, PNG, 'image/png');
      expect(retried.statusCode, retried.body).toBe(201);
      const filed = await ctx.container.database.db.execute<{ payment_id: string }>(
        sql`SELECT payment_id FROM payment_receipts`,
      );
      expect(filed.rows).toEqual([{ payment_id: paymentA }]);
    });

    it("refuses a receipt for another customer's payment, and never asks Telegram", async () => {
      const ownerToken = await sessionFor(700304);
      const instruction = await cardInstruction(ownerToken);
      const intruder = await sessionFor(700305);
      const refused = await upload(intruder, instruction.paymentId, PNG, 'image/png');
      expect(refused.statusCode).toBe(404);
      expect(refused.body).toContain('miniapp.not_found');
      expect(sent.filter((one) => one.url.endsWith('/sendPhoto'))).toHaveLength(0);
      for (const route of [MINIAPP_ROUTES.payment, MINIAPP_ROUTES.paymentTransferSent]) {
        const other = await call(
          intruder,
          route === MINIAPP_ROUTES.payment ? 'GET' : 'POST',
          route,
          {
            paymentId: instruction.paymentId,
          },
        );
        expect(other.statusCode, route).toBe(404);
      }
    });

    it('lists only the customer’s own payments and own ledger', async () => {
      const token = await sessionFor(700306);
      await cardInstruction(token);
      const otherToken = await sessionFor(700307);
      await credit(await customerIdOf(700307), 5_000n);
      await credit(await customerIdOf(700306), 7_000n);

      const mine = miniAppPaymentListSchema.parse(
        JSON.parse((await call(token, 'GET', MINIAPP_ROUTES.payments)).body),
      );
      expect(mine.items).toHaveLength(1);
      expect(mine.items[0]).toMatchObject({ method: 'MANUAL_TRANSFER', state: 'PENDING' });
      const theirs = miniAppPaymentListSchema.parse(
        JSON.parse((await call(otherToken, 'GET', MINIAPP_ROUTES.payments)).body),
      );
      expect(theirs.items).toHaveLength(0);

      const ledger = miniAppWalletEntriesSchema.parse(
        JSON.parse((await call(token, 'GET', MINIAPP_ROUTES.walletEntries)).body),
      );
      expect(ledger.items.map((entry) => entry.amount.amountMinor)).toEqual(['7000']);
      const otherLedger = miniAppWalletEntriesSchema.parse(
        JSON.parse((await call(otherToken, 'GET', MINIAPP_ROUTES.walletEntries)).body),
      );
      expect(otherLedger.items.map((entry) => entry.amount.amountMinor)).toEqual(['5000']);
    });

    it('starts a card-to-card top-up through the same request, recorded as the mini app', async () => {
      const token = await sessionFor(700308);
      const quote = await call(
        token,
        'POST',
        MINIAPP_ROUTES.walletTopupQuote,
        {},
        {
          amount: { amountMinor: '100000', currency: 'IRT' },
        },
      );
      expect(quote.statusCode, quote.body).toBe(201);
      const routes = JSON.parse(quote.body) as { outcome: string; routes: { provider: string }[] };
      expect(routes.outcome).toBe('ROUTES');
      expect(routes.routes.map((route) => route.provider)).toContain('MANUAL_TRANSFER');
      const topup = await call(
        token,
        'POST',
        MINIAPP_ROUTES.walletTopup,
        {},
        {
          amount: { amountMinor: '100000', currency: 'IRT' },
          provider: 'MANUAL_TRANSFER',
        },
      );
      expect(topup.statusCode, topup.body).toBe(201);
      expect(JSON.parse(topup.body)).toMatchObject({
        kind: 'CARD_TO_CARD',
        instruction: { amount: { amountMinor: '100000', currency: 'IRT' }, orderId: null },
      });
      const rows = await ctx.container.database.db.execute<{
        source_surface: string;
        order_id: null;
      }>(
        sql`SELECT source_surface, order_id FROM payments WHERE customer_id = ${await customerIdOf(700308)}`,
      );
      expect(rows.rows).toEqual([{ source_surface: 'MINI_APP', order_id: null }]);
      // A top-up has no order whose own read could refuse an intruder: the payment's own
      // ownership check is the only thing between another customer and its status.
      const paymentId = (JSON.parse(topup.body) as { instruction: { paymentId: string } })
        .instruction.paymentId;
      const intruder = await sessionFor(700309);
      const peek = await call(intruder, 'GET', MINIAPP_ROUTES.payment, { paymentId });
      expect(peek.statusCode, peek.body).toBe(404);
      expect((await call(token, 'GET', MINIAPP_ROUTES.payment, { paymentId })).statusCode).toBe(
        200,
      );
    });
  });

  // =====================================================================================
  // Ownership, route by route
  // =====================================================================================

  describe('ownership', () => {
    it("answers another customer's order, service and ticket as not found", async () => {
      const panelId = await marzbanPanel();
      const productId = await product(panelId);
      const alice = await sessionFor(700401);
      const bob = await sessionFor(700402);
      await credit(await customerIdOf(700401), 1_000_000n);
      const order = miniAppOrderSchema.parse(
        JSON.parse((await call(alice, 'POST', MINIAPP_ROUTES.orders, {}, { productId })).body),
      );

      const orderRoutes: ['GET' | 'POST' | 'PUT', string, unknown?][] = [
        ['GET', MINIAPP_ROUTES.order],
        ['GET', MINIAPP_ROUTES.orderRoutes],
        ['POST', MINIAPP_ROUTES.orderConfirm],
        ['POST', MINIAPP_ROUTES.orderCancel],
        ['POST', MINIAPP_ROUTES.orderPayWallet],
        ['POST', MINIAPP_ROUTES.orderPayCard],
        ['POST', MINIAPP_ROUTES.orderPayGateway, { provider: 'TONPAYS' }],
        ['PUT', MINIAPP_ROUTES.orderDiscount, { code: null }],
        ['POST', MINIAPP_ROUTES.orderUsername, { mode: 'AUTOMATIC' }],
      ];
      for (const [method, route, body] of orderRoutes) {
        const refused = await call(bob, method, route, { orderId: order.id }, body);
        expect(refused.statusCode, `${method} ${route}: ${refused.body}`).toBe(404);
      }
      // Nothing Bob asked for happened to Alice's order.
      const still = miniAppOrderSchema.parse(
        JSON.parse((await call(alice, 'GET', MINIAPP_ROUTES.order, { orderId: order.id })).body),
      );
      expect(still.state).toBe('DRAFT');

      await call(alice, 'POST', MINIAPP_ROUTES.orderPayWallet, { orderId: order.id });
      await ctx.container.provisionerLoop.tick();
      const serviceId = miniAppServicesResponseSchema.parse(
        JSON.parse((await call(alice, 'GET', MINIAPP_ROUTES.services)).body),
      ).items[0]?.id as string;
      const serviceRoutes: ['GET' | 'POST', string, Record<string, string>, unknown?][] = [
        ['GET', MINIAPP_ROUTES.service, { serviceId }],
        ['GET', MINIAPP_ROUTES.serviceQr, { serviceId }],
        ['GET', MINIAPP_ROUTES.serviceOffer, { serviceId, kind: 'RENEW' }],
        ['POST', MINIAPP_ROUTES.serviceQuote, { serviceId }, { kind: 'RENEW' }],
        ['GET', MINIAPP_ROUTES.serviceLocations, { serviceId }],
        ['POST', MINIAPP_ROUTES.serviceLocation, { serviceId }, { locationId: serviceId }],
      ];
      for (const [method, route, params, body] of serviceRoutes) {
        const refused = await call(bob, method, route, params, body);
        expect(refused.statusCode, `${method} ${route}: ${refused.body}`).toBe(404);
      }
      expect(
        miniAppServicesResponseSchema.parse(
          JSON.parse((await call(bob, 'GET', MINIAPP_ROUTES.services)).body),
        ).total,
      ).toBe(0);

      const categories = JSON.parse(
        (await call(alice, 'GET', MINIAPP_ROUTES.ticketCategories)).body,
      ) as { items: { id: string }[] };
      const opened = await call(
        alice,
        'POST',
        MINIAPP_ROUTES.tickets,
        {},
        {
          categoryId: categories.items[0]?.id,
          text: 'سرویس وصل نمی‌شود',
        },
      );
      expect(opened.statusCode, opened.body).toBe(201);
      const ticketId = (JSON.parse(opened.body) as { id: string }).id;
      expect((await call(bob, 'GET', MINIAPP_ROUTES.ticket, { ticketId })).statusCode).toBe(404);
      expect(
        (await call(bob, 'POST', MINIAPP_ROUTES.ticketReplies, { ticketId }, { text: 'من' }))
          .statusCode,
      ).toBe(404);
      expect(JSON.parse((await call(bob, 'GET', MINIAPP_ROUTES.tickets)).body).items).toHaveLength(
        0,
      );
      const tickets = await ctx.container.database.db.execute<{ source_surface: string }>(
        sql`SELECT source_surface FROM tickets`,
      );
      expect(tickets.rows).toEqual([{ source_surface: 'MINI_APP' }]);
      const reply = await call(
        alice,
        'POST',
        MINIAPP_ROUTES.ticketReplies,
        { ticketId },
        { text: 'هنوز' },
      );
      expect(reply.statusCode, reply.body).toBe(201);
    }, 60_000);

    it('a state-changing request without its own idempotency key is refused', async () => {
      const token = await sessionFor(700403);
      const response = await inject({
        method: 'POST',
        url: `${MINIAPP_API_PREFIX}${MINIAPP_ROUTES.orders}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { productId: ctx.container.ids.uuid() },
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).toContain('miniapp.request_invalid');
    });

    it('limits one customer to the request budget', async () => {
      const token = await sessionFor(700404);
      let last = 0;
      for (let index = 0; index < 121; index += 1) {
        last = (await call(token, 'GET', MINIAPP_ROUTES.me)).statusCode;
      }
      expect(last).toBe(429);
    }, 60_000);
  });
});
