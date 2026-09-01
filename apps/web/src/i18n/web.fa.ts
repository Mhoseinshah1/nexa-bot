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
  'web.build_info': 'اطلاعات نسخه',
  'web.version': 'نسخه',
  'web.commit': 'کامیت',
  'web.environment': 'محیط',
  'web.auth_notice': 'این نسخه احراز هویت ندارد. ورود و کنترل دسترسی در فاز بعدی اضافه می‌شود.',
} as const;

export type WebKey = keyof typeof WEB_FA;

export function t(key: WebKey): string {
  return WEB_FA[key];
}
