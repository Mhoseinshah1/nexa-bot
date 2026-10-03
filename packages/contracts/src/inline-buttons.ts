import { z } from 'zod';
import { MAIN_MENU_BUTTON_STYLES, type MainMenuButtonStyle } from './bot-menu-builder.js';
import type { TemplateKey } from './templates.js';

/**
 * The customer's INLINE («شیشه‌ای») buttons — the registry every inline keyboard a customer
 * sees is drawn from (owner spec §6).
 *
 * Separate from the main menu on purpose. The main menu is a REPLY keyboard whose tap sends
 * its label back as text, so its label IS its route (`bot.menu.*`, `bot-menu-builder.ts`).
 * An inline button carries `callback_data`, a URL or a clipboard string: the label is
 * presentation only, and nothing a customer taps is ever decided by it. So this registry
 * holds, per button, exactly the two things an operator may change — the label (a template,
 * edited with the template machinery: versioned, audited, `templates.edit`) and the style
 * (the `bot.inline_buttons` setting: versioned, audited, `settings.edit`) — and the runtime
 * never builds a customer button any other way (`inlineLabel`, pinned by a source scan).
 *
 * ## What a key is
 *
 * A STABLE identifier. Never derived from the label, never sent to Telegram, never part of
 * `callback_data`: renaming a label in the Web Admin changes the rendered text and nothing
 * else (pinned by a test that renders the same keyboard under two labels and compares the
 * data byte for byte). Renaming a KEY is a contract change — a stored style for the old key
 * would stop parsing, and the setting would fall back to the defaults, loudly.
 *
 * ## Labels that are not ours
 *
 * Some buttons are labelled with the TENANT'S OWN DATA — a product's title, a category's
 * name, an app, a location, a top-up amount. Those have `label: null`: their text is the
 * data, and only their style is configurable. Every other entry names the ONE template its
 * label is rendered from, and no two entries share a template (tested), so editing one
 * button's label can never silently relabel another.
 */

/**
 * The styles an inline button may take — the same closed set as the reply keyboard's, and
 * for the same reason: `InlineKeyboardButton.style` accepts exactly `primary`, `success` and
 * `danger` (Bot API 9.4, the same release and the same field as `KeyboardButton.style`,
 * `OQ-T-API-01`), and an absent style is the client's default. `default` is Nexa's name for
 * "no style" and is OMITTED on the wire. No custom colours exist and none are offered.
 */
export const INLINE_BUTTON_STYLES = MAIN_MENU_BUTTON_STYLES;
export type InlineButtonStyle = MainMenuButtonStyle;

/** The sections the Web Admin groups the buttons into, in the order it shows them. */
export const INLINE_BUTTON_GROUPS = [
  'NAVIGATION',
  'WALLET',
  'PURCHASE',
  'PAYMENT',
  'SERVICES',
  'SERVICE_ACTIONS',
  'SUPPORT',
  'REFERRAL',
  'APPS',
  'CHANNELS',
  'TERMS',
] as const;
export type InlineButtonGroup = (typeof INLINE_BUTTON_GROUPS)[number];

/** What a tap on the button does on the CLIENT: a callback to Nexa, a link, or a copy. */
export const INLINE_BUTTON_ACTIONS = ['CALLBACK', 'URL', 'COPY'] as const;
export type InlineButtonAction = (typeof INLINE_BUTTON_ACTIONS)[number];

export interface InlineButtonDefinition {
  readonly key: string;
  /** The template the label is rendered from, or null when the label is the tenant's data. */
  readonly label: TemplateKey | null;
  readonly defaultStyle: InlineButtonStyle;
  readonly group: InlineButtonGroup;
  readonly action: InlineButtonAction;
}

function button<const K extends string>(
  key: K,
  group: InlineButtonGroup,
  label: TemplateKey | null,
  action: InlineButtonAction = 'CALLBACK',
): InlineButtonDefinition & { readonly key: K } {
  // Every default is `default`: shipping the registry changes no customer's keyboard.
  // A style is something an operator chooses, never something an upgrade imposes.
  return { key, label, defaultStyle: 'default', group, action };
}

