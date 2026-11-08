/**
 * Database schema — business chats: Telegram wizards and review messages, business connections, conversations, messages.
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
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  BUSINESS_BOT_RIGHTS,
  BUSINESS_CONVERSATION_STATES,
  BUSINESS_HANDOFF_REASONS,
  BUSINESS_HANDOFF_KINDS,
  BUSINESS_MESSAGE_KINDS,
  BUSINESS_MESSAGE_ORIGINS,
  BUSINESS_OUTBOUND_ORIGINS,
  BUSINESS_OUTBOUND_FEEDBACK,
  BUSINESS_OUTBOUND_STATES,
  BUSINESS_TAKEOVER_REASONS,
  SUPPORT_AI_TOPICS,
  BUSINESS_ESCALATION_TICKET_OUTCOMES,
  TELEGRAM_WIZARD_KINDS,
  TELEGRAM_WIZARD_STEPS,
  TELEGRAM_REVIEW_MESSAGE_ROLES,
} from '@nexa/contracts';
import { enumArrayCheck, enumCheck, timestamptz } from './_shared.js';
import { botInstances, tenants } from './tenancy.js';
import { admins } from './identity.js';
import { customers } from './customers.js';
import { payments } from './payments.js';
import { tickets } from './support.js';

/**
 * R2 (v0.3.5 real-test item 5): one customer WIZARD message — the purchase or the wallet
 * top-up — that Telegram edits in place from step to step instead of receiving a new message
 * per step.
 *
 * Presentation state, keyed by the Telegram message itself: `(bot, chat, message)` is the
 * wizard's identity, so an older wizard message keeps its own state and an order still
 * payable from it stays payable. `step` is the screen the message SHOWS; a tapped button is
 * honoured only when the message still shows the screen the button belongs to, and every
 * transition is a conditional UPDATE on `version` taken before the work runs
 * (`busy_until` is that claim's lease), so a double tap or a keyboard Telegram had not yet
 * replaced is answered without effect — never a step backward, never a second draft,
 * payment or invoice. Nothing here decides money: the order, the payment and the capture
 * still re-decide every write under their own locks.
 *
 * `payment_id` is the attempt an `INVOICE`/`INVOICE_PENDING` message shows; the gateway
 * worker finds the message through it when the invoice it was creating is ready.
 */
