/**
 * Working catalogue fragment for agent B — customers & services.
 *
 * TEMPORARY. While the web-admin demo is implemented by several agents in parallel, each
 * agent adds its NEW `web.*` keys here instead of appending to `web.fa.ts` (which every
 * agent would append to at the same line). A key here whose name already exists in
 * `web.fa.ts` OVERRIDES that key's text (the fragment is spread last). The lead folds every
 * fragment into `web.fa.ts` and deletes this file before the branch is pushed.
 */
/**
 * New texts for keys `web.fa.ts` already declares. Typed as optional so the spread into
 * `WEB_FA` (after the key itself) type-checks; at run time it overrides, as intended.
 */
const CUSTOMERS_OVERRIDES = {
  // W5: no «there is no button» meta note; «صافی» → «فیلتر».
  'web.order_awaiting_banner_body':
    'این سفارش در انتظار پرداخت مشتری است. تأیید دریافت وجه در صفحهٔ پرداخت‌ها انجام می‌شود.',
  'web.orders_filter_empty_hint': 'متن جست‌وجو را بررسی کنید یا فیلترها را پاک کنید.',
  'web.c360_financial_exact': 'هر ارز جداگانه جمع می‌شود.',
} as const;

const CUSTOMERS_NEW = {
  // W1.4 saved-filter suggestions (the demo's presets).
  'web.users_view_blocked': 'کاربران مسدود',
  'web.services_view_expiring_3d': 'تمام می‌شوند تا ۳ روز',
  'web.services_view_expiring_24h': 'تمام می‌شوند تا ۲۴ ساعت',
  'web.services_view_unreconciled': 'نامشخص روی پنل',
  'web.services_view_delivery_failed': 'لینک به مشتری نرسید',
  'web.services_view_suspended': 'موقتاً قطع',
  'web.orders_view_awaiting': 'منتظر پرداخت',
  'web.orders_view_refunded': 'برگشت‌خورده',
  // W3 the OPEN refund request's two decisions.
  'web.service_refund_decide': 'تصمیم دربارهٔ این درخواست',
  // W5 refund-request failure kinds.
  'web.rr_fk_authentication_failed': 'ورود به پنل رد شد',
  'web.rr_fk_authentication_requires_interaction': 'پنل کد دومرحله‌ای خواست',
  'web.rr_fk_unreachable': 'پنل در دسترس نبود',
  'web.rr_fk_timeout': 'پاسخ پنل دیر رسید',
  'web.rr_fk_tls_failed': 'گواهی TLS پنل پذیرفته نشد',
  'web.rr_fk_blocked_target': 'نشانی پنل مجاز نیست',
  'web.rr_fk_rate_limited': 'پنل درخواست‌ها را محدود کرد',
  'web.rr_fk_malformed_response': 'پاسخ پنل نامفهوم بود',
  'web.rr_fk_provider_error': 'پنل خطا داد',
  'web.rr_fk_provider_refused': 'پنل حذف را نپذیرفت',
  'web.rr_fk_unsupported_capability': 'نوع پنل این کار را پشتیبانی نمی‌کند',
  'web.rr_fk_reservation_released': 'رزرو بازگشت وجه پیش‌تر آزاد شده بود',
  // W2 Customer 360's tabs.
  'web.c360_tab_overview': 'نمای کلی',
  'web.c360_tab_services': 'سرویس‌ها و سفارش‌ها',
  'web.c360_tab_support': 'پشتیبانی',
  'web.c360_tab_financial': 'مالی',
  'web.c360_tab_controls': 'کنترل‌ها',
  'web.c360_tab_relations': 'نماینده و معرفی',
  'web.c360_tab_messages': 'پیام‌ها',
  'web.c360_tab_crm': 'یادداشت و برچسب',
  'web.c360_tab_timeline': 'تاریخچه',
  // W1.5 Customer 360's action panel.
  'web.c360_action_panel_title': 'عملیات روی این مشتری',
  'web.c360_group_wallet': 'کیف پول',
  'web.c360_group_orders': 'سفارش‌ها',
  'web.c360_group_contact': 'ارتباط و دسترسی',
  // W3 the wallet and trial dialogs.
  'web.c360_wallet_credit_open': 'واریز به کیف پول',
  'web.c360_wallet_debit_open': 'برداشت از کیف پول',
  'web.c360_trial_set_open': 'ثبت سقف اختصاصی',
  'web.c360_trial_remove_open': 'حذف سقف اختصاصی',
  'web.crm_tag_add_open': 'افزودن برچسب',
  'web.crm_note_open': 'یادداشت تازه',
  // W5 why one service refused the suspend-all / resume-all.
  'web.c360_toggle_refused_not_allowed': 'این کار در وضعیت فعلی سرویس ممکن نیست',
  'web.c360_toggle_refused_in_progress': 'یک عملیات از همین نوع در جریان است',
  'web.c360_toggle_refused_panel': 'پنل این سرویس فعلاً قابل استفاده نیست',
  'web.c360_toggle_refused_order_state': 'وضعیت سفارش این سرویس اجازه نمی‌دهد',
  // W1.5 the service page's action panel.
  'web.service_action_panel_title': 'عملیات روی این سرویس',
  'web.service_group_panel': 'پنل و همگام‌سازی',
  'web.service_group_link': 'لینک اشتراک',
  'web.service_group_state': 'وضعیت سرویس',
  'web.service_group_gift': 'هدیه و تغییر',
} as const;

export const WEB_FA_CUSTOMERS = {
  ...CUSTOMERS_NEW,
  ...(CUSTOMERS_OVERRIDES as Partial<typeof CUSTOMERS_OVERRIDES>),
};

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
  // W5 / W1.5: the service page's transfer note, «why» card and terminate / grant cards.
  'web.services_transfer_absent',
  'web.service_actions_title',
  'web.service_actions_hint',
  'web.service_terminate_title',
  'web.soc_grant_move_title',
  'web.soc_grant_move_hint',
  // W2 / W5: Customer 360's jump menu, danger card, scope card and meta notes.
  'web.c360_nav_label',
  'web.c360_nav_attention',
  'web.c360_nav_general',
  'web.c360_nav_services',
  'web.c360_nav_support',
  'web.c360_nav_financial',
  'web.c360_nav_controls',
  'web.c360_nav_relations',
  'web.c360_nav_timeline',
  'web.c360_nav_danger',
  'web.dm_nav',
  'web.crm_nav',
  'web.c360_danger_title',
  'web.c360_points_absent',
  'web.c360_terms_unavailable',
  'web.wallet_adjust_title',
  'web.extra_devices_no_capable_panel',
  'web.service_locations_no_capable_panel',
  // W5: «دو پایان ممکن» and the future-rules card on /orders and /orders/:id.
  'web.orders_scope_title',
  'web.orders_scope_body',
  'web.orders_future_rules_title',
  'web.orders_rule_history',
  'web.orders_rule_attention',
  'web.orders_rule_shared_projection',
];
