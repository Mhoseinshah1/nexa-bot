import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import {
  SAVED_VIEWS_MAX_PER_PAGE,
  addView,
  forgetSavedViewsMemory,
  moveView,
  normalizeViewState,
  removeView,
  renameView,
  restoreView,
  routeViewRegistration,
  savedViewsStorageKey,
  setDefaultView,
  validateViewName,
  type SavedView,
  type SavedViewsRegistration,
  type ViewState,
} from '../../apps/web/src/ui/saved-views';
import { SavedViewsMenu, SavedViewsScope } from '../../apps/web/src/ui/saved-views-menu';
import { ToastProvider } from '../../apps/web/src/ui/kit';
import { t } from '../../apps/web/src/i18n/web.fa';

/** W1.4 — saved filters: local, per admin and installation, and the rules of a name. */

const view = (id: string, name: string, isDefault = false): SavedView => ({
  id,
  name,
  state: { status: id },
  isDefault,
});

beforeEach(() => {
  window.localStorage.clear();
  forgetSavedViewsMemory();
});
afterEach(() => {
  window.localStorage.clear();
  forgetSavedViewsMemory();
});

describe('the rules', () => {
  it('wants a name of two characters or more, unique on the page ignoring case', () => {
    const views = [view('a', 'Germany')];
    expect(validateViewName(views, ' x ')).toBe('too_short');
    expect(validateViewName(views, 'germany ')).toBe('taken');
    expect(validateViewName(views, 'Germany', 'a')).toBeNull();
    expect(validateViewName(views, 'آلمان')).toBeNull();
  });

  it('keeps at most twelve views a page', () => {
    let views: readonly SavedView[] = [];
    for (let i = 0; i < SAVED_VIEWS_MAX_PER_PAGE; i += 1) {
      const result = addView(views, { name: `view ${i}`, state: {}, isDefault: false });
      if ('error' in result) throw new Error(result.error);
      views = result.views;
    }
    expect(addView(views, { name: 'one more', state: {}, isDefault: false })).toEqual({
      error: 'full',
    });
  });

  it('has one default at most', () => {
    const result = addView([view('a', 'aa', true)], { name: 'bb', state: {}, isDefault: true });
    if ('error' in result) throw new Error(result.error);
    expect(result.views.map((one) => one.isDefault)).toEqual([false, true]);
    expect(setDefaultView(result.views, null).some((one) => one.isDefault)).toBe(false);
  });

  it('renames by the same rules, moves, and puts a deleted view back where it was', () => {
    const views = [view('a', 'aa'), view('b', 'bb'), view('c', 'cc')];
    expect(renameView(views, 'a', 'bb')).toEqual({ error: 'taken' });
    expect(moveView(views, 'c', -1).map((one) => one.id)).toEqual(['a', 'c', 'b']);
    expect(moveView(views, 'a', -1)).toBe(views);
    const { views: left, removed } = removeView(views, 'b');
    expect(left.map((one) => one.id)).toEqual(['a', 'c']);
    if (removed === null) throw new Error('nothing removed');
    expect(restoreView(left, removed).map((one) => one.id)).toEqual(['a', 'b', 'c']);
  });

  it('stores only what differs from the empty state', () => {
    expect(
      normalizeViewState({ q: '', status: 'ALL' }, { q: 'x', status: 'ALL', other: 'y' }),
    ).toEqual({
      q: 'x',
    });
  });
});

const EMPTY: ViewState = { status: '', q: '' };

