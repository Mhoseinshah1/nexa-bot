/**
 * Database schema — support knowledge: learning candidates, articles, revisions, the knowledge build (ADR-0035).
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 */
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  SUPPORT_AI_PROVIDERS,
  SUPPORT_AI_CONFIDENCES,
  SUPPORT_KNOWLEDGE_ARTICLE_STATES,
  SUPPORT_KNOWLEDGE_CATEGORIES,
  SUPPORT_KNOWLEDGE_LIMITS,
  SUPPORT_KNOWLEDGE_REVISION_ORIGINS,
  SUPPORT_KNOWLEDGE_SOURCES,
  SUPPORT_LEARNING_CANDIDATE_STATES,
  SUPPORT_LEARNING_JOB_OUTCOMES,
  SUPPORT_LEARNING_JOB_STATES,
  SUPPORT_LEARNING_JOB_TRIGGERS,
  SUPPORT_LEARNING_REJECT_REASONS,
  SUPPORT_LEARNING_SENSITIVE_KINDS,
  SUPPORT_KNOWLEDGE_BUILD_SOURCE_TYPES,
  SUPPORT_KNOWLEDGE_BUILD_STATES,
  SUPPORT_KNOWLEDGE_CONFLICT_CHOICES,
  SUPPORT_KNOWLEDGE_PROPOSAL_KINDS,
  SUPPORT_KNOWLEDGE_PROPOSAL_STATES,
} from '@nexa/contracts';
import { enumArrayCheck, enumCheck, nullableEnumCheck, timestamptz } from './_shared.js';
import { tenants } from './tenancy.js';
import { admins } from './identity.js';
import {
  businessConversations,
  businessMessages,
  businessOutboundMessages,
} from './business-chats.js';

// ---------------------------------------------------------------------------
// TB8 — support knowledge and controlled learning (ADR-0035)
// ---------------------------------------------------------------------------

const KNOWLEDGE_TITLE_MAX = sql.raw(String(SUPPORT_KNOWLEDGE_LIMITS.titleChars));
const KNOWLEDGE_BODY_MAX = sql.raw(String(SUPPORT_KNOWLEDGE_LIMITS.bodyChars));
const KNOWLEDGE_TAGS_MAX = sql.raw(String(SUPPORT_KNOWLEDGE_LIMITS.tags));

/**
 * TB8 — a learning candidate: a lesson the `assistant` role proposed from a human support
 * reply, waiting for a reviewer (ADR-0035 §2–§3). `PENDING → APPROVED | REJECTED`, each a
 * conditional UPDATE naming `PENDING` and the version.
 *
 * `normalized_title` is unique per tenant across every state but a scrubber rejection: a
 * proposal matching a pending, approved or reviewer-rejected candidate is merged into it as an
 * extra source (`source_refs`), so a rejected lesson is not proposed again. A
 * `SENSITIVE_CONTENT` rejection is outside the index, so it never absorbs a later clean
 * proposal. The text of a candidate never approved (title, body, rationale and tags) is purged
 * after `SUPPORT_LEARNING_TEXT_RETENTION_DAYS`; only its normalised title survives.
 *
 * A candidate the scrubber still matched is stored REJECTED with `SENSITIVE_CONTENT`, by
 * nobody, with its text REDACTED and only the KINDS of what matched.
 */
