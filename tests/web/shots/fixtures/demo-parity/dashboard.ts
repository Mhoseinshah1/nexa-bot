import {
  PAYMENT_OPS_QUEUES,
  dashboardOperationsResponseSchema,
  dashboardSummaryResponseSchema,
  navCountersResponseSchema,
  operationalEventListResponseSchema,
  paymentAttentionResponseSchema,
  reportFailuresResponseSchema,
  reportProductsResponseSchema,
  reportSummaryResponseSchema,
  systemDiagnosticsResponseSchema,
  systemReadinessResponseSchema,
} from '@nexa/contracts';
import { SHOT_NOW, ago, fixture, type ShotFixture } from '../../fixture.ts';

/*
 * DEMO PARITY — the dashboard (`/`) fed the approved demo's own sample numbers
 * (`docs/web-redesign/demo-parity/reference/approved-demo.html#/`, «۳۰ روز»), so a
 * side-by-side compares like with like: 13,623,019 toman today, 220,882,810 this month,
 * the demo's thirty daily revenue figures and its five top products.
 *
 * Only figures the API has a field for. The demo's extra service cards (provisioner,
 * monitor, backup storage) are not dependencies the readiness probe reports, so the
 * system card gets the four the API names. Every body is parsed by its response schema
 * in `tests/web/shots-fixtures.test.tsx`.
 */

/** The demo's seeded generator (`rnd`/`series` in its script), so the shapes match. */
function rnd(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}
function series(n: number, base: number, amp: number, seed: number, nullFrom?: number) {
  const r = rnd(seed);
  return Array.from({ length: n }, (_, i) =>
    nullFrom !== undefined && i >= nullFrom
      ? null
      : Math.round(base * (0.75 + r() * 0.5) + amp * Math.sin(i / 2.3)),
  );
}

