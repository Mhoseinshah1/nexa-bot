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
  // W1.1 — the Jalali date field
  'web.date_pick': 'انتخاب تاریخ',
  'web.date_pick_datetime': 'انتخاب تاریخ و ساعت',
  'web.date_pick_time': 'انتخاب ساعت',
  'web.date_clear_field': 'پاک کردن تاریخ',
  'web.date_clear': 'پاک کردن',
  'web.date_prev_month': 'ماه قبل',
  'web.date_next_month': 'ماه بعد',
  'web.date_prev_year': 'سال قبل',
  'web.date_next_year': 'سال بعد',
  'web.date_choose_month': 'انتخاب ماه',
  'web.date_today': 'امروز',
  'web.date_yesterday': 'دیروز',
  'web.date_7_days_ago': '۷ روز پیش',
  'web.date_30_days_ago': '۳۰ روز پیش',
  'web.date_gregorian': 'میلادی:',
  'web.date_none': 'تاریخی انتخاب نشده',
  'web.date_pick_day': 'روز را انتخاب کنید',
  'web.date_time': 'ساعت',
  'web.date_hour': 'ساعت',
  'web.date_minute': 'دقیقه',
  'web.date_hour_up': 'ساعت بعد',
  'web.date_hour_down': 'ساعت قبل',
  'web.date_minute_up': 'دقیقهٔ بعد',
  'web.date_minute_down': 'دقیقهٔ قبل',
  'web.date_now': 'الان',
  'web.date_in_one_hour': 'یک ساعت بعد',
  'web.date_tomorrow_10': 'فردا ساعت ۱۰',
  'web.date_9am': '۹ صبح',
  'web.date_noon': '۱۲ ظهر',
  'web.date_6pm': '۱۸ عصر',
  'web.date_confirm': 'تأیید',
  'web.date_24h': '۲۴ ساعته',
  'web.jalali_m1': 'فروردین',
  'web.jalali_m2': 'اردیبهشت',
  'web.jalali_m3': 'خرداد',
  'web.jalali_m4': 'تیر',
  'web.jalali_m5': 'مرداد',
  'web.jalali_m6': 'شهریور',
  'web.jalali_m7': 'مهر',
  'web.jalali_m8': 'آبان',
  'web.jalali_m9': 'آذر',
  'web.jalali_m10': 'دی',
  'web.jalali_m11': 'بهمن',
  'web.jalali_m12': 'اسفند',
  'web.jalali_wd_sat': 'ش',
  'web.jalali_wd_sun': 'ی',
  'web.jalali_wd_mon': 'د',
  'web.jalali_wd_tue': 'س',
  'web.jalali_wd_wed': 'چ',
  'web.jalali_wd_thu': 'پ',
  'web.jalali_wd_fri': 'ج',

  // W1.3 — the filter bar
  'web.filters': 'فیلترها',
  'web.filters_show_result': 'نمایش نتیجه',
  'web.filters_clear_all': 'پاک کردن همه',
  'web.filters_none': 'بدون فیلتر — همه نمایش داده می‌شوند',
  'web.filters_remove': 'حذف این فیلتر',

  // W1.5 — the action panel
  'web.action_panel_title': 'عملیات',
  'web.action_panel_sensitive': 'عملیات حساس',

  // W1.2 — the file picker
  'web.file_drop': 'فایل را اینجا رها کنید یا انتخاب کنید',
  'web.file_choose': 'انتخاب فایل',

  // W1.4 — saved filters
  'web.saved_views': 'فیلترهای ذخیره‌شده',
} as const;

/**
 * Keys of `web.fa.ts` this agent's work no longer renders. Listing a key here keeps
 * `check:i18n` quiet until the lead deletes it from `web.fa.ts` when folding.
 */
export const WEB_FA_UI_RETIRED: readonly string[] = [];
