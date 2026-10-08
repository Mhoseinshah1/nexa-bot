// The contracts package's own zod, the version the frozen copies below were written against.
import { z } from '../../packages/contracts/node_modules/zod';
import { frozenPreA4OutboundView } from './frozen-business-chat-outbound';

/*
 * THE PRE-A3 WEB BUNDLE'S PARSERS for every read that carries a handoff reason or an automatic
 * outcome, copied from `packages/contracts/src/{business-chats,tickets,support-analytics,
 * support-ai}.ts` on `main` at `862a5418`, with each enum written out as main shipped it. A
 * rolling deploy serves a new replica's answer to that bundle, and one reason or outcome outside
 * these enums fails the WHOLE read — the inbox of the whole tenant (review of PR #248, the
 * handoff-reason follow-up to CX1). Kept here, not imported, so that widening a live enum cannot
 * quietly widen the "old" one with it.
 *
 * The ticket detail is frozen for its `escalations` only: the rest of it is not touched by A3, and
 * the pre-A3 parser strips the keys it does not name, so the part frozen is the part that differs.
 */

export const MAIN_HANDOFF_REASONS = [
  'SEND_OUTCOME_UNKNOWN',
  'TRANSPORT_REFUSED',
  'AI_REQUESTED',
  'HANDOFF_TOPIC',
  'HUMAN_REQUESTED',
  'TOPIC_NOT_ALLOWED',
  'LOW_CONFIDENCE',
  'REPLY_OUT_OF_BOUNDS',
  'DECISION_NOT_REPLY',
  'AI_OUTPUT_INVALID',
  'AI_UNAVAILABLE',
  'ACCOUNT_UNDER_REVIEW',
  'IDENTITY_UNVERIFIED',
  'CUSTOMER_BLOCKED',
  'INSUFFICIENT_GROUNDING',
  'LOOP_GUARD',
  'UNSUPPORTED_CONTENT',
  'REPLY_STALE',
  'CLARIFYING_LIMIT',
] as const;

export const MAIN_AUTO_OUTCOMES = [
  'sent',
  'sent_clarifying',
  'dropped_mode',
  'dropped_epoch',
  'dropped_state',
  'dropped_coalesced',
  'dropped_connection',
  'dropped_scope',
  'guard_content',
  'guard_customer_blocked',
  'guard_consecutive',
  'guard_window',
  'guard_decision',
  'guard_handoff_topic',
  'guard_human_requested',
  'guard_topic_allowlist',
  'guard_identity',
  'guard_account_review',
  'guard_confidence',
  'guard_reply_bounds',
  'guard_grounding',
  'guard_clarifying_limit',
  'handoff_ai_requested',
  'handoff_output_invalid',
  'handoff_ai_unavailable',
  'handoff_stale',
] as const;

const CONVERSATION_STATES = ['AI_ACTIVE', 'HUMAN_ACTIVE', 'HANDOFF_REQUIRED', 'PAUSED'] as const;
const PROVIDERS = ['OPENAI', 'ANTHROPIC', 'ZAI'] as const;
const AI_OUTCOMES = [
  'OK',
  'RATE_LIMITED',
  'AUTH_FAILED',
  'TEMPORARY',
  'INVALID_OUTPUT',
  'REFUSED_BY_PROVIDER',
  'TIMEOUT',
] as const;
const OPERATIONS = [
  'CONNECTION_TEST',
  'ASSIST_DRAFT',
  'AUTO_DECISION',
  'SUMMARY',
  'LEARNING_EXTRACT',
] as const;
const FAILURE_CLASSES = [
  'request_rejected',
  'unsupported_capability',
  'auth',
  'quota',
  'rate_limited',
  'timeout',
  'network',
  'provider_error',
  'refused',
  'no_content',
  'truncated',
  'not_json',
  'schema_invalid',
  'reply_too_long',
  'no_provider',
] as const;

const conversationSummary = z.object({
  id: z.string(),
  state: z.enum(CONVERSATION_STATES),
  takeoverReason: z
    .enum(['HUMAN_MESSAGE', 'OTHER_BOT', 'OPERATOR_TAKEOVER', 'OPERATOR_SEND'])
    .nullable(),
  handoffReason: z.enum(MAIN_HANDOFF_REASONS).nullable(),
  peerTelegramUserId: z.string(),
  customer: z
    .object({ id: z.string(), username: z.string().nullable(), firstName: z.string().nullable() })
    .nullable(),
  connectionStatus: z.enum(['ACTIVE', 'DISABLED', 'RIGHTS_INSUFFICIENT', 'SUPERSEDED']),
  lastMessageAt: z.string().nullable(),
  lastInboundAt: z.string().nullable(),
  preview: z.string().nullable(),
  unansweredSince: z.string().nullable(),
  ticketId: z.string().nullable(),
});