export const telegramWizards = pgTable(
  'telegram_wizards',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    chatId: text('chat_id').notNull(),
    messageId: bigint('message_id', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    step: text('step').notNull(),
    version: integer('version').notNull().default(0),
    /** The order (ORDER) or the amount capture (TOPUP) the screen is about. */
    subjectId: uuid('subject_id'),
    paymentId: uuid('payment_id'),
    busyUntil: timestamptz('busy_until'),
    /**
     * The Telegram update whose turn put this screen on the message. A REDELIVERY of that
     * same update — Telegram did not see our 200, perhaps after the edit never went out —
     * is let through the gate again and replays to the same result (every write behind it
     * is idempotent by the update's key), so a lost edit is repaired rather than frozen.
     */
    lastUpdateKey: text('last_update_key'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('telegram_wizards_message_key').on(
      table.tenantId,
      table.botInstanceId,
      table.chatId,
      table.messageId,
    ),
    index('telegram_wizards_payment_idx')
      .on(table.tenantId, table.paymentId)
      .where(sql`payment_id IS NOT NULL`),
    index('telegram_wizards_subject_idx')
      .on(table.tenantId, table.subjectId)
      .where(sql`subject_id IS NOT NULL`),
    index('telegram_wizards_chat_idx').on(
      table.tenantId,
      table.botInstanceId,
      table.chatId,
      table.updatedAt,
    ),
    // The retention sweep's `(tenant_id, updated_at)` index is an ONLINE index
    // (`online-indexes.ts`): every customer tap writes this table.
    check('telegram_wizards_kind_check', enumCheck('kind', TELEGRAM_WIZARD_KINDS)),
    check('telegram_wizards_step_check', enumCheck('step', TELEGRAM_WIZARD_STEPS)),
    check('telegram_wizards_version_check', sql`version >= 0`),
    check('telegram_wizards_message_check', sql`message_id > 0`),
  ],
);

/**
 * R2 (v0.3.5 real-test item 3): an administrator's receipt-review message, or a prompt a
 * decision opened from it, recorded so the decision can edit it in place into its result.
 *
 * `finalised_at` is what makes a repeated tap harmless: a callback from a message already
 * finalised is answered (`answerCallbackQuery`) and nothing else — no decision is asked for
 * again, no message is sent or edited. The decisions themselves keep their own locks and
 * idempotency; this row only records which message shows the outcome.
 */
export const telegramReviewMessages = pgTable(
  'telegram_review_messages',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    chatId: text('chat_id').notNull(),
    messageId: bigint('message_id', { mode: 'number' }).notNull(),
    paymentId: uuid('payment_id').notNull(),
    role: text('role').notNull(),
    /** Whether the message carries the receipt FILE, so its caption is what is edited. */
    hasMedia: boolean('has_media').notNull(),
    finalisedAt: timestamptz('finalised_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /**
     * The row's last write — its recording, its finalisation, or a stamp cleared because the
     * edit failed (Codex review of #131). The retention sweep ages a review row by THIS, so
     * a stamp cleared for a retry is not eligible the moment it is cleared.
     */
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('telegram_review_messages_message_key').on(
      table.tenantId,
      table.botInstanceId,
      table.chatId,
      table.messageId,
    ),
    index('telegram_review_messages_payment_idx').on(table.tenantId, table.paymentId),
    // The retention sweep's `(tenant_id, updated_at)` index is an ONLINE index
    // (`online-indexes.ts`): every receipt decision writes this table.
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'telegram_review_messages_payment_fk',
    }),
    check('telegram_review_messages_role_check', enumCheck('role', TELEGRAM_REVIEW_MESSAGE_ROLES)),
    check('telegram_review_messages_message_check', sql`message_id > 0`),
  ],
);

/**
 * The retention sweep's PURGE HORIZON for one chat (`docs/telegram-retention.md`): the
 * greatest Telegram message id whose `telegram_wizards` or `telegram_review_messages` row
 * the sweep has removed in this chat.
 *
 * It is what keeps a removed row's old keyboard harmless. A tap on a message nothing tracks
 * is otherwise ADOPTED (a wizard gate) or decided afresh (a receipt review) — right for a
 * message whose row was never written, wrong for one whose row was deleted. So a tap on an
 * untracked message at or below this id is stale, answered and nothing else. Written in
 * the SAME transaction as the delete, so no reader can see the row gone and the horizon not
 * yet raised; it only ever rises (`GREATEST`), and it is never deleted: one row per chat the
 * sweep has touched, a bound the chats themselves set.
 */
export const telegramMessageHorizons = pgTable(
  'telegram_message_horizons',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    chatId: text('chat_id').notNull(),
    purgedThroughMessageId: bigint('purged_through_message_id', { mode: 'number' }).notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'telegram_message_horizons_pkey',
      columns: [table.tenantId, table.botInstanceId, table.chatId],
    }),
    check('telegram_message_horizons_message_check', sql`purged_through_message_id > 0`),
  ],
);

/**
 * TB1 — one Telegram Business connection of one of this tenant's bots (ADR-0033 §2).
 *
 * Telegram creates the connection when a Business account owner connects the bot, and
 * reports every change as a `business_connection` update. This row is the latest of those
 * reports, keyed by the bot AND Telegram's connection id: a connection id arriving on a
 * different bot's authenticated route is a different row, never this one.
 *
 * The STATUS is projected (`businessConnectionStatus`) from `is_enabled`, `rights` and
 * `superseded_at`, and never stored: a stored status is a second answer to "may this
 * connection send" that can disagree with the facts it summarises.
 *
 * `superseded_at` answers `OQ-TB-02`, which the reference leaves open: whether a reconnect
 * keeps its id. A new id for the same owner on the same bot supersedes every older row of
 * that owner, so a stale connection id fails closed instead of sending as an account that
 * has moved on. No secret is held here; the bot's token stays on `bot_instances`.
 */
