import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { PERMISSION_KEYS, type PermissionKey } from '@nexa/contracts';
import { App, NAV, ROUTE_PATTERNS, resolve } from '../../apps/web/src/app';
import { t } from '../../apps/web/src/i18n/web.fa';
import { NAV_STANDALONE_GROUP } from '../../apps/web/src/nav';
import { pageTrail } from '../../apps/web/src/page-trail';
import { navigate } from '../../apps/web/src/router';
import { IncidentBanner } from '../../apps/web/src/pages/incidents';
import { PageHead, PageTrailContext } from '../../apps/web/src/ui/kit';
import { ListFreshness } from '../../apps/web/src/ui/list-search';
import { renderPage, stubApi } from './harness';

/**
 * Demo parity X1, X3, X4 and A1–A4: the page header every page draws and the shell around it.
 *
 * - the breadcrumb is DERIVED from the navigation (group / page, group / list / detail), so a
 *   page never writes its own and none is missing;
 * - the page's title lives in the page header, never in the top bar;
 * - the header's controls follow the title block, on the other side, at its bottom;
 * - the top bar holds the search and the round glass buttons in the reference's order;
 * - the incident card is drawn only for a real open incident.
 */

const ALL = [...PERMISSION_KEYS];
const SAMPLE_ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';
const at = (path: string, permissions: readonly PermissionKey[] = ALL) =>
  resolve({ path, query: new URLSearchParams() }, permissions, ['owner']);
const trailOf = (path: string) => pageTrail(path, at(path).crumbs);

const session = {
  url: '/auth/session',
  body: {
    admin: {
      id: SAMPLE_ID,
      username: 'owner',
      displayName: 'مدیر اصلی',
      status: 'ACTIVE',
      telegramUserId: null,
      roleKeys: ['owner'],
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: '2026-09-06T08:00:00.000Z',
    },
    permissions: ['users.view'],
    expiresAt: '2026-09-07T08:00:00.000Z',
  },
};

beforeEach(() => {
  window.localStorage.clear();
  act(() => navigate('/', { replace: true, force: true }));
});
afterEach(() => {
  window.localStorage.clear();
});

describe('the breadcrumb is derived from the navigation (X1)', () => {
  it('names the menu group and the page for a page the sidebar links to', () => {
    expect(trailOf('/users')).toEqual([
      { label: t('web.navgroup_customers') },
      { label: t('web.users_title') },
    ]);
    // An entry of its own, not a child of the entry whose path it starts with.
    expect(trailOf('/reseller-tiers').map((crumb) => crumb.label)).toEqual([
      t('web.navgroup_resellers'),
      t('web.reseller_tiers_title'),
    ]);
  });

  it('goes group / list / detail on a page under a list, the list a link back', () => {
    const trail = trailOf(`/services/${SAMPLE_ID}`);
    expect(trail.map((crumb) => crumb.label)).toEqual([
      t('web.navgroup_customers'),
      t('web.nav_services'),
      t('web.service_detail'),
    ]);
    expect(trail[0]?.href).toBeUndefined();
    expect(trail[1]?.href).toBe('/services');
    expect(trail[2]?.href).toBeUndefined();
  });

  it('draws nothing where nothing is above the page: the dashboard, the account', () => {
    expect(trailOf('/')).toEqual([]);
    expect(trailOf('/account')).toEqual([]);
  });

  it('gives every route a sidebar entry owns a trail starting at that entry’s group', () => {
    const concrete = (pattern: string) => pattern.replace(/:[a-zA-Z]+/g, SAMPLE_ID);
    for (const pattern of ROUTE_PATTERNS) {
      const path = concrete(pattern);
      const owner = NAV.filter(
        (entry) => path === entry.path || (entry.path !== '/' && path.startsWith(`${entry.path}/`)),
      ).sort((a, b) => b.path.length - a.path.length)[0];
      if (owner === undefined || owner.group === NAV_STANDALONE_GROUP) continue;
      const resolved = at(path);
      // A redirect has no header of its own to carry a trail.
      if (resolved.crumbs.length === 0) continue;
      const trail = pageTrail(path, resolved.crumbs);
      expect(trail.length, pattern).toBeGreaterThanOrEqual(2);
      expect(trail[0]?.label, pattern).toBe(t(owner.group));
      expect(trail[trail.length - 1]?.label, pattern).toBe(
        resolved.crumbs[resolved.crumbs.length - 1]?.label,
      );
    }
  });
});

