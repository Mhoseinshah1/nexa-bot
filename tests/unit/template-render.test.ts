import { describe, expect, it } from 'vitest';
import { TEMPLATE_KEYS, money, templateDefinition, type TemplateDefinition } from '@nexa/contracts';
import { CATALOGUE_FA, formatDurationDays, renderTemplateBody } from '@nexa/i18n';

/**
 * How the single renderer treats a value it was not given, and the units it owns.
 *
 * Before the line rule, a customer whose service had no expiry read `{expiresAt}`, one
 * never synced read `{syncedAt}`, and a summary with no reserved name read `{username}`.
 * The rule is decided per LINE: a line whose placeholders are all absent optional tokens
 * goes, with its label and one newline; a line that still says something stays.
 */

const definition: TemplateDefinition = {
  key: 'test.render',
  description: 'Not registered. Exists only in this file.',
  format: 'PLAIN_TEXT',
  placeholders: [
    { token: 'name', type: 'STRING', description: 'Required.', required: true, repeatable: false },
    { token: 'note', type: 'STRING', description: 'Optional.', required: false, repeatable: true },
    {
      token: 'where',
      type: 'STRING',
      description: 'Optional.',
      required: false,
      repeatable: false,
    },
    {
      token: 'until',
      type: 'DATETIME',
      description: 'Optional.',
      required: false,
      repeatable: false,
    },
    { token: 'left', type: 'STRING', description: 'Optional.', required: false, repeatable: false },
    {
      token: 'days',
      type: 'DURATION_DAYS',
      description: 'Optional.',
      required: false,
      repeatable: false,
    },
  ],
};

const render = (body: string, values: Parameters<typeof renderTemplateBody>[2]) =>
  renderTemplateBody(definition, body, values);

describe('an optional placeholder with no value', () => {
  it('drops a line the token stood alone on, together with its newline', () => {
    expect(render('نام: {name}\n{note}\nپایان', { name: 'x' })).toBe('نام: x\nپایان');
    expect(render('نام: {name}\n  {note}  \nپایان', { name: 'x' })).toBe('نام: x\nپایان');
  });

  it('drops the whole line when its label is all that would be left', () => {
    // `🌍 لوکیشن: 🚀 {serviceLocation}` with no location is a label pointing at nothing.
    expect(render('نام: {name}\n🌍 لوکیشن: 🚀 {where}\nپایان', { name: 'x' })).toBe(
      'نام: x\nپایان',
    );
  });

  it('drops a line whose EVERY placeholder is absent, even with two of them', () => {
    expect(render('نام: {name}\n📅 تاریخ اتمام: {until} ({left})\nپایان', { name: 'x' })).toBe(
      'نام: x\nپایان',
    );
  });

  it('keeps a line where one placeholder still has a value, rendering the absent one empty', () => {
    expect(render('نام: {name}\n📅 تاریخ اتمام: {until} ({left})', { name: 'x', left: '۳' })).toBe(
      'نام: x\n📅 تاریخ اتمام:  (۳)',
    );
  });

  it('renders an inline absent optional as the empty string', () => {
    expect(render('{name} {note} تمام', { name: 'x' })).toBe('x  تمام');
  });

  it('removes the preceding newline when the dropped line is the last one', () => {
    expect(render('نام: {name}\n{note}', { name: 'x' })).toBe('نام: x');
  });

  it('removes the following newline when the dropped line is the first one', () => {
    expect(render('{note}\nنام: {name}', { name: 'x' })).toBe('نام: x');
  });

  it('keeps blank-separated paragraphs one blank line apart', () => {
    // Exactly the line and ONE newline go, so a paragraph does not close up
    // against its neighbour and does not gain a second blank line either.
    expect(render('اول {name}\n\n{note}\nدوم', { name: 'x' })).toBe('اول x\n\nدوم');
    expect(render('اول {name}\n{note}\n\nدوم', { name: 'x' })).toBe('اول x\n\nدوم');
  });

  it('drops consecutive absent lines without leaving a blank between them', () => {
    expect(render('نام: {name}\n{where}\n{until}\nپایان', { name: 'x' })).toBe('نام: x\nپایان');
  });

  it('renders an empty body when every line was absent', () => {
    expect(render('{where}\n{until}', {})).toBe('');
  });

  it('treats a repeatable optional token the same on every line', () => {
    expect(render('{note}\n{name}\n{note} و {note}', { name: 'x' })).toBe('x');
    expect(render('{note}\n{name}\n{note} و {note}', { name: 'x', note: 'n' })).toBe('n\nx\nn و n');
  });
});

