import { serviceCardLayoutSchema, serviceCardSlotOf } from '@nexa/contracts';

/** The button «بازگشت»: not a slot, always drawn, always last. */
const BACK_KEY = 'service.back_to_list';

/** Layout rows are numbered from here, above every row the runtime numbers by hand. */
const LAYOUT_ROW_BASE = 1000;
/** Above every layout row: the back button's own, final row. */
const BACK_ROW = 1_000_000;

interface Placeable {
  readonly inline?: string;
  readonly row?: number;
}

/**
 * R8-C3: the owner's arrangement of the service screen, applied to the buttons the screen
 * has ALREADY decided to draw.
 *
 * It starts from the eligible buttons and only orders, groups and hides them, so it cannot
 * show a button whose action is unavailable: a slot the layout names for which no button was
 * built draws nothing. A built button the layout does not name keeps its usual place, after
 * the named rows. «بازگشت» is last whatever the layout says, and is never hidden.
 *
 * No saved layout (null, empty rows, or a stored value this release cannot read) returns the
 * very same array, so the keyboard is byte-identical to what it was before the layout existed.
 */
export function applyServiceCardLayout<T extends Placeable>(
  buttons: readonly T[],
  stored: unknown,
): readonly T[] {
  const parsed = serviceCardLayoutSchema.safeParse(stored);
  if (!parsed.success || parsed.data.rows.length === 0) return buttons;
  const layout = parsed.data;

  const back = buttons.filter((button) => button.inline === BACK_KEY);
  const rest = buttons.filter((button) => button.inline !== BACK_KEY);
  const named = new Set(layout.rows.flat().map((entry) => entry.button));

  const placed: T[] = [];
  layout.rows.forEach((row, index) => {
    for (const entry of row) {
      if (!entry.enabled) continue;
      for (const button of rest) {
        if (button.inline !== undefined && serviceCardSlotOf(button.inline) === entry.button) {
          placed.push({ ...button, row: LAYOUT_ROW_BASE + index });
        }
      }
    }
  });
  const unnamed = rest.filter((button) => {
    const slot = button.inline === undefined ? null : serviceCardSlotOf(button.inline);
    return slot === null || !named.has(slot);
  });
  return [...placed, ...unnamed, ...back.map((button) => ({ ...button, row: BACK_ROW }))];
}
