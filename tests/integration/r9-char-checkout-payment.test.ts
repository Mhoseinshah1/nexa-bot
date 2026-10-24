import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makePin, makeRig, maskIds, viewOf, type View } from './r9-char-support';
import { systemActor } from './r9-char-support';
import { tenantA } from './harness';

/**
 * Characterization of the checkout-payment flow group of `bot-runtime.ts` (Round 9,
 * Phase B), for the two entry points no other test reaches through `BotRuntime.handle`:
 *
 *   - `px:<order>` («❌ بستن لیست» on the payment-method selector) -> PAY_METHODS_CLOSE
 *     -> `paymentMethodsBack`, which answers the screen the selector was opened from;
 *   - `/start tp-<payment>` (the TetraPay return deep link)        -> GATEWAY_RETURN
 *     -> `gatewayCheck`, the same question as «بررسی وضعیت».
 *
 * and, since they are the neighbours that make `px:` meaningful, the selector itself
 * (`pm:<order>`) and the awaiting-payment message it returns to. Everything is pinned as
 * it answers today: intent, template key, rendered text and the buttons in order.
 */

const CUSTOMER = '930001';
const OTHER = '930002';

const pin = makePin(expectedViews(), (actual, expected, label) =>
  expect(actual, label).toEqual(expected),
);

/** The expiry and the public order code are the only per-run values on these screens. */
const stable = (view: View): View => ({
  ...view,
  text: view.text
    .replace(/اعتبار تا: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/, 'اعتبار تا: <deadline>')
    .replace(/کد سفارش: [A-Z0-9]{8}/, 'کد سفارش: <code>'),
});

describe('the checkout-payment flow of the Telegram bot, as it answers today', () => {
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

  it('opens the method selector for an order and closes it back to the awaiting-payment message', async () => {
    const customer = await rig.resolveCustomer(CUSTOMER);
    const product = await rig.product();
    const order = await rig.awaitingOrder(customer, product, 'r9-await');

    pin('awaiting.methods', await turn(rig.tap(`pm:${order}`, CUSTOMER)));
    // «❌ بستن لیست» on an order awaiting payment draws the awaiting-payment message again.
    pin('awaiting.close', await turn(rig.tap(`px:${order}`, CUSTOMER)));
  });

  it('closes the selector of a draft purchase back to its pre-invoice', async () => {
    const customer = await rig.resolveCustomer(CUSTOMER);
    const product = await rig.product();
    const draft = await rig.draftOrder(customer, product, 'r9-draft');

    pin('draft.methods', await turn(rig.tap(`pm:${draft}`, CUSTOMER)));
    pin('draft.close', await turn(rig.tap(`px:${draft}`, CUSTOMER)));
  });

  it('closes the selector of an order that is no longer payable to the main menu, and says so for the selector itself', async () => {
    const customer = await rig.resolveCustomer(CUSTOMER);
    const product = await rig.product();
    const order = await rig.awaitingOrder(customer, product, 'r9-cancelled');
    await rig.ctx().container.orders.cancelByCustomer(tenantA, systemActor('r9-cancel'), {
      idempotencyKey: 'r9-cancel-key',
      customerId: customer,
      orderId: order,
    });

    pin('cancelled.methods', await turn(rig.tap(`pm:${order}`, CUSTOMER)));
    pin('cancelled.close', await turn(rig.tap(`px:${order}`, CUSTOMER)));
    // The main-menu answer also attaches the persistent keyboard to the reply.
    const body = rig.lastDrawn()?.body ?? {};
    expect(JSON.stringify(body['reply_markup'])).toContain('keyboard');
  });

  it("answers the same refusal for an order that is not the customer's, and for one that does not exist", async () => {
    const customer = await rig.resolveCustomer(CUSTOMER);
    await rig.resolveCustomer(OTHER, 'رضا');
    const product = await rig.product();
    const order = await rig.awaitingOrder(customer, product, 'r9-foreign');

    pin('foreign.methods', await turn(rig.tap(`pm:${order}`, OTHER)));
    pin('foreign.close', await turn(rig.tap(`px:${order}`, OTHER)));
    pin('unknown.close', await turn(rig.tap(`px:${rig.ctx().container.ids.uuid()}`, CUSTOMER)));
  });

  it("answers the TetraPay return deep link for a payment that is not the customer's as a closed attempt", async () => {
    await rig.resolveCustomer(CUSTOMER);
    const unknown = rig.ctx().container.ids.uuid();
    const returned = await turn(rig.text(`/start tp-${unknown}`, CUSTOMER));
    pin('return.unknown_payment', returned);
    // Not a payment id at all: an ordinary /start.
    const plain = await turn(rig.text('/start tp-nonsense', CUSTOMER));
    expect(plain.intent).toBe('START');
    expect(maskIds(plain.text)).not.toContain('<id>');
  });
});