export const telegramBusinessConnections = pgTable(
  'telegram_business_connections',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    /** `BusinessConnection.id` — opaque text, Telegram's. */
    connectionId: text('connection_id').notNull(),
    /** `BusinessConnection.user.id`: the Business account owner, as decimal text. */
    ownerTelegramUserId: text('owner_telegram_user_id').notNull(),
    /** `BusinessConnection.user_chat_id`: the bot's private chat with the owner. */
    ownerUserChatId: text('owner_user_chat_id').notNull(),
    isEnabled: boolean('is_enabled').notNull(),
    /** The granted `BusinessBotRights`, by field name; unknown rights are dropped at parse. */
    rights: text('rights')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** `BusinessConnection.date`: when Telegram says the connection was established. */
    connectedAt: timestamptz('connected_at').notNull(),
    /** When NEXA last applied a report of this connection (an update or a `getBusinessConnection`). */
    lastConfirmedAt: timestamptz('last_confirmed_at').notNull(),
    supersededAt: timestamptz('superseded_at'),
    /** Optimistic version (ADR-0021); advanced by every applied change. */
    version: integer('version').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('telegram_business_connections_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('telegram_business_connections_bot_connection_key').on(
      table.botInstanceId,
      table.connectionId,
    ),
    /** Supersession and the Web Admin's list: one owner's connections on one bot. */
    index('telegram_business_connections_owner_idx').on(
      table.tenantId,
      table.botInstanceId,
      table.ownerTelegramUserId,
    ),
    check(
      'telegram_business_connections_rights_check',
      enumArrayCheck('rights', BUSINESS_BOT_RIGHTS),
    ),
    check(
      'telegram_business_connections_owner_check',
      sql`owner_telegram_user_id ~ '^[1-9][0-9]{0,31}$'`,
    ),
    check(
      'telegram_business_connections_owner_chat_check',
      sql`owner_user_chat_id ~ '^-?[1-9][0-9]{0,31}$'`,
    ),
    check(
      'telegram_business_connections_connection_id_check',
      sql`length(connection_id) BETWEEN 1 AND 256`,
    ),
    check('telegram_business_connections_version_check', sql`version >= 1`),
  ],
);

/**
 * TB2 — one Telegram Business conversation: one customer chat of one business account on
 * one bot (ADR-0033 §4).
 *
 * Keyed by the bot, the OWNER and the chat, not by the connection row: a reconnect that
 * gets a new connection id (`OQ-TB-02`) continues the same conversation, and
 * `connection_row_id` follows the latest connection that carried it.
 *
 * `control_epoch` is the takeover mechanism. Every human signal (the owner typing, another
 * business bot, an operator taking over or sending, an operator resuming) increments it under
 * this row's lock, and every lane row carries the epoch it was created under. The send lane
 * compares them under the same lock immediately before stamping a send, so a human who spoke
 * first always wins. There is no `setState`: every transition is a conditional UPDATE naming
 * the states it may leave.
 */
