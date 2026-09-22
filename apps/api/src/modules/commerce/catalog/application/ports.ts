import type {
  Money,
  PanelId,
  ProductAudience,
  ProductCategoryId,
  ProductCategoryStatus,
  ProductCategoryVisibility,
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
  /**
   * The category a customer browses this under, or null.
   *
   * Null is a real state and it is UNSELLABLE, unlike `panelId`'s null which is merely
   * unfulfillable-yet. Migration 0097 gave every existing product a category, so a null
   * here means an operator deleted an emptied category out from under a product, or a
   * path created one without a category. Either way it is refused at confirmation with
   * a reason naming which rule failed, rather than the product silently vanishing.
   */
  readonly categoryId: ProductCategoryId | null;
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
  /**
   * One panel's products.
   *
   * The operator's question on a panel detail page — what would stop selling if
   * this panel were disabled. A product with no panel is excluded by it rather
   * than matching everything, which is why it is an equality on the column and
   * not a `IS NULL OR =`.
   */
  readonly panelId?: PanelId;
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
  /** The category this product is filed under. Reassignment is an ordinary edit. */
  readonly categoryId: ProductCategoryId | null;
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

/**
 * "Is this panel one of MINE?" — the only question the catalogue asks about a panel.
 *
 * A NARROW port, deliberately. The catalogue module has no business reading a panel's
 * address, its credentials or its health; it needs to know that a `panelId` an operator
 * typed belongs to the tenant writing the product, and nothing else. Depending on
 * `PanelRepository` here would hand this module every panel field and make the
 * one-way credential rule (ADR-0023) one careless projection away from being broken.
 *
 * The DATABASE is the guarantee — `products_tenant_panel_fk`, migration 0037 — and this
 * is the good error. Without the constraint this check is a race; without this check the
 * constraint is a 500 with no field named. Both, and in that order of authority.
 *
 * Takes the transaction handle because it is read INSIDE the write, like every other
 * precondition on this path: a panel archived between the check and the commit must not
 * be the version the product is written against.
 */
export interface PanelDirectory {
  /**
   * True when this tenant owns a panel with this id.
   *
   * Membership only. An id belonging to another tenant is indistinguishable from an id
   * belonging to nobody, which is the point: an operator must not be able to probe
   * another installation's panel ids by watching which of two refusals comes back.
   */
  existsInScope(scope: TenantContext, panelId: PanelId, tx?: unknown): Promise<boolean>;
}

export interface ProductRepository {
  create(
    scope: TenantContext,
    input: { readonly id: ProductId; readonly draft: ProductDraft; readonly now: Date },
    tx?: unknown,
  ): Promise<ProductRecord>;

  findById(scope: TenantContext, id: ProductId, tx?: unknown): Promise<ProductRecord | null>;

  /**
   * One PAGE of the categories a customer may browse. See the implementation for why
   * emptiness is a property of the query's shape rather than a check it performs.
   */
  listCustomerCategories(
    scope: TenantContext,
    limit: number,
    offset: number,
    eligiblePanelIds: readonly string[],
    tx?: unknown,
  ): Promise<CustomerPage<ProductCategoryRecord>>;

  /** One PAGE of the products inside one category, every predicate applied in SQL. */
  listCustomerProductsInCategory(
    scope: TenantContext,
    categoryId: string,
    limit: number,
    offset: number,
    eligiblePanelIds: readonly string[],
    tx?: unknown,
  ): Promise<CustomerPage<ProductRecord>>;

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
    /**
     * The panels that may be sold onto right now — the fleet filter, applied in
     * the WHERE clause so it precedes the LIMIT.
     *
     * Passed IN rather than computed here, because deciding it means counting
     * services and unexpired holds, and a catalogue query that counted services
     * would be the second implementation of a rule `PanelSalesGate` already owns.
     * The caller reads it once from that evaluator and hands the ids over.
     *
     * Filtering after the limit instead is what put a correctness ceiling on the
     * catalogue: enough ineligible products in front of an eligible one emptied
     * the shop, and every widening of the scan only moved the number at which
     * that happened.
     */
    eligiblePanelIds: readonly string[],
    tx?: unknown,
  ): Promise<{ readonly items: readonly ProductRecord[]; readonly hasMore: boolean }>;
}

/**
 * A category row as the application layer sees it.
 *
 * `status` and `visibility` are the two dimensions `catalog.ts` explains, and they do
 * different things: status decides whether the products inside may be BOUGHT,
 * visibility only whether the category is LISTED. Nothing here caches how many products
 * it holds — `productCategories` in the schema says why a count would be a second
 * answer that goes stale the moment a product is deactivated.
 */
export interface ProductCategoryRecord {
  readonly id: ProductCategoryId;
  readonly name: string;
  readonly description: string | null;
  /** Optional. Absence is ordinary and renders as an ordinary category. */
  readonly emoji: string | null;
  readonly status: ProductCategoryStatus;
  readonly visibility: ProductCategoryVisibility;
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * One page of an OFFSET-paged customer list.
 *
 * `hasMore` is READ rather than computed: the query asks for `limit + 1` rows and
 * discards the extra, so "there is a next page" is a fact about the data instead of an
 * inference from a count. `hasPrevious` is the caller's `page > 1` and is not carried
 * here, because it is not a question about the data at all.
 *
 * There is deliberately no `total`. It would need a second COUNT over the same
 * predicates, it would be stale the instant it was read, and neither Next nor Previous
 * needs it to be shown truthfully. `docs/wp5-categories-audit.md` §6.4 records that this
 * offset is not snapshot-stable — an operator reordering while a customer pages can move
 * a row across a boundary — and a printed total would imply a stability it does not have.
 */
export interface CustomerPage<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
}

/**
 * Categories, as the application reads and writes them.
 *
 * Separate from `ProductRepository` because they are separate aggregates with separate
 * lifecycles — a category outlives the products filed under it, and deleting one is a
 * question about the products rather than about the category.
 *
 * `findById` takes a NULLABLE id and answers null for null. That is not laziness: every
 * caller holds `product.categoryId`, which is nullable by design, and making each of
 * them write the same guard is how one of them eventually forgets.
 */
export interface ProductCategoryRepository {
  findById(
    scope: TenantContext,
    id: ProductCategoryId | null,
    tx?: unknown,
  ): Promise<ProductCategoryRecord | null>;

  /**
   * Gives a tenant a first category IF it has none, and reports whether it wrote one.
   *
   * The idempotency key is "this tenant has at least one category", not the name and
   * not the id — which is what makes a rerun safe in the two ways that matter. An
   * installer that reruns after a later failure writes nothing the second time, and a
   * tenant whose operator has RENAMED the default keeps the rename, because the
   * predicate asks whether any category exists rather than whether one called
   * `DEFAULT_PRODUCT_CATEGORY_NAME` does.
   *
   * There is no unique index to lean on here — `(tenant_id, name)` is deliberately not
   * unique, since an operator may legitimately want two categories with similar names
   * — so the conditional is `WHERE NOT EXISTS`, taken inside the caller's transaction.
   */
  ensureDefault(
    scope: TenantContext,
    input: { readonly id: ProductCategoryId; readonly name: string; readonly now: Date },
    tx?: unknown,
  ): Promise<{ readonly created: boolean }>;
}
