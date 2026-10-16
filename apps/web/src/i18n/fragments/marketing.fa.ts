/**
 * Working catalogue fragment for agent D — marketing & bot.
 *
 * TEMPORARY. While the web-admin demo is implemented by several agents in parallel, each
 * agent adds its NEW `web.*` keys here instead of appending to `web.fa.ts` (which every
 * agent would append to at the same line). A key here whose name already exists in
 * `web.fa.ts` OVERRIDES that key's text (the fragment is spread last). The lead folds every
 * fragment into `web.fa.ts` and deletes this file before the branch is pushed.
 */
const WEB_FA_MARKETING_NEW = {
  // tabs with a dot for unsaved edits or a problem
  'web.bx_tab_problem': 'نیاز به اصلاح',
  // referrals: its own filter words, «صافی» → «فیلتر» (owner list 10)
  'web.bx_referrals_filter_apply': 'جست‌وجو',
  'web.bx_referrals_filter_clear': 'پاک کردن',
  'web.bx_referrals_filter_empty': 'موردی با این فیلتر پیدا نشد.',
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
 * New texts for keys `web.fa.ts` already declares (the owner's polish list). Typed loosely
 * on purpose: spread after the catalogue's own literal they would trip TS2783 ("specified
 * more than once"), which is exactly the override intended here. The lead folds each text
 * into `web.fa.ts` in place of the old one.
 */
const WEB_FA_MARKETING_OVERRIDES: Readonly<Record<string, string>> = {
  // Polish (owner list 4): hints keep what they say, without the trailing «… is not here».
  'web.campaign_semantics_results': 'نتایج فقط از رکوردهای ثبت‌شده خوانده می‌شوند.',
  'web.campaign_results_hint':
    'فقط واقعیت‌های ثبت‌شده: سفارش‌هایی که از تخفیف همین کمپین استفاده کرده‌اند و کش‌بک‌های همین کمپین.',
  'web.report_failures_hint': 'فقط از وضعیت ساخت‌یافته شمرده می‌شود.',
  'web.report_infra_hint': 'سرویس، ترافیک و خطا به تفکیک پنل.',
  'web.report_resellers_hint':
    'سفارش، فروش، سرویس و بدهی پیشین (موجودی منفی از پیش از حذف خرید اعتباری).',
};

export const WEB_FA_MARKETING: typeof WEB_FA_MARKETING_NEW = Object.assign(
  {},
  WEB_FA_MARKETING_NEW,
  WEB_FA_MARKETING_OVERRIDES,
);

/**
 * Keys of `web.fa.ts` this agent's work no longer renders. Listing a key here keeps
 * `check:i18n` quiet until the lead deletes it from `web.fa.ts` when folding.
 */
export const WEB_FA_MARKETING_RETIRED: readonly string[] = [
  // terms: the enforcement switch is a row of its own, without a card title
  'web.terms_enforcement_title',
  // reports: meta notes that only said what the page does not do (owner list item 4)
  'web.planned_reports_no_logs',
  'web.report_location_unsupported',
  'web.finance_provider_fee_not_recorded',
  'web.finance_no_profit',
  // reports: every pager reads «قبلی / بعدی»
  'web.report_page_previous',
  'web.report_page_next',
  // campaigns: the commands are buttons in the page head, not a card
  'web.campaign_section_commands',
];
