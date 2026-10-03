import type {
  AdminId,
  Calendar,
  CurrencyCode,
  LedgerDirection,
  LedgerReason,
  OrderPurpose,
  OperationState,
  OperationType,
  PaymentMethod,
  PaymentState,
  ReportGranularity,
  ReportOperationGroup,
  ReportExportKind,
  ReportPaymentKind,
  ReportProductRanking,
  ReportRange,
  ReportReferrerRanking,
  ReportTrendMetric,
  RefundChannel,
  ScopeContext,
  ServiceState,
  TenantContext,
} from '@nexa/contracts';

/**
 * The ports the reporting service needs (`docs/wp12-business-analytics-audit.md`).
 *
 * Read-only throughout. Every repository method is ONE aggregate statement bounded by the
 * tenant and a half-open instant range; nothing here returns raw rows for the service to
 * sum, and nothing writes.
 */

// --- Periods --------------------------------------------------------------------

export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface BucketBounds {
  readonly index: number;
  readonly start: Date;
  readonly end: Date;
  readonly label: string;
}

export interface PeriodSide {
  readonly start: Date;
  readonly end: Date;
  readonly effectiveEnd: Date;
  readonly startLocal: CivilDate;
  readonly endLocalInclusive: CivilDate;
  readonly localDays: number;
  readonly buckets: readonly BucketBounds[];
}

export interface ResolvedPeriod {
  readonly range: ReportRange;
  readonly timezone: string;
  readonly calendar: Calendar;
  readonly granularity: ReportGranularity;
  readonly current: PeriodSide;
  readonly previous: PeriodSide;
  readonly lengthsDiffer: boolean;
  readonly now: Date;
}

export interface ReportPeriodResolver {
  resolve(
    input: {
      readonly range: ReportRange;
      readonly from?: string;
      readonly to?: string;
      readonly granularity?: ReportGranularity;
    },
    now: Date,
    presentation: { readonly timezone: string; readonly calendar: Calendar },
  ): ResolvedPeriod;
  /** `1405/07/03`, or with `-` for a file name. Latin digits, tenant calendar. */
  formatLocalDate(date: CivilDate, separator?: string): string;
  /** The tenant-calendar date and time of an instant, for an export's display column. */
  formatLocalDateTime(
    at: Date,
    presentation: { readonly timezone: string; readonly calendar: Calendar },
  ): string;
}

/** A half-open instant interval every repository method is bounded by. */
export interface Window {
  readonly from: Date;
  readonly to: Date;
}

// --- Aggregates -----------------------------------------------------------------

export interface CurrencyAmount {
  readonly currency: CurrencyCode;
  readonly amount: bigint;
}

export interface SalesTotals {
  readonly sales: number;
  readonly successfulOrders: number;
  readonly renewals: number;
  readonly revenue: readonly CurrencyAmount[];
  readonly gross: readonly CurrencyAmount[];
  readonly discount: readonly CurrencyAmount[];
}

export interface CountedAmount extends CurrencyAmount {
  readonly entries: number;
}

export interface ProductRankRow {
  readonly productId: string;
  readonly title: string;
  readonly categoryName: string | null;
  readonly categoryEmoji: string | null;
  readonly productStatus: string | null;
  readonly orders: number;
  readonly quantity: number;
  readonly revenue: bigint;
  readonly currency: CurrencyCode;
}

export interface PurposeFigures {
  readonly purpose: OrderPurpose;
  readonly orders: number;
  readonly revenue: readonly CurrencyAmount[];
}

export interface TrafficSold {
  readonly bytes: bigint;
  readonly unlimitedLines: number;
}

export interface InfrastructureFigures {
  readonly servicesCreated: number;
  readonly activeServices: number;
  readonly trafficSoldBytes: bigint;
  readonly unlimitedTrafficLines: number;
  readonly provisioningFailures: number;
}

