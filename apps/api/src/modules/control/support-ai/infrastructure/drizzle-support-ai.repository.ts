import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import {
  SUPPORT_AI_BREAKER_OPEN_MS,
  SUPPORT_AI_BREAKER_THRESHOLD,
  SUPPORT_AI_DEFAULT_CONFIG,
  type ScopeContext,
  type SecretCipher,
  type SupportAiConfigInput,
  type SupportAiFailureClass,
  type SupportAiFailureDetail,
  type SupportAiFailureDiagnostic,
  type SupportAiOperation,
  type SupportAiOutcomeKind,
  type SupportAiProvider,
  type SupportAiProviderStep,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  supportAiConfigs,
  supportAiProviderCredentials,
  supportAiRuns,
} from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SupportAiCredential } from '../application/ports.js';

function exec(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

/** One tenant's one provider's row, AT the key version a call was made with. */
function sameKey(tenantId: string, provider: SupportAiProvider, keySetAt: Date) {
  return and(
    eq(supportAiProviderCredentials.tenantId, tenantId),
    eq(supportAiProviderCredentials.provider, provider),
    eq(supportAiProviderCredentials.apiKeySetAt, keySetAt),
  );
}

/** A decrypted key together with the version (`api_key_set_at`) it was read at. */
export type SupportAiReadCredential = SupportAiCredential & { readonly keySetAt: Date };

export interface SupportAiCredentialState {
  readonly provider: SupportAiProvider;
  readonly setAt: Date;
  readonly region: 'INTERNATIONAL' | 'CHINA' | null;
  readonly consecutiveFailures: number;
  readonly trippedUntil: Date | null;
  readonly lastTestOutcome: SupportAiOutcomeKind | null;
  readonly lastTestFailureClass: SupportAiFailureClass | null;
  readonly lastTestedAt: Date | null;
  /** TB10: when the provider last rejected this key; null once it answered again. */
  readonly rejectedAt: Date | null;
}

/**
 * TB4 — a tenant's AI provider keys, encrypted at rest (ADR-0023 to the letter).
 *
 * The AEAD context `(support_ai_provider.api_key, tenant, row id)` is rebuilt from the caller's
 * scope on every read and never stored. `read` is the ONLY place a key exists in plaintext,
 * for the length of one provider call; `states` selects timestamps and breaker facts — never
 * the ciphertext — so no response builder can acquire a key. Nothing here logs.
 */
export class DrizzleSupportAiCredentialStore {
  constructor(
    private readonly db: Database,
    private readonly cipher: SecretCipher,
    private readonly newId: () => string,
  ) {}

  async states(scope: ScopeContext): Promise<readonly SupportAiCredentialState[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select({
        provider: supportAiProviderCredentials.provider,
        setAt: supportAiProviderCredentials.apiKeySetAt,
        region: supportAiProviderCredentials.region,
        consecutiveFailures: supportAiProviderCredentials.consecutiveFailures,
        trippedUntil: supportAiProviderCredentials.trippedUntil,
        lastTestOutcome: supportAiProviderCredentials.lastTestOutcome,
        lastTestFailureClass: supportAiProviderCredentials.lastTestFailureClass,
        lastTestedAt: supportAiProviderCredentials.lastTestedAt,
        rejectedAt: supportAiProviderCredentials.rejectedAt,
      })
      .from(supportAiProviderCredentials)
      .where(eq(supportAiProviderCredentials.tenantId, tenantId));
    return rows.map((row) => ({
      provider: row.provider as SupportAiProvider,
      setAt: row.setAt,
      region: row.region as SupportAiCredentialState['region'],
      consecutiveFailures: row.consecutiveFailures,
      trippedUntil: row.trippedUntil,
      lastTestOutcome: row.lastTestOutcome as SupportAiOutcomeKind | null,
      lastTestFailureClass: row.lastTestFailureClass as SupportAiFailureClass | null,
      lastTestedAt: row.lastTestedAt,
      rejectedAt: row.rejectedAt,
    }));
  }

  /**
   * The decrypted key, scoped by tenant AND provider, or null when none is set.
   *
   * `keySetAt` is the key's VERSION: every write that follows a call made with this key names
   * it (`recordResult`, `markRejected`, `clearRejected`, `claimProbe`), so a slow call holding
   * an old key can neither reject nor trip the key an operator has set since.
   */
  async read(
    scope: ScopeContext,
    provider: SupportAiProvider,
  ): Promise<SupportAiReadCredential | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select({
        id: supportAiProviderCredentials.id,
        ciphertext: supportAiProviderCredentials.apiKeyCiphertext,
        keyId: supportAiProviderCredentials.apiKeyKeyId,
        region: supportAiProviderCredentials.region,
        keySetAt: supportAiProviderCredentials.apiKeySetAt,
      })
      .from(supportAiProviderCredentials)
      .where(
        and(
          eq(supportAiProviderCredentials.tenantId, tenantId),
          eq(supportAiProviderCredentials.provider, provider),
        ),
      )
      .limit(1);
    if (row === undefined) return null;
    const apiKey = this.cipher.decrypt(
      { keyId: row.keyId, ciphertext: row.ciphertext },
      { purpose: 'support_ai_provider.api_key', tenantId, entityId: row.id },
    );
    return {
      apiKey,
      region: row.region as SupportAiCredential['region'],
      keySetAt: row.keySetAt,
    };
  }

  /**
   * Sets or replaces a key. The row id is decided BEFORE encrypting, because the ciphertext is
   * bound to it. A replaced key starts with a closed breaker and no test result: a new key is a
   * new question.
   */
  async replace(
    scope: ScopeContext,
    input: {
      readonly provider: SupportAiProvider;
      readonly apiKey: string;
      readonly region: 'INTERNATIONAL' | 'CHINA' | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<{ readonly replaced: boolean; readonly wasRejected: boolean }> {
    const tenantId = requireTenantId(scope);
    const executor = exec(this.db, tx);
    const [existing] = await executor
      .select({
        id: supportAiProviderCredentials.id,
        rejectedAt: supportAiProviderCredentials.rejectedAt,
      })
      .from(supportAiProviderCredentials)
      .where(
        and(
          eq(supportAiProviderCredentials.tenantId, tenantId),
          eq(supportAiProviderCredentials.provider, input.provider),
        ),
      )
      .for('update')
      .limit(1);
    const id = existing?.id ?? this.newId();
    const sealed = this.cipher.encrypt(input.apiKey, {
      purpose: 'support_ai_provider.api_key',
      tenantId,
      entityId: id,
    });
    const fresh = {
      apiKeyCiphertext: sealed.ciphertext,
      apiKeyKeyId: sealed.keyId,
      apiKeySetAt: input.now,
      region: input.region,
      consecutiveFailures: 0,
      trippedUntil: null,
      lastTestOutcome: null,
      // A new key is a new question: the old key's test, and why it failed, say nothing of it.
      lastTestFailureClass: null,
      lastTestedAt: null,
      rejectedAt: null,
      updatedAt: input.now,
    };
    if (existing === undefined) {
      await executor
        .insert(supportAiProviderCredentials)
        .values({ id, tenantId, provider: input.provider, createdAt: input.now, ...fresh });
      return { replaced: false, wasRejected: false };
    }
    await executor
      .update(supportAiProviderCredentials)
      .set(fresh)
      .where(
        and(
          eq(supportAiProviderCredentials.tenantId, tenantId),
          eq(supportAiProviderCredentials.id, id),
        ),
      );
    return { replaced: true, wasRejected: existing.rejectedAt !== null };
  }

  /** Deletes the key — the row, and with it the breaker's state. */
  async remove(
    scope: ScopeContext,
    provider: SupportAiProvider,
    tx: unknown,
  ): Promise<{ readonly removed: boolean; readonly wasRejected: boolean }> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .delete(supportAiProviderCredentials)
      .where(
        and(
          eq(supportAiProviderCredentials.tenantId, tenantId),
          eq(supportAiProviderCredentials.provider, provider),
        ),
      )
      .returning({
        id: supportAiProviderCredentials.id,
        rejectedAt: supportAiProviderCredentials.rejectedAt,
      });
    return { removed: rows.length > 0, wasRejected: rows[0]?.rejectedAt != null };
  }

  /**
   * The breaker (ADR-0034 §3, state HERE — TB0 review F4). A success closes it; a transient
   * failure counts, and the THRESHOLD-th consecutive one opens it for
   * `SUPPORT_AI_BREAKER_OPEN_MS`. One conditional statement each, so two replicas recording at
   * once still count correctly. Returns the state after the write, or null when the key the
   * call was made with is no longer the stored one — a replaced key starts with a closed
   * breaker, and an old key's failure is not its failure.
   */
  async recordResult(
    scope: ScopeContext,
    provider: SupportAiProvider,
    keySetAt: Date,
    result: 'SUCCESS' | 'TRANSIENT_FAILURE',
    now: Date,
  ): Promise<{ readonly trippedUntil: Date | null; readonly consecutiveFailures: number } | null> {
    const tenantId = requireTenantId(scope);
    const where = sameKey(tenantId, provider, keySetAt);
    const openUntil = new Date(now.getTime() + SUPPORT_AI_BREAKER_OPEN_MS);
    const [row] =
      result === 'SUCCESS'
        ? await this.db
            .update(supportAiProviderCredentials)
            .set({ consecutiveFailures: 0, trippedUntil: null, updatedAt: now })
            .where(where)
            .returning({
              trippedUntil: supportAiProviderCredentials.trippedUntil,
              consecutiveFailures: supportAiProviderCredentials.consecutiveFailures,
            })
        : await this.db
            .update(supportAiProviderCredentials)
            .set({
              consecutiveFailures: sql`${supportAiProviderCredentials.consecutiveFailures} + 1`,
              trippedUntil: sql`CASE WHEN ${supportAiProviderCredentials.consecutiveFailures} + 1 >= ${SUPPORT_AI_BREAKER_THRESHOLD}
                                     THEN ${openUntil.toISOString()}::timestamptz
                                     ELSE ${supportAiProviderCredentials.trippedUntil} END`,
              updatedAt: now,
            })
            .where(where)
            .returning({
              trippedUntil: supportAiProviderCredentials.trippedUntil,
              consecutiveFailures: supportAiProviderCredentials.consecutiveFailures,
            });
    return row ?? null;
  }

  /**
   * Marks the key REJECTED. True only on the transition into rejected (null → set): the one
   * moment `credential_rejected` is raised. Only the key the call was made with: a slow call
   * holding a replaced key never rejects the new one.
   */
  async markRejected(
    scope: ScopeContext,
    provider: SupportAiProvider,
    keySetAt: Date,
    now: Date,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .update(supportAiProviderCredentials)
      .set({ rejectedAt: now, updatedAt: now })
      .where(
        and(sameKey(tenantId, provider, keySetAt), isNull(supportAiProviderCredentials.rejectedAt)),
      )
      .returning({ id: supportAiProviderCredentials.id });
    return rows.length > 0;
  }

  /**
   * Clears a rejection. True only on the transition out of rejected: the one recovery. Only
   * for the key the call was made with.
   */
  async clearRejected(
    scope: ScopeContext,
    provider: SupportAiProvider,
    keySetAt: Date,
    now: Date,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .update(supportAiProviderCredentials)
      .set({ rejectedAt: null, updatedAt: now })
      .where(
        and(
          sameKey(tenantId, provider, keySetAt),
          isNotNull(supportAiProviderCredentials.rejectedAt),
        ),
      )
      .returning({ id: supportAiProviderCredentials.id });
    return rows.length > 0;
  }

  /**
   * Whether THIS key is rejected: `REJECTED`, `ACCEPTED`, or null when the key is no longer
   * the stored one. Read by the alert's self-healing path, which must never act for a key an
   * operator has since replaced.
   */
  async rejection(
    scope: ScopeContext,
    provider: SupportAiProvider,
    keySetAt: Date,
  ): Promise<'REJECTED' | 'ACCEPTED' | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select({ rejectedAt: supportAiProviderCredentials.rejectedAt })
      .from(supportAiProviderCredentials)
      .where(sameKey(tenantId, provider, keySetAt))
      .limit(1);
    if (row === undefined) return null;
    return row.rejectedAt === null ? 'ACCEPTED' : 'REJECTED';
  }

  /**
   * Claims the breaker's half-open probe. After the open window a provider gets exactly ONE
   * trial call: this pushes `tripped_until` forward by another window, conditionally on it
   * having passed, so of any number of concurrent callers (on any number of replicas) one
   * row-update succeeds and every other caller still sees the breaker open. The probe's own
   * result then closes it (`recordResult` SUCCESS) or re-opens it.
   */
  async claimProbe(
    scope: ScopeContext,
    provider: SupportAiProvider,
    keySetAt: Date,
    now: Date,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .update(supportAiProviderCredentials)
      .set({
        trippedUntil: new Date(now.getTime() + SUPPORT_AI_BREAKER_OPEN_MS),
        updatedAt: now,
      })
      .where(
        and(
          sameKey(tenantId, provider, keySetAt),
          isNotNull(supportAiProviderCredentials.trippedUntil),
          lte(supportAiProviderCredentials.trippedUntil, now),
        ),
      )
      .returning({ id: supportAiProviderCredentials.id });
    return rows.length > 0;
  }

  /**
   * Claims the right to run a capability test: a conditional UPDATE that stamps
   * `last_tested_at` only when the previous test is at least `cooldownMs` old (or there was
   * none). Two presses, two tabs or two replicas meet at this row; exactly one wins, and the
   * loser learns when the previous test was. Run in the caller's transaction.
   */
  async claimTest(
    scope: ScopeContext,
    provider: SupportAiProvider,
    now: Date,
    cooldownMs: number,
    tx?: unknown,
  ): Promise<
    { readonly claimed: true } | { readonly claimed: false; readonly lastTestedAt: Date | null }
  > {
    const tenantId = requireTenantId(scope);
    const since = new Date(now.getTime() - cooldownMs);
    const rows = await exec(this.db, tx)
      .update(supportAiProviderCredentials)
      .set({ lastTestedAt: now, updatedAt: now })
      .where(
        and(
          eq(supportAiProviderCredentials.tenantId, tenantId),
          eq(supportAiProviderCredentials.provider, provider),
          sql`(${supportAiProviderCredentials.lastTestedAt} IS NULL OR ${supportAiProviderCredentials.lastTestedAt} <= ${since.toISOString()}::timestamptz)`,
        ),
      )
      .returning({ id: supportAiProviderCredentials.id });
    if (rows.length > 0) return { claimed: true };
    const [row] = await exec(this.db, tx)
      .select({ lastTestedAt: supportAiProviderCredentials.lastTestedAt })
      .from(supportAiProviderCredentials)
      .where(
        and(
          eq(supportAiProviderCredentials.tenantId, tenantId),
          eq(supportAiProviderCredentials.provider, provider),
        ),
      );
    return { claimed: false, lastTestedAt: row?.lastTestedAt ?? null };
  }

  async recordTest(
    scope: ScopeContext,
    provider: SupportAiProvider,
    outcome: SupportAiOutcomeKind,
    now: Date,
    failureClass: SupportAiFailureClass | null = null,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.db
      .update(supportAiProviderCredentials)
      .set({
        lastTestOutcome: outcome,
        lastTestFailureClass: outcome === 'OK' ? null : failureClass,
        lastTestedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(supportAiProviderCredentials.tenantId, tenantId),
          eq(supportAiProviderCredentials.provider, provider),
        ),
      );
  }
}

