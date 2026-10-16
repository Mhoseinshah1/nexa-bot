/**
 * Working catalogue fragment for agent D — marketing & bot.
 *
 * TEMPORARY. While the web-admin demo is implemented by several agents in parallel, each
 * agent adds its NEW `web.*` keys here instead of appending to `web.fa.ts` (which every
 * agent would append to at the same line). A key here whose name already exists in
 * `web.fa.ts` OVERRIDES that key's text (the fragment is spread last). The lead folds every
 * fragment into `web.fa.ts` and deletes this file before the branch is pushed.
 */
export const WEB_FA_MARKETING = {
  // tabs with a dot for unsaved edits or a problem
  'web.bx_tab_problem': 'نیاز به اصلاح',
  // bots — the compact card per bot
  'web.bx_bots_count': 'ربات',
  'web.bx_bots_attention': 'نیازمند توجه',
  // appearance — slots as compact rows, each opening a sheet
  'web.bx_appearance_stored': 'شناسهٔ ذخیره‌شده',
  // reminders — five section cards with sheets
  'web.bx_rem_configure': 'تنظیم',
  'web.bx_rem_flags_on': '{n} از {m} یادآور روشن',
  // bot buttons — the inline buttons as a compact table
  'web.bx_ib_button': 'دکمه',
  'web.bx_ib_group': 'گروه',
  'web.bx_ib_group_all': 'همهٔ گروه‌ها',
  'web.bx_bb_tab_layout': 'چیدمان منوی اصلی',
  'web.bx_bb_duplicate': 'متن تکراری',
  'web.bx_bb_col_place': 'جایگاه',
  'web.bx_bb_col_look': 'ظاهر',
  'web.bx_bb_col_show': 'نمایش و مقصد',
} as const;

/**
 * Keys of `web.fa.ts` this agent's work no longer renders. Listing a key here keeps
 * `check:i18n` quiet until the lead deletes it from `web.fa.ts` when folding.
 */
export const WEB_FA_MARKETING_RETIRED: readonly string[] = [
  // terms: the enforcement switch is a row of its own, without a card title
  'web.terms_enforcement_title',
];
