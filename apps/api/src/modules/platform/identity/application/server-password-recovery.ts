import {
  adminPasswordSchema,
  adminUsernameSchema,
  errors,
  IDENTITY_ERROR_CODES,
  systemJobActor,
  type AdminId,
  type AuditWriter,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type OperationalEventRecorder,
  type PasswordHasher,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { AdminRepository, LoginThrottleRepository, SessionRepository } from './ports.js';

/**
 * Owner recovery for a forgotten PASSWORD, from the SERVER (`botctl admin reset-password`).
 *
 * The sibling of `ServerSecondFactorRecovery`, with the same shape and for the same reason:
 * the operator who runs it has no session, so it authorizes no caller, so it must be
 * unreachable from every surface by CONSTRUCTION. Only the CLI entrypoint builds one, from
 * the container's parts; `scripts/check-boundaries.sh` refuses any surface that imports it.
 *
 * It writes the stored hash with the application's OWN hasher (the one login verifies
 * with), under the application's own password policy, and in ONE transaction:
 *
 *   - the new hash replaces the old one;
 *   - the administrator's failed-login counter is erased, so the person who has just been
 *     given a password is not still locked out by the attempts that made them ask;
 *   - every session they hold ends — whoever knew the old password, or held a session
 *     opened with it, loses access;
 *   - an audit row (`admin.password_reset`, actor `SYSTEM_JOB`, `via: SERVER_CLI`) and a
 *     WARN on the alerts page record the act. Neither carries the password, a hash, a
 *     length or a prefix.
 *
 * Their second factor is NOT touched: a lost password and a lost authenticator are
 * different recoveries (`admin reset-2fa`), and one must not quietly perform the other.
 * Not refused for a stopped tenant, for the reason the 2FA recovery is not: it only ever
 * restores access, and a stopped installation is one whose owner may need back in.
 */
export interface ServerPasswordRecoveryDependencies {
  readonly uow: UnitOfWork<TransactionScope>;
  readonly admins: AdminRepository;
  readonly sessions: SessionRepository;
  readonly throttle: LoginThrottleRepository;
  readonly hasher: PasswordHasher;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export class ServerPasswordRecovery {
  constructor(private readonly deps: ServerPasswordRecoveryDependencies) {}

  async resetPasswordFromServer(
    scope: TenantContext,
    input: { readonly username: string; readonly password: string },
  ): Promise<{ adminId: AdminId; endedSignIns: number }> {
    // The same normalisation login applies to the username, and the same policy the
    // application enforces everywhere a password is set. Both throw before any work.
    const username = adminUsernameSchema.parse(input.username.trim().toLowerCase());
    adminPasswordSchema.parse(input.password);
    const actor = systemJobActor(
      'install:reset-admin-password',
      this.deps.ids.uuid() as CorrelationId,
    );
    // Outside the transaction, like every other password write: a KDF is intentionally
    // slow and must not hold the tenant lock for its duration.
    const passwordHash = await this.deps.hasher.hash(input.password);

    return this.deps.uow.run(scope, async (tx) => {
      await this.deps.admins.lockTenantForAdminChange(scope, tx);
      const admin = await this.deps.admins.findByUsername(scope, username, tx);
      if (admin === null) {
        throw errors.notFound(IDENTITY_ERROR_CODES.ADMIN_NOT_FOUND, 'No such administrator.');
      }
      const now = this.deps.clock.now();
      await this.deps.admins.setPasswordHash(scope, admin.id, passwordHash, now, tx);
      // The USERNAME counter, as login keys it (the normalised username). The IP rows
      // belong to whoever was at that address, not to this administrator, and stay.
      await this.deps.throttle.clear(scope, 'USERNAME', admin.username, tx);
      const endedSignIns = await this.deps.sessions.revokeAllForAdmin(
        scope,
        admin.id,
        now,
        'admin_password_reset',
        tx,
      );
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'admin.password_reset',
          entityType: 'Admin',
          entityId: admin.id,
          // Keys chosen so the audit writer's redaction of `password`/`session` does not
          // blank the only facts the row carries (see AdminManagementService).
          before: { liveSignIns: endedSignIns },
          after: { rotated: true, endedSignIns, via: 'SERVER_CLI' },
          reason: 'owner recovery from the server',
          result: 'SUCCESS',
        },
        tx,
      );
      await this.deps.opsLog.record(
        scope,
        {
          code: 'admin.password_reset',
          severity: 'WARN',
          message: `the password of administrator ${admin.username} was reset from the server`,
          context: { adminId: admin.id, endedSignIns, via: 'SERVER_CLI' },
        },
        tx,
      );
      return { adminId: admin.id, endedSignIns };
    });
  }
}
