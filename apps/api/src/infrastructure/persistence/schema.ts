import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';
import {
  ACTOR_TYPES,
  AUDIT_RESULTS,
  BOT_INSTANCE_STATUSES,
  CALENDARS,
  CURRENCY_CODES,
  OPERATIONAL_SEVERITIES,
  SOURCE_SURFACES,
  TENANT_KINDS,
  TENANT_STATUSES,
} from '@nexa/contracts';

/**
 * Builds a CHECK constraint from a contract enum, so the database rejects any
 * value the contract does not define. The legacy system encodes one service
 * status four different ways — `active`, `فعال`, and two emoji-prefixed Persian
 * phrases — because nothing constrained the column.
 */
function enumCheck(column: string, values: readonly string[]): SQL {
  const list = values.map((v) => `'${v}'`).join(', ');
  return sql.raw(`${column} IN (${list})`);
}

/**
 * Phase 0 schema — the foundation tables, and nothing else.
 *
 * Conventions, all enforced here rather than by memory:
 *   - `id` is UUIDv7, generated in the application so the value exists before
 *     the INSERT and can be written into an outbox row in the same statement.
 *   - every timestamp is `timestamptz`, stored UTC.
 *   - every status is a CHECK-constrained text column, never free text.
 *   - tenant-owned rows carry `tenant_id NOT NULL`; rows that genuinely belong
 *     to no tenant carry NULL and say so.
 *   - append-only tables are protected by a trigger, not by convention
 *     (see migrations/0001_foundation.sql).
 *
 * There is deliberately no `balance` column, no money column and no product
 * table here. Phase 0 has no business features.
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    parentTenantId: uuid('parent_tenant_id'),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    locale: text('locale').notNull().default('fa'),
    displayTimezone: text('display_timezone').notNull().default('Asia/Tehran'),
    calendar: text('calendar').notNull().default('jalali'),
    currency: text('currency').notNull().default('IRT'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('tenants_slug_key').on(table.slug),
    check('tenants_kind_check', enumCheck('kind', TENANT_KINDS)),
    check('tenants_status_check', enumCheck('status', TENANT_STATUSES)),
    check('tenants_calendar_check', enumCheck('calendar', CALENDARS)),
    check('tenants_currency_check', enumCheck('currency', CURRENCY_CODES)),
    // A reseller sales bot is a tenant with a parent; a primary tenant has none.
    check(
      'tenants_parent_check',
      sql`(kind = 'PRIMARY' AND parent_tenant_id IS NULL) OR (kind <> 'PRIMARY' AND parent_tenant_id IS NOT NULL)`,
    ),
  ],
);

/**
 * A bot instance is a Telegram bot. It is NOT a tenant: one tenant may own
 * several, and a reseller sales bot is its own tenant that owns one.
 */
export const botInstances = pgTable(
  'bot_instances',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    username: text('username').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    /** Envelope-encrypted. Never returned by any API, never logged. */
    tokenCiphertext: text('token_ciphertext').notNull(),
    tokenKeyId: text('token_key_id').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('bot_instances_username_key').on(table.username),
    index('bot_instances_tenant_idx').on(table.tenantId),
    check('bot_instances_status_check', enumCheck('status', BOT_INSTANCE_STATUSES)),
  ],
);

// ---------------------------------------------------------------------------
// Eventing — the transactional outbox
// ---------------------------------------------------------------------------

