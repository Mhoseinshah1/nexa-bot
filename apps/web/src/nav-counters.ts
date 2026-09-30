import { useQuery } from '@tanstack/react-query';
import { COUNTER_CAP, NAV_COUNTERS_REFRESH_MS, type NavCountersResponse } from '@nexa/contracts';
import { fetchNavCounters } from './api/client';
import { formatNumber } from './format';
import { t } from './i18n/web.fa';
import { pollUnlessFinal } from './polling';

/**
 * Optional numeric badges beside navigation entries.
 *
 * A counter is keyed by the NAV entry's `id` and comes from ONE lightweight
 * summary request, `GET /nav-counters` — never from fetching a page's own data
 * to count its rows (brief §12), and never from a page of results (lead
 * decision D2: a count is a real server total or it is not shown).
 *
 * Each server counter is withheld (`null`) unless the viewer holds the
 * permission of the page its link opens, and the server decides that; the
 * sidebar draws what arrives. A zero draws nothing: a badge is something to
 * act on, and "0" beside a link is noise.
 */
export interface NavCounter {
  readonly count: number;
  /** `warn` or `danger` when the number is something to act on. */
  readonly tone?: 'warn' | 'danger';
  /**
   * The count is a floor: a server counter it holds stopped at `COUNTER_CAP`.
   * Drawn as «۱۰۰۰+», never as a plain number that reads as exact.
   */
  readonly atLeast?: true;
}

/** The badge's text: the count, with a «+» when it is only a floor. */
export function navCounterText(counter: NavCounter): string {
  const count = formatNumber(counter.count);
  return counter.atLeast === true ? t('web.nav_counter_at_least').replace('{count}', count) : count;
}

export type NavCounters = Readonly<Partial<Record<string, NavCounter>>>;

const NONE: NavCounters = {};

/**
 * Which server counter sits beside which link, and how loud it is.
 *
 * `/services` carries two: services UNRECONCILED (a create whose answer was
 * lost — a READ decides, and it is the louder) and refund requests awaiting
 * action. Both are acted on from that page, so the badge is their sum, only as
 * loud as its loudest part. A counter at `COUNTER_CAP` means "that many or
 * more", so a sum that includes one is a floor — which is what a badge implies.
 */
export function navCountersFrom(response: NavCountersResponse): NavCounters {
  const c = response.counters;
  const out: Record<string, NavCounter> = {};
  const put = (
    id: string,
    count: number | null,
    tone?: 'warn' | 'danger',
    capped: boolean = count === COUNTER_CAP,
  ) => {
    if (count === null || count <= 0) return;
    out[id] = {
      count,
      ...(tone === undefined ? {} : { tone }),
      ...(capped ? { atLeast: true as const } : {}),
    };
  };
  put('alerts', c.openConditions, 'warn');
  put('tickets', c.ticketsAwaitingSupport);
  put('panels', c.unhealthyPanels, 'danger');
  put('payments', c.paymentsUnknown, 'warn');
  if (c.unreconciledServices !== null || c.refundRequestsAwaiting !== null) {
    const unreconciled = c.unreconciledServices ?? 0;
    const refunds = c.refundRequestsAwaiting ?? 0;
    put(
      'services',
      unreconciled + refunds,
      unreconciled > 0 ? 'danger' : undefined,
      unreconciled === COUNTER_CAP || refunds === COUNTER_CAP,
    );
  }
  return out;
}

/**
 * The shell's counters: one request a minute per tab (`NAV_COUNTERS_REFRESH_MS`),
 * shared by every page because the query key is. A refusal, or a response this
 * bundle cannot parse, stops the polling (`pollUnlessFinal`); on any failure the
 * sidebar simply draws no badges — a counter is never guessed.
 */
export function useNavCounters(): NavCounters {
  const query = useQuery({
    queryKey: ['nav-counters'],
    queryFn: fetchNavCounters,
    refetchInterval: pollUnlessFinal(NAV_COUNTERS_REFRESH_MS),
    select: navCountersFrom,
  });
  // A failed re-read keeps the previous answer in the cache; the sidebar does not
  // keep drawing it as though it were current.
  return query.isError ? NONE : (query.data ?? NONE);
}
