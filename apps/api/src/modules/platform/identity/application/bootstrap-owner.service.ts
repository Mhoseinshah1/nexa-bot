import {
  adminPasswordSchema,
  adminUsernameSchema,
  errors,
  IDENTITY_ERROR_CODES,
  OWNER_ROLE_KEY,
  systemJobActor,
  type ActorContext,
  type AdminId,
  type AuditWriter,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type PasswordHasher,
  type RoleId,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { OutboxWriter } from '../../eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { DrizzleRoleRepository } from '../infrastructure/drizzle-role.repository.js';
import type { AdminRepository } from './ports.js';

/**
 * Installation bootstrap: creating the first owner.
 *
 * This is PROVISIONING, not a request. It runs from the install CLI, against
 * the database, by whoever already holds the database credentials — there is no
 * caller to authorize, and no administrator exists yet to authorize them.
 *
 * That makes it exactly the shape Phase 0's security review found and removed
 * from the guard, so it is fenced by construction instead:
 *
 *   - it is not reachable from any surface, and `scripts/check-boundaries.sh`
 *     fails the build if a surface ever imports it;
 *   - it refuses to run if the tenant already has ANY administrator, so it can
 *     create the first owner and nothing else. It is not a back door into an
 *     installation that is already running;
 *   - it audits itself as SYSTEM_JOB on the WORKER surface, so the first row in
 *     the audit log says how the first owner came to exist.
 *
 * "No caller to authorize" is a true statement about a provisioning step and a
 * false one about a request handler. The difference is enforced by the boundary
 * check, not by this comment.
 */

export interface BootstrapOwnerInput {
  readonly username: string;
  readonly displayName: string;
  readonly password: string;
}

export interface BootstrapOwnerResult {
  readonly adminId: AdminId;
  readonly username: string;
}

export class BootstrapOwnerService {
  constructor(
    private readonly uow: UnitOfWork<TransactionScope>,
    private readonly admins: AdminRepository,
    private readonly roles: DrizzleRoleRepository,
    private readonly hasher: PasswordHasher,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(scope: TenantContext, input: BootstrapOwnerInput): Promise<BootstrapOwnerResult> {
    const username = adminUsernameSchema.parse(input.username.trim().toLowerCase());
    adminPasswordSchema.parse(input.password);

    const existing = await this.admins.list(scope);
    if (existing.length > 0) {
      // The one condition that makes this safe. An installation with any
      // administrator is administered through the authenticated surface.
      throw errors.conflict(
        IDENTITY_ERROR_CODES.BOOTSTRAP_ALREADY_DONE,
        'This installation already has administrators. Bootstrap creates the FIRST one only; ' +
          'use the admin surface, or recover through an existing owner.',
        { adminCount: existing.length },
      );
    }

    const now = this.clock.now();
    const adminId = this.ids.uuid() as AdminId;
    const passwordHash = await this.hasher.hash(input.password);
    const correlationId = this.ids.uuid() as CorrelationId;
    const actor: ActorContext = systemJobActor('install:bootstrap-owner', correlationId);

    await this.uow.run(scope, async (tx) => {
      await this.roles.ensureSystemRoles(scope, tx);

      const ownerRole = await this.roles.findByKey(scope, OWNER_ROLE_KEY, tx);
      if (ownerRole === null) {
        throw errors.internal(
          IDENTITY_ERROR_CODES.ROLE_NOT_FOUND,
          'The owner role was not seeded. The role catalog is a frozen contract; this is a bug.',
        );
      }

      await this.admins.create(
        scope,
        {
          id: adminId,
          username,
          displayName: input.displayName,
          passwordHash,
          telegramUserId: null,
          now,
        },
        tx,
      );

      // Null `assignedBy`: nobody granted this, the installation did. Recording
      // a fabricated administrator here would be the "fake actor" pattern.
      await this.roles.setAdminRoles(scope, adminId, [ownerRole.id as RoleId], null, tx);

      await this.audit.record(
        scope,
        actor,
        {
          action: 'admin.bootstrap',
          entityType: 'Admin',
          entityId: adminId,
          before: null,
          after: { username, roleKeys: [OWNER_ROLE_KEY] },
          reason: 'Installation bootstrap: first owner.',
          result: 'SUCCESS',
        },
        tx,
      );

      await this.outbox.write(tx, actor, {
        eventType: 'AdminCreated',
        aggregateType: 'Admin',
        aggregateId: adminId,
        payload: { username, roleKeys: [OWNER_ROLE_KEY] },
      });
    });

    return { adminId, username };
  }
}
