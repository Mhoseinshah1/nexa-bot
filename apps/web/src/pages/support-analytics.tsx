import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  REPORT_REFRESH_INTERVAL_MS,
  supportAutoOutcomeCountsOf,
  supportHandoffCountsOf,
  type BusinessHandoffReason,
  type ReportRange,
  type SupportAiAutoOutcome,
  type SupportAnalyticsResponse,
} from '@nexa/contracts';
import {
  fetchSupportAnalytics,
  fetchSupportHandoffQuestions,
  fetchSupportKnowledgeGaps,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { REPORT_RANGE_LABELS, rangeFromRoute, rangeIsComplete } from '../report-view';
import { setQuery, useLinkHandler, type Route } from '../router';
import {
  Badge,
  Banner,
  Card,
  DataTable,
  Distribution,
  Empty,
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
import { SAI_AUTO_TOPIC_LABELS } from './support-ai';
import { HANDOFF_LABELS } from './handoff-labels';
import {
  OPERATION_LABELS,
  OUTCOME_LABELS,
  OUTCOME_TONES,
  SUPPORT_AI_PROVIDER_LABELS,
} from './support-ai';
import { FAILURE_CLASS_ACTIONS, FAILURE_CLASS_LABELS } from './support-ai-failure';
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
  sent_clarifying: 'web.sa_auto_sent_clarifying',
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
  guard_clarifying_limit: 'web.sa_auto_guard_clarifying_limit',
  handoff_ai_requested: 'web.sa_auto_handoff_ai_requested',
  handoff_output_invalid: 'web.sa_auto_handoff_output_invalid',
  handoff_ai_unavailable: 'web.sa_auto_handoff_ai_unavailable',
  handoff_stale: 'web.sa_auto_handoff_stale',
  guard_no_progress: 'web.sa_auto_guard_no_progress',
  guard_repeated_advice: 'web.sa_auto_guard_repeated_advice',
  guard_inbound_flood: 'web.sa_auto_guard_inbound_flood',
  no_action: 'web.sa_auto_no_action',
  guard_output_policy: 'web.sa_auto_guard_output_policy',
  guard_refusal_abuse: 'web.sa_auto_guard_refusal_abuse',
  sent_link: 'web.sa_auto_sent_link',
  guard_tool_scope: 'web.sa_auto_guard_tool_scope',
  guard_tool_rate_limit: 'web.sa_auto_guard_tool_rate_limit',
  sent_payment_delivered: 'web.sa_auto_sent_payment_delivered',
  sent_payment_ask: 'web.sa_auto_sent_payment_ask',
  handoff_payment_checked: 'web.sa_auto_handoff_payment_checked',
  sent_unsupported_content: 'web.sa_auto_sent_unsupported_content',
};

export function SupportAnalyticsPage({
  route,
  denied,
  mayReadText = false,
}: {
  route: Route;
  denied: boolean;
  /** `business_chats.view`: the customers' own words behind a handoff (the server checks it too). */
  mayReadText?: boolean;
}) {
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
            ? t('web.sa_intro_counts_and_text')
            : `${t('web.sa_intro_counts_and_text')} ${t('web.sa_period_from')} ${formatTimestamp(data.period.start)} ${t('web.sa_period_to')} ${formatTimestamp(data.period.end)}`
        }
      />
      {/* Demo parity (DIFFS support-analytics #2): the range label beside the pills, no rule under them. */}
      {!denied && (
        <Card className="sa-range-card" tight>
          <div className="sa-range">
            <span className="sa-range-label">{t('web.sa_range')}</span>
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
          </div>
        </Card>
      )}
      <StateSwitch query={analytics} denied={denied}>
        {data !== undefined && <AnalyticsBody data={data} mayReadText={mayReadText} />}
      </StateSwitch>
    </>
  );
}

/**
 * The automatic outcomes' bars take a colour each (demo parity, DIFFS support-analytics #4), in
 * the chart series' order, so neighbouring outcomes are told apart at a glance.
 */
const OUTCOME_BAR_TONES = ['info', 'ok', 'violet', 'warn', 'danger', 'teal'] as const;