export const supportLearningCandidates = pgTable(
  'support_learning_candidates',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    state: text('state').notNull().default('PENDING'),
    /** Null once purged (with the body, rationale and tags). */
    title: text('title'),
    normalizedTitle: text('normalized_title').notNull(),
    body: text('body'),
    category: text('category').notNull(),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    rationale: text('rationale'),
    confidence: text('confidence').notNull(),
    rejectReason: text('reject_reason'),
    sensitiveKinds: text('sensitive_kinds')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    conversationId: uuid('conversation_id').notNull(),
    /** The first source: a delivered reply (`outbound`) or, D8, a message the owner typed. */
    sourceOutboundId: uuid('source_outbound_id'),
    sourceMessageId: uuid('source_message_id'),
    /**
     * Every source reply that proposed this lesson: `[{conversationId, outboundId, at}]`, or
     * `messageId` instead of `outboundId` for a message the owner typed (D8).
     */
    sourceRefs: jsonb('source_refs')
      .notNull()
      .default(sql`'[]'::jsonb`),
    sourceCount: integer('source_count').notNull().default(1),
    jobId: uuid('job_id').notNull(),
    provider: text('provider'),
    model: text('model'),
    articleId: uuid('article_id'),
    /**
     * Phase 4 PR-2 «جایگزین پاسخ تأییدشده»: the approved LEARNED article this lesson re-proposes
     * (the same normalised title was approved before). Approval writes a new revision of it.
     */
    replacesArticleId: uuid('replaces_article_id'),
    /** Phase 4 PR-2: the source reply was an AI draft a person sent (Assist). */
    assisted: boolean('assisted').notNull().default(false),
    reviewedByAdminId: uuid('reviewed_by_admin_id'),
    reviewedAt: timestamptz('reviewed_at'),
    textPurgedAt: timestamptz('text_purged_at'),
    version: integer('version').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('support_learning_candidates_tenant_id_key').on(table.tenantId, table.id),
    /*
     * Phase 4 PR-2: the exact-duplicate rule holds among PENDING candidates only. A lesson that
     * was rejected, or approved, is a decision about THAT text: the same lesson proposed again
     * is a new candidate for a reviewer (for an approved one, a replacement of its article),
     * never silently merged into a decision already taken.
     */
    uniqueIndex('support_learning_candidates_title_key')
      .on(table.tenantId, table.normalizedTitle)
      .where(sql`state = 'PENDING'`),
    /** The review queue: by state, newest first. */
    index('support_learning_candidates_queue_idx').on(table.tenantId, table.state, table.createdAt),
    /*
     * TB10 (PR #205 review, N4): the analytics count candidates CREATED in a window, by state.
     * The queue index leads with `state`, so that count walked the tenant's whole queue index
     * with `created_at` checked entry by entry; this bounds it to the window, and carries
     * `state` so the count stays an index-only scan (without it, the planner kept the queue
     * index rather than visit the heap for each row's state).
     */
    index('support_learning_candidates_created_idx').on(
      table.tenantId,
      table.createdAt,
      table.state,
    ),
    foreignKey({
      columns: [table.tenantId, table.conversationId],
      foreignColumns: [businessConversations.tenantId, businessConversations.id],
      name: 'support_learning_candidates_conversation_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.reviewedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'support_learning_candidates_reviewer_fk',
    }),
    check(
      'support_learning_candidates_state_check',
      enumCheck('state', SUPPORT_LEARNING_CANDIDATE_STATES),
    ),
    check(
      'support_learning_candidates_source_check',
      sql`num_nonnulls(source_outbound_id, source_message_id) = 1`,
    ),
    check(
      'support_learning_candidates_category_check',
      enumCheck('category', SUPPORT_KNOWLEDGE_CATEGORIES),
    ),
    check(
      'support_learning_candidates_confidence_check',
      enumCheck('confidence', SUPPORT_AI_CONFIDENCES),
    ),
    check(
      'support_learning_candidates_reject_reason_check',
      nullableEnumCheck('reject_reason', SUPPORT_LEARNING_REJECT_REASONS),
    ),
    check(
      'support_learning_candidates_sensitive_kinds_check',
      enumArrayCheck('sensitive_kinds', SUPPORT_LEARNING_SENSITIVE_KINDS),
    ),
    check(
      'support_learning_candidates_provider_check',
      nullableEnumCheck('provider', SUPPORT_AI_PROVIDERS),
    ),
    // Rejected exactly when a reason says why; approved exactly when an article was published.
    check(
      'support_learning_candidates_reject_shape_check',
      sql`(state = 'REJECTED') = (reject_reason IS NOT NULL)`,
    ),
    check(
      'support_learning_candidates_approve_shape_check',
      sql`(state = 'APPROVED') = (article_id IS NOT NULL)`,
    ),
    check(
      'support_learning_candidates_reviewed_check',
      sql`(state = 'PENDING') = (reviewed_at IS NULL)`,
    ),
    // The scrubber's rejection names what it found, and is nobody's decision.
    check(
      'support_learning_candidates_sensitive_shape_check',
      sql`(reject_reason IS NOT DISTINCT FROM 'SENSITIVE_CONTENT') = (cardinality(sensitive_kinds) > 0)
          AND (reject_reason IS DISTINCT FROM 'SENSITIVE_CONTENT' OR reviewed_by_admin_id IS NULL)`,
    ),
    check(
      'support_learning_candidates_title_check',
      sql`(title IS NULL OR length(btrim(title)) BETWEEN 1 AND ${KNOWLEDGE_TITLE_MAX}) AND length(normalized_title) >= 1`,
    ),
    check(
      'support_learning_candidates_body_check',
      sql`body IS NULL OR length(body) <= ${KNOWLEDGE_BODY_MAX}`,
    ),
    // Only purged text may be missing.
    check(
      'support_learning_candidates_purge_check',
      sql`(body IS NOT NULL AND title IS NOT NULL) OR text_purged_at IS NOT NULL`,
    ),
    check(
      'support_learning_candidates_tags_check',
      sql`cardinality(tags) <= ${KNOWLEDGE_TAGS_MAX}`,
    ),
    check('support_learning_candidates_counts_check', sql`source_count >= 1 AND version >= 1`),
  ],
);

