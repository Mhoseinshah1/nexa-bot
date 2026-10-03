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
 * What `appearanceSlot` does NOT do: it never decorates the keyboard. It names the slot of
 * the screen the item OPENS, which the appearance renderer decorates. A reply-keyboard
 * button's `text` carries no entities and is never altered (a tap is routed by it). Round T
 * added a separate button ICON, `iconSlot` (`bot-menu-builder.ts`); the owner retired it on
 * 2026-10-02 together with this field's control in the builder. Neither decorates the
 * keyboard now, and this field — never read by the runtime (audit §7) — is round-tripped
 * so the previous release and `bot.main_menu` keep reading what they wrote.
 */
export const MENU_APPEARANCE_SLOTS = APPEARANCE_SLOTS;
export type MenuAppearanceSlot = AppearanceSlot;

export function isMenuAppearanceSlot(value: unknown): value is MenuAppearanceSlot {
  return typeof value === 'string' && isAppearanceSlot(value);
}
