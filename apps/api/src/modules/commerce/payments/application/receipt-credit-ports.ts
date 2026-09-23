import type { Money, PaymentId, TenantContext } from '@nexa/contracts';

/**
 * A card-to-card receipt's credit-to-wallet disposition, as the application layer sees
 * it (Payment File 02 §12, `docs/payments-file02-design.md` D2).
 *
 * Append-only — `receipt_credits_no_update` and `_no_delete` (0114) refuse both — and
 * keyed by the payment, so there is at most one of these per payment for ever.
 */
export interface ReceiptCreditRecord {
  readonly paymentId: PaymentId;
  /** What the reviewer entered and the `RECEIPT_CREDIT` entry holds, in the payment's currency. */
  readonly amount: Money;
  /** The `RECEIPT_CREDIT` ledger entry this disposition wrote. */
  readonly walletEntryId: string;
  readonly decidedByAdminId: string;
  readonly decidedAt: Date;
  readonly note: string | null;
}

export interface ReceiptCreditRepository {
  /**
   * Records THE disposition. A plain INSERT, deliberately not `ON CONFLICT DO NOTHING`.
   *
   * The service holds the payment's row lock and has just moved it out of PENDING, so a
   * conflict here means a writer that did not take either. That is not a replay to be
   * answered quietly; it is a second disposition, and the primary key refusing it loudly
   * is the backstop invariant 8 names.
   */
  record(
    scope: TenantContext,
    record: ReceiptCreditRecord,
    tx: unknown,
  ): Promise<ReceiptCreditRecord>;

  findByPayment(
    scope: TenantContext,
    paymentId: PaymentId,
    tx?: unknown,
  ): Promise<ReceiptCreditRecord | null>;
}
