import { createContext, useContext, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FINANCIAL_GRANULARITIES,
  REPORT_PRODUCT_RANKINGS,
  REPORT_RANGES,
  REPORT_REFERRER_RANKINGS,
  REPORT_TREND_METRICS,
  type Calendar,
  type CurrencyCode,
  type MoneyComparison,
  type OrderPurpose,
  type PaymentMethod,
  type FinancialGranularity,
  type FinancialLines,
  type ReportExportKind,
  type ReportFinancialResponse,
  type ReportProductRanking,
  type ReportRange,
  type ReportReferrerRanking,
  type ReportTrendMetric,
  type WalletReportGroup,
} from '@nexa/contracts';
import {
  fetchReportFailures,
  fetchReportFinancial,
  fetchReportInfrastructure,
  fetchReportOrders,
  fetchReportPayments,
  fetchReportProducts,
  fetchReportReferrals,
  fetchReportResellers,
  fetchReportServices,
  fetchReportSummary,
  fetchReportTrend,
  fetchReportWallet,
  reportExportUrl,
  type ReportRangeSelection,
} from '../api/client';
import { formatTrafficGbText } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { pollUnlessFinal } from '../polling';
import {
  BUSINESS_REFRESH_MS,
  REPORT_RANGE_LABELS,
  describeChange,
  formatBasisPoints,
  formatRate,
  rangeFromRoute,
  rangeIsComplete,
} from '../report-view';
import { setQueries, useLinkHandler, type Route } from '../router';
import {
  Badge,
  Card,
  DataTable,
  Empty,
  Field,
  Ltr,
  Money,
  Num,
  PageHead,
  Pills,
  StateSwitch,
  TabPanel,
  Tabs,
  BarChart,
  ButtonGroup,
  ChartCard,
  CursorPager,
  Donut,
  FilterChip,
  FilterChips,
  Legend,
  StatCard,
  type Column,
  Quantity,
} from '../ui/kit';
import type { DonutSlice, SeriesTone } from '../ui/charts';
import { Icon } from '../ui/icons';
import { TrendChart } from '../ui/trend-chart';
import { STATE_LABELS as SERVICE_STATE_LABELS } from './services';
import { STATUS_LABELS as PRODUCT_STATUS_LABELS } from './products';
import { RESELLER_STATUS_LABELS } from './resellers';

/**
 * WP12's business analytics in the Web Admin (`docs/wp12-business-analytics-audit.md`).
 *
 * Owner only. Every section here is drawn only for a session that holds the owner role
 * and `reports.view`, and every request it makes is refused by the server for anyone
 * else — the drawing is courtesy, the refusal is the rule. Every figure is a server
 * aggregate; nothing on this page sums raw rows in the browser.
 *
 * Business queries re-read every five minutes (`BUSINESS_REFRESH_MS`) and on the refresh
 * button; the operational cards beside them keep their own faster cadence.
 */

const PURPOSE_LABELS: Readonly<Record<OrderPurpose, WebKey>> = {
  NEW_SERVICE: 'web.purpose_new_service',
  RENEW: 'web.purpose_renew',
  ADD_TRAFFIC: 'web.purpose_add_traffic',
  ADD_TIME: 'web.purpose_add_time',
  ADD_DEVICES: 'web.purpose_add_devices',
  CHANGE_LOCATION: 'web.purpose_change_location',
  TRIAL: 'web.report_purpose_trial',
  CUSTOM_SERVICE: 'web.purpose_custom_service',
};

const METHOD_LABELS: Readonly<Record<PaymentMethod, WebKey>> = {
  WALLET: 'web.payment_method_wallet',
  MANUAL_TRANSFER: 'web.payment_method_manual',
  GATEWAY: 'web.payment_method_gateway',
};

export const WALLET_GROUP_LABELS: Readonly<Record<WalletReportGroup, WebKey>> = {
  TOPUP: 'web.report_wallet_topup',
  RECEIPT_CREDIT: 'web.report_wallet_receipt_credit',
  CASHBACK: 'web.report_wallet_cashback',
  CASHBACK_REVERSAL: 'web.report_wallet_cashback_reversal',
  GIFT: 'web.report_wallet_gift',
  REFERRAL_COMMISSION: 'web.report_wallet_commission',
  REFERRAL_COMMISSION_REVERSAL: 'web.report_wallet_commission_reversal',
  SPENDING: 'web.report_wallet_spending',
  REFUND: 'web.report_wallet_refund',
  ADMINISTRATIVE: 'web.report_wallet_admin',
  TRANSFER: 'web.report_wallet_transfer',
  OTHER: 'web.report_wallet_other',
};

const METRIC_LABELS: Readonly<Record<ReportTrendMetric, WebKey>> = {
  REVENUE: 'web.report_metric_revenue',
  SALES: 'web.report_metric_sales',
  NEW_USERS: 'web.report_metric_new_users',
  RENEWALS: 'web.report_metric_renewals',
};

const PRODUCT_RANKING_LABELS: Readonly<Record<ReportProductRanking, WebKey>> = {
  COUNT: 'web.report_rank_by_count',
  REVENUE: 'web.report_rank_by_revenue',
};

const REFERRER_RANKING_LABELS: Readonly<Record<ReportReferrerRanking, WebKey>> = {
  SIGNUPS: 'web.report_rank_by_signups',
  BUYERS: 'web.report_rank_by_buyers',
  REVENUE: 'web.report_rank_by_revenue',
  COMMISSION: 'web.report_rank_by_commission',
};

/** Traffic in GB (Package C). Zero is zero here: unlimited lines are counted apart. */
function bytesText(bytes: bigint): string {
  return `${formatTrafficGbText(bytes)} ${t('web.unit_gib')}`;
}

/** Every query here shares this prefix, so one refresh re-reads them all. */
const REPORTS_KEY = 'reports';

function useReport<T>(key: readonly unknown[], fetcher: () => Promise<T>, enabled = true) {
  return useQuery({
    queryKey: [REPORTS_KEY, ...key],
    queryFn: fetcher,
    enabled,
    refetchInterval: pollUnlessFinal(BUSINESS_REFRESH_MS),
  });
}

// --- Period ---------------------------------------------------------------------

/**
 * The period selector. Presets are one click; a custom range takes two dates in the
 * TENANT's calendar (`1405-07-01`), which the server converts — the browser does no
 * calendar arithmetic and never decides where a day begins.
 */
export function RangePicker({
  route,
  selection,
}: {
  route: Route;
  selection: ReportRangeSelection;
}) {
  const choose = (range: ReportRange) => {
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
    <div className="report-range">
      <ButtonGroup segmented label={t('web.period_label')}>
        {REPORT_RANGES.map((range) => (
          <button
            key={range}
            type="button"
            className={selection.range === range ? 'btn sm on' : 'btn sm'}
            aria-pressed={selection.range === range}
            onClick={() => choose(range)}
          >
            {t(REPORT_RANGE_LABELS[range])}
          </button>
        ))}
      </ButtonGroup>
      {selection.range === 'CUSTOM' && (
        // Keyed by the APPLIED dates, so a range that arrives by history or a link starts a
        // fresh draft: the inputs never show one range while the figures show another.
        <CustomRangeForm
          key={`${selection.from ?? ''}|${selection.to ?? ''}`}
          route={route}
          from={selection.from ?? ''}
          to={selection.to ?? ''}
        />
      )}
    </div>
  );
}

function CustomRangeForm({ route, from, to }: { route: Route; from: string; to: string }) {
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
    <form className="report-custom" onSubmit={apply}>
      <Field
        compact
        label={t('web.report_range_from')}
        htmlFor="report-from"
        hint={t('web.report_range_date_hint')}
      >
        <input
          id="report-from"
          dir="ltr"
          placeholder="1405-07-01"
          value={draft.from}
          onChange={(event) => setDraft({ ...draft, from: event.target.value })}
        />
      </Field>
      <Field compact label={t('web.report_range_to')} htmlFor="report-to">
        <input
          id="report-to"
          dir="ltr"
          placeholder="1405-07-30"
          value={draft.to}
          onChange={(event) => setDraft({ ...draft, to: event.target.value })}
        />
      </Field>
      <button type="submit" className="btn sm primary">
        {t('web.report_range_apply')}
      </button>
    </form>
  );
}

