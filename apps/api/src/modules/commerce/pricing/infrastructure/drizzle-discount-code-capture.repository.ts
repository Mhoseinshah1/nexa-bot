import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DiscountCodeCaptureCloseReason, TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { discountCodeCaptures } from '../../../../infrastructure/persistence/schema.js';
import type {
  DiscountCodeCaptureRecord,
  DiscountCodeCaptureRepository,
} from '../application/ports.js';

/**
 * Discount-code windows, in PostgreSQL (`docs/wp8-pricing-audit.md` P11).
 *
 * `DrizzleUsernameCaptureRepository`, line for line where the question is the same: the
 * window is a ROW, one per customer and bot is enforced by a partial unique index, and
 * every close is conditional on the window still being open.
 *
 * There is no lock method here. The caller takes the username lane's window lock, the
 * SAME advisory lock, because the two windows answer one question — what does this
 * customer's next plain message mean — and must never both be open.
 */
export class DrizzleDiscountCodeCaptureRepository implements DiscountCodeCaptureRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async open(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly botInstanceId: string;
      readonly customerId: string;
      readonly orderId: string;
      readonly openedAt: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<DiscountCodeCaptureRecord> {
    const tenantId = requireTenantId(scope);
    // Close first, in this transaction: the partial unique index refuses a second open
    // row, and splitting the two statements would leave the customer with no window.
    await this.exec(tx)
      .update(discountCodeCaptures)
      .set({
        closedAt: input.openedAt,
        closeReason: sql`CASE WHEN ${discountCodeCaptures.expiresAt} <= ${input.openedAt} THEN 'EXPIRED' ELSE 'SUPERSEDED' END`,
      })
      .where(
        and(
          eq(discountCodeCaptures.tenantId, tenantId),
          eq(discountCodeCaptures.botInstanceId, input.botInstanceId),
          eq(discountCodeCaptures.customerId, input.customerId),
          isNull(discountCodeCaptures.closedAt),
        ),
      );
    const [row] = await this.exec(tx)
      .insert(discountCodeCaptures)
      .values({
        id: input.id,
        tenantId,
        botInstanceId: input.botInstanceId,
        customerId: input.customerId,
        orderId: input.orderId,
        openedAt: input.openedAt,
        expiresAt: input.expiresAt,
      })
      .returning();
    if (row === undefined) throw new Error('discount_code_captures insert returned no row.');
    return toRecord(row);
  }

  async findOpen(
    scope: TenantContext,
    botInstanceId: string,
    customerId: string,
    tx: unknown,
  ): Promise<DiscountCodeCaptureRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(discountCodeCaptures)
      .where(
        and(
          eq(discountCodeCaptures.tenantId, tenantId),
          eq(discountCodeCaptures.botInstanceId, botInstanceId),
          eq(discountCodeCaptures.customerId, customerId),
          isNull(discountCodeCaptures.closedAt),
        ),
      )
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async close(
    scope: TenantContext,
    id: string,
    reason: DiscountCodeCaptureCloseReason,
    at: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(discountCodeCaptures)
      .set({ closedAt: at, closeReason: reason })
      .where(
        and(
          eq(discountCodeCaptures.tenantId, tenantId),
          eq(discountCodeCaptures.id, id),
          isNull(discountCodeCaptures.closedAt),
        ),
      )
      .returning({ id: discountCodeCaptures.id });
    return rows.length > 0;
  }
}

function toRecord(row: typeof discountCodeCaptures.$inferSelect): DiscountCodeCaptureRecord {
  return {
    id: row.id,
    botInstanceId: row.botInstanceId,
    customerId: row.customerId,
    orderId: row.orderId,
    openedAt: row.openedAt,
    expiresAt: row.expiresAt,
  };
}
