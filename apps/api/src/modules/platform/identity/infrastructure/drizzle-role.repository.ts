import { and, eq, inArray } from 'drizzle-orm';
import {
  asId,
  isPermissionKey,
  ROLE_SEEDS,
  type AdminId,
  type IdGenerator,
  type PermissionKey,
  type PermissionOverride,
  type PermissionOverrideEffect,
  type Role,
  type RoleId,
  type ScopeContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  adminPermissionOverrides,
  adminRoles,
  rolePermissions,
  roles,
} from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type { RoleRepository } from '../application/ports.js';

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

/**
 * Roles as data, seeded from the frozen contract.
 *
 * `ROLE_SEEDS` is the shape an operator recognises on day one; the rows are
 * what they can actually edit afterwards. That is the whole difference from the
 * legacy enum, where the vocabulary is compiled in and a role cannot be changed
 * at all.
 *
 * A permission key that is not in the frozen catalog is dropped on read rather
 * than returned. A stale row left behind by a removed permission must not
 * silently keep granting something the catalog no longer defines.
 */
export class DrizzleRoleRepository implements RoleRepository {
  constructor(
    private readonly db: Database,
    private readonly ids: IdGenerator,
  ) {}

  async list(scope: ScopeContext, tx?: unknown): Promise<Role[]> {
    const tenantId = requireTenantId(scope);
    const roleRows = await executorOf(this.db, tx)
      .select()
      .from(roles)
      .where(eq(roles.tenantId, tenantId))
      .orderBy(roles.key);
    if (roleRows.length === 0) return [];

    const permissionRows = await executorOf(this.db, tx)
      .select()
      .from(rolePermissions)
      .where(eq(rolePermissions.tenantId, tenantId));

    const byRole = new Map<string, PermissionKey[]>();
    for (const row of permissionRows) {
      if (!isPermissionKey(row.permissionKey)) continue;
      const list = byRole.get(row.roleId);
      if (list) list.push(row.permissionKey);
      else byRole.set(row.roleId, [row.permissionKey]);
    }

    return roleRows.map((row) => ({
      id: asId<'RoleId'>(row.id),
      tenantId: asId<'TenantId'>(row.tenantId),
      key: row.key,
      name: row.name,
      isSystem: row.isSystem,
      permissions: (byRole.get(row.id) ?? []).sort(),
    }));
  }

  async findByKey(scope: ScopeContext, key: string, tx?: unknown): Promise<Role | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.key, key)))
      .limit(1);
    if (!row) return null;

    const permissionRows = await executorOf(this.db, tx)
      .select()
      .from(rolePermissions)
      .where(and(eq(rolePermissions.tenantId, tenantId), eq(rolePermissions.roleId, row.id)));

    return {
      id: asId<'RoleId'>(row.id),
      tenantId: asId<'TenantId'>(row.tenantId),
      key: row.key,
      name: row.name,
      isSystem: row.isSystem,
      permissions: permissionRows
        .map((p) => p.permissionKey)
        .filter(isPermissionKey)
        .sort(),
    };
  }

  /**
   * Seeds the system roles for a tenant.
   *
   * Idempotent and re-runnable: an installation that upgrades to a build with a
   * new permission in a seeded role picks it up here rather than needing a data
   * migration. Roles an operator created themselves are never touched.
   */
  async ensureSystemRoles(scope: ScopeContext, tx?: unknown): Promise<void> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);

    for (const seed of ROLE_SEEDS) {
      const [existing] = await executor
        .select()
        .from(roles)
        .where(and(eq(roles.tenantId, tenantId), eq(roles.key, seed.key)))
        .limit(1);

      const roleId = existing?.id ?? this.ids.uuid();
      if (!existing) {
        await executor
          .insert(roles)
          .values({ id: roleId, tenantId, key: seed.key, name: seed.name, isSystem: true })
          .onConflictDoNothing();
      }

      await executor
        .insert(rolePermissions)
        .values(seed.permissions.map((permissionKey) => ({ tenantId, roleId, permissionKey })))
        .onConflictDoNothing();
    }
  }

  async setAdminRoles(
    scope: ScopeContext,
    adminId: AdminId,
    roleIds: readonly RoleId[],
    assignedBy: AdminId | null,
    tx?: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);

    // Replace rather than merge: the caller supplies the complete set, so the
    // assignment cannot drift into "what was intended plus whatever was there".
    await executor
      .delete(adminRoles)
      .where(and(eq(adminRoles.tenantId, tenantId), eq(adminRoles.adminId, adminId)));

    if (roleIds.length === 0) return;

    await executor.insert(adminRoles).values(
      roleIds.map((roleId) => ({
        tenantId,
        adminId,
        roleId,
        assignedByAdminId: assignedBy,
      })),
    );
  }

  async permissionsForAdmin(
    scope: ScopeContext,
    adminId: AdminId,
    tx?: unknown,
  ): Promise<PermissionKey[]> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .select({ permissionKey: rolePermissions.permissionKey })
      .from(adminRoles)
      .innerJoin(
        rolePermissions,
        and(
          eq(rolePermissions.roleId, adminRoles.roleId),
          eq(rolePermissions.tenantId, adminRoles.tenantId),
        ),
      )
      .where(and(eq(adminRoles.tenantId, tenantId), eq(adminRoles.adminId, adminId)));

    const unique = new Set<PermissionKey>();
    for (const row of rows) {
      if (isPermissionKey(row.permissionKey)) unique.add(row.permissionKey);
    }
    return [...unique];
  }

  async overridesForAdmin(
    scope: ScopeContext,
    adminId: AdminId,
    tx?: unknown,
  ): Promise<PermissionOverride[]> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .select()
      .from(adminPermissionOverrides)
      .where(
        and(
          eq(adminPermissionOverrides.tenantId, tenantId),
          eq(adminPermissionOverrides.adminId, adminId),
        ),
      );

    return rows
      .filter((row) => isPermissionKey(row.permissionKey))
      .map((row) => ({
        permissionKey: row.permissionKey as PermissionKey,
        effect: row.effect as PermissionOverrideEffect,
        reason: row.reason,
        expiresAt: row.expiresAt,
      }));
  }

  /** Resolves role keys to ids within the tenant. Unknown keys are reported. */
  async idsForKeys(
    scope: ScopeContext,
    keys: readonly string[],
    tx?: unknown,
  ): Promise<{
    found: Map<string, RoleId>;
    missing: string[];
  }> {
    const tenantId = requireTenantId(scope);
    const found = new Map<string, RoleId>();
    if (keys.length === 0) return { found, missing: [] };

    const rows = await executorOf(this.db, tx)
      .select({ id: roles.id, key: roles.key })
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), inArray(roles.key, [...keys])));

    for (const row of rows) found.set(row.key, asId<'RoleId'>(row.id));
    return { found, missing: keys.filter((key) => !found.has(key)) };
  }
}
