import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ListFilterBar, type ListFilter } from '../../apps/web/src/ui/filter-bar';
import { ListSearchBox } from '../../apps/web/src/ui/list-search';
import { FilterChip, FilterChips } from '../../apps/web/src/ui/kit';
import { t } from '../../apps/web/src/i18n/web.fa';
import { FILTERS_TOGGLE, openFilterPanel } from './ui-helpers';
import { navigate, setQuery, useRoute } from '../../apps/web/src/router';

/** W1.3 — one filter line, a panel of filters, chips for what is on. */

const STATES = ['ALL', 'ACTIVE', 'BLOCKED'] as const;

function Page({ saved = false, onCleared }: { saved?: boolean; onCleared?: () => void }) {
  const [state, setState] = useState<(typeof STATES)[number]>('ALL');
  const [kind, setKind] = useState('');
  const filters: ListFilter[] = [
    {
      key: 'state',
      label: 'وضعیت',
      active: state === 'ALL' ? null : state === 'ACTIVE' ? 'فعال' : 'مسدود',
      onClear: () => setState('ALL'),
      control: (
        <FilterChips label="وضعیت">
          {STATES.map((one) => (
            <FilterChip key={one} pressed={state === one} onClick={() => setState(one)}>
              {one}
            </FilterChip>
          ))}
        </FilterChips>
      ),
    },
    {
      key: 'kind',
      label: 'نوع',
      active: kind === '' ? null : kind,
      onClear: () => setKind(''),
      control: (
        <select aria-label="نوع" value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="">همه</option>
          <option value="x">ایکس</option>
        </select>
      ),
    },
  ];
  return (
    <>
      <ListFilterBar
        filters={filters}
        {...(onCleared === undefined ? {} : { onClearAll: onCleared })}
        {...(saved ? { savedViews: <button type="button">saved</button> } : {})}
      />
      <p data-testid="state">
        {state}/{kind}
      </p>
      <button type="button">outside</button>
    </>
  );
}

const toggle = () => screen.getByRole('button', { name: FILTERS_TOGGLE });

describe('the filter line', () => {
  it('says there is no filter, and mounts no control until the panel opens', () => {
    render(<Page />);
    expect(screen.getByText(t('web.filters_none'))).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'وضعیت' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('applies a change at once and stays open across the re-render', () => {
    render(<Page />);
    const panel = openFilterPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'ACTIVE' }));
    expect(screen.getByTestId('state')).toHaveTextContent('ACTIVE/');
    expect(screen.getByRole('dialog', { name: t('web.filters') })).toBeInTheDocument();
    fireEvent.change(within(panel).getByRole('combobox', { name: 'نوع' }), {
      target: { value: 'x' },
    });
    expect(screen.getByTestId('state')).toHaveTextContent('ACTIVE/x');
    expect(screen.getByRole('dialog', { name: t('web.filters') })).toBeInTheDocument();
    // One row per filter, its label beside it.
    expect(within(panel).getByText('وضعیت', { selector: '.lfb-lbl' })).toBeInTheDocument();
  });

  it('closes with «نمایش نتیجه», ×, Escape and a click outside; focus goes back to «فیلترها»', () => {
    render(<Page />);
    openFilterPanel();
    fireEvent.click(screen.getByRole('button', { name: t('web.filters_show_result') }));
    expect(screen.queryByRole('dialog')).toBeNull();

    const panel = openFilterPanel();
    fireEvent.click(within(panel).getByRole('button', { name: t('web.close') }));
    expect(screen.queryByRole('dialog')).toBeNull();

    openFilterPanel();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(toggle());

    openFilterPanel();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('puts focus on the first filter when it opens', () => {
    render(<Page />);
    const panel = openFilterPanel();
    expect(document.activeElement).toBe(within(panel).getByRole('button', { name: 'ALL' }));
  });

  it('draws the active filters as chips with ×, a count, and «پاک کردن همه» from two', () => {
    render(<Page />);
    const panel = openFilterPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'BLOCKED' }));
    fireEvent.click(screen.getByRole('button', { name: t('web.filters_show_result') }));
    expect(screen.getByText('مسدود')).toBeInTheDocument();
    expect(toggle()).toHaveTextContent('1');
    expect(screen.queryByText(t('web.filters_clear_all'))).toBeNull();
    expect(screen.queryByText(t('web.filters_none'))).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `${t('web.filters_remove')} وضعیت` }));
    expect(screen.getByTestId('state')).toHaveTextContent('ALL/');

    const again = openFilterPanel();
    fireEvent.click(within(again).getByRole('button', { name: 'ACTIVE' }));
    fireEvent.change(within(again).getByRole('combobox', { name: 'نوع' }), {
      target: { value: 'x' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.filters_show_result') }));
    fireEvent.click(screen.getByRole('button', { name: t('web.filters_clear_all') }));
    expect(screen.getByTestId('state')).toHaveTextContent('ALL/');
  });

  it('uses the page’s own «پاک کردن همه» when it gives one', () => {
    let cleared = 0;
    render(<Page onCleared={() => (cleared += 1)} />);
    const panel = openFilterPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'ACTIVE' }));
    fireEvent.change(within(panel).getByRole('combobox', { name: 'نوع' }), {
      target: { value: 'x' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: t('web.filters_clear_all') }));
    expect(cleared).toBe(1);
  });

  /*
   * PR #285 review, A1. Without the page's own «پاک کردن همه», the bar calls each filter's
   * `onClear` — and each URL filter's `setQuery` builds on the `route.query` captured at
   * render. Called in turn they overwrote one another and only the LAST removal survived.
   */
  it('without onClearAll, clears every URL-backed filter in one navigation', () => {
    navigate('/things?a=1&b=2&keep=yes', { replace: true });
    function UrlPage() {
      const route = useRoute();
      const filters: ListFilter[] = ['a', 'b'].map((key) => ({
        key,
        label: key === 'a' ? 'الف' : 'ب',
        active: route.query.get(key),
        onClear: () => setQuery(route, key, null),
        control: <span />,
      }));
      return <ListFilterBar filters={filters} />;
    }
    render(<UrlPage />);
    fireEvent.click(screen.getByRole('button', { name: t('web.filters_clear_all') }));
    const query = new URLSearchParams(window.location.search);
    expect(query.get('a'), 'the first removal was overwritten by the second').toBeNull();
    expect(query.get('b')).toBeNull();
    // Only the filters: an unrelated parameter is kept.
    expect(query.get('keep')).toBe('yes');
    expect(window.location.pathname).toBe('/things');
    expect(screen.getByText(t('web.filters_none'))).toBeInTheDocument();
  });

  it('draws the saved-filters slot at the end', () => {
    const { container } = render(<Page saved />);
    expect(container.querySelector('.list-filter-bar')).toHaveClass('with-saved');
    expect(container.querySelector('.lfb-saved')).toContainElement(
      screen.getByRole('button', { name: 'saved' }),
    );
  });
});