export interface StoredSupportAiConfig {
  readonly config: SupportAiConfigInput;
  /** 0 when no row exists: the tenant runs on `SUPPORT_AI_DEFAULT_CONFIG`. */
  readonly version: number;
}

/** TB4 — the per-tenant configuration row (ADR-0021 optimistic versioning). */
export class DrizzleSupportAiConfigRepository {
  constructor(private readonly db: Database) {}

  async get(scope: ScopeContext, tx?: unknown): Promise<StoredSupportAiConfig> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select()
      .from(supportAiConfigs)
      .where(eq(supportAiConfigs.tenantId, tenantId))
      .limit(1);
    if (row === undefined) return { config: SUPPORT_AI_DEFAULT_CONFIG, version: 0 };
    return {
      version: row.version,
      config: {
        mode: row.mode as SupportAiConfigInput['mode'],
        primary:
          row.primaryProvider === null || row.primaryModel === null
            ? null
            : { provider: row.primaryProvider as SupportAiProvider, model: row.primaryModel },
        fallbacks: (row.fallbacks as SupportAiProviderStep[] | null) ?? [],
        visionEnabled: row.visionEnabled,
        timeoutMs: row.timeoutMs,
        maxOutputChars: row.maxOutputChars,
        sessionReplyBudget: row.sessionReplyBudget,
        maxAutoRepliesPerHour: row.maxAutoRepliesPerHour,
        maxConsecutiveClarifyingQuestions: row.maxConsecutiveClarifyingQuestions,
        cooldownSeconds: row.cooldownSeconds,
        settleDelaySeconds: row.settleDelaySeconds,
        toneInstructions: row.toneInstructions,
        autoTopics: (row.autoTopics ?? []) as SupportAiConfigInput['autoTopics'],
        autoMinConfidence: row.autoMinConfidence as SupportAiConfigInput['autoMinConfidence'],
      },
    };
  }

  /**
   * Writes the configuration when the stored version is `expectedVersion` (0 = no row yet).
   * Returns the new version, or null when somebody else saved first.
   */
  async save(
    scope: ScopeContext,
    input: {
      readonly config: SupportAiConfigInput;
      readonly expectedVersion: number;
      readonly adminId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<number | null> {
    const tenantId = requireTenantId(scope);
    const values = {
      mode: input.config.mode,
      primaryProvider: input.config.primary?.provider ?? null,
      primaryModel: input.config.primary?.model ?? null,
      fallbacks: input.config.fallbacks,
      visionEnabled: input.config.visionEnabled,
      timeoutMs: input.config.timeoutMs,
      maxOutputChars: input.config.maxOutputChars,
      sessionReplyBudget: input.config.sessionReplyBudget,
      maxAutoRepliesPerHour: input.config.maxAutoRepliesPerHour,
      maxConsecutiveClarifyingQuestions: input.config.maxConsecutiveClarifyingQuestions,
      cooldownSeconds: input.config.cooldownSeconds,
      settleDelaySeconds: input.config.settleDelaySeconds,
      toneInstructions: input.config.toneInstructions,
      autoTopics: [...input.config.autoTopics],
      autoMinConfidence: input.config.autoMinConfidence,
      updatedByAdminId: input.adminId,
      updatedAt: input.now,
    };
    const executor = exec(this.db, tx);
    if (input.expectedVersion === 0) {
      const inserted = await executor
        .insert(supportAiConfigs)
        .values({ tenantId, ...values, version: 1, createdAt: input.now })
        .onConflictDoNothing({ target: supportAiConfigs.tenantId })
        .returning({ version: supportAiConfigs.version });
      return inserted[0]?.version ?? null;
    }
    const updated = await executor
      .update(supportAiConfigs)
      .set({ ...values, version: sql`${supportAiConfigs.version} + 1` })
      .where(
        and(
          eq(supportAiConfigs.tenantId, tenantId),
          eq(supportAiConfigs.version, input.expectedVersion),
        ),
      )
      .returning({ version: supportAiConfigs.version });
    return updated[0]?.version ?? null;
  }
}

/** TB4 — telemetry: one row per provider call, never a prompt or a response (ADR-0034 §9). */
export class DrizzleSupportAiRunRecorder {
  constructor(private readonly db: Database) {}

  async record(
    scope: ScopeContext,
    run: {
      readonly id: string;
      readonly conversationId: string | null;
      readonly operation: SupportAiOperation;
      readonly provider: SupportAiProvider;
      readonly model: string;
      readonly attemptIndex: number;
      readonly latencyMs: number;
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
      readonly outcome: SupportAiOutcomeKind;
      readonly failureCode: string | null;
      /** The AI job the call was for, when it was for one. */
      readonly jobId?: string | null;
      /** Why it failed (`supportAiFailureDetailOf`); null for `OK`. */
      readonly failure?: SupportAiFailureDetail | null;
      /** A decision that failed NEXA's schema: the zod issue's path and code, never a value. */
      readonly schemaIssue?: { readonly path: string; readonly code: string } | null;
      readonly now: Date;
    },
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    const failure = run.outcome === 'OK' ? null : (run.failure ?? null);
    await this.db.insert(supportAiRuns).values({
      id: run.id,
      tenantId,
      conversationId: run.conversationId,
      jobId: run.jobId ?? null,
      failureClass: failure?.failureClass ?? null,
      httpStatus: failure?.httpStatus ?? null,
      providerErrorCode: failure?.providerErrorCode?.slice(0, 64) ?? null,
      providerErrorType: failure?.providerErrorType?.slice(0, 64) ?? null,
      providerErrorParam: failure?.providerErrorParam?.slice(0, 64) ?? null,
      schemaIssuePath: run.schemaIssue?.path.slice(0, 128) ?? null,
      schemaIssueCode: run.schemaIssue?.code.slice(0, 64) ?? null,
      operation: run.operation,
      provider: run.provider,
      model: run.model.slice(0, 128),
      attemptIndex: run.attemptIndex,
      latencyMs: Math.max(0, Math.round(run.latencyMs)),
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      outcome: run.outcome,
      failureCode: run.failureCode?.slice(0, 200) ?? null,
      createdAt: run.now,
    });
  }

  /**
   * The DECIDING call of each job — its last attempt — as an operator's diagnosis. A job with
   * no run (nothing could be called) is absent; the job's own `failure_class` says why.
   */
  async lastForJobs(
    scope: ScopeContext,
    jobIds: readonly string[],
  ): Promise<
    ReadonlyMap<
      string,
      Omit<SupportAiFailureDiagnostic, 'failureClass'> & {
        readonly failureClass: SupportAiFailureClass | null;
      }
    >
  > {
    const tenantId = requireTenantId(scope);
    if (jobIds.length === 0) return new Map();
    const rows = await this.db
      .selectDistinctOn([supportAiRuns.jobId])
      .from(supportAiRuns)
      .where(and(eq(supportAiRuns.tenantId, tenantId), inArray(supportAiRuns.jobId, [...jobIds])))
      .orderBy(
        supportAiRuns.jobId,
        desc(supportAiRuns.createdAt),
        desc(supportAiRuns.attemptIndex),
      );
    return new Map(
      rows.map((row) => [
        row.jobId as string,
        {
          failureClass: row.failureClass as SupportAiFailureClass | null,
          operation: row.operation as SupportAiOperation,
          provider: row.provider as SupportAiProvider,
          model: row.model,
          attemptIndex: row.attemptIndex,
          outcome: row.outcome as SupportAiOutcomeKind,
          httpStatus: row.httpStatus,
          providerErrorCode: row.providerErrorCode,
          providerErrorType: row.providerErrorType,
          providerErrorParam: row.providerErrorParam,
          issuePath: row.schemaIssuePath,
          issueCode: row.schemaIssueCode,
          latencyMs: row.latencyMs,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          at: row.createdAt.toISOString(),
        },
      ]),
    );
  }

  async usage(scope: ScopeContext, since: Date) {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select({
        provider: supportAiRuns.provider,
        model: supportAiRuns.model,
        operation: supportAiRuns.operation,
        calls: count(),
        failures: sql<number>`count(*) FILTER (WHERE ${supportAiRuns.outcome} <> 'OK')`.mapWith(
          Number,
        ),
        inputTokens: sql<number>`COALESCE(sum(${supportAiRuns.inputTokens}), 0)`.mapWith(Number),
        outputTokens: sql<number>`COALESCE(sum(${supportAiRuns.outputTokens}), 0)`.mapWith(Number),
        avgLatencyMs: sql<number>`COALESCE(round(avg(${supportAiRuns.latencyMs})), 0)`.mapWith(
          Number,
        ),
      })
      .from(supportAiRuns)
      .where(and(eq(supportAiRuns.tenantId, tenantId), gte(supportAiRuns.createdAt, since)))
      .groupBy(supportAiRuns.provider, supportAiRuns.model, supportAiRuns.operation)
      .orderBy(desc(count()));
    return rows.map((row) => ({
      provider: row.provider as SupportAiProvider,
      model: row.model,
      operation: row.operation as SupportAiOperation,
      calls: Number(row.calls),
      failures: row.failures,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      avgLatencyMs: row.avgLatencyMs,
    }));
  }
}
