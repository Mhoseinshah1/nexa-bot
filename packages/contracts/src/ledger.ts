import { z } from 'zod';

/**
 * Wallet ledger vocabulary.
 *
 * The ledger is append-only. Amounts are always POSITIVE and direction is a
 * separate column; a reversal is a new entry referencing the original, never an
 * edit. Balance is derived and cached, never authoritative.
 *
 * Phase 0 ships the vocabulary only — no wallet, no entries, no balance. It is
 * here because it is a contract: adding a reason later is a contract change with
 * a visible diff, not a feature commit. The legacy system's unexplained 916,550
 * residual is what a mutable balance column with no reason vocabulary produces.
 */

export const LEDGER_DIRECTIONS = ['CREDIT', 'DEBIT'] as const;
export type LedgerDirection = (typeof LEDGER_DIRECTIONS)[number];

export const LEDGER_REASONS = [
  // Top-ups
  'TOPUP_GATEWAY',
  'TOPUP_RECEIPT',
  'TOPUP_STARS',
  'TOPUP_CRYPTO',
  // WP10 P1: a manual transfer that arrived after its payment expired, credited to the
  // wallet by a reviewer because the payment and its order stay closed. A CREDIT and never
  // a reversal: it reverses nothing, it is money that arrived by the only door still open.
  // Its own reason rather than `TOPUP_RECEIPT`, which is a top-up the customer asked for,
  // and rather than `ADMIN_CREDIT`, which has no payment behind it and nothing to bound
  // it. One per payment, by `wallet_entries_late_transfer_payment_key`.
  // `docs/wp10-payments-audit.md` P1.
  'LATE_TRANSFER',
  // Commerce
  'PURCHASE',
  'PURCHASE_REVERSAL',
  'REFUND',
  // Cashback — three distinct sources, never merged into one opaque bump
  'CASHBACK_GATEWAY',
  'CASHBACK_TOPUP',
  'CASHBACK_RENEWAL',
  // WP8: cashback on a DELIVERED order, of any paid purpose, and its reversal when the
  // order's payment is later refunded. Its own reason rather than `CASHBACK_RENEWAL`,
  // which names one legacy mechanism for one purpose; and a reversal is a debit with its
  // own name, never a negative credit. `docs/wp8-pricing-audit.md` P9.
  'CASHBACK_PURCHASE',
  'CASHBACK_REVERSAL',
  // Referral
  'REFERRAL_COMMISSION',
  'REFERRAL_COMMISSION_REVERSAL',
  'REFERRAL_SIGNUP_GIFT',
  // Grants
  'START_GIFT',
  'LOTTERY_WIN',
  'LUCK_WHEEL_WIN',
  // Administrative
  'ADMIN_CREDIT',
  'ADMIN_DEBIT',
  'MASS_CREDIT',
  'MASS_DEBIT',
  // Reseller
  'RESELLER_SETTLEMENT',
  'RESELLER_MEMBERSHIP_FEE',
  // Exceptional
  'CHARGEBACK',
  'CORRECTION',
  'OTHER',
] as const;

export type LedgerReason = (typeof LEDGER_REASONS)[number];

export const ledgerDirectionSchema = z.enum(LEDGER_DIRECTIONS);
export const ledgerReasonSchema = z.enum(LEDGER_REASONS);

/** Reasons that may only be produced by an administrative action, never by a flow. */
export const ADMINISTRATIVE_REASONS: readonly LedgerReason[] = [
  'ADMIN_CREDIT',
  'ADMIN_DEBIT',
  'MASS_CREDIT',
  'MASS_DEBIT',
  'CORRECTION',
];

/** Reasons that reverse an earlier entry and therefore require a reference to it. */
export const REVERSAL_REASONS: readonly LedgerReason[] = [
  'PURCHASE_REVERSAL',
  'CASHBACK_REVERSAL',
  'REFERRAL_COMMISSION_REVERSAL',
  'REFUND',
  'CHARGEBACK',
  'CORRECTION',
];

export function isLedgerReason(value: string): value is LedgerReason {
  return (LEDGER_REASONS as readonly string[]).includes(value);
}
