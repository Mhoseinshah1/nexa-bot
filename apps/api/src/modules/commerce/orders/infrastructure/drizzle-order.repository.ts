import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { money, priceQuoteWireSchema, type ListSearchTerm, type PriceQuote } from '@nexa/contracts';
import { priceQuoteToWire } from '../application/order-pricing.js';
import type {
  CurrencyCode,
  OrderId,
  OrderPurpose,
  OrderState,
  PanelId,
  ProductCategoryId,
  ProductId,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { orders, products } from '../../../../infrastructure/persistence/schema.js';
import {
  customerIdsWithTelegramId,
  customerIdsWithUsernamePrefix,
  escapeLike,
  lowerPrefix,
  readCustomerIdentities,
} from '../../../../infrastructure/persistence/list-search.js';
import type {
  OrderCursor,
  OrderCustomerIdentity,
  OrderDraft,
  OrderPage,
  OrderRecord,
  OrderRepository,
  OrderSearch,
  OrderTotalsRecord,
} from '../application/ports.js';

/**
 * Orders, in PostgreSQL.
 *
 * Every query carries `eq(orders.tenantId, …)`, primary-key lookups included, for the
 * reason the customer and product repositories both state: a lookup without the tenant
 * returns another tenant's row and leaves the caller holding something it should never
 * have seen.
 */
export class DrizzleOrderRepository implements OrderRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  /**
   * Writes the DRAFT, snapshot and all.
   *
   * `state` is `'DRAFT'` and not a parameter — the same reasoning as a product being
   * created INACTIVE. An order comes into existence as an intention; reaching
   * `AWAITING_PAYMENT` is a transition with its own guard, and making the initial state
   * an argument is what would let one call create an order that already owes money.
   */
  async create(scope: TenantContext, draft: OrderDraft, tx?: unknown): Promise<OrderRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(orders)
      .values({
        id: draft.id,
        tenantId,
        customerId: draft.customerId,
        state: 'DRAFT',
        // `NEW_SERVICE` when the caller did not say, which is what the column defaults
        // to. Stated here so the ordinary purchase path reads as a decision rather than
        // as an omission somebody has to look up.
        purpose: draft.purpose ?? 'NEW_SERVICE',
        productId: draft.line.productId,
        panelId: draft.line.panelId,
        lineTitle: draft.line.title,
        /*
         * The category, COPIED into three columns rather than referenced.
         *
         * Nullable, and a null here is UNKNOWN rather than "uncategorised": the columns
         * exist from migration 0097 and were deliberately not backfilled, so every order
         * older than this release carries three nulls and must be RENDERED as unknown.
         * A read-time join to the product's current category would turn that absence
         * into a fabricated fact, which is exactly what the owner's instruction forbids.
         */
        lineCategoryId: draft.line.category?.categoryId ?? null,
        lineCategoryName: draft.line.category?.name ?? null,
        lineCategoryEmoji: draft.line.category?.emoji ?? null,
        lineDurationDays: draft.line.specification.durationDays,
        lineDurationHours: draft.line.durationHours ?? null,
        lineTrafficBytes: draft.line.specification.trafficBytes,
        lineDeviceLimit: draft.line.specification.deviceLimit,
        lineUnitPriceAmount: draft.line.unitPrice.amountMinor,
        lineQuantity: draft.line.quantity,
        subtotalAmount: draft.totals.subtotal.amountMinor,
        discountAmount: draft.totals.discount.amountMinor,
        totalAmount: draft.totals.total.amountMinor,
        currency: draft.totals.currency,
        quote: priceQuoteToWire(draft.totals.quote),
        expiresAt: draft.expiresAt,
        createdAt: draft.now,
        updatedAt: draft.now,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('orders insert returned no row.');
    return toRecord(row);
  }

  async findById(scope: TenantContext, id: OrderId, tx?: unknown): Promise<OrderRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /**
   * `SELECT ... FOR UPDATE` on the order, and nothing else.
   *
   * The id alone, not the row: every caller already has the record and wants the
   * LOCK. Selecting the columns would invite a reader to use this as a locking read
   * and then act on a snapshot that the lock does not actually make current — the
   * conditional UPDATE naming its `from` state is still what decides.
   */
  async lock(scope: TenantContext, id: OrderId, tx: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.id, id)))
      .for('update')
      .limit(1);
    return rows.length === 1;
  }

  /** One page, by keyset on `(created_at, id)` — both immutable, unlike `state`. */
  async list(
    scope: TenantContext,
    search: OrderSearch,
    limit: number,
    cursor: OrderCursor | null,
    tx?: unknown,
  ): Promise<OrderPage> {
    const productIds =
      search.text?.kind === 'TEXT'
        ? await this.productIdsTitled(scope, search.text.folded, tx)
        : [];
    const rows = await this.listStatement(scope, search, limit, cursor, tx, productIds);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toRecord),
      nextCursor:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAtText, id: last.id as OrderId }
          : null,
    };
  }

  /**
   * The ids of this tenant's products whose CURRENT title contains the text: the
   * product-name arm of the search box, resolved BEFORE the page statement.
   *
   * An infix match, and the one this search makes, because it runs over the catalogue —
   * tens of rows per tenant — and never over `orders`. Resolved as its own statement
   * rather than as an `ARRAY(SELECT …)` InitPlan inside the page query, and that was
   * measured, not assumed: the planner cannot see an InitPlan's result when it plans, so
   * it guessed the product arm unselective and walked `orders_tenant_created_idx`,
   * discarding 19 980 of 20 000 rows to find a product on one order in a thousand
   * (`list-search-plan.test.ts`). With the ids as literals it estimates them, and reads
   * `orders_tenant_product_created_idx`.
   */
  async productIdsTitled(
    scope: TenantContext,
    folded: string,
    tx?: unknown,
  ): Promise<readonly string[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.tenantId, tenantId),
          sql`lower(${products.title}) like ${`%${escapeLike(folded)}%`}`,
        ),
      );
    return rows.map((row) => row.id);
  }

  /**
   * Exposed so a plan regression can explain the statement production actually sends.
   * `productIds` is `productIdsTitled`'s answer for a text search, and empty otherwise.
   */
  listStatement(
    scope: TenantContext,
    search: OrderSearch,
    limit: number,
    cursor: OrderCursor | null,
    tx?: unknown,
    productIds: readonly string[] = [],
  ) {
    const tenantId = requireTenantId(scope);
    const conditions: SQL[] = [eq(orders.tenantId, tenantId)];

    if (search.state !== undefined) conditions.push(eq(orders.state, search.state));
    if (search.customerId !== undefined) conditions.push(eq(orders.customerId, search.customerId));
    if (search.productId !== undefined) conditions.push(eq(orders.productId, search.productId));
    if (search.text !== undefined) {
      conditions.push(orderTextCondition(tenantId, search.text, productIds));
    }
    if (cursor !== null) {
      conditions.push(
        sql`(${orders.createdAt}, ${orders.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }

    return this.exec(tx)
      .select({
        ...getTableColumns(orders),
        createdAtText: sql<string>`to_char(${orders.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(orders)
      .where(and(...conditions))
      .orderBy(asc(orders.createdAt), asc(orders.id))
      .limit(limit + 1);
  }

  async customerIdentities(
    scope: TenantContext,
    customerIds: readonly UserId[],
    tx?: unknown,
  ): Promise<ReadonlyMap<UserId, OrderCustomerIdentity>> {
    // The one shared reader (spec §10), so every list names a customer the same way.
    return (await readCustomerIdentities(
      this.exec(tx),
      requireTenantId(scope),
      customerIds,
    )) as ReadonlyMap<UserId, OrderCustomerIdentity>;
  }

  /**
   * A conditional UPDATE naming the state it expects to find.
   *
   * `WHERE state = from` is the entire concurrency story: two confirmations of one
   * draft, a replayed webhook and two replicas all produce exactly one transition and
   * one `true`, without a lock and without a read-then-write window. ADR-0028 records
   * the same mechanism for recovery, and states why there is no `setState` taking only
   * a target — that convenience would remove the guarantee from every caller at once.
   *
   * `confirmedAt` and `settledAt` are written by the SAME statement, because
   * `orders_settled_at_check` and its siblings bind each timestamp to its state:
   * moving the state in one statement and stamping the time in another opens a window
   * in which the row violates its own constraint. A SETTLE that moved the state
   * without `settled_at` would simply be refused by the database.
   */
  async transition(
    scope: TenantContext,
    id: OrderId,
    from: OrderState,
    to: OrderState,
    stamps: {
      readonly confirmedAt?: Date;
      readonly settledAt?: Date;
      readonly cancelledAt?: Date;
      readonly refundedAt?: Date;
    },
    now: Date,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(orders)
      .set({
        state: to,
        ...(stamps.confirmedAt === undefined ? {} : { confirmedAt: stamps.confirmedAt }),
        ...(stamps.settledAt === undefined ? {} : { settledAt: stamps.settledAt }),
        ...(stamps.cancelledAt === undefined ? {} : { cancelledAt: stamps.cancelledAt }),
        ...(stamps.refundedAt === undefined ? {} : { refundedAt: stamps.refundedAt }),
        updatedAt: now,
      })
      .where(and(eq(orders.tenantId, tenantId), eq(orders.id, id), eq(orders.state, from)))
      .returning({ id: orders.id });
    return rows.length > 0;
  }

  /**
   * The `EXPIRE` edge from `AWAITING_PAYMENT`, as a bounded set. The sweep's half.
   *
   * Two statements and `FOR UPDATE SKIP LOCKED`, exactly as
   * `PaymentRepository.expireDue` and `ServiceRepository.expireDue`: the sub-select
   * finds the candidates and the UPDATE re-checks every predicate after the row lock
   * is granted, because a scan can find a row another writer is about to move.
   *
   * `NO_CONFIRMED_PAYMENT` is REDUNDANT and kept deliberately. A confirmation settles
   * its order to PAID inside the same transaction, so a row that still reads
   * `AWAITING_PAYMENT` cannot have one — today. What it guards against is the day a
   * second path confirms a payment, because the failure mode is not a stale row: it is
   * an order somebody PAID FOR marked expired, and this installation then owing a
   * service it has no record of owing. A redundant predicate is cheap; that is not.
   */
  async expireDue(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: unknown,
  ): Promise<readonly OrderRecord[]> {
    const tenantId = requireTenantId(scope);
    if (limit <= 0) return [];

    const noConfirmedPayment = sql`NOT EXISTS (
      SELECT 1 FROM payments settled
       WHERE settled.tenant_id = ${orders.tenantId}
         AND settled.order_id = ${orders.id}
         AND settled.state = 'CONFIRMED'
    )`;

    /*
     * An order with a payment still live is NOT expired, and this is what makes the
     * sweep's stated ordering true rather than nearly true.
     *
     * `PaymentExpiryService` runs the payment half first and says the point of that is
     * that a tick which hits its bound leaves an order with a live payment — the
     * harmless half-state — rather than an expired order with a live instruction to
     * send money for it. The two halves are separately bounded and separately ordered,
     * so without this predicate that sentence is false exactly when it matters: four
     * hundred orders due at one midnight, two hundred payments moved by payment id and
     * two hundred orders moved by order id, and the overlap is chance.
     *
     * The customer on the wrong side of that holds bank instructions for an order that
     * no longer exists, and if they transfer, nobody can record it —
     * `confirmManualTransfer` requires the order to be AWAITING_PAYMENT and
     * `OPERATOR_MAY_CONFIRM_LATE` exempts the deadline, not the state.
     *
     * It costs nothing in the ordinary case: the payment half has already run in this
     * transaction and a payment's deadline is never later than its order's, so the only
     * PENDING payments left on a due order are the ones the bound skipped. This is the
     * one predicate here that is NOT redundant.
     */
    /*
     * `UNKNOWN` is live too (TonPays Telegram, §9.6.3 f): a payment whose provider review
     * ended unresolved is money very probably sent, waiting for an operator to reconcile it,
     * and a reconciled confirmation needs its order still AWAITING_PAYMENT. Expiring the
     * order would release its username hold and leave that confirmation nothing to settle.
     * Nothing else produces `UNKNOWN`, so every other route is unchanged.
     */
    const noLivePayment = sql`NOT EXISTS (
      SELECT 1 FROM payments live
       WHERE live.tenant_id = ${orders.tenantId}
         AND live.order_id = ${orders.id}
         AND live.state IN ('PENDING', 'UNKNOWN')
    )`;

    const due = this.exec(tx)
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.state, 'AWAITING_PAYMENT'),
          isNotNull(orders.expiresAt),
          lte(orders.expiresAt, now),
          noConfirmedPayment,
          noLivePayment,
        ),
      )
      .orderBy(asc(orders.expiresAt), asc(orders.id))
      .limit(limit)
      .for('update', { skipLocked: true });

    const rows = await this.exec(tx)
      .update(orders)
      .set({
        state: 'EXPIRED',
        /*
         * No timestamp. `orders` has `cancelled_at`, `settled_at` and `refunded_at` and
         * deliberately no `expired_at`, so `orders_cancelled_at_check` and its siblings
         * have nothing to say about this transition — which is why EXPIRE has always
         * been representable through `transition` while CANCEL was not.
         */
        updatedAt: now,
      })
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.state, 'AWAITING_PAYMENT'),
          isNotNull(orders.expiresAt),
          lte(orders.expiresAt, now),
          noConfirmedPayment,
          noLivePayment,
          sql`${orders.id} IN ${due}`,
        ),
      )
      .returning();

    return rows.map(toRecord);
  }

  async reprice(
    scope: TenantContext,
    id: OrderId,
    input: { readonly totals: OrderTotalsRecord; readonly discountCode: string | null },
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(orders)
      .set({
        subtotalAmount: input.totals.subtotal.amountMinor,
        discountAmount: input.totals.discount.amountMinor,
        totalAmount: input.totals.total.amountMinor,
        quote: priceQuoteToWire(input.totals.quote),
        discountCode: input.discountCode,
        updatedAt: now,
      })
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.id, id),
          eq(orders.state, 'DRAFT'),
          isNull(orders.confirmedAt),
        ),
      )
      .returning({ id: orders.id });
    return rows.length === 1;
  }
}

