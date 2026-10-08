import type { PermissionKey } from '@nexa/contracts';
import type { WebKey } from './i18n/web.fa';
import type { IconName } from './ui/icons';
import { isSuperAdmin } from './report-view';

/**
 * The navigation: every Web Admin surface, the group it is drawn in, its
 * glyph, and what an actor needs for the link to be drawn.
 *
 * `permission` decides what is DRAWN and never what is allowed: the server
 * re-checks every call. It is re-exported from `app.tsx`, where the route
 * table that serves each path lives.
 *
 * The sidebar information architecture: ten groups — داشبورد, then nine drawn as a
 * single-open accordion (`shell.tsx`). Every regrouping (Round W's semantic
 * sections, the support-AI group, this one) moved entries between groups without
 * changing a single entry's path, label or permission. The full map is in
 * `docs/web-redesign/foundation.md`; `tests/web/route-inventory.test.tsx` proves
 * every entry is in exactly one group and resolves to a real page, and
 * `tests/web/nav-accordion.test.tsx` pins the groups and the accordion.
 */

export interface NavEntry {
  readonly id: string;
  /** The nav destination. Detail routes are matched separately. */
  readonly path: string;
  readonly label: WebKey;
  readonly icon: IconName;
  /**
   * What the entry needs to be worth showing. Null means everyone with a
   * session; an ARRAY means ANY of them, because a page can serve more than one
   * capability and gating it on the first one hides the others.
   *
   * `/notifications` is why this is not a single string. It carries two
   * separate server capabilities — the delivery history (`opslog.view`) and the
   * test send (`settings.edit`, which `POST /notifications/test` authorizes on
   * its own and which the page already gates separately). Requiring only
   * `opslog.view` meant an actor holding `settings.edit` alone had no link to a
   * page that would have served them correctly: the UI hid an action the server
   * permits, which is the same defect as offering one it refuses, in the
   * direction nobody looks.
   */
  readonly permission: PermissionKey | readonly PermissionKey[] | null;
  readonly group: WebKey;
  /**
   * WP12: shown only to the Super Admin — the owner role AND the permission. The server
   * refuses anyone else on every report route; this only stops drawing a link to a page
   * that would answer 403 (`docs/wp12-business-analytics-audit.md` §2).
   */
  readonly ownerOnly?: boolean;
}

/**
 * Whether an actor may see a navigation entry.
 *
 * Exported because the rule is worth asserting directly: an entry listing
 * several permissions is satisfied by ANY of them, and the failure it exists to
 * prevent — a page with two capabilities hidden from an actor who holds one —
 * is invisible from the outside.
 */
export function navPermitted(
  entry: NavEntry,
  permissions: readonly PermissionKey[],
  roleKeys: readonly string[] = [],
): boolean {
  if (entry.ownerOnly === true && !isSuperAdmin(roleKeys, permissions)) return false;
  if (entry.permission === null) return true;
  const needed = typeof entry.permission === 'string' ? [entry.permission] : entry.permission;
  return needed.some((permission) => permissions.includes(permission));
}

/**
 * The navigation, in the order it is drawn.
 *
 * The surfaces come from the owner's route inventory; what each one may DO
 * comes from `docs/phase3d-coverage-ledger.md`. Nine of them have no backend at
 * all in this release and are marked `planned` at the page rather than hidden —
 * hiding them would leave an operator wondering whether the product has them,
 * which is the question the maturity vocabulary exists to answer.
 */
/**
 * Exported so a test can drive the paths an operator actually CLICKS.
 *
 * These are hardcoded here and looked up from `PLANNED_SURFACES` in `resolve`,
 * which makes the two independent: a typo in one sends a working navigation
 * link to `NotFound`. A test that reads its path from the same table it
 * checks cannot see that, and the first version of the route test did exactly
 * that — the mutation moved its input and the route table together and
 * survived.
 */
