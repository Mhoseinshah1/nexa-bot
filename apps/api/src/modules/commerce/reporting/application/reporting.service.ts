import {
  CONTROL_ERROR_CODES,
  PAYMENT_STATES,
  REPORT_COMMERCIAL_OPERATION_TYPES,
  REPORT_DRILLDOWN_PAGE_DEFAULT,
  REPORT_ENTITY_ROWS_MAX,
  REPORT_EXPORT_ROW_MAX,
  REPORT_FAILED_PAYMENT_STATES,
  REPORT_RANKING_DEPTH_MAX,
  REPORT_RANKING_TOP,
  SERVICE_STATES,
  WALLET_REPORT_GROUP_OF,
  errors,
  type ActorContext,
  type Clock,
  type CountComparison,
  type CurrencyCode,
  type MoneyComparison,
  type OrderPurpose,
  type PaymentMethod,
  type PaymentState,
  type ReportExportFormat,
  type ReportExportKind,
  type ReportFailuresResponse,
  type ReportInfrastructureResponse,
  type ReportOperationGroup,
  type ReportOperationsResponse,
  type ReportOrdersResponse,
  type ReportPaymentAttemptsResponse,
  type ReportPaymentKind,
  type ReportPaymentsResponse,
  type ReportPeriodResponse,
  type ReportProductRanking,
  type ReportProductsResponse,
  type ReportRange,
  type ReportReferralsResponse,
  type ReportReferrerRanking,
  type ReportResellersResponse,
  type ReportServicesResponse,
  type ReportSummaryResponse,
  type ReportTrendMetric,
  type ReportTrendResponse,
  type ReportWalletResponse,
  type TenantContext,
  type WalletReportGroup,
} from '@nexa/contracts';
import {
  REPORTS_EXPORT_PERMISSION,
  REPORTS_VIEW_PERMISSION,
  type ReportAccess,
} from './report-access.js';
import type {
  BucketBounds,
  CountedAmount,
  CurrencyAmount,
  ExportCell,
  ExportCellKind,
  ExportColumnKey,
  ExportTable,
  KeysetPosition,
  OrderRow,
  PeriodSide,
  ReportExportWriter,
  ReportPeriodResolver,
  ReportPresentationReader,
  ReportingRepository,
  ResolvedPeriod,
  SalesCurrencyReader,
  Window,
} from './ports.js';

const DAY_MS = 86_400_000;

/** A customer counts as active on a purchase this recent (spec §4.5). */
export const ACTIVE_CUSTOMER_PURCHASE_WINDOW_MS = 30 * DAY_MS;

export interface ReportRangeRequest {
  readonly range: ReportRange;
  readonly from?: string;
  readonly to?: string;
}

export interface ReportingServiceDeps {
  readonly access: ReportAccess;
  readonly repository: ReportingRepository;
  readonly periods: ReportPeriodResolver;
  readonly presentation: ReportPresentationReader;
  readonly salesCurrency: SalesCurrencyReader;
  readonly writer: ReportExportWriter;
  readonly clock: Clock;
}

export interface ReportExportFile {
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

interface Resolved {
  readonly period: ResolvedPeriod;
  readonly wire: ReportPeriodResponse;
  /** Where the current period's figures run: `[start, effectiveEnd)`. */
  readonly current: Window;
  readonly previous: Window;
}

/**
 * WP12's business reports (`docs/wp12-business-analytics-audit.md`).
 *
 * Read-only. Every method authorizes FIRST — the Super Admin rule, through `ReportAccess`
 * — then resolves the period in the tenant's own zone and calendar, then asks the
 * repository for grouped aggregates. The service never sums raw rows: what it adds up is
 * already-grouped figures (per state, per currency), which is arithmetic on a handful of
 * numbers, not an aggregation the database should have done.
 */
export class ReportingService {
  constructor(private readonly deps: ReportingServiceDeps) {}

  async summary(
    scope: TenantContext,
    actor: ActorContext,
    request: ReportRangeRequest,
  ): Promise<ReportSummaryResponse> {
    const r = await this.prepare(scope, actor, request, REPORTS_VIEW_PERMISSION);
    const repo = this.deps.repository;
    const side = async (window: Window) => ({
      sales: await repo.salesTotals(scope, window),
      newUsers: await repo.newCustomers(scope, window),
      newBuyers: await repo.newBuyers(scope, window),
      services: await repo.newServices(scope, window),
      topups: await repo.topups(scope, window),
    });
    const current = await side(r.current);
    const previous = await side(r.previous);
    const now = r.period.now;
    return {
      period: r.wire,
      sales: pair(current.sales.sales, previous.sales.sales),
      revenue: moneyPair(current.sales.revenue, previous.sales.revenue),
      grossValue: moneyPair(current.sales.gross, previous.sales.gross),
      discount: moneyPair(current.sales.discount, previous.sales.discount),
      successfulOrders: pair(current.sales.successfulOrders, previous.sales.successfulOrders),
      newUsers: pair(current.newUsers, previous.newUsers),
      newBuyers: pair(current.newBuyers, previous.newBuyers),
      newServices: pair(current.services.paid, previous.services.paid),
      newTrialServices: pair(current.services.trial, previous.services.trial),
      renewals: pair(current.sales.renewals, previous.sales.renewals),
      walletTopupCount: pair(entriesOf(current.topups), entriesOf(previous.topups)),
      walletTopup: moneyPair(current.topups, previous.topups),
      activeServices: await repo.activeServices(scope),
      activeCustomers: await repo.activeCustomers(
        scope,
        new Date(now.getTime() - ACTIVE_CUSTOMER_PURCHASE_WINDOW_MS),
        now,
      ),
    };
  }

