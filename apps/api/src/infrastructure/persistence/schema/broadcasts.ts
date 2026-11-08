/**
 * Database schema — broadcasts: frozen audiences, broadcasts, bulk operations.
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
  CURRENCY_CODES,
  BROADCAST_CONTENT_KINDS,
  BROADCAST_PIN_STATES,
  BROADCAST_PURPOSES,
  BROADCAST_MEDIA_FILE_NAME_MAX_LENGTH,
  BROADCAST_MEDIA_TYPES,
  BROADCAST_PAUSE_REASONS,
  BROADCAST_RECIPIENT_STATES,
  BROADCAST_STATES,
  BROADCAST_TITLE_MAX_LENGTH,
  BULK_ITEM_STATES,
  BULK_NOTE_MAX_LENGTH,
  BULK_OPERATION_KINDS,
  BULK_OPERATION_STATES,
  FROZEN_AUDIENCE_GRANT_KINDS,
  FROZEN_AUDIENCE_KINDS,
  BULK_SKIP_REASONS,
} from '@nexa/contracts';
import { bytea, enumCheck, nullableEnumCheck, timestamptz } from './_shared.js';
import { botInstances, tenants } from './tenancy.js';
import { admins } from './identity.js';
import { customers } from './customers.js';
import { walletEntries } from './wallet.js';
import { services } from './services.js';
import { provisioningOperations } from './provisioning.js';

// --- Round N close: frozen audiences (docs/round-n-close-audit.md §A) --------------------

/**
 * A frozen audience's header: what was confirmed, and never changed afterwards. The
 * definition it was selected by, that definition's hash, the instant it was evaluated at,
 * the member count and the set's fingerprint (md5 over the sorted member ids, exactly as
 * the preview computes it). The members are the table below; `released_at` says the sweep
 * has cleared them, which it does only once every campaign action, mass operation and
 * broadcast that names this row has ended (`FROZEN_AUDIENCE_RELEASE_AFTER_DAYS`). The
 * header itself is never deleted: every reference to it is `ON DELETE RESTRICT`.
 */
export const frozenAudiences = pgTable(
  'frozen_audiences',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    /** The grant a SERVICES audience was selected for (its eligibility rule); null for CUSTOMERS. */
    grantKind: text('grant_kind'),
    definition: jsonb('definition').notNull(),
    definitionHash: text('definition_hash').notNull(),
    asOf: timestamptz('as_of').notNull(),
    memberCount: integer('member_count').notNull(),
    fingerprint: text('fingerprint').notNull(),
    createdByAdminId: uuid('created_by_admin_id').references(() => admins.id),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    releasedAt: timestamptz('released_at'),
  },
  (table) => [
    unique('frozen_audiences_tenant_id_key').on(table.tenantId, table.id),
    check(
      'frozen_audiences_grant_kind_check',
      sql`grant_kind IS NULL OR ${enumCheck('grant_kind', FROZEN_AUDIENCE_GRANT_KINDS)}`,
    ),
    /** A SERVICES set names the grant whose rule selected it; a CUSTOMERS set names none. */
    check('frozen_audiences_grant_check', sql`(kind = 'SERVICES') = (grant_kind IS NOT NULL)`),
    /** The release sweep's question: which held audiences are old enough to consider. */
    index('frozen_audiences_held_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`released_at IS NULL`),
    check('frozen_audiences_kind_check', enumCheck('kind', FROZEN_AUDIENCE_KINDS)),
    check('frozen_audiences_hash_check', sql`definition_hash ~ '^[0-9a-f]{64}$'`),
    check('frozen_audiences_fingerprint_check', sql`fingerprint ~ '^[0-9a-f]{32}$'`),
    check('frozen_audiences_count_check', sql`member_count >= 0`),
  ],
);

/**
 * One member of a frozen audience: the customer and, for a SERVICES audience, the service;
 * with the bot the customer would be messaged through and the chat to reach, copied at the
 * freeze so a broadcast seeded later needs no second lookup. Ids are minted by the database
 * (`gen_random_uuid()`) for the reason `bulk_operation_items` gives: an `INSERT … SELECT`
 * over tens of thousands of rows must not ship every id through Node.
 */
