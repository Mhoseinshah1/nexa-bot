import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PageHead } from '../../apps/web/src/ui/kit';
import {
  AttentionStrip,
  CardRows,
  KpiRow,
  QuickAction,
  QuickActionBar,
  QuickFilters,
  SelectionBar,
  SettingRow,
  SettingsSection,
  StickySaveBar,
} from '../../apps/web/src/ui/redesign';
import {
  TimeField24,
  dayPartKey,
  parseTime24,
  persianDigits,
} from '../../apps/web/src/ui/time-field24';
import {
  LayoutDnd,
  keyboardMove,
  moveItem,
  type DndLayout,
} from '../../apps/web/src/ui/layout-dnd';

describe('PageHead extras', () => {
  it('draws the count chip, freshness, refresh and actions in one actions row', () => {
    const refresh = vi.fn();
    render(
      <PageHead
        title="کاربران"
        count={1234}
        freshness="۱۰ ثانیه پیش"
        onRefresh={refresh}
        actions={<button>جدید</button>}
      />,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('1,234');
    const row = document.querySelector('.page-head .actions') as HTMLElement;
    expect(within(row).getByText('۱۰ ثانیه پیش')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'به‌روزرسانی' }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(within(row).getByRole('button', { name: 'جدید' })).toBeTruthy();
  });

  it('draws neither chip nor refresh when not asked', () => {
    render(<PageHead title="کاربران" />);
    expect(document.querySelector('.count-chip')).toBeNull();
    expect(document.querySelector('.page-head .actions')).toBeNull();
  });
});

describe('QuickFilters', () => {
  it('marks the selected chip pressed, shows server counts and reports a change', () => {
    const onChange = vi.fn();
    render(
      <QuickFilters
        label="فیلتر"
        value="all"
        onChange={onChange}
        items={[
          { key: 'all', label: 'همه', count: 12 },
          { key: 'open', label: 'باز' },
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: /همه/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /همه/ }).textContent).toContain('12');
    fireEvent.click(screen.getByRole('button', { name: 'باز' }));
    expect(onChange).toHaveBeenCalledWith('open');
  });
});

describe('SelectionBar', () => {
  it('exists only while rows are ticked', () => {
    const { rerender } = render(<SelectionBar count={0} onClear={() => {}} />);
    expect(screen.queryByRole('region')).toBeNull();
    const clear = vi.fn();
    rerender(
      <SelectionBar count={3} onClear={clear}>
        <button>حذف</button>
      </SelectionBar>,
    );
    expect(screen.getByRole('region').textContent).toContain('3 مورد انتخاب شده');
    fireEvent.click(screen.getByRole('button', { name: 'لغو انتخاب' }));
    expect(clear).toHaveBeenCalled();
  });
});

describe('QuickActionBar', () => {
  it('draws labelled groups and skips groups with no action', () => {
    render(
      <QuickActionBar
        groups={[
          { key: 'w', label: 'کیف پول', actions: [<QuickAction key="a" label="افزایش" />] },
          { key: 'x', label: 'حساب', actions: [false, null] },
        ]}
      />,
    );
    expect(screen.getByRole('toolbar')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'کیف پول' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'حساب' })).toBeNull();
  });

  it('draws nothing when no group has an action', () => {
    render(<QuickActionBar groups={[{ key: 'x', label: 'حساب', actions: [null] }]} />);
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('a dangerous action is red and ends in an ellipsis, once', () => {
    render(
      <>
        <QuickAction danger label="مسدود کردن" />
        <QuickAction danger label="حذف…" />
      </>,
    );
    expect(screen.getByRole('button', { name: 'مسدود کردن…' }).className).toContain('danger');
    expect(screen.getByRole('button', { name: 'حذف…' })).toBeTruthy();
  });

  it('a disabled action says why, on hover and to assistive technology', () => {
    const onClick = vi.fn();
    render(
      <QuickAction
        label="بازگشت وجه"
        disabled
        disabledReason="پرداخت تسویه نشده است"
        onClick={onClick}
      />,
    );
    const button = screen.getByRole('button', { name: 'بازگشت وجه' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.parentElement?.getAttribute('title')).toBe('پرداخت تسویه نشده است');
    expect(button.getAttribute('aria-describedby')).toBeTruthy();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('AttentionStrip', () => {
  it('draws nothing without items', () => {
    render(<AttentionStrip items={[]} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('lists items as links with their counts', () => {
    render(
      <AttentionStrip
        items={[{ key: 'p', label: 'پرداخت نامعلوم', count: 2, href: '/payments' }]}
      />,
    );
    const link = screen.getByRole('link', { name: /پرداخت نامعلوم/ });
    expect(link.getAttribute('href')).toBe('/payments');
    expect(link.textContent).toContain('2');
  });
});

describe('KpiRow and CardRows', () => {
  it('draws one cell per figure', () => {
    render(
      <KpiRow
        items={[
          { key: 'a', label: 'موجودی', value: '185,000', unit: 'تومان' },
          { key: 'b', label: 'تست', value: '—' },
        ]}
      />,
    );
    expect(document.querySelectorAll('.kpi-cell').length).toBe(2);
  });
  it('lays cards out as rows (same height), a solo row spanning', () => {
    render(
      <CardRows
        rows={[
          {
            key: 'r1',
            main: <section className="card">الف</section>,
            side: <section className="card">ب</section>,
          },
          { key: 'r2', main: <section className="card">ج</section> },
        ]}
      />,
    );
    const rows = document.querySelectorAll('.card-row');
    expect(rows.length).toBe(2);
    expect(rows[0]?.querySelectorAll('.card').length).toBe(2);
    expect(rows[1]?.classList.contains('solo')).toBe(true);
  });
});

describe('Settings', () => {
  it('collapses a section and keeps its rows reachable when open', () => {
    render(
      <SettingsSection title="عمومی" changed={2}>
        <SettingRow title="نام" control={<input aria-label="نام" />} changed />
      </SettingsSection>,
    );
    const toggle = screen.getByRole('button', { name: /عمومی/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.settings-section-body')?.hasAttribute('hidden')).toBe(true);
  });

  it('the save bar exists only with changes and hands save/cancel back to the page', () => {
    const save = vi.fn();
    const cancel = vi.fn();
    const { rerender } = render(<StickySaveBar changes={0} onSave={save} onCancel={cancel} />);
    expect(screen.queryByRole('region')).toBeNull();
    rerender(<StickySaveBar changes={3} onSave={save} onCancel={cancel} />);
    expect(screen.getByRole('region').textContent).toContain('3 تغییر ذخیره‌نشده');
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    fireEvent.click(screen.getByRole('button', { name: 'لغو' }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('a save in flight disables both buttons', () => {
    render(<StickySaveBar changes={1} saving onSave={() => {}} onCancel={() => {}} />);
    expect((screen.getByRole('button', { name: 'لغو' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('TimeField24', () => {
  it('parses and labels 24-hour times', () => {
    expect(parseTime24('23:55')).toEqual({ hour: 23, minute: 55 });
    expect(parseTime24('24:00')).toBeNull();
    expect(parseTime24('9:00')).toBeNull();
    expect(persianDigits('09:30')).toBe('۰۹:۳۰');
    expect(dayPartKey(2)).toBe('web.kit_daypart_dawn');
    expect(dayPartKey(9)).toBe('web.kit_daypart_morning');
    expect(dayPartKey(14)).toBe('web.kit_daypart_afternoon');
    expect(dayPartKey(18)).toBe('web.kit_daypart_evening');
    expect(dayPartKey(23)).toBe('web.kit_daypart_night');
  });

  it('offers hours 00–23 and minutes in 5-minute steps, in Persian digits, with a day part', () => {
    function Harness() {
      const [value, setValue] = useState('22:30');
      return <TimeField24 label="زمان بکاپ" value={value} onChange={setValue} />;
    }
    render(<Harness />);
    const hour = screen.getByLabelText('زمان بکاپ — ساعت') as HTMLSelectElement;
    const minute = screen.getByLabelText('زمان بکاپ — دقیقه') as HTMLSelectElement;
    expect(hour.options.length).toBe(24);
    expect(hour.options[23]?.textContent).toBe('۲۳');
    expect(minute.options.length).toBe(12);
    expect(minute.options[1]?.textContent).toBe('۰۵');
    expect(document.body.textContent).toContain('شب');
    expect(document.body.textContent).not.toMatch(/AM|PM/);
    fireEvent.change(hour, { target: { value: '06' } });
    expect(hour.value).toBe('06');
    expect(minute.value).toBe('30');
    expect(document.body.textContent).toContain('صبح');
  });

  it('keeps a stored minute that is off the 5-minute grid', () => {
    render(<TimeField24 label="زمان" value="08:07" onChange={() => {}} />);
    const minute = screen.getByLabelText('زمان — دقیقه') as HTMLSelectElement;
    expect(minute.value).toBe('07');
    expect(minute.options.length).toBe(13);
  });
});

describe('moveItem (layout drag and drop)', () => {
  const base: DndLayout = { rows: [['a', 'b'], ['c'], ['d', 'e', 'f']], free: ['g'] };

  it('places next to an item, before or after', () => {
    expect(moveItem(base, 'c', { kind: 'item', id: 'a', side: 'before' })?.rows[0]).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(moveItem(base, 'a', { kind: 'item', id: 'c', side: 'after' })?.rows).toEqual([
      ['b'],
      ['c', 'a'],
      ['d', 'e', 'f'],
    ]);
  });
  it('drops on the empty space of a row: the end of that row', () => {
    expect(moveItem(base, 'a', { kind: 'row-end', row: 1 })?.rows).toEqual([
      ['b'],
      ['c', 'a'],
      ['d', 'e', 'f'],
    ]);
  });
  it('drops on the line between rows: a new row there, and an emptied row disappears', () => {
    expect(moveItem(base, 'c', { kind: 'gap', at: 0 })?.rows).toEqual([
      ['c'],
      ['a', 'b'],
      ['d', 'e', 'f'],
    ]);
    expect(moveItem(base, 'c', { kind: 'gap', at: 3 })?.rows).toEqual([
      ['a', 'b'],
      ['d', 'e', 'f'],
      ['c'],
    ]);
  });
  it('drops on the «ردیف تازه» zone: a new last row', () => {
    expect(moveItem(base, 'a', { kind: 'new-row' })?.rows).toEqual([
      ['b'],
      ['c'],
      ['d', 'e', 'f'],
      ['a'],
    ]);
  });
  it('drops in the free box and back into the layout', () => {
    const freed = moveItem(base, 'a', { kind: 'free' });
    expect(freed?.rows[0]).toEqual(['b']);
    expect(freed?.free).toEqual(['g', 'a']);
    expect(moveItem(base, 'g', { kind: 'row-end', row: 1 })).toEqual({
      rows: [
        ['a', 'b'],
        ['c', 'g'],
        ['d', 'e', 'f'],
      ],
      free: [],
    });
  });
  it('a drop that changes nothing, or an unknown item, answers null', () => {
    expect(moveItem(base, 'a', { kind: 'item', id: 'a', side: 'before' })).toBeNull();
    expect(moveItem(base, 'a', { kind: 'item', id: 'b', side: 'before' })).toBeNull();
    expect(moveItem(base, 'zz', { kind: 'free' })).toBeNull();
  });
  it('keeps the per-row maximum', () => {
    expect(moveItem(base, 'a', { kind: 'row-end', row: 2 }, { maxPerRow: 3 })).toBeNull();
    expect(
      moveItem(base, 'a', { kind: 'item', id: 'e', side: 'after' }, { maxPerRow: 3 }),
    ).toBeNull();
    expect(
      moveItem(base, 'd', { kind: 'item', id: 'f', side: 'after' }, { maxPerRow: 3 })?.rows[2],
    ).toEqual(['e', 'f', 'd']);
  });
  it('a fixed last item cannot be dragged and stays last', () => {
    const layout: DndLayout = {
      rows: [
        ['a', 'b'],
        ['c', 'back'],
      ],
      free: [],
    };
    const rules = { fixed: ['back'], maxPerRow: 3 };
    expect(moveItem(layout, 'back', { kind: 'free' }, rules)).toBeNull();
    expect(moveItem(layout, 'a', { kind: 'item', id: 'back', side: 'after' }, rules)).toBeNull();
    expect(moveItem(layout, 'a', { kind: 'row-end', row: 1 }, rules)?.rows[1]).toEqual([
      'c',
      'a',
      'back',
    ]);
    expect(moveItem(layout, 'a', { kind: 'new-row' }, rules)?.rows).toEqual([
      ['b'],
      ['a'],
      ['c', 'back'],
    ]);
  });
});

describe('keyboardMove', () => {
  const base: DndLayout = { rows: [['a', 'b'], ['c']], free: [] };
  it('moves along a row (RTL: Left goes toward the row end)', () => {
    expect(keyboardMove(base, 'a', 'ArrowLeft')?.rows[0]).toEqual(['b', 'a']);
    expect(keyboardMove(base, 'b', 'ArrowRight')?.rows[0]).toEqual(['b', 'a']);
    expect(keyboardMove(base, 'a', 'ArrowRight')).toBeNull();
  });
  it('moves between rows and makes a new row past the last or first', () => {
    expect(keyboardMove(base, 'a', 'ArrowDown')?.rows).toEqual([['b'], ['a', 'c']]);
    expect(keyboardMove(base, 'b', 'ArrowDown')?.rows[1]).toEqual(['b', 'c']);
    expect(keyboardMove(base, 'a', 'ArrowUp')?.rows).toEqual([['a'], ['b'], ['c']]);
    expect(keyboardMove(base, 'c', 'ArrowDown')).toBeNull();
  });
  it('Delete frees an item; an arrow brings it back', () => {
    const freed = keyboardMove(base, 'a', 'Delete');
    expect(freed?.free).toEqual(['a']);
    expect(keyboardMove(freed as DndLayout, 'a', 'ArrowUp')?.rows).toEqual([['b'], ['c', 'a']]);
  });
});

describe('LayoutDnd keyboard flow', () => {
  function Harness({ onChange }: { onChange?: (l: DndLayout) => void }) {
    const [layout, setLayout] = useState<DndLayout>({ rows: [['a', 'b']], free: [] });
    return (
      <LayoutDnd
        label="چیدمان"
        layout={layout}
        nameOf={(id) => `دکمه ${id}`}
        renderItem={(id) => <span>{id}</span>}
        onChange={(next) => {
          setLayout(next);
          onChange?.(next);
        }}
      />
    );
  }
  it('grab with Enter, move with arrows, drop with Enter; Escape restores', () => {
    const seen: DndLayout[] = [];
    render(<Harness onChange={(l) => seen.push(l)} />);
    const items = () => Array.from(document.querySelectorAll<HTMLElement>('[data-dnd-item]'));
    const a = items()[0] as HTMLElement;
    fireEvent.keyDown(a, { key: 'Enter' });
    expect(a.getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(a, { key: 'ArrowLeft' });
    expect(items().map((i) => i.dataset['dndItem'])).toEqual(['b', 'a']);
    fireEvent.keyDown(items()[1] as HTMLElement, { key: 'Escape' });
    expect(items().map((i) => i.dataset['dndItem'])).toEqual(['a', 'b']);
    // Without grabbing first, arrows do nothing.
    fireEvent.keyDown(items()[0] as HTMLElement, { key: 'ArrowLeft' });
    expect(items().map((i) => i.dataset['dndItem'])).toEqual(['a', 'b']);
    // No up/down/left/right BUTTONS exist.
    expect(screen.queryByRole('button', { name: /بالا|پایین|جدا/ })).toBeNull();
  });
});
