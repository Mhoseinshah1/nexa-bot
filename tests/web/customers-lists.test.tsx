import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { USER_PRESETS, UsersPage } from '../../apps/web/src/pages/users';
import { urlViewsRegistration } from '../../apps/web/src/pages/commerce-parts';
import { navigate, useRoute } from '../../apps/web/src/router';
import { t } from '../../apps/web/src/i18n/web.fa';
import { customer, renderPage, stubApi } from './harness';
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
    fireEvent.click(await screen.findByRole('button', { name: t('web.newer') }));
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
    expect(screen.queryByText(t('web.users_scope_title'))).toBeNull();
  });
});

describe('saved filters are the URL filter keys', () => {
  it('reads the keys from the route and applies a view in one navigation that drops the cursor', () => {
    navigate('/users?status=ACTIVE&q=ali&cursor=C3&other=1', { replace: true, force: true });
    const route = {
      path: '/users',
      query: new URLSearchParams(window.location.search),
    };
    const views = urlViewsRegistration(route, 'users', ['q', 'status', 'tag'], USER_PRESETS);
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
