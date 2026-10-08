import {
  PAYMENT_OPS_QUEUES,
  customerWorkspaceResponseSchema,
  dashboardOperationsResponseSchema,
  dashboardSummaryResponseSchema,
  navCountersResponseSchema,
  reportFailuresResponseSchema,
  reportProductsResponseSchema,
  reportSummaryResponseSchema,
  reportTrendResponseSchema,
  paymentAttentionResponseSchema,
} from '@nexa/contracts';
import { SHOT_NOW, fixture, type ShotFixture } from '../fixture.ts';

/*
 * Page family DASHBOARD: `/`. The dashboard reads `/dashboard/summary` and
 * `/dashboard/operations` (below), `/system/readiness` (shell.ts), `/ops-log`
 * (ops-b.ts), and for the owner three report cards (below); the shell reads
 * `/nav-counters` on every page (below).
 */

/** "Today" in Asia/Tehran around `SHOT_NOW`, by the hour. */
const PERIOD = {
  range: 'TODAY',
  timezone: 'Asia/Tehran',
  calendar: 'jalali',
  granularity: 'HOUR',
  current: {
    start: '2026-09-05T20:30:00.000Z',
    end: '2026-09-06T20:30:00.000Z',
    effectiveEnd: '2026-09-06T08:00:00.000Z',
    startLocal: '1405/06/15',
    endLocalInclusive: '1405/06/15',
  },
  previous: {
    start: '2026-09-04T20:30:00.000Z',
    end: '2026-09-05T20:30:00.000Z',
    effectiveEnd: '2026-09-05T08:00:00.000Z',
    startLocal: '1405/06/14',
    endLocalInclusive: '1405/06/14',
  },
  lengthsDiffer: false,
  generatedAt: '2026-09-06T08:00:00.000Z',
};

const count = (current: number, previous: number) => ({ current, previous });
const irt = (current: string, previous: string) => [{ currency: 'IRT', current, previous }];

/** Hour buckets: the elapsed hours carry values, the rest of the day is null (not begun). */
function buckets(values: readonly (string | null)[]) {
  return Array.from({ length: 24 }, (_, index) => ({
    index,
    start: new Date(Date.UTC(2026, 8, 5, 20, 30) + index * 3_600_000).toISOString(),
    end: new Date(Date.UTC(2026, 8, 5, 21, 30) + index * 3_600_000).toISOString(),
    label: `${String(index).padStart(2, '0')}:00`,
    value: values[index] ?? null,
  }));
}

const CURRENT = [
  '0',
  '0',
  '0',
  '0',
  '0',
  '0',
  '0',
  '120000',
  '350000',
  '480000',
  '260000',
  '610000',
];
const PREVIOUS = [
  '0',
  '0',
  '0',
  '0',
  '0',
  '0',
  '90000',
  '150000',
  '220000',
  '410000',
  '300000',
  '380000',
  '520000',
  '470000',
  '600000',
  '580000',
  '640000',
  '720000',
  '690000',
  '510000',
  '430000',
  '260000',
  '120000',
  '40000',
];

/** The three report cards the owner's dashboard reads at the reports' own cadence. */
const REPORT_CARDS: readonly ShotFixture[] = [
  fixture('/reports/summary', reportSummaryResponseSchema, {
    period: PERIOD,
    sales: count(14, 11),
    revenue: irt('1820000', '1490000'),
    grossValue: irt('1960000', '1590000'),
    discount: irt('140000', '100000'),
    successfulOrders: count(15, 12),
    newUsers: count(23, 19),
    newBuyers: count(6, 5),
    newServices: count(9, 7),
    newTrialServices: count(4, 6),
    renewals: count(5, 4),
    walletTopupCount: count(3, 2),
    walletTopup: irt('600000', '450000'),
    activeServices: 412,
    activeCustomers: 318,
  }),
  fixture('/reports/trend', reportTrendResponseSchema, {
    period: PERIOD,
    metric: 'REVENUE',
    currency: 'IRT',
    currencies: ['IRT'],
    current: buckets(CURRENT),
    previous: buckets(PREVIOUS),
  }),
  fixture('/reports/products', reportProductsResponseSchema, {
    period: PERIOD,
    by: 'REVENUE',
    page: 1,
    limit: 10,
    totalRows: 2,
    rows: [
      {
        rank: 1,
        productId: '019220ab-cdef-7012-8345-6789abcdef01',
        title: 'پلن یک‌ماهه ۵۰ گیگ',
        categoryName: 'عمومی',
        categoryEmoji: null,
        productStatus: 'ACTIVE',
        orders: 9,
        quantity: 9,
        revenue: '1170000',
        currency: 'IRT',
      },
      {
        rank: 2,
        productId: '019220ab-cdef-7012-8345-6789abcdef02',
        title: 'پلن سه‌ماهه ۱۵۰ گیگ',
        categoryName: 'ویژه',
        categoryEmoji: null,
        productStatus: 'ACTIVE',
        orders: 2,
        quantity: 2,
        revenue: '650000',
        currency: 'IRT',
      },
    ],
  }),
  fixture('/reports/failures', reportFailuresResponseSchema, {
    period: PERIOD,
    payments: { failed: 2, cancelled: 1, expired: 3, unknownNow: 0 },
    provisioning: { failed: 1, abandoned: 0 },
    commercialOperations: { failed: 0, abandoned: 0 },
    operationsUnknownNow: 0,
    byFailureKind: [{ failureKind: 'PROVIDER_ERROR', count: 1 }],
    ordersRefunded: 1,
  }),
];

