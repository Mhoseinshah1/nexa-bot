import { useQuery } from '@tanstack/react-query';
import {
  DASHBOARD_OPERATIONS_REFRESH_MS,
  NAV_COUNTERS_REFRESH_MS,
  NAV_COUNTER_PERMISSIONS,
  type PermissionKey,
} from '@nexa/contracts';
import { fetchNavCounters, fetchPaymentAttention, fetchSystemDiagnostics } from '../api/client';
import { dashboardAttentionItems, type AttentionItem } from '../attention-view';
import { formatNumber } from '../format';
import { t } from '../i18n/web.fa';
import { pollUnlessFinal } from '../polling';
import { BUSINESS_REFRESH_MS } from '../report-view';
import { useLinkHandler } from '../router';
import { Icon } from '../ui/icons';
import { Banner, Button, Skeleton } from '../ui/kit';

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

  const titleId = 'dash-attention-title';
  return (
    /*
     * The demo's queue: a narrow side column with the amber title and its description, and
     * the items beside it — the severe ones as large red tiles, four abreast, the rest as
     * compact rows with a count chip, three abreast. Empty, the side column stays and the
     * check sits in the item area at the strip's own height.
     */
    <section id="dash-attention" className="card dash-attention" aria-labelledby={titleId}>
      <header className="dash-attn-head">
        <h2 id={titleId}>{t('web.dash_attn_title')}</h2>
        <p className="hint">{t('web.dash_attn_hint')}</p>
      </header>
      <div className="dash-attn-body">
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
          <Skeleton rows={2} cols={3} />
        ) : items.length === 0 ? (
          failed ? null : (
            <div className="dash-attn-clear">
              <Icon name="check" size={22} />
              <b>{t('web.dash_attn_clear')}</b>
              <span>{t('web.dash_attn_clear_hint')}</span>
            </div>
          )
        ) : (
          <AttentionGrid items={items} label={t('web.dash_attn_title')} />
        )}
      </div>
    </section>
  );
}

/**
 * The queue's items, ONE list (each item one link, in `attention-view.ts`'s urgency order):
 * a `danger` item is a large tile, everything else a compact row; the first compact row
 * starts a new line, so the two kinds never share one.
 */
function AttentionGrid({ items, label }: { items: readonly AttentionItem[]; label: string }) {
  const onLink = useLinkHandler();
  const firstNormal = items.findIndex((item) => item.tone !== 'danger');
  return (
    <ul className="dash-attn-list" aria-label={label}>
      {items.map((item, index) => {
        const count = `${formatNumber(item.count)}${item.atLeast ? '+' : ''}`;
        const severe = item.tone === 'danger';
        const name = (
          <span className="dash-attn-lbl">
            {t(item.label)}
            {item.atLeast && <span className="faint small"> ({t('web.attn_at_least')})</span>}
          </span>
        );
        const go = (
          <span className="dash-attn-go">
            {t('web.attn_open')}
            <Icon name="chevronLeft" size={13} />
          </span>
        );
        return (
          <li
            key={item.key}
            className={`attn-${item.tone} ${severe ? 'dash-attn-tile' : 'dash-attn-row'}${index === firstNormal && index > 0 ? ' first-normal' : ''}`}
            data-attention={item.key}
          >
            <a href={item.href} onClick={onLink}>
              {severe ? (
                <>
                  <i className="dash-dot tone-danger" aria-hidden="true" />
                  <b className="num dash-attn-count">{count}</b>
                  {name}
                  {go}
                </>
              ) : (
                <>
                  <span className={`dash-chip ${item.tone}`}>
                    <span className="num">{count}</span>
                  </span>
                  {name}
                  {go}
                </>
              )}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
