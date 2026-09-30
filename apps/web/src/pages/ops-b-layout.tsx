import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { formatNumber } from '../format';
import { t } from '../i18n/web.fa';
import { Badge } from '../ui/kit';

/**
 * Page structure shared by the OPS-B settings-like screens (settings, reminders, texts):
 * which of a page's independently saved forms hold an unsaved edit, and an in-page
 * section list that jumps to a section without hiding any other.
 *
 * Every form on those pages keeps its own draft and its own Save, because each one writes
 * one registry row at the version it was read at. What the page adds is the sum: a count
 * beside the title and ONE leave guard for all of them (`useUnsavedChanges` at the page),
 * so leaving with an edit in any row asks first.
 */

type Report = (id: string, dirty: boolean) => void;

/** Null outside a `DirtyScope`: a card drawn on another page reports to nobody. */
const DirtyContext = createContext<Report | null>(null);

/** The ids of the forms on this page that hold an unsaved edit, and how they report it. */
export function useDirtySet(): { readonly dirty: ReadonlySet<string>; readonly report: Report } {
  const [dirty, setDirty] = useState<ReadonlySet<string>>(() => new Set());
  const report = useCallback<Report>((id, isDirty) => {
    setDirty((current) => {
      if (current.has(id) === isDirty) return current;
      const next = new Set(current);
      if (isDirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  return { dirty, report };
}

export function DirtyScope({ report, children }: { report: Report; children: ReactNode }) {
  return <DirtyContext.Provider value={report}>{children}</DirtyContext.Provider>;
}

/**
 * Tells the enclosing page whether this form holds an unsaved edit. Unmounting withdraws
 * the report, so a row that disappears cannot hold the leave guard for ever.
 */
export function useReportDirty(id: string, dirty: boolean): void {
  const report = useContext(DirtyContext);
  useEffect(() => {
    if (report === null) return undefined;
    report(id, dirty);
    return () => report(id, false);
  }, [report, id, dirty]);
}

/** The page-level marker: how many forms hold an unsaved edit. Nothing when none do. */
export function UnsavedCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <Badge tone="warn" dot>
      {`${formatNumber(count)} ${t('web.ob_unsaved_count')}`}
    </Badge>
  );
}

/**
 * Two values compared as the JSON they are sent as, with object keys in a fixed order —
 * a channel whose optional field was cleared and typed again is the same channel.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1)),
        )
      : inner,
  );
}

export interface SectionNavItem {
  /** The id of the element the item jumps to. */
  readonly id: string;
  readonly label: string;
  /** A section holding an unsaved edit is marked, so it can be found again. */
  readonly unsaved?: boolean;
}

/**
 * The list of a long page's sections, as buttons that bring one into view.
 *
 * Not a tablist and not a router: every section stays rendered — each holds forms with
 * drafts, and a section that unmounted when another was chosen would discard them. The
 * item last chosen, or the section nearest the top of the window, is `aria-current`.
 */
export function SectionNav({ label, items }: { label: string; items: readonly SectionNavItem[] }) {
  const [current, setCurrent] = useState(items[0]?.id ?? '');
  const ids = items.map((item) => item.id).join('|');

  useEffect(() => {
    // jsdom and older engines have no observer; the list still works, only without
    // following the scroll.
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top !== undefined) setCurrent(top.target.id);
      },
      { rootMargin: '-64px 0px -60% 0px' },
    );
    for (const id of ids.split('|')) {
      const element = document.getElementById(id);
      if (element !== null) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [ids]);

  return (
    <nav className="ob-secnav" aria-label={label}>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              aria-current={current === item.id ? 'true' : undefined}
              onClick={() => {
                setCurrent(item.id);
                const target = document.getElementById(item.id);
                if (target === null) return;
                if (typeof target.scrollIntoView === 'function') {
                  target.scrollIntoView({ block: 'start' });
                }
                target.focus({ preventScroll: true });
              }}
            >
              <span>{item.label}</span>
              {item.unsaved === true && (
                <span className="ob-secnav-mark" title={t('web.ob_unsaved_row')}>
                  <i className="dot warn" aria-hidden="true" />
                  <span className="visually-hidden">{t('web.ob_unsaved_row')}</span>
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
