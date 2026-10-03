/**
 * The feature flag registry.
 *
 * A feature flag answers exactly one question: is this feature on for this
 * tenant. Its stored value is a boolean, and the schema gives it nowhere else to
 * put anything — no nested JSON, no parameters, no fourth shape. A feature's
 * CONFIGURATION lives in the settings registry, which already has schemas,
 * defaults, validation and declared zero semantics.
 *
 * That split is the whole point. CBR-011 finds four shapes behind the legacy
 * capability screen — scalar, menu of scalars, subsystem, CRUD collection — and
 * concludes that "modelling capabilities as a flat `map[string]bool` cannot
 * represent" three of them. The answer is not to widen the flag; it is to notice
 * that three of those four are settings wearing a toggle's clothes.
 *
 * Two further findings are answered by structure rather than by care:
 *
 *   - A flag and its parameter live on different screens. `⚠️ اعلان کاهش موجودی`
 *     is the flag; `⚠️ مبلغ هشدار موجودی` is its threshold, one menu up
 *     (CBR-007). Here the link is declared in both directions and asserted
 *     symmetric by a test, so a surface can show the whole chain at once.
 *   - Forced-join has no toggle at all: it "is enabled by adding at least one
 *     channel and can be disabled only by removing every channel" (GSR-004). An
 *     emergent enable state cannot be audited and cannot be switched off without
 *     deleting data. Every gate here has an explicit flag.
 *
 * See docs/adr/0019-feature-flags.md.
 */

/**
 * How much a toggle changes.
 *
 * The legacy capability screen renders the whole-bot kill switch identically to
 * the dice toggle (CBR-009). Blast radius is therefore declared, and travels to
 * every surface on the flag's response.
 *
 * It no longer gates the write. Until WP-A2 a `TENANT_WIDE` toggle was refused
 * unless the operator typed the flag's key and a reason; the owner removed both
 * (an operator must never type an internal key), and the audit row records actor,
 * time and action on its own. Which disables deserve a plain confirmation is a
 * presentation decision the Web Admin makes per flag — see
 * docs/adr/0019-feature-flags.md, "Amended by WP-A2".
 *
 * This is not a second permission. `settings.destructive` is for bulk
 * mutations, and turning a feature off is not one.
 */
export const FLAG_BLAST_RADII = ['LOCAL', 'TENANT_WIDE'] as const;
export type FlagBlastRadius = (typeof FLAG_BLAST_RADII)[number];

export interface FeatureFlagDefinition {
  readonly key: string;
  readonly description: string;
  readonly defaultEnabled: boolean;
  readonly blastRadius: FlagBlastRadius;
  /**
   * The settings that parameterise this feature.
   *
   * The other half of `SettingDefinition.configures`. Both halves are declared
   * and checked against each other, because the legacy pair drifted apart by
   * living on two screens with nothing connecting them.
   */
  readonly configuredBy: readonly string[];
}

/**
 * Registered flags.
 *
 * A flag exists here only when the code behind it is written and reachable.
 * Publishing a flag for a Phase 3 or Phase 5 feature would put a switch on an
 * administrator's screen that turns nothing on — which is worse than the feature
 * being absent, because an absent feature is understood and a dead switch is a
 * bug report.
 */
