import type { LedgerReason, PaymentMethod, PaymentState } from '@nexa/contracts';
import type { MiniAppKey } from '../i18n/t.js';

/** Every ledger reason in the customer's words — exhaustive, so a new reason is a type error. */
export const LEDGER_REASON_KEY: Readonly<Record<LedgerReason, MiniAppKey>> = {
  TOPUP_GATEWAY: 'miniapp.wallet_reason_topup',
  TOPUP_RECEIPT: 'miniapp.wallet_reason_topup',
  TOPUP_STARS: 'miniapp.wallet_reason_topup',
  TOPUP_CRYPTO: 'miniapp.wallet_reason_topup',
  RECEIPT_CREDIT: 'miniapp.wallet_reason_receipt_credit',
  GATEWAY_LATE_CREDIT: 'miniapp.wallet_reason_late_credit',
  PURCHASE: 'miniapp.wallet_reason_purchase',
  PURCHASE_REVERSAL: 'miniapp.wallet_reason_purchase_reversal',
  REFUND: 'miniapp.wallet_reason_refund',
  CASHBACK_GATEWAY: 'miniapp.wallet_reason_cashback',
  CASHBACK_TOPUP: 'miniapp.wallet_reason_cashback_topup',
  CASHBACK_RENEWAL: 'miniapp.wallet_reason_cashback',
  CASHBACK_PURCHASE: 'miniapp.wallet_reason_cashback',
  CASHBACK_REVERSAL: 'miniapp.wallet_reason_cashback_reversal',
  REFERRAL_COMMISSION: 'miniapp.wallet_reason_referral',
  REFERRAL_COMMISSION_REVERSAL: 'miniapp.wallet_reason_referral_reversal',
  REFERRAL_SIGNUP_GIFT: 'miniapp.wallet_reason_signup_gift',
  START_GIFT: 'miniapp.wallet_reason_start_gift',
  LOTTERY_WIN: 'miniapp.wallet_reason_lottery',
  LUCK_WHEEL_WIN: 'miniapp.wallet_reason_wheel',
  ADMIN_CREDIT: 'miniapp.wallet_reason_admin_credit',
  ADMIN_DEBIT: 'miniapp.wallet_reason_admin_debit',
  MASS_CREDIT: 'miniapp.wallet_reason_admin_credit',
  MASS_DEBIT: 'miniapp.wallet_reason_admin_debit',
  ACCOUNT_TRANSFER_OUT: 'miniapp.wallet_reason_transfer_out',
  ACCOUNT_TRANSFER_IN: 'miniapp.wallet_reason_transfer_in',
  RESELLER_SETTLEMENT: 'miniapp.wallet_reason_reseller_settlement',
  RESELLER_MEMBERSHIP_FEE: 'miniapp.wallet_reason_reseller_fee',
  MIGRATION_OPENING_BALANCE: 'miniapp.wallet_reason_opening',
  CHARGEBACK: 'miniapp.wallet_reason_chargeback',
  CORRECTION: 'miniapp.wallet_reason_correction',
  OTHER: 'miniapp.wallet_reason_other',
};

export const PAYMENT_METHOD_KEY: Readonly<Record<PaymentMethod, MiniAppKey>> = {
  WALLET: 'miniapp.wallet_method_WALLET',
  MANUAL_TRANSFER: 'miniapp.wallet_method_MANUAL_TRANSFER',
  GATEWAY: 'miniapp.wallet_method_GATEWAY',
};

export const PAYMENT_STATE_KEY: Readonly<Record<PaymentState, MiniAppKey>> = {
  PENDING: 'miniapp.wallet_pstate_PENDING',
  CONFIRMED: 'miniapp.wallet_pstate_CONFIRMED',
  FAILED: 'miniapp.wallet_pstate_FAILED',
  CANCELLED: 'miniapp.wallet_pstate_CANCELLED',
  EXPIRED: 'miniapp.wallet_pstate_EXPIRED',
  UNKNOWN: 'miniapp.wallet_pstate_UNKNOWN',
};
