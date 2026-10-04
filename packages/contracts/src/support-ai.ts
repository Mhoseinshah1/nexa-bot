import { z } from 'zod';

/**
 * TB4 — the support AI's provider foundation (ADR-0034).
 *
 * The model reads and NEXA decides: nothing here gives a provider authority over any
 * customer, service, order, payment, wallet, ticket or permission. This file is the
 * provider-neutral vocabulary every adapter, the fallback chain and the configuration share.
 */

/** The three providers the program requires. A provider type is CODE, not a row. */
export const SUPPORT_AI_PROVIDERS = ['OPENAI', 'ANTHROPIC', 'ZAI'] as const;
export type SupportAiProvider = (typeof SUPPORT_AI_PROVIDERS)[number];

/**
 * The support agent's mode for a tenant.
 *
 * - `OFF` — no AI work of any kind. **The default for every tenant, new or migrated.**
 * - `ASSIST_ONLY` — the AI drafts for an operator; it never sends (TB5).
 * - `AUTO_REPLY_SAFE` — the AI may answer allowlisted topics automatically (TB7). Entering it
 *   needs `support_ai.auto_reply` (CRITICAL); no migration ever sets it.
 */
export const SUPPORT_AI_MODES = ['OFF', 'ASSIST_ONLY', 'AUTO_REPLY_SAFE'] as const;
export type SupportAiMode = (typeof SUPPORT_AI_MODES)[number];

/**
 * What one provider call produced — seven outcomes, and no eighth "it failed" that callers
 * would each interpret (ADR-0034 §2).
 *
 * Quota or billing exhaustion is `AUTH_FAILED` with `quota: true`: like a rejected key it is
 * not transient, retrying it is useless, and the operator must act on the credential. It is
 * never `RATE_LIMITED` (TB4 audit: OpenAI `insufficient_quota` and Z.AI 1113 are 429s).
 */
export const SUPPORT_AI_OUTCOMES = [
  'OK',
  'RATE_LIMITED',
  'AUTH_FAILED',
  'TEMPORARY',
  'INVALID_OUTPUT',
  'REFUSED_BY_PROVIDER',
  'TIMEOUT',
] as const;
export type SupportAiOutcomeKind = (typeof SUPPORT_AI_OUTCOMES)[number];

export interface SupportAiUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export type SupportAiOutcome =
  | {
      readonly outcome: 'OK';
      /** The parsed JSON object the model returned. Validated by the CALLER's schema. */
      readonly output: unknown;
      readonly usage: SupportAiUsage;
      readonly model: string;
    }
  | {
      readonly outcome: 'RATE_LIMITED';
      readonly retryAfterMs: number | null;
      readonly code: string;
    }
  | { readonly outcome: 'AUTH_FAILED'; readonly quota: boolean; readonly code: string }
  | { readonly outcome: 'TEMPORARY'; readonly code: string }
  | { readonly outcome: 'INVALID_OUTPUT'; readonly code: string; readonly usage?: SupportAiUsage }
  | {
      readonly outcome: 'REFUSED_BY_PROVIDER';
      readonly code: string;
      readonly usage?: SupportAiUsage;
    }
  | { readonly outcome: 'TIMEOUT' };

/**
 * The outcomes that move to the next configured provider (ADR-0034 §3, TB0 amendment 4).
 * `INVALID_OUTPUT` and `REFUSED_BY_PROVIDER` NEVER fall back: asking another model until one
 * agrees is a way of laundering an unsafe answer.
 */
export const SUPPORT_AI_FALLBACK_OUTCOMES = [
  'RATE_LIMITED',
  'AUTH_FAILED',
  'TEMPORARY',
  'TIMEOUT',
] as const satisfies readonly SupportAiOutcomeKind[];

export function supportAiOutcomeFallsBack(outcome: SupportAiOutcomeKind): boolean {
  return (SUPPORT_AI_FALLBACK_OUTCOMES as readonly string[]).includes(outcome);
}

/** What an adapter declares it can do. Core code branches on these, never on a provider name. */
export interface SupportAiCapabilities {
  /** A native JSON-schema output mode; otherwise the adapter asks for JSON and the core validates. */
  readonly structuredOutput: boolean;
  readonly vision: boolean;
  readonly maxImageBytes: number;
  readonly imageMediaTypes: readonly string[];
}