/**
 * Every inline button a customer can be shown, in the order the Web Admin lists them.
 *
 * Administrator screens inside the bot (`bot.admin.*`) are not here: they are operator
 * tools, not the customer's bot, and their labels are the management panel's own.
 */
export const INLINE_BUTTONS = [
  // Navigation
  button('main_menu', 'NAVIGATION', 'bot.menu.main_button'),
  button('list.close', 'NAVIGATION', 'bot.wallet.topup_close_button'),

  // Wallet
  button('wallet.open', 'WALLET', 'bot.wallet.open_button'),
  button('wallet.topup', 'WALLET', 'bot.wallet.topup_button'),
  button('wallet.topup_amount', 'WALLET', null),

  // Purchase
  button('catalog.open', 'PURCHASE', 'bot.catalog.open_button'),
  button('catalog.category', 'PURCHASE', null),
  button('catalog.product', 'PURCHASE', null),
  button('catalog.previous_page', 'PURCHASE', 'bot.catalog.previous_page_button'),
  button('catalog.next_page', 'PURCHASE', 'bot.catalog.next_page_button'),
  button('catalog.back_to_categories', 'PURCHASE', 'bot.catalog.back_to_categories_button'),
  button('catalog.custom_service', 'PURCHASE', 'bot.custom_service.button'),
  button('custom_service.location', 'PURCHASE', null),
  button('trial.panel', 'PURCHASE', 'bot.trial.panel_button'),
  button('username.custom', 'PURCHASE', 'bot.username.custom_button'),
  button('username.automatic', 'PURCHASE', 'bot.username.automatic_button'),
  button('discount.enter', 'PURCHASE', 'bot.discount.enter_button'),
  button('discount.remove', 'PURCHASE', 'bot.discount.remove_button'),
  button('order.cancel', 'PURCHASE', 'bot.order.cancel_button'),
  button('order.cancel_confirm', 'PURCHASE', 'bot.order.cancel_confirm_button'),

  // Payment
  button('payment.wallet', 'PAYMENT', 'bot.payment.wallet_button'),
  button('payment.methods', 'PAYMENT', 'bot.payment.manual_button'),
  button('payment.route', 'PAYMENT', 'bot.wallet.topup_method_button'),
  button('payment.route_gift', 'PAYMENT', 'bot.wallet.topup_method_gift_button'),
  button('payment.copy_card', 'PAYMENT', 'bot.payment.copy_card_button', 'COPY'),
  button('payment.copy_amount', 'PAYMENT', 'bot.payment.copy_amount_button', 'COPY'),
  button('payment.sent', 'PAYMENT', 'bot.payment.sent_button'),
  button('payment.cancel', 'PAYMENT', 'bot.payment.cancel_button'),
  button('payment.cancel_confirm', 'PAYMENT', 'bot.payment.cancel_confirm_button'),
  button('payment.gateway_pay', 'PAYMENT', 'bot.payment.gateway_pay_button', 'URL'),
  // A provider whose pay button reads differently (spec §16): its own key, so the label and
  // style are the operator's to set without touching the generic gateway button.
  button('payment.nowpayments_open', 'PAYMENT', 'bot.payment.nowpayments_pay_button', 'URL'),
  // CentralPay's «💳 پرداخت با CentralPay» link (spec §17), isolated the same way.
  button('payment.centralpay_open', 'PAYMENT', 'bot.payment.centralpay_pay_button', 'URL'),
  button('payment.gateway_check', 'PAYMENT', 'bot.payment.gateway_check_button'),
  button('payment.gateway_card_check', 'PAYMENT', 'bot.payment.gateway_card_check_button'),
  button('payment.gateway_receipt', 'PAYMENT', 'bot.payment.gateway_receipt_button'),
  button('payment.gateway_change_card', 'PAYMENT', 'bot.payment.gateway_change_card_button'),

  // My services: the list
  button('services.item', 'SERVICES', 'bot.service.list_item_button'),
  button('services.search_label', 'SERVICES', 'bot.service.search_label_button'),
  button('services.search', 'SERVICES', 'bot.service.search_button'),
  button('services.previous_page', 'SERVICES', 'bot.service.prev_page_button'),
  button('services.page', 'SERVICES', 'bot.service.page_button'),
  button('services.next_page', 'SERVICES', 'bot.service.next_page_button'),
  button('services.back_to_menu', 'SERVICES', 'bot.service.back_to_menu_button'),
  button('service.back_to_list', 'SERVICES', 'bot.service.back_to_list_button'),
  button('service.back_to_card', 'SERVICES', 'bot.service.back_to_card_button'),
  button('service.renewed_details', 'SERVICES', 'bot.service.renewed_details_button'),
  button('service.transfer_details', 'SERVICES', 'bot.service.transfer_details_button'),
  button('service.tutorial', 'SERVICES', 'bot.service.tutorial_button'),
  button('service.connected', 'SERVICES', 'bot.service.connected_button'),
  button('service.problem', 'SERVICES', 'bot.service.problem_button'),

  // My services: one service's actions
  button('service.refresh', 'SERVICE_ACTIONS', 'bot.service.refresh_button'),
  button('service.files', 'SERVICE_ACTIONS', 'bot.service.files_button'),
  button('service.link', 'SERVICE_ACTIONS', 'bot.service.link_button'),
  button('service.rotate', 'SERVICE_ACTIONS', 'bot.service.rotate_button'),
  button('service.rotate_confirm', 'SERVICE_ACTIONS', 'bot.service.rotate_confirm_button'),
  button('service.note', 'SERVICE_ACTIONS', 'bot.service.note_button'),
  button('service.renew', 'SERVICE_ACTIONS', 'bot.service.renew_button'),
  button('service.renew_option', 'SERVICE_ACTIONS', 'bot.service.renew_option_button'),
  button('service.add_traffic', 'SERVICE_ACTIONS', 'bot.service.add_traffic_button'),
  button('service.addon_option', 'SERVICE_ACTIONS', 'bot.service.addon_option'),
  button('service.add_devices', 'SERVICE_ACTIONS', 'bot.service.add_devices_button'),
  button('service.devices_option', 'SERVICE_ACTIONS', 'bot.service.devices_option'),
  button('service.change_location', 'SERVICE_ACTIONS', 'bot.service.change_location_button'),
  button('service.location_option', 'SERVICE_ACTIONS', 'bot.service.location_option'),
  button('service.location_option_free', 'SERVICE_ACTIONS', 'bot.service.location_option_free'),
  button('service.location_confirm', 'SERVICE_ACTIONS', 'bot.service.location_confirm_button'),
  button('service.suspend', 'SERVICE_ACTIONS', 'bot.service.suspend_button'),
  button('service.resume', 'SERVICE_ACTIONS', 'bot.service.resume_button'),
  button('service.refund_request', 'SERVICE_ACTIONS', 'bot.service.refund_request_button'),
  button(
    'service.refund_request_confirm',
    'SERVICE_ACTIONS',
    'bot.service.refund_request_confirm_button',
  ),
  button('service.transfer', 'SERVICE_ACTIONS', 'bot.service.transfer_button'),
  button('service.transfer_confirm', 'SERVICE_ACTIONS', 'bot.service.transfer_confirm_button'),

  // Support and tickets
  button('support.tickets', 'SUPPORT', 'bot.support.tickets_button'),
  button('support.contact', 'SUPPORT', 'bot.support.contact_button', 'URL'),
  button('tickets.item', 'SUPPORT', 'bot.ticket.list_item_button'),
  button('tickets.new', 'SUPPORT', 'bot.ticket.new_button'),
  button('tickets.category', 'SUPPORT', 'bot.ticket.category_button'),
  button('tickets.view', 'SUPPORT', 'bot.ticket.view_button'),
  button('tickets.reply', 'SUPPORT', 'bot.ticket.reply_button'),
  button('tickets.close', 'SUPPORT', 'bot.ticket.close_button'),
  button('tickets.close_confirm', 'SUPPORT', 'bot.ticket.close_confirm_button'),
  button('tickets.back', 'SUPPORT', 'bot.ticket.back_button'),
  button('marketing.opt_out', 'SUPPORT', 'bot.marketing.opt_out_button'),
  button('marketing.opt_in', 'SUPPORT', 'bot.marketing.opt_in_button'),

  // Referral
  button('referral.share', 'REFERRAL', 'bot.referral.share_button', 'URL'),
  button('referral.gift', 'REFERRAL', 'bot.referral.gift_button'),

  // Apps and the connection guide
  button('apps.platform_android', 'APPS', 'bot.tutorial.android_button'),
  button('apps.platform_ios', 'APPS', 'bot.tutorial.ios_button'),
  button('apps.platform_windows', 'APPS', 'bot.tutorial.windows_button'),
  button('apps.platform_macos', 'APPS', 'bot.tutorial.macos_button'),
  button('apps.platform_linux', 'APPS', 'bot.tutorial.linux_button'),
  button('apps.platform_other', 'APPS', 'bot.tutorial.other_button'),
  button('apps.app', 'APPS', null),
  button('apps.download', 'APPS', 'bot.apps.download_button', 'URL'),
  button('apps.alternative', 'APPS', 'bot.apps.alternative_button', 'URL'),
  button('apps.help', 'APPS', 'bot.apps.help_button', 'URL'),
  button('apps.services', 'APPS', 'bot.menu.services'),
  button('apps.back', 'APPS', 'bot.apps.back_button'),
  button('apps.platforms', 'APPS', 'bot.apps.platforms_button'),

  // Required channels
  button('channels.join_public', 'CHANNELS', null, 'URL'),
  button('channels.join_private', 'CHANNELS', 'bot.channels.join_private_button', 'URL'),
  button('channels.check', 'CHANNELS', 'bot.channels.check_button'),

  // Terms and rules (program §6)
  button('terms.accept', 'TERMS', 'bot.terms.accept_button'),
] as const satisfies readonly InlineButtonDefinition[];

