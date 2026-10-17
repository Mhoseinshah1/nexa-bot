import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { USER_PRESETS, UsersPage } from '../../apps/web/src/pages/users';
import { SERVICE_PRESETS, ServicesPage } from '../../apps/web/src/pages/services';
import { ORDER_PRESETS, OrderDetailPage, OrdersPage } from '../../apps/web/src/pages/orders';
import { routeViewRegistration } from '../../apps/web/src/ui/saved-views';
import { navigate, useRoute } from '../../apps/web/src/router';
import { t } from '../../apps/web/src/i18n/web.fa';
import { customer, order, renderPage, stubApi } from './harness';
import { openFilterPanel } from './ui-helpers';

/**
 * The demo's list pass on /users (W1.3, W1.4, W1.8, W5): one filter bar, saved filters
 * that are the URL's own filter keys, ten rows a page, and no «آنچه در این نسخه نیست».
 */

const VIP = '019210ab-cdef-7012-8345-00000000a001';
const OLD = '019210ab-cdef-7012-8345-00000000a002';
const tag = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
  id,
  label,
  color: null,
  archivedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...extra,
});
const TAGS = [tag(VIP, 'ویژه'), tag(OLD, 'قدیمی', { archivedAt: '2026-09-03T00:00:00.000Z' })];

function LiveUsers() {
  const route = useRoute();
  return <UsersPage route={route} maySearch denied={false} />;
}

const usersReads = (calls: readonly { url: string; method: string }[]) =>
  calls.filter(
    (call) => call.method === 'GET' && new URL(call.url, 'http://x').pathname.endsWith('/users'),
  );

describe('the customer list (W1)', () => {
  it('asks the server for ten customers a page, keyset paging kept', async () => {
    navigate('/users', { replace: true, force: true });
    const api = stubApi([
      { url: '/users', body: { customers: [customer()], nextCursor: 'C2' } },
      { url: '/customer-tags', body: { tags: [] } },
    ]);
    renderPage(<LiveUsers />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.page_next') }));
    await waitFor(() => expect(usersReads(api.calls).at(-1)!.url).toContain('cursor=C2'));
    for (const call of usersReads(api.calls)) {
      expect(new URL(call.url, 'http://x').searchParams.get('limit')).toBe('10');
    }
  });

  it('draws an active filter as a chip with its Persian value, and clears two in one navigation', async () => {
    navigate(`/users?status=BLOCKED&tag=${OLD}&q=ali&cursor=C9`, { replace: true, force: true });
    stubApi([
      { url: '/users', body: { customers: [customer()], nextCursor: null } },
      { url: '/customer-tags', body: { tags: TAGS } },
    ]);
    renderPage(<LiveUsers />);
    await screen.findByText(customer().telegramUserId as string);
    // The archived tag reads by its label, never by its id.
    const archived = t('web.users_filter_tag_archived').replace('{label}', 'قدیمی');
    await waitFor(() =>
      expect(document.body.textContent).toContain(`${t('web.users_filter_tag')}: ${archived}`),
    );
    expect(document.body.textContent).toContain(
      `${t('web.status')}: ${t('web.user_status_blocked')}`,
    );
    fireEvent.click(screen.getByRole('button', { name: t('web.filters_clear_all') }));
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('offers the status filter inside the panel, and the tag filter once the catalogue answers', async () => {
    navigate('/users', { replace: true, force: true });
    stubApi([
      { url: '/users', body: { customers: [customer()], nextCursor: null } },
      { url: '/customer-tags', body: { tags: TAGS } },
    ]);
    renderPage(<LiveUsers />);
    await screen.findByText(customer().telegramUserId as string);
    await waitFor(() => {
      const panel = openFilterPanel();
      expect(within(panel).getByLabelText(t('web.users_filter_tag'))).toBeInTheDocument();
    });
    fireEvent.click(
      within(openFilterPanel()).getByRole('button', { name: t('web.user_status_active') }),
    );
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get('status')).toBe('ACTIVE'),
    );
  });

  it('no longer draws the «not in this version» card', async () => {
    navigate('/users', { replace: true, force: true });
    stubApi([
      { url: '/users', body: { customers: [customer()], nextCursor: null } },
      { url: '/customer-tags', body: { tags: [] } },
    ]);
    renderPage(<LiveUsers />);
    await screen.findByText(customer().telegramUserId as string);
    expect(
      screen.queryByText(/* former web.users_scope_title */ 'آنچه در این نسخه نیست'),
    ).toBeNull();
  });
});

describe('saved filters are the URL filter keys', () => {
  it('reads the keys from the route and applies a view in one navigation that drops the cursor', () => {
    navigate('/users?status=ACTIVE&q=ali&cursor=C3&other=1', { replace: true, force: true });
    const route = {
      path: '/users',
      query: new URLSearchParams(window.location.search),
    };
    const views = routeViewRegistration(route, 'users', ['q', 'status', 'tag'], USER_PRESETS);
    expect(views.empty).toEqual({ q: '', status: '', tag: '' });
    expect(views.get()).toEqual({ q: 'ali', status: 'ACTIVE', tag: '' });
    views.set({ status: 'BLOCKED' });
    const after = new URLSearchParams(window.location.search);
    expect(after.get('status')).toBe('BLOCKED');
    expect(after.get('q')).toBeNull();
    expect(after.get('cursor')).toBeNull();
    // A key the list does not own is left alone.
    expect(after.get('other')).toBe('1');
  });

  it('suggests exactly the demo presets for /users', () => {
    expect(USER_PRESETS.map((preset) => [t(preset.name), preset.state])).toEqual([
      [t('web.users_view_blocked'), { status: 'BLOCKED' }],
    ]);
  });
});

describe('the service list (W1, W3)', () => {
  function LiveServices({ mass = false }: { mass?: boolean }) {
    const route = useRoute();
    return <ServicesPage route={route} denied={false} mayMassStatus={mass} mayMassGrant={mass} />;
  }
  const empty = [{ url: '/services', body: { services: [], nextCursor: null } }];

  it('asks the server for ten services a page', async () => {
    navigate('/services', { replace: true, force: true });
    const api = stubApi(empty);
    renderPage(<LiveServices />);
    await screen.findByText(t('web.services_empty'));
    const read = api.calls.find((call) =>
      new URL(call.url, 'http://x').pathname.endsWith('/services'),
    );
    expect(new URL(read!.url, 'http://x').searchParams.get('limit')).toBe('10');
  });

  it('suggests exactly the demo presets for /services, on the URL keys the page reads', () => {
    expect(SERVICE_PRESETS.map((preset) => [t(preset.name), preset.state])).toEqual([
      [t('web.services_view_expiring_3d'), { state: 'ACTIVE', expiring: '72' }],
      [t('web.services_view_expiring_24h'), { state: 'ACTIVE', expiring: '24' }],
      [t('web.services_view_unreconciled'), { state: 'UNRECONCILED' }],
      [t('web.services_view_delivery_failed'), { deliveryState: 'FAILED' }],
      [t('web.services_view_suspended'), { state: 'SUSPENDED' }],
    ]);
  });

  it('opens the mass action in a drawer from the head, and asks before dropping a typed value', async () => {
    navigate('/services', { replace: true, force: true });
    stubApi(empty);
    renderPage(<LiveServices mass />);
    await screen.findByText(t('web.services_empty'));
    // Not on the page until asked for.
    expect(screen.queryByLabelText(t('web.bulk_kind'))).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('web.soc_mass_title') }));
    const drawer = screen.getByRole('dialog', { name: t('web.soc_mass_title') });
    fireEvent.change(within(drawer).getByLabelText(t('web.bulk_kind')), {
      target: { value: 'SERVICE_TIME' },
    });
    fireEvent.change(within(drawer).getByLabelText(t('web.bulk_days_label')), {
      target: { value: '3' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: t('web.close') }));
    const ask = await screen.findByRole('alertdialog');
    expect(ask).toHaveTextContent(t('web.unsaved_title'));
    fireEvent.click(within(ask).getByRole('button', { name: t('web.unsaved_stay') }));
    expect(screen.getByLabelText(t('web.bulk_days_label'))).toHaveValue('3');
  });

  it('offers no mass action without either mass permission', async () => {
    navigate('/services', { replace: true, force: true });
    stubApi(empty);
    renderPage(<LiveServices />);
    await screen.findByText(t('web.services_empty'));
    expect(screen.queryByRole('button', { name: t('web.soc_mass_title') })).toBeNull();
  });
});

