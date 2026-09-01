import {
  errors,
  PLATFORM_ERROR_CODES,
  resolveEffectivePermissions,
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
 * Phase 0 ships the guard and the catalog. There is no authentication yet and
 * no admin records to resolve, so `PermissionResolver` has a single
 * implementation that grants nothing to anyone who is not the system. That is
 * deliberate: a stub that grants everything would be copied into Phase 1.
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
    // Background work runs as SYSTEM_JOB and is trusted by construction: it is
    // our own code, and it still leaves an audit row naming the job.
    if (actor.type === 'SYSTEM_JOB') return;

    const held = await this.resolver.resolve(scope, actor);
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
    if (actor.type === 'SYSTEM_JOB') return true;
    return (await this.resolver.resolve(scope, actor)).has(permission);
  }
}

/**
 * Phase 0's resolver: nobody holds any permission, because there are no admins
 * and no authentication. Phase 1 replaces this with a resolver backed by
 * `admins`, `roles`, `role_permissions` and per-admin overrides.
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
