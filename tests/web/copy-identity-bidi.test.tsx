import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Copyable, Ident, Ltr, Money } from '../../apps/web/src/ui/kit';
import { renderPage } from './harness';

/**
 * Owner revisions 7, 8 and 9 — the three ways a technical value gets mangled.
 */
describe('copying a reference', () => {
  function clipboard(): { writes: string[] } {
    const writes: string[] = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn((text: string) => {
          writes.push(text);
          return Promise.resolve();
        }),
      },
    });
    return { writes };
  }

  /**
   * The whole revision, in one assertion: what is COPIED is the full raw value,
   * whatever is displayed.
   *
   * The preview got exactly half of this — it truncated the display, showed a
   * "copied" toast, and never touched the clipboard at all.
   */
  it('copies the full value even when the display is shortened', async () => {
    const board = clipboard();
    const full = '0x8f3a19b47c2e5d6a8f0b1c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f691bc';

    renderPage(<Copyable value={full} display="0x8f3a...91bc" />);
    expect(screen.getByText('0x8f3a...91bc')).toBeInTheDocument();
    expect(screen.queryByText(full)).toBeNull();

    screen.getByRole('button', { name: 'کپی' }).click();

    await waitFor(() => expect(board.writes).toEqual([full]));
    expect(await screen.findByText('کپی شد')).toBeInTheDocument();
  });

  it('copies the value itself when nothing was shortened', async () => {
    const board = clipboard();
    renderPage(<Copyable value="01a05e35-c9ad-7e93-bef3-1ed9b55292c8" />);
    screen.getByRole('button', { name: 'کپی' }).click();
    await waitFor(() => expect(board.writes).toEqual(['01a05e35-c9ad-7e93-bef3-1ed9b55292c8']));
  });

  /**
   * A refusal is REPORTED. A silent "copied" that copied nothing is the legacy
   * pattern this codebase exists to end, and the clipboard is genuinely
   * refusable — an insecure origin has no `navigator.clipboard` at all.
   */
  it('says so when the browser refuses', async () => {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(() => Promise.reject(new Error('denied'))),
      },
    });
    renderPage(<Copyable value="abc" />);
    screen.getByRole('button', { name: 'کپی' }).click();
    expect(await screen.findByText(/کپی نشد/)).toBeInTheDocument();
    expect(screen.queryByText('کپی شد')).toBeNull();
  });

  it('says so when there is no clipboard at all', async () => {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    renderPage(<Copyable value="abc" />);
    screen.getByRole('button', { name: 'کپی' }).click();
    expect(await screen.findByText(/کپی نشد/)).toBeInTheDocument();
  });
});

describe('an identity', () => {
  /**
   * Owner revision 8 — a display name and a numeric identifier are two values.
   *
   * `کیان شریفی776737141` is what happens when they are printed adjacent with
   * nothing between them: the reader cannot tell where one ends.
   */
  it('separates the name from the identifier with a real character', () => {
    const { container } = renderPage(<Ident name="کیان شریفی" id="776737141" />);
    const text = container.textContent ?? '';
    expect(text).not.toContain('کیان شریفی776737141');
    expect(text).toContain('—');
    // Both values survive intact.
    expect(screen.getByText('کیان شریفی')).toBeInTheDocument();
    expect(screen.getByText('776737141')).toBeInTheDocument();
  });

  it('renders a name alone without a dangling separator', () => {
    const { container } = renderPage(<Ident name="کیان شریفی" id={null} />);
    expect(container.textContent).toBe('کیان شریفی');
  });

  it('isolates the identifier so it cannot reorder the text around it', () => {
    const { container } = renderPage(<Ident name="کیان شریفی" id="776737141" />);
    const isolated = container.querySelector('.ltr');
    expect(isolated).not.toBeNull();
    expect(isolated?.textContent).toBe('776737141');
  });
});

describe('bidi isolation', () => {
  /**
   * Owner revision 7 — `direction: ltr` alone is not enough.
   *
   * Without `unicode-bidi: isolate` the algorithm still resolves the Latin run
   * against its NEIGHBOURS, so `30 روز • 15 GB` comes out reordered. The class
   * carries both, and the stylesheet is where the second half lives.
   */
  it('marks a technical run as an isolated left-to-right island', () => {
    const { container } = renderPage(<Ltr>15 GB</Ltr>);
    const span = container.querySelector('span');
    expect(span?.className.split(' ')).toContain('ltr');
  });

  it('gives money its own isolate, so an amount cannot drag the sentence', () => {
    const { container } = renderPage(
      <Money value={{ amountMinor: '13125012', currency: 'IRT' }} />,
    );
    expect(container.querySelector('.money')).not.toBeNull();
    expect(container.textContent).toContain('13,125,012');
    expect(container.textContent).toContain('تومان');
  });

  it('carries the full amount in a title, so a clipped cell is still readable', () => {
    const { container } = renderPage(
      <Money value={{ amountMinor: '13125012', currency: 'IRR' }} />,
    );
    expect(container.querySelector('.money')?.getAttribute('title')).toBe('13,125,012 ریال');
  });
});
