import {
  BACKUP_SCHEDULE_SETTING_KEYS,
  isSettingKey,
  settingIntegerRange,
  type FxFallbackSource,
  type FxSource,
  type OperationalSeverity,
  type PanelBalancingStrategy,
  type ReferralCommissionScope,
  type SettingKey,
  type StarsPricingMode,
} from '@nexa/contracts';
import type { WebKey } from './i18n/web.fa';

/**
 * How the Settings page presents each registry key to an operator (WP-A1).
 *
 * The registry in `@nexa/contracts` says what a key IS — its schema, default and
 * consumer — in English written for engineers. This says how an operator SEES it: a
 * Persian title, a short Persian description, the group it sits in and the control that
 * edits it. The two are kept apart on purpose. The contract is language-neutral and
 * frozen; the Persian copy is web chrome, lives in the web catalogue under `web.*` like
 * every other admin string, and changes without a contract commit.
 *
 * TOTAL over `SettingKey`, not partial. A key added to the registry without an entry
 * here is a compile error, so no setting can reach an operator titled by its machine
 * key or described in English. The previous map was partial by design and seventeen of
 * twenty-five keys were shown bare.
 *
 * Every string is a LITERAL `web.*` key rather than one assembled from the setting key:
 * `check:i18n` proves each catalogue key is rendered by finding it in the source, and a
 * key built at runtime is invisible to it.
 *
 * Presentation only. Nothing here changes what a key accepts or does; the server
 * validates every write against the registry whatever the control offers.
 */

