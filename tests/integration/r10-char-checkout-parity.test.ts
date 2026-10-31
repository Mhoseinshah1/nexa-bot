import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  MINIAPP_API_PREFIX,
  MINIAPP_ROUTES,
  miniAppCardInstructionSchema,
  miniAppGatewayAttemptSchema,
  miniAppOrderSchema,
  miniAppPath,
  miniAppPaymentRoutesResponseSchema,
  miniAppServicesResponseSchema,
  miniAppTopupQuoteResponseSchema,
  money,
  PAYMENT_GATEWAY_DESCRIPTORS,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type PaymentGatewayConfig,
  type PaymentGatewayProvider,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import type { DiscountRuleWrite } from '../../apps/api/src/modules/commerce/pricing/application/ports';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  SEED_IDS,
  tenantA,
  testConfig,
  validatePanelConnection,
  type TestContext,
} from './harness';
import { makePin, viewOf, type View } from './r9-char-support';

/**
 * Round 10, B1: ONE checkout for the bot and the mini app.
 *
 * Round 9 (C5) gave the mini app its own copy of the bot's checkout rules — which lane
 * confirms a draft, which routes an order offers and in what order, whether the wallet
 * covers a total and the shortfall, which gateway a tap may start — so the bot's keyboards
 * stayed byte-identical. This file is the characterization written BEFORE the two were made
 * one: for the same cart, against the real services, the bot (driven through
 * `BotRuntime.handle` as the webhook drives it) and the mini app (over real HTTP) produce the
 * same quote, the same routes in the same order, and the same confirm outcome — the same
 * debit, the same gateway attempt with the same fee, the same refusal before anything is
 * confirmed. The bot's keyboards and texts for each case are pinned byte for byte.
 *
 * The routes configured, in the operator's order:
 *   NOWPAYMENTS      sort 0, DISABLED                   — never offered
 *   TONPAYS          sort 1, unbounded, 5 % fee         — every cart
 *   MANUAL_TRANSFER  sort 2, unbounded                  — card to card, drawn here
 *   TETRAPAY         sort 3, at most 500,000            — the small cart only
 *   RIALIT           sort 4, at least 300,000           — the large cart only
 */

const BOT_A1 = SEED_IDS.botA1 as BotInstanceId;
const TOKEN_A1 = '000000:seed-token-acme-1';
const BOT_USER = 731001;
const MINI_USER = 731002;
const SMALL = 250_000n;
const LARGE = 1_000_000n;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

const OPEN_ROUTE: PaymentGatewayConfig = {
  displayName: null,
  instructions: null,
  minAmountMinor: 0n,
  maxAmountMinor: 0n,
  eligibility: {
    activateAfterPayments: 0,
    deactivateAfterPayments: 0,
    activateAfterAccountDays: 0,
  },
  sortOrder: 0,
  topupCashbackPercent: 0,
  allowServicePurchase: true,
  allowWalletTopup: true,
};

const CODE_RULE: DiscountRuleWrite = {
  kind: 'CODE',
  code: 'R10OFF',
  label: 'کد آزمون',
  type: 'PERCENTAGE',
  value: 20n,
  currency: null,
  appliesTo: ['NEW_SERVICE'],
  productId: null,
  categoryId: null,
  customerId: null,
  firstPurchaseOnly: false,
  minimumSubtotal: null,
  startsAt: null,
  endsAt: null,
  totalLimit: null,
  perCustomerLimit: null,
  priority: 0,
  stackable: false,
};

