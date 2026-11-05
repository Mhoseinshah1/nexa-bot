import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import {
  CAPACITY_BOT_LIMIT_PRESSURE_CODE,
  type CapacityResource,
  type HostedBotState,
  type ScopeContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  backupRuns,
  hostedBots,
  hostingRecoveryCodes,
  hostingSessions,
  hostingTotpFactors,
  operationalEvents,
} from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  HostedBotRow,
  HostingFactorRow,
  HostingRepository,
  HostingSessionRow,
} from '../application/ports.js';

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

type BotRow = typeof hostedBots.$inferSelect;
type FactorRow = typeof hostingTotpFactors.$inferSelect;

function toBot(row: BotRow): HostedBotRow {
  return {
    tenantId: row.tenantId,
    hostedTenantId: row.hostedTenantId,
    state: row.state as HostedBotState,
    expiresAt: row.expiresAt,
    ownerAdminId: row.ownerAdminId,
    createdByAdminId: row.createdByAdminId,
    createdAt: row.createdAt,
    stateChangedAt: row.stateChangedAt,
    deletedAt: row.deletedAt,
    purgedAt: row.purgedAt,
  };
}

function toFactor(row: FactorRow): HostingFactorRow {
  return {
    id: row.id,
    adminId: row.adminId,
    state: row.state as 'PENDING' | 'ACTIVE',
    ciphertext: row.totpSecretCiphertext,
    keyId: row.totpSecretKeyId,
    lastUsedStep: row.lastUsedStep,
    failedAttempts: row.failedAttempts,
    lockedUntil: row.lockedUntil,
    enrolledSessionId: row.enrolledSessionId,
    createdAt: row.createdAt,
  };
}

/**
 * Phase 6A PR-3: the creator panel's rows, ALL owned by the installation tenant. Every
 * method is tenant-scoped through `requireTenantId`; no method here reads a hosted tenant's
 * own rows (that is `DrizzleHostedTenantSystemPath`).
 */
export class DrizzleHostingRepository implements HostingRepository {
  constructor(private readonly db: Database) {}

  async listHosted(scope: ScopeContext, tx?: unknown): Promise<readonly HostedBotRow[]> {
    const rows = await executorOf(this.db, tx)
      .select()
      .from(hostedBots)
      .where(eq(hostedBots.tenantId, requireTenantId(scope)))
      .orderBy(asc(hostedBots.createdAt), asc(hostedBots.hostedTenantId));
    return rows.map(toBot);
  }

  async findHosted(scope: ScopeContext, hostedTenantId: string, tx?: unknown, lock = false) {
    const query = executorOf(this.db, tx)
      .select()
      .from(hostedBots)
      .where(
        and(
          eq(hostedBots.tenantId, requireTenantId(scope)),
          eq(hostedBots.hostedTenantId, hostedTenantId),
        ),
      )
      .limit(1);
    const [row] = await (lock && tx !== undefined ? query.for('update') : query);
    return row ? toBot(row) : null;
  }

  async insertHosted(
    scope: ScopeContext,
    row: Parameters<HostingRepository['insertHosted']>[1],
    tx: unknown,
  ): Promise<void> {
    await executorOf(this.db, tx)
      .insert(hostedBots)
      .values({
        tenantId: requireTenantId(scope),
        hostedTenantId: row.hostedTenantId,
        state: row.state,
        expiresAt: row.expiresAt,
        ownerAdminId: row.ownerAdminId,
        createdByAdminId: row.createdByAdminId,
        createdAt: row.createdAt,
        stateChangedAt: row.createdAt,
        updatedAt: row.createdAt,
      });
  }

