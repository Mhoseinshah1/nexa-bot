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
import { stripFence } from './openai-adapter.js';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * TB4 — Anthropic Claude over the Messages API.
 *
 * Structured output is `output_config.format: {type: 'json_schema'}` (GA, no beta header, per
 * the TB4 audit of platform.claude.com); the JSON arrives as a `text` block. NOT a forced tool:
 * `tool_choice` forcing is refused on the current models. A refusal is `stop_reason: refusal` on
 * a 200, checked before anything is parsed.
 */
export class AnthropicAdapter implements SupportAiAdapter {
  readonly provider = 'ANTHROPIC' as const;
  readonly capabilities = {
    structuredOutput: true,
    vision: true,
    maxImageBytes: 5_000_000,
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
        url: `${ANTHROPIC_BASE_URL}/messages`,
        headers: headersFor(credential),
        timeoutMs: request.timeoutMs,
        body: {
          model: request.model,
          max_tokens: outputTokenBudget(request.maxOutputTokens),
          system: request.system,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: [
              ...(message.images ?? []).map((image) => ({
                type: 'image',
                source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
              })),
              { type: 'text', text: message.text },
            ],
          })),
          output_config: { format: { type: 'json_schema', schema: request.jsonSchema } },
        },
      },
      this.options.fetch,
    );
    return readMessage(result, this.options.now?.() ?? Date.now());
  }

  async testConnection(
    credential: SupportAiCredential,
    model: string,
    timeoutMs: number,
  ): Promise<SupportAiOutcome> {
    const result = await aiHttpRequest(
      {
        method: 'GET',
        url: `${ANTHROPIC_BASE_URL}/models/${encodeURIComponent(model)}`,
        headers: headersFor(credential),
        timeoutMs,
      },
      this.options.fetch,
    );
    if (
      result.kind === 'RESPONSE' &&
      result.status >= 200 &&
      result.status < 300 &&
      nonJsonSuccess(result, parseJson(result.body), 'anthropic') === null
    ) {
      return { outcome: 'OK', output: {}, usage: { inputTokens: null, outputTokens: null }, model };
    }
    return readMessage(result, this.options.now?.() ?? Date.now());
  }
}

function headersFor(credential: SupportAiCredential): Record<string, string> {
  return { 'x-api-key': credential.apiKey, 'anthropic-version': ANTHROPIC_VERSION };
}

export function readMessage(result: AiHttpResult, nowMs: number): SupportAiOutcome {
  if (result.kind === 'TIMEOUT') return { outcome: 'TIMEOUT' };
  if (result.kind === 'NETWORK')
    return { outcome: 'TEMPORARY', code: `anthropic.network.${result.code}` };
  const body = parseJson(result.body) as Record<string, unknown> | null;
  const notJson = nonJsonSuccess(result, body, 'anthropic');
  if (notJson !== null) return notJson;
  const status = result.status;
  if (status < 200 || status >= 300) {
    const error = (body?.error ?? null) as Record<string, unknown> | null;
    const type = typeof error?.type === 'string' ? error.type : '';
    if (status === 402 || type === 'billing_error')
      return { outcome: 'AUTH_FAILED', quota: true, code: 'anthropic.billing' };
    if (status === 401 || status === 403)
      return { outcome: 'AUTH_FAILED', quota: false, code: `anthropic.${type || status}` };
    if (status === 429) {
      const retryAfterMs = retryAfterMsOf(result.headers, nowMs);
      return { outcome: 'RATE_LIMITED', retryAfterMs, code: 'anthropic.rate_limit' };
    }
    if (status === 504) return { outcome: 'TIMEOUT' };
    if (status === 529 || status >= 500)
      return { outcome: 'TEMPORARY', code: `anthropic.${type || status}` };
    return { outcome: 'INVALID_OUTPUT', code: `anthropic.http_${status}` };
  }
  const usage = usageOf(body?.usage);
  const stop = typeof body?.stop_reason === 'string' ? body.stop_reason : null;
  if (stop === 'refusal')
    return { outcome: 'REFUSED_BY_PROVIDER', code: 'anthropic.refusal', usage };
  if (stop === 'max_tokens' || stop === 'model_context_window_exceeded') {
    return { outcome: 'INVALID_OUTPUT', code: 'anthropic.truncated', usage };
  }
  const blocks = Array.isArray(body?.content) ? (body.content as Record<string, unknown>[]) : [];
  // Thinking blocks are skipped; only text carries the decision.
  const text = blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');
  const output = parseJson(stripFence(text));
  if (output === null || typeof output !== 'object')
    return { outcome: 'INVALID_OUTPUT', code: 'anthropic.not_json', usage };
  return {
    outcome: 'OK',
    output,
    usage,
    model: typeof body?.model === 'string' ? body.model : 'unknown',
  };
}

function usageOf(raw: unknown): {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
} {
  const usage = (raw ?? {}) as Record<string, unknown>;
  const pick = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return { inputTokens: pick(usage.input_tokens), outputTokens: pick(usage.output_tokens) };
}
