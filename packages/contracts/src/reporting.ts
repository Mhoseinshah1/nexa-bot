import { z } from 'zod';
import { ORDER_PURPOSES, type OrderPurpose } from './commerce.js';
import { LEDGER_DIRECTIONS, LEDGER_REASONS, type LedgerReason } from './ledger.js';
import { CURRENCY_CODES, moneySchema } from './money.js';
import { PAYMENT_METHODS, PAYMENT_STATES } from './payment.js';
import { OPERATION_STATES, OPERATION_TYPES, SERVICE_STATES } from './provisioning.js';
import { CALENDARS } from './time.js';

/**
 * WP12 — business analytics and reports (`docs/wp12-business-analytics-audit.md`).
 *
 * Reporting only. Every figure on the wire is a named derivation from a persisted row;
 * the audit maps each one, and `METRIC_DEFINITIONS` registers each one by name. There is
 * no field here for profit, margin or cost, and no money beside a panel, provider or
 * location — both are forbidden by the owner, and a field that does not exist cannot
 * be filled by a later convenience.
 */

// --- Ranges ---------------------------------------------------------------------

/**
 * The periods a report is asked for.
 *
 * `NAMED_PERIODS` in `time.ts` carries `ALL_TIME`, which no WP12 report offers (a
 * comparison with "the previous all time" means nothing), and lacks `CUSTOM`. A second
 * list rather than a widened first one, because `NAMED_PERIODS` is what the metric
 * registry's `supportedPeriods` speaks and a custom range is not a named period.
 */
export const REPORT_RANGES = [
  'TODAY',
  'YESTERDAY',
  'LAST_7_DAYS',
  'LAST_30_DAYS',
  'THIS_MONTH',
  'PREVIOUS_MONTH',
  'THIS_YEAR',
  'CUSTOM',
] as const;
export type ReportRange = (typeof REPORT_RANGES)[number];

/** A custom range is 1 to this many local days, inclusive of both ends. */
export const REPORT_CUSTOM_RANGE_MAX_DAYS = 731;

/**
 * A local calendar date in the TENANT's calendar: `1405-07-01` for a Jalali tenant.
 *
 * The tenant's calendar and not ISO's, because that is what the operator reads and types,
 * and the one conversion lives on the server beside the timezone it belongs with.
 */
export const reportLocalDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'a local date is YYYY-MM-DD in the tenant calendar');

export const REPORT_GRANULARITIES = ['HOUR', 'DAY', 'WEEK', 'MONTH'] as const;
export type ReportGranularity = (typeof REPORT_GRANULARITIES)[number];

/**
 * The automatic granularity, from the number of local days in the nominal period.
 *
 * One rule for presets and custom ranges alike: a day is hourly, up to 31 days daily,
 * up to six 31-day months weekly, and beyond that monthly.
 */
export function reportGranularityFor(localDays: number): ReportGranularity {
  if (localDays <= 1) return 'HOUR';
  if (localDays <= 31) return 'DAY';
  if (localDays <= 186) return 'WEEK';
  return 'MONTH';
}

/** Business analytics re-read on this cadence, never faster. Operational cards keep theirs. */
export const REPORT_REFRESH_INTERVAL_MS = 300_000;

// --- Classifiers ----------------------------------------------------------------

/**
 * Whether an order of this purpose is a SALE — money taken for a commercial operation.
 *
 * Exhaustive by `switch`, for the reason `orderPurposeCreatesService` gives: a purpose
 * added to `ORDER_PURPOSES` must be classified here before it can compile, rather than
 * fall silently into or out of revenue. A trial is never a sale — its total is zero by
 * `orders_trial_is_free_check` — and it is still a successful order.
 */
export function orderPurposeIsSale(purpose: OrderPurpose): boolean {
  switch (purpose) {
    case 'NEW_SERVICE':
    case 'RENEW':
    case 'ADD_TRAFFIC':
    case 'ADD_TIME':
      return true;
    case 'TRIAL':
      return false;
    default: {
      const unreachable: never = purpose;
      throw new Error(`unclassified order purpose ${String(unreachable)}`);
    }
  }
}

