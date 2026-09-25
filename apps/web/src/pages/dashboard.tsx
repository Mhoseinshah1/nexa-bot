import { useQuery } from '@tanstack/react-query';
import { PANEL_PAGE_MAX, type PanelSummaryResponse } from '@nexa/contracts';
import { fetchOpsLog, fetchPanels, fetchReadiness } from '../api/client';
import { formatNumber, formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useLinkHandler, type Route } from '../router';
import { BusinessOverview } from './business';
import {
  Badge,
  Card,
  Distribution,
  Empty,
  Num,
  PageHead,
  StateSwitch,
  Stat,
  type DistributionSlice,
  type Tone,
} from '../ui/kit';
import { pollUnlessFinal } from '../polling';
import { queryState, shownData } from '../view-state';

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
 * Everything on it is a real figure from a real endpoint. The business section —
 * revenue, sales, customers — is WP12's, drawn for the owner only and computed by
 * server aggregates over persisted orders, payments and ledger entries
 * (`docs/wp12-business-analytics-audit.md`). A dashboard that invents a KPI is the
 * single most damaging thing this product could ship, since a KPI is exactly the
 * kind of number nobody re-derives before acting on it.
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
export function DashboardPage({
  permissions,
  route,
  superAdmin = false,
}: {
  permissions: readonly string[];
  route?: Route;
  /** WP12: the owner, holding `reports.view`, sees the business section as well. */
  superAdmin?: boolean;
}) {
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
  /*
   * Only what the SCREEN is showing.
   *
   * This feeds a `Card` hint rendered ABOVE the `StateSwitch`, so after a
   * refusal the header went on saying "this count covers only the first page;
   * the fleet is larger" over a card saying the fleet could not be read. The
   * `shownData` rule, unapplied one component over.
   */
  const shownPanels = shownData(panels, mayViewPanels ? queryState(panels) : 'denied', panels.data);
  const truncated = shownPanels?.nextCursor != null;

  return (
    <>
      <PageHead title={t('web.dashboard_title')} subtitle={t('web.dashboard_intro')} />

      {/*
       * WP12's business section, for the owner only. It FIRST, because the owner asked for
       * the business dashboard as the landing page; the operational cards below keep their
       * own cadence and their own permissions, unchanged.
       */}
      {superAdmin && route !== undefined && <BusinessOverview route={route} />}

      <div className="grid">
        <Card title={t('web.system_status')} className="span2">
          <StateSwitch query={readiness}>
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
              query={panels}
              denied={!mayViewPanels}
              /*
                `empty` without `isEmpty` is a prop that can never be read.
                `isEmpty` defaults to false, so `StateSwitch` could not reach
                the empty state and this card fell through to `Distribution`'s
                own `total === 0` guard — which draws the GENERIC `web.empty`
                rather than `web.dashboard_no_panels`. Measured on a zero-panel
                fleet: the fleet copy appeared 0 times and the generic one twice.
                (Quoting the Persian here is what `check:i18n` forbids, and
                rightly: a line scan cannot tell a quoted string in a comment
                from a hard-coded one.)
              */
              isEmpty={(shownPanels?.panels.length ?? 0) === 0}
              empty={<Empty title={t('web.dashboard_no_panels')} icon="panels" />}
            >
              <Distribution slices={healthSlices(shownPanels?.panels ?? [])} />
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
              query={panels}
              denied={!mayViewPanels}
              // The same emptiness as the card above, from the same data the
              // header was already reading.
              isEmpty={(shownPanels?.panels.length ?? 0) === 0}
              empty={<Empty title={t('web.dashboard_no_panels')} icon="panels" />}
            >
              <Distribution slices={providerSlices(shownPanels?.panels ?? [])} />
              {truncated && <p className="faint small">{t('web.dashboard_partial_fleet')}</p>}
            </StateSwitch>
          </Card>
        )}
      </div>

      {mayViewOps && <AttentionCard query={alerts} />}
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
    /*
     * REQUIRED, though it may be `undefined`.
     *
     * The narrowed shape omitted it, and `queryState` accepting an optional
     * `error` is what let that pass: this card would have decided a permanent
     * refusal was worth waiting through while every other card on the page
     * decided otherwise. Making the parameter required surfaced it at the type
     * level the moment the rule changed, which is the whole argument for
     * requiring it.
     */
    error: unknown;
    // Required for the same reason, and `| undefined` rather than `?:` so the
    // caller must actually have a query rather than a shape that resembles one.
    data:
      | {
          events: readonly {
            id: string;
            code: string;
            severity: string;
            message: string;
            /*
             * The ORDERING column, which is the one this card draws.
             *
             * `lastSeenAt` was named here and drawn below while the server
             * ordered by `first_seen_at DESC`. Narrowing the prop to the field
             * actually rendered is what makes a future swap a type error
             * rather than six timestamps in no particular order.
             */
            firstSeenAt: string;
          }[];
          /**
           * Whether the server held more open conditions than this page.
           *
           * `GET /ops-log` answers fifty rows by default and this card asked
           * for one page, then reported `events.length - 6` as "the other
           * open conditions" — forty-four, whether forty-four or four
           * hundred remained. The count on the one card headed "needs
           * attention" understated an incident exactly when it was large.
           * The distribution cards learned this lesson first; same rule.
           */
          nextCursor: object | null;
        }
      | undefined;
  };
}) {
  const onLink = useLinkHandler();
  const events = query.data?.events ?? [];
  // The SERVER's cursor, never a length comparison — the reason is stated
  // where the distribution cards make the same decision.
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
              {/*
               * FIRST seen, which is the column the list is ORDERED by.
               *
               * This drew `lastSeenAt` while the server ordered by
               * `first_seen_at DESC`, so six rows carried six timestamps in
               * no particular order — on the one card headed "needs
               * attention", whose whole purpose is triage. Nothing said
               * "most recent", so nothing was literally false; the card was
               * simply incoherent with its own ordering, which is worse
               * because it reads as a bug in the data.
               *
               * The alerts page has room for both and shows both, with
               * occurrences beside them. Six rows do not, so the one drawn
               * here is the one that decided the order, and it is labelled
               * rather than left as a bare timestamp whose meaning changed.
               */}
              <span className="faint small nowrap" title={t('web.first_seen')}>
                {formatTimestamp(event.firstSeenAt)}
              </span>
            </li>
          ))}
        </ul>
        {(events.length > ATTENTION_SHOWN || truncated) && (
          // Six rows with no count read as "there are six". Saying how many
          // were not drawn is the difference between a summary and a lie of
          // omission on the one card headed "needs attention" — and when the
          // page was full, the number is a FLOOR and the sentence says so.
          //
          // The floor COUNTS the cursor. A non-null `nextCursor` is the server
          // proving at least one more row exists beyond this page, so a full
          // fifty with six drawn is at least forty-five others, not forty-four —
          // the first version of this sentence hedged the number and still
          // understated the minimum it had been handed.
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

export { Num };
