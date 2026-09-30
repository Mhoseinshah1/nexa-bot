import type { ReactNode } from 'react';
import { t } from '../i18n/web.fa';

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
  const target = document.getElementById(id);
  if (target === null) return;
  // Not in jsdom; in a browser, the reduced-motion preference is honoured by CSS.
  if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' });
  target.focus({ preventScroll: true });
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
