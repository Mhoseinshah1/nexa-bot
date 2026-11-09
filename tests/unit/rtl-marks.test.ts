import { describe, expect, it } from 'vitest';
import { money, templateDefinition } from '@nexa/contracts';
import {
  applyRtlMarks,
  CATALOGUE_FA,
  DEFAULT_TEMPLATE_PRESENTATION,
  renderTemplateBody,
  RLM,
} from '@nexa/i18n';

/**
 * B2: a Persian line that starts with an emoji, an `{icon:…}` marker, a digit or a Latin word
 * is drawn left-aligned by Telegram on iOS. The renderer puts a RIGHT-TO-LEFT MARK in front of
 * it — once, never in code, never in a link, never in a line with no Persian in it.
 */
describe('applyRtlMarks', () => {
  it('marks a line that starts with an emoji or an icon marker', () => {
    expect(applyRtlMarks('🕒 ساعت: ۱۴:۰۵')).toBe(`${RLM}🕒 ساعت: ۱۴:۰۵`);
    expect(applyRtlMarks('{icon:clock} ساعت: ۱۴:۰۵')).toBe(`${RLM}{icon:clock} ساعت: ۱۴:۰۵`);
  });

  it('marks a line that starts with a digit or a Latin word and has Persian in it', () => {
    expect(applyRtlMarks('۱۲ سرویس')).toBe(`${RLM}۱۲ سرویس`);
    expect(applyRtlMarks('Nexa: خوش آمدید')).toBe(`${RLM}Nexa: خوش آمدید`);
  });

  it('leaves a line that already starts with a Persian letter alone', () => {
    expect(applyRtlMarks('سلام 🕒 12:00')).toBe('سلام 🕒 12:00');
  });

  it('never doubles: a second pass, or a line that already has the mark', () => {
    const once = applyRtlMarks('🕒 ساعت: 12:00');
    expect(applyRtlMarks(once)).toBe(once);
    expect(applyRtlMarks(`${RLM}🕒 ساعت`)).toBe(`${RLM}🕒 ساعت`);
    expect(applyRtlMarks('‎🕒 ساعت')).toBe('‎🕒 ساعت');
  });

  it('leaves lines with no Persian in them alone', () => {
    expect(applyRtlMarks('🕒 12:00\nABC-123')).toBe('🕒 12:00\nABC-123');
  });

  it('never marks a URL line', () => {
    const text = 'سلام\nhttps://example.com/ساعت\nwww.example.com ساعت';
    expect(applyRtlMarks(text)).toBe(text);
  });

  it('never marks inside code or pre, one line or many (HTML)', () => {
    const text = [
      '<code>abc ساعت</code>',
      '<pre>',
      '🕒 ساعت',
      '12 ساعت',
      '</pre>',
      '<b>🕒 ساعت</b>',
    ].join('\n');
    expect(applyRtlMarks(text, 'TELEGRAM_HTML')).toBe(
      [
        '<code>abc ساعت</code>',
        '<pre>',
        '🕒 ساعت',
        '12 ساعت',
        '</pre>',
        `${RLM}<b>🕒 ساعت</b>`,
      ].join('\n'),
    );
  });

  it('looks through a leading tag to decide, and marks before the tag', () => {
    expect(applyRtlMarks('<b>سلام</b> 12', 'TELEGRAM_HTML')).toBe('<b>سلام</b> 12');
  });
});

describe('renderTemplateBody', () => {
  const render = (locale: string, body: string, rtlMarks?: boolean) =>
    renderTemplateBody(
      templateDefinition('bot.wallet.summary'),
      body,
      {},
      locale as 'fa',
      DEFAULT_TEMPLATE_PRESENTATION,
      rtlMarks === undefined ? {} : { rtlMarks },
    );

  it('does not mark a locale that is not Persian', () => {
    expect(render('fa', '{icon:clock} ساعت', true)).toBe(`${RLM}{icon:clock} ساعت`);
    // The renderer only knows Persian today; the guard is the locale test itself.
    expect(render('en', '{icon:clock} ساعت', true)).toBe('{icon:clock} ساعت');
  });

  it('marks nothing unless asked: a button label is byte for byte what a tap sends back', () => {
    expect(render('fa', '🔐 خرید اشتراک')).toBe('🔐 خرید اشتراک');
    expect(render('fa', '🔐 خرید اشتراک', false)).toBe('🔐 خرید اشتراک');
    expect(render('fa', '🔐 خرید اشتراک', true)).toBe(`${RLM}🔐 خرید اشتراک`);
  });

  it('bot.wallet.summary: every line that starts with an icon is marked; the code span is intact', () => {
    const text = renderTemplateBody(
      templateDefinition('bot.wallet.summary'),
      CATALOGUE_FA['bot.wallet.summary'],
      {
        telegramId: '123456',
        displayName: 'Ali',
        phoneState: 'ثبت شده',
        registeredAt: new Date('2026-01-01T10:00:00Z'),
        balance: money(1_000n, 'IRT'),
        serviceCount: 2,
        paidInvoiceCount: 3,
        referralCount: 4,
        customerGroup: 'عادی',
        nowDate: new Date('2026-11-09T12:00:00Z'),
        nowTime: new Date('2026-11-09T12:05:00Z'),
      },
      'fa',
      DEFAULT_TEMPLATE_PRESENTATION,
      { rtlMarks: true },
    );
    expect(text).toMatchSnapshot();
    const lines = text.split('\n').filter((l) => l !== '');
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) expect(line.startsWith(RLM)).toBe(true);
    expect(text).toContain('<code>123456</code>');
    expect(text.match(/‏‏/u)).toBeNull();
  });
});
