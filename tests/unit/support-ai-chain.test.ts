import { describe, expect, it, vi } from 'vitest';
import {
  SUPPORT_AI_AVAILABLE_CODE,
  SUPPORT_AI_CREDENTIAL_ACCEPTED_CODE,
  SUPPORT_AI_CREDENTIAL_REJECTED_CODE,
  SUPPORT_AI_DEFAULT_CONFIG,
  SUPPORT_AI_UNAVAILABLE_CODE,
  supportAiConfigInputSchema,
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
  /** Providers with a state row whose key is gone by the time it is read (deleted meanwhile). */
  vanished?: SupportAiProvider[];
  tripped?: SupportAiProvider[];
  /** Providers whose breaker window has PASSED: the next call must claim the probe. */
  halfOpen?: SupportAiProvider[];
  rejected?: SupportAiProvider[];
  /** Credential-alert conditions already open, by dedupe key. */
  openAlerts?: string[];
  unavailableOpen?: boolean;
}) {
  const keys = new Set(options.keys ?? options.adapters.map((a) => a.provider));
  const vanished = new Set(options.vanished ?? []);
  const rejected = new Set(options.rejected ?? []);
  const openAlerts = new Set(options.openAlerts ?? []);
  const claims: SupportAiProvider[] = [];
  const results: { provider: string; result: string }[] = [];
  // The ops log keeps conditions open and closed the way the real recorder does.
  const opsLog = {
    record: vi.fn(
      async (
        _scope: unknown,
        event: { code: string; dedupeKey?: string; recoversDedupeKey?: string },
      ) => {
        if (event.recoversDedupeKey !== undefined) openAlerts.delete(event.recoversDedupeKey);
        else if (event.dedupeKey !== undefined) openAlerts.add(event.dedupeKey);
        return { isNew: true, reopened: false };
      },
    ),
  };
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
            : options.halfOpen?.includes(provider)
              ? new Date(NOW.getTime() - 1)
              : null,
          lastTestOutcome: null,
          lastTestedAt: null,
        })),
      read: async (_scope, provider) =>
        keys.has(provider) && !vanished.has(provider)
          ? { apiKey: `key-${provider}`, region: null, keySetAt: NOW }
          : null,
      recordResult: async (_scope, provider, _keySetAt, result) => {
        results.push({ provider, result });
        return null;
      },
      markRejected: async (_scope, provider) => {
        if (rejected.has(provider)) return false;
        rejected.add(provider);
        return true;
      },
      clearRejected: async (_scope, provider) => rejected.delete(provider),
      rejection: async (_scope, provider) => (rejected.has(provider) ? 'REJECTED' : 'ACCEPTED'),
      // The first claim wins; the store's conditional UPDATE is what makes that true for real.
      claimProbe: async (_scope, provider) => {
        if (claims.includes(provider)) return false;
        claims.push(provider);
        return true;
      },
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
    conditions: {
      tenantConditionIsOpen: async () => options.unavailableOpen ?? false,
      conditionIsOpen: async (_scope, dedupeKey) => openAlerts.has(dedupeKey),
    },
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
  const events = () =>
    opsLog.record.mock.calls.map(
      (call) => (call as unknown as [unknown, { code: string; dedupeKey?: string }])[1],
    );
  return { generate, opsLog, runs, results, codes, events, rejected, claims };
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

  // Substitute review of PR #199, finding 6: the keyless skip had no test of its own — the case
  // above is skipped earlier, at the state lookup.
  it('never calls a step whose key is gone by the time it is read', async () => {
    const vanished = adapter('OPENAI', [ok()]);
    const last = adapter('ANTHROPIC', [ok()]);
    const { generate } = chainWith({ adapters: [vanished, last], vanished: ['OPENAI'] });
    const result = await generate();
    expect(vanished.calls).toBe(0);
    expect(result.step?.provider).toBe('ANTHROPIC');
  });

  // Finding 3: after the window, ONE caller probes; the rest skip as if still tripped.
  it('lets exactly one of two concurrent callers probe a provider whose window has passed', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const probed = adapter('OPENAI', [ok(), ok()]);
    const slow: SupportAiAdapter & { calls: number } = Object.assign(probed, {
      generate: async () => {
        probed.calls += 1;
        await gate;
        return ok();
      },
    });
    const { generate, claims } = chainWith({ adapters: [slow], halfOpen: ['OPENAI'] });
    const both = Promise.all([generate(), generate()]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const [first, second] = await both;
    expect(slow.calls).toBe(1);
    expect(claims).toEqual(['OPENAI']);
    expect([first.exhausted, second.exhausted]).toEqual(
      expect.arrayContaining([null, 'NO_USABLE_PROVIDER']),
    );
  });

  // Finding 4: an INVALID_OUTPUT can be an HTTP 4xx (an exhausted balance may be one); only a
  // real OK proves the key works.
  it('never clears a rejection or emits credential_accepted on INVALID_OUTPUT', async () => {
    const { generate, codes, rejected, results } = chainWith({
      adapters: [adapter('ANTHROPIC', [{ outcome: 'INVALID_OUTPUT', code: 'anthropic.http_400' }])],
      rejected: ['ANTHROPIC'],
      openAlerts: [`${SUPPORT_AI_CREDENTIAL_REJECTED_CODE}:ANTHROPIC`],
    });
    await generate();
    expect(codes()).not.toContain(SUPPORT_AI_CREDENTIAL_ACCEPTED_CODE);
    expect(rejected.has('ANTHROPIC')).toBe(true);
    // The provider answered, so its breaker still closes.
    expect(results).toEqual([{ provider: 'ANTHROPIC', result: 'SUCCESS' }]);
  });

  // Finding 8: state and alert are two writes. A lost alert is raised again by the next call.
  it('raises credential_rejected again when the key is rejected and no alert is open', async () => {
    const auth: SupportAiOutcome = { outcome: 'AUTH_FAILED', quota: false, code: 'x' };
    const healed = chainWith({ adapters: [adapter('OPENAI', [auth])], rejected: ['OPENAI'] });
    await healed.generate();
    expect(healed.codes()).toContain(SUPPORT_AI_CREDENTIAL_REJECTED_CODE);
    // …and only then: an open alert is not raised a second time.
    const open = chainWith({
      adapters: [adapter('OPENAI', [auth])],
      rejected: ['OPENAI'],
      openAlerts: [`${SUPPORT_AI_CREDENTIAL_REJECTED_CODE}:OPENAI`],
    });
    await open.generate();
    expect(open.codes()).not.toContain(SUPPORT_AI_CREDENTIAL_REJECTED_CODE);
  });

  it('closes a credential alert left open over an accepted key when the provider answers', async () => {
    const { generate, codes } = chainWith({
      adapters: [adapter('OPENAI', [ok()])],
      openAlerts: [`${SUPPORT_AI_CREDENTIAL_REJECTED_CODE}:OPENAI`],
    });
    await generate();
    expect(codes()).toContain(SUPPORT_AI_CREDENTIAL_ACCEPTED_CODE);
  });

  // Finding 6: recovery is recorded only while the unavailable condition is open, and
  // deduplicated so two concurrent successes collapse onto one row.
  it('records available only while unavailable is open, under a dedupe key', async () => {
    const closed = chainWith({ adapters: [adapter('OPENAI', [ok()])], unavailableOpen: false });
    await closed.generate();
    expect(closed.codes()).not.toContain(SUPPORT_AI_AVAILABLE_CODE);
    const open = chainWith({ adapters: [adapter('OPENAI', [ok()])], unavailableOpen: true });
    await open.generate();
    expect(open.events().filter((event) => event.code === SUPPORT_AI_AVAILABLE_CODE)).toEqual([
      expect.objectContaining({ dedupeKey: `${SUPPORT_AI_AVAILABLE_CODE}:chain` }),
    ]);
  });
});

