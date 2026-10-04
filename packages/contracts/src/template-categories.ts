/**
 * UX Batch 01, item 5 — the DOMAIN a message template belongs to, so the «متن‌ها» screen can
 * show one domain at a time (general bot, purchase, payment, wallet, …).
 *
 * Declared beside the template catalogue rather than in the Web Admin because it is a fact
 * about the KEY, not about the screen: the key's prefix already says which flow sends it
 * (`bot.payment.*`, `bot.wallet.*`, `ops.*`), and this is the one place that turns that into
 * a closed category. The screen titles each category from its own Persian chrome, keyed by
 * this list, so a new category is a type error there until it has a name.
 *
 * ## Exactly one category per key
 *
 * A key belongs to the category with the LONGEST matching prefix, across every category, so
 * `bot.service.renew_button` is a renewal text although `bot.service.` also matches it,
 * whatever order the table is written in. No prefix is declared twice (tested), so the
 * longest match is never a tie. A key no prefix matches has NO category — there is
 * deliberately no catch-all: `tests/unit/template-categories.test.ts` names every catalogue
 * key that maps to nothing, so the change that adds a key under a new prefix is the change
 * that fails until it says where the key belongs.
 */

/** The categories, in the order the screen offers them. */
export const TEMPLATE_CATEGORIES = [
  /** Start, the main menu, commands and the bot's general replies. */
  'general',
  /** The catalogue, the order and its pre-invoice, username choice, discount codes. */
  'purchase',
  /** Card-to-card, receipts, gateways, Stars and refunds. */
  'payment',
  /** The wallet and its top-up. */
  'wallet',
  /** «سرویس‌های من»: the list, a service's card and its everyday actions. */
  'services',
  /** Renewal, add traffic, add time and extra users/devices. */
  'service_changes',
  /** Refusals and failures that are not part of one flow. */
  'errors',
  /** Support contact, FAQ and tickets. */
  'support',
  /** Automated reminders, incidents, broadcasts and direct messages. */
  'notifications',
  /** Inviting friends and the sign-up gift. */
  'referral',
  /** The terms and rules a customer accepts. */
  'terms',
  /** Connection tutorials and the apps to download. */
  'tutorials',
  /** Required channel membership. */
  'channels',
  /** The trial service. */
  'trial',
  /** Administration inside Telegram. */
  'admin',
  /** What Nexa posts to the operators' groups. */
  'operations',
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export function isTemplateCategory(value: string): value is TemplateCategory {
  return (TEMPLATE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The prefixes each category claims. A prefix is matched against the whole key with
 * `startsWith`; a narrower prefix in another category wins over a wider one here.
 */
export const TEMPLATE_CATEGORY_PREFIXES: Readonly<Record<TemplateCategory, readonly string[]>> = {
  general: ['bot.start.', 'bot.menu.', 'bot.command.', 'bot.help', 'bot.ping.', 'bot.appearance.'],
  purchase: ['bot.catalog.', 'bot.order.', 'bot.username.', 'bot.discount.', 'bot.custom_service.'],
  payment: ['bot.payment.', 'bot.refund.'],
  wallet: ['bot.wallet.'],
  services: ['bot.service.'],
  service_changes: [
    // renew_button, renew_choose, renew_option_button, renewed, renewed_details_button, …
    'bot.service.renew',
    'bot.service.add_traffic',
    'bot.service.add_time',
    'bot.service.addon_',
    'bot.service.action_quote',
    'bot.service.action_confirm_button',
    'bot.service.add_devices',
    'bot.service.devices_',
  ],
  errors: [
    'error.',
    'bot.unknown_command',
    'bot.callback.',
    'bot.request_unavailable',
    'bot.blocked',
  ],
  support: ['bot.support.', 'bot.faq.', 'bot.ticket.'],
  notifications: [
    'bot.service.expiry_',
    'bot.service.expired',
    'bot.service.usage_',
    'bot.wallet.low_balance',
    'bot.payment.pending_reminder',
    'bot.order.pending_reminder',
    'bot.reseller.',
    'bot.incident.',
    'bot.broadcast.',
    'bot.marketing.',
    'bot.direct_message.',
  ],
  referral: ['bot.referral.'],
  terms: ['bot.terms.'],
  tutorials: [
    'bot.tutorial.',
    'bot.apps.',
    'bot.service.tutorial_button',
    'bot.service.connected_',
    'bot.service.problem_button',
  ],
  channels: ['bot.channels.'],
  trial: ['bot.trial.'],
  admin: ['bot.admin.', 'bot.menu.admin'],
  operations: ['ops.'],
};

/**
 * The category a template key belongs to: the one with the longest matching prefix, or
 * `null` when no category claims the key. Takes a plain string, because a server may send
 * a key this build does not know; the catalogue's own keys never answer `null` (tested).
 */
export function templateCategoryOf(key: string): TemplateCategory | null {
  let best: TemplateCategory | null = null;
  let bestLength = 0;
  for (const category of TEMPLATE_CATEGORIES) {
    for (const prefix of TEMPLATE_CATEGORY_PREFIXES[category]) {
      if (prefix.length > bestLength && key.startsWith(prefix)) {
        best = category;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}
