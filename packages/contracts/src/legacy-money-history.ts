import { z } from 'zod';
import { moneySchema } from './money.js';

/**
 * Mirza `.nxpkg` importer — a customer's Mirza MONEY history, summarised and set beside the
 * opening figure the migration wrote (`docs/legacy-migration/nxpkg-importer.md` §5).
 *
 * READ ONLY, and never a balance. The wallet's opening figure is Mirza's `user.Balance`
 * snapshot and nothing else: one `MIGRATION_OPENING_BALANCE` ledger CREDIT for a positive
 * balance, one legacy debt (held for review, never collected) for a negative one. The
 * archived history — payments, wallet transactions, wheel prizes, referrals, discounts,
 * service operations — is EVIDENCE about how that snapshot came about. Nothing on this
 * surface writes, and no figure here is added to, netted against or compared into a balance
 * by any money path. Charged on `users.view`, then `legacy.history.view` (the history card's
 * own key: every amount here is already readable, record by record, on that card).
 */

/** What a successful legacy payment was FOR, as far as the package says. */
export const LEGACY_MONEY_PAYMENT_PURPOSES = [
  /** `Payment_report.id_invoice` tag absent or not a purchase tag, customer method. */
  'WALLET_TOP_UP',
  /** A purchase tag: buy after payment, extend, extra volume, extra time. */
  'SERVICE_PURCHASE',
  /** Mirza's "add balance by admin". */
  'ADMIN_CREDIT',
  /** Mirza's "low balance by admin" (stored as a positive price). */
  'ADMIN_DEBIT',
  /** The backup has no `id_invoice`/`invoice` column: top-up and purchase cannot be told apart. */
  'PURPOSE_NOT_IN_SOURCE',
  /** A purpose code this reader does not know. */
  'OTHER',
] as const;
export type LegacyMoneyPaymentPurpose = (typeof LEGACY_MONEY_PAYMENT_PURPOSES)[number];

/** The converter's payment outcomes (`status.outcome`); anything else reads as UNKNOWN. */
export const LEGACY_MONEY_PAYMENT_OUTCOMES = [
  'SUCCEEDED',
  'FAILED',
  'PENDING',
  'CANCELLED',
  'UNKNOWN',
] as const;
export type LegacyMoneyPaymentOutcome = (typeof LEGACY_MONEY_PAYMENT_OUTCOMES)[number];

/**
 * How the archived history relates to the opening figure. The snapshot is authoritative in
 * every case; the status says what the evidence shows, never what the balance should be.
 */
export const LEGACY_MONEY_RECONCILIATION_STATUSES = [
  /** Opening = snapshot, and the converter's wallet-history walk ends at the snapshot. */
  'RECONCILED',
  /** Opening = snapshot; the wallet-history walk ends elsewhere. The snapshot was kept. */
  'HISTORY_DIFFERS_SNAPSHOT_KEPT',
  /** An opening figure exists; Mirza kept no wallet-transaction chain to check it against. */
  'NO_WALLET_HISTORY',
  /** Neither an opening credit, a debt nor a wallet-history check: a zero or no Mirza balance. */
  'NO_OPENING_FIGURE',
  /** The opening written is not the snapshot the converter read. Must never happen. */
  'OPENING_DIFFERS_FROM_SNAPSHOT',
  /** More than one opening, a non-credit opening, a foreign reference, or credit AND debt. */
  'OPENING_INVALID',
  /** More than one wallet-history check for one customer. */
  'AMBIGUOUS_EVIDENCE',
  /** The check's amounts, currency or verdict cannot be read. */
  'UNREADABLE_EVIDENCE',
] as const;
export type LegacyMoneyReconciliationStatus = (typeof LEGACY_MONEY_RECONCILIATION_STATUSES)[number];