/** The image types any support flow may pass. Never a document, never an executable. */
export const SUPPORT_AI_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * The circuit breaker (ADR-0034 §3): this many consecutive transient failures trip a
 * provider for `SUPPORT_AI_BREAKER_OPEN_MS`; a call after that is the half-open probe.
 */
export const SUPPORT_AI_BREAKER_THRESHOLD = 3;
export const SUPPORT_AI_BREAKER_OPEN_MS = 5 * 60_000;

/** Operational-event codes (a code is schema; named in the release that introduces it). */
export const SUPPORT_AI_CREDENTIAL_REJECTED_CODE = 'support.ai_provider.credential_rejected';
export const SUPPORT_AI_CREDENTIAL_ACCEPTED_CODE = 'support.ai_provider.credential_accepted';
export const SUPPORT_AI_UNAVAILABLE_CODE = 'support.ai_provider.unavailable';
export const SUPPORT_AI_AVAILABLE_CODE = 'support.ai_provider.available';

/** What a run was for (telemetry). */
export const SUPPORT_AI_OPERATIONS = [
  'CONNECTION_TEST',
  'ASSIST_DRAFT',
  'AUTO_DECISION',
  'SUMMARY',
  'LEARNING_EXTRACT',
] as const;
export type SupportAiOperation = (typeof SUPPORT_AI_OPERATIONS)[number];

// --- configuration -------------------------------------------------------------

/** The settle delay before an automatic reply's final check (TB0 amendment 3). */
export const SUPPORT_AI_SETTLE_DELAY_DEFAULT_SECONDS = 6;
export const SUPPORT_AI_SETTLE_DELAY_MIN_SECONDS = 3;
export const SUPPORT_AI_SETTLE_DELAY_MAX_SECONDS = 30;

/** Bounds every configuration field is held to, in the schema and in the table's CHECKs. */
export const SUPPORT_AI_LIMITS = {
  maxFallbacks: 2,
  timeoutMs: { min: 5_000, max: 120_000, default: 30_000 },
  maxOutputChars: { min: 200, max: 4_000, default: 1_200 },
  maxConsecutiveReplies: { min: 1, max: 20, default: 4 },
  cooldownSeconds: { min: 0, max: 3_600, default: 20 },
  toneInstructionsChars: 2_000,
  modelIdChars: 128,
} as const;

const modelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(SUPPORT_AI_LIMITS.modelIdChars)
  .regex(/^[A-Za-z0-9._:/-]+$/u, 'A model id is letters, digits and . _ : / -');

export const supportAiProviderStepSchema = z.object({
  provider: z.enum(SUPPORT_AI_PROVIDERS),
  model: modelIdSchema,
});
export type SupportAiProviderStep = z.infer<typeof supportAiProviderStepSchema>;

/**
 * The editable configuration. `mode` is in it, but ENTERING `AUTO_REPLY_SAFE` is charged a
 * second, CRITICAL permission by the service (ADR-0034 §8). Turning safety on is never harder
 * than turning it off.
 */
export const supportAiConfigInputSchema = z
  .object({
    mode: z.enum(SUPPORT_AI_MODES),
    primary: supportAiProviderStepSchema.nullable(),
    fallbacks: z.array(supportAiProviderStepSchema).max(SUPPORT_AI_LIMITS.maxFallbacks),
    visionEnabled: z.boolean(),
    timeoutMs: z
      .number()
      .int()
      .min(SUPPORT_AI_LIMITS.timeoutMs.min)
      .max(SUPPORT_AI_LIMITS.timeoutMs.max),
    maxOutputChars: z
      .number()
      .int()
      .min(SUPPORT_AI_LIMITS.maxOutputChars.min)
      .max(SUPPORT_AI_LIMITS.maxOutputChars.max),
    maxConsecutiveReplies: z
      .number()
      .int()
      .min(SUPPORT_AI_LIMITS.maxConsecutiveReplies.min)
      .max(SUPPORT_AI_LIMITS.maxConsecutiveReplies.max),
    cooldownSeconds: z
      .number()
      .int()
      .min(SUPPORT_AI_LIMITS.cooldownSeconds.min)
      .max(SUPPORT_AI_LIMITS.cooldownSeconds.max),
    settleDelaySeconds: z
      .number()
      .int()
      .min(SUPPORT_AI_SETTLE_DELAY_MIN_SECONDS)
      .max(SUPPORT_AI_SETTLE_DELAY_MAX_SECONDS),
    toneInstructions: z.string().max(SUPPORT_AI_LIMITS.toneInstructionsChars),
  })
  .superRefine((value, ctx) => {
    // A mode that does AI work needs a provider to do it with.
    if (value.mode !== 'OFF' && value.primary === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['primary'],
        message: 'A mode other than OFF needs a provider.',
      });
    }
    // Each fallback must be an INDEPENDENTLY configured provider (TB0 amendment 4).
    const providers = [
      value.primary?.provider,
      ...value.fallbacks.map((step) => step.provider),
    ].filter((provider): provider is SupportAiProvider => provider !== undefined);
    if (new Set(providers).size !== providers.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['fallbacks'],
        message: 'Each step of the chain must be a different provider.',
      });
    }
    if (value.primary === null && value.fallbacks.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['fallbacks'], message: 'A fallback needs a primary.' });
    }
  });
