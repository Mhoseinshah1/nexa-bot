import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  COUNTER_CAP,
  DASHBOARD_OPERATIONS_REFRESH_MS,
  DASHBOARD_SUMMARY_REFRESH_MS,
  NAV_COUNTERS_REFRESH_MS,
  dashboardOperationsResponseSchema,
  dashboardSummaryResponseSchema,
  navCountersResponseSchema,
  reportFailuresResponseSchema,
  reportProductsResponseSchema,
  reportSummaryResponseSchema,
} from '@nexa/contracts';
import { DashboardPage, healthSlices, providerSlices } from '../../apps/web/src/pages/dashboard';
import {
  axisLabel,
  chartMoneyText,
  chartMoneyTexts,
  compareFromRoute,
  dashboardSelection,
  kpiDelta,
} from '../../apps/web/src/dashboard-view';
import { navCountersFrom } from '../../apps/web/src/nav-counters';
import { formatTimestamp } from '../../apps/web/src/format';
import { t } from '../../apps/web/src/i18n/web.fa';
import { useRoute } from '../../apps/web/src/router';
import { event, renderPage, stubApi } from './harness';

/**
 * The dashboard (`docs/web-redesign/dashboard.md` §6).
 *
 * Every fixture goes through the contract schema the server writes with, so a
 * shape the page reads and the server does not send fails here. The figures are
 * chosen so each rule has a number only it produces: a rise, a fall, a "new", a
 * zero against zero — and the colour each must, or must not, carry.
 */

const READINESS = {
  url: '/system/readiness',
  body: {
    status: 'ok',
    dependencies: [{ name: 'postgres', status: 'up', latencyMs: 3 }],
  },
};

const side = (start: string, end: string, local: string) => ({
  start,
  end,
  effectiveEnd: end,
  startLocal: local,
  endLocalInclusive: local,
});

const period = (range: string, granularity: string) => ({
  range,
  timezone: 'Asia/Tehran',
  calendar: 'jalali',
  granularity,
  current: side('2026-09-05T20:30:00.000Z', '2026-09-06T08:00:00.000Z', '1405/06/15'),
  previous: side('2026-09-04T20:30:00.000Z', '2026-09-05T08:00:00.000Z', '1405/06/14'),
  lengthsDiffer: false,
  generatedAt: '2026-09-06T08:00:00.000Z',
});

const slot = (index: number) => ({
  index,
  start: new Date(Date.UTC(2026, 8, 3, 20, 30) + index * 86_400_000).toISOString(),
  end: new Date(Date.UTC(2026, 8, 4, 20, 30) + index * 86_400_000).toISOString(),
  label: `1405/06/${String(13 + index)}`,
});
const bucket = (index: number, value: string | null) => ({ ...slot(index), value });

const irt = (current: string, previous: string) => [{ currency: 'IRT', current, previous }];

/** Three days, the third not yet begun. */
const SUMMARY = dashboardSummaryResponseSchema.parse({
  period: period('LAST_30_DAYS', 'DAY'),
  currency: 'IRT',
  currencies: ['IRT'],
  today: {
    period: period('TODAY', 'HOUR'),
    // 13,125,012 against 12,000,000: +9.3%, up, GOOD.
    revenue: irt('13125012', '12000000'),
    sales: { current: 12, previous: 10 },
    series: [bucket(0, '1000'), bucket(1, '2000'), bucket(2, null)],
  },
  month: {
    period: period('THIS_MONTH', 'DAY'),
    // Nothing last month: "new", never infinity.
    revenue: irt('317000000', '0'),
    sales: { current: 377, previous: 0 },
    series: [bucket(0, '5000'), bucket(1, '7000'), bucket(2, null)],
  },
  selected: {
    revenue: irt('20000000', '16000000'),
    sales: { current: 40, previous: 40 },
    // Zero against zero: no movement, no colour.
    renewals: { current: 0, previous: 0 },
    // Down: 30 against 40, BAD for a figure whose rise is good.
    newCustomers: { current: 30, previous: 40 },
    // Up: 9 against 6, BAD for failed payments.
    failedPayments: { current: 9, previous: 6 },
    revenueSeries: {
      current: [bucket(0, '8000000'), bucket(1, '12000000'), bucket(2, null)],
      previous: [bucket(0, '7000000'), bucket(1, '9000000'), bucket(2, '0')],
    },
    newCustomerSeries: [bucket(0, '12'), bucket(1, '18'), bucket(2, null)],
    salesByKind: [
      { ...slot(0), counts: { NEW: 10, RENEWAL: 0, ADDON: 2 } },
      { ...slot(1), counts: { NEW: 20, RENEWAL: 0, ADDON: 8 } },
      { ...slot(2), counts: null },
    ],
    paymentMethods: [
      {
        method: 'GATEWAY',
        confirmed: 25,
        confirmedAmount: [{ currency: 'IRT', amount: '12500000' }],
      },
    ],
  },
  activeServices: 412,
});

