import {
  SUPPORT_AI_AVAILABLE_CODE,
  SUPPORT_AI_CREDENTIAL_ACCEPTED_CODE,
  SUPPORT_AI_CREDENTIAL_REJECTED_CODE,
  SUPPORT_AI_UNAVAILABLE_CODE,
  supportAiOutcomeFallsBack,
  type Clock,
  type IdGenerator,
  type OperationalEventRecorder,
  type ScopeContext,
  type SupportAiOperation,
  type SupportAiOutcome,
  type SupportAiProvider,
  type SupportAiProviderStep,
} from '@nexa/contracts';
import type { SupportAiAdapter, SupportAiRequest } from './ports.js';
import type {
  DrizzleSupportAiConfigRepository,
  DrizzleSupportAiCredentialStore,
  DrizzleSupportAiRunRecorder,
} from '../infrastructure/drizzle-support-ai.repository.js';

export interface SupportAiChainDeps {
  readonly adapters: ReadonlyMap<SupportAiProvider, SupportAiAdapter>;
  readonly credentials: Pick<
    DrizzleSupportAiCredentialStore,
    'read' | 'states' | 'recordResult' | 'markRejected' | 'clearRejected'
  >;
  /** Whether the chain-unavailable condition is open, so its recovery is recorded once. */
  readonly conditions: { tenantConditionIsOpen(tenantId: string, code: string): Promise<boolean> };
  readonly configs: Pick<DrizzleSupportAiConfigRepository, 'get'>;
  readonly runs: Pick<DrizzleSupportAiRunRecorder, 'record'>;
  readonly opsLog: OperationalEventRecorder;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Wall time for latency; injectable so a test is not timing-dependent. */
  readonly nowMs?: () => number;
}

/** What one call through the chain produced. */
export interface SupportAiChainResult {
  readonly outcome: SupportAiOutcome;
  /** The step that produced it; null when no step could be attempted at all. */
  readonly step: SupportAiProviderStep | null;
  readonly attempts: number;
  /** Why the chain stopped without an answer, when it did. */
  readonly exhausted: 'NOT_CONFIGURED' | 'NO_USABLE_PROVIDER' | 'ALL_FAILED' | null;
}

/**
 * TB4 — one support-AI call through the tenant's configured chain (ADR-0034 §3).
 *
 * The rules, each a way to send an unsafe or duplicate answer that this refuses:
 *
 *   - FALLBACK only on `RATE_LIMITED`, `AUTH_FAILED`, `TEMPORARY` and `TIMEOUT`
 *     (`supportAiOutcomeFallsBack`). `INVALID_OUTPUT` and `REFUSED_BY_PROVIDER` STOP the chain
 *     — asking another model until one agrees is laundering an unsafe answer.
 *   - Each step is an independently configured provider with its OWN credential row; a step
 *     with no key is skipped, never called keyless.
 *   - `AUTH_FAILED` raises `support.ai_provider.credential_rejected`, deduplicated per tenant and
 *     provider (TB0 amendment 4), and the chain moves on; a later success of that provider
 *     closes it. A fallback that succeeds never hides a dead credential.
 *   - The BREAKER: an open provider (`tripped_until` in the future) is skipped as if it had
 *     failed transiently; the first call after the window is the half-open probe. Its state
 *     is the credential row's, never `operational_events`, which only reports it.
 *   - Nothing here sends anything to a customer. The chain returns an outcome; deciding what
 *     to do with it is the caller's.
 *   - Telemetry per attempt (provider, model, position, latency, tokens, outcome), never the
 *     prompt or the response.
 */
export class SupportAiChain {
  constructor(private readonly deps: SupportAiChainDeps) {}

  async generate(
    scope: ScopeContext,
    input: {
      readonly operation: SupportAiOperation;
      readonly conversationId: string | null;
      readonly request: Omit<SupportAiRequest, 'model' | 'timeoutMs'>;
    },
  ): Promise<SupportAiChainResult> {
    const { config } = await this.deps.configs.get(scope);
    if (config.mode === 'OFF' || config.primary === null) {
      return {
        outcome: { outcome: 'TEMPORARY', code: 'support_ai.off' },
        step: null,
        attempts: 0,
        exhausted: 'NOT_CONFIGURED',
      };
    }
    const steps = [config.primary, ...config.fallbacks];
    const states = new Map(
      (await this.deps.credentials.states(scope)).map((state) => [state.provider, state]),
    );
    const now = this.deps.clock.now();
    let attempts = 0;
    let last: SupportAiChainResult | null = null;

    for (const [index, step] of steps.entries()) {
      const adapter = this.deps.adapters.get(step.provider);
      const state = states.get(step.provider);
      if (adapter === undefined || state === undefined) continue;
      if (state.trippedUntil !== null && state.trippedUntil.getTime() > now.getTime()) continue;
      const credential = await this.deps.credentials.read(scope, step.provider);
      if (credential === null) continue;

      attempts += 1;
      const started = this.wallMs();
      const outcome = await adapter.generate(credential, {
        ...input.request,
        model: step.model,
        timeoutMs: config.timeoutMs,
      });
      await this.recordRun(scope, input, step, index, this.wallMs() - started, outcome);
      await this.observe(scope, step.provider, outcome);

      last = { outcome, step, attempts, exhausted: null };
      if (outcome.outcome === 'OK') {
        await this.recoverUnavailable(scope);
        return last;
      }
      if (!supportAiOutcomeFallsBack(outcome.outcome)) return last;
    }

    await this.deps.opsLog.record(scope, {
      code: SUPPORT_AI_UNAVAILABLE_CODE,
      severity: 'WARN',
      message:
        'No configured AI provider could answer. Support conversations hand off to a person until one can.',
      dedupeKey: `${SUPPORT_AI_UNAVAILABLE_CODE}:chain`,
      context: { attempts, lastOutcome: last?.outcome.outcome ?? null },
    });
    if (last === null) {
      return {
        outcome: { outcome: 'TEMPORARY', code: 'support_ai.no_usable_provider' },
        step: null,
        attempts: 0,
        exhausted: 'NO_USABLE_PROVIDER',
      };
    }
    return { ...last, exhausted: 'ALL_FAILED' };
  }

