import {
  reportFailuresResponseSchema,
  reportProductsResponseSchema,
  reportSummaryResponseSchema,
  reportTrendResponseSchema,
} from '@nexa/contracts';
import { fixture, type ShotFixture } from '../fixture.ts';

/*
 * Page family DASHBOARD: `/`. Today's dashboard reads `/system/readiness`
 * (shell.ts), `/panels` (ops-a.ts), `/ops-log` (ops-b.ts) and, for the Super
 * Admin, the business report cards below. The dashboard agent adds its
 * summary and trend endpoints here.
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

export const DASHBOARD: readonly ShotFixture[] = [
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