const OPERATIONS = dashboardOperationsResponseSchema.parse({
  generatedAt: '2026-09-06T08:00:00.000Z',
  panels: {
    total: 8,
    active: 7,
    health: [
      { state: 'HEALTHY', count: 5 },
      { state: 'UNREACHABLE', count: 1 },
      { state: 'DISABLED', count: 1 },
      { state: 'UNCHECKED', count: 1 },
    ],
    providers: [
      { providerType: 'marzban', providerName: 'Marzban', count: 5 },
      { providerType: 'sanaei', providerName: '3X-UI (MHSanaei)', count: 3 },
    ],
  },
  provisioning: { queued: 4, unknown: 1, unreconciledServices: 2 },
  expiring: { withinDays: 7, count: 38 },
});

const REPORT_PERIOD = period('LAST_30_DAYS', 'DAY');
const count = (current: number, previous: number) => ({ current, previous });

const REPORT_SUMMARY = reportSummaryResponseSchema.parse({
  period: REPORT_PERIOD,
  sales: count(40, 40),
  revenue: irt('20000000', '16000000'),
  grossValue: irt('21000000', '16000000'),
  discount: irt('1000000', '0'),
  successfulOrders: count(44, 22),
  newUsers: count(30, 40),
  newBuyers: count(6, 5),
  newServices: count(30, 20),
  newTrialServices: count(4, 0),
  renewals: count(0, 0),
  walletTopupCount: count(2, 1),
  walletTopup: irt('600000', '300000'),
  activeServices: 412,
  activeCustomers: 318,
});

const PRODUCTS = reportProductsResponseSchema.parse({
  period: REPORT_PERIOD,
  by: 'REVENUE',
  page: 1,
  limit: 5,
  totalRows: 1,
  rows: [
    {
      rank: 1,
      productId: '019210ab-cdef-7012-8345-6789abcdef01',
      title: 'Plan A',
      categoryName: null,
      categoryEmoji: null,
      productStatus: 'ACTIVE',
      orders: 2,
      quantity: 2,
      revenue: '110000',
      currency: 'IRT',
    },
  ],
});

const FAILURES = reportFailuresResponseSchema.parse({
  period: REPORT_PERIOD,
  payments: { failed: 9, cancelled: 0, expired: 0, unknownNow: 0 },
  provisioning: { failed: 1, abandoned: 0 },
  commercialOperations: { failed: 0, abandoned: 0 },
  operationsUnknownNow: 0,
  byFailureKind: [],
  ordersRefunded: 1,
});

const OWNER_ROUTES = [
  READINESS,
  { url: '/dashboard/summary', body: SUMMARY as unknown },
  { url: '/dashboard/operations', body: OPERATIONS as unknown },
  { url: '/reports/summary', body: REPORT_SUMMARY },
  { url: '/reports/products', body: PRODUCTS },
  { url: '/reports/failures', body: FAILURES },
  { url: '/ops-log', body: { events: [], nextCursor: null } },
];

const OWNER = ['reports.view', 'panels.view', 'services.view', 'opslog.view'];
const OPERATOR = ['panels.view', 'services.view', 'opslog.view'];

/** The page as the app mounts it: the route comes from the real router. */
function Routed({ permissions, superAdmin }: { permissions: string[]; superAdmin: boolean }) {
  const route = useRoute();
  return <DashboardPage permissions={permissions} route={route} superAdmin={superAdmin} />;
}

const ownerPage = () => {
  window.history.replaceState(null, '', '/');
  return renderPage(<Routed permissions={OWNER} superAdmin />);
};

/** The KPI card whose label is `label`. */
const card = (label: string) =>
  screen
    .getAllByText(label)
    .map((node) => node.closest('.stat'))
    .find((node) => node !== null) as HTMLElement;
const deltaOf = (label: string) => card(label).querySelector('.delta') as HTMLElement | null;

const summaryCalls = (calls: readonly { url: string }[]) =>
  calls.filter((call) => call.url.includes('/dashboard/summary'));
const rangeOf = (url: string) =>
  new URL(url, 'https://admin.example.test').searchParams.get('range');

afterEach(() => {
  vi.useRealTimers();
});

