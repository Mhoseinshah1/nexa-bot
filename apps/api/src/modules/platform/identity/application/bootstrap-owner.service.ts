import {
  adminDisplayNameSchema,
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
import type { AdminRepository, BootstrapRecordReader } from './ports.js';

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

/**
 * What the installer needs to know before it decides whether to bootstrap.
 *
 *   - `none`         — no administrator exists. Bootstrap normally.
 *   - `bootstrapped` — administrators exist AND this installation's own
 *                      bootstrap created them. A rerun may carry on past this
 *                      step; there is nothing left to do and nothing to ask.
 *   - `foreign`      — administrators exist with no record of this bootstrap.
 *                      The installer must stop: it is looking at a database it
 *                      did not provision, and continuing would attach a fresh
 *                      release identity to somebody else's installation.
 *
 * The distinction is the whole point. "There is an administrator, therefore the
 * bootstrap must have succeeded" is the reasoning that turns a safety fence
 * into a shrug.
 */
export type BootstrapStatus = 'none' | 'bootstrapped' | 'foreign';

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
    private readonly bootstrapRecord: BootstrapRecordReader,
  ) {}

  /**
   * Read-only. Creates nothing, and is NOT a way in.
   *
   * It exists because an interrupted install had no safe way to resume. The
   * owner is committed several steps before the release manifest and `current`
   * pointer are written, and on a real staging host the install stopped in
   * exactly that gap. A rerun then hit `execute` again, was refused with
   * BOOTSTRAP_ALREADY_DONE — correctly — and the installation was left running,
   * healthy, and permanently unable to record which release it was running.
   *
   * The fence in `execute` is untouched. This does not relax it, and it is not
   * consulted by it: `execute` still refuses whenever any administrator exists,
   * whoever created them. This only lets the INSTALLER tell apart the state it
   * produced from a state it must not touch.
   */
  async status(scope: TenantContext): Promise<BootstrapStatus> {
    const admins = await this.admins.list(scope);
    if (admins.length === 0) return 'none';
    return (await this.bootstrapRecord.wasBootstrapped(scope)) ? 'bootstrapped' : 'foreign';
  }

  async execute(scope: TenantContext, input: BootstrapOwnerInput): Promise<BootstrapOwnerResult> {
    const username = adminUsernameSchema.parse(input.username.trim().toLowerCase());
    adminPasswordSchema.parse(input.password);
    // The same rule the HTTP surface applies. Validated here because there is
    // no profile-edit route: whatever the installer types is what the first
    // owner is called, permanently, unless someone edits the database. Pressing
    // Enter at the prompt used to be accepted.
    const displayName = adminDisplayNameSchema.parse(input.displayName);

    // A cheap rejection before the hash. NOT the fence — that is re-run under
    // the tenant lock below, because this read sees only what has committed so
    // far and two bootstraps started together would both see nothing.
    const existingBefore = await this.admins.list(scope);
    if (existingBefore.length > 0) {
      throw this.alreadyBootstrapped(existingBefore.length);
    }

    const now = this.clock.now();
    const adminId = this.ids.uuid() as AdminId;
    const passwordHash = await this.hasher.hash(input.password);
    const correlationId = this.ids.uuid() as CorrelationId;
    const actor: ActorContext = systemJobActor('install:bootstrap-owner', correlationId);

    await this.uow.run(scope, async (tx) => {
      // The fence, for real this time: the same lock every administrator
      // mutation takes, so a second bootstrap either waits and then sees the
      // first one's owner, or holds the lock itself and the first waits.
      await this.admins.lockTenantForAdminChange(scope, tx);

      const existing = await this.admins.list(scope, tx);
      if (existing.length > 0) {
        throw this.alreadyBootstrapped(existing.length);
      }

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
          displayName,
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

  /**
   * The one condition that makes an unauthorized provisioning path safe: an
   * installation with any administrator is administered through the
   * authenticated surface, never through this.
   */
  private alreadyBootstrapped(adminCount: number): Error {
    return errors.conflict(
      IDENTITY_ERROR_CODES.BOOTSTRAP_ALREADY_DONE,
      'This installation already has administrators. Bootstrap creates the FIRST one only; ' +
        'use the admin surface, or recover through an existing owner.',
      { adminCount },
    );
  }
}