export const SETTING_GROUPS = [
  'sales',
  'wallet',
  'services',
  'reminders',
  'trial',
  'referral',
  'support',
  'fx',
  'ops',
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

export const SETTING_GROUP_TITLES: Readonly<Record<SettingGroup, WebKey>> = {
  sales: 'web.settings_group_sales',
  wallet: 'web.settings_group_wallet',
  services: 'web.settings_group_services',
  reminders: 'web.settings_group_reminders',
  trial: 'web.settings_group_trial',
  referral: 'web.settings_group_referral',
  support: 'web.settings_group_support',
  fx: 'web.settings_group_fx',
  ops: 'web.settings_group_ops',
};

export interface SelectOption {
  readonly value: string;
  readonly label: WebKey;
}

/**
 * The control that edits a key.
 *
 * - `integer`: a numeric field. Its range comes from the key's schema
 *   (`settingIntegerRange`), never from here. `optional` means an empty field is stored
 *   as null — the schema's own "not set".
 * - `text`: a plain left-to-right field, for the one free-form identifier left and the
 *   quiet window's two `HH:MM` times (HF-A9), which the registry's schema validates.
 * - `select`: a closed set of values, each with a Persian label.
 * - the rest are the dedicated editors a structured value needs: a currency picker,
 *   money (amount and currency), and a list of money, of Telegram handles and of channels.
 *   (The product picker went with `trial.product_id`'s retirement, F5.)
 *
 * There is no boolean and no secret control because the registry holds neither: a
 * switch is a feature flag, not a setting, and a credential is never a setting
 * (`holds no credential` in the registry test).
 */
export type SettingControl =
  | { readonly kind: 'integer'; readonly unit?: WebKey; readonly optional?: true }
  | { readonly kind: 'text' }
  /**
   * A decimal typed left to right. Persian and Arabic-Indic digits and the Arabic decimal
   * separator (`٫`) are normalised as they are typed, so the figure the description shows
   * as an example is one the registry's Latin-only pattern accepts (Codex review of #122).
   */
  | { readonly kind: 'decimal' }
  | { readonly kind: 'select'; readonly options: readonly SelectOption[] }
  | { readonly kind: 'currency' }
  | { readonly kind: 'money' }
  | { readonly kind: 'money_list' }
  | { readonly kind: 'handle_list' }
  | { readonly kind: 'channel_list' };

/**
 * Registry keys with a page of their own, which the Settings page does not draw (R1):
 * the main menu's arrangement is a list with an order and switches, edited on the
 * «دکمه‌های ربات» page beside the labels it arranges.
 */
export const SETTINGS_MANAGED_ELSEWHERE: readonly SettingKey[] = [
  'bot.main_menu',
  // Owner spec §6: the inline buttons' styles, on the same page («دکمه‌های شیشه‌ای ربات»).
  'bot.inline_buttons',
  // Phase 2 Item 3: the inline buttons' optional premium icons, beside their styles.
  'bot.inline_button_icons',
  // UX Batch 01, item 2: each category's colour, on «🎨 ظاهر ربات» beside the categories.
  'bot.category_colors',
  // Spec 13.2: the automatic backup schedule is edited on «بکاپ و بازیابی», beside the
  // backups it schedules, as a switch and an interval with a unit — never raw minutes.
  BACKUP_SCHEDULE_SETTING_KEYS.enabled,
  BACKUP_SCHEDULE_SETTING_KEYS.intervalMinutes,
];

/**
 * Retired registry keys, drawn on no page (F5). Each is `consumer: 'PLANNED'` in the
 * registry — stored, and read by nothing — and stays declared only so a value stored
 * before its retirement keeps parsing. A row for it would be a control that changes
 * nothing, which is the one thing this screen must never offer.
 *
 * `trial.product_id` (R1): a trial is configured on each panel's «سرویس تست» tab.
 * `stars.pricing_mode` (spec §8): Stars are always priced by the central rate.
 */
export const SETTINGS_RETIRED: readonly SettingKey[] = ['trial.product_id', 'stars.pricing_mode'];

export interface SettingPresentation {
  readonly title: WebKey;
  readonly description: WebKey;
  readonly group: SettingGroup;
  readonly control: SettingControl;
}

/** Keyed by the contract's own union, so a missing severity is a compile error. */
const SEVERITY_LABELS: Readonly<Record<OperationalSeverity, WebKey>> = {
  DEBUG: 'web.setting_severity_debug',
  INFO: 'web.setting_severity_info',
  WARN: 'web.setting_severity_warn',
  ERROR: 'web.setting_severity_error',
  CRITICAL: 'web.setting_severity_critical',
};

const COMMISSION_SCOPE_OPTIONS: Readonly<Record<ReferralCommissionScope, WebKey>> = {
  FIRST_PAID_ORDER: 'web.referral_trigger_first_paid_order',
  EVERY_PAID_ORDER: 'web.referral_trigger_every_paid_order',
};

function options(labels: Readonly<Record<string, WebKey>>): readonly SelectOption[] {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}

/** Package FX: the two sources, and "none" for the fallback only. */
/** Phase C3: the two ranking strategies of automatic panel balancing. */
const BALANCING_STRATEGY_OPTIONS: Readonly<Record<PanelBalancingStrategy, WebKey>> = {
  LEAST_USED: 'web.balancing_strategy_least_used',
  LOWEST_UTILISATION: 'web.balancing_strategy_lowest_utilisation',
};

const FX_SOURCE_OPTIONS: Readonly<Record<FxSource, WebKey>> = {
  NOBITEX: 'web.fx_source_nobitex',
  WALLEX: 'web.fx_source_wallex',
};
const FX_FALLBACK_OPTIONS: Readonly<Record<FxFallbackSource, WebKey>> = {
  ...FX_SOURCE_OPTIONS,
  NONE: 'web.fx_source_none',
};
const STARS_PRICING_MODE_OPTIONS: Readonly<Record<StarsPricingMode, WebKey>> = {
  FIXED_RATE: 'web.fx_stars_mode_fixed',
  CENTRAL_FX_RATIO: 'web.fx_stars_mode_central',
};

export const SETTING_PRESENTATION: Readonly<Record<SettingKey, SettingPresentation>> = {
  /*
   * The operations-log destination. WP-A4 replaces these with a connected group and
   * managed topics, so they get the generic rendering and nothing built around typing
   * an id.
   */
  'ops.notifications.telegram_chat_id': {
    title: 'web.setting_ops_chat_id',
    description: 'web.setting_ops_chat_id_desc',
    group: 'ops',
    control: { kind: 'text' },
  },
  'ops.notifications.telegram_topic_id': {
    title: 'web.setting_ops_topic_id',
    description: 'web.setting_ops_topic_id_desc',
    group: 'ops',
    control: { kind: 'integer', optional: true },
  },
  'ops.notifications.payments_topic_id': {
    title: 'web.setting_ops_payments_topic_id',
    description: 'web.setting_ops_payments_topic_id_desc',
    group: 'ops',
    control: { kind: 'integer', optional: true },
  },
  'ops.notifications.min_severity': {
    title: 'web.setting_ops_min_severity',
    description: 'web.setting_ops_min_severity_desc',
    group: 'ops',
    control: { kind: 'select', options: options(SEVERITY_LABELS) },
  },
  'ops.notifications.max_attempts': {
    title: 'web.setting_ops_max_attempts',
    description: 'web.setting_ops_max_attempts_desc',
    group: 'ops',
    control: { kind: 'integer', unit: 'web.unit_times' },
  },
  'ops.notifications.max_per_minute': {
    title: 'web.setting_ops_max_per_minute',
    description: 'web.setting_ops_max_per_minute_desc',
    group: 'ops',
    control: { kind: 'integer', unit: 'web.unit_messages' },
  },
  /*
   * Spec 13.2. Drawn on the backup page (`SETTINGS_MANAGED_ELSEWHERE`); the entries exist
   * because this map is total.
   */
  'backup.schedule_enabled': {
    title: 'web.backup_schedule_auto',
    description: 'web.backup_schedule_hint',
    group: 'ops',
    control: {
      kind: 'select',
      options: [
        { value: 'true', label: 'web.backup_schedule_on' },
        { value: 'false', label: 'web.backup_schedule_off' },
      ],
    },
  },
  'backup.interval_minutes': {
    title: 'web.backup_schedule_interval',
    description: 'web.backup_schedule_hint',
    group: 'ops',
    control: { kind: 'integer', unit: 'web.unit_minutes', optional: true },
  },
  'sales.currency': {
    title: 'web.setting_sales_currency',
    description: 'web.setting_sales_currency_desc',
    group: 'sales',
    control: { kind: 'currency' },
  },
  'support.accounts': {
    title: 'web.setting_support_accounts',
    description: 'web.setting_support_accounts_desc',
    group: 'support',
    control: { kind: 'handle_list' },
  },
  'telegram.channels': {
    title: 'web.setting_telegram_channels',
    description: 'web.setting_telegram_channels_desc',
    group: 'support',
    control: { kind: 'channel_list' },
  },
  'sales.order_expiry_minutes': {
    title: 'web.setting_order_expiry_minutes',
    description: 'web.setting_order_expiry_minutes_desc',
    group: 'sales',
    control: { kind: 'integer', unit: 'web.unit_minutes' },
  },
  'sales.payment_window_minutes': {
    title: 'web.setting_payment_window_minutes',
    description: 'web.setting_payment_window_minutes_desc',
    group: 'sales',
    control: { kind: 'integer', unit: 'web.unit_minutes' },
  },
  'provisioning.usage_sync_minutes': {
    title: 'web.setting_usage_sync_minutes',
    description: 'web.setting_usage_sync_minutes_desc',
    group: 'services',
    control: { kind: 'integer', unit: 'web.unit_minutes' },
  },
  'wallet.topup.minimum': {
    title: 'web.setting_topup_minimum',
    description: 'web.setting_topup_minimum_desc',
    group: 'wallet',
    control: { kind: 'money' },
  },
  'wallet.topup.presets': {
    title: 'web.setting_topup_presets',
    description: 'web.setting_topup_presets_desc',
    group: 'wallet',
    control: { kind: 'money_list' },
  },
  'reminders.expiry_first_days': {
    title: 'web.setting_reminders_expiry_first_days',
    description: 'web.setting_reminders_expiry_first_days_desc',
    group: 'reminders',
    control: { kind: 'integer', unit: 'web.unit_days' },
  },
  'reminders.expiry_second_days': {
    title: 'web.setting_reminders_expiry_second_days',
    description: 'web.setting_reminders_expiry_second_days_desc',
    group: 'reminders',
    control: { kind: 'integer', unit: 'web.unit_days' },
  },
  'reminders.usage_first_percent': {
    title: 'web.setting_reminders_usage_first_percent',
    description: 'web.setting_reminders_usage_first_percent_desc',
    group: 'reminders',
    control: { kind: 'integer', unit: 'web.unit_percent' },
  },
  'reminders.usage_second_percent': {
    title: 'web.setting_reminders_usage_second_percent',
    description: 'web.setting_reminders_usage_second_percent_desc',
    group: 'reminders',
    control: { kind: 'integer', unit: 'web.unit_percent' },
  },
  'reminders.usage_final_percent': {
    title: 'web.setting_reminders_usage_final_percent',
    description: 'web.setting_reminders_usage_final_percent_desc',
    group: 'reminders',
    control: { kind: 'integer', unit: 'web.unit_percent' },
  },
  // WP-A9.
  'reminders.expiry_early_days': {
    title: 'web.setting_reminders_expiry_early_days',
    description: 'web.setting_reminders_expiry_early_days_desc',
    group: 'reminders',
    control: { kind: 'integer', unit: 'web.unit_days' },
  },
  'reminders.payment_pending_minutes': {
    title: 'web.setting_reminders_payment_pending_minutes',
    description: 'web.setting_reminders_payment_pending_minutes_desc',
    group: 'reminders',
    control: { kind: 'integer', unit: 'web.unit_minutes' },
  },
  // Round N, package D.
  'reminders.reseller_minimum_days': {
    title: 'web.setting_reminders_reseller_minimum_days',
    description: 'web.setting_reminders_reseller_minimum_days_desc',
    group: 'reminders',
    control: { kind: 'integer', unit: 'web.unit_days' },
  },
  // HF-A9: the quiet window, as the HH:MM text the registry stores. The reminders page
  // edits the same two keys with a time picker.
  'reminders.quiet_hours_start': {
    title: 'web.setting_reminders_quiet_hours_start',
    description: 'web.setting_reminders_quiet_hours_start_desc',
    group: 'reminders',
    control: { kind: 'text' },
  },
  'reminders.quiet_hours_end': {
    title: 'web.setting_reminders_quiet_hours_end',
    description: 'web.setting_reminders_quiet_hours_end_desc',
    group: 'reminders',
    control: { kind: 'text' },
  },
  'wallet.low_balance.threshold': {
    title: 'web.setting_wallet_low_balance_threshold',
    description: 'web.setting_wallet_low_balance_threshold_desc',
    group: 'wallet',
    control: { kind: 'money' },
  },
  /*
   * R1: the main menu's arrangement. Edited on the «دکمه‌های ربات» page, never here
   * (`SETTINGS_MANAGED_ELSEWHERE`); the entry exists because this map is total.
   */
  'bot.main_menu': {
    title: 'web.setting_bot_main_menu',
    description: 'web.setting_bot_main_menu_desc',
    group: 'support',
    control: { kind: 'text' },
  },
  /*
   * Owner spec §6: the inline buttons' styles. Edited on the «دکمه‌های ربات» page, never
   * here (`SETTINGS_MANAGED_ELSEWHERE`); the entry exists because this map is total.
   */
  'bot.inline_buttons': {
    title: 'web.setting_bot_inline_buttons',
    description: 'web.setting_bot_inline_buttons_desc',
    group: 'support',
    control: { kind: 'text' },
  },
  /*
   * Phase 2 Item 3: the inline buttons' optional premium icons. Edited on the «دکمه‌های ربات»
   * page beside the styles, never here (`SETTINGS_MANAGED_ELSEWHERE`); the entry exists
   * because this map is total.
   */
  'bot.inline_button_icons': {
    title: 'web.setting_bot_inline_button_icons',
    description: 'web.setting_bot_inline_button_icons_desc',
    group: 'support',
    control: { kind: 'text' },
  },
  /*
   * UX Batch 01, item 2: each category's colour. Edited on «🎨 ظاهر ربات», never here
   * (`SETTINGS_MANAGED_ELSEWHERE`); the entry exists because this map is total.
   */
  'bot.category_colors': {
    title: 'web.setting_bot_category_colors',
    description: 'web.setting_bot_category_colors_desc',
    group: 'support',
    control: { kind: 'text' },
  },
  /*
   * Retired by R1 and drawn nowhere since F5 (`SETTINGS_RETIRED`); the entry exists because
   * this map is total.
   */
  'trial.product_id': {
    title: 'web.setting_trial_product_id',
    description: 'web.setting_trial_product_id_desc',
    group: 'trial',
    control: { kind: 'text' },
  },
  'trial.limit_per_customer': {
    title: 'web.setting_trial_limit_per_customer',
    description: 'web.setting_trial_limit_per_customer_desc',
    group: 'trial',
    control: { kind: 'integer', unit: 'web.unit_times' },
  },
  'panels.balancing.strategy': {
    title: 'web.setting_panels_balancing_strategy',
    description: 'web.setting_panels_balancing_strategy_desc',
    group: 'services',
    control: { kind: 'select', options: options(BALANCING_STRATEGY_OPTIONS) },
  },
  'services.link_rotation_cooldown_hours': {
    title: 'web.setting_link_rotation_cooldown_hours',
    description: 'web.setting_link_rotation_cooldown_hours_desc',
    group: 'services',
    control: { kind: 'integer', unit: 'web.unit_hours' },
  },
  'referral.commission_percent': {
    title: 'web.setting_referral_commission_percent',
    description: 'web.setting_referral_commission_percent_desc',
    group: 'referral',
    control: { kind: 'integer', unit: 'web.unit_percent', optional: true },
  },
  'referral.commission_scope': {
    title: 'web.setting_referral_commission_scope',
    description: 'web.setting_referral_commission_scope_desc',
    group: 'referral',
    control: { kind: 'select', options: options(COMMISSION_SCOPE_OPTIONS) },
  },
  'referral.minimum_order_amount': {
    title: 'web.setting_referral_minimum_order_amount',
    description: 'web.setting_referral_minimum_order_amount_desc',
    group: 'referral',
    control: { kind: 'money' },
  },
  'wallet.topup.maximum': {
    title: 'web.setting_topup_maximum',
    description: 'web.setting_topup_maximum_desc',
    group: 'wallet',
    control: { kind: 'money' },
  },
  'referral.signup_gift.total': {
    title: 'web.setting_referral_signup_gift_total',
    description: 'web.setting_referral_signup_gift_total_desc',
    group: 'referral',
    control: { kind: 'money' },
  },
  'referral.signup_gift.referrer_percent': {
    title: 'web.setting_referral_signup_gift_referrer_percent',
    description: 'web.setting_referral_signup_gift_referrer_percent_desc',
    group: 'referral',
    control: { kind: 'integer', unit: 'web.unit_percent' },
  },
  'referral.signup_gift.referred_percent': {
    title: 'web.setting_referral_signup_gift_referred_percent',
    description: 'web.setting_referral_signup_gift_referred_percent_desc',
    group: 'referral',
    control: { kind: 'integer', unit: 'web.unit_percent' },
  },
  /*
   * Package FX: the central exchange rate and the Stars route's pricing mode. The live
   * figures (the rate in force, its age, the sources) are on the payment routes page;
   * this group holds only what an operator SETS.
   */
  'fx.primary_source': {
    title: 'web.setting_fx_primary_source',
    description: 'web.setting_fx_primary_source_desc',
    group: 'fx',
    control: { kind: 'select', options: options(FX_SOURCE_OPTIONS) },
  },
  'fx.fallback_source': {
    title: 'web.setting_fx_fallback_source',
    description: 'web.setting_fx_fallback_source_desc',
    group: 'fx',
    control: { kind: 'select', options: options(FX_FALLBACK_OPTIONS) },
  },
  'fx.fresh_ttl_seconds': {
    title: 'web.setting_fx_fresh_ttl_seconds',
    description: 'web.setting_fx_fresh_ttl_seconds_desc',
    group: 'fx',
    control: { kind: 'integer', unit: 'web.unit_seconds' },
  },
  'fx.max_stale_seconds': {
    title: 'web.setting_fx_max_stale_seconds',
    description: 'web.setting_fx_max_stale_seconds_desc',
    group: 'fx',
    control: { kind: 'integer', unit: 'web.unit_seconds' },
  },
  'stars.pricing_mode': {
    title: 'web.setting_stars_pricing_mode',
    description: 'web.setting_stars_pricing_mode_desc',
    group: 'fx',
    control: { kind: 'select', options: options(STARS_PRICING_MODE_OPTIONS) },
  },
  'stars.per_usdt': {
    title: 'web.setting_stars_per_usdt',
    description: 'web.setting_stars_per_usdt_desc',
    group: 'fx',
    // A decimal typed left to right, digits normalised; the registry's pattern validates it.
    control: { kind: 'decimal' },
  },
};

/**
 * How to present a key the server sent, or `null` when this bundle does not know it.
 *
 * `null` is reachable: a tab holding the previous release across a deploy receives a
 * key its registry never had. The page then gives it a Persian placeholder title rather
 * than its machine key, and keeps the key in the technical disclosure.
 */
export function settingPresentation(key: string): SettingPresentation | null {
  return isSettingKey(key) ? SETTING_PRESENTATION[key] : null;
}

/** The accepted whole-number range of an integer control, or null when it has none. */
export function integerRange(key: string): { readonly min: number; readonly max: number } | null {
  return isSettingKey(key) ? settingIntegerRange(key) : null;
}
