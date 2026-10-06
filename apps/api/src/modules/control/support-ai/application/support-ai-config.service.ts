import {
  SUPPORT_AI_CREDENTIAL_ACCEPTED_CODE,
  SUPPORT_AI_CREDENTIAL_REJECTED_CODE,
  SUPPORT_AI_PROVIDERS,
  supportAiBreakerState,
  errors,
  PLATFORM_ERROR_CODES,
  supportAiConfigUpdateRequestSchema,
  supportAiCredentialSetRequestSchema,
  supportAiFailureDetailOf,
  supportAiTestRequestSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type IdGenerator,
  type OperationalEventRecorder,
  type PermissionKey,
  type ScopeContext,
  type SupportAiConfigInput,
  type SupportAiConfigResponse,
  type SupportAiOutcome,
  type SupportAiProvider,
  type SupportAiTestCheck,
  type SupportAiTestCheckView,
  type SupportAiTestResponse,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  DrizzleSupportAiConfigRepository,
  DrizzleSupportAiCredentialStore,
  DrizzleSupportAiRunRecorder,
} from '../infrastructure/drizzle-support-ai.repository.js';
import type { SupportAiAdapter } from './ports.js';
import { SupportAiCredentialAlert, credentialRejectedDedupeKey } from './credential-alert.js';
import { SUPPORT_AI_UNAVAILABLE_DEDUPE_KEY } from './support-ai-chain.js';
import { capabilityTestRequest } from './capability-test.js';
import {
  parseSupportDecision,
  type DecisionParse,
  type DecisionValidationFailure,
} from '../domain/decision.js';

function notRun(check: SupportAiTestCheck): SupportAiTestCheckView {
  return {
    check,
    result: 'NOT_TESTED',
    outcome: null,
    failureClass: null,
    code: null,
    httpStatus: null,
    providerErrorCode: null,
    providerErrorType: null,
    providerErrorParam: null,
    issuePath: null,
    issueCode: null,
    latencyMs: null,
  };
}

/** A check that is one provider call: PASS on `OK`, otherwise FAIL with the call's detail. */
function checkView(
  check: SupportAiTestCheck,
  probe: { readonly outcome: SupportAiOutcome; readonly latencyMs: number },
): SupportAiTestCheckView {
  const detail = supportAiFailureDetailOf(probe.outcome);
  return {
    check,
    result: probe.outcome.outcome === 'OK' ? 'PASS' : 'FAIL',
    outcome: probe.outcome.outcome,
    failureClass: detail?.failureClass ?? null,
    code:
      probe.outcome.outcome === 'OK' || probe.outcome.outcome === 'TIMEOUT'
        ? null
        : probe.outcome.code,
    httpStatus: detail?.httpStatus ?? null,
    providerErrorCode: detail?.providerErrorCode ?? null,
    providerErrorType: detail?.providerErrorType ?? null,
    providerErrorParam: detail?.providerErrorParam ?? null,
    issuePath: null,
    issueCode: null,
    latencyMs: probe.latencyMs,
  };
}

/** The decision-schema check: no call of its own; it reads the generation's answer. */
function schemaView(invalid: DecisionValidationFailure | null): SupportAiTestCheckView {
  if (invalid === null) return { ...notRun('DECISION_SCHEMA'), result: 'PASS', outcome: 'OK' };
  return {
    ...notRun('DECISION_SCHEMA'),
    result: 'FAIL',
    outcome: 'INVALID_OUTPUT',
    failureClass: invalid.failureClass,
    code: `decision.${invalid.failureClass}`,
    issuePath: invalid.issuePath,
    issueCode: invalid.issueCode,
  };
}

export const SUPPORT_AI_CONFIGURE_PERMISSION = 'support_ai.configure' satisfies PermissionKey;
export const SUPPORT_AI_AUTO_REPLY_PERMISSION = 'support_ai.auto_reply' satisfies PermissionKey;

