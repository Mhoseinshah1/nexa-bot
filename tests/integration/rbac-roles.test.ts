import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
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
  rolePermissions,
  roles as rolesTable,
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

  /*
   * Item 2 (permission contracts). `PermissionKey` is the catalogue's literal union, and a
   * row is a `string` until `isPermissionKey` says otherwise. A key stored in a role or an
   * override that the catalogue does not name — nothing has been removed so far, but a row
   * is not a contract — must confer nothing AND take nothing down: the role list, the
   * guard and the preview all still answer, and an edit of the role succeeds.
   */
  it('skips a stored key the catalogue does not name, and still answers everywhere', async () => {
    const helper = await createAdmin(ctx.container, tenantA, {
      username: 'helper',
      roleKeys: ['support'],
    });
    const db = ctx.container.database.db;
    const [supportRow] = await db
      .select({ id: rolesTable.id })
      .from(rolesTable)
      .where(
        and(eq(rolesTable.tenantId, tenantA.tenantId as string), eq(rolesTable.key, 'support')),
      );
    await db.insert(rolePermissions).values({
      tenantId: tenantA.tenantId as string,
      roleId: supportRow!.id,
      permissionKey: 'legacy.retired_power',
    });
    await grant(helper, 'legacy.other_power', 'GRANT');

    const support = (await roleOf('support'))!;
    expect(support.permissions).not.toContain('legacy.retired_power');
    expect(support.permissions).toContain('tickets.reply');

    const held = [...(await ctx.container.guard.permissionsOf(tenantA, adminActorFor(helper)))];
    expect(held).toContain('tickets.reply');
    expect(held).not.toContain('legacy.retired_power');
    expect(held).not.toContain('legacy.other_power');

    const preview = await mgmt().effectivePermissions(tenantA, ownerActor, helper.id);
    expect(preview.effective).toEqual([...held].sort());
    expect(preview.rolePermissions).not.toContain('legacy.retired_power');
    expect(preview.overrides.map((one) => one.permissionKey)).not.toContain('legacy.other_power');

    // Re-saving the set as read is a no-op: the uncatalogued row is invisible to the
    // comparison, so it neither blocks the save nor counts as a change.
    const unchanged = await mgmt().updateRole(tenantA, ownerActor, 'support', {
      name: support.name,
      permissions: support.permissions,
      expectedVersion: support.version,
      reason: 'routine review',
    });
    expect(unchanged.version).toBe(support.version);
    // A real edit writes exactly the submitted set; the uncatalogued row, which conferred
    // nothing, is not carried forward.
    const edited = await mgmt().updateRole(tenantA, ownerActor, 'support', {
      name: support.name,
      permissions: support.permissions.filter((one) => one !== 'tickets.reply'),
      expectedVersion: support.version,
      reason: 'replies move to a new team',
    });
    expect(edited.version).toBe(support.version + 1);
    const stored = await db
      .select({ key: rolePermissions.permissionKey })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, supportRow!.id));
    expect(stored.map((one) => one.key)).not.toContain('legacy.retired_power');
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

