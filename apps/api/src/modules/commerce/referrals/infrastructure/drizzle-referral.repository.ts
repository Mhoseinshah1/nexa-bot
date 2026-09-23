import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { money } from '@nexa/contracts';
import type {
  CurrencyCode,
  CustomerStatus,
  ReferralCommissionScope,
  ReferralCommissionState,
  ReferralTrigger,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  customers,
  orderReferralCommissions,
  orders,
  provisioningOperations,
  referralCodes,
  referralCommissionReversals,
  referrals,
} from '../../../../infrastructure/persistence/schema.js';
import { PURCHASED_AS } from '../../provisioning/application/provisioner.service.js';
import type {
  DueReferralCommission,
  ReferralCommissionListing,
  ReferralCommissionRecord,
  ReferralCommissionRepository,
  ReferralCommissionReversalRecord,
  ReferralCursor,
  ReferralListing,
  ReferralParty,
  ReferralRecord,
  ReferralRepository,
  ReferralTotals,
} from '../application/ports.js';

/** The order states in which a promise can no longer be kept: nothing was delivered. */
const ENDED_ORDER_STATES = ['CANCELLED', 'EXPIRED', 'REFUNDED'] as const;

const referrerParty = alias(customers, 'referrer_party');
const refereeParty = alias(customers, 'referee_party');

