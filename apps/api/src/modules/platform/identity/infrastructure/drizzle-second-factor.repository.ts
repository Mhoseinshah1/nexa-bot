import { and, count, desc, eq, inArray, isNull, lt, min, or, sql } from 'drizzle-orm';
import { asId, type AdminId, type ScopeContext, type TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  adminBackupCodes,
  adminLoginChallenges,
  adminTotpFactors,
  auditLogs,
} from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  LoginChallengeRepository,
  SecondFactorRepository,
  SecurityEventReader,
  SecurityEventRecord,
  StoredLoginChallenge,
  StoredTotpFactor,
  StoredTotpState,
} from '../application/ports.js';

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

type FactorRow = typeof adminTotpFactors.$inferSelect;

function toFactor(row: FactorRow): StoredTotpFactor {
  return {
    id: row.id,
    state: row.state as StoredTotpState,
    ciphertext: row.totpSecretCiphertext,
    keyId: row.totpSecretKeyId,
    lastUsedStep: row.lastUsedStep,
    enrolledSessionId: row.enrolledSessionId,
    activationAttempts: row.activationAttempts,
    createdAt: row.createdAt,
    activatedAt: row.activatedAt,
  };
}

/**
 * The second factor's rows (Phase D2). Every method is tenant-scoped through
 * `requireTenantId`; the ciphertext leaves this file only on the way to `SecretCipher`.
 */
export class DrizzleSecondFactorRepository implements SecondFactorRepository {
  constructor(private readonly db: Database) {}

  async findFactor(scope: ScopeContext, adminId: AdminId, tx?: unknown) {
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(adminTotpFactors)
      .where(
        and(
          eq(adminTotpFactors.tenantId, requireTenantId(scope)),
          eq(adminTotpFactors.adminId, adminId),
        ),
      )
      .limit(1);
    return row ? toFactor(row) : null;
  }

  async lockFactor(scope: ScopeContext, adminId: AdminId, tx: unknown) {
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(adminTotpFactors)
      .where(
        and(
          eq(adminTotpFactors.tenantId, requireTenantId(scope)),
          eq(adminTotpFactors.adminId, adminId),
        ),
      )
      .for('update')
      .limit(1);
    return row ? toFactor(row) : null;
  }

