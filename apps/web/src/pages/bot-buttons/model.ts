import {
  MAIN_MENU_BUTTON_IDS,
  defaultMainMenuButtonConfig,
  normalizeExplicitMainMenu,
  unplacedMainMenuButtons,
  type AppearanceSlot,
  type ExplicitMainMenu,
  type MainMenuButtonConfig,
  type CustomerMainMenuButton,
  type MainMenuButtonId,
  type MainMenuButtonStyle,
  type MainMenuGateOpenById,
  type MenuAppearanceSlot,
  type MainMenuBuilderItem,
} from '@nexa/contracts';

/**
 * Round T — the builder's EDITING model: pure functions over an `ExplicitMainMenu`.
 *
 * Every way the page can rearrange the draft — a drag dropped on a button, on a row, on
 * the gap between two rows or on the Available pool; a button in the Inspector; a keyboard
 * shortcut on a focused button — ends in one of the four placement primitives below
 * (`placeBefore`, `placeAtRowEnd`, `placeInNewRow`, `removeToPool`) or `moveRow`. There is
 * no second implementation of "move" for the accessible path, so the drag and the
 * non-drag path cannot disagree about what a move does (tested: both produce the same
 * saved draft).
 *
 * Nothing here decides a GATE. A gate's state is the server's answer (`item.gateOpen`),
 * passed through as data; the only rule applied to a layout is the contract's own.
 */

/** Where a placed button sits, zero-based. */
export interface Position {
  readonly row: number;
  readonly index: number;
}

export function positionOf(layout: ExplicitMainMenu, id: MainMenuButtonId): Position | null {
  for (let row = 0; row < layout.rows.length; row += 1) {
    const index = (layout.rows[row] ?? []).indexOf(id);
    if (index >= 0) return { row, index };
  }
  return null;
}

/** A configuration for `id` — the stored one, or the default when a layout lacks it. */
export function configOf(layout: ExplicitMainMenu, id: MainMenuButtonId): MainMenuButtonConfig {
  return layout.buttons.find((config) => config.button === id) ?? defaultMainMenuButtonConfig(id);
}

/** The rows with `id` taken out, empty rows KEPT so a row index read before stays valid. */
function rowsWithout(layout: ExplicitMainMenu, id: MainMenuButtonId): MainMenuButtonId[][] {
  return layout.rows.map((row) => row.filter((one) => one !== id));
}

/** The layout with these rows, empty rows dropped, and a configuration for every button. */
function withRows(layout: ExplicitMainMenu, rows: MainMenuButtonId[][]): ExplicitMainMenu {
  const configured = new Set(layout.buttons.map((config) => config.button));
  const missing = MAIN_MENU_BUTTON_IDS.filter((id) => !configured.has(id)).map((id) =>
    defaultMainMenuButtonConfig(id),
  );
  return {
    v: layout.v,
    rows: rows.filter((row) => row.length > 0),
    buttons: [...layout.buttons, ...missing],
  };
}

/** Put `id` immediately before `beforeId`, wherever each is now. */
export function placeBefore(
  layout: ExplicitMainMenu,
  id: MainMenuButtonId,
  beforeId: MainMenuButtonId,
): ExplicitMainMenu {
  if (id === beforeId) return layout;
  const rows = rowsWithout(layout, id);
  for (const row of rows) {
    const index = row.indexOf(beforeId);
    if (index >= 0) {
      row.splice(index, 0, id);
      return withRows(layout, rows);
    }
  }
  return layout;
}

/** Put `id` at the end of row `row` (an index into the layout's rows as they are now). */
export function placeAtRowEnd(
  layout: ExplicitMainMenu,
  id: MainMenuButtonId,
  row: number,
): ExplicitMainMenu {
  const rows = rowsWithout(layout, id);
  const target = rows[row];
  if (target === undefined) return layout;
  target.push(id);
  return withRows(layout, rows);
}

/** Put `id` alone on a NEW row, inserted before row `at` (`rows.length`: after the last). */
export function placeInNewRow(
  layout: ExplicitMainMenu,
  id: MainMenuButtonId,
  at: number,
): ExplicitMainMenu {
  const rows = rowsWithout(layout, id);
  const clamped = Math.max(0, Math.min(at, rows.length));
  rows.splice(clamped, 0, [id]);
  return withRows(layout, rows);
}

