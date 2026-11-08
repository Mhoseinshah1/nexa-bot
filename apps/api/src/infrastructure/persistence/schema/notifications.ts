/**
 * Database schema — notifications: admin and customer notifications, the ops log.
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
  DELIVERY_OUTCOMES,
  NOTIFICATION_KINDS,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TRANSPORTS,
  CUSTOMER_NOTIFICATION_KINDS,
  CUSTOMER_NOTIFICATION_STATES,
  OPS_LOG_GROUP_HEALTH,
  OPS_LOG_GROUP_PROBLEMS,
  OPS_LOG_GROUP_STATUSES,
  OPS_LOG_TOPIC_STATES,
} from '@nexa/contracts';
import { enumArrayCheck, enumCheck, timestamptz } from './_shared.js';
import { botInstances, tenants } from './tenancy.js';
import { operationalEvents } from './eventing.js';
import { admins } from './identity.js';
import { customers } from './customers.js';

/**
 * A notification INTENT.
 *
 * One row per thing that should be communicated, created inside the transaction
 * that produced it. Never one row per send: a retry appends to
 * `notification_delivery_attempts` and leaves this row alone.
 *
 * `dedupe_key` is the intent's identity within its tenant, and the unique index
 * is what makes "a retry must not create a second logical notification" a
 * property of the database rather than of the queue behaving well.
 *
 * `destination` is a SNAPSHOT taken when the intent was created, not a reference
 * to the setting that produced it: an attempt from March must still say which
 * chat it was addressed to after somebody repoints the destination in April.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    /** The rendered destination, as it stood when the intent was created. */
    destination: jsonb('destination').notNull(),
    /** Typed values for the template this kind renders. Redacted like any log. */
    payload: jsonb('payload').notNull(),
    templateKey: text('template_key').notNull(),
    status: text('status').notNull().default('PENDING'),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    correlationId: text('correlation_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lastAttemptAt: timestamptz('last_attempt_at'),
    /**
     * The earliest moment the next attempt may run.
     *
     * Three jobs in one column: the initial "send now", the back-off after a
     * retryable failure, and the LEASE the dispatcher takes when it claims a
     * row. Pushing it forward before the send means an intent whose sender dies
     * mid-flight becomes eligible again on its own, instead of staying claimed
     * by a process that no longer exists.
     */
    nextAttemptAt: timestamptz('next_attempt_at').notNull().defaultNow(),
    /** When it reached SENT or FAILED. NULL while PENDING. */
    completedAt: timestamptz('completed_at'),
  },
  (table) => [
    // The candidate key a composite foreign key needs on the referenced side,
    // so a delivery attempt can say "the notification with this id, IN THIS
    // TENANT" rather than naming a globally unique id and hoping. Redundant
    // with the primary key on purpose (migration 0007 explains the pattern).
    unique('notifications_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('notifications_dedupe_key').on(table.tenantId, table.dedupeKey),
    // The administrator-facing list: this tenant's notifications, newest first.
    index('notifications_tenant_created_idx').on(table.tenantId, table.createdAt),
    /**
     * The dispatcher's claim.
     *
     * `SELECT ... WHERE status = 'PENDING' AND next_attempt_at <= now ORDER BY
     * next_attempt_at FOR UPDATE SKIP LOCKED` — one query, run on a tick, and
     * the only reason this index exists.
     *
     * Partial, and it stays small: a row leaves the index the moment it reaches
     * SENT or FAILED, so it holds work in flight rather than all history.
     * Deliberately not led by `tenant_id` — the dispatcher runs for the
     * installation and has no tenant to fix, so a tenant-leading index would be
     * a scan.
     */
    index('notifications_pending_idx')
      .on(table.nextAttemptAt)
      .where(sql`status = 'PENDING'`),
    check('notifications_kind_check', enumCheck('kind', NOTIFICATION_KINDS)),
    check('notifications_status_check', enumCheck('status', NOTIFICATION_STATUSES)),
    check('notifications_attempts_check', sql`attempt_count >= 0 AND max_attempts >= 1`),
    // A terminal status has a completion time and a pending one does not. Two
    // fields that can contradict each other are a bug with a migration attached.
    check(
      'notifications_completed_check',
      sql`(status = 'PENDING' AND completed_at IS NULL) OR (status <> 'PENDING' AND completed_at IS NOT NULL)`,
    ),
  ],
);

