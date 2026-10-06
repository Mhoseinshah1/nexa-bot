import { useQuery } from '@tanstack/react-query';
import {
  REPORT_REFRESH_INTERVAL_MS,
  type ReportRange,
  type SupportAiAutoOutcome,
  type SupportAnalyticsResponse,
} from '@nexa/contracts';
import { fetchSupportAnalytics } from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { REPORT_RANGE_LABELS, rangeFromRoute, rangeIsComplete } from '../report-view';
import { setQuery, type Route } from '../router';
import {
  Badge,
  Banner,
  Card,
  DataTable,
  Distribution,
  Empty,
  FilterBar,
  FilterChip,
  FilterChips,
  KV,
  Num,
  PageHead,
  StatCard,
  StateSwitch,
  type Column,
} from '../ui/kit';
import { BUSINESS_STATE_LABELS } from './business-chats';
import { HANDOFF_LABELS } from './handoff-labels';
import {
  OPERATION_LABELS,
  OUTCOME_LABELS,
  OUTCOME_TONES,
  SUPPORT_AI_PROVIDER_LABELS,
} from './support-ai';
import { FAILURE_CLASS_LABELS } from './support-ai-failure';
import {
  CANDIDATE_STATE_LABELS,
  KNOWLEDGE_SOURCE_LABELS,
  KNOWLEDGE_STATE_LABELS,
} from './support-knowledge';

/**
 * TB10 — support analytics (program §40, §46). One read, `GET /support-ai/analytics`, charged
 * `support_ai.configure` by the server; this page only draws what arrives.
 *
 * Two of the figures are SNAPSHOTS (who holds each conversation now, the knowledge base now)
 * and are labelled so; everything else is counted in the chosen period, half-open. There is
 * no cost figure: `OQ-TB-07` is open, and a price this page invented would be a number
 * nobody approved. Tokens are shown instead, and the page says why.
 */

/** The presets offered; a CUSTOM range in the address is honoured but not offered here. */
export const SUPPORT_ANALYTICS_RANGES: readonly ReportRange[] = [
  'TODAY',
  'YESTERDAY',
  'LAST_7_DAYS',
  'LAST_30_DAYS',
  'THIS_MONTH',
  'PREVIOUS_MONTH',
];

const DEFAULT_RANGE: ReportRange = 'LAST_7_DAYS';

/** Every automatic outcome in words: the guard that failed, or why nothing was done. */
export const AUTO_OUTCOME_LABELS: Readonly<Record<SupportAiAutoOutcome, WebKey>> = {
  sent: 'web.sa_auto_sent',
  dropped_mode: 'web.sa_auto_dropped_mode',
  dropped_epoch: 'web.sa_auto_dropped_epoch',
  dropped_state: 'web.sa_auto_dropped_state',
  dropped_coalesced: 'web.sa_auto_dropped_coalesced',
  dropped_connection: 'web.sa_auto_dropped_connection',
  dropped_scope: 'web.sa_auto_dropped_scope',
  guard_content: 'web.sa_auto_guard_content',
  guard_customer_blocked: 'web.sa_auto_guard_customer_blocked',
  guard_consecutive: 'web.sa_auto_guard_consecutive',
  guard_window: 'web.sa_auto_guard_window',
  guard_decision: 'web.sa_auto_guard_decision',
  guard_handoff_topic: 'web.sa_auto_guard_handoff_topic',
  guard_human_requested: 'web.sa_auto_guard_human_requested',
  guard_topic_allowlist: 'web.sa_auto_guard_topic_allowlist',
  guard_identity: 'web.sa_auto_guard_identity',
  guard_account_review: 'web.sa_auto_guard_account_review',
  guard_confidence: 'web.sa_auto_guard_confidence',
  guard_reply_bounds: 'web.sa_auto_guard_reply_bounds',
  guard_grounding: 'web.sa_auto_guard_grounding',
  handoff_ai_requested: 'web.sa_auto_handoff_ai_requested',
  handoff_output_invalid: 'web.sa_auto_handoff_output_invalid',
  handoff_ai_unavailable: 'web.sa_auto_handoff_ai_unavailable',
  handoff_stale: 'web.sa_auto_handoff_stale',
};

