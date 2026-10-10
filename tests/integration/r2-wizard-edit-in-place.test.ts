import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type OrderId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
  paymentTrackingCode,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { appearanceFallbackText as plain } from '../../apps/api/src/modules/commerce/messaging/application/appearance-render';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { encodeIdPair } from '../../apps/api/src/surfaces/telegram/bot-runtime';
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
 * R2 (v0.3.5 real-test items 5 and 11): the purchase and top-up wizards evolve through ONE
 * Telegram message, a stale tap cannot move them backward or repeat a draft or a payment,
 * and (FIX-08, superseding R2 item 11's NEW message) a paid renewal's or add-on's result is
 * edited onto that same payment message — sent as a new one only when it cannot be edited.
 *
 * A socket stands in for Telegram and answers every send with a NEW message id, as Telegram
 * does, so a test can follow one message through its edits.
 */
const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const MARYAM = '910910';

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
  /** The id Telegram gave a message this call SENT. */
  readonly sentId: number | null;
}

describe('the wizard is one message, edited in place', () => {
  let ctx: TestContext;
  let telegram: Server;
  let calls: Call[];
  let nextMessageId = 100;
  let panel: FakeMarzban;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let panelId: string;
  let maryam: UserId;
  let owner: ActorContext;
  let updateSeq = 0;
  /** Messages Telegram will no longer edit: an edit of one is refused with a 400. */
  const uneditable = new Set<number>();
  /** FIX-08: messages whose edit Telegram answers with a 429, or with a 500 (unknown). */
  const editAnswers = new Map<number, 'RATE_LIMITED' | 'SERVER_ERROR'>();
  /** Codex review of #257: messages whose keyboard Telegram refuses to clear (a 400). */
  const unclearable = new Set<number>();

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
        const forced = editAnswers.get(Number(body['message_id']));
        if (method === 'editMessageText' && forced !== undefined) {
          // FIX-08: a 429 (declined, nothing applied) or a 500 (Telegram may have applied it).
          calls.push({ method, body, sentId: null });
          const status = forced === 'RATE_LIMITED' ? 429 : 500;
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              ok: false,
              error_code: status,
              description: forced === 'RATE_LIMITED' ? 'Too Many Requests' : 'Internal',
              ...(forced === 'RATE_LIMITED' ? { parameters: { retry_after: 1 } } : {}),
            }),
          );
          return;
        }
        if (method === 'editMessageReplyMarkup' && unclearable.has(Number(body['message_id']))) {
          // Codex review of #257: a keyboard Telegram will not take off either.
          calls.push({ method, body, sentId: null });
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: "Bad Request: message can't be edited",
            }),
          );
          return;
        }
        if (method === 'editMessageText' && uneditable.has(Number(body['message_id']))) {
          calls.push({ method, body, sentId: null });
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: "Bad Request: message can't be edited",
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
    services = new DrizzleServiceRepository(ctx.container.database.db);
    calls = [];
    uneditable.clear();
    editAnswers.clear();
    unclearable.clear();
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-r2', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-r2-create',
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
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
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
      idempotencyKey: `r2-update-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      update: { update_id: updateSeq, ...payload },
      telegramUserId: MARYAM,
      from: { id: Number(MARYAM), first_name: 'مریم' },
    };
  }

  /** A tap on ONE message: the same id twice is a double tap on the same keyboard. */
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

  function type(text: string, messageId: number) {
    calls = [];
    return ctx.container.botRuntime.handle(
      tenantA,
      systemActor('bot'),
      update({
        message: {
          message_id: messageId,
          date: 0,
          chat: { id: Number(MARYAM), type: 'private' },
          from: { id: Number(MARYAM), is_bot: false, first_name: 'مریم' },
          text,
        },
      }),
    );
  }

  const methods = () => calls.map((call) => call.method);
  const edited = (messageId: number) =>
    calls.filter(
      (call) => call.method === 'editMessageText' && call.body['message_id'] === messageId,
    );
  const buttonsOf = (call: Call | undefined): string[] =>
    (
      (call?.body['reply_markup'] as { inline_keyboard?: { callback_data?: string }[][] })
        ?.inline_keyboard ?? []
    )
      .flat()
      .map((button) => button.callback_data ?? '')
      .filter((data) => data !== '');

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await ctx.container.database.db.execute(query)).rows as T[];
  }
  const draftOrders = () =>
    rows<{ id: string; state: string }>(
      sql`SELECT id, state FROM orders WHERE tenant_id = ${tenantA.tenantId}
          AND customer_id = ${maryam} ORDER BY created_at`,
    );
  const debits = () =>
    rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM wallet_entries
          WHERE tenant_id = ${tenantA.tenantId} AND customer_id = ${maryam} AND direction = 'DEBIT'`,
    ).then((found) => Number(found[0]?.n ?? 0));

  // -------------------------------------------------------------------------------------
  // Item 5: the purchase wizard
  // -------------------------------------------------------------------------------------

  it('category → product → username → pre-invoice → wallet: ONE message edited, then closed, and the delivery is a new message', async () => {
    const productId = await product('one');
    await fund(1_000_000n, 'one');

    // The main menu's «خرید» is the one step that SENDS: it becomes the wizard message.
    await ctx.container.botRuntime.handle(
      tenantA,
      systemActor('bot'),
      update({
        message: {
          message_id: 5,
          date: 0,
          chat: { id: Number(MARYAM), type: 'private' },
          from: { id: Number(MARYAM), is_bot: false, first_name: 'مریم' },
          text: '/catalog',
        },
      }),
    );
    const wizard = calls.find((call) => call.method === 'sendMessage')?.sentId;
    if (wizard === null || wizard === undefined) throw new Error('no catalogue message');

    await tapOn(wizard, `ck:${SEED_IDS.categoryA}.0`);
    expect(methods()).toEqual(['editMessageText', 'answerCallbackQuery']);
    expect(edited(wizard)[0]?.body['text']).toBe(CATALOGUE_FA['bot.catalog.heading']);

    await tapOn(wizard, `p:${productId}`);
    expect(methods()).not.toContain('sendMessage');
    const [order] = await draftOrders();
    if (order === undefined) throw new Error('no draft');
    // Two username modes: the question is on the SAME message.
    expect(buttonsOf(edited(wizard)[0])).toContain(`Z:${order.id}`);

    await tapOn(wizard, `Z:${order.id}`);
    expect(buttonsOf(edited(wizard)[0])).toContain(`w:${order.id}`);
    expect(methods()).not.toContain('sendMessage');

    await tapOn(wizard, `w:${order.id}`);
    // The wizard closes in place with no buttons; what follows is a NEW message.
    expect(edited(wizard)[0]?.body['text']).toBe(plain(CATALOGUE_FA['bot.order.settled']));
    expect(buttonsOf(edited(wizard)[0])).toEqual([]);
    expect(edited(wizard)[0]?.body['reply_markup']).toEqual({ inline_keyboard: [] });
    const after = calls.filter((call) => call.method === 'sendMessage');
    expect(after.map((call) => call.body['text'])).toEqual([
      plain(CATALOGUE_FA['bot.service.provisioning']),
    ]);
    expect(await debits()).toBe(1);
  });

  it('a stale tap cannot move the wizard backward or repeat a draft or a payment: it is answered and nothing else', async () => {
    const productId = await product('stale');
    await fund(1_000_000n, 'stale');
    const wizard = 700;

    await tapOn(wizard, `ck:${SEED_IDS.categoryA}.0`);
    await tapOn(wizard, `p:${productId}`);
    expect(await draftOrders()).toHaveLength(1);

    // The product button again (a double tap before the edit landed): no second draft.
    const doubled = await tapOn(wizard, `p:${productId}`);
    expect(doubled.replyKey).toBeNull();
    expect(methods()).toEqual(['answerCallbackQuery']);
    expect(await draftOrders()).toHaveLength(1);

    const [order] = await draftOrders();
    if (order === undefined) throw new Error('no draft');
    await tapOn(wizard, `Z:${order.id}`);

    // A category from the list two screens back: the wizard does not move backward.
    const backward = await tapOn(wizard, `ck:${SEED_IDS.categoryA}.0`);
    expect(backward.replyKey).toBeNull();
    expect(methods()).toEqual(['answerCallbackQuery']);

    // Pay, then pay again from the same (now closed) message: one debit.
    await tapOn(wizard, `w:${order.id}`);
    expect(await debits()).toBe(1);
    const again = await tapOn(wizard, `w:${order.id}`);
    expect(again.replyKey).toBeNull();
    expect(methods()).toEqual(['answerCallbackQuery']);
    expect(await debits()).toBe(1);
    expect((await draftOrders()).map((o) => o.state)).toEqual(['PAID']);
  });

  /*
   * R2 finding F2: when Telegram refuses an edit, the screen goes out as a NEW message and
   * the wizard moves onto it. The message it LEFT still carries its keyboard; untracked, its
   * next tap was adopted as a fresh wizard and claimed — an old button moving the flow
   * backward (here: a second draft from the product list two screens back).
   */
  it('a message the wizard left after a refused edit stays closed: its old keyboard is stale and the wizard does not move', async () => {
    const productId = await product('left');
    const wizard = 750;
    await tapOn(wizard, `ck:${SEED_IDS.categoryA}.0`);
    await tapOn(wizard, `p:${productId}`);
    const [order] = await draftOrders();
    if (order === undefined) throw new Error('no draft');

    // Telegram will not edit the wizard message any more: the pre-invoice is sent anew.
    uneditable.add(wizard);
    await tapOn(wizard, `Z:${order.id}`);
    const fresh = calls.find((call) => call.method === 'sendMessage');
    const freshId = fresh?.sentId;
    if (freshId === null || freshId === undefined) throw new Error('no fallback message');
    expect(buttonsOf(fresh)).toContain(`w:${order.id}`);

    // The product button on the message the wizard left: answered, and nothing else.
    const stale = await tapOn(wizard, `p:${productId}`);
    expect(stale.replyKey).toBeNull();
    expect(methods()).toEqual(['answerCallbackQuery']);
    expect(await draftOrders()).toHaveLength(1);

    const tracked = await rows<{ message_id: string; step: string }>(
      sql`SELECT message_id::text AS message_id, step FROM telegram_wizards
          WHERE tenant_id = ${tenantA.tenantId} AND message_id IN (${wizard}, ${freshId})
          ORDER BY message_id`,
    );
    expect(new Map(tracked.map((row) => [row.message_id, row.step]))).toEqual(
      new Map([
        [String(wizard), 'CLOSED'],
        [String(freshId), 'PREINVOICE'],
      ]),
    );
  });

  /*
   * Retention (docs/telegram-retention.md): the CLOSED row that keeps the left-behind
   * message's old keyboard stale is itself removed once old. Without the chat's purge
   * horizon the next tap on that keyboard would be ADOPTED as a fresh pre-invoice — and its
   * pay button would pay. With it, the tap is stale: answered, and nothing else.
   */
  it('retention: once the left-behind message’s row is removed, its old pay button still moves no money', async () => {
    const productId = await product('retained');
    await fund(1_000_000n, 'retained');
    const wizard = 760;
    await tapOn(wizard, `ck:${SEED_IDS.categoryA}.0`);
    await tapOn(wizard, `p:${productId}`);
    const [order] = await draftOrders();
    if (order === undefined) throw new Error('no draft');
    uneditable.add(wizard);
    await tapOn(wizard, `Z:${order.id}`);
    const freshId = calls.find((call) => call.method === 'sendMessage')?.sentId;
    if (freshId === null || freshId === undefined) throw new Error('no fallback message');

    // The left-behind row grows old; the live pre-invoice on the fresh message does not.
    await ctx.container.database.db.execute(sql`
      UPDATE telegram_wizards SET updated_at = now() - interval '40 days',
                                  created_at = now() - interval '40 days'
       WHERE tenant_id = ${tenantA.tenantId} AND message_id = ${wizard}`);
    const swept = await ctx.container.telegramMessageState.purgeExpired(
      tenantA,
      systemActor('retention'),
      100,
    );
    expect(swept.wizards).toBe(1);

    // The pre-invoice's wallet button, on the message whose row is gone.
    const stale = await tapOn(wizard, `w:${order.id}`);
    expect(stale.replyKey).toBeNull();
    expect(methods()).toEqual(['answerCallbackQuery']);
    expect(await debits()).toBe(0);
    expect((await draftOrders()).map((o) => o.state)).toEqual(['DRAFT']);
    const tracked = await rows<{ message_id: string }>(
      sql`SELECT message_id::text AS message_id FROM telegram_wizards
          WHERE tenant_id = ${tenantA.tenantId} AND message_id = ${wizard}`,
    );
    expect(tracked).toEqual([]);

    // The live wizard is untouched by both: its own pay button still pays, once.
    await tapOn(freshId, `w:${order.id}`);
    expect(await debits()).toBe(1);
    expect((await draftOrders()).map((o) => o.state)).toEqual(['PAID']);
  });

  it('a typed username continues the SAME wizard message, and the typed message is removed', async () => {
    const productId = await product('typed');
    const wizard = 710;
    await tapOn(wizard, `ck:${SEED_IDS.categoryA}.0`);
    await tapOn(wizard, `p:${productId}`);
    const [order] = await draftOrders();
    if (order === undefined) throw new Error('no draft');

    await tapOn(wizard, `j:${order.id}`);
    expect(edited(wizard)[0]?.body['text']).toBe(CATALOGUE_FA['bot.username.instructions']);

    const answered = await type('maryam2026', 4242);
    expect(answered.replyKey).toBe('bot.order.preinvoice');
    expect(methods()).not.toContain('sendMessage');
    expect(buttonsOf(edited(wizard)[0])).toContain(`w:${order.id}`);
    expect(calls.find((call) => call.method === 'deleteMessage')?.body).toMatchObject({
      message_id: 4242,
    });
  });

  /*
   * R2 finding F3: a refused typed name names no order, and the refusal was shown on the
   * chat's most recently touched USERNAME wizard — with two purchases open, possibly the
   * OTHER order's. It is shown on the wizard of the order whose window is open.
   */
  it('a refused typed username is shown on the wizard of the order whose window is open, not the latest other one', async () => {
    const first = await product('two-a');
    const second = await product('two-b');
    const other = 771;
    const asking = 770;
    // The other purchase: its wizard waits at the username question.
    await tapOn(other, `ck:${SEED_IDS.categoryA}.0`);
    await tapOn(other, `p:${second}`);
    // This purchase: the customer chose to type a name, so ITS window is open.
    await tapOn(asking, `ck:${SEED_IDS.categoryA}.0`);
    await tapOn(asking, `p:${first}`);
    const orders = await draftOrders();
    const mine = orders.at(-1);
    if (mine === undefined || orders.length !== 2) throw new Error('two drafts expected');
    await tapOn(asking, `j:${mine.id}`);
    // The other wizard is the chat's most recently touched USERNAME wizard.
    await ctx.container.database.db.execute(
      sql`UPDATE telegram_wizards SET updated_at = now() + interval '1 minute'
          WHERE tenant_id = ${tenantA.tenantId} AND message_id = ${other}`,
    );

    const refused = await type('!!', 4444);
    expect(refused.replyKey).toBe('bot.username.invalid');
    expect(edited(other)).toHaveLength(0);
    expect(edited(asking)[0]?.body['text']).toBe(CATALOGUE_FA['bot.username.invalid']);
    expect(methods()).not.toContain('sendMessage');
  });

  it('a refused typed discount code is shown on the wizard of the order whose window is open, not the latest other one', async () => {
    const first = await product('code-a');
    const second = await product('code-b');
    const other = 781;
    const asking = 780;
    const toPreinvoice = async (message: number, productId: ProductId) => {
      await tapOn(message, `ck:${SEED_IDS.categoryA}.0`);
      await tapOn(message, `p:${productId}`);
      const order = (await draftOrders()).at(-1);
      if (order === undefined) throw new Error('no draft');
      await tapOn(message, `Z:${order.id}`);
      expect(buttonsOf(edited(message)[0])).toContain(`dc:${order.id}`);
      await tapOn(message, `dc:${order.id}`);
      return order.id;
    };
    await toPreinvoice(other, second);
    // This order's code window supersedes the other's: a typed code answers THIS one.
    await toPreinvoice(asking, first);
    await ctx.container.database.db.execute(
      sql`UPDATE telegram_wizards SET updated_at = now() + interval '1 minute'
          WHERE tenant_id = ${tenantA.tenantId} AND message_id = ${other}`,
    );

    const refused = await type('NOSUCHCODE', 4545);
    expect(refused.replyKey).toBe('bot.discount.rejected');
    expect(edited(other)).toHaveLength(0);
    expect(edited(asking)[0]?.body['text']).toBe(CATALOGUE_FA['bot.discount.rejected']);
  });

  // -------------------------------------------------------------------------------------
  // Item 5: the wallet top-up wizard
  // -------------------------------------------------------------------------------------

  it('top-up: amount → method on the SAME message, a typed amount included', async () => {
    await ctx.container.database.db.execute(sql`
      UPDATE payment_gateways SET status = 'ACTIVE' WHERE tenant_id = ${tenantA.tenantId}`);
    const walletScreen = 720;
    const begun = await tapOn(walletScreen, 'o:');
    expect(begun.replyKey).toBe('bot.wallet.topup_amount_prompt');
    expect(edited(walletScreen)).toHaveLength(1);

    const typed = await type('500000', 4343);
    expect(methods()).not.toContain('sendMessage');
    expect(edited(walletScreen)).toHaveLength(1);
    expect(typed.replyKey).not.toBeNull();
    expect(calls.some((call) => call.method === 'deleteMessage')).toBe(true);

    // The amount step's own button again (stale): answered, nothing moves.
    const stale = await tapOn(walletScreen, 'y:500000');
    expect(stale.replyKey).toBeNull();
    expect(methods()).toEqual(['answerCallbackQuery']);
  });

  // -------------------------------------------------------------------------------------
  // Item 11: the renewal result
  // -------------------------------------------------------------------------------------

  async function activeService(key: string): Promise<{ id: string; username: string }> {
    const productId = await product(key);
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(key), {
      idempotencyKey: `${key}-draft`,
      customerId: maryam,
      productId,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(key), {
      idempotencyKey: `${key}-confirm`,
      customerId: maryam,
      orderId: draft.id,
    });
    await fund(2_000_000n, key);
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(key), maryam, {
      idempotencyKey: `${key}-pay`,
      orderId: confirmed.id,
    });
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, confirmed.id as OrderId);
    if (service === null || service === undefined) throw new Error('no service');
    expect(service.state).toBe('ACTIVE');
    return { id: service.id, username: service.providerUsername };
  }

  // -------------------------------------------------------------------------------------
  // FIX-08: the outcome of a paid order is answered ON its payment message
  // -------------------------------------------------------------------------------------

  /** Another writer is done with the order's screens: past the settle window, and due. */
  async function settleScreens(): Promise<void> {
    await ctx.container.database.db.execute(sql`
      UPDATE telegram_wizards SET updated_at = updated_at - interval '1 hour', busy_until = NULL
       WHERE tenant_id = ${tenantA.tenantId}`);
    await ctx.container.database.db.execute(sql`
      UPDATE customer_notifications SET next_attempt_at = now() - interval '1 second'
       WHERE tenant_id = ${tenantA.tenantId} AND state = 'PENDING'`);
  }

  const notice = async (kind: string) =>
    (
      await rows<{ state: string; attempts: number }>(
        sql`SELECT state, attempts FROM customer_notifications
             WHERE tenant_id = ${tenantA.tenantId} AND kind = ${kind}`,
      )
    )[0];

  const renewedText = '✅ سرویس شما با موفقیت تمدید شد';

  /** The renewal quote (a new message, the renewal's wizard) and its wallet button. */
  async function renewalQuote(
    serviceId: string,
    messageId: number,
  ): Promise<{ quoteId: number; pay: string }> {
    await tapOn(messageId, `nr:${serviceId}`);
    const quote = calls.find((call) => call.method === 'sendMessage');
    const quoteId = quote?.sentId;
    if (quoteId === null || quoteId === undefined) throw new Error('no renewal quote');
    const pay = buttonsOf(quote).find((data) => data.startsWith('w:'));
    if (pay === undefined) throw new Error('no wallet button on the renewal quote');
    return { quoteId, pay };
  }

  it('a wallet renewal is answered ON its payment message: one message, edited, never a second one (FIX-08)', async () => {
    const service = await activeService('renew');
    const before = await services.findById(tenantA, service.id);
    const { quoteId, pay } = await renewalQuote(service.id, 730);

    await tapOn(quoteId, pay);
    // Closed in place, with no buttons and no «order paid» sentence.
    expect(edited(quoteId)[0]?.body['text']).toBe(plain(CATALOGUE_FA['bot.service.renew_paid']));
    expect(buttonsOf(edited(quoteId)[0])).toEqual([]);

    await ctx.container.provisionerLoop.tick();
    const told = await rows<{ kind: string }>(
      sql`SELECT kind FROM customer_notifications WHERE tenant_id = ${tenantA.tenantId}
          AND customer_id = ${maryam}`,
    );
    expect(told.map((row) => row.kind)).toContain('SERVICE_RENEWED');
    expect(told.map((row) => row.kind)).not.toContain('SERVICE_ACTION_SUCCEEDED');

    // The customer's own tap edited that message moments ago: the result waits for it to
    // settle, with nothing sent, nothing stamped and no attempt spent.
    calls = [];
    await ctx.container.customerNotificationLoop.tick();
    expect(methods()).toEqual([]);
    expect(await notice('SERVICE_RENEWED')).toEqual({ state: 'PENDING', attempts: 0 });

    await settleScreens();
    calls = [];
    await ctx.container.customerNotificationLoop.tick();
    expect(methods(), 'one edit, and no new message').toEqual(['editMessageText']);
    const result = edited(quoteId)[0];
    const text = String(result?.body['text'] ?? '');
    expect(text).toContain(renewedText);
    expect(text).toContain(service.username);
    expect(text).toContain('30 روز');
    const [paid] = await rows<{ reference: string }>(
      sql`SELECT p.reference FROM payments p JOIN orders o ON o.id = p.order_id
          WHERE o.purpose = 'RENEW' AND p.state = 'CONFIRMED' AND p.tenant_id = ${tenantA.tenantId}`,
    );
    // FIX-02: the renewal quotes the public code under the exact label, never `:wallet`.
    expect(text).toContain(`کد پیگیری پرداخت: ${paymentTrackingCode(paid?.reference ?? 'none')}`);
    expect(text).not.toContain(':wallet');
    const after = await services.findById(tenantA, service.id);
    expect(after?.expiresAt?.getTime()).toBeGreaterThan(before?.expiresAt?.getTime() ?? 0);
    // The buttons are the result's: one, opening the renewed service directly.
    expect(buttonsOf(result)).toEqual([`s:${service.id}`]);
    expect(await notice('SERVICE_RENEWED')).toMatchObject({ state: 'DELIVERED' });

    // That button works from the edited message: the closed payment screen does not gate it.
    const opened = await tapOn(quoteId, `s:${service.id}`);
    expect(opened.replyKey).toBe('bot.service.card');

    // Exactly once: a later pass finds nothing to say.
    await settleScreens();
    calls = [];
    await ctx.container.customerNotificationLoop.tick();
    expect(methods()).toEqual([]);
  });

  it('a double tap on the wallet button pays once and is answered once (FIX-08)', async () => {
    const service = await activeService('renew-double');
    const { quoteId, pay } = await renewalQuote(service.id, 731);
    const debitsBefore = await debits();

    await tapOn(quoteId, pay);
    const second = await tapOn(quoteId, pay);
    // The second tap is on a CLOSED screen: answered, nothing moves, nothing is drawn.
    expect(second.replyKey).toBeNull();
    expect(methods()).toEqual(['answerCallbackQuery']);
    expect((await debits()) - debitsBefore).toBe(1);

    await ctx.container.provisionerLoop.tick();
    await settleScreens();
    calls = [];
    await ctx.container.customerNotificationLoop.tick();
    expect(methods()).toEqual(['editMessageText']);
    expect(String(edited(quoteId)[0]?.body['text'])).toContain(renewedText);
  });

  it('a renewal whose payment message cannot be edited is SENT once as a new message (FIX-08)', async () => {
    const service = await activeService('renew-gone');
    const { quoteId, pay } = await renewalQuote(service.id, 732);
    await tapOn(quoteId, pay);
    await ctx.container.provisionerLoop.tick();
    // Deleted by the customer, or past Telegram's edit window: a definite refusal.
    uneditable.add(quoteId);

    await settleScreens();
    calls = [];
    await ctx.container.customerNotificationLoop.tick();
    expect(methods()).toEqual(['editMessageText', 'sendMessage']);
    expect(String(calls[1]?.body['text'])).toContain(renewedText);
    expect(await notice('SERVICE_RENEWED')).toMatchObject({ state: 'DELIVERED' });

    await settleScreens();
    calls = [];
    await ctx.container.customerNotificationLoop.tick();
    expect(methods(), 'and never a second time').toEqual([]);
  });

  it('a 429 on the edit is retried as the EDIT, never turned into a send (FIX-08)', async () => {
    const service = await activeService('renew-429');
    const { quoteId, pay } = await renewalQuote(service.id, 733);
    await tapOn(quoteId, pay);
    await ctx.container.provisionerLoop.tick();
    editAnswers.set(quoteId, 'RATE_LIMITED');

    await settleScreens();
    calls = [];
    await ctx.container.customerNotificationLoop.tick();
    expect(methods()).toEqual(['editMessageText']);
    expect(await notice('SERVICE_RENEWED')).toEqual({ state: 'PENDING', attempts: 0 });

    editAnswers.clear();
    await settleScreens();
    calls = [];
    await ctx.container.customerNotificationLoop.tick();
    expect(methods()).toEqual(['editMessageText']);
    expect(String(edited(quoteId)[0]?.body['text'])).toContain(renewedText);
    expect(await notice('SERVICE_RENEWED')).toMatchObject({ state: 'DELIVERED' });
  });

  it('an edit whose answer was lost is UNCONFIRMED and never repeated, as an edit or a send (FIX-08)', async () => {
    const service = await activeService('renew-unknown');
    const { quoteId, pay } = await renewalQuote(service.id, 734);
    await tapOn(quoteId, pay);
    await ctx.container.provisionerLoop.tick();
    editAnswers.set(quoteId, 'SERVER_ERROR');

    await settleScreens();
    calls = [];
    await ctx.container.customerNotificationLoop.tick();
    expect(methods()).toEqual(['editMessageText']);
    expect(await notice('SERVICE_RENEWED')).toMatchObject({ state: 'UNCONFIRMED' });

    editAnswers.clear();
    await settleScreens();
    calls = [];
    await ctx.container.customerNotificationLoop.tick();
    expect(methods()).toEqual([]);
  });

  /**
   * A renewal settled by an operator's hand rather than the wizard, and delivered: its quote
   * is still OPEN, carrying its pay buttons, when the lane comes to answer it.
   */
  async function renewalSettledOutside(
    name: string,
    messageId: number,
  ): Promise<{ service: { id: string; username: string }; quoteId: number }> {
    const service = await activeService(name);
    const { quoteId, pay } = await renewalQuote(service.id, messageId);
    const [order] = await rows<{ id: string }>(
      sql`SELECT id FROM orders WHERE purpose = 'RENEW' AND tenant_id = ${tenantA.tenantId}`,
    );
    if (order === undefined) throw new Error('no renewal order');
    const confirmed = await ctx.container.commercialActions.confirm(
      tenantA,
      systemActor(`${name}-c`),
      maryam,
      { orderId: order.id, idempotencyKey: `${name}-rm-confirm` },
    );
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(`${name}-p`), maryam, {
      idempotencyKey: `${name}-rm-pay`,
      orderId: confirmed.id,
    });
    await ctx.container.provisionerLoop.tick();
    expect(buttonsOf(calls.find((call) => call.sentId === quoteId))).toContain(pay);
    return { service, quoteId };
  }

  it('a renewal settled outside the wizard is answered on its still-open quote, which loses its pay buttons (FIX-08)', async () => {
    const { service, quoteId } = await renewalSettledOutside('renew-manual', 740);

    await settleScreens();
    calls = [];
    await ctx.container.customerNotificationLoop.tick();
    expect(methods()).toEqual(['editMessageText']);
    const result = edited(quoteId)[0];
    expect(String(result?.body['text'])).toContain(renewedText);
    // The quote's pay buttons are gone: what it carries now is the result's one button.
    expect(buttonsOf(result)).toEqual([`s:${service.id}`]);
    const [screen] = await rows<{ step: string }>(
      sql`SELECT step FROM telegram_wizards WHERE tenant_id = ${tenantA.tenantId}
          AND message_id = ${quoteId}`,
    );
    expect(screen?.step, 'and a stale pay tap on it is refused by the gate').toBe('CLOSED');
  });

  it('a refused edit of a still-open quote clears its pay buttons and sends the result once (Codex review of #257)', async () => {
    const { service, quoteId } = await renewalSettledOutside('renew-refused', 741);
    // Telegram will not edit the quote's text (a non-text message, an outcome too long).
    uneditable.add(quoteId);

    await settleScreens();
    calls = [];
    await ctx.container.customerNotificationLoop.tick();
    expect(methods()).toEqual(['editMessageText', 'editMessageReplyMarkup', 'sendMessage']);
    // The quote keeps its text and loses its stale pay buttons...
    expect(calls[1]?.body['message_id']).toBe(quoteId);
    expect(buttonsOf(calls[1])).toEqual([]);
    // ...and the result arrives once, as a new message.
    expect(String(calls[2]?.body['text'])).toContain(renewedText);
    expect(buttonsOf(calls[2])).toEqual([`s:${service.id}`]);
    expect(await notice('SERVICE_RENEWED')).toMatchObject({ state: 'DELIVERED' });

    await settleScreens();
    calls = [];
    await ctx.container.customerNotificationLoop.tick();
    expect(methods(), 'and never a second time').toEqual([]);
  });

  it('a keyboard that cannot be cleared holds back nothing and sends nothing twice (Codex review of #257)', async () => {
    const { quoteId } = await renewalSettledOutside('renew-unclearable', 742);
    uneditable.add(quoteId);
    unclearable.add(quoteId);

    await settleScreens();
    calls = [];
    await ctx.container.customerNotificationLoop.tick();
    expect(methods()).toEqual(['editMessageText', 'editMessageReplyMarkup', 'sendMessage']);
    expect(String(calls[2]?.body['text'])).toContain(renewedText);
    expect(await notice('SERVICE_RENEWED')).toMatchObject({ state: 'DELIVERED' });

    await settleScreens();
    calls = [];
    await ctx.container.customerNotificationLoop.tick();
    expect(methods()).toEqual([]);
  });

  it('a tap that lands between the two readiness checks defers the result: nothing sent, no attempt spent (Codex review of #257)', async () => {
    const service = await activeService('renew-landed');
    const { quoteId, pay } = await renewalQuote(service.id, 743);
    await tapOn(quoteId, pay);
    await ctx.container.provisionerLoop.tick();
    await settleScreens();

    /*
     * The lane's own check sees the message settled; right after it, a customer's turn lands
     * on it (as a landing does: the version moves and `updated_at` is now), so `answerOrder`'s
     * second check finds it being written.
     */
    const screens = ctx.container.wizardScreens;
    const original = screens.orderReadiness.bind(screens);
    let asked = 0;
    screens.orderReadiness = async (...args) => {
      const ready = await original(...args);
      asked += 1;
      if (asked === 1) {
        await ctx.container.database.db.execute(sql`
          UPDATE telegram_wizards SET updated_at = now(), version = version + 1
           WHERE tenant_id = ${tenantA.tenantId} AND message_id = ${quoteId}`);
      }
      return ready;
    };
    try {
      calls = [];
      await ctx.container.customerNotificationLoop.tick();
    } finally {
      screens.orderReadiness = original;
    }
    expect(asked).toBe(2);
    expect(methods(), 'nothing is edited, cleared or sent').toEqual([]);
    expect(await notice('SERVICE_RENEWED')).toEqual({ state: 'PENDING', attempts: 0 });
    const [stamp] = await rows<{ send_started_at: Date | null }>(
      sql`SELECT send_started_at FROM customer_notifications
           WHERE tenant_id = ${tenantA.tenantId} AND kind = 'SERVICE_RENEWED'`,
    );
    expect(stamp?.send_started_at, 'the stamp is taken back').toBeNull();

    // Once the message settles, the result is edited onto it, once.
    await settleScreens();
    calls = [];
    await ctx.container.customerNotificationLoop.tick();
    expect(methods()).toEqual(['editMessageText']);
    expect(String(edited(quoteId)[0]?.body['text'])).toContain(renewedText);
    expect(await notice('SERVICE_RENEWED')).toMatchObject({ state: 'DELIVERED' });
    await settleScreens();
    calls = [];
    await ctx.container.customerNotificationLoop.tick();
    expect(methods()).toEqual([]);
  });

  it('a SUSPEND is never answered on the purchase message of the order that created its service (FIX-08)', async () => {
    const service = await activeService('suspend-elsewhere');
    // The service's own purchase left a settled screen in this chat, long ago.
    const [created] = await rows<{ order_id: string }>(
      sql`SELECT order_id FROM services WHERE id = ${service.id}`,
    );
    await ctx.container.database.db.execute(sql`
      INSERT INTO telegram_wizards
        (id, tenant_id, bot_instance_id, chat_id, message_id, kind, step, version, subject_id,
         created_at, updated_at)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${BOT_A}, ${MARYAM}, 760,
              'ORDER', 'CLOSED', 1, ${created?.order_id ?? null},
              now() - interval '1 day', now() - interval '1 day')`);
    // Asked with no card, so the lane owes the answer — but the operation carries the
    // CREATING order's id, which is not what it was bought as.
    await ctx.container.provisioning.requestFromCustomer(
      tenantA,
      systemActor('susp'),
      maryam,
      service.id,
      'SUSPEND',
      { idempotencyKey: 'susp-elsewhere' },
    );
    await ctx.container.provisionerLoop.tick();
    await settleScreens();
    calls = [];
    await ctx.container.customerNotificationLoop.tick();
    expect(methods()).toEqual(['sendMessage']);
    expect(edited(760)).toEqual([]);
  });

  it('extra traffic paid from the wallet is answered on its payment message too (FIX-08)', async () => {
    const service = await activeService('traffic');
    const addon = await ctx.container.serviceAddons.create(tenantA, owner, {
      idempotencyKey: 'traffic-addon',
      draft: {
        kind: 'ADD_TRAFFIC',
        title: 'بسته ۱۰ گیگ',
        sortOrder: 10,
        specification: { kind: 'ADD_TRAFFIC', trafficBytes: 10_737_418_240n, durationDays: null },
        price: money(50_000n, 'IRT'),
      },
    });
    await ctx.container.serviceAddons.activate(tenantA, owner, {
      idempotencyKey: 'traffic-addon-on',
      addonId: addon.id,
    });

    await tapOn(750, `a:${encodeIdPair(service.id, addon.id)}`);
    const quote = calls.find((call) => call.method === 'sendMessage');
    const quoteId = quote?.sentId ?? edited(750)[0]?.body['message_id'];
    const message = quote ?? edited(750)[0];
    const pay = buttonsOf(message).find((data) => data.startsWith('w:'));
    if (typeof quoteId !== 'number' || pay === undefined) throw new Error('no traffic quote');
    await tapOn(quoteId, pay);
    await ctx.container.provisionerLoop.tick();
    expect(
      (
        await rows<{ state: string }>(
          sql`SELECT state FROM provisioning_operations WHERE type = 'ADD_TRAFFIC'`,
        )
      )[0]?.state,
    ).toBe('SUCCEEDED');

    await settleScreens();
    calls = [];
    await ctx.container.customerNotificationLoop.tick();
    expect(methods()).toEqual(['editMessageText']);
    expect(edited(quoteId)[0]?.body['text']).toBe(
      plain(CATALOGUE_FA['bot.service.action_succeeded']),
    );
    expect(await notice('SERVICE_ACTION_SUCCEEDED')).toMatchObject({ state: 'DELIVERED' });
  });
});