export type InlineButtonKey = (typeof INLINE_BUTTONS)[number]['key'];

export const INLINE_BUTTON_KEYS = INLINE_BUTTONS.map((entry) => entry.key) as unknown as readonly [
  InlineButtonKey,
  ...InlineButtonKey[],
];

const INLINE_BUTTON_BY_KEY: ReadonlyMap<string, InlineButtonDefinition> = new Map(
  INLINE_BUTTONS.map((entry) => [entry.key, entry]),
);

export function inlineButtonDefinition(key: InlineButtonKey): InlineButtonDefinition {
  const found = INLINE_BUTTON_BY_KEY.get(key);
  if (found === undefined) throw new Error(`Unknown inline button: ${key}.`);
  return found;
}

export function isInlineButtonKey(value: string): value is InlineButtonKey {
  return INLINE_BUTTON_BY_KEY.has(value);
}

/**
 * The value of the `bot.inline_buttons` setting: a style per button an operator changed.
 * A button absent from it has its registry default. Unknown keys and unknown styles are
 * refused (a partial record over the closed key set), so a value can only name a button
 * this release draws.
 */
export const inlineButtonStylesSchema = z.partialRecord(
  z.enum(INLINE_BUTTON_KEYS),
  z.enum(INLINE_BUTTON_STYLES),
);
export type InlineButtonStyles = Readonly<Partial<Record<InlineButtonKey, InlineButtonStyle>>>;

/** The style one button is drawn with: the tenant's choice, else the registry default. */
export function inlineButtonStyleOf(
  key: InlineButtonKey,
  styles: InlineButtonStyles,
): InlineButtonStyle {
  return styles[key] ?? inlineButtonDefinition(key).defaultStyle;
}
