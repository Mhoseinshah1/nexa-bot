import { describe, expect, it } from 'vitest';
import {
  money,
  templateDefinition,
  type ScopeContext,
  type TemplateKey,
  type TemplateValues,
} from '@nexa/contracts';
import { CATALOGUE_FA, renderTemplateBody, DEFAULT_TEMPLATE_PRESENTATION } from '@nexa/i18n';
import { CustomerScreenComposer } from '../../apps/api/src/modules/commerce/messaging/application/customer-screens';
import { appearanceFallbackText } from '../../apps/api/src/modules/commerce/messaging/application/appearance-render';

/**
 * The approved customer screens, pinned as TEXT (customer UX completion §Q).
 *
 * The composer renders the sub-lines through the resolver and hands back a key and
 * values; rendering the main key through the same catalogue here produces exactly what
 * a customer reads. Every expectation below is the owner's approved default, so a
 * change to any of these lines is a product decision and fails here first.
 */
const scope = { tenantId: 'tenant-1', botInstanceId: null } as unknown as ScopeContext;

/*
 * As a customer with no custom emoji configured reads it: the messenger turns every
 * appearance marker (`{icon:wallet}`, owner spec §4) into its fallback emoji.
 */
const render = (key: TemplateKey, values: TemplateValues): string =>
  appearanceFallbackText(
    renderTemplateBody(
      templateDefinition(key),
      CATALOGUE_FA[key],
      values,
      'fa',
      DEFAULT_TEMPLATE_PRESENTATION,
    ),
  );

const composer = new CustomerScreenComposer({
  render: async (_scope, key, values) => render(key, values),
});

describe('the service card', () => {
  const base = {
    state: 'ACTIVE' as const,
    serviceUsername: 'nx7k2m9q',
    serviceLocation: 'مولتی لوکیشن',
    productName: 'پلن ۳۰ روزه',
    trafficLimitBytes: 53_687_091_200n,
    trafficUsedBytes: 10_737_418_240n,
    usageSyncedAt: new Date('2026-09-24T18:00:00Z'),
    expiresAt: new Date('2026-10-24T18:30:00Z'),
    now: new Date('2026-09-24T18:30:00Z'),
    lastSeen: { kind: 'UNSUPPORTED' } as const,
    note: null,
    rotateOffered: true,
  };

  it('renders the approved lines, in order, from the rows', async () => {
    const screen = await composer.serviceCard(scope, base);
    expect(screen.key).toBe('bot.service.card');
    expect(render(screen.key, screen.values)).toBe(
      [
        '📊وضعیت سرویس: 🟢 فعال',
        '👤 نام سرویس: nx7k2m9q',
        '',
        '🌍 موقعیت سرویس: 🚀 مولتی لوکیشن',
        '📦 نام محصول: پلن ۳۰ روزه',
        '',
        '🟩 ترافیک: 50 گیگابایت',
        '📥 حجم مصرفی: 10 گیگابایت',
        '💢 حجم باقی مانده: 40 گیگابایت (80%)',
        '',
        '📅 تاریخ اتمام: 1405/08/02 22:00 (30 روز)',
        '',
        '📶 آخرین زمان اتصال شما: در دسترس نیست',
        '',
        '💡 با گزینهٔ «تغییر لینک» یک لینک اشتراک جدید برای این سرویس ساخته می‌شود.',
      ].join('\n'),
    );
  });

  it('never turns an unread usage into 0, and never claims never-connected for an unsupported field', async () => {
    const screen = await composer.serviceCard(scope, { ...base, usageSyncedAt: null });
    const text = render(screen.key, screen.values);
    expect(text).toContain('📥 حجم مصرفی: هنوز از سرور خوانده نشده');
    expect(text).toContain('💢 حجم باقی مانده: هنوز از سرور خوانده نشده');
    expect(text).not.toContain(': 0 گیگابایت');
    expect(text).toContain('📶 آخرین زمان اتصال شما: در دسترس نیست');
    expect(text).not.toContain('متصل نشده');
  });

  it('says never-connected only when a provider proved it, and shows a proven time', async () => {
    const never = await composer.serviceCard(scope, { ...base, lastSeen: { kind: 'NEVER' } });
    expect(render(never.key, never.values)).toContain('📶 آخرین زمان اتصال شما: متصل نشده');
    const at = await composer.serviceCard(scope, {
      ...base,
      lastSeen: { kind: 'AT', at: new Date('2026-09-24T10:00:00Z') },
    });
    expect(render(at.key, at.values)).toContain('📶 آخرین زمان اتصال شما: 1405/07/02 13:30');
  });

  it('keeps unlimited and zero apart, and drops the lines that do not apply', async () => {
    const unlimited = await composer.serviceCard(scope, {
      ...base,
      trafficLimitBytes: 0n,
      trafficUsedBytes: 0n,
      expiresAt: null,
      serviceLocation: null,
      rotateOffered: false,
    });
    const text = render(unlimited.key, unlimited.values);
    expect(text).toContain('🟩 ترافیک: نامحدود');
    expect(text).toContain('📥 حجم مصرفی: 0 گیگابایت');
    expect(text).toContain('💢 حجم باقی مانده: نامحدود');
    expect(text).toContain('📅 تاریخ اتمام: بدون محدودیت زمانی');
    expect(text).not.toContain('موقعیت سرویس');
    expect(text).not.toContain('تغییر لینک');
    expect(text).not.toContain('{');
  });

  it('floors remaining days and remaining traffic at zero', async () => {
    const overrun = await composer.serviceCard(scope, {
      ...base,
      trafficUsedBytes: 60_000_000_000n,
      expiresAt: new Date('2026-09-20T00:00:00Z'),
    });
    const text = render(overrun.key, overrun.values);
    expect(text).toContain('💢 حجم باقی مانده: 0 گیگابایت (0%)');
    expect(text).toContain('(0 روز)');
    expect(text).not.toContain('نامحدود');
  });

  it('shows the customer’s note and a suspended status', async () => {
    const screen = await composer.serviceCard(scope, {
      ...base,
      state: 'SUSPENDED',
      note: 'گوشی مادر',
    });
    const text = render(screen.key, screen.values);
    expect(text).toContain('📊وضعیت سرویس: 🔴 خاموش');
    expect(text).toContain('📝 یادداشت: گوشی مادر');
  });
});

