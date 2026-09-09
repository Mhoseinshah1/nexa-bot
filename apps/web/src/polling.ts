import { IDENTITY_ERROR_CODES } from '@nexa/contracts';
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
 * of one cost about four hundred POLLS per open tab at three seconds and forty at
 * thirty — some eight hundred requests and eighty, since `retry: 1` doubles
 * each. Near enough that a screen still recovers on its own within
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
 *   always carrying a status and a CODE. A 4xx is usually an ANSWER: 403 needs
 *   a human, 404 and 400 need a different request. Repeating it changes
 *   nothing. Three exceptions, and the third is the one that made the status
 *   alone insufficient:
 *     - 408 and 429 are the server asking to be asked again.
 *     - `auth.tenant_suspended` is a 401 the server issues while an
 *       installation is PAUSED, and it deliberately does not revoke the
 *       session, because "a tenant can be started again, and the sessions its
 *       operators held are not the thing that was suspended". Its message is
 *       "Try again once it has been started" — the service's own comment calls
 *       the distinction "sign in again versus wait". Classing it final froze a
 *       wall display for the whole of a maintenance window and left it frozen
 *       after the installation came back, which is the round-8 defect a third
 *       time. `client.ts` already special-cases this code for the same reason.
 *   A 5xx is transient.
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
export function finalAnswer(error: unknown): boolean {
  if (error instanceof ApiError) {
    if (error.code === IDENTITY_ERROR_CODES.AUTH_TENANT_SUSPENDED) return false;
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
/**
 * `settledMs`, when given, is the DISCOVERY lane: the cadence a settled answer
 * is re-read at anyway. The notifications list polled only while something
 * was pending, which was right about cost and wrong about discovery — an
 * operational event queues a new intent on its own, and a first page that
 * was settled when the tab opened never learned of it until navigation.
 * Callers pass it for the page on which new rows APPEAR and leave it off for
 * the cursor pages behind it, whose history does not change.
 */
export function pollUnlessFinalWhile<TData>(
  ms: number,
  unsettled: (data: TData) => boolean,
  settledMs?: number,
) {
  return (query: PollingQuery): number | false => {
    if (finalAnswer(query.state.error)) return false;
    // Nothing has loaded yet. A transient failure on the FIRST load still has
    // to be retried — otherwise a tab opened during a rolling restart never
    // polls again, which is the frozen screen in its coldest form — but a query
    // that is merely still loading needs no interval, because a fetch is
    // already in flight.
    const data = query.state.data as TData | undefined;
    if (data === undefined)
      return query.state.error === null ? false : paced(ms, query.state.error);
    if (!unsettled(data))
      return settledMs === undefined ? false : paced(settledMs, query.state.error);
    return paced(ms, query.state.error);
  };
}

/**
 * The session query's interval.
 *
 * The shell, not a page, and it needs all three behaviours at once.
 *
 * **While signed in it re-asks.** An earlier version polled only on failure and
 * justified it: "a resolved session does not go stale on a timer". The
 * contracts say otherwise — `sessionResponseSchema` carries `expiresAt`, and
 * `auth.session_invalid` exists because sessions are revoked — and the premise
 * being false left the worst screen on this branch: a tab whose session expired
 * kept rendering a complete, fully-drawn admin console that could do nothing.
 * Every page had correctly stopped polling on its 401; the shell alone never
 * asked, so nothing on screen ever said to sign in again.
 *
 * Re-asking also bounds the hazard the rest of this file mitigates rather than
 * fixes: `enabled:` is computed from a permission list that used to be fetched
 * once per tab, so a revoked permission was believed until a reload. It is now
 * believed for at most one cadence.
 *
 * **While failing it drops into the slow lane**, so a paused installation or a
 * rolling restart recovers without anybody present.
 *
 * **Signed OUT it asks nothing.** `fetchSession` returns `null` for an ordinary
 * 401, which is a resolved answer rather than a failure: nobody is signed in,
 * and nothing this tab does will change that. Polling a login screen is the
 * noise this rule exists to avoid.
 */
export function pollSession(ms: number) {
  return (query: PollingQuery): number | false => {
    if (finalAnswer(query.state.error)) return false;
    // The shared slow lane DIRECTLY, not `paced(ms, …)`. `paced` returns
    // `max(ms, lane)`, which is a floor for a page polling faster than the lane
    // — and the session's healthy cadence is SLOWER than it, so the max would
    // have made a failing shell recover at sixty seconds instead of thirty,
    // doubling how long a paused installation stays frozen. Recovery is the
    // whole point of the failing branch; it should not be throttled by how
    // rarely a healthy session needs re-asking.
    if (query.state.error !== null) return FAILING_INTERVAL_MS;
    // `== null` covers both: `null` is signed out, `undefined` is a first load
    // still in flight, and neither wants a timer.
    return query.state.data == null ? false : ms;
  };
}
