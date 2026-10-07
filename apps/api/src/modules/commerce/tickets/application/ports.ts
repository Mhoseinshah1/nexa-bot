import type {
  AdminId,
  BotInstanceId,
  CustomerNotificationState,
  TenantContext,
  TicketAttachmentKind,
  TicketCategoryId,
  TicketId,
  TicketMessageId,
  TicketMessageSender,
  TicketPriority,
  TicketReplyFileMimeType,
  TicketStatus,
  TicketSystemEvent,
  TicketOrigin,
  BusinessHandoffReason,
  UserId,
} from '@nexa/contracts';

/**
 * The ports the ticket module owns (WP-A7, `docs/wp-a7-tickets-audit.md`).
 *
 * Every method takes a `TenantContext` and every query carries the tenant: an id is a UUID
 * and would find another tenant's row without it, and the service answers that case as
 * "no such ticket" only because the predicate makes it so.
 */

export interface TicketCategoryRecord {
  readonly id: TicketCategoryId;
  readonly title: string;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TicketRecord {
  readonly id: TicketId;
  readonly number: number;
  readonly customerId: UserId;
  readonly botInstanceId: BotInstanceId;
  readonly categoryId: TicketCategoryId;
  /** The category's title when the ticket was opened — a snapshot, never re-joined. */
  readonly categoryTitle: string;
  readonly subject: string | null;
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
  readonly assignedAdminId: AdminId | null;
  readonly serviceId: string | null;
  readonly orderId: string | null;
  readonly paymentId: string | null;
  readonly openingKey: string;
  /** TB7: `BOT`, or `BUSINESS_CHAT` when the support agent escalated a business chat. */
  readonly origin: TicketOrigin;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastMessageAt: Date;
  readonly closedAt: Date | null;
}

/** A file the customer attached: the binding and Telegram's ids, never the bytes. */
export interface TicketAttachmentRecord {
  readonly kind: TicketAttachmentKind;
  /** The bot that RECEIVED it, whose token fetches it: a `file_id` is bot-scoped. */
  readonly botInstanceId: BotInstanceId;
  readonly fileId: string;
  readonly fileUniqueId: string;
  readonly mimeType: string | null;
  readonly fileName: string | null;
  readonly fileSize: bigint | null;
}

export interface TicketMessageRecord {
  readonly id: TicketMessageId;
  readonly ticketId: TicketId;
  readonly senderType: TicketMessageSender;
  readonly authorAdminId: AdminId | null;
  readonly body: string | null;
  readonly systemEvent: TicketSystemEvent | null;
  readonly attachment: TicketAttachmentRecord | null;
  readonly idempotencyKey: string | null;
  readonly requestHash: string | null;
  readonly createdAt: Date;
}

/**
 * The file support attached to a reply (HF-A7): what it is, and where its bytes are now.
 * Never the bytes themselves — `replyFileContent` is the one read that returns them.
 */
export interface TicketReplyFileRecord {
  readonly messageId: TicketMessageId;
  readonly ticketId: TicketId;
  /** The ticket's bot: its token sends the file, and the stamped `file_id` is its. */
  readonly botInstanceId: BotInstanceId;
  readonly kind: TicketAttachmentKind;
  readonly mimeType: TicketReplyFileMimeType;
  readonly fileName: string;
  readonly byteLength: number;
  readonly sha256: string;
  /** True while the bytes are still held here, waiting for Telegram. */
  readonly staged: boolean;
  /** Telegram's handle once it accepted the file; null until then, or if it never did. */
  readonly telegramFileId: string | null;
  readonly telegramFileUniqueId: string | null;
  readonly createdAt: Date;
}

/** One message as an operator reads it: who signed it, and how far a reply got. */
export interface TicketMessageListItem {
  readonly message: TicketMessageRecord;
  readonly authorUsername: string | null;
  /** The `TICKET_REPLY` notification's state, for an ADMIN message; null otherwise. */
  readonly delivery: CustomerNotificationState | null;
  /** HF-A7: support's file on this message, when it sent one. */
  readonly replyFile: TicketReplyFileRecord | null;
  /** HF-A7: the `TICKET_REPLY_ATTACHMENT` notification's state; null without a file. */
  readonly attachmentDelivery: CustomerNotificationState | null;
}

/** One inbox row: the ticket, who filed it, and who owns it. */
export interface TicketListItem {
  readonly ticket: TicketRecord;
  readonly customer: {
    readonly telegramUserId: string;
    readonly username: string | null;
    readonly firstName: string | null;
    readonly lastName: string | null;
  } | null;
  readonly assignedAdminUsername: string | null;
}

/** The inbox's filter, already resolved to ids by the service. */
export interface TicketListFilter {
  readonly status?: TicketStatus;
  readonly categoryId?: TicketCategoryId;
  /** A resolved customer. Null means "a customer was named and none matched": no rows. */
  readonly customerId?: UserId | null;
  /** An administrator's id, or `null` for "unassigned". */
  readonly assignedAdminId?: AdminId | null;
  /** Half-open `[from, to)` on `created_at`. */
  readonly from?: Date;
  readonly to?: Date;
  readonly before?: { readonly at: Date; readonly id: string };
  readonly limit: number;
}

/** TB7: the business-chat handoffs attached to a ticket (`business_conversation_escalations`). */
export interface TicketEscalationReader {
  forTicket(
    scope: TenantContext,
    ticketId: string,
    limit: number,
  ): Promise<
    readonly {
      readonly conversationId: string;
      readonly reason: BusinessHandoffReason;
      readonly summary: string | null;
      /** Roadmap A5: the rest of the safe operator context; gated with the summary. */
      readonly topic: string | null;
      readonly intent: string | null;
      readonly stepsTried: number | null;
      readonly createdAt: Date;
    }[]
  >;
}

export interface TicketMessageInsert {
  readonly id: TicketMessageId;
  readonly ticketId: TicketId;
  readonly senderType: TicketMessageSender;
  readonly authorAdminId: AdminId | null;
  readonly body: string | null;
  readonly systemEvent: TicketSystemEvent | null;
  readonly attachment: TicketAttachmentRecord | null;
  readonly idempotencyKey: string | null;
  readonly requestHash: string | null;
  readonly now: Date;
}

export interface TicketRepository {
  /**
   * Serialises one customer's ticket openings, so two new-ticket messages arriving together
   * cannot both pass the open-ticket rail. Advisory and transaction-scoped: there is no
   * row to lock before the first ticket exists.
   */
  lockCustomer(scope: TenantContext, customerId: UserId, tx: unknown): Promise<void>;
  /** The customer's active tickets IN ONE BOT — the desk a customer sees is that bot's. */
  countActiveForCustomer(
    scope: TenantContext,
    customerId: UserId,
    botInstanceId: BotInstanceId,
    tx: unknown,
  ): Promise<number>;
  findByOpeningKey(scope: TenantContext, key: string, tx?: unknown): Promise<TicketRecord | null>;
  create(
    scope: TenantContext,
    input: {
      readonly id: TicketId;
      readonly customerId: UserId;
      readonly botInstanceId: BotInstanceId;
      readonly categoryId: TicketCategoryId;
      readonly categoryTitle: string;
      readonly subject: string | null;
      readonly openingKey: string;
      /** Defaults to `BOT`. */
      readonly origin?: TicketOrigin;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<TicketRecord>;
  /** TB7: the customer's newest active ticket in any bot, or null. */
  latestActiveForCustomer(
    scope: TenantContext,
    customerId: UserId,
    tx: unknown,
  ): Promise<TicketRecord | null>;
  findById(scope: TenantContext, id: string, tx?: unknown): Promise<TicketRecord | null>;
  /** The ticket, row-locked until the caller's transaction ends. Every write takes this first. */
  findByIdForUpdate(scope: TenantContext, id: string, tx: unknown): Promise<TicketRecord | null>;
  /**
   * The ONE status write: a conditional UPDATE naming the status it leaves. `closed_at` is
   * set when `to` is CLOSED and cleared otherwise, so the row's CHECK always holds. `touch`
   * also moves `last_message_at` (a message was written). Null when the ticket was not in
   * `from` — somebody else moved it first.
   */
  moveStatus(
    scope: TenantContext,
    id: TicketId,
    from: TicketStatus,
    to: TicketStatus,
    at: Date,
    options: { readonly touch: boolean },
    tx: unknown,
  ): Promise<TicketRecord | null>;
  /** Conditional on the assignee the caller read; null when it moved. */
  setAssignee(
    scope: TenantContext,
    id: TicketId,
    expected: AdminId | null,
    next: AdminId | null,
    at: Date,
    tx: unknown,
  ): Promise<TicketRecord | null>;
  setPriority(
    scope: TenantContext,
    id: TicketId,
    expected: TicketPriority,
    next: TicketPriority,
    at: Date,
    tx: unknown,
  ): Promise<TicketRecord | null>;
  setLinks(
    scope: TenantContext,
    id: TicketId,
    links: {
      readonly serviceId: string | null;
      readonly orderId: string | null;
      readonly paymentId: string | null;
    },
    at: Date,
    tx: unknown,
  ): Promise<TicketRecord>;
  /**
   * A customer's own tickets opened through ONE bot: the active ones first, then the newest.
   * The desk in one bot never lists another bot's tickets (Codex review of #96).
   */
  listForCustomer(
    scope: TenantContext,
    customerId: UserId,
    botInstanceId: BotInstanceId,
    limit: number,
  ): Promise<readonly TicketRecord[]>;
  list(scope: TenantContext, filter: TicketListFilter): Promise<readonly TicketListItem[]>;
  findListItem(scope: TenantContext, id: string, tx?: unknown): Promise<TicketListItem | null>;

  findMessageByKey(
    scope: TenantContext,
    key: string,
    tx?: unknown,
  ): Promise<TicketMessageRecord | null>;
  findMessageById(
    scope: TenantContext,
    id: string,
    tx?: unknown,
  ): Promise<TicketMessageRecord | null>;
  /** Null when the key is already taken — a concurrent redelivery won; the caller re-reads. */
  insertMessage(
    scope: TenantContext,
    input: TicketMessageInsert,
    tx: unknown,
  ): Promise<TicketMessageRecord | null>;
  countMessages(scope: TenantContext, ticketId: TicketId, tx: unknown): Promise<number>;
  /**
   * Every message, oldest first, with its author and delivery state — or, given `only`, that
   * one message through the SAME join, so a write's answer and the detail cannot disagree.
   */
  messagesOf(
    scope: TenantContext,
    ticketId: TicketId,
    only?: TicketMessageId,
  ): Promise<readonly TicketMessageListItem[]>;
  /**
   * The newest `limit` messages, oldest first, how many there are in all, and which of them
   * carry a file from support (HF-A7) — the bot's conversation view marks those too.
   */
  latestMessages(
    scope: TenantContext,
    ticketId: TicketId,
    limit: number,
  ): Promise<{
    readonly messages: readonly TicketMessageRecord[];
    readonly messageCount: number;
    readonly filed: ReadonlySet<string>;
  }>;

  // --- HF-A7: support's files ------------------------------------------------------------

  /**
   * Serialises one tenant's staging of support's files, so two replies arriving together
   * cannot both fit under `TICKET_REPLY_FILE_STAGED_MAX_BYTES` and together cross it.
   * Advisory and transaction-scoped.
   */
  lockReplyFileStaging(scope: TenantContext, tx: unknown): Promise<void>;
  /** The bytes this tenant holds for files Telegram has not accepted yet. */
  stagedReplyFileBytes(scope: TenantContext, tx: unknown): Promise<number>;
  insertReplyFile(
    scope: TenantContext,
    input: {
      readonly messageId: TicketMessageId;
      readonly ticketId: TicketId;
      readonly botInstanceId: BotInstanceId;
      readonly kind: TicketAttachmentKind;
      readonly mimeType: TicketReplyFileMimeType;
      readonly fileName: string;
      readonly content: Uint8Array;
      readonly sha256: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<TicketReplyFileRecord>;
  findReplyFile(
    scope: TenantContext,
    messageId: string,
    tx?: unknown,
  ): Promise<TicketReplyFileRecord | null>;
  /** The staged bytes, or null once they were cleared. The ONE read that returns them. */
  replyFileContent(scope: TenantContext, messageId: string): Promise<Uint8Array | null>;
  /**
   * Telegram accepted the file: stamp its handle and clear the bytes, conditionally on no
   * handle being stamped yet — whether or not the retention sweep already cleared the bytes.
   * False when the row is missing or already carries a handle.
   */
  markReplyFileDelivered(
    scope: TenantContext,
    messageId: string,
    file: { readonly fileId: string; readonly fileUniqueId: string },
    at: Date,
    tx: unknown,
  ): Promise<boolean>;
  /**
   * Housekeeping across every tenant, the `RetentionSweeper` family: clears the bytes of at
   * most `limit` files staged before `cutoff`. The row — name, type, size, digest — stays.
   */
  purgeReplyFileContentBefore(cutoff: Date, at: Date, limit: number): Promise<number>;
}

export interface TicketCategoryRepository {
  list(
    scope: TenantContext,
    options: { readonly activeOnly: boolean },
    tx?: unknown,
  ): Promise<readonly TicketCategoryRecord[]>;
  findById(scope: TenantContext, id: string, tx?: unknown): Promise<TicketCategoryRecord | null>;
  findByTitle(
    scope: TenantContext,
    title: string,
    tx?: unknown,
  ): Promise<TicketCategoryRecord | null>;
  count(scope: TenantContext, tx?: unknown): Promise<number>;
  /** Serialises category writes in one tenant, so the limit and the title rule hold. */
  lockTenant(scope: TenantContext, tx: unknown): Promise<void>;
  insert(
    scope: TenantContext,
    input: {
      readonly id: TicketCategoryId;
      readonly title: string;
      readonly sortOrder: number;
      readonly isActive: boolean;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<TicketCategoryRecord>;
  update(
    scope: TenantContext,
    id: TicketCategoryId,
    patch: {
      readonly title: string;
      readonly sortOrder: number;
      readonly isActive: boolean;
    },
    at: Date,
    tx: unknown,
  ): Promise<TicketCategoryRecord>;
  hasSeed(scope: TenantContext, tx?: unknown): Promise<boolean>;
  /** `ON CONFLICT DO NOTHING`; false when another transaction seeded first. */
  markSeeded(scope: TenantContext, now: Date, tx: unknown): Promise<boolean>;
}

/**
 * Whether a service, order or payment is this customer's own — the one question linking
 * context asks. A narrow reader, so the ticket module cannot reach anything else about them.
 */
export interface TicketContextReader {
  ownerOf(
    scope: TenantContext,
    kind: 'SERVICE' | 'ORDER' | 'PAYMENT',
    id: string,
    tx?: unknown,
  ): Promise<UserId | null>;
}
