import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { PERMISSION_KEYS, type PermissionKey } from '@nexa/contracts';
import { App, GROUP_ORDER, NAV, ROUTE_PATTERNS, navPermitted } from '../../apps/web/src/app';
import { NAV_STANDALONE_GROUP, navGroupOf } from '../../apps/web/src/nav';
import { Sidebar, sumCounters } from '../../apps/web/src/shell';
import { t } from '../../apps/web/src/i18n/web.fa';
import { navigate } from '../../apps/web/src/router';
import type { NavCounters } from '../../apps/web/src/nav-counters';
import { navGroupHeader, renderPage, stubApi } from './harness';

/**
 * The sidebar's information architecture and its single-open accordion.
 *
 * What this file defends: the ten groups hold exactly the owner's entries, in the owner's
 * order; every one of the 50 entries survived with its path, label, icon, permission and
 * owner-only flag untouched (a snapshot taken from the navigation BEFORE the regrouping); only
 * one group is open at a time; the group that owns the current route opens on the first
 * render and on every navigation; permission filtering happens before anything is drawn.
 */

/** id, path, label, icon, permission, ownerOnly — the navigation as it was before this change. */
const BEFORE: readonly [
  string,
  string,
  string,
  string,
  PermissionKey | readonly PermissionKey[] | null,
  boolean,
][] = [
  ['alerts', '/alerts', 'web.nav_alerts', 'alertOctagon', 'opslog.view', false],
  ['appearance', '/appearance', 'web.nav_appearance', 'palette', 'settings.view', false],
  ['audit-log', '/audit-log', 'web.nav_audit_log', 'clock', 'audit.view', false],
  ['bot-buttons', '/bot-buttons', 'web.nav_bot_buttons', 'keyboard', 'settings.view', false],
  ['bots', '/bots', 'web.nav_bots', 'bots', 'settings.view', false],
  ['broadcasts', '/broadcasts', 'web.nav_broadcasts', 'send', 'broadcasts.view', false],
  [
    'bulk-operations',
    '/bulk-operations',
    'web.nav_bulk_operations',
    'grid',
    'bulk_operations.view',
    false,
  ],
  [
    'business-chats',
    '/business-chats',
    'web.nav_business_chats',
    'send',
    'business_chats.view',
    false,
  ],
  ['campaigns', '/campaigns', 'web.nav_campaigns', 'megaphone', 'campaigns.view', false],
  ['client-apps', '/client-apps', 'web.nav_client_apps', 'devices', 'client_apps.view', false],
  ['compensations', '/compensations', 'web.nav_compensations', 'undo', 'payments.view', false],
  ['content', '/content', 'web.nav_templates', 'content', 'templates.view', false],
  ['custom-service', '/custom-service', 'web.nav_custom_service', 'sliders', 'catalog.view', false],
  ['dashboard', '/', 'web.nav_overview', 'dashboard', null, false],
  ['discounts', '/discounts', 'web.nav_discounts', 'discounts', 'catalog.view', false],
  [
    'extra-devices',
    '/extra-devices',
    'web.nav_extra_devices',
    'userPlus',
    ['catalog.view', 'catalog.edit'],
    false,
  ],
  ['features', '/features', 'web.nav_features', 'toggle', 'settings.view', false],
  ['inbox', '/notification-center', 'web.nav_inbox', 'bell', null, false],
  ['incidents', '/incidents', 'web.nav_incidents', 'alert', 'incidents.view', false],
  [
    'knowledge-build',
    '/knowledge-build',
    'web.nav_knowledge_build',
    'refresh',
    'support_knowledge.view',
    false,
  ],
  [
    'learning-candidates',
    '/support-learning',
    'web.nav_learning_candidates',
    'check',
    'support_knowledge.view',
    false,
  ],
  [
    'notifications',
    '/notifications',
    'web.nav_notifications',
    'bell',
    ['opslog.view', 'settings.edit'],
    false,
  ],
  ['ops-group', '/ops-group', 'web.nav_ops_group', 'radio', 'settings.view', false],
  ['orders', '/orders', 'web.nav_orders', 'orders', 'orders.view', false],
  ['panel-health', '/panel-health', 'web.nav_panel_health', 'activity', 'panels.view', false],
  ['panels', '/panels', 'web.nav_panels', 'panels', ['panels.view', 'panels.edit'], false],
  [
    'payment-gateways',
    '/payment-gateways',
    'web.nav_payment_gateways',
    'wallet',
    ['payments.gateways.view', 'payments.accounts.view'],
    false,
  ],
  ['payments', '/payments', 'web.nav_payments', 'payments', 'payments.view', false],
  [
    'product-categories',
    '/product-categories',
    'web.nav_product_categories',
    'folder',
    ['catalog.view', 'catalog.edit'],
    false,
  ],
  [
    'products',
    '/products',
    'web.nav_products',
    'products',
    ['catalog.view', 'catalog.edit'],
    false,
  ],
  ['providers', '/providers', 'web.nav_providers', 'plug', null, false],
  ['recovery', '/recovery', 'web.nav_recovery', 'database', 'backup.view', false],
  ['referrals', '/referrals', 'web.nav_referrals', 'link', 'referrals.view', false],
  ['reminders', '/reminders', 'web.nav_reminders', 'clock', 'settings.view', false],
  ['reports', '/reports', 'web.nav_reports', 'reports', 'reports.view', true],
  [
    'reseller-plans',
    '/reseller-plans',
    'web.nav_reseller_plans',
    'target',
    'resellers.view',
    false,
  ],
  [
    'reseller-tiers',
    '/reseller-tiers',
    'web.nav_reseller_tiers',
    'layers',
    'resellers.view',
    false,
  ],
  ['resellers', '/resellers', 'web.nav_resellers', 'resellers', 'resellers.view', false],
  [
    'service-locations',
    '/service-locations',
    'web.nav_service_locations',
    'globe',
    ['catalog.view', 'catalog.edit'],
    false,
  ],
  [
    'services',
    '/services',
    'web.nav_services',
    'services',
    ['services.view', 'refunds.view'],
    false,
  ],
  ['settings', '/settings', 'web.nav_settings', 'settings', 'settings.view', false],
  ['support', '/support', 'web.nav_support', 'help', 'settings.view', false],
  ['support-ai', '/support-ai', 'web.nav_support_ai', 'zap', 'support_ai.configure', false],
  [
    'support-analytics',
    '/support-analytics',
    'web.nav_support_analytics',
    'activity',
    'support_ai.configure',
    false,
  ],
  [
    'support-knowledge',
    '/support-knowledge',
    'web.nav_support_knowledge',
    'content',
    'support_knowledge.view',
    false,
  ],
  ['system', '/system', 'web.nav_system', 'system', null, false],
  ['terms', '/terms', 'web.nav_terms', 'shield', 'terms.view', false],
  ['tickets', '/tickets', 'web.nav_tickets', 'message', 'tickets.view', false],
  [
    'trials',
    '/trials',
    'web.nav_trials',
    'gift',
    ['users.view', 'settings.destructive', 'settings.view', 'panels.view'],
    false,
  ],
  ['users', '/users', 'web.nav_users', 'users', 'users.view', false],
];