export const FEATURE_FLAGS = [
  {
    key: 'ops_notifications',
    description:
      'Project operational events into the operations log group — routed to its system or ' +
      'payments topic by event (WP-A4), not filtered by severity — and the financial log into ' +
      'its payments topic (WP18). Off by default: a destination has to be connected and tested ' +
      'first, and a flag that is on before its configuration exists is the inert-setting trap ' +
      'in reverse.',
    defaultEnabled: false,
    // Turning this off means nobody is told when things fail. That is worth
    // saying out loud before it happens.
    blastRadius: 'TENANT_WIDE',
    configuredBy: [
      'ops.notifications.telegram_chat_id',
      'ops.notifications.telegram_topic_id',
      'ops.notifications.payments_topic_id',
      'ops.notifications.max_attempts',
      'ops.notifications.max_per_minute',
    ],
  },
  {
    key: 'template_overrides',
    description:
      'Apply this tenant’s template overrides when rendering. Off falls every message back to ' +
      'the built-in default without deleting an override or losing a revision — the recovery a ' +
      'legacy operator did not have, since that surface has no reset control at all (UNK-TXT-008).',
    defaultEnabled: true,
    // Every customer-facing message changes at once.
    blastRadius: 'TENANT_WIDE',
    configuredBy: [],
  },
  {
    key: 'service_expiry_reminders',
    description:
      'Warn a customer before their service reaches its deadline, at the advance ' +
      'thresholds reminders.expiry_early_days, reminders.expiry_first_days and ' +
      'reminders.expiry_second_days (7, 3 and 1 days by default). On by ' +
      'default: the alternative to warning them is their configuration stopping without ' +
      'notice, which is what this installation did before Phase 6C. A flag PLUS its ' +
      'configuration, which is the shape CBR-003 and CBR-011 found behind Mirza\u2019s ' +
      '\u06a9\u0631\u0648\u0646 \u0632\u0645\u0627\u0646 screen and which a flat ' +
      'map of booleans cannot represent. Turning it off leaves both numbers stored ' +
      'exactly as they were.',
    defaultEnabled: true,
    // Every customer with a dated service stops being warned. Worth saying out loud.
    blastRadius: 'TENANT_WIDE',
    configuredBy: [
      'reminders.expiry_first_days',
      'reminders.expiry_second_days',
      // WP-A9: the week-out slot is a third advance warning of the same family.
      'reminders.expiry_early_days',
    ],
  },
  {
    key: 'service_expired_notice',
    description:
      'Tell a customer once their service has actually reached its deadline. A separate ' +
      'flag rather than a third threshold, because it is not a number: it fires at zero ' +
      'and what an operator decides about it is whether it is sent at all. Independent of ' +
      'service_expiry_reminders, so a tenant may warn in advance and stay quiet afterwards, ' +
      'or the reverse.',
    defaultEnabled: true,
    blastRadius: 'TENANT_WIDE',
    configuredBy: [],
  },
  {
    key: 'service_usage_reminders',
    description:
      'Warn a customer as their traffic allowance runs down, at the three thresholds ' +
      'reminders.usage_first_percent, _second_ and _final_. On by default, for the reason ' +
      'the expiry flag gives. A service with an unlimited allowance is never warned whatever ' +
      'this says \u2014 there is no fraction of an allowance that does not exist \u2014 and ' +
      'neither is one whose usage figure no panel has answered.',
    defaultEnabled: true,
    blastRadius: 'TENANT_WIDE',
    configuredBy: [
      'reminders.usage_first_percent',
      'reminders.usage_second_percent',
      'reminders.usage_final_percent',
    ],
  },
  /*
   * WP-A9: three more reminder switches. Each is on its own row for the reason
   * `service_expired_notice` is: what an operator decides about it is whether it is sent.
   */
  {
    key: 'service_expiry_day_reminder',
    description:
      'Tell a customer on the day their service expires, once that calendar day has begun in ' +
      'the tenant\u2019s display timezone and before the deadline itself. On by default, as ' +
      'the owner\u2019s schedule of 7, 3 and 1 days before and the day of expiry asks. ' +
      'Independent of service_expiry_reminders and of service_expired_notice.',
    defaultEnabled: true,
    blastRadius: 'TENANT_WIDE',
    configuredBy: [],
  },
  {
    key: 'wallet_low_balance_reminders',
    description:
      'Tell a customer, once, when their wallet balance falls below ' +
      'wallet.low_balance.threshold, and again only after it has been back at or above it. ' +
      'OFF by default: a threshold is a tenant\u2019s own number and there is no sensible ' +
      'one to invent for every installation.',
    defaultEnabled: false,
    blastRadius: 'TENANT_WIDE',
    configuredBy: ['wallet.low_balance.threshold'],
  },
  {
    key: 'payment_pending_reminders',
    description:
      'Remind a customer, once, shortly before an unpaid card-to-card payment or an unpaid ' +
      'order lapses, while it can still be completed. On by default. A payment that is ' +
      'settled, cancelled, expired or already carries a receipt is never reminded about.',
    defaultEnabled: true,
    blastRadius: 'TENANT_WIDE',
    configuredBy: ['reminders.payment_pending_minutes'],
  },
  /*
   * HF-A9: quiet hours for reminders. A switch whose parameters are the window's two
   * boundaries — the flag/settings split this registry exists to keep.
   */
  {
    key: 'reminder_quiet_hours',
    description:
      'Hold customer reminders that fall due inside the quiet window ' +
      '(reminders.quiet_hours_start to reminders.quiet_hours_end, in the tenant\u2019s ' +
      'display timezone) until the window ends, instead of sending them at night. Nothing is ' +
      'dropped and nothing is duplicated: the queued message waits, and is re-checked when ' +
      'it is sent, so a reminder about a service renewed, a payment settled or a wallet ' +
      'topped up in the meantime is not sent. Applies to reminders only \u2014 never to a ' +
      'reply to something the customer did, nor to a payment or order outcome. OFF by ' +
      'default, so an upgrade changes no tenant\u2019s sending times until it chooses to.',
    defaultEnabled: false,
    // Every reminder to every customer of the tenant moves at once.
    blastRadius: 'TENANT_WIDE',
    configuredBy: ['reminders.quiet_hours_start', 'reminders.quiet_hours_end'],
  },
  /*
   * Round N, package D: the reseller monthly minimum's two sentences
   * (`docs/round-n-reseller-audit.md` §3.4). Informational only — neither switch has, or
   * turns on, any consequence for a reseller below the minimum.
   */
  {
    key: 'reseller_minimum_reminders',
    description:
      'Remind an active reseller, once a month, reminders.reseller_minimum_days local days ' +
      'before the month ends, that their sales this month are still below their monthly ' +
      'minimum. ON by default, as Mirza\u2019s three-day warning is, and inert until an ' +
      'operator sets a minimum on a tier or a reseller: every minimum defaults to none.',
    defaultEnabled: true,
    blastRadius: 'TENANT_WIDE',
    configuredBy: ['reminders.reseller_minimum_days'],
  },
  {
    key: 'reseller_minimum_achieved_notices',
    description:
      'Tell an active reseller, once a month, that their sales this month reached their ' +
      'monthly minimum. OFF by default.',
    defaultEnabled: false,
    blastRadius: 'TENANT_WIDE',
    configuredBy: [],
  },
  /*
   * `trials` was here until F5. It was the tenant-wide switch in front of the free
   * trial, and R1 made each panel's own trial (`panel_trial_configs.enabled`) the thing that
   * is offered, so the switch became a second answer to "is a trial offered" that could
   * only disagree with the first. It is gone rather than kept as a dead switch: a flag
   * exists here only when it turns something on. Migration 0144 switched off every panel
   * trial of a tenant whose switch was off, so nothing started being offered; the stored
   * `feature_flag_states` rows are left in place, unread, for the release before this one
   * (`docs/deployment.md`, the F5 rollback section).
   */
  {
    key: 'customer_link_rotation',
    description:
      'Let a customer ask for a new subscription link for their own active service, from ' +
      'Telegram. Offered only where the panel can rotate a link, and at most once per ' +
      'services.link_rotation_cooldown_hours. It issues a new link; it makes no promise ' +
      'about the old one.',
    defaultEnabled: false,
    // TENANT_WIDE: turning it on offers a new action to every customer of the tenant at
    // once. Turning it off withdraws the button and refuses the callback;
    // a rotation already planned still runs.
    blastRadius: 'TENANT_WIDE',
    configuredBy: ['services.link_rotation_cooldown_hours'],
  },
  {
    key: 'customer_refund_requests',
    description:
      'Let a customer ask, from Telegram, for a refund of one of their paid services. An ' +
      'administrator decides the amount (never more than what is left of the original ' +
      'purchase, and never the payment gateway fee), the service is deleted from its panel, ' +
      'and only after the deletion succeeds is the amount credited to the customer\u2019s Nexa ' +
      'wallet \u2014 whatever the original payment method. Turning it off withdraws the ' +
      'button and refuses the customer\u2019s taps; requests already filed can still be decided.',
    defaultEnabled: false,
    // TENANT_WIDE, like `customer_link_rotation`: it offers a new action to every customer at
    // once, and that action ends in money leaving the tenant.
    blastRadius: 'TENANT_WIDE',
    configuredBy: [],
  },
  {
    key: 'referrals',
    description:
      'Run a referral program: a customer shares a link, and whoever joins through it is ' +
      'attributed to them for good. Off by default, and turning it on is not enough on its ' +
      'own: referral.commission_percent must be set before anyone is attributed or paid. The ' +
      'referrer earns a share of the referred customer\u2019s paid orders \u2014 the first ' +
      'one, or every one, per referral.commission_scope \u2014 credited to their wallet when ' +
      'the order is delivered and taken back in proportion when it is refunded. Nothing is ' +
      'paid for signing up, and trials earn nothing. Turning it off stops new attributions ' +
      'and new commissions; commissions already promised are still paid.',
    defaultEnabled: false,
    // TENANT_WIDE: turning it on puts money on offer to every customer of the tenant at
    // once.
    blastRadius: 'TENANT_WIDE',
    configuredBy: [
      'referral.commission_percent',
      'referral.commission_scope',
      'referral.minimum_order_amount',
    ],
  },
  {
    key: 'referral_signup_gift',
    description:
      'Pay a membership gift for a valid referral: one total, split between the referrer ' +
      'and the new customer by two share percents, each side claimed once from the ' +
      'referral screen. Independent of the purchase commission and never recursive. ' +
      'Turning it on requires the two shares to total 100 and a total above zero; turning ' +
      'it off withdraws the button and refuses new claims, and shares already credited ' +
      'stay credited.',
    defaultEnabled: false,
    // TENANT_WIDE like `referrals`: it puts money on offer to every referred customer of
    // the tenant at once.
    blastRadius: 'TENANT_WIDE',
    configuredBy: [
      'referral.signup_gift.total',
      'referral.signup_gift.referrer_percent',
      'referral.signup_gift.referred_percent',
    ],
  },
  {
    key: 'custom_service',
    description:
      'Let a customer buy a custom service: they choose a location, type a ' +
      'volume in GB and a number of days, and are charged volume \u00d7 price per GB plus ' +
      'days \u00d7 price per day from the custom-service price rules, before the ordinary ' +
      'discounts, payment and provisioning. Off by default. Turning it on is not enough on ' +
      'its own: a location must be offered and a VOLUME and a TIME rule must price the ' +
      'customer on it. Turning it off withdraws the button and refuses new drafts and ' +
      'confirmations; orders already confirmed are still paid for and delivered.',
    defaultEnabled: false,
    // TENANT_WIDE, like `customer_link_rotation`: it offers a new way to buy to every
    // customer of the tenant at once. The brief names it `custom_service_enabled`; a flag key is the name
    // of the feature, as every other key here is, and the flag IS the enablement.
    blastRadius: 'TENANT_WIDE',
    configuredBy: [],
  },
  {
    key: 'customer_marketing_opt_out',
    description:
      'Let a customer stop promotional (MARKETING) broadcasts themselves — /stop and the ' +
      'opt-out button — and honour what they chose. On by default: what every installation ' +
      'did before this switch existed. Turning it off hides the button, makes /stop and any ' +
      'old opt-out or opt-in button change nothing, and sends MARKETING broadcasts to ' +
      'customers who opted out earlier. Their stored choice is NOT erased: turning it back ' +
      'on makes it effective again. Messages about a customer\u2019s own payments, services ' +
      'and tickets are never affected either way (spec §9).',
    defaultEnabled: true,
    // TENANT_WIDE: turning it off sends promotions to every customer who asked not to get
    // them, at once. Worth saying out loud before it happens.
    blastRadius: 'TENANT_WIDE',
    configuredBy: [],
  },
  {
    key: 'central_fx',
    description:
      'Read the USDT rate from a public exchange (Nobitex, with Wallex as the fallback) and ' +
      'keep it fresh for the routes priced by it (package FX). The Telegram Stars route is ' +
      'priced by this rate and stars.per_usdt only (spec §8): while it is off no new Stars ' +
      'invoice can be priced, and there is no manual Stars rate to fall back to. Turning ' +
      'it off stops the refresh and makes the central rate ' +
      'UNAVAILABLE, so a new central-rate invoice is refused with a customer message; an ' +
      'invoice already issued keeps its own snapshot whatever happens to the feed.',
    defaultEnabled: false,
    // Every customer choosing a central-rate route is refused at once while it is off.
    blastRadius: 'TENANT_WIDE',
    configuredBy: [
      'fx.primary_source',
      'fx.fallback_source',
      'fx.fresh_ttl_seconds',
      'fx.max_stale_seconds',
      'stars.per_usdt',
    ],
  },
  {
    key: 'terms_enforcement',
    description:
      'Require every customer to accept the current terms and rules before using the bot ' +
      '(program §6). While it is on, a customer who has not accepted the newest PUBLISHED ' +
      'version is shown it, with an accept button, instead of what they asked for — at one ' +
      'gate in front of every customer action; support, help and the promotional opt-out ' +
      'stay reachable. With no published version nobody is stopped. Publishing a new version ' +
      'never marks anybody as having accepted it, so every customer is asked again. Turning ' +
      'it off lets everyone through and erases no acceptance.',
    defaultEnabled: false,
    // Turning it on stops every customer who has not accepted, at once.
    blastRadius: 'TENANT_WIDE',
    configuredBy: [],
  },
] as const satisfies readonly FeatureFlagDefinition[];

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[number]['key'];

export const FEATURE_FLAG_KEYS: readonly FeatureFlagKey[] = FEATURE_FLAGS.map(
  (f) => f.key as FeatureFlagKey,
);

const FLAG_BY_KEY = new Map<string, FeatureFlagDefinition>(FEATURE_FLAGS.map((f) => [f.key, f]));

export function featureFlagDefinition(key: FeatureFlagKey): FeatureFlagDefinition {
  const found = FLAG_BY_KEY.get(key);
  if (!found) {
    throw new Error(`Unknown feature flag: ${key}. Feature flags are a frozen contract.`);
  }
  return found;
}

/** Unknown keys fail closed. */
export function isFeatureFlagKey(value: string): value is FeatureFlagKey {
  return FLAG_BY_KEY.has(value);
}

/** Where a resolved flag value came from. Same shape, same reason, as a setting. */
export const FEATURE_FLAG_SOURCES = ['DEFAULT', 'TENANT'] as const;
export type FeatureFlagSource = (typeof FEATURE_FLAG_SOURCES)[number];
