import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { NOTIFICATION_LINK_TARGETS, NOTIFICATION_RULES, PERMISSION_KEYS } from '@nexa/contracts';
import { t } from '../../apps/web/src/i18n/web.fa';
import {
  NotificationBell,
  NotificationCenterPage,
  pathOf,
  titleOf,
  CATEGORY_LABELS,
} from '../../apps/web/src/pages/notification-center';
import { renderPage, stubApi } from './harness';

/**
 * Phase B3 — the Notification Center and its bell, against the shapes the server returns
 * (parsed by the contract's schemas through the real client).
 */

const PAYMENT = '019210ab-cdef-7012-8345-6789abcdef01';
const PANEL = '019210ab-cdef-7012-8345-6789abcdef02';

const item = (overrides: Record<string, unknown> = {}) => ({
  id: '019210ab-cdef-7012-8345-000000000001',
  code: 'payments.gateway_review_unresolved',
  category: 'PAYMENTS',
  severity: 'WARN',
  message: 'Reconcile this payment against the gateway.',
  occurrenceCount: 1,
  firstSeenAt: '2026-10-03T08:00:00.000Z',
  lastSeenAt: '2026-10-03T08:00:00.000Z',
  resolvedAt: null,
  read: false,
  link: { target: 'PAYMENT', id: PAYMENT },
  ...overrides,
});

describe('the bell', () => {
  it('draws the unread count, toned by the worst unread severity, and links to the inbox', async () => {
    stubApi([
      {
        url: '/notification-center/summary',
        body: { unread: 3, atLeast: false, highestUnread: 'ERROR' },
      },
    ]);
    renderPage(<NotificationBell />);
    const bell = await screen.findByRole(
      'link',
      { name: /اعلان‌ها: 3/u },
      // The summary is a request; under a loaded runner it can take longer than the default.
      { timeout: 5000 },
    );
    expect(bell.getAttribute('href')).toBe('/notification-center');
    expect(bell.querySelector('.nc-bell-count.danger')?.textContent).toBe('3');
  });

  it('draws no count when nothing is unread', async () => {
    stubApi([
      {
        url: '/notification-center/summary',
        body: { unread: 0, atLeast: false, highestUnread: null },
      },
    ]);
    renderPage(<NotificationBell />);
    const bell = await screen.findByRole('link', { name: 'اعلان‌ها' });
    await waitFor(() => expect(bell.querySelector('.nc-bell-count')).toBeNull());
  });
});

describe('the inbox', () => {
  it('lists notifications with a Persian title, severity, category, count and a deep link', async () => {
    stubApi([
      {
        url: '/notification-center',
        body: {
          notifications: [
            item(),
            item({
              id: '019210ab-cdef-7012-8345-000000000002',
              code: 'panel.health.unreachable',
              category: 'PANELS',
              severity: 'ERROR',
              occurrenceCount: 4,
              read: true,
              link: { target: 'PANEL', id: PANEL },
            }),
          ],
          nextCursor: null,
        },
      },
    ]);
    renderPage(<NotificationCenterPage permissions={[...PERMISSION_KEYS]} />);
    const payment = await screen.findByRole('listitem', {
      name: 'پرداخت درگاهی نیاز به تطبیق دستی دارد',
    });
    expect(within(payment).getByText('جدید')).toBeTruthy();
    expect(within(payment).getByText('هشدار')).toBeTruthy();
    expect(within(payment).getByText('پرداخت‌ها')).toBeTruthy();
    expect(within(payment).getByRole('link', { name: 'مشاهده' }).getAttribute('href')).toBe(
      `/payments/${PAYMENT}`,
    );
    const panel = screen.getByRole('listitem', { name: 'وضعیت پنل نیاز به بررسی دارد' });
    expect(within(panel).queryByText('جدید')).toBeNull();
    expect(within(panel).getByRole('link', { name: 'مشاهده' }).getAttribute('href')).toBe(
      `/panels/${PANEL}`,
    );
    expect(panel.textContent).toContain('تکرار');
  });

  it('marks one read or unread, and all read, by POSTs the server decides', async () => {
    const api = stubApi([
      { url: '/notification-center', body: { notifications: [item()], nextCursor: null } },
      { url: '/notification-center/read-all', body: { marked: 1 } },
      {
        url: `/notification-center/${item().id}/read`,
        body: { notification: item({ read: true }) },
      },
    ]);
    renderPage(<NotificationCenterPage permissions={['payments.view']} />);
    const row = await screen.findByRole('listitem', {
      name: 'پرداخت درگاهی نیاز به تطبیق دستی دارد',
    });
    fireEvent.click(within(row).getByRole('button', { name: 'خوانده شد' }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith(`/${item().id}/read`))).toBe(true),
    );
    expect(api.calls.find((call) => call.url.endsWith('/read'))?.body).toEqual({ read: true });

    fireEvent.click(screen.getByRole('button', { name: 'همه را خوانده‌شده کن' }));
    await screen.findByText('اعلان‌ها خوانده‌شده علامت خوردند.');
    expect(api.calls.find((call) => call.url.endsWith('/read-all'))?.method).toBe('POST');
  });

  it('offers only the categories the administrator may see, and asks for unread by default', async () => {
    const api = stubApi([
      { url: '/notification-center', body: { notifications: [], nextCursor: null } },
    ]);
    renderPage(<NotificationCenterPage permissions={['payments.view', 'panels.view']} />);
    await screen.findByText('همهٔ اعلان‌ها خوانده شده‌اند.');
    const select = screen.getByRole('combobox', { name: 'دسته' });
    const options = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual(['همهٔ دسته‌ها', 'پرداخت‌ها', 'پنل‌ها']);
    expect(api.calls[0]?.url).toContain('unread=true');
  });
});

describe('the deep links', () => {
  it('turns every target into a path the shell serves, never with an id it was not given', () => {
    for (const target of NOTIFICATION_LINK_TARGETS) {
      const path = pathOf({ target, id: null });
      expect(path.startsWith('/'), target).toBe(true);
      expect(path).not.toContain('null');
    }
    expect(pathOf({ target: 'SERVICE', id: PAYMENT })).toBe(`/services/${PAYMENT}`);
    expect(pathOf({ target: 'ADMINS', id: null })).toBe('/system?section=admins');
  });
});

describe('the titles', () => {
  it('give every exact rule its own Persian title, never the bare category', () => {
    for (const rule of NOTIFICATION_RULES) {
      if (rule.code === undefined) continue;
      expect(titleOf(rule.code, rule.category), rule.code).not.toBe(
        t(CATEGORY_LABELS[rule.category]),
      );
    }
  });
});
