import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { PERMISSION_KEYS, type PermissionKey } from '@nexa/contracts';
import { NAV, navPermitted } from '../../apps/web/src/app';
import { BottomNav } from '../../apps/web/src/shell';
import { t } from '../../apps/web/src/i18n/web.fa';
import { formatNumber } from '../../apps/web/src/format';
import type { NavCounters } from '../../apps/web/src/nav-counters';
import { renderPage } from './harness';

/**
 * The phone's bottom navigation (the Liquid Glass capsule). It draws a destination only when
 * the permission-filtered entries the sidebar receives contain its path, shows that entry's
 * server counter, marks the current route, and its menu button opens the sidebar drawer.
 */

const ALL = [...PERMISSION_KEYS];

function capsule(
  currentPath: string,
  permissions: readonly PermissionKey[] = ALL,
  options: { counters?: NavCounters; onOpenMenu?: () => void } = {},
) {
  renderPage(
    <BottomNav
      entries={NAV.filter((entry) => navPermitted(entry, permissions, ['owner']))}
      currentPath={currentPath}
      counters={options.counters ?? {}}
      collapsed
      onOpenMenu={options.onOpenMenu ?? (() => {})}
    />,
  );
  return screen.getByRole('navigation', { name: t('web.bottom_nav_label') });
}

const hrefs = (nav: HTMLElement) =>
  within(nav)
    .getAllByRole('link')
    .map((link) => link.getAttribute('href'));

describe('the bottom navigation', () => {
  it('draws the four destinations, in the demo order, and the menu when permitted', () => {
    const nav = capsule('/');
    expect(hrefs(nav)).toEqual(['/', '/business-chats', '/payments', '/users']);
    expect(within(nav).getByRole('link', { name: t('web.nav_overview') })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: t('web.bottom_nav_chats') })).toBeInTheDocument();
    expect(
      within(nav).getByRole('link', { name: t('web.bottom_nav_payments') }),
    ).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: t('web.nav_users') })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: t('web.bottom_nav_menu') })).toBeInTheDocument();
  });

  it('leaves out a destination the filtered entries do not contain', () => {
    const nav = capsule(
      '/',
      ALL.filter((key) => key !== 'payments.view' && key !== 'business_chats.view'),
    );
    expect(hrefs(nav)).toEqual(['/', '/users']);
    expect(within(nav).queryByRole('link', { name: t('web.bottom_nav_payments') })).toBeNull();
    // The menu is always there: it is how every other page is reached.
    expect(within(nav).getByRole('button', { name: t('web.bottom_nav_menu') })).toBeInTheDocument();
  });

  it('shows the sidebar counter for a destination, with its tone', () => {
    const nav = capsule('/', ALL, { counters: { payments: { count: 15, tone: 'warn' } } });
    const payments = within(nav).getByRole('link', {
      name: new RegExp(t('web.bottom_nav_payments')),
    });
    const badge = payments.querySelector('.cnt');
    expect(badge).toHaveClass('warn');
    expect(badge).toHaveTextContent(formatNumber(15));
    expect(payments).toHaveAccessibleDescription(formatNumber(15));
    expect(nav.querySelectorAll('.cnt')).toHaveLength(1);
  });

  it('marks the current route, including a page beneath it', () => {
    const nav = capsule('/users/01a05e35-c9ad-7e93-bef3-1ed9b55292c8');
    const current = within(nav)
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current.map((link) => link.getAttribute('href'))).toEqual(['/users']);
  });

  it('opens the sidebar drawer from its menu button', () => {
    const onOpenMenu = vi.fn();
    const nav = capsule('/', ALL, { onOpenMenu });
    const menu = within(nav).getByRole('button', { name: t('web.bottom_nav_menu') });
    expect(menu).toHaveAttribute('aria-controls', 'app-sidebar');
    fireEvent.click(menu);
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
  });
});