export const frozenAudienceMembers = pgTable(
  'frozen_audience_members',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    frozenAudienceId: uuid('frozen_audience_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    serviceId: uuid('service_id'),
    botInstanceId: uuid('bot_instance_id').references(() => botInstances.id),
    chatId: text('chat_id').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.frozenAudienceId],
      foreignColumns: [frozenAudiences.tenantId, frozenAudiences.id],
      name: 'frozen_audience_members_audience_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'frozen_audience_members_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'frozen_audience_members_service_fk',
    }),
    /** One row per customer of a CUSTOMERS audience, one per service of a SERVICES one. */
    uniqueIndex('frozen_audience_members_customer_key')
      .on(table.tenantId, table.frozenAudienceId, table.customerId)
      .where(sql`service_id IS NULL`),
    uniqueIndex('frozen_audience_members_service_key')
      .on(table.tenantId, table.frozenAudienceId, table.serviceId)
      .where(sql`service_id IS NOT NULL`),
  ],
);

// --- Round N: broadcast and safe mass actions (docs/round-n-broadcast-audit.md) ---------

/**
 * One broadcast (B1): an operator-authored message, its FROZEN audience and its lifecycle.
 *
 * `body` is stored RAW, placeholders included, and rendered per recipient at send time — the
 * repository's rule for every template body. `audience_definition` is the canonical definition
 * (`canonicalAudienceDefinition`) and `audience_hash` its sha256; at launch the recipients are
 * materialised into `broadcast_recipients` in the same transaction that stamps
 * `audience_as_of`, `recipient_count` and `audience_fingerprint`, and none of the four changes
 * again. Every state change is a conditional UPDATE naming its `from` states.
 */
export const broadcasts = pgTable(
  'broadcasts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    title: text('title').notNull(),
    state: text('state').notNull().default('DRAFT'),
    pauseReason: text('pause_reason'),
    contentKind: text('content_kind').notNull(),
    body: text('body').notNull(),
    buttons: jsonb('buttons')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Round N close (§D): MARKETING excludes opted-out customers; SERVICE_ANNOUNCEMENT does not. */
    purpose: text('purpose').notNull().default('MARKETING'),
    /**
     * Round N close (§C): the Telegram message a FORWARD or COPY sends, by its chat and
     * message id, and when a real preview last reached the operator from it. A launch
     * refuses a source with no verification; an edit of the source clears it.
     */
    sourceChatId: text('source_chat_id'),
    sourceMessageId: bigint('source_message_id', { mode: 'number' }),
    sourceVerifiedAt: timestamptz('source_verified_at'),
    /** Round N close (§C): pin each delivered message in the recipient's chat, once. */
    pin: boolean('pin').notNull().default(false),
    /** Round N close (§A): the frozen audience the recipients were copied from, if any. */
    frozenAudienceId: uuid('frozen_audience_id'),
    audienceDefinition: jsonb('audience_definition').notNull(),
    audienceHash: text('audience_hash').notNull(),
    audienceAsOf: timestamptz('audience_as_of'),
    recipientCount: integer('recipient_count'),
    audienceFingerprint: text('audience_fingerprint'),
    scheduledAt: timestamptz('scheduled_at'),
    version: integer('version').notNull().default(1),
    createdByAdminId: uuid('created_by_admin_id').references(() => admins.id),
    launchedByAdminId: uuid('launched_by_admin_id').references(() => admins.id),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    launchedAt: timestamptz('launched_at'),
    startedAt: timestamptz('started_at'),
    pausedAt: timestamptz('paused_at'),
    completedAt: timestamptz('completed_at'),
    cancelledAt: timestamptz('cancelled_at'),
  },
  (table) => [
    unique('broadcasts_tenant_id_key').on(table.tenantId, table.id),
    index('broadcasts_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    /** The scheduler's question: which confirmed broadcasts are due to start. */
    index('broadcasts_scheduled_idx')
      .on(table.scheduledAt)
      .where(sql`state = 'SCHEDULED'`),
    /** The dispatcher's question: which broadcasts are sending, and the completion sweep's. */
    index('broadcasts_sending_idx')
      .on(table.tenantId)
      .where(sql`state = 'SENDING'`),
    foreignKey({
      columns: [table.tenantId, table.frozenAudienceId],
      foreignColumns: [frozenAudiences.tenantId, frozenAudiences.id],
      name: 'broadcasts_frozen_audience_fk',
    }).onDelete('restrict'),
    check('broadcasts_state_check', enumCheck('state', BROADCAST_STATES)),
    check(
      'broadcasts_pause_reason_check',
      nullableEnumCheck('pause_reason', BROADCAST_PAUSE_REASONS),
    ),
    check('broadcasts_content_kind_check', enumCheck('content_kind', BROADCAST_CONTENT_KINDS)),
    check('broadcasts_purpose_check', enumCheck('purpose', BROADCAST_PURPOSES)),
    /** A sourced kind names its message; a composed kind names none. */
    check(
      'broadcasts_source_check',
      sql`(content_kind IN ('FORWARD', 'COPY')) = (source_chat_id IS NOT NULL AND source_message_id IS NOT NULL)
          AND (source_message_id IS NULL OR source_message_id > 0)
          AND (source_verified_at IS NULL OR source_chat_id IS NOT NULL)`,
    ),
    check(
      'broadcasts_title_check',
      sql`length(title) BETWEEN 1 AND ${sql.raw(String(BROADCAST_TITLE_MAX_LENGTH))}`,
    ),
    check('broadcasts_hash_check', sql`audience_hash ~ '^[0-9a-f]{64}$'`),
    check('broadcasts_version_check', sql`version >= 1`),
    check('broadcasts_buttons_check', sql`jsonb_typeof(buttons) = 'array'`),
    /** Launched means frozen: a non-draft always names the set it was confirmed against. */
    check(
      'broadcasts_frozen_check',
      sql`(state = 'DRAFT') = (launched_at IS NULL)
          AND (state = 'DRAFT' OR (audience_as_of IS NOT NULL AND recipient_count IS NOT NULL
                                   AND audience_fingerprint IS NOT NULL))`,
    ),
    check('broadcasts_schedule_check', sql`state <> 'SCHEDULED' OR scheduled_at IS NOT NULL`),
    check('broadcasts_paused_check', sql`(state = 'PAUSED') = (pause_reason IS NOT NULL)`),
    check('broadcasts_completed_check', sql`(state = 'COMPLETED') = (completed_at IS NOT NULL)`),
    check('broadcasts_cancelled_check', sql`(state = 'CANCELLED') = (cancelled_at IS NOT NULL)`),
    check('broadcasts_recipient_count_check', sql`recipient_count IS NULL OR recipient_count >= 0`),
  ],
);

