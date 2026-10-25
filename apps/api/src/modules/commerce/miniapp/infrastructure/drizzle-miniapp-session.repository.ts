import { eq } from 'drizzle-orm';
import type { BotInstanceId, TenantContext, TenantId, UserId } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { miniAppSessions } from '../../../../infrastructure/persistence/schema.js';
import type { MiniAppSessionRecord, MiniAppSessionRepository } from '../application/ports.js';

/** Mini-app sessions in PostgreSQL. The launch key's uniqueness is the replay rule. */
export class DrizzleMiniAppSessionRepository implements MiniAppSessionRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async insert(
    scope: TenantContext,
    record: MiniAppSessionRecord,
    tx: unknown,
  ): Promise<'INSERTED' | 'ALREADY_MINTED'> {
    const tenantId = requireTenantId(scope);
    if (tenantId !== record.tenantId)
      throw new Error('A session must be written in its own tenant.');
    const rows = await this.exec(tx)
      .insert(miniAppSessions)
      .values({
        id: record.id,
        tenantId,
        botInstanceId: record.botInstanceId,
        customerId: record.customerId,
        telegramUserId: record.telegramUserId,
        initDataHash: record.initDataHash,
        tokenHash: record.tokenHash,
        authDate: record.authDate,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      })
      .onConflictDoNothing({
        target: [
          miniAppSessions.tenantId,
          miniAppSessions.botInstanceId,
          miniAppSessions.initDataHash,
        ],
      })
      .returning({ id: miniAppSessions.id });
    return rows.length > 0 ? 'INSERTED' : 'ALREADY_MINTED';
  }

  async findById(id: string): Promise<MiniAppSessionRecord | null> {
    const [row] = await this.db
      .select()
      .from(miniAppSessions)
      .where(eq(miniAppSessions.id, id))
      .limit(1);
    if (row === undefined) return null;
    return {
      id: row.id,
      tenantId: row.tenantId as TenantId,
      botInstanceId: row.botInstanceId as BotInstanceId,
      customerId: row.customerId as UserId,
      telegramUserId: row.telegramUserId,
      initDataHash: row.initDataHash,
      tokenHash: row.tokenHash,
      authDate: row.authDate,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }
}
