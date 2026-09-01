import {
  isSystemContext,
  resolveEffectivePermissions,
  type ActorContext,
  type AdminId,
  type Clock,
  type PermissionKey,
  type ScopeContext,
} from '@nexa/contracts';
import type { AdminRepository, RoleRepository } from '../../identity/application/ports.js';
import type { PermissionResolver } from '../application/permission-guard.js';

/**
 * The real permission resolver. Replaces Phase 0's `NoAdminsPermissionResolver`,
 * which granted nothing to anyone because there were no admins to resolve.
 *
 * Resolution runs PER REQUEST rather than being cached into the session. That
 * is a deliberate trade of a query for a property: a role change or a
 * revocation takes effect on the very next request, and a disabled admin stops
 * being able to act immediately rather than when their session happens to
 * expire. Sessions carry identity; they never carry authority.
 *
 * Everything below denies. There is no branch that returns a full permission
 * set, no actor type that is trusted by construction, and no fallback for an
 * actor the resolver does not recognise — Phase 0's security review found
 * exactly that shape in the guard and it is not being reintroduced here.
 */
export class AdminPermissionResolver implements PermissionResolver {
  constructor(
    private readonly admins: AdminRepository,
    private readonly roles: RoleRepository,
    private readonly clock: Clock,
  ) {}

  async resolve(
    scope: ScopeContext,
    actor: ActorContext,
    tx?: unknown,
  ): Promise<ReadonlySet<PermissionKey>> {
    const empty = new Set<PermissionKey>();

    // Authority is always tenant-scoped. An actor presenting itself under the
    // system scope holds nothing: cross-tenant reads go through an explicit
    // cross-tenant service that does not exist yet, not through this.
    if (isSystemContext(scope)) return empty;

    // Only administrator actor types can hold catalog permissions. A CUSTOMER
    // is not a low-privilege admin; the two are separate concepts, and the
    // legacy system's habit of storing both in one table addressed by Telegram
    // id is precisely what this refuses to reproduce.
    if (actor.type !== 'WEB_ADMIN' && actor.type !== 'TELEGRAM_ADMIN') return empty;
    if (actor.id === null) return empty;

    const adminId = actor.id as AdminId;
    const admin = await this.admins.findById(scope, adminId, tx);

    // No such admin in this tenant, or disabled. A disabled admin keeps their
    // roles — history must still name them — and holds none of their powers.
    if (admin === null || admin.status !== 'ACTIVE') return empty;

    return this.permissionsIfActive(scope, adminId, tx);
  }

  /**
   * What an administrator holds, or WOULD hold if their status were ACTIVE.
   *
   * `resolve` above answers "what may this actor do now", and correctly gives a
   * disabled administrator nothing. Re-enabling one is a different question —
   * what authority is about to be restored — and it has to be answered by the
   * same rule, not by a second implementation of it. Two surfaces computing one
   * concept differently is the failure this codebase is built to avoid; here it
   * would mean the amplification rule disagreeing with the guard about what a
   * permission set contains.
   */
  async permissionsIfActive(
    scope: ScopeContext,
    adminId: AdminId,
    tx?: unknown,
  ): Promise<ReadonlySet<PermissionKey>> {
    // Sequential rather than concurrent when a transaction is supplied: a
    // transaction handle is a single connection and cannot serve two queries at
    // once. Concurrency here would buy microseconds and cost correctness.
    const rolePermissions = await this.roles.permissionsForAdmin(scope, adminId, tx);
    const overrides = await this.roles.overridesForAdmin(scope, adminId, tx);

    // The frozen rule: effective = (roles ∪ GRANT) − DENY, DENY always wins,
    // and an expired override simply stops applying.
    return resolveEffectivePermissions(rolePermissions, overrides, this.clock.now());
  }
}