  /** The breaker and the credential alert, from one attempt's outcome. */
  private async observe(
    scope: ScopeContext,
    provider: SupportAiProvider,
    outcome: SupportAiOutcome,
  ): Promise<void> {
    const now = this.deps.clock.now();
    const dedupeKey = `${SUPPORT_AI_CREDENTIAL_REJECTED_CODE}:${provider}`;
    if (outcome.outcome === 'AUTH_FAILED') {
      // Raised once, on the transition into rejected; the chain moves on meanwhile.
      if (await this.deps.credentials.markRejected(scope, provider, now)) {
        await this.deps.opsLog.record(scope, {
          code: SUPPORT_AI_CREDENTIAL_REJECTED_CODE,
          severity: 'ERROR',
          message: outcome.quota
            ? 'An AI provider refused the key for lack of quota or balance. Other configured providers are used meanwhile.'
            : 'An AI provider rejected its key. Other configured providers are used meanwhile; replace the key.',
          dedupeKey,
          context: { provider, quota: outcome.quota, code: outcome.code },
        });
      }
      return;
    }
    if (
      outcome.outcome === 'OK' ||
      outcome.outcome === 'INVALID_OUTPUT' ||
      outcome.outcome === 'REFUSED_BY_PROVIDER'
    ) {
      // The provider answered with this key: the key works and the provider is up.
      await this.deps.credentials.recordResult(scope, provider, 'SUCCESS', now);
      if (await this.deps.credentials.clearRejected(scope, provider, now)) {
        await this.deps.opsLog.record(scope, {
          code: SUPPORT_AI_CREDENTIAL_ACCEPTED_CODE,
          severity: 'INFO',
          message: 'An AI provider accepted its key again.',
          recoversCode: SUPPORT_AI_CREDENTIAL_REJECTED_CODE,
          recoversDedupeKey: dedupeKey,
          context: { provider },
        });
      }
      return;
    }
    // RATE_LIMITED, TEMPORARY, TIMEOUT: transient — counted toward the breaker.
    await this.deps.credentials.recordResult(scope, provider, 'TRANSIENT_FAILURE', now);
  }

  private async recoverUnavailable(scope: ScopeContext): Promise<void> {
    const tenantId = 'tenantId' in scope ? scope.tenantId : null;
    if (
      tenantId === null ||
      !(await this.deps.conditions.tenantConditionIsOpen(tenantId, SUPPORT_AI_UNAVAILABLE_CODE))
    ) {
      return;
    }
    await this.deps.opsLog.record(scope, {
      code: SUPPORT_AI_AVAILABLE_CODE,
      severity: 'INFO',
      message: 'A configured AI provider answered again.',
      recoversCode: SUPPORT_AI_UNAVAILABLE_CODE,
      recoversDedupeKey: `${SUPPORT_AI_UNAVAILABLE_CODE}:chain`,
    });
  }

  private async recordRun(
    scope: ScopeContext,
    input: { readonly operation: SupportAiOperation; readonly conversationId: string | null },
    step: SupportAiProviderStep,
    attemptIndex: number,
    latencyMs: number,
    outcome: SupportAiOutcome,
  ): Promise<void> {
    const usage = 'usage' in outcome && outcome.usage !== undefined ? outcome.usage : null;
    await this.deps.runs.record(scope, {
      id: this.deps.ids.uuid(),
      conversationId: input.conversationId,
      operation: input.operation,
      provider: step.provider,
      model: outcome.outcome === 'OK' ? outcome.model : step.model,
      attemptIndex,
      latencyMs,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      outcome: outcome.outcome,
      failureCode: outcome.outcome === 'OK' || outcome.outcome === 'TIMEOUT' ? null : outcome.code,
      now: this.deps.clock.now(),
    });
  }

  private wallMs(): number {
    return this.deps.nowMs?.() ?? this.deps.clock.now().getTime();
  }
}
