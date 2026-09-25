import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  reportFailuresResponseSchema,
  reportProductsResponseSchema,
  reportReferralsResponseSchema,
  reportSummaryResponseSchema,
  reportTrendResponseSchema,
} from '@nexa/contracts';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import { DashboardPage } from '../../apps/web/src/pages/dashboard';
import { ReferralsPage } from '../../apps/web/src/pages/referrals';
import { ReportsPage, formatInstantIn } from '../../apps/web/src/pages/business';
import { TrendChart } from '../../apps/web/src/ui/trend-chart';
import {
  BUSINESS_REFRESH_MS,
  describeChange,
  formatBasisPoints,
  formatRate,
  isSuperAdmin,
  rangeFromRoute,
} from '../../apps/web/src/report-view';
import { reportExportUrl } from '../../apps/web/src/api/client';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

const INACTIVE_LABEL = t('web.product_status_inactive');

/**
 * WP12 in the Web Admin (`docs/wp12-business-analytics-audit.md`).
 *
 * Fixtures go through the contract schemas the server writes with, so a shape the page
 * reads and the server does not send fails here. The business section is the owner's
 * only: every assertion that it is hidden is paired with one that nothing was fetched.
 */

const route = (query = '') => ({ path: '/', query: new URLSearchParams(query) });

const PERIOD = {
  range: 'TODAY',
  timezone: 'Asia/Tehran',
  calendar: 'jalali',
  granularity: 'HOUR',
  current: {
    start: '2026-09-24T20:30:00.000Z',
    end: '2026-09-25T20:30:00.000Z',
    effectiveEnd: '2026-09-25T08:30:00.000Z',
    startLocal: '1405/07/03',
    endLocalInclusive: '1405/07/03',
  },
  previous: {
    start: '2026-09-23T20:30:00.000Z',
    end: '2026-09-24T20:30:00.000Z',
    effectiveEnd: '2026-09-24T08:30:00.000Z',
    startLocal: '1405/07/02',
    endLocalInclusive: '1405/07/02',
  },
  lengthsDiffer: false,
  generatedAt: '2026-09-25T08:30:00.000Z',
};

const count = (current: number, previous: number) => ({ current, previous });
const irt = (current: string, previous: string) => [{ currency: 'IRT', current, previous }];

const SUMMARY = reportSummaryResponseSchema.parse({
  period: PERIOD,
  sales: count(6, 3),
  revenue: irt('177000', '0'),
  grossValue: irt('197000', '0'),
  discount: irt('20000', '0'),
  successfulOrders: count(7, 3),
  newUsers: count(2, 2),
  newBuyers: count(2, 1),
  newServices: count(2, 0),
  newTrialServices: count(1, 0),
  renewals: count(1, 0),
  walletTopupCount: count(1, 0),
  walletTopup: irt('60000', '30000'),
  activeServices: 3,
  activeCustomers: 3,
});

const bucket = (index: number, label: string, value: string | null) => ({
  index,
  start: new Date(Date.UTC(2026, 8, 24, 20, 30) + index * 3_600_000).toISOString(),
  end: new Date(Date.UTC(2026, 8, 24, 21, 30) + index * 3_600_000).toISOString(),
  label,
  value,
});

const TREND = reportTrendResponseSchema.parse({
  period: PERIOD,
  metric: 'REVENUE',
  currency: 'IRT',
  currencies: ['IRT'],
  current: [bucket(0, '00:00', '0'), bucket(1, '01:00', '80000'), bucket(2, '02:00', null)],
  previous: [bucket(0, '00:00', '5000'), bucket(1, '01:00', '7000'), bucket(2, '02:00', '0')],
});

const PRODUCTS = reportProductsResponseSchema.parse({
  period: PERIOD,
  by: 'REVENUE',
  page: 1,
  limit: 10,
  totalRows: 1,
  rows: [
    {
      rank: 1,
      productId: '019210ab-cdef-7012-8345-6789abcdef01',
      title: 'Plan A',
      categoryName: 'ویژه',
      categoryEmoji: null,
      productStatus: 'INACTIVE',
      orders: 2,
      quantity: 2,
      revenue: '110000',
      currency: 'IRT',
    },
  ],
});

const FAILURES = reportFailuresResponseSchema.parse({
  period: PERIOD,
  payments: { failed: 1, cancelled: 0, expired: 0, unknownNow: 0 },
  provisioning: { failed: 1, abandoned: 0 },
  commercialOperations: { failed: 0, abandoned: 0 },
  operationsUnknownNow: 0,
  byFailureKind: [{ failureKind: 'PROVIDER_ERROR', count: 1 }],
  ordersRefunded: 1,
});

