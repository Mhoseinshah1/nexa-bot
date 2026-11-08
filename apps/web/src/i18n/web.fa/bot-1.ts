/**
 * Web Admin catalogue — bots, bot buttons, menus, inline buttons, appearance, templates (part 1 of 2).
 *
 * One slice of `WEB_FA`; `../web.fa.ts` merges every slice and is what pages import.
 */
export const WEB_FA_BOT_1 = {
  // OPS-B redesign (round W): the settings-like pages' shared structure.
  'web.ob_unsaved_count': 'تغییر ذخیره‌نشده',
  'web.ob_unsaved_row': 'ذخیره‌نشده',
  'web.ob_toast_saved': 'ذخیره شد',
  'web.ob_toast_unchanged': 'ثبت شد؛ مقداری تغییر نکرد',
  'web.ob_toast_failed': 'ذخیره نشد',
  'web.templates_list': 'فهرست متن‌ها',
  'web.cmb_title': 'دکمه‌های دلخواه منوی اصلی',
  'web.cmb_hint':
    'اینجا دکمه‌های خودتان را می‌سازید: یک لینک، یا یک متن، عکس یا فایل که ربات با زدن دکمه می‌فرستد. جای دکمه، ترتیب و روشن یا خاموش بودنش را در چیدمان بالا از «دکمه‌های موجود» انتخاب می‌کنید.',
  'web.cmb_add': 'افزودن دکمه',
  'web.cmb_feature_off':
    'قابلیت «دکمه‌های دلخواه منوی اصلی» خاموش است. دکمه‌ها ساخته و چیده می‌شوند، ولی تا وقتی از صفحهٔ قابلیت‌ها روشنش نکنید روی کیبورد هیچ مشتری‌ای نمی‌آیند.',
  'web.cmb_limit_note':
    'به حداکثر تعداد دکمهٔ دلخواه رسیده‌اید. برای ساختن دکمهٔ تازه یکی از دکمه‌ها را حذف کنید.',
  'web.cmb_empty': 'هنوز دکمهٔ دلخواهی نساخته‌اید.',
  'web.cmb_edit': 'ویرایش',
  'web.cmb_archive': 'حذف',
  'web.cmb_cancel': 'انصراف',
  'web.cmb_save': 'ذخیره',
  'web.cmb_storage': 'فضای فایل‌های دکمه‌ها: {used} از {max}',
  'web.cmb_archived_toast': 'دکمه حذف شد.',
  'web.cmb_archive_title': 'حذف دکمه',
  'web.cmb_archive_question': 'دکمهٔ «{label}» حذف شود؟',
  'web.cmb_archive_detail':
    'دکمه از کیبورد برداشته می‌شود و فایلش پاک می‌شود. مشتری‌ای که کیبوردش را قبلاً گرفته با زدن آن دکمه می‌بیند که در دسترس نیست. این کار برگشت‌پذیر نیست؛ می‌توانید دکمهٔ تازه‌ای با همان نام بسازید.',
  'web.cmb_kind_link': 'لینک',
  'web.cmb_kind_text': 'متن',
  'web.cmb_kind_photo': 'عکس',
  'web.cmb_kind_document': 'فایل',
  'web.cmb_bots_all': 'همهٔ ربات‌ها',
  'web.cmb_bots_none': 'هیچ ربات',
  'web.cmb_bots_selected': 'فقط ربات‌های انتخاب‌شده',
  'web.cmb_bots_legend': 'نمایش روی کدام ربات‌ها',
  'web.cmb_new_title': 'دکمهٔ تازه',
  'web.cmb_edit_title': 'ویرایش دکمه',
  'web.cmb_label_label': 'نام دکمه',
  'web.cmb_label_hint': 'همین نوشته روی کیبورد مشتری دیده می‌شود. یک خط، بدون «/» در ابتدا',
  'web.cmb_label_too_long': 'نام دکمه بلندتر از 64 نویسه است.',
  'web.cmb_label_slash': 'نام دکمه نباید با «/» شروع شود.',
  'web.cmb_kind_label': 'نوع دکمه',
  'web.cmb_kind_fixed':
    'نوع دکمه: {kind}. نوع بعد از ساخت عوض نمی‌شود؛ برای نوع دیگر دکمهٔ تازه بسازید.',
  'web.cmb_url_label': 'نشانی لینک',
  'web.cmb_url_hint': 'فقط با https:// و نام یک سایت یا کانال، مثلاً https://t.me/example',
  'web.cmb_text_label': 'متنی که فرستاده می‌شود',
  'web.cmb_note_label': 'یادداشت کنار لینک (اختیاری)',
  'web.cmb_caption_label': 'توضیح زیر عکس یا فایل (اختیاری)',
  'web.cmb_body_too_long': 'متن از حد مجاز بلندتر است.',
  'web.cmb_file_label': 'فایل',
  'web.cmb_photo_hint': 'عکس JPEG یا PNG تا 5 مگابایت',
  'web.cmb_document_hint': 'PDF تا 10 مگابایت یا متن ساده (txt) تا 1 مگابایت',
  'web.cmb_current_file': 'فایل فعلی: {name}. برای عوض کردنش فایل تازه‌ای انتخاب کنید.',
  'web.bb_custom_badge': 'دلخواه',
  'web.bb_custom_inspector_note':
    'این دکمه را خودتان ساخته‌اید. نام و محتوایش را از بخش «دکمه‌های دلخواه منوی اصلی» پایین صفحه عوض کنید؛ اینجا فقط جا، روشن یا خاموش بودن و رنگ آن را تعیین می‌کنید.',
  'web.bb_custom_hidden_feature': 'قابلیت دکمه‌های دلخواه خاموش است؛ این دکمه روی کیبورد نمی‌آید.',
  'web.bb_custom_hidden_bots': 'این دکمه فقط روی ربات‌های انتخاب‌شده نمایش داده می‌شود.',
  'web.bb_custom_shadowed':
    'نام این دکمه با یکی از دکمه‌های اصلی یکی است و با آن نام فقط دکمهٔ اصلی کار می‌کند. نام یکی را عوض کنید.',
  'web.bb_custom_unplaced_note':
    'این دکمه هنوز روی کیبورد نیست. اول آن را در یک ردیف بگذارید؛ بعد رنگ و روشن یا خاموش بودنش را می‌توانید تعیین کنید.',

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
  'web.template_override_lacks':
    'این متن {token} ندارد. متن شما همچنان کار می‌کند و تغییری نکرده است؛ برای اینکه مشتری آن را ببیند، متغیر را به متن اضافه کنید.',
  'web.preview_sample_customer':
    'این فقط پیش‌نمایش با «مشتری نمونه» است. در ربات، هر مشتری نام و اطلاعات خودش را می‌بیند و متن ساخته‌شده در هیچ‌جا ذخیره نمی‌شود.',
  'web.sample_customer_first_name': 'علی',
  'web.sample_customer_date': '2 آبان 1405',
  'web.sample_customer_time': '18:30',
  'web.sample_customer_weekday': 'جمعه',
  'web.preview_sample_badge': 'پیش‌نمایش با مشتری نمونه',
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
  // UX Batch 01, item 5: the template categories (`TEMPLATE_CATEGORIES`).
  'web.templates_categories': 'دسته‌های متن',
  'web.templates_category_all': 'همه',
  'web.templates_elsewhere': '{n} متن دیگر در دسته‌های دیگر پیدا شد.',
  'web.templates_search_all': 'جستجو در همهٔ دسته‌ها',
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
  'web.template_issue_unknown_icon':
    'این نشانگر آیکون به هیچ جایگاهی در «ظاهر ربات» اشاره نمی‌کند و اگر ذخیره می‌شد، عیناً برای گیرنده فرستاده می‌شد',
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
  'web.sample_bytes': 'حجم به بایت با رقم لاتین، مثلاً 10737418240 برای 10 گیگابایت',
  'web.sample_traffic_limit':
    'سقف حجم به بایت با رقم لاتین، مثلاً 10737418240 برای 10 گیگابایت؛ صفر یعنی نامحدود',
  'web.sample_datetime': 'یک تاریخ به قالب ISO، مثلاً 2026-09-02T08:00:00Z (Z یعنی به وقت UTC)',
  'web.sample_money': 'مبلغ به کوچک‌ترین واحد و سپس ارز، مثلاً 1250000 IRR',
  // Shared chrome added in Phase 3D
  'web.copy': 'کپی',
  'web.copied': 'کپی شد',
  'web.copy_failed': 'کپی نشد. مرورگر اجازهٔ دسترسی به حافظهٔ موقت را نداد.',
  /* PR-C: the one action that reaches a record's internal id — it copies, it never draws it. */
  'web.copy_code': 'کپی کد',
  'web.copy_internal_id': 'کپی شناسهٔ داخلی',

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

  // --- Bots (WP13) ------------------------------------------------------------
  'web.bots_subtitle':
    'ربات‌های تلگرام این مجموعه: وضعیت ثبت‌شدهٔ دریافت پیام، توقف و راه‌اندازی، و جایگزینی امن توکن.',
  'web.bots_empty': 'هنوز رباتی برای این مجموعه پیکربندی نشده است.',
  'web.bots_empty_hint':
    'ربات اصلی را نصب‌کننده می‌سازد. اگر نصب ناتمام مانده است، دستور botctl telegram register را روی سرور اجرا کنید.',
  'web.bots_add_title': 'افزودن ربات',
  'web.bots_add_body':
    'در افزودن ربات، «ربات اصلی» وجود نخواهد داشت: ربات اصلی را نصب‌کننده می‌سازد و از این صفحه ساخته نمی‌شود.',
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
  'web.bot_menu_stale': 'قدیمی؛ کارگر پس‌زمینه به‌زودی همگام می‌کند (صفحهٔ «دکمه‌های ربات»)',
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
  // Round P: the command-menu sync a replacement runs afterwards, as a separate result.
  'web.bot_token_menu_synced': 'منوی دستورها هم با توکن جدید در تلگرام ثبت شد.',
  'web.bot_token_menu_sync_failed':
    'توکن و وب‌هوک با موفقیت جایگزین شدند، اما ثبت منوی دستورها ناموفق بود؛ در پس‌زمینه با فاصله دوباره تلاش می‌شود و در صفحهٔ «دکمه‌های ربات» دیده می‌شود.',
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
  // OPS-A redesign (round W, wave 2): bots.
  'web.bot_details_title': 'مشخصات ربات',
  'web.bot_token_card': 'توکن ربات',
  'web.bot_token_card_hint':
    'توکن فعلی هرگز نمایش داده نمی‌شود. توکن تازهٔ همین ربات را وارد کنید؛ پس از ارسال، فیلد پاک می‌شود.',
  'web.bot_read_only': 'برای این ربات فقط دسترسی مشاهده دارید.',
  'web.bot_check_card': 'آخرین بررسی زنده',
  'web.bot_buttons_title': 'دکمه‌های ربات',
  'web.bot_buttons_intro':
    'دکمه‌های منوی اصلی ربات، یعنی کیبوردی که زیر چت مشتری نمایش داده می‌شود: ردیف‌ها، نمایش، رنگ، آیکون و متن هر دکمه، و منوی دستورهای تلگرام.',
  'web.bot_buttons_needs_trial_offer':
    'فقط وقتی دیده می‌شود که دست‌کم روی یک پنل سرویس تست روشن باشد و همین حالا ارائه شود (صفحهٔ پنل، زبانهٔ «سرویس تست»).',
  'web.bot_buttons_trial_not_offered': 'فعلاً هیچ پنلی سرویس تست ارائه نمی‌کند',
  'web.bot_buttons_needs_referrals': 'فقط وقتی قابلیت «معرفی دوستان» روشن باشد دیده می‌شود.',
  'web.bot_buttons_feature_off': 'قابلیت خاموش است',
  'web.bot_buttons_one_required':
    'دست‌کم یکی از دکمه‌هایی که به قابلیتی وابسته نیستند باید روشن بماند.',
  'web.bot_buttons_preview_title': 'پیش‌نمایش کیبورد',
  'web.bot_buttons_preview_empty': 'با این تنظیمات هیچ دکمه‌ای نمایش داده نمی‌شود.',
  'web.bot_buttons_labels_title': 'متن دکمه‌ها',
  'web.bot_buttons_labels_hint':
    'متن هر دکمه همان چیزی است که مشتری می‌بیند و ربات با همان متن دکمه را می‌شناسد، پس متن دو دکمه نباید یکسان باشد. پس از تغییر متن، کیبورد جدید با پیام بعدی ربات به مشتری می‌رسد و کیبورد قبلی هم همچنان کار می‌کند.',
  'web.bot_buttons_labels_denied':
    'برای دیدن و ویرایش متن دکمه‌ها به دسترسی templates.view نیاز است.',
  'web.bot_buttons_label_duplicate': 'متن این دکمه با دکمهٔ دیگری یکسان است.',
  // Phase 2 Item 2: «آیکون دسته‌بندی‌ها» on the categories page.
  'web.ci_title': 'آیکون دسته‌بندی‌ها',
  'web.ci_hint':
    'برای هر دسته‌بندی، یک آیکون پریمیوم قبل از نام و یک ایموجی معمولی بعد از نام؛ هر دو اختیاری و مستقل از هم. نام و دکمهٔ دسته تغییری نمی‌کند.',
  'web.ci_limits':
    'محدودیت تلگرام: روی دکمه فقط یک ایموجی پریمیوم و فقط قبل از متن نمایش داده می‌شود، آن هم فقط از رباتی که آزمایش ایموجی سفارشی‌اش موفق بوده است؛ بعد از نام فقط ایموجی معمولی (یونیکد) ممکن است.',
  'web.ci_before': 'آیکون پریمیوم قبل',
  'web.ci_after': 'ایموجی بعد',
  'web.ci_before_placeholder': 'شناسهٔ ایموجی سفارشی (فقط رقم)',
  'web.ci_after_placeholder': 'مثلاً 🔥',
  'web.ci_remove': 'حذف',
  'web.ci_before_invalid': 'شناسهٔ ایموجی سفارشی فقط از رقم است (حداکثر 32 رقم).',
  'web.ci_after_invalid':
    'فقط ایموجی معمولی؛ بدون متن، عدد، فاصله یا نشانه‌گذاری. سقف 8 واحد یونیکد است، نه 8 ایموجی قابل‌مشاهده: یک پرچم یا ایموجی ترکیبی (مثل خانواده) خودش چند واحد حساب می‌شود.',
  'web.ci_mark_title': 'جای آیکون پریمیوم؛ خود ایموجی فقط در تلگرام دیده می‌شود',
  'web.ci_preview': 'پیش‌نمایش دکمه',
  'web.ci_count': '{n} دسته‌بندی آیکون یا ایموجی دارد',
  'web.ci_empty': 'هنوز دسته‌بندی‌ای ساخته نشده است.',
  'web.ci_stored_invalid':
    'مقدار ذخیره‌شدهٔ آیکون‌ها خوانا نیست و ربات آن را نادیده می‌گیرد؛ با ذخیره، همین فهرست جایگزینش می‌شود.',
  'web.ci_denied_edit': 'برای تغییر آیکون‌ها به مجوز ویرایش تنظیمات نیاز است.',
  'web.ci_unsaved': 'تغییرات ذخیره نشده است',
  'web.ci_save': 'ذخیرهٔ آیکون‌ها',
  'web.ci_saved': 'آیکون دسته‌بندی‌ها ذخیره شد.',
  'web.ci_unchanged': 'تغییری برای ذخیره نبود.',
  'web.ci_failed': 'ذخیرهٔ آیکون دسته‌بندی‌ها ناموفق بود.',
  // UX Batch 01, item 2: «رنگ دسته‌بندی‌ها» on the appearance page.
  'web.cc_title': 'رنگ دسته‌بندی‌ها',
  'web.cc_hint':
    'رنگ دکمهٔ هر دسته‌بندی در فروشگاه ربات. دسته‌بندی تازه خودکار اینجا می‌آید؛ تا رنگی برایش انتخاب نشود، رنگ «دکمهٔ دسته‌بندی» در صفحهٔ «دکمه‌های ربات» را می‌گیرد.',
  'web.cc_inherit': 'پیش‌فرض دسته‌ها ({fallback})',
  'web.cc_color': 'رنگ',
  'web.cc_preview': 'پیش‌نمایش',
  'web.cc_inactive': 'غیرفعال — در ربات نمایش داده نمی‌شود',
  'web.cc_hidden': 'پنهان — در ربات نمایش داده نمی‌شود',
  'web.cc_kept_note': 'رنگ این دسته نگه داشته می‌شود و با فعال شدن دوباره به کار می‌رود.',
  'web.cc_empty': 'هنوز دسته‌بندی‌ای ساخته نشده است.',
  'web.cc_categories_denied': 'برای دیدن دسته‌بندی‌ها دسترسی catalog.view لازم است.',
  'web.cc_denied_edit': 'برای تغییر رنگ دسته‌بندی‌ها دسترسی settings.edit لازم است.',
  'web.cc_stored_invalid':
    'مقدار ذخیره‌شدهٔ رنگ دسته‌بندی‌ها با این نسخه خوانا نیست؛ همه با رنگ پیش‌فرض نمایش داده می‌شوند. با ذخیرهٔ دوباره اصلاح می‌شود.',
  'web.cc_changed_count': '{n} دسته رنگ اختصاصی دارد.',
  'web.cc_save': 'ذخیرهٔ رنگ دسته‌ها',
  'web.cc_reset': 'همه پیش‌فرض',
  'web.cc_unsaved': 'تغییرات رنگ دسته‌ها ذخیره نشده است.',
  'web.cc_saved': 'رنگ دسته‌بندی‌ها ذخیره شد.',
  'web.cc_unchanged': 'رنگ دسته‌ها تغییری نکرده بود.',
  'web.cc_failed': 'ذخیرهٔ رنگ دسته‌بندی‌ها انجام نشد.',
  'web.qrt_title': 'پس‌زمینهٔ QR اشتراک',
  'web.qrt_hint':
    'QR لینک اشتراک می‌تواند روی تصویر خودتان کشیده شود. محتوای QR همیشه همان لینک است؛ فقط ظاهرش تغییر می‌کند. بدون پس‌زمینه یا جای QR، همان QR سادهٔ همیشگی فرستاده می‌شود.',
  'web.qrt_status_active': 'فعال — QR روی پس‌زمینه',
  'web.qrt_status_default': 'پیش‌فرض — QR ساده',
  'web.qrt_background_title': 'تصویر پس‌زمینه',
  'web.qrt_no_background': 'هنوز پس‌زمینه‌ای بارگذاری نشده است.',
  'web.qrt_dimensions': 'ابعاد (پیکسل)',
  'web.qrt_file': 'فایل PNG پس‌زمینه',
  'web.qrt_file_hint':
    'فقط PNG، حداکثر 1 مگابایت، هر ضلع بین {min} و {max} پیکسل، 8 بیتی و بدون interlace.',
  'web.qrt_upload': 'بارگذاری پس‌زمینه',
  'web.qrt_replace': 'جایگزینی پس‌زمینه',
  'web.qrt_uploaded': 'پس‌زمینهٔ QR ذخیره شد.',
  'web.qrt_problem_empty': 'فایل خالی است.',
  'web.qrt_problem_too_large': 'فایل بزرگ‌تر از 1 مگابایت است.',
  'web.qrt_problem_not_png': 'پس‌زمینهٔ QR فقط می‌تواند PNG باشد.',
  'web.qrt_problem_unreadable': 'سرآیند فایل خوانده نشد.',
  'web.qrt_problem_dimensions': 'ابعاد تصویر خارج از محدودهٔ مجاز است.',
  'web.qrt_problem_format':
    'این نوع PNG پشتیبانی نمی‌شود (16 بیتی، کمتر از 8 بیت یا interlace). آن را به PNG معمولی 8 بیتی تبدیل کنید.',
  'web.qrt_problem_bomb': 'دادهٔ تصویر بیش از اندازهٔ اعلام‌شده باز می‌شود و پذیرفته نشد.',
  'web.qrt_problem_corrupt': 'فایل PNG آسیب دیده است.',
  'web.qrt_placement_title': 'جای QR',
  'web.qrt_placement_hint':
    'یک مربع روی پس‌زمینه، بر حسب پیکسل تصویر. QR سیاه روی سفید و در مرکز این مربع کشیده می‌شود، با اندازهٔ صحیح پیکسل برای هر خانه و بدون کشیدگی.',
  'web.qrt_x': 'فاصله از چپ (x)',
  'web.qrt_y': 'فاصله از بالا (y)',
  'web.qrt_size': 'ضلع مربع',
  'web.qrt_size_hint': 'دست‌کم {min} پیکسل.',
  'web.qrt_quiet': 'حاشیهٔ سفید (خانه)',
  'web.qrt_quiet_hint':
    'عدد صحیح بین {min} و {max} خانه؛ 0 یعنی بدون حاشیه. کمتر از {recommended} ممکن است اسکن را دشوارتر کند.',
  'web.qrt_invalid_fields': 'همهٔ مقادیر باید عدد صحیح و در محدودهٔ مجاز باشند.',
  'web.qrt_needs_background': 'برای تعیین جای QR ابتدا پس‌زمینه را بارگذاری کنید.',
  'web.qrt_outside': 'مربع QR باید کاملاً داخل تصویر پس‌زمینه باشد.',
  'web.qrt_too_small':
    'این مربع برای یک لینک معمولی کوچک است: هر خانهٔ QR، آن‌طور که تلگرام عکس را نشان می‌دهد (حداکثر 1280 پیکسل در ضلع بلند)، کمتر از 4 پیکسل می‌شود. مربع را بزرگ‌تر یا تصویر را کوچک‌تر کنید.',
  'web.qrt_save': 'ذخیرهٔ جای QR',
  'web.qrt_saved': 'جای QR ذخیره شد.',
  'web.qrt_unchanged': 'جای QR تغییری نکرده بود.',
  'web.qrt_preview_draft': 'پیش‌نمایش',
  'web.qrt_centre': 'وسط تصویر',
  'web.qrt_revert': 'بازگشت به پیش‌فرض',
  'web.qrt_reverted': 'QR به حالت پیش‌فرض (ساده) برگشت.',
  'web.qrt_read_only': 'برای تغییر پس‌زمینهٔ QR دسترسی settings.edit لازم است.',
  'web.qrt_preview_title': 'پیش‌نمایش (همان تصویری که مشتری می‌گیرد)',
  'web.qrt_preview_alt': 'پیش‌نمایش QR اشتراک',
  'web.qrt_preview_loading': 'در حال آماده‌سازی پیش‌نمایش…',
  'web.qrt_preview_templated':
    'QR روی پس‌زمینه، {scale} پیکسل برای هر خانه، برای یک لینک نمونه با طول معمول. لینک‌های بلندتر خانه‌های کوچک‌تری دارند.',
  'web.qrt_preview_tight':
    'خانه‌ها کوچک‌اند؛ مربع بزرگ‌تر خوانایی را برای لینک‌های بلند بیشتر می‌کند.',
  'web.qrt_fallback_no_template': 'جای QR تعیین نشده است: QR ساده فرستاده می‌شود.',
  'web.qrt_fallback_no_background': 'پس‌زمینه‌ای نیست: QR ساده فرستاده می‌شود.',
  'web.qrt_fallback_unreadable': 'پس‌زمینه خوانده نشد: QR ساده فرستاده می‌شود.',
  'web.qrt_fallback_outside': 'مربع QR داخل پس‌زمینه جا نمی‌شود: QR ساده فرستاده می‌شود.',
  'web.qrt_fallback_too_small':
    'این مربع برای این لینک کوچک است (کمتر از 4 پیکسل برای هر خانه): QR ساده فرستاده می‌شود.',
  'web.qrt_fallback_too_large': 'تصویر نهایی بیش از حد بزرگ است: QR ساده فرستاده می‌شود.',
  'web.qrt_fallback_config_unreadable': 'تنظیم جای QR خوانده نشد: QR ساده فرستاده می‌شود.',
  'web.ib_title': 'دکمه‌های شیشه‌ای ربات',
  'web.ib_hint':
    'متن، رنگ و آیکون پریمیوم (اختیاری) دکمه‌های شیشه‌ای (زیر پیام‌ها) را برای همهٔ صفحه‌های ربات از اینجا تنظیم کنید. کاری که هر دکمه انجام می‌دهد با تغییر متن، رنگ یا آیکون عوض نمی‌شود.',
  'web.ib_filter': 'جستجوی دکمه',
  'web.ib_filter_placeholder': 'نام یا متن دکمه…',
  'web.ib_style': 'رنگ',
  'web.ib_edit_label': 'ویرایش متن',
  'web.ib_data_label':
    'متن این دکمه از اطلاعات خودتان می‌آید (نام محصول، دسته، برنامه، لوکیشن یا مبلغ) و فقط رنگ آن اینجا تنظیم می‌شود.',
  'web.ib_shared_label':
    'این متن با دکمهٔ «سرویس‌های من» منوی اصلی مشترک است؛ تغییر آن هر دو را عوض می‌کند.',
  'web.ib_link': 'لینک',
  'web.ib_copy': 'کپی',
  'web.ib_save': 'ذخیرهٔ رنگ‌ها و آیکون‌ها',
  'web.ib_reset': 'همه پیش‌فرض',
  'web.ib_suggest': 'رنگ‌های پیشنهادی ({n})',
  'web.ib_rich_preview_title': 'پیش‌نمایش جای دکمه‌ها',
  'web.ib_rich_preview_chat': 'ربات',
  'web.ib_rich_preview_note': 'متن صفحه',
  'web.ib_rich_preview_off':
    '«دکمه‌های داخل پیام» خاموش است: دکمه‌ها مثل همیشه زیر پیام نشان داده می‌شوند.',
  'web.ib_rich_preview_on':
    '«دکمه‌های داخل پیام» روشن است: دکمه‌ها داخل خود پیام قرار می‌گیرند. «ایموجی پریمیوم» خاموش است و هیچ دکمه‌ای آیکون ندارد.',
  'web.ib_rich_preview_on_premium':
    '«دکمه‌های داخل پیام» و «ایموجی پریمیوم» روشن‌اند: دکمه‌ها داخل پیام قرار می‌گیرند و دکمه‌ای که آیکون پریمیوم دارد زیر پیام می‌ماند تا آیکونش حفظ شود.',
  'web.ib_rich_preview_unknown':
    'وضعیت «دکمه‌های داخل پیام» خوانده نشد؛ چیدمان معمول نشان داده می‌شود.',
  'web.ib_unsaved': 'تغییرات رنگ یا آیکون ذخیره نشده است.',
  'web.ib_changed_elsewhere':
    'رنگ‌ها یا آیکون‌ها پس از شروع ویرایش شما جای دیگری تغییر کرده است؛ ذخیره رد می‌شود تا تغییر دیگری از بین نرود.',
  'web.ib_reload': 'دیدن مقدار تازه (کنار گذاشتن ویرایش)',
  'web.ib_changed_count': '{n} دکمه رنگ غیرپیش‌فرض دارد.',
  'web.ib_stored_invalid':
    'مقدار ذخیره‌شدهٔ رنگ‌ها با این نسخه خوانا نیست؛ همهٔ دکمه‌ها با رنگ پیش‌فرض نمایش داده می‌شوند. با ذخیرهٔ دوباره اصلاح می‌شود.',
  'web.ib_denied_edit': 'برای تغییر رنگ یا آیکون دکمه‌ها دسترسی settings.edit لازم است.',
  'web.ib_labels_denied': 'برای دیدن و ویرایش متن دکمه‌ها دسترسی templates.view لازم است.',
  'web.ib_none_found': 'دکمه‌ای با این عبارت پیدا نشد.',
  // Phase 2 Item 3: the optional premium icon of an inline button.
  'web.ib_icon': 'آیکون پریمیوم',
  'web.ib_icon_placeholder': 'شناسهٔ شکلک سفارشی، مثلاً 5368324170671202286',
  'web.ib_icon_none': 'بدون آیکون',
  'web.ib_icon_remove': 'حذف آیکون',
  'web.ib_icon_invalid': 'شناسهٔ شکلک سفارشی فقط از رقم تشکیل می‌شود (حداکثر 32 رقم).',
  'web.ib_icon_count': '{n} دکمه آیکون پریمیوم دارد.',
} as const;
