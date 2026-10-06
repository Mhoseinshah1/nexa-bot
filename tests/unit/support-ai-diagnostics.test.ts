import { describe, expect, it, vi } from 'vitest';
import {
  SUPPORT_AI_DECISION_JSON_SCHEMA,
  SUPPORT_AI_FAILURE_CLASSES,
  safeProviderToken,
  supportAiFailureDetailOf,
  type SupportAiOutcome,
} from '@nexa/contracts';
import { AnthropicAdapter } from '../../apps/api/src/infrastructure/ai/anthropic-adapter';
import { OpenAiAdapter } from '../../apps/api/src/infrastructure/ai/openai-adapter';
import { ZaiAdapter } from '../../apps/api/src/infrastructure/ai/zai-adapter';
import { outputTokenBudget } from '../../apps/api/src/infrastructure/ai/ai-http';
import { capabilityTestRequest } from '../../apps/api/src/modules/control/support-ai/application/capability-test';
import { decisionOutputTokens } from '../../apps/api/src/modules/control/support-ai/domain/decision';

/**
 * Program §A3 and §12 — every failed provider call is classified into a closed set, with the
 * provider's own machine identifiers kept and its prose dropped. Driven by REAL-SHAPED bodies:
 * the shapes the providers document for these errors, not shapes this repository invented to
 * agree with its own adapter (CLAUDE.md, the real-panel lesson). The opt-in acceptance run
 * against a real key corrects them in the same commit if they differ (`OQ-TB-20`).
 */

const KEY = 'sk-test-0123456789';
const credential = { apiKey: KEY, region: null } as const;
const config = { toneInstructions: '', maxOutputChars: 1_200, timeoutMs: 5_000 };
const request = capabilityTestRequest(config, 'model-x', false);

