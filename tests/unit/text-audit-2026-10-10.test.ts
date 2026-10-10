import { describe, expect, it } from 'vitest';
import {
  money,
  templateDefinition,
  validateTemplateBody,
  type PlaceholderDefinition,
  type TemplateKey,
  type TemplateValue,
  type TemplateValues,
} from '@nexa/contracts';
import { CATALOGUE_FA, DEFAULT_TEMPLATE_PRESENTATION, renderTemplateBody } from '@nexa/i18n';
import { appearanceFallbackText } from '../../apps/api/src/modules/commerce/messaging/application/appearance-render';

/**
 * Batch 2026-10-10 text audit (brief FIX-07, §C2–C7; `docs/text-audit-2026-10-10.md`).
 *
 * Two kinds of pin. The render matrix holds every changed DEFAULT body to the mechanics a
 * customer would otherwise see broken — a valid body, no literal `{token}` or `{icon:…}`
 * whatever the optional values, under Telegram's 4096 — and the truth pins hold each body
 * to the FACT it was changed for, by meaning rather than by bytes, so the next copy edit is
 * free to reword it and is stopped only if it re-introduces the false claim.
 *
 * Defaults only, with one exception: no placeholder was removed, and the one added
 * (`bot.admin.app_video_prompt`'s `{minutes}`) is optional — so a tenant's stored override of
 * any of these keys still validates and renders exactly as before (pinned below).
 */

/** Every key whose default this batch changed. */
const CHANGED = [
  'bot.payment.receipt_credited_to_wallet',
  'bot.order.preinvoice',
  'bot.payment.gateway_invoice',
  'bot.payment.gateway_invoice_order_fee',
  'bot.payment.gateway_invoice_topup_fee',
  'bot.payment.pending_reminder',
  'bot.referral.invite_card',
  'bot.referral.screen',
  'bot.support.handoff_notice',
  'bot.service.transfer_confirm',
  'bot.service.transfer_received',
  'bot.service.list',
  'bot.service.location_requested',
  // Part 2 (`fix10/text-p2-p3`): brief §C3, §C4 and §C5.
  'bot.service.suspend_confirm',
  'bot.service.resume_confirm',
  'bot.service.suspend_button',
  'bot.service.resume_button',
  'bot.terms.updated',
  'bot.admin.app_video_prompt',
  'bot.payment.centralpay_review_unresolved',
  'bot.payment.nowpayments_review_unresolved',
  'bot.payment.gateway_review_unresolved',
  'bot.payment.expired',
  'bot.service.state_exhausted',
  'bot.service.state_expired',
  'bot.payment.receipt_received',
  'bot.payment.gateway_card_invoice',
  'bot.payment.gateway_receipt_button',
  'bot.payment.gateway_card_receipt_sent',
  'bot.payment.gateway_card_receipt_refused',
  'bot.payment.gateway_in_review',
  'bot.payment.gateway_receipt_prompt',
  'bot.payment.gateway_receipt_queued',
  'bot.payment.gateway_receipt_photo_only',
  'bot.payment.gateway_receipt_already_sent',
  'bot.payment.gateway_receipt_too_large',
  'bot.payment.gateway_card_changing',
  'bot.payment.gateway_card_unconfirmed',
  'bot.payment.gateway_card_missing',
  'bot.payment.stars_invoice_order_fee',
  'bot.payment.stars_invoice_order',
  'bot.service.card',
  'bot.wallet.summary',
  'bot.service.link_qr_caption',
  'bot.admin.app_not_found',
  'bot.admin.app_video_stale',
  'bot.callback.stale',
  'bot.ticket.line_escalated',
  'bot.wallet.topup_method_prompt',
  'bot.wallet.topup_refused',
  'bot.service.renew_paid',
  'bot.order.settled',
  'bot.payment.sent_button',
  'bot.apps.alternative_button',
  'bot.wallet.topup_method_gift_button',
  'bot.faq.default_4_answer',
  'bot.faq.default_5_answer',
  'bot.faq.default_9_answer',
  'bot.username.choose',
  'bot.username.instructions',
  'bot.username.invalid',
  'bot.username.taken',
  'bot.username.exhausted',
  'bot.username.unavailable',
  'bot.username.mode_unavailable',
  'bot.username.stale',
] as const satisfies readonly TemplateKey[];

