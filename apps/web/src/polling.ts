import { ApiError } from './api/client';

/**
 * The shape both helpers read out of a query.
 *
 * Deliberately structural rather than React Query's own `Query`, which is
 * generic in four parameters. A callback annotated with the concrete `Query`
 * is not assignable to `refetchInterval` on a typed `useQuery`, and writing
 * `Query<unknown, ...>` there silently collapses the call's own inference —
 * that is how an early version of this file turned `readiness.data` into `{}`.
 * A supertype of every `Query` accepts them all and infers nothing.
 */
type PollingQuery = { readonly state: { readonly error: unknown; readonly data: unknown } };

/**
 * The slowest lane, used while a query is failing.
 *
 * Not a growing backoff. The obvious spelling of one — scaling by
 * `fetchFailureCount` — does not work: React Query zeroes that field when a
 * fetch STARTS, so it counts the retries inside one attempt and never the
 * consecutive failures across polls. A rule built on it would have been a flat
 * multiplier wearing a backoff's docblock, and the test written for it would
 * have passed.
 *
 * A single slow lane is what this actually needs to bound. The alerts list
 * polls every three seconds while a delivery is pending, and React Query
 * retains the last successful data across a failed refetch — so its own "only
 * while pending" condition stays satisfied throughout an outage. Twenty minutes
 * of one cost about four hundred requests per open tab at three seconds, and
 * forty at thirty. Near enough that a screen still recovers on its own within
 * half a minute of the server doing so, which is the point of the interval.
 */
const FAILING_INTERVAL_MS = 30_000;

/**
 * Will asking again, unchanged, ever produce a different answer?
 *
 * This is the partition the whole file turns on, and it has been wrong twice.
 *
 * The first version stopped on ANY error and rationalised it — "the user has a
 * Retry control and a reload". True only where a user is present, and the
 * scenario these intervals exist for is the wall display where nobody is. One
 * 502 during a rolling restart froze such a screen for good: the timer is
 * cleared, `refetchOnWindowFocus` is off, and React Query clears `error` only
 * on a SUCCESSFUL fetch — the fetch the stopped timer no longer makes.
 *
 * The second version corrected to "stop on 401 or 403, poll through everything
 * else", and claimed that everything else is cured by waiting. It is not.
 * `authedGet` has exactly three failure classes, so they are enumerated here
 * rather than partitioned by a rule of thumb:
 *
 * - `ApiError`, thrown by `toApiError` for every `!response.ok` and therefore
 *   always carrying a status. A 4xx is an ANSWER: 401 and 403 need a human,
 *   404 and 400 need a different request. Repeating it changes nothing. The
 *   two exceptions are 408 and 429, which are the server asking to be asked
 *   again. A 5xx is transient.
 * - `ZodError`, thrown by `schema.parse` on the SUCCESS path. The server
 *   answered and this bundle cannot read the answer — contract skew, which a
 *   tab holding a previous release across a deploy hits on every tick. Nothing
 *   but a reload resolves it, so polling it is pure noise. This is the class
 *   the second version polled forever.
 * - anything else — a `TypeError` from a dropped connection, an abort. The
 *   network, which is exactly what waiting cures.
 *
 * Unrecognised failures fall to the last case and keep polling, because the
 * cost of being wrong there is a request the server shrugs off, while the cost
 * of being wrong the other way is a frozen screen nobody is watching.
 */
function finalAnswer(error: unknown): boolean {
  if (error instanceof ApiError) {
    return (
      error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429
    );
  }
  // A parse failure. Named structurally rather than by importing zod into the
  // bundle: `schema.parse` is the only other thing that throws in `authedGet`.
  return error instanceof Error && error.name === 'ZodError';
}

/** The declared cadence while healthy; the slow lane while failing. */
function paced(ms: number, error: unknown): number {
  return error === null ? ms : Math.max(ms, FAILING_INTERVAL_MS);
}

/**
 * A refetch interval that gives up only on an answer that will not change, and
 * drops into the slow lane for one that might.
 *
 * The hazard it exists for is a 403. `enabled:` is computed from the session's
 * permission list, which is fetched ONCE per tab and never refetched, so a tab
 * whose permissions were revoked after it loaded goes on believing it holds
 * them and goes on asking. Every refusal records an `access.permission_denied`
 * operational event, `denialEvent` carries no `dedupeKey`, and
 * `operational_events` has no retention sweeper — so one wall display left on a
 * revoked session would write thousands of rows a day into the feed the alerts
 * page exists to keep clear.
 */
export function pollUnlessFinal(ms: number) {
  return (query: PollingQuery): number | false =>
    finalAnswer(query.state.error) ? false : paced(ms, query.state.error);
}

/**
 * The same rule, for an interval that also has a condition of its own.
 *
 * The alerts page polls only while something is PENDING, which reads as if it
 * were already bounded — but React Query retains the last successful `data`
 * across a failed refetch, so a list that held a pending row when a session was
 * revoked goes on satisfying its own condition and goes on asking. The failure
 * check has to come first for the condition to mean anything.
 */
export function pollUnlessFinalWhile<TData>(ms: number, unsettled: (data: TData) => boolean) {
  return (query: PollingQuery): number | false => {
    if (finalAnswer(query.state.error)) return false;
    const data = query.state.data as TData | undefined;
    if (data === undefined || !unsettled(data)) return false;
    return paced(ms, query.state.error);
  };
}