export const SALE_ORDER_PURPOSES: readonly OrderPurpose[] = ORDER_PURPOSES.filter((purpose) =>
  orderPurposeIsSale(purpose),
);

/** The purposes a product ranking counts: a product bought or renewed, never an add-on. */
export const PRODUCT_RANKING_PURPOSES: readonly OrderPurpose[] = ['NEW_SERVICE', 'RENEW'];

/** The purposes that carry traffic a customer bought. */
export const TRAFFIC_SELLING_PURPOSES: readonly OrderPurpose[] = [
  'NEW_SERVICE',
  'RENEW',
  'ADD_TRAFFIC',
];

/**
 * What a wallet ledger reason MEANS to a report.
 *
 * A `Record` over the frozen reason vocabulary, so a reason added to `LEDGER_REASONS`
 * without a group is a compile error rather than a credit silently counted as a top-up
 * or left out of every total. Classified by the reason CODE only — never the free-text
 * note (spec §13).
 */
export const WALLET_REPORT_GROUPS = [
  'TOPUP',
  'RECEIPT_CREDIT',
  'CASHBACK',
  'CASHBACK_REVERSAL',
  'GIFT',
  'REFERRAL_COMMISSION',
  'REFERRAL_COMMISSION_REVERSAL',
  'SPENDING',
  'REFUND',
  'ADMINISTRATIVE',
  'OTHER',
] as const;
export type WalletReportGroup = (typeof WALLET_REPORT_GROUPS)[number];

export const WALLET_REPORT_GROUP_OF: Readonly<Record<LedgerReason, WalletReportGroup>> = {
  TOPUP_GATEWAY: 'TOPUP',
  TOPUP_RECEIPT: 'TOPUP',
  TOPUP_STARS: 'TOPUP',
  TOPUP_CRYPTO: 'TOPUP',
  RECEIPT_CREDIT: 'RECEIPT_CREDIT',
  PURCHASE: 'SPENDING',
  PURCHASE_REVERSAL: 'REFUND',
  REFUND: 'REFUND',
  CASHBACK_GATEWAY: 'CASHBACK',
  CASHBACK_TOPUP: 'CASHBACK',
  CASHBACK_RENEWAL: 'CASHBACK',
  CASHBACK_PURCHASE: 'CASHBACK',
  CASHBACK_REVERSAL: 'CASHBACK_REVERSAL',
  REFERRAL_COMMISSION: 'REFERRAL_COMMISSION',
  REFERRAL_COMMISSION_REVERSAL: 'REFERRAL_COMMISSION_REVERSAL',
  REFERRAL_SIGNUP_GIFT: 'GIFT',
  START_GIFT: 'GIFT',
  LOTTERY_WIN: 'GIFT',
  LUCK_WHEEL_WIN: 'GIFT',
  ADMIN_CREDIT: 'ADMINISTRATIVE',
  ADMIN_DEBIT: 'ADMINISTRATIVE',
  MASS_CREDIT: 'ADMINISTRATIVE',
  MASS_DEBIT: 'ADMINISTRATIVE',
  CORRECTION: 'ADMINISTRATIVE',
  RESELLER_SETTLEMENT: 'OTHER',
  RESELLER_MEMBERSHIP_FEE: 'OTHER',
  CHARGEBACK: 'OTHER',
  OTHER: 'OTHER',
};

/** The reasons of one group, derived from the one map above. */
export function ledgerReasonsIn(group: WalletReportGroup): readonly LedgerReason[] {
  return LEDGER_REASONS.filter((reason) => WALLET_REPORT_GROUP_OF[reason] === group);
}

/**
 * The payment states the success rate's denominator counts as failed.
 *
 * `PAYMENT_RESOLVED_STATES` exactly — the terminal states reached WITHOUT money. PENDING
 * is not yet anything, and UNKNOWN is terminal only until reconciled, so neither is a
 * failure: counting either would lower a rate for attempts that may still succeed.
 */
