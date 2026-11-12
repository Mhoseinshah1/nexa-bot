import { and, desc, eq, gt, gte, isNull, lt, ne, sql } from 'drizzle-orm';
import {
  RESELLER_WEB_SECOND_FACTOR_MAX_ATTEMPTS,
  type ResellerPreferences,
  type ResellerWebSessionEndReason,
  type ResellerWebSessionState,
  type ResellerWebTotpState,
  type TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  resellerWebDevices,
  resellerWebFileFetches,
  resellerWebLoginTokens,
  resellerWebPreferences,
  resellerWebSessions,
  resellerWebTotpFactors,
  resellers,
} from '../../../../infrastructure/persistence/schema.js';
import { ScopeBound } from '../../../../infrastructure/persistence/database-scope.js';
import type {
  ResellerActivityRow,
  ResellerWebLinkRecord,
  ResellerWebRepository,
  ResellerWebSessionRecord,
  ResellerWebTotpFactorRecord,
} from '../application/ports.js';

type SessionRow = typeof resellerWebSessions.$inferSelect;
type FactorRow = typeof resellerWebTotpFactors.$inferSelect;

function toSession(row: SessionRow): ResellerWebSessionRecord {
  return {
    id: row.id,
    customerId: row.customerId,
    botInstanceId: row.botInstanceId,
    state: row.state as ResellerWebSessionState,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    endedAt: row.endedAt,
    deviceFingerprint: row.deviceFingerprint,
    deviceLabel: row.deviceLabel,
    network: row.network,
    secondFactorAttempts: row.secondFactorAttempts,
  };
}

function toFactor(row: FactorRow): ResellerWebTotpFactorRecord {
  return {
    id: row.id,
    customerId: row.customerId,
    state: row.state as ResellerWebTotpState,
    ciphertext: row.totpSecretCiphertext,
    keyId: row.totpSecretKeyId,
    lastUsedStep: row.lastUsedStep,
    activationAttempts: row.activationAttempts,
    createdAt: row.createdAt,
  };
}

