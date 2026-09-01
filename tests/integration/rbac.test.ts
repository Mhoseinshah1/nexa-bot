import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  IDENTITY_ERROR_CODES,
  isNexaError,
  OWNER_ROLE_KEY,
  ROLE_SEEDS,
  systemContext,
  systemJobActor,
  SYSTEM_JOB_PERMISSIONS,
  type AdminId,
  type CorrelationId,
} from '@nexa/contracts';
import {
  adminPermissionOverrides,
  auditLogs,
  outboxMessages,
} from '../../apps/api/src/infrastructure/persistence/schema';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type SeededAdmin,
  type TestContext,
} from './harness';

/**
 * RBAC against the real database.
 *
 * The Phase 0 guard was already deny-by-default; what is under test here is
 * that the resolver behind it reads the right rows, that a role change lands
 * immediately, and that the self-protection rules hold against a real
 * administrator rather than a fixture.
 */

let ctx: TestContext;
let owner: SeededAdmin;
let support: SeededAdmin;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.reset();
  owner = await createAdmin(ctx.container, tenantA, { username: 'owner', roleKeys: ['owner'] });
  support = await createAdmin(ctx.container, tenantA, {
    username: 'support',
    roleKeys: ['support'],
  });
});

describe('permission resolution', () => {
  it('grants an admin exactly their role’s permissions', async () => {
    const seed = ROLE_SEEDS.find((role) => role.key === 'support');
    const resolved = await ctx.container.roles.permissionsForAdmin(tenantA, support.id);
    expect([...resolved].sort()).toEqual([...(seed?.permissions ?? [])].sort());
  });

  it('denies a permission the role does not carry', async () => {
    // Support can view orders and cannot edit administrators. Deny by default
    // means the second is refused because it was never granted, not because
    // anything explicitly forbade it.
    const actor = adminActorFor(support);
    expect(await ctx.container.guard.has(tenantA, actor, 'orders.view')).toBe(true);
    expect(await ctx.container.guard.has(tenantA, actor, 'admins.edit')).toBe(false);
    expect(await ctx.container.guard.has(tenantA, actor, 'refunds.issue')).toBe(false);
  });

  it('grants the owner every permission in the catalog', async () => {
    const resolved = await ctx.container.roles.permissionsForAdmin(tenantA, owner.id);
    expect(resolved).toContain('admins.permissions.edit');
    expect(resolved).toContain('tenant.cross_read');
  });

  it('holds an admin with no roles at nothing', async () => {
    const nobody = await createAdmin(ctx.container, tenantA, { username: 'roleless' });
    const actor = adminActorFor(nobody);
    for (const permission of ['users.view', 'orders.view', 'admins.view'] as const) {
      expect(await ctx.container.guard.has(tenantA, actor, permission)).toBe(false);
    }
  });

  it('holds a disabled admin at nothing, without taking their roles away', async () => {
    // History must still be able to say the admin held the role at the time.
    await ctx.container.adminManagement.setStatus(tenantA, adminActorFor(owner), support.id, {
      status: 'DISABLED',
      reason: 'On leave.',
    });

    expect(await ctx.container.guard.has(tenantA, adminActorFor(support), 'orders.view')).toBe(
      false,
    );
    expect(await ctx.container.admins.roleKeysFor(tenantA, support.id)).toEqual(['support']);
  });

  it('applies a role change on the very next check', async () => {
    // Authority is resolved per request, never cached into a session, so this
    // needs no re-login and no cache invalidation.
    const actor = adminActorFor(support);
    expect(await ctx.container.guard.has(tenantA, actor, 'refunds.issue')).toBe(false);

    await ctx.container.adminManagement.setRoles(tenantA, adminActorFor(owner), support.id, {
      roleKeys: ['finance'],
      reason: 'Moved to the finance team.',
    });

    expect(await ctx.container.guard.has(tenantA, actor, 'refunds.issue')).toBe(true);
    expect(await ctx.container.guard.has(tenantA, actor, 'services.edit')).toBe(false);
  });

  it('unions the permissions of several roles', async () => {
    await ctx.container.adminManagement.setRoles(tenantA, adminActorFor(owner), support.id, {
      roleKeys: ['support', 'finance'],
      reason: 'Covering both desks.',
    });
    const actor = adminActorFor(support);
    expect(await ctx.container.guard.has(tenantA, actor, 'services.edit')).toBe(true);
    expect(await ctx.container.guard.has(tenantA, actor, 'refunds.issue')).toBe(true);
  });
});