export const businessConversations = pgTable(
  'business_conversations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    ownerTelegramUserId: text('owner_telegram_user_id').notNull(),
    /** The private chat's id: for a business chat, the customer's own Telegram id. */
    chatId: text('chat_id').notNull(),
    connectionRowId: uuid('connection_row_id').notNull(),
    /** The person on the other side, from Telegram's `from` of their own messages. */
    peerTelegramUserId: text('peer_telegram_user_id').notNull(),
    /** The NEXA customer, by exact `(tenant, telegram_user_id)` only; null when unlinked. */
    customerId: uuid('customer_id'),
    state: text('state').notNull().default('AI_ACTIVE'),
    controlEpoch: integer('control_epoch').notNull().default(0),
    takeoverReason: text('takeover_reason'),
    handoffReason: text('handoff_reason'),
    /**
     * Phase 4 PR-1 — how the current human hold ends (`BUSINESS_HANDOFF_KINDS`): HARD is sticky,
     * SOFT returns to the AI by itself. NULL on AI_ACTIVE, and on every hold from before this
     * column, which stays sticky.
     */
    handoffKind: text('handoff_kind'),
    lastMessageAt: timestamptz('last_message_at'),
    lastInboundAt: timestamptz('last_inbound_at'),
    lastHumanAt: timestamptz('last_human_at'),
    lastAiAt: timestamptz('last_ai_at'),
    /**
     * TB7: the ticket this conversation escalated to (the canonical escalation). At most one
     * active link: a later handoff links this ticket again while it is still active.
     */
    ticketId: uuid('ticket_id'),
    version: integer('version').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('business_conversations_tenant_id_key').on(table.tenantId, table.id),
    foreignKey({
      columns: [table.tenantId, table.ticketId],
      foreignColumns: [tickets.tenantId, tickets.id],
      name: 'business_conversations_ticket_fk',
    }),
    uniqueIndex('business_conversations_chat_key').on(
      table.botInstanceId,
      table.ownerTelegramUserId,
      table.chatId,
    ),
    /**
     * The inbox (TB10, program §47): conversations waiting for a person first, then newest
     * activity, then id — EXACTLY the repository's ORDER BY and keyset, expression for
     * expression, so a page is a bounded backward range scan of one tenant. The TB2 index on
     * `(tenant_id, last_message_at)` matched no query (the list orders by the COALESCE) and
     * is dropped by the same migration.
     */
    index('business_conversations_inbox_priority_idx').on(
      table.tenantId,
      sql`(${table.state} = 'HANDOFF_REQUIRED')`,
      sql`COALESCE(${table.lastMessageAt}, ${table.createdAt})`,
      table.id,
    ),
    foreignKey({
      columns: [table.tenantId, table.connectionRowId],
      foreignColumns: [telegramBusinessConnections.tenantId, telegramBusinessConnections.id],
      name: 'business_conversations_connection_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'business_conversations_customer_fk',
    }),
    check('business_conversations_state_check', enumCheck('state', BUSINESS_CONVERSATION_STATES)),
    check(
      'business_conversations_takeover_reason_check',
      enumCheck('takeover_reason', BUSINESS_TAKEOVER_REASONS),
    ),
    check(
      'business_conversations_handoff_reason_check',
      enumCheck('handoff_reason', BUSINESS_HANDOFF_REASONS),
    ),
    // A handoff always says why, and only a handoff does.
    check(
      'business_conversations_handoff_shape_check',
      sql`(state = 'HANDOFF_REQUIRED') = (handoff_reason IS NOT NULL)`,
    ),
    check(
      'business_conversations_handoff_kind_check',
      enumCheck('handoff_kind', BUSINESS_HANDOFF_KINDS),
    ),
    // Only a person's hold has a kind.
    check(
      'business_conversations_handoff_kind_shape_check',
      sql`state <> 'AI_ACTIVE' OR handoff_kind IS NULL`,
    ),
    check('business_conversations_epoch_check', sql`control_epoch >= 0`),
    check('business_conversations_chat_check', sql`chat_id ~ '^-?[1-9][0-9]{0,31}$'`),
    check('business_conversations_peer_check', sql`peer_telegram_user_id ~ '^[1-9][0-9]{0,31}$'`),
  ],
);

/**
 * TB2 — the bounded transcript of a business conversation (ADR-0033 §8).
 *
 * Kept only as far as the agent and the operator need context: `text` is bounded, purged
 * `BUSINESS_MESSAGE_TEXT_RETENTION_DAYS` after the message was sent and at once when
 * Telegram reports it deleted. The row itself (who, when, kind) survives the purge, so a
 * conversation's history of who spoke stays readable without keeping what was said.
 */
