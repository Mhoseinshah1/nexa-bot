import { SUPPORT_AI_IMAGE_MEDIA_TYPES, type SupportAiOutcome } from '@nexa/contracts';
import type {
  SupportAiAdapter,
  SupportAiCredential,
  SupportAiRequest,
} from '../../modules/control/support-ai/application/ports.js';
import {
  aiHttpRequest,
  nonJsonSuccess,
  outputTokenBudget,
  parseJson,
  retryAfterMsOf,
  type AiFetch,
  type AiHttpResult,
} from './ai-http.js';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * TB4 — OpenAI over Chat Completions (`docs/support-agent/tb4-provider-foundation.md` §2).
 *
 * Chat Completions rather than Responses: it carries a stable `finish_reason` and an explicit
 * `message.refusal`, and Z.AI speaks the same wire, so one reading serves two adapters. The
 * output is a native `json_schema` with `strict: true`; the core validates it anyway.
 */
export class OpenAiAdapter implements SupportAiAdapter {
  readonly provider = 'OPENAI' as const;
  readonly capabilities = {
    structuredOutput: true,
    vision: true,
    maxImageBytes: 10_000_000,
    imageMediaTypes: SUPPORT_AI_IMAGE_MEDIA_TYPES,
  };

  constructor(
    private readonly options: { readonly fetch?: AiFetch; readonly now?: () => number } = {},
  ) {}

  async generate(
    credential: SupportAiCredential,
    request: SupportAiRequest,
  ): Promise<SupportAiOutcome> {
    const result = await aiHttpRequest(
      {
        method: 'POST',
        url: `${OPENAI_BASE_URL}/chat/completions`,
        headers: { authorization: `Bearer ${credential.apiKey}` },
        timeoutMs: request.timeoutMs,
        body: {
          model: request.model,
          messages: openAiMessages(request),
          response_format: {
            type: 'json_schema',
            json_schema: { name: request.schemaName, schema: request.jsonSchema, strict: true },
          },
          max_completion_tokens: outputTokenBudget(request.maxOutputTokens),
        },
      },
      this.options.fetch,
    );
    return readChatCompletion(result, this.options.now?.() ?? Date.now(), 'openai');
  }

  async testConnection(
    credential: SupportAiCredential,
    model: string,
    timeoutMs: number,
  ): Promise<SupportAiOutcome> {
    const result = await aiHttpRequest(
      {
        method: 'GET',
        url: `${OPENAI_BASE_URL}/models/${encodeURIComponent(model)}`,
        headers: { authorization: `Bearer ${credential.apiKey}` },
        timeoutMs,
      },
      this.options.fetch,
    );
    return readListing(result, this.options.now?.() ?? Date.now(), model, 'openai');
  }
}

/** OpenAI-shaped messages: Z.AI reuses this. */
export function openAiMessages(
  request: SupportAiRequest,
  system: string = request.system,
): unknown[] {
  return [
    { role: 'system', content: system },
    ...request.messages.map((message) =>
      message.images === undefined || message.images.length === 0
        ? { role: message.role, content: message.text }
        : {
            role: message.role,
            content: [
              { type: 'text', text: message.text },
              ...message.images.map((image) => ({
                type: 'image_url',
                image_url: { url: `data:${image.mediaType};base64,${image.base64}`, detail: 'low' },
              })),
            ],
          },
    ),
  ];
}

/**
 * Reads an OpenAI-compatible chat completion (OpenAI and Z.AI). The order is the contract:
 * transport, HTTP status, refusal, truncation, then JSON — a refusal arrives as a 200 and must
 * be seen before its text is parsed as a decision.
 */