const BUSINESS_ROUTES = [
  { url: '/reports/summary', body: SUMMARY },
  { url: '/reports/trend', body: TREND },
  { url: '/reports/products', body: PRODUCTS },
  { url: '/reports/failures', body: FAILURES },
  { url: '/system/readiness', body: { status: 'ok', dependencies: [] } },
];

const OWNER_PERMISSIONS = ['reports.view', 'reports.export'];

afterEach(() => {
  vi.useRealTimers();
});

describe('who sees business reports', () => {
  it('is the owner holding reports.view, and nobody else', () => {
    expect(isSuperAdmin(['owner'], ['reports.view'])).toBe(true);
    // A finance role holds the permission and is not the owner.
    expect(isSuperAdmin(['finance'], ['reports.view', 'reports.export'])).toBe(false);
    // An owner whose permission was overridden away is refused like the server refuses.
    expect(isSuperAdmin(['owner'], [])).toBe(false);
  });

  it('draws the Reports link for the owner only', () => {
    const reports = NAV.find((entry) => entry.id === 'reports');
    if (reports === undefined) throw new Error('no reports nav entry');
    expect(navPermitted(reports, ['reports.view'], ['owner'])).toBe(true);
    expect(navPermitted(reports, ['reports.view'], ['finance'])).toBe(false);
  });

  it('keeps a non-owner dashboard free of business figures and business requests', async () => {
    const api = stubApi(BUSINESS_ROUTES);
    renderPage(<DashboardPage permissions={['reports.view']} route={route()} superAdmin={false} />);
    await screen.findByText('وضعیت سامانه');
    expect(screen.queryByText('گزارش کسب‌وکار')).toBeNull();
    expect(api.calls.some((call) => call.url.includes('/reports/'))).toBe(false);
  });

  it('answers /reports for a non-owner with the owner-only notice, and fetches nothing', () => {
    const api = stubApi(BUSINESS_ROUTES);
    const resolved = resolve(
      { path: '/reports', query: new URLSearchParams() },
      ['reports.view'],
      ['finance'],
    );
    const view = renderPage(resolved.element as never);
    expect(within(view.container).getByText('این گزارش فقط برای مالک است.')).toBeInTheDocument();
    expect(api.calls.some((call) => call.url.includes('/reports/'))).toBe(false);
  });
});