describe('the wallet summary', () => {
  it('renders the approved account summary', async () => {
    const screen = await composer.walletSummary(scope, {
      telegramId: '910910',
      displayName: 'مریم احمدی',
      registeredAt: new Date('2026-09-01T08:00:00Z'),
      balance: money(1_250_000n, 'IRT'),
      serviceCount: 3,
      paidInvoiceCount: 4,
      referralCount: 2,
      group: 'CUSTOMER',
      now: new Date('2026-10-02T19:52:00Z'),
    });
    expect(screen.key).toBe('bot.wallet.summary');
    /*
     * Owner spec §3/§4: every icon is an appearance slot (the phone is 📱, the balance the
     * `wallet` slot, the referral count the `referral` slot), and after the user group a
     * blank line, then the date and the time the screen was drawn, in Tehran, Jalali.
     */
    expect(render(screen.key, screen.values)).toBe(
      [
        '🎡 اطلاعات حساب کاربری شما:',
        '',
        '🪪 شناسه کاربری: 910910',
        '👤 نام: مریم احمدی',
        '📱 شماره تماس: 🔴 ارسال نشده است',
        '⏳ زمان ثبت نام: 1405/06/10 11:30',
        '💰 موجودی: 1,250,000 تومان',
        '🛒 تعداد سرویس های خریداری شده: 3 عدد',
        '🧾 تعداد فاکتورهای پرداخت شده: 4 عدد',
        '🎁 تعداد زیرمجموعه های شما: 2 نفر',
        '🔖 گروه کاربری: کاربر عادی',
        '',
        '📅 تاریخ: 1405/07/10',
        '🕒 ساعت: 23:22',
      ].join('\n'),
    );
  });

  it('names a reseller truthfully, from the standing and nothing else', async () => {
    const screen = await composer.walletSummary(scope, {
      telegramId: '1',
      displayName: 'x',
      registeredAt: new Date('2026-09-01T08:00:00Z'),
      balance: money(0n, 'IRT'),
      serviceCount: 0,
      paidInvoiceCount: 0,
      referralCount: 0,
      group: 'RESELLER',
      now: new Date('2026-10-02T19:52:00Z'),
    });
    expect(render(screen.key, screen.values)).toContain('🔖 گروه کاربری: نماینده');
  });
});