export interface PanelFigures extends InfrastructureFigures {
  readonly panelId: string;
  readonly panelName: string;
  readonly providerType: string;
}

export interface ProviderFigures extends InfrastructureFigures {
  readonly providerType: string;
}

export interface PaymentGroupRow {
  readonly method: PaymentMethod;
  readonly provider: string | null;
  readonly kind: ReportPaymentKind;
  readonly counts: Readonly<Record<PaymentState, number>>;
  readonly confirmedAmount: readonly CurrencyAmount[];
}

export interface WalletReasonRow {
  readonly reason: LedgerReason;
  readonly direction: LedgerDirection;
  readonly currency: CurrencyCode;
  readonly entries: number;
  readonly amount: bigint;
}

export interface ReferrerRow {
  readonly referrerId: string;
  readonly signups: number;
  readonly convertedBuyers: number;
  readonly revenue: readonly CurrencyAmount[];
  readonly commission: readonly CurrencyAmount[];
}

export interface ResellerRow {
  readonly resellerCustomerId: string;
  readonly tierName: string;
  readonly status: string;
  readonly orders: number;
  readonly sales: readonly CurrencyAmount[];
  readonly services: number;
  /** The reseller's own limit, or null for the tier's. */
  readonly ownLimit: CurrencyAmount | null;
  readonly tierLimit: CurrencyAmount;
  /**
   * The reseller's derived balance, now, in the currency it SELLS in — the only currency a
   * debit is written in, so the only one a debt can stand in (`creditStateOf`).
   */
  readonly balanceInSellingCurrency: bigint;
}

export interface FailureGroupRow {
  readonly type: OperationType;
  readonly state: OperationState;
  readonly failureKind: string | null;
  readonly count: number;
}

export interface FailureTotals {
  readonly payments: {
    readonly failed: number;
    readonly cancelled: number;
    readonly expired: number;
  };
  readonly paymentsUnknownNow: number;
  readonly operations: readonly FailureGroupRow[];
  readonly operationsUnknownNow: number;
  readonly ordersRefunded: number;
}

export interface KeysetPosition {
  /** Microsecond-precision ISO text, as `keyset-cursor.ts` issues it. */
  readonly at: string;
  readonly id: string;
}

export interface OrderRow {
  readonly orderId: string;
  readonly settledAt: Date;
  readonly settledAtText: string;
  readonly purpose: OrderPurpose;
  readonly title: string;
  readonly categoryName: string | null;
  readonly subtotal: bigint;
  readonly discount: bigint;
  readonly total: bigint;
  readonly currency: CurrencyCode;
  readonly paymentMethod: PaymentMethod | null;
  readonly paymentProvider: string | null;
  readonly customerId: string;
}

export interface PaymentAttemptRow {
  readonly paymentId: string;
  readonly reference: string;
  readonly createdAt: Date;
  readonly createdAtText: string;
  readonly method: PaymentMethod;
  readonly provider: string | null;
  readonly kind: ReportPaymentKind;
  readonly state: PaymentState;
  readonly amount: bigint;
  readonly currency: CurrencyCode;
  readonly orderId: string | null;
}

export interface OperationRow {
  readonly operationId: string;
  readonly serviceId: string;
  readonly orderId: string | null;
  readonly panelId: string;
  readonly panelName: string | null;
  readonly type: OperationType;
  readonly state: OperationState;
  readonly failureKind: string | null;
  readonly completedAt: Date;
  readonly completedAtText: string;
}

export interface Page<T> {
  readonly rows: readonly T[];
  readonly next: KeysetPosition | null;
}

export interface Ranked<T> {
  readonly rows: readonly T[];
  readonly totalRows: number;
}

/**
 * The aggregates. Each method takes the tenant FIRST and a half-open window, and runs one
 * statement. Money is bigint minor units with its currency, never summed across currencies.
 */