/**
 * A broadcast's media, STAGED: the verified bytes until the retention sweep clears them, one
 * row per broadcast. The HF-A7 ticket-file shape — a per-type size bound held by a CHECK, a
 * per-tenant bound on undelivered bytes checked under an advisory lock, and a lifetime.
 */
export const broadcastMedia = pgTable(
  'broadcast_media',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    broadcastId: uuid('broadcast_id').notNull(),
    kind: text('kind').notNull(),
    mimeType: text('mime_type').notNull(),
    fileName: text('file_name').notNull(),
    byteLength: integer('byte_length').notNull(),
    sha256: text('sha256').notNull(),
    content: bytea('content'),
    purgedAt: timestamptz('purged_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'broadcast_media_pk', columns: [table.tenantId, table.broadcastId] }),
    foreignKey({
      columns: [table.tenantId, table.broadcastId],
      foreignColumns: [broadcasts.tenantId, broadcasts.id],
      name: 'broadcast_media_broadcast_fk',
    }).onDelete('cascade'),
    index('broadcast_media_staged_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`content IS NOT NULL`),
    check(
      'broadcast_media_type_check',
      sql`CASE mime_type ${sql.raw(
        BROADCAST_MEDIA_TYPES.map((type) => {
          if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(type.mimeType) || !/^[A-Z]+$/.test(type.kind)) {
            throw new Error(`broadcast_media: "${type.mimeType}" is not a plain literal.`);
          }
          return `WHEN '${type.mimeType}' THEN kind = '${type.kind}' AND byte_length BETWEEN 1 AND ${String(type.maxBytes)}`;
        }).join(' '),
      )} ELSE false END`,
    ),
    check(
      'broadcast_media_content_check',
      sql`(content IS NULL) = (purged_at IS NOT NULL)
          AND (content IS NULL OR octet_length(content) = byte_length)`,
    ),
    check('broadcast_media_sha256_check', sql`sha256 ~ '^[0-9a-f]{64}$'`),
    check(
      'broadcast_media_name_check',
      sql`length(file_name) BETWEEN 1 AND ${sql.raw(String(BROADCAST_MEDIA_FILE_NAME_MAX_LENGTH))}`,
    ),
  ],
);

/**
 * Telegram's handle for a broadcast's media, per BOT: a `file_id` is scoped to the bot that
 * uploaded it. The first send through a bot uploads the bytes and stamps its handle here; every
 * later send through that bot reuses it, so a broadcast to fifty thousand chats uploads its
 * video once per bot rather than fifty thousand times.
 */
export const broadcastMediaHandles = pgTable(
  'broadcast_media_handles',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    broadcastId: uuid('broadcast_id').notNull(),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    telegramFileId: text('telegram_file_id').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'broadcast_media_handles_pk',
      columns: [table.tenantId, table.broadcastId, table.botInstanceId],
    }),
    foreignKey({
      columns: [table.tenantId, table.broadcastId],
      foreignColumns: [broadcasts.tenantId, broadcasts.id],
      name: 'broadcast_media_handles_broadcast_fk',
    }).onDelete('cascade'),
    check('broadcast_media_handles_file_check', sql`length(telegram_file_id) BETWEEN 1 AND 512`),
  ],
);

