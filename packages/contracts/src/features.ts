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
      'ops.log.disabled_types',
      'ops.log.storm_rollup_enabled',
      'ops.log.storm_threshold',
      'ops.log.storm_window_minutes',
      'ops.log.nightly_report_time',
      'ops.log.admin_base_url',
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
    key: 'referral_abuse_guard',
    description:
      'R10 D5 (b): guard referral money against fake sign-ups. On, a referral’s membership ' +
      'gift is claimable only once the referred customer has a paid order that was delivered ' +
      '(or from the attribution, if the unlock setting says so), and each referrer is paid at ' +
      'most a configured number of gift shares and of purchase commissions per local day; ' +
      'what is over a cap waits for the next day and is never voided. Off by default: the ' +
      'gift and the commission behave exactly as before. Turning it on or off never changes ' +
      'a balance — nothing already paid is taken back and nothing is granted by the switch.',
    defaultEnabled: false,
    // TENANT_WIDE: it changes when money is paid to every referrer and referee of the tenant.
    blastRadius: 'TENANT_WIDE',
    configuredBy: [
      'referral.abuse.gift_unlock',
      'referral.abuse.referrer_daily_gift_cap',
      'referral.abuse.referrer_daily_commission_cap',
    ],
  },
  {
    key: 'start_captcha',
    description:
      'R10 D5 (a): ask every NEW customer a simple question in the chat (a sum, four answer ' +
      'buttons) before the bot serves them. Only customers who first arrive while it is on ' +
      'are asked; existing customers never are, and turning it off lets everybody waiting ' +
      'through at once. A wrong answer costs an attempt and, at the limit, a cooldown — ' +
      'never a block. Administrators are never asked. No third-party service is involved.',
    defaultEnabled: false,
    // TENANT_WIDE: it stands in front of every new customer of the tenant.
    blastRadius: 'TENANT_WIDE',
    configuredBy: ['captcha.expiry_seconds', 'captcha.max_attempts', 'captcha.cooldown_seconds'],
  },
  {
    key: 'panel_auto_balancing',
    description:
      'Place each new service on the best eligible panel of its product\u2019s balancing ' +
      'group instead of always on the product\u2019s own panel. Only panels an operator has ' +
      'put in the same group are considered, only ones that may take a new account right ' +
      'now (enabled, not drained, not confirmed unhealthy, with room), healthy ones first, ' +
      'then by the configured load strategy. A panel in no group is unaffected. Off by ' +
      'default; turning it off places every new draft on its product\u2019s own panel again ' +
      'and moves nothing that already exists.',
    defaultEnabled: false,
    // TENANT_WIDE: it changes where every new purchase of the tenant lands.
    blastRadius: 'TENANT_WIDE',
    configuredBy: ['panels.balancing.strategy'],
  },
  {
    key: 'custom_panel_provider',
    description:
      'Let an operator add a panel of the `custom` provider type: a bridge service that ' +
      'speaks Nexa\u2019s own signed panel protocol (docs/protocols/custom-panel.md) in front ' +
      'of a panel Nexa has no adapter for. Off by default, because the protocol has not yet ' +
      'been accepted against a real bridge. Turning it off refuses creating a NEW custom ' +
      'panel and hides the type from the panel form; custom panels that already exist keep ' +
      'operating \u2014 services on them are still delivered, renewed, checked and monitored, ' +
      'so no customer who already paid is stranded.',
    defaultEnabled: false,
    // TENANT_WIDE: it decides which provider types every operator of the tenant may add.
    // Not to be confused with `custom_service` below, which is an unrelated way to BUY.
    blastRadius: 'TENANT_WIDE',
    configuredBy: [],
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
      'Read the USDT rate from the public exchanges (Nobitex, Wallex, Tabdeal, Bitpin and Ramzinex; a rate is stored when ' +
      'enough of them agree) and ' +
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
      'fx.source_nobitex_enabled',
      'fx.source_wallex_enabled',
      'fx.source_tabdeal_enabled',
      'fx.source_bitpin_enabled',
      'fx.source_ramzinex_enabled',
      'fx.sanity_band_bps',
      'fx.min_agreeing_sources',
      'fx.accept_single_source',
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
      'stay reachable. With no published version nobody is stopped. A customer who accepted ' +
      'once (any version, or the previous bot\u2019s rules carried by the import) is not asked ' +
      'again when a new version is published, unless `terms_reprompt_on_new_version` is on ' +
      '(R4 A4). Turning it off lets everyone through and erases no acceptance.',
    defaultEnabled: false,
    // Turning it on stops every customer who has not accepted, at once.
    blastRadius: 'TENANT_WIDE',
    configuredBy: [],
  },
  {
    key: 'rich_messages',
    description:
      'Send every customer screen that carries inline buttons as a Telegram rich message ' +
      '(sendRichMessage) whose buttons sit INSIDE the message, in a buttons block, and edit ' +
      'it in place with editMessageText(rich_message). Off by default: off is exactly what ' +
      'every installation sent before this switch existed. A screen Telegram refuses as a ' +
      'rich message is sent once more the ordinary way and the refusal is logged to the ' +
      'errors topic once an hour per bot; a button that cannot sit inside the block stays an ' +
      'ordinary inline keyboard under the message, never dropped. What a tap does is ' +
      'identical in both modes. The main menu keyboard and photo screens do not change.',
    defaultEnabled: false,
    // TENANT_WIDE: every inline-button screen every customer of the tenant sees changes shape.
    blastRadius: 'TENANT_WIDE',
    configuredBy: [],
  },
  {
    key: 'rich_plan_table',
    description:
      'R5C-2 B2: draw the plan list as a table (name, traffic, days, price) above the plan ' +
      'buttons. Off by default and independent of rich_messages in what it means, but inert ' +
      'without it: a table is a rich-message block, and with rich_messages off the plan list ' +
      'is the ordinary message it always was. Off with rich_messages on is the plan list ' +
      'without a table, byte for byte the list a tenant without tables sees.',
    defaultEnabled: false,
    // TENANT_WIDE: every customer who opens a category sees the plan list change shape.
    blastRadius: 'TENANT_WIDE',
    configuredBy: [],
  },
  {
    key: 'rich_premium_emoji',
    description:
      'Inside rich messages, draw the custom emoji of the bot appearance slots as premium ' +
      'emoji, for a bot whose appearance test succeeded. Off by default and inert without ' +
      'rich_messages: a rich message then carries the plain emoji, and an ordinary message ' +
      'is decorated exactly as before, by the appearance test alone. A rich message Telegram ' +
      'refuses is sent the ordinary way, so a refused premium emoji never costs the screen.',
    defaultEnabled: false,
    // TENANT_WIDE (PR #295 review): it changes every rich message every customer of the
    // tenant receives from an eligible bot.
    blastRadius: 'TENANT_WIDE',
    configuredBy: [],
  },
  {
    key: 'terms_reprompt_on_new_version',
    description:
      'R4 A4: ask a customer who already accepted the rules to accept AGAIN when a newer ' +
      'version is published. Off by default, the owner\u2019s rule: a customer who accepted ' +
      'once \u2014 in this bot, or in the previous bot before the import \u2014 is never asked ' +
      'again, whatever the rules text becomes. Only read while `terms_enforcement` is on.',
    defaultEnabled: false,
    // Turning it on stops every customer who has not accepted the newest version, at once.
    blastRadius: 'TENANT_WIDE',
    configuredBy: [],
  },
  {
    key: 'wallet_admin_credit_notice',
    description:
      'R4 A5: tell a customer when an administrator credits their wallet by hand \u2014 the ' +
      'amount, the new balance and, only when the administrator ticked it, the reason. ' +
      'Never for an imported opening balance or any other ledger movement.',
    defaultEnabled: true,
    blastRadius: 'LOCAL',
    configuredBy: [],
  },
  {
    key: 'wallet_admin_debit_notice',
    description:
      'R4 A5: tell a customer when an administrator debits their wallet by hand, the same ' +
      'sentence as the credit in the other direction.',
    defaultEnabled: true,
    blastRadius: 'LOCAL',
    configuredBy: [],
  },
  {
    key: 'addon_time_in_renew_menu',
    description:
      'R5C-1 item 4 «نمایش زمان اضافه داخل تمدید هم»: keep the extra-time packages in the ' +
      'renewal menu too. On by default \u2014 the menu is as it has always been, and the ' +
      'service card also has its own «خرید زمان اضافه» button. Off hides the time packages ' +
      'from the renewal menu only; they stay purchasable from their own button. It is a ' +
      'flag and not a setting because it has no parameter: a boolean is a flag.',
    defaultEnabled: true,
    blastRadius: 'LOCAL',
    configuredBy: [],
  },
  {
    key: 'mini_app',
    description:
      'Round 9, C5: the customer Telegram Mini App. On, every ACTIVE bot of the tenant gets a ' +
      'menu button that opens the mini app (applied by the command-menu sync), and the mini ' +
      'app\u2019s endpoints accept sessions. Off by default: the endpoints answer as if they did ' +
      'not exist, no menu button is set, and nothing in the bot changes \u2014 no keyboard, no ' +
      'message, no extra Telegram call. The mini app exposes only what the bot already offers, ' +
      'through the same services, gates and permissions.',
    defaultEnabled: false,
    // TENANT_WIDE: turning it on offers a second way in to every customer of the tenant.
    blastRadius: 'TENANT_WIDE',
    configuredBy: ['miniapp.init_data_max_age_seconds', 'miniapp.session_ttl_minutes'],
  },
  {
    key: 'gift_cards',
    description:
      'R10 D4: gift cards \u2014 wallet top-up codes an operator mints in batches in the Web ' +
      'Admin and a customer redeems in the bot or the mini app, crediting their wallet through ' +
      'the ledger (GIFT_CARD_REDEMPTION). Off by default: the wallet screen draws no gift-card ' +
      'button, the mini app hides the field, a redemption is refused and no batch can be ' +
      'created. Codes already minted keep their own expiry while it is off, and redeem again ' +
      'once it is back on; exporting and disabling a batch stay available to an operator.',
    defaultEnabled: false,
    // TENANT_WIDE: turning it on lets every customer of the tenant redeem codes.
    blastRadius: 'TENANT_WIDE',
    configuredBy: [],
  },
  {
    key: 'personal_discount',
    description:
      'R10 D3: apply each customer\u2019s personal discount percent \u2014 set on the customer\u2019s ' +
      'page \u2014 to purchases and renewals. The larger single discount wins: the order is ' +
      'priced the ordinary way (reseller price, discount codes and automatic discounts) and ' +
      'as the list price minus the personal percent, and the strictly lower total is charged; ' +
      'the two are never combined. Never applied to a wallet top-up. Off by default: every ' +
      'price is exactly what it was, and the percents stay stored. Turning it off refuses the ' +
      'confirmation of a draft priced with a personal discount; the customer starts again.',
    defaultEnabled: false,
    // TENANT_WIDE: it changes what every customer with a percent is charged.
    blastRadius: 'TENANT_WIDE',
    configuredBy: [],
  },
  {
    key: 'custom_menu_buttons',
    description:
      'R10 D2: owner-defined buttons on the customer main menu \u2014 a link that opens a URL, or ' +
      'a stored text, photo or document the bot sends \u2014 placed through the button builder. ' +
      'Off by default: no custom button is drawn on any keyboard, a tap on one already sitting in ' +
      'a chat is answered as unavailable, and the registry buttons are exactly as before. Turning ' +
      'it off keeps every button and its place in the layout; turning it on again draws them.',
    defaultEnabled: false,
    // LOCAL: it adds buttons to the keyboard the operator has just arranged, and nothing else.
    blastRadius: 'LOCAL',
    configuredBy: [],
  },
  {
    key: 'service_auto_renew',
    description:
      'Round 10, D1: «تمدید خودکار». On, a customer may switch automatic renewal on for one of ' +
      'their services from the bot\u2019s service screen or the mini app; auto_renew.lead_hours ' +
      'before the deadline the worker renews it through the ordinary renewal \u2014 the same ' +
      'quote, the same wallet debit, the same provisioning \u2014 if the wallet covers it and the ' +
      'price is not above what the customer agreed to; otherwise the customer is told once. Off ' +
      'by default. Off stops every new run at once: an opted-in service is simply not renewed, ' +
      'its consent is kept, and the customer can still switch it off.',
    defaultEnabled: false,
    // TENANT_WIDE: it spends customers' wallets without a tap of theirs at the time.
    blastRadius: 'TENANT_WIDE',
    configuredBy: ['auto_renew.lead_hours'],
  },
  {
    key: 'referral_friends_list',
    description:
      'R11 B3: the «دوستان دعوت‌شده» list on the mini app\u2019s referral screen \u2014 the ' +
      'customer\u2019s own referees, newest first, each with a first name or a masked username ' +
      '(never a Telegram id, phone or full name), the join date and one status: joined, first ' +
      'purchase done, reward pending or reward paid. Read-only; no money moves and no message ' +
      'is sent. Off by default: the screen shows its three figures and nothing else, and the ' +
      'list route answers that the feature is off. Turning it off hides the list and changes ' +
      'no referral, commission or balance.',
    defaultEnabled: false,
    // LOCAL: it adds a read-only section to one screen of the customer's own mini app.
    blastRadius: 'LOCAL',
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
