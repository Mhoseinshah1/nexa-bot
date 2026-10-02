import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXPLICIT_MAIN_MENU, type ExplicitMainMenu } from '@nexa/contracts';
import {
  DRAG_THRESHOLD_PX,
  autoScrollStep,
  passedThreshold,
  targetAtPoint,
} from '../../apps/web/src/pages/bot-buttons/dnd';
import {
  applyDrop,
  chipSide,
  dropHintOf,
  hintedRow,
  moveRow,
  placeAtRowEnd,
  placeBefore,
  placeInNewRow,
  removeToPool,
} from '../../apps/web/src/pages/bot-buttons/model';

/**
 * The builder's drag rules as PURE functions (owner, 2026-10-02): what a drop does, when it
 * does nothing, where its placeholder goes, and when a press becomes a drag. The page's
 * pointer code only feeds these; `bot-buttons-builder.test.tsx` drives them through it.
 */

const layout: ExplicitMainMenu = {
  ...DEFAULT_EXPLICIT_MAIN_MENU,
  rows: [['catalog', 'services'], ['wallet', 'help'], ['apps']],
};

describe('applyDrop — every drop is one of the primitives, and a no-op is null', () => {
  it('maps each target to the primitive the Inspector and the keyboard call', () => {
    expect(
      applyDrop(layout, { kind: 'button', id: 'help' }, { kind: 'chip', id: 'catalog' }),
    ).toEqual(placeBefore(layout, 'help', 'catalog'));
    expect(applyDrop(layout, { kind: 'button', id: 'catalog' }, { kind: 'row', row: 2 })).toEqual(
      placeAtRowEnd(layout, 'catalog', 2),
    );
    expect(applyDrop(layout, { kind: 'button', id: 'wallet' }, { kind: 'gap', at: 0 })).toEqual(
      placeInNewRow(layout, 'wallet', 0),
    );
    expect(applyDrop(layout, { kind: 'button', id: 'apps' }, { kind: 'pool' })).toEqual(
      removeToPool(layout, 'apps'),
    );
    expect(applyDrop(layout, { kind: 'row', row: 2 }, { kind: 'gap', at: 0 })).toEqual(
      moveRow(layout, 2, 0),
    );
  });

  it('answers null for every drop that would leave the layout as it is (no accidental reorder)', () => {
    const none = [
      // Onto itself.
      [
        { kind: 'button', id: 'catalog' },
        { kind: 'chip', id: 'catalog' },
      ],
      // Before the key that already follows it.
      [
        { kind: 'button', id: 'catalog' },
        { kind: 'chip', id: 'services' },
      ],
      // To the end of the row it already ends.
      [
        { kind: 'button', id: 'services' },
        { kind: 'row', row: 0 },
      ],
      // A key alone on its row, onto either gap beside that row.
      [
        { kind: 'button', id: 'apps' },
        { kind: 'gap', at: 2 },
      ],
      [
        { kind: 'button', id: 'apps' },
        { kind: 'gap', at: 3 },
      ],
      // A pooled key onto the pool.
      [{ kind: 'button', id: 'trial' }, { kind: 'pool' }],
      // A row onto the gaps around itself.
      [
        { kind: 'row', row: 1 },
        { kind: 'gap', at: 1 },
      ],
      [
        { kind: 'row', row: 1 },
        { kind: 'gap', at: 2 },
      ],
      // A row onto anything but a gap is not a move.
      [
        { kind: 'row', row: 1 },
        { kind: 'chip', id: 'catalog' },
      ],
      [
        { kind: 'row', row: 1 },
        { kind: 'row', row: 0 },
      ],
      [{ kind: 'row', row: 1 }, { kind: 'pool' }],
    ] as const;
    for (const [source, target] of none) {
      expect(applyDrop(layout, source, target), JSON.stringify([source, target])).toBeNull();
      expect(dropHintOf(layout, source, target)).toBeNull();
    }
  });
});