/**
 * One recipient of one broadcast: the FROZEN identity (customer, bot, chat) materialised at
 * launch, and its delivery state. At most once: `SENDING` is committed before the request, and
 * a stamped row whose outcome was never recorded becomes `UNCONFIRMED`, never `PENDING`.
 */
export const broadcastRecipients = pgTable(
  'broadcast_recipients',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    broadcastId: uuid('broadcast_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    botInstanceId: uuid('bot_instance_id').references(() => botInstances.id),
    chatId: text('chat_id').notNull(),
    state: text('state').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at'),
    leaseUntil: timestamptz('lease_until'),
    sendStartedAt: timestamptz('send_started_at'),
    resolvedAt: timestamptz('resolved_at'),
    /** The transport's code, never Telegram's description (which can quote a chat id). */
    errorCode: text('error_code'),
    /**
     * Round N close (§C): the delivered message's id, kept for the pin; and the pin's own
     * outcome, recorded apart from the send. `pin_started_at` is stamped BEFORE the pin
     * request; a PENDING pin whose stamp is older than the lease is resolved UNCONFIRMED.
     */
    sentMessageId: bigint('sent_message_id', { mode: 'number' }),
    pinState: text('pin_state'),
    pinErrorCode: text('pin_error_code'),
    pinStartedAt: timestamptz('pin_started_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /** The pin reaper: stamped pins whose answer never came. */
    index('broadcast_recipients_pin_stranded_idx')
      .on(table.pinStartedAt)
      .where(sql`pin_state = 'PENDING'`),
    check(
      'broadcast_recipients_pin_state_check',
      nullableEnumCheck('pin_state', BROADCAST_PIN_STATES),
    ),
    check(
      'broadcast_recipients_pin_check',
      sql`(pin_state IS NULL OR (state = 'SENT' AND sent_message_id IS NOT NULL AND pin_started_at IS NOT NULL))
          AND (pin_error_code IS NULL OR length(pin_error_code) BETWEEN 1 AND 100)`,
    ),
    primaryKey({
      name: 'broadcast_recipients_pk',
      columns: [table.tenantId, table.broadcastId, table.customerId],
    }),
    foreignKey({
      columns: [table.tenantId, table.broadcastId],
      foreignColumns: [broadcasts.tenantId, broadcasts.id],
      name: 'broadcast_recipients_broadcast_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'broadcast_recipients_customer_fk',
    }),
    /** The claim: a bot's waiting recipients, in a stable order. */
    index('broadcast_recipients_due_idx')
      .on(table.tenantId, table.botInstanceId, table.broadcastId, table.customerId)
      .where(sql`state = 'PENDING'`),
    /** The reaper: stamped sends whose lease ran out. */
    index('broadcast_recipients_stranded_idx')
      .on(table.leaseUntil)
      .where(sql`state = 'SENDING'`),
    /** The report: counts per state, and the recipients page. */
    index('broadcast_recipients_state_idx').on(
      table.tenantId,
      table.broadcastId,
      table.state,
      table.customerId,
    ),
    check('broadcast_recipients_state_check', enumCheck('state', BROADCAST_RECIPIENT_STATES)),
    check('broadcast_recipients_attempts_check', sql`attempts >= 0 AND attempts <= 100`),
    check(
      'broadcast_recipients_resolved_check',
      sql`(state IN ('PENDING', 'SENDING')) = (resolved_at IS NULL)`,
    ),
    check(
      'broadcast_recipients_sending_check',
      sql`state <> 'SENDING' OR (send_started_at IS NOT NULL AND lease_until IS NOT NULL)`,
    ),
    check(
      'broadcast_recipients_error_check',
      sql`error_code IS NULL OR length(error_code) BETWEEN 1 AND 100`,
    ),
  ],
);

/**
 * One bot's broadcast send budget, shared by every worker replica: `BROADCAST_SENDS_PER_SECOND`
 * per one-second window, taken under this row's lock, and `hold_until` when Telegram answered
 * 429 — every replica then waits for that bot until Telegram's own time.
 */
export const broadcastBotPacing = pgTable(
  'broadcast_bot_pacing',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    windowStartedAt: timestamptz('window_started_at').notNull(),
    sentInWindow: integer('sent_in_window').notNull().default(0),
    holdUntil: timestamptz('hold_until'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'broadcast_bot_pacing_pk', columns: [table.tenantId, table.botInstanceId] }),
    check('broadcast_bot_pacing_sent_check', sql`sent_in_window >= 0`),
  ],
);

