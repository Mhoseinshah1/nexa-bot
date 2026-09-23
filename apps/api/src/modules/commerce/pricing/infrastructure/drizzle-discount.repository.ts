import { and, asc, eq, getTableColumns, inArray, sql, type SQL } from 'drizzle-orm';
import { money } from '@nexa/contracts';
import type {
  CurrencyCode,
  DiscountKind,
  DiscountStatus,
  DiscountType,
  DiscountablePurpose,
  Money,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  discountRedemptions,
  discounts,
  orders,
} from '../../../../infrastructure/persistence/schema.js';
import type { DiscountUsage } from '../domain/pricing-engine.js';
import type {
  DiscountRepository,
  DiscountRuleRecord,
  DiscountRulePage,
  DiscountRuleSearch,
  DiscountRuleWrite,
  RedemptionRecord,
  RuleCursor,
} from '../application/ports.js';

/**
 * The states in which a redemption is LIVE (P6).
 *
 * A cancelled, expired or refunded order frees its use without anything having to run:
 * the count asks the ORDER, so there is no released-at column for a cancellation path
 * to forget to write. `DRAFT` is not here — a draft redeems nothing until it is
 * confirmed.
 */
const LIVE_ORDER_STATES = ['AWAITING_PAYMENT', 'PAID'] as const;

/**
 * Discount rules and their redemptions, in PostgreSQL.
 *
 * Every query carries the tenant, primary-key lookups included, for the reason every
 * repository here states: a lookup without it returns another tenant's row.
 */
