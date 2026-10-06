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

/**
 * WHY one provider call (or the decision it produced) failed — the operator's diagnosis, a
 * closed set pinned by CHECK constraints on `support_ai_runs`, `support_ai_jobs` and the
 * credential's last test. The seven outcomes above decide what the CHAIN does (fall back or
 * stop); a class says what an operator must change, and several classes share one outcome.
 *
 * - `request_rejected` — HTTP 400/404/422: the provider refused the request itself (a model id,
 *   a parameter). The provider's own error code, type and param ride along when safe.
 * - `unsupported_capability` — a rejection that names the capability NEXA needs: strict
 *   structured output (`response_format`), an unsupported parameter or value, or an image sent
 *   to an adapter that cannot see.
 * - `auth` / `quota` — the key was rejected / the account has no quota or balance.
 * - `rate_limited` — a 429 that is not quota. `timeout` — no answer in time.
 * - `network` — no HTTP answer (connection, DNS, an oversized or unreadable body, a 2xx that is
 *   not JSON). `provider_error` — a 408/409/5xx/529 from the provider.
 * - `refused` — the provider's refusal or content filter.
 * - `no_content` / `truncated` / `not_json` — a 2xx that carried no text, stopped at the
 *   output limit, or was not a JSON object.
 * - `schema_invalid` — JSON that fails `supportAiDecisionSchema` (recorded with the zod issue's
 *   PATH and CODE only, never a value). `reply_too_long` — a reply over the tenant's limit.
 * - `no_provider` — no step could be called at all (off, no key, every breaker open).
 *
 * Never the provider's free-text message, the prompt or the response: a class and a few
 * provider-defined identifiers are what is stored.
 */
export const SUPPORT_AI_FAILURE_CLASSES = [
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
export type SupportAiFailureClass = (typeof SUPPORT_AI_FAILURE_CLASSES)[number];

/**
 * The safe part of a failed call: its class, the HTTP status, and the provider's own
 * MACHINE identifiers (`error.code`, `error.type`, `error.param`) when each is a short token
 * (`safeProviderToken`). Never `error.message`.
 */
export interface SupportAiFailureDetail {
  readonly failureClass: SupportAiFailureClass;
  readonly httpStatus: number | null;
  readonly providerErrorCode: string | null;
  readonly providerErrorType: string | null;
  readonly providerErrorParam: string | null;
}

/**
 * A provider-defined identifier is kept only when it is a short token — letters, digits and
 * `_ . : - [ ]` (so `messages[0].role` survives) — and nothing that could be prose, a
 * customer's words or a key fragment of unbounded length.
 */
export const SUPPORT_AI_PROVIDER_TOKEN_MAX = 64;
export function safeProviderToken(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value)) value = String(value);
  if (typeof value !== 'string') return null;
  return value.length <= SUPPORT_AI_PROVIDER_TOKEN_MAX && /^[A-Za-z0-9_.:[\]-]+$/u.test(value)
    ? value
    : null;
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
      readonly detail?: SupportAiFailureDetail;
    }
  | {
      readonly outcome: 'AUTH_FAILED';
      readonly quota: boolean;
      readonly code: string;
      readonly detail?: SupportAiFailureDetail;
    }
  | {
      readonly outcome: 'TEMPORARY';
      readonly code: string;
      readonly detail?: SupportAiFailureDetail;
    }
  | {
      readonly outcome: 'INVALID_OUTPUT';
      readonly code: string;
      readonly usage?: SupportAiUsage;
      readonly detail?: SupportAiFailureDetail;
    }
  | {
      readonly outcome: 'REFUSED_BY_PROVIDER';
      readonly code: string;
      readonly usage?: SupportAiUsage;
      readonly detail?: SupportAiFailureDetail;
    }
  | { readonly outcome: 'TIMEOUT'; readonly detail?: SupportAiFailureDetail };

/**
 * The detail of a failed outcome: the adapter's own when it gave one, otherwise the class the
 * outcome kind implies with nothing else known. Null for `OK`. A code ending `.truncated`,
 * `.no_content`, `.not_json` or `.schema_invalid` keeps its precise class even without a detail,
 * so an older or hand-built outcome is never reported vaguer than its code says.
 */
