import type { LedgerReason } from '@nexa/contracts';

/**
 * R12 F3 item 7: what a wallet movement WAS, in the customer's words, for the bot's «📜
 * تراکنش‌ها» list. Typed over the closed set of ledger reasons, so a reason added to the
 * contract without a name here fails the build rather than printing a raw code to a customer.
 *
 * Deliberately short and neutral: the list shows the movement, not the operator's note, and an
 * administrative adjustment says only that the administrator moved it (the note is shown to the
 * customer only through the notification the operator chose to send).
 */
export const LEDGER_REASON_LABELS_FA: Readonly<Record<LedgerReason, string>> = {
  TOPUP_GATEWAY: 'شارژ با درگاه',
  TOPUP_RECEIPT: 'شارژ با کارت به کارت',
  TOPUP_STARS: 'شارژ با استارز',
  TOPUP_CRYPTO: 'شارژ با ارز دیجیتال',
  RECEIPT_CREDIT: 'واریز رسید به کیف پول',
  GATEWAY_LATE_CREDIT: 'واریز پرداخت دیرهنگام',
  PURCHASE: 'خرید',
  PURCHASE_REVERSAL: 'بازگشت خرید',
  REFUND: 'بازگشت وجه',
  CASHBACK_GATEWAY: 'هدیه شارژ',
  CASHBACK_TOPUP: 'هدیه شارژ',
  CASHBACK_RENEWAL: 'هدیه تمدید',
  CASHBACK_PURCHASE: 'هدیه خرید',
  CASHBACK_REVERSAL: 'بازگشت هدیه',
  REFERRAL_COMMISSION: 'پورسانت زیرمجموعه',
  REFERRAL_COMMISSION_REVERSAL: 'بازگشت پورسانت',
  REFERRAL_SIGNUP_GIFT: 'هدیه دعوت',
  GIFT_CARD_REDEMPTION: 'کارت هدیه',
  START_GIFT: 'هدیه شروع',
  LOTTERY_WIN: 'جایزه',
  LUCK_WHEEL_WIN: 'جایزه',
  ADMIN_CREDIT: 'افزایش توسط مدیر',
  ADMIN_DEBIT: 'کاهش توسط مدیر',
  MASS_CREDIT: 'افزایش توسط مدیر',
  MASS_DEBIT: 'کاهش توسط مدیر',
  ACCOUNT_TRANSFER_OUT: 'انتقال حساب',
  ACCOUNT_TRANSFER_IN: 'انتقال حساب',
  RESELLER_SETTLEMENT: 'تسویه نمایندگی',
  RESELLER_MEMBERSHIP_FEE: 'حق عضویت نمایندگی',
  MIGRATION_OPENING_BALANCE: 'موجودی اولیه',
  CHARGEBACK: 'بازگشت پرداخت',
  CORRECTION: 'اصلاح موجودی',
  OTHER: 'تراکنش دیگر',
};