function answering(status: number, body: unknown) {
  return vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

const openAi = (status: number, body: unknown) => {
  const fetch = answering(status, body);
  return { fetch, adapter: new OpenAiAdapter({ fetch, now: () => 0 }) };
};

describe('OpenAI failures, classified from real-shaped bodies', () => {
  // The field failure's leading suspect: a model that can be listed but rejects strict
  // structured output. Before this, the class and the provider's param were dropped and the
  // operator saw only «خروجی هوش مصنوعی معتبر نبود».
  it('a 400 naming response_format is unsupported_capability, with type and param kept', async () => {
    const { adapter } = openAi(400, {
      error: {
        message:
          "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.",
        type: 'invalid_request_error',
        param: 'response_format',
        code: null,
      },
    });
    const outcome = await adapter.generate(credential, request);
    expect(outcome).toMatchObject({ outcome: 'INVALID_OUTPUT', code: 'openai.http_400' });
    expect(supportAiFailureDetailOf(outcome)).toEqual({
      failureClass: 'unsupported_capability',
      httpStatus: 400,
      providerErrorCode: null,
      providerErrorType: 'invalid_request_error',
      providerErrorParam: 'response_format',
    });
    // The provider's message is prose and may quote the request: it is never carried.
    expect(JSON.stringify(outcome)).not.toContain('not supported with this model');
  });

  it('an unsupported system role is unsupported_capability (code unsupported_value)', async () => {
    const { adapter } = openAi(400, {
      error: {
        message: "Unsupported value: 'messages[0].role' does not support 'system' with this model.",
        type: 'invalid_request_error',
        param: 'messages[0].role',
        code: 'unsupported_value',
      },
    });
    expect(supportAiFailureDetailOf(await adapter.generate(credential, request))).toMatchObject({
      failureClass: 'unsupported_capability',
      providerErrorCode: 'unsupported_value',
      providerErrorParam: 'messages[0].role',
    });
  });

  it('an unknown model id is request_rejected with its code', async () => {
    const { adapter } = openAi(404, {
      error: {
        message: 'The model `x` does not exist or you do not have access to it.',
        type: 'invalid_request_error',
        param: null,
        code: 'model_not_found',
      },
    });
    expect(supportAiFailureDetailOf(await adapter.generate(credential, request))).toEqual({
      failureClass: 'request_rejected',
      httpStatus: 404,
      providerErrorCode: 'model_not_found',
      providerErrorType: 'invalid_request_error',
      providerErrorParam: null,
    });
  });

  // A reasoning model that spent the output budget thinking: `finish_reason: length`, the
  // reasoning tokens in `completion_tokens_details`, and no complete answer.
  it('finish_reason length with reasoning usage is truncated, with the tokens recorded', async () => {
    const { adapter } = openAi(200, {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      model: 'model-x-2026-01-01',
      choices: [
        {
          index: 0,
          finish_reason: 'length',
          message: { role: 'assistant', content: '', refusal: null },
        },
      ],
      usage: {
        prompt_tokens: 2_310,
        completion_tokens: 8_096,
        total_tokens: 10_406,
        completion_tokens_details: { reasoning_tokens: 8_096 },
      },
    });
    const outcome = await adapter.generate(credential, request);
    expect(outcome).toMatchObject({
      outcome: 'INVALID_OUTPUT',
      code: 'openai.truncated',
      usage: { inputTokens: 2_310, outputTokens: 8_096 },
      detail: { failureClass: 'truncated', httpStatus: 200 },
    });
  });

  it.each([
    [401, { error: { type: 'invalid_request_error', code: 'invalid_api_key' } }, 'auth'],
    [429, { error: { type: 'insufficient_quota', code: 'insufficient_quota' } }, 'quota'],
    [429, { error: { type: 'requests', code: 'rate_limit_exceeded' } }, 'rate_limited'],
    [500, { error: { type: 'server_error' } }, 'provider_error'],
    [422, { error: { type: 'invalid_request_error' } }, 'request_rejected'],
  ] as const)('HTTP %i is %s', async (status, body, failureClass) => {
    const { adapter } = openAi(status, body);
    expect(supportAiFailureDetailOf(await adapter.generate(credential, request))).toMatchObject({
      failureClass,
      httpStatus: status,
    });
  });

  it.each([
    [{ finish_reason: 'stop', message: { content: null, refusal: 'I can’t help.' } }, 'refused'],
    [{ finish_reason: 'content_filter', message: { content: '' } }, 'refused'],
    [{ finish_reason: 'stop', message: { content: '   ' } }, 'no_content'],
    [{ finish_reason: 'stop', message: {} }, 'no_content'],
    [{ finish_reason: 'stop', message: { content: 'Sure! Here you go.' } }, 'not_json'],
    [{ finish_reason: 'stop', message: { content: '[1,2]' } }, 'not_json'],
  ] as const)('a 200 choice %j is %s', async (choice, failureClass) => {
    const { adapter } = openAi(200, { model: 'm', choices: [choice] });
    expect(supportAiFailureDetailOf(await adapter.generate(credential, request))).toMatchObject({
      failureClass,
    });
  });

  it('a timeout, a network failure and a proxy page are timeout, network, network', async () => {
    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const slow = await new OpenAiAdapter({ fetch: hanging as never }).generate(credential, {
      ...request,
      timeoutMs: 10,
    });
    expect(supportAiFailureDetailOf(slow)?.failureClass).toBe('timeout');
    const down = await new OpenAiAdapter({
      fetch: vi.fn(async () => {
        throw new TypeError('fetch failed');
      }) as never,
    }).generate(credential, request);
    expect(supportAiFailureDetailOf(down)?.failureClass).toBe('network');
    const portal = await new OpenAiAdapter({
      fetch: vi.fn(async () => new Response('<html>portal</html>', { status: 200 })) as never,
    }).generate(credential, request);
    expect(supportAiFailureDetailOf(portal)).toMatchObject({
      failureClass: 'network',
      httpStatus: 200,
    });
  });
});

describe('Anthropic and Z.AI failures, the same classes', () => {
  it('Anthropic: a 400 invalid_request_error is request_rejected with its type', async () => {
    const fetch = answering(400, {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'max_tokens: 16000 > 8192, which is the maximum',
      },
    });
    const outcome = await new AnthropicAdapter({ fetch }).generate(credential, request);
    expect(supportAiFailureDetailOf(outcome)).toEqual({
      failureClass: 'request_rejected',
      httpStatus: 400,
      providerErrorCode: null,
      providerErrorType: 'invalid_request_error',
      providerErrorParam: null,
    });
    expect(JSON.stringify(outcome)).not.toContain('maximum');
  });

  it.each([
    [{ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"de' }] }, 'truncated'],
    [{ stop_reason: 'refusal', content: [] }, 'refused'],
    [{ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'x' }] }, 'no_content'],
    [{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] }, 'not_json'],
  ] as const)('Anthropic: a 200 %j is %s', async (body, failureClass) => {
    const fetch = answering(200, { model: 'm', usage: {}, ...body });
    const outcome = await new AnthropicAdapter({ fetch }).generate(credential, request);
    expect(supportAiFailureDetailOf(outcome)?.failureClass).toBe(failureClass);
  });

  it.each([
    [402, { type: 'error', error: { type: 'billing_error' } }, 'quota'],
    [401, { type: 'error', error: { type: 'authentication_error' } }, 'auth'],
    [429, { type: 'error', error: { type: 'rate_limit_error' } }, 'rate_limited'],
    [529, { type: 'error', error: { type: 'overloaded_error' } }, 'provider_error'],
    [504, { type: 'error', error: { type: 'timeout_error' } }, 'timeout'],
  ] as const)('Anthropic: HTTP %i is %s', async (status, body, failureClass) => {
    const fetch = answering(status, body);
    const outcome = await new AnthropicAdapter({ fetch }).generate(credential, request);
    expect(supportAiFailureDetailOf(outcome)?.failureClass).toBe(failureClass);
  });

  it.each([
    [400, { error: { code: '1301', message: 'unsafe' } }, 'refused'],
    [429, { error: { code: '1113', message: 'Insufficient balance' } }, 'quota'],
    [400, { error: { code: '1214', message: 'bad param' } }, 'request_rejected'],
  ] as const)('Z.AI: HTTP %i with business code is %s', async (status, body, failureClass) => {
    const fetch = answering(status, body);
    const outcome = await new ZaiAdapter({ fetch }).generate(credential, request);
    expect(supportAiFailureDetailOf(outcome)).toMatchObject({
      failureClass,
      httpStatus: status,
      providerErrorCode: body.error.code,
    });
  });
});

