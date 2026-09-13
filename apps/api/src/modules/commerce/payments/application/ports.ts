import type {
  Money,
  OrderId,
  PaymentEvidenceKind,
  PaymentId,
  PaymentMethod,
  PaymentState,
  TenantContext,
  UserId,
} from '@nexa/contracts';

/**
 * One payment, as the application layer sees it.
 *
 * A payment is a FIRST-CLASS record and not a property of an order, which is the one
 * structural thing the research settles outright: the legacy system has 124,196
 * payments against 74,860 orders, because a renewal and an add-on are payments with no
 * new order. It also names the same row "receipt" and "payment" (`PRBR-004`), which is
 * why `method` and `evidenceKind` are separate columns here — how money arrived and
 * what a confirmation rests on are different questions.
 */
export interface PaymentRecord {
  readonly id: PaymentId;
  readonly customerId: UserId;
  /** Null would be a wallet top-up. Nothing in this release produces one. */
  readonly orderId: OrderId | null;
  readonly state: PaymentState;
  readonly method: PaymentMethod;
  readonly amount: Money;
  /** Generated, unique per tenant, quoted by the customer. Never customer-supplied. */
  readonly reference: string;
  readonly evidenceKind: PaymentEvidenceKind | null;
  readonly evidenceNote: string | null;
  readonly externalReference: string | null;
  readonly confirmedAt: Date | null;
  readonly confirmedByAdminId: string | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * What creating a payment needs.
 *
 * No `state`: the initial one is `PAYMENT_MACHINE.initial` and a caller that could
 * name its own could create a payment already CONFIRMED, which is the whole of the
 * confirmation path skipped in one field. No `evidenceKind` and no `confirmedAt` for
 * the same reason — `payments_confirmed_check` binds those to the state, and the only
 * thing that may set them is a confirmation.
 */
export interface PaymentDraft {
  readonly id: PaymentId;
  readonly customerId: UserId;
  readonly orderId: OrderId | null;
  readonly method: PaymentMethod;
  readonly amount: Money;
  readonly reference: string;
  readonly expiresAt: Date | null;
  readonly now: Date;
}

/** What a confirmation records. There is no `amount` — see `PaymentRepository.confirm`. */
export interface PaymentConfirmation {
  readonly evidenceKind: PaymentEvidenceKind;
  readonly evidenceNote: string | null;
  /** The administrator who approved it, for an `OPERATOR_REVIEW`. Null for a flow. */
  readonly confirmedByAdminId: string | null;
  readonly confirmedAt: Date;
}

/** `(createdAt, id)`, both immutable. The same keyset every other list here uses. */
export interface PaymentCursor {
  /** PostgreSQL's own microsecond text, never a `Date`. See `CustomerCursor`. */
  readonly createdAt: string;
  readonly id: PaymentId;
}

export interface PaymentPage {
  readonly items: readonly PaymentRecord[];
  readonly nextCursor: PaymentCursor | null;
}

export interface PaymentSearch {
  readonly state?: PaymentState;
  readonly method?: PaymentMethod;
  readonly customerId?: UserId;
  readonly orderId?: OrderId;
}

export interface PaymentRepository {
  /**
   * Creates a payment, or returns the one already written under this reference.
   *
   * The same `ON CONFLICT DO NOTHING` then re-read the wallet ledger uses, against
   * `payments_tenant_reference_key`, and for the same reason: a retried command must
   * produce one payment rather than a second one the customer could also be asked to
   * pay.
   */
  create(scope: TenantContext, draft: PaymentDraft, tx?: unknown): Promise<PaymentRecord>;

  findById(scope: TenantContext, id: PaymentId, tx?: unknown): Promise<PaymentRecord | null>;

  findByReference(
    scope: TenantContext,
    reference: string,
    tx?: unknown,
  ): Promise<PaymentRecord | null>;

  list(
    scope: TenantContext,
    search: PaymentSearch,
    limit: number,
    cursor: PaymentCursor | null,
    tx?: unknown,
  ): Promise<PaymentPage>;

  /**
   * The `CONFIRM` edge of `PAYMENT_MACHINE`, as a conditional UPDATE, and it reports
   * whether the row actually moved.
   *
   * `WHERE state = 'PENDING'` is the whole concurrency story, exactly as it is for an
   * order: two operators pressing approve, a replayed request and two replicas all
   * produce one confirmation and one `true`. There is no `setState`.
   *
   * **It takes no amount.** A confirmation records what the payment already says the
   * money was; it never restates it. `nexa_payments_confirmation_guard` (0035) freezes
   * the money, the customer, the order, the method, the reference, the evidence and
   * the confirming administrator once the state is CONFIRMED, so an amount passed here
   * could not be written anyway — the method simply does not offer the field, which is
   * the difference between a rule and a rule a caller can try.
   */
  confirm(
    scope: TenantContext,
    id: PaymentId,
    confirmation: PaymentConfirmation,
    now: Date,
    tx?: unknown,
  ): Promise<boolean>;
}