/**
 * TB8 — one support knowledge article: its CURRENT state (ADR-0035 §1).
 *
 * The support agent reads `state = 'APPROVED' AND enabled`, in SQL. `revision` is the number of
 * the revision the article currently shows (0 for a draft never published); every body ever
 * approved is in `support_knowledge_revisions`. `version` is the optimistic-concurrency stamp
 * every write names. A LEARNED article names the candidate whose approval created it.
 */
export const supportKnowledgeArticles = pgTable(
  'support_knowledge_articles',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    source: text('source').notNull(),
    state: text('state').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    title: text('title').notNull(),
    body: text('body').notNull(),
    category: text('category').notNull(),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    revision: integer('revision').notNull().default(0),
    version: integer('version').notNull().default(1),
    candidateId: uuid('candidate_id'),
    createdByAdminId: uuid('created_by_admin_id'),
    /**
     * TB9 (`NEXA_BUILD` only): the source item this article was built from, the revision the
     * last build apply wrote, and the content hash it applied (or a reviewer acknowledged).
     * `revision <> built_revision` means a reviewer edited it since: a changed source against
     * it is a CONFLICT, never an overwrite.
     */
    sourceType: text('source_type'),
    sourceKey: text('source_key'),
    builtRevision: integer('built_revision'),
    builtHash: text('built_hash'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('support_knowledge_articles_tenant_id_key').on(table.tenantId, table.id),
    /** TB9: one article per source item. */
    uniqueIndex('support_knowledge_articles_source_key')
      .on(table.tenantId, table.sourceType, table.sourceKey)
      .where(sql`source_key IS NOT NULL`),
    check(
      'support_knowledge_articles_source_type_check',
      nullableEnumCheck('source_type', SUPPORT_KNOWLEDGE_BUILD_SOURCE_TYPES),
    ),
    // A built article names its source, its built revision and hash; nothing else does.
    check(
      'support_knowledge_articles_built_check',
      sql`(source = 'NEXA_BUILD') = (source_type IS NOT NULL)
          AND (source_type IS NULL) = (source_key IS NULL)
          AND (source_type IS NULL) = (built_revision IS NULL)
          AND (source_type IS NULL) = (built_hash IS NULL)`,
    ),
    /** The context read: approved and enabled, newest first. */
    index('support_knowledge_articles_active_idx').on(
      table.tenantId,
      table.state,
      table.enabled,
      table.updatedAt,
    ),
    /** One article per approved candidate: a replayed approval cannot publish twice. */
    uniqueIndex('support_knowledge_articles_candidate_key')
      .on(table.tenantId, table.candidateId)
      .where(sql`candidate_id IS NOT NULL`),
    foreignKey({
      columns: [table.tenantId, table.candidateId],
      foreignColumns: [supportLearningCandidates.tenantId, supportLearningCandidates.id],
      name: 'support_knowledge_articles_candidate_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.createdByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'support_knowledge_articles_admin_fk',
    }),
    check(
      'support_knowledge_articles_source_check',
      enumCheck('source', SUPPORT_KNOWLEDGE_SOURCES),
    ),
    check(
      'support_knowledge_articles_state_check',
      enumCheck('state', SUPPORT_KNOWLEDGE_ARTICLE_STATES),
    ),
    check(
      'support_knowledge_articles_category_check',
      enumCheck('category', SUPPORT_KNOWLEDGE_CATEGORIES),
    ),
    check(
      'support_knowledge_articles_title_check',
      sql`length(btrim(title)) BETWEEN 1 AND ${KNOWLEDGE_TITLE_MAX}`,
    ),
    check(
      'support_knowledge_articles_body_check',
      sql`length(btrim(body)) BETWEEN 1 AND ${KNOWLEDGE_BODY_MAX}`,
    ),
    check('support_knowledge_articles_tags_check', sql`cardinality(tags) <= ${KNOWLEDGE_TAGS_MAX}`),
    check('support_knowledge_articles_version_check', sql`version >= 1 AND revision >= 0`),
    // Nothing is approved without a published revision to show for it.
    check('support_knowledge_articles_approved_check', sql`state <> 'APPROVED' OR revision >= 1`),
    // A learned article always names its candidate, and only a learned one does.
    check(
      'support_knowledge_articles_learned_check',
      sql`(source = 'LEARNED') = (candidate_id IS NOT NULL)`,
    ),
  ],
);

