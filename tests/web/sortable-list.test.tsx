import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  DRAG_START_PX,
  SortableList,
  insertionAt,
  reorderedIndex,
} from '../../apps/web/src/ui/sortable-list';
import { t } from '../../apps/web/src/i18n/web.fa';

/**
 * The kit's drag-and-drop list (PR-2): pure arithmetic first, then the pointer drag and the
 * keyboard move on a real DOM. The rows' boxes are stubbed (jsdom lays nothing out): three
 * rows, 100 px apart and 40 px tall.
 */

describe('the drop arithmetic', () => {
  const rows = [0, 100, 200].map((top) => ({ top, height: 40 }));

  it('puts the insertion before the first row whose middle is below the pointer', () => {
    expect(insertionAt(rows, -50)).toBe(0);
    expect(insertionAt(rows, 19)).toBe(0);
    expect(insertionAt(rows, 21)).toBe(1);
    expect(insertionAt(rows, 119)).toBe(1);
    expect(insertionAt(rows, 150)).toBe(2);
    expect(insertionAt(rows, 400)).toBe(3);
  });

  it('turns an insertion position into the final index of the moved row', () => {
    expect(reorderedIndex(0, 3)).toBe(2);
    expect(reorderedIndex(0, 1)).toBe(0);
    expect(reorderedIndex(2, 0)).toBe(0);
    expect(reorderedIndex(1, 2)).toBe(1);
  });
});

const ITEMS = ['الف', 'ب', 'پ'];

function mount(onReorder = vi.fn(), disabled = false) {
  render(
    <SortableList
      items={ITEMS}
      itemKey={(item) => item}
      label="فهرست"
      disabled={disabled}
      onReorder={onReorder}
      renderItem={(item) => <span>{item}</span>}
    />,
  );
  const items = Array.from(document.querySelectorAll<HTMLLIElement>('.sortable-item'));
  items.forEach((item, index) => {
    item.getBoundingClientRect = () => ({ top: index * 100, height: 40 }) as DOMRect;
  });
  return { onReorder, grips: screen.getAllByRole('button', { name: t('web.sortable_grip') }) };
}

describe('the sortable list', () => {
  it('reorders by dragging a grip past the threshold and releasing over another row', () => {
    const { onReorder, grips } = mount();
    const grip = grips[0] as HTMLElement;
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientX: 5, clientY: 10 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 5, clientY: 260 });
    // The drop line is drawn over the layout: the last row carries it.
    expect(document.querySelector('.sortable-item.is-drop-after')).not.toBeNull();
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 5, clientY: 260 });
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(0, 2);
  });

  it('treats a press that barely moves as a tap: nothing is reordered', () => {
    const { onReorder, grips } = mount();
    const grip = grips[1] as HTMLElement;
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientX: 5, clientY: 110 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 5, clientY: 110 + DRAG_START_PX - 2 });
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 5, clientY: 230 });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('changes nothing on a cancelled pointer, and nothing when dropped where it was', () => {
    const { onReorder, grips } = mount();
    const grip = grips[1] as HTMLElement;
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientX: 5, clientY: 110 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 5, clientY: 250 });
    fireEvent.pointerCancel(grip, { pointerId: 1 });
    expect(onReorder).not.toHaveBeenCalled();
    fireEvent.pointerDown(grip, { pointerId: 2, button: 0, clientX: 5, clientY: 110 });
    fireEvent.pointerMove(grip, { pointerId: 2, clientX: 5, clientY: 130 });
    fireEvent.pointerUp(grip, { pointerId: 2, clientX: 5, clientY: 130 });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('moves a row with the arrow keys on its grip and stops at the ends', () => {
    const { onReorder, grips } = mount();
    fireEvent.keyDown(grips[0] as HTMLElement, { key: 'ArrowUp' });
    expect(onReorder).not.toHaveBeenCalled();
    fireEvent.keyDown(grips[0] as HTMLElement, { key: 'ArrowDown' });
    expect(onReorder).toHaveBeenLastCalledWith(0, 1);
    fireEvent.keyDown(grips[2] as HTMLElement, { key: 'ArrowUp' });
    expect(onReorder).toHaveBeenLastCalledWith(2, 1);
    fireEvent.keyDown(grips[2] as HTMLElement, { key: 'ArrowDown' });
    expect(onReorder).toHaveBeenCalledTimes(2);
  });

  it('does nothing while disabled', () => {
    const { onReorder, grips } = mount(vi.fn(), true);
    expect(grips[0]).toBeDisabled();
    fireEvent.keyDown(grips[0] as HTMLElement, { key: 'ArrowDown' });
    expect(onReorder).not.toHaveBeenCalled();
  });
});
