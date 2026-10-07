import {
  SUPPORT_AI_IMAGE_MEDIA_TYPES,
  safeProviderToken,
  type SupportAiOutcome,
} from '@nexa/contracts';
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
import { networkOutcome, rejectionClass, stripFence } from './openai-adapter.js';

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
    /**
     * TB6: Anthropic refuses an image over 5 MB, measured on the base64 payload. 3,750,000
     * raw bytes encode to exactly 5,000,000 base64 characters, so a larger image is never
     * sent here (the chain treats this step as unable to see it).
     */
    maxImageBytes: 3_750_000,
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
              // A9: no resolution or "detail" field is sent. The Messages reference this adapter
              // was audited against (TB4) documents none for an image block; the image is sent
              // as it is, within `maxImageBytes`. Whether one exists is OQ-SAI2-03, never guessed.
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
  if (result.kind === 'TIMEOUT') return { outcome: 'TIMEOUT', detail: failureDetail('timeout') };
  if (result.kind === 'NETWORK') return networkOutcome(result.code, 'anthropic');
  const body = parseJson(result.body) as Record<string, unknown> | null;
  const notJson = nonJsonSuccess(result, body, 'anthropic');
  if (notJson !== null) return notJson;
  const status = result.status;
  if (status < 200 || status >= 300) {
    const error = (
      body?.error !== null && typeof body?.error === 'object' ? body.error : null
    ) as Record<string, unknown> | null;
    // The provider's own type goes into our `code`, which is stored and shown: only as a
    // short machine token (`safeProviderToken`), never arbitrary text from the body.
    const type = safeProviderToken(error?.type) ?? '';
    const from = { httpStatus: status, error };
    if (status === 402 || type === 'billing_error') {
      const detail = failureDetail('quota', from);
      return { outcome: 'AUTH_FAILED', quota: true, code: 'anthropic.billing', detail };
    }
    if (status === 401 || status === 403) {
      const detail = failureDetail('auth', from);
      return { outcome: 'AUTH_FAILED', quota: false, code: `anthropic.${type || status}`, detail };
    }
    if (status === 429) {
      const retryAfterMs = retryAfterMsOf(result.headers, nowMs);
      const detail = failureDetail('rate_limited', from);
      return { outcome: 'RATE_LIMITED', retryAfterMs, code: 'anthropic.rate_limit', detail };
    }
    if (status === 504) return { outcome: 'TIMEOUT', detail: failureDetail('timeout', from) };
    if (status === 529 || status >= 500) {
      const detail = failureDetail('provider_error', from);
      return { outcome: 'TEMPORARY', code: `anthropic.${type || status}`, detail };
    }
    // Anthropic's errors carry a type and no param; a rejection is told apart from a missing
    // capability only where the machine fields say so.
    const detail = failureDetail(rejectionClass(error), from);
    return { outcome: 'INVALID_OUTPUT', code: `anthropic.http_${status}`, detail };
  }
  const usage = usageOf(body?.usage);
  const ok = { httpStatus: status };
  const stop = typeof body?.stop_reason === 'string' ? body.stop_reason : null;
  if (stop === 'refusal') {
    const detail = failureDetail('refused', ok);
    return { outcome: 'REFUSED_BY_PROVIDER', code: 'anthropic.refusal', usage, detail };
  }
  if (stop === 'max_tokens' || stop === 'model_context_window_exceeded') {
    const detail = failureDetail('truncated', ok);
    return { outcome: 'INVALID_OUTPUT', code: 'anthropic.truncated', usage, detail };
  }
  const blocks = Array.isArray(body?.content) ? (body.content as Record<string, unknown>[]) : [];
  // Thinking blocks are skipped; only text carries the decision.
  const text = blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');
  if (text.trim() === '') {
    const detail = failureDetail('no_content', ok);
    return { outcome: 'INVALID_OUTPUT', code: 'anthropic.no_content', usage, detail };
  }
  const output = parseJson(stripFence(text));
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    const detail = failureDetail('not_json', ok);
    return { outcome: 'INVALID_OUTPUT', code: 'anthropic.not_json', usage, detail };
  }
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
