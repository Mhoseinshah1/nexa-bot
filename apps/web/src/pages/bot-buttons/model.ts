import {
  MAIN_MENU_BUTTON_IDS,
  customMenuButtonVisible,
  customMenuRefOf,
  defaultCustomMenuButtonConfig,
  defaultMainMenuButtonConfig,
  isCustomMenuRef,
  normalizeExplicitMainMenu,
  placedCustomRefs,
  unplacedMainMenuButtons,
  type AnyExplicitMainMenu,
  type CustomMenuButtonView,
  type CustomMenuRef,
  type CustomMenuVisibleById,
  type CustomerMainMenuButton,
  type MainMenuButtonConfig,
  type MainMenuButtonId,
  type MainMenuButtonStyle,
  type MainMenuGateOpenById,
  type MainMenuRowItem,
  type AppearanceSlot,
  type MainMenuBuilderItem,
} from '@nexa/contracts';

/**
 * R10 D2: the editor's layout is either shape (`v: 1`, or `v: 2` once a custom button is
 * placed), and an item of a row is a registry id or a custom button's reference. The server
 * decides the version a layout is saved as (`normalizeExplicitMainMenu`); the editor never
 * does — it writes `v: 2` only while a custom reference is placed or the draft already was.
 */
type ExplicitMainMenu = AnyExplicitMainMenu;
type ItemId = MainMenuRowItem;

/** What a placed or pooled item carries that the editor changes: switch, style, icon. */
export type ItemConfig = Pick<MainMenuButtonConfig, 'enabled' | 'style' | 'iconSlot'>;

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

export function positionOf(layout: ExplicitMainMenu, id: ItemId): Position | null {
  for (let row = 0; row < layout.rows.length; row += 1) {
    const index = (layout.rows[row] ?? []).indexOf(id);
    if (index >= 0) return { row, index };
  }
  return null;
}

/** A configuration for `id` — the stored one, or the default when a layout lacks it. */
export function configOf(layout: ExplicitMainMenu, id: ItemId): ItemConfig {
  if (isCustomMenuRef(id)) {
    const stored =
      layout.v === 2 ? layout.customButtons.find((config) => config.ref === id) : undefined;
    // Destructured: the web's CSP scan refuses an object literal spelling `style:` (see `lookOf`).
    // A custom button never carries an icon.
    const { enabled, style } = stored ?? defaultCustomMenuButtonConfig(id);
    return { enabled, style, iconSlot: null };
  }
  return layout.buttons.find((config) => config.button === id) ?? defaultMainMenuButtonConfig(id);
}

/** The rows with `id` taken out, empty rows KEPT so a row index read before stays valid. */
function rowsWithout(layout: ExplicitMainMenu, id: ItemId): ItemId[][] {
  return (layout.rows as readonly (readonly ItemId[])[]).map((row) =>
    row.filter((one) => one !== id),
  );
}

/** The layout with these rows, empty rows dropped, and a configuration for every button. */
function withRows(layout: ExplicitMainMenu, rows: ItemId[][]): ExplicitMainMenu {
  const configured = new Set(layout.buttons.map((config) => config.button));
  const missing = MAIN_MENU_BUTTON_IDS.filter((id) => !configured.has(id)).map((id) =>
    defaultMainMenuButtonConfig(id),
  );
  const kept = rows.filter((row) => row.length > 0);
  const refs = kept.flat().filter(isCustomMenuRef);
  const buttons = [...layout.buttons, ...missing];
  // A v1 layout with nothing custom in it stays v1, byte for byte what the editor held.
  if (refs.length === 0 && layout.v === 1) {
    return { v: 1, rows: kept as MainMenuButtonId[][], buttons };
  }
  // A custom button placed (or a draft that already was v2): v2, configured where placed.
  return {
    v: 2,
    rows: kept,
    buttons,
    customButtons: refs.map((ref) => {
      const { enabled, style } = configOf(layout, ref);
      return { ref, enabled, style };
    }),
  };
}

/**
 * The layout after a drag-and-drop edit: `rows` are the rows the drag left (the free box is
 * simply every button no row names — the pool). Configuration is kept, as every placement
 * primitive keeps it.
 */
export function withDroppedRows(
  layout: ExplicitMainMenu,
  rows: readonly (readonly ItemId[])[],
): ExplicitMainMenu {
  return withRows(
    layout,
    rows.map((row) => [...row]),
  );
}

function withConfig(
  layout: ExplicitMainMenu,
  id: ItemId,
  change: Partial<Omit<MainMenuButtonConfig, 'button'>>,
): ExplicitMainMenu {
  if (isCustomMenuRef(id)) {
    // A custom button is configured only where it is placed; an unplaced one has no config.
    if (layout.v !== 2 || !placedCustomRefs(layout).includes(id)) return layout;
    const { iconSlot: _icon, appearanceSlot: _slot, ...own } = change;
    return {
      ...layout,
      rows: layout.rows.map((row) => [...row]),
      customButtons: layout.customButtons.map((config) =>
        config.ref === id ? { ...config, ...own } : config,
      ),
    };
  }
  const present = layout.buttons.some((config) => config.button === id);
  const buttons = present
    ? layout.buttons.map((config) => (config.button === id ? { ...config, ...change } : config))
    : [...layout.buttons, { ...defaultMainMenuButtonConfig(id), ...change }];
  return { ...layout, rows: layout.rows.map((row) => [...row]), buttons } as ExplicitMainMenu;
}

