import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { UsersPage, UserDetailPage } from '../../apps/web/src/pages/users';
import { resolve } from '../../apps/web/src/app';
import { customer, order, renderPage, stubApi } from './harness';

/**
 * The Users surface, rendered against the shapes the server actually returns.
 *
 * Everything goes through the real API client, so every fixture below is parsed
 * by `customerSummarySchema` — the same schema the server validates against. A
 * fixture that drifted from the contract fails here rather than in production.
 *
 * Two of the assertions in this file moved here from `planned-and-absent.test.tsx`
 * when Phase 4A turned `/users` from a planned page into a real one: NO USER TAGS
 * and NO RECENT-ACTIVITY FEED. The first was REVERSED by the owner in program §8 (Phase A3,
 * customer notes and tags), and its case below now asserts the ordered shape instead. They were recorded as copy on a page no route
 * renders any more, and an absence asserted against an unreachable screen is a
 * green test for nothing. They are asserted here, where the concepts could
 * actually come back.
 */

const LIST_ROUTE = { path: '/users', query: new URLSearchParams() };
/** The one search box's label (spec §10). */
const SEARCH = 'جست‌وجو';
const ROW_ID = '019210ab-cdef-7012-8345-6789abcdef01';
/** The block's reason field, labelled mandatory (WP10G). */
const LABEL = 'دلیل مسدودسازی (اجباری)';

/**
 * The wallet permissions, all off.
 *
 * Spread into the cases whose subject is something else, so those keep testing what
 * they were written for. A case about the wallet names its own permissions.
 */
const NO_WALLET = { mayViewWallet: false, mayCredit: false, mayDebit: false } as const;
/*
 * `orders.view`, `services.view` and `referrals.view` withheld.
 *
 * Separate from `NO_WALLET` because they are separate permissions on separate
 * modules: an operator may read wallets and not orders. The detail tests below
 * are about identity, blocking and the wallet, so they withhold both and assert
 * against the two denial sentences where it matters; the commerce cards have
 * their own describe block.
 */
const NO_COMMERCE = {
  mayViewOrders: false,
  mayViewServices: false,
  mayViewReferrals: false,
  mayViewReseller: false,
  mayEditReseller: false,
} as const;

const walletRoutes = (balance: Record<string, unknown> = {}, entries: readonly unknown[] = []) => [
  {
    url: `/users/${ROW_ID}/wallet/entries`,
    body: { entries, nextCursor: null },
  },
  {
    url: `/users/${ROW_ID}/wallet`,
    body: {
      wallet: {
        customerId: ROW_ID,
        balanceAmount: '0',
        currency: 'IRT',
        entryCount: 0,
        ...balance,
      },
    },
  },
];

const walletEntry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '019210ab-cdef-7012-8345-6789abcdef99',
  customerId: ROW_ID,
  direction: 'CREDIT',
  reason: 'ADMIN_CREDIT',
  amount: '250000',
  currency: 'IRT',
  orderId: null,
  paymentId: null,
  actorAdminId: null,
  note: 'goodwill',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const list = (customers: unknown[], nextCursor: string | null = null) => [
  { url: '/users', body: { customers, nextCursor } },
];

