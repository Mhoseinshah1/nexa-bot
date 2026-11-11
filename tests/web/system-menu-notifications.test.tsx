import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { PERMISSION_KEYS, type PermissionKey } from '@nexa/contracts';
import { resolve } from '../../apps/web/src/app';
import { navPermitted, NAV } from '../../apps/web/src/nav';
import { openFilterPanel } from './ui-helpers';
import { t } from '../../apps/web/src/i18n/web.fa';
import type { AlertEvent } from '../../apps/web/src/pages/alerts';
import { RedirectPage } from '../../apps/web/src/pages/redirect';
import {
  filterFromQuery,
  mergeFeeds,
  NotificationCenterPage,
} from '../../apps/web/src/pages/notification-center';
import { event, renderPage, stubApi } from './harness';
import type { ReactElement } from 'react';

/**
 * PR-8 «system menu»: «مرکز اعلان‌ها» + «هشدارهای مدیریتی» are one page, and the delivery log is
 * a tab of «گروه لاگ». Driven through the real `resolve` and `NAV`, the real client and the real
 * components.
 */

const AT = '2026-10-03T08:00:00.000Z';
const ID_BOTH = '019210ab-cdef-7012-8345-0000000000a1';
const ID_ALERT_ONLY = '019210ab-cdef-7012-8345-0000000000a2';
const ID_INBOX_ONLY = '019210ab-cdef-7012-8345-0000000000a3';

const inboxRow = (id: string, firstSeenAt = AT) => ({
  id,
  code: 'admin.roles_changed',
  category: 'SECURITY',
  severity: 'WARN',
  message: 'Roles changed.',
  occurrenceCount: 1,
  firstSeenAt,
  lastSeenAt: firstSeenAt,
  resolvedAt: null,
  read: false,
  link: { target: 'ADMINS', id: null },
});

const alertRow = (id: string, firstSeenAt = AT, extra: Record<string, unknown> = {}): AlertEvent =>
  event({ id, firstSeenAt, lastSeenAt: firstSeenAt, ...extra }) as unknown as AlertEvent;

/**
 * A chip of the unified page, found inside its own filter strip in the «فیلترها» panel (demo
 * parity: no chip row above the list); the panel is opened first when it is not open yet.
 */
const chip = (label: Parameters<typeof t>[0]) => {
  const panel = screen.queryByRole('dialog', { name: t('web.filters') }) ?? openFilterPanel();
  return within(within(panel).getByRole('group', { name: t('web.nc_filters_label') })).getByRole(
    'button',
    { name: new RegExp(t(label), 'u') },
  );
};

const routeFor = (path: string, permissions: readonly PermissionKey[], query = ''): ReactElement =>
  resolve({ path, query: new URLSearchParams(query) }, permissions).element as ReactElement;

describe('the old routes redirect', () => {
  it('/alerts lands on the unified page with the alerts filter', () => {
    const element = routeFor('/alerts', ['opslog.view']);
    expect(element.type).toBe(RedirectPage);
    expect((element.props as { to: string }).to).toBe('/notification-center?filter=open');
    expect(filterFromQuery('open')).toBe('OPEN');
    expect(filterFromQuery(null)).toBe('UNREAD');
  });

  it('/notifications lands on the delivery-log tab of the ops group', () => {
    const element = routeFor('/notifications', ['opslog.view']);
    expect(element.type).toBe(RedirectPage);
    expect((element.props as { to: string }).to).toBe('/ops-group?tab=log');
  });

  it('keeps neither as a menu entry, and the ops group carries both capabilities', () => {
    expect(NAV.some((entry) => entry.path === '/alerts' || entry.path === '/notifications')).toBe(
      false,
    );
    const group = NAV.find((entry) => entry.id === 'ops-group');
    expect(group?.permission).toEqual(['settings.view', 'opslog.view', 'settings.edit']);
    expect(NAV.find((entry) => entry.id === 'inbox')?.label).toBe('web.nav_inbox');
  });
});

