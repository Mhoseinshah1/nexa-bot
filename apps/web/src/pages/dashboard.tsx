import { useQuery } from '@tanstack/react-query';
import { PANEL_PAGE_MAX, type PanelSummaryResponse } from '@nexa/contracts';
import { fetchOpsLog, fetchPanels, fetchReadiness } from '../api/client';
import { formatNumber, formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
import {
  Badge,
  Card,
  Distribution,
  Empty,
  MaturityBadge,
  Num,
  PageHead,
  StateSwitch,
  Stat,
  type DistributionSlice,
  type Tone,
  type ViewState,
} from '../ui/kit';
import { pollUnlessFinal } from '../polling';

/**
 * One page of panels, at the contract's ceiling. `PANEL_PAGE_MAX` is the most
 * `GET /panels` will return for any `limit`, so this is as close to the fleet
 * as one request gets — and `truncated` below says so when it is not close
 * enough.
 */
const DASHBOARD_PANEL_PAGE = PANEL_PAGE_MAX;

/** How many open conditions the attention card draws before it counts the rest. */
const ATTENTION_SHOWN = 6;

/**
 * The dashboard.
 *
 * Everything on it is a real figure from a real endpoint. There is no revenue
 * tile, no sales chart and no customer count, because this installation has no
 * orders, no payments and no customers — and a dashboard that invents those is
 * the single most damaging thing this release could ship, since a KPI is
 * exactly the kind of number nobody re-derives before acting on it.
 *
 * Two owner revisions land here:
 *
 *   - **Revision 1** — no abbreviated money. There is no money on this page at
 *     all yet, and when there is, it goes through `<Money>`, which cannot
 *     abbreviate. The preview's dashboard called `tomanShort()` and rendered
 *     `۱۳ میلیون تومان`.
 *   - **Revision 2** — the breakdown is by PANEL, not by location. A panel can
 *     serve several locations, so a location breakdown counts one panel more
 *     than once and the shares do not sum to the fleet. There is also no
 *     location field anywhere in the panel contract, so a location breakdown
 *     could only have come from inventing one.
 */
export function DashboardPage({ permissions }: { permissions: readonly string[] }) {
  const mayViewPanels = permissions.includes('panels.view');
  const mayViewOps = permissions.includes('opslog.view');

  const readiness = useQuery({
    queryKey: ['readiness'],
    queryFn: fetchReadiness,
    refetchInterval: pollUnlessFinal(15_000),
  });

  // One page, deliberately. The dashboard summarises; it does not walk the
  // whole fleet to do it, and a tenant with two hundred panels should not
  // trigger four requests to draw one card.
  const panels = useQuery({
    queryKey: ['panels', 'dashboard'],
    queryFn: () => fetchPanels({ limit: DASHBOARD_PANEL_PAGE }),
    enabled: mayViewPanels,
    // The health distribution is written by the monitor too, and it sits beside
    // a card that refreshes. One stale card next to a live one is worse than
    // two stale cards, because nothing on screen says which is which.
    refetchInterval: pollUnlessFinal(60_000),
  });

  /**
   * `MANAGEMENT_CONDITIONS`, not `MANAGEMENT`.
   *
   * This card is headed "needs attention", so every row on it has to be
   * something an operator can still do something about. The wider management
   * scope also carries one-shot RECORDS — a denial, a lockout, an
   * administrator added — which open and are never resolved, because this
   * product deliberately has no "mark as seen". Asking for them here would
   * fill the card permanently with items no action can clear, which is the
   * burial the management scope was introduced to prevent, arrived at from
   * the other direction. The narrower scope is decided on the server for the
   * same reason the wider one is: a browser-side filter would leave the
   * cursor having walked past what it discarded.
   */
  const alerts = useQuery({
    queryKey: ['ops-log', 'management-conditions', 'open'],
    queryFn: () => fetchOpsLog({ scope: 'MANAGEMENT_CONDITIONS', open: true }),
    enabled: mayViewOps,
    /**
     * The card is headed "needs attention", so it is the one thing on this page
     * that must not be a photograph. Without this it never ran again: readiness
     * polls, this did not, and `refetchOnWindowFocus` is off globally — so a
     * dashboard left open on a wall display kept saying nothing needed action
     * throughout an incident, and kept showing a condition that had already
     * recovered.
     *
     * Same interval as readiness, because they are read together and two
     * cadences on one screen produce a card that disagrees with the one beside
     * it.
     */
    refetchInterval: pollUnlessFinal(15_000),
  });

  /**
   * Whether the two distribution cards are counting the FLEET or one page of it.
   *
   * `GET /panels` is keyset-paged and 200 is its ceiling, not a large number.
   * A tenant with 260 panels got sixty of them counted zero times, while the
   * card's own hint said "each panel is counted exactly once" and the shares
   * rendered as shares of a whole — a count over the wrong population,
   * presented as the population, which is RSV2-BR-021 rebuilt. The aggregation
   * stays (a second, exact endpoint does not exist), but a full page means the
   * card says what it actually covers.
   */
  // The SERVER's cursor, not a length comparison. `length === limit` says
  // "the page is full", which is a different question from "there are more":
  // a tenant with exactly 200 panels got a partial-fleet warning over a
  // complete aggregate. `nextCursor` is non-null only when a panel really was
  // left out.
  const truncated = panels.data?.nextCursor != null;

  return (
    <>
      <PageHead title={t('web.dashboard_title')} subtitle={t('web.dashboard_intro')} />

      <div className="grid">
        <Card title={t('web.system_status')} className="span2">
          <StateSwitch
            state={queryState(readiness)}
            stale={staleAfterError(readiness)}
            onRetry={() => void readiness.refetch()}
          >
            <div className="head-stats">
              {(readiness.data?.dependencies ?? []).map((dependency) => (
                <Stat
                  key={dependency.name}
                  label={dependency.name}
                  value={dependency.status === 'up' ? t('web.up') : t('web.down')}
                  tone={dependency.status === 'up' ? 'ok' : 'danger'}
                  // `latencyMs` is OPTIONAL on the wire, not nullable: a
                  // dependency that reports no timing omits it. Guarding on
                  // `null` let `undefined` through, and the page rendered the
                  // literal text "undefined ms" beside a healthy dependency.
                  {...(dependency.latencyMs === undefined
                    ? {}
                    : { hint: `${formatNumber(dependency.latencyMs)} ms` })}
                />
              ))}
            </div>
          </StateSwitch>
        </Card>

        {mayViewPanels && (
          <Card
            title={t('web.dashboard_panel_distribution')}
            hint={t('web.dashboard_panel_distribution_hint')}
          >
            <StateSwitch
              state={mayViewPanels ? queryState(panels) : 'denied'}
              onRetry={() => void panels.refetch()}
              empty={<Empty title={t('web.dashboard_no_panels')} icon="panels" />}
            >
              <Distribution slices={healthSlices(panels.data?.panels ?? [])} />
              {truncated && <p className="faint small">{t('web.dashboard_partial_fleet')}</p>}
            </StateSwitch>
          </Card>
        )}

        {mayViewPanels && (
          <Card
            title={t('web.dashboard_by_provider')}
            hint={
              truncated ? t('web.dashboard_partial_fleet') : t('web.dashboard_by_provider_hint')
            }
          >
            <StateSwitch
              state={mayViewPanels ? queryState(panels) : 'denied'}
              onRetry={() => void panels.refetch()}
              empty={<Empty title={t('web.dashboard_no_panels')} icon="panels" />}
            >
              <Distribution slices={providerSlices(panels.data?.panels ?? [])} />
              {truncated && <p className="faint small">{t('web.dashboard_partial_fleet')}</p>}
            </StateSwitch>
          </Card>
        )}
      </div>

      {mayViewOps && <AttentionCard query={alerts} />}

      <Card title={t('web.dashboard_scope_title')}>
        <p className="muted small">
          <MaturityBadge value="planned" /> {t('web.dashboard_scope_body')}
        </p>
      </Card>
    </>
  );
}

/**
 * What actually wants an operator's attention.
 *
 * Revision 3 is about this card. Its rule — an ordinary "awaiting payment" is
 * NOT "needs attention" — is a rule about which states qualify, and the way to
 * keep it is to never build a needs-attention count out of "everything that is
 * not finished". So this counts one thing: management-scope conditions that are
 * still OPEN. A condition that resolved itself is history, not attention, and
 * a routine event was never attention in the first place.
 */
function AttentionCard({
  query,
}: {
  query: {
    isPending: boolean;
    isError: boolean;
    refetch: () => unknown;
    data?:
      | {
          events: readonly {
            id: string;
            code: string;
            severity: string;
            message: string;
            lastSeenAt: string;
          }[];
        }
      | undefined;
  };
}) {
  const onLink = useLinkHandler();
  const events = query.data?.events ?? [];

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
        state={queryState(query, events.length === 0)}
        stale={staleAfterError(query)}
        onRetry={() => void query.refetch()}
        empty={
          <Empty
            title={t('web.dashboard_nothing_to_do')}
            hint={t('web.dashboard_nothing_to_do_hint')}
            icon="check"
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
              <span className="faint small nowrap">{formatTimestamp(event.lastSeenAt)}</span>
            </li>
          ))}
        </ul>
        {events.length > ATTENTION_SHOWN && (
          // Six rows with no count read as "there are six". Saying how many
          // were not drawn is the difference between a summary and a lie of
          // omission on the one card headed "needs attention".
          <p className="faint small">
            {t('web.dashboard_more_conditions')} <Num value={events.length - ATTENTION_SHOWN} />
          </p>
        )}
      </StateSwitch>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Aggregation
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

