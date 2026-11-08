import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { t } from '../i18n/web.fa';
import { formatNumber } from '../format';

/**
 * Layout drag and drop (web redesign): items arranged in ROWS plus a «free» box, reordered by
 * dragging — no up/down or left/right buttons. The first user is the bot's button layout
 * (PR-6); the model is generic and knows nothing about buttons.
 *
 * Drop targets: an item (placed next to it), the empty space of a row (end of that row), the
 * line between rows (a new row there), the «ردیف تازه» zone (a new row at the end) and the
 * free box (out of the layout). Items listed in `fixed` neither drag nor accept a drop next to
 * them at the end of a layout (the service page's «بازگشت به فهرست» is always last).
 *
 * The keyboard reorders too: Enter/Space grabs the focused item, the arrow keys move it
 * (left/right along its row, up/down between rows — past the first or last row they make a new
 * row), Delete moves it to the free box, Enter drops, Escape puts it back.
 *
 * Pure model first (`moveItem`, `keyboardMove`) so the rules are tested without a DOM; the
 * component only turns pointer positions and keys into those calls. The layout is controlled —
 * `onChange` receives the next layout and the parent draws what it passes back.
 */

export interface DndLayout {
  readonly rows: readonly (readonly string[])[];
  readonly free: readonly string[];
}

export type DropTarget =
  | { readonly kind: 'item'; readonly id: string; readonly side: 'before' | 'after' }
  | { readonly kind: 'row-end'; readonly row: number }
  | { readonly kind: 'gap'; readonly at: number }
  | { readonly kind: 'new-row' }
  | { readonly kind: 'free' };

export interface DndRules {
  /** Most items in one row (the service layout keeps 3). */
  readonly maxPerRow?: number;
  /** Ids that cannot be dragged and always stay last in the last row. */
  readonly fixed?: readonly string[];
}

/** How far the pointer must travel before a press is a drag. */
export const DND_THRESHOLD_PX = 6;

function clean(rows: readonly (readonly string[])[]): string[][] {
  return rows.filter((row) => row.length > 0).map((row) => [...row]);
}

function locate(layout: DndLayout, id: string): { row: number; col: number } | 'free' | null {
  for (const [row, items] of layout.rows.entries()) {
    const col = items.indexOf(id);
    if (col >= 0) return { row, col };
  }
  return layout.free.includes(id) ? 'free' : null;
}

function sameLayout(a: DndLayout, b: DndLayout): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Apply a drop. `null` means "nothing changes" — an invalid drop (a fixed item, a full row)
 * or one that lands the item where it already is.
 */
export function moveItem(
  layout: DndLayout,
  id: string,
  target: DropTarget,
  rules: DndRules = {},
): DndLayout | null {
  const fixed = rules.fixed ?? [];
  if (fixed.includes(id) || locate(layout, id) === null) return null;
  const rows = layout.rows.map((row) => row.filter((x) => x !== id));
  let free = layout.free.filter((x) => x !== id);
  const lastFixed = (): number => {
    // The fixed items sit at the end of the last row: nothing is dropped after them.
    const lastRow = rows[rows.length - 1];
    if (lastRow === undefined) return 0;
    let n = 0;
    while (n < lastRow.length && fixed.includes(lastRow[lastRow.length - 1 - n] ?? '')) n += 1;
    return n;
  };
  const fits = (row: readonly string[]): boolean =>
    rules.maxPerRow === undefined || row.length < rules.maxPerRow;

  switch (target.kind) {
    case 'free':
      free = [...free, id];
      break;
    case 'new-row': {
      const keep = lastFixed();
      if (keep > 0) {
        // A new row goes BEFORE the row that ends with the fixed item.
        rows.splice(rows.length - 1, 0, [id]);
      } else rows.push([id]);
      break;
    }
    case 'gap': {
      const at = Math.max(0, Math.min(target.at, rows.length));
      if (at >= rows.length && lastFixed() > 0) rows.splice(rows.length - 1, 0, [id]);
      else rows.splice(at, 0, [id]);
      break;
    }
    case 'row-end': {
      const row = rows[target.row];
      if (row === undefined || !fits(row)) return null;
      const keep = target.row === rows.length - 1 ? lastFixed() : 0;
      row.splice(row.length - keep, 0, id);
      break;
    }
    case 'item': {
      if (target.id === id) return null;
      const rowIndex = rows.findIndex((row) => row.includes(target.id));
      const row = rows[rowIndex];
      if (row === undefined || !fits(row)) return null;
      const col = row.indexOf(target.id);
      if (fixed.includes(target.id) && target.side === 'after') return null;
      row.splice(target.side === 'before' ? col : col + 1, 0, id);
      break;
    }
  }
  const next: DndLayout = { rows: clean(rows), free };
  return sameLayout(next, layout) ? null : next;
}

