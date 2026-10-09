import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type ActorContext,
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
 * TonPays Telegram in the bot (`docs/tonpays-telegram-gateway-audit.md` §8): the same
 * payment message, edited in place by the turn and by the worker; «📤 ارسال فیش واریزی»,
 * «🔄 تعویض کارت» and «🔎 بررسی وضعیت»; a photo routed to the provider's window — scoped to
 * the tenant, this bot, this customer, this payment, the provider and its invoice — and never
 * to the manual review queue. The provider is a fake from the owner's transcription.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_A2 = SEED_IDS.botA2 as BotInstanceId;
const MARYAM = '910912';
const REZA = '910913';

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

describe('TonPays Telegram in the bot', () => {
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

  beforeEach(async () => {
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
    telegram.sent.length = 0;
    telegram.files.clear();
    lane = telegramLaneWith(ctx, fake, { invoiceScreens: ctx.container.wizardScreens });
  });

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
    telegram.sent.filter((body) => body['message_id'] === message).at(-1);
  const markupOf = (body: Record<string, unknown> | undefined) =>
    JSON.stringify(body?.['reply_markup'] ?? {});

  it('edits the tapped message into the card invoice with the three actions, and never says paid', async () => {
    const { paymentId, message } = await cardOnScreen();
    const screen = lastOn(message);
    const card = fake.invoices.values().next().value!.cards[0]!;
    expect(String(screen?.['text'])).toContain(card);
    expect(String(screen?.['text'])).toContain('250,000');
    expect(String(screen?.['text'])).not.toContain('تأیید و ثبت شد');
    const markup = markupOf(screen);
    expect(markup).toContain(`gr:${paymentId}`);
    expect(markup).toContain(`gc:${paymentId}`);
    expect(markup).toContain('ارسال فیش واریزی');
    expect(markup).toContain('بررسی وضعیت');
    // The card was just shown: no change is offered inside its sixty seconds.
    expect(markup).not.toContain(`gk:${paymentId}`);
    clock.shift(61_000);
    await tapOn(message, `gc:${paymentId}`);
    const later = markupOf(lastOn(message));
    expect(later).toContain(`gk:${paymentId}`);
    expect(later).toContain('تعویض کارت');
  });

  it('the receipt: gr: asks for a photo as its own message, the photo goes to TonPays, and the worker edits the payment message into the review', async () => {
    const { paymentId, message } = await cardOnScreen();
    const before = telegram.sent.length;
    const prompt = await tapOn(message, `gr:${paymentId}`);
    expect(prompt.replyKey).toBe('bot.payment.gateway_receipt_prompt');
    // Its own message: the payment message still shows the card.
    const promptBody = telegram.sent.slice(before).find((body) => body['message_id'] === undefined);
    expect(String(promptBody?.['text'])).toContain('۵ مگابایت');
    expect(String(lastOn(message)?.['text'])).toContain('شماره کارت');

    const photo = await sendPhoto('ph-1');
    expect(photo.replyKey).toBe('bot.payment.gateway_receipt_queued');
    expect(
      await rows(sql`SELECT id FROM payment_receipts WHERE payment_id = ${paymentId}`),
    ).toEqual([]);
    await lane.runOnce(tenantA);
    expect(fake.receipts).toHaveLength(1);
    const review = lastOn(message);
    expect(String(review?.['text'])).toContain('در حال بررسی');
    expect(markupOf(review)).not.toContain('gr:');
    expect(markupOf(review)).not.toContain('gk:');
  });

  it('FIX-02: a photo after the receipt window’s deadline is answered closed WITH the payment’s code', async () => {
    const { paymentId, message } = await cardOnScreen();
    const [stored] = await rows<{ reference: string }>(
      sql`SELECT reference FROM payments WHERE id = ${paymentId}`,
    );
    const code = stored!.reference.split(':')[0]!;
    // The card invoice already carries it, before anything is paid.
    expect(String(lastOn(message)?.['text'])).toContain(`کد پیگیری پرداخت: ${code}`);
    await tapOn(message, `gr:${paymentId}`);
    // The window's own deadline passes before the photo arrives.
    await ctx.container.database.db.execute(
      sql`UPDATE gateway_receipt_captures SET opened_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'
           WHERE payment_id = ${paymentId}`,
    );
    const before = telegram.sent.length;
    const late = await sendPhoto('ph-late');
    expect(late.replyKey).toBe('bot.payment.gateway_closed');
    const answer = telegram.sent.slice(before).at(-1);
    expect(String(answer?.['text'])).toContain(`کد پیگیری پرداخت: ${code}`);
    expect(String(answer?.['text'])).not.toContain(stored!.reference);
  });

  it('the card change: gk: redraws the message as "changing", and the worker edits the new card in', async () => {
    const { paymentId, message } = await cardOnScreen();
    clock.shift(61_000);
    const first = fake.invoices.values().next().value!.cards[0]!;
    await tapOn(message, `gk:${paymentId}`);
    expect(String(lastOn(message)?.['text'])).toContain('کارت جدید');
    await lane.runOnce(tenantA);
    const cards = fake.invoices.values().next().value!.cards;
    expect(cards).toHaveLength(2);
    const text = String(lastOn(message)?.['text']);
    expect(text).toContain(cards[1]!);
    expect(text).not.toContain(first);
  });

  /** The tenant's second bot, running: a customer may talk to both. */
  const runSecondBot = () =>
    ctx.container.database.db.execute(
      sql`UPDATE bot_instances SET status = 'ACTIVE' WHERE id = ${BOT_A2}`,
    );

  it('TPTG-19: gr:/gk: for another customer’s payment, another bot’s, or a payment no longer pending change nothing and answer closed', async () => {
    const { paymentId, message } = await cardOnScreen();
    await runSecondBot();
    await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('resolve-reza'), {
      idempotencyKey: 'resolve-reza',
      telegramUserId: REZA,
      from: { id: Number(REZA), first_name: 'رضا' },
      botInstanceId: BOT_A,
    });
    clock.shift(61_000);
    for (const data of [`gr:${paymentId}`, `gk:${paymentId}`]) {
      expect((await tapOn(null, data, REZA)).replyKey, data).toBe('bot.payment.gateway_closed');
      expect((await tapOn(null, data, MARYAM, BOT_A2)).replyKey, data).toBe(
        'bot.payment.gateway_closed',
      );
    }
    expect(await rows(sql`SELECT id FROM gateway_receipt_captures`)).toEqual([]);
    expect(await rows(sql`SELECT id FROM gateway_card_changes`)).toEqual([]);

    await ctx.container.payments.failGatewayPayment(tenantA, systemActor(key()), paymentId, {
      reasonCode: 'tonpays_telegram:rejected',
      notifyCustomer: false,
    });
    // The first tap redraws the payment message as closed; a second one on it is stale.
    expect((await tapOn(message, `gr:${paymentId}`)).replyKey).toBe('bot.payment.gateway_closed');
    expect((await tapOn(message, `gk:${paymentId}`)).replyKey).toBeNull();
    expect((await tapOn(null, `gk:${paymentId}`)).replyKey).toBe('bot.payment.gateway_closed');
    expect(await rows(sql`SELECT id FROM gateway_receipt_captures`)).toEqual([]);
    expect(await rows(sql`SELECT id FROM gateway_card_changes`)).toEqual([]);
  });

  it('TPTG-07 (in the bot): with a window open in bot A, a photo sent to bot B goes to the manual flow there, never to this payment', async () => {
    const { paymentId, message } = await cardOnScreen();
    await runSecondBot();
    await tapOn(message, `gr:${paymentId}`);
    const reply = await sendPhoto('ph-other-bot', MARYAM, BOT_A2);
    expect(reply.replyKey).not.toBe('bot.payment.gateway_receipt_queued');
    expect(
      await rows(sql`SELECT id FROM gateway_receipt_submissions WHERE payment_id = ${paymentId}`),
    ).toEqual([]);
  });

  it('a photo with no provider window open is the manual flow’s, exactly as before', async () => {
    const reply = await sendPhoto('ph-none');
    expect(reply.replyKey).not.toBe('bot.payment.gateway_receipt_queued');
    expect(await rows(sql`SELECT id FROM gateway_receipt_submissions`)).toEqual([]);
  });
});
