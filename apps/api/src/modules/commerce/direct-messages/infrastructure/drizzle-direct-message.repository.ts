import { and, desc, eq, gte, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import {
  ticketReplyFileTypeOf,
  type CustomerNotificationState,
  type CustomerStatus,
  type DirectMessageContentKind,
  type DirectMessageFileMimeType,
  type TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  admins,
  botInstances,
  customerDirectMessages,
  customerNotifications,
  customers,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  DirectMessageDraft,
  DirectMessageHistoryRow,
  DirectMessageRecord,
  DirectMessageRepository,
  DirectMessageTarget,
} from '../application/ports.js';

/**
 * The advisory lock class of a tenant's direct messages ('DM'). Taken first by every send;
 * nothing else takes it, so it is never part of another lock order.
 */
export const DIRECT_MESSAGE_LOCK_CLASS = 0x444d;

/** The columns a record is built from — never the bytes. */
const recordColumns = {
  id: customerDirectMessages.id,
  customerId: customerDirectMessages.customerId,
  botInstanceId: customerDirectMessages.botInstanceId,
  authorAdminId: customerDirectMessages.authorAdminId,
  contentKind: customerDirectMessages.contentKind,
  body: customerDirectMessages.body,
  fileMimeType: customerDirectMessages.fileMimeType,
  fileName: customerDirectMessages.fileName,
  fileByteLength: customerDirectMessages.fileByteLength,
  fileSha256: customerDirectMessages.fileSha256,
  fileStaged: sql<boolean>`${customerDirectMessages.fileContent} IS NOT NULL`,
  idempotencyKey: customerDirectMessages.idempotencyKey,
  requestHash: customerDirectMessages.requestHash,
  createdAt: customerDirectMessages.createdAt,
};

type RecordRow = {
  readonly id: string;
  readonly customerId: string;
  readonly botInstanceId: string;
  readonly authorAdminId: string;
  readonly contentKind: string;
  readonly body: string | null;
  readonly fileMimeType: string | null;
  readonly fileName: string | null;
  readonly fileByteLength: number | null;
  readonly fileSha256: string | null;
  readonly fileStaged: boolean;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly createdAt: Date;
};

function toRecord(row: RecordRow): DirectMessageRecord {
  const type = row.fileMimeType === null ? undefined : ticketReplyFileTypeOf(row.fileMimeType);
  return {
    id: row.id,
    customerId: row.customerId,
    botInstanceId: row.botInstanceId,
    authorAdminId: row.authorAdminId,
    contentKind: row.contentKind as DirectMessageContentKind,
    body: row.body,
    file:
      type === undefined || row.fileName === null || row.fileByteLength === null
        ? null
        : {
            kind: type.kind,
            mimeType: type.mimeType as DirectMessageFileMimeType,
            fileName: row.fileName,
            byteLength: row.fileByteLength,
            sha256: row.fileSha256 ?? '',
            staged: row.fileStaged,
          },
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    createdAt: row.createdAt,
  };
}

/**
 * Direct messages and their lane rows (Phase A2). Every query carries the tenant; the
 * history JOINS the lane row by its subject key — `(tenant, kind, subject_id)` — rather than
 * copying its state, so what the operator reads is exactly where the lane is.
 */
export class DrizzleDirectMessageRepository implements DirectMessageRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async lockTenant(scope: TenantContext, tx: TransactionScope): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(
      sql`SELECT pg_advisory_xact_lock(${DIRECT_MESSAGE_LOCK_CLASS}, hashtext(${tenantId}))`,
    );
  }

  async customerExists(scope: TenantContext, customerId: string): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
      .limit(1);
    return row !== undefined;
  }

  async target(
    scope: TenantContext,
    customerId: string,
    tx: TransactionScope,
  ): Promise<DirectMessageTarget | null> {
    const tenantId = requireTenantId(scope);
    const [customer] = await this.exec(tx)
      .select({
        id: customers.id,
        status: customers.status,
        botId: customers.firstBotInstanceId,
      })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
      .for('share');
    if (customer === undefined) return null;
    let activeBotInstanceId: string | null = null;
    if (customer.botId !== null) {
      const [bot] = await this.exec(tx)
        .select({ id: botInstances.id })
        .from(botInstances)
        .where(
          and(
            eq(botInstances.tenantId, tenantId),
            eq(botInstances.id, customer.botId),
            eq(botInstances.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      activeBotInstanceId = bot?.id ?? null;
    }
    return {
      customerId: customer.id,
      status: customer.status as CustomerStatus,
      activeBotInstanceId,
    };
  }

  async findByKey(
    scope: TenantContext,
    idempotencyKey: string,
    tx: TransactionScope,
  ): Promise<DirectMessageRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select(recordColumns)
      .from(customerDirectMessages)
      .where(
        and(
          eq(customerDirectMessages.tenantId, tenantId),
          eq(customerDirectMessages.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async countByAdminSince(
    scope: TenantContext,
    adminId: string,
    since: Date,
    tx: TransactionScope,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select({ n: sql<number>`count(*)::int` })
      .from(customerDirectMessages)
      .where(
        and(
          eq(customerDirectMessages.tenantId, tenantId),
          eq(customerDirectMessages.authorAdminId, adminId),
          gte(customerDirectMessages.createdAt, since),
        ),
      );
    return Number(row?.n ?? 0);
  }

  async countByCustomerSince(
    scope: TenantContext,
    customerId: string,
    since: Date,
    tx: TransactionScope,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select({ n: sql<number>`count(*)::int` })
      .from(customerDirectMessages)
      .where(
        and(
          eq(customerDirectMessages.tenantId, tenantId),
          eq(customerDirectMessages.customerId, customerId),
          gte(customerDirectMessages.createdAt, since),
        ),
      );
    return Number(row?.n ?? 0);
  }

  async stagedBytes(scope: TenantContext, tx: TransactionScope): Promise<number> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select({
        total: sql<string>`coalesce(sum(${customerDirectMessages.fileByteLength}), 0)`,
      })
      .from(customerDirectMessages)
      .where(
        and(
          eq(customerDirectMessages.tenantId, tenantId),
          isNotNull(customerDirectMessages.fileContent),
        ),
      );
    return Number(row?.total ?? 0);
  }

  async insert(scope: TenantContext, draft: DirectMessageDraft, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    await this.exec(tx)
      .insert(customerDirectMessages)
      .values({
        id: draft.id,
        tenantId,
        customerId: draft.customerId,
        botInstanceId: draft.botInstanceId,
        authorAdminId: draft.authorAdminId,
        contentKind: draft.contentKind,
        body: draft.body,
        ...(draft.file === null
          ? {}
          : {
              fileMimeType: draft.file.mimeType,
              fileName: draft.file.fileName,
              fileByteLength: draft.file.bytes.byteLength,
              fileSha256: draft.file.sha256,
              fileContent: Buffer.from(
                draft.file.bytes.buffer,
                draft.file.bytes.byteOffset,
                draft.file.bytes.byteLength,
              ),
            }),
        idempotencyKey: draft.idempotencyKey,
        requestHash: draft.requestHash,
        createdAt: draft.now,
      });
  }

  async find(scope: TenantContext, id: string, tx?: unknown): Promise<DirectMessageRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select(recordColumns)
      .from(customerDirectMessages)
      .where(and(eq(customerDirectMessages.tenantId, tenantId), eq(customerDirectMessages.id, id)))
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async fileContent(scope: TenantContext, id: string): Promise<Uint8Array | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select({ content: customerDirectMessages.fileContent })
      .from(customerDirectMessages)
      .where(and(eq(customerDirectMessages.tenantId, tenantId), eq(customerDirectMessages.id, id)))
      .limit(1);
    if (row?.content === undefined || row.content === null) return null;
    return new Uint8Array(row.content.buffer, row.content.byteOffset, row.content.byteLength);
  }

  async markFileDelivered(
    scope: TenantContext,
    id: string,
    file: { readonly fileId: string; readonly fileUniqueId: string },
    at: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    /*
     * Conditional on NO handle yet, not on the bytes still being here — the ticket file's
     * rule (Codex review of #108): retention may clear the bytes between the dispatcher's
     * read and Telegram's answer, and the stamp must still land. `file_purged_at` keeps the
     * sweep's time when the bytes were already gone.
     */
    const rows = await this.exec(tx)
      .update(customerDirectMessages)
      .set({
        telegramFileId: file.fileId,
        telegramFileUniqueId: file.fileUniqueId,
        fileContent: null,
        filePurgedAt: sql`coalesce(${customerDirectMessages.filePurgedAt}, ${at})`,
      })
      .where(
        and(
          eq(customerDirectMessages.tenantId, tenantId),
          eq(customerDirectMessages.id, id),
          isNotNull(customerDirectMessages.fileMimeType),
          isNull(customerDirectMessages.telegramFileId),
        ),
      )
      .returning({ id: customerDirectMessages.id });
    return rows.length > 0;
  }

  async purgeFileContentBefore(cutoff: Date, at: Date, limit: number): Promise<number> {
    // Oldest first, bounded, only rows still holding bytes; SKIP LOCKED so a delivery
    // stamping one of these rows is never waited on.
    const rows = await this.db
      .update(customerDirectMessages)
      .set({ fileContent: null, filePurgedAt: at })
      .where(
        sql`${customerDirectMessages.id} IN (
          SELECT candidate.id FROM ${customerDirectMessages} AS candidate
           WHERE candidate.file_content IS NOT NULL AND candidate.created_at < ${cutoff}
           ORDER BY candidate.created_at ASC
           LIMIT ${Math.max(1, limit)}
           FOR UPDATE SKIP LOCKED
        )`,
      )
      .returning({ id: customerDirectMessages.id });
    return rows.length;
  }

  async history(
    scope: TenantContext,
    customerId: string,
    input: {
      readonly limit: number;
      readonly before: { readonly at: Date; readonly id: string } | null;
    },
  ): Promise<readonly DirectMessageHistoryRow[]> {
    const tenantId = requireTenantId(scope);
    const before =
      input.before === null
        ? undefined
        : or(
            lt(customerDirectMessages.createdAt, input.before.at),
            and(
              eq(customerDirectMessages.createdAt, input.before.at),
              lt(customerDirectMessages.id, input.before.id),
            ),
          );
    const rows = await this.historyQuery(tenantId)
      .where(
        and(
          eq(customerDirectMessages.tenantId, tenantId),
          eq(customerDirectMessages.customerId, customerId),
          before,
        ),
      )
      .orderBy(desc(customerDirectMessages.createdAt), desc(customerDirectMessages.id))
      .limit(Math.max(1, input.limit));
    return rows.map(toHistoryRow);
  }

  async historyRow(scope: TenantContext, id: string): Promise<DirectMessageHistoryRow | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.historyQuery(tenantId)
      .where(and(eq(customerDirectMessages.tenantId, tenantId), eq(customerDirectMessages.id, id)))
      .limit(1);
    return row === undefined ? null : toHistoryRow(row);
  }

  private historyQuery(tenantId: string) {
    return this.db
      .select({
        ...recordColumns,
        authorUsername: admins.username,
        laneState: customerNotifications.state,
        laneSendStartedAt: customerNotifications.sendStartedAt,
        laneAttempts: customerNotifications.attempts,
        laneResolvedAt: customerNotifications.resolvedAt,
      })
      .from(customerDirectMessages)
      .leftJoin(
        admins,
        and(
          eq(admins.tenantId, customerDirectMessages.tenantId),
          eq(admins.id, customerDirectMessages.authorAdminId),
        ),
      )
      .leftJoin(
        customerNotifications,
        and(
          eq(customerNotifications.tenantId, tenantId),
          eq(customerNotifications.subjectId, customerDirectMessages.id),
          sql`${customerNotifications.kind} = CASE ${customerDirectMessages.contentKind}
                WHEN 'TEXT' THEN 'DIRECT_MESSAGE' ELSE 'DIRECT_MESSAGE_MEDIA' END`,
        ),
      );
  }
}

function toHistoryRow(
  row: RecordRow & {
    readonly authorUsername: string | null;
    readonly laneState: string | null;
    readonly laneSendStartedAt: Date | null;
    readonly laneAttempts: number | null;
    readonly laneResolvedAt: Date | null;
  },
): DirectMessageHistoryRow {
  return {
    message: toRecord(row),
    authorUsername: row.authorUsername,
    lane:
      row.laneState === null
        ? null
        : {
            state: row.laneState as CustomerNotificationState,
            sendStarted: row.laneSendStartedAt !== null,
            attempts: row.laneAttempts ?? 0,
            resolvedAt: row.laneResolvedAt,
          },
  };
}
