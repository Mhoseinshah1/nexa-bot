import { SUPPORT_AI_IMAGE_MEDIA_TYPES, type SupportAiOutcome } from '@nexa/contracts';
import type {
  SupportAiAdapter,
  SupportAiCredential,
  SupportAiRequest,
} from '../../modules/control/support-ai/application/ports.js';
import {
  aiHttpRequest,
  failureDetail,
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
  if (result.kind === 'TIMEOUT') return { outcome: 'TIMEOUT', detail: failureDetail('timeout') };
  if (result.kind === 'NETWORK') return networkOutcome(result.code, prefix);
  const body = parseJson(result.body) as Record<string, unknown> | null;
  const notJson = nonJsonSuccess(result, body, prefix);
  if (notJson !== null) return notJson;
  if (result.status < 200 || result.status >= 300)
    return statusOutcome(result, body, nowMs, prefix);
  const ok = { httpStatus: result.status };

  const choice = Array.isArray(body?.choices)
    ? (body.choices[0] as Record<string, unknown> | undefined)
    : undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  const usage = usageOf(body?.usage);
  const finish = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
  if (typeof message?.refusal === 'string' && message.refusal.length > 0) {
    const detail = failureDetail('refused', ok);
    return { outcome: 'REFUSED_BY_PROVIDER', code: `${prefix}.refusal`, usage, detail };
  }
  if (finish === 'content_filter' || finish === 'sensitive') {
    const detail = failureDetail('refused', ok);
    return { outcome: 'REFUSED_BY_PROVIDER', code: `${prefix}.${finish}`, usage, detail };
  }
  if (finish === 'network_error') {
    const detail = failureDetail('network', ok);
    return { outcome: 'TEMPORARY', code: `${prefix}.network_error`, detail };
  }
  if (finish === 'length' || finish === 'model_context_window_exceeded') {
    const detail = failureDetail('truncated', ok);
    return { outcome: 'INVALID_OUTPUT', code: `${prefix}.truncated`, usage, detail };
  }
  if (typeof message?.content !== 'string' || message.content.trim() === '') {
    const detail = failureDetail('no_content', ok);
    return { outcome: 'INVALID_OUTPUT', code: `${prefix}.no_content`, usage, detail };
  }
  const output = parseJson(stripFence(message.content));
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    const detail = failureDetail('not_json', ok);
    return { outcome: 'INVALID_OUTPUT', code: `${prefix}.not_json`, usage, detail };
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
  if (result.kind === 'TIMEOUT') return { outcome: 'TIMEOUT', detail: failureDetail('timeout') };
  if (result.kind === 'NETWORK') return networkOutcome(result.code, prefix);
  const body = parseJson(result.body) as Record<string, unknown> | null;
  const notJson = nonJsonSuccess(result, body, prefix);
  if (notJson !== null) return notJson;
  if (result.status >= 200 && result.status < 300) {
    return { outcome: 'OK', output: {}, usage: { inputTokens: null, outputTokens: null }, model };
  }
  return statusOutcome(result, body, nowMs, prefix);
}

/** No HTTP answer at all: a connection, DNS or body failure. Transient. */
export function networkOutcome(code: string, prefix: string): SupportAiOutcome {
  return {
    outcome: 'TEMPORARY',
    code: `${prefix}.network.${code}`,
    detail: failureDetail('network'),
  };
}

/**
 * A 400/404/422 that names the capability NEXA's request needs: strict structured output
 * (`param: response_format…`), or a parameter or value the model does not support
 * (`code: unsupported_parameter | unsupported_value` — e.g. a `system` message, or
 * `max_completion_tokens`, on a model that refuses them). Read from the provider's machine
 * fields only, never from its message.
 */
const UNSUPPORTED_CODES: ReadonlySet<string> = new Set([
  'unsupported_parameter',
  'unsupported_value',
  'unsupported_model',
]);

export function rejectionClass(
  error: Record<string, unknown> | null,
): 'unsupported_capability' | 'request_rejected' {
  const param = typeof error?.param === 'string' ? error.param : '';
  const code = typeof error?.code === 'string' ? error.code : '';
  return param.startsWith('response_format') || UNSUPPORTED_CODES.has(code)
    ? 'unsupported_capability'
    : 'request_rejected';
}

function statusOutcome(
  result: Extract<AiHttpResult, { kind: 'RESPONSE' }>,
  body: Record<string, unknown> | null,
  nowMs: number,
  prefix: string,
): SupportAiOutcome {
  const error = (
    body?.error !== null && typeof body?.error === 'object' ? body.error : null
  ) as Record<string, unknown> | null;
  const code =
    typeof error?.code === 'string'
      ? error.code
      : typeof error?.type === 'string'
        ? error.type
        : '';
  const status = result.status;
  const from = { httpStatus: status, error };
  // Quota and billing exhaustion is the credential's problem, never a rate limit (TB4 audit).
  if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached') {
    const detail = failureDetail('quota', from);
    return { outcome: 'AUTH_FAILED', quota: true, code: `${prefix}.quota`, detail };
  }
  if (status === 401 || status === 403) {
    const detail = failureDetail('auth', from);
    return { outcome: 'AUTH_FAILED', quota: false, code: `${prefix}.http_${status}`, detail };
  }
  if (status === 429) {
    return {
      outcome: 'RATE_LIMITED',
      retryAfterMs: retryAfterMsOf(result.headers, nowMs),
      code: `${prefix}.http_429`,
      detail: failureDetail('rate_limited', from),
    };
  }
  if (status === 408 || status === 409 || status >= 500) {
    const detail = failureDetail('provider_error', from);
    return { outcome: 'TEMPORARY', code: `${prefix}.http_${status}`, detail };
  }
  // 400/404/422: a model id or request the provider will not accept. Not transient, and not
  // the model's output — it is configuration, reported as invalid output so it never falls
  // back into a second provider with the same mistake hidden. The CLASS says which: the
  // request was refused, or it named a capability this model lacks.
  return {
    outcome: 'INVALID_OUTPUT',
    code: `${prefix}.http_${status}`,
    detail: failureDetail(rejectionClass(error), from),
  };
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