describe('permission overrides', () => {
  it('lets DENY beat a role grant', async () => {
    // The frozen rule: effective = (roles ∪ GRANT) − DENY. A DENY that a role
    // could out-vote would be useless for the case it exists for.
    await ctx.container.database.db.insert(adminPermissionOverrides).values({
      tenantId: tenantA.tenantId,
      adminId: support.id,
      permissionKey: 'orders.view',
      effect: 'DENY',
      reason: 'Under investigation.',
      expiresAt: null,
    });

    expect(await ctx.container.guard.has(tenantA, adminActorFor(support), 'orders.view')).toBe(
      false,
    );
  });

  it('lets GRANT add a permission the role lacks', async () => {
    await ctx.container.database.db.insert(adminPermissionOverrides).values({
      tenantId: tenantA.tenantId,
      adminId: support.id,
      permissionKey: 'refunds.issue',
      effect: 'GRANT',
      reason: 'Temporary cover.',
      expiresAt: null,
    });

    expect(await ctx.container.guard.has(tenantA, adminActorFor(support), 'refunds.issue')).toBe(
      true,
    );
  });

  it('stops applying an expired override without anyone running a cleanup', async () => {
    await ctx.container.database.db.insert(adminPermissionOverrides).values({
      tenantId: tenantA.tenantId,
      adminId: support.id,
      permissionKey: 'refunds.issue',
      effect: 'GRANT',
      reason: 'Cover for one shift.',
      expiresAt: new Date(Date.now() - 60_000),
    });

    expect(await ctx.container.guard.has(tenantA, adminActorFor(support), 'refunds.issue')).toBe(
      false,
    );
  });
});

describe('SYSTEM_JOB is still not a bypass', () => {
  it('holds only the narrow set the contract grants background work', async () => {
    // The Phase 0 security review found a blanket bypass here. Phase 1 gives
    // the guard a real resolver, and this is the regression test that the
    // resolver did not quietly become one.
    const job = systemJobActor('nightly', 'corr' as CorrelationId);

    for (const permission of SYSTEM_JOB_PERMISSIONS) {
      expect(await ctx.container.guard.has(tenantA, job, permission)).toBe(true);
    }
    for (const permission of ['admins.edit', 'users.wallet.credit', 'refunds.issue'] as const) {
      expect(await ctx.container.guard.has(tenantA, job, permission)).toBe(false);
    }
  });

  it('cannot manage administrators', async () => {
    const job = systemJobActor('nightly', 'corr' as CorrelationId);
    await expect(ctx.container.adminManagement.list(tenantA, job)).rejects.toThrow();
  });

  it('grants nothing to any actor under the system scope', async () => {
    // Authority is tenant-scoped. An admin actor presenting itself with no
    // tenant holds nothing, whatever roles they have elsewhere.
    expect(
      await ctx.container.guard.has(systemContext('test'), adminActorFor(owner), 'admins.view'),
    ).toBe(false);
  });

  it('grants nothing to a customer actor, whatever id they carry', async () => {
    // A CUSTOMER is not a low-privilege admin. Passing an admin's own id as a
    // customer must not resolve that admin's permissions.
    expect(
      await ctx.container.guard.has(
        tenantA,
        { ...adminActorFor(owner), type: 'CUSTOMER', surface: 'TELEGRAM' },
        'admins.view',
      ),
    ).toBe(false);
  });
});

