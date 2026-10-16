import { FilterChip } from '../ui/kit';
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
