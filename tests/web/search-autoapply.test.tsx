import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { PaymentsPage } from '../../apps/web/src/pages/payments';
import { ProductsPage } from '../../apps/web/src/pages/products';
import { ResellersPage } from '../../apps/web/src/pages/resellers';
import { TicketsPage } from '../../apps/web/src/pages/tickets';
import { AuditLogPage } from '../../apps/web/src/pages/audit-log';
import { ReferralsPage } from '../../apps/web/src/pages/referrals';
import { CustomerPicker } from '../../apps/web/src/pages/customer-picker';
import { LIST_SEARCH_DEBOUNCE_MS, useDebouncedApply } from '../../apps/web/src/ui/list-search';
import { navigate, useRoute } from '../../apps/web/src/router';
import { t } from '../../apps/web/src/i18n/web.fa';
import { customer, product, renderPage } from './harness';

/**
 * FIX-01 (2026-10-09): every data search in the Web Admin applies itself.
 *
 * `/users`, `/orders` and `/services` already did (`customer-search.test.tsx`,
 * `list-polish.test.tsx`). This file holds every list that did NOT, each rendered through
 * the LIVE route — the box applies by navigating, and only a page that re-reads the URL can
 * show what that navigation asked the server — and the same five behaviours asked of each:
 * a burst of typing is one request, a paste is trimmed, clearing restores the unfiltered
 * list, a slower answer to an older term never replaces a newer one, and a new term starts
 * at the first page. The matrix is `docs/web-redesign/search-autoapply.md`.
 *
 * Fake timers with `shouldAdvanceTime`, every boundary asserted with a 250 ms margin either
 * side of the debounce, as `customer-search.test.tsx` does.
 */

const SHORT = LIST_SEARCH_DEBOUNCE_MS - 250;
const PAST = LIST_SEARCH_DEBOUNCE_MS + 250;
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

const UUID_A = '019210ab-cdef-7012-8345-6789abcdef0a';
const UUID_B = '019210ab-cdef-7012-8345-6789abcdef0b';

interface Call {
  readonly url: string;
  readonly method: string;
}

/**
 * A fetch stub that answers by pathname and lets one test hold a response back. `answer`
 * returns the JSON body for a request, or a Promise for one a test releases later.
 */
function stubFetch(answer: (url: URL) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x');
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      const body = answer(url);
      const respond = (value: unknown) =>
        value === undefined
          ? new Response(
              JSON.stringify({
                error: {
                  kind: 'not_found',
                  code: 'test.unrouted',
                  message: '',
                  correlationId: 't',
                },
              }),
              { status: 404, headers: { 'content-type': 'application/json' } },
            )
          : new Response(JSON.stringify(value), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
      return body instanceof Promise ? body.then(respond) : Promise.resolve(respond(body));
    }),
  );
  return calls;
}

// ---------------------------------------------------------------------------
// The routes, each as one row of the matrix
// ---------------------------------------------------------------------------

interface Spec {
  readonly name: string;
  readonly path: string;
  readonly page: () => ReactElement;
  readonly box: () => HTMLInputElement;
  /** The list's own GET, by the END of its pathname. */
  readonly list: string;
  /** The request parameter the term is sent as, and the URL key it lives under. */
  readonly param: string;
  /** One page of the list, in the server's shape. */
  readonly body: (rows: number, next: boolean) => unknown;
  /** Everything else the page reads. */
  readonly extras?: (url: URL) => unknown;
  /** Two valid terms, the second typed after the first; and a paste, with its whitespace. */
  readonly terms: readonly [string, string];
  readonly paste: string;
  /** The pager's "next" button, and the request parameter its cursor travels in. */
  readonly next: 'web.older' | 'web.newer';
  readonly cursorParam: string;
}

const PAYMENT = {
  id: '019240ab-cdef-7012-8345-6789abcdef01',
  customerId: '019210ab-cdef-7012-8345-6789abcdef01',
  orderId: '019230ab-cdef-7012-8345-6789abcdef01',
  state: 'PENDING',
  method: 'MANUAL_TRANSFER',
  amount: '250000',
  currency: 'IRT',
  reference: 'a1b2c3d4e5f60718',
  evidenceKind: null,
  confirmedAt: null,
  confirmedByAdminId: null,
  resolvedAt: null,
  resolvedByAdminId: null,
  customerSignalledAt: null,
  expiresAt: null,
  createdAt: '2026-09-10T12:30:00.000Z',
  updatedAt: '2026-09-10T12:30:00.000Z',
};