/**
 * Claims handed back without ever reaching the transport.
 *
 * `attempt_count` on the intent counts claims ISSUED, and it is deliberately
 * monotonic: a claim whose process died with the socket open has to count, or a
 * crash-looping worker retries for ever. So capacity cannot be returned by
 * decrementing it, and the first attempt to do so was wrong in two ways at
 * once. A decrement matched on `attempt_count = attemptNumber` could only be
 * applied by whichever claim happened to be current, so two outstanding claims
 * releasing out of order silently lost one attempt's capacity; and it required
 * `status = 'PENDING'`, so a sweep that terminalised the row a moment earlier
 * made the hand-back impossible.
 *
 * A release is a FACT about one attempt number, recorded here. Spend is then
 * derived — `attempt_count` minus the releases — so order does not matter, a
 * repeated release is a no-op against the primary key, and a release can be
 * recorded after the intent has been written off.
 */
export const notificationReleasedClaims = pgTable(
  'notification_released_claims',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    notificationId: uuid('notification_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    releasedAt: timestamptz('released_at').notNull(),
    /** Why the claim was handed back. A machine code, never a sentence. */
    reason: text('reason').notNull(),
  },
  (table) => [
    // The identity of a release IS the attempt it releases. Idempotent by
    // construction: a retry after an ambiguous commit inserts nothing new,
    // which is what makes a release safe to repeat when its outcome is unknown.
    primaryKey({
      name: 'notification_released_claims_pk',
      columns: [table.tenantId, table.notificationId, table.attemptNumber],
    }),
    check('notification_released_claims_number_check', sql`attempt_number >= 1`),
    foreignKey({
      name: 'notification_released_claims_tenant_notification_fk',
      columns: [table.tenantId, table.notificationId],
      foreignColumns: [notifications.tenantId, notifications.id],
    }),
  ],
);

/**
 * One attempt to deliver one notification. Append-only.
 *
 * The record of what actually happened on the wire, which the legacy system does
 * not keep at all — it has no delivery-status field anywhere, which is why
 * whether its notification report means "sent" or "matched" is UNKNOWN
 * (UNK-LGR-015).
 *
 * `retry_after_ms` holds what the transport ASKED FOR, when it said anything. A
 * 429 that names a wait is honoured rather than second-guessed.
 */
export const notificationDeliveryAttempts = pgTable(
  'notification_delivery_attempts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    notificationId: uuid('notification_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    transport: text('transport').notNull(),
    outcome: text('outcome').notNull(),
    startedAt: timestamptz('started_at').notNull(),
    finishedAt: timestamptz('finished_at').notNull(),
    /** A machine code from the transport, never a prose sentence. */
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    retryAfterMs: integer('retry_after_ms'),
  },
  (table) => [
    uniqueIndex('notification_delivery_attempts_key').on(
      table.tenantId,
      table.notificationId,
      table.attemptNumber,
    ),
    check('notification_delivery_attempts_outcome_check', enumCheck('outcome', DELIVERY_OUTCOMES)),
    check(
      'notification_delivery_attempts_transport_check',
      enumCheck('transport', NOTIFICATION_TRANSPORTS),
    ),
    check('notification_delivery_attempts_number_check', sql`attempt_number >= 1`),
    // A success carries no error; a failure carries a code. Otherwise "why did
    // this fail" is answered by an empty column half the time.
    check(
      'notification_delivery_attempts_error_check',
      sql`(outcome = 'SUCCEEDED' AND error_code IS NULL) OR (outcome <> 'SUCCEEDED' AND error_code IS NOT NULL)`,
    ),
    foreignKey({
      name: 'notification_delivery_attempts_tenant_notification_fk',
      columns: [table.tenantId, table.notificationId],
      foreignColumns: [notifications.tenantId, notifications.id],
    }),
  ],
);

