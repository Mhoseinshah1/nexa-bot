import { describe, expect, it } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { holdFor, useScrollHold } from '../../apps/web/src/ui/scroll-hold';

/**
 * W2 at 390px: Customer 360's wallet shortcut sits deep in «نمای کلی» and opens a far shorter
 * tab. Without a hold the browser clamps the scroll offset to the shorter page — the jump
 * `pnpm web:no-scroll` reported on `/users/:id`. jsdom has no layout, so the scroller's
 * geometry is stubbed: the content is as tall as the tab drawn in it, plus the spacer.
 */

describe('holdFor', () => {
  it('keeps exactly the height the page is missing', () => {
    expect(holdFor(2189, 1800)).toBe(389);
  });

  it('keeps nothing when the page is tall enough', () => {
    expect(holdFor(2189, 2514)).toBe(0);
    expect(holdFor(2189, 2189)).toBe(0);
  });

  it('rounds up, so a fraction of a pixel cannot clamp the offset', () => {
    expect(holdFor(1000.4, 1000)).toBe(1);
  });
});

const TALL = 2500;
const SHORT = 1200;
const VISIBLE = 780;

function Page() {
  const [tab, setTab] = useState<'tall' | 'short'>('tall');
  const hold = useScrollHold('main', tab);
  return (
    <main id="main" data-tab={tab}>
      <div>
        <button
          type="button"
          onClick={() => {
            hold.hold();
            setTab('short');
          }}
        >
          jump
        </button>
        <button
          type="button"
          onClick={() => {
            hold.release();
            setTab('tall');
          }}
        >
          back
        </button>
        {hold.spacer}
      </div>
    </main>
  );
}

/** The scroller's geometry: the tab's own height plus the spacer, and an offset that clamps. */
function stubGeometry(main: HTMLElement): { readonly top: () => number } {
  let top = 0;
  const height = () => {
    const natural = main.dataset.tab === 'tall' ? TALL : SHORT;
    const spacer = Number(main.querySelector('svg.scroll-hold')?.getAttribute('height') ?? 0);
    return natural + spacer;
  };
  // A browser clamps the STORED offset whenever layout finds the page shorter than it; it
  // does not come back when the page grows again.
  const clamp = () => {
    top = Math.min(top, Math.max(0, height() - VISIBLE));
    return top;
  };
  Object.defineProperty(main, 'clientHeight', { configurable: true, get: () => VISIBLE });
  Object.defineProperty(main, 'scrollHeight', {
    configurable: true,
    get: () => {
      clamp();
      return height();
    },
  });
  Object.defineProperty(main, 'scrollTop', {
    configurable: true,
    get: clamp,
    set: (value: number) => {
      top = value;
    },
  });
  return { top: () => main.scrollTop };
}

describe('useScrollHold', () => {
  it('keeps the page where it was when a shortcut opens a shorter tab', () => {
    const { container, getByText } = render(<Page />);
    const main = container.querySelector<HTMLElement>('#main')!;
    const geometry = stubGeometry(main);
    main.scrollTop = 1409;

    act(() => {
      fireEvent.click(getByText('jump'));
    });

    expect(main.dataset.tab).toBe('short');
    const spacer = main.querySelector('svg.scroll-hold');
    expect(spacer?.getAttribute('height')).toBe(String(1409 + VISIBLE - SHORT));
    expect(spacer?.getAttribute('aria-hidden')).toBe('true');
    expect(geometry.top()).toBe(1409);
    expect(main.classList.contains('no-scroll-anchor')).toBe(true);
  });

  it('drops the spacer, and anchoring comes back, on the next ordinary change', () => {
    const { container, getByText } = render(<Page />);
    const main = container.querySelector<HTMLElement>('#main')!;
    stubGeometry(main);
    main.scrollTop = 1409;
    act(() => {
      fireEvent.click(getByText('jump'));
    });

    act(() => {
      fireEvent.click(getByText('back'));
    });

    expect(main.querySelector('svg.scroll-hold')).toBeNull();
    expect(main.classList.contains('no-scroll-anchor')).toBe(false);
  });

  it('draws no spacer when the shorter tab still reaches the visible bottom', () => {
    const { container, getByText } = render(<Page />);
    const main = container.querySelector<HTMLElement>('#main')!;
    stubGeometry(main);
    main.scrollTop = 100;

    act(() => {
      fireEvent.click(getByText('jump'));
    });

    expect(main.querySelector('svg.scroll-hold')).toBeNull();
  });
});
