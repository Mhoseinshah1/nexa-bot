import {
  adminChangeReasonSchema,
  adminUsernameSchema,
  errors,
  HOSTING_ERROR_CODES,
  IDENTITY_ERROR_CODES,
  OWNER_ROLE_KEY,
  systemJobActor,
  type AdminId,
  type AuditWriter,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { AdminRepository } from '../../identity/application/ports.js';
import type { HostingRepository } from './ports.js';

export interface ServerHostingFactorRecoveryDependencies {
  readonly uow: UnitOfWork<TransactionScope>;
  readonly repository: Pick<
    HostingRepository,
    | 'lockFactor'
    | 'deleteFactor'
    | 'countUnusedRecoveryCodes'
    | 'replaceRecoveryCodes'
    | 'revokeSessions'
  >;
  readonly admins: Pick<
    AdminRepository,
    'findByUsername' | 'roleKeysFor' | 'lockTenantForAdminChange'
  >;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * Owner recovery for the «میزبانی‌ها» section's own second factor, from the SERVER
 * (`botctl admin reset-hosting-2fa`, `pnpm admin:hosting-2fa-reset`).
 *
 * The same shape and the same reasons as `ServerSecondFactorRecovery` (the Web Admin
 * sign-in factor): its own class, never a container property, built only by the CLI
 * entrypoint, so no surface can reach it and `scripts/check-boundaries.sh` refuses any
 * that imports it. It authorizes no caller — the operator at the host has no session,
 * which is the lockout it ends — and whoever can run it already holds the database
 * credentials.
 *
 * It removes the section's factor (PENDING or ACTIVE), its recovery codes and every
 * section session the administrator holds. It does NOT touch the sign-in factor
 * (`admin_totp_factors`), the password or the Web Admin sessions: the owner stays
 * signed in wherever they are and simply enrols a new device in the section. The audit
 * row (`hosting.totp_reset`, actor `SYSTEM_JOB`, the operator's reason) is written in the
 * INSTALLATION's log — hosted tenants never see it.
 *
 * Only the installation owner has a section factor, so the target must hold the system
 * `owner` role in the installation tenant.
 */
export class ServerHostingFactorRecovery {
  constructor(private readonly deps: ServerHostingFactorRecoveryDependencies) {}

  async resetFromServer(
    installation: TenantContext,
    input: { readonly username: string; readonly reason: string },
  ): Promise<{
    adminId: AdminId;
    hadFactor: boolean;
    recoveryCodesRemoved: number;
    endedSectionSessions: number;
  }> {
    const username = adminUsernameSchema.parse(input.username.trim().toLowerCase());
    const reason = adminChangeReasonSchema.parse(input.reason);
    const actor = systemJobActor(
      'install:reset-hosting-2fa',
      this.deps.ids.uuid() as CorrelationId,
    );

    return this.deps.uow.run(installation, async (tx) => {
      // The tenant lock every administrator change takes; not refused for a stopped
      // installation (recovery only removes access).
      await this.deps.admins.lockTenantForAdminChange(installation, tx);
      const admin = await this.deps.admins.findByUsername(installation, username, tx);
      if (admin === null) {
        throw errors.notFound(IDENTITY_ERROR_CODES.ADMIN_NOT_FOUND, 'No such administrator.');
      }
      const roles = await this.deps.admins.roleKeysFor(installation, admin.id, tx);
      if (!roles.includes(OWNER_ROLE_KEY)) {
        throw errors.permissionDenied(
          HOSTING_ERROR_CODES.OWNER_ONLY,
          'Only the installation owner has a hosting section factor.',
        );
      }
      const now = this.deps.clock.now();
      // Under the factor row's lock, so it serialises against an enrolment or a code
      // check in flight.
      const factor = await this.deps.repository.lockFactor(installation, admin.id, tx);
      const recoveryCodesRemoved = await this.deps.repository.countUnusedRecoveryCodes(
        installation,
        admin.id,
        tx,
      );
      if (factor !== null) await this.deps.repository.deleteFactor(installation, factor.id, tx);
      await this.deps.repository.replaceRecoveryCodes(installation, admin.id, [], now, tx);
      const endedSectionSessions = await this.deps.repository.revokeSessions(
        installation,
        { adminId: admin.id, now },
        tx,
      );
      await this.deps.audit.record(
        installation,
        actor,
        {
          action: 'hosting.totp_reset',
          entityType: 'Admin',
          entityId: admin.id,
          before: { hadFactor: factor !== null, factorState: factor?.state ?? 'NONE' },
          after: {
            state: 'NONE',
            recoveryCodesRemoved,
            endedSectionSessions,
            via: 'SERVER_CLI',
          },
          reason,
          result: 'SUCCESS',
        },
        tx,
      );
      return {
        adminId: admin.id,
        hadFactor: factor !== null,
        recoveryCodesRemoved,
        endedSectionSessions,
      };
    });
  }
}
