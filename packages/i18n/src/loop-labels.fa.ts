/**
 * Persian names of the background loops a process role watches, and of the roles themselves,
 * for the `job.loop_stalled` / `job.loop_recovered` messages in the operations group.
 *
 * Keyed by the loop name the watchdog reports (`main.worker.ts`'s list, the other roles'
 * loop constants and the provisioner's lanes). `tests/unit/loop-stall-labels.test.ts` reads
 * those lists from the sources and fails when one has no label here, so a loop added later
 * cannot reach the group under its English key.
 */
export const LOOP_LABELS_FA: Readonly<Record<string, string>> = {
  // The worker.
  relay: 'انتشار رویدادها',
  'throttle-sweeper': 'پاک‌سازی محدودیت‌های ورود',
  'session-sweeper': 'پاک‌سازی نشست‌ها',
  'backup-run-sweeper': 'پاک‌سازی سابقهٔ بکاپ‌ها',
  'recovery-request-sweeper': 'پاک‌سازی درخواست‌های بازیابی',
  'outbox-retention-sweeper': 'پاک‌سازی صف رویدادها',
  'legacy-compaction-executor': 'فشرده‌سازی داده‌های قدیمی',
  'idempotency-retention-sweeper': 'پاک‌سازی کلیدهای جلوگیری از تکرار',
  'ticket-reply-file-sweeper': 'پاک‌سازی فایل‌های پاسخ پشتیبانی',
  'direct-message-file-sweeper': 'پاک‌سازی فایل‌های پیام مستقیم',
  'payment-expiry': 'انقضای پرداخت‌ها',
  'gateway-payments': 'پرداخت‌های درگاهی',
  'fx-refresh': 'به‌روزرسانی نرخ ارز',
  'service-reminders': 'یادآوری به مشتریان سرویس‌دار',
  'nightly-reports': 'گزارش‌های شبانه',
  'data-compaction': 'فشرده‌سازی داده‌ها',
  'customer-reminders': 'یادآوری پرداخت و موجودی کیف پول',
  'campaign-schedule': 'زمان‌بندی کمپین‌ها',
  'telegram-message-retention': 'پاک‌سازی پیام‌های تلگرام',
  'gift-card-sweep': 'پاک‌سازی فایل‌های کارت هدیه',
  'bot-command-sync': 'همگام‌سازی دستورهای ربات',
  'customer-notifications': 'پیام‌های خودکار مشتری',
  'business-outbound': 'ارسال پیام‌های تلگرام بیزنس',
  'support-assistant-watch': 'پایش دستیار پشتیبانی',
  'support-knowledge-refresh': 'به‌روزرسانی خودکار دانش پشتیبان',
  broadcasts: 'ارسال همگانی',
  'incident-scheduler': 'زمان‌بندی دورهٔ نگهداری',
  'bulk-operations': 'عملیات گروهی',
  'receipt-review-push': 'اعلان رسیدهای در انتظار بررسی',
  'ops-group': 'گروه گزارش عملیات',
  'notification-dispatcher': 'ارسال اعلان‌ها',
  'backup-scheduler': 'زمان‌بند بکاپ',
  'backup-housekeeping': 'نگهداری بکاپ‌ها',
  // The monitor, the recovery executor, the migration executor.
  'panel-monitor': 'پایش پنل‌ها',
  'recovery-executor': 'اجرای بازیابی',
  'migration-executor': 'اجرای انتقال داده‌های قدیمی',
  // The provisioner's lanes.
  provisioner: 'ساخت سرویس‌ها',
  'provisioner-cashback': 'اعطای کش‌بک',
  'provisioner-referrals': 'پاداش دعوت دوستان',
  'provisioner-service-refunds': 'بازگشت وجه سرویس‌ها',
};

/** The process roles by their `processRole` value. The assistant reports through the worker. */
export const PROCESS_ROLE_LABELS_FA: Readonly<Record<string, string>> = {
  // R11 A3: the API reports no loops, but a restart storm names it like any other role.
  api: 'سرور وب و وب‌هوک تلگرام',
  worker: 'کارگر پس‌زمینه',
  monitor: 'پایشگر پنل‌ها',
  recovery: 'بازیابی',
  provisioner: 'سازندهٔ سرویس',
  migration: 'انتقال داده',
  assistant: 'دستیار پشتیبانی',
};

/** What the line naming the role is called. */
export const PROCESS_ROLE_LINE_LABEL_FA = 'فرایند';

/** A loop no table knows (a later release's): still Persian, the key is the technical line. */
export const UNKNOWN_LOOP_LABEL_FA = 'کار پس‌زمینهٔ ناشناخته';
/** A role no table knows. */
export const UNKNOWN_PROCESS_ROLE_LABEL_FA = 'فرایند ناشناخته';

/** The loop's Persian name, or null when it has none. */
export function loopLabelFa(loop: string): string | null {
  return Object.hasOwn(LOOP_LABELS_FA, loop) ? (LOOP_LABELS_FA[loop] as string) : null;
}

/** The role's Persian name, or null when it has none. */
export function processRoleLabelFa(role: string): string | null {
  return Object.hasOwn(PROCESS_ROLE_LABELS_FA, role)
    ? (PROCESS_ROLE_LABELS_FA[role] as string)
    : null;
}