  async transition(
    scope: ScopeContext,
    hostedTenantId: string,
    from: readonly HostedBotState[],
    to: HostedBotState,
    now: Date,
    tx: unknown,
  ): Promise<HostedBotRow | null> {
    // The timestamps follow the state, so the table's CHECKs hold: deleted_at is set on the
    // way into DELETED (kept into PURGED) and cleared on a restore; purged_at only on PURGED.
    const deletedAt =
      to === 'DELETED'
        ? sql`COALESCE(${hostedBots.deletedAt}, ${now.toISOString()}::timestamptz)`
        : to === 'PURGED'
          ? hostedBots.deletedAt
          : sql`NULL`;
    const [row] = await executorOf(this.db, tx)
      .update(hostedBots)
      .set({
        state: to,
        stateChangedAt: now,
        updatedAt: now,
        deletedAt,
        purgedAt: to === 'PURGED' ? now : null,
      })
      .where(
        and(
          eq(hostedBots.tenantId, requireTenantId(scope)),
          eq(hostedBots.hostedTenantId, hostedTenantId),
          inArray(hostedBots.state, [...from]),
        ),
      )
      .returning();
    return row ? toBot(row) : null;
  }

  async setExpiry(
    scope: ScopeContext,
    hostedTenantId: string,
    expiresAt: Date | null,
    now: Date,
    tx: unknown,
  ): Promise<void> {
    await executorOf(this.db, tx)
      .update(hostedBots)
      .set({ expiresAt, updatedAt: now })
      .where(
        and(
          eq(hostedBots.tenantId, requireTenantId(scope)),
          eq(hostedBots.hostedTenantId, hostedTenantId),
        ),
      );
  }

  async claimExpired(scope: ScopeContext, now: Date, limit: number, tx: unknown) {
    const rows = await executorOf(this.db, tx)
      .select()
      .from(hostedBots)
      .where(
        and(
          eq(hostedBots.tenantId, requireTenantId(scope)),
          eq(hostedBots.state, 'ACTIVE'),
          isNotNull(hostedBots.expiresAt),
          lte(hostedBots.expiresAt, now),
        ),
      )
      .orderBy(asc(hostedBots.expiresAt), asc(hostedBots.hostedTenantId))
      .limit(limit)
      .for('update', { skipLocked: true });
    return rows.map(toBot);
  }

  // --- factor --------------------------------------------------------------------------

  async findFactor(scope: ScopeContext, adminId: string, tx?: unknown) {
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(hostingTotpFactors)
      .where(
        and(
          eq(hostingTotpFactors.tenantId, requireTenantId(scope)),
          eq(hostingTotpFactors.adminId, adminId),
        ),
      )
      .limit(1);
    return row ? toFactor(row) : null;
  }

  async lockFactor(scope: ScopeContext, adminId: string, tx: unknown) {
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(hostingTotpFactors)
      .where(
        and(
          eq(hostingTotpFactors.tenantId, requireTenantId(scope)),
          eq(hostingTotpFactors.adminId, adminId),
        ),
      )
      .for('update')
      .limit(1);
    return row ? toFactor(row) : null;
  }