export type SupportAiConfigInput = z.infer<typeof supportAiConfigInputSchema>;

/** The configuration every tenant starts with — and has until an owner changes it. */
export const SUPPORT_AI_DEFAULT_CONFIG: SupportAiConfigInput = {
  mode: 'OFF',
  primary: null,
  fallbacks: [],
  visionEnabled: false,
  timeoutMs: SUPPORT_AI_LIMITS.timeoutMs.default,
  maxOutputChars: SUPPORT_AI_LIMITS.maxOutputChars.default,
  maxConsecutiveReplies: SUPPORT_AI_LIMITS.maxConsecutiveReplies.default,
  cooldownSeconds: SUPPORT_AI_LIMITS.cooldownSeconds.default,
  settleDelaySeconds: SUPPORT_AI_SETTLE_DELAY_DEFAULT_SECONDS,
  toneInstructions: '',
};

const idempotencyKeySchema = z.string().min(8).max(128);

export const supportAiConfigUpdateRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  /** Optimistic concurrency (ADR-0021): the version the operator saw; null for "none stored yet". */
  expectedVersion: z.number().int().min(0).nullable(),
  config: supportAiConfigInputSchema,
});
export type SupportAiConfigUpdateRequest = z.infer<typeof supportAiConfigUpdateRequestSchema>;

/**
 * A credential is SET, never read back (ADR-0023). There is no masked stand-in: a
 * `********` could be resubmitted as the real key.
 */
export const supportAiCredentialSetRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  apiKey: z.string().trim().min(8).max(512),
  /**
   * Only for `ZAI`, whose keys belong to one of two hosts (international or China). Never a
   * free URL: an operator-typed URL is a way to send a key somewhere it should not go.
   */
  region: z.enum(['INTERNATIONAL', 'CHINA']).optional(),
});
export type SupportAiCredentialSetRequest = z.infer<typeof supportAiCredentialSetRequestSchema>;

export const supportAiControlRequestSchema = z.object({ idempotencyKey: idempotencyKeySchema });

export const supportAiCredentialViewSchema = z.object({
  provider: z.enum(SUPPORT_AI_PROVIDERS),
  configured: z.boolean(),
  setAt: z.string().nullable(),
  region: z.enum(['INTERNATIONAL', 'CHINA']).nullable(),
  /** The breaker: open until this instant, or null. */
  trippedUntil: z.string().nullable(),
  lastTestOutcome: z.enum(SUPPORT_AI_OUTCOMES).nullable(),
  lastTestedAt: z.string().nullable(),
});
export type SupportAiCredentialView = z.infer<typeof supportAiCredentialViewSchema>;

export const supportAiConfigResponseSchema = z.object({
  config: supportAiConfigInputSchema,
  version: z.number().int(),
  credentials: z.array(supportAiCredentialViewSchema),
  capabilities: z.record(
    z.enum(SUPPORT_AI_PROVIDERS),
    z.object({ structuredOutput: z.boolean(), vision: z.boolean() }),
  ),
});
export type SupportAiConfigResponse = z.infer<typeof supportAiConfigResponseSchema>;

export const supportAiTestResponseSchema = z.object({
  outcome: z.enum(SUPPORT_AI_OUTCOMES),
  code: z.string().nullable(),
  latencyMs: z.number().int(),
});
export type SupportAiTestResponse = z.infer<typeof supportAiTestResponseSchema>;

export const SUPPORT_AI_ROUTES = {
  config: '/support-ai/config',
  credential: (provider: string) => `/support-ai/credentials/${encodeURIComponent(provider)}`,
  test: (provider: string) => `/support-ai/credentials/${encodeURIComponent(provider)}/test`,
  usage: '/support-ai/usage',
} as const;