export const frozenPreA3ChatList = z.object({
  conversations: z.array(conversationSummary),
  nextCursor: z.string().nullable(),
});

const failureDiagnostic = z.object({
  failureClass: z.enum(FAILURE_CLASSES),
  operation: z.enum(OPERATIONS).nullable(),
  provider: z.enum(PROVIDERS).nullable(),
  model: z.string().nullable(),
  attemptIndex: z.number().int().nullable(),
  outcome: z.enum(AI_OUTCOMES).nullable(),
  httpStatus: z.number().int().nullable(),
  providerErrorCode: z.string().nullable(),
  providerErrorType: z.string().nullable(),
  providerErrorParam: z.string().nullable(),
  issuePath: z.string().nullable(),
  issueCode: z.string().nullable(),
  latencyMs: z.number().int().nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  at: z.string().nullable(),
});

export const frozenPreA3ChatDetail = z.object({
  conversation: conversationSummary.extend({
    controlEpoch: z.number().int(),
    lastHumanAt: z.string().nullable(),
  }),
  messages: z.array(
    z.object({
      id: z.string(),
      origin: z.enum(['INBOUND', 'OWN_ECHO', 'OFFLINE', 'OTHER_BOT', 'HUMAN']),
      kind: z.enum(['TEXT', 'PHOTO', 'OTHER']),
      text: z.string().nullable(),
      sentAt: z.string(),
      edited: z.boolean(),
      deleted: z.boolean(),
    }),
  ),
  outbound: z.array(frozenPreA4OutboundView),
  escalations: z.array(
    z.object({
      id: z.string(),
      reason: z.enum(MAIN_HANDOFF_REASONS),
      summary: z.string().nullable(),
      ticketId: z.string().nullable(),
      ticketOutcome: z.enum([
        'CREATED',
        'LINKED',
        'NO_CUSTOMER',
        'CUSTOMER_BLOCKED',
        'NO_CATEGORY',
        'SCOPE_INACTIVE',
      ]),
      createdAt: z.string(),
      aiFailure: failureDiagnostic.nullable(),
    }),
  ),
});

/** The ticket detail's `escalations`, the part A3 touches (see above). */
export const frozenPreA3TicketEscalations = z.object({
  escalations: z.array(
    z.object({
      conversationId: z.string(),
      reason: z.enum(MAIN_HANDOFF_REASONS),
      summary: z.string().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
});

const count = z.number().int().nonnegative();

export const frozenPreA3Analytics = z.object({
  period: z.object({
    range: z.enum([
      'TODAY',
      'YESTERDAY',
      'LAST_7_DAYS',
      'LAST_30_DAYS',
      'THIS_MONTH',
      'PREVIOUS_MONTH',
      'THIS_YEAR',
      'CUSTOM',
    ]),
    start: z.iso.datetime(),
    end: z.iso.datetime(),
  }),
  conversationsNow: z.array(z.object({ state: z.enum(CONVERSATION_STATES), count })),
  handoffsByReason: z.array(z.object({ reason: z.enum(MAIN_HANDOFF_REASONS), count })),
  auto: z.object({
    sent: count,
    handedOff: count,
    dropped: count,
    pending: count,
    byOutcome: z.array(z.object({ outcome: z.enum(MAIN_AUTO_OUTCOMES), count })),
  }),
  assist: z.object({
    requested: count,
    sent: count,
    discarded: count,
    superseded: count,
    failed: count,
    open: count,
  }),
  providerRuns: z.array(
    z.object({
      provider: z.enum(PROVIDERS),
      outcome: z.enum(AI_OUTCOMES),
      runs: count,
      p50LatencyMs: count,
      p95LatencyMs: count,
      inputTokens: count,
      outputTokens: count,
    }),
  ),
  aiFailures: z.array(
    z.object({
      operation: z.enum(OPERATIONS),
      provider: z.enum(PROVIDERS),
      failureClass: z.enum(FAILURE_CLASSES),
      runs: count,
    }),
  ),
  learningByState: z.array(z.object({ state: z.enum(['PENDING', 'APPROVED', 'REJECTED']), count })),
  knowledgeBySource: z.array(
    z.object({
      source: z.enum(['MANUAL', 'LEARNED', 'NEXA_BUILD']),
      state: z.enum(['DRAFT', 'APPROVED', 'RETIRED']),
      enabled: z.boolean(),
      count,
    }),
  ),
});
