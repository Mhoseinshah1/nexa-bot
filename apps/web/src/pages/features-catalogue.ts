import type { FeatureFlagKey } from '@nexa/contracts';
import type { WebKey } from '../i18n/web.fa';

/**
 * How the Features page presents each flag to an operator (WP-A2).
 *
 * The frozen registry in `@nexa/contracts` says what a flag IS: its key, its default, the
 * settings it governs. This says how it reads on the screen: a Persian name, one practical
 * sentence, and whether switching it OFF (or, rarely, ON) deserves a plain confirmation
 * first. It is kept out of the contract because none of it changes what the server does. The server
 * refuses no toggle for want of a confirmation; the modal is a courtesy to the operator,
 * not a safeguard.
 *
 * `Record<FeatureFlagKey, …>` rather than a partial map, so a flag added to the registry
 * without a Persian name fails the build here instead of reaching an operator as a bare
 * machine key. Literal `web.*` keys, never assembled from the flag key, because
 * `check:i18n` proves a catalogue key is rendered by finding it quoted in the source.
 */
export interface FeaturePresentation {
  readonly title: WebKey;
  readonly summary: WebKey;
  /**
   * What switching this feature OFF does, said in the confirmation modal. `null` means
   * the switch-off takes one click and no confirmation.
   *
   * A feature gets a sentence here when switching it off does one of these:
   * - it silently stops something that customers or operators rely on without asking
   *   for it;
   * - what happens while it is off cannot be made up for by switching it back on.
   *
   * Switching off a feature that only withdraws an offer from customers (a button, a new
   * way to buy) is not sensitive. Nothing already under way is lost, and switching it
   * back on restores it exactly.
   */
  readonly disableEffect: WebKey | null;
  /**
   * What switching this feature ON asks first, or `null` for one click.
   *
   * Most features only offer something when on, so turning one on needs no question. A
   * feature whose switch-ON stops customers at once (`terms_enforcement`: everyone who has
   * not accepted the current terms is held at the gate) asks here with the SAME words as
   * its own page, so the two paths to one switch cannot be one guarded and one not.
   */
  readonly confirmEnable: EnableConfirmation | null;
}

/** The enable-confirmation's wording: the question, the consequence and the yes button. */
export interface EnableConfirmation {
  readonly question: WebKey;
  readonly detail: WebKey;
  readonly confirmLabel: WebKey;
}

