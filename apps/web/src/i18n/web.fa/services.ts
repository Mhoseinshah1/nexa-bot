/**
 * Web Admin catalogue — services, orders, reminders, locations, delivery.
 *
 * One slice of `WEB_FA`; `../web.fa.ts` merges every slice and is what pages import.
 */
export const WEB_FA_SERVICES = {
  'web.reminders_wallet_threshold_invalid': 'مبلغ را فقط با رقم بنویسید؛ بدون ممیز و علامت.',
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
  'web.order_category': 'دستهٔ خرید',
  'web.order_category_unknown': 'ثبت نشده',
  /*
   * Owner revision 10, carried onto the LIVE page.
   *
   * It used to live on the planned products page, which no route renders any more. A
   * decision recorded only on an unreachable screen is a decision nobody will read
   * before breaking it — the same reason `users`' two absences moved to the real page
   * when Phase 4A shipped it.
   */

  // --- Orders (Phase 4B) ---------------------------------------------------
  'web.orders_title': 'سفارش‌ها',
  'web.orders_col_order': 'سفارش / کد',
  'web.orders_col_dates': 'ثبت / مهلت پرداخت',
  'web.orders_empty': 'هنوز سفارشی ثبت نشده است.',
  'web.orders_empty_hint': 'وقتی مشتری از فهرست ربات چیزی انتخاب کند، اینجا دیده می‌شود.',
  'web.orders_filter_empty': 'سفارشی با این مشخصات پیدا نشد.',
  'web.orders_filter_empty_hint': 'متن جست‌وجو را بررسی کنید یا فیلترها را پاک کنید.',
  'web.orders_search_hint':
    'شناسهٔ عددی تلگرام، شناسهٔ سفارش یا محصول، نام محصول، یا ‎@نام کاربری.',
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
    'این سفارش در انتظار پرداخت مشتری است. تأیید دریافت وجه در صفحهٔ پرداخت‌ها انجام می‌شود.',
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
  /*
   * Owner revisions 3, 6 and 11, carried onto the LIVE page.
   *
   * Revision 6 is DELIVERED — every `line*` field is a snapshot, so an order's history
   * is not rewritten by editing the product — and it is stated here beside the two that
   * are still future so the three are read together. The other two describe the payment
   * surface, which does not exist yet; recording them on a planned page no route renders
   * would have left them for nobody.
   */

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
  'web.services_empty': 'هنوز سرویسی ساخته نشده است.',
  'web.services_col_service': 'سرویس / کد',
  'web.services_col_panel': 'پنل / لوکیشن',
  'web.services_col_state': 'وضعیت / تحویل',
  'web.services_col_dates': 'انقضا / شروع',
  'web.services_tab_live': 'فعال',
  'web.services_tab_ended': 'پایان‌یافته',
  'web.services_tab_all': 'همه',
  'web.services_empty_live': 'سرویس فعالی نیست.',
  'web.services_empty_live_hint': 'سرویس‌های پایان‌یافته در زبانهٔ «پایان‌یافته» هستند.',
  'web.services_empty_ended': 'سرویس پایان‌یافته‌ای نیست.',
  'web.service_started_at': 'تاریخ خرید',
  'web.service_original_start_line': 'تاریخ خرید اصلی: {date}',
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
  'web.service_provider_user_id': 'شناسهٔ کاربری در پنل',
  'web.service_panel_username_pending': 'هنوز روی پنل ساخته نشده است.',
  'web.service_panel_username_unknown':
    'ساخت روی پنل نتیجهٔ نامعلومی داشت و تا تطبیق، معلوم نیست حساب روی پنل هست یا نه.',
  'web.service_panel_username_never': 'این سرویس هرگز روی پنل ساخته نشد.',
  'web.service_panel_username_history': 'وضعیت ساخت سرویس',
  'web.service_panel_account_id': 'شناسهٔ حساب نزد پنل',
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
  'web.services_search_hint':
    'نام کاربری سرویس روی پنل (کامل و دقیق)، شناسهٔ عددی تلگرام، ‎@نام کاربری، یا شناسهٔ سرویس، سفارش یا پنل.',

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

  // --- Service actions -----------------------------------------------------
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
  // Program §13: the Service Operations Center.
  'web.service_action_add_traffic': 'افزودن حجم رایگان',
  'web.service_action_add_time': 'افزودن زمان رایگان',
  'web.service_action_change_location': 'تغییر لوکیشن',
  'web.service_blocker_unlimited': 'این سرویس در این مورد محدودیتی ندارد که به آن افزوده شود.',
  'web.service_blocker_no_target': 'لوکیشن دیگری برای این سرویس تنظیم نشده است.',
  'web.soc_filter_panel': 'پنل',
  'web.soc_filter_product': 'محصول',
  'web.soc_filter_location': 'لوکیشن',
  'web.soc_filter_expiring': 'انقضا',
  'web.soc_expiring_all': 'همه',
  'web.soc_expiring_24h': '24 ساعت آینده',
  'web.soc_expiring_3d': '3 روز آینده',
  'web.soc_expiring_7d': '7 روز آینده',
  'web.soc_mass_title': 'عملیات گروهی روی سرویس‌های فیلترشده',
  'web.soc_mass_hint':
    'روی همان سرویس‌هایی که فیلترهای بالا انتخاب می‌کنند؛ ابتدا پیش‌نمایش، سپس تأیید. هر سرویس جداگانه پردازش و نتیجه‌اش ثبت می‌شود.',
  'web.soc_mass_unrepresentable':
    'جستجوی متنی، وضعیت تحویل و لوکیشن در عملیات گروهی قابل استفاده نیستند و فیلتر انقضا فقط همراه وضعیت «فعال». برای عملیات گروهی فقط با وضعیت، پنل، محصول و انقضای سرویس‌های فعال فیلتر کنید.',
  'web.soc_mass_stale': 'فیلترها پس از پیش‌نمایش تغییر کرده‌اند؛ دوباره پیش‌نمایش بگیرید.',
  'web.soc_mass_eligible': 'سرویس‌های واجد شرایط',
  'web.soc_mass_selected': 'سرویس‌های انتخاب‌شده',
  'web.soc_ineligible_state': 'در وضعیت مناسب نیستند',
  'web.soc_ineligible_panel': 'پنل اکنون قادر به انجام نیست',
  'web.soc_ineligible_other': 'محدودیتی برای افزودن ندارند',
  'web.soc_mass_ineligible_sample': 'نمونهٔ سرویس‌های کنارگذاشته‌شده',
  'web.soc_mass_reason': 'دلیل',
  'web.soc_mass_danger':
    'این عملیات روی همهٔ سرویس‌های واجد شرایط بالا اجرا می‌شود. هر سرویس هنگام پردازش دوباره بررسی می‌شود و نتیجهٔ هر کدام جداگانه ثبت می‌شود.',
  'web.soc_grant_gb': 'حجم (گیگابایت)',
  'web.soc_grant_days': 'تعداد روز',
  'web.soc_grant_traffic_button': 'افزودن حجم',
  'web.soc_grant_time_button': 'افزودن زمان',
  'web.soc_grant_denied': 'افزودن رایگان حجم یا زمان دسترسی جداگانه‌ای لازم دارد.',
  'web.soc_reason': 'دلیل',
  'web.soc_unavailable': 'این کار اکنون برای این سرویس ممکن نیست.',
  'web.soc_move_current': 'لوکیشن فعلی:',
  'web.soc_move_target': 'لوکیشن مقصد',
  'web.soc_move_choose': 'انتخاب کنید',
  'web.soc_move_hint':
    'جابه‌جایی توسط اپراتور رایگان است و محدودیت دفعات تغییر مشتری را مصرف نمی‌کند.',
  'web.soc_move_button': 'تغییر لوکیشن',
  'web.soc_move_denied': 'جابه‌جایی سرویس به دسترسی ویرایش سرویس نیاز دارد.',
  'web.service_blocker_no_contact':
    'جایی برای فرستادن نیست: مشتری ربات را شروع نکرده یا مسدود شده است.',
  'web.service_action_denied_edit': 'برای انجام این کارها به دسترسی «ویرایش سرویس» نیاز دارید.',
  'web.service_action_denied_terminate':
    'پایان دادن به سرویس دسترسی جداگانه‌ای دارد که شما ندارید.',
  'web.service_action_planned': 'درخواست ثبت شد. تا وقتی پنل آن را اعمال نکند، انجام‌شده نیست.',
  'web.service_action_resent': 'لینک برای مشتری فرستاده شد.',
  /* The terminate confirmation. A typed phrase, for the reason the recovery screen gives. */
  'web.service_terminate_danger':
    'این کار حساب مشتری را روی پنل حذف می‌کند و برگشت‌پذیر نیست. سفارشی که مشتری پرداخت کرده سر جایش می‌ماند.',
  'web.service_terminate_confirm_label': 'برای تأیید، این عبارت را دقیقاً بنویسید:',
  'web.service_terminate_confirm_wrong': 'عبارت تأیید مطابقت ندارد.',
  'web.service_terminate_button': 'پایان بده',
  /* Item 11: «حذف سرویس» opens a modal with two options. */
  'web.service_delete_open': 'حذف سرویس…',
  'web.service_delete_title': 'حذف سرویس',
  'web.service_delete_choose': 'نوع حذف را انتخاب کنید:',
  'web.service_delete_only': 'فقط حذف سرویس',
  'web.service_delete_only_hint':
    'حساب روی پنل حذف می‌شود و هیچ مبلغی به کیف پول مشتری برنمی‌گردد.',
  'web.service_delete_refund': 'حذف سرویس و بازگشت وجه',
  'web.service_delete_refund_hint':
    'حساب روی پنل حذف می‌شود و پس از تأیید حذف، مبلغی که تعیین می‌کنید به کیف پول مشتری واریز می‌شود.',
  'web.service_delete_refund_denied':
    'بازگشت وجه به دو دسترسی «ثبت بازگشت وجه» و «پایان دادن به سرویس» نیاز دارد.',
  'web.service_delete_refund_loading': 'در حال خواندن مبلغ قابل بازگشت…',
  'web.service_delete_refund_unavailable': 'بازگشت وجه برای این سرویس ممکن نیست:',
  'web.service_delete_reason_service_state':
    'سرویس در وضعیتی نیست که بتوان آن را حذف و بازپرداخت کرد.',
  'web.service_delete_reason_already_requested':
    'برای این سرویس یک درخواست بازگشت وجه باز یا در حال اجرا وجود دارد؛ آن را در بخش «درخواست‌های بازگشت وجه» بررسی کنید.',
  'web.service_delete_reason_no_paid_source':
    'این سرویس از خرید پرداخت‌شده‌ای نیامده است (آزمایشی، رایگان یا منتقل‌شده)؛ برای جبران از تنظیم دستی کیف پول استفاده کنید.',
  'web.service_delete_reason_source_unresolved': 'پرداخت اصلی این سرویس به‌طور قطعی پیدا نشد.',
  'web.service_delete_reason_nothing_refundable':
    'از پرداخت این سرویس مبلغی برای بازگشت باقی نمانده است.',
  'web.service_delete_reason_cannot_delete':
    'اکنون نمی‌توان این سرویس را حذف کرد (پنل اجازه نمی‌دهد یا عملیات دیگری در جریان است).',
  'web.service_delete_amount': 'مبلغ بازگشت',
  'web.service_delete_amount_max': 'حداکثر قابل بازگشت:',
  'web.service_delete_amount_paid': 'مبلغ پرداخت‌شده:',
  'web.service_delete_amount_invalid': 'مبلغ باید عددی صحیح و بزرگ‌تر از صفر باشد.',
  'web.service_delete_amount_too_large': 'مبلغ از حداکثر قابل بازگشت بیشتر است.',
  'web.service_delete_continue': 'ادامه',
  'web.service_delete_back': 'بازگشت',
  'web.service_delete_cancel': 'انصراف',
  'web.service_delete_summary': 'خلاصه پیش از تأیید',
  'web.service_delete_summary_service': 'سرویس',
  'web.service_delete_summary_customer': 'مشتری',
  'web.service_delete_summary_amount': 'مبلغ بازگشت',
  'web.service_delete_summary_destination': 'مقصد',
  'web.service_delete_destination_wallet': 'کیف پول مشتری در ربات',
  'web.service_delete_summary_note':
    'مبلغ فقط پس از تأیید حذف از پنل واریز می‌شود. اگر حذف ناموفق یا نامشخص باشد، هیچ مبلغی واریز نمی‌شود.',
  'web.service_delete_confirm_check':
    'تأیید می‌کنم که این سرویس حذف شود و این مبلغ به کیف پول مشتری بازگردد.',
  'web.service_delete_refund_submit': 'حذف و بازگشت وجه',
  'web.service_delete_result_pending':
    'حذف سرویس ثبت شد. پس از تأیید حذف از پنل، مبلغ به کیف پول مشتری واریز می‌شود.',
  'web.service_delete_result_blocked':
    'نتیجه حذف از پنل نامشخص است؛ بازگشت وجه تا روشن شدن وضعیت حذف معلق است و هیچ مبلغی واریز نشده است.',
  'web.service_delete_result_completed': 'سرویس حذف شد و مبلغ به کیف پول مشتری واریز شد.',
  'web.service_delete_result_failed':
    'حذف سرویس از پنل ناموفق بود؛ هیچ مبلغی واریز نشد و سرویس سر جایش است.',
  'web.service_delete_result_reference': 'شناسه پیگیری:',
  'web.service_delete_close': 'بستن',
  'web.service_refund_origin_operator': 'حذف و بازگشت وجه توسط مدیر',
  'web.reminders_title': 'یادآورهای خودکار',
  'web.reminders_intro':
    'پیام‌هایی را که ربات خودکار برای مشتریان می‌فرستد روشن یا خاموش کنید و زمان آن‌ها را تنظیم کنید. هر یادآور برای هر سرویس، پرداخت یا کاهش موجودی فقط یک بار فرستاده می‌شود.',
  'web.reminders_about_fold': 'دربارهٔ این صفحه',
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
    'چند روز پیش از انقضا، از 1 تا 30. یادآور اول باید زودتر از یادآور دوم باشد.',
  'web.reminders_unit_days': 'روز پیش از انقضا',
  'web.reminders_usage_title': 'کاهش حجم',
  'web.reminders_usage_hint':
    'وقتی بخش مشخصی از حجم سرویس باقی مانده باشد به مشتری خبر می‌دهد. پس از خرید حجم اضافه یا تمدید، از نو شمرده می‌شود. سرویس با حجم نامحدود هشدار نمی‌گیرد.',
  'web.reminders_flag_usage': 'یادآور کاهش حجم',
  'web.reminders_usage_first': 'هشدار اول',
  'web.reminders_usage_second': 'هشدار دوم',
  'web.reminders_usage_final': 'هشدار پایانی',
  'web.reminders_usage_values_hint':
    'درصد حجم باقی‌مانده، از 0 تا 99. هر هشدار باید با حجم باقی‌ماندهٔ کمتری از هشدار قبلی باشد.',
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
    'چند دقیقه پیش از پایان مهلت، از 5 تا 30. پرداختی که کمتر از 5 دقیقه از ایجادش گذشته یا کمتر از 3 دقیقه به پایان مهلتش مانده یادآوری نمی‌شود.',
  // HF-A9: the quiet-hours card.
  'web.reminders_quiet_title': 'ساعات سکوت',
  'web.reminders_quiet_hint':
    'یادآوری که در این بازه موعدش برسد حذف نمی‌شود؛ تا پایان بازه نگه داشته می‌شود و بعد فقط یک بار فرستاده می‌شود. اگر تا آن زمان دیگر معتبر نباشد (مثلاً سرویس تمدید شده، پرداخت انجام یا منقضی شده یا کیف پول شارژ شده) فرستاده نمی‌شود. ساعت‌ها به وقت فروشگاه است. پیام‌های پرداخت، سفارش و پاسخ به مشتری هیچ‌وقت نگه داشته نمی‌شوند.',
  'web.reminders_flag_quiet': 'فعال بودن ساعات سکوت',
  'web.reminders_quiet_start': 'ساعت شروع',
  'web.reminders_quiet_end': 'ساعت پایان',
  'web.reminders_quiet_time_hint': 'ساعت و دقیقه، 24ساعته.',
  'web.reminders_quiet_overnight':
    'ساعت پایان پیش از ساعت شروع است، پس بازه از نیمه‌شب می‌گذرد و تا ساعت پایانِ روز بعد ادامه دارد.',
  'web.reminders_quiet_same':
    'ساعت شروع و پایان یکسان است و ساعات سکوت اثری ندارد. یکی از آن دو را تغییر دهید.',
  'web.reminders_templates': 'متن پیام‌ها',
  'web.reminders_templates_hint':
    'متن هر پیام را می‌توانید همین‌جا ویرایش کنید؛ همان متنی است که در بخش «متن‌ها» هم دیده می‌شود.',
  'web.reminders_templates_denied': 'برای دیدن و ویرایش متن پیام‌ها به دسترسی «متن‌ها» نیاز است.',
  'web.service_identity_title': 'مشخصات سرویس',
  'web.connection_files_title': 'توضیح فایل‌های اتصال',
  'web.connection_files_hint':
    'متنی که زیر فایل‌های اتصال این پنل (مثل Android.bpf و Windows.bpf) برای مشتری فرستاده می‌شود.',
  'web.connection_files_mode': 'حالت توضیح',
  'web.connection_files_mode_panel_default': 'پیش‌فرض پنل',
  'web.connection_files_mode_custom': 'سفارشی',
  'web.connection_files_mode_none': 'بدون توضیح',
  'web.connection_files_mode_panel_default_note':
    'توضیح آمادهٔ خود پنل برای هر فایل نشان داده می‌شود؛ اگر پنل توضیحی نفرستد، نام کاربری سرویس.',
  'web.connection_files_mode_none_note': 'فایل‌ها بدون هیچ توضیحی فرستاده می‌شوند.',
  'web.connection_files_use_default': 'استفاده از قالب پیش‌فرض',
  'web.connection_files_use_default_note':
    'قالب پیش‌فرض همان «توضیح پیش‌فرض فایل‌های اتصال» در صفحهٔ قالب پیام‌هاست.',
  'web.connection_files_template': 'قالب توضیح این پنل',
  'web.connection_files_template_hint':
    'متغیرها را داخل آکولاد بنویسید، مثل {username}. هر خطی که مقدار متغیرهایش برای سرویس موجود نباشد حذف می‌شود. برچسب‌های قالب‌بندی تلگرام مثل <b> و <code> مجازند و مقدار متغیرها هرگز به‌عنوان برچسب خوانده نمی‌شود.',
  'web.connection_files_variables': 'متغیرهای مجاز',
  'web.connection_files_unknown_variable':
    'متغیر ناشناخته: {token}. فقط متغیرهای فهرست‌شده مجازند.',
  'web.connection_files_template_empty': 'قالب توضیح نمی‌تواند خالی باشد.',
  'web.connection_files_template_too_long':
    'قالب توضیح حداکثر {max} نویسه است؛ این قالب {count} نویسه دارد.',
  'web.connection_files_length': '{count} از {max} نویسه',
  'web.connection_files_length_warning':
    'تلگرام توضیح فایل را حداکثر 1024 نویسه می‌پذیرد. اگر متن نهایی با مقدارهای واقعی بلندتر شود، هنگام ارسال کوتاه می‌شود و «…» در پایانش می‌آید.',
  'web.connection_files_placement': 'محل توضیح',
  'web.connection_files_placement_last': 'فقط زیر آخرین فایل',
  'web.connection_files_placement_every': 'زیر همهٔ فایل‌ها',
  'web.connection_files_preview': 'پیش‌نمایش',
  'web.connection_files_preview_hint':
    'این فقط پیش‌نمایش است: به جای هر متغیر نام آن نشان داده می‌شود و مقدار واقعی سرویس هنگام ارسال جایگزین می‌شود.',
  'web.connection_files_preview_empty': 'با این قالب توضیحی فرستاده نمی‌شود.',
  'web.connection_files_stale': 'این تنظیم در این فاصله تغییر کرده است؛ مقدار تازه بارگذاری شد.',
  'web.connection_files_invalid': 'قالب توضیح هنوز ایراد دارد؛ پیش از ذخیره آن را اصلاح کنید.',
  'web.connection_files_updated_at': 'آخرین تغییر',
  'web.service_missing_on_panel': 'روی پنل نیست',
  'web.service_trial_badge': 'سرویس تست',
  'web.service_original_product': 'محصول اصلی',
  'web.service_original_price': 'مبلغ اصلی',
  'web.delivery_tutorial_title': 'آموزش پس از تحویل سرویس',
  'web.delivery_tutorial_hint':
    'اختیاری. پس از اینکه سرویس خریداری‌شده یا آزمایشی روی این پنل به مشتری تحویل شد، یک بار و خودکار پس از لینک و فایل‌های اتصال فرستاده می‌شود؛ برای تغییر لینک یا ارسال دوبارهٔ کارت فرستاده نمی‌شود. دکمهٔ «📖 آموزش» و آموزش‌های برنامه‌ها مثل قبل سر جای خود هستند.',
  'web.delivery_tutorial_unconfigured':
    'برای این پنل هنوز آموزشی تنظیم نشده است و چیزی فرستاده نمی‌شود.',
  'web.delivery_tutorial_mode': 'نوع آموزش',
  'web.delivery_tutorial_mode_disabled': 'غیرفعال — چیزی فرستاده نمی‌شود',
  'web.delivery_tutorial_mode_text': 'فقط متن',
  'web.delivery_tutorial_mode_video': 'فقط ویدیو',
  'web.delivery_tutorial_mode_video_text': 'ویدیو همراه متن',
  'web.delivery_tutorial_disabled_note':
    'در حالت غیرفعال متن و ویدیوی انتخاب‌شده نگه داشته می‌شوند تا با فعال‌کردن دوباره از دست نروند.',
  'web.delivery_tutorial_applies': 'برای کدام سرویس‌ها فرستاده شود',
  'web.delivery_tutorial_applies_purchase': 'پس از تحویل سرویس خریداری‌شده',
  'web.delivery_tutorial_applies_trial': 'پس از تحویل سرویس تست',
  'web.delivery_tutorial_applies_required':
    'آموزش فعال باید دست‌کم برای یکی از این دو فرستاده شود.',
  'web.delivery_tutorial_text': 'متن آموزش',
  'web.delivery_tutorial_text_optional': 'متن آموزش (اختیاری در این حالت)',
  'web.delivery_tutorial_text_hint':
    'متن ساده؛ خطی که با «- » شروع شود فهرست و «[عنوان](https://…)» لینک می‌شود. HTML پذیرفته نیست. برای ایموجی پرمیوم از نشانگرهای زیر استفاده کنید.',
  'web.delivery_tutorial_text_required': 'در این حالت متن آموزش لازم است.',
  'web.delivery_tutorial_text_control': 'متن نویسهٔ کنترلی نامعتبر دارد.',
  'web.delivery_tutorial_text_markup':
    'HTML (از جمله <tg-emoji>) پذیرفته نیست؛ ایموجی پرمیوم را با نشانگر {icon:…} بنویسید.',
  'web.delivery_tutorial_text_unsafe_link': 'هر لینک باید با https:// و به نام یک میزبان باشد.',
  'web.delivery_tutorial_text_unknown_icon':
    'یکی از نشانگرهای {icon:…} نام هیچ ایموجی ظاهر ربات نیست.',
  'web.delivery_tutorial_text_too_long': 'متن آموزش بیش از اندازهٔ مجاز است.',
  'web.delivery_tutorial_icons': 'نشانگرهای ایموجی پرمیوم',
  'web.delivery_tutorial_icons_hint':
    'هر نشانگر روی ربات‌هایی که ایموجی پرمیوم را پشتیبانی می‌کنند به ایموجی سفارشیِ تنظیم‌شده در «ظاهر ربات» و در غیر این صورت به ایموجی معمولی آن تبدیل می‌شود.',
  'web.delivery_tutorial_length': '{count} از {max} نویسه',
  'web.delivery_tutorial_caption_fallback':
    'این متن در توضیح ویدیو (حداکثر 1024 نویسه) جا نمی‌شود؛ ویدیو جداگانه و متن کامل در پیام بعدی فرستاده می‌شود و هیچ بخشی بریده نمی‌شود.',
  'web.delivery_tutorial_video': 'ویدیوی آموزش',
  'web.delivery_tutorial_video_optional': 'ویدیوی آموزش (اختیاری در این حالت)',
  'web.delivery_tutorial_video_hint':
    'ویدیوی آموزشی یکی از برنامه‌ها، که از «برنامه‌ها و آموزش اتصال» از طریق ربات تنظیم شده است. فقط رباتی که آن ویدیو را دارد آن را می‌فرستد؛ اگر ربات تحویل‌دهنده ویدیو را نداشته باشد، در حالت «ویدیو همراه متن» فقط متن و در حالت «فقط ویدیو» چیزی فرستاده نمی‌شود.',
  'web.delivery_tutorial_video_none': '— بدون ویدیو —',
  'web.delivery_tutorial_video_missing': 'برنامهٔ انتخاب‌شده دیگر وجود ندارد',
  'web.delivery_tutorial_video_bots': 'ویدیو روی {count} ربات',
  'web.delivery_tutorial_video_app_disabled': 'برنامه غیرفعال است',
  'web.delivery_tutorial_video_required': 'در این حالت انتخاب ویدیو لازم است.',
  'web.delivery_tutorial_video_empty':
    'هنوز برای هیچ برنامه‌ای ویدیوی آموزشی تنظیم نشده است؛ ابتدا از صفحهٔ برنامه‌ها ویدیو را از طریق ربات اضافه کنید.',
  'web.delivery_tutorial_preview': 'پیش‌نمایش متن',
  'web.delivery_tutorial_preview_hint':
    'متن همان‌طور که مشتری می‌خواند؛ نشانگرهای {icon:…} در تلگرام به ایموجی تبدیل می‌شوند.',
  'web.delivery_tutorial_updated_at': 'آخرین تغییر',
  'web.delivery_tutorial_stale':
    'آموزش این پنل در این فاصله تغییر کرده است. مقادیر تازه را بررسی و دوباره ذخیره کنید.',
  // Owner spec §6: «دکمه‌های شیشه‌ای ربات» — the inline button registry's section.
  'web.scl_title': 'چیدمان صفحهٔ سرویس',
  'web.scl_hint':
    'ترتیب، ردیف‌بندی (یک تا سه دکمه در هر ردیف) و نمایش دکمه‌های صفحهٔ سرویس مشتری را از اینجا تنظیم کنید. اینجا فقط چیدمان عوض می‌شود: هر دکمه همچنان فقط وقتی دیده می‌شود که سرویس و پنل اجازه‌اش را بدهند، و «بازگشت» همیشه آخرین دکمه است. متن هر دکمه با «ویرایش متن» همان‌جا که برای دکمه‌های شیشه‌ای هست عوض می‌شود.',
  'web.scl_denied_edit': 'شما اجازهٔ تغییر چیدمان را ندارید؛ فقط می‌توانید آن را ببینید.',
  'web.scl_stored_invalid':
    'چیدمان ذخیره‌شده خوانده نشد و صفحهٔ سرویس به‌صورت پیش‌فرض نمایش داده می‌شود. با ذخیرهٔ دوباره، چیدمان درست جایگزین می‌شود.',
  'web.scl_row': 'ردیف',
  'web.scl_show': 'نمایش',
  'web.scl_hidden': 'پنهان',
  'web.scl_earlier': 'انتقال به قبل در ردیف',
  'web.scl_later': 'انتقال به بعد در ردیف',
  'web.scl_row_up': 'انتقال به ردیف بالاتر',
  'web.scl_row_down': 'انتقال به ردیف پایین‌تر',
  'web.scl_split': 'جدا کردن در ردیف تازه',
  'web.scl_move_row_up': 'بالا بردن ردیف',
  'web.scl_move_row_down': 'پایین بردن ردیف',
  'web.scl_edit_label': 'ویرایش متن',
  'web.scl_back_fixed': 'همیشه آخرین دکمه است و پنهان نمی‌شود.',
  'web.scl_save': 'ذخیرهٔ چیدمان',
  'web.scl_reset': 'بازگشت به چیدمان پیش‌فرض',
  'web.scl_unsaved': 'تغییرات ذخیره نشده‌اند.',
  'web.scl_saved': 'چیدمان صفحهٔ سرویس ذخیره شد.',
  'web.scl_unchanged': 'چیدمان صفحهٔ سرویس تغییری نکرد.',
  'web.scl_failed': 'ذخیرهٔ چیدمان صفحهٔ سرویس انجام نشد.',
  'web.scl_resume_note':
    'این جایگاه برای «روشن کردن سرویس» هم هست: یک سرویس فقط یکی از این دو را می‌بیند.',
  // WP-A6: the service location change — a panel's locations and the price of moving there.
  'web.service_locations_title': 'تغییر لوکیشن سرویس',
  'web.service_locations_subtitle':
    'لوکیشن‌های هر پنل، لوکیشنی که سرویس‌های جدید در آن ساخته می‌شوند، و هزینه و محدودیت انتقال سرویس فعلی مشتری به هر لوکیشن.',
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
    'اختیاری و همراه هم؛ مثلاً 2 تغییر در 30 روز. خالی یعنی بدون سقف.',
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
  'web.service_locations_delete_confirm':
    'این لوکیشن حذف شود؟ اگر درخواست تغییر لوکیشنی به آن اشاره کند، حذف پذیرفته نمی‌شود.',
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
    'این پنل به حداکثر تعداد لوکیشن رسیده است (20 ردیف، همراه با ردیف‌های مخصوص محصول).',
  'web.service_locations_error_count': 'به حداکثر تعداد لوکیشن‌های این نصب (500) رسیده‌اید.',

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
  'web.order_reseller_layer_fixed': 'قیمت ثابت سطح برای این محصول',

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
  'web.order_purpose': 'نوع سفارش',
  'web.order_custom_service_title': 'شرایط سرویس دلخواه',
  'web.order_custom_service_hint':
    'همان‌طور که هنگام ثبت سفارش ثبت شد؛ ویرایش یا حذف قاعده‌ها این ارقام را تغییر نمی‌دهد.',
  'web.order_custom_service_none': 'برای این سفارش شرایط سرویس دلخواهی ثبت نشده است.',
  'web.services_view_expiring_3d': 'تمام می‌شوند تا 3 روز',
  'web.services_view_expiring_24h': 'تمام می‌شوند تا 24 ساعت',
  'web.services_view_unreconciled': 'نامشخص روی پنل',
  'web.services_view_delivery_failed': 'لینک به مشتری نرسید',
  'web.services_view_suspended': 'موقتاً قطع',
  'web.orders_view_awaiting': 'منتظر پرداخت',
  'web.orders_view_refunded': 'برگشت‌خورده',
  'web.service_refund_decide': 'تصمیم دربارهٔ این درخواست',
  'web.service_action_panel_title': 'عملیات روی این سرویس',
  'web.service_group_panel': 'پنل و همگام‌سازی',
  'web.service_group_link': 'لینک اشتراک',
  'web.service_group_state': 'وضعیت سرویس',
  'web.service_group_gift': 'هدیه و تغییر',
  'web.dlv_outcome_succeeded': 'ارسال شد',
  'web.dlv_outcome_failed_retryable': 'ناموفق، دوباره تلاش می‌شود',
  'web.dlv_outcome_failed_permanent': 'ناموفق، قطعی',
  'web.delivery_options_title': 'تحویل به مشتری',
  'web.delivery_options_hint':
    'تعیین می‌کند مشتری این پنل چه چیزی از اتصال خود می‌بیند. با ذخیره‌کردن چیزی برای مشتری فرستاده نمی‌شود.',
  'web.files_only_title': 'فقط فایل، بدون لینک ساب',
  'web.files_only_hint':
    'اگر روشن باشد، مشتری این پنل هرگز لینک اشتراک، QR یا دکمهٔ کپی نمی‌بیند؛ فقط فایل‌های اتصال را می‌گیرد و «تغییر لینک» برایش «دریافت فایل‌های جدید» می‌شود.',
  'web.delivery_choice_label': 'چه چیزی به مشتری تحویل شود',
  'web.delivery_choice_both': 'لینک ساب + فایل‌ها',
  'web.delivery_choice_both_hint':
    'لینک اشتراک و QR آن، به‌اضافهٔ فایل‌های اتصالی که پل برای همان اکانت می‌فرستد.',
  'web.delivery_choice_files': 'فقط فایل',
  'web.delivery_choice_files_hint':
    'بدون لینک ساب؛ مشتری فقط فایل‌های اتصال را می‌گیرد و «تغییر لینک» برایش «دریافت فایل‌های جدید» می‌شود.',
  'web.delivery_choice_link': 'فقط لینک ساب',
  'web.delivery_choice_link_hint': 'لینک اشتراک و QR آن، بدون فایل اتصال.',
  'web.delivery_files_not_announced':
    'دو گزینهٔ فایل غیرفعال است: پل در آخرین بررسی سلامت قابلیت files را اعلام نکرده است. تا وقتی اعلام نکند، هیچ فایلی از پل خواسته و برای مشتری فرستاده نمی‌شود. پس از اضافه‌کردن این قابلیت به پل، «تست اتصال» را بزنید.',
  'web.delivery_files_only_stranded':
    'این پنل روی «فقط فایل» است ولی پل دیگر files را اعلام نمی‌کند؛ مشتریان این پنل الان نه لینک می‌گیرند نه فایل. «فقط لینک ساب» را انتخاب کنید یا پل را درست کنید.',
  'web.delivery_policy_unreadable':
    'سیاست ذخیره‌شدهٔ این پنل خوانا نیست؛ پیش از تغییر تحویل، آن را در زبانهٔ قابلیت‌ها دوباره ذخیره کنید.',
} as const;