const GROUPS: readonly [string, readonly string[]][] = [
  ['web.navgroup_dashboard', ['dashboard']],
  ['web.navgroup_customers', ['users', 'services', 'tickets', 'support']],
  [
    'web.navgroup_support_ai',
    [
      'business-chats',
      'support-ai',
      'support-knowledge',
      'learning-candidates',
      'knowledge-build',
      'support-analytics',
    ],
  ],
  [
    'web.navgroup_sales',
    [
      'orders',
      'products',
      'product-categories',
      'custom-service',
      'extra-devices',
      'service-locations',
      'trials',
      'discounts',
      'campaigns',
      'referrals',
      'reports',
    ],
  ],
  ['web.navgroup_finance', ['payments', 'compensations', 'payment-gateways', 'bulk-operations']],
  ['web.navgroup_resellers', ['resellers', 'reseller-tiers', 'reseller-plans']],
  [
    'web.navgroup_bot',
    [
      'bots',
      'bot-buttons',
      'appearance',
      'content',
      'broadcasts',
      'reminders',
      'client-apps',
      'terms',
    ],
  ],
  ['web.navgroup_infra', ['panels', 'panel-health', 'providers']],
  ['web.navgroup_config', ['settings', 'features']],
  [
    'web.navgroup_system',
    [
      'inbox',
      'audit-log',
      'incidents',
      'alerts',
      'notifications',
      'ops-group',
      'system',
      'recovery',
    ],
  ],
];

