import { describe, expect, it, vi } from 'vitest';
import type { SupportAiOutcomeKind } from '@nexa/contracts';
import { AnthropicAdapter } from '../../apps/api/src/infrastructure/ai/anthropic-adapter';
import { OpenAiAdapter } from '../../apps/api/src/infrastructure/ai/openai-adapter';
import { ZaiAdapter, ZAI_BASE_URLS } from '../../apps/api/src/infrastructure/ai/zai-adapter';
import {
  AI_OUTPUT_TOKEN_BUDGET_MAX,
  AI_OUTPUT_TOKEN_HEADROOM,
  AI_RESPONSE_MAX_BYTES,
  aiHttpRequest,
  outputTokenBudget,
  retryAfterMsOf,
} from '../../apps/api/src/infrastructure/ai/ai-http';
import { withinTransaction } from '../../apps/api/src/infrastructure/transaction-boundary';
import type {
  SupportAiAdapter,
  SupportAiRequest,
} from '../../apps/api/src/modules/control/support-ai/application/ports';

/**
 * TB4 — ONE contract suite every provider adapter must pass (ADR-0034 §2).
 *
 * Each adapter is driven by recorded wire shapes (from the TB4 audit of each provider's
 * official API reference, SDK types or OpenAPI spec). Normal CI never calls a provider. The
 * shapes are what the adapter promises to read; per the real-panel lesson in CLAUDE.md, an
 * opt-in acceptance run against the real API corrects them in the same commit (`OQ-TB-20`).
 */

type Fixture = { status: number; body: unknown; headers?: Record<string, string> };

interface Wire {
  readonly ok: (json: unknown) => Fixture;
  readonly refusal: Fixture;
  readonly truncated: Fixture;
  /** Truncated, yet the text that did arrive PARSES: only the stop reason says it is cut. */
  readonly truncatedParseable: Fixture;
  readonly notJson: Fixture;
  readonly authFailed: Fixture;
  readonly quota: Fixture;
  readonly rateLimited: Fixture;
  readonly overloaded: Fixture;
}

const decision = { decision: 'REPLY', text: 'سلام' };

const openAiWire: Wire = {
  ok: (json) => ({
    status: 200,
    body: {
      model: 'gpt-5.5-2026-08-01',
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify(json), refusal: null },
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    },
  }),
  refusal: {
    status: 200,
    body: {
      model: 'm',
      choices: [
        { finish_reason: 'stop', message: { content: null, refusal: 'I can’t help with that.' } },
      ],
    },
  },
  truncated: {
    status: 200,
    body: {
      model: 'm',
      choices: [
        { finish_reason: 'length', message: { content: '{"decision":"RE', refusal: null } },
      ],
    },
  },
  truncatedParseable: {
    status: 200,
    body: {
      model: 'm',
      choices: [
        {
          finish_reason: 'length',
          message: { content: '{"decision":"REPLY","text":"سل"}', refusal: null },
        },
      ],
    },
  },
  notJson: {
    status: 200,
    body: {
      model: 'm',
      choices: [
        {
          finish_reason: 'stop',
          message: { content: 'Sure! Here is your answer.', refusal: null },
        },
      ],
    },
  },
  authFailed: {
    status: 401,
    body: {
      error: {
        message: 'Incorrect API key provided',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    },
  },
  quota: {
    status: 429,
    body: {
      error: {
        message: 'You exceeded your current quota',
        type: 'insufficient_quota',
        code: 'insufficient_quota',
      },
    },
  },
  rateLimited: {
    status: 429,
    body: {
      error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' },
    },
    headers: { 'retry-after-ms': '1500' },
  },
  overloaded: { status: 503, body: { error: { message: 'overloaded', type: 'server_error' } } },
};

const anthropicWire: Wire = {
  ok: (json) => ({
    status: 200,
    body: {
      model: 'claude-sonnet-5-5',
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'hidden' },
        { type: 'text', text: JSON.stringify(json) },
      ],
      usage: { input_tokens: 200, output_tokens: 40 },
    },
  }),
  refusal: {
    status: 200,
    body: { model: 'm', stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] },
  },
  truncated: {
    status: 200,
    body: {
      model: 'm',
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{"decision"' }],
    },
  },
  truncatedParseable: {
    status: 200,
    body: {
      model: 'm',
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{"decision":"REPLY","text":"سل"}' }],
    },
  },
  notJson: {
    status: 200,
    body: { model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] },
  },
  authFailed: {
    status: 401,
    body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
  },
  quota: {
    status: 402,
    body: { type: 'error', error: { type: 'billing_error', message: 'credit balance too low' } },
  },
  rateLimited: {
    status: 429,
    body: { type: 'error', error: { type: 'rate_limit_error', message: 'rate' } },
    headers: { 'retry-after': '7' },
  },
  overloaded: {
    status: 529,
    body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
  },
};