function Page({ withScope = true }: { withScope?: boolean }) {
  const [state, setState] = useState<ViewState>(EMPTY);
  const registration: SavedViewsRegistration = {
    page: 'users',
    empty: EMPTY,
    get: () => state,
    set: (next) => setState({ ...next }),
    presets: [{ id: 'blocked', name: 'web.saved_views_presets', state: { status: 'BLOCKED' } }],
  };
  const menu = <SavedViewsMenu registration={registration} />;
  return (
    <ToastProvider>
      {withScope ? (
        <SavedViewsScope.Provider value={{ scope: 'admin.example', adminId: 'adm-1' }}>
          {menu}
        </SavedViewsScope.Provider>
      ) : (
        menu
      )}
      <button type="button" onClick={() => setState({ ...state, status: 'ACTIVE' })}>
        active
      </button>
      <button type="button" onClick={() => setState({ ...state, q: 'ali' })}>
        search
      </button>
      <button type="button" onClick={() => setState(EMPTY)}>
        reset
      </button>
      <output data-testid="state">{JSON.stringify(state)}</output>
    </ToastProvider>
  );
}

const menuButton = () => screen.getByRole('button', { name: new RegExp(t('web.saved_views')) });
const openMenu = () => {
  const button = document.querySelector<HTMLElement>('.saved-views-btn');
  if (button === null) throw new Error('no saved-views button');
  if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button);
  return screen.getByRole('dialog', { name: t('web.saved_views') });
};
const KEY = savedViewsStorageKey('admin.example', 'adm-1');

function saveCurrent(name: string, makeDefault = false) {
  const pop = openMenu();
  fireEvent.click(within(pop).getByRole('button', { name: t('web.saved_views_save') }));
  const dialog = screen.getByRole('dialog', { name: t('web.saved_views_save_title') });
  fireEvent.change(within(dialog).getByLabelText(t('web.saved_views_name')), {
    target: { value: name },
  });
  if (makeDefault)
    fireEvent.click(within(dialog).getByLabelText(t('web.saved_views_make_default')));
  fireEvent.click(within(dialog).getByRole('button', { name: t('web.saved_views_submit') }));
}