describe('the owner dashboard', () => {
  it('draws the figures exactly, never abbreviated', async () => {
    stubApi(OWNER_ROUTES);
    const { container } = ownerPage();
    await screen.findByText(t('web.dashboard_today_sales'));

    expect(card(t('web.dashboard_today_sales')).textContent).toContain('13,125,012');
    expect(card(t('web.dashboard_month_sales')).textContent).toContain('317,000,000');
    expect(card(t('web.dashboard_active_services')).textContent).toContain('412');
    const text = container.textContent ?? '';
    for (const abbreviation of ['میلیون', 'میلیارد', 'هزار']) {
      expect(text, abbreviation).not.toContain(abbreviation);
    }
  });

  /**
   * A bucket is an exact minor-unit string; the chart's coordinate is a `number`, which
   * rounds past 2^53. Everything a reader is shown — the hover readout, each slot's focus
   * name, the hidden table — is the exact string, never the coordinate turned back into text.
   */
  it('states a revenue bucket past 2^53 exactly wherever the chart shows it as text', async () => {
    const big = '9007199254740993'; // 2^53 + 1: Number() makes it ...992.
    const huge = '12345678901234567891';
    const summary = structuredClone(SUMMARY);
    summary.selected.revenueSeries.current[1] = bucket(1, big);
    summary.selected.revenueSeries.previous[0] = bucket(0, huge);
    stubApi(
      OWNER_ROUTES.map((r) => (r.url === '/dashboard/summary' ? { ...r, body: summary } : r)),
    );
    const { container } = ownerPage();
    await screen.findByText(t('web.dashboard_today_sales'));
    const chart = container.querySelector('.dash-revenue') as HTMLElement;
    const exact = '9,007,199,254,740,993';
    const exactHuge = '12,345,678,901,234,567,891';

    const table = chart.querySelector('table.visually-hidden') as HTMLTableElement;
    expect(table.textContent).toContain(exact);
    expect(table.textContent).toContain(exactHuge);
    expect(table.textContent).not.toContain('9,007,199,254,740,992');

    const hits = chart.querySelectorAll('rect.hit');
    expect(hits[1]?.getAttribute('aria-label')).toContain(exact);
    expect(hits[0]?.getAttribute('aria-label')).toContain(exactHuge);
    fireEvent.focus(hits[1] as Element);
    expect(chart.querySelector('.chart-readout')?.textContent).toContain(exact);
  });

  /**
   * Colour is a claim about the business, made only where good and bad exist:
   * revenue up is good, new customers down is bad, failed payments UP is bad,
   * and a gauge has no delta at all.
   */
  it('colours a movement by what it means, not by its sign', async () => {
    stubApi(OWNER_ROUTES);
    ownerPage();
    await screen.findByText(t('web.dashboard_today_sales'));

    expect(deltaOf(t('web.dashboard_today_sales'))?.className).toContain('good');
    expect(deltaOf(t('web.dashboard_today_sales'))?.textContent).toContain('+9.3%');
    expect(deltaOf(t('web.dashboard_new_customers'))?.className).toContain('bad');
    expect(deltaOf(t('web.dashboard_new_customers'))?.textContent).toContain('−25%');
    expect(deltaOf(t('web.dashboard_failed_payments'))?.className).toContain('bad');
    expect(deltaOf(t('web.dashboard_failed_payments'))?.textContent).toContain('+50%');
    expect(deltaOf(t('web.dashboard_month_sales'))?.textContent).toContain(
      t('web.report_change_new'),
    );
    expect(deltaOf(t('web.dashboard_renewals'))?.className).toContain('neutral');
    expect(deltaOf(t('web.dashboard_renewals'))?.textContent).toContain('—');
    // A gauge: no stored history, so no comparison is drawn.
    expect(deltaOf(t('web.dashboard_active_services'))).toBeNull();
    // Failed payments above zero is outlined for attention.
    expect(card(t('web.dashboard_failed_payments')).className).toMatch(/alert|warnish/);
  });

  it('asks for the period the operator picks, in the reports own ranges', async () => {
    const api = stubApi(OWNER_ROUTES);
    ownerPage();
    await screen.findByText(t('web.dashboard_today_sales'));
    // The default: thirty days, as the reference opens.
    expect(summaryCalls(api.calls).map((call) => rangeOf(call.url))).toEqual(['LAST_30_DAYS']);

    fireEvent.click(screen.getByRole('button', { name: t('web.period_7d') }));
    await waitFor(() => {
      expect(summaryCalls(api.calls).map((call) => rangeOf(call.url))).toContain('LAST_7_DAYS');
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.period_month') }));
    await waitFor(() => {
      expect(summaryCalls(api.calls).map((call) => rangeOf(call.url))).toContain('THIS_MONTH');
    });
    expect(window.location.search).toContain('range=THIS_MONTH');
  });

  it('asks nothing for a custom range until both dates are applied, then sends them', async () => {
    const api = stubApi(OWNER_ROUTES);
    ownerPage();
    await screen.findByText(t('web.dashboard_today_sales'));
    const before = summaryCalls(api.calls).length;

    fireEvent.click(screen.getByRole('button', { name: t('web.period_custom') }));
    expect(await screen.findByText(t('web.dashboard_custom_needed'))).toBeInTheDocument();
    expect(summaryCalls(api.calls)).toHaveLength(before);

    fireEvent.change(screen.getByLabelText(t('web.report_range_from')), {
      target: { value: '1405-06-01' },
    });
    fireEvent.change(screen.getByLabelText(t('web.report_range_to')), {
      target: { value: '1405-06-10' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.report_range_apply') }));
    await waitFor(() => {
      const last = summaryCalls(api.calls).at(-1)?.url ?? '';
      expect(last).toContain('range=CUSTOM');
      expect(last).toContain('from=1405-06-01');
      expect(last).toContain('to=1405-06-10');
    });
  });

  /**
   * The comparison is a drawing choice over figures already held: switching it
   * off removes the deltas and the dashed previous-period line, and asks the
   * server NOTHING.
   */
  it('turns the comparison off without asking again', async () => {
    const api = stubApi(OWNER_ROUTES);
    const { container } = ownerPage();
    await screen.findByText(t('web.dashboard_today_sales'));
    expect(container.querySelectorAll('.stat .delta').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('path.line.dashed').length).toBeGreaterThan(0);
    const asked = summaryCalls(api.calls).length;

    fireEvent.click(screen.getByLabelText(t('web.period_compare')));

    await waitFor(() => {
      expect(container.querySelectorAll('.stat .delta')).toHaveLength(0);
    });
    expect(container.querySelectorAll('path.line.dashed')).toHaveLength(0);
    expect(window.location.search).toContain('compare=0');
    expect(summaryCalls(api.calls)).toHaveLength(asked);
  });

  it('breaks the sales down by kind, and a bucket not yet begun draws nothing', async () => {
    stubApi(OWNER_ROUTES);
    ownerPage();
    const chart = (
      await screen.findByRole('img', { name: t('web.dashboard_orders_chart') })
    ).closest('figure') as HTMLElement;
    // Two begun days, three kinds each; the third day is null and draws no bar.
    expect(chart.querySelectorAll('rect.bar')).toHaveLength(6);
    for (const kind of [
      'web.dashboard_kind_new',
      'web.dashboard_kind_renewal',
      'web.dashboard_kind_addon',
    ] as const) {
      expect(screen.getAllByText(t(kind)).length).toBeGreaterThan(0);
    }
  });

  it('keeps the report cards: top products linked to the full list, failures, other figures', async () => {
    stubApi(OWNER_ROUTES);
    ownerPage();
    expect(await screen.findByText(/Plan A/u)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: t('web.report_view_all') }).getAttribute('href')).toBe(
      '/reports?tab=products',
    );
    expect(
      screen.getByRole('link', { name: t('web.report_open_reports') }).getAttribute('href'),
    ).toBe('/reports');
    expect(screen.getByText(t('web.report_failures_title'))).toBeInTheDocument();
    const other = (await screen.findByText(t('web.dashboard_active_customers'))).closest(
      'section',
    ) as HTMLElement;
    expect(other.textContent).toContain('318');
    expect(other.textContent).toContain('600,000');
  });

  /**
   * Traffic over 24 hours has no source (usage is an overwritten snapshot), so it
   * is never drawn; a section the server withheld is absent, never a zero.
   */
  it('omits what it has no source for, and what the server withheld', async () => {
    stubApi([
      ...OWNER_ROUTES.filter((route) => route.url !== '/dashboard/operations'),
      {
        url: '/dashboard/operations',
        body: { ...OPERATIONS, provisioning: null, expiring: null },
      },
    ]);
    const { container } = ownerPage();
    await screen.findByText(t('web.dashboard_active_panels'));
    expect(screen.queryByText(t('web.dashboard_queue'))).toBeNull();
    expect(screen.queryByText(new RegExp(t('web.dashboard_expiring'), 'u'))).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/ترافیک|TB/u);
  });

  it('says the viewer may not see the business figures when the server refuses them', async () => {
    stubApi([
      ...OWNER_ROUTES.filter((route) => route.url !== '/dashboard/summary'),
      {
        url: '/dashboard/summary',
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
    ownerPage();
    const business = (await screen.findByText(t('web.dashboard_business'))).closest(
      'section',
    ) as HTMLElement;
    expect(await within(business).findByText(t('web.no_permission'))).toBeInTheDocument();
    expect(screen.queryByText(t('web.dashboard_today_sales'))).toBeNull();
  });

  it('writes no style attribute the production policy would drop', async () => {
    stubApi(OWNER_ROUTES);
    const { container } = ownerPage();
    await screen.findByText(/Plan A/u);
    await screen.findByText(t('web.dashboard_active_customers'));
    expect(container.querySelectorAll('.skel')).toHaveLength(0);
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('[style]')).toHaveLength(0);
  });

  it('re-asks every business figure on the refresh button, and offers none after a refusal', async () => {
    const api = stubApi(OWNER_ROUTES);
    ownerPage();
    await screen.findByText(t('web.dashboard_today_sales'));
    await screen.findByText(t('web.dashboard_active_customers'));
    const reports = () => api.calls.filter((c) => c.url.includes('/reports/summary')).length;
    const before = { summaries: summaryCalls(api.calls).length, reports: reports() };
    fireEvent.click(screen.getByRole('button', { name: t('web.report_refresh') }));
    await waitFor(() => {
      expect(summaryCalls(api.calls).length).toBeGreaterThan(before.summaries);
      expect(reports()).toBeGreaterThan(before.reports);
    });
  });

  it('draws no refresh over a refused summary', async () => {
    stubApi([
      ...OWNER_ROUTES.filter((route) => route.url !== '/dashboard/summary'),
      {
        url: '/dashboard/summary',
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
    ownerPage();
    expect((await screen.findAllByText(t('web.no_permission'))).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: t('web.report_refresh') })).toBeNull();
  });

  it('re-reads the summary once a minute and the gauges every thirty seconds', async () => {
    expect(DASHBOARD_SUMMARY_REFRESH_MS).toBe(60_000);
    expect(DASHBOARD_OPERATIONS_REFRESH_MS).toBe(30_000);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = stubApi(OWNER_ROUTES);
    ownerPage();
    await screen.findByText(t('web.dashboard_today_sales'));
    await screen.findByText(t('web.dashboard_active_customers'));
    const summaries = () => summaryCalls(api.calls).length;
    const gauges = () => api.calls.filter((c) => c.url.includes('/dashboard/operations')).length;
    const reports = () => api.calls.filter((c) => c.url.includes('/reports/summary')).length;
    const first = { summaries: summaries(), gauges: gauges(), reports: reports() };

    await vi.advanceTimersByTimeAsync(31_000);
    await waitFor(() => expect(gauges()).toBeGreaterThan(first.gauges));
    expect(summaries()).toBe(first.summaries);

    await vi.advanceTimersByTimeAsync(30_000);
    await waitFor(() => expect(summaries()).toBeGreaterThan(first.summaries));
    // The report cards keep the reports' five minutes: not re-read within a minute.
    expect(reports()).toBe(first.reports);
  });
});

describe('the dashboard for an operator who is not the owner', () => {
  it('draws the operational figures, and asks for no business figure', async () => {
    const api = stubApi(OWNER_ROUTES);
    renderPage(<DashboardPage permissions={OPERATOR} />);
    expect(await screen.findByText(t('web.dashboard_active_panels'))).toBeInTheDocument();
    expect(card(t('web.dashboard_queue')).textContent).toContain('4');
    expect(screen.getByText(new RegExp(t('web.dashboard_expiring'), 'u'))).toBeInTheDocument();
    expect(screen.queryByText(t('web.dashboard_today_sales'))).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.period_7d') })).toBeNull();
    expect(api.calls.some((c) => c.url.includes('/dashboard/summary'))).toBe(false);
    expect(api.calls.some((c) => c.url.includes('/reports/'))).toBe(false);
  });

  it('outlines the fleet when a probe says a panel is down', async () => {
    stubApi(OWNER_ROUTES);
    renderPage(<DashboardPage permissions={OPERATOR} />);
    await screen.findByText(t('web.dashboard_active_panels'));
    const fleet = card(t('web.dashboard_active_panels'));
    expect(fleet.className).toContain('alert');
    expect(fleet.textContent).toContain(t('web.health_unreachable'));
    // A disabled or never-probed panel is not trouble.
    expect(fleet.textContent).not.toContain(t('web.health_disabled'));
  });

  /**
   * The session's permission list can be a minute old. A fleet section the server
   * withheld is a refusal, said as one — never an empty fleet.
   */
  it('says so when the server withheld a section the session believed it held', async () => {
    stubApi([
      READINESS,
      { url: '/dashboard/operations', body: { ...OPERATIONS, panels: null } },
      { url: '/ops-log', body: { events: [], nextCursor: null } },
    ]);
    renderPage(<DashboardPage permissions={OPERATOR} />);
    const fleet = (await screen.findByText(t('web.dashboard_panel_distribution'))).closest(
      'section',
    ) as HTMLElement;
    expect(await within(fleet).findByText(t('web.no_permission'))).toBeInTheDocument();
    expect(screen.queryByText(t('web.dashboard_no_panels'))).toBeNull();
    expect(screen.queryByText(t('web.dashboard_active_panels'))).toBeNull();
  });

  it('asks for no operational section it holds no permission for', async () => {
    const api = stubApi([READINESS]);
    renderPage(<DashboardPage permissions={[]} />);
    await screen.findByText(t('web.system_status'));
    expect(screen.queryByText(t('web.dashboard_panel_distribution'))).toBeNull();
    expect(screen.queryByText(t('web.dashboard_attention'))).toBeNull();
    expect(api.calls.some((c) => c.url.includes('/dashboard/'))).toBe(false);
  });

  /** `latencyMs` is OPTIONAL on the wire: once rendered as "undefined ms". */
  it('omits the timing for a dependency that reported none', async () => {
    stubApi([
      {
        url: '/system/readiness',
        body: {
          status: 'ok',
          dependencies: [
            { name: 'migrations', status: 'up', detail: '27 applied' },
            { name: 'postgres', status: 'up', latencyMs: 3 },
          ],
        },
      },
    ]);
    const { container } = renderPage(<DashboardPage permissions={[]} />);
    await screen.findByText('migrations');
    const text = container.textContent ?? '';
    expect(text.match(/ ms/g) ?? []).toHaveLength(1);
    expect(text).not.toMatch(/(undefined|NaN|null)/);
    expect(screen.getByText('3 ms')).toBeInTheDocument();
  });
});

/**
 * The fleet card's three older rules, carried onto the server's exact counts
 * (`docs/phase3d-falsification.md` R-01, V5, W11).
 */
describe('the dashboard fleet', () => {
  const fleetOf = (panels: unknown) => [
    READINESS,
    { url: '/dashboard/operations', body: { ...OPERATIONS, panels } as unknown },
    { url: '/ops-log', body: { events: [], nextCursor: null } },
  ];

  /**
   * R-01, superseded: the card once aggregated one page of `GET /panels` and had
   * to say when the server left a panel out. The server now counts the fleet, so
   * a fleet larger than any page is drawn whole, and nothing claims it is partial.
   */
  it('claims a partial fleet only when the server left a panel out', async () => {
    stubApi(
      fleetOf({
        total: 260,
        active: 260,
        health: [{ state: 'HEALTHY', count: 260 }],
        providers: [{ providerType: 'marzban', providerName: 'Marzban', count: 260 }],
      }),
    );
    const { container } = renderPage(<DashboardPage permissions={OPERATOR} />);
    await screen.findByText(t('web.dashboard_active_panels'));
    expect(card(t('web.dashboard_active_panels')).textContent).toContain('260');
    expect(container.textContent ?? '').not.toMatch(/۲۰۰|200/u);
  });

  /** W11: an empty fleet names what is missing, not the generic empty copy. */
  it('names the empty thing when the fleet is empty', async () => {
    stubApi(fleetOf({ total: 0, active: 0, health: [], providers: [] }));
    renderPage(<DashboardPage permissions={OPERATOR} />);
    expect(await screen.findByText(t('web.dashboard_no_panels'))).toBeInTheDocument();
    expect(screen.queryByText(t('web.empty'))).toBeNull();
  });

  /**
   * V5: after a refusal the card draws nothing it read before. React Query keeps
   * the last answer in its cache; `shownData` is what stops it being drawn under
   * a card that says the fleet could not be read.
   */
  it('says nothing about a fleet it could not read', async () => {
    const route = { url: '/dashboard/operations', body: OPERATIONS as unknown, status: 200 };
    stubApi([READINESS, { url: '/ops-log', body: { events: [], nextCursor: null } }, route]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage(<DashboardPage permissions={OPERATOR} />);
    expect((await screen.findAllByText('3X-UI (MHSanaei)')).length).toBeGreaterThan(0);

    route.status = 403;
    route.body = {
      error: {
        kind: 'forbidden',
        code: 'access.permission_denied',
        message: 'no',
        correlationId: 'test',
      },
    };
    await vi.advanceTimersByTimeAsync(35_000);

    await waitFor(() => {
      expect(screen.queryAllByText('3X-UI (MHSanaei)')).toHaveLength(0);
    });
    expect(screen.queryByText(t('web.dashboard_active_panels'))).toBeNull();
  });
});

describe('the attention card', () => {
  /**
   * Owner revision 3 — "needs attention" means an operator has to do something:
   * management-scope conditions still OPEN. Parsed, not substring-matched:
   * `scope=MANAGEMENT` would also match the wider list.
   */
  it('asks only for open management conditions', async () => {
    const api = stubApi([READINESS, { url: '/ops-log', body: { events: [], nextCursor: null } }]);
    renderPage(<DashboardPage permissions={['opslog.view']} />);
    await screen.findByText(t('web.dashboard_nothing_to_do'));
    const call = api.calls.find((entry) => entry.url.includes('/ops-log'));
    const scope = new URL(call?.url ?? '', 'https://admin.example.test').searchParams;
    expect(scope.get('scope')).toBe('MANAGEMENT_CONDITIONS');
    expect(scope.get('open')).toBe('true');
  });

  /** The timestamp is the column the list is ORDERED by (`first_seen_at DESC`). */
  it('dates each condition by when it FIRST appeared, which is the order it is in', async () => {
    stubApi([
      READINESS,
      {
        url: '/ops-log',
        body: {
          events: [
            event({
              id: 'newer-first-seen',
              message: 'Newer condition',
              firstSeenAt: '2026-09-06T08:00:00.000Z',
              lastSeenAt: '2026-09-06T09:00:00.000Z',
            }),
            event({
              id: 'older-first-seen',
              message: 'Older condition',
              firstSeenAt: '2026-09-05T08:00:00.000Z',
              lastSeenAt: '2026-09-06T23:00:00.000Z',
            }),
          ],
          nextCursor: null,
        },
      },
    ]);
    renderPage(<DashboardPage permissions={['opslog.view']} />);
    await screen.findByText('Older condition');
    const shown = screen
      .getAllByTitle(t('web.first_seen'))
      .map((node) => node.textContent ?? '')
      .filter((text) => text.length > 0);
    expect(shown).toEqual([
      formatTimestamp('2026-09-06T08:00:00.000Z'),
      formatTimestamp('2026-09-05T08:00:00.000Z'),
    ]);
  });
});

describe('dashboard presentation rules', () => {
  const route = (query = '') => ({ path: '/', query: new URLSearchParams(query) });

  it('asks for the five offered ranges only, thirty days by default', () => {
    expect(dashboardSelection(route())).toEqual({ range: 'LAST_30_DAYS' });
    expect(dashboardSelection(route('range=TODAY'))).toEqual({ range: 'TODAY' });
    expect(dashboardSelection(route('range=THIS_MONTH'))).toEqual({ range: 'THIS_MONTH' });
    // A report range with no button falls back rather than drawing an unnamed period.
    expect(dashboardSelection(route('range=YESTERDAY'))).toEqual({ range: 'LAST_30_DAYS' });
    expect(dashboardSelection(route('range=nonsense'))).toEqual({ range: 'LAST_30_DAYS' });
    expect(dashboardSelection(route('range=CUSTOM&from=1405-06-01&to=1405-06-10'))).toEqual({
      range: 'CUSTOM',
      from: '1405-06-01',
      to: '1405-06-10',
    });
  });

  it('compares unless the URL turned comparison off', () => {
    expect(compareFromRoute(route())).toBe(true);
    expect(compareFromRoute(route('compare=0'))).toBe(false);
  });

  it('words and colours a delta by the reports rule and the figure sense', () => {
    expect(kpiDelta(12n, 10n, 'up-good')).toMatchObject({
      text: '+20%',
      direction: 'good',
      trend: 'up',
    });
    expect(kpiDelta(8n, 10n, 'up-good')).toMatchObject({
      text: '−20%',
      direction: 'bad',
      trend: 'down',
    });
    expect(kpiDelta(12n, 10n, 'up-bad')).toMatchObject({ direction: 'bad', trend: 'up' });
    expect(kpiDelta(8n, 10n, 'up-bad')).toMatchObject({ direction: 'good', trend: 'down' });
    expect(kpiDelta(12n, 10n, 'neutral')).toMatchObject({ direction: 'neutral', trend: 'up' });
    expect(kpiDelta(0n, 0n, 'up-good')).toEqual({ text: '—', direction: 'neutral' });
    expect(kpiDelta(5n, 0n, 'up-good')).toMatchObject({
      text: t('web.report_change_new'),
      direction: 'good',
    });
    expect(kpiDelta(10n, 10n, 'up-good')).toEqual({ text: '0%', direction: 'neutral' });
  });

  it('writes an axis tick as a grouped amount, never in exponent notation', () => {
    // String(1e21) is "1e+21"; an amount is digits.
    expect(chartMoneyText(1e21, 'IRT')).toBe('1,000,000,000,000,000,000,000');
    expect(chartMoneyText(2500, 'USD')).toBe('2,500.00');
    expect(chartMoneyTexts(['9007199254740993', null], 'IRT')).toEqual([
      '9,007,199,254,740,993',
      null,
    ]);
  });

  it('drops only the year from a date on a chart axis', () => {
    expect(axisLabel('1405/06/15')).toBe('06/15');
    expect(axisLabel('1405/06/01–1405/06/07')).toBe('06/01–06/07');
    expect(axisLabel('08:00')).toBe('08:00');
  });

  it('aggregates the fleet by panel, as the server counted it', () => {
    const health = healthSlices(OPERATIONS.panels?.health ?? []);
    expect(health.reduce((sum, slice) => sum + slice.count, 0)).toBe(8);
    expect(health[0]?.key).toBe('HEALTHY');
    const providers = providerSlices(OPERATIONS.panels?.providers ?? []);
    expect(providers.reduce((sum, slice) => sum + slice.count, 0)).toBe(8);
  });
});

describe('the sidebar counters', () => {
  const counters = (values: Record<string, number | null>) =>
    navCountersResponseSchema.parse({
      generatedAt: '2026-09-06T08:00:00.000Z',
      counters: {
        openConditions: null,
        ticketsAwaitingSupport: null,
        unhealthyPanels: null,
        unreconciledServices: null,
        refundRequestsAwaiting: null,
        paymentsUnknown: null,
        ...values,
      },
    });

  it('places each counter beside the link that acts on it', () => {
    expect(
      navCountersFrom(
        counters({
          openConditions: 3,
          ticketsAwaitingSupport: 5,
          unhealthyPanels: 2,
          paymentsUnknown: 1,
          unreconciledServices: 2,
          refundRequestsAwaiting: 1,
        }),
      ),
    ).toEqual({
      alerts: { count: 3, tone: 'warn' },
      tickets: { count: 5 },
      panels: { count: 2, tone: 'danger' },
      payments: { count: 1, tone: 'warn' },
      services: { count: 3, tone: 'danger' },
    });
  });

  it('draws nothing for a withheld counter or a zero', () => {
    expect(navCountersFrom(counters({ openConditions: 0, unhealthyPanels: null }))).toEqual({});
    // Refund requests alone are not the loud part of the services badge.
    expect(
      navCountersFrom(counters({ unreconciledServices: 0, refundRequestsAwaiting: 4 })),
    ).toEqual({ services: { count: 4 } });
  });

  /**
   * `COUNTER_CAP` means "this many or more". A badge at the cap is a floor, and so is any
   * sum with a capped part in it — the services badge adds two counters.
   */
  it('marks a counter at the cap, and a sum with a capped part, as a lower bound', () => {
    expect(
      navCountersFrom(
        counters({
          openConditions: COUNTER_CAP,
          ticketsAwaitingSupport: COUNTER_CAP - 1,
          unreconciledServices: 3,
          refundRequestsAwaiting: COUNTER_CAP,
        }),
      ),
    ).toEqual({
      alerts: { count: COUNTER_CAP, tone: 'warn', atLeast: true },
      tickets: { count: COUNTER_CAP - 1 },
      services: { count: COUNTER_CAP + 3, tone: 'danger', atLeast: true },
    });
    expect(navCountersFrom(counters({ unreconciledServices: COUNTER_CAP }))).toEqual({
      services: { count: COUNTER_CAP, tone: 'danger', atLeast: true },
    });
    expect(
      navCountersFrom(counters({ unreconciledServices: 2, refundRequestsAwaiting: 5 })),
    ).toEqual({ services: { count: 7, tone: 'danger' } });
  });

  it('is one request a minute', () => {
    expect(NAV_COUNTERS_REFRESH_MS).toBe(60_000);
  });
});
