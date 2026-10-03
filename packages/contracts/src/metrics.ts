/**
 * The metric registry.
 *
 * Every reported number is a registry entry with one name, one formula, one
 * filter set and one interval semantic, served by one query service that both
 * surfaces call.
 *
 * The legacy system's reporting defects are definition failures, not query
 * failures: "sales" excludes renewals and add-ons (a 38% understatement against
 * the web's own revenue figure), "buyer" means two different things inside one
 * feature (56,792 vs 27,732), and no metric states which timestamp it filters
 * on. No amount of query correctness fixes a metric that means two things.
 *
 * Phase 0 ships the registry type and the CI gate that rejects a metric name
 * with no entry. The metric catalog itself is filled in as modules land.
 */

import type { NamedPeriod } from './time.js';

export const METRIC_KINDS = ['COUNT', 'SUM_MONEY', 'RATIO', 'AVERAGE', 'GAUGE'] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];

/**
 * Which timestamp a metric filters on. The legacy system records none of this,
 * which is why its all-time and grouped renewal totals disagree by 6.5%.
 */
export const TIMESTAMP_BASES = [
  'CREATED_AT',
  'PAID_AT',
  'COMPLETED_AT',
  'RENEWED_AT',
  'OCCURRED_AT',
] as const;
export type TimestampBasis = (typeof TIMESTAMP_BASES)[number];

export interface MetricDefinition {
  /** Stable machine name. This, not a display label, is the identifier. */
  readonly name: string;
  readonly kind: MetricKind;
  /** Prose formula, precise enough to reimplement from. */
  readonly formula: string;
  /** Which timestamp column the period filter applies to. */
  readonly timestampBasis: TimestampBasis;
  /** Named filters applied before aggregation, e.g. 'excludes test orders'. */
  readonly filters: readonly string[];
  /** Periods this metric is defined over. Intervals are always half-open. */
  readonly supportedPeriods: readonly NamedPeriod[];
  readonly description: string;
}

/** Every period a WP12 report offers by name; a custom range is the eighth. */
const REPORT_PERIODS: readonly NamedPeriod[] = [
  'TODAY',
  'YESTERDAY',
  'LAST_7_DAYS',
  'LAST_30_DAYS',
  'THIS_MONTH',
  'PREVIOUS_MONTH',
  'THIS_YEAR',
];

/** The filter every sale shares, stated once so a metric cannot restate it differently. */
const SALE_FILTERS: readonly string[] = [
  "state = 'PAID' (a REFUNDED order is not a sale)",
  'purpose in NEW_SERVICE, RENEW, ADD_TRAFFIC, ADD_TIME (never TRIAL)',
  'one row per ORDER, never per payment attempt',
  'tenant-scoped',
];

/**
 * Phase 0 registered only what it could compute, and that was nothing. WP12 registers
 * what it computes — every figure the business reports show, each with the formula
 * `docs/wp12-business-analytics-audit.md` maps to a persisted row. An aspirational
 * metric still has no place here: location, profit and margin are absent because no
 * WP12 query computes them.
 */
