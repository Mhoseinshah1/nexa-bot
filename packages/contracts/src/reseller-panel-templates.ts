import type { PlaceholderDefinition, TemplateDefinition } from './templates.js';

/**
 * PR-4 — the reseller web panel's bot copy, in a file of its own that imports only types, so
 * `templates.ts` can spread it without a module cycle (the shape `reseller-requests.ts` has).
 */

// --- Bot copy ---------------------------------------------------------------------------

function ph(
  token: string,
  type: PlaceholderDefinition['type'],
  description: string,
): PlaceholderDefinition {
  return { token, type, description, required: true, repeatable: false };
}

function tpl<const K extends string>(
  key: K,
  description: string,
  placeholders: readonly PlaceholderDefinition[] = [],
): TemplateDefinition & { readonly key: K } {
  return { key, description, format: 'PLAIN_TEXT', placeholders };
}

/** The callback the bot's «ورود به پنل وب» button carries. */
export const RESELLER_WEB_CALLBACK = 'rwp:';

export const RESELLER_PANEL_TEMPLATES = [
  tpl(
    'bot.reseller_web.open_button',
    'Reseller panel: the inline button «ورود به پنل وب», shown to an ACTIVE reseller while the reseller_web_panel flag is on.',
  ),
  tpl(
    'bot.reseller_web.link',
    'Reseller panel: the one-time sign-in link was issued; the message carries a button that opens it. Valid ten minutes, once.',
    [ph('minutes', 'NUMBER', 'How long the link stays valid, in minutes.')],
  ),
  tpl(
    'bot.reseller_web.link_button',
    'Reseller panel: the URL button on the link message that opens the panel.',
  ),
  tpl(
    'bot.reseller_web.link_rate_limited',
    'Reseller panel: more than five links were asked for in an hour; nothing was issued.',
  ),
  tpl(
    'bot.reseller_web.unavailable',
    'Reseller panel: the panel cannot be opened now (switched off, not an active reseller, or no web address is set).',
  ),
  tpl(
    'bot.reseller_web.new_device',
    'Reseller panel: sent once per new device or browser that signs in to the reseller panel (when «اعلان ورود جدید» is on).',
  ),
] as const;
