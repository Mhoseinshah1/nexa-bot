import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DateField, type DateFieldMode } from '../../apps/web/src/ui/date-field';
import { Drawer, Field } from '../../apps/web/src/ui/kit';
import { ListFilterBar } from '../../apps/web/src/ui/filter-bar';
import { t } from '../../apps/web/src/i18n/web.fa';
import { plainDigits } from '../../apps/web/src/ui/jalali';
import { openFilterPanel, setDateField } from './ui-helpers';

/**
 * W1.1 — the Jalali date field. The wire value is what the native input sent; only the
 * display and the picking are Jalali.
 */

function Harness({
  mode = 'date',
  initial = '',
  min,
  max,
  onValue = () => undefined,
}: {
  mode?: DateFieldMode;
  initial?: string;
  min?: string;
  max?: string;
  onValue?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Field label="تاریخ" htmlFor="d">
      <DateField
        id="d"
        mode={mode}
        value={value}
        onChange={(next) => {
          setValue(next);
          onValue(next);
        }}
        {...(min === undefined ? {} : { min })}
        {...(max === undefined ? {} : { max })}
      />
    </Field>
  );
}

const field = () => screen.getByLabelText('تاریخ');
const popover = () => {
  const id = field().getAttribute('aria-controls');
  const node = id === null ? null : document.getElementById(id);
  if (node === null) throw new Error('closed');
  return node;
};
const day = (n: number) => {
  const node = popover().querySelector<HTMLElement>(`[data-day="${n}"]`);
  if (node === null) throw new Error(`no day ${n}`);
  return node;
};

beforeEach(() => {
  // Friday 24 Mehr 1405, 14:32 local.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 16, 14, 32));
});
afterEach(() => vi.useRealTimers());

describe('the trigger', () => {
  it('shows the placeholder, a Jalali day, and a day with its time', () => {
    const { unmount } = render(<Harness />);
    expect(field()).toHaveTextContent(t('web.date_pick'));
    unmount();
    const second = render(<Harness initial="2026-10-16" />);
    expect(field()).toHaveTextContent(
      `${plainDigits(24)} ${t('web.jalali_m7')} ${plainDigits(1405)}`,
    );
    second.unmount();
    render(<Harness mode="datetime" initial="2026-10-16T23:34" />);
    expect(field()).toHaveTextContent(
      `${plainDigits(24)} ${t('web.jalali_m7')} ${plainDigits(1405)} — ${plainDigits('23:34')}`,
    );
  });

  it('is named by its label and is a button, never a native date input', () => {
    render(<Harness />);
    expect(field().tagName).toBe('BUTTON');
    expect(document.querySelector('input[type="date"]')).toBeNull();
  });
});

