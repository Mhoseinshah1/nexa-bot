import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WEB_FA } from '../../apps/web/src/i18n/web.fa';
import {
  formatDate,
  formatNumber,
  formatRelative,
  formatTimestamp,
} from '../../apps/web/src/format';
import { dayLabel, dayRangeLabel } from '../../apps/web/src/ops-list-filters';
import { formatFileSize } from '../../apps/web/src/ui/file-picker';
import { plainDigits } from '../../apps/web/src/ui/jalali';
import { DateField } from '../../apps/web/src/ui/date-field';
import { ListFreshness } from '../../apps/web/src/ui/list-search';
import { t } from '../../apps/web/src/i18n/web.fa';

/**
 * Latin digits everywhere (owner decision, R11 — it reverses "Persian digits"). The Jalali
 * CALENDAR stays; only the digit shapes are Latin. The setup file also fails ANY web test whose
 * rendered DOM holds U+06F0-U+06F9, so this file pins the sources of such digits one by one.
 */
const PERSIAN_DIGIT = /[۰-۹]/u;

describe('Latin digits — the catalogue', () => {
  it('holds no Persian digit in any string of web.fa.ts', () => {
    const bad = Object.entries(WEB_FA)
      .filter(([, value]) => typeof value === 'string' && PERSIAN_DIGIT.test(value))
      .map(([key]) => key);
    expect(bad).toEqual([]);
  });
});

describe('Latin digits — every formatter', () => {
  const at = '2026-10-06T16:00:00.000Z';
  it('draws Jalali dates and times with Latin digits', () => {
    expect(formatTimestamp(at)).toBe('⁦1405/07/14 16:00⁩');
    expect(formatDate(at)).toBe('⁦1405/07/14⁩');
    expect(dayLabel('2026-10-06')).toMatch(/^\d+ \S+ 1405$/u);
    expect(dayRangeLabel('2026-10-06', '2026-10-07') ?? '').not.toMatch(PERSIAN_DIGIT);
  });
  it('draws relative times, counts and sizes with Latin digits', () => {
    const now = Date.parse(at) + 5 * 24 * 3_600_000;
    expect(formatRelative(at, now)).toMatch(/^5 /u);
    expect(formatNumber(1_250_000)).toBe('1,250,000');
    expect(formatFileSize(812)).toBe(t('web.file_bytes').replace('{n}', '812'));
    expect(formatFileSize(249_856)).not.toMatch(PERSIAN_DIGIT);
    expect(formatFileSize(3_355_443)).not.toMatch(PERSIAN_DIGIT);
  });
  it('normalises any Persian digit that reaches the date helpers', () => {
    expect(plainDigits(1405)).toBe('1405');
    expect(plainDigits('۱۴۰۵')).toBe('1405');
  });
});

describe('Latin digits — rendered DOM', () => {
  it('draws the freshness line and the Jalali date field with Latin digits', () => {
    render(
      <ListFreshness
        query={{
          dataUpdatedAt: Date.UTC(2026, 5, 1, 12, 0, 5),
          isFetching: false,
          refetch: vi.fn(),
        }}
      />,
    );
    const text = screen.getByTestId('list-read-at').textContent ?? '';
    expect(text).toMatch(/\d/u);
    expect(text).not.toMatch(PERSIAN_DIGIT);
    render(
      <DateField id="d" mode="datetime" value="2026-10-16T23:34" onChange={() => undefined} />,
    );
    fireEvent.click(document.getElementById('d') as HTMLElement);
    expect(document.body.textContent).toMatch(/1405/u);
    expect(document.body.textContent ?? '').not.toMatch(PERSIAN_DIGIT);
  });
});

describe('Latin digits — styles', () => {
  it('has no stylistic set that redraws digits, and no rule resetting one', () => {
    const base = readFileSync(resolve('apps/web/src/styles/base.css'), 'utf8');
    expect(base).not.toMatch(/ss01/u);
    expect(base).not.toMatch(/font-feature-settings/u);
  });
});