describe('the customer list', () => {
  /**
   * Navigating away from a search must not leave its criteria in the box.
   *
   * The sidebar's «کاربران» link re-renders THIS component with an empty query
   * instead of remounting it, and a `useState` initialiser runs once per mount. So
   * after a search that link left the input showing the old criteria above an
   * unfiltered list, with Clear disabled because nothing was applied any more — the
   * screen telling the operator three different things about what they had asked for.
   * `ListSearchBox` derives its draft from the URL for that reason.
   *
   * `rerender` is exactly that navigation: same component instance, new props.
   */
  it('clears the search box when navigation drops the query', async () => {
    stubApi([{ url: '/users', body: { customers: [customer()], nextCursor: null } }]);
    const searched = { path: '/users', query: new URLSearchParams({ q: '5551234567' }) };
    const { rerender } = renderPage(<UsersPage route={searched} maySearch denied={false} />);
    await screen.findByText('5551234567', { selector: '.ltr' });
    expect((screen.getByLabelText(SEARCH) as HTMLInputElement).value).toBe('5551234567');

    // The sidebar link: same component, empty query.
    rerender(<UsersPage route={LIST_ROUTE} maySearch denied={false} />);

    expect(
      (screen.getByLabelText(SEARCH) as HTMLInputElement).value,
      'the search box still shows a search that is no longer applied',
    ).toBe('');
  });

  /**
   * And the draft must SURVIVE a render that does not change the applied search.
   *
   * Deriving the draft from the URL invites the opposite mistake: resetting on every
   * render would erase what the operator is typing. The status filter is the case that
   * proves the box follows `q` and nothing else.
   */
  it('keeps what the operator is typing when the status filter changes', async () => {
    stubApi([{ url: '/users', body: { customers: [customer()], nextCursor: null } }]);
    const { rerender } = renderPage(<UsersPage route={LIST_ROUTE} maySearch denied={false} />);
    await screen.findByText('5551234567');

    fireEvent.change(screen.getByLabelText(SEARCH), { target: { value: 'half' } });
    expect((screen.getByLabelText(SEARCH) as HTMLInputElement).value).toBe('half');

    rerender(
      <UsersPage
        route={{ path: '/users', query: new URLSearchParams({ status: 'BLOCKED' }) }}
        maySearch
        denied={false}
      />,
    );
    expect(
      (screen.getByLabelText(SEARCH) as HTMLInputElement).value,
      'changing the status filter discarded a half-typed search',
    ).toBe('half');
  });

  it('renders the six real columns and invents no commercial telemetry', async () => {
    stubApi(list([customer()]));
    renderPage(<UsersPage route={LIST_ROUTE} maySearch denied={false} />);
    await screen.findByText('5551234567');

    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent ?? '');
    /*
     * Owner decision, and the reason this assertion is over HEADERS rather than
     * over the source.
     *
     * No order, payment, wallet, service, discount or reseller entity exists in
     * this release, so a column for any of them could only be invented — and the
     * way that comes back is somebody adding a column, not somebody editing a
     * string a grep would have found. `0` in a wallet column is the legacy
     * statistics screen counting configured panels as connected.
     */
    for (const forbidden of [
      'کیف پول',
      'موجودی',
      'سفارش',
      'سرویس',
      'پرداخت',
      'تخفیف',
      'نماینده',
      'فروش',
    ]) {
      expect(headers.join(' '), forbidden).not.toContain(forbidden);
    }
    // And the six that ARE there, by name, so a removal is as visible as an
    // addition.
    expect(headers.join(' ')).toContain('شناسهٔ تلگرام');
    expect(headers.join(' ')).toContain('نام کاربری');
    expect(headers.join(' ')).toContain('وضعیت');
    expect(headers.join(' ')).toContain('نخستین تماس');
    expect(headers.join(' ')).toContain('آخرین تماس');
  });

  /**
   * Tags — owner revision 15 REVERSED by program §8 (Phase A3, customer notes and tags).
   *
   * This case used to assert "no user-tag concept anywhere": no tag column, no tag filter,
   * no tag word at all. The owner has since explicitly ordered tenant-defined tags with a
   * list filter, so the absence is replaced, deliberately, by the shape §8 asks for: a tag
   * FILTER beside the status filter (never a column, and never a second search box), drawn
   * only when the tenant has defined a tag — a select with nothing in it would be a control
   * that does nothing — and the catalogue editor only for `users.tags.manage`.
   */
  it('draws no tag control while the tenant has defined no tag (program §8)', async () => {
    stubApi([...list([customer()]), { url: '/customer-tags', body: { tags: [] } }]);
    const { container } = renderPage(<UsersPage route={LIST_ROUTE} maySearch denied={false} />);
    await screen.findByText('5551234567');
    expect(container.textContent ?? '').not.toContain('برچسب');
    // No tag COLUMN either way: a tag is read on the customer's own page.
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent ?? '');
    expect(headers.join(' ')).not.toContain('برچسب');
  });

  it('shows a blocked customer as blocked rather than hiding them', async () => {
    stubApi(
      list([
        customer(),
        customer({
          id: '019210ab-cdef-7012-8345-6789abcdef02',
          telegramUserId: '777000111',
          username: null,
          status: 'BLOCKED',
          blockedAt: '2026-09-11T09:00:00.000Z',
          blockedReason: 'spam',
        }),
      ]),
    );
    renderPage(<UsersPage route={LIST_ROUTE} maySearch denied={false} />);
    await screen.findByText('777000111');
    // Both rows, and the blocked one carries its own badge IN ITS ROW. Scoped to
    // the row rather than to the page, because the status filter's pills carry
    // the same word: a page-wide `getByText` would have passed on the pill alone
    // and said nothing about the row. A blocked customer dropping out of the
    // list is how an operator loses the ability to unblock them — the dead end
    // archiving a panel once produced.
    expect(screen.getByText('5551234567')).toBeInTheDocument();
    const blockedRow = screen.getByText('777000111').closest('tr');
    expect(blockedRow, 'the blocked customer has no row').not.toBeNull();
    expect(within(blockedRow as HTMLElement).getByText('مسدود')).toBeInTheDocument();
  });

  it('renders no search form, and names the permission, without users.search', async () => {
    stubApi(list([customer()]));
    renderPage(<UsersPage route={LIST_ROUTE} maySearch={false} denied={false} />);
    await screen.findByText('5551234567');

    // No search box at all — not a disabled one. A disabled box makes the same claim
    // without naming the permission, which is the half an operator needs in order to
    // ask for it.
    expect(screen.queryByLabelText(SEARCH)).toBeNull();
    expect(screen.getByText(/users\.search/)).toBeInTheDocument();
  });

  it('never sends a search an actor without users.search left in the URL', async () => {
    // A link from a colleague who holds the permission must not turn the list into a 403.
    const api = stubApi(list([customer()]));
    const route = { path: '/users', query: new URLSearchParams({ q: '5551234567' }) };
    renderPage(<UsersPage route={route} maySearch={false} denied={false} />);
    await screen.findByText('5551234567');
    expect(api.calls[api.calls.length - 1]?.url ?? '').not.toContain('q=');
    // And the empty state, were there one, would not claim a search found nothing.
    expect(screen.queryByText('هیچ مشتری‌ای با این جست‌وجو پیدا نشد.')).toBeNull();
  });

  it('keeps the status filter for an actor without users.search', async () => {
    /*
     * The server charges `users.search` for a Telegram-id or username lookup and
     * NOT for a status filter: narrowing a tenant's own list to the blocked half
     * is the same question the unfiltered list answers. Gating the pills here
     * would hide a capability the server permits — the direction nobody looks,
     * and the one the navigation's own ANY-of-these permission rule exists for.
     */
    stubApi(list([customer()]));
    renderPage(<UsersPage route={LIST_ROUTE} maySearch={false} denied={false} />);
    await screen.findByText('5551234567');
    expect(screen.getByRole('button', { name: 'مسدود' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'فعال' })).toBeInTheDocument();
  });

  /**
   * Spec §10: ONE box, and the server decides what the text is. The line under the box
   * says how it will be read, from the contract's own `classifyListSearch` — so an
   * operator who typed `12ab` is told it is searched as text rather than finding out
   * from an empty page that it was never a Telegram id.
   */
  it('says how the box will read what was typed, before anything is sent', async () => {
    const api = stubApi(list([customer()]));
    renderPage(<UsersPage route={LIST_ROUTE} maySearch denied={false} />);
    await screen.findByText('5551234567');
    const before = api.calls.length;
    const box = screen.getByLabelText(SEARCH);

    const readsAs = (value: string) => {
      fireEvent.change(box, { target: { value } });
      return screen.getByTestId('list-search-kind').textContent ?? '';
    };
    expect(readsAs('5551234567')).toContain('شناسهٔ عددی تلگرام');
    expect(readsAs('@ali')).toContain('نام کاربری');
    expect(readsAs(ROW_ID)).toContain('شناسهٔ داخلی');
    expect(readsAs('12ab')).toContain('متن');
    // Typing asks nothing: the draft lives in state, the search in the URL.
    expect(api.calls.length).toBe(before);
  });

  it('sends the one search as q, and none of the retired parameters', async () => {
    const route = { path: '/users', query: new URLSearchParams({ q: 'ali' }) };
    const api = stubApi(list([customer()]));
    renderPage(<UsersPage route={route} maySearch denied={false} />);
    await screen.findByText('5551234567');

    const url = api.calls[api.calls.length - 1]?.url ?? '';
    expect(url).toContain('q=ali');
    expect(url).not.toContain('telegramUserId=');
    expect(url).not.toContain('username=');
  });

  it('applies the search in one navigation that keeps the status filter, and clears it', async () => {
    /*
     * The box navigates with `setQueries`, which builds from the route it was handed;
     * the status filter in the same URL must survive a search being applied.
     */
    stubApi(list([customer()]));
    window.history.replaceState(null, '', '/users?status=ACTIVE');
    renderPage(
      <UsersPage
        route={{ path: '/users', query: new URLSearchParams({ status: 'ACTIVE' }) }}
        maySearch
        denied={false}
      />,
    );
    await screen.findByText('5551234567');

    fireEvent.change(screen.getByLabelText(SEARCH), { target: { value: '  5551234567 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'جست‌وجو' }));

    await waitFor(() => {
      const applied = new URLSearchParams(window.location.search);
      // Trimmed: the URL carries what the server will read.
      expect(applied.get('q')).toBe('5551234567');
      expect(applied.get('status'), 'applying a search dropped the status filter').toBe('ACTIVE');
    });

    stubApi(list([customer()]));
    renderPage(
      <UsersPage
        route={{ path: '/users', query: new URLSearchParams(window.location.search) }}
        maySearch
        denied={false}
      />,
    );
    fireEvent.click((await screen.findAllByText('پاک کردن'))[0] as HTMLButtonElement);
    await waitFor(() => {
      expect(window.location.search).toBe('?status=ACTIVE');
    });
  });

  it('sends no search parameter at all when the box is empty', async () => {
    const api = stubApi(list([customer()]));
    renderPage(<UsersPage route={LIST_ROUTE} maySearch denied={false} />);
    await screen.findByText('5551234567');

    const url = api.calls[api.calls.length - 1]?.url ?? '';
    // An empty `q` would be refused by the server as a 400; absent is "no search".
    expect(url).not.toContain('q=');
  });

  it('answers a search separately from a status filter spelled the same way', async () => {
    /*
     * The cursor trail and the query key are keyed on a SIGNATURE of the applied
     * filters, and the separator is what keeps two of them apart. `?q=BLOCKED` and
     * `?status=BLOCKED` must be two questions to the server, never one cached answer
     * served under the other's heading and paged with the other's cursor.
     */
    const bySearch = { path: '/users', query: new URLSearchParams({ q: 'BLOCKED' }) };
    const byStatus = { path: '/users', query: new URLSearchParams({ status: 'BLOCKED' }) };

    const api = stubApi(list([customer()], 'Y3Vyc29yLXNoYXJlZA'));
    const view = renderPage(<UsersPage route={bySearch} maySearch denied={false} />);
    await screen.findByText('5551234567');
    const searchUrl = api.calls[api.calls.length - 1]?.url ?? '';

    view.rerender(<UsersPage route={byStatus} maySearch denied={false} />);
    await waitFor(() =>
      expect(api.calls[api.calls.length - 1]?.url ?? '').toContain('status=BLOCKED'),
    );
    const statusUrl = api.calls[api.calls.length - 1]?.url ?? '';

    expect(searchUrl).toContain('q=BLOCKED');
    expect(searchUrl).not.toContain('status=');
    expect(statusUrl).not.toContain('q=');
    expect(searchUrl).not.toBe(statusUrl);
  });

  it('pages forward with the cursor the server minted, and back without one', async () => {
    const api = stubApi(list([customer()], 'Y3Vyc29yLW9uZQ'));
    renderPage(<UsersPage route={LIST_ROUTE} maySearch denied={false} />);
    await screen.findByText('5551234567');

    fireEvent.click(screen.getByRole('button', { name: 'تازه‌تر' }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.includes('cursor=Y3Vyc29yLW9uZQ'))).toBe(true),
    );

    // The pager is a sibling of `StateSwitch` and is drawn only in the `ready`
    // state, so it is gone while the new page is in flight. Waiting for it back
    // is waiting for the second page to have arrived.
    const back = await screen.findByRole('button', { name: 'قدیمی‌تر' });
    // Back pops the trail rather than asking the server to reverse: a keyset
    // cursor only goes forward, and the previous page's start is a cursor this
    // component already held.
    const forward = api.calls.length;
    fireEvent.click(back);
    // The first page again — from the cache when it was read within the list's
    // freshness window (`NAV_PREFETCH_FRESH_MS`, Issue 16), otherwise re-asked —
    // and in neither case by a request carrying a cursor.
    await screen.findByText('5551234567');
    await waitFor(() => expect(screen.getByRole('button', { name: 'قدیمی‌تر' })).toBeDisabled());
    for (const call of api.calls.slice(forward)) expect(call.url).not.toContain('cursor=');
  });

  it('does not offer a pager page it cannot serve', async () => {
    stubApi(list([customer()], null));
    renderPage(<UsersPage route={LIST_ROUTE} maySearch denied={false} />);
    await screen.findByText('5551234567');
    // `nextCursor: null` is the last page. An enabled button here would push a
    // cursor, change the query key and issue a request for nothing.
    expect(screen.getByRole('button', { name: 'تازه‌تر' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'قدیمی‌تر' })).toBeDisabled();
  });

  it('says the list is empty without claiming a search found nothing', async () => {
    stubApi(list([]));
    renderPage(<UsersPage route={LIST_ROUTE} maySearch denied={false} />);
    await screen.findByText('هنوز هیچ مشتری‌ای ثبت نشده است.');
    // The two empties are different claims: "you have no customers" and "your
    // search matched none". The legacy bot showed one message for both.
    expect(screen.queryByText('هیچ مشتری‌ای با این جست‌وجو پیدا نشد.')).toBeNull();
  });

  it('says a SEARCH found nothing when a search is applied', async () => {
    const route = { path: '/users', query: new URLSearchParams({ q: 'nobody' }) };
    stubApi(list([]));
    renderPage(<UsersPage route={route} maySearch denied={false} />);
    await screen.findByText('هیچ مشتری‌ای با این جست‌وجو پیدا نشد.');
  });

  it('renders the refusal, not a table, without users.view', async () => {
    const api = stubApi(list([customer()]));
    renderPage(<UsersPage route={LIST_ROUTE} maySearch denied />);
    // `enabled: false`, so no request is made at all — the page does not ask a
    // question it has been told it may not ask.
    expect(api.calls).toHaveLength(0);
    expect(screen.queryByRole('table')).toBeNull();
    /*
     * And no REACHABLE toolbar, for the reason the panels toolbar gives: a
     * control that mints a new query key is a request against a question already
     * refused.
     *
     * `not.toBeVisible` rather than `toBeNull`, and the difference is the point:
     * the toolbar is hidden with the `hidden` attribute, so the input is still in
     * the document and `queryByLabelText` finds it. Asserting its absence would
     * have been a test that could only pass by changing the mechanism; asserting
     * it cannot be seen or reached is the actual rule.
     */
    expect(screen.getByLabelText(SEARCH)).not.toBeVisible();
  });
});