function expectedViews(): Record<string, View> {
  return {
    'awaiting.methods': {
      intent: 'PAY_METHODS',
      key: 'bot.wallet.topup_method_prompt',
      text: '💰 روش پرداخت را انتخاب کنید.',
      buttons: [[['پرداخت با کارت به کارت', 'm:<id>']], [['❌ بستن لیست', 'px:<id>']]],
    },
    'awaiting.close': {
      intent: 'PAY_METHODS_CLOSE',
      key: 'bot.order.awaiting_payment',
      text: 'سفارش ثبت شد و در انتظار پرداخت است.\nمبلغ: 250,000 تومان\nاعتبار تا: <deadline>',
      buttons: [
        [['💰 پرداخت از کیف پول', 'w:<id>']],
        [['🧾 ثبت پرداخت', 'pm:<id>']],
        [['لغو سفارش', 'd:<id>']],
      ],
    },
    'draft.methods': {
      intent: 'PAY_METHODS',
      key: 'bot.wallet.topup_method_prompt',
      text: '💰 روش پرداخت را انتخاب کنید.',
      buttons: [[['پرداخت با کارت به کارت', 'm:<id>']], [['❌ بستن لیست', 'px:<id>']]],
    },
    'draft.close': {
      intent: 'PAY_METHODS_CLOSE',
      key: 'bot.order.preinvoice',
      text: '🧾 پیش\u200cفاکتور\n🔖 کد سفارش: <code>\n\n📦 سرویس: پلن پایه\n📅 مدت: 30 روز\n📊 حجم: 50 گیگابایت\n💵 مبلغ سفارش: 250,000 تومان\n\n💰 موجودی کیف پول: 0 تومان\n\n🛒 سفارش شما آماده پرداخت است؛ روش پرداخت را با دکمه\u200cهای زیر انتخاب کنید. اگر روشی کارمزد داشته باشد، کارمزد و مبلغ قابل پرداخت در فاکتور همان روش جداگانه نمایش داده می\u200cشود.',
      buttons: [
        [['💰 پرداخت از کیف پول', 'w:<id>']],
        [['🧾 ثبت پرداخت', 'pm:<id>']],
        [['🏷 اعمال کد تخفیف', 'dc:<id>']],
        [['🏠 بازگشت به منوی اصلی', 'mm:']],
      ],
    },
    'cancelled.methods': {
      intent: 'PAY_METHODS',
      key: 'bot.order.not_awaiting_payment',
      text: 'این سفارش دیگر در انتظار پرداخت نیست.',
      buttons: [[['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'cancelled.close': {
      intent: 'PAY_METHODS_CLOSE',
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
    'foreign.methods': {
      intent: 'PAY_METHODS',
      key: 'bot.order.unavailable',
      text: '⚠️ این سرویس در حال حاضر قابل خرید نیست.',
      buttons: [],
    },
    'foreign.close': {
      intent: 'PAY_METHODS_CLOSE',
      key: 'bot.order.unavailable',
      text: '⚠️ این سرویس در حال حاضر قابل خرید نیست.',
      buttons: [],
    },
    'unknown.close': {
      intent: 'PAY_METHODS_CLOSE',
      key: 'bot.order.unavailable',
      text: '⚠️ این سرویس در حال حاضر قابل خرید نیست.',
      buttons: [],
    },
    'return.unknown_payment': {
      intent: 'GATEWAY_RETURN',
      key: 'bot.payment.gateway_closed',
      text: 'این فاکتور دیگر قابل پرداخت نیست (مهلت آن تمام شده یا بسته شده است). برای پرداخت می\u200cتوانید دوباره اقدام کنید.',
      buttons: [[['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
  };
}