/**
 * TB8 — every body ever published, append-only (a trigger in `0207` refuses UPDATE and
 * DELETE). An edit of approved knowledge is a NEW revision; the old one stays, with who
 * approved it.
 */
export const supportKnowledgeRevisions = pgTable(
  'support_knowledge_revisions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    articleId: uuid('article_id').notNull(),
    revision: integer('revision').notNull(),
    origin: text('origin').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    category: text('category').notNull(),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    reviewerAdminId: uuid('reviewer_admin_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('support_knowledge_revisions_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('support_knowledge_revisions_article_key').on(
      table.tenantId,
      table.articleId,
      table.revision,
    ),
    foreignKey({
      columns: [table.tenantId, table.articleId],
      foreignColumns: [supportKnowledgeArticles.tenantId, supportKnowledgeArticles.id],
      name: 'support_knowledge_revisions_article_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.reviewerAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'support_knowledge_revisions_reviewer_fk',
    }),
    check(
      'support_knowledge_revisions_origin_check',
      enumCheck('origin', SUPPORT_KNOWLEDGE_REVISION_ORIGINS),
    ),
    check(
      'support_knowledge_revisions_category_check',
      enumCheck('category', SUPPORT_KNOWLEDGE_CATEGORIES),
    ),
    check('support_knowledge_revisions_revision_check', sql`revision >= 1`),
    check(
      'support_knowledge_revisions_title_check',
      sql`length(btrim(title)) BETWEEN 1 AND ${KNOWLEDGE_TITLE_MAX}`,
    ),
    check(
      'support_knowledge_revisions_body_check',
      sql`length(btrim(body)) BETWEEN 1 AND ${KNOWLEDGE_BODY_MAX}`,
    ),
    check(
      'support_knowledge_revisions_tags_check',
      sql`cardinality(tags) <= ${KNOWLEDGE_TAGS_MAX}`,
    ),
  ],
);

/**
 * TB8 — one learning job: "read this human reply and propose a lesson, or decline". Claimed by
 * the `assistant` role with a lease, produced OUTSIDE any transaction, and resolved by a
 * conditional UPDATE from `QUEUED`. Bounded: one per conversation per 24 hours, and a
 * per-tenant hourly cap, both counted in the enqueuing transaction.
 */