const zaiWire: Wire = {
  ok: (json) => ({
    status: 200,
    body: {
      model: 'glm-5.2',
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: '```json\n' + JSON.stringify(json) + '\n```' },
        },
      ],
      usage: { prompt_tokens: 90, completion_tokens: 20, total_tokens: 110 },
      request_id: 'r',
    },
  }),
  refusal: {
    status: 200,
    body: { model: 'm', choices: [{ finish_reason: 'sensitive', message: { content: '' } }] },
  },
  truncated: {
    status: 200,
    body: { model: 'm', choices: [{ finish_reason: 'length', message: { content: '{"de' } }] },
  },
  truncatedParseable: {
    status: 200,
    body: {
      model: 'm',
      choices: [
        { finish_reason: 'length', message: { content: '{"decision":"REPLY","text":"سل"}' } },
      ],
    },
  },
  notJson: {
    status: 200,
    body: { model: 'm', choices: [{ finish_reason: 'stop', message: { content: 'hello' } }] },
  },
  authFailed: { status: 401, body: { error: { code: '1000', message: 'Authentication failed' } } },
  quota: { status: 429, body: { error: { code: '1113', message: 'Insufficient balance' } } },
  rateLimited: {
    status: 429,
    body: { error: { code: '1302', message: 'Rate limit' } },
    headers: { 'retry-after': '2' },
  },
  overloaded: { status: 503, body: { error: { code: '500', message: 'busy' } } },
};

const request: Omit<SupportAiRequest, 'model' | 'timeoutMs'> = {
  system: 'You are NEXA support.',
  messages: [{ role: 'user', text: 'اینترنت وصل نمی‌شود' }],
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['decision', 'text'],
    properties: { decision: { type: 'string' }, text: { type: 'string' } },
  },
  schemaName: 'support_decision',
  maxOutputTokens: 400,
};

const KEY = 'sk-test-0123456789';

function fetchAnswering(fixture: Fixture) {
  return vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(typeof fixture.body === 'string' ? fixture.body : JSON.stringify(fixture.body), {
        status: fixture.status,
        headers: { 'content-type': 'application/json', ...(fixture.headers ?? {}) },
      }),
  );
}

const suites: {
  name: string;
  wire: Wire;
  make: (fetch: ReturnType<typeof fetchAnswering>) => SupportAiAdapter;
}[] = [
  { name: 'OpenAI', wire: openAiWire, make: (fetch) => new OpenAiAdapter({ fetch, now: () => 0 }) },
  {
    name: 'Anthropic',
    wire: anthropicWire,
    make: (fetch) => new AnthropicAdapter({ fetch, now: () => 0 }),
  },
  { name: 'Z.AI', wire: zaiWire, make: (fetch) => new ZaiAdapter({ fetch, now: () => 0 }) },
];

