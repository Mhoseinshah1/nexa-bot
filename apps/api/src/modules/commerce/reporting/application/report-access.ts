import {
  OWNER_ROLE_KEY,
  PLATFORM_ERROR_CODES,
  errors,
  type ActorContext,
  type AdminId,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { AdminRoleReader } from './ports.js';

export const REPORTS_VIEW_PERMISSION: PermissionKey = 'reports.view';
export const REPORTS_EXPORT_PERMISSION: PermissionKey = 'reports.export';

/**
 * Business and financial reports are for the Super Admin only
 * (`docs/wp12-business-analytics-audit.md` §2).
 *
 * The Super Admin is the EXISTING highest authority: an active administrator holding the
 * `owner` role. There is no new role and no new permission. A permission alone could not
 * say it: `reports.view` is seeded to operator, finance, sales and observer too, and a new
 * one would need a backfill migration to reach the owner roles already stored.
 *
 * So two checks, in this order, and both on every request:
 *
 *   1. The permission, through the guard. That keeps the ONE resolution rule — a disabled
 *      owner, or a negative override on `reports.view`, is refused exactly as everywhere
 *      else — and keeps the guard's audited `access.permission_denied` event.
 *   2. Membership of the owner role, read from the role assignment now, never from a
 *      session. This is a ROLE check, not an actor-type check: nothing here asks what
 *      kind of actor this is, only which roles the named administrator holds.
 *
 * The refusal has the guard's own shape, the 403 `PERMISSION_DENIED` a client already
 * handles, and records the same event with the role it lacked.
 */
export class ReportAccess {
  constructor(
    private readonly guard: PermissionGuard,
    private readonly roles: AdminRoleReader,
    private readonly opsLog: OperationalEventRecorder,
  ) {}

  async authorize(
    scope: TenantContext,
    actor: ActorContext,
    permission: PermissionKey,
  ): Promise<void> {
    await this.guard.check(scope, actor, permission);
    const roleKeys =
      actor.id === null ? [] : await this.roles.roleKeysFor(scope, actor.id as AdminId);
    if (roleKeys.includes(OWNER_ROLE_KEY)) return;

    const event = this.guard.denialEvent(actor, permission);
    await this.opsLog.record(scope, {
      ...event,
      message: `${event.message} Business reports require the ${OWNER_ROLE_KEY} role.`,
      context: { ...event.context, requiredRole: OWNER_ROLE_KEY },
    });
    throw errors.permissionDenied(
      PLATFORM_ERROR_CODES.PERMISSION_DENIED,
      'Business reports are available to the owner only.',
      { permission, requiredRole: OWNER_ROLE_KEY },
    );
  }
}
