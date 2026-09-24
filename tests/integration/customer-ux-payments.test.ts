import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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
  type ProductDisplay,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
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
 * Money through the approved screens (customer UX completion §D, §E, §F, §O, §Q): the
 * pre-invoice and its payment buttons, the wallet summary, the typed top-up and its
 * route chooser — each driven through the runtime as Telegram would.
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

describe('a customer pays through the approved screens', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: Sent[];
  let reply: (request: IncomingMessage, response: ServerResponse) => void;
  let panel: FakeMarzban;
  let products: DrizzleProductRepository;
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
        const raw = Buffer.concat(chunks).toString('utf8');
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
    sent = [];
    reply = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
    };
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-pay', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-pay-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);
    maryam = await resolve(MARYAM, 'مریم', 'احمدی');
    reza = await resolve(REZA, 'رضا', null);
  });

  async function resolve(
    telegramUserId: string,
    firstName: string,
    lastName: string | null,
  ): Promise<UserId> {
    registered.set(telegramUserId, {
      first_name: firstName,
      ...(lastName === null ? {} : { last_name: lastName }),
    });
    const resolved = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: {
          id: Number(telegramUserId),
          first_name: firstName,
          ...(lastName === null ? {} : { last_name: lastName }),
        },
        botInstanceId: BOT_A,
      },
    );
    return resolved.customer.id;
  }

  async function product(
    key: string,
    display: ProductDisplay = EMPTY_PRODUCT_DISPLAY,
    priceMinor = 250_000n,
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
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: money(priceMinor, 'IRT'),
        display,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, row.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return row.id;
  }

  async function credit(customerId: UserId, amountMinor: bigint, key: string): Promise<void> {
    await ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: `${key}-credit`,
      direction: 'CREDIT',
      amountMinor,
      currency: 'IRT',
      note: 'fixture',
    });
  }

  async function setSetting(key: string, value: unknown): Promise<void> {
    await ctx.container.database.db.execute(sql`
      INSERT INTO setting_values (id, tenant_id, setting_key, value, version, updated_at)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${key},
              ${JSON.stringify(value)}::jsonb, 1, now())
      ON CONFLICT (tenant_id, setting_key)
        DO UPDATE SET value = ${JSON.stringify(value)}::jsonb, version = setting_values.version + 1`);
  }

  /*
   * The `from` of every update carries the name the customer registered with. The
   * resolver refreshes a customer's name from each update — Nexa's rule, a name follows
   * Telegram — so a fixture that sent `x` here would rename the customer it is testing.
   */
  const registered = new Map<string, { first_name: string; last_name?: string }>();
  const fromOf = (telegramUserId: string) => ({
    id: Number(telegramUserId),
    ...(registered.get(telegramUserId) ?? { first_name: 'x' }),
  });
  const customerUpdate = (payload: Record<string, unknown>, telegramUserId = MARYAM) => {
    updateSeq += 1;
    return {
      idempotencyKey: `bot-update-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      update: { update_id: updateSeq, ...payload },
      telegramUserId,
      from: fromOf(telegramUserId),
    };
  };
  const tap = (data: string, telegramUserId = MARYAM) =>
    customerUpdate(
      {
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { ...fromOf(telegramUserId), is_bot: false },
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
          from: { ...fromOf(telegramUserId), is_bot: false },
          text: value,
        },
      },
      telegramUserId,
    );
  const handle = (update: ReturnType<typeof customerUpdate>) =>
    ctx.container.botRuntime.handle(tenantA, systemActor('bot'), update);
  const messages = () => sent.filter((one) => one.url.includes('/sendMessage'));
  const last = () => messages()[messages().length - 1];
  const lastText = () => String(last()?.body['text'] ?? '');
  const lastMarkup = () => JSON.stringify(last()?.body['reply_markup'] ?? {});
  const buttonsOf = (markup: string): string[] =>
    [...markup.matchAll(/"callback_data":"([^"]+)"/g)].map((m) => m[1] as string);
  const labelsOf = (markup: string): string[] =>
    [...markup.matchAll(/"text":"([^"]+)"/g)].map((m) => m[1] as string);

  /** Tap the product, answer the username question the cheap way: the pre-invoice. */
  async function draftTo(productId: ProductId, telegramUserId = MARYAM): Promise<string> {
    await handle(tap(`p:${productId}`, telegramUserId));
    const question = buttonsOf(lastMarkup()).find((b) => b.startsWith('Z:'));
    if (question === undefined) throw new Error(`no username question: ${lastMarkup()}`);
    const orderId = question.slice(2);
    await handle(tap(question, telegramUserId));
    return orderId;
  }

  async function ledger(customerId: UserId): Promise<{ reason: string; amount: string }[]> {
    const rows = await ctx.container.database.db.execute(
      sql`SELECT reason, amount::text AS amount FROM wallet_entries WHERE tenant_id = ${tenantA.tenantId} AND customer_id = ${customerId} ORDER BY created_at, reason`,
    );
    return rows.rows as { reason: string; amount: string }[];
  }

  // =========================================================================
  // §D — the pre-invoice
  // =========================================================================
  describe('the pre-invoice', () => {
    it('renders the approved structure with the product’s ordered locations and features, and the payment buttons', async () => {
      const productId = await product('pre', {
        displayLocations: ['🇩🇪 آلمان', '🇳🇱 هلند'],
        displayFeatures: ['✅ اتصال همزمان ۳ دستگاه', '✅ پشتیبانی ۲۴ ساعته'],
        serviceLocationLabel: 'مولتی لوکیشن',
      });
      await credit(maryam, 1_000_000n, 'pre');
      const orderId = await draftTo(productId);
      const body = lastText();
      expect(body.startsWith('🧾 پیش فاکتور شما:\n\n')).toBe(true);
      expect(body).toMatch(/👤 نام کاربر: nx[a-z0-9]+\n/u);
      expect(body).toContain(
        '🔐 نام سرویس: پلن pre\n📆 مدت اعتبار: 30 روز\n💵 قیمت: 250,000 تومان\n👥 حجم اکانت: 50 گیگابایت\n\n',
      );
      expect(body).toContain(
        '🌍 لوکیشن‌های محصول:\n🇩🇪 آلمان\n🇳🇱 هلند\n\n✅ اتصال همزمان ۳ دستگاه\n✅ پشتیبانی ۲۴ ساعته\n\n',
      );
      expect(
        body.endsWith('💰 موجودی کیف پول شما: 1,000,000 تومان\n\n💰 سفارش شما آماده پرداخت است'),
      ).toBe(true);
      expect(buttonsOf(lastMarkup())).toEqual([
        `w:${orderId}`,
        `m:${orderId}`,
        `dc:${orderId}`,
        'mm:',
      ]);
      expect(labelsOf(lastMarkup())).toEqual([
        '💰 پرداخت از کیف پول',
        '🧾 ثبت پرداخت',
        '🏷 اعمال کد تخفیف',
        '🏠 بازگشت به منوی اصلی',
      ]);
    });

    it('omits the location and feature sections when the product has none, and never draws a gateway button', async () => {
      const productId = await product('plain');
      await draftTo(productId);
      const body = lastText();
      expect(body).not.toContain('لوکیشن');
      expect(body).not.toContain('{');
      expect(lastMarkup()).not.toContain('💳 پرداخت با درگاه');
      expect(buttonsOf(lastMarkup()).some((b) => b.startsWith('g:'))).toBe(false);
    });

    it('draws no manual button when the card-to-card route is not allowed for purchases', async () => {
      await ctx.container.database.db.execute(
        sql`UPDATE payment_gateways SET allow_service_purchase = false WHERE tenant_id = ${tenantA.tenantId}`,
      );
      const productId = await product('nomanual');
      const orderId = await draftTo(productId);
      expect(buttonsOf(lastMarkup())).toEqual([`w:${orderId}`, `dc:${orderId}`, 'mm:']);
    });

    it('splits a long pre-invoice at section boundaries and puts the keyboard on the last part only', async () => {
      const productId = await product('long', {
        displayLocations: Array.from(
          { length: 30 },
          (_, i) => `🌐 لوکیشن شمارهٔ ${String(i + 1)} ${'—'.repeat(40)}`,
        ),
        displayFeatures: Array.from(
          { length: 30 },
          // Each section fits a message on its own, so the cut falls BETWEEN sections;
          // a section wider than the bound would be cut line by line into a third part.
          (_, i) => `✅ ویژگی شمارهٔ ${String(i + 1)} ${'—'.repeat(100)}`,
        ),
        serviceLocationLabel: null,
      });
      await draftTo(productId);
      const parts = messages().slice(-2);
      expect(parts.length).toBe(2);
      const [first, second] = parts;
      expect(String(first?.body['text']).length).toBeLessThanOrEqual(4096);
      expect(String(second?.body['text']).length).toBeLessThanOrEqual(4096);
      expect(first?.body['reply_markup']).toBeUndefined();
      expect(second?.body['reply_markup']).toBeDefined();
      const whole = `${String(first?.body['text'])}\n\n${String(second?.body['text'])}`;
      expect(whole).toContain('🌐 لوکیشن شمارهٔ 30');
      expect(whole).toContain('✅ ویژگی شمارهٔ 30');
      expect(whole).toContain('💰 سفارش شما آماده پرداخت است');
    });
  });

  // =========================================================================
  // §O1 — wallet payment from the pre-invoice
  // =========================================================================
  describe('paying from the wallet', () => {
    it('confirms and settles a DRAFT in one tap when the balance covers it', async () => {
      const productId = await product('wallet-ok');
      await credit(maryam, 300_000n, 'wallet-ok');
      const orderId = await draftTo(productId);
      const result = await handle(tap(`w:${orderId}`));
      expect(result.replyKey).toBe('bot.order.settled');
      const rows = await ctx.container.database.db.execute(
        sql`SELECT state FROM orders WHERE id = ${orderId}`,
      );
      expect((rows.rows[0] as { state: string }).state).toBe('PAID');
      expect((await ledger(maryam)).map((e) => e.reason)).toEqual(['ADMIN_CREDIT', 'PURCHASE']);
    });

    it('names the shortfall, offers the top-up, and confirms NOTHING when the balance is short', async () => {
      const productId = await product('wallet-short');
      await credit(maryam, 100_000n, 'wallet-short');
      const orderId = await draftTo(productId);
      const result = await handle(tap(`w:${orderId}`));
      expect(result.replyKey).toBe('bot.wallet.insufficient');
      expect(lastText()).toContain('150,000 تومان');
      expect(buttonsOf(lastMarkup())).toEqual(['o:', 'mm:']);
      const rows = await ctx.container.database.db.execute(
        sql`SELECT state FROM orders WHERE id = ${orderId}`,
      );
      expect(
        (rows.rows[0] as { state: string }).state,
        'no reservation held for missing money',
      ).toBe('DRAFT');
      expect((await ledger(maryam)).map((e) => e.reason)).toEqual(['ADMIN_CREDIT']);
    });

    it('a double tap and a redelivered tap debit once', async () => {
      const productId = await product('wallet-twice');
      await credit(maryam, 1_000_000n, 'wallet-twice');
      const orderId = await draftTo(productId);
      const first = tap(`w:${orderId}`);
      await handle(first);
      await handle(first); // the same update, redelivered
      const second = await handle(tap(`w:${orderId}`)); // a new tap on the same button
      expect(second.replyKey).not.toBe('bot.order.settled');
      const purchases = (await ledger(maryam)).filter((e) => e.reason === 'PURCHASE');
      expect(purchases).toHaveLength(1);
    });

    it('two concurrent taps converge on one debit', async () => {
      const productId = await product('wallet-race');
      await credit(maryam, 1_000_000n, 'wallet-race');
      const orderId = await draftTo(productId);
      const results = await Promise.all([handle(tap(`w:${orderId}`)), handle(tap(`w:${orderId}`))]);
      expect(results.filter((r) => r.replyKey === 'bot.order.settled')).toHaveLength(1);
      const purchases = (await ledger(maryam)).filter((e) => e.reason === 'PURCHASE');
      expect(purchases).toHaveLength(1);
    });

    it('confirms then asks for the transfer when the manual button is tapped on a DRAFT', async () => {
      const productId = await product('manual-draft');
      const orderId = await draftTo(productId);
      const result = await handle(tap(`m:${orderId}`));
      expect(result.replyKey).toBe('bot.payment.transfer_instructions');
      const rows = await ctx.container.database.db.execute(
        sql`SELECT state FROM orders WHERE id = ${orderId}`,
      );
      expect((rows.rows[0] as { state: string }).state).toBe('AWAITING_PAYMENT');
    });
  });

  // =========================================================================
  // §E — the wallet summary
  // =========================================================================
  describe('the wallet summary', () => {
    it('renders the approved account summary from the customer’s OWN rows', async () => {
      await credit(maryam, 750_000n, 'summary');
      await credit(reza, 5_000_000n, 'summary-reza');
      const result = await handle(text('/wallet'));
      expect(result.replyKey).toBe('bot.wallet.summary');
      const body = lastText();
      expect(body.startsWith('🎡 اطلاعات حساب کاربری شما:\n\n')).toBe(true);
      expect(body).toContain('🪪 آی دی عددی: 910910');
      expect(body).toContain('👤 نام: مریم احمدی');
      expect(body).toContain('⚫ شماره تماس: 🔴 ارسال نشده است');
      expect(body).toMatch(/⏳ زمان ثبت نام: 14\d\d\/\d\d\/\d\d \d\d:\d\d/u);
      expect(body).toContain('⭐ موجودی: 750,000 تومان');
      expect(body).not.toContain('5,000,000');
      expect(body).toContain('🛒 تعداد سرویس های خریداری شده: 0 عدد');
      expect(body).toContain('🧾 تعداد فاکتورهای پرداخت شده: 0 عدد');
      expect(body).toContain('👥 تعداد زیرمجموعه های شما: 0 نفر');
      expect(body).toContain('🔖 گروه کاربری: کاربر عادی');
      expect(labelsOf(lastMarkup())).toEqual(['💰 افزایش موجودی', '🏠 بازگشت به منوی اصلی']);
    });

    it('counts services and paid invoices from the rows', async () => {
      const productId = await product('counts');
      await credit(maryam, 1_000_000n, 'counts');
      const orderId = await draftTo(productId);
      await handle(tap(`w:${orderId}`));
      await ctx.container.provisionerLoop.tick();
      sent = [];
      await handle(text('/wallet'));
      expect(lastText()).toContain('🛒 تعداد سرویس های خریداری شده: 1 عدد');
      expect(lastText()).toContain('🧾 تعداد فاکتورهای پرداخت شده: 1 عدد');
    });
  });

  // =========================================================================
  // §F / §O2 — the typed top-up
  // =========================================================================
  describe('topping up by a typed amount', () => {
    it('asks for the amount, reads it in any digits, and offers every allowed route with its gift', async () => {
      await ctx.container.database.db.execute(
        sql`UPDATE payment_gateways SET topup_cashback_percent = 10, display_name = NULL WHERE tenant_id = ${tenantA.tenantId}`,
      );
      const begun = await handle(tap('o:'));
      expect(begun.replyKey).toBe('bot.wallet.topup_amount_prompt');
      const typed = await handle(text('۵۰٬۰۰۰'));
      expect(typed.replyKey).toBe('bot.wallet.topup_method_prompt');
      expect(lastText()).toBe('💳 روش پرداخت خود را انتخاب نمایید');
      const labels = labelsOf(lastMarkup());
      expect(labels).toEqual(['پرداخت با کارت به کارت (10 درصد شارژ هدیه)', '❌ بستن لیست']);
      const route = buttonsOf(lastMarkup()).find((b) => b.startsWith('tp:'));
      expect(route).toMatch(/^tp:[0-9a-f-]{36}\.MANUAL_TRANSFER$/u);

      const chosen = await handle(tap(route ?? ''));
      expect(chosen.replyKey).toBe('bot.payment.transfer_instructions');
      const payment = await ctx.container.database.db.execute(
        sql`SELECT amount::text AS amount, topup_cashback_percent AS pct, order_id FROM payments WHERE tenant_id = ${tenantA.tenantId}`,
      );
      expect(payment.rows).toHaveLength(1);
      expect(payment.rows[0]).toMatchObject({ amount: '50000', pct: 10, order_id: null });

      // The same button tapped again: the same payment, not a second one.
      await handle(tap(route ?? ''));
      const again = await ctx.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM payments WHERE tenant_id = ${tenantA.tenantId}`,
      );
      expect((again.rows[0] as { n: number }).n).toBe(1);
    });

    it('shows the route without a gift when the percent is zero, and closes the list on request', async () => {
      await handle(tap('o:'));
      await handle(text('50000'));
      expect(labelsOf(lastMarkup())).toEqual(['پرداخت با کارت به کارت', '❌ بستن لیست']);
      const close = buttonsOf(lastMarkup()).find((b) => b.startsWith('tx:'));
      const closed = await handle(tap(close ?? ''));
      expect(closed.replyKey).toBe('bot.wallet.topup_closed');
      const route = `tp:${(close ?? '').slice(3)}.MANUAL_TRANSFER`;
      const stale = await handle(tap(route));
      expect(stale.replyKey).toBe('bot.wallet.topup_expired');
    });

    it('refuses a figure that is not a whole positive amount, and keeps asking', async () => {
      await handle(tap('o:'));
      for (const bad of ['abc', '-5000', '12.5', '0', '']) {
        if (bad === '') continue;
        const result = await handle(text(bad));
        expect(result.replyKey, bad).toBe('bot.wallet.topup_amount_invalid');
      }
      const ok = await handle(text('1,000'));
      expect(ok.replyKey).toBe('bot.wallet.topup_method_prompt');
    });

    it('holds the installation’s floor and ceiling', async () => {
      await setSetting('wallet.topup.minimum', { amountMinor: '20000', currency: 'IRT' });
      await setSetting('wallet.topup.maximum', { amountMinor: '100000', currency: 'IRT' });
      await handle(tap('o:'));
      expect(lastText()).toContain('حداقل: 20,000 تومان');
      expect(lastText()).toContain('حداکثر: 100,000 تومان');
      const low = await handle(text('10000'));
      expect(low.replyKey).toBe('bot.wallet.topup_below_minimum');
      const high = await handle(text('200000'));
      expect(high.replyKey).toBe('bot.wallet.topup_above_maximum');
      const ok = await handle(text('50000'));
      expect(ok.replyKey).toBe('bot.wallet.topup_method_prompt');
    });

    it('offers no route that is not allowed for top-up, and says so', async () => {
      await ctx.container.database.db.execute(
        sql`UPDATE payment_gateways SET allow_wallet_topup = false WHERE tenant_id = ${tenantA.tenantId}`,
      );
      const begun = await handle(tap('o:'));
      expect(begun.replyKey).toBe('bot.wallet.topup_unavailable');
      await handle(text('/wallet'));
      expect(labelsOf(lastMarkup())).not.toContain('💰 افزایش موجودی');
    });

    it('a preset shortcut records the figure on the same capture and opens the chooser', async () => {
      await setSetting('wallet.topup.presets', [{ amountMinor: '500000', currency: 'IRT' }]);
      await handle(tap('o:'));
      expect(labelsOf(lastMarkup())).toContain('500,000 تومان');
      const picked = await handle(tap('y:500000'));
      expect(picked.replyKey).toBe('bot.wallet.topup_method_prompt');
    });

    it('an amount typed with no window open is not a top-up, and a window past its deadline reads nothing', async () => {
      const stray = await handle(text('50000'));
      expect(stray.replyKey).toBe('bot.unknown_command');
      await handle(tap('o:'));
      await ctx.container.database.db.execute(
        // Both stamps move: the row's CHECK keeps a deadline after its opening.
        sql`UPDATE customer_text_captures
               SET opened_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute'`,
      );
      const late = await handle(text('50000'));
      expect(late.replyKey).toBe('bot.unknown_command');
      const rows = await ctx.container.database.db.execute(
        sql`SELECT close_reason FROM customer_text_captures`,
      );
      expect((rows.rows[0] as { close_reason: string }).close_reason).toBe('EXPIRED');
    });

    it('the principal and the gift are separate entries, written once across a repeated confirmation', async () => {
      await ctx.container.database.db.execute(
        sql`UPDATE payment_gateways SET topup_cashback_percent = 10 WHERE tenant_id = ${tenantA.tenantId}`,
      );
      await handle(tap('o:'));
      await handle(text('100000'));
      const route = buttonsOf(lastMarkup()).find((b) => b.startsWith('tp:')) ?? '';
      await handle(tap(route));
      const paymentRow = await ctx.container.database.db.execute(
        sql`SELECT id FROM payments WHERE tenant_id = ${tenantA.tenantId}`,
      );
      const paymentId = (paymentRow.rows[0] as { id: string }).id;
      const confirm = () =>
        ctx.container.payments.confirmManualTransfer(tenantA, owner, paymentId, {
          idempotencyKey: `confirm-${paymentId}`,
          note: 'seen',
        });
      await confirm();
      await confirm();
      const entries = await ledger(maryam);
      expect(entries.map((e) => [e.reason, e.amount])).toEqual([
        ['CASHBACK_TOPUP', '10000'],
        ['TOPUP_RECEIPT', '100000'],
      ]);
    });
  });

  // =========================================================================
  // §K — routing
  // =========================================================================
  describe('the main menu and support', () => {
    it('the support button opens the seeded FAQ with the contact button, and the main-menu button comes back', async () => {
      await setSetting('support.accounts', ['@nexa_support']);
      const help = await handle(text('/help'));
      expect(help.replyKey).toBe('bot.faq.page');
      const body = lastText();
      expect(body.startsWith('💡 سوالات متداول ⁉️')).toBe(true);
      expect(body).toContain(
        '1️⃣ فیلترشکن شما آیپی ثابته؟ میتونم برای صرافی های ارز دیجیتال استفاده کنم؟',
      );
      expect(body).toContain(
        '✅ به دلیل وضعیت نت و محدودیت های کشور سرویس ما مناسب ترید نیست و فقط لوکیشن‌ ثابته.',
      );
      expect(body).toContain('9️⃣ امکان بازگشت وجه دارید؟');
      expect(
        body.endsWith('💡 در صورتی که جواب سوالتون رو نگرفتید میتونید به «پشتیبانی» مراجعه کنید.'),
      ).toBe(true);
      expect(lastMarkup()).toContain('"url":"https://t.me/nexa_support"');
      expect(labelsOf(lastMarkup())).toEqual([
        '📨 ارسال پیام به پشتیبانی',
        '🏠 بازگشت به منوی اصلی',
      ]);

      const menu = await handle(tap('mm:'));
      expect(menu.replyKey).toBe('bot.start.welcome_back');
      expect(JSON.stringify(last()?.body)).toContain('💬 پشتیبانی');
    });

    it('draws no contact button when no support account is configured', async () => {
      await handle(text('/help'));
      expect(lastMarkup()).not.toContain('"url"');
      expect(labelsOf(lastMarkup())).toEqual(['🏠 بازگشت به منوی اصلی']);
    });

    it('shows the contact action alone when every FAQ is inactive', async () => {
      await setSetting('support.accounts', ['@nexa_support']);
      await handle(text('/help'));
      await ctx.container.database.db.execute(
        sql`UPDATE support_faqs SET status = 'INACTIVE' WHERE tenant_id = ${tenantA.tenantId}`,
      );
      const result = await handle(text('/help'));
      expect(result.replyKey).toBe('bot.support.contact');
      expect(lastMarkup()).toContain('"url":"https://t.me/nexa_support"');
    });
  });
});
