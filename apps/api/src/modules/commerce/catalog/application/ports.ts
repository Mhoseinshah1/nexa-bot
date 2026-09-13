import type {
  Money,
  PanelId,
  ProductAudience,
  ProductId,
  ProductSpecification,
  ProductStatus,
  TenantContext,
} from '@nexa/contracts';

/**
 * A product row as the application layer sees it.
 *
 * The module is called `catalog` and not `products` because the permission
 * vocabulary frozen in `permissions.ts` is `catalog.view` / `catalog.edit`. A
 * `products` module governed by `catalog.*` permissions is the two-names-for-one-thing
 * defect `docs/phase4b-audit.md` opens by naming.
 */
export interface ProductRecord {
  readonly id: ProductId;
  readonly title: string;
  readonly description: string | null;
  readonly status: ProductStatus;
  readonly audience: ProductAudience;
  readonly sortOrder: number;
  /**
   * The panel a purchase is fulfilled on, or null while an operator is still
   * configuring it.
   *
   * Null is a real state rather than an error: `catalog.ts` says such a product is
   * "refused at order confirmation rather than at browse time, because the refusal
   * message an operator needs names the product".
   */
  readonly panelId: PanelId | null;
  readonly specification: ProductSpecification;
  /**
   * The price as ONE nullable value rather than two nullable columns.
   *
   * The table enforces `(price_amount IS NULL) = (price_currency IS NULL)`; this is
   * the same statement in the type system, so a half-price cannot be constructed in
   * the application either. `catalog.ts` records what the null means and it is not
   * "free": a product with no price is a product that cannot be sold.
   */
  readonly price: Money | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The admin list's cursor: `(createdAt, id)`, and deliberately NOT `sortOrder`.
 *
 * `sortOrder` is what an operator drags to re-order a catalogue, so a keyset built on
 * it is a keyset on a mutable column — the exact defect migration 0026 retired for
 * panels, where "a keyset on an editable name could not order a stable traversal".
 * Re-ordering mid-traversal would then skip or repeat products.
 *
 * So the admin list traverses the immutable key and shows `sortOrder` as a column, the
 * same shape `/users` and `/panels` already use. The CUSTOMER catalogue is the surface
 * that genuinely reads in `sortOrder` order, and it is a bounded single page rather
 * than a traversal for precisely this reason — see `CatalogQuery`.
 *
 * This is `KeysetPosition` from `surfaces/web/keyset-cursor.ts` structurally. It is
 * restated here rather than imported because the application layer does not depend on
 * a surface; the controller converts.
 */
export interface ProductCursor {
  /** PostgreSQL's own microsecond text, never a `Date`. See `CustomerCursor`. */
  readonly createdAt: string;
  readonly id: ProductId;
}

export interface ProductPage {
  readonly items: readonly ProductRecord[];
  readonly nextCursor: ProductCursor | null;
}

/** How an operator narrowed the product list. */
export interface ProductSearch {
  readonly status?: ProductStatus;
  readonly audience?: ProductAudience;
  /** Case-insensitive prefix on the title, the same shape the customer search uses. */
  readonly titlePrefix?: string;
}

/**
 * The fields an operator may set when creating a product.
 *
 * `status` is absent on purpose: the column defaults to `INACTIVE` and a product
 * becomes purchasable through the state change, never as a side effect of creation.
 * An operator who could create an already-ACTIVE product could publish an unpriced,
 * unfulfillable plan in one step.
 */
export interface ProductDraft {
  readonly title: string;
  readonly description: string | null;
  readonly audience: ProductAudience;
  readonly sortOrder: number;
  readonly panelId: PanelId | null;
  readonly specification: ProductSpecification;
  readonly price: Money | null;
}

/**
 * The fields an edit may change.
 *
 * Every one is mutable by design, and every one is snapshotted onto an order at
 * confirmation — which is what makes editing safe. `status` is not here; it moves
 * through `setStatus` so the change is a conditional write with its own audit action.
 */
export type ProductEdit = ProductDraft;

export interface ProductRepository {
  create(
    scope: TenantContext,
    input: { readonly id: ProductId; readonly draft: ProductDraft; readonly now: Date },
    tx?: unknown,
  ): Promise<ProductRecord>;

  findById(scope: TenantContext, id: ProductId, tx?: unknown): Promise<ProductRecord | null>;

  list(
    scope: TenantContext,
    search: ProductSearch,
    limit: number,
    cursor: ProductCursor | null,
    tx?: unknown,
  ): Promise<ProductPage>;

  /** Returns the updated row, or null when the id names no product in this tenant. */
  update(
    scope: TenantContext,
    id: ProductId,
    edit: ProductEdit,
    now: Date,
    tx?: unknown,
  ): Promise<ProductRecord | null>;

  /**
   * Moves the status, and reports whether the row actually moved.
   *
   * A conditional `UPDATE … WHERE status = from`, the same mechanism
   * `CustomerRepository.setStatus` uses and for the same three reasons: a replay, a
   * double-click and two replicas all produce one change. `false` means the product
   * was already in the target state, which is a successful no-op rather than a failure.
   */
  setStatus(
    scope: TenantContext,
    id: ProductId,
    from: ProductStatus,
    to: ProductStatus,
    now: Date,
    tx?: unknown,
  ): Promise<boolean>;

  /**
   * The customer-visible catalogue, in `sortOrder, createdAt, id` order.
   *
   * A BOUNDED page rather than a traversal, and the bound is the point. The ordering
   * an operator curates is `sortOrder`, which is mutable, so a cursor over it would be
   * the unstable-traversal defect above. A catalogue read in a chat window is small and
   * finite; when it is not, the caller is told there are more rather than handed a
   * cursor that can skip a product.
   *
   * Membership is the four-part rule `bot.catalog.empty`'s frozen description states —
   * listed, priced, fulfillable — and it is applied in SQL so that a product that
   * fails it never leaves the database.
   */
  listCatalog(
    scope: TenantContext,
    limit: number,
    tx?: unknown,
  ): Promise<{ readonly items: readonly ProductRecord[]; readonly hasMore: boolean }>;
}