describe('the slim search', () => {
  const route = { path: '/users', query: new URLSearchParams() };

  it('keeps its label as the name, and moves the hint into the placeholder and the title', () => {
    render(<ListSearchBox route={route} id="s" hint="نام یا شناسه" slim />);
    const input = screen.getByLabelText(t('web.list_search_label'));
    expect(input).toHaveAttribute('placeholder', 'نام یا شناسه');
    expect(input).toHaveAttribute('title', 'نام یا شناسه');
    expect(screen.queryByText('نام یا شناسه')).toBeNull();
    expect(input.closest('form')).toHaveClass('slim');
  });

  it('is drawn exactly as before without slim', () => {
    render(<ListSearchBox route={route} id="s" hint="نام یا شناسه" />);
    const input = screen.getByLabelText(t('web.list_search_label'));
    expect(input).not.toHaveAttribute('placeholder');
    expect(screen.getByText('نام یا شناسه')).toBeInTheDocument();
    expect(input.closest('form')).not.toHaveClass('slim');
    expect(input.closest('form')?.querySelector('.ca-search-main')).toBeNull();
  });
});

describe('the saved-filters width rule', () => {
  it('shares the search buttons’ column with a 170px floor, measured by CSS alone', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(resolve(here, '../../apps/web/src/styles/ui.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const rule = (selector: string) => {
      const at = css.indexOf(`${selector} {`);
      if (at < 0) throw new Error(`no rule for ${selector}`);
      return css.slice(at, css.indexOf('}', at));
    };
    expect(rule('.list-filter-bar.with-saved')).toMatch(
      /grid-template-columns:\s*minmax\(0, 1fr\) auto/,
    );
    expect(rule('.lfb-saved')).toMatch(/grid-column:\s*2/);
    expect(rule('.lfb-saved')).toMatch(/width:\s*170px/);
    expect(rule('.lfb-saved')).toMatch(/min-width:\s*100%/);
    expect(
      rule('.list-filter-bar.with-saved .lfb-search > .ca-search.slim > .ca-search-actions'),
    ).toMatch(/grid-column:\s*2/);
  });
});