const LABELS: Readonly<Record<string, string>> = {
  'web.navgroup_dashboard': 'داشبورد',
  'web.navgroup_customers': 'مشتریان و پشتیبانی',
  'web.navgroup_support_ai': 'هوش مصنوعی پشتیبانی',
  'web.navgroup_sales': 'فروش و محصولات',
  'web.navgroup_finance': 'مالی و پرداخت',
  'web.navgroup_resellers': 'نمایندگان',
  'web.navgroup_bot': 'ربات و ارتباط با مشتری',
  'web.navgroup_infra': 'زیرساخت و پنل‌ها',
  'web.navgroup_config': 'تنظیمات',
  'web.navgroup_system': 'مدیریت سیستم',
};

const ALL = [...PERMISSION_KEYS];
const OWNER = ['owner'];

function sidebar(
  currentPath: string,
  permissions: readonly PermissionKey[] = ALL,
  roles: readonly string[] = OWNER,
  options: { collapsed?: boolean; counters?: NavCounters } = {},
) {
  stubApi([{ url: '/health/info', body: { environment: 'test', name: 'nexa' } }]);
  const draw = (path: string) => (
    <Sidebar
      entries={NAV.filter((entry) => navPermitted(entry, permissions, roles))}
      currentPath={path}
      collapsed={options.collapsed ?? false}
      onToggle={() => {}}
      counters={options.counters ?? {}}
      theme="system"
      onTheme={() => {}}
    />
  );
  const view = renderPage(draw(currentPath));
  return { ...view, goTo: (path: string) => view.rerender(draw(path)) };
}

const nav = () => screen.getByRole('navigation', { name: t('web.nav_label') });
const openGroups = () =>
  [...document.querySelectorAll('.nav-group-head[aria-expanded="true"]')].map(
    (head) => head.querySelector('.lbl')?.textContent,
  );
const drawnHrefs = () =>
  within(nav())
    .queryAllByRole('link')
    .map((link) => link.getAttribute('href'));
const head = (group: string) => navGroupHeader(group) as HTMLButtonElement;

