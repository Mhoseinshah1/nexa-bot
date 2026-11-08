/**
 * Web Admin catalogue — settings and feature flags.
 *
 * One slice of `WEB_FA`; `../web.fa.ts` merges every slice and is what pages import.
 */
export const WEB_FA_SETTINGS = {
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
  'web.settings_group_fx': 'نرخ ارز',
  'web.settings_group_ops': 'گزارش‌های مدیریتی',
  'web.settings_group_customer_notices': 'اعلان‌های مشتری',
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
  'web.settings_invalid_value':
    'این مقدار پذیرفته نشد. مقدار واردشده را بررسی کنید و دوباره ذخیره کنید.',
  'web.settings_currency_not_sales': 'غیر از واحد پول فروشگاه',
  'web.settings_money_currency_mismatch':
    'این مبلغ به واحد پول فروشگاه نیست و با هیچ مبلغی مقایسه نمی‌شود، پس این تنظیم کار نمی‌کند. واحد پول را به واحد پول فروشگاه تغییر دهید.',
  'web.settings_presets_currency_mismatch':
    'برخی از این مبالغ به واحد پول فروشگاه نیستند و به مشتری نشان داده نمی‌شوند.',
  'web.settings_unknown_title': 'تنظیم ناشناخته',
  'web.settings_currency_confirm': 'واحد پول فروشگاه عوض شود؟',
  'web.settings_currency_confirm_detail':
    'هیچ قیمتی تبدیل نمی‌شود. مبالغ و گزینه‌های شارژی که به واحد قبلی ذخیره شده‌اند دیگر اعمال نمی‌شوند تا دوباره به واحد تازه تنظیم شوند.',
  'web.settings_currency_confirm_yes': 'بله، عوض شود',
  'web.features_list_title': 'همهٔ قابلیت‌ها',
  'web.features_list_hint':
    'هر تغییر همان لحظه اعمال می‌شود؛ خاموش‌کردن قابلیت‌هایی که چیزی را متوقف می‌کنند پیش از اجرا پرسیده می‌شود.',
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
  'web.setting_backup_keep_count': 'تعداد آرشیوهای بکاپ نگه‌داشته‌شده',
  'web.setting_backup_keep_count_desc':
    'این تعداد از تازه‌ترین بکاپ‌های تأییدشده همیشه روی سرور می‌مانند. آرشیوی فقط وقتی پاک می‌شود که هم بیرون از این تعداد باشد و هم از مدت نگهداری قدیمی‌تر. تازه‌ترین بکاپ تأییدشده هرگز پاک نمی‌شود.',
  'web.setting_backup_cpu_limit': 'حداکثر مصرف پردازنده‌ی بکاپ',
  'web.setting_backup_cpu_limit_desc':
    'بیشترین سهم پردازنده که فشرده‌سازی، رمزگذاری و تأیید بکاپ می‌گیرند، به درصدِ یک هسته. با 70 درصد یک هسته از سرور دوهسته‌ای همیشه برای ربات آزاد می‌ماند؛ عدد کمتر بکاپ را کندتر می‌کند، سنگین‌تر نه.',
  'web.setting_import_demotion_cap_min': 'حداقل سقف سرویس‌های تنزل‌یافته در واردکردن',
  'web.setting_import_demotion_cap_min_desc':
    'اگر بین اجرای آزمایشی تأییدشده و واردکردن، حساب سرویسی که قرار بود متصل شود از پنل حذف یا منقضی شود، آن سرویس به‌صورت سرویس پایان‌یافته وارد (یا برای بررسی نگه‌داشته) می‌شود و واردکردن ادامه می‌یابد. سقف این تعداد، بیشترِ این عدد و سهم تعیین‌شده در تنظیم بعدی است؛ بیش از سقف، واردکردن پیش از هر نوشتنی رد می‌شود. 0 یعنی فقط سهم درصدی.',
  'web.setting_import_demotion_cap_bps': 'سهم مجاز سرویس‌های تنزل‌یافته در واردکردن',
  'web.setting_import_demotion_cap_bps_desc':
    'سهمی از سرویس‌های قابل‌اتصالِ تأییدشده که واردکردن می‌تواند تنزل دهد، به صدم درصد (50 یعنی 0.5٪، رو به پایین گرد می‌شود). سقف، بیشترِ این سهم و حداقل تنظیم قبلی است. 0 یعنی فقط حداقل.',
  'web.setting_import_adoption_concurrency': 'هم‌زمانی اتصال سرویس‌ها در واردکردن',
  'web.setting_import_adoption_concurrency_desc':
    'هنگام واردکردن، حداکثر چند حساب از یک پنل هم‌زمان به سرویس متصل شوند. هر اتصال همچنان تراکنش جداگانه‌ی خودش است و به پنل درخواستی نمی‌فرستد (پنل یک بار خوانده می‌شود)؛ این عدد فقط کار پایگاه‌داده را هم‌پوشان می‌کند. 1 یعنی یکی‌یکی. بین 1 و 16.',
  'web.setting_backup_keep_days': 'مدت نگهداری آرشیوهای بکاپ',
  'web.setting_backup_keep_days_desc':
    'هر آرشیو بکاپ دست‌کم این تعداد روز پس از پایان روی سرور می‌ماند. آرشیوی که بازیابیِ در جریان به آن نیاز دارد یا ارسالش نامعلوم مانده هرگز پاک نمی‌شود.',
  'web.setting_bulk_read_rows': 'هشدار خواندن انبوه در یک درخواست (فقط مالک)',
  'web.setting_bulk_read_rows_desc':
    'اگر یک فهرست، جست‌وجو یا خروجی در پنل مدیریت بیش از این تعداد ردیف برگرداند، در گروه گزارش‌های مالک نصب هشدار امنیتی فرستاده می‌شود. صفر یعنی خاموش.',
  'web.setting_bulk_read_window_rows': 'هشدار خواندن انبوه در یک بازه (فقط مالک)',
  'web.setting_bulk_read_window_rows_desc':
    'اگر یک مدیر در یک بازهٔ زمانی بیش از این تعداد ردیف بخواند، یک بار در همان بازه به مالک نصب هشدار داده می‌شود. صفر یعنی خاموش.',
  'web.setting_bulk_read_window_minutes': 'طول بازهٔ شمارش خواندن انبوه',
  'web.setting_bulk_read_window_minutes_desc':
    'بازه‌ای که خواندن‌های هر مدیر در آن شمرده می‌شود؛ هر بازه از صفر شروع می‌شود.',
  'web.setting_outbound_private_targets': 'نشانی‌های داخلی مجاز برای پنل و درگاه (فقط مالک)',
  'web.setting_outbound_private_targets_desc':
    '⚠️ هشدار امنیتی: نشانی‌هایی که اینجا وارد می‌کنید به خودِ این سرور و شبکه‌های داخلی داکرِ آن می‌رسند. ربات به‌طور پیش‌فرض اجازه نمی‌دهد آدرس پنل، درگاه پرداخت یا پل اختصاصی به این شبکه‌ها (شبکهٔ لبهٔ نصب و ‎172.17.0.0/16‎) اشاره کند، چون از آن راه می‌شود به سرویس‌های داخلی سرور دسترسی گرفت. فقط اگر پنل شما واقعاً روی همین سرور و پشت یکی از این نشانی‌ها اجرا می‌شود، همان نشانی را (مثلاً ‎172.17.0.1‎ یا ‎172.29.0.0/24‎) با کاما جدا کنید. خالی یعنی هیچ‌کدام. پایگاه داده و ردیسِ نصب هرگز در دسترس نیستند. تغییر حداکثر تا یک دقیقه در همهٔ بخش‌ها اعمال می‌شود.',
  'web.setting_ops_max_per_minute': 'سقف ارسال گزارش در هر دقیقه',
  'web.setting_ops_max_per_minute_desc':
    'بیشترین تعداد گزارش مدیریتی که در یک دقیقه به تلگرام فرستاده می‌شود. گزارش‌های بیشتر حذف نمی‌شوند؛ در صف می‌مانند و در دقیقه‌های بعد فرستاده می‌شوند.',
  'web.setting_sales_currency_desc':
    'واحد پولی که قیمت محصولات و مبالغ تازه با آن تعیین می‌شود. تغییر آن قیمت‌های ثبت‌شده را تبدیل نمی‌کند.',
  'web.setting_sales_currency_refused':
    'تا وقتی پرداخت‌های قابل بازپرداختی به واحد پول فعلی وجود دارد، واحد پول فروشگاه را نمی‌توان تغییر داد. ابتدا آن پرداخت‌ها را تسویه یا بازپرداخت کنید.',
  'web.setting_support_accounts': 'حساب‌های پشتیبانی',
  'web.setting_support_ai_resume_after_minutes': 'بازگشت خودکار به هوش مصنوعی (دقیقه)',
  'web.setting_support_ai_resume_after_minutes_desc':
    'اگر پس از ارجاع عادی یا پیام شما در گفتگو، این مدت کسی از پشتیبانی چیزی ننویسد، هوش مصنوعی دوباره پاسخ می‌دهد. ارجاع‌های حساس (بازپرداخت، اختلاف پرداخت، امنیت، درخواست پشتیبان انسانی) هرگز خودکار برنمی‌گردند. 0 یعنی هرگز.',
  'web.setting_support_ai_handoff_alert_pct': 'آستانهٔ هشدار نرخ ارجاع (درصد)',
  'web.setting_support_ai_handoff_alert_pct_desc':
    'اگر سهم ارجاع‌های عادی در 50 پاسخ خودکار اخیر از این درصد بیشتر شود، در گروه گزارش‌ها هشدار داده می‌شود (حداکثر هر 6 ساعت یک بار). 0 یعنی خاموش.',
  'web.setting_support_knowledge_auto_refresh': 'به‌روزرسانی خودکار دانش پشتیبان',
  'web.setting_support_knowledge_auto_refresh_desc':
    'اگر روشن باشد، دانش ساخته‌شده از اطلاعات خود فروشگاه (پلن‌ها، پرسش‌های متداول، راهنماهای اتصال، برنامه‌ها، موقعیت‌ها، قوانین، حساب‌های پشتیبانی و راهنمای روش‌های پرداخت) دو دقیقه پس از آخرین تغییر و هر شب یک بار خودکار به‌روز می‌شود. مقاله‌ای که خودتان ویرایش کرده‌اید به‌عنوان تعارض برای بررسی می‌ماند و درس‌های آموخته از گفتگوها همچنان به تأیید شما نیاز دارند.',
  'web.setting_support_ai_actions_enabled': 'ابزارها و دکمه‌های هوش مصنوعی',
  'web.setting_support_ai_actions_enabled_desc':
    'اگر روشن باشد، هوش مصنوعی در گفتگوی حساب تجاری می‌تواند لینک اشتراک خود مشتری را بفرستد، وضعیت پرداخت‌های خودش را بگوید، دکمهٔ ورود به خرید، تمدید، حجم و زمان اضافه، تغییر لوکیشن، سرویس تست، تغییر لینک و شارژ کیف پول در ربات را بگذارد، پیش از ارجاع «پرداخت کردم ولی نیومد» پرداخت‌ها را بررسی کند، دکمهٔ «👤 پشتیبان انسانی» را زیر پاسخ‌ها بگذارد و به پیام صوتی یا فایل با درخواست نوشتن پاسخ دهد. هوش مصنوعی هیچ‌کدام از این کارها را خودش انجام نمی‌دهد؛ مشتری در ربات انجام می‌دهد.',
  'web.setting_support_ai_tickets_enabled': 'پاسخ هوش مصنوعی در تیکت‌های ربات',
  'web.setting_support_ai_tickets_enabled_desc':
    'اگر روشن باشد (و هوش مصنوعی در حالت پاسخ خودکار باشد)، هوش مصنوعی اولین پاسخ را در تیکت‌های ربات و بخش پشتیبانی مینی‌اپ هم می‌نویسد؛ با همان محافظ‌ها و بررسی‌های پاسخ‌های حساب تجاری. پاسخ او در تیکت با برچسب «هوش مصنوعی» ثبت می‌شود و وضعیت تیکت را تغییر نمی‌دهد. با پاسخ یک پشتیبان، هوش مصنوعی در همان تیکت کنار می‌رود و پس از مدت «بازگشت خودکار» برمی‌گردد؛ ارجاع سخت (پول، امنیت، درخواست انسان) تا بازگرداندن دستی نزد پشتیبان می‌ماند.',
  'web.setting_support_ai_label_enabled': 'برچسب «پاسخ هوش مصنوعی»',
  'web.setting_support_ai_label_enabled_desc':
    'اگر روشن باشد، هر پاسخ خودکار در حساب تجاری با سطر «🤖 پاسخ هوش مصنوعی» شروع می‌شود.',
  'web.setting_support_ai_feedback_enabled': 'پرسش «مشکل حل شد؟»',
  'web.setting_support_ai_feedback_enabled_desc':
    'اگر روشن باشد (و ابزارهای هوش مصنوعی هم روشن باشند)، زیر پاسخ خودکار «مشکل حل شد؟» با دکمه‌های 👍 و 👎 می‌آید. 👎 گفتگو را به پشتیبان می‌سپارد و یک کمبود دانش ثبت می‌کند.',
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
  'web.setting_server_selection': 'انتخاب سرور در خرید',
  'web.setting_server_selection_desc':
    'روشن باشد، مشتری پیش از دسته‌ها سرور را انتخاب می‌کند: سرور ← دسته ← پلن. فقط سرورهای فعالِ تخلیه‌نشده‌ای که دست‌کم یک پلن قابل خرید دارند، با نام پنل، نشان داده می‌شوند؛ اگر فقط یک سرور باشد این مرحله نشان داده نمی‌شود. قیمت، پیش‌فاکتور، پرداخت و تمدید تغییری نمی‌کنند.',
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
    'هشدار پایانی مصرف حجم؛ 100 یعنی لحظهٔ تمام‌شدن حجم. باید بیشتر از آستانهٔ دوم باشد.',
  // WP-A9.
  'web.setting_reminders_expiry_early_days_desc':
    'چند روز پیش از پایان اعتبار سرویس، یادآور هفتگی فرستاده شود؛ زودتر از یادآور اول. صفر یعنی این یادآور فرستاده نشود.',
  'web.setting_reminders_payment_pending_minutes_desc':
    'چند دقیقه پیش از پایان مهلت، یک بار به مشتری‌ای که هنوز کارت‌به‌کارت نکرده یا سفارشش را پرداخت نکرده یادآوری شود.',
  // HF-A9: the quiet window's two boundaries.
  'web.setting_reminders_quiet_hours_start_desc':
    'از این ساعت (به وقت فروشگاه) یادآورها فرستاده نمی‌شوند و تا پایان ساعات سکوت نگه داشته می‌شوند. به شکل ساعت:دقیقه، مثلاً 23:00. فقط وقتی «ساعات سکوت یادآورها» روشن باشد اثر دارد.',
  'web.setting_reminders_quiet_hours_end_desc':
    'در این ساعت (به وقت فروشگاه) ساعات سکوت تمام می‌شود و یادآورهای نگه‌داشته فرستاده می‌شوند. اگر از ساعت شروع کوچک‌تر باشد، بازه از نیمه‌شب می‌گذرد؛ مثلاً 23:00 تا 08:00.',
  'web.setting_wallet_low_balance_threshold_desc':
    'وقتی موجودی کیف پول مشتری از این مبلغ کمتر شود، یک بار به او هشدار داده می‌شود. صفر یعنی هشداری فرستاده نشود. باید به واحد پول فروشگاه باشد.',
  'web.setting_trial_product_id_desc':
    'دیگر استفاده نمی‌شود. سرویس تست اکنون مستقل از محصولات و روی هر پنل (صفحهٔ پنل، زبانهٔ «سرویس تست») تنظیم می‌شود؛ مقدار قبلی این تنظیم یک بار به تنظیمات همان پنل منتقل شده است.',
  'web.setting_trial_limit_per_customer_desc':
    'هر مشتری در مجموع همهٔ پنل‌ها چند بار می‌تواند سرویس آزمایشی بگیرد. صفر یعنی سرویس آزمایشی به کسی داده نمی‌شود. روشن یا خاموش بودن سرویس تست روی هر پنل جداگانه (صفحهٔ پنل، زبانهٔ «سرویس تست») تعیین می‌شود.',
  'web.setting_miniapp_init_data_max_age_seconds_desc':
    'تلگرام هنگام باز شدن مینی‌اپ یک امضای ورود می‌سازد. امضایی قدیمی‌تر از این مدت پذیرفته نمی‌شود و مشتری باید مینی‌اپ را دوباره باز کند.',
  'web.setting_auto_renew_lead_hours_desc':
    'سرویسی که مشتری تمدید خودکار آن را روشن کرده، این تعداد ساعت پیش از پایان اعتبار از کیف پول تمدید می‌شود. اگر موجودی کافی نباشد یک بار به مشتری گفته می‌شود و اگر پیش از پایان اعتبار کیف پول شارژ شود، تمدید انجام می‌شود. بین 1 تا 168 ساعت.',
  'web.setting_miniapp_session_ttl_minutes_desc':
    'هر بار باز شدن مینی‌اپ فقط یک نشست می‌سازد که پس از این مدت تمام می‌شود؛ بعد از آن مشتری مینی‌اپ را دوباره باز می‌کند.',
  'web.setting_link_rotation_cooldown_hours_desc':
    'مشتری پس از دریافت لینک اشتراک تازه، باید این مدت صبر کند تا دوباره بتواند لینک تازه بگیرد.',
  'web.setting_referral_commission_percent': 'درصد پورسانت معرفی',
  'web.setting_referral_commission_percent_desc':
    'چند درصد از مبلغ سفارش پرداخت‌شدهٔ کاربر معرفی‌شده به معرف داده شود. اگر خالی بماند، برنامهٔ معرفی اجرا نمی‌شود.',
  // Package FX: what an operator sets. The live figures are on the payment routes page.
  'web.setting_fx_primary_source': 'صرافی اصلی نرخ تتر',
  'web.setting_fx_primary_source_desc':
    'وقتی چند منبع روشن با هم موافقند، عددِ همین منبع ذخیره می‌شود. همهٔ منبع‌های روشن خوانده می‌شوند. هر منبع بهترین قیمت خریدِ دفتر سفارش تتر را می‌دهد؛ یعنی قیمتی که خریدار به فروشنده می‌پردازد، تا مشتری هیچ‌وقت کمتر از ارزش واقعی شارژ نشود.',
  'web.setting_fx_fallback_source': 'صرافی پشتیبان نرخ تتر',
  'web.setting_fx_fallback_source_desc':
    'اگر صرافی اصلی میان منبع‌های موافق نباشد، عدد این صرافی ذخیره می‌شود. «ندارد» یعنی ترجیح دومی نیست. این گزینه منبعی را خاموش نمی‌کند؛ برای خاموش کردن از کلیدهای «خواندن از ...» استفاده کنید.',
  'web.setting_fx_fresh_ttl_seconds': 'مهلت تازگی نرخ',
  'web.setting_fx_fresh_ttl_seconds_desc':
    'نرخ خوانده‌شده تا این مدت «تازه» است و بعد از آن دوباره خوانده می‌شود. فاکتور جدیدی که با نرخ تازه صادر شود چیز خاصی ثبت نمی‌کند.',
  'web.setting_fx_max_stale_seconds': 'حداکثر کهنگی مجاز نرخ',
  'web.setting_fx_max_stale_seconds_desc':
    'اگر همهٔ منبع‌ها از کار بیفتند، آخرین نرخ معتبر تا این سن (معمولاً 6 ساعت) هنوز می‌تواند فاکتور جدید صادر کند و این استفاده ثبت می‌شود. بعد از آن فاکتور جدید با نرخ مرکزی (مثلاً استارز) با پیام روشن رد می‌شود؛ هیچ‌وقت نرخی ساخته نمی‌شود. فاکتورهای صادرشده نرخ ثبت‌شدهٔ خودشان را نگه می‌دارند.',
  'web.setting_fx_source_nobitex_enabled': 'خواندن نرخ از نوبیتکس',
  'web.setting_fx_source_nobitex_enabled_desc':
    'خاموش یعنی نوبیتکس هرگز فراخوانی نمی‌شود. برای وقتی که نوبیتکس به آدرس این سرور خطای 403 می‌دهد.',
  'web.setting_fx_source_wallex_enabled': 'خواندن نرخ از والکس',
  'web.setting_fx_source_wallex_enabled_desc': 'خاموش یعنی والکس هرگز فراخوانی نمی‌شود.',
  'web.setting_fx_source_tabdeal_enabled': 'خواندن نرخ از تبدیل',
  'web.setting_fx_source_tabdeal_enabled_desc':
    'میانگین بهترین فروش و بهترین خرید جفت تتر/تومان. خاموش یعنی تبدیل هرگز فراخوانی نمی‌شود.',
  'web.setting_fx_source_bitpin_enabled': 'خواندن نرخ از بیت‌پین',
  'web.setting_fx_source_bitpin_enabled_desc':
    'آخرین قیمت معامله‌شدهٔ تتر/تومان. خاموش یعنی بیت‌پین هرگز فراخوانی نمی‌شود.',
  'web.setting_fx_source_ramzinex_enabled': 'خواندن نرخ از رمزینکس',
  'web.setting_fx_source_ramzinex_enabled_desc':
    'میانگین خرید و فروش به ریال که به تومان تبدیل می‌شود. در ابتدا خاموش است و منبع جایگزین است. خاموش یعنی رمزینکس هرگز فراخوانی نمی‌شود.',
  'web.setting_fx_sanity_band_bps': 'حد انحراف مجاز از میانهٔ منبع‌ها',
  'web.setting_fx_sanity_band_bps_desc':
    'وقتی دست‌کم سه منبع سالم هست، منبعی که بیش از این مقدار از میانهٔ بقیه فاصله دارد در همان نوبت کنار گذاشته و یک بار در گزارش عملیات ثبت می‌شود. 200 یعنی دو درصد. با دو منبع، فقط شرط موافقت سه‌درصدی تصمیم می‌گیرد.',
  'web.setting_fx_min_agreeing_sources': 'حداقل منبع موافق برای ذخیرهٔ نرخ',
  'web.setting_fx_min_agreeing_sources_desc':
    'نرخ وقتی ذخیره می‌شود که دست‌کم این تعداد منبع روشن و سالم، در حدود سه درصد با هم موافق باشند. معمولاً 2.',
  'web.setting_fx_accept_single_source': 'پذیرش نرخ از یک منبع',
  'web.setting_fx_accept_single_source_desc':
    'وقتی فقط یک منبع سالم مانده، نرخ همان ذخیره شود. خاموش یعنی آخرین نرخ ذخیره‌شده تا پایان مهلت کهنگی کار می‌کند. در حالت روشن هم نرخی که بیش از 15 درصد با آخرین نرخ خوب فاصله دارد رد می‌شود و یک هشدار «فقط یک منبع نرخ فعال است» ثبت می‌شود.',
  'web.setting_stars_pricing_mode': 'حالت قیمت‌گذاری استارز (بازنشسته)',
  'web.setting_stars_pricing_mode_desc':
    'دیگر استفاده نمی‌شود: قیمت هر ستاره همیشه از نرخ مرکزی تتر و «تعداد استارز به ازای هر تتر» به‌دست می‌آید و نرخ دستی برای استارز وجود ندارد.',
  // NEXA v095 PR-4 B.
  'web.setting_phone_allowed_numbers': 'شماره‌های مجاز برای تأیید شماره',
  'web.setting_phone_allowed_numbers_desc':
    'کدام شماره‌ها در تأیید شماره پذیرفته شوند: در تأیید اجباری کل ربات، در شرط تأیید شمارهٔ درگاه‌ها و در مینی‌اپ. شماره پیش از بررسی یکسان‌سازی می‌شود (+98، 98 و 0098 هر سه ایران است). مشتری‌ای که پیش‌تر با شماره‌ای دیگر تأیید شده، تأییدش را نگه می‌دارد.',
  'web.phone_allowed_numbers_all': 'همهٔ شماره‌ها',
  'web.phone_allowed_numbers_iran_only': 'فقط شمارهٔ ایران (+98)',
  'web.setting_stars_per_usdt': 'تعداد استارز به ازای هر تتر',
  'web.setting_stars_per_usdt_desc':
    'قیمت هر ستاره به تومان همیشه خودکار از نرخ مرکزی تتر تقسیم بر این عدد محاسبه می‌شود. تلگرام نرخ رسمی تبدیل ستاره به تتر منتشر نمی‌کند؛ این عدد را شما تعیین می‌کنید (مثلاً 100 یا 77٫5؛ حداکثر چهار رقم اعشار). خالی یعنی تنظیم نشده: روش پرداخت استارز روشن نمی‌شود و تا روشن است نمی‌توان آن را خالی کرد.',
  'web.setting_referral_commission_scope': 'سفارش‌های مشمول پورسانت',
  'web.setting_referral_commission_scope_desc':
    'پورسانت فقط برای نخستین سفارش پرداخت‌شدهٔ کاربر معرفی‌شده داده شود یا برای همهٔ سفارش‌هایش. تغییر آن فقط روی معرفی‌های بعدی اثر دارد.',
  'web.setting_referral_minimum_order_amount': 'حداقل مبلغ سفارش برای پورسانت',
  'web.setting_referral_minimum_order_amount_desc':
    'سفارش‌هایی که مبلغشان کمتر از این مقدار است پورسانتی ندارند. صفر یعنی بدون حداقل. اگر به واحد پولی غیر از واحد پول سفارش باشد، هیچ سفارشی پورسانت نمی‌گیرد؛ مبلغ‌ها تبدیل ارز نمی‌شوند.',
  'web.setting_referral_signup_gift_total_desc':
    'کل هدیه‌ای که پس از یک معرفی معتبر میان معرف و کاربر تازه تقسیم می‌شود. صفر یعنی هدیه‌ای پرداخت نمی‌شود. باید به واحد پول فروشگاه باشد، وگرنه هدیهٔ عضویت روشن نمی‌شود.',
  'web.setting_referral_signup_gift_referrer_percent_desc':
    'سهم معرف از هدیهٔ عضویت. جمع سهم معرف و کاربر تازه باید 100 باشد.',
  'web.setting_referral_signup_gift_referred_percent_desc':
    'سهم کاربر تازه از هدیهٔ عضویت. جمع سهم معرف و کاربر تازه باید 100 باشد.',
  // R10 D5 (b): the referral-gift guard.
  'web.setting_referral_abuse_gift_unlock': 'زمان قابل دریافت شدن هدیهٔ عضویت',
  'web.setting_referral_abuse_gift_unlock_desc':
    'وقتی «محافظ سوءاستفاده از معرفی» روشن است: هدیهٔ عضویت هر دو طرف پس از نخستین خرید پرداخت‌شده و تحویل‌شدهٔ کاربر معرفی‌شده قابل دریافت شود، یا مثل قبل بلافاصله پس از معرفی. سهم‌هایی که پیش‌تر پرداخت شده‌اند دست نمی‌خورند.',
  'web.setting_referral_abuse_referrer_daily_gift_cap': 'سقف روزانهٔ هدیهٔ معرف',
  'web.setting_referral_abuse_referrer_daily_gift_cap_desc':
    'بیشترین تعداد سهم هدیهٔ عضویت که هر معرف در یک روز (به وقت و تقویم فروشگاه) دریافت می‌کند. سهم بیش از سقف از بین نمی‌رود و روز بعد قابل دریافت است. سهم کاربر تازه سقف ندارد. خالی یعنی بدون سقف.',
  'web.setting_referral_abuse_referrer_daily_commission_cap': 'سقف روزانهٔ پورسانت معرف',
  'web.setting_referral_abuse_referrer_daily_commission_cap_desc':
    'بیشترین تعداد پورسانت خرید که هر معرف در یک روز دریافت می‌کند. پورسانت بیش از سقف باطل نمی‌شود؛ در انتظار می‌ماند و از روز بعد به همان قاعدهٔ همیشگی پرداخت می‌شود. خالی یعنی بدون سقف.',
  // R10 D5 (a): the /start captcha for new customers.
  'web.setting_captcha_expiry_seconds': 'مهلت پاسخ به سؤال امنیتی',
  'web.setting_captcha_expiry_seconds_desc':
    'هر سؤال تا این مدت قابل پاسخ است. پاسخ به سؤالی که مهلتش گذشته شمرده نمی‌شود و سؤال تازه‌ای پرسیده می‌شود.',
  'web.setting_captcha_max_attempts': 'تعداد پاسخ نادرست مجاز',
  'web.setting_captcha_max_attempts_desc':
    'پس از این تعداد پاسخ نادرست، کاربر تازه باید مدتی صبر کند. حساب او هرگز مسدود نمی‌شود.',
  'web.setting_captcha_cooldown_seconds': 'مدت انتظار پس از پاسخ‌های نادرست',
  'web.setting_captcha_cooldown_seconds_desc':
    'پس از پایان این مدت، با شروع دوبارهٔ ربات سؤال تازه‌ای پرسیده می‌شود و شمارش از نو آغاز می‌شود.',

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
  /*
   * v0.9.5: the Features page groups flags into categories (side list), says where each one is
   * seen and what switching it off does. `_off` keys are the plain-language effect for flags that
   * do NOT ask for confirmation; a flag that asks keeps its `_off_effect` key, which is both.
   */
  'web.features_search_label': 'جستجوی قابلیت',
  'web.features_search_placeholder': 'جستجو در نام و توضیح قابلیت‌ها…',
  'web.features_filter_label': 'فیلتر وضعیت',
  'web.features_filter_all': 'همه',
  'web.features_filter_on': 'روشن',
  'web.features_filter_off': 'خاموش',
  'web.features_categories_label': 'دسته‌ها',
  'web.features_no_match': 'قابلیتی با این جستجو و فیلتر پیدا نشد.',
  'web.features_cat_empty': 'در این دسته قابلیتی با این فیلتر نیست.',
  'web.features_results_label': 'نتیجهٔ جستجو',
  'web.feature_cat_reminders': 'اعلان‌ها و یادآوری‌ها',
  'web.feature_cat_sales': 'فروش و پرداخت',
  'web.feature_cat_customer': 'مشتری و حساب',
  'web.feature_cat_referral': 'دعوت و پاداش',
  'web.feature_cat_miniapp': 'مینی‌اپ',
  'web.feature_cat_bot': 'ربات و پیام‌ها',
  'web.feature_cat_panel': 'پنل و سرویس',
  'web.feature_cat_other': 'سایر',
  'web.feature_where_label': 'کجا دیده می‌شود',
  'web.feature_where_bot': 'ربات مشتری',
  'web.feature_where_miniapp': 'مینی‌اپ',
  'web.feature_where_ops_group': 'گروه گزارش‌ها',
  'web.feature_where_web_admin': 'پنل مدیریت',
  'web.feature_where_background': 'پس‌زمینه',
  'web.feature_off_label': 'اگر خاموش شود',
  'web.feature_open_settings': 'تنظیمات در',
  'web.feature_reseller_minimum_reminders_off':
    'نمایندگان پیش از پایان ماه یادآوری نمی‌گیرند که فروششان هنوز به حداقل ماهانه نرسیده است. چیز دیگری به این وابسته نیست.',
  'web.feature_reseller_minimum_achieved_notices_off':
    'به نماینده خبر داده نمی‌شود که فروش ماهانه‌اش به حداقل رسیده است. چیز دیگری به این وابسته نیست.',
  'web.feature_reminder_quiet_hours_off':
    'یادآورها در ساعات سکوت هم فرستاده می‌شوند. یادآوری‌ای که تا آن لحظه نگه داشته شده بود در نوبت بعدی ارسال فرستاده می‌شود و چیزی از بین نمی‌رود.',
  'web.feature_customer_link_rotation_off':
    'دکمهٔ گرفتن لینک جدید از ربات برداشته می‌شود. چرخش لینکی که از پیش زمان‌بندی شده باشد همچنان انجام می‌شود.',
  'web.feature_customer_refund_requests_off':
    'دکمهٔ درخواست بازپرداخت برداشته می‌شود و درخواست تازهٔ مشتری پذیرفته نمی‌شود. درخواست‌هایی که پیش‌تر ثبت شده‌اند را مدیر همچنان می‌تواند تعیین تکلیف کند.',
  'web.feature_referral_signup_gift_off':
    'دکمهٔ دریافت هدیه برداشته می‌شود و درخواست تازه رد می‌شود. سهم‌های پرداخت‌شده می‌مانند و سهم‌های دریافت‌نشده بعد از روشن شدن دوباره قابل دریافت‌اند.',
  'web.feature_referral_abuse_guard_off':
    'هدیه و پورسانت دوباره مثل پیش از روشن شدن این قابلیت عمل می‌کنند: شرط خرید و سقف روزانه اعمال نمی‌شود. هیچ موجودی‌ای تغییر نمی‌کند.',
  'web.feature_start_captcha_off':
    'از کاربران تازه سؤال پرسیده نمی‌شود و همهٔ کسانی که منتظر پاسخ بودند بلافاصله وارد می‌شوند.',
  'web.feature_phone_verification_off':
    'از هیچ مشتری‌ای دیگر شماره خواسته نمی‌شود و هر که منتظر تأیید بود بلافاصله وارد می‌شود. شماره‌های ذخیره‌شده و معافیت‌ها می‌مانند. شرط «تأیید شماره لازم است» هر درگاه جداگانه کار می‌کند و با خاموش شدن این گزینه تغییری نمی‌کند.',
  'web.feature_panel_auto_balancing_off':
    'هر سرویس جدید دوباره روی پنل خودِ محصول ساخته می‌شود. سرویس‌هایی که از پیش ساخته شده‌اند جابه‌جا نمی‌شوند.',
  'web.feature_custom_service_off':
    'دکمهٔ سرویس دلخواه برداشته می‌شود و پیش‌نویس و تأیید تازه رد می‌شود. سفارش‌هایی که پیش‌تر تأیید شده‌اند همچنان پرداخت و تحویل می‌شوند.',
  'web.feature_terms_enforcement_off':
    'همهٔ مشتریان بدون پذیرش قوانین وارد می‌شوند. هیچ پذیرشی پاک نمی‌شود.',
  'web.feature_rich_messages_off':
    'همهٔ صفحه‌ها دوباره به شکل پیام معمولی فرستاده می‌شوند. صفحه‌ای که پیش‌تر پیام غنی بوده به روش معمول ویرایش یا دوباره فرستاده می‌شود و چیزی از دست نمی‌رود.',
  'web.feature_rich_plan_table_off': 'فهرست پلن‌ها بدون جدول و به‌شکل پیش‌فرض نشان داده می‌شود.',
  'web.feature_rich_premium_emoji_off':
    'پیام‌های غنی ایموجی ساده دارند و ایموجی پریمیوم کشیده نمی‌شود.',
  'web.feature_terms_reprompt_off':
    'مشتری‌ای که یک بار قوانین را پذیرفته با انتشار نسخهٔ تازه دوباره پرسیده نمی‌شود.',
  'web.feature_addon_time_in_renew_menu_off':
    'بسته‌های زمان اضافه از منوی تمدید برداشته می‌شوند و فقط از دکمهٔ «خرید زمان اضافه» قابل خرید هستند.',
  'web.feature_services_search_label_button_off':
    'دکمهٔ «جستجوی نام کاربری» در فهرست سرویس‌های مشتری کشیده نمی‌شود (حالت پیش‌فرض). اگر دکمهٔ «🔎 جستجو» هم خاموش باشد، کل ردیف جستجو حذف می‌شود. چیزی پاک نمی‌شود.',
  'web.feature_services_search_button_off':
    'دکمهٔ «🔎 جستجو» در فهرست سرویس‌های مشتری کشیده نمی‌شود (حالت پیش‌فرض). اگر دکمهٔ «جستجوی نام کاربری» هم خاموش باشد، کل ردیف جستجو حذف می‌شود و ضربه روی دکمهٔ قدیمی با پیام «این دکمه دیگر فعال نیست» پاسخ داده می‌شود. چیزی پاک نمی‌شود.',
  'web.feature_personal_discount_off':
    'تخفیف شخصی اعمال نمی‌شود و قیمت‌ها همان قیمت معمول است؛ درصدهای ثبت‌شده می‌مانند. تأیید پیش‌نویسی که با تخفیف شخصی قیمت‌گذاری شده رد می‌شود و مشتری باید از اول شروع کند.',
  'web.feature_service_usage_chart_off':
    'نمودار مصرف در مینی‌اپ نشان داده نمی‌شود و دادهٔ مصرف تازه‌ای ذخیره نمی‌شود. داده‌های ذخیره‌شده می‌مانند.',
  'web.feature_custom_menu_buttons_off':
    'دکمه‌های سفارشی روی هیچ منویی نشان داده نمی‌شوند و ضربه روی دکمه‌ای که از پیش در چت مانده «در دسترس نیست» پاسخ می‌گیرد. دکمه‌ها و جایشان نگه داشته می‌شود.',
  'web.feature_referral_friends_list_off':
    'فهرست دوستان از صفحهٔ دعوت مینی‌اپ پنهان می‌شود. هیچ معرفی، پورسانت یا موجودی تغییر نمی‌کند.',
  'web.feature_miniapp_stars_invoice_off':
    'مینی‌اپ دوباره می‌گوید فاکتور در چت ربات است و ساخت لینک پرداخت رد می‌شود. پرداخت‌های انجام‌شده تغییر نمی‌کنند.',
  'web.feature_notification_centre_off':
    'زنگ اعلان‌ها از مینی‌اپ برداشته می‌شود. پیام‌های ذخیره‌شده و علامت‌های خوانده‌شده می‌مانند و ربات تغییری نمی‌کند.',
  'web.feature_location_remaining_display_off':
    'خط «تغییر لوکیشن باقی‌مانده» از کارت سرویس و مینی‌اپ حذف می‌شود. سقف تغییر و اجرای آن همان می‌ماند.',
  'web.feature_last_changed': 'آخرین تغییر',
  'web.feature_related_settings': 'تنظیمات مرتبط',
  'web.feature_setting_unset': 'تعیین نشده',
  'web.value_lines_separator': '؛ ',
  'web.value_field_handle': 'شناسه',
  'web.value_field_chat_id': 'شناسه گفتگو',
  'web.value_field_mandatory': 'اجباری',
  'web.value_field_amount': 'مبلغ',
  'web.value_field_currency': 'واحد پول',
  'web.secret_show': 'نمایش مقدار',
  'web.secret_hide': 'پنهان کردن مقدار',
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
  'web.feature_reseller_minimum_reminders_title': 'یادآوری حداقل فروش ماهانهٔ نمایندگان',
  'web.feature_reseller_minimum_reminders_summary':
    'چند روز پیش از پایان ماه، به نماینده‌ای که فروشش هنوز به حداقل ماهانه نرسیده یک بار یادآوری می‌شود. تا برای سطح یا نماینده‌ای حداقل تعیین نشود کاری نمی‌کند و هیچ پیامدی برای نماینده ندارد.',
  'web.feature_reseller_minimum_achieved_notices_title': 'پیام رسیدن به حداقل فروش ماهانه',
  'web.feature_reseller_minimum_achieved_notices_summary':
    'وقتی فروش ماهانهٔ نماینده به حداقل او برسد، یک بار در ماه به او خبر داده می‌شود.',
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
  'web.feature_customer_link_rotation_title': 'دریافت لینک جدید توسط مشتری',
  'web.feature_customer_link_rotation_summary':
    'مشتری می‌تواند از ربات برای سرویس فعال خود لینک اشتراک جدید بگیرد؛ فقط روی پنل‌هایی که این کار را پشتیبانی می‌کنند و با فاصلهٔ زمانی تعیین‌شده.',
  'web.feature_customer_refund_requests_title': 'درخواست بازپرداخت توسط مشتری',
  'web.feature_customer_refund_requests_summary':
    'مشتری می‌تواند از ربات برای سرویس پرداخت‌شدهٔ خود درخواست بازپرداخت ثبت کند. مبلغ را مدیر تعیین می‌کند و پس از حذف سرویس از پنل، به کیف پول مشتری واریز می‌شود.',
  'web.feature_customer_marketing_opt_out_title': 'اجازه قطع پیام‌های تبلیغاتی توسط مشتری',
  'web.feature_customer_marketing_opt_out_summary':
    'مشتری می‌تواند با /stop یا دکمهٔ «قطع پیام‌های تبلیغاتی» پیام‌های تبلیغاتی را برای خود قطع یا دوباره وصل کند و ارسال‌های تبلیغاتی انتخاب او را رعایت می‌کنند. پیام‌های پرداخت، سرویس و پشتیبانی همیشه ارسال می‌شوند.',
  'web.feature_customer_marketing_opt_out_off_effect':
    'دکمهٔ قطع پنهان می‌شود و /stop یا دکمه‌های قدیمی چیزی را تغییر نمی‌دهند. ارسال‌های تبلیغاتی به مشتریانی هم که قبلاً قطع کرده بودند فرستاده می‌شود — حتی ارسالی که پیش از خاموش‌کردن زمان‌بندی شده است، چون تصمیم در لحظهٔ ارسال گرفته می‌شود؛ انتخاب آن‌ها پاک نمی‌شود و با روشن‌کردن دوباره، دوباره اعمال می‌شود.',
  'web.feature_customer_reminder_opt_out_title': 'اجازه قطع یادآوری انقضا و حجم توسط مشتری',
  'web.feature_customer_reminder_opt_out_summary':
    'مشتری می‌تواند از صفحهٔ پشتیبانی ربات یا مینی‌اپ یادآوری‌های انقضا و حجم سرویس‌های خود را قطع یا دوباره وصل کند، و مدیر هم می‌تواند این را از صفحهٔ مشتری تنظیم کند. فقط یادآوری‌های انقضا و حجم قطع می‌شوند؛ پیام‌های پرداخت، تحویل سرویس، کیف پول، امنیت و پشتیبانی همیشه ارسال می‌شوند.',
  'web.feature_customer_reminder_opt_out_off_effect':
    'دکمه‌ها از ربات و مینی‌اپ برداشته می‌شوند و انتخاب قبلی مشتریان دیگر رعایت نمی‌شود: یادآوری‌های انقضا و حجم دوباره برای همهٔ مشتریان فرستاده می‌شود، حتی کسانی که قبلاً قطع کرده بودند. انتخاب آن‌ها پاک نمی‌شود و با روشن‌کردن دوباره، دوباره اعمال می‌شود.',
  'web.feature_referrals_title': 'برنامهٔ معرفی (زیرمجموعه‌گیری)',
  'web.feature_referrals_summary':
    'مشتری با لینک اختصاصی خود دیگران را معرفی می‌کند و از خریدهای آن‌ها پورسانت به کیف پولش واریز می‌شود. درصد پورسانت باید در تنظیمات تعیین شده باشد.',
  'web.feature_referrals_off_effect':
    'کسانی که در این مدت با لینک معرفی عضو شوند بدون معرف ثبت می‌شوند و بعداً هم به معرف وصل نخواهند شد. پورسانت‌هایی که پیش‌تر وعده داده شده‌اند همچنان پرداخت می‌شوند.',
  'web.feature_referral_signup_gift_title': 'هدیهٔ عضویت با معرفی',
  'web.feature_referral_signup_gift_summary':
    'برای هر معرفی معتبر، مبلغ هدیه میان معرف و کاربر جدید تقسیم می‌شود و هر کدام یک بار سهم خود را دریافت می‌کنند.',
  // R10 D5.
  'web.feature_referral_abuse_guard_title': 'محافظ سوءاستفاده از معرفی',
  'web.feature_referral_abuse_guard_summary':
    'هدیهٔ عضویت فقط پس از نخستین خرید پرداخت‌شده و تحویل‌شدهٔ کاربر معرفی‌شده قابل دریافت می‌شود و برای هدیه و پورسانت هر معرف سقف روزانه می‌توان گذاشت. موجودی‌ها و سهم‌های پرداخت‌شده دست نمی‌خورند.',
  'web.feature_start_captcha_title': 'سؤال امنیتی شروع (کپچا)',
  'web.feature_start_captcha_summary':
    'از هر کاربر تازه پیش از استفاده از ربات یک سؤال ساده (جمع دو عدد با چهار گزینه) پرسیده می‌شود. کاربران فعلی و مدیران هرگز پرسیده نمی‌شوند و پاسخ نادرست به مسدودی نمی‌انجامد.',
  // R11 B7.
  'web.feature_phone_verification_title': 'تأیید شماره تلفن کاربران',
  // NEXA v095 PR-4 A: off or MANDATORY; the gateway rule works on its own either way.
  'web.feature_phone_verification_summary':
    'روشن یعنی اجباری: مشتری‌ای که شمارهٔ تأییدشده یا معافیت ندارد، پیش از هر کاری در ربات و مینی‌اپ (استارت، هر دکمه، هر پیام یا فرمان) باید با «📞 Share Contact» شمارهٔ خود حساب تلگرامش را تأیید کند؛ بعد از کپچا و قوانین. مشتری‌هایی که قبلاً تأیید شده‌اند چیزی نمی‌بینند و مدیران هرگز متوقف نمی‌شوند. شرط «برای پرداخت با این درگاه، تأیید شماره لازم است» روی هر درگاه جداگانه و حتی با خاموش بودن این گزینه کار می‌کند.',
  'web.feature_phone_verification_confirm_question': 'تأیید شماره برای همه اجباری شود؟',
  'web.feature_phone_verification_confirm_detail':
    'از همین حالا هر مشتری‌ای که شمارهٔ تأییدشده یا معافیت ندارد، در پیام بعدی‌اش به صفحهٔ تأیید شماره می‌رود و تا تأیید نکند کار دیگری در ربات و مینی‌اپ نمی‌تواند انجام دهد. پرداخت‌ها، تحویل سرویس و یادآوری‌ها در پس‌زمینه ادامه می‌یابند. خاموش کردن از هیچ‌کس شماره نمی‌خواهد.',
  'web.feature_phone_verification_confirm': 'اجباری کن',
  // A flag from a newer server that this panel build has no entry for.
  'web.feature_unknown_off_effect':
    'این قابلیت برای این نسخه از پنل ناشناخته است و خاموش کردن آن ممکن است بخشی از کار ربات را متوقف کند.',
  'web.feature_custom_service_title': 'سرویس دلخواه',
  'web.feature_custom_service_summary':
    'مشتری موقعیت، حجم و مدت دلخواه خود را انتخاب می‌کند و قیمت بر اساس قیمت هر گیگابایت و هر روز محاسبه می‌شود.',
  'web.feature_central_fx_title': 'نرخ ارز مرکزی',
  'web.feature_terms_reprompt_title': 'درخواست پذیرش دوباره پس از انتشار نسخهٔ تازه',
  'web.feature_terms_reprompt_summary':
    'خاموش (پیش‌فرض): مشتری‌ای که یک بار قوانین را پذیرفته — در این ربات یا در ربات قبلی — دیگر هرگز پرسیده نمی‌شود، حتی اگر متن قوانین ویرایش شود. روشن: با هر نسخهٔ تازه همه باید دوباره بپذیرند.',
  'web.feature_terms_reprompt_confirm_question': 'پذیرش دوباره پس از هر نسخهٔ تازه روشن شود؟',
  'web.feature_terms_reprompt_confirm_detail':
    'از همین لحظه، تا وقتی الزام پذیرش روشن است، هر مشتری‌ای که نسخهٔ فعلی را نپذیرفته — حتی اگر نسخهٔ قبلی را پذیرفته باشد — تا پذیرش آن نمی‌تواند از ربات استفاده کند.',
  'web.feature_wallet_admin_credit_notice_title': 'پیام افزایش موجودی دستی به مشتری',
  'web.feature_wallet_admin_credit_notice_summary':
    'وقتی ادمین کیف پول مشتری را دستی شارژ می‌کند، به مشتری مبلغ و موجودی جدید گفته می‌شود؛ دلیل فقط اگر «نمایش دلیل به مشتری» زده شده باشد. برای موجودی منتقل‌شده از ربات قبلی هرگز پیامی فرستاده نمی‌شود.',
  'web.feature_wallet_admin_debit_notice_title': 'پیام کسر موجودی دستی به مشتری',
  'web.feature_wallet_admin_debit_notice_summary':
    'وقتی ادمین از کیف پول مشتری دستی کسر می‌کند، به مشتری مبلغ و موجودی جدید گفته می‌شود؛ دلیل فقط اگر «نمایش دلیل به مشتری» زده شده باشد.',
  'web.feature_wallet_admin_notice_off_effect':
    'تا وقتی خاموش است، تغییرهای دستی موجودی به مشتری گفته نمی‌شود و روشن کردن دوباره، پیام تغییرهای این مدت را نمی‌فرستد.',
  'web.feature_service_auto_renew_title': 'تمدید خودکار سرویس',
  // NEXA-OWNER-BATCH-1 PR-3: the automatic deletion of finished services.
  'web.feature_service_auto_delete_title': 'حذف خودکار سرویس‌های پایان‌یافته',
  'web.feature_service_auto_delete_summary':
    'سرویس منقضی یا معلق، پس از تعداد روزی که در تنظیمات «سرویس‌ها» تعیین می‌کنید، از پنل حذف می‌شود؛ همان «پایان سرویس» ادمین، بدون بازگشت وجه. مشتری یک بار پیش از حذف با دکمهٔ تمدید باخبر می‌شود و سرویس تمدیدشده یا دارای سفارش و پرداخت باز حذف نمی‌شود.',
  'web.feature_service_auto_delete_off_effect':
    'هشدار و حذف تازه‌ای انجام نمی‌شود؛ حذف‌هایی که پیش‌تر در صف پنل گذاشته شده‌اند ادامه می‌یابند.',
  'web.feature_service_auto_delete_on_question': 'حذف خودکار سرویس‌ها روشن شود؟',
  'web.feature_service_auto_delete_on_detail':
    'از این پس سرویس‌های منقضی و معلق طبق تنظیمات، پس از هشدار به مشتری، از پنل حذف می‌شوند و این کار برگشت‌پذیر نیست.',
  'web.feature_service_auto_delete_on_confirm': 'بله، روشن شود',
  'web.auto_delete_preview_lead': 'با این تنظیمات،',
  'web.auto_delete_preview_tail': 'سرویس در 24 ساعت آینده حذف می‌شود',
  'web.auto_delete_preview_traffic': 'پایان حجم:',
  'web.auto_delete_preview_time': 'پایان زمان:',
  'web.auto_delete_preview_suspended': 'معلق:',
  'web.auto_delete_preview_separator': '،',
  'web.auto_delete_preview_note':
    'شمارش سرور است و تا حداکثر حذف در دقیقه برای هر پنل، آرام‌آرام انجام می‌شود.',
  'web.auto_delete_preview_loading': 'در حال شمارش سرویس‌هایی که حذف می‌شوند…',
  'web.auto_delete_preview_unavailable': 'شمار سرویس‌هایی که حذف می‌شوند خوانده نشد.',
  'web.setting_auto_delete_after_traffic_days': 'حذف پس از پایان حجم',
  'web.setting_auto_delete_after_traffic_days_desc':
    'چند روز پس از آن‌که سرویس به‌خاطر پایان حجم منقضی شد، از پنل حذف شود. 0 یعنی خاموش.',
  'web.setting_auto_delete_after_time_days': 'حذف پس از پایان زمان',
  'web.setting_auto_delete_after_time_days_desc':
    'چند روز پس از آن‌که زمان سرویس تمام شد، از پنل حذف شود. 0 یعنی خاموش.',
  'web.setting_auto_delete_after_suspend_days': 'حذف پس از تعلیق',
  'web.setting_auto_delete_after_suspend_days_desc':
    'چند روز پس از آن‌که سرویس معلق شد، از پنل حذف شود. 0 یعنی خاموش.',
  'web.setting_auto_delete_warn_hours': 'هشدار پیش از حذف',
  'web.setting_auto_delete_warn_hours_desc':
    'چند ساعت پیش از حذف، یک پیام با دکمهٔ تمدید برای مشتری فرستاده شود. سرویس زودتر از این پس از هشدار حذف نمی‌شود. 0 یعنی بدون هشدار.',
  'web.setting_auto_delete_max_per_minute': 'حداکثر حذف در دقیقه برای هر پنل',
  'web.setting_auto_delete_max_per_minute_desc':
    'حذف‌ها با این سرعت در صف پنل گذاشته می‌شوند تا پنل یک‌باره زیر بار نرود.',
  'web.feature_service_auto_renew_summary':
    'مشتری می‌تواند برای هر سرویس خود از ربات یا مینی‌اپ «تمدید خودکار» را روشن کند. چند ساعت پیش از پایان اعتبار، سرویس از موجودی کیف پول و با همان قیمت‌گذاری تمدید معمول تمدید می‌شود، مشروط بر اینکه موجودی کافی باشد و قیمت از مبلغ مورد توافق مشتری بیشتر نشده باشد.',
  'web.feature_service_auto_renew_off_effect':
    'با خاموش شدن، هیچ تمدید خودکار تازه‌ای انجام نمی‌شود و سرویس مشتریانی که آن را روشن کرده‌اند خودکار تمدید نمی‌شود؛ انتخاب مشتریان نگه داشته می‌شود و با روشن کردن دوباره، از دورهٔ بعد ادامه پیدا می‌کند.',
  'web.feature_notification_centre_title': 'مرکز اعلان‌های مشتری در مینی‌اپ',
  'web.feature_notification_centre_summary':
    'در مینی‌اپ یک زنگ با شمارندهٔ خوانده‌نشده‌ها نشان داده می‌شود. مشتری فهرست پیام‌هایی را که ربات برایش فرستاده است (نتیجهٔ پرداخت و سفارش، یادآوری‌ها، پاسخ پشتیبانی، پیام ادمین) می‌بیند؛ پیام‌های گروه گزارش‌ها هرگز نمایش داده نمی‌شوند.',
  'web.feature_location_remaining_display_title': 'نمایش تغییر لوکیشن باقی‌مانده',
  'web.feature_location_remaining_display_summary':
    'در کارت سرویس ربات و در مینی‌اپ نوشته می‌شود که مشتری چند بار دیگر می‌تواند لوکیشن سرویس را عوض کند. این خط فقط وقتی دیده می‌شود که تغییر لوکیشن برای آن سرویس فعال و سقفی تعیین شده باشد.',
  'web.feature_mini_app_title': 'مینی‌اپ تلگرام',
  'web.feature_mini_app_summary':
    'یک دکمهٔ منو کنار کادر پیام ربات، که مینی‌اپ فروشگاه را باز می‌کند. مینی‌اپ فقط همان کارهای ربات (خرید، تمدید، کیف پول، پشتیبانی) را با همان قیمت‌ها و قوانین انجام می‌دهد.',
  'web.feature_mini_app_off_effect':
    'با خاموش شدن، دکمهٔ منو در همگام‌سازی بعدی برداشته می‌شود و مینی‌اپ دیگر باز نمی‌شود؛ خریدها و پرداخت‌های ثبت‌شده مثل همیشه ادامه پیدا می‌کنند.',
  'web.feature_miniapp_stars_invoice_title': 'پرداخت با تلگرام استارز داخل مینی‌اپ',
  'web.feature_miniapp_stars_invoice_summary':
    'مشتری فاکتور استارز سفارش را داخل مینی‌اپ پرداخت می‌کند، بدون رفتن به چت ربات. فقط وقتی کار می‌کند که روش پرداخت استارز برای همان سفارش در ربات هم عرضه شود.',
  'web.feature_service_usage_chart_title': 'نمودار مصرف سرویس در مینی‌اپ',
  'web.feature_service_usage_chart_summary':
    'در صفحهٔ هر سرویس در مینی‌اپ، نموداری از حجم مصرف‌شده در 7 یا 30 روز گذشته نشان داده می‌شود. نمودار از همان عددهای مصرفی ساخته می‌شود که Nexa از پنل می‌خواند و درخواست تازه‌ای به پنل نمی‌فرستد.',
  'web.feature_gift_cards_title': 'کارت هدیه (کد شارژ کیف پول)',
  'web.feature_gift_cards_summary':
    'ادمین در صفحهٔ «کارت‌های هدیه» دسته‌ای از کدهای شارژ می‌سازد؛ مشتری کد را در ربات یا مینی‌اپ وارد می‌کند و مبلغ آن به کیف پولش اضافه می‌شود. هر کد فقط یک بار استفاده می‌شود.',
  'web.feature_gift_cards_off_effect':
    'تا وقتی خاموش است مشتری‌ها نمی‌توانند کد وارد کنند؛ کدها باطل نمی‌شوند و با روشن شدن دوباره کار می‌کنند، اما کدی که در این مدت به تاریخ انقضایش برسد دیگر قابل استفاده نیست.',
  'web.feature_personal_discount_title': 'تخفیف شخصی مشتری',
  'web.feature_personal_discount_summary':
    'درصد تخفیفی که در صفحهٔ هر مشتری تعیین می‌شود روی خرید و تمدید سرویس او اعمال می‌شود، نه روی شارژ کیف پول. تخفیف‌ها جمع نمی‌شوند: قیمت یک بار به روش معمول و یک بار با تخفیف شخصی حساب می‌شود و کمتر از این دو گرفته می‌شود.',
  // R11 B3.
  'web.feature_referral_friends_list_title': 'فهرست دوستان دعوت‌شده در مینی‌اپ',
  'web.feature_referral_friends_list_summary':
    'در صفحهٔ «دعوت دوستان» مینی‌اپ، مشتری فهرست دوستانی را می‌بیند که با لینک او آمده‌اند: نام کوچک یا نام کاربری نیمه‌پنهان، تاریخ پیوستن و وضعیت. این فهرست فقط خواندنی است و هیچ پولی جابه‌جا نمی‌کند.',
  'web.feature_custom_menu_buttons_title': 'دکمه‌های دلخواه منوی اصلی',
  'web.feature_custom_menu_buttons_summary':
    'دکمه‌هایی که خودتان به منوی اصلی ربات اضافه می‌کنید: یک لینک، یا یک متن، عکس یا فایل که ربات می‌فرستد. چیدمان از بخش «دکمه‌های ربات» انجام می‌شود.',
  'web.feature_addon_time_in_renew_menu_title': 'نمایش زمان اضافه داخل تمدید هم',
  'web.feature_addon_time_in_renew_menu_summary':
    'روشن (پیش‌فرض): بسته‌های زمان اضافه علاوه بر دکمهٔ «خرید زمان اضافه» در منوی «تمدید سرویس» هم نشان داده می‌شوند. خاموش: فقط از دکمهٔ «خرید زمان اضافه» قابل خرید هستند و از منوی تمدید حذف می‌شوند.',
  'web.feature_services_search_label_button_title': 'دکمهٔ «جستجوی نام کاربری» در سرویس‌های من',
  'web.feature_services_search_label_button_summary':
    'روشن: در فهرست «سرویس‌های من» ربات، دکمهٔ «جستجوی نام کاربری» بالای دکمه‌های صفحه‌بندی نشان داده می‌شود و با ضربه روی آن مشتری نام کاربری سرویسش را برای جستجو می‌فرستد. خاموش (پیش‌فرض): این دکمه کشیده نمی‌شود؛ اگر دکمهٔ «🔎 جستجو» هم خاموش باشد، کل ردیف جستجو حذف می‌شود و اگر آن روشن باشد فقط همان دکمه می‌ماند. متن دکمه از بخش متن‌ها (bot.service.search_label_button) تغییر می‌کند.',
  'web.feature_services_search_button_title': 'دکمهٔ «🔎 جستجو» در سرویس‌های من',
  'web.feature_services_search_button_summary':
    'روشن: در فهرست «سرویس‌های من» ربات، دکمهٔ «🔎 جستجو» نشان داده می‌شود و با ضربه روی آن مشتری نام کاربری سرویسش را برای جستجو می‌فرستد. خاموش (پیش‌فرض): این دکمه کشیده نمی‌شود؛ اگر دکمهٔ «جستجوی نام کاربری» هم خاموش باشد، کل ردیف جستجو حذف می‌شود و ضربه روی دکمهٔ قدیمی که پیش از خاموش شدن کشیده شده بود با «این دکمه دیگر فعال نیست» پاسخ داده می‌شود و فهرست همان‌جا دوباره کشیده می‌شود. متن دکمه از بخش متن‌ها (bot.service.search_button) تغییر می‌کند.',
  'web.feature_rich_messages_title': 'دکمه‌های داخل پیام',
  'web.feature_rich_messages_summary':
    'صفحه‌های دکمه‌دار ربات به‌صورت «پیام غنی» تلگرام فرستاده می‌شوند و دکمه‌ها داخل خود پیام قرار می‌گیرند. صفحه‌ای که تلگرام نپذیرد به روش معمول فرستاده می‌شود.',
  'web.feature_rich_plan_table_title': 'نمایش پلن‌ها به‌صورت جدول',
  'web.feature_rich_plan_table_summary':
    'فهرست پلن‌های هر دسته بالای دکمه‌های پلن، یک جدول (سرویس، حجم، مدت، قیمت) هم نشان می‌دهد. پیش‌فرض خاموش است و فقط وقتی «دکمه‌های داخل پیام» روشن باشد اثر دارد؛ خاموش، فهرست پلن‌ها بدون جدول و دقیقاً مثل قبل فرستاده می‌شود.',
  'web.feature_rich_premium_emoji_title': 'ایموجی پریمیوم',
  'web.feature_rich_premium_emoji_summary':
    'در پیام‌های غنی، ایموجی‌های «ظاهر ربات» به‌صورت ایموجی پریمیوم کشیده می‌شوند — فقط برای رباتی که پیام آزمایشی‌اش موفق بوده است. بدون «دکمه‌های داخل پیام» اثری ندارد؛ اگر تلگرام نپذیرد، صفحه با ایموجی معمولی فرستاده می‌شود.',
  'web.feature_terms_enforcement_title': 'الزام پذیرش قوانین',
  'web.feature_terms_enforcement_summary':
    'مشتری‌ای که نسخهٔ فعلی قوانین را نپذیرفته، پیش از هر کاری در ربات قوانین و دکمهٔ پذیرش را می‌بیند. متن و نسخه‌ها در صفحهٔ «قوانین و مقررات» مدیریت می‌شود.',
  'web.feature_central_fx_summary':
    'نرخ تتر به تومان از صرافی عمومی (نوبیتکس، و والکس به‌عنوان پشتیبان) خوانده و تازه نگه داشته می‌شود تا روش‌های پرداختی که با آن قیمت‌گذاری می‌شوند از یک نرخ واحد استفاده کنند. قیمت هر ستارهٔ تلگرام همیشه از همین نرخ و «تعداد استارز به ازای هر تتر» محاسبه می‌شود و نرخ دستی ندارد.',
  'web.feature_central_fx_off_effect':
    'با خاموش شدن، خواندن نرخ متوقف می‌شود و روش‌هایی که با نرخ مرکزی قیمت‌گذاری می‌شوند (از جمله استارز تلگرام) فاکتور جدید صادر نمی‌کنند (فاکتورهای صادرشده نرخ ثبت‌شدهٔ خودشان را نگه می‌دارند).',

  // Maturity — what a surface may claim about a capability
  'web.maturity_now': 'فعال',
  'web.maturity_now_help': 'همین نسخه این کار را انجام می‌دهد.',
  'web.maturity_ready': 'آمادهٔ سرور',
  'web.maturity_ready_help': 'سمت سرور وجود دارد اما هنوز مصرف‌کننده‌ای ندارد.',
  'web.maturity_planned': 'برنامه‌ریزی‌شده',
  'web.maturity_planned_help': 'در این نسخه وجود ندارد و کاری انجام نمی‌دهد.',
  'web.maturity_unsupported': 'پشتیبانی‌نشده',
  'web.maturity_unsupported_help': 'خودِ نرم‌افزار پنل این قابلیت را ندارد.',
  'web.setting_backup_local_copies': 'کپی‌های محلی بکاپ‌های ارسال‌شده',
  'web.setting_backup_local_copies_desc':
    'چند بکاپ که همه‌ی بخش‌هایشان به تلگرام رسیده، روی سرور هم نگه داشته شوند (0 یعنی هیچ). بکاپی که ارسالش ناقص یا نامعلوم است هرگز با این تنظیم پاک نمی‌شود.',
  'web.setting_retention_outbox': 'نگه‌داری رویدادهای منتشرشده',
  'web.setting_retention_outbox_desc':
    'رویدادهای منتشرشده‌ی صف خروجی پس از چند روز پاک شوند. رویدادی که هنوز منتشر نشده هرگز پاک نمی‌شود.',
  'web.setting_retention_idempotency': 'نگه‌داری کلیدهای تکرارناپذیری',
  'web.setting_retention_idempotency_desc':
    'کلیدهای پنل وب و تلگرام پس از چند روز پاک شوند. کلیدهای کارهای پس‌زمینه و انتقال داده هرگز پاک نمی‌شوند.',
  // Round 9 C3 — the data compaction (settings and its dry run).
  'web.setting_compaction_mode': 'حالت فشرده‌سازی داده‌های قدیمی',
  'web.setting_compaction_mode_desc':
    'در حالت «حذف»، که حالت آغازین است، هر شب اعلان‌های تمام‌شده و پنجره‌های بسته‌ی رسید که از مدت نگه‌داری گذشته‌اند حذف می‌شوند. در حالت «فقط شمارش» فقط شمرده می‌شود چه چیزی حذف خواهد شد و هیچ ردیفی حذف نمی‌شود. دفتر کیف پول، پرداخت‌ها، سفارش‌ها، سرویس‌ها، رسیدها، بازگشت وجه‌ها و سوابق ممیزی هرگز حذف نمی‌شوند.',
  'web.setting_compaction_ops_days': 'نگه‌داری اعلان‌های گروه عملیات',
  'web.setting_compaction_ops_days_desc':
    'پیام‌های گروه عملیات که ارسال شده یا ناموفق مانده‌اند، همراه با سابقه‌ی تلاش‌های ارسالشان، پس از چند روز حذف شوند. پیامی که هنوز در صف است هرگز حذف نمی‌شود.',
  'web.setting_compaction_customer_days': 'نگه‌داری اعلان‌های کاربران',
  'web.setting_compaction_customer_days_desc':
    'اعلان‌های تمام‌شده‌ی کاربران از نوع یادآوری سرویس، کمبود موجودی، حداقل فروش نماینده و نتیجه‌ی عملیات اعلام‌شده پس از چند روز حذف شوند. اعلان در صف یا نامعلوم، و هر اعلانی درباره‌ی پرداخت، سفارش، بازگشت وجه، کیف پول، تیکت یا پیام مستقیم هرگز حذف نمی‌شود.',
  'web.setting_compaction_receipt_days': 'نگه‌داری پنجره‌های بسته‌ی رسید',
  'web.setting_compaction_receipt_days_desc':
    'پنجره‌های بسته‌ای که ربات در آن منتظر عکس رسید بود پس از چند روز حذف شوند. پنجره‌ی باز، خود رسید و رسید ارسال‌شده به درگاه هرگز حذف نمی‌شوند.',
  'web.setting_topup_minimum': 'کمینهٔ شارژ کیف پول',
  'web.setting_sales_currency': 'واحد پول فروشگاه',
  'web.setting_topup_presets': 'مبالغ شارژ کیف پول',
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
  'web.setting_reseller_request_cooldown_days': 'فاصلهٔ درخواست مجدد نمایندگی پس از رد',
  'web.setting_reseller_request_cooldown_days_desc':
    'مشتری‌ای که درخواست نمایندگی‌اش رد شده، تا این تعداد روز نمی‌تواند درخواست تازه بدهد. صفر یعنی بدون انتظار.',
  'web.feature_reseller_requests_title': 'درخواست نمایندگی از ربات',
  'web.feature_reseller_requests_summary':
    'دکمهٔ «درخواست نمایندگی» در منوی ربات نمایش داده می‌شود. مشتری به سؤال‌هایی که شما تعریف کرده‌اید پاسخ می‌دهد و درخواست او در گروه گزارش و در بخش «درخواست‌های نمایندگی» پنل دیده می‌شود. می‌توانید پیش از تصمیم با او گفتگو کنید، سپس با انتخاب سطح نماینده‌اش کنید یا رد کنید.',
  'web.feature_reseller_requests_off_effect':
    'دکمه از منوی ربات برداشته می‌شود و کسی نمی‌تواند درخواست تازه شروع کند. درخواست‌های ثبت‌شده و گفتگوی آن‌ها سر جایش می‌ماند و هنوز قابل تصمیم‌گیری است.',
  'web.setting_reminders_reseller_minimum_days':
    'یادآوری حداقل فروش نمایندگان (روز پیش از پایان ماه)',
  'web.setting_reminders_reseller_minimum_days_desc':
    'چند روز مانده به پایان ماه تقویمی، نماینده‌ای که هنوز به حداقل فروش ماهانه نرسیده یک بار یادآوری بگیرد؛ از 1 تا 10 روز.',
  'web.setting_reminders_payment_pending_minutes': 'زمان یادآور پرداخت در انتظار',
  'web.setting_reminders_max_per_minute': 'سقف ارسال یادآورها در هر دقیقه',
  'web.setting_reminders_max_per_minute_desc':
    'بیشترین تعداد یادآور خودکار (انقضا، حجم، کیف پول، پرداخت و سفارش در انتظار، حداقل فروش نماینده) که در یک دقیقه برای مشتریان فرستاده می‌شود. بقیه برای دقیقهٔ بعد می‌مانند؛ پاسخ‌ها و نتیجهٔ پرداخت و سفارش هیچ‌وقت منتظر این سقف نمی‌مانند.',
  'web.setting_reminders_burst_alarm_per_hour': 'هشدار هجوم یادآور (در هر ساعت)',
  'web.setting_reminders_burst_alarm_per_hour_desc':
    'اگر در یک ساعت بیش از این تعداد یادآور تازه ساخته و فرستاده شود، یک بار در تاپیک خطاهای گروه گزارش خبر داده می‌شود و وقتی یک ساعت زیر این عدد بگذرد، رفع آن هم اعلام می‌شود. یادآورهایی که ساعت سکوت نگه داشته بود حساب نمی‌شوند. صفر یعنی هشدار خاموش است؛ سقف دقیقه‌ای همچنان اعمال می‌شود.',
  'web.setting_wallet_low_balance_threshold': 'آستانهٔ هشدار کمبود موجودی کیف پول',
  'web.flag_service_expiry_day_reminder': 'یادآور روز انقضای سرویس',
  'web.flag_wallet_low_balance_reminders': 'هشدار کمبود موجودی کیف پول',
  'web.flag_payment_pending_reminders': 'یادآور پرداخت در انتظار',
  // HF-A9: quiet hours.
  'web.setting_reminders_quiet_hours_start': 'شروع ساعات سکوت یادآورها',
  'web.setting_reminders_quiet_hours_end': 'پایان ساعات سکوت یادآورها',
  'web.flag_reminder_quiet_hours': 'ساعات سکوت یادآورها',
  // WP6-A: the trial's two settings. Its flag and the product picker went in F5.
  'web.setting_trial_product_id': 'محصول سرویس آزمایشی (بازنشسته)',
  'web.setting_trial_limit_per_customer': 'تعداد مجاز سرویس آزمایشی برای هر مشتری',
  'web.flag_customer_link_rotation': 'دریافت لینک اشتراک جدید توسط مشتری',
  'web.setting_link_rotation_cooldown_hours': 'فاصلهٔ مجاز بین دو درخواست لینک جدید',
  'web.setting_miniapp_init_data_max_age_seconds': 'اعتبار ورود به مینی‌اپ',
  'web.setting_miniapp_session_ttl_minutes': 'مدت هر نشست مینی‌اپ',
  'web.setting_auto_renew_lead_hours': 'فاصلهٔ تمدید خودکار تا انقضا',
  'web.flag_referral_signup_gift': 'هدیهٔ عضویت از طریق معرفی',
  'web.flag_referral_abuse_guard': 'محافظ سوءاستفاده از معرفی',
  'web.flag_start_captcha': 'سؤال امنیتی شروع (کپچا)',
  'web.flag_phone_verification': 'تأیید شماره تلفن کاربران',
  'web.setting_referral_signup_gift_total': 'مبلغ کل هدیهٔ عضویت',
  'web.setting_referral_signup_gift_referrer_percent': 'سهم معرف از هدیهٔ عضویت',
  'web.setting_referral_signup_gift_referred_percent': 'سهم کاربر معرفی‌شده از هدیهٔ عضویت',
  'web.setting_connection_files_mode_desc':
    'برای هر پنل جدا، در صفحهٔ همان پنل، بخش «فایل‌های اتصال» تنظیم می‌شود.',
  'web.setting_connection_files_template_desc':
    'قالب توضیح سفارشی هر پنل، در صفحهٔ همان پنل، بخش «فایل‌های اتصال».',
  'web.setting_connection_files_placement_desc':
    'اینکه توضیح زیر آخرین فایل بیاید یا زیر همهٔ فایل‌ها؛ برای هر پنل جدا.',
  'web.setting_bot_main_menu': 'دکمه‌های منوی اصلی ربات',
  'web.setting_bot_inline_buttons': 'سبک دکمه‌های شیشه‌ای ربات',
  'web.setting_bot_inline_buttons_desc':
    'رنگ (سبک) هر دکمهٔ شیشه‌ای مشتری؛ در صفحهٔ «دکمه‌های ربات»، بخش «دکمه‌های شیشه‌ای ربات» ویرایش می‌شود.',
  'web.setting_bot_inline_button_icons': 'آیکون پریمیوم دکمه‌های شیشه‌ای ربات',
  'web.setting_bot_inline_button_icons_desc':
    'شناسهٔ شکلک سفارشی (پریمیوم) تلگرام برای هر دکمهٔ شیشه‌ای، اختیاری؛ در صفحهٔ «دکمه‌های ربات» تنظیم می‌شود.',
  'web.setting_bot_category_colors': 'رنگ دکمهٔ دسته‌بندی‌ها',
  'web.setting_bot_category_colors_desc':
    'رنگ دکمهٔ هر دسته‌بندی محصول در فروشگاه ربات؛ در صفحهٔ «🎨 ظاهر ربات»، بخش «رنگ دسته‌بندی‌ها» ویرایش می‌شود.',
  'web.setting_bot_category_icons': 'آیکون دسته‌بندی‌ها',
  'web.setting_bot_category_icons_desc':
    'آیکون پریمیوم قبل از نام و ایموجی معمولی بعد از نام هر دسته‌بندی؛ در صفحهٔ «دسته‌بندی‌ها» ویرایش می‌شود.',
  // Phase 2 item 4: the subscription QR on the tenant's own background.
  'web.setting_delivery_qr_template': 'جای کد کیوآر روی پس‌زمینه',
  'web.setting_delivery_qr_template_desc':
    'جای کد کیوآر لینک اشتراک روی تصویر پس‌زمینه. در «🎨 ظاهر ربات»، بخش «پس‌زمینهٔ کد کیوآر» تنظیم می‌شود.',
  'web.setting_bot_main_menu_desc':
    'ترتیب و نمایش دکمه‌های منوی اصلی ربات؛ در صفحهٔ «دکمه‌های ربات» ویرایش می‌شود.',
  // --- Automatic panel balancing (Phase C3) ------------------------------------
  'web.flag_panel_auto_balancing': 'توزیع خودکار سرویس بین پنل‌ها',
  'web.feature_panel_auto_balancing_title': 'توزیع خودکار سرویس بین پنل‌ها',
  'web.feature_panel_auto_balancing_summary':
    'هر سرویس جدید روی بهترین پنلِ واجد شرایط از گروه توزیعِ پنلِ محصول ساخته می‌شود: پنل‌های سالم اول، سپس بر اساس شیوهٔ توزیع. پنلی که در هیچ گروهی نیست مثل قبل عمل می‌کند و هیچ سرویس موجودی جابه‌جا نمی‌شود.',
  'web.setting_panels_balancing_strategy': 'شیوهٔ توزیع بین پنل‌ها',
  'web.setting_panels_balancing_strategy_desc':
    'پس از مقایسهٔ سلامت، پنل‌های واجد شرایط یک گروه با این معیار مرتب می‌شوند. در تساوی، پنل خودِ محصول و سپس کوچک‌ترین شناسه انتخاب می‌شود.',
  'web.flag_custom_service': 'سرویس دلخواه',
  'web.feature_unknown_summary':
    'این قابلیت برای این نسخهٔ پنل مدیریت شناخته نیست؛ توضیح سرور در جزئیات فنی آمده است.',
  'web.settings_unknown_note': 'این تنظیم برای پنل مدیریت شناخته نیست. صفحه را تازه کنید.',
  'web.setting_no_consumer_note': 'این تنظیم ذخیره می‌شود اما فعلاً روی رفتار ربات اثری ندارد.',
} as const;
