import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { OrdersPage } from '../../apps/web/src/pages/orders';
import { ServicesPage } from '../../apps/web/src/pages/services';
import { LIST_SEARCH_DEBOUNCE_MS } from '../../apps/web/src/ui/list-search';
import { navigate, useRoute } from '../../apps/web/src/router';
import { t } from '../../apps/web/src/i18n/web.fa';
import { customer, order, renderPage, stubApi } from './harness';
import { UsersPage } from '../../apps/web/src/pages/users';

/**
 * Roadmap B1/B4: the list polish on /orders and /services (and, through the same
 * components, /users and /tickets).
 *
 * Rendered through the LIVE route, as `customer-search.test.tsx` renders /users: the
 * controls under test act by navigating, and only a page that re-reads the URL shows what
 * that navigation asked the server.
 */

function LiveOrders() {
  const route = useRoute();
  return <OrdersPage route={route} denied={false} />;
}

function LiveUsers() {
  const route = useRoute();
  return <UsersPage route={route} maySearch denied={false} />;
}

function LiveServices() {
  const route = useRoute();
  return <ServicesPage route={route} denied={false} />;
}

const ordersList = [{ url: '/orders', body: { orders: [], nextCursor: null } }];
const orderReads = (calls: readonly { url: string; method: string }[]) =>
  calls.filter(
    (call) => call.method === 'GET' && new URL(call.url, 'http://x').pathname.endsWith('/orders'),
  );

afterEach(() => {
  vi.useRealTimers();
});

describe('how fresh a list is', () => {
  beforeEach(() => navigate('/orders', { replace: true, force: true }));

  it('says when the rows were read, and reads them again on request', async () => {
    const api = stubApi(ordersList);
    renderPage(<LiveOrders />);
    expect(await screen.findByText(/^خوانده‌شده در /)).toBeInTheDocument();
    const before = orderReads(api.calls).length;
    fireEvent.click(screen.getByRole('button', { name: t('web.list_refresh') }));
    await waitFor(() => expect(orderReads(api.calls).length).toBe(before + 1));
    // Same filters: the refresh re-reads THIS list, not a fresh one.
    expect(new URL(orderReads(api.calls).at(-1)!.url, 'http://x').search).toBe('');
  });

  it('draws nothing before the first answer, and is withdrawn once the list is refused', async () => {
    stubApi(ordersList);
    renderPage(<LiveOrders />);
    expect(screen.queryByRole('button', { name: t('web.list_refresh') })).toBeNull();
    const refresh = await screen.findByRole('button', { name: t('web.list_refresh') });
    // The permission is withdrawn: the next read is refused, and a refresh would ask again.
    stubApi([
      {
        url: '/orders',
        status: 403,
        body: {
          error: { kind: 'FORBIDDEN', code: 'access.denied', message: 'no', correlationId: 'c' },
        },
      },
    ]);
    fireEvent.click(refresh);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: t('web.list_refresh') })).toBeNull(),
    );
  });
});

