import { and, count, desc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  SUPPORT_AI_BREAKER_OPEN_MS,
  SUPPORT_AI_BREAKER_THRESHOLD,
  SUPPORT_AI_DEFAULT_CONFIG,
  type ScopeContext,
  type SecretCipher,
  type SupportAiConfigInput,
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

export interface SupportAiCredentialState {
  readonly provider: SupportAiProvider;
  readonly setAt: Date;
  readonly region: 'INTERNATIONAL' | 'CHINA' | null;
  readonly consecutiveFailures: number;
  readonly trippedUntil: Date | null;
  readonly lastTestOutcome: SupportAiOutcomeKind | null;
  readonly lastTestedAt: Date | null;
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
        lastTestedAt: supportAiProviderCredentials.lastTestedAt,
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
      lastTestedAt: row.lastTestedAt,
    }));
  }

  /** The decrypted key, scoped by tenant AND provider, or null when none is set. */
  async read(scope: ScopeContext, provider: SupportAiProvider): Promise<SupportAiCredential | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select({
        id: supportAiProviderCredentials.id,
        ciphertext: supportAiProviderCredentials.apiKeyCiphertext,
        keyId: supportAiProviderCredentials.apiKeyKeyId,
        region: supportAiProviderCredentials.region,
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
    return { apiKey, region: row.region as SupportAiCredential['region'] };
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
      .select({ id: supportAiProviderCredentials.id, rejectedAt: supportAiProviderCredentials.rejectedAt })
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
      .where(and(eq(supportAiProviderCredentials.tenantId, tenantId), eq(supportAiProviderCredentials.id, id)));
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
      .returning({ id: supportAiProviderCredentials.id, rejectedAt: supportAiProviderCredentials.rejectedAt });
    return { removed: rows.length > 0, wasRejected: rows[0]?.rejectedAt != null };
  }

  /**
   * The breaker (ADR-0034 §3, state HERE — TB0 review F4). A success closes it; a transient
   * failure counts, and the THRESHOLD-th consecutive one opens it for
   * `SUPPORT_AI_BREAKER_OPEN_MS`. One conditional statement each, so two replicas recording at
   * once still count correctly. Returns the state after the write.
   */
  async recordResult(
    scope: ScopeContext,
    provider: SupportAiProvider,
    result: 'SUCCESS' | 'TRANSIENT_FAILURE',
    now: Date,
  ): Promise<{ readonly trippedUntil: Date | null; readonly consecutiveFailures: number } | null> {
    const tenantId = requireTenantId(scope);
    const where = and(
      eq(supportAiProviderCredentials.tenantId, tenantId),
      eq(supportAiProviderCredentials.provider, provider),
    );
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
   * moment `credential_rejected` is raised.
   */
  async markRejected(scope: ScopeContext, provider: SupportAiProvider, now: Date): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .update(supportAiProviderCredentials)
      .set({ rejectedAt: now, updatedAt: now })
      .where(
        and(
          eq(supportAiProviderCredentials.tenantId, tenantId),
          eq(supportAiProviderCredentials.provider, provider),
          isNull(supportAiProviderCredentials.rejectedAt),
        ),
      )
      .returning({ id: supportAiProviderCredentials.id });
    return rows.length > 0;
  }

  /** Clears a rejection. True only on the transition out of rejected: the one recovery. */
  async clearRejected(scope: ScopeContext, provider: SupportAiProvider, now: Date): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .update(supportAiProviderCredentials)
      .set({ rejectedAt: null, updatedAt: now })
      .where(
        and(
          eq(supportAiProviderCredentials.tenantId, tenantId),
          eq(supportAiProviderCredentials.provider, provider),
          isNotNull(supportAiProviderCredentials.rejectedAt),
        ),
      )
      .returning({ id: supportAiProviderCredentials.id });
    return rows.length > 0;
  }

  async recordTest(
    scope: ScopeContext,
    provider: SupportAiProvider,
    outcome: SupportAiOutcomeKind,
    now: Date,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.db
      .update(supportAiProviderCredentials)
      .set({ lastTestOutcome: outcome, lastTestedAt: now, updatedAt: now })
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
        maxConsecutiveReplies: row.maxConsecutiveReplies,
        cooldownSeconds: row.cooldownSeconds,
        settleDelaySeconds: row.settleDelaySeconds,
        toneInstructions: row.toneInstructions,
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
      maxConsecutiveReplies: input.config.maxConsecutiveReplies,
      cooldownSeconds: input.config.cooldownSeconds,
      settleDelaySeconds: input.config.settleDelaySeconds,
      toneInstructions: input.config.toneInstructions,
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
      .where(and(eq(supportAiConfigs.tenantId, tenantId), eq(supportAiConfigs.version, input.expectedVersion)))
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
      readonly now: Date;
    },
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.db.insert(supportAiRuns).values({
      id: run.id,
      tenantId,
      conversationId: run.conversationId,
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

  async usage(scope: ScopeContext, since: Date) {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select({
        provider: supportAiRuns.provider,
        model: supportAiRuns.model,
        operation: supportAiRuns.operation,
        calls: count(),
        failures: sql<number>`count(*) FILTER (WHERE ${supportAiRuns.outcome} <> 'OK')`.mapWith(Number),
        inputTokens: sql<number>`COALESCE(sum(${supportAiRuns.inputTokens}), 0)`.mapWith(Number),
        outputTokens: sql<number>`COALESCE(sum(${supportAiRuns.outputTokens}), 0)`.mapWith(Number),
        avgLatencyMs: sql<number>`COALESCE(round(avg(${supportAiRuns.latencyMs})), 0)`.mapWith(Number),
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
