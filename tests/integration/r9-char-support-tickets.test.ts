import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makePin, makeRig, viewOf, type View } from './r9-char-support';

/**
 * Characterization of the support and tickets flow group of `bot-runtime.ts` (Round 9,
 * Phase B). `tickets.test.ts` drives the whole customer journey against the database and
 * asserts template keys, stored rows and callback prefixes; it does not pin what each screen
 * SAYS or the order of its buttons. This file does, for every screen the group draws:
 *
 *   support screen (/help, /paysupport), ticket list (empty and with one), category
 *   chooser, message prompt, created, ticket view, reply prompt, reply sent, close ask,
 *   closed, and the answer to a reply on a closed ticket.
 *
 * Pinned as it answers today: intent, template key, rendered text, buttons in order.
 */

const CUSTOMER = '951101';

const pin = makePin(expectedViews(), (actual, expected, label) =>
  expect(actual, label).toEqual(expected),
);

/** Dates and public codes differ run to run; their position is the contract. */
const stable = (view: View): View => ({
  ...view,
  text: view.text
    .replace(/\d{4}\/\d{2}\/\d{2}( \d{2}:\d{2})?/g, '<date>')
    .replace(/\b[A-Z0-9]{8}\b/g, '<code>'),
});

describe('the support and tickets flow of the Telegram bot, as it answers today', () => {
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
    return stable(viewOf(result, rig.lastDrawn()?.body));
  };
  /** The unmasked callback data of the last drawn message's button that starts with `prefix`. */
  const dataOf = (prefix: string): string => {
    const markup = rig.lastDrawn()?.body['reply_markup'] as
      { inline_keyboard?: { callback_data?: string }[][] } | undefined;
    const found = (markup?.inline_keyboard ?? [])
      .flat()
      .map((button) => button.callback_data ?? '')
      .find((data) => data.startsWith(prefix));
    if (found === undefined) throw new Error(`no ${prefix} button`);
    return found;
  };

  it('draws the support screen for /help and /paysupport', async () => {
    await rig.resolveCustomer(CUSTOMER);
    pin('support.help', await turn(rig.text('/help', CUSTOMER)));
    pin('support.paysupport', await turn(rig.text('/paysupport', CUSTOMER)));
  });

  it('walks the ticket journey: list, categories, prompt, created, view, reply, close', async () => {
    await rig.resolveCustomer(CUSTOMER);
    pin('ticket.list_empty', await turn(rig.text('/tickets', CUSTOMER)));
    const chooser = await turn(rig.tap('tkn:', CUSTOMER));
    pin('ticket.choose_category', chooser);
    pin('ticket.message_prompt', await turn(rig.tap(dataOf('tkc:'), CUSTOMER)));
    const created = await turn(rig.text('سرویس من از دیروز وصل نمی‌شود.', CUSTOMER));
    pin('ticket.created', created);
    const ticketId = dataOf('tkv:').slice('tkv:'.length);
    pin('ticket.list_one', await turn(rig.tap('tkl:', CUSTOMER)));
    pin('ticket.view', await turn(rig.tap(`tkv:${ticketId}`, CUSTOMER)));
    pin('ticket.reply_prompt', await turn(rig.tap(`tkr:${ticketId}`, CUSTOMER)));
    pin('ticket.reply_sent', await turn(rig.text('شماره پیگیری: ۱۲۳۴', CUSTOMER)));
    pin('ticket.view_after_reply', await turn(rig.tap(`tkv:${ticketId}`, CUSTOMER)));
    pin('ticket.close_ask', await turn(rig.tap(`tkq:${ticketId}`, CUSTOMER)));
    pin('ticket.closed', await turn(rig.tap(`tkx:${ticketId}`, CUSTOMER)));
    pin('ticket.reply_on_closed', await turn(rig.tap(`tkr:${ticketId}`, CUSTOMER)));
    pin('ticket.view_closed', await turn(rig.tap(`tkv:${ticketId}`, CUSTOMER)));
  });

  it("answers a ticket id that is not the customer's, and a malformed one", async () => {
    await rig.resolveCustomer(CUSTOMER);
    const unknown = rig.ctx().container.ids.uuid();
    pin('ticket.view_unknown', await turn(rig.tap(`tkv:${unknown}`, CUSTOMER)));
    pin('ticket.reply_unknown', await turn(rig.tap(`tkr:${unknown}`, CUSTOMER)));
    pin('ticket.close_unknown', await turn(rig.tap(`tkx:${unknown}`, CUSTOMER)));
    pin('ticket.view_malformed', await turn(rig.tap('tkv:nope', CUSTOMER)));
  });
});

