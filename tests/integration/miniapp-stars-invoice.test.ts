import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  MINIAPP_API_PREFIX,
  MINIAPP_ROUTES,
  TELEGRAM_SECRET_TOKEN_HEADER,
  miniAppGatewayAttemptSchema,
  miniAppOrderSchema,
  miniAppPath,
  miniAppPaymentRoutesResponseSchema,
  miniAppPaymentStatusSchema,
  miniAppStarsInvoiceSchema,
  money,
  type ActorContext,
  type BotInstanceId,
  type PanelId,
  type PaymentGatewayConfig,
  type ProductCategoryId,
  type ProductId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  testConfig,
  validatePanelConnection,
} from './harness';

/**
 * R11 B5 — Telegram Stars paid INSIDE the mini app (`Telegram.WebApp.openInvoice`), end to end.
 *
 * The real API app over a real database; Telegram is a recording fake. The customer opens the
 * order and its Stars attempt through the mini app's own endpoints, asks for the invoice link,
 * and pays it — and the payment arrives exactly as Telegram delivers every Stars payment: a
 * `pre_checkout_query` and a `successful_payment` on the bot's authenticated webhook, decided
 * and settled by the existing code. What this file pins is that the link is that same invoice
 * (same payload, same XTR amount), made once per attempt, offered only where the bot offers
 * Stars, and that nothing the client says makes an order paid.
 */

const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-mini-stars';
const BOT_A1 = SEED_IDS.botA1 as BotInstanceId;
const TOKEN_A1 = '000000:seed-token-acme-1';
const MARYAM = 930930;
const USDT_TOMAN = 130_000n;
const STARS_PER_USDT = '100';

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

interface Call {
  readonly method: string;
  readonly token: string;
  readonly body: Record<string, unknown>;
}