describe('what the line rule leaves alone', () => {
  it('keeps a REQUIRED placeholder with no value literal, on its own line too', () => {
    // `validateTemplateValues` refuses such a send before it renders; a preview of a
    // half-filled form is expected to show the token, not an empty line.
    expect(render('سلام\n{name}\nپایان', {})).toBe('سلام\n{name}\nپایان');
    expect(render('سلام {name}', {})).toBe('سلام {name}');
  });

  it('keeps an undeclared token literal and keeps its line', () => {
    expect(render('{other}\n{note} {other}', {})).toBe('{other}\n {other}');
  });

  it('does not count decorative braces as a placeholder', () => {
    // `اشتراک رایگان {تست}` is not a token (C-TXT-009), so it neither substitutes nor
    // keeps a line whose only real placeholder is absent; on a line of its own it stays.
    expect(render('{name}\nاشتراک رایگان {تست}', { name: 'x' })).toBe('x\nاشتراک رایگان {تست}');
    expect(render('{name}\n{note} {تست}', { name: 'x' })).toBe('x');
  });

  it('keeps a line with an undeclared token beside an absent optional one', () => {
    expect(render('نام: {name}\n{other} {note}', { name: 'x' })).toBe('نام: x\n{other} ');
  });

  it('keeps a blank line that has no placeholder', () => {
    expect(render('اول\n\nدوم {name}', { name: 'x' })).toBe('اول\n\nدوم x');
  });

  it('is not fooled by a value that is falsy but present', () => {
    expect(render('نام: {name}\nمدت: {days}', { name: 'x', days: 0 })).toBe('نام: x\nمدت: نامحدود');
    expect(render('نام: {name}\n{note}', { name: 'x', note: '' })).toBe('نام: x\n');
  });
});

describe('the catalogue under the rule', () => {
  it('shows a service with no expiry and no sync without a literal token', () => {
    const key = 'bot.service.detail';
    const rendered = renderTemplateBody(templateDefinition(key), CATALOGUE_FA[key], {
      productTitle: 'پلن',
      state: 'فعال',
      usedTrafficBytes: 0n,
      totalTrafficBytes: 0n,
    });
    expect(rendered).toBe('سرویس: پلن\nوضعیت: فعال\nمصرف: 0 بایت از نامحدود');
  });

  it('drops the never-synced line of the admin view and keeps the expiry', () => {
    const key = 'bot.admin.service';
    const at = new Date('2026-09-24T18:30:00Z');
    const rendered = renderTemplateBody(
      templateDefinition(key),
      'انقضا: {expiresAt}\nآخرین خواندن مصرف: {syncedAt}',
      { expiresAt: at },
      'fa',
      { timezone: 'Asia/Tehran', calendar: 'jalali' },
    );
    expect(rendered).toBe('انقضا: 1405/07/02 22:00');
  });

  it('names the catalogue lines that type the unit a DURATION_DAYS value now carries', () => {
    // `formatDurationDays` appends «روز», so a body that ALSO writes «روز» after the
    // token shows it twice. The two reminder keys do, because their `days` is a count
    // of days remaining that the contract types as a duration; the fix is theirs — a
    // retyped token in `packages/contracts/src/templates.ts` or a reworded line in
    // `catalogue.fa.ts` — and this pin fails the moment either lands, so the entry
    // here is deleted with it rather than outliving it.
    const doubled: string[] = [];
    for (const key of TEMPLATE_KEYS) {
      for (const placeholder of templateDefinition(key).placeholders) {
        if (placeholder.type !== 'DURATION_DAYS') continue;
        if (new RegExp(`\\{${placeholder.token}\\}\\s*روز`).test(CATALOGUE_FA[key]))
          doubled.push(key);
      }
    }
    expect(doubled).toEqual(['bot.service.expiry_first', 'bot.service.expiry_second']);
  });
});

describe('formatDurationDays', () => {
  it('renders the word for unlimited, never zero', () => {
    expect(formatDurationDays(0)).toBe('نامحدود');
    expect(formatDurationDays(0n)).toBe('نامحدود');
  });

  it('renders a count in days, with Latin digits', () => {
    expect(formatDurationDays(1)).toBe('1 روز');
    expect(formatDurationDays(30)).toBe('30 روز');
    expect(formatDurationDays(365n)).toBe('365 روز');
  });

  it('is what a DURATION_DAYS placeholder renders through', () => {
    expect(render('نام: {name}\nمدت: {days}', { name: 'x', days: 30 })).toBe('نام: x\nمدت: 30 روز');
    expect(render('نام: {name}\nمدت: {days}', { name: 'x', days: 30n })).toBe(
      'نام: x\nمدت: 30 روز',
    );
  });

  it('shows a non-integer duration as given rather than guessing a unit', () => {
    expect(render('{name} {days}', { name: 'x', days: 1.5 })).toBe('x 1.5');
  });

  it('leaves the money path untouched', () => {
    const priced = templateDefinition('bot.order.summary');
    expect(priced.placeholders.some((p) => p.type === 'MONEY')).toBe(true);
    expect(renderTemplateBody(definition, '{name}', { name: money(1n, 'IRT') })).toBe('1 تومان');
  });
});