  async trend(
    scope: TenantContext,
    actor: ActorContext,
    request: ReportRangeRequest,
    metric: ReportTrendMetric,
    currency?: CurrencyCode,
  ): Promise<ReportTrendResponse> {
    const r = await this.prepare(scope, actor, request, REPORTS_VIEW_PERMISSION);
    const repo = this.deps.repository;
    const money = metric === 'REVENUE';
    const chosen = money
      ? (currency ?? (await this.deps.salesCurrency.salesCurrency(scope)))
      : null;
    const series = async (side: PeriodSide) => {
      const values = await repo.trend(scope, metric, chosen, boundariesOf(side.buckets));
      return side.buckets.map((bucket) => ({
        index: bucket.index,
        start: bucket.start.toISOString(),
        end: bucket.end.toISOString(),
        label: bucket.label,
        // A bucket that has not begun is unknown, never zero: the chart must not draw a
        // collapse for hours that have not happened yet.
        value:
          bucket.start.getTime() >= r.period.now.getTime()
            ? null
            : (values.get(bucket.index) ?? 0n).toString(),
      }));
    };
    return {
      period: r.wire,
      metric,
      currency: chosen,
      currencies: money
        ? [
            ...(await repo.revenueCurrencies(scope, [
              { from: r.period.current.start, to: r.period.current.end },
              { from: r.period.previous.start, to: r.period.previous.end },
            ])),
          ]
        : [],
      current: await series(r.period.current),
      previous: await series(r.period.previous),
    };
  }

  async products(
    scope: TenantContext,
    actor: ActorContext,
    request: ReportRangeRequest,
    by: ReportProductRanking,
    paging: { readonly limit?: number; readonly page?: number },
  ): Promise<ReportProductsResponse> {
    const r = await this.prepare(scope, actor, request, REPORTS_VIEW_PERMISSION);
    const { limit, page, offset } = rankingPage(paging);
    const ranked = await this.deps.repository.productRanking(
      scope,
      r.current,
      by,
      await this.deps.salesCurrency.salesCurrency(scope),
      limit,
      offset,
    );
    return {
      period: r.wire,
      by,
      page,
      limit,
      totalRows: ranked.totalRows,
      rows: ranked.rows.map((row, i) => ({
        rank: offset + i + 1,
        productId: row.productId,
        title: row.title,
        categoryName: row.categoryName,
        categoryEmoji: row.categoryEmoji,
        productStatus: row.productStatus,
        orders: row.orders,
        quantity: row.quantity,
        revenue: row.revenue.toString(),
        currency: row.currency,
      })),
    };
  }

  async services(
    scope: TenantContext,
    actor: ActorContext,
    request: ReportRangeRequest,
  ): Promise<ReportServicesResponse> {
    const r = await this.prepare(scope, actor, request, REPORTS_VIEW_PERMISSION);
    const repo = this.deps.repository;
    const created = await repo.newServices(scope, r.current);
    const createdBefore = await repo.newServices(scope, r.previous);
    const states = await repo.serviceStates(scope);
    const purposes: readonly OrderPurpose[] = REPORT_COMMERCIAL_OPERATION_TYPES;
    const now = await repo.purposeFigures(scope, r.current, purposes);
    const before = await repo.purposeFigures(scope, r.previous, purposes);
    const traffic = await repo.trafficSold(scope, r.current);
    return {
      period: r.wire,
      newServices: pair(created.paid, createdBefore.paid),
      newTrialServices: pair(created.trial, createdBefore.trial),
      activeServices: states.get('ACTIVE') ?? 0,
      states: SERVICE_STATES.map((state) => ({ state, count: states.get(state) ?? 0 })),
      operations: purposes.map((purpose) => {
        const a = now.find((row) => row.purpose === purpose);
        const b = before.find((row) => row.purpose === purpose);
        return {
          purpose,
          orders: pair(a?.orders ?? 0, b?.orders ?? 0),
          revenue: moneyPair(a?.revenue ?? [], b?.revenue ?? []),
        };
      }),
      trafficSoldBytes: traffic.bytes.toString(),
      unlimitedTrafficLines: traffic.unlimitedLines,
    };
  }

