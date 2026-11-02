import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CATALOGUE_FA, DEFAULT_TEMPLATE_PRESENTATION, renderTemplateBody } from '@nexa/i18n';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  templateDefinition,
  type ActorContext,
  type DomainEvent,
  type TemplateKey,
  type TemplateValues,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type PaymentGatewayConfig,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { GatewayPaymentService } from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import { FinancialLogConsumer } from '../../apps/api/src/modules/commerce/payments/application/financial-log.consumer';
import { DrizzleOpsLogFacts } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/drizzle-ops-log-facts';
import { i18nOpsLogWords } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { DrizzleGatewayInvoiceRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-invoice.repository';
import { DrizzleGatewayProviderRequestRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-provider-request.repository';
import { DrizzleServiceRefundRequestRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-service-refund-request.repository';
import { TonPaysRateLimiter } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-rate-limiter';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import { attemptWire } from '../../apps/api/src/surfaces/miniapp/projections';
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
 * TonPays Telegram, Round 6 (`docs/tonpays-telegram-gateway-audit.md` §19): underpayment
 * (`action_required_less`), overpayment (`action_required_more`) with a refund card, cancel,
 * a buyer who already holds an invoice, rejection reasons, and the money rule that none of it
 * moves. The provider is a fake whose answers are the TonPays API document's own examples
 * (pages 14-18); nothing leaves the process.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const MARYAM = '910922';

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

describe('TonPays Telegram Round 6: remainder, refund, cancel', () => {
  let ctx: TestContext;
  let telegram: Awaited<ReturnType<typeof startFakeTelegram>>;
  let panel: FakeMarzban;
  let panelId: string;
  let owner: ActorContext;
  let maryam: UserId;
  let fake: FakeTonPaysTelegram;
  let lane: GatewayPaymentService;
  let clock: ReturnType<typeof useClock>;
  let seq = 0;
  let updateSeq = 0;

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

  const key = () => {
    seq += 1;
    return `tg-${String(seq)}`;
  };

  const beforeEachAgain = async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    clock = useClock(ctx);
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-tg', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-tg-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);
    maryam = (
      await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('resolve-tg'), {
        idempotencyKey: 'resolve-tg',
        telegramUserId: MARYAM,
        from: { id: Number(MARYAM), first_name: 'مریم' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
    await ctx.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TONPAYS_TELEGRAM',
      config: OPEN_ROUTE,
    });
    await ctx.container.paymentGateways.setCredential(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TONPAYS_TELEGRAM',
      apiKey: 'tpt_live_TG_key_0001',
    });
    await ctx.container.paymentGateways.setStatus(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TONPAYS_TELEGRAM',
      status: 'ACTIVE',
    });
    fake = new FakeTonPaysTelegram();
    fake.enforceOneOpenInvoice = true;
    telegram.sent.length = 0;
    telegram.files.clear();
    lane = telegramLaneWith(ctx, fake, {
      invoiceScreens: ctx.container.wizardScreens,
      providerRequests: true,
    });
  };
  beforeEach(beforeEachAgain);

  const handle = (
    update: Record<string, unknown>,
    who: string = MARYAM,
    bot: BotInstanceId = BOT_A,
  ) => {
    updateSeq += 1;
    return ctx.container.botRuntime.handle(
      { tenantId: tenantA.tenantId, botInstanceId: bot },
      systemActor('bot'),
      {
        idempotencyKey: `tg-update-${String(updateSeq)}`,
        botInstanceId: bot,
        update: { update_id: updateSeq, ...update },
        telegramUserId: who,
        from: { id: Number(who), first_name: 'مشتری' },
      },
    );
  };

  /** A tap on `messageId` (a fresh one when null). */
  const tapOn = (
    messageId: number | null,
    data: string,
    who: string = MARYAM,
    bot: BotInstanceId = BOT_A,
  ) =>
    handle(
      {
        callback_query: {
          id: `cbq-${String(updateSeq + 1)}`,
          from: { id: Number(who), first_name: 'مشتری', is_bot: false },
          data,
          message: {
            message_id: messageId ?? updateSeq + 1,
            date: 0,
            chat: { id: Number(who), type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      who,
      bot,
    );

  const sendPhoto = (fileId: string, who: string = MARYAM, bot: BotInstanceId = BOT_A) => {
    telegram.files.set(fileId, JPEG_BYTES);
    return handle(
      {
        message: {
          message_id: updateSeq + 1,
          date: 0,
          chat: { id: Number(who), type: 'private' },
          from: { id: Number(who), first_name: 'مشتری', is_bot: false },
          photo: [
            { file_id: fileId, file_unique_id: fileId, width: 800, height: 1200, file_size: 4_096 },
          ],
        },
      },
      who,
      bot,
    );
  };

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await ctx.container.database.db.execute(query)).rows as T[];
  }

  /** The card invoice on screen: the order's tap, the worker's create, the edit in place. */
  async function cardOnScreen(): Promise<{ paymentId: string; message: number; orderId: string }> {
    const products = new DrizzleProductRepository(ctx.container.database.db);
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن تست',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    await tapOn(null, `p:${product.id}`);
    const [draft] = await rows<{ id: string }>(
      sql`SELECT id FROM orders WHERE customer_id = ${maryam} ORDER BY created_at DESC LIMIT 1`,
    );
    await tapOn(null, `Z:${draft!.id}`);
    await tapOn(null, `gp:${draft!.id}.TONPAYS_TELEGRAM`);
    const message = updateSeq;
    const [payment] = await rows<{ id: string }>(
      sql`SELECT id FROM payments WHERE order_id = ${draft!.id} AND method = 'GATEWAY'`,
    );
    await lane.runOnce(tenantA);
    return { paymentId: payment!.id, message, orderId: draft!.id };
  }

  const lastOn = (message: number) =>
    telegram.sent
      .filter((body) => body['message_id'] === message || body['sentMessageId'] === message)
      .at(-1);
  /**
   * R9 C1: a NEW next step (a remainder, a refund card) goes out as a NEW message, which then
   * IS the payment's invoice screen; the old invoice message loses its buttons.
   */
  const nextStepMessage = (): number => {
    const body = telegram.sent.filter((one) => one['sentMessageId'] !== undefined).at(-1);
    expect(body, 'the next step was sent as a new message').toBeDefined();
    return Number(body!['sentMessageId']);
  };
  const markupOf = (body: Record<string, unknown> | undefined) =>
    JSON.stringify(body?.['reply_markup'] ?? {});

  // ------------------------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------------------------

  const sendText = (text: string, who: string = MARYAM, bot: BotInstanceId = BOT_A) =>
    handle(
      {
        message: {
          message_id: updateSeq + 1,
          date: 0,
          chat: { id: Number(who), type: 'private' },
          from: { id: Number(who), first_name: 'مشتری', is_bot: false },
          text,
        },
      },
      who,
      bot,
    );

  /** The next inquiry is due now (the worker's schedule is not what is tested here). */
  const inquireNow = async () => {
    await ctx.container.database.db.execute(
      sql`UPDATE gateway_invoices SET next_inquiry_at = now() - interval '1 second',
            inquiry_claimed_until = NULL
          WHERE provider = 'TONPAYS_TELEGRAM' AND outcome IS NULL AND provider_invoice_id IS NOT NULL`,
    );
    return lane.runOnce(tenantA);
  };

  const firstInvoice = () => fake.invoices.values().next().value!;
  const paymentOf = async (paymentId: string) => {
    const [row] = await rows<{ state: string; provider_review_until: string | null }>(
      sql`SELECT state, provider_review_until FROM payments WHERE id = ${paymentId}`,
    );
    return row!;
  };
  const requests = (paymentId: string, kind: 'CANCEL' | 'REFUND') =>
    rows<{
      state: string;
      error_code: string | null;
      refund_card_masked: string | null;
      refund_card_ciphertext: string | null;
    }>(
      sql`SELECT state, error_code, refund_card_masked, refund_card_ciphertext
            FROM gateway_provider_requests WHERE payment_id = ${paymentId} AND kind = ${kind}
           ORDER BY requested_at`,
    );
  const wholeCardAnywhere = async (digits: string) => {
    // Every text column of the request table, as one string: the number must not be in it.
    const [row] = await rows<{ text: string }>(
      sql`SELECT coalesce(string_agg(t::text, ' '), '') AS text FROM gateway_provider_requests t`,
    );
    const audit = await rows<{ text: string }>(
      sql`SELECT coalesce(string_agg(a::text, ' '), '') AS text FROM audit_logs a`,
    );
    return `${row!.text} ${audit[0]!.text}`.includes(digits);
  };
  const walletEntries = (paymentId: string) =>
    rows<{ reason: string; amount: string }>(
      sql`SELECT reason, amount::text AS amount FROM wallet_entries
           WHERE tenant_id = ${tenantA.tenantId} AND payment_id = ${paymentId}`,
    );

  const CARD = '6037991234567890';
  const REFUND_TEXT = `${CARD}\nAli Rezaei`;

  // ------------------------------------------------------------------------------------
  // underpayment: action_required_less
  // ------------------------------------------------------------------------------------

  it('underpay: the remainder, its card and exact amount (tap to copy) and a remainder-receipt button replace the plain open invoice; nothing settles', async () => {
    const { paymentId } = await cardOnScreen();
    firstInvoice().status = 'processing';
    fake.underpay(firstInvoice().invoiceId, 12_000);
    await inquireNow();
    const step = nextStepMessage();
    const screen = lastOn(step);
    const text = String(screen?.['text']);
    expect(text).toContain('کمتر از مبلغ فاکتور بود');
    expect(text).toContain('6219861012345678');
    expect(text).toContain('Shop Card');
    // v0.8.2 hotfix: TonPays' 12,000 Toman is shown as 120,000 RIAL, Toman only in brackets.
    expect(text).toContain('مبلغ مابقی قابل واریز: ۱۲۰٬۰۰۰ ریال\n(معادل ۱۲٬۰۰۰ تومان)');
    expect(text).not.toContain('12,000');
    const markup = markupOf(screen);
    expect(markup).toContain('"copy_text":{"text":"6219861012345678"}'); // the card
    expect(markup).toContain('"copy_text":{"text":"120000"}'); // the remainder, in rial digits
    expect(markup).not.toContain('"copy_text":{"text":"12000"}');
    expect(markup).toContain(`gr:${paymentId}`);
    expect(markup).toContain('ارسال رسید مابقی');
    // Never plain "open", never "paid".
    expect(text).not.toContain('شماره کارت مقصد: ' + firstInvoice().cards[0]!);
    expect((await paymentOf(paymentId)).state).toBe('PENDING');
    expect(await walletEntries(paymentId)).toEqual([]);
  });

  it('underpay: the remainder receipt goes to the REMAINDER invoice, the original stays action_required_less, and only completed + paid settles', async () => {
    const { paymentId } = await cardOnScreen();
    fake.underpay(firstInvoice().invoiceId, 12_000);
    await inquireNow();
    const step = nextStepMessage();
    const prompt = await tapOn(step, `gr:${paymentId}`);
    expect(prompt.replyKey).toBe('bot.payment.gateway_receipt_prompt');
    expect((await sendPhoto('rem-1')).replyKey).toBe('bot.payment.gateway_receipt_queued');
    await lane.runOnce(tenantA);
    expect(fake.receipts).toHaveLength(1);
    expect(fake.receipts[0]!.url).toBe(
      'https://tonpays.online/api/custom/v1/invoices/TP-REM123XYZ0/receipt',
    );
    await inquireNow();
    const text = String(lastOn(step)?.['text']);
    expect(text).toContain('رسید مابقی');
    expect(text).toContain('در انتظار پاسخ');
    expect(text).toContain('مبلغ مابقی: ۱۲۰٬۰۰۰ ریال\n(معادل ۱۲٬۰۰۰ تومان)');
    expect(firstInvoice().status).toBe('action_required_less');
    expect((await paymentOf(paymentId)).state).toBe('PENDING');

    firstInvoice().status = 'completed';
    firstInvoice().paid = true;
    await inquireNow();
    expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
  });

  it('underpay: a status with no usable remainder is "details not available", not an invented card', async () => {
    await cardOnScreen();
    firstInvoice().status = 'action_required_less';
    firstInvoice().remainingAmount = 12_000; // no card, no remainder invoice id
    await inquireNow();
    const step = nextStepMessage();
    const text = String(lastOn(step)?.['text']);
    expect(text).toContain('اطلاعات کارت مابقی را هنوز نفرستاده');
    expect(markupOf(lastOn(step))).not.toContain('copy_text');
  });

  // ------------------------------------------------------------------------------------
  // overpayment: action_required_more
  // ------------------------------------------------------------------------------------

  it('overpay: the refund card is collected, /refund is called ONCE with the document body and no amount, the card is never stored whole, and the invoice settles once at the principal', async () => {
    const { paymentId } = await cardOnScreen();
    fake.overpay(firstInvoice().invoiceId, 15_000);
    await inquireNow();
    const step = nextStepMessage();
    expect(String(lastOn(step)?.['text'])).toContain('بیشتر از مبلغ فاکتور');
    expect(markupOf(lastOn(step))).toContain(`gf:${paymentId}`);

    const prompt = await tapOn(step, `gf:${paymentId}`);
    expect(prompt.replyKey).toBe('bot.payment.gateway_refund_card_prompt');
    const reply = await sendText(REFUND_TEXT);
    expect(reply.replyKey).toBe('bot.payment.gateway_refund_requested');
    const [queued] = await requests(paymentId, 'REFUND');
    expect(queued).toMatchObject({ state: 'REQUESTED', refund_card_masked: '603799******7890' });
    expect(queued!.refund_card_ciphertext).not.toBeNull();
    // Sealed, never plain: the whole number is nowhere in the table or the audit log.
    expect(await wholeCardAnywhere(CARD)).toBe(false);

    await lane.runOnce(tenantA);
    expect(fake.refunds).toHaveLength(1);
    expect(fake.refunds[0]!.url).toBe(
      `https://tonpays.online/api/custom/v1/invoices/${firstInvoice().invoiceId}/refund`,
    );
    expect(fake.refunds[0]!.headers['X-API-Key']).toBe('tpt_live_TG_key_0001');
    expect(JSON.parse(fake.refunds[0]!.body)).toEqual({
      invoice_id: firstInvoice().invoiceId,
      card_number: CARD,
      card_holder: 'Ali Rezaei',
    });
    const [applied] = await requests(paymentId, 'REFUND');
    expect(applied).toMatchObject({ state: 'APPLIED', refund_card_masked: '603799******7890' });
    // The send stamp wiped the sealed card.
    expect(applied!.refund_card_ciphertext).toBeNull();
    expect(await wholeCardAnywhere(CARD)).toBe(false);
    // Still not settled: the refund answer said paid: true, which is metadata.
    expect((await paymentOf(paymentId)).state).toBe('PENDING');
    expect(String(lastOn(step)?.['text'])).toContain('603799******7890');

    // The provider finishes: the inquiry — and only it — settles, once.
    firstInvoice().status = 'completed';
    firstInvoice().paid = true;
    await inquireNow();
    await inquireNow();
    expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
    expect(fake.refunds).toHaveLength(1);
  });

  it('overpay: an invalid card text stores and sends nothing, reopens the window, and the next message is read', async () => {
    const { paymentId } = await cardOnScreen();
    fake.overpay(firstInvoice().invoiceId, 15_000);
    await inquireNow();
    const step = nextStepMessage();
    await tapOn(step, `gf:${paymentId}`);
    for (const bad of ['hello', `${CARD}`, '12345\nAli Rezaei', `${CARD}\n12345`]) {
      const answer = await sendText(bad);
      expect(answer.replyKey, bad).toBe('bot.payment.gateway_refund_card_invalid');
    }
    expect(await requests(paymentId, 'REFUND')).toEqual([]);
    // Persian digits are read; the window was reopened by every refusal.
    const good = await sendText('۶۰۳۷۹۹۱۲۳۴۵۶۷۸۹۰\nعلی رضایی');
    expect(good.replyKey).toBe('bot.payment.gateway_refund_requested');
    expect(await requests(paymentId, 'REFUND')).toHaveLength(1);
  });

  it('overpay: INVALID_REFUND_CARD, INVALID_REFUND_HOLDER, REFUND_NOT_ALLOWED and REFUND_ALREADY_OPEN each get their own Persian message', async () => {
    const cases: [string, string][] = [
      ['INVALID_REFUND_CARD', 'شماره'],
      ['INVALID_REFUND_HOLDER', 'نام صاحب کارت را نپذیرفت'],
      ['REFUND_NOT_ALLOWED', 'مجاز ندانست'],
      ['REFUND_ALREADY_OPEN', 'پیش‌تر درخواست بازگشت'],
    ];
    for (const [code, phrase] of cases) {
      await ctx.reset();
      await beforeEachAgain();
      const { paymentId } = await cardOnScreen();
      fake.overpay(firstInvoice().invoiceId, 15_000);
      await inquireNow();
      const step = nextStepMessage();
      await tapOn(step, `gf:${paymentId}`);
      await sendText(REFUND_TEXT);
      fake.refundMode = { code, status: 400 };
      await lane.runOnce(tenantA);
      const [row] = await requests(paymentId, 'REFUND');
      expect(row, code).toMatchObject({ state: 'REFUSED', error_code: code });
      expect(row!.refund_card_ciphertext, code).toBeNull();
      expect(String(lastOn(step)?.['text']), code).toContain(phrase);
      expect(fake.refunds, code).toHaveLength(1);
    }
  });

  it('overpay: a refund whose answer is lost is UNKNOWN and is never sent again; a stamped row found later is UNKNOWN too', async () => {
    const { paymentId } = await cardOnScreen();
    fake.overpay(firstInvoice().invoiceId, 15_000);
    await inquireNow();
    const step = nextStepMessage();
    await tapOn(step, `gf:${paymentId}`);
    await sendText(REFUND_TEXT);
    fake.refundMode = 'TIMEOUT';
    await lane.runOnce(tenantA);
    expect((await requests(paymentId, 'REFUND'))[0]).toMatchObject({ state: 'UNKNOWN' });
    expect((await requests(paymentId, 'REFUND'))[0]!.refund_card_ciphertext).toBeNull();
    fake.refundMode = 'OK';
    await lane.runOnce(tenantA);
    await lane.runOnce(tenantA);
    expect(fake.refunds).toHaveLength(1);
    expect(String(lastOn(step)?.['text'])).toContain('پاسخ تون‌پی به درخواست بازگشت');
    const [event] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM operational_events WHERE code = 'payments.gateway_request_unknown'`,
    );
    expect(event?.n).toBe(1);
  });

  it('a cancel or a refund whose send was stamped and never answered is UNKNOWN when found, and is never sent', async () => {
    const { paymentId } = await cardOnScreen();
    fake.overpay(firstInvoice().invoiceId, 15_000);
    await inquireNow();
    const step = nextStepMessage();
    await tapOn(step, `gf:${paymentId}`);
    await sendText(REFUND_TEXT);
    // A worker died after stamping the send: the stamp is set, the row is not decided.
    await ctx.container.database.db.execute(
      sql`UPDATE gateway_provider_requests
             SET state = 'SENT', sent_at = now(), refund_card_ciphertext = NULL, refund_card_key_id = NULL,
                 claimed_until = NULL
           WHERE payment_id = ${paymentId} AND kind = 'REFUND'`,
    );
    await lane.runOnce(tenantA);
    expect(fake.refunds).toHaveLength(0);
    expect(await requests(paymentId, 'REFUND')).toMatchObject([
      { state: 'UNKNOWN', error_code: 'nexa.send_interrupted' },
    ]);

    // The same for a cancel on another payment.
    const other = await topupIn(100_000n);
    await ctx.container.database.db.execute(
      sql`INSERT INTO gateway_provider_requests
            (id, tenant_id, payment_id, bot_instance_id, customer_id, kind, state, requested_at, sent_at, idempotency_key)
          SELECT gen_random_uuid(), tenant_id, id, ${BOT_A}, customer_id, 'CANCEL', 'SENT', now(), now(), 'stamped-cancel'
            FROM payments WHERE id = ${other.payment.id}`,
    );
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(0);
    expect(await requests(other.payment.id, 'CANCEL')).toMatchObject([
      { state: 'UNKNOWN', error_code: 'nexa.send_interrupted' },
    ]);
  });

  it('overpay: the refund is refused while the invoice is not overpaid (a tap on a stale button writes nothing)', async () => {
    const { paymentId, message } = await cardOnScreen();
    await tapOn(message, `gf:${paymentId}`);
    expect(await requests(paymentId, 'REFUND')).toEqual([]);
    expect(await rows(sql`SELECT id FROM customer_text_captures`)).toEqual([]);
  });

  // ------------------------------------------------------------------------------------
  // cancel
  // ------------------------------------------------------------------------------------

  it('cancel: ask, confirm, a request row, ONE /cancel by the worker, the payment FAILED quietly, and the message says cancelled', async () => {
    const { paymentId, message } = await cardOnScreen();
    expect(markupOf(lastOn(message))).toContain(`gq:${paymentId}`);
    const ask = await tapOn(message, `gq:${paymentId}`);
    expect(ask.replyKey).toBe('bot.payment.gateway_cancel_confirm');
    expect(markupOf(lastOn(message))).toContain(`gz:${paymentId}`);
    expect(fake.cancels).toHaveLength(0);
    await tapOn(message, `gz:${paymentId}`);
    expect(String(lastOn(message)?.['text'])).toContain('درخواست لغو');
    expect(fake.cancels).toHaveLength(0);
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([{ state: 'REQUESTED' }]);

    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(1);
    expect(fake.cancels[0]!.url).toBe(
      `https://tonpays.online/api/custom/v1/invoices/${firstInvoice().invoiceId}/cancel`,
    );
    expect(fake.cancels[0]!.body).toBe('');
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([{ state: 'APPLIED' }]);
    expect((await paymentOf(paymentId)).state).toBe('FAILED');
    // R8 A3: who cancelled is on the row, so the operations log says «لغوکننده: مشتری».
    expect(await rows(sql`SELECT resolution_note FROM payments WHERE id = ${paymentId}`)).toEqual([
      { resolution_note: 'tonpays_telegram:canceled_by_customer' },
    ]);
    expect(String(lastOn(message)?.['text'])).toContain('فاکتور لغو شد');
    // The customer asked: no "your payment failed" notification.
    expect(
      await rows(sql`SELECT id FROM customer_notifications WHERE kind = 'GATEWAY_PAYMENT_FAILED'`),
    ).toEqual([]);
    // A second tap on the same confirm writes nothing more.
    await tapOn(message, `gz:${paymentId}`);
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(1);
  });

  it('cancel: only a pending invoice offers it — not once a receipt is on its way, not when underpaid or overpaid', async () => {
    const { paymentId, message } = await cardOnScreen();
    await tapOn(message, `gr:${paymentId}`);
    await sendPhoto('c-1');
    await tapOn(message, `gc:${paymentId}`);
    expect(markupOf(lastOn(message))).not.toContain(`gq:${paymentId}`);
    expect((await tapOn(message, `gq:${paymentId}`)).replyKey).not.toBe(
      'bot.payment.gateway_cancel_confirm',
    );
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(0);
    fake.overpay(firstInvoice().invoiceId, 100);
    await inquireNow();
    const step = nextStepMessage();
    expect(markupOf(lastOn(step))).not.toContain(`gq:${paymentId}`);
  });

  it('cancel: CANCEL_NOT_ALLOWED_PROCESSING, _NEED_ACTION_LESS, _NEED_ACTION_MORE and NOT_PENDING each get their own message and leave the payment open', async () => {
    const cases: [string, string][] = [
      ['CANCEL_NOT_ALLOWED_PROCESSING', 'در حال بررسی تون‌پی است'],
      ['CANCEL_NOT_ALLOWED_NEED_ACTION_LESS', 'مبلغ کمتری واریز شده'],
      ['CANCEL_NOT_ALLOWED_NEED_ACTION_MORE', 'مبلغ بیشتری واریز شده'],
      ['NOT_PENDING', 'دیگر در انتظار پرداخت نیست'],
    ];
    for (const [code, phrase] of cases) {
      await ctx.reset();
      await beforeEachAgain();
      const { paymentId, message } = await cardOnScreen();
      fake.cancelMode = { code, status: 409 };
      await tapOn(message, `gz:${paymentId}`);
      await lane.runOnce(tenantA);
      expect(await requests(paymentId, 'CANCEL'), code).toMatchObject([
        { state: 'REFUSED', error_code: code },
      ]);
      expect((await paymentOf(paymentId)).state, code).toBe('PENDING');
      expect(String(lastOn(message)?.['text']), code).toContain(phrase);
    }
  });

  it('cancel: a cancel whose answer is lost is UNKNOWN, never sent again by Nexa itself, and the next inquiry says what the invoice is', async () => {
    const { paymentId, message } = await cardOnScreen();
    fake.cancelMode = 'TIMEOUT';
    await tapOn(message, `gz:${paymentId}`);
    await lane.runOnce(tenantA);
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([{ state: 'UNKNOWN' }]);
    fake.cancelMode = 'OK';
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(1);
    // The provider did cancel it: the inquiry reports `canceled` and the payment fails.
    firstInvoice().status = 'canceled';
    await inquireNow();
    expect((await paymentOf(paymentId)).state).toBe('FAILED');
  });

  // ------------------------------------------------------------------------------------
  // a new top-up while an own pending invoice exists; a buyer who holds an invoice
  // ------------------------------------------------------------------------------------

  const topupIn = (amount: bigint) => {
    const k = key();
    return ctx.container.payments.requestGatewayTopup(
      { ...tenantA, botInstanceId: BOT_A },
      systemActor(k),
      maryam,
      { idempotencyKey: k, amount: money(amount, 'IRT'), provider: 'TONPAYS_TELEGRAM' },
    );
  };

  it('a new top-up while an own pending invoice exists: the old one is cancelled FIRST, then the new one is created', async () => {
    const { paymentId: first, message } = await cardOnScreen();
    const second = await topupIn(100_000n);
    await lane.runOnce(tenantA);
    const calls = [
      ...fake.cancels.map((call) => ({ at: 'cancel', url: call.url })),
      ...fake.creates.map(() => ({ at: 'create', url: '' })),
    ];
    expect(calls.map((call) => call.at)).toEqual(['cancel', 'create', 'create']);
    expect(fake.cancels[0]!.url).toContain(`/${[...fake.invoices.keys()][0]!}/cancel`);
    expect((await paymentOf(first)).state).toBe('FAILED');
    // R8 A3: Nexa cancelled it, not the customer — and the note says so.
    expect(await rows(sql`SELECT resolution_note FROM payments WHERE id = ${first}`)).toEqual([
      { resolution_note: 'tonpays_telegram:canceled_by_nexa' },
    ]);
    expect(fake.creates).toHaveLength(2);
    const [created] = await rows<{ creation_state: string }>(
      sql`SELECT creation_state FROM gateway_invoices WHERE payment_id = ${second.payment.id}`,
    );
    expect(created?.creation_state).toBe('CREATED');
    expect(String(lastOn(message)?.['text'])).toContain('فاکتور لغو شد');
  });

  it('BUYER_HAS_PROCESSING_INVOICE / _NEED_ACTION_LESS / _NEED_ACTION_MORE show the open invoice and its next step, not a generic error', async () => {
    const cases: [string, (invoiceId: string) => void, string][] = [
      [
        'BUYER_HAS_PROCESSING_INVOICE',
        (id) => (fake.invoices.get(id)!.status = 'processing'),
        'در حال بررسی است',
      ],
      ['BUYER_HAS_NEED_ACTION_LESS', (id) => fake.underpay(id, 12_000), 'کمتر واریز شده'],
      ['BUYER_HAS_NEED_ACTION_MORE', (id) => fake.overpay(id, 15_000), 'بیشتر واریز شده'],
    ];
    for (const [code, arrange, phrase] of cases) {
      await ctx.reset();
      await beforeEachAgain();
      const { paymentId: open } = await cardOnScreen();
      arrange(firstInvoice().invoiceId);
      // Nexa learned of it.
      await inquireNow();
      const second = await topupIn(100_000n);
      await lane.runOnce(tenantA);
      const [row] = await rows<{ creation_state: string; creation_error_code: string | null }>(
        sql`SELECT creation_state, creation_error_code FROM gateway_invoices WHERE payment_id = ${second.payment.id}`,
      );
      expect(row, code).toMatchObject({
        creation_state: 'CREATE_FAILED',
        creation_error_code: code,
      });
      // Nothing was cancelled: the provider refuses it, and Nexa does not ask.
      expect(fake.cancels, code).toHaveLength(0);
      const screen = await tapOn(null, `gc:${second.payment.id}`);
      expect(screen.replyKey, code).toBeTruthy();
      const sent = telegram.sent.at(-1);
      expect(String(sent?.['text']), code).toContain(phrase);
      expect(markupOf(sent), code).toContain(`gc:${open}`);
    }
  });

  it('a blocking invoice inside its review window is still the one shown, with its action', async () => {
    const { paymentId: open, message } = await cardOnScreen();
    // A receipt the provider acknowledged opens the review window; then it finds the shortfall.
    await tapOn(message, `gr:${open}`);
    await sendPhoto('rev-1');
    await lane.runOnce(tenantA);
    expect((await paymentOf(open)).provider_review_until).not.toBeNull();
    fake.underpay(firstInvoice().invoiceId, 12_000);
    await inquireNow();
    const second = await topupIn(100_000n);
    await lane.runOnce(tenantA);
    await tapOn(null, `gc:${second.payment.id}`);
    expect(markupOf(telegram.sent.at(-1))).toContain(`gc:${open}`);
    expect(String(telegram.sent.at(-1)?.['text'])).toContain('کمتر واریز شده');
  });

  it('a pre-create cancel the provider rate-limited keeps the new create waiting, is asked again, and only then is the create sent', async () => {
    await cardOnScreen();
    fake.cancelMode = { code: 'RATE_LIMIT_EXCEEDED', status: 429 };
    const second = await topupIn(100_000n);
    await lane.runOnce(tenantA);
    expect(fake.creates).toHaveLength(1);
    const state = () =>
      rows<{ creation_state: string }>(
        sql`SELECT creation_state FROM gateway_invoices WHERE payment_id = ${second.payment.id}`,
      );
    expect(await state()).toEqual([{ creation_state: 'CREATING' }]);
    fake.cancelMode = 'OK';
    clock.shift(10_000);
    await lane.runOnce(tenantA);
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(2);
    expect(fake.creates).toHaveLength(2);
    expect(await state()).toEqual([{ creation_state: 'CREATED' }]);
  });

  it('a cancel still in flight keeps the create waiting; the create is never sent past it', async () => {
    const { paymentId, message } = await cardOnScreen();
    await tapOn(message, `gz:${paymentId}`);
    const second = await topupIn(100_000n);
    // Creations run before the request lane: the customer's own cancel is not yet sent.
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(1);
    expect(fake.creates).toHaveLength(1);
    const [row] = await rows<{ creation_state: string }>(
      sql`SELECT creation_state FROM gateway_invoices WHERE payment_id = ${second.payment.id}`,
    );
    expect(row?.creation_state).toBe('CREATING');
  });

  it('BUYER_HAS_PENDING_INVOICE: the customer’s own pending invoice is cancelled and the create retried ONCE, with the same order id', async () => {
    const { paymentId: first } = await cardOnScreen();
    // Race: the pre-create look finds no sibling; the provider then refuses the create.
    let looks = 0;
    lane = telegramLaneWith(ctx, fake, {
      invoiceScreens: ctx.container.wizardScreens,
      providerRequests: (real) =>
        new Proxy(real, {
          get(target, property, receiver) {
            if (property === 'siblingAttempts') {
              return async (...args: Parameters<typeof real.siblingAttempts>) => {
                looks += 1;
                return looks === 1 ? [] : real.siblingAttempts(...args);
              };
            }
            return Reflect.get(target, property, receiver) as unknown;
          },
        }),
    });
    const second = await topupIn(100_000n);
    await lane.runOnce(tenantA);
    expect(fake.creates).toHaveLength(2); // the first create was refused…
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(1);
    expect((await paymentOf(first)).state).toBe('FAILED');
    expect(fake.creates).toHaveLength(3); // …and sent again once
    const orderIds = fake.creates.map(
      (call) => (JSON.parse(call.body) as { order_id: string }).order_id,
    );
    expect(orderIds[2]).toBe(orderIds[1]);
    const [row] = await rows<{ creation_state: string }>(
      sql`SELECT creation_state FROM gateway_invoices WHERE payment_id = ${second.payment.id}`,
    );
    expect(row?.creation_state).toBe('CREATED');
  });

  it('BUYER_HAS_PENDING_INVOICE with an invoice Nexa did not make: no cancel, no retry, the customer is told', async () => {
    await cardOnScreen();
    // The provider holds a pending invoice for this buyer that Nexa has no payment for.
    const stray = firstInvoice();
    const [old] = await rows<{ id: string }>(
      sql`SELECT id FROM payments WHERE method = 'GATEWAY' AND customer_id = ${maryam}`,
    );
    // Nexa gave up on it locally (it never told the provider): still pending THERE.
    await ctx.container.payments.failGatewayPayment(tenantA, systemActor(key()), old!.id, {
      reasonCode: 'tonpays_telegram:test',
      notifyCustomer: false,
    });
    expect(stray.status).toBe('pending');
    const second = await topupIn(100_000n);
    await lane.runOnce(tenantA);
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(0);
    expect(fake.creates).toHaveLength(2);
    const [row] = await rows<{ creation_state: string; creation_error_code: string | null }>(
      sql`SELECT creation_state, creation_error_code FROM gateway_invoices WHERE payment_id = ${second.payment.id}`,
    );
    expect(row).toMatchObject({
      creation_state: 'CREATE_FAILED',
      creation_error_code: 'BUYER_HAS_PENDING_INVOICE',
    });
  });

  // ------------------------------------------------------------------------------------
  // rejection reasons
  // ------------------------------------------------------------------------------------

  it('reject_reasons: shown to the customer, kept on the payment’s facts, and written into the failure’s audit row', async () => {
    const { paymentId, message } = await cardOnScreen();
    firstInvoice().status = 'rejected';
    firstInvoice().rejectReasons = [
      'رسید خوانا نبود',
      { message: 'نام صاحب کارت مطابقت ندارد' },
      42,
    ];
    await inquireNow();
    expect((await paymentOf(paymentId)).state).toBe('FAILED');
    const text = String(lastOn(message)?.['text']);
    expect(text).toContain('رسید خوانا نبود');
    expect(text).toContain('نام صاحب کارت مطابقت ندارد');
    const [facts] = await rows<{ reject_reasons: string[] }>(
      sql`SELECT reject_reasons FROM gateway_invoice_provider_facts WHERE payment_id = ${paymentId}`,
    );
    expect(facts?.reject_reasons).toEqual(['رسید خوانا نبود', 'نام صاحب کارت مطابقت ندارد']);
    const audit = await rows<{ after: { providerReasons?: string[] } }>(
      sql`SELECT after FROM audit_logs WHERE entity_id = ${paymentId} AND action = 'payment.gateway_fail'`,
    );
    expect(audit[0]?.after.providerReasons).toEqual([
      'رسید خوانا نبود',
      'نام صاحب کارت مطابقت ندارد',
    ]);
  });

  // ------------------------------------------------------------------------------------
  // the money: only the principal is ever credited
  // ------------------------------------------------------------------------------------

  it('with a 10% customer fee, a webhook credit_amount, final_amount and refund_amount never reach the wallet: a top-up credits its principal only', async () => {
    await ctx.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TONPAYS_TELEGRAM',
      config: { ...OPEN_ROUTE, customerFeeBasisPoints: 1000 } as PaymentGatewayConfig,
    });
    const attempt = await topupIn(100_000n);
    await lane.runOnce(tenantA);
    const [invoice] = await rows<{
      provider_invoice_id: string;
      provider_order_id: string;
      sent_amount: string;
    }>(
      sql`SELECT provider_invoice_id, provider_order_id, sent_amount::text FROM gateway_invoices WHERE payment_id = ${attempt.payment.id}`,
    );
    // The fee is on top of the principal: TonPays is asked for the payable.
    expect(invoice?.sent_amount).toBe('110000');
    const fakeInvoice = fake.invoices.get(invoice!.provider_invoice_id)!;
    fakeInvoice.finalAmount = 110_037;
    // A webhook carrying a credit_amount that is neither the principal nor the payable.
    await lane.receiveWebhook(
      String(tenantA.tenantId),
      'TONPAYS_TELEGRAM',
      {
        invoice_id: fakeInvoice.invoiceId,
        order_id: invoice!.provider_order_id,
        credit_amount: 999_999,
        status: 'completed',
        paid: true,
        delivery_id: 'wh-1',
        refund_amount: 15_000,
      },
      'wh-1',
    );
    expect((await paymentOf(attempt.payment.id)).state).toBe('PENDING');
    fakeInvoice.refundAmount = 15_000;
    fakeInvoice.status = 'completed';
    fakeInvoice.paid = true;
    await inquireNow();
    expect((await paymentOf(attempt.payment.id)).state).toBe('CONFIRMED');
    const entries = await walletEntries(attempt.payment.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ amount: '100000' });
  });

  // ------------------------------------------------------------------------------------
  // R9 C1: the customer and the operator are always told; cancel on expiry; credit_amount
  // ------------------------------------------------------------------------------------

  /** The `GatewayPaymentAttentionRaised` rows this payment's transactions wrote, in order. */
  const attention = (paymentId: string) =>
    rows<{ id: string; payload: { reason: string }; occurred_at: Date | string }>(
      sql`SELECT id, payload, occurred_at FROM outbox_messages
           WHERE event_type = 'GatewayPaymentAttentionRaised' AND aggregate_id = ${paymentId}
           ORDER BY sequence`,
    );

  /** Each of those rows through the REAL financial-log consumer, rendered in Persian. */
  async function opsMessages(paymentId: string): Promise<{ key: string; text: string }[]> {
    const db = ctx.container.database.db;
    const out: { key: string; text: string }[] = [];
    for (const row of await attention(paymentId)) {
      const queued: { templateKey: TemplateKey; values: TemplateValues }[] = [];
      const consumer = new FinancialLogConsumer({
        lane: {
          financialDestination: async () =>
            ({ transport: 'TELEGRAM', chatId: '-1001', topicId: null }) as never,
          queue: async (_scope, input) => {
            queued.push({ templateKey: input.templateKey, values: input.values });
            return undefined;
          },
        },
        payments: new DrizzlePaymentRepository(db),
        customers: new DrizzleCustomerRepository(db),
        invoices: new DrizzleGatewayInvoiceRepository(db),
        facts: new DrizzleOpsLogFacts(db),
        words: i18nOpsLogWords,
        refundRequests: new DrizzleServiceRefundRequestRepository(db),
        providerRequests: new DrizzleGatewayProviderRequestRepository(db),
      });
      const event = {
        eventId: row.id,
        eventType: 'GatewayPaymentAttentionRaised',
        eventVersion: 1,
        tenantId: String(tenantA.tenantId),
        aggregateType: 'Payment',
        aggregateId: paymentId,
        sequence: 1,
        correlationId: 'r9-c1',
        causationId: null,
        actor: { type: 'SYSTEM_JOB', id: null },
        occurredAt: new Date(row.occurred_at).toISOString(),
        payload: row.payload,
      } as unknown as DomainEvent;
      await ctx.container.uow.run(tenantA, (tx) => consumer.handle(event, tx as never));
      for (const one of queued) {
        out.push({
          key: one.templateKey,
          text: renderTemplateBody(
            templateDefinition(one.templateKey),
            CATALOGUE_FA[one.templateKey as never],
            one.values,
            'fa',
            DEFAULT_TEMPLATE_PRESENTATION,
          ),
        });
      }
    }
    return out;
  }

  /** Every NEW message (not an edit) the bot sent this customer. */
  const newMessages = () =>
    telegram.sent.filter(
      (one) => one['sentMessageId'] !== undefined && String(one['chat_id']) === MARYAM,
    );

  it('R9 C1 underpay: told in a NEW message even when no message shows the invoice any more, with the remainder, the card and the receipt button; asked once', async () => {
    const { paymentId } = await cardOnScreen();
    // The customer moved on (the main menu, another invoice): no wizard shows this invoice.
    await ctx.container.database.db.execute(
      sql`UPDATE telegram_wizards SET step = 'CLOSED' WHERE payment_id = ${paymentId}`,
    );
    const before = newMessages().length;
    firstInvoice().status = 'processing';
    fake.underpay(firstInvoice().invoiceId, 12_000);
    await inquireNow();
    const sent = newMessages().slice(before);
    expect(sent).toHaveLength(1);
    const text = String(sent[0]!['text']);
    expect(text).toContain('کمتر از مبلغ فاکتور بود');
    expect(text).toContain('6219861012345678');
    expect(text).toContain('۱۲۰٬۰۰۰ ریال');
    expect(markupOf(sent[0])).toContain(`gr:${paymentId}`);
    // The provider says the same again (a second inquiry, a second replica): never asked twice.
    await inquireNow();
    await inquireNow();
    expect(newMessages().slice(before)).toHaveLength(1);
    expect((await attention(paymentId)).map((one) => one.payload.reason)).toEqual(['UNDERPAID']);
    // The new message IS the invoice screen: its remainder-receipt button works.
    const prompt = await tapOn(Number(sent[0]!['sentMessageId']), `gr:${paymentId}`);
    expect(prompt.replyKey).toBe('bot.payment.gateway_receipt_prompt');
    // Never a partial credit.
    expect((await paymentOf(paymentId)).state).toBe('PENDING');
    expect(await walletEntries(paymentId)).toEqual([]);
  });

  it('R9 C1: the old invoice message loses its buttons when the next step goes out as a new one', async () => {
    const { message } = await cardOnScreen();
    const cleared = () =>
      telegram.requests.filter(
        (one) =>
          one.url.includes('/editMessageReplyMarkup') &&
          (JSON.parse(one.raw) as Record<string, unknown>)['message_id'] === message,
      ).length;
    expect(cleared()).toBe(0);
    fake.overpay(firstInvoice().invoiceId, 15_000);
    await inquireNow();
    expect(cleared()).toBe(1);
    expect(String(lastOn(nextStepMessage())?.['text'])).toContain('بیشتر از مبلغ فاکتور');
  });

  it('R9 C1: the operations log gets «پرداخت ناقص — منتظر مابقی» and «پرداخت بیش از مبلغ — منتظر کارت بازگشت», once each, and nothing is credited', async () => {
    const less = await cardOnScreen();
    fake.underpay(firstInvoice().invoiceId, 12_000);
    await inquireNow();
    await inquireNow();
    const [underpaid, ...noMore] = await opsMessages(less.paymentId);
    expect(noMore).toEqual([]);
    expect(underpaid!.key).toBe('ops.financial.payment_underpaid');
    expect(underpaid!.text.startsWith('⚠️ پرداخت ناقص — منتظر مابقی')).toBe(true);
    expect(underpaid!.text).toContain('۱۲۰۰۰ تومان');
    expect(underpaid!.text).toContain('TP-REM123XYZ0');
    expect(underpaid!.text).not.toContain('ناموفق');

    await ctx.reset();
    await beforeEachAgain();
    const more = await cardOnScreen();
    fake.overpay(firstInvoice().invoiceId, 15_000);
    await inquireNow();
    const [overpaid] = await opsMessages(more.paymentId);
    expect(overpaid!.key).toBe('ops.financial.payment_overpaid');
    expect(overpaid!.text.startsWith('⚠️ پرداخت بیش از مبلغ — منتظر کارت بازگشت')).toBe(true);
    expect(overpaid!.text).toContain('۱۵۰۰۰ تومان');
    expect((await paymentOf(more.paymentId)).state).toBe('PENDING');
    expect(await walletEntries(more.paymentId)).toEqual([]);
  });

  it('R9 C1: a NEW remainder invoice (the remainder fell short too) is a new ask — a new message and a new log line', async () => {
    const { paymentId } = await cardOnScreen();
    fake.underpay(firstInvoice().invoiceId, 12_000);
    await inquireNow();
    const first = newMessages().length;
    firstInvoice().remainingInvoiceId = 'TP-REM2NDXYZ';
    firstInvoice().remainingAmount = 3_000;
    await inquireNow();
    expect(newMessages().length).toBe(first + 1);
    expect(String(newMessages().at(-1)!['text'])).toContain('۳۰٬۰۰۰ ریال'); // 3,000 Toman
    expect((await attention(paymentId)).map((one) => one.payload.reason)).toEqual([
      'UNDERPAID',
      'UNDERPAID',
    ]);
  });

  it('R9 C1: a blocked customer is not sent a new message; the invoice message is edited as before', async () => {
    const { paymentId, message } = await cardOnScreen();
    await ctx.container.database.db.execute(
      sql`UPDATE customers SET status = 'BLOCKED', blocked_at = now() WHERE id = ${maryam}`,
    );
    const before = newMessages().length;
    fake.underpay(firstInvoice().invoiceId, 12_000);
    await inquireNow();
    expect(newMessages().length).toBe(before);
    expect(String(lastOn(message)?.['text'])).toContain('کمتر از مبلغ فاکتور بود');
    // The operator still hears of it.
    expect((await attention(paymentId)).map((one) => one.payload.reason)).toEqual(['UNDERPAID']);
  });

  it('R9 C1 webhook: credit_amount is never credited; one that matches nothing raises ONE alert per figure; a repeated delivery and the same status twice change nothing', async () => {
    const attempt = await topupIn(100_000n);
    await lane.runOnce(tenantA);
    const [invoice] = await rows<{ provider_invoice_id: string; provider_order_id: string }>(
      sql`SELECT provider_invoice_id, provider_order_id FROM gateway_invoices WHERE payment_id = ${attempt.payment.id}`,
    );
    const hook = (deliveryId: string, credit: number, status = 'processing') =>
      lane.receiveWebhook(
        String(tenantA.tenantId),
        'TONPAYS_TELEGRAM',
        {
          invoice_id: invoice!.provider_invoice_id,
          order_id: invoice!.provider_order_id,
          credit_amount: credit,
          status,
          paid: false,
          delivery_id: deliveryId,
        },
        deliveryId,
      );
    // The principal itself: nothing to say.
    await hook('wh-1', 100_000);
    expect(await attention(attempt.payment.id)).toEqual([]);
    // A figure that is neither the principal nor what was invoiced: one alert.
    await hook('wh-2', 99_000);
    expect(await hook('wh-2', 99_000)).toBe('DUPLICATE');
    await hook('wh-3', 99_000);
    expect((await attention(attempt.payment.id)).map((one) => one.payload.reason)).toEqual([
      'CREDIT_AMOUNT_MISMATCH',
    ]);
    const [alert] = await opsMessages(attempt.payment.id);
    expect(alert!.key).toBe('ops.financial.credit_amount_mismatch');
    expect(alert!.text).toContain('۹۹۰۰۰ تومان');
    expect(alert!.text).toContain('۱۰۰۰۰۰ تومان');
    // The payment history shows the figure and the flag.
    const view = await ctx.container.paymentTimeline.timeline(tenantA, owner, attempt.payment.id);
    expect(view.entries.find((entry) => entry.kind === 'GATEWAY_WEBHOOK_HINT')).toMatchObject({
      creditAmount: '99000',
      providerUnit: 'IRT',
      creditAmountDiffers: true,
    });
    // Nothing settles on a webhook; the inquiry's completed + paid credits the PRINCIPAL.
    expect((await paymentOf(attempt.payment.id)).state).toBe('PENDING');
    const fakeInvoice = fake.invoices.get(invoice!.provider_invoice_id)!;
    fakeInvoice.status = 'completed';
    fakeInvoice.paid = true;
    await hook('wh-4', 99_000, 'completed');
    await inquireNow();
    expect((await paymentOf(attempt.payment.id)).state).toBe('CONFIRMED');
    expect(await walletEntries(attempt.payment.id)).toEqual([
      { reason: 'TOPUP_GATEWAY', amount: '100000' },
    ]);
  });

  it('R9 C1 webhook: two deliveries carrying the same new credit_amount at once raise ONE alert; the provider’s own final amount raises none', async () => {
    const attempt = await topupIn(100_000n);
    await lane.runOnce(tenantA);
    const [invoice] = await rows<{ provider_invoice_id: string; provider_order_id: string }>(
      sql`SELECT provider_invoice_id, provider_order_id FROM gateway_invoices WHERE payment_id = ${attempt.payment.id}`,
    );
    const hook = (deliveryId: string, credit: number) =>
      lane.receiveWebhook(
        String(tenantA.tenantId),
        'TONPAYS_TELEGRAM',
        {
          invoice_id: invoice!.provider_invoice_id,
          order_id: invoice!.provider_order_id,
          credit_amount: credit,
          status: 'processing',
          paid: false,
          delivery_id: deliveryId,
        },
        deliveryId,
      );
    // The figure TonPays itself asked the customer to transfer (request + its unique tail).
    const fakeInvoice = fake.invoices.get(invoice!.provider_invoice_id)!;
    await inquireNow();
    await hook('same-0', fakeInvoice.finalAmount);
    expect(await attention(attempt.payment.id)).toEqual([]);
    await Promise.all([hook('same-1', 77_000), hook('same-2', 77_000), hook('same-3', 77_000)]);
    expect((await attention(attempt.payment.id)).map((one) => one.payload.reason)).toEqual([
      'CREDIT_AMOUNT_MISMATCH',
    ]);
  });

  it('R9 C1: a tenant stopped between the provider’s answer and its recording raises nothing (the check is inside the transaction)', async () => {
    const { paymentId } = await cardOnScreen();
    fake.underpay(firstInvoice().invoiceId, 12_000);
    const asked = fake.checks.length;
    let stopped = false;
    const racing = telegramLaneWith(ctx, fake, {
      invoiceScreens: ctx.container.wizardScreens,
      providerRequests: true,
      paymentRecords: (real) => {
        const read = real.findById.bind(real);
        real.findById = async (scope, id, tx) => {
          const seen = await read(scope, id, tx);
          // The re-read right after TonPays answered: the operator stops the tenant now.
          if (!stopped && id === paymentId && fake.checks.length > asked) {
            stopped = true;
            await ctx.container.database.db.execute(
              sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
            );
          }
          return seen;
        };
        return real;
      },
    });
    const before = newMessages().length;
    await ctx.container.database.db.execute(
      sql`UPDATE gateway_invoices SET next_inquiry_at = now() - interval '1 second', inquiry_claimed_until = NULL
           WHERE payment_id = ${paymentId}`,
    );
    await racing.runOnce(tenantA);
    expect(stopped).toBe(true);
    expect(await attention(paymentId)).toEqual([]);
    expect(newMessages().length).toBe(before);
  });

  it('R9 C1 race: the provider approves while the customer’s cancel waits — the inquiry settles it and the cancel is never sent', async () => {
    const { paymentId, message } = await cardOnScreen();
    await tapOn(message, `gq:${paymentId}`);
    await tapOn(message, `gz:${paymentId}`);
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([{ state: 'REQUESTED' }]);
    // The customer had paid; the provider's webhook says so, and its inquiry agrees.
    firstInvoice().status = 'completed';
    firstInvoice().paid = true;
    const [invoice] = await rows<{ provider_order_id: string }>(
      sql`SELECT provider_order_id FROM gateway_invoices WHERE payment_id = ${paymentId}`,
    );
    await lane.receiveWebhook(
      String(tenantA.tenantId),
      'TONPAYS_TELEGRAM',
      {
        invoice_id: firstInvoice().invoiceId,
        order_id: invoice!.provider_order_id,
        status: 'completed',
        paid: true,
        delivery_id: 'race-1',
      },
      'race-1',
    );
    await inquireNow();
    expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
    expect(fake.cancels).toHaveLength(0);
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([
      { state: 'REFUSED', error_code: 'nexa.attempt_closed' },
    ]);
  });

  it('R9 C1 race: the cancel is applied first — a late "completed" webhook settles nothing, the inquiry reads canceled', async () => {
    const { paymentId, message } = await cardOnScreen();
    await tapOn(message, `gq:${paymentId}`);
    await tapOn(message, `gz:${paymentId}`);
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(1);
    expect((await paymentOf(paymentId)).state).toBe('FAILED');
    const [invoice] = await rows<{ provider_order_id: string }>(
      sql`SELECT provider_order_id FROM gateway_invoices WHERE payment_id = ${paymentId}`,
    );
    // A stale or forged "completed" hint: it only brings an inquiry forward.
    await lane.receiveWebhook(
      String(tenantA.tenantId),
      'TONPAYS_TELEGRAM',
      {
        invoice_id: firstInvoice().invoiceId,
        order_id: invoice!.provider_order_id,
        status: 'completed',
        paid: true,
        delivery_id: 'race-2',
      },
      'race-2',
    );
    await inquireNow();
    expect(firstInvoice().status).toBe('canceled');
    expect((await paymentOf(paymentId)).state).toBe('FAILED');
    expect(await walletEntries(paymentId)).toEqual([]);
  });

  it('R9 C1 expiry: Nexa expiring a pending attempt asks the provider to cancel its invoice ONCE, through the lane, and fails nothing', async () => {
    const attempt = await topupIn(100_000n);
    await lane.runOnce(tenantA);
    expect(firstInvoice().status).toBe('pending');
    clock.shift(71 * 60_000);
    await ctx.container.paymentExpirySweep.runOnce(tenantA);
    expect((await paymentOf(attempt.payment.id)).state).toBe('EXPIRED');
    expect(await requests(attempt.payment.id, 'CANCEL')).toMatchObject([{ state: 'REQUESTED' }]);
    // Written by the sweep, sent by the worker — never while the sweep holds its transaction.
    expect(fake.cancels).toHaveLength(0);
    await ctx.container.paymentExpirySweep.runOnce(tenantA);
    expect(await requests(attempt.payment.id, 'CANCEL')).toHaveLength(1);
    await lane.runOnce(tenantA);
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(1);
    expect(fake.cancels[0]!.url).toBe(
      `https://tonpays.online/api/custom/v1/invoices/${firstInvoice().invoiceId}/cancel`,
    );
    expect(await requests(attempt.payment.id, 'CANCEL')).toMatchObject([{ state: 'APPLIED' }]);
    expect(firstInvoice().status).toBe('canceled');
    // Already EXPIRED (and the customer told so by the expiry): nothing is failed on top.
    expect((await paymentOf(attempt.payment.id)).state).toBe('EXPIRED');
    expect(
      await rows(sql`SELECT id FROM customer_notifications WHERE kind = 'GATEWAY_PAYMENT_FAILED'`),
    ).toEqual([]);
    // The audit says Nexa asked, because of the expiry.
    const [audit] = await rows<{ after: { reason: string } }>(
      sql`SELECT after FROM audit_logs WHERE action = 'gateway_invoice.cancel_requested'
           AND entity_id = ${attempt.payment.id}`,
    );
    expect(audit?.after.reason).toBe('NEXA_EXPIRY');
  });

  it('R9 C1 expiry: never a cancel for a create whose answer was lost, nor for an invoice the inquiry saw paid or in progress', async () => {
    const cases: [string, (paymentId: string) => Promise<void>][] = [
      // A create whose answer was lost: UNKNOWN, never cancelled (nor retried).
      ['create unknown', async () => undefined],
      // The inquiry last saw it paid (the approval is the settlement path's to decide).
      [
        'paid',
        async (paymentId) => {
          firstInvoice().status = 'completed';
          firstInvoice().paid = true;
          await ctx.container.database.db.execute(
            sql`UPDATE gateway_invoices SET provider_status = 'completed', provider_paid = true
                 WHERE payment_id = ${paymentId}`,
          );
        },
      ],
      // The inquiry last saw a receipt being checked.
      [
        'processing',
        async (paymentId) => {
          firstInvoice().status = 'processing';
          await ctx.container.database.db.execute(
            sql`UPDATE gateway_invoices SET provider_status = 'processing' WHERE payment_id = ${paymentId}`,
          );
        },
      ],
    ];
    for (const [label, stage] of cases) {
      await ctx.reset();
      await beforeEachAgain();
      if (label === 'create unknown') fake.createMode = 'TIMEOUT';
      const attempt = await topupIn(100_000n);
      await lane.runOnce(tenantA);
      fake.createMode = 'OK';
      await stage(attempt.payment.id);
      clock.shift(71 * 60_000);
      await ctx.container.paymentExpirySweep.runOnce(tenantA);
      expect((await paymentOf(attempt.payment.id)).state, label).toBe('EXPIRED');
      expect(await requests(attempt.payment.id, 'CANCEL'), label).toEqual([]);
      await lane.runOnce(tenantA);
      expect(fake.cancels, label).toHaveLength(0);
    }
  });

  it('R9 C1 expiry: the send re-checks the invoice — one the inquiry saw move on since the expiry is refused, never sent', async () => {
    const attempt = await topupIn(100_000n);
    await lane.runOnce(tenantA);
    clock.shift(71 * 60_000);
    await ctx.container.paymentExpirySweep.runOnce(tenantA);
    expect(await requests(attempt.payment.id, 'CANCEL')).toMatchObject([{ state: 'REQUESTED' }]);
    // Between the sweep and the worker, a late inquiry saw the customer's receipt arrive.
    firstInvoice().status = 'processing';
    await ctx.container.database.db.execute(
      sql`UPDATE gateway_invoices SET provider_status = 'processing' WHERE payment_id = ${attempt.payment.id}`,
    );
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(0);
    expect(await requests(attempt.payment.id, 'CANCEL')).toMatchObject([
      { state: 'REFUSED', error_code: 'nexa.not_pending' },
    ]);
  });

  // ------------------------------------------------------------------------------------
  // R11 A8 (owner bug): a cancel whose answer was lost may be asked again
  // ------------------------------------------------------------------------------------

  /** The cancel's answer is lost (a timeout): one call, one UNKNOWN row. */
  const lostCancel = async (paymentId: string, message: number) => {
    fake.cancelMode = 'TIMEOUT';
    await tapOn(message, `gq:${paymentId}`);
    await tapOn(message, `gz:${paymentId}`);
    await lane.runOnce(tenantA);
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([{ state: 'UNKNOWN' }]);
    expect(fake.cancels).toHaveLength(1);
    fake.cancelMode = 'OK';
  };
  /** The spacing a retry waits for (`CANCEL_RETRY_BACKOFF_SECONDS`), and a little more. */
  const pastRetrySpacing = () => clock.shift(31_000);
  const UNKNOWN_PHRASE = 'پاسخ تون‌پی به درخواست لغو دریافت نشد';
  // R12 F3 item 10: a rate-limited cancel is a KNOWN "not processed", told apart from a lost answer.
  const RATE_LIMITED_PHRASE = 'درخواست لغو فاکتور فعلاً توسط تون‌پی پذیرفته نشد';

  it('R11 A8: a lost cancel keeps «❌ لغو فاکتور» on its notice and on the invoice; the retry is a NEW row, held for the spacing, sent ONCE, and cancels', async () => {
    const { paymentId, message } = await cardOnScreen();
    await lostCancel(paymentId, message);
    // The notice the worker edits in: the lost answer, and the button to ask again.
    expect(String(lastOn(message)?.['text'])).toContain(UNKNOWN_PHRASE);
    expect(markupOf(lastOn(message))).toContain(`gq:${paymentId}`);
    // The provider still says pending: the owner's screen — copy amount, copy card AND cancel.
    await inquireNow();
    await tapOn(message, `gc:${paymentId}`);
    expect(String(lastOn(message)?.['text'])).not.toContain(UNKNOWN_PHRASE);
    expect(markupOf(lastOn(message))).toContain('copy_text');
    expect(markupOf(lastOn(message))).toContain(`gq:${paymentId}`);
    expect((await paymentOf(paymentId)).state).toBe('PENDING');

    expect((await tapOn(message, `gq:${paymentId}`)).replyKey).toBe(
      'bot.payment.gateway_cancel_confirm',
    );
    await tapOn(message, `gz:${paymentId}`);
    expect(String(lastOn(message)?.['text'])).toContain('درخواست لغو');
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([
      { state: 'UNKNOWN' },
      { state: 'REQUESTED' },
    ]);
    // Within the spacing from the lost answer the worker leaves it.
    const [held] = await rows<{ claimed_until: string | null }>(
      sql`SELECT claimed_until FROM gateway_provider_requests
           WHERE payment_id = ${paymentId} AND state = 'REQUESTED'`,
    );
    expect(held!.claimed_until).not.toBeNull();
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(1);
    pastRetrySpacing();
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(2);
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([
      { state: 'UNKNOWN' },
      { state: 'APPLIED' },
    ]);
    expect((await paymentOf(paymentId)).state).toBe('FAILED');
    expect(String(lastOn(message)?.['text'])).toContain('فاکتور لغو شد');
    expect(await walletEntries(paymentId)).toEqual([]);
    // The retry's audit row names the lost cancel it follows.
    const audits = await rows<{ after: { retryOf: string | null } }>(
      sql`SELECT after FROM audit_logs WHERE action = 'gateway_invoice.cancel_requested'
           AND entity_id = ${paymentId} ORDER BY occurred_at`,
    );
    expect(audits).toHaveLength(2);
    expect(audits[0]!.after.retryOf).toBeNull();
    expect(audits[1]!.after.retryOf).not.toBeNull();

    /*
     * A cancel button still on another message (one the worker did not edit — the tapped
     * message itself is now a notice, whose old keyboard is stale and swallowed):
     * «فاکتور قبلاً لغو شده», and nothing is sent.
     */
    const older = await tapOn(null, `gq:${paymentId}`);
    expect(older.replyKey).toBe('bot.payment.gateway_cancel_already_cancelled');
    expect((await tapOn(null, `gz:${paymentId}`)).replyKey).toBe(
      'bot.payment.gateway_cancel_already_cancelled',
    );
    expect(String(lastOn(updateSeq)?.['text'])).toContain('فاکتور قبلاً لغو شده');
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(2);
    expect(await requests(paymentId, 'CANCEL')).toHaveLength(2);
  });

  it('R11 A8: a cancel TonPays rate-limited (429 RATE_LIMIT_EXCEEDED) says not-cancelled-yet (R12 F3 item 10, not "lost"), keeps the button, and the retry cancels', async () => {
    const { paymentId, message } = await cardOnScreen();
    fake.cancelMode = { code: 'RATE_LIMIT_EXCEEDED', status: 429 };
    await tapOn(message, `gq:${paymentId}`);
    await tapOn(message, `gz:${paymentId}`);
    await lane.runOnce(tenantA);
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([
      { state: 'RATE_LIMITED', error_code: 'RATE_LIMIT_EXCEEDED' },
    ]);
    expect(String(lastOn(message)?.['text'])).toContain(RATE_LIMITED_PHRASE);
    expect(String(lastOn(message)?.['text'])).not.toContain(UNKNOWN_PHRASE);
    expect(markupOf(lastOn(message))).toContain(`gq:${paymentId}`);
    fake.cancelMode = 'OK';
    await tapOn(message, `gq:${paymentId}`);
    await tapOn(message, `gz:${paymentId}`);
    // Spaced from the rate-limited one like a retry after a lost answer.
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(1);
    pastRetrySpacing();
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(2);
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([
      { state: 'RATE_LIMITED' },
      { state: 'APPLIED' },
    ]);
    expect((await paymentOf(paymentId)).state).toBe('FAILED');
  });

  it("R11 A8: a retry the TonPays client HELD (the key paused by the 429's Retry-After) is not spent — it waits as asked and is sent ONCE when the key may be used", async () => {
    const { paymentId, message } = await cardOnScreen();
    // The production adapters' shared limiter: a 429 pauses the key; a call in the pause is HELD.
    lane = telegramLaneWith(ctx, fake, {
      invoiceScreens: ctx.container.wizardScreens,
      providerRequests: true,
      limiter: new TonPaysRateLimiter({
        clock: ctx.container.clock,
        sleep: () => Promise.resolve(),
        random: () => 0.5,
      }),
    });
    // TonPays: 429 RATE_LIMIT_EXCEEDED, «retry after 120 s» — the key pauses for two minutes.
    fake.cancelMode = { code: 'RATE_LIMIT_EXCEEDED', status: 429, retryAfter: '120' };
    await tapOn(message, `gq:${paymentId}`);
    await tapOn(message, `gz:${paymentId}`);
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(1);
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([{ state: 'RATE_LIMITED' }]);
    fake.cancelMode = 'OK';
    // The customer asks again after Nexa's 30 s spacing, still inside the key's pause.
    pastRetrySpacing();
    await tapOn(message, `gq:${paymentId}`);
    await tapOn(message, `gz:${paymentId}`);
    await lane.runOnce(tenantA);
    // HELD: nothing sent, nothing decided — the request stands as the customer asked it.
    expect(fake.cancels).toHaveLength(1);
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([
      { state: 'RATE_LIMITED' },
      { state: 'REQUESTED', error_code: null },
    ]);
    const [waiting] = await rows<{ sent_at: string | null; claimed_until: string | null }>(
      sql`SELECT sent_at, claimed_until FROM gateway_provider_requests
           WHERE payment_id = ${paymentId} AND state = 'REQUESTED'`,
    );
    expect(waiting!.sent_at).toBeNull();
    // Due when the pause ends, not a pass later and not a whole spacing later.
    const dueIn = new Date(waiting!.claimed_until!).getTime() - clock.now().getTime();
    expect(dueIn).toBeGreaterThan(60_000);
    expect(dueIn).toBeLessThanOrEqual(120_000);
    // It reads "cancelling…" with no cancel button: the customer need not (and cannot) tap again.
    expect(String(lastOn(message)?.['text'])).not.toContain(UNKNOWN_PHRASE);
    expect(String(lastOn(message)?.['text'])).toContain('درخواست لغو');
    expect(markupOf(lastOn(message))).not.toContain(`gq:${paymentId}`);
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(1);
    // The pause over: sent once, applied, the payment closed, no money moved.
    clock.shift(125_000);
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(2);
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([
      { state: 'RATE_LIMITED' },
      { state: 'APPLIED' },
    ]);
    expect((await paymentOf(paymentId)).state).toBe('FAILED');
    expect(await walletEntries(paymentId)).toEqual([]);
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(2);
  });

  it('R11 A8: a HELD retry that would only be due after the customer window is decided rate-limited, so the expiry cancel still follows', async () => {
    const { paymentId, message } = await cardOnScreen();
    lane = telegramLaneWith(ctx, fake, {
      invoiceScreens: ctx.container.wizardScreens,
      providerRequests: true,
      limiter: new TonPaysRateLimiter({
        clock: ctx.container.clock,
        sleep: () => Promise.resolve(),
        random: () => 0.5,
      }),
    });
    // Nexa's deadline in 100 s; TonPays pauses the key for 120 s.
    await ctx.container.database.db.execute(
      sql`UPDATE payments SET expires_at = ${new Date(clock.now().getTime() + 100_000)}
           WHERE id = ${paymentId}`,
    );
    fake.cancelMode = { code: 'RATE_LIMIT_EXCEEDED', status: 429, retryAfter: '120' };
    await tapOn(message, `gq:${paymentId}`);
    await tapOn(message, `gz:${paymentId}`);
    await lane.runOnce(tenantA);
    fake.cancelMode = 'OK';
    pastRetrySpacing();
    await tapOn(message, `gq:${paymentId}`);
    await tapOn(message, `gz:${paymentId}`);
    await lane.runOnce(tenantA);
    // HELD, and the pause outlasts the window: not put back — nothing sent, decided.
    expect(fake.cancels).toHaveLength(1);
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([
      { state: 'RATE_LIMITED', error_code: 'RATE_LIMIT_EXCEEDED' },
      { state: 'RATE_LIMITED', error_code: 'nexa.rate_limited_locally' },
    ]);
    // Nexa's deadline expires the attempt; nothing stands in the way of its own cancel.
    clock.shift(130_000);
    await ctx.container.paymentExpirySweep.runOnce(tenantA);
    expect((await paymentOf(paymentId)).state).toBe('EXPIRED');
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([
      { state: 'RATE_LIMITED' },
      { state: 'RATE_LIMITED' },
      { state: 'REQUESTED' },
    ]);
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(2);
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([
      { state: 'RATE_LIMITED' },
      { state: 'RATE_LIMITED' },
      { state: 'APPLIED' },
    ]);
    expect(await walletEntries(paymentId)).toEqual([]);
  });

  it('R11 A8 (Codex #356): a retry whose spacing would end after the customer window writes no row, so the expiry cancel follows', async () => {
    const { paymentId, message } = await cardOnScreen();
    fake.cancelMode = { code: 'RATE_LIMIT_EXCEEDED', status: 429 };
    await tapOn(message, `gq:${paymentId}`);
    await tapOn(message, `gz:${paymentId}`);
    await lane.runOnce(tenantA);
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([{ state: 'RATE_LIMITED' }]);
    fake.cancelMode = 'OK';
    // Nexa's deadline is 10 s away: the 30 s spacing would end after it.
    await ctx.container.database.db.execute(
      sql`UPDATE payments SET expires_at = ${new Date(clock.now().getTime() + 10_000)}
           WHERE id = ${paymentId}`,
    );
    await tapOn(message, `gq:${paymentId}`);
    await tapOn(message, `gz:${paymentId}`);
    expect(await requests(paymentId, 'CANCEL')).toHaveLength(1);
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(1);
    // At the deadline the expiry cancel is written, and sent once.
    clock.shift(15_000);
    await ctx.container.paymentExpirySweep.runOnce(tenantA);
    expect((await paymentOf(paymentId)).state).toBe('EXPIRED');
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([
      { state: 'RATE_LIMITED' },
      { state: 'REQUESTED' },
    ]);
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(2);
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([
      { state: 'RATE_LIMITED' },
      { state: 'APPLIED' },
    ]);
    expect(firstInvoice().status).toBe('canceled');
    expect(await walletEntries(paymentId)).toEqual([]);
  });

  it('R11 A8: requeueUnsentCancel takes back only the stamp it is given, and only from SENT', async () => {
    const { paymentId, message } = await cardOnScreen();
    await tapOn(message, `gq:${paymentId}`);
    await tapOn(message, `gz:${paymentId}`);
    const repo = new DrizzleGatewayProviderRequestRepository(ctx.container.database.db);
    const [row] = await rows<{ id: string }>(
      sql`SELECT id FROM gateway_provider_requests WHERE payment_id = ${paymentId}`,
    );
    const stamp = new Date(Math.floor(clock.now().getTime() / 1000) * 1000);
    const notBefore = new Date(stamp.getTime() + 90_000);
    // Never sent: there is no stamp to take back.
    expect(await repo.requeueUnsentCancel(tenantA, row!.id, stamp, notBefore, undefined)).toBe(
      false,
    );
    expect(await repo.markSent(tenantA, row!.id, stamp, undefined)).toBe(true);
    // A stamp that is not this one (another send) is never taken back.
    expect(
      await repo.requeueUnsentCancel(
        tenantA,
        row!.id,
        new Date(stamp.getTime() + 1),
        notBefore,
        undefined,
      ),
    ).toBe(false);
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([{ state: 'SENT' }]);
    expect(await repo.requeueUnsentCancel(tenantA, row!.id, stamp, notBefore, undefined)).toBe(
      true,
    );
    const [back] = await rows<{ state: string; sent_at: string | null; claimed_until: string }>(
      sql`SELECT state, sent_at, claimed_until FROM gateway_provider_requests WHERE id = ${row!.id}`,
    );
    expect(back!.state).toBe('REQUESTED');
    expect(back!.sent_at).toBeNull();
    expect(new Date(back!.claimed_until).getTime()).toBe(notBefore.getTime());
    // A decided row is never moved back either.
    expect(await repo.markSent(tenantA, row!.id, stamp, undefined)).toBe(true);
    expect(await repo.decide(tenantA, row!.id, 'UNKNOWN', 'http.timeout', stamp, undefined)).toBe(
      true,
    );
    expect(await repo.requeueUnsentCancel(tenantA, row!.id, stamp, notBefore, undefined)).toBe(
      false,
    );
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([{ state: 'UNKNOWN' }]);
  });

  it('R11 A8: the lost cancel HAD cancelled it — the retry meets NOT_PENDING, the inquiry reads canceled, and the next tap says «فاکتور قبلاً لغو شده»', async () => {
    const { paymentId, message } = await cardOnScreen();
    await lostCancel(paymentId, message);
    // TonPays did cancel it; Nexa does not know yet (the next inquiry is not due).
    firstInvoice().status = 'canceled';
    await ctx.container.database.db.execute(
      sql`UPDATE gateway_invoices SET next_inquiry_at = now() + interval '1 hour'
           WHERE payment_id = ${paymentId}`,
    );
    await tapOn(message, `gq:${paymentId}`);
    await tapOn(message, `gz:${paymentId}`);
    pastRetrySpacing();
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(2);
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([
      { state: 'UNKNOWN' },
      { state: 'REFUSED', error_code: 'NOT_PENDING' },
    ]);
    // A refusal is not an approval and not a cancellation: still open until the inquiry says.
    expect((await paymentOf(paymentId)).state).toBe('PENDING');
    await inquireNow();
    expect((await paymentOf(paymentId)).state).toBe('FAILED');
    expect(await rows(sql`SELECT resolution_note FROM payments WHERE id = ${paymentId}`)).toEqual([
      { resolution_note: 'tonpays_telegram:canceled' },
    ]);
    expect(await walletEntries(paymentId)).toEqual([]);
    // The worker edited the attempt into "cancelled" (the customer asked), not "failed".
    expect(String(lastOn(message)?.['text'])).toContain('فاکتور لغو شد');
    // A cancel button still on another message: «فاکتور قبلاً لغو شده».
    expect((await tapOn(null, `gq:${paymentId}`)).replyKey).toBe(
      'bot.payment.gateway_cancel_already_cancelled',
    );
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(2);
  });

  it('R11 A8: two confirm taps at once after a lost cancel write ONE request and TonPays is asked ONCE more', async () => {
    const { paymentId, message } = await cardOnScreen();
    await lostCancel(paymentId, message);
    // One tap on the invoice and one on another message carrying the button: two turns that
    // the wizard does not merge, so only the payment's lock and the in-flight index decide.
    await Promise.all([tapOn(message, `gz:${paymentId}`), tapOn(null, `gz:${paymentId}`)]);
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([
      { state: 'UNKNOWN' },
      { state: 'REQUESTED' },
    ]);
    pastRetrySpacing();
    await lane.runOnce(tenantA);
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(2);
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([
      { state: 'UNKNOWN' },
      { state: 'APPLIED' },
    ]);
    expect((await paymentOf(paymentId)).state).toBe('FAILED');
    // One effect: the payment failed once.
    expect(
      await rows(
        sql`SELECT id FROM outbox_messages
             WHERE event_type = 'PaymentFailed' AND aggregate_id = ${paymentId}`,
      ),
    ).toHaveLength(1);
  });

  it('R11 A8: after PAID a cancel tap is refused in Persian, nothing is sent and nothing moves', async () => {
    const { paymentId, message } = await cardOnScreen();
    await lostCancel(paymentId, message);
    firstInvoice().status = 'completed';
    firstInvoice().paid = true;
    await inquireNow();
    expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
    const before = await walletEntries(paymentId);
    // A cancel button still on another message (the tapped one now says paid, and is closed).
    for (const data of [`gq:${paymentId}`, `gz:${paymentId}`]) {
      expect((await tapOn(null, data)).replyKey, data).toBe('bot.payment.gateway_not_pending');
      expect(String(lastOn(updateSeq)?.['text']), data).toContain('دیگر در انتظار پرداخت نیست');
    }
    pastRetrySpacing();
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(1);
    expect(await requests(paymentId, 'CANCEL')).toMatchObject([{ state: 'UNKNOWN' }]);
    expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
    expect(await walletEntries(paymentId)).toEqual(before);
  });

  it('R11 A8: a card change whose answer was lost keeps the card change and the cancel; both can be asked again', async () => {
    const { paymentId, message } = await cardOnScreen();
    clock.shift(61_000);
    fake.changeMode = 'TIMEOUT';
    await tapOn(message, `gk:${paymentId}`);
    await lane.runOnce(tenantA);
    fake.changeMode = 'OK';
    await tapOn(message, `gc:${paymentId}`);
    // No card is shown (the change may have happened); the change and the cancel stay.
    expect(markupOf(lastOn(message))).toContain(`gk:${paymentId}`);
    expect(markupOf(lastOn(message))).toContain(`gq:${paymentId}`);
    clock.shift(2 * 61_000);
    await tapOn(message, `gk:${paymentId}`);
    await lane.runOnce(tenantA);
    expect(fake.changes).toHaveLength(2);
    // And the cancel after a lost change, then a lost cancel, still goes through.
    await lostCancel(paymentId, message);
    expect(markupOf(lastOn(message))).toContain(`gq:${paymentId}`);
    await tapOn(message, `gz:${paymentId}`);
    clock.shift(2 * 61_000 + 31_000);
    await lane.runOnce(tenantA);
    expect(fake.cancels).toHaveLength(2);
    expect((await paymentOf(paymentId)).state).toBe('FAILED');
  });

  it('R11 A8 (mini app): a lost cancel leaves the payment open there too — paid in the bot, where the cancel is; the applied retry closes it', async () => {
    const { paymentId, message } = await cardOnScreen();
    await lostCancel(paymentId, message);
    const open = await lane.attemptFor(tenantA, maryam, paymentId);
    expect(open?.payment.state).toBe('PENDING');
    expect(attemptWire(open!)).toMatchObject({
      paysInChat: true,
      invoiceReady: true,
      payUrl: null,
    });
    await tapOn(message, `gz:${paymentId}`);
    pastRetrySpacing();
    await lane.runOnce(tenantA);
    const closed = await lane.attemptFor(tenantA, maryam, paymentId);
    expect(closed?.payment.state).toBe('FAILED');
  });
});