/** The period as the tenant reads it, beside the moment the figures were computed. */
function PeriodNote({
  period,
}: {
  period: {
    current: { startLocal: string; endLocalInclusive: string };
    previous: { startLocal: string; endLocalInclusive: string };
    lengthsDiffer: boolean;
    generatedAt: string;
    timezone: string;
    calendar: Calendar;
  };
}) {
  const span = (side: { startLocal: string; endLocalInclusive: string }) =>
    side.startLocal === side.endLocalInclusive
      ? side.startLocal
      : `${side.startLocal} – ${side.endLocalInclusive}`;
  return (
    <p className="faint small">
      {t('web.report_period_current')} <Quantity>{span(period.current)}</Quantity> ·{' '}
      {t('web.report_period_previous')} <Quantity>{span(period.previous)}</Quantity> ·{' '}
      {t('web.report_updated_at')}{' '}
      <Quantity>{formatInstantIn(period.generatedAt, period.timezone, period.calendar)}</Quantity>
      {period.lengthsDiffer && <> · {t('web.report_lengths_differ')}</>}
    </p>
  );
}

/** The ICU locale that writes a date in each tenant calendar, with Latin digits. */
const CALENDAR_LOCALE: Readonly<Record<Calendar, string>> = {
  jalali: 'fa-IR-u-ca-persian-nu-latn',
  gregorian: 'en-GB-u-ca-gregory-nu-latn',
};

/**
 * An instant in the TENANT's zone and calendar, Latin digits: `1405/07/03 14:05` for a
 * Jalali tenant, `2026/09/25 14:05` for a Gregorian one — the calendar the period and the
 * exports use, never the browser's.
 */
