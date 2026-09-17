import {
  adminChangeReasonSchema,
  adminPasswordSchema,
  adminUsernameSchema,
  telegramUserIdSchema,
  createAdminRequestSchema,
  changePasswordRequestSchema,
  errors,
  IDENTITY_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  isNexaError,
  isSystemContext,
  type TenantContext,
  OWNER_ROLE_KEY,
  setAdminRolesRequestSchema,
  setAdminStatusRequestSchema,
  type ActorContext,
  type Admin,
  type AdminId,
  type AdminSessionId,
  type TenantStatus,
  type AdminStatus,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type OperationalEventRecorder,
  type PasswordHasher,
  type PermissionKey,
  type Role,
  type RoleId,
  type ScopeContext,
  type UnitOfWork,
  type ManagementAdminEventCode,
} from '@nexa/contracts';
import {
  denialEventRecorded,
  type PermissionGuard,
} from '../../access/application/permission-guard.js';
import type { OutboxWriter } from '../../eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { DrizzleRoleRepository } from '../infrastructure/drizzle-role.repository.js';
import type { AdminRepository, SessionRepository } from './ports.js';
import { assertNotSelf, assertOwnerSurvives, diffRoles } from '../domain/admin-protection.js';
import type { CredentialThrottle, Reservation } from './credential-throttle.js';

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
/**
 * Refuses a write for a tenant that is not open for business.
 *
 * Called with the status the tenant LOCK returned, never with one read
 * separately: authentication established a status when the request arrived, and
 * a stop committing between then and the lock would otherwise be observed by
 * the lock and ignored by the work it protects.
 *
 * Reported as an unauthenticated session rather than a distinct code, matching
 * what a stopped installation tells every other caller.
 */
function assertTenantActive(status: TenantStatus): void {
  if (status !== 'ACTIVE') {
    throw errors.unauthenticated(
      IDENTITY_ERROR_CODES.AUTH_SESSION_INVALID,
      'The session is not valid. Sign in again.',
    );
  }
}

/**
 * What the surface must resolve for a password rotation.
 *
 * Mirrors `LoginContext`: deciding whether a client address can be believed is
 * a transport question, and the application layer must not guess at it.
 */
export interface PasswordChangeContext {
  /** The throttle subject, already checked against the trusted-proxy config. */
  readonly ip: string | null;
}

