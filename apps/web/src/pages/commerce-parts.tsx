import { useState, type ReactNode } from 'react';
import { CursorPager, FilterChip, TwoColumn } from '../ui/kit';
import { setQueries, type Route } from '../router';
import type { SavedViewsRegistration, ViewPreset, ViewState } from '../ui/saved-views';

/**
 * Presentation pieces shared by the commerce list pages (users, services,
 * orders, payments). Nothing here reads data or decides anything: each page
 * keeps its own query, its own URL state and its own validation.
 */

/**
 * One filter axis as a group of chips — the reference's chip row.
 *
 * A list with several axes (a service's state and its delivery state; a
 * payment's state, method and receipt disposition) draws one group per axis
 * inside a single `.filter-row`, separated by `ChipDivider`, so the axes stay
 * distinguishable without a second row each. `label` names the group for
 * assistive technology; every group carries its own «همه».
 *
 * Exactly one chip is pressed, and pressing one is the page's own URL write —
 * the same `onChange` the `Pills` it replaces took.
 */
export function ChipGroup<T extends string>({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: T;
  onChange: (next: T) => void;
  items: readonly { id: T; label: string }[];
}) {
  return (
    <span className="ca-chips" role="group" aria-label={label}>
      {items.map((item) => (
        <FilterChip key={item.id} pressed={item.id === value} onClick={() => onChange(item.id)}>
          {item.label}
        </FilterChip>
      ))}
    </span>
  );
}

/**
 * A list whose filters all live in the URL registers them with the saved-filters menu
 * (W1.4) through this one function: `get` reads the keys from the route, `set` writes every
 * key in ONE navigation (a key the state leaves out is cleared) and drops the keyset cursor
 * the page may hold in the URL, so applying a view is exactly what the page's own controls
 * do. There is no `count`: no list has a server total to give it.
 */
export function urlViewsRegistration(
  route: Route,
  page: string,
  keys: readonly string[],
  presets: readonly ViewPreset[],
): SavedViewsRegistration {
  const empty: ViewState = Object.fromEntries(keys.map((key) => [key, '']));
  return {
    page,
    empty,
    presets,
    get: () => Object.fromEntries(keys.map((key) => [key, route.query.get(key) ?? ''])),
    set: (state) =>
      setQueries(route, [
        ...keys.map((key) => [key, state[key] ?? null] as const),
        ['cursor', null] as const,
      ]),
  };
}

/**
 * «پاک کردن همه» of a `ListFilterBar`: every filter key, the search and the cursor in ONE
 * navigation — never one `setQuery` per key (`router.ts` says why).
 */
export function clearUrlFilters(route: Route, keys: readonly string[]): void {
  setQueries(
    route,
    [...keys, 'cursor'].map((key) => [key, null] as const),
  );
}

/**
 * The bar's «پاک کردن همه», and the `key` to give the page's `ListSearchBox`. Clearing every
 * filter also empties a search still being typed (review of #242, N5): the box is drawn
 * again from the cleared URL, which drops its draft and cancels its pending apply, so no
 * unapplied text is left suggesting a search the list is not under.
 */
export function useListClearAll(
  route: Route,
  keys: readonly string[],
): { readonly searchKey: number; readonly clearAll: () => void } {
  const [searchKey, setSearchKey] = useState(0);
  return {
    searchKey,
    clearAll: () => {
      setSearchKey((current) => current + 1);
      clearUrlFilters(route, keys);
    },
  };
}

/**
 * W4, no layout holes: a long main + side detail page. The two columns share one height —
 * each column's LAST card stretches to it — and what would make the taller column run on
 * alone (`tail`) is drawn as full-width rows underneath. Pure CSS grid; nothing moves in
 * the DOM after render.
 */
export function BalancedColumns({
  main,
  side,
  tail,
}: {
  main: ReactNode;
  side: ReactNode;
  tail?: ReactNode;
}) {
  return (
    <>
      <div className="wb-balance">
        <TwoColumn main={main} side={side} />
      </div>
      {tail !== undefined && <div className="wb-balance-tail stack">{tail}</div>}
    </>
  );
}

/** W1.8: the page size of every list this agent's pages draw. */
export const LIST_PAGE_SIZE = 10;

/**
 * W1.8 for a list the server sends WHOLE (a bounded history, a small catalogue): ten rows at
 * a time with «قبلی / بعدی», paged in memory. Never for a keyset list — those ask the
 * server for ten. The page index is clamped, so a list that shrinks under it stays drawn.
 */
export function useClientPage<T>(
  rows: readonly T[],
  size: number = LIST_PAGE_SIZE,
): { readonly rows: readonly T[]; readonly pager: ReactNode } {
  const [page, setPage] = useState(0);
  const last = Math.max(0, Math.ceil(rows.length / size) - 1);
  const current = Math.min(page, last);
  const shown = rows.slice(current * size, current * size + size);
  const pager =
    rows.length <= size ? null : (
      <CursorPager
        shown={shown.length}
        hasPrevious={current > 0}
        hasNext={current < last}
        onPrevious={() => setPage(current - 1)}
        onNext={() => setPage(current + 1)}
        previousLabel="web.report_page_previous"
        nextLabel="web.report_page_next"
      />
    );
  return { rows: shown, pager };
}
