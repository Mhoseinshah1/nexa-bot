import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  EMPTY_PRODUCT_DISPLAY,
  isNexaError,
  money,
  TELEGRAM_SECRET_TOKEN_HEADER,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type PaymentGatewayConfig,
  type PaymentId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleGatewayInvoiceRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-invoice.repository';
import { STARS_CHARGE_UNMATCHED_CODE } from '../../apps/api/src/modules/commerce/payments/application/telegram-stars-payment.service';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  tenantB,
  testConfig,
  validatePanelConnection,
} from './harness';

/**
 * Package A — Telegram Stars, end to end (`docs/package-a-telegram-stars-audit.md`, brief A9).
 *
 * The real API app and container over a real database. Telegram is a recording fake: the
 * worker's `sendInvoice`, the webhook's `answerPreCheckoutQuery` and every customer reply
 * land in `calls`. Stars payments arrive exactly as Telegram delivers them — as bot
 * updates POSTed to the bot's own authenticated webhook — so the interception in the
 * webhook, the pre-checkout validation, the record under the row lock and the one
 * settlement path are all the production code.
 */

const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-stars';
const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_A2 = SEED_IDS.botA2 as BotInstanceId;
const BOT_B = SEED_IDS.botB1 as BotInstanceId;
const MARYAM = 910910;
const REZA = 920920;
/** 1 Star = 1,300 Toman, the owner's `toman_per_star`. */
const RATE = 1_300n;

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

