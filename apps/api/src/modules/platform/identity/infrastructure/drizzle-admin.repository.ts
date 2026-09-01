import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  asId,
  type Admin,
  type AdminId,
  type AdminStatus,
  type ScopeContext,
  type TenantStatus,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  adminRoles,
  admins,
  roles,
  tenants,
} from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type { AdminCredentials, AdminRepository } from '../application/ports.js';

type AdminRow = typeof admins.$inferSelect;

/**
 * Every method resolves its tenant through `requireTenantId`, so a query that
 * forgets the predicate throws rather than reading another tenant's rows. The
 * password hash never leaves this file except through
 * `findCredentialsByUsername`, which the authentication service alone calls.
 */
function toAdmin(row: AdminRow): Admin {
  return {
    id: asId<'AdminId'>(row.id),
    tenantId: asId<'TenantId'>(row.tenantId),
    username: row.username,
    displayName: row.displayName,
    status: row.status as AdminStatus,
    telegramUserId: row.telegramUserId,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
    disabledAt: row.disabledAt,
  };
}

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

export class DrizzleAdminRepository implements AdminRepository {
  constructor(private readonly db: Database) {}

  async findCredentialsByUsername(
    scope: ScopeContext,
    username: string,
  ): Promise<AdminCredentials | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select()
      .from(admins)
      .where(and(eq(admins.tenantId, tenantId), eq(admins.username, username)))
      .limit(1);
    return row ? { admin: toAdmin(row), passwordHash: row.passwordHash } : null;
  }

  async findById(scope: ScopeContext, id: AdminId, tx?: unknown): Promise<Admin | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(admins)
      .where(and(eq(admins.tenantId, tenantId), eq(admins.id, id)))
      .limit(1);
    return row ? toAdmin(row) : null;
  }

  async findByUsername(scope: ScopeContext, username: string, tx?: unknown): Promise<Admin | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(admins)
      .where(and(eq(admins.tenantId, tenantId), eq(admins.username, username)))
      .limit(1);
    return row ? toAdmin(row) : null;
  }

  async findByTelegramUserId(
    scope: ScopeContext,
    telegramUserId: string,
    tx?: unknown,
  ): Promise<Admin | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(admins)
      .where(and(eq(admins.tenantId, tenantId), eq(admins.telegramUserId, telegramUserId)))
      .limit(1);
    return row ? toAdmin(row) : null;
  }

  async list(scope: ScopeContext, tx?: unknown): Promise<Admin[]> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .select()
      .from(admins)
      .where(eq(admins.tenantId, tenantId))
      .orderBy(admins.username);
    return rows.map(toAdmin);
  }

  async roleKeysFor(scope: ScopeContext, id: AdminId, tx?: unknown): Promise<string[]> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .select({ key: roles.key })
      .from(adminRoles)
      .innerJoin(roles, eq(roles.id, adminRoles.roleId))
      .where(and(eq(adminRoles.tenantId, tenantId), eq(adminRoles.adminId, id)));
    return rows.map((row) => row.key).sort();
  }

  async roleKeysForAll(
    scope: ScopeContext,
    ids: readonly AdminId[],
  ): Promise<Map<string, string[]>> {
    const tenantId = requireTenantId(scope);
    const result = new Map<string, string[]>();
    if (ids.length === 0) return result;

    const rows = await this.db
      .select({ adminId: adminRoles.adminId, key: roles.key })
      .from(adminRoles)
      .innerJoin(roles, eq(roles.id, adminRoles.roleId))
      .where(and(eq(adminRoles.tenantId, tenantId), inArray(adminRoles.adminId, [...ids])));

    for (const row of rows) {
      const existing = result.get(row.adminId);
      if (existing) existing.push(row.key);
      else result.set(row.adminId, [row.key]);
    }
    for (const keys of result.values()) keys.sort();
    return result;
  }

  async create(
    scope: ScopeContext,
    input: {
      readonly id: AdminId;
      readonly username: string;
      readonly displayName: string;
      readonly passwordHash: string;
      readonly telegramUserId: string | null;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await executorOf(this.db, tx).insert(admins).values({
      id: input.id,
      tenantId,
      username: input.username,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      passwordUpdatedAt: input.now,
      status: 'ACTIVE',
      telegramUserId: input.telegramUserId,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  async setStatus(
    scope: ScopeContext,
    id: AdminId,
    status: AdminStatus,
    now: Date,
    tx?: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await executorOf(this.db, tx)
      .update(admins)
      .set({
        status,
        // The CHECK constraint requires these two to agree, so they are always
        // written together rather than left to a caller to remember.
        disabledAt: status === 'DISABLED' ? now : null,
        updatedAt: now,
      })
      .where(and(eq(admins.tenantId, tenantId), eq(admins.id, id)));
  }

  /**
   * Compare-and-set. The expected hash is part of the WHERE clause, so the
   * check and the write are one atomic statement — no window between them for
   * another rotation to slip through.
   *
   * `returning` is how the row count is read: an UPDATE that matched nothing is
   * not an error to the driver, so a caller that did not ask would be told the
   * write succeeded.
   */
  async compareAndSetPasswordHash(
    scope: ScopeContext,
    id: AdminId,
    expectedHash: string,
    newHash: string,
    now: Date,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const updated = await executorOf(this.db, tx)
      .update(admins)
      .set({ passwordHash: newHash, passwordUpdatedAt: now, updatedAt: now })
      .where(
        and(
          eq(admins.tenantId, tenantId),
          eq(admins.id, id),
          eq(admins.passwordHash, expectedHash),
          // Status is part of the predicate, not merely the hash. A disable
          // commits and revokes the actor's sessions while a rotation is still
          // hashing; without this the now-disabled administrator could still
          // commit a new credential after their access ended, leaving a
          // password they control ready for any later re-enable. A disable that
          // commits first now makes the rotation lose, exactly as a concurrent
          // password change does.
          eq(admins.status, 'ACTIVE'),
        ),
      )
      .returning({ id: admins.id });
    return updated.length === 1;
  }

  async recordLogin(scope: ScopeContext, id: AdminId, now: Date): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.db
      .update(admins)
      // Never backwards. `now` is captured before the KDF, so two overlapping
      // logins can reach this statement in the opposite order to the one they
      // started in, and an unconditional write would let the slower, earlier
      // request replace a newer timestamp — reporting a last login that
      // predates one that has already finished.
      .set({
        lastLoginAt: sql`GREATEST(${admins.lastLoginAt}, ${now})`,
      })
      .where(and(eq(admins.tenantId, tenantId), eq(admins.id, id)));
  }

  /**
   * Holds the tenant's status still for a READER, and returns it.
   *
   * `FOR SHARE`, not `FOR UPDATE`: a login is a reader of this status, and
   * share locks are compatible with each other, so concurrent sign-ins do not
   * queue behind one another. A status change still waits, which is the point —
   * it is the writer.
   */
  async lockTenantForRead(scope: ScopeContext, tx: unknown): Promise<TenantStatus> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .for('share');
    return (row?.status ?? 'DISABLED') as TenantStatus;
  }

  async lockTenantForAdminChange(scope: ScopeContext, tx: unknown): Promise<TenantStatus> {
    const tenantId = requireTenantId(scope);
    // Serialises owner-affecting changes within a tenant. Counting owners is
    // only a decision if nothing can change between the count and the write.
    const [row] = await executorOf(this.db, tx)
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .for('update');

    // The status is read by the SAME statement that takes the lock, so the two
    // cannot disagree. A caller that checked tenant status when the request
    // arrived is holding a snapshot; the transition it may have missed either
    // committed before this lock — in which case this returns the new value —
    // or cannot commit until this transaction ends.
    return (row?.status ?? 'DISABLED') as TenantStatus;
  }

  async lockIfPasswordHashMatches(
    scope: ScopeContext,
    id: AdminId,
    expectedHash: string,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .select({ id: admins.id })
      .from(admins)
      .where(
        and(
          eq(admins.tenantId, tenantId),
          eq(admins.id, id),
          eq(admins.passwordHash, expectedHash),
          // Status too, for the same reason the rotation's predicate carries
          // it. The status the login checked was read outside any transaction,
          // and a disable committing in that gap revokes every session that
          // exists at that moment — a session inserted afterwards would not be
          // one of them. It could never be USED (`authenticate` refuses a
          // non-ACTIVE administrator on every request), but a login must not
          // outlive the account's access any more than it outlives its
          // credential.
          eq(admins.status, 'ACTIVE'),
        ),
      )
      .for('update')
      .limit(1);
    return rows.length === 1;
  }

  /** Used only by the bootstrap and rehash paths, which have no CAS predicate. */
  async setPasswordHash(
    scope: ScopeContext,
    id: AdminId,
    hash: string,
    now: Date,
    tx?: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await executorOf(this.db, tx)
      .update(admins)
      .set({ passwordHash: hash, passwordUpdatedAt: now, updatedAt: now })
      .where(and(eq(admins.tenantId, tenantId), eq(admins.id, id)));
  }

  async countActiveOwners(scope: ScopeContext, tx?: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select({ count: sql<number>`count(*)::int` })
      .from(adminRoles)
      .innerJoin(roles, eq(roles.id, adminRoles.roleId))
      .innerJoin(admins, eq(admins.id, adminRoles.adminId))
      .where(
        and(eq(adminRoles.tenantId, tenantId), eq(roles.key, 'owner'), eq(admins.status, 'ACTIVE')),
      );
    return row?.count ?? 0;
  }
}