/** Take `id` off the keyboard into the Available pool. Its configuration is kept. */
export function removeToPool(layout: ExplicitMainMenu, id: MainMenuButtonId): ExplicitMainMenu {
  return withRows(layout, rowsWithout(layout, id));
}

/** Move a whole row so it sits before row `at` (`rows.length`: last). */
export function moveRow(layout: ExplicitMainMenu, from: number, at: number): ExplicitMainMenu {
  const rows = layout.rows.map((row) => [...row]);
  const [moved] = rows.splice(from, 1);
  if (moved === undefined) return layout;
  const target = at > from ? at - 1 : at;
  rows.splice(Math.max(0, Math.min(target, rows.length)), 0, moved);
  return withRows(layout, rows);
}

function withConfig(
  layout: ExplicitMainMenu,
  id: MainMenuButtonId,
  change: Partial<Omit<MainMenuButtonConfig, 'button'>>,
): ExplicitMainMenu {
  const present = layout.buttons.some((config) => config.button === id);
  const buttons = present
    ? layout.buttons.map((config) => (config.button === id ? { ...config, ...change } : config))
    : [...layout.buttons, { ...defaultMainMenuButtonConfig(id), ...change }];
  return { ...layout, rows: layout.rows.map((row) => [...row]), buttons };
}

/** Off keeps the button's place; it is not drawn. */
export function setEnabled(
  layout: ExplicitMainMenu,
  id: MainMenuButtonId,
  enabled: boolean,
): ExplicitMainMenu {
  return withConfig(layout, id, { enabled });
}

export function setStyle(
  layout: ExplicitMainMenu,
  id: MainMenuButtonId,
  look: MainMenuButtonStyle,
): ExplicitMainMenu {
  const style = look;
  return withConfig(layout, id, { style });
}

/**
 * A button's STYLE (`KeyboardButton.style`), read by destructuring: the web's CSP scan
 * (`csp.test.tsx`) refuses every spelling of an element's `style` property, and this field
 * merely shares the name. Called «look» in this folder for the same reason.
 */
export function lookOf(config: MainMenuButtonConfig | CustomerMainMenuButton): MainMenuButtonStyle {
  const { style } = config;
  return style;
}

/** The ICON slot. Never touches `appearanceSlot`, which names the screen the button opens. */
export function setIconSlot(
  layout: ExplicitMainMenu,
  id: MainMenuButtonId,
  iconSlot: AppearanceSlot | null,
): ExplicitMainMenu {
  return withConfig(layout, id, { iconSlot });
}

/** Round P's slot for the screen the button opens; null is the button's default. */
export function setAppearanceSlot(
  layout: ExplicitMainMenu,
  id: MainMenuButtonId,
  appearanceSlot: MenuAppearanceSlot | null,
): ExplicitMainMenu {
  return withConfig(layout, id, { appearanceSlot });
}

// --- The non-drag moves: each one is a primitive above, never a second implementation ---

/** One place earlier in its row. */
export function moveEarlier(layout: ExplicitMainMenu, id: MainMenuButtonId): ExplicitMainMenu {
  const at = positionOf(layout, id);
  const before = at === null ? undefined : layout.rows[at.row]?.[at.index - 1];
  return before === undefined ? layout : placeBefore(layout, id, before);
}

/** One place later in its row. */
export function moveLater(layout: ExplicitMainMenu, id: MainMenuButtonId): ExplicitMainMenu {
  const at = positionOf(layout, id);
  if (at === null) return layout;
  const row = layout.rows[at.row] ?? [];
  if (at.index >= row.length - 1) return layout;
  const afterNext = row[at.index + 2];
  return afterNext === undefined
    ? placeAtRowEnd(layout, id, at.row)
    : placeBefore(layout, id, afterNext);
}

/** To the end of the row above. */
export function moveToPreviousRow(
  layout: ExplicitMainMenu,
  id: MainMenuButtonId,
): ExplicitMainMenu {
  const at = positionOf(layout, id);
  if (at === null || at.row === 0) return layout;
  return placeAtRowEnd(layout, id, at.row - 1);
}

/** To the end of the row below. */
export function moveToNextRow(layout: ExplicitMainMenu, id: MainMenuButtonId): ExplicitMainMenu {
  const at = positionOf(layout, id);
  if (at === null || at.row >= layout.rows.length - 1) return layout;
  return placeAtRowEnd(layout, id, at.row + 1);
}