// --- The dashboard's own endpoints -----------------------------------------------

/*
 * A controlled, internally consistent month of a small shop, in Asia/Tehran's
 * Jalali calendar around `SHOT_NOW` (1405/06/15 11:30). Consistent, because a
 * screenshot that shows a month total which is not the sum of its own bars is a
 * screenshot of a bug: every headline below is summed from the series it
 * heads. Deterministic, so two captures of one build are the same picture.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Tehran's midnight on the shot's day, as an instant (UTC+03:30). */
const TODAY_START = Date.parse('2026-09-05T20:30:00.000Z');
const NOW = Date.parse(SHOT_NOW);

const JALALI = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** `1405/06/15` for an instant, as the server's resolver writes a local date. */
function localDate(at: number): string {
  const parts = JALALI.formatToParts(new Date(at));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}/${get('month')}/${get('day')}`;
}

const iso = (at: number) => new Date(at).toISOString();

/** A smooth, repeatable wobble in [0, 1) — the shape of a real month, not noise. */
function wave(index: number, seed: number): number {
  const value = Math.sin(index * 1.7 + seed) * 0.5 + Math.sin(index * 0.45 + seed * 2) * 0.5;
  return (value + 1) / 2;
}

interface Side {
  readonly start: number;
  readonly end: number;
  readonly effectiveEnd: number;
}

function periodOf(range: string, granularity: string, current: Side, previous: Side) {
  const side = (s: Side) => ({
    start: iso(s.start),
    end: iso(s.end),
    effectiveEnd: iso(s.effectiveEnd),
    startLocal: localDate(s.start),
    endLocalInclusive: localDate(s.end - DAY),
  });
  return {
    range,
    timezone: 'Asia/Tehran',
    calendar: 'jalali',
    granularity,
    current: side(current),
    previous: side(previous),
    lengthsDiffer: false,
    generatedAt: SHOT_NOW,
  };
}

/** Day buckets from `start`, `count` long; a day not yet begun has no value. */
function dayBuckets(start: number, count: number, value: (index: number) => string) {
  return Array.from({ length: count }, (_, index) => {
    const at = start + index * DAY;
    return {
      index,
      start: iso(at),
      end: iso(at + DAY),
      label: localDate(at),
      value: at < NOW ? value(index) : null,
    };
  });
}

function hourBuckets(start: number, value: (index: number) => string) {
  return Array.from({ length: 24 }, (_, index) => {
    const at = start + index * HOUR;
    return {
      index,
      start: iso(at),
      end: iso(at + HOUR),
      label: `${String(index).padStart(2, '0')}:00`,
      value: at < NOW ? value(index) : null,
    };
  });
}

/** Whole toman (IRT has no minor unit), rounded to the thousand a price list would use. */
const toman = (amount: number) => String(Math.round(amount / 1000) * 1000);
const sum = (values: readonly (string | null)[]) =>
  String(values.reduce((total, value) => total + (value === null ? 0 : Number(value)), 0));

// The selected period: the last 30 days (the dashboard's default), today included.
const SELECTED_START = TODAY_START - 29 * DAY;
const PREVIOUS_START = SELECTED_START - 30 * DAY;
const ELAPSED = NOW - SELECTED_START;

const salesOn = (index: number, seed: number) => ({
  NEW: 9 + Math.round(wave(index, seed) * 10),
  RENEWAL: 6 + Math.round(wave(index, seed + 1.3) * 7),
  ADDON: 1 + Math.round(wave(index, seed + 2.1) * 3),
});
// Today is a morning: about half a day's sales so far.
const TODAY_INDEX = 29;
const partial = (index: number, full: number) =>
  index === TODAY_INDEX ? Math.round(full * 0.45) : full;

const KIND_BUCKETS = dayBuckets(SELECTED_START, 30, () => '0').map((bucket, index) => {
  const sales = salesOn(index, 0.4);
  return {
    index: bucket.index,
    start: bucket.start,
    end: bucket.end,
    label: bucket.label,
    counts: {
      NEW: partial(index, sales.NEW),
      RENEWAL: partial(index, sales.RENEWAL),
      ADDON: partial(index, sales.ADDON),
    },
  };
});
const salesCount = (index: number) => {
  const counts = KIND_BUCKETS[index]?.counts;
  return counts === undefined ? 0 : counts.NEW + counts.RENEWAL + counts.ADDON;
};
const TODAY_REVENUE = hourBuckets(TODAY_START, (hour) =>
  hour < 7 ? '0' : toman((hour === 11 ? 0.5 : 1) * (380_000 + wave(hour, 0.9) * 1_400_000)),
);
const TODAY_TOTAL = sum(TODAY_REVENUE.map((b) => b.value));
/** Yesterday up to the same minute: the like-for-like comparison. */
const YESTERDAY_REVENUE = toman(Number(TODAY_TOTAL) * 0.92);

const REVENUE_CURRENT = dayBuckets(SELECTED_START, 30, (index) =>
  index === TODAY_INDEX
    ? TODAY_TOTAL
    : toman(salesCount(index) * (410_000 + wave(index, 3.1) * 120_000)),
);
const REVENUE_PREVIOUS = dayBuckets(PREVIOUS_START, 30, (index) => {
  const sales = salesOn(index, 2.2);
  const count = sales.NEW + sales.RENEWAL + sales.ADDON;
  return toman(count * (380_000 + wave(index, 1.2) * 110_000));
}).map((bucket, index) => ({
  ...bucket,
  // The previous side runs only as long as the current one has: like for like.
  value: index === TODAY_INDEX ? toman(Number(bucket.value ?? '0') * 0.45) : bucket.value,
}));
const NEW_CUSTOMERS = dayBuckets(SELECTED_START, 30, (index) =>
  String(partial(index, 6 + Math.round(wave(index, 5.5) * 9))),
);

// This month: 1405/06/01 (2026-08-23 local) to the end of Shahrivar's 31 days.
const MONTH_START = TODAY_START - 14 * DAY;
const MONTH_REVENUE = dayBuckets(MONTH_START, 31, (index) =>
  String(REVENUE_CURRENT[index + 15]?.value ?? '0'),
);
const MONTH_SALES = Array.from({ length: 15 }, (_, index) => salesCount(index + 15)).reduce(
  (total, value) => total + value,
  0,
);

const selectedSales = KIND_BUCKETS.reduce(
  (total, bucket) => total + bucket.counts.NEW + bucket.counts.RENEWAL + bucket.counts.ADDON,
  0,
);
const selectedRenewals = KIND_BUCKETS.reduce((total, bucket) => total + bucket.counts.RENEWAL, 0);
const selectedRevenue = sum(REVENUE_CURRENT.map((b) => b.value));
const previousRevenue = sum(REVENUE_PREVIOUS.map((b) => b.value));
const gateway = Math.round(selectedSales * 0.52);
const manual = Math.round(selectedSales * 0.3);
const wallet = selectedSales - gateway - manual;
const share = (part: number) => toman((Number(selectedRevenue) * part) / selectedSales);

const SUMMARY_30_DAYS = {
  period: periodOf(
    'LAST_30_DAYS',
    'DAY',
    { start: SELECTED_START, end: TODAY_START + DAY, effectiveEnd: NOW },
    { start: PREVIOUS_START, end: SELECTED_START, effectiveEnd: PREVIOUS_START + ELAPSED },
  ),
  currency: 'IRT',
  currencies: ['IRT'],
  today: {
    period: periodOf(
      'TODAY',
      'HOUR',
      { start: TODAY_START, end: TODAY_START + DAY, effectiveEnd: NOW },
      { start: TODAY_START - DAY, end: TODAY_START, effectiveEnd: NOW - DAY },
    ),
    revenue: [
      {
        currency: 'IRT',
        current: TODAY_TOTAL,
        previous: YESTERDAY_REVENUE,
      },
    ],
    sales: { current: salesCount(TODAY_INDEX), previous: 14 },
    series: TODAY_REVENUE,
  },
  month: {
    period: periodOf(
      'THIS_MONTH',
      'DAY',
      { start: MONTH_START, end: MONTH_START + 31 * DAY, effectiveEnd: NOW },
      {
        start: MONTH_START - 31 * DAY,
        end: MONTH_START,
        effectiveEnd: MONTH_START - 31 * DAY + (NOW - MONTH_START),
      },
    ),
    revenue: [
      {
        currency: 'IRT',
        current: sum(MONTH_REVENUE.map((b) => b.value)),
        previous: toman(Number(sum(MONTH_REVENUE.map((b) => b.value))) * 0.87),
      },
    ],
    sales: { current: MONTH_SALES, previous: Math.round(MONTH_SALES * 0.9) },
    series: MONTH_REVENUE,
  },
  selected: {
    revenue: [{ currency: 'IRT', current: selectedRevenue, previous: previousRevenue }],
    sales: { current: selectedSales, previous: Math.round(selectedSales * 0.93) },
    renewals: { current: selectedRenewals, previous: Math.round(selectedRenewals * 0.89) },
    newCustomers: {
      current: Number(sum(NEW_CUSTOMERS.map((b) => b.value))),
      previous: Number(sum(NEW_CUSTOMERS.map((b) => b.value))) + 14,
    },
    failedPayments: { current: 9, previous: 6 },
    revenueSeries: { current: REVENUE_CURRENT, previous: REVENUE_PREVIOUS },
    newCustomerSeries: NEW_CUSTOMERS,
    salesByKind: KIND_BUCKETS,
    paymentMethods: [
      {
        method: 'GATEWAY',
        confirmed: gateway,
        confirmedAmount: [{ currency: 'IRT', amount: share(gateway) }],
      },
      {
        method: 'MANUAL_TRANSFER',
        confirmed: manual,
        confirmedAmount: [{ currency: 'IRT', amount: share(manual) }],
      },
      {
        method: 'WALLET',
        confirmed: wallet,
        confirmedAmount: [{ currency: 'IRT', amount: share(wallet) }],
      },
    ],
  },
  activeServices: 412,
};

export const DASHBOARD: readonly ShotFixture[] = [
  ...REPORT_CARDS,
  fixture('/dashboard/summary', dashboardSummaryResponseSchema, SUMMARY_30_DAYS),
  fixture('/dashboard/operations', dashboardOperationsResponseSchema, {
    generatedAt: SHOT_NOW,
    panels: {
      total: 8,
      active: 7,
      health: [
        { state: 'HEALTHY', count: 5 },
        { state: 'DEGRADED', count: 1 },
        { state: 'UNREACHABLE', count: 1 },
        { state: 'DISABLED', count: 1 },
      ],
      providers: [
        { providerType: 'marzban', providerName: 'Marzban', count: 5 },
        { providerType: 'sanaei', providerName: '3X-UI (MHSanaei)', count: 3 },
      ],
    },
    provisioning: { queued: 4, unknown: 1, unreconciledServices: 2 },
    expiring: { withinDays: 7, count: 38 },
  }),
  fixture('/nav-counters', navCountersResponseSchema, {
    generatedAt: SHOT_NOW,
    counters: {
      openConditions: 3,
      ticketsAwaitingSupport: 5,
      unhealthyPanels: 2,
      unreconciledServices: 2,
      refundRequestsAwaiting: 1,
      paymentsUnknown: 1,
      businessHandoffs: 2,
    },
  }),
  // Roadmap B6 (Agent 2b): the attention queue's payment source, the payments page's too.
  fixture('/payment-operations/attention', paymentAttentionResponseSchema, {
    window: null,
    byGateway: [],
    totals: {
      ...Object.fromEntries(PAYMENT_OPS_QUEUES.map((queue) => [queue, 0])),
      UNKNOWN: 1,
      NEEDS_RECONCILIATION: 1,
    },
    generatedAt: SHOT_NOW,
  }),
  // Roadmap B5 (Agent 2b): Customer 360's workspace summary.
  fixture('/users/:id/workspace', customerWorkspaceResponseSchema, {
    workspace: {
      generatedAt: SHOT_NOW,
      tickets: { awaitingSupport: 1, open: 2 },
      businessHandoffs: 1,
      businessHandoffConversationId: '019210ab-cdef-7012-8345-6789abcd5101',
      payments: {
        unknown: 1,
        latest: [
          {
            id: '019210ab-cdef-7012-8345-6789abcd5001',
            reference: 'NX-7K2Q-91',
            method: 'MANUAL_TRANSFER',
            state: 'UNKNOWN',
            amount: '450000',
            currency: 'IRT',
            createdAt: '2026-09-06T06:40:00.000Z',
          },
        ],
      },
      services: { unreconciled: 0 },
      orders: {
        latest: [
          {
            id: '019210ab-cdef-7012-8345-6789abcd5002',
            lineTitle: 'پلن ۳۰ روزه — ۵۰ گیگ',
            purpose: 'NEW_SERVICE',
            state: 'PAID',
            totalAmount: '450000',
            currency: 'IRT',
            createdAt: '2026-09-06T06:30:00.000Z',
          },
        ],
      },
    },
  }),
];