/**
 * The queue of things to tell a customer that they did not ask for.
 *
 * `ADR 0030` decides the shape and `docs/phase4h-audit.md` §1 measures the absence it
 * fills: before Phase 4H this product could tell a customer exactly ONE such thing, the
 * subscription link, whose lane is two columns on `services` and a state table about a
 * subscription link. Phases 4D–4G created several more facts a customer needs and none
 * of them had anywhere to travel.
 *
 * Its own table rather than more columns on the subjects, because the subjects are four
 * different tables and a column pair per table is four copies of one state machine. Its
 * own table rather than `notifications`, because that one's destinations are OPERATOR
 * channels and its `DELIVERY_OUTCOMES` enum is pinned by a CHECK constraint — an
 * operator alert that arrives late is still useful and a duplicate is merely noise, and
 * for a customer neither is true. Not the outbox either: that carries domain EVENTS and
 * freezes their content, and a customer message is an EFFECT of an event.
 *
 * There is no `values` column, and its absence is a decision rather than an omission.
 * Every one of the eight kinds renders a template that declares NO placeholders, so there
 * is nothing to carry; a jsonb column with no producer is the empty table this
 * repository refuses elsewhere. The first kind that needs one adds it, in the migration
 * that needs it.
 */
export const customerNotifications = pgTable(
  'customer_notifications',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    /**
     * Which bot to send from, and never "the tenant's active bot".
     *
     * `CustomerMessenger`'s port states the rule and the reason: a customer wrote to a
     * specific bot, and a reply from a different one arrives from an account they have
     * never heard of — which, for a tenant running a public bot and a reseller bot,
     * leaks the relationship between them. So the producer resolves it at enqueue time
     * from the subject, and the dispatcher does not get to choose.
     */
    botInstanceId: uuid('bot_instance_id').notNull(),
    /** One of `CUSTOMER_NOTIFICATION_KINDS`. The kind decides the template AND the table `subject_id` names. */
    kind: text('kind').notNull(),
    /**
     * The row this notification is about, in the table its `kind` implies.
     *
     * Deliberately NOT accompanied by a `subject_type` column. The kind already
     * determines the table — `PAYMENT_REJECTED` names a payment and nothing else — and a
     * second column saying so is a second source of truth that can disagree with the
     * first. `CUSTOMER_NOTIFICATION_PRECONDITIONS` is keyed on kind for the same reason.
     *
     * No foreign key, and that is deliberate too: the four possible targets are four
     * different tables, and a column cannot reference all of them. What protects it is
     * that the producer writes this row in the SAME transaction as the fact, so a
     * subject that never existed cannot have produced one.
     */
    subjectId: uuid('subject_id').notNull(),
    state: text('state').notNull().default('PENDING'),
    /**
     * Definite refusals observed for THIS message.
     *
     * A rate limit is not one. `CUSTOMER_NOTIFICATION_MAX_ATTEMPTS` states why at
     * length: an attempt is an outcome somebody observed about this message, and
     * Telegram declining to look at it yet is not that. Spending attempts on rate limits
     * fails messages that were never rejected on their merits, in exactly the conditions
     * that produce rate limits.
     */
    attempts: integer('attempts').notNull().default(0),
    /** When the dispatcher may next try. Null means now. */
    nextAttemptAt: timestamptz('next_attempt_at'),
    /**
     * When a send was handed to Telegram with no outcome recorded yet.
     *
     * `services.delivery_send_started_at` for this lane, and it exists for the identical
     * reason: it is the one fact distinguishing "this process died BEFORE sending" from
     * "this process died AFTER sending", and only the second must never be repeated
     * automatically. Without it a dispatcher killed mid-send leaves a row `PENDING`
     * behind nothing but a lease, and the next pass tells the customer again.
     *
     * Cleared by every recorded outcome, so a set value always means an unresolved send.
     */
    sendStartedAt: timestamptz('send_started_at'),
    /**
     * When this row stopped being `PENDING`, whatever it became.
     *
     * One stamp rather than one per terminal state. `state` already says WHICH outcome,
     * and a `delivered_at` beside a `failed_at` beside a `superseded_at` is three
     * columns that can disagree with the one that decides.
     */
    resolvedAt: timestamptz('resolved_at'),
    /**
     * Round 11, B1 (the mini app's notification centre): the plain text the customer was
     * sent, exactly as it was rendered at the moment of delivery — markup removed, cut at
     * `MINIAPP_NOTIFICATION_TEXT_MAX`.
     *
     * Stamped by the SAME statement that records `DELIVERED`, and by nothing else, so it
     * is the answer to "what did this bot tell this customer" and not a second message
     * store: the row, its owner, its bot and its moment already live here, and a kind and a
     * subject id cannot be re-rendered into the same words later (the lane froze its
     * figures; a balance or a status read today is not what was said). Null for every row
     * delivered before the centre existed and for any row that never reached the customer,
     * which is what keeps both out of the list without a backfill — and no customer is
     * messaged about them.
     */
    renderedText: text('rendered_text'),
    /**
     * When the customer marked this delivered message read in the mini app. Null is unread.
     * The row is already the customer's own (`customer_id`), so this is read state keyed by
     * customer without a second table; set only where it is null, so a second tap changes
     * nothing and keeps the first moment.
     */
    customerReadAt: timestamptz('customer_read_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'customer_notifications_customer_fk',
    }),
    /**
     * The centre's text exists only for a delivered message, and only a message with text can
     * have been read: the list is "delivered rows with text", so a read mark on anything else
     * would be unreachable state.
     */
    check(
      'customer_notifications_centre_check',
      sql`(rendered_text IS NULL OR state = 'DELIVERED') AND (customer_read_at IS NULL OR rendered_text IS NOT NULL)`,
    ),
    /*
     * The centre's two partial indexes (`customer_notifications_centre_idx`, the page, and
     * `customer_notifications_centre_unread_idx`, the bell's counter) are built CONCURRENTLY
     * by `online-indexes.ts`, not here: `customer_notifications` is a large table and a plain
     * CREATE INDEX in the migrator's one transaction would block the lane's writes.
     */
    check('customer_notifications_kind_check', enumCheck('kind', CUSTOMER_NOTIFICATION_KINDS)),
    check('customer_notifications_state_check', enumCheck('state', CUSTOMER_NOTIFICATION_STATES)),
    /**
     * A resolved row has a stamp and a `PENDING` one does not, as an equality.
     *
     * The same shape as `orders_cancelled_at_check`, which the 4G audit found had made
     * its own state unwritable — so this one is stated as an equality over the state
     * rather than a one-way implication, and 4H-2's tests write every terminal state
     * through it rather than trusting that they can.
     */
    check(
      'customer_notifications_resolved_check',
      sql`(state <> 'PENDING') = (resolved_at IS NOT NULL)`,
    ),
    /**
     * One notification of one kind per subject, for ever.
     *
     * This is the idempotency of the whole lane and it is a CONSTRAINT rather than a
     * check in a service: the producers enqueue inside the transaction that produced the
     * fact, two worker replicas are the normal case on every rolling update, and a
     * redelivered outbox message replays its effect. "Payment X was rejected" is told
     * once whichever of those happens.
     */
    unique('customer_notifications_subject_key').on(table.tenantId, table.kind, table.subjectId),
    /** The dispatcher's claim: queued rows whose backoff has elapsed, oldest first. */
    index('customer_notifications_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`state = 'PENDING'`),
  ],
);

