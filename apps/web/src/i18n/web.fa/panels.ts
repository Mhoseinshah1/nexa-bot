/**
 * Web Admin catalogue — panels, health, capacity, policies, diagnostics, provisioning codes.
 *
 * One slice of `WEB_FA`; `../web.fa.ts` merges every slice and is what pages import.
 */
export const WEB_FA_PANELS = {
  'web.monitor_over_capacity_title': 'پایش از سقف کل نصب عبور کرده است',
  'web.monitor_over_capacity_body':
    'پنل‌های فعال این نصب بیش از آن است که پایش بتواند همه را در بازهٔ تازگی بررسی کند. جزئیات در ردیف «سقف کل نصب» آمده است.',
  'web.notifications_list_hint':
    'هر ردیف یک اعلان است؛ وضعیت ارسال آن جدا از خودش ثبت می‌شود. برای دیدن تلاش‌ها، کلید آن را بزنید.',
  'web.notifications_pick_hint':
    'یک اعلان را از فهرست انتخاب کنید تا تلاش‌های ارسال آن این‌جا نمایش داده شود.',
  'web.technical_section': 'بخش فنی',
  'web.technical_section_body':
    'شناسهٔ داخلی فقط برای پرس‌وجو در پایگاه داده یا ارجاع به پشتیبانی فنی است؛ کد کوتاه همان است که در صفحه می‌بینید.',
  'web.record_open': 'مشاهده',
  'web.record_code': 'کد',
  'web.panel_unlisted': 'پنلی که دیگر در فهرست نیست',

  // Credentials
  'web.credential_set': 'تنظیم شده',
  'web.credential_absent': 'تنظیم نشده',

  'web.test_replayed': 'همین درخواست پیش‌تر ثبت شده بود؛ پیام تازه‌ای در صف قرار نگرفت.',

  // --- Shell ---------------------------------------------------------------
  'web.skip_to_content': 'رفتن به محتوا',
  'web.panel_name_unknown': 'پنل (نامی در دسترس نیست)',
  'web.reference_name_unknown': 'نام در دسترس نیست',
  'web.search_group_customer': 'مشتریان',
  'web.search_group_order': 'سفارش‌ها',
  'web.search_group_service': 'سرویس‌ها',
  'web.search_more': 'نتیجه‌های بیشتری هست؛ جست‌وجو را دقیق‌تر کنید.',
  'web.search_loading': 'در حال جست‌وجو…',
  'web.search_failed': 'جست‌وجوی مشتری، سفارش و سرویس انجام نشد.',

  // --- Panels --------------------------------------------------------------
  'web.panel_new': 'افزودن پنل',
  'web.panel_detail': 'جزئیات پنل',
  'web.monitor_over_capacity': 'فراتر از ظرفیت',
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
  'web.panels_rules_fold': 'دربارهٔ این فهرست',
  'web.providers_rules_fold': 'دربارهٔ ارائه‌دهنده‌ها',
  'web.ph_rules_fold': 'دربارهٔ سلامت پنل‌ها',
  'web.panel_actions_bar': 'اقدام‌های پنل',
  'web.panel_group_probe': 'بررسی',
  'web.panel_group_lifecycle': 'چرخهٔ عمر پنل',
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
    'مشتری خودش یوزرنیم را می‌نویسد: 4 تا 20 نویسه از a-z، A-Z، 0-9، - و _ ، با حداقل یک حرف و یک رقم. حروف بزرگ و کوچک فرقی ندارند و با حروف کوچک ذخیره می‌شود.',
  'web.panel_username_automatic': 'انتخاب خودکار',
  'web.panel_username_automatic_hint':
    'سامانه خودش یوزرنیم می‌سازد، بر اساس روشی که پایین انتخاب می‌کنید.',
  'web.panel_username_strategy': 'روش ساخت خودکار',
  'web.panel_username_strategy_hint':
    'هر یوزرنیم جدید بین 4 تا 20 نویسه و فقط از حروف کوچک انگلیسی، رقم، خط تیره و زیرخط ساخته می‌شود.',
  'web.panel_username_strategy_RANDOM': 'تصادفی 12 نویسه‌ای',
  'web.panel_username_strategy_PREFIX_RANDOM': 'پیشوند + تصادفی',
  'web.panel_username_strategy_TELEGRAM_ID_RANDOM': 'شناسهٔ تلگرام + تصادفی',
  'web.panel_username_strategy_CUSTOM_TEMPLATE': 'الگوی دلخواه',
  'web.panel_username_prefix': 'پیشوند',
  'web.panel_username_prefix_hint':
    'با یک حرف کوچک انگلیسی شروع شود و حداکثر 14 نویسه باشد، تا دست‌کم 6 نویسهٔ تصادفی جا بماند. پیش‌فرض nx است.',
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
  'web.panel_username_issue_TOO_LONG': 'بلندترین خروجی این الگو از 20 نویسه بیشتر می‌شود.',
  'web.panel_username_issue_TOO_SHORT': 'کوتاه‌ترین خروجی این الگو از 4 نویسه کمتر می‌شود.',
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
  'web.panel_upstream_status': 'کد پاسخ پنل',
  'web.panel_provider_version': 'نسخهٔ پنل',
  'web.panel_last_healthy': 'آخرین بار سالم',
  // OPS-A redesign (round W, wave 2): panels.
  'web.panels_not_sellable': 'قابل فروش نیست',
  'web.panel_stat_sellable': 'آمادهٔ فروش',
  'web.panels_filter': 'نمایش پنل‌ها',
  'web.panel_never_checked': 'هنوز بررسی نشده',
  'web.panel_failure_title': 'آخرین بررسی ناموفق بود',
  'web.panel_open_health': 'مشاهدهٔ سلامت',
  'web.panel_section_connection': 'اتصال و ظرفیت',
  'web.form_unsaved': 'تغییرات ذخیره‌نشده دارید.',
  'web.panel_stale_title': 'وضعیت سلامت این پنل کهنه است',
  'web.panel_health_latest_card': 'آخرین وضعیت ثبت‌شده',
  'web.panel_health_latest_chip': 'بدون روند',
  'web.credentials_presence_hint':
    'فقط وجود هر اعتبارنامه و زمان آخرین جایگزینی نشان داده می‌شود؛ مقدار هرگز.',
  'web.panel_new_section_identity': 'مشخصات پنل',
  'web.panel_new_section_credentials': 'اعتبارنامهٔ اولیه',
  'web.panel_new_provider_card': 'ارائه‌دهندهٔ انتخاب‌شده',
  'web.panel_new_choose_provider':
    'پس از انتخاب ارائه‌دهنده، شکل اعتبارنامه و فیلدهای لازم آن اینجا نشان داده می‌شود.',
  'web.panel_new_no_rotate':
    'ثبت اعتبارنامه دسترسی جداگانه‌ای لازم دارد؛ پنل بدون اعتبارنامه ساخته می‌شود و کسی که این دسترسی را دارد آن را وارد می‌کند.',
  'web.panel_read_only':
    'این پیکربندی اینجا فقط خواندنی است: یا دسترسی ویرایش پنل را ندارید یا پنل بایگانی شده است.',
  'web.panel_freshness': 'مهلت کهنه‌شدن',
  'web.panel_new_intro': 'ارائه‌دهنده پیش از ساخته‌شدن ردیف پنل تعیین می‌شود.',
  'web.panel_credential_shape': 'شکل اعتبارنامه',
  'web.panel_activation_fields': 'فیلدهای لازم برای فعال‌سازی',
  'web.api_token': 'توکن API',
  // --- Custom panel (R10 C2): the bridge's shared signing secret and its timeout ---
  'web.provider_name_custom': 'پنل کاستوم',
  'web.protocol_doc_open': 'باز کردن مستند',
  'web.protocol_doc_panel_title': 'مستند پروتکل پنل کاستوم',
  'web.protocol_doc_panel_hint':
    'درخواست‌ها، امضا و پاسخ‌هایی که پل پنل باید پیاده کند در این مستند آمده است.',
  'web.protocol_doc_gateway_title': 'مستند پروتکل درگاه کاستوم',
  'web.protocol_doc_gateway_hint':
    'درخواست‌ها، امضا و پاسخ‌هایی که پل درگاه باید پیاده کند در این مستند آمده است.',
  'web.api_token_signing': 'کلید مشترک امضا',
  'web.api_token_signing_hint':
    'کلیدی که پل و Nexa هر درخواست و پاسخ را با آن امضا می‌کنند. هرگز فرستاده یا دوباره نمایش داده نمی‌شود. کمترین طول (نویسه):',
  'web.panel_base_url_https_hint': 'فقط نشانی https پذیرفته می‌شود، همراه با مسیر پایه اگر دارد.',
  'web.panel_request_timeout': 'مهلت پاسخ (ثانیه)',
  'web.panel_request_timeout_hint':
    'اختیاری، از 1 تا 30 ثانیه. هرگز بیشتر از مهلت کلی این نصب منتظر نمی‌ماند؛ کمتر از 5 ثانیه ممکن است پاسخ‌های کُند را «نامعلوم» کند.',
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
  'web.diagnostics_outbox_exhausted': 'متوقف‌شده پس از 12 تلاش ناموفق',
  'web.diagnostics_outbox_exhausted_banner':
    'برخی رویدادها پس از 12 تلاش ناموفق دیگر خودکار تلاش نمی‌شوند. نگه داشته شده‌اند و در گزارش عملیات ثبت شده‌اند؛ علت خطا باید رفع شود.',
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
  'web.monitor_lightweight': 'بررسی سلامت',
  'web.monitor_lightweight_body':
    'یک درخواست سبک به هر پنل فعال، با فاصلهٔ بالا. یک پیاده‌سازی بررسی وجود دارد و تست دستی اپراتور و پایش خودکار هر دو از همان استفاده می‌کنند.',

  // --- Settings, new keys --------------------------------------------------
  'web.currency': 'واحد پول',
  'web.amount_minor': 'مبلغ به کوچک‌ترین واحد',

  // Track 3 §2: a panel's connection-file caption — its «فایل‌های اتصال» tab.
  'web.panel_tab_connection_files': 'فایل‌های اتصال',

  // R1: the free trial per panel — its tab on the panel page and the Trials page overview.
  'web.panel_tab_trial': 'سرویس تست',
  'web.panel_trial_title': 'سرویس تست این پنل',
  'web.panel_trial_hint':
    'سرویس تست مستقل از محصولات فروشی است و فقط از همین‌جا روشن، خاموش و تنظیم می‌شود. وقتی به مشتری پیشنهاد می‌شود که اینجا روشن باشد، این پنل بتواند سرویس جدید بپذیرد و ساخت نام کاربری خودکار در آن مجاز باشد. تعداد دفعات مجاز برای هر مشتری در صفحهٔ تنظیمات است. تغییر این مقادیر روی سرویس‌های تستی که قبلاً داده شده‌اند اثری ندارد.',
  'web.panel_trial_unconfigured': 'سرویس تست برای این پنل هنوز تنظیم نشده است.',
  'web.panel_trial_enabled': 'ارائهٔ سرویس تست روی این پنل',
  'web.panel_trial_traffic': 'حجم سرویس تست',
  'web.panel_trial_traffic_hint':
    'مثلاً 100 مگابایت یا 1 گیگابایت؛ بیشتر از صفر و حداکثر 100 گیگابایت، با حداکثر دو رقم اعشار.',
  'web.panel_trial_unit_label': 'واحد حجم',
  'web.panel_trial_unit_gb': 'گیگابایت',
  'web.panel_trial_unit_mb': 'مگابایت',
  'web.panel_trial_hours': 'مدت سرویس تست',
  'web.panel_trial_hours_hint': 'به ساعت، از 1 تا 720؛ مثلاً 72 ساعت برای سه روز.',
  'web.panel_trial_hours_unit': 'ساعت',
  'web.panel_trial_label': 'نام نمایشی برای مشتری (اختیاری)',
  'web.panel_trial_label_hint':
    'وقتی چند پنل سرویس تست دارند، روی دکمهٔ انتخاب سرور نشان داده می‌شود. خالی یعنی نام همین پنل.',
  'web.panel_trial_invalid':
    'حجم باید بیشتر از صفر و حداکثر 100 گیگابایت و مدت باید عددی صحیح از 1 تا 720 ساعت باشد.',
  'web.panel_trial_updated_at': 'آخرین تغییر',
  'web.panel_trial_stale':
    'تنظیمات سرویس تست این پنل در این فاصله تغییر کرده است. مقادیر تازه را بررسی و دوباره ذخیره کنید.',

  // Phase 2 item 5: the panel's post-delivery tutorial — its tab on the panel page.
  'web.panel_tab_delivery_tutorial': 'آموزش پس از تحویل',

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
  'web.balancing_strategy_least_used': 'کمترین تعداد ظرفیت اشغال‌شده',
  'web.balancing_strategy_lowest_utilisation': 'کمترین درصد پرشدگی (پنل بدون سقف در آخر)',
  // --- Panel health dashboard and drain (Phase C2) ------------------------------
  'web.panel_reason_draining': 'فروش جدید متوقف است (Drain)',
  'web.panel_reason_draining_help':
    'اپراتور فروش جدید روی این پنل را متوقف کرده است. سرویس‌های موجود بدون تغییر کار می‌کنند. برای ازسرگیری، به صفحهٔ «سلامت پنل‌ها» بروید.',
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
  // Demo parity (panels): the failure kind as a short pill; the sentence above is its title.
  'web.failure_short_authentication_failed': 'ورود ناموفق',
  'web.failure_short_authentication_requires_interaction': 'نیاز به کد دومرحله‌ای',
  'web.failure_short_unreachable': 'در دسترس نیست',
  'web.failure_short_timeout': 'پاسخ دیر رسید',
  'web.failure_short_tls_failed': 'خطای گواهی TLS',
  'web.failure_short_blocked_target': 'مقصد غیرمجاز',
  'web.failure_short_rate_limited': 'محدودیت درخواست',
  'web.failure_short_malformed_response': 'پاسخ نامعتبر',
  'web.failure_short_provider_error': 'خطای خود پنل',
  'web.failure_short_provider_refused': 'پنل درخواست را رد کرد',
  'web.failure_short_unsupported_capability': 'کار پشتیبانی نمی‌شود',

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
  'web.provcode_created': 'ساخته شد',
  'web.provcode_create_failed': 'ساخت ناموفق',
  'web.provcode_create_unknown': 'نتیجهٔ ساخت نامعلوم',
  'web.provcode_creating': 'در حال ساخت',
  'web.provcode_gateway_invoice_reconcile_inquiry_requested': 'استعلام دوباره درخواست شد',
  'web.provcode_nexa_amount_out_of_range': 'مبلغ خارج از محدودهٔ درگاه است',
  'web.provcode_nexa_amount_mismatch': 'مبلغ پاسخ درگاه با مبلغ درخواستی نمی‌خواند',
  'web.provcode_nexa_attempt_closed': 'مهلت این تلاش پرداخت بسته شده است',
  'web.provcode_nexa_card_unavailable': 'کارت بازگشت وجه در دسترس نبود؛ چیزی ارسال نشد',
  'web.provcode_nexa_card_unreadable': 'کارت بازگشت وجه قابل خواندن نبود؛ چیزی ارسال نشد',
  'web.provcode_nexa_not_overpaid': 'فاکتور دیگر بیش‌پرداخت نیست؛ درخواست بازگشت ارسال نشد',
  'web.provcode_nexa_not_pending': 'فاکتور دیگر در انتظار پرداخت نیست؛ درخواست لغو ارسال نشد',
  'web.provcode_nexa_bot_token_unavailable': 'توکن ربات در دسترس نیست',
  'web.provcode_nexa_budget': 'سهمیهٔ درخواست به درگاه تمام شد',
  'web.provcode_nexa_buyer_chat_id_missing': 'شناسهٔ تلگرام خریدار موجود نیست',
  'web.provcode_nexa_chat_unknown': 'گفت‌وگوی خریدار شناخته نیست',
  'web.provcode_nexa_credential_missing': 'کلید درگاه تنظیم نشده است',
  'web.provcode_nexa_deadline_passed': 'مهلت پرداخت گذشته است',
  'web.provcode_nexa_file_unavailable': 'فایل در دسترس نیست',
  'web.provcode_nexa_fx_unreadable': 'نرخ ارز خوانا نبود',
  'web.provcode_nexa_identity_mismatch': 'هویت درگاه با تنظیمات نمی‌خواند',
  'web.provcode_nexa_identity_unavailable': 'هویت درگاه در دسترس نیست',
  'web.provcode_nexa_invoice_id_unsafe': 'شناسهٔ فاکتور درگاه ناامن است',
  'web.provcode_nexa_migration_mirza': 'انتقال از ربات قدیمی',
  'web.provcode_nexa_no_adapter': 'منبع پشتیبانی نمی‌شود',
  'web.provcode_nexa_no_inquiry_context': 'اطلاعات لازم برای استعلام نیست',
  'web.provcode_nexa_no_payment_card': 'کارت پرداختی در دسترس نیست',
  'web.provcode_nexa_no_payment_link': 'پیوند پرداخت ساخته نشد',
  'web.provcode_nexa_no_return_url': 'نشانی بازگشت تنظیم نشده است',
  'web.provcode_nexa_no_source': 'منبعی تنظیم نشده است',
  'web.provcode_nexa_not_an_image': 'فایل تصویر نیست',
  'web.provcode_nexa_not_an_order_id': 'شناسهٔ سفارش معتبر نیست',
  'web.provcode_nexa_not_inquirable': 'این پرداخت قابل استعلام نیست',
  'web.provcode_nexa_nothing_recorded': 'چیزی ثبت نشده است',
  'web.provcode_nexa_nothing_to_ask': 'چیزی برای استعلام نیست',
  'web.provcode_nexa_order_id_mismatch': 'شناسهٔ سفارش درگاه نمی‌خواند',
  'web.provcode_nexa_payment_link_rejected': 'پیوند پرداخت رد شد',
  'web.provcode_nexa_presentation_missing': 'نمایش پرداخت تنظیم نشده است',
  'web.provcode_nexa_reader_threw': 'خواندن پاسخ با خطا متوقف شد',
  'web.provcode_nexa_receipt_too_large': 'تصویر رسید بزرگ است',
  'web.provcode_nexa_scope_inactive': 'نصب کار تازه نمی‌پذیرد',
  'web.provcode_nexa_send_interrupted': 'ارسال نیمه‌کاره ماند',
  'web.provcode_nobitex_no_bids': 'نوبیتکس پیشنهاد خریدی نداشت',
  'web.provcode_nobitex_not_json': 'پاسخ نوبیتکس قابل خواندن نبود',
  'web.provcode_nobitex_unreadable': 'پاسخ نوبیتکس قابل خواندن نبود',
  'web.provcode_ok': 'موفق',
  'web.provcode_payment_reconcile_confirmed': 'پرداخت با بررسی تأیید شد',
  'web.provcode_payment_reconcile_failed': 'پرداخت با بررسی رد شد',
  'web.provcode_wallex_no_bids': 'والکس پیشنهاد خریدی نداشت',
  'web.provcode_wallex_no_result': 'والکس نتیجه‌ای نداد',
  'web.provcode_wallex_not_json': 'پاسخ والکس قابل خواندن نبود',
  'web.provcode_tetrapay_unauthorized': 'کلید API تتراپی پذیرفته نشد',
  'web.provcode_tetrapay_gateway_suspended':
    'درگاه تتراپی معلق است؛ ساخت پرداخت جدید ممکن نیست ولی استعلام ادامه دارد',
  'web.provcode_tetrapay_no_method_available': 'تتراپی هیچ روش پرداختی برای این پرداخت ندارد',
  'web.provcode_tetrapay_not_found': 'تتراپی این پرداخت را نمی‌شناسد',
  'web.provcode_tetrapay_order_conflict':
    'شناسهٔ سفارش در تتراپی تکراری است؛ ممکن است فاکتوری با آن وجود داشته باشد',
  'web.provcode_tetrapay_amount_out_of_range': 'مبلغ خارج از محدودهٔ مجاز تتراپی است',
  'web.provcode_tetrapay_invalid_callback': 'نشانی بازگشت (لینک ربات) نزد تتراپی نامعتبر است',
  'web.provcode_tetrapay_invalid_webhook': 'نشانی وب‌هوک نزد تتراپی نامعتبر است',
  'web.provcode_tetrapay_webhook_not_configured': 'وب‌هوک در پنل تتراپی تنظیم نشده است',
  'web.provcode_tetrapay_rate_limited':
    'سقف تعداد درخواست تتراپی پر شد؛ پس از مهلت اعلام‌شده دوباره تلاش می‌شود',
  'web.provcode_tetrapay_daily_limit_reached':
    'سقف روزانهٔ تتراپی پر شد؛ درگاه تا 00:00 به وقت تهران پنهان است',
  'web.provcode_tetrapay_validation': 'تتراپی درخواست را نامعتبر دانست',
  'web.provcode_tetrapay_unsupported_media_type': 'تتراپی نوع محتوای درخواست را نپذیرفت',
  'web.provcode_tetrapay_bad_json': 'تتراپی بدنهٔ درخواست را نخواند',
  'web.provcode_tetrapay_internal': 'خطای داخلی تتراپی',
  'web.provcode_rialit_unauthorized':
    'کلید API ریالیت پذیرفته نشد (نادرست، ناقص یا باطل‌شده)؛ کلید تازه‌ای در پنل ریالیت بسازید و اینجا ثبت کنید',
  'web.provcode_rialit_ip_not_allowed':
    'نشانی IP سرور در فهرست «IPهای مجاز» پنل ریالیت نیست؛ آن را اضافه کنید',
  'web.provcode_rialit_merchant_inactive':
    'حساب پذیرندهٔ ریالیت غیرفعال است و پرداخت تازه نمی‌سازد؛ با پشتیبانی ریالیت تماس بگیرید (پرداخت‌های باز همچنان استعلام می‌شوند)',
  'web.provcode_rialit_forbidden': 'ریالیت این درخواست را مجاز ندانست (403)',
  'web.provcode_rialit_bad_request':
    'ریالیت درخواست را نامعتبر دانست؛ همان درخواست دوباره فرستاده نمی‌شود',
  'web.provcode_rialit_amount_out_of_range':
    'مبلغ قابل پرداخت خارج از محدودهٔ 50٬000 تا 10٬000٬000 تومان ریالیت است',
  'web.provcode_rialit_invalid_order_id': 'ریالیت شناسهٔ سفارش را نپذیرفت',
  'web.provcode_rialit_invalid_payer_id': 'ریالیت شناسهٔ تلگرام پرداخت‌کننده را نپذیرفت',
  'web.provcode_rialit_not_found': 'ریالیت این پرداخت (یا این مسیر) را نمی‌شناسد',
  'web.provcode_rialit_order_conflict':
    'این شناسهٔ سفارش در ریالیت با مبلغ یا پرداخت‌کنندهٔ دیگری ثبت شده است؛ دوباره فرستاده نمی‌شود',
  'web.provcode_rialit_rate_limited':
    'ریالیت به‌دلیل محدودیت تعداد درخواست موقتاً پاسخ نداد؛ دوباره تلاش می‌شود',
  'web.provcode_rialit_double_fee':
    'هم کارمزد درگاه همین ربات و هم کارمزد پرداخت‌کنندهٔ ریالیت روشن است؛ لینک به مشتری داده نشد تا دو بار کارمزد نپردازد. فقط یکی را نگه دارید: کارمزد این درگاه را در ربات صفر کنید یا کارمزد پرداخت‌کننده را در پنل ریالیت (تنظیمات پذیرنده)',
  'web.provcode_rialit_payer_amount_mismatch':
    'مبلغ پرداخت‌کننده در پاسخ ریالیت با «مبلغ + کارمزد» برابر نبود؛ لینک به مشتری داده نشد',
  'web.provcode_rialit_payer_amount_unreadable':
    'مبلغ قابل پرداخت مشتری در پاسخ ریالیت خوانا نبود؛ لینک به مشتری داده نشد',
  'web.provcode_custom_bad_request': 'پل درگاه کاستوم درخواست نکسا را نامعتبر دانست (400)',
  'web.provcode_custom_signature_invalid':
    'پل درگاه کاستوم امضای درخواست نکسا را نپذیرفت؛ رمز مشترک دو طرف یکی نیست',
  'web.provcode_custom_timestamp_out_of_window':
    'ساعت سرور نکسا و پل درگاه کاستوم بیش از 5 دقیقه اختلاف دارد',
  'web.provcode_custom_nonce_replayed': 'پل درگاه کاستوم این درخواست را تکراری دانست',
  'web.provcode_custom_forbidden': 'حساب پذیرندهٔ پشت پل درگاه کاستوم غیرفعال است یا اجازه ندارد',
  'web.provcode_custom_not_found': 'پل درگاه کاستوم این پرداخت را نمی‌شناسد',
  'web.provcode_custom_invoice_conflict':
    'پل درگاه کاستوم برای این شناسه قبلاً پرداخت دیگری دارد؛ نتیجه نامعلوم است',
  'web.provcode_custom_cancel_not_allowed': 'پل درگاه کاستوم لغو این پرداخت را نپذیرفت',
  'web.provcode_custom_unsupported_currency': 'پل درگاه کاستوم ریال را نمی‌پذیرد',
  'web.provcode_custom_amount_out_of_range':
    'مبلغ خارج از محدودهٔ پل درگاه کاستوم بود؛ پرداختی ساخته نشد',
  'web.provcode_custom_amount_not_payable': 'پل درگاه کاستوم این مبلغ دقیق را نمی‌تواند دریافت کند',
  'web.provcode_custom_expires_at_invalid': 'پل درگاه کاستوم مهلت پرداخت را نپذیرفت',
  'web.provcode_custom_callback_url_rejected':
    'پل درگاه کاستوم نشانی بازگشت (callback) نکسا را نپذیرفت',
  'web.provcode_custom_rate_limited':
    'پل درگاه کاستوم درخواست‌های زیادی دریافت کرده است؛ بعداً دوباره پرسیده می‌شود',
  'web.provcode_custom_internal': 'خطای داخلی در پل درگاه کاستوم',
  'web.provcode_custom_unavailable': 'سرویس پرداخت پشت پل درگاه کاستوم در دسترس نیست',
  'web.provcode_custom_unknown_code': 'پل درگاه کاستوم کد خطایی خارج از پروتکل فرستاد',
  'web.provcode_custom_unsigned': 'پاسخ پل درگاه کاستوم امضای معتبر نداشت و پذیرفته نشد',
  'web.provcode_custom_unreadable': 'پاسخ پل درگاه کاستوم قالب پروتکل را نداشت',
  'web.provcode_custom_echo_mismatch':
    'پل درگاه کاستوم برای شناسه یا مبلغی جز آنچه درخواست شده بود پاسخ داد؛ لینک به مشتری داده نشد',
  'web.provcode_custom_link_rejected':
    'لینک پرداختی که پل درگاه کاستوم فرستاد https نبود؛ لینک به مشتری داده نشد',
  'web.provcode_custom_protocol_mismatch': 'پل درگاه کاستوم پروتکل یا نسخهٔ دیگری را اعلام کرد',
  'web.provcode_custom_currency_unsupported':
    'پل درگاه کاستوم ریال (IRR) را در فهرست ارزهایش اعلام نکرد',
  'web.provcode_custom_endpoint_missing': 'نشانی پل درگاه کاستوم تنظیم نشده است',
  'web.provcode_custom_clock_skew': 'ساعت پل درگاه کاستوم بیش از یک دقیقه با ساعت نکسا اختلاف دارد',
  'web.provcode_custom_endpoint_blocked':
    'این نصب به نشانی پل درگاه کاستوم درخواست نمی‌فرستد (نشانی محلی، داخلی یا شبکهٔ خود نکسا)',
  'web.provcode_wallex_not_success': 'والکس پاسخ ناموفق داد',
  'web.provcode_wallex_unreadable': 'پاسخ والکس قابل خواندن نبود',
  'web.qr_kind_label': 'نوع بارکد',
  'web.qr_kind_hint': 'QR که مشتری می‌بیند: لینک اشتراک، واردکردن در sing-box یا هر دو.',
  'web.qr_kind_sub_link': 'QR لینک اشتراک (پیش‌فرض)',
  'web.qr_kind_singbox': 'QR مخصوص sing-box',
  'web.qr_kind_both': 'هر دو QR',
  'web.singbox_interval_label': 'فاصلهٔ به‌روزرسانی خودکار sing-box (دقیقه)',
  'web.singbox_interval_hint': 'عدد صحیح بین {min} و {max}. پیش‌فرض 360 دقیقه.',
  'web.singbox_interval_invalid': 'فاصله باید عددی صحیح در بازهٔ مجاز باشد.',
  'web.qr_kind_files_only_note':
    'تا وقتی «فقط فایل، بدون لینک ساب» روشن است هیچ QR نشان داده نمی‌شود.',
  'web.panel_inbound_tags_note':
    'با ویرگول جدا کنید. برای هر پروتکل انتخاب‌شده دست‌کم یک تگ لازم است؛ اگر خالی بماند، مرزبان همهٔ ورودی‌های آن پروتکل را حذف می‌کند و مشتری اشتراکی خالی می‌گیرد.',
  'web.cap_gap_unsupported': 'این ارائه‌دهنده این کار را انجام نمی‌دهد.',
  'web.cap_gap_unavailable': 'این کار هنوز در دسترس نیست.',
} as const;
