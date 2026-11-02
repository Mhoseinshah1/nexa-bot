/**
 * Phase 4 PR-1 — a Telegram Business handoff reason (`BUSINESS_HANDOFF_REASONS`) in Persian, for
 * the operations log's handoff-rate alert («نرخ ارجاع به پشتیبان بالا است»), which names the top
 * three reasons. Keyed by the reason code; a code with no entry is printed as itself.
 */
export const SUPPORT_HANDOFF_REASON_LABELS_FA: Readonly<Record<string, string>> = {
  SEND_OUTCOME_UNKNOWN: 'نتیجهٔ یک ارسال نامشخص ماند',
  TRANSPORT_REFUSED: 'تلگرام یک ارسال را رد کرد',
  AI_REQUESTED: 'هوش مصنوعی خودش پاسخ را به پشتیبان سپرد',
  HANDOFF_TOPIC: 'موضوعی که همیشه پشتیبان پاسخ می‌دهد',
  HUMAN_REQUESTED: 'مشتری پشتیبان انسانی خواست',
  TOPIC_NOT_ALLOWED: 'موضوع در فهرست پاسخ خودکار نیست',
  LOW_CONFIDENCE: 'اطمینان هوش مصنوعی کافی نبود',
  REPLY_OUT_OF_BOUNDS: 'متن پاسخ خالی یا بیش از حد بلند بود',
  DECISION_NOT_REPLY: 'هوش مصنوعی پاسخ مستقیمی نداشت',
  AI_OUTPUT_INVALID: 'خروجی هوش مصنوعی معتبر نبود',
  AI_UNAVAILABLE: 'هوش مصنوعی در دسترس نبود',
  ACCOUNT_UNDER_REVIEW: 'پرداخت در حال بررسی یا سرویس ناهماهنگ',
  IDENTITY_UNVERIFIED: 'مشتری به حسابی در ربات متصل نیست',
  CUSTOMER_BLOCKED: 'حساب مشتری مسدود است',
  INSUFFICIENT_GROUNDING: 'استناد به اطلاعاتی که در دست نبود',
  LOOP_GUARD: 'سقف پاسخ‌های خودکار',
  UNSUPPORTED_CONTENT: 'پیامی که هوش مصنوعی نمی‌تواند بخواند',
  REPLY_STALE: 'پاسخ خودکار دیر آماده شد',
  CLARIFYING_LIMIT: 'سقف سؤال‌های تکمیلی پیاپی',
  NO_PROGRESS: 'راهنمایی هوش مصنوعی جواب نداد',
  REPEATED_ADVICE: 'تکرار راهنمایی قبلی',
  INBOUND_FLOOD: 'پیام‌های تکراری یا پشت‌سرهم مشتری',
  OUTPUT_POLICY: 'پاسخ از بررسی خروجی رد شد',
  SUSPICIOUS_PROBING: 'درخواست‌های ردشدهٔ پیاپی',
  CUSTOMER_UNSATISFIED: 'مشتری گفت پاسخ مشکل را حل نکرد',
};
