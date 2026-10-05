import { describe, expect, it } from 'vitest';
import { templateDefinition, type TemplateKey } from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';

/**
 * Pre-support copy fixes A11, A3 and E4 (pre-support remaining-fixes audit §2), pinned as the
 * Persian DEFAULT bodies. Copy only: no placeholder is added or removed, so every body still
 * uses exactly the tokens its contract declares. A tenant override is not rewritten.
 */
const body = (key: TemplateKey): string => {
  const text = CATALOGUE_FA[key];
  if (text === undefined) throw new Error(`no Persian default for ${key}`);
  return text;
};

/** The `{token}` placeholders a body uses, appearance markers (`{icon:…}`) excluded. */
const tokensOf = (text: string): string[] =>
  [...text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((m) => m[1]!).sort();

const declared = (key: TemplateKey): string[] =>
  templateDefinition(key)
    .placeholders.map((p) => p.token)
    .sort();

const GATEWAY_INVOICES = [
  'bot.payment.gateway_invoice',
  'bot.payment.gateway_invoice_order_fee',
  'bot.payment.gateway_invoice_topup_fee',
] as const satisfies readonly TemplateKey[];

describe('A11: the gateway invoice says the payment is checked automatically', () => {
  for (const key of GATEWAY_INVOICES) {
    it(`${key} says the check is automatic and the button is only a fallback`, () => {
      const text = body(key);
      // The contract's own requirement survives: a payment counts only once confirmed.
      expect(text).toContain('پرداخت شما فقط پس از تأیید درگاه ثبت می‌شود.');
      expect(text).toContain(
        'پس از پرداخت نیازی به کار دیگری نیست: وضعیت پرداخت به‌صورت خودکار بررسی می‌شود و نتیجه در همین گفتگو به شما اعلام می‌شود.',
      );
      expect(text).toContain(
        'دکمهٔ «بررسی وضعیت پرداخت» فقط برای وقتی است که چند دقیقه پس از پرداخت هنوز نتیجه‌ای دریافت نکرده‌اید.',
      );
      // The old instruction made the manual check the way to confirm a payment.
      expect(text).not.toContain('پس از پرداخت، دکمهٔ «بررسی وضعیت پرداخت» را بزنید');
      expect(tokensOf(text)).toEqual(declared(key));
    });
  }
});

describe('A3: the wallet screen calls the identifier «شناسه کاربری»', () => {
  it('bot.wallet.summary labels the Telegram id «شناسه کاربری»', () => {
    const text = body('bot.wallet.summary');
    expect(text).toContain('{icon:identity} شناسه کاربری: {telegramId}');
    expect(text).not.toContain('آی دی عددی');
    // The brief spells the old label with a zero-width non-joiner; that form is refused too.
    expect(text).not.toContain('آی\u200cدی');
    expect(tokensOf(text)).toEqual(declared('bot.wallet.summary'));
  });

  it('bot.service.transfer_confirm labels the recipient «شناسه کاربری مقصد»', () => {
    // Brief §3: no customer-facing screen may still name a user's identifier the old way.
    const text = body('bot.service.transfer_confirm');
    expect(text).toContain('{icon:identity} شناسه کاربری مقصد: {recipientId}');
    expect(text).not.toContain('آی دی عددی');
    expect(text).not.toContain('آی\u200cدی');
    expect(tokensOf(text)).toEqual(declared('bot.service.transfer_confirm'));
  });

  it('no customer-facing default still calls the identifier «آی دی»', () => {
    for (const [key, text] of Object.entries(CATALOGUE_FA)) {
      expect(text, key).not.toMatch(/آی[ \u200c]?دی/);
    }
  });
});

describe('E4: the discount prompt uses the brief’s exact wording', () => {
  it('bot.discount.ask reads «کد تخفیف خود را ارسال کنید»', () => {
    expect(body('bot.discount.ask')).toBe('کد تخفیف خود را ارسال کنید');
    expect(declared('bot.discount.ask')).toEqual([]);
  });
});