/**
 * Round 4 PR-H (post-import safety): how many automatic reminders the customer notification
 * lane has claimed in the current minute and the current hour, per tenant — latest state
 * only, one row.
 *
 * A ROW taken under its lock, never a counter in a process, for the reason the gateway call
 * budget gives: two worker replicas are the normal case on every rolling update, and a
 * ceiling each replica counted for itself would be twice the ceiling. The dispatcher locks
 * this row, claims at most what `reminders.max_per_minute` leaves, and writes the new counts
 * in the same transaction, so two replicas are serialised by the row.
 *
 * `hour_fresh` counts the reminders claimed this hour that were raised within the hour — a
 * reminder quiet hours held overnight is not fresh — and is what the burst alarm
 * (`notification.reminder_burst`) compares with `reminders.burst_alarm_per_hour`.
 * `burst_open` says the alarm's condition is open, so its recovery is recorded once, when
 * an hour ends below the threshold, and never on every quiet pass.
 */
export const customerNotificationRateWindows = pgTable(
  'customer_notification_rate_windows',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    minuteStartedAt: timestamptz('minute_started_at').notNull(),
    minuteClaimed: integer('minute_claimed').notNull(),
    hourStartedAt: timestamptz('hour_started_at').notNull(),
    hourFresh: integer('hour_fresh').notNull(),
    burstOpen: boolean('burst_open').notNull().default(false),
    /**
     * Codex review of PR #296: the last `customer_reminder_raise_counters.raised_total` this
     * row has counted. `hour_fresh` grows by the difference on each pass, so the burst alarm
     * counts reminders as they are RAISED, whatever the ceiling lets the claim take.
     */
    raisedSeen: bigint('raised_seen', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  () => [
    check(
      'customer_notification_rate_windows_counts_check',
      sql`minute_claimed >= 0 AND hour_fresh >= 0 AND raised_seen >= 0`,
    ),
  ],
);

/**
 * Codex review of PR #296: how many automatic reminders (the kinds quiet hours hold) have
 * ever been QUEUED for a tenant — a monotonic counter, bumped by `CustomerNotifier` in the
 * producer's own transaction, so it commits with the rows it counts.
 *
 * Its own row, apart from `customer_notification_rate_windows`, on purpose: the dispatcher
 * locks that row for its claim, and a sweep that also had to lock it would sit in a lock
 * cycle with a dispatcher holding the notification row the sweep's insert waits on. The
 * dispatcher only READS this one, without a lock, and counts the difference since its last
 * pass.
 */
export const customerReminderRaiseCounters = pgTable(
  'customer_reminder_raise_counters',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    raisedTotal: bigint('raised_total', { mode: 'bigint' }).notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  () => [check('customer_reminder_raise_counters_total_check', sql`raised_total >= 0`)],
);

// --- WP-A4: the Telegram operations log group and the topics Nexa owns in it ----------

/**
 * The tenant's operations log group: ONE row per tenant, kept through a disconnect.
 *
 * The chat id is DISCOVERED, never typed: it is read from the authenticated webhook update
 * that carried a valid one-time connection code (`ops_log_connect_codes`), so nobody
 * copies a number and nobody can bind a group to another tenant. Reconnecting a different
 * group replaces the chat on this row; its topics are keyed by chat, so the new group
 * gets new topics and the old group's thread ids are never posted to again.
 *
 * `health` is what the last permission check found. It is never HEALTHY without
 * `getChat` and `getChatMember` having answered — a bound row starts UNVERIFIED and the
 * worker checks it — and `problems` says what is wrong in the Web Admin's words.
 */
export const opsLogGroups = pgTable(
  'ops_log_groups',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    /** Telegram's numeric chat id, as text (`-100…`). */
    chatId: text('chat_id').notNull(),
    /** The group's title as Telegram last reported it. Operator-chosen text. */
    title: text('title').notNull(),
    status: text('status').notNull(),
    health: text('health').notNull().default('UNVERIFIED'),
    problems: text('problems')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** The bot's own ChatMember status in the group, as last read. */
    botMemberStatus: text('bot_member_status'),
    checkedAt: timestamptz('checked_at'),
    lastDeliveredAt: timestamptz('last_delivered_at'),
    /** The administrator whose connection code bound the group. */
    connectedByAdminId: uuid('connected_by_admin_id'),
    connectedAt: timestamptz('connected_at').notNull(),
    disconnectedAt: timestamptz('disconnected_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('ops_log_groups_tenant_id_key').on(table.tenantId, table.id),
    /** One binding per tenant: reconnecting another group rewrites this row. */
    uniqueIndex('ops_log_groups_tenant_key').on(table.tenantId),
    /** The worker's read: groups whose permissions need checking. */
    index('ops_log_groups_check_idx')
      .on(table.health, table.checkedAt)
      .where(sql`status = 'CONNECTED'`),
    foreignKey({
      columns: [table.tenantId, table.connectedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'ops_log_groups_admin_fk',
    }),
    check('ops_log_groups_status_check', enumCheck('status', OPS_LOG_GROUP_STATUSES)),
    check('ops_log_groups_health_check', enumCheck('health', OPS_LOG_GROUP_HEALTH)),
    check('ops_log_groups_problems_check', enumArrayCheck('problems', OPS_LOG_GROUP_PROBLEMS)),
    check('ops_log_groups_chat_check', sql`chat_id ~ '^-?[0-9]{1,32}$'`),
    // A disconnected row says when; a connected one has no such instant.
    check(
      'ops_log_groups_disconnected_check',
      sql`(status = 'DISCONNECTED') = (disconnected_at IS NOT NULL)`,
    ),
  ],
);

/**
 * The topic registry: one row per (group chat, category), holding the thread id Nexa
 * created and posts to.
 *
 * A CATEGORY KEY column, not one column per topic, so a third topic is a row and never a
 * migration; the CHECK pins the key's shape only. The unique key is what makes topic
 * creation idempotent under concurrency: there is exactly one row to claim, and only the
 * holder of `creation_claim_token` (a conditional UPDATE with a lease) calls
 * `createForumTopic`. A second worker, a double-click and a redelivered update all find
 * the row claimed or READY and create nothing.
 */
export const opsLogTopics = pgTable(
  'ops_log_topics',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    groupId: uuid('group_id').notNull(),
    /** The chat the thread lives in: a thread id means nothing in any other chat. */
    chatId: text('chat_id').notNull(),
    category: text('category').notNull(),
    state: text('state').notNull().default('PENDING'),
    messageThreadId: bigint('message_thread_id', { mode: 'number' }),
    /** Who is creating the topic right now, and until when that claim holds. */
    creationClaimToken: uuid('creation_claim_token'),
    creationClaimedUntil: timestamptz('creation_claimed_until'),
    recreatedCount: integer('recreated_count').notNull().default(0),
    lastDeliveredAt: timestamptz('last_delivered_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ops_log_topics_chat_category_key').on(
      table.tenantId,
      table.chatId,
      table.category,
    ),
    foreignKey({
      columns: [table.tenantId, table.groupId],
      foreignColumns: [opsLogGroups.tenantId, opsLogGroups.id],
      name: 'ops_log_topics_group_fk',
    }),
    check('ops_log_topics_state_check', enumCheck('state', OPS_LOG_TOPIC_STATES)),
    check('ops_log_topics_category_check', sql`category ~ '^[A-Z][A-Z0-9_]{0,31}$'`),
    // READY means a thread to post to; nothing else claims one.
    check('ops_log_topics_ready_check', sql`state <> 'READY' OR message_thread_id IS NOT NULL`),
    check('ops_log_topics_recreated_check', sql`recreated_count >= 0`),
  ],
);

/**
 * One-time connection codes, stored as a SHA-256 hash only.
 *
 * Issued by the Web Admin to one administrator for one of the tenant's bots, accepted
 * once, for ten minutes, and only from an update that bot's own webhook delivered — the
 * webhook route names the bot, and the lookup is keyed by tenant AND bot, so a code for
 * one bot or tenant is simply not found through another. Consumption is a conditional
 * UPDATE (`consumed_at IS NULL AND expires_at > now`), so a replayed update and two
 * groups racing for one code consume it exactly once.
 */
export const opsLogConnectCodes = pgTable(
  'ops_log_connect_codes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    codeHash: text('code_hash').notNull(),
    issuedByAdminId: uuid('issued_by_admin_id').notNull(),
    issuedAt: timestamptz('issued_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    consumedAt: timestamptz('consumed_at'),
    consumedChatId: text('consumed_chat_id'),
  },
  (table) => [
    uniqueIndex('ops_log_connect_codes_hash_key').on(table.codeHash),
    index('ops_log_connect_codes_tenant_issued_idx').on(table.tenantId, table.issuedAt),
    foreignKey({
      columns: [table.tenantId, table.issuedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'ops_log_connect_codes_admin_fk',
    }),
    check('ops_log_connect_codes_expiry_check', sql`expires_at > issued_at`),
    check(
      'ops_log_connect_codes_consumed_check',
      sql`(consumed_at IS NULL) = (consumed_chat_id IS NULL)`,
    ),
  ],
);

// --- Phase B3: the Web Admin Notification Center ----------------------------------------

/**
 * One administrator's read mark on one notification (`docs/notification-center.md`).
 *
 * The notification IS the `operational_events` row; this is only what one person has
 * seen of it. `read_through` is the event's `last_seen_at` at the moment it was read, so a
 * condition that recurs afterwards — the recorder bumps `last_seen_at` on the same row —
 * reads as unread again for this administrator and nobody else. NULL is an explicit
 * "mark unread". No row means never read.
 *
 * Nothing here touches the event: the operational log stays append-only and still has no
 * "mark as seen", and a read mark resolves nothing. Tenant-scoped end to end: the
 * administrator is a composite foreign key on `(tenant_id, admin_id)`, and every query
 * also names the event's tenant.
 */
export const adminNotificationReads = pgTable(
  'admin_notification_reads',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => operationalEvents.id),
    /** The event's `last_seen_at` when this administrator read it; NULL = marked unread. */
    readThrough: timestamptz('read_through'),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'admin_notification_reads_pk',
      columns: [table.tenantId, table.adminId, table.eventId],
    }),
    foreignKey({
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'admin_notification_reads_admin_fk',
    }),
  ],
);
