import { useQuery } from '@tanstack/react-query';
import { COUNTER_CAP, NAV_COUNTERS_REFRESH_MS, type NavCountersResponse } from '@nexa/contracts';
import { fetchNavCounters } from './api/client';
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
   * `count` is a floor, not a total: a server counter reached `COUNTER_CAP`, which means
   * "this many or more". The sidebar draws it with a plus and says "or more".
   */
  readonly atLeast?: true;
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
 * more", so a sum that includes one is a floor too; either is marked `atLeast`
 * and drawn with a plus, never as an exact figure.
 */
export function navCountersFrom(response: NavCountersResponse): NavCounters {
  const c = response.counters;
  const out: Record<string, NavCounter> = {};
  const put = (
    id: string,
    count: number | null,
    tone: 'warn' | 'danger' | undefined,
    atLeast: boolean,
  ) => {
    if (count === null || count <= 0) return;
    out[id] = {
      count,
      ...(tone === undefined ? {} : { tone }),
      ...(atLeast ? { atLeast: true as const } : {}),
    };
  };
  const one = (id: string, count: number | null, tone?: 'warn' | 'danger') =>
    put(id, count, tone, capped(count));
  one('alerts', c.openConditions, 'warn');
  one('tickets', c.ticketsAwaitingSupport);
  one('panels', c.unhealthyPanels, 'danger');
  one('payments', c.paymentsUnknown, 'warn');
  // Roadmap B6: support handoffs — a person must answer, the AI has stood down.
  one('business-chats', c.businessHandoffs, 'warn');
  if (c.unreconciledServices !== null || c.refundRequestsAwaiting !== null) {
    const unreconciled = c.unreconciledServices ?? 0;
    put(
      'services',
      unreconciled + (c.refundRequestsAwaiting ?? 0),
      unreconciled > 0 ? 'danger' : undefined,
      // A sum with a floor in it is a floor.
      capped(c.unreconciledServices) || capped(c.refundRequestsAwaiting),
    );
  }
  return out;
}

/** A server counter at its cap: "this many or more". */
function capped(count: number | null): boolean {
  return count !== null && count >= COUNTER_CAP;
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