/**
 * The fleet by health state, biggest share first.
 *
 * Exported so a test can assert the aggregation rather than the pixels: it is
 * the one place the dashboard turns rows into a claim, and "by panel, not by
 * location" is a claim about exactly this function.
 */
export function healthSlices(panels: readonly PanelSummaryResponse[]): DistributionSlice[] {
  const counts = new Map<string, number>();
  for (const panel of panels) {
    counts.set(panel.health.state, (counts.get(panel.health.state) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([state, count]) => ({
      key: state,
      label: t(HEALTH_LABELS[state] ?? 'web.health_unchecked'),
      count,
      tone: HEALTH_TONES[state] ?? 'neutral',
    }))
    .sort((a, b) => b.count - a.count);
}

/** The fleet by provider. One row per PANEL, whatever it serves. */
export function providerSlices(panels: readonly PanelSummaryResponse[]): DistributionSlice[] {
  const counts = new Map<string, number>();
  for (const panel of panels) {
    counts.set(panel.providerName, (counts.get(panel.providerName) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ key: name, label: name, count, tone: 'info' as Tone }))
    .sort((a, b) => b.count - a.count);
}

export function severityTone(severity: string): Tone {
  if (severity === 'CRITICAL' || severity === 'ERROR') return 'danger';
  if (severity === 'WARN') return 'warn';
  return 'neutral';
}

/**
 * The four view states, read off a react-query result.
 *
 * `isError` alone is NOT the error state. TanStack Query sets `status: 'error'`
 * on a failed BACKGROUND refetch while `data` is still present, so mapping it
 * straight through replaced a working page with an error card on one transient
 * 5xx from a poll — and, because `StateSwitch` renders the card INSTEAD of its
 * children, unmounted the whole subtree and discarded whatever local state it
 * held. On the panel detail that is the operator's unsaved draft, the basis it
 * is compared against, and the revision their own writes stored. No operator
 * action is involved; it happens on a timer.
 *
 * A query that has never delivered anything still has nothing to show, so that
 * is still the error state.
 */
export function queryState(
  query: { isPending: boolean; isError: boolean; data?: unknown },
  isEmpty = false,
): ViewState {
  if (query.isPending) return 'loading';
  if (query.isError && query.data === undefined) return 'error';
  return isEmpty ? 'empty' : 'ready';
}

/**
 * Showing data whose refresh failed, and therefore owing the reader a warning.
 *
 * Keeping the page is only half the fix: what is on screen is now older than
 * the server and nothing about it looks any different. A screen that has
 * stopped updating without saying so is the defect this admin exists to
 * remove — the legacy system's whole character — so the failure is stated
 * beside the data rather than drawn over the top of it.
 */
export function staleAfterError(query: { isError: boolean; data?: unknown }): boolean {
  return query.isError && query.data !== undefined;
}

export { Num };
