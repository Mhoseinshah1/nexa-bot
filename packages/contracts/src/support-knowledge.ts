import { z } from 'zod';
import { SUPPORT_AI_CONFIDENCES, SUPPORT_AI_PROVIDERS } from './support-ai.js';

/**
 * TB8 — support knowledge and controlled learning (ADR-0035, program §29, §38).
 *
 * One tenant-scoped knowledge base. Only an APPROVED and enabled article grounds the support
 * agent (TB3's context reads `state = 'APPROVED' AND enabled` in SQL). Learning produces
 * CANDIDATES, never knowledge: a reviewer holding `support_knowledge.review` approves (as is,
 * or edited) or rejects each one, and only an approval publishes an article revision. Nothing
 * becomes active on a timer, by count or by confidence.
 */

/** An article's current state. `DRAFT` and `RETIRED` never reach the agent. */
export const SUPPORT_KNOWLEDGE_ARTICLE_STATES = ['DRAFT', 'APPROVED', 'RETIRED'] as const;
export type SupportKnowledgeArticleState = (typeof SUPPORT_KNOWLEDGE_ARTICLE_STATES)[number];

/**
 * Where an article came from. `MANUAL` — a reviewer wrote it; `LEARNED` — an approved learning
 * candidate; `NEXA_BUILD` — an applied proposal of the knowledge build (TB9).
 */
export const SUPPORT_KNOWLEDGE_SOURCES = ['MANUAL', 'LEARNED', 'NEXA_BUILD'] as const;
export type SupportKnowledgeSource = (typeof SUPPORT_KNOWLEDGE_SOURCES)[number];

/** A closed category set: retrieval and the reviewer's filter both read it. */
export const SUPPORT_KNOWLEDGE_CATEGORIES = [
  'CONNECTION',
  'APPS',
  'PLANS',
  'PAYMENTS',
  'ACCOUNT',
  'POLICY',
  'GENERAL',
] as const;
export type SupportKnowledgeCategory = (typeof SUPPORT_KNOWLEDGE_CATEGORIES)[number];

/** What produced one revision: a reviewer's edit, a candidate's approval, or a build apply. */
export const SUPPORT_KNOWLEDGE_REVISION_ORIGINS = ['MANUAL', 'CANDIDATE', 'BUILD'] as const;
export type SupportKnowledgeRevisionOrigin = (typeof SUPPORT_KNOWLEDGE_REVISION_ORIGINS)[number];

/** Bounds every field is held to, in the schema and in the tables' CHECKs. */
export const SUPPORT_KNOWLEDGE_LIMITS = {
  titleChars: 200,
  bodyChars: 4000,
  tags: 8,
  tagChars: 32,
  rationaleChars: 600,
  rejectNoteChars: 300,
  /** Articles per tenant, every state counted: a bound, not a lock. */
  articles: 1000,
} as const;

// --- learning ------------------------------------------------------------------

/** `PENDING → APPROVED | REJECTED`. Reject is terminal and never enters knowledge. */
export const SUPPORT_LEARNING_CANDIDATE_STATES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type SupportLearningCandidateState = (typeof SUPPORT_LEARNING_CANDIDATE_STATES)[number];

/**
 * Why a candidate was rejected: a reviewer said so, or the deterministic scrubber still found
 * sensitive content in what the model proposed (rejected automatically, by nobody).
 */
export const SUPPORT_LEARNING_REJECT_REASONS = ['REVIEWER', 'SENSITIVE_CONTENT'] as const;
export type SupportLearningRejectReason = (typeof SUPPORT_LEARNING_REJECT_REASONS)[number];

/**
 * What the scrubber recognises — only the KIND is ever stored or shown, never the match.
 * `REDACTION_MARK` is the scrubber's own placeholder appearing in a model's output: a lesson
 * written about the redacted value is about one customer. `HOST` is a server address by name
 * (a domain, with or without a port or a path, or a URL with no token in it): program §29
 * lists server addresses beside phones and cards.
 */