export const SUPPORT_AI_ERROR_CODES = {
  VERSION_CONFLICT: 'support_ai.version_conflict',
  CREDENTIAL_MISSING: 'support_ai.credential_missing',
  UNKNOWN_PROVIDER: 'support_ai.unknown_provider',
  REGION_NOT_APPLICABLE: 'support_ai.region_not_applicable',
  TEST_TOO_SOON: 'support_ai.test_too_soon',
} as const;

/**
 * The capability test makes paid calls. One test per provider key per this interval, decided
 * by a conditional write on the credential row (`claimTest`), never by a process's memory.
 */
export const SUPPORT_AI_TEST_COOLDOWN_MS = 30_000;

export interface SupportAiConfigServiceDeps {
  readonly configs: DrizzleSupportAiConfigRepository;
  readonly credentials: DrizzleSupportAiCredentialStore;
  readonly runs: Pick<DrizzleSupportAiRunRecorder, 'record' | 'usage'>;
  readonly adapters: ReadonlyMap<SupportAiProvider, SupportAiAdapter>;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  /** Whether a provider's credential alert is open, so it heals itself (`credential-alert`). */
  readonly conditions: {
    conditionIsOpen(scope: ScopeContext, dedupeKey: string): Promise<boolean>;
  };
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * TB4 — the support AI's configuration and keys (ADR-0034 §8).
 *
 * - Every write charges `support_ai.configure` (HIGH) inside its transaction. ENTERING
 *   `AUTO_REPLY_SAFE` additionally charges `support_ai.auto_reply` (CRITICAL, owner-only);
 *   leaving it needs only `configure`, so turning safety on is never harder than turning it
 *   off.
 * - A key is SET, never read back: the view carries `setAt`, region and breaker facts. The
 *   audit records which provider's key changed, never the value.
 * - Optimistic versioning (ADR-0021): a save names the version it saw.
 * - The connection test is the operator's deliberate action; it calls the provider OUTSIDE any
 *   transaction and records a telemetry row and the outcome — never the key, never a body.
 */
export class SupportAiConfigService {
  private readonly alert: SupportAiCredentialAlert;

  constructor(private readonly deps: SupportAiConfigServiceDeps) {
    this.alert = new SupportAiCredentialAlert(deps);
  }

  async view(scope: ScopeContext, actor: ActorContext): Promise<SupportAiConfigResponse> {
    await this.deps.guard.check(scope, actor, SUPPORT_AI_CONFIGURE_PERMISSION);
    const [stored, states, chainUnavailable] = await Promise.all([
      this.deps.configs.get(scope),
      this.deps.credentials.states(scope),
      // TB10: the operational log only REPORTS the chain's condition; nothing decides from it.
      this.deps.conditions.conditionIsOpen(scope, SUPPORT_AI_UNAVAILABLE_DEDUPE_KEY),
    ]);
    const now = this.deps.clock.now();
    const byProvider = new Map(states.map((state) => [state.provider, state]));
    return {
      config: stored.config,
      version: stored.version,
      credentials: SUPPORT_AI_PROVIDERS.map((provider) => {
        const state = byProvider.get(provider);
        return {
          provider,
          configured: state !== undefined,
          setAt: state?.setAt.toISOString() ?? null,
          region: state?.region ?? null,
          trippedUntil: state?.trippedUntil?.toISOString() ?? null,
          lastTestOutcome: state?.lastTestOutcome ?? null,
          lastTestFailureClass: state?.lastTestFailureClass ?? null,
          lastTestedAt: state?.lastTestedAt?.toISOString() ?? null,
          // TB10: the breaker as of this read, derived and never stored.
          breaker: supportAiBreakerState(state?.trippedUntil ?? null, now),
          consecutiveFailures: state?.consecutiveFailures ?? 0,
          rejectedAt: state?.rejectedAt?.toISOString() ?? null,
        };
      }),
      capabilities: Object.fromEntries(
        SUPPORT_AI_PROVIDERS.map((provider) => {
          const adapter = this.deps.adapters.get(provider);
          return [
            provider,
            {
              structuredOutput: adapter?.capabilities.structuredOutput ?? false,
              vision: adapter?.capabilities.vision ?? false,
            },
          ];
        }),
      ) as SupportAiConfigResponse['capabilities'],
      chainUnavailable,
    };
  }

