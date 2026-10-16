/**
 * Working catalogue fragment for agent C — money & catalogue.
 *
 * TEMPORARY. While the web-admin demo is implemented by several agents in parallel, each
 * agent adds its NEW `web.*` keys here instead of appending to `web.fa.ts` (which every
 * agent would append to at the same line). A key here whose name already exists in
 * `web.fa.ts` OVERRIDES that key's text (the fragment is spread last). The lead folds every
 * fragment into `web.fa.ts` and deletes this file before the branch is pushed.
 */
export const WEB_FA_MONEY = {
  // The dismiss button of every dialog and drawer this agent's pages open.
  'web.money_cancel': 'انصراف',
  // W1.4 — the payments list's suggested saved filters (the approved demo's presets).
  'web.payments_view_needs_action': 'نیاز به اقدام',
  'web.payments_view_manual_pending': 'کارت‌به‌کارت در انتظار',
  'web.payments_view_unknown': 'نتیجهٔ نامعلوم',
  // W3 — the refund answers are row buttons; this is their column.
  'web.refund_answer_column': 'اقدام',
  // W5 — payment evidence, history and provider words in Persian (raw key in `title`).
  'web.pay_evidence_operator_review': 'بررسی مدیر',
  'web.pay_evidence_wallet_debit': 'برداشت از کیف پول',
  'web.pay_evidence_gateway_callback': 'پیام تأییدشدهٔ درگاه',
  'web.pay_evidence_reconciliation': 'تطبیق با پاسخ درگاه',
  'web.pay_evidence_gateway_inquiry': 'استعلام از درگاه',
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
  'web.pay_provider_pending': 'در انتظار',
  'web.pay_provider_processing': 'در حال پردازش',
  'web.pay_provider_completed': 'تکمیل‌شده',
  'web.pay_provider_need_action': 'نیازمند اقدام',
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
  // W2 — a tab's marker, said to assistive technology.
  'web.money_tab_unsaved': 'تغییر ذخیره‌نشده',
  'web.money_tab_problem': 'نیاز به اصلاح',
  // W1.5 — the product page's action group.
  'web.product_actions_catalogue': 'دسته و وضعیت',
  // W5 — «صافی» → «فیلتر»: new keys (a fragment cannot override an existing key's text).
  'web.discounts_filter_none': 'قاعده‌ای با این فیلتر پیدا نشد.',
  'web.resellers_filter_empty': 'موردی با این فیلتر پیدا نشد.',
  // W5 — the plans page's pricing note, without «… وجود ندارد».
  'web.reseller_plans_pricing_note':
    'قیمت نماینده همان قیمت محصول است با نرخ سطح یا نرخ اختصاصی نماینده؛ هنگام خرید محاسبه و در سفارش ثبت می‌شود.',
} as const;

/**
 * Keys of `web.fa.ts` this agent's work no longer renders. Listing a key here keeps
 * `check:i18n` quiet until the lead deletes it from `web.fa.ts` when folding.
 */
export const WEB_FA_MONEY_RETIRED: readonly string[] = [
  // The refund answer's select and section heading (W3: row buttons open the dialog).
  'web.refund_answer_title',
  'web.refund_answer_none',
  // The bulk operation's steering card (W3: its buttons are in the page head).
  'web.cb_steering',
  // W5: the products page's «آنچه در این نسخه نیست» card (removed by the owner's polish list).
  'web.products_scope_title',
  'web.products_scope_body',
  'web.products_panel_rule',
  // W1.5: the product status card became a button in the action panel.
  'web.product_status_title',
  // W5: replaced by `web.discounts_filter_none` («فیلتر», not «صافی»).
  'web.discounts_filter_empty',
  // W5: replaced by `web.reseller_plans_pricing_note` (no «وجود ندارد» meta sentence).
  'web.reseller_plans_pricing_rule',
];