export const SUPPORT_LEARNING_SENSITIVE_KINDS = [
  'EMAIL',
  'PHONE',
  'CARD',
  'IBAN',
  'SUBSCRIPTION_LINK',
  'URL_TOKEN',
  'IP_ADDRESS',
  'HOST',
  'UUID',
  'SECRET',
  'USERNAME',
  'AMOUNT',
  'LONG_NUMBER',
  'REDACTION_MARK',
] as const;
export type SupportLearningSensitiveKind = (typeof SUPPORT_LEARNING_SENSITIVE_KINDS)[number];

/**
 * Why a learning job exists: an operator handed a conversation back to the AI after replying
 * in it, or an operator explicitly proposed one of their replies as knowledge.
 */
export const SUPPORT_LEARNING_JOB_TRIGGERS = ['HANDBACK', 'OPERATOR_PROPOSAL'] as const;
export type SupportLearningJobTrigger = (typeof SUPPORT_LEARNING_JOB_TRIGGERS)[number];

export const SUPPORT_LEARNING_JOB_STATES = ['QUEUED', 'DONE', 'FAILED'] as const;
export type SupportLearningJobState = (typeof SUPPORT_LEARNING_JOB_STATES)[number];

/**
 * What became of one learning job (telemetry; a closed set pinned by a CHECK).
 *
 * - `candidate_created` — a new PENDING candidate.
 * - `merged` — the proposal's normalised title matched an existing candidate (pending,
 *   approved or rejected), which gained this as an extra source.
 * - `auto_rejected` — the scrubber still matched the model's output: stored REJECTED, redacted.
 * - `declined` — the model said there is no general lesson here.
 * - `dropped_mode` — the support AI was OFF when the job ran.
 * - `dropped_source` — the reply is gone (purged, or not a delivered human reply).
 * - `dropped_scope` — the tenant stopped accepting work before the result was recorded.
 * - `output_invalid` — the output failed the strict schema.
 * - `ai_unavailable` — the provider chain produced no answer.
 * - `attempts_exhausted` — claimed too many times without a result.
 */
export const SUPPORT_LEARNING_JOB_OUTCOMES = [
  'candidate_created',
  'merged',
  'auto_rejected',
  'declined',
  'dropped_mode',
  'dropped_source',
  'dropped_scope',
  'output_invalid',
  'ai_unavailable',
  'attempts_exhausted',
] as const;
export type SupportLearningJobOutcome = (typeof SUPPORT_LEARNING_JOB_OUTCOMES)[number];

/** ADR-0035 §3: at most one learning job (so one candidate) per conversation per this window. */
export const SUPPORT_LEARNING_CONVERSATION_WINDOW_HOURS = 24;
/** And at most this many learning jobs per tenant per hour, whatever triggered them. */
export const SUPPORT_LEARNING_MAX_JOBS_PER_HOUR = 30;
/** A candidate keeps at most this many source references (the first, then merges). */
export const SUPPORT_LEARNING_MAX_SOURCES = 20;
/** A candidate never approved has its text purged after this, like the transcript. */
export const SUPPORT_LEARNING_TEXT_RETENTION_DAYS = 30;

const tagSchema = z.string().trim().min(1).max(SUPPORT_KNOWLEDGE_LIMITS.tagChars);
const tagsSchema = z.array(tagSchema).max(SUPPORT_KNOWLEDGE_LIMITS.tags);

/**
 * THE structured output of a `LEARNING_EXTRACT` call, validated by zod before anything reads
 * it. `NONE` is the model declining: a one-off decision, personal data, a guess, nothing
 * general. The source reference is NEVER the model's: the server records which reply it read.
 */
export const supportLearningExtractionSchema = z
  .object({
    proposal: z.enum(['CANDIDATE', 'NONE']),
    title: z.string().max(SUPPORT_KNOWLEDGE_LIMITS.titleChars),
    body: z.string().max(SUPPORT_KNOWLEDGE_LIMITS.bodyChars),
    category: z.enum(SUPPORT_KNOWLEDGE_CATEGORIES),
    tags: tagsSchema,
    rationale: z.string().max(SUPPORT_KNOWLEDGE_LIMITS.rationaleChars),
    confidence: z.enum(SUPPORT_AI_CONFIDENCES),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.proposal !== 'CANDIDATE') return;
    if (value.title.trim().length === 0)
      ctx.addIssue({ code: 'custom', path: ['title'], message: 'A candidate needs a title.' });
    if (value.body.trim().length === 0)
      ctx.addIssue({ code: 'custom', path: ['body'], message: 'A candidate needs a body.' });
  });
