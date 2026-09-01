import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  asId,
  type AdminId,
  type AdminSession,
  type AdminSessionId,
  type ScopeContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { adminSessions } from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SessionRepository } from '../application/ports.js';

type SessionRow = typeof adminSessions.$inferSelect;

function toSession(row: SessionRow): AdminSession {
  return {
    id: asId<'AdminSessionId'>(row.id),
    tenantId: asId<'TenantId'>(row.tenantId),
    adminId: asId<'AdminId'>(row.adminId),
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
  };
}

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

export class DrizzleSessionRepository implements SessionRepository {
  constructor(private readonly db: Database) {}

  async create(
    scope: ScopeContext,
    session: {
      readonly id: AdminSessionId;
      readonly adminId: AdminId;
      readonly tokenHash: string;
      readonly issuedAt: Date;
      readonly expiresAt: Date;
      readonly ip: string | null;
      readonly userAgent: string | null;
    },
    tx?: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await executorOf(this.db, tx).insert(adminSessions).values({
      id: session.id,
      tenantId,
      adminId: session.adminId,
      tokenHash: session.tokenHash,
      issuedAt: session.issuedAt,
      expiresAt: session.expiresAt,
      lastSeenAt: session.issuedAt,
      ip: session.ip,
      userAgent: session.userAgent,
    });
  }

  /**
   * The one deliberately unscoped read in the module.
   *
   * A token is presented before any tenant is known — the tenant is the RESULT
   * of this lookup, not an input to it. It is safe because the lookup key is a
   * 256-bit random value's hash: it cannot be guessed, enumerated or derived
   * from anything a caller knows. Every call made after this one is scoped to
   * the tenant it returns.
   */
  async findByTokenHash(tokenHash: string): Promise<AdminSession | null> {
    const [row] = await this.db
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.tokenHash, tokenHash))
      .limit(1);
    return row ? toSession(row) : null;
  }

  async touch(id: AdminSessionId, now: Date): Promise<void> {
    await this.db.update(adminSessions).set({ lastSeenAt: now }).where(eq(adminSessions.id, id));
  }

  async revoke(id: AdminSessionId, now: Date, reason: string): Promise<void> {
    // Only an unrevoked session is revoked, so the original revocation time and
    // reason survive a second logout rather than being overwritten.
    await this.db
      .update(adminSessions)
      .set({ revokedAt: now, revokedReason: reason })
      .where(and(eq(adminSessions.id, id), isNull(adminSessions.revokedAt)));
  }

  async revokeAllForAdmin(
    scope: ScopeContext,
    adminId: AdminId,
    now: Date,
    reason: string,
    tx?: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .update(adminSessions)
      .set({ revokedAt: now, revokedReason: reason })
      .where(
        and(
          eq(adminSessions.tenantId, tenantId),
          eq(adminSessions.adminId, adminId),
          isNull(adminSessions.revokedAt),
        ),
      )
      .returning({ id: adminSessions.id });
    return rows.length;
  }

  /** Removes sessions that expired long enough ago to have no forensic value. */
  async purgeExpiredBefore(cutoff: Date): Promise<number> {
    const rows = await this.db
      .delete(adminSessions)
      .where(sql`${adminSessions.expiresAt} < ${cutoff}`)
      .returning({ id: adminSessions.id });
    return rows.length;
  }
}