const body = (key: TemplateKey): string => CATALOGUE_FA[key];

/** A value for one placeholder, chosen to be hostile: markup, RTL marks, big figures. */
function sample(p: PlaceholderDefinition): TemplateValue {
  switch (p.type) {
    case 'MONEY':
      return money(123_456_789n, 'IRT');
    case 'NUMBER':
      return 1234;
    case 'DATETIME':
    case 'DATE':
    case 'TIME':
      return new Date('2026-10-10T08:30:00Z');
    case 'DURATION_DAYS':
      return 30;
    case 'BYTES':
    case 'TRAFFIC_LIMIT':
      return 53_687_091_200n;
    default:
      return `<b>نمونهٔ ${p.token}</b>‏`.padEnd(64, 'ـ');
  }
}

function values(key: TemplateKey, which: 'all' | 'required'): TemplateValues {
  const out: Record<string, TemplateValue> = {};
  for (const p of templateDefinition(key).placeholders) {
    if (which === 'all' || p.required) out[p.token] = sample(p);
  }
  return out;
}

/** What the customer reads: values substituted, then every `{icon:…}` drawn as its emoji. */
const render = (key: TemplateKey, given: TemplateValues): string =>
  appearanceFallbackText(
    renderTemplateBody(
      templateDefinition(key),
      body(key),
      given,
      'fa',
      DEFAULT_TEMPLATE_PRESENTATION,
    ),
  );

describe('render matrix: every changed default', () => {
  for (const key of CHANGED) {
    it(`${key}: validates against its unchanged contract`, () => {
      expect(validateTemplateBody(templateDefinition(key), body(key))).toEqual([]);
    });

    for (const which of ['all', 'required'] as const) {
      it(`${key}: rendered with ${which} values leaves no literal token or icon marker`, () => {
        const text = render(key, values(key, which));
        expect(text).not.toMatch(/\{[A-Za-z_][A-Za-z0-9_]*\}/);
        expect(text).not.toContain('{icon:');
        expect(text.length).toBeLessThan(4096);
        expect(text).not.toMatch(/\n{3,}$|\s$/u);
      });
    }

    it(`${key}: uses Persian letters, not their Arabic look-alikes`, () => {
      expect(body(key)).not.toMatch(/[يك]/);
    });

    it(`${key}: addresses the customer as «شما», never «تو»`, () => {
      expect(body(key)).not.toMatch(/(^|[\s،؛.])(تو|بده|بفرست|بزن|کن|بگیر|پیامت|بیا)([\s،؛.!]|$)/u);
    });
  }
});

