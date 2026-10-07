import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  BarChart,
  Checkbox,
  CursorPager,
  DetailHead,
  Disclosure,
  Donut,
  Drawer,
  FilterChip,
  LeaveGuardHost,
  LineChart,
  Menu,
  Modal,
  Num,
  PageHead,
  PeriodControl,
  Progress,
  Quantity,
  RoutedTabs,
  Sparkline,
  StatCard,
  axisLabelSlots,
  progressRatio,
  useUnsavedChanges,
  type PeriodPreset,
} from '../../apps/web/src/ui/kit';
import { ICON_NAMES, Icon } from '../../apps/web/src/ui/icons';
import { NAV } from '../../apps/web/src/app';
import { navigate, useRoute } from '../../apps/web/src/router';
import { t } from '../../apps/web/src/i18n/web.fa';
import { formatNumber } from '../../apps/web/src/format';
import { renderPage, stubApi } from './harness';

/**
 * The shared kit's own behaviour. The pages are tested where they live; what
 * is pinned here is what every page inherits by using a component — and one
 * rule above all: no component writes a `style` attribute, which the
 * production policy (`style-src 'self'`) would silently drop.
 */

/** Moves the router itself (not just the address bar), past any guard. */
const go = (url: string) => act(() => navigate(url, { replace: true, force: true }));

afterEach(() => {
  go('/');
});

const noStyle = (root: ParentNode = document) => root.querySelectorAll('[style]').length;

describe('Progress', () => {
  it('is exact for bigints past 2^53, and clamps', () => {
    expect(progressRatio(2n ** 60n, 2n ** 61n)).toBe(0.5);
    expect(progressRatio(2n ** 61n + 1n, 2n ** 61n)).toBe(1);
    expect(progressRatio(-5, 10)).toBe(0);
    expect(progressRatio(5, 0)).toBe(0);
    expect(progressRatio(3, 12)).toBe(0.25);
  });

  it('is a labelled progressbar whose width is SVG geometry, not a style', () => {
    const { container } = renderPage(<Progress value={90n} max={100n} label="ترافیک" />);
    const bar = screen.getByRole('progressbar', { name: 'ترافیک' });
    expect(bar.getAttribute('aria-valuenow')).toBe('90');
    expect(bar.getAttribute('class')).toContain('warn');
    expect(container.querySelector('rect')?.getAttribute('width')).toBe('90');
    expect(noStyle(container)).toBe(0);
  });
});

describe('StatCard and DetailHead', () => {
  it('draws a delta with its meaning, and none without one', () => {
    const { container, rerender } = renderPage(
      <StatCard label="فروش" value="۱۲" delta={{ text: '۸٪', direction: 'good', trend: 'up' }} />,
    );
    expect(container.querySelector('.delta.good')?.textContent).toContain('۸٪');
    expect(screen.getByText(t('web.vs_previous'))).toBeInTheDocument();
    rerender(<StatCard label="فروش" value="۱۲" />);
    expect(container.querySelector('.delta')).toBeNull();
  });

  it('puts the detail head stats in a definition list', () => {
    renderPage(<DetailHead title="Frankfurt A" stats={[{ label: 'سرویس', value: '۱۲' }]} />);
    const term = screen.getByText('سرویس');
    expect(term.tagName).toBe('DT');
    expect(term.nextElementSibling?.textContent).toBe('۱۲');
  });
});

describe('PageHead', () => {
  it('flags only a page that does not do its job yet', () => {
    const { container } = renderPage(
      <>
        <PageHead title="کاربران" subtitle="فهرست" />
        <PageHead title="گزارش" maturity="planned" />
        {/* @ts-expect-error — a working page carries no maturity badge beside its title. */}
        <PageHead title="سفارش‌ها" maturity="now" />
      </>,
    );
    const heads = [...container.querySelectorAll('.page-head')];
    expect(heads[0]?.querySelector('.maturity')).toBeNull();
    expect(heads[1]?.querySelector('.maturity.planned')?.textContent).toBe(
      t('web.maturity_planned'),
    );
  });
});

