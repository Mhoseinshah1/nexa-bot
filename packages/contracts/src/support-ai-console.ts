import { z } from 'zod';
import { BUSINESS_HANDOFF_KINDS, BUSINESS_HANDOFF_REASONS } from './business-chats.js';
import {
  SUPPORT_AI_AUTO_OUTCOMES,
  SUPPORT_AI_CONFIDENCES,
  SUPPORT_AI_DECISIONS,
  SUPPORT_AI_FAILURE_CLASSES,
  SUPPORT_AI_PROVIDERS,
  SUPPORT_AI_TOPICS,
} from './support-ai.js';

/**
 * Phase 4 PR-5 — the Web Admin's support pages: the readiness card, the test console, and the
 * two reports that read the TEXT behind a handoff (the analytics page reads counts only).
 *
 * Everything here is READ-ONLY with respect to the business: the test console runs the real
 * stored configuration through the decision pipeline and the same guards, and sends nothing to
 * any customer — no outbound row, no conversation change, no ticket (`support-test-console`).
 * Charged `support_ai.configure`, like the rest of this page.
 */
export const SUPPORT_AI_CONSOLE_ROUTES = {
  readiness: '/support-ai/readiness',
  testConsole: '/support-ai/test-console',
  handoffQuestions: '/support-ai/handoff-questions',
  knowledgeGaps: '/support-ai/knowledge-gaps',
} as const;

// --- readiness ----------------------------------------------------------------------

/** The lines of the readiness card, in the order the owner fixes them. */
export const SUPPORT_READINESS_CHECKS = [
  'BUSINESS_CONNECTION',
  'SUPPORT_HANDLE',
  'PROVIDER_KEY',
  'STRUCTURED_OUTPUT',
  'ASSISTANT_ROLE',
  'TOPICS',
  'KNOWLEDGE',
  'VISION',
] as const;
export type SupportReadinessCheck = (typeof SUPPORT_READINESS_CHECKS)[number];

/**
 * Why a line is what it is. The server states the fact; the page owns the Persian sentence and
 * the one-line fix for each code. `OK` lines carry the code of what was seen.
 */
export const SUPPORT_READINESS_DETAILS = [
  // BUSINESS_CONNECTION
  'CONNECTED',
  'NO_CONNECTION',
  'CONNECTION_DISABLED',
  'CANNOT_REPLY',
  // SUPPORT_HANDLE
  'HANDLE_MATCHES',
  'HANDLE_MISSING',
  'HANDLE_MISMATCH',
  'HANDLE_UNVERIFIED',
  // PROVIDER_KEY
  'KEY_OK',
  'NO_PRIMARY',
  'NO_KEY',
  'KEY_REJECTED',
  'BREAKER_OPEN',
  // STRUCTURED_OUTPUT
  'TEST_PASSED',
  'NOT_TESTED',
  'TEST_FAILED',
  'UNSUPPORTED',
  // ASSISTANT_ROLE
  'RUNNING',
  'NEVER_STARTED',
  'STOPPED',
  'RESTARTING',
  'STALLED',
  // TOPICS
  'TOPICS_SELECTED',
  'NO_TOPICS',
  // KNOWLEDGE
  'KNOWLEDGE_READY',
  'NO_KNOWLEDGE',
  // VISION
  'VISION_ON',
  'VISION_OFF',
  'VISION_UNSUPPORTED',
] as const;
export type SupportReadinessDetail = (typeof SUPPORT_READINESS_DETAILS)[number];

export const supportReadinessResponseSchema = z.object({
  checks: z.array(
    z.object({
      check: z.enum(SUPPORT_READINESS_CHECKS),
      status: z.enum(['OK', 'WARN']),
      detail: z.enum(SUPPORT_READINESS_DETAILS),
      /** A number the line quotes (topics selected, approved articles); null when none. */
      count: z.number().int().nonnegative().nullable(),
      /** Handles the line quotes (`support.accounts`); public handles, never a customer's. */
      handles: z.array(z.string()),
    }),
  ),
});
export type SupportReadinessResponse = z.infer<typeof supportReadinessResponseSchema>;

// --- test console -------------------------------------------------------------------

export const SUPPORT_TEST_QUESTION_MAX = 1000;

export const supportTestConsoleRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
  /** What the owner types as if a customer had sent it. */
  question: z.string().trim().min(1).max(SUPPORT_TEST_QUESTION_MAX),
  /** A real customer whose facts the context carries; null tests as an unlinked customer. */
  customerId: z.uuid().nullable().default(null),
});
export type SupportTestConsoleRequest = z.infer<typeof supportTestConsoleRequestSchema>;