/** One keyboard step for a grabbed item. `rtl`: the Left arrow moves toward the row's end. */
export function keyboardMove(
  layout: DndLayout,
  id: string,
  key: string,
  rules: DndRules = {},
  rtl = true,
): DndLayout | null {
  const at = locate(layout, id);
  if (at === null) return null;
  if (key === 'Delete' || key === 'Backspace') return moveItem(layout, id, { kind: 'free' }, rules);
  if (at === 'free') {
    if (key === 'ArrowUp' || key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowDown') {
      const last = layout.rows.length - 1;
      return last < 0
        ? moveItem(layout, id, { kind: 'new-row' }, rules)
        : (moveItem(layout, id, { kind: 'row-end', row: last }, rules) ??
            moveItem(layout, id, { kind: 'new-row' }, rules));
    }
    return null;
  }
  const row = layout.rows[at.row] ?? [];
  const forward = (rtl ? 'ArrowLeft' : 'ArrowRight') === key;
  const backward = (rtl ? 'ArrowRight' : 'ArrowLeft') === key;
  if (forward || backward) {
    const neighbour = row[at.col + (forward ? 1 : -1)];
    if (neighbour === undefined) return null;
    return moveItem(
      layout,
      id,
      { kind: 'item', id: neighbour, side: forward ? 'after' : 'before' },
      rules,
    );
  }
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const up = key === 'ArrowUp';
    const targetRow = layout.rows[at.row + (up ? -1 : 1)];
    if (targetRow === undefined) {
      if (row.length === 1) return null;
      return up
        ? moveItem(layout, id, { kind: 'gap', at: 0 }, rules)
        : moveItem(layout, id, { kind: 'new-row' }, rules);
    }
    const col = Math.min(at.col, targetRow.length - 1);
    const anchor = targetRow[col];
    if (anchor === undefined) return null;
    return (
      moveItem(layout, id, { kind: 'item', id: anchor, side: 'before' }, rules) ??
      moveItem(layout, id, { kind: 'item', id: anchor, side: 'after' }, rules)
    );
  }
  return null;
}

/* ---------------------------------------------------------------- component --- */

function targetAt(x: number, y: number, rtl: boolean): DropTarget | null {
  const element = document.elementFromPoint(x, y);
  if (element === null) return null;
  const item = element.closest<HTMLElement>('[data-dnd-item]');
  if (item !== null) {
    const rect = item.getBoundingClientRect();
    const first = x > rect.left + rect.width / 2;
    const before = rtl ? first : !first;
    return { kind: 'item', id: item.dataset['dndItem'] ?? '', side: before ? 'before' : 'after' };
  }
  const row = element.closest<HTMLElement>('[data-dnd-row]');
  if (row !== null) return { kind: 'row-end', row: Number(row.dataset['dndRow']) };
  const gap = element.closest<HTMLElement>('[data-dnd-gap]');
  if (gap !== null) return { kind: 'gap', at: Number(gap.dataset['dndGap']) };
  if (element.closest('[data-dnd-new-row]') !== null) return { kind: 'new-row' };
  if (element.closest('[data-dnd-free]') !== null) return { kind: 'free' };
  return null;
}

function targetKey(target: DropTarget | null): string {
  if (target === null) return '';
  switch (target.kind) {
    case 'item':
      return `item:${target.id}:${target.side}`;
    case 'row-end':
      return `row:${target.row}`;
    case 'gap':
      return `gap:${target.at}`;
    default:
      return target.kind;
  }
}

