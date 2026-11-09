/**
 * Web Admin catalogue — Phase 6B PR-2: hosted-bot backups in «میزبانی‌ها», «بازیابی ربات از
 * فایل», and the hosted bot's own backup page.
 *
 * One slice of `WEB_FA`; `../web.fa.ts` merges every slice and is what pages import.
 */
export const WEB_FA_HOSTING_BACKUP = {
  'web.hosted_backup_title': 'بکاپ ربات',
  'web.hosted_backup_hint':
    'بکاپ این ربات جدا از بکاپ خود شما گرفته می‌شود، با رمزی که فقط شما تعیین می‌کنید، و روی هر نصب نکسای دیگری با همان فایل و رمز بازیابی می‌شود.',
  'web.hosted_backup_schedule': 'زمان‌بندی',
  'web.hosted_backup_schedule_on': 'بکاپ روزانه روشن است',
  'web.hosted_backup_schedule_off': 'بکاپ روزانه خاموش است',
  'web.hosted_backup_daily_time': 'ساعت بکاپ روزانه (به وقت تهران)',
  'web.hosted_backup_keep': 'تعداد بکاپ‌های نگه‌داشته روی سرور',
  'web.hosted_backup_schedule_save': 'ذخیرهٔ زمان‌بندی',
  'web.hosted_backup_schedule_title': 'تغییر زمان‌بندی بکاپ',
  'web.hosted_backup_enabled_switch': 'بکاپ روزانهٔ این ربات',
  'web.hosted_backup_password': 'رمز بکاپ',
  'web.hosted_backup_password_set_at': 'رمز تعیین شده در',
  'web.hosted_backup_password_none':
    'هنوز رمزی تعیین نشده؛ تا رمز نگذارید از این ربات بکاپ گرفته نمی‌شود.',
  'web.hosted_backup_password_set': 'تعیین رمز',
  'web.hosted_backup_password_change': 'تغییر رمز',
  'web.hosted_backup_password_title': 'رمز بکاپ این ربات',
  'web.hosted_backup_password_hint':
    'این رمز فایل‌های بکاپ را قفل می‌کند و مالک ربات آن را نمی‌بیند. تغییر آن فقط روی بکاپ‌های بعدی اثر دارد؛ بکاپ‌های قبلی با رمز قبلی باز می‌شوند.',
  'web.hosted_backup_password_field': 'رمز تازه (دست‌کم 12 نویسه)',
  'web.hosted_backup_password_repeat': 'تکرار رمز',
  'web.hosted_backup_password_mismatch': 'دو رمز یکی نیستند.',
  'web.hosted_backup_run_now': 'بکاپ الان',
  'web.hosted_backup_run_title': 'گرفتن بکاپ همین حالا',
  'web.hosted_backup_run_hint':
    'درخواست ثبت می‌شود و سرور در نوبت کارهای سنگین، یکی‌یکی، بکاپ را می‌گیرد.',
  'web.hosted_backup_run_requested': 'بکاپ در نوبت است؛ ثبت شده در',
  'web.hosted_backup_archives': 'فایل‌های بکاپ',
  'web.hosted_backup_archives_empty': 'هنوز بکاپی از این ربات گرفته نشده است.',
  'web.hosted_backup_archive_time': 'زمان',
  'web.hosted_backup_archive_size': 'حجم',
  'web.hosted_backup_archive_status': 'وضعیت',
  'web.hosted_backup_status_ok': 'سالم و آزموده',
  'web.hosted_backup_status_running': 'در حال گرفتن',
  'web.hosted_backup_status_failed': 'ناموفق',
  'web.hosted_backup_status_gone': 'از سرور پاک شده',
  'web.hosted_backup_download': 'دانلود',
  'web.hosted_backup_download_title': 'دانلود فایل بکاپ',
  'web.hosted_backup_download_hint':
    'فایل رمزگذاری‌شده است و با رمز بکاپ همین ربات باز می‌شود. این دانلود در گزارش کارهای شما ثبت می‌شود.',
  'web.hosted_backup_restore_here': 'بازیابی روی همین سرور',
  'web.hosted_backup_restore_here_title': 'بازیابی این بکاپ روی همین ربات',
  'web.hosted_backup_restore_here_hint':
    'همهٔ داده‌های فعلی این ربات با داده‌های این بکاپ جایگزین می‌شود. اول فایل بررسی می‌شود و چیزی تغییر نمی‌کند؛ بعد از تأیید شما، ربات در مدت کار متوقف می‌ماند، از داده‌های فعلی‌اش بکاپ گرفته می‌شود و تا داده‌های تازه کامل و شمرده نشده‌اند داده‌های قبلی پاک نمی‌شوند. همهٔ ورودهای مدیران این ربات بسته می‌شود.',
  'web.hosted_backup_restore_here_password': 'رمزی که این بکاپ با آن گرفته شده',
  'web.hosted_backup_restore_here_done':
    'فایل بررسی شد؛ برای جایگزینی، آن را در «بازیابی ربات از فایل» تأیید کنید.',
  'web.hosted_backup_delivery_group': 'به گروه خود ربات هم فرستاده شد',
  'web.hosted_backup_saved': 'ذخیره شد.',
  // «بازیابی ربات از فایل»
  'web.hosted_restore_title': 'بازیابی ربات از فایل',
  'web.hosted_restore_hint':
    'فایل بکاپ یک ربات میزبانی‌شده از هر نصب نکسا را بارگذاری کنید، رمزش را بدهید، نتیجهٔ بررسی را ببینید و آن را به‌عنوان ربات تازه برگردانید. ربات بازیابی‌شده متوقف می‌ماند تا آن را دوباره فعال کنید.',
  'web.hosted_restore_file': 'فایل بکاپ (.7z)',
  'web.hosted_restore_upload': 'بارگذاری',
  'web.hosted_restore_uploading': 'در حال بارگذاری…',
  'web.hosted_restore_uploaded': 'فایل رسید؛ حالا بررسی را شروع کنید.',
  'web.hosted_restore_dry_run': 'بررسی فایل',
  'web.hosted_restore_dry_run_title': 'بررسی فایل بکاپ',
  'web.hosted_restore_dry_run_hint':
    'فایل باز می‌شود و در یک پایگاه‌داده آزمایشی بازیابی و با فهرستش مقایسه می‌شود؛ چیزی به ربات‌های این سرور اضافه نمی‌شود.',
  'web.hosted_restore_password': 'رمز فایل',
  'web.hosted_restore_slug': 'نشانی کوتاه تازه (اگر نشانی فایل اینجا گرفته شده)',
  'web.hosted_restore_list': 'بازیابی‌ها',
  'web.hosted_restore_empty': 'هنوز بازیابی‌ای انجام نشده است.',
  'web.hosted_restore_rows': 'ردیف‌ها',
  'web.hosted_restore_head_equal': 'نسخهٔ فایل با این سرور یکی است',
  'web.hosted_restore_head_older': 'فایل از نسخهٔ قدیمی‌تر است و به‌روز می‌شود',
  'web.hosted_restore_confirm': 'بازیابی به‌عنوان ربات تازه',
  'web.hosted_restore_replace_switch': 'جایگزینی ربات موجود (همین ربات روی این سرور)',
  'web.hosted_restore_replace_hint':
    'داده‌های فعلی همان ربات با داده‌های فایل جایگزین می‌شود؛ پیش از آن از داده‌های فعلی‌اش بکاپ گرفته می‌شود. ربات حذف‌شده هم برمی‌گردد.',
  'web.hosted_restore_mode': 'نوع',
  'web.hosted_restore_mode_new': 'ربات تازه',
  'web.hosted_restore_mode_replace': 'جایگزینی ربات موجود',
  'web.hosted_restore_pre_replace': 'بکاپ پیش از جایگزینی گرفته شد',
  'web.hosted_restore_replace_confirm': 'جایگزینی داده‌های ربات',
  'web.hosted_restore_replace_confirm_title': 'تأیید جایگزینی',
  'web.hosted_restore_replace_confirm_hint':
    'در پس‌زمینه: ربات متوقف می‌شود، از داده‌های فعلی‌اش بکاپ گرفته می‌شود، داده‌ها در یک مرحله جایگزین و با فایل مقایسه می‌شوند و ربات به وضعیت قبلی‌اش برمی‌گردد. اگر هر مرحله‌ای ناموفق باشد داده‌های فعلی دست‌نخورده می‌مانند.',
  'web.hosted_restore_confirm_title': 'تأیید بازیابی',
  'web.hosted_restore_confirm_hint':
    'بازیابی در پس‌زمینه انجام می‌شود؛ ربات تازه متوقف ساخته می‌شود.',
  'web.hosted_restore_cancel': 'لغو',
  'web.hosted_restore_cancel_title': 'لغو این بازیابی',
  'web.hosted_restore_cancel_hint': 'نتیجهٔ بررسی و فایل بارگذاری‌شده پاک می‌شوند.',
  'web.hosted_restore_state_verifying': 'در حال بررسی',
  'web.hosted_restore_state_verified': 'بررسی شد؛ منتظر تأیید',
  'web.hosted_restore_state_confirmed': 'تأیید شد؛ در نوبت بازیابی',
  'web.hosted_restore_state_applying': 'در حال بازیابی',
  'web.hosted_restore_state_succeeded': 'بازیابی شد',
  'web.hosted_restore_state_failed': 'ناموفق',
  // The hosted bot's own backup page
  'web.hosted_own_backup_title': 'بکاپ‌ها را میزبان مدیریت می‌کند',
  'web.hosted_own_backup_body':
    'بکاپ‌گیری، رمز بکاپ و بازیابی این ربات با میزبان شماست. برای دریافت یا بازیابی بکاپ با میزبان تماس بگیرید.',
  'web.hosted_own_backup_last': 'آخرین بکاپ',
  'web.hosted_own_backup_none': 'هنوز بکاپی گرفته نشده',
  'web.hosted_own_backup_off': 'خاموش',
} as const;
