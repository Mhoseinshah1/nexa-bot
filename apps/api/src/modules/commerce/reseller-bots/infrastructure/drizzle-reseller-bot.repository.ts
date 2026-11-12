import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import type { CurrencyCode, TenantContext, UserId } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { ScopeBound } from '../../../../infrastructure/persistence/database-scope.js';
import {
  auditLogs,
  hostedBotActivationLinks,
  resellerBotFeeCharges,
  resellerBotFeeNotices,
  resellerBotRequests,
} from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  ResellerBotChargeRecord,
  ResellerBotLifecycleMark,
  ResellerBotNoticeRecord,
  ResellerBotRepository,
  ResellerBotRequestRecord,
} from '../application/ports.js';
import {
  RESELLER_BOT_RESUME_AUDIT_ACTION as RESELLER_BOT_RESUME_ACTION,
  RESELLER_BOT_STOP_AUDIT_ACTION as RESELLER_BOT_STOP_ACTION,
} from '../application/reseller-bot-fee.service.js';

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

type Row = typeof resellerBotRequests.$inferSelect;

function toRecord(row: Row): ResellerBotRequestRecord {
  return {
    id: row.id,
    number: row.number,
    customerId: row.customerId as UserId,
    status: row.status as ResellerBotRequestRecord['status'],
    telegramBotId: row.telegramBotId,
    botUsername: row.botUsername,
    tokenCiphertext: row.tokenCiphertext,
    tokenKeyId: row.tokenKeyId,
    domain: row.domain,
    feeAmountMinor: row.feeAmountMinor,
    feeCurrency: row.feeCurrency as CurrencyCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    decidedAt: row.decidedAt,
    decidedByAdminId: row.decidedByAdminId,
    rejectReason: row.rejectReason,
    cancelledAt: row.cancelledAt,
    hostedTenantId: row.hostedTenantId,
    linkedAt: row.linkedAt,
    paidThrough: row.paidThrough,
    lastPeriod: row.lastPeriod,
    feeStoppedAt: row.feeStoppedAt,
    activationLinkId: row.activationLinkId,
    activationLinkCiphertext: row.activationLinkCiphertext,
    activationLinkKeyId: row.activationLinkKeyId,
    activationLinkSentAt: row.activationLinkSentAt,
  };
}

/**
 * Reseller-phase PR-6: the dedicated-bot requests, their fee debits and notices — every row the
 * INSTALLATION tenant's, every statement scoped through `requireTenantId` (row-level security
 * binds the same tenant). Every state change is a conditional UPDATE naming its `from` state.
 */
@ScopeBound()
export class DrizzleResellerBotRepository implements ResellerBotRepository {
  constructor(private readonly db: Database) {}

  async insert(
    scope: TenantContext,
    row: Parameters<ResellerBotRepository['insert']>[1],
    tx: unknown,
  ): Promise<ResellerBotRequestRecord> {
    const [inserted] = await executorOf(this.db, tx)
      .insert(resellerBotRequests)
      .values({
        id: row.id,
        tenantId: requireTenantId(scope),
        customerId: row.customerId,
        status: 'PENDING',
        telegramBotId: row.telegramBotId,
        botUsername: row.botUsername,
        tokenCiphertext: row.tokenCiphertext,
        tokenKeyId: row.tokenKeyId,
        domain: row.domain,
        feeAmountMinor: row.feeAmountMinor,
        feeCurrency: row.feeCurrency,
        createdAt: row.now,
        updatedAt: row.now,
      })
      .returning();
    return toRecord(inserted as Row);
  }

  async find(
    scope: TenantContext,
    id: string,
    tx?: unknown,
    lock = false,
  ): Promise<ResellerBotRequestRecord | null> {
    const query = executorOf(this.db, tx)
      .select()
      .from(resellerBotRequests)
      .where(
        and(
          eq(resellerBotRequests.tenantId, requireTenantId(scope)),
          eq(resellerBotRequests.id, id),
        ),
      )
      .limit(1);
    const [row] = lock ? await query.for('update') : await query;
    return row === undefined ? null : toRecord(row);
  }

