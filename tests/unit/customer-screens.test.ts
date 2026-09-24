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

/**
 * The approved customer screens, pinned as TEXT (customer UX completion §Q).
 *
 * The composer renders the sub-lines through the resolver and hands back a key and
 * values; rendering the main key through the same catalogue here produces exactly what
 * a customer reads. Every expectation below is the owner's approved default, so a
 * change to any of these lines is a product decision and fails here first.
 */
const scope = { tenantId: 'tenant-1', botInstanceId: null } as unknown as ScopeContext;

const render = (key: TemplateKey, values: TemplateValues): string =>
  renderTemplateBody(
    templateDefinition(key),
    CATALOGUE_FA[key],
    values,
    'fa',
    DEFAULT_TEMPLATE_PRESENTATION,
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
        '💡 برای قطع دسترسی دیگران کافیست روی گزینه "تغییر لینک" کلیک کنید.',
      ].join('\n'),
    );
  });

  it('never turns an unread usage into 0, and never claims never-connected for an unsupported field', async () => {
    const screen = await composer.serviceCard(scope, { ...base, usageSyncedAt: null });
    const text = render(screen.key, screen.values);
    expect(text).toContain('📥 حجم مصرفی: هنوز از سرور خوانده نشده');
    expect(text).toContain('💢 حجم باقی مانده: هنوز از سرور خوانده نشده');
    expect(text).not.toContain('0 بایت');
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
    expect(text).toContain('📥 حجم مصرفی: 0 بایت');
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
    expect(text).toContain('💢 حجم باقی مانده: 0 بایت (0%)');
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
    });
    expect(screen.key).toBe('bot.wallet.summary');
    expect(render(screen.key, screen.values)).toBe(
      [
        '🎡 اطلاعات حساب کاربری شما:',
        '',
        '🪪 آی دی عددی: 910910',
        '👤 نام: مریم احمدی',
        '⚫ شماره تماس: 🔴 ارسال نشده است',
        '⏳ زمان ثبت نام: 1405/06/10 11:30',
        '⭐ موجودی: 1,250,000 تومان',
        '🛒 تعداد سرویس های خریداری شده: 3 عدد',
        '🧾 تعداد فاکتورهای پرداخت شده: 4 عدد',
        '👥 تعداد زیرمجموعه های شما: 2 نفر',
        '🔖 گروه کاربری: کاربر عادی',
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

  it('renders the approved structure with the ordered blocks', async () => {
    const screen = await composer.preinvoice(scope, facts);
    expect(screen.key).toBe('bot.order.preinvoice');
    expect(render(screen.key, screen.values)).toBe(
      [
        '🧾 پیش فاکتور شما:',
        '',
        '👤 نام کاربر: ali_2026',
        '🔐 نام سرویس: پلن ۳۰ روزه',
        '📆 مدت اعتبار: 30 روز',
        '💵 قیمت: 250,000 تومان',
        '👥 حجم اکانت: 50 گیگابایت',
        '',
        '🌍 لوکیشن‌های محصول:',
        '🇩🇪 آلمان',
        '🇳🇱 هلند',
        '🇹🇷 ترکیه',
        '',
        '✅ اتصال همزمان ۳ دستگاه',
        '✅ پشتیبانی ۲۴ ساعته',
        '',
        '💰 موجودی کیف پول شما: 1,000,000 تومان',
        '',
        '💰 سفارش شما آماده پرداخت است',
      ].join('\n'),
    );
  });

  it('omits the location and feature sections cleanly when a product has none', async () => {
    const screen = await composer.preinvoice(scope, {
      ...facts,
      serviceUsername: null,
      locations: [],
      features: [],
    });
    const text = render(screen.key, screen.values);
    expect(text).not.toContain('لوکیشن');
    expect(text).not.toContain('نام کاربر');
    expect(text).not.toContain('{');
    expect(text).toContain('💵 قیمت: 250,000 تومان\n👥 حجم اکانت: 50 گیگابایت\n\n💰 موجودی کیف پول شما');
  });

  it('shows the discount and the cashback as their own lines, with the FINAL price on the price line', async () => {
    const screen = await composer.preinvoice(scope, {
      ...facts,
      total: money(200_000n, 'IRT'),
      discount: { subtotal: money(250_000n, 'IRT'), discount: money(50_000n, 'IRT') },
      cashback: money(10_000n, 'IRT'),
    });
    const text = render(screen.key, screen.values);
    expect(text).toContain('💵 قیمت: 200,000 تومان');
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
    expect(text).not.toContain('مدت اعتبار');
    expect(text).not.toContain('حجم اکانت');
  });
});

describe('the referral screen', () => {
  it('renders the approved copy with the configured figures, never hard-coded ones', async () => {
    const screen = await composer.referralScreen(scope, {
      commissionPercent: 15,
      referralLink: 'https://t.me/nexa_bot?start=ref-ABCDEFGH',
      gift: { total: money(40_000n, 'IRT'), referrerPercent: 70, referredPercent: 30 },
      referralCount: 5,
      referredPurchaseCount: 2,
      referredPurchaseTotal: money(600_000n, 'IRT'),
      commissionReceivedTotal: money(90_000n, 'IRT'),
    });
    const text = render(screen.key, screen.values);
    expect(text).toContain('به ازای هر فرد جدیدی که برای اولین بار با لینک شما وارد ربات شود و خرید انجام دهد 15 درصد پورسانت دریافت کنید!');
    expect(text).toContain('🔗 https://t.me/nexa_bot?start=ref-ABCDEFGH');
    expect(text).toContain(
      '🎁 هدیه عضویت:\n• مجموع هدیه: 40,000 تومان\n• 70٪ برای شما (معرف)\n• 30٪ برای زیرمجموعه (کاربر جدید)',
    );
    expect(text).toContain('💸 پورسانت خرید:\n• 15 درصد از مبلغ خرید زیرمجموعه به شما تعلق می‌گیرد');
    expect(text).toContain(
      '📊 آمار شما:\n• زیرمجموعه‌ها: 5 نفر\n• خریدها: 2 عدد\n• مجموع خرید: 600,000 تومان\n• پورسانت دریافتی: 90,000 تومان',
    );
    expect(text.endsWith('📢 دعوت کن، هدیه بگیر، رشد کن!')).toBe(true);
    expect(text).not.toContain('10 درصد');
  });

  it('omits the gift block when the signup gift is off', async () => {
    const screen = await composer.referralScreen(scope, {
      commissionPercent: 10,
      referralLink: 'https://t.me/x?start=ref-A',
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
