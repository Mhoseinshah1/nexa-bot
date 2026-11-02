import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tenantA } from './harness';
import { makePin, makeRig, viewOf, type View } from './r9-char-support';

/**
 * Characterization of the start/menu flow group of `bot-runtime.ts` (Round 9, Phase B):
 * the greeting a first `/start` and a later one answer, the persistent reply keyboard that
 * only that answer attaches, the main-menu button, an administrator's variant of the
 * keyboard, the answer to text the bot does not understand, and the marketing preference
 * (`/stop` and its opt-in button) whose existing test pins template keys only.
 *
 * Pinned as it answers today: intent, template key, rendered text, inline buttons in order
 * and the reply keyboard.
 */

const CUSTOMER = '931001';
const ADMIN = '931002';

const pin = makePin(expectedViews(), (actual, expected, label) =>
  expect(actual, label).toEqual(expected),
);

describe('the start and menu flow of the Telegram bot, as it answers today', () => {
  const rig = makeRig();

  beforeAll(async () => {
    await rig.start();
  }, 120_000);
  afterAll(async () => {
    await rig.stop();
  });
  beforeEach(async () => {
    await rig.reset();
  });

  const turn = async (update: ReturnType<typeof rig.tap>): Promise<View> => {
    rig.sent.length = 0;
    const result = await rig.handle(update);
    return viewOf(result, rig.lastDrawn()?.body);
  };

  it('greets a first /start with the welcome and the persistent keyboard, and a later one with the welcome-back', async () => {
    pin('start.first', await turn(rig.text('/start', CUSTOMER)));
    pin('start.again', await turn(rig.text('/start', CUSTOMER)));
  });

  it('answers the main-menu button with the welcome-back and no inline buttons', async () => {
    await rig.resolveCustomer(CUSTOMER);
    pin('menu.main', await turn(rig.tap('mm:', CUSTOMER)));
  });

  it('attaches the administrator variant of the keyboard for a bound administrator', async () => {
    await rig.boundAdmin('r9-menu-admin', ADMIN, ['owner']);
    pin('start.admin', await turn(rig.text('/start', ADMIN)));
    pin('menu.admin', await turn(rig.tap('mm:', ADMIN)));
  });

  it('answers text it does not understand, and a button it no longer knows', async () => {
    await rig.resolveCustomer(CUSTOMER);
    pin('unknown.text', await turn(rig.text('سلام این یک متن آزاد است', CUSTOMER)));
    pin('unknown.command', await turn(rig.text('/nosuchcommand', CUSTOMER)));
    pin('unknown.callback', await turn(rig.tap('zz:whatever', CUSTOMER)));
  });

  it('opts out on /stop and back in from the opt-in button, each answered idempotently with the button that undoes it', async () => {
    await rig.resolveCustomer(CUSTOMER);
    // Each reply carries the way back: after /stop the opt-in button, after the opt-in the
    // opt-out button, and the same again for a repeated tap (Round 10 B2; Round 9 pinned
    // the reverse, the button for what had just been done).
    pin('marketing.opted_out', await turn(rig.text('/stop', CUSTOMER)));
    pin('marketing.opted_out_again', await turn(rig.text('/stop', CUSTOMER)));
    pin('marketing.opted_in', await turn(rig.tap('mk:in', CUSTOMER)));
    pin('marketing.opted_in_again', await turn(rig.tap('mk:in', CUSTOMER)));
    pin('marketing.opt_out_button', await turn(rig.tap('mk:out', CUSTOMER)));
    const stored = await rig
      .ctx()
      .container.database.db.execute(
        sql`SELECT marketing_opt_out_at IS NOT NULL AS out FROM customers`,
      );
    expect((stored.rows[0] as { out: boolean }).out).toBe(true);
  });

  it('answers /stop and the opt-in button as unavailable, changing nothing, while the installation does not allow opting out', async () => {
    const customer = await rig.resolveCustomer(CUSTOMER);
    const container = rig.ctx().container;
    const current = await container.featureFlagResolver.resolve(
      tenantA,
      'customer_marketing_opt_out',
    );
    await container.featureFlags.set(tenantA, await rig.owner(), {
      key: 'customer_marketing_opt_out',
      enabled: false,
      expectedVersion: current.version,
      idempotencyKey: 'r9-marketing-off',
      reason: 'Round 9 characterization.',
    });
    pin('marketing.unavailable', await turn(rig.text('/stop', CUSTOMER)));
    expect(customer).toBeDefined();
  });
});

