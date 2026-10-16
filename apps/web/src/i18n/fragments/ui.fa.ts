/**
 * Working catalogue fragment for agent A — ui (W1 shared components).
 *
 * TEMPORARY. While the web-admin demo is implemented by several agents in parallel, each
 * agent adds its NEW `web.*` keys here instead of appending to `web.fa.ts` (which every
 * agent would append to at the same line). A key here whose name already exists in
 * `web.fa.ts` OVERRIDES that key's text (the fragment is spread last). The lead folds every
 * fragment into `web.fa.ts` and deletes this file before the branch is pushed.
 */
export const WEB_FA_UI = {
  'web.date_pick': 'انتخاب تاریخ',
  'web.filters': 'فیلترها',
  'web.filters_show_result': 'نمایش نتیجه',
  'web.filters_clear_all': 'پاک کردن همه',
  'web.filters_none': 'بدون فیلتر — همه نمایش داده می‌شوند',
  'web.filters_remove': 'حذف این فیلتر',
  'web.action_panel_title': 'عملیات',
  'web.action_panel_sensitive': 'عملیات حساس',
  'web.file_drop': 'فایل را اینجا رها کنید یا انتخاب کنید',
  'web.file_choose': 'انتخاب فایل',
  'web.saved_views': 'فیلترهای ذخیره‌شده',
} as const;

/**
 * Keys of `web.fa.ts` this agent's work no longer renders. Listing a key here keeps
 * `check:i18n` quiet until the lead deletes it from `web.fa.ts` when folding.
 */
export const WEB_FA_UI_RETIRED: readonly string[] = [];
