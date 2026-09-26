import { sql, type SQL } from 'drizzle-orm';
import {
  LEDGER_REASONS,
  PAYMENT_STATES,
  PRODUCT_RANKING_PURPOSES,
  REPORT_COMMERCIAL_OPERATION_TYPES,
  REPORT_FAILED_OPERATION_STATES,
  REPORT_FAILED_PAYMENT_STATES,
  SALE_ORDER_PURPOSES,
  SERVICE_STATES,
  TRAFFIC_SELLING_PURPOSES,
  ledgerReasonsIn,
  type CurrencyCode,
  type LedgerDirection,
  type LedgerReason,
  type OperationState,
  type OperationType,
  type OrderPurpose,
  type PaymentMethod,
  type PaymentState,
  type ReportOperationGroup,
  type ReportPaymentKind,
  type ReportProductRanking,
  type ReportReferrerRanking,
  type ReportTrendMetric,
  type ServiceState,
  type TenantContext,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import type {
  CountedAmount,
  CurrencyAmount,
  FailureTotals,
  KeysetPosition,
  OperationRow,
  OrderRow,
  Page,
  PanelFigures,
  PaymentAttemptRow,
  PaymentGroupRow,
  ProductRankRow,
  ProviderFigures,
  PurposeFigures,
  Ranked,
  ReferrerRow,
  ReportingRepository,
  ResellerRow,
  SalesTotals,
  TrafficSold,
  WalletReasonRow,
  Window,
} from '../application/ports.js';

/**
 * The reporting aggregates, in SQL (`docs/wp12-business-analytics-audit.md` §4, §5, §10).
 *
 * Four rules hold for every statement here, and each is a way a report lies:
 *
 *   - **Tenant first.** `tenant_id = $tenant` is the first predicate of every table read,
 *     including each side of every join, so no row of another tenant can be counted.
 *   - **A half-open window.** `ts >= $from AND ts < $to`, from instants the tenant-calendar
 *     resolver produced. No `AT TIME ZONE`, no `date_trunc`: a Jalali month is not a
 *     PostgreSQL month, so buckets arrive as explicit boundaries (`width_bucket`).
 *   - **One row per business fact.** A sale is an ORDER row; a join to `payments` goes
 *     through `payments_order_confirmed_key` (at most one CONFIRMED per order), so it can
 *     never multiply a sale by its payment attempts.
 *   - **Money is bigint, grouped by currency.** Sums come back as text and are parsed
 *     with `BigInt`; nothing is summed across currencies, and nothing is a float.
 *
 * And two things no statement here selects: `order_reseller_terms.margin_amount` /
 * `cost_amount` (no profit reporting), and any money beside a panel or provider (no
 * revenue by infrastructure). Customer profile columns are never read.
 */
export class DrizzleReportingRepository implements ReportingRepository {
  constructor(private readonly db: Database) {}

  private async rows<T>(query: SQL): Promise<T[]> {
    const result = await this.db.execute<T & Record<string, unknown>>(query);
    return result.rows as T[];
  }

  async salesTotals(scope: TenantContext, window: Window): Promise<SalesTotals> {
    const rows = await this.rows<{
      currency: CurrencyCode;
      sales: number;
      successful: number;
      renewals: number;
      revenue: string;
      gross: string;
      discount: string;
    }>(sql`
      SELECT o.currency,
             count(*) FILTER (WHERE o.purpose = ANY(${purposes(SALE_ORDER_PURPOSES)}))::int AS sales,
             count(*)::int AS successful,
             count(*) FILTER (WHERE o.purpose = 'RENEW')::int AS renewals,
             coalesce(sum(o.total_amount) FILTER (WHERE o.purpose = ANY(${purposes(SALE_ORDER_PURPOSES)})), 0)::text AS revenue,
             coalesce(sum(o.subtotal_amount) FILTER (WHERE o.purpose = ANY(${purposes(SALE_ORDER_PURPOSES)})), 0)::text AS gross,
             coalesce(sum(o.discount_amount) FILTER (WHERE o.purpose = ANY(${purposes(SALE_ORDER_PURPOSES)})), 0)::text AS discount
        FROM orders o
       WHERE o.tenant_id = ${tenant(scope)}
         AND o.state = 'PAID'
         AND ${within(sql`o.settled_at`, window)}
       GROUP BY o.currency`);
    const money = (key: 'revenue' | 'gross' | 'discount'): CurrencyAmount[] =>
      rows
        .filter((row) => row.sales > 0)
        .map((row) => ({ currency: row.currency, amount: BigInt(row[key]) }));
    return {
      sales: rows.reduce((total, row) => total + row.sales, 0),
      successfulOrders: rows.reduce((total, row) => total + row.successful, 0),
      renewals: rows.reduce((total, row) => total + row.renewals, 0),
      revenue: money('revenue'),
      gross: money('gross'),
      discount: money('discount'),
    };
  }

  async newCustomers(scope: TenantContext, window: Window): Promise<number> {
    const [row] = await this.rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM customers c
       WHERE c.tenant_id = ${tenant(scope)} AND ${within(sql`c.created_at`, window)}`);
    return row?.n ?? 0;
  }

  async newBuyers(scope: TenantContext, window: Window): Promise<number> {
    // The EARLIEST sale of each customer, over all time, and then only those that fall
    // in the window: a returning buyer is never a new one.
    const [row] = await this.rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM (
        SELECT o.customer_id, min(o.settled_at) AS first_sale
          FROM orders o
         WHERE o.tenant_id = ${tenant(scope)}
           AND o.state = 'PAID'
           AND o.purpose = ANY(${purposes(SALE_ORDER_PURPOSES)})
         GROUP BY o.customer_id
      ) f
      WHERE ${within(sql`f.first_sale`, window)}`);
    return row?.n ?? 0;
  }

  async newServices(
    scope: TenantContext,
    window: Window,
  ): Promise<{ paid: number; trial: number }> {
    const [row] = await this.rows<{ paid: number; trial: number }>(sql`
      SELECT count(*) FILTER (WHERE o.purpose <> 'TRIAL')::int AS paid,
             count(*) FILTER (WHERE o.purpose = 'TRIAL')::int AS trial
        FROM services s
        JOIN orders o ON o.tenant_id = s.tenant_id AND o.id = s.order_id
       WHERE s.tenant_id = ${tenant(scope)}
         AND ${within(sql`s.provisioned_at`, window)}`);
    return { paid: row?.paid ?? 0, trial: row?.trial ?? 0 };
  }

  async topups(scope: TenantContext, window: Window): Promise<readonly CountedAmount[]> {
    const rows = await this.rows<{ currency: CurrencyCode; entries: number; amount: string }>(sql`
      SELECT w.currency, count(*)::int AS entries, sum(w.amount)::text AS amount
        FROM wallet_entries w
       WHERE w.tenant_id = ${tenant(scope)}
         AND w.direction = 'CREDIT'
         AND w.reason = ANY(${reasons(ledgerReasonsIn('TOPUP'))})
         AND ${within(sql`w.created_at`, window)}
       GROUP BY w.currency
       ORDER BY w.currency`);
    return rows.map((row) => ({
      currency: row.currency,
      entries: row.entries,
      amount: BigInt(row.amount),
    }));
  }

  async activeServices(scope: TenantContext): Promise<number> {
    const [row] = await this.rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM services s
       WHERE s.tenant_id = ${tenant(scope)} AND s.state = 'ACTIVE'`);
    return row?.n ?? 0;
  }

  async activeCustomers(scope: TenantContext, purchasedSince: Date, now: Date): Promise<number> {
    // UNION, not UNION ALL: a customer with both an active service and a recent purchase
    // is one active customer.
    const [row] = await this.rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM (
        SELECT s.customer_id FROM services s
         WHERE s.tenant_id = ${tenant(scope)} AND s.state = 'ACTIVE'
        UNION
        SELECT o.customer_id FROM orders o
         WHERE o.tenant_id = ${tenant(scope)}
           AND o.state = 'PAID'
           AND o.purpose = ANY(${purposes(SALE_ORDER_PURPOSES)})
           AND ${within(sql`o.settled_at`, { from: purchasedSince, to: now })}
      ) active`);
    return row?.n ?? 0;
  }

  async trend(
    scope: TenantContext,
    metric: ReportTrendMetric,
    currency: CurrencyCode | null,
    boundaries: readonly Date[],
  ): Promise<ReadonlyMap<number, bigint>> {
    if (boundaries.length < 2) return new Map();
    const bounds = sql`${sql.param(boundaries.map((b) => b.toISOString()))}::timestamptz[]`;
    const window: Window = {
      from: boundaries[0] as Date,
      to: boundaries[boundaries.length - 1] as Date,
    };
    const source = ((): { ts: SQL; value: SQL; from: SQL } => {
      switch (metric) {
        case 'REVENUE':
          return {
            ts: sql`o.settled_at`,
            value: sql`sum(o.total_amount)`,
            from: sql`orders o WHERE o.tenant_id = ${tenant(scope)} AND o.state = 'PAID'
              AND o.purpose = ANY(${purposes(SALE_ORDER_PURPOSES)}) AND o.currency = ${currency ?? ''}`,
          };
        case 'SALES':
          return {
            ts: sql`o.settled_at`,
            value: sql`count(*)`,
            from: sql`orders o WHERE o.tenant_id = ${tenant(scope)} AND o.state = 'PAID'
              AND o.purpose = ANY(${purposes(SALE_ORDER_PURPOSES)})`,
          };
        case 'RENEWALS':
          return {
            ts: sql`o.settled_at`,
            value: sql`count(*)`,
            from: sql`orders o WHERE o.tenant_id = ${tenant(scope)} AND o.state = 'PAID'
              AND o.purpose = 'RENEW'`,
          };
        case 'NEW_USERS':
          return {
            ts: sql`c.created_at`,
            value: sql`count(*)`,
            from: sql`customers c WHERE c.tenant_id = ${tenant(scope)}`,
          };
        default: {
          const unreachable: never = metric;
          throw new Error(`unknown trend metric ${String(unreachable)}`);
        }
      }
    })();
    // `width_bucket(ts, thresholds)` is 1 for the first bucket; the window predicate keeps
    // every row inside [first start, last end), so 0 and n+1 never occur. It counts the
    // thresholds <= ts, so a repeated threshold (the zero-width slot of an hour a DST gap
    // skipped) receives no row: `width_bucket(3, '{0,3,3,10}')` is 3, never 2.
    const rows = await this.rows<{ bucket: number; value: string }>(sql`
      SELECT width_bucket(${source.ts}, ${bounds}) - 1 AS bucket, (${source.value})::text AS value
        FROM ${source.from}
         AND ${within(source.ts, window)}
       GROUP BY 1`);
    return new Map(rows.map((row) => [Number(row.bucket), BigInt(row.value)]));
  }

  async revenueCurrencies(
    scope: TenantContext,
    windows: readonly Window[],
  ): Promise<readonly CurrencyCode[]> {
    const predicates = windows.map((w) => within(sql`o.settled_at`, w));
    if (predicates.length === 0) return [];
    const rows = await this.rows<{ currency: CurrencyCode }>(sql`
      SELECT DISTINCT o.currency FROM orders o
       WHERE o.tenant_id = ${tenant(scope)} AND o.state = 'PAID'
         AND o.purpose = ANY(${purposes(SALE_ORDER_PURPOSES)})
         AND (${sql.join(predicates, sql` OR `)})
       ORDER BY o.currency`);
    return rows.map((row) => row.currency);
  }

  async productRanking(
    scope: TenantContext,
    window: Window,
    by: ReportProductRanking,
    preferredCurrency: CurrencyCode,
    limit: number,
    offset: number,
  ): Promise<Ranked<ProductRankRow>> {
    /*
     * Grouped by the SNAPSHOT title, never the current product's: a product renamed after
     * a sale keeps its old name on its old rows. The product row is joined for one current
     * fact, its lifecycle status, and nothing it says replaces the history.
     */
    const order =
      by === 'COUNT'
        ? sql`count(*) DESC, sum(o.total_amount) DESC`
        : sql`(o.currency = ${preferredCurrency}) DESC, sum(o.total_amount) DESC, count(*) DESC`;
    const rows = await this.rows<{
      product_id: string;
      title: string;
      category_name: string | null;
      category_emoji: string | null;
      product_status: string | null;
      orders: number;
      quantity: number;
      revenue: string;
      currency: CurrencyCode;
      total_rows: number;
    }>(sql`
      SELECT o.product_id,
             o.line_title AS title,
             (array_agg(o.line_category_name ORDER BY o.settled_at DESC, o.id DESC))[1] AS category_name,
             (array_agg(o.line_category_emoji ORDER BY o.settled_at DESC, o.id DESC))[1] AS category_emoji,
             p.status AS product_status,
             count(*)::int AS orders,
             sum(o.line_quantity)::int AS quantity,
             sum(o.total_amount)::text AS revenue,
             o.currency,
             (count(*) OVER ())::int AS total_rows
        FROM orders o
        LEFT JOIN products p ON p.tenant_id = o.tenant_id AND p.id = o.product_id
       WHERE o.tenant_id = ${tenant(scope)}
         AND o.state = 'PAID'
         AND o.purpose = ANY(${purposes(PRODUCT_RANKING_PURPOSES)})
         AND ${within(sql`o.settled_at`, window)}
       GROUP BY o.product_id, o.line_title, o.currency, p.status
       ORDER BY ${order}, o.line_title ASC, o.product_id ASC
       LIMIT ${limit} OFFSET ${offset}`);
    return {
      totalRows:
        rows[0]?.total_rows ?? (offset > 0 ? await this.productRankCount(scope, window) : 0),
      rows: rows.map((row) => ({
        productId: row.product_id,
        title: row.title,
        categoryName: row.category_name,
        categoryEmoji: row.category_emoji,
        productStatus: row.product_status,
        orders: row.orders,
        quantity: row.quantity,
        revenue: BigInt(row.revenue),
        currency: row.currency,
      })),
    };
  }

  /** The row count alone, for a page past the end, where the window function has no row to ride on. */
  private async productRankCount(scope: TenantContext, window: Window): Promise<number> {
    const [row] = await this.rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM orders o
         WHERE o.tenant_id = ${tenant(scope)} AND o.state = 'PAID'
           AND o.purpose = ANY(${purposes(PRODUCT_RANKING_PURPOSES)})
           AND ${within(sql`o.settled_at`, window)}
         GROUP BY o.product_id, o.line_title, o.currency
      ) g`);
    return row?.n ?? 0;
  }

  async serviceStates(scope: TenantContext): Promise<ReadonlyMap<ServiceState, number>> {
    const rows = await this.rows<{ state: ServiceState; n: number }>(sql`
      SELECT s.state, count(*)::int AS n FROM services s
       WHERE s.tenant_id = ${tenant(scope)}
       GROUP BY s.state`);
    const known = new Set<string>(SERVICE_STATES);
    return new Map(rows.filter((row) => known.has(row.state)).map((row) => [row.state, row.n]));
  }

  async purposeFigures(
    scope: TenantContext,
    window: Window,
    list: readonly OrderPurpose[],
  ): Promise<readonly PurposeFigures[]> {
    const rows = await this.rows<{
      purpose: OrderPurpose;
      currency: CurrencyCode;
      n: number;
      amount: string;
    }>(sql`
      SELECT o.purpose, o.currency, count(*)::int AS n, sum(o.total_amount)::text AS amount
        FROM orders o
       WHERE o.tenant_id = ${tenant(scope)}
         AND o.state = 'PAID'
         AND o.purpose = ANY(${purposes(list)})
         AND ${within(sql`o.settled_at`, window)}
       GROUP BY o.purpose, o.currency`);
    return list.map((purpose) => {
      const mine = rows.filter((row) => row.purpose === purpose);
      return {
        purpose,
        orders: mine.reduce((total, row) => total + row.n, 0),
        revenue: mine.map((row) => ({ currency: row.currency, amount: BigInt(row.amount) })),
      };
    });
  }

  async trafficSold(scope: TenantContext, window: Window): Promise<TrafficSold> {
    const [row] = await this.rows<{ bytes: string; unlimited: number }>(sql`
      SELECT ${meteredBytes(sql`o`)} AS bytes, ${unlimitedLines(sql`o`)} AS unlimited
        FROM orders o
       WHERE o.tenant_id = ${tenant(scope)}
         AND o.state = 'PAID'
         AND o.purpose = ANY(${purposes(TRAFFIC_SELLING_PURPOSES)})
         AND ${within(sql`o.settled_at`, window)}`);
    return { bytes: BigInt(row?.bytes ?? '0'), unlimitedLines: row?.unlimited ?? 0 };
  }

  async panelFigures(
    scope: TenantContext,
    window: Window,
    limit: number,
  ): Promise<{
    readonly panels: readonly PanelFigures[];
    readonly providers: readonly ProviderFigures[];
  }> {
    const t = tenant(scope);
    /*
     * Service, traffic and failure counts per panel — and no money. Each CTE is grouped
     * by `panel_id` on its own before the join, so a panel's services cannot multiply its
     * operations or its orders.
     */
    const perPanel = sql`
      WITH created AS (
        SELECT s.panel_id, count(*)::int AS n FROM services s
         WHERE s.tenant_id = ${t} AND ${within(sql`s.provisioned_at`, window)}
         GROUP BY s.panel_id
      ), active AS (
        SELECT s.panel_id, count(*)::int AS n FROM services s
         WHERE s.tenant_id = ${t} AND s.state = 'ACTIVE'
         GROUP BY s.panel_id
      ), traffic AS (
        SELECT o.panel_id, ${meteredBytes(sql`o`)}::numeric AS bytes, ${unlimitedLines(sql`o`)} AS unlimited
          FROM orders o
         WHERE o.tenant_id = ${t} AND o.state = 'PAID'
           AND o.purpose = ANY(${purposes(TRAFFIC_SELLING_PURPOSES)})
           AND ${within(sql`o.settled_at`, window)}
         GROUP BY o.panel_id
      ), failures AS (
        SELECT op.panel_id, count(*)::int AS n FROM provisioning_operations op
         WHERE op.tenant_id = ${t} AND op.type = 'PROVISION'
           AND op.state = ANY(${text(REPORT_FAILED_OPERATION_STATES)})
           AND ${within(sql`op.completed_at`, window)}
         GROUP BY op.panel_id
      ), figures AS (
        SELECT p.id AS panel_id, p.name AS panel_name, p.provider_type,
               coalesce(c.n, 0) AS services_created,
               coalesce(a.n, 0) AS active_services,
               coalesce(tr.bytes, 0) AS traffic_bytes,
               coalesce(tr.unlimited, 0) AS unlimited,
               coalesce(f.n, 0) AS failures,
               p.archived_at
          FROM panels p
          LEFT JOIN created c ON c.panel_id = p.id
          LEFT JOIN active a ON a.panel_id = p.id
          LEFT JOIN traffic tr ON tr.panel_id = p.id
          LEFT JOIN failures f ON f.panel_id = p.id
         WHERE p.tenant_id = ${t}
      )`;
    const activity = sql`(archived_at IS NULL OR services_created > 0 OR active_services > 0
      OR traffic_bytes > 0 OR unlimited > 0 OR failures > 0)`;
    const panels = await this.rows<{
      panel_id: string;
      panel_name: string;
      provider_type: string;
      services_created: number;
      active_services: number;
      traffic_bytes: string;
      unlimited: number;
      failures: number;
    }>(sql`${perPanel}
      SELECT panel_id, panel_name, provider_type, services_created, active_services,
             traffic_bytes::text AS traffic_bytes, unlimited, failures
        FROM figures WHERE ${activity}
       ORDER BY panel_name ASC, panel_id ASC
       LIMIT ${limit}`);
    const providers = await this.rows<{
      provider_type: string;
      services_created: number;
      active_services: number;
      traffic_bytes: string;
      unlimited: number;
      failures: number;
    }>(sql`${perPanel}
      SELECT provider_type,
             sum(services_created)::int AS services_created,
             sum(active_services)::int AS active_services,
             sum(traffic_bytes)::text AS traffic_bytes,
             sum(unlimited)::int AS unlimited,
             sum(failures)::int AS failures
        FROM figures WHERE ${activity}
       GROUP BY provider_type
       ORDER BY provider_type`);
    const figures = (row: {
      services_created: number;
      active_services: number;
      traffic_bytes: string;
      unlimited: number;
      failures: number;
    }) => ({
      servicesCreated: row.services_created,
      activeServices: row.active_services,
      trafficSoldBytes: BigInt(row.traffic_bytes),
      unlimitedTrafficLines: row.unlimited,
      provisioningFailures: row.failures,
    });
    return {
      panels: panels.map((row) => ({
        panelId: row.panel_id,
        panelName: row.panel_name,
        providerType: row.provider_type,
        ...figures(row),
      })),
      providers: providers.map((row) => ({ providerType: row.provider_type, ...figures(row) })),
    };
  }

  async paymentGroups(scope: TenantContext, window: Window): Promise<readonly PaymentGroupRow[]> {
    const rows = await this.rows<{
      method: PaymentMethod;
      provider: string | null;
      topup: boolean;
      state: PaymentState;
      currency: CurrencyCode;
      n: number;
      amount: string;
    }>(sql`
      SELECT p.method, p.gateway_provider AS provider, (p.order_id IS NULL) AS topup,
             p.state, p.currency, count(*)::int AS n, sum(p.amount)::text AS amount
        FROM payments p
       WHERE p.tenant_id = ${tenant(scope)}
         AND ${within(sql`p.created_at`, window)}
       GROUP BY 1, 2, 3, 4, 5`);
    const groups = new Map<
      string,
      { row: PaymentGroupRow; counts: Record<PaymentState, number>; amounts: CurrencyAmount[] }
    >();
    for (const row of rows) {
      const kind: ReportPaymentKind = row.topup ? 'TOPUP' : 'ORDER';
      const key = `${row.method}|${row.provider ?? ''}|${kind}`;
      let group = groups.get(key);
      if (group === undefined) {
        const counts = Object.fromEntries(PAYMENT_STATES.map((s) => [s, 0])) as Record<
          PaymentState,
          number
        >;
        const amounts: CurrencyAmount[] = [];
        group = {
          counts,
          amounts,
          row: {
            method: row.method,
            provider: row.provider,
            kind,
            counts,
            confirmedAmount: amounts,
          },
        };
        groups.set(key, group);
      }
      group.counts[row.state] += row.n;
      if (row.state === 'CONFIRMED')
        group.amounts.push({ currency: row.currency, amount: BigInt(row.amount) });
    }
    return [...groups.values()]
      .map((g) => g.row)
      .sort(
        (a, b) =>
          a.method.localeCompare(b.method) ||
          (a.provider ?? '').localeCompare(b.provider ?? '') ||
          a.kind.localeCompare(b.kind),
      );
  }

  async walletReasons(scope: TenantContext, window: Window): Promise<readonly WalletReasonRow[]> {
    const rows = await this.rows<{
      reason: LedgerReason;
      direction: LedgerDirection;
      currency: CurrencyCode;
      entries: number;
      amount: string;
    }>(sql`
      SELECT w.reason, w.direction, w.currency, count(*)::int AS entries, sum(w.amount)::text AS amount
        FROM wallet_entries w
       WHERE w.tenant_id = ${tenant(scope)}
         AND ${within(sql`w.created_at`, window)}
       GROUP BY 1, 2, 3`);
    const order = new Map<string, number>(LEDGER_REASONS.map((reason, i) => [reason, i]));
    return rows
      .map((row) => ({ ...row, amount: BigInt(row.amount) }))
      .sort(
        (a, b) =>
          (order.get(a.reason) ?? 0) - (order.get(b.reason) ?? 0) ||
          a.direction.localeCompare(b.direction) ||
          a.currency.localeCompare(b.currency),
      );
  }

  async walletBalances(scope: TenantContext): Promise<readonly CurrencyAmount[]> {
    const rows = await this.rows<{ currency: CurrencyCode; balance: string }>(sql`
      SELECT w.currency, ${signedSum(sql`w`)} AS balance
        FROM wallet_entries w
       WHERE w.tenant_id = ${tenant(scope)}
       GROUP BY w.currency
       ORDER BY w.currency`);
    return rows.map((row) => ({ currency: row.currency, amount: BigInt(row.balance) }));
  }

  async referralSignups(
    scope: TenantContext,
    window: Window,
  ): Promise<{ signups: number; converted: number }> {
    const [row] = await this.rows<{ signups: number; converted: number }>(sql`
      SELECT count(*)::int AS signups,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM orders o
                WHERE o.tenant_id = r.tenant_id AND o.customer_id = r.referee_id
                  AND o.state = 'PAID' AND o.purpose = ANY(${purposes(SALE_ORDER_PURPOSES)})
             ))::int AS converted
        FROM referrals r
       WHERE r.tenant_id = ${tenant(scope)}
         AND ${within(sql`r.created_at`, window)}`);
    return { signups: row?.signups ?? 0, converted: row?.converted ?? 0 };
  }

  async referredSales(
    scope: TenantContext,
    window: Window,
  ): Promise<{ readonly sales: number; readonly revenue: readonly CurrencyAmount[] }> {
    // `referrals_referee_key` makes the join one-to-one: a referee has one attribution,
    // so an order is counted at most once.
    const rows = await this.rows<{ currency: CurrencyCode; n: number; amount: string }>(sql`
      SELECT o.currency, count(*)::int AS n, sum(o.total_amount)::text AS amount
        FROM orders o
        JOIN referrals r ON r.tenant_id = o.tenant_id AND r.referee_id = o.customer_id
       WHERE o.tenant_id = ${tenant(scope)}
         AND o.state = 'PAID'
         AND o.purpose = ANY(${purposes(SALE_ORDER_PURPOSES)})
         AND ${within(sql`o.settled_at`, window)}
       GROUP BY o.currency
       ORDER BY o.currency`);
    return {
      sales: rows.reduce((total, row) => total + row.n, 0),
      revenue: rows.map((row) => ({ currency: row.currency, amount: BigInt(row.amount) })),
    };
  }

  async topReferrers(
    scope: TenantContext,
    window: Window,
    by: ReportReferrerRanking,
    rankingCurrency: CurrencyCode,
    limit: number,
    offset: number,
  ): Promise<Ranked<ReferrerRow>> {
    const t = tenant(scope);
    const order = ((): SQL => {
      switch (by) {
        case 'SIGNUPS':
          return sql`signups DESC, buyers DESC`;
        case 'BUYERS':
          return sql`buyers DESC, signups DESC`;
        case 'REVENUE':
          return sql`rank_revenue DESC, signups DESC`;
        case 'COMMISSION':
          return sql`rank_commission DESC, signups DESC`;
        default: {
          const unreachable: never = by;
          throw new Error(`unknown referrer ranking ${String(unreachable)}`);
        }
      }
    })();
    const rows = await this.rows<{
      referrer_id: string;
      signups: number;
      buyers: number;
      revenue: { currency: CurrencyCode; amount: string }[] | null;
      commission: { currency: CurrencyCode; amount: string }[] | null;
      total_rows: number;
    }>(sql`
      WITH s AS (
        SELECT r.referrer_id, count(*)::int AS signups,
               count(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM orders o
                  WHERE o.tenant_id = r.tenant_id AND o.customer_id = r.referee_id
                    AND o.state = 'PAID' AND o.purpose = ANY(${purposes(SALE_ORDER_PURPOSES)})
               ))::int AS buyers
          FROM referrals r
         WHERE r.tenant_id = ${t} AND ${within(sql`r.created_at`, window)}
         GROUP BY r.referrer_id
      ), rev AS (
        SELECT r.referrer_id, o.currency, sum(o.total_amount) AS amount
          FROM orders o
          JOIN referrals r ON r.tenant_id = o.tenant_id AND r.referee_id = o.customer_id
         WHERE o.tenant_id = ${t} AND o.state = 'PAID'
           AND o.purpose = ANY(${purposes(SALE_ORDER_PURPOSES)})
           AND ${within(sql`o.settled_at`, window)}
         GROUP BY r.referrer_id, o.currency
      ), com AS (
        SELECT w.customer_id AS referrer_id, w.currency, sum(w.amount) AS amount
          FROM wallet_entries w
         WHERE w.tenant_id = ${t} AND w.reason = 'REFERRAL_COMMISSION' AND w.direction = 'CREDIT'
           AND ${within(sql`w.created_at`, window)}
         GROUP BY w.customer_id, w.currency
      ), ids AS (
        SELECT referrer_id FROM s UNION SELECT referrer_id FROM rev UNION SELECT referrer_id FROM com
      ), ranked AS (
        SELECT ids.referrer_id,
               coalesce(s.signups, 0) AS signups,
               coalesce(s.buyers, 0) AS buyers,
               coalesce((SELECT amount FROM rev WHERE rev.referrer_id = ids.referrer_id AND rev.currency = ${rankingCurrency}), 0) AS rank_revenue,
               coalesce((SELECT amount FROM com WHERE com.referrer_id = ids.referrer_id AND com.currency = ${rankingCurrency}), 0) AS rank_commission
          FROM ids LEFT JOIN s ON s.referrer_id = ids.referrer_id
      )
      SELECT ranked.referrer_id, ranked.signups, ranked.buyers,
             (SELECT json_agg(json_build_object('currency', rev.currency, 'amount', rev.amount::text) ORDER BY rev.currency)
                FROM rev WHERE rev.referrer_id = ranked.referrer_id) AS revenue,
             (SELECT json_agg(json_build_object('currency', com.currency, 'amount', com.amount::text) ORDER BY com.currency)
                FROM com WHERE com.referrer_id = ranked.referrer_id) AS commission,
             (count(*) OVER ())::int AS total_rows
        FROM ranked
       ORDER BY ${order}, ranked.referrer_id ASC
       LIMIT ${limit} OFFSET ${offset}`);
    const money = (list: { currency: CurrencyCode; amount: string }[] | null): CurrencyAmount[] =>
      (list ?? []).map((m) => ({ currency: m.currency, amount: BigInt(m.amount) }));
    return {
      totalRows:
        rows[0]?.total_rows ?? (offset > 0 ? await this.referrerRankCount(scope, window) : 0),
      rows: rows.map((row) => ({
        referrerId: row.referrer_id,
        signups: row.signups,
        convertedBuyers: row.buyers,
        revenue: money(row.revenue),
        commission: money(row.commission),
      })),
    };
  }

  /**
   * The ranked referrers' count alone, for a page past the end: the same three sources
   * `topReferrers` unions — referrals made, referees' sales and commission credited.
   */
  private async referrerRankCount(scope: TenantContext, window: Window): Promise<number> {
    const t = tenant(scope);
    const [row] = await this.rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM (
        SELECT r.referrer_id FROM referrals r
         WHERE r.tenant_id = ${t} AND ${within(sql`r.created_at`, window)}
        UNION
        SELECT r.referrer_id FROM orders o
          JOIN referrals r ON r.tenant_id = o.tenant_id AND r.referee_id = o.customer_id
         WHERE o.tenant_id = ${t} AND o.state = 'PAID'
           AND o.purpose = ANY(${purposes(SALE_ORDER_PURPOSES)})
           AND ${within(sql`o.settled_at`, window)}
        UNION
        SELECT w.customer_id FROM wallet_entries w
         WHERE w.tenant_id = ${t} AND w.reason = 'REFERRAL_COMMISSION' AND w.direction = 'CREDIT'
           AND ${within(sql`w.created_at`, window)}
      ) ids`);
    return row?.n ?? 0;
  }

  async resellers(
    scope: TenantContext,
    window: Window,
    limit: number,
  ): Promise<readonly ResellerRow[]> {
    const t = tenant(scope);
    // The terms row is read for its reseller and nothing else: `margin_amount` and
    // `cost_amount` are deliberately absent from this statement.
    const rows = await this.rows<{
      customer_id: string;
      tier_name: string;
      status: string;
      credit_limit_amount: string | null;
      credit_limit_currency: CurrencyCode | null;
      orders: number;
      sales: { currency: CurrencyCode; amount: string }[] | null;
      services: number;
      balance: string | null;
    }>(sql`
      WITH sold AS (
        SELECT t.reseller_customer_id, o.currency, count(*)::int AS n, sum(o.total_amount) AS amount
          FROM order_reseller_terms t
          JOIN orders o ON o.tenant_id = t.tenant_id AND o.id = t.order_id
         WHERE t.tenant_id = ${t} AND o.state = 'PAID'
           AND o.purpose = ANY(${purposes(SALE_ORDER_PURPOSES)})
           AND ${within(sql`o.settled_at`, window)}
         GROUP BY t.reseller_customer_id, o.currency
      ), delivered AS (
        SELECT t.reseller_customer_id, count(*)::int AS n
          FROM order_reseller_terms t
          JOIN services s ON s.tenant_id = t.tenant_id AND s.order_id = t.order_id
         WHERE t.tenant_id = ${t} AND ${within(sql`s.provisioned_at`, window)}
         GROUP BY t.reseller_customer_id
      )
      SELECT r.customer_id, tier.name AS tier_name, r.status,
             r.credit_limit_amount::text AS credit_limit_amount, r.credit_limit_currency,
             coalesce((SELECT sum(n) FROM sold WHERE sold.reseller_customer_id = r.customer_id), 0)::int AS orders,
             (SELECT json_agg(json_build_object('currency', sold.currency, 'amount', sold.amount::text) ORDER BY sold.currency)
                FROM sold WHERE sold.reseller_customer_id = r.customer_id) AS sales,
             coalesce((SELECT n FROM delivered WHERE delivered.reseller_customer_id = r.customer_id), 0) AS services,
             (SELECT ${signedSum(sql`w`)} FROM wallet_entries w
               WHERE w.tenant_id = r.tenant_id AND w.customer_id = r.customer_id
                 AND w.currency = r.credit_limit_currency) AS balance
        FROM resellers r
        JOIN reseller_tiers tier ON tier.tenant_id = r.tenant_id AND tier.id = r.tier_id
       WHERE r.tenant_id = ${t}
       ORDER BY orders DESC, r.customer_id ASC
       LIMIT ${limit}`);
    return rows.map((row) => ({
      resellerCustomerId: row.customer_id,
      tierName: row.tier_name,
      status: row.status,
      orders: row.orders,
      sales: (row.sales ?? []).map((m) => ({ currency: m.currency, amount: BigInt(m.amount) })),
      services: row.services,
      creditLimit:
        row.credit_limit_currency === null
          ? null
          : { currency: row.credit_limit_currency, amount: BigInt(row.credit_limit_amount ?? '0') },
      balanceInLimitCurrency:
        row.credit_limit_currency === null ? null : BigInt(row.balance ?? '0'),
    }));
  }

  async failures(scope: TenantContext, window: Window): Promise<FailureTotals> {
    const t = tenant(scope);
    const [payments] = await this.rows<{
      failed: number;
      cancelled: number;
      expired: number;
      unknown_now: number;
    }>(sql`
      SELECT count(*) FILTER (WHERE p.state = 'FAILED' AND ${within(sql`p.resolved_at`, window)})::int AS failed,
             count(*) FILTER (WHERE p.state = 'CANCELLED' AND ${within(sql`p.resolved_at`, window)})::int AS cancelled,
             count(*) FILTER (WHERE p.state = 'EXPIRED' AND ${within(sql`p.resolved_at`, window)})::int AS expired,
             count(*) FILTER (WHERE p.state = 'UNKNOWN')::int AS unknown_now
        FROM payments p
       WHERE p.tenant_id = ${t}
         AND (p.state = 'UNKNOWN' OR (p.state = ANY(${text(REPORT_FAILED_PAYMENT_STATES)}) AND ${within(sql`p.resolved_at`, window)}))`);
    const operations = await this.rows<{
      type: OperationType;
      state: OperationState;
      failure_kind: string | null;
      n: number;
    }>(sql`
      SELECT op.type, op.state, op.failure_kind, count(*)::int AS n
        FROM provisioning_operations op
       WHERE op.tenant_id = ${t}
         AND op.state = ANY(${text(REPORT_FAILED_OPERATION_STATES)})
         AND ${within(sql`op.completed_at`, window)}
       GROUP BY 1, 2, 3`);
    const [unknownOps] = await this.rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM provisioning_operations op
       WHERE op.tenant_id = ${t} AND op.state = 'UNKNOWN'`);
    const [refunded] = await this.rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM orders o
       WHERE o.tenant_id = ${t} AND o.state = 'REFUNDED' AND ${within(sql`o.refunded_at`, window)}`);
    return {
      payments: {
        failed: payments?.failed ?? 0,
        cancelled: payments?.cancelled ?? 0,
        expired: payments?.expired ?? 0,
      },
      paymentsUnknownNow: payments?.unknown_now ?? 0,
      operations: operations.map((row) => ({
        type: row.type,
        state: row.state,
        failureKind: row.failure_kind,
        count: row.n,
      })),
      operationsUnknownNow: unknownOps?.n ?? 0,
      ordersRefunded: refunded?.n ?? 0,
    };
  }

  async orders(
    scope: TenantContext,
    window: Window,
    filter: {
      readonly purpose?: OrderPurpose;
      readonly purposes?: readonly OrderPurpose[];
      readonly productId?: string;
    },
    limit: number,
    after: KeysetPosition | null,
  ): Promise<Page<OrderRow>> {
    const rows = await this.rows<{
      id: string;
      settled_at: string;
      settled_at_text: string;
      purpose: OrderPurpose;
      title: string;
      category_name: string | null;
      subtotal: string;
      discount: string;
      total: string;
      currency: CurrencyCode;
      method: PaymentMethod | null;
      provider: string | null;
      customer_id: string;
    }>(sql`
      SELECT o.id, o.settled_at,
             to_char(o.settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS settled_at_text,
             o.purpose, o.line_title AS title, o.line_category_name AS category_name,
             o.subtotal_amount::text AS subtotal, o.discount_amount::text AS discount,
             o.total_amount::text AS total, o.currency, o.customer_id,
             p.method, p.gateway_provider AS provider
        FROM orders o
        LEFT JOIN payments p
          ON p.tenant_id = o.tenant_id AND p.order_id = o.id AND p.state = 'CONFIRMED'
       WHERE o.tenant_id = ${tenant(scope)}
         AND o.state = 'PAID'
         AND ${within(sql`o.settled_at`, window)}
         ${filter.purpose === undefined ? sql`` : sql`AND o.purpose = ${filter.purpose}`}
         ${filter.purposes === undefined ? sql`` : sql`AND o.purpose = ANY(${purposes(filter.purposes)})`}
         ${filter.productId === undefined ? sql`` : sql`AND o.product_id = ${filter.productId}::uuid`}
         ${after === null ? sql`` : sql`AND (o.settled_at, o.id) < (${after.at}::timestamptz, ${after.id}::uuid)`}
       ORDER BY o.settled_at DESC, o.id DESC
       LIMIT ${limit + 1}`);
    return paged(
      rows,
      limit,
      (row) => ({ at: row.settled_at_text, id: row.id }),
      (row) => ({
        orderId: row.id,
        settledAt: new Date(row.settled_at),
        settledAtText: row.settled_at_text,
        purpose: row.purpose,
        title: row.title,
        categoryName: row.category_name,
        subtotal: BigInt(row.subtotal),
        discount: BigInt(row.discount),
        total: BigInt(row.total),
        currency: row.currency,
        paymentMethod: row.method,
        paymentProvider: row.provider,
        customerId: row.customer_id,
      }),
    );
  }

  async paymentAttempts(
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
  ): Promise<Page<PaymentAttemptRow>> {
    const rows = await this.rows<{
      id: string;
      reference: string;
      created_at: string;
      created_at_text: string;
      method: PaymentMethod;
      provider: string | null;
      topup: boolean;
      state: PaymentState;
      amount: string;
      currency: CurrencyCode;
      order_id: string | null;
    }>(sql`
      SELECT p.id, p.reference, p.created_at,
             to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text,
             p.method, p.gateway_provider AS provider, (p.order_id IS NULL) AS topup,
             p.state, p.amount::text AS amount, p.currency, p.order_id
        FROM payments p
       WHERE p.tenant_id = ${tenant(scope)}
         AND ${within(sql`p.created_at`, window)}
         ${filter.method === undefined ? sql`` : sql`AND p.method = ${filter.method}`}
         ${filter.provider === undefined ? sql`` : sql`AND p.gateway_provider = ${filter.provider}`}
         ${filter.kind === undefined ? sql`` : filter.kind === 'TOPUP' ? sql`AND p.order_id IS NULL` : sql`AND p.order_id IS NOT NULL`}
         ${filter.state === undefined ? sql`` : sql`AND p.state = ${filter.state}`}
         ${after === null ? sql`` : sql`AND (p.created_at, p.id) < (${after.at}::timestamptz, ${after.id}::uuid)`}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ${limit + 1}`);
    return paged(
      rows,
      limit,
      (row) => ({ at: row.created_at_text, id: row.id }),
      (row) => ({
        paymentId: row.id,
        reference: row.reference,
        createdAt: new Date(row.created_at),
        createdAtText: row.created_at_text,
        method: row.method,
        provider: row.provider,
        kind: row.topup ? 'TOPUP' : 'ORDER',
        state: row.state,
        amount: BigInt(row.amount),
        currency: row.currency,
        orderId: row.order_id,
      }),
    );
  }

  async failedOperations(
    scope: TenantContext,
    window: Window,
    group: ReportOperationGroup | undefined,
    limit: number,
    after: KeysetPosition | null,
  ): Promise<Page<OperationRow>> {
    const types =
      group === 'PROVISION'
        ? sql`AND op.type = 'PROVISION'`
        : group === 'COMMERCIAL'
          ? sql`AND op.type = ANY(${text(REPORT_COMMERCIAL_OPERATION_TYPES)})`
          : sql``;
    // `failure_message` is provider text and is not selected.
    const rows = await this.rows<{
      id: string;
      service_id: string;
      order_id: string | null;
      panel_id: string;
      panel_name: string | null;
      type: OperationType;
      state: OperationState;
      failure_kind: string | null;
      completed_at: string;
      completed_at_text: string;
    }>(sql`
      SELECT op.id, op.service_id, op.order_id, op.panel_id, pn.name AS panel_name,
             op.type, op.state, op.failure_kind, op.completed_at,
             to_char(op.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at_text
        FROM provisioning_operations op
        LEFT JOIN panels pn ON pn.tenant_id = op.tenant_id AND pn.id = op.panel_id
       WHERE op.tenant_id = ${tenant(scope)}
         AND op.state = ANY(${text(REPORT_FAILED_OPERATION_STATES)})
         AND ${within(sql`op.completed_at`, window)}
         ${types}
         ${after === null ? sql`` : sql`AND (op.completed_at, op.id) < (${after.at}::timestamptz, ${after.id}::uuid)`}
       ORDER BY op.completed_at DESC, op.id DESC
       LIMIT ${limit + 1}`);
    return paged(
      rows,
      limit,
      (row) => ({ at: row.completed_at_text, id: row.id }),
      (row) => ({
        operationId: row.id,
        serviceId: row.service_id,
        orderId: row.order_id,
        panelId: row.panel_id,
        panelName: row.panel_name,
        type: row.type,
        state: row.state,
        failureKind: row.failure_kind,
        completedAt: new Date(row.completed_at),
        completedAtText: row.completed_at_text,
      }),
    );
  }
}