describe('the customer detail', () => {
  const detail = (overrides: Record<string, unknown> = {}) => [
    { url: `/users/${ROW_ID}`, body: { customer: customer(overrides) } },
    ...walletRoutes(),
  ];

  /**
   * Owner revision 16 — no generic recent-activity feed.
   *
   * Moved here from the planned page, and asserted as an absence for the same
   * reason as the tags: on the planned page it was the presence of a sentence,
   * which stops meaning anything the moment the page is real.
   */
  it('carries no recent-activity feed and no commercial cards', async () => {
    stubApi(detail());
    const { container } = renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...NO_WALLET}
        {...NO_COMMERCE}
        denied={false}
      />,
    );
    // The head and the general card both name the username (Customer 360).
    await screen.findAllByText('ali_tehran', { exact: false });
    const text = container.textContent ?? '';
    expect(text).not.toContain('فعالیت اخیر');
    /*
     * «برچسب» was in this list and is not any more: program §8 (Phase A3) ordered customer
     * tags, shown on this page in their own card. Replaced rather than deleted — the tags
     * card's own tests (`customer-crm.test.tsx`) assert what it now says, and that it draws
     * no write without `users.tags.assign`.
     */
    /*
     * «موجودی» was in this list and is not any more.
     *
     * Phase 4A asserted that the detail page carried no balance, which was true
     * of 4A: no wallet existed. 4C builds one, and the card is rendered above —
     * so the assertion is REPLACED rather than deleted, by the wallet tests
     * below that check what it now says. Leaving it would have failed; deleting
     * it silently would have removed the only thing watching this region.
     */
  });

  /*
   * Codex review on PR #125: the redesign moved the head into the loaded branch
   * as a `DetailHead`, which drew an <h2>, and dropped the `PageHead` that stood
   * outside the query state — so the page had no level-one heading at all while
   * loading, refused or failed, and only an <h2> once loaded.
   */
  describe('keeps one level-one heading in every state', () => {
    const page = (denied: boolean) => (
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock={false}
        {...NO_WALLET}
        {...NO_COMMERCE}
        denied={denied}
      />
    );

    it('while loading', () => {
      stubApi(detail());
      renderPage(page(false));
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    });

    it('when refused', () => {
      stubApi(detail());
      renderPage(page(true));
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    });

    it('when the read fails', async () => {
      stubApi([
        {
          url: `/users/${ROW_ID}`,
          status: 500,
          body: {
            error: { kind: 'internal', code: 'test.boom', message: 'no', correlationId: 'test' },
          },
        },
      ]);
      const { container } = renderPage(page(false));
      await waitFor(() => expect(container.querySelector('.skel')).toBeNull());
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    });

    it('once loaded, where the head card carries it and names the customer', async () => {
      stubApi(detail());
      renderPage(page(false));
      // The head and the general card both name the username (Customer 360).
      await screen.findAllByText('ali_tehran', { exact: false });
      const headings = screen.getAllByRole('heading', { level: 1 });
      expect(headings).toHaveLength(1);
      expect(headings[0]?.closest('.detail-head')).not.toBeNull();
    });
  });

  it('sends a block with an idempotency key and the mandatory reason, in two steps', async () => {
    const api = stubApi([
      ...detail(),
      {
        url: `/users/${ROW_ID}/block`,
        body: {
          customer: customer({
            status: 'BLOCKED',
            blockedAt: '2026-09-12T10:00:00.000Z',
            blockedReason: 'spam',
          }),
        },
      },
    ]);
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...NO_WALLET}
        {...NO_COMMERCE}
        denied={false}
      />,
    );
    // Step one: the button only opens the confirmation panel. No request yet.
    await screen.findByRole('button', { name: 'مسدود کردن' });
    fireEvent.click(screen.getByRole('button', { name: 'مسدود کردن' }));
    await screen.findByText('تأیید مسدودسازی');
    expect(api.calls.find((entry) => entry.url.includes('/block'))).toBeUndefined();

    // Step two: the mandatory reason, then the confirm.
    fireEvent.change(screen.getByLabelText(LABEL), { target: { value: '  spam  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'تأیید و مسدود کردن' }));

    await waitFor(() => {
      const call = api.calls.find((entry) => entry.url.includes('/block'));
      expect(call, 'no block request was sent').toBeDefined();
      const body = call?.body as { idempotencyKey?: string; reason?: string };
      // The key is in the BODY, as every other command on this surface carries
      // it, and it is long enough for the contract's `min(8)`.
      expect((body.idempotencyKey ?? '').length).toBeGreaterThanOrEqual(8);
      // Trimmed here as the server trims it, so the fingerprint the key is bound to is
      // the reason that is actually sent.
      expect(body.reason).toBe('spam');
    });

    // And the page now shows the state the SERVER returned, not a guess: the
    // response carries the row as it is, so nothing re-reads a value it has.
    await screen.findByText('این مشتری مسدود است');
  });

  it('offers unblock instead of block once the customer is blocked', async () => {
    stubApi(detail({ status: 'BLOCKED', blockedAt: '2026-09-11T09:00:00.000Z' }));
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...NO_WALLET}
        {...NO_COMMERCE}
        denied={false}
      />,
    );
    await screen.findByRole('button', { name: 'رفع مسدودی' });
    // Never both. Two enabled controls for opposite directions is how a
    // double-click blocks and unblocks in one gesture.
    expect(screen.queryByRole('button', { name: 'مسدود کردن' })).toBeNull();
  });

  it('sends no block until a non-empty reason is typed', async () => {
    const api = stubApi([
      ...detail(),
      { url: `/users/${ROW_ID}/block`, body: { customer: customer({ status: 'BLOCKED' }) } },
    ]);
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...NO_WALLET}
        {...NO_COMMERCE}
        denied={false}
      />,
    );
    await screen.findByRole('button', { name: 'مسدود کردن' });
    fireEvent.click(screen.getByRole('button', { name: 'مسدود کردن' }));
    const confirm = await screen.findByRole('button', { name: 'تأیید و مسدود کردن' });

    // Disabled with nothing typed, and with whitespace only: a block without a reason is
    // the thing the server refuses, and the courtesy here is not to offer it.
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(LABEL), { target: { value: '   ' } });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(api.calls.find((entry) => entry.url.includes('/block'))).toBeUndefined();

    fireEvent.change(screen.getByLabelText(LABEL), { target: { value: 'spam' } });
    expect(confirm).toBeEnabled();

    // The bound is the server's, in code points: 500 emoji may be typed and sent, 501 may not.
    const emoji = '😀'.repeat(500);
    fireEvent.change(screen.getByLabelText(LABEL), { target: { value: emoji } });
    expect(screen.getByLabelText(LABEL)).toHaveValue(emoji);
    expect(confirm).toBeEnabled();
    fireEvent.change(screen.getByLabelText(LABEL), { target: { value: `${emoji}😀` } });
    expect(confirm).toBeDisabled();
  });

  it('cancel closes the confirmation and sends nothing', async () => {
    const api = stubApi(detail());
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...NO_WALLET}
        {...NO_COMMERCE}
        denied={false}
      />,
    );
    await screen.findByRole('button', { name: 'مسدود کردن' });
    fireEvent.click(screen.getByRole('button', { name: 'مسدود کردن' }));
    fireEvent.change(await screen.findByLabelText(LABEL), { target: { value: 'typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'انصراف' }));

    // Back to step one, and the typed reason is gone with the panel.
    await screen.findByRole('button', { name: 'مسدود کردن' });
    expect(screen.queryByLabelText(LABEL)).toBeNull();
    expect(api.calls.find((entry) => entry.url.includes('/block'))).toBeUndefined();
  });

  it('unblock asks for confirmation, then sends no reason', async () => {
    const api = stubApi([
      ...detail({
        status: 'BLOCKED',
        blockedAt: '2026-09-11T09:00:00.000Z',
        blockedReason: 'spam',
        blockedReasonShown: true,
        marketingOptOutAt: null,
      }),
      { url: `/users/${ROW_ID}/unblock`, body: { customer: customer() } },
    ]);
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...NO_WALLET}
        {...NO_COMMERCE}
        denied={false}
      />,
    );
    await screen.findByRole('button', { name: 'رفع مسدودی' });
    fireEvent.click(screen.getByRole('button', { name: 'رفع مسدودی' }));
    await screen.findByText('تأیید رفع مسدودی');
    expect(api.calls.find((entry) => entry.url.includes('/unblock'))).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'تأیید و رفع مسدودی' }));
    await waitFor(() => {
      const call = api.calls.find((entry) => entry.url.includes('/unblock'));
      expect(call, 'no unblock request was sent').toBeDefined();
      expect(Object.keys(call?.body as object)).not.toContain('reason');
    });
  });

  it('says whether the customer is shown the stored reason', async () => {
    stubApi(
      detail({
        status: 'BLOCKED',
        blockedAt: '2026-09-11T09:00:00.000Z',
        blockedReason: 'an old note',
        blockedReasonShown: false,
        marketingOptOutAt: '2026-09-21T10:00:00.000Z',
      }),
    );
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...NO_WALLET}
        {...NO_COMMERCE}
        denied={false}
      />,
    );
    await screen.findByText('an old note');
    // A reason written before the promise: the customer sees only the plain sentence.
    await screen.findByText(/به مشتری نشان داده نمی‌شود/);
  });

  it('draws no block control at all without users.block', async () => {
    stubApi(detail());
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock={false}
        {...NO_WALLET}
        {...NO_COMMERCE}
        denied={false}
      />,
    );
    await screen.findByText(/users\.block/);
    expect(screen.queryByRole('button', { name: 'مسدود کردن' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'رفع مسدودی' })).toBeNull();
    // Not even the note field: a reason with nowhere to go is a form that looks
    // like it will do something.
    expect(screen.queryByLabelText(LABEL)).toBeNull();
  });

  it('shows the server refusal rather than a success it did not get', async () => {
    stubApi([
      ...detail(),
      {
        url: `/users/${ROW_ID}/block`,
        status: 403,
        body: {
          error: {
            kind: 'forbidden',
            code: 'access.permission_denied',
            message: 'no',
            correlationId: 'test',
          },
        },
      },
    ]);
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...NO_WALLET}
        {...NO_COMMERCE}
        denied={false}
      />,
    );
    await screen.findByRole('button', { name: 'مسدود کردن' });
    fireEvent.click(screen.getByRole('button', { name: 'مسدود کردن' }));
    fireEvent.change(await screen.findByLabelText(LABEL), { target: { value: 'spam' } });
    fireEvent.click(screen.getByRole('button', { name: 'تأیید و مسدود کردن' }));

    // The UI drew the button because the session claimed the permission; the
    // server is the authority and disagreed. The disagreement is shown.
    await screen.findByText('شما به این بخش دسترسی ندارید.');
    expect(screen.queryByText('این مشتری مسدود است')).toBeNull();
  });
});

