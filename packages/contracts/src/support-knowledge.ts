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
 * written about the redacted value is about one customer.
 */
export const SUPPORT_LEARNING_SENSITIVE_KINDS = [
  'EMAIL',
  'PHONE',
  'CARD',
  'IBAN',
  'SUBSCRIPTION_LINK',
  'URL_TOKEN',
  'IP_ADDRESS',
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
  /** The title survives the purge: the duplicate check matches it (ADR-0035). */
  title: z.string(),
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