export function SupportAnalyticsPage({ route, denied }: { route: Route; denied: boolean }) {
  const chosen = rangeFromRoute(route, DEFAULT_RANGE);
  const selection = rangeIsComplete(chosen) ? chosen : { range: DEFAULT_RANGE };
  const analytics = useQuery({
    queryKey: ['support-analytics', selection],
    queryFn: () => fetchSupportAnalytics(selection),
    enabled: !denied,
    refetchInterval: REPORT_REFRESH_INTERVAL_MS,
  });
  const data = denied ? undefined : analytics.data;

  return (
    <>
      <PageHead
        title={t('web.sa_title')}
        subtitle={
          data === undefined
            ? t('web.sa_intro')
            : `${t('web.sa_intro')} ${t('web.sa_period_from')} ${formatTimestamp(data.period.start)} ${t('web.sa_period_to')} ${formatTimestamp(data.period.end)}`
        }
      />
      <Card>
        <FilterBar hidden={denied}>
          <FilterChips label={t('web.sa_range')}>
            {SUPPORT_ANALYTICS_RANGES.map((range) => (
              <FilterChip
                key={range}
                pressed={selection.range === range}
                onClick={() => setQuery(route, 'range', range)}
              >
                {t(REPORT_RANGE_LABELS[range])}
              </FilterChip>
            ))}
          </FilterChips>
        </FilterBar>
      </Card>
      <StateSwitch query={analytics} denied={denied}>
        {data !== undefined && <AnalyticsBody data={data} />}
      </StateSwitch>
    </>
  );
}

function AnalyticsBody({ data }: { data: SupportAnalyticsResponse }) {
  return (
    <div className="stack">
      <div className="stat-grid" aria-label={t('web.sa_auto')}>
        <StatCard
          icon="send"
          label={t('web.sa_auto_sent_total')}
          value={<Num value={data.auto.sent} />}
        />
        <StatCard
          icon="user"
          label={t('web.sa_auto_handed_off_total')}
          value={<Num value={data.auto.handedOff} />}
        />
        <StatCard
          icon="clock"
          label={t('web.sa_auto_dropped_total')}
          value={<Num value={data.auto.dropped} />}
          hint={t('web.sa_auto_dropped_hint')}
        />
        <StatCard
          icon="edit"
          label={t('web.sa_assist_requested')}
          value={<Num value={data.assist.requested} />}
        />
      </div>

      <div className="grid-2">
        <Card title={t('web.sa_conversations_now')} hint={t('web.sa_snapshot_hint')}>
          <Distribution
            slices={data.conversationsNow.map((row) => ({
              key: row.state,
              label: t(BUSINESS_STATE_LABELS[row.state]),
              count: row.count,
              tone: row.state === 'HANDOFF_REQUIRED' ? 'danger' : 'info',
            }))}
          />
        </Card>
        <Card title={t('web.sa_handoffs')} hint={t('web.sa_handoffs_hint')}>
          {data.handoffsByReason.length === 0 ? (
            <Empty title={t('web.sa_none_in_period')} icon="check" />
          ) : (
            <Distribution
              slices={data.handoffsByReason.map((row) => ({
                key: row.reason,
                label: t(HANDOFF_LABELS[row.reason]),
                count: row.count,
                tone: 'warn',
              }))}
            />
          )}
        </Card>
      </div>

      <div className="grid-2">
        <Card title={t('web.sa_auto')} hint={t('web.sa_auto_hint')}>
          <KV
            items={[
              [t('web.sa_auto_sent_total'), <Num key="s" value={data.auto.sent} />],
              [t('web.sa_auto_handed_off_total'), <Num key="h" value={data.auto.handedOff} />],
              [t('web.sa_auto_dropped_total'), <Num key="d" value={data.auto.dropped} />],
              [t('web.sa_auto_pending'), <Num key="p" value={data.auto.pending} />],
            ]}
          />
          {data.auto.byOutcome.length > 0 && (
            <Distribution
              slices={data.auto.byOutcome.map((row) => ({
                key: row.outcome,
                label: t(AUTO_OUTCOME_LABELS[row.outcome]),
                count: row.count,
              }))}
            />
          )}
        </Card>
        <Card title={t('web.sa_assist')} hint={t('web.sa_assist_hint')}>
          <KV
            items={[
              [t('web.sa_assist_requested'), <Num key="r" value={data.assist.requested} />],
              [t('web.sa_assist_sent'), <Num key="s" value={data.assist.sent} />],
              [t('web.sa_assist_discarded'), <Num key="d" value={data.assist.discarded} />],
              // L1: replaced by a newer request, counted apart from what operators discarded.
              [t('web.sa_assist_superseded'), <Num key="x" value={data.assist.superseded} />],
              [t('web.sa_assist_failed'), <Num key="f" value={data.assist.failed} />],
              [t('web.sa_assist_open'), <Num key="o" value={data.assist.open} />],
            ]}
          />
        </Card>
      </div>

      <ProviderRunsCard rows={data.providerRuns} />
      <AiFailuresCard rows={data.aiFailures} />

      <div className="grid-2">
        <Card title={t('web.sa_learning')} hint={t('web.sa_learning_hint')}>
          <Distribution
            slices={data.learningByState.map((row) => ({
              key: row.state,
              label: t(CANDIDATE_STATE_LABELS[row.state]),
              count: row.count,
            }))}
          />
        </Card>
        <KnowledgeCard rows={data.knowledgeBySource} />
      </div>
    </div>
  );
}

