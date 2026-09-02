/**
 * Web-only chrome.
 *
 * Anything a customer could ever see lives in `@nexa/i18n` and is shared with
 * the Telegram surface. This file holds strings that only the admin SPA can
 * render — page titles, table headers, status labels — under the `web.*`
 * namespace, and is checked by the same missing-key script.
 */
export const WEB_FA = {
  'web.title': 'نکسا بات',
  'web.subtitle': 'پنل مدیریت',
  'web.system_status': 'وضعیت سامانه',
  'web.dependency': 'وابستگی',
  'web.status': 'وضعیت',
  'web.latency': 'تأخیر',
  'web.detail': 'توضیح',
  'web.up': 'در دسترس',
  'web.down': 'خارج از دسترس',
  'web.loading': 'در حال بارگذاری…',
  'web.error': 'خطا در ارتباط با سرور',
  'web.session_unavailable':
    'وضعیت ورود شما قابل بررسی نیست. ممکن است همچنان وارد باشید — پیش از ورود دوباره، اتصال را بررسی کنید.',
  'web.retry': 'تلاش دوباره',
  'web.build_info': 'اطلاعات نسخه',
  'web.version': 'نسخه',
  'web.commit': 'کامیت',
  'web.environment': 'محیط',
  'web.sign_in': 'ورود',
  'web.sign_out': 'خروج',
  'web.username': 'نام کاربری',
  'web.password': 'گذرواژه',
  'web.signing_in': 'در حال ورود…',
  'web.sign_in_failed': 'نام کاربری یا گذرواژه نادرست است.',
  'web.rate_limited': 'تلاش‌های ناموفق زیاد بوده است. کمی بعد دوباره تلاش کنید.',
  'web.signed_in_as': 'وارد شده به عنوان',
  'web.roles': 'نقش‌ها',
  'web.administrators': 'مدیران',
  'web.no_permission': 'شما به این بخش دسترسی ندارید.',

  // Navigation
  'web.nav_overview': 'نمای کلی',
  'web.nav_settings': 'تنظیمات',
  'web.nav_features': 'قابلیت‌ها',
  'web.nav_templates': 'متن‌ها',
  'web.nav_operations': 'رویدادهای عملیاتی',
  'web.nav_notifications': 'اعلان‌ها',

  // Shared
  'web.save': 'ذخیره',
  'web.saving': 'در حال ذخیره…',
  'web.saved': 'ذخیره شد.',
  'web.unchanged': 'ثبت شد، اما مقداری تغییر نکرد.',
  // A list separator is punctuation, but it is still Persian text and it still
  // belongs in the catalogue rather than typed into a component.
  'web.list_separator': '، ',
  'web.value': 'مقدار',
  'web.source': 'منبع',
  'web.source_default': 'پیش‌فرض',
  'web.source_tenant': 'تنظیم‌شده',
  'web.description': 'توضیح',
  'web.updated_at': 'آخرین تغییر',
  'web.conflict':
    'این مقدار در همین فاصله توسط شخص دیگری تغییر کرده است. صفحه را تازه کنید و تغییر خود را دوباره اعمال کنید.',
  'web.key': 'کلید',
  'web.code': 'کد',
  'web.severity': 'شدت',
  'web.message': 'پیام',
  'web.occurrences': 'تعداد رخداد',
  'web.first_seen': 'نخستین بار',
  'web.last_seen': 'آخرین بار',
  'web.resolved': 'برطرف شد',
  'web.unresolved': 'باز',
  'web.all': 'همه',
  'web.refresh': 'تازه‌سازی',
  'web.empty': 'موردی برای نمایش نیست.',

  // Settings
  'web.settings_title': 'تنظیمات',
  'web.settings_intro':
    'هر تنظیم مقدار فعلی، منبع آن، و معنای صفر یا خالی بودنش را نشان می‌دهد. برای خواندن یک مقدار لازم نیست آن را بازنویسی کنید.',
  'web.zero_meaning': 'معنای صفر یا خالی',
  'web.zero_disables': 'صفر یا خالی این قابلیت را غیرفعال می‌کند.',
  'web.zero_unlimited': 'صفر یعنی بدون محدودیت.',
  'web.zero_literal': 'صفر یک مقدار عادی است و معنای ویژه‌ای ندارد.',
  'web.zero_not_applicable': 'صفر یا خالی برای این کلید مجاز نیست.',
  'web.sensitive': 'حساس',
  'web.restart_required': 'نیازمند راه‌اندازی مجدد',

  // Feature flags
  'web.features_title': 'قابلیت‌ها',
  'web.features_intro':
    'هر قابلیت یک کلید روشن یا خاموش است. تنظیمات مربوط به آن در همین‌جا کنار خودش نمایش داده می‌شود.',
  'web.enabled': 'روشن',
  'web.disabled': 'خاموش',
  // The state and the action are different words. One string doing both jobs is
  // how a label comes to mean two things on one screen.
  'web.enable': 'روشن کردن',
  'web.disable': 'خاموش کردن',
  'web.inert': 'تا روشن‌شدن این قابلیت، این مقدار بی‌اثر است.',
  'web.tenant_wide': 'اثر گسترده',
  'web.confirm_key': 'برای تأیید، کلید قابلیت را بنویسید',
  'web.confirm_reason': 'دلیل این تغییر',
  'web.confirm_required': 'این تغییر روی همه مشتریان اثر می‌گذارد. کلید و دلیل را وارد کنید.',

  // Templates
  'web.templates_title': 'متن‌های ربات',
  'web.templates_intro':
    'متن‌ها به صورت خام ذخیره می‌شوند. آنچه در کادر ویرایش می‌بینید همان چیزی است که ذخیره شده — نه نتیجهٔ جای‌گذاری مقادیر.',
  'web.template_body': 'متن خام',
  'web.template_default': 'متن پیش‌فرض',
  'web.placeholders': 'متغیرها',
  'web.required': 'الزامی',
  'web.preview': 'پیش‌نمایش',
  'web.preview_values': 'مقادیر نمونه برای پیش‌نمایش',
  'web.preview_note': 'پیش‌نمایش هیچ چیزی را ذخیره نمی‌کند و مقادیر آن از حساب شما گرفته نمی‌شود.',
  'web.preview_unresolved': 'متغیرهایی که مقداری برایشان داده نشده و دست‌نخورده مانده‌اند',
  'web.revert': 'بازگرداندن به پیش‌فرض',
  'web.revert_note': 'بازگرداندن، متن اختصاصی را حذف می‌کند. تاریخچه حذف نمی‌شود.',
  'web.revisions': 'تاریخچه',
  'web.revision': 'نسخه',
  'web.action': 'عملیات',
  'web.action_set': 'ثبت',
  'web.action_revert': 'بازگردانی',
  'web.override_suppressed':
    'متن اختصاصی این کلید ذخیره شده است اما اعمال نمی‌شود، چون قابلیت متن‌های اختصاصی خاموش است.',

  // Operations
  'web.ops_title': 'رویدادهای عملیاتی',
  'web.ops_intro':
    'آنچه سامانه انجام داده است. رویدادهای تکراری در یک ردیف با شمارنده جمع می‌شوند و هیچ ردیفی حذف نمی‌شود.',
  'web.notifications_title': 'اعلان‌ها',
  'web.notifications_intro':
    'قصد اطلاع‌رسانی و تلاش‌های ارسال دو چیز جدا هستند. اینجا هر دو دیده می‌شوند.',
  'web.status_pending': 'در انتظار',
  'web.status_sent': 'ارسال شد',
  'web.status_failed': 'ناموفق',
  'web.attempts': 'تلاش‌ها',
  'web.attempt': 'تلاش',
  'web.outcome': 'نتیجه',
  'web.error_code': 'کد خطا',
  'web.send_test': 'ارسال پیام آزمایشی',
  'web.test_sent': 'پیام آزمایشی در صف قرار گرفت.',
  'web.destination_missing': 'مقصد اعلان‌ها هنوز تنظیم نشده است.',
} as const;

export type WebKey = keyof typeof WEB_FA;

export function t(key: WebKey): string {
  return WEB_FA[key];
}
