import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { CATALOGUE_FA, formatMoney } from '@nexa/i18n';
import { appearanceFallbackText as plain } from '../../apps/api/src/modules/commerce/messaging/application/appearance-render';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleCustomerNotificationRepository } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-customer-notification.repository';
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

/**
 * R11 A11 (owner request: order-expiry edit-in-place). When an unpaid order ENDS — its window
 * closes, or the customer cancels it — Nexa EDITS the order's own payment message into the
 * ended screen: the order summary stays (code, product, amount); the card number, the copy
 * buttons and the pay/receipt buttons go; «🔁 سفارش دوباره» and «🏠 منوی اصلی» appear; and no
 * "no money was taken" line. A new message only when that message cannot be edited (deleted,
 * too old) or is not known (an order started in the mini app) — and then ONCE per order.
 *
 * The owner's real case was three expiry messages minutes apart (11:09, 11:11, 11:16). The
 * one-order-many-notices path behind it was a `PAYMENT_EXPIRED` per payment ATTEMPT (a gateway
 * attempt's lifetime runs from its own creation, so an order's attempts lapse at different
 * minutes), and a new `bot.order.expired` message per tap on a stale pay button. Both are
 * pinned here.
 *
 * A socket stands in for Telegram and answers every send with a NEW message id.
 */
const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const CATEGORY_A = SEED_IDS.categoryA;
const MARYAM = '920920';

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

interface Call {
  readonly method: string;
  readonly body: Record<string, unknown>;
  readonly sentId: number | null;
}

interface WireButton {
  readonly text?: string;
  readonly callback_data?: string;
  readonly url?: string;
  readonly copy_text?: unknown;
}