  async infrastructure(
    scope: TenantContext,
    actor: ActorContext,
    request: ReportRangeRequest,
  ): Promise<ReportInfrastructureResponse> {
    const r = await this.prepare(scope, actor, request, REPORTS_VIEW_PERMISSION);
    const figures = await this.deps.repository.panelFigures(
      scope,
      r.current,
      REPORT_ENTITY_ROWS_MAX + 1,
    );
    const figuresOf = (row: {
      servicesCreated: number;
      activeServices: number;
      trafficSoldBytes: bigint;
      unlimitedTrafficLines: number;
      provisioningFailures: number;
    }) => ({
      servicesCreated: row.servicesCreated,
      activeServices: row.activeServices,
      trafficSoldBytes: row.trafficSoldBytes.toString(),
      unlimitedTrafficLines: row.unlimitedTrafficLines,
      provisioningFailures: row.provisioningFailures,
    });
    return {
      period: r.wire,
      panels: figures.panels.slice(0, REPORT_ENTITY_ROWS_MAX).map((row) => ({
        panelId: row.panelId,
        panelName: row.panelName,
        providerType: row.providerType,
        ...figuresOf(row),
      })),
      providers: figures.providers.map((row) => ({
        providerType: row.providerType,
        ...figuresOf(row),
      })),
      truncated: figures.panels.length > REPORT_ENTITY_ROWS_MAX,
      locationSupported: false,
    };
  }

  async payments(
    scope: TenantContext,
    actor: ActorContext,
    request: ReportRangeRequest,
  ): Promise<ReportPaymentsResponse> {
    const r = await this.prepare(scope, actor, request, REPORTS_VIEW_PERMISSION);
    const groups = await this.deps.repository.paymentGroups(scope, r.current);
    const totals = zeroCounts();
    const totalAmounts: CurrencyAmount[] = [];
    for (const group of groups) {
      for (const state of PAYMENT_STATES) totals[state] += group.counts[state];
      addAmounts(totalAmounts, group.confirmedAmount);
    }
    return {
      period: r.wire,
      rows: groups.map((group) => ({
        method: group.method,
        provider: group.provider,
        kind: group.kind,
        ...paymentFigures(group.counts, group.confirmedAmount),
      })),
      totals: paymentFigures(totals, totalAmounts),
    };
  }

  async wallet(
    scope: TenantContext,
    actor: ActorContext,
    request: ReportRangeRequest,
  ): Promise<ReportWalletResponse> {
    const r = await this.prepare(scope, actor, request, REPORTS_VIEW_PERMISSION);
    const reasons = await this.deps.repository.walletReasons(scope, r.current);
    const groups = new Map<
      string,
      { group: WalletReportGroup; currency: CurrencyCode; entries: number; amount: bigint }
    >();
    for (const row of reasons) {
      const group = WALLET_REPORT_GROUP_OF[row.reason];
      const key = `${group}|${row.currency}`;
      const found = groups.get(key) ?? { group, currency: row.currency, entries: 0, amount: 0n };
      // A group can hold both directions (ADMINISTRATIVE); its total is signed like the
      // ledger's own balance, so a debit is never added to a credit total (RSV2-BR-019).
      found.entries += row.entries;
      found.amount += row.direction === 'CREDIT' ? row.amount : -row.amount;
      groups.set(key, found);
    }
    const balances = await this.deps.repository.walletBalances(scope);
    return {
      period: r.wire,
      reasons: reasons.map((row) => ({
        reason: row.reason,
        direction: row.direction,
        group: WALLET_REPORT_GROUP_OF[row.reason],
        currency: row.currency,
        entries: row.entries,
        amount: row.amount.toString(),
      })),
      groups: [...groups.values()].map((g) => ({
        group: g.group,
        currency: g.currency,
        entries: g.entries,
        amount: g.amount.toString(),
      })),
      balances: balances.map(toMoneyTotal),
    };
  }

  async referrals(
    scope: TenantContext,
    actor: ActorContext,
    request: ReportRangeRequest,
    by: ReportReferrerRanking,
    paging: { readonly limit?: number; readonly page?: number },
  ): Promise<ReportReferralsResponse> {
    const r = await this.prepare(scope, actor, request, REPORTS_VIEW_PERMISSION);
    const repo = this.deps.repository;
    const current = await repo.referralSignups(scope, r.current);
    const previous = await repo.referralSignups(scope, r.previous);
    const reasons = await repo.walletReasons(scope, r.current);
    const reward = (reason: string): CountedAmount[] =>
      reasons
        .filter((row) => row.reason === reason)
        .map((row) => ({ currency: row.currency, amount: row.amount, entries: row.entries }));
    const referred = await repo.referredSales(scope, r.current);
    const rankingCurrency = await this.deps.salesCurrency.salesCurrency(scope);
    const { limit, page, offset } = rankingPage(paging);
    const top = await repo.topReferrers(scope, r.current, by, rankingCurrency, limit, offset);
    return {
      period: r.wire,
      signups: pair(current.signups, previous.signups),
      convertedBuyers: current.converted,
      conversionBasisPoints: basisPoints(current.converted, current.signups),
      signupGifts: reward('REFERRAL_SIGNUP_GIFT').map(toMoneyCount),
      commissions: reward('REFERRAL_COMMISSION').map(toMoneyCount),
      commissionReversals: reward('REFERRAL_COMMISSION_REVERSAL').map(toMoneyCount),
      referredSales: referred.sales,
      referredRevenue: referred.revenue.map(toMoneyTotal),
      topReferrers: {
        by,
        rankingCurrency,
        page,
        limit,
        totalRows: top.totalRows,
        rows: top.rows.map((row, i) => ({
          rank: offset + i + 1,
          referrerId: row.referrerId,
          signups: row.signups,
          convertedBuyers: row.convertedBuyers,
          revenue: row.revenue.map(toMoneyTotal),
          commission: row.commission.map(toMoneyTotal),
        })),
      },
    };
  }

