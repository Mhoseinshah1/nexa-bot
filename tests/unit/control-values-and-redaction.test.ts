import { describe, expect, it } from 'vitest';
import {
  coerceTemplateValue,
  coerceTemplateValues,
  isMoneyValue,
  templateDefinition,
  type PlaceholderDefinition,
} from '@nexa/contracts';
import { redactSecretText, REDACTED } from '../../apps/api/src/infrastructure/redaction';
import { deserialiseValues } from '../../apps/api/src/modules/control/notifications/application/notification-dispatcher';

const placeholder = (type: PlaceholderDefinition['type']): PlaceholderDefinition => ({
  token: 'sample',
  type,
  description: 'A sample.',
  required: false,
  repeatable: false,
});

/**
 * Sample values arrive from a form as text and have to become the type the
 * catalogue declares.
 *
 * This is the half that made three placeholder types unusable from the admin
 * screen: the field could only ever send a string, and the validator only ever
 * accepted a `Date`, a `Money` or a number.
 */
describe('coercing a typed sample value out of a text field', () => {
  it('turns a whole number into a number', () => {
    const result = coerceTemplateValue(placeholder('NUMBER'), ' 30 ');
    expect(result).toEqual({ ok: true, value: 30 });
  });

  it('refuses an empty field for a number rather than reading it as zero', () => {
    // `Number('')` is 0, and zero means something specific enough in this
    // system to have its own registry field. A blank box is not a supplied
    // zero.
    expect(coerceTemplateValue(placeholder('NUMBER'), '').ok).toBe(false);
    expect(coerceTemplateValue(placeholder('NUMBER'), '12.5').ok).toBe(false);
    expect(coerceTemplateValue(placeholder('NUMBER'), 'thirty').ok).toBe(false);
  });

  it('turns an ISO timestamp into a Date', () => {
    const result = coerceTemplateValue(placeholder('DATETIME'), '2026-09-02T08:00:00Z');
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBeInstanceOf(Date);
    expect(result.ok && (result.value as Date).toISOString()).toBe('2026-09-02T08:00:00.000Z');
  });

  it('refuses a date it cannot read, naming the form it wanted', () => {
    const result = coerceTemplateValue(placeholder('DATETIME'), 'yesterday');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem).toContain('2026-09-02T08:00:00Z');
  });

  it('turns minor units and a currency into Money', () => {
    const result = coerceTemplateValue(placeholder('MONEY'), '1250000 irr');
    expect(result.ok).toBe(true);
    expect(result.ok && isMoneyValue(result.value)).toBe(true);
    expect(result.ok && isMoneyValue(result.value) && result.value.amountMinor).toBe(1250000n);
    expect(result.ok && isMoneyValue(result.value) && result.value.currency).toBe('IRR');
  });

  it('refuses a bare amount, because a unit typed into copy is the legacy bug', () => {
    // One card-to-card template says تومان where its twin says ریال for the
    // same `{price}`. A MONEY value carries its currency or it is not one.
    expect(coerceTemplateValue(placeholder('MONEY'), '1250000').ok).toBe(false);
    expect(coerceTemplateValue(placeholder('MONEY'), '1250000 XYZ').ok).toBe(false);
  });

  describe('a whole form at once', () => {
    const definition = templateDefinition('ops.notification.operational_event');

    it('reports every wrong field, not the first', () => {
      const wrong: Record<string, string> = {};
      for (const p of definition.placeholders) wrong[p.token] = 'definitely not valid';
      const { problems } = coerceTemplateValues(definition, wrong);
      const typed = definition.placeholders.filter((p) => p.type !== 'STRING');
      expect(problems).toHaveLength(typed.length);
    });

    it('treats an empty field as no sample rather than as a value', () => {
      const blank: Record<string, string> = {};
      for (const p of definition.placeholders) blank[p.token] = '   ';
      const { values, problems } = coerceTemplateValues(definition, blank);
      expect(problems).toEqual([]);
      expect(Object.keys(values)).toEqual([]);
    });

    it('refuses a token the catalogue does not declare', () => {
      const { problems } = coerceTemplateValues(definition, { not_a_token: 'x' });
      expect(problems).toEqual(['{not_a_token} is not declared for this template.']);
    });
  });
});

/**
 * The stored payload back into typed values.
 *
 * Both branches, because both were untested: a DATETIME comes back from an ISO
 * string and a MONEY from its two fields, so the single formatter renders it
 * and no unit is ever typed into copy.
 */
describe('deserialising a stored notification payload', () => {
  it('rebuilds a Date and a Money from their stored forms', () => {
    // A synthetic definition is not available here, so the assertion uses the
    // one template that carries a DATETIME placeholder.
    const values = deserialiseValues({
      templateKey: 'ops.notification.operational_event',
      payload: {
        severity: 'ERROR',
        code: 'panel.unreachable',
        message: 'The panel did not answer.',
        occurrences: 3,
        firstSeenAt: '2026-09-02T08:00:00.000Z',
      },
    });
    expect(values.firstSeenAt).toBeInstanceOf(Date);
    expect((values.firstSeenAt as Date).toISOString()).toBe('2026-09-02T08:00:00.000Z');
    expect(values.occurrences).toBe(3);
  });

  it('skips a placeholder the payload does not carry', () => {
    const values = deserialiseValues({
      templateKey: 'ops.notification.operational_event',
      payload: { code: 'panel.unreachable' },
    });
    expect(Object.keys(values)).toEqual(['code']);
  });
});

/**
 * Secrets inside free text.
 *
 * The first version of this wrapped the message in `{ message }` and called the
 * key-based redactor, which matched nothing at all — a function that truncated
 * under a comment saying it redacted.
 */
describe('redacting a transport error message', () => {
  it('removes a Telegram bot token quoted out of a request URL', () => {
    const message =
      'Request failed: POST https://api.telegram.org/bot123456789:AAH4kK9vQwErTyUiOpAsDfGhJkLzXcVbNmQ/sendMessage';
    const redacted = redactSecretText(message);
    expect(redacted).not.toContain('AAH4kK9vQwErTyUiOpAsDfGhJkLzXcVbNmQ');
    expect(redacted).toContain(REDACTED);
    expect(redacted).toContain('api.telegram.org');
  });

  it('removes a labelled credential and keeps its label', () => {
    const redacted = redactSecretText('rejected: api_key=sk-live-9f2c8 and password: hunter2');
    expect(redacted).not.toContain('sk-live-9f2c8');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).toContain('api_key');
    expect(redacted).toContain('password');
  });

  it('removes a labelled bearer credential, scheme and all', () => {
    // The whole value goes, `Bearer` included. Keeping the scheme and removing
    // only what follows was the first attempt and produced two redaction
    // markers in a row, which says less than one.
    const redacted = redactSecretText('Authorization: Bearer abc.def.ghi refused');
    expect(redacted).toBe(`Authorization: ${REDACTED} refused`);
  });

  it('removes an unlabelled bearer credential', () => {
    const redacted = redactSecretText('sent Bearer abc.def.ghi and it was refused');
    expect(redacted).not.toContain('abc.def.ghi');
    expect(redacted).toContain(`Bearer ${REDACTED}`);
  });

  it('leaves ordinary operational text alone', () => {
    // A redactor that eats the message is as useless as one that does nothing:
    // the point of keeping this text is that somebody can act on it.
    const message = 'chat not found (400) after 2 attempts against chat -100999';
    expect(redactSecretText(message)).toBe(message);
  });
});
