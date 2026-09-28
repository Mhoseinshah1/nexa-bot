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
  TicketStatus,
  TicketSystemEvent,
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

/** One message as an operator reads it: who signed it, and how far a reply got. */
export interface TicketMessageListItem {
  readonly message: TicketMessageRecord;
  readonly authorUsername: string | null;
  /** The `TICKET_REPLY` notification's state, for an ADMIN message; null otherwise. */
  readonly delivery: CustomerNotificationState | null;
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
  countActiveForCustomer(scope: TenantContext, customerId: UserId, tx: unknown): Promise<number>;
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
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<TicketRecord>;
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
  /** A customer's own tickets for the bot: the active ones first, then the newest. */
  listForCustomer(
    scope: TenantContext,
    customerId: UserId,
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
  /** Every message, oldest first, with its author and delivery state. */
  messagesOf(scope: TenantContext, ticketId: TicketId): Promise<readonly TicketMessageListItem[]>;
  /** The newest `limit` messages, oldest first, and how many there are in all. */
  latestMessages(
    scope: TenantContext,
    ticketId: TicketId,
    limit: number,
  ): Promise<{ readonly messages: readonly TicketMessageRecord[]; readonly messageCount: number }>;
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