export const REPORT_FAILED_PAYMENT_STATES = ['FAILED', 'CANCELLED', 'EXPIRED'] as const;

/** The operation states that are a terminal failure. UNKNOWN is not one: a READ decides. */
export const REPORT_FAILED_OPERATION_STATES = ['FAILED', 'ABANDONED'] as const;

/** The operation types that act on an existing service for money. */
export const REPORT_COMMERCIAL_OPERATION_TYPES = ['RENEW', 'ADD_TRAFFIC', 'ADD_TIME'] as const;

// --- Bounds ---------------------------------------------------------------------

export const REPORT_RANKING_TOP = 10;
export const REPORT_RANKING_PAGE_MAX = 100;
/** A ranking is paged no deeper than this many rows. */
export const REPORT_RANKING_DEPTH_MAX = 10_000;
export const REPORT_DRILLDOWN_PAGE_DEFAULT = 25;
export const REPORT_DRILLDOWN_PAGE_MAX = 100;
/** Resellers and panels are operator-created and few; a report lists this many at most. */
export const REPORT_ENTITY_ROWS_MAX = 500;
/** An export larger than this is refused, never truncated. */
export const REPORT_EXPORT_ROW_MAX = 10_000;

export const REPORT_EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ReportExportFormat = (typeof REPORT_EXPORT_FORMATS)[number];

export const REPORT_EXPORT_KINDS = [
  'SALES',
  'PRODUCTS',
  'PAYMENTS',
  'WALLET',
  'INFRASTRUCTURE',
  'REFERRALS',
  'RESELLERS',
] as const;
export type ReportExportKind = (typeof REPORT_EXPORT_KINDS)[number];

export const REPORT_TREND_METRICS = ['REVENUE', 'SALES', 'NEW_USERS', 'RENEWALS'] as const;
export type ReportTrendMetric = (typeof REPORT_TREND_METRICS)[number];

export const REPORT_PRODUCT_RANKINGS = ['COUNT', 'REVENUE'] as const;
export type ReportProductRanking = (typeof REPORT_PRODUCT_RANKINGS)[number];

export const REPORT_REFERRER_RANKINGS = ['SIGNUPS', 'BUYERS', 'REVENUE', 'COMMISSION'] as const;
export type ReportReferrerRanking = (typeof REPORT_REFERRER_RANKINGS)[number];

export const REPORT_PAYMENT_KINDS = ['ORDER', 'TOPUP'] as const;
export type ReportPaymentKind = (typeof REPORT_PAYMENT_KINDS)[number];

export const REPORT_OPERATION_GROUPS = ['PROVISION', 'COMMERCIAL'] as const;
export type ReportOperationGroup = (typeof REPORT_OPERATION_GROUPS)[number];

// --- Queries --------------------------------------------------------------------

/**
 * The period every report takes. `from` and `to` exist exactly when `range` is CUSTOM.
 *
 * Enforced here rather than left to the resolver so that a preset with a stray `from`
 * is a 400 at the edge instead of a parameter quietly ignored — an operator who typed a
 * range and got "today" would read the wrong figures without knowing it.
 */