const RESELLER = {
  customerId: '019210ab-cdef-7012-8345-6789abcdef01',
  telegramUserId: '5551234567',
  displayName: 'Reza Reseller',
  tier: { id: '019290ab-cdef-7012-8345-6789abcdef01', name: 'Gold' },
  status: 'ACTIVE',
  pricingMode: 'TIER',
  discountPercentage: null,
  creditLimit: null,
  effectiveCreditLimit: { amount: '500000', currency: 'IRT' },
  createdAt: '2026-09-02T08:00:00.000Z',
  updatedAt: '2026-09-02T08:00:00.000Z',
};

const TICKET = {
  id: '019300ab-cdef-7012-8345-6789abcdef01',
  number: 42,
  status: 'WAITING_FOR_SUPPORT',
  priority: 'HIGH',
  categoryId: '019310ab-cdef-7012-8345-6789abcdef01',
  categoryTitle: 'مشکل اتصال',
  subject: 'سرویس وصل نمی‌شود',
  customerId: '019320ab-cdef-7012-8345-6789abcdef01',
  customerTelegramUserId: '951001',
  customerUsername: 'mary',
  customerDisplayName: 'مریم',
  assignedAdminId: null,
  assignedAdminUsername: null,
  serviceId: null,
  orderId: null,
  paymentId: null,
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T11:00:00.000Z',
  lastMessageAt: '2026-09-20T11:00:00.000Z',
  closedAt: null,
};

const AUDIT_ENTRY = {
  id: '019360ab-cdef-7012-8345-6789abcdef01',
  occurredAt: '2026-09-20T10:00:00.000Z',
  actorType: 'WEB_ADMIN',
  actorId: '019330ab-cdef-7012-8345-6789abcdef01',
  actorLabel: 'owner',
  surface: 'WEB',
  action: 'order.confirm',
  entityType: 'Order',
  entityId: '019350ab-cdef-7012-8345-6789abcdef01',
  result: 'SUCCESS',
  reason: null,
  correlationId: 'corr-1',
  before: null,
  after: null,
  security: [],
  links: { customerId: null, orderId: null, paymentId: null, serviceId: null },
};

const REFERRAL = {
  id: '019270ab-cdef-7012-8345-6789abcdef01',
  referrer: { customerId: UUID_A, telegramUserId: '5551234567', displayName: 'Sara' },
  referee: {
    customerId: '019210ab-cdef-7012-8345-6789abcdef02',
    telegramUserId: '5559876543',
    displayName: null,
  },
  trigger: 'ON_FIRST_PAID_ORDER',
  createdAt: '2026-09-10T12:30:00.000Z',
};

const rowsOf = <T,>(row: T, count: number): T[] =>
  Array.from({ length: count }, (_, index) => ({
    ...row,
    id: `${String((row as { id?: string }).id ?? '').slice(0, -2)}${String(index).padStart(2, '0')}`,
  }));

function Live({ children }: { children: (route: ReturnType<typeof useRoute>) => ReactElement }) {
  return children(useRoute());
}

const byId = (id: string) => () => document.getElementById(id) as HTMLInputElement;

