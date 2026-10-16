import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n/web.fa';
import { Num } from '../ui/kit';
import { Icon } from '../ui/icons';
import { useFocusTrap } from '../ui/overlays';

/**
 * Editor layout pieces shared by the commerce pages (products, discounts,
 * campaigns, broadcasts): the section sub-nav, one titled form section, and the
 * save bar. Presentation only — no page state lives here.
 *
 * The sub-nav is a list of BUTTONS, not `#fragment` links: a fragment link is a
 * history entry, and the router treats a history move on a dirty page as a
 * navigation it has to ask about. Scrolling to a section is not leaving the page.
 */

export interface SectionLink {
  readonly id: string;
  readonly label: string;
}

/**
 * Scrolls an element (a section, or a form's first field) into view and moves focus
 * to it, so a keyboard user lands there too.
 */
export function revealField(id: string): void {
  // After the render the click caused: the form or panel being revealed may be the one
  // the same click opened, and it is not in the document until then.
  window.setTimeout(() => {
    const target = document.getElementById(id);
    if (target === null) return;
    // Not in jsdom; in a browser, the reduced-motion preference is honoured by CSS.
    if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' });
    target.focus({ preventScroll: true });
  }, 0);
}

/** The sticky list of an editor's sections, beside the form. */
export function SectionNav({ items }: { items: readonly SectionLink[] }) {
  return (
    <nav className="cb-section-nav" aria-label={t('web.cb_sections')}>
      {items.map((item) => (
        <button key={item.id} type="button" onClick={() => revealField(item.id)}>
          {item.label}
        </button>
      ))}
    </nav>
  );
}

/**
 * One section of a sectioned form card: a heading, an optional sentence, and
 * its fields in the two-column form grid (one column on a narrow screen).
 * `grid={false}` for a section whose children lay themselves out.
 */
export function FormSection({
  id,
  title,
  hint,
  children,
  grid = true,
}: {
  id: string;
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  grid?: boolean;
}) {
  return (
    <div
      className="form-section cb-form-section"
      id={id}
      tabIndex={-1}
      role="group"
      aria-labelledby={`${id}-title`}
    >
      <h3 id={`${id}-title`}>{title}</h3>
      {hint !== undefined && <p className="desc">{hint}</p>}
      {grid ? <div className="form-grid">{children}</div> : children}
    </div>
  );
}

/**
 * The foot of an editor: the unsaved-changes marker when the form differs from
 * what was loaded, then the explicit Save (and anything beside it).
 */
export function SaveBar({ dirty, children }: { dirty: boolean; children: ReactNode }) {
  return (
    <div className="cb-savebar">
      {dirty && (
        <span className="cb-dirty" role="status">
          <i className="dot" aria-hidden="true" />
          {t('web.unsaved_changes')}
        </span>
      )}
      <span className="spacer" />
      {children}
    </div>
  );
}

/**
 * A labelled checkbox with a hint, laid out as a form field. The label wraps the box,
 * so the box's accessible name is the label text.
 */
export function CheckField({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled = false,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="field cb-check-field">
      <label className="check" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      {hint !== undefined && <span className="muted small">{hint}</span>}
    </div>
  );
}

/**
 * One labelled set of filter chips — its own `role="group"` — for a filter row that
 * holds several sets side by side (`<div className="filter-row">` + `ChipDivider`).
 * The kit's `FilterChips` is the row itself; this is a set inside one.
 */
export function ChipGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="cb-chip-group" role="group" aria-label={label}>
      {children}
    </div>
  );
}

/**
 * Whether the window is at most `maxWidth` px wide, following resizes. The same media query
 * the CSS uses, so a layout decision made in a script and one made in a stylesheet agree.
 */
export function useNarrowScreen(maxWidth = 980): boolean {
  const query = `(max-width: ${maxWidth}px)`;
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    setNarrow(list.matches);
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return narrow;
}

/** One figure of the page's summary line: a count and what it counts. */
export function SummaryPill({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone?: 'ok' | 'warn' | 'info';
}) {
  return (
    <span className={tone === undefined ? 'bx-pill' : `bx-pill ${tone}`}>
      <b>
        <Num value={value} />
      </b>
      {label}
    </span>
  );
}

/**
 * A side sheet whose contents stay MOUNTED while it is closed.
 *
 * The kit's `Drawer` unmounts its body on close, which is right for a form whose draft lives
 * in its caller. A sheet holding rows that keep their OWN drafts (a setting row, a template
 * card) must not: closing it would discard what was typed without a word, and the page's
 * unsaved count, fed by those rows, would forget it too. This one is hidden instead — same
 * look, focus trap, Escape, backdrop and ✕ as the drawer.
 */
export function KeptSheet({
  open,
  onClose,
  title,
  hint,
  wide = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  hint?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  const titleId = useId();
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(ref, open, onClose);
  return createPortal(
    <>
      {open && <div className="drawer-layer" onMouseDown={onClose} />}
      <aside
        ref={ref}
        className={wide ? 'drawer wide bx-kept' : 'drawer bx-kept'}
        hidden={!open}
        aria-labelledby={titleId}
        {...(open ? { role: 'dialog', 'aria-modal': true } : {})}
      >
        <div className="drawer-head">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t('web.close')}
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="drawer-body stack">
          {hint !== undefined && <p className="muted small">{hint}</p>}
          {children}
        </div>
      </aside>
    </>,
    document.body,
  );
}
