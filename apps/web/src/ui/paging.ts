import { hashKey, type QueryKey, type UseQueryOptions } from '@tanstack/react-query';

/**
 * A server-paged list keeps the page it is showing on screen while the page «قبلی / بعدی»
 * asked for is read (B3). Without it the list empties for the length of a request and the
 * view jumps: the rows go, the pager rises into their place, and the operator's pointer is
 * no longer on the button they pressed.
 *
 * Only a turn of the SAME list keeps its rows. `cursorAt` names the positions of the cursor
 * in the query key (negative counts from the end; default: the last element); everything
 * else in the key is the list — its filters, its search, its tab. A new filter is a
 * different question, and the old filter's rows drawn under it would read as its answer, so
 * it starts from nothing (a skeleton) exactly as before.
 *
 *   useQuery(keepPageWhileTurning({ queryKey: ['orders', search, cursor ?? null], queryFn }))
 *
 * The rows kept are marked `isPlaceholderData` by TanStack Query until the new page lands.
 */
export function keepPageWhileTurning<
  TQueryFnData,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
  cursorAt: readonly number[] = [-1],
): UseQueryOptions<TQueryFnData, TError, TData, TQueryKey> {
  const list = listOf(options.queryKey, cursorAt);
  return {
    ...options,
    placeholderData: (previous, previousQuery) =>
      previousQuery !== undefined && listOf(previousQuery.queryKey, cursorAt) === list
        ? withoutNextCursor(previous)
        : undefined,
  };
}

/**
 * The kept page offers no «بعدی» of its own while the next page is read: its `nextCursor` is
 * the cursor of the page being read, and a second press would push it onto the trail twice —
 * after which «قبلی» would seem to do nothing. «قبلی» stays as it was.
 */
function withoutNextCursor<T>(previous: T | undefined): T | undefined {
  if (typeof previous !== 'object' || previous === null || !('nextCursor' in previous))
    return previous;
  return { ...previous, nextCursor: null };
}

/** The query key without its cursor: what identifies the list, not the page. */
export function listOf(queryKey: QueryKey, cursorAt: readonly number[]): string {
  const drop = new Set(cursorAt.map((at) => (at < 0 ? queryKey.length + at : at)));
  return hashKey(queryKey.filter((_, index) => !drop.has(index)));
}
