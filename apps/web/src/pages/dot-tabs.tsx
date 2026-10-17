import { useRef } from 'react';
import { t } from '../i18n/web.fa';
import { useSelectedTabInStrip } from '../ui/tab-strip';

/**
 * A tab strip whose tabs can carry a marker (W2): a warn dot when the tab's fields differ
 * from what was saved, a danger dot when the form's current problem is in that tab. The
 * markers are said in words to assistive technology, not only drawn.
 *
 * Same keyboard model as the kit's `Tabs`: a roving tabindex, ←/→ (RTL: ← advances),
 * Home/End, and focus follows the selection. The panel is the caller's `role="tabpanel"`
 * with `id={panelId}`.
 */
export type TabMark = 'dirty' | 'problem' | null;

export function DotTabs<T extends string>({
  value,
  onChange,
  items,
  panelId,
  label,
}: {
  value: T;
  onChange: (next: T) => void;
  items: readonly { id: T; label: string; mark?: TabMark }[];
  panelId: string;
  label: string;
}) {
  const buttons = useRef(new Map<T, HTMLButtonElement | null>());
  const strip = useRef<HTMLDivElement | null>(null);
  useSelectedTabInStrip(strip, () => buttons.current.get(value), value);
  const select = (next: T) => {
    onChange(next);
    queueMicrotask(() => buttons.current.get(next)?.focus({ preventScroll: true }));
  };
  const move = (delta: number) => {
    const at = items.findIndex((item) => item.id === value);
    const next = items[(at + delta + items.length) % items.length];
    if (at >= 0 && next !== undefined) select(next.id);
  };
  return (
    <div
      ref={strip}
      className="tabs w-money-tabs"
      role="tablist"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          move(1);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          move(-1);
        } else if (event.key === 'Home' && items[0] !== undefined) {
          event.preventDefault();
          select(items[0].id);
        } else if (event.key === 'End') {
          const last = items[items.length - 1];
          if (last === undefined) return;
          event.preventDefault();
          select(last.id);
        }
      }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          ref={(node) => {
            buttons.current.set(item.id, node);
          }}
          type="button"
          role="tab"
          id={`${panelId}-tab-${item.id}`}
          aria-selected={item.id === value}
          aria-controls={panelId}
          tabIndex={item.id === value ? 0 : -1}
          className={item.id === value ? 'on' : undefined}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {item.mark != null && (
            <>
              <i className={`w-money-tab-dot ${item.mark}`} aria-hidden="true" />
              <span className="visually-hidden">
                {t(item.mark === 'problem' ? 'web.money_tab_problem' : 'web.money_tab_unsaved')}
              </span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}