  async update(
    scope: ScopeContext,
    actor: ActorContext,
    body: unknown,
  ): Promise<{ readonly version: number; readonly config: SupportAiConfigInput }> {
    const command = supportAiConfigUpdateRequestSchema.parse(body);
    const adminId = this.adminIdOf(actor);
    const denial = {
      action: 'support_ai.config.update',
      entityType: 'SupportAiConfig',
      entityId: null,
    };
    await this.authorize(scope, actor, SUPPORT_AI_CONFIGURE_PERMISSION, denial);
    const requestHash = hashRequest({
      command: 'support_ai.config.update',
      ...command,
      idempotencyKey: undefined,
    });
    type Result = { readonly version: number; readonly config: SupportAiConfigInput };
    const replay = await this.deps.idempotency.find<Result>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay) return replay.result;

    const mutation = runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      SUPPORT_AI_CONFIGURE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.deps.configs.get(scope, tx);
        // N4 (review of PR #228): a save that omits the clarifying limit — an older client that
        // does not know it — keeps the stored value (the default when nothing is stored). It is
        // merged BEFORE the permission and version logic, so an absent field is never a widening.
        const config: SupportAiConfigInput = {
          ...command.config,
          maxConsecutiveClarifyingQuestions:
            command.config.maxConsecutiveClarifyingQuestions ??
            before.config.maxConsecutiveClarifyingQuestions,
        };
        // ENTERING automatic replies is the owner's call alone; staying in it or leaving it is not.
        if (config.mode === 'AUTO_REPLY_SAFE' && before.config.mode !== 'AUTO_REPLY_SAFE') {
          await this.deps.guard.check(scope, actor, SUPPORT_AI_AUTO_REPLY_PERMISSION, tx);
        }
        // TB7: WIDENING what may be answered automatically is the same CRITICAL call; narrowing
        // never is. Two kinds of widening (substitute review of PR #202):
        //  - what may be answered at all — a topic added to the allowlist, a lower confidence
        //    accepted — charged in every mode, because the allowlist means nothing else;
        //  - how much and how often — more consecutive replies, more consecutive clarifying
        //    questions (hotfix 2026-10-06), longer replies, a shorter cooldown, a shorter
        //    settle delay — charged when the result is AUTO_REPLY_SAFE.
        //    These also shape Assist drafts, so outside AUTO they are ordinary configuration;
        //    and entering AUTO is itself charged above, so whoever enters it adopts every bound
        //    on the form under the CRITICAL permission. What is left is an AUTO tenant's bounds
        //    loosened by someone who could not have set the mode.
        const next = config;
        const prev = before.config;
        const widened =
          next.autoTopics.some((topic) => !prev.autoTopics.includes(topic)) ||
          (next.autoMinConfidence === 'MEDIUM' && prev.autoMinConfidence !== 'MEDIUM') ||
          (next.mode === 'AUTO_REPLY_SAFE' &&
            (next.maxConsecutiveReplies > prev.maxConsecutiveReplies ||
              next.maxConsecutiveClarifyingQuestions > prev.maxConsecutiveClarifyingQuestions ||
              next.maxOutputChars > prev.maxOutputChars ||
              next.cooldownSeconds < prev.cooldownSeconds ||
              next.settleDelaySeconds < prev.settleDelaySeconds));
        if (widened) {
          await this.deps.guard.check(scope, actor, SUPPORT_AI_AUTO_REPLY_PERMISSION, tx);
        }
        const expected = command.expectedVersion ?? 0;
        if (expected !== before.version) throw this.versionConflict();
        const version = await this.deps.configs.save(
          scope,
          {
            config,
            expectedVersion: expected,
            adminId,
            now: this.deps.clock.now(),
          },
          tx,
        );
        if (version === null) throw this.versionConflict();
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'support_ai.config.update',
            entityType: 'SupportAiConfig',
            entityId: null,
            before: { version: before.version, ...before.config },
            after: { version, ...config },
            result: 'SUCCESS',
          },
          tx,
        );
        const result: Result = { version, config };
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          result,
          tx,
        );
        return result;
      },
    );
    try {
      return await mutation;
    } catch (error) {
      // ENTERING automatic replies is charged its own CRITICAL permission inside the
      // transaction, and its refusal leaves its own trail: a DENIED audit row and a denial event
      // naming `support_ai.auto_reply`, recorded here once the transaction has unwound.
      // `runAuthorizedMutation` records only the permission it is given (`configure`).
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        SUPPORT_AI_AUTO_REPLY_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }

  async setCredential(
    scope: ScopeContext,
    actor: ActorContext,
    providerRaw: string,
    body: unknown,
  ): Promise<{ readonly replaced: boolean }> {
    const provider = this.providerOf(providerRaw);
    const command = supportAiCredentialSetRequestSchema.parse(body);
    if (command.region !== undefined && provider !== 'ZAI') {
      throw errors.validation(
        SUPPORT_AI_ERROR_CODES.REGION_NOT_APPLICABLE,
        'Only Z.AI keys have a region.',
      );
    }
    const denial = {
      action: 'support_ai.credential.set',
      entityType: 'SupportAiCredential',
      entityId: provider,
    };
    await this.authorize(scope, actor, SUPPORT_AI_CONFIGURE_PERMISSION, denial);
    // The key is NOT in the request hash: an unsalted digest of a key is a key-guessing oracle
    // stored beside the row, and the repository never hashes a secret into idempotency
    // (panel and gateway credentials hash only WHICH credential). The cost, accepted: a replay
    // of one idempotency key with a DIFFERENT key value answers the first result instead of
    // refusing; a corrected key is a new submission with a new idempotency key.
    const requestHash = hashRequest({
      command: 'support_ai.credential.set',
      provider,
      region: command.region ?? null,
    });
    const replay = await this.deps.idempotency.find<{ readonly replaced: boolean }>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay) return replay.result;
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      SUPPORT_AI_CONFIGURE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const now = this.deps.clock.now();
        const written = await this.deps.credentials.replace(
          scope,
          {
            provider,
            apiKey: command.apiKey,
            region: provider === 'ZAI' ? (command.region ?? 'INTERNATIONAL') : null,
            now,
          },
          tx,
        );
        // A replaced key is a new question: whatever rejection the old one had is closed.
        if (written.wasRejected) await this.closeRejection(scope, provider, tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'support_ai.credential.set',
            entityType: 'SupportAiCredential',
            entityId: provider,
            // WHICH key changed, never the value (ADR-0023).
            before: { configured: written.replaced },
            after: {
              configured: true,
              region: provider === 'ZAI' ? (command.region ?? 'INTERNATIONAL') : null,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        const result = { replaced: written.replaced };
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          result,
          tx,
        );
        return result;
      },
    );
  }

  async deleteCredential(
    scope: ScopeContext,
    actor: ActorContext,
    providerRaw: string,
    idempotencyKey: string,
  ): Promise<{ readonly removed: boolean }> {
    const provider = this.providerOf(providerRaw);
    const denial = {
      action: 'support_ai.credential.delete',
      entityType: 'SupportAiCredential',
      entityId: provider,
    };
    await this.authorize(scope, actor, SUPPORT_AI_CONFIGURE_PERMISSION, denial);
    const requestHash = hashRequest({ command: 'support_ai.credential.delete', provider });
    const replay = await this.deps.idempotency.find<{ readonly removed: boolean }>(
      scope,
      actor.surface,
      idempotencyKey,
      requestHash,
    );
    if (replay) return replay.result;
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      SUPPORT_AI_CONFIGURE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const removed = await this.deps.credentials.remove(scope, provider, tx);
        if (removed.wasRejected) await this.closeRejection(scope, provider, tx);
        if (removed.removed) {
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'support_ai.credential.delete',
              entityType: 'SupportAiCredential',
              entityId: provider,
              before: { configured: true },
              after: { configured: false },
              result: 'SUCCESS',
            },
            tx,
          );
        }
        const result = { removed: removed.removed };
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          idempotencyKey,
          requestHash,
          result,
          tx,
        );
        return result;
      },
    );
  }

  /**
   * The operator's capability test (program §11, A2). Authorised and scope-checked first, then
   * the provider is called outside any transaction, one call per check, then the outcome is
   * recorded:
   *
   *   1. `MODEL_ACCESS` — the adapter's model lookup (`testConnection`);
   *   2. `STRUCTURED_GENERATION` — the adapter's `generate` with the SAME request Assist and
   *      Auto Reply send (`capabilityTestRequest`), over a synthetic conversation;
   *   3. `DECISION_SCHEMA` — that answer through `parseSupportDecision` at the tenant's limits;
   *   4. `VISION` — only when vision is on and the adapter declares it: the same request with
   *      one tiny embedded image.
   *
   * A check is not paid for when an earlier one already failed. `OK` is reported — and stored
   * as `last_test_outcome` — only when every check that ran passed: a model that can be listed
   * but cannot produce NEXA's decision is never «OK». Idempotent on the operator's key: a
   * replay returns the first answer and calls nothing.
   *
   * The recording is not in a transaction and does not re-read scope activity — a stated
   * exception (`docs/conventions.md`): it writes only telemetry, the last test result and the
   * credential alert about calls already made, and creates no business state.
   */
  async test(
    scope: ScopeContext,
    actor: ActorContext,
    providerRaw: string,
    body: unknown,
  ): Promise<SupportAiTestResponse> {
    const provider = this.providerOf(providerRaw);
    await this.authorize(scope, actor, SUPPORT_AI_CONFIGURE_PERMISSION, {
      action: 'support_ai.credential.test',
      entityType: 'SupportAiCredential',
      entityId: provider,
    });
    const command = supportAiTestRequestSchema.parse(body);
    const model = command.model;
    const requestHash = hashRequest({ command: 'support_ai.credential.test', provider, model });
    const replay = await this.deps.idempotency.find<SupportAiTestResponse>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return replay.result;
    if (!(await this.deps.scopeActivity.scopeIsActive(scope))) throw this.inactive();
    const adapter = this.deps.adapters.get(provider);
    if (adapter === undefined) throw this.unknownProvider();
    const credential = await this.deps.credentials.read(scope, provider);
    if (credential === null) {
      throw errors.conflict(
        SUPPORT_AI_ERROR_CODES.CREDENTIAL_MISSING,
        'Set a key for this provider first.',
      );
    }
    // The cooldown: claimed in a transaction that re-reads scope activity, BEFORE any paid
    // call. A refused claim calls nothing.
    await this.deps.uow.run(scope, async (tx) => {
      await this.assertScopeActive(scope, tx);
      const claim = await this.deps.credentials.claimTest(
        scope,
        provider,
        this.deps.clock.now(),
        SUPPORT_AI_TEST_COOLDOWN_MS,
        tx,
      );
      if (!claim.claimed) {
        throw errors.conflict(
          SUPPORT_AI_ERROR_CODES.TEST_TOO_SOON,
          'This provider was tested a moment ago; wait before testing again.',
          { lastTestedAt: claim.lastTestedAt?.toISOString() ?? null },
        );
      }
    });
    const { config } = await this.deps.configs.get(scope);
    const started = this.deps.clock.now().getTime();
    const checks: SupportAiTestCheckView[] = [];
    const answers: SupportAiOutcome[] = [];

    // 1. Model access.
    const access = await this.probe(scope, provider, model, () =>
      adapter.testConnection(credential, model, config.timeoutMs),
    );
    answers.push(access.outcome);
    checks.push(checkView('MODEL_ACCESS', access));

    // 2 + 3. The runtime request, and NEXA's decision schema over its answer.
    const strict = (output: unknown) =>
      parseSupportDecision(output, {
        maxReplyChars: config.maxOutputChars,
        mode: 'STRICT',
      });
    let decided = false;
    if (access.outcome.outcome !== 'OK') {
      checks.push(notRun('STRUCTURED_GENERATION'), notRun('DECISION_SCHEMA'));
    } else {
      const generation = await this.probe(
        scope,
        provider,
        model,
        () => adapter.generate(credential, capabilityTestRequest(config, model, false)),
        strict,
      );
      answers.push(generation.outcome);
      checks.push(checkView('STRUCTURED_GENERATION', generation));
      if (generation.outcome.outcome !== 'OK') {
        checks.push(notRun('DECISION_SCHEMA'));
      } else {
        decided = generation.invalid === null;
        checks.push(schemaView(generation.invalid));
      }
    }

    // 4. Vision, only when the tenant turned it on.
    if (!config.visionEnabled) {
      checks.push(notRun('VISION'));
    } else if (!adapter.capabilities.vision) {
      checks.push({ ...notRun('VISION'), result: 'UNSUPPORTED' });
    } else if (!decided) {
      checks.push(notRun('VISION'));
    } else {
      const seen = await this.probe(
        scope,
        provider,
        model,
        () => adapter.generate(credential, capabilityTestRequest(config, model, true)),
        strict,
      );
      answers.push(seen.outcome);
      const view = checkView('VISION', seen);
      checks.push(
        seen.outcome.outcome === 'OK' && seen.invalid !== null
          ? {
              ...view,
              result: 'FAIL',
              outcome: 'INVALID_OUTPUT',
              failureClass: seen.invalid.failureClass,
              issuePath: seen.invalid.issuePath,
              issueCode: seen.invalid.issueCode,
            }
          : view,
      );
    }

    const now = this.deps.clock.now();
    const failed = checks.find((check) => check.result === 'FAIL') ?? null;
    const outcome = failed?.outcome ?? 'OK';
    const failureClass = failed?.failureClass ?? null;
    await this.deps.credentials.recordTest(scope, provider, outcome, now, failureClass);
    const keySetAt = credential.keySetAt;
    // The key's alert reads what the PROVIDER said: any answer proves the key; a rejection
    // raises the alert.
    if (answers.some((answer) => answer.outcome === 'OK')) {
      await this.alert.accepted(scope, { provider, keySetAt, now });
    }
    const rejected = answers.find((answer) => answer.outcome === 'AUTH_FAILED');
    if (rejected !== undefined && rejected.outcome === 'AUTH_FAILED') {
      await this.alert.rejected(scope, {
        provider,
        keySetAt,
        quota: rejected.quota,
        code: rejected.code,
        message: 'An AI provider rejected its key during a connection test.',
        now,
      });
    }
    const response: SupportAiTestResponse = {
      outcome,
      code: failed?.code ?? null,
      failureClass,
      latencyMs: Math.max(0, now.getTime() - started),
      checks,
    };
    await this.deps.uow.run(scope, (tx) =>
      rememberOnce(
        this.deps.idempotency,
        scope,
        actor.surface,
        command.idempotencyKey,
        requestHash,
        response,
        tx,
      ),
    );
    return response;
  }

  /**
   * One provider call of the capability test, recorded as a `CONNECTION_TEST` run with its
   * failure class — and, for an answer that is not a decision, as `INVALID_OUTPUT` with the
   * zod issue's path and code, exactly as the chain records a production call.
   */
  private async probe(
    scope: ScopeContext,
    provider: SupportAiProvider,
    model: string,
    call: () => Promise<SupportAiOutcome>,
    validate?: (output: unknown) => DecisionParse,
  ): Promise<{
    readonly outcome: SupportAiOutcome;
    readonly invalid: DecisionValidationFailure | null;
    readonly latencyMs: number;
  }> {
    const started = this.deps.clock.now().getTime();
    const outcome = await call();
    const now = this.deps.clock.now();
    const latencyMs = Math.max(0, now.getTime() - started);
    const parsed =
      outcome.outcome === 'OK' && validate !== undefined ? validate(outcome.output) : null;
    const invalid = parsed !== null && !parsed.ok ? parsed.failure : null;
    const usage = 'usage' in outcome && outcome.usage !== undefined ? outcome.usage : null;
    const recorded: SupportAiOutcome =
      outcome.outcome === 'OK' && invalid !== null
        ? {
            outcome: 'INVALID_OUTPUT',
            code: `decision.${invalid.failureClass}`,
            detail: {
              failureClass: invalid.failureClass,
              httpStatus: null,
              providerErrorCode: null,
              providerErrorType: null,
              providerErrorParam: null,
            },
          }
        : outcome;
    await this.deps.runs.record(scope, {
      id: this.deps.ids.uuid(),
      conversationId: null,
      operation: 'CONNECTION_TEST',
      provider,
      model: outcome.outcome === 'OK' ? outcome.model : model,
      attemptIndex: 0,
      latencyMs,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      outcome: recorded.outcome,
      failureCode:
        recorded.outcome === 'OK' || recorded.outcome === 'TIMEOUT' ? null : recorded.code,
      failure: supportAiFailureDetailOf(recorded),
      schemaIssue: invalid === null ? null : { path: invalid.issuePath, code: invalid.issueCode },
      now,
    });
    return { outcome, invalid, latencyMs };
  }

  async usage(scope: ScopeContext, actor: ActorContext, sinceDays = 30) {
    await this.deps.guard.check(scope, actor, SUPPORT_AI_CONFIGURE_PERMISSION);
    const since = new Date(this.deps.clock.now().getTime() - sinceDays * 86_400_000);
    return { since: since.toISOString(), rows: await this.deps.runs.usage(scope, since) };
  }

  private async closeRejection(
    scope: ScopeContext,
    provider: SupportAiProvider,
    tx: unknown,
  ): Promise<void> {
    await this.deps.opsLog.record(
      scope,
      {
        code: SUPPORT_AI_CREDENTIAL_ACCEPTED_CODE,
        severity: 'INFO',
        message: 'An AI provider key that had been rejected was replaced or removed.',
        recoversCode: SUPPORT_AI_CREDENTIAL_REJECTED_CODE,
        recoversDedupeKey: credentialRejectedDedupeKey(provider),
        context: { provider },
      },
      tx,
    );
  }

  private providerOf(raw: string): SupportAiProvider {
    if ((SUPPORT_AI_PROVIDERS as readonly string[]).includes(raw)) return raw as SupportAiProvider;
    throw this.unknownProvider();
  }

  private adminIdOf(actor: ActorContext): string {
    if (actor.id === null) {
      throw errors.permissionDenied(
        PLATFORM_ERROR_CODES.PERMISSION_DENIED,
        'Only an administrator configures the support AI.',
      );
    }
    return actor.id;
  }

  private async authorize(
    scope: ScopeContext,
    actor: ActorContext,
    permission: PermissionKey,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (error) {
      await recordMutationDenial(this.mutationDeps(), scope, actor, permission, denial, error);
      throw error;
    }
  }

  private async assertScopeActive(scope: ScopeContext, tx: TransactionScope): Promise<void> {
    if (await this.deps.scopeActivity.scopeIsActive(scope, tx)) return;
    throw this.inactive();
  }

  private inactive() {
    return errors.notFound(
      PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
      'This scope is not accepting work.',
    );
  }

  private versionConflict() {
    return errors.conflict(
      SUPPORT_AI_ERROR_CODES.VERSION_CONFLICT,
      'The configuration changed since it was loaded; reload it.',
    );
  }

  private unknownProvider() {
    return errors.notFound(SUPPORT_AI_ERROR_CODES.UNKNOWN_PROVIDER, 'No such AI provider.');
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }
}
