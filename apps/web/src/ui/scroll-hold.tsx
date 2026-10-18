import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * How much empty height has to stay under the content so the page can keep the scroll
 * position it had, given the content's own height (without any hold). Never negative:
 * a page already tall enough needs no hold.
 *
 * `bottomLine` is the scroll offset plus the scroller's visible height when the page was
 * asked not to move.
 */
export function holdFor(bottomLine: number, naturalHeight: number): number {
  return Math.max(0, Math.ceil(bottomLine - naturalHeight));
}

/**
 * A page that swaps a tall panel for a shorter one under the operator — a shortcut deep in
 * a tab that opens another tab — must not move (W2, `pnpm web:no-scroll`). The browser
 * clamps the scroll offset the moment the content is shorter than it, and that clamp is a
 * jump of hundreds of pixels on a phone.
 *
 * `hold()` is called just before the swap. Before the next paint the hook measures the
 * scroller, keeps the missing height as an empty spacer under the content and puts the
 * offset back, so the swap happens in place. The spacer shrinks as the new panel's content
 * arrives and grows into it, and `release()` (the next ordinary change) drops it.
 *
 * The spacer is an SVG whose `height` attribute carries the figure: the CSP forbids a
 * style attribute, and continuous values go through SVG attributes here (as `Progress`).
 */
export function useScrollHold(
  scrollerId: string,
  changed: unknown,
): {
  readonly hold: () => void;
  readonly release: () => void;
  readonly spacer: ReactNode;
} {
  const target = useRef<{ top: number; bottomLine: number } | null>(null);
  const [height, setHeight] = useState(0);
  const heightRef = useRef(0);
  heightRef.current = height;

  const scroller = () => document.getElementById(scrollerId);
  const measure = () => {
    const el = scroller();
    if (el === null || target.current === null) return;
    const natural = el.scrollHeight - heightRef.current;
    const next = holdFor(target.current.bottomLine, natural);
    if (next !== heightRef.current) setHeight(next);
  };

  // The swap rendered: keep the missing height before the browser paints the clamp.
  useLayoutEffect(() => {
    measure();
    // Measured once per change of the swapped content.
  }, [changed]);

  // The spacer is in place: put the offset back where the operator left it.
  useLayoutEffect(() => {
    const el = scroller();
    if (el === null || target.current === null) return;
    if (el.scrollTop !== target.current.top) el.scrollTop = target.current.top;
  }, [height]);

  // The new panel's content arrives later (a query): give the height back as it grows.
  useLayoutEffect(() => {
    const el = scroller();
    if (el === null || typeof ResizeObserver === 'undefined') return undefined;
    const content = el.firstElementChild;
    if (content === null) return undefined;
    const observer = new ResizeObserver(() => {
      if (target.current !== null) measure();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return {
    hold: () => {
      const el = scroller();
      // No scroll anchoring while held: the spacer would be the anchor, and the new panel
      // growing above it would shift the page for a frame before the hold shrinks.
      el?.classList.add('no-scroll-anchor');
      target.current =
        el === null ? null : { top: el.scrollTop, bottomLine: el.scrollTop + el.clientHeight };
    },
    release: () => {
      scroller()?.classList.remove('no-scroll-anchor');
      target.current = null;
      setHeight(0);
    },
    spacer:
      height > 0 ? (
        <svg
          className="scroll-hold"
          aria-hidden="true"
          focusable="false"
          width="1"
          height={height}
        />
      ) : null,
  };
}
