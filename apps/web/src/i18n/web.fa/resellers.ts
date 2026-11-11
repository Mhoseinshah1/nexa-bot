/**
 * Web Admin catalogue — resellers and reseller tiers.
 *
 * One slice of `WEB_FA`; `../web.fa.ts` merges every slice and is what pages import.
 */
export const WEB_FA_RESELLERS = {
  // --- Resellers (WP9-B) ---------------------------------------------------
  'web.resellers_title': 'نمایندگان',
  'web.resellers_intro':
    'مشتریانی که با قیمت نمایندگی خرید می‌کنند و سطح هر کدام. نماینده همان مشتری است با یک ردیف نمایندگی و مثل هر مشتری فقط با موجودی کیف پول خرید می‌کند.',
  'web.resellers_list_title': 'فهرست نمایندگان',
  'web.resellers_list_hint':
    'تازه‌ترین در بالا. قیمت‌گذاری‌ای که نشان داده می‌شود همان است که واقعاً اعمال می‌شود.',
  'web.resellers_search': 'جست‌وجو',
  'web.resellers_search_hint': 'شناسهٔ تلگرام (دقیق) یا بخشی از نام یا نام کاربری.',
  'web.resellers_empty': 'هنوز نماینده‌ای ثبت نشده است.',
  'web.resellers_empty_hint':
    'نماینده را از همین صفحه یا از کارت «نمایندگی» در صفحهٔ مشتری ثبت کنید؛ پیش از آن دست‌کم یک سطح نمایندگی بسازید.',
  'web.resellers_scope_title': 'قاعده‌هایی که این صفحه رعایت می‌کند',
  'web.resellers_rule_identity':
    'هر مشتری حداکثر یک ردیف نمایندگی دارد و فقط اپراتور آن را ثبت می‌کند. مشتری بدون ردیف یا با ردیف معلق، از هر نظر مشتری عادی است.',
  'web.resellers_rule_credit':
    'خرید اعتباری برای نمایندگان حذف شده است: نماینده مثل هر مشتری فقط با موجودی کیف پول خرید می‌کند و موجودی هرگز با خرید یا برداشت دستی زیر صفر نمی‌رود. ثبت نماینده هیچ تراکنشی در کیف پول نمی‌نویسد.',
  'web.resellers_rule_suspend':
    'تعلیق فقط امتیازهای نمایندگی را برمی‌دارد؛ مسدود کردن مشتری اهرم جداگانه‌ای است که در صفحهٔ مشتری است. تغییر سطح یا نرخ فقط بر سفارش‌هایی اثر دارد که پس از آن تأیید شوند.',
  'web.resellers_tiers_link': 'سطوح نمایندگی و مجوزهای آنها',
  'web.reseller_customer': 'نماینده',
  'web.reseller_customer_page': 'صفحهٔ مشتری',
  'web.reseller_customer_id': 'مشتری',
  'web.reseller_tier': 'سطح',
  'web.reseller_tier_all': 'همهٔ سطوح',
  'web.reseller_status_all': 'همه',
  'web.reseller_status_active': 'فعال',
  'web.reseller_status_suspended': 'معلق',
  'web.reseller_status_hint': 'نمایندهٔ معلق با قیمت فهرست خرید می‌کند، درست مانند مشتری عادی.',
  'web.reseller_pricing': 'قیمت‌گذاری',
  'web.reseller_pricing_hint':
    '«مطابق سطح» یعنی نرخ اختصاصی ندارد. هر گزینهٔ دیگر جایگزین نرخ سطح می‌شود و فقط برای همین نماینده است.',
  'web.reseller_pricing_list': 'قیمت فهرست',
  'web.reseller_pricing_percentage': 'کمتر از قیمت فهرست',
  'web.reseller_pricing_fixed_table': 'قیمت ثابت هر محصول',
  'web.reseller_tier_unpriced_fallback': 'قیمت عادی برای محصولات بدون قیمت',
  'web.reseller_tier_unpriced_fallback_hint':
    'اگر روشن باشد، محصولی که برای این سطح قیمت ندارد با قیمت عادی فروخته می‌شود. اگر خاموش باشد (پیش‌فرض)، آن محصول به نماینده‌های این سطح فروخته نمی‌شود.',
  'web.reseller_tier_fixed_hint':
    'قیمت هر محصول را در «قیمت محصولات» همین سطح بنویسید. خرید و تمدید با این قیمت است؛ حجم و زمان اضافه، کاربر اضافه و تغییر لوکیشن با قیمت معمول خودشان.',
  'web.tier_prices_open': 'قیمت محصولات',
  'web.tier_prices_title': 'قیمت محصولات',
  'web.tier_prices_hint':
    'قیمت دقیق هر محصول برای این سطح. حاشیه یعنی قیمت عادی منهای قیمت سطح. قیمتی بالاتر از قیمت عادی گرفته نمی‌شود؛ نماینده همان قیمت عادی را می‌پردازد.',
  'web.tier_prices_mode_not_table':
    'قیمت‌گذاری این سطح «قیمت ثابت هر محصول» نیست؛ این جدول ذخیره می‌شود ولی تا وقتی قیمت‌گذاری سطح را عوض نکنید اثری ندارد.',
  'web.tier_prices_fallback_on': 'محصولات بدون قیمت در این سطح با قیمت عادی فروخته می‌شوند.',
  'web.tier_prices_fallback_off': 'محصولات بدون قیمت به نماینده‌های این سطح فروخته نمی‌شوند.',
  'web.tier_prices_edit_denied': 'برای ویرایش قیمت‌ها دسترسی resellers.edit لازم است.',
  'web.tier_prices_catalog_denied':
    'جدول قیمت محصولات به دسترسی catalog.view نیاز دارد؛ عنوان و قیمت محصولات از کاتالوگ خوانده می‌شود.',
  'web.tier_prices_empty': 'هنوز محصولی ثبت نشده است.',
  'web.tier_prices_no_category': 'بدون دسته',
  'web.tier_prices_product': 'محصول',
  'web.tier_prices_list': 'قیمت عادی',
  'web.tier_prices_tier': 'قیمت سطح',
  'web.tier_prices_margin': 'حاشیه',
  'web.tier_prices_above_list': '(بالاتر از قیمت عادی)',
  'web.tier_prices_inactive': 'غیرفعال',
  'web.tier_prices_fill_label': 'یک قیمت برای همهٔ محصولات این دسته',
  'web.tier_prices_fill_apply': 'اعمال به همه',
  'web.tier_prices_more': 'بارگذاری بیشتر',
  'web.tier_prices_pasted': 'از جدول چسبانده شد؛ ردیف‌ها:',
  'web.tier_prices_save': 'ذخیرهٔ قیمت‌ها',
  'web.tier_prices_save_note':
    'فقط ردیف‌های تغییرکرده فرستاده می‌شوند. خالی‌کردن یک قیمت، قیمت سطح را برای آن محصول برمی‌دارد.',
  'web.tier_prices_saved': 'قیمت‌ها ذخیره شد',
  'web.tier_prices_saved_set': 'ثبت‌شده:',
  'web.tier_prices_saved_cleared': 'برداشته‌شده:',
  'web.tier_prices_problem_amount': 'هر قیمت باید عددی صحیح و بزرگ‌تر از صفر باشد.',
  'web.tier_prices_problem_unpriced': 'محصولی که قیمت عادی ندارد قیمت سطح هم نمی‌گیرد.',
  'web.tier_prices_problem_too_many': 'در هر ذخیره حداکثر 500 قیمت را می‌توان تغییر داد.',
  'web.reseller_override_tier': 'مطابق سطح',
  'web.reseller_override_list': 'قیمت فهرست (بی‌توجه به نرخ سطح)',
  'web.reseller_override_percentage': 'درصد اختصاصی کمتر از قیمت فهرست',
  'web.reseller_tier_pricing_now': 'نرخ کنونی این سطح:',
  'web.reseller_percent': 'درصد',
  'web.reseller_percent_hint': 'عددی صحیح از 1 تا 100؛ از قیمت فهرست کم می‌شود.',
  'web.reseller_credit_limit': 'سقف اعتبار',
  'web.reseller_register_title': 'ثبت نماینده',
  'web.reseller_register_hint':
    'یک مشتری موجود را نماینده می‌کند. ثبت نماینده هیچ پولی جابه‌جا نمی‌کند.',
  'web.reseller_register': 'ثبت نماینده',
  'web.reseller_registered': 'نماینده ثبت شد.',
  'web.reseller_saved': 'نماینده ذخیره شد.',
  'web.reseller_edit_denied': 'برای ثبت یا ویرایش نماینده دسترسی resellers.edit لازم است.',
  'web.reseller_no_tiers':
    'هنوز سطح نمایندگی‌ای ساخته نشده است؛ هر نماینده باید دقیقاً یک سطح داشته باشد.',
  'web.reseller_problem_customer': 'مشتری را با جست‌وجو پیدا و انتخاب کنید.',
  'web.reseller_problem_tier': 'یک سطح انتخاب کنید.',
  'web.reseller_problem_percent': 'درصد باید عددی صحیح از 1 تا 100 باشد.',

  'web.reseller_tiers_title': 'سطوح نمایندگی',
  'web.reseller_tiers_intro':
    'هر سطح یک نرخ قیمت و مجموعه‌ای از مجوزهاست. هر نماینده دقیقاً یک سطح دارد.',
  'web.reseller_tiers_list_title': 'سطوح',
  'web.reseller_tiers_list_hint':
    'به ترتیب ساخت. مجوزی که قرمز است یعنی آن سطح از آن نوع هیچ چیزی را اجازه نمی‌دهد.',
  'web.reseller_tiers_empty': 'هنوز سطحی ساخته نشده است.',
  'web.reseller_tiers_empty_hint': 'بدون سطح نمی‌توان نماینده ثبت کرد.',
  'web.reseller_tier_name': 'نام سطح',
  'web.reseller_tier_count': 'تعداد نمایندگان',
  'web.reseller_tier_new_title': 'سطح تازه',
  'web.reseller_tier_new_hint': 'نرخ سطح را تعیین کنید؛ مجوزها را پس از ساخت، از فهرست بالا.',
  'web.reseller_tier_edit_title': 'ویرایش سطح',
  'web.reseller_tier_edit_hint':
    'تغییر فقط بر سفارش‌هایی اثر دارد که پس از آن تأیید شوند؛ سفارش تأییدشده قیمت خود را نگه می‌دارد.',
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
  'web.reseller_credit_title': 'کیف پول نماینده',
  'web.reseller_credit_hint': 'موجودی کیف پول همین مشتری، از روی دفتر کیف پول.',
  'web.reseller_credit_denied': 'برای دیدن موجودی کیف پول دسترسی users.view لازم است.',
  'web.reseller_credit_balance': 'موجودی کیف پول',
  'web.reseller_credit_in_use': 'بدهی پیشین (مانده منفی)',
  'web.reseller_credit_legacy_banner':
    'موجودی این نماینده زیر صفر است: بدهی‌ای که پیش از حذف خرید اعتباری ایجاد شده است. سر جای خود می‌ماند و فقط با شارژ یا اعتبار دستی جبران می‌شود؛ تا وقتی موجودی کافی نباشد هیچ خرید تازه‌ای از کیف پول پذیرفته نمی‌شود.',
  'web.reseller_credit_rule_debt':
    'خرید اعتباری برای نمایندگان حذف شده است و هیچ خریدی موجودی را زیر صفر نمی‌برد. سامانه بدهی پیشین را تسویه، وصول یا جریمه نمی‌کند.',
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
  'web.history_hint': 'تا 50 تغییر آخر، از گزارش ممیزی. تلاش‌های ردشده هم ثبت شده‌اند.',
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
  'web.history_action_tier_product_prices': 'تغییر قیمت محصولات',
  'web.history_action_tier_minimum': 'تغییر حداقل فروش ماهانه',
  'web.history_action_reseller_grants_override': 'تغییر مجوزهای اختصاصی',
  'web.history_action_reseller_minimum': 'تغییر حداقل فروش ماهانهٔ اختصاصی',
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

  /*
   * Round N, package D (`docs/round-n-reseller-audit.md`): plans per tier, per-reseller
   * overrides and the monthly minimum. Tracking only — every sentence about the minimum
   * says so, because nothing happens to a reseller below it.
   */
  'web.reseller_plans_title': 'تنظیمات نمایندگان / پلن‌ها و حداقل فروش',
  'web.reseller_plans_intro':
    'اینکه هر سطح نمایندگی کدام محصولات موجود را می‌تواند بفروشد، با چه نرخی، و حداقل فروش ماهانهٔ هر نماینده چقدر است و تا کجا پیش رفته.',
  'web.reseller_plans_tiers_title': 'پلن‌های هر سطح',
  'web.reseller_plans_tiers_hint':
    'محصولات همان محصولات فروشگاه‌اند؛ اینجا فقط مشخص می‌شود کدام‌یک برای نمایندگان هر سطح مجاز است.',
  'web.reseller_plans_products': 'محصولات و دسته‌های مجاز',
  'web.reseller_plans_edit_products': 'محصولات و مجوزها',
  'web.reseller_minimum': 'حداقل فروش ماهانه',
  'web.reseller_minimum_none': 'بدون حداقل',
  'web.reseller_minimum_own_none': 'بدون حداقل (اختصاصی این نماینده)',
  'web.reseller_minimum_edit': 'حداقل فروش',
  'web.reseller_minimum_tier_title': 'حداقل فروش ماهانهٔ سطح',
  'web.reseller_minimum_tier_hint':
    'نمایندگان این سطح همین حداقل را دارند مگر حداقل اختصاصی داشته باشند. صفر یعنی بدون حداقل.',
  'web.reseller_minimum_amount': 'مبلغ حداقل (واحد خرد)',
  'web.reseller_minimum_amount_hint': 'فقط فروش با همین ارز حساب می‌شود. صفر یعنی بدون حداقل.',
  'web.reseller_minimum_problem': 'مبلغ باید عددی صحیح و نامنفی به واحد خرد و در بازهٔ مجاز باشد.',
  'web.reseller_minimum_problem_own':
    'برای حداقل اختصاصی مبلغی بزرگ‌تر از صفر وارد کنید، یا «بدون حداقل» را برگزینید.',
  'web.reseller_expiry_title': 'مهلت نمایندگی',
  'web.reseller_expiry_hint':
    'تاریخ پایان نمایندگی این مشتری. پس از آن، نماینده معلق می‌شود، قیمت‌ها به حالت عادی برمی‌گردد و هیچ مبلغی جابه‌جا نمی‌شود. خالی یعنی بدون مهلت.',
  'web.reseller_expiry_field': 'پایان نمایندگی',
  'web.reseller_expiry_current': 'مهلت فعلی:',
  'web.reseller_expiry_none': 'بدون مهلت',
  'web.reseller_expiry_save': 'ذخیرهٔ مهلت',
  'web.reseller_expiry_clear': 'حذف مهلت',
  'web.reseller_expiry_saved': 'مهلت نمایندگی ذخیره شد.',
  'web.reseller_expiry_cleared': 'مهلت نمایندگی حذف شد.',
  'web.reseller_expiry_reactivates':
    'این نماینده به‌دلیل پایان مهلت معلق شده است؛ ثبت تاریخ جدید، نمایندگی او را دوباره فعال می‌کند.',
  'web.reseller_expiry_manual_suspended':
    'این نماینده را مدیر معلق کرده است؛ تغییر تاریخ، وضعیت او را فعال نمی‌کند.',
  'web.reseller_expiry_past': 'تاریخ مهلت باید در آینده باشد.',
  'web.reseller_minimum_saved': 'حداقل فروش ذخیره شد.',
  'web.reseller_minimum_save': 'ذخیرهٔ حداقل فروش',
  'web.reseller_minimum_choice_inherit': 'مطابق سطح',
  'web.reseller_minimum_choice_none': 'بدون حداقل برای این نماینده',
  'web.reseller_minimum_choice_own': 'حداقل اختصاصی',
  'web.reseller_minimum_source_tier': 'از سطح',
  'web.reseller_minimum_source_own': 'اختصاصی این نماینده',
  'web.reseller_minimum_source_none': 'بدون حداقل',
  'web.reseller_minimum_progress_title': 'پیشرفت حداقل فروش ماهانه',
  'web.reseller_minimum_progress_hint':
    'فروش هر نماینده در ماه تقویمی، در منطقهٔ زمانی و تقویم همین نصب، در برابر حداقل او.',
  'web.reseller_minimum_progress_denied':
    'برای دیدن فروش نمایندگان دسترسی orders.view هم لازم است.',
  'web.reseller_minimum_period_this': 'این ماه',
  'web.reseller_minimum_period_previous': 'ماه قبل',
  'web.reseller_minimum_filter_all': 'همه',
  'web.reseller_minimum_filter_achieved': 'رسیده به حداقل',
  'web.reseller_minimum_filter_below': 'زیر حداقل',
  'web.reseller_minimum_period': 'دوره',
  'web.reseller_minimum_period_to': 'تا',
  'web.reseller_minimum_timezone': 'منطقهٔ زمانی',
  'web.reseller_minimum_running': 'این ماه هنوز تمام نشده است؛ ارقام تا همین لحظه‌اند.',
  'web.reseller_minimum_achieved': 'فروش دوره',
  'web.reseller_minimum_remaining': 'باقی‌مانده',
  'web.reseller_minimum_progress': 'پیشرفت',
  'web.reseller_minimum_state_achieved': 'رسیده به حداقل',
  'web.reseller_minimum_state_below': 'هنوز نرسیده',
  'web.reseller_minimum_state_none': 'بدون حداقل',
  'web.reseller_minimum_state_not_active': 'نمایندگی معلق',
  'web.reseller_minimum_empty': 'نماینده‌ای با این شرط نیست.',
  'web.reseller_minimum_truncated':
    'تعداد نمایندگان بیش از ظرفیت این فهرست است؛ فقط بخشی از آنها نشان داده شده است.',
  'web.reseller_minimum_rules_title': 'حداقل فروش ماهانه چگونه حساب می‌شود',
  'web.reseller_minimum_rule_counts':
    'فقط سفارش‌های پرداخت‌شده‌ای حساب می‌شوند که با شرایط نمایندگی همین نماینده تأیید شده‌اند؛ همان رقم «فروش» در گزارش نمایندگان. سفارشی که کامل بازپرداخت شده حساب نمی‌شود و بازپرداخت جزئی از فروش کم نمی‌شود. سرویس آزمایشی فروش نیست.',
  'web.reseller_minimum_rule_period':
    'دوره، ماه تقویمی در منطقهٔ زمانی و تقویم همین نصب است، از نیمه‌شب روز اول تا نیمه‌شب روز اول ماه بعد.',
  'web.reseller_minimum_rule_no_consequence':
    'رسیدن یا نرسیدن به حداقل هیچ پیامدی ندارد: هیچ بدهی، کارمزد، کسر از کیف پول، تسویه، تنزل سطح، تعلیق یا مسدودسازی ایجاد نمی‌شود. این بخش فقط برای پیگیری، گزارش و اطلاع‌رسانی است.',
  'web.reseller_minimum_rule_notices':
    'یادآوری چند روز پیش از پایان ماه (پیش‌فرض سه روز) و پیام رسیدن به حداقل، هر کدام حداکثر یک بار در ماه برای هر نماینده فرستاده می‌شوند؛ هر دو را از صفحهٔ قابلیت‌ها روشن یا خاموش کنید و تعداد روزها را از تنظیمات تغییر دهید.',
  'web.reseller_minimum_rule_mirza':
    'در ربات قبلی گفته شده نماینده‌ای که به حداقل نرسد نمایندگی‌اش را از دست می‌دهد، اما این رفتار هرگز مشاهده نشده و معیار آن نامعلوم است؛ برای همین در نکسا پیاده نشده است.',
  'web.reseller_minimum_features_link': 'قابلیت‌ها',
  'web.reseller_minimum_settings_link': 'تنظیمات',
  'web.reseller_policy_open': 'سیاست مؤثر',
  'web.reseller_policy_title': 'سیاست مؤثر نماینده',
  'web.reseller_policy_hint':
    'آنچه از سطح به ارث رسیده، آنچه برای همین نماینده جایگزین شده، و آنچه در عمل اعمال می‌شود.',
  'web.reseller_policy_suspended':
    'این نماینده معلق است: اکنون مانند مشتری عادی خرید می‌کند و این سیاست تا فعال شدن دوباره اعمال نمی‌شود.',
  'web.reseller_policy_entitlements': 'مجوزها',
  'web.reseller_policy_dimension': 'بخش',
  'web.reseller_policy_tier_value': 'مقدار سطح',
  'web.reseller_policy_override_value': 'اختصاصی این نماینده',
  'web.reseller_policy_effective_value': 'اعمال‌شده',
  'web.reseller_policy_inherited': 'مطابق سطح',
  'web.reseller_policy_source_tier': 'از سطح',
  'web.reseller_policy_source_own': 'اختصاصی',
  'web.reseller_policy_pricing_note':
    'قیمت نهایی هر خرید هنگام پرداخت و از روی همین نرخ محاسبه و در سفارش ثبت می‌شود؛ اینجا قیمتی محاسبه نمی‌شود.',
  'web.reseller_policy_products': 'محصولاتی که این نماینده می‌تواند بفروشد',
  'web.reseller_policy_products_partial': 'فقط نخستین صفحهٔ محصولات نشان داده شده است.',
  'web.reseller_policy_products_empty': 'هنوز محصولی ساخته نشده است.',
  'web.reseller_policy_products_denied':
    'برای دیدن فهرست محصولات و اینکه کدام‌یک برای این نماینده مجاز است، دسترسی catalog.view لازم است.',
  // --- the reseller edit view: summary, tabs, allowed products, sensitive actions ---------
  'web.rs_tab_profile': 'مشخصات',
  'web.rs_tab_pricing': 'قیمت‌گذاری',
  'web.rs_tab_credit': 'اعتبار و حداقل خرید',
  'web.rs_tab_expiry': 'انقضا و وضعیت',
  'web.rs_tab_products': 'محصولات مجاز',
  'web.rs_tab_danger': 'عملیات حساس',
  'web.rs_summary_expiry': 'انقضا',
  'web.rs_summary_products': 'محصولات مجاز',
  'web.rs_summary_debt': 'بدهی قدیمی',
  'web.rs_profile_title': 'مشخصات نماینده',
  'web.rs_profile_tier': 'سطح نمایندگی',
  'web.rs_profile_registered': 'تاریخ ثبت',
  'web.rs_pricing_title': 'قیمت‌گذاری نماینده',
  'web.rs_status_title': 'وضعیت فعلی',
  'web.rs_access_title': 'قواعد دسترسی',
  'web.rs_access_hint': 'عملیات، پنل و ربات؛ دسترسی محصولات در بالا تنظیم می‌شود.',
  'web.rs_verdicts_summary': 'نتیجهٔ ارزیابی هر محصول',
  'web.rs_products_title': 'محصولات مجاز این نماینده',
  'web.rs_products_total': 'محصولات مجاز',
  'web.rs_products_search': 'جستجوی محصول',
  'web.rs_products_filter': 'فیلتر محصولات',
  'web.rs_products_bulk': 'انتخاب گروهی',
  'web.rs_products_partial':
    'فهرست محصولات کامل خوانده نشد؛ شمارش و ویرایش در این حالت نشان داده نمی‌شود.',
  'web.rs_products_save': 'ذخیرهٔ محصولات مجاز',
  'web.rs_filter_all': 'همه',
  'web.rs_filter_allowed': 'مجاز',
  'web.rs_filter_denied': 'غیرمجاز',
  'web.rs_bulk_all': 'همه مجاز',
  'web.rs_bulk_none': 'همه غیرمجاز',
  'web.rs_bulk_current': 'فقط محصولات فعلی',
  'web.rs_group_legacy': 'محصولات قدیمی',
  'web.rs_group_switch': 'مجاز بودن همهٔ',
  'web.rs_allowed_word': 'مجاز',
  'web.rs_danger_title': 'عملیات حساس',
  'web.rs_danger_hint':
    'تعلیق و تغییر سطح پس از «ذخیره» اعمال می‌شود و در تاریخچهٔ تغییرات ثبت می‌شود.',
  'web.rs_danger_edit': 'شروع ویرایش',
  // NEXA-FIX-V096 PR-4 (OQ-V095-01): a written reason for the three sensitive changes.
  'web.rs_suspend_action': 'تعلیق نمایندگی',
  'web.rs_sensitive_title': 'تأیید عملیات حساس',
  'web.rs_sensitive_confirm': 'تأیید و اعمال',
  'web.rs_effect_suspend':
    'نمایندگی تعلیق می‌شود؛ خرید با قیمت نماینده و اعتبار متوقف می‌شود؛ کیف پول و سرویس‌ها دست نمی‌خورند.',
  'web.rs_effect_tier':
    'سطح نماینده عوض می‌شود؛ از خریدهای بعدی قیمت و دسترسی‌ها طبق سطح جدید است؛ سفارش‌های تأییدشده و کیف پول دست نمی‌خورند.',
  'web.rs_reason_label': 'دلیل (اجباری)',
  'web.rs_reason_hint': 'بین 3 تا 500 نویسه. در تاریخچهٔ تغییرات ثبت می‌شود.',
  'web.rs_reason_invalid': 'دلیل باید بین 3 تا 500 نویسه باشد.',
  'web.history_reason': 'دلیل',
  'web.rs_danger_readonly': 'برای تغییر وضعیت یا سطح، ابتدا ویرایش را شروع کنید.',
  'web.reseller_policy_can_sell': 'خرید سرویس تازه',
  'web.reseller_policy_allowed': 'مجاز',
  'web.reseller_policy_refused': 'مجاز نیست',
  'web.reseller_policy_bot_any': 'پاسخ برای خرید سرویس تازه از هر رباتی است.',
  'web.reseller_policy_bot_granted':
    'پاسخ برای خرید سرویس تازه از ربات مجاز این نماینده است؛ از ربات‌های دیگر خریدی پذیرفته نمی‌شود.',
  'web.reseller_policy_bot_none':
    'هیچ رباتی برای این نماینده مجاز نیست؛ بنابراین هیچ خریدی پذیرفته نمی‌شود.',
  'web.reseller_policy_edit': 'ویرایش تنظیمات اختصاصی',
  'web.reseller_policy_edit_title': 'تنظیمات اختصاصی این نماینده',
  'web.reseller_policy_edit_hint':
    'هر بخش یا مطابق سطح است یا اختصاصی. بخش اختصاصی کاملاً جایگزین مجوزهای سطح در همان بخش می‌شود؛ بخش اختصاصی بدون هیچ انتخابی یعنی هیچ چیز از آن بخش مجاز نیست.',
  'web.reseller_policy_choice_inherit': 'مطابق سطح',
  'web.reseller_policy_choice_own': 'اختصاصی',
  'web.reseller_policy_save': 'ذخیرهٔ مجوزهای اختصاصی',
  'web.reseller_policy_saved': 'مجوزهای اختصاصی ذخیره شد.',
  'web.resellers_filter_empty': 'موردی با این فیلتر پیدا نشد.',
  'web.reseller_plans_pricing_note':
    'قیمت نماینده همان قیمت محصول است با نرخ سطح یا نرخ اختصاصی نماینده؛ هنگام خرید محاسبه و در سفارش ثبت می‌شود.',
} as const;
