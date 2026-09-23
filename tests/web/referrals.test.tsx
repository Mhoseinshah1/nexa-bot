import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ReferralsPage } from '../../apps/web/src/pages/referrals';
import { UserDetailPage } from '../../apps/web/src/pages/users';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import { customer, renderPage, stubApi, type Api } from './harness';

/**
 * WP9-A on the Web Admin: the Referrals page and the referral card on a customer.
 *
 * Every response goes through the real client and the real zod schema, so a fixture that
 * drifts from `referralSummarySchema`, `referralCommissionSummarySchema` or
 * `customerReferralResponseSchema` fails here rather than in production. What these
 * cases hold is what the screen DOES with the server's figures: page by the cursor the
 * server minted, filter on the server, show an unearned commission as a dash rather than
 * a zero, ask nothing without `referrals.view` — and send nothing but GETs, because the
 * surface is read-only (`docs/wp9-referral-audit.md` F10).
 */

const REFERRER_ID = '019210ab-cdef-7012-8345-6789abcdef01';
const REFEREE_ID = '019210ab-cdef-7012-8345-6789abcdef02';
const REFERRAL_ID = '019270ab-cdef-7012-8345-6789abcdef01';
const COMMISSION_ID = '019280ab-cdef-7012-8345-6789abcdef01';
const ORDER_ID = '019230ab-cdef-7012-8345-6789abcdef01';

const referrer = {
  customerId: REFERRER_ID,
  telegramUserId: '5551234567',
  displayName: 'Sara Referrer',
};
const referee = { customerId: REFEREE_ID, telegramUserId: '5559876543', displayName: null };

function referral(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REFERRAL_ID,
    referrer,
    referee,
    trigger: 'ON_FIRST_PAID_ORDER',
    createdAt: '2026-09-10T12:30:00.000Z',
    ...overrides,
  };
}

function commission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: COMMISSION_ID,
    referralId: REFERRAL_ID,
    orderId: ORDER_ID,
    referrer,
    referee,
    scope: 'FIRST_PAID_ORDER',
    percent: 10,
    basisAmount: '1250000',
    promisedAmount: '125000',
    currency: 'IRT',
    state: 'EARNED',
    earnedAmount: '125000',
    reversedAmount: '0',
    unrecoveredAmount: '0',
    createdAt: '2026-09-10T12:30:00.000Z',
    earnedAt: '2026-09-11T12:30:00.000Z',
    voidedAt: null,
    ...overrides,
  };
}

const lists = (
  options: {
    referrals?: readonly Record<string, unknown>[];
    referralsNext?: string | null;
    commissions?: readonly Record<string, unknown>[];
    commissionsNext?: string | null;
  } = {},
) => [
  {
    url: '/referrals',
    body: {
      referrals: options.referrals ?? [referral()],
      nextCursor: options.referralsNext ?? null,
    },
  },
  {
    url: '/referral-commissions',
    body: {
      commissions: options.commissions ?? [commission()],
      nextCursor: options.commissionsNext ?? null,
    },
  },
];

const render = (query = '', denied = false) =>
  renderPage(
    <ReferralsPage
      route={{ path: '/referrals', query: new URLSearchParams(query) }}
      denied={denied}
    />,
  );

const attributionTable = () => screen.getByRole('table', { name: 'معرفی‌ها' });
const commissionTable = () => screen.getByRole('table', { name: 'دفتر پورسانت' });
const gets = (api: Api, path: string) =>
  api.calls.filter((call) => call.method === 'GET' && call.url.includes(path));

describe('the attributions list', () => {
  it('renders both parties, the snapshotted scope and links to each customer', async () => {
    stubApi(lists());
    render();
    const table = await waitFor(attributionTable);
    const row = within(table).getByText('Sara Referrer').closest('tr') as HTMLElement;
    // The referee has no display name, so the Telegram id IS the link.
    expect(within(row).getByText('5559876543').closest('a')?.getAttribute('href')).toBe(
      `/users/${REFEREE_ID}`,
    );
    expect(within(row).getByText('Sara Referrer').closest('a')?.getAttribute('href')).toBe(
      `/users/${REFERRER_ID}`,
    );
    expect(within(row).getByText('فقط نخستین سفارش پرداخت‌شده')).toBeInTheDocument();
  });

  it('pages OLDER by the cursor the server minted, and back again', async () => {
    const api = stubApi(lists({ referralsNext: 'ref-cursor-2' }));
    render();
    const card = (await waitFor(attributionTable)).closest('section') as HTMLElement;

    // Newest first, so the NEXT page is older and there is no previous one yet.
    expect(within(card).getByRole('button', { name: 'تازه‌تر' })).toBeDisabled();
    fireEvent.click(within(card).getByRole('button', { name: 'قدیمی‌تر' }));
    await waitFor(() => expect(gets(api, '/referrals?cursor=ref-cursor-2')).toHaveLength(1));
    // The commission list was not paged by the attribution pager.
    expect(gets(api, '/referral-commissions?cursor=')).toHaveLength(0);

    await waitFor(() =>
      expect(within(card).getByRole('button', { name: 'تازه‌تر' })).not.toBeDisabled(),
    );
    fireEvent.click(within(card).getByRole('button', { name: 'تازه‌تر' }));
    await waitFor(() =>
      expect(within(card).getByRole('button', { name: 'تازه‌تر' })).toBeDisabled(),
    );
  });

  it('says there are none rather than drawing an empty table', async () => {
    stubApi(lists({ referrals: [] }));
    render();
    expect(await screen.findByText('هنوز معرفی‌ای ثبت نشده است.')).toBeInTheDocument();
  });
});