export class AdminManagementService {
  constructor(
    private readonly guard: PermissionGuard,
    private readonly uow: UnitOfWork<TransactionScope>,
    private readonly admins: AdminRepository,
    private readonly roles: DrizzleRoleRepository,
    private readonly sessions: SessionRepository,
    private readonly hasher: PasswordHasher,
    private readonly audit: AuditWriter,
    private readonly opsLog: OperationalEventRecorder,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly throttle: CredentialThrottle,
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
    /*
     * BEFORE the parse, and this is the odd arm of its own file.
     *
     * `setStatus` and `setRoles` both authorize and then parse; only `create`
     * was inverted — the one that mints a NEW CREDENTIAL with roles attached.
     * A `ZodError` is a 400 that never reaches the guard, so an authenticated
     * caller without `admins.edit` who posted `{nonsense:true}` was answered
     * 400 and left NO `access.permission_denied` and NO DENIED audit row,
     * while the same caller posting a well-formed body left both. Measured:
     * +0 and +0 against +1 and +1.
     *
     * The previous round moved the five panel writes for exactly this reason
     * and said in three documents that the panel service was "the last to
     * follow a rule the others kept". It was not: this was, in the module with
     * the highest blast radius on the surface, and in a file that already did
     * it correctly twice. Correct where the author was looking, wrong one
     * module over — the same shape the move itself was fixing.
     *
     * Still a CHEAP rejection before the expensive hash, so an unprivileged
     * caller does not get to spend a KDF per request, and still NOT the
     * authorization of record: that is re-run under the lock below, because
     * this one is read on the pool and can be stale by the time the row is
     * written.
     */
    await this.assertMayAttempt(scope, actor, 'admins.edit', {
      action: 'admin.create',
      entityId: null,
    });
    const command = createAdminRequestSchema.parse(input);
    const username = adminUsernameSchema.parse(command.username.trim().toLowerCase());
    adminPasswordSchema.parse(command.password);

    const adminId = this.ids.uuid() as AdminId;
    // Hashing is deliberately outside the transaction: it is intentionally slow,
    // and holding a database transaction open for the duration of a KDF turns
    // one slow request into contention for every other writer.
    const passwordHash = await this.hasher.hash(command.password);

    const roleKeys = [...new Set(command.roleKeys)].sort();

    // Everything that decides whether this administrator may exist happens
    // under the tenant lock, on the locked connection.
    //
    // `create` mints a NEW CREDENTIAL with roles attached and a password the
    // caller chooses — the most privileged act on this surface — and it used to
    // authorize entirely before the transaction, with scrypt inside the gap.
    // That made the window wide and attacker-triggerable rather than
    // microseconds, and two interleavings exploited it:
    //
    //   - a manager disabled mid-request still created a live administrator,
    //     AFTER the disable and the session revocation had committed;
    //   - a manager demoted mid-request still granted the role they had just
    //     lost, because the amplification check had passed against a snapshot
    //     that no longer existed.
    //
    // Both are the same mistake `setRoles` was corrected for: authorization on
    // state that can change before the write commits.
    await this.runLockedMutation(
      scope,
      actor,
      { action: 'admin.create', entityId: null },
      async (tx) => {
        // The lock, and the tenant's status as of holding it. Authentication
        // checked that status when the request arrived, which is a snapshot: a
        // stop committing in between would otherwise be observed by the lock
        // and ignored by the work it protects.
        assertTenantActive(await this.admins.lockTenantForAdminChange(scope, tx));

        // The session, before the authority it carries. A revoked session is
        // not a less-privileged actor; it is not an actor.
        await this.assertSessionStillLive(scope, actor, tx);

        // Taken after the lock, for the reason `setStatus` states: this request
        // may have queued here for the length of another mutation, and the row
        // it writes should be stamped with when it happened, not when it asked.
        const now = this.clock.now();

        // Re-checked against authoritative state. If the caller lost
        // `admins.edit` — or was disabled, which empties their permissions — the
        // hash just computed is simply discarded.
        await this.guard.check(scope, actor, 'admins.edit', tx);

        // Granting the owner role is the single most privileged act available.
        // `admins.edit` creates administrators; making one an owner additionally
        // needs the permission that governs privilege itself.
        if (roleKeys.includes(OWNER_ROLE_KEY)) {
          await this.guard.check(scope, actor, 'admins.permissions.edit', tx);
        }
        await this.assertGrantsNoMorePrivilegeThanHeld(scope, actor, roleKeys, tx);

        const existing = await this.admins.findByUsername(scope, username, tx);
        if (existing !== null) {
          throw errors.conflict(
            IDENTITY_ERROR_CODES.ADMIN_USERNAME_TAKEN,
            'An administrator with that username already exists.',
            { username },
          );
        }

        // The other uniqueness the schema enforces. Without this check the
        // unique index rejected the INSERT instead, and a driver error is a
        // 500 — an ordinary input mistake reported as a server fault, and a
        // declared conflict code (`admin.telegram_id_taken`) that nothing could
        // ever emit. Read on the locked connection, so two requests claiming
        // the same Telegram account cannot both pass it.
        if (command.telegramUserId != null) {
          const linked = await this.admins.findByTelegramUserId(scope, command.telegramUserId, tx);
          if (linked !== null) {
            throw errors.conflict(
              IDENTITY_ERROR_CODES.ADMIN_TELEGRAM_ID_TAKEN,
              'That Telegram account is already linked to an administrator.',
              { telegramUserId: command.telegramUserId },
            );
          }
        }

        const roleIds = await this.resolveRoleIds(scope, roleKeys, tx);

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
              roleKeys,
            },
            result: 'SUCCESS',
          },
          tx,
        );

        await this.recordAdminChange(
          scope,
          tx,
          'admin.created',
          `administrator ${username} was created`,
          { adminId, username, roleKeys },
        );

