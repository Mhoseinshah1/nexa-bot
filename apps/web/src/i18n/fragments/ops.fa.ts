/**
 * Working catalogue fragment for agent E — support, infra & system.
 *
 * TEMPORARY. While the web-admin demo is implemented by several agents in parallel, each
 * agent adds its NEW `web.*` keys here instead of appending to `web.fa.ts` (which every
 * agent would append to at the same line). A key here whose name already exists in
 * `web.fa.ts` OVERRIDES that key's text (the fragment is spread last). The lead folds every
 * fragment into `web.fa.ts` and deletes this file before the branch is pushed.
 */
export const WEB_FA_OPS = {
  // --- system: seeded role keys --------------------------------------------
  'web.role_key_owner': 'مالک',
  'web.role_key_operator': 'اپراتور',
  'web.role_key_finance': 'مالی',
  'web.role_key_support': 'پشتیبانی',
  'web.role_key_sales': 'فروش',
  'web.role_key_technical': 'فنی',
  'web.role_key_receipt_reviewer': 'بررسی رسید',
  'web.role_key_observer': 'ناظر',
} as const;

/**
 * Keys of `web.fa.ts` this agent's work no longer renders. Listing a key here keeps
 * `check:i18n` quiet until the lead deletes it from `web.fa.ts` when folding.
 */
export const WEB_FA_OPS_RETIRED: readonly string[] = [
  // system: the commit is no longer shown; the logs and monitor meta notes are gone.
  'web.commit',
  'web.system_logs_absent',
  'web.system_logs_body',
  'web.monitor_separation',
  'web.monitor_separation_hint',
  'web.monitor_heavy',
  'web.monitor_heavy_body',
  'web.monitor_user_sync',
  'web.monitor_user_sync_body',
];
