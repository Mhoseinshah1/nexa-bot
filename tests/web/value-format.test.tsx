import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { formatValueText, valueLines } from '../../apps/web/src/ui/value-format';
import { Value } from '../../apps/web/src/ui/kit';
import { t } from '../../apps/web/src/i18n/web.fa';

const UNSET = 'تعیین نشده';

describe('the Persian value formatter', () => {
  it('empty and absent values say «تعیین نشده»', () => {
    for (const empty of [null, undefined, '', [], {}]) expect(formatValueText(empty)).toBe(UNSET);
  });

  it('booleans are روشن / خاموش', () => {
    expect(formatValueText(true)).toBe('روشن');
    expect(formatValueText(false)).toBe('خاموش');
  });

  it('a money object is the money format, never its JSON', () => {
    expect(formatValueText({ amountMinor: '20000', currency: 'IRT' })).toBe('20,000 تومان');
    expect(formatValueText({ amountMinor: '0', currency: 'IRT' })).toBe('0 تومان');
    expect(formatValueText({ amountMinor: '0', currency: 'IRT' })).not.toContain('amountMinor');
  });

  it('a duration reads as a figure with its unit', () => {
    expect(formatValueText({ days: 3 })).toBe('3 روز');
    expect(formatValueText({ hours: 2 })).toBe('2 ساعت');
    expect(formatValueText({ minutes: 15 })).toBe('15 دقیقه');
  });

  it('a number takes the unit it is given, and is grouped', () => {
    expect(formatValueText(1500)).toBe('1,500');
    expect(formatValueText(60, { unit: 'web.unit_percent' })).toBe(`60 ${t('web.unit_percent')}`);
  });

  it('an array is a readable list, each item formatted', () => {
    expect(formatValueText(['@a', '@b'])).toBe(`@a${t('web.list_separator')}@b`);
    expect(
      formatValueText([
        { amountMinor: '1000', currency: 'IRT' },
        { amountMinor: '2000', currency: 'IRT' },
      ]),
    ).toBe(`1,000 تومان${t('web.list_separator')}2,000 تومان`);
  });

  it('a known object is labelled lines', () => {
    expect(valueLines({ handle: '@news', mandatory: true, joinUrl: 'https://t.me/news' })).toEqual([
      `${t('web.value_field_handle')}: @news`,
      `${t('web.value_field_mandatory')}: روشن`,
      `${t('web.channel_join_url')}: https://t.me/news`,
    ]);
  });

  it('never produces braces or quotes from a structured value', () => {
    const nested = { a: { b: [1, true, null] }, money: { amountMinor: '5', currency: 'IRT' } };
    const text = formatValueText(nested);
    expect(text).not.toMatch(/[{}"]/u);
    expect(text).toContain('5 تومان');
  });

  it('the Value component draws a string left-to-right and a money object as words', () => {
    const view = render(
      <>
        <Value value="https://x.test" />
        <Value value={{ amountMinor: '20000', currency: 'IRT' }} />
      </>,
    );
    expect(view.container.textContent).toBe('https://x.test20,000 تومان');
    expect(view.container.querySelector('.ltr')).not.toBeNull();
  });
});