describe('the navigation’s information architecture', () => {
  it('keeps all 50 entries exactly once, each with its path, label, icon and permission', () => {
    expect(NAV).toHaveLength(50);
    expect(new Set(NAV.map((entry) => entry.id)).size).toBe(50);
    expect(new Set(NAV.map((entry) => entry.path)).size).toBe(50);
    const now = [...NAV]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((entry) => [
        entry.id,
        entry.path,
        entry.label,
        entry.icon,
        entry.permission,
        entry.ownerOnly === true,
      ]);
    expect(now).toEqual(BEFORE);
    for (const entry of NAV) expect(ROUTE_PATTERNS, entry.path).toContain(entry.path);
  });

  it('draws the ten groups in the owner’s order, each holding the owner’s entries in order', () => {
    expect(GROUP_ORDER).toEqual(GROUPS.map(([group]) => group));
    for (const [group, ids] of GROUPS) {
      expect(
        NAV.filter((entry) => entry.group === group).map((entry) => entry.id),
        group,
      ).toEqual(ids);
      expect(t(group as never), group).toBe(LABELS[group]);
    }
    expect(NAV_STANDALONE_GROUP).toBe('web.navgroup_dashboard');
  });

  it('puts the six support-AI pages under «هوش مصنوعی پشتیبانی»', () => {
    for (const path of [
      '/business-chats',
      '/support-ai',
      '/support-knowledge',
      '/support-learning',
      '/knowledge-build',
      '/support-analytics',
    ]) {
      expect(NAV.find((entry) => entry.path === path)?.group, path).toBe('web.navgroup_support_ai');
    }
  });

  it('names the group that owns a path, a detail page included, and none for an unlisted one', () => {
    expect(navGroupOf(NAV, '/')).toBe('web.navgroup_dashboard');
    expect(navGroupOf(NAV, '/orders/019400ab-cdef-7012-8345-6789abcdef01')).toBe(
      'web.navgroup_sales',
    );
    expect(navGroupOf(NAV, '/business-chats/x')).toBe('web.navgroup_support_ai');
    expect(navGroupOf(NAV, '/payment-gateways/tonpays')).toBe('web.navgroup_finance');
    expect(navGroupOf(NAV, '/account')).toBeNull();
  });
});

