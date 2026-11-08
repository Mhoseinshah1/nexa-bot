/**
 * Database schema — support AI: configs, provider credentials, runs, jobs, holds.
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
  BUSINESS_HANDOFF_REASONS,
  BUSINESS_HANDOFF_KINDS,
  SUPPORT_AI_MODES,
  SUPPORT_AI_FAILURE_CLASSES,
  SUPPORT_AI_OPERATIONS,
  SUPPORT_AI_OUTCOMES,
  SUPPORT_AI_PROVIDERS,
  SUPPORT_AI_CONFIDENCES,
  SUPPORT_AI_DECISIONS,
  SUPPORT_AI_JOB_KINDS,
  SUPPORT_AI_JOB_STATES,
  SUPPORT_AI_IMAGE_OUTCOMES,
  SUPPORT_AI_IMAGE_SKIP_REASONS,
  SUPPORT_AI_TICKET_ACTIONS,
  SUPPORT_AI_TOPICS,
  SUPPORT_AI_SAFE_TOPICS,
  SUPPORT_AI_AUTO_MIN_CONFIDENCES,
  SUPPORT_AI_AUTO_OUTCOMES,
  SUPPORT_AI_ACTION_KINDS,
  SUPPORT_AI_TICKET_JOB_STATES,
  SUPPORT_AI_TICKET_HOLD_STATES,
} from '@nexa/contracts';
import { enumCheck, enumSubsetCheck, nullableEnumCheck, timestamptz } from './_shared.js';
import { tenants } from './tenancy.js';
import { admins } from './identity.js';
import { ticketMessages, tickets } from './support.js';
import { businessConversations, businessMessages } from './business-chats.js';

/**
 * TB4 — a tenant's support-AI configuration (ADR-0034 §8). One row per tenant, created on the
 * first save; a tenant with no row is `SUPPORT_AI_DEFAULT_CONFIG` — mode `OFF`. No migration
 * inserts a row, and none ever sets `AUTO_REPLY_SAFE` (program §49).
 *
 * Optimistic per-row versioning (ADR-0021). Every bound the input schema applies is also a
 * CHECK, so a writer that forgets the schema is still refused.
 */
