import { and, asc, eq, getTableColumns, isNotNull, sql, type SQL } from 'drizzle-orm';
import { money } from '@nexa/contracts';
import type {
  CurrencyCode,
  PanelId,
  ProductAudience,
  ProductId,
  ProductStatus,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { panels, products } from '../../../../infrastructure/persistence/schema.js';
import type {
  PanelDirectory,
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
  async listCatalog(
    scope: TenantContext,
    limit: number,
    tx?: unknown,
  ): Promise<{ readonly items: readonly ProductRecord[]; readonly hasMore: boolean }> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(products)
      .where(
        and(
          eq(products.tenantId, tenantId),
          eq(products.status, 'ACTIVE'),
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
          sql`${products.audience} NOT IN ('HIDDEN', 'RESELLERS_ONLY')`,
          isNotNull(products.priceAmount),
          isNotNull(products.panelId),
        ),
      )
      .orderBy(asc(products.sortOrder), asc(products.createdAt), asc(products.id))
      .limit(limit + 1);

    return { items: rows.slice(0, limit).map(toRecord), hasMore: rows.length > limit };
  }
}

/** The draft's fields as columns. One place, so create and update cannot diverge. */
function columnsFor(draft: ProductDraft) {
  return {
    title: draft.title,
    description: draft.description,
    audience: draft.audience,
    sortOrder: draft.sortOrder,
    panelId: draft.panelId,
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
