import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  IDENTITY_ERROR_CODES,
  isNexaError,
  OWNER_ROLE_KEY,
  type ActorContext,
  type PermissionKey,
} from '@nexa/contracts';
import {
  adminPermissionOverrides,
  auditLogs,
  operationalEvents,
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
 * Phase D3 — role management over the existing authorization model, against a real
 * database: the immutable owner role, coherence, the amplification bound, the typed
 * confirmation, versioned edits, holders, and the effective-permission preview held to
 * the REAL resolver (the guard), never a copy.
 */

let ctx: TestContext;
let owner: SeededAdmin;
let ownerActor: ActorContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.reset();
  owner = await createAdmin(ctx.container, tenantA, { username: 'owner', roleKeys: ['owner'] });
  ownerActor = adminActorFor(owner);
});

const mgmt = () => ctx.container.adminManagement;

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (isNexaError(error)) return error.code;
    throw error;
  }
  throw new Error('expected a failure');
}

async function roleOf(key: string) {
  return (await mgmt().listManagedRoles(tenantA, ownerActor)).find((role) => role.key === key);
}

async function grant(
  admin: SeededAdmin,
  permissionKey: string,
  effect: 'GRANT' | 'DENY' = 'GRANT',
) {
  await ctx.container.database.db.insert(adminPermissionOverrides).values({
    tenantId: tenantA.tenantId as string,
    adminId: admin.id,
    permissionKey,
    effect,
    reason: 'test override',
  });
}

describe('reading roles', () => {
  it('lists every role with its version, holders, and the owner role marked immutable', async () => {
    const support = await createAdmin(ctx.container, tenantA, {
      username: 'helper',
      roleKeys: ['support'],
    });
    const roles = await mgmt().listManagedRoles(tenantA, ownerActor);
    const ownerRole = roles.find((role) => role.key === OWNER_ROLE_KEY)!;
    expect(ownerRole.immutable).toBe(true);
    expect(ownerRole.isSystem).toBe(true);
    expect(ownerRole.assignedAdmins.map((one) => one.username)).toEqual(['owner']);
    const supportRole = roles.find((role) => role.key === 'support')!;
    expect(supportRole.immutable).toBe(false);
    expect(supportRole.version).toBe(1);
    expect(supportRole.assignedAdmins.map((one) => one.id)).toEqual([support.id]);
  });

  it('needs admins.view', async () => {
    const nobody = await createAdmin(ctx.container, tenantA, { username: 'nobody' });
    expect(await codeOf(mgmt().listManagedRoles(tenantA, adminActorFor(nobody)))).toBe(
      'platform.permission_denied',
    );
  });
});

describe('creating and cloning', () => {
  it('creates a custom role, audited, with an alerts-page event', async () => {
    const role = await mgmt().createRole(tenantA, ownerActor, {
      key: 'night_shift',
      name: 'Night shift',
      permissions: ['users.view', 'tickets.view', 'tickets.reply'],
      reason: 'staffing',
    });
    expect(role).toMatchObject({
      key: 'night_shift',
      isSystem: false,
      immutable: false,
      version: 1,
    });
    expect(role.permissions).toEqual(['tickets.reply', 'tickets.view', 'users.view']);
    const [row] = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'role.create'), eq(auditLogs.result, 'SUCCESS')));
    expect(row?.entityType).toBe('Role');
    expect(row?.reason).toBe('staffing');
    const events = await ctx.container.database.db
      .select()
      .from(operationalEvents)
      .where(eq(operationalEvents.code, 'admin.role_created'));
    expect(events).toHaveLength(1);
  });

  it('records the source of a clone', async () => {
    const support = (await roleOf('support'))!;
    await mgmt().createRole(tenantA, ownerActor, {
      key: 'support_plus',
      name: 'Support plus',
      permissions: [...support.permissions, 'users.block'],
      reason: 'a support role that can block',
      clonedFrom: 'support',
    });
    const [row] = await ctx.container.database.db
      .select({ after: auditLogs.after })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'role.create'));
    expect((row?.after as { clonedFrom?: string }).clonedFrom).toBe('support');
  });

  it('refuses a taken key, an unknown permission, and an action without its read', async () => {
    expect(
      await codeOf(
        mgmt().createRole(tenantA, ownerActor, {
          key: 'support',
          name: 'Again',
          permissions: ['users.view'],
          reason: 'x',
        }),
      ),
    ).toBe(IDENTITY_ERROR_CODES.ROLE_KEY_TAKEN);
    expect(
      await codeOf(
        mgmt().createRole(tenantA, ownerActor, {
          key: 'made_up',
          name: 'Made up',
          permissions: ['users.fly'],
          reason: 'x',
        }),
      ),
    ).toBe(IDENTITY_ERROR_CODES.ROLE_UNKNOWN_PERMISSION);
    // `receipts.review` needs `payments.view` (PERMISSION_REQUIRES).
    expect(
      await codeOf(
        mgmt().createRole(tenantA, ownerActor, {
          key: 'reviewer_alone',
          name: 'Reviewer',
          permissions: ['receipts.review'],
          reason: 'x',
        }),
      ),
    ).toBe(IDENTITY_ERROR_CODES.ROLE_PERMISSIONS_INCOHERENT);
    await mgmt().createRole(tenantA, ownerActor, {
      key: 'reviewer_whole',
      name: 'Reviewer',
      permissions: ['receipts.review', 'payments.view'],
      reason: 'x',
    });
  });

  it('demands the typed role key for a CRITICAL permission', async () => {
    const attempt = (confirmation?: string) =>
      mgmt().createRole(tenantA, ownerActor, {
        key: 'refunder',
        name: 'Refunder',
        permissions: ['refunds.issue'],
        reason: 'refunds desk',
        ...(confirmation === undefined ? {} : { confirmation }),
      });
    expect(await codeOf(attempt())).toBe(IDENTITY_ERROR_CODES.ROLE_CONFIRMATION_REQUIRED);
    expect(await codeOf(attempt('Refunder'))).toBe(IDENTITY_ERROR_CODES.ROLE_CONFIRMATION_REQUIRED);
    await expect(attempt('refunder')).resolves.toMatchObject({ key: 'refunder' });
  });

  it('replays a create by its idempotency key', async () => {
    const input = {
      key: 'replayed',
      name: 'Replayed',
      permissions: ['users.view'],
      reason: 'x',
      idempotencyKey: 'role-create-key-1',
    };
    const first = await mgmt().createRole(tenantA, ownerActor, input);
    const second = await mgmt().createRole(tenantA, ownerActor, input);
    expect(second).toEqual(first);
  });
});

