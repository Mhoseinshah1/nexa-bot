import { z } from 'zod';
import type { OrderPurpose } from './commerce.js';
import { CURRENCY_CODES } from './money.js';
import { PANEL_HEALTH_STATES, PANEL_HEALTH_VIEWS, type PanelHealthState } from './panels.js';
import { PAYMENT_METHODS } from './payment.js';
import type { PermissionKey } from './permissions.js';
import type { OperationState } from './provisioning.js';
import type { TicketStatus } from './tickets.js';
import {
  countComparisonSchema,
  moneyComparisonSchema,
  reportBucketSchema,
  reportPeriodSchema,
} from './reporting.js';

/**
 * The Web Admin dashboard and the sidebar counters (round W, `docs/web-redesign/dashboard.md`).
 *
 * Read-only aggregates, three routes, one question each:
 *
 *   - `summary`: the business figures for one period — the owner's section. It is WP12's
 *     reports, not a second reading of them: every figure is one of `METRIC_DEFINITIONS`,
 *     computed by `ReportingService` over the same repository and the same tenant-calendar
 *     period resolver, behind the same Super Admin gate (the owner role AND `reports.view`).
 *   - `operations`: what the fleet and the provisioning lane look like NOW. Each section is
 *     present only when the viewer holds the permission of the page it summarises.
 *   - `navCounters`: the few counts the sidebar draws beside a link, each withheld (`null`)
 *     unless the viewer holds the permission of the page that link opens.
 *
 * Nothing here is a write, a secret or a customer's profile field.
 */

// --- Routes and cadence -----------------------------------------------------------

export const DASHBOARD_ROUTES = {
  summary: '/dashboard/summary',
  operations: '/dashboard/operations',
  navCounters: '/nav-counters',
} as const;

/**
 * The business summary is re-read once a minute. It is about twenty statements, each bounded
 * by the tenant and ONE half-open window (the selected period, today or this month, and each
 * one's previous equivalent). It deliberately carries none of the two figures whose cost is
 * not bounded by a window — new buyers (every customer's earliest sale) and active customers —
 * which stay on the five-minute `REPORT_REFRESH_INTERVAL_MS` report summary.
 */
export const DASHBOARD_SUMMARY_REFRESH_MS = 60_000;

/** Operational gauges: a handful of indexed counts. */
export const DASHBOARD_OPERATIONS_REFRESH_MS = 30_000;

/** The sidebar's counts, shared by every page: one request a minute per tab. */
export const NAV_COUNTERS_REFRESH_MS = 60_000;

/** "Expiring soon" on the dashboard: an ACTIVE service with an expiry in `[now, now + 7 days)`. */
export const DASHBOARD_EXPIRING_WITHIN_DAYS = 7;

/**
 * The most any one counter counts. A count is bounded by a `LIMIT` on the rows it reads, so a
 * pathological backlog costs the same as a large one; the value `COUNTER_CAP` means "this many
 * or more", and the sidebar draws it that way.
 */
export const COUNTER_CAP = 1000;

// --- Classifiers ------------------------------------------------------------------

/**
 * What kind of SALE an order of this purpose is, for the orders-and-renewals chart.
 *
 * `NEW` bought a service that did not exist (a product, or a custom service); `RENEWAL` renewed
 * one; `ADDON` added to one (traffic, time, devices, a location move). A TRIAL is not a sale
 * and has no kind. Exhaustive by `switch`, so a purpose added to `ORDER_PURPOSES` must be
 * placed here before it compiles, and a unit test holds this to `orderPurposeIsSale`: the
 * three kinds partition exactly the `sales.count` rows, so the bars of one bucket add up to
 * that bucket's sales.
 */
export const DASHBOARD_SALE_KINDS = ['NEW', 'RENEWAL', 'ADDON'] as const;
export type DashboardSaleKind = (typeof DASHBOARD_SALE_KINDS)[number];

export function dashboardSaleKindOf(purpose: OrderPurpose): DashboardSaleKind | null {
  switch (purpose) {
    case 'NEW_SERVICE':
    case 'CUSTOM_SERVICE':
      return 'NEW';
    case 'RENEW':
      return 'RENEWAL';
    case 'ADD_TRAFFIC':
    case 'ADD_TIME':
    case 'ADD_DEVICES':
    case 'CHANGE_LOCATION':
      return 'ADDON';
    case 'TRIAL':
      return null;
    default: {
      const unreachable: never = purpose;
      throw new Error(`unclassified order purpose ${String(unreachable)}`);
    }
  }
}