describe('the menu', () => {
  it('cannot save until something is filtered', () => {
    render(<Page />);
    const pop = openMenu();
    expect(within(pop).getByRole('button', { name: t('web.saved_views_save') })).toBeDisabled();
    expect(within(pop).getByText(t('web.saved_views_none'))).toBeInTheDocument();
  });

  it('saves the filters in force under a valid name, in storage under the admin’s key', () => {
    render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: 'active' }));
    saveCurrent('x');
    expect(screen.getByRole('alert')).toHaveTextContent(t('web.saved_views_err_short'));
    fireEvent.change(screen.getByLabelText(t('web.saved_views_name')), {
      target: { value: 'فعال‌ها' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.saved_views_submit') }));
    expect(screen.queryByRole('dialog', { name: t('web.saved_views_save_title') })).toBeNull();
    // The button now reads the view that matches the filters in force.
    expect(screen.getByRole('button', { name: /فعال‌ها/u })).toBeInTheDocument();
    const stored = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Record<
      string,
      SavedView[]
    >;
    expect(stored['users']?.[0]).toMatchObject({ name: 'فعال‌ها', state: { status: 'ACTIVE' } });
  });

  it('refuses a name already used on the page', () => {
    render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: 'active' }));
    saveCurrent('Active');
    fireEvent.click(screen.getByRole('button', { name: 'search' }));
    saveCurrent('active');
    expect(screen.getByRole('alert')).toHaveTextContent(t('web.saved_views_err_taken'));
  });

  it('applies a saved view and a preset, and clears an applied one', () => {
    render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: 'active' }));
    saveCurrent('Active');
    fireEvent.click(screen.getByRole('button', { name: 'reset' }));
    let pop = openMenu();
    fireEvent.click(within(pop).getByRole('button', { name: 'Active' }));
    expect(screen.getByTestId('state')).toHaveTextContent('"status":"ACTIVE"');
    pop = openMenu();
    fireEvent.click(within(pop).getByRole('button', { name: t('web.saved_views_presets') }));
    expect(screen.getByTestId('state')).toHaveTextContent('"status":"BLOCKED"');
    pop = openMenu();
    const preset = within(pop).getByRole('button', { name: t('web.saved_views_presets') });
    expect(preset).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(preset);
    expect(screen.getByTestId('state')).toHaveTextContent('"status":""');
  });

  it('offers «به‌روزرسانی» after an applied view is changed', () => {
    render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: 'active' }));
    saveCurrent('Active');
    fireEvent.click(screen.getByRole('button', { name: 'search' }));
    const pop = openMenu();
    const update = within(pop).getByRole('button', {
      name: t('web.saved_views_update').replace('{name}', 'Active'),
    });
    fireEvent.click(update);
    const stored = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Record<
      string,
      SavedView[]
    >;
    expect(stored['users']?.[0]?.state).toEqual({ q: 'ali', status: 'ACTIVE' });
  });

  it('applies the default view when the page opens with nothing filtered', () => {
    const first = render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: 'active' }));
    saveCurrent('Active', true);
    first.unmount();
    render(<Page />);
    expect(screen.getByTestId('state')).toHaveTextContent('"status":"ACTIVE"');
  });

  it('manages: rename, reorder, and delete with undo', () => {
    render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: 'active' }));
    saveCurrent('Active');
    fireEvent.click(screen.getByRole('button', { name: 'search' }));
    saveCurrent('Search');
    const pop = openMenu();
    fireEvent.click(within(pop).getByRole('button', { name: t('web.saved_views_manage') }));
    const drawer = screen.getByRole('dialog', { name: t('web.saved_views_manage_title') });
    const names = () =>
      within(drawer)
        .getAllByLabelText(t('web.saved_views_name'))
        .map((input) => (input as HTMLInputElement).value);
    expect(names()).toEqual(['Active', 'Search']);
    fireEvent.click(
      within(drawer).getAllByRole('button', { name: t('web.saved_views_down') })[0] as HTMLElement,
    );
    expect(names()).toEqual(['Search', 'Active']);
    const field = within(drawer).getAllByLabelText(t('web.saved_views_name'))[1] as HTMLElement;
    fireEvent.change(field, { target: { value: 'Search' } });
    fireEvent.blur(field);
    expect(within(drawer).getByRole('alert')).toHaveTextContent(t('web.saved_views_err_taken'));
    fireEvent.change(field, { target: { value: 'Busy' } });
    fireEvent.blur(field);
    expect(names()).toEqual(['Search', 'Busy']);
    fireEvent.click(
      within(drawer).getAllByRole('button', {
        name: t('web.saved_views_delete'),
      })[0] as HTMLElement,
    );
    expect(names()).toEqual(['Busy']);
    fireEvent.click(within(drawer).getByRole('button', { name: t('web.saved_views_undo') }));
    expect(names()).toEqual(['Search', 'Busy']);
  });

  it('works when storage refuses, keeping the views in memory', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: 'active' }));
    saveCurrent('Active');
    expect(screen.getByRole('button', { name: /Active/u })).toBeInTheDocument();
  });

  it('writes nothing to storage without a scope', () => {
    render(<Page withScope={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'active' }));
    saveCurrent('Active');
    expect(screen.getByRole('button', { name: /Active/u })).toBeInTheDocument();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('draws no count, because no list has a server total', () => {
    render(<Page />);
    expect(menuButton()).toHaveTextContent(t('web.saved_views'));
    expect(menuButton().querySelector('.lfb-n')).toBeNull();
  });
});

describe('routeViewRegistration', () => {
  it('reads the keys from the route and applies a view as one navigation without a cursor', () => {
    window.history.replaceState(null, '', '/users?status=ACTIVE&cursor=abc&other=1');
    const route = {
      path: '/users',
      query: new URLSearchParams('status=ACTIVE&cursor=abc&other=1'),
    };
    const registration = routeViewRegistration(route, 'users', ['status', 'q']);
    expect(registration.get()).toEqual({ status: 'ACTIVE', q: '' });
    registration.set({ status: '', q: 'ali' });
    expect(window.location.search).toBe('?other=1&q=ali');
  });
});
