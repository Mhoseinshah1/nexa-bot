import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  money,
  type BotInstanceId,
  type CurrencyCode,
  type CustomerCaptureCloseReason,
  type CustomerCapturePurpose,
  type CustomerCaptureState,
  type Money,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { customerTextCaptures } from '../../../../infrastructure/persistence/schema.js';
import type {
  CustomerCaptureRecord,
  CustomerCaptureRepository,
} from '../application/customer-capture-ports.js';

/** Its own advisory lock class, beside the admin capture's, so the two never contend. */
export const CUSTOMER_CAPTURE_LOCK_CLASS = 0x4343;

export class DrizzleCustomerCaptureRepository implements CustomerCaptureRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async lockForCustomer(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    customerId: UserId,
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(
      sql`SELECT pg_advisory_xact_lock(${CUSTOMER_CAPTURE_LOCK_CLASS},
            hashtext(${`${tenantId}:${botInstanceId}:${customerId}`}))`,
    );
  }

  async open(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly botInstanceId: BotInstanceId;
      readonly customerId: UserId;
      readonly purpose: CustomerCapturePurpose;
      readonly subjectId: string | null;
      readonly openedAt: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<CustomerCaptureRecord> {
    const tenantId = requireTenantId(scope);
    await this.closeOpen(scope, input.botInstanceId, input.customerId, input.openedAt, tx);
    const [row] = await this.exec(tx)
      .insert(customerTextCaptures)
      .values({
        id: input.id,
        tenantId,
        botInstanceId: input.botInstanceId,
        customerId: input.customerId,
        purpose: input.purpose,
        subjectId: input.subjectId,
        openedAt: input.openedAt,
        expiresAt: input.expiresAt,
      })
      .returning();
    if (row === undefined) throw new Error('customer_text_captures insert returned no row.');
    return toRecord(row);
  }

  async closeOpen(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    customerId: UserId,
    at: Date,
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    // The reason is derived from the row, as the admin capture derives it: a window past
    // its deadline was already dead, and saying SUPERSEDED about it would be a lie.
    await this.exec(tx)
      .update(customerTextCaptures)
      .set({
        closedAt: at,
        closeReason: sql`CASE WHEN ${customerTextCaptures.expiresAt} <= ${at} THEN 'EXPIRED' ELSE 'SUPERSEDED' END`,
      })
      .where(
        and(
          eq(customerTextCaptures.tenantId, tenantId),
          eq(customerTextCaptures.botInstanceId, botInstanceId),
          eq(customerTextCaptures.customerId, customerId),
          isNull(customerTextCaptures.closedAt),
        ),
      );
  }

  async findOpen(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    customerId: UserId,
    tx?: unknown,
  ): Promise<CustomerCaptureRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(customerTextCaptures)
      .where(
        and(
          eq(customerTextCaptures.tenantId, tenantId),
          eq(customerTextCaptures.botInstanceId, botInstanceId),
          eq(customerTextCaptures.customerId, customerId),
          isNull(customerTextCaptures.closedAt),
        ),
      )
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async findById(
    scope: TenantContext,
    id: string,
    tx?: unknown,
  ): Promise<CustomerCaptureRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(customerTextCaptures)
      .where(and(eq(customerTextCaptures.tenantId, tenantId), eq(customerTextCaptures.id, id)))
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async recordAmount(
    scope: TenantContext,
    id: string,
    amount: Money,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(customerTextCaptures)
      .set({
        state: 'AMOUNT_RECORDED',
        amountMinor: amount.amountMinor,
        amountCurrency: amount.currency,
      })
      .where(
        and(
          eq(customerTextCaptures.tenantId, tenantId),
          eq(customerTextCaptures.id, id),
          isNull(customerTextCaptures.closedAt),
          eq(customerTextCaptures.state, 'AWAITING_TEXT'),
          eq(customerTextCaptures.purpose, 'TOPUP_AMOUNT'),
        ),
      )
      .returning({ id: customerTextCaptures.id });
    return rows.length === 1;
  }

  async close(
    scope: TenantContext,
    id: string,
    reason: CustomerCaptureCloseReason,
    at: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(customerTextCaptures)
      .set({ closedAt: at, closeReason: reason })
      .where(
        and(
          eq(customerTextCaptures.tenantId, tenantId),
          eq(customerTextCaptures.id, id),
          isNull(customerTextCaptures.closedAt),
        ),
      )
      .returning({ id: customerTextCaptures.id });
    return rows.length === 1;
  }
}

function toRecord(row: typeof customerTextCaptures.$inferSelect): CustomerCaptureRecord {
  return {
    id: row.id,
    botInstanceId: row.botInstanceId as BotInstanceId,
    customerId: row.customerId as UserId,
    purpose: row.purpose as CustomerCapturePurpose,
    subjectId: row.subjectId,
    state: row.state as CustomerCaptureState,
    amount:
      row.amountMinor === null || row.amountCurrency === null
        ? null
        : money(row.amountMinor, row.amountCurrency as CurrencyCode),
    openedAt: row.openedAt,
    expiresAt: row.expiresAt,
    closedAt: row.closedAt,
    closeReason: row.closeReason as CustomerCaptureCloseReason | null,
  };
}
