import {
  SUPPORT_AI_CREDENTIAL_ACCEPTED_CODE,
  SUPPORT_AI_CREDENTIAL_REJECTED_CODE,
  SUPPORT_AI_PROVIDERS,
  errors,
  PLATFORM_ERROR_CODES,
  supportAiConfigUpdateRequestSchema,
  supportAiCredentialSetRequestSchema,
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

export const SUPPORT_AI_CONFIGURE_PERMISSION = 'support_ai.configure' satisfies PermissionKey;
export const SUPPORT_AI_AUTO_REPLY_PERMISSION = 'support_ai.auto_reply' satisfies PermissionKey;

export const SUPPORT_AI_ERROR_CODES = {
  VERSION_CONFLICT: 'support_ai.version_conflict',
  CREDENTIAL_MISSING: 'support_ai.credential_missing',
  UNKNOWN_PROVIDER: 'support_ai.unknown_provider',
  REGION_NOT_APPLICABLE: 'support_ai.region_not_applicable',
} as const;

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
    const [stored, states] = await Promise.all([
      this.deps.configs.get(scope),
      this.deps.credentials.states(scope),
    ]);
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
          lastTestedAt: state?.lastTestedAt?.toISOString() ?? null,
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
        // ENTERING automatic replies is the owner's call alone; staying in it or leaving it is not.
        if (command.config.mode === 'AUTO_REPLY_SAFE' && before.config.mode !== 'AUTO_REPLY_SAFE') {
          await this.deps.guard.check(scope, actor, SUPPORT_AI_AUTO_REPLY_PERMISSION, tx);
        }
        // TB7: WIDENING what may be answered automatically is the same CRITICAL call; narrowing
        // never is. Two kinds of widening (substitute review of PR #202):
        //  - what may be answered at all — a topic added to the allowlist, a lower confidence
        //    accepted — charged in every mode, because the allowlist means nothing else;
        //  - how much and how often — more consecutive replies, longer replies, a shorter
        //    cooldown, a shorter settle delay — charged when the result is AUTO_REPLY_SAFE.
        //    These also shape Assist drafts, so outside AUTO they are ordinary configuration;
        //    and entering AUTO is itself charged above, so whoever enters it adopts every bound
        //    on the form under the CRITICAL permission. What is left is an AUTO tenant's bounds
        //    loosened by someone who could not have set the mode.
        const next = command.config;
        const prev = before.config;
        const widened =
          next.autoTopics.some((topic) => !prev.autoTopics.includes(topic)) ||
          (next.autoMinConfidence === 'MEDIUM' && prev.autoMinConfidence !== 'MEDIUM') ||
          (next.mode === 'AUTO_REPLY_SAFE' &&
            (next.maxConsecutiveReplies > prev.maxConsecutiveReplies ||
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
            config: command.config,
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
            after: { version, ...command.config },
            result: 'SUCCESS',
          },
          tx,
        );
        const result: Result = { version, config: command.config };
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
   * The operator's connection test. Authorised and scope-checked first, then the provider is
   * called outside any transaction, then the outcome is recorded.
   *
   * The recording is not in a transaction and does not re-read scope activity — a stated
   * exception (`docs/conventions.md`): it writes only telemetry, the last test result and the
   * credential alert about a call already made, and creates no business state.
   */
  async test(
    scope: ScopeContext,
    actor: ActorContext,
    providerRaw: string,
    model: string,
  ): Promise<SupportAiTestResponse> {
    const provider = this.providerOf(providerRaw);
    await this.authorize(scope, actor, SUPPORT_AI_CONFIGURE_PERMISSION, {
      action: 'support_ai.credential.test',
      entityType: 'SupportAiCredential',
      entityId: provider,
    });
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
    const { config } = await this.deps.configs.get(scope);
    const started = this.deps.clock.now().getTime();
    const outcome: SupportAiOutcome = await adapter.testConnection(
      credential,
      model,
      config.timeoutMs,
    );
    const now = this.deps.clock.now();
    const latencyMs = Math.max(0, now.getTime() - started);
    await this.deps.runs.record(scope, {
      id: this.deps.ids.uuid(),
      conversationId: null,
      operation: 'CONNECTION_TEST',
      provider,
      model,
      attemptIndex: 0,
      latencyMs,
      inputTokens: null,
      outputTokens: null,
      outcome: outcome.outcome,
      failureCode: outcome.outcome === 'OK' || outcome.outcome === 'TIMEOUT' ? null : outcome.code,
      now,
    });
    await this.deps.credentials.recordTest(scope, provider, outcome.outcome, now);
    const keySetAt = credential.keySetAt;
    if (outcome.outcome === 'OK') await this.alert.accepted(scope, { provider, keySetAt, now });
    if (outcome.outcome === 'AUTH_FAILED') {
      await this.alert.rejected(scope, {
        provider,
        keySetAt,
        quota: outcome.quota,
        code: outcome.code,
        message: 'An AI provider rejected its key during a connection test.',
        now,
      });
    }
    return {
      outcome: outcome.outcome,
      code: outcome.outcome === 'OK' || outcome.outcome === 'TIMEOUT' ? null : outcome.code,
      latencyMs,
    };
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
