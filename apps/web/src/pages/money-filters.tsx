import type { ReactNode } from 'react';
import { setQueries, type Route } from '../router';
import { FilterChip, FilterChips } from '../ui/kit';
import type { ListFilter } from '../ui/filter-bar';

/**
 * The money & catalogue lists' filters, as `ListFilterBar` entries (W1.3).
 *
 * Each filter is the page's existing chip group, unchanged: the same URL parameter, the same
 * "all" chip, the same server counts where a page had them, and the same keys reset on every
 * change (the keyset cursor). The bar only decides where the chips are drawn. The active
 * chip reads the chosen option's Persian label; an option the page no longer lists (a stale
 * link) reads its raw value rather than nothing.
 */
export interface ChipOption<T extends string> {
  readonly id: T;
  readonly label: string;
  /** A REAL server total, as `FilterChip` requires; never counted from the rows shown. */
  readonly count?: number;
}

export function queryChipFilter<T extends string>({
  route,
  param,
  label,
  value,
  items,
  allLabel,
  resetKeys = ['cursor'],
  allCount,
  after,
}: {
  route: Route;
  /** The URL query parameter the filter writes. */
  param: string;
  label: string;
  /** The value in force, or `null` for "all". */
  value: T | null;
  items: readonly ChipOption<T>[];
  allLabel: string;
  /** Keys a change clears with it (a cursor minted under the old filter). */
  resetKeys?: readonly string[];
  allCount?: number | undefined;
  /** Drawn under the chips while the panel is open (a page's own hint). */
  after?: ReactNode | undefined;
}): ListFilter {
  const set = (next: T | null) =>
    setQueries(route, [[param, next], ...resetKeys.map((key) => [key, null] as const)]);
  return chipFilter({ key: param, label, value, items, allLabel, onChange: set, allCount, after });
}

/** The same, for a filter whose value is held somewhere other than one URL parameter. */
export function chipFilter<T extends string>({
  key,
  label,
  value,
  items,
  allLabel,
  onChange,
  allCount,
  after,
}: {
  key: string;
  label: string;
  value: T | null;
  items: readonly ChipOption<T>[];
  allLabel: string;
  onChange: (next: T | null) => void;
  allCount?: number | undefined;
  after?: ReactNode | undefined;
}): ListFilter {
  return {
    key,
    label,
    active: value === null ? null : (items.find((one) => one.id === value)?.label ?? value),
    onClear: () => onChange(null),
    control: (
      <>
        <FilterChips label={label}>
          <FilterChip
            pressed={value === null}
            onClick={() => onChange(null)}
            {...(allCount === undefined ? {} : { count: allCount })}
          >
            {allLabel}
          </FilterChip>
          {items.map((one) => (
            <FilterChip
              key={one.id}
              pressed={value === one.id}
              onClick={() => onChange(one.id)}
              {...(one.count === undefined ? {} : { count: one.count })}
            >
              {one.label}
            </FilterChip>
          ))}
        </FilterChips>
        {after}
      </>
    ),
  };
}