describe('Modal', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          باز
        </button>
        <Modal open={open} onClose={() => setOpen(false)} title="عنوان">
          <input aria-label="درون" />
        </Modal>
      </>
    );
  }

  it('traps focus, closes on Escape and hands focus back', () => {
    renderPage(<Harness />);
    const opener = screen.getByRole('button', { name: 'باز' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'عنوان' });
    // Rendered into the body, outside the page's own tree.
    expect(dialog.closest('.modal-layer')?.parentElement).toBe(document.body);
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

/**
 * Focus traps stack and only reachable controls count (roadmap B7).
 *
 * A dialog opened from a drawer let BOTH traps' document listeners run: one Escape closed
 * both, and the drawer's trap pulled Tab focus back out of the dialog. And a control the
 * trap counted but Tab could never reach — inside a `[hidden]` toolbar or a closed
 * `<details>` — as the last match let Tab leave the dialog for the page behind it.
 */
describe('focus traps', () => {
  function Nested() {
    const [drawer, setDrawer] = useState(true);
    const [modal, setModal] = useState(false);
    return (
      <Drawer open={drawer} onClose={() => setDrawer(false)} title="کشو">
        <button type="button" onClick={() => setModal(true)}>
          گفتگو
        </button>
        <Modal open={modal} onClose={() => setModal(false)} title="درونی">
          <input aria-label="اول" />
          <input aria-label="دوم" />
        </Modal>
      </Drawer>
    );
  }

  it('lets only the innermost trap answer Escape', () => {
    renderPage(<Nested />);
    fireEvent.click(screen.getByRole('button', { name: 'گفتگو' }));
    expect(screen.getByRole('dialog', { name: 'درونی' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'درونی' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'کشو' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'کشو' })).toBeNull();
  });

  it('keeps Tab inside the innermost trap', () => {
    renderPage(<Nested />);
    fireEvent.click(screen.getByRole('button', { name: 'گفتگو' }));
    const inner = screen.getByRole('dialog', { name: 'درونی' });
    const last = within(inner).getByRole('textbox', { name: 'دوم' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    // Wrapped to the dialog's first control (its close button), not pulled into the drawer.
    expect(inner.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(inner).getAllByRole('button')[0]);
  });

  it('wraps from the last REACHABLE control, skipping hidden and collapsed ones', () => {
    function Hidden() {
      return (
        <Modal open onClose={() => undefined} title="پنهان">
          <input aria-label="پیدا" />
          <div hidden>
            <button type="button">نادیدنی</button>
          </div>
          <details>
            <summary>بیشتر</summary>
            <button type="button">درون جمع‌شده</button>
          </details>
        </Modal>
      );
    }
    renderPage(<Hidden />);
    const dialog = screen.getByRole('dialog', { name: 'پنهان' });
    const summary = within(dialog).getByText('بیشتر');
    summary.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(within(dialog).getAllByRole('button')[0]);
  });

  it('wraps past a [hidden] toolbar that ends the dialog', () => {
    renderPage(
      <Modal open onClose={() => undefined} title="نوار پنهان">
        <input aria-label="آخرین" />
        <div hidden>
          <button type="button">پنهان</button>
        </div>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'نوار پنهان' });
    within(dialog).getByRole('textbox', { name: 'آخرین' }).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(within(dialog).getAllByRole('button')[0]);
  });

  it('ranks a dialog above the drawer it sits in when both open in the same commit', () => {
    function Both() {
      const [drawer, setDrawer] = useState(true);
      const [modal, setModal] = useState(true);
      return (
        <Drawer open={drawer} onClose={() => setDrawer(false)} title="کشوی هم‌زمان">
          <Modal open={modal} onClose={() => setModal(false)} title="گفتگوی هم‌زمان">
            <input aria-label="درون گفتگو" />
          </Modal>
        </Drawer>
      );
    }
    renderPage(<Both />);
    const inner = screen.getByRole('dialog', { name: 'گفتگوی هم‌زمان' });
    expect(inner.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'گفتگوی هم‌زمان' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'کشوی هم‌زمان' })).toBeInTheDocument();
  });

  it('wraps past a tail control hidden by CSS', () => {
    const style = document.createElement('style');
    style.textContent = '.css-gone { display: none } .css-unseen { visibility: hidden }';
    document.head.append(style);
    try {
      renderPage(
        <Modal open onClose={() => undefined} title="پنهان با سبک">
          <input aria-label="آخرِ دیدنی" />
          <div className="css-gone">
            <button type="button">پنهان با کلاس</button>
          </div>
          <button type="button" className="css-unseen">
            نادیده
          </button>
        </Modal>,
      );
      const dialog = screen.getByRole('dialog', { name: 'پنهان با سبک' });
      within(dialog).getByRole('textbox', { name: 'آخرِ دیدنی' }).focus();
      fireEvent.keyDown(document, { key: 'Tab' });
      expect(document.activeElement).toBe(within(dialog).getAllByRole('button')[0]);
    } finally {
      style.remove();
    }
  });

  it('wraps past an inert tail', () => {
    renderPage(
      <Modal open onClose={() => undefined} title="بی‌اثر">
        <input aria-label="آخرِ فعال" />
        <div inert>
          <button type="button">بی‌اثر</button>
        </div>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'بی‌اثر' });
    within(dialog).getByRole('textbox', { name: 'آخرِ فعال' }).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(within(dialog).getAllByRole('button')[0]);
  });

  it('closes only the menu when Escape is pressed inside a menu in a dialog', () => {
    const closed = vi.fn();
    renderPage(
      <Modal open onClose={closed} title="با منو">
        <Menu
          label="گزینه‌ها"
          trigger="گزینه‌ها"
          items={[{ key: 'a', label: 'یک', onSelect: () => undefined }]}
        />
      </Modal>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'گزینه‌ها' }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(closed).not.toHaveBeenCalled();
  });
});