export function supportAiFailureDetailOf(outcome: SupportAiOutcome): SupportAiFailureDetail | null {
  if (outcome.outcome === 'OK') return null;
  if (outcome.detail !== undefined) return outcome.detail;
  const bare = (failureClass: SupportAiFailureClass): SupportAiFailureDetail => ({
    failureClass,
    httpStatus: null,
    providerErrorCode: null,
    providerErrorType: null,
    providerErrorParam: null,
  });
  switch (outcome.outcome) {
    case 'TIMEOUT':
      return bare('timeout');
    case 'RATE_LIMITED':
      return bare('rate_limited');
    case 'AUTH_FAILED':
      return bare(outcome.quota ? 'quota' : 'auth');
    case 'REFUSED_BY_PROVIDER':
      return bare('refused');
    case 'TEMPORARY':
      return bare(/\.http_\d+$/u.test(outcome.code) ? 'provider_error' : 'network');
    case 'INVALID_OUTPUT': {
      const suffix = outcome.code.slice(outcome.code.lastIndexOf('.') + 1);
      const known: Readonly<Record<string, SupportAiFailureClass>> = {
        truncated: 'truncated',
        no_content: 'no_content',
        not_json: 'not_json',
        schema_invalid: 'schema_invalid',
        reply_too_long: 'reply_too_long',
      };
      return bare(known[suffix] ?? 'request_rejected');
    }
    default: {
      const unreachable: never = outcome;
      throw new Error(`unclassified outcome ${String(unreachable)}`);
    }
  }
}

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

/**
 * TB7 — the safe topics that need no account: the only ones an UNLINKED customer may be
 * answered on automatically (tb0-audit §3.5). The other safe topics are about one customer's
 * own services, which an unlinked peer has none of in NEXA's eyes.
 */
export const SUPPORT_AI_GENERAL_TOPICS = [
  'CONNECTION_TROUBLESHOOTING',
  'APP_SETUP',
  'PLAN_INFO',
  'KNOWN_ERROR',
  'GREETING',
] as const satisfies readonly SupportAiSafeTopic[];

export const SUPPORT_AI_CONFIDENCES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type SupportAiConfidence = (typeof SUPPORT_AI_CONFIDENCES)[number];
/** The lowest confidence an automatic reply may be configured to accept. LOW never sends. */
export const SUPPORT_AI_AUTO_MIN_CONFIDENCES = ['MEDIUM', 'HIGH'] as const;

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
    /**
     * TB7 — the safe topics an automatic reply may answer. EMPTY by default, and empty means
     * nothing is ever sent automatically. Widening it charges `support_ai.auto_reply`.
     * Defaulted so a client that does not know the field saves the SAFE value: none.
     */
    autoTopics: z
      .array(z.enum(SUPPORT_AI_SAFE_TOPICS))
      .max(SUPPORT_AI_SAFE_TOPICS.length)
      .default([]),
    /** TB7 — the lowest model confidence an automatic reply accepts. Default HIGH. */
    autoMinConfidence: z.enum(SUPPORT_AI_AUTO_MIN_CONFIDENCES).default('HIGH'),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.autoTopics).size !== value.autoTopics.length) {
      ctx.addIssue({ code: 'custom', path: ['autoTopics'], message: 'A topic is listed twice.' });
    }
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
  autoTopics: [],
  autoMinConfidence: 'HIGH',
};

/**
 * TB7 — the loop guard's window: at most `maxPerWindow` automatic replies per conversation in
 * any `windowSeconds`, whatever the consecutive limit (`maxConsecutiveReplies`) allows.
 */
export const SUPPORT_AI_AUTO_WINDOW = { windowSeconds: 3_600, maxPerWindow: 10 } as const;

/**
 * TB7 — how late an automatic reply may still be (substitute review of PR #202). A job produced
 * more than this after its `due_at`, or an AUTO lane row not yet sent this long after it was
 * enqueued, is never sent: the conversation is handed to a person (`REPLY_STALE`).
 *
 * Measured from `due_at`, not from the message, because `due_at` is the message's arrival plus
 * the settle delay (≤ 30 s) or the end of the owner's own cooldown (≤ 1 h), whichever is later;
 * a bound on the message's age would hand off every reply the owner deliberately postponed.
 * Ten minutes is far above the normal latency (the assistant polls every 2 s, and the worst
 * case of one job is 7 min) and far below "the tenant was stopped and resumed later", which is
 * what it exists for: a stopped scope takes no writes, so its jobs wait untouched, and on
 * resume a person — not a reply about a conversation that moved on — answers them.
 */
export const SUPPORT_AI_AUTO_STALE_SECONDS = 600;

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