  async resellers(
    scope: TenantContext,
    actor: ActorContext,
    request: ReportRangeRequest,
  ): Promise<ReportResellersResponse> {
    const r = await this.prepare(scope, actor, request, REPORTS_VIEW_PERMISSION);
    const rows = await this.deps.repository.resellers(scope, r.current, REPORT_ENTITY_ROWS_MAX + 1);
    return {
      period: r.wire,
      truncated: rows.length > REPORT_ENTITY_ROWS_MAX,
      rows: rows.slice(0, REPORT_ENTITY_ROWS_MAX).map((row) => ({
        resellerCustomerId: row.resellerCustomerId,
        tierName: row.tierName,
        status: row.status,
        orders: row.orders,
        sales: row.sales.map(toMoneyTotal),
        services: row.services,
        creditLimit:
          row.creditLimit === null
            ? null
            : {
                amountMinor: row.creditLimit.amount.toString(),
                currency: row.creditLimit.currency,
              },
        creditInUse:
          row.creditLimit === null || row.balanceInLimitCurrency === null
            ? null
            : {
                // `canCover`'s own rule, read the other way: credit in use is how far below
                // zero the wallet stands. A positive balance uses none of it.
                amountMinor: (row.balanceInLimitCurrency < 0n
                  ? -row.balanceInLimitCurrency
                  : 0n
                ).toString(),
                currency: row.creditLimit.currency,
              },
      })),
    };
  }

  async failures(
    scope: TenantContext,
    actor: ActorContext,
    request: ReportRangeRequest,
  ): Promise<ReportFailuresResponse> {
    const r = await this.prepare(scope, actor, request, REPORTS_VIEW_PERMISSION);
    const totals = await this.deps.repository.failures(scope, r.current);
    const commercial = new Set<string>(REPORT_COMMERCIAL_OPERATION_TYPES);
    const sum = (predicate: (type: string, state: string) => boolean): number =>
      totals.operations
        .filter((row) => predicate(row.type, row.state))
        .reduce((total, row) => total + row.count, 0);
    const byKind = new Map<string | null, number>();
    for (const row of totals.operations) {
      byKind.set(row.failureKind, (byKind.get(row.failureKind) ?? 0) + row.count);
    }
    return {
      period: r.wire,
      payments: { ...totals.payments, unknownNow: totals.paymentsUnknownNow },
      provisioning: {
        failed: sum((type, state) => type === 'PROVISION' && state === 'FAILED'),
        abandoned: sum((type, state) => type === 'PROVISION' && state === 'ABANDONED'),
      },
      commercialOperations: {
        failed: sum((type, state) => commercial.has(type) && state === 'FAILED'),
        abandoned: sum((type, state) => commercial.has(type) && state === 'ABANDONED'),
      },
      operationsUnknownNow: totals.operationsUnknownNow,
      byFailureKind: [...byKind.entries()]
        .map(([failureKind, count]) => ({ failureKind, count }))
        .sort(
          (a, b) => b.count - a.count || String(a.failureKind).localeCompare(String(b.failureKind)),
        ),
      ordersRefunded: totals.ordersRefunded,
    };
  }

  // --- Drill-down ---------------------------------------------------------------

  async orders(
    scope: TenantContext,
    actor: ActorContext,
    request: ReportRangeRequest,
    query: {
      readonly purpose?: OrderPurpose;
      readonly productId?: string;
      readonly limit?: number;
      readonly after?: KeysetPosition;
    },
  ): Promise<{
    readonly response: Omit<ReportOrdersResponse, 'nextCursor'>;
    readonly next: KeysetPosition | null;
  }> {
    const r = await this.prepare(scope, actor, request, REPORTS_VIEW_PERMISSION);
    const page = await this.deps.repository.orders(
      scope,
      r.current,
      {
        ...(query.purpose === undefined ? {} : { purpose: query.purpose }),
        ...(query.productId === undefined ? {} : { productId: query.productId }),
      },
      query.limit ?? REPORT_DRILLDOWN_PAGE_DEFAULT,
      query.after ?? null,
    );
    return { response: { period: r.wire, rows: page.rows.map(toOrderWire) }, next: page.next };
  }