export type SupportLearningExtraction = z.infer<typeof supportLearningExtractionSchema>;

/** The same output as a JSON Schema in the intersection every provider accepts (OQ-TB-21). */
export const SUPPORT_LEARNING_EXTRACTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['proposal', 'title', 'body', 'category', 'tags', 'rationale', 'confidence'],
  properties: {
    proposal: { type: 'string', enum: ['CANDIDATE', 'NONE'] },
    title: { type: 'string' },
    body: { type: 'string' },
    category: { type: 'string', enum: [...SUPPORT_KNOWLEDGE_CATEGORIES] },
    tags: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
    confidence: { type: 'string', enum: [...SUPPORT_AI_CONFIDENCES] },
  },
};

// --- HTTP ----------------------------------------------------------------------

const idempotencyKeySchema = z.string().min(8).max(128);
const versionSchema = z.number().int().min(1);

/** An article's editable content. Operator-reviewed free text (the AI/operator exception). */
export const supportKnowledgeContentSchema = z
  .object({
    title: z.string().trim().min(1).max(SUPPORT_KNOWLEDGE_LIMITS.titleChars),
    body: z.string().trim().min(1).max(SUPPORT_KNOWLEDGE_LIMITS.bodyChars),
    category: z.enum(SUPPORT_KNOWLEDGE_CATEGORIES),
    tags: tagsSchema,
  })
  .strict();
export type SupportKnowledgeContent = z.infer<typeof supportKnowledgeContentSchema>;

export const supportKnowledgeCreateRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    content: supportKnowledgeContentSchema,
    /** True: published at once as revision 1. False: saved as a DRAFT nobody reads. */
    publish: z.boolean(),
  })
  .strict();

export const supportKnowledgeUpdateRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    expectedVersion: versionSchema,
    content: supportKnowledgeContentSchema,
  })
  .strict();

export const supportKnowledgeControlRequestSchema = z
  .object({ idempotencyKey: idempotencyKeySchema, expectedVersion: versionSchema })
  .strict();

export const supportKnowledgeEnabledRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    expectedVersion: versionSchema,
    enabled: z.boolean(),
  })
  .strict();

export const supportLearningApproveRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    expectedVersion: versionSchema,
    /** Null: approve as proposed. Otherwise «edit then approve» publishes THIS content. */
    edit: supportKnowledgeContentSchema.nullable(),
  })
  .strict();

export const supportLearningRejectRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    expectedVersion: versionSchema,
    note: z.string().trim().max(SUPPORT_KNOWLEDGE_LIMITS.rejectNoteChars).optional(),
  })
  .strict();

/** «پیشنهاد به‌عنوان دانش» on one of the operator's delivered replies. */
export const supportLearningProposeRequestSchema = z
  .object({ idempotencyKey: idempotencyKeySchema, outboundId: z.uuid() })
  .strict();

