import {
  SUPPORT_AI_AVAILABLE_CODE,
  SUPPORT_AI_UNAVAILABLE_CODE,
  SUPPORT_AI_VISION_MAX_IMAGES,
  supportAiOutcomeFallsBack,
  type SupportAiConfigInput,
  type SupportAiImageSkipReason,
  type Clock,
  type IdGenerator,
  type OperationalEventRecorder,
  type ScopeContext,
  type SupportAiOperation,
  type SupportAiOutcome,
  type SupportAiProvider,
  type SupportAiProviderStep,
} from '@nexa/contracts';
import type {
  SupportAiAdapter,
  SupportAiImage,
  SupportAiMessage,
  SupportAiRequest,
} from './ports.js';
import { SupportAiCredentialAlert } from './credential-alert.js';
import { base64ByteLength } from '../domain/vision.js';
import type {
  DrizzleSupportAiConfigRepository,
  DrizzleSupportAiCredentialStore,
  DrizzleSupportAiRunRecorder,
} from '../infrastructure/drizzle-support-ai.repository.js';

export interface SupportAiChainDeps {
  readonly adapters: ReadonlyMap<SupportAiProvider, SupportAiAdapter>;
  readonly credentials: Pick<
    DrizzleSupportAiCredentialStore,
    | 'read'
    | 'states'
    | 'recordResult'
    | 'markRejected'
    | 'clearRejected'
    | 'rejection'
    | 'claimProbe'
  >;
  /**
   * Whether the chain-unavailable condition is open, so its recovery is recorded only then;
   * and whether a provider's credential alert is open, so it heals itself (`credential-alert`).
   */
  readonly conditions: {
    tenantConditionIsOpen(tenantId: string, code: string): Promise<boolean>;
    conditionIsOpen(scope: ScopeContext, dedupeKey: string): Promise<boolean>;
  };
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
  readonly exhausted:
    | 'NOT_CONFIGURED'
    | 'NO_USABLE_PROVIDER'
    | 'ALL_FAILED'
    /** TB6: an image was required and no usable step could see it; no step was called. */
    | 'NO_VISION_STEP'
    | null;
  /** TB6: images the step that produced `outcome` was given (0 when it was text-only). */
  readonly imagesSent: number;
  /**
   * TB6: the vision variant's images as the step that produced `outcome` saw them — the ids it
   * was given, and why it was not given each of the others. Empty when no variant was passed or
   * no step was called.
   */
  readonly sight: StepSight;
}

/** One processed image of a vision variant, by the id of the message that carried it. */
export interface SupportAiVisionImage {
  readonly id: string;
  readonly image: SupportAiImage;
}

/**
 * TB6 — the image variant of a request. `images` are the processed images, oldest first; each
 * step is given exactly the ones it can see (`stepSight`), and `render` builds the
 * conversation with THOSE attached and every other image marked unseen. `requiredId`: the
 * customer's latest message is this image, so a step that cannot see IT is not called at all —
 * answering it blind is the pretence the program forbids (§28).
 */
export interface SupportAiVisionVariant {
  readonly images: readonly SupportAiVisionImage[];
  readonly requiredId: string | null;
  render(seen: ReadonlySet<string>): readonly SupportAiMessage[];
}

/** Which of a variant's images one step is given, and why each other one is not. */
export interface StepSight {
  readonly seen: readonly string[];
  readonly unseen: ReadonlyMap<string, SupportAiImageSkipReason>;
}

const NO_SIGHT: StepSight = { seen: [], unseen: new Map() };

/**
 * Which images one adapter may be given: the tenant has vision on, the adapter declares it,
 * and the image is a type and a size the adapter declares. An image that does not fit is
 * dropped FOR THIS STEP ONLY (marked unseen, `NO_VISION_CAPABILITY`), so one oversized older
 * image never blinds a step to the latest one. At most `SUPPORT_AI_VISION_MAX_IMAGES` go, the
 * most recent; an older one is `OVER_LIMIT`. Core code branches on capabilities, never on a
 * provider name (ADR-0034 §2).
 */