describe('Menu', () => {
  it('opens, moves with the arrows, closes on Escape and returns focus', () => {
    const chosen = vi.fn();
    renderPage(
      <Menu
        label="حساب"
        trigger="حساب"
        items={[
          { key: 'a', label: 'اول', onSelect: () => undefined },
          { key: 'b', label: 'دوم', onSelect: chosen },
        ]}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'حساب' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu');
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'اول' }));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'دوم' }));
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'دوم' }));
    expect(chosen).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('RoutedTabs (lead decision D1)', () => {
  const opened: string[] = [];
  function Panel({ id }: { id: string }) {
    opened.push(id);
    return <p>{`panel-${id}`}</p>;
  }
  function Page() {
    const route = useRoute();
    return (
      <RoutedTabs
        route={route}
        panelId="detail"
        items={[
          { id: 'overview', label: 'کلیات' },
          { id: 'history', label: 'تاریخچه', count: 3 },
        ]}
      >
        {(tab) => <Panel id={tab} />}
      </RoutedTabs>
    );
  }

  it('takes the tab from ?tab=, mounts only the open panel, and pushes history', () => {
    opened.length = 0;
    go('/panels/x?tab=history');
    renderPage(<Page />);
    expect(screen.getByText('panel-history')).toBeInTheDocument();
    expect(screen.queryByText('panel-overview')).toBeNull();
    expect(opened).not.toContain('overview');
    expect(screen.getByRole('tab', { name: /تاریخچه/ }).textContent).toContain(formatNumber(3));

    const before = window.history.length;
    fireEvent.click(screen.getByRole('tab', { name: 'کلیات' }));
    // The first tab is the default, so it leaves the URL clean — and it is a new entry.
    expect(window.location.search).toBe('');
    expect(window.history.length).toBe(before + 1);
    expect(screen.getByText('panel-overview')).toBeInTheDocument();
  });

  it('falls back to the first tab for a value it does not know', () => {
    go('/panels/x?tab=../admins');
    renderPage(<Page />);
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('کلیات');
  });
});

