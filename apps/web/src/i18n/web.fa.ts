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
  'web.nav_discounts': 'تخفیف‌ها و کمپین‌ها',
  'web.nav_resellers': 'نمایندگان',
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

  'web.planned_services_summary': 'سرویس‌های تحویل‌شده و مدیریت آنها.',
  'web.planned_discounts_summary': 'کدهای تخفیف و کمپین‌های فروش.',
  'web.planned_resellers_summary': 'نمایندگان فروش و سقف اختیارات آنها.',
  'web.planned_reports_summary': 'گزارش‌های فروش، مشتری و مالی.',
  'web.planned_bots_summary': 'ربات‌های تلگرام و پیکربندی آنها.',

  'web.planned_missing_wallet': 'دفتر کیف پول (ledger) هنوز مصرف‌کننده‌ای روی HTTP ندارد.',
  'web.planned_missing_service': 'موجودیت سرویس تحویل‌شده وجود ندارد.',
  'web.planned_missing_provisioning':
    'هیچ عملیات تحویلی روی پنل پیاده نشده است؛ تنها قابلیت ارائه‌دهندگان در این نسخه بررسی سلامت است.',
  'web.planned_missing_order': 'موجودیت سفارش وجود ندارد.',
  'web.planned_missing_catalog': 'کاتالوگ محصول و دسته‌بندی وجود ندارد.',
  'web.planned_missing_pricing': 'قواعد قیمت‌گذاری فقط به صورت قرارداد تعریف شده و اجرا نمی‌شود.',
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
  'web.planned_missing_reseller': 'موجودیت نماینده وجود ندارد.',
  'web.planned_missing_ledger': 'داده‌ای برای گزارش‌گیری وجود ندارد.',
  'web.planned_missing_bot_runtime':
    'اجرای ربات تلگرام بخشی از فاز بعدی است و در این نسخه ساخته نمی‌شود.',

  'web.planned_services_no_protocol':
    'پروتکل (VLESS/VMess/…) در رابط عادی سرویس‌ها نمایش داده نمی‌شود؛ انتزاع سرویس، لینک اشتراک است.',
  'web.planned_services_ordering':
    'ترتیب پیش‌فرض از سمت سرور است: created_at نزولی و سپس id نزولی. مرتب‌سازی یک صفحهٔ واکشی‌شده در مرورگر مجاز نیست.',
  'web.planned_services_plan_filter':
    'فیلتر لوکیشن وجود نخواهد داشت؛ به جای آن فیلتر چندانتخابی «پلن» با پشتیبانی از صفحه‌بندی سمت سرور.',
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
  // The count is a FLOOR: only the first page of open conditions was read.
  'web.dashboard_more_conditions_partial': 'شرایط باز دیگر، دست‌کم (فقط صفحهٔ نخست خوانده شد):',
  'web.monitor_over_capacity': 'فراتر از ظرفیت',
  'web.setting_topup_minimum': 'کمینهٔ شارژ کیف پول',
  'web.setting_sales_currency': 'واحد پول فروشگاه',
  'web.admin_active': 'فعال',
  'web.admin_suspended': 'معلق',
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
  'web.user_block_reason_label': 'دلیل (اختیاری)',
  'web.user_block_reason_hint':
    'این یادداشت برای اپراتور است و هرگز به مشتری نشان داده نمی‌شود. با رفع مسدودی پاک می‌شود.',
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
    'سرویس، تخفیف و نمایندگی در این نسخه وجود ندارند؛ بنابراین هیچ عدد یا ستونی برای آنها نشان داده نمی‌شود. نمایش صفر برای چیزی که ساخته نشده، گزارشِ نادرست است.',

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
  'web.payment_evidence_kind': 'مبنای تأیید',
  'web.payment_evidence_note': 'یادداشت بررسی',
  'web.payment_reviewer': 'تأییدکننده',
  'web.payment_confirmed_at': 'زمان تأیید',
  'web.payment_created_at': 'زمان ثبت',
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
  'web.payment_confirm_title': 'تأیید دریافت وجه',
  'web.payment_confirm_hint':
    'با تأیید، سفارش مربوط به این پرداخت پرداخت‌شده می‌شود. مبلغ و ارز قابل تغییر نیستند.',
  'web.payment_confirm_note': 'یادداشت بررسی',
  'web.payment_confirm': 'تأیید دریافت',
  'web.payment_confirm_done': 'پرداخت تأیید شد و سفارش پرداخت‌شده است.',
  'web.payment_confirm_denied': 'برای تأیید پرداخت دسترسی receipts.review لازم است.',
  'web.payment_reject_title': 'رد رسید',
  // Says the two things an operator has to know before pressing it: the order is NOT
  // cancelled, and the decision cannot be undone.
  'web.payment_reject_hint':
    'با رد این رسید، پرداخت بسته می‌شود و سفارش تا پایان مهلت خود باز می‌ماند تا مشتری بتواند با روش دیگری پرداخت کند. این تصمیم برگشت‌پذیر نیست.',
  'web.payment_reject_note': 'دلیل رد',
  'web.payment_reject': 'رد رسید',
  'web.payment_reject_done': 'رسید رد شد. سفارش همچنان در انتظار پرداخت است.',
  'web.payment_resolution': 'نتیجهٔ بدون دریافت وجه',
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
  'web.payment_not_settled_here':
    'این صفحه فقط وضعیت مالی را نشان می‌دهد. ساخت یا تحویل سرویس در این نسخه انجام نمی‌شود.',

  // --- Products (Phase 4B) -------------------------------------------------
  'web.products_title': 'محصولات',
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
  'web.product_traffic_bytes': 'حجم (بایت)',
  'web.product_traffic_hint': 'به بایت. صفر یعنی بدون محدودیت حجم.',
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
    'مخاطب آن فقط نمایندگان است؛ تا زمانی که نمایندگی ساخته نشود نه در فهرست می‌آید و نه فروخته می‌شود.',
  'web.product_gap_unpriced': 'قیمت ندارد؛ بدون قیمت قابل فروش نیست.',
  'web.product_gap_no_panel': 'به هیچ پنلی وصل نیست؛ چیزی برای تحویل وجود ندارد.',

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
  'web.product_problem_traffic': 'حجم باید عددی صحیح به بایت باشد.',
  'web.product_problem_devices': 'سقف دستگاه باید عددی صحیح و بزرگ‌تر از صفر باشد یا خالی بماند.',
  'web.product_problem_price': 'قیمت باید عددی صحیح و بزرگ‌تر از صفر باشد یا خالی بماند.',
  'web.products_scope_title': 'آنچه در این نسخه نیست',
  'web.products_scope_body':
    'قاعدهٔ قیمت‌گذاری، تخفیف، دسته‌بندی و قیمت ویژهٔ نمایندگان در این نسخه وجود ندارند. قیمت هر محصول همان عددی است که اینجا وارد می‌کنید.',
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
  'web.orders_scope_title': 'آنچه در این نسخه نیست',
  'web.orders_scope_body':
    'تحویل سرویس، لغو و بازپرداخت در این نسخه وجود ندارند. سفارش تا «پرداخت‌شده» پیش می‌رود و همان‌جا می‌ماند؛ «پرداخت‌شده» یعنی پول رسیده است و نه بیشتر.',
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

  // --- Units ---------------------------------------------------------------
  'web.unit_seconds': 'ثانیه',
  'web.unit_minutes': 'دقیقه',
  'web.unit_hours': 'ساعت',
} as const;

export type WebKey = keyof typeof WEB_FA;

export function t(key: WebKey): string {
  return WEB_FA[key];
}
