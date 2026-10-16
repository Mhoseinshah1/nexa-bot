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

  // --- shared list filters (support, infra, system) ------------------------
  'web.ops_filter_from': 'از',
  'web.ops_filter_until': 'تا',
  'web.ops_filter_dates': 'بازهٔ زمانی',
  'web.ops_page_previous': 'قبلی',
  'web.ops_page_next': 'بعدی',

  // --- tickets: saved-view presets -----------------------------------------
  'web.tickets_view_awaiting': 'منتظر پاسخ ما',
  'web.tickets_view_mine': 'تیکت‌های من',
  'web.tickets_view_unassigned': 'بدون مسئول',
  'web.ticket_assignee_change': 'مسئول پاسخ…',
  'web.ticket_priority_change': 'اولویت…',

  // --- business chats: outbound failure codes ------------------------------
  'web.bchat_fc_reply_stale': 'پاسخ هوش مصنوعی دیگر به‌روز نبود',
  'web.bchat_fc_notice_stale': 'پیام اعلام دیگر لازم نبود',
  'web.bchat_fc_mode_off': 'پاسخ خودکار خاموش شد',
  'web.bchat_fc_scope_inactive': 'فروشگاه کار نمی‌پذیرد',
  'web.bchat_fc_moved_on': 'گفتگو پیش از ارسال جلو رفت',
  'web.bchat_fc_notice_template': 'متن پیام اعلام در دسترس نبود',
  'web.bchat_fc_invalid_text': 'متن پیام پذیرفتنی نبود',
  'web.bchat_fc_connection_not_found': 'اتصال بیزینس پیدا نشد',
  'web.bchat_fc_connection_unusable': 'اتصال بیزینس قابل استفاده نیست',
  'web.bchat_fc_bot_unavailable': 'ربات در دسترس نیست',
  'web.bchat_fc_telegram_rejected': 'تلگرام پیام را نپذیرفت',
  'web.bchat_fc_blocked': 'مشتری ربات را مسدود کرده است',
  'web.bchat_fc_rate_limited': 'محدودیت ارسال تلگرام',
  'web.bchat_fc_unreachable': 'تلگرام در دسترس نبود',
  'web.bchat_fc_unreadable': 'پاسخ تلگرام خوانا نبود',
  'web.bchat_fc_connection_mismatch': 'پاسخ تلگرام با این اتصال نمی‌خواند',
  'web.bchat_fc_server_error': 'خطای سرور تلگرام',
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
  // business chats: «load more» became the ten-a-page pager.
  'web.bchat_load_more',
];