describe('the page header (X1, X3, X4)', () => {
  it('draws the trail above the title, the subtitle, then the controls after the block', () => {
    renderPage(
      <PageTrailContext.Provider
        value={[{ label: 'گروه' }, { label: 'فهرست', href: '/x' }, { label: 'جزئیات' }]}
      >
        <PageHead
          title="عنوان"
          subtitle="زیرعنوان"
          meta="آخرین به‌روزرسانی"
          actions={<button type="button">کار اصلی</button>}
        />
      </PageTrailContext.Provider>,
    );
    const head = document.querySelector('.page-head') as HTMLElement;
    const titles = head.querySelector('.titles') as HTMLElement;
    const crumbs = within(titles).getByRole('navigation', { name: t('web.breadcrumbs') });
    // The trail comes first in the block, the H1 after it.
    expect(titles.firstElementChild).toBe(crumbs);
    expect(crumbs.compareDocumentPosition(within(titles).getByRole('heading', { level: 1 }))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // The group is a place, not a link; the list is a link; the page itself is current.
    expect(within(crumbs).queryByRole('link', { name: 'گروه' })).toBeNull();
    expect(within(crumbs).getByRole('link', { name: 'فهرست' }).getAttribute('href')).toBe('/x');
    expect(within(crumbs).getByText('جزئیات').getAttribute('aria-current')).toBe('page');
    // Subtitle, then the meta line, inside the block.
    expect(titles.querySelector('.sub')?.textContent).toBe('زیرعنوان');
    expect(titles.querySelector('.head-meta')?.textContent).toBe('آخرین به‌روزرسانی');
    // The primary action is the header's other side, after the block — never inside the H1.
    const actions = head.querySelector(':scope > .actions') as HTMLElement;
    expect(titles.nextElementSibling).toBe(actions);
    expect(within(actions).getByRole('button', { name: 'کار اصلی' })).toBeTruthy();
    expect(head.querySelector('h1 button')).toBeNull();
  });

  it('draws no trail outside the shell, or a trail of one', () => {
    const view = renderPage(<PageHead title="عنوان" />);
    expect(view.container.querySelector('.crumbs')).toBeNull();
    view.unmount();
    renderPage(
      <PageTrailContext.Provider value={[{ label: 'تنها' }]}>
        <PageHead title="عنوان" />
      </PageTrailContext.Provider>,
    );
    expect(document.querySelector('.crumbs')).toBeNull();
  });

  it('offers the ticket queue’s labelled «خواندن دوباره», and a round icon elsewhere (X4)', () => {
    const query = { dataUpdatedAt: Date.UTC(2026, 8, 6, 8), isFetching: false, refetch: () => 0 };
    const icon = renderPage(<ListFreshness query={query} />);
    const round = within(icon.container).getByRole('button', { name: t('web.list_refresh') });
    expect(round.classList.contains('icon')).toBe(true);
    icon.unmount();
    const labelled = renderPage(<ListFreshness query={query} labelled />);
    const button = within(labelled.container).getByRole('button', { name: t('web.list_refresh') });
    expect(button.classList.contains('icon')).toBe(false);
    expect(button.textContent).toBe(t('web.list_refresh'));
    expect(within(labelled.container).getByTestId('list-read-at').textContent).not.toBe('');
  });
});

describe('the shell around it (A1, X11)', () => {
  it('puts the title in the page header and the breadcrumb under the top bar, not in it', async () => {
    stubApi([session, { url: '/customers', body: { customers: [], nextCursor: null } }]);
    act(() => navigate('/users', { replace: true, force: true }));
    renderPage(<App />);
    const heading = await screen.findByRole('heading', { level: 1, name: t('web.users_title') });
    const topbar = document.querySelector('.topbar') as HTMLElement;
    expect(topbar.contains(heading)).toBe(false);
    expect(within(topbar).queryByRole('navigation', { name: t('web.breadcrumbs') })).toBeNull();
    expect(topbar.textContent).not.toContain(t('web.users_title'));
    // The breadcrumb is the page header's, from the navigation.
    const crumbs = (document.querySelector('.page-head') as HTMLElement).querySelector(
      '.crumbs',
    ) as HTMLElement;
    expect(crumbs.textContent).toContain(t('web.navgroup_customers'));
    expect(crumbs.textContent).toContain(t('web.users_title'));
  });

  it('orders the top bar: search on the sidebar side, then menu, help, bell, theme, owner', async () => {
    stubApi([session]);
    renderPage(<App />);
    await screen.findByRole('navigation', { name: t('web.nav_label') });
    const topbar = document.querySelector('.topbar') as HTMLElement;
    const order = [...topbar.querySelectorAll('button, a')].map(
      (node) => node.getAttribute('aria-label') ?? '',
    );
    const index = (label: string) => order.indexOf(label);
    expect(index(t('web.search_label'))).toBe(0);
    expect(index(t('web.open_menu'))).toBeGreaterThan(index(t('web.search_label')));
    expect(index(t('web.help'))).toBeGreaterThan(index(t('web.open_menu')));
    const bell = order.findIndex((label) => label.startsWith(t('web.nc_bell')));
    expect(bell).toBeGreaterThan(index(t('web.help')));
    const theme = order.findIndex((label) => label.startsWith(`${t('web.theme')}:`));
    expect(theme).toBeGreaterThan(bell);
    // The owner pill is last: at the far edge.
    expect(order[order.length - 1]).toBe(t('web.user_menu'));
    // It shows the avatar's letter and the role, not the name.
    const pill = within(topbar).getByRole('button', { name: t('web.user_menu') });
    expect(pill.querySelector('.avatar')?.textContent).toBe('م');
    expect(pill.querySelector('.who-name')?.textContent).toBe(t('web.role_key_owner'));
  });

  it('opens help with the search shortcut, which opens the search', async () => {
    stubApi([session]);
    renderPage(<App />);
    await screen.findByRole('navigation', { name: t('web.nav_label') });
    fireEvent.click(screen.getByRole('button', { name: t('web.help') }));
    fireEvent.click(screen.getByRole('menuitem', { name: t('web.help_search') }));
    expect(screen.getByRole('dialog', { name: t('web.search_label') })).toBeTruthy();
  });

  it('folds the sidebar to its rail from the top bar’s menu button at a desk', async () => {
    stubApi([session]);
    const { container } = renderPage(<App />);
    const menu = await screen.findByRole('button', { name: t('web.open_menu') });
    expect(container.querySelector('.app')?.classList.contains('collapsed')).toBe(false);
    fireEvent.click(menu);
    expect(container.querySelector('.app')?.classList.contains('collapsed')).toBe(true);
    expect(menu.getAttribute('aria-expanded')).toBe('false');
  });

  it('draws the brand block with the wordmark and no separate installation card', async () => {
    stubApi([session]);
    renderPage(<App />);
    await screen.findByRole('navigation', { name: t('web.nav_label') });
    const sidebar = document.getElementById('app-sidebar') as HTMLElement;
    expect(sidebar.querySelector('.brand .wordmark')?.textContent).toBe(t('web.brand_wordmark'));
    expect(sidebar.querySelector('.brand-mark')?.textContent).toBe('N');
    expect(sidebar.querySelector('.identity')).toBeNull();
  });
});

describe('a new page opens at its top', () => {
  it('resets the one scroller on a pathname change, never on a query change', async () => {
    stubApi([session, { url: '/customers', body: { customers: [], nextCursor: null } }]);
    act(() => navigate('/users', { replace: true, force: true }));
    renderPage(<App />);
    await screen.findByRole('heading', { level: 1, name: t('web.users_title') });
    const scroller = document.getElementById('main') as HTMLElement;

    // A filter or a tab is the same page: the operator's place in it stays.
    scroller.scrollTop = 400;
    act(() => navigate('/users?q=ali'));
    expect(scroller.scrollTop).toBe(400);

    // Another page starts at its own top, not at the offset the last one was left at.
    act(() => navigate('/'));
    expect(document.getElementById('main')?.scrollTop).toBe(0);
  });
});

describe('the incident card (A4)', () => {
  const banner = (incidents: readonly unknown[]) => ({
    url: '/incidents/banner',
    body: { incidents },
  });
  const active = {
    id: SAMPLE_ID,
    kind: 'INCIDENT',
    severity: 'CRITICAL',
    title: 'قطعی پنل',
    startedAt: '2026-10-03T10:00:00.000Z',
    scheduledEndAt: null,
  };

  it('is drawn only while the server reports an open incident', async () => {
    stubApi([banner([])]);
    const none = renderPage(<IncidentBanner mayView />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(none.container.querySelector('.incident-banner')).toBeNull();
    none.unmount();

    stubApi([banner([active])]);
    const view = renderPage(<IncidentBanner mayView />);
    const card = (await waitFor(() => {
      const found = view.container.querySelector('.incident-banner');
      expect(found).not.toBeNull();
      return found;
    })) as HTMLElement;
    // Red-tinted for a real outage, the kind in bold over the title, and the «جزئیات» capsule.
    expect(card.classList.contains('is-danger')).toBe(true);
    expect(card.querySelector('strong')?.textContent).toBe(t('web.inc_kind_incident'));
    expect(card.textContent).toContain('قطعی پنل');
    const open = within(card).getByRole('link', { name: t('web.inc_banner_open') });
    expect(open.classList.contains('incident-banner-open')).toBe(true);
  });

  it('takes the amber tint for a minor incident', async () => {
    stubApi([banner([{ ...active, severity: 'MINOR' }])]);
    const view = renderPage(<IncidentBanner mayView={false} />);
    await waitFor(() =>
      expect(view.container.querySelector('.incident-banner.is-warn')).not.toBeNull(),
    );
  });
});
