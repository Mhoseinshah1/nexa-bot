import { z } from 'zod';
import { telegramUserIdSchema } from './customer.js';

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
  // Payment File 02 §12 (D2): a reviewer crediting the amount they judged arrived with a
  // card-to-card receipt to the customer's wallet, as that receipt's final disposition. A
  // CREDIT and never a reversal: it reverses nothing. Its own reason rather than
  // `TOPUP_RECEIPT`, which is a top-up the customer asked for and earns a gift, and rather
  // than `ADMIN_CREDIT`, which has no payment behind it. It always names its payment, and
  // there is one per payment, by `wallet_entries_receipt_credit_payment_key`.
  // `docs/payments-file02-design.md` D2.
  'RECEIPT_CREDIT',
  // R5A item 4: a gateway's verified approval that arrived AFTER Nexa had closed the payment
  // (deadline passed, or EXPIRED / UNKNOWN), credited to the customer's wallet and never to the
  // order. Its own reason rather than `TOPUP_GATEWAY` (a top-up the payment settled, which earns
  // a gift) or `ADMIN_CREDIT` (no operator decided it): the money came from a payment, once, by
  // `<paymentId>:late-credit`, and `wallet_entries_gateway_late_credit_payment_key` holds that.
  'GATEWAY_LATE_CREDIT',
  // Commerce
  'PURCHASE',
  'PURCHASE_REVERSAL',
  'REFUND',
  // Cashback — three distinct sources, never merged into one opaque bump
  'CASHBACK_GATEWAY',
  // Payment File 02 §17 (D5): the top-up gift, a percentage of a top-up's principal
  // snapshotted on the payment from the gateway it was offered through. A separate entry
  // from the principal's `TOPUP_RECEIPT`, never folded into it, one per payment by
  // `wallet_entries_topup_cashback_payment_key`.
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
  // R10 D4: a gift card (wallet top-up code) an operator minted in a batch and a customer
  // redeemed. A CREDIT, never a reversal and never administrative: no operator decided THIS
  // credit (the batch was minted earlier, for anyone holding a code) and no payment arrived
  // with it. Its own reason so the liability a batch created is reported apart from top-ups,
  // signup gifts and operator grants. One per code, under `giftcard:<codeId>`, and a CHECK
  // pins the reason and the prefix to each other in both directions.
  'GIFT_CARD_REDEMPTION',
  // Grants
  'START_GIFT',
  'LOTTERY_WIN',
  'LUCK_WHEEL_WIN',
  // Administrative
  'ADMIN_CREDIT',
  'ADMIN_DEBIT',
  'MASS_CREDIT',
  'MASS_DEBIT',
  // Customer 360 (`docs/customer-account-transfer-audit.md`): an operator moving a
  // customer's whole balance to the account that replaces it. Always a PAIR written in one
  // transaction — a DEBIT of the source and a CREDIT of the destination for the same
  // amount — never a set-balance, and never `ADMIN_*`, which would read as money an
  // operator granted or took rather than money that changed hands.
  'ACCOUNT_TRANSFER_OUT',
  'ACCOUNT_TRANSFER_IN',
  // Reseller
  'RESELLER_SETTLEMENT',
  'RESELLER_MEMBERSHIP_FEE',
  // Legacy migration (Migration P2, `docs/migration-opening-balance.md`): the ONE entry that
  // carries a customer's legacy wallet balance into this ledger, at import time. Its own
  // reason because it is none of the others: not a top-up (no money arrived), not an
  // administrative grant (no operator decided it), not a sale. A CREDIT for a positive
  // legacy balance and a DEBIT for a negative one — the only writer allowed to take a
  // wallet below zero, because the debt already exists and is being recorded, not
  // created. At most one per customer, under `legacy:opening:<telegram_user_id>`.
  'MIGRATION_OPENING_BALANCE',
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
  'ACCOUNT_TRANSFER_OUT',
  'ACCOUNT_TRANSFER_IN',
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

/**
 * Migration P2: the reference an opening balance is written under.
 *
 * DERIVED from the legacy identity — the customer's Telegram user id, which is the
 * legacy `user.id` and NEXA's `customers.telegram_user_id` — so a rerun, a resume and two
 * importers racing compute the same reference without talking to each other, and
 * `wallet_entries_tenant_reference_key` makes the second one a no-op. The prefix is
 * reserved for this reason by a CHECK in both directions.
 */
export const MIGRATION_OPENING_REFERENCE_PREFIX = 'legacy:opening:' as const;

/** Throws for anything `telegramUserIdSchema` refuses: the reference names a real id. */
export function migrationOpeningReference(telegramUserId: string): string {
  if (!telegramUserIdSchema.safeParse(telegramUserId).success) {
    throw new Error('A migration opening reference needs a Telegram user id.');
  }
  return `${MIGRATION_OPENING_REFERENCE_PREFIX}${telegramUserId}`;
}

/**
 * R10 D4: the reference a gift card's redemption credit is written under.
 *
 * DERIVED from the code row's id, so a retry, a replay and two redeemers racing one code all
 * compute the same reference, and `wallet_entries_tenant_reference_key` lets at most one
 * credit exist per code even if a writer forgot the code row's conditional UPDATE. The prefix
 * is reserved for `GIFT_CARD_REDEMPTION` by a CHECK in both directions.
 */
export const GIFT_CARD_REFERENCE_PREFIX = 'giftcard:' as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Throws for anything that is not a lower-case uuid: the reference names a real code row. */
export function giftCardReference(codeId: string): string {
  if (!UUID_PATTERN.test(codeId)) {
    throw new Error('A gift card reference needs the code row id.');
  }
  return `${GIFT_CARD_REFERENCE_PREFIX}${codeId}`;
}
