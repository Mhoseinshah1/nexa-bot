/**
 * Web Admin catalogue — «خروجی داده», the open data export (phase 6B PR-3), for a hosted bot's
 * owner in their own Web Admin and for the installation owner inside «میزبانی‌ها».
 *
 * One slice of `WEB_FA`; `../web.fa.ts` merges every slice and is what pages import.
 */
export const WEB_FA_DATA_EXPORT = {
  'web.nav_data_export': 'خروجی داده',
  'web.data_export_title': 'خروجی داده',
  'web.data_export_subtitle':
    'یک فایل ZIP از داده‌های ربات شما: مشتریان، کیف پول و دفتر آن، سفارش‌ها، سرویس‌ها، پرداخت‌ها، محصول‌ها، نمایندگان، تیکت‌ها و پیام‌ها.',
  'web.data_export_what_title': 'در فایل چه می‌آید',
  'web.data_export_what_hint':
    'هر جدول یک فایل CSV است (UTF-8 با BOM تا اکسل فارسی را درست نشان دهد) و فایل README.fa.md هر ستون را توضیح می‌دهد. مبلغ‌ها عدد صحیح و دقیق به کوچک‌ترین واحد پول‌اند و واحد پول کنارشان آمده است.',
  'web.data_export_never_hint':
    'رمزها، توکن‌ها، کلیدها، اعتبارنامه‌های پنل و درگاه، پیوند اشتراک سرویس‌ها و هش رمز مدیران هرگز در خروجی نیست.',
  'web.data_export_request': 'درخواست خروجی داده',
  'web.data_export_requesting': 'در حال ثبت…',
  'web.data_export_requested': 'درخواست ثبت شد. ساخت فایل چند دقیقه طول می‌کشد.',
  'web.data_export_list_title': 'خروجی‌های شما',
  'web.data_export_empty_title': 'هنوز خروجی نگرفته‌اید',
  'web.data_export_empty_hint':
    'با «درخواست خروجی داده» فایل را بسازید؛ پس از آماده شدن 24 ساعت قابل دانلود است.',
  'web.data_export_state_requested': 'در صف',
  'web.data_export_state_running': 'در حال ساخت',
  'web.data_export_state_ready': 'آماده',
  'web.data_export_state_failed': 'ناموفق',
  'web.data_export_state_expired': 'منقضی شد',
  'web.data_export_requested_at': 'زمان درخواست',
  'web.data_export_expires_at': 'قابل دانلود تا',
  'web.data_export_size': 'حجم فایل',
  'web.data_export_by_host': 'درخواست‌شده توسط میزبان',
  'web.data_export_download': 'دانلود ZIP',
  'web.data_export_expired_hint': 'مهلت 24 ساعتهٔ دانلود تمام شد؛ خروجی تازه‌ای درخواست کنید.',
  'web.data_export_failed_hint': 'ساخت فایل ناموفق بود؛ دوباره درخواست دهید.',
  'web.data_export_failed_too_large_hint':
    'حجم داده از حد یک فایل ZIP بیشتر است؛ با مدیر سرور تماس بگیرید.',
  'web.data_export_waiting_hint': 'این صفحه خودش به‌روز می‌شود.',
  // Inside «میزبانی‌ها»: one bot's card.
  'web.hosting_action_data_export': 'خروجی داده',
  'web.hosting_data_export_title': 'خروجی داده',
  'web.hosting_data_export_hint':
    'فایل ZIP داده‌های همین ربات (CSV و README.fa.md). درخواست یک کد تازهٔ دومرحله‌ای می‌خواهد و در گزارش خودتان ثبت می‌شود، نه در گزارش ربات.',
  'web.hosting_data_export_request': 'درخواست خروجی داده',
  'web.hosting_data_export_submit': 'ثبت درخواست',
  'web.hosting_data_export_pending': 'در حال ثبت…',
} as const;