/**
 * TB10 — the breaker as the operator reads it, DERIVED from the credential row at read time
 * and never stored (the row's `tripped_until` and `consecutive_failures` are the state):
 *
 * - `CLOSED` — calls go through (`tripped_until` is null);
 * - `OPEN` — the provider is skipped until `tripped_until`;
 * - `HALF_OPEN` — the window has passed: the next caller claims ONE probe call
 *   (`claimProbe`), and its answer closes or re-opens the breaker.
 */
export const SUPPORT_AI_BREAKER_STATES = ['CLOSED', 'OPEN', 'HALF_OPEN'] as const;
export type SupportAiBreakerState = (typeof SUPPORT_AI_BREAKER_STATES)[number];

export function supportAiBreakerState(trippedUntil: Date | null, now: Date): SupportAiBreakerState {
  if (trippedUntil === null) return 'CLOSED';
  return trippedUntil.getTime() > now.getTime() ? 'OPEN' : 'HALF_OPEN';
}

export const supportAiCredentialViewSchema = z.object({
  provider: z.enum(SUPPORT_AI_PROVIDERS),
  configured: z.boolean(),
  setAt: z.string().nullable(),
  region: z.enum(['INTERNATIONAL', 'CHINA']).nullable(),
  /** The breaker: open until this instant, or null. */
  trippedUntil: z.string().nullable(),
  lastTestOutcome: z.enum(SUPPORT_AI_OUTCOMES).nullable(),
  /**
   * Why the last test was not `OK` — the first failing check's class; null when it passed or
   * no test ran since this column existed. `lastTestOutcome` keeps its meaning: `OK` only when
   * EVERY check that ran passed (model access, structured generation, decision schema, and
   * vision when vision is on), never because the model could merely be listed.
   */
  lastTestFailureClass: z.enum(SUPPORT_AI_FAILURE_CLASSES).nullable(),
  lastTestedAt: z.string().nullable(),
  /** TB10: `supportAiBreakerState` at the moment of the read; `CLOSED` with no key. */
  breaker: z.enum(SUPPORT_AI_BREAKER_STATES),
  /** TB10: transient failures in a row since the last answer (the breaker's counter). */
  consecutiveFailures: z.number().int().nonnegative(),
  /** TB10: when the provider last rejected THIS key; null once it answered again. */
  rejectedAt: z.string().nullable(),
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
  /**
   * TB10: `support.ai_provider.unavailable` is open — the last chain call found no provider
   * that could answer, and none has answered since. Read from the operational log, which
   * only REPORTS it; nothing decides from this field.
   */
  chainUnavailable: z.boolean(),
});
export type SupportAiConfigResponse = z.infer<typeof supportAiConfigResponseSchema>;

/**
 * The capability test's checks, in the order they run (program §11). Each one is a separate
 * provider call, except `DECISION_SCHEMA`, which reads the `STRUCTURED_GENERATION` answer:
 *
 * - `MODEL_ACCESS` — the provider's model lookup (`GET /models/{id}`); Z.AI, which documents
 *   none, answers it with its one-token request;
 * - `STRUCTURED_GENERATION` — the SAME request Assist and Auto Reply send (adapter `generate`,
 *   `SUPPORT_AI_DECISION_JSON_SCHEMA`, the same output-token budget), over a fixed synthetic
 *   conversation that holds no customer data;
 * - `DECISION_SCHEMA` — that answer parsed STRICTLY, as an automatic reply parses it
 *   (`supportAiDecisionSchema` exactly: no note cut, no citation dropped) and held to the
 *   tenant's reply limit. The stricter of the two runtime parses is the readiness signal: a
 *   model that passes it also produces usable Assist drafts, which tolerate more;
 * - `VISION` — only when vision is on: the same request with one tiny embedded image.
 *
 * The test makes paid calls: at most one per provider key every 30 seconds, claimed by a
 * conditional write on the credential row before any call (`support_ai.test_too_soon`).
 */
export const SUPPORT_AI_TEST_CHECKS = [
  'MODEL_ACCESS',
  'STRUCTURED_GENERATION',
  'DECISION_SCHEMA',
  'VISION',
] as const;
export type SupportAiTestCheck = (typeof SUPPORT_AI_TEST_CHECKS)[number];

/**
 * - `PASS` / `FAIL`;
 * - `NOT_TESTED` — not run: the provider has no model lookup, vision is off, or an earlier
 *   check failed (a call that cannot succeed is not paid for);
 * - `UNSUPPORTED` — vision is on but this adapter declares no vision, so no image is ever sent.
 */
