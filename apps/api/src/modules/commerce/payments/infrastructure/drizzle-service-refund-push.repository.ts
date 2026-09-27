import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type {
  AdminId,
  BotInstanceId,
  ReceiptReviewPushState,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { serviceRefundRequestPushes } from '../../../../infrastructure/persistence/schema.js';
import type {
  ServiceRefundPushRecord,
  ServiceRefundPushRepository,
} from '../application/service-refund-push-ports.js';

type Row = typeof serviceRefundRequestPushes.$inferSelect;

function toRecord(row: Row): ServiceRefundPushRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    requestId: row.requestId,
    adminId: row.adminId as AdminId,
    botInstanceId: row.botInstanceId as BotInstanceId,
    // `service_refund_request_pushes_state_check` is built from the contract enum.
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
 * The administrators' refund-request review cards (WP19), in PostgreSQL — the receipt
 * push lane's repository (ADR-0031) over its own table.
 *
 * The customer lane's repository (`DrizzleCustomerNotificationRepository`) is the model and
 * the reasoning is the same: a claim is a conditional UPDATE that moves `next_attempt_at` to a
 * lease, a send is stamped before it leaves, and an outcome is recorded only on a row still
 * PENDING — so a row the reaper has already made UNKNOWN is never re-opened by a straggler.
 */
export class DrizzleServiceRefundPushRepository implements ServiceRefundPushRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async enqueue(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly requestId: string;
      readonly adminId: AdminId;
      readonly botInstanceId: BotInstanceId;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(serviceRefundRequestPushes)
      .values({
        id: input.id,
        tenantId,
        requestId: input.requestId,
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
          serviceRefundRequestPushes.tenantId,
          serviceRefundRequestPushes.requestId,
          serviceRefundRequestPushes.adminId,
        ],
      })
      .returning({ id: serviceRefundRequestPushes.id });
    return rows.length > 0;
  }

  async claimDue(
    scope: TenantContext,
    now: Date,
    leaseUntil: Date,
    limit: number,
  ): Promise<readonly ServiceRefundPushRecord[]> {
    const tenantId = requireTenantId(scope);
    const ready = or(
      isNull(serviceRefundRequestPushes.nextAttemptAt),
      lte(serviceRefundRequestPushes.nextAttemptAt, now),
    );
    const due = this.db
      .select({ id: serviceRefundRequestPushes.id })
      .from(serviceRefundRequestPushes)
      .where(
        and(
          eq(serviceRefundRequestPushes.tenantId, tenantId),
          eq(serviceRefundRequestPushes.state, 'PENDING'),
          // A row whose send started is the reaper's, never the claim's: re-claiming it is
          // exactly the duplicate this lane exists not to send.
          isNull(serviceRefundRequestPushes.sendStartedAt),
          ready,
        ),
      )
      .orderBy(asc(serviceRefundRequestPushes.createdAt), asc(serviceRefundRequestPushes.id))
      .limit(limit);

    const rows = await this.db
      .update(serviceRefundRequestPushes)
      .set({ nextAttemptAt: leaseUntil, updatedAt: now })
      .where(
        and(
          eq(serviceRefundRequestPushes.tenantId, tenantId),
          sql`${serviceRefundRequestPushes.id} IN ${due}`,
          eq(serviceRefundRequestPushes.state, 'PENDING'),
          isNull(serviceRefundRequestPushes.sendStartedAt),
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
      .update(serviceRefundRequestPushes)
      .set({ sendStartedAt: now, chatId, updatedAt: now })
      .where(
        and(
          eq(serviceRefundRequestPushes.tenantId, tenantId),
          eq(serviceRefundRequestPushes.id, id),
          eq(serviceRefundRequestPushes.state, 'PENDING'),
          isNull(serviceRefundRequestPushes.sendStartedAt),
        ),
      )
      .returning({ id: serviceRefundRequestPushes.id });
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
      .update(serviceRefundRequestPushes)
      .set({
        state: to,
        attempts: input.spend
          ? sql`${serviceRefundRequestPushes.attempts} + 1`
          : serviceRefundRequestPushes.attempts,
        nextAttemptAt: input.nextAttemptAt,
        lastErrorCode: input.lastErrorCode,
        resolvedAt: to === 'PENDING' ? null : now,
        sendStartedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(serviceRefundRequestPushes.tenantId, tenantId),
          eq(serviceRefundRequestPushes.id, id),
          eq(serviceRefundRequestPushes.state, 'PENDING'),
        ),
      )
      .returning({ id: serviceRefundRequestPushes.id });
    return rows.length > 0;
  }

  async reapStranded(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly ServiceRefundPushRecord[]> {
    const tenantId = requireTenantId(scope);
    const stranded = this.exec(tx)
      .select({ id: serviceRefundRequestPushes.id })
      .from(serviceRefundRequestPushes)
      .where(
        and(
          eq(serviceRefundRequestPushes.tenantId, tenantId),
          eq(serviceRefundRequestPushes.state, 'PENDING'),
          sql`${serviceRefundRequestPushes.sendStartedAt} IS NOT NULL`,
          or(
            isNull(serviceRefundRequestPushes.nextAttemptAt),
            lte(serviceRefundRequestPushes.nextAttemptAt, now),
          ),
        ),
      )
      .limit(limit);
    const rows = await this.exec(tx)
      .update(serviceRefundRequestPushes)
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
          eq(serviceRefundRequestPushes.tenantId, tenantId),
          sql`${serviceRefundRequestPushes.id} IN ${stranded}`,
          eq(serviceRefundRequestPushes.state, 'PENDING'),
          sql`${serviceRefundRequestPushes.sendStartedAt} IS NOT NULL`,
        ),
      )
      .returning();
    return rows.map(toRecord);
  }

  async listForRequest(
    scope: TenantContext,
    requestId: string,
  ): Promise<readonly ServiceRefundPushRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(serviceRefundRequestPushes)
      .where(
        and(
          eq(serviceRefundRequestPushes.tenantId, tenantId),
          eq(serviceRefundRequestPushes.requestId, requestId),
        ),
      )
      .orderBy(asc(serviceRefundRequestPushes.createdAt), asc(serviceRefundRequestPushes.id));
    return rows.map(toRecord);
  }
}