describe('an ended order is answered ON its own payment message (R11 A11)', () => {
  let ctx: TestContext;
  let telegram: Server;
  let calls: Call[];
  let nextMessageId = 500;
  let panel: FakeMarzban;
  let products: DrizzleProductRepository;
  let panelId: string;
  let maryam: UserId;
  let owner: ActorContext;
  let updateSeq = 0;
  /** Messages Telegram will no longer edit (deleted, too old): a 400 on edit. */
  const uneditable = new Set<number>();

  beforeAll(async () => {
    calls = [];
    telegram = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          body = {};
        }
        const method = (request.url ?? '').split('/').pop() ?? '';
        if (method === 'editMessageText' && uneditable.has(Number(body['message_id']))) {
          calls.push({ method, body, sentId: null });
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: 'Bad Request: message to edit not found',
            }),
          );
          return;
        }
        const sends =
          method === 'sendMessage' || method === 'sendPhoto' || method === 'sendDocument';
        const sentId = sends ? (nextMessageId += 1) : null;
        calls.push({ method, body, sentId });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ ok: true, result: sentId === null ? true : { message_id: sentId } }),
        );
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  afterEach(async () => {
    await panel?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(ctx.container.database.db);
    calls = [];
    uneditable.clear();
    cardNumber = null;
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-a11', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-a11-create',
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
  });

  // -------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------

  async function product(key: string): Promise<ProductId> {
    const row = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: `پلن ${key}`,
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: CATEGORY_A as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, row.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return row.id;
  }

  async function fund(amountMinor: bigint, key: string): Promise<void> {
    await ctx.container.wallet.adjust(tenantA, owner, maryam, {
      idempotencyKey: `${key}-credit`,
      direction: 'CREDIT',
      amountMinor,
      currency: 'IRT',
      note: 'fixture',
    });
  }

  function update(payload: Record<string, unknown>) {
    updateSeq += 1;
    return {
      idempotencyKey: `a11-update-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      update: { update_id: updateSeq, ...payload },
      telegramUserId: MARYAM,
      from: { id: Number(MARYAM), first_name: 'مریم' },
    };
  }

  function tapOn(messageId: number, data: string) {
    calls = [];
    return ctx.container.botRuntime.handle(
      tenantA,
      systemActor('bot'),
      update({
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(MARYAM), is_bot: false, first_name: 'مریم' },
          data,
          message: {
            message_id: messageId,
            date: 0,
            chat: { id: Number(MARYAM), type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      }),
    );
  }

  const methods = () => calls.map((call) => call.method);
  const editsOf = (messageId: number) =>
    calls.filter(
      (call) => call.method === 'editMessageText' && call.body['message_id'] === messageId,
    );
  const keyboardOf = (call: Call | undefined): WireButton[] =>
    (
      (call?.body['reply_markup'] as { inline_keyboard?: WireButton[][] } | undefined)
        ?.inline_keyboard ?? []
    ).flat();
  const dataOf = (call: Call | undefined): string[] =>
    keyboardOf(call)
      .map((button) => button.callback_data ?? '')
      .filter((data) => data !== '');
  const textOf = (call: Call | undefined): string => String(call?.body['text'] ?? '');

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await ctx.container.database.db.execute(query)).rows as T[];
  }
  const orderOf = async (orderId: string) =>
    (
      await rows<{ state: string; code: string | null }>(
        sql`SELECT state, code FROM orders WHERE id = ${orderId}`,
      )
    )[0];
  const ordersOfMaryam = () =>
    rows<{ id: string }>(
      sql`SELECT id FROM orders WHERE tenant_id = ${tenantA.tenantId} AND customer_id = ${maryam}`,
    );
  const notices = () =>
    rows<{ kind: string; subject_id: string; state: string }>(
      sql`SELECT kind, subject_id, state FROM customer_notifications
           WHERE tenant_id = ${tenantA.tenantId} AND customer_id = ${maryam}
           ORDER BY created_at, kind`,
    );

  /** Another writer is done with the order's screens: past the settle window, and due. */
  async function settle(): Promise<void> {
    await ctx.container.database.db.execute(sql`
      UPDATE telegram_wizards SET updated_at = updated_at - interval '1 hour', busy_until = NULL
       WHERE tenant_id = ${tenantA.tenantId}`);
    await ctx.container.database.db.execute(sql`
      UPDATE customer_notifications SET next_attempt_at = now() - interval '1 second'
       WHERE tenant_id = ${tenantA.tenantId} AND state = 'PENDING'`);
  }

  /** The order's and its payments' deadlines, both in the past. */
  async function lapse(orderId: string): Promise<void> {
    await ctx.container.database.db.execute(
      sql`UPDATE payments SET expires_at = now() - interval '1 hour' WHERE order_id = ${orderId}` as never,
    );
    await ctx.container.database.db.execute(
      sql`UPDATE orders SET expires_at = now() - interval '1 hour' WHERE id = ${orderId}` as never,
    );
  }

  async function deliver(): Promise<void> {
    await settle();
    calls = [];
    await ctx.container.customerNotificationLoop.tick();
  }

  /**
   * The purchase wizard up to its pre-invoice, on ONE message (`messageId`): category →
   * product → the automatic name. Returns the DRAFT's id.
   */
  async function preinvoiceOn(messageId: number, key: string): Promise<string> {
    const productId = await product(key);
    await tapOn(messageId, `ck:${CATEGORY_A}.0`);
    await tapOn(messageId, `p:${productId}`);
    const [draft] = await ordersOfMaryam();
    if (draft === undefined) throw new Error('no draft');
    const step = dataOf(editsOf(messageId)[0]);
    if (step.includes(`Z:${draft.id}`)) await tapOn(messageId, `Z:${draft.id}`);
    expect(dataOf(editsOf(messageId)[0])).toContain(`w:${draft.id}`);
    return draft.id;
  }

  /** …then the card-to-card invoice on that same message: card number, copy and pay buttons. */
  async function cardInvoiceOn(messageId: number, key: string): Promise<string> {
    const orderId = await preinvoiceOn(messageId, key);
    await tapOn(messageId, `pm:${orderId}`);
    await tapOn(messageId, `m:${orderId}`);
    const invoice = editsOf(messageId)[0];
    expect(invoice, 'the card invoice is an edit of the wizard message').toBeDefined();
    expect(methods()).not.toContain('sendMessage');
    // What the ended screen must take away: something to copy, and the pay/receipt buttons.
    expect(keyboardOf(invoice).some((button) => button.copy_text !== undefined)).toBe(true);
    expect(dataOf(invoice).some((data) => data.startsWith('i:'))).toBe(true);
    cardNumber = /\d{16}|\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}/u.exec(textOf(invoice))?.[0] ?? null;
    expect(cardNumber, 'the invoice shows a card number').not.toBeNull();
    expect((await orderOf(orderId))?.state).toBe('AWAITING_PAYMENT');
    return orderId;
  }

  /** The card number the last card invoice showed. */
  let cardNumber: string | null = null;

  /** The ended screen's buttons: re-order (the order's category) and the main menu, only. */
  const ENDED_BUTTONS = [`ro:${CATEGORY_A}`, 'mm:'];
  const NO_MONEY_TAKEN = ['مبلغی ثبت نشده', 'مبلغی ثبت نشد', 'کسر نشده', 'کسر نشد'];

  function expectEndedScreen(call: Call | undefined, code: string | null, header: string): void {
    const text = textOf(call);
    expect(text.startsWith(header) || text.includes(header), 'the ending is named').toBe(true);
    if (code !== null) expect(text).toContain(code);
    expect(text).toContain('پلن');
    expect(text).toContain(formatMoney(money(250_000n, 'IRT')));
    for (const phrase of NO_MONEY_TAKEN) expect(text).not.toContain(phrase);
    if (cardNumber !== null) expect(text).not.toContain(cardNumber);
    // Nothing that pays: no card number, nothing to copy, no pay or receipt button.
    expect(keyboardOf(call).filter((button) => button.copy_text !== undefined)).toEqual([]);
    expect(keyboardOf(call).filter((button) => button.url !== undefined)).toEqual([]);
    expect(dataOf(call)).toEqual(ENDED_BUTTONS);
    expect(keyboardOf(call).map((button) => button.text)).toEqual([
      CATALOGUE_FA['bot.order.reorder_button'],
      CATALOGUE_FA['bot.order.main_menu_button'],
    ]);
  }
  const EXPIRED_HEADER = plain(CATALOGUE_FA['bot.order.expired_screen']).split('\n')[0] ?? '';
  const CANCELLED_HEADER = plain(CATALOGUE_FA['bot.order.cancelled_screen']).split('\n')[0] ?? '';

  // -------------------------------------------------------------------------------------
  // The expiry sweep, then the lane
  // -------------------------------------------------------------------------------------

  it('expiry with a known message: ONE edit of that message, zero sends, and ONE notice for the order', async () => {
    const message = 801;
    const orderId = await cardInvoiceOn(message, 'known');
    const invoiceText = textOf(editsOf(message)[0]);
    await lapse(orderId);

    const report = await ctx.container.paymentExpirySweep.runOnce(tenantA);
    expect(report).toMatchObject({ payments: 1, orders: 1 });
    // ONE notice, the order's — the payment against it is told nothing of its own.
    expect((await notices()).map((row) => [row.kind, row.subject_id])).toEqual([
      ['ORDER_EXPIRED', orderId],
    ]);

    await deliver();
    expect(methods(), 'one edit, and no new message').toEqual(['editMessageText']);
    const edit = editsOf(message)[0];
    expectEndedScreen(edit, (await orderOf(orderId))?.code ?? null, EXPIRED_HEADER);
    expect(invoiceText).toContain(cardNumber ?? '');
    expect((await notices())[0]?.state).toBe('DELIVERED');

    // Exactly once: a later pass, and a later sweep, find nothing more to say.
    await deliver();
    expect(methods()).toEqual([]);
    expect(await ctx.container.paymentExpirySweep.runOnce(tenantA)).toMatchObject({
      payments: 0,
      orders: 0,
    });
    expect(await notices()).toHaveLength(1);
  });

  it('an expired order whose message is gone (deleted, too old) is SENT exactly once', async () => {
    const message = 802;
    const orderId = await cardInvoiceOn(message, 'gone');
    await lapse(orderId);
    await ctx.container.paymentExpirySweep.runOnce(tenantA);
    uneditable.add(message);

    await deliver();
    expect(methods()).toEqual(['editMessageText', 'editMessageReplyMarkup', 'sendMessage']);
    const sent = calls.find((call) => call.method === 'sendMessage');
    expectEndedScreen(sent, (await orderOf(orderId))?.code ?? null, EXPIRED_HEADER);
    expect((await notices()).map((row) => row.state)).toEqual(['DELIVERED']);

    await deliver();
    expect(methods(), 'and never a second time').toEqual([]);
  });

  it('two sweeps and two dispatchers at once still produce ONE notice and ONE edit', async () => {
    const message = 803;
    const orderId = await cardInvoiceOn(message, 'race');
    await lapse(orderId);

    const [first, second] = await Promise.all([
      ctx.container.paymentExpirySweep.runOnce(tenantA),
      ctx.container.paymentExpirySweep.runOnce(tenantA),
    ]);
    expect(first.orders + second.orders).toBe(1);
    expect(await notices()).toHaveLength(1);

    await settle();
    calls = [];
    await Promise.all([
      ctx.container.customerNotificationLoop.tick(),
      ctx.container.customerNotificationLoop.tick(),
    ]);
    expect(methods()).toEqual(['editMessageText']);
    expect(methods()).not.toContain('sendMessage');
  });

  it('repeated expiry events for the same order add nothing: the per-order key is durable', async () => {
    const message = 804;
    const orderId = await cardInvoiceOn(message, 'repeat');
    await lapse(orderId);
    await ctx.container.paymentExpirySweep.runOnce(tenantA);
    await deliver();
    expect(methods()).toEqual(['editMessageText']);

    // The same fact raised again — a redelivery, a second replica — is a no-op at the key.
    const repository = new DrizzleCustomerNotificationRepository(ctx.container.database.db);
    const raised = await ctx.container.uow.run(tenantA, (tx) =>
      repository.enqueue(
        tenantA,
        {
          id: ctx.container.ids.uuid(),
          customerId: maryam,
          botInstanceId: BOT_A,
          kind: 'ORDER_EXPIRED',
          subjectId: orderId,
          nextAttemptAt: null,
        },
        ctx.container.clock.now(),
        tx,
      ),
    );
    expect(raised).toBe(false);
    await ctx.container.paymentExpirySweep.runOnce(tenantA);
    await deliver();
    expect(methods()).toEqual([]);
    expect(await notices()).toHaveLength(1);
  });

  it('an order with several lapsed payment attempts still gets ONE expiry notice, its own', async () => {
    const message = 805;
    const orderId = await cardInvoiceOn(message, 'attempts');
    // The first attempt lapses while the order still has time: nothing is said about it.
    await ctx.container.database.db.execute(
      sql`UPDATE payments SET expires_at = now() - interval '1 hour' WHERE order_id = ${orderId}` as never,
    );
    expect(await ctx.container.paymentExpirySweep.runOnce(tenantA)).toMatchObject({
      payments: 1,
      orders: 0,
    });
    expect(await notices()).toEqual([]);
    // A second attempt, and then the order's own window closes with it.
    await ctx.container.payments.requestManualTransfer(tenantA, systemActor('second'), maryam, {
      idempotencyKey: 'a11-second-attempt',
      orderId,
    });
    await lapse(orderId);
    expect(await ctx.container.paymentExpirySweep.runOnce(tenantA)).toMatchObject({
      payments: 1,
      orders: 1,
    });
    expect((await notices()).map((row) => row.kind)).toEqual(['ORDER_EXPIRED']);
    await deliver();
    expect(methods()).toEqual(['editMessageText']);
  });

  it('a transfer signalled but never receipted is answered ON its receipt prompt', async () => {
    const message = 806;
    const orderId = await cardInvoiceOn(message, 'signal');
    const sent = dataOf(editsOf(message)[0]).find((data) => data.startsWith('i:'));
    if (sent === undefined) throw new Error('no «I have paid» button on the card invoice');
    await tapOn(message, sent);
    await lapse(orderId);
    expect(await ctx.container.paymentExpirySweep.runOnce(tenantA)).toMatchObject({
      payments: 1,
      orders: 1,
    });

    await deliver();
    expect(methods()).toEqual(['editMessageText']);
    expectEndedScreen(editsOf(message)[0], (await orderOf(orderId))?.code ?? null, EXPIRED_HEADER);
  });

  it('an order with no known message (started in the mini app) is told once, by a new message', async () => {
    const productId = await product('miniapp');
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor('mini'), {
      idempotencyKey: 'a11-mini-draft',
      customerId: maryam,
      productId,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor('mini'), {
      idempotencyKey: 'a11-mini-confirm',
      customerId: maryam,
      orderId: draft.id,
    });
    await lapse(confirmed.id);
    await ctx.container.paymentExpirySweep.runOnce(tenantA);

    await deliver();
    expect(methods()).toEqual(['sendMessage']);
    expectEndedScreen(calls[0], (await orderOf(confirmed.id))?.code ?? null, EXPIRED_HEADER);
    await deliver();
    expect(methods()).toEqual([]);
  });

  it('an order paid just before its deadline is never edited into the expired screen', async () => {
    const message = 807;
    const orderId = await preinvoiceOn(message, 'paid');
    await fund(1_000_000n, 'paid');
    await tapOn(message, `w:${orderId}`);
    expect((await orderOf(orderId))?.state).toBe('PAID');
    await lapse(orderId);

    expect(await ctx.container.paymentExpirySweep.runOnce(tenantA)).toMatchObject({ orders: 0 });
    expect((await notices()).map((row) => row.kind)).not.toContain('ORDER_EXPIRED');

    // Even a row that names it — a bug, a restore — says nothing about a paid order.
    const repository = new DrizzleCustomerNotificationRepository(ctx.container.database.db);
    await ctx.container.uow.run(tenantA, (tx) =>
      repository.enqueue(
        tenantA,
        {
          id: ctx.container.ids.uuid(),
          customerId: maryam,
          botInstanceId: BOT_A,
          kind: 'ORDER_EXPIRED',
          subjectId: orderId,
          nextAttemptAt: null,
        },
        ctx.container.clock.now(),
        tx,
      ),
    );
    await deliver();
    expect(
      calls.filter((call) => textOf(call).includes(EXPIRED_HEADER)),
      'no expired screen, edited or sent',
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------------------
  // The customer's own taps
  // -------------------------------------------------------------------------------------

  it('a tap on a stale pay button of an expired order EDITS that message, never sends a new one', async () => {
    const message = 808;
    const orderId = await cardInvoiceOn(message, 'stale');
    await fund(1_000_000n, 'stale');
    // Past the deadline and not yet swept: the order still reads AWAITING_PAYMENT.
    await ctx.container.database.db.execute(
      sql`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = ${orderId}` as never,
    );
    // An older screen of the same order, still carrying its wallet button.
    const older = 809;
    const first = await tapOn(older, `w:${orderId}`);
    expect(first.replyKey).toBe('bot.order.expired_screen');
    expect(methods()).not.toContain('sendMessage');
    expectEndedScreen(editsOf(older)[0], (await orderOf(orderId))?.code ?? null, EXPIRED_HEADER);

    // The edited message carries nothing that pays, so it cannot be tapped into a second one.
    const again = await tapOn(older, `w:${orderId}`);
    expect(again.replyKey).toBeNull();
    expect(methods()).toEqual(['answerCallbackQuery']);
  });

  it('a draft past its hold is answered ON its pre-invoice, not by a new message', async () => {
    const message = 810;
    const orderId = await preinvoiceOn(message, 'hold');
    await ctx.container.database.db.execute(
      sql`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = ${orderId}` as never,
    );
    const answered = await tapOn(message, `pm:${orderId}`);
    expect(answered.replyKey).toBe('bot.order.expired_screen');
    expect(methods()).not.toContain('sendMessage');
    expect(textOf(editsOf(message)[0])).toContain(EXPIRED_HEADER);
    expect((await orderOf(orderId))?.state).toBe('DRAFT');
  });

  it('a cancellation edits the order’s own message into the cancelled screen and removes the question', async () => {
    const message = 811;
    const orderId = await cardInvoiceOn(message, 'cancel');
    // The way out is on the awaiting-payment screen; draw it on its own message.
    calls = [];
    await tapOn(812, `d:${orderId}`);
    const question = calls.find((call) => call.method === 'sendMessage');
    expect(textOf(question)).toBe(plain(CATALOGUE_FA['bot.order.cancel_confirm']));
    const questionId = question?.sentId;
    if (questionId === null || questionId === undefined) throw new Error('no question');

    const answered = await tapOn(questionId, `f:${orderId}`);
    expect((await orderOf(orderId))?.state).toBe('CANCELLED');
    expect(answered.replyKey).toBeNull();
    expect(methods()).not.toContain('sendMessage');
    expectEndedScreen(
      editsOf(message)[0],
      (await orderOf(orderId))?.code ?? null,
      CANCELLED_HEADER,
    );
    expect(
      calls.filter(
        (call) => call.method === 'deleteMessage' && call.body['message_id'] === questionId,
      ),
      'the spent question is removed',
    ).toHaveLength(1);
  });

  it('«🔁 سفارش دوباره» opens the category’s plans as a new message and creates no order', async () => {
    const message = 813;
    const orderId = await cardInvoiceOn(message, 'reorder');
    await lapse(orderId);
    await ctx.container.paymentExpirySweep.runOnce(tenantA);
    await deliver();
    const before = (await ordersOfMaryam()).length;

    const opened = await tapOn(message, `ro:${CATEGORY_A}`);
    expect(opened.replyKey).toBe('bot.catalog.heading');
    expect(methods()).toContain('sendMessage');
    expect(editsOf(message), 'the ended screen stays as the record').toEqual([]);
    expect((await ordersOfMaryam()).length).toBe(before);
  });
});
