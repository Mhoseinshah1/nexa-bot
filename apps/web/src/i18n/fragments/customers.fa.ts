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
  // W5: «دو پایان ممکن» and the future-rules card on /orders and /orders/:id.
  'web.orders_scope_title',
  'web.orders_scope_body',
  'web.orders_future_rules_title',
  'web.orders_rule_history',
  'web.orders_rule_attention',
  'web.orders_rule_shared_projection',
];
