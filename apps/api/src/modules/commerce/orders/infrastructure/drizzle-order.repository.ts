import { and, asc, eq, getTableColumns, sql, type SQL } from 'drizzle-orm';
import { money, priceQuoteWireSchema, type PriceQuote, type PriceQuoteWire } from '@nexa/contracts';
import type {
  CurrencyCode,
  OrderId,
  OrderState,
  PanelId,
  ProductId,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { orders } from '../../../../infrastructure/persistence/schema.js';
import type {
  OrderCursor,
  OrderDraft,
  OrderPage,
  OrderRecord,
  OrderRepository,
  OrderSearch,
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
        productId: draft.line.productId,
        panelId: draft.line.panelId,
        lineTitle: draft.line.title,
        lineDurationDays: draft.line.specification.durationDays,
        lineTrafficBytes: draft.line.specification.trafficBytes,
        lineDeviceLimit: draft.line.specification.deviceLimit,
        lineUnitPriceAmount: draft.line.unitPrice.amountMinor,
        lineQuantity: draft.line.quantity,
        subtotalAmount: draft.totals.subtotal.amountMinor,
        discountAmount: draft.totals.discount.amountMinor,
        totalAmount: draft.totals.total.amountMinor,
        currency: draft.totals.currency,
        quote: quoteToJson(draft.totals.quote),
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

  /** One page, by keyset on `(created_at, id)` — both immutable, unlike `state`. */
  async list(
    scope: TenantContext,
    search: OrderSearch,
    limit: number,
    cursor: OrderCursor | null,
    tx?: unknown,
  ): Promise<OrderPage> {
    const rows = await this.listStatement(scope, search, limit, cursor, tx);
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

  /** Exposed so a plan regression can explain the statement production actually sends. */
  listStatement(
    scope: TenantContext,
    search: OrderSearch,
    limit: number,
    cursor: OrderCursor | null,
    tx?: unknown,
  ) {
    const tenantId = requireTenantId(scope);
    const conditions: SQL[] = [eq(orders.tenantId, tenantId)];

    if (search.state !== undefined) conditions.push(eq(orders.state, search.state));
    if (search.customerId !== undefined) conditions.push(eq(orders.customerId, search.customerId));
    if (search.productId !== undefined) conditions.push(eq(orders.productId, search.productId));
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
    stamps: { readonly confirmedAt?: Date; readonly settledAt?: Date },
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
        updatedAt: now,
      })
      .where(and(eq(orders.tenantId, tenantId), eq(orders.id, id), eq(orders.state, from)))
      .returning({ id: orders.id });
    return rows.length > 0;
  }
}

/** The quote, with every amount as a decimal string. See `priceQuoteWireSchema`. */
function quoteToJson(quote: PriceQuote): PriceQuoteWire {
  return {
    productId: quote.productId,
    quotedAt: quote.quotedAt,
    currency: quote.currency,
    finalAmount: {
      amountMinor: quote.finalAmount.amountMinor.toString(),
      currency: quote.finalAmount.currency,
    },
    trace: quote.trace.map((step) => ({
      step: step.step,
      effect: step.effect,
      ruleId: step.ruleId,
      ruleLabel: step.ruleLabel,
      amountBefore: {
        amountMinor: step.amountBefore.amountMinor.toString(),
        currency: step.amountBefore.currency,
      },
      amountAfter: {
        amountMinor: step.amountAfter.amountMinor.toString(),
        currency: step.amountAfter.currency,
      },
    })),
  };
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
  };
}

function toRecord(row: typeof orders.$inferSelect): OrderRecord {
  const currency = row.currency as CurrencyCode;
  return {
    id: row.id as OrderId,
    customerId: row.customerId as UserId,
    state: row.state as OrderState,
    line: {
      productId: row.productId as ProductId,
      panelId: row.panelId as PanelId,
      title: row.lineTitle,
      specification: {
        durationDays: row.lineDurationDays,
        trafficBytes: row.lineTrafficBytes,
        deviceLimit: row.lineDeviceLimit,
      },
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
    expiresAt: row.expiresAt,
    confirmedAt: row.confirmedAt,
    settledAt: row.settledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