// --- Summary (business, Super Admin) -----------------------------------------------

const count = z.number().int().nonnegative();
const minorString = z.string().regex(/^-?\d+$/, 'must be an integer string');
const iso = z.iso.datetime();

/**
 * One fixed window the dashboard always shows beside the selected one: today, or this
 * calendar month in the tenant's calendar. Compared like for like with its previous
 * equivalent (yesterday up to the same time; last month's same elapsed span).
 */
export const dashboardFixedWindowSchema = z.object({
  period: reportPeriodSchema,
  /** `sales.revenue`, per currency. */
  revenue: moneyComparisonSchema,
  /** `sales.count`. */
  sales: countComparisonSchema,
  /** The current side's revenue in the summary's `currency`, by bucket. Null: not begun. */
  series: z.array(reportBucketSchema),
});
export type DashboardFixedWindow = z.infer<typeof dashboardFixedWindowSchema>;

/** One bucket of the orders chart: the sales of each kind. Null for a bucket not yet begun. */
export const dashboardSalesBucketSchema = z.object({
  index: count,
  start: iso,
  end: iso,
  label: z.string(),
  counts: z.object({ NEW: count, RENEWAL: count, ADDON: count }).nullable(),
});
export type DashboardSalesBucket = z.infer<typeof dashboardSalesBucketSchema>;

export const dashboardSummaryResponseSchema = z.object({
  /** The selected period, resolved exactly as every report resolves it. */
  period: reportPeriodSchema,
  /** The tenant's sales currency: the series and the money headlines are in it. */
  currency: z.enum(CURRENCY_CODES),
  /** Every currency revenue was taken in during any window here. More than one: a note. */
  currencies: z.array(z.enum(CURRENCY_CODES)),
  today: dashboardFixedWindowSchema,
  month: dashboardFixedWindowSchema,
  selected: z.object({
    /** `sales.revenue` and `sales.count` over the selected period. */
    revenue: moneyComparisonSchema,
    sales: countComparisonSchema,
    /** `sales.renewals`. */
    renewals: countComparisonSchema,
    /** `customers.new`. */
    newCustomers: countComparisonSchema,
    /** `failures.payments`, the FAILED part: attempts resolved FAILED in the period. */
    failedPayments: countComparisonSchema,
    /** `sales.revenue` by bucket in `currency`, both sides, bucket `i` against bucket `i`. */
    revenueSeries: z.object({
      current: z.array(reportBucketSchema),
      previous: z.array(reportBucketSchema),
    }),
    /** `customers.new` by bucket, current side. */
    newCustomerSeries: z.array(reportBucketSchema),
    /** `sales.by_kind` by bucket, current side. */
    salesByKind: z.array(dashboardSalesBucketSchema),
    /**
     * `payments.attempts`, ORDER payments only: per method, the attempts created in the period
     * that were CONFIRMED, and their amount per currency.
     */
    paymentMethods: z.array(
      z.object({
        method: z.enum(PAYMENT_METHODS),
        confirmed: count,
        confirmedAmount: z.array(
          z.object({ currency: z.enum(CURRENCY_CODES), amount: minorString }),
        ),
      }),
    ),
  }),
  /** `services.active`, now. A gauge: no stored history, so no comparison and no trend. */
  activeServices: count,
});
export type DashboardSummaryResponse = z.infer<typeof dashboardSummaryResponseSchema>;

// --- Operations (per-section permission) --------------------------------------------

/** The permission each operations section is drawn under: the page it summarises. */
/** A provisioning operation still waiting for, or holding, its turn at a panel. */
export const DASHBOARD_QUEUED_OPERATION_STATES = [
  'PLANNED',
  'IN_FLIGHT',
] as const satisfies readonly OperationState[];

export const DASHBOARD_OPERATION_SECTIONS = ['panels', 'provisioning', 'expiring'] as const;
export type DashboardOperationSection = (typeof DASHBOARD_OPERATION_SECTIONS)[number];

