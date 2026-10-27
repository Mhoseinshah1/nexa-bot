import type { CustomerNotificationKind } from '@nexa/contracts';

/**
 * Persian names of the customer notification kinds, for the operations group (Round 5A item 1:
 * a failed send names WHAT could not be sent, not only that something could not).
 *
 * The same words the Web Admin's notification list uses (`web.pay_notice_*`), so a kind is
 * called one thing on every surface. Typed over the closed set, so a kind added to the
 * contract without a name here fails the build, not an operator at 3 a.m.
 */
export const CUSTOMER_NOTIFICATION_KIND_NAMES_FA: Readonly<
  Record<CustomerNotificationKind, string>
> = {
  PAYMENT_REJECTED: 'رد پرداخت',
  PAYMENT_EXPIRED: 'پایان مهلت پرداخت',
  ORDER_EXPIRED: 'پایان مهلت سفارش',
  SERVICE_ACTION_SUCCEEDED: 'انجام کار روی سرویس',
  SERVICE_ACTION_FAILED: 'انجام‌نشدن کار روی سرویس',
  SERVICE_PROVISION_DELAYED: 'تأخیر در ساخت سرویس',
  PAYMENT_TRANSFER_RECORDED: 'ثبت اعلام واریز',
  ORDER_CANCELLED: 'لغو سفارش',
  WALLET_TOPUP_CREDITED: 'شارژ کیف پول',
  ORDER_REFUNDED_TO_WALLET: 'بازگشت مبلغ سفارش به کیف پول',
  SERVICE_EXPIRY_FIRST: 'یادآوری اول پایان سرویس',
  SERVICE_EXPIRY_SECOND: 'یادآوری دوم پایان سرویس',
  SERVICE_EXPIRED: 'پایان سرویس',
  SERVICE_USAGE_FIRST: 'هشدار اول مصرف حجم',
  SERVICE_USAGE_SECOND: 'هشدار دوم مصرف حجم',
  SERVICE_USAGE_FINAL: 'هشدار پایان حجم',
  TRIAL_NOT_DELIVERED: 'تحویل‌نشدن سرویس تست',
  RECEIPT_CREDITED_TO_WALLET: 'واریز رسید به کیف پول',
  WALLET_TOPUP_GIFT_CREDITED: 'هدیهٔ شارژ کیف پول',
  GATEWAY_LATE_PAYMENT_CREDITED: 'واریز پرداخت دیرهنگام به کیف پول',
  REFUND_COMPLETED: 'انجام بازگشت وجه',
  GATEWAY_PAYMENT_FAILED: 'ناموفق‌بودن پرداخت درگاه',
  SERVICE_REFUND_REQUEST_REGISTERED: 'ثبت درخواست بازگشت وجه سرویس',
  SERVICE_REFUND_REQUEST_APPROVED: 'تأیید درخواست بازگشت وجه سرویس',
  SERVICE_REFUND_REQUEST_REJECTED: 'رد درخواست بازگشت وجه سرویس',
  SERVICE_TRANSFER_RECEIVED: 'دریافت سرویس انتقالی',
  TICKET_REPLY: 'پاسخ تیکت',
  SERVICE_EXPIRY_EARLY: 'یادآوری زودهنگام پایان سرویس',
  SERVICE_EXPIRY_DAY: 'یادآوری روز پایان سرویس',
  WALLET_LOW_BALANCE: 'کم‌بودن موجودی کیف پول',
  PAYMENT_PENDING_REMINDER: 'یادآوری پرداخت در انتظار',
  ORDER_PENDING_REMINDER: 'یادآوری سفارش در انتظار',
  TICKET_REPLY_ATTACHMENT: 'پیوست پاسخ تیکت',
  SERVICE_RENEWED: 'تمدید سرویس',
  RESELLER_MINIMUM_REMINDER: 'یادآوری حداقل فروش نماینده',
  RESELLER_MINIMUM_ACHIEVED: 'رسیدن به حداقل فروش نماینده',
  WALLET_MASS_CREDITED: 'واریز گروهی به کیف پول',
  SERVICE_GIFT_APPLIED: 'اعمال هدیهٔ سرویس',
  DIRECT_MESSAGE: 'پیام مستقیم',
  DIRECT_MESSAGE_MEDIA: 'پیام مستقیم با رسانه',
  INCIDENT_NOTICE: 'اطلاعیهٔ رخداد',
  WALLET_ADMIN_CREDITED: 'افزایش دستی موجودی',
  WALLET_ADMIN_DEBITED: 'کسر دستی موجودی',
  ACCOUNT_UNBLOCKED: 'رفع مسدودی حساب',
  SERVICE_TRAFFIC_ADDED: 'خرید حجم اضافه',
  SERVICE_TIME_ADDED: 'خرید زمان اضافه',
  SERVICE_AUTO_RENEW_FUNDS_SHORT: 'کمبود موجودی برای تمدید خودکار',
  SERVICE_AUTO_RENEW_PRICE_CHANGED: 'تغییر مبلغ تمدید خودکار',
};