export interface ReportingRepository {
  salesTotals(scope: TenantContext, window: Window): Promise<SalesTotals>;
  newCustomers(scope: TenantContext, window: Window): Promise<number>;
  newBuyers(scope: TenantContext, window: Window): Promise<number>;
  newServices(scope: TenantContext, window: Window): Promise<{ paid: number; trial: number }>;
  topups(scope: TenantContext, window: Window): Promise<readonly CountedAmount[]>;
  activeServices(scope: TenantContext): Promise<number>;
  activeCustomers(scope: TenantContext, purchasedSince: Date, now: Date): Promise<number>;

  /** One series: bucket index → exact value, from `width_bucket` over `boundaries`. */
  trend(
    scope: TenantContext,
    metric: ReportTrendMetric,
    currency: CurrencyCode | null,
    boundaries: readonly Date[],
  ): Promise<ReadonlyMap<number, bigint>>;
  revenueCurrencies(
    scope: TenantContext,
    windows: readonly Window[],
  ): Promise<readonly CurrencyCode[]>;

  productRanking(
    scope: TenantContext,
    window: Window,
    by: ReportProductRanking,
    preferredCurrency: CurrencyCode,
    limit: number,
    offset: number,
  ): Promise<Ranked<ProductRankRow>>;

  serviceStates(scope: TenantContext): Promise<ReadonlyMap<ServiceState, number>>;
  purposeFigures(
    scope: TenantContext,
    window: Window,
    purposes: readonly OrderPurpose[],
  ): Promise<readonly PurposeFigures[]>;
  trafficSold(scope: TenantContext, window: Window): Promise<TrafficSold>;

  panelFigures(
    scope: TenantContext,
    window: Window,
    limit: number,
  ): Promise<{
    readonly panels: readonly PanelFigures[];
    readonly providers: readonly ProviderFigures[];
  }>;

  paymentGroups(scope: TenantContext, window: Window): Promise<readonly PaymentGroupRow[]>;

  walletReasons(scope: TenantContext, window: Window): Promise<readonly WalletReasonRow[]>;
  walletBalances(scope: TenantContext): Promise<readonly CurrencyAmount[]>;

  referralSignups(
    scope: TenantContext,
    window: Window,
  ): Promise<{ signups: number; converted: number }>;
  referredSales(
    scope: TenantContext,
    window: Window,
  ): Promise<{ readonly sales: number; readonly revenue: readonly CurrencyAmount[] }>;
  topReferrers(
    scope: TenantContext,
    window: Window,
    by: ReportReferrerRanking,
    rankingCurrency: CurrencyCode,
    limit: number,
    offset: number,
  ): Promise<Ranked<ReferrerRow>>;

  resellers(
    scope: TenantContext,
    window: Window,
    sellingCurrency: CurrencyCode,
    limit: number,
  ): Promise<readonly ResellerRow[]>;

  failures(scope: TenantContext, window: Window): Promise<FailureTotals>;
  /**
   * The payment half of `failures`: attempts resolved FAILED, CANCELLED or EXPIRED in the
   * window. One statement, shared by the failure report and the dashboard, so the two
   * cannot count a failed payment differently.
   */
  paymentFailures(scope: TenantContext, window: Window): Promise<FailureTotals['payments']>;

  /**
   * The `sales.count` rows by bucket AND purpose: bucket index → purpose → count, from
   * `width_bucket` over `boundaries`, the same way `trend` buckets. The dashboard folds the
   * purposes into `dashboardSaleKindOf`; the SQL knows nothing about kinds.
   */
  salesTrendByPurpose(
    scope: TenantContext,
    boundaries: readonly Date[],
  ): Promise<ReadonlyMap<number, ReadonlyMap<OrderPurpose, number>>>;

