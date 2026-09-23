import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  AUTOMATIC_REFUND_REASON,
  REFUND_CONSUMING_STATES,
  money,
  type CurrencyCode,
  type OrderId,
  type PaymentId,
  type RefundChannel,
  type RefundId,
  type RefundState,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { customers, payments, refunds } from '../../../../infrastructure/persistence/schema.js';
import type {
  CompensationCursor,
  CompensationPage,
  RefundConsumption,
  RefundDraft,
  RefundRecord,
  RefundRepository,
} from '../application/refund-ports.js';

/** The columns the record is built from. Selected explicitly, in one place. */
const COLUMNS = {
  id: refunds.id,
  paymentId: refunds.paymentId,
  customerId: refunds.customerId,
  orderId: refunds.orderId,
  state: refunds.state,
  channel: refunds.channel,
  amount: refunds.amount,
  currency: refunds.currency,
  reason: refunds.reason,
  requestedByAdminId: refunds.requestedByAdminId,
  completedByAdminId: refunds.completedByAdminId,
  completedAt: refunds.completedAt,
  externalReference: refunds.externalReference,
  completionNote: refunds.completionNote,
  createdAt: refunds.createdAt,
  updatedAt: refunds.updatedAt,
} as const;

interface Row {
  readonly id: string;
  readonly paymentId: string;
  readonly customerId: string;
  readonly orderId: string | null;
  readonly state: string;
  readonly channel: string;
  readonly amount: bigint;
  readonly currency: string;
  readonly reason: string;
  readonly requestedByAdminId: string | null;
  readonly completedByAdminId: string | null;
  readonly completedAt: Date | null;
  readonly externalReference: string | null;
  readonly completionNote: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toRecord(row: Row): RefundRecord {
  return {
    id: row.id as RefundId,
    paymentId: row.paymentId as PaymentId,
    customerId: row.customerId as UserId,
    orderId: row.orderId === null ? null : (row.orderId as OrderId),
    /*
     * Cast rather than re-validated: `refunds_state_check`, `refunds_channel_check` and
     * `refunds_currency_check` are built from these exact contract enums, so the
     * database is the boundary that guarantees them.
     */
    state: row.state as RefundState,
    channel: row.channel as RefundChannel,
    amount: money(row.amount, row.currency as CurrencyCode),
    reason: row.reason,
    requestedByAdminId: row.requestedByAdminId,
    completedByAdminId: row.completedByAdminId,
    completedAt: row.completedAt,
    externalReference: row.externalReference,
    completionNote: row.completionNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Refunds, in PostgreSQL.
 *
 * Every query carries `eq(refunds.tenantId, …)`, the primary-key lookups included, for
 * the reason the payment repository states: a primary-key lookup without the tenant
 * returns another tenant's row and leaves the caller holding financial evidence it
 * should never have seen.
 */
export class DrizzleRefundRepository implements RefundRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  /** Oldest first — a history reads forwards, and the sum below does not care. */
  async listCompensations(
    scope: TenantContext,
    limit: number,
    cursor: CompensationCursor | null,
    tx?: unknown,
  ): Promise<CompensationPage> {
    const tenantId = requireTenantId(scope);
    const conditions: SQL[] = [
      eq(refunds.tenantId, tenantId),
      // The automatic lane's two marks: its reason and its channel (§13's compensation).
      eq(refunds.reason, AUTOMATIC_REFUND_REASON),
      eq(refunds.channel, 'WALLET_CREDIT'),
    ];
    if (cursor !== null) {
      conditions.push(
        sql`(${refunds.createdAt}, ${refunds.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await this.exec(tx)
      .select({
        refundId: refunds.id,
        paymentId: refunds.paymentId,
        orderId: refunds.orderId,
        customerId: refunds.customerId,
        telegramUserId: customers.telegramUserId,
        username: customers.username,
        principal: payments.amount,
        principalCurrency: payments.currency,
        credited: refunds.amount,
        currency: refunds.currency,
        reason: refunds.reason,
        state: refunds.state,
        createdAt: refunds.createdAt,
        completedAt: refunds.completedAt,
        createdAtText: sql<string>`to_char(${refunds.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(refunds)
      // Tenant-scoped joins on both sides, the way every composite key here is.
      .innerJoin(
        payments,
        and(eq(payments.tenantId, refunds.tenantId), eq(payments.id, refunds.paymentId)),
      )
      .leftJoin(
        customers,
        and(eq(customers.tenantId, refunds.tenantId), eq(customers.id, refunds.customerId)),
      )
      .where(and(...conditions))
      .orderBy(asc(refunds.createdAt), asc(refunds.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({
        refundId: row.refundId as RefundId,
        paymentId: row.paymentId as PaymentId,
        orderId: row.orderId as OrderId | null,
        customerId: row.customerId as UserId,
        customerTelegramUserId: row.telegramUserId,
        customerUsername: row.username,
        principal: money(row.principal, row.principalCurrency as CurrencyCode),
        credited: money(row.credited, row.currency as CurrencyCode),
        reason: row.reason,
        state: row.state as RefundState,
        createdAt: row.createdAt,
        completedAt: row.completedAt,
      })),
      nextCursor:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAtText, id: last.refundId as RefundId }
          : null,
    };
  }

  async listForPayment(
    scope: TenantContext,
    paymentId: PaymentId,
    tx?: unknown,
  ): Promise<readonly RefundRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select(COLUMNS)
      .from(refunds)
      .where(and(eq(refunds.tenantId, tenantId), eq(refunds.paymentId, paymentId)))
      .orderBy(asc(refunds.createdAt), asc(refunds.id));
    return rows.map(toRecord);
  }

  async findById(scope: TenantContext, id: RefundId, tx?: unknown): Promise<RefundRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select(COLUMNS)
      .from(refunds)
      .where(and(eq(refunds.tenantId, tenantId), eq(refunds.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findByIdForUpdate(
    scope: TenantContext,
    id: RefundId,
    tx: unknown,
  ): Promise<RefundRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select(COLUMNS)
      .from(refunds)
      .where(and(eq(refunds.tenantId, tenantId), eq(refunds.id, id)))
      .limit(1)
      .for('update');
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /**
   * The sum that bounds every refund, over the CONSUMING states only.
   *
   * `inArray(REFUND_CONSUMING_STATES)` rather than `ne('FAILED')`, so a state added to
   * `REFUND_STATES` later cannot silently start consuming a payment's refundable
   * balance. The contract spells the list out for the same reason.
   *
   * `MIN(currency)` is not a currency calculation — it is a WITNESS. Every refund of one
   * payment is in that payment's currency by construction (the service copies it and the
   * column has a CHECK), so this returns the one value present so the caller can assert
   * it rather than assume it. `count` is how many rows produced the sum, because a total
   * that cannot say what it was derived from is the legacy summary that leaves 916,550
   * unexplained.
   */
  async consumptionFor(
    scope: TenantContext,
    paymentId: PaymentId,
    tx: unknown,
  ): Promise<RefundConsumption> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({
        consumed: sql<string>`coalesce(sum(${refunds.amount}), 0)::text`,
        currency: sql<string | null>`min(${refunds.currency})`,
        total: sql<number>`count(*)::int`,
      })
      .from(refunds)
      .where(
        and(
          eq(refunds.tenantId, tenantId),
          eq(refunds.paymentId, paymentId),
          inArray(refunds.state, [...REFUND_CONSUMING_STATES]),
        ),
      );
    const row = rows[0];
    return {
      consumedMinor: BigInt(row?.consumed ?? '0'),
      currency: (row?.currency ?? null) as CurrencyCode | null,
      count: Number(row?.total ?? 0),
    };
  }

  /**
   * How many CONFIRMED payments in one currency still have money that could go back.
   *
   * Asked before `sales.currency` is allowed to change. A wallet credit is written in
   * the PAYMENT's frozen currency, and every wallet read — balance, history,
   * settlement — is denominated in the currency the tenant sells in TODAY. So a
   * currency change with refundable exposure behind it produces credits the customer
   * is told about and can neither see nor spend, which is the condition
   * `confirmAndCredit` already refuses for a top-up.
   *
   * A COUNT rather than the rows: the answer is a yes/no about whether the change is
   * safe, and the operator is told how many stand in the way, not which.
   *
   * `REFUND_CONSUMING_STATES` is the same set the refundable balance uses, so a
   * payment fully covered by an in-flight refund does not count as exposure.
   */
  async refundableExposureIn(
    scope: TenantContext,
    currency: CurrencyCode,
    tx?: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const consuming = [...REFUND_CONSUMING_STATES];
    const rows = (await this.exec(tx).execute(sql`
      SELECT count(*)::int AS n
        FROM ${payments} p
       WHERE p.tenant_id = ${tenantId}
         AND p.state = 'CONFIRMED'
         AND p.currency = ${currency}
         AND p.amount > coalesce((SELECT sum(r.amount) FROM ${refunds} r
                                   WHERE r.payment_id = p.id
                                     AND r.tenant_id = p.tenant_id
                                     AND r.state = ANY(${sql.param(consuming)}::text[])), 0)
    `)) as unknown as { rows: { n: number }[] };
    return Number(rows.rows[0]?.n ?? 0);
  }

  async lockPayment(scope: TenantContext, paymentId: PaymentId, tx: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.id, paymentId)))
      .limit(1)
      /*
       * `NO KEY UPDATE`, not `UPDATE` — it serialises every refund writer of this
       * payment exactly as before (the two modes conflict with themselves and with each
       * other), and it does NOT conflict with the `FOR KEY SHARE` a foreign-key check
       * takes. That difference is a deadlock: the cashback and referral earners hold the
       * CUSTOMER's lock and then insert a ledger entry naming this payment, whose FK
       * check waited on a `FOR UPDATE` here while this transaction waited on the
       * customer. WP10 P3 made `complete` take this lock, and the mid-credit races in
       * `cashback.test.ts` and `referrals.test.ts` aborted with `40P01` until it changed.
       */
      .for('no key update');
    return rows.length === 1;
  }

  async create(scope: TenantContext, draft: RefundDraft, tx: unknown): Promise<RefundRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(refunds)
      .values({
        id: draft.id,
        tenantId,
        paymentId: draft.paymentId,
        customerId: draft.customerId,
        orderId: draft.orderId,
        state: draft.state,
        channel: draft.channel,
        amount: draft.amount.amountMinor,
        currency: draft.amount.currency,
        reason: draft.reason,
        requestedByAdminId: draft.requestedByAdminId,
        completedByAdminId: draft.completedByAdminId,
        completedAt: draft.completedAt,
        createdAt: draft.now,
        updatedAt: draft.now,
      })
      .returning(COLUMNS);
    const row = rows[0];
    if (row === undefined) {
      // An INSERT with no conflict clause either returns its row or throws. Reaching
      // here would mean drizzle returned nothing from a successful insert, which is not
      // a state to paper over with a re-read.
      throw new Error('refund insert returned no row');
    }
    return toRecord(row);
  }

  /**
   * The conditional transition. `from` is in the WHERE, never checked and then written.
   *
   * A read-then-write would let two operators both see AWAITING_EXTERNAL and both write
   * COMPLETED, and the second would record a completion — an operator's name against
   * money somebody else returned. Naming `from` makes the loser's UPDATE affect zero
   * rows and say so.
   *
   * The completion columns are written in the SAME statement as the state, which is what
   * `refunds_completed_check` requires: the constraint binds COMPLETED to having both an
   * operator and a timestamp, so a two-step write would be refused by the database
   * between the steps.
   */
  async transition(
    scope: TenantContext,
    id: RefundId,
    input: {
      readonly from: RefundState;
      readonly to: RefundState;
      readonly completedByAdminId?: string | null;
      readonly completedAt?: Date | null;
      readonly externalReference?: string | null;
      readonly completionNote?: string | null;
    },
    now: Date,
    tx: unknown,
  ): Promise<RefundRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(refunds)
      .set({
        state: input.to,
        ...(input.completedByAdminId === undefined
          ? {}
          : { completedByAdminId: input.completedByAdminId }),
        ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
        ...(input.externalReference === undefined
          ? {}
          : { externalReference: input.externalReference }),
        ...(input.completionNote === undefined ? {} : { completionNote: input.completionNote }),
        updatedAt: now,
      })
      .where(and(eq(refunds.tenantId, tenantId), eq(refunds.id, id), eq(refunds.state, input.from)))
      .returning(COLUMNS);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }
}