describe('the single-open accordion', () => {
  it('opens the current route’s group on the first render, and only that one', () => {
    sidebar('/panels');
    expect(openGroups()).toEqual([LABELS['web.navgroup_infra']]);
    expect(head('web.navgroup_infra').getAttribute('aria-expanded')).toBe('true');
    expect(head('web.navgroup_infra').getAttribute('aria-controls')).toBeTruthy();
    expect(drawnHrefs()).toEqual(['/', '/panels', '/panel-health', '/providers']);
  });

  it('opens the owning group of a deep link, and highlights its page', () => {
    sidebar('/orders/019400ab-cdef-7012-8345-6789abcdef01');
    expect(openGroups()).toEqual([LABELS['web.navgroup_sales']]);
    const orders = within(nav()).getByRole('link', { name: t('web.nav_orders') });
    expect(orders.getAttribute('aria-current')).toBe('page');
    expect(
      within(nav())
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current') === 'page'),
    ).toHaveLength(1);
  });

  it('keeps one group open: opening another closes the last, and a header closes its own', () => {
    sidebar('/');
    expect(openGroups()).toEqual([]);
    fireEvent.click(head('web.navgroup_customers'));
    expect(openGroups()).toEqual([LABELS['web.navgroup_customers']]);
    expect(drawnHrefs()).toEqual(['/', '/users', '/services', '/tickets', '/support']);
    fireEvent.click(head('web.navgroup_system'));
    expect(openGroups()).toEqual([LABELS['web.navgroup_system']]);
    expect(drawnHrefs()).not.toContain('/users');
    expect(head('web.navgroup_customers').getAttribute('aria-expanded')).toBe('false');
    for (const [group] of GROUPS.slice(1)) {
      fireEvent.click(head(group));
      expect(openGroups(), group).toEqual([LABELS[group]]);
    }
    fireEvent.click(head('web.navgroup_system'));
    expect(openGroups()).toEqual([]);
  });

  it('follows navigation to the group that owns the new page', () => {
    const { goTo } = sidebar('/users');
    expect(openGroups()).toEqual([LABELS['web.navgroup_customers']]);
    goTo('/support-ai');
    expect(openGroups()).toEqual([LABELS['web.navgroup_support_ai']]);
    expect(
      within(nav())
        .getByRole('link', { name: t('web.nav_support_ai') })
        .getAttribute('aria-current'),
    ).toBe('page');
    // A page no entry owns leaves the sidebar as it was.
    goTo('/account');
    expect(openGroups()).toEqual([LABELS['web.navgroup_support_ai']]);
  });

  it('keeps an operator’s own choice until the route changes', () => {
    const { goTo } = sidebar('/users');
    fireEvent.click(head('web.navgroup_bot'));
    expect(openGroups()).toEqual([LABELS['web.navgroup_bot']]);
    // A re-render on the same route does not snap back to the owning group.
    goTo('/users');
    expect(openGroups()).toEqual([LABELS['web.navgroup_bot']]);
  });

  it('re-opens the owning group on a move within it, after another group was opened', () => {
    const { goTo } = sidebar('/users');
    fireEvent.click(head('web.navgroup_bot'));
    goTo('/services');
    expect(openGroups()).toEqual([LABELS['web.navgroup_customers']]);
    expect(
      within(nav())
        .getByRole('link', { name: t('web.nav_services') })
        .getAttribute('aria-current'),
    ).toBe('page');
  });

  it('re-opens the owning group on a move within it, after the operator closed it', () => {
    const { goTo } = sidebar('/users');
    fireEvent.click(head('web.navgroup_customers'));
    expect(openGroups()).toEqual([]);
    goTo('/tickets');
    expect(openGroups()).toEqual([LABELS['web.navgroup_customers']]);
    expect(
      within(nav())
        .getByRole('link', { name: t('web.nav_tickets') })
        .getAttribute('aria-current'),
    ).toBe('page');
  });

  it('points every header at a real panel, hidden while the group is closed', () => {
    sidebar('/panels');
    for (const [group] of GROUPS.slice(1)) {
      const header = head(group);
      const panel = document.getElementById(header.getAttribute('aria-controls') as string);
      expect(panel, group).not.toBeNull();
      expect(panel?.hidden, group).toBe(header.getAttribute('aria-expanded') !== 'true');
    }
  });

  it('draws the dashboard above the accordion, reachable whichever group is open', () => {
    sidebar('/panels');
    const dashboard = within(nav()).getByRole('link', { name: t('web.nav_overview') });
    expect(dashboard.getAttribute('href')).toBe('/');
    expect(navGroupHeader('web.navgroup_dashboard')).toBeNull();
    fireEvent.click(head('web.navgroup_resellers'));
    expect(within(nav()).getByRole('link', { name: t('web.nav_overview') })).toBeTruthy();
  });

  it('shows a closed group’s counters on its header, and the link’s own once open', () => {
    sidebar('/', ALL, OWNER, {
      counters: { tickets: { count: 3, tone: 'warn' }, services: { count: 2, atLeast: true } },
    });
    const customers = head('web.navgroup_customers');
    expect(customers.querySelector('.cnt [aria-hidden="true"]')?.textContent).toBe(
      t('web.nav_counter_at_least').replace('{count}', '5'),
    );
    expect(customers.querySelector('.cnt')?.classList.contains('warn')).toBe(true);
    // Heard as well as seen: the header's name carries the sum, a capped one as a floor.
    expect(customers).toHaveAccessibleName(
      `${LABELS['web.navgroup_customers']}${t('web.nav_counter_at_least_spoken').replace('{count}', '5')}`,
    );
    fireEvent.click(customers);
    expect(customers.querySelector('.cnt')).toBeNull();
    expect(
      within(nav())
        .getByRole('link', { name: new RegExp(t('web.nav_tickets')) })
        .querySelector('.cnt')?.textContent,
    ).toBe('3');
  });

  it('sums counters with the most severe tone, and draws none for zero', () => {
    const members = NAV.filter((entry) => entry.group === 'web.navgroup_customers');
    expect(sumCounters(members, {})).toBeUndefined();
    expect(sumCounters(members, { users: { count: 0 } })).toBeUndefined();
    expect(
      sumCounters(members, {
        tickets: { count: 1, tone: 'warn' },
        services: { count: 4, tone: 'danger' },
      }),
    ).toEqual({ count: 5, tone: 'danger' });
    expect(sumCounters(members, { tickets: { count: 1 } })).toEqual({ count: 1 });
  });

  it('keeps every icon in the collapsed rail, where a header has no room for its label', () => {
    sidebar('/', ALL, OWNER, { collapsed: true });
    expect(document.querySelectorAll('.nav-group-head')).toHaveLength(0);
    expect(drawnHrefs()).toHaveLength(50);
  });
});

