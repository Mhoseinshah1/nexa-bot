import { and, eq, sql } from 'drizzle-orm';
import type { BotInstanceId, TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { clientAppVideos } from '../../../../infrastructure/persistence/schema.js';
import type {
  ClientAppVideoRecord,
  ClientAppVideoRepository,
  InboundTutorialVideo,
} from '../application/client-app-video.service.js';

/**
 * Spec §7: the tutorial video references, one per (tenant, app, bot). Every query carries the
 * tenant, and the bot: a `file_id` is valid only for the bot that received it.
 */
export class DrizzleClientAppVideoRepository implements ClientAppVideoRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async find(
    scope: TenantContext,
    clientAppId: string,
    botInstanceId: BotInstanceId,
    tx?: unknown,
  ): Promise<ClientAppVideoRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(clientAppVideos)
      .where(
        and(
          eq(clientAppVideos.tenantId, tenantId),
          eq(clientAppVideos.clientAppId, clientAppId),
          eq(clientAppVideos.botInstanceId, botInstanceId),
        ),
      )
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async appsWithVideo(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    tx?: unknown,
  ): Promise<ReadonlySet<string>> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ clientAppId: clientAppVideos.clientAppId })
      .from(clientAppVideos)
      .where(
        and(
          eq(clientAppVideos.tenantId, tenantId),
          eq(clientAppVideos.botInstanceId, botInstanceId),
        ),
      );
    return new Set(rows.map((row) => row.clientAppId));
  }

  async upsert(
    scope: TenantContext,
    draft: InboundTutorialVideo & {
      readonly id: string;
      readonly clientAppId: string;
      readonly botInstanceId: BotInstanceId;
      readonly setByAdminId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<ClientAppVideoRecord> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .insert(clientAppVideos)
      .values({
        id: draft.id,
        tenantId,
        clientAppId: draft.clientAppId,
        botInstanceId: draft.botInstanceId,
        fileId: draft.fileId,
        fileUniqueId: draft.fileUniqueId,
        mimeType: draft.mimeType,
        durationSeconds: draft.durationSeconds,
        fileSize: draft.fileSize,
        setByAdminId: draft.setByAdminId,
        createdAt: draft.now,
        updatedAt: draft.now,
      })
      .onConflictDoUpdate({
        target: [
          clientAppVideos.tenantId,
          clientAppVideos.clientAppId,
          clientAppVideos.botInstanceId,
        ],
        set: {
          fileId: draft.fileId,
          fileUniqueId: draft.fileUniqueId,
          mimeType: draft.mimeType,
          durationSeconds: draft.durationSeconds,
          fileSize: draft.fileSize,
          setByAdminId: draft.setByAdminId,
          version: sql`${clientAppVideos.version} + 1`,
          updatedAt: draft.now,
        },
      })
      .returning();
    if (row === undefined) throw new Error('client_app_videos upsert returned no row.');
    return toRecord(row);
  }

  async remove(
    scope: TenantContext,
    clientAppId: string,
    botInstanceId: BotInstanceId,
    tx: unknown,
  ): Promise<ClientAppVideoRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .delete(clientAppVideos)
      .where(
        and(
          eq(clientAppVideos.tenantId, tenantId),
          eq(clientAppVideos.clientAppId, clientAppId),
          eq(clientAppVideos.botInstanceId, botInstanceId),
        ),
      )
      .returning();
    return row === undefined ? null : toRecord(row);
  }
}

function toRecord(row: typeof clientAppVideos.$inferSelect): ClientAppVideoRecord {
  return {
    id: row.id,
    clientAppId: row.clientAppId,
    botInstanceId: row.botInstanceId as BotInstanceId,
    fileId: row.fileId,
    fileUniqueId: row.fileUniqueId,
    mimeType: row.mimeType,
    durationSeconds: row.durationSeconds,
    fileSize: row.fileSize,
    setByAdminId: row.setByAdminId,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