  async findByHosted(
    scope: TenantContext,
    hostedTenantId: string,
    tx?: unknown,
    lock = false,
  ): Promise<ResellerBotRequestRecord | null> {
    const query = executorOf(this.db, tx)
      .select()
      .from(resellerBotRequests)
      .where(
        and(
          eq(resellerBotRequests.tenantId, requireTenantId(scope)),
          eq(resellerBotRequests.hostedTenantId, hostedTenantId),
        ),
      )
      .limit(1);
    const [row] = lock ? await query.for('update') : await query;
    return row === undefined ? null : toRecord(row);
  }

  async findPendingByCustomer(
    scope: TenantContext,
    customerId: UserId,
    tx?: unknown,
  ): Promise<ResellerBotRequestRecord | null> {
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(resellerBotRequests)
      .where(
        and(
          eq(resellerBotRequests.tenantId, requireTenantId(scope)),
          eq(resellerBotRequests.customerId, customerId),
          eq(resellerBotRequests.status, 'PENDING'),
        ),
      )
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async liveBotTaken(scope: TenantContext, telegramBotId: string, tx?: unknown): Promise<boolean> {
    const [row] = await executorOf(this.db, tx)
      .select({ id: resellerBotRequests.id })
      .from(resellerBotRequests)
      .where(
        and(
          eq(resellerBotRequests.tenantId, requireTenantId(scope)),
          eq(resellerBotRequests.telegramBotId, telegramBotId),
          inArray(resellerBotRequests.status, ['PENDING', 'APPROVED']),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async listByCustomer(
    scope: TenantContext,
    customerId: UserId,
  ): Promise<ResellerBotRequestRecord[]> {
    const rows = await this.db
      .select()
      .from(resellerBotRequests)
      .where(
        and(
          eq(resellerBotRequests.tenantId, requireTenantId(scope)),
          eq(resellerBotRequests.customerId, customerId),
        ),
      )
      .orderBy(desc(resellerBotRequests.createdAt), desc(resellerBotRequests.id));
    return rows.map(toRecord);
  }

  async listAll(scope: TenantContext, limit: number): Promise<ResellerBotRequestRecord[]> {
    const rows = await this.db
      .select()
      .from(resellerBotRequests)
      .where(eq(resellerBotRequests.tenantId, requireTenantId(scope)))
      .orderBy(desc(resellerBotRequests.createdAt), desc(resellerBotRequests.id))
      .limit(limit);
    return rows.map(toRecord);
  }

  async approve(
    scope: TenantContext,
    id: string,
    input: { readonly adminId: string; readonly paidThrough: Date; readonly now: Date },
    tx: unknown,
  ): Promise<boolean> {
    const rows = await executorOf(this.db, tx)
      .update(resellerBotRequests)
      .set({
        status: 'APPROVED',
        decidedAt: input.now,
        decidedByAdminId: input.adminId,
        paidThrough: input.paidThrough,
        lastPeriod: 1,
        updatedAt: input.now,
      })
      .where(this.pending(scope, id))
      .returning({ id: resellerBotRequests.id });
    return rows.length > 0;
  }

  async reject(
    scope: TenantContext,
    id: string,
    input: { readonly adminId: string; readonly reason: string; readonly now: Date },
    tx: unknown,
  ): Promise<boolean> {
    const rows = await executorOf(this.db, tx)
      .update(resellerBotRequests)
      .set({
        status: 'REJECTED',
        decidedAt: input.now,
        decidedByAdminId: input.adminId,
        rejectReason: input.reason,
        updatedAt: input.now,
      })
      .where(this.pending(scope, id))
      .returning({ id: resellerBotRequests.id });
    return rows.length > 0;
  }

  async cancel(scope: TenantContext, id: string, now: Date, tx: unknown): Promise<boolean> {
    const rows = await executorOf(this.db, tx)
      .update(resellerBotRequests)
      .set({ status: 'CANCELLED', cancelledAt: now, updatedAt: now })
      .where(this.pending(scope, id))
      .returning({ id: resellerBotRequests.id });
    return rows.length > 0;
  }

  async link(
    scope: TenantContext,
    id: string,
    hostedTenantId: string,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const rows = await executorOf(this.db, tx)
      .update(resellerBotRequests)
      .set({ hostedTenantId, linkedAt: now, updatedAt: now })
      .where(
        and(
          eq(resellerBotRequests.tenantId, requireTenantId(scope)),
          eq(resellerBotRequests.id, id),
          eq(resellerBotRequests.status, 'APPROVED'),
          isNull(resellerBotRequests.hostedTenantId),
        ),
      )
      .returning({ id: resellerBotRequests.id });
    return rows.length > 0;
  }

  async advance(
    scope: TenantContext,
    id: string,
    input: {
      readonly fromPeriod: number;
      readonly period: number;
      readonly paidThrough: Date;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean> {
    const rows = await executorOf(this.db, tx)
      .update(resellerBotRequests)
      .set({ lastPeriod: input.period, paidThrough: input.paidThrough, updatedAt: input.now })
      .where(
        and(
          eq(resellerBotRequests.tenantId, requireTenantId(scope)),
          eq(resellerBotRequests.id, id),
          eq(resellerBotRequests.status, 'APPROVED'),
          eq(resellerBotRequests.lastPeriod, input.fromPeriod),
        ),
      )
      .returning({ id: resellerBotRequests.id });
    return rows.length > 0;
  }

  async setFeeStopped(
    scope: TenantContext,
    id: string,
    stoppedAt: Date | null,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const rows = await executorOf(this.db, tx)
      .update(resellerBotRequests)
      .set({ feeStoppedAt: stoppedAt, updatedAt: now })
      .where(
        and(
          eq(resellerBotRequests.tenantId, requireTenantId(scope)),
          eq(resellerBotRequests.id, id),
          eq(resellerBotRequests.status, 'APPROVED'),
          stoppedAt === null
            ? isNotNull(resellerBotRequests.feeStoppedAt)
            : isNull(resellerBotRequests.feeStoppedAt),
        ),
      )
      .returning({ id: resellerBotRequests.id });
    return rows.length > 0;
  }

  async setActivationLink(
    scope: TenantContext,
    id: string,
    link: {
      readonly linkId: string;
      readonly ciphertext: string;
      readonly keyId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void> {
    await executorOf(this.db, tx)
      .update(resellerBotRequests)
      .set({
        activationLinkId: link.linkId,
        activationLinkCiphertext: link.ciphertext,
        activationLinkKeyId: link.keyId,
        activationLinkSentAt: link.now,
        updatedAt: link.now,
      })
      .where(
        and(
          eq(resellerBotRequests.tenantId, requireTenantId(scope)),
          eq(resellerBotRequests.id, id),
        ),
      );
  }

  async findByOpenLink(
    scope: TenantContext,
    linkId: string,
    now: Date,
  ): Promise<{ readonly request: ResellerBotRequestRecord; readonly expiresAt: Date } | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select({ request: resellerBotRequests, expiresAt: hostedBotActivationLinks.expiresAt })
      .from(resellerBotRequests)
      .innerJoin(
        hostedBotActivationLinks,
        and(
          eq(hostedBotActivationLinks.tenantId, resellerBotRequests.tenantId),
          eq(hostedBotActivationLinks.id, resellerBotRequests.activationLinkId),
          eq(hostedBotActivationLinks.hostedTenantId, resellerBotRequests.hostedTenantId),
        ),
      )
      .where(
        and(
          eq(resellerBotRequests.tenantId, tenantId),
          eq(resellerBotRequests.activationLinkId, linkId),
          isNull(hostedBotActivationLinks.usedAt),
          isNull(hostedBotActivationLinks.revokedAt),
          gt(hostedBotActivationLinks.expiresAt, now),
        ),
      )
      .limit(1);
    return row === undefined ? null : { request: toRecord(row.request), expiresAt: row.expiresAt };
  }

  async dueIds(scope: TenantContext, now: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ id: resellerBotRequests.id })
      .from(resellerBotRequests)
      .where(
        and(
          eq(resellerBotRequests.tenantId, requireTenantId(scope)),
          eq(resellerBotRequests.status, 'APPROVED'),
          isNotNull(resellerBotRequests.hostedTenantId),
          lte(resellerBotRequests.paidThrough, now),
        ),
      )
      .orderBy(asc(resellerBotRequests.paidThrough), asc(resellerBotRequests.id))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  async insertCharge(
    scope: TenantContext,
    row: Omit<ResellerBotChargeRecord, 'createdAt'> & { readonly now: Date },
    tx: unknown,
  ): Promise<boolean> {
    const rows = await executorOf(this.db, tx)
      .insert(resellerBotFeeCharges)
      .values({
        id: row.id,
        tenantId: requireTenantId(scope),
        requestId: row.requestId,
        period: row.period,
        kind: row.kind,
        walletEntryId: row.walletEntryId,
        amountMinor: row.amountMinor,
        currency: row.currency,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        createdAt: row.now,
      })
      .onConflictDoNothing()
      .returning({ id: resellerBotFeeCharges.id });
    return rows.length > 0;
  }

  async listCharges(
    scope: TenantContext,
    requestIds: readonly string[],
  ): Promise<ResellerBotChargeRecord[]> {
    if (requestIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(resellerBotFeeCharges)
      .where(
        and(
          eq(resellerBotFeeCharges.tenantId, requireTenantId(scope)),
          inArray(resellerBotFeeCharges.requestId, [...requestIds]),
        ),
      )
      .orderBy(asc(resellerBotFeeCharges.requestId), asc(resellerBotFeeCharges.period));
    return rows.map((row) => ({
      id: row.id,
      requestId: row.requestId,
      period: row.period,
      kind: row.kind as ResellerBotChargeRecord['kind'],
      walletEntryId: row.walletEntryId,
      amountMinor: row.amountMinor,
      currency: row.currency as CurrencyCode,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      createdAt: row.createdAt,
    }));
  }

  async insertNotice(
    scope: TenantContext,
    row: {
      readonly id: string;
      readonly requestId: string;
      readonly period: number;
      readonly noticeDay: string;
      readonly deadline: Date;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<ResellerBotNoticeRecord | null> {
    const rows = await executorOf(this.db, tx)
      .insert(resellerBotFeeNotices)
      .values({
        id: row.id,
        tenantId: requireTenantId(scope),
        requestId: row.requestId,
        period: row.period,
        noticeDay: row.noticeDay,
        deadline: row.deadline,
        createdAt: row.now,
      })
      .onConflictDoNothing()
      .returning({ id: resellerBotFeeNotices.id });
    return rows.length === 0
      ? null
      : {
          id: row.id,
          requestId: row.requestId,
          period: row.period,
          noticeDay: row.noticeDay,
          deadline: row.deadline,
        };
  }

  async findNotice(scope: TenantContext, id: string): Promise<ResellerBotNoticeRecord | null> {
    const [row] = await this.db
      .select()
      .from(resellerBotFeeNotices)
      .where(
        and(
          eq(resellerBotFeeNotices.tenantId, requireTenantId(scope)),
          eq(resellerBotFeeNotices.id, id),
        ),
      )
      .limit(1);
    return row === undefined
      ? null
      : {
          id: row.id,
          requestId: row.requestId,
          period: row.period,
          noticeDay: row.noticeDay,
          deadline: row.deadline,
        };
  }

  async lifecycleMarks(
    scope: TenantContext,
    requestIds: readonly string[],
  ): Promise<ResellerBotLifecycleMark[]> {
    if (requestIds.length === 0) return [];
    const rows = await this.db
      .select({
        entityId: auditLogs.entityId,
        action: auditLogs.action,
        at: auditLogs.occurredAt,
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, requireTenantId(scope)),
          eq(auditLogs.entityType, 'ResellerBotRequest'),
          inArray(auditLogs.entityId, [...requestIds]),
          inArray(auditLogs.action, [RESELLER_BOT_STOP_ACTION, RESELLER_BOT_RESUME_ACTION]),
          eq(auditLogs.result, 'SUCCESS'),
        ),
      )
      .orderBy(asc(auditLogs.occurredAt));
    return rows.map((row) => ({
      requestId: row.entityId as string,
      event: row.action === RESELLER_BOT_STOP_ACTION ? 'STOPPED' : 'RESUMED',
      at: row.at,
    }));
  }

  private pending(scope: TenantContext, id: string) {
    return and(
      eq(resellerBotRequests.tenantId, requireTenantId(scope)),
      eq(resellerBotRequests.id, id),
      eq(resellerBotRequests.status, 'PENDING'),
    );
  }
}