  async replaceWithPending(
    scope: ScopeContext,
    input: Parameters<HostingRepository['replaceWithPending']>[1],
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);
    // Only a PENDING row is replaced; the caller refused an ACTIVE one under the lock.
    await executor
      .delete(hostingTotpFactors)
      .where(
        and(
          eq(hostingTotpFactors.tenantId, tenantId),
          eq(hostingTotpFactors.adminId, input.adminId),
          eq(hostingTotpFactors.state, 'PENDING'),
        ),
      );
    await executor.insert(hostingTotpFactors).values({
      id: input.id,
      tenantId,
      adminId: input.adminId,
      state: 'PENDING',
      totpSecretCiphertext: input.ciphertext,
      totpSecretKeyId: input.keyId,
      enrolledSessionId: input.enrolledSessionId,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  async deleteFactor(scope: ScopeContext, factorId: string, tx: unknown): Promise<void> {
    await executorOf(this.db, tx)
      .delete(hostingTotpFactors)
      .where(
        and(
          eq(hostingTotpFactors.tenantId, requireTenantId(scope)),
          eq(hostingTotpFactors.id, factorId),
        ),
      );
  }

  async activate(scope: ScopeContext, factorId: string, step: number, now: Date, tx: unknown) {
    const rows = await executorOf(this.db, tx)
      .update(hostingTotpFactors)
      .set({
        state: 'ACTIVE',
        activatedAt: now,
        lastUsedStep: step,
        failedAttempts: 0,
        lockedUntil: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(hostingTotpFactors.tenantId, requireTenantId(scope)),
          eq(hostingTotpFactors.id, factorId),
          eq(hostingTotpFactors.state, 'PENDING'),
        ),
      )
      .returning({ id: hostingTotpFactors.id });
    return rows.length === 1;
  }

  async consumeStep(scope: ScopeContext, factorId: string, step: number, now: Date, tx: unknown) {
    // The replay rule as one statement: only a step strictly after the last one.
    const rows = await executorOf(this.db, tx)
      .update(hostingTotpFactors)
      .set({ lastUsedStep: step, updatedAt: now })
      .where(
        and(
          eq(hostingTotpFactors.tenantId, requireTenantId(scope)),
          eq(hostingTotpFactors.id, factorId),
          eq(hostingTotpFactors.state, 'ACTIVE'),
          or(isNull(hostingTotpFactors.lastUsedStep), lt(hostingTotpFactors.lastUsedStep, step)),
        ),
      )
      .returning({ id: hostingTotpFactors.id });
    return rows.length === 1;
  }

  async setFailures(
    scope: ScopeContext,
    factorId: string,
    input: {
      readonly failedAttempts: number;
      readonly lockedUntil: Date | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void> {
    await executorOf(this.db, tx)
      .update(hostingTotpFactors)
      .set({
        failedAttempts: input.failedAttempts,
        lockedUntil: input.lockedUntil,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(hostingTotpFactors.tenantId, requireTenantId(scope)),
          eq(hostingTotpFactors.id, factorId),
        ),
      );
  }

  // --- recovery codes --------------------------------------------------------------------

  async replaceRecoveryCodes(
    scope: ScopeContext,
    adminId: string,
    codes: readonly { readonly id: string; readonly hash: string }[],
    now: Date,
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);
    // The old set dies in the transaction that writes the new one: never two valid sets.
    await executor
      .delete(hostingRecoveryCodes)
      .where(
        and(eq(hostingRecoveryCodes.tenantId, tenantId), eq(hostingRecoveryCodes.adminId, adminId)),
      );
    if (codes.length === 0) return;
    await executor.insert(hostingRecoveryCodes).values(
      codes.map((code) => ({
        id: code.id,
        tenantId,
        adminId,
        codeHash: code.hash,
        createdAt: now,
      })),
    );
  }

  async consumeRecoveryCode(
    scope: ScopeContext,
    adminId: string,
    hash: string,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const rows = await executorOf(this.db, tx)
      .update(hostingRecoveryCodes)
      .set({ usedAt: now })
      .where(
        and(
          eq(hostingRecoveryCodes.tenantId, requireTenantId(scope)),
          eq(hostingRecoveryCodes.adminId, adminId),
          eq(hostingRecoveryCodes.codeHash, hash),
          isNull(hostingRecoveryCodes.usedAt),
        ),
      )
      .returning({ id: hostingRecoveryCodes.id });
    return rows.length === 1;
  }

  async countUnusedRecoveryCodes(scope: ScopeContext, adminId: string, tx?: unknown) {
    const [row] = await executorOf(this.db, tx)
      .select({ count: sql<number>`count(*)::int` })
      .from(hostingRecoveryCodes)
      .where(
        and(
          eq(hostingRecoveryCodes.tenantId, requireTenantId(scope)),
          eq(hostingRecoveryCodes.adminId, adminId),
          isNull(hostingRecoveryCodes.usedAt),
        ),
      );
    return row?.count ?? 0;
  }

  // --- sessions --------------------------------------------------------------------------

  async createSession(
    scope: ScopeContext,
    input: Parameters<HostingRepository['createSession']>[1],
    tx: unknown,
  ): Promise<void> {
    await executorOf(this.db, tx)
      .insert(hostingSessions)
      .values({
        id: input.id,
        tenantId: requireTenantId(scope),
        adminId: input.adminId,
        adminSessionId: input.adminSessionId,
        tokenHash: input.tokenHash,
        createdAt: input.now,
        expiresAt: input.expiresAt,
      });
  }

  async findLiveSession(
    scope: ScopeContext,
    input: Parameters<HostingRepository['findLiveSession']>[1],
    tx?: unknown,
  ): Promise<HostingSessionRow | null> {
    const query = executorOf(this.db, tx)
      .select({
        id: hostingSessions.id,
        adminId: hostingSessions.adminId,
        adminSessionId: hostingSessions.adminSessionId,
        expiresAt: hostingSessions.expiresAt,
      })
      .from(hostingSessions)
      .where(
        and(
          eq(hostingSessions.tenantId, requireTenantId(scope)),
          eq(hostingSessions.tokenHash, input.tokenHash),
          eq(hostingSessions.adminId, input.adminId),
          eq(hostingSessions.adminSessionId, input.adminSessionId),
          isNull(hostingSessions.revokedAt),
          gt(hostingSessions.expiresAt, input.now),
        ),
      )
      .limit(1);
    // Inside a write, held FOR SHARE: a close that commits meanwhile waits for this write.
    const [row] = await (tx !== undefined ? query.for('share') : query);
    return row ?? null;
  }

  async revokeSessions(
    scope: ScopeContext,
    input: { readonly adminId: string; readonly adminSessionId?: string; readonly now: Date },
    tx?: unknown,
  ): Promise<number> {
    const rows = await executorOf(this.db, tx)
      .update(hostingSessions)
      .set({ revokedAt: input.now })
      .where(
        and(
          eq(hostingSessions.tenantId, requireTenantId(scope)),
          eq(hostingSessions.adminId, input.adminId),
          input.adminSessionId === undefined
            ? undefined
            : eq(hostingSessions.adminSessionId, input.adminSessionId),
          isNull(hostingSessions.revokedAt),
          gt(hostingSessions.expiresAt, input.now),
        ),
      )
      .returning({ id: hostingSessions.id });
    return rows.length;
  }

  // --- readings ----------------------------------------------------------------------------

  async limitHitsSince(scope: ScopeContext, since: Date) {
    // The owner's pressure alerts are recorded on the INSTALLATION tenant with the bot in
    // their context (`LimitPressureReporter`), so this is the installation's own rows.
    const tenantKey = sql<string>`${operationalEvents.context} ->> 'tenantId'`;
    const resourceKey = sql<string>`${operationalEvents.context} ->> 'resource'`;
    const rows = await this.db
      .select({
        tenantId: tenantKey,
        resource: resourceKey,
        hits: sql<number>`COALESCE(SUM(${operationalEvents.occurrenceCount}), 0)::int`,
      })
      .from(operationalEvents)
      .where(
        and(
          eq(operationalEvents.tenantId, requireTenantId(scope)),
          eq(operationalEvents.code, CAPACITY_BOT_LIMIT_PRESSURE_CODE),
          gte(operationalEvents.lastSeenAt, since),
        ),
      )
      .groupBy(tenantKey, resourceKey);
    const out = new Map<string, Map<CapacityResource, number>>();
    for (const row of rows) {
      if (row.tenantId === null || row.resource === null) continue;
      const own = out.get(row.tenantId) ?? new Map<CapacityResource, number>();
      own.set(row.resource as CapacityResource, row.hits);
      out.set(row.tenantId, own);
    }
    return out;
  }

  async lastSucceededBackupAt(): Promise<Date | null> {
    // `backup_runs` is installation-wide (one dump holds every tenant); it has no tenant.
    const [row] = await this.db
      .select({ finishedAt: backupRuns.finishedAt })
      .from(backupRuns)
      .where(and(eq(backupRuns.state, 'SUCCEEDED'), isNotNull(backupRuns.finishedAt)))
      .orderBy(desc(backupRuns.finishedAt))
      .limit(1);
    return row?.finishedAt ?? null;
  }
}
