import type {
  CurrencyCode,
  Money,
  OrderId,
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
   * `confirmedAt` is written by the same statement, because
   * `orders_settled_at_check` and its siblings bind each timestamp to its state: a
   * transition that set one without the other would be refused by the database, which
   * is the point of having the constraint.
   */
  transition(
    scope: TenantContext,
    id: OrderId,
    from: OrderState,
    to: OrderState,
    stamps: { readonly confirmedAt?: Date },
    now: Date,
    tx?: unknown,
  ): Promise<boolean>;
}