/** Rescales the known points so they sum exactly to `total` (the last one takes the rest). */
function scaledTo(values: readonly (number | null)[], total: number): (number | null)[] {
  const known = values.filter((v): v is number => v !== null);
  const sum = known.reduce((a, b) => a + b, 0);
  const lastIndex = values.reduce<number>((last, v, i) => (v === null ? last : i), -1);
  let running = 0;
  return values.map((v, i) => {
    if (v === null) return null;
    if (i === lastIndex) return total - running;
    const scaled = Math.round((v * total) / sum);
    running += scaled;
    return scaled;
  });
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (at: number) => new Date(at).toISOString();
/** Tehran's midnight on the shot's day (UTC+03:30). */
const TODAY_START = Date.parse('2026-09-05T20:30:00.000Z');

/** The demo's day labels: 1405/06/17 … 1405/07/15, thirty days. */
const DAY_LABELS = Array.from({ length: 30 }, (_, i) => {
  const d = 17 + i;
  return d <= 31
    ? `1405/06/${String(d).padStart(2, '0')}`
    : `1405/07/${String(d - 31).padStart(2, '0')}`;
});

const side = (start: number, end: number, from: string, to: string) => ({
  start: iso(start),
  end: iso(end),
  effectiveEnd: iso(Math.min(end, Date.parse(SHOT_NOW))),
  startLocal: from,
  endLocalInclusive: to,
});
function periodOf(range: string, granularity: string, from: string, to: string, days: number) {
  const start = TODAY_START - (days - 1) * DAY;
  return {
    range,
    timezone: 'Asia/Tehran',
    calendar: 'jalali',
    granularity,
    current: side(start, TODAY_START + DAY, from, to),
    previous: side(start - days * DAY, start, from, to),
    lengthsDiffer: false,
    generatedAt: SHOT_NOW,
  };
}

const SELECTED_START = TODAY_START - 29 * DAY;
function dayBuckets<T>(values: readonly T[], start = SELECTED_START, labels = DAY_LABELS) {
  return values.map((value, index) => ({
    index,
    start: iso(start + index * DAY),
    end: iso(start + (index + 1) * DAY),
    label: labels[index] ?? '',
    value,
  }));
}

// --- the demo's own figures ------------------------------------------------------------

/** «درآمد روزانه»: the demo's thirty days, this period and the previous one, exactly. */
const REVENUE_CURRENT = [
  10351674, 12233815, 15718934, 14942342, 17063681, 18420800, 15138542, 10972626, 9694400, 14849847,
  13491399, 7861048, 12792933, 8957097, 14261534, 14009024, 17904366, 14860196, 19661363, 13786297,
  18982147, 13279039, 11684174, 14429499, 9235228, 9485437, 13172628, 9867855, 15308389, 15570068,
];
const REVENUE_PREVIOUS = [
  9226540, 11691034, 12467463, 16088540, 12284015, 11572169, 13755867, 13949856, 12835569, 12870469,
  8282226, 10253042, 10408495, 8226899, 13050328, 15731631, 13903272, 13245613, 13680111, 12650952,
  13301650, 16044182, 14043664, 12461643, 7329508, 11746784, 12356111, 12855267, 10072785, 12037784,
];
const sum = (values: readonly (number | null)[]) =>
  values.reduce<number>((total, value) => total + (value ?? 0), 0);

const TODAY_TOTAL = 13_623_019;
const TODAY_SERIES = scaledTo(series(24, 900000, 350000, 7, 15), TODAY_TOTAL);
const MONTH_TOTAL = 220_882_810;
const MONTH_SERIES = scaledTo(series(31, 14200000, 3000000, 41, 15), MONTH_TOTAL);
const KINDS = {
  NEW: series(30, 24, 7, 33),
  RENEWAL: series(30, 18, 5, 34),
  ADDON: series(30, 5, 2, 35),
};
const NEW_CUSTOMERS = scaledTo(series(30, 20, 6, 51), 612);

const SUMMARY = {
  period: periodOf('LAST_30_DAYS', 'DAY', DAY_LABELS[0] ?? '', DAY_LABELS[29] ?? '', 30),
  currency: 'IRT',
  currencies: ['IRT', 'USDT'],
  today: {
    period: periodOf('TODAY', 'HOUR', '1405/07/15', '1405/07/15', 1),
    // 13,623,019 against 11,048,677: +23.3%.
    revenue: [{ currency: 'IRT', current: String(TODAY_TOTAL), previous: '11048677' }],
    sales: { current: 126, previous: 104 },
    series: TODAY_SERIES.map((value, index) => ({
      index,
      start: iso(TODAY_START + index * HOUR),
      end: iso(TODAY_START + (index + 1) * HOUR),
      label: `${String(index).padStart(2, '0')}:00`,
      value: value === null ? null : String(value),
    })),
  },
  month: {
    period: periodOf('THIS_MONTH', 'DAY', '1405/07/01', '1405/07/30', 15),
    // 220,882,810 against 187,985,370: +17.5%; and the demo's «ارزهای دیگر: 12.50 USDT».
    revenue: [
      { currency: 'IRT', current: String(MONTH_TOTAL), previous: '187985370' },
      { currency: 'USDT', current: '12500000', previous: '0' },
    ],
    sales: { current: 713, previous: 607 },
    series: dayBuckets(
      MONTH_SERIES.map((value) => (value === null ? null : String(value))),
      TODAY_START - 14 * DAY,
      Array.from({ length: 31 }, (_, i) => `1405/07/${String(i + 1).padStart(2, '0')}`),
    ),
  },
  selected: {
    revenue: [
      {
        currency: 'IRT',
        current: String(sum(REVENUE_CURRENT)),
        previous: String(sum(REVENUE_PREVIOUS)),
      },
    ],
    sales: { current: 1360, previous: 1256 },
    renewals: { current: 1094, previous: 960 },
    newCustomers: { current: 612, previous: 561 },
    failedPayments: { current: 58, previous: 56 },
    revenueSeries: {
      current: dayBuckets(REVENUE_CURRENT.map(String)),
      previous: dayBuckets(REVENUE_PREVIOUS.map(String)),
    },
    newCustomerSeries: dayBuckets(NEW_CUSTOMERS.map((v) => (v === null ? null : String(v)))),
    salesByKind: DAY_LABELS.map((label, index) => ({
      index,
      start: iso(SELECTED_START + index * DAY),
      end: iso(SELECTED_START + (index + 1) * DAY),
      label,
      counts: {
        NEW: KINDS.NEW[index] ?? 0,
        RENEWAL: KINDS.RENEWAL[index] ?? 0,
        ADDON: KINDS.ADDON[index] ?? 0,
      },
    })),
    paymentMethods: [
      {
        method: 'GATEWAY',
        confirmed: 286,
        confirmedAmount: [{ currency: 'IRT', amount: '85677000' }],
      },
      {
        method: 'MANUAL_TRANSFER',
        confirmed: 694,
        confirmedAmount: [{ currency: 'IRT', amount: '208073000' }],
      },
      {
        method: 'WALLET',
        confirmed: 381,
        confirmedAmount: [{ currency: 'IRT', amount: '114236000' }],
      },
    ],
  },
  activeServices: 37,
};

const REPORT_PERIOD = SUMMARY.period;
const count = (current: number, previous: number) => ({ current, previous });
const irt = (current: number, previous: number) => [
  { currency: 'IRT', current: String(current), previous: String(previous) },
];

const PRODUCTS = [
  ['یک‌ماهه ۵۰ گیگ — آلمان', 318, 98_600_000],
  ['یک‌ماهه نامحدود — هلند', 204, 91_800_000],
  ['سه‌ماهه ۱۵۰ گیگ — آلمان', 96, 74_900_000],
  ['یک‌ماهه ۳۰ گیگ — ترکیه', 187, 46_700_000],
  ['سرویس دلخواه', 71, 23_400_000],
] as const;

/** Open management conditions, newest first: the demo's six and one more behind the footer. */
const CONDITIONS = [
  ['panel.health.unreachable', 'ERROR', 'Panel DE-2 is unreachable.', 2],
  ['notification.attempts_exhausted', 'CRITICAL', 'A customer message ran out of attempts.', 65],
  ['panel.health.degraded', 'WARN', 'Panel TR-1 answers slowly (over 800 ms).', 140],
  ['backup.interval_exceeded', 'WARN', 'The last backup is 26 hours old.', 332],
  ['provisioning.stalled', 'ERROR', 'A provisioning outcome on DE-2 is unknown.', 352],
  ['backup.delivery_failed', 'WARN', 'Telegram did not confirm the backup delivery.', 1702],
  ['payments.gateway_inquiry_failing', 'WARN', 'The gateway inquiry is failing.', 1800],
] as const;

export const DEMO_DASHBOARD: readonly ShotFixture[] = [
  fixture('/dashboard/summary', dashboardSummaryResponseSchema, SUMMARY),
  fixture('/dashboard/operations', dashboardOperationsResponseSchema, {
    generatedAt: SHOT_NOW,
    panels: {
      total: 6,
      active: 6,
      health: [
        { state: 'HEALTHY', count: 4 },
        { state: 'UNREACHABLE', count: 1 },
        { state: 'DEGRADED', count: 1 },
      ],
      providers: [
        { providerType: 'marzban', providerName: 'Marzban', count: 4 },
        { providerType: 'sanaei', providerName: '3X-UI (MHSanaei)', count: 2 },
      ],
    },
    provisioning: { queued: 0, unknown: 1, unreconciledServices: 3 },
    expiring: { withinDays: 7, count: 13 },
  }),
  fixture('/nav-counters', navCountersResponseSchema, {
    generatedAt: SHOT_NOW,
    counters: {
      openConditions: 7,
      ticketsAwaitingSupport: 4,
      unhealthyPanels: 1,
      unreconciledServices: 3,
      refundRequestsAwaiting: 1,
      paymentsUnknown: 4,
      businessHandoffs: 2,
    },
  }),
  fixture('/payment-operations/attention', paymentAttentionResponseSchema, {
    window: null,
    byGateway: [],
    totals: {
      ...Object.fromEntries(PAYMENT_OPS_QUEUES.map((queue) => [queue, 0])),
      UNKNOWN: 4,
      NEEDS_RECONCILIATION: 2,
    },
    generatedAt: SHOT_NOW,
  }),
  fixture('/system/diagnostics', systemDiagnosticsResponseSchema, {
    generatedAt: SHOT_NOW,
    outbox: { pending: 0, oldestPendingAt: null, failing: 1, exhausted: 1, failingSample: [] },
    provisioning: {
      counts: { UNKNOWN_OUTCOME: 1, LEASE_EXPIRED: 0, RETRYING: 0, UNANNOUNCED: 0 },
      sample: [],
    },
  }),
  fixture('/system/readiness', systemReadinessResponseSchema, {
    status: 'degraded',
    dependencies: [
      { name: 'redis', status: 'up', latencyMs: 1 },
      { name: 'postgres', status: 'up', latencyMs: 4 },
      { name: 'migrations', status: 'up', detail: '155 applied' },
      { name: 'outbox', status: 'down', detail: 'unavailable' },
    ],
  }),
  fixture(
    '/ops-log',
    operationalEventListResponseSchema,
    {
      events: CONDITIONS.map(([code, severity, message, minutes], index) => ({
        id: `01a05e35-c9ad-7e93-bef3-1ed9b55d9e0${index}`,
        code,
        severity,
        message,
        context: null,
        occurrenceCount: 1,
        firstSeenAt: ago(minutes),
        lastSeenAt: ago(Math.max(0, minutes - 1)),
        correlationId: `demo-${index}`,
        recoversCode: null,
        resolvedAt: null,
        resolvedByEventId: null,
      })),
      nextCursor: null,
    },
    { query: { scope: 'MANAGEMENT_CONDITIONS', open: 'true' } },
  ),
  fixture('/reports/summary', reportSummaryResponseSchema, {
    period: REPORT_PERIOD,
    sales: count(1360, 1256),
    revenue: irt(sum(REVENUE_CURRENT), sum(REVENUE_PREVIOUS)),
    grossValue: irt(sum(REVENUE_CURRENT) + 18_400_000, sum(REVENUE_PREVIOUS)),
    discount: irt(18_400_000, 15_200_000),
    successfulOrders: count(1180, 1094),
    newUsers: count(612, 561),
    newBuyers: count(260, 277),
    newServices: count(940, 839),
    newTrialServices: count(210, 219),
    renewals: count(1094, 960),
    walletTopupCount: count(380, 362),
    walletTopup: irt(312_500_000, 281_000_000),
    activeServices: 37,
    activeCustomers: 2074,
  }),
  fixture('/reports/products', reportProductsResponseSchema, {
    period: REPORT_PERIOD,
    by: 'REVENUE',
    page: 1,
    limit: 5,
    totalRows: 5,
    rows: PRODUCTS.map(([title, orders, revenue], index) => ({
      rank: index + 1,
      productId: `019220ab-cdef-7012-8345-6789abcd${String(index + 1).padStart(4, '0')}`,
      title,
      categoryName: null,
      categoryEmoji: null,
      productStatus: 'ACTIVE',
      orders,
      quantity: orders,
      revenue: String(revenue),
      currency: 'IRT',
    })),
  }),
  fixture('/reports/failures', reportFailuresResponseSchema, {
    period: REPORT_PERIOD,
    payments: { failed: 58, cancelled: 12, expired: 9, unknownNow: 4 },
    provisioning: { failed: 1, abandoned: 0 },
    commercialOperations: { failed: 4, abandoned: 0 },
    operationsUnknownNow: 1,
    byFailureKind: [{ failureKind: 'PROVIDER_ERROR', count: 1 }],
    ordersRefunded: 3,
  }),
];

/*
 * The EMPTY dashboard (`demo-dashboard-empty--1440-dark.png`'s state): a shop with nothing
 * in the period and nothing waiting. Real zeros from the server — drawn as 0, not as a
 * dash — and empty series, so each chart draws its own «برای این بازه داده‌ای ثبت نشده است.».
 */
const zeros = (n: number) => Array.from({ length: n }, () => '0');
const EMPTY_SUMMARY = {
  ...SUMMARY,
  currencies: ['IRT'],
  today: {
    ...SUMMARY.today,
    revenue: [],
    sales: { current: 0, previous: 0 },
    series: SUMMARY.today.series.map((bucket) => ({
      ...bucket,
      value: bucket.value === null ? null : '0',
    })),
  },
  month: {
    ...SUMMARY.month,
    revenue: [],
    sales: { current: 0, previous: 0 },
    series: SUMMARY.month.series.map((bucket) => ({
      ...bucket,
      value: bucket.value === null ? null : '0',
    })),
  },
  selected: {
    revenue: [],
    sales: { current: 0, previous: 0 },
    renewals: { current: 0, previous: 0 },
    newCustomers: { current: 0, previous: 0 },
    failedPayments: { current: 0, previous: 0 },
    revenueSeries: { current: dayBuckets(zeros(30)), previous: dayBuckets(zeros(30)) },
    newCustomerSeries: dayBuckets(zeros(30)),
    salesByKind: SUMMARY.selected.salesByKind.map((bucket) => ({
      ...bucket,
      counts: { NEW: 0, RENEWAL: 0, ADDON: 0 },
    })),
    paymentMethods: [],
  },
  activeServices: 0,
};

export const DEMO_DASHBOARD_EMPTY: readonly ShotFixture[] = [
  fixture('/dashboard/summary', dashboardSummaryResponseSchema, EMPTY_SUMMARY),
  fixture('/dashboard/operations', dashboardOperationsResponseSchema, {
    generatedAt: SHOT_NOW,
    panels: { total: 0, active: 0, health: [], providers: [] },
    provisioning: { queued: 0, unknown: 0, unreconciledServices: 0 },
    expiring: { withinDays: 7, count: 0 },
  }),
  fixture('/nav-counters', navCountersResponseSchema, {
    generatedAt: SHOT_NOW,
    counters: {
      openConditions: 0,
      ticketsAwaitingSupport: 0,
      unhealthyPanels: 0,
      unreconciledServices: 0,
      refundRequestsAwaiting: 0,
      paymentsUnknown: 0,
      businessHandoffs: 0,
    },
  }),
  fixture('/payment-operations/attention', paymentAttentionResponseSchema, {
    window: null,
    byGateway: [],
    totals: Object.fromEntries(PAYMENT_OPS_QUEUES.map((queue) => [queue, 0])),
    generatedAt: SHOT_NOW,
  }),
  fixture('/system/diagnostics', systemDiagnosticsResponseSchema, {
    generatedAt: SHOT_NOW,
    outbox: { pending: 0, oldestPendingAt: null, failing: 0, exhausted: 0, failingSample: [] },
    provisioning: {
      counts: { UNKNOWN_OUTCOME: 0, LEASE_EXPIRED: 0, RETRYING: 0, UNANNOUNCED: 0 },
      sample: [],
    },
  }),
  fixture(
    '/ops-log',
    operationalEventListResponseSchema,
    { events: [], nextCursor: null },
    { query: { scope: 'MANAGEMENT_CONDITIONS', open: 'true' } },
  ),
  fixture('/reports/summary', reportSummaryResponseSchema, {
    period: REPORT_PERIOD,
    sales: count(0, 0),
    revenue: [],
    grossValue: [],
    discount: [],
    successfulOrders: count(0, 0),
    newUsers: count(0, 0),
    newBuyers: count(0, 0),
    newServices: count(0, 0),
    newTrialServices: count(0, 0),
    renewals: count(0, 0),
    walletTopupCount: count(0, 0),
    walletTopup: [],
    activeServices: 0,
    activeCustomers: 0,
  }),
  fixture('/reports/products', reportProductsResponseSchema, {
    period: REPORT_PERIOD,
    by: 'REVENUE',
    page: 1,
    limit: 5,
    totalRows: 0,
    rows: [],
  }),
  fixture('/reports/failures', reportFailuresResponseSchema, {
    period: REPORT_PERIOD,
    payments: { failed: 0, cancelled: 0, expired: 0, unknownNow: 0 },
    provisioning: { failed: 0, abandoned: 0 },
    commercialOperations: { failed: 0, abandoned: 0 },
    operationsUnknownNow: 0,
    byFailureKind: [],
    ordersRefunded: 0,
  }),
];
