import {
  adminPasswordSchema,
  adminUsernameSchema,
  createAdminRequestSchema,
  changePasswordRequestSchema,
  errors,
  IDENTITY_ERROR_CODES,
  OWNER_ROLE_KEY,
  setAdminRolesRequestSchema,
  setAdminStatusRequestSchema,
  type ActorContext,
  type Admin,
  type AdminId,
  type AdminStatus,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type PasswordHasher,
  type Role,
  type RoleId,
  type ScopeContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import type { OutboxWriter } from '../../eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { DrizzleRoleRepository } from '../infrastructure/drizzle-role.repository.js';
import type { AdminRepository, SessionRepository } from './ports.js';
import { assertNotSelf, assertOwnerSurvives, diffRoles } from '../domain/admin-protection.js';

/**
 * Administrator management.
 *
 * Every method here follows the Phase 0 write path — authorize, validate,
 * transact, audit, outbox — and adds the two rules that keep an installation
 * both secure and recoverable:
 *
 *   - An admin never changes their own roles or status. Holding `admins.edit`
 *     is authority over OTHER administrators; without this rule every other
 *     boundary is decorative, because any admin who can edit admins can grant
 *     themselves everything (`UNK-ADM-005`).
 *   - The last active owner cannot be disabled or demoted. Losing it is not a
 *     permission problem; it means editing the database by hand to get back in.
 *
 * Both checks run under a tenant row lock, because a count is only a decision
 * if nothing can change between counting and writing. The triggers in migration
 * 0006 repeat the owner rule as a backstop for a future path that forgets.
 */
export class AdminManagementService {
  constructor(
    private readonly guard: PermissionGuard,
    private readonly uow: UnitOfWork<TransactionScope>,
    private readonly admins: AdminRepository,
    private readonly roles: DrizzleRoleRepository,
    private readonly sessions: SessionRepository,
    private readonly hasher: PasswordHasher,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async list(
    scope: ScopeContext,
    actor: ActorContext,
  ): Promise<{ admin: Admin; roleKeys: string[] }[]> {
    await this.guard.check(scope, actor, 'admins.view');
    const found = await this.admins.list(scope);
    const roleKeys = await this.admins.roleKeysForAll(
      scope,
      found.map((admin) => admin.id),
    );
    return found.map((admin) => ({ admin, roleKeys: roleKeys.get(admin.id) ?? [] }));
  }

  async listRoles(scope: ScopeContext, actor: ActorContext): Promise<Role[]> {
    await this.guard.check(scope, actor, 'admins.view');
    return this.roles.list(scope);
  }

  async create(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<{ admin: Admin; roleKeys: string[] }> {
    await this.guard.check(scope, actor, 'admins.edit');
    const command = createAdminRequestSchema.parse(input);

    const username = adminUsernameSchema.parse(command.username.trim().toLowerCase());
    adminPasswordSchema.parse(command.password);

    // Granting the owner role is the single most privileged act available.
    // `admins.edit` creates administrators; making one an owner additionally
    // needs the permission that governs privilege itself.
    if (command.roleKeys.includes(OWNER_ROLE_KEY)) {
      await this.guard.check(scope, actor, 'admins.permissions.edit');
    }

    const now = this.clock.now();
    const adminId = this.ids.uuid() as AdminId;
    // Hashing is deliberately outside the transaction: it is intentionally slow,
    // and holding a database transaction open for the duration of a KDF turns
    // one slow request into contention for every other writer.
    const passwordHash = await this.hasher.hash(command.password);

    const existing = await this.admins.findCredentialsByUsername(scope, username);
    if (existing !== null) {
      throw errors.conflict(
        IDENTITY_ERROR_CODES.ADMIN_USERNAME_TAKEN,
        'An administrator with that username already exists.',
        { username },
      );
    }

    const roleIds = await this.resolveRoleIds(scope, command.roleKeys);

    await this.uow.run(scope, async (tx) => {
      await this.admins.create(
        scope,
        {
          id: adminId,
          username,
          displayName: command.displayName,
          passwordHash,
          telegramUserId: command.telegramUserId ?? null,
          now,
        },
        tx,
      );
      await this.roles.setAdminRoles(scope, adminId, roleIds, adminIdOf(actor), tx);

      await this.audit.record(
        scope,
        actor,
        {
          action: 'admin.create',
          entityType: 'Admin',
          entityId: adminId,
          before: null,
          // No password, no hash. `passwordHash` would be caught by the
          // redactor anyway; not writing it is better than relying on that.
          after: {
            username,
            displayName: command.displayName,
            roleKeys: [...command.roleKeys].sort(),
          },
          result: 'SUCCESS',
        },
        tx,
      );

      await this.outbox.write(tx, actor, {
        eventType: 'AdminCreated',
        aggregateType: 'Admin',
        aggregateId: adminId,
        payload: { username, roleKeys: [...command.roleKeys].sort() },
      });
    });

    const created = await this.admins.findById(scope, adminId);
    if (created === null) {
      throw errors.internal(
        'admin.create_failed',
        'The administrator was not readable after creation.',
      );
    }
    return { admin: created, roleKeys: [...command.roleKeys].sort() };
  }

  async setStatus(
    scope: ScopeContext,
    actor: ActorContext,
    targetId: AdminId,
    input: unknown,
  ): Promise<Admin> {
    await this.guard.check(scope, actor, 'admins.edit');
    const command = setAdminStatusRequestSchema.parse(input);

    // Refused before anything is read: an admin cannot disable themselves, and
    // this holds no matter which permissions they carry.
    assertNotSelf(adminIdOf(actor), targetId);

    const now = this.clock.now();

    const updated = await this.uow.run(scope, async (tx) => {
      await this.admins.lockTenantForAdminChange(scope, tx);

      const target = await this.requireAdmin(scope, targetId);
      if (target.status === command.status) return target;

      if (command.status === 'DISABLED') {
        await this.assertOwnerSurvivesDisabling(scope, target, tx);
      }

      await this.admins.setStatus(scope, targetId, command.status, now, tx);

      // Disabling ends every live session immediately. Waiting for expiry would
      // leave a revoked administrator acting for up to the session lifetime.
      if (command.status === 'DISABLED') {
        await this.sessions.revokeAllForAdmin(scope, targetId, now, 'admin_disabled', tx);
      }

      await this.audit.record(
        scope,
        actor,
        {
          action: 'admin.status_change',
          entityType: 'Admin',
          entityId: targetId,
          before: { status: target.status },
          after: { status: command.status },
          reason: command.reason,
          result: 'SUCCESS',
        },
        tx,
      );

      await this.outbox.write(tx, actor, {
        eventType: 'AdminStatusChanged',
        aggregateType: 'Admin',
        aggregateId: targetId,
        payload: { from: target.status, to: command.status },
      });

      return { ...target, status: command.status as AdminStatus };
    });

    return updated;
  }

  async setRoles(
    scope: ScopeContext,
    actor: ActorContext,
    targetId: AdminId,
    input: unknown,
  ): Promise<{ admin: Admin; roleKeys: string[] }> {
    await this.guard.check(scope, actor, 'admins.edit');
    const command = setAdminRolesRequestSchema.parse(input);

    assertNotSelf(adminIdOf(actor), targetId);

    const current = await this.admins.roleKeysFor(scope, targetId);
    const next = [...new Set(command.roleKeys)].sort();
    const delta = diffRoles(current, next);

    // Granting or removing the owner role is a change to privilege itself, not
    // merely to an assignment, so it needs the permission that governs privilege.
    if (delta.added.includes(OWNER_ROLE_KEY) || delta.removed.includes(OWNER_ROLE_KEY)) {
      await this.guard.check(scope, actor, 'admins.permissions.edit');
    }

    const roleIds = await this.resolveRoleIds(scope, next);
    const now = this.clock.now();

    await this.uow.run(scope, async (tx) => {
      await this.admins.lockTenantForAdminChange(scope, tx);
      const target = await this.requireAdmin(scope, targetId);

      if (delta.removed.includes(OWNER_ROLE_KEY)) {
        await this.assertOwnerSurvivesDisabling(scope, target, tx);
      }

      await this.roles.setAdminRoles(scope, targetId, roleIds, adminIdOf(actor), tx);

      await this.audit.record(
        scope,
        actor,
        {
          action: 'admin.roles_change',
          entityType: 'Admin',
          entityId: targetId,
          before: { roleKeys: [...current].sort() },
          after: { roleKeys: next },
          reason: command.reason,
          result: 'SUCCESS',
        },
        tx,
      );

      await this.outbox.write(tx, actor, {
        eventType: 'AdminRolesChanged',
        aggregateType: 'Admin',
        aggregateId: targetId,
        payload: { added: delta.added, removed: delta.removed },
      });

      void now;
    });

    const admin = await this.requireAdmin(scope, targetId);
    return { admin, roleKeys: next };
  }

  /**
   * Changing one's OWN password.
   *
   * Not covered by `assertNotSelf`: it requires the current password, grants
   * nothing, and refusing it would mean an administrator could never rotate a
   * credential they believe is exposed. It needs no catalog permission for the
   * same reason — the current password IS the authorization.
   */
  async changeOwnPassword(scope: ScopeContext, actor: ActorContext, input: unknown): Promise<void> {
    const command = changePasswordRequestSchema.parse(input);
    const adminId = adminIdOf(actor);
    if (adminId === null) {
      throw errors.unauthenticated(IDENTITY_ERROR_CODES.AUTH_REQUIRED, 'Sign in first.');
    }

    const admin = await this.requireAdmin(scope, adminId);
    const credentials = await this.admins.findCredentialsByUsername(scope, admin.username);
    if (credentials === null) {
      throw errors.notFound(IDENTITY_ERROR_CODES.ADMIN_NOT_FOUND, 'No such administrator.');
    }

    const currentMatches = await this.hasher.verify(
      command.currentPassword,
      credentials.passwordHash,
    );
    if (!currentMatches) {
      await this.audit.record(scope, actor, {
        action: 'admin.password_change',
        entityType: 'Admin',
        entityId: adminId,
        before: null,
        after: null,
        result: 'DENIED',
      });
      throw errors.unauthenticated(
        IDENTITY_ERROR_CODES.AUTH_INVALID_CREDENTIALS,
        'The current password is incorrect.',
      );
    }

    // Re-using the password one already has is not a password change. Verified
    // against the stored hash rather than by comparing plaintexts, so nothing
    // has to hold two passwords at once.
    const reused = await this.hasher.verify(command.newPassword, credentials.passwordHash);
    if (reused) {
      throw errors.validation(
        IDENTITY_ERROR_CODES.ADMIN_PASSWORD_REUSED,
        'The new password must differ from the current one.',
      );
    }

    adminPasswordSchema.parse(command.newPassword);
    const hash = await this.hasher.hash(command.newPassword);
    const now = this.clock.now();

    await this.uow.run(scope, async (tx) => {
      await this.admins.setPasswordHash(scope, adminId, hash, now, tx);
      await this.audit.record(
        scope,
        actor,
        {
          action: 'admin.password_change',
          entityType: 'Admin',
          entityId: adminId,
          before: null,
          after: { changedAt: now.toISOString(), bySelf: true },
          result: 'SUCCESS',
        },
        tx,
      );
      await this.outbox.write(tx, actor, {
        eventType: 'AdminPasswordChanged',
        aggregateType: 'Admin',
        aggregateId: adminId,
        payload: { bySelf: true },
      });
    });

    // Every other session is ended. A password change is what an administrator
    // does when they believe a credential is exposed, and leaving the other
    // sessions alive would make it useless for that.
    await this.sessions.revokeAllForAdmin(scope, adminId, now, 'password_changed');
  }

  private async requireAdmin(scope: ScopeContext, id: AdminId): Promise<Admin> {
    const admin = await this.admins.findById(scope, id);
    if (admin === null) {
      // Same error whether the id belongs to another tenant or to nobody. A
      // "wrong tenant" message would confirm the id exists somewhere.
      throw errors.notFound(IDENTITY_ERROR_CODES.ADMIN_NOT_FOUND, 'No such administrator.');
    }
    return admin;
  }

  private async assertOwnerSurvivesDisabling(
    scope: ScopeContext,
    target: Admin,
    tx: unknown,
  ): Promise<void> {
    const roleKeys = await this.admins.roleKeysFor(scope, target.id);
    const targetIsActiveOwner = roleKeys.includes(OWNER_ROLE_KEY) && target.status === 'ACTIVE';
    const activeOwnerCount = await this.admins.countActiveOwners(scope, tx);
    assertOwnerSurvives({ activeOwnerCount, targetIsActiveOwner });
  }

  private async resolveRoleIds(scope: ScopeContext, keys: readonly string[]): Promise<RoleId[]> {
    const { found, missing } = await this.roles.idsForKeys(scope, keys);
    if (missing.length > 0) {
      throw errors.validation(IDENTITY_ERROR_CODES.ROLE_NOT_FOUND, 'Unknown role.', {
        roleKeys: missing,
      });
    }
    return keys.map((key) => found.get(key) as RoleId);
  }
}

function adminIdOf(actor: ActorContext): AdminId | null {
  return actor.id === null ? null : (actor.id as AdminId);
}