describe('the commission ledger', () => {
  it('renders every figure as money in its own currency', async () => {
    stubApi(lists());
    render();
    const table = await waitFor(commissionTable);
    const row = within(table).getByText('Sara Referrer').closest('tr') as HTMLElement;
    expect(row.textContent).toContain('1,250,000');
    expect(row.textContent).toContain('125,000');
    expect(row.textContent).toContain('10');
    expect(row.textContent).toContain('درصد');
    expect(within(row).getByText('واریز شده')).toBeInTheDocument();
    // The scope the commission was promised under, frozen on the row.
    expect(within(row).getByText('فقط نخستین سفارش پرداخت‌شده')).toBeInTheDocument();
    expect(within(row).getByText(ORDER_ID.slice(0, 8)).closest('a')?.getAttribute('href')).toBe(
      `/orders/${ORDER_ID}`,
    );
    // Nothing went uncovered, so nothing is said about it.
    expect(screen.queryByText(/هرگز از معرف مطالبه نمی‌شود/)).toBeNull();
  });

  it('shows an unearned commission as a dash, never as zero', async () => {
    stubApi(
      lists({
        commissions: [commission({ state: 'PENDING', earnedAmount: null, earnedAt: null })],
      }),
    );
    render();
    const table = await waitFor(commissionTable);
    const row = within(table).getByText('Sara Referrer').closest('tr') as HTMLElement;
    expect(within(row).getByText('در انتظار تحویل')).toBeInTheDocument();
    // Earned and settled-at are both dashes: no amount and no date were decided.
    expect(within(row).getAllByText('—')).toHaveLength(2);
  });

  it('says out loud when a reversal went unrecovered', async () => {
    stubApi(
      lists({
        commissions: [commission({ reversedAmount: '125000', unrecoveredAmount: '40000' })],
      }),
    );
    render();
    await waitFor(commissionTable);
    expect(commissionTable().textContent).toContain('40,000');
    expect(screen.getByText(/هرگز از معرف مطالبه نمی‌شود/)).toBeInTheDocument();
  });

  it('filters by state on the server and starts that filter from its first page', async () => {
    const api = stubApi(lists({ commissionsNext: 'com-cursor-2' }));
    render();
    const card = (await waitFor(commissionTable)).closest('section') as HTMLElement;

    fireEvent.click(within(card).getByRole('button', { name: 'قدیمی‌تر' }));
    await waitFor(() =>
      expect(gets(api, '/referral-commissions?cursor=com-cursor-2')).toHaveLength(1),
    );

    fireEvent.click(within(card).getByRole('button', { name: 'باطل شده' }));
    await waitFor(() =>
      expect(api.calls.at(-1)?.url.endsWith('/referral-commissions?state=VOID')).toBe(true),
    );
  });
});

describe('the referrer filter', () => {
  it('narrows BOTH lists to the referrer in the URL', async () => {
    const api = stubApi(lists());
    render(`referrerId=${REFERRER_ID}`);
    await waitFor(commissionTable);
    expect(gets(api, `/referrals?referrerId=${REFERRER_ID}`)).toHaveLength(1);
    expect(gets(api, `/referral-commissions?referrerId=${REFERRER_ID}`)).toHaveLength(1);
  });

  it('refuses to apply something that is not a customer id', async () => {
    stubApi(lists());
    render();
    await waitFor(attributionTable);
    fireEvent.change(screen.getByLabelText('شناسهٔ معرف'), { target: { value: 'not-an-id' } });
    expect(screen.getByText('این یک شناسهٔ کامل مشتری نیست.')).toBeInTheDocument();
  });
});

