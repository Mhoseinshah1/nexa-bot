/**
 * Web Admin catalogue — payments, receipts, refunds, wallet, ledger, finance (part 1 of 2).
 *
 * One slice of `WEB_FA`; `../web.fa.ts` merges every slice and is what pages import.
 */
export const WEB_FA_PAYMENTS_1 = {
  'web.topup_preset_add': 'افزودن مبلغ',
  'web.topup_preset_empty': 'هیچ مبلغی تنظیم نشده است.',
  // OPS-A redesign (round W, wave 2): bot buttons.
  // OPS-A redesign (round W, wave 2): payment routes.
  'web.payment_gateway_section_display': 'نمایش به مشتری',
  'web.payment_gateway_section_amounts': 'محدودهٔ مبلغ',
  'web.payment_gateway_section_money': 'هدیه، کارمزد و نرخ',
  'web.payment_gateway_section_advanced': 'پیشرفته',
  'web.payment_gateway_sort_hint':
    'روش‌ها به ترتیب این عدد، کوچک به بزرگ، به مشتری نشان داده می‌شوند.',

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
  'web.wallet_adjust_hint':
    'مبلغ به واحد خرد و فقط رقم. علت تراکنش از روی جهت آن تعیین می‌شود و قابل انتخاب نیست.',
  'web.wallet_adjust_amount': 'مبلغ (واحد خرد)',
  'web.wallet_adjust_show_note': 'نمایش دلیل به مشتری',
  'web.wallet_adjust_show_note_hint':
    'مشتری پیام افزایش یا کسر موجودی را با مبلغ و موجودی جدید دریافت می‌کند. یادداشت بالا فقط وقتی به‌عنوان دلیل به او نشان داده می‌شود که این گزینه را بزنید.',
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
  'web.wallet_imported_title': 'تاریخچهٔ پیشین کیف پول',
  'web.wallet_imported_hint':
    'این ردیف‌ها تاریخچهٔ پیشین هستند و در موجودی فعلی جمع نمی‌شوند؛ موجودی پیشین یک‌بار به‌صورت موجودی اولیه وارد شده است.',
  'web.wallet_imported_wheel': 'گردونهٔ شانس',
  'web.wallet_balance_negative_hint':
    'موجودی منفی بدهی پیشین یک نماینده است: خریدی که پیش از حذف خرید اعتباری از اعتبار او برداشته شد. هیچ خریدی دیگر موجودی را زیر صفر نمی‌برد. این عدد همان مجموع تراکنش‌هاست؛ بدهی سر جای خود می‌ماند، وصول یا جریمه نمی‌شود و فقط با شارژ یا اعتبار دستی جبران می‌شود.',

  // --- Payments (Phase 4C) -------------------------------------------------
  /*
   * PAID means the money arrived and nothing else.
   *
   * No string here says a service was created, is being prepared, or is on its
   * way — because nothing in this release does any of that. The legacy bot's
   * post-payment copy is the defect this comment exists to prevent being ported:
   * a message that claims an effect which did not happen.
   */
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
  'web.payment_reference': 'کد پیگیری پرداخت',
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
  'web.payment_gateway': 'درگاه',
  'web.payment_external_reference': 'شناسهٔ پیگیری بیرونی',
  'web.payment_updated_at': 'آخرین تغییر',
  'web.payment_customer_fee_rate': 'نرخ کارمزد مشتری',
  'web.payment_customer_fee_amount': 'کارمزد درگاه',
  'web.payment_customer_fee_payable': 'مبلغ قابل پرداخت',
  'web.payment_transfer_payable': 'مبلغ قابل واریز مشتری',
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
  'web.payments_search_hint':
    'شناسهٔ عددی تلگرام، کد پیگیری یا شمارهٔ مرجع بانک (دقیق)، شناسهٔ پرداخت یا سفارش، یا ‎@نام کاربری.',
  'web.payments_filter_all': 'همه',
  'web.payments_about_fold': 'دربارهٔ این فهرست',
  'web.payment_ops_title': 'مرکز عملیات پرداخت',
  'web.payment_ops_intro':
    'همهٔ پرداخت‌ها در همهٔ درگاه‌ها، با صف‌هایی برای آنچه نیاز به رسیدگی دارد. هیچ صفی وضعیت پرداخت نیست و هیچ دکمه‌ای اینجا پرداخت را «پرداخت‌شده» نمی‌کند.',
  'web.payment_ops_queue': 'صف',
  'web.payment_ops_queue_all': 'همه',
  'web.payment_ops_queue_pending': 'در انتظار',
  'web.payment_ops_queue_unknown': 'نامعلوم',
  'web.payment_ops_queue_needs_reconciliation': 'آمادهٔ تطبیق',
  'web.payment_ops_queue_mismatch': 'ناهمخوانی',
  'web.payment_ops_queue_partial': 'پرداخت ناقص',
  'web.payment_ops_queue_late_completion': 'تأیید دیرهنگام',
  'web.payment_ops_queue_provider_error': 'خطای درگاه / استعلام',
  'web.payment_ops_queue_refund_related': 'مرتبط با بازپرداخت',
  'web.payment_ops_queue_hint_pending': 'پرداخت‌هایی که هنوز باز هستند.',
  'web.payment_ops_queue_hint_unknown':
    'نتیجه نامعلوم است؛ نه موفق است و نه ناموفق، تا وقتی با پاسخ ثبت‌شدهٔ درگاه تطبیق داده شود.',
  'web.payment_ops_queue_hint_needs_reconciliation':
    'پرداخت‌های نامعلومی که پاسخ ثبت‌شدهٔ درگاه همین حالا برای تطبیق کافی است.',
  'web.payment_ops_queue_hint_mismatch':
    'درگاه پولی گزارش کرده که با فاکتور نمی‌خواند (مبلغ، مشتری یا شناسهٔ دیگر). هیچ چیزی خودکار تسویه نشده است.',
  'web.payment_ops_queue_hint_partial':
    'درگاه پرداخت ناقص گزارش کرده است (فقط درگاه‌هایی که چنین وضعیتی دارند).',
  'web.payment_ops_queue_hint_late_completion':
    'درگاه پس از پایان مهلت تأیید کرده است؛ چیزی جابه‌جا نشده و تصمیم با اپراتور است.',
  'web.payment_ops_queue_hint_provider_error':
    'ساخت فاکتور رد شد یا پاسخش گم شد، یا آخرین استعلام با خطا تمام شد.',
  'web.payment_ops_queue_hint_refund_related': 'پرداخت‌هایی که دست‌کم یک بازپرداخت دارند.',
  // --- roadmap E1/E2 (Agent 5, payments): the situation guide and the NEEDS_ACTION queue ---
  'web.payment_ops_queue_needs_action': 'نیازمند اقدام',
  'web.payment_ops_queue_hint_needs_action':
    'پرداخت‌هایی که تا کسی اقدام نکند جلو نمی‌روند؛ قدیمی‌ترین اول نمایش داده می‌شود.',
  'web.payment_situation_card': 'وضعیت و اقدام',
  'web.payment_situation_money': 'پول',
  'web.payment_situation_customer': 'مشتری باید',
  'web.payment_situation_no_action': 'اقدامی لازم نیست.',
  'web.payment_situation_needs_action': 'نیازمند اقدام',
  'web.payment_situation_awaiting_payment': 'در انتظار پرداخت مشتری',
  'web.payment_situation_invoice_not_issued': 'فاکتور درگاه صادر نشد',
  'web.payment_situation_customer_signalled': 'مشتری اعلام واریز کرده است (بدون رسید)',
  'web.payment_situation_receipt_under_review': 'رسید در انتظار بررسی',
  'web.payment_situation_provider_review': 'در بررسی درگاه',
  'web.payment_situation_outcome_unknown': 'نتیجه نامعلوم',
  'web.payment_situation_mismatch': 'مغایرت',
  'web.payment_situation_partial': 'پرداخت ناقص',
  'web.payment_situation_late_completion': 'تأیید دیرهنگام درگاه',
  'web.payment_situation_confirmed': 'تأییدشده',
  'web.payment_situation_refund_in_progress': 'بازپرداخت در جریان',
  'web.payment_situation_refunded': 'بازپرداخت‌شده',
  'web.payment_situation_credited_to_wallet': 'واریز به کیف پول',
  'web.payment_situation_late_credited': 'تأیید دیرهنگام — به کیف پول واریز شد',
  'web.payment_situation_what_late_credited':
    'درگاه پرداخت را پس از پایان مهلت تأیید کرد، استعلام درگاه آن را دوباره تأیید کرد و مبلغ همان‌جا به کیف پول مشتری واریز شد. سفارش پرداخت نشده است و سرویسی ساخته نشد.',
  'web.payment_situation_safe_late_credited':
    'به مشتری نگویید دوباره پرداخت کند: پول در کیف پول اوست و می‌تواند از همان برای خرید استفاده کند.',
  'web.payment_situation_rejected': 'ردشده توسط بازبین',
  'web.payment_situation_failed': 'ناموفق',
  'web.payment_situation_expired': 'منقضی‌شده',
  'web.payment_situation_cancelled': 'لغوشده',
  'web.payment_situation_what_awaiting_payment':
    'دستورالعمل یا لینک پرداخت برای مشتری فرستاده شده و مشتری هنوز چیزی اعلام نکرده است.',
  'web.payment_situation_what_invoice_not_issued':
    'درگاه ساخت فاکتور را رد کرد یا پاسخ آن دریافت نشد؛ لینکی به مشتری داده نشده است.',
  'web.payment_situation_what_customer_signalled':
    'مشتری می‌گوید مبلغ را واریز کرده است، اما هنوز رسیدی نفرستاده است. این ادعای مشتری است و چیزی برای بررسی وجود ندارد.',
  'web.payment_situation_what_receipt_under_review':
    'مشتری رسید واریز را فرستاده است و پرداخت منتظر تصمیم بازبین است. رسید ادعای مشتری است، نه تأیید.',
  'web.payment_situation_what_provider_review':
    'درگاه رسید مشتری را دریافت کرده و پرداخت در مهلت بررسی خود درگاه است.',
  'web.payment_situation_what_outcome_unknown':
    'ممکن است درگاه پول را گرفته باشد و این سامانه نمی‌تواند بگوید. تا تطبیق، نه موفق است نه ناموفق.',
  'web.payment_situation_what_mismatch':
    'پاسخ درگاه با این پرداخت جور نبود (مبلغ، مشتری یا شناسهٔ دیگر) و سامانه آن را برای بررسی نگه داشت.',
  'web.payment_situation_what_partial':
    'درگاه پرداخت ناقص ثبت کرده است. هیچ تسویه‌ای انجام نشده است.',
  'web.payment_situation_what_late_completion':
    'درگاه پس از پایان مهلت پرداخت را تأیید کرد. پول نزد درگاه است و در این سامانه چیزی تسویه نشده است.',
  'web.payment_situation_what_confirmed':
    'پول با شواهدی که این سامانه به آن اعتماد دارد تأیید شده است.',
  'web.payment_situation_what_refund_in_progress':
    'پرداخت تأیید شده است و یک بازپرداخت هنوز باز است.',
  'web.payment_situation_what_refunded':
    'تمام یا بخشی از مبلغ این پرداخت بازپرداخت شده است (برای پرداختی که به سفارش نرسید، به کیف پول مشتری).',
  'web.payment_situation_what_credited_to_wallet':
    'بازبین رسید را بررسی کرد و مبلغی را که دید به کیف پول مشتری واریز کرد؛ سفارش با این پرداخت پرداخت نشد.',
  'web.payment_situation_what_rejected':
    'مدیر این واریز کارت‌به‌کارت را بررسی کرد و آن را نپذیرفت.',
  'web.payment_situation_what_failed':
    'درگاه پرداخت را ناموفق اعلام کرد یا پرداخت با تطبیق ناموفق بسته شد.',
  'web.payment_situation_what_expired': 'مهلت پرداخت تمام شد و چیزی تأیید نشد.',
  'web.payment_situation_what_cancelled': 'پرداخت پیش از تأیید پس گرفته شد.',
  'web.payment_situation_safe_awaiting_payment':
    'کاری لازم نیست؛ سامانه پرداخت را در پایان مهلت خودش می‌بندد.',
  'web.payment_situation_safe_invoice_not_issued':
    'از اینجا نمی‌توان فاکتور را دوباره ساخت؛ مشتری می‌تواند پرداخت تازه‌ای آغاز کند.',
  'web.payment_situation_safe_customer_signalled':
    'کاری لازم نیست تا رسید برسد؛ اگر نرسد، پرداخت در پایان مهلت خودش بسته می‌شود.',
  'web.payment_situation_safe_receipt_under_review':
    'پیش از تأیید، واریز را در صورت‌حساب بانک ببینید. تأیید، رد یا واریز به کیف پول فقط در تلگرام انجام می‌شود.',
  'web.payment_situation_safe_provider_review':
    'تا پایان مهلت بررسی درگاه منتظر بمانید و پرداخت را دستی تأیید یا رد نکنید.',
  'web.payment_situation_safe_outcome_unknown':
    'بازپرداخت یا واریز دستی نکنید. ابتدا از درگاه دوباره بپرسید و فقط بر پایهٔ پاسخ ثبت‌شده تطبیق دهید.',
  'web.payment_situation_safe_mismatch':
    'تا پاسخ ثبت‌شدهٔ درگاه تطبیق را پشتیبانی نکند کاری نکنید، و پول دیگری را به این پرداخت نسبت ندهید.',
  'web.payment_situation_safe_partial':
    'سامانه پرداخت ناقص را تسویه نمی‌کند. در پنل درگاه بررسی کنید؛ اگر پرداخت دیگر «نامعلوم» نیست، واریز دستی به کیف پول تنها راه موجود است و سیاست آن هنوز تصمیم‌گیری نشده است.',
  'web.payment_situation_safe_late_completion':
    'هیچ‌چیز خودکار تسویه نمی‌شود. در پنل درگاه بررسی کنید؛ اگر پرداخت هنوز «نامعلوم» است با تطبیق، وگرنه تنها با واریز دستی به کیف پول که سیاست آن هنوز تصمیم‌گیری نشده است.',
  'web.action_panel_why_unavailable': 'چرا برخی عملیات در دسترس نیست؟',
  'web.payment_situation_safe_confirmed':
    'هر بازپرداخت از سقف همین پرداخت کم می‌شود؛ کارمزد درگاه بازپرداخت‌پذیر نیست.',
  'web.payment_situation_safe_refund_in_progress':
    'بازپرداخت دستی را فقط پس از انجام واقعی انتقال «تکمیل» کنید.',
  'web.payment_situation_safe_refunded':
    'باقی‌ماندهٔ قابل بازپرداخت را سرور حساب می‌کند، نه این صفحه.',
  'web.payment_situation_safe_credited_to_wallet':
    'این یک رد نیست؛ پول به کیف پول رسیده است. دوباره واریز نکنید.',
  'web.payment_situation_safe_rejected':
    'مبلغی را دستی جابه‌جا نکنید؛ مشتری می‌تواند تا پایان مهلت سفارش دوباره پرداخت کند.',
  'web.payment_situation_safe_failed': 'مشتری می‌تواند دوباره پرداخت کند.',
  'web.payment_situation_safe_expired':
    'اگر پس از این پولی از درگاه برسد، به‌صورت «تأیید دیرهنگام» نشان داده می‌شود.',
  'web.payment_situation_safe_cancelled': 'کاری لازم نیست.',
  'web.payment_money_not_yet': 'هنوز پرداخت نشده است',
  'web.payment_money_no': 'پولی دریافت نشده است',
  'web.payment_money_claimed': 'مشتری ادعای واریز دارد (تأییدنشده)',
  'web.payment_money_possibly': 'شاید پول جابه‌جا شده باشد',
  'web.payment_money_partially': 'بخشی از مبلغ نزد درگاه است',
  'web.payment_money_at_provider': 'پول نزد درگاه است، نه در این سامانه',
  'web.payment_money_yes': 'پول دریافت شده است',
  'web.payment_money_to_wallet': 'به کیف پول مشتری واریز شد',
  'web.payment_money_returning': 'بازپرداخت در جریان است',
  'web.payment_money_returned': 'تمام یا بخشی بازپرداخت شد',
  'web.payment_customer_guidance_pay_within_window': 'تا پایان مهلت پرداخت کند',
  'web.payment_customer_guidance_send_receipt': 'رسید واریز را از طریق ربات بفرستد',
  'web.payment_customer_guidance_start_again': 'می‌تواند پرداخت تازه‌ای آغاز کند',
  'web.payment_customer_guidance_wait_do_not_pay_again': 'منتظر بماند و دوباره پرداخت نکند',
  'web.payment_customer_guidance_may_pay_again': 'در صورت تمایل دوباره پرداخت کند',
  'web.payment_customer_guidance_nothing': 'کاری لازم نیست',
  'web.payment_operator_action_review_receipt_in_telegram':
    'بررسی رسید (تأیید، رد یا واریز به کیف پول) — فقط در تلگرام',
  'web.payment_operator_action_ask_provider_again': 'پرسش دوباره از درگاه — کارت تطبیق',
  'web.payment_operator_action_reconcile': 'تطبیق از روی پاسخ ثبت‌شدهٔ درگاه — کارت تطبیق',
  'web.payment_operator_action_verify_at_provider': 'بررسی در پنل خود درگاه',
  'web.payment_operator_action_manual_wallet_adjustment':
    'واریز دستی به کیف پول از صفحهٔ مشتری — سیاست آن تصمیم‌گیری نشده است',
  'web.payment_operator_action_issue_refund': 'بازپرداخت — کارت بازپرداخت‌ها',
  'web.payment_operator_action_late_deliver': 'تحویل سرویس — کارت «پرداخت دیرهنگام»',
  'web.payment_operator_action_late_to_wallet': 'واریز به کیف پول — کارت «پرداخت دیرهنگام»',
  'web.payment_operator_action_settle_refund': 'تکمیل یا لغو بازپرداخت باز — کارت بازپرداخت‌ها',
  // --- end roadmap E1/E2 block ---
  // --- roadmap E4/E5 (Agent 5, payments): one money breakdown, one rate provenance ---
  'web.payment_amounts': 'مبالغ این پرداخت',
  'web.payment_amounts_hint':
    'همهٔ مبالغ را سرور از تصویر ثبت‌شدهٔ همین پرداخت حساب کرده است؛ این صفحه چیزی محاسبه نمی‌کند.',
  'web.payment_amounts_principal': 'مبلغ اصل (سفارش یا شارژ)',
  'web.payment_amounts_received': 'دریافت‌شده از بیرون (تأییدشده)',
  'web.payment_amounts_wallet_credit': 'واریز به کیف پول با این پرداخت',
  'web.payment_amounts_wallet_debit': 'برداشت از کیف پول با این پرداخت',
  'web.payment_amounts_merchant_net': 'خالص دریافتی فروشنده',
  'web.payment_amounts_merchant_net_not_recorded':
    'ثبت نشده — هیچ درگاهی سهم خود را گزارش نمی‌کند و این عدد ساخته نمی‌شود.',
  'web.payment_rate_provenance': 'منشأ نرخ تبدیل',
  'web.payment_rate_provenance_hint':
    'نرخی که هنگام ساخت این فاکتور ثبت و قفل شد؛ نرخ امروز آن را تغییر نمی‌دهد.',
  'web.payment_rate_authority': 'مرجع نرخ',
  'web.payment_rate_authority_none': 'بدون تبدیل (درگاه به ارز فروش صورت‌حساب می‌دهد)',
  'web.payment_rate_authority_operator': 'نرخ ثابت تعیین‌شده توسط اپراتور',
  'web.payment_rate_authority_market': 'نرخ مرکزی بازار',
  'web.payment_rate_value': 'نرخ (واحد خرد ارز فروش به ازای هر واحد درگاه)',
  'web.payment_rate_missing': 'نرخی ثبت نشده است؛ هیچ نرخ دیگری جایگزین نمی‌شود.',
  'web.payment_rate_source': 'منبع',
  'web.payment_rate_quoted_at': 'زمان دفتر سفارش منبع',
  'web.payment_rate_fetched_at': 'زمان دریافت نرخ',
  'web.payment_rate_quote_state': 'وضعیت نرخ هنگام قیمت‌گذاری',
  'web.payment_rate_quote_id': 'شناسهٔ نرخ',
  'web.payment_rate_frozen_at': 'زمان قفل شدن نرخ روی فاکتور',
  // --- end roadmap E4/E5 block ---
  'web.payment_ops_gateway_all': 'همهٔ درگاه‌ها',
  'web.payment_ops_range': 'بازهٔ ایجاد',
  'web.payment_ops_range_all': 'همهٔ زمان‌ها',
  'web.payment_ops_range_today': 'امروز',
  'web.payment_ops_range_7d': '7 روز اخیر',
  'web.payment_ops_range_30d': '30 روز اخیر',
  'web.payment_ops_range_month': 'این ماه',
  'web.payment_ops_counts_error': 'شمار صف‌ها خوانده نشد.',
  'web.payment_ops_situation': 'وضعیت عملیاتی',
  'web.payment_ops_signal': 'آخرین پاسخ درگاه',
  'web.payment_ops_signal_inquiry_error': 'خطای استعلام',
  'web.payment_ops_signal_create': 'ساخت فاکتور',
  'web.payment_row_detail': 'جزئیات این پرداخت',
  'web.payment_ops_no_force_paid':
    'تأیید یک پرداخت فقط از راه تسویه و با مدرک انجام می‌شود. برای نامعلوم‌ها «استعلام دوباره» و سپس تطبیق در صفحهٔ پرداخت؛ برای برگشت پول، کارت بازپرداخت همان صفحه.',
  'web.payment_confirm_title': 'بررسی رسید',
  /*
   * R12 F3 item 8: card-to-card review is in BOTH places (owner decision, reversing Payment File
   * 02 §10's "Telegram only"). The same three dispositions, through the same application methods.
   */
  'web.receipt_review_hint':
    'رسید را ببینید و یکی از تصمیم‌ها را ثبت کنید: تأیید، رد یا واریز به کیف پول. همین تصمیم‌ها در ربات تلگرام هم انجام می‌شود و تصمیمِ اول معتبر است.',
  'web.receipt_note': 'یادداشت (اختیاری)',
  'web.receipt_approve': 'تأیید پرداخت',
  'web.receipt_approve_title': 'تأیید پرداخت کارت‌به‌کارت',
  'web.receipt_approve_body':
    'با تأیید، پرداخت به مبلغ زیر ثبت و نهایی می‌شود و سفارش یا شارژ مشتری ادامه پیدا می‌کند. این کار برگشت‌پذیر نیست.',
  'web.receipt_approve_check': 'مبلغ رسید را با حساب بانکی تطبیق داده‌ام',
  'web.receipt_approve_confirm': 'تأیید و ثبت پرداخت',
  'web.receipt_done_approved': 'پرداخت تأیید شد.',
  'web.receipt_reject': 'رد رسید',
  'web.receipt_reject_title': 'رد رسید',
  'web.receipt_reject_body':
    'دلیل رد به مشتری اعلام می‌شود. با رد رسید، این پرداخت بسته می‌شود و مشتری باید دوباره پرداخت کند.',
  'web.receipt_reject_reason': 'دلیل رد (به مشتری گفته می‌شود)',
  'web.receipt_reject_confirm': 'رد رسید',
  'web.receipt_done_rejected': 'رسید رد شد و دلیل آن به مشتری اعلام می‌شود.',
  'web.receipt_credit': 'واریز به کیف پول',
  'web.receipt_credit_title': 'واریز به کیف پول مشتری',
  'web.receipt_credit_hint':
    'مبلغی را که واقعاً به حساب رسیده به کیف پول مشتری اضافه می‌کند. سفارش پرداخت‌شده حساب نمی‌شود و هدیهٔ شارژ ندارد؛ مشتری می‌تواند با کیف پول پرداخت کند.',
  'web.receipt_credit_amount': 'مبلغ رسیده، به واحد پایه',
  'web.receipt_credit_invalid': 'مبلغ باید عدد صحیح مثبت باشد.',
  'web.receipt_credit_will_add': 'به کیف پول اضافه می‌شود',
  'web.receipt_credit_check': 'مبلغ رسیده را با حساب بانکی تطبیق داده‌ام',
  'web.receipt_credit_confirm': 'واریز به کیف پول',
  'web.receipt_done_credited': 'مبلغ به کیف پول مشتری واریز شد.',
  'web.receipt_denied':
    'بررسی رسید به دسترسی receipts.review نیاز دارد. در ربات تلگرام هم قابل انجام است.',
  'web.receipt_credit_denied': 'واریز به کیف پول به دسترسی users.wallet.credit هم نیاز دارد.',
  'web.payment_ops_queue_receipt_review': 'رسید در انتظار بررسی',
  'web.payment_ops_queue_hint_receipt_review':
    'کارت‌به‌کارت‌هایی که مشتری رسید فرستاده و هنوز کسی تأیید یا رد نکرده است.',
  'web.payment_currency': 'واحد پول',
  'web.search_group_payment': 'پرداخت‌ها',
  'web.search_group_ticket': 'تیکت‌ها',
  // Payment accounts — the destination an out-of-band transfer is told to go to.
  // The screen that replaces editing a message template to change a card number.
  // UX Batch 01, item 7: the cards of the card-to-card method, managed on its own view
  // (`/payment-gateways/card-to-card`); the separate «حساب‌های دریافت» entry is gone.
  'web.payment_accounts_title': 'کارت‌های مقصد',
  'web.payment_accounts_subtitle':
    'کارتی که به مشتری برای واریز کارت به کارت نشان داده می‌شود. ترتیب نمایش را در بخش «پیشرفته» فرم کارت تنظیم کنید.',
  'web.payment_accounts_empty': 'هنوز کارتی ثبت نشده است.',
  'web.payment_accounts_empty_hint':
    'تا زمانی که حساب فعالی ثبت نشود، دکمهٔ پرداخت کارت به کارت به مشتری نشان داده نمی‌شود.',
  'web.payment_account_label': 'نام حساب',
  'web.payment_account_bank': 'بانک',
  'web.payment_account_holder': 'به نام',
  'web.payment_account_card': 'شماره کارت',
  'web.payment_account_card_hint': '16 رقم. فاصله، خط تیره و ارقام فارسی نیز پذیرفته می‌شود.',
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
  'web.payment_account_new': 'کارت جدید',
  'web.payment_account_add': 'افزودن کارت',
  'web.payment_account_editing': 'ویرایش کارت',
  // Says the two things an operator cannot see from the form: an edit does not
  // reach an instruction already sent, and there is no delete.
  'web.payment_account_form_hint':
    'ویرایش یک کارت، پرداخت‌هایی که پیش‌تر صادر شده‌اند را تغییر نمی‌دهد. کارت حذف نمی‌شود؛ برای بایگانی، آن را غیرفعال کنید تا سابقهٔ پرداخت‌های قبلی حفظ شود.',
  'web.payment_account_save': 'ذخیره',
  'web.payment_account_cancel_edit': 'انصراف',
  'web.payment_account_saved': 'کارت ذخیره شد.',
  'web.payment_account_default_done': 'مقصد پرداخت‌های جدید تغییر کرد.',
  'web.payment_account_limit': 'سقف تعداد کارت‌ها پر شده است. یکی را غیرفعال کنید.',
  'web.payment_gateways_title': 'روش‌های پرداخت',
  // UX Batch 01, item 8: each payment method's own view, at its own URL.
  'web.payment_method_open': 'مدیریت',
  'web.payment_method_back': 'بازگشت به روش‌های پرداخت',
  'web.payment_method_settings': 'تنظیمات این روش پرداخت',
  'web.payment_method_health': 'سلامت این روش پرداخت',
  'web.payment_method_unknown': 'روش پرداخت یافت نشد',
  'web.payment_method_missing': 'این روش پرداخت در این نصب وجود ندارد.',
  'web.payment_method_cards_only_hint':
    'کارت‌های مقصد کارت به کارت در صفحهٔ همین روش پرداخت مدیریت می‌شوند.',
  'web.redirect_moved': 'این صفحه جابه‌جا شده است؛ در حال انتقال…',
  'web.payment_gateways_subtitle':
    'روش‌هایی که به مشتری پیشنهاد می‌شود، به همان ترتیب و با همان شرط‌ها.',
  // Says the thing the screen cannot show: the roster is what the software can
  // actually operate, so there is no Add button and its absence is not a defect.
  'web.payment_gateways_hint':
    'فهرست روش‌ها ثابت است و تنها روش‌هایی را نشان می‌دهد که این نسخه می‌تواند انجام دهد. روش جدید با نسخهٔ جدید اضافه می‌شود، نه از این صفحه.',
  // The wallet top-up warning: the server's own route decision (the one the bot uses to
  // hide «💰 افزایش موجودی»), drawn per route. Never re-decided here.
  'web.payment_gateways_topup_unavailable_title': 'هیچ روشی برای افزایش موجودی کیف پول فعال نیست',
  'web.payment_gateways_topup_unavailable_body':
    'برای همین دکمهٔ «💰 افزایش موجودی» در ربات به مشتری نشان داده نمی‌شود. دلیل هر روش:',
  'web.payment_gateways_topup_block_inactive': 'خاموش است',
  'web.payment_gateways_topup_block_inactive_keyed': 'کلید API دارد اما خاموش است',
  'web.payment_gateways_topup_block_inactive_no_key': 'خاموش است و کلید API ندارد',
  'web.payment_gateways_topup_block_purpose_off': 'افزایش موجودی برای این روش خاموش است',
  'web.payment_gateways_topup_block_no_receiving_account': 'هیچ کارت مقصد فعالی ندارد',
  'web.payment_gateways_topup_block_unpriceable': 'نسبت واحد نرخ مرکزی تنظیم نشده است',
  'web.payment_gateways_topup_block_hidden':
    'سقف روزانهٔ درگاه پر شده است و تا ساعت 00:00 به وقت تهران پنهان می‌ماند',
  'web.payment_gateway_provider': 'روش',
  'web.payment_gateway_provider_manual_transfer': 'کارت به کارت',
  'web.payment_gateway_provider_tonpays': 'درگاه پرداخت تون پی وبسایت',
  'web.payment_gateway_provider_tonpays_telegram': 'درگاه پرداخت تون پی تلگرام',
  'web.payment_gateway_provider_telegram_stars': 'تلگرام استارز (⭐)',
  'web.payment_gateway_provider_nowpayments': 'درگاه ارز دیجیتال (NOWPayments)',
  'web.payment_gateway_provider_centralpay': 'درگاه CentralPay',
  'web.payment_gateway_provider_tetrapay': 'درگاه تتراپی',
  'web.payment_gateway_provider_rialit': 'درگاه ریالیت',
  // Package A: the Stars route's operator-set rate. No FX feed exists or is implied.
  'web.payment_gateway_provider_custom': 'درگاه کاستوم (پل پرداخت)',
  'web.payment_gateway_rate': 'نرخ هر ستاره (به کوچک‌ترین واحد ارز فروش)',
  'web.payment_gateway_rate_hint':
    'مبلغ یک ستارهٔ تلگرام به کوچک‌ترین واحد ارز فروش؛ عدد صحیح مثبت. تعداد ستارهٔ هر پرداخت = سقفِ (مبلغ قابل پرداخت ÷ این نرخ). نرخ روی هر پرداخت ثبت می‌شود و تغییر آن پرداخت‌های قبلی را تغییر نمی‌دهد. بدون نرخ، این روش فعال نمی‌شود. خالی گذاشتن نرخ را پاک می‌کند (فقط وقتی روش غیرفعال است).',
  'web.payment_gateway_rate_invalid': 'نرخ باید یک عدد صحیح مثبت باشد.',
  'web.payment_gateway_rate_column': 'نرخ ستاره',
  'web.payment_gateway_rate_missing': 'نرخ تعیین نشده',
  'web.payment_gateway_invoice': 'فاکتور درگاه',
  'web.payment_gateway_invoice_hint':
    'اطلاعات سمت درگاه برای پشتیبانی و بررسی. مبالغ درگاه فقط اطلاعات تکمیلی‌اند؛ تأیید پرداخت فقط با استعلام مستقیم (completed و paid=true) و پیش از پایان مهلت 70 دقیقه‌ای انجام می‌شود.',
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
  'web.payment_gateway_invoice_policy': 'روش تبدیل مبلغ',
  'web.payment_gateway_invoice_fx': 'نرخ ارز ثبت‌شده روی فاکتور',
  'web.payment_gateway_credential': 'کلید API',
  'web.payment_gateway_credential_none': 'لازم نیست',
  'web.payment_gateway_credential_missing': 'تنظیم نشده',
  'web.payment_gateway_credential_configured': 'تنظیم شده ••••••••',
  'web.payment_gateway_credential_edit': 'تنظیم کلید API',
  'web.payment_gateway_credential_title': 'کلید API درگاه',
  'web.payment_gateway_credential_hint':
    'کلید ذخیره‌شده هرگز دوباره نمایش داده نمی‌شود. برای تغییر، کلید جدید را وارد کنید تا جایگزین کلید قبلی شود. بدون کلید، این درگاه قابل فعال‌سازی نیست.',
  'web.payment_gateway_credential_telegram_hint':
    'این درگاه کلید «Custom Telegram» جداگانه‌ای از تون پی می‌خواهد. کلید درگاه وبسایت اینجا کار نمی‌کند و نباید وارد شود.',
  'web.payment_gateway_credential_input': 'کلید API جدید',
  'web.payment_gateway_credential_saved': 'کلید API ذخیره شد.',
  'web.payment_gateway_nowpayments_hint':
    'مبلغ فاکتور به دلار و فقط از نرخ مرکزی ارز (USDT) محاسبه می‌شود؛ مشتری نوع ارز دیجیتال را در صفحهٔ NOWPayments انتخاب می‌کند. پرداخت فقط پس از وضعیت «finished» با استعلام مستقیم از NOWPayments تأیید می‌شود.',
  'web.payment_gateway_webhook_secret_missing': 'کلید IPN تنظیم نشده',
  'web.payment_gateway_webhook_secret_configured': 'کلید IPN تنظیم شده ••••••••',
  'web.payment_gateway_webhook_secret_input': 'کلید IPN جدید (رمز IPN)',
  'web.payment_gateway_webhook_secret_hint':
    'اعلان‌های NOWPayments فقط با این کلید امضا و بررسی می‌شوند. کلید ذخیره‌شده هرگز نمایش داده نمی‌شود؛ ابتدا کلید API را تنظیم کنید. بدون کلید IPN، این درگاه قابل فعال‌سازی نیست.',
  'web.payment_gateway_webhook_secret_save': 'ذخیرهٔ کلید IPN',
  'web.payment_gateway_webhook_secret_saved': 'کلید IPN ذخیره شد.',
  'web.payment_gateway_tetrapay_hint':
    'مبلغ‌ها در تتراپی به ریال ارسال می‌شود (تومان × 10). مشتری پس از پرداخت با لینک ربات برمی‌گردد و وضعیت را از خود پرداخت می‌بیند؛ بازگشت به‌تنهایی چیزی را تأیید نمی‌کند. پرداخت فقط پس از استعلام مستقیم با وضعیت «paid» و تطبیق شناسهٔ سفارش و مبلغ به ریال ثبت می‌شود. وب‌هوک اختیاری است و فقط استعلام را جلو می‌اندازد.',
  'web.payment_gateway_tetrapay_secret_optional': 'رمز وب‌هوک (اختیاری) تنظیم نشده',
  'web.payment_gateway_tetrapay_secret_input': 'رمز وب‌هوک جدید (whsec_ — اختیاری)',
  'web.payment_gateway_tetrapay_secret_hint':
    'رمز امضای وب‌هوک تتراپی که با «whsec_» شروع می‌شود. اگر وارد کنید، هر اعلان با امضای نامعتبر یا قدیمی (بیش از 5 دقیقه) نادیده گرفته می‌شود؛ اگر وارد نکنید، اعلان‌ها بدون احراز فقط استعلام را جلو می‌اندازند. رمز ذخیره‌شده هرگز نمایش داده نمی‌شود؛ ابتدا کلید API را تنظیم کنید.',
  'web.payment_gateway_tonpays_signature_off':
    'امضای وب‌هوک تون‌پیز فعال نیست؛ سکرت وب‌هوک را تنظیم کنید',
  'web.payment_gateway_tonpays_secret_set_at': 'آخرین تنظیم:',
  'web.payment_gateway_tonpays_secret_input': 'سکرت وب‌هوک تون‌پیز',
  'web.payment_gateway_tonpays_secret_hint':
    'اول سکرت جدید را اینجا ذخیره کنید، بعد در پنل تون‌پیز بچرخانید؛ دورهٔ هم‌پوشانی وجود ندارد. با ذخیرهٔ سکرت، هر اعلان بدون امضای معتبر (یا با زمان ارسال بیش از 5 دقیقه اختلاف) رد می‌شود؛ بدون سکرت، اعلان‌ها فقط استعلام را جلو می‌اندازند. سکرت ذخیره‌شده هرگز نمایش داده نمی‌شود.',
  'web.payment_gateway_tonpays_secret_save': 'ذخیرهٔ سکرت وب‌هوک',
  'web.payment_gateway_tetrapay_secret_save': 'ذخیرهٔ رمز وب‌هوک',
  'web.payment_gateway_tetrapay_secret_saved': 'رمز وب‌هوک ذخیره شد.',
  'web.payment_gateway_webhook_url': 'نشانی وب‌هوک (در پنل تتراپی وارد کنید)',
  'web.payment_gateway_webhook_url_hint':
    'این نشانی را در بخش وب‌هوک پنل تتراپی ثبت کنید. فقط استعلام را جلو می‌اندازد و هرگز به‌تنهایی پرداختی را تأیید نمی‌کند.',
  'web.payment_gateway_rialit_webhook_url': 'نشانی وب‌هوک (در پنل ریالیت وارد کنید)',
  'web.payment_gateway_rialit_webhook_url_hint':
    'این نشانی را در پنل ریالیت، تنظیمات ← «تنظیمات وب‌هوک» ثبت کنید و یک رویداد آزمایشی بفرستید. وب‌هوک ریالیت امضا ندارد: فقط استعلام وضعیت را جلو می‌اندازد و هرگز به‌تنهایی پرداختی را تأیید نمی‌کند.',
  'web.payment_gateway_rialit_hint':
    'مبلغ‌ها در ریالیت به تومان ارسال می‌شود (50٬000 تا 10٬000٬000 تومان، همراه با کارمزد درگاه همین‌جا). فقط یک طرف کارمزد بگیرد: اگر کارمزد این درگاه را در ربات تنظیم کرده‌اید، کارمزد پرداخت‌کننده را در پنل ریالیت (تنظیمات پذیرنده) صفر کنید، یا برعکس؛ اگر هر دو روشن باشد لینک به مشتری داده نمی‌شود. وقتی فقط ریالیت کارمزد می‌گیرد، مبلغ نهایی ریالیت به مشتری نشان داده می‌شود و به کیف پول فقط اصل مبلغ واریز می‌شود. اگر فهرست «IPهای مجاز» را پر کرده‌اید، IP این سرور را اضافه کنید. پرداخت فقط پس از استعلام مستقیم (GET /status) با وضعیت «paid» و تطبیق شناسهٔ سفارش و مبلغ ثبت می‌شود. لینک پرداخت 30 دقیقه باز است.',
  'web.payment_gateway_custom_hint':
    'درگاه کاستوم پروتکل خود نکساست: سرویس کوچکی به نام «پل» که شخص ثالث می‌نویسد، درخواست‌های نکسا را به یک سرویس پرداخت می‌رساند. یک رمز مشترک (دست‌کم 32 نویسه) همهٔ درخواست‌ها و پاسخ‌ها و اعلان‌ها را در هر دو جهت امضا می‌کند. فقط پاسخ امضاشدهٔ استعلام پل می‌تواند پرداختی را تأیید کند؛ اعلان پل هرگز به‌تنهایی چیزی واریز نمی‌کند. مبلغ همیشه به ریال فرستاده می‌شود. نشانی پل فقط وقتی درگاه خاموش است قابل تغییر است.',
  'web.payment_gateway_custom_configure': 'تنظیم پل (رمز و نشانی)',
  'web.payment_gateway_custom_secret_input': 'رمز مشترک پل (32 تا 512 نویسه)',
  'web.payment_gateway_custom_secret_too_short': 'رمز مشترک پل باید دست‌کم 32 نویسه باشد.',
  'web.payment_gateway_custom_endpoint_title': 'نشانی پل درگاه',
  'web.payment_gateway_custom_endpoint_hint':
    'نشانی پایهٔ پل، فقط با https و بدون پارامتر؛ مثلاً https://pay.example.com/nexa. هر پرداخت به همان پلی پرسیده می‌شود که با آن ساخته شده است.',
  'web.payment_gateway_custom_base_url': 'نشانی پایهٔ پل (https)',
  'web.payment_gateway_custom_allowlist': 'نشانی‌های مجاز اعلان پل (اختیاری)',
  'web.payment_gateway_custom_allowlist_hint':
    'هر خط یک نشانی IP یا محدودهٔ CIDR (حداکثر 32 مورد). خالی یعنی بدون بررسی نشانی؛ امضای اعلان همیشه بررسی می‌شود.',
  'web.payment_gateway_custom_endpoint_save': 'ذخیرهٔ نشانی پل',
  'web.payment_gateway_custom_endpoint_saved': 'نشانی پل ذخیره شد.',
  'web.payment_gateway_custom_endpoint_active':
    'برای تغییر نشانی پل، اول درگاه را خاموش کنید؛ سپس نشانی را تغییر دهید، اتصال را آزمایش کنید و دوباره روشن کنید.',
  'web.payment_gateway_custom_endpoint_invalid':
    'نشانی پل باید با https:// شروع شود و پارامتر یا # نداشته باشد.',
  'web.payment_gateway_custom_allowlist_invalid':
    'هر خط فهرست مجاز باید یک نشانی IP یا محدودهٔ CIDR باشد.',
  'web.payment_gateway_custom_endpoint_missing': 'نشانی پل ثبت نشده',
  'web.payment_gateway_custom_endpoint_set': 'نشانی پل',
  'web.payment_gateway_custom_allowlist_count': 'نشانی‌های مجاز اعلان',
  'web.payment_gateway_custom_allowlist_none': 'بدون بررسی نشانی',
  'web.payment_gateway_test_connection': 'تست اتصال',
  'web.payment_gateway_enable_refused_endpoint_missing':
    'این درگاه بدون نشانی پل روشن نمی‌شود. ابتدا نشانی پل را ثبت کنید.',
  'web.payment_gateway_endpoint_refused_active':
    'نشانی پل فقط وقتی درگاه خاموش است قابل تغییر است. ابتدا درگاه را خاموش کنید.',
  'web.payment_gateway_endpoint_refused_open_attempts':
    'تا وقتی پرداختی که روی پل فعلی ساخته شده باز است، نشانی پل قابل تغییر نیست. صبر کنید تا آن پرداخت‌ها نتیجه بگیرند (یا موارد در انتظار بررسی را تطبیق دهید)، سپس نشانی را تغییر دهید.',
  'web.payment_gateway_endpoint_refused_url':
    'نشانی پل پذیرفته نشد: باید با https:// شروع شود و نام کاربری، پارامتر یا # نداشته باشد.',
  'web.payment_gateway_endpoint_refused_address':
    'این نصب به این نشانی درخواست نمی‌فرستد (نشانی محلی، داخلی یا شبکهٔ خود نکسا).',
  'web.payment_gateway_endpoint_refused_allowlist':
    'فهرست نشانی‌های مجاز پذیرفته نشد: هر خط یک IP یا CIDR، حداکثر 32 مورد.',
  'web.payment_gateway_bot_username': 'نام کاربری ربات برای لینک بازگشت',
  'web.payment_gateway_bot_username_none': 'ربات فعالی با نام کاربری ثبت‌شده وجود ندارد',
  'web.payment_gateway_hidden_until': 'پنهان‌شده تا (سقف روزانهٔ درگاه)',
  'web.payment_gateway_provider_payment_id': 'شناسهٔ پرداخت در درگاه',
  'web.payment_gateway_centralpay_hint':
    'مبلغ به تومان و دقیقاً برابر مبلغ قابل پرداخت ارسال می‌شود. بازگشت مشتری از صفحهٔ پرداخت به‌تنهایی چیزی را تأیید نمی‌کند؛ پرداخت فقط پس از استعلام مستقیم با کلید تأیید و تطبیق مبلغ، کاربر و شمارهٔ مرجع ثبت می‌شود. این درگاه سرویس سالم‌سنجی ندارد.',
  'web.payment_gateway_verify_key_missing': 'کلید تأیید تنظیم نشده',
  'web.payment_gateway_verify_key_configured': 'کلید تأیید تنظیم شده ••••••••',
  'web.payment_gateway_verify_key_input': 'کلید تأیید جدید',
  'web.payment_gateway_verify_key_hint':
    'کلید جداگانه‌ای که CentralPay برای استعلام پرداخت داده است (غیر از کلید ساخت لینک). کلید ذخیره‌شده هرگز نمایش داده نمی‌شود؛ ابتدا کلید API را تنظیم کنید. بدون کلید تأیید، این درگاه قابل فعال‌سازی نیست.',
  'web.payment_gateway_verify_key_saved': 'کلید تأیید ذخیره شد.',
  'web.payment_gateway_provider_user_id': 'شناسهٔ کاربر در درگاه',
  'web.payment_gateway_check': 'بررسی اتصال',
  'web.payment_gateway_check_done': 'بررسی اتصال انجام شد.',
  'web.payment_gateway_last_check': 'آخرین بررسی',
  'web.payment_gateway_check_ok': 'اتصال موفق',
  'web.payment_gateway_check_failed': 'اتصال ناموفق',
  'web.payment_gateway_callback_url': 'آدرس وب‌هوک (تولیدشده)',
  'web.payment_gateway_callback_url_hint':
    'این آدرس به‌صورت خودکار ساخته می‌شود و همراه هر فاکتور برای درگاه ارسال می‌شود. وب‌هوک فقط یک اعلان است؛ تأیید پرداخت همیشه با استعلام مستقیم از درگاه انجام می‌شود.',
} as const;