/**
 * The stored quote, parsed rather than cast.
 *
 * A `jsonb` column is the one place a document can come back malformed with nothing
 * having been wrong at write time — a restore, a hand-edit, an older writer. A cast
 * would turn that into a total rendered from `undefined`; the parse turns it into a
 * refusal naming the order.
 */
function quoteFromJson(raw: unknown, orderId: string): PriceQuote {
  const parsed = priceQuoteWireSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Order ${orderId} carries a quote that is not a quote.`);
  }
  const wire = parsed.data;
  return {
    productId: wire.productId as ProductId | null,
    quotedAt: wire.quotedAt,
    currency: wire.currency,
    finalAmount: money(BigInt(wire.finalAmount.amountMinor), wire.finalAmount.currency),
    trace: wire.trace.map((step) => ({
      step: step.step,
      effect: step.effect,
      ruleId: step.ruleId,
      ruleLabel: step.ruleLabel,
      amountBefore: money(BigInt(step.amountBefore.amountMinor), step.amountBefore.currency),
      amountAfter: money(BigInt(step.amountAfter.amountMinor), step.amountAfter.currency),
    })),
    ...(wire.cashback === undefined
      ? {}
      : {
          cashback: {
            ruleId: wire.cashback.ruleId,
            ruleLabel: wire.cashback.ruleLabel,
            percent: wire.cashback.percent,
            amount: money(BigInt(wire.cashback.amount.amountMinor), wire.cashback.amount.currency),
          },
        }),
  };
}

function toRecord(row: typeof orders.$inferSelect): OrderRecord {
  const currency = row.currency as CurrencyCode;
  return {
    id: row.id as OrderId,
    customerId: row.customerId as UserId,
    state: row.state as OrderState,
    purpose: row.purpose as OrderPurpose,
    line: {
      productId: row.productId as ProductId | null,
      panelId: row.panelId as PanelId,
      title: row.lineTitle,
      /*
       * Rebuilt only when the id is there. A row with an id and no name cannot occur —
       * all three are written together — so the name is asserted rather than defaulted:
       * a `?? ''` would turn a schema violation into a category with a blank label that
       * somebody would later "fix" by joining to the product.
       */
      category:
        row.lineCategoryId === null
          ? null
          : {
              categoryId: row.lineCategoryId as ProductCategoryId,
              name: row.lineCategoryName as string,
              emoji: row.lineCategoryEmoji,
            },
      specification: {
        durationDays: row.lineDurationDays,
        trafficBytes: row.lineTrafficBytes,
        deviceLimit: row.lineDeviceLimit,
      },
      durationHours: row.lineDurationHours,
      unitPrice: money(row.lineUnitPriceAmount, currency),
      quantity: row.lineQuantity,
    },
    totals: {
      subtotal: money(row.subtotalAmount, currency),
      discount: money(row.discountAmount, currency),
      total: money(row.totalAmount, currency),
      currency,
      quote: quoteFromJson(row.quote, row.id),
    },
    discountCode: row.discountCode,
    expiresAt: row.expiresAt,
    confirmedAt: row.confirmedAt,
    settledAt: row.settledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The order list's one search box (spec §10), with an index behind every arm so an `OR` of
 * them is a BitmapOr rather than a walk of the tenant's orders:
 *
 * - a Telegram id / `@username` — the customer's ids, resolved ONCE as an InitPlan (see
 *   `customerIdsWithTelegramId`), then `orders_customer_created_idx`;
 * - a uuid — the primary key, `orders_customer_created_idx`, `orders_tenant_product_created_idx`;
 * - text — the SNAPSHOT title by prefix (`orders_tenant_line_title_idx`), which is what
 *   the customer bought even if the product was renamed since; OR a product whose CURRENT
 *   title contains the text. That one infix match is over `products`, a catalogue of tens
 *   of rows per tenant, resolved to ids first (`productIdsTitled`) and then served by the
 *   product index. It is never applied to `orders` itself, which grows with every sale.
 */
function orderTextCondition(
  tenantId: string,
  term: ListSearchTerm,
  productIds: readonly string[],
): SQL {
  switch (term.kind) {
    case 'TELEGRAM_ID':
      return sql`${orders.customerId} = ANY(${customerIdsWithTelegramId(tenantId, term.value)})`;
    case 'USERNAME':
      return sql`${orders.customerId} = ANY(${customerIdsWithUsernamePrefix(tenantId, term.value)})`;
    case 'UUID':
      return or(
        eq(orders.id, term.value),
        eq(orders.customerId, term.value),
        eq(orders.productId, term.value),
      ) as SQL;
    case 'TEXT': {
      const byTitle = lowerPrefix(sql`${orders.lineTitle}`, term.folded);
      return productIds.length === 0
        ? byTitle
        : (or(byTitle, inArray(orders.productId, [...productIds])) as SQL);
    }
  }
}