describe.each(suites)('the $name adapter honours the provider contract', ({ wire, make }) => {
  async function run(fixture: Fixture) {
    const fetch = fetchAnswering(fixture);
    const adapter = make(fetch);
    const outcome = await adapter.generate(
      { apiKey: KEY, region: null },
      { ...request, model: 'model-x', timeoutMs: 5000 },
    );
    return { outcome, fetch };
  }

  it('returns the parsed decision and the token usage on success', async () => {
    const { outcome } = await run(wire.ok(decision));
    expect(outcome).toMatchObject({ outcome: 'OK', output: decision });
    if (outcome.outcome === 'OK') {
      expect(outcome.usage.inputTokens).toBeGreaterThan(0);
      expect(outcome.usage.outputTokens).toBeGreaterThan(0);
    }
  });

  it.each([
    ['refusal', 'REFUSED_BY_PROVIDER'],
    ['truncated', 'INVALID_OUTPUT'],
    ['truncatedParseable', 'INVALID_OUTPUT'],
    ['notJson', 'INVALID_OUTPUT'],
    ['overloaded', 'TEMPORARY'],
  ] as const)('maps %s to %s', async (fixture, expected: SupportAiOutcomeKind) => {
    expect((await run(wire[fixture])).outcome.outcome).toBe(expected);
  });

  it('maps a rejected key to AUTH_FAILED, not a quota problem', async () => {
    expect((await run(wire.authFailed)).outcome).toMatchObject({
      outcome: 'AUTH_FAILED',
      quota: false,
    });
  });

  // Never a rate limit: retrying an empty balance is useless, and it is the operator's to fix.
  it('maps quota or billing exhaustion to AUTH_FAILED with quota, never RATE_LIMITED', async () => {
    expect((await run(wire.quota)).outcome).toMatchObject({ outcome: 'AUTH_FAILED', quota: true });
  });

  it('maps a 429 to RATE_LIMITED with the provider’s own wait', async () => {
    const { outcome } = await run(wire.rateLimited);
    expect(outcome.outcome).toBe('RATE_LIMITED');
    if (outcome.outcome === 'RATE_LIMITED') expect(outcome.retryAfterMs).toBeGreaterThan(0);
  });

  it('reports a request that never answered as TIMEOUT, and a network failure as TEMPORARY', async () => {
    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const slow = await make(hanging as never).generate(
      { apiKey: KEY, region: null },
      { ...request, model: 'm', timeoutMs: 20 },
    );
    expect(slow.outcome).toBe('TIMEOUT');
    const broken = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const down = await make(broken as never).generate(
      { apiKey: KEY, region: null },
      { ...request, model: 'm', timeoutMs: 1000 },
    );
    expect(down.outcome).toBe('TEMPORARY');
  });

  // Substitute review of PR #199: a proxy's HTML page on a 200 is not the provider answering.
  it('reads a 200 whose body is not JSON as TEMPORARY, never INVALID_OUTPUT', async () => {
    const { outcome } = await run({ status: 200, body: '<html><body>Gateway</body></html>' });
    expect(outcome).toMatchObject({ outcome: 'TEMPORARY' });
  });

  it('never calls a connection test that met a non-JSON 200 a success', async () => {
    const fetch = fetchAnswering({ status: 200, body: '<html>captive portal</html>' });
    const outcome = await make(fetch).testConnection({ apiKey: KEY, region: null }, 'm', 1000);
    expect(outcome.outcome).toBe('TEMPORARY');
  });

  it('sends the key only in a header, never follows a redirect, and never puts the key in the URL', async () => {
    const { fetch } = await run(wire.ok(decision));
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain(KEY);
    expect(init.redirect).toBe('error');
    expect(JSON.stringify(init.headers)).toContain(KEY);
    expect(String(init.body)).not.toContain(KEY);
  });
});