  /**
   * PAID orders settled in the window, newest first. `purposes` narrows to a set — the
   * SALES export passes `SALE_ORDER_PURPOSES`, because a trial is a successful order and
   * never a sale; the drill-down leaves it unset and shows every successful order.
   */
  orders(
    scope: TenantContext,
    window: Window,
    filter: {
      readonly purpose?: OrderPurpose;
      readonly purposes?: readonly OrderPurpose[];
      readonly productId?: string;
    },
    limit: number,
    after: KeysetPosition | null,
  ): Promise<Page<OrderRow>>;
  paymentAttempts(
    scope: TenantContext,
    window: Window,
    filter: {
      readonly method?: PaymentMethod;
      readonly provider?: string;
      readonly kind?: ReportPaymentKind;
      readonly state?: PaymentState;
    },
    limit: number,
    after: KeysetPosition | null,
  ): Promise<Page<PaymentAttemptRow>>;
  failedOperations(
    scope: TenantContext,
    window: Window,
    group: ReportOperationGroup | undefined,
    limit: number,
    after: KeysetPosition | null,
  ): Promise<Page<OperationRow>>;

  // --- Phase E2: the financial statement (`docs/financial-reports.md`) -------------
  //
  // Each is ONE statement bucketed by `width_bucket` over `boundaries`, the way `trend`
  // buckets, so a row lands in exactly one bucket and the period is the buckets' union.

  /** `finance.sales`: settled orders (PAID or REFUNDED) of a sale purpose, by `settled_at`. */
  financialSales(
    scope: TenantContext,
    boundaries: readonly Date[],
  ): Promise<readonly FinancialSalesRow[]>;
  /** `finance.refunds`: COMPLETED refunds by `completed_at`, per channel. */
  financialRefunds(
    scope: TenantContext,
    boundaries: readonly Date[],
  ): Promise<readonly FinancialRefundRow[]>;
  /** `finance.customer_paid`: CONFIRMED non-wallet payments by `confirmed_at`, per route and kind. */
  financialCash(
    scope: TenantContext,
    boundaries: readonly Date[],
  ): Promise<readonly FinancialCashRow[]>;
  /** The ledger by bucket, reason and direction, by `created_at`. */
  financialLedger(
    scope: TenantContext,
    boundaries: readonly Date[],
  ): Promise<readonly FinancialLedgerRow[]>;
  /** Σ signed ledger entries strictly before `at`, per currency: the liability at that instant. */
  walletBalancesBefore(scope: TenantContext, at: Date): Promise<readonly CurrencyAmount[]>;
  /** `finance.sales_by_channel` over the window. */
  financialSalesByChannel(
    scope: TenantContext,
    window: Window,
  ): Promise<readonly FinancialChannelRow[]>;
  /** `finance.sales_by_product` over the window, at most `limit` rows (sales desc). */
  financialByProduct(
    scope: TenantContext,
    window: Window,
    limit: number,
  ): Promise<{ readonly rows: readonly FinancialProductRow[]; readonly truncated: boolean }>;
  /** `finance.reseller_sales` over the window. */
  financialResellerSales(scope: TenantContext, window: Window): Promise<readonly CountedAmount[]>;
}

export interface FinancialSalesRow {
  readonly bucket: number;
  readonly currency: CurrencyCode;
  readonly count: number;
  readonly gross: bigint;
  readonly discount: bigint;
  readonly total: bigint;
}

export interface FinancialRefundRow {
  readonly bucket: number;
  readonly currency: CurrencyCode;
  readonly channel: RefundChannel;
  readonly count: number;
  readonly amount: bigint;
}

export interface FinancialCashRow {
  readonly bucket: number;
  readonly currency: CurrencyCode;
  readonly method: PaymentMethod;
  readonly provider: string | null;
  readonly kind: ReportPaymentKind;
  readonly count: number;
  readonly principal: bigint;
  readonly fee: bigint;
  readonly payable: bigint;
}

export interface FinancialLedgerRow {
  readonly bucket: number;
  readonly currency: CurrencyCode;
  readonly reason: LedgerReason;
  readonly direction: LedgerDirection;
  readonly count: number;
  readonly amount: bigint;
}