export class DrizzleDiscountRepository implements DiscountRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async create(
    scope: TenantContext,
    id: string,
    write: DiscountRuleWrite,
    now: Date,
    tx?: unknown,
  ): Promise<DiscountRuleRecord | null> {
    const tenantId = requireTenantId(scope);
    /*
     * `ON CONFLICT DO NOTHING` on the code's unique index: two operators creating the
     * same code at once get one rule and one refusal, and neither gets a 23505. A NULL
     * code never conflicts — automatic rules have none, and NULLs are distinct.
     */
    const rows = await this.exec(tx)
      .insert(discounts)
      .values({
        id,
        tenantId,
        ...columnsOf(write),
        status: 'INACTIVE',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [discounts.tenantId, discounts.code] })
      .returning();
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async update(
    scope: TenantContext,
    id: string,
    write: DiscountRuleWrite,
    now: Date,
    tx?: unknown,
  ): Promise<DiscountRuleRecord | null> {
    const tenantId = requireTenantId(scope);
    // `kind` and `code` are never rewritten: the service refuses a change to either, and
    // this statement does not name them, so it could not make one by accident either.
    const { kind: _kind, code: _code, ...editable } = columnsOf(write);
    const rows = await this.exec(tx)
      .update(discounts)
      .set({ ...editable, updatedAt: now })
      .where(and(eq(discounts.tenantId, tenantId), eq(discounts.id, id)))
      .returning();
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async setStatus(
    scope: TenantContext,
    id: string,
    from: DiscountStatus,
    to: DiscountStatus,
    now: Date,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(discounts)
      .set({ status: to, updatedAt: now })
      .where(
        and(eq(discounts.tenantId, tenantId), eq(discounts.id, id), eq(discounts.status, from)),
      )
      .returning({ id: discounts.id });
    return rows.length === 1;
  }

  async findById(
    scope: TenantContext,
    id: string,
    tx?: unknown,
  ): Promise<DiscountRuleRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(discounts)
      .where(and(eq(discounts.tenantId, tenantId), eq(discounts.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findByCode(
    scope: TenantContext,
    code: string,
    tx?: unknown,
  ): Promise<DiscountRuleRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(discounts)
      .where(
        and(eq(discounts.tenantId, tenantId), eq(discounts.kind, 'CODE'), eq(discounts.code, code)),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async listLiveAutomatic(
    scope: TenantContext,
    tx?: unknown,
  ): Promise<readonly DiscountRuleRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(discounts)
      .where(
        and(
          eq(discounts.tenantId, tenantId),
          eq(discounts.kind, 'AUTOMATIC'),
          eq(discounts.status, 'ACTIVE'),
        ),
      )
      // Ordered for a stable read; the engine orders by precedence itself and never
      // trusts this order.
      .orderBy(asc(discounts.id));
    return rows.map(toRecord);
  }

  async list(
    scope: TenantContext,
    search: DiscountRuleSearch,
    limit: number,
    cursor: RuleCursor | null,
    tx?: unknown,
  ): Promise<DiscountRulePage> {
    const tenantId = requireTenantId(scope);
    const conditions: SQL[] = [eq(discounts.tenantId, tenantId)];
    if (search.kind !== undefined) conditions.push(eq(discounts.kind, search.kind));
    if (search.status !== undefined) conditions.push(eq(discounts.status, search.status));
    if (cursor !== null) {
      conditions.push(
        sql`(${discounts.createdAt}, ${discounts.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await this.exec(tx)
      .select({
        ...getTableColumns(discounts),
        createdAtText: sql<string>`to_char(${discounts.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(discounts)
      .where(and(...conditions))
      .orderBy(asc(discounts.createdAt), asc(discounts.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toRecord),
      nextCursor:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAtText, id: last.id }
          : null,
    };
  }

  async usage(
    scope: TenantContext,
    ruleIds: readonly string[],
    customerId: string | null,
    excludingOrderId: string | null,
    tx?: unknown,
  ): Promise<ReadonlyMap<string, DiscountUsage>> {
    const result = new Map<string, DiscountUsage>();
    if (ruleIds.length === 0) return result;
    const tenantId = requireTenantId(scope);
    const conditions: SQL[] = [
      eq(discountRedemptions.tenantId, tenantId),
      inArray(discountRedemptions.discountId, [...ruleIds]),
      inArray(orders.state, [...LIVE_ORDER_STATES]),
    ];
    if (excludingOrderId !== null) {
      conditions.push(sql`${discountRedemptions.orderId} <> ${excludingOrderId}::uuid`);
    }
    const forCustomer =
      customerId === null
        ? sql<number>`0`
        : sql<number>`count(*) FILTER (WHERE ${discountRedemptions.customerId} = ${customerId}::uuid)::int`;
    const rows = await this.exec(tx)
      .select({
        discountId: discountRedemptions.discountId,
        live: sql<number>`count(*)::int`,
        liveForCustomer: forCustomer,
      })
      .from(discountRedemptions)
      .innerJoin(
        orders,
        and(
          eq(orders.tenantId, discountRedemptions.tenantId),
          eq(orders.id, discountRedemptions.orderId),
        ),
      )
      .where(and(...conditions))
      .groupBy(discountRedemptions.discountId);
    for (const row of rows) {
      result.set(row.discountId, {
        live: Number(row.live),
        liveForCustomer: Number(row.liveForCustomer),
      });
    }
    return result;
  }

  async lockForRedemption(
    scope: TenantContext,
    ruleIds: readonly string[],
    tx: unknown,
  ): Promise<readonly DiscountRuleRecord[]> {
    if (ruleIds.length === 0) return [];
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(discounts)
      .where(and(eq(discounts.tenantId, tenantId), inArray(discounts.id, [...ruleIds])))
      .orderBy(asc(discounts.id))
      .for('update');
    return rows.map(toRecord);
  }

  async lockFirstPurchase(scope: TenantContext, customerId: string, tx: unknown): Promise<void> {
    const tenantId = requireTenantId(scope);
    // A key derived from the tenant AND the customer: the same customer id in another
    // tenant is another customer and must not queue behind this one.
    await this.exec(tx).execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`nexa:first-purchase:${tenantId}:${customerId}`}, 0))`,
    );
  }

  async isFirstPurchase(
    scope: TenantContext,
    customerId: string,
    excludingOrderId: string | null,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const conditions: SQL[] = [
      eq(orders.tenantId, tenantId),
      sql`${orders.customerId} = ${customerId}::uuid`,
      eq(orders.purpose, 'NEW_SERVICE'),
      inArray(orders.state, [...LIVE_ORDER_STATES]),
    ];
    if (excludingOrderId !== null) {
      conditions.push(sql`${orders.id} <> ${excludingOrderId}::uuid`);
    }
    const rows = await this.exec(tx)
      .select({ id: orders.id })
      .from(orders)
      .where(and(...conditions))
      .limit(1);
    return rows.length === 0;
  }

  async recordRedemption(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly discountId: string;
      readonly customerId: string;
      readonly orderId: string;
      readonly amount: Money;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(discountRedemptions)
      .values({
        id: input.id,
        tenantId,
        discountId: input.discountId,
        customerId: input.customerId,
        orderId: input.orderId,
        amount: input.amount.amountMinor,
        currency: input.amount.currency,
        createdAt: input.now,
      })
      .onConflictDoNothing({
        target: [
          discountRedemptions.tenantId,
          discountRedemptions.orderId,
          discountRedemptions.discountId,
        ],
      })
      .returning({ id: discountRedemptions.id });
    return rows.length === 1;
  }

  async redemptionsForOrder(
    scope: TenantContext,
    orderId: string,
    tx?: unknown,
  ): Promise<readonly RedemptionRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(discountRedemptions)
      .where(
        and(eq(discountRedemptions.tenantId, tenantId), eq(discountRedemptions.orderId, orderId)),
      )
      .orderBy(asc(discountRedemptions.createdAt), asc(discountRedemptions.id));
    return rows.map((row) => ({
      discountId: row.discountId,
      amount: money(row.amount, row.currency as CurrencyCode),
      createdAt: row.createdAt,
    }));
  }
}

function columnsOf(write: DiscountRuleWrite) {
  return {
    kind: write.kind,
    code: write.code,
    label: write.label,
    type: write.type,
    value: write.value,
    currency: write.currency,
    appliesTo: [...write.appliesTo],
    productId: write.productId,
    categoryId: write.categoryId,
    customerId: write.customerId,
    firstPurchaseOnly: write.firstPurchaseOnly,
    minimumSubtotalAmount: write.minimumSubtotal,
    startsAt: write.startsAt,
    endsAt: write.endsAt,
    totalRedemptionsLimit: write.totalLimit,
    perCustomerLimit: write.perCustomerLimit,
    priority: write.priority,
    stackable: write.stackable,
  };
}

function toRecord(row: typeof discounts.$inferSelect): DiscountRuleRecord {
  return {
    id: row.id,
    kind: row.kind as DiscountKind,
    code: row.code,
    label: row.label,
    type: row.type as DiscountType,
    value: row.value,
    currency: row.currency as CurrencyCode | null,
    appliesTo: row.appliesTo as DiscountablePurpose[],
    productId: row.productId,
    categoryId: row.categoryId,
    customerId: row.customerId,
    firstPurchaseOnly: row.firstPurchaseOnly,
    minimumSubtotal: row.minimumSubtotalAmount,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    totalLimit: row.totalRedemptionsLimit,
    perCustomerLimit: row.perCustomerLimit,
    priority: row.priority,
    stackable: row.stackable,
    status: row.status as DiscountStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