export const NAV: readonly NavEntry[] = [
  {
    id: 'dashboard',
    path: '/',
    label: 'web.nav_overview',
    icon: 'dashboard',
    permission: null,
    group: 'web.navgroup_dashboard',
  },
  {
    id: 'users',
    path: '/users',
    label: 'web.nav_users',
    icon: 'users',
    permission: 'users.view',
    group: 'web.navgroup_customers',
  },
  {
    id: 'services',
    path: '/services',
    label: 'web.nav_services',
    icon: 'services',
    // ANY of the two: the page is the services list AND the customers' refund-request queue
    // (WP19), and a finance reviewer may hold `refunds.view` alone (Codex review of #83).
    permission: ['services.view', 'refunds.view'],
    group: 'web.navgroup_customers',
  },
  {
    /*
     * WP-A7: the support ticket inbox. `tickets.view`, and only that — every write on the
     * page (reply, assign, status, categories) opens from a row the view key lists.
     */
    id: 'tickets',
    path: '/tickets',
    label: 'web.nav_tickets',
    icon: 'message',
    permission: 'tickets.view',
    group: 'web.navgroup_customers',
  },
  {
    id: 'support',
    path: '/support',
    label: 'web.nav_support',
    icon: 'help',
    /*
     * `settings.view`, and only that — the payment-gateways rule. The FAQ is
     * configuration: the server's list charges `settings.view` and its writes
     * `settings.edit`, the same pair the settings page beside it uses, because the
     * support DESTINATION is a setting on that page.
     */
    permission: 'settings.view',
    group: 'web.navgroup_customers',
  },
  {
    /*
     * TB2: Telegram Business conversations (ADR-0033). `business_chats.view`; the take over,
     * hand back and reply controls are drawn on `business_chats.reply` inside the page.
     */
    id: 'business-chats',
    path: '/business-chats',
    label: 'web.nav_business_chats',
    icon: 'send',
    permission: 'business_chats.view',
    group: 'web.navgroup_support_ai',
  },
  {
    /*
     * TB4/TB5: the support AI's mode, provider chain, keys and usage (ADR-0034 §8).
     * `support_ai.configure`, which every read and write on the page charges; entering
     * automatic replies is charged `support_ai.auto_reply` by the server on save.
     */
    id: 'support-ai',
    path: '/support-ai',
    label: 'web.nav_support_ai',
    icon: 'zap',
    permission: 'support_ai.configure',
    group: 'web.navgroup_support_ai',
  },
  {
    /*
     * TB8: the support knowledge base (ADR-0035). `support_knowledge.view`; every write on the
     * page is charged `support_knowledge.review` by the server.
     */
    id: 'support-knowledge',
    path: '/support-knowledge',
    label: 'web.nav_support_knowledge',
    icon: 'content',
    permission: 'support_knowledge.view',
    group: 'web.navgroup_support_ai',
  },
  {
    // TB8: the lessons the support AI proposed from human replies, waiting for a reviewer.
    id: 'learning-candidates',
    path: '/support-learning',
    label: 'web.nav_learning_candidates',
    icon: 'check',
    permission: 'support_knowledge.view',
    group: 'web.navgroup_support_ai',
  },
  {
    // TB9: the one-click build from NEXA — run, review the diff, resolve conflicts, apply.
    id: 'knowledge-build',
    path: '/knowledge-build',
    label: 'web.nav_knowledge_build',
    icon: 'refresh',
    permission: 'support_knowledge.view',
    group: 'web.navgroup_support_ai',
  },
  {
    /*
     * TB10: support analytics — conversations, handoffs, automatic replies, drafts, provider
     * runs, learning and knowledge, over a report range. Read under `support_ai.configure`,
     * which the server charges; usage and cost are folded into that key (`tb0-audit.md` §7).
     */
    id: 'support-analytics',
    path: '/support-analytics',
    label: 'web.nav_support_analytics',
    icon: 'activity',
    permission: 'support_ai.configure',
    group: 'web.navgroup_support_ai',
  },
  {
    id: 'orders',
    path: '/orders',
    label: 'web.nav_orders',
    icon: 'orders',
    permission: 'orders.view',
    group: 'web.navgroup_sales',
  },
  {
    id: 'products',
    path: '/products',
    label: 'web.nav_products',
    icon: 'products',
    // EITHER, exactly as `/panels` and `/notifications` do, and for
    // the identical reason. The route renders the CREATE form on `catalog.edit`
    // whether or not `catalog.view` is held, and the server authorizes creation on
    // `catalog.edit` alone — so gating the link on `catalog.view` hid a page that
    // would have served a custom-role editor correctly. Found by the Codex review of
    // this branch, which is the third time this shape has been the answer.
    permission: ['catalog.view', 'catalog.edit'],
    group: 'web.navgroup_sales',
  },
  {
    id: 'product-categories',
    path: '/product-categories',
    label: 'web.nav_product_categories',
    icon: 'folder',
    // EITHER, for the reason `/products` above gives in full: the route renders the
    // create form on `catalog.edit` whether or not `catalog.view` is held, and the
    // server authorizes every write on `catalog.edit` alone.
    permission: ['catalog.view', 'catalog.edit'],
    group: 'web.navgroup_sales',
  },
  {
    // Mirza migration PR2: the legacy (Mirza) products read for migration, one code at a
    // time (`docs/legacy-product-review-design.md` §8). Under the catalogue, beside the
    // products a decision maps a code to. Its own permission, never `catalog.*`.
    id: 'legacy-products',
    path: '/legacy-products',
    label: 'web.nav_legacy_products',
    icon: 'archive',
    permission: 'legacy.products.view',
    group: 'web.navgroup_sales',
  },
  {
    // Mirza migration PR3: every legacy (Mirza) invoice, kept as read-only history — beside
    // the legacy product review, the other half of what a migration operator reviews. Its
    // own MEDIUM permission (observers do not see it); personal data needs a second key.
    id: 'legacy-invoices',
    path: '/legacy-invoices',
    label: 'web.nav_legacy_invoices',
    icon: 'clock',
    permission: 'legacy.invoices.view',
    group: 'web.navgroup_sales',
  },
  {
    // Mirza migration PR4 (owner decision 6): negative legacy balances held for the owner's
    // review — never a ledger entry, never collected. Beside the other legacy reviews. Its
    // own MEDIUM permission (observers do not see it); deciding needs a HIGH one.
    id: 'legacy-debts',
    path: '/legacy-debts',
    label: 'web.nav_legacy_debts',
    icon: 'wallet',
    permission: 'legacy.debts.view',
    group: 'web.navgroup_sales',
  },
  {
    // Mirza migration PR5 (owner decision 8): every live legacy invoice's ONE adoption
    // outcome, and the operator's review of the ones not adopted — an empty-code invoice is
    // adopted only by an explicit approval here. Beside the other legacy reviews; its own
    // MEDIUM permission (observers do not see it); deciding needs a HIGH one.
    id: 'legacy-services',
    path: '/legacy-services',
    label: 'web.nav_legacy_services',
    icon: 'services',
    permission: 'legacy.services.view',
    group: 'web.navgroup_sales',
  },
  {
    // Mirza migration PR6 (owner constraint 3): the owner's approval of ONE frozen legacy
    // snapshot for import, bound to seven exact values. Its own MEDIUM view permission;
    // approving is CRITICAL and owner-only.
    id: 'legacy-cutover',
    path: '/legacy-cutover',
    label: 'web.nav_legacy_cutover',
    icon: 'shield',
    permission: 'legacy.cutover.view',
    group: 'web.navgroup_sales',
  },
  {
    id: 'custom-service',
    path: '/custom-service',
    label: 'web.nav_custom_service',
    icon: 'sliders',
    /*
     * `catalog.view`, and only that — the rule the discounts entry states. Both
     * lists need it (`CustomServiceAdminService` charges it to read), and every write
     * opens from a row or a form beside them; an actor holding only
     * `catalog.pricing.edit` would reach forms with nothing to edit.
     */
    permission: 'catalog.view',
    group: 'web.navgroup_sales',
  },
  {
    // WP-A5: the extra users / devices rate — an `ADD_DEVICES` add-on, under the catalogue's
    // own pair and for the reason `/products` gives: the create form needs only edit.
    id: 'extra-devices',
    path: '/extra-devices',
    label: 'web.nav_extra_devices',
    icon: 'userPlus',
    permission: ['catalog.view', 'catalog.edit'],
    group: 'web.navgroup_sales',
  },
  {
    // WP-A6: a panel's locations and the price of moving a service there, under the
    // catalogue's own pair, for the reason the entry above gives.
    id: 'service-locations',
    path: '/service-locations',
    label: 'web.nav_service_locations',
    icon: 'globe',
    permission: ['catalog.view', 'catalog.edit'],
    group: 'web.navgroup_sales',
  },
  {
    id: 'trials',
    path: '/trials',
    label: 'web.nav_trials',
    icon: 'gift',
    // ANY of the three, for the reason `/products` gives: the page serves three
    // capabilities — the override list, the global reset and its history — each
    // charged by the server on its own key.
    // R1: and `panels.view`, which the per-panel trial overview is charged on.
    permission: ['users.view', 'settings.destructive', 'settings.view', 'panels.view'],
    group: 'web.navgroup_sales',
  },
  {
    id: 'discounts',
    path: '/discounts',
    label: 'web.nav_discounts',
    icon: 'discounts',
    /*
     * `catalog.view`, and only that — the rule the payment-gateways entry states.
     *
     * WP8 made this a real page. Both rule lists, the edit forms (which open from a
     * row), activate and deactivate (buttons on a row) and the price preview all need
     * `catalog.view`, which `DiscountAdminService.list`, `CashbackRuleAdminService.list`
     * and `PricingReadService.preview` each charge. An actor holding only
     * `catalog.discounts.edit` or `catalog.pricing.edit` could reach nothing but a
     * blank create form, so a link offered on either would be a promise the page could
     * not keep.
     */
    permission: 'catalog.view',
    group: 'web.navgroup_sales',
  },
  {
    id: 'campaigns',
    path: '/campaigns',
    label: 'web.nav_campaigns',
    icon: 'megaphone',
    /*
     * Round N, C1. `campaigns.view`, and only that: the list, the detail and the results all
     * charge it (`CampaignService`), and every write opens from them. The writes ALSO charge
     * each composed action's own key on the server.
     */
    permission: 'campaigns.view',
    group: 'web.navgroup_sales',
  },
  {
    id: 'referrals',
    path: '/referrals',
    label: 'web.nav_referrals',
    icon: 'link',
    /*
     * `referrals.view`, and only that. The page is READ-ONLY — there is no referral
     * write for any other key to unlock (`docs/wp9-referral-audit.md` F10) — and both
     * of its lists are charged this key by `ReferralReadService`.
     */
    permission: 'referrals.view',
    group: 'web.navgroup_sales',
  },
  {
    id: 'reports',
    path: '/reports',
    label: 'web.nav_reports',
    icon: 'reports',
    permission: 'reports.view',
    group: 'web.navgroup_sales',
    ownerOnly: true,
  },
  {
    id: 'payments',
    path: '/payments',
    label: 'web.nav_payments',
    icon: 'payments',
    permission: 'payments.view',
    group: 'web.navgroup_finance',
  },
  {
    /*
     * The compensation list (Payment File 02 §21, D7), directly under payments because it
     * is a view OF payments: the automatic wallet refunds of paid orders that could not be
     * delivered. `payments.view`, the key `GET /compensations` charges.
     */
    id: 'compensations',
    path: '/compensations',
    label: 'web.nav_compensations',
    icon: 'undo',
    permission: 'payments.view',
    group: 'web.navgroup_finance',
  },
  {
    id: 'payment-gateways',
    path: '/payment-gateways',
    label: 'web.nav_payment_gateways',
    icon: 'wallet',
    /*
     * The VIEW keys, and no edit key — a link is a promise that a page will work.
     *
     * `payments.gateways.view` is the list: the route passes `denied={!may(…view)}` and
     * `PaymentGatewayService.list` charges the same key, so an edit-only role would reach a
     * page it could not load and therefore could not edit from.
     *
     * `payments.accounts.view` since UX Batch 01, item 7: the separate «حساب‌های دریافت»
     * entry is gone and the cards are managed on the card-to-card method's own view, so a
     * role that reads the cards alone needs this entry to reach them. The list sends that
     * role straight on to the card-to-card view (`PaymentGatewaysTabbedPage`
     * `mayViewCards`), and `PaymentAccountService.list` still charges the accounts key.
     */
    permission: ['payments.gateways.view', 'payments.accounts.view'],
    group: 'web.navgroup_finance',
  },
  {
    // Round N (B2): «عملیات گروهی» — mass wallet credit and mass traffic/time.
    id: 'bulk-operations',
    path: '/bulk-operations',
    label: 'web.nav_bulk_operations',
    icon: 'grid',
    permission: 'bulk_operations.view',
    group: 'web.navgroup_finance',
  },
  {
    id: 'resellers',
    path: '/resellers',
    label: 'web.nav_resellers',
    icon: 'resellers',
    /*
     * `resellers.view`, and only that — the rule the payment-gateways entry states. The
     * list, the tier filter and the edit form (which opens from a row) all need it, and
     * `ResellerAdminService.list` charges it; an actor holding only `resellers.edit`
     * would reach a register form with no tier to choose.
     */
    permission: 'resellers.view',
    group: 'web.navgroup_resellers',
  },
  {
    id: 'reseller-tiers',
    path: '/reseller-tiers',
    label: 'web.nav_reseller_tiers',
    icon: 'layers',
    // The same key, for the same reason: every tier write opens from the list it charges.
    permission: 'resellers.view',
    group: 'web.navgroup_resellers',
  },
  {
    // Round N, package D: «تنظیمات نمایندگان / پلن‌ها و حداقل فروش».
    id: 'reseller-plans',
    path: '/reseller-plans',
    label: 'web.nav_reseller_plans',
    icon: 'target',
    // The tiers list it opens with is charged `resellers.view`; the progress card asks
    // `orders.view` as well and says so when it is missing.
    permission: 'resellers.view',
    group: 'web.navgroup_resellers',
  },
  {
    id: 'bots',
    path: '/bots',
    label: 'web.nav_bots',
    icon: 'bots',
    permission: 'settings.view',
    group: 'web.navgroup_bot',
  },
  {
    // R1: the customer main menu — order, switches (a setting) and labels (templates).
    id: 'bot-buttons',
    path: '/bot-buttons',
    label: 'web.nav_bot_buttons',
    icon: 'keyboard',
    permission: 'settings.view',
    group: 'web.navgroup_bot',
  },
  {
    // Premium UI: «ظاهر ربات» — custom emoji per semantic slot. Read with `settings.view`,
    // edited and tested with `settings.edit`, the bot-buttons pair.
    id: 'appearance',
    path: '/appearance',
    label: 'web.nav_appearance',
    icon: 'palette',
    permission: 'settings.view',
    group: 'web.navgroup_bot',
  },
  {
    id: 'content',
    path: '/content',
    label: 'web.nav_templates',
    icon: 'content',
    permission: 'templates.view',
    group: 'web.navgroup_bot',
  },
  {
    /*
     * Round N (B1): «ارسال همگانی». `broadcasts.view` reads the list and the reports;
     * composing and launching is `broadcasts.send`, which requires it.
     */
    id: 'broadcasts',
    path: '/broadcasts',
    label: 'web.nav_broadcasts',
    icon: 'send',
    permission: 'broadcasts.view',
    group: 'web.navgroup_bot',
  },
  {
    // WP-A9: every automated customer reminder, its schedule and its message.
    id: 'reminders',
    path: '/reminders',
    label: 'web.nav_reminders',
    icon: 'clock',
    permission: 'settings.view',
    group: 'web.navgroup_bot',
  },
  {
    // WP-A10: the client apps and connection guides the bot recommends. Its own pair,
    // `client_apps.*`: the list charges the view and every write the edit.
    id: 'client-apps',
    path: '/client-apps',
    label: 'web.nav_client_apps',
    icon: 'devices',
    permission: 'client_apps.view',
    group: 'web.navgroup_bot',
  },
  {
    // Program §6: the terms and rules. `terms.view`, the key `GET /terms` charges; the
    // draft, publication and enforcement switch are each drawn under their own key.
    id: 'terms',
    path: '/terms',
    label: 'web.nav_terms',
    icon: 'shield',
    permission: 'terms.view',
    group: 'web.navgroup_bot',
  },
  {
    id: 'panels',
    path: '/panels',
    label: 'web.nav_panels',
    icon: 'panels',
    // EITHER, for the reason `/notifications` carries a list: this page serves
    // the fleet list (`panels.view`) AND the route to the create form
    // (`panels.edit`), and the server authorizes them separately. Gating the
    // entry on the first hid the second — an actor permitted to create a panel
    // had no link to the page the form lives behind, which is the same defect
    // this branch fixed one entry away.
    permission: ['panels.view', 'panels.edit'],
    group: 'web.navgroup_infra',
  },
  {
    // Phase C2: the live fleet's health, load, failures and drain. `panels.view` is
    // what the page's one query charges; probe and drain are gated on the page.
    id: 'panel-health',
    path: '/panel-health',
    label: 'web.nav_panel_health',
    icon: 'activity',
    permission: 'panels.view',
    group: 'web.navgroup_infra',
  },
  {
    id: 'providers',
    path: '/providers',
    label: 'web.nav_providers',
    icon: 'plug',
    // `GET /providers` needs a session and nothing more — it is a catalogue of
    // code, identical for every tenant. Gating it on `panels.view` hid it from
    // an actor holding `panels.edit` alone, who is the actor this release
    // built the create form for, and whose create form fetches this very
    // catalogue and renders it in its picker. Hiding what the server serves is
    // the same defect as offering what it refuses, seen from the other side.
    permission: null,
    group: 'web.navgroup_infra',
  },
  {
    id: 'settings',
    path: '/settings',
    label: 'web.nav_settings',
    icon: 'settings',
    permission: 'settings.view',
    group: 'web.navgroup_config',
  },
  {
    id: 'features',
    path: '/features',
    label: 'web.nav_features',
    icon: 'toggle',
    permission: 'settings.view',
    group: 'web.navgroup_config',
  },
  {
    // Phase B3: the notification center. Every administrator has an inbox; the server
    // filters it by the categories their permissions admit.
    id: 'inbox',
    path: '/notification-center',
    label: 'web.nav_inbox',
    icon: 'bell',
    permission: null,
    group: 'web.navgroup_system',
  },
  {
    // Phase D1: who changed what. Read with `audit.view`; the export is `audit.export`,
    // which the page draws for itself.
    id: 'audit-log',
    path: '/audit-log',
    label: 'web.nav_audit_log',
    icon: 'clock',
    permission: 'audit.view',
    group: 'web.navgroup_system',
  },
  {
    // Phase E3: incidents and maintenance windows. `incidents.view` is what the list
    // charges; manage and notify are gated on the page.
    id: 'incidents',
    path: '/incidents',
    label: 'web.nav_incidents',
    icon: 'alert',
    permission: 'incidents.view',
    group: 'web.navgroup_system',
  },
  {
    id: 'alerts',
    path: '/alerts',
    label: 'web.nav_alerts',
    icon: 'alertOctagon',
    permission: 'opslog.view',
    group: 'web.navgroup_system',
  },
  {
    id: 'notifications',
    path: '/notifications',
    label: 'web.nav_notifications',
    icon: 'bell',
    // EITHER capability. See `NavEntry.permission`.
    permission: ['opslog.view', 'settings.edit'],
    group: 'web.navgroup_system',
  },
  {
    // WP-A4: «گروه گزارش‌های مدیریتی». Read with `settings.view`, acted on with
    // `settings.edit`, which the page gates itself.
    id: 'ops-group',
    path: '/ops-group',
    label: 'web.nav_ops_group',
    icon: 'radio',
    permission: 'settings.view',
    group: 'web.navgroup_system',
  },
  {
    id: 'system',
    path: '/system',
    label: 'web.nav_system',
    icon: 'system',
    permission: null,
    group: 'web.navgroup_system',
  },
  {
    id: 'recovery',
    path: '/recovery',
    label: 'web.nav_recovery',
    icon: 'database',
    /*
     * `backup.view` alone. The page serves four capabilities and gates each one
     * itself, so requiring the most privileged of them would hide the list from
     * an operator whose whole job is checking that backups work.
     *
     * Not a LIST, unlike `/panels` and `/notifications`: every other capability
     * here is strictly narrower in audience than `backup.view`, because
     * `backup.view` is LOW and is in the observer role's read-only set while
     * `backup.run`, `backup.download` and `recovery.restore` are HIGH or
     * CRITICAL. There is no actor who holds one of those and not this one —
     * which is the condition under which a list is needed, and it does not hold.
     */
    permission: 'backup.view',
    group: 'web.navgroup_system',
  },
];