export const supportLearningJobs = pgTable(
  'support_learning_jobs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    conversationId: uuid('conversation_id').notNull(),
    /** The reply learned from: a delivered outbound row, or (D8) a message the owner typed. */
    sourceOutboundId: uuid('source_outbound_id'),
    sourceMessageId: uuid('source_message_id'),
    trigger: text('trigger').notNull(),
    requestedByAdminId: uuid('requested_by_admin_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    state: text('state').notNull().default('QUEUED'),
    outcome: text('outcome'),
    attempts: integer('attempts').notNull().default(0),
    claimedUntil: timestamptz('claimed_until'),
    candidateId: uuid('candidate_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('support_learning_jobs_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('support_learning_jobs_idempotency_key').on(table.tenantId, table.idempotencyKey),
    index('support_learning_jobs_due_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`state = 'QUEUED'`),
    /** The per-conversation window. */
    index('support_learning_jobs_conversation_idx').on(
      table.tenantId,
      table.conversationId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.tenantId, table.conversationId],
      foreignColumns: [businessConversations.tenantId, businessConversations.id],
      name: 'support_learning_jobs_conversation_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.sourceOutboundId],
      foreignColumns: [businessOutboundMessages.tenantId, businessOutboundMessages.id],
      name: 'support_learning_jobs_outbound_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.sourceMessageId],
      foreignColumns: [businessMessages.tenantId, businessMessages.id],
      name: 'support_learning_jobs_message_fk',
    }),
    // D8: exactly one source — a delivered reply, or a message the owner typed.
    check(
      'support_learning_jobs_source_check',
      sql`num_nonnulls(source_outbound_id, source_message_id) = 1`,
    ),
    foreignKey({
      columns: [table.tenantId, table.requestedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'support_learning_jobs_admin_fk',
    }),
    check(
      'support_learning_jobs_trigger_check',
      enumCheck('trigger', SUPPORT_LEARNING_JOB_TRIGGERS),
    ),
    check('support_learning_jobs_state_check', enumCheck('state', SUPPORT_LEARNING_JOB_STATES)),
    check(
      'support_learning_jobs_outcome_check',
      nullableEnumCheck('outcome', SUPPORT_LEARNING_JOB_OUTCOMES),
    ),
    // Resolved exactly when it says what became of it.
    check('support_learning_jobs_outcome_shape_check', sql`(state = 'QUEUED') = (outcome IS NULL)`),
    // An operator's proposal names the operator; a handback is nobody's request.
    check(
      'support_learning_jobs_requester_check',
      sql`(trigger = 'OPERATOR_PROPOSAL') = (requested_by_admin_id IS NOT NULL)`,
    ),
    check('support_learning_jobs_attempts_check', sql`attempts >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// TB9 — the one-click knowledge build (ADR-0035 §5)
// ---------------------------------------------------------------------------

/**
 * TB9 — one run of «ساخت/به‌روزرسانی دانش پشتیبان از اطلاعات NEXA»: a change-set of proposals,
 * never an applied change. At most one OPEN build per tenant (a partial unique index); a new run
 * supersedes the open one in its own transaction, and a superseded build applies nothing.
 */
export const supportKnowledgeBuilds = pgTable(
  'support_knowledge_builds',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    state: text('state').notNull().default('OPEN'),
    createdByAdminId: uuid('created_by_admin_id'),
    addCount: integer('add_count').notNull().default(0),
    updateCount: integer('update_count').notNull().default(0),
    unchangedCount: integer('unchanged_count').notNull().default(0),
    conflictCount: integer('conflict_count').notNull().default(0),
    retireCount: integer('retire_count').notNull().default(0),
    /** Items clipped to the article bounds, and items dropped by a bound (at least). */
    clippedCount: integer('clipped_count').notNull().default(0),
    cappedCount: integer('capped_count').notNull().default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('support_knowledge_builds_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('support_knowledge_builds_open_key')
      .on(table.tenantId)
      .where(sql`state = 'OPEN'`),
    index('support_knowledge_builds_recent_idx').on(table.tenantId, table.createdAt),
    foreignKey({
      columns: [table.tenantId, table.createdByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'support_knowledge_builds_admin_fk',
    }),
    check(
      'support_knowledge_builds_state_check',
      enumCheck('state', SUPPORT_KNOWLEDGE_BUILD_STATES),
    ),
    check(
      'support_knowledge_builds_counts_check',
      sql`add_count >= 0 AND update_count >= 0 AND unchanged_count >= 0 AND conflict_count >= 0
          AND retire_count >= 0 AND clipped_count >= 0 AND capped_count >= 0`,
    ),
  ],
);

/**
 * TB9 — one proposal of a build: what one allowlisted source item would do to the knowledge
 * base. It records the content (customer-facing fields only), its hash, the article it would
 * replace and that article's revision and text at build time (the diff's other side, and the
 * base an apply is conditional on).
 */
export const supportKnowledgeBuildProposals = pgTable(
  'support_knowledge_build_proposals',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    buildId: uuid('build_id').notNull(),
    sourceType: text('source_type').notNull(),
    sourceKey: text('source_key').notNull(),
    kind: text('kind').notNull(),
    state: text('state').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    category: text('category').notNull(),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    contentHash: text('content_hash').notNull(),
    articleId: uuid('article_id'),
    baseRevision: integer('base_revision'),
    baseTitle: text('base_title'),
    baseBody: text('base_body'),
    resolution: text('resolution'),
    decidedByAdminId: uuid('decided_by_admin_id'),
    decidedAt: timestamptz('decided_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('support_knowledge_build_proposals_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('support_knowledge_build_proposals_source_key').on(
      table.tenantId,
      table.buildId,
      table.sourceType,
      table.sourceKey,
    ),
    foreignKey({
      columns: [table.tenantId, table.buildId],
      foreignColumns: [supportKnowledgeBuilds.tenantId, supportKnowledgeBuilds.id],
      name: 'support_knowledge_build_proposals_build_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.articleId],
      foreignColumns: [supportKnowledgeArticles.tenantId, supportKnowledgeArticles.id],
      name: 'support_knowledge_build_proposals_article_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.decidedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'support_knowledge_build_proposals_admin_fk',
    }),
    check(
      'support_knowledge_build_proposals_source_type_check',
      enumCheck('source_type', SUPPORT_KNOWLEDGE_BUILD_SOURCE_TYPES),
    ),
    check(
      'support_knowledge_build_proposals_kind_check',
      enumCheck('kind', SUPPORT_KNOWLEDGE_PROPOSAL_KINDS),
    ),
    check(
      'support_knowledge_build_proposals_state_check',
      enumCheck('state', SUPPORT_KNOWLEDGE_PROPOSAL_STATES),
    ),
    check(
      'support_knowledge_build_proposals_category_check',
      enumCheck('category', SUPPORT_KNOWLEDGE_CATEGORIES),
    ),
    check(
      'support_knowledge_build_proposals_resolution_check',
      nullableEnumCheck('resolution', SUPPORT_KNOWLEDGE_CONFLICT_CHOICES),
    ),
    // An ADD names no article; every other kind names the one it is about, and its base.
    check(
      'support_knowledge_build_proposals_article_check',
      sql`(kind = 'ADD') = (article_id IS NULL) AND (article_id IS NULL) = (base_revision IS NULL)`,
    ),
    // Nothing to do is decided at birth; only a conflict is resolved by a choice.
    check(
      'support_knowledge_build_proposals_unchanged_check',
      sql`kind <> 'UNCHANGED' OR state = 'SKIPPED'`,
    ),
    check(
      'support_knowledge_build_proposals_resolution_shape_check',
      sql`resolution IS NULL OR kind = 'CONFLICT'`,
    ),
    check(
      'support_knowledge_build_proposals_text_check',
      sql`length(btrim(title)) BETWEEN 1 AND ${KNOWLEDGE_TITLE_MAX} AND length(btrim(body)) BETWEEN 1 AND ${KNOWLEDGE_BODY_MAX}`,
    ),
  ],
);