  async replaceWithPending(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly adminId: AdminId;
      readonly ciphertext: string;
      readonly keyId: string;
      readonly enrolledSessionId: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);
    await executor
      .delete(adminTotpFactors)
      .where(
        and(eq(adminTotpFactors.tenantId, tenantId), eq(adminTotpFactors.adminId, input.adminId)),
      );
    await executor.insert(adminTotpFactors).values({
      id: input.id,
      tenantId,
      adminId: input.adminId,
      state: 'PENDING',
      totpSecretCiphertext: input.ciphertext,
      totpSecretKeyId: input.keyId,
      lastUsedStep: null,
      enrolledSessionId: input.enrolledSessionId,
      activationAttempts: 0,
      createdAt: input.now,
      activatedAt: null,
      updatedAt: input.now,
    });
  }

  async countActivationAttempt(scope: ScopeContext, adminId: AdminId): Promise<number | null> {
    const [row] = await this.db
      .update(adminTotpFactors)
      .set({ activationAttempts: sql`${adminTotpFactors.activationAttempts} + 1` })
      .where(
        and(
          eq(adminTotpFactors.tenantId, requireTenantId(scope)),
          eq(adminTotpFactors.adminId, adminId),
          eq(adminTotpFactors.state, 'PENDING'),
        ),
      )
      .returning({ attempts: adminTotpFactors.activationAttempts });
    return row?.attempts ?? null;
  }

  async discardPending(scope: ScopeContext, adminId: AdminId): Promise<boolean> {
    const rows = await this.db
      .delete(adminTotpFactors)
      .where(
        and(
          eq(adminTotpFactors.tenantId, requireTenantId(scope)),
          eq(adminTotpFactors.adminId, adminId),
          eq(adminTotpFactors.state, 'PENDING'),
        ),
      )
      .returning({ id: adminTotpFactors.id });
    return rows.length > 0;
  }

  async activate(
    scope: ScopeContext,
    factorId: string,
    step: number,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const rows = await executorOf(this.db, tx)
      .update(adminTotpFactors)
      .set({
        state: 'ACTIVE',
        activatedAt: now,
        lastUsedStep: step,
        enrolledSessionId: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(adminTotpFactors.tenantId, requireTenantId(scope)),
          eq(adminTotpFactors.id, factorId),
          eq(adminTotpFactors.state, 'PENDING'),
        ),
      )
      .returning({ id: adminTotpFactors.id });
    return rows.length === 1;
  }

  async consumeStep(
    scope: ScopeContext,
    factorId: string,
    step: number,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    /*
     * THE replay rule, as one statement. A step is used once: the predicate admits only a
     * step strictly after the last one recorded, so two requests carrying the same code
     * cannot both pass, and an older code cannot be accepted after a newer one was —
     * whatever any process believed when it checked.
     */
    const rows = await executorOf(this.db, tx)
      .update(adminTotpFactors)
      .set({ lastUsedStep: step, updatedAt: now })
      .where(
        and(
          eq(adminTotpFactors.tenantId, requireTenantId(scope)),
          eq(adminTotpFactors.id, factorId),
          eq(adminTotpFactors.state, 'ACTIVE'),
          or(isNull(adminTotpFactors.lastUsedStep), lt(adminTotpFactors.lastUsedStep, step)),
        ),
      )
      .returning({ id: adminTotpFactors.id });
    return rows.length === 1;
  }

  async deleteFactor(scope: ScopeContext, adminId: AdminId, tx: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);
    await executor
      .delete(adminBackupCodes)
      .where(and(eq(adminBackupCodes.tenantId, tenantId), eq(adminBackupCodes.adminId, adminId)));
    const rows = await executor
      .delete(adminTotpFactors)
      .where(and(eq(adminTotpFactors.tenantId, tenantId), eq(adminTotpFactors.adminId, adminId)))
      .returning({ id: adminTotpFactors.id });
    return rows.length > 0;
  }

  async replaceBackupCodes(
    scope: ScopeContext,
    adminId: AdminId,
    codes: readonly { readonly id: string; readonly codeHash: string }[],
    now: Date,
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);
    // The old generation goes in the SAME transaction the new one arrives in: there is
    // no instant at which two sets are valid, and none at which neither is.
    await executor
      .delete(adminBackupCodes)
      .where(and(eq(adminBackupCodes.tenantId, tenantId), eq(adminBackupCodes.adminId, adminId)));
    if (codes.length === 0) return;
    await executor.insert(adminBackupCodes).values(
      codes.map((code) => ({
        id: code.id,
        tenantId,
        adminId,
        codeHash: code.codeHash,
        createdAt: now,
        usedAt: null,
      })),
    );
  }

  async consumeBackupCode(
    scope: ScopeContext,
    adminId: AdminId,
    codeHash: string,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    // One statement: a code is spent once however many requests race it.
    const rows = await executorOf(this.db, tx)
      .update(adminBackupCodes)
      .set({ usedAt: now })
      .where(
        and(
          eq(adminBackupCodes.tenantId, requireTenantId(scope)),
          eq(adminBackupCodes.adminId, adminId),
          eq(adminBackupCodes.codeHash, codeHash),
          isNull(adminBackupCodes.usedAt),
        ),
      )
      .returning({ id: adminBackupCodes.id });
    return rows.length === 1;
  }

  async backupCodeSummary(scope: ScopeContext, adminId: AdminId, tx?: unknown) {
    const [row] = await executorOf(this.db, tx)
      .select({
        remaining: sql<number>`count(*) FILTER (WHERE ${adminBackupCodes.usedAt} IS NULL)`.mapWith(
          Number,
        ),
        total: count(),
        generatedAt: min(adminBackupCodes.createdAt),
      })
      .from(adminBackupCodes)
      .where(
        and(
          eq(adminBackupCodes.tenantId, requireTenantId(scope)),
          eq(adminBackupCodes.adminId, adminId),
        ),
      );
    return {
      remaining: row?.remaining ?? 0,
      generatedAt: row !== undefined && row.total > 0 ? (row.generatedAt ?? null) : null,
    };
  }
}

type ChallengeRow = typeof adminLoginChallenges.$inferSelect;

function toChallenge(row: ChallengeRow): StoredLoginChallenge {
  return {
    id: row.id,
    tenantId: row.tenantId,
    adminId: asId<'AdminId'>(row.adminId),
    credentialFingerprint: row.credentialFingerprint,
    expiresAt: row.expiresAt,
    attempts: row.attempts,
    consumedAt: row.consumedAt,
    ip: row.ip,
    userAgent: row.userAgent,
  };
}