describe('the business dashboard', () => {
  it('renders the eight KPI cards with exact money and the comparison', async () => {
    stubApi(BUSINESS_ROUTES);
    renderPage(<DashboardPage permissions={OWNER_PERMISSIONS} route={route()} superAdmin />);
    const kpis = await screen.findByText('شاخص‌های اصلی');
    const card = kpis.closest('section') as HTMLElement;
    await waitFor(() => expect(card.textContent).toContain('177,000'));
    for (const label of [
      'فروش',
      'درآمد',
      'سفارش موفق',
      'کاربر جدید',
      'سرویس جدید',
      'تمدید',
      'شارژ کیف پول',
      'سرویس فعال (اکنون)',
    ]) {
      expect(within(card).getAllByText(label).length, label).toBeGreaterThan(0);
    }
    // Full value, never abbreviated.
    expect(card.textContent).toContain('177,000');
    // 6 against 3 is +100%; nothing before and something now is "new", never infinity.
    expect(card.textContent).toContain('+100%');
    expect(within(card).getAllByText('جدید').length).toBeGreaterThan(0);
    expect(card.textContent).not.toContain('∞');
  });

  it('asks for the range the operator picks', async () => {
    const api = stubApi(BUSINESS_ROUTES);
    window.history.replaceState(null, '', '/');
    renderPage(<DashboardPage permissions={OWNER_PERMISSIONS} route={route()} superAdmin />);
    await screen.findByText('شاخص‌های اصلی');
    expect(api.calls.some((c) => c.url.includes('/reports/summary?range=TODAY'))).toBe(true);
    fireEvent.click(screen.getAllByRole('button', { name: 'دیروز' })[0] as HTMLElement);
    expect(window.location.search).toContain('range=YESTERDAY');
  });

  it('reads a range from the URL, and falls back on anything unknown', () => {
    expect(rangeFromRoute(route('range=LAST_7_DAYS'), 'TODAY')).toEqual({ range: 'LAST_7_DAYS' });
    expect(rangeFromRoute(route('range=nonsense'), 'TODAY')).toEqual({ range: 'TODAY' });
    expect(rangeFromRoute(route('range=CUSTOM&from=1405-07-01&to=bad'), 'TODAY')).toEqual({
      range: 'CUSTOM',
      from: '1405-07-01',
    });
  });

  it('re-reads every five minutes, not faster, and on the refresh button', async () => {
    expect(BUSINESS_REFRESH_MS).toBe(300_000);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = stubApi(BUSINESS_ROUTES);
    renderPage(<DashboardPage permissions={OWNER_PERMISSIONS} route={route()} superAdmin />);
    await screen.findByText('شاخص‌های اصلی');
    const summaries = () => api.calls.filter((c) => c.url.includes('/reports/summary')).length;
    const first = summaries();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(summaries()).toBe(first);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BUSINESS_REFRESH_MS);
    });
    await waitFor(() => expect(summaries()).toBeGreaterThan(first));
    const afterTimer = summaries();
    fireEvent.click(screen.getAllByRole('button', { name: 'تازه‌سازی' })[0] as HTMLElement);
    await waitFor(() => expect(summaries()).toBeGreaterThan(afterTimer));
  });

  it('shows the top products by their sold title, with a link to all of them', async () => {
    stubApi(BUSINESS_ROUTES);
    renderPage(<DashboardPage permissions={OWNER_PERMISSIONS} route={route()} superAdmin />);
    expect(await screen.findByText('Plan A')).toBeInTheDocument();
    const viewAll = screen.getByRole('link', { name: 'مشاهدهٔ همه' });
    expect(viewAll.getAttribute('href')).toBe('/reports?tab=products');
    // A product no longer on sale stays in the ranking, with its lifecycle named.
    expect(screen.getByText(INACTIVE_LABEL)).toBeInTheDocument();
  });

  it('says so when a report fails rather than showing zeros', async () => {
    stubApi([
      ...BUSINESS_ROUTES.filter((r) => r.url !== '/reports/summary'),
      {
        url: '/reports/summary',
        status: 500,
        body: {
          error: { kind: 'internal', code: 'internal.unhandled', message: 'x', correlationId: 't' },
        },
      },
    ]);
    renderPage(<DashboardPage permissions={OWNER_PERMISSIONS} route={route()} superAdmin />);
    const card = (await screen.findByText('شاخص‌های اصلی')).closest('section') as HTMLElement;
    await waitFor(() => expect(within(card).queryByText('177,000')).toBeNull());
    await waitFor(() => expect(within(card).getAllByRole('button').length).toBeGreaterThan(0));
    expect(card.textContent).not.toContain('177,000');
  });
});

describe('the trend chart', () => {
  it('draws both periods and names both in the readout', () => {
    renderPage(
      <TrendChart
        current={TREND.current}
        previous={TREND.previous}
        format={(v) => v}
        caption="درآمد"
      />,
    );
    fireEvent.mouseEnter(screen.getByTestId('trend-slot-1'));
    const readout = document.querySelector('.trend-readout') as HTMLElement;
    expect(readout.textContent).toContain('دورهٔ جاری');
    expect(readout.textContent).toContain('80000');
    expect(readout.textContent).toContain('دورهٔ قبل');
    expect(readout.textContent).toContain('7000');
    // A bucket that has not started is a gap, shown as a dash, never as zero.
    fireEvent.mouseEnter(screen.getByTestId('trend-slot-2'));
    expect(document.querySelector('.trend-readout')?.textContent).toContain('02:00: —');
    expect(document.querySelectorAll('polyline.current').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('polyline.previous').length).toBeGreaterThan(0);
    // No inline style anywhere: the production policy is style-src 'self'.
    expect(document.querySelector('[style]')).toBeNull();
  });
});