export const reportRangeQuerySchema = z
  .object({
    range: z.enum(REPORT_RANGES),
    from: reportLocalDateSchema.optional(),
    to: reportLocalDateSchema.optional(),
  })
  .superRefine((value, context) => {
    const custom = value.range === 'CUSTOM';
    for (const key of ['from', 'to'] as const) {
      if (custom && value[key] === undefined) {
        context.addIssue({ code: 'custom', path: [key], message: `a CUSTOM range needs ${key}` });
      }
      if (!custom && value[key] !== undefined) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is accepted only with range=CUSTOM`,
        });
      }
    }
  });
export type ReportRangeQuery = z.infer<typeof reportRangeQuerySchema>;

const pageLimit = (max: number) => z.coerce.number().int().positive().max(max).optional();
const rankingPage = z.coerce
  .number()
  .int()
  .positive()
  .max(REPORT_RANKING_DEPTH_MAX / REPORT_RANKING_TOP)
  .optional();

export const reportTrendQuerySchema = z.object({
  metric: z.enum(REPORT_TREND_METRICS),
  currency: z.enum(CURRENCY_CODES).optional(),
});

export const reportProductsQuerySchema = z.object({
  by: z.enum(REPORT_PRODUCT_RANKINGS),
  limit: pageLimit(REPORT_RANKING_PAGE_MAX),
  page: rankingPage,
});

export const reportReferralsQuerySchema = z.object({
  by: z.enum(REPORT_REFERRER_RANKINGS).optional(),
  limit: pageLimit(REPORT_RANKING_PAGE_MAX),
  page: rankingPage,
});

export const reportOrdersQuerySchema = z.object({
  purpose: z.enum(ORDER_PURPOSES).optional(),
  productId: z.uuid().optional(),
  limit: pageLimit(REPORT_DRILLDOWN_PAGE_MAX),
  cursor: z.string().min(1).max(200).optional(),
});

export const reportPaymentAttemptsQuerySchema = z.object({
  method: z.enum(PAYMENT_METHODS).optional(),
  // The route's code as stored. Bounded and shaped, never a free string into SQL.
  provider: z
    .string()
    .regex(/^[A-Z0-9_]{1,64}$/)
    .optional(),
  kind: z.enum(REPORT_PAYMENT_KINDS).optional(),
  state: z.enum(PAYMENT_STATES).optional(),
  limit: pageLimit(REPORT_DRILLDOWN_PAGE_MAX),
  cursor: z.string().min(1).max(200).optional(),
});

export const reportOperationsQuerySchema = z.object({
  group: z.enum(REPORT_OPERATION_GROUPS).optional(),
  limit: pageLimit(REPORT_DRILLDOWN_PAGE_MAX),
  cursor: z.string().min(1).max(200).optional(),
});

export const reportExportQuerySchema = z.object({
  report: z.enum(REPORT_EXPORT_KINDS),
  format: z.enum(REPORT_EXPORT_FORMATS),
});

// --- Responses ------------------------------------------------------------------

const minorString = z.string().regex(/^-?\d+$/, 'must be an integer string');
const count = z.number().int().nonnegative();
const iso = z.iso.datetime();

/** One side of a period, as instants AND as the tenant reads it. */
export const reportPeriodSideSchema = z.object({
  start: iso,
  end: iso,
  /**
   * Where the figures actually stop: `end`, or — for a period still in progress — the
   * instant the comparison is cut at. The previous side's is the same elapsed duration
   * from ITS start, so an unfinished day is compared with the same hours of the last.
   */
  effectiveEnd: iso,
  /** The first local date, in the tenant calendar: `1405/07/01`. */
  startLocal: z.string(),
  /** The last local date INCLUDED, in the tenant calendar. */
  endLocalInclusive: z.string(),
});

export const reportPeriodSchema = z.object({
  range: z.enum(REPORT_RANGES),
  timezone: z.string(),
  calendar: z.enum(CALENDARS),
  granularity: z.enum(REPORT_GRANULARITIES),
  current: reportPeriodSideSchema,
  previous: reportPeriodSideSchema,
  /** The two periods have different nominal lengths (a 31-day month against a 30-day one). */
  lengthsDiffer: z.boolean(),
  /** When the server computed the figures. The UI's "last updated". */
  generatedAt: iso,
});
export type ReportPeriodResponse = z.infer<typeof reportPeriodSchema>;

export const countComparisonSchema = z.object({ current: count, previous: count });
export type CountComparison = z.infer<typeof countComparisonSchema>;

/** Money compared per currency. Never summed across currencies. */
export const moneyComparisonSchema = z.array(
  z.object({
    currency: z.enum(CURRENCY_CODES),
    current: minorString,
    previous: minorString,
  }),
);
export type MoneyComparison = z.infer<typeof moneyComparisonSchema>;

export const reportSummaryResponseSchema = z.object({
  period: reportPeriodSchema,
  sales: countComparisonSchema,
  revenue: moneyComparisonSchema,
  grossValue: moneyComparisonSchema,
  discount: moneyComparisonSchema,
  successfulOrders: countComparisonSchema,
  newUsers: countComparisonSchema,
  newBuyers: countComparisonSchema,
  newServices: countComparisonSchema,
  newTrialServices: countComparisonSchema,
  renewals: countComparisonSchema,
  walletTopupCount: countComparisonSchema,
  walletTopup: moneyComparisonSchema,
  /** Gauges, now. No comparison: there is no stored history of a state. */
  activeServices: count,
  activeCustomers: count,
});
export type ReportSummaryResponse = z.infer<typeof reportSummaryResponseSchema>;

export const reportBucketSchema = z.object({
  index: count,
  start: iso,
  end: iso,
  /** The bucket as the tenant reads it: an hour, a date, a date range or a month. */
  label: z.string(),
  /** Exact, as an integer string. Null for a bucket that has not started yet. */
  value: minorString.nullable(),
});
export type ReportBucket = z.infer<typeof reportBucketSchema>;

export const reportTrendResponseSchema = z.object({
  period: reportPeriodSchema,
  metric: z.enum(REPORT_TREND_METRICS),
  /** The currency a REVENUE series is in; null for a count. */
  currency: z.enum(CURRENCY_CODES).nullable(),
  /** Every currency revenue was taken in during either period. */
  currencies: z.array(z.enum(CURRENCY_CODES)),
  current: z.array(reportBucketSchema),
  previous: z.array(reportBucketSchema),
});
export type ReportTrendResponse = z.infer<typeof reportTrendResponseSchema>;

export const reportProductRowSchema = z.object({
  rank: count,
  /** Navigation only. The title below is the SNAPSHOT the product was sold under. */
  productId: z.string(),
  title: z.string(),
  categoryName: z.string().nullable(),
  categoryEmoji: z.string().nullable(),
  /** The product's lifecycle NOW, the one current fact a history row shows. */
  productStatus: z.string().nullable(),
  orders: count,
  quantity: count,
  revenue: minorString,
  currency: z.enum(CURRENCY_CODES),
});
export type ReportProductRow = z.infer<typeof reportProductRowSchema>;

export const reportProductsResponseSchema = z.object({
  period: reportPeriodSchema,
  by: z.enum(REPORT_PRODUCT_RANKINGS),
  rows: z.array(reportProductRowSchema),
  page: count,
  limit: count,
  totalRows: count,
});
export type ReportProductsResponse = z.infer<typeof reportProductsResponseSchema>;

const moneyTotals = z.array(z.object({ currency: z.enum(CURRENCY_CODES), amount: minorString }));

export const reportServicesResponseSchema = z.object({
  period: reportPeriodSchema,
  newServices: countComparisonSchema,
  newTrialServices: countComparisonSchema,
  activeServices: count,
  states: z.array(z.object({ state: z.enum(SERVICE_STATES), count })),
  operations: z.array(
    z.object({
      purpose: z.enum(ORDER_PURPOSES),
      orders: countComparisonSchema,
      revenue: moneyComparisonSchema,
    }),
  ),
  /** Bytes of METERED traffic sold. An unlimited line is counted, never added as zero. */
  trafficSoldBytes: minorString,
  unlimitedTrafficLines: count,
});
export type ReportServicesResponse = z.infer<typeof reportServicesResponseSchema>;

/** Service, traffic and failure figures. There is deliberately no money in this shape. */
const infrastructureFigures = {
  servicesCreated: count,
  activeServices: count,
  trafficSoldBytes: minorString,
  unlimitedTrafficLines: count,
  provisioningFailures: count,
};

export const reportInfrastructureResponseSchema = z.object({
  period: reportPeriodSchema,
  panels: z.array(
    z.object({
      panelId: z.string(),
      panelName: z.string(),
      providerType: z.string(),
      ...infrastructureFigures,
    }),
  ),
  providers: z.array(z.object({ providerType: z.string(), ...infrastructureFigures })),
  truncated: z.boolean(),
  /** Always false in this release: no single location is recorded for a service. */
  locationSupported: z.literal(false),
});
export type ReportInfrastructureResponse = z.infer<typeof reportInfrastructureResponseSchema>;

const paymentFigures = {
  attempts: count,
  confirmed: count,
  failed: count,
  cancelled: count,
  expired: count,
  pending: count,
  unknown: count,
  /** confirmed / (confirmed + failed + cancelled + expired), in basis points; null on 0/0. */
  successRateBasisPoints: z.number().int().min(0).max(10_000).nullable(),
  confirmedAmount: moneyTotals,
};

export const reportPaymentsResponseSchema = z.object({
  period: reportPeriodSchema,
  rows: z.array(
    z.object({
      method: z.enum(PAYMENT_METHODS),
      /** The route code the payment was offered through, as stored; null for none. */
      provider: z.string().nullable(),
      kind: z.enum(REPORT_PAYMENT_KINDS),
      ...paymentFigures,
    }),
  ),
  totals: z.object(paymentFigures),
});
export type ReportPaymentsResponse = z.infer<typeof reportPaymentsResponseSchema>;

export const reportWalletResponseSchema = z.object({
  period: reportPeriodSchema,
  reasons: z.array(
    z.object({
      reason: z.enum(LEDGER_REASONS),
      direction: z.enum(LEDGER_DIRECTIONS),
      group: z.enum(WALLET_REPORT_GROUPS),
      currency: z.enum(CURRENCY_CODES),
      entries: count,
      amount: minorString,
    }),
  ),
  groups: z.array(
    z.object({
      group: z.enum(WALLET_REPORT_GROUPS),
      currency: z.enum(CURRENCY_CODES),
      entries: count,
      amount: minorString,
    }),
  ),
  /** Σ signed entries up to now, per currency: the stored value customers hold. */
  balances: moneyTotals,
});
export type ReportWalletResponse = z.infer<typeof reportWalletResponseSchema>;

const moneyCountTotals = z.array(
  z.object({ currency: z.enum(CURRENCY_CODES), amount: minorString, entries: count }),
);

export const reportReferralsResponseSchema = z.object({
  period: reportPeriodSchema,
  signups: countComparisonSchema,
  /** Of THIS period's signups, how many have bought at least once, to date. */
  convertedBuyers: count,
  conversionBasisPoints: z.number().int().min(0).max(10_000).nullable(),
  signupGifts: moneyCountTotals,
  commissions: moneyCountTotals,
  commissionReversals: moneyCountTotals,
  referredSales: count,
  referredRevenue: moneyTotals,
  topReferrers: z.object({
    by: z.enum(REPORT_REFERRER_RANKINGS),
    /** The currency REVENUE and COMMISSION rankings are ordered by. */
    rankingCurrency: z.enum(CURRENCY_CODES),
    page: count,
    limit: count,
    totalRows: count,
    rows: z.array(
      z.object({
        rank: count,
        /** A link to the canonical customer page. No name, handle or Telegram id. */
        referrerId: z.string(),
        signups: count,
        convertedBuyers: count,
        revenue: moneyTotals,
        commission: moneyTotals,
      }),
    ),
  }),
});
export type ReportReferralsResponse = z.infer<typeof reportReferralsResponseSchema>;

export const reportResellersResponseSchema = z.object({
  period: reportPeriodSchema,
  rows: z.array(
    z.object({
      /** A link to the canonical customer page. */
      resellerCustomerId: z.string(),
      tierName: z.string(),
      status: z.string(),
      orders: count,
      sales: moneyTotals,
      services: count,
      creditLimit: moneySchema.nullable(),
      /** How far below zero the reseller's wallet is now, in the limit's currency. */
      creditInUse: moneySchema.nullable(),
    }),
  ),
  truncated: z.boolean(),
});
export type ReportResellersResponse = z.infer<typeof reportResellersResponseSchema>;

export const reportFailuresResponseSchema = z.object({
  period: reportPeriodSchema,
  payments: z.object({ failed: count, cancelled: count, expired: count, unknownNow: count }),
  provisioning: z.object({ failed: count, abandoned: count }),
  commercialOperations: z.object({ failed: count, abandoned: count }),
  operationsUnknownNow: count,
  /** Failed operations by structured failure kind; the provider's own text is never read. */
  byFailureKind: z.array(z.object({ failureKind: z.string().nullable(), count })),
  ordersRefunded: count,
});
export type ReportFailuresResponse = z.infer<typeof reportFailuresResponseSchema>;

export const reportOrderRowSchema = z.object({
  orderId: z.string(),
  settledAt: iso,
  purpose: z.enum(ORDER_PURPOSES),
  title: z.string(),
  categoryName: z.string().nullable(),
  subtotal: minorString,
  discount: minorString,
  total: minorString,
  currency: z.enum(CURRENCY_CODES),
  paymentMethod: z.enum(PAYMENT_METHODS).nullable(),
  paymentProvider: z.string().nullable(),
  /** A link to the canonical customer page, and nothing about the customer. */
  customerId: z.string(),
});
export type ReportOrderRow = z.infer<typeof reportOrderRowSchema>;

export const reportOrdersResponseSchema = z.object({
  period: reportPeriodSchema,
  rows: z.array(reportOrderRowSchema),
  nextCursor: z.string().nullable(),
});
export type ReportOrdersResponse = z.infer<typeof reportOrdersResponseSchema>;

export const reportPaymentAttemptRowSchema = z.object({
  paymentId: z.string(),
  reference: z.string(),
  createdAt: iso,
  method: z.enum(PAYMENT_METHODS),
  provider: z.string().nullable(),
  kind: z.enum(REPORT_PAYMENT_KINDS),
  state: z.enum(PAYMENT_STATES),
  amount: minorString,
  currency: z.enum(CURRENCY_CODES),
  orderId: z.string().nullable(),
});

export const reportPaymentAttemptsResponseSchema = z.object({
  period: reportPeriodSchema,
  rows: z.array(reportPaymentAttemptRowSchema),
  nextCursor: z.string().nullable(),
});
export type ReportPaymentAttemptsResponse = z.infer<typeof reportPaymentAttemptsResponseSchema>;

export const reportOperationRowSchema = z.object({
  operationId: z.string(),
  serviceId: z.string(),
  orderId: z.string().nullable(),
  panelId: z.string(),
  panelName: z.string().nullable(),
  type: z.enum(OPERATION_TYPES),
  state: z.enum(OPERATION_STATES),
  failureKind: z.string().nullable(),
  completedAt: iso,
});

export const reportOperationsResponseSchema = z.object({
  period: reportPeriodSchema,
  rows: z.array(reportOperationRowSchema),
  nextCursor: z.string().nullable(),
});
export type ReportOperationsResponse = z.infer<typeof reportOperationsResponseSchema>;

// --- Routes ---------------------------------------------------------------------

export const REPORT_ROUTES = {
  summary: '/reports/summary',
  trend: '/reports/trend',
  products: '/reports/products',
  services: '/reports/services',
  infrastructure: '/reports/infrastructure',
  payments: '/reports/payments',
  wallet: '/reports/wallet',
  referrals: '/reports/referrals',
  resellers: '/reports/resellers',
  failures: '/reports/failures',
  orders: '/reports/orders',
  paymentAttempts: '/reports/payment-attempts',
  operations: '/reports/operations',
  export: '/reports/export',
} as const;