describe('the calendar', () => {
  it('draws Persian months, a Saturday-first week, red Fridays, today ringed and the day chosen', () => {
    render(<Harness initial="2026-10-10" />);
    fireEvent.click(field());
    const pop = popover();
    expect(within(pop).getByRole('button', { name: t('web.date_choose_month') })).toHaveTextContent(
      t('web.jalali_m7'),
    );
    const head = pop.querySelector('.date-pop-wd');
    expect(head?.firstElementChild).toHaveTextContent(t('web.jalali_wd_sat'));
    expect(head?.lastElementChild).toHaveClass('fri');
    // 24 Mehr 1405 is a Friday and today.
    expect(day(24)).toHaveClass('fri');
    expect(day(24)).toHaveAttribute('aria-current', 'date');
    expect(day(18)).toHaveAttribute('aria-pressed', 'true');
    expect(day(18)).toHaveClass('sel');
    // 1 Mehr 1405 (23 Sep 2026) is a Wednesday: four blank cells come before it.
    expect(pop.querySelectorAll('.date-pop-grid > span')).toHaveLength(4);
    expect(pop.textContent).toContain('2026-10-10');
  });

  it('gives the wire day of the Jalali day clicked, closes and hands focus back', () => {
    const seen: string[] = [];
    render(<Harness onValue={(value) => seen.push(value)} />);
    fireEvent.click(field());
    fireEvent.click(day(1));
    expect(seen).toEqual(['2026-09-23']);
    expect(field()).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(field());
  });

  it('moves by the arrow keys as they read in RTL, across a month, and picks with Enter', () => {
    const seen: string[] = [];
    render(<Harness initial="2026-10-21" onValue={(value) => seen.push(value)} />);
    fireEvent.click(field());
    // Focus starts on the chosen day (29 Mehr).
    expect(document.activeElement).toBe(day(29));
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(day(30));
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(day(29));
    // Down a week leaves Mehr (30 days) for 6 Aban.
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(popover()).toHaveAttribute('data-view-month', '8');
    expect(document.activeElement).toBe(day(6));
    fireEvent.keyDown(document.activeElement as Element, { key: 'Enter' });
    fireEvent.click(document.activeElement as Element);
    expect(seen).toEqual(['2026-10-28']);
  });

  it('closes on Escape without a change and returns focus to the button', () => {
    const seen: string[] = [];
    render(<Harness initial="2026-10-21" onValue={(value) => seen.push(value)} />);
    fireEvent.click(field());
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(field()).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(field());
    expect(seen).toEqual([]);
  });

  it('closes on a click outside', () => {
    render(
      <>
        <Harness />
        <button type="button">elsewhere</button>
      </>,
    );
    fireEvent.click(field());
    fireEvent.mouseDown(screen.getByText('elsewhere'));
    expect(field()).toHaveAttribute('aria-expanded', 'false');
  });

  it('respects min and max: days and quick picks outside them cannot be chosen', () => {
    const seen: string[] = [];
    render(<Harness min="2026-10-10" max="2026-10-20" onValue={(value) => seen.push(value)} />);
    fireEvent.click(field());
    expect(day(17)).toHaveAttribute('aria-disabled', 'true'); // 2026-10-09
    expect(day(18)).not.toHaveAttribute('aria-disabled');
    expect(day(28)).not.toHaveAttribute('aria-disabled'); // 2026-10-20, the max itself
    fireEvent.click(day(17));
    expect(seen).toEqual([]);
    expect(
      within(popover()).getByRole('button', { name: t('web.date_30_days_ago') }),
    ).toBeDisabled();
    expect(within(popover()).getByRole('button', { name: t('web.date_today') })).toBeEnabled();
    expect(day(29)).toHaveAttribute('aria-disabled', 'true'); // 2026-10-21
  });

  it('opens a 12-month grid from the title, with year arrows', () => {
    render(<Harness initial="2026-10-16" />);
    fireEvent.click(field());
    fireEvent.click(within(popover()).getByRole('button', { name: t('web.date_choose_month') }));
    expect(popover().querySelectorAll('[data-month]')).toHaveLength(12);
    fireEvent.click(within(popover()).getByRole('button', { name: t('web.date_next_year') }));
    expect(popover()).toHaveAttribute('data-view-year', '1406');
    fireEvent.click(within(popover()).getByRole('button', { name: t('web.jalali_m12') }));
    expect(popover()).toHaveAttribute('data-view-month', '12');
    // Esfand 1406 is a common year: 29 days.
    expect(popover().querySelectorAll('[data-day]')).toHaveLength(29);
  });

  it('offers today, yesterday, a week and a month ago', () => {
    const seen: string[] = [];
    render(<Harness onValue={(value) => seen.push(value)} />);
    for (const key of [
      'web.date_today',
      'web.date_yesterday',
      'web.date_7_days_ago',
      'web.date_30_days_ago',
    ] as const) {
      fireEvent.click(field());
      fireEvent.click(within(popover()).getByRole('button', { name: t(key) }));
    }
    expect(seen).toEqual(['2026-10-16', '2026-10-15', '2026-10-09', '2026-09-16']);
  });

  it('clears from the footer and from the ×', () => {
    const seen: string[] = [];
    render(<Harness initial="2026-10-16" onValue={(value) => seen.push(value)} />);
    fireEvent.click(field());
    fireEvent.click(within(popover()).getByRole('button', { name: t('web.date_clear') }));
    expect(seen).toEqual(['']);
    expect(field()).toHaveTextContent(t('web.date_pick'));
    expect(screen.queryByRole('button', { name: t('web.date_clear_field') })).toBeNull();
  });

  it('clears with the × beside a value', () => {
    const seen: string[] = [];
    render(<Harness initial="2026-10-16" onValue={(value) => seen.push(value)} />);
    fireEvent.click(screen.getByRole('button', { name: t('web.date_clear_field') }));
    expect(seen).toEqual(['']);
  });
});