describe('clearing every filter at once', () => {
  it('is offered only while a filter is applied, and clears all of them in one navigation', async () => {
    navigate('/orders?state=PAID&q=ali', { replace: true, force: true });
    stubApi(ordersList);
    renderPage(<LiveOrders />);
    const clear = await screen.findByRole('button', { name: t('web.list_filters_clear') });
    fireEvent.click(clear);
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(screen.queryByRole('button', { name: t('web.list_filters_clear') })).toBeNull();
  });

  it('clears the service list filters and its cursor together', async () => {
    navigate('/services?deliveryState=FAILED&panelId=p1&cursor=c9', {
      replace: true,
      force: true,
    });
    stubApi([{ url: '/services', body: { services: [], nextCursor: null } }]);
    renderPage(<LiveServices />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.list_filters_clear') }));
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('is not drawn on an unfiltered list', async () => {
    navigate('/orders', { replace: true, force: true });
    stubApi(ordersList);
    renderPage(<LiveOrders />);
    await screen.findByText(/^خوانده‌شده در /);
    expect(screen.queryByRole('button', { name: t('web.list_filters_clear') })).toBeNull();
  });
});

describe('the order search applies itself', () => {
  it('sends one request after the debounce, as /users does', async () => {
    navigate('/orders', { replace: true, force: true });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = stubApi(ordersList);
    renderPage(<LiveOrders />);
    await screen.findByText(/^خوانده‌شده در /);
    const before = orderReads(api.calls).length;
    fireEvent.change(screen.getByLabelText(t('web.list_search_label')), {
      target: { value: 'ali' },
    });
    await act(() => vi.advanceTimersByTimeAsync(LIST_SEARCH_DEBOUNCE_MS - 250));
    expect(orderReads(api.calls).length).toBe(before);
    await act(() => vi.advanceTimersByTimeAsync(500));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('q')).toBe('ali'));
    await waitFor(() => expect(orderReads(api.calls).length).toBe(before + 1));
  });
});

/**
 * Review of #242 (N1/C5): the keyset trail lives in component state, keyed by the filter it
 * was minted under. Ignoring it under another filter was not enough: when the filter came
 * back — a cleared filter, or a search typed away and back — the old trail returned, and the
 * list reopened on page two.
 */
describe('the cursor trail after a filter change', () => {
  const lastRead = (calls: readonly { url: string; method: string }[], path: string) =>
    calls
      .filter((c) => c.method === 'GET' && new URL(c.url, 'http://x').pathname.endsWith(path))
      .at(-1)!;

  // `GET /orders` pages ascending, so its "next" button is «تازه‌تر».
  it('starts the orders list again from its first page when every filter is cleared', async () => {
    navigate('/orders', { replace: true, force: true });
    const api = stubApi([{ url: '/orders', body: { orders: [order()], nextCursor: 'C2' } }]);
    renderPage(<LiveOrders />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.newer') }));
    await waitFor(() => expect(lastRead(api.calls, '/orders').url).toContain('cursor=C2'));
    fireEvent.click(screen.getByRole('button', { name: t('web.order_state_paid') }));
    await waitFor(() => expect(lastRead(api.calls, '/orders').url).toContain('state=PAID'));
    fireEvent.click(await screen.findByRole('button', { name: t('web.list_filters_clear') }));
    await waitFor(() => expect(window.location.search).toBe(''));
    await waitFor(() => expect(lastRead(api.calls, '/orders').url).not.toContain('state='));
    expect(lastRead(api.calls, '/orders').url).not.toContain('cursor=');
  });

  it('starts again when a search is typed away and back (ali, alir, ali)', async () => {
    navigate('/orders?q=ali', { replace: true, force: true });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = stubApi([{ url: '/orders', body: { orders: [order()], nextCursor: 'C2' } }]);
    renderPage(<LiveOrders />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.newer') }));
    await waitFor(() => expect(lastRead(api.calls, '/orders').url).toContain('cursor=C2'));
    const box = screen.getByLabelText(t('web.list_search_label'));
    fireEvent.change(box, { target: { value: 'alir' } });
    await act(() => vi.advanceTimersByTimeAsync(LIST_SEARCH_DEBOUNCE_MS + 250));
    await waitFor(() => expect(lastRead(api.calls, '/orders').url).toContain('q=alir'));
    fireEvent.change(box, { target: { value: 'ali' } });
    await act(() => vi.advanceTimersByTimeAsync(LIST_SEARCH_DEBOUNCE_MS + 250));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('q')).toBe('ali'));
    await waitFor(() => expect(lastRead(api.calls, '/orders').url).not.toContain('q=alir'));
    expect(lastRead(api.calls, '/orders').url).not.toContain('cursor=');
  });

  it('starts the customer list again from its first page when every filter is cleared', async () => {
    navigate('/users', { replace: true, force: true });
    const api = stubApi([
      { url: '/users', body: { customers: [customer()], nextCursor: 'C2' } },
      { url: '/customer-tags', body: { tags: [] } },
    ]);
    renderPage(<LiveUsers />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.newer') }));
    await waitFor(() => expect(lastRead(api.calls, '/users').url).toContain('cursor=C2'));
    fireEvent.click(screen.getByRole('button', { name: t('web.user_status_blocked') }));
    await waitFor(() => expect(lastRead(api.calls, '/users').url).toContain('status=BLOCKED'));
    fireEvent.click(await screen.findByRole('button', { name: t('web.list_filters_clear') }));
    await waitFor(() => expect(window.location.search).toBe(''));
    // The first page of the unfiltered list (served from cache here, so asked of the pager):
    // no trail behind it, so nothing to go back to.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: t('web.older') })).toBeDisabled(),
    );
    expect(lastRead(api.calls, '/users').url).not.toContain('cursor=');
  });
});