function exec(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

/** A customer row selected through one of the two aliases, typed by the columns chosen. */
interface PartyRow {
  readonly id: unknown;
  readonly telegramUserId: unknown;
  readonly firstName: unknown;
  readonly lastName: unknown;
  readonly username: unknown;
}

function party(row: PartyRow): ReferralParty {
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value !== '' ? value : null;
  const name = [text(row.firstName), text(row.lastName)].filter((p) => p !== null).join(' ');
  return {
    customerId: String(row.id),
    telegramUserId: String(row.telegramUserId),
    displayName: name !== '' ? name : text(row.username),
  };
}

function partyColumns<
  T extends {
    readonly id: AnyPgColumn;
    readonly telegramUserId: AnyPgColumn;
    readonly firstName: AnyPgColumn;
    readonly lastName: AnyPgColumn;
    readonly username: AnyPgColumn;
  },
>(table: T) {
  return {
    id: table.id,
    telegramUserId: table.telegramUserId,
    firstName: table.firstName,
    lastName: table.lastName,
    username: table.username,
  };
}

/** Keyset predicate for newest-first lists: strictly older than the cursor. */
function before(
  createdAt: AnyPgColumn,
  id: AnyPgColumn,
  cursor: ReferralCursor | null,
): SQL | undefined {
  if (cursor === null) return undefined;
  return sql`(${createdAt}, ${id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`;
}

/** Attributions and codes, in PostgreSQL. Every query carries the tenant. */
export class DrizzleReferralRepository implements ReferralRepository {
  constructor(private readonly db: Database) {}

  async ensureCode(
    scope: TenantContext,
    input: { readonly customerId: string; readonly code: string; readonly now: Date },
    tx: unknown,
  ): Promise<'CREATED' | 'EXISTS' | 'TAKEN'> {
    const tenantId = requireTenantId(scope);
    const [existing] = await exec(this.db, tx)
      .select({ code: referralCodes.code })
      .from(referralCodes)
      .where(
        and(eq(referralCodes.tenantId, tenantId), eq(referralCodes.customerId, input.customerId)),
      )
      .limit(1);
    if (existing !== undefined) return existing.code === input.code ? 'EXISTS' : 'TAKEN';
    /*
     * ON CONFLICT DO NOTHING with no target covers BOTH keys: a concurrent first request
     * by the same customer (the primary key) and another customer holding this code (the
     * code key). Which one fired is read back below, so neither is guessed.
     */
    const rows = await exec(this.db, tx)
      .insert(referralCodes)
      .values({ tenantId, customerId: input.customerId, code: input.code, createdAt: input.now })
      .onConflictDoNothing()
      .returning({ code: referralCodes.code });
    if (rows.length === 1) return 'CREATED';
    const [mine] = await exec(this.db, tx)
      .select({ code: referralCodes.code })
      .from(referralCodes)
      .where(
        and(eq(referralCodes.tenantId, tenantId), eq(referralCodes.customerId, input.customerId)),
      )
      .limit(1);
    return mine !== undefined && mine.code === input.code ? 'EXISTS' : 'TAKEN';
  }

  async findCodeOwner(
    scope: TenantContext,
    code: string,
    tx?: unknown,
  ): Promise<{ readonly customerId: string; readonly status: CustomerStatus } | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select({ customerId: referralCodes.customerId, status: customers.status })
      .from(referralCodes)
      .innerJoin(
        customers,
        and(
          eq(customers.tenantId, referralCodes.tenantId),
          eq(customers.id, referralCodes.customerId),
        ),
      )
      .where(and(eq(referralCodes.tenantId, tenantId), eq(referralCodes.code, code)))
      .limit(1);
    return row === undefined
      ? null
      : { customerId: row.customerId, status: row.status as CustomerStatus };
  }

  async attribute(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly referrerId: string;
      readonly refereeId: string;
      readonly trigger: ReferralTrigger;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .insert(referrals)
      .values({
        id: input.id,
        tenantId,
        referrerId: input.referrerId,
        refereeId: input.refereeId,
        trigger: input.trigger,
        createdAt: input.now,
      })
      .onConflictDoNothing({ target: [referrals.tenantId, referrals.refereeId] })
      .returning({ id: referrals.id });
    return rows.length === 1;
  }

  async findByReferee(
    scope: TenantContext,
    refereeId: string,
    tx?: unknown,
  ): Promise<ReferralRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select()
      .from(referrals)
      .where(and(eq(referrals.tenantId, tenantId), eq(referrals.refereeId, refereeId)))
      .limit(1);
    return row === undefined ? null : toReferral(row);
  }

  async countReferredBy(scope: TenantContext, referrerId: string, tx?: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select({ n: sql<number>`count(*)::int` })
      .from(referrals)
      .where(and(eq(referrals.tenantId, tenantId), eq(referrals.referrerId, referrerId)));
    return row?.n ?? 0;
  }

  async list(
    scope: TenantContext,
    filter: { readonly referrerId?: string },
    limit: number,
    cursor: ReferralCursor | null,
  ): Promise<{ readonly items: readonly ReferralListing[]; readonly next: ReferralCursor | null }> {
    const tenantId = requireTenantId(scope);
    const conditions: (SQL | undefined)[] = [
      eq(referrals.tenantId, tenantId),
      before(referrals.createdAt, referrals.id, cursor),
    ];
    if (filter.referrerId !== undefined) {
      conditions.push(eq(referrals.referrerId, filter.referrerId));
    }
    const rows = await this.listingQuery()
      .where(and(...conditions))
      .orderBy(desc(referrals.createdAt), desc(referrals.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map(toListing);
    const last = items[items.length - 1];
    return {
      items,
      next:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAt.toISOString(), id: last.id }
          : null,
    };
  }

  async findListingByReferee(
    scope: TenantContext,
    refereeId: string,
  ): Promise<ReferralListing | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.listingQuery()
      .where(and(eq(referrals.tenantId, tenantId), eq(referrals.refereeId, refereeId)))
      .limit(1);
    return row === undefined ? null : toListing(row);
  }

  private listingQuery() {
    return this.db
      .select({
        referral: referrals,
        referrer: partyColumns(referrerParty),
        referee: partyColumns(refereeParty),
      })
      .from(referrals)
      .innerJoin(
        referrerParty,
        and(
          eq(referrerParty.tenantId, referrals.tenantId),
          eq(referrerParty.id, referrals.referrerId),
        ),
      )
      .innerJoin(
        refereeParty,
        and(
          eq(refereeParty.tenantId, referrals.tenantId),
          eq(refereeParty.id, referrals.refereeId),
        ),
      );
  }
}

/** Commissions and their reversals, in PostgreSQL. Every query carries the tenant. */
export class DrizzleReferralCommissionRepository implements ReferralCommissionRepository {
  constructor(private readonly db: Database) {}

