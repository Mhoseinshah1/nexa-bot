import { z } from 'zod';
import { customEmojiIdSchema } from './appearance.js';
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
  // R10 D5: the answers under the /start captcha.
  'CAPTCHA',
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
  /**
   * R4 PR-F (F4): the colour the owner's rule SUGGESTS for this button — success for paying
   * and confirming, danger for cancelling and destructive confirmations, primary for the main
   * action of a screen — or `default` where the rule names none.
   *
   * A suggestion, never applied by itself: `defaultStyle` stays `default` for every button, so
   * an upgrade changes no customer's keyboard. The Web Admin's inline-button builder offers
   * «رنگ‌های پیشنهادی», which writes these into the tenant's `bot.inline_buttons` through the
   * ordinary versioned, audited setting save, where the owner can change each one again.
   */
  readonly suggestedStyle: InlineButtonStyle;
}

function button<const K extends string>(
  key: K,
  group: InlineButtonGroup,
  label: TemplateKey | null,
  action: InlineButtonAction = 'CALLBACK',
): InlineButtonDefinition & { readonly key: K } {
  // Every default is `default`: shipping the registry changes no customer's keyboard.
  // A style is something an operator chooses, never something an upgrade imposes.
  return {
    key,
    label,
    defaultStyle: 'default',
    group,
    action,
    suggestedStyle: INLINE_BUTTON_SUGGESTED_STYLES[key] ?? 'default',
  };
}

/**
 * R4 PR-F (F4): the owner's colour rule, per button — success = pay / confirm, danger =
 * delete / cancel, primary = the main action. A button not named here suggests `default`.
 * Read only by `suggestedStyle`; see there for why nothing applies it automatically.
 */
const INLINE_BUTTON_SUGGESTED_STYLES: Readonly<
  Record<string, Exclude<InlineButtonStyle, 'default'>>