describe('report formatting', () => {
  it('never lets percentage math lie', () => {
    expect(describeChange(0n, 0n)).toEqual({ kind: 'none' });
    expect(describeChange(5n, 0n)).toEqual({ kind: 'new' });
    expect(describeChange(0n, 5n)).toEqual({ kind: 'change', basisPoints: -10_000n });
    expect(formatBasisPoints(1_250n)).toBe('+12.5%');
    expect(formatBasisPoints(-4_000n)).toBe('−40%');
    expect(formatRate(null)).toBe('—');
    expect(formatRate(5_000)).toBe('50%');
  });

  it('renders instants in the tenant zone and the Jalali calendar', () => {
    expect(formatInstantIn('2026-09-25T08:30:00Z', 'Asia/Tehran')).toBe('1405/07/03 12:00');
    // One minute before Tehran midnight, and one after: the date moves in Tehran's terms.
    expect(formatInstantIn('2026-09-25T20:29:00Z', 'Asia/Tehran')).toBe('1405/07/03 23:59');
    expect(formatInstantIn('2026-09-25T20:31:00Z', 'Asia/Tehran')).toBe('1405/07/04 00:01');
  });

  it('points the export buttons at the server, with the selected range', () => {
    const url = reportExportUrl(
      { range: 'CUSTOM', from: '1405-07-01', to: '1405-07-30' },
      'SALES',
      'xlsx',
    );
    expect(url).toBe(
      '/api/admin/v1/reports/export?range=CUSTOM&from=1405-07-01&to=1405-07-30&report=SALES&format=xlsx',
    );
  });
});

describe('the Reports page', () => {
  it('offers CSV and XLSX exports on the sales tab', async () => {
    stubApi([
      ...BUSINESS_ROUTES,
      { url: '/reports/orders', body: { period: PERIOD, rows: [], nextCursor: null } },
    ]);
    renderPage(
      <ReportsPage
        route={{ path: '/reports', query: new URLSearchParams('range=TODAY') }}
        denied={false}
      />,
    );
    const csv = await screen.findByRole('link', { name: 'خروجی CSV' });
    expect(csv.getAttribute('href')).toContain('report=SALES&format=csv');
    expect(screen.getByRole('link', { name: 'خروجی Excel' }).getAttribute('href')).toContain(
      'format=xlsx',
    );
  });
});

describe('referral analytics', () => {
  const REFERRALS = reportReferralsResponseSchema.parse({
    period: PERIOD,
    signups: count(4, 2),
    convertedBuyers: 1,
    conversionBasisPoints: 2_500,
    signupGifts: [{ currency: 'IRT', amount: '4000', entries: 2 }],
    commissions: [{ currency: 'IRT', amount: '3000', entries: 1 }],
    commissionReversals: [],
    referredSales: 4,
    referredRevenue: [{ currency: 'IRT', amount: '145000' }],
    topReferrers: {
      by: 'SIGNUPS',
      rankingCurrency: 'IRT',
      page: 1,
      limit: 10,
      totalRows: 1,
      rows: [
        {
          rank: 1,
          referrerId: '019210ab-cdef-7012-8345-6789abcdef99',
          signups: 4,
          convertedBuyers: 1,
          revenue: [{ currency: 'IRT', amount: '145000' }],
          commission: [{ currency: 'IRT', amount: '3000' }],
        },
      ],
    },
  });
  const LISTS = [
    { url: '/referrals', body: { referrals: [], nextCursor: null } },
    { url: '/referral-commissions', body: { commissions: [], nextCursor: null } },
    { url: '/reports/referrals', body: REFERRALS },
  ];

  it('lives inside the Referral page, for the owner, with Top Referrers linked by id only', async () => {
    stubApi(LISTS);
    renderPage(
      <ReferralsPage
        route={{ path: '/referrals', query: new URLSearchParams() }}
        denied={false}
        mayViewBanner={false}
        mayEditBanner={false}
        superAdmin
      />,
    );
    const title = await screen.findByText('تحلیل معرفی');
    const card = title.closest('section') as HTMLElement;
    await waitFor(() => expect(card.textContent).toContain('25%'));
    expect(card.textContent).toContain('145,000');
    const link = within(card).getByRole('link', { name: 'abcdef99' });
    expect(link.getAttribute('href')).toBe('/users/019210ab-cdef-7012-8345-6789abcdef99');
  });

  it('is absent, and never asked for, without the owner role', async () => {
    const api = stubApi(LISTS);
    renderPage(
      <ReferralsPage
        route={{ path: '/referrals', query: new URLSearchParams() }}
        denied={false}
        mayViewBanner={false}
        mayEditBanner={false}
      />,
    );
    await waitFor(() => expect(api.calls.some((c) => c.url.includes('/referrals'))).toBe(true));
    expect(screen.queryByText('تحلیل معرفی')).toBeNull();
    expect(api.calls.some((c) => c.url.includes('/reports/referrals'))).toBe(false);
  });
});