/** Program §12: why the AI's failed calls failed, by class — counts only, never text. */
function AiFailuresCard({ rows }: { rows: SupportAnalyticsResponse['aiFailures'] }) {
  type Row = SupportAnalyticsResponse['aiFailures'][number];
  const columns: readonly Column<Row>[] = [
    {
      key: 'class',
      header: t('web.sai_failure_reason'),
      render: (row) => t(FAILURE_CLASS_LABELS[row.failureClass]),
    },
    {
      key: 'operation',
      header: t('web.sai_diag_operation'),
      render: (row) => t(OPERATION_LABELS[row.operation]),
    },
    {
      key: 'provider',
      header: t('web.sai_provider'),
      render: (row) => t(SUPPORT_AI_PROVIDER_LABELS[row.provider]),
    },
    { key: 'runs', header: t('web.sa_runs'), render: (row) => <Num value={row.runs} /> },
  ];
  return (
    <Card title={t('web.sai_ai_failures')} hint={t('web.sai_ai_failures_hint')}>
      {rows.length === 0 ? (
        <Empty title={t('web.sai_ai_failures_empty')} icon="activity" />
      ) : (
        <DataTable
          caption={t('web.sai_ai_failures')}
          columns={columns}
          rows={rows}
          rowKey={(row) => `${row.operation}:${row.provider}:${row.failureClass}`}
        />
      )}
    </Card>
  );
}

function ProviderRunsCard({ rows }: { rows: SupportAnalyticsResponse['providerRuns'] }) {
  type Row = SupportAnalyticsResponse['providerRuns'][number];
  const columns: readonly Column<Row>[] = [
    {
      key: 'provider',
      header: t('web.sai_provider'),
      render: (row) => t(SUPPORT_AI_PROVIDER_LABELS[row.provider]),
    },
    {
      key: 'outcome',
      header: t('web.sa_outcome'),
      render: (row) => (
        <Badge tone={OUTCOME_TONES[row.outcome]}>{t(OUTCOME_LABELS[row.outcome])}</Badge>
      ),
    },
    { key: 'runs', header: t('web.sa_runs'), render: (row) => <Num value={row.runs} /> },
    { key: 'p50', header: t('web.sa_p50'), render: (row) => <Num value={row.p50LatencyMs} /> },
    { key: 'p95', header: t('web.sa_p95'), render: (row) => <Num value={row.p95LatencyMs} /> },
    {
      key: 'input',
      header: t('web.sai_input_tokens'),
      render: (row) => <Num value={row.inputTokens} />,
    },
    {
      key: 'output',
      header: t('web.sai_output_tokens'),
      render: (row) => <Num value={row.outputTokens} />,
    },
  ];
  return (
    <Card title={t('web.sa_runs_title')} hint={t('web.sa_runs_hint')}>
      <Banner tone="info" title={t('web.sa_cost_title')}>
        <p>{t('web.sa_cost_hint')}</p>
      </Banner>
      {rows.length === 0 ? (
        <Empty title={t('web.sa_none_in_period')} icon="activity" />
      ) : (
        <DataTable
          caption={t('web.sa_runs_title')}
          columns={columns}
          rows={rows}
          rowKey={(row) => `${row.provider}:${row.outcome}`}
          dense
        />
      )}
    </Card>
  );
}

function KnowledgeCard({ rows }: { rows: SupportAnalyticsResponse['knowledgeBySource'] }) {
  type Row = SupportAnalyticsResponse['knowledgeBySource'][number];
  const columns: readonly Column<Row>[] = [
    {
      key: 'source',
      header: t('web.sa_source'),
      render: (row) => t(KNOWLEDGE_SOURCE_LABELS[row.source]),
    },
    {
      key: 'state',
      header: t('web.status'),
      render: (row) => t(KNOWLEDGE_STATE_LABELS[row.state]),
    },
    {
      key: 'enabled',
      header: t('web.sa_enabled'),
      render: (row) => t(row.enabled ? 'web.sa_enabled_yes' : 'web.sa_enabled_no'),
    },
    { key: 'count', header: t('web.sa_count'), render: (row) => <Num value={row.count} /> },
  ];
  return (
    <Card title={t('web.sa_knowledge')} hint={t('web.sa_snapshot_hint')}>
      {rows.length === 0 ? (
        <Empty title={t('web.sa_knowledge_empty')} icon="content" />
      ) : (
        <DataTable
          caption={t('web.sa_knowledge')}
          columns={columns}
          rows={rows}
          rowKey={(row) => `${row.source}:${row.state}:${String(row.enabled)}`}
          dense
        />
      )}
    </Card>
  );
}