describe('the pre-invoice', () => {
  const facts = {
    serviceUsername: 'ali_2026',
    productName: 'پلن ۳۰ روزه',
    durationDays: 30,
    total: money(250_000n, 'IRT'),
    trafficBytes: 53_687_091_200n,
    addedTrafficBytes: null,
    discount: null,
    cashback: null,
    locations: ['🇩🇪 آلمان', '🇳🇱 هلند', '🇹🇷 ترکیه'],
    features: ['✅ اتصال همزمان ۳ دستگاه', '✅ پشتیبانی ۲۴ ساعته'],
    walletBalance: money(1_000_000n, 'IRT'),
  };

  /*
   * B1: the customer is shown ONE editable description — the product's own — in place of the
   * separate «لوکیشن‌های محصول» and features blocks. The locations and features are still
   * product data (and still composed for an override that uses their blocks).
   */
  const description = 'سرورهای پرسرعت آلمان و هلند\nمناسب استفادهٔ روزمره و استریم';

  it('B1: renders the one customer-facing description in place of the location and feature blocks', async () => {
    const screen = await composer.preinvoice(scope, { ...facts, description });
    expect(screen.key).toBe('bot.order.preinvoice');
    expect(render(screen.key, screen.values)).toBe(
      [
        '🧾 پیش‌فاکتور',
        '',
        '📦 سرویس: پلن ۳۰ روزه',
        '👤 نام کاربری: ali_2026',
        '📅 مدت: 30 روز',
        '📊 حجم: 50 گیگابایت',
        '💵 مبلغ سفارش: 250,000 تومان',
        '',
        'سرورهای پرسرعت آلمان و هلند',
        'مناسب استفادهٔ روزمره و استریم',
        '',
        '💰 موجودی کیف پول: 1,000,000 تومان',
        '',
        '🛒 سفارش شما آماده پرداخت است؛ روش پرداخت را با دکمه‌های زیر انتخاب کنید. اگر روشی کارمزد داشته باشد، کارمزد و مبلغ قابل پرداخت در فاکتور همان روش جداگانه نمایش داده می‌شود.',
      ].join('\n'),
    );
  });

  it.each([
    ['no description', null],
    ['a blank description', '  \n '],
  ])(
    'B1: %s leaves no empty block, whatever locations and features the product has',
    async (_label, none) => {
      const screen = await composer.preinvoice(scope, { ...facts, description: none });
      const text = render(screen.key, screen.values);
      expect(text).not.toContain('لوکیشن');
      expect(text).not.toContain('آلمان');
      expect(text).not.toContain('{');
      expect(text).toContain(
        '📊 حجم: 50 گیگابایت\n💵 مبلغ سفارش: 250,000 تومان\n\n💰 موجودی کیف پول',
      );
    },
  );

  it('B1: an installation override that still names the blocks renders them from the kept data', async () => {
    const screen = await composer.preinvoice(scope, { ...facts, description });
    const override = '{productName}\n\n{locationsBlock}\n\n{featuresBlock}';
    const text = appearanceFallbackText(
      renderTemplateBody(
        templateDefinition('bot.order.preinvoice'),
        override,
        screen.values,
        'fa',
        DEFAULT_TEMPLATE_PRESENTATION,
      ),
    );
    expect(text).toContain('🌍 لوکیشن‌های محصول:\n🇩🇪 آلمان\n🇳🇱 هلند\n🇹🇷 ترکیه');
    expect(text).toContain('✅ اتصال همزمان ۳ دستگاه\n✅ پشتیبانی ۲۴ ساعته');
  });

  it('omits the optional sections cleanly when a product has nothing to show', async () => {
    const screen = await composer.preinvoice(scope, {
      ...facts,
      serviceUsername: null,
      locations: [],
      features: [],
    });
    const text = render(screen.key, screen.values);
    expect(text).not.toContain('لوکیشن');
    expect(text).not.toContain('نام کاربری');
    expect(text).not.toContain('{');
    expect(text).toContain(
      '📊 حجم: 50 گیگابایت\n💵 مبلغ سفارش: 250,000 تومان\n\n💰 موجودی کیف پول',
    );
  });

  it('shows the discount and the cashback as their own lines, with the FINAL price on the price line', async () => {
    const screen = await composer.preinvoice(scope, {
      ...facts,
      total: money(200_000n, 'IRT'),
      discount: { subtotal: money(250_000n, 'IRT'), discount: money(50_000n, 'IRT') },
      cashback: money(10_000n, 'IRT'),
    });
    const text = render(screen.key, screen.values);
    // The FINAL figure, labelled with the money model's «مبلغ سفارش» (brief C2.2).
    expect(text).toContain('💵 مبلغ سفارش: 200,000 تومان');
    expect(text).toContain('🏷 تخفیف: 50,000 تومان (قیمت پیش از تخفیف: 250,000 تومان)');
    expect(text).toContain('🎁 کش‌بک این سفارش پس از تحویل: 10,000 تومان');
  });

  it('renders an add-traffic package as added volume, not as a plan', async () => {
    const screen = await composer.preinvoice(scope, {
      ...facts,
      productName: 'بستهٔ ۲۰ گیگ',
      durationDays: null,
      trafficBytes: null,
      addedTrafficBytes: 21_474_836_480n,
      locations: [],
      features: [],
    });
    const text = render(screen.key, screen.values);
    expect(text).toContain('➕ حجم افزوده: 20 گیگابایت');
    expect(text).not.toContain('📅 مدت');
    expect(text).not.toContain('📊 حجم:');
  });
});

