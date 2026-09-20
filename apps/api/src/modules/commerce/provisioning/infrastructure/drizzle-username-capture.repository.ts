import { and, eq, isNull, sql } from 'drizzle-orm';
import type { TenantContext, UsernameCaptureCloseReason } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { usernameCaptures } from '../../../../infrastructure/persistence/schema.js';
import type {
  UsernameCaptureRecord,
  UsernameCaptureRepository,
} from '../application/username-ports.js';

/**
 * The advisory-lock CLASS for a customer's username work.
 *
 * Its own class, distinct from `RECEIPT_CAPTURE_LOCK_CLASS`, so two locks about
 * different subjects cannot collide however their object keys are derived. Exported so
 * an integration test can watch `pg_locks` for waiters on exactly this key rather than
 * sleeping and hoping.
 */
export const USERNAME_CAPTURE_LOCK_CLASS = 0x554e;

/** The username-entry window, in PostgreSQL. Modelled on `DrizzleReceiptCaptureRepository`. */
export class DrizzleUsernameCaptureRepository implements UsernameCaptureRepository {
  constructor(private readonly db: Database) {}

  async lockForCustomer(
    scope: TenantContext,
    botInstanceId: string,
    customerId: string,
    tx: TransactionScope,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    // The TENANT is in the key although the bot id is already unique, because a lock a
    // tenant id cannot be read out of is a lock whose collisions cross tenants.
    await tx.tx.execute(
      sql`SELECT pg_advisory_xact_lock(${USERNAME_CAPTURE_LOCK_CLASS},
            hashtext(${`${tenantId}:${botInstanceId}:${customerId}`}))`,
    );
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
    tx: TransactionScope,
  ): Promise<UsernameCaptureRecord> {
    const tenantId = requireTenantId(scope);
    /*
     * The close reason is DERIVED from the row being closed, not fixed at `SUPERSEDED`.
     *
     * A window whose deadline had already passed was not superseded by anything —
     * nobody typed a name in time — and this is the only place that distinction gets
     * recorded. A refusal cannot record it, because a refusal throws and a throw rolls
     * back its own transaction; so the next tap is what stamps the old row.
     */
    await tx.tx
      .update(usernameCaptures)
      .set({
        closedAt: input.openedAt,
        closeReason: sql`CASE WHEN ${usernameCaptures.expiresAt} <= ${input.openedAt} THEN 'EXPIRED' ELSE 'SUPERSEDED' END`,
      })
      .where(
        and(
          eq(usernameCaptures.tenantId, tenantId),
          eq(usernameCaptures.botInstanceId, input.botInstanceId),
          eq(usernameCaptures.customerId, input.customerId),
          isNull(usernameCaptures.closedAt),
        ),
      );

    const [row] = await tx.tx
      .insert(usernameCaptures)
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
    if (row === undefined) throw new Error('username_captures insert returned no row.');
    return toRecord(row);
  }

  async findOpen(
    scope: TenantContext,
    botInstanceId: string,
    customerId: string,
    tx: TransactionScope,
  ): Promise<UsernameCaptureRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await tx.tx
      .select()
      .from(usernameCaptures)
      .where(
        and(
          eq(usernameCaptures.tenantId, tenantId),
          eq(usernameCaptures.botInstanceId, botInstanceId),
          eq(usernameCaptures.customerId, customerId),
          isNull(usernameCaptures.closedAt),
        ),
      )
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async close(
    scope: TenantContext,
    id: string,
    reason: UsernameCaptureCloseReason,
    at: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    // Conditional on STILL BEING OPEN, so a redelivered message cannot rewrite the
    // reason a window already closed for.
    const rows = await tx.tx
      .update(usernameCaptures)
      .set({ closedAt: at, closeReason: reason })
      .where(
        and(
          eq(usernameCaptures.tenantId, tenantId),
          eq(usernameCaptures.id, id),
          isNull(usernameCaptures.closedAt),
        ),
      )
      .returning({ id: usernameCaptures.id });
    return rows.length > 0;
  }
}

function toRecord(row: typeof usernameCaptures.$inferSelect): UsernameCaptureRecord {
  return {
    id: row.id,
    botInstanceId: row.botInstanceId,
    customerId: row.customerId,
    orderId: row.orderId,
    openedAt: row.openedAt,
    expiresAt: row.expiresAt,
  };
}
