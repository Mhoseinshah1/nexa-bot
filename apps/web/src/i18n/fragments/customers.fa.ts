/**
 * Working catalogue fragment for agent B — customers & services.
 *
 * TEMPORARY. While the web-admin demo is implemented by several agents in parallel, each
 * agent adds its NEW `web.*` keys here instead of appending to `web.fa.ts` (which every
 * agent would append to at the same line). A key here whose name already exists in
 * `web.fa.ts` OVERRIDES that key's text (the fragment is spread last). The lead folds every
 * fragment into `web.fa.ts` and deletes this file before the branch is pushed.
 */
export const WEB_FA_CUSTOMERS = {
  // W1.4 saved-filter suggestions (the demo's presets).
  'web.users_view_blocked': 'کاربران مسدود',
  'web.services_view_expiring_3d': 'تمام می‌شوند تا ۳ روز',
  'web.services_view_expiring_24h': 'تمام می‌شوند تا ۲۴ ساعت',
  'web.services_view_unreconciled': 'نامشخص روی پنل',
  'web.services_view_delivery_failed': 'لینک به مشتری نرسید',
  'web.services_view_suspended': 'موقتاً قطع',
} as const;

/**
 * Keys of `web.fa.ts` this agent's work no longer renders. Listing a key here keeps
 * `check:i18n` quiet until the lead deletes it from `web.fa.ts` when folding.
 */
export const WEB_FA_CUSTOMERS_RETIRED: readonly string[] = [
  // W5: «آنچه در این نسخه نیست» on /users.
  'web.users_scope_title',
  'web.users_scope_body',
  // W5: «قاعده‌های این صفحه» on /services.
  'web.services_rules_title',
  'web.services_rule_no_protocol',
  'web.services_rule_ordering',
  'web.services_rule_plan_filter',
];
