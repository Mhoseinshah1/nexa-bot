import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { OrdersPage } from '../../apps/web/src/pages/orders';
import { ServicesPage } from '../../apps/web/src/pages/services';
import { LIST_SEARCH_DEBOUNCE_MS } from '../../apps/web/src/ui/list-search';
import { navigate, useRoute } from '../../apps/web/src/router';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

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

  it('draws nothing before the first answer, and nothing when the list is refused', async () => {
    stubApi([
      {
        url: '/orders',
        status: 403,
        body: {
          error: { kind: 'FORBIDDEN', code: 'access.denied', message: 'no', correlationId: 'c' },
        },
      },
    ]);
    renderPage(<LiveOrders />);
    expect(screen.queryByRole('button', { name: t('web.list_refresh') })).toBeNull();
    await waitFor(() => expect(document.querySelector('.empty')).not.toBeNull());
    expect(screen.queryByRole('button', { name: t('web.list_refresh') })).toBeNull();
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