export const supportKnowledgeArticleViewSchema = z.object({
  id: z.string(),
  source: z.enum(SUPPORT_KNOWLEDGE_SOURCES),
  state: z.enum(SUPPORT_KNOWLEDGE_ARTICLE_STATES),
  enabled: z.boolean(),
  title: z.string(),
  body: z.string(),
  category: z.enum(SUPPORT_KNOWLEDGE_CATEGORIES),
  tags: z.array(z.string()),
  /** The current published revision; 0 for a draft never published. */
  revision: z.number().int().min(0),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SupportKnowledgeArticleView = z.infer<typeof supportKnowledgeArticleViewSchema>;

export const supportKnowledgeRevisionViewSchema = z.object({
  revision: z.number().int().min(1),
  origin: z.enum(SUPPORT_KNOWLEDGE_REVISION_ORIGINS),
  title: z.string(),
  body: z.string(),
  category: z.enum(SUPPORT_KNOWLEDGE_CATEGORIES),
  tags: z.array(z.string()),
  reviewerAdminId: z.string().nullable(),
  createdAt: z.string(),
});
export type SupportKnowledgeRevisionView = z.infer<typeof supportKnowledgeRevisionViewSchema>;

export const supportLearningCandidateViewSchema = z.object({
  id: z.string(),
  state: z.enum(SUPPORT_LEARNING_CANDIDATE_STATES),
  /**
   * Null once purged, like the body: a candidate never approved keeps no text after the
   * retention. The duplicate check matches the normalised title, which is not shown.
   */
  title: z.string().nullable(),
  /** Null once purged (a candidate never approved, after the retention). */
  body: z.string().nullable(),
  category: z.enum(SUPPORT_KNOWLEDGE_CATEGORIES),
  tags: z.array(z.string()),
  rationale: z.string().nullable(),
  confidence: z.enum(SUPPORT_AI_CONFIDENCES),
  rejectReason: z.enum(SUPPORT_LEARNING_REJECT_REASONS).nullable(),
  sensitiveKinds: z.array(z.enum(SUPPORT_LEARNING_SENSITIVE_KINDS)),
  /** The conversation the first source reply belongs to (a link for the reviewer). */
  conversationId: z.string(),
  /** How many replies proposed this lesson (1 + merges). */
  sourceCount: z.number().int().min(1),
  provider: z.enum(SUPPORT_AI_PROVIDERS).nullable(),
  model: z.string().nullable(),
  articleId: z.string().nullable(),
  version: z.number().int().min(1),
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
});
export type SupportLearningCandidateView = z.infer<typeof supportLearningCandidateViewSchema>;

export const SUPPORT_KNOWLEDGE_ROUTES = {
  articles: '/support-knowledge/articles',
  article: (id: string) => `/support-knowledge/articles/${encodeURIComponent(id)}`,
  revisions: (id: string) => `/support-knowledge/articles/${encodeURIComponent(id)}/revisions`,
  publish: (id: string) => `/support-knowledge/articles/${encodeURIComponent(id)}/publish`,
  retire: (id: string) => `/support-knowledge/articles/${encodeURIComponent(id)}/retire`,
  enabled: (id: string) => `/support-knowledge/articles/${encodeURIComponent(id)}/enabled`,
  candidates: '/support-knowledge/candidates',
  approve: (id: string) => `/support-knowledge/candidates/${encodeURIComponent(id)}/approve`,
  reject: (id: string) => `/support-knowledge/candidates/${encodeURIComponent(id)}/reject`,
  propose: (conversationId: string) =>
    `/business-chats/${encodeURIComponent(conversationId)}/knowledge-proposals`,
} as const;

export const SUPPORT_KNOWLEDGE_ERROR_CODES = {
  NOT_FOUND: 'support_knowledge.not_found',
  CANDIDATE_NOT_FOUND: 'support_knowledge.candidate_not_found',
  VERSION_CONFLICT: 'support_knowledge.version_conflict',
  NOT_IN_STATE: 'support_knowledge.not_in_state',
  SENSITIVE_CONTENT: 'support_knowledge.sensitive_content',
  RATE_LIMITED: 'support_knowledge.learning_rate_limited',
  AI_OFF: 'support_knowledge.ai_off',
  SOURCE_NOT_ELIGIBLE: 'support_knowledge.source_not_eligible',
  LIMIT: 'support_knowledge.limit',
  SCOPE_STOPPED: 'support_knowledge.scope_stopped',
} as const;

// ---------------------------------------------------------------------------
// TB9 — the one-click knowledge build from NEXA (ADR-0035 §5, program §30, §39)
// ---------------------------------------------------------------------------

/**
 * THE source allowlist. A build reads these and nothing else, each through one adapter that
 * maps a record to its customer-facing fields only. A test pins this list exactly, so a new
 * source is a reviewed change.
 *
 * - `PRODUCT` — an ACTIVE product offered to EVERYONE: its public title, description, display
 *   features and locations, duration, traffic and device limit. Never the price (the pricing
 *   boundary is the one answer to "what does this cost"), never the panel.
 * - `LOCATIONS` — the labels of the enabled service locations, as one article.
 * - `CLIENT_APP` — an ENABLED client app: name, description, guide, help and official URLs.
 * - `TUTORIAL` — the connection guides `bot.tutorial.<platform>`, the tenant's override or the
 *   default, raw (they declare no placeholder, so nothing is rendered).
 * - `FAQ` — an ACTIVE support FAQ entry.
 * - `TERMS` — the current published terms version.
 * - `SUPPORT_ACCOUNTS` — the `support.accounts` setting.
 * - `PAYMENT_METHOD` — an ENABLED payment route's display name and customer instructions,
 *   only when the instructions declare no placeholder. Never an account number or a gateway
 *   setting.
 */
export const SUPPORT_KNOWLEDGE_BUILD_SOURCE_TYPES = [
  'PRODUCT',
  'LOCATIONS',
  'CLIENT_APP',
  'TUTORIAL',
  'FAQ',
  'TERMS',
  'SUPPORT_ACCOUNTS',
  'PAYMENT_METHOD',
] as const;
export type SupportKnowledgeBuildSourceType = (typeof SUPPORT_KNOWLEDGE_BUILD_SOURCE_TYPES)[number];

/** A build is the tenant's one OPEN change-set until the next run supersedes it. */
export const SUPPORT_KNOWLEDGE_BUILD_STATES = ['OPEN', 'SUPERSEDED'] as const;
export type SupportKnowledgeBuildState = (typeof SUPPORT_KNOWLEDGE_BUILD_STATES)[number];

/**
 * What one source item proposes against the knowledge base.
 *
 * - `ADD` — no article holds this source yet.
 * - `UPDATE` — the source changed and its article was not edited since the last build.
 * - `UNCHANGED` — the source is as last built (or its article was retired): nothing to do.
 * - `CONFLICT` — the source changed AND its article was edited since the last build. Never
 *   applied without an explicit choice: a manual edit is never silently overwritten.
 * - `RETIRE` — a built article whose source is no longer in the allowlisted set (a product
 *   withdrawn, made reseller-only or put in a hidden category, an app disabled, a FAQ entry
 *   deactivated, a payment route switched off). Only ever PROPOSED: a reviewer applies it (the
 *   article is retired) or leaves it. Never part of «apply all», never automatic, and never
 *   forced over an article that moved since the build.
 */
export const SUPPORT_KNOWLEDGE_PROPOSAL_KINDS = [
  'ADD',
  'UPDATE',
  'UNCHANGED',
  'CONFLICT',
  'RETIRE',
] as const;
export type SupportKnowledgeProposalKind = (typeof SUPPORT_KNOWLEDGE_PROPOSAL_KINDS)[number];

/** `PENDING → APPLIED | SKIPPED`. An UNCHANGED proposal is SKIPPED from birth. */
export const SUPPORT_KNOWLEDGE_PROPOSAL_STATES = ['PENDING', 'APPLIED', 'SKIPPED'] as const;
export type SupportKnowledgeProposalState = (typeof SUPPORT_KNOWLEDGE_PROPOSAL_STATES)[number];

/** A reviewer's explicit choice on a CONFLICT: the build's text, or the edited article as is. */
export const SUPPORT_KNOWLEDGE_CONFLICT_CHOICES = ['TAKE_BUILD', 'KEEP_CURRENT'] as const;
export type SupportKnowledgeConflictChoice = (typeof SUPPORT_KNOWLEDGE_CONFLICT_CHOICES)[number];

/** Items per source type and per build: a bound, so one run is a reviewable change-set. */
export const SUPPORT_KNOWLEDGE_BUILD_LIMITS = { perSource: 100, proposals: 400 } as const;

export const supportKnowledgeBuildRunRequestSchema = z
  .object({ idempotencyKey: idempotencyKeySchema })
  .strict();

/**
 * Apply the named PENDING proposals, or (null) every pending ADD and UPDATE. A CONFLICT never
 * applies here; a RETIRE applies only when named.
 */
export const supportKnowledgeBuildApplyRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    proposalIds: z.array(z.uuid()).max(SUPPORT_KNOWLEDGE_BUILD_LIMITS.proposals).nullable(),
  })
  .strict();

export const supportKnowledgeBuildResolveRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    choice: z.enum(SUPPORT_KNOWLEDGE_CONFLICT_CHOICES),
  })
  .strict();

export const supportKnowledgeProposalViewSchema = z.object({
  id: z.string(),
  sourceType: z.enum(SUPPORT_KNOWLEDGE_BUILD_SOURCE_TYPES),
  kind: z.enum(SUPPORT_KNOWLEDGE_PROPOSAL_KINDS),
  state: z.enum(SUPPORT_KNOWLEDGE_PROPOSAL_STATES),
  title: z.string(),
  body: z.string(),
  category: z.enum(SUPPORT_KNOWLEDGE_CATEGORIES),
  /** The article as it was when the build ran (null for an ADD): the diff's other side. */
  baseTitle: z.string().nullable(),
  baseBody: z.string().nullable(),
  baseRevision: z.number().int().nullable(),
  articleId: z.string().nullable(),
  resolution: z.enum(SUPPORT_KNOWLEDGE_CONFLICT_CHOICES).nullable(),
});
export type SupportKnowledgeProposalView = z.infer<typeof supportKnowledgeProposalViewSchema>;

export const supportKnowledgeBuildViewSchema = z.object({
  id: z.string(),
  state: z.enum(SUPPORT_KNOWLEDGE_BUILD_STATES),
  createdAt: z.string(),
  /** The proposals of each kind, as they stand now (an UPDATE that met an edit is a CONFLICT). */
  counts: z.object({
    add: z.number().int(),
    update: z.number().int(),
    unchanged: z.number().int(),
    conflict: z.number().int(),
    retire: z.number().int(),
  }),
  /** Items whose text was clipped to the article bounds (title or body) when the build ran. */
  truncated: z.number().int(),
  /** Items dropped by the per-source or per-build bound (at least this many). */
  capped: z.number().int(),
  proposals: z.array(supportKnowledgeProposalViewSchema),
});
export type SupportKnowledgeBuildView = z.infer<typeof supportKnowledgeBuildViewSchema>;

