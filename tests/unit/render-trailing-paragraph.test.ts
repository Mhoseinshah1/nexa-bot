import { describe, expect, it } from 'vitest';
import { money, templateDefinition, type TemplateKey, type TemplateValues } from '@nexa/contracts';
import { CATALOGUE_FA, DEFAULT_TEMPLATE_PRESENTATION, renderTemplateBody } from '@nexa/i18n';

/**
 * B14 review: a body whose LAST paragraph is optional, rendered without it, leaves no
 * separator behind — not the two (or three) newlines that preceded the dropped line. Pinned
 * on a customer credit message, whose tracking-code paragraph sits two blank lines below
 * the sentence, and on an unrelated template whose last paragraph is optional.
 */
const render = (key: TemplateKey, values: TemplateValues): string =>
  renderTemplateBody(
    templateDefinition(key),
    CATALOGUE_FA[key],
    values,
    'fa',
    DEFAULT_TEMPLATE_PRESENTATION,
  );

describe('a dropped last paragraph leaves no trailing separator', () => {
  it('bot.wallet.topup_credited without its tracking code ends at the sentence', () => {
    const text = render('bot.wallet.topup_credited', { amount: money(500_000n, 'IRT') });
    expect(text.endsWith('به کیف پول شما اضافه شد.')).toBe(true);
    expect(text).not.toMatch(/\s$/u);
    expect(text).not.toContain('کد پیگیری');
  });

  it('bot.admin.receipt without the customer’s note ends at the tracking code', () => {
    const text = render('bot.admin.receipt', {
      reference: 'REF-1',
      total: money(250_000n, 'IRT'),
      customer: '910910',
    });
    expect(text.endsWith('کد پیگیری پرداخت: REF-1')).toBe(true);
    expect(text).not.toMatch(/\s$/u);
    expect(text).not.toContain('توضیحات کاربر');
  });

  it('a body nothing was dropped from renders as written, its own blank lines kept', () => {
    const text = render('bot.wallet.topup_credited', {
      amount: money(500_000n, 'IRT'),
      reference: 'REF-2',
    });
    expect(text).toContain('اضافه شد.\n\n\nکد پیگیری پرداخت: REF-2');
  });
});
