import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_TOKEN_PATTERN,
  TEMPLATE_BODY_MAX_LENGTH,
  money,
  placeholderTokensIn,
  templateDefinition,
  validateTemplateBody,
  validateTemplateValues,
  type TemplateDefinition,
} from '@nexa/contracts';
import { escapeTelegramHtml, renderTemplateBody } from '@nexa/i18n';

const kinds = (body: string, key: 'bot.ping.reply' | 'bot.unknown_command' = 'bot.ping.reply') =>
  validateTemplateBody(templateDefinition(key), body).map((issue) => issue.kind);

/**
 * A declaration that is not in the registry.
 *
 * Used to exercise placeholder types no registered key uses yet. The type
 * vocabulary is a Phase 0 contract; registering a real key just to test MONEY
 * would put a template in the catalogue with nothing to send it.
 */
const synthetic: TemplateDefinition = {
  key: 'test.synthetic',
  description: 'Not registered. Exists only in this file.',
  format: 'PLAIN_TEXT',
  placeholders: [
    { token: 'price', type: 'MONEY', description: 'An amount.', required: true, repeatable: false },
    {
      token: 'gigabytes',
      type: 'BYTES',
      description: 'A size.',
      required: false,
      repeatable: false,
    },
    {
      token: 'days',
      type: 'DURATION_DAYS',
      description: 'A duration.',
      required: false,
      repeatable: true,
    },
  ],
};

describe('placeholder syntax', () => {
  it('treats an ASCII identifier in braces as a token', () => {
    expect(placeholderTokensIn('hello {first_name} and {x1}')).toEqual(['first_name', 'x1']);
  });

  it('leaves non-identifier braces alone, so a Persian caption survives', () => {
    // `اشتراک رایگان {تست}` is a live legacy button caption in which the braces
    // are decoration. A substitution engine that treated every {…} as a
    // variable would erase it (C-TXT-009).
    expect(placeholderTokensIn('اشتراک رایگان {تست}')).toEqual([]);
    expect(placeholderTokensIn('{1}')).toEqual([]);
    expect(placeholderTokensIn('{ spaced }')).toEqual([]);
  });

  it('agrees with the exported pattern', () => {
    expect(PLACEHOLDER_TOKEN_PATTERN.test('first_name')).toBe(true);
    expect(PLACEHOLDER_TOKEN_PATTERN.test('1name')).toBe(false);
    expect(PLACEHOLDER_TOKEN_PATTERN.test('تست')).toBe(false);
  });
});

describe('validateTemplateBody', () => {
  it('accepts a body that uses exactly what the key declares', () => {
    expect(
      validateTemplateBody(templateDefinition('bot.ping.reply'), 'سلام {correlationId}'),
    ).toEqual([]);
  });

  it('rejects a token the key does not declare, rather than shipping it literally', () => {
    // A mistyped {correlationI} would otherwise reach customers as the four
    // characters "{cor…}" — visible, permanent, and reported as a bug by them.
    expect(kinds('سلام {correlationI}')).toContain('UNKNOWN_PLACEHOLDER');
  });

  it('rejects dropping a required placeholder', () => {
    expect(kinds('سلام')).toContain('MISSING_REQUIRED_PLACEHOLDER');
  });

  it('rejects repeating a placeholder the key declares single-use', () => {
    expect(kinds('{correlationId} {correlationId}')).toContain('REPEATED_PLACEHOLDER');
  });

  it('rejects an empty or whitespace-only body', () => {
    expect(kinds('   ')).toContain('EMPTY');
  });

  it('rejects a body longer than a Telegram message can carry', () => {
    const body = `{correlationId}${'ا'.repeat(TEMPLATE_BODY_MAX_LENGTH)}`;
    expect(kinds(body)).toContain('TOO_LONG');
  });

  it('validates per key, never against a global vocabulary', () => {
    // {correlationId} is declared for the ping reply and for nothing else. The
    // legacy {time} means "now" in one template and "service duration" in
    // another; a shared vocabulary would have to be wrong in one of them.
    expect(kinds('{correlationId}', 'bot.unknown_command')).toContain('UNKNOWN_PLACEHOLDER');
  });
});

describe('validateTemplateValues', () => {
  it('refuses a bare number where MONEY is declared', () => {
    // The legacy {price} is a bare number whose unit is typed into the
    // surrounding copy, which is how one card-to-card template says تومان where
    // its twin says ریال for the same token. A number cannot satisfy MONEY here.
    const problems = validateTemplateValues(synthetic, { price: 15000 });
    expect(problems.join(' ')).toContain('{price}');
    expect(problems.join(' ')).toContain('Money');
  });

  it('accepts a Money value for a MONEY placeholder', () => {
    expect(validateTemplateValues(synthetic, { price: money(15000, 'IRT') })).toEqual([]);
  });

  it('accepts a number or a bigint for the numeric placeholder types', () => {
    expect(
      validateTemplateValues(synthetic, { price: money(0, 'IRT'), gigabytes: 5n, days: 30 }),
    ).toEqual([]);
  });

  it('rejects a repeated token unless the declaration says repeatable', () => {
    expect(
      validateTemplateBody(synthetic, '{price} {price} {days} {days}').map((i) => i.kind),
    ).toEqual(['REPEATED_PLACEHOLDER']);
  });

  it('requires a Date for a DATETIME placeholder', () => {
    const problems = validateTemplateValues(templateDefinition('ops.notification.test'), {
      requestedBy: 'مدیر',
      at: '2026-01-01' as unknown as Date,
    });
    expect(problems.join(' ')).toContain('{at}');
  });

  it('reports a missing required value', () => {
    const problems = validateTemplateValues(templateDefinition('ops.notification.test'), {
      requestedBy: 'مدیر',
    });
    expect(problems.join(' ')).toContain('{at}');
  });

  it('accepts values of the declared types', () => {
    expect(
      validateTemplateValues(templateDefinition('ops.notification.test'), {
        requestedBy: 'مدیر',
        at: new Date(0),
      }),
    ).toEqual([]);
  });
});

describe('renderTemplateBody', () => {
  it('substitutes only declared tokens', () => {
    const rendered = renderTemplateBody(
      templateDefinition('bot.ping.reply'),
      '{correlationId} {تست} {other}',
      { correlationId: 'abc' },
    );
    expect(rendered).toBe('abc {تست} {other}');
  });

  it('escapes interpolated values in an HTML-format template', () => {
    // The body's markup is the administrator's; the value is an event message
    // and must not be able to close a tag. An unescaped `<` fails the parse,
    // and the notification that fails is the one telling somebody about it.
    const rendered = renderTemplateBody(
      templateDefinition('ops.notification.operational_event'),
      '<code>{code}</code> {message}',
      { severity: 'ERROR', code: 'x', message: 'panel <b>down</b> & unreachable' },
    );
    expect(rendered).toBe('<code>x</code> panel &lt;b&gt;down&lt;/b&gt; &amp; unreachable');
  });

  it('does not escape in a plain-text template', () => {
    const rendered = renderTemplateBody(
      templateDefinition('ops.notification.test'),
      '{requestedBy}',
      { requestedBy: 'a < b' },
    );
    expect(rendered).toBe('a < b');
  });

  it('renders money through the single formatter, so no unit is typed by hand', () => {
    const rendered = renderTemplateBody(synthetic, 'مبلغ: {price}', {
      price: money(1500000, 'IRT'),
    });
    expect(rendered).toBe('مبلغ: 1,500,000 تومان');
  });

  it('escapes exactly the five characters Telegram treats as markup', () => {
    expect(escapeTelegramHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});
