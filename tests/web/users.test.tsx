import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { UsersPage, UserDetailPage } from '../../apps/web/src/pages/users';
import { resolve } from '../../apps/web/src/app';
import { customer, renderPage, stubApi } from './harness';

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

const list = (customers: unknown[], nextCursor: string | null = null) => [
  { url: '/users', body: { customers, nextCursor } },
];

describe('the customer list', () => {
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
    const { container } = renderPage(<UserDetailPage id={ROW_ID} mayBlock denied={false} />);
    await screen.findByText('ali_tehran', { exact: false });
    const text = container.textContent ?? '';
    expect(text).not.toContain('فعالیت اخیر');
    expect(text).not.toContain('موجودی');
    expect(text).not.toContain('برچسب');
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
    renderPage(<UserDetailPage id={ROW_ID} mayBlock denied={false} />);
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
    renderPage(<UserDetailPage id={ROW_ID} mayBlock denied={false} />);
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
    renderPage(<UserDetailPage id={ROW_ID} mayBlock denied={false} />);
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
    renderPage(<UserDetailPage id={ROW_ID} mayBlock={false} denied={false} />);
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
    renderPage(<UserDetailPage id={ROW_ID} mayBlock denied={false} />);
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
});
