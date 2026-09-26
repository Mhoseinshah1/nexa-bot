import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  OPERATION_MAX_ATTEMPTS,
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
      expect(markup).toContain(`✨ ${service.username} ✨`);
      expect(buttonsOf(markup)).toEqual([`s:${service.id}`, 'ss:', 'ss:', 'sl:1', 'mm:']);
      expect(markup).toContain('جستجو نام کاربری');
      expect(markup).toContain('🔎 جستجو');
      expect(markup).toContain('1/1');
      expect(markup).toContain('🔙 بازگشت به منوی اصلی');
    });

    it('lists the customer’s OWN services and nobody else’s', async () => {
      const mine = await activeService('list-mine', maryam);
      const theirs = await activeService('list-theirs', reza);
      await handle(text('/services'));
      const markup = lastMarkup();
      expect(markup).toContain(`s:${mine.id}`);
      expect(markup).not.toContain(`s:${theirs.id}`);
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
      expect(first.filter((b) => b.startsWith('s:'))).toHaveLength(10);
      expect(first).toContain('sl:2');
      expect(first).not.toContain('sl:0');

      await handle(tap('sl:2'));
      expect(lastText()).toContain('📄 صفحه 2 از 2 | 📊 کل: 11 سرویس');
      const second = buttonsOf(lastMarkup());
      expect(second.filter((b) => b.startsWith('s:'))).toHaveLength(1);
      expect(second).toContain('sl:1');
      expect(second).not.toContain('sl:3');
      // Newest first: the last created service leads page 1, the first created ends page 2.
      expect(first[0]).toBe(`s:${ids[10] ?? ''}`);
      expect(second[0]).toBe(`s:${ids[0] ?? ''}`);

      // A stale button from an older message lands on the last real page.
      await handle(tap('sl:9'));
      expect(lastText()).toContain('📄 صفحه 2 از 2');
      const crafted = await handle(tap('sl:abc'));
      expect(crafted.intent).toBe('UNSUPPORTED');
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
      expect(lastMarkup()).toContain(`s:${mine.id}`);
      expect(lastMarkup()).not.toContain(`s:${theirs.id}`);

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
      expect(body).toContain('📥 حجم مصرفی: 0 بایت');
      expect(body).toContain('💢 حجم باقی مانده: 50 گیگابایت (100%)');
      expect(body).toMatch(/📅 تاریخ اتمام: 14\d\d\/\d\d\/\d\d \d\d:\d\d \(30 روز\)/u);
      expect(body).toContain('📶 آخرین زمان اتصال شما: در دسترس نیست');
      expect(body).not.toContain('متصل نشده');
      expect(body).not.toContain('{');
      // Rotation is off (flag), so neither the button nor the hint about it is drawn.
      expect(body).not.toContain('تغییر لینک');

      const buttons = buttonsOf(lastMarkup());
      // No `t:`: a customer cannot end a service (WP15 G1). Suspend (`u:`) stays.
      expect(buttons).toEqual([
        `rs:${service.id}`,
        `r:${service.id}`,
        `nt:${service.id}`,
        `n:${service.id}`,
        `u:${service.id}`,
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
      const asked = await handle(tap(`nt:${service.id}`));
      expect(asked.replyKey).toBe('bot.service.note_prompt');
      expect(lastText()).toContain('حداکثر 200 نویسه');

      const saved = await handle(text('  گوشی مادر  '));
      expect(saved.replyKey).toBe('bot.service.note_saved');
      expect((await services.findById(tenantA, service.id))?.customerNote).toBe('گوشی مادر');
      await handle(tap(`s:${service.id}`));
      expect(lastText()).toContain('📝 یادداشت: گوشی مادر');

      await handle(tap(`nt:${service.id}`));
      const cleared = await handle(text('-'));
      expect(cleared.replyKey).toBe('bot.service.note_cleared');
      expect((await services.findById(tenantA, service.id))?.customerNote).toBeNull();
    });

    it('bounds the note and strips control characters', async () => {
      const service = await activeService('note-bound');
      await handle(tap(`nt:${service.id}`));
      const saved = await handle(text('a\u0007b\n\nc'));
      expect(saved.replyKey).toBe('bot.service.note_saved');
      expect((await services.findById(tenantA, service.id))?.customerNote).toBe('a b c');
      await handle(tap(`nt:${service.id}`));
      const long = await handle(text('x'.repeat(250)));
      expect(long.replyKey).toBe('bot.service.note_saved');
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
    it('queues a usage read the customer asked for, writes what the panel said, and tells them', async () => {
      const service = await activeService('refresh');
      const user = panel.users.get(service.username);
      if (user === undefined) throw new Error('no panel user');
      user.usedTraffic = 5_368_709_120;
      await ctx.container.database.db.execute(
        sql`UPDATE services SET usage_synced_at = now() - interval '10 minutes' WHERE id = ${service.id}`,
      );

      const result = await handle(tap(`rs:${service.id}`));
      expect(result.replyKey).toBe('bot.service.refresh_requested');
      const queued = (await operations.listForService(tenantA, service.id, 50)).find(
        (operation) => operation.type === 'SYNC_USAGE',
      );
      expect(queued?.requestedByCustomerId).toBe(maryam);

      await ctx.container.provisionerLoop.tick();
      const row = await services.findById(tenantA, service.id);
      expect(row?.trafficUsedBytes).toBe(5_368_709_120n);
      const announced = await ctx.container.database.db.execute(
        sql`SELECT kind FROM customer_notifications WHERE tenant_id = ${tenantA.tenantId} ORDER BY created_at`,
      );
      expect(announced.rows.map((r) => (r as { kind: string }).kind)).toContain(
        'SERVICE_ACTION_SUCCEEDED',
      );

      // A second tap right after the read: nothing new, and the customer is told why.
      const again = await handle(tap(`rs:${service.id}`));
      expect(again.replyKey).toBe('bot.service.refresh_too_soon');
    });

    it('a read the panel refuses erases nothing and is announced as a failure', async () => {
      const service = await activeService('refresh-fail');
      await ctx.container.database.db.execute(
        sql`UPDATE services SET traffic_used_bytes = 1024, usage_synced_at = now() - interval '10 minutes' WHERE id = ${service.id}`,
      );
      panel.forget(service.username);
      await handle(tap(`rs:${service.id}`));
      await ctx.container.database.db.execute(
        // One attempt left: `claimDue` claims `attempts < OPERATION_MAX_ATTEMPTS` only, so
        // a count at or above the bound is never run at all, and this failure is terminal.
        sql`UPDATE provisioning_operations
               SET next_attempt_at = now() - interval '1 hour', attempts = ${OPERATION_MAX_ATTEMPTS - 1}`,
      );
      await ctx.container.provisionerLoop.tick();
      const row = await services.findById(tenantA, service.id);
      expect(row?.trafficUsedBytes).toBe(1024n);
      expect(row?.state).toBe('ACTIVE');
      const announced = await ctx.container.database.db.execute(
        sql`SELECT kind FROM customer_notifications WHERE tenant_id = ${tenantA.tenantId}`,
      );
      expect(announced.rows.map((r) => (r as { kind: string }).kind)).toContain(
        'SERVICE_ACTION_FAILED',
      );
    });

    it('cannot be asked for another customer’s service', async () => {
      const theirs = await activeService('refresh-theirs', reza);
      const result = await handle(tap(`rs:${theirs.id}`));
      expect(result.replyKey).toBe('bot.service.not_found');
      expect(await operations.listForService(tenantA, theirs.id, 50)).toEqual(
        expect.not.arrayContaining([expect.objectContaining({ type: 'SYNC_USAGE' })]),
      );
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
