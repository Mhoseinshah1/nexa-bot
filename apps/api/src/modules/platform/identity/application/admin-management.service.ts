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
    await this.assertGrantsNoMorePrivilegeThanHeld(scope, actor, command.roleKeys);

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

      // Transaction-aware, for the same reason as setRoles: a read on the pool
      // after the lock does not participate in it, so the status this decision
      // rests on could differ from the one about to be overwritten.
      const target = await this.requireAdmin(scope, targetId, tx);
      // Re-checked against the id the DATABASE returned, not the one the caller
      // supplied. The boundary already canonicalises, and this is the check
      // that does not depend on it having: whatever row we are about to write
      // is the row the guard now sees.
      assertNotSelf(adminIdOf(actor), target.id);
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

    // Cheap and state-independent, so it can refuse before any work.
    assertNotSelf(adminIdOf(actor), targetId);

    const next = [...new Set(command.roleKeys)].sort();
    const now = this.clock.now();

    // EVERY authoritative read, decision and write happens under the tenant
    // lock, in this transaction.
    //
    // The delta used to be computed before the lock, and the owner-sensitive
    // authorization ran against it. That made the security decision a function
    // of a snapshot that could already be stale by the time it was acted on:
    //
    //   target holds [support]
    //   request B reads [support], intends [support] — delta contains no owner
    //   request A promotes target to [owner] and commits
    //   B takes the lock and writes [support]
    //
    // B has now removed the owner role without `admins.permissions.edit` ever
    // being checked, because the delta B computed never mentioned it. The
    // last-owner trigger does not catch this: another active owner exists, so
    // nothing is violated — a privileged role was simply removed by a request
    // that was never authorised to touch it.
    //
    // Reading current state before the lock is therefore not an optimisation
    // with a small race; it is authorization on unsound input.
    const result = await this.uow.run(scope, async (tx) => {
      await this.admins.lockTenantForAdminChange(scope, tx);

      // Transaction-aware. A read on the pool after the lock does not
      // participate in it and can observe a different snapshot.
      const target = await this.requireAdmin(scope, targetId, tx);
      assertNotSelf(adminIdOf(actor), target.id);

      const current = await this.admins.roleKeysFor(scope, target.id, tx);
      const delta = diffRoles(current, next);

      // Authorised from the LOCKED delta. Granting or removing the owner role
      // is a change to privilege itself, not merely to an assignment.
      if (delta.added.includes(OWNER_ROLE_KEY) || delta.removed.includes(OWNER_ROLE_KEY)) {
        await this.guard.check(scope, actor, 'admins.permissions.edit');
      }
      // Also from the locked delta: only what is genuinely being ADDED relative
      // to authoritative state. Removing a role is not amplification.
      await this.assertGrantsNoMorePrivilegeThanHeld(scope, actor, delta.added);

      if (delta.removed.includes(OWNER_ROLE_KEY)) {
        await this.assertOwnerSurvivesDisabling(scope, target, tx);
      }

      // Nothing to do. Returning early avoids an audit row and an event
      // claiming a change that did not happen.
      if (delta.added.length === 0 && delta.removed.length === 0) {
        return { admin: target, roleKeys: current };
      }

      const roleIds = await this.resolveRoleIds(scope, next, tx);
      await this.roles.setAdminRoles(scope, target.id, roleIds, adminIdOf(actor), tx);

      // before/after are the locked state, so the audit row describes the
      // transition that actually occurred rather than the one intended.
      await this.audit.record(
        scope,
        actor,
        {
          action: 'admin.roles_change',
          entityType: 'Admin',
          entityId: target.id,
          before: { roleKeys: current },
          after: { roleKeys: next },
          reason: command.reason,
          result: 'SUCCESS',
        },
        tx,
      );

      await this.outbox.write(tx, actor, {
        eventType: 'AdminRolesChanged',
        aggregateType: 'Admin',
        aggregateId: target.id,
        payload: { added: delta.added, removed: delta.removed },
      });

      void now;
      return { admin: target, roleKeys: next };
    });

    return result;
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
    // Hashed before the transaction opens: the KDF is intentionally slow, and
    // holding a transaction open for its duration turns one password change into
    // contention for every other writer in the tenant.
    const hash = await this.hasher.hash(command.newPassword);
    const now = this.clock.now();

    // COMPARE-AND-SET, not a blind write.
    //
    // Verification happened outside the transaction — it has to, for the reason
    // above — so between verifying and writing, another rotation can commit.
    // Both requests validated against the same old password; without a
    // predicate, the slower one silently overwrites the newer credential, and
    // it does so from a session the first rotation already revoked. That is a
    // time-of-check-to-time-of-use window measured in hundreds of milliseconds,
    // because scrypt is deliberately slow.
    //
    // The expected hash therefore travels into the UPDATE's WHERE clause. The
    // check and the write become one atomic statement, and a request whose
    // view of the credential is stale updates no rows.
    const rotated = await this.uow.run(scope, async (tx) => {
      const won = await this.admins.compareAndSetPasswordHash(
        scope,
        adminId,
        credentials.passwordHash,
        hash,
        now,
        tx,
      );
      // Nothing else has run yet, so throwing here rolls back an empty
      // transaction: no revocation, no audit row claiming success, no event.
      if (!won) return false;

      // Everything below commits with the rotation or not at all. It used to be
      // two transactions, and a failure in between left the credential replaced
      // while every session opened with the old one stayed live.
      //
      // ALL sessions are revoked, including the one making the request. An
      // administrator rotating a password they believe is exposed cannot know
      // which live session is the attacker's, so keeping "theirs" would be a
      // guess. They sign in again; the surface clears the cookie.
      await this.sessions.revokeAllForAdmin(scope, adminId, now, 'password_changed', tx);

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

      return true;
    });

    if (!rotated) {
      // Recorded outside the aborted transaction, so the denial survives the
      // rollback that discarded everything else.
      await this.audit.record(scope, actor, {
        action: 'admin.password_change',
        entityType: 'Admin',
        entityId: adminId,
        before: null,
        after: { reason: 'STALE_CREDENTIAL' },
        result: 'DENIED',
      });
      // UNAUTHENTICATED rather than CONFLICT: the credential this request
      // validated against no longer exists, and the session it arrived on was
      // revoked by whoever won. There is nothing to retry — sign in again.
      throw errors.unauthenticated(
        IDENTITY_ERROR_CODES.ADMIN_PASSWORD_STALE,
        'The password was changed by another request. Sign in again.',
      );
    }
  }

  /**
   * Refuses to grant a permission the acting administrator does not hold.
   *
   * Without this, `admins.edit` silently confers every assignable role's
   * powers: create an administrator with the `finance` role, set its password,
   * sign in as it. The self-modification guard does not help — the puppet is
   * somebody else — so the two rules only work together.
   *
   * An owner holds the whole catalog, so this never constrains them. It
   * constrains a DELEGATED admin manager, which is the case the rule exists
   * for and the case that will actually occur once roles are edited.
   */
  private async assertGrantsNoMorePrivilegeThanHeld(
    scope: ScopeContext,
    actor: ActorContext,
    roleKeys: readonly string[],
  ): Promise<void> {
    const actorId = adminIdOf(actor);
    if (actorId === null) return;

    const held = new Set(await this.roles.permissionsForAdmin(scope, actorId));
    const granting = new Set<string>();
    for (const role of await this.roles.list(scope)) {
      if (!roleKeys.includes(role.key)) continue;
      for (const permission of role.permissions) granting.add(permission);
    }

    const excess = [...granting].filter((permission) => !held.has(permission as never)).sort();
    if (excess.length > 0) {
      throw errors.permissionDenied(
        IDENTITY_ERROR_CODES.ADMIN_PRIVILEGE_ESCALATION,
        'You cannot grant a permission you do not hold yourself.',
        { permissions: excess },
      );
    }
  }

  private async requireAdmin(scope: ScopeContext, id: AdminId, tx?: unknown): Promise<Admin> {
    const admin = await this.admins.findById(scope, id, tx);
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
    // Read inside the transaction, under the lock the caller already holds.
    const roleKeys = await this.admins.roleKeysFor(scope, target.id, tx);
    const targetIsActiveOwner = roleKeys.includes(OWNER_ROLE_KEY) && target.status === 'ACTIVE';
    const activeOwnerCount = await this.admins.countActiveOwners(scope, tx);
    assertOwnerSurvives({ activeOwnerCount, targetIsActiveOwner });
  }

  private async resolveRoleIds(
    scope: ScopeContext,
    keys: readonly string[],
    tx?: unknown,
  ): Promise<RoleId[]> {
    const { found, missing } = await this.roles.idsForKeys(scope, keys, tx);
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
