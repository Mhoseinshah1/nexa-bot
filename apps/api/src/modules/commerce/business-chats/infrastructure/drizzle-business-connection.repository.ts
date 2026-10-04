import { and, desc, eq, gt, isNull, lt, ne, sql } from 'drizzle-orm';
import type { BusinessBotRight, ScopeContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  botInstances,
  telegramBusinessConnections,
} from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  BusinessConnectionRecord,
  BusinessConnectionReport,
  BusinessConnectionRepository,
} from '../application/ports.js';

type Row = typeof telegramBusinessConnections.$inferSelect;

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

function toRecord(row: Row): BusinessConnectionRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    botInstanceId: row.botInstanceId,
    connectionId: row.connectionId,
    ownerTelegramUserId: row.ownerTelegramUserId,
    ownerUserChatId: row.ownerUserChatId,
    isEnabled: row.isEnabled,
    rights: (row.rights ?? []) as BusinessBotRight[],
    connectedAt: row.connectedAt,
    lastConfirmedAt: row.lastConfirmedAt,
    supersededAt: row.supersededAt,
    version: row.version,
  };
}

export class DrizzleBusinessConnectionRepository implements BusinessConnectionRepository {
  constructor(private readonly db: Database) {}

  async find(
    scope: ScopeContext,
    botInstanceId: string,
    connectionId: string,
    tx?: unknown,
  ): Promise<BusinessConnectionRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(telegramBusinessConnections)
      .where(
        and(
          eq(telegramBusinessConnections.tenantId, tenantId),
          eq(telegramBusinessConnections.botInstanceId, botInstanceId),
          eq(telegramBusinessConnections.connectionId, connectionId),
        ),
      )
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async findById(
    scope: ScopeContext,
    id: string,
    tx?: unknown,
  ): Promise<BusinessConnectionRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(telegramBusinessConnections)
      .where(
        and(
          eq(telegramBusinessConnections.tenantId, tenantId),
          eq(telegramBusinessConnections.id, id),
        ),
      )
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async list(scope: ScopeContext): Promise<readonly BusinessConnectionRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(telegramBusinessConnections)
      .where(eq(telegramBusinessConnections.tenantId, tenantId))
      .orderBy(desc(telegramBusinessConnections.connectedAt))
      .limit(100);
    return rows.map(toRecord);
  }

  async lock(
    scope: ScopeContext,
    botInstanceId: string,
    connectionId: string,
    tx: unknown,
  ): Promise<BusinessConnectionRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(telegramBusinessConnections)
      .where(
        and(
          eq(telegramBusinessConnections.tenantId, tenantId),
          eq(telegramBusinessConnections.botInstanceId, botInstanceId),
          eq(telegramBusinessConnections.connectionId, connectionId),
        ),
      )
      .for('update')
      .limit(1);
    return row ? toRecord(row) : null;
  }

  /**
   * ON CONFLICT DO NOTHING, then a locked read: two first reports of one connection,
   * delivered concurrently, both pass `lock` finding nothing. The loser's insert becomes a
   * no-op and it reads the winner's row, under the same lock, instead of failing on the
   * unique index.
   */
  async insert(
    scope: ScopeContext,
    row: {
      readonly id: string;
      readonly botInstanceId: string;
      readonly report: BusinessConnectionReport;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<{ readonly record: BusinessConnectionRecord; readonly inserted: boolean }> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);
    const created = await executor
      .insert(telegramBusinessConnections)
      .values({
        id: row.id,
        tenantId,
        botInstanceId: row.botInstanceId,
        connectionId: row.report.connectionId,
        ownerTelegramUserId: row.report.ownerTelegramUserId,
        ownerUserChatId: row.report.ownerUserChatId,
        isEnabled: row.report.isEnabled,
        rights: [...row.report.rights],
        connectedAt: row.report.connectedAt,
        lastConfirmedAt: row.now,
        createdAt: row.now,
        updatedAt: row.now,
      })
      .onConflictDoNothing({
        target: [
          telegramBusinessConnections.botInstanceId,
          telegramBusinessConnections.connectionId,
        ],
      })
      .returning({ id: telegramBusinessConnections.id });
    const stored = await this.lock(scope, row.botInstanceId, row.report.connectionId, tx);
    if (stored === null) {
      throw new Error('telegram_business_connections: the inserted row is not readable in scope.');
    }
    return { record: stored, inserted: created.length > 0 };
  }

  async update(
    scope: ScopeContext,
    id: string,
    report: BusinessConnectionReport,
    now: Date,
    tx: unknown,
  ): Promise<BusinessConnectionRecord> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .update(telegramBusinessConnections)
      .set({
        ownerTelegramUserId: report.ownerTelegramUserId,
        ownerUserChatId: report.ownerUserChatId,
        isEnabled: report.isEnabled,
        rights: [...report.rights],
        connectedAt: report.connectedAt,
        lastConfirmedAt: now,
        version: sql`${telegramBusinessConnections.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(telegramBusinessConnections.tenantId, tenantId),
          eq(telegramBusinessConnections.id, id),
        ),
      )
      .returning();
    if (row === undefined) {
      throw new Error('telegram_business_connections: the locked row vanished before its update.');
    }
    return toRecord(row);
  }

  async confirm(scope: ScopeContext, id: string, now: Date, tx: unknown): Promise<void> {
    const tenantId = requireTenantId(scope);
    await executorOf(this.db, tx)
      .update(telegramBusinessConnections)
      .set({ lastConfirmedAt: now })
      .where(
        and(
          eq(telegramBusinessConnections.tenantId, tenantId),
          eq(telegramBusinessConnections.id, id),
        ),
      );
  }

  async supersedeOthers(
    scope: ScopeContext,
    input: {
      readonly botInstanceId: string;
      readonly ownerTelegramUserId: string;
      readonly keepId: string;
      readonly olderThan: Date;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<readonly BusinessConnectionRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .update(telegramBusinessConnections)
      .set({
        supersededAt: input.now,
        version: sql`${telegramBusinessConnections.version} + 1`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(telegramBusinessConnections.tenantId, tenantId),
          eq(telegramBusinessConnections.botInstanceId, input.botInstanceId),
          eq(telegramBusinessConnections.ownerTelegramUserId, input.ownerTelegramUserId),
          ne(telegramBusinessConnections.id, input.keepId),
          isNull(telegramBusinessConnections.supersededAt),
          lt(telegramBusinessConnections.connectedAt, input.olderThan),
        ),
      )
      .returning();
    return rows.map(toRecord);
  }

  async hasNewerLive(
    scope: ScopeContext,
    input: {
      readonly botInstanceId: string;
      readonly ownerTelegramUserId: string;
      readonly connectedAt: Date;
      readonly excludeId: string;
    },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .select({ id: telegramBusinessConnections.id })
      .from(telegramBusinessConnections)
      .where(
        and(
          eq(telegramBusinessConnections.tenantId, tenantId),
          eq(telegramBusinessConnections.botInstanceId, input.botInstanceId),
          eq(telegramBusinessConnections.ownerTelegramUserId, input.ownerTelegramUserId),
          ne(telegramBusinessConnections.id, input.excludeId),
          isNull(telegramBusinessConnections.supersededAt),
          gt(telegramBusinessConnections.connectedAt, input.connectedAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async markSuperseded(
    scope: ScopeContext,
    id: string,
    now: Date,
    tx: unknown,
  ): Promise<BusinessConnectionRecord> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .update(telegramBusinessConnections)
      .set({
        supersededAt: now,
        version: sql`${telegramBusinessConnections.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(telegramBusinessConnections.tenantId, tenantId),
          eq(telegramBusinessConnections.id, id),
        ),
      )
      .returning();
    if (row === undefined) {
      throw new Error('telegram_business_connections: the row vanished before its supersession.');
    }
    return toRecord(row);
  }

  async ownBotId(scope: ScopeContext, botInstanceId: string): Promise<string | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select({ telegramBotId: botInstances.telegramBotId })
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.id, botInstanceId)))
      .limit(1);
    return row?.telegramBotId ?? null;
  }
}