  async paymentAttempts(
    scope: TenantContext,
    actor: ActorContext,
    request: ReportRangeRequest,
    query: {
      readonly method?: PaymentMethod;
      readonly provider?: string;
      readonly kind?: ReportPaymentKind;
      readonly state?: PaymentState;
      readonly limit?: number;
      readonly after?: KeysetPosition;
    },
  ): Promise<{
    readonly response: Omit<ReportPaymentAttemptsResponse, 'nextCursor'>;
    readonly next: KeysetPosition | null;
  }> {
    const r = await this.prepare(scope, actor, request, REPORTS_VIEW_PERMISSION);
    const page = await this.deps.repository.paymentAttempts(
      scope,
      r.current,
      {
        ...(query.method === undefined ? {} : { method: query.method }),
        ...(query.provider === undefined ? {} : { provider: query.provider }),
        ...(query.kind === undefined ? {} : { kind: query.kind }),
        ...(query.state === undefined ? {} : { state: query.state }),
      },
      query.limit ?? REPORT_DRILLDOWN_PAGE_DEFAULT,
      query.after ?? null,
    );
    return {
      response: {
        period: r.wire,
        rows: page.rows.map((row) => ({
          paymentId: row.paymentId,
          reference: row.reference,
          createdAt: row.createdAt.toISOString(),
          method: row.method,
          provider: row.provider,
          kind: row.kind,
          state: row.state,
          amount: row.amount.toString(),
          currency: row.currency,
          orderId: row.orderId,
        })),
      },
      next: page.next,
    };
  }

  async operations(
    scope: TenantContext,
    actor: ActorContext,
    request: ReportRangeRequest,
    query: {
      readonly group?: ReportOperationGroup;
      readonly limit?: number;
      readonly after?: KeysetPosition;
    },
  ): Promise<{
    readonly response: Omit<ReportOperationsResponse, 'nextCursor'>;
    readonly next: KeysetPosition | null;
  }> {
    const r = await this.prepare(scope, actor, request, REPORTS_VIEW_PERMISSION);
    const page = await this.deps.repository.failedOperations(
      scope,
      r.current,
      query.group,
      query.limit ?? REPORT_DRILLDOWN_PAGE_DEFAULT,
      query.after ?? null,
    );
    return {
      response: {
        period: r.wire,
        rows: page.rows.map((row) => ({
          operationId: row.operationId,
          serviceId: row.serviceId,
          orderId: row.orderId,
          panelId: row.panelId,
          panelName: row.panelName,
          type: row.type,
          state: row.state,
          failureKind: row.failureKind,
          completedAt: row.completedAt.toISOString(),
        })),
      },
      next: page.next,
    };
  }

  // --- Export -------------------------------------------------------------------

  /**
   * One report, rendered to a file on the server (spec §19).
   *
   * Charged on `reports.export` and the owner role. Bounded: a result larger than
   * `REPORT_EXPORT_ROW_MAX` is REFUSED with a request to narrow the range, never cut short
   * — a truncated export is a file whose totals are wrong and nothing in it says so.
   */
  async export(
    scope: TenantContext,
    actor: ActorContext,
    request: ReportRangeRequest,
    report: ReportExportKind,
    format: ReportExportFormat,
  ): Promise<ReportExportFile> {
    const r = await this.prepare(scope, actor, request, REPORTS_EXPORT_PERMISSION);
    const presentation = { timezone: r.period.timezone, calendar: r.period.calendar };
    const table = await this.exportTable(scope, r, report, presentation);
    if (table.rows.length > REPORT_EXPORT_ROW_MAX) {
      throw errors.validation(
        CONTROL_ERROR_CODES.INVALID_VALUE,
        `This export has more than ${REPORT_EXPORT_ROW_MAX} rows. Choose a shorter range.`,
        { limit: REPORT_EXPORT_ROW_MAX },
      );
    }
    const bytes = format === 'csv' ? this.deps.writer.csv(table) : this.deps.writer.xlsx(table);
    return {
      fileName: `${exportFileStem(report, r, this.deps.periods)}.${format}`,
      contentType:
        format === 'csv'
          ? 'text/csv; charset=utf-8'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes,
    };
  }