export const SUPPORT_AI_TEST_CHECK_RESULTS = ['PASS', 'FAIL', 'NOT_TESTED', 'UNSUPPORTED'] as const;
export type SupportAiTestCheckResult = (typeof SUPPORT_AI_TEST_CHECK_RESULTS)[number];

export const supportAiTestRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  model: modelIdSchema,
});
export type SupportAiTestRequest = z.infer<typeof supportAiTestRequestSchema>;

export const supportAiTestCheckViewSchema = z.object({
  check: z.enum(SUPPORT_AI_TEST_CHECKS),
  result: z.enum(SUPPORT_AI_TEST_CHECK_RESULTS),
  /** The provider call's outcome; null when no call was made for this check. */
  outcome: z.enum(SUPPORT_AI_OUTCOMES).nullable(),
  failureClass: z.enum(SUPPORT_AI_FAILURE_CLASSES).nullable(),
  code: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
  providerErrorCode: z.string().nullable(),
  providerErrorType: z.string().nullable(),
  providerErrorParam: z.string().nullable(),
  /** `DECISION_SCHEMA`: the first zod issue's path (`intent`, `factRefs.0`) and code. */
  issuePath: z.string().nullable(),
  issueCode: z.string().nullable(),
  latencyMs: z.number().int().nullable(),
});
export type SupportAiTestCheckView = z.infer<typeof supportAiTestCheckViewSchema>;

