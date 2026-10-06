import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  NexaError,
  PANEL_UNHEALTHY_AFTER_FAILURES,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type OrderId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { DrizzleOperationRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-operation.repository';
import { marzbanOnlineAt, startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import { CANARY, startFake3xUi } from '../support/fake-3xui';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  validatePanelConnection,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';
import { setBucket } from './usage-sync-fixtures';
import { monitorBudgetReserveFor, usageSyncBudgetReserveFor } from '../../apps/api/src/container';

/**
 * The service self-care screens (customer UX completion §G, §H, §P, §Q): the paged list,
 * search within the customer's own services, the card, the note, the refresh, and the
 * delivery card — each driven through the runtime as Telegram would, against a fake
 * Marzban and a fake Telegram that records every request.
 */
const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const MARYAM = '910910';
const REZA = '920920';

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

describe('a customer looks after the services they bought', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: Sent[];
  let reply: (request: IncomingMessage, response: ServerResponse) => void;
  let panel: FakeMarzban;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let operations: DrizzleOperationRepository;
  let panelId: string;
  let maryam: UserId;
  let reza: UserId;
  let owner: ActorContext;
  let updateSeq = 0;

  beforeAll(async () => {
    sent = [];
    telegram = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const rawBuffer = Buffer.concat(chunks);
        const raw = rawBuffer.toString('utf8');
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = { unparseable: true };
        }
        sent.push({ url: request.url ?? '', body, raw });
        reply(request, response);
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
    operations = new DrizzleOperationRepository(ctx.container.database.db);
    sent = [];
    reply = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
    };
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'owner-selfcare',
        roleKeys: ['owner'],
      }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-selfcare-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);
    maryam = await resolve(MARYAM, 'مریم');
    reza = await resolve(REZA, 'رضا');
  });

  async function resolve(telegramUserId: string, firstName: string): Promise<UserId> {
    const resolved = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: firstName },
        botInstanceId: BOT_A,
      },
    );
    return resolved.customer.id;
  }

  async function product(
    key: string,
    spec: { durationDays: number; trafficBytes: bigint } = {
      durationDays: 30,
      trafficBytes: 53_687_091_200n,
    },
    display = EMPTY_PRODUCT_DISPLAY,
  ): Promise<ProductId> {
    const row = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: `پلن ${key}`,
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { ...spec, deviceLimit: null },
        price: money(250_000n, 'IRT'),
        display,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, row.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return row.id;
  }

  async function paidOrder(
    key: string,
    customerId: UserId,
    productId: ProductId,
  ): Promise<OrderId> {
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(key), {
      idempotencyKey: `${key}-draft`,
      customerId,
      productId,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(key), {
      idempotencyKey: `${key}-confirm`,
      customerId,
      orderId: draft.id,
    });
    await ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: `${key}-credit`,
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(key), customerId, {
      idempotencyKey: `${key}-pay`,
      orderId: confirmed.id,
    });
    return confirmed.id;
  }

  async function activeService(
    key: string,
    customerId: UserId = maryam,
    productId?: ProductId,
  ): Promise<{ id: string; username: string }> {
    const orderId = await paidOrder(key, customerId, productId ?? (await product(key)));
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, orderId);
    if (service === undefined || service === null) throw new Error('no service');
    expect(service.state, 'the fixture must start ACTIVE').toBe('ACTIVE');
    return { id: service.id, username: service.providerUsername };
  }

  const customerUpdate = (payload: Record<string, unknown>, telegramUserId = MARYAM) => {
    updateSeq += 1;
    return {
      idempotencyKey: `bot-update-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      update: { update_id: updateSeq, ...payload },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'x' },
    };
  };
  const tap = (data: string, telegramUserId = MARYAM) =>
    customerUpdate(
      {
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'x' },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: Number(telegramUserId), type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId,
    );
  const text = (value: string, telegramUserId = MARYAM) =>
    customerUpdate(
      {
        message: {
          message_id: updateSeq,
          date: 0,
          chat: { id: Number(telegramUserId), type: 'private' },
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'x' },
          text: value,
        },
      },
      telegramUserId,
    );
  const runtime = () => ctx.container.botRuntime;
  const handle = (update: ReturnType<typeof customerUpdate>) =>
    runtime().handle(tenantA, systemActor('bot'), update);
  const messages = () => sent.filter((one) => one.url.includes('/sendMessage'));
  const last = () => messages()[messages().length - 1];
  const lastText = () => String(last()?.body['text'] ?? '');
  const lastMarkup = () => JSON.stringify(last()?.body['reply_markup'] ?? {});
  // Owner spec §2.3: a page, a card from the list and the way back EDIT the tapped message.
  const drawn = () =>
    sent.filter((one) => one.url.includes('/sendMessage') || one.url.includes('/editMessageText'));
  const lastDrawn = () => drawn()[drawn().length - 1];
  const lastDrawnText = () => String(lastDrawn()?.body['text'] ?? '');
  const lastDrawnMarkup = () => JSON.stringify(lastDrawn()?.body['reply_markup'] ?? {});
  /** A tap on one particular message — the list the bot sent, say. */
  const tapOn = (data: string, messageId: number) => {
    const update = tap(data);
    const query = (
      update.update as unknown as { callback_query: { message: { message_id: number } } }
    ).callback_query;
    query.message.message_id = messageId;
    return update;
  };
  const buttonsOf = (markup: string): string[] =>
    [...markup.matchAll(/"callback_data":"([^"]+)"/g)].map((m) => m[1] as string);

  // =========================================================================
  // §G — the list
  // =========================================================================
  describe('the services list', () => {
    it('renders the approved text, one button per REAL username, and the bottom controls', async () => {
      const service = await activeService('list-one');
      const result = await handle(text('/services'));
      expect(result.replyKey).toBe('bot.service.list');
      expect(lastText()).toBe(
        [
          '✨ اشتراک های خریداری شده توسط شما',
          '',
          '⚠️ برای مشاهده اطلاعات و مدیریت روی نام کاربری کلیک کنید',
          '',
          '🔴 همچنین برای پیدا کردن سریع سرویس خود و مدیریت آن می توانید از دکمه "🔎 جستجو سرویس" استفاده کنید',
          '',
          '📄 صفحه 1 از 1 | 📊 کل: 1 سرویس',
        ].join('\n'),
      );
      const markup = lastMarkup();
      // Batch 01 item 3: the marker and the colour of the service's derived status.
      expect(markup).toContain(`"text":"🟢 ${service.username}"`);
      expect(markup).toContain('"style":"success"');
      expect(buttonsOf(markup)).toEqual([`sv:${service.id}`, 'ss:', 'ss:', 'sl:1', 'mm:']);
      expect(markup).toContain('جستجو نام کاربری');
      expect(markup).toContain('🔎 جستجو');
      expect(markup).toContain('1/1');
      expect(markup).toContain('🔙 بازگشت به منوی اصلی');
    });

    /*
     * Batch 01 item 3: the colour is DERIVED from the row's facts — never stored, never
     * chosen by hand — so a service past its deadline or out of traffic is red while its
     * state still reads ACTIVE, and the list and the card follow a refresh that reads usage.
     */
    it('colours each service from its state, deadline and read usage, and follows a refresh', async () => {
      const productId = await product('colour');
      const fresh = await activeService('colour-fresh', maryam, productId);
      const lapsed = await activeService('colour-lapsed', maryam, productId);
      const used = await activeService('colour-used', maryam, productId);
      // The deadline has passed but no sweep has run: the row still says ACTIVE.
      await ctx.container.database.db.execute(
        sql`UPDATE services SET expires_at = now() - interval '1 hour' WHERE id = ${lapsed.id}`,
      );
      const cellOf = (markup: string, id: string) => {
        const rows = (JSON.parse(markup) as { inline_keyboard: Record<string, unknown>[][] })
          .inline_keyboard;
        return rows.flat().find((cell) => cell.callback_data === `sv:${id}`);
      };

      await handle(text('/services'));
      expect(cellOf(lastMarkup(), fresh.id)).toMatchObject({
        text: `🟢 ${fresh.username}`,
        style: 'success',
      });
      expect(cellOf(lastMarkup(), lapsed.id)).toMatchObject({
        text: `🔴 ${lapsed.username}`,
        style: 'danger',
      });
      expect(cellOf(lastMarkup(), used.id)).toMatchObject({ style: 'success' });
      expect((await services.findById(tenantA, lapsed.id))?.state).toBe('ACTIVE');

      // The lapsed card says so in red too, from the same table.
      await handle(tap(`sv:${lapsed.id}`));
      expect(lastDrawnText()).toContain('📊وضعیت سرویس: 🔴 منقضی شده');

      // A refresh reads the panel: the allowance is used up. Card and list turn red.
      const user = panel.users.get(used.username);
      if (user === undefined) throw new Error('no panel user');
      user.usedTraffic = 53_687_091_200;
      await ctx.container.database.db.execute(
        sql`UPDATE services SET usage_synced_at = now() - interval '10 minutes' WHERE id = ${used.id}`,
      );
      await handle(tap(`rs:${used.id}`));
      expect(lastDrawnText()).toContain('📊وضعیت سرویس: 🔴 حجم تمام شده');
      await handle(text('/services'));
      expect(cellOf(lastMarkup(), used.id)).toMatchObject({
        text: `🔴 ${used.username}`,
        style: 'danger',
      });
      expect((await services.findById(tenantA, used.id))?.state).toBe('ACTIVE');
    });

    it('lists the customer’s OWN services and nobody else’s', async () => {
      const mine = await activeService('list-mine', maryam);
      const theirs = await activeService('list-theirs', reza);
      await handle(text('/services'));
      const markup = lastMarkup();
      expect(markup).toContain(`sv:${mine.id}`);
      expect(markup).not.toContain(theirs.id);
      expect(markup).not.toContain(theirs.username);
    });

    it('pages ten at a time, in a stable order, and clamps a stale page', async () => {
      const productId = await product('list-page');
      const ids: string[] = [];
      for (let i = 0; i < 11; i += 1) {
        ids.push((await activeService(`page-${String(i)}`, maryam, productId)).id);
      }
      await handle(text('/services'));
      expect(lastText()).toContain('📄 صفحه 1 از 2 | 📊 کل: 11 سرویس');
      const first = buttonsOf(lastMarkup());
      expect(first.filter((b) => b.startsWith('sv:'))).toHaveLength(10);
      expect(first).toContain('sl:2');
      expect(first).not.toContain('sl:0');

      await handle(tap('sl:2'));
      expect(lastDrawnText()).toContain('📄 صفحه 2 از 2 | 📊 کل: 11 سرویس');
      const second = buttonsOf(lastDrawnMarkup());
      expect(second.filter((b) => b.startsWith('sv:'))).toHaveLength(1);
      expect(second).toContain('sl:1');
      expect(second).not.toContain('sl:3');
      // Newest first: the last created service leads page 1, the first created ends page 2.
      expect(first[0]).toBe(`sv:${ids[10] ?? ''}`);
      expect(second[0]).toBe(`sv:${ids[0] ?? ''}`);

      // A stale button from an older message lands on the last real page.
      await handle(tap('sl:9'));
      expect(lastDrawnText()).toContain('📄 صفحه 2 از 2');
      const crafted = await handle(tap('sl:abc'));
      expect(crafted.intent).toBe('UNSUPPORTED');
    });

    /*
     * Owner spec §2.3: «سرویس‌های من» is ONE message. Selecting a service edits the list
     * into its card; the card's back edits it into the list again; nothing new is sent. A
     * stale card tap (a service no longer the customer's) still edits that message, and
     * keeps the way back to the list on it.
     */
    it('opens a card and goes back to the list in the SAME message', async () => {
      const service = await activeService('same-message');
      await handle(text('/services'));
      const listMessage = 7001;
      sent = [];
      await handle(tapOn(`sv:${service.id}`, listMessage));
      expect(messages()).toHaveLength(0);
      const opened = lastDrawn();
      expect(opened?.url).toContain('/editMessageText');
      expect(opened?.body['message_id']).toBe(listMessage);
      expect(buttonsOf(lastDrawnMarkup())).toContain('sl:1');

      sent = [];
      await handle(tapOn('sl:1', listMessage));
      expect(messages()).toHaveLength(0);
      expect(lastDrawn()?.url).toContain('/editMessageText');
      expect(lastDrawn()?.body['message_id']).toBe(listMessage);
      expect(lastDrawnText()).toContain('✨ اشتراک های خریداری شده توسط شما');
      expect(buttonsOf(lastDrawnMarkup())).toContain(`sv:${service.id}`);
    });

    it('answers a stale card tap in place, with the way back to the list', async () => {
      const theirs = await activeService('stale-theirs', reza);
      sent = [];
      const result = await handle(tap(`sv:${theirs.id}`));
      expect(result.replyKey).toBe('bot.service.not_found');
      expect(messages()).toHaveLength(0);
      expect(lastDrawn()?.url).toContain('/editMessageText');
      expect(buttonsOf(lastDrawnMarkup())).toEqual(['sl:1']);
      expect(lastDrawnText()).not.toContain(theirs.username);
    });

    it('answers a customer with no services with the empty key and a way back', async () => {
      const result = await handle(text('/services'));
      expect(result.replyKey).toBe('bot.service.list_empty');
      expect(buttonsOf(lastMarkup())).toEqual(['mm:']);
    });
  });

  // =========================================================================
  // §G — search
  // =========================================================================
  describe('searching by username', () => {
    it('finds by prefix within the customer’s own services only', async () => {
      const mine = await activeService('search-mine', maryam);
      const theirs = await activeService('search-theirs', reza);
      const opened = await handle(tap('ss:'));
      expect(opened.replyKey).toBe('bot.service.search_prompt');

      await handle(text(mine.username.slice(0, 4)));
      expect(last()?.body['text']).toContain('🔎 نتایج جستجو برای');
      expect(lastMarkup()).toContain(`sv:${mine.id}`);
      expect(lastMarkup()).not.toContain(theirs.id);

      // The EXACT username of another customer's service: nothing, and no oracle.
      await handle(tap('ss:'));
      const foreign = await handle(text(theirs.username));
      expect(foreign.replyKey).toBe('bot.service.search_none');
      expect(lastMarkup()).not.toContain(theirs.id);
    });

    it('refuses an over-long term, and a typed message with no window open is not a search', async () => {
      await activeService('search-long');
      await handle(tap('ss:'));
      const long = await handle(text('a'.repeat(65)));
      expect(long.replyKey).toBe('bot.service.search_invalid');
      // The window closed on that read; the next plain message falls through.
      const stray = await handle(text('nx'));
      expect(stray.replyKey).toBe('bot.unknown_command');
    });

    it('escapes LIKE wildcards: a percent sign matches nothing rather than everything', async () => {
      await activeService('search-wild');
      await handle(tap('ss:'));
      const result = await handle(text('%'));
      expect(result.replyKey).toBe('bot.service.search_none');
    });
  });

  // =========================================================================
  // §H — the card
  // =========================================================================
  describe('the service card', () => {
    it('renders the approved card from the rows, with the capability-gated buttons', async () => {
      const productId = await product(
        'card',
        { durationDays: 30, trafficBytes: 53_687_091_200n },
        {
          ...EMPTY_PRODUCT_DISPLAY,
          serviceLocationLabel: 'مولتی لوکیشن',
        },
      );
      const service = await activeService('card', maryam, productId);
      const result = await handle(tap(`s:${service.id}`));
      expect(result.replyKey).toBe('bot.service.card');
      const body = lastText();
      expect(body).toContain('📊وضعیت سرویس: 🟢 فعال');
      expect(body).toContain(`👤 نام سرویس: ${service.username}`);
      expect(body).toContain('🌍 موقعیت سرویس: 🚀 مولتی لوکیشن');
      expect(body).toContain('📦 نام محصول: پلن card');
      expect(body).toContain('🟩 ترافیک: 50 گیگابایت');
      // The create returned the panel's figure, so usage is KNOWN (0), not unread.
      expect(body).toContain('📥 حجم مصرفی: 0 گیگابایت');
      expect(body).toContain('💢 حجم باقی مانده: 50 گیگابایت (100%)');
      expect(body).toMatch(/📅 تاریخ اتمام: 14\d\d\/\d\d\/\d\d \d\d:\d\d \(30 روز\)/u);
      expect(body).toContain('📶 آخرین زمان اتصال شما: در دسترس نیست');
      expect(body).not.toContain('متصل نشده');
      expect(body).not.toContain('{');
      // Rotation is off (flag), so neither the button nor the hint about it is drawn.
      expect(body).not.toContain('تغییر لینک');

      const buttons = buttonsOf(lastMarkup());
      // No `t:`: a customer cannot end a service (WP15 G1). Suspend (`u:`) stays. An
      // ACTIVE, delivered, paid service with nothing pending may change hands (Package F),
      // so «🔄 انتقال سرویس» (`ta:`) is drawn on the refund request's row, above the way back.
      expect(buttons).toEqual([
        `rs:${service.id}`,
        `r:${service.id}`,
        `nt:${service.id}`,
        `n:${service.id}`,
        `u:${service.id}`,
        `ta:${service.id}`,
        'sl:1',
      ]);
      const markup = lastMarkup();
      for (const label of [
        '♻️ بروزرسانی اطلاعات',
        '🔗 لینک اشتراک',
        '📝 تغییر یادداشت',
        '💊 تمدید سرویس',
        '❌ خاموش کردن اکانت',
        '🏠 بازگشت به لیست سرویس ها',
      ]) {
        expect(markup, label).toContain(label);
      }
      expect(markup).not.toContain('➕ خرید حجم اضافه');
    });

    it('never shows another customer’s card, by id', async () => {
      const theirs = await activeService('card-theirs', reza);
      const result = await handle(tap(`s:${theirs.id}`));
      expect(result.replyKey).toBe('bot.service.not_found');
      expect(lastText()).not.toContain(theirs.username);
    });

    it('keeps unlimited and unread apart from zero', async () => {
      const unlimited = await product('card-unlimited', { durationDays: 0, trafficBytes: 0n });
      const service = await activeService('card-unlimited', maryam, unlimited);
      await ctx.container.database.db.execute(
        sql`UPDATE services SET traffic_used_bytes = 0, usage_synced_at = NULL WHERE id = ${service.id}`,
      );
      // Pre-support A2: opening the card reads the panel. A panel that cannot answer
      // leaves the figure unread, which is the state this test draws.
      panel.forget(service.username);
      await handle(tap(`s:${service.id}`));
      const body = lastText();
      expect(body).toContain('🟩 ترافیک: نامحدود');
      expect(body).toContain('📥 حجم مصرفی: هنوز از سرور خوانده نشده');
      expect(body).toContain('💢 حجم باقی مانده: نامحدود');
      expect(body).toContain('📅 تاریخ اتمام: بدون محدودیت زمانی');
      expect(body).not.toContain('0 بایت');
    });

    it('shows the switch-on button, not the switch-off one, for a suspended service', async () => {
      const service = await activeService('card-suspended');
      await handle(tap(`u:${service.id}`));
      await ctx.container.database.db.execute(
        sql`UPDATE provisioning_operations SET next_attempt_at = now() - interval '1 hour'`,
      );
      await ctx.container.provisionerLoop.tick();
      const row = await services.findById(tenantA, service.id);
      expect(row?.state).toBe('SUSPENDED');
      await handle(tap(`s:${service.id}`));
      expect(lastText()).toContain('📊وضعیت سرویس: 🔴 خاموش');
      const buttons = buttonsOf(lastMarkup());
      expect(buttons).toContain(`e:${service.id}`);
      expect(buttons).not.toContain(`u:${service.id}`);
      expect(buttons, 'a suspended service cannot be read').not.toContain(`rs:${service.id}`);
      expect(lastMarkup()).toContain('✅ روشن کردن اکانت');
    });
  });

  // =========================================================================
  // §H4 — the note
  // =========================================================================
  describe('the customer’s note', () => {
    it('sets, shows, and clears a note on the customer’s own service', async () => {
      const service = await activeService('note');
      sent = [];
      const asked = await handle(tap(`nt:${service.id}`));
      expect(asked.replyKey).toBe('bot.service.note_prompt');
      // Round N (F4): the prompt replaces the card in place, with the way back to it.
      expect(messages()).toHaveLength(0);
      const prompt = sent.filter((one) => one.url.includes('/editMessageText')).at(-1);
      expect(String(prompt?.body['text'])).toContain('حداکثر 200 نویسه');
      expect(JSON.stringify(prompt?.body['reply_markup'])).toContain(`sv:${service.id}`);

      // The answer IS the card: the note as it now stands, and the saved line on it.
      const saved = await handle(text('  گوشی مادر  '));
      expect(saved.replyKey).toBe('bot.service.card');
      expect(lastText()).toContain('📝 یادداشت: گوشی مادر');
      expect(lastText()).toContain('📝 یادداشت ذخیره شد.');
      expect((await services.findById(tenantA, service.id))?.customerNote).toBe('گوشی مادر');
      await handle(tap(`s:${service.id}`));
      expect(lastText()).toContain('📝 یادداشت: گوشی مادر');
      expect(lastText()).not.toContain('📝 یادداشت ذخیره شد.');

      await handle(tap(`nt:${service.id}`));
      const cleared = await handle(text('-'));
      expect(cleared.replyKey).toBe('bot.service.card');
      expect(lastText()).toContain('📝 یادداشت حذف شد.');
      expect((await services.findById(tenantA, service.id))?.customerNote).toBeNull();
    });

    it('bounds the note and strips control characters', async () => {
      const service = await activeService('note-bound');
      await handle(tap(`nt:${service.id}`));
      const saved = await handle(text('a\u0007b\n\nc'));
      expect(saved.replyKey).toBe('bot.service.card');
      expect((await services.findById(tenantA, service.id))?.customerNote).toBe('a b c');
      await handle(tap(`nt:${service.id}`));
      const long = await handle(text('x'.repeat(250)));
      expect(long.replyKey).toBe('bot.service.card');
      expect((await services.findById(tenantA, service.id))?.customerNote).toHaveLength(200);
    });

    it('opens no window on another customer’s service, and writes nothing to it', async () => {
      const theirs = await activeService('note-theirs', reza);
      const asked = await handle(tap(`nt:${theirs.id}`));
      expect(asked.replyKey).toBe('bot.service.not_found');
      const stray = await handle(text('hacked'));
      expect(stray.replyKey).toBe('bot.unknown_command');
      expect((await services.findById(tenantA, theirs.id))?.customerNote).toBeNull();
    });

    it('a note prompt is one question: opening a search closes it', async () => {
      const service = await activeService('note-supersede');
      await handle(tap(`nt:${service.id}`));
      await handle(tap('ss:'));
      const result = await handle(text('zzzz'));
      expect(result.replyKey).toBe('bot.service.search_none');
      expect((await services.findById(tenantA, service.id))?.customerNote).toBeNull();
    });
  });

  // =========================================================================
  // §H1 — the refresh
  // =========================================================================
  describe('«♻️ بروزرسانی اطلاعات»', () => {
    /*
     * R3 item 7: one bounded read on the tap, and the SAME card edited with the answer —
     * no «request registered», no «result later», no operation and no queued message.
     */
    const edits = () => sent.filter((one) => one.url.includes('/editMessageText'));
    const answers = () => sent.filter((one) => one.url.includes('/answerCallbackQuery'));
    const reads = (username: string) =>
      panel.requests.filter((one) => one.method === 'GET' && one.path.includes(username)).length;

    it('reads the panel on the tap and edits the SAME card with what it said', async () => {
      const service = await activeService('refresh');
      const user = panel.users.get(service.username);
      if (user === undefined) throw new Error('no panel user');
      user.usedTraffic = 5_368_709_120;
      await ctx.container.database.db.execute(
        sql`UPDATE services SET usage_synced_at = now() - interval '10 minutes' WHERE id = ${service.id}`,
      );
      sent = [];

      const update = tap(`rs:${service.id}`);
      const result = await handle(update);
      expect(result.replyKey).toBe('bot.service.card');
      const row = await services.findById(tenantA, service.id);
      expect(row?.trafficUsedBytes).toBe(5_368_709_120n);
      // The card the button is on — its own chat and message id — rewritten in place.
      expect(messages(), 'no new message').toHaveLength(0);
      expect(edits()).toHaveLength(1);
      const tapped = (
        update.update as unknown as { callback_query: { message: { message_id: number } } }
      ).callback_query.message.message_id;
      expect(edits()[0]?.body['message_id']).toBe(tapped);
      expect(edits()[0]?.body['chat_id']).toBe(MARYAM);
      expect(String(edits()[0]?.body['text'])).toContain('📥 حجم مصرفی: 5 گیگابایت');
      expect(JSON.stringify(edits()[0]?.body['reply_markup'])).toContain(`rs:${service.id}`);
      // A read, not an operation: nothing queued, nobody told anything later.
      expect(
        (await operations.listForService(tenantA, service.id, 50)).filter(
          (operation) => operation.type === 'SYNC_USAGE',
        ),
      ).toHaveLength(0);
      const announced = await ctx.container.database.db.execute(
        sql`SELECT kind FROM customer_notifications WHERE tenant_id = ${tenantA.tenantId}`,
      );
      expect(announced.rows).toHaveLength(0);

      // A second tap inside the minimum interval redraws the card and asks the panel nothing.
      const before = reads(service.username);
      sent = [];
      const again = await handle(tap(`rs:${service.id}`));
      expect(again.replyKey).toBe('bot.service.card');
      expect(reads(service.username)).toBe(before);
      expect(edits()).toHaveLength(1);
      expect(messages()).toHaveLength(0);
    });

    it('a read the panel refuses leaves the card intact and answers with a notice', async () => {
      const service = await activeService('refresh-fail');
      await ctx.container.database.db.execute(
        sql`UPDATE services SET traffic_used_bytes = 1024, usage_synced_at = now() - interval '10 minutes' WHERE id = ${service.id}`,
      );
      panel.forget(service.username);
      sent = [];
      const result = await handle(tap(`rs:${service.id}`));
      expect(result.replyKey).toBeNull();
      const row = await services.findById(tenantA, service.id);
      expect(row?.trafficUsedBytes).toBe(1024n);
      expect(row?.state).toBe('ACTIVE');
      // Nothing edited, nothing sent: only the button's own notice.
      expect(edits()).toHaveLength(0);
      expect(messages()).toHaveLength(0);
      expect(answers()).toHaveLength(1);
      expect(String(answers()[0]?.body['text'])).toContain('خواندن اطلاعات از سرور ممکن نشد');
      expect(
        (await operations.listForService(tenantA, service.id, 50)).filter(
          (operation) => operation.type === 'SYNC_USAGE',
        ),
      ).toHaveLength(0);
    });

    it('two concurrent refreshes of one service make exactly ONE panel read', async () => {
      /*
       * Codex review of #110, P1: both taps read the same stale `usage_synced_at` and both
       * passed the interval check. The reservation is a conditional UPDATE in the
       * admission transaction, so the second tap waits on the first's row lock, finds the
       * read taken, and redraws the card from what is stored.
       */
      const service = await activeService('refresh-race');
      await ctx.container.database.db.execute(
        sql`UPDATE services SET usage_synced_at = now() - interval '10 minutes' WHERE id = ${service.id}`,
      );
      const before = reads(service.username);
      sent = [];
      /*
       * The panel's answer is held, so the first read is in flight — its own row not yet
       * written — while the second tap arrives. Released once the second tap has either
       * finished without the panel or reached it too.
       */
      const release = panel.holdUserReads();
      let settled = 0;
      const taps = [handle(tap(`rs:${service.id}`)), handle(tap(`rs:${service.id}`))].map((turn) =>
        turn.finally(() => void (settled += 1)),
      );
      const deadline = Date.now() + 10_000;
      while (settled === 0 && reads(service.username) - before < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      release();
      const results = await Promise.all(taps);
      expect(reads(service.username) - before, 'one read of the panel, not two').toBe(1);
      expect(results.map((one) => one.replyKey)).toEqual(['bot.service.card', 'bot.service.card']);
      const [marker] = (
        await ctx.container.database.db.execute(
          sql`SELECT usage_refresh_started_at FROM services WHERE id = ${service.id}`,
        )
      ).rows as { usage_refresh_started_at: Date | null }[];
      expect(marker?.usage_refresh_started_at, 'the reservation is given back').toBeNull();
    });

    it('reserves a read only when none is in flight and the figure is not fresh', async () => {
      /*
       * The reservation's three conditions, each at a chosen instant: the second tap that
       * waited on the first's row lock is judged by exactly these, whichever of them the
       * first tap's commit made true.
       */
      const service = await activeService('refresh-reserve');
      const now = new Date();
      const minutes = (n: number) => new Date(now.getTime() - n * 60_000);
      const reserve = (syncedBefore: Date, inFlightBefore: Date) =>
        ctx.container.uow.run(tenantA, async (tx) =>
          services.reserveUsageRefresh(
            tenantA,
            service.id,
            { now, syncedBefore, inFlightBefore },
            tx,
          ),
        );
      const set = (synced: Date | null, started: Date | null) =>
        ctx.container.database.db.execute(
          sql`UPDATE services SET usage_synced_at = ${synced?.toISOString() ?? null},
                                  usage_refresh_started_at = ${started?.toISOString() ?? null}
               WHERE id = ${service.id}`,
        );
      // Read a minute ago, the interval is five: fresh, nothing is dialled.
      await set(minutes(1), null);
      expect(await reserve(minutes(5), minutes(3))).toBe(false);
      // Read ten minutes ago, nothing in flight: reserved.
      await set(minutes(10), null);
      expect(await reserve(minutes(5), minutes(3))).toBe(true);
      // Now in flight since `now`: a second reservation is refused.
      expect(await reserve(minutes(5), minutes(3))).toBe(false);
      // In flight for longer than a read can take: presumed dead, and taken over.
      await set(minutes(10), minutes(4));
      expect(await reserve(minutes(5), minutes(3))).toBe(true);
    });

    it('a failed read gives the reservation back, so the next tap may try again', async () => {
      const service = await activeService('refresh-retry');
      await ctx.container.database.db.execute(
        sql`UPDATE services SET usage_synced_at = now() - interval '10 minutes' WHERE id = ${service.id}`,
      );
      const user = panel.users.get(service.username);
      if (user === undefined) throw new Error('no panel user');
      panel.forget(service.username);
      expect((await handle(tap(`rs:${service.id}`))).replyKey).toBeNull();
      // The account is back; the very next tap reads it rather than finding a stale hold.
      (panel.users as Map<string, typeof user>).set(service.username, user);
      const before = reads(service.username);
      expect((await handle(tap(`rs:${service.id}`))).replyKey).toBe('bot.service.card');
      expect(reads(service.username) - before).toBe(1);
    });

    it('cannot be asked for another customer’s service', async () => {
      const theirs = await activeService('refresh-theirs', reza);
      const before = reads(theirs.username);
      sent = [];
      const result = await handle(tap(`rs:${theirs.id}`));
      expect(result.replyKey).toBeNull();
      expect(reads(theirs.username)).toBe(before);
      expect(edits()).toHaveLength(0);
      expect(String(answers()[0]?.body['text'])).toContain('این سرویس در دسترس شما نیست');
      expect(await operations.listForService(tenantA, theirs.id, 50)).toEqual(
        expect.not.arrayContaining([expect.objectContaining({ type: 'SYNC_USAGE' })]),
      );
    });
  });

  // =========================================================================
  // Pre-support A2 — opening a card makes the bounded live read
  // =========================================================================
  describe('opening a card refreshes it, inside the refresh button’s bounds', () => {
    const answers = () => sent.filter((one) => one.url.includes('/answerCallbackQuery'));
    const reads = (username: string) =>
      panel.requests.filter((one) => one.method === 'GET' && one.path.includes(username)).length;
    const stale = (id: string, usedBytes = 2_147_483_648) =>
      ctx.container.database.db.execute(
        sql`UPDATE services SET traffic_used_bytes = ${usedBytes},
                                usage_synced_at = now() - interval '10 minutes'
             WHERE id = ${id}`,
      );
    const usedOnPanel = (username: string, bytes: number) => {
      const user = panel.users.get(username);
      if (user === undefined) throw new Error('no panel user');
      user.usedTraffic = bytes;
    };
    const noFailureNotice = () => {
      for (const answer of answers()) {
        expect(String(answer.body['text'] ?? '')).not.toContain('خواندن اطلاعات از سرور ممکن نشد');
      }
    };

    it('opening a card makes one panel read and shows the fresh figure', async () => {
      const service = await activeService('open-fresh');
      await stale(service.id);
      usedOnPanel(service.username, 5_368_709_120);
      const before = reads(service.username);
      sent = [];
      const result = await handle(tap(`s:${service.id}`));
      expect(result.replyKey).toBe('bot.service.card');
      expect(reads(service.username) - before, 'one read of the panel').toBe(1);
      expect(lastText()).toContain('📥 حجم مصرفی: 5 گیگابایت');
      expect((await services.findById(tenantA, service.id))?.trafficUsedBytes).toBe(5_368_709_120n);
      // The ♻️ button stays on the opened card.
      expect(buttonsOf(lastMarkup())).toContain(`rs:${service.id}`);
      // A read, not an operation.
      expect(
        (await operations.listForService(tenantA, service.id, 50)).filter(
          (operation) => operation.type === 'SYNC_USAGE',
        ),
      ).toHaveLength(0);
    });

    it('opening from the list (sv:) reads too, and edits the list message with the answer', async () => {
      const service = await activeService('open-from-list');
      await stale(service.id);
      usedOnPanel(service.username, 5_368_709_120);
      const before = reads(service.username);
      sent = [];
      await handle(tapOn(`sv:${service.id}`, 7002));
      expect(reads(service.username) - before).toBe(1);
      expect(messages()).toHaveLength(0);
      expect(lastDrawn()?.url).toContain('/editMessageText');
      expect(lastDrawn()?.body['message_id']).toBe(7002);
      expect(lastDrawnText()).toContain('📥 حجم مصرفی: 5 گیگابایت');
    });

    it('opening twice within 60 s makes ONE panel read', async () => {
      const service = await activeService('open-twice');
      await stale(service.id);
      const before = reads(service.username);
      expect((await handle(tap(`s:${service.id}`))).replyKey).toBe('bot.service.card');
      expect((await handle(tapOn(`sv:${service.id}`, 7003))).replyKey).toBe('bot.service.card');
      expect(reads(service.username) - before, 'the second open is inside the interval').toBe(1);
    });

    it('opening while a tap’s read is in flight makes no second read', async () => {
      const service = await activeService('open-in-flight');
      await stale(service.id);
      const before = reads(service.username);
      const release = panel.holdUserReads();
      try {
        const tapped = handle(tap(`rs:${service.id}`));
        const deadline = Date.now() + 10_000;
        while (reads(service.username) - before < 1 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(reads(service.username) - before, 'the tap’s read is in flight').toBe(1);
        sent = [];
        const opened = await handle(tap(`s:${service.id}`));
        expect(opened.replyKey).toBe('bot.service.card');
        expect(reads(service.username) - before, 'the open dialled nothing').toBe(1);
        // The stored figure, drawn without a notice.
        expect(lastText()).toContain('📥 حجم مصرفی: 2 گیگابایت');
        noFailureNotice();
        release();
        expect((await tapped).replyKey).toBe('bot.service.card');
      } finally {
        release();
      }
    });

    it('a panel failure draws the stored card, with no error and no notice', async () => {
      const service = await activeService('open-panel-down');
      await stale(service.id);
      panel.forget(service.username);
      const before = reads(service.username);
      sent = [];
      const result = await handle(tap(`s:${service.id}`));
      expect(result.replyKey).toBe('bot.service.card');
      expect(reads(service.username) - before, 'the panel was asked').toBe(1);
      expect(lastText()).toContain('📥 حجم مصرفی: 2 گیگابایت');
      noFailureNotice();
      const row = await services.findById(tenantA, service.id);
      expect(row?.trafficUsedBytes).toBe(2_147_483_648n);
      expect(row?.state).toBe('ACTIVE');
    });

    it('an exhausted probe budget draws the stored card and dials nothing', async () => {
      const service = await activeService('open-no-budget');
      await stale(service.id);
      // The tenant's ONE bucket, empty, and refilled as of a moment still to come.
      await setBucket(ctx, tenantA.tenantId, 0, new Date(Date.now() + 3_600_000));
      const before = reads(service.username);
      sent = [];
      const result = await handle(tap(`s:${service.id}`));
      expect(result.replyKey).toBe('bot.service.card');
      expect(reads(service.username) - before, 'no budget, no read').toBe(0);
      expect(lastText()).toContain('📥 حجم مصرفی: 2 گیگابایت');
      noFailureNotice();
      const [marker] = (
        await ctx.container.database.db.execute(
          sql`SELECT usage_refresh_started_at FROM services WHERE id = ${service.id}`,
        )
      ).rows as { usage_refresh_started_at: Date | null }[];
      expect(marker?.usage_refresh_started_at, 'the reservation rolled back').toBeNull();
    });

    const withRefresh = async (replacement: () => Promise<never>, body: () => Promise<void>) => {
      const deps = (runtime() as unknown as { deps: { serviceRefresh: { refresh: unknown } } })
        .deps;
      const original = deps.serviceRefresh.refresh;
      deps.serviceRefresh.refresh = replacement;
      try {
        await body();
      } finally {
        deps.serviceRefresh.refresh = original;
      }
    };

    /** The runtime's logger, replaced for one test by one that records what it is told. */
    const withLogger = async (
      body: (logged: { context: Record<string, unknown>; message: string }[]) => Promise<void>,
    ) => {
      const deps = runtime() as unknown as {
        deps: { logger?: { error: (context: Record<string, unknown>, message: string) => void } };
      };
      const original = deps.deps.logger;
      const logged: { context: Record<string, unknown>; message: string }[] = [];
      (deps.deps as { logger: unknown }).logger = {
        error: (context: Record<string, unknown>, message: string) => {
          logged.push({ context, message });
        },
      };
      try {
        await body(logged);
      } finally {
        (deps.deps as { logger: unknown }).logger = original;
      }
    };

    it('an expected refusal thrown by the refresh opens the stored card, silently', async () => {
      const service = await activeService('open-refresh-refused');
      await stale(service.id);
      await withLogger(async (logged) => {
        await withRefresh(
          () =>
            Promise.reject(
              new NexaError({
                kind: 'PERMISSION_DENIED',
                code: 'platform.permission_denied',
                message: 'denied',
              }),
            ),
          async () => {
            sent = [];
            const result = await handle(tap(`s:${service.id}`));
            expect(result.replyKey).toBe('bot.service.card');
            expect(lastText()).toContain('📥 حجم مصرفی: 2 گیگابایت');
            noFailureNotice();
          },
        );
        expect(logged, 'an expected refusal is not reported').toHaveLength(0);
      });
    });

    it('an unexpected error thrown by the refresh opens the stored card, and is reported', async () => {
      const service = await activeService('open-refresh-throws');
      await stale(service.id);
      const thrown = new Error('database unreadable');
      await withLogger(async (logged) => {
        await withRefresh(
          () => Promise.reject(thrown),
          async () => {
            sent = [];
            const result = await handle(tap(`s:${service.id}`));
            expect(result.replyKey).toBe('bot.service.card');
            expect(lastText()).toContain('📥 حجم مصرفی: 2 گیگابایت');
            noFailureNotice();
          },
        );
        expect(logged).toHaveLength(1);
        expect(logged[0]?.context).toEqual({
          err: thrown,
          serviceId: service.id,
          tenantId: tenantA.tenantId,
        });
      });
    });

    it('a panel whose stored credential cannot be decrypted still opens the stored card', async () => {
      /*
       * The real case behind the rule above: before the read on open, a card on such a
       * panel opened; the read must not take that away. The cipher's refusal is INTERNAL and
       * not retryable, so it is reported rather than silent.
       */
      const service = await activeService('open-bad-credential');
      await stale(service.id);
      await ctx.container.database.db.execute(
        sql`UPDATE panel_credentials
               SET username_ciphertext = 'fixture-not-a-real-ciphertext',
                   password_ciphertext = 'fixture-not-a-real-ciphertext'
             WHERE panel_id = ${panelId}`,
      );
      const before = reads(service.username);
      await withLogger(async (logged) => {
        sent = [];
        const result = await handle(tap(`s:${service.id}`));
        expect(result.replyKey).toBe('bot.service.card');
        expect(lastText()).toContain('📥 حجم مصرفی: 2 گیگابایت');
        noFailureNotice();
        expect(reads(service.username) - before, 'nothing was dialled').toBe(0);
        expect(logged).toHaveLength(1);
        expect(logged[0]?.context['serviceId']).toBe(service.id);
      });
    });

    it('a panel the monitor has confirmed unreachable is not dialled on open; ♻️ still reads', async () => {
      const service = await activeService('open-unreachable');
      await stale(service.id);
      await ctx.container.database.db.execute(
        sql`UPDATE panel_health SET state = 'UNREACHABLE', failure = 'TIMEOUT',
                                    unusable_streak = ${PANEL_UNHEALTHY_AFTER_FAILURES},
                                    checked_at = now()
             WHERE panel_id = ${panelId}`,
      );
      const before = reads(service.username);
      sent = [];
      const opened = await handle(tap(`s:${service.id}`));
      expect(opened.replyKey).toBe('bot.service.card');
      expect(reads(service.username) - before, 'an open does not dial a down panel').toBe(0);
      expect(lastText()).toContain('📥 حجم مصرفی: 2 گیگابایت');
      noFailureNotice();
      // The button the customer pressed to ask for a read keeps today's behaviour.
      expect((await handle(tap(`rs:${service.id}`))).replyKey).toBe('bot.service.card');
      expect(reads(service.username) - before, '♻️ reads').toBe(1);
    });

    it('a bucket at the background floor is not spent by an open; ♻️ still reads', async () => {
      const service = await activeService('open-at-floor');
      await stale(service.id);
      const capacity = ctx.container.config.PANEL_PROBE_TENANT_LIMIT;
      const floor = usageSyncBudgetReserveFor(
        capacity,
        monitorBudgetReserveFor(
          capacity,
          ctx.container.config.PANEL_MONITOR_BUDGET_RESERVE_PERCENT,
        ),
      );
      expect(floor, 'the fixture needs a floor').toBeGreaterThan(0);
      // Exactly the floor, refilled as of a moment still to come so nothing accrues.
      await setBucket(ctx, tenantA.tenantId, floor, new Date(Date.now() + 3_600_000));
      const before = reads(service.username);
      sent = [];
      expect((await handle(tap(`s:${service.id}`))).replyKey).toBe('bot.service.card');
      expect(reads(service.username) - before, 'the floor is not the open’s to spend').toBe(0);
      expect(lastText()).toContain('📥 حجم مصرفی: 2 گیگابایت');
      noFailureNotice();
      expect((await handle(tap(`rs:${service.id}`))).replyKey).toBe('bot.service.card');
      expect(reads(service.username) - before, '♻️ takes from the floor as before').toBe(1);
    });

    it('a service with a change in progress is drawn «working» without a read', async () => {
      const service = await activeService('open-working');
      await handle(tap(`u:${service.id}`));
      await stale(service.id);
      const before = reads(service.username);
      sent = [];
      expect((await handle(tap(`s:${service.id}`))).replyKey).toBe('bot.service.card');
      expect(reads(service.username) - before, 'no read while a SUSPEND is in flight').toBe(0);
    });

    it('a DISABLED panel is not dialled on open', async () => {
      const service = await activeService('open-disabled');
      await stale(service.id);
      await ctx.container.database.db.execute(
        sql`UPDATE panels SET status = 'DISABLED' WHERE id = ${panelId}`,
      );
      const before = reads(service.username);
      expect((await handle(tap(`s:${service.id}`))).replyKey).toBe('bot.service.card');
      expect(reads(service.username) - before).toBe(0);
    });

    it('a SUSPENDED service is not dialled on open', async () => {
      const service = await activeService('open-suspended');
      await ctx.container.database.db.execute(
        sql`UPDATE services SET state = 'SUSPENDED', usage_synced_at = now() - interval '10 minutes'
             WHERE id = ${service.id}`,
      );
      const before = reads(service.username);
      expect((await handle(tap(`s:${service.id}`))).replyKey).toBe('bot.service.card');
      expect(reads(service.username) - before).toBe(0);
    });

    it('a service that is not theirs is answered not-found, and dials nothing', async () => {
      const theirs = await activeService('open-theirs', reza);
      await stale(theirs.id);
      const before = reads(theirs.username);
      const result = await handle(tap(`s:${theirs.id}`));
      expect(result.replyKey).toBe('bot.service.not_found');
      expect(reads(theirs.username) - before).toBe(0);
    });
  });

  // =========================================================================
  // C1 — «آخرین زمان اتصال»: the panel's own last connection, or «در دسترس نیست»
  // =========================================================================
  describe('the last connection on the card (C1)', () => {
    const LINE = '📶 آخرین زمان اتصال شما: ';
    const stale = (id: string) =>
      ctx.container.database.db.execute(
        sql`UPDATE services SET usage_synced_at = now() - interval '10 minutes' WHERE id = ${id}`,
      );
    const lastSeenRow = async (id: string) => {
      const row = await services.findById(tenantA, id);
      return { state: row?.lastSeenState ?? null, at: row?.lastSeenAt?.toISOString() ?? null };
    };

    it('Marzban: shows the time the panel reported, in Tehran time, from a naive-UTC `online_at`', async () => {
      const service = await activeService('lc-at');
      const user = panel.users.get(service.username);
      if (user === undefined) throw new Error('no panel user');
      // 08:30 UTC, written as v0.8.4 writes it: no offset at all.
      user.onlineAt = marzbanOnlineAt(new Date('2026-10-06T08:30:00.000Z'));
      expect(user.onlineAt).toBe('2026-10-06T08:30:00');
      await stale(service.id);
      sent = [];
      expect((await handle(tap(`s:${service.id}`))).replyKey).toBe('bot.service.card');
      expect(await lastSeenRow(service.id)).toEqual({
        state: 'AT',
        at: '2026-10-06T08:30:00.000Z',
      });
      // Tehran is UTC+03:30: 12:00 on 14 Mehr 1405. Not 08:30, which is the naive string
      // read as local time, and not 05:00, which is it read as Tehran and shifted again.
      const body = lastText();
      expect(body).toContain(`${LINE}1405/07/14 12:00`);
      expect(body).not.toContain('در دسترس نیست');
      expect(body).not.toContain('متصل نشده');
    });

    it('Marzban: an account the panel says never connected reads «متصل نشده», not «در دسترس نیست»', async () => {
      const service = await activeService('lc-never');
      expect(panel.users.get(service.username)?.onlineAt).toBeNull();
      await stale(service.id);
      sent = [];
      expect((await handle(tap(`s:${service.id}`))).replyKey).toBe('bot.service.card');
      expect(await lastSeenRow(service.id)).toEqual({ state: 'NEVER', at: null });
      const body = lastText();
      expect(body).toContain(`${LINE}متصل نشده`);
      expect(body).not.toContain('در دسترس نیست');
    });

    it('3X-UI: «در دسترس نیست», even when the panel’s record carries a `lastOnline`', async () => {
      const xui = await startFake3xUi({ host: '127.0.0.2' });
      try {
        const created = await ctx.container.panels.create(tenantA, owner, {
          name: '3X-UI A',
          providerType: 'sanaei',
          baseUrl: xui.baseUrl,
          credentials: { username: CANARY.username, password: CANARY.password },
          activation: { subscriptionDomain: 'sub.example.test', inboundId: 1 },
          idempotencyKey: 'panel-lc-xui-create',
        });
        panelId = created.view.panel.id;
        await validatePanelConnection(ctx.container, tenantA, panelId);
        const service = await activeService('lc-xui');
        expect(xui.clients.has(service.username), 'the fixture provisioned on 3X-UI').toBe(true);
        xui.setLastOnline(service.username, Date.parse('2026-10-06T08:30:00.000Z'));
        await stale(service.id);
        const before = xui.requests.filter((one) => one.path.includes('clients/traffic/')).length;
        sent = [];
        expect((await handle(tap(`s:${service.id}`))).replyKey).toBe('bot.service.card');
        expect(
          xui.requests.filter((one) => one.path.includes('clients/traffic/')).length - before,
          'the card did read the panel',
        ).toBe(1);
        expect(await lastSeenRow(service.id)).toEqual({ state: null, at: null });
        const body = lastText();
        expect(body).toContain(`${LINE}در دسترس نیست`);
        expect(body).not.toContain('متصل نشده');
        expect(body).not.toContain('1405/07/14');
      } finally {
        await xui.close();
      }
    });
  });

  // =========================================================================
  // §B — the delivery card
  // =========================================================================
  describe('the delivery card', () => {
    it('arrives as ONE photo whose QR is the stored link and whose caption is the approved card', async () => {
      const productId = await product(
        'deliver',
        { durationDays: 30, trafficBytes: 53_687_091_200n },
        {
          ...EMPTY_PRODUCT_DISPLAY,
          serviceLocationLabel: 'مولتی لوکیشن',
        },
      );
      const orderId = await paidOrder('deliver', maryam, productId);
      await ctx.container.provisionerLoop.tick();
      const service = await services.findByOrderId(tenantA, orderId);
      expect(service?.deliveryState).toBe('DELIVERED');
      const photos = sent.filter((one) => one.url.includes('/sendPhoto'));
      expect(photos).toHaveLength(1);
      expect(messages(), 'no separate text: the card fit the caption').toHaveLength(0);
      const raw = photos[0]?.raw ?? '';
      expect(raw).toContain('name="photo"; filename="subscription.png"');
      // The PNG signature past its first byte: 0x89 is not UTF-8 and decodes to U+FFFD.
      expect(raw).toContain('PNG\r\n\u001a\n');
      expect(raw).toContain('✅ سرویس با موفقیت ایجاد شد');
      expect(raw).toContain(`👤 نام کاربری سرویس: ${service?.providerUsername ?? ''}`);
      expect(raw).toContain('🌿 نام سرویس: پلن deliver');
      expect(raw).toContain('🌍 لوکیشن: 🚀 مولتی لوکیشن');
      expect(raw).toContain('⌛ مدت زمان: 30 روز');
      expect(raw).toContain('⏱ حجم سرویس: 50 گیگابایت');
      expect(raw).toContain(`<code>${service?.subscriptionUrl ?? ''}</code>`);
      expect(raw).toContain('📚 مشاهده آموزش استفاده');
      expect(raw).toContain('🥰 وصل شدم');
      expect(raw).toContain('😐 مشکل دارم');
      expect(raw).toContain(`ok:${service?.id ?? ''}`);
    });

    it('«وصل شدم» acknowledges and writes nothing; «مشکل دارم» opens support; the guide opens platforms', async () => {
      const service = await activeService('deliver-buttons');
      const before = await ctx.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = ${tenantA.tenantId}`,
      );
      const ok = await handle(tap(`ok:${service.id}`));
      expect(ok.replyKey).toBe('bot.service.connected_ack');
      const after = await ctx.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = ${tenantA.tenantId}`,
      );
      expect((after.rows[0] as { n: number }).n).toBe((before.rows[0] as { n: number }).n);

      const guide = await handle(tap('tu:'));
      expect(guide.replyKey).toBe('bot.tutorial.choose');
      expect(buttonsOf(lastMarkup())).toEqual([
        'to:ANDROID',
        'to:IOS',
        'to:WINDOWS',
        'to:MACOS',
        'to:LINUX',
        'mm:',
      ]);
      const android = await handle(tap('to:ANDROID'));
      expect(android.replyKey).toBe('bot.tutorial.android');
      const crafted = await handle(tap('to:AMIGA'));
      expect(crafted.intent).toBe('UNSUPPORTED');

      const support = await handle(tap('sp:'));
      expect(support.replyKey).toBe('bot.faq.page');
      expect(lastText()).toContain('💡 سوالات متداول ⁉️');
    });
  });
});
