import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, NAV_PREFETCH } from '../../apps/web/src/app';
import { NAV_PREFETCH_FRESH_MS, prefetchNav } from '../../apps/web/src/nav-prefetch';
import { createQueryClient } from '../../apps/web/src/query-client';
import { navigate } from '../../apps/web/src/router';
import { t } from '../../apps/web/src/i18n/web.fa';
import { customer, sidebarLink, stubApi } from './harness';

/**
 * Navigation between Web Admin pages (Issue 16, `docs/perf/web-admin-navigation.md`).
 *
 * What is pinned here is what the benchmark measured and what the fix relies on, each a
 * rule rather than a timing — no stopwatch runs in this suite:
 *
 *   - the shell is never remounted by a navigation;
 *   - pointing at a link asks for the page's first screen ONCE, and the page arriving
 *     after it does not ask again (and a prefetch still in flight is joined, not
 *     repeated);
 *   - a prefetch is only ever a request the page itself would send, for an actor who
 *     holds the page's own permission;
 *   - a prefetch is keyed like the page, so it can never answer a different filter;
 *   - a prefetch still in flight at sign-out cannot write the operator's rows back.
 */

const SESSION = {
  admin: {
    id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
    username: 'owner',
    displayName: 'مدیر اصلی',
    status: 'ACTIVE',
    telegramUserId: null,
    roleKeys: ['operator'],
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: '2026-09-06T08:00:00.000Z',
  },
  permissions: ['users.view', 'users.search', 'audit.view', 'settings.view'],
  expiresAt: '2026-09-07T08:00:00.000Z',
};

const ROUTES = [
  { url: '/auth/session', body: SESSION },
  { url: '/health/info', body: { version: '1', commit: 'abc', builtAt: null } },
  { url: '/users', body: { customers: [customer()], nextCursor: null } },
  { url: '/customer-tags', body: { tags: [] } },
  { url: '/audit-log', body: { entries: [], nextCursor: null } },
  { url: '/settings', body: { settings: [] } },
];

const renderShell = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return {
    ...render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    ),
    client,
  };
};

/** The GETs of one API path (`/users` but not `/users/…`), from the harness log. */
const getsOf = (calls: readonly { url: string; method: string }[], path: string) =>
  calls.filter((call) => {
    if (call.method !== 'GET') return false;
    const { pathname } = new URL(call.url, 'http://localhost');
    return pathname === `/api/admin/v1${path}`;
  }).length;

const link = (label: string) => sidebarLink(t(label as never));