export function stepSight(
  config: Pick<SupportAiConfigInput, 'visionEnabled'>,
  adapter: Pick<SupportAiAdapter, 'capabilities'>,
  images: readonly SupportAiVisionImage[],
): StepSight {
  const unseen = new Map<string, SupportAiImageSkipReason>();
  if (!config.visionEnabled || !adapter.capabilities.vision) {
    for (const { id } of images) unseen.set(id, 'NO_VISION_CAPABILITY');
    return { seen: [], unseen };
  }
  const fits = images.filter(({ id, image }) => {
    const fit =
      adapter.capabilities.imageMediaTypes.includes(image.mediaType) &&
      base64ByteLength(image.base64) <= adapter.capabilities.maxImageBytes;
    if (!fit) unseen.set(id, 'NO_VISION_CAPABILITY');
    return fit;
  });
  const over = Math.max(0, fits.length - SUPPORT_AI_VISION_MAX_IMAGES);
  for (const { id } of fits.slice(0, over)) unseen.set(id, 'OVER_LIMIT');
  return { seen: fits.slice(over).map(({ id }) => id), unseen };
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
 *     failed transiently; after the window ONE caller claims the half-open probe
 *     (`claimProbe`) and every other caller keeps skipping it. Its state is the credential
 *     row's, never `operational_events`, which only reports it.
 *   - Breaker and rejection writes carry the key's version (`api_key_set_at`): a call made with
 *     a key that has since been replaced counts for nothing.
 *   - Scope activity is NOT read here — a stated exception (`docs/conventions.md`): the chain
 *     writes only telemetry, breaker and alert state about a call already made.
 *   - Nothing here sends anything to a customer. The chain returns an outcome; deciding what
 *     to do with it is the caller's.
 *   - Telemetry per attempt (provider, model, position, latency, tokens, outcome), never the
 *     prompt or the response.
 */
export class SupportAiChain {
  private readonly alert: SupportAiCredentialAlert;

  constructor(private readonly deps: SupportAiChainDeps) {
    this.alert = new SupportAiCredentialAlert(deps);
  }

  async generate(
    scope: ScopeContext,
    input: {
      readonly operation: SupportAiOperation;
      readonly conversationId: string | null;
      readonly request: Omit<SupportAiRequest, 'model' | 'timeoutMs'>;
      /** TB6: the image variant, when the conversation has processed images. */
      readonly vision?: SupportAiVisionVariant;
    },
  ): Promise<SupportAiChainResult> {
    const { config } = await this.deps.configs.get(scope);
    if (config.mode === 'OFF' || config.primary === null) {
      return {
        outcome: { outcome: 'TEMPORARY', code: 'support_ai.off' },
        step: null,
        attempts: 0,
        exhausted: 'NOT_CONFIGURED',
        imagesSent: 0,
        sight: NO_SIGHT,
      };
    }
    const steps = [config.primary, ...config.fallbacks];
    const states = new Map(
      (await this.deps.credentials.states(scope)).map((state) => [state.provider, state]),
    );
    const now = this.deps.clock.now();
    let attempts = 0;
    let skippedBlind = 0;
    let last: SupportAiChainResult | null = null;

    for (const [index, step] of steps.entries()) {
      const adapter = this.deps.adapters.get(step.provider);
      const state = states.get(step.provider);
      if (adapter === undefined || state === undefined) continue;
      if (state.trippedUntil !== null && state.trippedUntil.getTime() > now.getTime()) continue;
      const sight =
        input.vision === undefined ? NO_SIGHT : stepSight(config, adapter, input.vision.images);
      const required = input.vision?.requiredId ?? null;
      if (required !== null && !sight.seen.includes(required)) {
        // The customer's latest message is an image this step cannot see: never call it blind.
        skippedBlind += 1;
        continue;
      }
      const credential = await this.deps.credentials.read(scope, step.provider);
      if (credential === null) continue;
      // Half-open: exactly ONE caller probes a provider whose window has passed. The claim is a
      // conditional write, so every other caller — on this replica or another — skips it as
      // still tripped instead of sending its own request to a provider that was failing.
      if (
        state.trippedUntil !== null &&
        !(await this.deps.credentials.claimProbe(scope, step.provider, credential.keySetAt, now))
      ) {
        continue;
      }

      const messages =
        sight.seen.length > 0 && input.vision !== undefined
          ? input.vision.render(new Set(sight.seen))
          : input.request.messages;
      const imagesSent = messages.reduce((sum, message) => sum + (message.images?.length ?? 0), 0);
      attempts += 1;
      const started = this.wallMs();
      const outcome = await adapter.generate(credential, {
        ...input.request,
        messages,
        model: step.model,
        timeoutMs: config.timeoutMs,
      });
      await this.recordRun(scope, input, step, index, this.wallMs() - started, outcome);
      await this.observe(scope, step.provider, credential.keySetAt, outcome);

      last = { outcome, step, attempts, exhausted: null, imagesSent, sight };
      if (outcome.outcome === 'OK') {
        await this.recoverUnavailable(scope);
        return last;
      }
      if (!supportAiOutcomeFallsBack(outcome.outcome)) return last;
    }

    if (last === null && skippedBlind > 0) {
      // Not a provider outage: nothing configured can see this image. No alert; the caller
      // hands off.
      return {
        outcome: { outcome: 'TEMPORARY', code: 'support_ai.no_vision_step' },
        step: null,
        attempts: 0,
        exhausted: 'NO_VISION_STEP',
        imagesSent: 0,
        sight: NO_SIGHT,
      };
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
        imagesSent: 0,
        sight: NO_SIGHT,
      };
    }
    return { ...last, exhausted: 'ALL_FAILED' };
  }

  /**
   * TB6: whether ANY configured step could see an image at all (vision on, and an adapter that
   * declares it). False means no customer image is worth downloading for this tenant.
   */
  visionStepConfigured(config: SupportAiConfigInput): boolean {
    if (!config.visionEnabled || config.primary === null) return false;
    return [config.primary, ...config.fallbacks].some(
      (step) => this.deps.adapters.get(step.provider)?.capabilities.vision === true,
    );
  }

  /**
   * The breaker and the credential alert, from one attempt's outcome. Every write names the
   * key version the call was made with, so a slow call holding a replaced key changes nothing.
   */
  private async observe(
    scope: ScopeContext,
    provider: SupportAiProvider,
    keySetAt: Date,
    outcome: SupportAiOutcome,
  ): Promise<void> {
    const now = this.deps.clock.now();
    if (outcome.outcome === 'AUTH_FAILED') {
      // Raised on the transition into rejected, and again if that raise was lost; the chain
      // moves on meanwhile.
      await this.alert.rejected(scope, {
        provider,
        keySetAt,
        quota: outcome.quota,
        code: outcome.code,
        message: outcome.quota
          ? 'An AI provider refused the key for lack of quota or balance. Other configured providers are used meanwhile.'
          : 'An AI provider rejected its key. Other configured providers are used meanwhile; replace the key.',
        now,
      });
      return;
    }
    if (
      outcome.outcome === 'OK' ||
      outcome.outcome === 'INVALID_OUTPUT' ||
      outcome.outcome === 'REFUSED_BY_PROVIDER'
    ) {
      // The provider answered: it is up, so the breaker closes.
      await this.deps.credentials.recordResult(scope, provider, keySetAt, 'SUCCESS', now);
      // Only a real answer proves the KEY works. An `INVALID_OUTPUT` can be an HTTP 4xx — and an
      // exhausted balance may arrive as one (`OQ-TB-20`) — so it never clears a rejection.
      if (outcome.outcome === 'OK') await this.alert.accepted(scope, { provider, keySetAt, now });
      return;
    }
    // RATE_LIMITED, TEMPORARY, TIMEOUT: transient — counted toward the breaker.
    await this.deps.credentials.recordResult(scope, provider, keySetAt, 'TRANSIENT_FAILURE', now);
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
      // Deduplicated: two successes that both saw the condition open collapse onto one row.
      dedupeKey: `${SUPPORT_AI_AVAILABLE_CODE}:chain`,
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