export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    name: 'sales.count',
    kind: 'COUNT',
    formula: 'count(orders) where the sale filters hold and settled_at is in the period',
    timestampBasis: 'PAID_AT',
    filters: SALE_FILTERS,
    supportedPeriods: REPORT_PERIODS,
    description: 'Commercial operations whose money arrived: purchases, renewals and add-ons.',
  },
  {
    name: 'sales.revenue',
    kind: 'SUM_MONEY',
    formula: 'sum(orders.total_amount) grouped by currency, over the sales.count rows',
    timestampBasis: 'PAID_AT',
    filters: SALE_FILTERS,
    supportedPeriods: REPORT_PERIODS,
    description:
      'The final amount after discount. Wallet top-ups, cashback, gifts and commissions are ledger entries and never enter it.',
  },
  {
    name: 'sales.gross',
    kind: 'SUM_MONEY',
    formula: 'sum(orders.subtotal_amount) grouped by currency, over the sales.count rows',
    timestampBasis: 'PAID_AT',
    filters: SALE_FILTERS,
    supportedPeriods: REPORT_PERIODS,
    description: 'The pre-discount value of the same sales, from the immutable order snapshot.',
  },
  {
    name: 'sales.discount',
    kind: 'SUM_MONEY',
    formula: 'sum(orders.discount_amount) grouped by currency, over the sales.count rows',
    timestampBasis: 'PAID_AT',
    filters: SALE_FILTERS,
    supportedPeriods: REPORT_PERIODS,
    description: 'Discount granted on the same sales. gross − discount = revenue, by CHECK.',
  },
  {
    name: 'sales.renewals',
    kind: 'COUNT',
    formula:
      "count(orders) where the sale filters hold, purpose = 'RENEW', settled_at in the period",
    timestampBasis: 'PAID_AT',
    filters: SALE_FILTERS,
    supportedPeriods: REPORT_PERIODS,
    description: 'Paid renewals. Also counted once in sales.count.',
  },
  {
    name: 'orders.successful',
    kind: 'COUNT',
    formula: "count(orders) where state = 'PAID' and settled_at is in the period, any purpose",
    timestampBasis: 'PAID_AT',
    filters: ["state = 'PAID'", 'includes trials granted', 'tenant-scoped'],
    supportedPeriods: REPORT_PERIODS,
    description: 'Every order that reached PAID: the sales plus the free trials granted.',
  },
  {
    name: 'customers.new',
    kind: 'COUNT',
    formula: 'count(customers) where created_at is in the period',
    timestampBasis: 'CREATED_AT',
    filters: ['tenant-scoped'],
    supportedPeriods: REPORT_PERIODS,
    description: 'Customers who registered — their first /start — in the period.',
  },
  {
    name: 'customers.new_buyers',
    kind: 'COUNT',
    formula:
      'count(customers) whose EARLIEST order meeting the sale filters has settled_at in the period',
    timestampBasis: 'PAID_AT',
    filters: SALE_FILTERS,
    supportedPeriods: REPORT_PERIODS,
    description:
      'Customers whose first purchase happened in the period. Separate from customers.new.',
  },
  {
    name: 'customers.active',
    kind: 'GAUGE',
    formula:
      'count(distinct customers) with a service in state ACTIVE now, or a sale with settled_at in [now − 30 days, now)',
    timestampBasis: 'PAID_AT',
    filters: [...SALE_FILTERS, 'a wallet top-up alone does not qualify'],
    supportedPeriods: [],
    description: 'Customers with an active service or a purchase in the last 30 days, now.',
  },
  {
    name: 'services.new',
    kind: 'COUNT',
    formula:
      'count(services) where provisioned_at is in the period, split by the creating order purpose (NEW_SERVICE, TRIAL)',
    timestampBasis: 'COMPLETED_AT',
    filters: ['tenant-scoped', 'the account became real on a panel'],
    supportedPeriods: REPORT_PERIODS,
    description: 'Services delivered in the period, paid and trial reported apart.',
  },
  {
    name: 'services.active',
    kind: 'GAUGE',
    formula: "count(services) where state = 'ACTIVE', now",
    timestampBasis: 'OCCURRED_AT',
    filters: ['tenant-scoped', 'the canonical state, never inferred from expires_at'],
    supportedPeriods: [],
    description: 'Services active right now.',
  },
  {
    name: 'services.traffic_sold',
    kind: 'COUNT',
    formula:
      'sum(line_traffic_bytes × line_quantity) over sales of purpose NEW_SERVICE, RENEW, ADD_TRAFFIC with line_traffic_bytes > 0; unlimited lines counted separately',
    timestampBasis: 'PAID_AT',
    filters: SALE_FILTERS,
    supportedPeriods: REPORT_PERIODS,
    description: 'Metered traffic sold, in bytes. An unlimited line is never added as zero.',
  },
  {
    name: 'wallet.topup',
    kind: 'SUM_MONEY',
    formula:
      'sum(wallet_entries.amount) and count, CREDIT entries with reason TOPUP_GATEWAY, TOPUP_RECEIPT, TOPUP_STARS or TOPUP_CRYPTO, by currency',
    timestampBasis: 'OCCURRED_AT',
    filters: ['tenant-scoped', 'classified by reason code, never by note'],
    supportedPeriods: REPORT_PERIODS,
    description: 'Customer-funded wallet inflow. Not revenue.',
  },
  {
    name: 'wallet.by_reason',
    kind: 'SUM_MONEY',
    formula: 'sum(wallet_entries.amount) and count, grouped by reason, direction and currency',
    timestampBasis: 'OCCURRED_AT',
    filters: ['tenant-scoped', 'grouped through WALLET_REPORT_GROUP_OF'],
    supportedPeriods: REPORT_PERIODS,
    description:
      'Every ledger movement in the period: top-ups, cashback, gifts, spending, refunds.',
  },
  {
    name: 'wallet.balance',
    kind: 'GAUGE',
    formula: 'sum(signed amount) of every wallet entry up to now, by currency',
    timestampBasis: 'OCCURRED_AT',
    filters: ['tenant-scoped', 'CREDIT positive, DEBIT negative (signedMinor)'],
    supportedPeriods: [],
    description: 'The stored value customers hold now, net of any reseller credit in use.',
  },
  {
    name: 'payments.attempts',
    kind: 'COUNT',
    formula:
      'count(payments) created in the period, by method, route and kind (ORDER or TOPUP), split by state',
    timestampBasis: 'CREATED_AT',
    filters: ['tenant-scoped', 'a cohort of attempts; each is classified by its state now'],
    supportedPeriods: REPORT_PERIODS,
    description: 'Payment attempts and what became of them.',
  },
  {
    name: 'payments.success_rate',
    kind: 'RATIO',
    formula: 'CONFIRMED / (CONFIRMED + FAILED + CANCELLED + EXPIRED) over payments.attempts',
    timestampBasis: 'CREATED_AT',
    filters: ['PENDING and UNKNOWN are in neither term', 'null when the denominator is zero'],
    supportedPeriods: REPORT_PERIODS,
    description: 'The share of decided attempts that took money.',
  },
  {
    name: 'referrals.signups',
    kind: 'COUNT',
    formula: 'count(referrals) where created_at is in the period',
    timestampBasis: 'CREATED_AT',
    filters: ['tenant-scoped'],
    supportedPeriods: REPORT_PERIODS,
    description: 'Customers attributed to a referrer at registration.',
  },
  {
    name: 'referrals.conversion',
    kind: 'RATIO',
    formula:
      "count(the period's referral signups whose referee has at least one sale, to date) / count(the period's referral signups)",
    timestampBasis: 'CREATED_AT',
    filters: [...SALE_FILTERS, 'a cohort of the period signups'],
    supportedPeriods: REPORT_PERIODS,
    description: 'How many referred signups became buyers.',
  },
  {
    name: 'referrals.rewards',
    kind: 'SUM_MONEY',
    formula:
      'sum(wallet_entries.amount) of REFERRAL_SIGNUP_GIFT, REFERRAL_COMMISSION and REFERRAL_COMMISSION_REVERSAL entries in the period, by reason and currency',
    timestampBasis: 'OCCURRED_AT',
    filters: ['tenant-scoped', 'money actually credited, from the ledger'],
    supportedPeriods: REPORT_PERIODS,
    description: 'Referral gifts and commissions granted. Not revenue.',
  },
  {
    name: 'referrals.revenue',
    kind: 'SUM_MONEY',
    formula: 'sales.revenue restricted to customers who are a referrals.referee_id',
    timestampBasis: 'PAID_AT',
    filters: SALE_FILTERS,
    supportedPeriods: REPORT_PERIODS,
    description: 'Revenue from referred customers.',
  },
  {
    name: 'resellers.sales',
    kind: 'SUM_MONEY',
    formula:
      'count and sum(orders.total_amount) of sales that carry an order_reseller_terms row, by reseller and currency',
    timestampBasis: 'PAID_AT',
    filters: [...SALE_FILTERS, 'margin_amount and cost_amount are never selected'],
    supportedPeriods: REPORT_PERIODS,
    description: 'What resellers bought. No profit, margin or settlement.',
  },
  {
    name: 'resellers.credit_in_use',
    kind: 'GAUGE',
    formula: "max(0, −wallet.balance) of the reseller, in the credit limit's currency, now",
    timestampBasis: 'OCCURRED_AT',
    filters: ['tenant-scoped'],
    supportedPeriods: [],
    description: 'How much of its credit line a reseller is using now.',
  },
  {
    name: 'failures.payments',
    kind: 'COUNT',
    formula:
      'count(payments) FAILED, CANCELLED or EXPIRED with resolved_at in the period; UNKNOWN now',
    timestampBasis: 'COMPLETED_AT',
    filters: ['tenant-scoped'],
    supportedPeriods: REPORT_PERIODS,
    description: 'Payment attempts that ended without money.',
  },
  {
    name: 'failures.operations',
    kind: 'COUNT',
    formula:
      'count(provisioning_operations) FAILED or ABANDONED with completed_at in the period, by type group and failure_kind; UNKNOWN now',
    timestampBasis: 'COMPLETED_AT',
    filters: ['tenant-scoped', 'UNKNOWN is not a failure', 'failure_message is never read'],
    supportedPeriods: REPORT_PERIODS,
    description: 'Provisioning and provider failures.',
  },
  /*
   * Round W (`docs/web-redesign/dashboard.md`): the dashboard and the sidebar. Each is a
   * split or a gauge over rows the reports already read — no second definition of a sale.
   */
  {
    name: 'sales.by_kind',
    kind: 'COUNT',
    formula:
      'count(orders) of sales.count, split by dashboardSaleKindOf(purpose): NEW (NEW_SERVICE, CUSTOM_SERVICE), RENEWAL (RENEW), ADDON (ADD_TRAFFIC, ADD_TIME, ADD_DEVICES, CHANGE_LOCATION)',
    timestampBasis: 'PAID_AT',
    filters: SALE_FILTERS,
    supportedPeriods: REPORT_PERIODS,
    description: 'The same sales, by what they bought. The three kinds add up to sales.count.',
  },
  {
    name: 'services.expiring',
    kind: 'GAUGE',
    formula:
      "count(services) where state = 'ACTIVE' and expires_at is in [now, now + 7 days) — the audience expiringWithinHours predicate",
    timestampBasis: 'OCCURRED_AT',
    filters: ['tenant-scoped', 'the canonical state, never inferred from expires_at alone'],
    supportedPeriods: [],
    description: 'Active services that expire within the next seven days.',
  },
  {
    name: 'panels.fleet',
    kind: 'GAUGE',
    formula:
      "count(panels) where status <> 'ARCHIVED', by status, projected health view (readHealth) and provider type",
    timestampBasis: 'OCCURRED_AT',
    filters: ['tenant-scoped', 'health is the latest probe only; DISABLED and UNCHECKED projected'],
    supportedPeriods: [],
    description: 'The fleet now: how many panels, how many active, and how healthy.',
  },
  {
    name: 'provisioning.queue',
    kind: 'GAUGE',
    formula:
      'count(provisioning_operations) in state PLANNED or IN_FLIGHT, and apart those in UNKNOWN; count(services) in state UNRECONCILED; now',
    timestampBasis: 'OCCURRED_AT',
    filters: ['tenant-scoped', 'UNKNOWN is not a failure: a READ decides'],
    supportedPeriods: [],
    description: 'Work waiting for a panel, and work whose outcome a READ must decide.',
  },
  /*
   * Phase E2 — Financial Reports V2 (`docs/financial-reports.md`). A STATEMENT: each fact
   * is counted once, on the timestamp it happened, and a later event is its own line — so a
   * closed period's figures never change. Three sections that are never added together:
   * sales (revenue recognised at settlement), cash from customers (money that arrived from
   * outside) and the wallet (stored value the tenant owes). A top-up is cash and a wallet
   * liability, never a sale; the wallet purchase that spends it is a sale, never cash.
   */
  {
    name: 'finance.sales',
    kind: 'SUM_MONEY',
    formula:
      "count, sum(subtotal_amount), sum(discount_amount), sum(total_amount) of orders with state in ('PAID','REFUNDED'), a sale purpose and settled_at in the period, grouped by currency",
    timestampBasis: 'PAID_AT',
    filters: [
      'state PAID or REFUNDED: a later refund is its own line (finance.refunds), never a rewrite of the period the sale was in',
      'purpose is a sale purpose (never TRIAL)',
      'one row per ORDER, never per payment attempt',
      'tenant-scoped',
    ],
    supportedPeriods: REPORT_PERIODS,
    description:
      'Sales recognised when the money for them was taken. Top-ups, cashback, gifts and commissions never enter it; a wallet purchase does, once.',
  },
  {
    name: 'finance.refunds',
    kind: 'SUM_MONEY',
    formula:
      "count, sum(amount) of refunds with state = 'COMPLETED' and completed_at in the period, grouped by currency and channel (WALLET_CREDIT, EXTERNAL_MANUAL, PROVIDER)",
    timestampBasis: 'COMPLETED_AT',
    filters: [
      'COMPLETED only: a requested or failed refund gave nothing back',
      'every refund names an order payment; a top-up is not refundable',
      'partial refunds are separate rows and sum to at most the payment',
      'tenant-scoped',
    ],
    supportedPeriods: REPORT_PERIODS,
    description: 'Sales money given back, on the day it was given back.',
  },
  {
    name: 'finance.net_sales',
    kind: 'SUM_MONEY',
    formula: 'finance.sales total − finance.refunds amount, per currency, same period',
    timestampBasis: 'PAID_AT',
    filters: ['never across currencies', 'tenant-scoped'],
    supportedPeriods: REPORT_PERIODS,
    description: 'Sales net of the refunds completed in the same period.',
  },
  {
    name: 'finance.customer_paid',
    kind: 'SUM_MONEY',
    formula:
      "count, sum(amount) (principal), sum(customer_fee_amount) and sum(coalesce(payable_amount, amount)) of payments with state = 'CONFIRMED', method <> 'WALLET' and confirmed_at in the period, grouped by currency, method, route and kind (ORDER or TOPUP)",
    timestampBasis: 'PAID_AT',
    filters: [
      'external money only: a WALLET payment spends stored value and is never cash',
      'the customer gateway fee is beside the principal, never inside revenue',
      'a fee the provider deducted is not recorded and is not reported',
      'tenant-scoped',
    ],
    supportedPeriods: REPORT_PERIODS,
    description:
      'What customers paid from outside, before any provider deduction: the principal, the gateway fee they bore, and the two together.',
  },
  {
    name: 'finance.receipt_credits',
    kind: 'SUM_MONEY',
    formula:
      "count, sum(amount) of wallet_entries with reason = 'RECEIPT_CREDIT' and created_at in the period, grouped by currency",
    timestampBasis: 'OCCURRED_AT',
    filters: [
      'the receipt payment itself is FAILED and is not in finance.customer_paid',
      'tenant-scoped',
    ],
    supportedPeriods: REPORT_PERIODS,
    description: 'Card-to-card money a reviewer credited to a wallet instead of confirming.',
  },
  {
    name: 'finance.wallet_liability',
    kind: 'SUM_MONEY',
    formula:
      'per currency: opening = Σ signed wallet_entries before the period; movement per WALLET_REPORT_GROUPS group = Σ signed in the period; closing = Σ signed before the period end. opening + Σ movements = closing',
    timestampBasis: 'OCCURRED_AT',
    filters: ['signed by the ledger rule: CREDIT +, DEBIT −', 'tenant-scoped'],
    supportedPeriods: REPORT_PERIODS,
    description:
      'The stored value customers hold, and why it moved: top-ups, receipt credits, spending, refunds, cashback, commissions, gifts, administration and transfers.',
  },
  {
    name: 'finance.sales_by_channel',
    kind: 'SUM_MONEY',
    formula:
      "finance.sales split by the method and route of the order's one CONFIRMED payment (payments_order_confirmed_key); NONE when no payment was needed",
    timestampBasis: 'PAID_AT',
    filters: ['the parts add up to finance.sales', 'tenant-scoped'],
    supportedPeriods: REPORT_PERIODS,
    description: 'Which sales were paid from the wallet and which by each external route.',
  },
  {
    name: 'finance.sales_by_product',
    kind: 'SUM_MONEY',
    formula:
      'finance.sales grouped by (product_id, snapshot line_title, currency), with finance.refunds of those products’ orders in the same period beside them',
    timestampBasis: 'PAID_AT',
    filters: ['the title is the snapshot the product was sold under', 'tenant-scoped'],
    supportedPeriods: REPORT_PERIODS,
    description: 'Sales and refunds per product, by the name it was sold under.',
  },
  {
    name: 'finance.reseller_sales',
    kind: 'SUM_MONEY',
    formula:
      'count, sum(total_amount) of finance.sales rows that have an order_reseller_terms row, grouped by currency',
    timestampBasis: 'PAID_AT',
    filters: ['what the reseller was charged; margin and cost are never read', 'tenant-scoped'],
    supportedPeriods: REPORT_PERIODS,
    description: 'The part of sales bought by resellers.',
  },
  {
    name: 'nav.counters',
    kind: 'GAUGE',
    formula:
      'per sidebar link, now: open management conditions; tickets OPEN or WAITING_FOR_SUPPORT; ACTIVE panels whose latest probe is not HEALTHY; services UNRECONCILED; refund requests OPEN, EXECUTING or FAILED; payments UNKNOWN — each capped at COUNTER_CAP',
    timestampBasis: 'OCCURRED_AT',
    filters: ['tenant-scoped', "withheld unless the viewer holds the linked page's permission"],
    supportedPeriods: [],
    description: 'What is waiting for an operator behind each sidebar link.',
  },
];

const METRIC_BY_NAME = new Map(METRIC_DEFINITIONS.map((m) => [m.name, m]));

export function isRegisteredMetric(name: string): boolean {
  return METRIC_BY_NAME.has(name);
}

export function metricDefinition(name: string): MetricDefinition {
  const found = METRIC_BY_NAME.get(name);
  if (!found) {
    throw new Error(
      `Metric "${name}" has no registry entry. Every reported number must be defined once, in @nexa/contracts.`,
    );
  }
  return found;
}
