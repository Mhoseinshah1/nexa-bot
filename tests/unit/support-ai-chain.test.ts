import { describe, expect, it, vi } from 'vitest';
import {
  SUPPORT_AI_CREDENTIAL_ACCEPTED_CODE,
  SUPPORT_AI_CREDENTIAL_REJECTED_CODE,
  SUPPORT_AI_DEFAULT_CONFIG,
  SUPPORT_AI_UNAVAILABLE_CODE,
  type SupportAiOutcome,
  type SupportAiProvider,
} from '@nexa/contracts';
import { SupportAiChain } from '../../apps/api/src/modules/control/support-ai/application/support-ai-chain';
import type { SupportAiAdapter } from '../../apps/api/src/modules/control/support-ai/application/ports';

/**
 * TB4 — the fallback chain (ADR-0034 §3, TB0 amendment 4).
 *
 * Fallback is for transport and availability only; an unsafe or invalid answer STOPS the
 * chain; a rejected key is reported once and closed once; a tripped provider is skipped;
 * a step with no key is never called keyless.
 */

const scope = { tenantId: 'tenant-a', botInstanceId: null } as never;
const NOW = new Date('2026-10-04T12:00:00Z');

function adapter(
  provider: SupportAiProvider,
  outcomes: SupportAiOutcome[],
): SupportAiAdapter & { calls: number } {
  const queue = [...outcomes];
  const fake = {
    provider,
    capabilities: { structuredOutput: true, vision: false, maxImageBytes: 0, imageMediaTypes: [] },
    calls: 0,
    async generate() {
      fake.calls += 1;
      return queue.shift() ?? { outcome: 'TEMPORARY' as const, code: 'exhausted-script' };
    },
    async testConnection() {
      return { outcome: 'TIMEOUT' as const };
    },
  };
  return fake;
}

const ok = (model = 'm'): SupportAiOutcome => ({
  outcome: 'OK',
  output: { decision: 'REPLY' },
  usage: { inputTokens: 1, outputTokens: 1 },
  model,
});

function chainWith(options: {
  adapters: SupportAiAdapter[];
  keys?: SupportAiProvider[];
  tripped?: SupportAiProvider[];
  rejected?: SupportAiProvider[];
  unavailableOpen?: boolean;
}) {
  const keys = new Set(options.keys ?? options.adapters.map((a) => a.provider));
  const rejected = new Set(options.rejected ?? []);
  const results: { provider: string; result: string }[] = [];
  const opsLog = { record: vi.fn(async () => ({ isNew: true, reopened: false })) };
  const runs = { record: vi.fn(async () => undefined) };
  const steps = options.adapters.map((a) => ({
    provider: a.provider,
    model: `${a.provider.toLowerCase()}-model`,
  }));
  const chain = new SupportAiChain({
    adapters: new Map(options.adapters.map((a) => [a.provider, a])),
    credentials: {
      states: async () =>
        [...keys].map((provider) => ({
          provider,
          setAt: NOW,
          region: null,
          consecutiveFailures: 0,
          trippedUntil: options.tripped?.includes(provider)
            ? new Date(NOW.getTime() + 60_000)
            : null,
          lastTestOutcome: null,
          lastTestedAt: null,
        })),
      read: async (_scope, provider) =>
        keys.has(provider) ? { apiKey: `key-${provider}`, region: null } : null,
      recordResult: async (_scope, provider, result) => {
        results.push({ provider, result });
        return null;
      },
      markRejected: async (_scope, provider) => {
        if (rejected.has(provider)) return false;
        rejected.add(provider);
        return true;
      },
      clearRejected: async (_scope, provider) => rejected.delete(provider),
    },
    configs: {
      get: async () => ({
        version: 1,
        config: {
          ...SUPPORT_AI_DEFAULT_CONFIG,
          mode: 'ASSIST_ONLY',
          primary: steps[0] ?? null,
          fallbacks: steps.slice(1),
        },
      }),
    },
    runs,
    conditions: { tenantConditionIsOpen: async () => options.unavailableOpen ?? false },
    opsLog: opsLog as never,
    clock: { now: () => NOW },
    ids: { uuid: () => 'id' } as never,
  });
  const generate = () =>
    chain.generate(scope, {
      operation: 'ASSIST_DRAFT',
      conversationId: null,
      request: { system: 's', messages: [], jsonSchema: {}, schemaName: 'x', maxOutputTokens: 10 },
    });
  const codes = () =>
    opsLog.record.mock.calls.map(
      (call) => (call as unknown as [unknown, { code: string }])[1].code,
    );
  return { generate, opsLog, runs, results, codes, rejected };
}

