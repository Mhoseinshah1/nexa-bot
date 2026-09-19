import type {
  CurrencyCode,
  Money,
  OrderId,
  PaymentId,
  RefundChannel,
  RefundId,
  RefundState,
  TenantContext,
  UserId,
} from '@nexa/contracts';

/** One refund, as the application layer holds it. */
export interface RefundRecord {
  readonly id: RefundId;
  readonly paymentId: PaymentId;
  readonly customerId: UserId;
  readonly orderId: OrderId | null;
  readonly state: RefundState;
  readonly channel: RefundChannel;
  readonly amount: Money;
  readonly reason: string;
  readonly requestedByAdminId: string | null;
  readonly completedByAdminId: string | null;
  readonly completedAt: Date | null;
  readonly externalReference: string | null;
  readonly completionNote: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What a refund is created with. The channel and amount are already decided and bounded. */
export interface RefundDraft {
  readonly id: RefundId;
  readonly paymentId: PaymentId;
  readonly customerId: UserId;
  readonly orderId: OrderId | null;
  readonly state: RefundState;
  readonly channel: RefundChannel;
  readonly amount: Money;
  readonly reason: string;
  readonly requestedByAdminId: string | null;
  /** Set only when the refund is born COMPLETED, which is the wallet channel. */
  readonly completedByAdminId: string | null;
  readonly completedAt: Date | null;
  readonly now: Date;
}

/**
 * How much of a payment is already spoken for.
 *
 * `consumedMinor` sums `REFUND_CONSUMING_STATES` — so an in-flight refund reserves its
 * amount and two operators cannot each refund the same payment in full. `currency` comes
 * back so the caller can refuse a payment whose refunds somehow disagree with it rather
 * than summing across denominations, which would be the implicit conversion the money
 * model refuses.
 */
export interface RefundConsumption {
  readonly consumedMinor: bigint;
  readonly currency: CurrencyCode | null;
  readonly count: number;
}

export interface RefundRepository {
  /**
   * How many CONFIRMED payments in this currency still have refundable money.
   *
   * Read by the guard that refuses a `sales.currency` change: a credit written in a
   * currency the tenant no longer sells in is one the customer cannot see or spend.
   */
  refundableExposureIn(scope: TenantContext, currency: CurrencyCode, tx?: unknown): Promise<number>;

  /** Every refund against one payment, oldest first — the order a history reads in. */
  listForPayment(
    scope: TenantContext,
    paymentId: PaymentId,
    tx?: unknown,
  ): Promise<readonly RefundRecord[]>;

  findById(scope: TenantContext, id: RefundId, tx?: unknown): Promise<RefundRecord | null>;

  /**
   * The same read, holding the row until the caller's transaction ends.
   *
   * One caller: completing or failing a refund. Both are conditional UPDATEs naming the
   * state they move from, so this is not what makes them safe — it is what makes the
   * REFUSAL truthful, by ensuring the state the caller reports having refused from is
   * the state that was actually there.
   */
  findByIdForUpdate(scope: TenantContext, id: RefundId, tx: unknown): Promise<RefundRecord | null>;

  /**
   * What this payment has already committed to refunding.
   *
   * Read inside the requesting transaction, AFTER the payment row is locked, which is
   * what makes the bound hold under concurrency: summing without the lock lets two
   * requests each see the pre-existing total and both commit, and the payment refunds
   * twice over. The wallet ledger's `lockCustomer` comment records the same failure for
   * the same reason — under READ COMMITTED a `SUM` does not block on another
   * transaction's uncommitted INSERT.
   */
  consumptionFor(
    scope: TenantContext,
    paymentId: PaymentId,
    tx: unknown,
  ): Promise<RefundConsumption>;

  /**
   * Takes the PAYMENT row `FOR UPDATE`, so a consumption read after it is a decision.
   *
   * The payment rather than the customer, because the bound being defended is per
   * payment: two refunds of different payments by the same customer have no reason to
   * wait for each other, and two refunds of the SAME payment must. Returns false when
   * the payment does not exist — `FOR UPDATE` on a missing row locks nothing, which is
   * the way this pattern silently stops serialising.
   */
  lockPayment(scope: TenantContext, paymentId: PaymentId, tx: unknown): Promise<boolean>;

  create(scope: TenantContext, draft: RefundDraft, tx: unknown): Promise<RefundRecord>;

  /**
   * Moves a refund to a state, only FROM the state named.
   *
   * The conditional UPDATE ADR-0028 records: a replay, a double-click and two replicas
   * are all made safe by one mechanism rather than three checks. `null` means the row is
   * gone or was not in `from`, and the caller re-reads to tell those apart.
   */
  transition(
    scope: TenantContext,
    id: RefundId,
    input: {
      readonly from: RefundState;
      readonly to: RefundState;
      readonly completedByAdminId?: string | null;
      readonly completedAt?: Date | null;
      readonly externalReference?: string | null;
      readonly completionNote?: string | null;
    },
    now: Date,
    tx: unknown,
  ): Promise<RefundRecord | null>;
}