/**
 * One mass action (B2) — a wallet credit or a traffic/time grant — with its frozen audience,
 * what each item is given, and its lifecycle. Created already confirmed: the confirmation
 * transaction materialises the items beside it and compares them with what was previewed.
 */
export const bulkOperations = pgTable(
  'bulk_operations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    state: text('state').notNull().default('RUNNING'),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }),
    currency: text('currency'),
    trafficBytes: bigint('traffic_bytes', { mode: 'bigint' }),
    durationDays: integer('duration_days'),
    notify: boolean('notify').notNull(),
    note: text('note').notNull(),
    audienceDefinition: jsonb('audience_definition').notNull(),
    audienceHash: text('audience_hash').notNull(),
    audienceAsOf: timestamptz('audience_as_of').notNull(),
    itemCount: integer('item_count').notNull(),
    audienceFingerprint: text('audience_fingerprint').notNull(),
    /**
     * The earliest instant an item may be processed (NULL = at once). The items are frozen
     * at creation all the same; only the processing waits, and the claim query itself
     * enforces it.
     */
    notBefore: timestamptz('not_before'),
    /** Round N close (§A): the frozen audience the items were copied from, if any. */
    frozenAudienceId: uuid('frozen_audience_id'),
    createdByAdminId: uuid('created_by_admin_id')
      .notNull()
      .references(() => admins.id),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    /** Round N close (§B): set while PAUSED, cleared by a resume. */
    pausedAt: timestamptz('paused_at'),
    completedAt: timestamptz('completed_at'),
    cancelledAt: timestamptz('cancelled_at'),
    /**
     * Program §13: the operation whose FAILED items this one retries. Its items are a copy
     * of those, so the original's history is never rewritten.
     */
    retryOfId: uuid('retry_of_id'),
  },
  (table) => [
    unique('bulk_operations_tenant_id_key').on(table.tenantId, table.id),
    foreignKey({
      columns: [table.tenantId, table.retryOfId],
      foreignColumns: [table.tenantId, table.id],
      name: 'bulk_operations_retry_of_fk',
    }),
    index('bulk_operations_retry_of_idx')
      .on(table.tenantId, table.retryOfId)
      .where(sql`retry_of_id IS NOT NULL`),
    foreignKey({
      columns: [table.tenantId, table.frozenAudienceId],
      foreignColumns: [frozenAudiences.tenantId, frozenAudiences.id],
      name: 'bulk_operations_frozen_audience_fk',
    }).onDelete('restrict'),
    check('bulk_operations_paused_check', sql`(state = 'PAUSED') = (paused_at IS NOT NULL)`),
    index('bulk_operations_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    index('bulk_operations_running_idx')
      .on(table.tenantId)
      .where(sql`state = 'RUNNING'`),
    check('bulk_operations_kind_check', enumCheck('kind', BULK_OPERATION_KINDS)),
    check('bulk_operations_state_check', enumCheck('state', BULK_OPERATION_STATES)),
    check('bulk_operations_currency_check', nullableEnumCheck('currency', CURRENCY_CODES)),
    /** Exactly the grant its kind names, and nothing of the others. */
    check(
      'bulk_operations_grant_check',
      sql`CASE kind
            WHEN 'WALLET_CREDIT' THEN amount_minor IS NOT NULL AND amount_minor > 0
                 AND currency IS NOT NULL AND traffic_bytes IS NULL AND duration_days IS NULL
            WHEN 'SERVICE_TRAFFIC' THEN traffic_bytes IS NOT NULL AND traffic_bytes > 0
                 AND amount_minor IS NULL AND currency IS NULL AND duration_days IS NULL
            WHEN 'SERVICE_TIME' THEN duration_days IS NOT NULL AND duration_days > 0
                 AND amount_minor IS NULL AND currency IS NULL AND traffic_bytes IS NULL
            WHEN 'SERVICE_SUSPEND' THEN amount_minor IS NULL AND currency IS NULL
                 AND traffic_bytes IS NULL AND duration_days IS NULL AND NOT notify
            WHEN 'SERVICE_RESUME' THEN amount_minor IS NULL AND currency IS NULL
                 AND traffic_bytes IS NULL AND duration_days IS NULL AND NOT notify
            ELSE false
          END`,
    ),
    check(
      'bulk_operations_note_check',
      sql`length(note) BETWEEN 1 AND ${sql.raw(String(BULK_NOTE_MAX_LENGTH))}`,
    ),
    check('bulk_operations_hash_check', sql`audience_hash ~ '^[0-9a-f]{64}$'`),
    check('bulk_operations_items_check', sql`item_count >= 1`),
    check(
      'bulk_operations_completed_check',
      sql`(state = 'COMPLETED') = (completed_at IS NOT NULL)`,
    ),
    check(
      'bulk_operations_cancelled_check',
      sql`(state = 'CANCELLED') = (cancelled_at IS NOT NULL)`,
    ),
  ],
);