export function formatInstantIn(iso: string, timezone: string, calendar: Calendar): string {
  const parts = new Intl.DateTimeFormat(CALENDAR_LOCALE[calendar], {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
}

function RefreshButton() {
  const client = useQueryClient();
  return (
    <button
      type="button"
      className="btn sm"
      onClick={() => void client.invalidateQueries({ queryKey: [REPORTS_KEY] })}
    >
      <Icon name="refresh" />
      {t('web.report_refresh')}
    </button>
  );
}

// --- Figures --------------------------------------------------------------------

/** A movement against the previous period. Never coloured good or bad (spec §23). */
export function ChangeNote({ current, previous }: { current: bigint; previous: bigint }) {
  const change = describeChange(current, previous);
  if (change.kind === 'none') return <span className="faint small">—</span>;
  if (change.kind === 'new')
    return <span className="faint small">{t('web.report_change_new')}</span>;
  return (
    <span className="faint small" title={t('web.report_change_hint')}>
      <Num signed value={formatBasisPoints(change.basisPoints)} />
    </span>
  );
}

/**
 * One KPI, as the kit's stat card. The change against the previous period is its delta
 * and is always `neutral`: a movement is shown, never judged (spec §23). The hint stays a
 * tooltip on the tile, as before, rather than a sentence under every figure.
 */
function Kpi({
  label,
  hint,
  value,
  change,
  children,
}: {
  label: string;
  hint?: string;
  value: ReactNode;
  change?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="report-kpi" {...(hint === undefined ? {} : { title: hint })}>
      <StatCard
        label={label}
        value={value}
        {...(change === undefined
          ? {}
          : { delta: { text: change, direction: 'neutral' as const } })}
      >
        {children}
      </StatCard>
    </div>
  );
}

function CountKpi({
  label,
  hint,
  value,
}: {
  label: string;
  hint?: string;
  value: { current: number; previous: number };
}) {
  return (
    <Kpi
      label={label}
      {...(hint === undefined ? {} : { hint })}
      value={<Num value={value.current} />}
      change={<ChangeNote current={BigInt(value.current)} previous={BigInt(value.previous)} />}
    />
  );
}

function MoneyKpi({
  label,
  hint,
  value,
  sub,
}: {
  label: string;
  hint?: string;
  value: MoneyComparison;
  sub?: ReactNode;
}) {
  // One currency is the tile's figure and its change; more are listed, each with its own
  // change — two currencies are never added into one number.
  const [first, ...rest] = value;
  return (
    <Kpi
      label={label}
      {...(hint === undefined ? {} : { hint })}
      value={
        first === undefined ? (
          <Num value={0} />
        ) : (
          <Money value={{ amountMinor: first.current, currency: first.currency }} />
        )
      }
      {...(first === undefined
        ? {}
        : {
            change: (
              <ChangeNote current={BigInt(first.current)} previous={BigInt(first.previous)} />
            ),
          })}
    >
      {rest.map((row) => (
        <span key={row.currency} className="kpi-money">
          <Money value={{ amountMinor: row.current, currency: row.currency }} />
          <ChangeNote current={BigInt(row.current)} previous={BigInt(row.previous)} />
        </span>
      ))}
      {sub}
    </Kpi>
  );
}

function SummaryCards({ selection }: { selection: ReportRangeSelection }) {
  const summary = useReport(
    ['summary', selection],
    () => fetchReportSummary(selection),
    rangeIsComplete(selection),
  );
  const data = summary.data;
  return (
    <Card
      title={t('web.report_kpis_title')}
      hint={t('web.report_kpis_hint')}
      actions={<RefreshButton />}
    >
      <StateSwitch query={summary}>
        {data !== undefined && (
          <>
            <div className="stat-grid report-kpis">
              <CountKpi
                label={t('web.report_kpi_sales')}
                hint={t('web.report_kpi_sales_hint')}
                value={data.sales}
              />
              <MoneyKpi
                label={t('web.report_kpi_revenue')}
                hint={t('web.report_kpi_revenue_hint')}
                value={data.revenue}
              />
              <CountKpi
                label={t('web.report_kpi_successful_orders')}
                hint={t('web.report_kpi_successful_orders_hint')}
                value={data.successfulOrders}
              />
              <CountKpi label={t('web.report_kpi_new_users')} value={data.newUsers} />
              <CountKpi
                label={t('web.report_kpi_new_services')}
                hint={t('web.report_kpi_new_services_hint')}
                value={data.newServices}
              />
              <CountKpi label={t('web.report_kpi_renewals')} value={data.renewals} />
              <MoneyKpi
                label={t('web.report_kpi_topup')}
                hint={t('web.report_kpi_topup_hint')}
                value={data.walletTopup}
                sub={
                  <span className="faint small">
                    {t('web.report_kpi_topup_count')} <Num value={data.walletTopupCount.current} />
                  </span>
                }
              />
              <Kpi
                label={t('web.report_kpi_active_services')}
                hint={t('web.report_kpi_now_hint')}
                value={<Num value={data.activeServices} />}
              />
            </div>
            <div className="report-substats">
              <span className="faint small">
                {t('web.report_kpi_new_buyers')} <Num value={data.newBuyers.current} />
              </span>
              <span className="faint small">
                {t('web.report_kpi_active_customers')} <Num value={data.activeCustomers} />
              </span>
              <span className="faint small">
                {t('web.report_kpi_trial_services')} <Num value={data.newTrialServices.current} />
              </span>
              {data.discount.map((row) => (
                <span key={row.currency} className="faint small">
                  {t('web.report_kpi_discount')}{' '}
                  <Money value={{ amountMinor: row.current, currency: row.currency }} />
                </span>
              ))}
            </div>
            <PeriodNote period={data.period} />
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

function TrendCard({ selection }: { selection: ReportRangeSelection }) {
  const [metric, setMetric] = useState<ReportTrendMetric>('REVENUE');
  const trend = useReport(
    ['trend', selection, metric],
    () => fetchReportTrend(selection, metric),
    rangeIsComplete(selection),
  );
  const data = trend.data;
  const currency: CurrencyCode | null = data?.currency ?? null;
  const format = (value: string): ReactNode =>
    currency === null ? (
      <Num value={Number(value)} />
    ) : (
      <Money value={{ amountMinor: value, currency }} />
    );
  const empty =
    data !== undefined &&
    [...data.current, ...data.previous].every((b) => b.value === null || b.value === '0');
  return (
    <ChartCard
      title={t('web.report_trend_title')}
      hint={t('web.report_trend_hint')}
      legend={
        <Legend
          items={[
            { label: t('web.report_period_current'), tone: 1 },
            { label: t('web.report_period_previous'), tone: 1, dashed: true },
          ]}
        />
      }
    >
      <FilterChips label={t('web.report_trend_title')}>
        {REPORT_TREND_METRICS.map((m) => (
          <FilterChip key={m} pressed={metric === m} onClick={() => setMetric(m)}>
            {t(METRIC_LABELS[m])}
          </FilterChip>
        ))}
      </FilterChips>
      <StateSwitch
        query={trend}
        isEmpty={empty}
        empty={<Empty title={t('web.report_trend_empty')} icon="reports" />}
      >
        {data !== undefined && (
          <>
            <TrendChart
              current={data.current}
              previous={data.previous}
              format={format}
              caption={t(METRIC_LABELS[metric])}
            />
            {data.currencies.length > 1 && (
              <p className="faint small">{t('web.report_trend_other_currencies')}</p>
            )}
          </>
        )}
      </StateSwitch>
    </ChartCard>
  );
}

/**
 * Whether this session holds `reports.export` as well as the Super Admin standing. Set by
 * the two pages that draw exports; the default is false, so a surface that forgets to say
 * draws no download the server would refuse.
 */
const ReportExportAllowed = createContext(false);

function ExportButtons({
  selection,
  report,
  granularity,
}: {
  selection: ReportRangeSelection;
  report: ReportExportKind;
  /** The financial statement's bucket size, so the file holds the rows the page shows. */
  granularity?: FinancialGranularity;
}) {
  const allowed = useContext(ReportExportAllowed);
  if (!allowed || !rangeIsComplete(selection)) return null;
  return (
    <>
      <a className="btn sm" href={reportExportUrl(selection, report, 'csv', granularity)} download>
        <Icon name="download" />
        {t('web.report_export_csv')}
      </a>
      <a className="btn sm" href={reportExportUrl(selection, report, 'xlsx', granularity)} download>
        <Icon name="download" />
        {t('web.report_export_xlsx')}
      </a>
    </>
  );
}

/**
 * State that belongs to one period — a page number, a cursor stack. A new range starts
 * it over: the component is not remounted when the range changes, so a cursor from the
 * old range would page the new one from a point outside it and show "nothing" while the
 * new range has rows.
 */
function usePerRange<T>(selection: ReportRangeSelection, initial: T): [T, (next: T) => void] {
  const key = `${selection.range}|${selection.from ?? ''}|${selection.to ?? ''}`;
  const [held, setHeld] = useState<{ readonly key: string; readonly value: T }>({
    key,
    value: initial,
  });
  return [held.key === key ? held.value : initial, (value: T) => setHeld({ key, value })];
}

// --- Products -------------------------------------------------------------------

function TopProducts({ selection }: { selection: ReportRangeSelection }) {
  const [by, setBy] = useState<ReportProductRanking>('REVENUE');
  const [page, setPage] = usePerRange(selection, 1);
  const limit = 25;
  const products = useReport(
    ['products', selection, by, page, limit],
    () => fetchReportProducts(selection, { by, limit, page }),
    rangeIsComplete(selection),
  );
  const data = products.data;
  const columns: Column<NonNullable<typeof data>['rows'][number]>[] = [
    {
      key: 'rank',
      header: t('web.report_col_rank'),
      render: (r) => <Num value={r.rank} />,
      align: 'end',
    },
    {
      key: 'title',
      header: t('web.report_col_product'),
      render: (r) => (
        <span dir="auto">
          {r.categoryEmoji ?? ''} {r.title}
          {r.categoryName !== null && <span className="faint small"> · {r.categoryName}</span>}
        </span>
      ),
    },
    {
      key: 'status',
      header: t('web.report_col_product_status'),
      render: (r) =>
        r.productStatus === null ? (
          '—'
        ) : (
          <Badge tone="neutral">
            {t(
              PRODUCT_STATUS_LABELS[r.productStatus as keyof typeof PRODUCT_STATUS_LABELS] ??
                'web.report_status_unknown',
            )}
          </Badge>
        ),
    },
    {
      key: 'orders',
      header: t('web.report_col_orders'),
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
      title={t('web.report_products_title')}
      hint={t('web.report_products_hint')}
      actions={<ExportButtons selection={selection} report="PRODUCTS" />}
    >
      <FilterChips label={t('web.report_products_title')}>
        {REPORT_PRODUCT_RANKINGS.map((r) => (
          <FilterChip
            key={r}
            pressed={by === r}
            onClick={() => {
              setBy(r);
              setPage(1);
            }}
          >
            {t(PRODUCT_RANKING_LABELS[r])}
          </FilterChip>
        ))}
      </FilterChips>
      <StateSwitch
        query={products}
        isEmpty={(data?.rows.length ?? 0) === 0}
        empty={<Empty title={t('web.report_products_empty')} icon="reports" />}
      >
        {data !== undefined && (
          <>
            <DataTable
              columns={columns}
              rows={data.rows}
              rowKey={(r) => `${r.productId}|${r.title}|${r.currency}`}
              caption={t('web.report_products_title')}
              dense
            />
            <CursorPager
              summary={
                <>
                  {t('web.report_total_rows')} <Num value={data.totalRows} />
                </>
              }
              hasPrevious={page > 1}
              hasNext={page * limit < data.totalRows}
              onPrevious={() => setPage(page - 1)}
              onNext={() => setPage(page + 1)}
              previousLabel={'web.report_page_previous'}
              nextLabel={'web.report_page_next'}
            />
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

// --- Failures -------------------------------------------------------------------

function FailureSummary({ selection }: { selection: ReportRangeSelection }) {
  const failures = useReport(
    ['failures', selection],
    () => fetchReportFailures(selection),
    rangeIsComplete(selection),
  );
  const data = failures.data;
  return (
    <Card title={t('web.report_failures_title')} hint={t('web.report_failures_hint')}>
      <StateSwitch query={failures}>
        {data !== undefined && (
          <>
            <div className="stat-grid report-kpis">
              <Stat label={t('web.report_failed_payments')} value={data.payments.failed} />
              <Stat
                label={t('web.report_failed_provisioning')}
                value={data.provisioning.failed + data.provisioning.abandoned}
              />
              <Stat
                label={t('web.report_failed_commercial')}
                value={data.commercialOperations.failed + data.commercialOperations.abandoned}
              />
              <Stat label={t('web.report_orders_refunded')} value={data.ordersRefunded} />
              <Stat
                label={t('web.report_unknown_now')}
                value={data.payments.unknownNow + data.operationsUnknownNow}
              />
            </div>
            {data.byFailureKind.length > 0 && (
              <ul className="side-list">
                {data.byFailureKind.map((row) => (
                  <li key={row.failureKind ?? 'none'}>
                    <Ltr>{row.failureKind ?? '—'}</Ltr>
                    <span className="grow" />
                    <Num value={row.count} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <StatCard label={label} value={<Num value={value} />} />;
}

// --- Reports page ----------------------------------------------------------------

const REPORT_TABS = [
  'sales',
  // Phase E2: the financial statement (`docs/financial-reports.md`).
  'finance',
  'products',
  'services',
  'payments',
  'wallet',
  'infrastructure',
  'resellers',
  'failures',
] as const;
type ReportTab = (typeof REPORT_TABS)[number];

const TAB_LABELS: Readonly<Record<ReportTab, WebKey>> = {
  sales: 'web.report_tab_sales',
  finance: 'web.report_tab_finance',
  products: 'web.report_tab_products',
  services: 'web.report_tab_services',
  payments: 'web.report_tab_payments',
  wallet: 'web.report_tab_wallet',
  infrastructure: 'web.report_tab_infrastructure',
  resellers: 'web.report_tab_resellers',
  failures: 'web.report_tab_failures',
};

/**
 * `/reports`: one page, one period selector, a tab per report (spec §30). Replaces the
 * planned placeholder that stood here since Phase 3D.
 */
export function ReportsPage({
  route,
  denied,
  mayExport = false,
}: {
  route: Route;
  denied: boolean;
  mayExport?: boolean;
}) {
  const selection = rangeFromRoute(route, 'THIS_MONTH');
  const raw = route.query.get('tab') ?? 'sales';
  const tab: ReportTab = (REPORT_TABS as readonly string[]).includes(raw)
    ? (raw as ReportTab)
    : 'sales';
  const panelId = 'reports-panel';
  if (denied) {
    return (
      <>
        <PageHead title={t('web.nav_reports')} subtitle={t('web.report_page_intro')} />
        <Empty
          title={t('web.report_owner_only')}
          hint={t('web.report_owner_only_hint')}
          icon="lock"
        />
        <NoLogsNote />
      </>
    );
  }
  return (
    <>
      <PageHead
        title={t('web.nav_reports')}
        subtitle={t('web.report_page_intro')}
        actions={<RefreshButton />}
      />
      <Card className="report-range-card">
        <RangePicker route={route} selection={selection} />
      </Card>
      <Tabs
        value={tab}
        onChange={(next) => setQueries(route, [['tab', next]])}
        items={REPORT_TABS.map((id) => ({ id, label: t(TAB_LABELS[id]) }))}
        panelId={panelId}
      />
      <TabPanel id={panelId} labelledBy={`${panelId}-tab-${tab}`}>
        <ReportExportAllowed.Provider value={mayExport}>
          {tab === 'sales' && (
            <>
              <SummaryCards selection={selection} />
              <TrendCard selection={selection} />
              <OrdersDrilldown selection={selection} />
            </>
          )}
          {tab === 'finance' && <FinancialReport selection={selection} route={route} />}
          {tab === 'products' && <TopProducts selection={selection} />}
          {tab === 'services' && <ServicesReport selection={selection} />}
          {tab === 'payments' && <PaymentsReport selection={selection} />}
          {tab === 'wallet' && <WalletReport selection={selection} />}
          {tab === 'infrastructure' && <InfrastructureReport selection={selection} />}
          {tab === 'resellers' && <ResellersReport selection={selection} />}
          {tab === 'failures' && <FailureSummary selection={selection} />}
        </ReportExportAllowed.Provider>
      </TabPanel>
      <NoLogsNote />
    </>
  );
}

/**
 * Owner revision 25, which the planned placeholder carried and this page inherits: business
 * reports are aggregates, and there is no general log browser here or anywhere.
 */
function NoLogsNote() {
  return <p className="faint small">{t('web.planned_reports_no_logs')}</p>;
}

function OrdersDrilldown({ selection }: { selection: ReportRangeSelection }) {
  const [purpose, setPurpose] = useState<OrderPurpose | 'ALL'>('ALL');
  const [cursors, setCursors] = usePerRange<readonly string[]>(selection, []);
  const cursor = cursors.at(-1);
  const orders = useReport(
    ['orders', selection, purpose, cursor ?? null],
    () =>
      fetchReportOrders(selection, {
        ...(purpose === 'ALL' ? {} : { purpose }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    rangeIsComplete(selection),
  );
  const onLink = useLinkHandler();
  const data = orders.data;
  const columns: Column<NonNullable<typeof data>['rows'][number]>[] = [
    {
      key: 'at',
      header: t('web.report_col_settled_at'),
      render: (r) => (
        <Ltr>
          {formatInstantIn(
            r.settledAt,
            data?.period.timezone ?? 'UTC',
            data?.period.calendar ?? 'jalali',
          )}
        </Ltr>
      ),
    },
    {
      key: 'purpose',
      header: t('web.report_col_purpose'),
      render: (r) => t(PURPOSE_LABELS[r.purpose]),
    },
    {
      key: 'title',
      header: t('web.report_col_product'),
      render: (r) => <span dir="auto">{r.title}</span>,
    },
    {
      key: 'subtotal',
      header: t('web.report_col_gross'),
      render: (r) => <Money value={{ amountMinor: r.subtotal, currency: r.currency }} />,
      align: 'end',
    },
    {
      key: 'discount',
      header: t('web.report_col_discount'),
      render: (r) => <Money value={{ amountMinor: r.discount, currency: r.currency }} />,
      align: 'end',
    },
    {
      key: 'total',
      header: t('web.report_col_total'),
      render: (r) => <Money value={{ amountMinor: r.total, currency: r.currency }} />,
      align: 'end',
    },
    {
      key: 'method',
      header: t('web.report_col_method'),
      render: (r) => (r.paymentMethod === null ? '—' : t(METHOD_LABELS[r.paymentMethod])),
    },
    {
      key: 'links',
      header: t('web.report_col_links'),
      render: (r) => (
        <span className="btn-group">
          <a href={`/orders/${r.orderId}`} onClick={onLink}>
            {t('web.report_link_order')}
          </a>
          <a href={`/users/${r.customerId}`} onClick={onLink}>
            {t('web.report_link_customer')}
          </a>
        </span>
      ),
    },
  ];
  return (
    <Card
      title={t('web.report_orders_title')}
      hint={t('web.report_orders_hint')}
      actions={<ExportButtons selection={selection} report="SALES" />}
    >
      <FilterChips label={t('web.report_col_purpose')}>
        {(
          [
            { id: 'ALL', label: t('web.report_all') },
            ...(Object.keys(PURPOSE_LABELS) as OrderPurpose[]).map((p) => ({
              id: p,
              label: t(PURPOSE_LABELS[p]),
            })),
          ] as { id: OrderPurpose | 'ALL'; label: string }[]
        ).map((item) => (
          <FilterChip
            key={item.id}
            pressed={purpose === item.id}
            onClick={() => {
              setPurpose(item.id);
              setCursors([]);
            }}
          >
            {item.label}
          </FilterChip>
        ))}
      </FilterChips>
      <StateSwitch
        query={orders}
        isEmpty={(data?.rows.length ?? 0) === 0}
        empty={<Empty title={t('web.report_orders_empty')} icon="orders" />}
      >
        {data !== undefined && (
          <>
            <DataTable
              columns={columns}
              rows={data.rows}
              rowKey={(r) => r.orderId}
              caption={t('web.report_orders_title')}
              dense
            />
            <CursorPager
              summary={null}
              hasPrevious={cursors.length > 0}
              hasNext={data.nextCursor !== null}
              onPrevious={() => setCursors(cursors.slice(0, -1))}
              onNext={() => data.nextCursor !== null && setCursors([...cursors, data.nextCursor])}
              previousLabel={'web.report_page_previous'}
              nextLabel={'web.report_page_next'}
            />
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

function MoneyList({ rows }: { rows: readonly { currency: CurrencyCode; amount: string }[] }) {
  if (rows.length === 0) return <Num value={0} />;
  return (
    <>
      {rows.map((row) => (
        <span key={row.currency} className="money-line">
          <Money value={{ amountMinor: row.amount, currency: row.currency }} />
        </span>
      ))}
    </>
  );
}

function ServicesReport({ selection }: { selection: ReportRangeSelection }) {
  const services = useReport(
    ['services', selection],
    () => fetchReportServices(selection),
    rangeIsComplete(selection),
  );
  const data = services.data;
  return (
    <Card title={t('web.report_services_title')} hint={t('web.report_services_hint')}>
      <StateSwitch query={services}>
        {data !== undefined && (
          <>
            <div className="stat-grid report-kpis">
              <Stat label={t('web.report_kpi_new_services')} value={data.newServices.current} />
              <Stat
                label={t('web.report_kpi_trial_services')}
                value={data.newTrialServices.current}
              />
              <Stat label={t('web.report_kpi_active_services')} value={data.activeServices} />
              <StatCard
                label={t('web.report_traffic_sold')}
                value={<Num value={bytesText(BigInt(data.trafficSoldBytes))} />}
                hint={
                  <>
                    {t('web.report_unlimited_lines')} <Num value={data.unlimitedTrafficLines} />
                  </>
                }
              />
            </div>
            {/* The operations table below, as columns: orders per purpose, this period
                beside the previous. Counts only — revenue stays per currency in the table. */}
            {data.operations.some((r) => r.orders.current > 0 || r.orders.previous > 0) && (
              <BarChart
                labels={data.operations.map((r) => t(PURPOSE_LABELS[r.purpose]))}
                series={[
                  {
                    name: t('web.report_period_current'),
                    values: data.operations.map((r) => r.orders.current),
                    tone: 1,
                  },
                  {
                    name: t('web.report_period_previous'),
                    values: data.operations.map((r) => r.orders.previous),
                    tone: 3,
                  },
                ]}
                caption={t('web.report_col_orders')}
                height={180}
              />
            )}
            <DataTable
              columns={[
                {
                  key: 'purpose',
                  header: t('web.report_col_purpose'),
                  render: (r) => t(PURPOSE_LABELS[r.purpose]),
                },
                {
                  key: 'orders',
                  header: t('web.report_col_orders'),
                  render: (r) => (
                    <>
                      <Num value={r.orders.current} />{' '}
                      <ChangeNote
                        current={BigInt(r.orders.current)}
                        previous={BigInt(r.orders.previous)}
                      />
                    </>
                  ),
                  align: 'end',
                },
                {
                  key: 'revenue',
                  header: t('web.report_col_revenue'),
                  render: (r) => (
                    <MoneyList
                      rows={r.revenue.map((m) => ({ currency: m.currency, amount: m.current }))}
                    />
                  ),
                  align: 'end',
                },
              ]}
              rows={data.operations}
              rowKey={(r) => r.purpose}
              caption={t('web.report_services_title')}
            />
            <DataTable
              columns={[
                {
                  key: 'state',
                  header: t('web.report_col_state'),
                  render: (r) => t(SERVICE_STATE_LABELS[r.state]),
                },
                {
                  key: 'count',
                  header: t('web.report_col_count'),
                  render: (r) => <Num value={r.count} />,
                  align: 'end',
                },
              ]}
              rows={data.states}
              rowKey={(r) => r.state}
              caption={t('web.report_service_states')}
            />
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

/** Confirmed attempts summed per method — the table's rows are method × provider × kind. */
function paymentMethodSlices(
  rows: readonly { method: PaymentMethod; confirmed: number }[],
): DonutSlice[] {
  const totals = new Map<PaymentMethod, number>();
  for (const row of rows) totals.set(row.method, (totals.get(row.method) ?? 0) + row.confirmed);
  return [...totals.entries()].map(([method, value], index) => ({
    key: method,
    label: t(METHOD_LABELS[method]),
    value,
    tone: ((index % 6) + 1) as SeriesTone,
  }));
}

function PaymentsReport({ selection }: { selection: ReportRangeSelection }) {
  const payments = useReport(
    ['payments', selection],
    () => fetchReportPayments(selection),
    rangeIsComplete(selection),
  );
  const data = payments.data;
  type Row = NonNullable<typeof data>['rows'][number];
  const columns: Column<Row>[] = [
    {
      key: 'method',
      header: t('web.report_col_method'),
      render: (r) => t(METHOD_LABELS[r.method]),
    },
    {
      key: 'route',
      header: t('web.report_col_route'),
      render: (r) => <Ltr>{r.provider ?? '—'}</Ltr>,
    },
    {
      key: 'kind',
      header: t('web.report_col_kind'),
      render: (r) => t(r.kind === 'TOPUP' ? 'web.report_kind_topup' : 'web.report_kind_order'),
    },
    {
      key: 'attempts',
      header: t('web.report_col_attempts'),
      render: (r) => <Num value={r.attempts} />,
      align: 'end',
    },
    {
      key: 'confirmed',
      header: t('web.report_col_confirmed'),
      render: (r) => <Num value={r.confirmed} />,
      align: 'end',
    },
    {
      key: 'failed',
      header: t('web.report_col_failed_terminal'),
      render: (r) => <Num value={r.failed + r.cancelled + r.expired} />,
      align: 'end',
    },
    {
      key: 'pending',
      header: t('web.report_col_pending'),
      render: (r) => <Num value={r.pending + r.unknown} />,
      align: 'end',
    },
    {
      key: 'rate',
      header: t('web.report_col_success_rate'),
      render: (r) => <Num value={formatRate(r.successRateBasisPoints)} />,
      align: 'end',
    },
    {
      key: 'amount',
      header: t('web.report_col_confirmed_amount'),
      render: (r) => <MoneyList rows={r.confirmedAmount} />,
      align: 'end',
    },
  ];
  return (
    <Card
      title={t('web.report_payments_title')}
      hint={t('web.report_payments_hint')}
      actions={<ExportButtons selection={selection} report="PAYMENTS" />}
    >
      <StateSwitch
        query={payments}
        isEmpty={(data?.rows.length ?? 0) === 0}
        empty={<Empty title={t('web.report_payments_empty')} icon="payments" />}
      >
        {data !== undefined && (
          <>
            {/* Confirmed attempts by method, from the rows the table below holds. */}
            <div className="report-donut">
              <Donut
                slices={paymentMethodSlices(data.rows)}
                caption={t('web.report_col_confirmed')}
              />
            </div>
            <DataTable
              columns={columns}
              rows={data.rows}
              rowKey={(r) => `${r.method}|${r.provider ?? ''}|${r.kind}`}
              caption={t('web.report_payments_title')}
              dense
            />
            <p className="faint small">
              {t('web.report_success_rate_total')}{' '}
              <Num value={formatRate(data.totals.successRateBasisPoints)} />
            </p>
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

function WalletReport({ selection }: { selection: ReportRangeSelection }) {
  const wallet = useReport(
    ['wallet', selection],
    () => fetchReportWallet(selection),
    rangeIsComplete(selection),
  );
  const data = wallet.data;
  return (
    <Card
      title={t('web.report_wallet_title')}
      hint={t('web.report_wallet_hint')}
      actions={<ExportButtons selection={selection} report="WALLET" />}
    >
      <StateSwitch query={wallet}>
        {data !== undefined && (
          <>
            <DataTable
              columns={[
                {
                  key: 'group',
                  header: t('web.report_col_group'),
                  render: (r) => t(WALLET_GROUP_LABELS[r.group]),
                },
                {
                  key: 'entries',
                  header: t('web.report_col_count'),
                  render: (r) => <Num value={r.entries} />,
                  align: 'end',
                },
                {
                  key: 'amount',
                  header: t('web.report_col_net_amount'),
                  render: (r) => <Money value={{ amountMinor: r.amount, currency: r.currency }} />,
                  align: 'end',
                },
              ]}
              rows={data.groups}
              rowKey={(r) => `${r.group}|${r.currency}`}
              caption={t('web.report_wallet_title')}
            />
            <p className="muted small">
              {t('web.report_wallet_balance')} <MoneyList rows={data.balances} />
            </p>
            <DataTable
              columns={[
                {
                  key: 'reason',
                  header: t('web.report_col_reason'),
                  render: (r) => <Ltr>{r.reason}</Ltr>,
                },
                {
                  key: 'group',
                  header: t('web.report_col_group'),
                  render: (r) => t(WALLET_GROUP_LABELS[r.group]),
                },
                {
                  key: 'direction',
                  header: t('web.report_col_direction'),
                  render: (r) =>
                    t(r.direction === 'CREDIT' ? 'web.report_credit' : 'web.report_debit'),
                },
                {
                  key: 'entries',
                  header: t('web.report_col_count'),
                  render: (r) => <Num value={r.entries} />,
                  align: 'end',
                },
                {
                  key: 'amount',
                  header: t('web.report_col_amount'),
                  render: (r) => <Money value={{ amountMinor: r.amount, currency: r.currency }} />,
                  align: 'end',
                },
              ]}
              rows={data.reasons}
              rowKey={(r) => `${r.reason}|${r.direction}|${r.currency}`}
              caption={t('web.report_wallet_reasons')}
            />
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

function InfrastructureReport({ selection }: { selection: ReportRangeSelection }) {
  const infra = useReport(
    ['infrastructure', selection],
    () => fetchReportInfrastructure(selection),
    rangeIsComplete(selection),
  );
  const data = infra.data;
  type Figures = {
    servicesCreated: number;
    activeServices: number;
    trafficSoldBytes: string;
    unlimitedTrafficLines: number;
    provisioningFailures: number;
  };
  const figureColumns = <T extends Figures>(): Column<T>[] => [
    {
      key: 'created',
      header: t('web.report_col_services_created'),
      render: (r) => <Num value={r.servicesCreated} />,
      align: 'end',
    },
    {
      key: 'active',
      header: t('web.report_col_active_services'),
      render: (r) => <Num value={r.activeServices} />,
      align: 'end',
    },
    {
      key: 'traffic',
      header: t('web.report_traffic_sold'),
      render: (r) => <Num value={bytesText(BigInt(r.trafficSoldBytes))} />,
      align: 'end',
    },
    {
      key: 'unlimited',
      header: t('web.report_unlimited_lines'),
      render: (r) => <Num value={r.unlimitedTrafficLines} />,
      align: 'end',
    },
    {
      key: 'failures',
      header: t('web.report_col_provisioning_failures'),
      render: (r) => <Num value={r.provisioningFailures} />,
      align: 'end',
    },
  ];
  return (
    <Card
      title={t('web.report_infra_title')}
      hint={t('web.report_infra_hint')}
      actions={<ExportButtons selection={selection} report="INFRASTRUCTURE" />}
    >
      <StateSwitch
        query={infra}
        isEmpty={(data?.panels.length ?? 0) === 0}
        empty={<Empty title={t('web.dashboard_no_panels')} icon="panels" />}
      >
        {data !== undefined && (
          <>
            <DataTable
              columns={[
                {
                  key: 'panel',
                  header: t('web.report_col_panel'),
                  render: (r) => <span dir="auto">{r.panelName}</span>,
                },
                {
                  key: 'provider',
                  header: t('web.report_col_provider'),
                  render: (r) => <Ltr>{r.providerType}</Ltr>,
                },
                ...figureColumns<(typeof data.panels)[number]>(),
              ]}
              rows={data.panels}
              rowKey={(r) => r.panelId}
              caption={t('web.report_infra_title')}
            />
            <DataTable
              columns={[
                {
                  key: 'provider',
                  header: t('web.report_col_provider'),
                  render: (r) => <Ltr>{r.providerType}</Ltr>,
                },
                ...figureColumns<(typeof data.providers)[number]>(),
              ]}
              rows={data.providers}
              rowKey={(r) => r.providerType}
              caption={t('web.report_infra_providers')}
            />
            {data.truncated && <p className="faint small">{t('web.report_truncated')}</p>}
            <p className="faint small">{t('web.report_location_unsupported')}</p>
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

function ResellersReport({ selection }: { selection: ReportRangeSelection }) {
  const resellers = useReport(
    ['resellers', selection],
    () => fetchReportResellers(selection),
    rangeIsComplete(selection),
  );
  const onLink = useLinkHandler();
  const data = resellers.data;
  return (
    <Card
      title={t('web.report_resellers_title')}
      hint={t('web.report_resellers_hint')}
      actions={<ExportButtons selection={selection} report="RESELLERS" />}
    >
      <StateSwitch
        query={resellers}
        isEmpty={(data?.rows.length ?? 0) === 0}
        empty={<Empty title={t('web.report_resellers_empty')} icon="users" />}
      >
        {data !== undefined && (
          <DataTable
            columns={[
              {
                key: 'reseller',
                header: t('web.report_col_reseller'),
                render: (r) => (
                  // The customer page, whose reseller card shows the standing: there is
                  // no `/resellers/:id` route, and this link resolved to Not Found (D1).
                  <a href={`/users/${encodeURIComponent(r.resellerCustomerId)}`} onClick={onLink}>
                    <Ltr>{r.resellerCustomerId.slice(-8)}</Ltr>
                  </a>
                ),
              },
              {
                key: 'tier',
                header: t('web.report_col_tier'),
                render: (r) => <span dir="auto">{r.tierName}</span>,
              },
              {
                key: 'status',
                header: t('web.report_col_state'),
                render: (r) =>
                  t(
                    RESELLER_STATUS_LABELS[r.status as keyof typeof RESELLER_STATUS_LABELS] ??
                      'web.report_status_unknown',
                  ),
              },
              {
                key: 'orders',
                header: t('web.report_col_orders'),
                render: (r) => <Num value={r.orders} />,
                align: 'end',
              },
              {
                key: 'sales',
                header: t('web.report_col_sales'),
                render: (r) => <MoneyList rows={r.sales} />,
                align: 'end',
              },
              {
                key: 'services',
                header: t('web.report_col_services'),
                render: (r) => <Num value={r.services} />,
                align: 'end',
              },
              {
                key: 'credit',
                header: t('web.report_col_credit_in_use'),
                // Reseller credit was removed (2026-10-01): no limit, only a legacy debt.
                render: (r) => (r.creditInUse === null ? '—' : <Money value={r.creditInUse} />),
                align: 'end',
              },
            ]}
            rows={data.rows}
            rowKey={(r) => r.resellerCustomerId}
            caption={t('web.report_resellers_title')}
          />
        )}
      </StateSwitch>
    </Card>
  );
}

// --- Referral analytics ----------------------------------------------------------

/**
 * The referral analytics, inside the existing Referral page (spec §14, §26). The period is
 * the page's own; rewards come from the ledger and revenue from orders, and Top Referrers
 * name a customer only by a link to the canonical customer page.
 */
export function ReferralAnalytics({
  route,
  mayExport = false,
}: {
  route: Route;
  mayExport?: boolean;
}) {
  const selection = rangeFromRoute(route, 'LAST_30_DAYS');
  const [by, setBy] = useState<ReportReferrerRanking>('SIGNUPS');
  const [page, setPage] = usePerRange(selection, 1);
  const limit = 10;
  const referrals = useReport(
    ['referrals', selection, by, page],
    () => fetchReportReferrals(selection, { by, limit, page }),
    rangeIsComplete(selection),
  );
  const onLink = useLinkHandler();
  const data = referrals.data;
  const sum = (rows: readonly { currency: CurrencyCode; amount: string }[]) => (
    <MoneyList rows={rows} />
  );
  return (
    <Card
      title={t('web.report_referral_title')}
      hint={t('web.report_referral_hint')}
      actions={
        <>
          <RefreshButton />
          <ReportExportAllowed.Provider value={mayExport}>
            <ExportButtons selection={selection} report="REFERRALS" />
          </ReportExportAllowed.Provider>
        </>
      }
    >
      <RangePicker route={route} selection={selection} />
      <StateSwitch query={referrals}>
        {data !== undefined && (
          <>
            <div className="stat-grid report-kpis">
              <CountKpi label={t('web.report_referral_signups')} value={data.signups} />
              <Kpi
                label={t('web.report_referral_buyers')}
                hint={t('web.report_referral_buyers_hint')}
                value={<Num value={data.convertedBuyers} />}
              >
                <span className="faint small">
                  <Num value={formatRate(data.conversionBasisPoints)} />
                </span>
              </Kpi>
              <Kpi label={t('web.report_referral_gifts')} value={sum(data.signupGifts)} />
              <Kpi label={t('web.report_referral_commissions')} value={sum(data.commissions)} />
              <Kpi
                label={t('web.report_referral_revenue')}
                hint={t('web.report_referral_revenue_hint')}
                value={sum(data.referredRevenue)}
              >
                <span className="faint small">
                  {t('web.report_kpi_sales')} <Num value={data.referredSales} />
                </span>
              </Kpi>
            </div>
            <h3>{t('web.report_top_referrers')}</h3>
            <FilterChips label={t('web.report_top_referrers')}>
              {REPORT_REFERRER_RANKINGS.map((r) => (
                <FilterChip
                  key={r}
                  pressed={by === r}
                  onClick={() => {
                    setBy(r);
                    setPage(1);
                  }}
                >
                  {t(REFERRER_RANKING_LABELS[r])}
                </FilterChip>
              ))}
            </FilterChips>
            {data.topReferrers.rows.length === 0 ? (
              <Empty title={t('web.report_referrers_empty')} icon="users" />
            ) : (
              <DataTable
                columns={[
                  {
                    key: 'rank',
                    header: t('web.report_col_rank'),
                    render: (r) => <Num value={r.rank} />,
                    align: 'end',
                  },
                  {
                    key: 'referrer',
                    header: t('web.report_col_referrer'),
                    render: (r) => (
                      <a href={`/users/${r.referrerId}`} onClick={onLink}>
                        <Ltr>{r.referrerId.slice(-8)}</Ltr>
                      </a>
                    ),
                  },
                  {
                    key: 'signups',
                    header: t('web.report_referral_signups'),
                    render: (r) => <Num value={r.signups} />,
                    align: 'end',
                  },
                  {
                    key: 'buyers',
                    header: t('web.report_referral_buyers'),
                    render: (r) => <Num value={r.convertedBuyers} />,
                    align: 'end',
                  },
                  {
                    key: 'revenue',
                    header: t('web.report_referral_revenue'),
                    render: (r) => sum(r.revenue),
                    align: 'end',
                  },
                  {
                    key: 'commission',
                    header: t('web.report_referral_commissions'),
                    render: (r) => sum(r.commission),
                    align: 'end',
                  },
                ]}
                rows={data.topReferrers.rows}
                rowKey={(r) => r.referrerId}
                caption={t('web.report_top_referrers')}
              />
            )}
            <CursorPager
              summary={
                <>
                  {t('web.report_total_rows')} <Num value={data.topReferrers.totalRows} />
                </>
              }
              hasPrevious={page > 1}
              hasNext={page * limit < data.topReferrers.totalRows}
              onPrevious={() => setPage(page - 1)}
              onNext={() => setPage(page + 1)}
              previousLabel={'web.report_page_previous'}
              nextLabel={'web.report_page_next'}
            />
            <PeriodNote period={data.period} />
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

// --- Financial statement (Phase E2) ---------------------------------------------

const GRANULARITY_LABELS: Readonly<Record<FinancialGranularity, WebKey>> = {
  DAY: 'web.finance_daily',
  WEEK: 'web.finance_weekly',
  MONTH: 'web.finance_monthly',
};

/** The bucket size in the URL, or none — the server then decides by the period's length. */
export function financialGranularityOf(route: Route): FinancialGranularity | undefined {
  const raw = route.query.get('granularity');
  return (FINANCIAL_GRANULARITIES as readonly string[]).includes(raw ?? '')
    ? (raw as FinancialGranularity)
    : undefined;
}

type MoneyLine = Exclude<
  keyof FinancialLines,
  'currency' | 'salesCount' | 'refundCount' | 'externalPayments'
>;

/** The three sections, in the order the statement reads. Never added to one another. */
const SALES_LINES: readonly (readonly [MoneyLine, WebKey])[] = [
  ['grossSales', 'web.finance_gross_sales'],
  ['discounts', 'web.finance_discounts'],
  ['sales', 'web.finance_sales'],
  ['refunds', 'web.finance_refunds'],
  ['refundsToWallet', 'web.finance_refunds_to_wallet'],
  ['refundsPaidOut', 'web.finance_refunds_paid_out'],
  ['netSales', 'web.finance_net_sales'],
];
const CASH_LINES: readonly (readonly [MoneyLine, WebKey])[] = [
  ['principalReceived', 'web.finance_principal'],
  ['customerFees', 'web.finance_customer_fees'],
  ['customerPaid', 'web.finance_customer_paid'],
  ['receiptCredits', 'web.finance_receipt_credits'],
];
const WALLET_LINES: readonly (readonly [MoneyLine, WebKey])[] = [
  ['walletTopups', 'web.finance_wallet_topups'],
  ['walletSpending', 'web.finance_wallet_spending'],
  ['cashbackNet', 'web.finance_cashback_net'],
  ['commissionNet', 'web.finance_commission_net'],
  ['gifts', 'web.finance_gifts'],
];

/**
 * One section of the totals: a row per line, a column per currency. Vertical, so the
 * statement reads at 390px without a wide table; currencies sit side by side and are never
 * summed.
 */
function SectionTable({
  caption,
  lines,
  totals,
}: {
  caption: string;
  lines: readonly (readonly [MoneyLine, WebKey])[];
  totals: readonly FinancialLines[];
}) {
  const columns: Column<readonly [MoneyLine, WebKey]>[] = [
    { key: 'line', header: caption, wrap: true, render: ([, label]) => t(label) },
    ...totals.map((total) => ({
      key: total.currency,
      header: total.currency,
      align: 'end' as const,
      render: ([key]: readonly [MoneyLine, WebKey]) => (
        <Money value={{ amountMinor: total[key], currency: total.currency }} />
      ),
    })),
  ];
  return (
    <DataTable dense caption={caption} columns={columns} rows={lines} rowKey={([key]) => key} />
  );
}

/**
 * `/reports?tab=finance`: the financial statement (`docs/financial-reports.md`). Sales,
 * cash from customers and the wallet, per bucket and for the period. The definitions are
 * on the page because a number whose meaning has to be guessed is not a financial figure.
 */
function FinancialReport({ selection, route }: { selection: ReportRangeSelection; route: Route }) {
  const granularity = financialGranularityOf(route);
  const report = useReport(
    ['financial', selection, granularity ?? 'AUTO'],
    () => fetchReportFinancial(selection, granularity),
    rangeIsComplete(selection),
  );
  const data: ReportFinancialResponse | undefined = report.data;
  const shown = data?.granularity ?? granularity ?? 'DAY';
  return (
    <>
      <Card
        title={t('web.finance_title')}
        hint={t('web.finance_hint')}
        actions={<ExportButtons selection={selection} report="FINANCIAL" granularity={shown} />}
      >
        <div className="finance-controls">
          <Pills
            value={shown}
            onChange={(next) => setQueries(route, [['granularity', next]])}
            items={FINANCIAL_GRANULARITIES.map((id) => ({
              id,
              label: t(GRANULARITY_LABELS[id]),
            }))}
          />
        </div>
        <ul className="finance-definitions small">
          <li>{t('web.finance_def_sales')}</li>
          <li>{t('web.finance_def_cash')}</li>
          <li>{t('web.finance_def_wallet')}</li>
          <li>{t('web.finance_def_topup')}</li>
        </ul>
        <StateSwitch
          query={report}
          isEmpty={data !== undefined && data.totals.length === 0 && data.wallet.length === 0}
          empty={<Empty title={t('web.finance_empty')} icon="inbox" />}
        >
          {data !== undefined && (
            <div className="finance-sections">
              <SectionTable
                caption={t('web.finance_section_sales')}
                lines={SALES_LINES}
                totals={data.totals}
              />
              <SectionTable
                caption={t('web.finance_section_cash')}
                lines={CASH_LINES}
                totals={data.totals}
              />
              <p className="muted small" data-testid="finance-provider-fee">
                {t('web.finance_provider_fee_not_recorded')}
              </p>
              <SectionTable
                caption={t('web.finance_section_wallet_flow')}
                lines={WALLET_LINES}
                totals={data.totals}
              />
              <p className="muted small" data-testid="finance-no-profit">
                {t('web.finance_no_profit')}
              </p>
            </div>
          )}
        </StateSwitch>
      </Card>

      {data !== undefined && (
        <>
          <Card title={t('web.finance_buckets_title')} hint={t('web.finance_buckets_hint')}>
            <BucketTable data={data} />
          </Card>
          <Card title={t('web.finance_wallet_title')} hint={t('web.finance_wallet_hint')}>
            <WalletLiabilityTables data={data} />
          </Card>
          <Card title={t('web.finance_channels_title')} hint={t('web.finance_channels_hint')}>
            <ChannelTables data={data} />
          </Card>
          <Card title={t('web.finance_products_title')} hint={t('web.finance_products_hint')}>
            <ProductTable data={data} />
          </Card>
        </>
      )}
    </>
  );
}

interface BucketRow {
  readonly key: string;
  readonly label: string;
  readonly lines: FinancialLines;
}

const BUCKET_MONEY: readonly (readonly [MoneyLine, WebKey])[] = [
  ['sales', 'web.finance_sales'],
  ['refunds', 'web.finance_refunds'],
  ['netSales', 'web.finance_net_sales'],
  ['customerPaid', 'web.finance_customer_paid'],
  ['walletTopups', 'web.finance_wallet_topups'],
  ['walletSpending', 'web.finance_wallet_spending'],
];

function BucketTable({ data }: { data: ReportFinancialResponse }) {
  const rows: BucketRow[] = data.buckets.flatMap((bucket) =>
    (bucket.lines ?? []).map((lines) => ({
      key: `${bucket.index}|${lines.currency}`,
      label: bucket.label,
      lines,
    })),
  );
  const columns: Column<BucketRow>[] = [
    {
      key: 'bucket',
      header: t('web.finance_col_bucket'),
      render: (r) => <span className="nowrap">{r.label}</span>,
    },
    { key: 'currency', header: t('web.finance_col_currency'), render: (r) => r.lines.currency },
    {
      key: 'count',
      header: t('web.finance_col_sales_count'),
      align: 'end',
      render: (r) => <Num value={r.lines.salesCount} />,
    },
    ...BUCKET_MONEY.map(([key, label]) => ({
      key,
      header: t(label),
      align: 'end' as const,
      render: (r: BucketRow) => (
        <Money value={{ amountMinor: r.lines[key], currency: r.lines.currency }} />
      ),
    })),
  ];
  if (rows.length === 0) return <Empty variant="compact" title={t('web.finance_empty')} />;
  return (
    <DataTable
      dense
      caption={t('web.finance_buckets_title')}
      rows={rows}
      rowKey={(r) => r.key}
      columns={columns}
    />
  );
}

interface LiabilityRow {
  readonly key: string;
  readonly label: string;
  readonly amount: string;
}

function WalletLiabilityTables({ data }: { data: ReportFinancialResponse }) {
  if (data.wallet.length === 0) return <Empty variant="compact" title={t('web.finance_empty')} />;
  return (
    <>
      {data.wallet.map((wallet) => {
        const rows: LiabilityRow[] = [
          { key: 'opening', label: t('web.finance_opening'), amount: wallet.opening },
          ...wallet.movements.map((m) => ({
            key: m.group,
            label: t(WALLET_GROUP_LABELS[m.group]),
            amount: m.amount,
          })),
          { key: 'closing', label: t('web.finance_closing'), amount: wallet.closing },
        ];
        return (
          <DataTable
            key={wallet.currency}
            dense
            caption={`${t('web.finance_wallet_title')} ${wallet.currency}`}
            rows={rows}
            rowKey={(r) => r.key}
            rowClassName={(r) =>
              r.key === 'opening' || r.key === 'closing' ? 'finance-balance-row' : undefined
            }
            columns={[
              { key: 'label', header: wallet.currency, wrap: true, render: (r) => r.label },
              {
                key: 'amount',
                header: t('web.report_col_net_amount'),
                align: 'end',
                render: (r) => (
                  <Money value={{ amountMinor: r.amount, currency: wallet.currency }} />
                ),
              },
            ]}
          />
        );
      })}
    </>
  );
}

type CashRow = ReportFinancialResponse['cashByRoute'][number];

function ChannelTables({ data }: { data: ReportFinancialResponse }) {
  const cashMoney: readonly (readonly ['principal' | 'customerFees' | 'customerPaid', WebKey])[] = [
    ['principal', 'web.finance_principal'],
    ['customerFees', 'web.finance_customer_fees'],
    ['customerPaid', 'web.finance_customer_paid'],
  ];
  return (
    <>
      <DataTable
        dense
        caption={t('web.finance_channels_title')}
        rows={data.salesByChannel}
        rowKey={(r) => `${r.method ?? ''}|${r.provider ?? ''}|${r.currency}`}
        columns={[
          {
            key: 'method',
            header: t('web.report_col_method'),
            render: (r) =>
              r.method === null ? t('web.finance_no_payment') : t(METHOD_LABELS[r.method]),
          },
          {
            key: 'route',
            header: t('web.report_col_route'),
            render: (r) => <Ltr>{r.provider ?? '—'}</Ltr>,
          },
          {
            key: 'orders',
            header: t('web.report_col_orders'),
            align: 'end',
            render: (r) => <Num value={r.orders} />,
          },
          {
            key: 'sales',
            header: t('web.finance_sales'),
            align: 'end',
            render: (r) => <Money value={{ amountMinor: r.sales, currency: r.currency }} />,
          },
        ]}
      />
      <h3 className="finance-subtitle">{t('web.finance_cash_routes_title')}</h3>
      <DataTable
        dense
        caption={t('web.finance_cash_routes_title')}
        rows={data.cashByRoute}
        rowKey={(r) => `${r.method}|${r.provider ?? ''}|${r.kind}|${r.currency}`}
        columns={[
          {
            key: 'method',
            header: t('web.report_col_method'),
            render: (r) => t(METHOD_LABELS[r.method]),
          },
          {
            key: 'route',
            header: t('web.report_col_route'),
            render: (r) => <Ltr>{r.provider ?? '—'}</Ltr>,
          },
          {
            key: 'kind',
            header: t('web.report_col_kind'),
            render: (r) =>
              t(r.kind === 'TOPUP' ? 'web.report_kind_topup' : 'web.report_kind_order'),
          },
          ...cashMoney.map(([key, label]) => ({
            key,
            header: t(label),
            align: 'end' as const,
            render: (r: CashRow) => <Money value={{ amountMinor: r[key], currency: r.currency }} />,
          })),
        ]}
      />
    </>
  );
}

function ProductTable({ data }: { data: ReportFinancialResponse }) {
  return (
    <>
      <DataTable
        dense
        caption={t('web.finance_products_title')}
        rows={data.byProduct}
        rowKey={(r) => `${r.productId}|${r.title}|${r.currency}`}
        columns={[
          {
            key: 'title',
            header: t('web.report_col_product'),
            wrap: true,
            render: (r) => <bdi>{r.title}</bdi>,
          },
          {
            key: 'orders',
            header: t('web.report_col_orders'),
            align: 'end',
            render: (r) => <Num value={r.orders} />,
          },
          {
            key: 'sales',
            header: t('web.finance_sales'),
            align: 'end',
            render: (r) => <Money value={{ amountMinor: r.sales, currency: r.currency }} />,
          },
          {
            key: 'refunds',
            header: t('web.finance_refunds'),
            align: 'end',
            render: (r) => <Money value={{ amountMinor: r.refunds, currency: r.currency }} />,
          },
        ]}
      />
      {data.byProductTruncated && (
        <p className="muted small">{t('web.finance_products_truncated')}</p>
      )}
      <p className="small" data-testid="finance-reseller-sales">
        {t('web.finance_reseller_sales')}{' '}
        <MoneyList
          rows={data.resellerSales.map((row) => ({ currency: row.currency, amount: row.sales }))}
        />
      </p>
    </>
  );
}
