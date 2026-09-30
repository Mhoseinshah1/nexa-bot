import { FilterChip } from '../ui/kit';

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