> = {
  // Pay / confirm.
  'payment.wallet': 'success',
  'payment.sent': 'success',
  'payment.gateway_pay': 'success',
  'payment.nowpayments_open': 'success',
  'payment.centralpay_open': 'success',
  'service.renew_option': 'success',
  'service.rotate_confirm': 'success',
  'service.files_new_confirm': 'success',
  'service.location_confirm': 'success',
  'service.resume_confirm': 'success',
  'service.transfer_confirm': 'success',
  'terms.accept': 'success',
  // Delete / cancel.
  'order.cancel': 'danger',
  'order.cancel_confirm': 'danger',
  'payment.cancel': 'danger',
  'payment.cancel_confirm': 'danger',
  'discount.remove': 'danger',
  'service.suspend_confirm': 'danger',
  'service.refund_request_confirm': 'danger',
  'tickets.close_confirm': 'danger',
  // The main action of a screen.
  'catalog.open': 'primary',
  'catalog.product': 'primary',
  'wallet.topup': 'primary',
  'service.renew': 'primary',
  'tickets.new': 'primary',
  'channels.check': 'primary',
};

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
  // R10 D2: the URL button under a custom main-menu link button's answer.
  button('custom.link_open', 'NAVIGATION', 'bot.custom_button.open_link_button', 'URL'),

  // Wallet
  button('wallet.open', 'WALLET', 'bot.wallet.open_button'),
  button('wallet.topup', 'WALLET', 'bot.wallet.topup_button'),
  // R12 F3: «📜 تراکنش‌ها» under the balance.
  button('wallet.history', 'WALLET', 'bot.wallet.history_button'),
  button('wallet.topup_amount', 'WALLET', null),
  // R10 D4: «🎁 کارت هدیه» under the balance, while the gift_cards feature is on.
  button('wallet.gift_card', 'WALLET', 'bot.wallet.gift_card_button'),
  // R4 A3: «📋 کپی شناسه» on the account summary — a CopyTextButton with the Telegram id.
  button('account.copy_id', 'WALLET', 'bot.wallet.copy_id_button', 'COPY'),

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
  // R11 A11: under an expired or cancelled order's edited payment message.
  button('order.reorder', 'PURCHASE', 'bot.order.reorder_button'),
  button('order.main_menu', 'PURCHASE', 'bot.order.main_menu_button'),
  // R12 F3: the status button of `bot.order.payment_in_review`, and the back / cancel pair under
  // a typed-input prompt (also «بازگشت به پیش‌فاکتور» under the wallet shortfall).
  button('order.payment_status', 'PURCHASE', 'bot.order.payment_status_button'),
  button('order.input_back', 'PURCHASE', 'bot.order.input_back_button'),
  button('order.input_cancel', 'PURCHASE', 'bot.order.input_cancel_button'),
  button('custom_service.back', 'PURCHASE', 'bot.custom_service.back_button'),

  // Payment
  button('payment.wallet', 'PAYMENT', 'bot.payment.wallet_button'),
  button('payment.methods', 'PAYMENT', 'bot.payment.manual_button'),
  button('payment.route', 'PAYMENT', 'bot.wallet.topup_method_button'),
  button('payment.route_gift', 'PAYMENT', 'bot.wallet.topup_method_gift_button'),
  button('payment.copy_card', 'PAYMENT', 'bot.payment.copy_card_button', 'COPY'),
  button('payment.copy_amount', 'PAYMENT', 'bot.payment.copy_amount_button', 'COPY'),
  // R6 item 2: on a TonPays card invoice — the exact odd amount, bare digits. R8 A2: «📋 کپی مبلغ
  // (ریال)», RIAL digits, on the manual card-to-card invoice too.
  button(
    'payment.copy_transfer_amount',
    'PAYMENT',
    'bot.payment.copy_transfer_amount_button',
    'COPY',
  ),
  button('payment.sent', 'PAYMENT', 'bot.payment.sent_button'),
  // R12 F3: under a rejected or expired payment's notice.
  button('payment.retry', 'PAYMENT', 'bot.payment.retry_button'),
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
  // Round 6 (TonPays Telegram): cancel a pending invoice, the remainder's receipt, the refund
  // card of an overpayment, and the way to an open invoice that blocked a new one.
  button('payment.gateway_cancel', 'PAYMENT', 'bot.payment.gateway_cancel_button'),
  button('payment.gateway_cancel_confirm', 'PAYMENT', 'bot.payment.gateway_cancel_confirm_button'),
  button(
    'payment.gateway_remainder_receipt',
    'PAYMENT',
    'bot.payment.gateway_remainder_receipt_button',
  ),
  button('payment.gateway_refund_card', 'PAYMENT', 'bot.payment.gateway_refund_card_button'),
  button('payment.gateway_open_invoice', 'PAYMENT', 'bot.payment.gateway_open_invoice_button'),
  // R4 A1: «🔄 تغییر شماره کارت» on the card-to-card invoice — the NEXT enabled receiving
  // card, edited into the same message. Not the TonPays card change above, which asks a
  // provider: this one rotates through the tenant's own accounts.
  button('payment.switch_card', 'PAYMENT', 'bot.payment.switch_card_button'),

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
  // Track 3 §1: support, from the «not found on the panel» answer to opening a card.
  button('service.support', 'SERVICE_ACTIONS', 'bot.service.support_button'),
  button('service.files', 'SERVICE_ACTIONS', 'bot.service.files_button'),
  button('service.link', 'SERVICE_ACTIONS', 'bot.service.link_button'),
  button('service.rotate', 'SERVICE_ACTIONS', 'bot.service.rotate_button'),
  button('service.rotate_confirm', 'SERVICE_ACTIONS', 'bot.service.rotate_confirm_button'),
  // R11 A4: on a files-only panel «تغییر لینک» is «دریافت فایل‌های جدید» (same slot, same tap).
  button('service.files_new', 'SERVICE_ACTIONS', 'bot.service.files_new_button'),
  button('service.files_new_confirm', 'SERVICE_ACTIONS', 'bot.service.files_new_confirm_button'),
  button('service.note', 'SERVICE_ACTIONS', 'bot.service.note_button'),
  button('service.renew', 'SERVICE_ACTIONS', 'bot.service.renew_button'),
  button('service.renew_option', 'SERVICE_ACTIONS', 'bot.service.renew_option_button'),
  button('service.add_traffic', 'SERVICE_ACTIONS', 'bot.service.add_traffic_button'),
  // R5C-1 item 4: «⏳ خرید زمان اضافه», beside the extra-traffic button.
  button('service.add_time', 'SERVICE_ACTIONS', 'bot.service.add_time_button'),
  button('service.addon_option', 'SERVICE_ACTIONS', 'bot.service.addon_option'),
  button('service.add_devices', 'SERVICE_ACTIONS', 'bot.service.add_devices_button'),
  button('service.devices_option', 'SERVICE_ACTIONS', 'bot.service.devices_option'),
  button('service.change_location', 'SERVICE_ACTIONS', 'bot.service.change_location_button'),
  button('service.location_option', 'SERVICE_ACTIONS', 'bot.service.location_option'),
  button('service.location_option_free', 'SERVICE_ACTIONS', 'bot.service.location_option_free'),
  button('service.location_confirm', 'SERVICE_ACTIONS', 'bot.service.location_confirm_button'),
  button('service.suspend', 'SERVICE_ACTIONS', 'bot.service.suspend_button'),
  button('service.resume', 'SERVICE_ACTIONS', 'bot.service.resume_button'),
  // B8: the switch asks first, in both directions.
  button('service.suspend_confirm', 'SERVICE_ACTIONS', 'bot.service.suspend_confirm_button'),
  button('service.resume_confirm', 'SERVICE_ACTIONS', 'bot.service.resume_confirm_button'),
  button('service.toggle_cancel', 'SERVICE_ACTIONS', 'bot.service.toggle_cancel_button'),
  button('service.refund_request', 'SERVICE_ACTIONS', 'bot.service.refund_request_button'),
  button(
    'service.refund_request_confirm',
    'SERVICE_ACTIONS',
    'bot.service.refund_request_confirm_button',
  ),
  // Round 10, D1: «تمدید خودکار» — on and off are one slot; the ON tap asks first.
  button('service.auto_renew_enable', 'SERVICE_ACTIONS', 'bot.service.auto_renew_enable_button'),
  button('service.auto_renew_disable', 'SERVICE_ACTIONS', 'bot.service.auto_renew_disable_button'),
  button('service.auto_renew_confirm', 'SERVICE_ACTIONS', 'bot.service.auto_renew_confirm_button'),
  button('service.transfer', 'SERVICE_ACTIONS', 'bot.service.transfer_button'),
  button('service.transfer_confirm', 'SERVICE_ACTIONS', 'bot.service.transfer_confirm_button'),

  // Support and tickets
  button('support.tickets', 'SUPPORT', 'bot.support.tickets_button'),
  button('support.contact', 'SUPPORT', 'bot.support.contact_button', 'URL'),
  // R4 A5: on the blocked reply. A URL, never a callback: a blocked customer's taps are
  // refused, and a link to the support account still opens.
  button('blocked.support', 'SUPPORT', 'bot.blocked.support_button', 'URL'),
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

  // The /start captcha's four answers (R10 D5): the label is the offered number.
  button('captcha.option', 'CAPTCHA', 'bot.captcha.option_button'),
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

