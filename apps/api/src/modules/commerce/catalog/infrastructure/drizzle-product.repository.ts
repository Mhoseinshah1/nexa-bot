import { and, asc, eq, getTableColumns, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { money } from '@nexa/contracts';
import type {
  CurrencyCode,
  PanelId,
  ProductAudience,
  ProductCategoryId,
  ProductCategoryStatus,
  ProductCategoryVisibility,
  ProductId,
  ProductStatus,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  panels,
  productCategories,
  products,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  CatalogueAudience,
  CustomerPage,
  PanelDirectory,
  ProductCategoryDraft,
  ProductCategoryEdit,
  ProductCategoryListing,
  ProductCategoryRecord,
  ProductCategoryRepository,
  ProductCursor,
  ProductDraft,
  ProductEdit,
  ProductPage,
  ProductRecord,
  ProductRepository,
  ProductSearch,
} from '../application/ports.js';

/**
 * Products, in PostgreSQL.
 *
 * Every query carries `eq(products.tenantId, …)`, the primary-key lookups included, for
 * the reason `drizzle-customer.repository.ts` states: a primary-key lookup without the
 * tenant returns another tenant's row and leaves the caller to decide what to do with
 * something it should never have seen. Filtering in the query means the row never
 * leaves the database.
 */
/**
 * The audience half of "may a customer see this product", as SQL
 * (`docs/wp9-reseller-audit.md` R5, R6).
 *
 * A `CUSTOMER` never sees `HIDDEN` or `RESELLERS_ONLY`. A `RESELLER` sees `RESELLERS_ONLY`
 * too, narrowed to the products their tier grants — by product id or by the product's
 * category — and applied here, ahead of the LIMIT, for the reason every other predicate of
 * this catalogue is: a filter after a limit can be defeated by enough ineligible rows.
 */
function audienceClause(audience: CatalogueAudience): SQL {
  if (audience.kind === 'CUSTOMER') {
    return sql`${products.audience} NOT IN ('HIDDEN', 'RESELLERS_ONLY')`;
  }
  const listed = sql`${products.audience} <> 'HIDDEN'`;
  if (audience.productIds === 'ALL' || audience.categoryIds === 'ALL') return listed;
  return sql`(${listed} AND (${products.id} = ANY(${sql.param([...audience.productIds])}::uuid[])
    OR ${products.categoryId} = ANY(${sql.param([...audience.categoryIds])}::uuid[])))`;
}

export class DrizzleProductRepository implements ProductRepository {
  constructor(private readonly db: Database) {}

  /** `.tx`, not the handle — see `DrizzleCustomerRepository.exec` for what casting it cost. */
  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async create(
    scope: TenantContext,
    input: { readonly id: ProductId; readonly draft: ProductDraft; readonly now: Date },
    tx?: unknown,
  ): Promise<ProductRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(products)
      .values({
        id: input.id,
        tenantId,
        ...columnsFor(input.draft),
        /*
         * INACTIVE, and not a parameter.
         *
         * The column defaults to it, and this states it rather than relying on the
         * default so that the rule is visible where the row is made: a product becomes
         * purchasable through an explicit state change, never as a side effect of
         * creation. Otherwise one call could publish an unpriced, unfulfillable plan.
         */
        status: 'INACTIVE',
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('products insert returned no row.');
    return toRecord(row);
  }

  async findById(scope: TenantContext, id: ProductId, tx?: unknown): Promise<ProductRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /**
   * One page, by keyset on `(created_at, id)`.
   *
   * `limit + 1` rows are read and the extra discarded, so the page knows whether a next
   * one exists without a second COUNT. The cursor is compared as a ROW against the same
   * shape of index `customers` and `panels` use.
   *
   * NOT ordered by `sort_order`, deliberately: that column is what an operator drags,
   * and a keyset over a mutable column skips or repeats rows when it changes
   * mid-traversal — migration 0026's lesson. `sort_order` is a COLUMN in this list and
   * the ordering of the customer catalogue, which is a bounded page for that reason.
   */
  async list(
    scope: TenantContext,
    search: ProductSearch,
    limit: number,
    cursor: ProductCursor | null,
    tx?: unknown,
  ): Promise<ProductPage> {
    const rows = await this.listStatement(scope, search, limit, cursor, tx);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toRecord),
      nextCursor:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAtText, id: last.id as ProductId }
          : null,
    };
  }

  /** Exposed so a plan regression can explain the statement production actually sends. */
  listStatement(
    scope: TenantContext,
    search: ProductSearch,
    limit: number,
    cursor: ProductCursor | null,
    tx?: unknown,
  ) {
    const tenantId = requireTenantId(scope);
    const conditions: SQL[] = [eq(products.tenantId, tenantId)];

    if (search.status !== undefined) conditions.push(eq(products.status, search.status));
    if (search.audience !== undefined) conditions.push(eq(products.audience, search.audience));
    if (search.panelId !== undefined) conditions.push(eq(products.panelId, search.panelId));
    if (search.categoryId === 'UNCATEGORISED') {
      conditions.push(isNull(products.categoryId));
    } else if (search.categoryId !== undefined) {
      conditions.push(eq(products.categoryId, search.categoryId));
    }
    if (search.titlePrefix !== undefined && search.titlePrefix !== '') {
      // Escaped, so a title containing `%` or `_` matches no more than it spells.
      const needle = search.titlePrefix.toLowerCase().replace(/[\\%_]/g, '\\$&');
      conditions.push(sql`lower(${products.title}) like ${`${needle}%`}`);
    }
    if (cursor !== null) {
      conditions.push(
        sql`(${products.createdAt}, ${products.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }

    return this.exec(tx)
      .select({
        ...getTableColumns(products),
        createdAtText: sql<string>`to_char(${products.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(products)
      .where(and(...conditions))
      .orderBy(asc(products.createdAt), asc(products.id))
      .limit(limit + 1);
  }

  async update(
    scope: TenantContext,
    id: ProductId,
    edit: ProductEdit,
    now: Date,
    tx?: unknown,
  ): Promise<ProductRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(products)
      .set({ ...columnsFor(edit), updatedAt: now })
      .where(and(eq(products.tenantId, tenantId), eq(products.id, id)))
      .returning();
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /**
   * A conditional UPDATE naming the status it expects to find.
   *
   * `WHERE status = from` is the whole mechanism: two operators pressing the same
   * button, or one pressing it twice, produce one row change and one `false`. The
   * `false` is a successful no-op — the end state the operator asked for holds.
   */
  async setStatus(
    scope: TenantContext,
    id: ProductId,
    from: ProductStatus,
    to: ProductStatus,
    now: Date,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(products)
      .set({ status: to, updatedAt: now })
      .where(and(eq(products.tenantId, tenantId), eq(products.id, id), eq(products.status, from)))
      .returning({ id: products.id });
    return rows.length > 0;
  }

  /**
   * Moves a product into a category. Tenant-predicated, like every write here.
   *
   * `products_tenant_category_fk` is composite, so a category belonging to another
   * tenant is refused by the database even if this predicate were ever dropped. The
   * service takes the destination's row lock first, so the category named here is one
   * that still exists at commit rather than one that did when the request arrived.
   */
  async setCategory(
    scope: TenantContext,
    id: ProductId,
    categoryId: ProductCategoryId,
    now: Date,
    tx?: unknown,
  ): Promise<ProductRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .update(products)
      .set({ categoryId, updatedAt: now })
      .where(and(eq(products.tenantId, tenantId), eq(products.id, id)))
      .returning();
    return row === undefined ? null : toRecord(row);
  }

  /**
   * The customer catalogue: listed, priced, fulfillable — in SQL.
   *
   * The four predicates are the frozen description of `bot.catalog.empty`, applied in
   * the WHERE clause so a product that fails any of them never leaves the database.
   * Written out rather than routed through `isListed` because this runs in PostgreSQL;
   * `catalog-visibility.ts` holds the single TypeScript statement of the same rule and
   * a test asserts the two agree, which is what stops them drifting.
   *
   * `limit + 1` again, and the extra row becomes `hasMore` rather than a cursor: the
   * order is `sort_order` first and that column is mutable, so a cursor over it could
   * skip a product an operator re-ordered mid-browse. A catalogue is small and finite;
   * being told there are more is honest, and a cursor that silently drops one is not.
   */
  /**
   * The predicates a product must satisfy to be SHOWN to a customer, as SQL.
   *
   * Extracted so the two paged queries and `listCatalog` state the rule once. The
   * TypeScript twin is `isCustomerVisible`, and `catalog.test.ts` runs both over the
   * same matrix and asserts they agree — the duplication is deliberate and the test is
   * what stops it drifting.
   *
   * The category join is INNER, which is what makes an uncategorised product invisible
   * without a separate `IS NOT NULL`: a product whose category was deleted out from
   * under it simply has no row to match.
   */
  private customerVisibleProduct(
    tenantId: string,
    eligiblePanelIds: readonly string[],
    audience: CatalogueAudience,
  ): SQL {
    return and(
      eq(products.tenantId, tenantId),
      eq(products.status, 'ACTIVE'),
      sql`${products.panelId} = ANY(${sql.param([...eligiblePanelIds])}::uuid[])`,
      audienceClause(audience),
      isNotNull(products.priceAmount),
      isNotNull(products.panelId),
      /* The category's BOTH terms — browsing asks whether it is listed, not only sold. */
      eq(productCategories.status, 'ACTIVE'),
      eq(productCategories.visibility, 'VISIBLE'),
    ) as SQL;
  }

  /**
   * One PAGE of the categories a customer may browse, ordered `sort_order ASC, id ASC`.
   *
   * ## Emptiness is structural, not a second question
   *
   * A category appears only where an `EXISTS` finds at least one product that passes
   * `customerVisibleProduct` inside it. So "an empty category is never shown" is not a
   * rule this method applies — it is a property of the query's shape, and there is no
   * code path that could show an empty one by forgetting to check. A `LEFT JOIN` with a
   * count, or a filter over the returned page, would both have reintroduced the
   * possibility.
   *
   * ## Offset, and what it does not promise
   *
   * `sort_order` is what an operator drags, so it cannot be a cursor key — that is
   * migration 0026's defect and `ports.ts` records it for the admin list. The owner
   * therefore chose an OFFSET, accepting that a reorder during paging can move a row
   * across a boundary. Nothing here claims otherwise; see
   * `docs/wp5-categories-audit.md` §6.4.
   *
   * `limit + 1` rows are read and the extra discarded, so `hasMore` is a fact about the
   * data rather than an inference from a COUNT that was true a moment ago. Previous is
   * the caller's `page > 1` and needs no query at all.
   */
  async listCustomerCategories(
    scope: TenantContext,
    limit: number,
    offset: number,
    eligiblePanelIds: readonly string[],
    audience: CatalogueAudience,
    tx?: unknown,
  ): Promise<CustomerPage<ProductCategoryRecord>> {
    const tenantId = requireTenantId(scope);
    /* No eligible panel is no catalogue, answered without a round trip. */
    if (eligiblePanelIds.length === 0) return { items: [], hasMore: false };

    const rows = await this.exec(tx)
      .select(getTableColumns(productCategories))
      .from(productCategories)
      .where(
        and(
          eq(productCategories.tenantId, tenantId),
          eq(productCategories.status, 'ACTIVE'),
          eq(productCategories.visibility, 'VISIBLE'),
          sql`EXISTS (
            SELECT 1 FROM ${products}
            WHERE ${products.categoryId} = ${productCategories.id}
              AND ${products.tenantId} = ${productCategories.tenantId}
              AND ${products.status} = 'ACTIVE'
              AND ${audienceClause(audience)}
              AND ${products.priceAmount} IS NOT NULL
              AND ${products.panelId} IS NOT NULL
              AND ${products.panelId} = ANY(${sql.param([...eligiblePanelIds])}::uuid[])
          )`,
        ),
      )
      .orderBy(asc(productCategories.sortOrder), asc(productCategories.id))
      .limit(limit + 1)
      .offset(offset);

    return {
      items: rows.slice(0, limit).map(toCategoryRecord),
      hasMore: rows.length > limit,
    };
  }

  /**
   * One PAGE of the products inside one category, ordered `sort_order ASC, id ASC`.
   *
   * Every predicate is in this statement, before `LIMIT`/`OFFSET`: tenant, category,
   * the category's own status and visibility, the product's status and audience, panel
   * eligibility, price and panel presence. That ordering is the whole point and it has
   * a history — filtering a bounded result in memory emptied this shop three times, at
   * twenty, then a hundred, then five hundred, each "fix" only moving the threshold.
   *
   * The owner's instruction restates it for this query: never fetch a bounded page and
   * then filter in memory.
   */
  async listCustomerProductsInCategory(
    scope: TenantContext,
    categoryId: string,
    limit: number,
    offset: number,
    eligiblePanelIds: readonly string[],
    audience: CatalogueAudience,
    tx?: unknown,
  ): Promise<CustomerPage<ProductRecord>> {
    const tenantId = requireTenantId(scope);
    if (eligiblePanelIds.length === 0) return { items: [], hasMore: false };

    const rows = await this.exec(tx)
      .select(getTableColumns(products))
      .from(products)
      .innerJoin(
        productCategories,
        and(
          eq(productCategories.id, products.categoryId),
          eq(productCategories.tenantId, products.tenantId),
        ),
      )
      .where(
        and(
          this.customerVisibleProduct(tenantId, eligiblePanelIds, audience),
          eq(products.categoryId, categoryId),
        ),
      )
      .orderBy(asc(products.sortOrder), asc(products.id))
      .limit(limit + 1)
      .offset(offset);

    return { items: rows.slice(0, limit).map(toRecord), hasMore: rows.length > limit };
  }

  async listCatalog(
    scope: TenantContext,
    limit: number,
    eligiblePanelIds: readonly string[],
    audience: CatalogueAudience,
    tx?: unknown,
  ): Promise<{ readonly items: readonly ProductRecord[]; readonly hasMore: boolean }> {
    const tenantId = requireTenantId(scope);
    /*
     * No eligible panel means no catalogue, and saying so costs nothing.
     *
     * `= ANY(...)` over an empty array is a perfectly good `false`, so this is
     * not a correctness guard — it is the honest answer given without a round
     * trip: `hasMore` is false because there is nothing further to reach, not
     * because a bound was hit.
     */
    if (eligiblePanelIds.length === 0) return { items: [], hasMore: false };
    const rows = await this.exec(tx)
      .select()
      .from(products)
      .where(
        and(
          eq(products.tenantId, tenantId),
          eq(products.status, 'ACTIVE'),
          /*
           * The fleet filter, BEFORE the limit.
           *
           * This is the whole of the fix for the catalogue ceiling: the LIMIT now
           * applies to products that are already sellable, so the hundredth
           * ineligible product in front of an eligible one costs a row of index
           * scan rather than a customer-visible empty shop.
           *
           * ONE bind parameter, not one per panel. `inArray` expands to `IN ($1,
           * $2, ... $n)`, and n here is the tenant's whole eligible fleet — so a
           * large enough fleet stops being a slow query and becomes a FAILED one,
           * at PostgreSQL's 65535-parameter ceiling, with the catalogue empty and
           * nothing in the shop to explain it. An array bound once and cast to
           * `uuid[]` is a single parameter whatever the fleet size, and the planner
           * still uses the index on `panel_id`.
           */
          sql`${products.panelId} = ANY(${sql.param([...eligiblePanelIds])}::uuid[])`,
          /*
           * Neither HIDDEN nor RESELLERS_ONLY.
           *
           * HIDDEN is the contract's own exclusion. RESELLERS_ONLY is OURS, and it
           * fails closed: `isListed` returns true for it because the contract expects
           * the caller to know whose catalogue this is, and Phase 4B has no reseller
           * identity to check against. Showing a reseller tier to every ordinary
           * customer is the price leak that exclusion exists to prevent.
           * `catalog-visibility.ts` states the same rule and the matrix test asserts
           * these two agree.
           */
          audienceClause(audience),
          isNotNull(products.priceAmount),
          isNotNull(products.panelId),
        ),
      )
      .orderBy(asc(products.sortOrder), asc(products.createdAt), asc(products.id))
      .limit(limit + 1);

    return { items: rows.slice(0, limit).map(toRecord), hasMore: rows.length > limit };
  }
}

/**
 * The draft's fields as columns. One place, so create and update cannot diverge.
 *
 * A `ProductEdit` whose `display` is null contributes NO display columns, so the UPDATE
 * leaves the row's own; a draft always carries one.
 */
function columnsFor(draft: ProductDraft | ProductEdit) {
  return {
    title: draft.title,
    description: draft.description,
    audience: draft.audience,
    sortOrder: draft.sortOrder,
    panelId: draft.panelId,
    /*
     * The category, and it is mapped HERE rather than at the two call sites.
     *
     * `create` and `update` both spread this function, so a field missing from it is a
     * field silently dropped on the way to the database — which is exactly what happened
     * when `categoryId` was added to `ProductDraft` and not to this map: the type system
     * was satisfied at every layer, the INSERT omitted the column, and every product
     * came back uncategorised. Twenty-seven integration tests failed with
     * `PRODUCT_NOT_CATEGORISED`, which was the new rule correctly refusing a row this
     * function had quietly made unsellable.
     */
    categoryId: draft.categoryId,
    durationDays: draft.specification.durationDays,
    trafficBytes: draft.specification.trafficBytes,
    deviceLimit: draft.specification.deviceLimit,
    /*
     * Both halves of the price, or both null.
     *
     * Written from ONE nullable value so the pair cannot be split here. The table's
     * `products_price_pair_check` says the same thing one layer down, and this is the
     * layer where a partial edit would otherwise construct the half-price it refuses.
     */
    priceAmount: draft.price === null ? null : draft.price.amountMinor,
    priceCurrency: draft.price === null ? null : draft.price.currency,
    /*
     * The display lists, as jsonb arrays of strings, in the operator's order.
     *
     * Copied rather than passed through so the driver serialises a plain array whatever
     * readonly wrapper the draft arrived in. Mapped HERE for the reason `categoryId`
     * gives above: a field missing from this function is a field the INSERT silently
     * omits, and these three would fall back to `'[]'` and NULL — every list an operator
     * typed written back as nothing, with no error anywhere.
     */
    ...(draft.display === null
      ? {}
      : {
          displayLocations: [...draft.display.displayLocations],
          displayFeatures: [...draft.display.displayFeatures],
          serviceLocationLabel: draft.display.serviceLocationLabel,
        }),
  };
}

/**
 * A jsonb display list, as an array of strings or not at all.
 *
 * `jsonb` carries no shape, so the column type is `unknown` and what came back is
 * checked rather than cast. A row that holds anything but an array of strings is
 * CORRUPT — nothing this repository writes can produce one — and it is refused rather
 * than coerced, because the alternative is a pre-invoice quietly rendering `[object
 * Object]` or `null` as a server location, which is a false claim to a customer with
 * no error anywhere to explain it. The refusal names the column so the operator who
 * meets it can find the row.
 */
function displayListOf(value: unknown, column: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`products.${column} is not a JSON array; the row is corrupted.`);
  }
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`products.${column} holds a non-string element; the row is corrupted.`);
    }
  }
  return value as readonly string[];
}

