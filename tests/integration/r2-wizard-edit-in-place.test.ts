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
 * and a renewal ends with its own result as a NEW message after the payment message was
 * closed.
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
   * FIX-10 (batch 2026-10-10): the owner's rule end to end, through the bot and the server
   * together — the bot carries the raw text, the server judges it with the one contract
   * function, and every refusal is the same sentence. Uppercase is folded, never refused,
   * and only the lowercase form is reserved.
   */
  it('refuses through the bot every name the owner’s rule refuses, and keeps the lowercase form of one it allows (FIX-10)', async () => {
    const productId = await product('brief-rule');
    const wizard = 720;
    await tapOn(wizard, `ck:${SEED_IDS.categoryA}.0`);
    await tapOn(wizard, `p:${productId}`);
    const [order] = await draftOrders();
    if (order === undefined) throw new Error('no draft');
    await tapOn(wizard, `j:${order.id}`);

    const refusedNames = [
      'ali', // three
      'a1b2c3d4e5f6g7h8i9j0k', // twenty-one
      'aliserver', // no digit
      '12345678', // no letter
      'علی۱۴۰۳', // Persian
      'ali 2026', // space
      'ali.2026', // dot
      '@ali2026', // at
      'ali😀2026', // emoji
    ];
    let messageId = 4300;
    for (const raw of refusedNames) {
      messageId += 1;
      const refused = await type(raw, messageId);
      expect(refused.replyKey, JSON.stringify(raw)).toBe('bot.username.invalid');
    }
    expect(
      await rows(sql`SELECT 1 FROM service_username_reservations WHERE order_id = ${order.id}`),
      'nothing was reserved for a refused name',
    ).toHaveLength(0);

    const accepted = await type('Maryam_2026', messageId + 1);
    expect(accepted.replyKey).toBe('bot.order.preinvoice');
    expect(
      await rows<{ username: string }>(
        sql`SELECT username FROM service_username_reservations WHERE order_id = ${order.id}`,
      ),
    ).toEqual([{ username: 'maryam_2026' }]);
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

  it('a wallet renewal closes its payment message, then ends with the dedicated Renewal result — never the generic sentence', async () => {
    const service = await activeService('renew');
    const before = await services.findById(tenantA, service.id);

    // The renewal quote is a new message: it becomes the renewal's wizard.
    await tapOn(730, `nr:${service.id}`);
    const quote = calls.find((call) => call.method === 'sendMessage');
    const quoteId = quote?.sentId;
    if (quoteId === null || quoteId === undefined) throw new Error('no renewal quote');
    const renewal = buttonsOf(quote).find((data) => data.startsWith('w:'));
    if (renewal === undefined) throw new Error('no wallet button on the renewal quote');

    await tapOn(quoteId, renewal);
    // Closed in place, with no buttons and no «order paid» sentence.
    expect(edited(quoteId)[0]?.body['text']).toBe(plain(CATALOGUE_FA['bot.service.renew_paid']));
    expect(edited(quoteId)[0]?.body['text']).not.toBe(plain(CATALOGUE_FA['bot.order.settled']));
    expect(buttonsOf(edited(quoteId)[0])).toEqual([]);

    await ctx.container.provisionerLoop.tick();
    const told = await rows<{ kind: string }>(
      sql`SELECT kind FROM customer_notifications WHERE tenant_id = ${tenantA.tenantId}
          AND customer_id = ${maryam}`,
    );
    expect(told.map((row) => row.kind)).toContain('SERVICE_RENEWED');
    expect(told.map((row) => row.kind)).not.toContain('SERVICE_ACTION_SUCCEEDED');

    calls = [];
    await ctx.container.customerNotificationLoop.tick();
    const result = calls.filter((call) => call.method === 'sendMessage').at(-1);
    const text = String(result?.body['text'] ?? '');
    expect(text).toContain('✅ سرویس شما با موفقیت تمدید شد');
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
    // One button, opening the renewed service directly.
    expect(buttonsOf(result)).toEqual([`s:${service.id}`]);
  });

  it('a renewal settled outside the wizard has its payment screen closed BEFORE the result is sent', async () => {
    const service = await activeService('renew-manual');
    await tapOn(740, `nr:${service.id}`);
    const quote = calls.find((call) => call.method === 'sendMessage');
    const quoteId = quote?.sentId;
    if (quoteId === null || quoteId === undefined) throw new Error('no renewal quote');
    const [order] = await rows<{ id: string }>(
      sql`SELECT id FROM orders WHERE purpose = 'RENEW' AND tenant_id = ${tenantA.tenantId}`,
    );
    if (order === undefined) throw new Error('no renewal order');

    // Settled by an operator's hand rather than the wizard: the payment screen is still open.
    const confirmed = await ctx.container.commercialActions.confirm(
      tenantA,
      systemActor('rm'),
      maryam,
      {
        orderId: order.id,
        idempotencyKey: 'rm-confirm',
      },
    );
    await ctx.container.payments.settleFromWallet(tenantA, systemActor('rm'), maryam, {
      idempotencyKey: 'rm-pay',
      orderId: confirmed.id,
    });
    await ctx.container.provisionerLoop.tick();

    calls = [];
    await ctx.container.customerNotificationLoop.tick();
    const closeAt = calls.findIndex(
      (call) => call.method === 'editMessageReplyMarkup' && call.body['message_id'] === quoteId,
    );
    const resultAt = calls.findIndex(
      (call) =>
        call.method === 'sendMessage' &&
        String(call.body['text'] ?? '').includes('✅ سرویس شما با موفقیت تمدید شد'),
    );
    expect(closeAt).toBeGreaterThanOrEqual(0);
    expect(resultAt).toBeGreaterThan(closeAt);
  });
});
