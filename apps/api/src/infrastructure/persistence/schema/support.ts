/**
 * Database schema — support: FAQs, ticket categories, tickets, replies.
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 */
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  SOURCE_SURFACES,
  SUPPORT_FAQ_STATUSES,
  SUPPORT_FAQ_QUESTION_MAX_LENGTH,
  SUPPORT_FAQ_ANSWER_MAX_LENGTH,
  TICKET_ATTACHMENT_FILE_NAME_MAX_LENGTH,
  TICKET_ATTACHMENT_KINDS,
  TICKET_ATTACHMENT_MAX_BYTES,
  TICKET_REPLY_FILE_TYPES,
  TICKET_CATEGORY_SORT_MAX,
  TICKET_CATEGORY_TITLE_MAX_LENGTH,
  TICKET_MESSAGE_MAX_LENGTH,
  TICKET_MESSAGE_SENDERS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_SUBJECT_MAX_LENGTH,
  TICKET_SYSTEM_EVENTS,
  TICKET_ORIGINS,
} from '@nexa/contracts';
import {
  bytea,
  enumCheck,
  nullableEnumCheck,
  publicCodeChecks,
  publicCodeColumns,
  recordSourceChecks,
  recordSourceColumns,
  timestamptz,
} from './_shared.js';
import { botInstances, tenants } from './tenancy.js';
import { admins } from './identity.js';
import { customers } from './customers.js';
import { orders } from './orders.js';
import { payments } from './payments.js';
import { services } from './services.js';

/**
 * The tenant's FAQ, as the operator maintains it. The nine approved defaults are copied
 * in from the catalogue the first time a tenant's FAQ is read (see `support_faq_seeds`);
 * from then on these rows are the operator's and the catalogue is not consulted.
 */
export const supportFaqs = pgTable(
  'support_faqs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    sortOrder: integer('sort_order').notNull().default(0),
    version: integer('version').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /** The customer's screen: active rows in order. */
    index('support_faqs_tenant_sort_idx').on(
      table.tenantId,
      table.sortOrder,
      table.createdAt,
      table.id,
    ),
    unique('support_faqs_tenant_id_key').on(table.tenantId, table.id),
    check('support_faqs_status_check', enumCheck('status', SUPPORT_FAQ_STATUSES)),
    check(
      'support_faqs_question_check',
      sql`length(btrim(question)) BETWEEN 1 AND ${sql.raw(String(SUPPORT_FAQ_QUESTION_MAX_LENGTH))}`,
    ),
    check(
      'support_faqs_answer_check',
      sql`length(btrim(answer)) BETWEEN 1 AND ${sql.raw(String(SUPPORT_FAQ_ANSWER_MAX_LENGTH))}`,
    ),
    check('support_faqs_sort_order_check', sql`sort_order BETWEEN 0 AND 100000`),
    check('support_faqs_version_check', sql`version >= 1`),
  ],
);

/**
 * That a tenant's FAQ defaults were seeded, once. A tenant that then deletes or
 * deactivates every entry is NOT re-seeded — an empty FAQ is a decision the operator
 * made, and the seed is a convenience for a tenant that never had one.
 */
export const supportFaqSeeds = pgTable('support_faq_seeds', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  seededAt: timestamptz('seeded_at').notNull().defaultNow(),
});

// --- WP-A7: support tickets (docs/wp-a7-tickets-audit.md) --------------------------------

/**
 * The subjects a customer files a ticket under, as the tenant's operators maintain them.
 *
 * Never deleted: a category is deactivated, because tickets name it and a deleted one would
 * leave history pointing at nothing. The five defaults are copied in from the catalogue the
 * first time a tenant's categories are read (`ticket_category_seeds`), the FAQ's pattern.
 */
export const ticketCategories = pgTable(
  'ticket_categories',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    title: text('title').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('ticket_categories_tenant_id_key').on(table.tenantId, table.id),
    /** Two categories with one title would be two buttons a customer cannot tell apart. */
    unique('ticket_categories_title_key').on(table.tenantId, table.title),
    index('ticket_categories_tenant_sort_idx').on(table.tenantId, table.sortOrder, table.id),
    check(
      'ticket_categories_title_check',
      sql`length(btrim(title)) BETWEEN 1 AND ${sql.raw(String(TICKET_CATEGORY_TITLE_MAX_LENGTH))}`,
    ),
    check(
      'ticket_categories_sort_order_check',
      sql`sort_order BETWEEN 0 AND ${sql.raw(String(TICKET_CATEGORY_SORT_MAX))}`,
    ),
  ],
);

/**
 * That a tenant's default categories were seeded, once. A tenant that then deactivates
 * every one is NOT re-seeded — that is a decision the operator made.
 */