export const supportAiConfigs = pgTable(
  'support_ai_configs',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    mode: text('mode').notNull().default('OFF'),
    primaryProvider: text('primary_provider'),
    primaryModel: text('primary_model'),
    /** Ordered `[{provider, model}]`, at most two, each a different provider. */
    fallbacks: jsonb('fallbacks')
      .notNull()
      .default(sql`'[]'::jsonb`),
    visionEnabled: boolean('vision_enabled').notNull().default(false),
    timeoutMs: integer('timeout_ms').notNull(),
    maxOutputChars: integer('max_output_chars').notNull(),
    /**
     * RETIRED by roadmap A1 (0236): no longer read or written by this release; its value is the
     * old per-epoch limit. Kept (with a default so the new writer may omit it) because a column is
     * dropped only in the release after the one that stopped writing it.
     */
    maxConsecutiveReplies: integer('max_consecutive_replies').notNull().default(4),
    /**
     * Roadmap A1 (0236): automatic replies per session, and per conversation per hour. Added with
     * the contract defaults, so every existing tenant reads 20 and 30.
     */
    sessionReplyBudget: integer('session_reply_budget').notNull().default(20),
    maxAutoRepliesPerHour: integer('max_auto_replies_per_hour').notNull().default(30),
    /**
     * Hotfix (2026-10-06): sent automatic clarifying questions in a row before a handoff.
     * Added by 0218 with the contract default, so an existing tenant keeps a working limit.
     * Roadmap A2 (0236): the column default is 3; stored values are left as they are.
     */
    maxConsecutiveClarifyingQuestions: integer('max_consecutive_clarifying_questions')
      .notNull()
      .default(3),
    cooldownSeconds: integer('cooldown_seconds').notNull(),
    settleDelaySeconds: integer('settle_delay_seconds').notNull().default(6),
    toneInstructions: text('tone_instructions').notNull().default(''),
    /** TB7: the safe topics an automatic reply may answer. EMPTY by default: none. */
    autoTopics: text('auto_topics')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    autoMinConfidence: text('auto_min_confidence').notNull().default('HIGH'),
    updatedByAdminId: uuid('updated_by_admin_id'),
    version: integer('version').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.updatedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'support_ai_configs_admin_fk',
    }),
    check('support_ai_configs_mode_check', enumCheck('mode', SUPPORT_AI_MODES)),
    check(
      'support_ai_configs_primary_provider_check',
      enumCheck('primary_provider', SUPPORT_AI_PROVIDERS),
    ),
    check(
      'support_ai_configs_primary_shape_check',
      sql`(primary_provider IS NULL) = (primary_model IS NULL)`,
    ),
    // A mode that does AI work names a provider.
    check(
      'support_ai_configs_mode_provider_check',
      sql`mode = 'OFF' OR primary_provider IS NOT NULL`,
    ),
    check(
      'support_ai_configs_fallbacks_check',
      sql`jsonb_typeof(fallbacks) = 'array' AND jsonb_array_length(fallbacks) <= 2`,
    ),
    check('support_ai_configs_timeout_check', sql`timeout_ms BETWEEN 5000 AND 120000`),
    check('support_ai_configs_output_check', sql`max_output_chars BETWEEN 200 AND 4000`),
    check('support_ai_configs_replies_check', sql`max_consecutive_replies BETWEEN 1 AND 20`),
    check('support_ai_configs_session_budget_check', sql`session_reply_budget BETWEEN 5 AND 40`),
    check(
      'support_ai_configs_hourly_limit_check',
      sql`max_auto_replies_per_hour BETWEEN 10 AND 60`,
    ),
    check(
      'support_ai_configs_clarifying_check',
      sql`max_consecutive_clarifying_questions BETWEEN 1 AND 10`,
    ),
    check('support_ai_configs_cooldown_check', sql`cooldown_seconds BETWEEN 0 AND 3600`),
    check('support_ai_configs_settle_check', sql`settle_delay_seconds BETWEEN 3 AND 30`),
    check('support_ai_configs_tone_check', sql`length(tone_instructions) <= 2000`),
    check(
      'support_ai_configs_auto_topics_check',
      sql`cardinality(auto_topics) = 0 OR (${enumSubsetCheck('auto_topics', SUPPORT_AI_SAFE_TOPICS)})`,
    ),
    check(
      'support_ai_configs_auto_confidence_check',
      enumCheck('auto_min_confidence', SUPPORT_AI_AUTO_MIN_CONFIDENCES),
    ),
    check('support_ai_configs_version_check', sql`version >= 1`),
  ],
);

/**
 * TB4 — one tenant's key for one AI provider (ADR-0023 to the letter, ADR-0034 §8).
 *
 * The key travels ONE way: written encrypted (`support_ai_provider.api_key`, AAD bound to this
 * row's id), read in plaintext only by the adapter's call, and projected to every surface as
 * `set_at` alone — no ciphertext, no masked stand-in. The three key columns are all null or
 * all present.
 *
 * The circuit breaker's state lives HERE (TB0 review F4), never in `operational_events`, which
 * only reports it.
 */