describe('dropHintOf — the insertion placeholder and the target row', () => {
  it('names the key a drop goes before and the row it lands in', () => {
    const hint = dropHintOf(layout, { kind: 'button', id: 'apps' }, { kind: 'chip', id: 'help' });
    expect(hint).toEqual({ kind: 'before', id: 'help', row: 1 });
    expect(hintedRow(hint)).toBe(1);
  });

  it('names a row end, a new row and the pool; only the first is a target ROW', () => {
    const rowEnd = dropHintOf(layout, { kind: 'button', id: 'apps' }, { kind: 'row', row: 0 });
    expect(rowEnd).toEqual({ kind: 'row-end', row: 0 });
    expect(hintedRow(rowEnd)).toBe(0);
    const gap = dropHintOf(layout, { kind: 'button', id: 'catalog' }, { kind: 'gap', at: 3 });
    expect(gap).toEqual({ kind: 'new-row', at: 3 });
    expect(hintedRow(gap)).toBeNull();
    const pool = dropHintOf(layout, { kind: 'button', id: 'catalog' }, { kind: 'pool' });
    expect(pool).toEqual({ kind: 'pool' });
    expect(hintedRow(pool)).toBeNull();
  });

  it('shows nothing without a drag or a target', () => {
    expect(dropHintOf(layout, null, { kind: 'pool' })).toBeNull();
    expect(dropHintOf(layout, { kind: 'button', id: 'apps' }, null)).toBeNull();
  });
});

describe('chipSide — before or after a key, in reading order, without flicker', () => {
  const rect = { left: 100, width: 100 };

  it('reads the right half as the start in Persian, and the left half in a left-to-right page', () => {
    expect(chipSide(rect, 190, true, null)).toBe('before');
    expect(chipSide(rect, 110, true, null)).toBe('after');
    expect(chipSide(rect, 110, false, null)).toBe('before');
    expect(chipSide(rect, 190, false, null)).toBe('after');
  });

  it('keeps the previous answer inside the dead band around the middle', () => {
    expect(chipSide(rect, 147, true, 'before')).toBe('before');
    expect(chipSide(rect, 153, true, 'after')).toBe('after');
    // Outside the band the pointer decides again.
    expect(chipSide(rect, 140, true, 'before')).toBe('after');
    expect(chipSide(rect, 160, true, 'after')).toBe('before');
  });
});

describe('the press-to-drag threshold and the edge auto-scroll', () => {
  it('a press becomes a drag only after the pointer travels the threshold', () => {
    const start = { x: 50, y: 50 };
    expect(passedThreshold(start, start)).toBe(false);
    expect(passedThreshold(start, { x: 53, y: 53 })).toBe(false);
    expect(passedThreshold(start, { x: 50 + DRAG_THRESHOLD_PX, y: 50 })).toBe(true);
    expect(passedThreshold(start, { x: 50, y: 50 - DRAG_THRESHOLD_PX })).toBe(true);
  });

  it('scrolls up near the top, down near the bottom, faster closer to the edge, never in between', () => {
    expect(autoScrollStep(400, 800)).toBe(0);
    expect(autoScrollStep(56, 800)).toBe(0);
    expect(autoScrollStep(30, 800)).toBeLessThan(0);
    expect(autoScrollStep(0, 800)).toBeLessThan(autoScrollStep(30, 800));
    expect(autoScrollStep(770, 800)).toBeGreaterThan(0);
    expect(autoScrollStep(800, 800)).toBeGreaterThan(autoScrollStep(770, 800));
    expect(autoScrollStep(10, 0)).toBe(0);
  });
});

describe('targetAtPoint — a key resolved to the side the pointer is on', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function rowOf(ids: readonly string[]): HTMLElement {
    document.body.innerHTML = `<div data-drop="row" data-row="0">${ids
      .map((id) => `<div data-drop="chip" data-id="${id}"><span class="label">${id}</span></div>`)
      .join('')}<span class="warn"></span></div>`;
    for (const chip of document.querySelectorAll<HTMLElement>('[data-drop="chip"]')) {
      chip.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 30 }) as DOMRect;
    }
    return document.body.firstElementChild as HTMLElement;
  }

  it('before the key on its start half, before the NEXT key on its end half, row end after the last', () => {
    rowOf(['catalog', 'services']);
    const label = (id: string) => document.querySelector(`[data-id="${id}"] .label`) as HTMLElement;
    expect(targetAtPoint(label('catalog'), 90, true, null)).toEqual({
      target: { kind: 'chip', id: 'catalog' },
      side: 'before',
    });
    expect(targetAtPoint(label('catalog'), 10, true, null)).toEqual({
      target: { kind: 'chip', id: 'services' },
      side: 'after',
    });
    expect(targetAtPoint(label('services'), 10, true, null)).toEqual({
      target: { kind: 'row', row: 0 },
      side: 'after',
    });
  });

  it('passes a non-key target through untouched', () => {
    const row = rowOf(['catalog']);
    expect(targetAtPoint(row.querySelector('.warn'), 10, true, 'after')).toEqual({
      target: { kind: 'row', row: 0 },
      side: null,
    });
    expect(targetAtPoint(null, 10, true, null)).toEqual({ target: null, side: null });
  });
});
