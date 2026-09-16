import type {
  Money,
  OrderId,
  PaymentEvidenceKind,
  PaymentId,
  PaymentMethod,
  PaymentResolvedState,
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
  /**
   * When it ended WITHOUT money — rejected, withdrawn or expired.
   *
   * The mirror of `confirmedAt`, and a second field rather than a reused one because
   * `payments_confirmed_check` binds that one to CONFIRMED. A record carrying both
   * meanings in one field would be read by asking `state`, which is how a rejection
   * comes to be displayed as an approval.
   */
  readonly resolvedAt: Date | null;
  /** The administrator who rejected it. Null for an expiry and for a withdrawal. */
  readonly resolvedByAdminId: string | null;
  /** Why, in the operator's own words. Null unless a person rejected it. */
  readonly resolutionNote: string | null;
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

/**
 * What a resolution records: a payment that ended WITHOUT money.
 *
 * The mirror of `PaymentConfirmation`, and like it there is no `amount` and no
 * `state` beyond the target the caller names. A rejection asserts that the money the
 * payment already says was owed did not arrive; it never restates the figure.
 *
 * `resolvedByAdminId` is null for everything but an operator's rejection — nobody
 * decides an expiry and a withdrawal is the customer's own — and
 * `payments_resolution_reviewer_check` refuses the write if a caller gets that wrong.
 */
export interface PaymentResolution {
  /** The administrator who rejected it. Null for an expiry and for a withdrawal. */
  readonly resolvedByAdminId: string | null;
  /** Why, in the operator's own words. Null when no person decided it. */
  readonly resolutionNote: string | null;
  readonly resolvedAt: Date;
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
  /**
   * The quotable code, matched EXACTLY.
   *
   * Exact rather than a prefix or a contains: a reference is what a customer reads out
   * of a message, and a partial match over money would let an operator open somebody
   * else's payment by typing four characters. `payments_tenant_reference_key` makes the
   * exact match a unique lookup within the tenant.
   */
  readonly reference?: string;
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

  /**
   * The three edges that end a payment WITHOUT money, as one conditional UPDATE each.
   *
   * `FAIL`, `CANCEL` and `EXPIRE` — `PAYMENT_MACHINE`'s remaining transitions out of
   * `PENDING`. They share a method because they are the same statement with a
   * different target and a different set of resolution fields; splitting them into
   * three would be three places for `WHERE state = 'PENDING'` to be got wrong.
   *
   * The `from` state is NOT a parameter and is hard-bound to `PENDING`. Every edge in
   * the machine that reaches one of these three leaves `PENDING`, so a parameter would
   * only ever carry one value — and the one it could carry WRONG is `UNKNOWN`, whose
   * two reconcile edges have no producer in this release and must not be reachable by
   * passing an argument.
   *
   * It reports whether the row actually moved, and that is the whole concurrency
   * story: an operator rejecting while the sweep expires, a customer withdrawing while
   * an operator confirms, a replayed command and two worker replicas all produce ONE
   * transition and one `true`. There is no `setState`.
   *
   * Both resolution columns are set by the SAME statement as the state, because
   * `payments_resolved_check` binds them: `(state IN ('FAILED','CANCELLED','EXPIRED'))
   * = (resolved_at IS NOT NULL)`, so moving the state alone could not commit.
   */
  resolve(
    scope: TenantContext,
    id: PaymentId,
    to: PaymentResolvedState,
    resolution: PaymentResolution,
    now: Date,
    tx?: unknown,
  ): Promise<boolean>;
}