  private async exportTable(
    scope: TenantContext,
    r: Resolved,
    report: ReportExportKind,
    presentation: { timezone: string; calendar: ResolvedPeriod['calendar'] },
  ): Promise<ExportTable> {
    const repo = this.deps.repository;
    const cap = REPORT_EXPORT_ROW_MAX + 1;
    const sheetName = report;
    switch (report) {
      case 'SALES': {
        const rows: OrderRow[] = [];
        let after: KeysetPosition | null = null;
        // Walked in pages so that no single statement is unbounded, and stopped one row
        // past the cap so an oversized export is refused rather than silently cut.
        do {
          const page = await repo.orders(scope, r.current, {}, 1_000, after);
          rows.push(...page.rows);
          after = page.next;
        } while (after !== null && rows.length < cap);
        return table(
          sheetName,
          [
            ['orderId', 'text'],
            ['settledAtLocal', 'text'],
            ['settledAtUtc', 'text'],
            ['purpose', 'text'],
            ['title', 'text'],
            ['category', 'text'],
            ['subtotal', 'money'],
            ['discount', 'money'],
            ['total', 'money'],
            ['currency', 'text'],
            ['paymentMethod', 'text'],
            ['paymentRoute', 'text'],
            ['customerId', 'text'],
          ],
          rows.map((row) => ({
            orderId: row.orderId,
            settledAtLocal: this.deps.periods.formatLocalDateTime(row.settledAt, presentation),
            settledAtUtc: row.settledAt.toISOString(),
            purpose: row.purpose,
            title: row.title,
            category: row.categoryName,
            subtotal: { amountMinor: row.subtotal, currency: row.currency },
            discount: { amountMinor: row.discount, currency: row.currency },
            total: { amountMinor: row.total, currency: row.currency },
            currency: row.currency,
            paymentMethod: row.paymentMethod,
            paymentRoute: row.paymentProvider,
            customerId: row.customerId,
          })),
        );
      }
      case 'PRODUCTS': {
        const ranked = await repo.productRanking(
          scope,
          r.current,
          'REVENUE',
          await this.deps.salesCurrency.salesCurrency(scope),
          cap,
          0,
        );
        return table(
          sheetName,
          [
            ['rank', 'number'],
            ['productId', 'text'],
            ['title', 'text'],
            ['category', 'text'],
            ['productStatus', 'text'],
            ['orders', 'number'],
            ['quantity', 'number'],
            ['revenue', 'money'],
            ['currency', 'text'],
          ],
          ranked.rows.map((row, i) => ({
            rank: i + 1,
            productId: row.productId,
            title: row.title,
            category: row.categoryName,
            productStatus: row.productStatus,
            orders: row.orders,
            quantity: row.quantity,
            revenue: { amountMinor: row.revenue, currency: row.currency },
            currency: row.currency,
          })),
        );
      }
      case 'PAYMENTS': {
        const groups = await repo.paymentGroups(scope, r.current);
        const out: Record<string, ExportCell>[] = [];
        for (const group of groups) {
          const figures = paymentFigures(group.counts, group.confirmedAmount);
          const amounts = group.confirmedAmount.length > 0 ? group.confirmedAmount : [null];
          for (const amount of amounts) {
            out.push({
              method: group.method,
              route: group.provider,
              kind: group.kind,
              attempts: figures.attempts,
              confirmed: figures.confirmed,
              failed: figures.failed,
              cancelled: figures.cancelled,
              expired: figures.expired,
              pending: figures.pending,
              unknown: figures.unknown,
              successRatePercent:
                figures.successRateBasisPoints === null
                  ? null
                  : figures.successRateBasisPoints / 100,
              confirmedAmount:
                amount === null ? null : { amountMinor: amount.amount, currency: amount.currency },
              currency: amount === null ? null : amount.currency,
            });
          }
        }
        return table(
          sheetName,
          [
            ['method', 'text'],
            ['route', 'text'],
            ['kind', 'text'],
            ['attempts', 'number'],
            ['confirmed', 'number'],
            ['failed', 'number'],
            ['cancelled', 'number'],
            ['expired', 'number'],
            ['pending', 'number'],
            ['unknown', 'number'],
            ['successRatePercent', 'number'],
            ['confirmedAmount', 'money'],
            ['currency', 'text'],
          ],
          out,
        );
      }
      case 'WALLET': {
        const reasons = await repo.walletReasons(scope, r.current);
        return table(
          sheetName,
          [
            ['reason', 'text'],
            ['group', 'text'],
            ['direction', 'text'],
            ['entries', 'number'],
            ['amount', 'money'],
            ['currency', 'text'],
          ],
          reasons.map((row) => ({
            reason: row.reason,
            group: WALLET_REPORT_GROUP_OF[row.reason],
            direction: row.direction,
            entries: row.entries,
            amount: { amountMinor: row.amount, currency: row.currency },
            currency: row.currency,
          })),
        );
      }
      case 'INFRASTRUCTURE': {
        const figures = await repo.panelFigures(scope, r.current, cap);
        return table(
          sheetName,
          [
            ['panelName', 'text'],
            ['providerType', 'text'],
            ['servicesCreated', 'number'],
            ['activeServices', 'number'],
            ['trafficSoldBytes', 'number'],
            ['unlimitedTrafficLines', 'number'],
            ['provisioningFailures', 'number'],
          ],
          figures.panels.map((row) => ({
            panelName: row.panelName,
            providerType: row.providerType,
            servicesCreated: row.servicesCreated,
            activeServices: row.activeServices,
            trafficSoldBytes: row.trafficSoldBytes,
            unlimitedTrafficLines: row.unlimitedTrafficLines,
            provisioningFailures: row.provisioningFailures,
          })),
        );
      }
      case 'REFERRALS': {
        const currency = await this.deps.salesCurrency.salesCurrency(scope);
        const top = await repo.topReferrers(scope, r.current, 'REVENUE', currency, cap, 0);
        const inCurrency = (amounts: readonly CurrencyAmount[]): bigint =>
          amounts.find((a) => a.currency === currency)?.amount ?? 0n;
        return table(
          sheetName,
          [
            ['rank', 'number'],
            ['referrerId', 'text'],
            ['signups', 'number'],
            ['convertedBuyers', 'number'],
            ['revenue', 'money'],
            ['commission', 'money'],
            ['currency', 'text'],
          ],
          top.rows.map((row, i) => ({
            rank: i + 1,
            referrerId: row.referrerId,
            signups: row.signups,
            convertedBuyers: row.convertedBuyers,
            revenue: { amountMinor: inCurrency(row.revenue), currency },
            commission: { amountMinor: inCurrency(row.commission), currency },
            currency,
          })),
        );
      }
      case 'RESELLERS': {
        const rows = await repo.resellers(scope, r.current, cap);
        const out: Record<string, ExportCell>[] = [];
        for (const row of rows) {
          const sales = row.sales.length > 0 ? row.sales : [null];
          for (const sale of sales) {
            const inUse =
              row.creditLimit === null || row.balanceInLimitCurrency === null
                ? null
                : row.balanceInLimitCurrency < 0n
                  ? -row.balanceInLimitCurrency
                  : 0n;
            out.push({
              resellerCustomerId: row.resellerCustomerId,
              tierName: row.tierName,
              status: row.status,
              orders: row.orders,
              sales: sale === null ? null : { amountMinor: sale.amount, currency: sale.currency },
              currency: sale === null ? null : sale.currency,
              services: row.services,
              creditLimit:
                row.creditLimit === null
                  ? null
                  : { amountMinor: row.creditLimit.amount, currency: row.creditLimit.currency },
              creditInUse:
                row.creditLimit === null || inUse === null
                  ? null
                  : { amountMinor: inUse, currency: row.creditLimit.currency },
            });
          }
        }
        return table(
          sheetName,
          [
            ['resellerCustomerId', 'text'],
            ['tierName', 'text'],
            ['status', 'text'],
            ['orders', 'number'],
            ['sales', 'money'],
            ['currency', 'text'],
            ['services', 'number'],
            ['creditLimit', 'money'],
            ['creditInUse', 'money'],
          ],
          out,
        );
      }
      default: {
        const unreachable: never = report;
        throw new Error(`unknown report ${String(unreachable)}`);
      }
    }
  }