/** Telegram's own Mini App signer, independently of the verifier. */
function initDataFor(id: number): string {
  const fields: Record<string, string> = {
    query_id: `q-${String(id)}-${String(Math.random()).slice(2, 10)}`,
    user: JSON.stringify({ id, first_name: 'مریم' }),
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const check = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN_A1).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

describe('Telegram Stars inside the mini app (R11 B5)', () => {
  let api: ApiApp;
  let telegram: Server;
  let calls: Call[] = [];
  let panel: FakeMarzban | null = null;
  let owner: ActorContext;
  let seq = 0;
  let linkSeq = 0;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);
  const key = () => `mini-stars-${String((seq += 1)).padStart(6, '0')}-abcdef`;

  beforeAll(async () => {
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const [, tokenPart = '', method = ''] = (request.url ?? '').split('/');
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          body = {};
        }
        calls.push({ method, token: tokenPart.replace(/^bot/u, ''), body });
        response.writeHead(200, { 'content-type': 'application/json' });
        const result =
          method === 'createInvoiceLink'
            ? `https://t.me/$invoice-${String((linkSeq += 1))}`
            : method === 'answerPreCheckoutQuery' || method === 'answerCallbackQuery'
              ? true
              : { message_id: (seq += 1) };
        response.end(JSON.stringify({ ok: true, result }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const config = testConfig({
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    // Nothing here ever asks Telegram to refund Stars (Package A, brief A6).
    expect(calls.some((one) => one.method === 'refundStarPayment')).toBe(false);
    await panel?.close();
    await api?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  beforeEach(async () => {
    await panel?.close();
    panel = null;
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    calls = [];
    owner = adminActorFor(
      await createAdmin(api.container, tenantA, {
        username: 'owner-mini-stars',
        roleKeys: ['owner'],
      }),
    );
    await setFlag('mini_app', true);
  });

  // --- fixtures ------------------------------------------------------------------------

  async function setFlag(flag: string, enabled: boolean) {
    const current = await api.container.featureFlagResolver.resolve(tenantA, flag as never);
    if (current.enabled === enabled) return;
    await api.container.featureFlags.set(tenantA, owner, {
      key: flag as never,
      enabled,
      expectedVersion: current.version,
      idempotencyKey: key(),
      reason: 'mini-app Stars integration test',
    });
  }

  async function enableStars() {
    await api.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TELEGRAM_STARS',
      config: OPEN_ROUTE,
    });
    await setFlag('central_fx', true);
    const current = await api.container.settingsService.get(tenantA, owner, 'stars.per_usdt');
    await api.container.settingsService.set(tenantA, owner, {
      key: 'stars.per_usdt',
      value: STARS_PER_USDT,
      expectedVersion: current.version,
      idempotencyKey: key(),
    });
    await api.container.database.db.execute(
      sql`INSERT INTO fx_quotes (tenant_id, base_asset, quote_currency, rate_mantissa, rate_scale,
                                 source, fetched_at, quote_id, policy_version)
          VALUES (${tenantA.tenantId}, 'USDT', 'IRT', ${USDT_TOMAN}, 0, 'NOBITEX', now(),
                  ${`v1:NOBITEX:USDT-IRT:${String(USDT_TOMAN)}e-0:-:${String(Date.now())}`}, 1)
          ON CONFLICT (tenant_id, base_asset, quote_currency) DO UPDATE
            SET rate_mantissa = EXCLUDED.rate_mantissa, fetched_at = EXCLUDED.fetched_at,
                quote_id = EXCLUDED.quote_id`,
    );
    await setStarsStatus('ACTIVE');
  }

  const setStarsStatus = (status: 'ACTIVE' | 'DISABLED') =>
    api.container.paymentGateways.setStatus(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TELEGRAM_STARS',
      status,
    });

  async function product(priceMinor: bigint): Promise<ProductId> {
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    const created = await api.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: key(),
    });
    await validatePanelConnection(api.container, tenantA, created.view.panel.id);
    const products = new DrizzleProductRepository(api.container.database.db);
    const row = await products.create(tenantA, {
      id: api.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ستاره',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: created.view.panel.id as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: money(priceMinor, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: api.container.clock.now(),
    });
    await products.setStatus(tenantA, row.id, 'INACTIVE', 'ACTIVE', api.container.clock.now());
    return row.id;
  }

  async function session(telegramUserId = MARYAM): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES.session, { botInstanceId: BOT_A1 })}`,
      payload: { initData: initDataFor(telegramUserId) },
    });
    expect(response.statusCode, response.body).toBe(201);
    return (JSON.parse(response.body) as { token: string }).token;
  }

  const call = (
    token: string,
    method: 'GET' | 'POST',
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

  /** The customer's Stars attempt for a new order, opened through the mini app. */
  async function starsAttempt(token: string, priceMinor = 260_000n) {
    const productId = await product(priceMinor);
    const created = await call(token, 'POST', MINIAPP_ROUTES.orders, {}, { productId });
    expect(created.statusCode, created.body).toBe(201);
    const order = miniAppOrderSchema.parse(JSON.parse(created.body));
    const opened = await call(
      token,
      'POST',
      MINIAPP_ROUTES.orderPayGateway,
      { orderId: order.id },
      { provider: 'TELEGRAM_STARS' },
    );
    expect(opened.statusCode, opened.body).toBe(201);
    return { order, attempt: miniAppGatewayAttemptSchema.parse(JSON.parse(opened.body)) };
  }

  const askLink = (token: string, paymentId: string) =>
    call(token, 'POST', MINIAPP_ROUTES.paymentStarsInvoice, { paymentId });

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await api.container.database.db.execute(query)).rows as T[];
  }

  async function invoiceOf(paymentId: string) {
    const [row] = await rows<{
      provider_order_id: string;
      sent_amount: string;
      provider_unit: string;
      provider_charge_id: string | null;
    }>(
      sql`SELECT provider_order_id, sent_amount::text AS sent_amount, provider_unit, provider_charge_id
          FROM gateway_invoices WHERE payment_id = ${paymentId}`,
    );
    if (row === undefined) throw new Error('no invoice');
    return row;
  }

  const webhook = (update: Record<string, unknown>) =>
    inject({
      method: 'POST',
      url: `/telegram/webhook/${BOT_A1}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: { update_id: (seq += 1), ...update },
    });

  const preCheckout = (payload: string, totalAmount: number) =>
    webhook({
      pre_checkout_query: {
        id: `pcq-${String(seq)}`,
        from: { id: MARYAM, is_bot: false, first_name: 'Customer' },
        currency: 'XTR',
        total_amount: totalAmount,
        invoice_payload: payload,
      },
    });

  const successfulPayment = (payload: string, totalAmount: number, chargeId: string) =>
    webhook({
      message: {
        message_id: (seq += 1),
        date: 0,
        chat: { id: MARYAM, type: 'private' },
        from: { id: MARYAM, is_bot: false, first_name: 'Customer' },
        successful_payment: {
          currency: 'XTR',
          total_amount: totalAmount,
          invoice_payload: payload,
          telegram_payment_charge_id: chargeId,
          provider_payment_charge_id: '',
        },
      },
    });

  const status = async (token: string, paymentId: string) =>
    miniAppPaymentStatusSchema.parse(
      JSON.parse((await call(token, 'GET', MINIAPP_ROUTES.payment, { paymentId })).body),
    );

  // =====================================================================================

  it('makes the link once per attempt, with the attempt’s own payload and exact XTR Stars', async () => {
    await enableStars();
    await setFlag('miniapp_stars_invoice', true);
    const token = await session();
    const { order, attempt } = await starsAttempt(token);
    expect(attempt).toMatchObject({ provider: 'TELEGRAM_STARS', inAppInvoice: true });

    const routes = miniAppPaymentRoutesResponseSchema.parse(
      JSON.parse(
        (await call(token, 'GET', MINIAPP_ROUTES.orderRoutes, { orderId: order.id })).body,
      ),
    );
    expect(routes.routes.find((one) => one.provider === 'TELEGRAM_STARS')?.paysInApp).toBe(true);

    const first = await askLink(token, attempt.paymentId);
    expect(first.statusCode, first.body).toBe(201);
    const again = await askLink(token, attempt.paymentId);
    expect(again.statusCode, again.body).toBe(201);
    const link = miniAppStarsInvoiceSchema.parse(JSON.parse(first.body));
    expect(miniAppStarsInvoiceSchema.parse(JSON.parse(again.body))).toEqual(link);
    expect(link.paymentId).toBe(attempt.paymentId);

    // One createInvoiceLink, with the attempt's payload and its snapshotted Stars:
    // 260,000 Toman at 130,000 / 100 = 1,300 Toman per Star is exactly 200 Stars.
    const invoice = await invoiceOf(attempt.paymentId);
    expect(invoice).toMatchObject({ sent_amount: '200', provider_unit: 'XTR' });
    const made = calls.filter((one) => one.method === 'createInvoiceLink');
    expect(made).toHaveLength(1);
    expect(made[0]!.token).toBe(TOKEN_A1);
    expect(made[0]!.body).toMatchObject({
      payload: invoice.provider_order_id,
      currency: 'XTR',
      provider_token: '',
      prices: [{ amount: 200 }],
    });
    expect(made[0]!.body).not.toHaveProperty('chat_id');
    // No second attempt was opened by asking for the link.
    const attempts = await rows<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM payments WHERE order_id = ${order.id}`,
    );
    expect(attempts[0]?.n).toBe('1');
  });

  it('refuses with the existing route_unavailable when Stars is not offered, or the flag is off', async () => {
    await enableStars();
    const token = await session();
    const { attempt } = await starsAttempt(token);
    // Flag off: the attempt is not drawn as payable here, and the link is refused.
    expect(attempt.inAppInvoice).toBe(false);
    const off = await askLink(token, attempt.paymentId);
    expect(off.statusCode, off.body).toBe(409);
    expect(JSON.parse(off.body).error.code).toBe('miniapp.route_unavailable');

    // Flag on, but the Stars route switched off since: the bot would not offer it now.
    await setFlag('miniapp_stars_invoice', true);
    await setStarsStatus('DISABLED');
    const notOffered = await askLink(token, attempt.paymentId);
    expect(notOffered.statusCode, notOffered.body).toBe(409);
    expect(JSON.parse(notOffered.body).error.code).toBe('miniapp.route_unavailable');
    expect(calls.filter((one) => one.method === 'createInvoiceLink')).toHaveLength(0);
  });

  it('answers another customer’s attempt as not found', async () => {
    await enableStars();
    await setFlag('miniapp_stars_invoice', true);
    const token = await session();
    const { attempt } = await starsAttempt(token);
    const stranger = await session(940940);
    const response = await askLink(stranger, attempt.paymentId);
    expect(response.statusCode, response.body).toBe(404);
    expect(calls.filter((one) => one.method === 'createInvoiceLink')).toHaveLength(0);
  });

  it('never calls an order paid on the client’s word, and settles it exactly once from the webhook', async () => {
    await enableStars();
    await setFlag('miniapp_stars_invoice', true);
    const token = await session();
    const { order, attempt } = await starsAttempt(token);
    await askLink(token, attempt.paymentId);
    const invoice = await invoiceOf(attempt.paymentId);

    // The client's `openInvoice` callback said `paid`; it has nothing to tell the server, and
    // the server's answer stays what its records say: PENDING, awaiting payment.
    const before = await status(token, attempt.paymentId);
    expect(before.state).toBe('PENDING');
    expect(before.order?.state).toBe('AWAITING_PAYMENT');

    // Telegram's own updates, on the bot's webhook: approve, charge, and a redelivery.
    expect((await preCheckout(invoice.provider_order_id, 200)).statusCode).toBeLessThan(300);
    const answers = calls.filter((one) => one.method === 'answerPreCheckoutQuery');
    expect(answers[answers.length - 1]?.body).toMatchObject({ ok: true });
    await successfulPayment(invoice.provider_order_id, 200, 'charge-mini');
    await successfulPayment(invoice.provider_order_id, 200, 'charge-mini');

    const after = await status(token, attempt.paymentId);
    expect(after.state).toBe('CONFIRMED');
    expect(after.order?.state).toBe('PAID');
    const confirmed = await rows<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM payments WHERE order_id = ${order.id} AND state = 'CONFIRMED'`,
    );
    expect(confirmed[0]?.n).toBe('1');
    expect((await invoiceOf(attempt.paymentId)).provider_charge_id).toBe('charge-mini');
    // A Stars order payment moves no wallet money.
    const ledger = await rows<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM wallet_entries WHERE tenant_id = ${tenantA.tenantId}`,
    );
    expect(ledger[0]?.n).toBe('0');

    // Paid: the link is refused now, and the chat invoice cannot be paid a second time.
    const late = await askLink(token, attempt.paymentId);
    expect(late.statusCode, late.body).toBe(409);
    await preCheckout(invoice.provider_order_id, 200);
    const last = calls.filter((one) => one.method === 'answerPreCheckoutQuery');
    expect(last[last.length - 1]?.body).toMatchObject({ ok: false });
  });
});
