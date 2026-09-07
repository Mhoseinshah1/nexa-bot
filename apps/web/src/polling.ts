/**
 * The shape both helpers read out of a query.
 *
 * Deliberately structural rather than React Query's own `Query`, which is
 * generic in four parameters. A callback annotated with the concrete `Query`
 * is not assignable to `refetchInterval` on a typed `useQuery`, and writing
 * `Query<unknown, ...>` there silently collapses the call's own inference —
 * that is how the first version of this file turned `readiness.data` into
 * `{}`. A supertype of every `Query` accepts them all and infers nothing.
 */
type PollingQuery = { readonly state: { readonly error: unknown; readonly data: unknown } };

/**
 * A refetch interval that stops once the query has failed.
 *
 * Background polling was added so a page left open stops being a photograph.
 * The hazard it introduced is the other side of that: `enabled:` is computed
 * from the session's permission list, which is fetched ONCE per tab and never
 * refetched, so a tab whose permissions were revoked after it loaded goes on
 * believing it holds them and goes on asking.
 *
 * Every one of those requests is refused by the server, and a refusal is not
 * free: `PermissionGuard.check` records an `access.permission_denied`
 * operational event, `denialEvent` carries no `dedupeKey`, and
 * `operational_events` has no retention. One wall display left on a revoked
 * session would write thousands of rows a day into the feed the alerts page
 * exists to keep clear — and before polling, each of these queries ran once per
 * page load, so the growth was bounded by navigation and is now bounded by
 * nothing.
 *
 * Stopping on ANY error rather than only on a 403 is deliberate. A page that
 * cannot reach its endpoint has nothing to gain from asking again on a timer;
 * the user has a Retry control and a reload, both of which reset the query and
 * start the interval again. Erring towards silence is also the safer failure:
 * the alternative hammers a server that is already answering badly.
 */
export function pollUnlessFailing(ms: number) {
  return (query: PollingQuery): number | false => (query.state.error === null ? ms : false);
}

/**
 * The same rule, for an interval that also has a condition of its own.
 *
 * The alerts page polls only while something is PENDING, which reads as if it
 * were already bounded — but React Query RETAINS the last successful `data`
 * across a failed refetch, so a list that held a pending row when a session was
 * revoked goes on satisfying its own condition and goes on asking, for ever.
 * The error check has to come first for the condition to mean anything.
 */
export function pollUnlessFailingWhile<TData>(ms: number, unsettled: (data: TData) => boolean) {
  return (query: PollingQuery): number | false => {
    if (query.state.error !== null) return false;
    const data = query.state.data as TData | undefined;
    return data !== undefined && unsettled(data) ? ms : false;
  };
}