export const businessMessages = pgTable(
  'business_messages',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    conversationId: uuid('conversation_id').notNull(),
    telegramMessageId: bigint('telegram_message_id', { mode: 'number' }).notNull(),
    origin: text('origin').notNull(),
    kind: text('kind').notNull(),
    text: text('text'),
    contentVersion: integer('content_version').notNull().default(1),
    sentAt: timestamptz('sent_at').notNull(),
    editedAt: timestamptz('edited_at'),
    deletedAt: timestamptz('deleted_at'),
    textPurgedAt: timestamptz('text_purged_at'),
    /**
     * TB6 — the reference to a PHOTO's largest size, never its bytes and never a URL (a file
     * URL carries the bot token). `file_id` is what `getFile` takes and is scoped to the bot
     * that received it — `business_conversations.bot_instance_id`. Purged with the text, and
     * at once on delete: a reference is as much the customer's content as the caption.
     */
    photoFileId: text('photo_file_id'),
    photoFileUniqueId: text('photo_file_unique_id'),
    /** Telegram's declared size of that photo size, when it gave one. A claim, not a bound. */
    photoFileSize: integer('photo_file_size'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('business_messages_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('business_messages_message_key').on(table.conversationId, table.telegramMessageId),
    /** The detail view: one conversation's most recent messages. */
    index('business_messages_conversation_idx').on(
      table.tenantId,
      table.conversationId,
      table.sentAt,
    ),
    /** The retention sweep: text still held, oldest first. */
    index('business_messages_retention_idx')
      .on(table.tenantId, table.sentAt)
      .where(sql`text IS NOT NULL`),
    foreignKey({
      columns: [table.tenantId, table.conversationId],
      foreignColumns: [businessConversations.tenantId, businessConversations.id],
      name: 'business_messages_conversation_fk',
    }),
    check('business_messages_origin_check', enumCheck('origin', BUSINESS_MESSAGE_ORIGINS)),
    check('business_messages_kind_check', enumCheck('kind', BUSINESS_MESSAGE_KINDS)),
    check('business_messages_text_check', sql`text IS NULL OR length(text) <= 4096`),
    check('business_messages_message_id_check', sql`telegram_message_id > 0`),
    check('business_messages_version_check', sql`content_version >= 1`),
    // A deleted message holds no text.
    check('business_messages_deleted_check', sql`deleted_at IS NULL OR text IS NULL`),
    // TB6: a photo reference belongs only to a PHOTO, comes as a pair, is bounded, and its
    // declared size never outlives it (PR #201 review, N4).
    check(
      'business_messages_photo_shape_check',
      sql`(photo_file_id IS NULL) = (photo_file_unique_id IS NULL) AND (photo_file_id IS NULL OR kind = 'PHOTO') AND (photo_file_size IS NULL OR photo_file_id IS NOT NULL)`,
    ),
    check(
      'business_messages_photo_bounds_check',
      sql`(photo_file_id IS NULL OR length(photo_file_id) BETWEEN 1 AND 256) AND (photo_file_unique_id IS NULL OR length(photo_file_unique_id) BETWEEN 1 AND 128) AND (photo_file_size IS NULL OR photo_file_size >= 0)`,
    ),
    check(
      'business_messages_photo_deleted_check',
      sql`deleted_at IS NULL OR photo_file_id IS NULL`,
    ),
  ],
);

/**
 * TB2 — the outbound lane: every message NEXA sends as a Business account (ADR-0033 §4, §6).
 *
 * ADR-0030's discipline, unchanged: the row is enqueued inside the transaction that decided
 * to send it, the worker claims it with a lease, stamps `send_started_at` in its own
 * transaction BEFORE the network call, and records the outcome in a third. A stamped row
 * nobody resolved is `UNCONFIRMED`, never resent. What is new is the final check: the stamp's
 * transaction locks the conversation and requires `control_epoch` to equal this row's
 * (plus `AI_ACTIVE` for an `AUTO` row) — `businessOutboundSendable` — or the row is
 * `SUPERSEDED` and nothing is sent.
 */
export const businessOutboundMessages = pgTable(
  'business_outbound_messages',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    conversationId: uuid('conversation_id').notNull(),
    origin: text('origin').notNull(),
    /** The text to send; purged with the transcript's retention once resolved. */
    body: text('body'),
    createdByAdminId: uuid('created_by_admin_id'),
    controlEpoch: integer('control_epoch').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    state: text('state').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at'),
    sendStartedAt: timestamptz('send_started_at'),
    resolvedAt: timestamptz('resolved_at'),
    telegramMessageId: bigint('telegram_message_id', { mode: 'number' }),
    failureCode: text('failure_code'),
    bodyPurgedAt: timestamptz('body_purged_at'),
    /**
     * Roadmap A4: a `HANDOFF_NOTICE` row names its template instead of carrying a body — the
     * text is rendered when the row is sent, never stored (CLAUDE.md, Phase 2).
     */
    templateKey: text('template_key'),
    /**
     * Phase 4 PR-3: the inline keyboard of an automatic message or a handoff notice
     * (`businessOutboundButtonsSchema`): deep links into the bot and the support AI's own
     * callbacks, labels rendered from templates when the row was enqueued. Purged with the body.
     */
    buttons: jsonb('buttons'),
    /** Phase 4 PR-3: the customer's 👍 / 👎 under an automatic answer; the first tap wins. */
    feedback: text('feedback'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('business_outbound_messages_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('business_outbound_messages_idempotency_key').on(
      table.tenantId,
      table.idempotencyKey,
    ),
    /** The claim: pending rows, by when they are due. */
    index('business_outbound_messages_due_idx')
      .on(table.tenantId, table.nextAttemptAt)
      .where(sql`state = 'PENDING'`),
    /** Echo matching and the detail view. */
    index('business_outbound_messages_conversation_idx').on(
      table.tenantId,
      table.conversationId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.tenantId, table.conversationId],
      foreignColumns: [businessConversations.tenantId, businessConversations.id],
      name: 'business_outbound_messages_conversation_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.createdByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'business_outbound_messages_admin_fk',
    }),
    check(
      'business_outbound_messages_origin_check',
      enumCheck('origin', BUSINESS_OUTBOUND_ORIGINS),
    ),
    check('business_outbound_messages_state_check', enumCheck('state', BUSINESS_OUTBOUND_STATES)),
    check(
      'business_outbound_messages_body_check',
      sql`body IS NULL OR length(body) BETWEEN 1 AND 4096`,
    ),
    // A person's send names the person; the AI's and the handoff notice never do.
    check(
      'business_outbound_messages_author_check',
      sql`(origin IN ('AUTO', 'HANDOFF_NOTICE')) = (created_by_admin_id IS NULL)`,
    ),
    /*
     * Roadmap A4: only the notice is a template, and a template has no stored body. Phase 4
     * PR-3: a notice may instead carry a rendered body — check-before-handoff's facts message,
     * which IS the notice of that handoff — never both (a purged body leaves neither; the lane
     * sends only a row with one).
     */
    check(
      'business_outbound_messages_template_check',
      sql`(origin = 'HANDOFF_NOTICE' OR template_key IS NULL) AND (template_key IS NULL OR body IS NULL)`,
    ),
    // Phase 4 PR-3: buttons only on what the support AI sends; feedback only on its replies.
    check(
      'business_outbound_messages_buttons_check',
      sql`buttons IS NULL OR origin IN ('AUTO', 'HANDOFF_NOTICE')`,
    ),
    check(
      'business_outbound_messages_feedback_check',
      sql`feedback IS NULL OR (origin = 'AUTO' AND ${enumCheck('feedback', BUSINESS_OUTBOUND_FEEDBACK)})`,
    ),
    // Resolved exactly when not PENDING; a delivered row knows its Telegram message.
    check(
      'business_outbound_messages_resolved_check',
      sql`(state = 'PENDING') = (resolved_at IS NULL)`,
    ),
    check('business_outbound_messages_attempts_check', sql`attempts >= 0`),
    check('business_outbound_messages_epoch_check', sql`control_epoch >= 0`),
  ],
);

