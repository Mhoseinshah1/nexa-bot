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
  'web.unit_bytes': 'بایت',
  'web.unit_mib': 'مگابایت',
  'web.unit_gib': 'گیگابایت',
  'web.unit_tib': 'ترابایت',
  'web.unit_pib': 'پتابایت',
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
  'web.roles': 'نقش‌ها',
  'web.administrators': 'مدیران',
  'web.no_permission': 'شما به این بخش دسترسی ندارید.',

  // Navigation
  'web.nav_overview': 'نمای کلی',
  'web.nav_settings': 'تنظیمات',
  'web.nav_features': 'قابلیت‌ها',
  'web.nav_templates': 'متن‌ها',
  'web.nav_notifications': 'اعلان‌ها',

  // Shared
  'web.save': 'ذخیره',
  'web.saving': 'در حال ذخیره…',
  'web.saved': 'ذخیره شد.',
  'web.unchanged': 'ثبت شد، اما مقداری تغییر نکرد.',
  // A list separator is punctuation, but it is still Persian text and it still
  // belongs in the catalogue rather than typed into a component.
  'web.list_separator': '، ',
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
  'web.settings_intro': 'تنظیمات موردنظر را تغییر دهید و ذخیره کنید.',
  'web.restart_required': 'نیازمند راه‌اندازی مجدد',
  /*
   * WP-A1: the operator's settings page. Titles, descriptions and groups for every
   * registry key, read through `settings-presentation.ts` (a total map, so a key without
   * a Persian name does not compile). Descriptions say what the setting does for the
   * business, in a sentence or two; how the value is stored, where it came from and the
   * engineering history behind it stay in the contract, not on the operator's screen.
   */
  'web.settings_group_sales': 'فروش و سفارش',
  'web.settings_group_wallet': 'کیف پول',
  'web.settings_group_services': 'سرویس‌ها',
  'web.settings_group_reminders': 'یادآوری‌ها',
  'web.settings_group_trial': 'سرویس آزمایشی',
  'web.settings_group_referral': 'معرفی دوستان',
  'web.settings_group_support': 'پشتیبانی و کانال‌ها',
  'web.settings_group_ops': 'گزارش‌های مدیریتی',
  'web.settings_group_other': 'سایر تنظیمات',
  'web.settings_current_value': 'مقدار فعلی',
  'web.settings_value_unset': 'تنظیم نشده',
  'web.settings_range_from': 'عدد صحیح از',
  'web.settings_range_to': 'تا',
  'web.settings_optional_empty': 'برای تنظیم‌نکردن، خالی بگذارید.',
  'web.settings_needs_feature':
    'این تنظیم فقط وقتی اثر دارد که قابلیت مربوط به آن در بخش «قابلیت‌ها» روشن باشد.',
  'web.settings_technical': 'اطلاعات فنی',
  'web.settings_technical_key': 'شناسهٔ فنی',
  'web.settings_technical_issues': 'جزئیات خطا',
  'web.settings_invalid_value':
    'این مقدار پذیرفته نشد. مقدار واردشده را بررسی کنید و دوباره ذخیره کنید.',
  'web.settings_currency_not_sales': 'غیر از واحد پول فروشگاه',
  'web.settings_money_currency_mismatch':
    'این مبلغ به واحد پول فروشگاه نیست و با هیچ مبلغی مقایسه نمی‌شود، پس این تنظیم کار نمی‌کند. واحد پول را به واحد پول فروشگاه تغییر دهید.',
  'web.settings_presets_currency_mismatch':
    'برخی از این مبالغ به واحد پول فروشگاه نیستند و به مشتری نشان داده نمی‌شوند.',
  'web.settings_unknown_title': 'تنظیم ناشناخته',
  'web.settings_unknown_desc':
    'این تنظیم در این نسخه از پنل مدیریت شناخته نمی‌شود. صفحه را تازه کنید.',
  'web.unit_days': 'روز',
  'web.unit_percent': 'درصد',
  'web.unit_times': 'بار',
  'web.unit_messages': 'پیام',
  'web.setting_severity_debug': 'جزئیات اشکال‌زدایی',
  'web.setting_severity_info': 'اطلاع',
  'web.setting_severity_warn': 'هشدار',
  'web.setting_severity_error': 'خطا',
  'web.setting_severity_critical': 'بحرانی',

  'web.setting_ops_chat_id': 'گروه تلگرام گزارش‌های مدیریتی',
  'web.setting_ops_chat_id_desc':
    'گفت‌وگوی تلگرامی که گزارش‌های مدیریتی به آن فرستاده می‌شود. اگر خالی باشد، گزارشی فرستاده نمی‌شود.',
  'web.setting_ops_topic_id': 'تاپیک گزارش‌های سیستم',
  'web.setting_ops_topic_id_desc':
    'تاپیکی از همان گروه که گزارش‌های مدیریتی در آن منتشر می‌شود. اگر خالی باشد، پیام‌ها در خود گروه فرستاده می‌شوند.',
  'web.setting_ops_payments_topic_id': 'تاپیک گزارش‌های پرداخت',
  'web.setting_ops_payments_topic_id_desc':
    'تاپیکی از همان گروه برای گزارش پرداخت‌ها، شارژها، ردشدن‌ها و بازپرداخت‌ها. اگر خالی باشد، این گزارش‌ها در تاپیک گزارش‌های سیستم فرستاده می‌شوند.',
  'web.setting_ops_min_severity': 'کمترین اهمیت برای ارسال',
  'web.setting_ops_min_severity_desc':
    'فقط رویدادهایی که اهمیتشان در این سطح یا بالاتر است به گروه گزارش فرستاده می‌شوند.',
  'web.setting_ops_max_attempts': 'دفعات تلاش برای ارسال هر گزارش',
  'web.setting_ops_max_attempts_desc':
    'برای ارسال هر گزارش حداکثر این تعداد بار تلاش می‌شود؛ پس از آن ارسال ناموفق ثبت می‌شود.',
  'web.setting_ops_max_per_minute': 'سقف ارسال گزارش در هر دقیقه',
  'web.setting_ops_max_per_minute_desc':
    'بیشترین تعداد گزارش مدیریتی که در یک دقیقه به تلگرام فرستاده می‌شود. گزارش‌های بیشتر حذف نمی‌شوند؛ در صف می‌مانند و در دقیقه‌های بعد فرستاده می‌شوند.',
  'web.setting_sales_currency_desc':
    'واحد پولی که قیمت محصولات و مبالغ تازه با آن تعیین می‌شود. تغییر آن قیمت‌های ثبت‌شده را تبدیل نمی‌کند.',
  'web.setting_sales_currency_refused':
    'تا وقتی پرداخت‌های قابل بازپرداختی به واحد پول فعلی وجود دارد، واحد پول فروشگاه را نمی‌توان تغییر داد. ابتدا آن پرداخت‌ها را تسویه یا بازپرداخت کنید.',
  'web.setting_support_accounts': 'حساب‌های پشتیبانی',
  'web.setting_support_accounts_desc':
    'حساب‌های تلگرامی پشتیبانی که به مشتری معرفی می‌شوند، به همین ترتیب. دکمهٔ تماس با پشتیبانی به نخستین حساب باز می‌شود و اگر فهرست خالی باشد نمایش داده نمی‌شود.',
  'web.setting_telegram_channels': 'کانال‌های ربات',
  'web.setting_telegram_channels_desc':
    'کانال‌هایی که به مشتری نشان داده می‌شوند، به همین ترتیب. مشتری تا عضو کانال‌های اجباری نشود نمی‌تواند از ربات استفاده کند.',
  'web.setting_order_expiry_minutes': 'مهلت نگه‌داشتن سفارش پرداخت‌نشده',
  'web.setting_order_expiry_minutes_desc':
    'سفارشی که در این مدت پرداخت نشود منقضی می‌شود و مشتری باید دوباره سفارش دهد.',
  'web.setting_payment_window_minutes': 'مهلت پرداخت',
  'web.setting_payment_window_minutes_desc':
    'مدتی که یک پرداخت در انتظار باز می‌ماند؛ پس از آن پرداخت و سفارشش منقضی می‌شوند.',
  'web.setting_usage_sync_minutes': 'فاصلهٔ به‌روزرسانی مصرف سرویس‌ها',
  'web.setting_usage_sync_minutes_desc':
    'هر چند دقیقه یک بار مصرف حجم سرویس‌ها از پنل خوانده شود. عدد کمتر اطلاعات تازه‌تری به مشتری می‌دهد و درخواست بیشتری به پنل می‌فرستد.',
  'web.setting_topup_minimum_desc':
    'کمترین مبلغی که مشتری می‌تواند کیف پولش را با آن شارژ کند. صفر یعنی بدون حداقل. اگر به واحد پولی غیر از واحد پول فروشگاه باشد، شارژ کیف پول پذیرفته نمی‌شود.',
  'web.setting_topup_maximum': 'بیشینهٔ شارژ کیف پول',
  'web.setting_topup_maximum_desc':
    'بیشترین مبلغی که مشتری می‌تواند برای شارژ کیف پول وارد کند. صفر یعنی بدون سقف. اگر به واحد پولی غیر از واحد پول فروشگاه باشد، شارژ کیف پول پذیرفته نمی‌شود.',
  'web.setting_topup_presets_desc':
    'مبالغ آماده‌ای که هنگام شارژ کیف پول به‌صورت دکمه به مشتری پیشنهاد می‌شوند. فقط مبالغی که به واحد پول فروشگاه هستند نمایش داده می‌شوند.',
  'web.setting_reminders_expiry_first_days_desc':
    'چند روز پیش از پایان اعتبار سرویس، نخستین یادآوری به مشتری فرستاده شود. باید بیشتر از یادآور دوم باشد.',
  'web.setting_reminders_expiry_second_days_desc':
    'چند روز پیش از پایان اعتبار سرویس، یادآوری دوم فرستاده شود. باید کمتر از یادآور اول باشد.',
  'web.setting_reminders_usage_first_percent_desc':
    'وقتی مصرف سرویس به این درصد از حجم برسد، نخستین هشدار فرستاده می‌شود. سرویس‌های حجم نامحدود هشدار نمی‌گیرند.',
  'web.setting_reminders_usage_second_percent_desc':
    'هشدار دوم مصرف حجم. باید بیشتر از آستانهٔ اول و کمتر از آستانهٔ پایانی باشد.',
  'web.setting_reminders_usage_final_percent_desc':
    'هشدار پایانی مصرف حجم؛ ۱۰۰ یعنی لحظهٔ تمام‌شدن حجم. باید بیشتر از آستانهٔ دوم باشد.',
  // WP-A9.
  'web.setting_reminders_expiry_early_days_desc':
    'چند روز پیش از پایان اعتبار سرویس، یادآور هفتگی فرستاده شود؛ زودتر از یادآور اول. صفر یعنی این یادآور فرستاده نشود.',
  'web.setting_reminders_payment_pending_minutes_desc':
    'چند دقیقه پیش از پایان مهلت، یک بار به مشتری‌ای که هنوز کارت‌به‌کارت نکرده یا سفارشش را پرداخت نکرده یادآوری شود.',
  // HF-A9: the quiet window's two boundaries.
  'web.setting_reminders_quiet_hours_start_desc':
    'از این ساعت (به وقت فروشگاه) یادآورها فرستاده نمی‌شوند و تا پایان ساعات سکوت نگه داشته می‌شوند. به شکل ساعت:دقیقه، مثلاً ۲۳:۰۰. فقط وقتی «ساعات سکوت یادآورها» روشن باشد اثر دارد.',
  'web.setting_reminders_quiet_hours_end_desc':
    'در این ساعت (به وقت فروشگاه) ساعات سکوت تمام می‌شود و یادآورهای نگه‌داشته فرستاده می‌شوند. اگر از ساعت شروع کوچک‌تر باشد، بازه از نیمه‌شب می‌گذرد؛ مثلاً ۲۳:۰۰ تا ۰۸:۰۰.',
  'web.setting_wallet_low_balance_threshold_desc':
    'وقتی موجودی کیف پول مشتری از این مبلغ کمتر شود، یک بار به او هشدار داده می‌شود. صفر یعنی هشداری فرستاده نشود. باید به واحد پول فروشگاه باشد.',
  'web.setting_trial_product_id_desc':
    'دیگر استفاده نمی‌شود. سرویس تست اکنون مستقل از محصولات و روی هر پنل (صفحهٔ پنل، زبانهٔ «سرویس تست») تنظیم می‌شود؛ مقدار قبلی این تنظیم یک بار به تنظیمات همان پنل منتقل شده است.',
  'web.setting_trial_limit_per_customer_desc':
    'هر مشتری چند بار می‌تواند سرویس آزمایشی بگیرد. صفر یعنی سرویس آزمایشی به کسی داده نمی‌شود.',
  'web.setting_link_rotation_cooldown_hours_desc':
    'مشتری پس از دریافت لینک اشتراک تازه، باید این مدت صبر کند تا دوباره بتواند لینک تازه بگیرد.',
  'web.setting_referral_commission_percent': 'درصد پورسانت معرفی',
  'web.setting_referral_commission_percent_desc':
    'چند درصد از مبلغ سفارش پرداخت‌شدهٔ کاربر معرفی‌شده به معرف داده شود. اگر خالی بماند، برنامهٔ معرفی اجرا نمی‌شود.',
  'web.setting_referral_commission_scope': 'سفارش‌های مشمول پورسانت',
  'web.setting_referral_commission_scope_desc':
    'پورسانت فقط برای نخستین سفارش پرداخت‌شدهٔ کاربر معرفی‌شده داده شود یا برای همهٔ سفارش‌هایش. تغییر آن فقط روی معرفی‌های بعدی اثر دارد.',
  'web.setting_referral_minimum_order_amount': 'حداقل مبلغ سفارش برای پورسانت',
  'web.setting_referral_minimum_order_amount_desc':
    'سفارش‌هایی که مبلغشان کمتر از این مقدار است پورسانتی ندارند. صفر یعنی بدون حداقل. اگر به واحد پولی غیر از واحد پول سفارش باشد، هیچ سفارشی پورسانت نمی‌گیرد؛ مبلغ‌ها تبدیل ارز نمی‌شوند.',
  'web.setting_referral_signup_gift_total_desc':
    'کل هدیه‌ای که پس از یک معرفی معتبر میان معرف و کاربر تازه تقسیم می‌شود. صفر یعنی هدیه‌ای پرداخت نمی‌شود. باید به واحد پول فروشگاه باشد، وگرنه هدیهٔ عضویت روشن نمی‌شود.',
  'web.setting_referral_signup_gift_referrer_percent_desc':
    'سهم معرف از هدیهٔ عضویت. جمع سهم معرف و کاربر تازه باید ۱۰۰ باشد.',
  'web.setting_referral_signup_gift_referred_percent_desc':
    'سهم کاربر تازه از هدیهٔ عضویت. جمع سهم معرف و کاربر تازه باید ۱۰۰ باشد.',

  // Feature flags
  'web.features_title': 'قابلیت‌ها',
  'web.features_intro':
    'هر قابلیت را با یک کلیک روشن یا خاموش کنید. تنظیمات مربوط به هر قابلیت کنار خودش نمایش داده می‌شود.',
  'web.enabled': 'روشن',
  'web.disabled': 'خاموش',
  'web.inert': 'تا روشن‌شدن این قابلیت، این تنظیمات اثری ندارند.',

  /*
   * WP-A2: each feature's Persian name and one practical sentence, read through
   * `FEATURE_PRESENTATION` in `pages/features-catalogue.ts`. The `_off_effect` line exists
   * only for a feature whose switch-off asks for confirmation, and is shown in that modal.
   */
  'web.feature_last_changed': 'آخرین تغییر',
  'web.feature_related_settings': 'تنظیمات مرتبط',
  'web.feature_setting_unset': 'تعیین نشده',
  'web.feature_confirm_disable': 'آیا از خاموش کردن این قابلیت مطمئن هستید؟',
  'web.feature_confirm_disable_yes': 'بله، خاموش شود',
  'web.feature_confirm_cancel': 'انصراف',
  'web.feature_ops_notifications_title': 'اعلان‌های مدیریتی',
  'web.feature_ops_notifications_summary':
    'خطاها و رویدادهای مهم سامانه و گزارش مالی به گروه مدیریت در تلگرام فرستاده می‌شود.',
  'web.feature_ops_notifications_off_effect':
    'از این پس خطاها و رویدادهای مهم به گروه مدیریت فرستاده نمی‌شوند و رویدادهای این مدت بعداً هم فرستاده نخواهند شد.',
  'web.feature_template_overrides_title': 'شخصی‌سازی متن‌های ربات',
  'web.feature_template_overrides_summary':
    'متن‌هایی که در بخش «متن‌های ربات» تغییر داده‌اید در ربات به کار می‌رود. با خاموش کردن، متن‌های پیش‌فرض نمایش داده می‌شوند و متن‌های شما پاک نمی‌شوند.',
  'web.feature_template_overrides_off_effect':
    'همهٔ پیام‌های ربات بلافاصله به متن پیش‌فرض برمی‌گردند؛ متن‌های شخصی‌سازی‌شده پاک نمی‌شوند.',
  'web.feature_service_expiry_reminders_title': 'یادآوری انقضای سرویس',
  'web.feature_service_expiry_reminders_summary':
    'پیش از پایان مدت سرویس، در نوبت‌هایی که در تنظیمات تعیین شده، به مشتری یادآوری می‌شود.',
  'web.feature_service_expiry_reminders_off_effect':
    'مشتریان پیش از پایان مدت سرویس خود یادآوری دریافت نمی‌کنند.',
  'web.feature_service_expired_notice_title': 'اطلاع پایان سرویس',
  'web.feature_service_expired_notice_summary':
    'وقتی مدت سرویس مشتری به پایان رسید، یک بار به او اطلاع داده می‌شود.',
  'web.feature_service_expired_notice_off_effect':
    'به مشتریان اطلاع داده نمی‌شود که مدت سرویسشان به پایان رسیده است.',
  'web.feature_service_usage_reminders_title': 'یادآوری مصرف حجم',
  'web.feature_service_usage_reminders_summary':
    'وقتی حجم سرویس مشتری رو به اتمام است، در سه آستانه‌ای که در تنظیمات تعیین شده به او هشدار داده می‌شود. سرویس‌های با حجم نامحدود هشدار نمی‌گیرند.',
  'web.feature_service_usage_reminders_off_effect':
    'مشتریان هنگام رو به اتمام بودن حجم سرویس خود هشدار دریافت نمی‌کنند.',
  // WP-A9.
  'web.feature_service_expiry_day_reminder_title': 'یادآوری روز انقضا',
  'web.feature_service_expiry_day_reminder_summary':
    'در روز پایان مدت سرویس و پیش از پایان آن، یک بار به مشتری یادآوری می‌شود.',
  'web.feature_service_expiry_day_reminder_off_effect':
    'مشتریان در روز انقضای سرویس خود یادآوری دریافت نمی‌کنند.',
  'web.feature_wallet_low_balance_reminders_title': 'هشدار کمبود موجودی کیف پول',
  'web.feature_wallet_low_balance_reminders_summary':
    'وقتی موجودی کیف پول مشتری از مبلغ تعیین‌شده در تنظیمات کمتر شود، یک بار به او هشدار داده می‌شود.',
  'web.feature_wallet_low_balance_reminders_off_effect':
    'مشتریان هنگام کم شدن موجودی کیف پول خود هشدار دریافت نمی‌کنند.',
  'web.feature_payment_pending_reminders_title': 'یادآوری پرداخت در انتظار',
  'web.feature_payment_pending_reminders_summary':
    'کمی پیش از پایان مهلت پرداخت کارت‌به‌کارت یا سفارش پرداخت‌نشده، یک بار به مشتری یادآوری می‌شود.',
  'web.feature_payment_pending_reminders_off_effect':
    'مشتریان پیش از پایان مهلت پرداخت خود یادآوری دریافت نمی‌کنند.',
  // HF-A9.
  'web.feature_reminder_quiet_hours_title': 'ساعات سکوت یادآورها',
  'web.feature_reminder_quiet_hours_summary':
    'یادآورهایی که در ساعات سکوت موعدشان می‌رسد حذف نمی‌شوند؛ تا پایان ساعات سکوت نگه داشته و سپس فرستاده می‌شوند، مگر اینکه دیگر معتبر نباشند. پیام‌های پرداخت، سفارش و پاسخ‌ها نگه داشته نمی‌شوند.',
  'web.feature_trials_title': 'سرویس آزمایشی رایگان',
  'web.feature_trials_summary':
    'مشتریان می‌توانند یک سرویس تست رایگان دریافت کنند. برای کار کردن، سرویس تست باید دست‌کم روی یک پنل (در صفحهٔ همان پنل، زبانهٔ «سرویس تست») روشن و تنظیم شده باشد.',
  'web.feature_customer_link_rotation_title': 'دریافت لینک جدید توسط مشتری',
  'web.feature_customer_link_rotation_summary':
    'مشتری می‌تواند از ربات برای سرویس فعال خود لینک اشتراک جدید بگیرد؛ فقط روی پنل‌هایی که این کار را پشتیبانی می‌کنند و با فاصلهٔ زمانی تعیین‌شده.',
  'web.feature_customer_refund_requests_title': 'درخواست بازپرداخت توسط مشتری',
  'web.feature_customer_refund_requests_summary':
    'مشتری می‌تواند از ربات برای سرویس پرداخت‌شدهٔ خود درخواست بازپرداخت ثبت کند. مبلغ را مدیر تعیین می‌کند و پس از حذف سرویس از پنل، به کیف پول مشتری واریز می‌شود.',
  'web.feature_referrals_title': 'برنامهٔ معرفی (زیرمجموعه‌گیری)',
  'web.feature_referrals_summary':
    'مشتری با لینک اختصاصی خود دیگران را معرفی می‌کند و از خریدهای آن‌ها پورسانت به کیف پولش واریز می‌شود. درصد پورسانت باید در تنظیمات تعیین شده باشد.',
  'web.feature_referrals_off_effect':
    'کسانی که در این مدت با لینک معرفی عضو شوند بدون معرف ثبت می‌شوند و بعداً هم به معرف وصل نخواهند شد. پورسانت‌هایی که پیش‌تر وعده داده شده‌اند همچنان پرداخت می‌شوند.',
  'web.feature_referral_signup_gift_title': 'هدیهٔ عضویت با معرفی',
  'web.feature_referral_signup_gift_summary':
    'برای هر معرفی معتبر، مبلغ هدیه میان معرف و کاربر جدید تقسیم می‌شود و هر کدام یک بار سهم خود را دریافت می‌کنند.',
  // A flag from a newer server that this panel build has no entry for.
  'web.feature_unknown_off_effect':
    'این قابلیت برای این نسخه از پنل ناشناخته است و خاموش کردن آن ممکن است بخشی از کار ربات را متوقف کند.',
  'web.feature_custom_service_title': 'سرویس دلخواه',
  'web.feature_custom_service_summary':
    'مشتری موقعیت، حجم و مدت دلخواه خود را انتخاب می‌کند و قیمت بر اساس قیمت هر گیگابایت و هر روز محاسبه می‌شود.',

  // Templates
  'web.templates_title': 'متن‌های ربات',
  'web.templates_intro':
    'پیام‌هایی که ربات برای مشتریان و مدیران می‌فرستد. آنچه در کادر ویرایش می‌بینید همان متن ذخیره‌شده است؛ متغیرهای داخل آکولاد هنگام ارسال با مقدار واقعی جایگزین می‌شوند.',
  'web.template_body': 'متن پیام',
  'web.template_default': 'متن پیش‌فرض',
  'web.placeholders': 'متغیرهای قابل استفاده',
  'web.required': 'الزامی',
  'web.preview': 'پیش‌نمایش',
  'web.preview_values': 'مقادیر نمونه برای پیش‌نمایش',
  'web.preview_note': 'پیش‌نمایش هیچ چیزی را ذخیره نمی‌کند و مقادیر آن از حساب شما گرفته نمی‌شود.',
  'web.preview_unresolved': 'متغیرهایی که مقداری برایشان داده نشده و دست‌نخورده مانده‌اند',
  'web.revert': 'بازگرداندن به پیش‌فرض',
  'web.revert_note':
    'بازگرداندن، متن سفارشی را حذف می‌کند و متن پیش‌فرض دوباره اعمال می‌شود. تاریخچه حذف نمی‌شود.',
  'web.revisions': 'تاریخچه',
  'web.revision': 'نسخه',
  'web.action': 'عملیات',
  'web.action_set': 'ثبت',
  'web.action_revert': 'بازگردانی',
  'web.override_suppressed':
    'متن سفارشی این پیام ذخیره شده است اما اعمال نمی‌شود، چون قابلیت متن‌های سفارشی خاموش است.',
  'web.templates_search': 'جست‌وجو در متن‌ها',
  'web.templates_search_placeholder': 'نام پیام، توضیح، بخشی از متن یا کلید فنی…',
  'web.templates_group': 'بخش',
  'web.templates_group_all': 'همهٔ بخش‌ها',
  'web.templates_filter_custom': 'سفارشی‌شده',
  'web.templates_filter_default': 'پیش‌فرض',
  'web.templates_count': 'متن‌های نمایش‌داده‌شده',
  'web.templates_count_of': 'از',
  'web.templates_no_match': 'متنی با این جست‌وجو یا فیلتر پیدا نشد.',
  'web.templates_clear_filters': 'پاک کردن جست‌وجو و فیلترها',
  'web.template_technical_key': 'کلید فنی',
  'web.template_customised': 'سفارشی‌شده',
  'web.template_format_plain': 'متن ساده',
  'web.template_format_html': 'HTML تلگرام',
  'web.template_format_plain_hint':
    'این پیام به صورت متن ساده فرستاده می‌شود؛ برچسب‌هایی مثل <b> پردازش نمی‌شوند و همان‌طور که نوشته شده‌اند دیده می‌شوند.',
  'web.template_format_html_hint':
    'در این پیام می‌توانید از برچسب‌های قالب‌بندی تلگرام مانند <b>، <i> و <code> استفاده کنید.',
  'web.template_length': 'طول متن',
  'web.template_length_unit': 'نویسه',
  'web.template_placeholders_hint':
    'متغیرها را دقیقاً با همین نوشتار انگلیسی و داخل آکولاد در متن بگذارید؛ ربات هنگام ارسال، مقدار واقعی را جای آن‌ها می‌گذارد. نام متغیرها را ترجمه یا تغییر ندهید.',
  'web.template_no_placeholders': 'این پیام متغیری ندارد.',
  'web.template_placeholder_token': 'متغیر',
  'web.template_placeholder_type': 'نوع مقدار',
  'web.template_required_yes': 'بله',
  'web.template_required_no': 'خیر',
  'web.template_repeatable': 'قابل تکرار',
  'web.template_invalid': 'این متن پذیرفته نشد. موارد زیر را اصلاح کنید.',
  'web.template_issue_empty': 'متن پیام نمی‌تواند خالی باشد.',
  'web.template_issue_too_long': 'متن از حداکثر طول مجاز این پیام بلندتر است؛ آن را کوتاه کنید.',
  'web.template_issue_unknown':
    'این متغیر برای این پیام تعریف نشده است و اگر ذخیره می‌شد، عیناً برای گیرنده فرستاده می‌شد',
  'web.template_issue_missing': 'این متغیر در این پیام اجباری است و نباید حذف شود',
  'web.template_issue_repeated': 'این متغیر فقط یک بار می‌تواند در متن بیاید',
  'web.template_samples_invalid': 'مقدار نمونهٔ برخی متغیرها با نوع آن‌ها جور نیست.',
  'web.template_sample_invalid': 'مقدار نمونه معتبر نیست',
  'web.template_not_overridden':
    'این پیام از قبل روی متن پیش‌فرض است و چیزی برای بازگرداندن نیست. صفحه را تازه کنید.',
  'web.template_unknown_key': 'این پیام در نسخهٔ فعلی سامانه وجود ندارد. صفحه را تازه کنید.',

  // Operations
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
  'web.returned_claims': 'تلاش‌های بازگردانده‌شده',
  'web.returned_claims_intro':
    'تلاش‌هایی که گرفته شدند و بی‌آنکه چیزی ارسال شود پس داده شدند؛ اینها از سهم پیام کم نمی‌شوند. علت sweep.withdrawn یعنی حکم «تمام‌شدن تلاش‌ها» پس گرفته شده است: شکست دائمیِ همان شماره در جدول بالا دیگر سرنوشت این پیام نیست.',
  'web.returned_reason': 'علت بازگرداندن',
  'web.returned_at': 'زمان بازگرداندن',
  'web.send_test': 'ارسال پیام آزمایشی',
  'web.send_test_payments': 'ارسال پیام آزمایشی به تاپیک پرداخت‌ها',
  'web.test_sent': 'پیام آزمایشی در صف قرار گرفت.',
  'web.destination_missing': 'مقصد اعلان‌ها هنوز تنظیم نشده است.',

  // Concurrency and repair
  'web.changed_elsewhere':
    'این مقدار پس از آغاز ویرایش شما جای دیگری تغییر کرده است. ذخیره‌کردن با خطای تداخل روبه‌رو می‌شود.',
  /*
   * The same situation where the server CANNOT refuse the overwrite.
   *
   * `settings` and `content` send an `expectedVersion` and are told about a
   * real conflict; `POST /panels/:id` carries no version, so promising one
   * there described a refusal that cannot happen and invited the operator to
   * press Save expecting to be stopped. The save succeeds and the other
   * administrator's write is gone — the exact harm `VERSION_CONFLICT` exists to
   * name, under a message saying it was safe to try.
   */
  'web.changed_elsewhere_overwrite':
    'این مقدار پس از آغاز ویرایش شما جای دیگری تغییر کرده است. ذخیره‌کردن، تغییر آن‌ها را بازنویسی می‌کند.',
  /*
   * The same row changed elsewhere, in a field this operator has NOT edited.
   *
   * The form sends changed fields only, so saving leaves that field exactly as
   * the other administrator left it. Promising an overwrite here was the
   * previous version's defect in the opposite direction: an operator who did
   * not want to clobber a colleague pressed "load the fresh value", which
   * resets the WHOLE form, and threw away their own unsaved edit to avoid a
   * loss that could not have happened.
   */
  /*
   * The row moved, and this operator cannot save at all — an ARCHIVED panel, or
   * a viewer without `panels.edit`. No claim about saving, because there is no
   * save; the reload link is the point, and gating the whole notice on write
   * access took away both the only signal that the row had moved and the only
   * control that re-syncs the draft.
   *
   * And no claim about an EDIT either. The two other strings are addressed to
   * somebody who opened a form and typed in it; a `panels.view` actor reading
   * this one never began an edit, so "since your edit started" is a false
   * statement about the reader — the same class of untruth as the rest of this
   * notice's history, pointed at the one audience that cannot act on it. What
   * is true for both audiences is that the values on screen are older than the
   * row.
   */
  'web.changed_elsewhere_readonly':
    'این ردیف جای دیگری تغییر کرده است و مقدارهای روی صفحه از پیش از آن تغییر هستند.',
  'web.changed_elsewhere_untouched':
    'این ردیف پس از آغاز ویرایش شما جای دیگری تغییر کرده است. ذخیره‌کردن تنها فیلدهایی را می‌فرستد که خودتان تغییر داده‌اید.',
  'web.reload_value': 'گرفتن مقدار تازه',
  'web.stored_value_invalid':
    'مقدار ذخیره‌شدهٔ این تنظیم دیگر معتبر نیست و فعلاً مقدار اولیه اعمال می‌شود. با ذخیرهٔ یک مقدار معتبر اصلاح می‌شود.',
  'web.unsaved_changes': 'تغییرات ذخیره‌نشده دارید.',
  'web.preview_stale': 'متن پس از این پیش‌نمایش تغییر کرده است. دوباره پیش‌نمایش بگیرید.',
  'web.discard': 'دورانداختن تغییرات',
  'web.sample_number': 'یک عدد صحیح با رقم لاتین، مثلاً 30',
  'web.sample_days': 'تعداد روز با رقم لاتین، مثلاً 30؛ صفر یعنی نامحدود',
  'web.sample_bytes': 'حجم به بایت با رقم لاتین، مثلاً 10737418240 برای ۱۰ گیگابایت',
  'web.sample_traffic_limit':
    'سقف حجم به بایت با رقم لاتین، مثلاً 10737418240 برای ۱۰ گیگابایت؛ صفر یعنی نامحدود',
  'web.sample_datetime': 'یک تاریخ به قالب ISO، مثلاً 2026-09-02T08:00:00Z (Z یعنی به وقت UTC)',
  'web.sample_money': 'مبلغ به کوچک‌ترین واحد و سپس ارز، مثلاً 1250000 IRR',
  'web.older': 'قدیمی‌تر',
  // Shared chrome added in Phase 3D
  'web.copy': 'کپی',
  'web.copied': 'کپی شد',
  'web.copy_failed': 'کپی نشد. مرورگر اجازهٔ دسترسی به حافظهٔ موقت را نداد.',
  'web.working': 'در حال انجام…',
  'web.remove': 'حذف',
  'web.replace': 'جایگزینی',
  'web.move_up': 'انتقال به بالا',
  'web.move_down': 'انتقال به پایین',
  'web.showing': 'نمایش',
  'web.newer': 'تازه‌تر',
  'web.error_hint': 'ارتباط با سرور برقرار نشد. دوباره تلاش کنید.',
  /*
   * A final answer that is NOT a refusal.
   *
   * `web.error`/`web.error_hint` say the connection failed and tell the reader
   * to try again. For a 403 that was already wrong, and the round before this
   * one fixed the 403 arm alone — leaving every OTHER final answer saying the
   * same two false things. `finalAnswer` also covers a `ZodError` on the
   * SUCCESS path (a tab holding a previous release across a deploy, which
   * `polling.ts` calls its headline case), a 404 and a 400: the server
   * answered, correctly and fast, and `retryOf` has deliberately withheld the
   * button the hint tells them to press.
   *
   * So this asserts only what is true of all of them — the answer came back,
   * and repeating the request produces the same one — and names a reload as a
   * conditional, because a reload cures contract skew and cures nothing about
   * a 404.
   */
  'web.rejected': 'سرور این درخواست را نپذیرفت',
  'web.rejected_hint':
    'پاسخ سرور دریافت شد و با تکرار درخواست تغییر نمی‌کند. اگر نسخهٔ تازه‌ای منتشر شده، صفحه را دوباره بارگذاری کنید.',
  /*
   * Shown ABOVE data that is still on screen, not instead of it.
   *
   * The claim is precise on purpose: not "there was an error" — the reader can
   * see the page — but "what you are looking at is older than the server". A
   * page that quietly stops refreshing is the legacy system's defining defect.
   */
  'web.refresh_failed': 'تازه‌سازی این صفحه انجام نشد؛ آنچه می‌بینید از آخرین دریافت موفق است.',
  'web.no_permission_hint':
    'برای دیدن این بخش به دسترسی دیگری نیاز دارید. از یک مدیر بخواهید آن را بدهد.',
  // The separator between a display name and a numeric identifier. It is a
  // real character with spaces around it, because the defect it fixes is two
  // values printed adjacent with nothing between them.
  'web.ident_separator': '—',

  // Currency names. Keyed from the contract enum in format.ts, so a currency
  // added to CURRENCY_CODES without a label here is a compile error.
  'web.currency_irt': 'تومان',
  'web.currency_irr': 'ریال',
  'web.currency_usd': 'USD',
  'web.currency_eur': 'EUR',
  'web.currency_usdt': 'USDT',

  // Maturity — what a surface may claim about a capability
  'web.maturity_now': 'فعال',
  'web.maturity_now_help': 'همین نسخه این کار را انجام می‌دهد.',
  'web.maturity_ready': 'آمادهٔ سرور',
  'web.maturity_ready_help': 'سمت سرور وجود دارد اما هنوز مصرف‌کننده‌ای ندارد.',
  'web.maturity_planned': 'برنامه‌ریزی‌شده',
  'web.maturity_planned_help': 'در این نسخه وجود ندارد و کاری انجام نمی‌دهد.',
  'web.maturity_unsupported': 'پشتیبانی‌نشده',
  'web.maturity_unsupported_help': 'خودِ نرم‌افزار پنل این قابلیت را ندارد.',

  // Credentials
  'web.credential_set': 'تنظیم شده',
  'web.credential_absent': 'تنظیم نشده',

  'web.test_replayed': 'همین درخواست پیش‌تر ثبت شده بود؛ پیام تازه‌ای در صف قرار نگرفت.',

  // --- Shell ---------------------------------------------------------------
  'web.skip_to_content': 'رفتن به محتوا',
  'web.nav_label': 'بخش‌های پنل',
  'web.breadcrumbs': 'مسیر صفحه',
  'web.toggle_sidebar': 'باز و بسته کردن نوار کناری',
  'web.theme': 'پوسته',
  'web.theme_system': 'مطابق سیستم',
  'web.theme_dark': 'تیره',
  'web.theme_light': 'روشن',
  'web.not_found_title': 'این صفحه وجود ندارد.',
  'web.not_found_hint': 'نشانی را بررسی کنید یا به نمای کلی برگردید.',

  // --- Navigation groups ---------------------------------------------------
  'web.navgroup_main': 'نمای کلی',
  'web.navgroup_sales': 'فروش',
  'web.navgroup_infra': 'زیرساخت',
  'web.navgroup_config': 'پیکربندی',
  'web.navgroup_system': 'سامانه و عملیات',

  // --- Navigation ----------------------------------------------------------
  'web.nav_users': 'کاربران',
  'web.nav_services': 'سرویس‌ها',
  'web.nav_orders': 'سفارش‌ها',
  'web.nav_products': 'محصولات',
  'web.nav_payments': 'پرداخت‌ها و کیف پول',
  'web.nav_compensations': 'جبران‌های خودکار',
  'web.nav_discounts': 'تخفیف‌ها و کش‌بک',
  'web.nav_referrals': 'معرفی و پورسانت',
  'web.nav_resellers': 'نمایندگان',
  'web.nav_reseller_tiers': 'سطوح نمایندگی',
  'web.nav_reports': 'گزارش‌ها',
  'web.nav_panels': 'پنل‌ها',
  'web.nav_providers': 'ارائه‌دهندگان',
  'web.nav_bots': 'ربات‌ها',
  'web.nav_alerts': 'هشدارهای مدیریتی',
  'web.nav_system': 'سامانه و عملیات',
  'web.nav_recovery': 'بکاپ و بازیابی',

  // --- Backup and disaster recovery ----------------------------------------
  'web.recovery_title': 'بکاپ و بازیابی',
  'web.recovery_intro': 'وضعیت بکاپ‌های این نصب، و بازگرداندن کل نصب از یکی از بکاپ‌های خودش.',
  'web.recovery_status_title': 'وضعیت بکاپ',
  'web.recovery_history_title': 'تاریخچه بکاپ‌ها',
  'web.recovery_last_success_title': 'آخرین بکاپ موفق',
  'web.recovery_operations_title': 'عملیات بازیابی',
  'web.recovery_schedule': 'بکاپ خودکار',
  'web.recovery_schedule_on': 'روشن',
  'web.recovery_schedule_off': 'خاموش',
  'web.recovery_schedule_off_hint':
    'بکاپ خودکار خاموش است. تاریخچه‌ی سالم به‌تنهایی معنایش این نیست که بکاپی گرفته می‌شود.',
  'web.recovery_interval': 'فاصله‌ی بکاپ‌ها',
  'web.recovery_last_success': 'آخرین موفقیت',
  'web.recovery_never': 'هرگز',
  'web.recovery_running': 'در حال اجرا',
  'web.recovery_unknown_deliveries': 'ارسال‌های نامعلوم',
  'web.recovery_unknown_deliveries_hint':
    'تلگرام ممکن است این فایل‌ها را گرفته باشد یا نگرفته باشد. هیچ‌چیز به‌طور خودکار دوباره ارسال نمی‌شود.',
  'web.recovery_quiesced': 'نصب در حال بازیابی است و تغییرات را نمی‌پذیرد.',
  'web.recovery_run_now': 'تهیه بکاپ جدید',
  'web.recovery_running_now': 'در حال تهیه بکاپ…',
  'web.recovery_run_busy': 'یک بکاپ همین حالا در حال اجراست.',
  'web.recovery_run_done': 'بکاپ گرفته شد و با بازگردانی واقعی راستی‌آزمایی شد.',
  'web.recovery_backup_id': 'شناسه',
  'web.recovery_trigger': 'آغازگر',
  'web.recovery_trigger_manual': 'دستی',
  'web.recovery_trigger_scheduled': 'زمان‌بندی‌شده',
  'web.recovery_trigger_pre_restore': 'پیش از بازیابی',
  'web.recovery_state': 'وضعیت',
  'web.recovery_started': 'شروع',
  'web.recovery_finished': 'پایان',
  'web.recovery_dump_size': 'اندازه‌ی دامپ',
  'web.recovery_archive_size': 'اندازه‌ی آرشیو',
  'web.recovery_checksum': 'چک‌سام',
  'web.recovery_verified': 'راستی‌آزمایی',
  'web.recovery_verified_yes': 'بازگردانی واقعی انجام شد',
  'web.recovery_verified_no': 'راستی‌آزمایی نشده',
  'web.recovery_delivery': 'ارسال به تلگرام',
  'web.recovery_delivery_not_attempted': 'انجام نشد',
  'web.recovery_delivery_succeeded': 'موفق',
  'web.recovery_delivery_failed': 'ناموفق',
  'web.recovery_delivery_unknown': 'نامعلوم',
  'web.recovery_cleanup_incomplete': 'پاک‌سازی ناقص',
  'web.recovery_cleanup_hint':
    'چند فایل موقت روی سرور باقی مانده‌اند و ممکن است دامپ رمزنشده باشند. مسیرها در گزارش عملیاتی سرور است، نه اینجا.',
  'web.recovery_download': 'دریافت آرشیو رمزشده',
  'web.recovery_download_gone': 'فایل محلی دیگر موجود نیست',
  'web.recovery_download_gone_hint':
    'آرشیو رمزشده روی این سرور نگه داشته نشده است. اگر به تلگرام ارسال شده باشد، همان‌جاست.',
  'web.recovery_no_backups': 'هنوز هیچ بکاپی روی این نصب گرفته نشده است.',
  'web.recovery_no_backups_hint': 'تا وقتی بکاپی گرفته نشده باشد، چیزی برای بازگرداندن وجود ندارد.',

  // Upload and verification
  'web.recovery_upload_title': 'بارگذاری آرشیو',
  'web.recovery_upload_hint':
    'فقط آرشیو رمزشده‌ی همین نصب. فایل روی سرور رمزگشایی و راستی‌آزمایی می‌شود؛ کلید هرگز به مرورگر نمی‌آید.',
  'web.recovery_upload_choose': 'انتخاب فایل',
  'web.recovery_upload_send': 'بارگذاری',
  'web.recovery_uploading': 'در حال بارگذاری…',
  'web.recovery_upload_disabled': 'بارگذاری روی این نصب غیرفعال است.',
  'web.recovery_upload_too_large': 'این فایل از حد مجاز این نصب بزرگ‌تر است.',
  'web.recovery_foreign_unsupported': 'پشتیبانی نمی‌شود',
  'web.recovery_foreign_hint':
    'بازیابی از آرشیو نصب دیگر پشتیبانی نمی‌شود: کلید آن نصب اینجا نیست، و هیچ فرمی برای وارد کردن کلید وجود ندارد.',
  'web.recovery_verify': 'راستی‌آزمایی و آزمون بازگردانی',
  'web.recovery_verifying': 'در حال راستی‌آزمایی…',
  'web.recovery_verify_hint':
    'آرشیو رمزگشایی، چک‌سام مقایسه، و با pg_restore واقعی در یک پایگاه‌داده‌ی خالی بازگردانده می‌شود.',
  'web.recovery_tables_restored': 'جدول بازگردانده‌شده',
  'web.recovery_migration_verdict': 'وضعیت مهاجرت‌ها',
  'web.recovery_taken_at': 'زمان تهیه',
  'web.recovery_source_database': 'پایگاه‌داده',

  // The dangerous half
  'web.recovery_restore_title': 'بازگرداندن کل نصب',
  'web.recovery_restore_danger':
    'این کار پایگاه‌داده‌ی فعلی را با محتوای این آرشیو جایگزین می‌کند. پیش از آن، یک بکاپ اجباری از وضعیت فعلی گرفته و راستی‌آزمایی می‌شود؛ اگر آن بکاپ موفق نشود، بازیابی انجام نمی‌شود.',
  'web.recovery_confirm_label': 'برای تأیید، عبارت زیر را دقیقاً تایپ کنید',
  'web.recovery_confirm_button': 'تأیید و شروع بازیابی',
  'web.recovery_confirm_wrong': 'عبارت تأیید مطابقت ندارد.',
  'web.recovery_confirmed': 'بازیابی تأیید شد و در صف اجراست.',
  'web.recovery_confirm_expires': 'اعتبار تأیید',
  'web.recovery_no_permission_restore':
    'شما اجازه‌ی بازگرداندن این نصب را ندارید. راستی‌آزمایی آرشیو همچنان ممکن است.',

  // Recovery list
  'web.recovery_requests_title': 'درخواست‌های بازیابی',
  'web.recovery_no_requests': 'هیچ درخواست بازیابی‌ای ثبت نشده است.',
  'web.recovery_requested_by': 'درخواست‌کننده',
  'web.recovery_stage': 'مرحله',
  'web.recovery_failure': 'کد خطا',
  'web.recovery_displaced': 'پایگاه‌داده‌ی جایگزین‌شده',
  'web.recovery_displaced_hint':
    'پایگاه‌داده‌ی پیش از بازیابی با این نام روی سرور باقی مانده است. چیزی آن را حذف نمی‌کند.',
  'web.recovery_cutover_at': 'زمان جابه‌جایی',

  // --- Planned surfaces ----------------------------------------------------
  'web.planned_why_title': 'چرا هنوز فعال نیست',
  'web.planned_why_hint': 'این بخش به چیزهایی روی سرور نیاز دارد که در این نسخه ساخته نشده‌اند.',
  'web.planned_decided_title': 'آنچه از پیش تصمیم‌گیری شده',
  'web.planned_decided_hint':
    'این قواعد پیش از ساخت این صفحه تعیین شده‌اند و هنگام پیاده‌سازی باید رعایت شوند.',
  'web.planned_status_title': 'وضعیت',
  'web.planned_status_body':
    'هیچ دکمه‌ای در این صفحه وجود ندارد، چون هیچ کاری از سرور برنمی‌آید. دکمهٔ غیرفعال هم نگذاشته‌ایم: دکمهٔ غیرفعال یعنی «هست ولی دسترسی ندارید»، و این درست نیست.',

  /*
   * KEPT, and now rendered on the real Payments page rather than on a placeholder.
   *
   * A gateway is still absent in 4C — `WALLET` and `MANUAL_TRANSFER` are the two
   * rails `SELF_CONTAINED_PAYMENT_METHODS` names — so an operator looking at the
   * method filter needs to know why a third never appears. The other five
   * `planned_payments_*` strings went with the placeholder: two described a page
   * that is now real, one said the payment entity does not exist, and one said
   * receipt review happens in Telegram rather than here, which 4C makes false.
   * The two that named real deferred decisions (payment expiry, refund state)
   * are recorded in `docs/open-questions.md`, where a deferral belongs.
   */
  'web.planned_missing_gateway': 'هیچ درگاه پرداختی ثبت یا تعریف نشده است.',

  'web.planned_reports_no_logs':
    'صفحهٔ لاگ عمومی در پنل وب ساخته نمی‌شود؛ جریان عملیاتی انسانی به گروه گزارش تلگرام می‌رود.',

  // --- Bots (WP13) ------------------------------------------------------------
  'web.bots_subtitle':
    'ربات‌های تلگرام این مجموعه: وضعیت ثبت‌شدهٔ دریافت پیام، توقف و راه‌اندازی، و جایگزینی امن توکن.',
  'web.bots_empty': 'هنوز رباتی برای این مجموعه پیکربندی نشده است.',
  'web.bots_empty_hint':
    'ربات اصلی را نصب‌کننده می‌سازد. اگر نصب ناتمام مانده است، دستور botctl telegram register را روی سرور اجرا کنید.',
  'web.bots_add_title': 'افزودن ربات',
  'web.bots_add_body':
    'در افزودن ربات، «ربات اصلی» وجود نخواهد داشت: ربات اصلی را نصب‌کننده می‌سازد و از این صفحه ساخته نمی‌شود. تنها گزینهٔ آینده «ربات فروش نماینده» است که هنوز ساخته نشده و فعال نیست؛ به همین دلیل اینجا دکمهٔ افزودن وجود ندارد.',
  'web.bot_status_active': 'فعال',
  'web.bot_status_stopped': 'متوقف',
  'web.bot_status_disabled': 'غیرفعال',
  'web.bot_readiness_registered': 'وب‌هوک ثبت شده',
  'web.bot_readiness_not_registered': 'وب‌هوک ثبت نشده',
  'web.bot_readiness_held': 'دریافت پیام متوقف',
  'web.bot_cause_route_disabled':
    'مسیر وب‌هوک در این نصب خاموش است یا راز وب‌هوک تنظیم نشده است؛ هیچ پیامی از تلگرام پذیرفته نمی‌شود. TELEGRAM_WEBHOOK_ENABLED و TELEGRAM_WEBHOOK_SECRET را در nexa.env بررسی و سرویس را دوباره راه‌اندازی کنید.',
  'web.bot_cause_tenant_inactive':
    'این مجموعه پذیرش کار را متوقف کرده است؛ تا مجموعه دوباره فعال نشود، راه‌اندازی ربات چیزی را عوض نمی‌کند.',
  'web.bot_cause_bot_not_active':
    'ربات فعال نیست؛ پیام‌های تلگرام پذیرفته نمی‌شوند و پاسخ یا اعلانی از آن فرستاده نمی‌شود.',
  'web.bot_cause_never_registered':
    'وب‌هوک هرگز در تلگرام ثبت نشده است. دستور botctl telegram register را روی سرور اجرا کنید.',
  'web.bot_cause_secret_changed':
    'وب‌هوک با رازی غیر از راز فعلی ثبت شده است و تلگرام پیام‌ها را با راز قدیمی امضا می‌کند. دستور botctl telegram register را اجرا کنید.',
  'web.bot_cause_secret_unknown':
    'معلوم نیست وب‌هوک با کدام راز ثبت شده است. یک بار دستور botctl telegram register را اجرا کنید تا مشخص شود.',
  'web.bot_tenant': 'مجموعه',
  'web.bot_tenant_fixed':
    'اتصال ربات به مجموعه ثابت است؛ کاربران ذخیره‌شده به همین ربات تعلق دارند.',
  'web.bot_telegram_id': 'شناسهٔ تلگرام',
  'web.bot_telegram_id_unknown': 'ثبت نشده',
  'web.bot_webhook': 'آخرین ثبت وب‌هوک',
  'web.bot_webhook_never': 'هرگز ثبت نشده',
  'web.bot_secret': 'راز وب‌هوک',
  'web.bot_secret_matches': 'با راز فعلی ثبت شده است',
  'web.bot_secret_differs': 'با راز دیگری ثبت شده است',
  'web.bot_secret_unknown': 'نامعلوم',
  'web.bot_secret_not_configured': 'در این نصب تنظیم نشده است',
  'web.bot_menu': 'منوی دستورها',
  'web.bot_menu_current': 'به‌روز',
  'web.bot_menu_stale': 'قدیمی؛ با botctl telegram register به‌روز می‌شود',
  'web.bot_menu_unknown': 'نامعلوم',
  'web.bot_id': 'شناسهٔ داخلی',
  'web.bot_stop': 'توقف ربات',
  'web.bot_start': 'راه‌اندازی ربات',
  'web.bot_stop_confirm_title': 'ربات متوقف شود؟',
  'web.bot_stop_confirm_body':
    'تا وقتی ربات متوقف است، پیام‌های تلگرام پذیرفته نمی‌شوند، به مشتریان پاسخی داده نمی‌شود، اعلان‌های عملیاتی از این ربات فرستاده نمی‌شوند و رسیدهای دریافت‌شده با این ربات باز نمی‌شوند.',
  'web.bot_stop_confirm': 'بله، متوقف شود',
  'web.bot_cancel': 'انصراف',
  'web.bot_stopped_done': 'ربات متوقف شد.',
  'web.bot_started_done': 'ربات راه‌اندازی شد.',
  'web.bot_no_change': 'ربات از قبل در همین وضعیت بود؛ چیزی تغییر نکرد.',
  'web.bot_token_label': 'توکن جدید همین ربات',
  'web.bot_token_hint':
    'فقط توکن تازهٔ همین ربات از BotFather پذیرفته می‌شود. پیش از ذخیره، توکن با تلگرام بررسی، وب‌هوک همین نصب با آن ثبت و از تلگرام بازخوانی می‌شود؛ اگر هر مرحله ناموفق باشد، توکن ذخیره نمی‌شود. توکن ربات دیگری هرگز جایگزین نمی‌شود و توکن فعلی هیچ‌جا نمایش داده نمی‌شود.',
  'web.bot_token_submit': 'جایگزینی توکن',
  'web.bot_token_done':
    'توکن جایگزین شد؛ وب‌هوک این نصب با توکن جدید ثبت و از تلگرام بازخوانی و تأیید شد.',
  'web.bot_token_same':
    'این همان توکن ذخیره‌شده است و تغییری نکرد؛ وب‌هوک این نصب دوباره ثبت و از تلگرام بازخوانی و تأیید شد.',
  'web.bot_check': 'بررسی زنده با تلگرام',
  'web.bot_check_title': 'پاسخ تلگرام در',
  'web.bot_identity_identified': 'تلگرام توکن را پذیرفت.',
  'web.bot_identity_rejected': 'تلگرام توکن ذخیره‌شده را رد کرد؛ توکن را جایگزین کنید.',
  'web.bot_identity_not_telegram': 'نشانی تنظیم‌شدهٔ API تلگرام پاسخی از تلگرام نداد.',
  'web.bot_identity_unreachable': 'تلگرام در دسترس نبود؛ کمی بعد دوباره بررسی کنید.',
  'web.bot_check_id_mismatch': 'تلگرام این توکن را متعلق به ربات دیگری می‌داند.',
  'web.bot_check_username_mismatch': 'نام کاربری ربات در تلگرام تغییر کرده است:',
  'web.bot_webhook_read': 'ثبت وب‌هوک از تلگرام خوانده شد.',
  'web.bot_webhook_rejected': 'تلگرام خواندن ثبت وب‌هوک را رد کرد.',
  'web.bot_webhook_unreachable': 'ثبت وب‌هوک خوانده نشد؛ تلگرام در دسترس نبود.',
  'web.bot_webhook_skipped': 'چون توکن پذیرفته نشد، ثبت وب‌هوک خوانده نشد.',
  'web.bot_check_url': 'نشانی وب‌هوک در تلگرام:',
  'web.bot_check_none': 'هیچ',
  'web.bot_check_url_mismatch': 'با نشانی ثبت‌شده در این نصب یکی نیست',
  'web.bot_check_url_matches': 'با نشانی ثبت‌شده یکی است',
  'web.bot_check_pending': 'پیام‌های در صف تلگرام:',
  'web.bot_check_last_error': 'آخرین خطای تحویل:',
  'web.bot_error_not_found': 'این ربات در این مجموعه وجود ندارد.',
  'web.bot_error_status_not_managed':
    'این ربات در وضعیت «غیرفعال» است که از پنل وب تنظیم یا برداشته نمی‌شود.',
  'web.bot_error_not_active': 'فقط ربات فعال بررسی می‌شود؛ از توکن ربات متوقف استفاده نمی‌شود.',
  'web.bot_error_token_malformed':
    'این توکن ربات تلگرام نیست. توکن از شناسهٔ ربات، دونقطه و بخش محرمانه تشکیل می‌شود.',
  'web.bot_error_token_different_bot':
    'این توکن متعلق به ربات دیگری است. فقط توکن تازهٔ همین ربات پذیرفته می‌شود.',
  'web.bot_error_identity_unknown':
    'شناسهٔ تلگرام این ربات ثبت نشده است. یک بار دستور botctl telegram register را اجرا کنید.',
  'web.bot_error_token_rejected':
    'تلگرام این توکن را رد کرد. توکن تازه‌ای از BotFather بگیرید و دوباره امتحان کنید.',
  'web.bot_error_telegram_unreachable':
    'تلگرام در دسترس نبود و چیزی تغییر نکرد. کمی بعد دوباره امتحان کنید.',
  'web.bot_error_telegram_api_invalid':
    'نشانی تنظیم‌شدهٔ API تلگرام پاسخی از تلگرام نداد. TELEGRAM_API_BASE_URL را بررسی کنید.',
  // R4 — token replacement registers and verifies the webhook before storing the token.
  'web.bot_error_webhook_route_unavailable':
    'این نصب مسیر وب‌هوک تلگرام را ارائه نمی‌دهد (TELEGRAM_WEBHOOK_ENABLED یا TELEGRAM_WEBHOOK_SECRET)، پس وب‌هوکی که ثبت شود کار نمی‌کند. چیزی به تلگرام فرستاده نشد و توکن ذخیره نشد.',
  'web.bot_error_webhook_origin_unknown':
    'این نصب هنوز نشانی عمومی‌ای را که پیام‌های تلگرام را روی آن دریافت می‌کند ثبت نکرده است، پس نشانی وب‌هوک ساخته نمی‌شود. یک بار دستور botctl telegram register را روی سرور اجرا کنید و سپس توکن را جایگزین کنید. چیزی به تلگرام فرستاده نشد.',
  'web.bot_error_replacement_in_progress':
    'جایگزینی دیگری برای توکن همین ربات در جریان است. چند لحظه صبر کنید، وضعیت ربات را ببینید و در صورت نیاز دوباره امتحان کنید. این درخواست چیزی به تلگرام نفرستاد.',
  'web.bot_error_webhook_refused':
    'تلگرام ثبت وب‌هوک این نصب را نپذیرفت، پس توکن ذخیره نشد و ربات همان‌طور که بود ماند. معمولاً دامنه برای تلگرام قابل دسترسی نیست یا گواهی https آن معتبر نیست.',
  'web.bot_error_webhook_setup_failed':
    'تلگرام ثبت وب‌هوک را تأیید نکرد (پاسخی نرسید)، پس توکن ذخیره نشد. کمی بعد دوباره امتحان کنید.',
  'web.bot_error_webhook_verification_failed':
    'تلگرام ثبت وب‌هوک را پذیرفت، اما بازخوانی آن دقیقاً نشانی این نصب را نشان نداد، پس توکن ذخیره نشد.',
  'web.bot_error_token_activation_failed':
    'وب‌هوک ثبت و تأیید شد، اما ذخیرهٔ توکن جدید کامل نشد، پس توکن ذخیره نشد. همان توکن را دوباره ثبت کنید.',
  'web.bot_compensation_not_needed':
    'در تلگرام چیزی برای برگرداندن نبود؛ وب‌هوک ربات همان است که پیش از این تلاش بود.',
  'web.bot_compensation_restored':
    'وب‌هوکی که این تلاش ثبت کرده بود برداشته شد و ربات در تلگرام به حالت قبل (بدون وب‌هوک) برگشت؛ تلگرام پیام‌ها را تا تلاش بعدی نگه می‌دارد.',
  'web.bot_compensation_held':
    'وب‌هوک قبلی ربات به نشانی دیگری بود و تلگرام راز آن را فاش نمی‌کند، پس قابل برگرداندن نیست؛ وب‌هوک برداشته شد تا تلگرام پیام‌ها را تا تلاش بعدی نگه دارد.',
  'web.bot_compensation_superseded':
    'در همین فاصله کس دیگری وب‌هوک ربات را تغییر داده است؛ به آن دست زده نشد.',
  'web.bot_compensation_failed':
    'برگرداندن وضعیت تلگرام ممکن نشد یا تأیید نشد. ربات را با «بررسی زنده» بررسی کنید و توکن را دوباره جایگزین کنید؛ یک رویداد عملیاتی هم ثبت شد.',
  'web.bot_failure_expected': 'نشانی مورد انتظار این نصب:',
  'web.bot_failure_actual': 'نشانی‌ای که تلگرام گزارش داد:',
  'web.bot_failure_telegram_reason': 'دلیل تلگرام:',
  'web.bot_check_expected': 'نشانی وب‌هوک این نصب برای این ربات:',
  'web.bot_check_expected_unknown': 'نامعلوم؛ این نصب هنوز نشانی عمومی خود را ثبت نکرده است',
  'web.bot_check_url_exact': 'دقیقاً همان نشانی این نصب است',
  'web.bot_check_url_not_exact': 'با نشانی این نصب یکی نیست',
  'web.bot_verdict_ready': 'ربات آمادهٔ دریافت پیام است.',
  'web.bot_verdict_not_ready': 'ربات هنوز آمادهٔ دریافت پیام نیست:',
  'web.bot_problem_route_disabled':
    'مسیر وب‌هوک در این نصب خاموش است یا راز وب‌هوک تنظیم نشده است.',
  'web.bot_problem_tenant_inactive': 'این مجموعه پذیرش کار را متوقف کرده است.',
  'web.bot_problem_bot_not_active': 'ربات فعال نیست؛ برای دریافت پیام آن را راه‌اندازی کنید.',
  'web.bot_problem_token_not_accepted': 'تلگرام توکن را نپذیرفت.',
  'web.bot_problem_different_bot': 'تلگرام این توکن را متعلق به ربات دیگری می‌داند.',
  'web.bot_problem_webhook_unreadable': 'وضعیت وب‌هوک از تلگرام خوانده نشد.',
  'web.bot_problem_webhook_expected_unknown':
    'نشانی وب‌هوک این نصب معلوم نیست؛ یک بار دستور botctl telegram register را اجرا کنید.',
  'web.bot_problem_webhook_not_set':
    'تلگرام هیچ وب‌هوکی برای این ربات ندارد و پیام‌ها را نگه می‌دارد؛ توکن فعلی را دوباره در فرم جایگزینی ثبت کنید.',
  'web.bot_problem_webhook_elsewhere':
    'تلگرام پیام‌ها را به نشانی دیگری می‌فرستد؛ توکن فعلی را دوباره در فرم جایگزینی ثبت کنید.',
  'web.bot_problem_webhook_updates_narrowed':
    'وب‌هوک فقط بخشی از انواع پیام را می‌پذیرد (مثلاً دکمه‌ها نمی‌رسند)؛ توکن فعلی را دوباره در فرم جایگزینی ثبت کنید.',
  'web.bot_problem_webhook_secret_not_current':
    'معلوم نیست وب‌هوک با راز فعلی این نصب ثبت شده باشد؛ توکن فعلی را دوباره در فرم جایگزینی ثبت کنید.',

  // --- Panels --------------------------------------------------------------
  'web.panel_new': 'افزودن پنل',
  'web.panel_detail': 'جزئیات پنل',

  // --- Dashboard -----------------------------------------------------------
  'web.dashboard_title': 'نمای کلی',
  'web.dashboard_intro': 'وضعیت واقعی سامانه. هیچ عددی در این صفحه ساختگی نیست.',
  'web.dashboard_panel_distribution': 'توزیع پنل‌ها',
  'web.dashboard_panel_distribution_hint':
    'تجمیع بر اساس پنل است، نه لوکیشن: یک پنل می‌تواند چند لوکیشن داشته باشد و شمارش بر پایهٔ لوکیشن آن را چند بار می‌شمارد.',
  'web.dashboard_by_provider': 'پنل‌ها بر پایهٔ ارائه‌دهنده',
  'web.dashboard_by_provider_hint': 'هر پنل یک بار شمرده می‌شود.',
  'web.dashboard_partial_fleet':
    'این شمارش فقط ۲۰۰ پنل نخست را در بر می‌گیرد؛ ناوگان بزرگ‌تر از یک صفحه است.',
  'web.dashboard_more_conditions': 'شرایط باز دیگر:',
  // The count is a FLOOR: only the first page of open conditions was read.
  'web.dashboard_more_conditions_partial': 'شرایط باز دیگر، دست‌کم (فقط صفحهٔ نخست خوانده شد):',
  'web.monitor_over_capacity': 'فراتر از ظرفیت',
  'web.setting_topup_minimum': 'کمینهٔ شارژ کیف پول',
  'web.setting_sales_currency': 'واحد پول فروشگاه',
  'web.setting_topup_presets': 'مبالغ شارژ کیف پول',
  'web.topup_preset_add': 'افزودن مبلغ',
  'web.topup_preset_empty': 'هیچ مبلغی تنظیم نشده است.',
  'web.admin_active': 'فعال',
  'web.admin_suspended': 'معلق',
  // The Telegram binding of an administrator: System → Administrators.
  'web.admin_telegram': 'تلگرام',
  'web.admin_telegram_not_connected': 'متصل نیست',
  'web.admin_telegram_id_label': 'شناسهٔ عددی تلگرام',
  'web.admin_telegram_id_hint':
    'فقط شناسهٔ عددی حساب تلگرام، مثلاً ۱۲۳۴۵۶۷۸۹ — نه نام کاربری و نه @handle. مدیر باید پس از اتصال یک بار به ربات /start بفرستد.',
  'web.admin_telegram_reason_label': 'دلیل تغییر',
  'web.admin_telegram_reason_hint': 'در سابقهٔ ممیزی ثبت می‌شود.',
  'web.admin_telegram_connect': 'اتصال',
  'web.admin_telegram_replace': 'جایگزینی',
  'web.admin_telegram_remove': 'قطع اتصال',
  'web.admin_telegram_edit': 'ویرایش اتصال تلگرام',
  'web.admin_telegram_cancel': 'انصراف',
  'web.admin_telegram_connected_done':
    'حساب تلگرام متصل شد. مدیر باید یک بار به ربات /start بفرستد تا ربات بتواند به او پیام بدهد.',
  'web.admin_telegram_removed_done':
    'اتصال تلگرام قطع شد. دسترسی مدیریتی از تلگرام از همین لحظه برداشته شد.',
  'web.admin_telegram_id_taken': 'این حساب تلگرام قبلاً به مدیر دیگری متصل است.',
  'web.admin_telegram_id_invalid': 'شناسهٔ عددی تلگرام باید فقط از رقم تشکیل شود.',
  // Creating an administrator: System → Administrators → افزودن مدیر.
  'web.admin_add': 'افزودن مدیر',
  'web.admin_add_title': 'مدیر جدید',
  'web.admin_add_hint':
    'گذرواژه یک بار از همین‌جا فرستاده می‌شود و دیگر هیچ‌جا خوانده نمی‌شود. آن را از مسیر امنی به مدیر برسانید و از او بخواهید پس از اولین ورود خودش تغییرش دهد.',
  'web.admin_username_label': 'نام کاربری ورود',
  'web.admin_username_hint': 'برای ورود به پنل وب. کوچک نوشته می‌شود و یکتاست.',
  'web.admin_display_name_label': 'نام نمایشی',
  'web.admin_password_label': 'گذرواژهٔ اولیه',
  'web.admin_password_hint': 'دست‌کم ۱۲ کاراکتر.',
  'web.admin_roles_label': 'نقش‌ها',
  'web.admin_roles_hint':
    'دست‌کم یک نقش لازم است. نمی‌توانید نقشی بدهید که اختیارات آن را خودتان ندارید.',
  'web.admin_created_done': 'مدیر ساخته شد.',
  'web.admin_username_taken': 'این نام کاربری قبلاً استفاده شده است.',
  // Status, roles, sessions and credential reset on one administrator.
  'web.admin_manage': 'مدیریت',
  'web.admin_manage_close': 'بستن',
  'web.admin_enable': 'فعال‌سازی',
  'web.admin_disable': 'تعلیق',
  'web.admin_status_done': 'وضعیت مدیر تغییر کرد.',
  'web.admin_roles_save': 'ذخیرهٔ نقش‌ها',
  'web.admin_roles_done': 'نقش‌ها تغییر کرد.',
  'web.admin_reason_label': 'دلیل',
  'web.admin_reason_hint': 'در سابقهٔ ممیزی ثبت می‌شود.',
  'web.admin_password_reset': 'بازنشانی گذرواژه',
  'web.admin_password_reset_title': 'بازنشانی گذرواژهٔ این مدیر',
  'web.admin_password_reset_hint':
    'گذرواژهٔ فعلی پرسیده نمی‌شود، چون شما آن را نمی‌دانید. با این کار همهٔ نشست‌های این مدیر بسته می‌شود. گذرواژهٔ خودتان از مسیر «تغییر گذرواژه» عوض می‌شود، نه از اینجا.',
  'web.admin_new_password_label': 'گذرواژهٔ جدید',
  'web.admin_password_reset_done': 'گذرواژه بازنشانی شد و {count} نشست بسته شد.',
  'web.admin_sessions': 'نشست‌های فعال',
  'web.admin_sessions_empty': 'هیچ نشست فعالی ندارد.',
  'web.admin_sessions_current': 'همین نشست',
  'web.admin_session_issued': 'شروع',
  'web.admin_session_last_seen': 'آخرین فعالیت',
  'web.admin_session_expires': 'انقضا',
  'web.admin_session_ip': 'نشانی',
  'web.admin_session_agent': 'عامل کاربر',
  'web.admin_sessions_revoke': 'بستن همهٔ نشست‌ها',
  'web.admin_sessions_revoked_done': '{count} نشست بسته شد.',
  'web.admin_self_modification': 'این کار را روی حساب خودتان نمی‌توانید انجام دهید.',
  'web.admin_privilege_escalation': 'نمی‌توانید اختیاری را بدهید یا بازگردانید که خودتان ندارید.',
  'web.admin_last_owner': 'آخرین مالک را نمی‌توان معلق یا خلع کرد.',
  'web.event_recorded': 'ثبت‌شده',
  'web.event_recovered': 'برطرف شد',
  'web.credential_username': 'نام کاربری',
  'web.credential_password': 'گذرواژه',
  'web.credential_api_token': 'توکن API',
  'web.credential_unusable': 'این نوع پنل از آن استفاده نمی‌کند',
  'web.credential_stored_unusable':
    'یکی از اعتبارنامه‌های ذخیره‌شده با نوع این پنل نمی‌خواند و در هیچ بررسی‌ای استفاده نمی‌شود. می‌توانید حذفش کنید.',
  'web.credential_unsupported_hint':
    'تنها فیلدهایی نمایش داده می‌شوند که این نوع پنل می‌پذیرد. فیلدهای دیگر پیش‌تر ذخیره می‌شدند و هیچ‌گاه استفاده نمی‌شدند.',
  'web.panel_archive': 'بایگانی',
  'web.panel_restore': 'بازگردانی از بایگانی',
  'web.panel_archive_hint':
    'بایگانی نام پنل را آزاد می‌کند و آن را از فهرست‌ها و بررسی‌های خودکار خارج می‌کند. برگشت‌پذیر است.',
  'web.no_changes': 'چیزی تغییر نکرده است.',
  'web.providers_none': 'هیچ ارائه‌دهنده‌ای در دسترس نیست.',
  'web.monitor_tenant_turn_ceiling': 'بیشترین مستأجر در یک بازهٔ تازگی',
  'web.monitor_within_capacity': 'در محدودهٔ ظرفیت',
  'web.dashboard_no_panels': 'هنوز پنلی ثبت نشده است.',
  'web.dashboard_attention': 'نیازمند توجه',
  'web.dashboard_attention_hint':
    'تنها شرایط بازِ مدیریتی. یک رویداد روتین یا وضعیتی که خودش برطرف شده، «نیازمند توجه» نیست.',
  'web.dashboard_nothing_to_do': 'چیزی برای رسیدگی نیست.',
  'web.dashboard_nothing_to_do_hint': 'هیچ شرط مدیریتیِ بازی وجود ندارد.',

  // --- Health --------------------------------------------------------------
  'web.health_healthy': 'سالم',
  'web.health_degraded': 'کند',
  'web.health_unreachable': 'در دسترس نیست',
  'web.health_auth_failed': 'احراز هویت ناموفق',
  'web.health_disabled': 'غیرفعال',
  'web.health_unchecked': 'بررسی نشده',
  'web.health_stale': 'کهنه',
  'web.health_stale_hint':
    'نتیجه آن‌قدر قدیمی است که نباید بر پایهٔ آن تصمیم گرفت. کهنگی را سرور در برابر یک ثابت حساب می‌کند، نه این صفحه.',
  'web.failure_retryable': 'تلاش دوباره ممکن است نتیجهٔ متفاوتی بدهد.',
  'web.failure_permanent': 'تلاش دوباره نتیجه را عوض نمی‌کند؛ چیزی باید اصلاح شود.',

  // --- Panels --------------------------------------------------------------
  'web.panels_title': 'پنل‌ها',
  'web.panels_intro': 'پنل‌های ارائه‌دهنده، سلامت آنها و اعتبارنامه‌هایشان.',
  'web.panels_empty': 'هنوز پنلی ثبت نشده است.',
  'web.panels_empty_hint': 'برای شروع، یک پنل اضافه کنید.',
  'web.panel_name': 'نام',
  'web.panel_provider': 'ارائه‌دهنده',
  'web.panel_health': 'سلامت',
  'web.panel_failure': 'نوع خطا',
  'web.panel_last_check': 'آخرین بررسی',
  'web.panel_latency': 'تأخیر',
  'web.panel_capacity': 'ظرفیت',
  'web.panel_capacity_title': 'ظرفیت و سقف',
  'web.panel_capacity_hint':
    'سقف اختیاری است؛ خالی یعنی بدون محدودیت. پایین‌آوردن سقف زیر مصرف فعلی هیچ سرویسی را حذف نمی‌کند و فقط جلوی فروش تازه را می‌گیرد.',
  'web.panel_capacity_services': 'سرویس‌های فعال',
  'web.panel_capacity_reservations': 'رزرو جاری',
  'web.panel_capacity_used': 'مجموع اشغال',
  'web.panel_capacity_available': 'ظرفیت آزاد',
  'web.panel_capacity_unlimited': 'بدون محدودیت',
  'web.panel_max_services': 'سقف سرویس',

  // The username policy. Read back in full on the panel page, for the reason
  // `docs/conventions.md` names: a setting a surface can write and cannot read is the
  // legacy screen where "the only way to read a price is to overwrite it".
  'web.panel_username_policy': 'یوزرنیم سرویس‌ها',
  'web.panel_username_custom': 'یوزرنیم دلخواه مشتری',
  'web.panel_username_custom_hint':
    'مشتری خودش یوزرنیم را می‌نویسد: ۴ تا ۲۰ نویسه از a-z، A-Z، 0-9، - و _ ، با حداقل یک حرف و یک رقم. حروف بزرگ و کوچک فرقی ندارند و با حروف کوچک ذخیره می‌شود.',
  'web.panel_username_automatic': 'انتخاب خودکار',
  'web.panel_username_automatic_hint':
    'سامانه خودش یوزرنیم می‌سازد، بر اساس روشی که پایین انتخاب می‌کنید.',
  'web.panel_username_strategy': 'روش ساخت خودکار',
  'web.panel_username_strategy_hint':
    'هر یوزرنیم جدید بین ۴ تا ۲۰ نویسه و فقط از حروف کوچک انگلیسی، رقم، خط تیره و زیرخط ساخته می‌شود.',
  'web.panel_username_strategy_RANDOM': 'تصادفی ۱۲ نویسه‌ای',
  'web.panel_username_strategy_PREFIX_RANDOM': 'پیشوند + تصادفی',
  'web.panel_username_strategy_TELEGRAM_ID_RANDOM': 'شناسهٔ تلگرام + تصادفی',
  'web.panel_username_strategy_CUSTOM_TEMPLATE': 'الگوی دلخواه',
  'web.panel_username_prefix': 'پیشوند',
  'web.panel_username_prefix_hint':
    'با یک حرف کوچک انگلیسی شروع شود و حداکثر ۱۴ نویسه باشد، تا دست‌کم ۶ نویسهٔ تصادفی جا بماند. پیش‌فرض nx است.',
  'web.panel_username_template': 'الگوی یوزرنیم',
  'web.panel_username_template_hint':
    'باید دست‌کم یکی از {order4}، {random4}، {random6} یا {random10} را داشته باشد، وگرنه دو خرید یک نام می‌گیرند.',
  'web.panel_username_tokens': 'جانشین‌های مجاز',
  'web.panel_username_bounds':
    'خروجی این الگو بین {best} و {worst} نویسه است؛ مجاز {min} تا {max} نویسه.',
  'web.panel_username_preview': 'نمونهٔ خروجی',
  // Each issue is its own sentence, and all of them are shown at once: an operator
  // fixing one problem per round trip is an operator who gives up.
  'web.panel_username_issue_EMPTY': 'الگو نمی‌تواند خالی باشد.',
  'web.panel_username_issue_MALFORMED': 'آکولاد بازِ بسته‌نشده در الگو هست.',
  'web.panel_username_issue_UNKNOWN_TOKEN': 'جانشینی که این الگو دارد تعریف نشده است.',
  'web.panel_username_issue_ILLEGAL_CHARACTER':
    'متن ثابت الگو فقط می‌تواند حرف کوچک انگلیسی، رقم، خط تیره و زیرخط داشته باشد.',
  'web.panel_username_issue_NO_UNIQUENESS_TOKEN':
    'الگو باید دست‌کم یکی از {order4}، {random4}، {random6} یا {random10} را داشته باشد، وگرنه همه‌ی مشتری‌ها یک یوزرنیم می‌گیرند.',
  'web.panel_username_issue_TOO_LONG': 'بلندترین خروجی این الگو از ۲۰ نویسه بیشتر می‌شود.',
  'web.panel_username_issue_TOO_SHORT': 'کوتاه‌ترین خروجی این الگو از ۴ نویسه کمتر می‌شود.',
  'web.panel_username_policy_empty': 'دست‌کم یکی از دو حالت باید روشن باشد.',
  'web.panel_max_services_hint': 'یک عدد مثبت، یا خالی برای بدون محدودیت.',
  'web.panel_id': 'شناسه',
  'web.panel_identity': 'شناسنامه',
  'web.panel_created': 'زمان ساخت',
  'web.panel_configuration': 'پیکربندی',
  'web.panel_configuration_hint':
    'نوع ارائه‌دهنده قابل تغییر نیست: تغییر آن یعنی تفسیر اعتبارنامه‌های ذخیره‌شده با پروتکلی دیگر.',
  'web.panel_base_url': 'نشانی پایه',
  'web.panel_base_url_hint': 'نشانی کامل پنل، همراه با مسیر پایه اگر دارد.',
  'web.panel_lifecycle': 'چرخهٔ عمر',
  'web.panel_lifecycle_hint':
    'غیرفعال‌کردن، پایش خودکار را متوقف می‌کند اما «تست اتصال» دستی همچنان کار می‌کند.',
  'web.panel_enable': 'فعال‌سازی',
  'web.panel_disable': 'غیرفعال‌سازی',
  'web.panel_status_active': 'فعال',
  'web.panel_status_disabled': 'غیرفعال',
  'web.panel_status_archived': 'بایگانی‌شده',
  'web.panel_test': 'تست اتصال',
  'web.panel_tested': 'تست انجام شد و سلامت به‌روزرسانی شد.',
  'web.panel_test_replayed':
    'تست تازه‌ای انجام نشد؛ همین درخواست پیش‌تر ثبت شده یا به‌تازگی همین پیکربندی بررسی شده است. آنچه می‌بینید سلامت ذخیره‌شده است.',
  'web.panel_tab_overview': 'کلیات',
  'web.panel_tab_health': 'سلامت',
  'web.panel_tab_credentials': 'اعتبارنامه‌ها',
  'web.panel_tab_capabilities': 'قابلیت‌ها',
  'web.panel_tab_workload': 'بار روی پنل',
  // What the panel carries. Two server-filtered lists, a first page of each.
  'web.panel_workload_products': 'محصولات این پنل',
  'web.panel_workload_products_hint':
    'محصولاتی که این پنل را نام برده‌اند. اگر پنل از سرویس خارج شود، فروش همین‌ها متوقف می‌شود.',
  'web.panel_workload_no_products': 'هیچ محصولی این پنل را نام نبرده است.',
  'web.panel_workload_services': 'سرویس‌های روی این پنل',
  'web.panel_workload_services_hint':
    'حساب‌هایی که روی این پنل ساخته شده‌اند. بایگانی کردن پنل هیچ‌کدام را پایان نمی‌دهد.',
  'web.panel_workload_no_services': 'هنوز سرویسی روی این پنل ساخته نشده است.',
  'web.panel_workload_more':
    'بیش از این هم هست؛ فهرست کامل در صفحهٔ مربوط به خودش صفحه‌بندی می‌شود.',
  // The second press on archive, and the two facts it needs before it.
  'web.panel_archive_confirm_title': 'بایگانی کردن این پنل',
  'web.panel_archive_confirm_body':
    'پنل از فهرست‌ها، از زمان‌بندی پایش و از کاتالوگ خارج می‌شود و نامش آزاد می‌شود. سرویس‌هایی که همین حالا روی آن هستند پایان نمی‌یابند و دست‌نخورده می‌مانند. با دکمهٔ بازگردانی می‌توان این کار را برگرداند.',
  'web.panel_archive_confirm': 'بله، بایگانی کن',
  'web.panel_archive_cancel': 'انصراف',
  // Shown to an actor who may create a panel but not open its detail page.
  'web.panel_created_title': 'پنل ساخته شد',
  'web.panel_created_body':
    'پنل ساخته شد. برای دیدن جزئیات آن به دسترسی «مشاهدهٔ پنل‌ها» نیاز است، که شما ندارید. نام پنل:',
  // Shown only after a restore was refused because the name was taken.
  'web.panel_restore_name_taken':
    'نام قبلی این پنل را پنل دیگری گرفته است. بایگانی کردن نام را آزاد می‌کند، بنابراین برای بازگردانی باید نام تازه‌ای بدهید.',
  'web.panel_restore_new_name': 'نام تازه برای بازگردانی',
  // Filter labels for the panel list.
  'web.panels_live': 'در سرویس',
  'web.panels_archived': 'بایگانی‌شده',
  'web.panels_archived_empty': 'پنل بایگانی‌شده‌ای نیست.',
  // Why no connection test is offered, and why the monitor will not probe it
  // either: the stored credentials do not satisfy the provider's shape, so
  // every probe would answer 412 `panel.credentials_missing`.
  'web.panel_not_probeable':
    'اعتبارنامه‌های ذخیره‌شده برای این نوع پنل کامل نیستند، بنابراین نه تست اتصال ممکن است و نه پایش خودکار. از زبانهٔ اعتبارنامه‌ها آن‌ها را کامل کنید.',
  'web.panel_health_latest_title': 'فقط آخرین وضعیت',
  'web.panel_health_latest_body':
    'سلامت پنل تنها به صورت «آخرین وضعیت» ذخیره می‌شود؛ تاریخچه یا نمودار روند وجود ندارد، چون چنین چیزی ذخیره نمی‌شود.',
  'web.panel_upstream_status': 'کد پاسخ پنل',
  'web.panel_provider_version': 'نسخهٔ پنل',
  'web.panel_last_healthy': 'آخرین بار سالم',
  'web.panel_freshness': 'مهلت کهنه‌شدن',
  'web.panel_new_intro': 'ارائه‌دهنده پیش از ساخته‌شدن ردیف پنل تعیین می‌شود.',
  'web.panel_credential_shape': 'شکل اعتبارنامه',
  'web.panel_activation_fields': 'فیلدهای لازم برای فعال‌سازی',
  'web.api_token': 'توکن API',
  'web.api_token_hint':
    'برای دسترسی بدون دخالت انسان، توکن بر گذرواژه ترجیح دارد: پنلی که کد دومرحله‌ای می‌خواهد با گذرواژه قابل استفاده نیست.',
  'web.capability': 'قابلیت',
  'web.capabilities_hint':
    'از خودِ آداپتور ارائه‌دهنده خوانده می‌شود — هم پیاده‌سازی و هم اعلام آن — نه از یک ردیف ذخیره‌شده. هیچ کلیدی در این صفحه قابلیتی را که پنل ندارد روشن نمی‌کند.',
  'web.credentials_one_way_title': 'اعتبارنامه یک‌طرفه است',
  'web.credentials_one_way_body':
    'هیچ اعتبارنامه‌ای خوانده نمی‌شود — نه مقدارش، نه شکل ستاره‌دارش. تنها «تنظیم شده» یا «تنظیم نشده» و زمان آخرین جایگزینی دیده می‌شود. کادرهای جایگزینی خالی شروع می‌شوند؛ کادر خالی یعنی «دست نزن»، نه «پاک کن».',
  'web.credentials_replace': 'جایگزینی اعتبارنامه',
  'web.credentials_replace_hint': 'تنها کادرهایی که پر کنید فرستاده می‌شوند.',
  'web.credentials_nothing_to_do': 'هیچ کادری پر نشده است.',

  // --- Providers -----------------------------------------------------------
  'web.providers_title': 'ارائه‌دهندگان',
  'web.providers_intro': 'پنل‌هایی که این نسخه می‌تواند با آنها کار کند.',
  'web.providers_code_title': 'ارائه‌دهنده کد است، نه ردیف',
  'web.providers_code_body':
    'قابلیت‌ها از توصیف‌گر آداپتور می‌آیند. فهرستی که در مرورگر کپی شود، فهرستی است که در نسخهٔ بعد کهنه می‌شود.',

  // --- Alerts --------------------------------------------------------------
  'web.alerts_title': 'هشدارهای مدیریتی',
  'web.alerts_intro': 'مواردی که واقعاً به رسیدگی یک نفر نیاز دارند.',
  'web.alerts_scope_title': 'این صفحه تاریخچهٔ عملیاتی نیست',
  'web.alerts_scope_body':
    'تنها رویدادهای مدیریتی اینجا می‌آیند: تغییر مدیران و نقش‌ها، قفل‌شدن حساب، رد دسترسی، پرشدن سهمیهٔ پایش یک مستأجر، و تنظیمی که دیگر خوانده نمی‌شود. جریان روتین — هر بررسی سلامت، هر تلاش ارسال، و ازکارافتادن کانال اعلان — به گروه گزارش تلگرام می‌رود.',
  // Two empty states, because there are two questions and only one of them was
  // being answered. The page defaults to HISTORY and carries a severity filter,
  // so "there is no open alert" was printed over filtered-out rows and, worse,
  // over conditions that really were open.
  'web.alerts_empty': 'هشدار بازی وجود ندارد.',
  'web.alerts_empty_hint': 'هیچ شرط مدیریتی بازی ثبت نشده است.',
  'web.alerts_empty_filtered': 'چیزی با این پالایه‌ها پیدا نشد.',
  'web.alerts_empty_filtered_hint':
    'این نتیجه فقط دربارهٔ پالایه‌های کنونی است و نمی‌گوید هشدار بازی وجود ندارد. برای دیدن همهٔ شرط‌های باز، شدت را روی «همه» و نما را روی «حل‌نشده» بگذارید.',

  // --- System --------------------------------------------------------------
  'web.system_title': 'سامانه و عملیات',
  'web.system_intro': 'وضعیت اجرا، نسخهٔ در حال اجرا، مدیران، و پیکربندی پایش.',
  'web.system_tab_status': 'وضعیت',
  'web.system_tab_monitor': 'پایش',
  'web.system_tab_admins': 'مدیران',
  'web.system_status_hint': 'زنده‌بودن و آماده‌بودن دو چیز جدا هستند.',
  'web.build_time': 'زمان ساخت',
  'web.node_version': 'نسخهٔ Node',
  'web.last_login': 'آخرین ورود',
  'web.administrators_hint':
    'دسترسی‌ها روی سرور بررسی می‌شوند؛ پنهان‌کردن یک دکمه، کنترل دسترسی نیست.',
  'web.system_logs_title': 'لاگ‌ها',
  'web.system_logs_absent': 'صفحهٔ لاگ عمومی وجود ندارد',
  'web.system_logs_body':
    'در پنل وب نه صفحهٔ لاگ هست، نه مرورگر لاگ، نه بایگانی. این یک تصمیم است، نه چیزی که جا مانده باشد.',
  // WP16: the Telegram operations group IS built (the operational-event projector and the
  // notification dispatcher); the sentence that said it was not had gone stale.
  'web.system_logs_destination':
    'جریان عملیاتی انسانی به گروه گزارش تلگرام می‌رود؛ شناسهٔ گروه و حداقل سطح اهمیت در تنظیمات «اعلان‌های عملیاتی» تعیین می‌شود.',
  'web.system_tab_diagnostics': 'عیب‌یابی',
  'web.diagnostics_provisioning_title': 'عملیات گیرکرده',
  'web.diagnostics_provisioning_hint':
    'عملیاتی که سامانه هنوز به نتیجهٔ آن نرسیده یا منتظر تلاش دوباره است؛ قدیمی‌ترین‌ها اول.',
  'web.diagnostics_provisioning_empty': 'عملیات گیرکرده‌ای نیست.',
  'web.diagnostics_provisioning_rule':
    'این صفحه چیزی را تغییر نمی‌دهد. برای هر مورد به صفحهٔ همان سرویس بروید؛ «بررسی دوباره» و «ساخت دوباره» همان‌جا و با قواعد خودشان در دسترس‌اند.',
  'web.diagnostics_reason': 'وضعیت',
  'web.diagnostics_reason_unknown': 'نتیجهٔ نامعلوم',
  'web.diagnostics_reason_unknown_hint':
    'پاسخ پنل گم شده است؛ سرویس تا وقتی خواندن از پنل روشنش نکند منتظر می‌ماند و هیچ مبلغی بازگردانده نمی‌شود.',
  'web.diagnostics_reason_lease': 'کارگر متوقف‌شده',
  'web.diagnostics_reason_lease_hint':
    'کارگری این عملیات را برداشته و مهلتش تمام شده است؛ پاک‌سازی دوره‌ای آن را دوباره در صف می‌گذارد.',
  'web.diagnostics_reason_retrying': 'در انتظار تلاش دوباره',
  'web.diagnostics_reason_retrying_hint':
    'دست‌کم یک بار ناموفق بوده و تلاش بعدی زمان‌بندی شده است.',
  'web.diagnostics_reason_unannounced': 'اعلام‌نشده به مشتری',
  'web.diagnostics_reason_unannounced_hint':
    'عملیات بیش از ده دقیقه است که تمام شده ولی هنوز به مشتری اعلام نشده است.',
  'web.diagnostics_operation': 'عملیات',
  'web.diagnostics_attempts': 'تلاش‌ها',
  'web.diagnostics_since': 'آخرین تغییر',
  'web.diagnostics_service': 'سرویس',
  'web.diagnostics_outbox_title': 'صف رویدادها',
  'web.diagnostics_outbox_hint':
    'رویدادهای این مجموعه که هنوز منتشر نشده‌اند. رویدادی که بارها ناموفق شده نشانهٔ خطا در کد است و حذف نمی‌شود.',
  'web.diagnostics_outbox_pending': 'منتشرنشده',
  'web.diagnostics_outbox_oldest': 'قدیمی‌ترین منتشرنشده',
  'web.diagnostics_outbox_failing': 'ناموفق دست‌کم یک بار',
  'web.diagnostics_outbox_failing_banner':
    'برخی رویدادها دست‌کم یک بار ناموفق شده‌اند و دوباره تلاش می‌شوند. متن خطا کوتاه شده و نشانی‌ها از آن حذف شده‌اند.',
  // WP20 (brief §3.2): after twelve real failures a message is kept but no longer retried.
  'web.diagnostics_outbox_exhausted': 'متوقف‌شده پس از ۱۲ تلاش ناموفق',
  'web.diagnostics_outbox_exhausted_banner':
    'برخی رویدادها پس از ۱۲ تلاش ناموفق دیگر خودکار تلاش نمی‌شوند. نگه داشته شده‌اند و در گزارش عملیات ثبت شده‌اند؛ علت خطا باید رفع شود.',
  'web.diagnostics_next_attempt': 'تلاش بعدی',
  'web.diagnostics_no_more_attempts': 'تلاش خودکار متوقف شده',
  'web.diagnostics_event': 'رویداد',
  'web.diagnostics_aggregate': 'موجودیت',
  'web.diagnostics_occurred': 'زمان رخداد',
  'web.diagnostics_error': 'آخرین خطا',

  // --- Monitor -------------------------------------------------------------
  'web.monitor_cadence': 'دوره‌های پایش',
  'web.monitor_cadence_hint':
    'مقادیر مؤثرِ همین نصب، از سرور خوانده می‌شوند — نه عددی که در این صفحه نوشته شده باشد.',
  'web.monitor_enabled': 'پایش خودکار',
  'web.monitor_healthy_interval': 'فاصلهٔ بررسی پنل سالم',
  'web.monitor_retryable_interval': 'پس از خطای قابل تکرار',
  'web.monitor_nonretryable_interval': 'پس از خطای غیرقابل تکرار',
  'web.monitor_tick': 'فاصلهٔ بیدارشدن حلقه',
  'web.monitor_freshness': 'مهلت کهنه‌شدن نتیجه',
  'web.monitor_capacity': 'ظرفیت',
  'web.monitor_capacity_hint': 'چند پنل را می‌توان در مهلت کهنه‌شدن تازه نگه داشت.',
  'web.monitor_capacity_ceiling_note':
    'این‌ها سقف هستند، نه تضمین: تست‌های دستی از همین سهم خرج می‌کنند و تأخیر پنل‌ها در این محاسبه نیست. سقف هر مستأجر و سقف کل نصب را سرور با همان توابعی حساب می‌کند که هشدار ظرفیت را صادر می‌کنند؛ اما «بیشترین مستأجر در یک بازهٔ تازگی» فقط گزارش می‌شود و هیچ هشداری پشت آن نیست — تعداد مستأجرها پیکربندی نیست و رشد می‌کند، پس چیزی نمی‌تواند از عبور از آن جلوگیری کند.',
  'web.monitor_tenant_ceiling': 'سقف هر مستأجر',
  'web.monitor_installation_ceiling': 'سقف کل نصب',
  'web.monitor_probe_budget': 'سهم بررسی هر مستأجر',
  'web.monitor_reserve': 'سهم نگه‌داشته برای اپراتور',
  'web.monitor_batch': 'اندازهٔ دسته',
  'web.monitor_concurrency': 'هم‌زمانی',
  'web.monitor_separation': 'سبک و سنگین',
  'web.monitor_separation_hint':
    'بررسی سلامت سبک و پرتکرار؛ همگام‌سازی سنگین کم‌تکرار و دسته‌ای. این جدا‌سازی در این نسخه بدیهی است، چون هنوز چیز سنگینی وجود ندارد.',
  'web.monitor_lightweight': 'بررسی سلامت',
  'web.monitor_lightweight_body':
    'یک درخواست سبک به هر پنل فعال، با فاصلهٔ بالا. یک پیاده‌سازی بررسی وجود دارد و تست دستی اپراتور و پایش خودکار هر دو از همان استفاده می‌کنند.',
  'web.monitor_heavy': 'آمار سنگین پنل',
  'web.monitor_heavy_body':
    'در این نسخه اصلاً وجود ندارد: هیچ ترافیک، مصرف یا شمار کاربری از پنل خوانده نمی‌شود. وقتی ساخته شود باید حدود هر یک ساعت باشد و هرگز با بررسی سلامت یکی نشود.',
  'web.monitor_user_sync': 'همگام‌سازی کاربران',
  'web.monitor_user_sync_body':
    'در این نسخه وجود ندارد. وقتی ساخته شود باید از فراخوانی گروهی ارائه‌دهنده استفاده کند، و اگر نبود از صفحه‌بندی کران‌دار — هرگز یک درخواست به ازای هر کاربر.',

  // --- Settings, new keys --------------------------------------------------
  'web.setting_no_consumer':
    'این تنظیم ذخیره می‌شود، اما در این نسخه هنوز چیزی آن را نمی‌خواند و روی رفتار ربات اثری ندارد.',
  'web.currency': 'واحد پول',
  'web.amount_minor': 'مبلغ به کوچک‌ترین واحد',
  'web.support_handle': 'شناسهٔ پشتیبانی',
  'web.support_add': 'افزودن حساب پشتیبانی',
  'web.support_empty': 'هیچ حساب پشتیبانی‌ای تعریف نشده است.',
  'web.channel_handle': 'شناسهٔ کانال',
  'web.channel_add': 'افزودن کانال',
  'web.channel_empty': 'هیچ کانالی تعریف نشده است.',
  'web.channel_mandatory': 'عضویت اجباری',
  'web.channel_optional': 'اختیاری',
  'web.channel_chat_id': 'شناسهٔ عددی کانال',
  'web.channel_join_url': 'لینک عضویت',
  'web.channel_enforcement_hint':
    'ربات باید در هر کانال اجباری مدیر باشد. برای کانال خصوصی، شناسهٔ عددی و لینک عضویت را وارد کنید.',

  // --- Customers (Phase 4A) ------------------------------------------------
  'web.users_title': 'کاربران',
  'web.users_intro': 'مشتریان ثبت‌شده از طریق ربات تلگرام، و وضعیت دسترسی آنها.',
  'web.users_empty': 'هنوز هیچ مشتری‌ای ثبت نشده است.',
  'web.users_empty_hint': 'مشتری با نخستین پیام /start به ربات ساخته می‌شود.',
  'web.users_search_empty': 'هیچ مشتری‌ای با این جست‌وجو پیدا نشد.',
  'web.users_search_empty_hint':
    'شناسهٔ عددی تلگرام باید کامل و دقیق باشد؛ نام کاربری با ابتدای آن جست‌وجو می‌شود.',
  'web.users_search_telegram': 'شناسهٔ تلگرام',
  'web.users_search_telegram_hint': 'تطبیق کامل و دقیق. بخشی از شناسه جست‌وجو نمی‌شود.',
  'web.users_search_username': 'نام کاربری',
  'web.users_search_username_hint': 'با ابتدای نام کاربری، بدون حساسیت به بزرگی و کوچکی حرف‌ها.',
  'web.users_search_invalid_telegram': 'شناسهٔ تلگرام فقط رقم است و با صفر آغاز نمی‌شود.',
  'web.users_search_apply': 'جست‌وجو',
  'web.users_search_clear': 'پاک کردن',
  'web.users_search_denied':
    'برای جست‌وجو به دسترسی users.search نیاز است. فهرست بدون جست‌وجو در دسترس شماست.',
  'web.users_filter_all': 'همه',
  'web.user_telegram_id': 'شناسهٔ تلگرام',
  'web.user_username': 'نام کاربری',
  'web.user_name': 'نام',
  'web.user_language': 'زبان',
  'web.user_first_seen': 'نخستین تماس',
  'web.user_last_seen': 'آخرین تماس',
  'web.user_status_active': 'فعال',
  'web.user_status_blocked': 'مسدود',
  'web.user_detail': 'مشتری',
  'web.user_identity_title': 'هویت',
  'web.user_access_title': 'دسترسی',
  'web.user_blocked_at': 'زمان مسدودسازی',
  'web.user_blocked_reason': 'دلیل مسدودسازی',
  'web.user_block': 'مسدود کردن',
  'web.user_unblock': 'رفع مسدودی',
  'web.user_block_reason_label': 'دلیل مسدودسازی (اجباری)',
  'web.user_block_reason_hint':
    'این دلیل در پیام مسدودی به خود مشتری نشان داده می‌شود؛ آن را برای او بنویسید. با رفع مسدودی پاک می‌شود.',
  'web.user_block_reason_required': 'بدون دلیل نمی‌توان مشتری را مسدود کرد.',
  'web.user_block_reason_too_long': 'دلیل مسدودسازی حداکثر ۵۰۰ نویسه است.',
  'web.user_block_confirm_title': 'تأیید مسدودسازی',
  'web.user_block_confirm_body':
    'پس از تأیید، ربات به پیام‌های این مشتری فقط با متن مسدودی و همین دلیل پاسخ می‌دهد. مسدودسازی بدون دلیل انجام نمی‌شود.',
  'web.user_block_confirm': 'تأیید و مسدود کردن',
  'web.user_unblock_confirm_title': 'تأیید رفع مسدودی',
  'web.user_unblock_confirm_body':
    'پس از تأیید، مشتری دوباره می‌تواند از ربات استفاده کند و دلیل مسدودی ثبت‌شده پاک می‌شود.',
  'web.user_unblock_confirm': 'تأیید و رفع مسدودی',
  'web.user_action_cancel': 'انصراف',
  'web.user_blocked_reason_shown': 'نمایش دلیل به مشتری',
  'web.user_blocked_reason_shown_yes': 'مشتری این دلیل را می‌بیند.',
  'web.user_blocked_reason_shown_no':
    'این دلیل پیش از قاعدهٔ فعلی ثبت شده و به مشتری نشان داده نمی‌شود؛ مشتری فقط پیام عمومی مسدودی را می‌بیند.',
  'web.user_blocked_banner_title': 'این مشتری مسدود است',
  'web.user_blocked_banner_body':
    'ربات به پیام‌های او فقط با متن «مسدود» پاسخ می‌دهد و /start این مسدودی را برنمی‌دارد.',
  'web.user_block_denied': 'برای مسدود کردن یا رفع مسدودی به دسترسی users.block نیاز است.',
  'web.user_blocked_done': 'مشتری مسدود شد.',
  'web.user_unblocked_done': 'مسدودی مشتری برداشته شد.',
  /*
   * What this page deliberately does NOT show, said out loud.
   *
   * The legacy customer screen showed a wallet balance, an order count and a
   * service list. This copy said none of those existed — TRUE of Phase 4A, and
   * false from 4C, which builds the wallet and payments. It now names only what
   * is still absent, because a scope card that lists a shipped feature as
   * missing is the same untruth in the other direction.
   *
   * A zero for something unbuilt stays forbidden: that is the legacy statistics
   * screen counting configured panels as connected.
   */
  'web.users_scope_title': 'آنچه در این نسخه نیست',
  'web.users_scope_body':
    'نمایندگی ستونی در فهرست مشتریان ندارد؛ نماینده بودن یا نبودن هر مشتری در کارت «نمایندگی» صفحهٔ همان مشتری آمده است. نمایش صفر برای چیزی که ثبت نشده، گزارشِ نادرست است. تخفیف‌ها و کش‌بک در صفحهٔ «تخفیف‌ها و کش‌بک» مدیریت می‌شوند.',

  // --- A customer's orders and services (WP2) ------------------------------
  /*
   * Two lists the scope card used to say did not exist.
   *
   * Each card is an embedded, paged view of the SAME list the top-level screen
   * pages, filtered to this customer — not a summary and not a count. A count
   * would be a number this page cannot recompute, which is the legacy
   * statistics screen's whole failure; a bounded "recent N" would be a claim
   * about ordering that `/orders` does not make, because it pages oldest-first
   * while `/services` pages newest-first.
   *
   * So the copy names the direction rather than leaving an operator to infer it
   * from two pagers whose buttons mean opposite things.
   */
  'web.user_orders_title': 'سفارش‌های این مشتری',
  'web.user_orders_empty': 'این مشتری هنوز سفارشی ثبت نکرده است.',
  'web.user_orders_denied': 'برای دیدن سفارش‌های این مشتری دسترسی orders.view لازم است.',
  'web.user_orders_hint':
    'این فهرست از قدیمی‌ترین سفارش شروع می‌شود؛ دکمهٔ «تازه‌تر» به سفارش‌های جدیدتر می‌رود.',
  'web.user_orders_all': 'همهٔ سفارش‌های این مشتری',
  'web.user_services_title': 'سرویس‌های این مشتری',
  'web.user_services_empty': 'این مشتری هنوز سرویسی ندارد.',
  'web.user_services_denied': 'برای دیدن سرویس‌های این مشتری دسترسی services.view لازم است.',
  'web.user_services_hint': 'این فهرست از تازه‌ترین سرویس شروع می‌شود.',
  'web.user_services_all': 'همهٔ سرویس‌های این مشتری',

  // --- Wallet (Phase 4C) ---------------------------------------------------
  /*
   * The balance is DERIVED and the history is append-only, and this copy says
   * both. There is no "set balance" string here because there is no such
   * control: the legacy `صفر کردن موجودی` button is a set-balance in disguise
   * and has no ledger reason that could honestly describe it.
   */
  'web.wallet_title': 'کیف پول',
  'web.wallet_balance': 'موجودی',
  'web.wallet_balance_hint': 'این عدد از مجموع تراکنش‌ها محاسبه می‌شود و در جایی ذخیره نشده است.',
  'web.wallet_entry_count': 'تعداد تراکنش',
  'web.wallet_history_title': 'تاریخچه تراکنش‌ها',
  'web.wallet_history_empty': 'هنوز تراکنشی ثبت نشده است.',
  'web.wallet_direction': 'جهت',
  'web.wallet_direction_credit': 'واریز',
  'web.wallet_direction_debit': 'برداشت',
  'web.wallet_reason': 'علت',
  /*
   * There is deliberately NO `web.wallet_reference`.
   *
   * A ledger entry's `reference` is a derived idempotency identity —
   * `<operationId>:purchase` — and not a code anybody quotes. Labelling it
   * «کد یکتا» on screen would invite an operator to read it out as a support
   * reference, and the code a customer actually holds is the PAYMENT's, shown on
   * the payments surface. A key with no renderer was what `check:i18n` caught.
   */
  'web.wallet_note': 'یادداشت',
  'web.wallet_actor': 'ثبت‌کننده',
  'web.wallet_actor_system': 'سامانه',
  'web.wallet_created_at': 'زمان ثبت',
  'web.wallet_adjust_title': 'ثبت تراکنش دستی',
  'web.wallet_adjust_hint':
    'مبلغ به واحد خرد و فقط رقم. علت تراکنش از روی جهت آن تعیین می‌شود و قابل انتخاب نیست.',
  'web.wallet_adjust_amount': 'مبلغ (واحد خرد)',
  'web.wallet_adjust_note': 'یادداشت',
  'web.wallet_credit': 'واریز به کیف پول',
  'web.wallet_debit': 'برداشت از کیف پول',
  'web.wallet_credit_done': 'واریز ثبت شد.',
  'web.wallet_debit_done': 'برداشت ثبت شد.',
  'web.wallet_credit_denied': 'برای واریز به کیف پول دسترسی users.wallet.credit لازم است.',
  'web.wallet_debit_denied': 'برای برداشت از کیف پول دسترسی users.wallet.debit لازم است.',
  'web.wallet_immutable':
    'تراکنش‌های کیف پول قابل ویرایش یا حذف نیستند. اصلاح یک اشتباه، یک تراکنش جدید در جهت مخالف است.',
  'web.wallet_denied': 'برای دیدن کیف پول دسترسی users.view لازم است.',
  'web.wallet_balance_negative': 'بدهکار',
  'web.wallet_balance_negative_hint':
    'موجودی منفی فقط برای نماینده‌ای ممکن است که سقف اعتبار دارد: خریدی که از اعتبار او برداشته شده است. این عدد همان مجموع تراکنش‌هاست و بدهی او در محدودهٔ سقف اعتبارش را نشان می‌دهد.',

  // --- Payments (Phase 4C) -------------------------------------------------
  /*
   * PAID means the money arrived and nothing else.
   *
   * No string here says a service was created, is being prepared, or is on its
   * way — because nothing in this release does any of that. The legacy bot's
   * post-payment copy is the defect this comment exists to prevent being ported:
   * a message that claims an effect which did not happen.
   */
  'web.payments_title': 'پرداخت‌ها',
  'web.payments_intro': 'پولی که رسیده است، و پولی که هنوز در انتظار بررسی است.',
  'web.payments_empty': 'هنوز پرداختی ثبت نشده است.',
  'web.payment_detail': 'جزئیات پرداخت',
  'web.payment_state': 'وضعیت',
  'web.payment_state_pending': 'در انتظار',
  'web.payment_state_confirmed': 'تأیید شده',
  'web.payment_state_failed': 'ناموفق',
  'web.payment_state_cancelled': 'لغو شده',
  'web.payment_state_expired': 'منقضی شده',
  'web.payment_state_unknown': 'نامشخص',
  'web.payment_method': 'روش',
  'web.payment_method_wallet': 'کیف پول',
  'web.payment_method_manual': 'کارت به کارت',
  'web.payment_method_gateway': 'درگاه',
  'web.payment_amount': 'مبلغ',
  'web.payment_reference': 'کد پیگیری',
  'web.payment_customer': 'مشتری',
  'web.payment_order': 'سفارش',
  /*
   * What a payment with no order IS. 5B's top-ups are the first payments in this product
   * that name no order, and the column showed a dash — which reads as missing data.
   */
  'web.payment_topup': 'شارژ کیف پول',
  'web.payment_evidence_kind': 'مبنای تأیید',
  'web.payment_evidence_note': 'یادداشت بررسی',
  'web.payment_reviewer': 'تأییدکننده',
  'web.payment_confirmed_at': 'زمان تأیید',
  'web.payment_created_at': 'زمان ثبت',
  /*
   * Payment File 02 §21 (D7): the diagnostics an operator reconciles against, on the list
   * and the detail. Read-only — card-to-card is decided in Telegram (§10).
   */
  'web.payment_id': 'شناسهٔ پرداخت',
  'web.payment_telegram': 'تلگرام مشتری',
  'web.payment_gateway': 'درگاه',
  'web.payment_external_reference': 'شناسهٔ پیگیری بیرونی',
  'web.payment_updated_at': 'آخرین تغییر',
  'web.payment_customer_fee': 'کارمزد درگاه',
  'web.payment_customer_fee_rate': 'نرخ کارمزد مشتری',
  'web.payment_customer_fee_amount': 'کارمزد درگاه',
  'web.payment_customer_fee_payable': 'مبلغ قابل پرداخت',
  'web.payment_customer_fee_hint':
    'مبلغ پرداخت بالا اصل سفارش یا شارژ است. کارمزد جداگانه ثبت شده، جزو درآمد یا شارژ کیف پول نیست و قابل بازگشت نیست.',
  'web.payment_topup_gift': 'هدیهٔ شارژ این پرداخت',
  'web.payment_topup_gift_hint':
    'درصدی که هنگام ایجاد این شارژ از درگاه آن ثبت شد. تغییر بعدی تنظیمات درگاه آن را عوض نمی‌کند.',
  'web.payment_receipt_credit': 'واریز رسید به کیف پول',
  'web.payment_disposition': 'نتیجهٔ رسید',
  'web.payment_disposition_approved': 'تأیید شد',
  'web.payment_disposition_rejected': 'رد شد',
  'web.payment_disposition_credited': 'واریز به کیف پول',
  'web.payment_receipt_credit_hint':
    'این رسید در تلگرام به‌جای تأیید یا رد، با مبلغی که مدیر وارد کرد به کیف پول مشتری واریز شد. این واریز پرداخت سفارش حساب نمی‌شود.',
  'web.payment_receipt_credit_amount': 'مبلغ واریزشده',
  'web.payment_receipt_credit_admin': 'مدیر تصمیم‌گیرنده',
  'web.payment_receipt_credit_at': 'زمان واریز',
  'web.payment_receipt_credit_note': 'یادداشت مدیر',
  /*
   * The compensation list (§21, D7): automatic wallet refunds of undeliverable orders.
   * No timeline and no action — a compensation is automatic.
   */
  'web.compensations_title': 'جبران‌های خودکار',
  'web.compensations_intro':
    'سفارش‌هایی که پول آن‌ها رسید ولی تحویلشان ممکن نشد، و مبلغی که به‌طور خودکار به کیف پول مشتری بازگشت.',
  'web.compensations_empty': 'هنوز جبرانی ثبت نشده است.',
  'web.compensation_payment': 'پرداخت',
  'web.compensation_order': 'سفارش',
  'web.compensation_customer': 'مشتری',
  'web.compensation_principal': 'مبلغ اصلی',
  'web.compensation_credited': 'واریز به کیف پول',
  'web.compensation_reason': 'دلیل',
  'web.compensation_reason_undeliverable': 'تحویل‌نشدنی',
  'web.compensation_state': 'وضعیت',
  'web.compensation_time': 'زمان',
  'web.payment_expires_at': 'اعتبار تا',
  /*
   * The customer's CLAIM, and the copy never lets it read as evidence.
   *
   * `paymentSummarySchema` puts it on the summary precisely so a pending list is
   * triageable — `docs/phase4h-audit.md` §4 measured that an operator learns of a
   * transfer from their bank rather than from the product. It is not a state: a
   * signalled payment is still PENDING and still needs a human, which is the
   * distinction the legacy receipt review does not have (`PRBR-004`).
   */
  'web.payment_customer_signalled': 'مشتری گفته پرداخت کرده',
  'web.payment_customer_signalled_none': 'مشتری چیزی نگفته است.',
  'web.payment_customer_signalled_hint':
    'این فقط گفتهٔ مشتری است، نه رسید و نه تأیید. پرداخت همچنان در انتظار بررسی شماست.',
  'web.payments_filter_customer_hint': 'شناسهٔ مشتری را کامل وارد کنید.',
  'web.payments_filter_order_hint': 'شناسهٔ سفارش را کامل وارد کنید.',
  'web.payments_filter_reference_hint': 'کد پیگیری دقیقاً همان چیزی است که مشتری می‌خواند.',
  'web.payments_filter_all': 'همه',
  'web.payments_filter_invalid_id': 'شناسه معتبر نیست.',
  'web.payments_search_apply': 'جست‌وجو',
  'web.payment_confirm_title': 'بررسی رسید',
  /*
   * Payment File 02 §10: card-to-card review is Telegram's alone. The Web Admin says
   * where the decision is taken rather than drawing a control it has no route for.
   */
  'web.payment_review_in_telegram':
    'این کارت‌به‌کارت در انتظار بررسی است. تأیید، رد یا واریز به کیف پول فقط از پنل مدیریت تلگرام انجام می‌شود و این صفحه تنها نتیجه را نمایش می‌دهد.',
  // Payment accounts — the destination an out-of-band transfer is told to go to.
  // The screen that replaces editing a message template to change a card number.
  'web.nav_payment_accounts': 'حساب‌های دریافت',
  'web.payment_accounts_title': 'حساب‌های دریافت کارت به کارت',
  'web.payment_accounts_subtitle': 'مقصدی که به مشتری برای واریز نشان داده می‌شود.',
  'web.payment_accounts_empty': 'هنوز حسابی ثبت نشده است.',
  'web.payment_accounts_empty_hint':
    'تا زمانی که حساب فعالی ثبت نشود، دکمهٔ پرداخت کارت به کارت به مشتری نشان داده نمی‌شود.',
  'web.payment_account_label': 'نام حساب',
  'web.payment_account_bank': 'بانک',
  'web.payment_account_holder': 'به نام',
  'web.payment_account_card': 'شماره کارت',
  'web.payment_account_card_hint': '۱۶ رقم. فاصله، خط تیره و ارقام فارسی نیز پذیرفته می‌شود.',
  'web.payment_account_iban': 'شبا',
  'web.payment_account_iban_hint': 'اختیاری. در صورت خالی بودن، در پیام مشتری نمایش داده نمی‌شود.',
  'web.payment_account_sort': 'ترتیب نمایش',
  'web.payment_account_state': 'وضعیت',
  'web.payment_account_enabled': 'فعال',
  'web.payment_account_disabled': 'غیرفعال',
  'web.payment_account_default': 'پیش‌فرض',
  'web.payment_account_updated': 'آخرین تغییر',
  'web.payment_account_actions': 'عملیات',
  'web.payment_account_edit': 'ویرایش',
  'web.payment_account_enable': 'فعال کردن',
  'web.payment_account_disable': 'غیرفعال کردن',
  'web.payment_account_make_default': 'پیش‌فرض کردن',
  'web.payment_account_new': 'حساب جدید',
  'web.payment_account_editing': 'ویرایش حساب',
  // Says the two things an operator cannot see from the form: an edit does not
  // reach an instruction already sent, and there is no delete.
  'web.payment_account_form_hint':
    'ویرایش یک حساب، پرداخت‌هایی که پیش‌تر صادر شده‌اند را تغییر نمی‌دهد. حساب حذف نمی‌شود؛ غیرفعال می‌شود.',
  'web.payment_account_save': 'ذخیره',
  'web.payment_account_cancel_edit': 'انصراف',
  'web.payment_account_saved': 'حساب ذخیره شد.',
  'web.payment_account_default_done': 'مقصد پرداخت‌های جدید تغییر کرد.',
  'web.payment_account_limit': 'سقف تعداد حساب‌ها پر شده است. یکی را غیرفعال کنید.',
  // Payment routes (Phase 5C) — which ways a customer may pay, and under what
  // conditions. The route is not the destination: `web.payment_accounts_*` above is
  // where the money goes, this is whether the route is offered at all.
  'web.nav_payment_gateways': 'روش‌های پرداخت',
  'web.payment_gateways_title': 'روش‌های پرداخت',
  'web.payment_gateways_subtitle':
    'روش‌هایی که به مشتری پیشنهاد می‌شود، به همان ترتیب و با همان شرط‌ها.',
  // Says the thing the screen cannot show: the roster is what the software can
  // actually operate, so there is no Add button and its absence is not a defect.
  'web.payment_gateways_hint':
    'فهرست روش‌ها ثابت است و تنها روش‌هایی را نشان می‌دهد که این نسخه می‌تواند انجام دهد. روش جدید با نسخهٔ جدید اضافه می‌شود، نه از این صفحه.',
  'web.payment_gateway_provider': 'روش',
  'web.payment_gateway_provider_manual_transfer': 'کارت به کارت',
  'web.payment_gateway_provider_tonpays': 'تون‌پیز (TonPays)',
  'web.payment_gateway_provider_telegram_stars': 'تلگرام استارز (⭐)',
  // Package A: the Stars route's operator-set rate. No FX feed exists or is implied.
  'web.payment_gateway_rate': 'نرخ هر ستاره (به کوچک‌ترین واحد ارز فروش)',
  'web.payment_gateway_rate_hint':
    'مبلغ یک ستارهٔ تلگرام به کوچک‌ترین واحد ارز فروش؛ عدد صحیح مثبت. تعداد ستارهٔ هر پرداخت = سقفِ (مبلغ قابل پرداخت ÷ این نرخ). نرخ روی هر پرداخت ثبت می‌شود و تغییر آن پرداخت‌های قبلی را تغییر نمی‌دهد. بدون نرخ، این روش فعال نمی‌شود. خالی گذاشتن نرخ را پاک می‌کند (فقط وقتی روش غیرفعال است).',
  'web.payment_gateway_rate_invalid': 'نرخ باید یک عدد صحیح مثبت باشد.',
  'web.payment_gateway_rate_column': 'نرخ ستاره',
  'web.payment_gateway_rate_missing': 'نرخ تعیین نشده',
  'web.payment_gateway_invoice': 'فاکتور درگاه',
  'web.payment_gateway_invoice_hint':
    'اطلاعات سمت درگاه برای پشتیبانی و بررسی. مبالغ درگاه فقط اطلاعات تکمیلی‌اند؛ تأیید پرداخت فقط با استعلام مستقیم (completed و paid=true) و پیش از پایان مهلت ۷۰ دقیقه‌ای انجام می‌شود.',
  'web.payment_gateway_invoice_order_id': 'شناسهٔ سفارش در درگاه',
  'web.payment_gateway_invoice_id': 'شناسهٔ فاکتور درگاه',
  'web.payment_gateway_charge_id': 'شناسهٔ پرداخت درگاه',
  'web.payment_gateway_invoice_creation': 'ساخت فاکتور',
  'web.payment_gateway_invoice_status': 'آخرین وضعیت استعلام',
  'web.payment_gateway_invoice_last_inquiry': 'آخرین استعلام',
  'web.payment_gateway_invoice_webhook': 'آخرین اعلان وب‌هوک (تعداد)',
  'web.payment_gateway_invoice_amounts': 'مبلغ ارسالی / درخواستی / نهایی / واریزی درگاه',
  'web.payment_gateway_invoice_outcome': 'نتیجه',
  'web.payment_gateway_invoice_late': 'تأیید درگاه پس از مهلت',
  'web.payment_gateway_credential': 'کلید API',
  'web.payment_gateway_credential_none': 'لازم نیست',
  'web.payment_gateway_credential_missing': 'تنظیم نشده',
  'web.payment_gateway_credential_configured': 'تنظیم شده ••••••••',
  'web.payment_gateway_credential_edit': 'تنظیم کلید API',
  'web.payment_gateway_credential_title': 'کلید API درگاه',
  'web.payment_gateway_credential_hint':
    'کلید ذخیره‌شده هرگز دوباره نمایش داده نمی‌شود. برای تغییر، کلید جدید را وارد کنید تا جایگزین کلید قبلی شود. بدون کلید، این درگاه قابل فعال‌سازی نیست.',
  'web.payment_gateway_credential_input': 'کلید API جدید',
  'web.payment_gateway_credential_save': 'ذخیرهٔ کلید',
  'web.payment_gateway_credential_saved': 'کلید API ذخیره شد.',
  'web.payment_gateway_callback_url': 'آدرس وب‌هوک (تولیدشده)',
  'web.payment_gateway_callback_url_hint':
    'این آدرس به‌صورت خودکار ساخته می‌شود و همراه هر فاکتور برای درگاه ارسال می‌شود. وب‌هوک فقط یک اعلان است؛ تأیید پرداخت همیشه با استعلام مستقیم از درگاه انجام می‌شود.',
  'web.payment_gateway_callback_url_none':
    'هنوز آدرس عمومی ربات ثبت نشده است؛ فاکتورها بدون وب‌هوک ساخته می‌شوند و وضعیت پرداخت با استعلام دوره‌ای بررسی می‌شود.',
  'web.payment_gateway_name': 'نام نمایشی',
  'web.payment_gateway_name_hint':
    'اختیاری. در صورت خالی بودن، نام پیش‌فرض همین نسخه به مشتری نشان داده می‌شود.',
  'web.payment_gateway_name_default': 'نام پیش‌فرض',
  'web.payment_gateway_state': 'وضعیت',
  'web.payment_gateway_active': 'فعال',
  'web.payment_gateway_disabled': 'غیرفعال',
  'web.payment_gateway_min': 'حداقل مبلغ',
  'web.payment_gateway_max': 'حداکثر مبلغ',
  'web.payment_gateway_amount_hint': 'مبلغ‌ها به ریال. عدد صفر یعنی بدون محدودیت.',
  'web.payment_gateway_sort': 'ترتیب نمایش',
  'web.payment_gateway_topup_gift': 'هدیهٔ شارژ (درصد)',
  'web.payment_gateway_topup_gift_hint':
    'درصدی از مبلغ هر شارژ کیف پول از این درگاه که جداگانه به‌عنوان هدیه به کیف پول مشتری واریز می‌شود؛ ۰ یعنی بدون هدیه. هر شارژ درصد زمان ایجاد خود را نگه می‌دارد، پس تغییر آن فقط بر شارژهای بعدی اثر دارد.',
  'web.payment_gateway_topup_invalid': 'درصد هدیهٔ شارژ باید عددی صحیح از ۰ تا ۱۰۰ باشد.',
  'web.payment_gateway_customer_fee': 'کارمزد مشتری (%)',
  'web.payment_gateway_customer_fee_hint':
    'درصدی از مبلغ سفارش یا شارژ که به‌عنوان کارمزد درگاه به مبلغ قابل پرداخت مشتری اضافه می‌شود؛ حداکثر دو رقم اعشار، ۰ یعنی بدون کارمزد. کارمزد جزو مبلغ سفارش یا شارژ کیف پول نیست و بازگردانده نمی‌شود. هر پرداخت کارمزد زمان ایجاد خود را نگه می‌دارد.',
  'web.payment_gateway_customer_fee_invalid':
    'کارمزد مشتری باید عددی از ۰ تا ۱۰۰ با حداکثر دو رقم اعشار باشد.',
  'web.payment_gateway_unbounded': 'بدون محدودیت',
  'web.payment_gateway_instructions': 'راهنمای مشتری',
  'web.payment_gateway_instructions_hint':
    'اختیاری. همان‌طور که نوشته می‌شود ذخیره می‌شود و به انتهای پیام پرداخت اضافه می‌شود.',
  'web.payment_gateway_eligibility': 'شرط نمایش به مشتری',
  // The three controls the research establishes, and the one it establishes is
  // ABSENT: nothing here keys off a customer's tier.
  'web.payment_gateway_eligibility_hint':
    'عدد صفر یعنی شرط غیرفعال است. این شرط‌ها فقط به سابقهٔ پرداخت و مدت عضویت خود مشتری نگاه می‌کنند.',
  'web.payment_gateway_after_payments': 'فعال پس از این تعداد پرداخت موفق',
  'web.payment_gateway_until_payments': 'غیرفعال پس از این تعداد پرداخت موفق',
  'web.payment_gateway_after_days': 'فعال پس از این تعداد روز عضویت',
  'web.payment_gateway_updated': 'آخرین تغییر',
  'web.payment_gateway_actions': 'عملیات',
  'web.payment_gateway_edit': 'ویرایش',
  'web.payment_gateway_enable': 'فعال کردن',
  'web.payment_gateway_disable': 'غیرفعال کردن',
  'web.payment_gateway_editing': 'ویرایش روش پرداخت',
  // The two things an operator cannot see from the form.
  'web.payment_gateway_form_hint':
    'تغییر شرط‌ها روی پرداخت‌هایی که پیش‌تر صادر شده‌اند اثری ندارد. روش پرداخت حذف نمی‌شود؛ غیرفعال می‌شود.',
  'web.payment_gateway_save': 'ذخیره',
  'web.payment_gateway_cancel_edit': 'انصراف',
  'web.payment_gateway_saved': 'روش پرداخت ذخیره شد.',
  'web.payment_gateway_amount_invalid':
    'حداقل و حداکثر مبلغ باید عددی صحیح باشند. علامت، نقطهٔ اعشار یا حروف پذیرفته نمی‌شود.',
  'web.payment_gateway_status_done': 'وضعیت روش پرداخت تغییر کرد.',
  /*
   * Per-purpose switches on a route (customer UX completion §D/§F). Two, because an
   * operator may take card-to-card for a top-up and not for a purchase, or the
   * reverse; one switch for both is a route that is on for something it was never
   * meant for.
   */
  'web.gateway_allow_column': 'کاربرد',
  'web.gateway_allow_service_purchase': 'خرید سرویس',
  'web.gateway_allow_wallet_topup': 'شارژ کیف پول',
  'web.gateway_allow_hint':
    'این روش برای کدام کارها به مشتری پیشنهاد شود. روشِ فعال با هر دو گزینهٔ خاموش به هیچ مشتری‌ای پیشنهاد نمی‌شود.',
  'web.gateway_allow_none': 'برای هیچ کاری',
  'web.payment_gateways_empty': 'هنوز روش پرداختی ثبت نشده است.',
  'web.payment_gateways_empty_hint':
    'در نصب سالم این فهرست خالی نمی‌ماند. اگر خالی است، سرویس را یک بار راه‌اندازی مجدد کنید تا روش‌های این نسخه ساخته شوند.',
  // Support (customer UX completion §J) — the FAQ the bot answers with, and a
  // pointer at the settings page, where the support DESTINATION already lives.
  'web.nav_support': 'پشتیبانی',
  'web.support_title': 'پشتیبانی',
  'web.support_subtitle':
    'سوالات متداولی که ربات به مشتری نشان می‌دهد، به همان ترتیب، و راه ارتباط با پشتیبانی.',
  'web.support_faq_hint':
    'فقط پرسش‌های فعال به مشتری نشان داده می‌شوند، به ترتیب عدد «ترتیب». بار اول نه پرسش پیش‌فرض ساخته می‌شود؛ از آن پس فهرست مال شماست و خودبه‌خود پر نمی‌شود.',
  'web.support_destination_title': 'راه ارتباط با پشتیبانی',
  'web.support_destination_note':
    'دکمهٔ «ارسال پیام به پشتیبانی» به نخستین حساب فهرست «حساب‌های پشتیبانی» می‌رود. آن فهرست در صفحهٔ تنظیمات ویرایش می‌شود، نه این‌جا؛ اگر خالی باشد به مشتری گفته می‌شود راه ارتباطی تنظیم نشده است.',
  'web.support_destination_link': 'رفتن به تنظیمات',
  'web.support_faq_order': 'ترتیب',
  'web.support_faq_question': 'پرسش',
  'web.support_faq_answer': 'پاسخ',
  'web.support_faq_status': 'وضعیت',
  'web.support_faq_active': 'فعال',
  'web.support_faq_inactive': 'غیرفعال',
  'web.support_faq_updated': 'آخرین تغییر',
  'web.support_faq_actions': 'عملیات',
  'web.support_faq_edit': 'ویرایش',
  'web.support_faq_activate': 'فعال کردن',
  'web.support_faq_deactivate': 'غیرفعال کردن',
  'web.support_faq_new': 'افزودن پرسش',
  'web.support_faq_creating': 'پرسش تازه',
  'web.support_faq_editing': 'ویرایش پرسش',
  'web.support_faq_form_hint':
    'پرسش تا ۳۰۰ و پاسخ تا ۲۰۰۰ نویسه. متن همان‌طور که نوشته می‌شود به مشتری نشان داده می‌شود.',
  'web.support_faq_sort_hint': 'عدد کوچک‌تر بالاتر نشان داده می‌شود. پیش‌فرض‌ها ۱۰ تا ۹۰ هستند.',
  'web.support_faq_sort_invalid': 'ترتیب باید عددی صحیح از ۰ تا ۱۰۰٬۰۰۰ باشد.',
  'web.support_faq_text_required': 'پرسش و پاسخ هر دو لازم‌اند.',
  'web.support_faq_save': 'ذخیره',
  'web.support_faq_cancel': 'انصراف',
  'web.support_faq_saved': 'پرسش ذخیره شد.',
  'web.support_faq_status_done': 'وضعیت پرسش تغییر کرد.',
  'web.support_faq_conflict':
    'این پرسش پس از خواندن شما تغییر کرده است. نسخهٔ تازه را بگیرید و تغییر خود را دوباره اعمال کنید.',
  'web.support_faq_limit': 'سقف تعداد پرسش‌ها پر شده است. یکی را غیرفعال یا ویرایش کنید.',
  'web.support_faq_empty': 'هنوز پرسشی ثبت نشده است.',
  'web.support_faq_empty_hint': 'با «افزودن پرسش» نخستین پرسش را بسازید.',
  // WP-A10: apps and connection guides.
  'web.nav_client_apps': 'برنامه‌ها و آموزش اتصال',
  'web.client_apps_title': 'برنامه‌ها و آموزش اتصال',
  'web.client_apps_subtitle':
    'برنامه‌هایی که ربات در بخش «📱 دانلود برنامه و آموزش اتصال» به مشتری پیشنهاد می‌دهد، با لینک دانلود و آموزش هر کدام. هر تغییر از همان لحظه در ربات دیده می‌شود.',
  'web.client_apps_hint':
    'مشتری فقط برنامه‌های فعال را می‌بیند، به ترتیب عدد ترتیب، و اگر سرویسی دارد فقط برنامه‌هایی که با سرویسش سازگارند. سیستم عاملی که برنامه‌ای ندارد همان آموزش کلی خودش را نشان می‌دهد.',
  'web.client_apps_empty': 'هنوز برنامه‌ای ثبت نشده است.',
  'web.client_apps_empty_hint':
    'هیچ لینک پیش‌فرضی همراه نصب نیست. با «افزودن برنامه» برنامه‌هایی را که خودتان پیشنهاد می‌کنید ثبت کنید؛ تا آن زمان ربات آموزش کلی هر سیستم عامل را نشان می‌دهد.',
  'web.client_apps_new': 'افزودن برنامه',
  'web.client_apps_creating': 'برنامهٔ تازه',
  'web.client_apps_editing': 'ویرایش برنامه',
  'web.client_apps_form_hint':
    'لینک‌ها باید با https:// شروع شوند و به یک نام دامنه اشاره کنند. HTML و لینک‌های javascript: یا data: پذیرفته نمی‌شوند.',
  'web.client_apps_platform': 'سیستم عامل',
  'web.client_apps_platform_android': 'اندروید',
  'web.client_apps_platform_ios': 'آیفون (iOS)',
  'web.client_apps_platform_windows': 'ویندوز',
  'web.client_apps_platform_macos': 'مک',
  'web.client_apps_platform_linux': 'لینوکس',
  'web.client_apps_platform_other': 'سایر',
  'web.client_apps_name': 'نام برنامه',
  'web.client_apps_icon': 'نماد',
  'web.client_apps_icon_hint':
    'اختیاری؛ یک ایموجی یا نشانهٔ کوتاه که پیش از نام نمایش داده می‌شود.',
  'web.client_apps_icon_invalid': 'نماد باید کوتاه و بدون فاصله باشد.',
  'web.client_apps_description': 'توضیح کوتاه',
  'web.client_apps_official_url': 'لینک دانلود رسمی',
  'web.client_apps_url_hint': 'مثلاً نشانی صفحهٔ دانلود سازندهٔ برنامه، با https://',
  'web.client_apps_alternative_url': 'لینک فروشگاه یا لینک جایگزین',
  'web.client_apps_help_url': 'لینک ویدیو یا راهنمای بیشتر',
  'web.client_apps_optional': 'اختیاری.',
  'web.client_apps_url_invalid':
    'لینک معتبر نیست. فقط https:// با نام دامنه پذیرفته می‌شود (بدون نشانی IP، فاصله یا نام کاربری در لینک).',
  'web.client_apps_guide': 'آموزش اتصال',
  'web.client_apps_guide_hint':
    'متن ساده. خطی که با - شروع شود فهرست می‌شود، خطی که با عدد و نقطه شروع شود یک مرحله است، و [متن](https://…) یک پیوند. خط خالی پاراگراف‌ها را جدا می‌کند.',
  'web.client_apps_delivery': 'نوع تحویل سرویس',
  'web.client_apps_compat_hint':
    'برای نمایش به همه چیزی را انتخاب نکنید. اگر انتخاب کنید، به مشتری‌ای که سرویسش با هیچ‌کدام سازگار نیست نشان داده نمی‌شود.',
  'web.client_apps_delivery_link': 'لینک اشتراک',
  'web.client_apps_delivery_files': 'فایل‌های اتصال',
  'web.client_apps_protocols': 'پروتکل‌ها',
  'web.client_apps_providers': 'نوع پنل',
  'web.client_apps_compat': 'سازگاری',
  'web.client_apps_compat_any': 'همه',
  'web.client_apps_order': 'ترتیب',
  'web.client_apps_sort_hint': 'عدد کوچک‌تر بالاتر نشان داده می‌شود.',
  'web.client_apps_sort_invalid': 'ترتیب باید عددی صحیح از ۰ تا ۱۰۰٬۰۰۰ باشد.',
  'web.client_apps_status': 'وضعیت',
  'web.client_apps_enabled': 'فعال',
  'web.client_apps_disabled': 'غیرفعال',
  'web.client_apps_updated': 'آخرین تغییر',
  'web.client_apps_actions': 'عملیات',
  'web.client_apps_edit': 'ویرایش',
  'web.client_apps_enable': 'فعال کردن',
  'web.client_apps_disable': 'غیرفعال کردن',
  'web.client_apps_delete': 'حذف',
  'web.client_apps_delete_confirm':
    'این برنامه برای همیشه حذف می‌شود و دیگر به مشتری نشان داده نمی‌شود. ادامه می‌دهید؟',
  'web.client_apps_preview': 'پیش‌نمایش در ربات',
  'web.client_apps_preview_hint':
    'پیام همان‌طور که مشتری می‌بیند، با متن پیش‌فرض ربات. دکمه‌ها زیر پیام نمایش داده می‌شوند.',
  'web.client_apps_save': 'ذخیره',
  'web.client_apps_cancel': 'انصراف',
  'web.client_apps_saved': 'برنامه ذخیره شد.',
  'web.client_apps_status_done': 'وضعیت برنامه تغییر کرد.',
  'web.client_apps_deleted': 'برنامه حذف شد.',
  'web.client_apps_required': 'این بخش لازم است.',
  'web.client_apps_one_line': 'باید در یک خط باشد.',
  'web.client_apps_problem_control': 'نویسه‌های کنترلی پذیرفته نمی‌شوند.',
  'web.client_apps_problem_markup': 'HTML پذیرفته نمی‌شود؛ متن ساده بنویسید.',
  'web.client_apps_problem_scheme':
    'لینک‌های javascript:، data:، vbscript: و file: پذیرفته نمی‌شوند.',
  'web.client_apps_problem_link':
    'هر لینک، چه به‌صورت [متن](لینک) و چه خود نشانی، باید با https:// و نام دامنه باشد؛ لینک http:// یا www. بدون https:// پذیرفته نمی‌شود.',
  'web.client_apps_conflict':
    'این برنامه از زمانی که باز کردید تغییر کرده است. نسخهٔ تازه را بارگذاری کنید و تغییر را دوباره اعمال کنید.',
  'web.client_apps_limit': 'سقف تعداد برنامه‌ها پر شده است. یکی را حذف کنید.',
  // HF-A10 — an entry's optional picture.
  'web.client_apps_image_title': 'تصویر برنامه',
  'web.client_apps_image_hint':
    'اختیاری. ربات این تصویر را پیش از صفحهٔ برنامه می‌فرستد. اگر تصویری نباشد یا تلگرام آن را نپذیرد، همان صفحهٔ متنی با نماد (ایموجی) فرستاده می‌شود. دکمه‌های فهرست برنامه‌ها همیشه فقط نماد و نام را نشان می‌دهند.',
  'web.client_apps_image_none': 'تصویری تنظیم نشده است؛ ربات نماد و متن را نشان می‌دهد.',
  'web.client_apps_image_save_first': 'برای افزودن تصویر، ابتدا برنامه را ذخیره کنید.',
  'web.client_apps_image_file': 'فایل تصویر',
  'web.client_apps_image_file_hint':
    'PNG یا JPEG، حداکثر ۵۱۲ کیلوبایت، هر ضلع بین ۱۶ تا ۲۰۴۸ پیکسل. SVG پذیرفته نمی‌شود.',
  'web.client_apps_image_upload': 'بارگذاری تصویر',
  'web.client_apps_image_uploading': 'در حال بارگذاری…',
  'web.client_apps_image_clear': 'حذف تصویر',
  'web.client_apps_image_uploaded': 'تصویر برنامه ذخیره شد.',
  'web.client_apps_image_cleared': 'تصویر برنامه حذف شد.',
  'web.client_apps_image_alt': 'تصویر ذخیره‌شدهٔ برنامه',
  'web.client_apps_image_picked_alt': 'پیش‌نمایش فایل انتخاب‌شده',
  'web.client_apps_image_type': 'نوع فایل',
  'web.client_apps_image_size': 'اندازه',
  'web.client_apps_image_dimensions': 'ابعاد (پیکسل)',
  'web.client_apps_image_invalid_type': 'فقط فایل PNG یا JPEG پذیرفته می‌شود.',
  'web.client_apps_image_empty': 'فایل خالی است.',
  'web.client_apps_image_too_large': 'اندازهٔ فایل بیش از ۵۱۲ کیلوبایت است.',
  'web.client_apps_image_mismatch': 'محتوای فایل با نوع اعلام‌شده‌اش هم‌خوانی ندارد.',
  'web.client_apps_image_unreadable': 'ابعاد تصویر خوانده نشد؛ فایل ناقص یا خراب است.',
  'web.client_apps_image_bad_dimensions':
    'هر ضلع تصویر باید بین ۱۶ تا ۲۰۴۸ پیکسل باشد و ضلع بلندتر بیش از ۲۰ برابر ضلع کوتاه‌تر نباشد.',
  'web.payment_resolution': 'نتیجهٔ بدون دریافت وجه',
  'web.payment_destination': 'مقصد واریز اعلام‌شده',
  'web.payment_destination_label': 'عنوان حساب',
  'web.payment_destination_bank': 'بانک',
  'web.payment_destination_holder': 'به نام',
  'web.payment_destination_card': 'چهار رقم آخر کارت',
  'web.payment_destination_sheba': 'شبا',
  'web.payment_destination_sheba_given': 'به مشتری اعلام شد',
  'web.payment_destination_sheba_absent': 'اعلام نشد',
  'web.payment_destination_account': 'شناسهٔ حساب',
  /*
   * The receipt card. A receipt is EVIDENCE, and the wording keeps it that way: it
   * arrived, an operator reads it, and only «تأیید پرداخت» below decides anything.
   */
  'web.payment_receipts': 'رسیدهای ارسالی مشتری',
  'web.payment_receipts_empty': 'مشتری رسیدی ارسال نکرده است.',
  'web.payment_receipts_note':
    'رسید، ادعای مشتری است و به‌تنهایی پرداخت را تأیید نمی‌کند. تأیید نهایی با اپراتور است.',
  'web.payment_receipt_kind': 'نوع',
  'web.payment_receipt_kind_photo': 'تصویر',
  'web.payment_receipt_kind_document': 'فایل',
  'web.payment_receipt_file': 'نام فایل',
  'web.payment_receipt_size': 'حجم',
  'web.payment_receipt_sent_at': 'زمان ارسال',
  'web.payment_receipt_view': 'مشاهدهٔ رسید',
  'web.payment_receipt_download': 'دریافت فایل رسید',
  'web.payment_receipt_save': 'ذخیرهٔ فایل',
  'web.payment_receipt_alt': 'تصویر رسید ارسالی مشتری',
  'web.payment_receipt_failed': 'رسید در دسترس نیست',
  /*
   * The causes, in the order they actually happen. The stopped bot is first because it
   * is the one an operator can fix: the file is fetched with the token of the bot that
   * received it, and a stopped bot has no usable token — for which «try again» is not a
   * remedy.
   */
  'web.payment_receipt_failed_hint':
    'دریافت فایل از تلگرام ناموفق بود. اگر رباتِ دریافت‌کنندهٔ این رسید متوقف شده است، ابتدا آن را فعال کنید. در غیر این صورت ممکن است فایل حذف شده باشد یا تلگرام موقتاً پاسخ نداده باشد؛ دوباره تلاش کنید.',
  'web.payment_resolved_at': 'زمان بسته شدن',
  'web.payment_resolver': 'بسته‌شده توسط',
  'web.payment_resolution_note': 'دلیل',
  /*
   * `UNKNOWN` is an ABSENCE of an outcome, not an outcome. `payment.ts` makes it
   * non-terminal for that reason, and this copy says what an operator must do
   * rather than inviting them to guess.
   */
  'web.payment_unknown_banner':
    'نتیجهٔ این پرداخت مشخص نیست. تا زمانی که با سوابق طرف مقابل تطبیق داده نشود، نه موفق است و نه ناموفق.',
  // --- Refunds (Phase 5E) --------------------------------------------------
  /*
   * A refund is money going BACK, and the copy never says it has gone back until an
   * operator has said so. `AWAITING_EXTERNAL` is the state that carries that
   * distinction and its wording is the whole point of the lifecycle.
   */
  'web.refunds': 'بازگشت وجه',
  'web.refunds_empty': 'برای این پرداخت بازگشت وجهی ثبت نشده است.',
  'web.refund_paid': 'مبلغ پرداخت‌شده',
  'web.refund_consumed': 'مجموع بازگشت‌های ثبت‌شده',
  'web.refund_remaining': 'باقی‌ماندهٔ قابل بازگشت',
  /*
   * «به‌هیچ‌وجه قابل بازگشت نیست» is a different sentence from «باقی‌مانده صفر است»,
   * and the two must not be merged: the first is a payment that never نشست or a
   * روش that has no channel in this release.
   */
  'web.refund_unavailable':
    'در حال حاضر این پرداخت قابل بازگشت نیست. یا هنوز تأیید نشده است، یا روش پرداخت آن در این نسخه مسیر بازگشتی ندارد، یا مبلغ آن پیش‌تر به کیف پول مشتری رفته است، یا ساخت سرویس سفارش آن هنوز به نتیجهٔ قطعی نرسیده است. مورد آخر با پایان ساخت خودبه‌خود برطرف می‌شود.',
  /*
   * WP10 P3, said when the SERVER named it. A refund of an order payment is refused
   * while the order's purchase is planned, in flight or UNKNOWN: money given back for
   * an account the customer may be holding is the ambiguity the money rules forbid.
   * The one refusal that clears on its own, and the copy says so.
   */
  'web.refund_delivery_in_progress':
    'تا وقتی ساخت سرویس این سفارش به نتیجهٔ قطعی نرسیده، بازگشت وجه ممکن نیست؛ ممکن است سرویس برای مشتری ساخته شده باشد. اگر ساخت ناموفق شود، مبلغ به‌طور خودکار بازگردانده می‌شود. پس از پایان ساخت دوباره تلاش کنید.',
  /*
   * WP10 P3, after the order's refunds reached its full amount. The two claims are the
   * two the data supports: the ORDER says REFUNDED (read from the order, never inferred
   * from the rows here), and a refund never acts on a service — suspending or
   * terminating one is the operator's own, explicit service action.
   */
  'web.refund_order_refunded_title': 'سفارش این پرداخت بازگشت خورده است',
  'web.refund_order_refunded_body':
    'بازگشت وجه هیچ سرویسی را تعلیق یا حذف نمی‌کند. اگر این سفارش سرویسی ساخته باشد، آن سرویس به همان حال قبلی مانده است؛ برای تعلیق یا حذف آن از اقدام‌های صفحهٔ سرویس استفاده کنید.',
  'web.refund_order_link': 'مشاهدهٔ سفارش و سرویس آن',
  'web.refund_amount': 'مبلغ',
  'web.refund_state': 'وضعیت',
  'web.refund_state_requested': 'ثبت‌شده',
  'web.refund_state_awaiting': 'در انتظار واریز بیرونی',
  'web.refund_state_completed': 'بازگشت انجام شد',
  'web.refund_state_failed': 'منصرف‌شده',
  'web.refund_channel': 'مسیر بازگشت',
  'web.refund_channel_wallet': 'اعتبار کیف پول',
  'web.refund_channel_manual': 'واریز دستی بیرون از سامانه',
  'web.refund_channel_provider': 'درگاه پرداخت',
  // WP17 — the payment's history, read-only.
  'web.payment_timeline': 'تاریخچهٔ پرداخت',
  'web.payment_timeline_hint':
    'رویدادهایی که پیش‌تر برای این پرداخت ثبت شده‌اند، به ترتیب زمان. این کارت فقط نمایش است و چیزی را تغییر نمی‌دهد.',
  'web.payment_timeline_at': 'زمان',
  'web.payment_timeline_event': 'رویداد',
  'web.payment_timeline_detail': 'جزئیات',
  'web.payment_timeline_empty': 'رویدادی ثبت نشده است.',
  'web.payment_timeline_withheld': 'بخش‌هایی که مجوز دیدنشان را ندارید در این تاریخچه نیامده‌اند:',
  'web.payment_timeline_withheld_receipts': 'رسیدها',
  'web.payment_timeline_withheld_refunds': 'بازپرداخت‌ها',
  'web.payment_timeline_withheld_wallet': 'تراکنش‌های کیف پول',
  'web.payment_timeline_truncated':
    'این تاریخچه طولانی‌تر از حد نمایش است؛ فقط قدیمی‌ترین رویدادها نشان داده شده‌اند.',
  'web.payment_timeline_by_system': 'سامانه',
  'web.payment_timeline_by_customer': 'مشتری',
  'web.payment_timeline_created': 'پرداخت ایجاد شد',
  'web.payment_timeline_signalled': 'مشتری اعلام کرد واریز کرده است',
  'web.payment_timeline_receipt': 'رسید ارسال شد',
  'web.payment_timeline_confirmed': 'پرداخت تأیید شد',
  /*
   * "Closed without being settled", never "without receiving money": a receipt credited to
   * the wallet closes the payment FAILED while the money it carried is credited, and the
   * row right below says so (Codex review of #81).
   */
  'web.payment_timeline_resolved': 'پرداخت بدون تسویه بسته شد',
  'web.payment_timeline_receipt_credited': 'مبلغ رسید به کیف پول واریز شد',
  'web.payment_timeline_wallet_entry': 'تراکنش کیف پول',
  'web.payment_timeline_refund_requested': 'بازپرداخت ثبت شد',
  'web.payment_timeline_refund_completed': 'بازپرداخت انجام شد',
  'web.payment_timeline_refund_failed': 'بازپرداخت کنار گذاشته شد',
  'web.payment_timeline_notified': 'پیام برای مشتری صف شد',
  'web.payment_timeline_delivery_pending': 'در انتظار ارسال',
  'web.payment_timeline_delivery_delivered': 'تحویل شد',
  'web.payment_timeline_delivery_unconfirmed': 'نتیجهٔ ارسال نامعلوم',
  'web.payment_timeline_delivery_failed': 'ارسال نشد',
  'web.payment_timeline_delivery_superseded': 'جایگزین شد',
  'web.refund_reason': 'دلیل',
  'web.refund_requested_by': 'ثبت‌شده توسط',
  'web.refund_completed_by': 'تأیید واریز توسط',
  'web.refund_awaiting_hint': 'هنوز کسی واریز را تأیید نکرده است.',
  'web.refund_created_at': 'زمان ثبت',
  'web.refund_completed_at': 'زمان واریز',
  'web.refund_external_reference': 'شمارهٔ پیگیری واریز',
  /*
   * WP19 — customers' service refund requests. The Web Admin is the durable fallback for
   * the Telegram review card (brief §2.10): the same two decisions, the same rules.
   */
  'web.service_refunds': 'درخواست‌های بازگشت وجه',
  'web.service_refunds_hint':
    'درخواست‌هایی که کاربران برای لغو سرویس و بازگشت وجه ثبت کرده‌اند. با تأیید، سرویس حذف و پس از حذف موفق مبلغ تأییدشده به کیف پول کاربر واریز می‌شود؛ کارمزد درگاه قابل بازگشت نیست.',
  'web.service_refunds_open': 'درخواست‌های بازگشت وجهِ نیازمند رسیدگی',
  'web.service_refunds_empty': 'درخواستی وجود ندارد.',
  'web.service_refund_state_open': 'در انتظار بررسی',
  'web.service_refund_state_executing': 'در حال حذف سرویس',
  'web.service_refund_state_completed': 'انجام‌شده',
  'web.service_refund_state_rejected': 'ردشده',
  'web.service_refund_state_failed': 'ناموفق',
  'web.service_refund_service': 'سرویس',
  'web.service_refund_customer': 'کاربر',
  'web.service_refund_reason': 'دلیل کاربر',
  'web.service_refund_principal': 'مبلغ خرید',
  'web.service_refund_remaining': 'باقی‌ماندهٔ قابل بازگشت',
  'web.service_refund_approved': 'مبلغ تأییدشده',
  'web.service_refund_operation': 'وضعیت حذف',
  'web.service_refund_created': 'زمان ثبت',
  'web.service_refund_outcome': 'نتیجه',
  'web.service_refund_amount': 'مبلغ بازگشت (به کوچک‌ترین یکای پول)',
  'web.service_refund_confirm':
    'تأیید می‌کنم که سرویس حذف می‌شود و مبلغ فقط پس از حذف موفق به کیف پول کاربر واریز خواهد شد؛ کارمزد درگاه قابل بازگشت نیست.',
  'web.service_refund_approve': 'تأیید و حذف سرویس',
  'web.service_refund_reject_reason': 'دلیل رد (برای کاربر ارسال می‌شود)',
  'web.service_refund_reject': 'رد درخواست',
  'web.service_refund_approved_toast': 'درخواست تأیید شد و حذف سرویس آغاز شد.',
  'web.service_refund_completed_toast':
    'این درخواست پیش‌تر انجام شده است: سرویس حذف و مبلغ به کیف پول کاربر واریز شد.',
  'web.service_refund_failed_toast':
    'حذف سرویس ناموفق بود و مبلغی بازگردانده نشد. وضعیت درخواست را بررسی کنید.',
  'web.service_refund_rejected_toast': 'درخواست رد شد.',
  'web.service_refund_denied':
    'تصمیم دربارهٔ این درخواست به هر دو دسترسی «ثبت بازگشت وجه» و «حذف سرویس» نیاز دارد.',
  'web.refund_request_title': 'ثبت بازگشت وجه',
  /*
   * Says the two facts an operator needs before pressing it: the bound is the
   * server's, and a wallet refund is immediate while a دستی one is not.
   */
  'web.refund_request_hint':
    'مبلغ در سرور و بر پایهٔ همین پرداخت محدود می‌شود؛ رقم این فرم پیشنهاد است. بازگشت به کیف پول در همین لحظه ثبت و اعتبار افزوده می‌شود، اما بازگشت واریز دستی تا زمانی که اپراتور واریز را تأیید نکند «انجام‌شده» به حساب نمی‌آید.',
  'web.refund_amount_minor': 'مبلغ (به کوچک‌ترین یکای پول)',
  'web.refund_amount_all': 'کل باقی‌ماندهٔ قابل بازگشت',
  'web.refund_request': 'ثبت درخواست',
  'web.refund_requested': 'بازگشت وجه ثبت شد.',
  'web.refund_denied': 'ثبت بازگشت وجه به دسترسی «refunds.issue» نیاز دارد.',
  'web.refund_answer_title': 'پاسخ به بازگشت‌های در انتظار واریز',
  'web.refund_answer_hint':
    'این سامانه نمی‌تواند خودکار به حساب بانکی مشتری واریز کند. پس از انجام واریز، آن را همین‌جا تأیید کنید. اگر واریزی انجام نشد و نخواهد شد، «منصرف شدم» مبلغ را به باقی‌ماندهٔ قابل بازگشت برمی‌گرداند و سابقهٔ آن پاک نمی‌شود.',
  'web.refund_answer_which': 'کدام بازگشت',
  'web.refund_answer_none': 'انتخاب نشده',
  'web.refund_answer_note': 'توضیح',
  'web.refund_complete': 'واریز انجام شد',
  'web.refund_completed': 'واریز بازگشت وجه تأیید شد.',
  'web.refund_abandon': 'منصرف شدم',
  'web.refund_failed_done': 'بازگشت وجه منصرف شد و مبلغ آن آزاد شد.',

  /*
   * REWRITTEN. It said "service creation or delivery does not happen in this
   * version", which stopped being true at Phase 4D and was still on the screen
   * when order `01a0c54b` was refunded. Stale scope copy is worse than no copy:
   * an operator reading it concludes the missing service is expected.
   */
  'web.payment_not_settled_here':
    'این صفحه فقط وضعیت مالی را نشان می‌دهد. وضعیت ساخت و تحویل سرویس در صفحهٔ سفارش و صفحهٔ سرویس‌ها دیده می‌شود.',

  // --- Products (Phase 4B) -------------------------------------------------
  'web.products_title': 'محصولات',

  // --- Product categories ---------------------------------------------------
  'web.nav_product_categories': 'دسته‌بندی‌ها',
  'web.nav_extra_devices': 'افزایش کاربر / دستگاه',
  'web.nav_service_locations': 'تغییر لوکیشن',
  'web.categories_title': 'دسته‌بندی محصولات',
  'web.categories_subtitle': 'هر محصول فروختنی دقیقاً در یک دسته قرار می‌گیرد.',
  'web.categories_empty': 'هنوز دسته‌ای ساخته نشده است',
  'web.categories_empty_hint': 'برای اینکه محصولی قابل فروش شود، دست‌کم یک دسته لازم است.',
  'web.category_name': 'نام',
  'web.category_description': 'توضیح',
  'web.category_emoji': 'ایموجی',
  'web.category_emoji_hint': 'اختیاری. نبودِ آن کاملاً عادی است.',
  'web.category_sort': 'ترتیب',
  'web.category_products': 'تعداد محصول',
  'web.category_status': 'وضعیت فروش',
  'web.category_visibility': 'نمایش در فهرست',
  'web.category_active': 'فعال',
  'web.category_inactive': 'غیرفعال',
  'web.category_visible': 'نمایش داده می‌شود',
  'web.category_hidden': 'پنهان',
  'web.category_actions': 'اقدام‌ها',
  'web.category_edit': 'ویرایش',
  'web.category_activate': 'فعال‌سازی',
  'web.category_deactivate': 'غیرفعال‌سازی',
  'web.category_show': 'نمایش در فهرست',
  'web.category_hide': 'پنهان کردن',
  'web.category_move_up': 'بالاتر',
  'web.category_move_down': 'پایین‌تر',
  'web.category_delete': 'حذف',
  'web.category_delete_confirm': 'این دسته حذف شود؟ این کار برگشت‌پذیر نیست.',
  'web.category_deleted': 'دسته حذف شد',
  'web.category_new': 'دسته تازه',
  'web.category_editing': 'ویرایش دسته',
  'web.category_form_hint':
    'وضعیت فروش و نمایش از دکمه‌های همان ردیف تغییر می‌کنند، نه از این فرم.',
  'web.category_save': 'ذخیره',
  'web.category_cancel_edit': 'انصراف',
  'web.category_saved': 'ذخیره شد',
  'web.category_reordered': 'ترتیب تازه ذخیره شد',
  'web.category_inactive_note': 'دستهٔ غیرفعال برای خرید تازه در دسترس نیست — حتی با پیوند مستقیم.',
  'web.category_hidden_note':
    'دستهٔ پنهان در فهرست دیده نمی‌شود، اما محصول آن با پیوند مستقیم همچنان قابل خرید است.',
  'web.category_filter_all': 'همه',
  'web.category_filter_none': 'بدون دسته',
  'web.product_category': 'دسته',
  'web.product_category_unset': 'بدون دسته',
  'web.product_category_hint':
    'دسته‌ای که مشتری این محصول را زیر آن می‌بیند. محصول بدون دسته فروخته نمی‌شود.',
  'web.product_category_unreadable':
    'فهرست دسته‌ها خوانده نشد؛ شناسهٔ دسته را وارد کنید یا خالی بگذارید.',
  'web.product_category_assign': 'انتقال به دسته',
  'web.product_category_assign_hint':
    'انتقال، ویرایشِ مشخصات محصول نیست؛ ردیف جداگانه‌ای در گزارش اقدام‌ها ثبت می‌کند.',
  'web.product_category_assigned': 'محصول به دستهٔ تازه منتقل شد',
  'web.order_category': 'دستهٔ خرید',
  'web.order_category_unknown': 'ثبت نشده',

  'web.products_intro': 'سرویس‌هایی که مشتری می‌تواند بخرد، و آنهایی که هنوز نمی‌تواند.',
  'web.products_empty': 'هنوز محصولی تعریف نشده است.',
  'web.products_empty_hint': 'با فرم پایین همین صفحه اولین محصول را بسازید.',
  'web.products_search_title': 'عنوان محصول',
  'web.products_search_title_hint': 'ابتدای عنوان کافی است.',
  'web.products_search_empty': 'محصولی با این عنوان پیدا نشد.',
  'web.products_search_empty_hint': 'عبارت را کوتاه‌تر کنید یا جست‌وجو را پاک کنید.',
  'web.product_title': 'عنوان',
  'web.product_description': 'توضیح',
  'web.product_description_hint':
    'در پیام خلاصهٔ سفارش به مشتری نشان داده نمی‌شود؛ برای خود شماست.',
  'web.product_detail': 'جزئیات محصول',
  'web.product_identity_title': 'مشخصات محصول',
  'web.product_status_active': 'فعال',
  'web.product_status_inactive': 'غیرفعال',
  'web.product_audience': 'مخاطب',
  'web.product_audience_all': 'همهٔ مخاطب‌ها',
  'web.product_audience_everyone': 'همه',
  'web.product_audience_resellers': 'فقط نمایندگان',
  'web.product_audience_hidden': 'پنهان',
  'web.product_audience_hint':
    'پنهان یعنی در فهرست ربات نمایش داده نمی‌شود، ولی اگر کسی نشانی آن را داشته باشد می‌تواند سفارش دهد.',
  'web.product_price': 'قیمت',
  'web.product_price_hint':
    'به کوچک‌ترین واحد پول. خالی بگذارید تا محصول فروخته نشود؛ قیمت صفر معنایی ندارد.',
  'web.product_currency': 'واحد پول',
  'web.product_duration': 'مدت',
  'web.product_duration_hint': 'به روز. صفر یعنی بدون محدودیت زمانی.',
  'web.product_days_unit': 'روز',
  'web.product_traffic': 'حجم',
  'web.product_traffic_gb': 'حجم (گیگابایت)',
  'web.product_traffic_hint': 'به گیگابایت، حداکثر با دو رقم اعشار؛ مثلاً 10.25',
  'web.product_traffic_unlimited': 'بدون محدودیت حجم',
  'web.product_unlimited': 'نامحدود',
  'web.product_device_limit': 'سقف دستگاه',
  'web.product_device_limit_hint':
    'خالی یعنی هر چه پنل به‌صورت پیش‌فرض می‌دهد. صفر یک سقف واقعی نیست و پذیرفته نمی‌شود.',
  'web.product_devices_provider_default': 'پیش‌فرض پنل',
  'web.product_sort_order': 'ترتیب',
  'web.product_sort_hint': 'عدد کوچک‌تر بالاتر دیده می‌شود.',
  'web.product_panel': 'پنل',
  'web.product_panel_hint': 'سرویسِ خریداری‌شده روی این پنل ساخته خواهد شد.',
  'web.product_panel_none': 'بدون پنل',
  'web.product_panel_denied':
    'فهرست پنل‌ها برای شما قابل خواندن نیست (دسترسی panels.view)؛ شناسهٔ پنل را دستی وارد کنید.',
  'web.product_created_at': 'ساخته‌شده در',

  /*
   * The catalogue badge, which is the reason this page exists in this shape.
   *
   * An operator otherwise publishes a plan, sees it in their own list, and finds out it
   * was invisible to customers when nobody buys it. Four separate sentences rather than
   * one "not visible", because each names a different thing to go and fix.
   */
  'web.product_catalogue': 'در فهرست ربات',
  'web.product_in_catalogue': 'نمایش داده می‌شود',
  'web.product_panel_too_many':
    'پنل‌ها بیش از آن است که در یک فهرست بیاید؛ شناسهٔ پنل را از صفحهٔ پنل‌ها بردارید و اینجا بگذارید.',
  'web.product_currency_hint':
    'باید همان واحد پولی باشد که در تنظیمات برای فروشگاه انتخاب شده است؛ در غیر این صورت ذخیره نمی‌شود.',
  'web.product_gap_banner_title': 'این محصول در فهرست ربات نیست',
  'web.product_gap_inactive': 'غیرفعال است؛ تا فعال نشود فروخته نمی‌شود.',
  'web.product_gap_unlisted': 'مخاطب آن پنهان است؛ فروخته می‌شود ولی در فهرست نمی‌آید.',
  'web.product_gap_resellers':
    'مخاطب آن فقط نمایندگان است؛ مشتری عادی آن را نه در فهرست می‌بیند و نه می‌تواند سفارش دهد. فقط نماینده‌ای که سطحش این محصول یا دستهٔ آن را مجاز کرده باشد آن را می‌بیند و می‌خرد.',
  'web.product_gap_unpriced': 'قیمت ندارد؛ بدون قیمت قابل فروش نیست.',
  'web.product_gap_no_panel': 'به هیچ پنلی وصل نیست؛ چیزی برای تحویل وجود ندارد.',
  'web.product_gap_uncategorised': 'در هیچ دسته‌ای نیست؛ تا در دسته‌ای قرار نگیرد فروخته نمی‌شود.',
  'web.product_gap_category_inactive': 'دستهٔ آن غیرفعال است؛ حتی با پیوند مستقیم فروخته نمی‌شود.',
  'web.product_gap_category_hidden':
    'دستهٔ آن پنهان است؛ با پیوند مستقیم فروخته می‌شود ولی در فهرست نمی‌آید.',
  'web.product_gap_category_unknown': 'وضعیت دستهٔ آن خوانده نشد.',

  'web.product_new_title': 'محصول تازه',
  'web.product_edit_title': 'ویرایش محصول',
  'web.product_edit_denied': 'برای ساخت یا ویرایش محصول به دسترسی catalog.edit نیاز است.',
  'web.product_create': 'ساخت محصول',
  'web.product_save': 'ذخیرهٔ تغییرات',
  'web.product_created': 'محصول ساخته شد.',
  'web.product_saved': 'تغییرات ذخیره شد.',
  'web.product_created_inactive':
    'محصول تازه غیرفعال ساخته می‌شود تا یک دکمه نتواند پلنِ بی‌قیمت یا بی‌پنل را منتشر کند.',
  'web.product_status_title': 'فعال یا غیرفعال',
  'web.product_status_hint': 'فقط محصول فعال به مشتری فروخته می‌شود.',
  'web.product_activate': 'فعال کردن',
  'web.product_deactivate': 'غیرفعال کردن',
  'web.product_activated': 'محصول فعال شد.',
  'web.product_deactivated': 'محصول غیرفعال شد.',
  'web.product_deactivate_note':
    'غیرفعال کردن روی سفارش‌های ثبت‌شده اثری ندارد: هر سفارش نسخهٔ خودش از محصول را نگه داشته است.',
  'web.product_problem_title': 'عنوان نمی‌تواند خالی باشد.',
  'web.product_problem_sort': 'ترتیب باید عددی صحیح و در بازهٔ مجاز باشد.',
  'web.product_problem_duration': 'مدت باید عددی صحیح و در بازهٔ مجاز باشد.',
  'web.product_problem_traffic':
    'حجم باید عددی بزرگ‌تر از صفر به گیگابایت، حداکثر با دو رقم اعشار باشد؛ یا «بدون محدودیت حجم» را انتخاب کنید.',
  'web.product_problem_devices': 'سقف دستگاه باید عددی صحیح و بزرگ‌تر از صفر باشد یا خالی بماند.',
  'web.product_problem_price': 'قیمت باید عددی صحیح و بزرگ‌تر از صفر باشد یا خالی بماند.',
  /*
   * Product display metadata (customer UX completion §C). Marketing copy the
   * pre-invoice and the cards render in the operator's order; the panel field, not
   * any of this, decides where a purchase is delivered — and the hints say so where
   * the operator is typing, because a location list that LOOKS like routing is one
   * somebody will one day edit expecting it to route.
   */
  'web.product_display_locations': 'لوکیشن‌ها',
  'web.product_display_locations_hint':
    'به همین ترتیب در پیش‌فاکتور نمایش داده می‌شود؛ هر خط یک لوکیشن، حداکثر ۳۰ خط و هر خط تا ۶۰ نویسه. فقط برای نمایش است: سرویس روی پنلِ انتخاب‌شده در بالا ساخته می‌شود، نه بر اساس این متن.',
  'web.product_display_locations_empty':
    'لوکیشنی نوشته نشده است؛ این بخش در پیش‌فاکتور نمایش داده نمی‌شود.',
  'web.product_display_add_location': 'افزودن لوکیشن',
  'web.product_display_location_n': 'لوکیشن',
  'web.product_display_features': 'ویژگی‌ها',
  'web.product_display_features_hint':
    'به همین ترتیب در پیش‌فاکتور نمایش داده می‌شود؛ هر خط یک ویژگی، حداکثر ۳۰ خط و هر خط تا ۲۰۰ نویسه.',
  'web.product_display_features_empty':
    'ویژگی‌ای نوشته نشده است؛ این بخش در پیش‌فاکتور نمایش داده نمی‌شود.',
  'web.product_display_add_feature': 'افزودن ویژگی',
  'web.product_display_feature_n': 'ویژگی',
  'web.product_display_location_label': 'برچسب لوکیشن سرویس',
  'web.product_display_location_label_hint':
    'برچسب کوتاهی که کارت تحویل و کارت سرویس به‌عنوان لوکیشن سرویس نشان می‌دهند، تا ۶۰ نویسه. خالی یعنی نمایش داده نمی‌شود.',
  'web.product_display_problem_locations':
    'هر لوکیشن باید یک خط غیرخالی و حداکثر ۶۰ نویسه باشد و بیش از ۳۰ لوکیشن مجاز نیست.',
  'web.product_display_problem_features':
    'هر ویژگی باید یک خط غیرخالی و حداکثر ۲۰۰ نویسه باشد و بیش از ۳۰ ویژگی مجاز نیست.',
  'web.product_display_problem_label': 'برچسب لوکیشن سرویس باید یک خط و حداکثر ۶۰ نویسه باشد.',
  'web.products_scope_title': 'آنچه در این نسخه نیست',
  'web.products_scope_body':
    'فهرست قیمت جداگانه برای نمایندگان در این نسخه وجود ندارد. قیمت هر محصول همان عددی است که اینجا وارد می‌کنید؛ نماینده با نرخ سطح خود (یا نرخ اختصاصی‌اش) از همین قیمت خرید می‌کند، و تخفیف‌ها و کش‌بک قاعده‌هایی جدا هستند که در صفحهٔ «تخفیف‌ها و کش‌بک» روی قیمت اعمال می‌شوند.',
  /*
   * Owner revision 10, carried onto the LIVE page.
   *
   * It used to live on the planned products page, which no route renders any more. A
   * decision recorded only on an unreachable screen is a decision nobody will read
   * before breaking it — the same reason `users`' two absences moved to the real page
   * when Phase 4A shipped it.
   */
  'web.products_panel_rule':
    'انتخاب خودکار «کم‌بارترین پنل» وجود نخواهد داشت. یا محصول به یک پنل مشخص گره خورده است، یا مشتری هنگام خرید پنل را انتخاب می‌کند.',

  // --- Orders (Phase 4B) ---------------------------------------------------
  'web.orders_title': 'سفارش‌ها',
  'web.orders_intro': 'آنچه مشتری خواسته است، و مبلغی که به او اعلام شده.',
  'web.orders_empty': 'هنوز سفارشی ثبت نشده است.',
  'web.orders_empty_hint': 'وقتی مشتری از فهرست ربات چیزی انتخاب کند، اینجا دیده می‌شود.',
  'web.orders_filter_empty': 'سفارشی با این مشخصات پیدا نشد.',
  'web.orders_filter_empty_hint': 'شناسه را بررسی کنید یا صافی‌ها را پاک کنید.',
  'web.orders_filter_customer_hint': 'شناسهٔ داخلی مشتری، نه شناسهٔ تلگرام.',
  'web.orders_filter_product_hint': 'شناسهٔ محصول.',
  'web.orders_filter_invalid_id':
    'این یک شناسهٔ معتبر نیست. شناسهٔ داخلی را از صفحهٔ همان مشتری یا محصول بردارید.',
  'web.order_detail': 'جزئیات سفارش',
  'web.order_line': 'سرویس',
  'web.order_line_title': 'آنچه خریداری شده',
  'web.order_snapshot_hint':
    'این مقادیر در لحظهٔ ثبت سفارش نگه داشته شده‌اند؛ تغییر بعدی محصول آنها را عوض نمی‌کند.',
  'web.order_unit_price': 'قیمت واحد',
  'web.order_quantity': 'تعداد',
  'web.order_totals_title': 'مبلغ',
  'web.order_subtotal': 'جمع',
  'web.order_discount': 'تخفیف',
  'web.order_total': 'مبلغ نهایی',
  'web.order_lifecycle_title': 'وضعیت و زمان‌ها',
  'web.order_created_at': 'ثبت‌شده در',
  'web.order_expires_at': 'اعتبار تا',
  'web.order_settled_at': 'زمان تسویه',
  'web.order_payments_title': 'پرداخت‌های این سفارش',
  'web.order_payments_empty': 'هنوز پرداختی برای این سفارش ثبت نشده است.',
  'web.order_payments_denied': 'نمایش پرداخت‌های این سفارش به دسترسی payments.view نیاز دارد.',
  'web.order_payments_truncated':
    'پرداخت‌های بیشتری برای این سفارش ثبت شده است. فهرست کامل در صفحهٔ پرداخت‌ها با فیلتر همین سفارش در دسترس است.',
  /* --- What the order produced (hotfix: the activation/sellability pass) ----- */
  'web.order_service_title': 'سرویس این سفارش',
  'web.order_service_hint':
    'آنچه این سفارش ساخته است و آنچه هنگام ساخت آن اتفاق افتاده. اگر ساخت ناموفق بوده، دلیل فنی آن در جدول عملیات پایین همین صفحه دیده می‌شود.',
  'web.order_service_denied': 'نمایش سرویس این سفارش به دسترسی services.view نیاز دارد.',
  'web.order_service_empty': 'هنوز سرویسی برای این سفارش ساخته نشده است.',
  'web.order_service_empty_hint':
    'تا وقتی پول سفارش تسویه نشده باشد، سرویسی ساخته نمی‌شود. اگر سفارش تسویه شده و اینجا خالی است، یا سفارش از نوع خرید سرویس جدید نبوده، یا هنگام تسویه هیچ پنل واجد شرایطی برای تحویل آن نبوده و سفارش در همان لحظه بازگشت خورده است. وضعیت سفارش در بالای همین صفحه می‌گوید کدام‌یک.',
  'web.order_refunded_banner_title': 'این سفارش بازگشت خورده است',
  /*
   * REWRITTEN for WP10 P3. It said the order was refunded because its service could not
   * be created — true of the automatic lane, and false since an operator's refunds that
   * reach the payment's full amount also move the order to REFUNDED, after delivery.
   * Both causes are named, because this banner reads only the order's state and that
   * state does not say which of the two produced it.
   */
  'web.order_refunded_banner_body':
    'پول این سفارش بازگردانده شده است: یا به‌طور خودکار، چون ساخت سرویس آن ممکن نشد، یا با بازگشت‌های وجهی که اپراتور ثبت کرده است. در حالت خودکار، اگر پیش از آن بخشی از همان پرداخت به‌صورت دستی بازگردانده شده باشد، تنها باقیماندهٔ آن به کیف پول مشتری واریز می‌شود. بازگشت وجه هیچ سرویسی را تعلیق یا حذف نمی‌کند. مبلغ و مقصد دقیق هر بازپرداخت در تاریخچهٔ بازپرداخت‌های همان پرداخت و در دفتر کیف پول مشتری ثبت شده است.',
  'web.order_confirmed_at': 'تأییدشده در',
  'web.order_customer': 'مشتری',
  'web.order_product': 'محصول',
  'web.order_references_title': 'ارجاع‌ها',
  'web.order_references_hint':
    'برای پیمایش است؛ آنچه خریداری شده از همین سفارش خوانده می‌شود، نه از محصول امروز.',
  'web.order_state_draft': 'پیش‌نویس',
  'web.order_state_awaiting_payment': 'در انتظار پرداخت',
  'web.order_state_paid': 'پرداخت‌شده',
  'web.order_state_cancelled': 'لغوشده',
  'web.order_state_expired': 'منقضی‌شده',
  'web.order_state_refunded': 'بازپرداخت‌شده',
  'web.order_awaiting_banner_title': 'این سفارش منتظر پرداخت است',
  /*
   * Rewritten for 4C. It used to say there was no way to take a payment at all,
   * which was true of 4B and is not now: a customer pays from their wallet or
   * submits a transfer, and an operator confirms the latter on the payments page.
   * What stays true is that there is no «پرداخت شد» button HERE — an operator
   * asserting money arrived is what `settlementIsFunded` refuses to take anyone's
   * word for.
   */
  'web.order_awaiting_banner_body':
    'این سفارش در انتظار پرداخت مشتری است. تأیید دریافت وجه در صفحهٔ پرداخت‌ها و همراه با ثبت مبنای تأیید انجام می‌شود؛ در این صفحه دکمهٔ «پرداخت شد» وجود ندارد.',
  /*
   * REWRITTEN, and the heading with it. This said delivery, cancellation and
   * refund "do not exist in this version" and that the order stops at PAID —
   * false since 4D, 4G and the automatic-refund change respectively. It was
   * still rendered on both the list and the detail page while a customer was
   * being refunded by machinery it claimed did not exist.
   *
   * What replaces it is not a smaller scope note. It is the actual rule, which
   * an operator does need on this page: an order has two terminal outcomes and
   * there is no third.
   */
  'web.orders_scope_title': 'دو پایان ممکن برای یک سفارش',
  'web.orders_scope_body':
    'سفارشی که پول آن رسیده یا «تحویل‌شده» می‌شود یا «بازگشت‌خورده». حالت سومی برای «پرداخت شد ولی تحویل نشد» وجود ندارد: اگر ساخت سرویس ممکن نباشد، مبلغ در همان تراکنش به‌طور کامل به کیف پول مشتری برمی‌گردد و سفارش «بازگشت‌خورده» می‌شود.',
  /*
   * Owner revisions 3, 6 and 11, carried onto the LIVE page.
   *
   * Revision 6 is DELIVERED — every `line*` field is a snapshot, so an order's history
   * is not rewritten by editing the product — and it is stated here beside the two that
   * are still future so the three are read together. The other two describe the payment
   * surface, which does not exist yet; recording them on a planned page no route renders
   * would have left them for nobody.
   */
  'web.orders_future_rules_title': 'قاعده‌هایی که در فازهای بعد نگه داشته می‌شوند',
  'web.orders_rule_history':
    'تاریخچهٔ واقعی سفارش و سرویس حفظ می‌شود و با یک وضعیت جاری عمومی بازنویسی نمی‌شود؛ در همین نسخه هر سفارش نسخهٔ خودش از محصول را نگه می‌دارد.',
  'web.orders_rule_attention':
    'سفارش عادی «در انتظار پرداخت» جزو «نیازمند توجه» شمرده نمی‌شود؛ این برچسب فقط برای مواردی است که واقعاً دخالت اپراتور لازم است.',
  'web.orders_rule_shared_projection':
    'صفحهٔ سفارش و صفحهٔ پرداخت از یک پروجکشن مشترک استفاده می‌کنند تا هرگز دو وضعیت متناقض نشان ندهند.',

  // --- Services (Phase 4H) -------------------------------------------------
  /*
   * A service is what the customer BOUGHT, and this page never hands over what
   * they bought with.
   *
   * There is no subscription link here, no subscription ref and no provider client
   * id — those are bearer capabilities, and `serviceSummarySchema` leaves all three
   * out of the response rather than leaving them out of the markup. So there is no
   * key for any of them either: a string like «لینک اشتراک: ********» would be a
   * label waiting for somebody to fill it in.
   *
   * `web.service_subscription_withheld` says that out loud, because an operator who
   * cannot find the link needs to know it is withheld rather than missing.
   */
  'web.services_title': 'سرویس‌ها',
  'web.services_intro': 'سرویس‌هایی که ساخته شده‌اند، و آنهایی که هنوز نشده‌اند.',
  'web.services_empty': 'هنوز سرویسی ساخته نشده است.',
  'web.services_empty_hint':
    'سرویس با تسویهٔ یک سفارش ساخته می‌شود؛ تا آن لحظه چیزی برای دیدن نیست.',
  'web.service_detail': 'جزئیات سرویس',

  'web.service_state': 'وضعیت',
  'web.service_state_pending_provision': 'در انتظار ساخت',
  'web.service_state_active': 'فعال',
  'web.service_state_suspended': 'موقتاً قطع',
  'web.service_state_expired': 'منقضی',
  'web.service_state_terminated': 'پایان‌یافته',
  'web.service_state_unreconciled': 'نامشخص روی پنل',

  /*
   * Delivery is a SECOND axis, and the labels never borrow the lifecycle's words.
   *
   * 4D's `recordDelivery` exists so that a failed Telegram send cannot move a service
   * out of `ACTIVE`; if this column said «ناموفق» in the same vocabulary the state
   * column uses, an operator would read a bounced message as a failed service — and
   * the obvious remedy for that is to build it again, on somebody's panel, a second
   * time.
   */
  'web.service_delivery': 'تحویل به مشتری',
  'web.service_delivery_pending': 'هنوز اعلام نشده',
  'web.service_delivery_delivered': 'به مشتری رسید',
  'web.service_delivery_unconfirmed': 'نامشخص',
  'web.service_delivery_failed': 'رد شد',

  'web.service_customer': 'مشتری',
  'web.service_panel': 'پنل',
  'web.service_product': 'محصول',
  'web.service_order': 'سفارش',
  'web.service_username': 'نام کاربری روی پنل',
  'web.service_username_hint': 'همان چیزی است که در پنل جست‌وجو می‌کنید. این یک اعتبارنامه نیست.',
  'web.service_provider_user_id': 'شناسهٔ کاربر در پنل',
  'web.service_subscription': 'لینک اشتراک',
  'web.service_subscription_present': 'ساخته شده',
  'web.service_subscription_absent': 'هنوز ساخته نشده',
  'web.service_subscription_withheld':
    'لینک اشتراک در این صفحه نشان داده نمی‌شود و از سرور هم برنمی‌گردد: هرکس آن را داشته باشد می‌تواند از سرویس استفاده کند. مشتری آن را در ربات دریافت می‌کند.',

  'web.service_expires_at': 'انقضا',
  'web.service_traffic_limit': 'سقف حجم',
  'web.service_device_limit': 'تعداد کاربر / دستگاه مجاز',
  'web.service_device_limit_none': 'ثبت نشده',
  'web.service_traffic_used': 'حجم مصرف‌شده',
  'web.service_usage_synced_at': 'آخرین خواندن مصرف از پنل',
  'web.service_usage_never': 'هرگز از پنل خوانده نشده است.',
  'web.service_provisioned_at': 'زمان ساخت روی پنل',
  'web.service_delivered_at': 'زمان اعلام به مشتری',
  'web.service_terminated_at': 'زمان پایان',
  'web.service_created_at': 'زمان ثبت',
  'web.service_updated_at': 'آخرین تغییر',
  'web.service_delivery_attempts': 'تعداد تلاش برای اعلام',
  'web.service_delivery_next_attempt': 'تلاش بعدی',

  'web.services_filter_all': 'همه',
  'web.services_filter_customer_hint': 'شناسهٔ مشتری را کامل وارد کنید.',
  'web.services_filter_panel_hint': 'شناسهٔ پنل را کامل وارد کنید.',
  'web.services_filter_invalid_id': 'شناسه معتبر نیست.',
  /*
   * The lookup an operator actually arrives with.
   *
   * A customer quotes the name on their account, never the internal id, so until
   * this existed the one handle a support conversation contains matched no search
   * on either surface. EXACT, and the hint says so: a prefix over account names
   * would enumerate a panel's accounts, and every row here leads to a
   * subscription.
   */
  'web.services_filter_username_hint': 'نام کاربری روی پنل را کامل وارد کنید؛ جست‌وجو دقیق است.',
  'web.services_filter_invalid_username': 'این نام کاربری از شکلی نیست که اینجا ذخیره می‌شود.',
  'web.services_search_apply': 'جست‌وجو',

  /*
   * Three banners, each naming what an operator should DO.
   *
   * `UNRECONCILED` is an absence of knowledge, exactly as `UNKNOWN` is on a payment,
   * and the copy refuses to suggest building the service again — that is the
   * duplicate the state exists to prevent.
   */
  'web.service_unreconciled_banner':
    'معلوم نیست روی پنل کاربری برای این سرویس ساخته شده است یا نه. تا وقتی تطبیق انجام نشده، ساختن دوبارهٔ آن یعنی احتمال یک کاربر تکراری روی پنل.',
  'web.service_delivery_unconfirmed_banner':
    'نتیجهٔ اعلام به مشتری نامشخص است؛ ممکن است پیام را گرفته باشد. دوباره فرستادن خودکار انجام نمی‌شود، چون دو پیام «سرویس شما آماده است» یعنی مشتری نمی‌داند کدام درست است.',
  'web.service_delivery_failed_banner':
    'اعلام به مشتری قطعاً رد شده است. تلاش دوباره آن را درست نمی‌کند: یا مشتری ربات را بلاک کرده، یا توکن ربات کار نمی‌کند.',

  // --- Service operations --------------------------------------------------
  /*
   * The other half of "why has this customer not had their service".
   *
   * `failureMessage` is the ADAPTER's own text and IS shown: it is what tells a
   * panel refusing a duplicate apart from a panel that was unreachable, and an
   * operator can act on the difference.
   */
  'web.service_operations_title': 'کارهای انجام‌شده روی این سرویس',
  'web.service_operations_hint':
    'تازه‌ترین در بالا. این فهرست صفحه‌بندی نمی‌شود و به تازه‌ترین عملیات محدود است.',
  /*
   * The bound, printed only when it actually bit.
   *
   * What stood here said a service with dozens of operations "is itself the
   * problem". A service renewed monthly for three years accumulates renew,
   * add-traffic and usage-sync operations by ORDINARY use; the retry ceilings
   * bound attempts, not a lifetime. So the old sentence told an operator their
   * healthy service was in trouble on the evidence of its age, and told them
   * nothing about the one thing they needed to know — whether they were
   * looking at all of it.
   *
   * The figure comes from the RESPONSE, never from a constant in this file: the
   * server reads one row beyond its bound to answer this, and a client that
   * hard-coded fifty would print a number that stopped being true the moment
   * the bound moved.
   */
  'web.service_operations_truncated':
    'عملیات قدیمی‌تری هم روی این سرویس ثبت شده و اینجا نیامده است. شمار عملیات نشان‌داده‌شده:',
  'web.service_operations_empty': 'هیچ عملیاتی روی این سرویس ثبت نشده است.',
  'web.operation_type': 'نوع',
  'web.operation_state': 'نتیجه',
  'web.operation_attempts': 'تلاش‌ها',
  'web.operation_failure': 'پیام پنل',
  'web.operation_scheduled_at': 'زمان‌بندی',
  'web.operation_completed_at': 'پایان',
  'web.operation_created_at': 'ثبت',

  'web.operation_type_provision': 'ساخت',
  'web.operation_type_renew': 'تمدید',
  'web.operation_type_add_traffic': 'افزودن حجم',
  'web.operation_type_add_time': 'افزودن زمان',
  'web.operation_type_add_devices': 'افزایش کاربر / دستگاه',
  'web.operation_type_change_location': 'تغییر لوکیشن',
  'web.operation_type_suspend': 'قطع موقت',
  'web.operation_type_resume': 'وصل دوباره',
  'web.operation_type_terminate': 'حذف',
  'web.operation_type_sync_usage': 'خواندن مصرف',
  'web.operation_type_rotate_subscription': 'تعویض لینک اشتراک',
  'web.operation_type_reconcile': 'تطبیق با پنل',

  'web.operation_state_planned': 'ثبت‌شده',
  'web.operation_state_in_flight': 'در حال انجام',
  'web.operation_state_succeeded': 'موفق',
  'web.operation_state_failed': 'ناموفق',
  'web.operation_state_unknown': 'نامشخص',
  'web.operation_state_abandoned': 'رهاشده',

  // --- Services: what this page deliberately does not do --------------------
  /*
   * Owner revisions 12, 13 and 14, moved here from the placeholder this route
   * replaced.
   *
   * Revision 13 is not only a record: `drizzle-service.repository.ts` pages
   * `(created_at, id)` DESCENDING because of it, against the ascending convention
   * every other list here follows, and `services-http.test.ts` asserts the rows.
   * The other two are still absences, and an absence with nowhere to live is an
   * absence that comes back.
   */
  'web.services_rules_title': 'قاعده‌های این صفحه',
  'web.services_rule_no_protocol':
    'پروتکل (VLESS/VMess/…) در رابط عادی سرویس‌ها نمایش داده نمی‌شود؛ انتزاع سرویس، لینک اشتراک است.',
  'web.services_rule_ordering':
    'ترتیب از سمت سرور است: created_at نزولی و سپس id نزولی. مرتب‌سازی یک صفحهٔ واکشی‌شده در مرورگر مجاز نیست.',
  'web.services_rule_plan_filter':
    'فیلتر لوکیشن وجود نخواهد داشت؛ به جای آن فیلتر چندانتخابی «پلن» با پشتیبانی از صفحه‌بندی سمت سرور.',
  /*
   * What is STILL not here, in the product's own words rather than left for an
   * operator to infer from a missing button.
   *
   * Phase 6A built the seven actions this sentence used to say were absent. Package F
   * built the CUSTOMER's transfer, from the bot: the owner settled that only ownership
   * moves. `services.transfer` — the operator's transfer — is still a declared permission
   * with no endpoint, because none was asked for; and each customer transfer is in the
   * audit log as `service.transfer`.
   */
  'web.services_transfer_absent':
    'انتقال سرویس از پنل مدیریت ساخته نشده است. مشتری خودش سرویسش را از داخل ربات به کاربر دیگری منتقل می‌کند؛ فقط مالکیت جابه‌جا می‌شود و سفارش، پرداخت و لینک اشتراک دست نمی‌خورند. هر انتقال با عنوان service.transfer در گزارش ممیزی ثبت می‌شود. دکمهٔ غیرفعال نگذاشته‌ایم، چون یعنی «هست ولی دسترسی ندارید».',

  // --- Service actions -----------------------------------------------------
  'web.service_actions_title': 'عملیات روی این سرویس',
  'web.service_actions_hint':
    'هر عملیات همان‌جا و با همان قواعد سمت سرور بررسی می‌شود؛ این فهرست تصمیم سرور را نشان می‌دهد، نه تصمیم این صفحه.',
  'web.service_action_sync_usage': 'به‌روزرسانی مصرف از پنل',
  'web.service_action_resend_config': 'ارسال مجدد لینک به مشتری',
  'web.service_action_retry_provision': 'تلاش مجدد برای ساخت روی پنل',
  'web.service_action_reconcile': 'تطبیق با پنل',
  'web.service_action_suspend': 'موقتاً غیرفعال کن',
  'web.service_action_resume': 'دوباره فعال کن',
  'web.service_action_terminate': 'پایان دادن به سرویس',
  'web.service_action_rotate_link': 'ساخت لینک اشتراک جدید',
  /*
   * WHY an action is not offered. One sentence per blocker code, and each one names
   * the screen or the wait that resolves it — a greyed-out control with no reason is
   * the legacy panel's whole style of refusal.
   */
  'web.service_blocker_state': 'وضعیت فعلی سرویس این کار را ممکن نمی‌کند.',
  'web.service_blocker_capability':
    'نوع پنل این سرویس چنین کاری را پشتیبانی نمی‌کند. با تنظیم پنل درست نمی‌شود.',
  'web.service_blocker_panel_not_operable':
    'پنل این سرویس در حال حاضر قابل استفاده نیست. صفحهٔ پنل‌ها را ببینید.',
  'web.service_blocker_in_progress': 'یک عملیات از همین نوع در جریان است؛ کمی بعد دوباره ببینید.',
  'web.service_blocker_no_configuration': 'هنوز لینکی برای این سرویس ساخته نشده که فرستاده شود.',
  'web.service_blocker_no_contact':
    'جایی برای فرستادن نیست: مشتری ربات را شروع نکرده یا مسدود شده است.',
  'web.service_action_denied_edit': 'برای انجام این کارها به دسترسی «ویرایش سرویس» نیاز دارید.',
  'web.service_action_denied_terminate':
    'پایان دادن به سرویس دسترسی جداگانه‌ای دارد که شما ندارید.',
  'web.service_action_planned': 'درخواست ثبت شد. تا وقتی پنل آن را اعمال نکند، انجام‌شده نیست.',
  'web.service_action_resent': 'لینک برای مشتری فرستاده شد.',
  /* The terminate confirmation. A typed phrase, for the reason the recovery screen gives. */
  'web.service_terminate_title': 'پایان دادن به سرویس',
  'web.service_terminate_danger':
    'این کار حساب مشتری را روی پنل حذف می‌کند و برگشت‌پذیر نیست. سفارشی که مشتری پرداخت کرده سر جایش می‌ماند.',
  'web.service_terminate_confirm_label': 'برای تأیید، این عبارت را دقیقاً بنویسید:',
  'web.service_terminate_confirm_wrong': 'عبارت تأیید مطابقت ندارد.',
  'web.service_terminate_button': 'پایان بده',

  // --- Units ---------------------------------------------------------------
  'web.unit_seconds': 'ثانیه',
  'web.unit_minutes': 'دقیقه',
  'web.unit_hours': 'ساعت',
  /*
   * Persian names for the reminder settings and switches.
   *
   * The setting titles here are read through `settings-presentation.ts`, which is TOTAL
   * over the registry (WP-A1); the flag names through `registryLabel` in `settings.tsx`.
   * A setting's unit is shown beside its field, so it is not repeated in the title.
   */
  'web.setting_reminders_expiry_first_days': 'یادآور اول پیش از انقضا',
  'web.setting_reminders_expiry_second_days': 'یادآور دوم پیش از انقضا',
  'web.setting_reminders_usage_first_percent': 'آستانهٔ اول مصرف حجم',
  'web.setting_reminders_usage_second_percent': 'آستانهٔ دوم مصرف حجم',
  'web.setting_reminders_usage_final_percent': 'آستانهٔ پایانی مصرف حجم',
  'web.flag_service_expiry_reminders': 'یادآور پیش از انقضای سرویس',
  'web.flag_service_expired_notice': 'اعلام پایان اعتبار سرویس',
  'web.flag_service_usage_reminders': 'یادآور مصرف حجم سرویس',
  // WP-A9: the names of the reminder keys and switches this package added.
  'web.setting_reminders_expiry_early_days': 'یادآور هفتگی پیش از انقضا',
  'web.setting_reminders_payment_pending_minutes': 'زمان یادآور پرداخت در انتظار',
  'web.setting_wallet_low_balance_threshold': 'آستانهٔ هشدار کمبود موجودی کیف پول',
  'web.flag_service_expiry_day_reminder': 'یادآور روز انقضای سرویس',
  'web.flag_wallet_low_balance_reminders': 'هشدار کمبود موجودی کیف پول',
  'web.flag_payment_pending_reminders': 'یادآور پرداخت در انتظار',
  // HF-A9: quiet hours.
  'web.setting_reminders_quiet_hours_start': 'شروع ساعات سکوت یادآورها',
  'web.setting_reminders_quiet_hours_end': 'پایان ساعات سکوت یادآورها',
  'web.flag_reminder_quiet_hours': 'ساعات سکوت یادآورها',
  // WP-A9: the reminders screen.
  'web.nav_reminders': 'یادآورها',
  'web.reminders_title': 'یادآورهای خودکار',
  'web.reminders_intro':
    'پیام‌هایی را که ربات خودکار برای مشتریان می‌فرستد روشن یا خاموش کنید و زمان آن‌ها را تنظیم کنید. هر یادآور برای هر سرویس، پرداخت یا کاهش موجودی فقط یک بار فرستاده می‌شود.',
  'web.reminders_expiry_title': 'انقضای سرویس',
  'web.reminders_expiry_hint':
    'پیش از پایان اعتبار سرویس، در روز انقضا و پس از آن به مشتری خبر می‌دهد. اگر مشتری تمدید کند، یادآورهای دورهٔ قبلی دیگر فرستاده نمی‌شوند.',
  'web.reminders_flag_expiry': 'یادآور پیش از انقضا',
  'web.reminders_flag_expiry_day': 'یادآور روز انقضا',
  'web.reminders_day_hint':
    'از ابتدای روزِ انقضا به وقت فروشگاه و پیش از پایان اعتبار فرستاده می‌شود.',
  'web.reminders_flag_expired': 'اعلام پایان اعتبار',
  'web.reminders_early_days': 'یادآور هفتگی',
  'web.reminders_early_days_hint':
    'چند روز پیش از انقضا، زودتر از یادآور اول. صفر یعنی این یادآور فرستاده نشود.',
  'web.reminders_early_inert':
    'یادآور هفتگی زودتر از یادآور اول نیست و در حال حاضر فرستاده نمی‌شود. عدد آن را بیشتر از یادآور اول کنید یا صفر بگذارید.',
  'web.reminders_first_days': 'یادآور اول',
  'web.reminders_second_days': 'یادآور دوم',
  'web.reminders_days_hint':
    'چند روز پیش از انقضا، از ۱ تا ۳۰. یادآور اول باید زودتر از یادآور دوم باشد.',
  'web.reminders_unit_days': 'روز پیش از انقضا',
  'web.reminders_usage_title': 'کاهش حجم',
  'web.reminders_usage_hint':
    'وقتی بخش مشخصی از حجم سرویس باقی مانده باشد به مشتری خبر می‌دهد. پس از خرید حجم اضافه یا تمدید، از نو شمرده می‌شود. سرویس با حجم نامحدود هشدار نمی‌گیرد.',
  'web.reminders_flag_usage': 'یادآور کاهش حجم',
  'web.reminders_usage_first': 'هشدار اول',
  'web.reminders_usage_second': 'هشدار دوم',
  'web.reminders_usage_final': 'هشدار پایانی',
  'web.reminders_usage_values_hint':
    'درصد حجم باقی‌مانده، از ۰ تا ۹۹. هر هشدار باید با حجم باقی‌ماندهٔ کمتری از هشدار قبلی باشد.',
  'web.reminders_unit_percent': 'درصد باقی‌مانده',
  'web.reminders_wallet_title': 'کمبود موجودی کیف پول',
  'web.reminders_wallet_hint':
    'وقتی موجودی کیف پول مشتری از مبلغ تعیین‌شده کمتر شود، یک بار به او خبر می‌دهد و تا موجودی دوباره به این مبلغ نرسیده باشد پیام دیگری نمی‌فرستد. به مشتری‌ای که هیچ‌وقت این مبلغ را در کیف پول نداشته پیامی فرستاده نمی‌شود.',
  'web.reminders_flag_wallet': 'هشدار کمبود موجودی',
  'web.reminders_wallet_threshold': 'مبلغ آستانه',
  'web.reminders_wallet_threshold_hint':
    'به کوچک‌ترین واحد پول فروش. صفر یعنی هشداری فرستاده نشود.',
  'web.reminders_wallet_currency_mismatch':
    'این مبلغ به واحد پولی غیر از واحد فروش فعلی ذخیره شده و هشداری فرستاده نمی‌شود. مبلغ را دوباره ذخیره کنید.',
  'web.reminders_pending_title': 'پرداخت در انتظار',
  'web.reminders_pending_hint':
    'کمی پیش از پایان مهلت، یک بار به مشتری‌ای که هنوز کارت‌به‌کارت نکرده یا سفارشش را پرداخت نکرده یادآوری می‌کند. برای پرداخت تأییدشده، لغوشده یا منقضی‌شده، پرداختی که رسیدش ارسال شده و پرداخت درگاهی فرستاده نمی‌شود.',
  'web.reminders_flag_pending': 'یادآور پرداخت در انتظار',
  'web.reminders_pending_minutes': 'زمان یادآوری',
  'web.reminders_pending_minutes_hint':
    'چند دقیقه پیش از پایان مهلت، از ۵ تا ۳۰. پرداختی که کمتر از ۵ دقیقه از ایجادش گذشته یا کمتر از ۳ دقیقه به پایان مهلتش مانده یادآوری نمی‌شود.',
  // HF-A9: the quiet-hours card.
  'web.reminders_quiet_title': 'ساعات سکوت',
  'web.reminders_quiet_hint':
    'یادآوری که در این بازه موعدش برسد حذف نمی‌شود؛ تا پایان بازه نگه داشته می‌شود و بعد فقط یک بار فرستاده می‌شود. اگر تا آن زمان دیگر معتبر نباشد (مثلاً سرویس تمدید شده، پرداخت انجام یا منقضی شده یا کیف پول شارژ شده) فرستاده نمی‌شود. ساعت‌ها به وقت فروشگاه است. پیام‌های پرداخت، سفارش و پاسخ به مشتری هیچ‌وقت نگه داشته نمی‌شوند.',
  'web.reminders_flag_quiet': 'فعال بودن ساعات سکوت',
  'web.reminders_quiet_start': 'ساعت شروع',
  'web.reminders_quiet_end': 'ساعت پایان',
  'web.reminders_quiet_time_hint': 'ساعت و دقیقه، ۲۴ساعته.',
  'web.reminders_quiet_overnight':
    'ساعت پایان پیش از ساعت شروع است، پس بازه از نیمه‌شب می‌گذرد و تا ساعت پایانِ روز بعد ادامه دارد.',
  'web.reminders_quiet_same':
    'ساعت شروع و پایان یکسان است و ساعات سکوت اثری ندارد. یکی از آن دو را تغییر دهید.',
  'web.reminders_templates': 'متن پیام‌ها',
  'web.reminders_templates_hint':
    'متن هر پیام را می‌توانید همین‌جا ویرایش کنید؛ همان متنی است که در بخش «متن‌ها» هم دیده می‌شود.',
  'web.reminders_templates_denied': 'برای دیدن و ویرایش متن پیام‌ها به دسترسی «متن‌ها» نیاز است.',
  // WP6-A: the trial's flag, its two settings, and the product picker's two options.
  'web.flag_trials': 'سرویس آزمایشی',
  'web.setting_trial_product_id': 'محصول سرویس آزمایشی (بازنشسته)',
  'web.setting_trial_limit_per_customer': 'تعداد مجاز سرویس آزمایشی برای هر مشتری',
  'web.flag_customer_link_rotation': 'دریافت لینک اشتراک جدید توسط مشتری',
  'web.setting_link_rotation_cooldown_hours': 'فاصلهٔ مجاز بین دو درخواست لینک جدید',
  'web.flag_referral_signup_gift': 'هدیهٔ عضویت از طریق معرفی',
  'web.setting_referral_signup_gift_total': 'مبلغ کل هدیهٔ عضویت',
  'web.setting_referral_signup_gift_referrer_percent': 'سهم معرف از هدیهٔ عضویت',
  'web.setting_referral_signup_gift_referred_percent': 'سهم کاربر معرفی‌شده از هدیهٔ عضویت',
  'web.trial_product_none': 'هیچ‌کدام (سرویس آزمایشی ارائه نمی‌شود)',
  'web.trial_product_unlisted': 'محصول فعلی (در فهرست محصولات فعال نیست)',
  'web.trial_product_current': 'محصول فعلی',

  // WP6-B: a customer's trial allowance, the override, the global reset and its history.
  'web.nav_trials': 'سرویس آزمایشی',
  'web.trial_card_title': 'سرویس آزمایشی',
  'web.trial_feature_off':
    'سرویس آزمایشی در این نصب خاموش است؛ این اعداد تا روشن شدن آن به کار نمی‌آیند.',
  'web.trial_global_limit': 'سقف پیش‌فرض',
  'web.trial_override': 'سقف اختصاصی',
  'web.trial_override_none': 'ندارد (از سقف پیش‌فرض پیروی می‌کند)',
  'web.trial_effective_limit': 'سقف مؤثر',
  'web.trial_used': 'استفاده‌شده',
  'web.trial_remaining': 'باقی‌مانده',
  'web.trial_zero_hint': 'صفر یعنی هیچ سرویس آزمایشی؛ هرگز به معنای نامحدود نیست.',
  'web.trial_override_label': 'سقف اختصاصی جدید',
  'web.trial_reason_label': 'دلیل (اختیاری؛ در گزارش ممیزی ثبت می‌شود)',
  'web.trial_override_set': 'ثبت سقف اختصاصی',
  'web.trial_override_remove': 'حذف سقف اختصاصی',
  'web.trial_override_done': 'سقف اختصاصی ثبت شد.',
  'web.trial_override_removed': 'سقف اختصاصی حذف شد و مشتری از سقف پیش‌فرض پیروی می‌کند.',
  'web.trial_override_denied': 'برای تغییر سقف اختصاصی به دسترسی users.trial.edit نیاز است.',
  'web.trials_title': 'سرویس آزمایشی',
  'web.trials_overrides_title': 'مشتریان با سقف اختصاصی',
  'web.trials_overrides_empty': 'هیچ مشتری سقف اختصاصی ندارد.',
  'web.trials_overrides_denied': 'برای دیدن این فهرست به دسترسی users.view نیاز است.',
  'web.trials_customer': 'مشتری',
  'web.trials_set_at': 'زمان ثبت',
  'web.trials_reset_title': 'بازنشانی مصرف همه مشتریان',
  'web.trials_reset_body':
    'مصرف سرویس آزمایشی همه مشتریان صفر می‌شود و سقف‌های اختصاصی دست نمی‌خورند. این کار برگشت‌پذیر نیست.',
  'web.trials_reset_preview': 'پیش‌نمایش',
  'web.trials_reset_affected': 'سرویس‌های آزمایشی که دیگر شمرده نمی‌شوند',
  'web.trials_reset_customers': 'تعداد مشتریان',
  'web.trials_reset_sample': 'نمونه‌ای از مشتریان',
  'web.trials_reset_grants': 'تعداد',
  'web.trials_reset_nothing': 'هیچ سرویس آزمایشی شمرده‌شده‌ای وجود ندارد؛ چیزی برای بازنشانی نیست.',
  'web.trials_reset_confirm_label': 'برای تأیید، همان عدد بالا را وارد کنید',
  'web.trials_reset_reason_label': 'دلیل (الزامی)',
  'web.trials_reset_execute': 'بازنشانی',
  'web.trials_reset_done': 'بازنشانی انجام شد.',
  'web.trials_reset_denied': 'بازنشانی به دسترسی‌های settings.destructive و users.view نیاز دارد.',
  'web.trials_history_title': 'سابقه بازنشانی‌ها',
  'web.trials_history_empty': 'تاکنون بازنشانی انجام نشده است.',
  'web.trials_history_denied': 'برای دیدن سابقه به دسترسی settings.view نیاز است.',
  'web.trials_history_actor': 'انجام‌دهنده',
  'web.trials_history_reason': 'دلیل',
  'web.trials_history_time': 'زمان',

  // R1: the free trial per panel — its tab on the panel page and the Trials page overview.
  'web.panel_tab_trial': 'سرویس تست',
  'web.service_trial_badge': 'سرویس تست',
  'web.panel_trial_title': 'سرویس تست این پنل',
  'web.panel_trial_hint':
    'سرویس تست مستقل از محصولات فروشی است و فقط از همین‌جا تنظیم می‌شود. وقتی به مشتری پیشنهاد می‌شود که قابلیت «سرویس آزمایشی» روشن باشد، این پنل بتواند سرویس جدید بپذیرد و ساخت نام کاربری خودکار در آن مجاز باشد. تعداد دفعات مجاز برای هر مشتری در صفحهٔ تنظیمات است. تغییر این مقادیر روی سرویس‌های تستی که قبلاً داده شده‌اند اثری ندارد.',
  'web.panel_trial_unconfigured': 'سرویس تست برای این پنل هنوز تنظیم نشده است.',
  'web.panel_trial_enabled': 'ارائهٔ سرویس تست روی این پنل',
  'web.panel_trial_traffic': 'حجم سرویس تست',
  'web.panel_trial_traffic_hint':
    'مثلاً ۱۰۰ مگابایت یا ۱ گیگابایت؛ بیشتر از صفر و حداکثر ۱۰۰ گیگابایت، با حداکثر دو رقم اعشار.',
  'web.panel_trial_unit_label': 'واحد حجم',
  'web.panel_trial_unit_gb': 'گیگابایت',
  'web.panel_trial_unit_mb': 'مگابایت',
  'web.panel_trial_hours': 'مدت سرویس تست',
  'web.panel_trial_hours_hint': 'به ساعت، از ۱ تا ۷۲۰؛ مثلاً ۷۲ ساعت برای سه روز.',
  'web.panel_trial_hours_unit': 'ساعت',
  'web.panel_trial_label': 'نام نمایشی برای مشتری (اختیاری)',
  'web.panel_trial_label_hint':
    'وقتی چند پنل سرویس تست دارند، روی دکمهٔ انتخاب سرور نشان داده می‌شود. خالی یعنی نام همین پنل.',
  'web.panel_trial_invalid':
    'حجم باید بیشتر از صفر و حداکثر ۱۰۰ گیگابایت و مدت باید عددی صحیح از ۱ تا ۷۲۰ ساعت باشد.',
  'web.panel_trial_updated_at': 'آخرین تغییر',
  'web.panel_trial_stale':
    'تنظیمات سرویس تست این پنل در این فاصله تغییر کرده است. مقادیر تازه را بررسی و دوباره ذخیره کنید.',
  'web.trials_panels_title': 'پنل‌های دارای سرویس تست',
  'web.trials_panels_hint':
    'سرویس تست روی هر پنل جداگانه و از صفحهٔ همان پنل (زبانهٔ «سرویس تست») تنظیم می‌شود. «در حال ارائه» یعنی مشتری همین حالا می‌تواند آن را دریافت کند.',
  'web.trials_panels_empty': 'هنوز روی هیچ پنلی سرویس تست تنظیم نشده است.',
  'web.trials_panels_denied': 'برای دیدن این فهرست به دسترسی panels.view نیاز است.',
  'web.trials_panel': 'پنل',
  'web.trials_panel_traffic': 'حجم',
  'web.trials_panel_hours': 'مدت (ساعت)',
  'web.trials_panel_state': 'وضعیت',
  'web.trials_panel_offered': 'در حال ارائه',
  'web.trials_panel_not_offered': 'روشن، ولی فعلاً ارائه نمی‌شود',
  'web.trials_panel_disabled': 'خاموش',

  // R1: «دکمه‌های ربات» — the customer main menu's order, switches and labels.
  'web.nav_bot_buttons': 'دکمه‌های ربات',
  'web.bot_buttons_title': 'دکمه‌های ربات',
  'web.bot_buttons_intro':
    'دکمه‌های منوی اصلی ربات، یعنی کیبوردی که زیر چت مشتری نمایش داده می‌شود: ترتیب، نمایش و متن هر دکمه. دکمه‌ها دوتا دوتا کنار هم چیده می‌شوند و دکمه‌های طولانی در یک ردیف جدا.',
  'web.bot_buttons_order_title': 'ترتیب و نمایش',
  'web.bot_buttons_order_hint':
    'ترتیب را با دکمه‌های بالا و پایین تغییر دهید و در پایان ذخیره کنید. دست‌کم یکی از دکمه‌هایی که به قابلیتی وابسته نیستند باید روشن بماند.',
  'web.bot_buttons_position': 'ترتیب',
  'web.bot_buttons_button': 'دکمه',
  'web.bot_buttons_shown': 'نمایش',
  'web.bot_buttons_move_up': 'بالا',
  'web.bot_buttons_move_down': 'پایین',
  'web.bot_buttons_needs_trials': 'فقط وقتی قابلیت «سرویس آزمایشی» روشن باشد دیده می‌شود.',
  'web.bot_buttons_needs_referrals': 'فقط وقتی قابلیت «معرفی دوستان» روشن باشد دیده می‌شود.',
  'web.bot_buttons_feature_off': 'قابلیت خاموش است',
  'web.bot_buttons_one_required':
    'دست‌کم یکی از دکمه‌هایی که به قابلیتی وابسته نیستند باید روشن بماند.',
  'web.bot_buttons_unsaved': 'تغییرات هنوز ذخیره نشده‌اند.',
  'web.bot_buttons_restore_default': 'ترتیب پیش‌فرض',
  'web.bot_buttons_preview_title': 'پیش‌نمایش کیبورد',
  'web.bot_buttons_preview_hint':
    'کیبورد با همین ترتیب و با قابلیت‌هایی که الان روشن‌اند؛ پنل مدیریت برای مدیران زیر آن اضافه می‌شود.',
  'web.bot_buttons_preview_empty': 'با این تنظیمات هیچ دکمه‌ای نمایش داده نمی‌شود.',
  'web.bot_buttons_labels_title': 'متن دکمه‌ها',
  'web.bot_buttons_labels_hint':
    'متن هر دکمه همان چیزی است که مشتری می‌بیند و ربات با همان متن دکمه را می‌شناسد، پس متن دو دکمه نباید یکسان باشد. پس از تغییر متن، کیبورد جدید با پیام بعدی ربات به مشتری می‌رسد و کیبورد قبلی هم همچنان کار می‌کند.',
  'web.bot_buttons_labels_denied':
    'برای دیدن و ویرایش متن دکمه‌ها به دسترسی templates.view نیاز است.',
  'web.bot_buttons_label_duplicate': 'متن این دکمه با دکمهٔ دیگری یکسان است.',
  'web.bot_buttons_stored_invalid':
    'مقدار ذخیره‌شده خوانا نبود؛ ترتیب پیش‌فرض در حال اجراست تا دوباره ذخیره شود.',
  'web.setting_bot_main_menu': 'دکمه‌های منوی اصلی ربات',
  'web.setting_bot_main_menu_desc':
    'ترتیب و نمایش دکمه‌های منوی اصلی ربات؛ در صفحهٔ «دکمه‌های ربات» ویرایش می‌شود.',

  /*
   * The three states a panel read has to say separately, and the eight reasons.
   *
   * Added by the hotfix for order `01a0c54b`, where a panel that was ACTIVE,
   * HEALTHY and had free capacity was sold onto while it had no Marzban
   * activation configured at all. The operator's screen showed two greens and
   * nothing that said the panel could not create anything.
   *
   * Every reason has a LABEL and a HELP line, and the help names a screen or a
   * button rather than restating the problem. "This panel cannot take orders" is
   * what the legacy system says.
   */
  'web.panel_sellability_title': 'قابلیت فروش',
  'web.panel_sellability_hint':
    'سلامت اتصال، کامل‌بودن پیکربندی و قابل‌فروش‌بودن سه چیز جداگانه‌اند. سبزبودن سلامت به‌تنهایی یعنی پنل پاسخ می‌دهد، نه اینکه می‌تواند سرویس بسازد.',
  'web.panel_sellable': 'قابل فروش',
  'web.panel_sellable_yes': 'بله',
  'web.panel_sellable_no': 'خیر',
  'web.panel_activation_state': 'پیکربندی ارائه‌دهنده',
  'web.panel_activation_complete': 'کامل',
  'web.panel_activation_incomplete': 'ناقص',
  'web.panel_connection_validated': 'تست اتصال',
  'web.panel_connection_validated_yes': 'با همین پیکربندی موفق بوده',
  'web.panel_connection_validated_no': 'برای پیکربندی فعلی انجام نشده',
  'web.panel_activation_missing': 'فیلدهای ناقص',
  'web.panel_activation': 'پیکربندی ارائه‌دهنده',
  'web.panel_activation_invalid': 'این مقادیر با طرح ارائه‌دهنده سازگار نیستند:',
  'web.panel_proxy_protocols': 'پروتکل‌ها',
  'web.panel_proxy_protocols_hint':
    'پروتکل‌هایی که برای هر کاربر ساخته می‌شوند. دست‌کم یکی لازم است؛ کاربری بدون پروتکل به هیچ‌جا وصل نمی‌شود.',
  'web.panel_inbound_tags': 'تگ‌های ورودی',
  'web.panel_inbound_tags_hint':
    'با ویرگول جدا کنید. برای هر پروتکل انتخاب‌شده دست‌کم یک تگ لازم است. اگر خالی بماند، مرزبان همهٔ ورودی‌های آن پروتکل را حذف می‌کند و مشتری اشتراکی خالی می‌گیرد — پیش‌فرضی وجود ندارد و ساخته هم نمی‌شود.',
  'web.panel_subscription_domain': 'دامنهٔ اشتراک',
  'web.panel_subscription_domain_hint':
    'میزبانی که /sub/ را سرو می‌کند؛ در صورت نیاز با پورت. این همان آدرس پنل نیست.',
  'web.panel_inbound_id': 'شناسهٔ ورودی',
  'web.panel_inbound_id_hint': 'ورودی‌ای که کلاینت ساخته‌شده به آن اضافه می‌شود. یک عدد صحیح مثبت.',
  'web.panel_reason_archived': 'بایگانی شده',
  'web.panel_reason_archived_help':
    'این پنل بایگانی شده است. محصولی که هنوز به آن اشاره می‌کند باید به پنل دیگری منتقل شود.',
  'web.panel_reason_disabled': 'غیرفعال',
  'web.panel_reason_disabled_help':
    'شما این پنل را غیرفعال کرده‌اید. تا زمانی که دوباره فعال نشود فروشی روی آن انجام نمی‌شود.',
  'web.panel_reason_unhealthy': 'ناسالم',
  'web.panel_reason_unhealthy_help':
    'چند بررسی پیاپی و تازه شکست خورده‌اند. آدرس و اعتبارنامه‌ها را بررسی کنید و تست اتصال بگیرید.',
  'web.panel_reason_at_capacity': 'پر شده',
  'web.panel_reason_at_capacity_help':
    'سقف سرویس‌های این پنل پر است. سقف را بالا ببرید یا روی پنل دیگری بفروشید.',
  'web.panel_reason_activation_incomplete': 'پیکربندی ناقص',
  'web.panel_reason_activation_incomplete_help':
    'فیلدهای لازم ارائه‌دهنده تکمیل نشده‌اند. همین صفحه، بخش «پیکربندی ارائه‌دهنده».',
  'web.panel_reason_credentials_missing': 'اعتبارنامه ناقص',
  'web.panel_reason_credentials_missing_help':
    'اعتبارنامه‌هایی که این ارائه‌دهنده لازم دارد ثبت نشده‌اند. همین صفحه، بخش اعتبارنامه‌ها.',
  'web.panel_reason_provision_unsupported': 'ساخت سرویس پشتیبانی نمی‌شود',
  'web.panel_reason_provision_unsupported_help':
    'این نسخه برای این ارائه‌دهنده کدی برای ساخت کاربر ندارد. با تنظیمات درست نمی‌شود؛ نیازمند نسخهٔ جدید است.',
  'web.panel_reason_unvalidated': 'تست اتصال انجام نشده',
  'web.panel_reason_unvalidated_help':
    'برای پیکربندی فعلی هیچ تست اتصال موفقی ثبت نشده است. دکمهٔ «تست اتصال» در همین صفحه کافی است.',
  // --- Discounts, cashback rules and the price preview (WP8) ----------------
  /*
   * The page that replaced the `/discounts` placeholder. Every figure on it is the
   * server's; the copy says what the server does with it — a rule is created inactive,
   * nothing is deleted, the limits are decided against LIVE redemptions, and cashback
   * is a later wallet credit rather than a lower price.
   */
  // --- Round N, C1: campaigns («کمپین‌ها») ---
  'web.nav_campaigns': 'کمپین‌ها',
  'web.campaigns_title': 'کمپین‌ها',
  'web.campaigns_intro':
    'یک کمپین ابزارهای موجود را با هم به کار می‌گیرد: تخفیف و کش‌بک از موتور قیمت‌گذاری، هدیهٔ کیف پول و حجم و زمان از عملیات گروهی، و پیام از ارسال همگانی.',
  'web.campaign_semantics_title': 'کمپین چه کاری می‌کند و چه کاری نمی‌کند',
  'web.campaign_semantics_audience':
    'مخاطبان کمپین کسانی هستند که پیام و هدیه را دریافت می‌کنند. تخفیف و کش‌بک طبق قواعد خودشان (محصول، دسته، نوع خرید) برای همهٔ خریداران واجد شرایط اعمال می‌شوند، نه فقط برای مخاطبان.',
  'web.campaign_semantics_cancel':
    'لغو کمپین فقط کارهای آینده را متوقف می‌کند. تخفیف‌های ثبت‌شده، کش‌بک وعده‌داده یا پرداخت‌شده، مبالغ واریزشده، حجم و زمان اعمال‌شده و پیام‌های ارسال‌شده برگردانده نمی‌شوند.',
  'web.campaign_semantics_results':
    'نتایج فقط از رکوردهای ثبت‌شده خوانده می‌شوند. سیستم ادعا نمی‌کند که فروشی «به خاطر» کمپین انجام شده است.',
  'web.campaign_new': 'کمپین جدید',
  'web.campaign_name': 'نام کمپین',
  'web.campaign_description': 'توضیح داخلی',
  'web.campaign_description_hint': 'فقط برای مدیران؛ به مشتری نشان داده نمی‌شود.',
  'web.campaign_window': 'بازهٔ اجرا',
  'web.campaign_window_hint': 'تاریخ‌ها با تقویم و ساعت همین فروشگاه خوانده می‌شوند:',
  'web.campaign_calendar_jalali': 'تقویم شمسی',
  'web.campaign_calendar_gregorian': 'تقویم میلادی',
  'web.campaign_date_format': 'تاریخ به شکل سال-ماه-روز، مثلاً 1405-07-10',
  'web.campaign_start': 'شروع',
  'web.campaign_end': 'پایان',
  'web.campaign_actions': 'اقدامات',
  'web.campaign_action': 'اقدام',
  'web.campaign_actions_hint':
    'هر اقدام رکورد خودش را در موتور مربوط دارد؛ وضعیت واقعی همان‌جا ثبت می‌شود.',
  'web.campaign_no_actions': 'بدون اقدام',
  'web.campaign_audience_confirmed': 'مخاطبان تأییدشده',
  'web.campaign_not_confirmed': 'هنوز تأیید نشده',
  'web.campaign_filter_all': 'همه',
  'web.campaign_empty': 'هنوز کمپینی ساخته نشده است.',
  'web.campaign_empty_hint':
    'با «کمپین جدید» یک پیش‌نویس بسازید؛ تا تأیید نکنید چیزی اجرا نمی‌شود.',
  'web.campaign_state_draft': 'پیش‌نویس',
  'web.campaign_state_scheduled': 'زمان‌بندی‌شده',
  'web.campaign_state_active': 'فعال',
  'web.campaign_state_paused': 'متوقف موقت',
  'web.campaign_state_completed': 'پایان‌یافته',
  'web.campaign_state_cancelled': 'لغوشده',
  'web.campaign_action_discount': 'تخفیف',
  'web.campaign_action_cashback': 'کش‌بک',
  'web.campaign_action_wallet_gift': 'هدیهٔ کیف پول',
  'web.campaign_action_traffic_gift': 'هدیهٔ حجم',
  'web.campaign_action_time_gift': 'هدیهٔ زمان',
  'web.campaign_action_announcement': 'پیام اطلاع‌رسانی',
  'web.campaign_action_state_pending': 'در انتظار',
  'web.campaign_action_state_launched': 'سپرده‌شده',
  'web.campaign_action_state_cancelled': 'لغوشده',
  'web.campaign_action_state_failed': 'ناموفق',
  'web.campaign_action_on': 'این اقدام در کمپین باشد',
  'web.campaign_section_identity': 'مشخصات',
  'web.campaign_section_audience': 'مخاطبان',
  'web.campaign_audience_hint':
    'همان مخاطب‌سازی ارسال همگانی و عملیات گروهی. تعداد دقیق پیش از تأیید نمایش داده می‌شود.',
  'web.campaign_audience_status': 'وضعیت حساب',
  'web.campaign_audience_status_active': 'فقط کاربران فعال',
  'web.campaign_audience_status_blocked': 'فقط کاربران مسدود',
  'web.campaign_audience_any': 'فرقی نمی‌کند',
  'web.campaign_audience_purchase': 'سابقهٔ خرید',
  'web.campaign_audience_purchased': 'خرید داشته‌اند',
  'web.campaign_audience_never_purchased': 'خرید نداشته‌اند',
  'web.campaign_audience_segment': 'گروه کاربری',
  'web.campaign_audience_segment_all': 'همه',
  'web.campaign_audience_segment_ordinary': 'فقط کاربران عادی',
  'web.campaign_audience_segment_tiers': 'فقط نمایندگان سطح‌های انتخابی',
  'web.campaign_audience_segment_ordinary_and_tiers': 'کاربران عادی و نمایندگان سطح‌های انتخابی',
  'web.campaign_audience_tiers': 'سطح‌های نمایندگی',
  'web.campaign_audience_trial': 'سرویس تست',
  'web.campaign_audience_trial_used': 'تست گرفته‌اند',
  'web.campaign_audience_trial_not_used': 'تست نگرفته‌اند',
  'web.campaign_audience_referral': 'زیرمجموعه‌گیری',
  'web.campaign_audience_referral_participant': 'در طرح معرفی شرکت دارند',
  'web.campaign_audience_referral_non_participant': 'در طرح معرفی شرکت ندارند',
  'web.campaign_audience_referral_referrer': 'کسی را معرفی کرده‌اند',
  'web.campaign_audience_referral_referred': 'معرفی‌شده هستند',
  'web.campaign_audience_no_purchase_days': 'بدون خرید در چند روز اخیر',
  'web.campaign_audience_no_purchase_days_hint': 'خالی یعنی این شرط اعمال نشود.',
  'web.campaign_audience_service_on': 'فقط کاربرانی که سرویس با شرایط زیر دارند',
  'web.campaign_audience_products': 'محصول سرویس',
  'web.campaign_audience_panels': 'سرور (پنل) سرویس',
  'web.campaign_audience_expiring_hours': 'انقضا تا چند ساعت دیگر',
  'web.campaign_audience_expiring_hours_hint': 'خالی یعنی این شرط اعمال نشود.',
  'web.campaign_audience_expired': 'سرویس منقضی‌شده',
  'web.campaign_none_available': 'موردی برای انتخاب نیست.',
  'web.campaign_discount_hint':
    'یک قاعدهٔ تخفیف در همان موتور تخفیف‌ها ساخته می‌شود و بازهٔ اجرای آن دقیقاً بازهٔ کمپین است.',
  'web.campaign_discount_kind': 'نحوهٔ اعمال',
  'web.campaign_discount_automatic': 'خودکار برای همهٔ خریدهای واجد شرایط',
  'web.campaign_discount_code': 'کد تخفیف',
  'web.campaign_code_hint': 'حروف و ارقام انگلیسی، خط تیره یا زیرخط؛ ۳ تا ۴۰ نویسه.',
  'web.campaign_discount_type': 'نوع تخفیف',
  'web.campaign_discount_percentage': 'درصدی',
  'web.campaign_discount_fixed': 'مبلغ ثابت',
  'web.campaign_discount_value': 'مقدار',
  'web.campaign_percent_hint': 'عدد صحیح از ۱ تا ۱۰۰',
  'web.campaign_amount_hint': 'مبلغ به کوچک‌ترین واحد پول:',
  'web.campaign_purposes': 'نوع خرید',
  'web.campaign_scope': 'محدوده',
  'web.campaign_scope_all': 'همهٔ محصولات',
  'web.campaign_scope_product': 'یک محصول',
  'web.campaign_scope_category': 'یک دسته',
  'web.campaign_choose': 'انتخاب کنید',
  'web.campaign_discount_minimum': 'حداقل مبلغ سفارش',
  'web.campaign_discount_total_limit': 'سقف کل استفاده',
  'web.campaign_discount_per_customer': 'سقف استفادهٔ هر مشتری',
  'web.campaign_limit_hint': 'خالی یعنی بدون سقف.',
  'web.campaign_discount_first_purchase': 'فقط برای خرید اول',
  'web.campaign_discount_stackable': 'قابل جمع با تخفیف‌های دیگر',
  'web.campaign_cashback_hint':
    'یک قاعدهٔ کش‌بک در همان موتور کش‌بک ساخته می‌شود؛ مبلغ پس از تحویل سرویس به کیف پول واریز می‌شود.',
  'web.campaign_cashback_percent': 'درصد کش‌بک',
  'web.campaign_section_gifts': 'هدیه‌ها',
  'web.campaign_gifts_hint':
    'هدیه‌ها با عملیات گروهی اجرا می‌شوند: فهرست دریافت‌کنندگان هنگام تأیید ثابت می‌شود و اجرا از زمان شروع کمپین آغاز می‌شود.',
  'web.campaign_wallet_amount': 'مبلغ هدیه برای هر نفر',
  'web.campaign_notify': 'به دریافت‌کننده اطلاع داده شود',
  'web.campaign_traffic_gb': 'حجم هدیه (گیگابایت)',
  'web.campaign_traffic_hint': 'حداکثر دو رقم اعشار',
  'web.campaign_time_days': 'زمان هدیه (روز)',
  'web.campaign_service_gift_hint':
    'حجم و زمان فقط روی سرویس‌های موجود و قابل‌اجرای مخاطبان اعمال می‌شود؛ اگر شرط سرویس در مخاطبان تعیین شده باشد، همان سرویس‌ها انتخاب می‌شوند.',
  'web.campaign_announcement_hint':
    'پیام با ارسال همگانی و در زمان شروع کمپین فرستاده می‌شود. شکست ارسال پیام هیچ اقدام مالی را برنمی‌گرداند.',
  'web.campaign_announcement_body': 'متن پیام',
  'web.campaign_placeholders': 'متغیرهای مجاز: {firstName}، {username}، {walletBalance}',
  'web.campaign_button_label': 'متن دکمه',
  'web.campaign_button_url': 'پیوند دکمه',
  'web.campaign_button_add': 'افزودن دکمه',
  'web.campaign_button_remove': 'حذف دکمه',
  'web.campaign_referral_note':
    'پاداش زیرمجموعه‌گیری در کمپین قابل تنظیم نیست: شرایط معرفی برای کل فروشگاه است و در تنظیمات تغییر می‌کند.',
  'web.campaign_save_draft': 'ذخیرهٔ پیش‌نویس',
  'web.campaign_save_hint': 'ذخیره هیچ اقدامی را اجرا نمی‌کند؛ پس از بررسی پیش‌نمایش تأیید کنید.',
  'web.campaign_saved': 'پیش‌نویس ذخیره شد.',
  'web.campaign_edit': 'ویرایش پیش‌نویس',
  'web.campaign_section_summary': 'خلاصه',
  'web.campaign_scheduled_at': 'زمان تأیید',
  'web.campaign_cancelled_at': 'زمان لغو',
  'web.campaign_terms': 'شرایط',
  'web.campaign_engine_record': 'رکورد اجرا',
  'web.campaign_open_rules': 'در صفحهٔ تخفیف‌ها',
  'web.campaign_engine_broadcast': 'در ارسال همگانی',
  'web.campaign_engine_bulk': 'در عملیات گروهی',
  'web.campaign_days': 'روز',
  'web.campaign_section_preview': 'پیش‌نمایش و تأیید',
  'web.campaign_preview_hint':
    'تأیید دقیقاً به همین ارقام بسته است؛ اگر پیش از تأیید چیزی تغییر کند، تأیید رد می‌شود و باید دوباره بررسی کنید.',
  'web.campaign_preview_audience': 'تعداد مخاطبان',
  'web.campaign_preview_reachable': 'قابل پیام‌رسانی',
  'web.campaign_preview_discount_max': 'حداکثر هزینهٔ تخفیف',
  'web.campaign_not_determinable': 'از پیش قابل محاسبه نیست (به سفارش‌های آینده بستگی دارد)',
  'web.campaign_preview_wallet_count': 'تعداد دریافت‌کنندگان هدیهٔ کیف پول',
  'web.campaign_preview_wallet_total': 'تعهد مالی کل هدیهٔ کیف پول',
  'web.campaign_preview_traffic_count': 'تعداد سرویس‌های هدیهٔ حجم',
  'web.campaign_preview_time_count': 'تعداد سرویس‌های هدیهٔ زمان',
  'web.campaign_preview_sample': 'نمونه:',
  'web.campaign_type_count': 'برای تأیید، تعداد را تایپ کنید',
  'web.campaign_type_count_hint': 'عدد مورد انتظار:',
  'web.campaign_reviewed': 'پیش‌نمایش را بررسی کردم و اجرای کمپین را تأیید می‌کنم',
  'web.campaign_confirm': 'تأیید و زمان‌بندی',
  'web.campaign_scheduled': 'کمپین زمان‌بندی شد.',
  'web.campaign_section_commands': 'مدیریت اجرا',
  'web.campaign_cancel_hint':
    'توقف موقت تخفیف و کش‌بک و پیام را متوقف می‌کند؛ هدیه‌ای که اجرایش شروع شده تا پایان فهرست ثابت خود ادامه می‌یابد.',
  'web.campaign_pause': 'توقف موقت',
  'web.campaign_resume': 'ادامه',
  'web.campaign_launch_pending': 'سپردن دوبارهٔ اقدامات در انتظار',
  'web.campaign_cancel': 'لغو کمپین',
  'web.campaign_cancel_confirm_title': 'لغو کمپین',
  'web.campaign_cancel_confirm_body':
    'کارهای انجام‌نشده متوقف می‌شوند. هیچ تخفیف ثبت‌شده، کش‌بک، واریز، هدیهٔ اعمال‌شده یا پیام ارسال‌شده‌ای برگردانده نمی‌شود.',
  'web.campaign_cancel_confirm': 'بله، لغو شود',
  'web.campaign_cancel_keep': 'منصرف شدم',
  'web.campaign_command_done': 'انجام شد.',
  'web.campaign_section_results': 'نتایج',
  'web.campaign_results_hint':
    'فقط واقعیت‌های ثبت‌شده: سفارش‌هایی که از تخفیف همین کمپین استفاده کرده‌اند و کش‌بک‌های همین کمپین. «درآمد ناشی از کمپین» محاسبه نمی‌شود.',
  'web.campaign_results_targeted': 'مخاطبان هدف',
  'web.campaign_results_redemptions': 'سفارش‌های دارای تخفیف کمپین',
  'web.campaign_results_cashback': 'کش‌بک‌های کمپین',
  'web.campaign_results_cashback_reversed': 'کش‌بک برگشت‌خورده با استرداد',
  'web.campaign_results_credited': 'مبلغ واریزشده',
  'web.campaign_none_yet': 'هنوز موردی نیست',
  'web.campaign_order_awaiting_payment': 'در انتظار پرداخت',
  'web.campaign_order_paid': 'پرداخت‌شده',
  'web.campaign_order_refunded': 'مسترد',
  'web.campaign_order_cancelled': 'لغوشده',
  'web.campaign_order_expired': 'منقضی',
  'web.campaign_cashback_pending': 'وعده‌داده‌شده',
  'web.campaign_cashback_earned': 'واریزشده',
  'web.campaign_cashback_void': 'باطل',
  'web.campaign_sent': 'ارسال‌شده',
  'web.campaign_failed': 'ناموفق',
  'web.campaign_unconfirmed': 'نامعلوم',
  'web.campaign_pending': 'در صف',
  'web.campaign_cancelled_count': 'لغوشده',
  'web.campaign_done': 'انجام‌شده',
  'web.campaign_skipped': 'ردشده',
  'web.campaign_problem_name': 'نام کمپین را بنویسید.',
  'web.campaign_problem_date': 'تاریخ شروع و پایان را به شکل سال-ماه-روز بنویسید.',
  'web.campaign_problem_days': 'تعداد روز معتبر نیست.',
  'web.campaign_problem_hours': 'تعداد ساعت معتبر نیست.',
  'web.campaign_problem_tiers': 'دست‌کم یک سطح نمایندگی انتخاب کنید.',
  'web.campaign_problem_value': 'مقدار یا مبلغ معتبر نیست.',
  'web.campaign_problem_purposes': 'دست‌کم یک نوع خرید انتخاب کنید.',
  'web.campaign_problem_product': 'محصول را انتخاب کنید.',
  'web.campaign_problem_category': 'دسته را انتخاب کنید.',
  'web.campaign_problem_limit': 'سقف استفاده باید عدد صحیح مثبت باشد.',
  'web.campaign_problem_code': 'کد تخفیف معتبر نیست.',
  'web.campaign_problem_percent': 'درصد کش‌بک باید عددی از ۱ تا ۱۰۰ باشد.',
  'web.campaign_problem_traffic': 'حجم معتبر نیست.',
  'web.campaign_problem_body': 'متن پیام را بنویسید.',
  'web.campaign_error_not_editable':
    'فقط پیش‌نویس قابل ویرایش است. کمپین را لغو کنید و کمپین تازه بسازید.',
  'web.campaign_error_transition': 'وضعیت کمپین تغییر کرده است. صفحه را تازه کنید.',
  'web.campaign_error_window': 'بازهٔ اجرا معتبر نیست یا گذشته است.',
  'web.campaign_error_no_action': 'دست‌کم یک اقدام به کمپین اضافه کنید.',
  'web.campaign_error_typed_count': 'تعداد تایپ‌شده با تعداد پیش‌نمایش برابر نیست.',
  'web.campaign_error_changed':
    'مخاطبان یا ارقام پس از پیش‌نمایش تغییر کرده‌اند. دوباره بررسی و تأیید کنید.',
  'web.campaign_error_empty': 'این انتخاب هیچ دریافت‌کننده‌ای ندارد.',
  'web.campaign_error_audience': 'تعریف مخاطبان معتبر نیست.',
  'web.campaign_error_code_taken': 'این کد تخفیف پیش‌تر استفاده شده است.',
  'web.campaign_error_body': 'متن پیام متغیری دارد که پشتیبانی نمی‌شود.',
  'web.discounts_title': 'تخفیف‌ها و کش‌بک',
  'web.discounts_intro':
    'قاعده‌های تخفیف، قاعده‌های کش‌بک، و پیش‌نمایش قیمت با همان موتوری که ربات هنگام خرید به کار می‌برد.',
  'web.discounts_rules_title': 'قاعده‌های تخفیف',
  'web.discounts_rules_hint':
    'قاعده‌ها به ترتیب اولویت بررسی می‌شوند، بزرگ‌تر اول. هر قاعده غیرفعال ساخته می‌شود و با دکمهٔ جداگانه فعال می‌شود.',
  'web.discounts_empty': 'هنوز قاعدهٔ تخفیفی ثبت نشده است.',
  'web.discounts_empty_hint':
    'قاعده‌ای که بسازید اینجا دیده می‌شود؛ تا فعالش نکنید روی هیچ سفارشی اثر ندارد.',
  'web.discounts_filter_empty': 'قاعده‌ای با این صافی پیدا نشد.',
  'web.discounts_scope_title': 'قاعده‌هایی که این صفحه رعایت می‌کند',
  'web.discounts_rule_no_delete':
    'هیچ قاعده‌ای حذف نمی‌شود: سفارش‌ها و استفاده‌های ثبت‌شده به آن اشاره می‌کنند. برای کنار گذاشتن یک قاعده، غیرفعالش کنید.',
  'web.discounts_rule_usage':
    '«استفادهٔ فعال» شمار استفاده‌هایی است که سفارششان در انتظار پرداخت یا پرداخت‌شده است، و سقف‌ها با همین عدد سنجیده می‌شوند. سفارشی که لغو، منقضی یا بازپرداخت شود، استفاده‌اش را آزاد می‌کند.',
  'web.discounts_rule_cashback':
    'کش‌بک از مبلغ پرداختی کم نمی‌کند. پس از تحویل سفارش به کیف پول مشتری واریز می‌شود، اگر سفارش بدون تحویل پایان یابد باطل می‌شود، و بازپرداخت بخشی از پول همان نسبت از آن را برمی‌گرداند. برگشتی که موجودی کیف پول پوشش ندهد «وصول‌نشده» ثبت می‌شود و هرگز از مشتری مطالبه نمی‌شود.',

  'web.discount_kind': 'نوع',
  'web.discount_kind_all': 'همهٔ انواع',
  'web.discount_kind_code': 'کد تخفیف',
  'web.discount_kind_automatic': 'خودکار',
  'web.discount_kind_hint':
    'کد فقط وقتی اعمال می‌شود که مشتری آن را وارد کند. قاعدهٔ خودکار بدون کد روی هر سفارشی که شرایطش را دارد اعمال می‌شود.',
  'web.discount_kind_locked':
    'نوع و کد پس از ساخت تغییر نمی‌کنند: کدی که به مشتری داده شده باید همچنان همین قاعده را معنی دهد.',
  'web.discount_code': 'کد',
  'web.discount_code_hint':
    'حروف لاتین، رقم، خط تیره یا زیرخط؛ ۳ تا ۴۰ نویسه. بزرگی و کوچکی حروف فرقی نمی‌کند.',
  'web.discount_type': 'شیوهٔ محاسبه',
  'web.discount_type_percentage': 'درصدی',
  'web.discount_type_fixed': 'مبلغ ثابت',
  'web.discount_value': 'مقدار',
  'web.discount_value_hint_percentage': 'درصد صحیح از ۱ تا ۱۰۰.',
  'web.discount_value_hint_fixed': 'مبلغ صحیح به کوچک‌ترین واحد پولِ انتخاب‌شده.',
  'web.discount_percent_unit': 'درصد',
  'web.discount_currency': 'واحد پول',
  'web.discount_customer': 'مشتری',
  'web.discount_customer_hint':
    'اختیاری. شناسهٔ داخلی مشتری، نه شناسهٔ تلگرام. خالی یعنی همهٔ مشتریان.',
  'web.discount_first_purchase': 'فقط خرید نخست',
  'web.discount_first_purchase_hint':
    'فقط وقتی مجاز است که کاربرد قاعده تنها «خرید سرویس جدید» باشد.',
  'web.discount_minimum': 'حداقل مبلغ سفارش',
  'web.discount_minimum_hint': 'اختیاری. به کوچک‌ترین واحد پول سفارش؛ خالی یعنی بدون حداقل.',
  'web.discount_usage': 'استفادهٔ فعال',
  'web.discount_usage_of': 'از',
  'web.discount_unlimited': 'بی‌سقف',
  'web.discount_per_customer': 'هر مشتری',
  'web.discount_total_limit': 'سقف کل استفاده',
  'web.discount_per_customer_limit': 'سقف استفادهٔ هر مشتری',
  'web.discount_limit_hint': 'اختیاری. عدد صحیح بزرگ‌تر از صفر؛ خالی یعنی بی‌سقف.',
  'web.discount_priority': 'اولویت',
  'web.discount_priority_hint': 'عدد صحیح از ۰ تا ۱۰۰۰؛ بزرگ‌تر زودتر بررسی می‌شود.',
  'web.discount_stackable': 'قابل ترکیب',
  'web.discount_exclusive': 'غیرقابل ترکیب',
  'web.discount_stackable_hint': 'قاعدهٔ غیرقابل ترکیب با قاعدهٔ دیگری روی یک سفارش جمع نمی‌شود.',
  'web.discount_new_title': 'قاعدهٔ تخفیف جدید',
  'web.discount_edit_title': 'ویرایش قاعدهٔ تخفیف',
  'web.discount_create': 'ساخت قاعده',
  'web.discount_created': 'قاعدهٔ تخفیف ساخته شد. تا فعالش نکنید اثری ندارد.',
  'web.discount_saved': 'قاعدهٔ تخفیف ذخیره شد.',
  'web.discount_activated': 'قاعدهٔ تخفیف فعال شد.',
  'web.discount_deactivated': 'قاعدهٔ تخفیف غیرفعال شد.',
  'web.discount_edit_denied':
    'ساخت، ویرایش و فعال‌سازی قاعدهٔ تخفیف به دسترسی catalog.discounts.edit نیاز دارد.',
  'web.discount_problem_code': 'کد باید ۳ تا ۴۰ نویسه از حروف لاتین، رقم، خط تیره یا زیرخط باشد.',
  'web.discount_problem_value_percentage': 'درصد باید عددی صحیح از ۱ تا ۱۰۰ باشد.',
  'web.discount_problem_value_fixed': 'مبلغ باید عددی صحیح و بزرگ‌تر از صفر باشد.',
  'web.discount_problem_customer': 'شناسهٔ مشتری معتبر نیست.',
  'web.discount_problem_first_purchase':
    'قاعدهٔ خرید نخست فقط برای «خرید سرویس جدید» است و کاربرد دیگری نمی‌پذیرد.',
  'web.discount_problem_minimum': 'حداقل مبلغ باید عددی صحیح باشد یا خالی بماند.',
  'web.discount_problem_limit': 'سقف استفاده باید عددی صحیح و بزرگ‌تر از صفر باشد یا خالی بماند.',
  'web.discount_problem_priority': 'اولویت باید عددی صحیح از ۰ تا ۱۰۰۰ باشد.',

  'web.cashback_rules_title': 'قاعده‌های کش‌بک',
  'web.cashback_rules_hint':
    'کش‌بک از مبلغ پرداختی کم نمی‌کند؛ درصدی از مبلغ نهایی است که پس از تحویل سفارش به کیف پول مشتری واریز می‌شود.',
  'web.cashback_empty': 'هنوز قاعدهٔ کش‌بکی ثبت نشده است.',
  'web.cashback_percent': 'درصد کش‌بک',
  'web.cashback_percent_hint': 'درصد صحیح از ۱ تا ۱۰۰ از مبلغ نهایی سفارش؛ رو به پایین گرد می‌شود.',
  'web.cashback_new_title': 'قاعدهٔ کش‌بک جدید',
  'web.cashback_edit_title': 'ویرایش قاعدهٔ کش‌بک',
  'web.cashback_create': 'ساخت قاعدهٔ کش‌بک',
  'web.cashback_created': 'قاعدهٔ کش‌بک ساخته شد. تا فعالش نکنید اثری ندارد.',
  'web.cashback_saved': 'قاعدهٔ کش‌بک ذخیره شد.',
  'web.cashback_activated': 'قاعدهٔ کش‌بک فعال شد.',
  'web.cashback_deactivated': 'قاعدهٔ کش‌بک غیرفعال شد.',
  'web.cashback_edit_denied':
    'ساخت، ویرایش و فعال‌سازی قاعدهٔ کش‌بک به دسترسی catalog.pricing.edit نیاز دارد.',
  'web.cashback_problem_percent': 'درصد کش‌بک باید عددی صحیح از ۱ تا ۱۰۰ باشد.',

  /* Shared by the two rule tables and the two forms. */
  'web.rule_label': 'عنوان',
  'web.rule_label_hint': 'نامی که اپراتور می‌بیند و در ردِ قیمت هر سفارش ثبت می‌شود.',
  'web.rule_status_all': 'همهٔ وضعیت‌ها',
  'web.rule_status_active': 'فعال',
  'web.rule_status_inactive': 'غیرفعال',
  'web.rule_applies_to': 'کاربرد برای',
  'web.rule_scope': 'دامنه',
  'web.rule_scope_kind': 'محدود به',
  'web.rule_scope_all': 'همهٔ محصولات',
  'web.rule_scope_product': 'محصول',
  'web.rule_scope_category': 'دسته',
  'web.rule_scope_hint': 'یک قاعده به یک محصول یا به یک دسته محدود می‌شود، نه هر دو.',
  'web.rule_product_unreadable': 'فهرست کامل محصولات در دسترس نیست؛ شناسهٔ محصول را وارد کنید.',
  'web.rule_category_unreadable': 'فهرست دسته‌ها در دسترس نیست؛ شناسهٔ دسته را وارد کنید.',
  'web.rule_window': 'بازهٔ زمانی',
  'web.rule_window_always': 'همیشه',
  'web.rule_window_from': 'از',
  'web.rule_window_until': 'تا',
  'web.rule_starts_at': 'شروع',
  'web.rule_ends_at': 'پایان',
  'web.rule_window_hint': 'اختیاری، به وقت مرورگر شما. خالی یعنی بدون مرز.',
  'web.rule_actions': 'عملیات',
  'web.rule_edit': 'ویرایش',
  'web.rule_activate': 'فعال کردن',
  'web.rule_deactivate': 'غیرفعال کردن',
  'web.rule_save': 'ذخیره',
  'web.rule_cancel_edit': 'انصراف',
  'web.rule_created_inactive':
    'قاعدهٔ تازه غیرفعال ساخته می‌شود و تا فعالش نکنید روی هیچ سفارشی اثر ندارد.',
  'web.rule_problem_label': 'عنوان نمی‌تواند خالی یا بلندتر از ۸۰ نویسه باشد.',
  'web.rule_problem_applies_to': 'دست‌کم یک کاربرد را انتخاب کنید.',
  'web.rule_problem_product': 'یک محصول انتخاب کنید یا شناسهٔ معتبرش را وارد کنید.',
  'web.rule_problem_category': 'یک دسته انتخاب کنید یا شناسهٔ معتبرش را وارد کنید.',
  'web.rule_problem_window': 'زمان شروع یا پایان معتبر نیست.',
  'web.rule_problem_window_order': 'پایان بازه باید پس از شروع آن باشد.',

  'web.purpose_new_service': 'خرید سرویس جدید',
  'web.purpose_renew': 'تمدید',
  'web.purpose_add_traffic': 'افزایش حجم',
  'web.purpose_add_time': 'افزایش زمان',
  'web.purpose_add_devices': 'افزایش کاربر / دستگاه',
  'web.purpose_change_location': 'تغییر لوکیشن',
  // WP-A5: the extra users / devices rate — an `ADD_DEVICES` add-on, in operator words.
  'web.extra_devices_title': 'افزایش کاربر / دستگاه',
  'web.extra_devices_subtitle':
    'قیمت هر کاربر یا دستگاه اضافه که مشتری برای سرویس فعلی خود می‌خرد، و حداکثر تعدادی که یک سرویس می‌تواند بخرد.',
  'web.extra_devices_no_capable_panel':
    'در این نسخه هیچ‌یک از انواع پنل پشتیبانی‌شده امکان افزایش تعداد کاربر یک سرویس موجود را ندارد. تعرفه‌ای که اینجا ذخیره کنید تا وقتی پنلی با این قابلیت وصل نشود به هیچ مشتری‌ای نمایش داده نمی‌شود.',
  'web.extra_devices_capable_panels':
    'دکمهٔ «افزایش کاربر / دستگاه» فقط برای سرویس‌هایی نمایش داده می‌شود که روی این نوع پنل‌ها هستند: {providers}',
  'web.extra_devices_rates': 'تعرفه‌ها',
  'web.extra_devices_empty': 'هنوز تعرفه‌ای تعریف نشده است',
  'web.extra_devices_empty_hint':
    'بدون تعرفهٔ فعال و قیمت‌دار، دکمهٔ افزایش کاربر به مشتری نمایش داده نمی‌شود.',
  'web.extra_devices_rate_title': 'عنوان',
  'web.extra_devices_unit_price': 'قیمت هر کاربر',
  'web.extra_devices_unit_price_hint':
    'مبلغ یک کاربر یا دستگاه اضافه. مبلغ نهایی برابر است با این قیمت ضرب در تعدادی که مشتری انتخاب می‌کند.',
  'web.extra_devices_unpriced': 'بدون قیمت',
  'web.extra_devices_currency': 'واحد پول',
  'web.extra_devices_max_quantity': 'حداکثر قابل خرید',
  'web.extra_devices_max_quantity_hint':
    'بیشترین تعداد کاربر اضافه‌ای که یک سرویس روی هم می‌تواند بخرد؛ عددی بین ۱ تا {max}.',
  'web.extra_devices_scope': 'پنل / محصول',
  'web.extra_devices_scope_panel': 'پنل',
  'web.extra_devices_scope_product': 'محصول',
  'web.extra_devices_scope_hint':
    'اگر برای یک سرویس چند تعرفه صدق کند، تعرفهٔ مخصوص محصول بر تعرفهٔ مخصوص پنل، و آن بر تعرفهٔ عمومی مقدم است.',
  'web.extra_devices_scope_all_panels': 'همهٔ پنل‌ها',
  'web.extra_devices_scope_all_products': 'همهٔ محصولات',
  'web.extra_devices_panel_unsupported': 'این پنل افزایش کاربر را پشتیبانی نمی‌کند',
  'web.extra_devices_scope_unavailable':
    'فهرست کامل پنل‌ها یا محصولات خوانده نشد، پس ممکن است همهٔ گزینه‌ها نمایش داده نشوند. صفحه را دوباره بارگذاری کنید.',
  'web.extra_devices_sort': 'ترتیب',
  'web.extra_devices_state': 'وضعیت',
  'web.extra_devices_active': 'فعال',
  'web.extra_devices_inactive': 'غیرفعال',
  'web.extra_devices_updated': 'آخرین تغییر',
  'web.extra_devices_actions': 'عملیات',
  'web.extra_devices_edit': 'ویرایش',
  'web.extra_devices_enable': 'فعال کردن',
  'web.extra_devices_disable': 'غیرفعال کردن',
  'web.extra_devices_new': 'تعرفهٔ جدید',
  'web.extra_devices_editing': 'ویرایش تعرفه',
  'web.extra_devices_form_hint':
    'تعرفهٔ جدید غیرفعال ساخته می‌شود و با «فعال کردن» به مشتری عرضه می‌شود. تغییر قیمت فقط روی خریدهای بعدی اثر دارد؛ هر سفارش قیمت و نسخهٔ تعرفه‌ای را که با آن خریده شده نگه می‌دارد.',
  'web.extra_devices_save': 'ذخیره',
  'web.extra_devices_cancel_edit': 'انصراف از ویرایش',
  'web.extra_devices_saved': 'تعرفه ذخیره شد.',
  // WP-A6: the service location change — a panel's locations and the price of moving there.
  'web.service_locations_title': 'تغییر لوکیشن سرویس',
  'web.service_locations_subtitle':
    'لوکیشن‌های هر پنل، لوکیشنی که سرویس‌های جدید در آن ساخته می‌شوند، و هزینه و محدودیت انتقال سرویس فعلی مشتری به هر لوکیشن.',
  'web.service_locations_no_capable_panel':
    'در این نسخه هیچ‌یک از انواع پنل پشتیبانی‌شده امکان جابه‌جایی امن سرویس موجود بین لوکیشن‌ها را ندارد. تنظیماتی که اینجا ذخیره کنید تا وقتی پنلی با این قابلیت وصل نشود به هیچ مشتری‌ای نمایش داده نمی‌شود.',
  'web.service_locations_capable_panels':
    'دکمهٔ «🌍 تغییر لوکیشن» فقط برای سرویس‌هایی نمایش داده می‌شود که روی این نوع پنل‌ها هستند: {providers}',
  'web.service_locations_list': 'لوکیشن‌ها',
  'web.service_locations_empty': 'هنوز لوکیشنی تعریف نشده است',
  'web.service_locations_empty_hint':
    'بدون لوکیشن اولیه و دست‌کم یک لوکیشن مقصدِ فعال و قیمت‌دار، تغییر لوکیشن به مشتری پیشنهاد نمی‌شود. تنظیم‌نشده هرگز به معنای رایگان نیست.',
  'web.service_locations_panel': 'پنل',
  'web.service_locations_panel_unsupported': 'این پنل تغییر لوکیشن را پشتیبانی نمی‌کند',
  'web.service_locations_panel_id_hint':
    'فهرست پنل‌ها برای نقش شما خواندنی نیست؛ شناسهٔ پنل را وارد کنید.',
  'web.service_locations_product_id_hint':
    'فهرست محصولات برای نقش شما خواندنی نیست؛ برای همهٔ محصولات خالی بگذارید یا شناسهٔ محصول را وارد کنید.',
  'web.service_locations_product': 'محصول',
  'web.service_locations_all_products': 'همهٔ محصولات این پنل',
  'web.service_locations_product_hint':
    'اگر برای یک لوکیشن هم ردیف عمومی و هم ردیف مخصوص محصول باشد، ردیف مخصوص محصول برای سرویس‌های همان محصول اعمال می‌شود؛ حتی اگر غیرفعال باشد.',
  'web.service_locations_key': 'شناسهٔ لوکیشن در پنل',
  'web.service_locations_key_hint':
    'همان شناسه‌ای که پنل برای این لوکیشن به کار می‌برد. به مشتری نمایش داده نمی‌شود.',
  'web.service_locations_label': 'نام لوکیشن',
  'web.service_locations_label_hint': 'نامی که مشتری در ربات می‌بیند؛ مثلاً «🇩🇪 آلمان».',
  'web.service_locations_initial': 'لوکیشن اولیهٔ سرویس‌های جدید این پنل',
  'web.service_locations_initial_hint':
    'هر پنل یک لوکیشن اولیه دارد. بدون آن، معلوم نیست سرویسی که هنوز جابه‌جا نشده کجاست و تغییر لوکیشن برایش پیشنهاد نمی‌شود.',
  'web.service_locations_enabled': 'به‌عنوان مقصد به مشتری عرضه شود',
  'web.service_locations_price': 'هزینهٔ انتقال',
  'web.service_locations_price_hint':
    'برای انتقال رایگان صفر وارد کنید. خالی یعنی این لوکیشن مقصد فروش نیست.',
  'web.service_locations_free': 'رایگان',
  'web.service_locations_unpriced': 'بدون قیمت',
  'web.service_locations_currency': 'واحد پول',
  'web.service_locations_cooldown': 'فاصلهٔ لازم بین دو تغییر (ساعت)',
  'web.service_locations_cooldown_hint': 'اختیاری. خالی یعنی بدون فاصلهٔ اجباری.',
  'web.service_locations_max_changes': 'حداکثر تعداد تغییر',
  'web.service_locations_period_days': 'در بازهٔ چند روز',
  'web.service_locations_limit_hint':
    'اختیاری و همراه هم؛ مثلاً ۲ تغییر در ۳۰ روز. خالی یعنی بدون سقف.',
  'web.service_locations_limit_pair': 'حداکثر تعداد تغییر و بازهٔ روز را با هم وارد کنید.',
  'web.service_locations_limits': 'محدودیت‌ها',
  'web.service_locations_no_limits': 'بدون محدودیت',
  'web.service_locations_cooldown_value': '{hours} ساعت فاصله',
  'web.service_locations_limit_value': '{max} تغییر در {days} روز',
  'web.service_locations_sort': 'ترتیب',
  'web.service_locations_state': 'وضعیت',
  'web.service_locations_target_on': 'مقصد فعال',
  'web.service_locations_target_off': 'مقصد نیست',
  'web.service_locations_initial_badge': 'اولیه',
  'web.service_locations_updated': 'آخرین تغییر',
  'web.service_locations_actions': 'عملیات',
  'web.service_locations_edit': 'ویرایش',
  'web.service_locations_delete': 'حذف',
  'web.service_locations_new': 'لوکیشن جدید',
  'web.service_locations_editing': 'ویرایش لوکیشن',
  'web.service_locations_form_hint':
    'تغییر قیمت یا محدودیت فقط روی درخواست‌های بعدی اثر دارد؛ هر درخواست نام، قیمت و نسخهٔ لوکیشنی را که با آن ثبت شده نگه می‌دارد. لینک یا اطلاعات اتصال مشتری ممکن است پس از جابه‌جایی تغییر کند؛ در این صورت اطلاعات جدید برایش فرستاده می‌شود.',
  'web.service_locations_save': 'ذخیره',
  'web.service_locations_cancel_edit': 'انصراف از ویرایش',
  'web.service_locations_saved': 'لوکیشن ذخیره شد.',
  'web.service_locations_unchanged': 'تغییری برای ذخیره نبود.',
  'web.service_locations_deleted': 'لوکیشن حذف شد.',
  'web.service_locations_error_in_use':
    'درخواست تغییر لوکیشنی به این لوکیشن اشاره می‌کند و نمی‌توان آن را حذف کرد؛ به‌جای حذف، آن را از مقصدها خارج کنید.',
  'web.service_locations_error_duplicate': 'این پنل برای همین محصول‌ها لوکیشنی با همین شناسه دارد.',
  'web.service_locations_error_second_initial': 'این پنل از قبل یک لوکیشن اولیه دارد.',
  'web.service_locations_error_currency': 'قیمت باید با واحد پول فروش این نصب باشد.',
  'web.service_locations_error_product_panel': 'این محصول روی پنل انتخاب‌شده فروخته نمی‌شود.',
  'web.service_locations_error_panel_full':
    'این پنل به حداکثر تعداد لوکیشن رسیده است (۲۰ ردیف، همراه با ردیف‌های مخصوص محصول).',
  'web.service_locations_error_count': 'به حداکثر تعداد لوکیشن‌های این نصب (۵۰۰) رسیده‌اید.',

  'web.preview_title': 'پیش‌نمایش قیمت',
  'web.preview_hint':
    'با همان موتوری که ربات هنگام خرید به کار می‌برد. چیزی ثبت نمی‌شود، استفاده‌ای شمرده نمی‌شود و قفلی گرفته نمی‌شود.',
  'web.preview_purpose': 'نوع سفارش',
  'web.preview_product': 'محصول',
  'web.preview_addon': 'شناسهٔ افزودنی',
  'web.preview_addon_hint': 'شناسهٔ افزودنیِ حجم یا زمانی که قیمتش را می‌خواهید.',
  'web.preview_customer': 'شناسهٔ مشتری',
  'web.preview_customer_hint':
    'اختیاری. بدون آن، قاعده‌ای که به مشتری بستگی دارد «وابسته به مشتری» گزارش می‌شود و نه پذیرفته و نه رد.',
  'web.preview_code': 'کد تخفیف',
  'web.preview_code_hint': 'اختیاری. همان کدی که مشتری در ربات وارد می‌کند.',
  'web.preview_run': 'محاسبه',
  'web.preview_problem_addon': 'شناسهٔ معتبر افزودنی را وارد کنید.',
  'web.preview_cashback': 'کش‌بک',
  'web.preview_no_cashback': 'هیچ قاعدهٔ کش‌بکی بر این سفارش اعمال نمی‌شود.',
  'web.preview_code_verdict': 'کد واردشده',
  'web.preview_code_accepted': 'پذیرفته شد',
  'web.preview_code_refused': 'پذیرفته نشد',
  'web.preview_rules_title': 'قاعده‌های بررسی‌شده',
  'web.preview_rules_empty': 'هیچ قاعدهٔ تخفیفی نامزد این سفارش نبود.',
  'web.preview_outcome': 'نتیجه',
  'web.preview_reason': 'دلیل',
  'web.preview_reason_note':
    'این دلیل‌ها فقط برای اپراتور است. مشتری برای هر کدِ ردشده یک پیام یکسان می‌بیند، تا وجود یا پر شدن یک کد لو نرود.',
  'web.preview_outcome_applied': 'اعمال شد',
  'web.preview_outcome_skipped': 'کنار گذاشته شد',
  'web.preview_outcome_ineligible': 'شامل نمی‌شود',
  'web.preview_outcome_customer_dependent': 'وابسته به مشتری',

  'web.discount_reason_unknown_code': 'کدی با این نام وجود ندارد',
  'web.discount_reason_inactive': 'قاعده غیرفعال است',
  'web.discount_reason_not_started': 'هنوز شروع نشده است',
  'web.discount_reason_ended': 'به پایان رسیده است',
  'web.discount_reason_purpose': 'برای این نوع سفارش نیست',
  'web.discount_reason_product': 'برای این محصول نیست',
  'web.discount_reason_category': 'برای این دسته نیست',
  'web.discount_reason_customer': 'برای این مشتری نیست',
  'web.discount_reason_first_purchase': 'فقط برای خرید نخست است',
  'web.discount_reason_minimum_subtotal': 'مبلغ سفارش کمتر از حداقل قاعده است',
  'web.discount_reason_currency': 'واحد پول سفارش با قاعده یکی نیست',
  'web.discount_reason_total_limit': 'سقف کل استفاده پر شده است',
  'web.discount_reason_customer_limit': 'سقف استفادهٔ این مشتری پر شده است',
  'web.discount_reason_not_combinable': 'با قاعدهٔ اعمال‌شدهٔ دیگری ترکیب نمی‌شود',

  'web.order_pricing_title': 'قیمت‌گذاری این سفارش',
  'web.order_pricing_hint':
    'از قیمتی خوانده می‌شود که در همین سفارش ثبت شده است، نه از قاعده‌های امروز.',
  'web.order_pricing_code': 'کد تخفیف واردشده',
  'web.order_pricing_no_code': 'بدون کد',
  'web.order_pricing_adjustments': 'تعدیل‌های تخفیف',
  'web.order_pricing_no_adjustments': 'هیچ تخفیفی بر این سفارش اعمال نشده است.',
  'web.order_pricing_rule': 'قاعده',
  'web.order_pricing_before': 'پیش از تعدیل',
  'web.order_pricing_after': 'پس از تعدیل',
  'web.order_pricing_redemptions': 'استفاده‌های ثبت‌شده',
  'web.order_pricing_no_redemptions':
    'استفاده‌ای ثبت نشده است. استفاده از تخفیف هنگام تأیید سفارش ثبت می‌شود.',
  'web.order_pricing_amount': 'مبلغ تخفیف',
  'web.order_pricing_redeemed_at': 'زمان ثبت',
  'web.order_cashback_title': 'کش‌بک این سفارش',
  'web.order_cashback_none': 'قیمت این سفارش کش‌بکی در بر ندارد.',
  'web.order_cashback_percent': 'درصد',
  'web.order_cashback_promised': 'مبلغ وعده‌داده‌شده',
  'web.order_cashback_state': 'وضعیت کش‌بک',
  'web.order_cashback_earned': 'واریزشده',
  'web.order_cashback_reversed': 'برگشت‌داده‌شده',
  'web.order_cashback_unrecovered': 'وصول‌نشده',
  'web.order_cashback_unrecovered_note':
    'بخشی از برگشت کش‌بک را موجودی کیف پول پوشش نداد. این کسری فقط ثبت می‌شود و هرگز از مشتری مطالبه نمی‌شود.',
  'web.cashback_state_draft': 'هنوز ثبت نشده — هنگام تأیید سفارش ثبت می‌شود',
  'web.cashback_state_pending': 'در انتظار تحویل',
  'web.cashback_state_earned': 'واریز شده',
  'web.cashback_state_void': 'باطل شده',
  // --- Referral (WP9-A) ----------------------------------------------------
  'web.referrals_title': 'معرفی و پورسانت',
  'web.referrals_intro':
    'چه کسی چه کسی را معرفی کرده و برای آن چه پورسانتی وعده داده، واریز یا برگشت داده شده است. این صفحه فقط خواندنی است.',
  'web.referrals_filter_referrer': 'شناسهٔ معرف',
  'web.referrals_filter_referrer_hint':
    'شناسهٔ کامل مشتری؛ هر دو فهرست فقط به معرفی‌ها و پورسانت‌های همین معرف محدود می‌شوند.',
  'web.referrals_filter_invalid_id': 'این یک شناسهٔ کامل مشتری نیست.',
  'web.referrals_filter_apply': 'اعمال صافی',
  'web.referrals_filter_clear': 'حذف صافی',
  'web.referrals_filter_empty': 'موردی با این صافی پیدا نشد.',
  'web.referrals_attributions_title': 'معرفی‌ها',
  'web.referrals_attributions_hint':
    'هر مشتری فقط یک معرف دارد و معرفی فقط هنگام ثبت‌نام ثبت می‌شود. دامنهٔ پورسانت همان لحظه ثبت می‌شود و بعداً تغییر نمی‌کند. تازه‌ترین در بالا.',
  'web.referrals_attributions_empty': 'هنوز معرفی‌ای ثبت نشده است.',
  'web.referrals_commissions_title': 'دفتر پورسانت',
  'web.referrals_commissions_hint':
    'هر پورسانت هنگام تأیید سفارش وعده داده می‌شود، با تحویل سرویس واریز می‌شود و با بازپرداخت به نسبت برگشت داده می‌شود. تازه‌ترین در بالا.',
  'web.referrals_commissions_empty': 'هنوز پورسانتی ثبت نشده است.',
  'web.referrals_state_all': 'همه',
  'web.referrals_scope_title': 'قاعده‌هایی که این صفحه رعایت می‌کند',
  'web.referrals_rule_read_only':
    'هیچ معرفی‌ای جابه‌جا و هیچ پورسانتی دستی ویرایش نمی‌شود؛ هر دو تعیین می‌کنند چه کسی طلبکار است.',
  'web.referrals_rule_configure':
    'برنامهٔ معرفی از صفحهٔ قابلیت‌ها روشن می‌شود و درصد، دامنه و حداقل مبلغ سفارش از صفحهٔ تنظیمات.',
  'web.referrals_rule_unrecovered':
    'آن بخش از برگشت پورسانت که موجودی کیف پول معرف پوشش نداد فقط ثبت می‌شود و هرگز از او مطالبه نمی‌شود.',
  'web.referral_banner_title': 'بنر معرفی',
  'web.referral_banner_hint':
    'تصویری که بالای صفحهٔ معرفی در تلگرام نمایش داده می‌شود. PNG یا JPEG، حداکثر یک مگابایت.',
  'web.referral_banner_empty': 'بنری تنظیم نشده است؛ صفحهٔ معرفی بدون تصویر ارسال می‌شود.',
  'web.referral_banner_type': 'نوع فایل',
  'web.referral_banner_size': 'اندازه',
  'web.referral_banner_version': 'نسخه',
  'web.referral_banner_updated_at': 'آخرین تغییر',
  'web.referral_banner_digest': 'اثر انگشت (SHA-256)',
  'web.referral_banner_file': 'فایل بنر',
  'web.referral_banner_file_hint': 'PNG یا JPEG تا یک مگابایت.',
  'web.referral_banner_file_invalid_type': 'فقط PNG یا JPEG پذیرفته می‌شود.',
  'web.referral_banner_file_too_large': 'اندازهٔ فایل بیش از یک مگابایت است.',
  'web.referral_banner_file_unreadable': 'خواندن فایل ممکن نشد.',
  'web.referral_banner_upload': 'بارگذاری بنر',
  'web.referral_banner_uploading': 'در حال بارگذاری…',
  'web.referral_banner_uploaded': 'بنر ذخیره شد.',
  'web.referral_banner_clear': 'حذف بنر',
  'web.referral_banner_cleared': 'بنر حذف شد.',
  'web.referral_banner_read_only': 'برای تغییر بنر به مجوز ویرایش تنظیمات نیاز است.',
  'web.referral_banner_invalid': 'فایل با نوع اعلام‌شده هم‌خوانی ندارد یا بیش از حد بزرگ است.',
  'web.referral_gift_terms_invalid':
    'شرایط هدیهٔ عضویت نامعتبر است: مبلغ کل باید بیش از صفر و مجموع دو سهم دقیقاً ۱۰۰ باشد.',
  'web.referral_referrer': 'معرف',
  'web.referral_referee': 'معرفی‌شده',
  'web.referral_trigger': 'دامنهٔ پورسانت',
  'web.referral_created_at': 'زمان ثبت',
  'web.referral_order': 'سفارش',
  'web.referral_percent': 'درصد',
  'web.referral_basis': 'مبنای محاسبه',
  'web.referral_promised': 'مبلغ وعده‌داده‌شده',
  'web.referral_earned': 'واریزشده',
  'web.referral_reversed': 'برگشت‌داده‌شده',
  'web.referral_unrecovered': 'وصول‌نشده',
  'web.referral_settled_at': 'زمان تعیین تکلیف',
  'web.referral_unrecovered_note':
    'بخشی از برگشت پورسانت را موجودی کیف پول معرف پوشش نداد. این کسری فقط ثبت می‌شود و هرگز از معرف مطالبه نمی‌شود.',
  'web.referral_trigger_signup': 'هنگام ثبت‌نام',
  'web.referral_trigger_first_paid_order': 'فقط نخستین سفارش پرداخت‌شده',
  'web.referral_trigger_every_paid_order': 'هر سفارش پرداخت‌شده',
  'web.referral_commission_state_pending': 'در انتظار تحویل',
  'web.referral_commission_state_earned': 'واریز شده',
  'web.referral_commission_state_void': 'باطل شده',
  'web.user_referral_title': 'معرفی',
  'web.user_referral_denied':
    'برای دیدن معرفی‌ها و پورسانت‌های این مشتری دسترسی referrals.view لازم است.',
  'web.user_referral_referred_by': 'معرفی‌شده توسط',
  'web.user_referral_not_referred': 'این مشتری با معرفی کسی ثبت‌نام نکرده است.',
  'web.user_referral_referred_count': 'تعداد معرفی‌ها',
  'web.user_referral_no_commissions': 'هنوز پورسانتی به این مشتری تعلق نگرفته است.',
  'web.user_referral_totals': 'جمع پورسانت‌های این مشتری به تفکیک ارز',
  'web.user_referral_pending': 'در انتظار تحویل',
  'web.user_referral_earned': 'واریزشده',
  'web.user_referral_reversed': 'برگشت‌داده‌شده',
  'web.user_referral_unrecovered': 'وصول‌نشده',
  'web.user_referral_code': 'کد معرفی',
  'web.user_referral_no_code': 'این مشتری هنوز لینک دعوت خود را باز نکرده است.',
  'web.user_referral_all': 'معرفی‌ها و پورسانت‌های این معرف',

  // --- Resellers (WP9-B) ---------------------------------------------------
  'web.resellers_title': 'نمایندگان',
  'web.resellers_intro':
    'مشتریانی که با قیمت نمایندگی خرید می‌کنند، سطح هر کدام و سقف اعتبار خریدشان. نماینده همان مشتری است با یک ردیف نمایندگی.',
  'web.resellers_list_title': 'فهرست نمایندگان',
  'web.resellers_list_hint':
    'تازه‌ترین در بالا. سقف اعتباری که نشان داده می‌شود همان است که واقعاً اعمال می‌شود.',
  'web.resellers_search': 'جست‌وجو',
  'web.resellers_search_hint': 'شناسهٔ تلگرام (دقیق) یا بخشی از نام یا نام کاربری.',
  'web.resellers_empty': 'هنوز نماینده‌ای ثبت نشده است.',
  'web.resellers_empty_hint':
    'نماینده را از همین صفحه یا از کارت «نمایندگی» در صفحهٔ مشتری ثبت کنید؛ پیش از آن دست‌کم یک سطح نمایندگی بسازید.',
  'web.resellers_scope_title': 'قاعده‌هایی که این صفحه رعایت می‌کند',
  'web.resellers_rule_identity':
    'هر مشتری حداکثر یک ردیف نمایندگی دارد و فقط اپراتور آن را ثبت می‌کند. مشتری بدون ردیف یا با ردیف معلق، از هر نظر مشتری عادی است.',
  'web.resellers_rule_credit':
    'سقف اعتبار فقط برای خرید است و فقط در واحد پول همان سقف: موجودی کیف پول نماینده تا همین اندازه می‌تواند منفی شود. برداشت دستی هرگز موجودی را زیر صفر نمی‌برد و ثبت نماینده هیچ تراکنشی در کیف پول نمی‌نویسد.',
  'web.resellers_rule_suspend':
    'تعلیق فقط امتیازهای نمایندگی را برمی‌دارد؛ مسدود کردن مشتری اهرم جداگانه‌ای است که در صفحهٔ مشتری است. تغییر سطح یا نرخ فقط بر سفارش‌هایی اثر دارد که پس از آن تأیید شوند.',
  'web.resellers_tiers_link': 'سطوح نمایندگی و مجوزهای آنها',
  'web.reseller_customer': 'نماینده',
  'web.reseller_customer_id': 'شناسهٔ مشتری',
  'web.reseller_customer_id_hint': 'شناسهٔ کامل مشتری؛ از صفحهٔ همان مشتری کپی کنید.',
  'web.reseller_tier': 'سطح',
  'web.reseller_tier_all': 'همهٔ سطوح',
  'web.reseller_status_all': 'همه',
  'web.reseller_status_active': 'فعال',
  'web.reseller_status_suspended': 'معلق',
  'web.reseller_status_hint':
    'نمایندهٔ معلق با قیمت فهرست و بدون اعتبار خرید می‌کند، درست مانند مشتری عادی.',
  'web.reseller_pricing': 'قیمت‌گذاری',
  'web.reseller_pricing_hint':
    '«مطابق سطح» یعنی نرخ اختصاصی ندارد. هر گزینهٔ دیگر جایگزین نرخ سطح می‌شود و فقط برای همین نماینده است.',
  'web.reseller_pricing_list': 'قیمت فهرست',
  'web.reseller_pricing_percentage': 'کمتر از قیمت فهرست',
  'web.reseller_override_tier': 'مطابق سطح',
  'web.reseller_override_list': 'قیمت فهرست (بی‌توجه به نرخ سطح)',
  'web.reseller_override_percentage': 'درصد اختصاصی کمتر از قیمت فهرست',
  'web.reseller_tier_pricing_now': 'نرخ کنونی این سطح:',
  'web.reseller_percent': 'درصد',
  'web.reseller_percent_hint': 'عددی صحیح از ۱ تا ۱۰۰؛ از قیمت فهرست کم می‌شود.',
  'web.reseller_credit_limit': 'سقف اعتبار',
  'web.reseller_credit_limit_effective': 'سقف اعتبار اعمال‌شده',
  'web.reseller_credit_from_tier': 'از سطح',
  'web.reseller_credit_own': 'اختصاصی این نماینده',
  'web.reseller_own_limit': 'سقف اعتبار اختصاصی',
  'web.reseller_own_limit_hint': 'اگر علامت نخورد، سقف اعتبار سطح اعمال می‌شود.',
  'web.reseller_uses_tier_limit': 'سقف اعتبار سطح اعمال می‌شود:',
  'web.reseller_limit_amount': 'سقف اعتبار (واحد خرد)',
  'web.reseller_limit_amount_hint': 'صفر یعنی بدون اعتبار: موجودی این نماینده زیر صفر نمی‌رود.',
  'web.reseller_register_title': 'ثبت نماینده',
  'web.reseller_register_hint':
    'یک مشتری موجود را نماینده می‌کند. ثبت نماینده هیچ پولی جابه‌جا نمی‌کند.',
  'web.reseller_register': 'ثبت نماینده',
  'web.reseller_registered': 'نماینده ثبت شد.',
  'web.reseller_edit_title': 'ویرایش نماینده',
  'web.reseller_saved': 'نماینده ذخیره شد.',
  'web.reseller_edit_denied': 'برای ثبت یا ویرایش نماینده دسترسی resellers.edit لازم است.',
  'web.reseller_no_tiers':
    'هنوز سطح نمایندگی‌ای ساخته نشده است؛ هر نماینده باید دقیقاً یک سطح داشته باشد.',
  'web.reseller_problem_customer': 'شناسهٔ مشتری کامل و معتبر نیست.',
  'web.reseller_problem_tier': 'یک سطح انتخاب کنید.',
  'web.reseller_problem_percent': 'درصد باید عددی صحیح از ۱ تا ۱۰۰ باشد.',
  'web.reseller_problem_limit':
    'سقف اعتبار باید عددی صحیح و نامنفی به واحد خرد و در بازهٔ مجاز باشد.',

  'web.reseller_tiers_title': 'سطوح نمایندگی',
  'web.reseller_tiers_intro':
    'هر سطح یک نرخ قیمت، یک سقف اعتبار و مجموعه‌ای از مجوزهاست. هر نماینده دقیقاً یک سطح دارد.',
  'web.reseller_tiers_list_title': 'سطوح',
  'web.reseller_tiers_list_hint':
    'به ترتیب ساخت. مجوزی که قرمز است یعنی آن سطح از آن نوع هیچ چیزی را اجازه نمی‌دهد.',
  'web.reseller_tiers_empty': 'هنوز سطحی ساخته نشده است.',
  'web.reseller_tiers_empty_hint': 'بدون سطح نمی‌توان نماینده ثبت کرد.',
  'web.reseller_tier_name': 'نام سطح',
  'web.reseller_tier_count': 'تعداد نمایندگان',
  'web.reseller_tier_new_title': 'سطح تازه',
  'web.reseller_tier_new_hint':
    'نرخ و سقف اعتبار سطح را تعیین کنید؛ مجوزها را پس از ساخت، از فهرست بالا.',
  'web.reseller_tier_edit_title': 'ویرایش سطح',
  'web.reseller_tier_edit_hint':
    'تغییر فقط بر سفارش‌هایی اثر دارد که پس از آن تأیید شوند؛ سفارش تأییدشده قیمت خود را نگه می‌دارد.',
  'web.reseller_tier_limit_hint':
    'سقف اعتبار پیش‌فرض نمایندگان این سطح، به واحد خرد. صفر یعنی بدون اعتبار.',
  'web.reseller_tier_create': 'ساخت سطح',
  'web.reseller_tier_created': 'سطح ساخته شد.',
  'web.reseller_tier_saved': 'سطح ذخیره شد.',
  'web.reseller_tier_created_empty':
    'سطح تازه هیچ مجوزی ندارد؛ تا مجوزهایش را تعیین نکنید، نماینده‌ای در آن نمی‌تواند چیزی بخرد.',
  'web.reseller_tier_edit_denied':
    'برای ساخت یا ویرایش سطح و مجوزهای آن دسترسی resellers.edit لازم است.',
  'web.reseller_tier_problem_name': 'نام سطح نباید خالی یا بیش از اندازهٔ مجاز باشد.',
  'web.reseller_tiers_scope_title': 'قاعده‌هایی که این صفحه رعایت می‌کند',
  'web.reseller_tiers_rule_deny':
    'مجوزها به‌طور پیش‌فرض بسته‌اند: نوعی که هیچ مجوزی ندارد، هیچ چیزی از آن نوع را اجازه نمی‌دهد — نه «همه» را.',
  'web.reseller_tiers_rule_four':
    'نماینده فقط وقتی می‌تواند بخرد که هر چهار شرط برقرار باشد: نوع خرید مجاز باشد، محصول یا دستهٔ آن مجاز باشد، پنل محصول مجاز باشد و رباتی که خرید از آن انجام می‌شود مجاز باشد.',
  'web.reseller_tiers_rule_no_delete':
    'سطحی که نماینده دارد حذف نمی‌شود؛ سطح در جای خود ویرایش می‌شود.',
  'web.reseller_tiers_rule_future':
    'تغییر نرخ یا مجوزها فقط بر اقدام‌هایی اثر دارد که پس از آن تأیید شوند؛ سفارشی که تأیید شده، شرایط خود را نگه می‌دارد.',
  'web.reseller_tiers_resellers_link': 'فهرست نمایندگان',

  /*
   * WP14 — reseller phase 2 (`docs/wp14-reseller-phase2-audit.md`). Every sentence below
   * restates R8 or `OQ-WP9-04` as built: a debt is a negative balance, repaid like any
   * balance; nothing is settled, collected, aged or charged.
   */
  'web.reseller_standing_open': 'وضعیت',
  'web.reseller_credit_title': 'اعتبار نماینده',
  'web.reseller_credit_hint':
    'بخشی از سقف اعتبار که اکنون مصرف شده است، از روی دفتر کیف پول همین مشتری.',
  'web.reseller_credit_denied': 'برای دیدن اعتبار مصرف‌شده دسترسی users.view لازم است.',
  'web.reseller_credit_state': 'اعتبار',
  'web.reseller_credit_state_applies': 'اعمال می‌شود',
  'web.reseller_credit_state_suspended': 'اعمال نمی‌شود: نماینده معلق است',
  'web.reseller_credit_state_no_limit': 'اعمال نمی‌شود: سقف صفر است',
  'web.reseller_credit_state_currency': 'اعمال نمی‌شود: ارز سقف با ارز فروش یکی نیست',
  'web.reseller_credit_balance': 'موجودی کیف پول',
  'web.reseller_credit_allowance': 'مجاز زیر صفر',
  'web.reseller_credit_in_use': 'اعتبار مصرف‌شده (بدهی)',
  'web.reseller_credit_available': 'قابل خرید با اعتبار',
  'web.reseller_credit_over_limit': 'بیش از سقف کنونی',
  'web.reseller_credit_over_limit_banner':
    'بدهی این نماینده از سقف کنونی بیشتر است. بدهی سر جای خود می‌ماند و تا وقتی موجودی به محدودهٔ سقف برنگردد خرید اعتباری تازه‌ای پذیرفته نمی‌شود.',
  'web.reseller_credit_currency_banner':
    'سقف اعتبار به ارزی تعریف شده که فروش با آن انجام نمی‌شود؛ هیچ خریدی از این اعتبار استفاده نمی‌کند.',
  'web.reseller_credit_rule_debt':
    'بدهی همان موجودی منفی است و مثل هر موجودی با شارژ یا اعتبار دستی جبران می‌شود. سامانه بدهی را تسویه، وصول یا جریمه نمی‌کند.',
  'web.reseller_credit_rule_available':
    '«قابل خرید با اعتبار» همان مرزی است که هنگام پرداخت بررسی می‌شود؛ خریدی که یک لحظه بعد ثبت شود آن را تغییر می‌دهد.',
  'web.reseller_confirm_limit_below_debt':
    'سقف تازه از بدهی کنونی این نماینده کمتر است. بدهی سر جای خود می‌ماند و خرید اعتباری تازه متوقف می‌شود؛ هیچ مبلغی کسر یا وصول نمی‌شود.',
  'web.reseller_confirm_suspend_debt':
    'این نماینده بدهی دارد. تعلیق بدهی را سر جای خود نگه می‌دارد و فقط اعتبار تازه را قطع می‌کند؛ هیچ مبلغی کسر یا وصول نمی‌شود.',
  'web.reseller_confirm_acknowledge': 'متوجه شدم؛ ذخیره شود.',
  'web.reseller_purchases_title': 'خریدهای نماینده',
  'web.reseller_purchases_hint':
    'هر ردیف همان شرایطی است که هنگام تأیید سفارش ثبت شد، نه نرخ کنونی سطح. وضعیت سفارش، وضعیت امروز آن است.',
  'web.reseller_purchases_denied': 'برای دیدن خریدها دسترسی orders.view لازم است.',
  'web.reseller_purchases_empty': 'این نماینده هنوز خریدی تأییدشده ندارد.',
  'web.reseller_purchase_order': 'سفارش',
  'web.reseller_purchase_purpose': 'نوع خرید',
  'web.reseller_purchase_purpose_trial': 'اشتراک آزمایشی',
  'web.reseller_purchase_terms': 'سطح و لایهٔ قیمت',
  'web.reseller_purchase_list': 'قیمت فهرست',
  'web.reseller_purchase_cost': 'قیمت نماینده',
  'web.reseller_purchase_promotion': 'تخفیف',
  'web.reseller_purchase_sale': 'مبلغ پرداختی',
  'web.history_title': 'تاریخچهٔ تغییرات',
  'web.history_hint': 'تا ۵۰ تغییر آخر، از گزارش ممیزی. تلاش‌های ردشده هم ثبت شده‌اند.',
  'web.history_denied': 'برای دیدن تاریخچه دسترسی audit.view لازم است.',
  'web.history_empty': 'تغییری ثبت نشده است.',
  'web.history_open': 'تاریخچه',
  'web.history_when': 'زمان',
  'web.history_action': 'رویداد',
  'web.history_actor': 'انجام‌دهنده',
  'web.history_result': 'نتیجه',
  'web.history_changed': 'فیلدهای تغییرکرده',
  'web.history_action_reseller_register': 'ثبت نماینده',
  'web.history_action_reseller_update': 'ویرایش نماینده',
  'web.history_action_tier_create': 'ساخت سطح',
  'web.history_action_tier_update': 'ویرایش سطح',
  'web.history_action_tier_grants': 'تغییر مجوزها',
  'web.history_actor_customer': 'مشتری',
  'web.history_actor_telegram_admin': 'مدیر در تلگرام',
  'web.history_actor_web_admin': 'مدیر در پنل وب',
  'web.history_actor_system': 'سامانه',
  'web.history_actor_api': 'API',
  'web.history_actor_provider': 'همگام‌سازی پنل',
  'web.history_result_success': 'انجام شد',
  'web.history_result_denied': 'رد شد',
  'web.history_result_failed': 'ناموفق',

  'web.reseller_grants': 'مجوزها',
  'web.reseller_grants_title': 'مجوزهای سطح',
  'web.reseller_grants_hint':
    'برای هر نوع: هیچ، همه، یا موارد مشخص. ذخیره کل مجموعه را یکجا جایگزین می‌کند.',
  'web.reseller_grants_open': 'مجوزها',
  'web.reseller_grants_close': 'بستن',
  'web.reseller_grants_save': 'ذخیرهٔ مجوزها',
  'web.reseller_grants_saved': 'مجوزها ذخیره شد.',
  'web.reseller_grants_replace_note':
    'هر چه در این فرم مجاز نشده باشد، پس از ذخیره دیگر مجاز نیست.',
  'web.reseller_grants_blocked_title':
    'با این مجوزها نماینده‌ای در این سطح هیچ خریدی نمی‌تواند انجام دهد. آنچه بسته است:',
  'web.reseller_grants_sells_nothing': 'این سطح فعلاً اجازهٔ هیچ خریدی نمی‌دهد.',
  'web.reseller_grants_problem_empty':
    'برای نوعی که «موارد مشخص» دارد دست‌کم یک مورد انتخاب کنید، یا «هیچ» را برگزینید.',
  'web.reseller_grants_problem_id': 'یکی از شناسه‌های واردشده کامل و معتبر نیست.',
  'web.reseller_grants_problem_too_many': 'تعداد مجوزها بیش از اندازهٔ مجاز است.',
  'web.reseller_grant_kind_product': 'محصول',
  'web.reseller_grant_kind_category': 'دسته',
  'web.reseller_grant_kind_panel': 'پنل',
  'web.reseller_grant_kind_bot': 'ربات',
  'web.reseller_grant_kind_operation': 'نوع خرید',
  'web.reseller_grant_hint_product':
    'محصولی مجاز است که خودش یا دسته‌اش مجاز باشد؛ اگر نه محصول و نه دسته مجوزی نداشته باشد، هیچ محصولی مجاز نیست.',
  'web.reseller_grant_hint_category': 'همهٔ محصولات دسته‌های انتخاب‌شده مجاز می‌شوند.',
  'web.reseller_grant_hint_panel':
    'محصولی که پنلش مجاز نباشد، حتی اگر خودش مجاز باشد، فروخته نمی‌شود.',
  'web.reseller_grant_hint_bot':
    'خرید از طریق ربات انجام می‌شود؛ بدون مجوز ربات هیچ خریدی ممکن نیست.',
  'web.reseller_grant_hint_operation': 'خرید سرویس تازه، تمدید، افزایش حجم و افزایش زمان.',
  'web.reseller_grant_mode_none': 'هیچ (مجاز نیست)',
  'web.reseller_grant_mode_all': 'همه',
  'web.reseller_grant_mode_some': 'موارد مشخص',
  'web.reseller_grant_none': 'هیچ',
  'web.reseller_grant_all': 'همه',
  'web.reseller_grant_some_unit': 'مورد',
  'web.reseller_grant_none_hint': 'این سطح هیچ چیزی از این نوع را اجازه نمی‌دهد.',
  'web.reseller_grant_typed': 'شناسه‌ها',
  'web.reseller_grant_typed_hint':
    'فهرست کامل این نوع در دسترس نیست (دسترسی یا تعداد)؛ شناسه‌های کامل را هر کدام در یک سطر وارد کنید.',
  'web.reseller_grant_typed_bot':
    'پنل وب فهرستی از ربات‌ها ندارد؛ شناسهٔ کامل هر ربات را در یک سطر وارد کنید.',
  'web.reseller_grant_no_choices': 'موردی برای انتخاب وجود ندارد.',
  'web.reseller_dimension_operation': 'نوع خرید',
  'web.reseller_dimension_catalogue': 'محصول یا دسته',
  'web.reseller_dimension_panel': 'پنل',
  'web.reseller_dimension_bot': 'ربات',

  'web.reseller_layer_list': 'قیمت فهرست — سطح تغییری در قیمت نداد',
  'web.reseller_layer_tier': 'نرخ سطح',
  'web.reseller_layer_override': 'نرخ اختصاصی نماینده',

  'web.user_reseller_title': 'نمایندگی',
  'web.user_reseller_denied': 'برای دیدن نمایندگی این مشتری دسترسی resellers.view لازم است.',
  'web.user_reseller_none': 'این مشتری نماینده نیست.',
  'web.user_reseller_register': 'ثبت این مشتری به‌عنوان نماینده',
  'web.user_reseller_suspended':
    'نمایندگی این مشتری معلق است: با قیمت فهرست و بدون اعتبار خرید می‌کند.',
  'web.user_reseller_manage': 'مدیریت در صفحهٔ نمایندگان',

  'web.order_reseller_title': 'خرید نماینده',
  'web.order_reseller_customer': 'نماینده',
  'web.order_reseller_layer': 'لایهٔ قیمت',
  'web.order_reseller_list': 'قیمت فهرست',
  'web.order_reseller_cost': 'قیمت نماینده',
  'web.order_reseller_promotion': 'تخفیف تبلیغاتی',
  'web.order_reseller_sale': 'مبلغ فروش',
  'web.order_reseller_margin': 'حاشیهٔ نماینده',
  'web.order_reseller_currency': 'واحد پول',
  'web.order_reseller_bot': 'ربات',
  'web.order_reseller_recorded_at': 'زمان ثبت',
  'web.order_reseller_margin_note':
    'این ارقام هنگام تأیید سفارش ثبت شده‌اند و بعداً تغییر نمی‌کنند. حاشیه، قیمت فهرست منهای قیمت نماینده است و تخفیف مشتری به شمار نمی‌آید؛ تخفیف تبلیغاتی روی قیمت نماینده اعمال شده است.',

  'web.error_reseller_not_entitled': 'سطح این نماینده این خرید را اجازه نمی‌دهد.',
  'web.error_reseller_terms_changed':
    'شرایط نمایندگی از زمان نمایش قیمت تغییر کرده است؛ سفارش باید از نو آغاز شود.',
  'web.error_reseller_not_found': 'این مشتری نماینده نیست.',
  'web.error_reseller_already_registered': 'این مشتری پیش‌تر به‌عنوان نماینده ثبت شده است.',
  'web.error_reseller_tier_not_found': 'این سطح نمایندگی وجود ندارد؛ فهرست را تازه کنید.',
  // --- WP12 business reports -------------------------------------------------
  'web.report_all': 'همه',
  'web.report_business_title': 'گزارش کسب‌وکار',
  'web.report_business_hint':
    'ارقام فروش و درآمد، فقط برای مالک. هر پنج دقیقه تازه می‌شود و درآمد پس از تخفیف است؛ شارژ کیف پول، کش‌بک و هدیه درآمد نیستند.',
  'web.report_change_hint': 'نسبت به همان بازهٔ دورهٔ قبل',
  'web.report_change_new': 'جدید',
  'web.report_chart_current': 'دورهٔ جاری',
  'web.report_chart_previous': 'دورهٔ قبل',
  'web.report_chart_hover_hint': 'برای دیدن ارقام دقیق هر دو دوره، نشانگر را روی نمودار ببرید.',
  'web.report_col_active_services': 'سرویس فعال',
  'web.report_col_amount': 'مبلغ',
  'web.report_col_attempts': 'تلاش‌ها',
  'web.report_col_confirmed': 'موفق',
  'web.report_col_confirmed_amount': 'مبلغ موفق',
  'web.report_col_count': 'تعداد',
  'web.report_col_credit_in_use': 'اعتبار در حال استفاده / سقف',
  'web.report_col_direction': 'جهت',
  'web.report_col_discount': 'تخفیف',
  'web.report_col_failed_terminal': 'ناموفق قطعی',
  'web.report_col_gross': 'پیش از تخفیف',
  'web.report_col_group': 'گروه',
  'web.report_col_kind': 'نوع',
  'web.report_col_links': 'پیوندها',
  'web.report_col_method': 'روش پرداخت',
  'web.report_col_net_amount': 'اثر خالص',
  'web.report_col_orders': 'سفارش‌ها',
  'web.report_col_panel': 'پنل',
  'web.report_col_pending': 'در انتظار یا نامعلوم',
  'web.report_col_product': 'محصول (عنوان زمان خرید)',
  'web.report_col_product_status': 'وضعیت فعلی محصول',
  'web.report_col_provider': 'نوع ارائه‌دهنده',
  'web.report_col_provisioning_failures': 'خطای ساخت سرویس',
  'web.report_col_purpose': 'نوع عملیات',
  'web.report_col_rank': 'رتبه',
  'web.report_col_reason': 'علت تراکنش',
  'web.report_col_referrer': 'معرف',
  'web.report_col_reseller': 'نماینده',
  'web.report_col_revenue': 'درآمد',
  'web.report_col_route': 'مسیر پرداخت',
  'web.report_col_sales': 'مبلغ فروش',
  'web.report_col_services': 'سرویس‌ها',
  'web.report_col_services_created': 'سرویس ایجادشده',
  'web.report_col_settled_at': 'زمان پرداخت',
  'web.report_col_state': 'وضعیت',
  'web.report_col_success_rate': 'نرخ موفقیت',
  'web.report_col_tier': 'سطح',
  'web.report_col_total': 'مبلغ نهایی',
  'web.report_credit': 'واریز',
  'web.report_debit': 'برداشت',
  'web.report_export_csv': 'خروجی CSV',
  'web.report_export_xlsx': 'خروجی Excel',
  'web.report_failed_commercial': 'خطای تمدید یا افزودنی',
  'web.report_failed_payments': 'پرداخت ناموفق',
  'web.report_failed_provisioning': 'خطای ساخت سرویس',
  'web.report_failures_title': 'خلاصهٔ خطاها',
  'web.report_failures_hint':
    'فقط از وضعیت ساخت‌یافته شمرده می‌شود؛ پایش عمیق عملیات در این صفحه نیست.',
  'web.report_infra_title': 'پنل و ارائه‌دهنده',
  'web.report_infra_hint': 'سرویس، ترافیک و خطا به تفکیک پنل. درآمد به زیرساخت نسبت داده نمی‌شود.',
  'web.report_infra_providers': 'به تفکیک نوع ارائه‌دهنده',
  'web.report_kind_order': 'سفارش',
  'web.report_kind_topup': 'شارژ کیف پول',
  'web.report_kpi_active_customers': 'مشتری فعال:',
  'web.report_kpi_active_services': 'سرویس فعال (اکنون)',
  'web.report_kpi_discount': 'تخفیف داده‌شده:',
  'web.report_kpi_new_buyers': 'خریدار جدید:',
  'web.report_kpi_new_services': 'سرویس جدید',
  'web.report_kpi_new_services_hint':
    'سرویس‌هایی که در این بازه روی پنل ساخته شدند؛ سرویس آزمایشی جدا شمرده می‌شود.',
  'web.report_kpi_new_users': 'کاربر جدید',
  'web.report_kpi_now_hint': 'وضعیت همین لحظه؛ مقایسه با گذشته ندارد.',
  'web.report_kpi_renewals': 'تمدید',
  'web.report_kpi_revenue': 'درآمد',
  'web.report_kpi_revenue_hint':
    'مبلغ نهایی پس از تخفیف برای سفارش‌های پرداخت‌شده، با هر روش پرداخت؛ خریدی که از موجودی کیف پول پرداخت شده نیز شمرده می‌شود، حتی اگر آن موجودی از هدیه، کش‌بک یا پورسانت آمده باشد. خودِ شارژ کیف پول، کش‌بک، هدیه و پورسانت جداگانه به آن افزوده نمی‌شوند.',
  'web.report_kpi_sales': 'فروش',
  'web.report_kpi_sales_hint':
    'تعداد خرید، تمدید و افزودنی‌های پرداخت‌شده. هر سفارش یک بار شمرده می‌شود.',
  'web.report_kpi_successful_orders': 'سفارش موفق',
  'web.report_kpi_successful_orders_hint': 'فروش‌ها به‌علاوهٔ سرویس‌های آزمایشیِ داده‌شده.',
  'web.report_kpi_topup': 'شارژ کیف پول',
  'web.report_kpi_topup_count': 'تعداد:',
  'web.report_kpi_topup_hint':
    'پولی که مشتری به کیف پول واریز کرده است. درآمد نیست؛ خریدی که بعداً از کیف پول انجام شود درآمد است.',
  'web.report_kpi_trial_services': 'سرویس آزمایشی:',
  'web.report_kpis_title': 'شاخص‌های اصلی',
  'web.report_kpis_hint':
    'مقایسه با همان مدتِ دورهٔ قبل. رشد یا افت خودبه‌خود خوب یا بد نامیده نمی‌شود.',
  'web.report_lengths_differ': 'طول دو دوره برابر نیست.',
  'web.report_link_customer': 'مشتری',
  'web.report_link_order': 'سفارش',
  'web.report_location_unsupported':
    'گزارش بر اساس موقعیت در دسترس نیست: موقعیت فقط متن نمایشی محصول است و برای هر سرویس به‌طور یکتا ثبت نمی‌شود.',
  'web.report_metric_new_users': 'کاربر جدید',
  'web.report_metric_renewals': 'تمدید',
  'web.report_metric_revenue': 'درآمد',
  'web.report_metric_sales': 'تعداد فروش',
  'web.report_open_reports': 'گزارش‌های کامل',
  'web.report_orders_empty': 'در این بازه سفارش پرداخت‌شده‌ای نیست.',
  'web.report_orders_hint':
    'سفارش‌های پرداخت‌شده با عنوان و مبلغ زمان خرید. اطلاعات شخصی مشتری اینجا نیست؛ از پیوند مشتری استفاده کنید.',
  'web.report_orders_refunded': 'سفارش بازپرداخت‌شده',
  'web.report_orders_title': 'سفارش‌های پرداخت‌شده',
  'web.report_owner_only': 'این گزارش فقط برای مالک است.',
  'web.report_owner_only_hint':
    'گزارش‌های کسب‌وکار و مالی به نقش مالک محدودند و سرور هم درخواست دیگران را رد می‌کند.',
  'web.report_page_intro':
    'فروش، محصولات، سرویس‌ها، پرداخت‌ها، کیف پول، زیرساخت و نمایندگان، از داده‌های ثبت‌شده.',
  'web.report_page_next': 'بعدی',
  'web.report_page_previous': 'قبلی',
  'web.report_payments_empty': 'در این بازه تلاش پرداختی نیست.',
  'web.report_payments_title': 'پرداخت‌ها',
  'web.report_payments_hint':
    'تلاش‌های ایجادشده در این بازه. نرخ موفقیت = موفق ÷ (موفق + ناموفق، لغوشده و منقضی)؛ در انتظار و نامعلوم در آن شمرده نمی‌شوند.',
  'web.report_period_current': 'دوره:',
  'web.report_period_previous': 'دورهٔ قبل:',
  'web.report_products_empty': 'در این بازه محصولی فروخته نشده است.',
  'web.report_products_hint':
    'به عنوانی که محصول با آن فروخته شد؛ تغییر نام بعدی تاریخچه را عوض نمی‌کند.',
  'web.report_products_title': 'رتبه‌بندی محصولات',
  'web.report_purpose_trial': 'آزمایشی',
  'web.report_range_apply': 'اعمال',
  'web.report_range_custom': 'بازهٔ دلخواه',
  'web.report_range_date_hint': 'تاریخ شمسی به شکل ۱۴۰۵-۰۷-۰۱ با ارقام لاتین.',
  'web.report_range_from': 'از',
  'web.report_range_last_30': '۳۰ روز اخیر',
  'web.report_range_last_7': '۷ روز اخیر',
  'web.report_range_previous_month': 'ماه قبل',
  'web.report_range_this_month': 'این ماه',
  'web.report_range_this_year': 'امسال',
  'web.report_range_to': 'تا',
  'web.report_range_today': 'امروز',
  'web.report_range_yesterday': 'دیروز',
  'web.report_rank_by_buyers': 'به تعداد خریدار',
  'web.report_rank_by_commission': 'به پورسانت',
  'web.report_rank_by_count': 'به تعداد',
  'web.report_rank_by_revenue': 'به درآمد',
  'web.report_rank_by_signups': 'به ثبت‌نام',
  'web.report_referral_buyers': 'خریدار شده',
  'web.report_referral_buyers_hint':
    'از ثبت‌نام‌های این بازه، چند نفر تاکنون دست‌کم یک خرید داشته‌اند.',
  'web.report_referral_commissions': 'پورسانت خرید',
  'web.report_referral_gifts': 'هدیهٔ عضویت',
  'web.report_referral_title': 'تحلیل معرفی',
  'web.report_referral_hint':
    'فقط برای مالک. پاداش‌ها از دفتر کیف پول و درآمد از سفارش‌ها می‌آید؛ پاداش معرفی درآمد نیست.',
  'web.report_referral_revenue': 'درآمد از معرفی‌شده‌ها',
  'web.report_referral_revenue_hint': 'درآمد پس از تخفیف از خریدهای مشتریانی که با معرفی آمده‌اند.',
  'web.report_referral_signups': 'ثبت‌نام معرفی‌شده',
  'web.report_referrers_empty': 'در این بازه معرفی ثبت نشده است.',
  'web.report_refresh': 'تازه‌سازی',
  'web.report_resellers_empty': 'نماینده‌ای ثبت نشده است.',
  'web.report_resellers_title': 'نمایندگان',
  'web.report_resellers_hint':
    'سفارش، فروش، سرویس و اعتبار در حال استفاده. سود و تسویه در این گزارش نیست.',
  'web.report_service_states': 'وضعیت سرویس‌ها',
  'web.report_services_title': 'سرویس‌ها',
  'web.report_services_hint':
    'سرویس جدید، وضعیت فعلی، تمدید و افزودنی‌ها. ترافیک نامحدود جدا شمرده می‌شود.',
  'web.report_status_unknown': 'نامشخص',
  'web.report_success_rate_total': 'نرخ موفقیت کل:',
  'web.report_tab_failures': 'خطاها',
  'web.report_tab_infrastructure': 'زیرساخت',
  'web.report_tab_payments': 'پرداخت‌ها',
  'web.report_tab_products': 'محصولات',
  'web.report_tab_resellers': 'نمایندگان',
  'web.report_tab_sales': 'فروش',
  'web.report_tab_services': 'سرویس‌ها',
  'web.report_tab_wallet': 'کیف پول',
  'web.report_top_products_title': '۱۰ محصول برتر',
  'web.report_top_referrers': 'معرف‌های برتر',
  'web.report_total_rows': 'تعداد کل:',
  'web.report_traffic_sold': 'ترافیک فروخته‌شده',
  'web.report_trend_empty': 'در این دو دوره رقمی ثبت نشده است.',
  'web.report_trend_hint': 'دورهٔ جاری و دورهٔ قبل روی یک نمودار؛ بازه‌های آینده خالی می‌مانند.',
  'web.report_trend_other_currencies':
    'در این بازه با واحد پول دیگری هم فروش ثبت شده است؛ نمودار واحد پول فروش را نشان می‌دهد.',
  'web.report_trend_title': 'روند',
  'web.report_truncated': 'فقط بخشی از پنل‌ها نشان داده شده است.',
  'web.report_unknown_now': 'نتیجهٔ نامعلوم (اکنون)',
  'web.report_unlimited_lines': 'اقلام نامحدود:',
  'web.report_updated_at': 'به‌روزرسانی:',
  'web.report_view_all': 'مشاهدهٔ همه',
  'web.report_wallet_admin': 'اصلاح مدیریتی',
  'web.report_wallet_balance': 'موجودی کل کیف پول‌ها (اکنون):',
  'web.report_wallet_cashback': 'کش‌بک',
  'web.report_wallet_cashback_reversal': 'برگشت کش‌بک',
  'web.report_wallet_commission': 'پورسانت معرفی',
  'web.report_wallet_commission_reversal': 'برگشت پورسانت',
  'web.report_wallet_gift': 'هدیه',
  'web.report_wallet_title': 'کیف پول',
  'web.report_wallet_hint':
    'به تفکیک علت ثبت‌شده، نه متن توضیح. شارژ، هدیه، کش‌بک و خرج جدا از درآمدند؛ اثر خالص برداشت منفی است.',
  'web.report_wallet_other': 'سایر',
  'web.report_wallet_reasons': 'به تفکیک علت',
  'web.report_wallet_receipt_credit': 'واریز رسید به کیف پول',
  'web.report_wallet_refund': 'بازپرداخت به کیف پول',
  'web.report_wallet_spending': 'خرید از کیف پول',
  'web.report_wallet_topup': 'شارژ توسط مشتری',

  // Package D: the custom service (سرویس دلخواه) — its page, its rules and locations, and a
  // custom order's frozen terms.
  'web.nav_custom_service': 'سرویس دلخواه',
  'web.purpose_custom_service': 'سرویس دلخواه',
  'web.flag_custom_service': 'سرویس دلخواه',
  'web.order_purpose': 'نوع سفارش',
  'web.custom_service_title': 'سرویس دلخواه',
  'web.custom_service_intro':
    'مشتری موقعیت را انتخاب می‌کند، حجم را به گیگابایت و مدت را به روز وارد می‌کند و قیمت از قاعده‌های زیر محاسبه می‌شود.',
  'web.custom_service_flag_title': 'قابلیت سرویس دلخواه',
  'web.custom_service_flag_note':
    'این بخش تنها وقتی به مشتری نشان داده می‌شود که قابلیت «سرویس دلخواه» (custom_service) در بخش قابلیت‌ها روشن باشد؛ به‌طور پیش‌فرض خاموش است.',
  'web.custom_service_specificity_title': 'ترتیب انتخاب قاعده',
  'web.custom_service_specificity_intro':
    'برای حجم و برای زمان، هرکدام جداگانه، نخستین سطحی انتخاب می‌شود که قاعده‌ای فعال با بازهٔ شامل مقدار درخواستی داشته باشد؛ از خاص‌ترین به عام‌ترین:',
  'web.custom_service_note_tier':
    'سطح مشتری یعنی سطح نمایندگی او، اگر نمایندهٔ فعال باشد؛ در غیر این صورت قاعده‌های «مشتریان عادی».',
  'web.custom_service_note_both':
    'یک موقعیت تنها وقتی به مشتری عرضه می‌شود که هم قاعدهٔ حجم و هم قاعدهٔ زمان او را روی آن پنل قیمت‌گذاری کند.',
  'web.custom_service_note_overlap':
    'دو قاعدهٔ فعال از یک نوع، برای یک مخاطب و یک پنل، نمی‌توانند بازهٔ هم‌پوشان داشته باشند.',
  'web.custom_service_note_snapshot':
    'ویرایش یا حذف یک قاعده سفارش‌های ثبت‌شده را تغییر نمی‌دهد؛ هر سفارش شرایط قیمت خود را نگه می‌دارد.',
  'web.custom_service_dimension': 'نوع قاعده',
  'web.custom_service_dimension_volume': 'حجم',
  'web.custom_service_dimension_time': 'زمان',
  'web.custom_service_level_customer_panel': 'مشتری مشخص، روی همین پنل',
  'web.custom_service_level_customer_all_panels': 'مشتری مشخص، روی همهٔ پنل‌ها',
  'web.custom_service_level_tier_panel': 'سطح مشتری، روی همین پنل',
  'web.custom_service_level_tier_all_panels': 'سطح مشتری، روی همهٔ پنل‌ها',
  'web.custom_service_error_overlap':
    'بازهٔ این قاعده با یک قاعدهٔ فعال دیگر از همین نوع، برای همین مخاطب و همین پنل، هم‌پوشانی دارد. بازه را تغییر دهید یا قاعدهٔ دیگر را غیرفعال کنید.',
  'web.custom_service_error_rule_not_found': 'این قاعده دیگر وجود ندارد.',
  'web.custom_service_error_location_not_found': 'این موقعیت دیگر وجود ندارد.',
  'web.custom_service_error_invalid': 'قاعده پذیرفته نشد؛ مقادیر فرم را بررسی کنید.',
  'web.custom_service_error_invalid_panel': 'این پنل در این مجموعه وجود ندارد.',
  'web.custom_service_error_invalid_customer': 'این مشتری در این مجموعه وجود ندارد.',
  'web.custom_service_error_invalid_tier': 'این سطح نمایندگی وجود ندارد.',
  'web.custom_service_error_invalid_count': 'تعداد قاعده‌های سرویس دلخواه به سقف مجاز رسیده است.',
  'web.custom_service_locations_title': 'موقعیت‌ها',
  'web.custom_service_locations_hint':
    'پنلی به مشتری عرضه می‌شود که موقعیت فعال داشته باشد. نام پنل فقط برای مدیر است؛ مشتری عنوان موقعیت را می‌بیند.',
  'web.custom_service_locations_empty': 'پنلی برای نمایش نیست.',
  'web.custom_service_locations_empty_hint':
    'نخست پنلی اضافه کنید، سپس آن را با یک عنوان برای مشتری عرضه کنید.',
  'web.custom_service_panel': 'پنل',
  'web.custom_service_location': 'موقعیت',
  'web.custom_service_location_label': 'عنوان برای مشتری',
  'web.custom_service_location_label_hint': 'نامی که مشتری می‌بیند، مثلاً «🇩🇪 آلمان».',
  'web.custom_service_location_offered': 'عرضه می‌شود',
  'web.custom_service_location_disabled': 'غیرفعال',
  'web.custom_service_location_not_offered': 'عرضه نمی‌شود',
  'web.custom_service_location_offer': 'عرضه',
  'web.custom_service_location_form_title': 'ذخیرهٔ موقعیت',
  'web.custom_service_location_form_hint':
    'ذخیره برای پنلی که موقعیت ندارد آن را اضافه می‌کند و برای پنلی که دارد آن را به‌روز می‌کند.',
  'web.custom_service_location_saved': 'موقعیت ذخیره شد.',
  'web.custom_service_location_deleted': 'موقعیت حذف شد.',
  'web.custom_service_location_delete_confirm':
    'این پنل دیگر برای سرویس دلخواه عرضه نشود؟ سفارش‌های ثبت‌شده تغییری نمی‌کنند.',
  'web.custom_service_panel_typed_hint': 'فهرست پنل‌ها در دسترس نیست؛ شناسهٔ پنل را وارد کنید.',
  'web.custom_service_enabled': 'فعال',
  'web.custom_service_delete': 'حذف',
  'web.custom_service_edit_denied': 'برای ویرایش، دسترسی «catalog.pricing.edit» لازم است.',
  'web.custom_service_rules_title': 'قاعده‌های قیمت',
  'web.custom_service_rules_hint':
    'قیمت هر گیگابایت برای بازه‌ای از حجم، و قیمت هر روز برای بازه‌ای از مدت، به کوچک‌ترین واحد پول فروش.',
  'web.custom_service_rules_empty': 'هنوز قاعده‌ای ثبت نشده است.',
  'web.custom_service_range': 'بازه',
  'web.custom_service_range_to': 'تا',
  'web.custom_service_unit_price': 'قیمت واحد',
  'web.custom_service_per_gb': 'برای هر گیگابایت',
  'web.custom_service_per_day': 'برای هر روز',
  'web.custom_service_audience': 'مخاطب',
  'web.custom_service_audience_hint':
    'یک مشتری مشخص، یک سطح نمایندگی، یا مشتریان عادی (کسانی که نمایندهٔ فعال نیستند).',
  'web.custom_service_audience_ordinary': 'مشتریان عادی',
  'web.custom_service_audience_tier': 'سطح نمایندگی',
  'web.custom_service_audience_customer': 'مشتری مشخص',
  'web.custom_service_customer_id': 'شناسهٔ مشتری',
  'web.custom_service_customer_id_hint': 'شناسهٔ داخلی مشتری، نه شناسهٔ تلگرام.',
  'web.custom_service_tier_typed_hint':
    'فهرست سطح‌های نمایندگی در دسترس نیست؛ شناسهٔ سطح را وارد کنید.',
  'web.custom_service_all_panels': 'همهٔ پنل‌ها',
  'web.custom_service_rule_panel_hint': 'قاعدهٔ یک پنل مشخص بر قاعدهٔ «همهٔ پنل‌ها» مقدم است.',
  'web.custom_service_rule_panel_typed_hint':
    'فهرست پنل‌ها در دسترس نیست؛ شناسهٔ پنل را وارد کنید یا برای همهٔ پنل‌ها خالی بگذارید.',
  'web.custom_service_rule_new_title': 'قاعدهٔ تازه',
  'web.custom_service_rule_edit_title': 'ویرایش قاعده',
  'web.custom_service_rule_create': 'ثبت قاعده',
  'web.custom_service_rule_created': 'قاعده ثبت شد.',
  'web.custom_service_rule_saved': 'قاعده ذخیره شد.',
  'web.custom_service_rule_deleted': 'قاعده حذف شد.',
  'web.custom_service_rule_delete_confirm': 'این قاعده حذف شود؟ سفارش‌های ثبت‌شده تغییری نمی‌کنند.',
  'web.custom_service_rule_label_hint': 'اختیاری؛ نامی که فقط مدیر می‌بیند.',
  'web.custom_service_minimum_gb': 'کمینهٔ حجم (گیگابایت)',
  'web.custom_service_maximum_gb': 'بیشینهٔ حجم (گیگابایت)',
  'web.custom_service_minimum_days': 'کمینهٔ مدت (روز)',
  'web.custom_service_maximum_days': 'بیشینهٔ مدت (روز)',
  'web.custom_service_bound_gb_hint':
    'حداکثر با دو رقم اعشار، بزرگ‌تر از صفر، مثلاً 10.25. هر دو مرز جزو بازه‌اند.',
  'web.custom_service_bound_days_hint': 'عدد صحیح از ۱ تا ۳۶۵۰. هر دو مرز جزو بازه‌اند.',
  'web.custom_service_price_per_gb': 'قیمت هر گیگابایت',
  'web.custom_service_price_per_day': 'قیمت هر روز',
  'web.custom_service_price_hint':
    'به کوچک‌ترین واحد پول فروش، عدد صحیح مثبت؛ قیمت صفر پذیرفته نمی‌شود.',
  'web.custom_service_problem_label': 'عنوان بیش از حد بلند است.',
  'web.custom_service_problem_volume_bound':
    'مرزهای حجم باید عددی بزرگ‌تر از صفر با حداکثر دو رقم اعشار باشند (مثلاً 10.25).',
  'web.custom_service_problem_days_bound': 'مرزهای مدت باید عدد صحیح از ۱ تا ۳۶۵۰ روز باشند.',
  'web.custom_service_problem_range': 'بیشینه نباید از کمینه کمتر باشد.',
  'web.custom_service_problem_price': 'قیمت باید عدد صحیح مثبت باشد.',
  'web.custom_service_problem_tier': 'یک سطح نمایندگی انتخاب کنید.',
  'web.custom_service_problem_customer': 'شناسهٔ مشتری معتبر نیست.',
  'web.custom_service_problem_panel': 'پنل معتبری انتخاب کنید.',
  'web.custom_service_problem_location_label': 'عنوان موقعیت را وارد کنید (حداکثر ۶۴ نویسه).',
  'web.custom_service_volume': 'حجم',
  'web.custom_service_days': 'مدت',
  'web.custom_service_volume_price': 'قیمت حجم',
  'web.custom_service_time_price': 'قیمت زمان',
  'web.custom_service_base_price': 'قیمت پایه',
  'web.custom_service_volume_rule': 'قاعدهٔ حجم',
  'web.custom_service_time_rule': 'قاعدهٔ زمان',
  'web.order_custom_service_title': 'شرایط سرویس دلخواه',
  'web.order_custom_service_hint':
    'همان‌طور که هنگام ثبت سفارش ثبت شد؛ ویرایش یا حذف قاعده‌ها این ارقام را تغییر نمی‌دهد.',
  'web.order_custom_service_none': 'برای این سفارش شرایط سرویس دلخواهی ثبت نشده است.',
  // WP-A4 — «گروه گزارش‌های مدیریتی».
  'web.nav_ops_group': 'گروه گزارش‌ها',
  'web.opsgroup_title': 'گروه گزارش‌های مدیریتی',
  'web.opsgroup_subtitle':
    'گروه تلگرامی که Nexa گزارش‌های سیستم، خطاها و پرداخت‌ها را در تاپیک‌های خودش در آن ارسال می‌کند.',
  'web.opsgroup_lane_off':
    'ارسال گزارش‌ها خاموش است؛ تا روشن نشود هیچ گزارشی به گروه فرستاده نمی‌شود. از صفحهٔ «قابلیت‌ها»، قابلیت «اعلان‌های مدیریتی» را روشن کنید.',
  'web.opsgroup_connection': 'وضعیت اتصال',
  'web.opsgroup_connected': 'متصل',
  'web.opsgroup_disconnected': 'قطع',
  'web.opsgroup_group_name': 'نام گروه',
  'web.opsgroup_bot': 'ربات',
  'web.opsgroup_health': 'دسترسی‌ها',
  'web.opsgroup_health_unverified': 'در انتظار بررسی',
  'web.opsgroup_health_healthy': 'سالم',
  'web.opsgroup_health_problem': 'مشکل دسترسی',
  'web.opsgroup_checked_at': 'آخرین بررسی:',
  'web.opsgroup_last_delivery': 'آخرین ارسال موفق:',
  'web.opsgroup_none': '—',
  'web.opsgroup_problems_title': 'برای رفع مشکل:',
  'web.opsgroup_problem_not_forum':
    'تاپیک‌های گروه خاموش است. در تنظیمات گروه در تلگرام گزینهٔ «Topics» را روشن کنید و سپس «بررسی دسترسی‌ها» را بزنید.',
  'web.opsgroup_problem_bot_not_admin':
    'ربات مدیر گروه نیست. در تلگرام ربات را مدیر (Admin) گروه کنید و سپس «بررسی دسترسی‌ها» را بزنید.',
  'web.opsgroup_problem_cannot_send':
    'ربات اجازهٔ ارسال پیام در گروه را ندارد. در تنظیمات مدیر ربات، اجازهٔ ارسال پیام را بدهید.',
  'web.opsgroup_problem_cannot_manage_topics':
    'ربات مدیر است ولی اجازهٔ «مدیریت تاپیک‌ها» (Manage Topics) را ندارد. این اجازه را در تنظیمات مدیر ربات روشن کنید.',
  'web.opsgroup_problem_bot_removed':
    'ربات از گروه حذف شده یا مسدود شده است. ربات را دوباره به گروه اضافه و مدیر کنید و سپس «اتصال مجدد» را بزنید.',
  'web.opsgroup_problem_chat_unreachable':
    'تلگرام این گروه را پیدا نمی‌کند (ممکن است حذف یا تبدیل شده باشد). با «اتصال گروه تلگرام» گروه را دوباره وصل کنید.',
  'web.opsgroup_problem_bot_inactive':
    'رباتی که به گروه وصل است خاموش است یا توکن آن در دسترس نیست. از صفحهٔ «ربات‌ها» آن را روشن کنید.',
  'web.opsgroup_problem_topic_create_failed':
    'ساخت یکی از تاپیک‌ها ناموفق بود. اجازهٔ «مدیریت تاپیک‌ها» را بررسی کنید و «بررسی دسترسی‌ها» را دوباره بزنید.',
  'web.opsgroup_verify': 'بررسی دسترسی‌ها',
  'web.opsgroup_test': 'ارسال پیام آزمایشی',
  'web.opsgroup_reconnect': 'اتصال مجدد',
  'web.opsgroup_disconnect': 'قطع اتصال',
  'web.opsgroup_connect': 'اتصال گروه تلگرام',
  'web.opsgroup_disconnect_confirm_title': 'اتصال گروه قطع شود؟',
  'web.opsgroup_disconnect_confirm_body':
    'پس از قطع اتصال، Nexa دیگر در این گروه گزارشی نمی‌فرستد. گروه و تاپیک‌ها حذف نمی‌شوند و با «اتصال مجدد» برمی‌گردند.',
  'web.opsgroup_verified_done': 'دسترسی‌ها بررسی شد.',
  'web.opsgroup_reconnected_done': 'گروه دوباره متصل و بررسی شد.',
  'web.opsgroup_disconnected_done': 'اتصال گروه قطع شد.',
  'web.opsgroup_test_sent': 'ارسال شد',
  'web.opsgroup_test_failed': 'ارسال نشد',
  'web.opsgroup_topics': 'تاپیک‌ها',
  'web.opsgroup_topics_hint':
    'Nexa این تاپیک‌ها را خودش می‌سازد و نگه می‌دارد؛ اگر یکی حذف شود، دوباره ساخته می‌شود.',
  'web.opsgroup_topic_system': '⚙️ سیستم و خطاها',
  'web.opsgroup_topic_payments': '💳 پرداخت‌ها',
  'web.opsgroup_topic_pending': 'هنوز ساخته نشده',
  'web.opsgroup_topic_ready': 'آماده',
  'web.opsgroup_topic_missing': 'حذف شده — دوباره ساخته می‌شود',
  'web.opsgroup_queue': 'صف گزارش‌ها',
  'web.opsgroup_queue_pending': 'در انتظار ارسال',
  'web.opsgroup_queue_preserved': 'ارسال‌نشده (نگه‌داشته‌شده)',
  'web.opsgroup_queue_hint':
    'هر گزارش پیش از ارسال ثبت می‌شود و هیچ گزارشی حذف نمی‌شود، حتی وقتی گروه متصل نیست. گزارشی که پس از ۱۰ بار تلاش ارسال نشود اینجا نگه داشته می‌شود و پس از اتصال مجدد یا رفع مشکل، خودکار دوباره ارسال می‌شود؛ این دکمه همین کار را همین حالا انجام می‌دهد.',
  'web.opsgroup_requeue': 'ارسال مجدد گزارش‌های ارسال‌نشده',
  'web.opsgroup_requeued_done': 'تعداد گزارش‌هایی که دوباره در صف ارسال قرار گرفت:',
  'web.opsgroup_connect_title': 'اتصال گروه تلگرام',
  'web.opsgroup_connect_hint': 'بدون نیاز به شناسهٔ گروه یا شناسهٔ تاپیک.',
  'web.opsgroup_step_group':
    'در تلگرام یک سوپرگروه بسازید (یا یکی را انتخاب کنید) و گزینهٔ «Topics» را در تنظیمات آن روشن کنید.',
  'web.opsgroup_step_admin':
    'ربات را به گروه اضافه کنید و مدیر کنید، با اجازه‌های «ارسال پیام» و «مدیریت تاپیک‌ها».',
  'web.opsgroup_step_code':
    'دکمهٔ زیر را بزنید و پیوند را باز کنید، یا دستور نمایش‌داده‌شده را در همان گروه بفرستید.',
  'web.opsgroup_no_bot': 'هیچ ربات فعالی نیست. ابتدا از صفحهٔ «ربات‌ها» یک ربات را روشن کنید.',
  'web.opsgroup_open_link': 'افزودن ربات به گروه و اتصال',
  'web.opsgroup_or_command': 'یا این دستور را در گروه بفرستید:',
  'web.opsgroup_code_expires': 'این کد یک‌بار مصرف است و تا این زمان معتبر است:',
  'web.opsgroup_error_not_connected':
    'هنوز گروهی متصل نیست. ابتدا «اتصال گروه تلگرام» را انجام دهید.',
  'web.opsgroup_error_bot': 'این ربات فعال نیست. ربات دیگری انتخاب کنید.',
  'web.opsgroup_advanced': 'پیشرفته: مقصد دستی',
  'web.opsgroup_advanced_hint':
    'فقط اگر نمی‌توانید گروه را با روش بالا وصل کنید. این مقدارها تنها وقتی به کار می‌روند که هیچ گروهی متصل نباشد.',
  'web.opsgroup_manual_in_use': 'اکنون گزارش‌ها به همین مقصد دستی فرستاده می‌شوند.',
  'web.opsgroup_manual_chat': 'شناسهٔ عددی گروه',
  'web.opsgroup_manual_topic': 'شناسهٔ تاپیک گزارش‌های سیستم',
  'web.opsgroup_manual_payments_topic': 'شناسهٔ تاپیک پرداخت‌ها',
  'web.opsgroup_manual_saved': 'ذخیره شد.',
  // --- Advanced provider settings (WP-A8) ----------------------------------
  // The capability registry: one row per thing a person does with a service.
  'web.cap_registry_title': 'قابلیت‌های این پنل',
  'web.cap_support': 'پشتیبانی',
  'web.cap_supported': 'پشتیبانی می‌شود',
  'web.cap_unsupported': 'پشتیبانی نمی‌شود',
  'web.cap_row_create_service': 'ساخت سرویس',
  'web.cap_row_create_service_hint': 'ساخت حساب تازه روی پنل پس از پرداخت سفارش.',
  'web.cap_row_renew': 'تمدید',
  'web.cap_row_renew_hint': 'تمدید سرویس با همان پلن و قیمت امروز آن.',
  'web.cap_row_add_traffic': 'افزایش حجم',
  'web.cap_row_add_traffic_hint': 'افزودن حجم به سهم فعلی سرویس با خرید بسته.',
  'web.cap_row_add_time': 'افزایش زمان',
  'web.cap_row_add_time_hint': 'افزودن روز به مدت سرویس با خرید بسته.',
  'web.cap_row_reset_traffic': 'بازنشانی مصرف',
  'web.cap_row_reset_traffic_hint': 'صفر کردن حجم مصرف‌شدهٔ یک سرویس روی پنل.',
  'web.cap_row_disable_enable': 'غیرفعال / فعال کردن',
  'web.cap_row_disable_enable_hint': 'متوقف کردن موقت سرویس و فعال کردن دوبارهٔ آن.',
  'web.cap_row_rotate_subscription': 'ابطال و تعویض لینک اشتراک',
  'web.cap_row_rotate_subscription_hint': 'گرفتن لینک اشتراک تازه از پنل برای یک سرویس.',
  'web.cap_row_subscription_files': 'فایل‌های اشتراک',
  'web.cap_row_subscription_files_hint': 'فرستادن فایل‌های اتصال آماده‌ای که خود پنل می‌سازد.',
  'web.cap_row_extra_devices': 'افزایش کاربر / دستگاه',
  'web.cap_row_extra_devices_hint': 'بالا بردن محدودیت کاربر یا دستگاه یک سرویس موجود.',
  'web.cap_row_location_change': 'تغییر لوکیشن سرویس',
  'web.cap_row_location_change_hint': 'بردن یک سرویس موجود به لوکیشن دیگر.',
  'web.cap_row_usage_read': 'خواندن مصرف',
  'web.cap_row_usage_read_hint': 'خواندن حجم مصرف‌شدهٔ سرویس از پنل.',
  'web.cap_row_terminate': 'حذف سرویس',
  'web.cap_row_terminate_hint': 'پاک کردن حساب سرویس از پنل.',
  'web.cap_gap_not_declared':
    'پیاده‌سازی شده، اما هنوز روی پنل واقعی تأیید و اعلام نشده است؛ برای همین پیشنهاد نمی‌شود.',
  'web.cap_gap_not_implemented': 'اعلام شده اما کدی پشت آن نیست؛ برای ایمنی رد می‌شود.',
  'web.cap_gap_not_supported': 'این ارائه‌دهنده در این نسخه این کار را انجام نمی‌دهد.',
  'web.cap_gap_not_in_release': 'این نسخه هنوز چنین قابلیتی ندارد.',
  'web.cap_customer': 'برای مشتری',
  'web.cap_customer_available': 'در دسترس مشتری',
  'web.cap_customer_operator_only': 'کار مدیر یا سامانه',
  'web.cap_blocker_unsupported': 'پنل پشتیبانی نمی‌کند',
  'web.cap_blocker_policy_disabled': 'در سیاست این پنل خاموش است',
  'web.cap_blocker_policy_unreadable': 'سیاست ذخیره‌شده خوانا نیست',
  'web.cap_blocker_tenant_feature_off': 'قابلیت سراسری آن خاموش است',
  'web.cap_customer_hint':
    'آماده بودن بستهٔ فروش در کاتالوگ و آماده بودن خود پنل جداگانه، در بخش‌های خودشان نشان داده می‌شود.',

  // The operator's policy for this panel: it can only restrict.
  'web.policy_title': 'سیاست‌های عملیاتی این پنل',
  'web.policy_hint':
    'سیاست فقط می‌تواند محدود کند: کاری را برای مشتریانِ این پنل خاموش کند، فاصلهٔ انتظار را بیشتر کند یا اندازهٔ یک خرید را محدود کند. فقط کارهایی که پنل پشتیبانی می‌کند قابل تنظیم‌اند، و کارهای مدیر و سامانه تغییر نمی‌کنند.',
  'web.policy_customer_enabled': 'در دسترس مشتری',
  'web.policy_action_unsupported':
    'این کلید غیرفعال است، چون ارائه‌دهندهٔ این پنل این کار را انجام نمی‌دهد و مشتری آن را نمی‌بیند. دلیل:',
  'web.policy_cooldown_minutes': 'کمترین فاصلهٔ دو درخواست مشتری (دقیقه)',
  'web.policy_cooldown_hint':
    'خالی یعنی همان فاصلهٔ عمومی. فاصلهٔ واقعی بیشترینِ این عدد و فاصلهٔ عمومی است؛ هیچ‌وقت کمتر نمی‌شود.',
  'web.policy_max_traffic_gb': 'بیشترین حجم یک خرید (گیگابایت)',
  'web.policy_max_days': 'بیشترین مدت یک خرید (روز)',
  'web.policy_max_device_limit': 'بیشترین تعداد کاربر یک سرویس',
  'web.policy_limit_hint':
    'خالی یعنی بدون سقف اضافه. بسته‌های بزرگ‌تر روی این پنل پیشنهاد نمی‌شوند.',
  'web.policy_delivery': 'شیوهٔ تحویل سرویس',
  'web.policy_delivery_hint':
    'در هر دو حالت همان متن تأییدشده، لینک اشتراک و دکمه‌ها فرستاده می‌شود؛ تفاوت فقط تصویر QR است.',
  'web.policy_delivery_card_with_qr': 'کارت تحویل همراه با تصویر QR',
  'web.policy_delivery_card_text': 'کارت تحویل به‌صورت متن، بدون تصویر QR',
  'web.policy_no_actions': 'این پنل هیچ کار مشتری‌ای را پشتیبانی نمی‌کند که قابل تنظیم باشد.',
  'web.policy_invalid': 'این مقدارها معتبر نیستند:',
  'web.policy_stale':
    'سیاست این پنل از زمان بارگذاری تغییر کرده است. مقدار تازه بارگذاری شد؛ تغییرتان را دوباره اعمال کنید.',
  'web.policy_unreadable': 'سیاست ذخیره‌شده خوانا نیست',
  'web.policy_unreadable_body':
    'تا ذخیرهٔ دوباره، همهٔ کارهای مشتری روی این پنل رد می‌شود. فرم زیر پیش‌فرض را نشان می‌دهد.',
  'web.policy_revision': 'نسخهٔ سیاست',
  'web.policy_read_only': 'برای تغییر سیاست به دسترسی ویرایش پنل نیاز است.',

  // The fixed rules the provider's adapter applies.
  'web.prule_title': 'تنظیمات اختصاصی ارائه‌دهنده',
  'web.prule_hint':
    'رفتار ثابتی که هنگام ساخت سرویس روی این پنل اعمال می‌شود. پیکربندی قابل‌ویرایش — پروتکل‌ها، تگ‌های ورودی، دامنهٔ اشتراک و شناسهٔ ورودی — در زبانهٔ «نمای کلی»، بخش پیکربندی ارائه‌دهنده است و با همان قاعدهٔ سرور بررسی می‌شود.',
  'web.prule_traffic_reset': 'بازنشانی دوره‌ای حجم',
  'web.prule_traffic_reset_never':
    'هرگز. حجم خریداری‌شده کل سهم سرویس است؛ بازنشانی دوره‌ای به مشتری بیش از آنچه خریده می‌دهد، پس تنظیم‌پذیر نیست.',
  'web.prule_protocols': 'انتخاب پروتکل',
  'web.prule_protocols_operator_chosen': 'مدیر در پیکربندی پنل انتخاب می‌کند.',
  'web.prule_protocols_panel_assigned': 'خود پنل همهٔ پروتکل‌ها را به هر حساب می‌دهد.',
  'web.prule_protocols_inbound_defined': 'پروتکلِ ورودیِ انتخاب‌شده به کار می‌رود.',
  'web.prule_inbounds': 'انتخاب ورودی',
  'web.prule_inbounds_operator_tags': 'تگ‌های ورودی که مدیر برای هر پروتکل می‌نویسد.',
  'web.prule_inbounds_operator_inbound_id': 'یک ورودی، با شناسه‌ای که مدیر وارد می‌کند.',
  'web.prule_inbounds_panel_assigned': 'خود پنل همهٔ ورودی‌ها را به هر حساب می‌دهد.',
  'web.prule_subscription_link': 'لینک اشتراک',
  'web.prule_subscription_link_panel_issued': 'پنل لینک را می‌سازد و برمی‌گرداند.',
  'web.prule_subscription_link_subscription_domain': 'از دامنهٔ اشتراکِ پیکربندی‌شده ساخته می‌شود.',
  'web.prule_device_limit': 'محدودیت کاربر هنگام ساخت',
  'web.prule_device_limit_from_product': 'محدودیت کاربرِ محصول روی حساب تازه نوشته می‌شود.',
  'web.prule_device_limit_not_sent': 'فرستاده نمی‌شود؛ این پنل محدودیت کاربر یا دستگاه ندارد.',
  'web.prule_current': 'پیکربندی فعلی',
  'web.prule_nothing_to_configure': 'این پنل پیش از ساخت سرویس به پیکربندی نیاز ندارد.',
  'web.prule_not_configured': 'هنوز تنظیم نشده است.',
  'web.prule_location_note':
    'لوکیشنی که مشتری می‌بیند از محصول یا سرویس دلخواه می‌آید، نه از پیکربندی پنل.',

  // Diagnostics, from what the probe lane already stored.
  'web.diag_title': 'عیب‌یابی',
  'web.diag_hint':
    'از آخرین نتیجهٔ ذخیره‌شده خوانده می‌شود؛ دیدن این بخش هیچ درخواستی به پنل نمی‌فرستد. برای بررسی تازه «آزمایش اتصال» را بزنید.',
  'web.diag_check': 'بررسی',
  'web.diag_overall_ok': 'همه چیز درست است',
  'web.diag_overall_degraded': 'کار می‌کند، با هشدار',
  'web.diag_overall_error': 'مشکل دارد',
  'web.diag_overall_not_checked': 'هنوز بررسی نشده',
  'web.diag_overall_disabled': 'پنل غیرفعال است',
  'web.diag_check_connectivity': 'دسترسی به پنل',
  'web.diag_check_credentials': 'اعتبارنامهٔ تنظیم‌شده',
  'web.diag_check_authentication': 'احراز هویت',
  'web.diag_check_provider_status': 'وضعیت خود پنل',
  'web.diag_check_configuration': 'پیکربندی ارائه‌دهنده',
  'web.diag_check_connection_test': 'آزمایش اتصال با پیکربندی فعلی',
  'web.diag_check_freshness': 'تازگی نتیجه',
  'web.diag_check_required_capabilities': 'قابلیت‌های لازم',
  'web.diag_verdict_pass': 'درست',
  'web.diag_verdict_warn': 'هشدار',
  'web.diag_verdict_fail': 'نادرست',
  'web.diag_verdict_unknown': 'نامشخص',
  'web.diag_failure': 'آخرین خطا',
  'web.diag_last_success': 'آخرین بررسی موفق',
  'web.diag_missing_fields': 'فیلدهای تنظیم‌نشده',
  'web.diag_required_title': 'قابلیت‌های لازم برای فروش و نگهداری',
  'web.diag_capability_health_check': 'بررسی سلامت',
  'web.diag_capability_create_user': 'ساخت حساب',
  'web.diag_capability_deliver_subscription_link': 'تحویل لینک اشتراک',
  'web.diag_capability_read_usage': 'خواندن مصرف',
  'web.diag_available': 'موجود',
  'web.diag_missing': 'موجود نیست',
  'web.diag_failure_authentication_failed':
    'اعتبارنامه رد شد — نام کاربری و گذرواژه یا توکن را جایگزین کنید.',
  'web.diag_failure_authentication_requires_interaction':
    'پنل کد دومرحله‌ای می‌خواهد — برای دسترسی خودکار توکن API تنظیم کنید.',
  'web.diag_failure_unreachable': 'پنل در دسترس نبود — نشانی و روشن بودن سرور را بررسی کنید.',
  'web.diag_failure_timeout': 'پنل دیر پاسخ داد یا در زمان مقرر پاسخی نداد.',
  'web.diag_failure_tls_failed': 'گواهی یا دست‌دهی TLS ناموفق بود — گواهی پنل را بررسی کنید.',
  'web.diag_failure_blocked_target': 'نشانی به مقصدی می‌رسد که این نصب اجازهٔ تماس با آن را ندارد.',
  'web.diag_failure_rate_limited':
    'پنل گفت درخواست‌ها زیاد است — خود پنل سالم است؛ کمتر با آن تماس گرفته شود.',
  'web.diag_failure_malformed_response':
    'پنل پاسخ داد، اما پاسخ شکل پاسخ این ارائه‌دهنده را نداشت.',
  'web.diag_failure_provider_error': 'پنل با خطای خودش پاسخ داد.',
  'web.diag_failure_provider_refused': 'پنل درخواست را طبق قاعدهٔ خودش رد کرد.',
  'web.diag_failure_unsupported_capability': 'این ارائه‌دهنده کار خواسته‌شده را انجام نمی‌دهد.',

  // The Super Admin's read-only technical view.
  'web.tech_title': 'نمای فنی (فقط مدیر ارشد)',
  'web.tech_hint':
    'شناسه‌های خام برای عیب‌یابی یکپارچگی. فقط‌خواندنی است و هیچ اعتبارنامه‌ای در آن نیست — فقط زمان تنظیم آنها.',
  'web.tech_show': 'نمایش نمای فنی',
  'web.tech_hide': 'پنهان کردن نمای فنی',

  // Credential shapes and the provider catalogue, in Persian.
  'web.credential_shape_username_password': 'نام کاربری و گذرواژه',
  'web.credential_shape_opaque_token': 'توکن API',
  'web.credential_shape_token_or_username_password': 'توکن API یا نام کاربری و گذرواژه',
  'web.credential_shape_none': 'بدون اعتبارنامه',
  'web.providers_capabilities': 'کارهای پشتیبانی‌شده',

  // WP-A7 — support tickets.
  'web.nav_tickets': 'تیکت‌های پشتیبانی',
  'web.tickets_title': 'تیکت‌های پشتیبانی',
  'web.tickets_intro':
    'گفتگوهای پشتیبانی مشتریان در ربات. پاسخ شما در همین‌جا ثبت می‌شود و از طریق ربات برای مشتری فرستاده می‌شود.',
  'web.tickets_empty': 'هنوز تیکتی ثبت نشده است.',
  'web.tickets_empty_hint': 'مشتریان از بخش «🎫 پشتیبانی / تیکت‌ها» در ربات تیکت ثبت می‌کنند.',
  'web.tickets_filter_empty': 'تیکتی با این فیلترها پیدا نشد.',
  'web.ticket_filter_all': 'همه',
  'web.ticket_filter_mine': 'تیکت‌های من',
  'web.ticket_filter_customer_hint': 'شناسهٔ عددی تلگرام، نام کاربری یا شناسهٔ داخلی مشتری',
  'web.ticket_filter_from': 'از تاریخ',
  'web.ticket_filter_to': 'تا تاریخ',
  'web.ticket_filter_dates_invalid':
    'بازهٔ تاریخ معتبر نیست؛ تاریخ پایان نباید پیش از تاریخ شروع باشد.',
  'web.ticket_number': 'شمارهٔ تیکت',
  'web.ticket_subject': 'موضوع',
  'web.ticket_category': 'دسته',
  'web.ticket_priority': 'اولویت',
  'web.ticket_customer': 'مشتری',
  'web.ticket_assignee': 'مسئول پاسخ',
  'web.ticket_unassigned': 'بدون مسئول',
  'web.ticket_last_message': 'آخرین پیام',
  'web.ticket_created_at': 'زمان ثبت',
  'web.ticket_closed_at': 'زمان بسته‌شدن',
  'web.ticket_status_open': 'باز',
  'web.ticket_status_waiting_for_customer': 'در انتظار پاسخ مشتری',
  'web.ticket_status_waiting_for_support': 'در انتظار پاسخ پشتیبانی',
  'web.ticket_status_closed': 'بسته',
  'web.ticket_priority_low': 'کم',
  'web.ticket_priority_normal': 'عادی',
  'web.ticket_priority_high': 'زیاد',
  'web.ticket_priority_urgent': 'فوری',
  'web.ticket_delivery_pending': 'در صف ارسال به تلگرام',
  'web.ticket_delivery_delivered': 'به مشتری رسید',
  'web.ticket_delivery_unconfirmed': 'نتیجهٔ ارسال نامشخص',
  'web.ticket_delivery_failed': 'ارسال ناموفق',
  'web.ticket_delivery_superseded': 'ارسال نشد',
  'web.ticket_delivery_none': 'بدون ارسال در تلگرام',
  'web.ticket_system_closed_by_customer': 'مشتری تیکت را بست',
  'web.ticket_system_closed_by_support': 'پشتیبانی تیکت را بست',
  'web.ticket_system_reopened': 'پشتیبانی تیکت را دوباره باز کرد',
  'web.ticket_action_wait_customer': 'در انتظار پاسخ مشتری',
  'web.ticket_action_wait_support': 'در انتظار پاسخ پشتیبانی',
  'web.ticket_action_close': 'بستن تیکت',
  'web.ticket_action_reopen': 'بازکردن دوبارهٔ تیکت',
  'web.ticket_actions': 'مدیریت تیکت',
  'web.ticket_actions_hint':
    'تغییر وضعیت، مسئول پاسخ و اولویت. هر تغییر خودکار در گزارش فعالیت‌ها ثبت می‌شود.',
  'web.ticket_assign_me': 'واگذاری به من',
  'web.ticket_saved': 'ذخیره شد.',
  'web.ticket_no_change': 'تغییری لازم نبود؛ تیکت از قبل همین‌طور بود.',
  'web.ticket_detail': 'تیکت',
  'web.ticket_detail_intro': 'گفتگو، پیوست‌ها و اطلاعات مرتبط با این تیکت',
  'web.ticket_summary': 'خلاصهٔ تیکت',
  'web.ticket_context': 'مشتری و اطلاعات مرتبط',
  'web.ticket_context_hint': 'سرویس، سفارش یا پرداخت مرتبط باید متعلق به همین مشتری باشد.',
  'web.ticket_customer_telegram': 'شناسهٔ تلگرام',
  'web.ticket_customer_username': 'نام کاربری تلگرام',
  'web.ticket_customer_status': 'وضعیت مشتری',
  'web.ticket_customer_active': 'فعال',
  'web.ticket_customer_blocked': 'مسدود',
  'web.ticket_link_service': 'سرویس مرتبط',
  'web.ticket_link_order': 'سفارش مرتبط',
  'web.ticket_link_payment': 'پرداخت مرتبط',
  'web.ticket_links_save': 'ذخیرهٔ موارد مرتبط',
  'web.ticket_links_saved': 'موارد مرتبط ذخیره شد.',
  'web.ticket_conversation': 'گفتگو',
  'web.ticket_conversation_hint': 'همهٔ پیام‌ها به ترتیب زمان. پیام‌ها ویرایش یا حذف نمی‌شوند.',
  'web.ticket_sender_customer': 'مشتری',
  'web.ticket_sender_support': 'پشتیبانی',
  'web.ticket_attachment': 'پیوست',
  'web.ticket_attachment_photo': 'تصویر',
  'web.ticket_attachment_document': 'فایل',
  'web.ticket_attachment_name': 'نام فایل',
  'web.ticket_attachment_size': 'حجم',
  'web.ticket_attachment_view': 'نمایش تصویر',
  'web.ticket_attachment_download': 'دریافت فایل',
  'web.ticket_attachment_save': 'ذخیرهٔ فایل',
  'web.ticket_attachment_alt': 'تصویر ارسالی مشتری',
  'web.ticket_attachment_failed': 'این پیوست دیگر از تلگرام قابل دریافت نیست.',
  'web.ticket_reply': 'پاسخ به مشتری',
  'web.ticket_reply_hint':
    'پاسخ در تیکت ثبت می‌شود و از طریق ربات برای مشتری فرستاده می‌شود. اگر ارسال در تلگرام ناموفق باشد، پاسخ از بین نمی‌رود و مشتری آن را در تیکت می‌بیند.',
  'web.ticket_reply_text': 'متن پاسخ',
  'web.ticket_reply_limit': 'حداکثر ۳۰۰۰ نویسه',
  'web.ticket_reply_send': 'ارسال پاسخ',
  'web.ticket_reply_sent': 'پاسخ ثبت شد و برای ارسال به مشتری در صف قرار گرفت.',
  'web.ticket_reply_closed': 'این تیکت بسته است. برای پاسخ، ابتدا آن را دوباره باز کنید.',
  // HF-A7: support's file on a reply.
  'web.ticket_reply_file': 'پیوست (اختیاری)',
  'web.ticket_reply_file_hint':
    'تصویر JPEG یا PNG تا ۵ مگابایت، فایل PDF تا ۱۰ مگابایت یا فایل متنی TXT تا ۱ مگابایت. فایل اجرایی، اسکریپت، فایل فشرده و صفحهٔ وب پذیرفته نمی‌شود. پیوست جدا از متن پاسخ برای مشتری فرستاده می‌شود.',
  'web.ticket_reply_file_clear': 'حذف پیوست',
  'web.ticket_reply_file_empty': 'این فایل خالی است.',
  'web.ticket_reply_file_type':
    'این نوع فایل مجاز نیست. فقط تصویر JPEG یا PNG، فایل PDF یا فایل متنی TXT با پسوند درست پذیرفته می‌شود.',
  'web.ticket_reply_file_too_large':
    'حجم فایل بیش از حد مجاز است: تصویر تا ۵ مگابایت، PDF تا ۱۰ مگابایت و فایل متنی تا ۱ مگابایت.',
  'web.ticket_reply_file_name':
    'نام فایل پسوند یک فایل اجرایی یا اسکریپت را در خود دارد. نام فایل را تغییر دهید.',
  'web.ticket_reply_file_content':
    'محتوای فایل با نوع و پسوند آن یکی نیست؛ ممکن است فایل اجرایی یا اسکریپتی باشد که تغییر نام داده شده است.',
  'web.ticket_reply_file_unreadable': 'این فایل خوانده نشد. دوباره انتخاب کنید.',
  'web.ticket_attachment_delivery': 'ارسال پیوست',
  'web.ticket_attachment_alt_support': 'تصویر ارسالی پشتیبانی',
  'web.ticket_categories_title': 'دسته‌های تیکت',
  'web.ticket_categories_hint':
    'دسته‌هایی که مشتری هنگام ثبت تیکت در ربات انتخاب می‌کند. دسته‌ها حذف نمی‌شوند؛ دستهٔ پنهان از فهرست ربات برداشته می‌شود.',
  'web.ticket_category_title': 'عنوان دسته',
  'web.ticket_category_title_hint': 'یک خط، حداکثر ۶۴ نویسه',
  'web.ticket_category_order': 'ترتیب نمایش',
  'web.ticket_category_active': 'نمایش در ربات',
  'web.ticket_category_hidden': 'پنهان',
  'web.ticket_category_hide': 'پنهان کردن',
  'web.ticket_category_show': 'نمایش در ربات',
  'web.ticket_category_rename': 'تغییر نام',
  'web.ticket_category_reorder': 'ذخیرهٔ ترتیب',
  'web.ticket_category_add': 'افزودن دسته',
  'web.ticket_category_created': 'دسته افزوده شد.',
  'web.ticket_category_saved': 'دسته ذخیره شد.',
  'web.ticket_fault_closed': 'این تیکت بسته است؛ ابتدا آن را دوباره باز کنید.',
  'web.ticket_fault_transition': 'این تغییر وضعیت از وضعیت فعلی تیکت ممکن نیست. صفحه را تازه کنید.',
  'web.ticket_fault_message': 'متن پاسخ باید بین ۱ تا ۳۰۰۰ نویسه باشد.',
  'web.ticket_fault_message_limit': 'این تیکت به سقف پیام‌ها رسیده است.',
  'web.ticket_fault_assignee': 'این مدیر فعال نیست یا دسترسی مشاهدهٔ تیکت‌ها را ندارد.',
  'web.ticket_fault_link': 'مورد مرتبط باید متعلق به همین مشتری باشد.',
  'web.ticket_fault_category': 'عنوان دسته خالی، طولانی یا تکراری است.',
  'web.ticket_fault_category_limit': 'به سقف تعداد دسته‌ها رسیده‌اید.',
  'web.ticket_fault_category_missing': 'این دسته پیدا نشد.',
  'web.ticket_fault_not_found': 'این تیکت پیدا نشد.',
  'web.ticket_fault_attachment': 'این پیوست دیگر از تلگرام قابل دریافت نیست.',
  'web.ticket_fault_storage_full':
    'پیوست‌های زیادی هنوز در انتظار ارسال به تلگرام هستند. کمی بعد دوباره تلاش کنید یا پاسخ را بدون پیوست بفرستید.',
  'web.ticket_fault_retry':
    'این درخواست پیش‌تر با متن دیگری ثبت شده است. صفحه را تازه کنید و دوباره بفرستید.',
} as const;

export type WebKey = keyof typeof WEB_FA;

export function t(key: WebKey): string {
  return WEB_FA[key];
}
