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
 * Defaults only: no placeholder was added or removed by these changes, so a tenant's stored
 * override of any of these keys still validates and renders exactly as before.
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