function expectedViews(): Record<string, View> {
  return {
    'support.help': {
      intent: 'HELP',
      key: 'bot.faq.page',
      text: '💡 سوالات متداول ⁉️\n\n1️⃣ فیلترشکن شما آیپی ثابته؟ میتونم برای صرافی های ارز دیجیتال استفاده کنم؟\n\n✅ به دلیل وضعیت نت و محدودیت های کشور سرویس ما مناسب ترید نیست و فقط لوکیشن\u200c ثابته.\n\n2️⃣ اگه قبل از منقضی شدن اکانت، تمدیدش کنم روزهای باقی مانده می سوزد؟\n\n✅ خیر، روزهای باقیمونده اکانت موقع تمدید حساب میشن و اگه مثلا 5 روز قبل از منقضی شدن اکانت 1 ماهه خودتون اون رو تمدید کنید 5 روز باقیمونده + 30 روز تمدید میشه.\n\n3️⃣ اگه به یک اکانت بیشتر از حد مجاز متصل شیم چه اتفاقی میافته؟\n\n✅ در این صورت حجم سرویس شما زود تمام خواهد شد.\n\n4️⃣ فیلترشکن شما از چه نوعیه؟\n\n✅ سرویس\u200cهای ما بر پایهٔ v2ray هستند و از چند پروتکل پشتیبانی می\u200cکنند تا در زمان اختلال اینترنت هم گزینهٔ اتصال داشته باشید.\n\n5️⃣ فیلترشکن از کدوم کشور است؟\n\n✅ لوکیشن سرویس شما پس از خرید در کارت سرویس نمایش داده می\u200cشود. برای اطلاع از لوکیشن\u200cهای هر محصول پیش از خرید، توضیحات محصول را ببینید یا از پشتیبانی بپرسید.\n\n6️⃣ چطور باید از این فیلترشکن استفاده کنم؟\n\n✅ برای آموزش استفاده از برنامه، روی دکمه «📱 دانلود برنامه و آموزش اتصال» بزنید.\n\n7️⃣ فیلترشکن وصل نمیشه، چیکار کنم؟\n\n✅ به همراه یک عکس از پیغام خطایی که میگیرید به پشتیبانی مراجعه کنید.\n\n8️⃣ فیلترشکن شما تضمینی هست که همیشه مواقع متصل بشه؟\n\n✅ به دلیل قابل پیش\u200cبینی نبودن وضعیت نت کشور، امکان دادن تضمین نیست فقط می\u200cتونیم تضمین کنیم که تمام تلاشمون رو برای ارائه سرویس هر چه بهتر انجام بدیم.\n\n9️⃣ امکان بازگشت وجه دارید؟\n\n✅ اگر مشکل سرویس از سمت ما برطرف نشود، امکان درخواست بازگشت وجه وجود دارد؛ پس از بررسی، مبلغ تأییدشده به کیف پول شما در ربات واریز می\u200cشود.\n\n💡 در صورتی که جواب سوالتون رو نگرفتید میتونید به «پشتیبانی» مراجعه کنید.',
      buttons: [
        [['🎫 تیکت\u200cهای پشتیبانی', 'tkl:']],
        [['🔕 قطع پیام\u200cهای تبلیغاتی', 'mk:out']],
        [['🏠 بازگشت به منوی اصلی', 'mm:']],
      ],
    },
    'support.paysupport': {
      intent: 'SUPPORT',
      key: 'bot.faq.page',
      text: '💡 سوالات متداول ⁉️\n\n1️⃣ فیلترشکن شما آیپی ثابته؟ میتونم برای صرافی های ارز دیجیتال استفاده کنم؟\n\n✅ به دلیل وضعیت نت و محدودیت های کشور سرویس ما مناسب ترید نیست و فقط لوکیشن\u200c ثابته.\n\n2️⃣ اگه قبل از منقضی شدن اکانت، تمدیدش کنم روزهای باقی مانده می سوزد؟\n\n✅ خیر، روزهای باقیمونده اکانت موقع تمدید حساب میشن و اگه مثلا 5 روز قبل از منقضی شدن اکانت 1 ماهه خودتون اون رو تمدید کنید 5 روز باقیمونده + 30 روز تمدید میشه.\n\n3️⃣ اگه به یک اکانت بیشتر از حد مجاز متصل شیم چه اتفاقی میافته؟\n\n✅ در این صورت حجم سرویس شما زود تمام خواهد شد.\n\n4️⃣ فیلترشکن شما از چه نوعیه؟\n\n✅ سرویس\u200cهای ما بر پایهٔ v2ray هستند و از چند پروتکل پشتیبانی می\u200cکنند تا در زمان اختلال اینترنت هم گزینهٔ اتصال داشته باشید.\n\n5️⃣ فیلترشکن از کدوم کشور است؟\n\n✅ لوکیشن سرویس شما پس از خرید در کارت سرویس نمایش داده می\u200cشود. برای اطلاع از لوکیشن\u200cهای هر محصول پیش از خرید، توضیحات محصول را ببینید یا از پشتیبانی بپرسید.\n\n6️⃣ چطور باید از این فیلترشکن استفاده کنم؟\n\n✅ برای آموزش استفاده از برنامه، روی دکمه «📱 دانلود برنامه و آموزش اتصال» بزنید.\n\n7️⃣ فیلترشکن وصل نمیشه، چیکار کنم؟\n\n✅ به همراه یک عکس از پیغام خطایی که میگیرید به پشتیبانی مراجعه کنید.\n\n8️⃣ فیلترشکن شما تضمینی هست که همیشه مواقع متصل بشه؟\n\n✅ به دلیل قابل پیش\u200cبینی نبودن وضعیت نت کشور، امکان دادن تضمین نیست فقط می\u200cتونیم تضمین کنیم که تمام تلاشمون رو برای ارائه سرویس هر چه بهتر انجام بدیم.\n\n9️⃣ امکان بازگشت وجه دارید؟\n\n✅ اگر مشکل سرویس از سمت ما برطرف نشود، امکان درخواست بازگشت وجه وجود دارد؛ پس از بررسی، مبلغ تأییدشده به کیف پول شما در ربات واریز می\u200cشود.\n\n💡 در صورتی که جواب سوالتون رو نگرفتید میتونید به «پشتیبانی» مراجعه کنید.',
      buttons: [
        [['🎫 تیکت\u200cهای پشتیبانی', 'tkl:']],
        [['🔕 قطع پیام\u200cهای تبلیغاتی', 'mk:out']],
        [['🏠 بازگشت به منوی اصلی', 'mm:']],
      ],
    },
    'ticket.list_empty': {
      intent: 'TICKETS',
      key: 'bot.ticket.list_empty',
      text: '🎫 تیکت\u200cهای پشتیبانی\n\nهنوز تیکتی ثبت نکرده\u200cاید. برای ارتباط با پشتیبانی «➕ تیکت جدید» را بزنید.',
      buttons: [[['➕ تیکت جدید', 'tkn:']], [['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'ticket.choose_category': {
      intent: 'TICKET_NEW',
      key: 'bot.ticket.choose_category',
      text: '📂 موضوع تیکت خود را انتخاب کنید:',
      buttons: [
        [['مشکل اتصال', 'tkc:<id>']],
        [['خرید و پرداخت', 'tkc:<id>']],
        [['سرویس', 'tkc:<id>']],
        [['حساب کاربری', 'tkc:<id>']],
        [['سایر', 'tkc:<id>']],
        [['🔙 بازگشت به تیکت\u200cها', 'tkl:']],
      ],
    },
    'ticket.message_prompt': {
      intent: 'TICKET_CATEGORY',
      key: 'bot.ticket.message_prompt',
      text: '📝 موضوع: مشکل اتصال\n\nپیام خود را بنویسید و بفرستید (حداکثر 3000 نویسه).\nمی\u200cتوانید به\u200cجای متن، یک عکس یا فایل (PDF، تصویر یا متن) همراه با توضیح بفرستید.',
      buttons: [[['🔙 بازگشت به تیکت\u200cها', 'tkl:']]],
    },
    'ticket.created': {
      intent: 'USERNAME_TEXT',
      key: 'bot.ticket.created',
      text: '✅ تیکت #1 ثبت شد.\nپاسخ پشتیبانی در همین ربات برای شما فرستاده می\u200cشود.',
      buttons: [[['🎫 مشاهده تیکت', 'tkv:<id>']], [['🔙 بازگشت به تیکت\u200cها', 'tkl:']]],
    },
    'ticket.list_one': {
      intent: 'TICKETS',
      key: 'bot.ticket.list',
      text: '🎫 تیکت\u200cهای پشتیبانی\n\nتیکت\u200cهای شما در زیر آمده است؛ برای دیدن گفتگو روی هر تیکت بزنید. برای طرح موضوعی تازه «➕ تیکت جدید» را بزنید.',
      buttons: [
        [['🆕 باز | #1 مشکل اتصال', 'tkv:<id>']],
        [['➕ تیکت جدید', 'tkn:']],
        [['🏠 بازگشت به منوی اصلی', 'mm:']],
      ],
    },
    'ticket.view': {
      intent: 'TICKET_VIEW',
      key: 'bot.ticket.view',
      text: '🎫 تیکت #1\n📂 موضوع: مشکل اتصال\n📌 وضعیت: 🆕 باز\n\n👤 شما — <date>\nسرویس من از دیروز وصل نمی\u200cشود.',
      buttons: [
        [['✍️ ارسال پاسخ', 'tkr:<id>']],
        [['🔒 بستن تیکت', 'tkq:<id>']],
        [['🔙 بازگشت به تیکت\u200cها', 'tkl:']],
      ],
    },
    'ticket.reply_prompt': {
      intent: 'TICKET_REPLY',
      key: 'bot.ticket.reply_prompt',
      text: '✍️ پاسخ خود را برای تیکت #1 بنویسید و بفرستید (حداکثر 3000 نویسه).\nمی\u200cتوانید یک عکس یا فایل (PDF، تصویر یا متن) هم بفرستید.',
      buttons: [[['🎫 مشاهده تیکت', 'tkv:<id>']]],
    },
    'ticket.reply_sent': {
      intent: 'USERNAME_TEXT',
      key: 'bot.ticket.reply_sent',
      text: '✅ پیام شما به تیکت #1 افزوده شد.',
      buttons: [[['🎫 مشاهده تیکت', 'tkv:<id>']], [['🔙 بازگشت به تیکت\u200cها', 'tkl:']]],
    },
    'ticket.view_after_reply': {
      intent: 'TICKET_VIEW',
      key: 'bot.ticket.view',
      text: '🎫 تیکت #1\n📂 موضوع: مشکل اتصال\n📌 وضعیت: 🆕 باز\n\n👤 شما — <date>\nسرویس من از دیروز وصل نمی\u200cشود.\n\n👤 شما — <date>\nشماره پیگیری: ۱۲۳۴',
      buttons: [
        [['✍️ ارسال پاسخ', 'tkr:<id>']],
        [['🔒 بستن تیکت', 'tkq:<id>']],
        [['🔙 بازگشت به تیکت\u200cها', 'tkl:']],
      ],
    },
    'ticket.close_ask': {
      intent: 'TICKET_CLOSE_ASK',
      key: 'bot.ticket.close_ask',
      text: 'تیکت #1 بسته شود؟ پس از بستن، پیامی در این تیکت فرستاده نمی\u200cشود و برای موضوع تازه باید تیکت جدید ثبت کنید.',
      buttons: [[['✅ بله، بسته شود', 'tkx:<id>']], [['🎫 مشاهده تیکت', 'tkv:<id>']]],
    },
    'ticket.closed': {
      intent: 'TICKET_CLOSE',
      key: 'bot.ticket.closed',
      text: '🔒 تیکت #1 بسته شد. از همراهی شما سپاسگزاریم.',
      buttons: [[['🔙 بازگشت به تیکت\u200cها', 'tkl:']]],
    },
    'ticket.reply_on_closed': {
      intent: 'TICKET_REPLY',
      key: 'bot.ticket.already_closed',
      text: 'این تیکت بسته شده است. برای ادامهٔ گفتگو یک تیکت جدید ثبت کنید.',
      buttons: [[['➕ تیکت جدید', 'tkn:']], [['🔙 بازگشت به تیکت\u200cها', 'tkl:']]],
    },
    'ticket.view_closed': {
      intent: 'TICKET_VIEW',
      key: 'bot.ticket.view',
      text: '🎫 تیکت #1\n📂 موضوع: مشکل اتصال\n📌 وضعیت: 🔒 بسته\u200cشده\n\n👤 شما — <date>\nسرویس من از دیروز وصل نمی\u200cشود.\n\n👤 شما — <date>\nشماره پیگیری: ۱۲۳۴\n\n🔒 <date> — تیکت را بستید.',
      buttons: [[['➕ تیکت جدید', 'tkn:']], [['🔙 بازگشت به تیکت\u200cها', 'tkl:']]],
    },
    'ticket.view_unknown': {
      intent: 'TICKET_VIEW',
      key: 'bot.ticket.not_found',
      text: 'این تیکت پیدا نشد.',
      buttons: [[['🔙 بازگشت به تیکت\u200cها', 'tkl:']]],
    },
    'ticket.reply_unknown': {
      intent: 'TICKET_REPLY',
      key: 'bot.ticket.not_found',
      text: 'این تیکت پیدا نشد.',
      buttons: [[['🔙 بازگشت به تیکت\u200cها', 'tkl:']]],
    },
    'ticket.close_unknown': {
      intent: 'TICKET_CLOSE',
      key: 'bot.ticket.not_found',
      text: 'این تیکت پیدا نشد.',
      buttons: [[['🔙 بازگشت به تیکت\u200cها', 'tkl:']]],
    },
    'ticket.view_malformed': {
      intent: 'UNSUPPORTED',
      key: 'bot.callback.stale',
      text: 'ℹ️ این دکمه دیگر فعال نیست. برای ادامه، دکمهٔ زیر را بزنید.',
      buttons: [[['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
  };
}