beforeEach(() => {
  act(() => navigate('/', { replace: true, force: true }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('navigating between pages', () => {
  it('keeps the same sidebar and top bar across every page it opens', async () => {
    stubApi(ROUTES);
    renderShell();
    await screen.findByText('مدیر اصلی');
    const sidebar = document.querySelector('aside.sidebar');
    const topbar = document.querySelector('header.topbar');
    expect(sidebar).not.toBeNull();
    expect(topbar).not.toBeNull();

    for (const [label, path] of [
      ['web.nav_users', '/users'],
      ['web.nav_audit_log', '/audit-log'],
      ['web.nav_settings', '/settings'],
      ['web.nav_users', '/users'],
    ] as const) {
      fireEvent.click(link(label));
      await waitFor(() => expect(window.location.pathname).toBe(path));
      // The SAME nodes: a remount would replace them, and with them every bit of state
      // the shell holds (the drawer, the search, the counters' cache observers).
      expect(document.querySelector('aside.sidebar')).toBe(sidebar);
      expect(document.querySelector('header.topbar')).toBe(topbar);
    }
  });
});

describe('the sidebar prefetch', () => {
  it('asks for the page once on pointing, and the page arriving after it does not ask again', async () => {
    const api = stubApi(ROUTES);
    renderShell();
    await screen.findByText('مدیر اصلی');
    expect(getsOf(api.calls, '/users')).toBe(0);

    fireEvent.pointerEnter(link('web.nav_users'));
    // Pointing again, and focusing, are the same intent: still one request each.
    fireEvent.pointerEnter(link('web.nav_users'));
    fireEvent.focus(link('web.nav_users'));
    await waitFor(() => expect(getsOf(api.calls, '/users')).toBe(1));
    expect(getsOf(api.calls, '/customer-tags')).toBe(1);

    fireEvent.click(link('web.nav_users'));
    await screen.findByText('5551234567');
    // Settled: the page drew the prefetched rows and sent nothing of its own.
    await act(async () => {
      await new Promise((done) => setTimeout(done, 50));
    });
    expect(getsOf(api.calls, '/users')).toBe(1);
    expect(getsOf(api.calls, '/customer-tags')).toBe(1);
  });

  it('prefetches on keyboard focus, as it does on pointing', async () => {
    const api = stubApi(ROUTES);
    renderShell();
    await screen.findByText('مدیر اصلی');
    expect(getsOf(api.calls, '/settings')).toBe(0);
    fireEvent.focus(link('web.nav_settings'));
    await waitFor(() => expect(getsOf(api.calls, '/settings')).toBe(1));
  });

  it('reads the audit log again after a write, even inside its freshness window', async () => {
    /*
     * Every write appends an audit row and no page's mutation names the log, so the
     * production client invalidates it after every settled mutation. Without that, an
     * operator who pointed at Audit Log, saved something and opened Audit Log within
     * five seconds was shown the read from before the save.
     */
    const api = stubApi(ROUTES);
    const client = createQueryClient();
    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
    await screen.findByText('مدیر اصلی');
    fireEvent.pointerEnter(link('web.nav_audit_log'));
    await waitFor(() => expect(getsOf(api.calls, '/audit-log')).toBe(1));

    // Any mutation through the client's mutation cache, as every page's `useMutation` is.
    await act(async () => {
      await client
        .getMutationCache()
        .build(client, { mutationFn: () => Promise.resolve(null) })
        .execute(undefined);
    });

    fireEvent.click(link('web.nav_audit_log'));
    await waitFor(() => expect(getsOf(api.calls, '/audit-log')).toBe(2));
  });

  it('joins a prefetch still in flight instead of sending a second request', async () => {
    const api = stubApi(ROUTES);
    // Hold the audit log's answer until the page has mounted on top of the prefetch.
    const answered = vi.fn();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const harness = globalThis.fetch;
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) =>
      String(input).includes('/audit-log')
        ? gate.then(() => {
            answered();
            return harness(input as RequestInfo, init);
          })
        : harness(input as RequestInfo, init),
    );
    renderShell();
    await screen.findByText('مدیر اصلی');

    fireEvent.pointerEnter(link('web.nav_audit_log'));
    fireEvent.click(link('web.nav_audit_log'));
    await waitFor(() => expect(window.location.pathname).toBe('/audit-log'));
    release();
    await waitFor(() => expect(answered).toHaveBeenCalled());
    await act(async () => {
      await new Promise((done) => setTimeout(done, 50));
    });
    expect(answered).toHaveBeenCalledTimes(1);
    expect(getsOf(api.calls, '/audit-log')).toBe(1);
  });

  it('asks the page again once its first screen is older than the freshness window', async () => {
    const api = stubApi(ROUTES);
    renderShell();
    await screen.findByText('مدیر اصلی');
    fireEvent.click(link('web.nav_settings'));
    await waitFor(() => expect(getsOf(api.calls, '/settings')).toBe(1));
    fireEvent.click(link('web.nav_users'));
    await screen.findByText('5551234567');

    // Within the window: back to Settings draws what it read without asking.
    fireEvent.click(link('web.nav_settings'));
    await waitFor(() => expect(window.location.pathname).toBe('/settings'));
    expect(getsOf(api.calls, '/settings')).toBe(1);

    // Past it: a revisit refreshes, exactly as every visit did before the prefetch.
    fireEvent.click(link('web.nav_users'));
    await screen.findByText('5551234567');
    const later = Date.now() + NAV_PREFETCH_FRESH_MS + 1;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      fireEvent.click(link('web.nav_settings'));
      await waitFor(() => expect(getsOf(api.calls, '/settings')).toBe(2));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('never asks for a page whose own permission the actor does not hold', async () => {
    const api = stubApi(ROUTES);
    const client = new QueryClient();
    // `audit.view` is the page's gate; holding the others is not enough.
    prefetchNav(client, NAV_PREFETCH, '/audit-log', ['users.view', 'settings.view']);
    // A path with no entry asks for nothing, whatever the actor holds.
    prefetchNav(client, NAV_PREFETCH, '/payments', ['payments.view']);
    prefetchNav(client, NAV_PREFETCH, 'constructor', ['users.view']);
    await act(async () => {
      await new Promise((done) => setTimeout(done, 20));
    });
    expect(api.calls).toHaveLength(0);

    prefetchNav(client, NAV_PREFETCH, '/audit-log', ['audit.view']);
    await waitFor(() => expect(getsOf(api.calls, '/audit-log')).toBe(1));
  });

  it('prefetches only non-financial reference pages, each under its page gate', () => {
    // Adding a page here is a decision about how fresh it must be, not a tuning: no page
    // that shows a balance, a payment, an order or a panel's health belongs in it.
    expect(
      Object.fromEntries(
        Object.entries(NAV_PREFETCH).map(([path, entry]) => [path, entry.permission]),
      ),
    ).toEqual({
      '/users': 'users.view',
      '/audit-log': 'audit.view',
      '/settings': 'settings.view',
    });
  });

  it('never lets a prefetch of the bare page answer a filtered one', async () => {
    const api = stubApi(ROUTES);
    const { client } = renderShell();
    await screen.findByText('مدیر اصلی');

    fireEvent.pointerEnter(link('web.nav_audit_log'));
    await waitFor(() => expect(getsOf(api.calls, '/audit-log')).toBe(1));
    act(() => navigate('/audit-log?result=DENIED'));

    // The filtered page asked its OWN question; the bare page's answer is not it.
    await waitFor(() => expect(getsOf(api.calls, '/audit-log')).toBe(2));
    const keys = client
      .getQueryCache()
      .findAll({ queryKey: ['audit-log'] })
      .map((query) => query.queryKey[1]);
    expect(keys).toEqual(expect.arrayContaining(['{}', JSON.stringify({ result: 'DENIED' })]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never lets the bare customer list answer a searched one', async () => {
    // Issue 13 searches as the operator types; each applied term is its own question.
    const api = stubApi(ROUTES);
    const { client } = renderShell();
    await screen.findByText('مدیر اصلی');

    fireEvent.pointerEnter(link('web.nav_users'));
    await waitFor(() => expect(getsOf(api.calls, '/users')).toBe(1));
    act(() => navigate('/users?q=ali_tehran'));

    await waitFor(() =>
      expect(
        api.calls.some(
          (call) =>
            call.method === 'GET' &&
            new URL(call.url, 'http://localhost').searchParams.get('q') === 'ali_tehran',
        ),
      ).toBe(true),
    );
    const keys = client
      .getQueryCache()
      .findAll({ queryKey: ['customers'] })
      .map((query) => query.queryKey[1]);
    expect(keys).toEqual(expect.arrayContaining(['||', '||ali_tehran']));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('cannot write a prefetch still in flight back into the cache after sign-out', async () => {
    stubApi(ROUTES);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const harness = globalThis.fetch;
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) =>
      new URL(String(input), 'http://localhost').pathname === '/api/admin/v1/users'
        ? gate.then(() => harness(input as RequestInfo, init))
        : harness(input as RequestInfo, init),
    );
    const { client } = renderShell();
    await screen.findByText('مدیر اصلی');

    fireEvent.pointerEnter(link('web.nav_users'));
    await waitFor(() =>
      expect(client.getQueryCache().find({ queryKey: ['customers'], exact: false })).toBeDefined(),
    );

    // Signed out from here on; the gated `/users` answer is still the first operator's.
    stubApi([
      { url: '/auth/logout', body: { ok: true } },
      {
        url: '/auth/session',
        status: 401,
        body: {
          error: {
            kind: 'UNAUTHENTICATED',
            code: 'auth.no_session',
            message: 'no',
            correlationId: 'c',
          },
        },
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'حساب کاربری' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'خروج' }));
    await screen.findByLabelText('گذرواژه');

    release();
    await act(async () => {
      await new Promise((done) => setTimeout(done, 50));
    });
    expect(
      client.getQueryCache().find({ queryKey: ['customers'], exact: false })?.state.data,
      "a prefetch landed the previous operator's customers after sign-out",
    ).toBeUndefined();
  });
});
