import {
  errors,
  PLATFORM_ERROR_CODES,
  SYSTEM_JOB_PERMISSIONS,
  type ActorContext,
  type AdminId,
  type OperationalEventInput,
  type OperationalEventRecorder,
  type PermissionKey,
  type ScopeContext,
} from '@nexa/contracts';

/**
 * The permission guard.
 *
 * Deny by default: a permission that is not granted is denied, and an unknown
 * permission is denied. Checks run in the application layer, on every call,
 * from every surface. Hiding a menu item is UX, not authorisation — in the
 * legacy system the role descriptions may never have been enforced at all
 * (UNK-ADM-001), because "enforcement" there means not drawing a button.
 *
 * There is deliberately NO actor type that skips the check. An earlier version
 * let `SYSTEM_JOB` through on the reasoning that background work is our own
 * code and therefore trusted — which was false the moment an HTTP surface
 * constructed a `SYSTEM_JOB` actor for an anonymous caller. Jobs now hold an
 * explicit, narrow permission set (`SYSTEM_JOB_PERMISSIONS`) like everyone else,
 * so a job that gains a new power gains it visibly, in a contract diff.
 *
 * Phase 1 supplies the real resolver (`AdminPermissionResolver`), backed by
 * `admins`, `roles`, `role_permissions` and per-admin overrides, and resolving
 * on every call rather than caching authority into a session. Phase 0's
 * placeholder resolver has been deleted rather than left in place: a resolver
 * that grants nothing is a correct answer when there are no admins and a
 * dangerous one the moment there are.
 */

export interface PermissionResolver {
  /**
   * The permissions this actor effectively holds in this scope.
   *
   * `tx` makes the read participate in the caller's transaction. A permission
   * re-checked under a lock must be read on the LOCKED connection: a pool read
   * neither participates in the lock nor draws from the same connection, and
   * with every pool connection held by a transaction waiting for one, the
   * process deadlocks itself.
   */
  resolve(
    scope: ScopeContext,
    actor: ActorContext,
    tx?: unknown,
  ): Promise<ReadonlySet<PermissionKey>>;
  /**
   * What an administrator holds, or WOULD hold once ACTIVE.
   *
   * Needed because re-enabling a disabled administrator restores authority, and
   * `resolve` deliberately reports a disabled one as holding nothing.
   */
  permissionsIfActive(
    scope: ScopeContext,
    adminId: AdminId,
    tx?: unknown,
  ): Promise<ReadonlySet<PermissionKey>>;
}

export class PermissionGuard {
  constructor(
    private readonly resolver: PermissionResolver,
    private readonly opsLog: OperationalEventRecorder,
  ) {}

  async check(
    scope: ScopeContext,
    actor: ActorContext,
    permission: PermissionKey,
    tx?: unknown,
  ): Promise<void> {
    const held = await this.effective(scope, actor, tx);
    if (held.has(permission)) return;

    // Every denial is an operational event — repeated denials from one actor
    // are a signal worth alerting on, and cannot be if nothing records them.
    //
    // But NOT from inside a caller's transaction. The recorder writes on the
    // pool, so recording here while the caller holds a pool connection AND the
    // tenant row lock would take a SECOND connection from the same pool. With
    // `DATABASE_POOL_MAX` concurrent denials, every connection is held by a
    // transaction waiting for a connection that will never come, and the
    // transaction never rolls back, so the tenant lock is never released
    // either: the process wedges until restart. Reproduced at pool size 1.
    //
    // The row would roll back with the denial in any case, so writing it here
    // buys nothing even when it does not deadlock. A transactional caller owns
    // recording its own denial, AFTER the transaction unwinds — the pattern
    // `AdminManagementService` uses.
    if (tx === undefined) {
      await this.opsLog.record(scope, this.denialEvent(actor, permission));
    }

    throw errors.permissionDenied(
      PLATFORM_ERROR_CODES.PERMISSION_DENIED,
      `Missing permission "${permission}".`,
      { permission },
    );
  }

  async has(
    scope: ScopeContext,
    actor: ActorContext,
    permission: PermissionKey,
    tx?: unknown,
  ): Promise<boolean> {
    return (await this.effective(scope, actor, tx)).has(permission);
  }

  /**
   * The operational event a denial produces.
   *
   * Exposed so a transactional caller can record the same event once its
   * transaction has unwound, rather than the guard writing it under a lock.
   */
  denialEvent(actor: ActorContext, permission: PermissionKey): OperationalEventInput {
    return {
      code: 'access.permission_denied',
      severity: 'WARN',
      message: `Actor ${actor.type}:${actor.id ?? 'anonymous'} was denied ${permission}.`,
      context: { permission, actorType: actor.type, actorId: actor.id, surface: actor.surface },
      ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
    };
  }

  /**
   * The actor's effective permissions, by the ONE resolution rule.
   *
   * Exposed because anything deciding what an actor may do must decide it the
   * same way `check` does. A caller that assembles its own view of an actor's
   * authority will eventually disagree with the guard, and the disagreement
   * will be the security hole.
   */
  async permissionsOf(
    scope: ScopeContext,
    actor: ActorContext,
    tx?: unknown,
  ): Promise<ReadonlySet<PermissionKey>> {
    return this.effective(scope, actor, tx);
  }

  /** The authority a re-enable would restore. See `PermissionResolver`. */
  async permissionsIfActive(
    scope: ScopeContext,
    adminId: AdminId,
    tx?: unknown,
  ): Promise<ReadonlySet<PermissionKey>> {
    return this.resolver.permissionsIfActive(scope, adminId, tx);
  }

  private async effective(
    scope: ScopeContext,
    actor: ActorContext,
    tx?: unknown,
  ): Promise<ReadonlySet<PermissionKey>> {
    if (actor.type === 'SYSTEM_JOB') {
      return new Set<PermissionKey>(SYSTEM_JOB_PERMISSIONS);
    }
    return this.resolver.resolve(scope, actor, tx);
  }
}