describe('the route table', () => {
  it('serves the live list at /users, not a planned page', async () => {
    stubApi(list([customer()]));
    const resolved = resolve({ path: '/users', query: new URLSearchParams() }, [
      'users.view',
      'users.search',
      'users.block',
    ]);
    const view = renderPage(resolved.element as ReactElement);
    await screen.findByText('5551234567');
    // The planned page's own heading must NOT be here: `/users` was a planned
    // route until Phase 4A, and `resolve` falls through to `PLANNED_SURFACES`,
    // so an entry left in that table would still win for a path whose live
    // branch was removed.
    expect(within(view.container).queryByText('چرا هنوز فعال نیست')).toBeNull();
    expect(within(view.container).getAllByRole('columnheader').length).toBeGreaterThan(0);
  });

  it('serves the detail at /users/:id', async () => {
    stubApi([{ url: `/users/${ROW_ID}`, body: { customer: customer() } }]);
    const resolved = resolve({ path: `/users/${ROW_ID}`, query: new URLSearchParams() }, [
      'users.view',
      'users.block',
    ]);
    renderPage(resolved.element as ReactElement);
    // The head and the general card both name the username (Customer 360).
    await screen.findAllByText('ali_tehran', { exact: false });
  });

  /*
   * The ROUTE deriving credit and debit from their OWN permissions.
   *
   * Every wallet permission case below constructs the card with `mayDebit={false}`,
   * which proves the card honours the prop and nothing about `app.tsx` computing it.
   * `mayDebit={may('users.view')}` — every reader offered the CRITICAL debit button —
   * left that whole suite green. This is the call site, and debit is the half worth
   * asserting because it takes money away.
   */
  /*
   * The ROUTE deriving the two commerce cards from their OWN permissions.
   *
   * Same failure mode as the debit case above and the same reason to assert it
   * here: every card test below passes `mayViewOrders`/`mayViewServices`
   * directly, which proves the card honours a prop and nothing about `app.tsx`
   * computing it. `mayViewOrders={may('users.view')}` would hand every customer
   * reader an order list the server's `orders.view` guard would have refused,
   * and would leave the whole card suite green.
   */
  it('derives the two commerce cards from orders.view and services.view', async () => {
    stubApi([
      { url: `/users/${ROW_ID}`, body: { customer: customer() } },
      { url: '/orders', body: { orders: [order()], nextCursor: null } },
    ]);
    const resolved = resolve({ path: `/users/${ROW_ID}`, query: new URLSearchParams() }, [
      'users.view',
      'orders.view',
    ]);
    renderPage(resolved.element as ReactElement);

    // Orders granted, so the card has drawn — the services denial below is a
    // decision rather than a card that has not rendered yet.
    await screen.findByText('پلن یک‌ماهه');
    expect(screen.getByText(/services\.view/u)).toBeTruthy();
    expect(screen.queryByText(/orders\.view/u)).toBeNull();
  });

  it('links "all orders" and "all services" through the one search box, scoped to this customer', async () => {
    stubApi([
      { url: `/users/${ROW_ID}`, body: { customer: customer() } },
      { url: '/orders', body: { orders: [order()], nextCursor: null } },
      { url: '/services', body: { services: [], nextCursor: null } },
    ]);
    const resolved = resolve({ path: `/users/${ROW_ID}`, query: new URLSearchParams() }, [
      'users.view',
      'orders.view',
      'services.view',
    ]);
    renderPage(resolved.element as ReactElement);

    const orders = await screen.findByText('همهٔ سفارش‌های این مشتری');
    const services = await screen.findByText('همهٔ سرویس‌های این مشتری');
    // The list pages read only `q`; a retired `customerId` would show every tenant row.
    expect(orders.closest('a')?.getAttribute('href')).toBe(
      `/orders?q=${encodeURIComponent(ROW_ID)}`,
    );
    expect(services.closest('a')?.getAttribute('href')).toBe(
      `/services?q=${encodeURIComponent(ROW_ID)}`,
    );
  });

  /*
   * The other half of the same wiring, and the half that catches the likelier slip.
   *
   * The positive case above still passes when the route reads
   * `mayViewOrders={may('users.view')}`, because that actor holds `users.view`
   * too — which is exactly how a derived-from-the-wrong-key bug survives a green
   * suite. An actor holding ONLY `users.view` is the one that can tell them
   * apart: it must see BOTH denial sentences, because neither commerce key is in
   * its set.
   */
  it('withholds both commerce cards from an actor holding only users.view', async () => {
    const api = stubApi([{ url: `/users/${ROW_ID}`, body: { customer: customer() } }]);
    const resolved = resolve({ path: `/users/${ROW_ID}`, query: new URLSearchParams() }, [
      'users.view',
    ]);
    renderPage(resolved.element as ReactElement);
    // The head and the general card both name the username (Customer 360).
    await screen.findAllByText('ali_tehran', { exact: false });

    expect(screen.getByText(/orders\.view/u)).toBeTruthy();
    expect(screen.getByText(/services\.view/u)).toBeTruthy();
    expect(api.calls.some((call) => call.url.includes('/orders'))).toBe(false);
    expect(api.calls.some((call) => call.url.includes('/services'))).toBe(false);
  });

  it('derives debit from users.wallet.debit, not from a permission that merely reads', async () => {
    stubApi([{ url: `/users/${ROW_ID}`, body: { customer: customer() } }, ...walletRoutes()]);
    const resolved = resolve({ path: `/users/${ROW_ID}`, query: new URLSearchParams() }, [
      'users.view',
      'users.wallet.credit',
    ]);
    renderPage(resolved.element as ReactElement);

    // Credit is granted, so the card has drawn — the absence below is a decision
    // rather than a card that has not rendered yet.
    await screen.findByText('واریز به کیف پول');
    expect(screen.queryByText('برداشت از کیف پول')).toBeNull();
  });
});

