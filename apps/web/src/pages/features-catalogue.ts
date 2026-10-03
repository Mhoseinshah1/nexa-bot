import type { FeatureFlagKey } from '@nexa/contracts';
import type { WebKey } from '../i18n/web.fa';

/**
 * How the Features page presents each flag to an operator (WP-A2).
 *
 * The frozen registry in `@nexa/contracts` says what a flag IS: its key, its default, the
 * settings it governs. This says how it reads on the screen: a Persian name, one practical
 * sentence, and whether switching it OFF deserves a plain confirmation first. It is kept
 * out of the contract because none of it changes what the server does. The server
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
}

export const FEATURE_PRESENTATION: Readonly<Record<FeatureFlagKey, FeaturePresentation>> = {
  // Off: operational events are not queued at all while it is off, so nothing written
  // in the meantime is ever delivered.
  ops_notifications: {
    title: 'web.feature_ops_notifications_title',
    summary: 'web.feature_ops_notifications_summary',
    disableEffect: 'web.feature_ops_notifications_off_effect',
  },
  // Off: every customer-facing message changes at once, including any the tenant
  // rewrote to carry its own instructions.
  template_overrides: {
    title: 'web.feature_template_overrides_title',
    summary: 'web.feature_template_overrides_summary',
    disableEffect: 'web.feature_template_overrides_off_effect',
  },
  // The three reminder families: off, every customer with a dated or metered service
  // silently stops being warned, and a threshold crossed while off is not sent later.
  service_expiry_reminders: {
    title: 'web.feature_service_expiry_reminders_title',
    summary: 'web.feature_service_expiry_reminders_summary',
    disableEffect: 'web.feature_service_expiry_reminders_off_effect',
  },
  service_expired_notice: {
    title: 'web.feature_service_expired_notice_title',
    summary: 'web.feature_service_expired_notice_summary',
    disableEffect: 'web.feature_service_expired_notice_off_effect',
  },
  service_usage_reminders: {
    title: 'web.feature_service_usage_reminders_title',
    summary: 'web.feature_service_usage_reminders_summary',
    disableEffect: 'web.feature_service_usage_reminders_off_effect',
  },
  // WP-A9: the three reminder switches it added. Off, like the families above, customers
  // silently stop being told something they did not ask for and rely on.
  service_expiry_day_reminder: {
    title: 'web.feature_service_expiry_day_reminder_title',
    summary: 'web.feature_service_expiry_day_reminder_summary',
    disableEffect: 'web.feature_service_expiry_day_reminder_off_effect',
  },
  wallet_low_balance_reminders: {
    title: 'web.feature_wallet_low_balance_reminders_title',
    summary: 'web.feature_wallet_low_balance_reminders_summary',
    disableEffect: 'web.feature_wallet_low_balance_reminders_off_effect',
  },
  payment_pending_reminders: {
    title: 'web.feature_payment_pending_reminders_title',
    summary: 'web.feature_payment_pending_reminders_summary',
    disableEffect: 'web.feature_payment_pending_reminders_off_effect',
  },
  // Round N, package D. Off, resellers are simply not told; nothing else depends on it.
  reseller_minimum_reminders: {
    title: 'web.feature_reseller_minimum_reminders_title',
    summary: 'web.feature_reseller_minimum_reminders_summary',
    disableEffect: null,
  },
  reseller_minimum_achieved_notices: {
    title: 'web.feature_reseller_minimum_achieved_notices_title',
    summary: 'web.feature_reseller_minimum_achieved_notices_summary',
    disableEffect: null,
  },
  // HF-A9. Off loses nothing: a held reminder is simply sent at its next claim.
  reminder_quiet_hours: {
    title: 'web.feature_reminder_quiet_hours_title',
    summary: 'web.feature_reminder_quiet_hours_summary',
    disableEffect: null,
  },
  // Off withdraws the button; a rotation already planned still runs.
  customer_link_rotation: {
    title: 'web.feature_customer_link_rotation_title',
    summary: 'web.feature_customer_link_rotation_summary',
    disableEffect: null,
  },
  // Off withdraws the button; requests already filed can still be decided.
  customer_refund_requests: {
    title: 'web.feature_customer_refund_requests_title',
    summary: 'web.feature_customer_refund_requests_summary',
    disableEffect: null,
  },
  // Spec §9. Off hides the button and makes /stop change nothing; stored choices are kept
  // and become effective again when it is turned back on.
  customer_marketing_opt_out: {
    title: 'web.feature_customer_marketing_opt_out_title',
    summary: 'web.feature_customer_marketing_opt_out_summary',
    disableEffect: 'web.feature_customer_marketing_opt_out_off_effect',
  },
  // Off: an attribution is made only at registration and never afterwards, so a
  // customer who joins through a referral link while this is off is never attributed.
  referrals: {
    title: 'web.feature_referrals_title',
    summary: 'web.feature_referrals_summary',
    disableEffect: 'web.feature_referrals_off_effect',
  },
  // Off refuses new claims; shares already credited stay, and unclaimed ones can be
  // claimed once it is back on.
  referral_signup_gift: {
    title: 'web.feature_referral_signup_gift_title',
    summary: 'web.feature_referral_signup_gift_summary',
    disableEffect: null,
  },
  // Off withdraws the button; orders already confirmed are still paid for and delivered.
  custom_service: {
    title: 'web.feature_custom_service_title',
    summary: 'web.feature_custom_service_summary',
    disableEffect: null,
  },
  // Off: every route priced by the central rate refuses NEW invoices at once (an issued
  // invoice keeps its own snapshot), and the Stars route in its central mode stops selling
  // until the feature is back on or the mode is switched back to the fixed rate.
  central_fx: {
    title: 'web.feature_central_fx_title',
    summary: 'web.feature_central_fx_summary',
    disableEffect: 'web.feature_central_fx_off_effect',
  },
  // Program §6. Off lets every customer through at once; no acceptance is erased, and
  // turning it back on asks only those who have not accepted the current version.
  terms_enforcement: {
    title: 'web.feature_terms_enforcement_title',
    summary: 'web.feature_terms_enforcement_summary',
    disableEffect: null,
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