describe('editing', () => {
  it('never edits or deletes the owner role', async () => {
    const ownerRole = (await roleOf(OWNER_ROLE_KEY))!;
    expect(
      await codeOf(
        mgmt().updateRole(tenantA, ownerActor, OWNER_ROLE_KEY, {
          name: 'Owner',
          permissions: ownerRole.permissions.filter((one) => one !== 'admins.edit'),
          expectedVersion: ownerRole.version,
          reason: 'x',
          confirmation: OWNER_ROLE_KEY,
        }),
      ),
    ).toBe(IDENTITY_ERROR_CODES.ROLE_IMMUTABLE);
    expect(
      await codeOf(
        mgmt().deleteRole(tenantA, ownerActor, OWNER_ROLE_KEY, {
          expectedVersion: ownerRole.version,
          reason: 'x',
          confirmation: OWNER_ROLE_KEY,
        }),
      ),
    ).toBe(IDENTITY_ERROR_CODES.ROLE_IMMUTABLE);
    expect((await roleOf(OWNER_ROLE_KEY))!.permissions).toEqual(ownerRole.permissions);
  });

  it('edits a system role, bumps its version, and the change applies to holders at once', async () => {
    const helper = await createAdmin(ctx.container, tenantA, {
      username: 'helper',
      roleKeys: ['support'],
    });
    const guard = () =>
      ctx.container.guard.permissionsOf(tenantA, adminActorFor(helper)) as Promise<
        ReadonlySet<PermissionKey>
      >;
    expect((await guard()).has('tickets.reply')).toBe(true);
    const support = (await roleOf('support'))!;
    const edited = await mgmt().updateRole(tenantA, ownerActor, 'support', {
      name: 'Support desk',
      permissions: support.permissions.filter((one) => one !== 'tickets.reply'),
      expectedVersion: support.version,
      reason: 'replies move to a new team',
    });
    expect(edited.version).toBe(support.version + 1);
    expect(edited.name).toBe('Support desk');
    expect((await guard()).has('tickets.reply')).toBe(false);
    const [row] = await ctx.container.database.db
      .select({ after: auditLogs.after, before: auditLogs.before })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'role.update'));
    expect((row?.after as { removed: string[] }).removed).toEqual(['tickets.reply']);
  });

  it('refuses an edit made from a stale version, and lets exactly one of two racers win', async () => {
    const support = (await roleOf('support'))!;
    const edit = (name: string) =>
      mgmt().updateRole(tenantA, ownerActor, 'support', {
        name,
        permissions: support.permissions,
        expectedVersion: support.version,
        reason: 'race',
      });
    const results = await Promise.allSettled([edit('First'), edit('Second')]);
    const won = results.filter((one) => one.status === 'fulfilled');
    const lost = results.filter((one) => one.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(
      isNexaError((lost[0] as PromiseRejectedResult).reason) &&
        (lost[0] as PromiseRejectedResult).reason.code,
    ).toBe(IDENTITY_ERROR_CODES.ROLE_VERSION_CONFLICT);
    expect((await roleOf('support'))!.version).toBe(support.version + 1);
  });

  it('a CRITICAL addition or removal needs the typed key', async () => {
    const support = (await roleOf('support'))!;
    expect(
      await codeOf(
        mgmt().updateRole(tenantA, ownerActor, 'support', {
          name: support.name,
          permissions: [...support.permissions, 'users.wallet.debit'],
          expectedVersion: support.version,
          reason: 'x',
        }),
      ),
    ).toBe(IDENTITY_ERROR_CODES.ROLE_CONFIRMATION_REQUIRED);
    await mgmt().updateRole(tenantA, ownerActor, 'support', {
      name: support.name,
      permissions: [...support.permissions, 'users.wallet.debit'],
      expectedVersion: support.version,
      reason: 'x',
      confirmation: 'support',
    });
  });
});

