import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  TICKET_ACTIVE_STATUSES,
  type AdminId,
  type BotInstanceId,
  type CustomerNotificationState,
  type TenantContext,
  type TicketAttachmentKind,
  type TicketCategoryId,
  type TicketId,
  type TicketMessageId,
  type TicketMessageSender,
  type TicketPriority,
  type TicketReplyFileMimeType,
  type TicketStatus,
  type TicketSystemEvent,
  type TicketOrigin,
  type UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  admins,
  customerNotifications,
  customers,
  ticketMessages,
  ticketReplyFiles,
  tickets,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  TicketListFilter,
  TicketListItem,
  TicketMessageInsert,
  TicketMessageListItem,
  TicketMessageRecord,
  TicketRecord,
  TicketReplyFileRecord,
  TicketRepository,
} from '../application/ports.js';

/** One customer's ticket openings, serialised (`lockCustomer`). 'TK'. */
export const TICKET_CUSTOMER_LOCK_CLASS = 0x544b;
/** One tenant's staging of support's files, serialised (`lockReplyFileStaging`). 'TF'. */
export const TICKET_REPLY_FILE_LOCK_CLASS = 0x5446;

/**
 * The `TICKET_REPLY_ATTACHMENT` lane row, joined beside the `TICKET_REPLY` one: the same
 * table under a second name, so one message reads both of its deliveries in one query.
 */
const attachmentNotifications = alias(customerNotifications, 'attachment_notifications');

/** Every column but the bytes: nothing that lists or describes a file ever loads them. */
const replyFileColumns = {
  messageId: ticketReplyFiles.messageId,
  ticketId: ticketReplyFiles.ticketId,
  botInstanceId: ticketReplyFiles.botInstanceId,
  kind: ticketReplyFiles.kind,
  mimeType: ticketReplyFiles.mimeType,
  fileName: ticketReplyFiles.fileName,
  byteLength: ticketReplyFiles.byteLength,
  sha256: ticketReplyFiles.sha256,
  purgedAt: ticketReplyFiles.purgedAt,
  telegramFileId: ticketReplyFiles.telegramFileId,
  telegramFileUniqueId: ticketReplyFiles.telegramFileUniqueId,
  createdAt: ticketReplyFiles.createdAt,
};

type ReplyFileRow = {
  readonly messageId: string;
  readonly ticketId: string;
  readonly botInstanceId: string;
  readonly kind: string;
  readonly mimeType: string;
  readonly fileName: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly purgedAt: Date | null;
  readonly telegramFileId: string | null;
  readonly telegramFileUniqueId: string | null;
  readonly createdAt: Date;
};

function toReplyFile(row: ReplyFileRow): TicketReplyFileRecord {
  return {
    messageId: row.messageId as TicketMessageId,
    ticketId: row.ticketId as TicketId,
    botInstanceId: row.botInstanceId as BotInstanceId,
    // Casts rather than re-validation: both columns' CHECKs are built from the contract.
    kind: row.kind as TicketAttachmentKind,
    mimeType: row.mimeType as TicketReplyFileMimeType,
    fileName: row.fileName,
    byteLength: row.byteLength,
    sha256: row.sha256,
    // `purged_at` is set exactly when the bytes are gone (`ticket_reply_files_content_check`).
    staged: row.purgedAt === null,
    telegramFileId: row.telegramFileId,
    telegramFileUniqueId: row.telegramFileUniqueId,
    createdAt: row.createdAt,
  };
}

type TicketRow = typeof tickets.$inferSelect;
type MessageRow = typeof ticketMessages.$inferSelect;

function toTicket(row: TicketRow): TicketRecord {
  return {
    id: row.id as TicketId,
    // An identity bounded far below 2^53 in any installation's lifetime.
    number: Number(row.number),
    customerId: row.customerId as UserId,
    botInstanceId: row.botInstanceId as BotInstanceId,
    categoryId: row.categoryId as TicketCategoryId,
    categoryTitle: row.categoryTitle,
    subject: row.subject,
    // Casts rather than re-validation: each column's CHECK is built from the contract enum.
    status: row.status as TicketStatus,
    priority: row.priority as TicketPriority,
    assignedAdminId: row.assignedAdminId as AdminId | null,
    serviceId: row.serviceId,
    orderId: row.orderId,
    paymentId: row.paymentId,
    openingKey: row.openingKey,
    origin: row.origin as TicketOrigin,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastMessageAt: row.lastMessageAt,
    closedAt: row.closedAt,
  };
}

