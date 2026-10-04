import { MutationCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from './api/client';

/**
 * The admin's one query client, built here so the web suite can exercise the very
 * configuration `main.tsx` mounts.
 *
 * **Every settled mutation invalidates `['audit-log']`** (Issue 16). The audit log is
 * the one list every write changes: a success appends a SUCCESS row and a refusal a
 * DENIED one, and no page's mutation names it. With the five-second freshness the
 * sidebar prefetch gives it (`nav-prefetch.ts`), an operator who pointed at Audit Log,
 * saved a setting and then opened Audit Log to check it would have been shown the read
 * from before the save. Settled rather than succeeded, because a refused write is
 * audited too. An invalidation refetches only a log that is on screen; otherwise it
 * marks the cached pages stale, so the next visit asks again.
 *
 * `mutations.retry` is set, and that is what makes the idempotency key mean
 * something.
 *
 * The default is 0, so before this a failed write was never retried, and the
 * client's `newIdempotencyKey` docblock — which says a retry carries the key
 * its first attempt used — described protection nothing could reach. Setting
 * it makes the sentence true rather than rewording it, and the key is what
 * makes the retry safe: react-query hands the same `variables` back, so the
 * second attempt is recognised as the same command rather than a second one.
 *
 * One retry, with a short delay, and ONLY for a failure the server did not
 * author. `retry: 1` unconditionally re-sent writes the server had already
 * refused: a denied click produced two `result: 'DENIED'` audit rows, and a
 * version conflict was retried with the same stale expectation, guaranteeing a
 * second failure before the error handler could refresh. A 4xx is an answer.
 */
export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    mutationCache: new MutationCache({
      // See the module docblock: every write may append to the audit log.
      onSettled: () => {
        void client.invalidateQueries({ queryKey: ['audit-log'] });
      },
    }),
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false },
      mutations: {
        retry: (failures, error) =>
          failures < 1 && !(error instanceof ApiError && error.status < 500),
        retryDelay: 500,
      },
    },
  });
  return client;
}