  // --- Shared -------------------------------------------------------------------

  private async prepare(
    scope: TenantContext,
    actor: ActorContext,
    request: ReportRangeRequest,
    permission: typeof REPORTS_VIEW_PERMISSION,
  ): Promise<Resolved> {
    // Authority FIRST: a refused caller learns nothing, not even that its range was bad.
    await this.deps.access.authorize(scope, actor, permission);
    const presentation = await this.deps.presentation.presentationFor(scope);
    const period = this.deps.periods.resolve(
      {
        range: request.range,
        ...(request.from === undefined ? {} : { from: request.from }),
        ...(request.to === undefined ? {} : { to: request.to }),
      },
      this.deps.clock.now(),
      presentation,
    );
    const fmt = (d: PeriodSide['startLocal']): string => this.deps.periods.formatLocalDate(d);
    const side = (s: PeriodSide) => ({
      start: s.start.toISOString(),
      end: s.end.toISOString(),
      effectiveEnd: s.effectiveEnd.toISOString(),
      startLocal: fmt(s.startLocal),
      endLocalInclusive: fmt(s.endLocalInclusive),
    });
    return {
      period,
      wire: {
        range: period.range,
        timezone: period.timezone,
        calendar: period.calendar,
        granularity: period.granularity,
        current: side(period.current),
        previous: side(period.previous),
        lengthsDiffer: period.lengthsDiffer,
        generatedAt: period.now.toISOString(),
      },
      current: { from: period.current.start, to: period.current.effectiveEnd },
      previous: { from: period.previous.start, to: period.previous.effectiveEnd },
    };
  }
}

// --- Pure helpers -----------------------------------------------------------------

function pair(current: number, previous: number): CountComparison {
  return { current, previous };
}

/** Per currency, over the union of both sides; a currency absent from one side is zero there. */
export function moneyPair(
  current: readonly CurrencyAmount[],
  previous: readonly CurrencyAmount[],
): MoneyComparison {
  const currencies = [...new Set([...current, ...previous].map((a) => a.currency))].sort();
  const amount = (list: readonly CurrencyAmount[], currency: CurrencyCode): bigint =>
    list.filter((a) => a.currency === currency).reduce((total, a) => total + a.amount, 0n);
  return currencies.map((currency) => ({
    currency,
    current: amount(current, currency).toString(),
    previous: amount(previous, currency).toString(),
  }));
}

function entriesOf(rows: readonly CountedAmount[]): number {
  return rows.reduce((total, row) => total + row.entries, 0);
}

function addAmounts(into: CurrencyAmount[], add: readonly CurrencyAmount[]): void {
  for (const a of add) {
    const index = into.findIndex((x) => x.currency === a.currency);
    if (index === -1) into.push({ ...a });
    else
      into[index] = {
        currency: a.currency,
        amount: (into[index] as CurrencyAmount).amount + a.amount,
      };
  }
}

function zeroCounts(): Record<PaymentState, number> {
  return Object.fromEntries(PAYMENT_STATES.map((state) => [state, 0])) as Record<
    PaymentState,
    number
  >;
}

/** `numerator / denominator` in basis points, rounded down; null when nothing was decided. */
export function basisPoints(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.floor((numerator * 10_000) / denominator);
}

/**
 * The payment figures for one group, and THE success-rate rule: confirmed over confirmed
 * plus the money-less terminal states. PENDING and UNKNOWN are in neither term.
 */
export function paymentFigures(
  counts: Readonly<Record<PaymentState, number>>,
  confirmedAmount: readonly CurrencyAmount[],
) {
  const failedTerminal = REPORT_FAILED_PAYMENT_STATES.reduce(
    (total, state) => total + counts[state],
    0,
  );
  return {
    attempts: PAYMENT_STATES.reduce((total, state) => total + counts[state], 0),
    confirmed: counts.CONFIRMED,
    failed: counts.FAILED,
    cancelled: counts.CANCELLED,
    expired: counts.EXPIRED,
    pending: counts.PENDING,
    unknown: counts.UNKNOWN,
    successRateBasisPoints: basisPoints(counts.CONFIRMED, counts.CONFIRMED + failedTerminal),
    confirmedAmount: confirmedAmount.map(toMoneyTotal),
  };
}

function toMoneyTotal(a: CurrencyAmount): { currency: CurrencyCode; amount: string } {
  return { currency: a.currency, amount: a.amount.toString() };
}

function toMoneyCount(a: CountedAmount): {
  currency: CurrencyCode;
  amount: string;
  entries: number;
} {
  return { currency: a.currency, amount: a.amount.toString(), entries: a.entries };
}

function toOrderWire(row: OrderRow) {
  return {
    orderId: row.orderId,
    settledAt: row.settledAt.toISOString(),
    purpose: row.purpose,
    title: row.title,
    categoryName: row.categoryName,
    subtotal: row.subtotal.toString(),
    discount: row.discount.toString(),
    total: row.total.toString(),
    currency: row.currency,
    paymentMethod: row.paymentMethod,
    paymentProvider: row.paymentProvider,
    customerId: row.customerId,
  };
}

/** The `width_bucket` thresholds: every bucket's start, then the last bucket's end. */
export function boundariesOf(buckets: readonly BucketBounds[]): Date[] {
  if (buckets.length === 0) return [];
  return [...buckets.map((b) => b.start), (buckets.at(-1) as BucketBounds).end];
}

function rankingPage(paging: { readonly limit?: number; readonly page?: number }): {
  limit: number;
  page: number;
  offset: number;
} {
  const limit = paging.limit ?? REPORT_RANKING_TOP;
  const page = paging.page ?? 1;
  const offset = (page - 1) * limit;
  if (offset + limit > REPORT_RANKING_DEPTH_MAX) {
    throw errors.validation(
      CONTROL_ERROR_CODES.INVALID_VALUE,
      `A ranking is paged no deeper than ${REPORT_RANKING_DEPTH_MAX} rows.`,
      { page, limit },
    );
  }
  return { limit, page, offset };
}

function table(
  report: ReportExportKind,
  columns: readonly (readonly [ExportColumnKey, ExportCellKind])[],
  rows: readonly Record<string, ExportCell>[],
): ExportTable {
  return { report, columns: columns.map(([key, kind]) => ({ key, kind })), rows };
}

/**
 * `nexa-sales-1405-07-01-to-1405-07-30`, a single day as one date, a whole calendar month
 * as `nexa-payments-1405-07` (spec §31). Tenant-calendar dates, Latin digits, no identifier.
 */
export function exportFileStem(
  report: ReportExportKind,
  r: { readonly period: ResolvedPeriod },
  periods: Pick<ReportPeriodResolver, 'formatLocalDate'>,
): string {
  const base = `nexa-${report.toLowerCase()}`;
  const { startLocal, endLocalInclusive } = r.period.current;
  const wholeMonth = r.period.range === 'THIS_MONTH' || r.period.range === 'PREVIOUS_MONTH';
  if (wholeMonth) {
    return `${base}-${String(startLocal.year).padStart(4, '0')}-${String(startLocal.month).padStart(2, '0')}`;
  }
  const from = periods.formatLocalDate(startLocal, '-');
  const to = periods.formatLocalDate(endLocalInclusive, '-');
  return from === to ? `${base}-${from}` : `${base}-${from}-to-${to}`;
}
