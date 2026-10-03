import { describe, expect, it } from 'vitest';
import type { TemplateDefinition } from '@nexa/contracts';
import {
  DEFAULT_TEMPLATE_PRESENTATION,
  formatDateOnly,
  formatDateTime,
  formatTimeOnly,
  renderTemplateBody,
  type TemplatePresentation,
} from '@nexa/i18n';

/**
 * A DATETIME as a tenant reads it: the tenant's zone and calendar, Latin digits, a fixed
 * layout. The strings below are pinned exactly, because they are what a customer receives.
 */

const TEHRAN_JALALI: TemplatePresentation = { timezone: 'Asia/Tehran', calendar: 'jalali' };
const TEHRAN_GREGORIAN: TemplatePresentation = { timezone: 'Asia/Tehran', calendar: 'gregorian' };
const UTC_GREGORIAN: TemplatePresentation = { timezone: 'UTC', calendar: 'gregorian' };

const AT = new Date('2026-09-24T18:30:00Z');

describe('formatDateTime', () => {
  it('renders Jalali in Tehran with Latin digits', () => {
    expect(formatDateTime(AT, TEHRAN_JALALI)).toBe('1405/07/02 22:00');
  });

  it('renders Gregorian in the same zone with the same layout', () => {
    expect(formatDateTime(AT, TEHRAN_GREGORIAN)).toBe('2026/09/24 22:00');
  });

  it('applies the zone, so the same instant is a different hour in UTC', () => {
    expect(formatDateTime(AT, UTC_GREGORIAN)).toBe('2026/09/24 18:30');
  });

  it('zero-pads month, day, hour and minute', () => {
    expect(formatDateTime(new Date('2026-01-05T08:05:00Z'), UTC_GREGORIAN)).toBe(
      '2026/01/05 08:05',
    );
    expect(formatDateTime(new Date('2026-01-05T08:05:00Z'), TEHRAN_JALALI)).toBe(
      '1404/10/15 11:35',
    );
  });

  it('renders midnight as 00:00, never 24:00', () => {
    // Nowruz 1405 begins at 2026-03-21 00:00 Tehran (UTC+3:30).
    expect(formatDateTime(new Date('2026-03-20T20:30:00Z'), TEHRAN_JALALI)).toBe(
      '1405/01/01 00:00',
    );
  });

  it('crosses a calendar day boundary by zone, not by UTC', () => {
    // 21:30Z is 01:00 the next day in Tehran.
    expect(formatDateTime(new Date('2026-09-24T21:30:00Z'), TEHRAN_JALALI)).toBe(
      '1405/07/03 01:00',
    );
  });
});

describe('formatDateOnly', () => {
  it('renders the calendar date without a time', () => {
    expect(formatDateOnly(AT, TEHRAN_JALALI)).toBe('1405/07/02');
    expect(formatDateOnly(AT, TEHRAN_GREGORIAN)).toBe('2026/09/24');
    expect(formatDateOnly(new Date('2026-09-24T21:30:00Z'), TEHRAN_JALALI)).toBe('1405/07/03');
  });
});

describe('the default presentation', () => {
  it('is Tehran, Jalali, declared once', () => {
    expect(DEFAULT_TEMPLATE_PRESENTATION).toEqual({ timezone: 'Asia/Tehran', calendar: 'jalali' });
    expect(Object.isFrozen(DEFAULT_TEMPLATE_PRESENTATION)).toBe(true);
  });
});

describe('renderTemplateBody with a presentation', () => {
  const definition: TemplateDefinition = {
    key: 'test.presentation',
    description: 'Not registered. Exists only in this file.',
    format: 'PLAIN_TEXT',
    placeholders: [
      { token: 'at', type: 'DATETIME', description: 'When.', required: true, repeatable: false },
    ],
  };

  it('renders a DATETIME through formatDateTime when a presentation is given', () => {
    expect(renderTemplateBody(definition, 'در {at}', { at: AT }, 'fa', TEHRAN_JALALI)).toBe(
      'در 1405/07/02 22:00',
    );
    expect(renderTemplateBody(definition, 'در {at}', { at: AT }, 'fa', UTC_GREGORIAN)).toBe(
      'در 2026/09/24 18:30',
    );
  });

  it('renders ISO-8601 UTC when no presentation was resolved', () => {
    expect(renderTemplateBody(definition, 'در {at}', { at: AT })).toBe(
      'در 2026-09-24T18:30:00.000Z',
    );
  });
});

/*
 * Owner spec §3: the account screen shows TODAY and the TIME separately, in the tenant's zone
 * and calendar — `DATE` and `TIME` placeholders over the same `Date`.
 */
describe('DATE and TIME placeholders', () => {
  const definition: TemplateDefinition = {
    key: 'test.now',
    description: 'Not registered. Exists only in this file.',
    format: 'PLAIN_TEXT',
    placeholders: [
      { token: 'd', type: 'DATE', description: 'Day.', required: true, repeatable: false },
      { token: 't', type: 'TIME', description: 'Time.', required: true, repeatable: false },
    ],
  };
  // 23:22 in Tehran on 1405/07/10 (2026-10-02T19:52Z): the evening crosses no day boundary.
  const NOW = new Date('2026-10-02T19:52:00Z');

  it('renders the Jalali date and the 24-hour time in the tenant zone', () => {
    expect(
      renderTemplateBody(
        definition,
        'تاریخ: {d}\nساعت: {t}',
        { d: NOW, t: NOW },
        'fa',
        TEHRAN_JALALI,
      ),
    ).toBe('تاریخ: 1405/07/10\nساعت: 23:22');
    expect(formatTimeOnly(NOW, UTC_GREGORIAN)).toBe('19:52');
  });

  it('follows the zone across midnight: the date is the tenant’s, not UTC’s', () => {
    const late = new Date('2026-10-02T21:00:00Z'); // 00:30 on the 3rd in Tehran
    expect(formatDateOnly(late, TEHRAN_JALALI)).toBe('1405/07/11');
    expect(formatTimeOnly(late, TEHRAN_JALALI)).toBe('00:30');
    expect(formatDateOnly(late, UTC_GREGORIAN)).toBe('2026/10/02');
  });
});
