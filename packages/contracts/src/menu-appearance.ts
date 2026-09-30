import { APPEARANCE_SLOTS, isAppearanceSlot, type AppearanceSlot } from './appearance.js';

/**
 * The semantic appearance slots a main-menu item may reference (round P, COMMAND-MENU).
 *
 * ONE vocabulary: the appearance catalogue (`APPEARANCE_SLOTS`, «🎨 ظاهر ربات», the
 * PREMIUM-UI package's) is the list, and these names are aliases of it, kept so the menu
 * contracts and the bot-buttons page read as they were written. Until the two packages
 * merged this was a LOCAL closed list of the seventeen slots the round P brief enumerates,
 * kept identical to the catalogue by hand; the catalogue has since grown four slots
 * (`ticket`, `date`, `user`, `location`) and a menu item may name any of them.
 *
 * What a slot does NOT do here: a Reply Keyboard button is plain text (the Bot API's
 * `KeyboardButton.text` carries no entities), so no slot changes what the keyboard shows.
 * The reference is for the screen the item opens, which the appearance renderer decorates.
 */
export const MENU_APPEARANCE_SLOTS = APPEARANCE_SLOTS;
export type MenuAppearanceSlot = AppearanceSlot;

export function isMenuAppearanceSlot(value: unknown): value is MenuAppearanceSlot {
  return typeof value === 'string' && isAppearanceSlot(value);
}
