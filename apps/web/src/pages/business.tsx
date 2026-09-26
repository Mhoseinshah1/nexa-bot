import { createContext, useContext, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  REPORT_PRODUCT_RANKINGS,
  REPORT_RANGES,
  REPORT_REFERRER_RANKINGS,
  REPORT_TREND_METRICS,
  type CurrencyCode,
  type MoneyComparison,
  type OrderPurpose,
  type PaymentMethod,
  type ReportExportKind,
  type ReportProductRanking,
  type ReportRange,
  type ReportReferrerRanking,
  type ReportTrendMetric,
  type WalletReportGroup,
} from '@nexa/contracts';
import {
  fetchReportFailures,
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
import { splitBytes } from '../format';
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
  type Column,
} from '../ui/kit';
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
  TRIAL: 'web.report_purpose_trial',
};

const METHOD_LABELS: Readonly<Record<PaymentMethod, WebKey>> = {
  WALLET: 'web.payment_method_wallet',
  MANUAL_TRANSFER: 'web.payment_method_manual',
  GATEWAY: 'web.payment_method_gateway',
};

const WALLET_GROUP_LABELS: Readonly<Record<WalletReportGroup, WebKey>> = {
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

/** A byte count in the catalogue's units. Zero is zero bytes here: unlimited lines are counted apart. */
function bytesText(bytes: bigint): string {
  const { value, unit } = splitBytes(bytes);
  return `${value} ${t(unit)}`;
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
  const [draft, setDraft] = useState({ from: selection.from ?? '', to: selection.to ?? '' });
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
  const apply = (event: FormEvent) => {
    event.preventDefault();
    setQueries(route, [
      ['range', 'CUSTOM'],
      ['from', draft.from.trim()],
      ['to', draft.to.trim()],
    ]);
  };
  return (
    <div className="report-range">
      <Pills
        value={selection.range}
        onChange={choose}
        items={REPORT_RANGES.map((range) => ({ id: range, label: t(REPORT_RANGE_LABELS[range]) }))}
      />
      {selection.range === 'CUSTOM' && (
        <form className="toolbar" onSubmit={apply}>
          <Field
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
          <Field label={t('web.report_range_to')} htmlFor="report-to">
            <input
              id="report-to"
              dir="ltr"
              placeholder="1405-07-30"
              value={draft.to}
              onChange={(event) => setDraft({ ...draft, to: event.target.value })}
            />
          </Field>
          <button type="submit" className="btn sm">
            {t('web.report_range_apply')}
          </button>
        </form>
      )}
    </div>
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
  };
}) {
  const span = (side: { startLocal: string; endLocalInclusive: string }) =>
    side.startLocal === side.endLocalInclusive
      ? side.startLocal
      : `${side.startLocal} – ${side.endLocalInclusive}`;
  return (
    <p className="faint small">
      {t('web.report_period_current')} <Ltr>{span(period.current)}</Ltr> ·{' '}
      {t('web.report_period_previous')} <Ltr>{span(period.previous)}</Ltr> ·{' '}
      {t('web.report_updated_at')} <Ltr>{formatInstantIn(period.generatedAt, period.timezone)}</Ltr>
      {period.lengthsDiffer && <> · {t('web.report_lengths_differ')}</>}
    </p>
  );
}

