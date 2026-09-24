import type {
  Money,
  OrderId,
  PaymentEvidenceKind,
  PaymentGatewayProvider,
  PaymentId,
  PaymentMethod,
  PaymentResolvedState,
  PaymentState,
  ReceiptDisposition,
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
  /**
   * When the customer said they had sent the transfer. Their CLAIM, never evidence.
   *
   * Deliberately not folded into `state`. `PAYMENT_STATES` classifies what this
   * installation KNOWS about the money; a customer's assertion is not knowledge, and a
   * `SIGNALLED` member would put it on the same axis as a reviewed confirmation. The
   * legacy receipt review does exactly that — `PRBR-004` records that "receipt" and
   * "payment" name one record there — and the operator can then no longer tell what
   * was claimed from what was checked.
   */
  readonly customerSignalledAt: Date | null;
  readonly expiresAt: Date | null;
  /**
   * The route the payment was offered through, snapshotted at creation (D5, D7). Null
   * for a wallet settlement and for a payment created before the column existed.
   */
  readonly gatewayProvider: PaymentGatewayProvider | null;
  /**
   * The top-up gift this payment promised, snapshotted from its route at creation (D5).
   * Null for anything that is not a top-up; frozen after insert by 0114.
   */
  readonly topupCashbackPercent: number | null;
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
  /** The route snapshot (D5). Null for a wallet settlement. */
  readonly gatewayProvider: PaymentGatewayProvider | null;
  /**
   * The gift a TOP-UP promises, from its route's `topup_cashback_percent`; null for every
   * other payment. Written once, here, and frozen by 0114 afterwards.
   */
  readonly topupCashbackPercent: number | null;
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
  /**
   * How the receipt left review (WP10 follow-up §5), by the SAME derivation the list and
   * detail report — one SQL expression, so the filter and the column cannot disagree.
   */
  readonly disposition?: ReceiptDisposition;
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

  /**
   * The same read, holding the row until the caller's transaction ends.
   *
   * One caller: filing a receipt. It refuses a payment that is not PENDING, and an
   * ordinary read cannot enforce that — an operator's confirmation can commit between
   * the read and the insert, and the evidence then lands on a payment somebody has
   * already decided. The confirm path UPDATEs this row, so holding it here makes the
   * two orders the only two: either the operator waits and then sees the receipt, or
   * this read waits and then sees CONFIRMED and refuses.
   *
   * Requires a transaction. Locking a row outside one holds it for a statement and
   * releases it immediately, which would look like protection and be none.
   */
  findByIdForUpdate(
    scope: TenantContext,
    id: PaymentId,
    tx: unknown,
  ): Promise<PaymentRecord | null>;

  /**
   * The customer's open wallet top-up, if they have one.
   *
   * A top-up is a payment with NO order, so `PaymentSearch` cannot express it: every
   * filter there narrows by a value, and this asks for the absence of one. Its own
   * method rather than a nullable filter, because "order_id IS NULL" is the definition
   * of a top-up in this schema and a search flag would let a caller ask for it by
   * accident.
   *
   * ONE per customer is the rule it serves, and it is the order rule with the order
   * swapped out: two open top-ups are two references for one intention, the customer
   * transfers once quoting one of them, and the operator cannot tell which. The order
   * path states the rest of that argument on `requestManualTransfer`.
   */
  findOpenTopup(
    scope: TenantContext,
    customerId: UserId,
    tx?: unknown,
  ): Promise<PaymentRecord | null>;

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

  /**
   * Expires the PENDING payments whose own deadline has passed, bounded.
   *
   * The `EXPIRE` edge as a SET rather than one row at a time, because there is nothing
   * to decide per row: the deadline is on the row, the target is one state, and no
   * person is involved. `resolve` exists for the two edges a person takes.
   *
   * Bounded by `limit` for the reason `ServiceRepository.expireDue` is: a tenant whose
   * orders all lapse on one midnight must not turn one tick into ten thousand rows, and
   * the next tick picks up where this one stopped because the candidates are ordered by
   * deadline.
   *
   * Returns the rows it moved, so the sweep can audit each one. The `before` state is
   * not returned and does not need to be: there is exactly one source state and the
   * statement names it, which is what `ServiceRepository.expireDue` needs two UPDATEs
   * to achieve.
   *
   * It takes a REQUIRED transaction. This is a durable write and ADR-0028's quiesce
   * gate lives in `DrizzleUnitOfWork.run`; an optional handle here would make it
   * possible to expire a customer's payment in a database that is being replaced.
   *
   * **A manual transfer that carries a receipt is never a candidate** (Payment File 02
   * §9, D1): a submitted receipt has no timer and leaves review only through a
   * reviewer's decision. The predicate is in the candidate SELECT and again in the
   * UPDATE, for the reason the UPDATE re-checks every other predicate.
   */
  expireDue(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: unknown,
  ): Promise<readonly PaymentRecord[]>;

  /**
   * Records that the customer says they have sent the transfer.
   *
   * It moves NO state, and that is the point of it being its own method rather than a
   * parameter on `resolve`: `resolve` exists for the three edges that end a payment,
   * and a claim ends nothing. What the customer taps changes what an operator can see
   * and changes nothing about the money.
   *
   * A conditional UPDATE, and its predicates are the whole contract:
   *
   *   - `state = 'PENDING'` — a claim about a payment that is already over is a claim
   *     nobody can act on, and the schema's guard refuses it in any case (0058).
   *   - `method = 'MANUAL_TRANSFER'` — `payments_customer_signal_check` says the same
   *     thing, and stating it here means a wallet payment answers `false` rather than
   *     raising.
   *   - `customer_signalled_at IS NULL` — the FIRST claim is the one recorded. A
   *     customer tapping again a day later must not move the moment they first said
   *     they had paid, because that moment is what an operator compares against their
   *     bank statement.
   *
   * So `false` means one of three things and the caller treats all of them the same
   * way it treats a replay, which is what makes a double tap harmless.
   */
  signalSent(scope: TenantContext, id: PaymentId, now: Date, tx?: unknown): Promise<boolean>;

  /**
   * Whether any PENDING payment against this order has been claimed as sent.
   *
   * An EXISTS rather than a list, because the caller acts on the answer and never on
   * the rows: `OrderService.cancelByCustomer` refuses when it is true, and a payment id
   * would only give it something to leak.
   *
   * It takes a REQUIRED transaction. The whole point is that a claim committing between
   * the read and the cancellation cannot slip past, and an optional handle would make
   * the read a different snapshot from the write.
   */
  hasClaimedPendingForOrder(scope: TenantContext, orderId: OrderId, tx: unknown): Promise<boolean>;

  /**
   * Withdraws every PENDING payment against one order. The `CANCEL` edge, as a set.
   *
   * For `OrderService.cancelByCustomer`, which must not leave a live transfer
   * instruction behind a cancelled order — the state `PaymentExpiryService`'s docblock
   * names as the one a customer could act on with their own money.
   *
   * `CANCELLED` rather than `EXPIRED`, because a deadline did not do this: the customer
   * did, and `commerce.ts` records that "the customer changed their mind" and "we
   * stopped waiting" are different facts about the same row.
   *
   * A set rather than one row: at most one PENDING transfer per order is an application
   * rule, not a schema one, and a statement that closed "the" payment would leave a
   * second one live if that rule ever loosened. Returns what it moved, so the order's
   * audit row can say how many.
   *
   * Required transaction, for the reason `expireDue` gives: this is a durable write and
   * ADR-0028's quiesce gate lives in `DrizzleUnitOfWork.run`.
   */
  cancelPendingForOrder(
    scope: TenantContext,
    orderId: OrderId,
    now: Date,
    tx: unknown,
  ): Promise<readonly PaymentId[]>;

  /**
   * The CONFIRMED payment that settled one order, or null.
   *
   * For the lane that discovers, after the fact, that a paid order cannot be
   * delivered: it holds the operation and the service and has to find the money.
   * `settlementIsFunded` is what makes at most one exist — an order reaches a settled
   * state only through a confirmed payment, and `confirmAndSettle` is the one place
   * that happens.
   *
   * Null is a broken invariant rather than an ordinary case, and the caller treats it
   * as one: it declines to refund and leaves the operator's condition open, because
   * an order that says it was paid and has no payment is not a thing to move money
   * on. It is deliberately NOT an exception here — a read that threw would make the
   * absence of a row a 500 on every path that consults it.
   *
   * Newest first and one row, for the same reason `listForPayment` orders at all: a
   * rejected-then-reconfirmed history is possible, and the answer wanted is the
   * confirmation that is standing now.
   */
  findConfirmedForOrder(
    scope: TenantContext,
    orderId: OrderId,
    tx: unknown,
  ): Promise<PaymentRecord | null>;

  /**
   * Who a page of payments' customers are on Telegram (Payment File 02 §21, D7).
   *
   * One query for the page rather than one per row, for the Web Admin's list. A READ of
   * the customer row, never stored on the payment: a username changes, and the list
   * must show the one the customer has now.
   */
  customerIdentities(
    scope: TenantContext,
    customerIds: readonly UserId[],
    tx?: unknown,
  ): Promise<ReadonlyMap<UserId, PaymentCustomerIdentity>>;

  /**
   * How each of these payments' receipts left review (WP10 follow-up §5), DERIVED:
   * `CREDITED_TO_WALLET` when a `receipt_credits` row exists, `APPROVED` or `REJECTED` from
   * the state and the deciding administrator, and absent for everything that is not a
   * decided manual transfer holding a receipt. Read-only and unlocked.
   */
  receiptDispositions(
    scope: TenantContext,
    paymentIds: readonly PaymentId[],
    tx?: unknown,
  ): Promise<ReadonlyMap<PaymentId, ReceiptDisposition>>;

  /**
   * The reason an administrator REJECTED this payment (File 01 §7): its `resolution_note`,
   * for a payment FAILED by an administrator and not credited to the wallet. Null for
   * anything else, and for a rejection recorded before the reason was mandatory.
   */
  rejectionReasonFor(scope: TenantContext, paymentId: string, tx?: unknown): Promise<string | null>;
}

/** A customer as Telegram knows them, for the payment list. */
export interface PaymentCustomerIdentity {
  readonly telegramUserId: string;
  readonly username: string | null;
}