/**
 * One item of a mass action: a customer (wallet credit) or a service (traffic/time), frozen at
 * confirmation. Its `id` is the subject of the customer notification that announces it.
 */
export const bulkOperationItems = pgTable(
  'bulk_operation_items',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    bulkOperationId: uuid('bulk_operation_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    serviceId: uuid('service_id'),
    state: text('state').notNull().default('PENDING'),
    skipReason: text('skip_reason'),
    walletEntryId: uuid('wallet_entry_id'),
    provisioningOperationId: uuid('provisioning_operation_id'),
    /**
     * When the item's notice was ENQUEUED on the customer notification lane — never whether
     * it was delivered. What the operator reads as "notified" is the lane's own row
     * (`customer_notifications`, subject = this item), Codex R4 on PR #117.
     */
    notifiedAt: timestamptz('notified_at'),
    processedAt: timestamptz('processed_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('bulk_operation_items_tenant_id_key').on(table.tenantId, table.id),
    foreignKey({
      columns: [table.tenantId, table.bulkOperationId],
      foreignColumns: [bulkOperations.tenantId, bulkOperations.id],
      name: 'bulk_operation_items_operation_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'bulk_operation_items_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'bulk_operation_items_service_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.walletEntryId],
      foreignColumns: [walletEntries.tenantId, walletEntries.id],
      name: 'bulk_operation_items_wallet_entry_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.provisioningOperationId],
      foreignColumns: [provisioningOperations.tenantId, provisioningOperations.id],
      name: 'bulk_operation_items_operation_row_fk',
    }),
    /** One item per customer of a wallet credit, one per service of a grant. */
    uniqueIndex('bulk_operation_items_customer_key')
      .on(table.tenantId, table.bulkOperationId, table.customerId)
      .where(sql`service_id IS NULL`),
    uniqueIndex('bulk_operation_items_service_key')
      .on(table.tenantId, table.bulkOperationId, table.serviceId)
      .where(sql`service_id IS NOT NULL`),
    index('bulk_operation_items_pending_idx')
      .on(table.tenantId, table.bulkOperationId, table.id)
      .where(sql`state = 'PENDING'`),
    index('bulk_operation_items_planned_idx')
      .on(table.tenantId, table.bulkOperationId)
      .where(sql`state = 'PLANNED'`),
    index('bulk_operation_items_state_idx').on(
      table.tenantId,
      table.bulkOperationId,
      table.state,
      table.id,
    ),
    check('bulk_operation_items_state_check', enumCheck('state', BULK_ITEM_STATES)),
    check('bulk_operation_items_skip_check', nullableEnumCheck('skip_reason', BULK_SKIP_REASONS)),
    check(
      'bulk_operation_items_skipped_check',
      sql`(state = 'SKIPPED') = (skip_reason IS NOT NULL)`,
    ),
    check(
      'bulk_operation_items_credited_check',
      sql`(state = 'CREDITED') = (wallet_entry_id IS NOT NULL)`,
    ),
    check(
      'bulk_operation_items_planned_check',
      sql`(state IN ('PLANNED', 'SUCCEEDED', 'FAILED')) = (provisioning_operation_id IS NOT NULL)`,
    ),
    check(
      'bulk_operation_items_processed_check',
      sql`(state IN ('PENDING', 'CANCELLED')) = (processed_at IS NULL)`,
    ),
  ],
);