function toMessage(row: MessageRow): TicketMessageRecord {
  return {
    id: row.id as TicketMessageId,
    ticketId: row.ticketId as TicketId,
    senderType: row.senderType as TicketMessageSender,
    authorAdminId: row.authorAdminId as AdminId | null,
    body: row.body,
    systemEvent: row.systemEvent as TicketSystemEvent | null,
    attachment:
      row.attachmentKind === null ||
      row.attachmentFileId === null ||
      row.attachmentFileUniqueId === null ||
      row.attachmentBotInstanceId === null
        ? null
        : {
            kind: row.attachmentKind as TicketAttachmentKind,
            botInstanceId: row.attachmentBotInstanceId as BotInstanceId,
            fileId: row.attachmentFileId,
            fileUniqueId: row.attachmentFileUniqueId,
            mimeType: row.attachmentMimeType,
            fileName: row.attachmentFileName,
            fileSize: row.attachmentFileSize,
          },
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    createdAt: row.createdAt,
  };
}

/**
 * Tickets and their messages, in PostgreSQL. Every query carries the tenant.
 */
export class DrizzleTicketRepository implements TicketRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async lockCustomer(scope: TenantContext, customerId: UserId, tx: unknown): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(
      sql`SELECT pg_advisory_xact_lock(${TICKET_CUSTOMER_LOCK_CLASS},
            hashtext(${`${tenantId}:${customerId}`}))`,
    );
  }

  async countActiveForCustomer(
    scope: TenantContext,
    customerId: UserId,
    botInstanceId: BotInstanceId,
    tx: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ total: count() })
      .from(tickets)
      .where(
        and(
          eq(tickets.tenantId, tenantId),
          eq(tickets.customerId, customerId),
          eq(tickets.botInstanceId, botInstanceId),
          inArray(tickets.status, [...TICKET_ACTIVE_STATUSES]),
        ),
      );
    return Number(rows[0]?.total ?? 0);
  }

  async findByOpeningKey(
    scope: TenantContext,
    key: string,
    tx?: unknown,
  ): Promise<TicketRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(tickets)
      .where(and(eq(tickets.tenantId, tenantId), eq(tickets.openingKey, key)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toTicket(row);
  }

  async create(
    scope: TenantContext,
    input: {
      readonly id: TicketId;
      readonly customerId: UserId;
      readonly botInstanceId: BotInstanceId;
      readonly categoryId: TicketCategoryId;
      readonly categoryTitle: string;
      readonly subject: string | null;
      readonly openingKey: string;
      readonly origin?: TicketOrigin;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<TicketRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(tickets)
      .values({
        id: input.id,
        tenantId,
        customerId: input.customerId,
        botInstanceId: input.botInstanceId,
        categoryId: input.categoryId,
        categoryTitle: input.categoryTitle,
        subject: input.subject,
        status: 'OPEN',
        priority: 'NORMAL',
        openingKey: input.openingKey,
        origin: input.origin ?? 'BOT',
        createdAt: input.now,
        updatedAt: input.now,
        lastMessageAt: input.now,
      })
      .returning();
    const row = rows[0];
    /* istanbul ignore next -- an INSERT ... RETURNING that inserted returns its row. */
    if (row === undefined) throw new Error('A ticket insert returned no row.');
    return toTicket(row);
  }

  async latestActiveForCustomer(
    scope: TenantContext,
    customerId: UserId,
    tx: unknown,
  ): Promise<TicketRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.tenantId, tenantId),
          eq(tickets.customerId, customerId),
          inArray(tickets.status, [...TICKET_ACTIVE_STATUSES]),
        ),
      )
      .orderBy(desc(tickets.lastMessageAt), desc(tickets.id))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toTicket(row);
  }

  async findById(scope: TenantContext, id: string, tx?: unknown): Promise<TicketRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(tickets)
      .where(and(eq(tickets.tenantId, tenantId), eq(tickets.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toTicket(row);
  }

  async findByIdForUpdate(
    scope: TenantContext,
    id: string,
    tx: unknown,
  ): Promise<TicketRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(tickets)
      .where(and(eq(tickets.tenantId, tenantId), eq(tickets.id, id)))
      .limit(1)
      .for('update');
    const row = rows[0];
    return row === undefined ? null : toTicket(row);
  }

  async moveStatus(
    scope: TenantContext,
    id: TicketId,
    from: TicketStatus,
    to: TicketStatus,
    at: Date,
    options: { readonly touch: boolean },
    tx: unknown,
  ): Promise<TicketRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(tickets)
      .set({
        status: to,
        closedAt: to === 'CLOSED' ? at : null,
        updatedAt: at,
        ...(options.touch ? { lastMessageAt: at } : {}),
      })
      .where(and(eq(tickets.tenantId, tenantId), eq(tickets.id, id), eq(tickets.status, from)))
      .returning();
    const row = rows[0];
    return row === undefined ? null : toTicket(row);
  }

  async setAssignee(
    scope: TenantContext,
    id: TicketId,
    expected: AdminId | null,
    next: AdminId | null,
    at: Date,
    tx: unknown,
  ): Promise<TicketRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(tickets)
      .set({ assignedAdminId: next, updatedAt: at })
      .where(
        and(
          eq(tickets.tenantId, tenantId),
          eq(tickets.id, id),
          expected === null
            ? isNull(tickets.assignedAdminId)
            : eq(tickets.assignedAdminId, expected),
        ),
      )
      .returning();
    const row = rows[0];
    return row === undefined ? null : toTicket(row);
  }

  async setPriority(
    scope: TenantContext,
    id: TicketId,
    expected: TicketPriority,
    next: TicketPriority,
    at: Date,
    tx: unknown,
  ): Promise<TicketRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(tickets)
      .set({ priority: next, updatedAt: at })
      .where(
        and(eq(tickets.tenantId, tenantId), eq(tickets.id, id), eq(tickets.priority, expected)),
      )
      .returning();
    const row = rows[0];
    return row === undefined ? null : toTicket(row);
  }

  async setLinks(
    scope: TenantContext,
    id: TicketId,
    links: {
      readonly serviceId: string | null;
      readonly orderId: string | null;
      readonly paymentId: string | null;
    },
    at: Date,
    tx: unknown,
  ): Promise<TicketRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(tickets)
      .set({ ...links, updatedAt: at })
      .where(and(eq(tickets.tenantId, tenantId), eq(tickets.id, id)))
      .returning();
    const row = rows[0];
    /* istanbul ignore next -- the caller holds the row lock on a row it just read. */
    if (row === undefined) throw new Error('A locked ticket vanished.');
    return toTicket(row);
  }

  async listForCustomer(
    scope: TenantContext,
    customerId: UserId,
    botInstanceId: BotInstanceId,
    limit: number,
  ): Promise<readonly TicketRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.tenantId, tenantId),
          eq(tickets.customerId, customerId),
          eq(tickets.botInstanceId, botInstanceId),
        ),
      )
      // Active tickets first — the ones a customer can still write in — then the newest.
      .orderBy(
        sql`CASE WHEN ${tickets.status} = 'CLOSED' THEN 1 ELSE 0 END`,
        desc(tickets.lastMessageAt),
        desc(tickets.id),
      )
      .limit(Math.max(1, limit));
    return rows.map(toTicket);
  }

  private listSelect(tx?: unknown) {
    return this.exec(tx)
      .select({
        ticket: tickets,
        customerTelegramUserId: customers.telegramUserId,
        customerUsername: customers.username,
        customerFirstName: customers.firstName,
        customerLastName: customers.lastName,
        assignedAdminUsername: admins.username,
      })
      .from(tickets)
      .leftJoin(
        customers,
        and(eq(customers.tenantId, tickets.tenantId), eq(customers.id, tickets.customerId)),
      )
      .leftJoin(
        admins,
        and(eq(admins.tenantId, tickets.tenantId), eq(admins.id, tickets.assignedAdminId)),
      );
  }

  async list(scope: TenantContext, filter: TicketListFilter): Promise<readonly TicketListItem[]> {
    const tenantId = requireTenantId(scope);
    // A customer was named and nobody matched: the answer is no rows, not every row.
    if (filter.customerId === null) return [];
    const rows = await this.listSelect()
      .where(
        and(
          eq(tickets.tenantId, tenantId),
          filter.status === undefined ? undefined : eq(tickets.status, filter.status),
          filter.statuses === undefined ? undefined : inArray(tickets.status, [...filter.statuses]),
          filter.categoryId === undefined ? undefined : eq(tickets.categoryId, filter.categoryId),
          filter.customerId === undefined ? undefined : eq(tickets.customerId, filter.customerId),
          filter.assignedAdminId === undefined
            ? undefined
            : filter.assignedAdminId === null
              ? isNull(tickets.assignedAdminId)
              : eq(tickets.assignedAdminId, filter.assignedAdminId),
          filter.from === undefined
            ? undefined
            : sql`${tickets.createdAt} >= ${filter.from.toISOString()}::timestamptz`,
          filter.to === undefined
            ? undefined
            : sql`${tickets.createdAt} < ${filter.to.toISOString()}::timestamptz`,
          // The keyset, newest first, on the immutable `(created_at, id)`.
          filter.before === undefined
            ? undefined
            : sql`(${tickets.createdAt}, ${tickets.id}) < (${filter.before.at.toISOString()}::timestamptz, ${filter.before.id}::uuid)`,
        ),
      )
      .orderBy(desc(tickets.createdAt), desc(tickets.id))
      .limit(Math.max(1, filter.limit));
    return rows.map(toListItem);
  }

  async findListItem(
    scope: TenantContext,
    id: string,
    tx?: unknown,
  ): Promise<TicketListItem | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.listSelect(tx)
      .where(and(eq(tickets.tenantId, tenantId), eq(tickets.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toListItem(row);
  }

  async findMessageByKey(
    scope: TenantContext,
    key: string,
    tx?: unknown,
  ): Promise<TicketMessageRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(ticketMessages)
      .where(and(eq(ticketMessages.tenantId, tenantId), eq(ticketMessages.idempotencyKey, key)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toMessage(row);
  }

  async findMessageById(
    scope: TenantContext,
    id: string,
    tx?: unknown,
  ): Promise<TicketMessageRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(ticketMessages)
      .where(and(eq(ticketMessages.tenantId, tenantId), eq(ticketMessages.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toMessage(row);
  }

  async insertMessage(
    scope: TenantContext,
    input: TicketMessageInsert,
    tx: unknown,
  ): Promise<TicketMessageRecord | null> {
    const tenantId = requireTenantId(scope);
    const attachment = input.attachment;
    const rows = await this.exec(tx)
      .insert(ticketMessages)
      .values({
        id: input.id,
        tenantId,
        ticketId: input.ticketId,
        senderType: input.senderType,
        authorAdminId: input.authorAdminId,
        body: input.body,
        systemEvent: input.systemEvent,
        attachmentKind: attachment?.kind ?? null,
        attachmentBotInstanceId: attachment?.botInstanceId ?? null,
        attachmentFileId: attachment?.fileId ?? null,
        attachmentFileUniqueId: attachment?.fileUniqueId ?? null,
        attachmentMimeType: attachment?.mimeType ?? null,
        attachmentFileName: attachment?.fileName ?? null,
        attachmentFileSize: attachment?.fileSize ?? null,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        createdAt: input.now,
      })
      // The key's unique constraint, handled as data: a concurrent redelivery that won the
      // key waits here and then reports zero rows, and its transaction stays usable.
      .onConflictDoNothing()
      .returning();
    const row = rows[0];
    return row === undefined ? null : toMessage(row);
  }

  async countMessages(scope: TenantContext, ticketId: TicketId, tx: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ total: count() })
      .from(ticketMessages)
      .where(and(eq(ticketMessages.tenantId, tenantId), eq(ticketMessages.ticketId, ticketId)));
    return Number(rows[0]?.total ?? 0);
  }

  async messagesOf(
    scope: TenantContext,
    ticketId: TicketId,
    only?: TicketMessageId,
  ): Promise<readonly TicketMessageListItem[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select({
        message: ticketMessages,
        authorUsername: admins.username,
        delivery: customerNotifications.state,
        replyFile: replyFileColumns,
        attachmentDelivery: attachmentNotifications.state,
      })
      .from(ticketMessages)
      .leftJoin(
        admins,
        and(
          eq(admins.tenantId, ticketMessages.tenantId),
          eq(admins.id, ticketMessages.authorAdminId),
        ),
      )
      // The reply's delivery, projected from the lane's own row — one row per message by
      // `customer_notifications_subject_key` — rather than copied into the message.
      .leftJoin(
        customerNotifications,
        and(
          eq(customerNotifications.tenantId, ticketMessages.tenantId),
          eq(customerNotifications.kind, 'TICKET_REPLY'),
          eq(customerNotifications.subjectId, ticketMessages.id),
        ),
      )
      // HF-A7: support's file on the message, and ITS delivery — a second lane row.
      .leftJoin(
        ticketReplyFiles,
        and(
          eq(ticketReplyFiles.tenantId, ticketMessages.tenantId),
          eq(ticketReplyFiles.messageId, ticketMessages.id),
        ),
      )
      .leftJoin(
        attachmentNotifications,
        and(
          eq(attachmentNotifications.tenantId, ticketMessages.tenantId),
          eq(attachmentNotifications.kind, 'TICKET_REPLY_ATTACHMENT'),
          eq(attachmentNotifications.subjectId, ticketMessages.id),
        ),
      )
      .where(
        and(
          eq(ticketMessages.tenantId, tenantId),
          eq(ticketMessages.ticketId, ticketId),
          ...(only === undefined ? [] : [eq(ticketMessages.id, only)]),
        ),
      )
      .orderBy(asc(ticketMessages.seq));
    return rows.map((row) => ({
      message: toMessage(row.message),
      authorUsername: row.authorUsername,
      delivery: row.delivery === null ? null : (row.delivery as CustomerNotificationState),
      // A left join yields an all-null object for a message with no file.
      replyFile: row.replyFile === null ? null : toReplyFile(row.replyFile),
      attachmentDelivery:
        row.attachmentDelivery === null
          ? null
          : (row.attachmentDelivery as CustomerNotificationState),
    }));
  }

  async latestMessages(
    scope: TenantContext,
    ticketId: TicketId,
    limit: number,
  ): Promise<{
    readonly messages: readonly TicketMessageRecord[];
    readonly messageCount: number;
    readonly filed: ReadonlySet<string>;
  }> {
    const tenantId = requireTenantId(scope);
    const where = and(eq(ticketMessages.tenantId, tenantId), eq(ticketMessages.ticketId, ticketId));
    const [rows, totals] = await Promise.all([
      this.db
        .select({ message: ticketMessages, filedId: ticketReplyFiles.messageId })
        .from(ticketMessages)
        .leftJoin(
          ticketReplyFiles,
          and(
            eq(ticketReplyFiles.tenantId, ticketMessages.tenantId),
            eq(ticketReplyFiles.messageId, ticketMessages.id),
          ),
        )
        .where(where)
        .orderBy(desc(ticketMessages.seq))
        .limit(Math.max(1, limit)),
      this.db.select({ total: count() }).from(ticketMessages).where(where),
    ]);
    return {
      messages: rows.map((row) => toMessage(row.message)).reverse(),
      messageCount: Number(totals[0]?.total ?? 0),
      filed: new Set(rows.flatMap((row) => (row.filedId === null ? [] : [row.filedId]))),
    };
  }

  // --- HF-A7: support's files ------------------------------------------------------------

  async lockReplyFileStaging(scope: TenantContext, tx: unknown): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(
      sql`SELECT pg_advisory_xact_lock(${TICKET_REPLY_FILE_LOCK_CLASS}, hashtext(${tenantId}))`,
    );
  }

  async stagedReplyFileBytes(scope: TenantContext, tx: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ total: sql<string>`coalesce(sum(${ticketReplyFiles.byteLength}), 0)` })
      .from(ticketReplyFiles)
      .where(and(eq(ticketReplyFiles.tenantId, tenantId), isNotNull(ticketReplyFiles.content)));
    return Number(rows[0]?.total ?? 0);
  }

  async insertReplyFile(
    scope: TenantContext,
    input: Parameters<TicketRepository['insertReplyFile']>[1],
    tx: unknown,
  ): Promise<TicketReplyFileRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(ticketReplyFiles)
      .values({
        tenantId,
        messageId: input.messageId,
        ticketId: input.ticketId,
        botInstanceId: input.botInstanceId,
        kind: input.kind,
        mimeType: input.mimeType,
        fileName: input.fileName,
        byteLength: input.content.byteLength,
        sha256: input.sha256,
        content: Buffer.from(
          input.content.buffer,
          input.content.byteOffset,
          input.content.byteLength,
        ),
        createdAt: input.now,
      })
      .returning(replyFileColumns);
    const row = rows[0];
    /* istanbul ignore next -- an INSERT ... RETURNING that inserted returns its row. */
    if (row === undefined) throw new Error('A reply file insert returned no row.');
    return toReplyFile(row);
  }

  async findReplyFile(
    scope: TenantContext,
    messageId: string,
    tx?: unknown,
  ): Promise<TicketReplyFileRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select(replyFileColumns)
      .from(ticketReplyFiles)
      .where(
        and(eq(ticketReplyFiles.tenantId, tenantId), eq(ticketReplyFiles.messageId, messageId)),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toReplyFile(row);
  }

  async replyFileContent(scope: TenantContext, messageId: string): Promise<Uint8Array | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select({ content: ticketReplyFiles.content })
      .from(ticketReplyFiles)
      .where(
        and(eq(ticketReplyFiles.tenantId, tenantId), eq(ticketReplyFiles.messageId, messageId)),
      )
      .limit(1);
    const content = rows[0]?.content ?? null;
    return content === null
      ? null
      : new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  }

  async markReplyFileDelivered(
    scope: TenantContext,
    messageId: string,
    file: { readonly fileId: string; readonly fileUniqueId: string },
    at: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    /*
     * Conditional on NO handle yet, not on the bytes still being here (Codex review of #108):
     * the retention sweep may clear the bytes between the dispatcher's read and Telegram's
     * answer, and a stamp that required them would leave a delivered file with neither bytes
     * nor a handle. An existing handle is never overwritten. `purged_at` keeps the sweep's
     * time when the bytes were already gone, so both CHECKs hold either way.
     */
    const rows = await this.exec(tx)
      .update(ticketReplyFiles)
      .set({
        telegramFileId: file.fileId,
        telegramFileUniqueId: file.fileUniqueId,
        content: null,
        purgedAt: sql`coalesce(${ticketReplyFiles.purgedAt}, ${at})`,
      })
      .where(
        and(
          eq(ticketReplyFiles.tenantId, tenantId),
          eq(ticketReplyFiles.messageId, messageId),
          isNull(ticketReplyFiles.telegramFileId),
        ),
      )
      .returning({ messageId: ticketReplyFiles.messageId });
    return rows.length > 0;
  }

  async purgeReplyFileContentBefore(cutoff: Date, at: Date, limit: number): Promise<number> {
    // Oldest first, bounded, and only rows still holding bytes: the partial index's shape.
    // SKIP LOCKED, so a delivery stamping one of these rows is never waited on.
    const rows = await this.db
      .update(ticketReplyFiles)
      .set({ content: null, purgedAt: at })
      .where(
        sql`(${ticketReplyFiles.tenantId}, ${ticketReplyFiles.messageId}) IN (
          SELECT candidate.tenant_id, candidate.message_id FROM ${ticketReplyFiles} AS candidate
           WHERE candidate.content IS NOT NULL AND candidate.created_at < ${cutoff}
           ORDER BY candidate.created_at ASC
           LIMIT ${Math.max(1, limit)}
           FOR UPDATE SKIP LOCKED
        )`,
      )
      .returning({ messageId: ticketReplyFiles.messageId });
    return rows.length;
  }
}

function toListItem(row: {
  readonly ticket: TicketRow;
  readonly customerTelegramUserId: string | null;
  readonly customerUsername: string | null;
  readonly customerFirstName: string | null;
  readonly customerLastName: string | null;
  readonly assignedAdminUsername: string | null;
}): TicketListItem {
  return {
    ticket: toTicket(row.ticket),
    customer:
      row.customerTelegramUserId === null
        ? null
        : {
            telegramUserId: row.customerTelegramUserId,
            username: row.customerUsername,
            firstName: row.customerFirstName,
            lastName: row.customerLastName,
          },
    assignedAdminUsername: row.assignedAdminUsername,
  };
}