export const DASHBOARD_OPERATION_PERMISSIONS: Readonly<
  Record<DashboardOperationSection, PermissionKey>
> = {
  panels: 'panels.view',
  provisioning: 'services.view',
  expiring: 'services.view',
};

export const dashboardOperationsResponseSchema = z.object({
  generatedAt: iso,
  /**
   * The fleet: every panel that is not ARCHIVED, counted once. Health is the projected view
   * (`readHealth`): DISABLED from the status, UNCHECKED where no probe has run. Null without
   * `panels.view`.
   */
  panels: z
    .object({
      total: count,
      active: count,
      health: z.array(z.object({ state: z.enum(PANEL_HEALTH_VIEWS), count })),
      providers: z.array(z.object({ providerType: z.string(), providerName: z.string(), count })),
    })
    .nullable(),
  /**
   * The provisioning lane, now: operations PLANNED or IN_FLIGHT (queued), operations whose
   * outcome is UNKNOWN (a READ decides; never retried), and services UNRECONCILED. Null
   * without `services.view`.
   */
  provisioning: z.object({ queued: count, unknown: count, unreconciledServices: count }).nullable(),
  /** `services.expiring`: ACTIVE with an expiry in `[now, now + withinDays)`. */
  expiring: z.object({ withinDays: count, count }).nullable(),
});
export type DashboardOperationsResponse = z.infer<typeof dashboardOperationsResponseSchema>;

// --- Sidebar counters -------------------------------------------------------------

/**
 * The sidebar's counts. Each is something an operator can act on from the page it sits
 * beside, and each is withheld — `null` — unless the viewer holds that page's permission.
 */
export const NAV_COUNTER_KEYS = [
  'openConditions',
  'ticketsAwaitingSupport',
  'unhealthyPanels',
  'unreconciledServices',
  'refundRequestsAwaiting',
  'paymentsUnknown',
] as const;
export type NavCounterKey = (typeof NAV_COUNTER_KEYS)[number];

export const NAV_COUNTER_PERMISSIONS: Readonly<Record<NavCounterKey, PermissionKey>> = {
  /** `/alerts`: management conditions still open. */
  openConditions: 'opslog.view',
  /** `/tickets`: OPEN or WAITING_FOR_SUPPORT — the next word is support's. */
  ticketsAwaitingSupport: 'tickets.view',
  /** `/panels`: ACTIVE panels whose latest probe was DEGRADED, UNREACHABLE or AUTH_FAILED. */
  unhealthyPanels: 'panels.view',
  /** `/services`: services UNRECONCILED — a create whose answer was lost. */
  unreconciledServices: 'services.view',
  /** `/services` refund requests: `SERVICE_REFUND_REQUEST_ATTENTION_STATES`. */
  refundRequestsAwaiting: 'refunds.view',
  /** `/payments`: payments in state UNKNOWN, awaiting reconciliation. */
  paymentsUnknown: 'payments.view',
};

/** A ticket whose next word is support's: nobody has answered yet, or the customer has. */
export const TICKET_AWAITING_SUPPORT_STATUSES = [
  'OPEN',
  'WAITING_FOR_SUPPORT',
] as const satisfies readonly TicketStatus[];

/**
 * A panel worth a look: ACTIVE, probed, and not HEALTHY. Wider than
 * `PANEL_UNUSABLE_HEALTH_STATES` on purpose — DEGRADED still sells, and is still worth an
 * operator's glance. DISABLED and UNCHECKED are never stored, so they cannot be counted here.
 */
export const NAV_ATTENTION_PANEL_HEALTH_STATES: readonly PanelHealthState[] =
  PANEL_HEALTH_STATES.filter((state) => state !== 'HEALTHY');

const counter = z.number().int().min(0).max(COUNTER_CAP).nullable();

export const navCountersResponseSchema = z.object({
  generatedAt: iso,
  counters: z.object({
    openConditions: counter,
    ticketsAwaitingSupport: counter,
    unhealthyPanels: counter,
    unreconciledServices: counter,
    refundRequestsAwaiting: counter,
    paymentsUnknown: counter,
  }),
});
export type NavCountersResponse = z.infer<typeof navCountersResponseSchema>;