describe('the referral screens (R1: exactly two messages)', () => {
  const figures = {
    commissionPercent: 15,
    commissionScope: 'FIRST_PAID_ORDER' as const,
    minimumOrder: money(0n, 'IRT'),
    gift: { total: money(40_000n, 'IRT'), referrerPercent: 70, referredPercent: 30 },
    referralCount: 5,
    referredPurchaseCount: 2,
    referredPurchaseTotal: money(600_000n, 'IRT'),
    commissionReceivedTotal: money(90_000n, 'IRT'),
  };

  it('renders the forwardable invite with the approved copy, the rate and the link — and no figure about the customer', () => {
    const card = composer.referralInviteCard({
      commissionPercent: 15,
      referralLink: 'https://t.me/nexa_bot?start=ref-ABCDEFGH',
    });
    const text = render(card.key, card.values);
    expect(card.key).toBe('bot.referral.invite_card');
    /*
     * Batch 2026-10-10 (brief C2.5): the copy no longer promises a withdrawal to a bank
     * card — none exists; a commission is a wallet credit earned at delivery — nor an
     * unconditional welcome gift, which is flag-gated and off by default.
     */
    expect(text.startsWith('💼 دعوت به ربات')).toBe(true);
    expect(text).toContain(
      'طبق شرایط برنامهٔ زیرمجموعه‌گیری 15 درصد پورسانت می‌گیرد که پس از تحویل سرویس به کیف پول او در ربات واریز می‌شود.',
    );
    expect(text.endsWith('🔗 https://t.me/nexa_bot?start=ref-ABCDEFGH')).toBe(true);
    expect(text).not.toMatch(/کارت بانکی|برداشت/);
    // Nothing a customer would not want forwarded: no counts, no totals, no gift shares.
    expect(text).not.toContain('📊');
    expect(text).not.toContain('زیرمجموعه‌ها:');
    expect(text).not.toContain('پورسانت دریافتی');
    expect(text).not.toContain('هدیه عضویت:');
    expect(text).not.toContain('{');
  });

  it('renders the dashboard with every figure, the gift terms and the commission scope — never the link', async () => {
    const screen = await composer.referralDashboard(scope, figures);
    const text = render(screen.key, screen.values);
    expect(screen.key).toBe('bot.referral.dashboard');
    expect(text).toContain(
      '🎁 هدیه عضویت:\n• مجموع هدیه: 40,000 تومان\n• 70٪ برای شما (معرف)\n• 30٪ برای زیرمجموعه (کاربر جدید)',
    );
    expect(text).toContain(
      '💸 پورسانت خرید:\n• 15 درصد از مبلغ خرید زیرمجموعه به شما تعلق می‌گیرد\n• فقط برای اولین خرید هر زیرمجموعه',
    );
    expect(text).toContain(
      '📊 آمار شما:\n• زیرمجموعه‌ها: 5 نفر\n• خریدها: 2 عدد\n• مجموع خرید: 600,000 تومان\n• پورسانت دریافتی: 90,000 تومان',
    );
    // No minimum configured: the line is dropped, not shown as zero.
    expect(text).not.toContain('حداقل مبلغ خرید');
    expect(text).not.toContain('https://');
    expect(text).not.toContain('10 درصد');
  });

  it('names the minimum order and the every-order scope when they are configured', async () => {
    const screen = await composer.referralDashboard(scope, {
      ...figures,
      commissionScope: 'EVERY_PAID_ORDER',
      minimumOrder: money(200_000n, 'IRT'),
    });
    const text = render(screen.key, screen.values);
    expect(text).toContain('• برای همهٔ خریدهای زیرمجموعه');
    expect(text).toContain('• حداقل مبلغ خرید: 200,000 تومان');
  });

  it('omits the gift block when the signup gift is off', async () => {
    const screen = await composer.referralDashboard(scope, {
      ...figures,
      gift: null,
      referralCount: 0,
      referredPurchaseCount: 0,
      referredPurchaseTotal: money(0n, 'IRT'),
      commissionReceivedTotal: money(0n, 'IRT'),
    });
    const text = render(screen.key, screen.values);
    expect(text).not.toContain('هدیه عضویت');
    expect(text).not.toContain('{');
  });
});