const SPECS: readonly Spec[] = [
  {
    name: '/payments',
    path: '/payments',
    page: () => <Live>{(route) => <PaymentsPage route={route} denied={false} />}</Live>,
    box: byId('payments-search'),
    list: '/payments',
    param: 'q',
    body: (rows, next) => ({ payments: rowsOf(PAYMENT, rows), nextCursor: next ? 'C2' : null }),
    terms: ['ali', 'alireza'],
    paste: '  5551234567 \n',
    next: 'web.older',
    cursorParam: 'cursor',
  },
  {
    name: '/products',
    path: '/products',
    page: () => (
      <Live>{(route) => <ProductsPage route={route} mayEdit={false} denied={false} />}</Live>
    ),
    box: byId('products-title'),
    list: '/products',
    param: 'title',
    body: (rows, next) => ({
      products: rowsOf(product(), rows),
      nextCursor: next ? 'C2' : null,
    }),
    extras: (url) =>
      url.pathname.endsWith('/product-categories') ? { categories: [] } : undefined,
    terms: ['پلن', 'پلن یک'],
    paste: '  پلن یک‌ماهه \n',
    next: 'web.newer',
    cursorParam: 'cursor',
  },
  {
    name: '/resellers',
    path: '/resellers',
    page: () => (
      <Live>
        {(route) => (
          <ResellersPage
            route={route}
            denied={false}
            mayEdit={false}
            mayViewWallet={false}
            mayViewOrders={false}
            mayViewAudit={false}
          />
        )}
      </Live>
    ),
    box: byId('resellers-search'),
    list: '/resellers',
    param: 'search',
    body: (rows, next) => ({
      resellers: Array.from({ length: rows }, (_, index) => ({
        ...RESELLER,
        customerId: `${RESELLER.customerId.slice(0, -2)}${String(index).padStart(2, '0')}`,
      })),
      nextCursor: next ? 'C2' : null,
    }),
    extras: (url) => (url.pathname.endsWith('/reseller-tiers') ? { tiers: [] } : undefined),
    terms: ['رضا', 'رضا رس'],
    paste: '  5551234567 \n',
    next: 'web.older',
    cursorParam: 'cursor',
  },
  {
    name: '/tickets',
    path: '/tickets',
    page: () => (
      <Live>
        {(route) => (
          <TicketsPage route={route} denied={false} mayAssign={false} mayEditCategories={false} />
        )}
      </Live>
    ),
    box: byId('tickets-customer'),
    list: '/tickets',
    param: 'customer',
    body: (rows, next) => ({
      tickets: rowsOf(TICKET, rows),
      nextCursor: next ? { at: '2026-09-20T11:00:00.000Z', id: TICKET.id } : null,
    }),
    extras: (url) => (url.pathname.endsWith('/ticket-categories') ? { categories: [] } : undefined),
    terms: ['mar', 'mary'],
    paste: '  951001 \n',
    next: 'web.older',
    cursorParam: 'before',
  },
  {
    name: '/audit-log',
    path: '/audit-log',
    page: () => (
      <Live>{(route) => <AuditLogPage route={route} denied={false} mayExport={false} />}</Live>
    ),
    box: byId('audit-actor'),
    list: '/audit-log',
    param: 'actor',
    body: (rows, next) => ({ entries: rowsOf(AUDIT_ENTRY, rows), nextCursor: next ? 'C2' : null }),
    terms: ['own', 'owner'],
    paste: '  owner \n',
    next: 'web.older',
    cursorParam: 'cursor',
  },
  {
    name: '/referrals',
    path: '/referrals',
    page: () => (
      <Live>
        {(route) => (
          <ReferralsPage route={route} denied={false} mayViewBanner={false} mayEditBanner={false} />
        )}
      </Live>
    ),
    box: byId('referrals-referrer'),
    list: '/referrals',
    param: 'referrerId',
    body: (rows, next) => ({ referrals: rowsOf(REFERRAL, rows), nextCursor: next ? 'C2' : null }),
    extras: (url) =>
      url.pathname.endsWith('/referral-commissions')
        ? { commissions: [], nextCursor: null }
        : undefined,
    // Only a complete id is a referrer filter: both terms are ids.
    terms: [UUID_A, UUID_B],
    paste: `  ${UUID_A} \n`,
    next: 'web.older',
    cursorParam: 'cursor',
  },
];

const listReads = (calls: readonly Call[], spec: Spec) =>
  calls.filter(
    (call) => call.method === 'GET' && new URL(call.url, 'http://x').pathname.endsWith(spec.list),
  );
const sent = (calls: readonly Call[], spec: Spec) =>
  listReads(calls, spec).map((call) => new URL(call.url, 'http://x').searchParams.get(spec.param));
const inUrl = (spec: Spec) => new URLSearchParams(window.location.search).get(spec.param);

/** The list answers every request with one page of `rows` rows. */
const serve = (spec: Spec, rows = 1, next = false) =>
  stubFetch((url) =>
    url.pathname.endsWith(spec.list) ? spec.body(rows, next) : spec.extras?.(url),
  );

