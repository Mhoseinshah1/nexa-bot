/**
 * Database schema — eventing: the outbox, idempotency, audit and operational events.
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 */
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  ACTOR_TYPES,
  AUDIT_RESULTS,
  OPERATIONAL_SEVERITIES,
  SOURCE_SURFACES,
} from '@nexa/contracts';
import { enumCheck, timestamptz } from './_shared.js';

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
    /**
     * When the relay may try this message again after a failure (WP20, brief §3.1). NULL
     * means due now: a message that has never failed, and every row written before this
     * column existed. A failure moves only its own row, so the messages behind it are not
     * held up.
     */
    nextAttemptAt: timestamptz('next_attempt_at'),
    /**
     * When the relay gave up on this message and said so (WP20, brief §3.2): set by the
     * failure that reached `DELIVERY_MAX_FAILED_ATTEMPTS`, in the transaction that records
     * the announcement. NULL means still retried. A mark rather than a count, because a
     * count can grow under a release that never decides or announces anything.
     */
    exhaustedAt: timestamptz('exhausted_at'),
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
    // The same partial set, led by tenant.
    //
    // The index above orders ALL unpublished rows by time, which is right when
    // everything is dispatchable and wrong when it is not: a stopped tenant's
    // backlog had to be walked in full to prove it held nothing for an active
    // one. Leading with `tenant_id` lets the relay go straight to the rows it
    // may actually act on, and skip a paused tenant's entirely.
    index('outbox_messages_tenant_unpublished_idx')
      .on(table.tenantId, table.occurredAt)
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
    /**
     * Phase 6B (D5): the hosted tenant the installation owner acted IN through «ورود به پنل».
     * Such a row belongs to the installation's log (`tenant_id`), names the owner as the actor,
     * and is the only record of the act: the hosted tenant's own log receives nothing.
     */
    actedInTenantId: uuid('acted_in_tenant_id'),
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
    /**
     * Which dedupe namespace this row belongs to: the tenant id, or 'SYSTEM'.
     *
     * Without it the unique index below is global, and two tenants recording
     * the same dedupe key collapse onto ONE row — a cross-tenant write that no
     * repository predicate can prevent, because the collision happens in the
     * index rather than in a query.
     */
    dedupeScope: text('dedupe_scope').notNull().default('SYSTEM'),
    /** Repeats within one scope collapse onto one row and increment the counter. */
    dedupeKey: text('dedupe_key'),
    occurrenceCount: integer('occurrence_count').notNull().default(1),
    firstSeenAt: timestamptz('first_seen_at').notNull(),
    lastSeenAt: timestamptz('last_seen_at').notNull(),
    correlationId: text('correlation_id'),
    /** Set when this event records recovery from an earlier failure code. */
    recoversCode: text('recovers_code'),
    /**
     * When the condition this row records was observed to have cleared.
     *
     * Set by a recovery event naming this row's code, and cleared again if the
     * condition recurs. NOTHING IS DELETED either way: the failure row keeps its
     * message, its counter and its first-seen time, and the recovery event
     * stands beside it. History is the sequence of events; this column is a
     * marker over it, so an operator can tell an ongoing incident from one that
     * was fixed at four in the morning.
     */
    resolvedAt: timestamptz('resolved_at'),
    /** The recovery event that closed it. */
    resolvedByEventId: uuid('resolved_by_event_id'),
  },
  (table) => [
    index('operational_events_tenant_seen_idx').on(table.tenantId, table.lastSeenAt),
    index('operational_events_code_idx').on(table.code),
    uniqueIndex('operational_events_dedupe_key').on(table.dedupeScope, table.dedupeKey),
    // There is deliberately no index on `resolved_at`. One was drafted for a
    // retention sweep, and the sweep turned out not to be able to exist (the
    // table refuses DELETE — ADR-0020). An index whose only query was removed is
    // a write cost with nothing on the other side of it, so it went too.
    check('operational_events_severity_check', enumCheck('severity', OPERATIONAL_SEVERITIES)),
    check('operational_events_occurrence_check', sql`occurrence_count >= 1`),
    // A resolver without a resolution time is nonsense in either direction. The
    // UPDATE guard in migration 0011 says the same thing for updates; this says
    // it for inserts, which a BEFORE UPDATE trigger never sees.
    check(
      'operational_events_resolution_check',
      sql`resolved_by_event_id IS NULL OR resolved_at IS NOT NULL`,
    ),
  ],
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
