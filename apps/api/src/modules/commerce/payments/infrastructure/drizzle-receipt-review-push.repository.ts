import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type {
  AdminId,
  BotInstanceId,
  PaymentId,
  PaymentReceiptId,
  ReceiptReviewPushState,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { receiptReviewPushes } from '../../../../infrastructure/persistence/schema.js';
import type {
  ReceiptReviewPushRecord,
  ReceiptReviewPushRepository,
} from '../application/receipt-review-push-ports.js';

type Row = typeof receiptReviewPushes.$inferSelect;

function toRecord(row: Row): ReceiptReviewPushRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    paymentId: row.paymentId as PaymentId,
    receiptId: row.receiptId as PaymentReceiptId,
    adminId: row.adminId as AdminId,
    botInstanceId: row.botInstanceId as BotInstanceId,
    // `receipt_review_pushes_state_check` is built from the contract enum.
    state: row.state as ReceiptReviewPushState,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    sendStartedAt: row.sendStartedAt,
    chatId: row.chatId,
    lastErrorCode: row.lastErrorCode,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
  };
}

/**
 * The administrators' receipt push lane (ADR-0031), in PostgreSQL.
 *
 * The customer lane's repository (`DrizzleCustomerNotificationRepository`) is the model and
 * the reasoning is the same: a claim is a conditional UPDATE that moves `next_attempt_at` to a
 * lease, a send is stamped before it leaves, and an outcome is recorded only on a row still
 * PENDING — so a row the reaper has already made UNKNOWN is never re-opened by a straggler.
 */
export class DrizzleReceiptReviewPushRepository implements ReceiptReviewPushRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async enqueue(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly paymentId: PaymentId;
      readonly receiptId: PaymentReceiptId;
      readonly adminId: AdminId;
      readonly botInstanceId: BotInstanceId;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(receiptReviewPushes)
      .values({
        id: input.id,
        tenantId,
        paymentId: input.paymentId,
        receiptId: input.receiptId,
        adminId: input.adminId,
        botInstanceId: input.botInstanceId,
        state: 'PENDING',
        attempts: 0,
        nextAttemptAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [
          receiptReviewPushes.tenantId,
          receiptReviewPushes.receiptId,
          receiptReviewPushes.adminId,
        ],
      })
      .returning({ id: receiptReviewPushes.id });
    return rows.length > 0;
  }

  async claimDue(
    scope: TenantContext,
    now: Date,
    leaseUntil: Date,
    limit: number,
  ): Promise<readonly ReceiptReviewPushRecord[]> {
    const tenantId = requireTenantId(scope);
    const ready = or(
      isNull(receiptReviewPushes.nextAttemptAt),
      lte(receiptReviewPushes.nextAttemptAt, now),
    );
    const due = this.db
      .select({ id: receiptReviewPushes.id })
      .from(receiptReviewPushes)
      .where(
        and(
          eq(receiptReviewPushes.tenantId, tenantId),
          eq(receiptReviewPushes.state, 'PENDING'),
          // A row whose send started is the reaper's, never the claim's: re-claiming it is
          // exactly the duplicate this lane exists not to send.
          isNull(receiptReviewPushes.sendStartedAt),
          ready,
        ),
      )
      .orderBy(asc(receiptReviewPushes.createdAt), asc(receiptReviewPushes.id))
      .limit(limit);

    const rows = await this.db
      .update(receiptReviewPushes)
      .set({ nextAttemptAt: leaseUntil, updatedAt: now })
      .where(
        and(
          eq(receiptReviewPushes.tenantId, tenantId),
          sql`${receiptReviewPushes.id} IN ${due}`,
          eq(receiptReviewPushes.state, 'PENDING'),
          isNull(receiptReviewPushes.sendStartedAt),
          ready,
        ),
      )
      .returning();
    return rows
      .map(toRecord)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  async markSendStarted(
    scope: TenantContext,
    id: string,
    chatId: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(receiptReviewPushes)
      .set({ sendStartedAt: now, chatId, updatedAt: now })
      .where(
        and(
          eq(receiptReviewPushes.tenantId, tenantId),
          eq(receiptReviewPushes.id, id),
          eq(receiptReviewPushes.state, 'PENDING'),
          isNull(receiptReviewPushes.sendStartedAt),
        ),
      )
      .returning({ id: receiptReviewPushes.id });
    return rows.length > 0;
  }

  async record(
    scope: TenantContext,
    id: string,
    to: ReceiptReviewPushState,
    input: {
      readonly spend: boolean;
      readonly nextAttemptAt: Date | null;
      readonly lastErrorCode: string | null;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(receiptReviewPushes)
      .set({
        state: to,
        attempts: input.spend
          ? sql`${receiptReviewPushes.attempts} + 1`
          : receiptReviewPushes.attempts,
        nextAttemptAt: input.nextAttemptAt,
        lastErrorCode: input.lastErrorCode,
        resolvedAt: to === 'PENDING' ? null : now,
        sendStartedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(receiptReviewPushes.tenantId, tenantId),
          eq(receiptReviewPushes.id, id),
          eq(receiptReviewPushes.state, 'PENDING'),
        ),
      )
      .returning({ id: receiptReviewPushes.id });
    return rows.length > 0;
  }

  async reapStranded(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly ReceiptReviewPushRecord[]> {
    const tenantId = requireTenantId(scope);
    const stranded = this.exec(tx)
      .select({ id: receiptReviewPushes.id })
      .from(receiptReviewPushes)
      .where(
        and(
          eq(receiptReviewPushes.tenantId, tenantId),
          eq(receiptReviewPushes.state, 'PENDING'),
          sql`${receiptReviewPushes.sendStartedAt} IS NOT NULL`,
          or(
            isNull(receiptReviewPushes.nextAttemptAt),
            lte(receiptReviewPushes.nextAttemptAt, now),
          ),
        ),
      )
      .limit(limit);
    const rows = await this.exec(tx)
      .update(receiptReviewPushes)
      .set({
        state: 'UNKNOWN',
        lastErrorCode: 'push.send_stranded',
        resolvedAt: now,
        nextAttemptAt: null,
        sendStartedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(receiptReviewPushes.tenantId, tenantId),
          sql`${receiptReviewPushes.id} IN ${stranded}`,
          eq(receiptReviewPushes.state, 'PENDING'),
          sql`${receiptReviewPushes.sendStartedAt} IS NOT NULL`,
        ),
      )
      .returning();
    return rows.map(toRecord);
  }

  async listForPayment(
    scope: TenantContext,
    paymentId: PaymentId,
  ): Promise<readonly ReceiptReviewPushRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(receiptReviewPushes)
      .where(
        and(
          eq(receiptReviewPushes.tenantId, tenantId),
          eq(receiptReviewPushes.paymentId, paymentId),
        ),
      )
      .orderBy(asc(receiptReviewPushes.createdAt), asc(receiptReviewPushes.id));
    return rows.map(toRecord);
  }
}