/** A count of records with the sum of their readable amounts, one entry per currency. */
export const legacyMoneyTotalSchema = z.object({
  count: z.number().int().nonnegative(),
  amounts: z.array(moneySchema),
  /** Records whose amount is not an integer string: counted, never summed. */
  unparsedAmounts: z.number().int().nonnegative(),
  /** Records whose currency is not a known code: counted, never summed. */
  unrecognisedCurrency: z.number().int().nonnegative(),
});
export type LegacyMoneyTotal = z.infer<typeof legacyMoneyTotalSchema>;

export const legacyMoneyReconciliationSchema = z.object({
  status: z.enum(LEGACY_MONEY_RECONCILIATION_STATUSES),
  /** Opening credit minus legacy debt (zero when neither exists); null when unreadable. */
  openingFigure: moneySchema.nullable(),
  /** `user.Balance` as the converter's wallet-history check read it; null without a check. */
  snapshotBalance: moneySchema.nullable(),
  /** The last `balance_after` of Mirza's wallet-transaction chain. */
  historyClosingBalance: moneySchema.nullable(),
  /** Snapshot minus history closing balance, when the converter stated one. */
  deltaSnapshotMinusHistory: moneySchema.nullable(),
  /** The converter's verdict code verbatim (`MATCHES_SNAPSHOT`, `DIFFERS_FROM_SNAPSHOT`, …). */
  historyVerdict: z.string().nullable(),
  /** The converter's difference analysis (`cause`, `certainty`), when it made one. */
  difference: z
    .object({ cause: z.string().nullable(), certainty: z.string().nullable() })
    .nullable(),
  /** Null when there is no snapshot to compare with. */
  openingEqualsSnapshot: z.boolean().nullable(),
});
export type LegacyMoneyReconciliation = z.infer<typeof legacyMoneyReconciliationSchema>;

export const legacyMoneyHistoryResponseSchema = z.object({
  /** Always true: the history is shown, never applied. */
  readOnly: z.literal(true),
  /** Always false: no figure here is part of the customer's balance. */
  addedToBalance: z.literal(false),
  payments: z.object({
    /** SUCCEEDED payments only, by purpose. */
    succeededByPurpose: z.array(
      z.object({ purpose: z.enum(LEGACY_MONEY_PAYMENT_PURPOSES), total: legacyMoneyTotalSchema }),
    ),
    /** Every other outcome, shown apart and counted in no total above. */
    excludedByOutcome: z.array(
      z.object({ outcome: z.enum(LEGACY_MONEY_PAYMENT_OUTCOMES), total: legacyMoneyTotalSchema }),
    ),
  }),
  walletTransactions: z.object({
    moneyIn: legacyMoneyTotalSchema,
    /** Magnitudes (positive) of the debits. */
    moneyOut: legacyMoneyTotalSchema,
    noChange: z.number().int().nonnegative(),
    unparsedAmounts: z.number().int().nonnegative(),
  }),
  wheel: z.object({
    spins: z.number().int().nonnegative(),
    prizesWon: legacyMoneyTotalSchema,
  }),
  referrals: z.object({
    /** Records where this customer was the one referred. */
    asReferee: z.number().int().nonnegative(),
    /** Records where this customer was the referrer. */
    asReferrer: z.number().int().nonnegative(),
    /** Of those, the ones Mirza marked as gift paid to the referrer (no amount is recorded). */
    referrerGiftsPaid: z.number().int().nonnegative(),
  }),
  /** Discount and gift code uses (Mirza's amount field is unproven: a count only). */
  discountsUsed: z.number().int().nonnegative(),
  /** Mirza service operations by status; the amount's meaning is unproven in the source. */
  serviceOperations: z.array(z.object({ status: z.string(), total: legacyMoneyTotalSchema })),
  opening: z.object({
    /** The `MIGRATION_OPENING_BALANCE` ledger credit, when one was written. */
    credit: moneySchema.nullable(),
    /** The negative balance held as a legacy debt (positive amount), when one was recorded. */
    debt: z.object({ amount: moneySchema, state: z.string() }).nullable(),
  }),
  reconciliation: legacyMoneyReconciliationSchema,
});
export type LegacyMoneyHistoryResponse = z.infer<typeof legacyMoneyHistoryResponseSchema>;