/**
 * R4 PR-F (F4): every button the owner's colour rule names, with its suggested style — what
 * «رنگ‌های پیشنهادی» offers to write into `bot.inline_buttons`. Buttons whose suggestion is
 * `default` are absent, exactly as an unchanged button is absent from the setting.
 */
export function suggestedInlineButtonStyles(): InlineButtonStyles {
  const suggested: Partial<Record<InlineButtonKey, InlineButtonStyle>> = {};
  for (const entry of INLINE_BUTTONS) {
    if (entry.suggestedStyle !== 'default') suggested[entry.key] = entry.suggestedStyle;
  }
  return suggested;
}

/** The style one button is drawn with: the tenant's choice, else the registry default. */
export function inlineButtonStyleOf(
  key: InlineButtonKey,
  styles: InlineButtonStyles,
): InlineButtonStyle {
  return styles[key] ?? inlineButtonDefinition(key).defaultStyle;
}

// ---------------------------------------------------------------------------
// Per-button icons (Phase 2 UX wave, Item 3)
// ---------------------------------------------------------------------------

/**
 * The value of the `bot.inline_button_icons` setting: ONE Telegram custom emoji id per
 * registry button an operator gave an icon, drawn as `InlineKeyboardButton.icon_custom_emoji_id`.
 *
 * What Telegram allows, and so all this models (`@grammyjs/types` `InlineKeyboardButton`,
 * Bot API 9.4; `docs/phase2/button-icons.md`):
 *
 * - ONE icon per button, shown BEFORE the text. There is no "after" position.
 * - The button TEXT carries no entities: a premium emoji can never be put inside a label.
 *   The icon is a separate field and the label stays exactly the template's text.
 * - Only a bot able to use custom emoji may send one. Nexa decides that per BOT INSTANCE by
 *   its own appearance test (`SENT`), never per tenant: on any other bot the icon is omitted.
 *
 * A SEPARATE setting rather than a widening of `bot.inline_buttons`: that value is a closed
 * partial record an older release parses strictly, so a second field in it would make the
 * previous release read every tenant's styles as unreadable after a rollback.
 *
 * Keyed by the closed registry (an unknown key is refused); each value is digits only, at
 * most 32 (`customEmojiIdSchema`, the same rule the appearance slots use). A button absent
 * from the value has no icon. Removing an icon is removing its key.
 */
