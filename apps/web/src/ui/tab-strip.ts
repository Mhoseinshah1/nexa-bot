import { useLayoutEffect, type RefObject } from 'react';

/** Room left between a tab brought into view and the strip's edge, so it does not sit flush. */
const INSET_PX = 12;

/**
 * Brings the selected tab into view INSIDE its strip (B6). A strip wider than its screen
 * scrolls sideways; a tab chosen out of sight — by a shortcut elsewhere on the page, by a
 * link that opens on it, by the arrow keys — would otherwise stay hidden past the edge.
 *
 * Only the strip's own horizontal offset moves. `scrollIntoView` is deliberately not used:
 * it scrolls every scrollable ancestor too, and the page must not move when a tab is chosen
 * (W2, `pnpm web:no-scroll`).
 */
export function scrollTabIntoStrip(
  strip: HTMLElement | null | undefined,
  tab: HTMLElement | null | undefined,
): void {
  if (strip == null || tab == null) return;
  if (strip.scrollWidth <= strip.clientWidth) return;
  if (typeof strip.scrollBy !== 'function') return;
  const box = strip.getBoundingClientRect();
  const at = tab.getBoundingClientRect();
  let delta = 0;
  // Only a tab that is cut off moves the strip; then it lands a little inside the edge.
  if (at.left < box.left) delta = at.left - box.left - INSET_PX;
  else if (at.right > box.right) delta = at.right - box.right + INSET_PX;
  // Relative, so the sign is right in a right-to-left strip as in a left-to-right one.
  if (delta !== 0) strip.scrollBy({ left: delta });
}

/** `scrollTabIntoStrip` whenever the selected tab changes, and on first draw. */
export function useSelectedTabInStrip(
  strip: RefObject<HTMLElement | null>,
  selected: () => HTMLElement | null | undefined,
  value: unknown,
): void {
  useLayoutEffect(() => {
    scrollTabIntoStrip(strip.current, selected());
    // `selected` reads refs; the selection is what changes.
  }, [value]);
}
