import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { MAIN_MENU_BUTTON_IDS, type MainMenuButtonId } from '@nexa/contracts';
import { chipSide, type DragSource, type DropTarget } from './model';

export type { DragSource, DropTarget } from './model';

/**
 * Round T — drag and drop for the builder, on POINTER events, with no library.
 *
 * Pointer events, not the HTML drag-and-drop API, because the HTML API does not fire for a
 * finger on a phone: one implementation then serves a mouse, a pen and a touch screen. A
 * drag starts only on a button's or a row's grip (`touch-action: none` there), so a finger
 * anywhere else still scrolls the page.
 *
 * What a drop DOES is not decided here: `applyDrop` (model.ts) maps every (source, target)
 * pair to one of the placement primitives the Inspector's buttons and the keyboard shortcuts
 * call, and answers null for a drop that would change nothing.
 *
 * The quality rules (owner, 2026-10-02 — the drag already worked on a real phone):
 *
 * - **No accidental reorder.** Pressing a grip starts nothing: the pointer must travel
 *   `DRAG_THRESHOLD_PX` first, so a tap, a click or a finger that only rests is a no-op.
 *   Escape, a cancelled pointer and a release over no target change nothing either.
 * - **No jumpiness.** Nothing on the page changes size when a drag starts or moves: the
 *   gaps between rows are always there, and every placeholder is drawn by CSS over the
 *   layout, never inserted into it — so the target under a still pointer cannot move away
 *   from it. The half of a button the pointer is over decides before/after with a small
 *   dead band in the middle (`chipSide`), so the placeholder does not flicker.
 * - **Smooth tracking.** A ghost of the dragged key follows the pointer, positioned once per
 *   animation frame through an SVG `transform` ATTRIBUTE (the production CSP forbids every
 *   inline style), and the target is hit-tested on that same frame, not on every event.
 * - **Touch.** The grip is a real button with a 34 × 44 px hit area: Chromium's touch
 *   adjustment moved a finger on the old 18 px `span` grip to the key's own button beside it
 *   (round-T QA-2). Near the top or bottom of the screen the page scrolls by itself.
 */

/** How far the pointer must travel, in CSS pixels, before a press on a grip is a drag. */
export const DRAG_THRESHOLD_PX = 6;

/** Whether the pointer has travelled far enough from where it was pressed to start a drag. */
export function passedThreshold(
  start: { readonly x: number; readonly y: number },
  now: { readonly x: number; readonly y: number },
  threshold = DRAG_THRESHOLD_PX,
): boolean {
  return Math.hypot(now.x - start.x, now.y - start.y) >= threshold;
}

/**
 * How far to scroll the page this frame while dragging near its top or bottom edge:
 * negative up, positive down, zero in between — faster the closer the pointer is.
 */
export function autoScrollStep(y: number, viewportHeight: number, edge = 56, max = 16): number {
  if (viewportHeight <= 0) return 0;
  if (y < edge) return -Math.ceil(((edge - Math.max(y, 0)) / edge) * max);
  if (y > viewportHeight - edge) {
    return Math.ceil(((Math.min(y, viewportHeight) - (viewportHeight - edge)) / edge) * max);
  }
  return 0;
}

/**
 * The element that actually scrolls the builder: the nearest ancestor whose overflow scrolls
 * (the shell's `.content`), else the document. The shell keeps the document at 100% height,
 * so scrolling `window` would do nothing.
 */