export class DrizzleLoginChallengeRepository implements LoginChallengeRepository {
  constructor(private readonly db: Database) {}

  async create(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly adminId: AdminId;
      readonly tokenHash: string;
      readonly credentialFingerprint: string;
      readonly issuedAt: Date;
      readonly expiresAt: Date;
      readonly ip: string | null;
      readonly userAgent: string | null;
    },
    tx?: unknown,
  ): Promise<void> {
    await executorOf(this.db, tx)
      .insert(adminLoginChallenges)
      .values({ ...input, tenantId: requireTenantId(scope), attempts: 0, consumedAt: null });
  }

  async findByTokenHash(tokenHash: string): Promise<StoredLoginChallenge | null> {
    const [row] = await this.db
      .select()
      .from(adminLoginChallenges)
      .where(eq(adminLoginChallenges.tokenHash, tokenHash))
      .limit(1);
    return row ? toChallenge(row) : null;
  }

  async lock(scope: ScopeContext, id: string, tx: unknown): Promise<StoredLoginChallenge | null> {
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(adminLoginChallenges)
      .where(
        and(
          eq(adminLoginChallenges.tenantId, requireTenantId(scope)),
          eq(adminLoginChallenges.id, id),
        ),
      )
      .for('update')
      .limit(1);
    return row ? toChallenge(row) : null;
  }

  async countAttempt(scope: ScopeContext, id: string): Promise<number> {
    const [row] = await this.db
      .update(adminLoginChallenges)
      .set({ attempts: sql`${adminLoginChallenges.attempts} + 1` })
      .where(
        and(
          eq(adminLoginChallenges.tenantId, requireTenantId(scope)),
          eq(adminLoginChallenges.id, id),
        ),
      )
      .returning({ attempts: adminLoginChallenges.attempts });
    return row?.attempts ?? Number.MAX_SAFE_INTEGER;
  }

  async consume(scope: ScopeContext, id: string, now: Date, tx: unknown): Promise<boolean> {
    const rows = await executorOf(this.db, tx)
      .update(adminLoginChallenges)
      .set({ consumedAt: now })
      .where(
        and(
          eq(adminLoginChallenges.tenantId, requireTenantId(scope)),
          eq(adminLoginChallenges.id, id),
          isNull(adminLoginChallenges.consumedAt),
        ),
      )
      .returning({ id: adminLoginChallenges.id });
    return rows.length === 1;
  }

  async purgeExpiredBefore(cutoff: Date, limit: number): Promise<number> {
    const rows = await this.db
      .delete(adminLoginChallenges)
      .where(
        sql`ctid IN (
          SELECT ctid FROM ${adminLoginChallenges}
          WHERE ${adminLoginChallenges.expiresAt} < ${cutoff}
          LIMIT ${limit}
        )`,
      )
      .returning({ id: adminLoginChallenges.id });
    return rows.length;
  }
}

/**
 * An administrator's own security history, read from `audit_logs` through
 * `audit_logs_entity_idx`. Not a log browser: one entity, a closed list of actions,
 * bounded. The IP and user agent ARE selected here, unlike the entity-history reader,
 * because the person reading is the account holder looking for a sign-in they do not
 * recognise — and those two columns are how they would.
 */
export class DrizzleSecurityEventReader implements SecurityEventReader {
  constructor(private readonly db: Database) {}

  async forAdmin(
    scope: TenantContext,
    adminId: AdminId,
    actions: readonly string[],
    limit: number,
  ): Promise<readonly SecurityEventRecord[]> {
    if (actions.length === 0) return [];
    const rows = await this.db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        result: auditLogs.result,
        occurredAt: auditLogs.occurredAt,
        actorId: auditLogs.actorId,
        actorLabel: auditLogs.actorLabel,
        ip: auditLogs.ip,
        userAgent: auditLogs.userAgent,
        after: auditLogs.after,
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, requireTenantId(scope)),
          eq(auditLogs.entityType, 'Admin'),
          eq(auditLogs.entityId, adminId),
          inArray(auditLogs.action, [...actions]),
        ),
      )
      .orderBy(desc(auditLogs.occurredAt), desc(auditLogs.id))
      .limit(limit);
    return rows.map((row) => ({
      ...row,
      after:
        row.after !== null && typeof row.after === 'object' && !Array.isArray(row.after)
          ? (row.after as Record<string, unknown>)
          : null,
    }));
  }
}
