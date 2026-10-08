import { useQuery } from '@tanstack/react-query';
import {
  DASHBOARD_OPERATIONS_REFRESH_MS,
  NAV_COUNTERS_REFRESH_MS,
  NAV_COUNTER_PERMISSIONS,
  type PermissionKey,
} from '@nexa/contracts';
import { fetchNavCounters, fetchPaymentAttention, fetchSystemDiagnostics } from '../api/client';
import { dashboardAttentionItems } from '../attention-view';
import { t } from '../i18n/web.fa';
import { pollUnlessFinal } from '../polling';
import { BUSINESS_REFRESH_MS } from '../report-view';
import { Banner, Button, Card, Skeleton } from '../ui/kit';
import { AttentionClear, AttentionList } from './attention-list';

/**
 * The dashboard's attention queue (roadmap B6): what waits for a person NOW, first on the
 * page, every row a server count and a link to the page that handles it.
 *
 * Three existing sources and no new aggregate beyond the one counter B6 added:
 *
 *   - `GET /nav-counters` — the sidebar's counts (open conditions, tickets awaiting support,
 *     unhealthy panels, unreconciled services, refund requests, UNKNOWN payments, business
 *     handoffs). The SAME query key the shell polls, so the dashboard adds no request for
 *     them; the server withholds each without its page's permission.
 *   - `GET /system/diagnostics` (`opslog.view`) — stalled provisioning and exhausted outbox
 *     messages, the System page's own query key and cadence.
 *   - `GET /payment-operations/attention` (`payments.view`) — the payments reconcilable now.
 *     One grouped statement over the tenant's payments with no window, so it is asked at
 *     the reports' five minutes, not the gauges' thirty seconds.
 *
 * A source the viewer may not read is not asked (a 403 on `opslog.view` would be recorded
 * on every poll). A source that failed is said to have failed: "nothing waiting" is drawn
 * only when every source asked has answered, because an empty list over a failed read is
 * the one claim this card must never make.
 */

/** The permissions any row of the queue is drawn under; holding none hides the card. */
export const ATTENTION_PERMISSIONS: readonly PermissionKey[] = [
  ...new Set<PermissionKey>([
    ...Object.values(NAV_COUNTER_PERMISSIONS),
    'opslog.view',
    'payments.view',
  ]),
];

/** The System page's own cadence for the same query key. */
const DIAGNOSTICS_REFRESH_MS = DASHBOARD_OPERATIONS_REFRESH_MS;

export function AttentionQueueCard({ permissions }: { permissions: readonly PermissionKey[] }) {
  const mayViewOps = permissions.includes('opslog.view');
  const mayViewPayments = permissions.includes('payments.view');
  const asked = ATTENTION_PERMISSIONS.some((permission) => permissions.includes(permission));

  const counters = useQuery({
    queryKey: ['nav-counters'],
    queryFn: fetchNavCounters,
    refetchInterval: pollUnlessFinal(NAV_COUNTERS_REFRESH_MS),
    enabled: asked,
  });
  const diagnostics = useQuery({
    queryKey: ['system-diagnostics'],
    queryFn: fetchSystemDiagnostics,
    refetchInterval: pollUnlessFinal(DIAGNOSTICS_REFRESH_MS),
    enabled: mayViewOps,
  });
  const payments = useQuery({
    queryKey: ['payment-attention', null],
    queryFn: () => fetchPaymentAttention({}),
    refetchInterval: pollUnlessFinal(BUSINESS_REFRESH_MS),
    enabled: mayViewPayments,
  });

  if (!asked) return null;

  const sources = [
    counters,
    ...(mayViewOps ? [diagnostics] : []),
    ...(mayViewPayments ? [payments] : []),
  ];
  const failed = sources.some((query) => query.isError);
  const pending = sources.some((query) => query.isPending);
  const items = dashboardAttentionItems({
    counters: counters.data?.counters,
    diagnostics: mayViewOps ? diagnostics.data : undefined,
    payments: mayViewPayments ? payments.data : undefined,
  });

  return (
    <Card
      id="dash-attention"
      className="dash-attention"
      title={t('web.dash_attn_title')}
      hint={t('web.dash_attn_hint')}
    >
      {failed && (
        <Banner
          tone="warn"
          action={
            <Button
              size="sm"
              onClick={() => {
                for (const query of sources) if (query.isError) void query.refetch();
              }}
            >
              {t('web.retry')}
            </Button>
          }
        >
          {t('web.dash_attn_partial')}
        </Banner>
      )}
      {items.length === 0 && pending ? (
        <Skeleton rows={3} cols={2} />
      ) : (
        <AttentionList
          items={items}
          label={t('web.dash_attn_title')}
          empty={
            failed || pending ? null : (
              <AttentionClear
                title={t('web.dash_attn_clear')}
                hint={t('web.dash_attn_clear_hint')}
              />
            )
          }
        />
      )}
    </Card>
  );
}
