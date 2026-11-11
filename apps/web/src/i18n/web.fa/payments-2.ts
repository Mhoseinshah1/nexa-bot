/**
 * Web Admin catalogue — payments, receipts, refunds, wallet, ledger, finance (part 2 of 2).
 *
 * One slice of `WEB_FA`; `../web.fa.ts` merges every slice and is what pages import.
 */
export const WEB_FA_PAYMENTS_2 = {
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
    'درصدی از مبلغ هر شارژ کیف پول از این درگاه که جداگانه به‌عنوان هدیه به کیف پول مشتری واریز می‌شود؛ 0 یعنی بدون هدیه. هر شارژ درصد زمان ایجاد خود را نگه می‌دارد، پس تغییر آن فقط بر شارژهای بعدی اثر دارد.',
  'web.payment_gateway_topup_invalid': 'درصد هدیهٔ شارژ باید عددی صحیح از 0 تا 100 باشد.',
  'web.payment_gateway_customer_fee': 'کارمزد مشتری (%)',
  'web.payment_gateway_customer_fee_hint':
    'درصدی از مبلغ سفارش یا شارژ که به‌عنوان کارمزد (درگاه آنلاین یا کارت‌به‌کارت) به مبلغ قابل پرداخت مشتری اضافه می‌شود؛ حداکثر دو رقم اعشار، 0 یعنی بدون کارمزد. کارمزد جزو مبلغ سفارش یا شارژ کیف پول نیست و بازگردانده نمی‌شود. هر پرداخت کارمزد زمان ایجاد خود را نگه می‌دارد.',
  'web.payment_gateway_customer_fee_invalid':
    'کارمزد مشتری باید عددی از 0 تا 100 با حداکثر دو رقم اعشار باشد.',
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
  // R11 B7.
  // NEXA v095 PR-4 C: the owner's wording; enforced whatever «تأیید شماره تلفن کاربران» says.
  'web.payment_gateway_verified_phone_only': 'برای پرداخت با این درگاه، تأیید شماره لازم است',
  'web.payment_gateway_verified_phone_only_hint':
    'این درگاه به همهٔ مشتری‌ها نمایش داده می‌شود. وقتی مشتری‌ای که شماره‌اش تأیید نشده آن را انتخاب کند، پیش از ساخته شدن هر پرداختی شماره‌اش را می‌گیرد و پس از تأیید، مستقیم به پرداخت با همین درگاه برای همان سفارش یا افزایش موجودی می‌رود. حتی وقتی «تأیید شماره تلفن کاربران» خاموش است اعمال می‌شود؛ مشتری «معاف از تأیید شماره» هرگز پرسیده نمی‌شود.',
  // The TONPAYS (website) route's «لینک پرداخت».
  'web.payment_gateway_tonpays_link': 'لینک پرداخت',
  'web.payment_gateway_tonpays_link_hint':
    'مشتری به کدام لینک تون‌پیز فرستاده شود. اگر لینک انتخاب‌شده در فاکتور نبود، لینک دیگر نشان داده می‌شود. فقط روی فاکتورهای تازه اثر دارد.',
  'web.payment_gateway_tonpays_link_bot': 'ربات تلگرام تون‌پیز',
  'web.payment_gateway_tonpays_link_web': 'صفحهٔ وب تون‌پیز',
  'web.payment_gateway_verified_phone_list': '📱 نیاز به تأیید شماره',
  'web.payment_gateway_updated': 'آخرین تغییر',
  'web.payment_gateway_edit': 'ویرایش',
  'web.payment_gateway_col_actions': 'عملیات',
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
  'web.payment_gateways_empty': 'هنوز روش پرداختی ثبت نشده است.',
  'web.payment_gateways_empty_hint':
    'در نصب سالم این فهرست خالی نمی‌ماند. اگر خالی است، سرویس را یک بار راه‌اندازی مجدد کنید تا روش‌های این نسخه ساخته شوند.',
  'web.payment_resolution': 'نتیجهٔ بدون دریافت وجه',
  'web.payment_destination': 'مقصد واریز اعلام‌شده',
  'web.payment_destination_last_hint':
    'آخرین کارتی که به مشتری نشان داده شد؛ اگر مشتری «تغییر شماره کارت» زده باشد، هر تغییر در تاریخچهٔ پرداخت آمده است.',
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
  'web.pay_attn_review': 'رسید در انتظار تأیید یا رد شماست',
  'web.pay_attn_late': 'پرداخت دیرهنگام منتظر تصمیم است',
  'web.payment_unknown_banner':
    'نتیجهٔ این پرداخت مشخص نیست. تا زمانی که با سوابق طرف مقابل تطبیق داده نشود، نه موفق است و نه ناموفق.',
  /*
   * TonPays Telegram (audit §9.6, §10). A payment in the provider's review is neither paid
   * nor failed, and the copy says only that it is waiting for TonPays. Reconciliation is
   * decided by the provider's RECORDED answer; the buttons say so rather than inviting an
   * operator to choose.
   */
  'web.payment_provider_review_badge': 'در بررسی درگاه',
  'web.payment_provider_review_banner':
    'تون پی دریافت فیش این پرداخت را تأیید کرده و آن را در حال بررسی است. تا پایان بررسی نه موفق است و نه ناموفق. پایان مهلت بررسی:',
  'web.payment_provider_review_window': 'بازهٔ بررسی درگاه',
  'web.payment_gateway_card': 'کارت فعلی',
  'web.payment_gateway_card_change_exhausted': 'تعویض کارت دیگر ممکن نیست',
  'web.payment_gateway_card_change': 'آخرین تعویض کارت',
  'web.payment_gateway_receipts': 'فیش‌های ارسال‌شده به درگاه',
  'web.payment_gateway_receipt_opened_review': 'آغازگر بررسی',
  // R9 C1: what the gateway says the customer owes next, and the cancel/refund requests.
  'web.payment_gateway_next_step': 'اقدام بعدی خواسته‌شده از مشتری',
  'web.payment_gateway_need_less': 'پرداخت ناقص — منتظر مابقی',
  'web.payment_gateway_need_more': 'پرداخت بیش از مبلغ — منتظر کارت بازگشت',
  'web.payment_gateway_remaining': 'مابقی اعلام‌شدهٔ درگاه (فقط برای بررسی)',
  'web.payment_gateway_remaining_invoice': 'فاکتور مابقی',
  'web.payment_gateway_remaining_receipt': 'رسید مابقی',
  'web.payment_gateway_remaining_receipt_received': 'درگاه رسید مابقی را دریافت کرده',
  'web.payment_gateway_remaining_receipt_missing': 'هنوز رسیدی برای مابقی نرسیده',
  'web.payment_gateway_refund_amount': 'مازاد اعلام‌شدهٔ درگاه (فقط برای بررسی)',
  'web.payment_gateway_refund_pending': 'بازگشت مازاد در جریان است',
  'web.payment_gateway_refund_request': 'درخواست کارت بازگشت وجه',
  'web.payment_gateway_cancel_request': 'درخواست لغو فاکتور',
  'web.payment_gateway_cancel_by_nexa': 'به درخواست Nexa',
  'web.payment_gateway_cancel_by_customer': 'به درخواست مشتری',
  'web.payment_gateway_credit_amount': 'مبلغ اعلام‌شدهٔ وب‌هوک (credit_amount)',
  'web.payment_timeline_credit_amount': 'مبلغ اعلام‌شده:',
  'web.payment_gateway_credit_amount_differs':
    'با مبلغ اصل و مبلغ درخواستی نمی‌خواند — واریز نمی‌شود',
  'web.payment_gateway_credit_amount_note':
    'فقط برای بررسی؛ کیف پول فقط با مبلغ اصل و با استعلام درگاه شارژ می‌شود.',
  'web.payment_late_decision_title': 'پرداخت دیرهنگام — تصمیم مدیر',
  'web.payment_late_decision_hint':
    'درگاه این پرداخت را پس از پایان مهلت تأیید کرده و هنوز چیزی جابه‌جا نشده است. یکی از دو راه را انتخاب کنید؛ هر کدام فقط یک بار انجام می‌شود.',
  'web.payment_late_deliver': 'تحویل سرویس',
  'web.payment_late_to_wallet': 'به کیف پول',
  'web.payment_late_deliver_explain':
    'سرویس همین سفارش با همان مبلغ ثبت‌شدهٔ سفارش، مانند پرداخت به‌موقع، تحویل می‌شود؛ قیمت دوباره حساب نمی‌شود. اگر محصول دیگر فروخته نشود، مبلغ پرداخت سفارش را پوشش ندهد، پنل ظرفیت نداشته باشد یا کاربر مسدود باشد، مبلغ به کیف پول مشتری واریز می‌شود و علت در گروه گزارش‌ها ثبت می‌شود.',
  'web.payment_late_to_wallet_explain':
    'اصل مبلغ همین پرداخت یک بار به کیف پول مشتری واریز می‌شود و به او اطلاع داده می‌شود. سفارش دوباره باز نمی‌شود و سرویسی ساخته نمی‌شود.',
  'web.payment_late_decision_done': 'تصمیم پرداخت دیرهنگام انجام شد.',
  'web.payment_late_decision_denied':
    'تصمیم دربارهٔ پرداخت دیرهنگام به دسترسی payments.reconcile نیاز دارد.',
  'web.payment_reconcile_title': 'تطبیق با درگاه',
  'web.payment_reconcile_hint':
    'نتیجه فقط از روی آخرین پاسخ ثبت‌شدهٔ استعلام تون پی تعیین می‌شود. تأیید بدون پاسخ «completed» و پرداخت‌شده، و ناموفق بدون پاسخ رد، منقضی یا لغو، پذیرفته نمی‌شود.',
  'web.payment_reconcile_evidence': 'آخرین پاسخ ثبت‌شده',
  'web.payment_reconcile_note': 'یادداشت (اختیاری)',
  'web.payment_reconcile_confirm': 'تأیید بر اساس پاسخ ثبت‌شده',
  'web.payment_reconcile_fail': 'ناموفق بر اساس پاسخ ثبت‌شده',
  'web.payment_reinquire': 'استعلام دوباره',
  'web.payment_reconcile_done': 'نتیجهٔ پرداخت ثبت شد.',
  'web.payment_reinquire_done': 'استعلام دوباره در نوبت قرار گرفت.',
  'web.payment_reinquire_recent': 'یک استعلام در دقیقهٔ گذشته درخواست شده است.',
  'web.payment_reconcile_denied': 'تطبیق این پرداخت به دسترسی payments.reconcile نیاز دارد.',
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
  // --- roadmap E3 (Agent 5, payments): why a payment cannot be refunded, and what exists ---
  'web.refund_refusal_not_settled':
    'این پرداخت تأیید نشده است و پولی از آن دریافت نشده که بازگردانده شود. اگر پول نزد درگاه است (تأیید دیرهنگام یا پرداخت ناقص)، بازپرداخت درگاه در این نسخه وجود ندارد؛ راهنمای وضعیت بالای صفحه می‌گوید چه راهی هست.',
  'web.refund_refusal_channel_unsupported':
    'این پرداخت از درگاه آمده و برای بازگرداندن پول از طریق درگاه هیچ مسیر واقعی در این نسخه وجود ندارد؛ چیزی وانمود نمی‌شود. اگر سفارش تحویل نشود، مبلغ خودکار به کیف پول مشتری برمی‌گردد.',
  'web.refund_refusal_topup':
    'این شارژ کیف پول است و مبلغ آن پیش‌تر به کیف پول مشتری رفته است؛ بازپرداخت آن پول را دو بار برمی‌گرداند. برداشت از کیف پول به حساب بانکی عملیات جداگانه‌ای است که در این نسخه وجود ندارد.',
  'web.refund_refusal_currency':
    'بازپرداخت‌های این پرداخت با ارز دیگری ثبت شده‌اند؛ سامانه برای ایمنی آن را متوقف می‌کند. این را به پشتیبانی فنی گزارش دهید.',
  'web.refund_refusal_delivery':
    'ساخت سرویس این سفارش هنوز به نتیجهٔ قطعی نرسیده است و بازپرداخت پولِ سرویسی که شاید ساخته شده باشد مجاز نیست. با پایان ساخت، این محدودیت خودبه‌خود برطرف می‌شود.',
  // --- end roadmap E3 block ---
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
  'web.payment_timeline_destination_switched': 'مشتری کارت مقصد را تغییر داد',
  'web.payment_timeline_switch_sequence': 'تغییر شمارهٔ {n}',
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
  'web.payment_timeline_withheld_order': 'تسویه و تحویل سفارش',
  'web.payment_timeline_withheld_audit': 'گزارش ممیزی',
  'web.payment_timeline_invoice_requested': 'درخواست فاکتور به درگاه فرستاده شد',
  'web.payment_timeline_invoice_created': 'درگاه فاکتور را ساخت',
  'web.payment_timeline_webhook': 'آخرین اعلان (وب‌هوک) درگاه',
  'web.payment_timeline_webhook_count': 'تعداد اعلان‌ها',
  'web.payment_timeline_inquiry': 'آخرین استعلام از درگاه',
  'web.payment_timeline_reinquire': 'آخرین درخواست استعلام دوباره',
  'web.payment_timeline_review_opened': 'بازهٔ بررسی درگاه باز شد',
  'web.payment_timeline_review_until': 'تا',
  'web.payment_timeline_outcome_unknown': 'نتیجهٔ پرداخت نامعلوم شد',
  'web.payment_timeline_mismatch_reason': 'علت ناهمخوانی',
  'web.payment_timeline_review_lapsed': 'بررسی درگاه بدون پاسخ قطعی تمام شد',
  'web.payment_timeline_gateway_outcome': 'نتیجهٔ نهایی درگاه ثبت شد',
  'web.payment_timeline_late_completion': 'تأیید دیرهنگام درگاه',
  // R8 A6.
  'web.payment_timeline_late_credited': 'واریز تأیید دیرهنگام به کیف پول',
  'web.payment_timeline_late_credited_to_wallet': 'به کیف پول مشتری؛ سفارش باز نشد',
  'web.payment_timeline_reject_reasons': 'دلیل‌های رد درگاه',
  'web.payment_timeline_reject_reasons_withheld': '{n} دلیل متنی (در گزارش ممیزی پرداخت)',
  'web.payment_timeline_reject_reasons_none': 'درگاه دلیلی اعلام نکرد',
  'web.payment_timeline_order_settled': 'سفارش تسویه شد',
  'web.payment_timeline_order_fulfilment': 'تحویل سفارش',
  'web.payment_timeline_order_refunded': 'سفارش بازپرداخت شد',
  'web.payment_timeline_audit': 'رویداد ممیزی',
  'web.refund_reason': 'دلیل',
  'web.refund_requested_by': 'ثبت‌شده توسط',
  'web.refund_completed_by': 'تأیید واریز توسط',
  'web.refund_awaiting_hint': 'هنوز کسی واریز را تأیید نکرده است.',
  'web.refund_created_at': 'زمان ثبت',
  'web.refund_completed_at': 'زمان واریز',
  'web.refund_external_reference': 'شمارهٔ پیگیری واریز',
  'web.refund_request_title': 'ثبت بازگشت وجه',
  /*
   * Says the two facts an operator needs before pressing it: the bound is the
   * server's, and a wallet refund is immediate while a دستی one is not.
   */
  'web.refund_request_hint':
    'مبلغ در سرور و بر پایهٔ همین پرداخت محدود می‌شود؛ رقم این فرم پیشنهاد است. بازگشت به کیف پول در همین لحظه ثبت و اعتبار افزوده می‌شود، اما بازگشت واریز دستی تا زمانی که اپراتور واریز را تأیید نکند «انجام‌شده» به حساب نمی‌آید.',
  // R12 F1 item 3: said before the operator confirms a refund of a service purchase or renewal.
  'web.refund_full_suspends_service':
    'هشدار: اگر با این بازپرداخت کل مبلغ این پرداخت برگردد، سرویسی که این سفارش خریده یا تمدید کرده روی پنل معلق می‌شود (مدیر می‌تواند دوباره فعالش کند). بازپرداخت بخشی از مبلغ سرویس را تغییر نمی‌دهد.',
  'web.refund_amount_minor': 'مبلغ (به کوچک‌ترین یکای پول)',
  'web.refund_amount_all': 'کل باقی‌ماندهٔ قابل بازگشت',
  'web.refund_request': 'ثبت درخواست',
  'web.refund_requested': 'بازگشت وجه ثبت شد.',
  'web.refund_denied': 'ثبت بازگشت وجه به دسترسی «refunds.issue» نیاز دارد.',
  'web.refund_answer_hint':
    'این سامانه نمی‌تواند خودکار به حساب بانکی مشتری واریز کند. پس از انجام واریز، آن را همین‌جا تأیید کنید. اگر واریزی انجام نشد و نخواهد شد، «منصرف شدم» مبلغ را به باقی‌ماندهٔ قابل بازگشت برمی‌گرداند و سابقهٔ آن پاک نمی‌شود.',
  'web.refund_answer_which': 'کدام بازگشت',
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
  'web.payment_tech_details': 'نمایش جزئیات فنی درگاه',
  'web.bal_group': 'گروه توزیع',
  'web.bal_group_none': 'بدون گروه',
  'web.bal_group_edit': 'ویرایش گروه',
  'web.bal_group_title': 'گروه توزیع این پنل',
  'web.bal_group_explain':
    'پنل‌های یک گروه برای سرویس جدید جایگزین یکدیگر محسوب می‌شوند (فقط با ارائه‌دهندهٔ یکسان). وقتی توزیع خودکار روشن است، سفارش جدیدِ محصولِ هر پنلِ این گروه روی بهترین پنل واجد شرایط گروه ساخته می‌شود. خالی بگذارید تا پنل از گروه خارج شود.',
  'web.bal_group_hint': 'حروف کوچک لاتین، عدد، خط تیره یا زیرخط؛ حداکثر 40 نویسه.',
  'web.bal_group_save': 'ذخیره',
  'web.bal_group_done': 'گروه توزیع ذخیره شد.',
  'web.bal_placement_title': 'انتخاب پنل',
  'web.bal_placement_none': 'این سفارش بدون توزیع خودکار، روی پنلِ خودِ محصول ثبت شده است.',
  'web.bal_placement_group': 'گروه',
  'web.bal_placement_decided_at': 'زمان تصمیم',
  'web.bal_placement_strategy': 'شیوه',
  'web.bal_placement_decided_by': 'دلیل انتخاب',
  'web.bal_placement_home': 'پنل محصول',
  'web.bal_placement_chosen': 'پنل انتخاب‌شده',
  'web.bal_placement_rank': 'رتبه',
  'web.bal_placement_used': 'اشغال',
  'web.bal_placement_healthy': 'سالم',
  'web.bal_placement_status': 'وضعیت',
  'web.bal_decided_sole_candidate': 'تنها پنل واجد شرایط گروه',
  'web.bal_decided_health': 'سالم‌تر از پنل بعدی',
  'web.bal_decided_load': 'کم‌بارتر از پنل بعدی',
  'web.bal_decided_home_preference': 'برابر با بقیه؛ پنل خودِ محصول ترجیح داده شد',
  'web.bal_decided_panel_id': 'برابر با بقیه؛ کوچک‌ترین شناسه برای پایداری',
  'web.bal_decided_no_eligible_candidate':
    'هیچ پنلی در گروه واجد شرایط نبود؛ سفارش روی پنل محصول ماند و تأیید آن رد می‌شود',
  'web.bal_excluded_ineligible': 'غیرقابل‌فروش',
  'web.bal_excluded_provider_mismatch': 'ارائه‌دهندهٔ متفاوت',
  'web.bal_excluded_not_entitled': 'خارج از مجوز نماینده',
  'web.finance_title': 'صورت مالی',
  'web.finance_hint':
    'هر رویداد یک بار و در زمان خودش ثبت می‌شود؛ رقم‌های یک دورهٔ بسته‌شده بعداً تغییر نمی‌کنند.',
  'web.finance_daily': 'روزانه',
  'web.finance_weekly': 'هفتگی (بلوک‌های 7 روزه از شروع دوره)',
  'web.finance_monthly': 'ماهانه',
  'web.finance_def_sales':
    'فروش: سفارش‌هایی که پولشان در این دوره گرفته شد (به زمان تسویه). بازپرداخت سطر جداگانه است و در روزی ثبت می‌شود که انجام شد؛ فروش دوره‌های قبل را بازنویسی نمی‌کند.',
  'web.finance_def_cash':
    'دریافتی از مشتری: پولی که از بیرون رسید (پرداخت کارت‌به‌کارت و درگاه، و رسید واریزشده به کیف پول)، پیش از هر کسر ارائه‌دهنده. کارمزد درگاه سهم مشتری جدا از اصل مبلغ نشان داده می‌شود و جزو فروش نیست.',
  'web.finance_def_wallet':
    'کیف پول: اعتباری که مشتریان نزد شما دارند و دلیل هر تغییرش. کش‌بک، پورسانت و هدیه هزینهٔ تبلیغاتی‌اند، نه درآمد.',
  'web.finance_def_topup':
    'شارژ کیف پول فروش نیست و خرید از کیف پول دریافتی نقدی نیست؛ هر کدام دقیقاً یک بار، در بخش خودش، شمرده می‌شود.',
  'web.finance_empty': 'در این بازه رویداد مالی ثبت نشده است.',
  'web.finance_section_sales': 'فروش',
  'web.finance_section_cash': 'دریافتی از مشتری',
  'web.finance_section_wallet_flow': 'گردش کیف پول',
  'web.finance_gross_sales': 'فروش پیش از تخفیف',
  'web.finance_discounts': 'تخفیف',
  'web.finance_sales': 'فروش',
  'web.finance_refunds': 'بازپرداخت',
  'web.finance_refunds_to_wallet': 'بازپرداخت به کیف پول',
  'web.finance_refunds_paid_out': 'بازپرداخت خارج از سامانه',
  'web.finance_net_sales': 'فروش خالص پس از بازپرداخت',
  'web.finance_principal': 'اصل مبلغ دریافتی',
  'web.finance_customer_fees': 'کارمزد درگاه (پرداختی مشتری)',
  'web.finance_customer_paid': 'پرداخت ناخالص مشتری',
  'web.finance_receipt_credits': 'رسید واریزشده به کیف پول',
  'web.finance_wallet_topups': 'شارژ کیف پول',
  'web.finance_wallet_spending': 'خرید از کیف پول',
  'web.finance_cashback_net': 'کش‌بک خالص (پس از برگشت)',
  'web.finance_commission_net': 'پورسانت معرفی خالص (پس از برگشت)',
  'web.finance_gifts': 'هدیه',
  'web.finance_buckets_title': 'به تفکیک بازه',
  'web.finance_buckets_hint':
    'هر ردیف یک بازه و یک واحد پول است. جمع ستون‌ها دقیقاً همان جمع دوره در بالاست و خروجی همین ردیف‌ها را دارد.',
  'web.finance_col_bucket': 'بازه',
  'web.finance_col_currency': 'واحد پول',
  'web.finance_col_sales_count': 'تعداد فروش',
  'web.finance_wallet_title': 'بدهی کیف پول',
  'web.finance_wallet_hint': 'ماندهٔ ابتدای دوره به‌علاوهٔ تغییرات، برابر ماندهٔ پایان دوره است.',
  'web.finance_opening': 'ماندهٔ ابتدای دوره',
  'web.finance_closing': 'ماندهٔ پایان دوره',
  'web.finance_channels_title': 'فروش به تفکیک روش پرداخت',
  'web.finance_channels_hint':
    'هر فروش با تنها پرداخت تأییدشدهٔ سفارش؛ جمع ردیف‌ها برابر فروش دوره است.',
  'web.finance_no_payment': 'بدون پرداخت (مبلغ صفر)',
  'web.finance_cash_routes_title': 'دریافتی به تفکیک مسیر پرداخت',
  'web.finance_products_title': 'فروش و بازپرداخت به تفکیک محصول',
  'web.finance_products_hint': 'با عنوانی که محصول در زمان خرید داشت.',
  'web.finance_products_truncated': 'فقط پرفروش‌ترین ردیف‌ها نشان داده شده‌اند.',
  'web.finance_reseller_sales': 'فروش به نمایندگان (مبلغی که از نماینده گرفته شد):',
  'web.rrq_title': 'سؤال‌های درخواست نمایندگی',
  'web.rrq_hint':
    'سؤال‌ها به همین ترتیب از متقاضی پرسیده می‌شوند. با کشیدن دستگیره ترتیب را عوض کنید. تغییر سؤال‌ها روی درخواست‌های فرستاده‌شده اثری ندارد.',
  'web.rrq_list_label': 'سؤال‌ها',
  'web.rrq_empty': 'سؤالی تعریف نشده؛ متقاضی مستقیم به خلاصه می‌رسد.',
  'web.rrq_text': 'متن سؤال',
  'web.rrq_text_problem': 'متن سؤال خالی یا خیلی بلند است.',
  'web.rrq_required': 'اجباری',
  'web.rrq_max': 'حداکثر طول پاسخ',
  'web.rrq_max_problem': 'عددی بین 1 و 2000 بنویسید.',
  'web.rrq_delete': 'حذف',
  'web.rrq_add': 'افزودن سؤال',
  'web.rrq_saved': 'سؤال‌ها ذخیره شد.',
  'web.rrq_view_only': 'شما فقط می‌توانید سؤال‌ها را ببینید.',
  'web.sortable_grip': 'جابه‌جایی',
  'web.sortable_hint': 'بکشید تا جابه‌جا شود؛ با صفحه‌کلید روی دستگیره فلش بالا یا پایین را بزنید.',
  // Customer 360: the customer's Mirza invoices beside the import's outcome.
  // Customer 360: the services card, and the legacy debt beside the wallet.
  // Every ledger reason, for the wallet history.
  'web.ledger_reason_topup_gateway': 'شارژ با درگاه',
  'web.ledger_reason_topup_receipt': 'شارژ با رسید کارت‌به‌کارت',
  'web.ledger_reason_topup_stars': 'شارژ با استارز تلگرام',
  'web.ledger_reason_topup_crypto': 'شارژ با رمزارز',
  'web.ledger_reason_receipt_credit': 'واریز مبلغ رسید به کیف پول',
  'web.ledger_reason_gateway_late_credit': 'تأیید دیرهنگام پرداخت',
  'web.ledger_reason_purchase': 'خرید',
  'web.ledger_reason_purchase_reversal': 'برگشت خرید',
  'web.ledger_reason_refund': 'بازپرداخت',
  'web.ledger_reason_cashback_gateway': 'بازگشت وجه پرداخت درگاهی',
  'web.ledger_reason_cashback_topup': 'هدیهٔ شارژ',
  'web.ledger_reason_cashback_renewal': 'بازگشت وجه تمدید',
  'web.ledger_reason_cashback_purchase': 'بازگشت وجه خرید',
  'web.ledger_reason_cashback_reversal': 'برگشت بازگشت وجه',
  'web.ledger_reason_referral_commission': 'پورسانت معرفی',
  'web.ledger_reason_referral_commission_reversal': 'برگشت پورسانت معرفی',
  'web.ledger_reason_referral_signup_gift': 'هدیهٔ عضویت با معرفی',
  'web.ledger_reason_gift_card_redemption': 'کارت هدیه',
  'web.ledger_reason_start_gift': 'هدیهٔ شروع',
  'web.ledger_reason_lottery_win': 'جایزهٔ قرعه‌کشی',
  'web.ledger_reason_luck_wheel_win': 'جایزهٔ گردونهٔ شانس',
  'web.ledger_reason_admin_credit': 'افزایش توسط مدیر',
  'web.ledger_reason_admin_debit': 'کاهش توسط مدیر',
  'web.ledger_reason_mass_credit': 'افزایش گروهی',
  'web.ledger_reason_mass_debit': 'کاهش گروهی',
  'web.ledger_reason_account_transfer_out': 'انتقال موجودی به حساب دیگر',
  'web.ledger_reason_account_transfer_in': 'انتقال موجودی از حساب دیگر',
  'web.ledger_reason_reseller_settlement': 'تسویهٔ نمایندگی',
  'web.ledger_reason_reseller_membership_fee': 'حق عضویت نمایندگی',
  'web.ledger_reason_migration_opening_balance': 'موجودی اولیه',
  'web.ledger_reason_chargeback': 'برگشت تراکنش بانکی',
  'web.ledger_reason_correction': 'اصلاح',
  'web.ledger_reason_other': 'سایر',
  'web.payment_gateway_enable_refused_credential_missing':
    'این درگاه روشن نشد: کلید API آن ثبت نشده است. ابتدا از «تنظیم کلید» کلید API درگاه را ثبت کنید، سپس دوباره روشن کنید.',
  'web.payment_gateway_enable_refused_webhook_secret_missing':
    'این درگاه روشن نشد: کلید وب‌هوک (IPN) آن ثبت نشده است. ابتدا کلید وب‌هوک را ثبت کنید، سپس دوباره روشن کنید.',
  'web.payment_gateway_enable_refused_verify_key_missing':
    'این درگاه روشن نشد: کلید تأیید آن ثبت نشده است. ابتدا کلید تأیید را ثبت کنید، سپس دوباره روشن کنید.',
  'web.payment_gateway_enable_refused_rate_missing':
    'این درگاه روشن نشد: نرخ تبدیل آن ثبت نشده است. ابتدا نرخ را در فرم درگاه ثبت کنید، سپس دوباره روشن کنید.',
  'web.payment_gateway_enable_refused_fx_unavailable':
    'این درگاه روشن نشد: نرخ مرکزی ارز خاموش است یا نسبت واحد آن ثبت نشده است.',
  'web.payments_view_needs_action': 'نیاز به اقدام',
  'web.payments_view_manual_pending': 'کارت‌به‌کارت در انتظار',
  'web.payments_view_unknown': 'نتیجهٔ نامعلوم',
  'web.refund_answer_column': 'اقدام',
  'web.pay_evidence_operator_review': 'بررسی مدیر',
  'web.pay_evidence_wallet_debit': 'برداشت از کیف پول',
  'web.pay_evidence_gateway_callback': 'پیام تأییدشدهٔ درگاه',
  'web.pay_evidence_reconciliation': 'تطبیق با پاسخ درگاه',
  'web.pay_evidence_gateway_inquiry': 'استعلام از درگاه',
  'web.pay_evidence_legacy_import': 'واردشده از ربات قبلی',
  'web.pay_receipt_kind_photo': 'عکس',
  'web.pay_receipt_kind_document': 'فایل',
  'web.pay_ledger_credit': 'واریز',
  'web.pay_ledger_debit': 'برداشت',
  'web.pay_creation_creating': 'در حال ساخت',
  'web.pay_creation_created': 'ساخته شد',
  'web.pay_creation_failed': 'ساخت ناموفق',
  'web.pay_creation_unknown': 'نتیجهٔ ساخت نامعلوم',
  'web.pay_outcome_settled': 'تسویه شد',
  'web.pay_outcome_already_settled': 'پیش‌تر تسویه شده بود',
  'web.pay_outcome_unsuccessful': 'ناموفق',
  'web.pay_outcome_late_completion': 'تأیید دیرهنگام',
  'web.pay_outcome_late_credited': 'تأیید دیرهنگام — به کیف پول واریز شد',
  'web.pay_notice_payment_rejected': 'رد پرداخت',
  'web.pay_notice_payment_expired': 'پایان مهلت پرداخت',
  'web.pay_notice_order_expired': 'پایان مهلت سفارش',
  'web.pay_notice_service_action_succeeded': 'انجام کار روی سرویس',
  'web.pay_notice_service_action_failed': 'انجام‌نشدن کار روی سرویس',
  'web.pay_notice_service_provision_delayed': 'تأخیر در ساخت سرویس',
  'web.pay_notice_payment_transfer_recorded': 'ثبت اعلام واریز',
  'web.pay_notice_order_cancelled': 'لغو سفارش',
  'web.pay_notice_wallet_topup_credited': 'شارژ کیف پول',
  'web.pay_notice_order_refunded_to_wallet': 'بازگشت مبلغ سفارش به کیف پول',
  'web.pay_notice_service_expiry_first': 'یادآوری اول پایان سرویس',
  'web.pay_notice_service_expiry_second': 'یادآوری دوم پایان سرویس',
  'web.pay_notice_service_expired': 'پایان سرویس',
  'web.pay_notice_service_usage_first': 'هشدار اول مصرف حجم',
  'web.pay_notice_service_usage_second': 'هشدار دوم مصرف حجم',
  'web.pay_notice_service_usage_final': 'هشدار پایان حجم',
  'web.pay_notice_trial_not_delivered': 'تحویل‌نشدن سرویس تست',
  'web.pay_notice_receipt_credited_to_wallet': 'واریز رسید به کیف پول',
  'web.pay_notice_wallet_topup_gift_credited': 'هدیهٔ شارژ کیف پول',
  'web.pay_notice_gateway_late_payment_credited': 'واریز پرداخت دیرهنگام به کیف پول',
  'web.pay_notice_refund_completed': 'انجام بازگشت وجه',
  'web.pay_notice_gateway_payment_failed': 'ناموفق‌بودن پرداخت درگاه',
  'web.pay_notice_service_refund_request_registered': 'ثبت درخواست بازگشت وجه سرویس',
  'web.pay_notice_service_refund_request_approved': 'تأیید درخواست بازگشت وجه سرویس',
  'web.pay_notice_service_refund_request_rejected': 'رد درخواست بازگشت وجه سرویس',
  'web.pay_notice_service_transfer_received': 'دریافت سرویس انتقالی',
  'web.pay_notice_ticket_reply': 'پاسخ تیکت',
  'web.pay_notice_service_expiry_early': 'یادآوری زودهنگام پایان سرویس',
  'web.pay_notice_service_expiry_day': 'یادآوری روز پایان سرویس',
  'web.pay_notice_wallet_low_balance': 'کم‌بودن موجودی کیف پول',
  'web.pay_notice_payment_pending_reminder': 'یادآوری پرداخت در انتظار',
  'web.pay_notice_order_pending_reminder': 'یادآوری سفارش در انتظار',
  'web.pay_notice_ticket_reply_attachment': 'پیوست پاسخ تیکت',
  'web.pay_notice_service_renewed': 'تمدید سرویس',
  'web.pay_notice_reseller_minimum_reminder': 'یادآوری حداقل فروش نماینده',
  'web.pay_notice_reseller_minimum_achieved': 'رسیدن به حداقل فروش نماینده',
  'web.pay_notice_wallet_mass_credited': 'واریز گروهی به کیف پول',
  'web.pay_notice_service_gift_applied': 'اعمال هدیهٔ سرویس',
  'web.pay_notice_direct_message': 'پیام مستقیم',
  'web.pay_notice_direct_message_media': 'پیام مستقیم با رسانه',
  'web.pay_notice_incident_notice': 'اطلاعیهٔ رخداد',
  'web.pay_notice_wallet_admin_credited': 'افزایش دستی موجودی',
  'web.pay_notice_wallet_admin_debited': 'کسر دستی موجودی',
  'web.pay_notice_account_unblocked': 'رفع مسدودی حساب',
  'web.pay_notice_service_traffic_added': 'خرید حجم اضافه',
  'web.pay_notice_service_time_added': 'خرید زمان اضافه',
  'web.pay_notice_service_auto_renew_funds_short': 'کمبود موجودی برای تمدید خودکار',
  'web.pay_notice_service_auto_renew_price_changed': 'تغییر مبلغ تمدید خودکار',
  'web.pay_notice_reseller_expired': 'پایان مهلت نمایندگی',
  'web.pay_notice_service_auto_delete_warning': 'هشدار حذف خودکار سرویس',
  'web.pay_notice_reseller_request_message': 'پیام مدیریت دربارهٔ درخواست نمایندگی',
  'web.pay_notice_reseller_request_decision': 'نتیجهٔ درخواست نمایندگی',
  'web.pay_notice_reseller_web_new_device': 'ورود تازه به پنل نماینده',
  'web.pay_provider_pending': 'در انتظار',
  'web.pay_provider_processing': 'در حال پردازش',
  'web.pay_provider_completed': 'تکمیل‌شده',
  'web.pay_provider_need_action': 'نیازمند اقدام',
  'web.pay_provider_action_required_less': 'کم‌پرداخت (مابقی لازم است)',
  'web.pay_provider_action_required_more': 'بیش‌پرداخت (کارت بازگشت وجه لازم است)',
  'web.pay_provider_rejected': 'ردشده',
  'web.pay_provider_expired': 'منقضی',
  'web.pay_provider_canceled': 'لغوشده',
  'web.pay_provider_waiting': 'در انتظار پرداخت',
  'web.pay_provider_confirming': 'در حال تأیید',
  'web.pay_provider_confirmed': 'تأییدشده',
  'web.pay_provider_sending': 'در حال ارسال',
  'web.pay_provider_partially_paid': 'پرداخت ناقص',
  'web.pay_provider_finished': 'تمام‌شده',
  'web.pay_provider_failed': 'ناموفق',
  'web.pay_provider_refunded': 'بازگشت‌خورده',
  'web.pay_provider_verified': 'تأییدشده',
  'web.pay_provider_unverified': 'تأییدنشده',
  'web.pay_provider_paid_yes': 'پول رسیده',
  'web.pay_provider_paid_no': 'پول نرسیده',
  'web.pay_mismatch_amount': 'مبلغ ناهمخوان',
  'web.money_tab_unsaved': 'تغییر ذخیره‌نشده',
  'web.money_tab_problem': 'نیاز به اصلاح',
} as const;
