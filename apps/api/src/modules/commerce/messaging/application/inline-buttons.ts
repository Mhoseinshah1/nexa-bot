import {
  inlineButtonDefinition,
  type InlineButtonKey,
  type ScopeContext,
  type CategoryColors,
  type CategoryIcons,
  type InlineButtonIcons,
  type InlineButtonStyles,
  type TemplateValues,
} from '@nexa/contracts';
import type { CustomerButtonLabel } from './ports.js';

/**
 * Owner spec §6: the ONE way a customer inline button gets its label — from the registry
 * (`INLINE_BUTTONS`), never from a template key typed at the call site. Spread into a
 * button beside its route:
 *
 *     { ...inlineLabel('wallet.topup'), data: TOPUP_MENU_CALLBACK_PREFIX }
 *
 * The route (`data`, `url`, `copyText`) stays the caller's and is never derived from the
 * label, so relabelling a button in the Web Admin cannot change what a tap does. `inline`
 * names the button so the messenger can draw the tenant's STYLE for it.
 *
 * A source scan (`tests/unit/inline-button-routing.test.ts`) refuses a customer button
 * built any other way in the Telegram surface.
 */
export function inlineLabel(
  key: InlineButtonKey,
  values?: TemplateValues,
): { readonly label: CustomerButtonLabel; readonly inline: InlineButtonKey } {
  const definition = inlineButtonDefinition(key);
  if (definition.label === null) {
    throw new Error(`The inline button ${key} is labelled with data: use inlineDataLabel.`);
  }
  return {
    label: {
      kind: 'TEMPLATE',
      key: definition.label,
      ...(values === undefined ? {} : { values }),
    },
    inline: key,
  };
}

/**
 * A registry button whose label is the TENANT'S DATA — a product's title, a category, an
 * app, a location, an amount. Only its style is the registry's.
 */
export function inlineDataLabel(
  key: InlineButtonKey,
  label: Exclude<CustomerButtonLabel, { readonly kind: 'TEMPLATE' }>,
): { readonly label: CustomerButtonLabel; readonly inline: InlineButtonKey } {
  if (inlineButtonDefinition(key).label !== null) {
    throw new Error(`The inline button ${key} has a template label: use inlineLabel.`);
  }
  return { label, inline: key };
}

/**
 * What the messenger reads a tenant's styles through: `bot.inline_buttons`, resolved (an
 * unreadable stored value falls back to the defaults — loudly, by the settings resolver).
 */
export interface InlineButtonStyleReader {
  stylesFor(scope: ScopeContext): Promise<InlineButtonStyles>;
  /**
   * UX Batch 01, item 2: each product category's own colour (`bot.category_colors`), read
   * only for a keyboard that carries a category button. Absent in a stand-in, which draws
   * every category with the generic category button's style.
   */
  categoryColorsFor?(scope: ScopeContext): Promise<CategoryColors>;
  /**
   * Phase 2 Item 3: each registry button's optional premium icon (`bot.inline_button_icons`),
   * read only for a keyboard that names a registry button AND whose sending bot may carry
   * custom emoji. Absent in a stand-in, which draws every button without an icon.
   */
  iconsFor?(scope: ScopeContext): Promise<InlineButtonIcons>;
  /**
   * Phase 2 Item 2: each product category's decorations (`bot.category_icons`), read only for
   * a keyboard that lists categories — whatever the bot's eligibility, because the `after`
   * emoji is ordinary text; the `before` icon is drawn only from an eligible bot. Absent in a
   * stand-in, which draws every category exactly as before Item 2.
   */
  categoryIconsFor?(scope: ScopeContext): Promise<CategoryIcons>;
}
