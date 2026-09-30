/**
 * Optional numeric badges beside navigation entries.
 *
 * A counter is keyed by the NAV entry's `id` and must come from an
 * intentional, lightweight summary endpoint — never from fetching a page's
 * own data to count its rows (brief §12), and never from a page of results
 * (lead decision D2: a count is a real server total or it is not shown).
 *
 * Nothing supplies counters yet, so this returns none and the sidebar draws
 * none. The dashboard work wires it to its summary endpoint; the sidebar
 * already renders whatever it returns.
 */
export interface NavCounter {
  readonly count: number;
  /** `warn` or `danger` when the number is something to act on. */
  readonly tone?: 'warn' | 'danger';
}

export type NavCounters = Readonly<Partial<Record<string, NavCounter>>>;

const NONE: NavCounters = {};

export function useNavCounters(): NavCounters {
  return NONE;
}
