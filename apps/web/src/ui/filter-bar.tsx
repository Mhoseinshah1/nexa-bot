import { useState, type ReactNode } from 'react';
import { t } from '../i18n/web.fa';

/**
 * One compact filter line per list (W1.3).
 *
 * The line: the slim search, a «فیلترها» button with a count badge, the active filters as
 * removable chips («وضعیت: فعال ×»), «پاک کردن همه» when two or more are active, «بدون فیلتر —
 * همه نمایش داده می‌شوند» when none are, and the saved-filters slot at the end.
 *
 * «فیلترها» opens a panel with one row per filter (label on the side, the page's existing chip
 * group or select inside). Every change applies immediately — the page's own controls still
 * write the URL exactly as before — and the panel stays open across re-renders. It closes with
 * «نمایش نتیجه», ×, Esc or an outside click; on a phone it is a bottom sheet with a backdrop.
 *
 * CONTRACT FOR PAGES AND TESTS: a filter's `control` is mounted ONLY while the panel is open.
 * A test opens it with `openFilterPanel()` from `tests/web/ui-helpers.ts`.
 *
 * PHASE-0 INTERFACE STUB — agent A implements the look, chips, Esc/outside click and sheet.
 */
export interface ListFilter {
  /** Stable id, unique on the page. */
  key: string;
  /** The filter's Persian name (from the catalogue). */
  label: string;
  /** The page's existing control for this filter: a chip group, a select, a date range. */
  control: ReactNode;
  /**
   * The active value in Persian (the chip reads «label: active»), or `null` while the filter
   * is at its default — a filter at its default is not active and draws no chip.
   */
  active: string | null;
  /** Puts this filter back to its default (the chip's ×). */
  onClear: () => void;
}

export interface ListFilterBarProps {
  /** The page's `ListSearchBox` (drawn `slim`), or nothing for a list without free text. */
  search?: ReactNode;
  filters: readonly ListFilter[];
  /**
   * «پاک کردن همه». Absent → each active filter's `onClear` in turn.
   */
  onClearAll?: () => void;
  /** The saved-filters menu (`SavedViewsMenu`), drawn at the end of the line. */
  savedViews?: ReactNode;
  /** Accessible name of the filter region. */
  label?: string;
}

export function ListFilterBar({
  search,
  filters,
  onClearAll,
  savedViews,
  label,
}: ListFilterBarProps) {
  const [open, setOpen] = useState(false);
  const active = filters.filter((one) => one.active !== null);
  const clearAll = onClearAll ?? (() => active.forEach((one) => one.onClear()));
  return (
    <div
      className="list-filter-bar"
      role="search"
      {...(label === undefined ? {} : { 'aria-label': label })}
    >
      {search}
      <button type="button" className="btn sm" aria-expanded={open} onClick={() => setOpen(!open)}>
        {t('web.filters')}
        {active.length > 0 && <span className="cnt num">{active.length}</span>}
      </button>
      {active.map((one) => (
        <button
          key={one.key}
          type="button"
          className="chip on"
          onClick={one.onClear}
          aria-label={`${t('web.filters_remove')} ${one.label}`}
        >
          {one.label}: {one.active} ×
        </button>
      ))}
      {active.length >= 2 && (
        <button type="button" className="btn sm ghost" onClick={clearAll}>
          {t('web.filters_clear_all')}
        </button>
      )}
      {active.length === 0 && <span className="muted small">{t('web.filters_none')}</span>}
      {savedViews}
      {open && (
        <div className="list-filter-panel" role="dialog" aria-label={t('web.filters')}>
          {filters.map((one) => (
            <div key={one.key} className="list-filter-row">
              <span className="muted small">{one.label}</span>
              {one.control}
            </div>
          ))}
          <button type="button" className="btn sm primary" onClick={() => setOpen(false)}>
            {t('web.filters_show_result')}
          </button>
        </div>
      )}
    </div>
  );
}