// --- Fragments --------------------------------------------------------------------

function tenant(scope: TenantContext): SQL {
  return sql`${scope.tenantId}::uuid`;
}

/** The half-open window, on explicit instants. `[from, to)`: `to` itself is outside. */
function within(column: SQL, window: Window): SQL {
  return sql`${column} >= ${window.from.toISOString()}::timestamptz AND ${column} < ${window.to.toISOString()}::timestamptz`;
}

function text(values: readonly string[]): SQL {
  return sql`${sql.param([...values])}::text[]`;
}

function purposes(values: readonly OrderPurpose[]): SQL {
  return text(values);
}

function reasons(values: readonly LedgerReason[]): SQL {
  return text(values);
}

/** Metered bytes only: a line of 0 bytes is UNLIMITED (`UNLIMITED_TRAFFIC_BYTES`), never zero. */
function meteredBytes(alias: SQL): SQL {
  return sql`coalesce(sum(${alias}.line_traffic_bytes::numeric * ${alias}.line_quantity) FILTER (WHERE ${alias}.line_traffic_bytes > 0), 0)::text`;
}

function unlimitedLines(alias: SQL): SQL {
  return sql`(count(*) FILTER (WHERE ${alias}.line_traffic_bytes = 0))::int`;
}

/** The ledger's sign rule (`balance.ts#signedMinor`), in SQL: CREDIT adds, DEBIT subtracts. */
function signedSum(alias: SQL): SQL {
  return sql`coalesce(sum(CASE ${alias}.direction WHEN 'CREDIT' THEN ${alias}.amount WHEN 'DEBIT' THEN -${alias}.amount END), 0)::text`;
}

function paged<R, T>(
  rows: readonly R[],
  limit: number,
  position: (row: R) => KeysetPosition,
  map: (row: R) => T,
): Page<T> {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page.map(map),
    next: rows.length > limit && last !== undefined ? position(last) : null,
  };
}