function AnalyticsBody({
  data,
  mayReadText,
}: {
  data: SupportAnalyticsResponse;
  mayReadText: boolean;
}) {
  const resolution = resolutionPercent(data);
  return (
    <div className="stack sa-body">
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
        <StatCard
          icon="check"
          label={t('web.sa_resolution_rate')}
          value={
            resolution === null ? (
              '—'
            ) : (
              <>
                <Num value={resolution} />%
              </>
            )
          }
          hint={t('web.sa_resolution_rate_hint')}
        />
        <StatCard
          icon="activity"
          label={t('web.sa_tokens_total')}
          value={<Num value={tokenTotal(data)} />}
          hint={t('web.sa_tokens_hint')}
        />
      </div>

      <div className="grid-2">
        <Card title={t('web.sa_conversations_now')} hint={t('web.sa_snapshot_hint')}>
          <Distribution
            scale="max"
            slices={data.conversationsNow.map((row) => ({
              key: row.state,
              label: t(BUSINESS_STATE_LABELS[row.state]),
              count: row.count,
              tone: row.state === 'HANDOFF_REQUIRED' ? 'danger' : 'info',
            }))}
          />
        </Card>
      </div>

      <HandoffReasonsCard data={data} mayReadText={mayReadText} />
      <KnowledgeGapsCard mayReadText={mayReadText} />

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
          {supportAutoOutcomeCountsOf(data).length > 0 && (
            <Distribution
              scale="max"
              slices={supportAutoOutcomeCountsOf(data).map((row, index) => ({
                key: row.outcome,
                label: t(AUTO_OUTCOME_LABELS[row.outcome]),
                count: row.count,
                tone: OUTCOME_BAR_TONES[index % OUTCOME_BAR_TONES.length] ?? 'info',
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
            scale="max"
            slices={data.learningByState.map((row) => ({
              key: row.state,
              label: t(CANDIDATE_STATE_LABELS[row.state]),
              count: row.count,
              tone: row.state === 'APPROVED' ? 'ok' : row.state === 'REJECTED' ? 'violet' : 'info',
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
      key: 'action',
      header: t('web.sai_failure_what_to_do'),
      wrap: true,
      render: (row) => t(FAILURE_CLASS_ACTIONS[row.failureClass]),
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
    <Card id="sa-ai-failures" title={t('web.sai_ai_failures')} hint={t('web.sai_ai_failures_hint')}>
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

/**
 * Automatic replies the AI sent, as a share of the automatic jobs that ended in either an
 * answer or a person (dropped and still-pending jobs are neither). «Answered», not «the customer
 * was satisfied»: whether a chat was RESOLVED is not recorded (`OQ-TB-09`), so the page does not
 * claim it. Null when nothing was decided in the period.
 */
export function resolutionPercent(data: Pick<SupportAnalyticsResponse, 'auto'>): number | null {
  const decided = data.auto.sent + data.auto.handedOff;
  return decided === 0 ? null : Math.round((data.auto.sent / decided) * 100);
}

/** Input plus output tokens of every provider call in the period (the provider's own counts). */
export function tokenTotal(data: Pick<SupportAnalyticsResponse, 'providerRuns'>): number {
  return data.providerRuns.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
}

type Fix =
  | { readonly kind: 'link'; readonly label: WebKey; readonly path: string }
  | { readonly kind: 'scroll'; readonly label: WebKey; readonly id: string };

/**
 * The «رفع» for a handoff reason: where the owner fixes the CAUSE (a topic not enabled, a
 * confidence bar too high, no article, a provider failing). Reasons that are a person's by
 * design (money, a human asked for, an account under review) have none.
 */
export const HANDOFF_FIXES: Readonly<Partial<Record<BusinessHandoffReason, Fix>>> = {
  TOPIC_NOT_ALLOWED: { kind: 'link', label: 'web.sa_fix_topic', path: '/support-ai' },
  LOW_CONFIDENCE: { kind: 'link', label: 'web.sa_fix_confidence', path: '/support-ai' },
  INSUFFICIENT_GROUNDING: { kind: 'link', label: 'web.sa_fix_article', path: '/support-knowledge' },
  DECISION_NOT_REPLY: { kind: 'link', label: 'web.sa_fix_article', path: '/support-knowledge' },
  AI_REQUESTED: { kind: 'link', label: 'web.sa_fix_article', path: '/support-knowledge' },
  UNSUPPORTED_CONTENT: { kind: 'link', label: 'web.sa_fix_vision', path: '/support-ai' },
  AI_OUTPUT_INVALID: { kind: 'scroll', label: 'web.sa_fix_failures', id: 'sa-ai-failures' },
  AI_UNAVAILABLE: { kind: 'scroll', label: 'web.sa_fix_failures', id: 'sa-ai-failures' },
  REPLY_OUT_OF_BOUNDS: { kind: 'link', label: 'web.sa_fix_length', path: '/support-ai' },
  CLARIFYING_LIMIT: { kind: 'link', label: 'web.sa_fix_clarifying', path: '/support-ai' },
  LOOP_GUARD: { kind: 'link', label: 'web.sa_fix_limits', path: '/support-ai' },
};

/**
 * Handoffs by their REAL reason, each with its «رفع» and — for a reader who may see the
 * customers' words (`business_chats.view`) — the questions behind it, loaded only when opened.
 */
function HandoffReasonsCard({
  data,
  mayReadText,
}: {
  data: SupportAnalyticsResponse;
  mayReadText: boolean;
}) {
  const rows = supportHandoffCountsOf(data);
  const [open, setOpen] = useState<BusinessHandoffReason | null>(null);
  const onLink = useLinkHandler();
  return (
    <Card title={t('web.sa_handoffs')} hint={t('web.sa_handoffs_hint')}>
      {rows.length === 0 ? (
        <Empty title={t('web.sa_none_in_period')} icon="check" />
      ) : (
        <ul className="plain sa-reasons">
          {rows.map((row) => {
            const fix = HANDOFF_FIXES[row.reason];
            const expanded = open === row.reason;
            return (
              <li key={row.reason} className="sa-reason" data-reason={row.reason}>
                <div className="row">
                  <strong>{t(HANDOFF_LABELS[row.reason])}</strong>
                  <Badge tone="warn">
                    <Num value={row.count} />
                  </Badge>
                  <span className="spacer" />
                  {fix?.kind === 'link' && (
                    <a className="btn sm" href={fix.path} onClick={onLink}>
                      {t('web.sa_fix')}: {t(fix.label)}
                    </a>
                  )}
                  {fix?.kind === 'scroll' && (
                    <a className="btn sm" href={`#${fix.id}`}>
                      {t('web.sa_fix')}: {t(fix.label)}
                    </a>
                  )}
                  {mayReadText && (
                    <button
                      type="button"
                      className="btn sm ghost"
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : row.reason)}
                    >
                      {t(expanded ? 'web.sa_questions_hide' : 'web.sa_questions_show')}
                    </button>
                  )}
                </div>
                {expanded && <HandoffQuestions reason={row.reason} />}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function HandoffQuestions({ reason }: { reason: BusinessHandoffReason }) {
  const onLink = useLinkHandler();
  const questions = useQuery({
    queryKey: ['support-handoff-questions', reason],
    queryFn: () => fetchSupportHandoffQuestions(reason),
  });
  return (
    <StateSwitch
      query={questions}
      isEmpty={questions.data?.items.length === 0}
      empty={<Empty title={t('web.sa_questions_empty')} icon="message" />}
    >
      <ul className="plain sa-questions">
        {(questions.data?.items ?? []).map((item) => (
          <li key={`${item.conversationId}-${item.createdAt}`}>
            <span>{item.question ?? t('web.bchat_text_gone')}</span>{' '}
            <a
              className="small"
              href={`/business-chats/${encodeURIComponent(item.conversationId)}`}
              onClick={onLink}
            >
              {t('web.sa_open_chat')}
            </a>
          </li>
        ))}
      </ul>
    </StateSwitch>
  );
}

/**
 * The knowledge-gaps report: what customers asked that approved content did not cover,
 * clustered by what the AI said was asked, biggest first, each with «ساخت مقاله از این» (the
 * knowledge page opens its create form with the cluster's LABEL as the title; the customers'
 * own words are shown here for context and never put in an address).
 */
function KnowledgeGapsCard({ mayReadText }: { mayReadText: boolean }) {
  const onLink = useLinkHandler();
  const gaps = useQuery({
    queryKey: ['support-knowledge-gaps'],
    queryFn: fetchSupportKnowledgeGaps,
    enabled: mayReadText,
  });
  if (!mayReadText) {
    return (
      <Card title={t('web.sa_gaps')} hint={t('web.sa_gaps_hint')}>
        <Banner tone="info">{t('web.sa_gaps_denied')}</Banner>
      </Card>
    );
  }
  return (
    <Card title={t('web.sa_gaps')} hint={t('web.sa_gaps_hint')}>
      <StateSwitch
        query={gaps}
        isEmpty={gaps.data?.gaps.length === 0}
        empty={<Empty title={t('web.sa_gaps_empty')} icon="check" />}
      >
        <ul className="plain sa-gaps">
          {(gaps.data?.gaps ?? []).map((gap, index) => {
            const topic =
              gap.topic === null ? undefined : SAI_AUTO_TOPIC_LABELS[gap.topic as never];
            const title = gap.intent ?? (topic === undefined ? null : t(topic));
            return (
              <li key={`${gap.topic ?? ''}-${gap.intent ?? ''}-${index}`} className="sa-gap">
                <div className="row">
                  <strong>{gap.intent ?? t('web.sa_gap_no_label')}</strong>
                  {topic !== undefined && <Badge tone="info">{t(topic)}</Badge>}
                  <Badge tone="warn">
                    <Num value={gap.count} />
                  </Badge>
                  <span className="spacer" />
                  {title !== null && (
                    <a
                      className="btn sm"
                      href={`/support-knowledge?new=1&title=${encodeURIComponent(title)}`}
                      onClick={onLink}
                    >
                      {t('web.sa_gap_build')}
                    </a>
                  )}
                </div>
                {gap.reasons.length > 0 && (
                  <p className="muted small">
                    {gap.reasons
                      .map((reason) => t(HANDOFF_LABELS[reason]))
                      .join(t('web.list_separator'))}
                  </p>
                )}
                {gap.examples.length > 0 && (
                  <ul className="plain small">
                    {gap.examples.map((example) => (
                      <li key={example}>{example}</li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </StateSwitch>
    </Card>
  );
}