/** Renders the page and waits for its first, unfiltered list to arrive. */
async function open(spec: Spec, calls: () => readonly Call[]) {
  renderPage(spec.page());
  await waitFor(() => expect(listReads(calls(), spec).length).toBeGreaterThan(0));
  await waitFor(() => expect(spec.box()).toBeTruthy());
}

const type = (spec: Spec, value: string) => fireEvent.change(spec.box(), { target: { value } });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each(SPECS)('$name: the search applies itself (FIX-01)', (spec) => {
  beforeEach(() => {
    navigate(spec.path, { replace: true, force: true });
  });

  it('typing: one request for a burst, after the debounce, with no Enter and no extra history', async () => {
    const calls = serve(spec);
    await open(spec, () => calls);
    const history = window.history.length;
    spec.box().focus();
    const before = calls.length;

    // Typed a character at a time, each well inside the debounce of the last.
    const [, term] = spec.terms;
    for (let end = 1; end <= term.length; end += 1) {
      type(spec, term.slice(0, end));
      await advance(50);
    }
    await advance(SHORT);
    expect(sent(calls.slice(before), spec), 'the debounce fired early').toEqual([]);

    await advance(PAST);
    await waitFor(() => expect(sent(calls.slice(before), spec)).toEqual([term]));
    expect(inUrl(spec)).toBe(term);
    // The search replaces the history entry: Back leaves the list, not the keystroke.
    expect(window.history.length).toBe(history);
    // The box kept the caret: the list re-rendered around it, not over it.
    expect(document.activeElement).toBe(spec.box());
    expect(spec.box().value).toBe(term);

    // Nothing more is sent once the applied term is the typed one.
    await advance(PAST * 2);
    expect(sent(calls.slice(before), spec)).toEqual([term]);
  });

  it('paste: applies by itself, trimmed', async () => {
    const calls = serve(spec);
    await open(spec, () => calls);
    const before = calls.length;
    fireEvent.paste(spec.box());
    type(spec, spec.paste);
    await advance(PAST);
    await waitFor(() => expect(sent(calls.slice(before), spec)).toEqual([spec.paste.trim()]));
    expect(inUrl(spec)).toBe(spec.paste.trim());
  });

  it('clear: emptying the box restores the unfiltered list', async () => {
    navigate(`${spec.path}?${spec.param}=${encodeURIComponent(spec.terms[0])}`, {
      replace: true,
      force: true,
    });
    const calls = serve(spec);
    await open(spec, () => calls);
    expect(spec.box().value).toBe(spec.terms[0]);
    const before = calls.length;
    type(spec, '');
    await advance(PAST);
    await waitFor(() => expect(inUrl(spec)).toBeNull());
    await waitFor(() => expect(sent(calls.slice(before), spec)).toEqual([null]));
  });

  it('rapid change: an older, slower answer never replaces a newer one', async () => {
    const [older, newer] = spec.terms;
    let release: () => void = () => undefined;
    const calls = stubFetch((url) => {
      if (!url.pathname.endsWith(spec.list)) return spec.extras?.(url);
      const term = url.searchParams.get(spec.param);
      // The older term is answered LAST, with rows; the newer one at once, with none.
      if (term === older) {
        return new Promise((resolve) => {
          release = () => resolve(spec.body(3, false));
        });
      }
      return spec.body(term === null ? 1 : 0, false);
    });
    await open(spec, () => calls);

    type(spec, older);
    await advance(PAST);
    await waitFor(() => expect(sent(calls, spec)).toContain(older));
    type(spec, newer);
    await advance(PAST);
    await waitFor(() => expect(sent(calls, spec)).toContain(newer));
    await waitFor(() => expect(screen.queryAllByRole('row')).toHaveLength(0));

    release();
    await advance(100);
    expect(screen.queryAllByRole('row'), 'the stale answer replaced the newer one').toHaveLength(0);
    expect(inUrl(spec)).toBe(newer);
    expect(spec.box().value).toBe(newer);
  });

  it('cursor: a new term starts at the first page', async () => {
    const calls = serve(spec, 1, true);
    await open(spec, () => calls);
    fireEvent.click(await screen.findByRole('button', { name: t(spec.next) }));
    await waitFor(() =>
      expect(listReads(calls, spec).at(-1)!.url).toContain(`${spec.cursorParam}=`),
    );
    type(spec, spec.terms[0]);
    await advance(PAST);
    await waitFor(() => expect(sent(calls, spec).at(-1)).toBe(spec.terms[0]));
    expect(listReads(calls, spec).at(-1)!.url).not.toContain(`${spec.cursorParam}=`);
  });

  it('navigation: a half-typed term is not carried into a list reached another way', async () => {
    const calls = serve(spec);
    await open(spec, () => calls);
    type(spec, spec.terms[0]);
    await advance(SHORT);
    // The sidebar link for the same list, pressed inside the debounce.
    act(() => navigate(`${spec.path}?other=1`, { force: true }));
    const before = calls.length;
    await advance(PAST * 2);
    expect(sent(calls.slice(before), spec).filter((term) => term !== null)).toEqual([]);
    expect(inUrl(spec)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The gates a typed filter keeps: an invalid draft waits
// ---------------------------------------------------------------------------

describe('a draft with a problem is never applied by itself', () => {
  it('/referrals: a half-typed referrer id sends nothing', async () => {
    const spec = SPECS.find((one) => one.name === '/referrals')!;
    navigate(spec.path, { replace: true, force: true });
    const calls = serve(spec);
    await open(spec, () => calls);
    const before = calls.length;
    type(spec, UUID_A.slice(0, 12));
    await advance(PAST * 2);
    expect(sent(calls.slice(before), spec)).toEqual([]);
    expect(inUrl(spec)).toBeNull();
  });

  it('/audit-log: an action that is not a code sends nothing; a valid one applies', async () => {
    const spec = SPECS.find((one) => one.name === '/audit-log')!;
    navigate(spec.path, { replace: true, force: true });
    const calls = serve(spec);
    await open(spec, () => calls);
    const before = calls.length;
    const action = byId('audit-action');
    fireEvent.change(action(), { target: { value: 'Payment Confirm' } });
    await advance(PAST * 2);
    expect(listReads(calls.slice(before), spec)).toEqual([]);
    // Not in the URL either: the filter the page reads would drop it, but a link copied
    // now would carry a filter that is not in force.
    expect(new URLSearchParams(window.location.search).get('action')).toBeNull();
    fireEvent.change(action(), { target: { value: 'payment.' } });
    await advance(PAST);
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get('action')).toBe('payment.'),
    );
  });

  it('/tickets: a reversed date range sends nothing; the customer still waits for it', async () => {
    const spec = SPECS.find((one) => one.name === '/tickets')!;
    navigate(spec.path, { replace: true, force: true });
    const calls = serve(spec);
    await open(spec, () => calls);
    const before = calls.length;
    fireEvent.change(byId('tickets-from')(), { target: { value: '2026-09-20' } });
    fireEvent.change(byId('tickets-to')(), { target: { value: '2026-09-10' } });
    type(spec, 'mary');
    await advance(PAST * 2);
    expect(listReads(calls.slice(before), spec)).toEqual([]);
    // Fixing the range applies everything typed, in one navigation.
    fireEvent.change(byId('tickets-to')(), { target: { value: '2026-09-25' } });
    await advance(PAST);
    await waitFor(() => expect(inUrl(spec)).toBe('mary'));
    expect(new URLSearchParams(window.location.search).get('from')).toBe('2026-09-20');
    expect(new URLSearchParams(window.location.search).get('to')).toBe('2026-09-25');
  });

  it('/products: Enter still applies at once, and the pending apply does not send it twice', async () => {
    const spec = SPECS.find((one) => one.name === '/products')!;
    navigate(spec.path, { replace: true, force: true });
    const calls = serve(spec);
    await open(spec, () => calls);
    const before = calls.length;
    type(spec, 'پلن');
    fireEvent.submit(spec.box().closest('form')!);
    await waitFor(() => expect(sent(calls.slice(before), spec)).toEqual(['پلن']));
    await advance(PAST * 2);
    expect(sent(calls.slice(before), spec)).toEqual(['پلن']);
  });

  it('/resellers: a pause after a trailing space keeps the space under the caret', async () => {
    const spec = SPECS.find((one) => one.name === '/resellers')!;
    navigate(spec.path, { replace: true, force: true });
    const calls = serve(spec);
    await open(spec, () => calls);
    type(spec, 'رضا ');
    await advance(PAST);
    await waitFor(() => expect(inUrl(spec)).toBe('رضا'));
    expect(spec.box().value).toBe('رضا ');
  });
});

// ---------------------------------------------------------------------------
// A cancelled draft stays cancelled (Codex P2 on #249)
// ---------------------------------------------------------------------------

describe('a draft cancelled by another navigation is not revived by returning', () => {
  const spec = () => SPECS.find((one) => one.name === '/products')!;
  const status = () => new URLSearchParams(window.location.search).get('status');

  it('/products: a status chip inside the wait, then the chip back to «همه»', async () => {
    navigate('/products', { replace: true, force: true });
    const calls = serve(spec());
    await open(spec(), () => calls);
    type(spec(), 'پلن');
    await advance(SHORT);
    fireEvent.click(screen.getByRole('button', { name: t('web.product_status_active') }));
    await waitFor(() => expect(status()).toBe('ACTIVE'));
    await advance(50);
    fireEvent.click(screen.getAllByRole('button', { name: t('web.users_filter_all') })[0]!);
    await waitFor(() => expect(status()).toBeNull());
    const before = calls.length;
    await advance(PAST * 2);
    expect(inUrl(spec())).toBeNull();
    expect(sent(calls.slice(before), spec()).filter((term) => term !== null)).toEqual([]);
  });

  it('/products: another list inside the wait, then the browser Back button', async () => {
    navigate('/products', { replace: true, force: true });
    const calls = serve(spec());
    await open(spec(), () => calls);
    type(spec(), 'پلن');
    await advance(SHORT);
    act(() => navigate('/products?status=ACTIVE', { force: true }));
    await waitFor(() => expect(status()).toBe('ACTIVE'));
    await advance(50);
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    });
    await waitFor(() => expect(status()).toBeNull());
    const before = calls.length;
    await advance(PAST * 2);
    expect(inUrl(spec())).toBeNull();
    expect(sent(calls.slice(before), spec()).filter((term) => term !== null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The customer picker (the reseller register form): not a list, not in the URL
// ---------------------------------------------------------------------------

describe('the customer picker searches by itself', () => {
  const box = () => document.getElementById('picker') as HTMLInputElement;
  const picks = (calls: readonly Call[]) =>
    calls
      .filter((call) => new URL(call.url, 'http://x').pathname.endsWith('/users'))
      .map((call) => new URL(call.url, 'http://x').searchParams.get('q'));

  it('one request per burst, trimmed; emptying withdraws the results; a stale answer loses', async () => {
    let release: () => void = () => undefined;
    const calls = stubFetch((url) => {
      const q = url.searchParams.get('q');
      if (q === 'ali') {
        return new Promise((resolve) => {
          release = () =>
            resolve({ customers: [customer({ username: 'ali_old' })], nextCursor: null });
        });
      }
      return { customers: [customer({ username: 'alireza' })], nextCursor: null };
    });
    renderPage(<CustomerPicker inputId="picker" maySearch onPick={() => undefined} />);

    fireEvent.change(box(), { target: { value: 'a' } });
    await advance(50);
    fireEvent.change(box(), { target: { value: ' ali ' } });
    await advance(SHORT);
    expect(picks(calls)).toEqual([]);
    await advance(PAST);
    await waitFor(() => expect(picks(calls)).toEqual(['ali']));

    fireEvent.change(box(), { target: { value: 'alireza' } });
    await advance(PAST);
    await screen.findByText('@alireza');
    release();
    await advance(100);
    expect(screen.queryByText('@ali_old'), 'the stale answer replaced the newer one').toBeNull();

    fireEvent.change(box(), { target: { value: '' } });
    await advance(PAST);
    await waitFor(() => expect(screen.queryByText('@alireza')).toBeNull());
    expect(picks(calls)).toEqual(['ali', 'alireza']);
  });

  it('Enter searches at once and never submits the enclosing form', async () => {
    const calls = stubFetch(() => ({ customers: [], nextCursor: null }));
    const submitted = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    renderPage(
      <form onSubmit={submitted}>
        <CustomerPicker inputId="picker" maySearch onPick={() => undefined} />
      </form>,
    );
    fireEvent.change(box(), { target: { value: '5551234567' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(picks(calls)).toEqual(['5551234567']));
    await advance(PAST * 2);
    expect(picks(calls)).toEqual(['5551234567']);
    expect(submitted).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The shared debounce, on its own (`useDebouncedApply`)
// ---------------------------------------------------------------------------

function Probe({
  routeKey,
  ready = true,
  onApply,
}: {
  routeKey: string;
  ready?: boolean;
  onApply: (value: string) => void;
}) {
  const [text, setText] = useState('');
  const [applied, setApplied] = useState('');
  const [renders, setRenders] = useState(0);
  const debounce = useDebouncedApply({
    wanted: text,
    applied,
    routeKey,
    ready,
    apply: () => {
      onApply(text);
      setApplied(text);
    },
  });
  return (
    <>
      <input
        aria-label="probe"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          debounce.edited();
        }}
        {...debounce.composition}
      />
      <button type="button" onClick={() => setRenders(renders + 1)}>
        rerender {renders}
      </button>
    </>
  );
}

describe('useDebouncedApply', () => {
  const probe = () => screen.getByLabelText('probe');

  it('applies once, after the wait, the LATEST text', async () => {
    const onApply = vi.fn();
    render(<Probe routeKey="/a" onApply={onApply} />);
    fireEvent.change(probe(), { target: { value: 'a' } });
    await advance(SHORT);
    fireEvent.change(probe(), { target: { value: 'ab' } });
    await advance(SHORT);
    expect(onApply).not.toHaveBeenCalled();
    await advance(PAST);
    expect(onApply.mock.calls).toEqual([['ab']]);
  });

  it('never applies a draft that is already the applied one', async () => {
    const onApply = vi.fn();
    render(<Probe routeKey="/a" onApply={onApply} />);
    fireEvent.change(probe(), { target: { value: 'ab' } });
    await advance(PAST);
    expect(onApply.mock.calls).toEqual([['ab']]);
    await advance(PAST * 4);
    expect(onApply.mock.calls).toEqual([['ab']]);
  });

  it('is not restarted by a re-render that changes nothing it compares', async () => {
    // A list re-renders while it fetches; a timer reset by every render would never fire.
    const onApply = vi.fn();
    render(<Probe routeKey="/a" onApply={onApply} />);
    fireEvent.change(probe(), { target: { value: 'ab' } });
    for (let step = 0; step < 6; step += 1) {
      await advance(100);
      fireEvent.click(screen.getByRole('button'));
    }
    expect(onApply.mock.calls).toEqual([['ab']]);
  });

  it('waits while composing, and applies the finished word', async () => {
    const onApply = vi.fn();
    render(<Probe routeKey="/a" onApply={onApply} />);
    fireEvent.compositionStart(probe());
    fireEvent.change(probe(), { target: { value: 'سل' } });
    await advance(PAST * 2);
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.change(probe(), { target: { value: 'سلام' } });
    fireEvent.compositionEnd(probe());
    await advance(PAST);
    expect(onApply.mock.calls).toEqual([['سلام']]);
  });

  it('applies nothing while not ready', async () => {
    const onApply = vi.fn();
    render(<Probe routeKey="/a" ready={false} onApply={onApply} />);
    fireEvent.change(probe(), { target: { value: 'ab' } });
    await advance(PAST * 2);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('does not revive a cancelled draft when the route comes back to the same key', async () => {
    // Codex P2 on #249: typed on /a, moved to /b inside the wait, back on /a later.
    const onApply = vi.fn();
    const { rerender } = render(<Probe routeKey="/a" onApply={onApply} />);
    fireEvent.change(probe(), { target: { value: 'ab' } });
    await advance(SHORT);
    rerender(<Probe routeKey="/b" onApply={onApply} />);
    await advance(50);
    rerender(<Probe routeKey="/a" onApply={onApply} />);
    await advance(PAST * 2);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('cancels when the route moves away from the one the text was typed under', async () => {
    const onApply = vi.fn();
    const { rerender } = render(<Probe routeKey="/a" onApply={onApply} />);
    fireEvent.change(probe(), { target: { value: 'ab' } });
    await advance(SHORT);
    rerender(<Probe routeKey="/b" onApply={onApply} />);
    await advance(PAST * 2);
    expect(onApply).not.toHaveBeenCalled();
    // The next keystroke applies under the new route.
    fireEvent.change(probe(), { target: { value: 'abc' } });
    await advance(PAST);
    expect(onApply.mock.calls).toEqual([['abc']]);
  });
});