export function scrollContainerOf(element: Element | null): Element {
  for (let node = element?.parentElement ?? null; node !== null; node = node.parentElement) {
    const style = getComputedStyle(node);
    const overflowY = style.overflowY || style.overflow;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return document.scrollingElement ?? document.documentElement;
}

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

/**
 * The target under a point, with a button resolved to the side the pointer is on: over the
 * END half of a key the drop goes before the NEXT key in that row, or to the row's end
 * after the last one. `previous` is the side last answered, for `chipSide`'s dead band.
 */
export function targetAtPoint(
  element: Element | null,
  x: number,
  rtl: boolean,
  previous: 'before' | 'after' | null,
): { readonly target: DropTarget | null; readonly side: 'before' | 'after' | null } {
  const target = dropTargetOf(element);
  if (target?.kind !== 'chip') return { target, side: null };
  const host = element?.closest<HTMLElement>('[data-drop="chip"]');
  if (host === null || host === undefined) return { target, side: null };
  const side = chipSide(host.getBoundingClientRect(), x, rtl, previous);
  if (side === 'before') return { target, side };
  let next = host.nextElementSibling;
  while (next !== null && !(next instanceof HTMLElement && next.dataset['drop'] === 'chip')) {
    next = next.nextElementSibling;
  }
  if (next instanceof HTMLElement) return { target: dropTargetOf(next), side };
  const row = host.closest('[data-drop="row"]');
  return { target: row === null ? null : dropTargetOf(row), side };
}

/** A stable string for a target, so one can be compared with another. */
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

export interface PointerDrag {
  /** What is being dragged now (past the threshold), or null. */
  readonly source: DragSource | null;
  /** The target under the pointer now, or null. Whether a drop there DOES anything is the model's. */
  readonly over: DropTarget | null;
  /** Whether the drag is driven by a finger (the ghost is drawn above it, not under it). */
  readonly touch: boolean;
  /** The ghost's `<g>`: the hook writes its `transform` attribute every frame. */
  readonly ghostRef: RefObject<SVGGElement | null>;
  /** The handlers to spread on a grip. */
  readonly gripProps: (source: DragSource) => {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: () => void;
    onLostPointerCapture: () => void;
  };
}

interface Pressed {
  readonly from: DragSource;
  readonly startX: number;
  readonly startY: number;
  readonly touch: boolean;
}

function isRtl(): boolean {
  return document.documentElement.dir !== 'ltr';
}

function elementAt(x: number, y: number): Element | null {
  return typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
}

export function usePointerDrag(
  enabled: boolean,
  onDrop: (source: DragSource, target: DropTarget) => void,
): PointerDrag {
  const [source, setSource] = useState<DragSource | null>(null);
  const [over, setOver] = useState<DropTarget | null>(null);
  const [touch, setTouch] = useState(false);
  const ghostRef = useRef<SVGGElement | null>(null);
  // The live drag, read by handlers that may run before React re-renders.
  const pressed = useRef<Pressed | null>(null);
  const live = useRef<DragSource | null>(null);
  const point = useRef({ x: 0, y: 0 });
  const side = useRef<'before' | 'after' | null>(null);
  const overKey = useRef<string | null>(null);
  const frame = useRef<number | null>(null);
  const scroller = useRef<Element | null>(null);
  const onDropRef = useRef(onDrop);
  useEffect(() => {
    onDropRef.current = onDrop;
  });

  const resolve = (): DropTarget | null => {
    const found = targetAtPoint(
      elementAt(point.current.x, point.current.y),
      point.current.x,
      isRtl(),
      side.current,
    );
    side.current = found.side;
    return found.target;
  };

  const publishOver = (target: DropTarget | null) => {
    const key = target === null ? null : dropKey(target);
    if (key === overKey.current) return;
    overKey.current = key;
    setOver(target);
  };

  const placeGhost = () => {
    const ghost = ghostRef.current;
    if (ghost === null) return;
    const { x, y } = point.current;
    // Above a finger, so the finger never hides it; beside a mouse pointer.
    const lift = pressed.current?.touch === true ? 56 : 8;
    ghost.setAttribute('transform', `translate(${String(x)} ${String(y - lift)})`);
  };

  const cancelFrame = () => {
    if (frame.current !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(frame.current);
    }
    frame.current = null;
  };

  // One frame: place the ghost, hit-test the point, scroll near an edge — and again while the
  // page is still scrolling under a pointer that has stopped.
  const tick = () => {
    frame.current = null;
    if (live.current === null) return;
    placeGhost();
    publishOver(resolve());
    const box = scroller.current;
    if (box === null) return;
    const viewport =
      box === (document.scrollingElement ?? document.documentElement)
        ? { top: 0, height: window.innerHeight }
        : box.getBoundingClientRect();
    const step = autoScrollStep(point.current.y - viewport.top, viewport.height);
    if (step === 0) return;
    const before = box.scrollTop;
    box.scrollTop = before + step;
    // Keep scrolling under a still pointer only while the container actually moves.
    if (box.scrollTop !== before) schedule();
  };
  const schedule = () => {
    if (frame.current !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      tick();
      return;
    }
    frame.current = requestAnimationFrame(tick);
  };

  const end = () => {
    cancelFrame();
    pressed.current = null;
    live.current = null;
    side.current = null;
    overKey.current = null;
    setSource(null);
    setOver(null);
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
  // A drag never outlives the page.
  useEffect(() => cancelFrame, []);

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
      scroller.current = scrollContainerOf(event.currentTarget);
      pressed.current = {
        from,
        startX: event.clientX,
        startY: event.clientY,
        touch: event.pointerType === 'touch',
      };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const press = pressed.current;
      if (press === null) return;
      point.current = { x: event.clientX, y: event.clientY };
      if (live.current === null) {
        if (!passedThreshold({ x: press.startX, y: press.startY }, point.current)) return;
        live.current = press.from;
        setTouch(press.touch);
        setSource(press.from);
      }
      schedule();
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      const dragged = live.current;
      if (dragged === null) {
        // A press that never became a drag: nothing moves.
        end();
        return;
      }
      point.current = { x: event.clientX, y: event.clientY };
      const target = resolve();
      end();
      if (target !== null) onDropRef.current(dragged, target);
    },
    onPointerCancel: end,
    onLostPointerCapture: () => {
      // Capture lost before the release (an alert, a gesture the browser took over): the
      // moves would stop arriving, so the drag is abandoned and nothing changes. After a
      // release `end` has already run and this does nothing.
      if (pressed.current !== null) end();
    },
  });

  return { source, over, touch, ghostRef, gripProps };
}
