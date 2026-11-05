import {
  errors,
  HOSTING_ERROR_CODES,
  IDENTITY_ERROR_CODES,
  isSystemContext,
  OWNER_ROLE_KEY,
  type ActorContext,
  type AdminId,
  type AdminSessionId,
  type Clock,
  type AuditWriter,
  type OperationalEventRecorder,
  type PermissionKey,
  type ScopeContext,
  type TenantContext,
} from '@nexa/contracts';
import { recordMutationDenial } from '../../access/application/authorized-mutation.js';
import type { PermissionGuard } from '../../access/application/permission-guard.js';

/** The creator panel's permission. CRITICAL; seeded to `owner` only. */
export const HOSTING_PERMISSION: PermissionKey = 'hosting.manage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who may reach the creator panel: the INSTALLATION OWNER, precisely —
 *
 *   1. the scope is the installation tenant's (the PRIMARY tenant this process resolved at
 *      start), never a hosted bot's or a reseller bot's;
 *   2. the actor is an administrator (an admin id, not a job);
 *   3. the guard grants `hosting.manage` in that scope (deny by default, overrides apply);
 *   4. and that administrator holds the system `owner` role there.
 *
 * Every one is required. (1) is what stops a hosted bot's own owner, who holds EVERY key in
 * their own tenant (`owner` = ALL); (4) is what stops an installation operator somebody
 * handed `hosting.manage` through a custom role or an ALLOW override — the owner decided
 * this section is the owner's, not a delegable permission. Checked again inside every write
 * transaction, so a role removed mid-request is not overtaken.
 *
 * Inside a transaction (`tx`) the Web Admin session's liveness is re-read too.
 *
 * Each refusal is the same PERMISSION_DENIED (`hosting.owner_only`), naming the permission so
 * `recordMutationDenial` writes the DENIED audit row.
 */
export class HostingOwnerGuard {
  constructor(
    private readonly deps: {
      readonly guard: PermissionGuard;
      readonly audit: AuditWriter;
      readonly opsLog: OperationalEventRecorder;
      readonly admins: {
        roleKeysFor(scope: ScopeContext, id: AdminId, tx?: unknown): Promise<string[]>;
      };
      readonly installationTenantId: () => string | null;
      readonly sessions: {
        isLive(scope: ScopeContext, id: AdminSessionId, now: Date, tx?: unknown): Promise<boolean>;
      };
      readonly clock: Clock;
    },
  ) {}

  /** Throws unless the actor is the installation owner. Answers the installation scope. */
  async check(scope: ScopeContext, actor: ActorContext, tx?: unknown): Promise<TenantContext> {
    const installation = this.deps.installationTenantId();
    if (
      installation === null ||
      isSystemContext(scope) ||
      scope.tenantId.toLowerCase() !== installation.toLowerCase()
    ) {
      throw denied('NOT_INSTALLATION');
    }
    if (actor.id === null || !UUID.test(actor.id)) throw denied('NOT_AN_ADMIN');
    await this.deps.guard.check(scope, actor, HOSTING_PERMISSION, tx);
    const roles = await this.deps.admins.roleKeysFor(scope, actor.id as AdminId, tx);
    if (!roles.includes(OWNER_ROLE_KEY)) throw denied('NOT_OWNER');
    // Inside a write transaction, the Web Admin session must still be live: a sign-out or a
    // revocation that committed after the request arrived stops the write.
    if (
      tx !== undefined &&
      actor.sessionId !== undefined &&
      !(await this.deps.sessions.isLive(
        scope,
        actor.sessionId as AdminSessionId,
        this.deps.clock.now(),
        tx,
      ))
    ) {
      throw errors.unauthenticated(
        IDENTITY_ERROR_CODES.AUTH_SESSION_INVALID,
        'The session is not valid. Sign in again.',
      );
    }
    return { tenantId: scope.tenantId, botInstanceId: null };
  }

  /** `check`, with a refusal audited (DENIED row) before it is rethrown. */
  async checkAudited(
    scope: ScopeContext,
    actor: ActorContext,
    action: string,
    entityId: string | null = null,
  ): Promise<TenantContext> {
    try {
      return await this.check(scope, actor);
    } catch (denial) {
      await recordMutationDenial(
        this.deps,
        scope,
        actor,
        HOSTING_PERMISSION,
        { action, entityType: 'Tenant', entityId },
        denial,
      );
      throw denial;
    }
  }
}

function denied(reason: string): Error {
  return errors.permissionDenied(
    HOSTING_ERROR_CODES.OWNER_ONLY,
    'The creator panel is the installation owner’s only.',
    { permission: HOSTING_PERMISSION, reason },
  );
}