function toCategoryRecord(row: typeof productCategories.$inferSelect): ProductCategoryRecord {
  return {
    id: row.id as ProductCategoryId,
    name: row.name,
    description: row.description,
    emoji: row.emoji,
    status: row.status as ProductCategoryStatus,
    visibility: row.visibility as ProductCategoryVisibility,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRecord(row: typeof products.$inferSelect): ProductRecord {
  return {
    id: row.id as ProductId,
    title: row.title,
    description: row.description,
    status: row.status as ProductStatus,
    audience: row.audience as ProductAudience,
    sortOrder: row.sortOrder,
    panelId: row.panelId as PanelId | null,
    categoryId: row.categoryId as ProductCategoryId | null,
    specification: {
      durationDays: row.durationDays,
      trafficBytes: row.trafficBytes,
      deviceLimit: row.deviceLimit,
    },
    // The pair is reassembled as one value, so nothing downstream can read an amount
    // without its currency. The table guarantees the two are null together.
    price:
      row.priceAmount === null || row.priceCurrency === null
        ? null
        : money(row.priceAmount, row.priceCurrency as CurrencyCode),
    display: {
      displayLocations: displayListOf(row.displayLocations, 'display_locations'),
      displayFeatures: displayListOf(row.displayFeatures, 'display_features'),
      serviceLocationLabel: row.serviceLocationLabel,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * `PanelDirectory` over the `panels` table. One column, one predicate.
 *
 * It selects `panels.id` and nothing else — not the base URL, not a credential
 * timestamp, not the status — because the port's whole purpose is to keep the catalogue
 * module from acquiring a panel projection it would then be tempted to return.
 *
 * The tenant is in the WHERE clause, not checked afterwards, for the reason the
 * repository above states: a row that is not this tenant's never leaves the database,
 * so there is nothing to decide what to do with.
 *
 * ARCHIVED panels are deliberately still members. A product may point at a panel an
 * operator has retired: the catalogue's own fulfillable rule and the order path decide
 * whether such a product sells, and conflating "not yours" with "not usable right now"
 * here would give an operator a not-found for a panel they are looking straight at.
 */
export class DrizzlePanelDirectory implements PanelDirectory {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async existsInScope(scope: TenantContext, panelId: PanelId, tx?: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ id: panels.id })
      .from(panels)
      .where(and(eq(panels.tenantId, tenantId), eq(panels.id, panelId)))
      .limit(1);
    return rows.length > 0;
  }
}

/**
 * Categories, in PostgreSQL.
 *
 * The reads the order path needs and the writes an operator's surfaces perform. Every
 * one of them carries the tenant predicate, primary-key lookups included, for the reason
 * `DrizzleProductRepository` states above: a row filtered in the query never leaves the
 * database, and a row filtered afterwards has already been handed to code that must then
 * remember to throw it away.
 */
export class DrizzleProductCategoryRepository implements ProductCategoryRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  /**
   * Null in, null out — and the tenant predicate is carried even for a primary key.
   *
   * A primary-key lookup without the tenant returns another tenant's row and leaves the
   * caller holding something it should never have seen. Filtering in the query means it
   * never leaves the database, which is the same rule every other read here follows.
   */
  async findById(
    scope: TenantContext,
    id: ProductCategoryId | null,
    tx?: unknown,
  ): Promise<ProductCategoryRecord | null> {
    if (id === null) return null;
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select(getTableColumns(productCategories))
      .from(productCategories)
      .where(and(eq(productCategories.tenantId, tenantId), eq(productCategories.id, id)))
      .limit(1);
    return row === undefined ? null : toCategoryRecord(row);
  }

  /**
   * `INSERT … SELECT … WHERE NOT EXISTS`, in ONE statement.
   *
   * One statement rather than a read followed by a write, because the two-statement
   * form is a race: two installers, or an installer and an operator creating their
   * first category by hand, both see "none" and both insert. The conditional is
   * evaluated by the same statement that writes, under the caller's transaction.
   *
   * The predicate is "this tenant has ANY category", which is what makes it survive a
   * rename — see `ProductCategoryRepository.ensureDefault` for why that is the property
   * worth having rather than a name or id match.
   */
  async ensureDefault(
    scope: TenantContext,
    input: { readonly id: ProductCategoryId; readonly name: string; readonly now: Date },
    tx?: unknown,
  ): Promise<{ readonly created: boolean }> {
    const tenantId = requireTenantId(scope);
    /*
     * Raw SQL rather than the query builder, because `insert().select()` does not chain
     * a WHERE — and splitting this into a read then a write would reintroduce the race
     * it exists to avoid.
     *
     * `status`, `visibility` and `sort_order` are left to their column defaults
     * (`ACTIVE`, `VISIBLE`, `0`), which is where those decisions already live.
     */
    const result = (await this.exec(tx).execute(
      sql`
      INSERT INTO ${productCategories} (id, tenant_id, name, created_at, updated_at)
      SELECT ${input.id}::uuid, ${tenantId}::uuid, ${input.name}::text,
             ${input.now}::timestamptz, ${input.now}::timestamptz
      WHERE NOT EXISTS (
        SELECT 1 FROM ${productCategories} WHERE tenant_id = ${tenantId}::uuid
      )
      RETURNING id` as never,
    )) as unknown as { rows: readonly unknown[] };
    return { created: result.rows.length > 0 };
  }

  /**
   * Every category, in the operator's order, each with the number of products in it.
   *
   * A LEFT JOIN rather than a correlated subquery per row, and the join carries the
   * tenant on BOTH sides. `products.tenant_id = product_categories.tenant_id` looks
   * redundant next to the WHERE — it is not: without it the count would include another
   * tenant's products that name an id equal to one of this tenant's, which the composite
   * foreign key makes impossible today and which a future schema change could make
   * possible again. The predicate costs nothing and cannot rot.
   */
  async listForOperator(
    scope: TenantContext,
    tx?: unknown,
  ): Promise<readonly ProductCategoryListing[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({
        ...getTableColumns(productCategories),
        productCount: sql<number>`count(${products.id})::int`,
      })
      .from(productCategories)
      .leftJoin(
        products,
        and(
          eq(products.categoryId, productCategories.id),
          eq(products.tenantId, productCategories.tenantId),
        ),
      )
      .where(eq(productCategories.tenantId, tenantId))
      .groupBy(productCategories.id)
      .orderBy(asc(productCategories.sortOrder), asc(productCategories.id));
    return rows.map((row) => ({
      ...toCategoryRecord(row),
      productCount: Number(row.productCount),
    }));
  }

  async create(
    scope: TenantContext,
    input: {
      readonly id: ProductCategoryId;
      readonly draft: ProductCategoryDraft;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<ProductCategoryRecord> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .insert(productCategories)
      .values({
        id: input.id,
        tenantId,
        name: input.draft.name,
        description: input.draft.description,
        emoji: input.draft.emoji,
        sortOrder: input.draft.sortOrder,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
    if (row === undefined) throw new Error('insert returned no row');
    return toCategoryRecord(row);
  }

  async update(
    scope: TenantContext,
    id: ProductCategoryId,
    edit: ProductCategoryEdit,
    now: Date,
    tx?: unknown,
  ): Promise<ProductCategoryRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .update(productCategories)
      .set({
        name: edit.name,
        description: edit.description,
        emoji: edit.emoji,
        updatedAt: now,
      })
      .where(and(eq(productCategories.tenantId, tenantId), eq(productCategories.id, id)))
      .returning();
    return row === undefined ? null : toCategoryRecord(row);
  }

  /**
   * Conditional on the CURRENT status, so a replay and a race both write once.
   *
   * `eq(status, from)` in the WHERE is what makes this a transition rather than an
   * assignment. Two operators pressing Deactivate at the same moment produce one UPDATE
   * and one audit row; the loser gets null and its caller reads the row to find out it
   * was already there — a success that changed nothing, rather than a second transition
   * to the same place.
   */
  async setStatus(
    scope: TenantContext,
    id: ProductCategoryId,
    from: ProductCategoryStatus,
    to: ProductCategoryStatus,
    now: Date,
    tx?: unknown,
  ): Promise<ProductCategoryRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .update(productCategories)
      .set({ status: to, updatedAt: now })
      .where(
        and(
          eq(productCategories.tenantId, tenantId),
          eq(productCategories.id, id),
          eq(productCategories.status, from),
        ),
      )
      .returning();
    return row === undefined ? null : toCategoryRecord(row);
  }

  /** As `setStatus`, for visibility. The two are independent — audit §6.3. */
  async setVisibility(
    scope: TenantContext,
    id: ProductCategoryId,
    from: ProductCategoryVisibility,
    to: ProductCategoryVisibility,
    now: Date,
    tx?: unknown,
  ): Promise<ProductCategoryRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .update(productCategories)
      .set({ visibility: to, updatedAt: now })
      .where(
        and(
          eq(productCategories.tenantId, tenantId),
          eq(productCategories.id, id),
          eq(productCategories.visibility, from),
        ),
      )
      .returning();
    return row === undefined ? null : toCategoryRecord(row);
  }

  /**
   * One UPDATE for the whole new order, driven by a pair of arrays unnested and joined
   * on the id.
   *
   * One statement rather than N, because the order is a property of the SET and not of
   * any row in it. Applied one at a time, a concurrent reader between two of them sees
   * an arrangement no operator asked for — two categories at position 3, or a gap — and
   * a failure halfway leaves the tenant in one permanently.
   *
   * Two bind parameters rather than 2N, which is the shape R4-N4 settled on for panel
   * ids: a keyboard's worth of categories would otherwise be a statement whose parameter
   * count grows with the tenant's catalogue.
   *
   * `sql.param(array)` and NOT the bare array. Drizzle's template expands a bare JS array
   * into a parenthesised list — a ROW constructor — and PostgreSQL then refuses
   * `record::uuid[]`. The first version of this method did exactly that and would have
   * failed on every reorder; `product-categories.test.ts` is what found it.
   *
   * The tenant predicate is on the UPDATE, so an id belonging to somebody else matches
   * nothing and the returned count is short. The caller compares that count against what
   * it asked for rather than assuming success.
   */
  async reorder(
    scope: TenantContext,
    positions: readonly { readonly id: ProductCategoryId; readonly sortOrder: number }[],
    now: Date,
    tx?: unknown,
  ): Promise<number> {
    if (positions.length === 0) return 0;
    const tenantId = requireTenantId(scope);
    const result = (await this.exec(tx).execute(
      sql`
      UPDATE ${productCategories} AS c
      SET sort_order = w.sort_order, updated_at = ${now}::timestamptz
      FROM (
        SELECT unnest(${sql.param(positions.map((p) => p.id))}::uuid[]) AS id,
               unnest(${sql.param(positions.map((p) => p.sortOrder))}::integer[]) AS sort_order
      ) AS w
      WHERE c.id = w.id AND c.tenant_id = ${tenantId}::uuid
      RETURNING c.id` as never,
    )) as unknown as { rows: readonly unknown[] };
    return result.rows.length;
  }

  async countProducts(scope: TenantContext, id: ProductCategoryId, tx?: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select({ n: sql<number>`count(*)::int` })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.categoryId, id)));
    return Number(row?.n ?? 0);
  }

  async delete(scope: TenantContext, id: ProductCategoryId, tx?: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .delete(productCategories)
      .where(and(eq(productCategories.tenantId, tenantId), eq(productCategories.id, id)))
      .returning({ id: productCategories.id });
    return rows.length > 0;
  }

  /**
   * `SELECT … FOR UPDATE` on the category, so what is counted afterwards is what we
   * commit on.
   *
   * The delete path reads a product count and then deletes. Without the lock, a product
   * created into this category between the two makes the count a statement about a state
   * we are no longer in. The database's own foreign key catches that particular case —
   * but it catches it as a constraint violation, which is a 500 where the operator was
   * owed a sentence saying how many products are in the way.
   */
  async lock(scope: TenantContext, id: ProductCategoryId, tx: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select({ id: productCategories.id })
      .from(productCategories)
      .where(and(eq(productCategories.tenantId, tenantId), eq(productCategories.id, id)))
      .for('update')
      .limit(1);
    return row !== undefined;
  }

  /** `SELECT … FOR SHARE` on the category. See the port for why SHARE and not UPDATE. */
  async findForShare(
    scope: TenantContext,
    id: ProductCategoryId,
    tx: unknown,
  ): Promise<ProductCategoryRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select(getTableColumns(productCategories))
      .from(productCategories)
      .where(and(eq(productCategories.tenantId, tenantId), eq(productCategories.id, id)))
      .for('share')
      .limit(1);
    return row === undefined ? null : toCategoryRecord(row);
  }
}