export const FEATURE_PRESENTATION: Readonly<Record<FeatureFlagKey, FeaturePresentation>> = {
  // Off: operational events are not queued at all while it is off, so nothing written
  // in the meantime is ever delivered.
  ops_notifications: {
    title: 'web.feature_ops_notifications_title',
    summary: 'web.feature_ops_notifications_summary',
    disableEffect: 'web.feature_ops_notifications_off_effect',
    confirmEnable: null,
  },
  // Off: every customer-facing message changes at once, including any the tenant
  // rewrote to carry its own instructions.
  template_overrides: {
    title: 'web.feature_template_overrides_title',
    summary: 'web.feature_template_overrides_summary',
    disableEffect: 'web.feature_template_overrides_off_effect',
    confirmEnable: null,
  },
  // The three reminder families: off, every customer with a dated or metered service
  // silently stops being warned, and a threshold crossed while off is not sent later.
  service_expiry_reminders: {
    title: 'web.feature_service_expiry_reminders_title',
    summary: 'web.feature_service_expiry_reminders_summary',
    disableEffect: 'web.feature_service_expiry_reminders_off_effect',
    confirmEnable: null,
  },
  service_expired_notice: {
    title: 'web.feature_service_expired_notice_title',
    summary: 'web.feature_service_expired_notice_summary',
    disableEffect: 'web.feature_service_expired_notice_off_effect',
    confirmEnable: null,
  },
  service_usage_reminders: {
    title: 'web.feature_service_usage_reminders_title',
    summary: 'web.feature_service_usage_reminders_summary',
    disableEffect: 'web.feature_service_usage_reminders_off_effect',
    confirmEnable: null,
  },
  // WP-A9: the three reminder switches it added. Off, like the families above, customers
  // silently stop being told something they did not ask for and rely on.
  service_expiry_day_reminder: {
    title: 'web.feature_service_expiry_day_reminder_title',
    summary: 'web.feature_service_expiry_day_reminder_summary',
    disableEffect: 'web.feature_service_expiry_day_reminder_off_effect',
    confirmEnable: null,
  },
  wallet_low_balance_reminders: {
    title: 'web.feature_wallet_low_balance_reminders_title',
    summary: 'web.feature_wallet_low_balance_reminders_summary',
    disableEffect: 'web.feature_wallet_low_balance_reminders_off_effect',
    confirmEnable: null,
  },
  payment_pending_reminders: {
    title: 'web.feature_payment_pending_reminders_title',
    summary: 'web.feature_payment_pending_reminders_summary',
    disableEffect: 'web.feature_payment_pending_reminders_off_effect',
    confirmEnable: null,
  },
  // Round N, package D. Off, resellers are simply not told; nothing else depends on it.
  reseller_minimum_reminders: {
    title: 'web.feature_reseller_minimum_reminders_title',
    summary: 'web.feature_reseller_minimum_reminders_summary',
    disableEffect: null,
    confirmEnable: null,
  },
  reseller_minimum_achieved_notices: {
    title: 'web.feature_reseller_minimum_achieved_notices_title',
    summary: 'web.feature_reseller_minimum_achieved_notices_summary',
    disableEffect: null,
    confirmEnable: null,
  },
  // HF-A9. Off loses nothing: a held reminder is simply sent at its next claim.
  reminder_quiet_hours: {
    title: 'web.feature_reminder_quiet_hours_title',
    summary: 'web.feature_reminder_quiet_hours_summary',
    disableEffect: null,
    confirmEnable: null,
  },
  // Off withdraws the button; a rotation already planned still runs.
  customer_link_rotation: {
    title: 'web.feature_customer_link_rotation_title',
    summary: 'web.feature_customer_link_rotation_summary',
    disableEffect: null,
    confirmEnable: null,
  },
  // Off withdraws the button; requests already filed can still be decided.
  customer_refund_requests: {
    title: 'web.feature_customer_refund_requests_title',
    summary: 'web.feature_customer_refund_requests_summary',
    disableEffect: null,
    confirmEnable: null,
  },
  // Spec §9. Off hides the button and makes /stop change nothing; stored choices are kept
  // and become effective again when it is turned back on.
  customer_marketing_opt_out: {
    title: 'web.feature_customer_marketing_opt_out_title',
    summary: 'web.feature_customer_marketing_opt_out_summary',
    disableEffect: 'web.feature_customer_marketing_opt_out_off_effect',
    confirmEnable: null,
  },
  // Off: an attribution is made only at registration and never afterwards, so a
  // customer who joins through a referral link while this is off is never attributed.
  referrals: {
    title: 'web.feature_referrals_title',
    summary: 'web.feature_referrals_summary',
    disableEffect: 'web.feature_referrals_off_effect',
    confirmEnable: null,
  },
  // Off refuses new claims; shares already credited stay, and unclaimed ones can be
  // claimed once it is back on.
  referral_signup_gift: {
    title: 'web.feature_referral_signup_gift_title',
    summary: 'web.feature_referral_signup_gift_summary',
    disableEffect: null,
    confirmEnable: null,
  },
  // R10 D5 (b). ON makes every unclaimed gift wait for its referee's first paid purchase, at
  // once, so it asks first; nothing already paid is touched either way. Off restores the old
  // rule with nothing to undo, so one click.
  referral_abuse_guard: {
    title: 'web.feature_referral_abuse_guard_title',
    summary: 'web.feature_referral_abuse_guard_summary',
    disableEffect: null,
    confirmEnable: {
      question: 'web.referral_abuse_guard_confirm_question',
      detail: 'web.referral_abuse_guard_confirm_detail',
      confirmLabel: 'web.referral_abuse_guard_confirm',
    },
  },
  // R10 D5 (a). ON asks only customers who arrive from then on; nobody already here is
  // stopped, so one click. Off lets everyone still waiting through at once — also one click.
  start_captcha: {
    title: 'web.feature_start_captcha_title',
    summary: 'web.feature_start_captcha_summary',
    disableEffect: null,
    confirmEnable: null,
  },
  // Off: new drafts go to their product's own panel again; nothing already placed moves.
  panel_auto_balancing: {
    title: 'web.feature_panel_auto_balancing_title',
    summary: 'web.feature_panel_auto_balancing_summary',
    disableEffect: null,
    // On only changes where NEW drafts land, among panels an operator grouped; it stops
    // nobody, so one click.
    confirmEnable: null,
  },
  // Off withdraws the button; orders already confirmed are still paid for and delivered.
  custom_service: {
    title: 'web.feature_custom_service_title',
    summary: 'web.feature_custom_service_summary',
    disableEffect: null,
    confirmEnable: null,
  },
  // Off: every route priced by the central rate refuses NEW invoices at once (an issued
  // invoice keeps its own snapshot), and the Stars route in its central mode stops selling
  // until the feature is back on or the mode is switched back to the fixed rate.
  central_fx: {
    title: 'web.feature_central_fx_title',
    summary: 'web.feature_central_fx_summary',
    disableEffect: 'web.feature_central_fx_off_effect',
    confirmEnable: null,
  },
  // Program §6. Off lets every customer through at once; no acceptance is erased, and
  // turning it back on asks only those who have not accepted the current version. ON stops
  // every customer who has not accepted at once, so it asks first — in the terms page's
  // own words (Codex 4172817735).
  terms_enforcement: {
    title: 'web.feature_terms_enforcement_title',
    summary: 'web.feature_terms_enforcement_summary',
    disableEffect: null,
    confirmEnable: {
      question: 'web.terms_enforce_confirm_question',
      detail: 'web.terms_enforce_confirm_detail',
      confirmLabel: 'web.terms_enforce_confirm',
    },
  },
  // R4 PR-F. Off sends every screen the ordinary way again at once, and nothing is lost:
  // a screen already sent as a rich message is edited the ordinary way, or sent anew.
  rich_messages: {
    title: 'web.feature_rich_messages_title',
    summary: 'web.feature_rich_messages_summary',
    disableEffect: null,
    confirmEnable: null,
  },
  // R5C-2 B2: the plan table is its own switch, off by default; off is the plain plan list.
  rich_plan_table: {
    title: 'web.feature_rich_plan_table_title',
    summary: 'web.feature_rich_plan_table_summary',
    disableEffect: null,
    confirmEnable: null,
  },
  rich_premium_emoji: {
    title: 'web.feature_rich_premium_emoji_title',
    summary: 'web.feature_rich_premium_emoji_summary',
    disableEffect: null,
    confirmEnable: null,
  },
  // R4 A4: off by default — accept once, never asked again. Turning it ON stops every
  // customer who has not accepted the newest version, so it asks first.
  terms_reprompt_on_new_version: {
    title: 'web.feature_terms_reprompt_title',
    summary: 'web.feature_terms_reprompt_summary',
    disableEffect: null,
    confirmEnable: {
      question: 'web.feature_terms_reprompt_confirm_question',
      detail: 'web.feature_terms_reprompt_confirm_detail',
      confirmLabel: 'web.terms_enforce_confirm',
    },
  },
  // R4 A5: switching either off silently stops telling customers about a manual adjustment.
  wallet_admin_credit_notice: {
    title: 'web.feature_wallet_admin_credit_notice_title',
    summary: 'web.feature_wallet_admin_credit_notice_summary',
    disableEffect: 'web.feature_wallet_admin_notice_off_effect',
    confirmEnable: null,
  },
  wallet_admin_debit_notice: {
    title: 'web.feature_wallet_admin_debit_notice_title',
    summary: 'web.feature_wallet_admin_debit_notice_summary',
    disableEffect: 'web.feature_wallet_admin_notice_off_effect',
    confirmEnable: null,
  },
  // R5C-1 item 4: off hides time packages from the renewal menu only; they stay purchasable.
  addon_time_in_renew_menu: {
    title: 'web.feature_addon_time_in_renew_menu_title',
    summary: 'web.feature_addon_time_in_renew_menu_summary',
    // A display choice: nothing is lost by switching it off, so it does not ask first.
    disableEffect: null,
    confirmEnable: null,
  },
  // R10 D3: off withdraws an offer (every price is the ordinary one again); nothing is lost.
  personal_discount: {
    title: 'web.feature_personal_discount_title',
    summary: 'web.feature_personal_discount_summary',
    disableEffect: null,
    confirmEnable: null,
  },
  // R10 C2: off refuses NEW custom panels only; existing ones keep operating, so nothing is
  // lost by switching it off and it does not ask first.
  custom_panel_provider: {
    title: 'web.feature_custom_panel_provider_title',
    summary: 'web.feature_custom_panel_provider_summary',
    disableEffect: null,
    confirmEnable: null,
  },
  // Round 9, C5: the customer mini app. Off withdraws the menu button and ends new sessions.
  mini_app: {
    title: 'web.feature_mini_app_title',
    summary: 'web.feature_mini_app_summary',
    disableEffect: 'web.feature_mini_app_off_effect',
    confirmEnable: null,
  },
  // R10 D4: gift cards. Off stops redemptions; a code whose expiry passes meanwhile is lost.
  gift_cards: {
    title: 'web.feature_gift_cards_title',
    summary: 'web.feature_gift_cards_summary',
    disableEffect: 'web.feature_gift_cards_off_effect',
    confirmEnable: null,
  },
  // R10 D2: owner-defined main-menu buttons. Off hides them; nothing is lost, so it does not ask.
  custom_menu_buttons: {
    title: 'web.feature_custom_menu_buttons_title',
    summary: 'web.feature_custom_menu_buttons_summary',
    disableEffect: null,
    confirmEnable: null,
  },
  // R11 B3: the mini app's invited-friends list. Read-only, no money moves and nothing is sent, so
  // neither switching it on nor off asks, and off only hides the section.
  referral_friends_list: {
    title: 'web.feature_referral_friends_list_title',
    summary: 'web.feature_referral_friends_list_summary',
    disableEffect: null,
    confirmEnable: null,
  },
  // Round 10, D1: off stops every automatic renewal at once; customers who opted in are not renewed.
  service_auto_renew: {
    title: 'web.feature_service_auto_renew_title',
    summary: 'web.feature_service_auto_renew_summary',
    disableEffect: 'web.feature_service_auto_renew_off_effect',
    confirmEnable: null,
  },
};

/**
 * The presentation for a key the server sent, or `undefined` for one this build does not
 * know. That happens when a newer server has registered a flag that this page has not
 * been given yet. The page then falls back to the server's own description, and asks
 * before switching such a flag off, because nothing here can say it is harmless.
 */
export function featurePresentation(key: string): FeaturePresentation | undefined {
  return Object.prototype.hasOwnProperty.call(FEATURE_PRESENTATION, key)
    ? FEATURE_PRESENTATION[key as FeatureFlagKey]
    : undefined;
}