describe('«گروه لاگ» and its delivery-log tab', () => {
  const LOG = { url: '/notifications', body: { notifications: [], nextCursor: null } };

  it('an administrator holding only opslog.view reaches the delivery log (and not the group)', async () => {
    const group = NAV.find((entry) => entry.id === 'ops-group');
    expect(navPermitted(group!, ['opslog.view'])).toBe(true);
    const api = stubApi([LOG]);
    renderPage(routeFor('/ops-group', ['opslog.view']));
    // Opens ON the log tab: the first tab is the first one they may read.
    expect(await screen.findByRole('tab', { name: t('web.opsgroup_tab_log') })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await waitFor(() =>
      expect(
        api.calls.some((call) => new URL(call.url, 'http://x').pathname.endsWith('/notifications')),
      ).toBe(true),
    );
    // Their test-send capability is `settings.edit`, which they do not hold.
    expect(screen.queryByRole('button', { name: t('web.send_test') })).toBeNull();
    // The group is not read for them: it is refused, and asks nothing of `/ops-group`.
    expect(api.calls.some((call) => call.url.includes('/ops-group'))).toBe(false);
  });

  it('the page title is «گروه لاگ» and the tab reads «گزارش ارسال‌ها»', async () => {
    stubApi([LOG]);
    renderPage(
      routeFor('/ops-group', ['opslog.view', 'settings.view', 'settings.edit'], 'tab=log'),
    );
    expect(await screen.findByRole('heading', { name: 'گروه لاگ' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'گزارش ارسال‌ها' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(t('web.nav_ops_group')).toBe('گروه لاگ');
  });
});

describe('one item that is both an inbox entry and an alert shows once', () => {
  it('merges two newest-first pages by id and keeps both halves of the shared row', () => {
    const merged = mergeFeeds(
      [
        inboxRow(ID_BOTH, '2026-10-03T09:00:00.000Z') as never,
        inboxRow(ID_INBOX_ONLY, '2026-10-03T07:00:00.000Z') as never,
      ],
      false,
      [
        alertRow(ID_BOTH, '2026-10-03T09:00:00.000Z'),
        alertRow(ID_ALERT_ONLY, '2026-10-03T08:00:00.000Z'),
      ],
      false,
    );
    expect(merged.entries.map((entry) => entry.id)).toEqual([
      ID_BOTH,
      ID_ALERT_ONLY,
      ID_INBOX_ONLY,
    ]);
    const both = merged.entries[0];
    expect(both?.inbox).toBeDefined();
    expect(both?.alert).toBeDefined();
    expect(merged.hasNext).toBe(false);
  });

  it('shows rows only down to the newer feed floor, and pages each feed from its last shown row', () => {
    const merged = mergeFeeds(
      [inboxRow(ID_BOTH, '2026-10-03T09:00:00.000Z') as never],
      true, // the inbox has more, below 09:00
      [
        alertRow(ID_ALERT_ONLY, '2026-10-03T08:00:00.000Z'),
        alertRow(ID_INBOX_ONLY, '2026-10-03T07:00:00.000Z'),
      ],
      false,
    );
    // Below 09:00 the inbox page is unread, so an alert older than that is held back, not
    // drawn out of order and not skipped: the alerts cursor stays where this page began.
    expect(merged.entries.map((entry) => entry.id)).toEqual([ID_BOTH]);
    expect(merged.nextAlerts).toBeNull();
    expect(merged.nextInbox).toEqual({ at: '2026-10-03T09:00:00.000Z', id: ID_BOTH });
    expect(merged.hasNext).toBe(true);
  });

  it('draws the shared row once on the «همه» chip, carrying the alert state too', async () => {
    stubApi([
      {
        url: '/notification-center/summary',
        body: { unread: 1, atLeast: false, highestUnread: 'WARN' },
      },
      {
        url: '/notification-center',
        body: { notifications: [inboxRow(ID_BOTH)], nextCursor: null },
      },
      {
        url: '/ops-log',
        body: {
          events: [alertRow(ID_BOTH, AT, { code: 'admin.roles_changed' })],
          nextCursor: null,
        },
      },
    ]);
    renderPage(<NotificationCenterPage permissions={[...PERMISSION_KEYS]} />);
    await screen.findByRole('button', { name: new RegExp(t('web.filters'), 'u') });
    fireEvent.click(chip('web.nc_filter_all'));
    const items = await screen.findAllByRole('listitem');
    await waitFor(() => {
      expect(
        screen.getAllByRole('listitem').filter((li) => li.classList.contains('nc-item')),
      ).toHaveLength(1);
    });
    expect(items.length).toBeGreaterThan(0);
    const row = document.querySelector('.nc-item') as HTMLElement;
    // Inbox actions AND the alert's own state, on the one item.
    expect(within(row).getByRole('button', { name: t('web.nc_mark_read') })).toBeInTheDocument();
    expect(within(row).getByText(t('web.nc_source_alert'))).toBeInTheDocument();
  });
});

describe('the unified page', () => {
  it('has the four chips, and a red strip only while an alert is open', async () => {
    stubApi([
      {
        url: '/notification-center/summary',
        body: { unread: 2, atLeast: false, highestUnread: 'WARN' },
      },
      { url: '/notification-center', body: { notifications: [], nextCursor: null } },
      { url: '/ops-log', body: { events: [alertRow(ID_ALERT_ONLY)], nextCursor: null } },
    ]);
    const { container } = renderPage(<NotificationCenterPage permissions={[...PERMISSION_KEYS]} />);
    // Demo parity: no chip row above the list; the four are in the filters panel.
    await screen.findByRole('button', { name: new RegExp(t('web.filters'), 'u') });
    expect(screen.queryByRole('group', { name: t('web.nc_filters_label') })).toBeNull();
    for (const label of [
      'web.nc_filter_unread',
      'web.nc_filter_all',
      'web.nc_filter_open_alerts',
      'web.nc_filter_recorded_alerts',
    ] as const) {
      expect(chip(label)).toBeInTheDocument();
    }
    await waitFor(() => expect(container.querySelector('.attention-strip.danger')).not.toBeNull());
  });

  it('draws no strip and asks for no alerts without opslog.view', async () => {
    const api = stubApi([
      {
        url: '/notification-center/summary',
        body: { unread: 0, atLeast: false, highestUnread: null },
      },
      { url: '/notification-center', body: { notifications: [], nextCursor: null } },
    ]);
    const { container } = renderPage(<NotificationCenterPage permissions={['payments.view']} />);
    await screen.findByText(t('web.nc_empty_unread'));
    expect(container.querySelector('.attention-strip')).toBeNull();
    expect(api.calls.some((call) => call.url.includes('/ops-log'))).toBe(false);
  });

  it('the alerts chips keep the alert row’s status badge and «جزئیات فنی»', async () => {
    const api = stubApi([
      {
        url: '/notification-center/summary',
        body: { unread: 0, atLeast: false, highestUnread: null },
      },
      { url: '/notification-center', body: { notifications: [], nextCursor: null } },
      { url: '/ops-log', body: { events: [alertRow(ID_ALERT_ONLY)], nextCursor: null } },
    ]);
    renderPage(<NotificationCenterPage permissions={[...PERMISSION_KEYS]} />);
    await screen.findByRole('button', { name: new RegExp(t('web.filters'), 'u') });
    fireEvent.click(chip('web.nc_filter_recorded_alerts'));
    expect(await screen.findByText(t('web.event_recorded'))).toBeInTheDocument();
    expect(screen.getByText(t('web.err_technical'))).toBeInTheDocument();
    const scopes = api.calls
      .filter((call) => call.url.includes('/ops-log'))
      .map((call) => new URL(call.url, 'http://x').searchParams.get('scope'));
    expect(scopes).toContain('MANAGEMENT');
  });
});