export const outboxMessages = pgTable(
  'outbox_messages',
  {
    id: uuid('id').primaryKey(),
    /** NULL for platform events that belong to no tenant. */
    tenantId: uuid('tenant_id'),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    /** Monotonic per aggregate. Ordering is guaranteed per aggregate only. */
    sequence: integer('sequence').notNull(),
    eventType: text('event_type').notNull(),
    eventVersion: integer('event_version').notNull().default(1),
    payload: jsonb('payload').notNull(),
    actor: jsonb('actor').notNull(),
    correlationId: text('correlation_id').notNull(),
    causationId: text('causation_id'),
    occurredAt: timestamptz('occurred_at').notNull(),
    publishedAt: timestamptz('published_at'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('outbox_messages_aggregate_sequence_key').on(
      table.aggregateType,
      table.aggregateId,
      table.sequence,
    ),
    // Partial index: keeps the relay's claim query O(unpublished), not O(table).
    index('outbox_messages_unpublished_idx')
      .on(table.occurredAt)
      .where(sql`published_at IS NULL`),
    check('outbox_messages_sequence_check', sql`sequence >= 1`),
    check('outbox_messages_attempts_check', sql`attempts >= 0`),
  ],
);

/**
 * Consumer-side dedupe.
 *
 * The outbox gives at-least-once delivery. Effectively-once EFFECTS come from
 * each consumer recording the event ids it has already applied.
 */
export const processedMessages = pgTable(
  'processed_messages',
  {
    consumer: text('consumer').notNull(),
    messageId: uuid('message_id').notNull(),
    processedAt: timestamptz('processed_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('processed_messages_pkey').on(table.consumer, table.messageId)],
);

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

export const requestIdempotency = pgTable(
  'request_idempotency',
  {
    id: uuid('id').primaryKey(),
    /**
     * The tenant id as text, or the literal 'SYSTEM'. A plain nullable
     * `tenant_id` cannot participate in a unique constraint, because Postgres
     * treats NULLs as distinct — which would silently allow duplicate keys.
     */
    scopeRef: text('scope_ref').notNull(),
    tenantId: uuid('tenant_id'),
    key: text('key').notNull(),
    /** Hash of the request payload. A reused key with different input is a bug. */
    requestHash: text('request_hash').notNull(),
    result: jsonb('result'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('request_idempotency_scope_key').on(table.scopeRef, table.key)],
);

// ---------------------------------------------------------------------------
// Audit — who changed what, with before and after
// ---------------------------------------------------------------------------

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id'),
    occurredAt: timestamptz('occurred_at').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    /** Captured at action time so the record survives a later rename. */
    actorLabel: text('actor_label'),
    /** A machine code such as 'wallet.credit'. Never a prose sentence. */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    /** Values, not references. Secrets are replaced by a marker before writing. */
    before: jsonb('before'),
    after: jsonb('after'),
    reason: text('reason'),
    correlationId: text('correlation_id').notNull(),
    requestId: text('request_id'),
    sourceSurface: text('source_surface').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** Denials are audited too. */
    result: text('result').notNull(),
  },
  (table) => [
    index('audit_logs_tenant_occurred_idx').on(table.tenantId, table.occurredAt),
    index('audit_logs_entity_idx').on(table.entityType, table.entityId),
    index('audit_logs_correlation_idx').on(table.correlationId),
    check('audit_logs_actor_type_check', enumCheck('actor_type', ACTOR_TYPES)),
    check('audit_logs_result_check', enumCheck('result', AUDIT_RESULTS)),
    check('audit_logs_surface_check', enumCheck('source_surface', SOURCE_SURFACES)),
  ],
);

// ---------------------------------------------------------------------------
// Operational events — what the system did
// ---------------------------------------------------------------------------

export const operationalEvents = pgTable(
  'operational_events',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id'),
    code: text('code').notNull(),
    severity: text('severity').notNull(),
    message: text('message').notNull(),
    context: jsonb('context'),
    /** Repeats collapse onto one row and increment the counter. */
    dedupeKey: text('dedupe_key'),
    occurrenceCount: integer('occurrence_count').notNull().default(1),
    firstSeenAt: timestamptz('first_seen_at').notNull(),
    lastSeenAt: timestamptz('last_seen_at').notNull(),
    correlationId: text('correlation_id'),
    /** Set when this event records recovery from an earlier failure code. */
    recoversCode: text('recovers_code'),
  },
  (table) => [
    index('operational_events_tenant_seen_idx').on(table.tenantId, table.lastSeenAt),
    index('operational_events_code_idx').on(table.code),
    uniqueIndex('operational_events_dedupe_key').on(table.dedupeKey),
    check('operational_events_severity_check', enumCheck('severity', OPERATIONAL_SEVERITIES)),
    check('operational_events_occurrence_check', sql`occurrence_count >= 1`),
  ],
);

// ---------------------------------------------------------------------------
// Telegram callback references
// ---------------------------------------------------------------------------

export const callbackRefs = pgTable(
  'callback_refs',
  {
    ref: text('ref').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id').references(() => botInstances.id),
    flow: text('flow').notNull(),
    step: text('step').notNull(),
    payload: jsonb('payload').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [index('callback_refs_expires_idx').on(table.expiresAt)],
);

/** A counter that keeps the outbox `sequence` monotonic per aggregate. */
export const aggregateSequences = pgTable(
  'aggregate_sequences',
  {
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    lastSequence: bigint('last_sequence', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
  },
  (table) => [uniqueIndex('aggregate_sequences_pkey').on(table.aggregateType, table.aggregateId)],
);

export const schema = {
  tenants,
  botInstances,
  outboxMessages,
  processedMessages,
  requestIdempotency,
  auditLogs,
  operationalEvents,
  callbackRefs,
  aggregateSequences,
};

/** Tables the database itself refuses to UPDATE or DELETE. */
export const APPEND_ONLY_TABLES = ['audit_logs', 'processed_messages'] as const;
