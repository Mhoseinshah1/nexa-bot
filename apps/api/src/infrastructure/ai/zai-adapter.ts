import type { SupportAiOutcome } from '@nexa/contracts';
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
  type AiFetch,
} from './ai-http.js';
import { openAiMessages, readChatCompletion } from './openai-adapter.js';

/**
 * The two hosts a Z.AI key can belong to (official `zai-sdk`). A closed choice, never an
 * operator-typed URL: a free URL would be a way to send the key somewhere else.
 */
export const ZAI_BASE_URLS = {
  INTERNATIONAL: 'https://api.z.ai/api/paas/v4',
  CHINA: 'https://open.bigmodel.cn/api/paas/v4',
} as const;

/**
 * TB4 — GLM / Z.AI over its OpenAI-compatible chat completions.
 *
 * Native JSON-schema output is NOT documented (TB4 audit), so this adapter asks for
 * `json_object` and states the schema in the system prompt — ADR-0034's "ask for JSON, core
 * validates" path; `structuredOutput: false` says so. Z.AI's business codes ride inside 4xx
 * bodies: 1301 is a content refusal, 1113 an empty balance (a credential problem, never a
 * rate limit). Every Z.AI fixture is PROVISIONAL until the opt-in acceptance run against the
 * real API corrects it (`OQ-TB-20`).
 */
export class ZaiAdapter implements SupportAiAdapter {
  readonly provider = 'ZAI' as const;
  /**
   * TB6: NO vision. Z.AI's image input belongs to its separate `glm-*v` models, and whether a
   * base64 data URL is accepted, at what size, and what a text model does with an image part
   * are unconfirmed (`OQ-TB-30`, `OQ-TB-20`). A capability is declared after acceptance proves
   * it, never before (CLAUDE.md), so the chain never gives this adapter an image.
   */
  readonly capabilities = {
    structuredOutput: false,
    vision: false,
    maxImageBytes: 0,
    imageMediaTypes: [] as readonly string[],
  };

  constructor(
    private readonly options: { readonly fetch?: AiFetch; readonly now?: () => number } = {},
  ) {}

  async generate(
    credential: SupportAiCredential,
    request: SupportAiRequest,
  ): Promise<SupportAiOutcome> {
    // Defence in depth behind the chain's capability gate: an image is never sent here.
    if (request.messages.some((message) => (message.images?.length ?? 0) > 0)) {
      return { outcome: 'INVALID_OUTPUT', code: 'zai.vision_unsupported' };
    }
    const system =
      `${request.system}\n\nReply with ONE JSON object and nothing else. It must satisfy this JSON Schema:\n` +
      JSON.stringify(request.jsonSchema);
    const result = await aiHttpRequest(
      {
        method: 'POST',
        url: `${ZAI_BASE_URLS[credential.region ?? 'INTERNATIONAL']}/chat/completions`,
        headers: { authorization: `Bearer ${credential.apiKey}`, 'accept-language': 'en-US,en' },
        timeoutMs: request.timeoutMs,
        body: {
          model: request.model,
          messages: openAiMessages(request, system),
          response_format: { type: 'json_object' },
          thinking: { type: 'disabled' },
          max_tokens: outputTokenBudget(request.maxOutputTokens),
        },
      },
      this.options.fetch,
    );
    const zaiCode = businessCodeOf(result);
    if (zaiCode === '1301') return { outcome: 'REFUSED_BY_PROVIDER', code: 'zai.1301' };
    if (zaiCode === '1113') return { outcome: 'AUTH_FAILED', quota: true, code: 'zai.1113' };
    return readChatCompletion(result, this.options.now?.() ?? Date.now(), 'zai');
  }

  /**
   * No models endpoint is documented (TB4 audit), so the test is the smallest real call: one
   * token. It costs a few tokens and proves the key, the host and the model together.
   */
  async testConnection(
    credential: SupportAiCredential,
    model: string,
    timeoutMs: number,
  ): Promise<SupportAiOutcome> {
    const result = await aiHttpRequest(
      {
        method: 'POST',
        url: `${ZAI_BASE_URLS[credential.region ?? 'INTERNATIONAL']}/chat/completions`,
        headers: { authorization: `Bearer ${credential.apiKey}`, 'accept-language': 'en-US,en' },
        timeoutMs,
        body: {
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          thinking: { type: 'disabled' },
        },
      },
      this.options.fetch,
    );
    const zaiCode = businessCodeOf(result);
    if (zaiCode === '1113') return { outcome: 'AUTH_FAILED', quota: true, code: 'zai.1113' };
    if (
      result.kind === 'RESPONSE' &&
      result.status >= 200 &&
      result.status < 300 &&
      nonJsonSuccess(result, parseJson(result.body), 'zai') === null
    ) {
      return { outcome: 'OK', output: {}, usage: { inputTokens: null, outputTokens: null }, model };
    }
    return readChatCompletion(result, this.options.now?.() ?? Date.now(), 'zai');
  }
}

function businessCodeOf(result: Awaited<ReturnType<typeof aiHttpRequest>>): string | null {
  if (result.kind !== 'RESPONSE' || (result.status >= 200 && result.status < 300)) return null;
  const body = parseJson(result.body) as { error?: { code?: unknown } } | null;
  const code = body?.error?.code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : null;
}