export interface FinancialChannelRow {
  readonly method: PaymentMethod | null;
  readonly provider: string | null;
  readonly currency: CurrencyCode;
  readonly orders: number;
  readonly sales: bigint;
}

export interface FinancialProductRow {
  readonly productId: string;
  readonly title: string;
  readonly currency: CurrencyCode;
  readonly orders: number;
  readonly sales: bigint;
  readonly refunds: bigint;
}

// --- Authority and presentation -------------------------------------------------

/** The one read the Super Admin rule needs beyond the guard: an administrator's role keys. */
export interface AdminRoleReader {
  roleKeysFor(scope: ScopeContext, id: AdminId): Promise<string[]>;
}

export interface ReportPresentationReader {
  presentationFor(
    scope: ScopeContext,
  ): Promise<{ readonly timezone: string; readonly calendar: Calendar }>;
}

export interface SalesCurrencyReader {
  salesCurrency(scope: TenantContext): Promise<CurrencyCode>;
}

// --- Export ---------------------------------------------------------------------

/** `number` is written as a numeric cell (counts, bytes, a percentage); `money` scales by its currency. */
export type ExportCellKind = 'text' | 'number' | 'money';

/**
 * Every column an export may carry. Declared here, as data, so that the writer — which
 * binds each key to its Persian header from `@nexa/i18n` — can be held to the full list by a
 * test: a key with no header is a blank column heading, and nothing else would notice.
 */
export const REPORT_EXPORT_COLUMN_KEYS = [
  'rank',
  'orderId',
  'settledAtLocal',
  'settledAtUtc',
  'purpose',
  'title',
  'category',
  'productId',
  'productStatus',
  'subtotal',
  'discount',
  'total',
  'revenue',
  'currency',
  'paymentMethod',
  'paymentRoute',
  'customerId',
  'orders',
  'quantity',
  'method',
  'route',
  'kind',
  'attempts',
  'confirmed',
  'failed',
  'cancelled',
  'expired',
  'pending',
  'unknown',
  'successRatePercent',
  'confirmedAmount',
  'reason',
  'group',
  'direction',
  'entries',
  'amount',
  'panelName',
  'providerType',
  'servicesCreated',
  'activeServices',
  'trafficSoldBytes',
  'unlimitedTrafficLines',
  'provisioningFailures',
  'referrerId',
  'signups',
  'convertedBuyers',
  'commission',
  'resellerCustomerId',
  'tierName',
  'status',
  'sales',
  'services',
  'creditInUse',
  // Phase E2: the financial statement.
  'bucket',
  'bucketStartUtc',
  'bucketEndUtc',
  'salesCount',
  'grossSales',
  'discounts',
  'refundCount',
  'refunds',
  'refundsToWallet',
  'refundsPaidOut',
  'netSales',
  'externalPayments',
  'principalReceived',
  'customerFees',
  'customerPaid',
  'receiptCredits',
  'walletTopups',
  'walletSpending',
  'cashbackNet',
  'commissionNet',
  'gifts',
] as const;
export type ExportColumnKey = (typeof REPORT_EXPORT_COLUMN_KEYS)[number];

export interface ExportColumn {
  readonly key: ExportColumnKey;
  readonly kind: ExportCellKind;
}

/** A money cell carries its currency, so its exponent comes from the value. */
export type ExportCell =
  | string
  | number
  | bigint
  | null
  | { readonly amountMinor: bigint; readonly currency: CurrencyCode };

/** What to write. Headers and the sheet name are bound by the writer, from the catalogue. */
export interface ExportTable {
  readonly report: ReportExportKind;
  readonly columns: readonly ExportColumn[];
  readonly rows: readonly Readonly<Record<string, ExportCell>>[];
}

export interface ReportExportWriter {
  csv(table: ExportTable): Uint8Array;
  xlsx(table: ExportTable): Uint8Array;
}
