import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type {
  AdminAmountCaptureCloseReason,
  AdminCapturePurpose,
  BotInstanceId,
  PaymentId,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { adminAmountCaptures } from '../../../../infrastructure/persistence/schema.js';
import type {
  AdminAmountCaptureRecord,
  AdminAmountCaptureRepository,
} from '../application/admin-amount-capture-ports.js';

/**
 * The advisory-lock CLASS for an administrator's amount capture. Its own class, distinct
 * from `RECEIPT_CAPTURE_LOCK_CLASS`, for the reason that one states.
 */
export const ADMIN_AMOUNT_CAPTURE_LOCK_CLASS = 0x4143;

/**
 * Amount captures, in PostgreSQL. `DrizzleReceiptCaptureRepository`'s shape: every query
 * carries the tenant, and every close and every amount is conditional on the row still
 * being open, so two taps arriving together produce one change.
 */
export class DrizzleAdminAmountCaptureRepository implements AdminAmountCaptureRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async lockForAdmin(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    adminId: string,
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(
      sql`SELECT pg_advisory_xact_lock(${ADMIN_AMOUNT_CAPTURE_LOCK_CLASS},
            hashtext(${`${tenantId}:${botInstanceId}:${adminId}`}))`,
    );
  }

  async open(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly botInstanceId: BotInstanceId;
      readonly adminId: string;
      readonly paymentId: PaymentId;
      readonly purpose?: AdminCapturePurpose;
      readonly openedAt: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<AdminAmountCaptureRecord> {
    const tenantId = requireTenantId(scope);
    // Close first, in this transaction: the partial unique index refuses a second open row.
    // The reason is derived from the row, as `receipt_captures` derives it.
    await this.exec(tx)
      .update(adminAmountCaptures)
      .set({
        closedAt: input.openedAt,
        closeReason: sql`CASE WHEN ${adminAmountCaptures.expiresAt} <= ${input.openedAt} THEN 'EXPIRED' ELSE 'SUPERSEDED' END`,
      })
      .where(
        and(
          eq(adminAmountCaptures.tenantId, tenantId),
          eq(adminAmountCaptures.botInstanceId, input.botInstanceId),
          eq(adminAmountCaptures.adminId, input.adminId),
          isNull(adminAmountCaptures.closedAt),
        ),
      );
    const [row] = await this.exec(tx)
      .insert(adminAmountCaptures)
      .values({
        id: input.id,
        tenantId,
        botInstanceId: input.botInstanceId,
        adminId: input.adminId,
        paymentId: input.paymentId,
        purpose: input.purpose ?? 'RECEIPT_CREDIT_AMOUNT',
        openedAt: input.openedAt,
        expiresAt: input.expiresAt,
      })
      .returning();
    if (row === undefined) throw new Error('admin_amount_captures insert returned no row.');
    return toRecord(row);
  }

  async findAwaitingAmount(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    adminId: string,
    tx?: unknown,
  ): Promise<AdminAmountCaptureRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(adminAmountCaptures)
      .where(
        and(
          eq(adminAmountCaptures.tenantId, tenantId),
          eq(adminAmountCaptures.botInstanceId, botInstanceId),
          eq(adminAmountCaptures.adminId, adminId),
          isNull(adminAmountCaptures.closedAt),
          // An amount is read only by a capture that asked for one: a block's reason
          // capture has no amount either, and must never be parsed as one.
          eq(adminAmountCaptures.purpose, 'RECEIPT_CREDIT_AMOUNT'),
          isNull(adminAmountCaptures.amountMinor),
        ),
      )
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async findAwaitingReason(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    adminId: string,
    purpose: 'RECEIPT_BLOCK_REASON' | 'RECEIPT_REJECT_REASON',
    tx?: unknown,
  ): Promise<AdminAmountCaptureRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(adminAmountCaptures)
      .where(
        and(
          eq(adminAmountCaptures.tenantId, tenantId),
          eq(adminAmountCaptures.botInstanceId, botInstanceId),
          eq(adminAmountCaptures.adminId, adminId),
          isNull(adminAmountCaptures.closedAt),
          eq(adminAmountCaptures.purpose, purpose),
          isNull(adminAmountCaptures.reason),
        ),
      )
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async recordReason(
    scope: TenantContext,
    id: string,
    reason: string,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(adminAmountCaptures)
      .set({ reason })
      .where(
        and(
          eq(adminAmountCaptures.tenantId, tenantId),
          eq(adminAmountCaptures.id, id),
          isNull(adminAmountCaptures.closedAt),
          ne(adminAmountCaptures.purpose, 'RECEIPT_CREDIT_AMOUNT'),
          isNull(adminAmountCaptures.reason),
        ),
      )
      .returning({ id: adminAmountCaptures.id });
    return rows.length > 0;
  }

  async findById(
    scope: TenantContext,
    id: string,
    tx?: unknown,
  ): Promise<AdminAmountCaptureRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(adminAmountCaptures)
      .where(and(eq(adminAmountCaptures.tenantId, tenantId), eq(adminAmountCaptures.id, id)))
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async recordAmount(
    scope: TenantContext,
    id: string,
    amountMinor: bigint,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(adminAmountCaptures)
      .set({ amountMinor })
      .where(
        and(
          eq(adminAmountCaptures.tenantId, tenantId),
          eq(adminAmountCaptures.id, id),
          isNull(adminAmountCaptures.closedAt),
          isNull(adminAmountCaptures.amountMinor),
        ),
      )
      .returning({ id: adminAmountCaptures.id });
    return rows.length > 0;
  }

  async close(
    scope: TenantContext,
    id: string,
    reason: AdminAmountCaptureCloseReason,
    at: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(adminAmountCaptures)
      .set({ closedAt: at, closeReason: reason })
      .where(
        and(
          eq(adminAmountCaptures.tenantId, tenantId),
          eq(adminAmountCaptures.id, id),
          isNull(adminAmountCaptures.closedAt),
        ),
      )
      .returning({ id: adminAmountCaptures.id });
    return rows.length > 0;
  }
}

function toRecord(row: typeof adminAmountCaptures.$inferSelect): AdminAmountCaptureRecord {
  return {
    id: row.id,
    botInstanceId: row.botInstanceId as BotInstanceId,
    adminId: row.adminId,
    paymentId: row.paymentId as PaymentId,
    // `admin_amount_captures_purpose_check` is built from the contract enum.
    purpose: row.purpose as AdminCapturePurpose,
    amountMinor: row.amountMinor,
    reason: row.reason,
    openedAt: row.openedAt,
    expiresAt: row.expiresAt,
    closedAt: row.closedAt,
    // The CHECK constraint is what makes this cast safe; the column is a closed set.
    closeReason: row.closeReason as AdminAmountCaptureCloseReason | null,
  };
}