describe('what may be stored about a provider error', () => {
  it('keeps short machine tokens and drops prose, keys and unbounded text', () => {
    expect(safeProviderToken('invalid_request_error')).toBe('invalid_request_error');
    expect(safeProviderToken('messages[0].role')).toBe('messages[0].role');
    expect(safeProviderToken(1113)).toBe('1113');
    expect(safeProviderToken('The model does not exist')).toBeNull();
    expect(safeProviderToken('x'.repeat(65))).toBeNull();
    expect(safeProviderToken('سلام')).toBeNull();
    expect(safeProviderToken(null)).toBeNull();
    expect(safeProviderToken({ a: 1 })).toBeNull();
  });

  it('derives a class for an outcome no adapter detailed, from its kind and code', () => {
    const cases: [SupportAiOutcome, string][] = [
      [{ outcome: 'TIMEOUT' }, 'timeout'],
      [{ outcome: 'RATE_LIMITED', retryAfterMs: null, code: 'x' }, 'rate_limited'],
      [{ outcome: 'AUTH_FAILED', quota: true, code: 'x' }, 'quota'],
      [{ outcome: 'AUTH_FAILED', quota: false, code: 'x' }, 'auth'],
      [{ outcome: 'REFUSED_BY_PROVIDER', code: 'x' }, 'refused'],
      [{ outcome: 'TEMPORARY', code: 'openai.http_503' }, 'provider_error'],
      [{ outcome: 'TEMPORARY', code: 'support_ai.no_usable_provider' }, 'network'],
      [{ outcome: 'INVALID_OUTPUT', code: 'p.truncated' }, 'truncated'],
      [{ outcome: 'INVALID_OUTPUT', code: 'decision.schema_invalid' }, 'schema_invalid'],
      [{ outcome: 'INVALID_OUTPUT', code: 'p.http_400' }, 'request_rejected'],
    ];
    for (const [outcome, failureClass] of cases) {
      expect(supportAiFailureDetailOf(outcome)?.failureClass, JSON.stringify(outcome)).toBe(
        failureClass,
      );
      expect(SUPPORT_AI_FAILURE_CLASSES).toContain(failureClass);
    }
    expect(
      supportAiFailureDetailOf({
        outcome: 'OK',
        output: {},
        usage: { inputTokens: null, outputTokens: null },
        model: 'm',
      }),
    ).toBeNull();
  });
});

