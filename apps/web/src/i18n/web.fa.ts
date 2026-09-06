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
  'web.test_sent': 'پیام آزمایشی در صف قرار گرفت.',
  'web.destination_missing': 'مقصد اعلان‌ها هنوز تنظیم نشده است.',

  // Concurrency and repair
  'web.changed_elsewhere':
    'این مقدار پس از آغاز ویرایش شما جای دیگری تغییر کرده است. ذخیره‌کردن با خطای تداخل روبه‌رو می‌شود.',
  'web.reload_value': 'گرفتن مقدار تازه',
  'web.stored_value_invalid':
    'مقدار ذخیره‌شده با تعریف این کلید نمی‌خواند، پس پیش‌فرض اعمال می‌شود. ذخیره‌کردن یک مقدار معتبر آن را اصلاح می‌کند.',
  'web.unsaved_changes': 'تغییرات ذخیره‌نشده دارید.',
  'web.preview_stale': 'متن پس از این پیش‌نمایش تغییر کرده است. دوباره پیش‌نمایش بگیرید.',
  'web.discard': 'دورانداختن تغییرات',
  'web.sample_number': 'یک عدد درست، مثلاً ۳۰',
  'web.sample_datetime': 'یک تاریخ، مثلاً 2026-09-02T08:00:00Z',
  'web.sample_money': 'مبلغ به کوچک‌ترین واحد و سپس ارز، مثلاً 1250000 IRR',
  'web.older': 'قدیمی‌تر',
  // Shared chrome added in Phase 3D
  'web.copy': 'کپی',
  'web.copied': 'کپی شد',
  'web.copy_failed': 'کپی نشد. مرورگر اجازهٔ دسترسی به حافظهٔ موقت را نداد.',
  'web.close': 'بستن',
  'web.cancel': 'انصراف',
  'web.working': 'در حال انجام…',
  'web.remove': 'حذف',
  'web.replace': 'جایگزینی',
  'web.move_up': 'انتقال به بالا',
  'web.move_down': 'انتقال به پایین',
  'web.showing': 'نمایش',
  'web.newer': 'تازه‌تر',
  'web.error_hint': 'ارتباط با سرور برقرار نشد. دوباره تلاش کنید.',
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
  'web.nav_discounts': 'تخفیف‌ها و کمپین‌ها',
  'web.nav_resellers': 'نمایندگان',
  'web.nav_reports': 'گزارش‌ها',
  'web.nav_panels': 'پنل‌ها',
  'web.nav_providers': 'ارائه‌دهندگان',
  'web.nav_bots': 'ربات‌ها',
  'web.nav_alerts': 'هشدارهای مدیریتی',
  'web.nav_system': 'سامانه و عملیات',

  // --- Planned surfaces ----------------------------------------------------
  'web.planned_why_title': 'چرا هنوز فعال نیست',
  'web.planned_why_hint': 'این بخش به چیزهایی روی سرور نیاز دارد که در این نسخه ساخته نشده‌اند.',
  'web.planned_decided_title': 'آنچه از پیش تصمیم‌گیری شده',
  'web.planned_decided_hint':
    'این قواعد پیش از ساخت این صفحه تعیین شده‌اند و هنگام پیاده‌سازی باید رعایت شوند.',
  'web.planned_status_title': 'وضعیت',
  'web.planned_status_body':
    'هیچ دکمه‌ای در این صفحه وجود ندارد، چون هیچ کاری از سرور برنمی‌آید. دکمهٔ غیرفعال هم نگذاشته‌ایم: دکمهٔ غیرفعال یعنی «هست ولی دسترسی ندارید»، و این درست نیست.',

  'web.planned_users_summary': 'حساب مشتریان، کیف پول و سرویس‌های هر مشتری.',
  'web.planned_services_summary': 'سرویس‌های تحویل‌شده و مدیریت آنها.',
  'web.planned_orders_summary': 'سفارش‌ها، وضعیت پرداخت و تحویل.',
  'web.planned_products_summary': 'محصولات، دسته‌ها و قیمت‌گذاری فروشگاه.',
  'web.planned_payments_summary': 'پرداخت‌ها، درگاه‌ها، بازگشت وجه و دفتر کیف پول.',
  'web.planned_discounts_summary': 'کدهای تخفیف و کمپین‌های فروش.',
  'web.planned_resellers_summary': 'نمایندگان فروش و سقف اختیارات آنها.',
  'web.planned_reports_summary': 'گزارش‌های فروش، مشتری و مالی.',
  'web.planned_bots_summary': 'ربات‌های تلگرام و پیکربندی آنها.',

  'web.planned_missing_customer': 'موجودیت مشتری و هیچ سرویس یا اندپوینتی برای آن وجود ندارد.',
  'web.planned_missing_wallet': 'دفتر کیف پول (ledger) هنوز مصرف‌کننده‌ای روی HTTP ندارد.',
  'web.planned_missing_service': 'موجودیت سرویس تحویل‌شده وجود ندارد.',
  'web.planned_missing_provisioning':
    'هیچ عملیات تحویلی روی پنل پیاده نشده است؛ تنها قابلیت ارائه‌دهندگان در این نسخه بررسی سلامت است.',
  'web.planned_missing_order': 'موجودیت سفارش وجود ندارد.',
  'web.planned_missing_payment': 'موجودیت پرداخت و چرخهٔ عمر آن وجود ندارد.',
  'web.planned_missing_catalog': 'کاتالوگ محصول و دسته‌بندی وجود ندارد.',
  'web.planned_missing_pricing': 'قواعد قیمت‌گذاری فقط به صورت قرارداد تعریف شده و اجرا نمی‌شود.',
  'web.planned_missing_gateway': 'هیچ درگاه پرداختی ثبت یا تعریف نشده است.',
  'web.planned_missing_reseller': 'موجودیت نماینده وجود ندارد.',
  'web.planned_missing_ledger': 'داده‌ای برای گزارش‌گیری وجود ندارد.',
  'web.planned_missing_bot_runtime':
    'اجرای ربات تلگرام بخشی از فاز بعدی است و در این نسخه ساخته نمی‌شود.',

  'web.planned_users_no_tags':
    'برچسب کاربر وجود نخواهد داشت: نه ستون، نه فیلتر، نه در صفحهٔ کاربر.',
  'web.planned_users_no_activity':
    'بخش «فعالیت اخیر» ساخته نمی‌شود؛ صفحهٔ کاربر روی حساب، سرویس، سفارش، مالی و نمایندگی متمرکز می‌ماند.',
  'web.planned_services_no_protocol':
    'پروتکل (VLESS/VMess/…) در رابط عادی سرویس‌ها نمایش داده نمی‌شود؛ انتزاع سرویس، لینک اشتراک است.',
  'web.planned_services_ordering':
    'ترتیب پیش‌فرض از سمت سرور است: created_at نزولی و سپس id نزولی. مرتب‌سازی یک صفحهٔ واکشی‌شده در مرورگر مجاز نیست.',
  'web.planned_services_plan_filter':
    'فیلتر لوکیشن وجود نخواهد داشت؛ به جای آن فیلتر چندانتخابی «پلن» با پشتیبانی از صفحه‌بندی سمت سرور.',
  'web.planned_orders_attention':
    'سفارش عادی «در انتظار پرداخت» جزو «نیازمند توجه» شمرده نمی‌شود؛ این برچسب فقط برای مواردی است که واقعاً دخالت اپراتور لازم است.',
  'web.planned_orders_history':
    'تاریخچهٔ واقعی سفارش و سرویس حفظ می‌شود و با یک وضعیت جاری عمومی بازنویسی نمی‌شود.',
  'web.planned_orders_shared_projection':
    'صفحهٔ سفارش و صفحهٔ پرداخت از یک پروجکشن مشترک استفاده می‌کنند تا هرگز دو وضعیت متناقض نشان ندهند.',
  'web.planned_products_panel_choice':
    'انتخاب خودکار «کم‌بارترین پنل» وجود نخواهد داشت. یا محصول به یک پنل مشخص گره خورده است، یا مشتری هنگام خرید پنل را انتخاب می‌کند.',
  'web.planned_payments_expiry':
    'مهلت پرداخت حداکثر یک ساعت است و پس از آن پرداخت و سفارش باید منقضی یا لغو شوند. این قاعده باید در دامنه و سرور اجرا شود، نه با یک تایمر در مرورگر.',
  'web.planned_payments_refund':
    'وضعیت بازگشت وجه و وضعیت تحویل هرگز نباید ترکیب ناممکن بسازند؛ «درخواست بازگشت وجه» هم با «بازگشت وجه انجام‌شده» یکی نیست.',
  'web.planned_payments_no_receipts':
    'رسید پرداخت در پنل وب ذخیره، بایگانی، نمایش یا بررسی نمی‌شود. بررسی رسید در تلگرام انجام می‌شود.',
  'web.planned_reports_no_logs':
    'صفحهٔ لاگ عمومی در پنل وب ساخته نمی‌شود؛ جریان عملیاتی انسانی به گروه گزارش تلگرام می‌رود.',
  'web.planned_bots_add_flow':
    'در افزودن ربات، «ربات اصلی» وجود نخواهد داشت. تنها گزینهٔ آینده «ربات فروش نماینده» است و فعلاً غیرفعال و ساخته‌نشدنی است.',

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
  'web.monitor_over_capacity': 'فراتر از ظرفیت',
  'web.monitor_within_capacity': 'در محدودهٔ ظرفیت',
  'web.dashboard_no_panels': 'هنوز پنلی ثبت نشده است.',
  'web.dashboard_attention': 'نیازمند توجه',
  'web.dashboard_attention_hint':
    'تنها شرایط بازِ مدیریتی. یک رویداد روتین یا وضعیتی که خودش برطرف شده، «نیازمند توجه» نیست.',
  'web.dashboard_nothing_to_do': 'چیزی برای رسیدگی نیست.',
  'web.dashboard_nothing_to_do_hint': 'هیچ شرط مدیریتیِ بازی وجود ندارد.',
  'web.dashboard_scope_title': 'آنچه در این نسخه نیست',
  'web.dashboard_scope_body':
    'شاخص‌های فروش، درآمد و مشتری در این صفحه نیستند، چون هنوز سفارش، پرداخت و مشتری‌ای در سامانه وجود ندارد. عددی که ساخته شود، عددی است که کسی پیش از تصمیم‌گیری دوباره حسابش نمی‌کند.',

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
    'از توصیف‌گر ارائه‌دهنده خوانده می‌شود، نه از یک ردیف ذخیره‌شده. در این نسخه تنها «بررسی سلامت» اجرا می‌شود.',
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
    'تنها رویدادهای مدیریتی اینجا می‌آیند: تغییر مدیران و نقش‌ها، قفل‌شدن حساب، رد دسترسی، پرشدن ظرفیت پایش، ازکارافتادن کانال اعلان، و تنظیمی که دیگر خوانده نمی‌شود. جریان روتین — هر بررسی سلامت، هر تلاش ارسال — به گروه گزارش تلگرام می‌رود.',
  'web.alerts_empty': 'هشدار بازی وجود ندارد.',
  'web.alerts_empty_hint': 'هیچ شرط مدیریتی بازی ثبت نشده است.',

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
  'web.system_logs_destination':
    'جریان عملیاتی انسانی به گروه گزارش تلگرام می‌رود. ارسال به تلگرام بخشی از فاز بعدی است و در این نسخه ساخته نشده.',

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
    'این‌ها سقف هستند، نه تضمین: تست‌های دستی از همین سهم خرج می‌کنند و تأخیر پنل‌ها در این محاسبه نیست. همین اعداد را سرور با همان توابعی حساب می‌کند که هشدار ظرفیت را صادر می‌کنند.',
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
    'این مقدار ذخیره، نسخه‌گذاری و ثبت می‌شود، اما در این نسخه چیزی آن را نمی‌خواند. تا ساخته‌شدن مصرف‌کننده‌اش هیچ رفتاری تغییر نمی‌کند.',
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
  'web.topup_precedence_title': 'اولویت حداقل شارژ',
  'web.topup_precedence_body':
    'حداقلِ مخصوص هر درگاه بر این مقدار عمومی مقدم است. چنین چیزی هنوز قابل تعریف نیست: در این سامانه هیچ درگاه پرداختی ثبت نشده که بتوان تنظیم اختصاصی را به آن نسبت داد.',

  // --- Units ---------------------------------------------------------------
  'web.unit_seconds': 'ثانیه',
  'web.unit_minutes': 'دقیقه',
  'web.unit_hours': 'ساعت',
} as const;

export type WebKey = keyof typeof WEB_FA;

export function t(key: WebKey): string {
  return WEB_FA[key];
}
