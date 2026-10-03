import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  GatewayConfigurationGap,
  GatewayHealthState,
  GatewayHealthView,
  PaymentGatewayProvider,
  PaymentOpsQueue,
  ReportRange,
} from '@nexa/contracts';
import { fetchGatewayHealth } from '../api/client';
import { formatNumber, formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { setQueries, setQuery, useLinkHandler, type Route } from '../router';
import { ChipGroup } from './commerce-parts';
import { PaymentGatewaysPage } from './payment-gateways';
import {
  Badge,
  Banner,
  Card,
  Empty,
  KV,
  Ltr,
  PageHead,
  StateSwitch,
  TabPanel,
  Tabs,
  type Tone,
} from '../ui/kit';

/**
 * Gateway Health (program §11, `docs/gateway-health.md`): a tab beside the payment routes'
 * configuration, not a separate silo.
 *
 * READ-ONLY. Every line is something the server read from a record; a route with no record
 * says "not recorded", never a reassuring zero. There is no availability percentage and no
 * latency figure because nothing measures either — the latency row says so in words. The
 * credential check is the configuration tab's existing button; this tab says whether a route
 * has a safe check at all.
 */

type GatewaysTab = 'config' | 'health';

const PROVIDER_LABELS: Readonly<Record<PaymentGatewayProvider, WebKey>> = {
  MANUAL_TRANSFER: 'web.payment_gateway_provider_manual_transfer',
  TONPAYS: 'web.payment_gateway_provider_tonpays',
  TONPAYS_TELEGRAM: 'web.payment_gateway_provider_tonpays_telegram',
  TELEGRAM_STARS: 'web.payment_gateway_provider_telegram_stars',
  NOWPAYMENTS: 'web.payment_gateway_provider_nowpayments',
  CENTRALPAY: 'web.payment_gateway_provider_centralpay',
};

const STATE_LABELS: Readonly<Record<GatewayHealthState, WebKey>> = {
  DISABLED: 'web.gateway_health_state_disabled',
  INCOMPLETE: 'web.gateway_health_state_incomplete',
  ATTENTION: 'web.gateway_health_state_attention',
  NO_ACTIVITY: 'web.gateway_health_state_no_activity',
  NO_ISSUES_RECORDED: 'web.gateway_health_state_no_issues',
};

const STATE_TONES: Readonly<Record<GatewayHealthState, Tone>> = {
  DISABLED: 'neutral',
  INCOMPLETE: 'warn',
  ATTENTION: 'danger',
  NO_ACTIVITY: 'info',
  NO_ISSUES_RECORDED: 'ok',
};

const GAP_LABELS: Readonly<Record<GatewayConfigurationGap, WebKey>> = {
  CREDENTIAL_MISSING: 'web.gateway_health_gap_credential_missing',
  WEBHOOK_SECRET_MISSING: 'web.gateway_health_gap_webhook_secret_missing',
  VERIFY_KEY_MISSING: 'web.gateway_health_gap_verify_key_missing',
  RATE_MISSING: 'web.gateway_health_gap_rate_missing',
  CENTRAL_FX_DISABLED: 'web.gateway_health_gap_central_fx_disabled',
  UNIT_RATIO_MISSING: 'web.gateway_health_gap_unit_ratio_missing',
  NO_RECEIVING_ACCOUNT: 'web.gateway_health_gap_no_receiving_account',
};

/** The queues a health card shows, each a link into the Payment Operations Center. */
const CARD_QUEUES: readonly (readonly [PaymentOpsQueue, WebKey])[] = [
  ['PENDING', 'web.payment_ops_queue_pending'],
  ['UNKNOWN', 'web.payment_ops_queue_unknown'],
  ['NEEDS_RECONCILIATION', 'web.payment_ops_queue_needs_reconciliation'],
  ['MISMATCH', 'web.payment_ops_queue_mismatch'],
  ['PROVIDER_ERROR', 'web.payment_ops_queue_provider_error'],
];

const RANGES: readonly (readonly [ReportRange, WebKey])[] = [
  ['TODAY', 'web.payment_ops_range_today'],
  ['LAST_7_DAYS', 'web.payment_ops_range_7d'],
  ['LAST_30_DAYS', 'web.payment_ops_range_30d'],
];

/** The range in the URL; absent is the last seven days, `ALL` is no bound. */
export function healthRangeOf(value: string | null): ReportRange | null {
  if (value === 'ALL') return null;
  const found = RANGES.find(([range]) => range === value);
  return found === undefined ? 'LAST_7_DAYS' : found[0];
}

/** The Payment Operations Center, filtered to one route (and a queue, when given). */
export function opsLinkFor(provider: PaymentGatewayProvider, queue?: PaymentOpsQueue): string {
  const params = new URLSearchParams({ gateway: provider });
  if (queue !== undefined) params.set('queue', queue);
  return `/payments?${params.toString()}`;
}

function when(value: string | null): ReactNode {
  return value === null ? (
    <span className="muted small">{t('web.gateway_health_none_recorded')}</span>
  ) : (
    <span className="nowrap">{formatTimestamp(value)}</span>
  );
}

function HealthCard({
  view,
  onLink,
}: {
  view: GatewayHealthView;
  onLink: ReturnType<typeof useLinkHandler>;
}) {
  const a = view.answers;
  return (
    <Card
      title={t(PROVIDER_LABELS[view.provider])}
      actions={<Badge tone={STATE_TONES[view.state]}>{t(STATE_LABELS[view.state])}</Badge>}
    >
      <KV
        items={[
          [
            t('web.gateway_health_status_active'),
            t(
              view.status === 'ACTIVE'
                ? 'web.gateway_health_status_active'
                : 'web.gateway_health_status_disabled',
            ),
          ],
          [
            t('web.gateway_health_config'),
            view.configuration.complete ? (
              <Badge key="c" tone="ok">
                {t('web.gateway_health_config_complete')}
              </Badge>
            ) : (
              <span key="c">
                {view.configuration.gaps.map((gap) => (
                  <Badge key={gap} tone="warn">
                    {t(GAP_LABELS[gap])}
                  </Badge>
                ))}
              </span>
            ),
          ],
          [
            t('web.gateway_health_check'),
            !view.check.supported ? (
              <span key="k" className="muted small">
                {t('web.gateway_health_check_unsupported')}
              </span>
            ) : view.check.lastAt === null ? (
              <span key="k" className="muted small">
                {t('web.gateway_health_check_never')}
              </span>
            ) : (
              <span key="k">
                {formatTimestamp(view.check.lastAt)} · <Ltr>{view.check.lastResult ?? '—'}</Ltr>
              </span>
            ),
          ],
          [t('web.gateway_health_last_created'), when(a.lastInvoiceCreatedAt)],
          [t('web.gateway_health_last_answered'), when(a.lastInquiryAnsweredAt)],
          [
            t('web.gateway_health_last_inquiry_failure'),
            a.lastInquiryFailure === null ? (
              when(null)
            ) : (
              <span key="f">
                {formatTimestamp(a.lastInquiryFailure.at)} · <Ltr>{a.lastInquiryFailure.code}</Ltr>
              </span>
            ),
          ],
          [
            t('web.gateway_health_last_create_failure'),
            a.lastCreateFailure === null ? (
              when(null)
            ) : (
              <span key="cf">
                {formatTimestamp(a.lastCreateFailure.at)} ·{' '}
                <Ltr>{`${a.lastCreateFailure.state}${a.lastCreateFailure.code === null ? '' : ` · ${a.lastCreateFailure.code}`}`}</Ltr>
              </span>
            ),
          ],
          [
            t('web.gateway_health_errors'),
            // Two recorded counts, never a percentage computed from them.
            <span key="e">
              <Ltr>{formatNumber(a.attemptsWithProviderError)}</Ltr>{' '}
              {t('web.gateway_health_errors_of')} <Ltr>{formatNumber(a.attemptsInWindow)}</Ltr>{' '}
              {t('web.gateway_health_errors_attempts')}
            </span>,
          ],
          [
            t('web.gateway_health_calls'),
            view.callBudget === null ? (
              when(null)
            ) : (
              <span key="b">
                <Ltr>{formatNumber(view.callBudget.used)}</Ltr>{' '}
                {t('web.gateway_health_calls_since')}{' '}
                {formatTimestamp(view.callBudget.windowStartedAt)}
              </span>
            ),
          ],
          [
            t('web.gateway_health_conditions'),
            view.openConditions.length === 0 ? (
              <span key="o" className="muted small">
                {t('web.gateway_health_conditions_none')}
              </span>
            ) : (
              <span key="o">
                {view.openConditions.map((condition) => (
                  <Badge
                    key={condition.code}
                    tone={condition.severity === 'INFO' ? 'info' : 'danger'}
                  >
                    <Ltr>{`${condition.code} ×${String(condition.count)}`}</Ltr>
                  </Badge>
                ))}
              </span>
            ),
          ],
          [
            t('web.gateway_health_last_reconciliation'),
            view.lastReconciliation === null ? (
              when(null)
            ) : (
              <span key="r">
                {formatTimestamp(view.lastReconciliation.at)} ·{' '}
                <Ltr>{view.lastReconciliation.action}</Ltr>
              </span>
            ),
          ],
          // Said, not left out: an operator should not wonder whether it was forgotten.
          [
            t('web.gateway_health_latency'),
            <span key="l" className="muted small">
              {t('web.gateway_health_latency_not_measured')}
            </span>,
          ],
        ]}
      />
      {view.queues !== null && (
        <div className="filter-row">
          <span className="muted small">{t('web.gateway_health_queues')}:</span>
          {CARD_QUEUES.map(([queue, label]) => (
            <a key={queue} href={opsLinkFor(view.provider, queue)} onClick={onLink}>
              {t(label)} <Ltr>{formatNumber(view.queues?.[queue] ?? 0)}</Ltr>
            </a>
          ))}
        </div>
      )}
      <p className="muted small">{t('web.gateway_health_answers_hint')}</p>
      <div className="form-actions">
        <a href="/payment-gateways" onClick={onLink}>
          {t('web.gateway_health_open_config')}
        </a>
        <a href={opsLinkFor(view.provider)} onClick={onLink}>
          {t('web.gateway_health_open_ops')}
        </a>
      </div>
    </Card>
  );
}

export function GatewayHealthPanel({ route, denied }: { route: Route; denied: boolean }) {
  const onLink = useLinkHandler();
  const range = healthRangeOf(route.query.get('range'));
  const health = useQuery({
    queryKey: ['gateway-health', range],
    queryFn: () => fetchGatewayHealth(range === null ? {} : { range }),
    enabled: !denied,
  });
  return (
    <>
      <p className="muted small">{t('web.gateway_health_intro')}</p>
      <div className="filter-row">
        <ChipGroup
          label={t('web.gateway_health_range')}
          value={range ?? 'ALL'}
          onChange={(next) => setQuery(route, 'range', next === 'LAST_7_DAYS' ? null : next)}
          items={[
            ...RANGES.map(([id, label]) => ({ id, label: t(label) })),
            { id: 'ALL', label: t('web.gateway_health_range_all') },
          ]}
        />
      </div>
      <StateSwitch query={health} denied={denied}>
        {health.data === undefined ? null : health.data.gateways.length === 0 ? (
          <Empty title={t('web.gateway_health_empty')} />
        ) : (
          <>
            {health.data.withheld.includes('PAYMENTS') && (
              <Banner tone="info">{t('web.gateway_health_queues_withheld')}</Banner>
            )}
            {health.data.gateways.map((view) => (
              <HealthCard key={view.provider} view={view} onLink={onLink} />
            ))}
          </>
        )}
      </StateSwitch>
    </>
  );
}

/**
 * The payment routes page with its two tabs: the existing configuration, and health. The tab
 * is in the URL (`?tab=health`), so a link and a reload land where the operator was.
 */
export function PaymentGatewaysTabbedPage({
  route,
  denied,
  mayEdit,
}: {
  route: Route;
  denied: boolean;
  mayEdit: boolean;
}) {
  const tab: GatewaysTab = route.query.get('tab') === 'health' ? 'health' : 'config';
  const tabs = (
    <Tabs<GatewaysTab>
      panelId="gateways-panel"
      value={tab}
      onChange={(next) =>
        setQueries(route, [
          ['tab', next === 'config' ? null : next],
          ['range', null],
        ])
      }
      items={[
        { id: 'config', label: t('web.gateway_tab_config') },
        { id: 'health', label: t('web.gateway_tab_health') },
      ]}
    />
  );
  if (tab === 'config') {
    return (
      <PaymentGatewaysPage
        denied={denied}
        mayEdit={mayEdit}
        tabs={
          <>
            {tabs}
            <TabPanel id="gateways-panel" labelledBy="gateways-panel-tab-config">
              {null}
            </TabPanel>
          </>
        }
      />
    );
  }
  // The same head as the configuration tab, so the tab strip does not move between them.
  return (
    <>
      <PageHead
        title={t('web.payment_gateways_title')}
        subtitle={t('web.payment_gateways_subtitle')}
      />
      {tabs}
      <TabPanel id="gateways-panel" labelledBy="gateways-panel-tab-health">
        <GatewayHealthPanel route={route} denied={denied} />
      </TabPanel>
    </>
  );
}