/**
 * Program §A4 — the exact request body each adapter sends for a decision. A fixture written
 * out in full, so a change to what reaches a provider is a visible diff here.
 */
describe('the exact request body each adapter sends for a decision', () => {
  const budget = outputTokenBudget(decisionOutputTokens(1_200));

  async function bodyOf(
    make: (fetch: ReturnType<typeof answering>) => {
      generate: OpenAiAdapter['generate'];
    },
  ): Promise<{ url: string; body: Record<string, unknown> }> {
    const fetch = answering(500, {});
    await make(fetch).generate(credential, request);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
  }

  it('OpenAI: chat completions, strict json_schema with the decision schema, max_completion_tokens', async () => {
    const { url, body } = await bodyOf((fetch) => new OpenAiAdapter({ fetch }));
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(body).toEqual({
      model: 'model-x',
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: 'سلام، سرویس من وصل نمیشه.' },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'support_decision',
          schema: SUPPORT_AI_DECISION_JSON_SCHEMA,
          strict: true,
        },
      },
      max_completion_tokens: budget,
    });
  });

  it('Anthropic: messages, output_config json_schema with the decision schema, max_tokens', async () => {
    const { url, body } = await bodyOf((fetch) => new AnthropicAdapter({ fetch }));
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(body).toEqual({
      model: 'model-x',
      max_tokens: budget,
      system: request.system,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'سلام، سرویس من وصل نمیشه.' }] }],
      output_config: { format: { type: 'json_schema', schema: SUPPORT_AI_DECISION_JSON_SCHEMA } },
    });
  });

  it('Z.AI: json_object, the decision schema stated in the system prompt, thinking off, max_tokens', async () => {
    const { url, body } = await bodyOf((fetch) => new ZaiAdapter({ fetch }));
    expect(url).toBe('https://api.z.ai/api/paas/v4/chat/completions');
    expect(body).toEqual({
      model: 'model-x',
      messages: [
        {
          role: 'system',
          content: `${request.system}\n\nReply with ONE JSON object and nothing else. It must satisfy this JSON Schema:\n${JSON.stringify(SUPPORT_AI_DECISION_JSON_SCHEMA)}`,
        },
        { role: 'user', content: 'سلام، سرویس من وصل نمیشه.' },
      ],
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
      max_tokens: budget,
    });
  });

  it('the capability test carries no customer data and the runtime schema', () => {
    expect(request.jsonSchema).toBe(SUPPORT_AI_DECISION_JSON_SCHEMA);
    expect(request.schemaName).toBe('support_decision');
    expect(request.maxOutputTokens).toBe(decisionOutputTokens(1_200));
    expect(request.system).toContain('"alias":"K1"');
    expect(request.system).toContain('"customer":null');
    const seeing = capabilityTestRequest(config, 'model-x', true);
    expect(seeing.messages[0]?.images?.[0]?.mediaType).toBe('image/png');
    expect(
      Buffer.from(seeing.messages[0]?.images?.[0]?.base64 ?? '', 'base64').length,
    ).toBeLessThan(200);
  });
});