  async promise(
    scope: TenantContext,
    input: Parameters<ReferralCommissionRepository['promise']>[1],
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .insert(orderReferralCommissions)
      .values({
        id: input.id,
        tenantId,
        orderId: input.orderId,
        referralId: input.referralId,
        referrerId: input.referrerId,
        refereeId: input.refereeId,
        scope: input.scope,
        percent: input.percent,
        basisAmount: input.basis.amountMinor,
        amount: input.amount.amountMinor,
        currency: input.amount.currency,
        state: 'PENDING',
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({
        target: [orderReferralCommissions.tenantId, orderReferralCommissions.orderId],
      })
      .returning({ id: orderReferralCommissions.id });
    return rows.length === 1;
  }

  async findByOrder(
    scope: TenantContext,
    orderId: string,
    tx?: unknown,
  ): Promise<ReferralCommissionRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select()
      .from(orderReferralCommissions)
      .where(
        and(
          eq(orderReferralCommissions.tenantId, tenantId),
          eq(orderReferralCommissions.orderId, orderId),
        ),
      )
      .limit(1);
    return row === undefined ? null : toCommission(row);
  }

  async lockByOrder(
    scope: TenantContext,
    orderId: string,
    tx: unknown,
  ): Promise<ReferralCommissionRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select()
      .from(orderReferralCommissions)
      .where(
        and(
          eq(orderReferralCommissions.tenantId, tenantId),
          eq(orderReferralCommissions.orderId, orderId),
        ),
      )
      .for('update')
      .limit(1);
    return row === undefined ? null : toCommission(row);
  }

  async due(
    scope: TenantContext,
    limit: number,
    tx?: unknown,
  ): Promise<readonly DueReferralCommission[]> {
    return this.answered(scope, null, limit, tx);
  }

  async dueFor(
    scope: TenantContext,
    orderId: string,
    tx?: unknown,
  ): Promise<DueReferralCommission | null> {
    const [row] = await this.answered(scope, orderId, 1, tx);
    return row ?? null;
  }

  /**
   * `PENDING` commissions whose order has an answer — one order's, or the oldest `limit`.
   *
   * The same answer the cashback earner reads, from the same `PURCHASED_AS` table
   * imported rather than copied: delivered is an operation of the type the order bought
   * having `SUCCEEDED`, and ended is the order in a state from which nothing will be.
   */
  private async answered(
    scope: TenantContext,
    orderId: string | null,
    limit: number,
    tx?: unknown,
  ): Promise<readonly DueReferralCommission[]> {
    const tenantId = requireTenantId(scope);
    const purchasedAs = sql.join(
      Object.entries(PURCHASED_AS).map(([purpose, type]) => sql`WHEN ${purpose} THEN ${type}`),
      sql` `,
    );
    const delivered = sql<boolean>`EXISTS (
      SELECT 1 FROM ${provisioningOperations} op
      WHERE op.tenant_id = ${orderReferralCommissions.tenantId}
        AND op.order_id = ${orderReferralCommissions.orderId}
        AND op.state = 'SUCCEEDED'
        AND op.type = (CASE ${orders.purpose} ${purchasedAs} END)
    )`;
    const ended = sql<boolean>`${orders.state} IN (${sql.join(
      ENDED_ORDER_STATES.map((s) => sql`${s}`),
      sql`, `,
    )})`;
    const conditions: SQL[] = [
      eq(orderReferralCommissions.tenantId, tenantId),
      eq(orderReferralCommissions.state, 'PENDING'),
      sql`(${delivered} OR ${ended})`,
    ];
    if (orderId !== null) conditions.push(eq(orderReferralCommissions.orderId, orderId));
    const rows = await exec(this.db, tx)
      .select({ orderId: orderReferralCommissions.orderId, delivered, ended })
      .from(orderReferralCommissions)
      .innerJoin(
        orders,
        and(
          eq(orders.tenantId, orderReferralCommissions.tenantId),
          eq(orders.id, orderReferralCommissions.orderId),
        ),
      )
      .where(and(...conditions))
      .orderBy(asc(orderReferralCommissions.createdAt), asc(orderReferralCommissions.id))
      .limit(limit);
    return rows.map((r) => ({ orderId: r.orderId, delivered: r.delivered, ended: r.ended }));
  }

