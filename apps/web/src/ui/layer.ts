import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';

/**
 * Click-outside for popovers that render in a portal (W1 date field, filter panel, saved
 * filters).
 *
 * A popover drawn inside a Drawer, a Modal or a scrolling card is clipped by that
 * container's `overflow`, so these popovers render into `document.body` and are placed
 * against their trigger by CSS anchor positioning (`ui.css`). A portal breaks DOM
 * containment, though: a date picked in a calendar that a filter panel opened is, in the DOM,
 * OUTSIDE the panel, and a plain `panel.contains(target)` would close the panel on it.
 *
 * So each popover keeps the set of elements that count as "inside" it — its trigger's
 * wrapper, its own portal, and every element a popover nested in it (through React, which
 * portals do not interrupt) registers — and only a press outside all of them closes it.
 */
export interface LayerRegistry {
  /** Counts `element` as inside this layer and every layer around it; returns the undo. */
  add: (element: HTMLElement) => () => void;
}

export const LayerContext = createContext<LayerRegistry | null>(null);

export function useLayer(
  open: boolean,
  onOutside: () => void,
): {
  registry: LayerRegistry;
  /** A callback ref: the element counts as inside this layer (and its parents). */
  inside: (element: HTMLElement | null) => (() => void) | undefined;
} {
  const parent = useContext(LayerContext);
  const own = useRef(new Set<HTMLElement>());
  const outside = useRef(onOutside);
  useEffect(() => {
    outside.current = onOutside;
  });
  const registry = useMemo<LayerRegistry>(
    () => ({
      add(element) {
        own.current.add(element);
        const undo = parent?.add(element);
        return () => {
          own.current.delete(element);
          undo?.();
        };
      },
    }),
    [parent],
  );
  const inside = useCallback(
    (element: HTMLElement | null) => (element === null ? undefined : registry.add(element)),
    [registry],
  );
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      for (const element of own.current) if (element.contains(target)) return;
      outside.current();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  return { registry, inside };
}