describe('read-only, and asked only with referrals.view', () => {
  it('sends nothing but GETs and draws no write control', async () => {
    const api = stubApi(lists({ referralsNext: 'r2', commissionsNext: 'c2' }));
    render();
    await waitFor(commissionTable);
    for (const button of screen.getAllByRole('button')) fireEvent.click(button);
    await waitFor(() => expect(api.calls.length).toBeGreaterThan(2));
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('issues no request and says so when the actor lacks the key', async () => {
    const api = stubApi(lists());
    render('', true);
    expect((await screen.findAllByText('شما به این بخش دسترسی ندارید.')).length).toBe(2);
    expect(api.calls).toHaveLength(0);
    expect(screen.queryByLabelText('شناسهٔ معرف')).toBeNull();
  });

  it('is reached through the route table, and linked on referrals.view alone', async () => {
    stubApi(lists());
    const resolved = resolve({ path: '/referrals', query: new URLSearchParams() }, [
      'referrals.view',
    ]);
    const view = renderPage(resolved.element as ReactElement);
    await waitFor(() =>
      expect(within(view.container).getAllByText('Sara Referrer')).toHaveLength(2),
    );

    const entry = NAV.find((candidate) => candidate.id === 'referrals');
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.path).toBe('/referrals');
    expect(navPermitted(entry, ['referrals.view'])).toBe(true);
    expect(navPermitted(entry, ['users.view'])).toBe(false);
    expect(navPermitted(entry, [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The card on a customer
// ---------------------------------------------------------------------------

const OFF = {
  mayBlock: false,
  mayEditTrial: false,
  mayViewWallet: false,
  mayCredit: false,
  mayDebit: false,
  mayViewOrders: false,
  mayViewServices: false,
  mayViewReseller: false,
  mayEditReseller: false,
} as const;

const customerReferral = (overrides: Record<string, unknown> = {}) => ({
  customerId: REFEREE_ID,
  code: 'K7QX2M9PDA',
  referredBy: referral(),
  referredCount: 3,
  totals: [
    {
      currency: 'IRT',
      pendingAmount: '50000',
      earnedAmount: '125000',
      reversedAmount: '25000',
      unrecoveredAmount: '7000',
    },
  ],
  ...overrides,
});

const detailRoutes = (body: Record<string, unknown>) => [
  { url: `/users/${REFEREE_ID}`, body: { customer: customer({ id: REFEREE_ID }) } },
  { url: `/users/${REFEREE_ID}/referral`, body },
];

describe("the customer's referral card", () => {
  it('shows who referred them, how many they referred, and totals per currency', async () => {
    const api = stubApi(detailRoutes(customerReferral()));
    renderPage(<UserDetailPage id={REFEREE_ID} {...OFF} mayViewReferrals denied={false} />);
    const card = (await screen.findByRole('heading', { name: 'معرفی' })).closest(
      'section',
    ) as HTMLElement;
    await within(card).findByText('Sara Referrer');
    expect(within(card).getByText('فقط نخستین سفارش پرداخت‌شده')).toBeInTheDocument();
    expect(within(card).getByText('تعداد معرفی‌ها').parentElement?.textContent).toContain('3');
    const totals = within(card).getByRole('table');
    expect(totals.textContent).toContain('50,000');
    expect(totals.textContent).toContain('125,000');
    expect(totals.textContent).toContain('25,000');
    expect(totals.textContent).toContain('وصول‌نشده');
    expect(totals.textContent).toContain('7,000');
    expect(within(card).getByText('K7QX2M9PDA')).toBeInTheDocument();
    // The referees are one click away, on the page that can page them.
    expect(
      within(card).getByText('معرفی‌ها و پورسانت‌های این معرف').closest('a')?.getAttribute('href'),
    ).toBe(`/referrals?referrerId=${REFEREE_ID}`);
    expect(gets(api, `/users/${REFEREE_ID}/referral`)).toHaveLength(1);
  });

  it('says a customer nobody referred was not referred, and that none is owed', async () => {
    stubApi(
      detailRoutes(
        customerReferral({ code: null, referredBy: null, referredCount: 0, totals: [] }),
      ),
    );
    renderPage(<UserDetailPage id={REFEREE_ID} {...OFF} mayViewReferrals denied={false} />);
    expect(
      await screen.findByText('این مشتری با معرفی کسی ثبت‌نام نکرده است.'),
    ).toBeInTheDocument();
    expect(screen.getByText('هنوز پورسانتی به این مشتری تعلق نگرفته است.')).toBeInTheDocument();
    expect(screen.getByText('این مشتری هنوز لینک دعوت خود را باز نکرده است.')).toBeInTheDocument();
  });

  it('names the key and issues no request without referrals.view', async () => {
    const api = stubApi(detailRoutes(customerReferral()));
    renderPage(<UserDetailPage id={REFEREE_ID} {...OFF} mayViewReferrals={false} denied={false} />);
    expect(await screen.findByText(/referrals\.view/)).toBeInTheDocument();
    expect(gets(api, '/referral')).toHaveLength(0);
  });
});
