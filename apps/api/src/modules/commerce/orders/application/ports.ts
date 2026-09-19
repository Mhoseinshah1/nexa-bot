import type {
  CurrencyCode,
  Money,
  OrderId,
  OrderPurpose,
  OrderState,
  PanelId,
  PriceQuote,
  ProductId,
  ProductSpecification,
  TenantContext,
  UserId,
} from '@nexa/contracts';

/**
 * An order as the application layer sees it.
 *
 * `line` is the SNAPSHOT — what was bought, as it read when the order was made — and
 * `productId` inside it is navigation only. `commerce.ts` says so in terms: the
 * snapshot "is explicitly NOT how the purchase is reconstructed", because the product
 * may since have been renamed, re-priced, re-specified or withdrawn. The legacy
 * «محصول حذف‌شده» is what a report that joins on today's product row produces.
 */
export interface OrderLine {
  readonly productId: ProductId;
  readonly panelId: PanelId;
  readonly title: string;
  readonly specification: ProductSpecification;
  readonly unitPrice: Money;
  readonly quantity: number;
}

export interface OrderTotalsRecord {
  readonly subtotal: Money;
  readonly discount: Money;
  readonly total: Money;
  readonly currency: CurrencyCode;
  /** The full quote with its mandatory trace. A quote without one is not a quote. */
  readonly quote: PriceQuote;
}

export interface OrderRecord {
  readonly id: OrderId;
  readonly customerId: UserId;
  readonly state: OrderState;
  /**
   * What this order is FOR, and the column settlement dispatches on.
   *
   * `NEW_SERVICE` for the original purchase, which provisions. The other three act on
   * a service that already exists and provision nothing — `services.order_id` has said
   * since 4D that a renewal is a new order against the same service, and before this
   * column existed settlement had no way to tell the two apart.
   */
  readonly purpose: OrderPurpose;
  readonly line: OrderLine;
  readonly totals: OrderTotalsRecord;
  /**
   * The deadline, carried from DRAFT onward.
   *
   * On a DRAFT it is what stops a customer holding a stale price open for ever — the
   * confirmation refuses past it. On an `AWAITING_PAYMENT` order it is what the
   * expiry sweeper will read, and that sweeper is 4C's.
   */
  readonly expiresAt: Date | null;
  readonly confirmedAt: Date | null;
  /**
   * When the money arrived. Bound to the SETTLED states by
   * `orders_settled_at_check`, which since this release includes
   * `PAID_UNFULFILLED`: money that arrived is money that arrived, whether or not
   * anything could be created for it.
   */
  readonly settledAt: Date | null;
  /**
   * When the order was found unfulfillable, and why — retained even after a later
   * retry succeeds, because what went wrong once is what an operator reading the
   * order a week later needs. A `PanelEligibility` reason, never provider text.
   */
  readonly unfulfilledAt: Date | null;
  readonly unfulfilledReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The cursor for the admin order list: `(createdAt, id)`, both immutable. */
export interface OrderCursor {
  /** PostgreSQL's own microsecond text, never a `Date`. See `CustomerCursor`. */
  readonly createdAt: string;
  readonly id: OrderId;
}

export interface OrderPage {
  readonly items: readonly OrderRecord[];
  readonly nextCursor: OrderCursor | null;
}

/**
 * How an operator narrowed the order list.
 *
 * `customerId` and `productId` are exact; `state` is exact. There is deliberately no
 * free-text search: an order has no name, and the fields an operator actually quotes
 * from a support conversation are ids.
 */
export interface OrderSearch {
  readonly state?: OrderState;
  readonly customerId?: UserId;
  readonly productId?: ProductId;
}

/** Everything the DRAFT row carries at creation. Every field is a snapshot. */
export interface OrderDraft {
  readonly id: OrderId;
  readonly customerId: UserId;
  /**
   * Optional, and absent means `NEW_SERVICE`.
   *
   * The column defaults to it, so the ordinary purchase path needs no edit and the
   * release running beside this one during a rolling update writes what it always did.
   */
  readonly purpose?: OrderPurpose;
  readonly line: OrderLine;
  readonly totals: OrderTotalsRecord;
  readonly expiresAt: Date;
  readonly now: Date;
}

export interface OrderRepository {
  create(scope: TenantContext, draft: OrderDraft, tx?: unknown): Promise<OrderRecord>;

