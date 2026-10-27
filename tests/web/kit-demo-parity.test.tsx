import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import {
  Badge,
  Banner,
  CountedPager,
  CursorPager,
  DataTable,
  IdText,
  RefLink,
  Stat,
  StatCard,
  serverTotal,
  type Column,
} from '../../apps/web/src/ui/kit';
import { ListFilterBar } from '../../apps/web/src/ui/filter-bar';
import { t } from '../../apps/web/src/i18n/web.fa';
import {
  formatDate,
  formatNumber,
  formatTimestamp,
  formatTimestampNumeric,
} from '../../apps/web/src/format';
import { renderPage } from './harness';

/**
 * The shared-kit half of the demo-parity pass (DIFFS.md X2, X5, X6, X7, X8, X9, X10):
 * each rule once, in the component every page inherits it from.
 */

const KIT_CSS = readFileSync(
  join(import.meta.dirname, '../../apps/web/src/styles/kit.css'),
  'utf8',
);
const UI_CSS = readFileSync(join(import.meta.dirname, '../../apps/web/src/styles/ui.css'), 'utf8');

/** The declarations of the FIRST rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return css.slice(at, css.indexOf('}', at));
}

describe('X2 — CursorPager names its directions by the list order', () => {
  const button = (name: string) => screen.getByRole('button', { name });

  it('newest-first: «تازه‌تر» goes back, «قدیمی‌تر» goes on, only the available one is active', () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    renderPage(
      <CursorPager
        order="newest-first"
        shown={10}
        hasPrevious={false}
        hasNext
        onPrevious={onPrevious}
        onNext={onNext}
      />,
    );
    expect(button(t('web.page_newer'))).toBeDisabled();
    expect(button(t('web.page_older'))).toBeEnabled();
    fireEvent.click(button(t('web.page_older')));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrevious).not.toHaveBeenCalled();
    // No «قبلی / بعدی» on a time-ordered list.
    expect(screen.queryByRole('button', { name: t('web.page_next') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.page_previous') })).toBeNull();
  });

  it('oldest-first binds the same labels the other way round, «تازه‌تر» still first', () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const { container } = renderPage(
      <CursorPager
        order="oldest-first"
        hasPrevious
        hasNext={false}
        onPrevious={onPrevious}
        onNext={onNext}
      />,
    );
    // The next page of an ascending list is NEWER — and there is none here.
    expect(button(t('web.page_newer'))).toBeDisabled();
    expect(button(t('web.page_older'))).toBeEnabled();
    fireEvent.click(button(t('web.page_older')));
    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(onNext).not.toHaveBeenCalled();
    const labels = [...container.querySelectorAll('.pager button')].map((b) => b.textContent);
    expect(labels).toEqual([t('web.page_newer'), t('web.page_older')]);
  });

  it('a list that is not in time order keeps «قبلی / بعدی»', () => {
    renderPage(
      <CursorPager
        order="sequence"
        hasPrevious
        hasNext={false}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
      />,
    );
    expect(button(t('web.page_previous'))).toBeEnabled();
    expect(button(t('web.page_next'))).toBeDisabled();
    expect(screen.queryByRole('button', { name: t('web.page_newer') })).toBeNull();
  });

  it('cannot be drawn without saying the order', () => {
    // `order` is required: a default would label an ascending list backwards.
    const props = { hasPrevious: false, hasNext: true, onPrevious: vi.fn(), onNext: vi.fn() };
    // @ts-expect-error — no `order`.
    const element = <CursorPager {...props} />;
    expect(element).toBeTruthy();
  });
});

describe('X2 — CountedPager counts only a server total', () => {
  it('draws «۱۱–۲۰ از ۲۵ · صفحهٔ ۲ از ۳» with قبلی / بعدی and turns pages', () => {
    const onPage = vi.fn();
    renderPage(<CountedPager page={2} pageSize={10} total={serverTotal(25)} onPage={onPage} />);
    const info = screen.getByTestId('counted-pager-info');
    expect(info.textContent).toBe(
      `${formatNumber(11)}–${formatNumber(20)} ${t('web.page_range_of')} ${formatNumber(25)} · ` +
        `${t('web.page_of')} ${formatNumber(2)} ${t('web.page_range_of')} ${formatNumber(3)}`,
    );
    fireEvent.click(screen.getByRole('button', { name: t('web.page_next_aria') }));
    expect(onPage).toHaveBeenLastCalledWith(3);
    fireEvent.click(screen.getByRole('button', { name: t('web.page_previous_aria') }));
    expect(onPage).toHaveBeenLastCalledWith(1);
  });

  it('disables the direction past either end', () => {
    renderPage(<CountedPager page={1} pageSize={10} total={serverTotal(7)} onPage={vi.fn()} />);
    expect(screen.getByRole('button', { name: t('web.page_previous_aria') })).toBeDisabled();
    expect(screen.getByRole('button', { name: t('web.page_next_aria') })).toBeDisabled();
  });

  it('cannot render without a server total', () => {
    // A plain number — a client count such as `rows.length` — is not a server total.
    // @ts-expect-error — `total` must come from `serverTotal(response field)`.
    const counted = <CountedPager page={1} pageSize={10} total={12} onPage={vi.fn()} />;
    // @ts-expect-error — and it cannot be left out.
    const missing = <CountedPager page={1} pageSize={10} onPage={vi.fn()} />;
    const { container } = renderPage(
      <>
        {missing}
        <CountedPager
          page={1}
          pageSize={10}
          total={undefined as unknown as ReturnType<typeof serverTotal>}
          onPage={vi.fn()}
        />
        <CountedPager page={1} pageSize={10} total={serverTotal(0)} onPage={vi.fn()} />
      </>,
    );
    expect(counted).toBeTruthy();
    // Nothing is drawn: no figure, no «صفحهٔ ۱ از ۱» invented over a missing total.
    expect(container.querySelector('.pager')).toBeNull();
  });
});

describe('X5 — a callout is outlined in its tone, without a sign', () => {
  it('draws no icon on any tone, as every callout in the demo; an error still alerts', () => {
    const { container } = renderPage(
      <>
        <Banner tone="info" title="عنوان">
          متن
        </Banner>
        <Banner tone="info">متن</Banner>
        <Banner tone="neutral">متن</Banner>
        <Banner tone="warn">هشدار</Banner>
        <Banner tone="warn">هشدار</Banner>
        <Banner tone="danger">خطا</Banner>
        <Banner tone="ok">انجام شد</Banner>
      </>,
    );
    const banners = [...container.querySelectorAll('.banner')];
    expect(banners).toHaveLength(7);
    for (const banner of banners) expect(banner.querySelector('svg')).toBeNull();
    expect(banners[5]).toHaveAttribute('role', 'alert');
  });

  it('is outlined in the accent over its soft fill', () => {
    const css = rule(KIT_CSS, '.banner.info');
    expect(css).toContain('border-color: var(--accent)');
    expect(css).toContain('background: var(--accent-soft)');
  });

  it("outlines a warning and an error in their full tone, as the demo's .note.warn/.danger", () => {
    expect(rule(KIT_CSS, '.banner.warn')).toContain('border-color: var(--warn)');
    expect(rule(KIT_CSS, '.banner.danger')).toContain('border-color: var(--danger)');
  });
});

describe('X6 — stat strips are neutral bordered cards', () => {
  it('draws no amber border on a «warn» card and gives a bare Stat the card frame', () => {
    expect(KIT_CSS).not.toMatch(/\.stat\.warnish\s*\{/);
    expect(rule(KIT_CSS, '.stat-grid')).toContain('repeat(auto-fit, minmax(170px, 1fr))');
    expect(rule(KIT_CSS, '.stat-grid > .stat:not(.card)')).toContain(
      'border: 1px solid var(--line)',
    );
  });

  it('keeps the red outline for a failure only', () => {
    const { container } = renderPage(
      <div className="stat-grid">
        <StatCard label="الف" value="۱" tone="alert" />
        <StatCard label="ب" value="۲" tone="warn" />
        <Stat label="ج" value="۳" />
      </div>,
    );
    const [alert, warn, bare] = [...container.querySelectorAll('.stat-grid > .stat')];
    expect(alert).toHaveClass('alert');
    expect(warn).not.toHaveClass('alert');
    expect(bare).not.toHaveClass('card');
  });
});

describe('X7 — linkable identifiers', () => {
  it('RefLink is an underlined link that navigates in place; mono isolates an id', () => {
    renderPage(
      <>
        <RefLink href="/orders/abc">سفارش</RefLink>
        <RefLink href="/payments/p1" mono>
          PAY-1
        </RefLink>
      </>,
    );
    const name = screen.getByRole('link', { name: 'سفارش' });
    expect(name).toHaveClass('lk');
    expect(name).not.toHaveClass('mono');
    expect(name).toHaveAttribute('href', '/orders/abc');
    const id = screen.getByRole('link', { name: 'PAY-1' });
    expect(id).toHaveClass('lk', 'ltr', 'mono');
    fireEvent.click(id);
    expect(window.location.pathname).toBe('/payments/p1');
    for (const selector of ['.lk', '.tbl td a:not(.btn)']) {
      expect(KIT_CSS).toContain(selector);
    }
    // R11 (S6): the demo marks a link with a faint DASHED rule, not a text underline.
    expect(KIT_CSS).toMatch(
      /\.lk,\n\.tbl td a:not\(\.btn\),[^{]*\{[^}]*text-decoration: none;[^}]*border-bottom: 1px dashed/,
    );
  });

  it('IdText shows the id in monospace with its full value as the title and no copy button', () => {
    const uuid = '0199c981-8331-7a0f-b617-3f2de0673e81';
    const { container } = renderPage(<IdText value={uuid} display={uuid.slice(0, 8)} />);
    const id = screen.getByText('0199c981');
    expect(id).toHaveClass('ltr', 'mono');
    expect(id).toHaveAttribute('title', uuid);
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('X8 (owner decision 2026-10-19: the order follows the demo page by page)', () => {
  it('by default draws «فیلترها» and the saved filters first, then the search', () => {
    const { container } = renderPage(
      <ListFilterBar
        filters={[]}
        search={<input aria-label="جست‌وجو" />}
        savedViews={<button type="button">saved</button>}
      />,
    );
    const bar = container.querySelector('.list-filter-bar');
    const order = [...(bar?.children ?? [])].map((child) => child.className);
    expect(order).toEqual(['lfb-line', 'lfb-saved', 'lfb-search']);
    // The keyboard meets them in the same order.
    const reachable = [...(bar?.querySelectorAll('button, input') ?? [])].map(
      (one) => one.getAttribute('aria-label') ?? one.textContent,
    );
    expect(reachable.indexOf('saved')).toBeLessThan(reachable.indexOf('جست‌وجو'));
  });

  it('with first="search" draws the search first, then «فیلترها» and the saved filters', () => {
    const { container } = renderPage(
      <ListFilterBar
        first="search"
        filters={[]}
        search={<input aria-label="جست‌وجو" />}
        savedViews={<button type="button">saved</button>}
      />,
    );
    const bar = container.querySelector('.list-filter-bar');
    const order = [...(bar?.children ?? [])].map((child) => child.className);
    expect(order).toEqual(['lfb-search', 'lfb-line', 'lfb-saved']);
    const reachable = [...(bar?.querySelectorAll('button, input') ?? [])].map(
      (one) => one.getAttribute('aria-label') ?? one.textContent,
    );
    expect(reachable.indexOf('جست‌وجو')).toBeLessThan(reachable.indexOf('saved'));
  });
});

describe('X8 — which pages put the search first (the demo decides)', () => {
  it.each(['orders', 'services', 'payments', 'users'])('%s passes first="search"', (page) => {
    const source = readFileSync(join(process.cwd(), 'apps/web/src/pages', `${page}.tsx`), 'utf8');
    expect(source).toMatch(/<ListFilterBar\s+first="search"/);
  });
});

describe('X9 — a wide table fits its card', () => {
  interface Row {
    id: string;
    at: string;
    note: string;
  }
  const columns: Column<Row>[] = [
    { key: 'id', header: 'شناسه', render: (row) => row.id },
    { key: 'at', header: 'زمان ثبت', wrap: 'tight', render: (row) => row.at },
    { key: 'note', header: 'یادداشت', wrap: true, render: (row) => row.note },
  ];

  it('marks a tight column, a wrapping column, and lets headers break between words', () => {
    const { container } = renderPage(
      <DataTable
        caption="جدول"
        columns={columns}
        rows={[{ id: '1', at: '۱۵ شهریور ۱۴۰۵، ۷:۵۸', note: 'متن' }]}
        rowKey={(row) => row.id}
      />,
    );
    const [id, at, note] = [...container.querySelectorAll('tbody td')];
    expect(id).not.toHaveClass('wrap');
    expect(at).toHaveClass('wrap', 'tight');
    expect(note).toHaveClass('wrap');
    expect(note).not.toHaveClass('tight');
    expect(rule(KIT_CSS, '.tbl th')).toContain('white-space: normal');
    expect(KIT_CSS).toMatch(/\.tbl td\.wrap\.tight,\n\.tbl th\.wrap\.tight \{\s*min-width: 0;/);
    expect(KIT_CSS).toMatch(/\.tbl td\.wrap \.badge \{[^}]*white-space: normal/);
  });

  it('keeps a row detail usable in a stacked (phone card) table', () => {
    const { container } = renderPage(
      <DataTable
        caption="جدول"
        columns={columns}
        rows={[{ id: '1', at: 'الف', note: 'یک' }]}
        rowKey={(row) => row.id}
        stack
        detail={{ label: 'جزئیات', render: (row) => `جزئیات ${row.id}` }}
      />,
    );
    expect(container.querySelector('.tbl-wrap')).toHaveClass('stack');
    // The toggle cell is not a labelled line; the column cells are.
    const toggleCell = container.querySelector('td.tbl-toggle');
    expect(toggleCell).not.toHaveAttribute('data-label');
    expect(container.querySelector('tbody td')).toHaveAttribute('data-label', 'شناسه');
    fireEvent.click(screen.getByRole('button', { name: 'جزئیات' }));
    expect(container.querySelector('tr.tbl-detail td')).not.toHaveAttribute('data-label');
    // On a phone the toggle sits in the card's corner and the detail line carries no label.
    expect(KIT_CSS).toMatch(/\.tbl-wrap\.stack \.tbl td\.tbl-toggle \{\s*position: absolute;/);
    expect(KIT_CSS).toMatch(
      /\.tbl-wrap\.stack \.tbl td\.tbl-toggle::before,\n\s*\.tbl-wrap\.stack \.tbl tr\.tbl-detail > td::before \{\s*content: none;/,
    );
  });

  it('opens a row detail on one full-width line under its row, and closes it again', () => {
    const { container } = renderPage(
      <DataTable
        caption="جدول"
        columns={columns}
        rows={[
          { id: '1', at: 'الف', note: 'یک' },
          { id: '2', at: 'ب', note: 'دو' },
        ]}
        rowKey={(row) => row.id}
        detail={{ label: 'جزئیات', render: (row) => `جزئیات ${row.id}` }}
      />,
    );
    // Nothing is drawn until asked, and each row has its own toggle.
    expect(container.querySelector('tr.tbl-detail')).toBeNull();
    const toggles = screen.getAllByRole('button', { name: 'جزئیات' });
    expect(toggles).toHaveLength(2);
    expect(toggles[1]).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggles[1] as HTMLElement);
    const detail = container.querySelector('tr.tbl-detail');
    expect(detail?.textContent).toBe('جزئیات 2');
    // It spans every column plus the toggle's, and sits right under ITS row.
    expect(detail?.querySelector('td')).toHaveAttribute('colspan', String(columns.length + 1));
    expect(detail?.previousElementSibling).toHaveClass('expanded');
    expect(detail?.previousElementSibling?.textContent).toContain('دو');
    expect(toggles[1]).toHaveAttribute('aria-expanded', 'true');
    expect(toggles[1]).toHaveAttribute('aria-controls', detail?.id);

    fireEvent.click(toggles[1] as HTMLElement);
    expect(container.querySelector('tr.tbl-detail')).toBeNull();
  });
});

describe('X10 — filled states, outlined kinds', () => {
  it('outlines a kind pill in its own colour and fills a state pill', () => {
    const { container } = renderPage(
      <>
        <Badge tone="ok" dot>
          فعال
        </Badge>
        <Badge tone="info" outline>
          حجم
        </Badge>
      </>,
    );
    const [state, kind] = [...container.querySelectorAll('.badge')];
    expect(state).not.toHaveClass('outline');
    expect(kind).toHaveClass('outline');
    const css = rule(KIT_CSS, '.badge.outline');
    expect(css).toContain('background: transparent');
    expect(css).toContain('border: 1px solid currentColor');
  });
});

it('keeps the filter bar stylesheet in place for the reordered row', () => {
  // The search row spans the grid below «فیلترها» and the saved filters.
  expect(rule(UI_CSS, '.lfb-search')).toContain('grid-column: 1 / -1');
});

describe('card heads — no rule under the title, as the demo’s .ch', () => {
  it('draws no border under a card head, and the body under it starts at its edge', () => {
    expect(rule(KIT_CSS, '.card-head')).not.toMatch(/border-bottom/);
    expect(KIT_CSS).not.toMatch(/\.card-head\s*\{[^}]*border-bottom/);
    expect(rule(KIT_CSS, '.card-head + .card-body')).toContain('padding-top: 0');
  });
});

describe('page head — the action takes the full line on a phone, as the demo', () => {
  it('stretches a header button across the line below 820px, not an icon button', () => {
    const at = KIT_CSS.indexOf('@media (max-width: 820px) {\n  .page-head h1');
    expect(at).toBeGreaterThan(-1);
    const block = KIT_CSS.slice(at, KIT_CSS.indexOf('\n}\n', at));
    expect(block).toMatch(/\.page-head \.actions > \.btn:not\(\.icon\) \{\s*flex: 1;/);
    expect(block).toMatch(/\.page-head \.actions \{\s*width: 100%;/);
  });
});

describe('tab strips — wrap at every width, as the demo’s .tabs', () => {
  it('wraps a horizontal rail onto further rows on a phone too, without a sideways scroll', () => {
    const css = rule(KIT_CSS, '.tabs:not(.vertical)');
    expect(css).toContain('flex-wrap: wrap');
    expect(css).toContain('overflow-x: visible');
    expect(KIT_CSS).not.toMatch(/@media \(min-width: 821px\) \{\s*\.tabs:not\(\.vertical\)/);
  });
});

describe('timestamps — the demo’s numeric shape everywhere, decided in one place', () => {
  it('formats every date-time and date as numbers, never a month name', () => {
    const at = '2026-10-06T16:00:00.000Z';
    expect(formatTimestamp(at)).toBe(formatTimestampNumeric(at));
    expect(formatTimestamp(at)).toMatch(/^\u2066\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}\u2069$/);
    expect(formatDate(at)).toMatch(/^\u2066\d{4}\/\d{2}\/\d{2}\u2069$/);
    expect(formatTimestamp('not a date')).toBe('not a date');
  });
});

it('draws the list search at the full control height, as the demo’s 32px search', () => {
  expect(rule(UI_CSS, '.ca-search.slim .field input')).toContain('height: var(--ctl-h)');
});

describe('R2 — the slim information strip', () => {
  it('draws a leading icon and the slim class only when asked', () => {
    const { container } = renderPage(
      <>
        <Banner tone="info" slim>
          hint
        </Banner>
        <Banner tone="info">plain</Banner>
      </>,
    );
    const [slim, plain] = [...container.querySelectorAll('.banner')];
    expect(slim).toHaveClass('slim');
    expect(slim?.querySelector('svg')).not.toBeNull();
    expect(plain).not.toHaveClass('slim');
    expect(plain?.querySelector('svg')).toBeNull();
  });
});
