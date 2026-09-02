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
  'web.permissions': 'دسترسی‌ها',
  'web.administrators': 'مدیران',
  'web.no_permission': 'شما به این بخش دسترسی ندارید.',
} as const;

export type WebKey = keyof typeof WEB_FA;

export function t(key: WebKey): string {
  return WEB_FA[key];
}