describe('deleting', () => {
  it('refuses a system role and a role somebody holds; deletes an unheld custom role', async () => {
    const support = (await roleOf('support'))!;
    expect(
      await codeOf(
        mgmt().deleteRole(tenantA, ownerActor, 'support', {
          expectedVersion: support.version,
          reason: 'x',
        }),
      ),
    ).toBe(IDENTITY_ERROR_CODES.ROLE_IMMUTABLE);

    await mgmt().createRole(tenantA, ownerActor, {
      key: 'temp',
      name: 'Temp',
      permissions: ['users.view'],
      reason: 'x',
    });
    const holder = await createAdmin(ctx.container, tenantA, {
      username: 'temp-holder',
      roleKeys: ['temp'],
    });
    expect(
      await codeOf(
        mgmt().deleteRole(tenantA, ownerActor, 'temp', { expectedVersion: 1, reason: 'x' }),
      ),
    ).toBe(IDENTITY_ERROR_CODES.ROLE_IN_USE);
    await mgmt().setRoles(tenantA, ownerActor, holder.id, { roleKeys: [], reason: 'moving' });
    await expect(
      mgmt().deleteRole(tenantA, ownerActor, 'temp', { expectedVersion: 1, reason: 'x' }),
    ).resolves.toEqual({ deleted: true, key: 'temp' });
    expect(await roleOf('temp')).toBeUndefined();
  });
});

describe('who may manage roles', () => {
  it('refuses an administrator without admins.permissions.edit, and audits the refusal as a Role', async () => {
    const operator = await createAdmin(ctx.container, tenantA, {
      username: 'operator1',
      roleKeys: ['operator'],
    });
    expect(
      await codeOf(
        mgmt().createRole(tenantA, adminActorFor(operator), {
          key: 'mine',
          name: 'Mine',
          permissions: ['users.view'],
          reason: 'x',
        }),
      ),
    ).toBe('platform.permission_denied');
    const [row] = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'role.create'), eq(auditLogs.result, 'DENIED')));
    expect(row?.entityType).toBe('Role');
  });

  it('never lets a delegated manager grant, or rewrite a role holding, what they lack', async () => {
    const manager = await createAdmin(ctx.container, tenantA, {
      username: 'manager',
      roleKeys: ['support'],
    });
    await grant(manager, 'admins.view');
    await grant(manager, 'admins.permissions.edit');
    const actor = adminActorFor(manager);
    expect(
      await codeOf(
        mgmt().createRole(tenantA, actor, {
          key: 'escalator',
          name: 'Escalator',
          permissions: ['refunds.issue'],
          reason: 'x',
          confirmation: 'escalator',
        }),
      ),
    ).toBe(IDENTITY_ERROR_CODES.ADMIN_PRIVILEGE_ESCALATION);
    // Even REMOVING from a role more privileged than themselves is refused.
    const finance = (await roleOf('finance'))!;
    expect(
      await codeOf(
        mgmt().updateRole(tenantA, actor, 'finance', {
          name: finance.name,
          permissions: finance.permissions.slice(1),
          expectedVersion: finance.version,
          reason: 'x',
          confirmation: 'finance',
        }),
      ),
    ).toBe(IDENTITY_ERROR_CODES.ADMIN_PRIVILEGE_ESCALATION);
    // Within their own authority, they may.
    await expect(
      mgmt().createRole(tenantA, actor, {
        key: 'readers',
        name: 'Readers',
        permissions: ['users.view', 'orders.view'],
        reason: 'x',
      }),
    ).resolves.toMatchObject({ key: 'readers' });
  });

  it("cannot reach another tenant's roles", async () => {
    const elsewhere = await createAdmin(ctx.container, tenantB, {
      username: 'owner',
      roleKeys: ['owner'],
    });
    await mgmt().createRole(tenantA, ownerActor, {
      key: 'a_only',
      name: 'A only',
      permissions: ['users.view'],
      reason: 'x',
    });
    const fromB = await mgmt().listManagedRoles(tenantB, adminActorFor(elsewhere));
    expect(fromB.some((role) => role.key === 'a_only')).toBe(false);
    expect(
      await codeOf(
        mgmt().updateRole(tenantB, adminActorFor(elsewhere), 'a_only', {
          name: 'x',
          permissions: [],
          expectedVersion: 1,
          reason: 'x',
        }),
      ),
    ).toBe(IDENTITY_ERROR_CODES.ROLE_NOT_FOUND);
  });
});

