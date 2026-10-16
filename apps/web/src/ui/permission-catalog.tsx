import type { ReactNode } from 'react';

/**
 * The permission catalogue (W1.7) — the roles page, the role create/edit drawer and the
 * effective-permission preview draw permissions through this one component.
 *
 * One collapsible card per domain in a 2–3 column grid, with a count and «N بحرانی»; rows show
 * a view/change icon and the «بحرانی» badge, critical permissions first. Search, «فقط
 * بحرانی‌ها», «باز کردن همه / بستن همه»; cards start collapsed when there are more than 24
 * permissions. A «فهرست / جدول مقایسه» toggle draws a matrix (roles as columns) when
 * `matrix` is given.
 *
 * In `edit` mode the rows are checkboxes and each card has «انتخاب همه / هیچ‌کدام». The
 * component decides NOTHING about what may be granted: every toggle goes to the page, which
 * keeps its rules (auto-added requirements, dependent removal, typed confirmation for critical
 * changes, refusal to grant what the actor does not hold).
 *
 * PHASE-0 INTERFACE STUB — agent A implements it.
 */
export interface PermissionMatrixColumn {
  readonly key: string;
  readonly label: string;
  readonly has: (permission: string) => boolean;
}

export interface PermissionCatalogProps {
  /** The permission keys to draw (any subset of the contract's `PERMISSIONS`). */
  keys: readonly string[];
  mode: 'view' | 'edit';
  /** Edit mode: what is checked. */
  selected?: ReadonlySet<string>;
  /** Edit mode: one row toggled; the page applies its rules. */
  onToggle?: (key: string, next: boolean) => void;
  /**
   * Edit mode: «انتخاب همه» (`true`) / «هیچ‌کدام» (`false`) for one card's keys.
   */
  onToggleMany?: (keys: readonly string[], next: boolean) => void;
  /** Edit mode: a row the actor may not change (e.g. a permission they do not hold). */
  isLocked?: (key: string) => boolean;
  /**
   * Extra note under a row (e.g. «لازمهٔ …، خودکار افزوده شد»).
   */
  noteFor?: (key: string) => ReactNode;
  /**
   * When present, the «جدول مقایسه» view is offered.
   */
  matrix?: readonly PermissionMatrixColumn[];
  /** DOM id prefix, so two catalogues on one page do not collide. */
  idPrefix?: string;
}

export function PermissionCatalog({ keys }: PermissionCatalogProps) {
  return (
    <ul className="permission-catalog">
      {keys.map((key) => (
        <li key={key} dir="ltr">
          {key}
        </li>
      ))}
    </ul>
  );
}