export const supportKnowledgeBuildApplyResponseSchema = z.object({
  applied: z.number().int(),
  /** Proposals whose article moved since the build: now CONFLICT, waiting for a choice. */
  conflicted: z.number().int(),
  /**
   * Proposals that could not apply and were closed: an ADD whose source already has an article,
   * an UPDATE whose article was retired, a RETIRE whose article moved since the build.
   */
  skipped: z.number().int(),
});
export type SupportKnowledgeBuildApplyResponse = z.infer<
  typeof supportKnowledgeBuildApplyResponseSchema
>;

export const SUPPORT_KNOWLEDGE_BUILD_ROUTES = {
  builds: '/support-knowledge/builds',
  latest: '/support-knowledge/builds/latest',
  apply: (buildId: string) => `/support-knowledge/builds/${encodeURIComponent(buildId)}/apply`,
  resolve: (proposalId: string) =>
    `/support-knowledge/proposals/${encodeURIComponent(proposalId)}/resolve`,
} as const;

export const SUPPORT_KNOWLEDGE_BUILD_ERROR_CODES = {
  BUILD_NOT_FOUND: 'support_knowledge.build_not_found',
  BUILD_SUPERSEDED: 'support_knowledge.build_superseded',
  PROPOSAL_NOT_FOUND: 'support_knowledge.proposal_not_found',
  NOT_A_CONFLICT: 'support_knowledge.not_a_conflict',
  BASE_MOVED: 'support_knowledge.base_moved',
  /** Another run of the build for this tenant committed first; the newest build is that one. */
  BUILD_RUNNING: 'support_knowledge.build_running',
} as const;