describe('useUnsavedChanges', () => {
  function Form({ dirty }: { dirty: boolean }) {
    useUnsavedChanges(dirty);
    return <p>{`at ${useRoute().path}`}</p>;
  }

  it('asks before leaving a dirty page, and stays or leaves as answered', async () => {
    go('/settings');
    renderPage(
      <>
        <Form dirty />
        <LeaveGuardHost />
      </>,
    );
    act(() => navigate('/panels'));
    expect(window.location.pathname).toBe('/settings');
    const dialog = screen.getByRole('alertdialog', { name: t('web.unsaved_title') });
    fireEvent.click(within(dialog).getByRole('button', { name: t('web.unsaved_stay') }));
    expect(window.location.pathname).toBe('/settings');
    expect(screen.queryByRole('alertdialog')).toBeNull();

    act(() => navigate('/panels'));
    fireEvent.click(screen.getByRole('button', { name: t('web.unsaved_leave') }));
    expect(window.location.pathname).toBe('/panels');
  });

  it('does not interrupt a filter change on the same page', () => {
    go('/settings');
    renderPage(
      <>
        <Form dirty />
        <LeaveGuardHost />
      </>,
    );
    act(() => navigate('/settings?group=sales', { replace: true }));
    expect(window.location.search).toBe('?group=sales');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('lets a clean page go, and holds the browser prompt only while dirty', () => {
    go('/settings');
    const { rerender } = renderPage(
      <>
        <Form dirty />
        <LeaveGuardHost />
      </>,
    );
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    rerender(
      <>
        <Form dirty={false} />
        <LeaveGuardHost />
      </>,
    );
    const again = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(again);
    expect(again.defaultPrevented).toBe(false);
    act(() => navigate('/panels'));
    expect(window.location.pathname).toBe('/panels');
  });

  it('puts Back back and asks, when a dirty page is left by popstate', () => {
    go('/panels');
    act(() => navigate('/settings', { force: true }));
    renderPage(
      <>
        <Form dirty />
        <LeaveGuardHost />
      </>,
    );
    // What the browser does on Back: the URL changes first, then popstate fires.
    act(() => {
      window.history.replaceState(null, '', '/panels');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(window.location.pathname).toBe('/settings');
    fireEvent.click(screen.getByRole('button', { name: t('web.unsaved_leave') }));
    expect(window.location.pathname).toBe('/panels');
  });
});

describe('a guarded browser traversal', () => {
  function Form() {
    useUnsavedChanges(true);
    const route = useRoute();
    return <p>{`at ${route.path}${route.query.toString()}`}</p>;
  }
  // jsdom traverses history on a later task, so each step waits for the
  // state it produces rather than for a fixed time a loaded machine can miss.
  const traverse = async (step: () => void, done: () => void) => {
    act(step);
    await waitFor(done);
  };

  it('asks on Back between two ?tab= entries of the same page', async () => {
    go('/panels/x?tab=overview');
    // A `?tab=` switch that unmounts a tab's form is a GUARDED navigation.
    act(() => navigate('/panels/x?tab=history', { force: true, guard: true }));
    renderPage(
      <>
        <Form />
        <LeaveGuardHost />
      </>,
    );
    await traverse(
      () => window.history.back(),
      () => {
        expect(
          screen.getByRole('alertdialog', { name: t('web.unsaved_title') }),
        ).toBeInTheDocument();
        // The browser has been put back on the entry the dirty tab lives on.
        expect(window.location.search).toBe('?tab=history');
      },
    );
    fireEvent.click(screen.getByRole('button', { name: t('web.unsaved_stay') }));
    expect(window.location.search).toBe('?tab=history');
  });

  it('lets Back through a query-only entry no guarded navigation wrote', async () => {
    // A pager, or a tab strip that keeps every panel mounted: the forward step
    // did not ask, so neither does the step back.
    go('/orders');
    act(() => navigate('/panels/x', { force: true }));
    act(() => navigate('/panels/x?tab=health', { force: true }));
    renderPage(
      <>
        <Form />
        <LeaveGuardHost />
      </>,
    );
    await traverse(
      () => window.history.back(),
      () => expect(screen.getByText('at /panels/x')).toBeInTheDocument(),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // And a path change behind it is still guarded.
    await traverse(
      () => window.history.back(),
      () => {
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
        // Put back on the page the operator is on before anything else moves.
        expect(window.location.pathname).toBe('/panels/x');
      },
    );
    fireEvent.click(screen.getByRole('button', { name: t('web.unsaved_stay') }));
  });

  it('leaves by traversal, so the stack keeps the entries it had', async () => {
    go('/orders');
    act(() => navigate('/panels', { force: true }));
    act(() => navigate('/settings', { force: true }));
    const length = window.history.length;
    renderPage(
      <>
        <Form />
        <LeaveGuardHost />
      </>,
    );
    await traverse(
      () => window.history.back(),
      () => {
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
        expect(window.location.pathname).toBe('/settings');
      },
    );
    await traverse(
      () => fireEvent.click(screen.getByRole('button', { name: t('web.unsaved_leave') })),
      () => expect(screen.getByText('at /panels')).toBeInTheDocument(),
    );
    expect(window.location.pathname).toBe('/panels');
    expect(window.history.length, 'nothing was pushed').toBe(length);
    // Back continues backward, rather than returning to the page just left.
    await traverse(
      () => window.history.back(),
      () => {
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
        expect(window.location.pathname).toBe('/panels');
      },
    );
    await traverse(
      () => fireEvent.click(screen.getByRole('button', { name: t('web.unsaved_leave') })),
      () => expect(screen.getByText('at /orders')).toBeInTheDocument(),
    );
  });
});

describe('charts', () => {
  it('breaks the line at a null instead of drawing it to zero, and writes no style', () => {
    stubApi([]);
    const { container } = renderPage(
      <LineChart
        caption="درآمد"
        labels={['a', 'b', 'c', 'd', 'e']}
        series={[
          { name: 'جاری', values: [1, 2, null, 4, 5] },
          { name: 'قبلی', values: [1, 1, 1, 1, 1], dashed: true },
        ]}
      />,
    );
    expect(screen.getByRole('img', { name: 'درآمد' })).toBeInTheDocument();
    // Two runs for the current series, one for the previous.
    expect(container.querySelectorAll('path.line:not(.dashed)')).toHaveLength(2);
    expect(container.querySelectorAll('path.line.dashed')).toHaveLength(1);
    // Every value is reachable as text, the gap as a dash.
    const table = container.querySelector('table.visually-hidden') as HTMLTableElement;
    expect(table.textContent).toContain('—');
    // Each slot is a focus target that names its values.
    expect(container.querySelectorAll('rect.hit[tabindex="0"]')).toHaveLength(5);
    expect(noStyle(container)).toBe(0);
  });

  it('shows a supplied exact text for a value instead of its formatted coordinate', () => {
    const format = (value: number) => `~${value}`;
    const { container } = renderPage(
      <>
        <LineChart
          caption="خط"
          labels={['a', 'b']}
          format={format}
          series={[{ name: 'جاری', values: [1, 2], texts: ['exact-1', null] }]}
        />
        <BarChart
          caption="ستون"
          labels={['a', 'b']}
          format={format}
          series={[{ name: 'x', values: [3, 4], texts: [null, 'exact-4'] }]}
        />
      </>,
    );
    const [line, bar] = [...container.querySelectorAll('figure')] as HTMLElement[];
    for (const [figure, exact, fallback, index] of [
      [line, 'exact-1', '~2', 0],
      [bar, 'exact-4', '~3', 1],
    ] as const) {
      const table = figure?.querySelector('table.visually-hidden')?.textContent ?? '';
      expect(table).toContain(exact);
      // A slot with no text falls back to the formatter; the texted one never uses it.
      expect(table).toContain(fallback);
      expect(table).not.toContain(exact === 'exact-1' ? '~1' : '~4');
      const hit = figure?.querySelectorAll('rect.hit')[index] as Element;
      expect(hit.getAttribute('aria-label')).toContain(exact);
      fireEvent.focus(hit);
      expect(figure?.querySelector('.chart-readout')?.textContent).toContain(exact);
    }
  });

  it('draws nothing it would have to invent', () => {
    const { container } = renderPage(
      <>
        <Sparkline label="روند" values={[3]} />
        <Donut caption="سهم" slices={[{ key: 'a', label: 'الف', value: 0 }]} />
        <BarChart caption="سفارش" labels={['a']} series={[{ name: 'x', values: [null] }]} />
      </>,
    );
    expect(container.querySelector('svg.spark')).toBeNull();
    expect(screen.getAllByText(t('web.chart_empty'))).toHaveLength(2);
  });

  it('never draws two x-axis labels closer than one step, and always the last', () => {
    for (const most of [8, 10]) {
      for (let slots = 1; slots <= 120; slots += 1) {
        const shown = [...axisLabelSlots(slots, most)].sort((a, b) => a - b);
        const step = Math.max(1, Math.ceil(slots / most));
        expect(shown[0]).toBe(0);
        expect(shown[shown.length - 1]).toBe(slots - 1);
        expect(shown.length).toBeLessThanOrEqual(most + 1);
        for (let n = 1; n < shown.length; n += 1) {
          expect((shown[n] as number) - (shown[n - 1] as number)).toBeGreaterThanOrEqual(step);
        }
      }
    }
    // The dashboard's 30-day month: stepping by 4 ends on 28, one slot from 29.
    expect([...axisLabelSlots(30, 8)].sort((a, b) => a - b)).toEqual([0, 4, 8, 12, 16, 20, 24, 29]);
  });

  it('labels the 30th day without drawing it over the 29th', () => {
    const labels = Array.from({ length: 30 }, (_, i) => `d${i + 1}`);
    const { container } = renderPage(
      <LineChart
        caption="درآمد"
        labels={labels}
        series={[{ name: 'جاری', values: labels.map((_, i) => i) }]}
      />,
    );
    const drawn = [...container.querySelectorAll('svg.chart > text')].map((n) => n.textContent);
    expect(drawn).toContain('d30');
    expect(drawn).not.toContain('d29');
  });

  it('stacks bars from SVG geometry', () => {
    const { container } = renderPage(
      <BarChart
        caption="سفارش"
        stacked
        labels={['a', 'b']}
        series={[
          { name: 'خرید', values: [2, 3] },
          { name: 'تمدید', values: [1, 1] },
        ]}
      />,
    );
    expect(container.querySelectorAll('rect.bar')).toHaveLength(4);
    expect(noStyle(container)).toBe(0);
  });
});

describe('Disclosure', () => {
  it('is a closed native disclosure that reports its open state', () => {
    const seen: boolean[] = [];
    const { container } = renderPage(
      <Disclosure summary="فنی" size="sm" variant="boxed" onToggle={(open) => seen.push(open)}>
        <p>شناسه</p>
      </Disclosure>,
    );
    const details = container.querySelector('details') as HTMLDetailsElement;
    expect(details.className.split(' ')).toEqual(['disclosure', 'sm', 'boxed']);
    expect(details.open).toBe(false);
    const summary = details.querySelector(':scope > summary') as HTMLElement;
    expect(summary.textContent).toBe('فنی');
    expect(summary.querySelector('svg.disclosure-chevron')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    details.open = true;
    fireEvent(details, new Event('toggle'));
    details.open = false;
    fireEvent(details, new Event('toggle'));
    expect(seen).toEqual([true, false]);
    expect(noStyle(container)).toBe(0);
  });

  /*
   * One look for every closed section: a page that writes its own <details>
   * brings back its own summary colour, marker and spacing — the five
   * variants this pass folded into the kit.
   */
  it('is the only disclosure the pages draw', () => {
    const dir = join(import.meta.dirname, '../../apps/web/src/pages');
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith('.tsx'))
      .filter((name) => /<details[\s>]/.test(readFileSync(join(dir, name), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('quantities and identifiers', () => {
  /*
   * Days, gigabytes, counts, percentages and rates are quantities: they take
   * the body's digit shapes. `Ltr` resets those shapes to Latin, which is
   * right for an id, a host or a username and wrong for «۳۰ روز».
   */
  it('draws a quantity as Num, never as a technical Latin run', () => {
    const { container } = renderPage(
      <>
        <Num value={1250} />
        <Num value="12.5" />
        <Num value="+4.2%" signed />
        <Quantity>
          <Num value={42} /> ms
        </Quantity>
      </>,
    );
    const [count, figure, signed] = [...container.querySelectorAll('span')];
    expect(count?.className).toBe('num');
    expect(count?.textContent).toBe(formatNumber(1250));
    expect(figure?.textContent).toBe('12.5');
    expect(signed?.className.split(' ')).toEqual(['num', 'signed']);
    const group = [...container.querySelectorAll('span.num.signed')].at(-1);
    expect(group?.className).toBe('num signed');
    expect(group?.textContent).toBe('42 ms');
    expect(container.querySelector('.ltr')).toBeNull();
  });

  it('leaves a quantity input in the body digits, and only identifiers in Latin', () => {
    const dir = join(import.meta.dirname, '../../apps/web/src/pages');
    // Typed identifiers, not quantities: a custom emoji id, an inbound id, a card number.
    const IDENTIFIERS = ['appearance-', 'activation-inbound-id', 'pa-card'];
    const offenders: string[] = [];
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.tsx'))) {
      const code = readFileSync(join(dir, name), 'utf8');
      for (const element of code.match(/<input\b(?:[^<>]|=>)*?\/>/gs) ?? []) {
        if (!/inputMode="(numeric|decimal)"/.test(element)) continue;
        if (!/className="[^"]*\bltr\b/.test(element)) continue;
        if (IDENTIFIERS.some((id) => element.includes(id))) continue;
        offenders.push(`${name}: ${/\bid=(\S+)/.exec(element)?.[1] ?? '?'}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is what every page uses for a formatted quantity', () => {
    const dir = join(import.meta.dirname, '../../apps/web/src/pages');
    const quantity =
      /<Ltr[^>]*>\s*(<Num\b|\{\s*(formatNumber|formatTrafficGbText|formatRate|formatBasisPoints|bytesText)\()/;
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith('.tsx'))
      .filter((name) => quantity.test(readFileSync(join(dir, name), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('small controls', () => {
  it('PeriodControl marks the chosen preset and reports the comparison switch', () => {
    const changed = vi.fn<(next: PeriodPreset) => void>();
    const compared = vi.fn<(next: boolean) => void>();
    renderPage(<PeriodControl value="30d" onChange={changed} compare onCompareChange={compared} />);
    expect(
      screen.getByRole('button', { name: t('web.period_30d') }).getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: t('web.period_today') }));
    expect(changed).toHaveBeenCalledWith('today');
    fireEvent.click(screen.getByRole('checkbox', { name: t('web.period_compare') }));
    expect(compared).toHaveBeenCalledWith(false);
  });

  it('FilterChip and Checkbox expose their state', () => {
    renderPage(
      <>
        <FilterChip pressed onClick={() => undefined}>
          فعال
        </FilterChip>
        <Checkbox label="همه" checked={false} onChange={() => undefined} />
      </>,
    );
    expect(screen.getByRole('button', { name: 'فعال' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByRole('checkbox', { name: 'همه' }) as HTMLInputElement).checked).toBe(false);
  });
});

describe('icons', () => {
  it('draws every glyph, and every navigation entry names one', () => {
    const { container } = renderPage(
      <>
        {ICON_NAMES.map((name) => (
          <Icon key={name} name={name} />
        ))}
      </>,
    );
    const paths = container.querySelectorAll('path');
    expect(paths).toHaveLength(ICON_NAMES.length);
    for (const path of paths) expect(path.getAttribute('d')).toMatch(/^[mM]/);
    for (const entry of NAV) expect(ICON_NAMES, entry.id).toContain(entry.icon);
  });
});

describe('CursorPager', () => {
  const noop = () => undefined;

  it("says «نمایش N» by default, the caller's summary when given one, and nothing for null", () => {
    const { container } = renderPage(
      <>
        <CursorPager shown={3} hasPrevious={false} hasNext onPrevious={noop} onNext={noop} />
        <CursorPager
          summary={<>کل: ۹</>}
          hasPrevious
          hasNext={false}
          onPrevious={noop}
          onNext={noop}
        />
        <CursorPager summary={null} hasPrevious hasNext onPrevious={noop} onNext={noop} />
      </>,
    );
    const [counted, totalled, silent] = [...container.querySelectorAll('.pager')];
    expect(counted?.querySelector('.muted.small')?.textContent).toBe(
      `${t('web.showing')} ${formatNumber(3)}`,
    );
    expect(totalled?.querySelector('.muted.small')?.textContent).toBe('کل: ۹');
    expect(silent?.querySelector('.muted.small')).toBeNull();
    // The same two buttons, chevrons and all, whatever the summary says.
    for (const pager of [counted, totalled, silent]) {
      expect(pager?.querySelectorAll('button.btn.sm')).toHaveLength(2);
      expect(pager?.querySelectorAll('button svg[aria-hidden="true"]')).toHaveLength(2);
    }
  });

  /*
   * The reports drew three pagers by hand (no chevrons, their own summary
   * spans); a hand-written .pager is how that comes back.
   */
  it('is the only pager the pages draw', () => {
    const dir = join(import.meta.dirname, '../../apps/web/src/pages');
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith('.tsx'))
      .filter((name) => /className="pager"/.test(readFileSync(join(dir, name), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
