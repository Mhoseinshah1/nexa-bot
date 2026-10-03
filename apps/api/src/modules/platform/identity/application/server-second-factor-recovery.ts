import {
  adminChangeReasonSchema,
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
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { AdminRepository, SecondFactorRepository, SessionRepository } from './ports.js';

/**
 * Owner recovery for two-step sign-in, from the SERVER (`pnpm admin:2fa-reset`,
 * `botctl admin reset-2fa`).
 *
 * Its own class, and deliberately NOT a property of the container (D2 security review).
 * It authorizes no caller — the server operator has no session, which is the lockout it
 * exists to end — so it must be unreachable from every surface by CONSTRUCTION: the only
 * code that builds one is the CLI entrypoint, from the container's parts. A surface
 * holding the container cannot reach it without importing this module, and
 * `scripts/check-boundaries.sh` refuses any surface that does (and still text-matches
 * the method name as a backstop).
 */
export interface ServerSecondFactorRecoveryDependencies {
  readonly uow: UnitOfWork<TransactionScope>;
  readonly admins: AdminRepository;
  readonly sessions: SessionRepository;
  readonly factors: SecondFactorRepository;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export class ServerSecondFactorRecovery {
  constructor(private readonly deps: ServerSecondFactorRecoveryDependencies) {}

  /**
   * Owner recovery from the SERVER (`pnpm admin:2fa-reset`, `botctl admin reset-2fa`).
   *
   * The answer to the lockout a second factor creates: the only owner has lost their
   * phone and their backup codes. It is a CLI and never an endpoint, for the reason
   * `admin:bootstrap` is: there is no caller to authorize, so over HTTP it would be an
   * unauthenticated route that strips a factor. Whoever can run it already holds the
   * database credentials, which is more than this grants.
   *
   * What it does is deliberately small — removes the factor and its backup codes, and
   * ends every session — so the person recovering still needs the PASSWORD to get in.
   * It never sets a password and never creates a session. Audited as `SYSTEM_JOB`
   * with the operator's stated reason, and raised as a WARN on the alerts page.
   */
  async resetFromServer(
    scope: TenantContext,
    input: { readonly username: string; readonly reason: string },
  ): Promise<{ adminId: AdminId; hadSecondFactor: boolean; endedSignIns: number }> {
    const username = adminUsernameSchema.parse(input.username.trim().toLowerCase());
    const reason = adminChangeReasonSchema.parse(input.reason);
    const actor = systemJobActor('install:reset-admin-2fa', this.deps.ids.uuid() as CorrelationId);

    return this.deps.uow.run(scope, async (tx) => {
      // The tenant lock every administrator change takes, so this serialises against
      // the holder's own enrolment and against a login in flight. NOT refused for a
      // stopped tenant: recovery only ever removes access, and a stopped installation
      // is precisely one whose owner may need back in.
      await this.deps.admins.lockTenantForAdminChange(scope, tx);
      const admin = await this.deps.admins.findByUsername(scope, username, tx);
      if (admin === null) {
        throw errors.notFound(IDENTITY_ERROR_CODES.ADMIN_NOT_FOUND, 'No such administrator.');
      }
      const now = this.deps.clock.now();
      const hadSecondFactor = await this.deps.factors.deleteFactor(scope, admin.id, tx);
      const endedSignIns = await this.deps.sessions.revokeAllForAdmin(
        scope,
        admin.id,
        now,
        'second_factor_reset',
        tx,
      );
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'admin.totp_reset',
          entityType: 'Admin',
          entityId: admin.id,
          before: { hadSecondFactor },
          after: { state: 'DISABLED', endedSignIns, via: 'SERVER_CLI' },
          reason,
          result: 'SUCCESS',
        },
        tx,
      );
      await this.deps.opsLog.record(
        scope,
        {
          code: 'admin.second_factor_reset',
          severity: 'WARN',
          message: `two-step sign-in of administrator ${admin.username} was reset from the server`,
          context: { adminId: admin.id, hadSecondFactor, endedSignIns, via: 'SERVER_CLI' },
        },
        tx,
      );
      return { adminId: admin.id, hadSecondFactor, endedSignIns };
    });
  }
}