/** Usage telemetry, summarised (never a prompt or a response). */
export const supportAiUsageResponseSchema = z.object({
  since: z.string(),
  rows: z.array(
    z.object({
      provider: z.enum(SUPPORT_AI_PROVIDERS),
      model: z.string(),
      operation: z.enum(SUPPORT_AI_OPERATIONS),
      calls: z.number().int(),
      failures: z.number().int(),
      inputTokens: z.number().int(),
      outputTokens: z.number().int(),
      avgLatencyMs: z.number().int(),
    }),
  ),
});
export type SupportAiUsageResponse = z.infer<typeof supportAiUsageResponseSchema>;

// ---------------------------------------------------------------------------
// TB5 — the structured decision, and Assist drafts (ADR-0034 §1, §6)
// ---------------------------------------------------------------------------

/**
 * What the model may decide. Nothing here performs an action: `CREATE_OR_LINK_TICKET` is a
 * SUGGESTION the deterministic layer (TB7) carries out under its own rules, and every other
 * privileged act hands off (ADR-0034 §1).
 */
export const SUPPORT_AI_DECISIONS = [
  'REPLY',
  'ASK_CLARIFYING_QUESTION',
  'HANDOFF',
  'CREATE_OR_LINK_TICKET',
  'NO_ACTION',
] as const;
export type SupportAiDecisionKind = (typeof SUPPORT_AI_DECISIONS)[number];

/**
 * The closed topic catalogue. The model names one; the deterministic guards (TB7) decide what
 * a topic may lead to. The SAFE ones are the only topics an automatic reply may ever answer,
 * and only when the tenant's allowlist names them (default: none).
 */
export const SUPPORT_AI_SAFE_TOPICS = [
  'CONNECTION_TROUBLESHOOTING',
  'APP_SETUP',
  'SUBSCRIPTION_UPDATE',
  'SERVICE_INFO',
  'TRAFFIC_AND_EXPIRY',
  'PLAN_INFO',
  'KNOWN_ERROR',
  'GREETING',
] as const;
export type SupportAiSafeTopic = (typeof SUPPORT_AI_SAFE_TOPICS)[number];

/** Topics that ALWAYS hand off, whatever the model's decision or confidence (program §26). */
export const SUPPORT_AI_HANDOFF_TOPICS = [
  'REFUND',
  'WALLET',
  'PAYMENT_DISPUTE',
  'PAYMENT_STATUS',
  'RECEIPT_REVIEW',
  'SERVICE_DELETE_OR_TERMINATE',
  'OWNERSHIP_OR_ACCOUNT_TRANSFER',
  'ACCOUNT_SECURITY',
  'CREDENTIALS',
  'PROVIDER_CHANGE',
  'FRAUD_OR_CHARGEBACK',
  'LEGAL_OR_SAFETY',
  'HUMAN_REQUESTED',
  'OTHER',
] as const;

export const SUPPORT_AI_TOPICS = [...SUPPORT_AI_SAFE_TOPICS, ...SUPPORT_AI_HANDOFF_TOPICS] as const;
export type SupportAiTopic = (typeof SUPPORT_AI_TOPICS)[number];

export const SUPPORT_AI_CONFIDENCES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const SUPPORT_AI_TICKET_ACTIONS = ['NONE', 'CREATE', 'LINK'] as const;

/** The longest reply text a decision may carry, whatever the tenant configures. */
export const SUPPORT_AI_REPLY_MAX_CHARS = 4000;

/**
 * THE decision a model must return, validated by zod before anything reads it. Invalid output
 * sends nothing (ADR-0034 §1). `factRefs` and `knowledgeRefs` name payload aliases (`S1`, `P2`,
 * `K3`); a ref the payload did not contain is a reason to refuse the decision (TB7).
 */
export const supportAiDecisionSchema = z
  .object({
    decision: z.enum(SUPPORT_AI_DECISIONS),
    replyText: z.string().max(SUPPORT_AI_REPLY_MAX_CHARS),
    topic: z.enum(SUPPORT_AI_TOPICS),
    confidence: z.enum(SUPPORT_AI_CONFIDENCES),
    factRefs: z.array(z.string().regex(/^[A-Z][0-9]{1,3}$/u)).max(20),
    knowledgeRefs: z.array(z.string().regex(/^[A-Z][0-9]{1,3}$/u)).max(20),
    ticketAction: z.enum(SUPPORT_AI_TICKET_ACTIONS),
    /** One or two sentences for the operator: what the customer wants, in Persian. */
    summary: z.string().max(600),
    /** A short label of the customer's intent, for the operator. */
    intent: z.string().max(120),
  })
  .strict();