describe('Codex review of #161', () => {
  const repo = () =>
    ctx.container.roles as unknown as Record<string, (...args: unknown[]) => unknown>;

  /** Replaces one repository method for the length of `work`, restoring it after. */
  async function patched<T>(
    method: string,
    replacement: (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    const target = repo();
    const original = target[method]!.bind(target);
    target[method] = replacement(original);
    try {
      return await work();
    } finally {
      delete target[method];
    }
  }

  /** A commit on its OWN connection, as a racing operator's would be. */
  async function racingRename(key: string, name: string) {
    await ctx.container.database.db.execute(
      sql`UPDATE roles SET name = ${name}, version = version + 1
          WHERE tenant_id = ${tenantA.tenantId} AND key = ${key}`,
    );
  }

  it('4173474753: a listed role pairs its permissions with the version they were read at', async () => {
    const before = (await roleOf('support'))!;
    let raced = false;
    const listed = await patched(
      'list',
      (original) =>
        async (...args: unknown[]) => {
          const result = await original(...args);
          // Another operator commits between the permissions read and the version read.
          if (!raced) {
            raced = true;
            await ctx.container.database.db.execute(
              sql`UPDATE roles SET version = version + 1
                  WHERE tenant_id = ${tenantA.tenantId} AND key = 'support'`,
            );
            await ctx.container.database.db.execute(
              sql`DELETE FROM role_permissions rp USING roles r
                  WHERE rp.role_id = r.id AND r.key = 'support' AND rp.permission_key = 'tickets.reply'`,
            );
          }
          return result;
        },
      () => mgmt().listManagedRoles(tenantA, ownerActor),
    );
    const support = listed.find((role) => role.key === 'support')!;
    // One snapshot: the old set with the OLD version, never the old set with the new one.
    expect(support.version).toBe(before.version);
    expect(support.permissions).toContain('tickets.reply');
  });

  it('4173474761: one key reused with a different reason is refused, not replayed', async () => {
    const base = {
      key: 'keyed',
      name: 'Keyed',
      permissions: ['users.view'],
      idempotencyKey: 'role-reason-key-1',
    };
    await mgmt().createRole(tenantA, ownerActor, { ...base, reason: 'first reason' });
    expect(
      await codeOf(mgmt().createRole(tenantA, ownerActor, { ...base, reason: 'another reason' })),
    ).toBe('platform.idempotency_payload_mismatch');
    const support = (await roleOf('support'))!;
    const edit = {
      name: 'Support desk',
      permissions: support.permissions,
      expectedVersion: support.version,
      idempotencyKey: 'role-reason-key-2',
    };
    await mgmt().updateRole(tenantA, ownerActor, 'support', { ...edit, reason: 'one' });
    expect(
      await codeOf(mgmt().updateRole(tenantA, ownerActor, 'support', { ...edit, reason: 'two' })),
    ).toBe('platform.idempotency_payload_mismatch');
  });

  it('4173474758: an update answers with ITS result, read inside its own lock', async () => {
    const support = (await roleOf('support'))!;
    // Anything that reads the role AFTER the lock is released lets a racer in first:
    // simulate that racer at the moment such a read would happen.
    const result = await patched(
      'listForManagement',
      (original) =>
        async (...args: unknown[]) => {
          if (args[1] === undefined) await racingRename('support', 'Racer');
          return original(...args);
        },
      () =>
        mgmt().updateRole(tenantA, ownerActor, 'support', {
          name: 'Ours',
          permissions: support.permissions,
          expectedVersion: support.version,
          reason: 'rename',
        }),
    );
    expect(result.name).toBe('Ours');
    expect(result.version).toBe(support.version + 1);
  });

  it('4173474756: a no-op update records its replay, so a retry after another edit is answered', async () => {
    const support = (await roleOf('support'))!;
    const noop = {
      name: support.name,
      permissions: support.permissions,
      expectedVersion: support.version,
      reason: 'nothing to change',
      idempotencyKey: 'role-noop-key-1',
    };
    const first = await mgmt().updateRole(tenantA, ownerActor, 'support', noop);
    expect(first.version).toBe(support.version);
    // Somebody else edits the role; then the lost-response retry arrives.
    await mgmt().updateRole(tenantA, ownerActor, 'support', {
      name: 'Changed by someone else',
      permissions: support.permissions,
      expectedVersion: support.version,
      reason: 'other',
    });
    const retry = await mgmt().updateRole(tenantA, ownerActor, 'support', noop);
    expect(retry).toEqual(first);
  });

  it('4173474764: the effective preview describes ONE state, the resolver included', async () => {
    const helper = await createAdmin(ctx.container, tenantA, {
      username: 'helper',
      roleKeys: ['support'],
    });
    const admins = ctx.container.admins as unknown as Record<string, (...a: unknown[]) => unknown>;
    const original = admins['roleKeysFor']!.bind(admins);
    let raced = false;
    admins['roleKeysFor'] = async (...args: unknown[]) => {
      const result = await original(...args);
      if (!raced) {
        raced = true;
        // The role is taken away between the preview's first read and the rest.
        await ctx.container.database.db.execute(
          sql`DELETE FROM admin_roles WHERE admin_id = ${helper.id}`,
        );
      }
      return result;
    };
    let preview;
    try {
      preview = await mgmt().effectivePermissions(tenantA, ownerActor, helper.id);
    } finally {
      delete admins['roleKeysFor'];
    }
    // Whichever state it describes, it describes it whole: support in the roles AND its
    // permissions in both the role set and the effective set.
    expect(preview.roles.map((role) => role.key)).toEqual(['support']);
    expect(preview.rolePermissions).toContain('tickets.reply');
    expect(preview.effective).toContain('tickets.reply');
  });
});
