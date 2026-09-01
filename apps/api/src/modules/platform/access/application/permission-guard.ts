import {
  errors,
  PLATFORM_ERROR_CODES,
  resolveEffectivePermissions,
  SYSTEM_JOB_PERMISSIONS,
  type ActorContext,
  type Clock,
  type OperationalEventRecorder,
  type PermissionKey,
  type PermissionOverride,
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
 * Phase 0 ships the guard and the catalog. There is no authentication yet and
 * no admin records to resolve, so the human-actor resolver grants nothing. That
 * is deliberate: a stub that grants everything would be copied into Phase 1.
 */

export interface PermissionResolver {
  /** The permissions this actor effectively holds in this scope. */
  resolve(scope: ScopeContext, actor: ActorContext): Promise<ReadonlySet<PermissionKey>>;
}

export class PermissionGuard {
  constructor(
    private readonly resolver: PermissionResolver,
    private readonly opsLog: OperationalEventRecorder,
  ) {}

  async check(scope: ScopeContext, actor: ActorContext, permission: PermissionKey): Promise<void> {
    const held = await this.effective(scope, actor);
    if (held.has(permission)) return;

    // Every denial is an operational event. Repeated denials from one actor are
    // a signal worth alerting on, and they cannot be if they are never recorded.
    await this.opsLog.record(scope, {
      code: 'access.permission_denied',
      severity: 'WARN',
      message: `Actor ${actor.type}:${actor.id ?? 'anonymous'} was denied ${permission}.`,
      context: { permission, actorType: actor.type, actorId: actor.id, surface: actor.surface },
      correlationId: actor.correlationId,
    });

    throw errors.permissionDenied(
      PLATFORM_ERROR_CODES.PERMISSION_DENIED,
      `Missing permission "${permission}".`,
      { permission },
    );
  }

  async has(scope: ScopeContext, actor: ActorContext, permission: PermissionKey): Promise<boolean> {
    return (await this.effective(scope, actor)).has(permission);
  }

  private async effective(
    scope: ScopeContext,
    actor: ActorContext,
  ): Promise<ReadonlySet<PermissionKey>> {
    if (actor.type === 'SYSTEM_JOB') {
      return new Set<PermissionKey>(SYSTEM_JOB_PERMISSIONS);
    }
    return this.resolver.resolve(scope, actor);
  }
}

/**
 * Phase 0's resolver for human actors: nobody holds any permission, because
 * there are no admins and no authentication. Phase 1 replaces this with a
 * resolver backed by `admins`, `roles`, `role_permissions` and per-admin
 * overrides.
 */
export class NoAdminsPermissionResolver implements PermissionResolver {
  async resolve(): Promise<ReadonlySet<PermissionKey>> {
    return new Set<PermissionKey>();
  }
}

/**
 * The resolution rule Phase 1 will use, implemented and tested now because it is
 * pure and because getting DENY-wins wrong is expensive to discover later.
 */
export function effectivePermissions(
  rolePermissions: readonly PermissionKey[],
  overrides: readonly PermissionOverride[],
  clock: Clock,
): ReadonlySet<PermissionKey> {
  return resolveEffectivePermissions(rolePermissions, overrides, clock.now());
}
