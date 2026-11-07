import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Icon } from './icons';
import { t } from '../i18n/web.fa';

/**
 * A drag-and-drop list (PR-2): rows the operator reorders by dragging a grip. No up/down
 * buttons — the keyboard moves a row with ↑/↓ on its grip, which is the same reorder.
 *
 * Pointer events, no library, like the button builder's drag: one implementation serves a
 * mouse, a pen and a finger. A drag starts only on a row's grip (`touch-action: none` there),
 * so a finger anywhere else still scrolls the page; the pointer must travel `DRAG_START_PX`
 * first, so a tap or a resting finger reorders nothing; Escape and a release over the list's
 * own row change nothing. The drop position is a CSS line drawn over the rows — nothing is
 * inserted into the layout while dragging, so nothing under the pointer moves away from it.
 *
 * The list is controlled: it never reorders itself, it asks `onReorder(from, to)` (indexes in
 * the array as it stands) and draws what the parent passes back.
 */

/** How far the pointer must travel, in CSS pixels, before a press on a grip is a drag. */
export const DRAG_START_PX = 6;

/**
 * The insertion position (0 to rows.length) for a pointer at `y`: before the first row whose
 * middle is below the pointer, else after the last. Pure, so the arithmetic is tested alone.
 */
export function insertionAt(rows: readonly { top: number; height: number }[], y: number): number {
  for (const [index, row] of rows.entries()) {
    if (y < row.top + row.height / 2) return index;
  }
  return rows.length;
}

/** The final index of a row moved from `from` to the insertion position `at`. */
export function reorderedIndex(from: number, at: number): number {
  return at > from ? at - 1 : at;
}

export function SortableList<T>({
  items,
  itemKey,
  renderItem,
  onReorder,
  label,
  disabled = false,
}: {
  items: readonly T[];
  itemKey: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  onReorder: (from: number, to: number) => void;
  /** The list's name for assistive technology. */
  label: string;
  disabled?: boolean;
}) {
  const rows = useRef(new Map<string, HTMLLIElement | null>());
  const grips = useRef(new Map<string, HTMLButtonElement | null>());
  const press = useRef<{ index: number; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ from: number; at: number } | null>(null);
  // After a keyboard move the grip of the moved row gets focus back.
  const refocus = useRef<string | null>(null);

  useEffect(() => {
    if (refocus.current === null) return;
    grips.current.get(refocus.current)?.focus();
    refocus.current = null;
  });

  const positions = (): { top: number; height: number }[] =>
    items.map((item) => {
      const rect = rows.current.get(itemKey(item))?.getBoundingClientRect();
      return { top: rect?.top ?? 0, height: rect?.height ?? 0 };
    });

  const begin = (index: number, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || event.button !== 0) return;
    press.current = { index, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = press.current;
    if (start === null) return;
    if (
      drag === null &&
      Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_START_PX
    ) {
      return;
    }
    setDrag({ from: start.index, at: insertionAt(positions(), event.clientY) });
  };
  const finish = (event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const start = press.current;
    press.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const current = drag;
    setDrag(null);
    if (cancelled || start === null || current === null) return;
    const at = insertionAt(positions(), event.clientY);
    const to = reorderedIndex(start.index, at);
    if (to !== start.index) onReorder(start.index, to);
  };
  const key = (index: number, key: string, event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === 'Escape' && drag !== null) {
      press.current = null;
      setDrag(null);
      return;
    }
    const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const to = index + delta;
    if (to < 0 || to >= items.length) return;
    refocus.current = key;
    onReorder(index, to);
  };

  return (
    <ul className="sortable" role="list" aria-label={label}>
      {items.map((item, index) => {
        const id = itemKey(item);
        const line =
          drag === null
            ? null
            : drag.at === index
              ? 'before'
              : drag.at === items.length && index === items.length - 1
                ? 'after'
                : null;
        return (
          <li
            key={id}
            ref={(node) => {
              rows.current.set(id, node);
            }}
            className={[
              'sortable-item',
              drag?.from === index ? 'is-dragging' : '',
              line === 'before' ? 'is-drop-before' : '',
              line === 'after' ? 'is-drop-after' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <button
              type="button"
              className="sortable-grip"
              ref={(node) => {
                grips.current.set(id, node);
              }}
              aria-label={t('web.sortable_grip')}
              title={t('web.sortable_hint')}
              disabled={disabled}
              onPointerDown={(event) => begin(index, event)}
              onPointerMove={move}
              onPointerUp={(event) => finish(event, false)}
              onPointerCancel={(event) => finish(event, true)}
              onKeyDown={(event) => key(index, id, event)}
            >
              <Icon name="grip" />
            </button>
            <div className="sortable-body">{renderItem(item, index)}</div>
          </li>
        );
      })}
    </ul>
  );
}