function expectedViews(): Record<string, View> {
  return {
    'start.first': {
      intent: 'START',
      key: 'bot.start.welcome',
      text: 'ZED PROXY\n━━━━━━━━━━━━\nx عزیز، خوش آمدید.\n\n✓ اتصال پایدار با لوکیشن\u200cهای متنوع\n✓ کار با همه اپ\u200cهای داخلی بدون خاموش کردن فیلترشکن\n✓ سرویس تست رایگان قبل از خرید\n✓ پشتیبانی از داخل همین ربات\n\nبرای شروع از منوی پایین «🛒 خرید اشتراک» یا «🧪 سرویس تست» را بزنید.',
      buttons: [],
      replyKeyboard: [
        ['🛒 خرید اشتراک', '📱 سرویس\u200cهای من'],
        ['💰 کیف پول', '💬 پشتیبانی'],
        ['📱 دانلود برنامه و آموزش اتصال'],
        ['🎫 پشتیبانی / تیکت\u200cها'],
      ],
    },
    'start.again': {
      intent: 'START',
      key: 'bot.start.welcome_back',
      text: '👋 سلام x، خوش برگشتی\n\n📱 ۰ سرویس فعال داری\n\nاگه سرویست داره تموم می\u200cشه، از «📱 سرویس\u200cهای من» همین الان تمدیدش کن تا وسط کار قطع نشی 🔄',
      buttons: [],
      replyKeyboard: [
        ['🛒 خرید اشتراک', '📱 سرویس\u200cهای من'],
        ['💰 کیف پول', '💬 پشتیبانی'],
        ['📱 دانلود برنامه و آموزش اتصال'],
        ['🎫 پشتیبانی / تیکت\u200cها'],
      ],
    },
    'menu.main': {
      intent: 'MAIN_MENU',
      key: 'bot.start.welcome_back',
      text: '👋 سلام x، خوش برگشتی\n\n📱 ۰ سرویس فعال داری\n\nاگه سرویست داره تموم می\u200cشه، از «📱 سرویس\u200cهای من» همین الان تمدیدش کن تا وسط کار قطع نشی 🔄',
      buttons: [],
      replyKeyboard: [
        ['🛒 خرید اشتراک', '📱 سرویس\u200cهای من'],
        ['💰 کیف پول', '💬 پشتیبانی'],
        ['📱 دانلود برنامه و آموزش اتصال'],
        ['🎫 پشتیبانی / تیکت\u200cها'],
      ],
    },
    'start.admin': {
      intent: 'START',
      key: 'bot.start.welcome',
      text: 'ZED PROXY\n━━━━━━━━━━━━\nx عزیز، خوش آمدید.\n\n✓ اتصال پایدار با لوکیشن\u200cهای متنوع\n✓ کار با همه اپ\u200cهای داخلی بدون خاموش کردن فیلترشکن\n✓ سرویس تست رایگان قبل از خرید\n✓ پشتیبانی از داخل همین ربات\n\nبرای شروع از منوی پایین «🛒 خرید اشتراک» یا «🧪 سرویس تست» را بزنید.',
      buttons: [],
      replyKeyboard: [
        ['🛒 خرید اشتراک', '📱 سرویس\u200cهای من'],
        ['💰 کیف پول', '💬 پشتیبانی'],
        ['📱 دانلود برنامه و آموزش اتصال'],
        ['🎫 پشتیبانی / تیکت\u200cها'],
        ['👨\u200d💼 پنل مدیریت'],
      ],
    },
    'menu.admin': {
      intent: 'MAIN_MENU',
      key: 'bot.start.welcome_back',
      text: '👋 سلام x، خوش برگشتی\n\n📱 ۰ سرویس فعال داری\n\nاگه سرویست داره تموم می\u200cشه، از «📱 سرویس\u200cهای من» همین الان تمدیدش کن تا وسط کار قطع نشی 🔄',
      buttons: [],
      replyKeyboard: [
        ['🛒 خرید اشتراک', '📱 سرویس\u200cهای من'],
        ['💰 کیف پول', '💬 پشتیبانی'],
        ['📱 دانلود برنامه و آموزش اتصال'],
        ['🎫 پشتیبانی / تیکت\u200cها'],
        ['👨\u200d💼 پنل مدیریت'],
      ],
    },
    'unknown.text': {
      intent: 'USERNAME_TEXT',
      key: 'bot.unknown_command',
      text: 'این دستور شناخته نشد. برای دیدن فهرست دستورها /help را بفرستید.',
      buttons: [[['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'unknown.command': {
      intent: 'USERNAME_TEXT',
      key: 'bot.unknown_command',
      text: 'این دستور شناخته نشد. برای دیدن فهرست دستورها /help را بفرستید.',
      buttons: [[['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'unknown.callback': {
      intent: 'UNSUPPORTED',
      key: 'bot.callback.stale',
      text: 'ℹ️ این دکمه دیگر فعال نیست. برای ادامه، دکمهٔ زیر را بزنید.',
      buttons: [[['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'marketing.opted_out': {
      intent: 'MARKETING_OPT_OUT',
      key: 'bot.marketing.opted_out',
      text: '🔕 پیام\u200cهای تبلیغاتی برای شما قطع شد.\nاطلاع\u200cرسانی\u200cهای مربوط به پرداخت، سرویس و پشتیبانی شما همچنان ارسال می\u200cشود. هر وقت خواستید، با دکمهٔ زیر دوباره فعال کنید.',
      buttons: [
        [['🔔 دریافت پیام\u200cهای تبلیغاتی', 'mk:in']],
        [['🏠 بازگشت به منوی اصلی', 'mm:']],
      ],
    },
    'marketing.opted_out_again': {
      intent: 'MARKETING_OPT_OUT',
      key: 'bot.marketing.opted_out',
      text: '🔕 پیام\u200cهای تبلیغاتی برای شما قطع شد.\nاطلاع\u200cرسانی\u200cهای مربوط به پرداخت، سرویس و پشتیبانی شما همچنان ارسال می\u200cشود. هر وقت خواستید، با دکمهٔ زیر دوباره فعال کنید.',
      buttons: [
        [['🔔 دریافت پیام\u200cهای تبلیغاتی', 'mk:in']],
        [['🏠 بازگشت به منوی اصلی', 'mm:']],
      ],
    },
    'marketing.opted_in': {
      intent: 'MARKETING_OPT_IN',
      key: 'bot.marketing.opted_in',
      text: '🔔 پیام\u200cهای تبلیغاتی دوباره برای شما فعال شد.',
      buttons: [[['🔕 قطع پیام\u200cهای تبلیغاتی', 'mk:out']], [['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'marketing.opted_in_again': {
      intent: 'MARKETING_OPT_IN',
      key: 'bot.marketing.opted_in',
      text: '🔔 پیام\u200cهای تبلیغاتی دوباره برای شما فعال شد.',
      buttons: [[['🔕 قطع پیام\u200cهای تبلیغاتی', 'mk:out']], [['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'marketing.opt_out_button': {
      intent: 'MARKETING_OPT_OUT',
      key: 'bot.marketing.opted_out',
      text: '🔕 پیام\u200cهای تبلیغاتی برای شما قطع شد.\nاطلاع\u200cرسانی\u200cهای مربوط به پرداخت، سرویس و پشتیبانی شما همچنان ارسال می\u200cشود. هر وقت خواستید، با دکمهٔ زیر دوباره فعال کنید.',
      buttons: [
        [['🔔 دریافت پیام\u200cهای تبلیغاتی', 'mk:in']],
        [['🏠 بازگشت به منوی اصلی', 'mm:']],
      ],
    },
    'marketing.unavailable': {
      intent: 'MARKETING_OPT_OUT',
      key: 'bot.marketing.unavailable',
      text: 'ℹ️ در حال حاضر امکان قطع یا وصل پیام\u200cهای تبلیغاتی در این ربات فعال نیست.\nاطلاع\u200cرسانی\u200cهای مربوط به پرداخت، سرویس و پشتیبانی شما مثل همیشه ارسال می\u200cشود.',
      buttons: [[['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
  };
}
