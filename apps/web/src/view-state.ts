import { finalAnswer } from './polling';

/** The five states any query-driven view can be in. */
export type ViewState = 'ready' | 'loading' | 'empty' | 'error' | 'denied';

/**
 * Everything a view needs from a query, and the reason it is ONE object.
 *
 * `state`, `stale` and `onRetry` were three props, all derived from the same
 * query and all passed by hand at eighteen call sites. Six of them were missed
 * for a whole round; `stale={false}` at every site passed the scan written to
 * prevent that; and nothing could have caught a site wired to a DIFFERENT
 * query than its `state`. Three derivations of one value cannot be kept in
 * agreement by care. Passing the value instead makes the disagreement
 * unrepresentable.
 */
export interface QueryView {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly data: unknown;
  readonly error: unknown;
  readonly refetch: () => unknown;
}

/**
 * The four view states, read off a react-query result.
 *
 * `isError` alone is NOT the error state. TanStack Query sets `status: 'error'`
 * on a failed BACKGROUND refetch while `data` is still present, so mapping it
 * straight through replaced a working page with an error card on one transient
 * 5xx from a poll — and, because the card renders INSTEAD of the children,
 * unmounted the whole subtree and discarded whatever local state it held. On
 * the panel detail that is the operator's unsaved draft.
 *
 * Data wins over a RETRYABLE error, and only over a retryable one. `sessionView`
 * in `app.tsx` reached this rule first and says why in full: "the two rules have
 * to agree about which failures are worth waiting through." `pollUnlessFinal`
 * STOPS the timer on a final answer — a 403 when a permission is revoked, a
 * `ZodError` from a tab holding a previous release across a deploy — so letting
 * data win there leaves a fully drawn, editable screen asserting capabilities
 * the server has just refused, for ever, with no poll coming.
 *
 * A query that has never delivered anything still has nothing to show.
 */
export function queryState(query: QueryView, isEmpty = false): ViewState {
  if (query.isPending) return 'loading';
  if (query.isError && (query.data === undefined || finalAnswer(query.error))) return 'error';
  return isEmpty ? 'empty' : 'ready';
}

/**
 * Showing data whose refresh failed, and therefore owing the reader a warning.
 *
 * Keeping the page is only half the fix: what is on screen is now older than
 * the server and nothing about it looks any different. A screen that has
 * stopped updating without saying so is the defect this admin exists to
 * remove, so the failure is stated beside the data rather than drawn over it.
 */
export function staleAfterError(query: QueryView): boolean {
  return query.isError && query.data !== undefined && !finalAnswer(query.error);
}

/**
 * A retry worth offering.
 *
 * After a FINAL answer there is nothing to retry: the request will be refused
 * again, and on `access.permission_denied` each press writes another
 * operational event and another DENIED audit row — manufacturing exactly the
 * noise the alerts page exists to keep clear. `main.tsx` retries once, so every
 * click is two refusals.
 */
export function retryOf(query: QueryView): (() => void) | undefined {
  if (query.isError && finalAnswer(query.error)) return undefined;
  return () => void query.refetch();
}

/**
 * The data a view may actually show.
 *
 * A page that reads `query.data` directly is not covered by the state above it.
 * `PanelDetailPage` did exactly that for its heading, so on a final refusal the
 * tab strip and the form were torn down while the panel's name, its provider
 * and its **Test-connection button** — a write the server had just refused —
 * stayed on screen above the error card.
 */
export function shownData<T>(
  query: QueryView,
  state: ViewState,
  data: T | undefined,
): T | undefined {
  return state === 'ready' || state === 'empty' ? data : undefined;
}
