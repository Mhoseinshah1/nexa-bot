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
 * and NO RECENT-ACTIVITY FEED. They were recorded as copy on a page no route
 * renders any more, and an absence asserted against an unreachable screen is a
 * green test for nothing. They are asserted here, where the concepts could
 * actually come back.
 */

const LIST_ROUTE = { path: '/users', query: new URLSearchParams() };
const ROW_ID = '019210ab-cdef-7012-8345-6789abcdef01';

/**
 * The wallet permissions, all off.
 *
 * Spread into the cases whose subject is something else, so those keep testing what
 * they were written for. A case about the wallet names its own permissions.
 */
const NO_WALLET = { mayViewWallet: false, mayCredit: false, mayDebit: false } as const;
/*
 * `orders.view` and `services.view` withheld.
 *
 * Separate from `NO_WALLET` because they are separate permissions on separate
 * modules: an operator may read wallets and not orders. The detail tests below
 * are about identity, blocking and the wallet, so they withhold both and assert
 * against the two denial sentences where it matters; the commerce cards have
 * their own describe block.
 */
const NO_COMMERCE = { mayViewOrders: false, mayViewServices: false } as const;

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
   * Navigating away from a search must not leave its criteria in the boxes.
   *
   * The sidebar's «کاربران» link re-renders THIS component with an empty query
   * instead of remounting it, and `useState(appliedTelegramId)` runs its
   * initialiser once per mount. So after a search that link left the inputs
   * showing the old criteria above an unfiltered list, with Clear disabled
   * because nothing was applied any more — the screen telling the operator three
   * different things about what they had asked for.
   *
   * `rerender` is exactly that navigation: same component instance, new props.
   */
  it('clears the search boxes when navigation drops the query', async () => {
    stubApi([
      { url: '/users?', body: { customers: [customer()], nextCursor: null } },
      { url: '/users', body: { customers: [customer()], nextCursor: null } },
    ]);
    const searched = {
      path: '/users',
      query: new URLSearchParams({ telegramUserId: '5551234567', username: 'ali_tehran' }),
    };
    const { rerender } = renderPage(<UsersPage route={searched} maySearch denied={false} />);
    await screen.findByText('5551234567');
    expect((screen.getByLabelText('شناسهٔ تلگرام') as HTMLInputElement).value).toBe('5551234567');
    expect((screen.getByLabelText('نام کاربری') as HTMLInputElement).value).toBe('ali_tehran');

    // The sidebar link: same component, empty query.
    rerender(<UsersPage route={LIST_ROUTE} maySearch denied={false} />);

    expect(
      (screen.getByLabelText('شناسهٔ تلگرام') as HTMLInputElement).value,
      'the Telegram id box still shows a search that is no longer applied',
    ).toBe('');
    expect(
      (screen.getByLabelText('نام کاربری') as HTMLInputElement).value,
      'the username box still shows a search that is no longer applied',
    ).toBe('');
  });

  /**
   * And the draft must SURVIVE a render that does not change the applied search.
   *
   * The fix derives the draft from the URL, so the mistake it could introduce is
   * the opposite one: resetting on every render would erase what the operator is
   * typing. The status filter is the case that proves the signature is the two
   * values the form owns and not all three.
   */
  it('keeps what the operator is typing when the status filter changes', async () => {
    stubApi([{ url: '/users', body: { customers: [customer()], nextCursor: null } }]);
    const { rerender } = renderPage(<UsersPage route={LIST_ROUTE} maySearch denied={false} />);
    await screen.findByText('5551234567');

    fireEvent.change(screen.getByLabelText('نام کاربری'), { target: { value: 'half' } });
    expect((screen.getByLabelText('نام کاربری') as HTMLInputElement).value).toBe('half');

    rerender(
      <UsersPage
        route={{ path: '/users', query: new URLSearchParams({ status: 'BLOCKED' }) }}
        maySearch
        denied={false}
      />,
    );
    expect(
      (screen.getByLabelText('نام کاربری') as HTMLInputElement).value,
      'changing the status filter discarded a half-typed username',
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
   * Owner revision 15 — no user-tag concept, anywhere.
   *
   * Moved here from the planned page. Asserted as a true absence now: no tag
   * column, no tag filter, no tag word at all. On the planned page this was
   * asserted as the PRESENCE of a sentence saying tags were removed, which is
   * the opposite shape and stops meaning anything once the page is real.
   */
  it('carries no user-tag concept anywhere', async () => {
    stubApi(list([customer()]));
    const { container } = renderPage(<UsersPage route={LIST_ROUTE} maySearch denied={false} />);
    await screen.findByText('5551234567');
    expect(container.textContent ?? '').not.toContain('برچسب');
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

    // No input at all for the two searches — not a disabled one. A disabled box
    // makes the same claim without naming the permission, which is the half an
    // operator needs in order to ask for it.
    expect(screen.queryByLabelText('شناسهٔ تلگرام')).toBeNull();
    expect(screen.queryByLabelText('نام کاربری')).toBeNull();
    expect(screen.getByText(/users\.search/)).toBeInTheDocument();
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

  it('refuses a malformed Telegram id before asking the server', async () => {
    const api = stubApi(list([customer()]));
    renderPage(<UsersPage route={LIST_ROUTE} maySearch denied={false} />);
    await screen.findByText('5551234567');
    const before = api.calls.length;

    fireEvent.change(screen.getByLabelText('شناسهٔ تلگرام'), { target: { value: '12ab' } });
    // The error is stated and the submit is disabled, so the request is never
    // made. The server's 400 for a malformed id reads as "no such customer",
    // which is a different and false answer.
    expect(screen.getByRole('alert').textContent ?? '').toContain('رقم');
    const submit = screen.getByRole('button', { name: 'جست‌وجو' });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    await waitFor(() => expect(api.calls.length).toBe(before));
  });

  it('sends the two searches as separate parameters, only when non-empty', async () => {
    const route = {
      path: '/users',
      query: new URLSearchParams({ telegramUserId: '5551234567', username: 'ali' }),
    };
    const api = stubApi(list([customer()]));
    renderPage(<UsersPage route={route} maySearch denied={false} />);
    await screen.findByText('5551234567');

    const url = api.calls[api.calls.length - 1]?.url ?? '';
    expect(url).toContain('telegramUserId=5551234567');
    expect(url).toContain('username=ali');
  });

  it('applies BOTH search boxes, in one navigation, and clears both', async () => {
    /*
     * The page's own use of `setQueries`, not the helper's behaviour.
     *
     * Two `setQuery` calls in one handler apply ONE change: each builds from the
     * `route.query` PROP this render captured, which the first call's navigation does
     * not update. So the second overwrote the first and `telegramUserId` was silently
     * dropped — the operator saw the id in the box and a list filtered only by name.
     * The clear button had it in the other direction.
     *
     * `router.test.tsx` proves the helper; only this proves the CALL SITE, and a
     * falsification that reverted the handler survived the whole suite without it.
     */
    stubApi(list([customer()]));
    window.history.replaceState(null, '', '/users');
    renderPage(<UsersPage route={LIST_ROUTE} maySearch denied={false} />);
    await screen.findByText('5551234567');

    fireEvent.change(screen.getByLabelText('شناسهٔ تلگرام'), { target: { value: '5551234567' } });
    fireEvent.change(screen.getByLabelText('نام کاربری'), { target: { value: 'ali' } });
    fireEvent.click(screen.getByText('جست‌وجو'));

    await waitFor(() => {
      const applied = new URLSearchParams(window.location.search);
      expect(applied.get('telegramUserId'), 'the id filter was dropped').toBe('5551234567');
      expect(applied.get('username')).toBe('ali');
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
      expect(window.location.search).toBe('');
    });
  });

  it('sends no search parameters at all when the boxes are empty', async () => {
    const api = stubApi(list([customer()]));
    renderPage(<UsersPage route={LIST_ROUTE} maySearch denied={false} />);
    await screen.findByText('5551234567');

    const url = api.calls[api.calls.length - 1]?.url ?? '';
    // Not `username=`: the server would answer an empty prefix with every row
    // while charging `users.search` for it, which is a search an operator did
    // not ask for.
    expect(url).not.toContain('telegramUserId=');
    expect(url).not.toContain('username=');
  });

  it('answers a username search separately from a Telegram-id search of the same text', async () => {
    /*
     * The cursor trail and the query key are keyed on a SIGNATURE of the applied
     * search, and the separator is what keeps two searches apart. With an empty one,
     * `?username=1` and `?telegramUserId=1` are the same string — one key, one trail —
     * so the page serves one search's cached rows under the other's heading and pages
     * it with the other's cursor.
     *
     * Asserted over the REQUESTS rather than over the string, because the string is an
     * implementation detail and the thing that matters is that the server is asked two
     * different questions.
     */
    const byName = { path: '/users', query: new URLSearchParams({ username: '1' }) };
    const byId = { path: '/users', query: new URLSearchParams({ telegramUserId: '1' }) };

    const api = stubApi(list([customer()], 'Y3Vyc29yLXNoYXJlZA'));
    const view = renderPage(<UsersPage route={byName} maySearch denied={false} />);
    await screen.findByText('5551234567');
    const nameUrl = api.calls[api.calls.length - 1]?.url ?? '';

    view.rerender(<UsersPage route={byId} maySearch denied={false} />);
    await waitFor(() =>
      expect(api.calls[api.calls.length - 1]?.url ?? '').toContain('telegramUserId=1'),
    );
    const idUrl = api.calls[api.calls.length - 1]?.url ?? '';

    expect(nameUrl).toContain('username=1');
    expect(nameUrl).not.toContain('telegramUserId=');
    expect(idUrl).not.toContain('username=');
    // Two distinct requests, which is only true if the two searches did not collapse
    // into one query key.
    expect(nameUrl).not.toBe(idUrl);
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
    fireEvent.click(back);
    await waitFor(() => {
      const last = api.calls[api.calls.length - 1]?.url ?? '';
      expect(last).not.toContain('cursor=');
    });
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
    const route = { path: '/users', query: new URLSearchParams({ username: 'nobody' }) };
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
    expect(screen.getByLabelText('شناسهٔ تلگرام')).not.toBeVisible();
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
      <UserDetailPage id={ROW_ID} mayBlock {...NO_WALLET} {...NO_COMMERCE} denied={false} />,
    );
    await screen.findByText('ali_tehran', { exact: false });
    const text = container.textContent ?? '';
    expect(text).not.toContain('فعالیت اخیر');
    expect(text).not.toContain('برچسب');
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

  it('sends a block with an idempotency key and the operator note', async () => {
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
      <UserDetailPage id={ROW_ID} mayBlock {...NO_WALLET} {...NO_COMMERCE} denied={false} />,
    );
    await screen.findByLabelText('دلیل (اختیاری)');

    fireEvent.change(screen.getByLabelText('دلیل (اختیاری)'), { target: { value: 'spam' } });
    fireEvent.click(screen.getByRole('button', { name: 'مسدود کردن' }));

    await waitFor(() => {
      const call = api.calls.find((entry) => entry.url.includes('/block'));
      expect(call, 'no block request was sent').toBeDefined();
      const body = call?.body as { idempotencyKey?: string; reason?: string };
      // The key is in the BODY, as every other command on this surface carries
      // it, and it is long enough for the contract's `min(8)`.
      expect((body.idempotencyKey ?? '').length).toBeGreaterThanOrEqual(8);
      expect(body.reason).toBe('spam');
    });

    // And the page now shows the state the SERVER returned, not a guess: the
    // response carries the row as it is, so nothing re-reads a value it has.
    await screen.findByText('این مشتری مسدود است');
  });

  it('offers unblock instead of block once the customer is blocked', async () => {
    stubApi(detail({ status: 'BLOCKED', blockedAt: '2026-09-11T09:00:00.000Z' }));
    renderPage(
      <UserDetailPage id={ROW_ID} mayBlock {...NO_WALLET} {...NO_COMMERCE} denied={false} />,
    );
    await screen.findByRole('button', { name: 'رفع مسدودی' });
    // Never both. Two enabled controls for opposite directions is how a
    // double-click blocks and unblocks in one gesture.
    expect(screen.queryByRole('button', { name: 'مسدود کردن' })).toBeNull();
  });

  it('omits the reason field entirely when it is empty', async () => {
    const api = stubApi([
      ...detail(),
      { url: `/users/${ROW_ID}/block`, body: { customer: customer({ status: 'BLOCKED' }) } },
    ]);
    renderPage(
      <UserDetailPage id={ROW_ID} mayBlock {...NO_WALLET} {...NO_COMMERCE} denied={false} />,
    );
    await screen.findByRole('button', { name: 'مسدود کردن' });
    fireEvent.click(screen.getByRole('button', { name: 'مسدود کردن' }));

    await waitFor(() => {
      const call = api.calls.find((entry) => entry.url.includes('/block'));
      expect(call).toBeDefined();
      // Absent, not `''`. The contract trims and bounds the reason; an empty
      // string would be stored as a reason that says nothing and would read as
      // current on an active customer.
      expect(Object.keys(call?.body as object)).not.toContain('reason');
    });
  });

  it('draws no block control at all without users.block', async () => {
    stubApi(detail());
    renderPage(
      <UserDetailPage
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
    expect(screen.queryByLabelText('دلیل (اختیاری)')).toBeNull();
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
      <UserDetailPage id={ROW_ID} mayBlock {...NO_WALLET} {...NO_COMMERCE} denied={false} />,
    );
    await screen.findByRole('button', { name: 'مسدود کردن' });
    fireEvent.click(screen.getByRole('button', { name: 'مسدود کردن' }));

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
    await screen.findByText('ali_tehran', { exact: false });
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
    await screen.findByText('ali_tehran', { exact: false });

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
      <UserDetailPage id={ROW_ID} mayBlock {...ALL_WALLET} {...NO_COMMERCE} denied={false} />,
    );

    await screen.findByText('کیف پول');
    // The formatted amount, not the raw minor units.
    expect(await screen.findByText(/۷۵۰٬۰۰۰|750,000/u)).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
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
      <UserDetailPage id={ROW_ID} mayBlock {...ALL_WALLET} {...NO_COMMERCE} denied={false} />,
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
      <UserDetailPage id={ROW_ID} mayBlock {...ALL_WALLET} {...NO_COMMERCE} denied={false} />,
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
      <UserDetailPage id={ROW_ID} mayBlock {...ALL_WALLET} {...NO_COMMERCE} denied={false} />,
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
      <UserDetailPage id={ROW_ID} mayBlock {...ALL_WALLET} {...NO_COMMERCE} denied={false} />,
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
      <UserDetailPage id={ROW_ID} mayBlock {...ALL_WALLET} {...NO_COMMERCE} denied={false} />,
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
      <UserDetailPage id={ROW_ID} mayBlock {...ALL_WALLET} {...NO_COMMERCE} denied={false} />,
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
    expiresAt: '2026-12-01T00:00:00.000Z',
    trafficLimitBytes: '53687091200',
    trafficUsedBytes: '1073741824',
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

const ALL_COMMERCE = { mayViewOrders: true, mayViewServices: true } as const;

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
      <UserDetailPage id={ROW_ID} mayBlock {...NO_WALLET} {...ALL_COMMERCE} denied={false} />,
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
      <UserDetailPage id={ROW_ID} mayBlock {...NO_WALLET} {...ALL_COMMERCE} denied={false} />,
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
      <UserDetailPage id={ROW_ID} mayBlock {...NO_WALLET} {...ALL_COMMERCE} denied={false} />,
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
      <UserDetailPage id={ROW_ID} mayBlock {...NO_WALLET} {...ALL_COMMERCE} denied={false} />,
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

  it('names the missing permission and asks for nothing when orders are withheld', async () => {
    const api = withCards([{ url: '/services', body: { services: [], nextCursor: null } }]);
    renderPage(
      <UserDetailPage
        id={ROW_ID}
        mayBlock
        {...NO_WALLET}
        mayViewOrders={false}
        mayViewServices
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
        id={ROW_ID}
        mayBlock
        {...NO_WALLET}
        mayViewOrders
        mayViewServices={false}
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
      <UserDetailPage id={ROW_ID} mayBlock {...NO_WALLET} {...ALL_COMMERCE} denied={false} />,
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
      <UserDetailPage id={ROW_ID} mayBlock {...NO_WALLET} {...ALL_COMMERCE} denied={false} />,
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