export const supportAiProviderCredentials = pgTable(
  'support_ai_provider_credentials',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    provider: text('provider').notNull(),
    apiKeyCiphertext: text('api_key_ciphertext').notNull(),
    apiKeyKeyId: text('api_key_key_id').notNull(),
    apiKeySetAt: timestamptz('api_key_set_at').notNull(),
    /** `ZAI` only: which host the key belongs to. A closed choice, never a URL. */
    region: text('region'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    trippedUntil: timestamptz('tripped_until'),
    /**
     * Set when the provider last REJECTED this key (`AUTH_FAILED`), cleared by its next answer.
     * The transition null → set raises `credential_rejected`; set → null closes it — so the
     * alert is raised once and closed once, never re-recorded on every call.
     */
    rejectedAt: timestamptz('rejected_at'),
    lastTestOutcome: text('last_test_outcome'),
    /** Why the last capability test was not OK: its first failing check's class. */
    lastTestFailureClass: text('last_test_failure_class'),
    lastTestedAt: timestamptz('last_tested_at'),
    /** Phase 4 PR-5: the model that capability test ran on (readiness compares it to the primary's). */
    lastTestedModel: text('last_tested_model'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('support_ai_provider_credentials_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('support_ai_provider_credentials_provider_key').on(table.tenantId, table.provider),
    check(
      'support_ai_provider_credentials_provider_check',
      enumCheck('provider', SUPPORT_AI_PROVIDERS),
    ),
    check(
      'support_ai_provider_credentials_region_check',
      sql`region IS NULL OR (provider = 'ZAI' AND region IN ('INTERNATIONAL', 'CHINA'))`,
    ),
    check(
      'support_ai_provider_credentials_test_outcome_check',
      enumCheck('last_test_outcome', SUPPORT_AI_OUTCOMES),
    ),
    check(
      'support_ai_provider_credentials_test_failure_class_check',
      nullableEnumCheck('last_test_failure_class', SUPPORT_AI_FAILURE_CLASSES),
    ),
    // A passed test has no failure class (`lastTestOutcome` OK means every check passed).
    check(
      'support_ai_provider_credentials_test_failure_shape_check',
      sql`last_test_outcome IS DISTINCT FROM 'OK' OR last_test_failure_class IS NULL`,
    ),
    check('support_ai_provider_credentials_failures_check', sql`consecutive_failures >= 0`),
  ],
);

/**
 * TB4 — one provider call (ADR-0034 §9). Telemetry only: provider, model, position in the
 * fallback chain, latency, tokens, outcome. NEVER a prompt and never a response — those are a
 * customer's conversation, and keeping them would be PII at rest with no owner.
 */
export const supportAiRuns = pgTable(
  'support_ai_runs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    conversationId: uuid('conversation_id'),
    operation: text('operation').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    attemptIndex: integer('attempt_index').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    outcome: text('outcome').notNull(),
    failureCode: text('failure_code'),
    /**
     * The AI job this call was made for (Assist draft or automatic decision); null for a
     * connection test, a summary or a learning extraction. How a job's failure is explained.
     */
    jobId: uuid('job_id'),
    /**
     * Why the call failed (`SUPPORT_AI_FAILURE_CLASSES`), and its safe particulars: the HTTP
     * status, the provider's own error code, type and param as short tokens, and — for a
     * decision that failed NEXA's schema — the zod issue's path and code. Never a value, the
     * provider's message, the prompt or the response.
     */
    failureClass: text('failure_class'),
    httpStatus: integer('http_status'),
    providerErrorCode: text('provider_error_code'),
    providerErrorType: text('provider_error_type'),
    providerErrorParam: text('provider_error_param'),
    schemaIssuePath: text('schema_issue_path'),
    schemaIssueCode: text('schema_issue_code'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    /** The usage summary: a tenant's runs in a window. */
    index('support_ai_runs_tenant_created_idx').on(table.tenantId, table.createdAt),
    /** A job's calls, for its failure diagnosis. */
    index('support_ai_runs_job_idx')
      .on(table.tenantId, table.jobId)
      .where(sql`job_id IS NOT NULL`),
    foreignKey({
      columns: [table.tenantId, table.jobId],
      foreignColumns: [supportAiJobs.tenantId, supportAiJobs.id],
      name: 'support_ai_runs_job_fk',
    }),
    check(
      'support_ai_runs_failure_class_check',
      nullableEnumCheck('failure_class', SUPPORT_AI_FAILURE_CLASSES),
    ),
    // A class is a failure's: an OK call carries none.
    check('support_ai_runs_failure_shape_check', sql`outcome <> 'OK' OR failure_class IS NULL`),
    check(
      'support_ai_runs_http_status_check',
      sql`http_status IS NULL OR http_status BETWEEN 100 AND 599`,
    ),
    check(
      'support_ai_runs_provider_error_check',
      sql`(provider_error_code IS NULL OR length(provider_error_code) <= 64)
          AND (provider_error_type IS NULL OR length(provider_error_type) <= 64)
          AND (provider_error_param IS NULL OR length(provider_error_param) <= 64)
          AND (schema_issue_path IS NULL OR length(schema_issue_path) <= 128)
          AND (schema_issue_code IS NULL OR length(schema_issue_code) <= 64)`,
    ),
    foreignKey({
      columns: [table.tenantId, table.conversationId],
      foreignColumns: [businessConversations.tenantId, businessConversations.id],
      name: 'support_ai_runs_conversation_fk',
    }),
    check('support_ai_runs_operation_check', enumCheck('operation', SUPPORT_AI_OPERATIONS)),
    check('support_ai_runs_provider_check', enumCheck('provider', SUPPORT_AI_PROVIDERS)),
    check('support_ai_runs_outcome_check', enumCheck('outcome', SUPPORT_AI_OUTCOMES)),
    check('support_ai_runs_attempt_check', sql`attempt_index BETWEEN 0 AND 2`),
    check('support_ai_runs_latency_check', sql`latency_ms >= 0`),
    check('support_ai_runs_model_check', sql`length(model) BETWEEN 1 AND 128`),
  ],
);

/**
 * TB5 — a support-AI job and its result (ADR-0034 §7). In TB5 every job is an operator's
 * request for an Assist draft; TB7 adds the automatic kind.
 *
 * The `assistant` process role claims QUEUED rows (`claimed_until` lease, `attempts`), calls the
 * provider chain OUTSIDE any transaction, and records the validated decision here. A draft is a
 * SUGGESTION: nothing on this row is ever sent except by an operator's explicit send, through
 * the ordinary outbound lane as an `ASSIST` row (a human signal).
 *
 * The AI text (summary, suggested reply) is a customer's conversation restated: bounded, and
 * purged with the transcript's retention (`SUPPORT_AI_DRAFT_RETENTION_DAYS`).
 */
export const supportAiJobs = pgTable(
  'support_ai_jobs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    requestedByAdminId: uuid('requested_by_admin_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    /**
     * What the key was used for (TB5 review, finding 5): a replay under the same key with a
     * different conversation is refused, never answered with the other conversation's job.
     * Nullable only because 0201 created rows without it; every insert writes it.
     */
    requestHash: text('request_hash'),
    state: text('state').notNull().default('QUEUED'),
    attempts: integer('attempts').notNull().default(0),
    claimedUntil: timestamptz('claimed_until'),
    readyAt: timestamptz('ready_at'),
    failureCode: text('failure_code'),
    decision: text('decision'),
    topic: text('topic'),
    confidence: text('confidence'),
    ticketAction: text('ticket_action'),
    summary: text('summary'),
    intent: text('intent'),
    suggestedReply: text('suggested_reply'),
    factRefs: text('fact_refs')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    factLabels: text('fact_labels')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** D3: the knowledge entries the draft cited, resolved to their titles. */
    knowledgeLabels: text('knowledge_labels')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    provider: text('provider'),
    model: text('model'),
    sentOutboundId: uuid('sent_outbound_id'),
    /** TB6: images the answering model was given, and images in the transcript it did not see. */
    imagesSeen: integer('images_seen').notNull().default(0),
    imagesUnseen: integer('images_unseen').notNull().default(0),
    /**
     * TB6: the customer's latest message is an image nothing could process, so the draft is a
     * HANDOFF produced WITHOUT a model (fail closed). Why the image was not processed.
     */
    unseenImageHandoff: text('unseen_image_handoff'),
    textPurgedAt: timestamptz('text_purged_at'),
    /** TB7 (AUTO_DECISION): the inbound message that triggered it, and its content version. */
    triggerTelegramMessageId: bigint('trigger_telegram_message_id', { mode: 'number' }),
    triggerContentVersion: integer('trigger_content_version'),
    /** TB7: the conversation's epoch when the job was enqueued — the lane row carries it. */
    controlEpoch: integer('control_epoch'),
    /** TB7: not claimed before this instant (the settle delay). Null: due at once (ASSIST). */
    dueAt: timestamptz('due_at'),
    /** TB7: what became of an automatic job (`SUPPORT_AI_AUTO_OUTCOMES`). */
    outcome: text('outcome'),
    handoffReason: text('handoff_reason'),
    /**
     * Why the AI did not produce a usable result (`SUPPORT_AI_FAILURE_CLASSES`): a FAILED draft,
     * or an automatic job handed off as `AI_OUTPUT_INVALID` / `AI_UNAVAILABLE`. The handoff
     * reason stays coarse for the conversation's state; this is the operator's diagnosis, and
     * the deciding call's particulars are its `support_ai_runs` row (`job_id`).
     */
    failureClass: text('failure_class'),
    /**
     * D2 telemetry: how many knowledge entries the request that produced this job's result
     * carried to the provider, and how many the tenant had to choose from. Null when no
     * provider was asked (a guard, a drop, a job from before this column).
     */
    knowledgeSent: integer('knowledge_sent'),
    knowledgeAvailable: integer('knowledge_available'),
    /**
     * Phase 4 PR-3: the tool this automatic job used or asked for (`SUPPORT_AI_ACTION_KINDS`,
     * never `NONE`; `PAYMENT_STATUS` for a check-before-handoff), null for none — what the
     * per-epoch tool-call limit counts.
     */
    toolAction: text('tool_action'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('support_ai_jobs_tenant_id_key').on(table.tenantId, table.id),
    /** TB7: never two pending automatic jobs for one conversation (coalescing's backstop). */
    uniqueIndex('support_ai_jobs_auto_pending_key')
      .on(table.tenantId, table.conversationId)
      .where(sql`kind = 'AUTO_DECISION' AND state = 'QUEUED'`),
    uniqueIndex('support_ai_jobs_idempotency_key').on(table.tenantId, table.idempotencyKey),
    /** The claim: queued jobs, oldest first. */
    index('support_ai_jobs_due_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`state = 'QUEUED'`),
    index('support_ai_jobs_conversation_idx').on(
      table.tenantId,
      table.conversationId,
      table.createdAt,
    ),
    /** TB10 analytics: a tenant's jobs in a window (AUTO outcomes, Assist drafts). */
    index('support_ai_jobs_created_idx').on(table.tenantId, table.createdAt),
    /**
     * Roadmap A3 (review of PR #246, n4): `epochStartedAt` — an epoch's automatic jobs, exactly,
     * rather than every job the conversation ever had.
     */
    index('support_ai_jobs_auto_epoch_idx')
      .on(table.tenantId, table.conversationId, table.controlEpoch)
      .where(sql`kind = 'AUTO_DECISION'`),
    foreignKey({
      columns: [table.tenantId, table.conversationId],
      foreignColumns: [businessConversations.tenantId, businessConversations.id],
      name: 'support_ai_jobs_conversation_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.requestedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'support_ai_jobs_admin_fk',
    }),
    check('support_ai_jobs_kind_check', enumCheck('kind', SUPPORT_AI_JOB_KINDS)),
    check('support_ai_jobs_state_check', enumCheck('state', SUPPORT_AI_JOB_STATES)),
    check('support_ai_jobs_decision_check', enumCheck('decision', SUPPORT_AI_DECISIONS)),
    check('support_ai_jobs_topic_check', enumCheck('topic', SUPPORT_AI_TOPICS)),
    check('support_ai_jobs_confidence_check', enumCheck('confidence', SUPPORT_AI_CONFIDENCES)),
    check(
      'support_ai_jobs_ticket_action_check',
      enumCheck('ticket_action', SUPPORT_AI_TICKET_ACTIONS),
    ),
    check('support_ai_jobs_provider_check', enumCheck('provider', SUPPORT_AI_PROVIDERS)),
    // A ready or sent draft carries a decision; a queued one carries nothing yet.
    check(
      'support_ai_jobs_result_shape_check',
      sql`(state IN ('READY', 'SENT')) <= (decision IS NOT NULL OR text_purged_at IS NOT NULL)`,
    ),
    check('support_ai_jobs_sent_check', sql`(state = 'SENT') = (sent_outbound_id IS NOT NULL)`),
    check(
      'support_ai_jobs_reply_check',
      sql`suggested_reply IS NULL OR length(suggested_reply) <= 4000`,
    ),
    check('support_ai_jobs_summary_check', sql`summary IS NULL OR length(summary) <= 600`),
    check('support_ai_jobs_attempts_check', sql`attempts >= 0`),
    check('support_ai_jobs_images_check', sql`images_seen >= 0 AND images_unseen >= 0`),
    check(
      'support_ai_jobs_unseen_image_handoff_check',
      enumCheck('unseen_image_handoff', SUPPORT_AI_IMAGE_SKIP_REASONS),
    ),
    // The fail-closed draft is a HANDOFF that no model wrote and that saw no image: no provider,
    // no model, no summary, and an empty reply — or none at all once retention purged the text
    // (PR #201 review, N4). `IS NOT DISTINCT FROM`, because a CHECK passes on NULL: `= ''`
    // would let a NULL reply (or a NULL decision) through.
    check(
      'support_ai_jobs_unseen_image_handoff_shape_check',
      sql`unseen_image_handoff IS NULL OR (decision IS NOT DISTINCT FROM 'HANDOFF' AND provider IS NULL AND model IS NULL AND summary IS NULL AND images_seen = 0 AND (suggested_reply IS NOT DISTINCT FROM '' OR (suggested_reply IS NULL AND text_purged_at IS NOT NULL)))`,
    ),
    check('support_ai_jobs_outcome_check', nullableEnumCheck('outcome', SUPPORT_AI_AUTO_OUTCOMES)),
    check(
      'support_ai_jobs_tool_action_check',
      sql`tool_action IS NULL OR (tool_action <> 'NONE' AND ${enumCheck('tool_action', SUPPORT_AI_ACTION_KINDS)})`,
    ),
    check(
      'support_ai_jobs_failure_class_check',
      nullableEnumCheck('failure_class', SUPPORT_AI_FAILURE_CLASSES),
    ),
    check(
      'support_ai_jobs_knowledge_check',
      sql`(knowledge_sent IS NULL) = (knowledge_available IS NULL) AND (knowledge_sent IS NULL OR knowledge_sent BETWEEN 0 AND knowledge_available)`,
    ),
    check(
      'support_ai_jobs_handoff_reason_check',
      nullableEnumCheck('handoff_reason', BUSINESS_HANDOFF_REASONS),
    ),
    // An automatic job names its trigger, its epoch and when it is due, and no person.
    check(
      'support_ai_jobs_auto_shape_check',
      sql`(kind = 'AUTO_DECISION') = (trigger_telegram_message_id IS NOT NULL)
          AND (kind = 'AUTO_DECISION') = (control_epoch IS NOT NULL)
          AND (kind = 'AUTO_DECISION') = (due_at IS NOT NULL)
          AND (kind = 'AUTO_DECISION') = (trigger_content_version IS NOT NULL)
          AND (kind <> 'AUTO_DECISION' OR requested_by_admin_id IS NULL)
          AND (kind = 'AUTO_DECISION' OR outcome IS NULL)`,
    ),
  ],
);

/**
 * Phase 4 PR-4 — the support AI's jobs for TICKETS. Its own table, never `support_ai_jobs`: a
 * ticket job has no Business conversation, no connection and no outbound lane, so it cannot
 * name, claim or send into one (isolation by construction — the Business job table's foreign
 * key is to `business_conversations`, this one's to `tickets`).
 *
 * One QUEUED job per ticket at a time (a second customer message while one waits is covered by
 * it: the producer answers the ticket's latest customer message, `trigger_message_id` is only
 * the first). `epoch` is the ticket hold's epoch when the job was enqueued; a person speaking
 * or a handoff moves the hold, and a job of an older epoch is dropped. The reply, when there is
 * one, is a `ticket_messages` row of sender `AI` named by `reply_message_id`.
 */
export const supportAiTicketJobs = pgTable(
  'support_ai_ticket_jobs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    ticketId: uuid('ticket_id').notNull(),
    /** The customer message that caused the job (`ticket_messages.id`). */
    triggerMessageId: uuid('trigger_message_id').notNull(),
    epoch: integer('epoch').notNull().default(0),
    /** `ticket-ai:<ticket id>:<trigger message id>`: a redelivered update enqueues once. */
    idempotencyKey: text('idempotency_key').notNull(),
    state: text('state').notNull().default('QUEUED'),
    attempts: integer('attempts').notNull().default(0),
    claimedUntil: timestamptz('claimed_until'),
    /** Not claimed before this instant (the settle delay). */
    dueAt: timestamptz('due_at').notNull(),
    /** What became of it (`SUPPORT_AI_AUTO_OUTCOMES`, the Business jobs' closed set). */
    outcome: text('outcome'),
    decision: text('decision'),
    topic: text('topic'),
    confidence: text('confidence'),
    handoffReason: text('handoff_reason'),
    failureClass: text('failure_class'),
    /** The tool this job used or asked for (never `NONE`) — what the tool-call limit counts. */
    toolAction: text('tool_action'),
    provider: text('provider'),
    model: text('model'),
    /** The AI's message in the ticket (`ticket_messages.id`), when one was written. */
    replyMessageId: uuid('reply_message_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('support_ai_ticket_jobs_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('support_ai_ticket_jobs_idempotency_key').on(table.tenantId, table.idempotencyKey),
    /** Coalescing's backstop: never two pending jobs for one ticket. */
    uniqueIndex('support_ai_ticket_jobs_pending_key')
      .on(table.tenantId, table.ticketId)
      .where(sql`state = 'QUEUED'`),
    index('support_ai_ticket_jobs_due_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`state = 'QUEUED'`),
    index('support_ai_ticket_jobs_ticket_idx').on(table.tenantId, table.ticketId, table.createdAt),
    foreignKey({
      columns: [table.tenantId, table.ticketId],
      foreignColumns: [tickets.tenantId, tickets.id],
      name: 'support_ai_ticket_jobs_ticket_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.triggerMessageId],
      foreignColumns: [ticketMessages.tenantId, ticketMessages.id],
      name: 'support_ai_ticket_jobs_trigger_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.replyMessageId],
      foreignColumns: [ticketMessages.tenantId, ticketMessages.id],
      name: 'support_ai_ticket_jobs_reply_fk',
    }),
    check('support_ai_ticket_jobs_state_check', enumCheck('state', SUPPORT_AI_TICKET_JOB_STATES)),
    check(
      'support_ai_ticket_jobs_outcome_check',
      nullableEnumCheck('outcome', SUPPORT_AI_AUTO_OUTCOMES),
    ),
    check('support_ai_ticket_jobs_decision_check', enumCheck('decision', SUPPORT_AI_DECISIONS)),
    check('support_ai_ticket_jobs_topic_check', enumCheck('topic', SUPPORT_AI_TOPICS)),
    check(
      'support_ai_ticket_jobs_confidence_check',
      enumCheck('confidence', SUPPORT_AI_CONFIDENCES),
    ),
    check('support_ai_ticket_jobs_provider_check', enumCheck('provider', SUPPORT_AI_PROVIDERS)),
    check(
      'support_ai_ticket_jobs_handoff_reason_check',
      nullableEnumCheck('handoff_reason', BUSINESS_HANDOFF_REASONS),
    ),
    check(
      'support_ai_ticket_jobs_failure_class_check',
      nullableEnumCheck('failure_class', SUPPORT_AI_FAILURE_CLASSES),
    ),
    check(
      'support_ai_ticket_jobs_tool_action_check',
      sql`tool_action IS NULL OR (tool_action <> 'NONE' AND ${enumCheck('tool_action', SUPPORT_AI_ACTION_KINDS)})`,
    ),
    check('support_ai_ticket_jobs_attempts_check', sql`attempts >= 0 AND epoch >= 0`),
    /** Done iff it has an outcome; a sent reply names its message. */
    check(
      'support_ai_ticket_jobs_done_check',
      sql`(state = 'DONE') = (outcome IS NOT NULL) AND (reply_message_id IS NULL OR state = 'DONE')`,
    ),
    check('support_ai_ticket_jobs_key_check', sql`length(idempotency_key) BETWEEN 1 AND 300`),
  ],
);

/**
 * Phase 4 PR-4 — who holds a ticket's AI answers. No row: the AI answers (epoch 0). A row is
 * written when a person replies in the ticket (`HUMAN_ACTIVE`, SOFT) or the AI hands it off
 * (`HANDOFF_REQUIRED`, HARD or SOFT by `businessHandoffKindOf`), and again when the AI takes the
 * ticket back (`AI_ACTIVE`, epoch + 1: the earlier epoch's jobs no longer count and are
 * dropped). `last_human_at` is the last administrator reply; `held_at` when the hold began.
 * The resume rule is the Business chats' own (`autoResumeTrigger`).
 */
export const supportAiTicketHolds = pgTable(
  'support_ai_ticket_holds',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    ticketId: uuid('ticket_id').notNull(),
    state: text('state').notNull(),
    epoch: integer('epoch').notNull().default(0),
    handoffKind: text('handoff_kind'),
    handoffReason: text('handoff_reason'),
    heldAt: timestamptz('held_at').notNull(),
    lastHumanAt: timestamptz('last_human_at'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.ticketId], name: 'support_ai_ticket_holds_pkey' }),
    foreignKey({
      columns: [table.tenantId, table.ticketId],
      foreignColumns: [tickets.tenantId, tickets.id],
      name: 'support_ai_ticket_holds_ticket_fk',
    }),
    check('support_ai_ticket_holds_state_check', enumCheck('state', SUPPORT_AI_TICKET_HOLD_STATES)),
    check(
      'support_ai_ticket_holds_kind_check',
      nullableEnumCheck('handoff_kind', BUSINESS_HANDOFF_KINDS),
    ),
    check(
      'support_ai_ticket_holds_reason_check',
      nullableEnumCheck('handoff_reason', BUSINESS_HANDOFF_REASONS),
    ),
    check('support_ai_ticket_holds_epoch_check', sql`epoch >= 0`),
    /** A hold that ended has no kind; one that is held always has one. */
    check(
      'support_ai_ticket_holds_shape_check',
      sql`(state = 'AI_ACTIVE') = (handoff_kind IS NULL)`,
    ),
  ],
);

/**
 * TB6 — what happened to each image a draft's request considered (program §28): PROCESSED
 * (given to the model that answered) or SKIPPED, and why. Operational telemetry only: no
 * byte, no file id and no URL of the image is here — the message row is the reference.
 */
export const supportAiImageOutcomes = pgTable(
  'support_ai_image_outcomes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    jobId: uuid('job_id').notNull(),
    messageId: uuid('message_id').notNull(),
    outcome: text('outcome').notNull(),
    reason: text('reason'),
    /** The SNIFFED type, when the bytes were read; never Telegram's declared one. */
    mediaType: text('media_type'),
    byteSize: integer('byte_size'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('support_ai_image_outcomes_job_idx').on(table.tenantId, table.jobId),
    index('support_ai_image_outcomes_created_idx').on(table.tenantId, table.createdAt),
    foreignKey({
      columns: [table.tenantId, table.jobId],
      foreignColumns: [supportAiJobs.tenantId, supportAiJobs.id],
      name: 'support_ai_image_outcomes_job_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.messageId],
      foreignColumns: [businessMessages.tenantId, businessMessages.id],
      name: 'support_ai_image_outcomes_message_fk',
    }),
    check(
      'support_ai_image_outcomes_outcome_check',
      enumCheck('outcome', SUPPORT_AI_IMAGE_OUTCOMES),
    ),
    check(
      'support_ai_image_outcomes_reason_check',
      enumCheck('reason', SUPPORT_AI_IMAGE_SKIP_REASONS),
    ),
    // A processed image has no skip reason; a skipped one always says why.
    check('support_ai_image_outcomes_shape_check', sql`(outcome = 'PROCESSED') = (reason IS NULL)`),
    check(
      'support_ai_image_outcomes_media_type_check',
      sql`media_type IS NULL OR media_type IN ('image/jpeg', 'image/png', 'image/webp')`,
    ),
    check('support_ai_image_outcomes_size_check', sql`byte_size IS NULL OR byte_size >= 0`),
  ],
);
