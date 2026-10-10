import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  TONPAYS_TELEGRAM_REVIEW_INQUIRY_CADENCE,
  money,
  paymentTrackingCode,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type PaymentGatewayConfig,
  type PaymentGatewayProvider,
  type PaymentId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { GATEWAY_PAYMENT_INTERVAL_MS } from '../../apps/api/src/modules/commerce/payments/application/gateway-payment-loop';
import type { GatewayPaymentService } from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import { DrizzleGatewayInvoiceRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-invoice.repository';
import type { FetchLike } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-adapter';
import {
  TONPAYS_INQUIRY_SCHEDULE,
  firstInquiryAt,
  inquiryScheduleFor,
} from '../../apps/api/src/modules/commerce/payments/domain/inquiry-schedule';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  validatePanelConnection,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';
import {
  FakeTonPaysTelegram,
  JPEG_BYTES,
  json,
  startFakeTelegram,
  telegramLaneWith,
  useClock,
} from './tonpays-telegram-fixture';

/**
 * FIX-01 (batch 2026-10-10): from a provider's approval to the customer's FINAL message, per
 * rail, for an ORDER as well as a top-up — and the DISCOVERY stage measured on the REAL
 * inquiry schedule rather than by jumping the clock past it.
 *
 * `payment-settlement-latency.test.ts` measures commit → send for top-ups. What it cannot
 * say is how long an approval waits to be SEEN (it moves the clock six minutes and asks), nor
 * what an order's customer gets (a purchase is delivered by the provisioner, not the
 * notification lane). This file walks the lane pass by pass at its production interval on a
 * pinned clock, so the time an approval is discovered is the schedule's answer, and then
 * drives the component that sends the last message: the provisioner for an order, the
 * customer notification lane for a top-up. Telegram is a local fake on a real socket; the
 * providers are the REAL adapters over fake `fetch`. Nothing leaves the process.
 *
 * The bounds asserted are the schedule's, read from its own constants, so a change to the
 * schedule (FIX-06) changes them here in the same commit.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const MARYAM = '920920';
const TONPAYS_KEY = 'tp_live_discovery_key_never_leaks_7c1e';
const TELEGRAM_KEY = 'tpt_live_discovery_key_never_leaks_91aa';

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

/** A fake TonPays website API: create and check, in the documented shapes. */
class FakeTonPays {
  readonly invoices = new Map<
    string,
    { orderId: string; amount: number; status: string; paid: unknown }
  >();
  checks = 0;
  /** How many of the next checks answer a documented rate limit. */
  rateLimitNext = 0;
  private seq = 0;

  readonly fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url.endsWith('/api/v1/invoices/create')) {
      this.seq += 1;
      const invoiceId = `TPD-${String(this.seq).padStart(6, '0')}`;
      const invoice = {
        orderId: String(body.order_id),
        amount: Number(body.amount),
        status: 'pending',
        paid: false as unknown,
      };
      this.invoices.set(invoiceId, invoice);
      return json(201, {
        invoice_id: invoiceId,
        order_id: invoice.orderId,
        request_amount: invoice.amount,
        final_amount: invoice.amount,
        status: 'pending',
        invoice_url: `https://t.me/TonPaysInvoiceBot?start=inv_${invoiceId}`,
        web_invoice_url: `https://pay.tonpays.online/i/${invoiceId}`,
        callback_url: body.callback_url,
      });
    }
    if (url.endsWith('/api/v1/invoices/check')) {
      this.checks += 1;
      if (this.rateLimitNext > 0) {
        this.rateLimitNext -= 1;
        return json(429, { detail: { code: 'RATE_LIMIT_EXCEEDED' } });
      }
      const invoiceId = String(body.invoice_id);
      const invoice = this.invoices.get(invoiceId);
      if (invoice === undefined) return json(404, { detail: { code: 'INVOICE_NOT_FOUND' } });
      return json(200, {
        invoice_id: invoiceId,
        order_id: invoice.orderId,
        request_amount: invoice.amount,
        final_amount: invoice.amount,
        status: invoice.status,
        paid: invoice.paid,
      });
    }
    return json(404, { detail: { code: 'NOT_FOUND' } });
  };

  approve(invoiceId: string): void {
    const invoice = this.invoices.get(invoiceId);
    if (invoice === undefined) throw new Error(`no fake invoice ${invoiceId}`);
    invoice.status = 'completed';
    invoice.paid = true;
  }
}

interface LogLine {
  readonly level: string;
  readonly message: string;
  readonly context: Record<string, unknown>;
}