        await this.outbox.write(tx, actor, {
          eventType: 'AdminCreated',
          aggregateType: 'Admin',
          aggregateId: adminId,
          payload: { username, roleKeys },
        });
      },
    );

    const created = await this.admins.findById(scope, adminId);
    if (created === null) {
      throw errors.internal(
        'admin.create_failed',
        'The administrator was not readable after creation.',
      );
    }
    return { admin: created, roleKeys };
  }

  async setStatus(
    scope: ScopeContext,
    actor: ActorContext,
    targetId: AdminId,
    input: unknown,
  ): Promise<{ admin: Admin; roleKeys: string[] }> {
    // A cheap rejection, NOT the authorization. It is read on the pool, so by
    // the time this request reaches the lock the actor may have been disabled
    // or demoted. The authoritative check is inside the transaction.
    await this.assertMayAttempt(scope, actor, 'admins.edit', {
      action: 'admin.status_change',
      entityId: targetId,
    });
    const command = setAdminStatusRequestSchema.parse(input);

    // Refused before anything is read: an admin cannot disable themselves, and
    // this holds no matter which permissions they carry.
    assertNotSelf(adminIdOf(actor), targetId);

    const updated = await this.runLockedMutation(
      scope,
      actor,
      { action: 'admin.status_change', entityId: targetId },
      async (tx) => {
        // The lock, and the tenant's status as of holding it. Authentication
        // checked that status when the request arrived, which is a snapshot: a
        // stop committing in between would otherwise be observed by the lock
        // and ignored by the work it protects.
        assertTenantActive(await this.admins.lockTenantForAdminChange(scope, tx));

        // The session, before the authority it carries. A revoked session is
        // not a less-privileged actor; it is not an actor.
        await this.assertSessionStillLive(scope, actor, tx);

        // The mutation time, taken AFTER the lock rather than before it.
        // A request can queue on this lock for as long as the holder takes, and
        // a timestamp captured before waiting describes a moment when the
        // transition had not happened. The sharp case: a target logs in and is
        // issued a session while a disable waits here, and the revocation then
        // stamps `revoked_at` earlier than that session's `issued_at` — a
        // record that says the session was revoked before it existed.
        const now = this.clock.now();

        // The actor's BASE authority, re-read under the lock. Target state was
        // already reloaded here; the actor's own right to act was not, so a
        // manager disabled or demoted while this request was in flight still
        // mutated another administrator. Disabling empties an actor's
        // permissions, so this covers both cases with one check.
        await this.guard.check(scope, actor, 'admins.edit', tx);

        // Transaction-aware, for the same reason as setRoles: a read on the pool
        // after the lock does not participate in it, so the status this decision
        // rests on could differ from the one about to be overwritten.
        const target = await this.requireAdmin(scope, targetId, tx);
        // Re-checked against the id the DATABASE returned, not the one the caller
        // supplied. The boundary already canonicalises, and this is the check
        // that does not depend on it having: whatever row we are about to write
        // is the row the guard now sees.
        assertNotSelf(adminIdOf(actor), target.id);
        if (target.status === command.status) {
          // The no-op path returns the same projection as the change path, read
          // under the same lock — so the response shape does not depend on
          // whether the status happened to differ.
          return { admin: target, roleKeys: await this.admins.roleKeysFor(scope, target.id, tx) };
        }

        // Changing an OWNER's status is a change to privilege, so it takes the
        // permission that governs privilege — the same gate `setRoles` applies
        // to granting or removing the role.
        //
        // Without it the two paths disagreed about the same authority:
        // `admins.permissions.edit` was required to take the owner role away,
        // but plain `admins.edit` sufficed to disable the owner outright, which
        // empties their authority just as completely (the resolver grants a
        // non-ACTIVE admin nothing). Placed before the DISABLED branch so it
        // gates re-enabling too — restoring an owner is the same act reversed.
        const targetRoleKeys = await this.admins.roleKeysFor(scope, target.id, tx);
        if (targetRoleKeys.includes(OWNER_ROLE_KEY)) {
          await this.guard.check(scope, actor, 'admins.permissions.edit', tx);
        }

        if (command.status === 'DISABLED') {
          await this.assertOwnerSurvivesDisabling(scope, target, tx);
        }

        // Re-enabling RESTORES authority, so it is bound by the same rule as
        // conferring it: an administrator may not hand out a permission they do
        // not hold themselves.
        //
        // Gating only the owner key was too narrow. A disabled account holding
        // `refunds.issue`, or a custom role carrying `admins.permissions.edit`,
        // could be switched back on by an actor with plain `admins.edit` — who
        // could not have created that account, and could not have granted it
        // those roles. The account already existing does not make restoring it
        // a smaller act; the resolver gives a disabled admin nothing, so ACTIVE
        // is where the authority comes back.
        if (command.status === 'ACTIVE') {
          await this.assertRestoresNoMorePrivilegeThanHeld(scope, actor, target.id, tx);
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

        await this.recordAdminChange(
          scope,
          tx,
          'admin.status_changed',
          `administrator ${target.username} went from ${target.status} to ${command.status}`,
          { adminId: targetId, from: target.status, to: command.status },
        );

        await this.outbox.write(tx, actor, {
          eventType: 'AdminStatusChanged',
          aggregateType: 'Admin',
          aggregateId: targetId,
          payload: { from: target.status, to: command.status },
        });

        // The role keys come back with the status, read under the same lock
        // in the same transaction. The controller used to fetch them itself
        // afterwards, straight off the repository — outside this transaction,
        // so a concurrent role change made the response combine a status from
        // one moment with roles from another, and a web surface was reaching
        // past the application layer to finish a business response.
        return {
          admin: { ...target, status: command.status as AdminStatus },
          roleKeys: targetRoleKeys,
        };
      },
    );

    return updated;
  }

  async setRoles(
    scope: ScopeContext,
    actor: ActorContext,
    targetId: AdminId,
    input: unknown,
  ): Promise<{ admin: Admin; roleKeys: string[] }> {
    // A cheap rejection, NOT the authorization — see setStatus.
    await this.assertMayAttempt(scope, actor, 'admins.edit', {
      action: 'admin.roles_change',
      entityId: targetId,
    });
    const command = setAdminRolesRequestSchema.parse(input);

    // Cheap and state-independent, so it can refuse before any work.
    assertNotSelf(adminIdOf(actor), targetId);

    const next = [...new Set(command.roleKeys)].sort();

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
    const result = await this.runLockedMutation(
      scope,
      actor,
      { action: 'admin.roles_change', entityId: targetId },
      async (tx) => {
        // The lock, and the tenant's status as of holding it. Authentication
        // checked that status when the request arrived, which is a snapshot: a
        // stop committing in between would otherwise be observed by the lock
        // and ignored by the work it protects.
        assertTenantActive(await this.admins.lockTenantForAdminChange(scope, tx));

        // The session, before the authority it carries. A revoked session is
        // not a less-privileged actor; it is not an actor.
        await this.assertSessionStillLive(scope, actor, tx);

        // The actor's BASE authority, re-read under the lock — before any target
        // state, because an actor who has lost `admins.edit` has no business
        // reading it either.
        //
        // This matters most for a REMOVE-ONLY delta: `delta.added` is then empty,
        // so the amplification check examines nothing and would wave the request
        // through. Losing all authority has to stop the mutation on its own.
        await this.guard.check(scope, actor, 'admins.edit', tx);

        // Transaction-aware. A read on the pool after the lock does not
        // participate in it and can observe a different snapshot.
        const target = await this.requireAdmin(scope, targetId, tx);
        assertNotSelf(adminIdOf(actor), target.id);

        const current = await this.admins.roleKeysFor(scope, target.id, tx);
        const delta = diffRoles(current, next);

        // Authorised from the LOCKED delta. Granting or removing the owner role
        // is a change to privilege itself, not merely to an assignment.
        if (delta.added.includes(OWNER_ROLE_KEY) || delta.removed.includes(OWNER_ROLE_KEY)) {
          await this.guard.check(scope, actor, 'admins.permissions.edit', tx);
        }
        // Also from the locked delta: only what is genuinely being ADDED relative
        // to authoritative state. Removing a role is not amplification.
        await this.assertGrantsNoMorePrivilegeThanHeld(scope, actor, delta.added, tx);

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

        await this.recordAdminChange(
          scope,
          tx,
          'admin.roles_changed',
          `administrator ${target.username} had roles changed`,
          { adminId: target.id, added: delta.added, removed: delta.removed },
        );

        await this.outbox.write(tx, actor, {
          eventType: 'AdminRolesChanged',
          aggregateType: 'Admin',
          aggregateId: target.id,
          payload: { added: delta.added, removed: delta.removed },
        });
        return { admin: target, roleKeys: next };
      },
    );

    return result;
  }

  /**
   * Reserves a password attempt, recording the refusal as THIS action.
   *
   * The counter is shared with login; the audit row is not. Recording a refused
   * rotation as a refused login would make the trail lie about what happened.
   */
  /**
   * Binds a Telegram account to an administrator, or removes the binding (Phase 5T).
   *
   * ## What this actually confers
   *
   * Everything that administrator can do, through a second channel. `AdminPermissionResolver`
   * treats `TELEGRAM_ADMIN` exactly as it treats `WEB_ADMIN` — same roles, same
   * permissions, same tenant — so binding a Telegram account to an administrator hands
   * whoever holds that account that administrator's authority.
   *
   * That is why this takes the SAME two gates `setRoles` applies to conferring
   * authority, and not merely `admins.edit`:
   *
   *   - the target's privileges must be a subset of the actor's
   *     (`assertRestoresNoMorePrivilegeThanHeld`), so an administrator cannot bind
   *     their own Telegram account to the owner and act as the owner from a chat;
   *   - an OWNER target additionally takes `admins.permissions.edit`, because binding
   *     a channel to the owner account is a change to who may exercise owner authority.
   *
   * Without the first gate this method would be the escalation path `UNK-ADM-005`
   * names, reached with a permission the Mirza research found every one of its four
   * production admins holding.
   *
   * ## What it deliberately does NOT do
   *
   * Create an administrator. A Telegram-only administrator would need a row with no
   * usable `password_hash`, and there is no such shape in this identity model — so the
   * Telegram section links an administrator the Web Admin created, which is the
   * cleanest existing creation path rather than a faked second one.
   *
   * Revoking is `null`, and it leaves the account, its roles and its Web Admin access
   * untouched. Access through Telegram ends immediately either way, because the
   * resolver reads the binding on every turn and a disabled administrator resolves to
   * nothing at all.
   */
  async setTelegramBinding(
    scope: ScopeContext,
    actor: ActorContext,
    targetId: AdminId,
    input: { readonly telegramUserId: string | null; readonly reason: string },
  ): Promise<{ admin: Admin; roleKeys: string[] }> {
    // The cheap rejection, on the pool, exactly as `setStatus` does it. The
    // authoritative check is inside the transaction below.
    await this.assertMayAttempt(scope, actor, 'admins.edit', {
      action: 'admin.telegram_binding',
      entityId: targetId,
    });

    const reason = adminChangeReasonSchema.parse(input.reason);
    // Validated with the SAME schema the customer side uses, because it is the same
    // fact: a Telegram numeric id. The column's CHECK repeats the shape, and a value
    // that reached it unvalidated would be a 23514 reported as a server fault.
    const telegramUserId =
      input.telegramUserId === null ? null : telegramUserIdSchema.parse(input.telegramUserId);

    return this.runLockedMutation(
      scope,
      actor,
      { action: 'admin.telegram_binding', entityId: targetId },
      async (tx) => {
        assertTenantActive(await this.admins.lockTenantForAdminChange(scope, tx));
        await this.assertSessionStillLive(scope, actor, tx);
        const now = this.clock.now();

        // Re-read under the lock: an actor disabled or demoted while this request
        // waited is not a less-privileged actor, and `resolve` gives a disabled one
        // nothing.
        await this.guard.check(scope, actor, 'admins.edit', tx);

        const target = await this.requireAdmin(scope, targetId, tx);
        const targetRoleKeys = await this.admins.roleKeysFor(scope, target.id, tx);

        // Binding a channel to the OWNER is a change to who may exercise owner
        // authority, so it takes the permission that governs privilege — the same gate
        // `setStatus` applies to disabling or restoring an owner.
        if (targetRoleKeys.includes(OWNER_ROLE_KEY)) {
          await this.guard.check(scope, actor, 'admins.permissions.edit', tx);
        }

        // Only for a GRANT. Removing a channel confers nothing, and requiring the
        // grant test to revoke would leave an escalated binding in place precisely
        // when somebody noticed it.
        if (telegramUserId !== null) {
          await this.assertRestoresNoMorePrivilegeThanHeld(scope, actor, target.id, tx);
        }

        if (target.telegramUserId === telegramUserId) {
          // The no-op path answers with the same projection read under the same lock,
          // so the response shape does not depend on whether anything changed.
          return { admin: target, roleKeys: targetRoleKeys };
        }

        // The uniqueness the schema enforces, checked on the locked connection so two
        // requests claiming one Telegram account cannot both pass it. Without this the
        // partial unique index rejects the UPDATE and an ordinary input mistake is
        // reported as a 500 — the defect `create` already states.
        if (telegramUserId !== null) {
          const linked = await this.admins.findByTelegramUserId(scope, telegramUserId, tx);
          if (linked !== null && linked.id !== target.id) {
            throw errors.conflict(
              IDENTITY_ERROR_CODES.ADMIN_TELEGRAM_ID_TAKEN,
              'That Telegram account is already linked to an administrator.',
              { telegramUserId },
            );
          }
        }

        await this.admins.setTelegramUserId(scope, targetId, telegramUserId, now, tx);

        /*
         * The audit row carries the BEFORE and AFTER ids, and no session is revoked.
         *
         * A Telegram binding is not a session: there is nothing to revoke, and the next
         * turn from that chat resolves the binding again — so removing it ends access
         * at the next update rather than at some expiry. Web Admin sessions are
         * untouched on purpose; this changes one channel, not the account.
         */
        await this.audit.record(
          scope,
          actor,
          {
            action: 'admin.telegram_binding',
            entityType: 'Admin',
            entityId: targetId,
            before: { telegramUserId: target.telegramUserId },
            after: { telegramUserId },
            reason,
            result: 'SUCCESS',
          },
          tx,
        );

        /*
         * No outbox event, and that is a decision rather than an omission.
         *
         * `DOMAIN_EVENT_TYPES` is a frozen catalogue with a typed payload per event, and
         * adding one is a contract change that has to earn itself with a consumer.
         * Nothing reacts to a binding: there is no session to revoke, no projection to
         * rebuild, and access ends at the next update because the resolver re-reads the
         * column every turn. The audit row above is the record this act owes.
         */
        return { admin: { ...target, telegramUserId }, roleKeys: targetRoleKeys };
      },
    );
  }

  private async reservePasswordAttempt(
    scope: TenantContext,
    actor: ActorContext,
    username: string,
    ip: string | null,
    adminId: AdminId,
  ): Promise<Reservation> {
    try {
      return await this.throttle.reserve(scope, actor, username, ip);
    } catch (error) {
      if (isNexaError(error) && error.code === IDENTITY_ERROR_CODES.AUTH_RATE_LIMITED) {
        await this.audit.record(scope, actor, {
          action: 'admin.password_change',
          entityType: 'Admin',
          entityId: adminId,
          before: null,
          after: { reason: 'THROTTLED' },
          result: 'DENIED',
        });
      }
      throw error;
    }
  }

  /**
   * Changing one's OWN password.
   *
   * Not covered by `assertNotSelf`: it requires the current password, grants
   * nothing, and refusing it would mean an administrator could never rotate a
   * credential they believe is exposed. It needs no catalog permission for the
   * same reason — the current password IS the authorization.
   */
  async changeOwnPassword(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
    context: PasswordChangeContext,
  ): Promise<void> {
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

    // Counted before it is checked, exactly as login is.
    //
    // This endpoint verifies a password and was not throttled at all, so an
    // attacker holding a stolen session could guess the current password
    // without limit — each guess spending a production-cost scrypt derivation,
    // which is a CPU and memory exhaustion path as well as a brute force. And
    // the prize is worse than it looks: finding the password turns a session
    // that expires into a credential that does not.
    //
    // The SAME counter login uses, keyed by the same username. Two counters
    // would let an attacker locked out of login carry on guessing here, which
    // is the same credential by another door.
    // The throttle counts per tenant subject, so this needs a tenant scope. An
    // administrator rotating their own password always has one; asserting it
    // here rather than casting means a system-scoped caller fails loudly
    // instead of counting against a subject that does not exist.
    if (isSystemContext(scope)) {
      throw errors.validation(
        PLATFORM_ERROR_CODES.TENANT_CONTEXT_MISSING,
        'A password change needs a tenant scope.',
      );
    }
    const tenantScope: TenantContext = scope;

    // The throttle subject, resolved by the SURFACE — not `actor.ip`.
    //
    // `actor.ip` is the audit's view: whatever address the request arrived
    // from, kept verbatim so the trail is honest. The throttle needs a
    // different thing, which login already computes: an address that can be
    // BELIEVED as a client's, null when it cannot. Behind a reverse proxy with
    // no usable forwarded address that is the proxy's own IP, and counting
    // against it would let one account's failed rotations lock the address
    // every administrator shares — the installation-wide lockout the login path
    // exists to avoid, reintroduced through the other door. IPv4-mapped forms
    // are normalised there too, and were not here.
    const ip = context.ip;
    const reserved = await this.reservePasswordAttempt(
      tenantScope,
      actor,
      admin.username,
      ip,
      adminId,
    );

    let currentMatches: boolean;
    try {
      currentMatches = await this.hasher.verify(command.currentPassword, credentials.passwordHash);
    } catch (error) {
      // Never judged, so it must not be counted — the same rule login follows.
      await this.throttle.release(tenantScope, admin.username, ip, reserved);
      throw error;
    }

    if (!currentMatches) {
      // A verified failure keeps its reservation. That is the guess being
      // counted, and it is the whole point of the counter.
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

    // Correct: give it back, so rotating a password cannot rate-limit the
    // person doing it.
    await this.throttle.release(tenantScope, admin.username, ip, reserved);

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
      // The same serialization the administrator mutations take, for the same
      // three reasons: a stopped tenant must not accept a rotation that was
      // authenticated before it stopped; the timestamp below must describe when
      // this happened rather than when it asked; and the wait itself is what
      // those two are measured against.
      assertTenantActive(await this.admins.lockTenantForAdminChange(scope, tx));

      // Same rule as the administrator mutations: a revoked session performs no
      // writes. The compare-and-set below already loses to a competing
      // ROTATION, but a logout changes no hash, so without this a signed-out
      // request could still commit one.
      await this.assertSessionStillLive(scope, actor, tx);

      // Captured after the wait, not before it. A rotation that queued here
      // while a login issued a session would otherwise revoke that session with
      // a timestamp older than its own issue time.
      const now = this.clock.now();

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

      await this.recordAdminChange(
        scope,
        tx,
        'admin.password_changed',
        'an administrator changed their own password',
        { adminId, bySelf: true },
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
    tx?: unknown,
  ): Promise<void> {
    const actorId = adminIdOf(actor);
    if (actorId === null) return;

    // The actor's EFFECTIVE permissions, resolved by the same rule the guard
    // uses — `(roles ∪ GRANT) − DENY`. This used to read the raw union of the
    // actor's roles, which ignores overrides in both directions. The dangerous
    // direction: an actor with a DENY on `refunds.issue` was refused it
    // directly, then handed it out by creating an administrator with a role
    // that carries it and choosing that account's password. A permission the
    // system says you do not have is not one you may delegate.
    const held = await this.guard.permissionsOf(scope, actor, tx);
    const granting = new Set<string>();
    for (const role of await this.roles.list(scope, tx)) {
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

  /**
   * Refuses to restore authority the acting administrator does not hold.
   *
   * The counterpart of `assertGrantsNoMorePrivilegeThanHeld` for the one path
   * that confers permissions without naming any: flipping a disabled account
   * back to ACTIVE. What comes back is resolved by the guard's own rule rather
   * than recomputed here, including the target's own overrides — a DENY on the
   * target still subtracts, and a GRANT on the target still counts as authority
   * being restored.
   */
  private async assertRestoresNoMorePrivilegeThanHeld(
    scope: ScopeContext,
    actor: ActorContext,
    targetId: AdminId,
    tx?: unknown,
  ): Promise<void> {
    if (adminIdOf(actor) === null) return;

    const restoring = await this.guard.permissionsIfActive(scope, targetId, tx);
    if (restoring.size === 0) return;

    const held = await this.guard.permissionsOf(scope, actor, tx);
    const excess = [...restoring].filter((permission) => !held.has(permission)).sort();
    if (excess.length > 0) {
      throw errors.permissionDenied(
        IDENTITY_ERROR_CODES.ADMIN_PRIVILEGE_ESCALATION,
        'You cannot restore an administrator holding permissions you do not hold yourself.',
        { permissions: excess },
      );
    }
  }

  /**
   * The cheap pre-lock authorization check, with its denial audited.
   *
   * The check itself is only a fast rejection — the decision that counts is
   * re-run under the tenant lock. But it is also the one an ordinary
   * unauthorized request actually hits, and it used to throw straight out of
   * the service: the guard wrote its operational event and nothing wrote the
   * `DENIED` audit row. Whether an attempted administrator mutation appeared in
   * the audit log therefore depended on WHEN the denial fired — early, and it
   * vanished; late, because the actor lost authority mid-request, and it was
   * recorded. That is precisely the "activity feed with no attempt history" the
   * legacy system had.
   *
   * Only the audit row is written here. The guard already records the
   * operational event for a check made outside a transaction;
   * `runLockedMutation` records it when the guard reports it did not
   * (`denialEventRecorded`), which for an in-lock check is always.
   */
  private async assertMayAttempt(
    scope: ScopeContext,
    actor: ActorContext,
    permission: PermissionKey,
    denial: { action: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.guard.check(scope, actor, permission);
    } catch (error) {
      if (isNexaError(error) && error.kind === 'PERMISSION_DENIED') {
        await this.audit.record(scope, actor, {
          action: denial.action,
          entityType: 'Admin',
          entityId: denial.entityId,
          before: null,
          after: { deniedPermission: permission },
          result: 'DENIED',
        });
      }
      throw error;
    }
  }

  /**
   * Refuses if the session authorising this request has been revoked.
   *
   * Session validity is established once, when the request arrives, and then
   * the request does work. A logout or a password rotation committing in that
   * window revokes the session — and without re-reading it here, the request
   * still commits. That would make "a rotation revokes every session" true of
   * the rows and false of the requests already in flight, which is the one
   * thing rotation exists to guarantee.
   *
   * Read on the LOCKED connection, inside the transaction that is about to
   * commit, for the same reason the actor's permissions are.
   */
  private async assertSessionStillLive(
    scope: ScopeContext,
    actor: ActorContext,
    tx: TransactionScope,
  ): Promise<void> {
    const sessionId = actor.sessionId;
    // System work has no session. It is fenced by the boundary check and by
    // holding only what the contract grants `SYSTEM_JOB`, not by this.
    if (sessionId === undefined) return;

    const live = await this.sessions.isLive(
      scope,
      sessionId as AdminSessionId,
      this.clock.now(),
      tx,
    );
    if (!live) {
      throw errors.unauthenticated(
        IDENTITY_ERROR_CODES.AUTH_SESSION_INVALID,
        'The session is not valid. Sign in again.',
      );
    }
  }

  /**
   * The management-facing operational event for an administrator change.
   *
   * Owner revision 24 names administrator changes — adds, removals, role and
   * permission changes — as belonging on the Web Admin's Management Alerts
   * page. That page reads `operational_events`; these changes were only ever
   * written to `audit_logs`, under an `action` that merely LOOKED like an
   * event code. `MANAGEMENT_EVENT_CODE_PREFIXES = ['admin.']` matched the
   * audit vocabulary and therefore matched nothing the page could read, so
   * the requirement was claimed and not delivered.
   *
   * Recorded inside the caller's transaction, beside the audit row, so the two
   * records cannot disagree about whether the change happened.
   *
   * NO `dedupeKey`: each of these is a distinct act by a distinct person at a
   * distinct time, and collapsing "roles changed" onto one row with a counter
   * would destroy exactly the history an operator opens this page to read.
   * They are one-shot records, which is why they are in
   * `MANAGEMENT_EVENT_CODES` and NOT in `MANAGEMENT_CONDITION_CODES`: nothing
   * resolves them, and the dashboard's "needs attention" card must not fill
   * with them.
   */
  private async recordAdminChange(
    scope: ScopeContext,
    tx: TransactionScope,
    code: ManagementAdminEventCode,
    message: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    await this.opsLog.record(scope, { code, severity: 'INFO', message, context }, tx);
  }

  /**
   * Runs a locked mutation and records a denial once the transaction is gone.
   *
   * The guard deliberately does not write its operational event from inside a
   * transaction: it would take a second pool connection while holding one and
   * the tenant lock, and the row would roll back with the denial anyway. So the
   * transactional caller records it here — on the pool, after the rollback,
   * where both are safe — unless the guard reports it already did
   * (`denialEventRecorded`), which is the question every after-the-fact
   * recorder asks so that one refusal is one event (OQ-3D-03).
   *
   * Not every denial this catches came from the guard. An escalation refusal
   * (`assertGrantsNoMorePrivilegeThanHeld`, `assertRestoresNoMorePrivilegeThanHeld`)
   * is thrown by this service, carries no marker, and is recorded here alone.
   *
   * The audit row is the more important half, and it is written FIRST. A
   * refused administrative mutation is exactly the kind of event an operator
   * needs to see later, and before this it left no trace at all for
   * `setStatus` and `setRoles`. The two writes are not atomic; if the event
   * write fails, the audit row is already there and the write's error is
   * what the caller sees in place of the 403.
   */
  private async runLockedMutation<T>(
    scope: ScopeContext,
    actor: ActorContext,
    denial: { action: string; entityId: string | null },
    fn: (tx: TransactionScope) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.uow.run(scope, fn);
    } catch (error) {
      if (isNexaError(error) && error.kind === 'PERMISSION_DENIED') {
        // A guard denial names one permission under `permission`; an
        // amplification refusal names the whole offending set under
        // `permissions`. Reading only the singular recorded the second — the
        // more serious of the two, an administrator caught trying to confer
        // authority they do not hold — as permission `unknown` in the
        // operational log and `null` in the audit row, which is precisely the
        // record an operator would need and the one they would not get.
        const single = error.details['permission'];
        const many = error.details['permissions'];
        const attempted = Array.isArray(many) ? many.map(String) : single ? [String(single)] : [];

        // The audit row FIRST. It is the half an operator needs later, and a
        // failing operational-event write must not cost it: the two are
        // separate writes on the pool, nothing makes them atomic, and the
        // order is the only thing that decides which survives.
        await this.audit.record(scope, actor, {
          action: denial.action,
          entityType: 'Admin',
          entityId: denial.entityId,
          before: null,
          after: {
            deniedPermission: attempted[0] ?? null,
            // The full set, and the code that distinguishes a plain denial from
            // an attempted escalation. One name is not the story when somebody
            // tried to hand out five permissions at once.
            deniedPermissions: attempted,
            reason: error.code,
          },
          result: 'DENIED',
        });
        // The guard is the authority on whether the operational event exists
        // (OQ-3D-03). Every check inside a locked mutation passes `tx`, so the
        // guard wrote nothing and this is the emitter — but that is a fact
        // about today's callers, not a rule this function can see, and the
        // shared recorder learned the hard way that "the guard wrote nothing"
        // is exactly the sentence that goes false one call site over. Ask.
        if (!denialEventRecorded(error)) {
          await this.opsLog.record(
            scope,
            this.guard.denialEvent(actor, (attempted[0] ?? 'unknown') as PermissionKey),
          );
        }
      }
      throw error;
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