describe('date and time', () => {
  it('waits for «تأیید»: a day alone changes nothing, the time is typed or stepped', () => {
    const seen: string[] = [];
    render(<Harness mode="datetime" onValue={(value) => seen.push(value)} />);
    fireEvent.click(field());
    const ok = within(popover()).getByRole('button', { name: t('web.date_confirm') });
    expect(ok).toBeDisabled();
    fireEvent.click(day(25));
    expect(seen).toEqual([]);
    fireEvent.change(within(popover()).getByLabelText(t('web.date_hour')), {
      target: { value: plainDigits('08') },
    });
    fireEvent.change(within(popover()).getByLabelText(t('web.date_minute')), {
      target: { value: '05' },
    });
    fireEvent.click(within(popover()).getByRole('button', { name: t('web.date_hour_down') }));
    fireEvent.click(within(popover()).getByRole('button', { name: t('web.date_confirm') }));
    expect(seen).toEqual(['2026-10-17T07:05']);
  });

  it('offers now, an hour later and tomorrow at ten', () => {
    const seen: string[] = [];
    render(<Harness mode="datetime" onValue={(value) => seen.push(value)} />);
    for (const key of ['web.date_now', 'web.date_in_one_hour', 'web.date_tomorrow_10'] as const) {
      fireEvent.click(field());
      fireEvent.click(within(popover()).getByRole('button', { name: t(key) }));
      fireEvent.click(within(popover()).getByRole('button', { name: t('web.date_confirm') }));
    }
    expect(seen).toEqual(['2026-10-16T14:32', '2026-10-16T15:32', '2026-10-17T10:00']);
  });

  it('refuses a moment outside min/max', () => {
    render(<Harness mode="datetime" min="2026-10-16T15:00" />);
    fireEvent.click(field());
    fireEvent.click(within(popover()).getByRole('button', { name: t('web.date_now') }));
    expect(within(popover()).getByRole('button', { name: t('web.date_confirm') })).toBeDisabled();
    fireEvent.click(within(popover()).getByRole('button', { name: t('web.date_in_one_hour') }));
    expect(within(popover()).getByRole('button', { name: t('web.date_confirm') })).toBeEnabled();
  });

  it('time only: quick picks, wrap-around steps and «تأیید»', () => {
    const seen: string[] = [];
    render(<Harness mode="time" initial="23:10" onValue={(value) => seen.push(value)} />);
    expect(field()).toHaveTextContent(plainDigits('23:10'));
    fireEvent.click(field());
    fireEvent.click(within(popover()).getByRole('button', { name: t('web.date_hour_up') }));
    fireEvent.click(within(popover()).getByRole('button', { name: t('web.date_confirm') }));
    fireEvent.click(field());
    fireEvent.click(within(popover()).getByRole('button', { name: t('web.date_9am') }));
    fireEvent.click(within(popover()).getByRole('button', { name: t('web.date_confirm') }));
    expect(seen).toEqual(['00:10', '09:00']);
  });
});

describe('setDateField, the one way page tests set a date', () => {
  it('reaches any day, far in either direction, and clears', () => {
    const seen: string[] = [];
    render(<Harness onValue={(value) => seen.push(value)} />);
    setDateField(field(), '1999-02-28');
    setDateField(field(), '2031-12-31');
    setDateField(field(), '2025-03-20'); // 30 Esfand 1403, a leap day
    setDateField(field(), '');
    expect(seen).toEqual(['1999-02-28', '2031-12-31', '2025-03-20', '']);
  });

  it('sets a date-time and a time', () => {
    const seen: string[] = [];
    render(
      <>
        <Harness mode="datetime" onValue={(value) => seen.push(value)} />
      </>,
    );
    setDateField(field(), '2027-01-05T06:45');
    expect(seen).toEqual(['2027-01-05T06:45']);
  });

  it('fails loudly on a day the field refuses', () => {
    render(<Harness min="2026-10-10" />);
    expect(() => setDateField(field(), '2026-10-01')).toThrow(/min\/max/);
  });
});

describe('inside clipping containers', () => {
  it('draws the calendar in a portal, so a Drawer body cannot clip it, and picks there', () => {
    const seen: string[] = [];
    render(
      <Drawer open onClose={() => undefined} title="کشو">
        <Harness onValue={(value) => seen.push(value)} />
      </Drawer>,
    );
    fireEvent.click(field());
    const pop = popover();
    expect(pop.closest('.drawer')).toBeNull();
    expect(pop.closest('.drawer-body')).toBeNull();
    fireEvent.mouseDown(day(3));
    fireEvent.click(day(3));
    expect(seen).toEqual(['2026-09-25']);
  });

  it('a calendar opened from a filter panel does not close the panel when a day is pressed', () => {
    const seen: string[] = [];
    render(
      <ListFilterBar
        filters={[
          {
            key: 'from',
            label: 'از',
            active: null,
            onClear: () => undefined,
            control: <Harness onValue={(value) => seen.push(value)} />,
          },
        ]}
      />,
    );
    const panel = openFilterPanel();
    fireEvent.click(within(panel).getByLabelText('تاریخ'));
    fireEvent.mouseDown(day(5));
    fireEvent.click(day(5));
    expect(seen).toEqual(['2026-09-27']);
    expect(screen.getByRole('dialog', { name: t('web.filters') })).toBeInTheDocument();
  });

  it('setDateField refuses to clear a field that holds nothing', () => {
    render(<Harness />);
    expect(() => setDateField(field(), '')).toThrow(/nothing to clear/);
  });
});