describe('administrator management', () => {
  it('refuses an unprivileged admin', async () => {
    await expect(
      ctx.container.adminManagement.create(tenantA, adminActorFor(support), {
        username: 'newcomer',
        displayName: 'Newcomer',
        password: 'a-perfectly-fine-password',
        roleKeys: ['support'],
      }),
    ).rejects.toThrow(/permission/i);
  });

  it('creates an administrator, audits it and emits the event', async () => {
    const created = await ctx.container.adminManagement.create(tenantA, adminActorFor(owner), {
      username: 'newcomer',
      displayName: 'Newcomer',
      password: 'a-perfectly-fine-password',
      roleKeys: ['support'],
    });

    expect(created.admin.username).toBe('newcomer');
    expect(created.roleKeys).toEqual(['support']);

    const audits = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'admin.create'));
    expect(audits).toHaveLength(1);
    // The audit records the fact, never the credential.
    expect(JSON.stringify(audits)).not.toContain('a-perfectly-fine-password');

    const events = await ctx.container.database.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.eventType, 'AdminCreated'));
    expect(events).toHaveLength(1);
  });

  it('refuses a duplicate username within the tenant', async () => {
    await expect(
      ctx.container.adminManagement.create(tenantA, adminActorFor(owner), {
        username: 'support',
        displayName: 'Another support',
        password: 'a-perfectly-fine-password',
        roleKeys: ['support'],
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it('permits the same username in a different tenant', async () => {
    const bOwner = await createAdmin(ctx.container, tenantB, {
      username: 'globex-owner',
      roleKeys: ['owner'],
    });
    const created = await ctx.container.adminManagement.create(tenantB, adminActorFor(bOwner), {
      username: 'support',
      displayName: 'Globex support',
      password: 'a-perfectly-fine-password',
      roleKeys: ['support'],
    });
    expect(created.admin.id).not.toBe(support.id);
  });

  it('requires the privilege permission to mint another owner', async () => {
    // `admins.edit` creates administrators. Making one an OWNER is a change to
    // privilege itself, so it additionally needs the permission that governs
    // privilege — otherwise every admin manager is one call from being owner.
    const manager = await createAdmin(ctx.container, tenantA, {
      username: 'manager',
      roleKeys: ['support'],
    });
    await ctx.container.database.db.insert(adminPermissionOverrides).values({
      tenantId: tenantA.tenantId,
      adminId: manager.id,
      permissionKey: 'admins.edit',
      effect: 'GRANT',
      reason: 'Manages the support rota.',
      expiresAt: null,
    });

    await expect(
      ctx.container.adminManagement.create(tenantA, adminActorFor(manager), {
        username: 'sneaky-owner',
        displayName: 'Sneaky',
        password: 'a-perfectly-fine-password',
        roleKeys: [OWNER_ROLE_KEY],
      }),
    ).rejects.toThrow(/permission/i);

    // The same manager may still create an ordinary administrator.
    await expect(
      ctx.container.adminManagement.create(tenantA, adminActorFor(manager), {
        username: 'ordinary',
        displayName: 'Ordinary',
        password: 'a-perfectly-fine-password',
        roleKeys: ['support'],
      }),
    ).resolves.toBeDefined();
  });

  it('cannot see or change an administrator in another tenant', async () => {
    const other = await createAdmin(ctx.container, tenantB, {
      username: 'globex-support',
      roleKeys: ['support'],
    });

    const visible = await ctx.container.adminManagement.list(tenantA, adminActorFor(owner));
    expect(visible.map((entry) => entry.admin.id)).not.toContain(other.id);

    // And the same error whether the id belongs to another tenant or to
    // nobody: a "wrong tenant" message would confirm the id exists somewhere.
    await expect(
      ctx.container.adminManagement.setStatus(tenantA, adminActorFor(owner), other.id, {
        status: 'DISABLED',
        reason: 'Should not be possible.',
      }),
    ).rejects.toThrow(/No such administrator/);
  });
});

describe('owner self-preservation', () => {
  /**
   * An administrator who can manage admins and privileges but is NOT an owner.
   *
   * These tests disable and demote owners, so the acting admin must not be one
   * of the owners under test — otherwise the second call fails because the
   * actor just removed their own permissions, and the test would pass for the
   * wrong reason.
   */
  async function privilegedNonOwner(username = 'manager'): Promise<SeededAdmin> {
    const manager = await createAdmin(ctx.container, tenantA, { username, roleKeys: ['operator'] });
    await ctx.container.database.db.insert(adminPermissionOverrides).values([
      {
        tenantId: tenantA.tenantId,
        adminId: manager.id,
        permissionKey: 'admins.edit',
        effect: 'GRANT',
        reason: 'Administers the admin roster.',
        expiresAt: null,
      },
      {
        tenantId: tenantA.tenantId,
        adminId: manager.id,
        permissionKey: 'admins.permissions.edit',
        effect: 'GRANT',
        reason: 'Administers privileges.',
        expiresAt: null,
      },
    ]);
    return manager;
  }

  it('refuses to disable the last active owner', async () => {
    const manager = await privilegedNonOwner();
    const second = await createAdmin(ctx.container, tenantA, {
      username: 'second-owner',
      roleKeys: ['owner'],
    });

    // Two owners: disabling one is fine.
    await ctx.container.adminManagement.setStatus(tenantA, adminActorFor(manager), owner.id, {
      status: 'DISABLED',
      reason: 'Handing over.',
    });

    // One left: disabling it is refused, and the error says what to do.
    let caught: unknown;
    try {
      await ctx.container.adminManagement.setStatus(tenantA, adminActorFor(manager), second.id, {
        status: 'DISABLED',
        reason: 'Would lock everyone out.',
      });
    } catch (error) {
      caught = error;
    }
    expect(isNexaError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe(IDENTITY_ERROR_CODES.ADMIN_LAST_OWNER);

    // And the owner is genuinely still active, not merely reported as such.
    const still = await ctx.container.admins.findById(tenantA, second.id);
    expect(still?.status).toBe('ACTIVE');
  });

  it('refuses to take the owner role off the last owner', async () => {
    const manager = await privilegedNonOwner();
    const second = await createAdmin(ctx.container, tenantA, {
      username: 'second-owner',
      roleKeys: ['owner'],
    });

    // Two owners: demoting one is fine.
    await expect(
      ctx.container.adminManagement.setRoles(tenantA, adminActorFor(manager), owner.id, {
        roleKeys: ['support'],
        reason: 'Demoting.',
      }),
    ).resolves.toBeDefined();

    await expect(
      ctx.container.adminManagement.setRoles(tenantA, adminActorFor(manager), second.id, {
        roleKeys: ['support'],
        reason: 'Would leave nobody.',
      }),
    ).rejects.toThrow(/last active owner/i);
  });

  it('refuses an admin disabling themselves', async () => {
    await expect(
      ctx.container.adminManagement.setStatus(tenantA, adminActorFor(owner), owner.id, {
        status: 'DISABLED',
        reason: 'Accident.',
      }),
    ).rejects.toThrow(/cannot change their own/i);
  });

  it('refuses an admin editing their own roles, whatever they hold', async () => {
    // The escalation `UNK-ADM-005` asks about. Holding admins.edit is authority
    // over OTHER administrators; without this, any admin manager can grant
    // themselves everything and every other boundary is decorative.
    await expect(
      ctx.container.adminManagement.setRoles(tenantA, adminActorFor(owner), owner.id, {
        roleKeys: ['owner', 'finance'],
        reason: 'Self-promotion.',
      }),
    ).rejects.toThrow(/cannot change their own/i);
  });

  it('permits a genuine hand-over: promote first, then demote', async () => {
    const successor = await createAdmin(ctx.container, tenantA, {
      username: 'successor',
      roleKeys: ['operator'],
    });

    await ctx.container.adminManagement.setRoles(tenantA, adminActorFor(owner), successor.id, {
      roleKeys: [OWNER_ROLE_KEY],
      reason: 'Taking over.',
    });
    await ctx.container.adminManagement.setStatus(tenantA, adminActorFor(successor), owner.id, {
      status: 'DISABLED',
      reason: 'Handed over.',
    });

    expect(await ctx.container.admins.countActiveOwners(tenantA)).toBe(1);
  });
});

describe('password change', () => {
  it('rotates the password and ends every other session', async () => {
    const from = { ip: '203.0.113.20', userAgent: 'vitest' };
    const anonymous = {
      type: 'API' as const,
      id: null,
      label: null,
      surface: 'WEB' as const,
      correlationId: 'corr' as CorrelationId,
    };

    const first = await ctx.container.auth.login(
      tenantA,
      anonymous,
      { username: 'support', password: 'a-perfectly-fine-password' },
      from,
    );

    await ctx.container.adminManagement.changeOwnPassword(tenantA, adminActorFor(support), {
      currentPassword: 'a-perfectly-fine-password',
      newPassword: 'an-entirely-different-password',
    });

    // A password change is what an administrator does when they think a
    // credential is exposed. Leaving the other sessions alive makes it useless
    // for that.
    await expect(ctx.container.auth.authenticate(first.token)).rejects.toThrow();

    await expect(
      ctx.container.auth.login(
        tenantA,
        anonymous,
        { username: 'support', password: 'an-entirely-different-password' },
        from,
      ),
    ).resolves.toBeDefined();
  });

  it('refuses without the current password', async () => {
    await expect(
      ctx.container.adminManagement.changeOwnPassword(tenantA, adminActorFor(support), {
        currentPassword: 'not-the-current-one',
        newPassword: 'an-entirely-different-password',
      }),
    ).rejects.toThrow();
  });

  it('refuses re-using the same password', async () => {
    await expect(
      ctx.container.adminManagement.changeOwnPassword(tenantA, adminActorFor(support), {
        currentPassword: 'a-perfectly-fine-password',
        newPassword: 'a-perfectly-fine-password',
      }),
    ).rejects.toThrow(/differ/i);
  });

  it('audits the change without recording either password', async () => {
    await ctx.container.adminManagement.changeOwnPassword(tenantA, adminActorFor(support), {
      currentPassword: 'a-perfectly-fine-password',
      newPassword: 'an-entirely-different-password',
    });

    const audits = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'admin.password_change'));
    expect(audits).toHaveLength(1);
    const serialised = JSON.stringify(audits);
    expect(serialised).not.toContain('a-perfectly-fine-password');
    expect(serialised).not.toContain('an-entirely-different-password');
  });
});

describe('bootstrap', () => {
  it('creates the first owner and refuses to run again', async () => {
    // The one condition that makes an unauthorized provisioning path safe.
    const fresh = await ctx.container.bootstrapOwner
      .execute(tenantB, {
        username: 'first-owner',
        displayName: 'First Owner',
        password: 'the-installation-owner-password',
      })
      .then((result) => result);

    expect(fresh.username).toBe('first-owner');
    expect(await ctx.container.admins.countActiveOwners(tenantB)).toBe(1);

    let caught: unknown;
    try {
      await ctx.container.bootstrapOwner.execute(tenantB, {
        username: 'second-owner',
        displayName: 'Second',
        password: 'another-password-entirely',
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code: string }).code).toBe(IDENTITY_ERROR_CODES.BOOTSTRAP_ALREADY_DONE);
  });

  it('seeds the frozen role catalog for the tenant', async () => {
    await ctx.container.bootstrapOwner.execute(tenantB, {
      username: 'first-owner',
      displayName: 'First Owner',
      password: 'the-installation-owner-password',
    });

    const seeded = await ctx.container.roles.list(tenantB);
    expect(seeded.map((role) => role.key).sort()).toEqual(
      [...ROLE_SEEDS].map((role) => role.key).sort(),
    );
    expect(seeded.every((role) => role.isSystem)).toBe(true);
  });

  it('audits how the first owner came to exist', async () => {
    await ctx.container.bootstrapOwner.execute(tenantB, {
      username: 'first-owner',
      displayName: 'First Owner',
      password: 'the-installation-owner-password',
    });

    const audits = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'admin.bootstrap'));
    expect(audits).toHaveLength(1);
    // Named honestly as system work rather than as a fabricated administrator.
    expect(audits[0]?.actorType).toBe('SYSTEM_JOB');
    expect(audits[0]?.result).toBe('SUCCESS');
  });

  it('rejects a password below the policy floor', async () => {
    await expect(
      ctx.container.bootstrapOwner.execute(tenantB, {
        username: 'first-owner',
        displayName: 'First Owner',
        password: 'short',
      }),
    ).rejects.toThrow();
  });
});

describe('database backstops', () => {
  it('refuses to delete a system role', async () => {
    // Defence in depth: the application never deletes one, and an installation
    // that lost its owner role would be recoverable only by hand.
    const [role] = await ctx.container.roles.list(tenantA);
    expect(role).toBeDefined();
    await expect(
      ctx.container.database.db.execute(
        `DELETE FROM roles WHERE tenant_id = '${tenantA.tenantId}' AND key = 'owner'` as never,
      ),
    ).rejects.toThrow();
  });

  it('refuses a raw unassignment that would leave no active owner', async () => {
    // The trigger catches a code path that forgot the rule. The application
    // lock is what makes the rule concurrency-safe; this is the backstop.
    await expect(
      ctx.container.database.db.execute(
        `DELETE FROM admin_roles WHERE tenant_id = '${tenantA.tenantId}' AND admin_id = '${owner.id as AdminId}'` as never,
      ),
    ).rejects.toThrow();
  });
});