/** PR-4 — the reseller web panel's rows in PostgreSQL, every statement in its tenant. */
@ScopeBound()
export class DrizzleResellerWebRepository implements ResellerWebRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async lockReseller(scope: TenantContext, customerId: string, tx: unknown): Promise<boolean> {
    const rows = await this.exec(tx)
      .select({ id: resellers.id })
      .from(resellers)
      .where(
        and(eq(resellers.tenantId, requireTenantId(scope)), eq(resellers.customerId, customerId)),
      )
      .for('update')
      .limit(1);
    return rows.length > 0;
  }

  async countLinksSince(
    scope: TenantContext,
    customerId: string,
    since: Date,
    tx: unknown,
  ): Promise<number> {
    const [row] = await this.exec(tx)
      .select({ n: sql<number>`count(*)::int` })
      .from(resellerWebLoginTokens)
      .where(
        and(
          eq(resellerWebLoginTokens.tenantId, requireTenantId(scope)),
          eq(resellerWebLoginTokens.customerId, customerId),
          gt(resellerWebLoginTokens.createdAt, since),
        ),
      );
    return Number(row?.n ?? 0);
  }

  async insertLink(
    scope: TenantContext,
    row: Parameters<ResellerWebRepository['insertLink']>[1],
    tx: unknown,
  ): Promise<void> {
    await this.exec(tx)
      .insert(resellerWebLoginTokens)
      .values({ ...row, tenantId: requireTenantId(scope) });
  }

  async lockLinkByHash(
    scope: TenantContext,
    tokenHash: string,
    tx: unknown,
  ): Promise<ResellerWebLinkRecord | null> {
    const [row] = await this.exec(tx)
      .select({
        id: resellerWebLoginTokens.id,
        customerId: resellerWebLoginTokens.customerId,
        botInstanceId: resellerWebLoginTokens.botInstanceId,
        createdAt: resellerWebLoginTokens.createdAt,
        expiresAt: resellerWebLoginTokens.expiresAt,
        usedAt: resellerWebLoginTokens.usedAt,
      })
      .from(resellerWebLoginTokens)
      .where(
        and(
          eq(resellerWebLoginTokens.tenantId, requireTenantId(scope)),
          eq(resellerWebLoginTokens.tokenHash, tokenHash),
        ),
      )
      .for('update')
      .limit(1);
    return row ?? null;
  }

  async spendLink(
    scope: TenantContext,
    input: { readonly id: string; readonly sessionId: string; readonly now: Date },
    tx: unknown,
  ): Promise<boolean> {
    const rows = await this.exec(tx)
      .update(resellerWebLoginTokens)
      .set({ usedAt: input.now, sessionId: input.sessionId })
      .where(
        and(
          eq(resellerWebLoginTokens.tenantId, requireTenantId(scope)),
          eq(resellerWebLoginTokens.id, input.id),
          isNull(resellerWebLoginTokens.usedAt),
          gt(resellerWebLoginTokens.expiresAt, input.now),
        ),
      )
      .returning({ id: resellerWebLoginTokens.id });
    return rows.length === 1;
  }

  async insertSession(
    scope: TenantContext,
    row: Parameters<ResellerWebRepository['insertSession']>[1],
    tx: unknown,
  ): Promise<void> {
    await this.exec(tx)
      .insert(resellerWebSessions)
      .values({
        id: row.id,
        tenantId: requireTenantId(scope),
        customerId: row.customerId,
        botInstanceId: row.botInstanceId,
        tokenHash: row.tokenHash,
        state: row.state,
        createdAt: row.now,
        lastSeenAt: row.now,
        absoluteExpiresAt: row.absoluteExpiresAt,
        deviceFingerprint: row.deviceFingerprint,
        deviceLabel: row.deviceLabel,
        network: row.network,
      });
  }

  async findSessionByHash(
    scope: TenantContext,
    tokenHash: string,
  ): Promise<ResellerWebSessionRecord | null> {
    const [row] = await this.db
      .select()
      .from(resellerWebSessions)
      .where(
        and(
          eq(resellerWebSessions.tenantId, requireTenantId(scope)),
          eq(resellerWebSessions.tokenHash, tokenHash),
        ),
      )
      .limit(1);
    return row === undefined ? null : toSession(row);
  }

  async lockSession(
    scope: TenantContext,
    id: string,
    tx: unknown,
  ): Promise<ResellerWebSessionRecord | null> {
    const [row] = await this.exec(tx)
      .select()
      .from(resellerWebSessions)
      .where(
        and(
          eq(resellerWebSessions.tenantId, requireTenantId(scope)),
          eq(resellerWebSessions.id, id),
        ),
      )
      .for('update')
      .limit(1);
    return row === undefined ? null : toSession(row);
  }

  async touchSession(scope: TenantContext, id: string, now: Date): Promise<void> {
    await this.db
      .update(resellerWebSessions)
      .set({ lastSeenAt: now })
      .where(
        and(
          eq(resellerWebSessions.tenantId, requireTenantId(scope)),
          eq(resellerWebSessions.id, id),
          isNull(resellerWebSessions.endedAt),
          lt(resellerWebSessions.lastSeenAt, now),
        ),
      );
  }

  async activateSession(
    scope: TenantContext,
    input: { readonly id: string; readonly now: Date; readonly absoluteExpiresAt: Date },
    tx: unknown,
  ): Promise<boolean> {
    const rows = await this.exec(tx)
      .update(resellerWebSessions)
      .set({ state: 'ACTIVE', lastSeenAt: input.now, absoluteExpiresAt: input.absoluteExpiresAt })
      .where(
        and(
          eq(resellerWebSessions.tenantId, requireTenantId(scope)),
          eq(resellerWebSessions.id, input.id),
          eq(resellerWebSessions.state, 'PENDING_SECOND_FACTOR'),
          isNull(resellerWebSessions.endedAt),
        ),
      )
      .returning({ id: resellerWebSessions.id });
    return rows.length === 1;
  }

  async countSecondFactorAttempt(scope: TenantContext, id: string, tx: unknown): Promise<number> {
    const [row] = await this.exec(tx)
      .update(resellerWebSessions)
      .set({ secondFactorAttempts: sql`${resellerWebSessions.secondFactorAttempts} + 1` })
      .where(
        and(
          eq(resellerWebSessions.tenantId, requireTenantId(scope)),
          eq(resellerWebSessions.id, id),
          isNull(resellerWebSessions.endedAt),
        ),
      )
      .returning({ n: resellerWebSessions.secondFactorAttempts });
    return row?.n ?? RESELLER_WEB_SECOND_FACTOR_MAX_ATTEMPTS + 1;
  }

  async endSession(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly customerId: string;
      readonly reason: ResellerWebSessionEndReason;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<boolean> {
    const rows = await this.exec(tx)
      .update(resellerWebSessions)
      .set({ endedAt: input.now, endReason: input.reason })
      .where(
        and(
          eq(resellerWebSessions.tenantId, requireTenantId(scope)),
          eq(resellerWebSessions.id, input.id),
          eq(resellerWebSessions.customerId, input.customerId),
          isNull(resellerWebSessions.endedAt),
        ),
      )
      .returning({ id: resellerWebSessions.id });
    return rows.length === 1;
  }

  async endSessionsOf(
    scope: TenantContext,
    input: {
      readonly customerId: string;
      readonly reason: ResellerWebSessionEndReason;
      readonly now: Date;
      readonly keep: string | null;
    },
    tx: unknown,
  ): Promise<number> {
    const rows = await this.exec(tx)
      .update(resellerWebSessions)
      .set({ endedAt: input.now, endReason: input.reason })
      .where(
        and(
          eq(resellerWebSessions.tenantId, requireTenantId(scope)),
          eq(resellerWebSessions.customerId, input.customerId),
          isNull(resellerWebSessions.endedAt),
          input.keep === null ? undefined : ne(resellerWebSessions.id, input.keep),
        ),
      )
      .returning({ id: resellerWebSessions.id });
    return rows.length;
  }

  async openSessionsOf(
    scope: TenantContext,
    customerId: string,
  ): Promise<readonly ResellerWebSessionRecord[]> {
    const rows = await this.db
      .select()
      .from(resellerWebSessions)
      .where(
        and(
          eq(resellerWebSessions.tenantId, requireTenantId(scope)),
          eq(resellerWebSessions.customerId, customerId),
          isNull(resellerWebSessions.endedAt),
        ),
      )
      .orderBy(desc(resellerWebSessions.lastSeenAt), desc(resellerWebSessions.id))
      .limit(200);
    return rows.map(toSession);
  }

  async lastLoginAt(scope: TenantContext, customerId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ at: sql<Date | null>`max(${resellerWebSessions.createdAt})` })
      .from(resellerWebSessions)
      .where(
        and(
          eq(resellerWebSessions.tenantId, requireTenantId(scope)),
          eq(resellerWebSessions.customerId, customerId),
          eq(resellerWebSessions.state, 'ACTIVE'),
        ),
      );
    const at = row?.at ?? null;
    return at === null ? null : new Date(at);
  }

  async recordDevice(
    scope: TenantContext,
    input: { readonly customerId: string; readonly fingerprint: string; readonly now: Date },
    tx: unknown,
  ): Promise<boolean> {
    const rows = await this.exec(tx)
      .insert(resellerWebDevices)
      .values({
        tenantId: requireTenantId(scope),
        customerId: input.customerId,
        fingerprint: input.fingerprint,
        firstSeenAt: input.now,
      })
      .onConflictDoNothing()
      .returning({ fingerprint: resellerWebDevices.fingerprint });
    return rows.length === 1;
  }

  async findFactor(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<ResellerWebTotpFactorRecord | null> {
    const [row] = await this.exec(tx)
      .select()
      .from(resellerWebTotpFactors)
      .where(
        and(
          eq(resellerWebTotpFactors.tenantId, requireTenantId(scope)),
          eq(resellerWebTotpFactors.customerId, customerId),
        ),
      )
      .limit(1);
    return row === undefined ? null : toFactor(row);
  }

  async lockFactor(
    scope: TenantContext,
    customerId: string,
    tx: unknown,
  ): Promise<ResellerWebTotpFactorRecord | null> {
    const [row] = await this.exec(tx)
      .select()
      .from(resellerWebTotpFactors)
      .where(
        and(
          eq(resellerWebTotpFactors.tenantId, requireTenantId(scope)),
          eq(resellerWebTotpFactors.customerId, customerId),
        ),
      )
      .for('update')
      .limit(1);
    return row === undefined ? null : toFactor(row);
  }

  async replacePendingFactor(
    scope: TenantContext,
    row: Parameters<ResellerWebRepository['replacePendingFactor']>[1],
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx)
      .delete(resellerWebTotpFactors)
      .where(
        and(
          eq(resellerWebTotpFactors.tenantId, tenantId),
          eq(resellerWebTotpFactors.customerId, row.customerId),
          eq(resellerWebTotpFactors.state, 'PENDING'),
        ),
      );
    await this.exec(tx).insert(resellerWebTotpFactors).values({
      id: row.id,
      tenantId,
      customerId: row.customerId,
      state: 'PENDING',
      totpSecretCiphertext: row.ciphertext,
      totpSecretKeyId: row.keyId,
      createdAt: row.now,
    });
  }

  async countActivationAttempt(
    scope: TenantContext,
    customerId: string,
    tx: unknown,
  ): Promise<number | null> {
    const [row] = await this.exec(tx)
      .update(resellerWebTotpFactors)
      .set({ activationAttempts: sql`${resellerWebTotpFactors.activationAttempts} + 1` })
      .where(
        and(
          eq(resellerWebTotpFactors.tenantId, requireTenantId(scope)),
          eq(resellerWebTotpFactors.customerId, customerId),
          eq(resellerWebTotpFactors.state, 'PENDING'),
        ),
      )
      .returning({ n: resellerWebTotpFactors.activationAttempts });
    return row?.n ?? null;
  }

  async activateFactor(
    scope: TenantContext,
    input: { readonly id: string; readonly step: number; readonly now: Date },
    tx: unknown,
  ): Promise<boolean> {
    const rows = await this.exec(tx)
      .update(resellerWebTotpFactors)
      .set({ state: 'ACTIVE', activatedAt: input.now, lastUsedStep: input.step })
      .where(
        and(
          eq(resellerWebTotpFactors.tenantId, requireTenantId(scope)),
          eq(resellerWebTotpFactors.id, input.id),
          eq(resellerWebTotpFactors.state, 'PENDING'),
        ),
      )
      .returning({ id: resellerWebTotpFactors.id });
    return rows.length === 1;
  }

  async consumeStep(
    scope: TenantContext,
    input: { readonly id: string; readonly step: number },
    tx: unknown,
  ): Promise<boolean> {
    const rows = await this.exec(tx)
      .update(resellerWebTotpFactors)
      .set({ lastUsedStep: input.step })
      .where(
        and(
          eq(resellerWebTotpFactors.tenantId, requireTenantId(scope)),
          eq(resellerWebTotpFactors.id, input.id),
          eq(resellerWebTotpFactors.state, 'ACTIVE'),
          sql`(${resellerWebTotpFactors.lastUsedStep} IS NULL OR ${resellerWebTotpFactors.lastUsedStep} < ${input.step})`,
        ),
      )
      .returning({ id: resellerWebTotpFactors.id });
    return rows.length === 1;
  }

  async deleteFactor(scope: TenantContext, customerId: string, tx: unknown): Promise<boolean> {
    const rows = await this.exec(tx)
      .delete(resellerWebTotpFactors)
      .where(
        and(
          eq(resellerWebTotpFactors.tenantId, requireTenantId(scope)),
          eq(resellerWebTotpFactors.customerId, customerId),
        ),
      )
      .returning({ id: resellerWebTotpFactors.id });
    return rows.length > 0;
  }

  async findPreferences(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<ResellerPreferences | null> {
    const [row] = await this.exec(tx)
      .select({
        newDeviceAlert: resellerWebPreferences.newDeviceAlert,
        expiringDigest: resellerWebPreferences.expiringDigest,
        dailySalesReport: resellerWebPreferences.dailySalesReport,
        ticketReply: resellerWebPreferences.ticketReply,
      })
      .from(resellerWebPreferences)
      .where(
        and(
          eq(resellerWebPreferences.tenantId, requireTenantId(scope)),
          eq(resellerWebPreferences.customerId, customerId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async upsertPreferences(
    scope: TenantContext,
    input: { readonly customerId: string; readonly value: ResellerPreferences; readonly now: Date },
    tx: unknown,
  ): Promise<void> {
    await this.exec(tx)
      .insert(resellerWebPreferences)
      .values({
        tenantId: requireTenantId(scope),
        customerId: input.customerId,
        ...input.value,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [resellerWebPreferences.tenantId, resellerWebPreferences.customerId],
        set: { ...input.value, updatedAt: input.now },
      });
  }

  async countFileFetchesSince(
    scope: TenantContext,
    input: { readonly customerId: string; readonly serviceId: string; readonly since: Date },
    tx: unknown,
  ): Promise<number> {
    const [row] = await this.exec(tx)
      .select({ n: sql<number>`count(*)::int` })
      .from(resellerWebFileFetches)
      .where(
        and(
          eq(resellerWebFileFetches.tenantId, requireTenantId(scope)),
          eq(resellerWebFileFetches.customerId, input.customerId),
          eq(resellerWebFileFetches.serviceId, input.serviceId),
          gte(resellerWebFileFetches.fetchedAt, input.since),
        ),
      );
    return Number(row?.n ?? 0);
  }

  async insertFileFetch(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly customerId: string;
      readonly serviceId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void> {
    await this.exec(tx)
      .insert(resellerWebFileFetches)
      .values({
        id: input.id,
        tenantId: requireTenantId(scope),
        customerId: input.customerId,
        serviceId: input.serviceId,
        fetchedAt: input.now,
      });
  }

  async activityPage(
    scope: TenantContext,
    input: {
      readonly customerId: string;
      readonly actions: readonly string[];
      readonly before: { readonly at: Date; readonly id: string } | null;
      readonly limit: number;
    },
  ): Promise<readonly ResellerActivityRow[]> {
    const tenantId = requireTenantId(scope);
    const before =
      input.before === null
        ? sql`TRUE`
        : sql`(a.occurred_at, a.id) < (${input.before.at.toISOString()}::timestamptz, ${input.before.id}::uuid)`;
    const result = await this.db.execute<{
      id: string;
      action: string;
      entity_type: string;
      entity_id: string | null;
      result: string;
      occurred_at: string | Date;
    }>(sql`
      SELECT a.id::text AS id, a.action, a.entity_type, a.entity_id, a.result, a.occurred_at
        FROM audit_logs a
       WHERE a.tenant_id = ${tenantId}::uuid
         AND a.action IN (${sql.join(
           input.actions.map((action) => sql`${action}`),
           sql`, `,
         )})
         AND (
              (a.entity_type = 'Customer' AND a.entity_id = ${input.customerId})
           OR (a.entity_type = 'Service' AND a.entity_id IN (
                 SELECT s.id::text FROM services s
                  WHERE s.tenant_id = ${tenantId}::uuid AND s.customer_id = ${input.customerId}::uuid))
           OR (a.entity_type = 'Order' AND a.entity_id IN (
                 SELECT o.id::text FROM orders o
                  WHERE o.tenant_id = ${tenantId}::uuid AND o.customer_id = ${input.customerId}::uuid))
         )
         AND ${before}
       ORDER BY a.occurred_at DESC, a.id DESC
       LIMIT ${input.limit}`);
    return result.rows.map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      result: row.result,
      occurredAt: new Date(row.occurred_at),
    }));
  }
}
