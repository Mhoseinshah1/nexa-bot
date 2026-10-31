/**
 * Persian sentences for the operational events whose recorded `message` is an English log line.
 * Keyed by event CODE (the code is schema; this is only how it reads). Shown in the operations
 * group's technical line and the notification centre in place of the English text; each stays
 * under the 120 characters the group prints. `tests/unit/ops-message-persian.test.ts` pins them.
 */
export const OPERATIONAL_EVENT_MESSAGES_FA: Readonly<Record<string, string>> = {
  'antispam.customer_blocked': 'ضدهرزنامه مشتری را به‌خاطر ارسال پیاپی پیام موقتاً مسدود کرد.',
  'antispam.unavailable': 'ضدهرزنامه نتوانست تعامل‌ها را بشمارد؛ فعلاً کسی مسدود نمی‌شود.',
  'antispam.recovered': 'ضدهرزنامه دوباره تعامل‌ها را می‌شمارد.',
  'telegram.appearance_decoration_ok':
    'پیام آزمایشی با ایموجی سفارشی دوباره از این ربات پذیرفته شد.',
  'bot_menu.published_readable': 'چیدمان منوی اصلی منتشرشده دوباره خوانده می‌شود.',
  'bot_menu.published_unreadable':
    'چیدمان منتشرشدهٔ منوی اصلی در این نسخه خوانده نمی‌شود؛ کیبورد از تنظیم قبلی پیروی می‌کند.',
  'support.business_connection.unusable':
    'یک اتصال تلگرام بیزنس غیرقابل استفاده است و از آن پیامی فرستاده نمی‌شود.',
  'support.business_connection.usable': 'اتصال تلگرام بیزنس دوباره می‌تواند پیام بفرستد.',
  'support.handoff_required':
    'یک گفتگوی تلگرام بیزنس به اپراتور سپرده شد؛ هوش مصنوعی تا تحویل مجدد پاسخ نمی‌دهد.',
  'support.handoff_resolved':
    'گفتگوی سپرده‌شدهٔ تلگرام بیزنس را اپراتور گرفت یا به هوش مصنوعی برگشت.',
  'support.business_update_failed': 'یک به‌روزرسانی تلگرام بیزنس پردازش نشد.',
  'panel.capacity.full': 'ظرفیت پنل پر شد و فروش تازه روی آن رد می‌شود.',
  'panel.capacity.recovered': 'وضعیت ظرفیت پنل دوباره عادی شد.',
  'panel.capacity.warning': 'ظرفیت پنل رو به پر شدن است.',
  'channels.membership_unavailable':
    'ربات نتوانست عضویت در کانال اجباری را بررسی کند؛ فعلاً اجرا نمی‌شود.',
  'channels.membership_recovered': 'ربات دوباره عضویت همهٔ کانال‌های اجباری را بررسی می‌کند.',
  'bot.command_sync_failing':
    'ثبت منوی دستورهای تلگرام بارها ناموفق بود؛ با فاصله‌ی افزایشی دوباره تلاش می‌شود.',
  'bot.command_sync_recovered': 'منوی دستورهای تلگرام پس از شکست‌های قبلی ثبت شد.',
  'customer_notices.paused': 'پیام‌های خودکار مشتری با کلید اضطراری متوقف شد.',
  'customer_notices.resumed': 'پیام‌های خودکار مشتری دوباره ارسال می‌شود.',
  'fx.fallback_in_use': 'منبع اصلی نرخ، جفت‌ارز را قیمت‌گذاری نکرد و منبع پشتیبان جای آن را گرفت.',
  'fx.quote_rejected': 'یک منبع نرخ عددی داد که این نصب نپذیرفت.',
  'fx.quote_unavailable':
    'نرخ قابل‌استفاده‌ای نیست: همهٔ منبع‌ها ناموفق‌اند و آخرین نرخ سالم هم کهنه است.',
  'fx.single_source': 'فقط یک منبع نرخ سالم است.',
  'fx.source_unavailable': 'یک منبع نرخ پاسخ قابل‌استفاده نداد.',
  'fx.stale_quote_used': 'فاکتور تازه با آخرین نرخ سالم قیمت‌گذاری شد، چون منبعی پاسخ نداده است.',
  'payments.gateway_card_change_unknown':
    'پاسخ درگاه به تغییر کارت گم شد؛ کارت قبلی دیگر نمایش داده نمی‌شود.',
  'payments.gateway_configured': 'درگاه پرداخت دوباره فاکتورهای این نصب را می‌پذیرد.',
  'payments.gateway_identity_mismatch':
    'پاسخ درگاه به فاکتور یا سفارشی اشاره کرد که به این تلاش تعلق ندارد؛ چیزی تسویه نشد.',
  'payments.gateway_inquiry_failing':
    'درگاه پرداخت به استعلام‌ها پاسخ نمی‌دهد و تأییدها خوانده نمی‌شود.',
  'payments.gateway_inquiry_ok': 'درگاه پرداخت دوباره به استعلام‌ها پاسخ می‌دهد.',
  'payments.gateway_late_completion':
    'درگاه پرداختی را گزارش کرد که دیگر قابل تسویه نیست؛ بررسی دستی لازم است.',
  'payments.gateway_misconfigured':
    'درگاه پرداخت پیکربندی این نصب را نپذیرفت و روش پرداخت برای مشتری در دسترس نیست.',
  'payments.gateway_receipt_unknown': 'پاسخ درگاه به بارگذاری رسید گم شد؛ دوباره بارگذاری نمی‌شود.',
  'payments.gateway_request_unknown':
    'پاسخ درگاه به درخواست لغو یا بازگشت وجه مشتری گم شد؛ دوباره ارسال نمی‌شود.',
  'payments.gateway_review_reconciled': 'اپراتور پرداخت درگاهی با نتیجهٔ نامعلوم را تطبیق داد.',
  'payments.gateway_review_unresolved':
    'بررسی درگاه به نتیجهٔ قطعی نرسید؛ چیزی تسویه نشد و بررسی دستی لازم است.',
  'payments.gateway_row_failing':
    'یک ردیف پرداخت درگاهی در کارگر بارها ناموفق است و با فاصله‌ی افزایشی دوباره تلاش می‌شود.',
  'payments.gateway_row_recovered': 'ردیف پرداخت درگاهی دوباره پردازش می‌شود.',
  'payments.gateway_settlement_decided': 'پرداخت تأییدشدهٔ درگاه تعیین تکلیف شد.',
  'payments.gateway_settlement_failed':
    'پرداخت تأییدشدهٔ درگاه تسویه نشد؛ چیزی اعتبار داده نشد و دوباره بررسی می‌شود.',
  'payments.gateway_charge_unmatched':
    'پرداخت تلگرام (ستاره) به هیچ تلاشی وصل نشد؛ چیزی تسویه نشد.',
  'payments.gateway_charge_refunded':
    'تلگرام یک پرداخت ستاره را بازپرداخت کرد؛ پرداخت علامت خورد، سرویس و کیف پول تغییر نکرد و مدیر باید تصمیم بگیرد.',
  'internal.unhandled': 'یک درخواست API با خطای داخلی ناموفق شد.',
  'settings.stored_value_invalid':
    'مقدار ذخیره‌شدهٔ یک تنظیم با تعریفش نمی‌خواند؛ مقدار پیش‌فرض اعمال است.',
  'settings.stored_value_valid': 'مقدار ذخیره‌شدهٔ تنظیم دوباره معتبر شد.',
  'job.loop_stalled': 'یک حلقهٔ پس‌زمینه پیشرفت نمی‌کند.',
  'job.loop_recovered': 'حلقهٔ پس‌زمینه دوباره پیشرفت می‌کند.',
  'process.restart_storm': 'یکی از سرویس‌های ربات پی‌درپی کرش می‌کند و دوباره بالا می‌آید.',
  'process.restart_storm_ended': 'سرویس دوباره پایدار شد و دیگر ری‌استارت نمی‌شود.',
  'order.refunded_undeliverable': 'سفارش قابل تحویل نبود و مبلغ آن به کیف پول برگشت.',
  'outbox.message_exhausted': 'یک پیام صف خروجی بارها ناموفق ماند و دیگر خودکار تکرار نمی‌شود.',
  'panel.probe.limited':
    'آزمایش اتصال پنل‌ها رد می‌شود: ظرفیت بررسی خروجی این مستأجر تمام شده است.',
  'panel.probe.ok': 'آزمایش اتصال پنل‌ها دوباره پذیرفته می‌شود.',
  'provisioning.delivered':
    'سرویس روی پنل ساخته شد یا پس از نتیجهٔ نامعلوم روی پنل پیدا و پذیرفته شد.',
  'provisioning.stalled':
    'ساخت یا تغییر سرویس پرداخت‌شده روی پنل انجام نشد یا نتیجهٔ آن معلوم نیست.',
  'payments.receipt_push_failed': 'رسید به مدیر در تلگرام فرستاده نشد؛ هنوز در صف بررسی است.',
  'payments.receipt_push_ok': 'رسیدها دوباره به این مدیر در تلگرام می‌رسد.',
  'panel.health.recovered': 'پنل دوباره به بررسی سلامت پاسخ می‌دهد.',
  'panel.health.restored': 'پنل به حالت سالم برگشت.',
  'panel.health.retired': 'پنل بایگانی شد و دیگر پایش نمی‌شود.',
  'payments.refund_request_push_failed':
    'درخواست بازگشت وجه به مدیر در تلگرام فرستاده نشد؛ هنوز باز است.',
  'payments.refund_request_push_ok': 'درخواست‌های بازگشت وجه دوباره به این مدیر در تلگرام می‌رسد.',
  'notification.reminder_burst': 'در یک ساعت یادآور خودکار بیش از حد معمول ساخته شد.',
  'notification.reminder_burst_cleared': 'تعداد یادآورهای خودکار دوباره زیر آستانه است.',
  'telegram.rich_message_refused':
    'تلگرام صفحه‌ای را که پیام غنی فرستاده شده بود نپذیرفت؛ به روش عادی دوباره ارسال شد.',
  'panel.monitor.scheduler_capacity_exceeded':
    'تعداد پنل‌های فعال از ظرفیت زمان‌بند پایش بیشتر است.',
  'panel.monitor.scheduler_capacity_ok': 'تعداد پنل‌های فعال دوباره در ظرفیت زمان‌بند پایش است.',
  'panel.monitor.tenant_budget_exceeded':
    'تعداد پنل‌های فعال از بودجهٔ بررسی این مستأجر بیشتر است.',
  'panel.monitor.tenant_budget_ok': 'تعداد پنل‌های فعال دوباره در بودجهٔ بررسی است.',
  'service.panel_account_found': 'پنل دوباره حساب این سرویس را دارد.',
  'service.panel_account_missing':
    'پنل دوباره گفت حساب این سرویس وجود ندارد؛ سرویس بدون تغییر ماند.',
  'support.ai_provider.available': 'یک ارائه‌دهندهٔ هوش مصنوعی پیکربندی‌شده دوباره پاسخ داد.',
  'support.ai_provider.credential_accepted':
    'یک ارائه‌دهندهٔ هوش مصنوعی کلید خود را دوباره پذیرفت.',
  'support.ai_provider.credential_rejected': 'یک ارائه‌دهندهٔ هوش مصنوعی کلید را نپذیرفت.',
  'support.ai_provider.unavailable':
    'هیچ ارائه‌دهندهٔ هوش مصنوعی پاسخ نداد؛ گفتگوهای پشتیبانی تا برگشت به اپراتور سپرده می‌شوند.',
  'support.assistant.running': 'دستیار پشتیبانی دوباره کار می‌کند.',
  'support.assistant.stalled':
    'دستیار پشتیبانی کار نمی‌کند و پیش‌نویس‌ها و پاسخ‌های خودکار بی‌صاحب مانده‌اند.',
  'telegram.message_retention_failing':
    'پاکسازی وضعیت پیام‌های تلگرام بارها ناموفق است و دو جدول آن بزرگ می‌شوند.',
  'telegram.message_retention_recovered': 'پاکسازی وضعیت پیام‌های تلگرام دوباره کامل شد.',
  'bot.token_replacement_completed': 'توکن و وب‌هوک تلگرام ربات با تلگرام بررسی و ذخیره شد.',
  'bot.token_replacement_incomplete': 'جایگزینی توکن ربات کامل نشد؛ وضعیت وب‌هوک را بررسی کنید.',
  'ops_group.topic_recreated': 'یک موضوع گروه گزارش که حذف شده بود دوباره ساخته شد.',
  'telegram.ops_group_update_failed': 'یک به‌روزرسانی تلگرام برای گروه گزارش پردازش نشد.',
  'telegram.turn_failed': 'یک به‌روزرسانی تلگرام پردازش نشد.',
  'notification.sweep_withdrawn':
    'حکم «ارسال ناموفق» پس گرفته شد؛ ادعاهای شمرده‌شده هرگز به انتقال نرسیده بودند.',
  'access.permission_denied': 'درخواست بدون دسترسی رد شد.',
  'auth.login_locked_out': 'ورود به‌خاطر تلاش‌های ناموفق گذرواژه قفل شد.',
  'admin.second_factor_reset': 'ورود دومرحله‌ای یک مدیر بازنشانی شد.',
  'system.ping': 'پینگ سامانه دریافت شد.',
  'payments.gateway_create_unknown': 'پاسخ درگاه به ساخت فاکتور گم شد؛ دوباره ارسال نمی‌شود.',
  'payments.gateway_link_create_failed': 'ساخت لینک پرداخت در درگاه ناموفق بود.',
  'payments.gateway_webhook_unverified':
    'اعلان وب‌هوک درگاه با رمز ذخیره‌شده تأیید نشد و نادیده گرفته شد.',
  'payments.gateway_webhook_verified': 'اعلان وب‌هوک درگاه با رمز ذخیره‌شده تأیید شد.',
  'tonpays.webhook.signature_rejected': 'امضای وب‌هوک تن‌پیز رد شد؛ فقط استعلام تصمیم می‌گیرد.',
  'tonpays.webhook.signature_verified': 'امضای وب‌هوک تن‌پیز تأیید شد.',
  'telegram.appearance_decoration_failed':
    'تلگرام ایموجی سفارشی این ربات را نپذیرفت؛ پیام بدون آن فرستاده شد.',
};

export function operationalEventMessageFa(code: string): string | null {
  return OPERATIONAL_EVENT_MESSAGES_FA[code] ?? null;
}