describe('the order list and page (W1, W4)', () => {
  function LiveOrders() {
    const route = useRoute();
    return <OrdersPage route={route} denied={false} />;
  }

  it('asks the server for ten orders a page, and suggests exactly the demo presets', async () => {
    navigate('/orders', { replace: true, force: true });
    const api = stubApi([{ url: '/orders', body: { orders: [], nextCursor: null } }]);
    renderPage(<LiveOrders />);
    await screen.findByText(t('web.orders_empty'));
    const read = api.calls.find((call) =>
      new URL(call.url, 'http://x').pathname.endsWith('/orders'),
    );
    expect(new URL(read!.url, 'http://x').searchParams.get('limit')).toBe('10');
    expect(ORDER_PRESETS.map((preset) => [t(preset.name), preset.state])).toEqual([
      [t('web.orders_view_awaiting'), { state: 'AWAITING_PAYMENT' }],
      [t('web.orders_view_refunded'), { state: 'REFUNDED' }],
    ]);
  });

  it('draws the pricing under the two balanced columns, never in the tall one', async () => {
    stubApi([{ url: '/orders/019230ab', body: { order: order() } }]);
    const { container } = renderPage(
      <OrderDetailPage
        id="019230ab-cdef-7012-8345-6789abcdef01"
        denied={false}
        mayViewPayments={false}
        mayViewServices={false}
      />,
    );
    await screen.findByText(t('web.order_line_title'));
    const balanced = container.querySelector('.wb-balance');
    const tail = container.querySelector('.wb-balance-tail');
    expect(balanced).not.toBeNull();
    expect(tail).not.toBeNull();
    // The snapshot and the lifecycle side by side; pricing and the service underneath.
    expect(
      within(balanced as HTMLElement).getByText(t('web.order_line_title')),
    ).toBeInTheDocument();
    expect(
      within(balanced as HTMLElement).getByText(t('web.order_lifecycle_title')),
    ).toBeInTheDocument();
    expect(within(tail as HTMLElement).getByText(t('web.order_service_title'))).toBeInTheDocument();
    expect(
      screen.queryByText(/* former web.orders_scope_title */ 'دو پایان ممکن برای یک سفارش'),
    ).toBeNull();
  });
});