/** An instant in the TENANT's zone and the Jalali calendar, Latin digits: `1405/07/03 14:05`. */
export function formatInstantIn(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('fa-IR-u-ca-persian-nu-latn', {
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
      <Ltr>{formatBasisPoints(change.basisPoints)}</Ltr>
    </span>
  );
}

function Kpi({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="kpi" {...(hint === undefined ? {} : { title: hint })}>
      <span className="muted small">{label}</span>
      {children}
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
    <Kpi label={label} {...(hint === undefined ? {} : { hint })}>
      <strong>
        <Num value={value.current} />
      </strong>
      <ChangeNote current={BigInt(value.current)} previous={BigInt(value.previous)} />
    </Kpi>
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
  return (
    <Kpi label={label} {...(hint === undefined ? {} : { hint })}>
      {value.length === 0 ? (
        <strong>
          <Num value={0} />
        </strong>
      ) : (
        value.map((row) => (
          <span key={row.currency} className="kpi-money">
            <strong>
              <Money value={{ amountMinor: row.current, currency: row.currency }} />
            </strong>
            <ChangeNote current={BigInt(row.current)} previous={BigInt(row.previous)} />
          </span>
        ))
      )}
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
            <div className="kpi-grid">
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
              <Kpi label={t('web.report_kpi_active_services')} hint={t('web.report_kpi_now_hint')}>
                <strong>
                  <Num value={data.activeServices} />
                </strong>
              </Kpi>
            </div>
            <div className="head-stats">
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
    <Card title={t('web.report_trend_title')} hint={t('web.report_trend_hint')}>
      <Pills
        value={metric}
        onChange={setMetric}
        items={REPORT_TREND_METRICS.map((m) => ({ id: m, label: t(METRIC_LABELS[m]) }))}
      />
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
    </Card>
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
}: {
  selection: ReportRangeSelection;
  report: ReportExportKind;
}) {
  const allowed = useContext(ReportExportAllowed);
  if (!allowed || !rangeIsComplete(selection)) return null;
  return (
    <>
      <a className="btn sm" href={reportExportUrl(selection, report, 'csv')} download>
        {t('web.report_export_csv')}
      </a>
      <a className="btn sm" href={reportExportUrl(selection, report, 'xlsx')} download>
        {t('web.report_export_xlsx')}
      </a>
    </>
  );
}

// --- Dashboard section ----------------------------------------------------------

/**
 * The business section of the main dashboard (spec §5). KPI cards and the one trend
 * chart, then a compact top-products card and a compact failure card; everything deeper
 * lives on `/reports`.
 */
export function BusinessOverview({ route }: { route: Route }) {
  const selection = rangeFromRoute(route, 'TODAY');
  const onLink = useLinkHandler();
  return (
    <>
      <Card
        title={t('web.report_business_title')}
        hint={t('web.report_business_hint')}
        actions={
          <a className="btn sm" href="/reports" onClick={onLink}>
            {t('web.report_open_reports')}
          </a>
        }
      >
        <RangePicker route={route} selection={selection} />
      </Card>
      <SummaryCards selection={selection} />
      <TrendCard selection={selection} />
      <div className="grid">
        <TopProducts selection={selection} compact />
        <FailureSummary selection={selection} />
      </div>
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

function TopProducts({
  selection,
  compact = false,
}: {
  selection: ReportRangeSelection;
  compact?: boolean;
}) {
  const [by, setBy] = useState<ReportProductRanking>('REVENUE');
  const [page, setPage] = usePerRange(selection, 1);
  const limit = compact ? 10 : 25;
  const products = useReport(
    ['products', selection, by, page, limit],
    () => fetchReportProducts(selection, { by, limit, page }),
    rangeIsComplete(selection),
  );
  const onLink = useLinkHandler();
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
      title={compact ? t('web.report_top_products_title') : t('web.report_products_title')}
      hint={t('web.report_products_hint')}
      actions={
        compact ? (
          <a className="btn sm" href="/reports?tab=products" onClick={onLink}>
            {t('web.report_view_all')}
          </a>
        ) : (
          <ExportButtons selection={selection} report="PRODUCTS" />
        )
      }
    >
      <Pills
        value={by}
        onChange={(next) => {
          setBy(next);
          setPage(1);
        }}
        items={REPORT_PRODUCT_RANKINGS.map((r) => ({ id: r, label: t(PRODUCT_RANKING_LABELS[r]) }))}
      />
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
            />
            {!compact && (
              <div className="pager">
                <span className="muted small">
                  {t('web.report_total_rows')} <Num value={data.totalRows} />
                </span>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn sm"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  {t('web.report_page_previous')}
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={page * limit >= data.totalRows}
                  onClick={() => setPage(page + 1)}
                >
                  {t('web.report_page_next')}
                </button>
              </div>
            )}
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
            <div className="head-stats">
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
  return (
    <div className="stat">
      <span className="muted small">{label}</span>
      <strong>
        <Num value={value} />
      </strong>
    </div>
  );
}

// --- Reports page ----------------------------------------------------------------

const REPORT_TABS = [
  'sales',
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
      <Card>
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
      render: (r) => <Ltr>{formatInstantIn(r.settledAt, data?.period.timezone ?? 'UTC')}</Ltr>,
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
      <Pills
        value={purpose}
        onChange={(next) => {
          setPurpose(next);
          setCursors([]);
        }}
        items={[
          { id: 'ALL' as const, label: t('web.report_all') },
          ...(Object.keys(PURPOSE_LABELS) as OrderPurpose[]).map((p) => ({
            id: p,
            label: t(PURPOSE_LABELS[p]),
          })),
        ]}
      />
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
            />
            <div className="pager">
              <span className="spacer" />
              <button
                type="button"
                className="btn sm"
                disabled={cursors.length === 0}
                onClick={() => setCursors(cursors.slice(0, -1))}
              >
                {t('web.report_page_previous')}
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={data.nextCursor === null}
                onClick={() =>
                  data.nextCursor !== null && setCursors([...cursors, data.nextCursor])
                }
              >
                {t('web.report_page_next')}
              </button>
            </div>
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
            <div className="head-stats">
              <Stat label={t('web.report_kpi_new_services')} value={data.newServices.current} />
              <Stat
                label={t('web.report_kpi_trial_services')}
                value={data.newTrialServices.current}
              />
              <Stat label={t('web.report_kpi_active_services')} value={data.activeServices} />
              <div className="stat">
                <span className="muted small">{t('web.report_traffic_sold')}</span>
                <strong>
                  <Ltr>{bytesText(BigInt(data.trafficSoldBytes))}</Ltr>
                </strong>
                <span className="faint small">
                  {t('web.report_unlimited_lines')} <Num value={data.unlimitedTrafficLines} />
                </span>
              </div>
            </div>
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
      render: (r) => <Ltr>{formatRate(r.successRateBasisPoints)}</Ltr>,
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
            <DataTable
              columns={columns}
              rows={data.rows}
              rowKey={(r) => `${r.method}|${r.provider ?? ''}|${r.kind}`}
              caption={t('web.report_payments_title')}
            />
            <p className="faint small">
              {t('web.report_success_rate_total')}{' '}
              <Ltr>{formatRate(data.totals.successRateBasisPoints)}</Ltr>
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
      render: (r) => <Ltr>{bytesText(BigInt(r.trafficSoldBytes))}</Ltr>,
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
                  <a href={`/resellers/${r.resellerCustomerId}`} onClick={onLink}>
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
                render: (r) =>
                  r.creditInUse === null || r.creditLimit === null ? (
                    '—'
                  ) : (
                    <>
                      <Money value={r.creditInUse} /> / <Money value={r.creditLimit} />
                    </>
                  ),
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
            <div className="kpi-grid">
              <CountKpi label={t('web.report_referral_signups')} value={data.signups} />
              <Kpi
                label={t('web.report_referral_buyers')}
                hint={t('web.report_referral_buyers_hint')}
              >
                <strong>
                  <Num value={data.convertedBuyers} />
                </strong>
                <span className="faint small">
                  <Ltr>{formatRate(data.conversionBasisPoints)}</Ltr>
                </span>
              </Kpi>
              <Kpi label={t('web.report_referral_gifts')}>{sum(data.signupGifts)}</Kpi>
              <Kpi label={t('web.report_referral_commissions')}>{sum(data.commissions)}</Kpi>
              <Kpi
                label={t('web.report_referral_revenue')}
                hint={t('web.report_referral_revenue_hint')}
              >
                {sum(data.referredRevenue)}
                <span className="faint small">
                  {t('web.report_kpi_sales')} <Num value={data.referredSales} />
                </span>
              </Kpi>
            </div>
            <h3>{t('web.report_top_referrers')}</h3>
            <Pills
              value={by}
              onChange={(next) => {
                setBy(next);
                setPage(1);
              }}
              items={REPORT_REFERRER_RANKINGS.map((r) => ({
                id: r,
                label: t(REFERRER_RANKING_LABELS[r]),
              }))}
            />
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
            <div className="pager">
              <span className="muted small">
                {t('web.report_total_rows')} <Num value={data.topReferrers.totalRows} />
              </span>
              <span className="spacer" />
              <button
                type="button"
                className="btn sm"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                {t('web.report_page_previous')}
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={page * limit >= data.topReferrers.totalRows}
                onClick={() => setPage(page + 1)}
              >
                {t('web.report_page_next')}
              </button>
            </div>
            <PeriodNote period={data.period} />
          </>
        )}
      </StateSwitch>
    </Card>
  );
}