/** Telegram's own signer for a mini-app launch, independently of the verifier. */
function initDataFor(user: { id: number; first_name: string }): string {
  const fields: Record<string, string> = {
    query_id: `q-${String(user.id)}-${String(Math.random()).slice(2, 10)}`,
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const check = Object.keys(fields)
    .sort()
    .map((name) => `${name}=${fields[name]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN_A1).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

/** The per-run values on these screens: deadlines, public codes. Ids are masked by `viewOf`. */
const stable = (view: View): View => ({
  ...view,
  text: view.text
    .replace(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/gu, '<time>')
    .replace(/(کد سفارش: )[A-Z0-9]{8}/gu, '$1<code>')
    .replace(/(کد پیگیری پرداخت: )[A-Z0-9]{8}/gu, '$1<code>')
    .replace(/(مهلت واریز: ساعت )\d{2}:\d{2}/gu, '$1<time>')
    .replace(/(نام کاربری: )[a-z0-9]+/gu, '$1<username>'),
});

/*
 * Soft, so a run reports EVERY side that diverges rather than stopping at the first: a rule
 * broken in the shared checkout must show red on the bot's screens and on the mini app's
 * answers alike, and a hard assertion would hide the second behind the first.
 */
const pin = makePin(expectedViews(), (actual, expected, label) =>
  expect.soft(actual, label).toEqual(expected),
);

describe('one checkout: the bot and the mini app, for the same cart', () => {
  let ctx: TestContext;
  let api: ApiApp;
  let telegram: Server;
  let sent: { url: string; body: Record<string, unknown> }[] = [];
  let owner: ActorContext;
  let marzban: FakeMarzban | undefined;
  let seq = 0;
  let updateSeq = 0;

  const key = () => `r10-b1-key-${String((seq += 1)).padStart(6, '0')}-abcdef`;
  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          body = { unparseable: true };
        }
        sent.push({ url: request.url ?? '', body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const env = {
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
  });

  afterEach(async () => {
    await marzban?.close();
    marzban = undefined;
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    api.container.setInstallationTenant(tenantA.tenantId);
    sent = [];
    insertedPanel = undefined;
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'r10-owner', roleKeys: ['owner'] }),
    );
    const flag = await ctx.container.featureFlagResolver.resolve(tenantA, 'mini_app');
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'mini_app',
      enabled: true,
      expectedVersion: flag.version,
      idempotencyKey: key(),
      reason: 'r10 checkout characterization',
    });
    await route('NOWPAYMENTS', { sortOrder: 0 }, false);
    await route('TONPAYS', { sortOrder: 1, customerFeeBasisPoints: 500, topupCashbackPercent: 10 });
    await route('MANUAL_TRANSFER', { sortOrder: 2 });
    await route('TETRAPAY', { sortOrder: 3, maxAmountMinor: 500_000n, displayName: 'درگاه تترا' });
    await route('RIALIT', { sortOrder: 4, minAmountMinor: 300_000n, displayName: 'ریالیت' });
  });

  // --- fixtures ------------------------------------------------------------------------

  async function route(
    provider: PaymentGatewayProvider,
    config: Partial<PaymentGatewayConfig>,
    active = true,
  ): Promise<void> {
    const gateways = ctx.container.paymentGateways;
    await gateways.configure(tenantA, owner, {
      idempotencyKey: key(),
      provider,
      config: { ...OPEN_ROUTE, ...config },
    });
    if (PAYMENT_GATEWAY_DESCRIPTORS[provider].requiresCredentials) {
      await gateways.setCredential(tenantA, owner, {
        idempotencyKey: key(),
        provider,
        apiKey: `test-key-${provider.toLowerCase()}-0123456789`,
      });
    }
    if (active) {
      await gateways.setStatus(tenantA, owner, {
        idempotencyKey: key(),
        provider,
        status: 'ACTIVE',
      });
    }
  }

  let insertedPanel: string | undefined;
  async function plainPanel(): Promise<string> {
    const id = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${id}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(ctx.container, tenantA, id);
    insertedPanel = id;
    return id;
  }

  async function marzbanPanel(): Promise<string> {
    marzban = await startFakeMarzban({ host: '127.0.0.2' });
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: marzban.baseUrl,
      credentials: { username: marzban.username, password: marzban.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: key(),
    });
    const id = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, id);
    return id;
  }

  async function product(price: bigint, panelId?: string): Promise<ProductId> {
    const panel = panelId ?? insertedPanel ?? (await plainPanel());
    const products = new DrizzleProductRepository(ctx.container.database.db);
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: price === SMALL ? 'پلن پایه' : 'پلن ویژه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panel as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: money(price, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return created.id;
  }

  const credit = (customerId: UserId, amountMinor: bigint) =>
    ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: key(),
      direction: 'CREDIT',
      amountMinor,
      currency: 'IRT',
      note: 'fixture',
    });

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await ctx.container.database.db.execute(query)).rows as T[];
  }

  // --- the bot ---------------------------------------------------------------------------

  async function botCustomer(): Promise<UserId> {
    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: `resolve-${String(BOT_USER)}`,
      telegramUserId: String(BOT_USER),
      from: { id: BOT_USER, first_name: 'ربات' },
      botInstanceId: BOT_A1,
    });
    return resolved.customer.id;
  }

  const update = (payload: Record<string, unknown>) => {
    updateSeq += 1;
    return {
      idempotencyKey: `r10-update-${String(updateSeq)}`,
      botInstanceId: BOT_A1,
      update: { update_id: updateSeq, ...payload },
      telegramUserId: String(BOT_USER),
      from: { id: BOT_USER, first_name: 'ربات' },
    };
  };
  const chat = { id: BOT_USER, type: 'private' };
  const person = { id: BOT_USER, is_bot: false, first_name: 'ربات' };

  /** One bot turn, as the webhook delivers it; the last message Telegram was asked to draw. */
  async function bot(kind: 'tap' | 'text', value: string): Promise<View> {
    sent.length = 0;
    const payload =
      kind === 'tap'
        ? {
            callback_query: {
              id: `cbq-${String(updateSeq + 1)}`,
              from: person,
              data: value,
              message: {
                message_id: updateSeq + 1,
                date: 0,
                chat,
                from: { id: 999_999, is_bot: true, first_name: 'Nexa' },
              },
            },
          }
        : {
            message: { message_id: updateSeq + 1, date: 0, chat, from: person, text: value },
          };
    const result = await ctx.container.botRuntime.handle(
      tenantA,
      systemActor('r10-bot'),
      update(payload),
    );
    const drawn = sent.filter(
      (one) => one.url.includes('/sendMessage') || one.url.includes('/editMessageText'),
    );
    return stable(viewOf(result, drawn[drawn.length - 1]?.body));
  }

  const tap = (data: string) => bot('tap', data);

  /**
   * A draft the way the bot makes one: the product tap, then «🎲 انتخاب خودکار», which
   * answers the pre-invoice. Returns the order id and that pre-invoice.
   */
  async function botDraftOf(customerId: UserId, productId: ProductId) {
    await tap(`p:${productId}`);
    const id = await botOrder(customerId);
    return { id, preinvoice: await tap(`Z:${id}`) };
  }

  /** The bot customer's newest order of a purpose: its draft from a `p:` tap. */
  async function botOrder(customerId: UserId, purpose = 'NEW_SERVICE'): Promise<string> {
    const [row] = await rows<{ id: string }>(
      sql`SELECT id FROM orders WHERE customer_id = ${customerId} AND purpose = ${purpose}
           ORDER BY created_at DESC, id DESC LIMIT 1`,
    );
    if (row === undefined) throw new Error('no bot order');
    return row.id;
  }

  // --- the mini app ----------------------------------------------------------------------

  async function miniSession(): Promise<{ token: string; customerId: UserId }> {
    const minted = await inject({
      method: 'POST',
      url: `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES.session, { botInstanceId: BOT_A1 })}`,
      payload: { initData: initDataFor({ id: MINI_USER, first_name: 'مینی' }) },
    });
    expect.soft(minted.statusCode, minted.body).toBe(201);
    const [row] = await rows<{ id: string }>(
      sql`SELECT id FROM customers WHERE tenant_id = ${tenantA.tenantId}
            AND telegram_user_id = ${String(MINI_USER)}`,
    );
    if (row === undefined) throw new Error('no mini customer');
    return {
      token: (JSON.parse(minted.body) as { token: string }).token,
      customerId: row.id as UserId,
    };
  }

  const call = (
    token: string,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    params: Record<string, string> = {},
    payload?: unknown,
  ) =>
    inject({
      method,
      url: `${MINIAPP_API_PREFIX}${miniAppPath(path, params)}`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': key() }),
      },
      ...(payload === undefined ? {} : { payload }),
    });

  /** A draft and its username, the way the mini app makes one: an automatic name. */
  async function miniDraft(token: string, productId: ProductId) {
    const created = await call(token, 'POST', MINIAPP_ROUTES.orders, {}, { productId });
    expect.soft(created.statusCode, created.body).toBe(201);
    const { id } = miniAppOrderSchema.parse(JSON.parse(created.body));
    const named = await call(
      token,
      'POST',
      MINIAPP_ROUTES.orderUsername,
      { orderId: id },
      { mode: 'AUTOMATIC' },
    );
    expect.soft(named.statusCode, named.body).toBe(201);
    return miniAppOrderSchema.parse(JSON.parse(named.body));
  }

  async function miniRoutes(token: string, orderId: string) {
    const response = await call(token, 'GET', MINIAPP_ROUTES.orderRoutes, { orderId });
    expect.soft(response.statusCode, response.body).toBe(200);
    return miniAppPaymentRoutesResponseSchema.parse(JSON.parse(response.body));
  }

  // --- the records both paths leave -------------------------------------------------------

  async function ordersOf(customerId: UserId) {
    return rows<Record<string, string | null>>(
      sql`SELECT purpose, state, subtotal_amount::text AS subtotal, discount_amount::text AS discount,
                 total_amount::text AS total, currency, discount_code,
                 (quote::jsonb - 'quotedAt') AS quote
            FROM orders WHERE customer_id = ${customerId} ORDER BY created_at, id`,
    );
  }

  async function paymentsOf(customerId: UserId) {
    return rows<Record<string, string | number | null>>(
      sql`SELECT method, state, amount::text AS amount, currency, gateway_provider,
                 customer_fee_basis_points, customer_fee_amount::text AS fee,
                 payable_amount::text AS payable
            FROM payments WHERE customer_id = ${customerId} ORDER BY created_at, id`,
    );
  }

  async function ledgerOf(customerId: UserId) {
    return rows<Record<string, string>>(
      sql`SELECT direction, reason, amount::text AS amount FROM wallet_entries
           WHERE customer_id = ${customerId} AND reason <> 'ADMIN_CREDIT'
           ORDER BY created_at, id`,
    );
  }

  /**
   * The bot's route buttons against the mini app's route list: the same kinds and providers
   * in the same order, and each button labelled with the route name the mini app shows.
   */
  function expectSameRoutes(
    view: View,
    routes: readonly { kind: string; provider: string; name: string }[],
    label: string,
  ): void {
    const drawn = view.buttons.flat().flatMap(([text, data]) => {
      if (data.startsWith('gp:')) {
        return [{ kind: 'GATEWAY', provider: data.split('.').pop() ?? '', text }];
      }
      // The bot's card-to-card tap names no provider: every such route is the one `m:` tap.
      if (data.startsWith('m:')) return [{ kind: 'CARD_TO_CARD', provider: '', text }];
      return [];
    });
    expect
      .soft(
        drawn.map(({ kind, provider }) => ({ kind, provider })),
        `${label}: the same routes, in the same order`,
      )
      .toEqual(
        routes.map((one) => ({
          kind: one.kind,
          provider: one.kind === 'CARD_TO_CARD' ? '' : one.provider,
        })),
      );
    drawn.forEach((button, index) => {
      expect
        .soft(button.text, `${label}: route ${String(index)} is named alike`)
        .toContain(routes[index]?.name ?? '<missing>');
    });
  }

  // =====================================================================================

  it('quotes the same cart the same way and offers the same routes in the same order', async () => {
    const small = await product(SMALL);
    const large = await product(LARGE);
    const botId = await botCustomer();
    const mini = await miniSession();

    for (const [label, productId] of [
      ['small', small],
      ['large', large],
    ] as const) {
      const { id: botDraft, preinvoice } = await botDraftOf(botId, productId);
      pin(`${label}.preinvoice`, preinvoice);
      const miniOrder = await miniDraft(mini.token, productId);

      const [botRow] = (await ordersOf(botId)).filter((row) => row.state === 'DRAFT').slice(-1);
      const [miniRow] = (await ordersOf(mini.customerId)).slice(-1);
      expect.soft(miniRow, `${label}: the same quote`).toEqual(botRow);
      expect.soft(miniOrder.total).toEqual({
        amountMinor: String(productId === small ? SMALL : LARGE),
        currency: 'IRT',
      });

      const methods = await tap(`pm:${botDraft}`);
      pin(`${label}.methods`, methods);
      const listed = await miniRoutes(mini.token, miniOrder.id);
      expectSameRoutes(methods, listed.routes, label);
      expect.soft(listed.routes.map((one) => [one.provider, one.paysInChat])).toEqual(
        label === 'small'
          ? [
              ['TONPAYS', false],
              ['MANUAL_TRANSFER', false],
              ['TETRAPAY', false],
            ]
          : [
              ['TONPAYS', false],
              ['MANUAL_TRANSFER', false],
              ['RIALIT', false],
            ],
      );
    }
  }, 60_000);

  it('draws card to card last while it is offered but its own bounds leave it out, and not at all once it is off for purchases', async () => {
    const small = await product(SMALL);
    const botId = await botCustomer();
    const mini = await miniSession();
    await route('MANUAL_TRANSFER', { sortOrder: 2, minAmountMinor: 900_000n });

    const { id: botDraft } = await botDraftOf(botId, small);
    const miniOrder = await miniDraft(mini.token, small);
    const last = await tap(`pm:${botDraft}`);
    pin('manual-out-of-bounds.methods', last);
    const lastListed = (await miniRoutes(mini.token, miniOrder.id)).routes;
    expectSameRoutes(last, lastListed, 'manual last');
    expect
      .soft(lastListed.map((one) => one.provider))
      .toEqual(['TONPAYS', 'TETRAPAY', 'MANUAL_TRANSFER']);

    await route('MANUAL_TRANSFER', { sortOrder: 2, allowServicePurchase: false });
    const none = await tap(`pm:${botDraft}`);
    pin('manual-off.methods', none);
    const noneListed = (await miniRoutes(mini.token, miniOrder.id)).routes;
    expectSameRoutes(none, noneListed, 'manual off');
    expect.soft(noneListed.map((one) => one.provider)).toEqual(['TONPAYS', 'TETRAPAY']);
  }, 60_000);

  it('refuses a wallet payment the balance does not cover before confirming anything, and settles one it covers', async () => {
    const small = await product(SMALL);
    const botId = await botCustomer();
    const mini = await miniSession();
    await credit(botId, 100_000n);
    await credit(mini.customerId, 100_000n);

    const { id: botDraft } = await botDraftOf(botId, small);
    const miniOrder = await miniDraft(mini.token, small);

    pin('wallet.short', await tap(`w:${botDraft}`));
    const refused = await call(mini.token, 'POST', MINIAPP_ROUTES.orderPayWallet, {
      orderId: miniOrder.id,
    });
    expect.soft(refused.statusCode).toBe(409);
    expect.soft(JSON.parse(refused.body)).toMatchObject({
      error: {
        code: 'commerce.wallet_insufficient_funds',
        details: { shortfallMinor: '150000', currency: 'IRT' },
      },
    });
    expect.soft((await miniRoutes(mini.token, miniOrder.id)).wallet).toEqual({
      balance: { amountMinor: '100000', currency: 'IRT' },
      sufficient: false,
      shortfall: { amountMinor: '150000', currency: 'IRT' },
    });
    // Neither path confirmed the draft (no reservation for money that is not there).
    expect.soft(await ordersOf(botId)).toEqual(await ordersOf(mini.customerId));
    expect.soft((await ordersOf(botId)).map((row) => row.state)).toEqual(['DRAFT']);
    expect.soft((await ordersOf(mini.customerId)).map((row) => row.state)).toEqual(['DRAFT']);
    expect.soft(await paymentsOf(botId)).toEqual([]);
    expect.soft(await paymentsOf(mini.customerId)).toEqual([]);

    // The exact total is enough: the coverage rule is "not below", not "above".
    await credit(botId, 150_000n);
    await credit(mini.customerId, 150_000n);
    expect.soft((await miniRoutes(mini.token, miniOrder.id)).wallet).toEqual({
      balance: { amountMinor: '250000', currency: 'IRT' },
      sufficient: true,
      shortfall: null,
    });
    pin('wallet.settled', await tap(`w:${botDraft}`));
    const paid = await call(mini.token, 'POST', MINIAPP_ROUTES.orderPayWallet, {
      orderId: miniOrder.id,
    });
    expect.soft(paid.statusCode, paid.body).toBe(201);

    expect.soft(await ordersOf(mini.customerId)).toEqual(await ordersOf(botId));
    expect.soft((await ordersOf(botId)).map((row) => row.state)).toEqual(['PAID']);
    expect.soft((await ordersOf(mini.customerId)).map((row) => row.state)).toEqual(['PAID']);
    expect.soft(await paymentsOf(mini.customerId)).toEqual(await paymentsOf(botId));
    expect.soft(await ledgerOf(mini.customerId)).toEqual(await ledgerOf(botId));
    expect
      .soft(await ledgerOf(botId))
      .toEqual([{ direction: 'DEBIT', reason: 'PURCHASE', amount: '250000' }]);
  }, 60_000);

  it('opens the same gateway attempt with the same fee, and refuses a route out of bounds or switched off before confirming', async () => {
    const small = await product(SMALL);
    const large = await product(LARGE);
    const botId = await botCustomer();
    const mini = await miniSession();

    const { id: botSmall } = await botDraftOf(botId, small);
    const miniSmall = await miniDraft(mini.token, small);
    // RIALIT's floor is above this total; NOWPAYMENTS is DISABLED.
    for (const provider of ['RIALIT', 'NOWPAYMENTS'] as const) {
      pin(`gateway.refused.${provider}`, await tap(`gp:${botSmall}.${provider}`));
      const refused = await call(
        mini.token,
        'POST',
        MINIAPP_ROUTES.orderPayGateway,
        { orderId: miniSmall.id },
        { provider },
      );
      expect.soft(refused.statusCode, refused.body).toBe(409);
      expect.soft(JSON.parse(refused.body)).toMatchObject({
        error: { code: 'miniapp.route_unavailable' },
      });
    }
    expect.soft((await ordersOf(botId)).map((row) => row.state)).toEqual(['DRAFT']);
    expect.soft((await ordersOf(mini.customerId)).map((row) => row.state)).toEqual(['DRAFT']);
    expect.soft(await ordersOf(mini.customerId)).toEqual(await ordersOf(botId));
    expect.soft(await paymentsOf(botId)).toEqual([]);
    expect.soft(await paymentsOf(mini.customerId)).toEqual([]);

    const { id: botLarge } = await botDraftOf(botId, large);
    const miniLarge = await miniDraft(mini.token, large);
    // TETRAPAY's ceiling is below this total.
    pin('gateway.refused.TETRAPAY', await tap(`gp:${botLarge}.TETRAPAY`));
    const ceiling = await call(
      mini.token,
      'POST',
      MINIAPP_ROUTES.orderPayGateway,
      { orderId: miniLarge.id },
      { provider: 'TETRAPAY' },
    );
    expect.soft(ceiling.statusCode).toBe(409);

    // The offered route, with its 5 % fee, on the small cart.
    pin('gateway.opened.TONPAYS', await tap(`gp:${botSmall}.TONPAYS`));
    const opened = await call(
      mini.token,
      'POST',
      MINIAPP_ROUTES.orderPayGateway,
      { orderId: miniSmall.id },
      { provider: 'TONPAYS' },
    );
    expect.soft(opened.statusCode, opened.body).toBe(201);
    expect.soft(miniAppGatewayAttemptSchema.parse(JSON.parse(opened.body))).toMatchObject({
      provider: 'TONPAYS',
      paysInChat: false,
    });
    // RIALIT on the large cart, where its floor admits the total.
    await tap(`gp:${botLarge}.RIALIT`);
    const rialit = await call(
      mini.token,
      'POST',
      MINIAPP_ROUTES.orderPayGateway,
      { orderId: miniLarge.id },
      { provider: 'RIALIT' },
    );
    expect.soft(rialit.statusCode, rialit.body).toBe(201);

    expect.soft(await ordersOf(mini.customerId)).toEqual(await ordersOf(botId));
    expect
      .soft((await ordersOf(botId)).map((row) => row.state))
      .toEqual(['AWAITING_PAYMENT', 'AWAITING_PAYMENT']);
    expect
      .soft((await ordersOf(mini.customerId)).map((row) => row.state))
      .toEqual(['AWAITING_PAYMENT', 'AWAITING_PAYMENT']);
    expect.soft(await paymentsOf(mini.customerId)).toEqual(await paymentsOf(botId));
    expect.soft(await paymentsOf(botId)).toEqual([
      {
        method: 'GATEWAY',
        state: 'PENDING',
        amount: '250000',
        currency: 'IRT',
        gateway_provider: 'TONPAYS',
        customer_fee_basis_points: 500,
        fee: '12500',
        payable: '262500',
      },
      {
        method: 'GATEWAY',
        state: 'PENDING',
        amount: '1000000',
        currency: 'IRT',
        gateway_provider: 'RIALIT',
        customer_fee_basis_points: 0,
        fee: '0',
        payable: '1000000',
      },
    ]);
  }, 60_000);

  it('confirms the draft and issues one card-to-card transfer with the same fee', async () => {
    const small = await product(SMALL);
    const botId = await botCustomer();
    const mini = await miniSession();
    await ctx.container.database.db.execute(
      sql`UPDATE payment_gateways SET customer_fee_basis_points = 1000
           WHERE tenant_id = ${tenantA.tenantId} AND provider = 'MANUAL_TRANSFER'`,
    );

    const { id: botDraft } = await botDraftOf(botId, small);
    const miniOrder = await miniDraft(mini.token, small);

    pin('card.instruction', await tap(`m:${botDraft}`));
    const card = await call(mini.token, 'POST', MINIAPP_ROUTES.orderPayCard, {
      orderId: miniOrder.id,
    });
    expect.soft(card.statusCode, card.body).toBe(201);
    expect.soft(miniAppCardInstructionSchema.parse(JSON.parse(card.body)).amount).toEqual({
      amountMinor: '275000',
      currency: 'IRT',
    });

    expect.soft(await ordersOf(mini.customerId)).toEqual(await ordersOf(botId));
    expect.soft((await ordersOf(botId)).map((row) => row.state)).toEqual(['AWAITING_PAYMENT']);
    expect
      .soft((await ordersOf(mini.customerId)).map((row) => row.state))
      .toEqual(['AWAITING_PAYMENT']);
    expect.soft(await paymentsOf(mini.customerId)).toEqual(await paymentsOf(botId));
    expect
      .soft(await paymentsOf(botId))
      .toMatchObject([
        { method: 'MANUAL_TRANSFER', state: 'PENDING', amount: '250000', payable: '275000' },
      ]);
  }, 60_000);

  it('refuses card to card before confirming a draft once it is not offered, on both, and confirms nothing', async () => {
    /*
     * R11 A6 (an open item of R10 B1). `payByCard` confirmed the DRAFT through its lane and
     * only then asked the payment service, which refused a route that is off — leaving the
     * draft AWAITING_PAYMENT, its capacity reserved, for a payment that could not be made.
     * The route is now checked first, by the rule the menu draws it with, and the refusal
     * is the payment service's own code, so each surface answers in its usual Persian.
     *
     * MUTATION: the `manualTransferOffered` check in `CheckoutService.payByCard` removed ->
     * both orders read AWAITING_PAYMENT and this case fails.
     */
    const small = await product(SMALL);
    const botId = await botCustomer();
    const mini = await miniSession();
    const { id: botDraft } = await botDraftOf(botId, small);
    const miniOrder = await miniDraft(mini.token, small);
    // Off for purchases — the same switch the menu reads, so `m:` is drawn on no screen.
    await route('MANUAL_TRANSFER', { sortOrder: 2, allowServicePurchase: false });

    const refusedBot = await tap(`m:${botDraft}`);
    expect.soft(refusedBot.key).toBe('bot.payment.unconfigured');
    const refusedMini = await call(mini.token, 'POST', MINIAPP_ROUTES.orderPayCard, {
      orderId: miniOrder.id,
    });
    expect.soft(refusedMini.statusCode, refusedMini.body).toBe(409);
    expect.soft(JSON.parse(refusedMini.body)).toMatchObject({
      error: { code: 'commerce.payment_method_unavailable' },
    });

    for (const customerId of [botId, mini.customerId]) {
      expect.soft((await ordersOf(customerId)).map((row) => row.state)).toEqual(['DRAFT']);
      expect.soft(await paymentsOf(customerId)).toEqual([]);
      const confirmations = await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM audit_logs a JOIN orders o ON a.entity_id = o.id::text
             WHERE o.customer_id = ${customerId} AND a.action = 'order.confirm'`,
      );
      expect.soft(confirmations[0]?.n, 'nothing was confirmed').toBe(0);
    }
    const held = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM panel_capacity_reservations
           WHERE order_id = ANY(${sql.param([botDraft, miniOrder.id])}::uuid[])`,
    );
    expect.soft(held[0]?.n, 'no capacity is held').toBe(0);

    // Switched back on, the same drafts are confirmed and issued as before.
    await route('MANUAL_TRANSFER', { sortOrder: 2 });
    await tap(`m:${botDraft}`);
    const issued = await call(mini.token, 'POST', MINIAPP_ROUTES.orderPayCard, {
      orderId: miniOrder.id,
    });
    expect.soft(issued.statusCode, issued.body).toBe(201);
    for (const customerId of [botId, mini.customerId]) {
      expect
        .soft((await ordersOf(customerId)).map((row) => row.state))
        .toEqual(['AWAITING_PAYMENT']);
      expect
        .soft(await paymentsOf(customerId))
        .toMatchObject([{ method: 'MANUAL_TRANSFER', state: 'PENDING' }]);
    }
  }, 60_000);

  it('re-quotes a draft under a code the same way, and the wallet pays the discounted total', async () => {
    const small = await product(SMALL);
    const created = await ctx.container.discounts.create(tenantA, owner, {
      idempotencyKey: key(),
      write: CODE_RULE,
    });
    await ctx.container.discounts.activate(tenantA, owner, {
      idempotencyKey: key(),
      discountId: created.rule.id,
    });
    const botId = await botCustomer();
    const mini = await miniSession();
    await credit(botId, 200_000n);
    await credit(mini.customerId, 200_000n);

    const { id: botDraft } = await botDraftOf(botId, small);
    const miniOrder = await miniDraft(mini.token, small);

    pin('discount.ask', await tap(`dc:${botDraft}`));
    pin('discount.preinvoice', await bot('text', ' r10off '));
    const coded = await call(
      mini.token,
      'PUT',
      MINIAPP_ROUTES.orderDiscount,
      { orderId: miniOrder.id },
      { code: ' r10off ' },
    );
    expect.soft(coded.statusCode, coded.body).toBe(200);
    expect.soft(miniAppOrderSchema.parse(JSON.parse(coded.body))).toMatchObject({
      subtotal: { amountMinor: '250000', currency: 'IRT' },
      discount: { amountMinor: '50000', currency: 'IRT' },
      total: { amountMinor: '200000', currency: 'IRT' },
      discountApplied: true,
    });
    expect.soft(await ordersOf(mini.customerId)).toEqual(await ordersOf(botId));

    // 200,000 covers the discounted total exactly, and not the list price.
    expect.soft((await miniRoutes(mini.token, miniOrder.id)).wallet.sufficient).toBe(true);
    pin('discount.settled', await tap(`w:${botDraft}`));
    const paid = await call(mini.token, 'POST', MINIAPP_ROUTES.orderPayWallet, {
      orderId: miniOrder.id,
    });
    expect.soft(paid.statusCode, paid.body).toBe(201);
    expect.soft(await ordersOf(mini.customerId)).toEqual(await ordersOf(botId));
    expect.soft(await ledgerOf(mini.customerId)).toEqual(await ledgerOf(botId));
    expect
      .soft(await ledgerOf(botId))
      .toEqual([{ direction: 'DEBIT', reason: 'PURCHASE', amount: '200000' }]);
  }, 60_000);

  it('confirms a renewal through the commercial lane on both, short wallet first, then the same gateway attempt', async () => {
    const panelId = await marzbanPanel();
    const small = await product(SMALL, panelId);
    const botId = await botCustomer();
    const mini = await miniSession();
    await credit(botId, SMALL);
    await credit(mini.customerId, SMALL);

    // Buy on each path from the wallet, and let the provisioner deliver both.
    await tap(`w:${(await botDraftOf(botId, small)).id}`);
    const bought = await miniDraft(mini.token, small);
    expect
      .soft(
        (await call(mini.token, 'POST', MINIAPP_ROUTES.orderPayWallet, { orderId: bought.id }))
          .statusCode,
      )
      .toBe(201);
    await ctx.container.provisionerLoop.tick();
    const [botService] = await rows<{ id: string }>(
      sql`SELECT id FROM services WHERE customer_id = ${botId}`,
    );
    const miniServices = miniAppServicesResponseSchema.parse(
      JSON.parse((await call(mini.token, 'GET', MINIAPP_ROUTES.services)).body),
    );
    const miniServiceId = miniServices.items[0]?.id ?? '';
    expect.soft(botService).toBeDefined();
    expect.soft(miniServiceId).not.toBe('');

    // The renewal quote on each path.
    pin('renew.preinvoice', await tap(`nr:${botService?.id ?? ''}`));
    const botRenew = await botOrder(botId, 'RENEW');
    const quoted = await call(
      mini.token,
      'POST',
      MINIAPP_ROUTES.serviceQuote,
      { serviceId: miniServiceId },
      { kind: 'RENEW' },
    );
    expect.soft(quoted.statusCode, quoted.body).toBe(201);
    const miniRenew = miniAppOrderSchema.parse(JSON.parse(quoted.body));

    // The wallet is empty now: refused before the commercial confirm, on both.
    pin('renew.wallet.short', await tap(`w:${botRenew}`));
    const short = await call(mini.token, 'POST', MINIAPP_ROUTES.orderPayWallet, {
      orderId: miniRenew.id,
    });
    expect.soft(short.statusCode).toBe(409);
    expect.soft(JSON.parse(short.body)).toMatchObject({
      error: {
        code: 'commerce.wallet_insufficient_funds',
        details: { shortfallMinor: '250000', currency: 'IRT' },
      },
    });
    expect.soft(await ordersOf(mini.customerId)).toEqual(await ordersOf(botId));
    expect
      .soft((await ordersOf(botId)).map((row) => `${String(row.purpose)}:${String(row.state)}`))
      .toEqual(['NEW_SERVICE:PAID', 'RENEW:DRAFT']);
    expect
      .soft(
        (await ordersOf(mini.customerId)).map(
          (row) => `${String(row.purpose)}:${String(row.state)}`,
        ),
      )
      .toEqual(['NEW_SERVICE:PAID', 'RENEW:DRAFT']);

    // A gateway: the renewal is confirmed through the commercial lane, then the attempt.
    pin('renew.gateway', await tap(`gp:${botRenew}.TONPAYS`));
    const opened = await call(
      mini.token,
      'POST',
      MINIAPP_ROUTES.orderPayGateway,
      { orderId: miniRenew.id },
      { provider: 'TONPAYS' },
    );
    expect.soft(opened.statusCode, opened.body).toBe(201);
    expect.soft(await ordersOf(mini.customerId)).toEqual(await ordersOf(botId));
    expect
      .soft((await ordersOf(botId)).map((row) => `${String(row.purpose)}:${String(row.state)}`))
      .toEqual(['NEW_SERVICE:PAID', 'RENEW:AWAITING_PAYMENT']);
    expect
      .soft(
        (await ordersOf(mini.customerId)).map(
          (row) => `${String(row.purpose)}:${String(row.state)}`,
        ),
      )
      .toEqual(['NEW_SERVICE:PAID', 'RENEW:AWAITING_PAYMENT']);
    expect.soft(await paymentsOf(mini.customerId)).toEqual(await paymentsOf(botId));
    // The commercial lane wrote its own record of the confirmation on both paths.
    const confirmedBy = async (customerId: UserId) =>
      (
        await rows<{ action: string }>(
          sql`SELECT DISTINCT a.action FROM audit_logs a JOIN orders o ON a.entity_id = o.id::text
               WHERE o.customer_id = ${customerId} AND o.purpose = 'RENEW' ORDER BY a.action`,
        )
      ).map((row) => row.action);
    expect.soft(await confirmedBy(botId)).toEqual(['service.action_confirm']);
    expect.soft(await confirmedBy(mini.customerId)).toEqual(['service.action_confirm']);
  }, 90_000);

  it("confirms a renewal from the bot's confirm tap through the commercial lane, as the mini app's confirm does", async () => {
    /*
     * R10 B1 divergence. The bot's CONFIRM intent (`c:<order>`, drawn by no screen today but
     * still decoded) sent EVERY order to `OrderService.confirm`, the lane of a new service:
     * a renewal draft confirmed there skips `CommercialActionService.confirm`'s re-check of
     * the service and of what was quoted. The mini app's confirm chose the lane by the
     * order's purpose. The stricter reading is the mini app's, and the bot now takes it.
     *
     * MUTATION: routing `purchase-flow` `confirm` back to `orders.confirm` audits
     * `order.confirm` for the bot's renewal and this case fails.
     */
    const panelId = await marzbanPanel();
    const small = await product(SMALL, panelId);
    const botId = await botCustomer();
    const mini = await miniSession();
    await credit(botId, SMALL);
    await credit(mini.customerId, SMALL);
    await tap(`w:${(await botDraftOf(botId, small)).id}`);
    const bought = await miniDraft(mini.token, small);
    expect
      .soft(
        (await call(mini.token, 'POST', MINIAPP_ROUTES.orderPayWallet, { orderId: bought.id }))
          .statusCode,
      )
      .toBe(201);
    await ctx.container.provisionerLoop.tick();
    const [botService] = await rows<{ id: string }>(
      sql`SELECT id FROM services WHERE customer_id = ${botId}`,
    );
    const miniServiceId =
      miniAppServicesResponseSchema.parse(
        JSON.parse((await call(mini.token, 'GET', MINIAPP_ROUTES.services)).body),
      ).items[0]?.id ?? '';

    await tap(`nr:${botService?.id ?? ''}`);
    const botRenew = await botOrder(botId, 'RENEW');
    const quoted = await call(
      mini.token,
      'POST',
      MINIAPP_ROUTES.serviceQuote,
      { serviceId: miniServiceId },
      { kind: 'RENEW' },
    );
    const miniRenew = miniAppOrderSchema.parse(JSON.parse(quoted.body));

    pin('renew.confirm-tap', await tap(`c:${botRenew}`));
    const confirmed = await call(mini.token, 'POST', MINIAPP_ROUTES.orderConfirm, {
      orderId: miniRenew.id,
    });
    expect.soft(confirmed.statusCode, confirmed.body).toBe(201);

    for (const customerId of [botId, mini.customerId]) {
      expect
        .soft(
          (await ordersOf(customerId)).map((row) => `${String(row.purpose)}:${String(row.state)}`),
        )
        .toEqual(['NEW_SERVICE:PAID', 'RENEW:AWAITING_PAYMENT']);
      const actions = (
        await rows<{ action: string }>(
          sql`SELECT DISTINCT a.action FROM audit_logs a JOIN orders o ON a.entity_id = o.id::text
               WHERE o.customer_id = ${customerId} AND o.purpose = 'RENEW' ORDER BY a.action`,
        )
      ).map((row) => row.action);
      expect
        .soft(actions, 'the commercial lane confirmed the renewal')
        .toEqual(['service.action_confirm']);
    }

    // Another customer's order through the same tap: the same refusal as before the change.
    pin('confirm-tap.foreign', await tap(`c:${miniRenew.id}`));
  }, 90_000);

  it('OrderService.confirm refuses an order on an existing service, in any state; its own lane confirms it', async () => {
    /*
     * R11 A6 (an open item of R10 B1). `OrderService.confirm` is the lane of an order that
     * CREATES a service; R10 B1 routed every renewal and package through
     * `CommercialActionService.confirm`, but the new-service lane still accepted one. No
     * caller passes one now (`CheckoutService.confirmDraft` dispatches by purpose; the manual
     * order drafts a product), so this is the refusal of a caller's bug: typed, nothing
     * written.
     *
     * MUTATION: the `orderPurposeTargetsExistingService` refusal in `OrderService.confirm`
     * removed -> the renewal is confirmed through the new-service lane and this case fails.
     */
    const panelId = await marzbanPanel();
    const small = await product(SMALL, panelId);
    const botId = await botCustomer();
    await credit(botId, SMALL);
    await tap(`w:${(await botDraftOf(botId, small)).id}`);
    await ctx.container.provisionerLoop.tick();
    const [service] = await rows<{ id: string }>(
      sql`SELECT id FROM services WHERE customer_id = ${botId}`,
    );
    const { order: renewal } = await ctx.container.commercialActions.draft(
      tenantA,
      systemActor('r11-a6-renew'),
      botId,
      { serviceId: service?.id ?? '', kind: 'RENEW', idempotencyKey: key() },
    );
    expect.soft(renewal.purpose).toBe('RENEW');

    const viaNewServiceLane = () =>
      ctx.container.orders
        .confirm(tenantA, systemActor('r11-a6-renew'), {
          idempotencyKey: key(),
          customerId: botId,
          orderId: renewal.id,
        })
        .then(
          () => null,
          (error: unknown) => error as { code?: string; details?: Record<string, unknown> },
        );
    const refused = await viaNewServiceLane();
    expect.soft(refused?.code).toBe('commerce.order_state_invalid');
    expect.soft(refused?.details).toEqual({ reason: 'COMMERCIAL_PURPOSE', purpose: 'RENEW' });
    const states = async () =>
      (await ordersOf(botId)).map((row) => `${String(row.purpose)}:${String(row.state)}`);
    expect.soft(await states()).toEqual(['NEW_SERVICE:PAID', 'RENEW:DRAFT']);
    const audited = async () =>
      (
        await rows<{ action: string }>(
          sql`SELECT DISTINCT a.action FROM audit_logs a WHERE a.entity_id = ${renewal.id}
               ORDER BY a.action`,
        )
      ).map((row) => row.action);
    expect
      .soft(await audited(), 'the new-service lane wrote nothing')
      .not.toContain('order.confirm');

    // Its own lane confirms it; the new-service lane still refuses it once it is confirmed.
    await ctx.container.commercialActions.confirm(tenantA, systemActor('r11-a6-renew'), botId, {
      orderId: renewal.id,
      idempotencyKey: key(),
    });
    expect.soft(await states()).toEqual(['NEW_SERVICE:PAID', 'RENEW:AWAITING_PAYMENT']);
    const again = await viaNewServiceLane();
    expect.soft(again?.code).toBe('commerce.order_state_invalid');
    expect.soft(again?.details).toEqual({ reason: 'COMMERCIAL_PURPOSE', purpose: 'RENEW' });
    expect.soft(await audited()).not.toContain('order.confirm');
  }, 90_000);

  it('offers a top-up the same routes, names and gifts', async () => {
    const mini = await miniSession();
    await botCustomer();
    await route('TETRAPAY', {
      sortOrder: 3,
      maxAmountMinor: 500_000n,
      displayName: 'درگاه تترا',
      allowWalletTopup: false,
    });

    await tap('o:');
    const chooser = await bot('text', '50000');
    pin('topup.chooser', chooser);
    const quoted = await call(
      mini.token,
      'POST',
      MINIAPP_ROUTES.walletTopupQuote,
      {},
      { amount: { amountMinor: '50000', currency: 'IRT' } },
    );
    expect.soft(quoted.statusCode, quoted.body).toBe(201);
    const parsed = miniAppTopupQuoteResponseSchema.parse(JSON.parse(quoted.body));
    if (parsed.outcome !== 'ROUTES') throw new Error(parsed.outcome);
    const drawn = chooser.buttons.flat().filter(([, data]) => data.startsWith('tp:'));
    expect
      .soft(parsed.routes.map((one) => one.provider))
      .toEqual(drawn.map(([, data]) => data.split('.').pop()));
    expect.soft(parsed.routes.map((one) => [one.provider, one.kind, one.giftPercent])).toEqual([
      ['TONPAYS', 'GATEWAY', 10],
      ['MANUAL_TRANSFER', 'CARD_TO_CARD', 0],
    ]);
    parsed.routes.forEach((one, index) => {
      const label = drawn[index]?.[0] ?? '<missing>';
      expect.soft(label, `top-up route ${String(index)} is named alike`).toContain(one.name);
      // The gift is in the bot's label exactly when the mini app shows one.
      expect.soft(label.includes(`+${String(one.giftPercent)}٪`)).toBe(one.giftPercent > 0);
    });
  }, 60_000);
});

function expectedViews(): Record<string, View> {
  return {
    'small.preinvoice': {
      intent: 'USERNAME_AUTOMATIC',
      key: 'bot.order.preinvoice',
      text: '🧾 پیش\u200cفاکتور\n🔖 کد سفارش: <code>\n\n📦 سرویس: پلن پایه\n👤 نام کاربری: <username>\n📅 مدت: 30 روز\n📊 حجم: 50 گیگابایت\n💵 مبلغ سفارش: 250,000 تومان\n\n💰 موجودی کیف پول: 0 تومان\n\n🛒 سفارش شما آماده پرداخت است؛ روش پرداخت را با دکمه\u200cهای زیر انتخاب کنید. اگر روشی کارمزد داشته باشد، کارمزد و مبلغ قابل پرداخت در فاکتور همان روش جداگانه نمایش داده می\u200cشود.',
      buttons: [
        [['💰 پرداخت از کیف پول', 'w:<id>']],
        [['🧾 ثبت پرداخت', 'pm:<id>']],
        [['🏷 اعمال کد تخفیف', 'dc:<id>']],
        [['🏠 بازگشت به منوی اصلی', 'mm:']],
      ],
    },
    'small.methods': {
      intent: 'PAY_METHODS',
      key: 'bot.wallet.topup_method_prompt',
      text: '💰 روش پرداخت را انتخاب کنید.',
      buttons: [
        [['پرداخت با درگاه پرداخت تون پی وبسایت', 'gp:<id>.TONPAYS']],
        [['پرداخت با کارت به کارت', 'm:<id>']],
        [['پرداخت با درگاه تترا', 'gp:<id>.TETRAPAY']],
        [['❌ بستن لیست', 'px:<id>']],
      ],
    },
    'large.preinvoice': {
      intent: 'USERNAME_AUTOMATIC',
      key: 'bot.order.preinvoice',
      text: '🧾 پیش\u200cفاکتور\n🔖 کد سفارش: <code>\n\n📦 سرویس: پلن ویژه\n👤 نام کاربری: <username>\n📅 مدت: 30 روز\n📊 حجم: 50 گیگابایت\n💵 مبلغ سفارش: 1,000,000 تومان\n\n💰 موجودی کیف پول: 0 تومان\n\n🛒 سفارش شما آماده پرداخت است؛ روش پرداخت را با دکمه\u200cهای زیر انتخاب کنید. اگر روشی کارمزد داشته باشد، کارمزد و مبلغ قابل پرداخت در فاکتور همان روش جداگانه نمایش داده می\u200cشود.',
      buttons: [
        [['💰 پرداخت از کیف پول', 'w:<id>']],
        [['🧾 ثبت پرداخت', 'pm:<id>']],
        [['🏷 اعمال کد تخفیف', 'dc:<id>']],
        [['🏠 بازگشت به منوی اصلی', 'mm:']],
      ],
    },
    'large.methods': {
      intent: 'PAY_METHODS',
      key: 'bot.wallet.topup_method_prompt',
      text: '💰 روش پرداخت را انتخاب کنید.',
      buttons: [
        [['پرداخت با درگاه پرداخت تون پی وبسایت', 'gp:<id>.TONPAYS']],
        [['پرداخت با کارت به کارت', 'm:<id>']],
        [['پرداخت با ریالیت', 'gp:<id>.RIALIT']],
        [['❌ بستن لیست', 'px:<id>']],
      ],
    },
    'manual-out-of-bounds.methods': {
      intent: 'PAY_METHODS',
      key: 'bot.wallet.topup_method_prompt',
      text: '💰 روش پرداخت را انتخاب کنید.',
      buttons: [
        [['پرداخت با درگاه پرداخت تون پی وبسایت', 'gp:<id>.TONPAYS']],
        [['پرداخت با درگاه تترا', 'gp:<id>.TETRAPAY']],
        [['پرداخت با کارت به کارت', 'm:<id>']],
        [['❌ بستن لیست', 'px:<id>']],
      ],
    },
    'manual-off.methods': {
      intent: 'PAY_METHODS',
      key: 'bot.wallet.topup_method_prompt',
      text: '💰 روش پرداخت را انتخاب کنید.',
      buttons: [
        [['پرداخت با درگاه پرداخت تون پی وبسایت', 'gp:<id>.TONPAYS']],
        [['پرداخت با درگاه تترا', 'gp:<id>.TETRAPAY']],
        [['❌ بستن لیست', 'px:<id>']],
      ],
    },
    'wallet.short': {
      intent: 'PAY_WALLET',
      key: 'bot.wallet.insufficient',
      text: '⚠️ موجودی کیف پول کافی نیست. کمبود: 150,000 تومان',
      // R12 F3 item 7: the shortfall carries the way back to the pre-invoice.
      buttons: [
        [['💰 افزایش موجودی', 'o:']],
        [['🔙 بازگشت به پیش‌فاکتور', 'ib:<id>']],
        [['🏠 بازگشت به منوی اصلی', 'mm:']],
      ],
    },
    'wallet.settled': {
      intent: 'PAY_WALLET',
      key: 'bot.order.settled',
      text: '📦 سرویس شما در حال ساخته شدن است. نتیجه به شما اطلاع داده می\u200cشود.',
      buttons: [],
    },
    'gateway.refused.RIALIT': {
      intent: 'PAY_GATEWAY',
      key: 'bot.payment.gateway_unavailable',
      text: 'این روش پرداخت در حال حاضر در دسترس نیست. لطفاً روش دیگری را انتخاب کنید یا کمی بعد دوباره تلاش کنید.',
      buttons: [[['🧾 ثبت پرداخت', 'pm:<id>']], [['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'gateway.refused.NOWPAYMENTS': {
      intent: 'PAY_GATEWAY',
      key: 'bot.payment.gateway_unavailable',
      text: 'این روش پرداخت در حال حاضر در دسترس نیست. لطفاً روش دیگری را انتخاب کنید یا کمی بعد دوباره تلاش کنید.',
      buttons: [[['🧾 ثبت پرداخت', 'pm:<id>']], [['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'gateway.refused.TETRAPAY': {
      intent: 'PAY_GATEWAY',
      key: 'bot.payment.gateway_unavailable',
      text: 'این روش پرداخت در حال حاضر در دسترس نیست. لطفاً روش دیگری را انتخاب کنید یا کمی بعد دوباره تلاش کنید.',
      buttons: [[['🧾 ثبت پرداخت', 'pm:<id>']], [['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'gateway.opened.TONPAYS': {
      intent: 'PAY_GATEWAY',
      key: 'bot.payment.gateway_preparing',
      text: '⏳ فاکتور پرداخت آنلاین شما در حال ساخت است.\n\nچند لحظه صبر کنید؛ لینک پرداخت به\u200cمحض آماده شدن در همین پیام نمایش داده می\u200cشود.\n\nکد پیگیری پرداخت: <code>',
      buttons: [[['🔄 بررسی وضعیت پرداخت', 'gc:<id>']], [['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'card.instruction': {
      intent: 'PAY_MANUAL',
      key: 'bot.payment.transfer_instructions',
      text: '🧾 فاکتور کارت\u200cبه\u200cکارت\nمبلغ قابل واریز:\n<b>۲٬۷۵۰٬۰۰۰ ریال</b>\n(معادل ۲۷۵٬۰۰۰ تومان)\n⚠️ دقیقاً همین مبلغ را واریز کنید، سپس تصویر رسید را ارسال کنید؛ پرداخت شما پس از بررسی رسید تأیید می\u200cشود.\n💳 کارت مقصد:\n6037 9912 3456 7893\n👤 Acme Store\nبانک: بانک ملی ایران\nشبا: IR429600000001003242000012\n⏳ مهلت واریز: ساعت <time>\nکد پیگیری پرداخت: <code>',
      buttons: [
        [
          ['📋 کپی مبلغ (ریال)', ''],
          ['💳 کپی شماره کارت', ''],
        ],
        [
          ['📤 ارسال رسید', 'i:<id>'],
          ['❌ لغو فاکتور', 'x:<id>'],
        ],
        [['🏠 بازگشت به منوی اصلی', 'mm:']],
      ],
    },
    'discount.ask': {
      intent: 'DISCOUNT_CODE_ENTER',
      key: 'bot.discount.ask',
      text: 'کد تخفیف خود را ارسال کنید',
      // R12 F3 item 2: a typed prompt carries back and cancel.
      buttons: [
        [
          ['🔙 بازگشت به پیش‌فاکتور', 'ib:<id>'],
          ['انصراف', 'iz:'],
        ],
      ],
    },
    'discount.preinvoice': {
      intent: 'USERNAME_TEXT',
      key: 'bot.order.preinvoice',
      text: '🧾 پیش\u200cفاکتور\n🔖 کد سفارش: <code>\n\n📦 سرویس: پلن پایه\n👤 نام کاربری: <username>\n📅 مدت: 30 روز\n📊 حجم: 50 گیگابایت\n🏷 تخفیف: 50,000 تومان (قیمت پیش از تخفیف: 250,000 تومان)\n💵 مبلغ سفارش: 200,000 تومان\n\n💰 موجودی کیف پول: 200,000 تومان\n\n🛒 سفارش شما آماده پرداخت است؛ روش پرداخت را با دکمه\u200cهای زیر انتخاب کنید. اگر روشی کارمزد داشته باشد، کارمزد و مبلغ قابل پرداخت در فاکتور همان روش جداگانه نمایش داده می\u200cشود.',
      buttons: [
        [['💰 پرداخت از کیف پول', 'w:<id>']],
        [['🧾 ثبت پرداخت', 'pm:<id>']],
        [['حذف کد تخفیف', 'dx:<id>']],
        [['🏠 بازگشت به منوی اصلی', 'mm:']],
      ],
    },
    'discount.settled': {
      intent: 'PAY_WALLET',
      key: 'bot.order.settled',
      text: '📦 سرویس شما در حال ساخته شدن است. نتیجه به شما اطلاع داده می\u200cشود.',
      buttons: [],
    },
    'renew.preinvoice': {
      intent: 'SERVICE_RENEW_QUOTE',
      key: 'bot.order.preinvoice',
      text: '🧾 پیش\u200cفاکتور\n🔖 کد سفارش: <code>\n\n📦 سرویس: پلن پایه\n👤 نام کاربری: <username>\n📅 مدت: 30 روز\n💵 مبلغ سفارش: 250,000 تومان\n\n💰 موجودی کیف پول: 0 تومان\n\n🛒 سفارش شما آماده پرداخت است؛ روش پرداخت را با دکمه\u200cهای زیر انتخاب کنید. اگر روشی کارمزد داشته باشد، کارمزد و مبلغ قابل پرداخت در فاکتور همان روش جداگانه نمایش داده می\u200cشود.',
      buttons: [
        [['💰 پرداخت از کیف پول', 'w:<id>']],
        [['🧾 ثبت پرداخت', 'pm:<id>']],
        [['🏠 بازگشت به منوی اصلی', 'mm:']],
      ],
    },
    'renew.wallet.short': {
      intent: 'PAY_WALLET',
      key: 'bot.wallet.insufficient',
      text: '⚠️ موجودی کیف پول کافی نیست. کمبود: 250,000 تومان',
      // R12 F3 item 7: the shortfall carries the way back to the pre-invoice.
      buttons: [
        [['💰 افزایش موجودی', 'o:']],
        [['🔙 بازگشت به پیش‌فاکتور', 'ib:<id>']],
        [['🏠 بازگشت به منوی اصلی', 'mm:']],
      ],
    },
    'renew.gateway': {
      intent: 'PAY_GATEWAY',
      key: 'bot.payment.gateway_preparing',
      text: '⏳ فاکتور پرداخت آنلاین شما در حال ساخت است.\n\nچند لحظه صبر کنید؛ لینک پرداخت به\u200cمحض آماده شدن در همین پیام نمایش داده می\u200cشود.\n\nکد پیگیری پرداخت: <code>',
      buttons: [[['🔄 بررسی وضعیت پرداخت', 'gc:<id>']], [['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'topup.chooser': {
      intent: 'USERNAME_TEXT',
      key: 'bot.wallet.topup_method_prompt',
      text: '💰 روش پرداخت را انتخاب کنید.',
      buttons: [
        [['درگاه پرداخت تون پی وبسایت (+10٪ هدیه)', 'tp:<id>.TONPAYS']],
        [['پرداخت با کارت به کارت', 'tp:<id>.MANUAL_TRANSFER']],
        [['❌ بستن لیست', 'tx:<id>']],
      ],
    },
    'renew.confirm-tap': {
      intent: 'CONFIRM',
      key: 'bot.order.awaiting_payment',
      text: 'سفارش ثبت شد و در انتظار پرداخت است.\nمبلغ: 250,000 تومان\nاعتبار تا: <time>',
      buttons: [
        [['💰 پرداخت از کیف پول', 'w:<id>']],
        [['🧾 ثبت پرداخت', 'pm:<id>']],
        [['لغو سفارش', 'd:<id>']],
      ],
    },
    'confirm-tap.foreign': {
      intent: 'CONFIRM',
      key: 'bot.order.unavailable',
      text: '⚠️ این سرویس در حال حاضر قابل خرید نیست.',
      // R12 F3 item 3 (no dead ends): the refusal's way on is «🛒 خرید سرویس» and the main menu.
      buttons: [[['🛒 خرید سرویس', 'co:']], [['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
  };
}