export function readChatCompletion(
  result: AiHttpResult,
  nowMs: number,
  prefix: string,
): SupportAiOutcome {
  if (result.kind === 'TIMEOUT') return { outcome: 'TIMEOUT' };
  if (result.kind === 'NETWORK')
    return { outcome: 'TEMPORARY', code: `${prefix}.network.${result.code}` };
  const body = parseJson(result.body) as Record<string, unknown> | null;
  const notJson = nonJsonSuccess(result, body, prefix);
  if (notJson !== null) return notJson;
  if (result.status < 200 || result.status >= 300)
    return statusOutcome(result, body, nowMs, prefix);

  const choice = Array.isArray(body?.choices)
    ? (body.choices[0] as Record<string, unknown> | undefined)
    : undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  const usage = usageOf(body?.usage);
  const finish = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
  if (typeof message?.refusal === 'string' && message.refusal.length > 0) {
    return { outcome: 'REFUSED_BY_PROVIDER', code: `${prefix}.refusal`, usage };
  }
  if (finish === 'content_filter' || finish === 'sensitive') {
    return { outcome: 'REFUSED_BY_PROVIDER', code: `${prefix}.${finish}`, usage };
  }
  if (finish === 'network_error') return { outcome: 'TEMPORARY', code: `${prefix}.network_error` };
  if (finish === 'length' || finish === 'model_context_window_exceeded') {
    return { outcome: 'INVALID_OUTPUT', code: `${prefix}.truncated`, usage };
  }
  if (typeof message?.content !== 'string')
    return { outcome: 'INVALID_OUTPUT', code: `${prefix}.no_content`, usage };
  const output = parseJson(stripFence(message.content));
  if (output === null || typeof output !== 'object') {
    return { outcome: 'INVALID_OUTPUT', code: `${prefix}.not_json`, usage };
  }
  return {
    outcome: 'OK',
    output,
    usage,
    model: typeof body?.model === 'string' ? body.model : 'unknown',
  };
}

/** A listing or model read used as a connection test: 2xx is "the key works". */
export function readListing(
  result: AiHttpResult,
  nowMs: number,
  model: string,
  prefix: string,
): SupportAiOutcome {
  if (result.kind === 'TIMEOUT') return { outcome: 'TIMEOUT' };
  if (result.kind === 'NETWORK')
    return { outcome: 'TEMPORARY', code: `${prefix}.network.${result.code}` };
  const body = parseJson(result.body) as Record<string, unknown> | null;
  const notJson = nonJsonSuccess(result, body, prefix);
  if (notJson !== null) return notJson;
  if (result.status >= 200 && result.status < 300) {
    return { outcome: 'OK', output: {}, usage: { inputTokens: null, outputTokens: null }, model };
  }
  return statusOutcome(result, body, nowMs, prefix);
}

function statusOutcome(
  result: Extract<AiHttpResult, { kind: 'RESPONSE' }>,
  body: Record<string, unknown> | null,
  nowMs: number,
  prefix: string,
): SupportAiOutcome {
  const error = (body?.error ?? null) as Record<string, unknown> | null;
  const code =
    typeof error?.code === 'string'
      ? error.code
      : typeof error?.type === 'string'
        ? error.type
        : '';
  const status = result.status;
  // Quota and billing exhaustion is the credential's problem, never a rate limit (TB4 audit).
  if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached') {
    return { outcome: 'AUTH_FAILED', quota: true, code: `${prefix}.quota` };
  }
  if (status === 401 || status === 403)
    return { outcome: 'AUTH_FAILED', quota: false, code: `${prefix}.http_${status}` };
  if (status === 429) {
    return {
      outcome: 'RATE_LIMITED',
      retryAfterMs: retryAfterMsOf(result.headers, nowMs),
      code: `${prefix}.http_429`,
    };
  }
  if (status === 408 || status === 409 || status >= 500)
    return { outcome: 'TEMPORARY', code: `${prefix}.http_${status}` };
  // 400/404/422: a model id or request the provider will not accept. Not transient, and not
  // the model's output — it is configuration, reported as invalid output so it never falls
  // back into a second provider with the same mistake hidden.
  return { outcome: 'INVALID_OUTPUT', code: `${prefix}.http_${status}` };
}

function usageOf(raw: unknown): {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
} {
  const usage = (raw ?? {}) as Record<string, unknown>;
  const pick = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    inputTokens: pick(usage.prompt_tokens ?? usage.input_tokens),
    outputTokens: pick(usage.completion_tokens ?? usage.output_tokens),
  };
}

/** Some models wrap JSON in a ```json fence even when asked not to. */
export function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}
