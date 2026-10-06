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
 * added a separate button ICON, `iconSlot` (`bot-menu-builder.ts`) —
 * `KeyboardButton.icon_custom_emoji_id`, retired on 2026-10-02 and restored by the owner's
 * 2026-10-05 master prompt. The two are kept apart on purpose: every item has a non-null
 * default `appearanceSlot`, so reusing it as the icon would change every eligible bot's
 * keyboard on upgrade (`docs/round-t-button-builder-audit.md` §7). This field — never read
 * by the runtime (audit §7), its control removed on 2026-10-02 — is round-tripped so the
 * previous release and `bot.main_menu` keep reading what they wrote.
 */
export const MENU_APPEARANCE_SLOTS = APPEARANCE_SLOTS;
export type MenuAppearanceSlot = AppearanceSlot;

export function isMenuAppearanceSlot(value: unknown): value is MenuAppearanceSlot {
  return typeof value === 'string' && isAppearanceSlot(value);
}
