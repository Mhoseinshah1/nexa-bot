import { and, asc, eq, getTableColumns, sql, type SQL } from 'drizzle-orm';
import { money } from '@nexa/contracts';
import type {
  CashbackRuleStatus,
  CashbackState,
  CurrencyCode,
  DiscountablePurpose,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  cashbackReversals,
  cashbackRules,
  orderCashback,
  orders,
  provisioningOperations,
} from '../../../../infrastructure/persistence/schema.js';
import { PURCHASED_AS } from '../../provisioning/application/provisioner.service.js';
import type {
  CashbackReversalRecord,
  CashbackRuleRecord,
  CashbackRulePage,
  CashbackRuleRepository,
  CashbackRuleWrite,
  DueCashback,
  OrderCashbackRecord,
  OrderCashbackRepository,
  RuleCursor,
} from '../application/ports.js';

/** The order states in which a promise can no longer be kept: nothing was delivered. */
const ENDED_ORDER_STATES = ['CANCELLED', 'EXPIRED', 'REFUNDED'] as const;

/** Cashback rules, in PostgreSQL. Every query carries the tenant. */
export class DrizzleCashbackRuleRepository implements CashbackRuleRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async create(
    scope: TenantContext,
    id: string,
    write: CashbackRuleWrite,
    now: Date,
    tx?: unknown,
  ): Promise<CashbackRuleRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(cashbackRules)
      .values({
        id,
        tenantId,
        ...ruleColumns(write),
        status: 'INACTIVE',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('cashback_rules insert returned no row.');
    return toRule(row);
  }

  async update(
    scope: TenantContext,
    id: string,
    write: CashbackRuleWrite,
    now: Date,
    tx?: unknown,
  ): Promise<CashbackRuleRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(cashbackRules)
      .set({ ...ruleColumns(write), updatedAt: now })
      .where(and(eq(cashbackRules.tenantId, tenantId), eq(cashbackRules.id, id)))
      .returning();
    const row = rows[0];
    return row === undefined ? null : toRule(row);
  }

  async setStatus(
    scope: TenantContext,
    id: string,
    from: CashbackRuleStatus,
    to: CashbackRuleStatus,
    now: Date,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(cashbackRules)
      .set({ status: to, updatedAt: now })
      .where(
        and(
          eq(cashbackRules.tenantId, tenantId),
          eq(cashbackRules.id, id),
          eq(cashbackRules.status, from),
        ),
      )
      .returning({ id: cashbackRules.id });
    return rows.length === 1;
  }

  async findById(
    scope: TenantContext,
    id: string,
    tx?: unknown,
  ): Promise<CashbackRuleRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(cashbackRules)
      .where(and(eq(cashbackRules.tenantId, tenantId), eq(cashbackRules.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRule(row);
  }

  async list(
    scope: TenantContext,
    search: { readonly status?: CashbackRuleStatus },
    limit: number,
    cursor: RuleCursor | null,
    tx?: unknown,
  ): Promise<CashbackRulePage> {
    const tenantId = requireTenantId(scope);
    const conditions: SQL[] = [eq(cashbackRules.tenantId, tenantId)];
    if (search.status !== undefined) conditions.push(eq(cashbackRules.status, search.status));
    if (cursor !== null) {
      conditions.push(
        sql`(${cashbackRules.createdAt}, ${cashbackRules.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await this.exec(tx)
      .select({
        ...getTableColumns(cashbackRules),
        createdAtText: sql<string>`to_char(${cashbackRules.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(cashbackRules)
      .where(and(...conditions))
      .orderBy(asc(cashbackRules.createdAt), asc(cashbackRules.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toRule),
      nextCursor:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAtText, id: last.id }
          : null,
    };
  }

  async listLive(scope: TenantContext, tx?: unknown): Promise<readonly CashbackRuleRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(cashbackRules)
      .where(and(eq(cashbackRules.tenantId, tenantId), eq(cashbackRules.status, 'ACTIVE')))
      .orderBy(asc(cashbackRules.id));
    return rows.map(toRule);
  }
}

/** Order cashback promises and their reversals, in PostgreSQL. */
export class DrizzleOrderCashbackRepository implements OrderCashbackRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async promise(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly orderId: string;
      readonly customerId: string;
      readonly cashback: {
        readonly ruleId: string;
        readonly ruleLabel: string;
        readonly percent: number;
        readonly amount: { readonly amountMinor: bigint; readonly currency: CurrencyCode };
      };
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(orderCashback)
      .values({
        id: input.id,
        tenantId,
        orderId: input.orderId,
        customerId: input.customerId,
        ruleId: input.cashback.ruleId,
        ruleLabel: input.cashback.ruleLabel,
        percent: input.cashback.percent,
        amount: input.cashback.amount.amountMinor,
        currency: input.cashback.amount.currency,
        state: 'PENDING',
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({ target: [orderCashback.tenantId, orderCashback.orderId] })
      .returning({ id: orderCashback.id });
    return rows.length === 1;
  }

  async findByOrder(
    scope: TenantContext,
    orderId: string,
    tx?: unknown,
  ): Promise<OrderCashbackRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(orderCashback)
      .where(and(eq(orderCashback.tenantId, tenantId), eq(orderCashback.orderId, orderId)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toPromise(row);
  }

  async lockByOrder(
    scope: TenantContext,
    orderId: string,
    tx: unknown,
  ): Promise<OrderCashbackRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(orderCashback)
      .where(and(eq(orderCashback.tenantId, tenantId), eq(orderCashback.orderId, orderId)))
      .for('update')
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toPromise(row);
  }

  /**
   * `PENDING` promises whose order has an answer, oldest first.
   *
   * Delivered is `PURCHASED_AS[purpose]` — the provisioner's own table, imported rather
   * than copied — having an operation for this order in `SUCCEEDED`. That includes a
   * create whose answer was lost and a read later proved took effect: a reconcile moves
   * the original operation to `SUCCEEDED`, so the promise is kept for exactly the
   * accounts the customer holds. Everything else is still in flight and waits.
   */
  async due(scope: TenantContext, limit: number, tx?: unknown): Promise<readonly DueCashback[]> {
    return this.answered(scope, null, limit, tx);
  }

  async dueFor(scope: TenantContext, orderId: string, tx?: unknown): Promise<DueCashback | null> {
    const [row] = await this.answered(scope, orderId, 1, tx);
    return row ?? null;
  }

  /**
   * `PENDING` promises whose order has an answer — one order's, or the oldest `limit`.
   *
   * Delivered is `PURCHASED_AS[purpose]` — the provisioner's own table, imported rather
   * than copied — having an operation for this order in `SUCCEEDED`. That includes a
   * create whose answer was lost and a read later proved took effect: a reconcile moves
   * the original operation to `SUCCEEDED`, so the promise is kept for exactly the
   * accounts the customer holds. Everything else is still in flight and waits.
   */
  private async answered(
    scope: TenantContext,
    orderId: string | null,
    limit: number,
    tx?: unknown,
  ): Promise<readonly DueCashback[]> {
    const tenantId = requireTenantId(scope);
    const purchasedAs = sql.join(
      Object.entries(PURCHASED_AS).map(([purpose, type]) => sql`WHEN ${purpose} THEN ${type}`),
      sql` `,
    );
    const delivered = sql<boolean>`EXISTS (
      SELECT 1 FROM ${provisioningOperations} op
      WHERE op.tenant_id = ${orderCashback.tenantId}
        AND op.order_id = ${orderCashback.orderId}
        AND op.state = 'SUCCEEDED'
        AND op.type = (CASE ${orders.purpose} ${purchasedAs} END)
    )`;
    const ended = sql<boolean>`${orders.state} IN (${sql.join(
      ENDED_ORDER_STATES.map((s) => sql`${s}`),
      sql`, `,
    )})`;
    const conditions: SQL[] = [
      eq(orderCashback.tenantId, tenantId),
      eq(orderCashback.state, 'PENDING'),
      sql`(${delivered} OR ${ended})`,
    ];
    if (orderId !== null) conditions.push(eq(orderCashback.orderId, orderId));
    const rows = await this.exec(tx)
      .select({ orderId: orderCashback.orderId, delivered, ended })
      .from(orderCashback)
      .innerJoin(
        orders,
        and(eq(orders.tenantId, orderCashback.tenantId), eq(orders.id, orderCashback.orderId)),
      )
      .where(and(...conditions))
      .orderBy(asc(orderCashback.createdAt), asc(orderCashback.id))
      .limit(limit);
    return rows.map((r) => ({ orderId: r.orderId, delivered: r.delivered, ended: r.ended }));
  }

  async earn(
    scope: TenantContext,
    id: string,
    input: { readonly earnedAmount: bigint; readonly entryId: string | null; readonly now: Date },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(orderCashback)
      .set({
        state: 'EARNED',
        earnedAmount: input.earnedAmount,
        earnedEntryId: input.entryId,
        earnedAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(orderCashback.tenantId, tenantId),
          eq(orderCashback.id, id),
          eq(orderCashback.state, 'PENDING'),
        ),
      )
      .returning({ id: orderCashback.id });
    return rows.length === 1;
  }

  async void(scope: TenantContext, id: string, now: Date, tx: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(orderCashback)
      .set({ state: 'VOID', voidedAt: now, updatedAt: now })
      .where(
        and(
          eq(orderCashback.tenantId, tenantId),
          eq(orderCashback.id, id),
          eq(orderCashback.state, 'PENDING'),
        ),
      )
      .returning({ id: orderCashback.id });
    return rows.length === 1;
  }

  async reversals(
    scope: TenantContext,
    orderCashbackId: string,
    tx?: unknown,
  ): Promise<readonly CashbackReversalRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(cashbackReversals)
      .where(
        and(
          eq(cashbackReversals.tenantId, tenantId),
          eq(cashbackReversals.orderCashbackId, orderCashbackId),
        ),
      )
      .orderBy(asc(cashbackReversals.createdAt), asc(cashbackReversals.id));
    return rows.map((row) => ({
      id: row.id,
      refundId: row.refundId,
      due: row.dueAmount,
      recovered: row.recoveredAmount,
      unrecovered: row.unrecoveredAmount,
      walletEntryId: row.walletEntryId,
      createdAt: row.createdAt,
    }));
  }

  async recordReversal(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly orderCashbackId: string;
      readonly orderId: string;
      readonly customerId: string;
      readonly refundId: string;
      readonly due: bigint;
      readonly recovered: bigint;
      readonly unrecovered: bigint;
      readonly currency: CurrencyCode;
      readonly walletEntryId: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(cashbackReversals)
      .values({
        id: input.id,
        tenantId,
        orderCashbackId: input.orderCashbackId,
        orderId: input.orderId,
        customerId: input.customerId,
        refundId: input.refundId,
        dueAmount: input.due,
        recoveredAmount: input.recovered,
        unrecoveredAmount: input.unrecovered,
        currency: input.currency,
        walletEntryId: input.walletEntryId,
        createdAt: input.now,
      })
      .onConflictDoNothing({ target: [cashbackReversals.tenantId, cashbackReversals.refundId] })
      .returning({ id: cashbackReversals.id });
    return rows.length === 1;
  }
}

function ruleColumns(write: CashbackRuleWrite) {
  return {
    label: write.label,
    percent: write.percent,
    appliesTo: [...write.appliesTo],
    productId: write.productId,
    categoryId: write.categoryId,
    startsAt: write.startsAt,
    endsAt: write.endsAt,
  };
}

function toRule(row: typeof cashbackRules.$inferSelect): CashbackRuleRecord {
  return {
    id: row.id,
    label: row.label,
    percent: row.percent,
    appliesTo: row.appliesTo as DiscountablePurpose[],
    productId: row.productId,
    categoryId: row.categoryId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: row.status as CashbackRuleStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPromise(row: typeof orderCashback.$inferSelect): OrderCashbackRecord {
  return {
    id: row.id,
    orderId: row.orderId,
    customerId: row.customerId,
    ruleId: row.ruleId,
    ruleLabel: row.ruleLabel,
    percent: row.percent,
    amount: money(row.amount, row.currency as CurrencyCode),
    state: row.state as CashbackState,
    earnedAmount: row.earnedAmount,
    earnedEntryId: row.earnedEntryId,
    earnedAt: row.earnedAt,
    voidedAt: row.voidedAt,
  };
}