export const ticketCategorySeeds = pgTable('ticket_category_seeds', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  seededAt: timestamptz('seeded_at').notNull().defaultNow(),
});

/**
 * One support ticket: a customer's conversation with support about one subject.
 *
 * The status moves only by a conditional UPDATE naming the status it leaves
 * (`TICKET_MACHINE`); `closed_at` is set exactly while it is CLOSED. The category's title is
 * SNAPSHOTTED beside its id, so renaming a category does not rewrite what a customer filed
 * under. The service, order and payment are optional context an operator links; each must be
 * the ticket's customer's own, which the service checks at link time.
 */
export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /**
     * The number a customer and an operator quote («تیکت #۱۲۳»). An identity, so it is
     * unique and increasing without a counter row to contend on.
     */
    number: bigint('number', { mode: 'bigint' }).generatedAlwaysAsIdentity().notNull(),
    customerId: uuid('customer_id').notNull(),
    /** The bot the customer opened it through. */
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    categoryId: uuid('category_id').notNull(),
    categoryTitle: text('category_title').notNull(),
    subject: text('subject'),
    status: text('status').notNull().default('OPEN'),
    priority: text('priority').notNull().default('NORMAL'),
    assignedAdminId: uuid('assigned_admin_id'),
    serviceId: uuid('service_id'),
    orderId: uuid('order_id'),
    paymentId: uuid('payment_id'),
    /**
     * The key of the update that opened it. Unique for ever, so a redelivered update
     * answers with this ticket and never opens a second.
     */
    openingKey: text('opening_key').notNull(),
    /** TB7: `BOT` (the customer opened it) or `BUSINESS_CHAT` (the support agent escalated). */
    origin: text('origin').notNull().default('BOT'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    lastMessageAt: timestamptz('last_message_at').notNull().defaultNow(),
    closedAt: timestamptz('closed_at'),
    /**
     * Round 9, C5: the surface whose actor created this row (`SOURCE_SURFACES`), so the
     * operations log can say «منبع: مینی‌اپ» for what the Mini App created. Null for every row
     * written before the column existed: unknown, never guessed — not backfilled.
     */
    sourceSurface: text('source_surface'),
    ...recordSourceColumns(),
    ...publicCodeColumns(),
  },
  (table) => [
    ...recordSourceChecks('tickets', table),
    ...publicCodeChecks('tickets'),
    check(
      'tickets_source_surface_check',
      sql`source_surface IS NULL OR ${enumCheck('source_surface', SOURCE_SURFACES)}`,
    ),
    unique('tickets_tenant_id_key').on(table.tenantId, table.id),
    unique('tickets_opening_key').on(table.tenantId, table.openingKey),
    /** The inbox: newest first, under a keyset on the immutable `(created_at, id)`. */
    index('tickets_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    index('tickets_tenant_status_idx').on(table.tenantId, table.status, table.createdAt),
    /** A customer's own list in the bot, and the open-ticket rail. */
    index('tickets_tenant_customer_idx').on(table.tenantId, table.customerId, table.status),
    index('tickets_tenant_assignee_idx').on(table.tenantId, table.assignedAdminId),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'tickets_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.categoryId],
      foreignColumns: [ticketCategories.tenantId, ticketCategories.id],
      name: 'tickets_category_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.assignedAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'tickets_assignee_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'tickets_service_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'tickets_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'tickets_payment_fk',
    }),
    check('tickets_status_check', enumCheck('status', TICKET_STATUSES)),
    check('tickets_priority_check', enumCheck('priority', TICKET_PRIORITIES)),
    check('tickets_origin_check', enumCheck('origin', TICKET_ORIGINS)),
    /** An equality, the `customer_notifications_resolved_check` shape: closed iff stamped. */
    check('tickets_closed_check', sql`(status = 'CLOSED') = (closed_at IS NOT NULL)`),
    check(
      'tickets_subject_check',
      sql`subject IS NULL OR length(subject) BETWEEN 1 AND ${sql.raw(String(TICKET_SUBJECT_MAX_LENGTH))}`,
    ),
    check(
      'tickets_category_title_check',
      sql`length(category_title) BETWEEN 1 AND ${sql.raw(String(TICKET_CATEGORY_TITLE_MAX_LENGTH))}`,
    ),
    check('tickets_opening_key_check', sql`length(opening_key) BETWEEN 1 AND 300`),
  ],
);

/**
 * One message in a ticket — the conversation's source of truth.
 *
 * Append-only: `nexa_reject_mutation` refuses an UPDATE or a DELETE, so a message sent is a
 * message kept, whatever happened to the Telegram send that carried it. An administrator's
 * reply is pushed to the customer by a `TICKET_REPLY` row on the customer notification lane
 * whose subject is THIS row; its delivery state is read from that row, never copied here.
 *
 * An attachment is a BINDING, the receipts' pattern: which bot received it and Telegram's two
 * ids, with the declared type, name and size. The bytes stay at Telegram and are fetched
 * through the API, which holds the token.
 */
