import type { QueryClient } from '@tanstack/react-query';
import type { PermissionKey } from '@nexa/contracts';

/**
 * Asking for a page's first screen while the operator is still pointing at its link
 * (Issue 16, `docs/perf/web-admin-navigation.md`).
 *
 * The benchmark found a cold visit to Customers, Audit Log or Settings costs one round
 * trip and nothing else — no chunk, no waterfall, a fast endpoint — so at 200 ms of
 * latency the page drew 240–250 ms after the click, against 10–30 ms when its data was
 * already cached. Pointing at a link (or focusing it from the keyboard) is announced
 * well before the click, and a request sent then has usually answered by the time it
 * lands.
 *
 * Deliberately narrow, and each limit is a safety rule rather than a tuning choice:
 *
 * - **Only the pages listed in `NAV_PREFETCH`**, each of which reads non-financial
 *   reference data: the customer list (identity and status, no money), the audit log
 *   (append-only history) and the settings registry (versioned: a stale version is a
 *   conflict the server reports, never a silent overwrite). Nothing that shows a
 *   balance, a payment, an order total or a panel's health is prefetched.
 * - **Only with the permission the page's own query is gated on.** A request the
 *   server refuses is not free: each refusal records an `access.permission_denied`
 *   event. The sidebar draws only links the actor may follow, and this checks again
 *   against the page's own gate, which is not always the link's.
 * - **The SAME query the page asks**, built by the page module's own exported builder,
 *   so the key and the function cannot drift apart into a prefetch nobody reads.
 * - **No new identity in the key.** The keys stay tenant-independent; the cache is
 *   emptied at every session change (`app.tsx`, sign-in and sign-out). A prefetch is a
 *   query like any other, so one still in flight at sign-out cannot write the previous
 *   operator's rows back: `removeQueries` takes its entry out of the cache, and the
 *   answer lands on a query object the cache no longer holds. (Sign-out cancels first
 *   as well; the test pins the outcome, which `removeQueries` alone already secures.)
 */

/**
 * How long a page's first screen counts as fresh, for the pages that are prefetched.
 *
 * What makes a prefetch not a DUPLICATE: with React Query's default of zero, the page
 * mounting a moment after its prefetch answered would ask again at once. Five seconds
 * covers the gap between pointing and clicking with room to spare, and is the only
 * staleness it introduces: returning to one of these pages within five seconds of its
 * last read shows that read without asking again. A write made from this tab still
 * refreshes it at once, because invalidation ignores `staleTime`: the customer, tag and
 * settings mutations invalidate their own keys, and the audit log — which EVERY write
 * appends to and no page's mutation names — is invalidated after every settled mutation
 * by the query client itself (`query-client.ts`). A change made elsewhere (the bot,
 * another operator) is seen up to five seconds late on a revisit, as it is on any page
 * until it is next read.
 */
export const NAV_PREFETCH_FRESH_MS = 5_000;

/** What `prefetchQuery` needs, and what the page's `useQuery` is spread from. */
export interface PageQuery<TData = unknown> {
  readonly queryKey: readonly unknown[];
  readonly queryFn: () => Promise<TData>;
  readonly staleTime: number;
}

export interface NavPrefetch {
  /** The permission the page's own query is gated on. */
  readonly permission: PermissionKey;
  /** The queries the page issues on arrival from a bare link (no filter, no cursor). */
  readonly queries: () => readonly PageQuery[];
}

/** Starts the page's first-screen queries, if it has any and the actor may ask them. */
export function prefetchNav(
  client: QueryClient,
  registry: Readonly<Record<string, NavPrefetch>>,
  path: string,
  permissions: readonly PermissionKey[],
): void {
  const entry = Object.prototype.hasOwnProperty.call(registry, path) ? registry[path] : undefined;
  if (entry === undefined || !permissions.includes(entry.permission)) return;
  for (const query of entry.queries()) {
    // `prefetchQuery` does nothing while the entry is fresh and joins a fetch already in
    // flight, so pointing at a link twice is one request. Its promise never rejects; a
    // failure is left in the cache for the page to show and retry as it always has.
    void client.prefetchQuery({
      queryKey: [...query.queryKey],
      queryFn: query.queryFn,
      staleTime: query.staleTime,
    });
  }
}