// Substitute review of PR #199, finding 6: each fallback is an INDEPENDENT provider (TB0
// amendment 4) — a second step on the same provider is the same outage and the same key.
describe('the support AI configuration schema', () => {
  const config = (fallbacks: { provider: SupportAiProvider; model: string }[]) => ({
    ...SUPPORT_AI_DEFAULT_CONFIG,
    mode: 'ASSIST_ONLY' as const,
    primary: { provider: 'OPENAI' as const, model: 'gpt-5.5' },
    fallbacks,
  });

  it('refuses a chain that repeats a provider, and accepts distinct ones', () => {
    expect(
      supportAiConfigInputSchema.safeParse(config([{ provider: 'OPENAI', model: 'gpt-5.5-mini' }]))
        .success,
    ).toBe(false);
    expect(
      supportAiConfigInputSchema.safeParse(
        config([
          { provider: 'ANTHROPIC', model: 'claude' },
          { provider: 'ANTHROPIC', model: 'claude-2' },
        ]),
      ).success,
    ).toBe(false);
    expect(
      supportAiConfigInputSchema.safeParse(
        config([
          { provider: 'ANTHROPIC', model: 'claude' },
          { provider: 'ZAI', model: 'glm' },
        ]),
      ).success,
    ).toBe(true);
  });
});
