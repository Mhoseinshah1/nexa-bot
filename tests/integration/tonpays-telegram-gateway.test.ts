import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  isNexaError,
  money,
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
import { DrizzleReceiptCaptureRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-receipt.repository';
import type { GatewayPaymentService } from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import type { InboundReceiptFile } from '../../apps/api/src/modules/commerce/payments/application/receipt-ports';
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
  startFakeTelegram,
  telegramLaneWith,
  useClock,
} from './tonpays-telegram-fixture';

/**
 * TonPays Telegram (`TONPAYS_TELEGRAM`) end to end against a real database
 * (`docs/tonpays-telegram-gateway-audit.md`): the container's own services — the Telegram
 * runtime, `PaymentService` and its one settlement path, the route service, the customer's
 * receipt and card commands — and a gateway LANE built over the container's database with
 * the REAL `TonPaysTelegramAdapter`, whose `fetch` is a fake written from the owner's
 * transcription. Nothing leaves the process, and nothing here is real-provider acceptance
 * (`OQ-WP10-01`).
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_A2 = SEED_IDS.botA2 as BotInstanceId;
const MARYAM = '910910';
const TELEGRAM_KEY = 'tpt_live_CUSTOM_TELEGRAM_key_never_leak_5a1f';
const WEBSITE_KEY = 'tp_live_WEBSITE_key_never_leak_33c0';

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

describe('TonPays Telegram, through the one settlement path', () => {
  let ctx: TestContext;
  let telegram: Awaited<ReturnType<typeof startFakeTelegram>>;
  let panel: FakeMarzban;
  let products: DrizzleProductRepository;
  let panelId: string;
  let owner: ActorContext;
  let maryam: UserId;
  let fake: FakeTonPaysTelegram;
  let lane: GatewayPaymentService;
  let clock: ReturnType<typeof useClock>;
  let seq = 0;

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
    products = new DrizzleProductRepository(ctx.container.database.db);
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-tpt', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-tpt-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);
    maryam = (
      await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('resolve-m'), {
        idempotencyKey: 'resolve-m',
        telegramUserId: MARYAM,
        from: { id: Number(MARYAM), first_name: 'مریم' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
    await ctx.container.database.db.execute(
      sql`UPDATE bot_instances SET webhook_url = ${`https://bot.example.com/telegram/webhook/${BOT_A}`}
          WHERE tenant_id = ${tenantA.tenantId}`,
    );
    fake = new FakeTonPaysTelegram();
    telegram.sent.length = 0;
    telegram.files.clear();
    telegram.downloads.length = 0;
    lane = telegramLaneWith(ctx, fake);
  });

  // -------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------

  const key = () => {
    seq += 1;
    return `tpt-${String(seq)}`;
  };

  async function enable(
    provider: PaymentGatewayProvider = 'TONPAYS_TELEGRAM',
    apiKey: string | null = TELEGRAM_KEY,
  ) {
    await ctx.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: key(),
      provider,
      config: OPEN_ROUTE,
    });
    if (apiKey !== null) {
      await ctx.container.paymentGateways.setCredential(tenantA, owner, {
        idempotencyKey: key(),
        provider,
        apiKey,
      });
    }
    await ctx.container.paymentGateways.setStatus(tenantA, owner, {
      idempotencyKey: key(),
      provider,
      status: 'ACTIVE',
    });
  }

  async function product(priceMinor = 250_000n): Promise<ProductId> {
    const row = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن تست',
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
    await products.setStatus(tenantA, row.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return row.id;
  }

  let updateSeq = 0;
  const tap = (data: string, bot: BotInstanceId = BOT_A) => {
    updateSeq += 1;
    // The bot's own scope, as its authenticated webhook builds it.
    return ctx.container.botRuntime.handle(
      { tenantId: tenantA.tenantId, botInstanceId: bot },
      systemActor('bot'),
      {
        idempotencyKey: `tpt-update-${String(updateSeq)}`,
        botInstanceId: bot,
        update: {
          update_id: updateSeq,
          callback_query: {
            id: `cbq-${String(updateSeq)}`,
            from: { id: Number(MARYAM), first_name: 'مریم', is_bot: false },
            data,
            message: {
              message_id: updateSeq,
              date: 0,
              chat: { id: Number(MARYAM), type: 'private' },
              from: { id: 999999, is_bot: true, first_name: 'Nexa' },
            },
          },
        },
        telegramUserId: MARYAM,
        from: { id: Number(MARYAM), first_name: 'مریم' },
      },
    );
  };

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await ctx.container.database.db.execute(query)).rows as T[];
  }

  async function draftOrder(priceMinor = 250_000n): Promise<string> {
    const productId = await product(priceMinor);
    await tap(`p:${productId}`);
    const [draft] = await rows<{ id: string }>(
      sql`SELECT id FROM orders WHERE tenant_id = ${tenantA.tenantId} AND customer_id = ${maryam}
          ORDER BY created_at DESC LIMIT 1`,
    );
    if (draft === undefined) throw new Error('no draft');
    await tap(`Z:${draft.id}`);
    return draft.id;
  }

  async function payTelegram(
    orderId: string,
    bot: BotInstanceId = BOT_A,
  ): Promise<PaymentId | null> {
    await tap(`gp:${orderId}.TONPAYS_TELEGRAM`, bot);
    const [payment] = await rows<{ id: string }>(
      sql`SELECT id FROM payments WHERE tenant_id = ${tenantA.tenantId} AND order_id = ${orderId}
          AND method = 'GATEWAY' AND gateway_provider = 'TONPAYS_TELEGRAM'
          ORDER BY created_at DESC LIMIT 1`,
    );
    return (payment?.id as PaymentId | undefined) ?? null;
  }

  const pass = () => lane.runOnce(tenantA);

  async function invoiceOf(paymentId: string) {
    const [row] = await rows<{
      creation_state: string;
      creation_error_code: string | null;
      provider_order_id: string;
      provider_invoice_id: string | null;
      provider_status: string | null;
      card_number: string | null;
      card_seq: number | null;
      bot_instance_id: string | null;
      outcome: string | null;
      next_inquiry_at: string | null;
    }>(sql`SELECT * FROM gateway_invoices WHERE payment_id = ${paymentId}`);
    if (row === undefined) throw new Error('no invoice row');
    return row;
  }

  async function paymentOf(paymentId: string) {
    const [row] = await rows<{
      state: string;
      amount: string;
      expires_at: string;
      provider_review_until: string | null;
      evidence_kind: string | null;
    }>(sql`SELECT * FROM payments WHERE id = ${paymentId}`);
    if (row === undefined) throw new Error('no payment');
    return row;
  }

  /** A created Telegram attempt for a fresh order, and its fake invoice id. */
  async function createdAttempt(priceMinor = 250_000n) {
    await enable();
    const orderId = await draftOrder(priceMinor);
    const paymentId = await payTelegram(orderId);
    if (paymentId === null) throw new Error('no attempt');
    await pass();
    const invoice = await invoiceOf(paymentId);
    if (invoice.provider_invoice_id === null) throw new Error('not created');
    return { orderId, paymentId, invoiceId: invoice.provider_invoice_id };
  }

  const photo = (fileUniqueId: string, overrides: Partial<InboundReceiptFile> = {}) => {
    telegram.files.set(fileUniqueId, JPEG_BYTES);
    return {
      kind: 'PHOTO' as const,
      fileId: fileUniqueId,
      fileUniqueId,
      mimeType: null,
      fileName: null,
      fileSize: BigInt(JPEG_BYTES.byteLength),
      telegramMessageId: 1n,
      caption: null,
      ...overrides,
    };
  };

  const openWindow = (paymentId: string, bot: BotInstanceId = BOT_A) =>
    ctx.container.gatewayReceiptCaptures.openReceiptCapture(tenantA, systemActor(key()), {
      customerId: maryam,
      paymentId,
      botInstanceId: bot,
    });

  const sendPhoto = (file: InboundReceiptFile, bot: BotInstanceId = BOT_A) =>
    ctx.container.gatewayReceiptCaptures.receivePhoto(tenantA, systemActor(key()), {
      customerId: maryam,
      botInstanceId: bot,
      file,
    });

  const askCard = (paymentId: string) =>
    ctx.container.gatewayReceiptCaptures.requestCardChange(tenantA, systemActor(key()), {
      customerId: maryam,
      paymentId,
      botInstanceId: BOT_A,
      idempotencyKey: key(),
    });

  const submissions = (paymentId: string) =>
    rows<{ state: string; error_code: string | null; attempts: number; opened_review: boolean }>(
      sql`SELECT state, error_code, attempts, opened_review FROM gateway_receipt_submissions
          WHERE payment_id = ${paymentId} ORDER BY created_at`,
    );

  const cardChanges = (paymentId: string) =>
    rows<{ state: string; error_code: string | null }>(
      sql`SELECT state, error_code FROM gateway_card_changes WHERE payment_id = ${paymentId}
          ORDER BY requested_at`,
    );

  // =====================================================================================

  describe('creating an attempt', () => {
    it('is a database write while Telegram waits; the worker creates it with the documented request, a REQUIRED buyer_chat_id, its own key and a card', async () => {
      await enable();
      const orderId = await draftOrder();
      const paymentId = await payTelegram(orderId);
      expect(paymentId).not.toBeNull();
      expect(fake.creates).toHaveLength(0);
      const before = await invoiceOf(paymentId!);
      expect(before.creation_state).toBe('CREATING');
      // Bound to the bot the customer tapped in (§5.3, `boundToBot`).
      expect(before.bot_instance_id).toBe(BOT_A);

      await pass();
      expect(fake.creates).toHaveLength(1);
      const [create] = fake.creates;
      expect(create!.url).toBe('https://tonpays.online/api/custom/v1/invoices/telegram/create');
      expect(create!.headers['X-API-Key']).toBe(TELEGRAM_KEY);
      const invoice = await invoiceOf(paymentId!);
      expect(JSON.parse(create!.body)).toEqual({
        amount: 250000,
        order_id: invoice.provider_order_id,
        buyer_chat_id: Number(MARYAM),
        callback_url: `https://bot.example.com/payments/webhook/tonpays_telegram/${String(tenantA.tenantId)}`,
      });
      expect(invoice.provider_order_id).toMatch(/^NT[0-9A-Z]{18}$/u);
      expect(invoice.creation_state).toBe('CREATED');
      expect(invoice.creation_error_code).toBeNull();
      expect(invoice.card_seq).toBe(1);
      expect(invoice.card_number).toBe(fake.invoices.get(invoice.provider_invoice_id!)!.cards[0]);
      const history = await rows<{ seq: number; source: string }>(
        sql`SELECT seq, source FROM gateway_invoice_cards WHERE payment_id = ${paymentId}`,
      );
      expect(history).toEqual([{ seq: 1, source: 'CREATE' }]);
    });

    it('TPTG-12: a created card invoice is the open attempt handed back; one created without a card is not', async () => {
      await enable();
      const orderId = await draftOrder();
      const first = await payTelegram(orderId);
      await pass();
      expect(await payTelegram(orderId)).toBe(first);
      expect(fake.creates).toHaveLength(1);

      // Without a card it cannot be paid from Telegram: noted, never handed back.
      const other = await draftOrder();
      fake.createMode = 'NO_CARD';
      const noCard = await payTelegram(other);
      await pass();
      expect((await invoiceOf(noCard!)).creation_error_code).toBe('nexa.no_payment_card');
      fake.createMode = 'OK';
      const retry = await payTelegram(other);
      expect(retry).not.toBe(noCard);
    });

    it('TPTG-03: a create whose send was stamped and never answered is CREATE_UNKNOWN and never re-sent; DUPLICATE_ORDER_ID is CREATE_UNKNOWN too', async () => {
      await enable();
      const orderId = await draftOrder();
      const paymentId = await payTelegram(orderId);
      await ctx.container.database.db.execute(
        sql`UPDATE gateway_invoices SET creation_sent_at = now() WHERE payment_id = ${paymentId}`,
      );
      await pass();
      expect(fake.creates).toHaveLength(0);
      expect((await invoiceOf(paymentId!)).creation_state).toBe('CREATE_UNKNOWN');

      const other = await draftOrder();
      fake.createMode = { code: 'DUPLICATE_ORDER_ID', status: 409 };
      const duplicate = await payTelegram(other);
      await pass();
      await pass();
      expect(fake.creates).toHaveLength(1);
      expect((await invoiceOf(duplicate!)).creation_state).toBe('CREATE_UNKNOWN');
      expect((await paymentOf(duplicate!)).state).toBe('PENDING');
    });

    it('TPTG-15: WRONG_API_KEY_KIND is configuration — FAILED without telling the customer it failed, and the condition opens for TONPAYS_TELEGRAM', async () => {
      await enable();
      const orderId = await draftOrder();
      fake.createMode = { code: 'WRONG_API_KEY_KIND', status: 403 };
      const paymentId = await payTelegram(orderId);
      await pass();
      expect((await paymentOf(paymentId!)).state).toBe('FAILED');
      expect(
        await rows(sql`SELECT kind FROM customer_notifications WHERE subject_id = ${paymentId}`),
      ).toEqual([]);
      const conditions = await rows<{ code: string; dedupe_key: string }>(
        sql`SELECT code, dedupe_key FROM operational_events WHERE code = 'payments.gateway_misconfigured'`,
      );
      expect(conditions).toEqual([
        {
          code: 'payments.gateway_misconfigured',
          dedupe_key: 'payments.gateway_misconfigured:TONPAYS_TELEGRAM',
        },
      ]);
    });

    it('TPTG-18: refused before any row when the customer’s Telegram id is not a safe integer, or the request comes from no bot', async () => {
      await enable();
      const orderId = await draftOrder();
      await ctx.container.orders.confirm(tenantA, systemActor(key()), {
        idempotencyKey: key(),
        customerId: maryam,
        orderId,
      });
      await ctx.container.database.db.execute(
        sql`UPDATE customers SET telegram_user_id = '99999999999999999999' WHERE id = ${maryam}`,
      );
      const attempt = ctx.container.payments.requestGatewayPayment(
        { tenantId: tenantA.tenantId, botInstanceId: BOT_A },
        systemActor(key()),
        maryam,
        { idempotencyKey: key(), orderId, provider: 'TONPAYS_TELEGRAM' },
      );
      await expect(attempt).rejects.toSatisfy(
        (error: unknown) =>
          isNexaError(error) && error.code === 'commerce.payment_method_unavailable',
      );
      await ctx.container.database.db.execute(
        sql`UPDATE customers SET telegram_user_id = ${MARYAM} WHERE id = ${maryam}`,
      );
      const noBot = ctx.container.payments.requestGatewayPayment(
        tenantA,
        systemActor(key()),
        maryam,
        {
          idempotencyKey: key(),
          orderId,
          provider: 'TONPAYS_TELEGRAM',
        },
      );
      await expect(noBot).rejects.toSatisfy(
        (error: unknown) =>
          isNexaError(error) && error.code === 'commerce.payment_method_unavailable',
      );
      expect(
        await rows(sql`SELECT id FROM payments WHERE order_id = ${orderId} AND method = 'GATEWAY'`),
      ).toEqual([]);
    });
  });

  describe('credentials and coexistence', () => {
    it('TPTG-14: the Telegram route cannot be enabled with only the website key stored, and never reads it', async () => {
      await enable('TONPAYS', WEBSITE_KEY);
      await ctx.container.paymentGateways.configure(tenantA, owner, {
        idempotencyKey: key(),
        provider: 'TONPAYS_TELEGRAM',
        config: OPEN_ROUTE,
      });
      await expect(
        ctx.container.paymentGateways.setStatus(tenantA, owner, {
          idempotencyKey: key(),
          provider: 'TONPAYS_TELEGRAM',
          status: 'ACTIVE',
        }),
      ).rejects.toSatisfy(isNexaError);
      await ctx.container.paymentGateways.setCredential(tenantA, owner, {
        idempotencyKey: key(),
        provider: 'TONPAYS_TELEGRAM',
        apiKey: TELEGRAM_KEY,
      });
      await ctx.container.paymentGateways.setStatus(tenantA, owner, {
        idempotencyKey: key(),
        provider: 'TONPAYS_TELEGRAM',
        status: 'ACTIVE',
      });
      const orderId = await draftOrder();
      await payTelegram(orderId);
      await pass();
      expect(fake.creates[0]!.headers['X-API-Key']).toBe(TELEGRAM_KEY);
      // Both routes ACTIVE at once, each with its own credential row.
      const credentials = await rows<{ provider: string }>(
        sql`SELECT provider FROM payment_gateway_credentials WHERE tenant_id = ${tenantA.tenantId} ORDER BY provider`,
      );
      expect(credentials.map((row) => row.provider)).toEqual(['TONPAYS', 'TONPAYS_TELEGRAM']);
    });

    it('TPTG-16: a webhook to /tonpays/ naming a Telegram order id is IGNORED_UNKNOWN, and to /tonpays_telegram/ it is a hint', async () => {
      const { paymentId, invoiceId } = await createdAttempt();
      const invoice = await invoiceOf(paymentId);
      const body = {
        invoice_id: invoiceId,
        order_id: invoice.provider_order_id,
        status: 'completed',
        paid: true,
        delivery_id: 'd-1',
      };
      expect(await lane.receiveWebhook(String(tenantA.tenantId), 'TONPAYS', body, 'd-1')).toBe(
        'IGNORED_UNKNOWN',
      );
      expect(
        await lane.receiveWebhook(String(tenantA.tenantId), 'TONPAYS_TELEGRAM', body, 'd-1'),
      ).toBe('SCHEDULED');
      // A hint only: nothing settles until the inquiry says so.
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
    });
  });

  describe('the money', () => {
    it('TPTG-01/11: a receipt answer with paid:true settles nothing; only the inquiry’s completed + paid === true does, at the payment’s own amount whatever final_amount says', async () => {
      const { orderId, paymentId, invoiceId } = await createdAttempt();
      expect(await openWindow(paymentId)).not.toBeNull();
      expect(await sendPhoto(photo('receipt-1'))).toBe('QUEUED');
      await pass();
      // The upload answer said paid: true and receipt_received: true — metadata only.
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
      expect(fake.invoices.get(invoiceId)!.finalAmount).not.toBe(250000);

      fake.set(invoiceId, 'completed', true);
      clock.shift(6 * 60_000);
      await pass();
      const payment = await paymentOf(paymentId);
      expect(payment.state).toBe('CONFIRMED');
      expect(payment.evidence_kind).toBe('GATEWAY_INQUIRY');
      expect(String(payment.amount)).toBe('250000');
      const [order] = await rows<{ state: string; total_amount: string }>(
        sql`SELECT state, total_amount FROM orders WHERE id = ${orderId}`,
      );
      expect(order?.state).toBe('PAID');
      expect(String(order?.total_amount)).toBe('250000');
    });
  });

  describe('the card', () => {
    it('applies a new card: appended to the history, made current, the provider’s cooldown copied', async () => {
      const { paymentId } = await createdAttempt();
      clock.shift(61_000);
      expect(await askCard(paymentId)).toBe(true);
      await pass();
      expect(fake.changes).toHaveLength(1);
      expect(fake.changes[0]!.url).toMatch(/\/api\/custom\/v1\/invoices\/TPT-\d+\/change-card$/u);
      const invoice = await invoiceOf(paymentId);
      expect(invoice.card_seq).toBe(2);
      expect(await cardChanges(paymentId)).toEqual([{ state: 'APPLIED', error_code: null }]);
      const history = await rows<{ seq: number; source: string }>(
        sql`SELECT seq, source FROM gateway_invoice_cards WHERE payment_id = ${paymentId} ORDER BY seq`,
      );
      expect(history).toEqual([
        { seq: 1, source: 'CREATE' },
        { seq: 2, source: 'CHANGE_CARD' },
      ]);
    });

    it('TPTG-20: refused locally while one is in flight, during the cooldown, and once exhausted', async () => {
      const { paymentId } = await createdAttempt();
      // The local sixty seconds from the card shown.
      expect(await askCard(paymentId)).toBe(false);
      clock.shift(61_000);
      expect(await askCard(paymentId)).toBe(true);
      expect(await askCard(paymentId)).toBe(false);
      expect(await cardChanges(paymentId)).toHaveLength(1);
      await pass();
      // The provider's own cooldown (60 s) now runs from the new card.
      expect(await askCard(paymentId)).toBe(false);
      clock.shift(130_000);
      await ctx.container.database.db.execute(
        sql`UPDATE gateway_invoices SET card_change_exhausted = true WHERE payment_id = ${paymentId}`,
      );
      expect(await askCard(paymentId)).toBe(false);
      expect(await cardChanges(paymentId)).toHaveLength(1);
    });

    it('TPTG-04: a change whose send was stamped and never answered is UNKNOWN, never re-sent, and the current card is hidden', async () => {
      const { paymentId } = await createdAttempt();
      clock.shift(61_000);
      expect(await askCard(paymentId)).toBe(true);
      await ctx.container.database.db.execute(
        sql`UPDATE gateway_card_changes SET state = 'SENT', sent_at = now() WHERE payment_id = ${paymentId}`,
      );
      await pass();
      await pass();
      expect(fake.changes).toHaveLength(0);
      expect(await cardChanges(paymentId)).toEqual([
        { state: 'UNKNOWN', error_code: 'nexa.send_interrupted' },
      ]);
      const invoice = await invoiceOf(paymentId);
      expect(invoice.card_number).toBeNull();
      expect(invoice.card_seq).toBeNull();
      // The history keeps every card the customer was shown.
      expect(
        await rows(sql`SELECT seq FROM gateway_invoice_cards WHERE payment_id = ${paymentId}`),
      ).toHaveLength(1);
    });

    it('TPTG-04/06: a 5xx carrying RATE_LIMIT_EXCEEDED is UNKNOWN (card hidden); a 4xx rate limit changes nothing', async () => {
      const { paymentId } = await createdAttempt();
      clock.shift(61_000);
      fake.changeMode = { code: 'RATE_LIMIT_EXCEEDED', status: 429 };
      expect(await askCard(paymentId)).toBe(true);
      await pass();
      expect((await invoiceOf(paymentId)).card_seq).toBe(1);
      fake.changeMode = 'SERVER_ERROR';
      expect(await askCard(paymentId)).toBe(true);
      await pass();
      expect(await cardChanges(paymentId)).toEqual([
        { state: 'RATE_LIMITED', error_code: 'RATE_LIMIT_EXCEEDED' },
        { state: 'UNKNOWN', error_code: 'http.503' },
      ]);
      expect((await invoiceOf(paymentId)).card_seq).toBeNull();
    });
  });

  describe('the receipt', () => {
    it('TPTG-08: a provider receipt never writes payment_receipts, never reaches the review queue, and never exempts the payment from expiry', async () => {
      const { paymentId } = await createdAttempt();
      fake.receiptMode = 'NO_SIGNAL';
      expect(await openWindow(paymentId)).not.toBeNull();
      expect(await sendPhoto(photo('receipt-ns'))).toBe('QUEUED');
      await pass();
      expect(await submissions(paymentId)).toEqual([
        { state: 'ACCEPTED', error_code: null, attempts: 1, opened_review: false },
      ]);
      expect(
        await rows(sql`SELECT id FROM payment_receipts WHERE payment_id = ${paymentId}`),
      ).toEqual([]);
      const { expires_at } = await paymentOf(paymentId);
      clock.at(new Date(new Date(expires_at).getTime() + 1));
      await ctx.container.paymentExpirySweep.runOnce(tenantA);
      expect((await paymentOf(paymentId)).state).toBe('EXPIRED');
    });

    it('sends the photo as multipart `file`, downloaded with the bot’s token and bounded, and records an acknowledgement as the review', async () => {
      const { paymentId } = await createdAttempt();
      await openWindow(paymentId);
      expect(await sendPhoto(photo('receipt-ack'))).toBe('QUEUED');
      // Nothing is downloaded or uploaded while Telegram waits.
      expect(telegram.downloads).toEqual([]);
      expect(fake.receipts).toHaveLength(0);
      await pass();
      expect(telegram.downloads).toEqual(['receipt-ack']);
      expect(fake.receipts).toHaveLength(1);
      expect(fake.receipts[0]!.headers['content-type']).toMatch(/^multipart\/form-data/u);
      expect(fake.receipts[0]!.body).toContain('name="file"');
      const [submission] = await submissions(paymentId);
      expect(submission).toMatchObject({ state: 'ACCEPTED', opened_review: true });
      expect((await paymentOf(paymentId)).provider_review_until).not.toBeNull();
    });

    it('TPTG-05: an upload whose send was stamped and never answered is UNKNOWN and never re-uploaded; the same photo is never queued twice', async () => {
      const { paymentId } = await createdAttempt();
      await openWindow(paymentId);
      const file = photo('receipt-5');
      expect(await sendPhoto(file)).toBe('QUEUED');
      await ctx.container.database.db.execute(
        sql`UPDATE gateway_receipt_submissions SET state = 'SENDING', sent_at = now() WHERE payment_id = ${paymentId}`,
      );
      await pass();
      expect(fake.receipts).toHaveLength(0);
      expect(await submissions(paymentId)).toEqual([
        {
          state: 'UNKNOWN',
          error_code: 'nexa.send_interrupted',
          attempts: 0,
          opened_review: false,
        },
      ]);
      // While the lost upload is unresolved, no new window opens.
      expect(await openWindow(paymentId)).toBeNull();
      // An inquiry that answers `pending` resolves it for display; a DIFFERENT photo may go.
      clock.shift(6 * 60_000);
      await pass();
      expect(await openWindow(paymentId)).not.toBeNull();
      expect(await sendPhoto(file)).toBe('DUPLICATE');
      expect(await sendPhoto(photo('receipt-5b'))).toBe('QUEUED');
    });

    it('TPTG-06: only a 4xx RATE_LIMIT_EXCEEDED re-queues (bounded, then ABANDONED); a 5xx carrying it is UNKNOWN', async () => {
      const { paymentId } = await createdAttempt();
      fake.receiptMode = { code: 'RATE_LIMIT_EXCEEDED', status: 429 };
      await openWindow(paymentId);
      await sendPhoto(photo('receipt-6'));
      await pass();
      expect((await submissions(paymentId))[0]).toMatchObject({ state: 'QUEUED', attempts: 1 });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        clock.shift((attempt + 1) * 61_000);
        await pass();
      }
      expect(fake.receipts).toHaveLength(3);
      expect((await submissions(paymentId))[0]).toMatchObject({
        state: 'ABANDONED',
        error_code: 'RATE_LIMIT_EXCEEDED',
      });

      const other = await createdAttempt();
      fake.receiptMode = 'SERVER_ERROR';
      await openWindow(other.paymentId);
      await sendPhoto(photo('receipt-6b'));
      clock.shift(10 * 61_000);
      await pass();
      expect((await submissions(other.paymentId))[0]).toMatchObject({
        state: 'UNKNOWN',
        error_code: 'http.500',
      });
    });

    it('TPTG-07: a window in bot A never takes a photo sent to bot B', async () => {
      const { paymentId } = await createdAttempt();
      await openWindow(paymentId);
      expect(await sendPhoto(photo('receipt-7'), BOT_A2)).toBe('NO_WINDOW');
      expect(await submissions(paymentId)).toEqual([]);
      // Nor can the window be opened for this attempt from another bot.
      expect(await openWindow(paymentId, BOT_A2)).toBeNull();
    });

    it('TPTG-09: a document (even image/*), or a photo declared over 5 MB, is refused before any row', async () => {
      const { paymentId } = await createdAttempt();
      await openWindow(paymentId);
      expect(
        await sendPhoto(
          photo('doc-1', { kind: 'DOCUMENT', mimeType: 'image/jpeg', fileName: 'r.jpg' }),
        ),
      ).toBe('PHOTO_ONLY');
      expect(await sendPhoto(photo('big-1', { fileSize: 5_000_001n }))).toBe('TOO_LARGE');
      expect(await submissions(paymentId)).toEqual([]);
      // The window stays open for the photo the customer sends next.
      expect(await sendPhoto(photo('ok-1'))).toBe('QUEUED');
    });

    it('TPTG-10: opening a provider window supersedes the manual window in the same bot, and opening a manual one supersedes it', async () => {
      const { paymentId } = await createdAttempt();
      const manual = new DrizzleReceiptCaptureRepository(ctx.container.database.db);
      const now = ctx.container.clock.now();
      await ctx.container.uow.run(tenantA, (tx) =>
        manual.open(
          tenantA,
          {
            id: ctx.container.ids.uuid() as never,
            botInstanceId: BOT_A,
            customerId: maryam,
            paymentId: paymentId,
            openedAt: now,
            expiresAt: new Date(now.getTime() + 600_000),
          },
          tx,
        ),
      );
      await openWindow(paymentId);
      expect(
        await rows(sql`SELECT close_reason FROM receipt_captures WHERE customer_id = ${maryam}`),
      ).toEqual([{ close_reason: 'SUPERSEDED' }]);
      const later = new Date(now.getTime() + 1_000);
      await ctx.container.uow.run(tenantA, (tx) =>
        manual.open(
          tenantA,
          {
            id: ctx.container.ids.uuid() as never,
            botInstanceId: BOT_A,
            customerId: maryam,
            paymentId: paymentId,
            openedAt: later,
            expiresAt: new Date(later.getTime() + 600_000),
          },
          tx,
        ),
      );
      expect(
        await rows(
          sql`SELECT close_reason FROM gateway_receipt_captures WHERE customer_id = ${maryam}`,
        ),
      ).toEqual([{ close_reason: 'SUPERSEDED' }]);
      expect(await sendPhoto(photo('receipt-10'))).toBe('NO_WINDOW');
    });

    it('TPTG-33: once the 70 minutes are over nothing is uploaded (ABANDONED), and an acknowledgement after them reopens nothing', async () => {
      const { paymentId } = await createdAttempt();
      await openWindow(paymentId);
      await sendPhoto(photo('receipt-33'));
      const { expires_at } = await paymentOf(paymentId);
      clock.at(new Date(expires_at));
      await pass();
      expect(fake.receipts).toHaveLength(0);
      expect((await submissions(paymentId))[0]).toMatchObject({
        state: 'ABANDONED',
        error_code: 'nexa.deadline_passed',
      });

      // The answer arrives after the deadline while the sweep is late: still nothing opens.
      const other = await createdAttempt();
      await openWindow(other.paymentId);
      await sendPhoto(photo('receipt-33b'));
      const deadline = new Date((await paymentOf(other.paymentId)).expires_at);
      clock.at(new Date(deadline.getTime() - 5_000));
      fake.duringReceipt = () => {
        clock.at(new Date(deadline.getTime() + 1));
        return Promise.resolve();
      };
      await pass();
      expect(fake.receipts).toHaveLength(1);
      const after = await paymentOf(other.paymentId);
      expect(after.provider_review_until).toBeNull();
      expect((await submissions(other.paymentId))[0]).toMatchObject({
        state: 'ACCEPTED',
        opened_review: false,
      });
    });
  });

  describe('the budget and the logs', () => {
    it('TPTG-22: a pass stopped by an empty budget gives back the card-change and receipt leases it did not reach', async () => {
      const first = await createdAttempt();
      const second = await createdAttempt();
      clock.shift(61_000);
      await askCard(first.paymentId);
      await askCard(second.paymentId);
      const empty = telegramLaneWith(ctx, fake, {
        budget: { take: () => Promise.resolve(false) },
      });
      await empty.runOnce(tenantA);
      const leases = await rows<{ claimed_until: string | null }>(
        sql`SELECT claimed_until FROM gateway_card_changes WHERE tenant_id = ${tenantA.tenantId}`,
      );
      expect(leases.map((row) => row.claimed_until)).toEqual([null, null]);

      await openWindow(first.paymentId);
      await sendPhoto(photo('receipt-22'));
      await empty.runOnce(tenantA);
      const receiptLeases = await rows<{ claimed_until: string | null; state: string }>(
        sql`SELECT claimed_until, state FROM gateway_receipt_submissions WHERE tenant_id = ${tenantA.tenantId}`,
      );
      expect(receiptLeases).toEqual([{ claimed_until: null, state: 'QUEUED' }]);
    });

    it('TPTG-21: no key, card number, file id or bytes reach a log line, an audit row or an operational context', async () => {
      const lines: string[] = [];
      const spy = (context: Record<string, unknown>, message: string) =>
        lines.push(`${message} ${JSON.stringify(context)}`);
      lane = telegramLaneWith(ctx, fake, { logger: { info: spy, warn: spy, error: spy } });
      const { paymentId } = await createdAttempt();
      clock.shift(61_000);
      await askCard(paymentId);
      fake.changeMode = 'TIMEOUT';
      await pass();
      clock.shift(62_000);
      await openWindow(paymentId);
      fake.receiptMode = 'TIMEOUT';
      await sendPhoto(photo('secret-file-id-xyz'));
      await pass();
      const cards = fake.invoices.values().next().value!.cards;
      const audit = await rows<{ before: unknown; after: unknown }>(
        sql`SELECT before, after FROM audit_logs WHERE tenant_id = ${tenantA.tenantId}`,
      );
      const events = await rows<{ context: unknown }>(
        sql`SELECT context FROM operational_events WHERE tenant_id = ${tenantA.tenantId}`,
      );
      const everything = JSON.stringify([lines, audit, events]);
      for (const secret of [TELEGRAM_KEY, 'secret-file-id-xyz', ...cards]) {
        expect(everything).not.toContain(secret);
      }
      expect(lines.length).toBeGreaterThan(0);
    });
  });
});
