import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAIN_MENU_LAYOUT,
  explicitFromLegacy,
  type ExplicitMainMenu,
} from '@nexa/contracts';
import { moveItem } from '../../apps/web/src/ui/layout-dnd';
import { poolOf, withDroppedRows } from '../../apps/web/src/pages/bot-buttons/model';

/**
 * The main menu's drag-and-drop is the kit's `LayoutDnd`; the builder only turns the rows it
 * hands back into a draft. This pins that translation: a drop is a layout, the free box is
 * every button no row names (its configuration kept), and a drop that changes nothing is null.
 * `bot-buttons-builder.test.tsx` drives the same rules through the page.
 */
const layout: ExplicitMainMenu = {
  ...explicitFromLegacy(DEFAULT_MAIN_MENU_LAYOUT),
  rows: [['catalog', 'services'], ['wallet', 'help'], ['apps']],
};
const asDnd = (l: ExplicitMainMenu) => ({ rows: l.rows, free: poolOf(l) });

describe('the draft after a drop', () => {
  it('takes the rows the drop left, and the buttons no row names become the free box', () => {
    const next = moveItem(asDnd(layout), 'help', { kind: 'free' });
    expect(next?.rows).toEqual([['catalog', 'services'], ['wallet'], ['apps']]);
    const draft = withDroppedRows(layout, (next?.rows ?? []) as never);
    expect(draft.rows).toEqual([['catalog', 'services'], ['wallet'], ['apps']]);
    expect(poolOf(draft)).toContain('help');
    // Its configuration is kept for when it comes back.
    expect(draft.buttons.some((config) => config.button === 'help')).toBe(true);
  });

  it('answers null for a drop that leaves the layout as it is', () => {
    expect(
      moveItem(asDnd(layout), 'services', { kind: 'item', id: 'catalog', side: 'after' }),
    ).toBeNull();
    expect(moveItem(asDnd(layout), 'apps', { kind: 'new-row' })).toBeNull();
  });

  it('keeps the draft v1 while no custom button is placed', () => {
    const next = moveItem(asDnd(layout), 'apps', { kind: 'row-end', row: 0 });
    expect(withDroppedRows(layout, (next?.rows ?? []) as never).v).toBe(1);
  });
});