export type SupportAiDecision = z.infer<typeof supportAiDecisionSchema>;

/**
 * The same decision as a JSON Schema in the intersection every provider accepts (OQ-TB-21):
 * closed objects, every property required, no numeric or length keywords — zod above enforces
 * the bounds the providers would strip.
 */
export const SUPPORT_AI_DECISION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'decision',
    'replyText',
    'topic',
    'confidence',
    'factRefs',
    'knowledgeRefs',
    'ticketAction',
    'summary',
    'intent',
  ],
  properties: {
    decision: { type: 'string', enum: [...SUPPORT_AI_DECISIONS] },
    replyText: { type: 'string' },
    topic: { type: 'string', enum: [...SUPPORT_AI_TOPICS] },
    confidence: { type: 'string', enum: [...SUPPORT_AI_CONFIDENCES] },
    factRefs: { type: 'array', items: { type: 'string' } },
    knowledgeRefs: { type: 'array', items: { type: 'string' } },
    ticketAction: { type: 'string', enum: [...SUPPORT_AI_TICKET_ACTIONS] },
    summary: { type: 'string' },
    intent: { type: 'string' },
  },
};

/**
 * An AI job (TB5 Assist drafts; TB7 automatic decisions). The draft is the job's result and
 * lives on the same row, bounded and purged with the transcript's retention.
 */
export const SUPPORT_AI_JOB_KINDS = ['ASSIST_DRAFT'] as const;
export type SupportAiJobKind = (typeof SUPPORT_AI_JOB_KINDS)[number];

/**
 * - `QUEUED` — waiting for the `assistant` role.
 * - `READY` — a draft exists; nothing was sent.
 * - `FAILED` — no draft: the chain could not answer, or the answer was invalid.
 * - `SENT` — an operator sent it (edited or not), through the ordinary outbound lane.
 * - `DISCARDED` — an operator threw it away, or a newer draft replaced it.
 */
export const SUPPORT_AI_JOB_STATES = ['QUEUED', 'READY', 'FAILED', 'SENT', 'DISCARDED'] as const;
export type SupportAiJobState = (typeof SUPPORT_AI_JOB_STATES)[number];

export const supportAiDraftViewSchema = z.object({
  id: z.string(),
  state: z.enum(SUPPORT_AI_JOB_STATES),
  createdAt: z.string(),
  readyAt: z.string().nullable(),
  failureCode: z.string().nullable(),
  decision: z.enum(SUPPORT_AI_DECISIONS).nullable(),
  topic: z.enum(SUPPORT_AI_TOPICS).nullable(),
  confidence: z.enum(SUPPORT_AI_CONFIDENCES).nullable(),
  summary: z.string().nullable(),
  intent: z.string().nullable(),
  suggestedReply: z.string().nullable(),
  ticketAction: z.enum(SUPPORT_AI_TICKET_ACTIONS).nullable(),
  /** Payload aliases the model cited, resolved server-side to short human labels. */
  factLabels: z.array(z.string()),
  provider: z.enum(SUPPORT_AI_PROVIDERS).nullable(),
  model: z.string().nullable(),
});
export type SupportAiDraftView = z.infer<typeof supportAiDraftViewSchema>;

export const supportAiDraftRequestSchema = z.object({ idempotencyKey: idempotencyKeySchema });
export const supportAiDraftSendRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  /** The text the operator actually sends — the draft, edited or not. */
  text: z.string().trim().min(1).max(4096),
});

export const SUPPORT_AI_ASSIST_ROUTES = {
  drafts: (conversationId: string) => `/business-chats/${encodeURIComponent(conversationId)}/drafts`,
  draft: (draftId: string) => `/support-ai/drafts/${encodeURIComponent(draftId)}`,
  send: (draftId: string) => `/support-ai/drafts/${encodeURIComponent(draftId)}/send`,
  discard: (draftId: string) => `/support-ai/drafts/${encodeURIComponent(draftId)}/discard`,
} as const;

/** Drafts and their AI text are purged with the transcript (ADR-0033 §8). */
export const SUPPORT_AI_DRAFT_RETENTION_DAYS = 30;