describe('FIX-01: discovery, settlement and the final message, per rail, order and top-up', () => {
  let ctx: TestContext;
  let telegram: Awaited<ReturnType<typeof startFakeTelegram>>;
  let panel: FakeMarzban;
  let products: DrizzleProductRepository;
  let panelId: string;
  let owner: ActorContext;
  let maryam: UserId;
  let tonpays: FakeTonPays;
  let tpt: FakeTonPaysTelegram;
  let lane: GatewayPaymentService;
  let clock: ReturnType<typeof useClock>;
  let logs: LogLine[];
  let now: number;
  let seq = 0;
  const key = () => `discovery-${String((seq += 1))}`;

  beforeAll(async () => {
    telegram = await startFakeTelegram();
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      TELEGRAM_API_BASE_URL: telegram.base,
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    await telegram?.close();
  });

  afterEach(async () => {
    clock?.restore();
    await panel?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    clock = useClock(ctx);
    now = Date.now();
    clock.at(new Date(now));
    products = new DrizzleProductRepository(ctx.container.database.db);
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-disc', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban D',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-disc-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);
    maryam = (
      await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('resolve-d'), {
        idempotencyKey: 'resolve-d',
        telegramUserId: MARYAM,
        from: { id: Number(MARYAM), first_name: 'مریم' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
    await ctx.container.database.db.execute(
      sql`UPDATE bot_instances SET webhook_url = ${`https://bot.example.com/telegram/webhook/${BOT_A}`}
          WHERE tenant_id = ${tenantA.tenantId}`,
    );
    telegram.sent.length = 0;
    telegram.requests.length = 0;
    telegram.files.clear();
    tonpays = new FakeTonPays();
    tpt = new FakeTonPaysTelegram();
    logs = [];
    const record = (level: string) => (context: Record<string, unknown>, message: string) =>
      logs.push({ level, message, context });
    lane = telegramLaneWith(ctx, tpt, {
      websiteFetch: tonpays.fetch,
      logger: { info: record('info'), warn: record('warn'), error: record('error') },
    });
  });

  // -------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------

  /** The pinned clock, moved forward. */
  const advance = (ms: number) => {
    now += ms;
    clock.at(new Date(now));
  };

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await ctx.container.database.db.execute(query)).rows as T[];
  }

  async function setFx(rate: bigint) {
    const current = await ctx.container.featureFlagResolver.resolve(tenantA, 'central_fx');
    if (!current.enabled) {
      await ctx.container.featureFlags.set(tenantA, owner, {
        key: 'central_fx',
        enabled: true,
        expectedVersion: current.version,
        idempotencyKey: key(),
        reason: 'FIX-01 discovery latency test.',
      });
    }
    await ctx.container.database.db.execute(
      sql`INSERT INTO fx_quotes (tenant_id, base_asset, quote_currency, rate_mantissa, rate_scale,
                                 source, source_at, fetched_at, quote_id, policy_version)
          VALUES (${tenantA.tenantId}, 'USDT', 'IRT', ${rate}, 0, 'WALLEX', NULL, now(),
                  ${`v1:WALLEX:USDT-IRT:${String(rate)}e-0:-:fix01`}, 1)
          ON CONFLICT (tenant_id, base_asset, quote_currency) DO UPDATE
            SET rate_mantissa = EXCLUDED.rate_mantissa, fetched_at = now(), quote_id = EXCLUDED.quote_id`,
    );
  }

  async function enable(provider: PaymentGatewayProvider) {
    await ctx.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: key(),
      provider,
      config: OPEN_ROUTE,
    });
    const apiKey =
      provider === 'TONPAYS'
        ? TONPAYS_KEY
        : provider === 'TONPAYS_TELEGRAM'
          ? TELEGRAM_KEY
          : provider === 'NOWPAYMENTS' || provider === 'CENTRALPAY'
            ? `${provider.toLowerCase()}_discovery_key_never_leaks`
            : null;
    if (apiKey !== null) {
      await ctx.container.paymentGateways.setCredential(tenantA, owner, {
        idempotencyKey: key(),
        provider,
        apiKey,
      });
    }
    if (provider === 'NOWPAYMENTS') {
      await ctx.container.paymentGateways.setWebhookSecret(tenantA, owner, {
        idempotencyKey: key(),
        provider,
        secret: 'np_ipn_secret_discovery_never_leaks',
      });
      await setFx(103_500n);
    }
    if (provider === 'CENTRALPAY') {
      await ctx.container.paymentGateways.setVerifyKey(tenantA, owner, {
        idempotencyKey: key(),
        provider,
        verifyKey: 'cp_verify_discovery_never_leaks',
      });
    }
    if (provider === 'TELEGRAM_STARS') {
      await setFx(130_000n);
      const current = await ctx.container.settingsService.get(tenantA, owner, 'stars.per_usdt');
      await ctx.container.settingsService.set(tenantA, owner, {
        key: 'stars.per_usdt',
        value: '100',
        expectedVersion: current.version,
        idempotencyKey: key(),
      });
    }
    await ctx.container.paymentGateways.setStatus(tenantA, owner, {
      idempotencyKey: key(),
      provider,
      status: 'ACTIVE',
    });
  }

  /** A confirmed order for a fresh product on the Marzban panel, awaiting payment. */
  async function confirmedOrder(priceMinor = 250_000n): Promise<string> {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن کشف',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: money(priceMinor, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const k = key();
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(k), {
      idempotencyKey: `${k}-draft`,
      customerId: maryam,
      productId: product.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(k), {
      idempotencyKey: `${k}-confirm`,
      customerId: maryam,
      orderId: draft.id,
    });
    return confirmed.id;
  }

  const gatewayOrderPayment = async (provider: PaymentGatewayProvider, orderId: string) =>
    (
      await ctx.container.payments.requestGatewayPayment(
        { tenantId: tenantA.tenantId, botInstanceId: BOT_A },
        systemActor(key()),
        maryam,
        { idempotencyKey: key(), orderId, provider },
      )
    ).payment.id as PaymentId;

  const gatewayTopup = async (provider: PaymentGatewayProvider, amountMinor: bigint) =>
    (
      await ctx.container.payments.requestGatewayTopup(
        { tenantId: tenantA.tenantId, botInstanceId: BOT_A },
        systemActor(key()),
        maryam,
        { idempotencyKey: key(), amount: money(amountMinor, 'IRT'), provider },
      )
    ).payment.id as PaymentId;

  async function invoiceOf(paymentId: string) {
    const [row] = await rows<{
      provider_order_id: string;
      provider_invoice_id: string | null;
      created_invoice_at: Date | null;
      next_inquiry_at: Date | null;
      outcome: string | null;
    }>(
      sql`SELECT provider_order_id, provider_invoice_id, created_invoice_at, next_inquiry_at, outcome
            FROM gateway_invoices WHERE payment_id = ${paymentId}`,
    );
    if (row === undefined) throw new Error('no invoice row');
    return row;
  }

  const paymentState = async (paymentId: string) =>
    (await rows<{ state: string }>(sql`SELECT state FROM payments WHERE id = ${paymentId}`))[0]!
      .state;

  /**
   * The gateway lane at its PRODUCTION interval: one pass every `GATEWAY_PAYMENT_INTERVAL_MS`
   * on the pinned clock, until the payment is CONFIRMED. Answers the clock at the settling
   * pass — the instant the approval was discovered.
   */
  async function passesUntilConfirmed(paymentId: string, limitMs: number): Promise<number> {
    const until = now + limitMs;
    while (now <= until) {
      await lane.runOnce(tenantA);
      if ((await paymentState(paymentId)) === 'CONFIRMED') return now;
      advance(GATEWAY_PAYMENT_INTERVAL_MS);
    }
    throw new Error(`not discovered within ${String(limitMs)} ms`);
  }

  /** The lane at its interval until its first ask. */
  async function untilFirstAsk(): Promise<void> {
    const before = tonpays.checks;
    while (tonpays.checks === before) {
      advance(GATEWAY_PAYMENT_INTERVAL_MS);
      await lane.runOnce(tenantA);
    }
  }

  const settlementLines = () =>
    logs.filter((line) => line.message === 'gateway payment settlement latency');

  /** The one redacted line, its shape, and that it carries nothing but ids and durations. */
  function expectSettlementLine(
    paymentId: string,
    expected: {
      kind: 'ORDER' | 'TOPUP';
      trigger: string;
      provider: PaymentGatewayProvider;
      customerMessage?: string;
    },
  ) {
    const lines = settlementLines();
    expect(lines, 'no settlement latency line, or more than one').toHaveLength(1);
    const { context } = lines[0]!;
    expect(context).toMatchObject({
      paymentId,
      provider: expected.provider,
      kind: expected.kind,
      trigger: expected.trigger,
      customerMessage:
        expected.customerMessage ??
        (expected.kind === 'ORDER' ? 'PROVISIONER' : 'NOTIFICATION_LANE'),
    });
    expect(Object.keys(context).sort()).toEqual(
      [
        'customerMessage',
        'discoveryToConfirmedMs',
        'dueToDiscoveryMs',
        'inquiryAttempt',
        'invoiceToDiscoveryMs',
        'kind',
        'orderPurpose',
        'paymentId',
        'provider',
        'trigger',
        'webhookToDiscoveryMs',
      ].sort(),
    );
    const text = JSON.stringify(context);
    for (const secret of [TONPAYS_KEY, TELEGRAM_KEY, '6037-']) {
      expect(text, 'a key or a card reached the latency line').not.toContain(secret);
    }
    // The settlement commits in the pass that discovered it, on the same pinned clock.
    expect(context.discoveryToConfirmedMs).toBe(0);
    return context;
  }

  /** The delivery card(s) the provisioner sent to Maryam: one photo with the link. */
  const deliveryCards = () =>
    telegram.requests.filter(
      (request) => request.url.includes('/sendPhoto') && request.raw.includes(MARYAM),
    );

  /**
   * An order's final message: the provisioner's NEXT tick creates the account and sends the
   * delivery card in the same tick. Nothing was credited to a wallet, and no top-up message
   * was queued for an order payment.
   */
  async function expectOrderDeliveredOnce(orderId: string, paymentId: string) {
    expect(deliveryCards(), 'delivered before the provisioner ran').toHaveLength(0);
    await ctx.container.provisionerLoop.tick();
    const [service] = await rows<{ state: string; delivery_state: string }>(
      sql`SELECT state, delivery_state FROM services WHERE order_id = ${orderId}`,
    );
    expect(service).toMatchObject({ state: 'ACTIVE', delivery_state: 'DELIVERED' });
    expect(deliveryCards(), 'the customer was told, once').toHaveLength(1);
    await ctx.container.provisionerLoop.tick();
    expect(deliveryCards()).toHaveLength(1);
    const credits = await rows<{ reason: string }>(
      sql`SELECT reason FROM wallet_entries WHERE payment_id = ${paymentId} AND reason LIKE 'TOPUP%'`,
    );
    expect(credits, 'an order payment was credited as a top-up').toEqual([]);
    const notices = await rows<{ kind: string }>(
      sql`SELECT kind FROM customer_notifications WHERE subject_id = ${paymentId}
           AND kind IN ('WALLET_TOPUP_CREDITED', 'RECEIPT_CREDITED_TO_WALLET')`,
    );
    expect(notices).toEqual([]);
  }

  /** A top-up's final message: the customer notification lane's next tick. */
  async function expectTopupMessagedOnce(paymentId: string) {
    const [payment] = await rows<{ reference: string }>(
      sql`SELECT reference FROM payments WHERE id = ${paymentId}`,
    );
    const toMaryam = () =>
      telegram.sent.filter(
        (body) =>
          String(body['chat_id']) === MARYAM &&
          String(body['text'] ?? '').includes(paymentTrackingCode(payment!.reference)),
      );
    expect(toMaryam()).toHaveLength(0);
    await ctx.container.customerNotificationLoop.tick();
    expect(toMaryam(), 'the amount-and-code message, once').toHaveLength(1);
    await ctx.container.customerNotificationLoop.tick();
    expect(toMaryam()).toHaveLength(1);
  }

  // =====================================================================================
  // TonPays (website) — the real schedule
  // =====================================================================================

  describe('TONPAYS on the real inquiry schedule', () => {
    it('ORDER, callback lost: the first inquiry is the schedule’s first, it discovers an approval made before it, and the provisioner delivers on its next tick', async () => {
      await enable('TONPAYS');
      const orderId = await confirmedOrder();
      const paymentId = await gatewayOrderPayment('TONPAYS', orderId);
      await lane.runOnce(tenantA); // the create
      const invoice = await invoiceOf(paymentId);
      expect(invoice.provider_invoice_id).not.toBeNull();
      // The first scheduled inquiry, exactly where the provider's schedule puts it (FIX-06).
      const created = new Date(invoice.created_invoice_at!);
      const firstDelay =
        firstInquiryAt(inquiryScheduleFor('TONPAYS'), created, paymentId).getTime() -
        created.getTime();
      expect(new Date(invoice.next_inquiry_at!).getTime() - created.getTime()).toBe(firstDelay);
      expect(firstDelay).toBeLessThanOrEqual(11_000);

      // The customer pays two seconds later. No webhook ever arrives.
      advance(2_000);
      tonpays.approve(invoice.provider_invoice_id!);
      const approvedAt = now;
      const discoveredAt = await passesUntilConfirmed(paymentId, 10 * 60_000);
      expect(tonpays.checks, 'settled by more than one inquiry').toBe(1);
      expect(discoveredAt - approvedAt).toBeLessThanOrEqual(
        firstDelay + GATEWAY_PAYMENT_INTERVAL_MS,
      );
      const line = expectSettlementLine(paymentId, {
        kind: 'ORDER',
        trigger: 'SCHEDULED',
        provider: 'TONPAYS',
      });
      expect(line.inquiryAttempt).toBe(1);
      expect(Number(line.dueToDiscoveryMs)).toBeLessThan(GATEWAY_PAYMENT_INTERVAL_MS);

      await expectOrderDeliveredOnce(orderId, paymentId);
    });

    it('TOPUP, callback lost, paid just after the first inquiry: discovered at the second, one schedule step (10 s since FIX-06) later', async () => {
      await enable('TONPAYS');
      const paymentId = await gatewayTopup('TONPAYS', 250_000n);
      await lane.runOnce(tenantA);
      const invoice = await invoiceOf(paymentId);
      // Walk to the first inquiry; it finds the invoice unpaid.
      await untilFirstAsk();
      expect(tonpays.checks).toBe(1);
      expect(await paymentState(paymentId)).toBe('PENDING');

      advance(1_000);
      tonpays.approve(invoice.provider_invoice_id!);
      const approvedAt = now;
      const discoveredAt = await passesUntilConfirmed(paymentId, 10 * 60_000);
      expect(tonpays.checks).toBe(2);
      const gap = discoveredAt - approvedAt;
      // The schedule's own next step after one inquiry (10 s ±10 %), measured from that inquiry.
      const step =
        TONPAYS_INQUIRY_SCHEDULE.kind === 'BANDS'
          ? TONPAYS_INQUIRY_SCHEDULE.bands[0]!.intervalMs
          : 0;
      expect(gap).toBeGreaterThan(step * 0.9 - 1_000 - GATEWAY_PAYMENT_INTERVAL_MS);
      expect(gap).toBeLessThanOrEqual(step * 1.1 + GATEWAY_PAYMENT_INTERVAL_MS);
      const line = expectSettlementLine(paymentId, {
        kind: 'TOPUP',
        trigger: 'SCHEDULED',
        provider: 'TONPAYS',
      });
      expect(line.inquiryAttempt).toBe(2);

      await expectTopupMessagedOnce(paymentId);
    });

    it('TOPUP with a webhook: discovered within one pass, labelled WEBHOOK_HINT, messaged by the lane', async () => {
      await enable('TONPAYS');
      const paymentId = await gatewayTopup('TONPAYS', 250_000n);
      await lane.runOnce(tenantA);
      const invoice = await invoiceOf(paymentId);
      advance(2_000);
      tonpays.approve(invoice.provider_invoice_id!);
      expect(
        await lane.receiveWebhook(
          String(tenantA.tenantId),
          'TONPAYS',
          {
            invoice_id: invoice.provider_invoice_id,
            order_id: invoice.provider_order_id,
            request_amount: 250000,
            final_amount: 250000,
            credit_amount: 250000,
            status: 'completed',
            paid: true,
            delivery_id: 'disc-d-1',
            event: 'invoice.completed',
            occurred_at: 1727200000,
            api_version: 1,
          },
          'disc-d-1',
        ),
      ).toBe('SCHEDULED');
      const hintedAt = now;
      const discoveredAt = await passesUntilConfirmed(paymentId, 60_000);
      expect(discoveredAt - hintedAt).toBeLessThanOrEqual(GATEWAY_PAYMENT_INTERVAL_MS);
      const line = expectSettlementLine(paymentId, {
        kind: 'TOPUP',
        trigger: 'WEBHOOK_HINT',
        provider: 'TONPAYS',
      });
      expect(line.webhookToDiscoveryMs).not.toBeNull();
      await expectTopupMessagedOnce(paymentId);
    });

    it('ORDER with the customer’s status tap: brought forward, labelled CUSTOMER_HINT, and the tap is logged by payment id', async () => {
      await enable('TONPAYS');
      const orderId = await confirmedOrder();
      const paymentId = await gatewayOrderPayment('TONPAYS', orderId);
      await lane.runOnce(tenantA);
      await untilFirstAsk(); // the first inquiry: unpaid
      const invoice = await invoiceOf(paymentId);
      advance(4_000);
      tonpays.approve(invoice.provider_invoice_id!);
      const view = await lane.attemptFor(tenantA, maryam, paymentId);
      await lane.requestCheck(tenantA, view!);
      expect(
        logs.filter(
          (one) =>
            one.message === 'gateway status check brought an inquiry forward' &&
            one.context.paymentId === paymentId,
        ),
      ).toHaveLength(1);
      const tappedAt = now;
      const discoveredAt = await passesUntilConfirmed(paymentId, 60_000);
      // No sooner than five seconds after the last inquiry, then the next pass.
      expect(discoveredAt - tappedAt).toBeLessThanOrEqual(5_000 + GATEWAY_PAYMENT_INTERVAL_MS);
      expectSettlementLine(paymentId, {
        kind: 'ORDER',
        trigger: 'CUSTOMER_HINT',
        provider: 'TONPAYS',
      });
      await expectOrderDeliveredOnce(orderId, paymentId);
    });
  });

  // =====================================================================================
  // TonPays Telegram — the receipt acknowledgement and the review cadence
  // =====================================================================================

  describe('a gateway-paid RENEWAL: the provisioner runs it, the notification lane announces it', () => {
    it('Codex #265 (2): labelled PROVISIONER_THEN_NOTIFICATION_LANE, and its final message is SERVICE_RENEWED from the lane, not a delivery card', async () => {
      // A service to renew, bought by card to card and delivered.
      const firstOrder = await confirmedOrder();
      const { payment: bought } = await ctx.container.payments.requestManualTransfer(
        tenantA,
        systemActor(key()),
        maryam,
        { idempotencyKey: key(), orderId: firstOrder },
      );
      await ctx.container.payments.confirmManualTransfer(tenantA, owner, bought.id, {
        idempotencyKey: key(),
        note: 'کارت به کارت',
      });
      await ctx.container.provisionerLoop.tick();
      expect(deliveryCards()).toHaveLength(1);
      const [service] = await rows<{ id: string }>(
        sql`SELECT id FROM services WHERE order_id = ${firstOrder}`,
      );

      // The renewal, paid through TonPays, approval hinted by the webhook.
      await enable('TONPAYS');
      const k = key();
      const { order } = await ctx.container.commercialActions.draft(
        tenantA,
        systemActor(k),
        maryam,
        { serviceId: service!.id, kind: 'RENEW', idempotencyKey: `${k}-quote` },
      );
      await ctx.container.commercialActions.confirm(tenantA, systemActor(k), maryam, {
        orderId: order.id,
        idempotencyKey: `${k}-confirm`,
      });
      const paymentId = await gatewayOrderPayment('TONPAYS', order.id);
      await lane.runOnce(tenantA);
      const invoice = await invoiceOf(paymentId);
      tonpays.approve(invoice.provider_invoice_id!);
      await lane.receiveWebhook(
        String(tenantA.tenantId),
        'TONPAYS',
        {
          invoice_id: invoice.provider_invoice_id,
          order_id: invoice.provider_order_id,
          status: 'completed',
          paid: true,
          delivery_id: 'renew-1',
          event: 'invoice.completed',
          occurred_at: 1727200000,
          api_version: 1,
        },
        'renew-1',
      );
      await passesUntilConfirmed(paymentId, 60_000);
      const line = expectSettlementLine(paymentId, {
        kind: 'ORDER',
        trigger: 'WEBHOOK_HINT',
        provider: 'TONPAYS',
        customerMessage: 'PROVISIONER_THEN_NOTIFICATION_LANE',
      });
      expect(line.orderPurpose).toBe('RENEW');

      // The provisioner runs the renewal; the announcer queues its result for the lane.
      await ctx.container.provisionerLoop.tick();
      expect(deliveryCards(), 'a renewal was announced as a new delivery').toHaveLength(1);
      const queued = await rows<{ kind: string }>(
        sql`SELECT n.kind FROM customer_notifications n
              JOIN provisioning_operations o ON o.id = n.subject_id
             WHERE o.order_id = ${order.id}`,
      );
      expect(queued.map((row) => row.kind)).toEqual(['SERVICE_RENEWED']);
      const before = telegram.sent.filter((body) => String(body['chat_id']) === MARYAM).length;
      await ctx.container.customerNotificationLoop.tick();
      expect(
        telegram.sent.filter((body) => String(body['chat_id']) === MARYAM).length,
        'the lane did not send the renewal result',
      ).toBe(before + 1);
    });
  });

  describe('TONPAYS after a rate limit', () => {
    it('Codex #265 (4): a tap between the normal step and the rate-limit floor is CUSTOMER_HINT, not SCHEDULED', async () => {
      await enable('TONPAYS');
      const paymentId = await gatewayTopup('TONPAYS', 250_000n);
      await lane.runOnce(tenantA);
      const invoice = await invoiceOf(paymentId);
      // The first ask is rate-limited: the row now waits the later of its step and 60 s.
      tonpays.rateLimitNext = 1;
      await untilFirstAsk();
      const [asked] = await rows<{ last_inquiry_at: Date; next_inquiry_at: Date }>(
        sql`SELECT last_inquiry_at, next_inquiry_at FROM gateway_invoices WHERE payment_id = ${paymentId}`,
      );
      const last = new Date(asked!.last_inquiry_at).getTime();
      expect(new Date(asked!.next_inquiry_at).getTime() - last).toBeGreaterThanOrEqual(60_000);
      // 45 s later — past the normal step, inside the floor — the customer taps.
      now = last + 45_000;
      clock.at(new Date(now));
      tonpays.approve(invoice.provider_invoice_id!);
      const view = await lane.attemptFor(tenantA, maryam, paymentId);
      await lane.requestCheck(tenantA, view!);
      await passesUntilConfirmed(paymentId, 60_000);
      expectSettlementLine(paymentId, {
        kind: 'TOPUP',
        trigger: 'CUSTOMER_HINT',
        provider: 'TONPAYS',
      });
    });
  });

  describe('TONPAYS_TELEGRAM on the real review cadence', () => {
    async function acknowledgedOrder(receiptMode: FakeTonPaysTelegram['receiptMode'] = 'ACK') {
      tpt.receiptMode = receiptMode;
      await enable('TONPAYS_TELEGRAM');
      const orderId = await confirmedOrder();
      const paymentId = await gatewayOrderPayment('TONPAYS_TELEGRAM', orderId);
      await lane.runOnce(tenantA); // the create, with a card
      const invoice = await invoiceOf(paymentId);
      expect(invoice.provider_invoice_id).not.toBeNull();
      await ctx.container.gatewayReceiptCaptures.openReceiptCapture(tenantA, systemActor(key()), {
        customerId: maryam,
        paymentId,
        botInstanceId: BOT_A,
      });
      telegram.files.set('disc-receipt', JPEG_BYTES);
      expect(
        await ctx.container.gatewayReceiptCaptures.receivePhoto(tenantA, systemActor(key()), {
          customerId: maryam,
          botInstanceId: BOT_A,
          file: {
            kind: 'PHOTO',
            fileId: 'disc-receipt',
            fileUniqueId: 'disc-receipt',
            mimeType: null,
            fileName: null,
            fileSize: BigInt(JPEG_BYTES.byteLength),
            telegramMessageId: 1n,
            caption: null,
          },
        }),
      ).toBe('QUEUED');
      advance(GATEWAY_PAYMENT_INTERVAL_MS);
      return { orderId, paymentId, invoiceId: invoice.provider_invoice_id! };
    }

    it('ORDER approved on receipt: the acknowledgement’s own inquiry discovers it (RECEIPT_ACK), then the provisioner delivers', async () => {
      const { orderId, paymentId, invoiceId } = await acknowledgedOrder();
      await lane.runOnce(tenantA); // the upload: acknowledged, review opened
      // The provider has approved by the time the acknowledgement's inquiry asks.
      tpt.set(invoiceId, 'completed', true);
      const ackAt = now;
      expect(tpt.receipts).toHaveLength(1);
      const due = new Date((await invoiceOf(paymentId)).next_inquiry_at!).getTime();
      expect(due, 'the acknowledgement did not bring the inquiry forward').toBeLessThanOrEqual(
        ackAt,
      );
      advance(GATEWAY_PAYMENT_INTERVAL_MS);
      const discoveredAt = await passesUntilConfirmed(paymentId, 60_000);
      expect(discoveredAt - ackAt).toBeLessThanOrEqual(GATEWAY_PAYMENT_INTERVAL_MS);
      expectSettlementLine(paymentId, {
        kind: 'ORDER',
        trigger: 'RECEIPT_ACK',
        provider: 'TONPAYS_TELEGRAM',
      });
      await expectOrderDeliveredOnce(orderId, paymentId);
    });

    it('Codex #265 (3): a receipt accepted WITHOUT an acknowledgement brings the inquiry forward and is labelled RECEIPT_UPLOAD, not the customer', async () => {
      const { orderId, paymentId, invoiceId } = await acknowledgedOrder('NO_SIGNAL');
      await lane.runOnce(tenantA); // the upload: accepted, no review opened
      expect(tpt.receipts).toHaveLength(1);
      const [payment] = await rows<{ provider_review_until: Date | null }>(
        sql`SELECT provider_review_until FROM payments WHERE id = ${paymentId}`,
      );
      expect(payment!.provider_review_until, 'a review opened').toBeNull();
      tpt.set(invoiceId, 'completed', true);
      advance(GATEWAY_PAYMENT_INTERVAL_MS);
      await passesUntilConfirmed(paymentId, 60_000);
      expectSettlementLine(paymentId, {
        kind: 'ORDER',
        trigger: 'RECEIPT_UPLOAD',
        provider: 'TONPAYS_TELEGRAM',
      });
      await expectOrderDeliveredOnce(orderId, paymentId);
    });

    it('ORDER approved after the acknowledgement: discovered on the review cadence’s first step, with no callback', async () => {
      const { orderId, paymentId, invoiceId } = await acknowledgedOrder();
      await lane.runOnce(tenantA); // the upload
      advance(GATEWAY_PAYMENT_INTERVAL_MS);
      await lane.runOnce(tenantA); // the acknowledgement's inquiry: still processing
      expect(await paymentState(paymentId)).toBe('PENDING');
      const checksBefore = tpt.checks.length;
      expect(checksBefore).toBeGreaterThan(0);

      advance(5_000);
      tpt.set(invoiceId, 'completed', true);
      const approvedAt = now;
      const discoveredAt = await passesUntilConfirmed(paymentId, 30 * 60_000);
      const firstStep = TONPAYS_TELEGRAM_REVIEW_INQUIRY_CADENCE[0]!.intervalMs;
      expect(discoveredAt - approvedAt).toBeLessThanOrEqual(
        firstStep + GATEWAY_PAYMENT_INTERVAL_MS,
      );
      expect(tpt.checks.length - checksBefore, 'asked more often than the cadence').toBe(1);
      expectSettlementLine(paymentId, {
        kind: 'ORDER',
        trigger: 'SCHEDULED',
        provider: 'TONPAYS_TELEGRAM',
      });
      await expectOrderDeliveredOnce(orderId, paymentId);
    });
  });

  // =====================================================================================
  // The other rails: an ORDER's final message is the provisioner's delivery
  // =====================================================================================

  describe('ORDER on every other rail: the provisioner delivers, nothing is credited as a top-up', () => {
    it('MANUAL_TRANSFER: the operator’s approval, then one delivery', async () => {
      const orderId = await confirmedOrder();
      const { payment } = await ctx.container.payments.requestManualTransfer(
        tenantA,
        systemActor(key()),
        maryam,
        { idempotencyKey: key(), orderId },
      );
      await ctx.container.payments.confirmManualTransfer(tenantA, owner, payment.id, {
        idempotencyKey: key(),
        note: 'کارت به کارت',
      });
      await expectOrderDeliveredOnce(orderId, payment.id);
    });

    it('NOWPAYMENTS: an inquiry approval, then one delivery', async () => {
      await enable('NOWPAYMENTS');
      const orderId = await confirmedOrder();
      const paymentId = await gatewayOrderPayment('NOWPAYMENTS', orderId);
      const result = await ctx.container.payments.confirmGatewayPayment(
        tenantA,
        systemActor(key()),
        paymentId,
        { evidenceNote: 'nowpayments:finished:paid' },
      );
      expect(result.outcome).toBe('SETTLED');
      await expectOrderDeliveredOnce(orderId, paymentId);
    });

    it('CENTRALPAY: a verify naming its bound reference, then one delivery', async () => {
      await enable('CENTRALPAY');
      const orderId = await confirmedOrder();
      const paymentId = await gatewayOrderPayment('CENTRALPAY', orderId);
      await ctx.container.database.db.execute(
        sql`UPDATE gateway_invoices SET provider_charge_id = 'cp-ref-disc' WHERE payment_id = ${paymentId}`,
      );
      const result = await ctx.container.payments.confirmGatewayPayment(
        tenantA,
        systemActor(key()),
        paymentId,
        { evidenceNote: 'centralpay:verified:paid', providerReference: 'cp-ref-disc' },
      );
      expect(result.outcome).toBe('SETTLED');
      await expectOrderDeliveredOnce(orderId, paymentId);
    });

    it('TELEGRAM_STARS: settled on the update (STARS_UPDATE), then one delivery', async () => {
      await enable('TELEGRAM_STARS');
      const orderId = await confirmedOrder();
      const paymentId = await gatewayOrderPayment('TELEGRAM_STARS', orderId);
      await ctx.container.uow.run(tenantA, (tx) =>
        new DrizzleGatewayInvoiceRepository(ctx.container.database.db).recordCharge(
          tenantA,
          paymentId,
          { chargeId: 'stars-charge-disc', status: 'successful_payment', dueAt: new Date(now) },
          new Date(now),
          tx,
        ),
      );
      expect(await lane.settleRecorded(tenantA, paymentId)).toBe('SETTLED');
      const line = expectSettlementLine(paymentId, {
        kind: 'ORDER',
        trigger: 'STARS_UPDATE',
        provider: 'TELEGRAM_STARS',
      });
      // Codex #265 (1): no inquiry discovered it, so no inquiry attempt is claimed.
      expect(line.inquiryAttempt).toBeNull();
      expect(line.orderPurpose).toBe('NEW_SERVICE');
      await expectOrderDeliveredOnce(orderId, paymentId);
    });
  });
});