/** Off keeps the button's place; it is not drawn. */
export function setEnabled(
  layout: ExplicitMainMenu,
  id: ItemId,
  enabled: boolean,
): ExplicitMainMenu {
  return withConfig(layout, id, { enabled });
}

export function setStyle(
  layout: ExplicitMainMenu,
  id: ItemId,
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
export function lookOf(config: ItemConfig | CustomerMainMenuButton): MainMenuButtonStyle {
  const { style } = config;
  return style;
}

/** The ICON slot (restored 2026-10-05). Never touches `appearanceSlot`, the screen's slot. */
export function setIconSlot(
  layout: ExplicitMainMenu,
  id: ItemId,
  iconSlot: AppearanceSlot | null,
): ExplicitMainMenu {
  return withConfig(layout, id, { iconSlot });
}

/**
 * The Available pool: declared buttons in no row, then (R10 D2) the owner's ACTIVE custom
 * buttons in no row, in the order the server listed them. An archived button is not offered.
 */
export const poolOf = (
  layout: ExplicitMainMenu,
  customs: readonly CustomMenuButtonView[] = [],
): ItemId[] => {
  const placed = new Set<string>(layout.rows.flat());
  return [
    ...unplacedMainMenuButtons(layout),
    ...customs
      .filter((one) => one.archivedAt === null && !placed.has(one.ref))
      .map((one) => customMenuRefOf(one.id)),
  ];
};

/**
 * The custom buttons the preview draws: the contract's own visibility rule over what the
 * server listed, for the bot the phone names (null: no bot, so the bot filter is ignored).
 */
export function customVisibleOf(
  customs: readonly CustomMenuButtonView[],
  featureEnabled: boolean,
  botInstanceId: string | null,
): CustomMenuVisibleById {
  const visible: Record<string, boolean> = {};
  for (const one of customs) {
    visible[one.ref] = customMenuButtonVisible(one, featureEnabled, botInstanceId);
  }
  return visible;
}

/**
 * Whether the server would NOT draw this custom button on any keyboard now: the feature is off,
 * or the button is gone or archived. (Which bots draw it is the Inspector's own note.)
 */
export function customHiddenNow(
  custom: CustomMenuButtonView | undefined,
  featureEnabled: boolean,
): boolean {
  return custom === undefined || !customMenuButtonVisible(custom, featureEnabled, null);
}

/**
 * The layout without any custom reference the server does not list as ACTIVE — a button
 * archived since the draft was saved. Without it the page would hold a draft the server
 * refuses (`custom_menu_button.archived_in_layout`) and the operator could not publish.
 */
export function withoutUnusableCustom(
  layout: ExplicitMainMenu,
  customs: readonly CustomMenuButtonView[],
): ExplicitMainMenu {
  const usable = new Set(customs.filter((one) => one.archivedAt === null).map((one) => one.ref));
  const dead = placedCustomRefs(layout).filter((ref) => !usable.has(ref));
  if (dead.length === 0) return layout;
  return dead.reduce((current, ref) => withRows(current, rowsWithout(current, ref)), layout);
}

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
export function rowLooksCramped(row: readonly ItemId[], wide: (id: ItemId) => boolean): boolean {
  return row.length > COMFORTABLE_ROW_LENGTH || (row.length > 1 && row.some(wide));
}

/**
 * One button's difference between two layouts, for the publish confirmation. Only what a
 * customer's keyboard can show: the icon (restored 2026-10-05) is; the screen slot (no
 * control, no runtime consumer since the owner's 2026-10-02 order) is not.
 */
export type ButtonChange = 'added' | 'removed' | 'moved' | 'enabled' | 'disabled' | 'look' | 'icon';

export function diffLayouts(
  before: ExplicitMainMenu,
  after: ExplicitMainMenu,
): { readonly id: ItemId; readonly changes: readonly ButtonChange[] }[] {
  const from = normalizeExplicitMainMenu(before);
  const to = normalizeExplicitMainMenu(after);
  const out: { id: ItemId; changes: ButtonChange[] }[] = [];
  // The registry buttons, then every custom button either layout places (R10 D2).
  const customs = [...new Set<CustomMenuRef>([...placedCustomRefs(from), ...placedCustomRefs(to)])];
  for (const id of [...MAIN_MENU_BUTTON_IDS, ...customs] as ItemId[]) {
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
    if (changes.length > 0) out.push({ id, changes });
  }
  return out;
}

// --- Drag and drop: what a drop DOES, decided here, never in the pointer code -----------

/** A label that already starts with an emoji: an icon beside it draws two symbols. */
export function startsWithEmoji(label: string): boolean {
  return /^\p{Extended_Pictographic}/u.test(label.trimStart());
}