  async hasEarnedForReferral(
    scope: TenantContext,
    referralId: string,
    exceptId: string,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select({ id: orderReferralCommissions.id })
      .from(orderReferralCommissions)
      .where(
        and(
          eq(orderReferralCommissions.tenantId, tenantId),
          eq(orderReferralCommissions.referralId, referralId),
          eq(orderReferralCommissions.state, 'EARNED'),
          sql`${orderReferralCommissions.id} <> ${exceptId}::uuid`,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async earn(
    scope: TenantContext,
    id: string,
    input: { readonly earnedAmount: bigint; readonly entryId: string | null; readonly now: Date },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .update(orderReferralCommissions)
      .set({
        state: 'EARNED',
        earnedAmount: input.earnedAmount,
        earnedEntryId: input.entryId,
        earnedAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(orderReferralCommissions.tenantId, tenantId),
          eq(orderReferralCommissions.id, id),
          eq(orderReferralCommissions.state, 'PENDING'),
        ),
      )
      .returning({ id: orderReferralCommissions.id });
    return rows.length === 1;
  }

  async void(scope: TenantContext, id: string, now: Date, tx: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .update(orderReferralCommissions)
      .set({ state: 'VOID', voidedAt: now, updatedAt: now })
      .where(
        and(
          eq(orderReferralCommissions.tenantId, tenantId),
          eq(orderReferralCommissions.id, id),
          eq(orderReferralCommissions.state, 'PENDING'),
        ),
      )
      .returning({ id: orderReferralCommissions.id });
    return rows.length === 1;
  }

  async reversals(
    scope: TenantContext,
    commissionId: string,
    tx?: unknown,
  ): Promise<readonly ReferralCommissionReversalRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .select()
      .from(referralCommissionReversals)
      .where(
        and(
          eq(referralCommissionReversals.tenantId, tenantId),
          eq(referralCommissionReversals.commissionId, commissionId),
        ),
      )
      .orderBy(asc(referralCommissionReversals.createdAt), asc(referralCommissionReversals.id));
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
    input: Parameters<ReferralCommissionRepository['recordReversal']>[1],
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .insert(referralCommissionReversals)
      .values({
        id: input.id,
        tenantId,
        commissionId: input.commissionId,
        orderId: input.orderId,
        referrerId: input.referrerId,
        refundId: input.refundId,
        dueAmount: input.due,
        recoveredAmount: input.recovered,
        unrecoveredAmount: input.unrecovered,
        currency: input.currency,
        walletEntryId: input.walletEntryId,
        createdAt: input.now,
      })
      .onConflictDoNothing({
        target: [referralCommissionReversals.tenantId, referralCommissionReversals.refundId],
      })
      .returning({ id: referralCommissionReversals.id });
    return rows.length === 1;
  }

  async list(
    scope: TenantContext,
    filter: { readonly state?: ReferralCommissionState; readonly referrerId?: string },
    limit: number,
    cursor: ReferralCursor | null,
  ): Promise<{
    readonly items: readonly ReferralCommissionListing[];
    readonly next: ReferralCursor | null;
  }> {
    const tenantId = requireTenantId(scope);
    const conditions: (SQL | undefined)[] = [
      eq(orderReferralCommissions.tenantId, tenantId),
      before(orderReferralCommissions.createdAt, orderReferralCommissions.id, cursor),
    ];
    if (filter.state !== undefined) {
      conditions.push(eq(orderReferralCommissions.state, filter.state));
    }
    if (filter.referrerId !== undefined) {
      conditions.push(eq(orderReferralCommissions.referrerId, filter.referrerId));
    }
    const reversed = sql<string>`COALESCE((
      SELECT sum(r.due_amount) FROM ${referralCommissionReversals} r
      WHERE r.tenant_id = ${orderReferralCommissions.tenantId}
        AND r.commission_id = ${orderReferralCommissions.id}), 0)::text`;
    const unrecovered = sql<string>`COALESCE((
      SELECT sum(r.unrecovered_amount) FROM ${referralCommissionReversals} r
      WHERE r.tenant_id = ${orderReferralCommissions.tenantId}
        AND r.commission_id = ${orderReferralCommissions.id}), 0)::text`;
    const rows = await this.db
      .select({
        commission: orderReferralCommissions,
        referrer: partyColumns(referrerParty),
        referee: partyColumns(refereeParty),
        reversed,
        unrecovered,
      })
      .from(orderReferralCommissions)
      .innerJoin(
        referrerParty,
        and(
          eq(referrerParty.tenantId, orderReferralCommissions.tenantId),
          eq(referrerParty.id, orderReferralCommissions.referrerId),
        ),
      )
      .innerJoin(
        refereeParty,
        and(
          eq(refereeParty.tenantId, orderReferralCommissions.tenantId),
          eq(refereeParty.id, orderReferralCommissions.refereeId),
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(orderReferralCommissions.createdAt), desc(orderReferralCommissions.id))
      .limit(limit + 1);
    const items: ReferralCommissionListing[] = rows.slice(0, limit).map((row) => ({
      ...toCommission(row.commission),
      referrer: party(row.referrer),
      referee: party(row.referee),
      reversed: BigInt(row.reversed),
      unrecovered: BigInt(row.unrecovered),
    }));
    const last = items[items.length - 1];
    return {
      items,
      next:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAt.toISOString(), id: last.id }
          : null,
    };
  }

  async totalsForReferrer(
    scope: TenantContext,
    referrerId: string,
  ): Promise<readonly ReferralTotals[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select({
        currency: orderReferralCommissions.currency,
        pending: sql<string>`COALESCE(sum(${orderReferralCommissions.amount}) FILTER (WHERE ${orderReferralCommissions.state} = 'PENDING'), 0)::text`,
        earned: sql<string>`COALESCE(sum(${orderReferralCommissions.earnedAmount}) FILTER (WHERE ${orderReferralCommissions.state} = 'EARNED'), 0)::text`,
        reversed: sql<string>`COALESCE((
          SELECT sum(r.due_amount) FROM ${referralCommissionReversals} r
          WHERE r.tenant_id = ${tenantId}::uuid AND r.referrer_id = ${referrerId}::uuid
            AND r.currency = ${orderReferralCommissions.currency}), 0)::text`,
      })
      .from(orderReferralCommissions)
      .where(
        and(
          eq(orderReferralCommissions.tenantId, tenantId),
          eq(orderReferralCommissions.referrerId, referrerId),
        ),
      )
      .groupBy(orderReferralCommissions.currency)
      .orderBy(asc(orderReferralCommissions.currency));
    return rows.map((row) => ({
      currency: row.currency as CurrencyCode,
      pending: BigInt(row.pending),
      earned: BigInt(row.earned),
      reversed: BigInt(row.reversed),
    }));
  }
}

function toReferral(row: typeof referrals.$inferSelect): ReferralRecord {
  return {
    id: row.id,
    referrerId: row.referrerId,
    refereeId: row.refereeId,
    trigger: row.trigger as ReferralTrigger,
    createdAt: row.createdAt,
  };
}

function toListing(row: {
  readonly referral: typeof referrals.$inferSelect;
  readonly referrer: PartyRow;
  readonly referee: PartyRow;
}): ReferralListing {
  return {
    ...toReferral(row.referral),
    referrer: party(row.referrer),
    referee: party(row.referee),
  };
}

function toCommission(row: typeof orderReferralCommissions.$inferSelect): ReferralCommissionRecord {
  const currency = row.currency as CurrencyCode;
  return {
    id: row.id,
    orderId: row.orderId,
    referralId: row.referralId,
    referrerId: row.referrerId,
    refereeId: row.refereeId,
    scope: row.scope as ReferralCommissionScope,
    percent: row.percent,
    basis: money(row.basisAmount, currency),
    amount: money(row.amount, currency),
    state: row.state as ReferralCommissionState,
    earnedAmount: row.earnedAmount,
    earnedEntryId: row.earnedEntryId,
    earnedAt: row.earnedAt,
    voidedAt: row.voidedAt,
    createdAt: row.createdAt,
  };
}