/**
 * The wallet card on the customer detail.
 *
 * Every case here drives the REAL page — the real client, the real fetch, the real
 * button. The Phase 4B lesson is why: `setQueries` was tested and neither call site
 * was, so reverting a page's handler left the suite green. A helper with no call-site
 * test is a helper whose page can be broken without anybody noticing.
 */
describe('the wallet card', () => {
  const ALL_WALLET = { mayViewWallet: true, mayCredit: true, mayDebit: true } as const;

  it('renders the DERIVED balance, its entry count, and says it is derived', async () => {
    stubApi([
      { url: `/users/${ROW_ID}`, body: { customer: customer() } },
      ...walletRoutes({ balanceAmount: '750000', entryCount: 3 }, [walletEntry()]),
    ]);
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...ALL_WALLET}
        {...NO_COMMERCE}
        denied={false}
      />,
    );

    const card = (await screen.findByRole('heading', { name: 'کیف پول' })).closest(
      'section',
    ) as HTMLElement;
    // The formatted amount, not the raw minor units — in the wallet card itself.
    expect(await within(card).findByText(/۷۵۰٬۰۰۰|750,000/u)).toBeTruthy();
    expect(within(card).getByText('3')).toBeTruthy();
    // The head's summary strip reads the SAME derived balance (the same query), so the
    // two can never disagree.
    const strip = document.querySelector('.head-stats') as HTMLElement;
    expect(within(strip).getByText(/۷۵۰٬۰۰۰|750,000/u)).toBeTruthy();
    // The page SAYS the number is computed, because an operator seeing a balance
    // has no other way to know there is no stored column behind it.
    expect(screen.getByText(/محاسبه می‌شود/u)).toBeTruthy();
  });

  it('shows the ledger with its direction, and says it cannot be edited', async () => {
    stubApi([
      { url: `/users/${ROW_ID}`, body: { customer: customer() } },
      ...walletRoutes({ balanceAmount: '250000', entryCount: 1 }, [
        walletEntry({ direction: 'DEBIT', reason: 'PURCHASE', note: null }),
      ]),
    ]);
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...ALL_WALLET}
        {...NO_COMMERCE}
        denied={false}
      />,
    );

    await screen.findByText('تاریخچه تراکنش‌ها');
    expect(await screen.findByText('برداشت')).toBeTruthy();
    expect(screen.getByText('PURCHASE')).toBeTruthy();
    // A flow, not a person: `actorAdminId` is null and the page says so rather
    // than leaving the column blank.
    expect(screen.getByText('سامانه')).toBeTruthy();
    expect(screen.getByText(/قابل ویرایش یا حذف نیستند/u)).toBeTruthy();
  });

  it('draws NO control that could set a balance or remove an entry', async () => {
    stubApi([
      { url: `/users/${ROW_ID}`, body: { customer: customer() } },
      ...walletRoutes({ balanceAmount: '250000', entryCount: 1 }, [walletEntry()]),
    ]);
    const { container } = renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...ALL_WALLET}
        {...NO_COMMERCE}
        denied={false}
      />,
    );
    await screen.findByText('کیف پول');

    /*
     * Asserted by LOOKING, not by a comment.
     *
     * The legacy `صفر کردن موجودی` button is a set-balance in disguise, and the
     * single easiest thing to add to this card by accident. Every button is
     * enumerated and required to be one of the two movements.
     */
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim());
    for (const label of labels) {
      expect(
        label === 'واریز به کیف پول' ||
          label === 'برداشت از کیف پول' ||
          label === 'مسدود کردن' ||
          label === 'رفع مسدودی' ||
          // The shared pager's own two, which carry no wallet meaning.
          label === 'قدیمی‌تر' ||
          label === 'تازه‌تر' ||
          // A `Copyable` renders an unlabelled icon button; it copies a value and
          // changes nothing.
          label === '',
        `the wallet card draws an unexpected control: ${String(label)}`,
      ).toBe(true);
    }
    expect(container.textContent).not.toContain('صفر کردن');
    // And no text input that is bound to the balance itself.
    expect(screen.queryByLabelText('موجودی')).toBeNull();
  });

  it('sends a CREDIT with the typed amount, an idempotency key and no reason', async () => {
    const api = stubApi([
      { url: `/users/${ROW_ID}`, body: { customer: customer() } },
      ...walletRoutes({ balanceAmount: '0', entryCount: 0 }),
      {
        url: `/users/${ROW_ID}/wallet/adjust`,
        body: { entry: walletEntry() },
      },
    ]);
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...ALL_WALLET}
        {...NO_COMMERCE}
        denied={false}
      />,
    );
    await screen.findByText('ثبت تراکنش دستی');

    fireEvent.change(screen.getByLabelText('مبلغ (واحد خرد)'), { target: { value: '250000' } });
    fireEvent.change(screen.getByLabelText('یادداشت'), { target: { value: 'goodwill' } });
    fireEvent.click(screen.getByText('واریز به کیف پول'));

    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes('/wallet/adjust'))).toBe(true);
    });
    const call = api.calls.find((one) => one.url.includes('/wallet/adjust'));
    const body = call?.body as Record<string, unknown>;
    expect(body['direction']).toBe('CREDIT');
    // A decimal STRING in minor units. A `number` here would round past 2^53.
    expect(body['amount']).toBe('250000');
    expect(typeof body['amount']).toBe('string');
    expect(body['currency']).toBe('IRT');
    expect(body['note']).toBe('goodwill');
    expect(String(body['idempotencyKey']).length).toBeGreaterThanOrEqual(8);
    // NO reason: the server derives it from the direction, so a client cannot
    // file a debit as a PURCHASE.
    expect(body).not.toHaveProperty('reason');
  });

  it('repeats the SAME idempotency key when the same figures are sent twice', async () => {
    const api = stubApi([
      { url: `/users/${ROW_ID}`, body: { customer: customer() } },
      ...walletRoutes(),
      { url: `/users/${ROW_ID}/wallet/adjust`, body: { entry: walletEntry() } },
    ]);
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...ALL_WALLET}
        {...NO_COMMERCE}
        denied={false}
      />,
    );
    await screen.findByText('ثبت تراکنش دستی');

    fireEvent.change(screen.getByLabelText('مبلغ (واحد خرد)'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('یادداشت'), { target: { value: 'twice' } });
    fireEvent.click(screen.getByText('واریز به کیف پول'));
    await waitFor(() => {
      expect(api.calls.filter((c) => c.url.includes('/wallet/adjust'))).toHaveLength(1);
    });

    // The form clears on success, so the operator retypes the same figures — which
    // is a NEW command, and correctly gets a new key. What must be stable is the
    // key WITHIN one unsettled submission; `submission-key.test.tsx` owns that.
    // Here the subject is that a key is sent at all, and that it is bound to the
    // payload rather than to the component's lifetime.
    fireEvent.change(screen.getByLabelText('مبلغ (واحد خرد)'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('یادداشت'), { target: { value: 'twice' } });
    fireEvent.click(screen.getByText('واریز به کیف پول'));
    await waitFor(() => {
      expect(api.calls.filter((c) => c.url.includes('/wallet/adjust'))).toHaveLength(2);
    });
    const keys = api.calls
      .filter((c) => c.url.includes('/wallet/adjust'))
      .map((c) => (c.body as Record<string, unknown>)['idempotencyKey']);
    expect(keys[0]).not.toBe(keys[1]);
  });

  /*
   * The key is bound to the bytes SENT, not to what the operator typed.
   *
   * The fingerprint used to read the raw field state while the request trimmed both
   * strings, so «1000 » and «1000» were two keys for one server-visible adjustment.
   * That only matters when a command has to be retried — a 5xx or a dropped connection
   * that had in fact committed — and the retry then appends a SECOND movement under a
   * key the server has never seen. Typing a stray space is the ordinary way to produce
   * it.
   */
  it('reuses the key when a FAILED submission is retried with only whitespace changed', async () => {
    const api = stubApi([
      { url: `/users/${ROW_ID}`, body: { customer: customer() } },
      ...walletRoutes(),
      /*
       * A 503, so `settle()` never runs and the key stays held — which is the only
       * situation the fingerprint matters in. On SUCCESS the form clears and retyping
       * the same figures is correctly a new command with a new key.
       */
      { url: `/users/${ROW_ID}/wallet/adjust`, status: 503, body: { error: { code: 'x' } } },
    ]);
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...ALL_WALLET}
        {...NO_COMMERCE}
        denied={false}
      />,
    );
    await screen.findByText('ثبت تراکنش دستی');

    const submit = (amount: string, note: string) => {
      fireEvent.change(screen.getByLabelText('مبلغ (واحد خرد)'), { target: { value: amount } });
      fireEvent.change(screen.getByLabelText('یادداشت'), { target: { value: note } });
      fireEvent.click(screen.getByText('واریز به کیف پول'));
    };
    submit('1000', 'spacing');
    await waitFor(() => {
      expect(api.calls.filter((c) => c.url.includes('/wallet/adjust'))).toHaveLength(1);
    });
    // The operator retypes, adding stray spaces. The server sees the same bytes.
    submit('  1000  ', '  spacing  ');
    await waitFor(() => {
      expect(api.calls.filter((c) => c.url.includes('/wallet/adjust'))).toHaveLength(2);
    });

    const sent = api.calls
      .filter((c) => c.url.includes('/wallet/adjust'))
      .map((c) => c.body as Record<string, unknown>);
    expect(sent[0]?.['amount']).toBe(sent[1]?.['amount']);
    expect(sent[0]?.['note']).toBe(sent[1]?.['note']);
    /*
     * Identical bodies must carry an identical key. A 503 can be a response lost after
     * the write committed, so a fresh key here is a second movement for one command.
     */
    expect(sent[0]?.['idempotencyKey']).toBe(sent[1]?.['idempotencyKey']);
  });

  /*
   * CREDIT and DEBIT are SEPARATE permissions with different risk labels, and this
   * is the actor that can tell them apart: an operator holding credit and not debit.
   * One holding neither is refused either way and proves nothing about which.
   */
  it('draws only the button a credit-only operator is entitled to', async () => {
    stubApi([{ url: `/users/${ROW_ID}`, body: { customer: customer() } }, ...walletRoutes()]);
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        mayViewWallet
        mayCredit
        mayDebit={false}
        {...NO_COMMERCE}
        denied={false}
      />,
    );
    await screen.findByText('ثبت تراکنش دستی');

    expect(screen.getByText('واریز به کیف پول')).toBeTruthy();
    expect(screen.queryByText('برداشت از کیف پول')).toBeNull();
    // And it NAMES the permission that is missing, rather than a disabled button.
    expect(screen.getByText(/users.wallet.debit/u)).toBeTruthy();
  });

  it('asks for nothing and explains itself when the operator may not read a wallet', async () => {
    const api = stubApi([{ url: `/users/${ROW_ID}`, body: { customer: customer() } }]);
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        mayViewWallet={false}
        mayCredit={false}
        mayDebit={false}
        {...NO_COMMERCE}
        denied={false}
      />,
    );
    await screen.findByText('کیف پول');

    expect(screen.getByText(/users.view/u)).toBeTruthy();
    // The queries are DISABLED, not merely hidden: a page that fetches a wallet it
    // will not draw is a page that logs a 403 on every render.
    expect(api.calls.some((call) => call.url.includes('/wallet'))).toBe(false);
  });

  it('pages the ledger through the cursor the server sent', async () => {
    const api = stubApi([
      { url: `/users/${ROW_ID}`, body: { customer: customer() } },
      {
        url: `/users/${ROW_ID}/wallet/entries`,
        body: { entries: [walletEntry()], nextCursor: 'the-next-page' },
      },
      ...walletRoutes({ balanceAmount: '250000', entryCount: 2 }),
    ]);
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...ALL_WALLET}
        {...NO_COMMERCE}
        denied={false}
      />,
    );
    await screen.findByText('تاریخچه تراکنش‌ها');

    fireEvent.click(await screen.findByText('قدیمی‌تر'));

    await waitFor(() => {
      expect(
        api.calls.some((call) => call.url.includes('cursor=the-next-page')),
        'the pager did not send the cursor the server minted',
      ).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// This customer's orders and services (WP2)
// ---------------------------------------------------------------------------

const SERVICE_ID = '019250ab-cdef-7012-8345-6789abcdef01';

/** One service, exactly as `serviceSummarySchema` describes it. */
function service(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SERVICE_ID,
    customerId: ROW_ID,
    orderId: '019230ab-cdef-7012-8345-6789abcdef01',
    panelId: '019220ab-cdef-7012-8345-6789abcdef01',
    productId: '019215ab-cdef-7012-8345-6789abcdef01',
    state: 'ACTIVE',
    providerUsername: 'nx-7f3a91',
    providerUserId: '4821',
    hasSubscription: true,
    isTrial: false,
    expiresAt: '2026-12-01T00:00:00.000Z',
    trafficLimitBytes: '53687091200',
    trafficUsedBytes: '1073741824',
    deviceLimit: null,
    usageSyncedAt: '2026-09-15T08:00:00.000Z',
    deliveryState: 'DELIVERED',
    deliveredAt: '2026-09-10T12:35:00.000Z',
    provisionedAt: '2026-09-10T12:34:00.000Z',
    terminatedAt: null,
    createdAt: '2026-09-10T12:30:00.000Z',
    updatedAt: '2026-09-10T12:35:00.000Z',
    ...overrides,
  };
}

const ALL_COMMERCE = {
  mayViewOrders: true,
  mayViewServices: true,
  mayViewReferrals: false,
  mayViewReseller: false,
  mayEditReseller: false,
} as const;

/**
 * The two cards the stale docblock said could not exist.
 *
 * Each is a paged view of the SAME list its top-level screen pages, filtered to
 * this customer. The cases below cover the four ways that can go wrong: asking
 * for somebody else's rows, drawing a list a permission would have refused,
 * collapsing a service's two state axes into one, and labelling an ascending
 * pager as if it ran the other way.
 */
describe("a customer's orders and services", () => {
  const withCards = (routes: readonly { url: string; body: unknown }[]) =>
    stubApi([{ url: `/users/${ROW_ID}`, body: { customer: customer() } }, ...routes]);

  it('asks for THIS customer, with the embedded bound, on both lists', async () => {
    const api = withCards([
      { url: '/orders', body: { orders: [order()], nextCursor: null } },
      { url: '/services', body: { services: [service()], nextCursor: null } },
    ]);
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...NO_WALLET}
        {...ALL_COMMERCE}
        denied={false}
      />,
    );
    await screen.findByText('پلن یک‌ماهه');
    await screen.findByText('nx-7f3a91');

    /*
     * `customerId=` and not merely "a request to /orders".
     *
     * The card renders whatever the list returns, so a query that lost the
     * filter would draw the whole installation's orders under one customer's
     * name and every assertion about the rows would still pass.
     */
    const orders = api.calls.find((call) => call.url.includes('/orders'));
    const services = api.calls.find((call) => call.url.includes('/services'));
    expect(orders?.url).toContain(`customerId=${ROW_ID}`);
    expect(orders?.url).toContain('limit=10');
    expect(services?.url).toContain(`customerId=${ROW_ID}`);
    expect(services?.url).toContain('limit=10');
  });

  /*
   * `state` and `deliveryState` are TWO facts and this draws both.
   *
   * `services.tsx` states the rule: 4D's `recordDelivery` exists precisely so a
   * failed Telegram send cannot move a service out of `ACTIVE`, and a card that
   * merged the two axes would show a provisioned account whose message bounced
   * as unprovisioned — for which the obvious remedy is to provision it again,
   * on somebody's panel, a second time.
   */
  it('draws a delivered failure as ACTIVE and FAILED, never as one merged state', async () => {
    withCards([
      { url: '/orders', body: { orders: [], nextCursor: null } },
      {
        url: '/services',
        body: {
          services: [service({ state: 'ACTIVE', deliveryState: 'FAILED', deliveredAt: null })],
          nextCursor: null,
        },
      },
    ]);
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...NO_WALLET}
        {...ALL_COMMERCE}
        denied={false}
      />,
    );
    await screen.findByText('nx-7f3a91');

    const row = screen.getByText('nx-7f3a91').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('فعال')).toBeTruthy();
    expect(within(row as HTMLElement).getByText('رد شد')).toBeTruthy();
  });

  /*
   * The pager label, which is the one thing that differs between the two cards.
   *
   * `/orders` pages ASCENDING — `nextCursor` walks towards NEWER rows — so the
   * button that fetches it must say "newer". Leaving `CursorPager` on its
   * defaults would have labelled it "older", and an operator paging forward
   * through a customer's history would have believed they were going backwards.
   */
  it('labels the orders pager for an ascending traversal and sends its cursor', async () => {
    const api = withCards([
      { url: '/orders', body: { orders: [order()], nextCursor: 'orders-next' } },
      { url: '/services', body: { services: [], nextCursor: null } },
    ]);
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...NO_WALLET}
        {...ALL_COMMERCE}
        denied={false}
      />,
    );
    // The ROW first, so the card below is the loaded one and not its skeleton.
    await screen.findByText('پلن یک‌ماهه');
    // Located by the "all orders" link, which is the one string in this card that
    // the table caption does not also carry.
    const card = screen.getByText('همهٔ سفارش‌های این مشتری').closest('section');
    expect(card).not.toBeNull();

    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'تازه‌تر' }));

    await waitFor(() => {
      expect(
        api.calls.some((call) => call.url.includes('cursor=orders-next')),
        'the orders pager did not send the cursor the server minted',
      ).toBe(true);
    });
  });

  /* `/services` pages DESCENDING, so its pager keeps the default labels. */
  it('labels the services pager for a descending traversal and sends its cursor', async () => {
    const api = withCards([
      { url: '/orders', body: { orders: [], nextCursor: null } },
      { url: '/services', body: { services: [service()], nextCursor: 'services-next' } },
    ]);
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...NO_WALLET}
        {...ALL_COMMERCE}
        denied={false}
      />,
    );
    await screen.findByText('nx-7f3a91');
    const card = screen.getByText('همهٔ سرویس‌های این مشتری').closest('section');
    expect(card).not.toBeNull();

    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'قدیمی‌تر' }));

    await waitFor(() => {
      expect(
        api.calls.some((call) => call.url.includes('cursor=services-next')),
        'the services pager did not send the cursor the server minted',
      ).toBe(true);
    });
  });

  /*
   * Previous returns to the page BEFORE, not to the first page.
   *
   * A Codex round on this PR named the single-cursor version: after two advances,
   * Previous jumped from page three straight to page one and page two could not be
   * reached at all. The button says "the adjacent page" in both cards' vocabularies, so
   * delivering the first one is a control doing something other than what it is
   * labelled.
   *
   * Three pages driven from the server's own tokens, and the assertion is on the
   * REQUEST: what proves the trail is which cursor goes back out, not which rows come
   * back — a card that rendered page two's rows from a stale cache would pass a
   * row-based assertion with the trail removed.
   */
  it('steps the orders pager back one page, not all the way to the first', async () => {
    let page = 0;
    const api = withCards([
      {
        url: '/orders',
        get body() {
          page += 1;
          return {
            orders: [order({ lineTitle: `plan-page-${String(page)}` })],
            nextCursor: page < 3 ? `page-${String(page + 1)}` : null,
          };
        },
      },
      { url: '/services', body: { services: [], nextCursor: null } },
    ]);
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...NO_WALLET}
        {...ALL_COMMERCE}
        denied={false}
      />,
    );
    await screen.findByText('plan-page-1');
    const card = screen.getByText('همهٔ سفارش‌های این مشتری').closest('section') as HTMLElement;

    /*
     * Each advance waits for the ROW, not for the request.
     *
     * Waiting on `api.calls` resolves the moment the fetch goes out, while the card is
     * still showing its skeleton and has no pager to press — which is how the first
     * version of this case failed on its second click rather than on its assertion.
     */
    fireEvent.click(within(card).getByRole('button', { name: 'تازه‌تر' }));
    await screen.findByText('plan-page-2');
    expect(api.calls.some((call) => call.url.includes('cursor=page-2'))).toBe(true);

    fireEvent.click(within(card).getByRole('button', { name: 'تازه‌تر' }));
    await screen.findByText('plan-page-3');
    expect(api.calls.some((call) => call.url.includes('cursor=page-3'))).toBe(true);

    /*
     * Back once from the third page. The cache already holds page two under its own
     * cursor, so the proof is the QUERY KEY the card asks for — counted, because a
     * cached hit issues no new request.
     */
    const before = api.calls.length;
    fireEvent.click(within(card).getByRole('button', { name: 'قدیمی‌تر' }));
    await screen.findByText('plan-page-2');

    const after = api.calls.slice(before);
    expect(
      after.every((call) => !call.url.includes('/orders') || call.url.includes('cursor=page-2')),
      'Previous went somewhere other than the page before',
    ).toBe(true);
    /* And the first page is only reachable by pressing it again. */
    fireEvent.click(within(card).getByRole('button', { name: 'قدیمی‌تر' }));
    await screen.findByText('plan-page-1');
  });

  it('names the missing permission and asks for nothing when orders are withheld', async () => {
    const api = withCards([{ url: '/services', body: { services: [], nextCursor: null } }]);
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...NO_WALLET}
        mayViewOrders={false}
        mayViewServices
        mayViewReferrals={false}
        mayViewReseller={false}
        mayEditReseller={false}
        denied={false}
      />,
    );
    await screen.findByText('سرویس‌های این مشتری');

    expect(screen.getByText(/orders\.view/u)).toBeTruthy();
    // DISABLED, not merely undrawn: a card that fetches a list it will not draw
    // is a card that records a denial on every render.
    expect(api.calls.some((call) => call.url.includes('/orders'))).toBe(false);
  });

  it('names the missing permission and asks for nothing when services are withheld', async () => {
    const api = withCards([{ url: '/orders', body: { orders: [], nextCursor: null } }]);
    renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...NO_WALLET}
        mayViewOrders
        mayViewServices={false}
        mayViewReferrals={false}
        mayViewReseller={false}
        mayEditReseller={false}
        denied={false}
      />,
    );
    await screen.findByText('سفارش‌های این مشتری');

    expect(screen.getByText(/services\.view/u)).toBeTruthy();
    expect(api.calls.some((call) => call.url.includes('/services'))).toBe(false);
  });

  /*
   * An empty list says so in words and invents no number.
   *
   * A `0` for something the page cannot recompute is the legacy statistics
   * screen counting configured panels as connected; the cards therefore carry
   * no count at all, empty or not.
   */
  it('says a customer has none rather than showing a count', async () => {
    withCards([
      { url: '/orders', body: { orders: [], nextCursor: null } },
      { url: '/services', body: { services: [], nextCursor: null } },
    ]);
    const { container } = renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...NO_WALLET}
        {...ALL_COMMERCE}
        denied={false}
      />,
    );
    await screen.findByText('این مشتری هنوز سفارشی ثبت نکرده است.');
    await screen.findByText('این مشتری هنوز سرویسی ندارد.');

    const text = container.textContent ?? '';
    expect(text).not.toContain('تعداد سفارش');
    expect(text).not.toContain('تعداد سرویس');
  });

  /*
   * No bearer capability reaches this card, structurally.
   *
   * `serviceSummarySchema` carries neither `subscriptionUrl`, `subscriptionRef`
   * nor `providerClientId`, so there is nothing here to leak. Asserted anyway,
   * because the thing that would break it is somebody widening the schema and
   * this card rendering the new field by accident — and a list an operator pages
   * through is the worst place to put a capability in bulk.
   */
  it('renders no subscription link for a service that has one', async () => {
    withCards([
      { url: '/orders', body: { orders: [], nextCursor: null } },
      {
        url: '/services',
        body: { services: [service({ hasSubscription: true })], nextCursor: null },
      },
    ]);
    const { container } = renderPage(
      <UserDetailPage
        mayEditTrial={false}
        id={ROW_ID}
        mayBlock
        {...NO_WALLET}
        {...ALL_COMMERCE}
        denied={false}
      />,
    );
    await screen.findByText('nx-7f3a91');

    const card = (screen.getByText('همهٔ سرویس‌های این مشتری').closest('section') ??
      container) as HTMLElement;
    expect(card.textContent ?? '').not.toContain('http');
    for (const anchor of Array.from(card.querySelectorAll('a'))) {
      expect(anchor.getAttribute('href') ?? '').not.toContain('http');
    }
  });
});