export const inlineButtonIconsSchema = z.partialRecord(
  z.enum(INLINE_BUTTON_KEYS),
  customEmojiIdSchema,
);
export type InlineButtonIcons = Readonly<Partial<Record<InlineButtonKey, string>>>;

/** The custom emoji id one button carries as its icon, or null for none. */
export function inlineButtonIconOf(key: InlineButtonKey, icons: InlineButtonIcons): string | null {
  if (!Object.prototype.hasOwnProperty.call(icons, key)) return null;
  const icon = icons[key];
  return icon === undefined || icon === '' ? null : icon;
}

// ---------------------------------------------------------------------------
// Per-category colours (UX Batch 01, item 2)
// ---------------------------------------------------------------------------

/**
 * A product category's id as a key of `bot.category_colors`: any UUID, canonical lower case.
 *
 * Not `uuidV7Schema`: a tenant's first category was created by migrations 0097/0099 with
 * `gen_random_uuid()`, a version 4. Lower case only, so one category cannot be stored under
 * two spellings — Postgres prints a uuid in lower case, and that is what the catalogue sends.
 */
export const CATEGORY_COLOR_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * At most this many categories carry their own colour. A Nexa domain bound, far above any
 * catalogue a tenant browses (a reorder names at most 200), so a value stays a small row.
 */
export const CATEGORY_COLORS_MAX = 1000;

/**
 * The value of the `bot.category_colors` setting: one inline-button style per product
 * category, keyed by the category's ID — never its name, which the operator renames.
 *
 * The palette is the inline button's own (`INLINE_BUTTON_STYLES`): Telegram draws exactly
 * those four, so a colour outside them is refused here rather than stored and silently not
 * drawn. A category absent from the value has no colour of its own and is drawn with the
 * fallback (`categoryButtonStyleOf`). An id naming a category since deleted is harmless: no
 * button is drawn for it.
 */
export const categoryColorsSchema = z
  .record(
    z.string().regex(CATEGORY_COLOR_KEY_PATTERN, { message: 'a category id in lower case' }),
    z.enum(INLINE_BUTTON_STYLES),
  )
  .refine((value) => Object.keys(value).length <= CATEGORY_COLORS_MAX, {
    message: `at most ${String(CATEGORY_COLORS_MAX)} categories carry their own colour`,
  });
export type CategoryColors = Readonly<Record<string, InlineButtonStyle>>;

/**
 * The style one category's button is drawn with — the ONE rule, shared by the bot and the
 * Web Admin's preview:
 *
 *  1. the category's own colour (`bot.category_colors`), when it has one;
 *  2. otherwise the style of the generic category button (`catalog.category` in
 *     `bot.inline_buttons`), which is what every category was drawn with before item 2;
 *  3. otherwise that button's registry default, `default` — no style on the wire.
 */
export function categoryButtonStyleOf(
  categoryId: string,
  colors: CategoryColors,
  styles: InlineButtonStyles,
): InlineButtonStyle {
  const id = categoryId.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(colors, id)) {
    const own = colors[id];
    if (own !== undefined) return own;
  }
  return inlineButtonStyleOf('catalog.category', styles);
}

// ---------------------------------------------------------------------------
// Per-category decorations (Phase 2 UX wave, Item 2)
// ---------------------------------------------------------------------------

/**
 * The longest "after" emoji, in code points: the bound `product_categories.emoji` already
 * uses (`PRODUCT_CATEGORY_EMOJI_MAX_CODE_POINTS`), so the two decorations of one button are
 * held to the same size. A ZWJ family (7) or a subdivision flag (7) fits; a sentence does not.
 */
export const CATEGORY_AFTER_EMOJI_MAX_CODE_POINTS = 8;

/*
 * The grammar of an "after" emoji: one or more emoji ELEMENTS, nothing between them. Each
 * combining code point is accepted only where it belongs, never on its own (review of #217):
 *
 * - a keycap: `#`, `*` or a digit, an optional VS16, then U+20E3 — a digit is never text;
 * - a subdivision flag: 🏴, one or more tag characters, then the CANCEL TAG U+E007F — tag
 *   characters (invisible ASCII) are never accepted after any other pictograph;
 * - a flag: exactly two regional indicators;
 * - a pictograph with an optional VS16 and an optional skin tone, joined to more by ZWJ.
 *
 * No letter, space, `<`, `&`, control, bidi or zero-width character fits anywhere, so the
 * value can never carry markup, a line break or a direction override.
 */