/**
 * TB7 — one handoff of a business conversation to a person (program §27).
 *
 * Written in the transaction that moves the conversation to `HANDOFF_REQUIRED`, once per
 * handoff: unique on `(conversation, control_epoch)`, the epoch the handoff produced. It
 * records why, what became of the ticket (the canonical escalation), and the AI's short
 * operator-facing summary when the AI produced one — bounded, never sent to the customer,
 * and purged with the transcript's retention.
 */
export const businessConversationEscalations = pgTable(
  'business_conversation_escalations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    conversationId: uuid('conversation_id').notNull(),
    controlEpoch: integer('control_epoch').notNull(),
    reason: text('reason').notNull(),
    summary: text('summary'),
    /**
     * Roadmap A5: the safe operator context of the handoff — the latest AI decision's topic and
     * intent in this conversation (the intent is AI text, purged with the summary) and the
     * automatic replies of the session (steps tried). Never the customer's words.
     */
    topic: text('topic'),
    intent: text('intent'),
    stepsTried: integer('steps_tried'),
    /**
     * Review of PR #246 (M1): when the summary and intent were copied from an EARLIER decision
     * rather than the deciding one, that decision's time. The text is purged 30 days after the
     * older of this and `created_at`, so a copy never outlives its source.
     */
    contextFrom: timestamptz('context_from'),
    ticketId: uuid('ticket_id'),
    ticketOutcome: text('ticket_outcome').notNull(),
    /** Phase 4 PR-1 — the handoff's kind (`BUSINESS_HANDOFF_KINDS`); NULL before this column. */
    handoffKind: text('handoff_kind'),
    jobId: uuid('job_id'),
    textPurgedAt: timestamptz('text_purged_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('business_conversation_escalations_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('business_conversation_escalations_epoch_key').on(
      table.tenantId,
      table.conversationId,
      table.controlEpoch,
    ),
    index('business_conversation_escalations_ticket_idx').on(table.tenantId, table.ticketId),
    /** TB10 analytics: a tenant's handoffs in a window, by reason. */
    index('business_conversation_escalations_created_idx').on(table.tenantId, table.createdAt),
    foreignKey({
      columns: [table.tenantId, table.conversationId],
      foreignColumns: [businessConversations.tenantId, businessConversations.id],
      name: 'business_conversation_escalations_conversation_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.ticketId],
      foreignColumns: [tickets.tenantId, tickets.id],
      name: 'business_conversation_escalations_ticket_fk',
    }),
    check(
      'business_conversation_escalations_reason_check',
      enumCheck('reason', BUSINESS_HANDOFF_REASONS),
    ),
    check(
      'business_conversation_escalations_ticket_outcome_check',
      enumCheck('ticket_outcome', BUSINESS_ESCALATION_TICKET_OUTCOMES),
    ),
    // A ticket is named exactly when one was created or linked.
    check(
      'business_conversation_escalations_ticket_shape_check',
      sql`(ticket_outcome IN ('CREATED', 'LINKED')) = (ticket_id IS NOT NULL)`,
    ),
    check(
      'business_conversation_escalations_summary_check',
      sql`summary IS NULL OR length(summary) <= 600`,
    ),
    check('business_conversation_escalations_topic_check', enumCheck('topic', SUPPORT_AI_TOPICS)),
    check(
      'business_conversation_escalations_intent_check',
      sql`intent IS NULL OR length(intent) <= 600`,
    ),
    check(
      'business_conversation_escalations_steps_check',
      sql`steps_tried IS NULL OR steps_tried >= 0`,
    ),
    check(
      'business_conversation_escalations_handoff_kind_check',
      enumCheck('handoff_kind', BUSINESS_HANDOFF_KINDS),
    ),
    check('business_conversation_escalations_epoch_check', sql`control_epoch >= 1`),
  ],
);
