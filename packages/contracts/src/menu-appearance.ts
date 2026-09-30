/**
 * The semantic appearance slots a main-menu item may reference (round P, COMMAND-MENU).
 *
 * A LOCAL closed list. The appearance catalogue itself — each slot's fallback emoji,
 * optional `custom_emoji_id`, enabled state and preview — is the PREMIUM-UI package's
 * («🎨 ظاهر ربات»), and that package owns the vocabulary. This list exists so a menu item's
 * `appearanceSlot` is validated against a closed set at the schema rather than stored as
 * free text, and it names exactly the slots the round P brief enumerates. The lead
 * reconciles it against the appearance package's catalogue at merge time; until then the
 * two are kept identical by hand, and a slot the catalogue does not know renders as its
 * plain label — the menu never draws anything from a slot on its own.
 *
 * What a slot does NOT do here: a Reply Keyboard button is plain text (the Bot API's
 * `KeyboardButton.text` carries no entities), so no slot changes what the keyboard shows.
 * The reference is for the screen the item opens, which the appearance renderer decorates.
 */
export const MENU_APPEARANCE_SLOTS = [
  'success',
  'error',
  'warning',
  'info',
  'payment',
  'wallet',
  'purchase',
  'service',
  'trial',
  'referral',
  'support',
  'renewal',
  'traffic',
  'time',
  'link',
  'active',
  'inactive',
] as const;
export type MenuAppearanceSlot = (typeof MENU_APPEARANCE_SLOTS)[number];

export function isMenuAppearanceSlot(value: unknown): value is MenuAppearanceSlot {
  return typeof value === 'string' && (MENU_APPEARANCE_SLOTS as readonly string[]).includes(value);
}