export const ticketMessages = pgTable(
  'ticket_messages',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    ticketId: uuid('ticket_id').notNull(),
    /** The conversation's order, independent of any clock. */
    seq: bigint('seq', { mode: 'bigint' }).generatedAlwaysAsIdentity().notNull(),
    senderType: text('sender_type').notNull(),
    /** Who wrote an ADMIN message; null otherwise. */
    authorAdminId: uuid('author_admin_id'),
    body: text('body'),
    systemEvent: text('system_event'),
    attachmentKind: text('attachment_kind'),
    attachmentBotInstanceId: uuid('attachment_bot_instance_id').references(() => botInstances.id),
    /** What `getFile` takes. Bot-scoped, and never returned to a browser. */
    attachmentFileId: text('attachment_file_id'),
    attachmentFileUniqueId: text('attachment_file_unique_id'),
    attachmentMimeType: text('attachment_mime_type'),
    attachmentFileName: text('attachment_file_name'),
    attachmentFileSize: bigint('attachment_file_size', { mode: 'bigint' }),
    /**
     * The command's key — the Telegram update that carried a customer's message, or a Web
     * request's key for an administrator's — so a redelivery answers with this row and
     * never writes a second. Null for a SYSTEM fact, which its status change makes once.
     */
    idempotencyKey: text('idempotency_key'),
    /** What the key was first used for, so the same key with different words is refused. */
    requestHash: text('request_hash'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    ...recordSourceColumns(),
  },
  (table) => [
    ...recordSourceChecks('ticket_messages', table),
    unique('ticket_messages_tenant_id_key').on(table.tenantId, table.id),
    unique('ticket_messages_key').on(table.tenantId, table.idempotencyKey),
    index('ticket_messages_ticket_idx').on(table.tenantId, table.ticketId, table.seq),
    foreignKey({
      columns: [table.tenantId, table.ticketId],
      foreignColumns: [tickets.tenantId, tickets.id],
      name: 'ticket_messages_ticket_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.authorAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'ticket_messages_author_fk',
    }),
    check('ticket_messages_sender_check', enumCheck('sender_type', TICKET_MESSAGE_SENDERS)),
    check(
      'ticket_messages_system_event_check',
      nullableEnumCheck('system_event', TICKET_SYSTEM_EVENTS),
    ),
    check(
      'ticket_messages_attachment_kind_check',
      nullableEnumCheck('attachment_kind', TICKET_ATTACHMENT_KINDS),
    ),
    check(
      'ticket_messages_body_check',
      sql`body IS NULL OR length(body) BETWEEN 1 AND ${sql.raw(String(TICKET_MESSAGE_MAX_LENGTH))}`,
    ),
    /** An attachment is all of its binding or none of it. */
    check(
      'ticket_messages_attachment_check',
      sql`(attachment_kind IS NULL) = (attachment_file_id IS NULL)
          AND (attachment_kind IS NULL) = (attachment_file_unique_id IS NULL)
          AND (attachment_kind IS NULL) = (attachment_bot_instance_id IS NULL)
          AND (attachment_kind IS NOT NULL OR (attachment_mime_type IS NULL AND attachment_file_name IS NULL AND attachment_file_size IS NULL))`,
    ),
    check(
      'ticket_messages_attachment_size_check',
      sql`attachment_file_size IS NULL OR attachment_file_size BETWEEN 1 AND ${sql.raw(String(TICKET_ATTACHMENT_MAX_BYTES))}`,
    ),
    check(
      'ticket_messages_attachment_name_check',
      sql`attachment_file_name IS NULL OR length(attachment_file_name) BETWEEN 1 AND ${sql.raw(String(TICKET_ATTACHMENT_FILE_NAME_MAX_LENGTH))}`,
    ),
    /**
     * Each sender's shape: a customer writes text or a file; an administrator writes text,
     * signed; the system records one fact from its closed set and nothing else.
     */
    check(
      'ticket_messages_shape_check',
      sql`CASE sender_type
            WHEN 'CUSTOMER' THEN author_admin_id IS NULL AND system_event IS NULL
                 AND (body IS NOT NULL OR attachment_kind IS NOT NULL) AND idempotency_key IS NOT NULL
            WHEN 'ADMIN' THEN author_admin_id IS NOT NULL AND system_event IS NULL
                 AND body IS NOT NULL AND attachment_kind IS NULL AND idempotency_key IS NOT NULL
            WHEN 'SYSTEM' THEN author_admin_id IS NULL AND system_event IS NOT NULL
                 AND body IS NULL AND attachment_kind IS NULL
            WHEN 'AI' THEN author_admin_id IS NULL AND system_event IS NULL
                 AND body IS NOT NULL AND attachment_kind IS NULL AND idempotency_key IS NOT NULL
            ELSE false
          END`,
    ),
    check(
      'ticket_messages_key_check',
      sql`(idempotency_key IS NULL) = (request_hash IS NULL)
          AND (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 300)`,
    ),
  ],
);

