import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { MAIN_MENU_BUTTON_IDS, type MainMenuButtonId } from '@nexa/contracts';

/**
 * Round T — drag and drop for the builder, on POINTER events, with no library.
 *
 * Pointer events, not the HTML drag-and-drop API, because the HTML API does not fire for a
 * finger on a phone: one implementation then serves a mouse, a pen and a touch screen. A
 * drag starts only on a button's or a row's grip (`touch-action: none` there), so a finger
 * anywhere else still scrolls the page.
 *
 * The drop target is found by hit-testing the point under the pointer for the nearest
 * `[data-drop]` element. What a drop DOES is not decided here: the page maps every
 * (source, target) pair to one of the model's placement primitives — the same ones the
 * Inspector's buttons and the keyboard shortcuts call.
 */

export type DragSource =
  | { readonly kind: 'button'; readonly id: MainMenuButtonId }
  | { readonly kind: 'row'; readonly row: number };

export type DropTarget =
  /** Onto a placed button: the dragged one goes immediately before it. */
  | { readonly kind: 'chip'; readonly id: MainMenuButtonId }
  /** Onto a row but not onto a button in it: the end of that row. */
  | { readonly kind: 'row'; readonly row: number }
  /** Onto the gap before row `at` (`rows.length`: after the last): a new row there. */
  | { readonly kind: 'gap'; readonly at: number }
  /** Onto the Available pool: off the keyboard. */
  | { readonly kind: 'pool' };

function isButtonId(value: string | undefined): value is MainMenuButtonId {
  return value !== undefined && (MAIN_MENU_BUTTON_IDS as readonly string[]).includes(value);
}

/** The target an element declares through its `data-drop` attributes. */
export function dropTargetOf(element: Element | null): DropTarget | null {
  const host = element?.closest<HTMLElement>('[data-drop]');
  if (host === null || host === undefined) return null;
  const { drop, id, row, at } = host.dataset;
  if (drop === 'chip' && isButtonId(id)) return { kind: 'chip', id };
  if (drop === 'row' && row !== undefined) return { kind: 'row', row: Number(row) };
  if (drop === 'gap' && at !== undefined) return { kind: 'gap', at: Number(at) };
  if (drop === 'pool') return { kind: 'pool' };
  return null;
}

/** A stable string for a target, so the one under the pointer can be highlighted. */
export function dropKey(target: DropTarget): string {
  switch (target.kind) {
    case 'chip':
      return `chip:${target.id}`;
    case 'row':
      return `row:${String(target.row)}`;
    case 'gap':
      return `gap:${String(target.at)}`;
    case 'pool':
      return 'pool';
  }
}

function targetAt(x: number, y: number): DropTarget | null {
  if (typeof document.elementFromPoint !== 'function') return null;
  return dropTargetOf(document.elementFromPoint(x, y));
}

export interface PointerDrag {
  /** What is being dragged now, or null. */
  readonly source: DragSource | null;
  /** The key of the target under the pointer, for highlighting. */
  readonly overKey: string | null;
  /** The handlers to spread on a grip. */
  readonly gripProps: (source: DragSource) => {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: () => void;
  };
}

export function usePointerDrag(
  enabled: boolean,
  onDrop: (source: DragSource, target: DropTarget) => void,
): PointerDrag {
  const [source, setSource] = useState<DragSource | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  // The live drag, read by handlers that may run before React re-renders.
  const live = useRef<DragSource | null>(null);
  const onDropRef = useRef(onDrop);
  useEffect(() => {
    onDropRef.current = onDrop;
  });

  const end = () => {
    live.current = null;
    setSource(null);
    setOverKey(null);
  };

  // Escape abandons a drag; nothing changes.
  useEffect(() => {
    if (source === null) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') end();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [source]);

  const gripProps = (from: DragSource) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Capture is an optimisation for the moves that follow; without it they still arrive.
      }
      live.current = from;
      setSource(from);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      if (live.current === null) return;
      const target = targetAt(event.clientX, event.clientY);
      setOverKey(target === null ? null : dropKey(target));
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      const dragged = live.current;
      if (dragged === null) return;
      const target = targetAt(event.clientX, event.clientY);
      end();
      if (target !== null) onDropRef.current(dragged, target);
    },
    onPointerCancel: end,
  });

  return { source, overKey, gripProps };
}