describe('truth pins (brief §C2)', () => {
  it('C2.1 receipt credited: approved, credited to the wallet, and an order is still unpaid', () => {
    const text = body('bot.payment.receipt_credited_to_wallet');
    expect(text).toContain('رسید شما بررسی و تأیید شد');
    expect(text).toContain('به کیف پول شما واریز شد');
    expect(text).toContain('به‌عنوان پرداخت سفارش ثبت نشده است');
    expect(text).toContain('در انتظار پرداخت');
    // Never the top-up's sentence, which reads as "your payment (order) went through".
    expect(text).not.toBe(body('bot.wallet.topup_credited'));
    expect(text).not.toContain('پرداخت شما بررسی و تأیید شد');
    expect(text).not.toContain('/wallet');
    // The tracking code stays the last paragraph and goes with its line when unreadable.
    expect(text.endsWith('\n\n\nکد پیگیری پرداخت: {reference}')).toBe(true);
    const bare = render('bot.payment.receipt_credited_to_wallet', {
      amount: money(500_000n, 'IRT'),
    });
    expect(bare).not.toContain('کد پیگیری');
  });

  it('C2.2 preinvoice: the wallet icon marks only the wallet, the money labels are the model', () => {
    const text = body('bot.order.preinvoice');
    expect(text.split('{icon:wallet}').length - 1).toBe(1);
    expect(text).toContain('{icon:wallet} موجودی کیف پول: {walletBalance}');
    expect(text).toContain('{icon:amount} مبلغ سفارش: {total}');
    expect(text).toContain('{icon:user} نام کاربری: {serviceUsername}');
    expect(text).not.toMatch(/اکانت|نام کاربر:|قیمت: \{total\}/);
    // No payment exists yet, so no tracking code — and no fee figure it cannot know.
    expect(text).not.toContain('{reference}');
    expect(text).toContain('کارمزد');
  });

  it('C2.3 gateway invoices: short, amount/deadline/code kept, order and wallet icons apart', () => {
    for (const key of [
      'bot.payment.gateway_invoice',
      'bot.payment.gateway_invoice_order_fee',
      'bot.payment.gateway_invoice_topup_fee',
    ] as const) {
      const text = body(key);
      expect(text, key).toContain('{icon:time} مهلت پرداخت: {expiresAt}');
      expect(text, key).toContain('\n\nکد پیگیری پرداخت: {reference}');
      expect(text, key).toContain('فقط پس از تأیید درگاه ثبت می‌شود');
      expect(text, key).not.toContain('فقط برای وقتی است که');
    }
    expect(body('bot.payment.gateway_invoice')).toContain(
      '{icon:amount} مبلغ قابل پرداخت: {total}',
    );
    expect(body('bot.payment.gateway_invoice')).not.toContain('{icon:wallet}');
    expect(body('bot.payment.gateway_invoice_order_fee')).toContain(
      '{icon:purchase} مبلغ سفارش: {principal}',
    );
    expect(body('bot.payment.gateway_invoice_order_fee')).not.toContain('{icon:wallet}');
    expect(body('bot.payment.gateway_invoice_topup_fee')).toContain(
      '{icon:wallet} مبلغ شارژ: {principal}',
    );
  });

  it('C2.4 pending reminder: «کد پیگیری پرداخت: {reference}», dropped when unreadable', () => {
    const text = body('bot.payment.pending_reminder');
    expect(text).toContain('کد پیگیری پرداخت: {reference}');
    expect(text).not.toContain('فاکتور {reference}');
    const bare = render('bot.payment.pending_reminder', {
      minutes: 10,
      expiresAt: new Date('2026-10-10T08:30:00Z'),
    });
    expect(bare).not.toContain('کد پیگیری');
    expect(bare).not.toMatch(/\s$/u);
  });

  it('C2.5 referral: no withdrawal to a bank card is promised, the commission goes to the wallet', () => {
    for (const key of ['bot.referral.invite_card', 'bot.referral.screen'] as const) {
      const text = body(key);
      expect(text, key).not.toMatch(/کارت بانکی|برداشت|واریز خواهد شد/);
      expect(text, key).toContain('کیف پول');
      expect(text, key).toContain('پس از تحویل سرویس');
      // The signup gift is flag-gated (off by default): never promised unconditionally.
      expect(text, key).not.toContain('هدیه خوش‌آمد');
    }
  });

  it('C2.6 handoff notice: «شما», handed to a person, no promised time', () => {
    const text = body('bot.support.handoff_notice');
    expect(text).toContain('پیام شما');
    expect(text).toContain('پشتیبان');
    expect(text).not.toMatch(/پیامت|ادامه بده|دقیقه|ساعت|[0-9۰-۹]/);
  });

  it('C3 transfer: the subscription link is NOT changed by a transfer, and both sides are told', () => {
    // `ServiceTransferService` never calls the provider: whoever holds the link keeps access.
    expect(body('bot.service.transfer_confirm')).toContain('لینک اشتراک این سرویس تغییر نمی‌کند');
    expect(body('bot.service.transfer_confirm')).toContain('همچنان می‌تواند');
    expect(body('bot.service.transfer_received')).toContain('لینک اشتراک این سرویس تغییر نکرده');
  });

  it('C3 service list: names no button that does not exist', () => {
    const text = body('bot.service.list');
    expect(text).not.toContain('جستجو سرویس');
    // Inline labels are tenant-editable: the body must not quote one.
    expect(text).not.toMatch(/["«][^"»]*["»]/);
    expect(text).toContain('جستجو');
  });

  it('C4/C5.5 location request: queued, not applied — no success marker', () => {
    const text = body('bot.service.location_requested');
    expect(text).not.toContain('{icon:success}');
    expect(text).toContain('هنوز اعمال نشده');
  });
});

describe('part 2 pins (brief §C3, §C4, §C5)', () => {
  it('C3 suspend/resume: «سرویس», never «اکانت», and the clock keeps running while off', () => {
    // `serviceDisplayStatus` turns a SUSPENDED service past its deadline into EXPIRED, and
    // SUSPEND/RESUME never write `expires_at`: switching off does not pause the time.
    expect(body('bot.service.suspend_confirm')).toContain('متوقف نمی‌شود');
    for (const key of [
      'bot.service.suspend_confirm',
      'bot.service.resume_confirm',
      'bot.service.suspend_button',
      'bot.service.resume_button',
    ] as const) {
      expect(body(key), key).not.toContain('اکانت');
      expect(body(key), key).toContain('سرویس');
    }
  });

  it('C3 review unresolved and expiry: what happened to the money, and what to do next', () => {
    for (const key of [
      'bot.payment.centralpay_review_unresolved',
      'bot.payment.nowpayments_review_unresolved',
      'bot.payment.gateway_review_unresolved',
    ] as const) {
      expect(body(key), key).toContain('مبلغی به کیف پول شما واریز نشده');
      expect(body(key), key).toContain('دوباره پرداخت نکنید');
    }
    // A payment expires only from PENDING (`PaymentExpiryService`): nothing was ever credited.
    expect(body('bot.payment.expired')).toContain('از این پرداخت مبلغی ثبت نشده است');
    expect(body('bot.payment.expired')).toContain('دوباره پرداخت نکنید');
  });

  it('C3 invoices: an order figure is never drawn with the wallet icon', () => {
    expect(body('bot.payment.stars_invoice_order_fee')).toContain(
      '{icon:purchase} مبلغ سفارش: {principal}',
    );
    expect(body('bot.payment.stars_invoice_order')).toContain(
      '{icon:amount} مبلغ قابل پرداخت: {payable}',
    );
    for (const key of [
      'bot.payment.stars_invoice_order_fee',
      'bot.payment.stars_invoice_order',
      'bot.payment.gateway_card_invoice',
    ] as const) {
      expect(body(key), key).not.toContain('{icon:wallet}');
    }
    // One key serves an order and a top-up here, so the principal is named for what it is.
    expect(body('bot.payment.gateway_card_invoice')).toContain('مبلغ بدون کارمزد: {principal}');
    expect(body('bot.payment.gateway_card_invoice')).not.toContain('مبلغ اصلی');
  });

  it('Codex P2: the TonPays card invoice draws no purpose-specific icon beside the principal', () => {
    // `gatewayAttemptScreen` renders this ONE key for an order and for a wallet top-up
    // (payment.orderId === null) alike, so neither the cart nor the wallet icon is true of
    // both; the order-only and top-up-only keys keep theirs.
    const text = body('bot.payment.gateway_card_invoice');
    expect(text).toContain('{icon:amount} مبلغ بدون کارمزد: {principal}');
    expect(text).not.toContain('{icon:purchase}');
  });

  it('Codex P2: switching off promises nothing about a deadline an unlimited service lacks', () => {
    // A service with no `expiresAt` is supported and SUSPEND is offered for it, so the
    // clock sentence is conditional on the service having an end date at all.
    const text = body('bot.service.suspend_confirm');
    expect(text).toContain('اگر سرویس شما تاریخ اتمام دارد، زمان باقی‌ماندهٔ آن');
    expect(text).not.toContain('زمان باقی‌ماندهٔ سرویس در این مدت متوقف نمی‌شود');
  });

  it('Codex P2: a receipt must go as a photo, not as a document, and the customer is told so', () => {
    // `receivePhoto` returns PHOTO_ONLY for an image sent as a Telegram DOCUMENT; «تصویر»
    // alone describes what the customer already did.
    expect(body('bot.payment.gateway_receipt_photo_only')).toContain('به‌صورت عکس');
    expect(body('bot.payment.gateway_receipt_photo_only')).toContain('نه به‌صورت سند');
    expect(body('bot.payment.gateway_receipt_prompt')).toContain('به‌صورت عکس');
    expect(body('bot.payment.gateway_receipt_prompt')).toContain('نه به‌صورت سند');
  });

  it('C3 service card: the username is labelled as one, and no decoration inside a value', () => {
    const text = body('bot.service.card');
    expect(text).toContain('{icon:user} نام کاربری: {serviceUsername}');
    expect(text).not.toContain('نام سرویس: {serviceUsername}');
    expect(text).not.toContain('🚀');
    // The status carries its own marker; the line does not add a second one.
    expect(text.startsWith('وضعیت سرویس: {status}')).toBe(true);
  });

  it('C5.1/FIX-09 receipts: «رسید» and «تصویر», never «فیش» or «فایل»', () => {
    for (const [key, text] of Object.entries(CATALOGUE_FA)) {
      if (!key.startsWith('bot.payment.')) continue;
      expect(text, key).not.toContain('فیش');
      if (key.startsWith('bot.payment.gateway_')) expect(text, key).not.toContain('فایل');
    }
    expect(body('bot.payment.gateway_receipt_prompt')).toContain('تصویر رسید');
    expect(body('bot.payment.gateway_receipt_photo_only')).toContain('تصویر');
  });

  it('C5.1 vocabulary: the customer username keys say «نام کاربری», never «یوزرنیم»', () => {
    for (const [key, text] of Object.entries(CATALOGUE_FA)) {
      if (key.startsWith('bot.username.')) expect(text, key).not.toContain('یوزرنیم');
    }
  });

  /*
   * The welcomes are KEPT: `/catalog` is a live command (`bot-commands.ts`), and
   * `bot-runtime.test.ts` already refuses any reachable body that points at a «منو» in prose
   * or names a command the bot does not answer. The refusal is the one CTA that was false: it
   * also answers a TYPED amount, where there is no list to choose from.
   */
  it('C5.3 calls to action: the top-up refusal fits a typed amount as well as a list', () => {
    expect(body('bot.wallet.topup_refused')).not.toContain('از فهرست');
  });

  /*
   * C5.6 / FIX-08: on main the result of a paid renewal or add-on arrives as a NEW message;
   * with edit-in-place (`fix10/flows-edit-in-place`) it is edited into this one. The copy
   * must be true in both: it promises a result, never a separate message.
   */
  it('C5.6 paid renewal and add-on: no promise of a separate message', () => {
    for (const key of ['bot.service.renew_paid', 'bot.order.settled'] as const) {
      expect(body(key), key).not.toContain('پیام جداگانه');
      expect(body(key), key).toContain('در همین ربات');
    }
  });

  it('C5.12 FAQ: no unbacked speed or country-count claim', () => {
    expect(body('bot.faq.default_4_answer')).not.toMatch(/افت سرعت|بدون مشکل/);
    expect(body('bot.faq.default_5_answer')).not.toMatch(/[0-9۰-۹]+ کشور/);
  });

  it('C3 app video prompt: the window is the constant, through {minutes}', () => {
    const text = body('bot.admin.app_video_prompt');
    expect(text).toContain('{minutes} دقیقه');
    expect(text).not.toContain('۱۵');
    expect(text).not.toContain('به‌صورت ویدیو');
    // Optional: a body without it — any override stored before this release — still validates.
    const definition = templateDefinition('bot.admin.app_video_prompt');
    expect(definition.placeholders.find((p) => p.token === 'minutes')?.required).toBe(false);
    const stored =
      '🎬 ویدیوی آموزشی «{app}» را همین حالا به‌صورت ویدیو در همین گفتگو بفرستید.\n\nاین درخواست تا ۱۵ دقیقه معتبر است.';
    expect(validateTemplateBody(definition, stored)).toEqual([]);
  });

  /*
   * C5.11: a button label a phone can draw without cutting it. 24 visible characters is the
   * width the audit measured; the gift button is measured with the values it is drawn with.
   */
  it('C5.11 shortened buttons fit on a phone, rendered', () => {
    const width = (text: string) => [...text.replace(/‌/g, '')].length;
    for (const key of [
      'bot.payment.sent_button',
      'bot.apps.alternative_button',
      'bot.payment.gateway_receipt_button',
      'bot.service.suspend_button',
      'bot.service.resume_button',
    ] as const) {
      expect(width(render(key, {})), key).toBeLessThanOrEqual(24);
    }
    const gift = render('bot.wallet.topup_method_gift_button', {
      name: 'کارت به کارت',
      percent: 10,
    });
    expect(gift).toBe('کارت به کارت (+10٪ هدیه)');
    expect(width(gift)).toBeLessThanOrEqual(24);
  });
});