const KEYCAP = String.raw`[#*0-9]\uFE0F?\u20E3`;
const TAG_FLAG = String.raw`\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}`;
const FLAG = String.raw`\p{Regional_Indicator}{2}`;
const PICTOGRAPH = String.raw`\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?`;
const AFTER_EMOJI = new RegExp(
  String.raw`^(?:${KEYCAP}|${TAG_FLAG}|${FLAG}|${PICTOGRAPH}(?:\u200D${PICTOGRAPH})*)+$`,
  'u',
);

/**
 * Whether `value` is an ordinary Unicode emoji fit to follow a category's name on its button.
 *
 * Unlike `isValidCategoryEmoji` (deliberately any short text), this IS an emoji check: the
 * owner's Item 2 asks for an emoji after the name and nothing else, and the button's text is
 * tenant data on the wire. `Extended_Pictographic` reserves the unassigned code points of the
 * emoji blocks too, so an emoji newer than this runtime's tables is still accepted.
 */
export function isValidCategoryAfterEmoji(value: string): boolean {
  const points = [...value];
  if (points.length === 0 || points.length > CATEGORY_AFTER_EMOJI_MAX_CODE_POINTS) return false;
  return AFTER_EMOJI.test(value);
}

export const categoryAfterEmojiSchema = z.string().refine(isValidCategoryAfterEmoji, {
  message: `an ordinary emoji, at most ${String(CATEGORY_AFTER_EMOJI_MAX_CODE_POINTS)} code points, nothing else`,
});

/**
 * One category's decorations. Both optional and independent; an entry with neither is
 * refused (removing both is removing the key), so a stored value has one spelling.
 *
 * - `before`: a Telegram custom emoji id (`customEmojiIdSchema`, digits only), drawn as the
 *   button's `icon_custom_emoji_id` — Telegram's ONE premium icon per button, shown BEFORE the
 *   text, and only from a bot whose appearance test succeeded.
 * - `after`: an ORDINARY Unicode emoji appended to the text. Telegram has no premium "after"
 *   on a button (its text carries no entities), so this is the closest correct
 *   representation, and it is never drawn as, or called, a premium emoji.
 */
export const categoryIconSchema = z
  .object({
    before: customEmojiIdSchema.optional(),
    after: categoryAfterEmojiSchema.optional(),
  })
  .strict()
  .refine((value) => value.before !== undefined || value.after !== undefined, {
    message: 'a category entry carries before, after or both',
  });
export type CategoryIcon = { readonly before?: string; readonly after?: string };

/**
 * The value of the `bot.category_icons` setting: each product category's decorations, keyed
 * by the category's ID (the `bot.category_colors` key rule and bound). A category absent
 * from the value is drawn exactly as before Item 2. An id naming a category since deleted is
 * harmless: no button is drawn for it.
 */
export const categoryIconsSchema = z
  .record(
    z.string().regex(CATEGORY_COLOR_KEY_PATTERN, { message: 'a category id in lower case' }),
    categoryIconSchema,
  )
  .refine((value) => Object.keys(value).length <= CATEGORY_COLORS_MAX, {
    message: `at most ${String(CATEGORY_COLORS_MAX)} categories carry their own icons`,
  });
export type CategoryIcons = Readonly<Record<string, CategoryIcon>>;

/** One category's own decorations, each null when absent. */
export function categoryIconOf(
  categoryId: string,
  icons: CategoryIcons,
): { readonly before: string | null; readonly after: string | null } {
  const id = categoryId.toLowerCase();
  const own = Object.prototype.hasOwnProperty.call(icons, id) ? icons[id] : undefined;
  const before = own?.before;
  const after = own?.after;
  return {
    before: before === undefined || before === '' ? null : before,
    after: after === undefined || after === '' ? null : after,
  };
}

/**
 * The premium icon one category's button carries — the ONE rule, shared by the bot and the
 * Web Admin's preview, and the icon twin of `categoryButtonStyleOf`:
 *
 *  1. the category's own `before` (`bot.category_icons`), when it has one;
 *  2. otherwise the generic category button's icon (`catalog.category` in
 *     `bot.inline_button_icons`, Item 3);
 *  3. otherwise none.
 *
 * Eligibility is NOT decided here: a caller draws the result only from a bot that may carry
 * custom emoji.
 */
export function categoryButtonIconOf(
  categoryId: string,
  icons: CategoryIcons,
  inlineIcons: InlineButtonIcons,
): string | null {
  return (
    categoryIconOf(categoryId, icons).before ?? inlineButtonIconOf('catalog.category', inlineIcons)
  );
}

/**
 * A category button's text with its `after` emoji: the label, one space, the emoji. With no
 * `after` it is the label, unchanged byte for byte.
 */
export function categoryButtonText(label: string, after: string | null): string {
  return after === null ? label : `${label} ${after}`;
}
