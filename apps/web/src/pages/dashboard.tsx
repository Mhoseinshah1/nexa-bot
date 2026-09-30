import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DASHBOARD_OPERATIONS_REFRESH_MS,
  DASHBOARD_SUMMARY_REFRESH_MS,
  REPORT_PRODUCT_RANKINGS,
  type CurrencyCode,
  type DashboardOperationsResponse,
  type DashboardSummaryResponse,
  type MoneyComparison,
  type PaymentMethod,
  type ReportProductRanking,
} from '@nexa/contracts';
import {
  fetchDashboardOperations,
  fetchDashboardSummary,
  fetchOpsLog,
  fetchReadiness,
  fetchReportFailures,
  fetchReportProducts,
  fetchReportSummary,
  type ReportRangeSelection,
} from '../api/client';
import {
  DASHBOARD_PRESET_RANGES,
  REVENUE_TITLES,
  axisLabel,
  chartMoneyText,
  chartMoneyValue,
  compareFromRoute,
  countValues,
  dashboardSelection,
  kpiDelta,
  moneyRow,
  presetOf,
  type DeltaSense,
} from '../dashboard-view';
import { currencyLabel, formatMoney, formatNumber, formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { pollUnlessFinal } from '../polling';
import { BUSINESS_REFRESH_MS, rangeIsComplete } from '../report-view';
import { setQueries, useLinkHandler, type Route } from '../router';
import {
  AlertStatCard,
  BarChart,
  Badge,
  Card,
  ChartCard,
  DataTable,
  Distribution,
  Donut,
  Empty,
  IconButton,
  Input,
  KV,
  Legend,
  LineChart,
  Money,
  Num,
  PageHead,
  PeriodControl,
  Pills,
  Sparkline,
  StateSwitch,
  Stat,
  StatCard,
  type Column,
  type DistributionSlice,
  type PeriodPreset,
  type Tone,
  Quantity,
} from '../ui/kit';
import type { SeriesTone } from '../ui/charts';
import type { QueryView } from '../view-state';
import { mayRequest, queryState, shownData } from '../view-state';
import { formatInstantIn } from './business';

/** How many open conditions the attention card draws before it counts the rest. */
const ATTENTION_SHOWN = 6;

/** The compact product ranking: the reference's five, with the full list one click away. */
const TOP_PRODUCTS_SHOWN = 5;

/** Readiness and the attention list are read together, so they share one cadence. */
const LIVE_REFRESH_MS = 15_000;

const NO_ROUTE: Route = { path: '/', query: new URLSearchParams() };

/**
 * The dashboard (`docs/web-redesign/dashboard.md`).
 *
 * Every figure on it is a real figure from a real endpoint. The business figures
 * are the owner's — `GET /dashboard/summary`, WP12's reports resolved in the
 * tenant's timezone and calendar and computed by server aggregates over persisted
 * orders, payments and customers — and the operational ones come from
 * `GET /dashboard/operations`, each section computed only for a viewer holding the
 * permission of the page it summarises. A dashboard that invents a KPI is the
 * single most damaging thing this product could ship, since a KPI is exactly the
 * kind of number nobody re-derives before acting on it; so a figure without a
 * trustworthy source is not drawn at all (24-hour traffic is the named case).
 *
 * The owner revisions still hold:
 *
 *   - **Revision 1** — no abbreviated money. Every amount is `<Money>` or
 *     `formatMoney` over the exact minor-unit string.
 *   - **Revision 2** — the breakdown is by PANEL, not by location.
 *   - **Revision 3** — "needs attention" is open management conditions only.
 *
 * Cadence: the business summary once a minute, the operational gauges every
 * thirty seconds, readiness and the attention list every fifteen, and the three
 * report cards at the reports' own five minutes. Switching the period asks
 * again; switching the comparison does not — it is a drawing choice over figures
 * already held.
 */
export function DashboardPage({
  permissions,
  route = NO_ROUTE,
  superAdmin = false,
}: {
  permissions: readonly string[];
  route?: Route;
  /** The owner holding `reports.view`: the business figures are drawn as well. */
  superAdmin?: boolean;
}) {
  const mayViewPanels = permissions.includes('panels.view');
  const mayViewServices = permissions.includes('services.view');
  const mayViewOps = permissions.includes('opslog.view');
  const selection = dashboardSelection(route);
  const compare = compareFromRoute(route);
  const complete = rangeIsComplete(selection);

  const readiness = useQuery({
    queryKey: ['readiness'],
    queryFn: fetchReadiness,
    refetchInterval: pollUnlessFinal(LIVE_REFRESH_MS),
  });

  const summary = useQuery({
    queryKey: ['dashboard', 'summary', selection],
    queryFn: () => fetchDashboardSummary(selection),
    enabled: superAdmin && complete,
    refetchInterval: pollUnlessFinal(DASHBOARD_SUMMARY_REFRESH_MS),
  });

  /*
   * One request for every operational section. The server computes only the
   * sections this viewer may see and answers `null` for the rest, so a viewer
   * holding neither permission is not asked at all.
   */
  const operations = useQuery({
    queryKey: ['dashboard', 'operations'],
    queryFn: fetchDashboardOperations,
    enabled: mayViewPanels || mayViewServices,
    refetchInterval: pollUnlessFinal(DASHBOARD_OPERATIONS_REFRESH_MS),
  });

  /**
   * `MANAGEMENT_CONDITIONS`, not `MANAGEMENT`: every row on a card headed "needs
   * attention" has to be something an operator can still act on, and the wider
   * scope carries one-shot records that open and are never resolved. The card
   * polls because it is the one thing on the page that must not be a photograph —
   * `refetchOnWindowFocus` is off, and a wall display must see an incident start
   * and end.
   */
  const alerts = useQuery({
    queryKey: ['ops-log', 'management-conditions', 'open'],
    queryFn: () => fetchOpsLog({ scope: 'MANAGEMENT_CONDITIONS', open: true }),
    enabled: mayViewOps,
    refetchInterval: pollUnlessFinal(LIVE_REFRESH_MS),
  });

  const client = useQueryClient();
  const shownSummary = shownData(summary, queryState(summary), summary.data);
  const shownOperations = shownData(operations, queryState(operations), operations.data);

  const choosePreset = (preset: PeriodPreset) => {
    const range = DASHBOARD_PRESET_RANGES[preset];
    if (range === 'CUSTOM') {
      setQueries(route, [['range', 'CUSTOM']]);
      return;
    }
    setQueries(route, [
      ['range', range],
      ['from', null],
      ['to', null],
    ]);
  };

  return (
    <>
      <PageHead
        title={t('web.dashboard_title')}
        subtitle={
          <>
            {t('web.dashboard_intro')}
            <LastUpdated
              summary={superAdmin ? shownSummary : undefined}
              operations={shownOperations}
            />
          </>
        }
        {...(superAdmin
          ? {
              actions: (
                <>
                  <PeriodControl
                    value={presetOf(selection.range)}
                    onChange={choosePreset}
                    compare={compare}
                    onCompareChange={(next) => setQueries(route, [['compare', next ? null : '0']])}
                    custom={
                      <CustomRange
                        key={`${selection.from ?? ''}|${selection.to ?? ''}`}
                        route={route}
                        from={selection.from ?? ''}
                        to={selection.to ?? ''}
                      />
                    }
                  />
                  {/*
                   * Re-asks every business figure now, as `main`'s business section
                   * did. Withheld after a final answer: pressing it would only be
                   * refused again (`mayRequest`).
                   */}
                  {mayRequest(summary, !complete) && (
                    <IconButton
                      icon="refresh"
                      label={t('web.report_refresh')}
                      variant="default"
                      size="sm"
                      onClick={() => {
                        void client.invalidateQueries({ queryKey: ['dashboard'] });
                        void client.invalidateQueries({ queryKey: ['reports'] });
                      }}
                    />
                  )}
                </>
              ),
            }
          : {})}
      />

      {superAdmin &&
        (complete ? (
          <BusinessKpis query={summary} data={shownSummary} compare={compare} />
        ) : (
          <Card title={t('web.dashboard_business')}>
            <Empty title={t('web.dashboard_custom_needed')} icon="calendar" variant="compact" />
          </Card>
        ))}

      <OperationsKpis
        query={operations}
        data={shownOperations}
        asked={mayViewPanels || mayViewServices}
        summary={superAdmin ? shownSummary : undefined}
        compare={compare}
      />

      {superAdmin && shownSummary !== undefined && (
        <div className="dash-charts">
          <RevenueChart data={shownSummary} compare={compare} />
          <SalesByKindChart data={shownSummary} />
        </div>
      )}

      {superAdmin && complete && (
        <div className="dash-row">
          <PaymentMethods query={summary} data={shownSummary} />
          <TopProducts selection={selection} />
          <FailureSummary selection={selection} />
        </div>
      )}

      {superAdmin && complete && <OtherFigures selection={selection} />}

      <div className="dash-row">
        {mayViewPanels && <FleetCard query={operations} data={shownOperations} />}
        <Card title={t('web.system_status')}>
          <StateSwitch query={readiness}>
            <div className="head-stats">
              {(readiness.data?.dependencies ?? []).map((dependency) => (
                <Stat
                  key={dependency.name}
                  label={dependency.name}
                  value={dependency.status === 'up' ? t('web.up') : t('web.down')}
                  tone={dependency.status === 'up' ? 'ok' : 'danger'}
                  // `latencyMs` is OPTIONAL on the wire, not nullable: a dependency
                  // that reports no timing omits it, and guarding on `null` once
                  // rendered the literal text "undefined ms".
                  {...(dependency.latencyMs === undefined
                    ? {}
                    : { hint: `${formatNumber(dependency.latencyMs)} ms` })}
                />
              ))}
            </div>
          </StateSwitch>
        </Card>
        {mayViewOps && <AttentionCard query={alerts} />}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Page head
// ---------------------------------------------------------------------------

/**
 * When the figures on screen were computed — by the server, not by this tab.
 * The business summary carries the tenant's timezone and calendar, so its time
 * is drawn in them; the operational gauges carry only an instant.
 */
function LastUpdated({
  summary,
  operations,
}: {
  summary: DashboardSummaryResponse | undefined;
  operations: DashboardOperationsResponse | undefined;
}) {
  const text =
    summary !== undefined
      ? formatInstantIn(
          summary.period.generatedAt,
          summary.period.timezone,
          summary.period.calendar,
        )
      : operations !== undefined
        ? formatTimestamp(operations.generatedAt)
        : null;
  if (text === null) return null;
  return (
    <span className="dash-updated">
      {t('web.dashboard_updated_at')} <Quantity>{text}</Quantity>
    </span>
  );
}

/**
 * A custom range: two dates in the TENANT's calendar (`1405-07-01`), which the
 * server converts — the browser never decides where a day begins. Keyed by the
 * applied dates, so a range that arrives by history starts a fresh draft.
 */
function CustomRange({ route, from, to }: { route: Route; from: string; to: string }) {
  const [draft, setDraft] = useState({ from, to });
  const apply = (event: FormEvent) => {
    event.preventDefault();
    setQueries(route, [
      ['range', 'CUSTOM'],
      ['from', draft.from.trim()],
      ['to', draft.to.trim()],
    ]);
  };
  return (
    <form className="dash-custom" onSubmit={apply}>
      <Input
        size="sm"
        dir="ltr"
        aria-label={t('web.report_range_from')}
        title={t('web.report_range_date_hint')}
        placeholder="1405-07-01"
        value={draft.from}
        onChange={(event) => setDraft({ ...draft, from: event.target.value })}
      />
      <Input
        size="sm"
        dir="ltr"
        aria-label={t('web.report_range_to')}
        title={t('web.report_range_date_hint')}
        placeholder="1405-07-30"
        value={draft.to}
        onChange={(event) => setDraft({ ...draft, to: event.target.value })}
      />
      <button type="submit" className="btn sm">
        {t('web.report_range_apply')}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Business KPIs (owner)
// ---------------------------------------------------------------------------

/** A delta only while comparison is on; the figure itself never depends on it. */
function deltaIf(
  compare: boolean,
  current: bigint,
  previous: bigint,
  sense: DeltaSense,
  caption?: string,
) {
  return compare ? { delta: kpiDelta(current, previous, sense, caption) } : {};
}

/** The headline amount in the tenant's currency, exact, with its unit apart. */
function moneyHeadline(rows: MoneyComparison, currency: CurrencyCode) {
  const row = moneyRow(rows, currency);
  const { amount, unit } = formatMoney({ amountMinor: row.current, currency });
  return { row, amount, unit };
}

/** Other currencies taken in a window, each exact. Nothing is ever summed across them. */
function OtherCurrencies({ rows, currency }: { rows: MoneyComparison; currency: CurrencyCode }) {
  const others = rows.filter((row) => row.currency !== currency && row.current !== '0');
  if (others.length === 0) return null;
  return (
    <span className="dash-amounts">
      {t('web.dashboard_other_currencies')}
      {others.map((row) => (
        <Money key={row.currency} value={{ amountMinor: row.current, currency: row.currency }} />
      ))}
    </span>
  );
}

function BusinessKpis({
  query,
  data,
  compare,
}: {
  query: QueryView;
  data: DashboardSummaryResponse | undefined;
  compare: boolean;
}) {
  if (data === undefined) {
    return (
      <Card title={t('web.dashboard_business')}>
        <StateSwitch query={query}>{null}</StateSwitch>
      </Card>
    );
  }
  const currency = data.currency;
  const today = moneyHeadline(data.today.revenue, currency);
  const month = moneyHeadline(data.month.revenue, currency);
  const s = data.selected;
  const failed = s.failedPayments;
  const FailedCard = failed.current > 0 ? AlertStatCard : StatCard;
  return (
    <StateSwitch query={query}>
      <div className="dash-kpis">
        <StatCard
          label={t('web.dashboard_today_sales')}
          icon="zap"
          value={today.amount}
          unit={today.unit}
          {...deltaIf(
            compare,
            BigInt(today.row.current),
            BigInt(today.row.previous),
            'up-good',
            t('web.dashboard_vs_yesterday'),
          )}
          hint={
            <>
              <span>
                <Num value={data.today.sales.current} /> {t('web.dashboard_sales_unit')}
              </span>
              <OtherCurrencies rows={data.today.revenue} currency={currency} />
            </>
          }
        >
          <Sparkline
            values={data.today.series.map((b) => chartMoneyValue(b.value, currency))}
            label={t('web.dashboard_today_sales')}
          />
        </StatCard>
        <StatCard
          label={t('web.dashboard_month_sales')}
          icon="wallet"
          value={month.amount}
          unit={month.unit}
          {...deltaIf(
            compare,
            BigInt(month.row.current),
            BigInt(month.row.previous),
            'up-good',
            t('web.dashboard_vs_last_month'),
          )}
          hint={
            <>
              <span>
                <Num value={data.month.sales.current} /> {t('web.dashboard_sales_unit')}
              </span>
              <OtherCurrencies rows={data.month.revenue} currency={currency} />
            </>
          }
        >
          <Sparkline
            values={data.month.series.map((b) => chartMoneyValue(b.value, currency))}
            label={t('web.dashboard_month_sales')}
          />
        </StatCard>
        {/* A gauge: there is no stored history of a state, so no delta and no trend. */}
        <StatCard
          label={t('web.dashboard_active_services')}
          icon="services"
          value={formatNumber(data.activeServices)}
          hint={t('web.dashboard_now')}
        />
        <StatCard
          label={t('web.dashboard_new_customers')}
          icon="users"
          value={formatNumber(s.newCustomers.current)}
          {...deltaIf(
            compare,
            BigInt(s.newCustomers.current),
            BigInt(s.newCustomers.previous),
            'up-good',
          )}
        >
          <Sparkline
            values={countValues(s.newCustomerSeries.map((b) => b.value))}
            label={t('web.dashboard_new_customers')}
            tone={2}
          />
        </StatCard>
        <StatCard
          label={t('web.dashboard_renewals')}
          icon="refresh"
          value={formatNumber(s.renewals.current)}
          {...deltaIf(compare, BigInt(s.renewals.current), BigInt(s.renewals.previous), 'up-good')}
        >
          <Sparkline
            values={s.salesByKind.map((b) => (b.counts === null ? null : b.counts.RENEWAL))}
            label={t('web.dashboard_renewals')}
            tone={2}
          />
        </StatCard>
        {/* Up is BAD here; the card is outlined only while there is something to look at. */}
        <FailedCard
          label={t('web.dashboard_failed_payments')}
          icon="alert"
          value={formatNumber(failed.current)}
          {...(failed.current > 0 ? { tone: 'warn' as const } : {})}
          {...deltaIf(compare, BigInt(failed.current), BigInt(failed.previous), 'up-bad')}
        />
      </div>
    </StateSwitch>
  );
}

// ---------------------------------------------------------------------------
// Operational KPIs
// ---------------------------------------------------------------------------

const HEALTH_LABELS: Readonly<Record<string, WebKey>> = {
  HEALTHY: 'web.health_healthy',
  DEGRADED: 'web.health_degraded',
  UNREACHABLE: 'web.health_unreachable',
  AUTH_FAILED: 'web.health_auth_failed',
  DISABLED: 'web.health_disabled',
  UNCHECKED: 'web.health_unchecked',
};

export const HEALTH_TONES: Readonly<Record<string, Tone>> = {
  HEALTHY: 'ok',
  DEGRADED: 'warn',
  UNREACHABLE: 'danger',
  AUTH_FAILED: 'danger',
  DISABLED: 'neutral',
  UNCHECKED: 'neutral',
};

/** The health states named under the fleet figure: a probe said something is wrong. */
const TROUBLED_HEALTH: readonly string[] = ['DEGRADED', 'UNREACHABLE', 'AUTH_FAILED'];

function OperationsKpis({
  query,
  data,
  asked,
  summary,
  compare,
}: {
  query: QueryView;
  data: DashboardOperationsResponse | undefined;
  /** Whether this viewer's operations were asked for at all. */
  asked: boolean;
  summary: DashboardSummaryResponse | undefined;
  compare: boolean;
}) {
  if (asked && data === undefined) {
    return (
      <Card title={t('web.dashboard_operations')}>
        <StateSwitch query={query}>{null}</StateSwitch>
      </Card>
    );
  }
  const expiring = data?.expiring ?? null;
  const fleet = data?.panels ?? null;
  const provisioning = data?.provisioning ?? null;
  if (expiring === null && fleet === null && provisioning === null && summary === undefined) {
    return null;
  }
  const troubled = (fleet?.health ?? []).filter(
    (row) => row.count > 0 && TROUBLED_HEALTH.includes(row.state),
  );
  const down = troubled.some((row) => row.state !== 'DEGRADED');
  const needsReview =
    provisioning === null ? 0 : provisioning.unknown + provisioning.unreconciledServices;
  const cards = [expiring, fleet, provisioning, summary ?? null].filter((x) => x !== null).length;
  return (
    <div className={`dash-kpis n${cards}`}>
      {expiring !== null && (
        <StatCard
          label={`${t('web.dashboard_expiring')} (${formatNumber(expiring.withinDays)} ${t('web.dashboard_days')})`}
          icon="clock"
          value={formatNumber(expiring.count)}
          hint={t('web.dashboard_expiring_hint')}
        />
      )}
      {fleet !== null && (
        <StatCard
          label={t('web.dashboard_active_panels')}
          icon="panels"
          value={
            <>
              {formatNumber(fleet.active)}
              <small>/ {formatNumber(fleet.total)}</small>
            </>
          }
          {...(down
            ? { tone: 'alert' as const }
            : troubled.length > 0
              ? { tone: 'warn' as const }
              : {})}
          hint={
            troubled.length === 0 ? (
              t('web.dashboard_panels_ok')
            ) : (
              <span>
                {troubled.map((row, index) => (
                  <span key={row.state}>
                    {index > 0 && ' · '}
                    <Num value={row.count} />{' '}
                    {t(HEALTH_LABELS[row.state] ?? 'web.health_unchecked')}
                  </span>
                ))}
              </span>
            )
          }
        />
      )}
      {provisioning !== null && (
        <StatCard
          label={t('web.dashboard_queue')}
          icon="layers"
          value={formatNumber(provisioning.queued)}
          unit={t('web.dashboard_queue_waiting')}
          {...(needsReview > 0 ? { tone: 'warn' as const } : {})}
          hint={
            needsReview === 0 ? (
              t('web.dashboard_queue_clear')
            ) : (
              <span>
                <Num value={provisioning.unknown} /> {t('web.dashboard_queue_unknown')} ·{' '}
                <Num value={provisioning.unreconciledServices} />{' '}
                {t('web.dashboard_queue_unreconciled')}
              </span>
            )
          }
        />
      )}
      {summary !== undefined && <PeriodSalesCard data={summary} compare={compare} />}
    </div>
  );
}

/** The selected period's sales and revenue: the figures the two charts break down. */
function PeriodSalesCard({ data, compare }: { data: DashboardSummaryResponse; compare: boolean }) {
  const sales = data.selected.sales;
  const revenue = moneyRow(data.selected.revenue, data.currency);
  return (
    <StatCard
      label={t('web.dashboard_period_sales')}
      icon="orders"
      value={formatNumber(sales.current)}
      unit={t('web.dashboard_sales_unit')}
      {...deltaIf(compare, BigInt(sales.current), BigInt(sales.previous), 'up-good')}
      hint={
        <>
          <Money value={{ amountMinor: revenue.current, currency: data.currency }} />
          <OtherCurrencies rows={data.selected.revenue} currency={data.currency} />
        </>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Charts (owner)
// ---------------------------------------------------------------------------

function RevenueChart({ data, compare }: { data: DashboardSummaryResponse; compare: boolean }) {
  const currency = data.currency;
  const series = data.selected.revenueSeries;
  const title = t(REVENUE_TITLES[data.period.granularity]);
  const current = t('web.dashboard_this_period');
  const previous = t('web.dashboard_previous_period');
  const total = moneyRow(data.selected.revenue, currency);
  return (
    <ChartCard
      className="dash-revenue"
      title={title}
      hint={
        <>
          {t('web.dashboard_period_total')}{' '}
          <Money value={{ amountMinor: total.current, currency }} />
        </>
      }
      legend={
        <Legend
          items={[
            { label: current, tone: 1 },
            ...(compare ? [{ label: previous, dashed: true }] : []),
          ]}
        />
      }
    >
      <LineChart
        labels={series.current.map((bucket) => axisLabel(bucket.label))}
        caption={`${title} — ${currencyLabel(currency)}`}
        format={(value) => chartMoneyText(value, currency)}
        series={[
          {
            name: current,
            tone: 1,
            values: series.current.map((b) => chartMoneyValue(b.value, currency)),
          },
          ...(compare
            ? [
                {
                  name: previous,
                  dashed: true,
                  values: series.previous.map((b) => chartMoneyValue(b.value, currency)),
                },
              ]
            : []),
        ]}
      />
      <p className="faint small">
        {t('web.dashboard_amounts_in')} {currencyLabel(currency)}
        {data.currencies.some((code) => code !== currency) && (
          <> · {t('web.report_trend_other_currencies')}</>
        )}
      </p>
    </ChartCard>
  );
}

const SALE_KINDS = ['NEW', 'RENEWAL', 'ADDON'] as const;

const KIND_LABELS: Readonly<Record<(typeof SALE_KINDS)[number], WebKey>> = {
  NEW: 'web.dashboard_kind_new',
  RENEWAL: 'web.dashboard_kind_renewal',
  ADDON: 'web.dashboard_kind_addon',
};

const KIND_TONES: Readonly<Record<(typeof SALE_KINDS)[number], SeriesTone>> = {
  NEW: 1,
  RENEWAL: 2,
  ADDON: 4,
};

function SalesByKindChart({ data }: { data: DashboardSummaryResponse }) {
  const buckets = data.selected.salesByKind;
  return (
    <ChartCard
      className="dash-orders"
      title={t('web.dashboard_orders_chart')}
      hint={t('web.dashboard_orders_chart_hint')}
      legend={
        <Legend
          items={SALE_KINDS.map((kind) => ({
            label: t(KIND_LABELS[kind]),
            tone: KIND_TONES[kind],
          }))}
        />
      }
    >
      <BarChart
        stacked
        height={360}
        labels={buckets.map((bucket) => axisLabel(bucket.label))}
        caption={t('web.dashboard_orders_chart')}
        series={SALE_KINDS.map((kind) => ({
          name: t(KIND_LABELS[kind]),
          tone: KIND_TONES[kind],
          values: buckets.map((bucket) => (bucket.counts === null ? null : bucket.counts[kind])),
        }))}
      />
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------
// Secondary business cards (owner)
// ---------------------------------------------------------------------------

const METHOD_LABELS: Readonly<Record<PaymentMethod, WebKey>> = {
  WALLET: 'web.payment_method_wallet',
  MANUAL_TRANSFER: 'web.payment_method_manual',
  GATEWAY: 'web.payment_method_gateway',
};

const METHOD_TONES: Readonly<Record<PaymentMethod, SeriesTone>> = {
  WALLET: 2,
  MANUAL_TRANSFER: 3,
  GATEWAY: 1,
};

function PaymentMethods({
  query,
  data,
}: {
  query: QueryView;
  data: DashboardSummaryResponse | undefined;
}) {
  const confirmed = (data?.selected.paymentMethods ?? []).filter((row) => row.confirmed > 0);
  return (
    <Card title={t('web.dashboard_methods')} hint={t('web.dashboard_methods_hint')}>
      <StateSwitch
        query={query}
        isEmpty={confirmed.length === 0}
        empty={<Empty title={t('web.dashboard_methods_empty')} icon="payments" variant="compact" />}
      >
        <Donut
          caption={t('web.dashboard_methods')}
          slices={confirmed.map((row) => ({
            key: row.method,
            label: t(METHOD_LABELS[row.method]),
            value: row.confirmed,
            tone: METHOD_TONES[row.method],
          }))}
        />
        <KV
          items={confirmed.map((row) => [
            t(METHOD_LABELS[row.method]),
            <span key={row.method} className="dash-amounts">
              {row.confirmedAmount.map((amount) => (
                <Money
                  key={amount.currency}
                  value={{ amountMinor: amount.amount, currency: amount.currency }}
                />
              ))}
            </span>,
          ])}
        />
      </StateSwitch>
    </Card>
  );
}

const RANKING_LABELS: Readonly<Record<ReportProductRanking, WebKey>> = {
  COUNT: 'web.report_rank_by_count',
  REVENUE: 'web.report_rank_by_revenue',
};

/** The reports' own ranking, at their five-minute cadence, with the full list one click away. */
function TopProducts({ selection }: { selection: ReportRangeSelection }) {
  const [by, setBy] = useState<ReportProductRanking>('REVENUE');
  const products = useQuery({
    queryKey: ['reports', 'products', selection, by, 1, TOP_PRODUCTS_SHOWN],
    queryFn: () => fetchReportProducts(selection, { by, limit: TOP_PRODUCTS_SHOWN, page: 1 }),
    refetchInterval: pollUnlessFinal(BUSINESS_REFRESH_MS),
  });
  const onLink = useLinkHandler();
  const rows = products.data?.rows ?? [];
  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: 'title',
      header: t('web.dashboard_col_product'),
      render: (r) => (
        <span dir="auto">
          <Num value={r.rank} />. {r.title}
        </span>
      ),
      wrap: true,
    },
    {
      key: 'orders',
      header: t('web.dashboard_col_orders'),
      render: (r) => <Num value={r.orders} />,
      align: 'end',
    },
    {
      key: 'revenue',
      header: t('web.report_col_revenue'),
      render: (r) => <Money value={{ amountMinor: r.revenue, currency: r.currency }} />,
      align: 'end',
    },
  ];
  return (
    <Card
      title={t('web.dashboard_top_products')}
      actions={
        <a className="btn sm" href="/reports?tab=products" onClick={onLink}>
          {t('web.report_view_all')}
        </a>
      }
    >
      <Pills
        value={by}
        onChange={setBy}
        items={REPORT_PRODUCT_RANKINGS.map((r) => ({ id: r, label: t(RANKING_LABELS[r]) }))}
      />
      <StateSwitch
        query={products}
        isEmpty={rows.length === 0}
        empty={<Empty title={t('web.report_products_empty')} icon="reports" variant="compact" />}
      >
        <DataTable
          dense
          columns={columns}
          rows={rows}
          rowKey={(r) => `${r.productId}|${r.title}|${r.currency}`}
          caption={t('web.dashboard_top_products')}
        />
      </StateSwitch>
    </Card>
  );
}

function FailureSummary({ selection }: { selection: ReportRangeSelection }) {
  const failures = useQuery({
    queryKey: ['reports', 'failures', selection],
    queryFn: () => fetchReportFailures(selection),
    refetchInterval: pollUnlessFinal(BUSINESS_REFRESH_MS),
  });
  const data = failures.data;
  return (
    <Card title={t('web.report_failures_title')} hint={t('web.report_failures_hint')}>
      <StateSwitch query={failures}>
        {data !== undefined && (
          <div className="head-stats">
            <Stat
              label={t('web.report_failed_payments')}
              value={<Num value={data.payments.failed} />}
            />
            <Stat
              label={t('web.report_failed_provisioning')}
              value={<Num value={data.provisioning.failed + data.provisioning.abandoned} />}
            />
            <Stat
              label={t('web.report_failed_commercial')}
              value={
                <Num
                  value={data.commercialOperations.failed + data.commercialOperations.abandoned}
                />
              }
            />
            <Stat
              label={t('web.report_orders_refunded')}
              value={<Num value={data.ordersRefunded} />}
            />
            <Stat
              label={t('web.report_unknown_now')}
              value={<Num value={data.payments.unknownNow + data.operationsUnknownNow} />}
            />
          </div>
        )}
      </StateSwitch>
    </Card>
  );
}

/**
 * The report figures the dashboard summary deliberately does not carry. New
 * buyers and active customers are scans no window bounds, so they stay on
 * `/reports/summary` and its five-minute cadence; the rest were on `main`'s
 * dashboard and stay reachable here. Movements are uncoloured — a report figure
 * has no business opinion.
 */
function OtherFigures({ selection }: { selection: ReportRangeSelection }) {
  const report = useQuery({
    queryKey: ['reports', 'summary', selection],
    queryFn: () => fetchReportSummary(selection),
    refetchInterval: pollUnlessFinal(BUSINESS_REFRESH_MS),
  });
  const onLink = useLinkHandler();
  const data = report.data;
  const count = (value: { current: number; previous: number }): ReactNode => (
    <span className="dash-figure">
      <Num value={value.current} />
      <span className="faint small num signed">
        {kpiDelta(BigInt(value.current), BigInt(value.previous), 'neutral').text}
      </span>
    </span>
  );
  const money = (rows: MoneyComparison): ReactNode =>
    rows.length === 0 ? (
      <Num value={0} />
    ) : (
      <span className="dash-amounts">
        {rows.map((row) => (
          <Money key={row.currency} value={{ amountMinor: row.current, currency: row.currency }} />
        ))}
      </span>
    );
  return (
    <Card
      title={t('web.dashboard_other_figures')}
      hint={t('web.dashboard_other_figures_hint')}
      actions={
        <a className="btn sm" href="/reports" onClick={onLink}>
          {t('web.report_open_reports')}
        </a>
      }
    >
      <StateSwitch query={report}>
        {data !== undefined && (
          <div className="dash-figures">
            <KV
              items={[
                [t('web.report_kpi_successful_orders'), count(data.successfulOrders)],
                [t('web.report_kpi_new_services'), count(data.newServices)],
                [t('web.dashboard_trial_services'), count(data.newTrialServices)],
                [t('web.dashboard_new_buyers'), count(data.newBuyers)],
              ]}
            />
            <KV
              items={[
                [t('web.dashboard_active_customers'), <Num key="a" value={data.activeCustomers} />],
                [t('web.report_kpi_topup'), money(data.walletTopup)],
                [t('web.dashboard_topup_count'), count(data.walletTopupCount)],
                [t('web.dashboard_discount'), money(data.discount)],
              ]}
            />
          </div>
        )}
      </StateSwitch>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Operational cards
// ---------------------------------------------------------------------------

/**
 * The fleet by health and by provider: exact server counts, every panel that is
 * not ARCHIVED counted once (`dashboard.md` §3). A section the server withheld —
 * the session's permission list can be a minute old — says so rather than
 * drawing an empty fleet.
 */
function FleetCard({
  query,
  data,
}: {
  query: QueryView;
  data: DashboardOperationsResponse | undefined;
}) {
  const onLink = useLinkHandler();
  const fleet = data?.panels ?? null;
  return (
    <Card
      title={t('web.dashboard_panel_distribution')}
      hint={t('web.dashboard_panel_distribution_hint')}
      actions={
        <a className="btn sm" href="/panels" onClick={onLink}>
          {t('web.nav_panels')}
        </a>
      }
    >
      <StateSwitch
        query={query}
        denied={data !== undefined && fleet === null}
        isEmpty={fleet !== null && fleet.total === 0}
        empty={<Empty title={t('web.dashboard_no_panels')} icon="panels" variant="compact" />}
      >
        {fleet !== null && (
          <>
            <Distribution slices={healthSlices(fleet.health)} />
            <h3 className="dash-sub">{t('web.dashboard_by_provider')}</h3>
            <Distribution slices={providerSlices(fleet.providers)} />
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

/**
 * What actually wants an operator's attention (revision 3): management-scope
 * conditions still OPEN — never "everything not finished".
 */
function AttentionCard({
  query,
}: {
  query: {
    isPending: boolean;
    isError: boolean;
    refetch: () => unknown;
    // REQUIRED though it may be `undefined`, so a refusal is judged here as it is
    // everywhere else on the page.
    error: unknown;
    data:
      | {
          events: readonly {
            id: string;
            code: string;
            severity: string;
            message: string;
            /* The ORDERING column (`first_seen_at DESC`), which is the one drawn. */
            firstSeenAt: string;
          }[];
          /* Whether the server held more open conditions than this page. */
          nextCursor: object | null;
        }
      | undefined;
  };
}) {
  const onLink = useLinkHandler();
  const events = query.data?.events ?? [];
  // The SERVER's cursor, never a length comparison.
  const truncated = query.data?.nextCursor != null;

  return (
    <Card
      title={t('web.dashboard_attention')}
      hint={t('web.dashboard_attention_hint')}
      actions={
        <a className="btn sm" href="/alerts" onClick={onLink}>
          {t('web.nav_alerts')}
        </a>
      }
    >
      <StateSwitch
        query={query}
        isEmpty={events.length === 0}
        empty={
          <Empty
            title={t('web.dashboard_nothing_to_do')}
            hint={t('web.dashboard_nothing_to_do_hint')}
            icon="check"
            variant="compact"
          />
        }
      >
        <ul className="side-list">
          {events.slice(0, ATTENTION_SHOWN).map((event) => (
            <li key={event.id}>
              <Badge tone={severityTone(event.severity)}>{event.severity}</Badge>
              <span className="grow" dir="auto">
                {event.message}
              </span>
              {/* FIRST seen: the column the list is ordered by, labelled as such. */}
              <span className="faint small nowrap" title={t('web.first_seen')}>
                {formatTimestamp(event.firstSeenAt)}
              </span>
            </li>
          ))}
        </ul>
        {(events.length > ATTENTION_SHOWN || truncated) && (
          // How many were not drawn; when the page was full the number is a FLOOR,
          // and it counts the cursor — the server proving one more exists.
          <p className="faint small">
            {truncated
              ? t('web.dashboard_more_conditions_partial')
              : t('web.dashboard_more_conditions')}{' '}
            <Num value={Math.max(events.length - ATTENTION_SHOWN, 0) + (truncated ? 1 : 0)} />
          </p>
        )}
      </StateSwitch>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * The fleet by health state, biggest share first, from the server's exact counts.
 * Exported so a test can assert the claim rather than the pixels.
 */
export function healthSlices(
  health: readonly { state: string; count: number }[],
): DistributionSlice[] {
  return health
    .filter((row) => row.count > 0)
    .map((row) => ({
      key: row.state,
      label: t(HEALTH_LABELS[row.state] ?? 'web.health_unchecked'),
      count: row.count,
      tone: HEALTH_TONES[row.state] ?? 'neutral',
    }))
    .sort((a, b) => b.count - a.count);
}

/** The fleet by provider. One row per PANEL, whatever it serves (revision 2). */
export function providerSlices(
  providers: readonly { providerType: string; providerName: string; count: number }[],
): DistributionSlice[] {
  return providers
    .filter((row) => row.count > 0)
    .map((row) => ({
      key: row.providerType,
      label: row.providerName,
      count: row.count,
      tone: 'info' as Tone,
    }))
    .sort((a, b) => b.count - a.count);
}

export function severityTone(severity: string): Tone {
  if (severity === 'CRITICAL' || severity === 'ERROR') return 'danger';
  if (severity === 'WARN') return 'warn';
  return 'neutral';
}
