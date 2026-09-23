import type {
  LateTransferDecision,
  Money,
  PaymentId,
  PaymentRejectionReason,
  TenantContext,
} from '@nexa/contracts';

/**
 * A late transfer's one decision, as the application layer sees it.
 *
 * `docs/wp10-payments-audit.md` P1. Append-only — `late_transfer_decisions_no_update`
 * and `_no_delete` (0111) refuse both — and keyed by the payment, so there is at most one
 * of these per payment for ever.
 */
export interface LateTransferDecisionRecord {
  readonly paymentId: PaymentId;
  readonly decision: LateTransferDecision;
  /** Required on a dismissal and absent on a credit — `late_transfer_decisions_reason_check`. */
  readonly reason: PaymentRejectionReason | null;
  readonly note: string | null;
  /** What a credit put on the wallet: the payment's own amount. Null for a dismissal. */
  readonly amount: Money | null;
  /** The `LATE_TRANSFER` ledger entry a credit wrote. Null for a dismissal. */
  readonly walletEntryId: string | null;
  readonly decidedByAdminId: string;
  readonly decidedAt: Date;
}

/** What recording a decision needs. Everything, because nothing about it changes later. */
export interface LateTransferDecisionDraft {
  readonly paymentId: PaymentId;
  readonly decision: LateTransferDecision;
  readonly reason: PaymentRejectionReason | null;
  readonly note: string | null;
  readonly amount: Money | null;
  readonly walletEntryId: string | null;
  readonly decidedByAdminId: string;
  readonly decidedAt: Date;
}

export interface LateTransferRepository {
  findDecision(
    scope: TenantContext,
    paymentId: PaymentId,
    tx?: unknown,
  ): Promise<LateTransferDecisionRecord | null>;

  /**
   * Records THE decision. A plain INSERT, deliberately not `ON CONFLICT DO NOTHING`.
   *
   * The service holds the payment's row lock and has already read that no decision
   * exists, so a conflict here means a writer that did not take the lock. That is not a
   * replay to be answered quietly; it is a second decision, and the primary key refusing
   * it loudly is the backstop P1 names.
   */
  record(
    scope: TenantContext,
    draft: LateTransferDecisionDraft,
    tx: unknown,
  ): Promise<LateTransferDecisionRecord>;

  /**
   * The decisions standing on a page of payments, by payment id.
   *
   * One query for the page rather than one per row, for the surface that lists the lane.
   */
  decisionsFor(
    scope: TenantContext,
    paymentIds: readonly PaymentId[],
    tx?: unknown,
  ): Promise<ReadonlyMap<PaymentId, LateTransferDecisionRecord>>;

  /** How many receipts each of a page of payments holds. Absent means none. */
  receiptCountsFor(
    scope: TenantContext,
    paymentIds: readonly PaymentId[],
    tx?: unknown,
  ): Promise<ReadonlyMap<PaymentId, number>>;
}
