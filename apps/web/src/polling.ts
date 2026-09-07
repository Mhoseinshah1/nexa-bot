import { ApiError } from './api/client';

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
 * An authorization refusal: the only failure a timer cannot outlast.
 *
 * A 403 is the hazard these helpers exist for. `enabled:` is computed from the
 * session's permission list, which is fetched ONCE per tab and never refetched,
 * so a tab whose permissions were revoked after it loaded goes on believing it
 * holds them and goes on asking. Every one of those requests is refused, and a
 * refusal is not free: `PermissionGuard.check` records an
 * `access.permission_denied` operational event, `denialEvent` carries no
 * `dedupeKey`, and `operational_events` has no retention sweeper. One wall
 * display left on a revoked session would write thousands of rows a day into
 * the feed the alerts page exists to keep clear.
 *
 * A 401 joins it because the shell does not re-resolve the session for a page
 * already mounted, so a poll against an expired cookie repeats forever without
 * anything on screen offering the sign-in that would end it.
 *
 * Nothing else. That distinction is the whole rule, and getting it wrong is
 * worse than the defect it was written for — see below.
 */
function refused(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

/**
 * A refetch interval that stops once the server has REFUSED the query.
 *
 * The first version of this file stopped on any error at all, and rationalised
 * it: "the user has a Retry control and a reload". That sentence is true only
 * where a user is present, and the scenario these intervals were added for is
 * the one where nobody is — a dashboard left open on a wall.
 *
 * What it actually did to that dashboard: one 502 from the edge during a
 * rolling restart exhausts `retry: 1` and sets `state.error`. The interval then
 * returns `false` and the timer is cleared. `refetchOnWindowFocus` is off
 * globally, so looking at the tab does not restart it; there was no
 * offline/online transition, so `refetchOnReconnect` never fires; and React
 * Query clears `error` only on a SUCCESSFUL fetch (`fetchState` clears it while
 * starting one only when `data === undefined`, which is never true of a screen
 * that has been serving figures). The one thing that would clear the error is
 * the fetch the stopped timer no longer makes. So the screen froze into an
 * error box until somebody walked up to it — where before the fix it had healed
 * itself on the next tick.
 *
 * Hence: stop on a refusal, which no amount of waiting resolves, and keep
 * polling through everything else, which waiting is exactly the cure for.
 */
export function pollUnlessRefused(ms: number) {
  return (query: PollingQuery): number | false => (refused(query.state.error) ? false : ms);
}

/**
 * The same rule, for an interval that also has a condition of its own.
 *
 * The alerts page polls only while something is PENDING, which reads as if it
 * were already bounded — but React Query RETAINS the last successful `data`
 * across a failed refetch, so a list that held a pending row when a session was
 * revoked goes on satisfying its own condition and goes on asking, for ever.
 * The refusal check has to come first for the condition to mean anything.
 */
export function pollUnlessRefusedWhile<TData>(ms: number, unsettled: (data: TData) => boolean) {
  return (query: PollingQuery): number | false => {
    if (refused(query.state.error)) return false;
    const data = query.state.data as TData | undefined;
    return data !== undefined && unsettled(data) ? ms : false;
  };
}