  findById(scope: TenantContext, id: OrderId, tx?: unknown): Promise<OrderRecord | null>;

  list(
    scope: TenantContext,
    search: OrderSearch,
    limit: number,
    cursor: OrderCursor | null,
    tx?: unknown,
  ): Promise<OrderPage>;

  /**
   * Moves an order between two states, and reports whether the row actually moved.
   *
   * A conditional `UPDATE … WHERE state = from`, which is the mechanism ADR-0028
   * records for recovery and `CustomerRepository.setStatus` uses for blocks: it makes a
   * replay, a double-click and two replicas all produce one transition without a lock.
   * There is no `setState` that takes only a target — that convenience is exactly what
   * would remove the guarantee from all three at once.
   *
   * `confirmedAt`, `settledAt` and `cancelledAt` are written by the same statement,
   * because `orders_settled_at_check` and its siblings bind each timestamp to its
   * state: a transition that set one without the other would be refused by the
   * database, which is the point of having the constraint. `settled_at` is the one 4C
   * adds a writer for — `(state = 'PAID' OR state = 'REFUNDED') = (settled_at IS NOT
   * NULL)`, so a SETTLE that moved the state alone could not commit.
   *
   * `cancelledAt` is 4G's, and until this release its absence made the `CANCEL` edge
   * of `ORDER_MACHINE` not merely uncalled but UNCALLABLE: `orders_cancelled_at_check`
   * is `(state = 'CANCELLED') = (cancelled_at IS NOT NULL)`, so the old signature could
   * name CANCELLED as its target and the statement would be refused every time.
   * `docs/phase4g-audit.md` records the measurement.
   *
   * There is deliberately no `expiredAt`. `orders` has no such column, so `EXPIRE` has
   * always been representable through this method unchanged — an asymmetry the schema
   * chose, and one this phase leaves alone rather than tidying a column into existence
   * that no constraint asks for.
   */
  transition(
    scope: TenantContext,
    id: OrderId,
    from: OrderState,
    to: OrderState,
    stamps: {
      readonly confirmedAt?: Date;
      readonly settledAt?: Date;
      readonly cancelledAt?: Date;
      /*
       * `PAID_UNFULFILLED`'s pair, and the ONLY writable stamps that survive the
       * state they were written for. `orders_unfulfilled_*_check` are implications
       * rather than equalities, so a later `FULFIL` moves the state and leaves both
       * standing — which is what makes "this order was stranded once" a fact an
       * operator can still read.
       */
      readonly unfulfilledAt?: Date;
      readonly unfulfilledReason?: string;
      /**
       * Where the order will be fulfilled, when an operator REASSIGNS it.
       *
       * The one edit to a line snapshot this codebase allows, and it is allowed
       * because the alternative is worse: an order with no service, on a panel that
       * cannot take it, and no way to move it but a refund. Only the `FULFIL` edge
       * passes it, and the audit row says the panel changed.
       */
      readonly panelId?: string;
    },
    now: Date,
    tx?: unknown,
  ): Promise<boolean>;

  /**
   * Expires the orders nobody paid for, bounded. The `EXPIRE` edge from
   * `AWAITING_PAYMENT`.
   *
   * `orders_expiry_idx` — `(expires_at) WHERE state = 'AWAITING_PAYMENT'` — has existed
   * since migration 0032 with no reader at all, and `docs/phase4g-audit.md` records
   * that as the finding it is: a partial index is a statement about a query somebody
   * meant to write. This is that query.
   *
   * `DRAFT` is deliberately NOT swept, although `ORDER_MACHINE` has that edge too. A
   * draft is a quote the customer never confirmed, nothing was promised for it and
   * `OrderService.confirm` already refuses one past its deadline; the index the schema
   * built covers exactly `AWAITING_PAYMENT`, and the owner's rule is about a payment
   * and the order it was against. Sweeping drafts is retention rather than correctness
   * and `docs/open-questions.md` carries it.
   *
   * Required transaction, bounded, returns what it moved — see
   * `PaymentRepository.expireDue` for all three reasons.
   */
  expireDue(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: unknown,
  ): Promise<readonly OrderRecord[]>;
}