describe('the support AI fallback chain', () => {
  it('answers from the primary and records one telemetry row', async () => {
    const primary = adapter('OPENAI', [ok()]);
    const fallback = adapter('ANTHROPIC', [ok()]);
    const { generate, runs } = chainWith({ adapters: [primary, fallback] });
    const result = await generate();
    expect(result.outcome.outcome).toBe('OK');
    expect(result.step?.provider).toBe('OPENAI');
    expect(fallback.calls).toBe(0);
    expect(runs.record).toHaveBeenCalledOnce();
  });

  it.each([
    [{ outcome: 'TEMPORARY', code: 'x' }],
    [{ outcome: 'TIMEOUT' }],
    [{ outcome: 'RATE_LIMITED', retryAfterMs: 1000, code: 'x' }],
    [{ outcome: 'AUTH_FAILED', quota: false, code: 'x' }],
  ] as SupportAiOutcome[][])('falls back on %o', async (failure) => {
    const fallback = adapter('ANTHROPIC', [ok()]);
    const { generate } = chainWith({ adapters: [adapter('OPENAI', [failure]), fallback] });
    const result = await generate();
    expect(result.outcome.outcome).toBe('OK');
    expect(result.step?.provider).toBe('ANTHROPIC');
    expect(result.attempts).toBe(2);
  });

  // Asking another model until one agrees is laundering an unsafe answer.
  it.each([
    [{ outcome: 'INVALID_OUTPUT', code: 'not_json' }],
    [{ outcome: 'REFUSED_BY_PROVIDER', code: 'refusal' }],
  ] as SupportAiOutcome[][])('never falls back on %o', async (stop) => {
    const fallback = adapter('ANTHROPIC', [ok()]);
    const { generate } = chainWith({ adapters: [adapter('OPENAI', [stop]), fallback] });
    const result = await generate();
    expect(result.outcome.outcome).toBe(stop.outcome);
    expect(fallback.calls).toBe(0);
  });

  it('raises credential_rejected once for a rejected key, and closes it when the key works again', async () => {
    const primary = adapter('OPENAI', [
      { outcome: 'AUTH_FAILED', quota: false, code: 'x' },
      { outcome: 'AUTH_FAILED', quota: false, code: 'x' },
      ok(),
    ]);
    const fallback = adapter('ANTHROPIC', [ok(), ok()]);
    const { generate, codes } = chainWith({ adapters: [primary, fallback] });
    await generate();
    await generate();
    expect(codes().filter((code) => code === SUPPORT_AI_CREDENTIAL_REJECTED_CODE)).toHaveLength(1);
    await generate();
    expect(codes().filter((code) => code === SUPPORT_AI_CREDENTIAL_ACCEPTED_CODE)).toHaveLength(1);
  });

  it('skips a tripped provider and a provider with no key, never calling either', async () => {
    const tripped = adapter('OPENAI', [ok()]);
    const keyless = adapter('ANTHROPIC', [ok()]);
    const last = adapter('ZAI', [ok()]);
    const { generate } = chainWith({
      adapters: [tripped, keyless, last],
      keys: ['OPENAI', 'ZAI'],
      tripped: ['OPENAI'],
    });
    const result = await generate();
    expect(result.step?.provider).toBe('ZAI');
    expect(tripped.calls + keyless.calls).toBe(0);
  });

  it('counts transient failures toward the breaker and a real answer as a success', async () => {
    const { generate, results } = chainWith({
      adapters: [adapter('OPENAI', [{ outcome: 'TIMEOUT' }]), adapter('ANTHROPIC', [ok()])],
    });
    await generate();
    expect(results).toEqual([
      { provider: 'OPENAI', result: 'TRANSIENT_FAILURE' },
      { provider: 'ANTHROPIC', result: 'SUCCESS' },
    ]);
  });

  it('reports the chain unavailable when every step fails, and answers nothing', async () => {
    const { generate, codes } = chainWith({
      adapters: [
        adapter('OPENAI', [{ outcome: 'TIMEOUT' }]),
        adapter('ANTHROPIC', [{ outcome: 'TEMPORARY', code: 'x' }]),
      ],
    });
    const result = await generate();
    expect(result.exhausted).toBe('ALL_FAILED');
    expect(codes()).toContain(SUPPORT_AI_UNAVAILABLE_CODE);
  });

  it('does nothing at all when the mode is OFF', async () => {
    const primary = adapter('OPENAI', [ok()]);
    const { generate } = chainWith({ adapters: [] });
    const result = await generate();
    expect(result.exhausted).toBe('NOT_CONFIGURED');
    expect(primary.calls).toBe(0);
  });
});