describe('the effective-permission preview', () => {
  it('is exactly what the guard resolves, DENY overrides and dependencies included', async () => {
    const helper = await createAdmin(ctx.container, tenantA, {
      username: 'helper',
      roleKeys: ['support'],
    });
    // DENY the read: the resolver drops it AND every action that needs it.
    await grant(helper, 'tickets.view', 'DENY');
    await grant(helper, 'users.block', 'GRANT');
    const preview = await mgmt().effectivePermissions(tenantA, ownerActor, helper.id);
    const resolved = [
      ...(await ctx.container.guard.permissionsOf(tenantA, adminActorFor(helper))),
    ].sort();
    expect(preview.effective).toEqual(resolved);
    expect(preview.effective).not.toContain('tickets.view');
    expect(preview.effective).not.toContain('tickets.reply');
    expect(preview.effective).toContain('users.block');
    expect(preview.rolePermissions).toContain('tickets.reply');
    expect(preview.overrides.map((one) => `${one.effect}:${one.permissionKey}`)).toEqual([
      'DENY:tickets.view',
      'GRANT:users.block',
    ]);
  });

  it('shows a disabled administrator holding nothing', async () => {
    const parked = await createAdmin(ctx.container, tenantA, {
      username: 'parked',
      roleKeys: ['support'],
      status: 'DISABLED',
    });
    const preview = await mgmt().effectivePermissions(tenantA, ownerActor, parked.id);
    expect(preview.active).toBe(false);
    expect(preview.effective).toEqual([]);
    expect(preview.rolePermissions.length).toBeGreaterThan(0);
  });
});

describe('the last viable owner', () => {
  it('two owners demoting each other at once: exactly one succeeds, an owner remains', async () => {
    const second = await createAdmin(ctx.container, tenantA, {
      username: 'second-owner',
      roleKeys: ['owner'],
    });
    const results = await Promise.allSettled([
      mgmt().setRoles(tenantA, ownerActor, second.id, { roleKeys: ['support'], reason: 'race' }),
      mgmt().setRoles(tenantA, adminActorFor(second), owner.id, {
        roleKeys: ['support'],
        reason: 'race',
      }),
    ]);
    expect(results.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
    expect(await ctx.container.admins.countActiveOwners(tenantA)).toBe(1);
  });

  it('the last owner cannot be demoted, and the owner role cannot be emptied', async () => {
    const second = await createAdmin(ctx.container, tenantA, {
      username: 'second-owner',
      roleKeys: ['owner'],
    });
    await mgmt().setRoles(tenantA, adminActorFor(second), owner.id, {
      roleKeys: ['support'],
      reason: 'hand-over',
    });
    expect(
      await codeOf(
        mgmt().setRoles(tenantA, adminActorFor(second), second.id, {
          roleKeys: ['support'],
          reason: 'self',
        }),
      ),
    ).not.toBe('');
    expect(await ctx.container.admins.countActiveOwners(tenantA)).toBe(1);
    // Read as the remaining owner: the first one no longer holds `admins.view`.
    const ownerRole = (await mgmt().listManagedRoles(tenantA, adminActorFor(second))).find(
      (role) => role.key === OWNER_ROLE_KEY,
    )!;
    expect(
      await codeOf(
        mgmt().updateRole(tenantA, adminActorFor(second), OWNER_ROLE_KEY, {
          name: 'Owner',
          permissions: [],
          expectedVersion: ownerRole.version,
          reason: 'x',
          confirmation: OWNER_ROLE_KEY,
        }),
      ),
    ).toBe(IDENTITY_ERROR_CODES.ROLE_IMMUTABLE);
  });
});
