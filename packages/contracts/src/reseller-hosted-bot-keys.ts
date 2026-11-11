import type { PlaceholderDefinition, TemplateDefinition } from './templates.js';

/**
 * Reseller-phase PR-6: the leaf constants of the dedicated reseller bot (`reseller-hosted-bot.ts`)
 * — its settings' keys, its operational codes and its templates — with no runtime import, so
 * `settings.ts`, `ops-error-events.ts` and `templates.ts` can read them without a cycle.
 */

// ---------------------------------------------------------------------------
// Settings (installation tenant, owner only)
// ---------------------------------------------------------------------------

/** The monthly fee: an amount and a currency. Zero (the default) = not offered. */
export const RESELLER_BOT_MONTHLY_FEE_SETTING_KEY = 'hosting.reseller_bot_monthly_fee' as const;
/** Days a short wallet is given after a period falls due before the bot is stopped. */
export const RESELLER_BOT_GRACE_DAYS_SETTING_KEY = 'hosting.reseller_bot_grace_days' as const;
export const RESELLER_BOT_GRACE_DAYS_DEFAULT = 3;
export const RESELLER_BOT_GRACE_DAYS_MAX = 30;

/** Rejecting needs a written reason, 3–500 characters (the reseller rules' bounds). */
export const RESELLER_BOT_REJECT_REASON_MIN = 3;
export const RESELLER_BOT_REJECT_REASON_MAX = 500;

// ---------------------------------------------------------------------------
// Operational events (installation tenant: the owner's group)
// ---------------------------------------------------------------------------

/** The family every fee, stop and resume message of a reseller's bot belongs to. */
export const RESELLER_BOT_OPS_PREFIX = 'hosting.reseller_bot.' as const;
export const RESELLER_BOT_OPS_CODES = {
  APPROVED: 'hosting.reseller_bot.approved',
  FEE_CHARGED: 'hosting.reseller_bot.fee_charged',
  FEE_SHORT: 'hosting.reseller_bot.fee_short',
  STOPPED: 'hosting.reseller_bot.stopped',
  RESUMED: 'hosting.reseller_bot.resumed',
} as const;

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const ph = (
  token: string,
  type: PlaceholderDefinition['type'],
  description: string,
): PlaceholderDefinition => ({ token, type, description, required: true, repeatable: false });

function tpl<const K extends string>(
  key: K,
  description: string,
  placeholders: readonly PlaceholderDefinition[] = [],
): TemplateDefinition & { readonly key: K } {
  return { key, description, format: 'PLAIN_TEXT', placeholders };
}

export const RESELLER_BOT_TEMPLATES = [
  tpl(
    'bot.hosted_bot.activation_link',
    'PR-6: the reseller’s dedicated bot is ready; the one-time link opens its panel setup. Read at send time from the request row (HOSTED_BOT_ACTIVATION_LINK).',
    [
      ph('bot', 'STRING', 'The dedicated bot’s Telegram username.'),
      ph('url', 'STRING', 'The one-time activation link.'),
      ph('expiresAt', 'DATETIME', 'When the link stops working.'),
    ],
  ),
  tpl(
    'bot.hosted_bot.fee_short',
    'PR-6: once a day during the grace days — the wallet does not hold the dedicated bot’s monthly fee; the bot stops at the deadline if still unpaid (its data is kept).',
    [
      ph('bot', 'STRING', 'The dedicated bot’s Telegram username.'),
      ph('fee', 'MONEY', 'The monthly fee.'),
      ph('shortfall', 'MONEY', 'How much more the wallet needs.'),
      ph('deadline', 'DATETIME', 'When the bot is stopped if still unpaid.'),
    ],
  ),
] as const;