describe('permissions in the accordion', () => {
  it('hides an unauthorized child and a group with no authorized child, header included', () => {
    sidebar('/users', ['users.view', 'tickets.view'], []);
    expect(drawnHrefs()).toEqual(['/', '/users', '/tickets']);
    expect(navGroupHeader('web.navgroup_support_ai')).toBeNull();
    expect(screen.queryByRole('group', { name: t('web.navgroup_resellers') })).toBeNull();
    // `users.view` alone admits /trials (one of its four keys), so sales is drawn with it;
    // session-only entries keep infra (providers) and system drawn.
    expect(navGroupHeader('web.navgroup_infra')).not.toBeNull();
    expect(navGroupHeader('web.navgroup_system')).not.toBeNull();
    const drawnGroups = [...document.querySelectorAll('.nav-group-head .lbl')].map(
      (label) => label.textContent,
    );
    expect(drawnGroups).toEqual([
      LABELS['web.navgroup_customers'],
      LABELS['web.navgroup_sales'],
      LABELS['web.navgroup_infra'],
      LABELS['web.navgroup_system'],
    ]);
  });

  it('keeps the reports entry owner-only', () => {
    const { unmount } = sidebar('/orders', ['orders.view', 'reports.view'], ['operator']);
    expect(drawnHrefs()).not.toContain('/reports');
    unmount();
    sidebar('/orders', ['orders.view', 'reports.view'], OWNER);
    expect(drawnHrefs()).toContain('/reports');
  });
});

describe('the accordion in the narrow-screen drawer', () => {
  const realMatch = window.matchMedia;
  const realWidth = window.innerWidth;
  beforeEach(() => {
    window.localStorage.clear();
    act(() => navigate('/panels', { replace: true, force: true }));
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
    window.matchMedia = ((query: string) => ({
      ...realMatch(query),
      matches: /max-width:\s*980px/.test(query) || realMatch(query).matches,
    })) as typeof window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = realMatch;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: realWidth });
    act(() => navigate('/', { replace: true, force: true }));
  });

  it('opens on the current page’s group, keeps one open, and a link navigates and closes it', async () => {
    stubApi([
      {
        url: '/auth/session',
        body: {
          admin: {
            id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
            username: 'sara',
            displayName: 'سارا احمدی',
            status: 'ACTIVE',
            telegramUserId: null,
            roleKeys: ['operator'],
            createdAt: '2026-01-01T00:00:00.000Z',
            lastLoginAt: '2026-09-06T08:00:00.000Z',
          },
          permissions: ['panels.view', 'users.view', 'settings.view'],
          expiresAt: '2026-09-07T08:00:00.000Z',
        },
      },
    ]);
    const { container } = renderPage(<App />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.open_menu') }));
    expect(container.querySelector('.app')?.classList.contains('collapsed')).toBe(false);
    expect(openGroups()).toEqual([LABELS['web.navgroup_infra']]);
    fireEvent.click(head('web.navgroup_customers'));
    expect(openGroups()).toEqual([LABELS['web.navgroup_customers']]);
    act(() => {
      fireEvent.click(within(nav()).getByRole('link', { name: t('web.nav_users') }));
    });
    expect(window.location.pathname).toBe('/users');
    // Following a link closes the drawer; reopened, it shows the new page's group.
    expect(container.querySelector('.app')?.classList.contains('collapsed')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: t('web.open_menu') }));
    expect(openGroups()).toEqual([LABELS['web.navgroup_customers']]);
  });
});