export function LayoutDnd({
  layout,
  onChange,
  renderItem,
  nameOf,
  rules = {},
  label,
  rtl = true,
  disabled = false,
}: {
  layout: DndLayout;
  onChange: (next: DndLayout) => void;
  renderItem: (id: string) => ReactNode;
  /** The item's spoken name, for the keyboard announcements. */
  nameOf: (id: string) => string;
  rules?: DndRules;
  /** The layout's name for assistive technology. */
  label: string;
  rtl?: boolean;
  disabled?: boolean;
}) {
  const fixed = rules.fixed ?? [];
  const press = useRef<{ id: string; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ id: string; over: DropTarget | null } | null>(null);
  const [grabbed, setGrabbed] = useState<{ id: string; snapshot: DndLayout } | null>(null);
  const [announce, setAnnounce] = useState('');
  const dragRef = useRef(drag);
  dragRef.current = drag;

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>, id: string) => {
    if (disabled || fixed.includes(id) || event.button !== 0) return;
    press.current = { id, x: event.clientX, y: event.clientY };
    const move = (e: PointerEvent) => {
      const start = press.current;
      if (start === null) return;
      if (
        dragRef.current === null &&
        Math.hypot(e.clientX - start.x, e.clientY - start.y) < DND_THRESHOLD_PX
      )
        return;
      const over = targetAt(e.clientX, e.clientY, rtl);
      const key = targetKey(over);
      if (dragRef.current === null || targetKey(dragRef.current.over) !== key)
        setDrag({ id: start.id, over });
    };
    const end = (e: PointerEvent, cancelled: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', esc);
      const start = press.current;
      press.current = null;
      const active = dragRef.current;
      setDrag(null);
      if (cancelled || start === null || active === null) return;
      const over = targetAt(e.clientX, e.clientY, rtl);
      if (over === null) return;
      const next = moveItem(layout, start.id, over, rules);
      if (next !== null) onChange(next);
    };
    const up = (e: PointerEvent) => end(e, false);
    const cancel = (e: PointerEvent) => end(e, true);
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') end(new PointerEvent('pointercancel'), true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', esc);
  };

  const position = (next: DndLayout, id: string): { row: string; col: string } => {
    const at = locate(next, id);
    return at === null || at === 'free'
      ? { row: '—', col: '—' }
      : { row: formatNumber(at.row + 1), col: formatNumber(at.col + 1) };
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, id: string) => {
    if (disabled || fixed.includes(id)) return;
    if (grabbed === null) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setGrabbed({ id, snapshot: layout });
        const p = position(layout, id);
        setAnnounce(
          t('web.kit_dnd_grabbed')
            .replace('{name}', nameOf(id))
            .replace('{row}', p.row)
            .replace('{col}', p.col),
        );
      }
      return;
    }
    if (grabbed.id !== id) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setGrabbed(null);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onChange(grabbed.snapshot);
      setGrabbed(null);
      setAnnounce(t('web.kit_dnd_cancelled'));
      return;
    }
    const next = keyboardMove(layout, id, event.key, rules, rtl);
    if (next === null) return;
    event.preventDefault();
    onChange(next);
    const p = position(next, id);
    setAnnounce(
      locate(next, id) === 'free'
        ? t('web.kit_dnd_freed').replace('{name}', nameOf(id))
        : t('web.kit_dnd_moved')
            .replace('{name}', nameOf(id))
            .replace('{row}', p.row)
            .replace('{col}', p.col),
    );
  };

  const over = drag?.over ?? null;
  const overKey = targetKey(over);
  const item = (id: string): ReactNode => {
    const isFixed = fixed.includes(id);
    const cls = [
      'dnd-item',
      isFixed && 'fixed',
      drag?.id === id && 'dragging',
      grabbed?.id === id && 'grabbed',
      overKey.startsWith(`item:${id}:`) && 'over',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <div
        key={id}
        data-dnd-item={id}
        className={cls}
        role="button"
        tabIndex={isFixed || disabled ? -1 : 0}
        aria-pressed={grabbed?.id === id}
        aria-describedby={isFixed ? undefined : 'dnd-hint'}
        onPointerDown={(e) => onPointerDown(e, id)}
        onKeyDown={(e) => onKeyDown(e, id)}
      >
        {renderItem(id)}
      </div>
    );
  };

  return (
    <div className="dnd-layout" role="group" aria-label={label}>
      <span id="dnd-hint" className="visually-hidden">
        {t('web.kit_dnd_item_hint')}
      </span>
      <span className="visually-hidden" role="status" aria-live="polite">
        {announce}
      </span>
      {layout.rows.map((row, index) => (
        <div key={index}>
          <div
            className={`dnd-gap${overKey === `gap:${index}` ? ' over' : ''}`}
            data-dnd-gap={index}
          />
          <div
            className={`dnd-row${overKey === `row:${index}` ? ' over' : ''}`}
            data-dnd-row={index}
            aria-label={t('web.kit_dnd_row_label').replace('{n}', formatNumber(index + 1))}
          >
            {row.map(item)}
          </div>
        </div>
      ))}
      <div
        className={`dnd-gap${overKey === `gap:${layout.rows.length}` ? ' over' : ''}`}
        data-dnd-gap={layout.rows.length}
      />
      <div className={`dnd-new-row${overKey === 'new-row' ? ' over' : ''}`} data-dnd-new-row>
        {t('web.kit_dnd_new_row')}
      </div>
      <div
        className={`dnd-free${overKey === 'free' ? ' over' : ''}`}
        data-dnd-free
        aria-label={t('web.kit_dnd_free')}
      >
        {layout.free.length === 0 ? t('web.kit_dnd_free') : layout.free.map(item)}
      </div>
    </div>
  );
}
