import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n/web.fa';
import { formatNumber } from '../format';
import { Icon } from './icons';
import { LayerContext, useLayer } from './layer';
import { useFocusTrap } from './overlays';
import { tabbable } from './focusable';
import { batchQueryChanges } from '../router';

/**
 * One compact filter line per list (W1.3).
 *
 * The first row: a «فیلترها» button with a count badge, the active filters as removable chips
 * («وضعیت: فعال ×»), «پاک کردن همه» when two or more are active, «بدون فیلتر — همه نمایش داده
 * می‌شوند» when none are, and the saved-filters slot at the end. The slim search is the row
 * under it, or above it with `first="search"` (owner decision 2026-10-19: per page, as the demo).
 *
 * «فیلترها» opens a panel with one row per filter (label on the side, the page's existing chip
 * group or select inside). Every change applies immediately — the page's own controls still
 * write the URL exactly as before — and the panel stays open across re-renders (its state is
 * this component's, so a page must keep the bar mounted while its list reloads). It closes
 * with «نمایش نتیجه», ×, Esc or an outside click; on a phone it is a bottom sheet with a
 * backdrop. The panel renders in a portal (no card or drawer clips it), placed under the
 * bar by CSS anchor positioning and centred where a browser has none. While open it holds the keyboard (`useFocusTrap`): focus starts on the first
 * filter and returns to «فیلترها» when it closes.
 *
 * Layout: the search's own buttons («جست‌وجو» … «پاک کردن») and the saved-filters menu share
 * one grid column, so the menu is exactly as wide as those buttons (at least 170px) without
 * any measuring script — see `ui.css`.
 *
 * CONTRACT FOR PAGES AND TESTS: a filter's `control` is mounted ONLY while the panel is open.
 * A test opens it with `openFilterPanel()` from `tests/web/ui-helpers.ts`.
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
  /** A wide control (a date range, a small form) takes the whole row under its label. */
  wide?: boolean;
}

export interface ListFilterBarProps {
  /** The page's `ListSearchBox` (drawn `slim`), or nothing for a list without free text. */
  search?: ReactNode;
  filters: readonly ListFilter[];
  /**
   * «پاک کردن همه». Absent → each active filter's `onClear` in turn, inside ONE
   * `batchQueryChanges`: filters that write the URL each build on the previous removal and
   * the bar navigates once, so every removal survives (PR #285 review, A1). A page whose
   * search box or cursor must go too still passes its own (`useListClearAll`).
   */
  onClearAll?: () => void;
  /** The saved-filters menu (`SavedViewsMenu`), drawn at the end of the line. */
  savedViews?: ReactNode;
  /** Accessible name of the filter region. */
  label?: string;
  /**
   * Which row comes first. The owner decision of 2026-10-19 is «follow the approved demo, page
   * by page»: «filters» (default) draws the filter line and saved filters, then the search;
   * «search» draws the search, then the filter line. The DOM follows the screen either way.
   */
  first?: 'filters' | 'search';
}

export function ListFilterBar({
  search,
  filters,
  onClearAll,
  savedViews,
  label,
  first = 'filters',
}: ListFilterBarProps) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const active = filters.filter((one) => one.active !== null);
  const clearAll =
    onClearAll ?? (() => batchQueryChanges(() => active.forEach((one) => one.onClear())));
  const hasSaved = savedViews !== undefined && savedViews !== null && savedViews !== false;
  const hasSearch = search !== undefined && search !== null && search !== false;

  const layer = useLayer(open, () => setOpen(false));

  return (
    <div
      ref={layer.inside}
      className={`list-filter-bar${open ? ' open' : ''}${hasSaved ? ' with-saved' : ''}`}
      role="search"
      {...(label === undefined ? {} : { 'aria-label': label })}
    >
      {/* Owner decision 2026-10-19: the row order follows the demo page by page (`first`); the
          DOM is in the order on screen, so the keyboard meets the rows as the eye does. */}
      {first === 'search' && hasSearch && <div className="lfb-search">{search}</div>}
      <div className="lfb-line">
        <button
          ref={toggle}
          type="button"
          className={`btn sm lfb-open${active.length > 0 ? ' on' : ''}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          {...(open ? { 'aria-controls': panelId } : {})}
          onClick={() => {
            if (!open) toggle.current?.focus();
            setOpen(!open);
          }}
        >
          <Icon name="sliders" size={14} />
          {t('web.filters')}
          {active.length > 0 && <span className="lfb-n num">{formatNumber(active.length)}</span>}
        </button>
        <div className="lfb-active">
          {active.map((one) => (
            <span key={one.key} className="lfb-chip">
              <span className="muted">{one.label}:</span> {one.active}
              <button
                type="button"
                className="lfb-x"
                aria-label={`${t('web.filters_remove')} ${one.label}`}
                title={`${t('web.filters_remove')} ${one.label}`}
                onClick={one.onClear}
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
          {active.length >= 2 && (
            <button type="button" className="lfb-clear" onClick={clearAll}>
              {t('web.filters_clear_all')}
            </button>
          )}
          {active.length === 0 && <span className="lfb-none">{t('web.filters_none')}</span>}
        </div>
      </div>
      {hasSaved && <div className="lfb-saved">{savedViews}</div>}
      {first === 'filters' && hasSearch && <div className="lfb-search">{search}</div>}
      {open &&
        createPortal(
          <LayerContext.Provider value={layer.registry}>
            <div ref={layer.inside} className="lfb-layer">
              <div className="lfb-backdrop" aria-hidden="true" onMouseDown={() => setOpen(false)} />
              <FilterPanel
                id={panelId}
                filters={filters}
                anyActive={active.length > 0}
                onClearAll={clearAll}
                onClose={() => setOpen(false)}
              />
            </div>
          </LayerContext.Provider>,
          document.body,
        )}
    </div>
  );
}

function FilterPanel({
  id,
  filters,
  anyActive,
  onClearAll,
  onClose,
}: {
  id: string;
  filters: readonly ListFilter[];
  anyActive: boolean;
  onClearAll: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const initial = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    initial.current = rows.current === null ? null : (tabbable(rows.current)[0] ?? null);
  }, []);
  useFocusTrap(ref, true, onClose, initial);
  return (
    <div
      ref={ref}
      id={id}
      className="lfb-panel"
      role="dialog"
      aria-label={t('web.filters')}
      aria-describedby={titleId}
    >
      <div className="lfb-ph">
        <b>{t('web.filters')}</b>
        <span className="muted" id={titleId}>
          {t('web.filters_hint')}
        </span>
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label={t('web.close')}
          title={t('web.close')}
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
      </div>
      <div className="lfb-rows" ref={rows}>
        {filters.map((one) => (
          <div key={one.key} className={`lfb-row${one.wide === true ? ' wide' : ''}`}>
            <div className="lfb-lbl">{one.label}</div>
            <div className="lfb-ctl">{one.control}</div>
          </div>
        ))}
      </div>
      <div className="lfb-pf">
        {anyActive ? (
          <button type="button" className="btn sm ghost" onClick={onClearAll}>
            {t('web.filters_clear_all')}
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="btn sm primary" onClick={onClose}>
          {t('web.filters_show_result')}
        </button>
      </div>
    </div>
  );
}
