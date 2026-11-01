import type { PaymentState } from '@nexa/contracts';

/**
 * Phase 4 PR-3 — a payment's state as the support AI tells the customer it (payment_status,
 * check-before-handoff) and as the handoff summary names it to the person. Facts only: no word
 * here promises an outcome. A payment NEXA marks «under review» is told as such whatever its
 * state (`SUPPORT_PAYMENT_UNDER_REVIEW_FA`).
 */
export const SUPPORT_PAYMENT_STATE_LABELS_FA: Readonly<Record<PaymentState, string>> = {
  PENDING: 'در انتظار پرداخت یا تأیید درگاه',
  CONFIRMED: 'تأیید شده',
  FAILED: 'ناموفق',
  CANCELLED: 'لغو شده',
  EXPIRED: 'منقضی شده',
  UNKNOWN: 'در حال بررسی',
};

export const SUPPORT_PAYMENT_UNDER_REVIEW_FA = 'در حال بررسی';