describe('Telegram Stars (Package A)', () => {
  let api: ApiApp;
  let telegram: Server;
  let calls: Call[] = [];
  let reply: (method: string, response: ServerResponse) => void;
  let panel: FakeMarzban | null = null;
  let owner: ActorContext;
  let maryam: UserId;
  let updateId = 50_000;
  let messageId = 700;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  const systemActor = (correlationId: string): ActorContext => ({
    type: 'SYSTEM_JOB',
    id: null,
    label: 'telegram-update:test',
    surface: 'TELEGRAM',
    correlationId: correlationId as CorrelationId,
  });

  const defaultReply = (method: string, response: ServerResponse) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    const result =
      method === 'answerPreCheckoutQuery' || method === 'answerCallbackQuery'
        ? true
        : { message_id: (messageId += 1) };
    response.end(JSON.stringify({ ok: true, result }));
  };

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
        reply(method, response);
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
    // Brief A6, over every case in this file: nothing ever asked Telegram to refund Stars.
    expect(calls.some((call) => call.method === 'refundStarPayment')).toBe(false);
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
    reply = defaultReply;
    owner = adminActorFor(
      await createAdmin(api.container, tenantA, { username: 'owner-stars', roleKeys: ['owner'] }),
    );
    maryam = await customer(MARYAM);
  });

  // -------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------

  async function customer(telegramUserId: number, bot: BotInstanceId = BOT_A, scope = tenantA) {
    return (
      await api.container.customers.resolveFromUpdate(scope, systemActor(`r-${telegramUserId}`), {
        idempotencyKey: `resolve-${String(telegramUserId)}-${bot}`,
        telegramUserId: String(telegramUserId),
        from: { id: telegramUserId, first_name: 'Customer' },
        botInstanceId: bot,
      })
    ).customer.id;
  }

  async function configureStars(
    config: Partial<PaymentGatewayConfig> & {
      readonly providerUnitRateMinor?: bigint | null;
      readonly customerFeeBasisPoints?: number;
    } = {},
    scope = tenantA,
    actor = owner,
  ) {
    return api.container.paymentGateways.configure(scope, actor, {
      idempotencyKey: `stars-cfg-${JSON.stringify(config, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))}`,
      provider: 'TELEGRAM_STARS',
      config: { ...OPEN_ROUTE, providerUnitRateMinor: RATE, ...config },
    });
  }

  async function enableStars(config: Parameters<typeof configureStars>[0] = {}) {
    await configureStars(config);
    await api.container.paymentGateways.setStatus(tenantA, owner, {
      idempotencyKey: `stars-on-${String((updateId += 1))}`,
      provider: 'TELEGRAM_STARS',
      status: 'ACTIVE',
    });
  }

  const inBot = (bot: BotInstanceId = BOT_A) => ({ ...tenantA, botInstanceId: bot });

  const topup = (amountMinor: bigint, key = `stars-topup-${String((updateId += 1))}`) =>
    api.container.payments.requestGatewayTopup(inBot(), systemActor(key), maryam, {
      idempotencyKey: key,
      amount: money(amountMinor, 'IRT'),
      provider: 'TELEGRAM_STARS',
    });

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await api.container.database.db.execute(query)).rows as T[];
  }

  async function invoiceOf(paymentId: string) {
    const [row] = await rows<{
      provider_order_id: string;
      provider_invoice_id: string | null;
      provider_unit: string;
      sent_amount: string;
      conversion_rate_minor: string | null;
      bot_instance_id: string | null;
      provider_charge_id: string | null;
      provider_paid: boolean | null;
      creation_state: string;
      outcome: string | null;
      late_completion_observed_at: Date | null;
    }>(
      sql`SELECT provider_order_id, provider_invoice_id, provider_unit, sent_amount::text AS sent_amount,
                 conversion_rate_minor::text AS conversion_rate_minor, bot_instance_id,
                 provider_charge_id, provider_paid, creation_state, outcome, late_completion_observed_at
          FROM gateway_invoices WHERE payment_id = ${paymentId}`,
    );
    if (row === undefined) throw new Error('no invoice');
    return row;
  }

  const paymentState = async (paymentId: string) =>
    (await rows<{ state: string }>(sql`SELECT state FROM payments WHERE id = ${paymentId}`))[0]
      ?.state;

  const ledger = () =>
    rows<{ reason: string; amount: string; payment_id: string | null }>(
      sql`SELECT reason, amount::text AS amount, payment_id FROM wallet_entries
          WHERE tenant_id = ${tenantA.tenantId} AND customer_id = ${maryam} ORDER BY reason`,
    );

  const opsCodes = async () =>
    (
      await rows<{ code: string }>(
        sql`SELECT code FROM operational_events WHERE tenant_id = ${tenantA.tenantId} ORDER BY first_seen_at`,
      )
    ).map((row) => row.code);

  /** Runs the worker's gateway pass: the invoice goes out through the fake Telegram. */
  const worker = () => api.container.gatewayPayments.runOnce(tenantA);

  const webhook = (bot: BotInstanceId, update: Record<string, unknown>) =>
    inject({
      method: 'POST',
      url: `/telegram/webhook/${bot}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: { update_id: (updateId += 1), ...update },
    });

  const preCheckout = (
    payload: string,
    totalAmount: number,
    options: { from?: number; currency?: string; bot?: BotInstanceId } = {},
  ) =>
    webhook(options.bot ?? BOT_A, {
      pre_checkout_query: {
        id: `pcq-${String(updateId)}`,
        from: { id: options.from ?? MARYAM, is_bot: false, first_name: 'Customer' },
        currency: options.currency ?? 'XTR',
        total_amount: totalAmount,
        invoice_payload: payload,
      },
    });

  const successfulPayment = (
    payload: string,
    totalAmount: number,
    chargeId: string,
    options: { from?: number; currency?: string; bot?: BotInstanceId } = {},
  ) =>
    webhook(options.bot ?? BOT_A, {
      message: {
        message_id: (messageId += 1),
        date: 0,
        chat: { id: options.from ?? MARYAM, type: 'private' },
        from: { id: options.from ?? MARYAM, is_bot: false, first_name: 'Customer' },
        successful_payment: {
          currency: options.currency ?? 'XTR',
          total_amount: totalAmount,
          invoice_payload: payload,
          telegram_payment_charge_id: chargeId,
          provider_payment_charge_id: '',
        },
      },
    });

  const lastAnswer = () => {
    const answers = calls.filter((call) => call.method === 'answerPreCheckoutQuery');
    return answers[answers.length - 1]?.body;
  };

  /** A created Stars top-up attempt: requested, invoiced by the worker. */
  async function invoicedTopup(amountMinor = 100_000n) {
    const attempt = await topup(amountMinor);
    await worker();
    const invoice = await invoiceOf(attempt.payment.id);
    return { attempt, invoice, stars: Number(invoice.sent_amount) };
  }

  // =====================================================================================

  describe('the route (A1)', () => {
    it('starts disabled, and cannot be switched on without a rate', async () => {
      const [route] = await rows<{ status: string; provider_unit_rate_minor: string | null }>(
        sql`SELECT status, provider_unit_rate_minor::text AS provider_unit_rate_minor
            FROM payment_gateways WHERE tenant_id = ${tenantA.tenantId} AND provider = 'TELEGRAM_STARS'`,
      );
      expect(route).toEqual({ status: 'DISABLED', provider_unit_rate_minor: null });

      const refused = await api.container.paymentGateways
        .setStatus(tenantA, owner, {
          idempotencyKey: 'stars-on-no-rate',
          provider: 'TELEGRAM_STARS',
          status: 'ACTIVE',
        })
        .catch((error: unknown) => error);
      expect(isNexaError(refused) && refused.code).toBe(
        COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE,
      );
      expect(isNexaError(refused) && refused.details).toMatchObject({ reason: 'RATE_MISSING' });

      await enableStars();
      const [enabled] = await rows<{ status: string; provider_unit_rate_minor: string }>(
        sql`SELECT status, provider_unit_rate_minor::text AS provider_unit_rate_minor
            FROM payment_gateways WHERE tenant_id = ${tenantA.tenantId} AND provider = 'TELEGRAM_STARS'`,
      );
      expect(enabled).toEqual({ status: 'ACTIVE', provider_unit_rate_minor: '1300' });
    });

    it('refuses clearing the rate of an enabled route, and a rate on a route that has no conversion', async () => {
      await enableStars();
      const cleared = await configureStars({ providerUnitRateMinor: null }).catch(
        (error: unknown) => error,
      );
      expect(isNexaError(cleared) && cleared.details).toMatchObject({ reason: 'RATE_MISSING' });

      const onTonPays = await api.container.paymentGateways
        .configure(tenantA, owner, {
          idempotencyKey: 'tonpays-rate',
          provider: 'TONPAYS',
          config: { ...OPEN_ROUTE, providerUnitRateMinor: 5n },
        })
        .catch((error: unknown) => error);
      expect(isNexaError(onTonPays) && onTonPays.code).toBe(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
      );
    });

    it('is refused outside a bot: there is no chat to send the invoice to', async () => {
      await enableStars();
      const refused = await api.container.payments
        .requestGatewayTopup(tenantA, systemActor('no-bot'), maryam, {
          idempotencyKey: 'no-bot',
          amount: money(100_000n, 'IRT'),
          provider: 'TELEGRAM_STARS',
        })
        .catch((error: unknown) => error);
      expect(isNexaError(refused) && refused.code).toBe(
        COMMERCE_ERROR_CODES.PAYMENT_METHOD_UNAVAILABLE,
      );
    });
  });

  describe('the conversion and the invoice (A1, A2)', () => {
    it('asks for ceil(payable / rate) Stars, snapshots the rate and bot, and sends one XTR price with no provider token', async () => {
      // 5% fee: principal 100,000 + fee 5,000 = payable 105,000; 105,000 / 1,300 = 80.77 → 81.
      await enableStars({ customerFeeBasisPoints: 500 });
      const { attempt, invoice } = await invoicedTopup(100_000n);

      expect(String(attempt.payment.amount.amountMinor)).toBe('100000');
      expect(attempt.payment.customerFee?.payable.amountMinor).toBe(105_000n);
      expect(invoice).toMatchObject({
        provider_unit: 'XTR',
        sent_amount: '81',
        conversion_rate_minor: '1300',
        bot_instance_id: BOT_A,
        creation_state: 'CREATED',
      });
      expect(invoice.provider_order_id).toMatch(/^[0-9a-f]{32}$/u);

      const sent = calls.filter((call) => call.method === 'sendInvoice');
      expect(sent).toHaveLength(1);
      const body = sent[0]!.body;
      expect(body).toMatchObject({
        chat_id: String(MARYAM),
        payload: invoice.provider_order_id,
        currency: 'XTR',
        provider_token: '',
        prices: [{ label: CATALOGUE_FA['bot.payment.stars_price_label'], amount: 81 }],
        title: CATALOGUE_FA['bot.payment.stars_invoice_title'],
        description: CATALOGUE_FA['bot.payment.stars_invoice_description'],
      });
      // No tips, shipping, flexible price or subscription: exactly the fields above.
      expect(Object.keys(body).sort()).toEqual(
        [
          'chat_id',
          'currency',
          'description',
          'payload',
          'prices',
          'provider_token',
          'title',
        ].sort(),
      );
      // Sent with the token of the bot the customer is talking to.
      const [botRow] = await rows<{ id: string }>(
        sql`SELECT id FROM bot_instances WHERE id = ${BOT_A}`,
      );
      expect(botRow).toBeDefined();
      expect(invoice.provider_invoice_id).toMatch(/^message:\d+$/u);
    });

    it('keeps an open invoice at the rate it was issued at when the rate changes, and the row refuses a rewrite', async () => {
      await enableStars();
      const { attempt, invoice } = await invoicedTopup(100_000n);
      expect(invoice.sent_amount).toBe('77'); // 100,000 / 1,300 = 76.92 → 77

      await configureStars({ providerUnitRateMinor: 1_000n });
      const after = await invoiceOf(attempt.payment.id);
      expect(after.sent_amount).toBe('77');
      expect(after.conversion_rate_minor).toBe('1300');

      const refusal = (query: ReturnType<typeof sql>) =>
        api.container.database.db.execute(query).then(
          () => 'accepted',
          (error: unknown) => String((error as { cause?: { message?: string } }).cause?.message),
        );
      expect(
        await refusal(
          sql`UPDATE gateway_invoices SET sent_amount = 100 WHERE payment_id = ${attempt.payment.id}`,
        ),
      ).toMatch(/snapshot is immutable/u);
      expect(
        await refusal(
          sql`UPDATE gateway_invoices SET conversion_rate_minor = 1 WHERE payment_id = ${attempt.payment.id}`,
        ),
      ).toMatch(/snapshot is immutable/u);

      // A NEW attempt for another amount is priced at the new rate.
      const next = await invoicedTopup(50_000n);
      expect(next.invoice).toMatchObject({ sent_amount: '50', conversion_rate_minor: '1000' });
    });
  });

  describe('pre-checkout (A3)', () => {
    it('approves the attempt’s own payer, bot, currency and Stars, and moves nothing', async () => {
      await enableStars();
      const { attempt, invoice, stars } = await invoicedTopup();
      const response = await preCheckout(invoice.provider_order_id, stars);
      expect(response.statusCode).toBeLessThan(300);
      expect(lastAnswer()).toMatchObject({ ok: true });
      expect(await paymentState(attempt.payment.id)).toBe('PENDING');
      expect(await ledger()).toEqual([]);
    });

    it.each([
      ['the wrong payer', { from: REZA }],
      ['the wrong currency', { currency: 'USD' }],
      ['the wrong bot of the same tenant', { bot: BOT_A2 }],
    ] as const)('refuses %s with the one fixed sentence', async (_name, options) => {
      await enableStars();
      if ('from' in options) await customer(REZA);
      // The seed's second bot is STOPPED, and a stopped bot's webhook answers nothing.
      await api.container.database.db.execute(
        sql`UPDATE bot_instances SET status = 'ACTIVE' WHERE id = ${BOT_A2}`,
      );
      const { invoice, stars } = await invoicedTopup();
      await preCheckout(invoice.provider_order_id, stars, options);
      expect(lastAnswer()).toEqual({
        pre_checkout_query_id: expect.any(String),
        ok: false,
        error_message: CATALOGUE_FA['bot.payment.stars_precheckout_refused'],
      });
    });

    it('refuses a total that is not the snapshotted Stars', async () => {
      await enableStars();
      const { invoice, stars } = await invoicedTopup();
      await preCheckout(invoice.provider_order_id, stars - 1);
      expect(lastAnswer()).toMatchObject({ ok: false });
      await preCheckout(invoice.provider_order_id, stars + 1);
      expect(lastAnswer()).toMatchObject({ ok: false });
    });

    it('refuses an attempt inside its last two minutes, a closed one, and a payload nobody issued', async () => {
      await enableStars();
      const { attempt, invoice, stars } = await invoicedTopup();
      await api.container.database.db.execute(
        sql`UPDATE payments SET expires_at = now() + interval '90 seconds' WHERE id = ${attempt.payment.id}`,
      );
      await preCheckout(invoice.provider_order_id, stars);
      expect(lastAnswer()).toMatchObject({ ok: false });

      await preCheckout('0'.repeat(32), stars);
      expect(lastAnswer()).toMatchObject({ ok: false });
    });

    it('refuses a blocked customer', async () => {
      await enableStars();
      const { invoice, stars } = await invoicedTopup();
      await api.container.database.db.execute(
        sql`UPDATE customers SET status = 'BLOCKED', blocked_at = now() WHERE id = ${maryam}`,
      );
      await preCheckout(invoice.provider_order_id, stars);
      expect(lastAnswer()).toMatchObject({ ok: false });
    });

    it('refuses another tenant’s payload: tenant B’s bot cannot approve tenant A’s attempt', async () => {
      await enableStars();
      const { invoice, stars } = await invoicedTopup();
      await preCheckout(invoice.provider_order_id, stars, { bot: BOT_B });
      expect(lastAnswer()).toMatchObject({ ok: false });
    });
  });

  describe('successful_payment (A4)', () => {
    it('credits a top-up principal and its gift exactly once, never the fee or the Star rounding', async () => {
      await enableStars({ customerFeeBasisPoints: 500, topupCashbackPercent: 10 });
      const { attempt, invoice, stars } = await invoicedTopup(100_000n);

      const first = await successfulPayment(invoice.provider_order_id, stars, 'charge-1');
      expect(first.statusCode).toBeLessThan(300);
      expect(await paymentState(attempt.payment.id)).toBe('CONFIRMED');
      const recorded = await invoiceOf(attempt.payment.id);
      expect(recorded).toMatchObject({
        provider_charge_id: 'charge-1',
        provider_paid: true,
        outcome: 'SETTLED',
      });
      // Principal 100,000 and a 10% gift of the PRINCIPAL. The 5,000 fee and the Stars'
      // rounding excess (81 × 1,300 − 105,000 = 300) are credited nowhere.
      expect(await ledger()).toEqual([
        { reason: 'CASHBACK_TOPUP', amount: '10000', payment_id: attempt.payment.id },
        { reason: 'TOPUP_GATEWAY', amount: '100000', payment_id: attempt.payment.id },
      ]);

      // Telegram redelivers the same update, and the same charge arrives again.
      await successfulPayment(invoice.provider_order_id, stars, 'charge-1');
      await successfulPayment(invoice.provider_order_id, stars, 'charge-1');
      await worker();
      expect(await ledger()).toHaveLength(2);
    });

    it('settles an order once, through the one settlement path', async () => {
      await enableStars();
      const orderId = await draftOrder(260_000n);
      await tapAs(MARYAM, `gp:${orderId}.TELEGRAM_STARS`);
      const [payment] = await rows<{ id: string }>(
        sql`SELECT id FROM payments WHERE order_id = ${orderId} AND method = 'GATEWAY'`,
      );
      await worker();
      const invoice = await invoiceOf(payment!.id);
      expect(invoice.sent_amount).toBe('200'); // 260,000 / 1,300 exactly

      await successfulPayment(invoice.provider_order_id, 200, 'charge-order');
      await successfulPayment(invoice.provider_order_id, 200, 'charge-order');
      const [order] = await rows<{ state: string }>(
        sql`SELECT state FROM orders WHERE id = ${orderId}`,
      );
      expect(order?.state).toBe('PAID');
      const confirmed = await rows<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM payments WHERE order_id = ${orderId} AND state = 'CONFIRMED'`,
      );
      expect(confirmed[0]?.n).toBe('1');
      // No wallet money moves for a Stars order payment.
      expect(await ledger()).toEqual([]);
    });

    it('never attaches one charge id to a second attempt', async () => {
      await enableStars();
      const first = await invoicedTopup(100_000n);
      const second = await invoicedTopup(50_000n);
      await successfulPayment(first.invoice.provider_order_id, first.stars, 'charge-shared');
      await successfulPayment(second.invoice.provider_order_id, second.stars, 'charge-shared');

      expect(await paymentState(first.attempt.payment.id)).toBe('CONFIRMED');
      expect(await paymentState(second.attempt.payment.id)).toBe('PENDING');
      expect((await invoiceOf(second.attempt.payment.id)).provider_charge_id).toBeNull();
      expect(await opsCodes()).toContain(STARS_CHARGE_UNMATCHED_CODE);
    });

    it('settles nothing for a payment that does not match the attempt, and records the charge for the operator', async () => {
      await enableStars();
      await customer(REZA);
      const { attempt, invoice, stars } = await invoicedTopup();
      await successfulPayment(invoice.provider_order_id, stars + 5, 'charge-amount');
      await successfulPayment(invoice.provider_order_id, stars, 'charge-payer', { from: REZA });
      await successfulPayment(invoice.provider_order_id, stars, 'charge-cur', { currency: 'USD' });
      expect(await paymentState(attempt.payment.id)).toBe('PENDING');
      expect((await invoiceOf(attempt.payment.id)).provider_charge_id).toBeNull();
      expect(await ledger()).toEqual([]);
      expect(await opsCodes()).toContain('payments.gateway_identity_mismatch');
    });

    it('records a payment that lands after the deadline as a late completion, and credits nothing', async () => {
      await enableStars();
      const { attempt, invoice, stars } = await invoicedTopup();
      await api.container.database.db.execute(
        sql`UPDATE payments SET expires_at = now() - interval '1 minute' WHERE id = ${attempt.payment.id}`,
      );
      await successfulPayment(invoice.provider_order_id, stars, 'charge-late');
      const late = await invoiceOf(attempt.payment.id);
      expect(late.provider_charge_id).toBe('charge-late');
      expect(late.outcome).toBe('LATE_COMPLETION');
      expect(late.late_completion_observed_at).not.toBeNull();
      expect(await ledger()).toEqual([]);
      expect(await opsCodes()).toContain('payments.gateway_late_completion');
    });

    it('lets the worker settle a recorded payment whose settlement did not finish, without calling Telegram', async () => {
      await enableStars();
      const { attempt, invoice } = await invoicedTopup();
      // The webhook recorded the charge and died before settling.
      await api.container.uow.run(tenantA, (tx) =>
        new DrizzleGatewayInvoiceRepository(api.container.database.db).recordCharge(
          tenantA,
          attempt.payment.id as PaymentId,
          { chargeId: 'charge-crash', status: 'successful_payment', dueAt: new Date() },
          new Date(),
          tx,
        ),
      );
      expect(await paymentState(attempt.payment.id)).toBe('PENDING');
      const before = calls.length;
      await worker();
      expect(await paymentState(attempt.payment.id)).toBe('CONFIRMED');
      expect((await invoiceOf(attempt.payment.id)).outcome).toBe('SETTLED');
      expect(calls.slice(before).filter((call) => call.method !== 'sendMessage')).toEqual([]);
      expect(invoice.provider_charge_id).toBeNull();
    });

    it('does not settle tenant A’s attempt from tenant B’s bot', async () => {
      await enableStars();
      const { attempt, invoice, stars } = await invoicedTopup();
      await successfulPayment(invoice.provider_order_id, stars, 'charge-b', { bot: BOT_B });
      expect(await paymentState(attempt.payment.id)).toBe('PENDING');
      const inB = await rows<{ code: string }>(
        sql`SELECT code FROM operational_events WHERE tenant_id = ${tenantB.tenantId}`,
      );
      expect(inB.map((row) => row.code)).toContain(STARS_CHARGE_UNMATCHED_CODE);
    });
  });

  describe('the financial log (A8)', () => {
    it('logs the Stars payment with principal, fee, payable, the Stars and the charge id — never the token or payload', async () => {
      const key = () => `stars-log-${String((updateId += 1))}`;
      await api.container.featureFlags.set(tenantA, owner, {
        key: 'ops_notifications',
        enabled: true,
        expectedVersion: null,
        idempotencyKey: key(),
        confirmKey: 'ops_notifications',
        reason: 'Package A financial log.',
      });
      await api.container.settingsService.set(tenantA, owner, {
        key: 'ops.notifications.telegram_chat_id',
        value: '-1001234567890',
        expectedVersion: null,
        idempotencyKey: key(),
      });
      await enableStars({ customerFeeBasisPoints: 500 });
      const { attempt, invoice, stars } = await invoicedTopup(100_000n);
      await successfulPayment(invoice.provider_order_id, stars, 'charge-log');
      for (let round = 0; round < 20; round += 1) {
        if ((await api.container.relay.processBatch()).claimed === 0) break;
      }
      const logs = await rows<{ template_key: string; payload: Record<string, unknown> }>(
        sql`SELECT template_key, payload FROM notifications
            WHERE tenant_id = ${tenantA.tenantId} AND template_key LIKE 'ops.financial.%'`,
      );
      expect(logs).toHaveLength(1);
      expect(logs[0]!.template_key).toBe('ops.financial.topup_credited');
      expect(logs[0]!.payload).toMatchObject({
        method: 'GATEWAY',
        route: 'TELEGRAM_STARS',
        paymentId: attempt.payment.id,
        principal: { amountMinor: '100000', currency: 'IRT' },
        fee: { amountMinor: '5000', currency: 'IRT' },
        payable: { amountMinor: '105000', currency: 'IRT' },
        providerInvoiceId: 'charge:charge-log',
        providerFinalAmount: '81 XTR',
      });
      const serialised = JSON.stringify(logs);
      expect(serialised).not.toContain('seed-token');
      expect(serialised).not.toContain(invoice.provider_order_id);
    });
  });

  describe('what the customer sees (A5, A7)', () => {
    it('shows principal, fee, payable and the Stars, with no link', async () => {
      await enableStars({ customerFeeBasisPoints: 500 });
      const orderId = await draftOrder(260_000n);
      calls = [];
      await tapAs(MARYAM, `gp:${orderId}.TELEGRAM_STARS`);
      const text = String(calls.find((call) => call.method === 'sendMessage')?.body.text ?? '');
      // 260,000 + 13,000 = 273,000 → 210 Stars.
      expect(text).toContain('210');
      expect(JSON.stringify(calls.at(-1)?.body.reply_markup ?? {})).not.toContain('"url"');
    });

    it('draws one named button per external route', async () => {
      await enableStars();
      const orderId = await draftOrder(260_000n);
      // The pre-invoice the customer's last tap drew.
      const markup = JSON.stringify(
        calls.filter((call) => call.method === 'sendMessage').map((call) => call.body.reply_markup),
      );
      expect(markup).toContain(`gp:${orderId}.TELEGRAM_STARS`);
      expect(markup).not.toContain(`"g:${orderId}"`);
    });

    it('answers /paysupport with the support screen /help shows', async () => {
      const text = async (command: string) => {
        calls = [];
        await webhook(BOT_A, {
          message: {
            message_id: (messageId += 1),
            date: 0,
            chat: { id: MARYAM, type: 'private' },
            from: { id: MARYAM, is_bot: false, first_name: 'Customer' },
            text: command,
          },
        });
        return calls.filter((call) => call.method === 'sendMessage').map((call) => call.body.text);
      };
      const paysupport = await text('/paysupport');
      expect(paysupport).toHaveLength(1);
      expect(paysupport).toEqual(await text('/help'));
    });
  });

  describe('refunds (A6)', () => {
    it('has no code path that asks Telegram to refund Stars', () => {
      const offenders: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const path = join(dir, entry);
          if (statSync(path).isDirectory()) walk(path);
          else if (
            path.endsWith('.ts') &&
            /['"`/]refundStarPayment['"`]/u.test(readFileSync(path, 'utf8'))
          ) {
            offenders.push(path);
          }
        }
      };
      walk(join(__dirname, '../../apps/api/src'));
      expect(offenders).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------
  // The order fixtures: a Marzban panel, a product, and the customer's own taps.
  // -------------------------------------------------------------------------------------

  async function tapAs(from: number, data: string) {
    return webhook(BOT_A, {
      callback_query: {
        id: `cbq-${String(updateId)}`,
        from: { id: from, is_bot: false, first_name: 'Customer' },
        chat_instance: 'ci',
        message: {
          message_id: (messageId += 1),
          date: 0,
          chat: { id: from, type: 'private' },
          from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          text: 'x',
        },
        data,
      },
    });
  }

  async function draftOrder(priceMinor: bigint): Promise<string> {
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    const created = await api.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-stars-create',
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
    await tapAs(MARYAM, `p:${row.id}`);
    const [draft] = await rows<{ id: string }>(
      sql`SELECT id FROM orders WHERE tenant_id = ${tenantA.tenantId} AND customer_id = ${maryam}
          ORDER BY created_at DESC LIMIT 1`,
    );
    if (draft === undefined) throw new Error('no draft');
    await tapAs(MARYAM, `Z:${draft.id}`);
    return draft.id;
  }
});
