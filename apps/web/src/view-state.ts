import { ApiError } from './api/client';
import type { WebKey } from './i18n/web.fa';
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
 * Whether the error state is a REFUSAL rather than a connection failure.
 *
 * The card said "خطا در ارتباط با سرور — ارتباط با سرور برقرار نشد. دوباره
 * تلاش کنید" for a 403 the server answered correctly in microseconds: a false
 * statement about what happened, and — since `retryOf` withholds the button —
 * an instruction to do something the screen has deliberately removed the means
 * to do.
 *
 * `StateSwitch`'s `denied` prop comes from the permission list, which the shell
 * re-reads on a 60-second cadence, so a revocation IS eventually believed
 * there. An earlier version of this comment said it never was; that had been
 * true two rounds before the comment was written and was already fixed. What
 * remains true is the window — up to one cadence, plus any 403 that is not
 * permission-list drift at all — and inside it the 403 in hand is the better
 * evidence.
 */
export function refused(query: QueryView): boolean {
  return query.isError && query.error instanceof ApiError && query.error.status === 403;
}

/**
 * The three things an error card says, decided in ONE place.
 *
 * Both sites that draw an error card had the identical triple of ternaries on
 * `refused(query)` — `StateSwitch` and the alerts detail — and the round that
 * introduced them fixed the 403 arm at both while leaving the other arm wrong
 * at both. `finalAnswer` is broader than a 403: a `ZodError` from a tab
 * holding a previous release, a 404, a 400. In every one of those the card
 * said "ارتباط با سرور برقرار نشد. دوباره تلاش کنید." — the connection did not
 * fail, the server answered it correctly, and `retryOf` has withheld the very
 * button the sentence instructs the reader to press. Two false statements and
 * an unactionable instruction, in the admin whose thesis is that no screen
 * asserts what the server did not do.
 *
 * Returning the keys rather than the strings keeps this module free of copy,
 * and returning all three together is what stops the next round fixing one arm
 * at one site.
 */
export function errorCopy(query: QueryView): {
  readonly title: WebKey;
  readonly hint: WebKey;
  readonly icon: 'lock' | 'alert';
} {
  if (refused(query)) {
    return { title: 'web.no_permission', hint: 'web.no_permission_hint', icon: 'lock' };
  }
  if (query.isError && finalAnswer(query.error)) {
    return { title: 'web.rejected', hint: 'web.rejected_hint', icon: 'alert' };
  }
  return { title: 'web.error', hint: 'web.error_hint', icon: 'alert' };
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
 * Whether a control that ISSUES A REQUEST may be drawn.
 *
 * `retryOf` alone is not this test, and gating controls on it was wrong in the
 * same way twice. A DENIED query is `enabled: false`, so it stays `isPending`
 * for ever and is never `isError` — `retryOf` hands back a callback and the
 * control is drawn above the "you do not have access" card. Pressing it calls
 * `refetch()`, which DOES fetch a disabled query in react-query 5, so each
 * press is two refused requests and two `access.permission_denied` events.
 *
 * This covers every control beside a `StateSwitch` that mints a request — a
 * refresh button, a filter select, a scope pill, a pager. Each of them changes
 * or repeats the query the card below has just said cannot be answered.
 *
 * PRECONDITION, because the argument is doing more work than its name says.
 * `denied` is not only "the actor lacks the permission": it is "this query is
 * not allowed to run", and every caller that disables a query for ANY reason
 * owes it a `true`. A query that is `enabled: false` is `isPending` for ever
 * and never `isError`, so without it this function returns `true` and the
 * control is drawn beside a card that is still showing a skeleton. Both call
 * sites today pass `enabled: !denied`, so the two coincide and the gap is
 * latent — but `content.tsx`'s `enabled: showHistory` and `alerts.tsx`'s
 * `enabled: selected !== null` are exactly the shape that would reopen it, and
 * the first control placed beside either would.
 */
export function mayRequest(query: QueryView, denied = false): boolean {
  return !denied && retryOf(query) !== undefined;
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