/**
 * What the pipeline WOULD do with this question. Nothing was done.
 *
 * - `WOULD_SEND` — every guard passed; the reply below would go to the customer.
 * - `WOULD_SEND_LINK` — an unlinked customer asked about an account; the templated start-link
 *   message would go instead of the model's words.
 * - `WOULD_CLOSE_SILENTLY` — a thanks/solved message; nothing would be sent.
 * - `WOULD_HAND_OFF` — a guard blocks it (`guard`); a person would answer.
 * - `NOT_ASKED` — a guard before the model (money, content) stopped it; no provider was called.
 * - `NO_ANSWER` — the provider produced nothing usable (`failureClass`).
 */
export const SUPPORT_TEST_CONSOLE_VERDICTS = [
  'WOULD_SEND',
  'WOULD_SEND_LINK',
  'WOULD_CLOSE_SILENTLY',
  'WOULD_HAND_OFF',
  'NOT_ASKED',
  'NO_ANSWER',
] as const;
export type SupportTestConsoleVerdict = (typeof SUPPORT_TEST_CONSOLE_VERDICTS)[number];

export const supportTestConsoleResponseSchema = z.object({
  verdict: z.enum(SUPPORT_TEST_CONSOLE_VERDICTS),
  /** The stored mode, so the page can say that ASSIST_ONLY would only draft this. */
  mode: z.enum(['ASSIST_ONLY', 'AUTO_REPLY_SAFE']),
  /** The model's reply text (or its clarifying question); null when no model answered. */
  answer: z.string().nullable(),
  decision: z.enum(SUPPORT_AI_DECISIONS).nullable(),
  topic: z.enum(SUPPORT_AI_TOPICS).nullable(),
  confidence: z.enum(SUPPORT_AI_CONFIDENCES).nullable(),
  /** Titles of the knowledge entries the answer cited. */
  knowledgeUsed: z.array(z.string()),
  /** Labels of the customer facts the answer cited. */
  factsUsed: z.array(z.string()),
  /** The knowledge entries the request carried to the provider, of those available. */
  knowledgeSent: z.number().int().nonnegative().nullable(),
  knowledgeAvailable: z.number().int().nonnegative().nullable(),
  /** The guard that blocks it: the outcome and the handoff reason a conversation would get. */
  guard: z
    .object({
      outcome: z.enum(SUPPORT_AI_AUTO_OUTCOMES),
      reason: z.enum(BUSINESS_HANDOFF_REASONS),
      kind: z.enum(BUSINESS_HANDOFF_KINDS),
    })
    .nullable(),
  /** The output validator refused the reply (a real run asks once more, then hands off). */
  outputPolicyRefused: z.boolean(),
  failureClass: z.enum(SUPPORT_AI_FAILURE_CLASSES).nullable(),
  provider: z.enum(SUPPORT_AI_PROVIDERS).nullable(),
  model: z.string().nullable(),
  customerLinked: z.boolean(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
});
export type SupportTestConsoleResponse = z.infer<typeof supportTestConsoleResponseSchema>;

// --- the text behind a handoff -------------------------------------------------------

/** Both reports read the last this many days (the transcript's own retention is longer). */
export const SUPPORT_INSIGHTS_WINDOW_DAYS = 30;
export const SUPPORT_INSIGHTS_QUESTION_CHARS = 200;

export const supportHandoffQuestionsQuerySchema = z.object({
  reason: z.enum(BUSINESS_HANDOFF_REASONS),
});

export const supportHandoffQuestionsResponseSchema = z.object({
  reason: z.enum(BUSINESS_HANDOFF_REASONS),
  /** At most `SUPPORT_INSIGHTS_QUESTION_LIMIT`, newest first. */
  items: z.array(
    z.object({
      conversationId: z.string(),
      createdAt: z.string(),
      topic: z.enum(SUPPORT_AI_TOPICS).nullable(),
      kind: z.enum(BUSINESS_HANDOFF_KINDS).nullable(),
      /** The customer's last message before the handoff; null once purged by retention. */
      question: z.string().nullable(),
    }),
  ),
});
export type SupportHandoffQuestionsResponse = z.infer<typeof supportHandoffQuestionsResponseSchema>;
export const SUPPORT_INSIGHTS_QUESTION_LIMIT = 20;

export const supportKnowledgeGapsResponseSchema = z.object({
  /** Clustered questions the AI could not answer from approved content, biggest first. */
  gaps: z.array(
    z.object({
      topic: z.enum(SUPPORT_AI_TOPICS).nullable(),
      /** The model's own short label of what was asked (operator-only note); null if purged. */
      intent: z.string().nullable(),
      count: z.number().int().positive(),
      /** The outcomes that made these unanswered, by count (grounding, confidence, ...). */
      reasons: z.array(z.enum(BUSINESS_HANDOFF_REASONS)),
      examples: z.array(z.string()),
    }),
  ),
});
export type SupportKnowledgeGapsResponse = z.infer<typeof supportKnowledgeGapsResponseSchema>;
export const SUPPORT_KNOWLEDGE_GAPS_MAX = 20;
export const SUPPORT_KNOWLEDGE_GAP_EXAMPLES = 3;