/**
 * The groups, in the order the sidebar draws them. The first, `NAV_STANDALONE_GROUP`, is
 * drawn as plain links above the accordion; every other group is an accordion section.
 */
export const GROUP_ORDER: readonly WebKey[] = [
  'web.navgroup_dashboard',
  'web.navgroup_customers',
  'web.navgroup_support_ai',
  'web.navgroup_sales',
  'web.navgroup_finance',
  'web.navgroup_resellers',
  'web.navgroup_bot',
  'web.navgroup_infra',
  'web.navgroup_config',
  'web.navgroup_system',
];

/**
 * Whether a nav entry owns the current path.
 *
 * `/panels` must light up on `/panels/abc` but `/` must not light up on
 * everything — which is what a bare `startsWith` does, and why the root is a
 * separate case rather than a shorter prefix.
 */
export function isCurrent(entryPath: string, currentPath: string): boolean {
  if (entryPath === '/') return currentPath === '/';
  return currentPath === entryPath || currentPath.startsWith(`${entryPath}/`);
}

/** The group drawn as plain links above the accordion: the dashboard, one click from anywhere. */
export const NAV_STANDALONE_GROUP: WebKey = 'web.navgroup_dashboard';

/**
 * The group that owns a path: the group of the entry `isCurrent` lights up for it, or null for
 * a path no entry owns (`/account`, a redirect). Route ownership is what opens the accordion,
 * so a deep link lands with its own group expanded on the first render.
 */
export function navGroupOf(entries: readonly NavEntry[], currentPath: string): WebKey | null {
  return entries.find((entry) => isCurrent(entry.path, currentPath))?.group ?? null;
}