// --- HF-A7: the files support attaches to a ticket reply -------------------------------

/**
 * One file support attached to a reply from the Web Admin — its STAGING, and afterwards its
 * binding.
 *
 * The bytes are here only until Telegram has them. The reply's `ticket_messages` row is
 * written first and never changes; this row names it, holds the verified file, and is what
 * the `TICKET_REPLY_ATTACHMENT` notification reads at send time. The delivery that Telegram
 * accepts stamps Telegram's own `file_id` here and clears `content` in the same
 * transaction; from then on the Web Admin reads the file back from Telegram, the way it
 * reads a customer's. Bytes Telegram never took are cleared by the worker's retention
 * sweep after `TICKET_REPLY_FILE_RETENTION_DAYS`, and while they wait the tenant is held to
 * `TICKET_REPLY_FILE_STAGED_MAX_BYTES` of them — so this is a bounded, short-lived staging
 * area, never a blob store.
 *
 * Tenant-scoped end to end: the message, the ticket and the bot are composite foreign keys
 * on `(tenant_id, …)`, and every query carries the tenant. `bot_instance_id` is the ticket's
 * bot, whose token sends the file and whose namespace the stamped `file_id` belongs to.
 */
export const ticketReplyFiles = pgTable(
  'ticket_reply_files',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    messageId: uuid('message_id').notNull(),
    ticketId: uuid('ticket_id').notNull(),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    kind: text('kind').notNull(),
    mimeType: text('mime_type').notNull(),
    /** The name it is sent under, already cleaned and ending in the verified type's extension. */
    fileName: text('file_name').notNull(),
    byteLength: integer('byte_length').notNull(),
    sha256: text('sha256').notNull(),
    /** The bytes, until Telegram has them or the retention clears them. */
    content: bytea('content'),
    /** When `content` was cleared, by the delivery or by the retention sweep. */
    purgedAt: timestamptz('purged_at'),
    /** Telegram's handle for the delivered file, in `bot_instance_id`'s namespace. */
    telegramFileId: text('telegram_file_id'),
    telegramFileUniqueId: text('telegram_file_unique_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'ticket_reply_files_pk', columns: [table.tenantId, table.messageId] }),
    foreignKey({
      columns: [table.tenantId, table.messageId],
      foreignColumns: [ticketMessages.tenantId, ticketMessages.id],
      name: 'ticket_reply_files_message_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.ticketId],
      foreignColumns: [tickets.tenantId, tickets.id],
      name: 'ticket_reply_files_ticket_fk',
    }),
    /** What the staging bound sums, and what the retention sweep walks: the held bytes. */
    index('ticket_reply_files_staged_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`content IS NOT NULL`),
    index('ticket_reply_files_retention_idx')
      .on(table.createdAt)
      .where(sql`content IS NOT NULL`),
    check('ticket_reply_files_kind_check', enumCheck('kind', TICKET_ATTACHMENT_KINDS)),
    /*
     * The allow-list, by hand for the reason `tenant_media_assets_mime_check` gives: each
     * type with the shape it is sent as and its own size bound, from the contract.
     */
    check(
      'ticket_reply_files_type_check',
      sql`CASE mime_type ${sql.raw(
        TICKET_REPLY_FILE_TYPES.map((type) => {
          if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(type.mimeType) || !/^[A-Z]+$/.test(type.kind)) {
            throw new Error(`ticket_reply_files: "${type.mimeType}" is not a plain literal.`);
          }
          return `WHEN '${type.mimeType}' THEN kind = '${type.kind}' AND byte_length BETWEEN 1 AND ${String(type.maxBytes)}`;
        }).join(' '),
      )} ELSE false END`,
    ),
    check(
      'ticket_reply_files_content_check',
      sql`(content IS NULL) = (purged_at IS NOT NULL)
          AND (content IS NULL OR octet_length(content) = byte_length)`,
    ),
    check(
      'ticket_reply_files_telegram_check',
      sql`(telegram_file_id IS NULL) = (telegram_file_unique_id IS NULL)`,
    ),
    check('ticket_reply_files_sha256_check', sql`sha256 ~ '^[0-9a-f]{64}$'`),
    check(
      'ticket_reply_files_name_check',
      sql`length(file_name) BETWEEN 1 AND ${sql.raw(String(TICKET_ATTACHMENT_FILE_NAME_MAX_LENGTH))}`,
    ),
  ],
);