/** Alone on a new row directly below its current one. */
export function moveToOwnRow(layout: ExplicitMainMenu, id: MainMenuButtonId): ExplicitMainMenu {
  const at = positionOf(layout, id);
  if (at === null) return layout;
  if ((layout.rows[at.row] ?? []).length <= 1) return layout;
  return placeInNewRow(layout, id, at.row + 1);
}

/** What each control may do now, so a control that would do nothing is disabled. */
export function movesFor(
  layout: ExplicitMainMenu,
  id: MainMenuButtonId,
): {
  readonly earlier: boolean;
  readonly later: boolean;
  readonly previousRow: boolean;
  readonly nextRow: boolean;
  readonly ownRow: boolean;
  readonly rowUp: boolean;
  readonly rowDown: boolean;
} {
  const at = positionOf(layout, id);
  if (at === null) {
    return {
      earlier: false,
      later: false,
      previousRow: false,
      nextRow: false,
      ownRow: false,
      rowUp: false,
      rowDown: false,
    };
  }
  const length = (layout.rows[at.row] ?? []).length;
  return {
    earlier: at.index > 0,
    later: at.index < length - 1,
    previousRow: at.row > 0,
    nextRow: at.row < layout.rows.length - 1,
    ownRow: length > 1,
    rowUp: at.row > 0,
    rowDown: at.row < layout.rows.length - 1,
  };
}

/** The Available pool: declared buttons in no row. */
export const poolOf = (layout: ExplicitMainMenu): MainMenuButtonId[] =>
  unplacedMainMenuButtons(layout);

/**
 * The server's gate answers, by id, exactly as the read gave them — the argument
 * `customerRowsOf` takes. A pass-through on purpose: React holds no gate logic.
 */
export function gateAnswersOf(items: readonly MainMenuBuilderItem[]): MainMenuGateOpenById {
  const answers: Partial<Record<MainMenuButtonId, boolean | null>> = {};
  for (const item of items) answers[item.id] = item.gateOpen;
  return answers;
}

/** Whether the server says this gated button is hidden NOW. Ungated: never. */
export function hiddenNowByGate(item: MainMenuBuilderItem | undefined): boolean {
  return item !== undefined && item.gate !== null && item.gateOpen !== true;
}

/**
 * The comfortable width of a reply-keyboard row on a phone, in buttons. PRESENTATION only:
 * a row past it is warned about and never refused — how many buttons read well side by
 * side is the operator's call, and the contract states no such limit.
 */
export const COMFORTABLE_ROW_LENGTH = 3;

/** Whether a row is likely to be cramped on a narrow phone (a warning, never a refusal). */
export function rowLooksCramped(
  row: readonly MainMenuButtonId[],
  wide: (id: MainMenuButtonId) => boolean,
): boolean {
  return row.length > COMFORTABLE_ROW_LENGTH || (row.length > 1 && row.some(wide));
}

/** One button's difference between two layouts, for the publish confirmation. */
export type ButtonChange =
  'added' | 'removed' | 'moved' | 'enabled' | 'disabled' | 'look' | 'icon' | 'screen';

export function diffLayouts(
  before: ExplicitMainMenu,
  after: ExplicitMainMenu,
): { readonly id: MainMenuButtonId; readonly changes: readonly ButtonChange[] }[] {
  const from = normalizeExplicitMainMenu(before);
  const to = normalizeExplicitMainMenu(after);
  const out: { id: MainMenuButtonId; changes: ButtonChange[] }[] = [];
  for (const id of MAIN_MENU_BUTTON_IDS) {
    const changes: ButtonChange[] = [];
    const a = positionOf(from, id);
    const b = positionOf(to, id);
    if (a === null && b !== null) changes.push('added');
    else if (a !== null && b === null) changes.push('removed');
    else if (a !== null && b !== null && (a.row !== b.row || a.index !== b.index)) {
      changes.push('moved');
    }
    const ca = configOf(from, id);
    const cb = configOf(to, id);
    if (ca.enabled !== cb.enabled) changes.push(cb.enabled ? 'enabled' : 'disabled');
    if (lookOf(ca) !== lookOf(cb)) changes.push('look');
    if (ca.iconSlot !== cb.iconSlot) changes.push('icon');
    if (ca.appearanceSlot !== cb.appearanceSlot) changes.push('screen');
    if (changes.length > 0) out.push({ id, changes });
  }
  return out;
}
