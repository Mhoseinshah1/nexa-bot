import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { App } from '../../apps/web/src/app';
import { navigate } from '../../apps/web/src/router';
import { t } from '../../apps/web/src/i18n/web.fa';
import {
  GLOBAL_SEARCH_MIN_CHARS,
  searchHitPath,
  searchHitStateLabel,
} from '../../apps/web/src/global-search';
import { renderPage, stubApi } from './harness';

/**
 * R11 A1: the top-bar search finds customers, orders and services. The server decides which
 * kinds the operator may read; the page draws the groups it is given and derives no permission.
 */

const ADMIN = {
  id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
  username: 'sara',
  displayName: 'سارا احمدی',
  status: 'ACTIVE',
  telegramUserId: null,
  roleKeys: ['operator'],
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: '2026-09-06T08:00:00.000Z',
};
const session = (permissions: readonly string[]) => ({
  url: '/auth/session',
  body: { admin: ADMIN, permissions, expiresAt: '2026-09-07T08:00:00.000Z' },
});

const CUSTOMER_ID = '01a05e35-c9ad-7e93-bef3-1ed9b5529001';
const ORDER_ID = '01a05e35-c9ad-7e93-bef3-1ed9b5529002';

const FOUND = {
  url: '/search',
  body: {
    groups: [
      {
        kind: 'CUSTOMER',
        hasMore: true,
        hits: [
          {
            id: CUSTOMER_ID,
            title: 'Ali Rezaei',
            subtitle: '@ali_reza · 111111111',
            state: 'ACTIVE',
          },
        ],
      },
      {
        kind: 'ORDER',
        hasMore: false,
        hits: [{ id: ORDER_ID, title: 'ABCD2345', subtitle: 'Gold Plan Monthly', state: 'PAID' }],
      },
    ],
  },
};

beforeEach(() => {
  window.localStorage.clear();
  act(() => navigate('/', { replace: true, force: true }));
});

const open = async () => {
  await screen.findByRole('navigation', { name: t('web.nav_label') });
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  const dialog = screen.getByRole('dialog', { name: t('web.search_label') });
  return { dialog, input: within(dialog).getByRole('combobox') };
};

describe('the top-bar search over records', () => {
  it('asks the server after a pause, draws only the groups it returns, and opens a hit', async () => {
    const api = stubApi([session(['users.view', 'orders.view']), FOUND]);
    renderPage(<App />);
    const { dialog, input } = await open();
    fireEvent.change(input, { target: { value: 'ali' } });
    // Nothing is sent per keystroke: the request follows the pause.
    expect(api.calls.filter((call) => call.url.includes('/search'))).toHaveLength(0);

    await within(dialog).findByText('Ali Rezaei');
    const requests = api.calls.filter((call) => call.url.includes('/search?'));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('q=ali');

    // The groups the server sent are drawn under their headings; a kind it left out is not.
    expect(within(dialog).getByText(t('web.search_group_customer'))).toBeInTheDocument();
    expect(within(dialog).getByText(t('web.search_group_order'))).toBeInTheDocument();
    expect(within(dialog).queryByText(t('web.search_group_service'))).toBeNull();
    // The customer group has more than it shows, and says so; the order group does not.
    expect(within(dialog).getAllByText(t('web.search_more'))).toHaveLength(1);
    // State is the Persian name from the catalogue the lists use.
    expect(within(dialog).getByText(t('web.user_status_active'))).toBeInTheDocument();
    expect(within(dialog).getByText(t('web.order_state_paid'))).toBeInTheDocument();

    const hit = within(dialog).getByRole('option', { name: /Ali Rezaei/u });
    expect(hit).toHaveAttribute('href', `/users/${CUSTOMER_ID}`);
    fireEvent.click(hit);
    expect(window.location.pathname).toBe(`/users/${CUSTOMER_ID}`);
    expect(screen.queryByRole('dialog', { name: t('web.search_label') })).toBeNull();
  });

  it('moves through pages then records with the arrow keys and opens the active record on Enter', async () => {
    stubApi([session(['users.view', 'orders.view']), FOUND]);
    renderPage(<App />);
    const { dialog, input } = await open();
    // "سفارش" matches the orders PAGE; the records follow it in the same list.
    fireEvent.change(input, { target: { value: 'ali' } });
    await within(dialog).findByText('ABCD2345');
    const options = within(dialog).getAllByRole('option');
    const pages = options.length - 2;
    for (let step = 0; step < pages + 1; step += 1) fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options[pages + 1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(window.location.pathname).toBe(`/orders/${ORDER_ID}`);
  });

  it('does not search below two characters', async () => {
    const api = stubApi([session(['users.view']), FOUND]);
    renderPage(<App />);
    const { input } = await open();
    expect(GLOBAL_SEARCH_MIN_CHARS).toBe(2);
    fireEvent.change(input, { target: { value: 'a' } });
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(api.calls.filter((call) => call.url.includes('/search?'))).toHaveLength(0);
  });

  it('keeps the pages working, and says so, when the record search is refused', async () => {
    stubApi([
      session(['users.view']),
      {
        url: '/search',
        status: 403,
        body: { error: { kind: 'forbidden', code: 'x', message: 'x', correlationId: 'c' } },
      },
    ]);
    renderPage(<App />);
    const { dialog, input } = await open();
    fireEvent.change(input, { target: { value: t('web.nav_users') } });
    await within(dialog).findByText(t('web.search_failed'));
    expect(within(dialog).getAllByRole('option').length).toBeGreaterThan(0);
  });

  it('opens each kind at its own detail page, with the state name from the existing catalogue', () => {
    expect(searchHitPath('CUSTOMER', 'a b')).toBe('/users/a%20b');
    expect(searchHitPath('ORDER', 'o')).toBe('/orders/o');
    expect(searchHitPath('SERVICE', 's')).toBe('/services/s');
    const hit = { id: 'x', title: 't', subtitle: null, state: 'ACTIVE' };
    expect(searchHitStateLabel('SERVICE', hit)).toBe(t('web.service_state_active'));
    expect(searchHitStateLabel('CUSTOMER', hit)).toBe(t('web.user_status_active'));
    expect(searchHitStateLabel('ORDER', hit)).toBeNull();
    expect(searchHitStateLabel('ORDER', { ...hit, state: null })).toBeNull();
  });
});