export const supportAiTestResponseSchema = z.object({
  /** `OK` only when every check that ran passed; otherwise the first failing check's outcome. */
  outcome: z.enum(SUPPORT_AI_OUTCOMES),
  code: z.string().nullable(),
  failureClass: z.enum(SUPPORT_AI_FAILURE_CLASSES).nullable(),
  /** The whole test, every check included. */
  latencyMs: z.number().int(),
  checks: z.array(supportAiTestCheckViewSchema),
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

export const SUPPORT_AI_TICKET_ACTIONS = ['NONE', 'CREATE', 'LINK'] as const;

/** The longest reply text a decision may carry, whatever the tenant configures. */
export const SUPPORT_AI_REPLY_MAX_CHARS = 4000;
/** The operator-only notes of a decision: stated to the model, and the parser's bounds. */
export const SUPPORT_AI_SUMMARY_MAX_CHARS = 600;
export const SUPPORT_AI_INTENT_MAX_CHARS = 120;
/** How a cited alias is spelled: `S1`, `O2`, `P3` (facts) and `K4` (knowledge). */
export const SUPPORT_AI_REF_PATTERN = /^[A-Z][0-9]{1,3}$/u;
export const SUPPORT_AI_MAX_REFS = 20;

/**
 * THE decision a model must return, validated by zod before anything reads it. Invalid output
 * sends nothing (ADR-0034 §1). `factRefs` name the payload's fact aliases (`S1`, `O2`, `P3`);
 * `knowledgeRefs` name its knowledge aliases (`K1`…, `supportContextKnowledgeSchema`). A fact
 * ref the payload did not contain is a reason to refuse the decision (TB7).
 */
export const supportAiDecisionSchema = z
  .object({
    decision: z.enum(SUPPORT_AI_DECISIONS),
    replyText: z.string().max(SUPPORT_AI_REPLY_MAX_CHARS),
    topic: z.enum(SUPPORT_AI_TOPICS),
    confidence: z.enum(SUPPORT_AI_CONFIDENCES),
    factRefs: z.array(z.string().regex(SUPPORT_AI_REF_PATTERN)).max(SUPPORT_AI_MAX_REFS),
    knowledgeRefs: z.array(z.string().regex(SUPPORT_AI_REF_PATTERN)).max(SUPPORT_AI_MAX_REFS),
    ticketAction: z.enum(SUPPORT_AI_TICKET_ACTIONS),
    /** One or two sentences for the operator: what the customer wants, in Persian. */
    summary: z.string().max(SUPPORT_AI_SUMMARY_MAX_CHARS),
    /** A short label of the customer's intent, for the operator. */
    intent: z.string().max(SUPPORT_AI_INTENT_MAX_CHARS),
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
export const SUPPORT_AI_JOB_KINDS = ['ASSIST_DRAFT', 'AUTO_DECISION'] as const;
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

// ---------------------------------------------------------------------------
// TB6 — vision (program §28, §36)
// ---------------------------------------------------------------------------

/**
 * At most this many images go with one request: the most recent ones. An older image is
 * marked unseen in the transcript, never silently dropped.
 */
export const SUPPORT_AI_VISION_MAX_IMAGES = 2;

/**
 * The largest image NEXA will fetch from Telegram for a model, enforced on the declared size,
 * the declared length and WHILE streaming. A step whose own `maxImageBytes` is lower does not
 * receive a larger image (the step is treated as unable to see it).
 */
export const SUPPORT_AI_VISION_MAX_BYTES = 5 * 1024 * 1024;

/** Each of the two Telegram legs (`getFile`, then the file) is bounded by this. */
export const SUPPORT_AI_VISION_FETCH_TIMEOUT_MS = 15_000;

/** What happened to one image in one draft's request. Telemetry only — never a byte of it. */
export const SUPPORT_AI_IMAGE_OUTCOMES = ['PROCESSED', 'SKIPPED'] as const;
export type SupportAiImageOutcome = (typeof SUPPORT_AI_IMAGE_OUTCOMES)[number];

/**
 * Why an image was not given to a model.
 *
 * - `VISION_DISABLED` — the tenant's `visionEnabled` is off; nothing was fetched.
 * - `NO_VISION_CAPABILITY` — no configured step can see it (capability, media type or size),
 *   or the step that answered could not; nothing was sent to a model.
 * - `OVER_LIMIT` — older than the `SUPPORT_AI_VISION_MAX_IMAGES` most recent images.
 * - `NO_FILE_REFERENCE` — the message holds no file reference (purged, deleted, or older than TB6).
 * - `TOO_LARGE` — larger than `SUPPORT_AI_VISION_MAX_BYTES`, declared or streamed.
 * - `UNSUPPORTED_TYPE` — its magic bytes are not JPEG, PNG or WEBP.
 * - `DOWNLOAD_FAILED` — `getFile` or the download failed, timed out, or the bot has no token.
 * - `NOT_ANSWERED` — it was ready to send, but no provider step produced an answer.
 */
export const SUPPORT_AI_IMAGE_SKIP_REASONS = [
  'VISION_DISABLED',
  'NO_VISION_CAPABILITY',
  'OVER_LIMIT',
  'NO_FILE_REFERENCE',
  'TOO_LARGE',
  'UNSUPPORTED_TYPE',
  'DOWNLOAD_FAILED',
  'NOT_ANSWERED',
] as const;
export type SupportAiImageSkipReason = (typeof SUPPORT_AI_IMAGE_SKIP_REASONS)[number];

/**
 * What an operator reads about a failed AI job: the class (`SUPPORT_AI_FAILURE_CLASSES`) and,
 * when a provider was called, the deciding attempt's safe telemetry from `support_ai_runs` —
 * never a prompt, a response or the provider's message.
 */
export const supportAiFailureDiagnosticSchema = z.object({
  failureClass: z.enum(SUPPORT_AI_FAILURE_CLASSES),
  operation: z.enum(SUPPORT_AI_OPERATIONS).nullable(),
  provider: z.enum(SUPPORT_AI_PROVIDERS).nullable(),
  model: z.string().nullable(),
  /** 0 is the primary; 1 and 2 the fallbacks. */
  attemptIndex: z.number().int().nullable(),
  outcome: z.enum(SUPPORT_AI_OUTCOMES).nullable(),
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
export type SupportAiFailureDiagnostic = z.infer<typeof supportAiFailureDiagnosticSchema>;

export const supportAiDraftViewSchema = z.object({
  id: z.string(),
  state: z.enum(SUPPORT_AI_JOB_STATES),
  createdAt: z.string(),
  readyAt: z.string().nullable(),
  failureCode: z.string().nullable(),
  /** Why a FAILED draft failed, when the AI was the reason; null otherwise. */
  failure: supportAiFailureDiagnosticSchema.nullable(),
  decision: z.enum(SUPPORT_AI_DECISIONS).nullable(),
  topic: z.enum(SUPPORT_AI_TOPICS).nullable(),
  confidence: z.enum(SUPPORT_AI_CONFIDENCES).nullable(),
  summary: z.string().nullable(),
  intent: z.string().nullable(),
  suggestedReply: z.string().nullable(),
  /**
   * The suggested reply is longer than the tenant's `maxOutputChars`. An Assist draft is
   * SHOWN with a warning rather than failed — a person edits it before sending, and the send is
   * held to the ordinary outbound limit. An automatic reply over the limit never sends.
   */
  replyOverLimit: z.boolean(),
  ticketAction: z.enum(SUPPORT_AI_TICKET_ACTIONS).nullable(),
  /** Payload aliases the model cited, resolved server-side to short human labels. */
  factLabels: z.array(z.string()),
  provider: z.enum(SUPPORT_AI_PROVIDERS).nullable(),
  model: z.string().nullable(),
  /** TB6: images the answering model was actually given (at most `SUPPORT_AI_VISION_MAX_IMAGES`). */
  imagesSeen: z.number().int().min(0),
  /** TB6: images in the bounded transcript the model did NOT see, each marked as unseen. */
  imagesUnseen: z.number().int().min(0),
  /**
   * TB6: set when the customer's LATEST message is an image nobody could process. The draft is
   * then a HANDOFF produced without asking any model (fail closed), and this says why.
   */
  unseenImageHandoff: z.enum(SUPPORT_AI_IMAGE_SKIP_REASONS).nullable(),
});
export type SupportAiDraftView = z.infer<typeof supportAiDraftViewSchema>;

export const supportAiDraftRequestSchema = z.object({ idempotencyKey: idempotencyKeySchema });
export const supportAiDraftSendRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  /** The text the operator actually sends — the draft, edited or not. */
  text: z.string().trim().min(1).max(4096),
});

export const SUPPORT_AI_ASSIST_ROUTES = {
  drafts: (conversationId: string) =>
    `/business-chats/${encodeURIComponent(conversationId)}/drafts`,
  draft: (draftId: string) => `/support-ai/drafts/${encodeURIComponent(draftId)}`,
  send: (draftId: string) => `/support-ai/drafts/${encodeURIComponent(draftId)}/send`,
  discard: (draftId: string) => `/support-ai/drafts/${encodeURIComponent(draftId)}/discard`,
} as const;

/**
 * TB7 — the deterministic guards an automatic reply must pass, each named so its failure is
 * a telemetry code (`guard_<name>`) and a typed handoff reason. EVERY failure hands off: a
 * guard that merely means "not on the allowlist" fails closed too.
 */
export const SUPPORT_AI_AUTO_GUARDS = [
  'content',
  'customer_blocked',
  'consecutive',
  'window',
  'decision',
  'handoff_topic',
  'human_requested',
  'topic_allowlist',
  'identity',
  'account_review',
  'confidence',
  'reply_bounds',
  'grounding',
] as const;
export type SupportAiAutoGuard = (typeof SUPPORT_AI_AUTO_GUARDS)[number];

/**
 * TB7 — what became of one automatic job (telemetry; a closed set pinned by a CHECK).
 *
 * - `sent` — a lane row was enqueued under the captured epoch (TB2's final check still rules).
 * - `dropped_*` — nothing done and nobody handed off: the mode left AUTO, the conversation's
 *   epoch or state moved (a person intervened), a newer inbound message replaced the job, the
 *   connection cannot send, or the tenant stopped.
 * - `guard_*` — a deterministic guard failed; the conversation was handed off.
 * - `handoff_*` — the model asked for a person, or produced nothing usable; `handoff_stale`,
 *   the job came too late to answer automatically (`SUPPORT_AI_AUTO_STALE_SECONDS`).
 * - `dropped_scope` is no longer written: a stopped tenant's job is left untouched (substitute
 *   review of PR #202). It stays in the set because the CHECK pins it and older rows carry it.
 */
export const SUPPORT_AI_AUTO_OUTCOMES = [
  'sent',
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
  'handoff_ai_requested',
  'handoff_output_invalid',
  'handoff_ai_unavailable',
  'handoff_stale',
] as const;
export type SupportAiAutoOutcome = (typeof SUPPORT_AI_AUTO_OUTCOMES)[number];

/** Drafts and their AI text are purged with the transcript (ADR-0033 §8). */
export const SUPPORT_AI_DRAFT_RETENTION_DAYS = 30;

/**
 * A QUEUED draft with no live lease, this long after it was requested, is FAILED with
 * `job.unclaimed` (TB5 review, finding 6). With the `assistant` role down nothing claims a job,
 * and without a bound the operator's screen waits for ever with re-request disabled. The
 * server decides (the request, the listing and the assistant's own pass all apply it); the
 * web uses the same number to bound its polling.
 */
export const SUPPORT_AI_DRAFT_UNCLAIMED_SECONDS = 300;