describe('provider-specific wire details', () => {
  it('OpenAI asks for strict json_schema output with max_completion_tokens', async () => {
    const fetch = fetchAnswering(openAiWire.ok(decision));
    await new OpenAiAdapter({ fetch }).generate(
      { apiKey: KEY, region: null },
      { ...request, model: 'gpt', timeoutMs: 1000 },
    );
    const body = JSON.parse(
      String((fetch.mock.calls[0] as [string, RequestInit])[1].body),
    ) as Record<string, unknown>;
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { strict: true, name: 'support_decision' },
    });
    expect(body.max_completion_tokens).toBe(outputTokenBudget(400));
    expect(body).not.toHaveProperty('max_tokens');
  });

  // Finding 5: reasoning and thinking tokens share the output budget; a budget sized to the
  // reply alone truncates it, and a truncation stops the chain.
  it('gives every adapter a bounded output headroom over the requested reply', async () => {
    expect(outputTokenBudget(400)).toBe(400 + AI_OUTPUT_TOKEN_HEADROOM);
    expect(outputTokenBudget(AI_OUTPUT_TOKEN_BUDGET_MAX - 10)).toBe(AI_OUTPUT_TOKEN_BUDGET_MAX);
    expect(outputTokenBudget(AI_OUTPUT_TOKEN_BUDGET_MAX + 500)).toBe(
      AI_OUTPUT_TOKEN_BUDGET_MAX + 500,
    );
    const sent = async (
      adapter: (fetch: ReturnType<typeof fetchAnswering>) => SupportAiAdapter,
      ok: Fixture,
    ) => {
      const fetch = fetchAnswering(ok);
      await adapter(fetch).generate(
        { apiKey: KEY, region: null },
        { ...request, model: 'm', timeoutMs: 1000 },
      );
      return JSON.parse(String((fetch.mock.calls[0] as [string, RequestInit])[1].body)) as Record<
        string,
        unknown
      >;
    };
    const budget = 400 + AI_OUTPUT_TOKEN_HEADROOM;
    expect(
      (await sent((fetch) => new AnthropicAdapter({ fetch }), anthropicWire.ok(decision)))
        .max_tokens,
    ).toBe(budget);
    expect(
      (await sent((fetch) => new OpenAiAdapter({ fetch }), openAiWire.ok(decision)))
        .max_completion_tokens,
    ).toBe(budget);
    expect(
      (await sent((fetch) => new ZaiAdapter({ fetch }), zaiWire.ok(decision))).max_tokens,
    ).toBe(budget);
  });

  it('Anthropic sends output_config json_schema, the version header, and no forced tool', async () => {
    const fetch = fetchAnswering(anthropicWire.ok(decision));
    await new AnthropicAdapter({ fetch }).generate(
      { apiKey: KEY, region: null },
      { ...request, model: 'claude', timeoutMs: 1000 },
    );
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.output_config).toEqual({
      format: { type: 'json_schema', schema: request.jsonSchema },
    });
    expect(body).not.toHaveProperty('tool_choice');
    expect(init.headers).toMatchObject({ 'anthropic-version': '2023-06-01', 'x-api-key': KEY });
  });

  it('Z.AI goes to the host of the key’s region and states the schema in the prompt', async () => {
    const fetch = fetchAnswering(zaiWire.ok(decision));
    await new ZaiAdapter({ fetch }).generate(
      { apiKey: KEY, region: 'CHINA' },
      { ...request, model: 'glm', timeoutMs: 1000 },
    );
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith(ZAI_BASE_URLS.CHINA)).toBe(true);
    const body = JSON.parse(String(init.body)) as {
      response_format: unknown;
      messages: { content: string }[];
    };
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0]?.content).toContain('"required":["decision","text"]');
  });

  it('Z.AI reads its business code 1301 as a refusal', async () => {
    const fetch = fetchAnswering({
      status: 400,
      body: { error: { code: '1301', message: 'unsafe content' } },
    });
    const outcome = await new ZaiAdapter({ fetch }).generate(
      { apiKey: KEY, region: null },
      { ...request, model: 'glm', timeoutMs: 1000 },
    );
    expect(outcome.outcome).toBe('REFUSED_BY_PROVIDER');
  });

  it('reads retry-after as milliseconds, seconds, or an HTTP date — and never invents one', () => {
    expect(retryAfterMsOf(new Headers({ 'retry-after-ms': '250' }), 0)).toBe(250);
    expect(retryAfterMsOf(new Headers({ 'retry-after': '3' }), 0)).toBe(3000);
    expect(
      retryAfterMsOf(new Headers({ 'retry-after': new Date(10_000).toUTCString() }), 4_000),
    ).toBe(6000);
    expect(retryAfterMsOf(new Headers({}), 0)).toBeNull();
    expect(retryAfterMsOf(new Headers({ 'retry-after': 'soon' }), 0)).toBeNull();
  });
});

describe('the AI HTTP sink', () => {
  const get = {
    method: 'GET' as const,
    url: 'https://example.test/x',
    headers: {},
    timeoutMs: 1000,
  };

  it('refuses a body over the 1 MB cap as body_too_large, not as a timeout', async () => {
    const big = vi.fn(async () => new Response('x'.repeat(AI_RESPONSE_MAX_BYTES + 1)));
    expect(await aiHttpRequest(get, big)).toEqual({ kind: 'NETWORK', code: 'body_too_large' });
    const fits = vi.fn(async () => new Response('x'.repeat(AI_RESPONSE_MAX_BYTES)));
    expect((await aiHttpRequest(get, fits)).kind).toBe('RESPONSE');
  });

  it('labels a body that fails mid-read as a read failure, not as too large', async () => {
    const broken = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"par'));
              controller.error(new Error('connection reset'));
            },
          }),
        ),
    );
    expect(await aiHttpRequest(get, broken)).toEqual({ kind: 'NETWORK', code: 'body_read_failed' });
  });

  it('refuses to run inside a database transaction, before any request is sent', async () => {
    const fetch = vi.fn(async () => new Response('{}'));
    await expect(withinTransaction('tenant:t', () => aiHttpRequest(get, fetch))).rejects.toThrow(
      /inside a database transaction/u,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
