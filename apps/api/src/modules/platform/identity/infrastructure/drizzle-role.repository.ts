import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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
  admins,
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
   * Idempotent and re-runnable, and CREATION-ONLY: a role this call finds is
   * left exactly as it is. A role missing entirely — a new one in the
   * catalogue, or a fresh installation — is created with its seed permissions.
   * Roles an operator created themselves are never touched.
   *
   * Adding a permission to a role that already exists is therefore an explicit
   * migration, not something a restart does quietly. See the loop below for why
   * that trade is the right way round.
   *
   * Safe to run concurrently, which matters because it runs at API boot and two
   * processes can start together. The role id is re-read after the insert
   * rather than assumed: whichever process loses the unique index gets a no-op
   * from `onConflictDoNothing`, and the id it generated was never stored — so
   * granting permissions against it would name a role that does not exist, and
   * the composite foreign key would reject that and fail the boot.
   */
  async ensureSystemRoles(scope: ScopeContext, tx?: unknown): Promise<void> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);

    const findRoleId = async (key: string): Promise<string | undefined> => {
      const [row] = await executor
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.tenantId, tenantId), eq(roles.key, key)))
        .limit(1);
      return row?.id;
    };

    for (const seed of ROLE_SEEDS) {
      const existingId = await findRoleId(seed.key);

      // A role that already exists is LEFT ALONE. Its permissions are a
      // creation default, not a state this reasserts on every boot.
      //
      // This is a decision between two reported problems, and it is worth
      // stating which one was chosen. Writing the seed unconditionally made an
      // upgrade able to add a permission to an existing role — and made every
      // restart silently restore one an operator had deliberately withdrawn,
      // with no audit row and nothing to notice it. Writing it only at creation
      // means a permission newly added to a seeded role does NOT reach
      // installations that already have that role.
      //
      // The second failure is the safer one. It is visible — the amplification
      // rule refuses to grant a permission nobody holds, loudly — and it is
      // fixed by a migration that says what it is doing. The first is invisible
      // and hands back authority that was taken away on purpose. Restoring
      // privilege by accident is worse than failing to extend it on time.
      if (existingId !== undefined) continue;

      await executor
        .insert(roles)
        .values({ id: this.ids.uuid(), tenantId, key: seed.key, name: seed.name, isSystem: true })
        .onConflictDoNothing();

      // The authoritative id, whoever won the insert.
      const roleId = await findRoleId(seed.key);
      if (roleId === undefined) {
        // Neither our insert nor anyone else's produced a row. Better to say so
        // than to carry on and write permissions nothing can resolve.
        throw new Error(`The system role '${seed.key}' could not be created or found.`);
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

    // A stored key the catalogue does not name confers nothing and is skipped, never thrown:
    // one stale row must not take every request this administrator makes down with it.
    return rows.flatMap((row) => {
      const permissionKey = row.permissionKey;
      if (!isPermissionKey(permissionKey)) return [];
      return [
        {
          permissionKey,
          effect: row.effect as PermissionOverrideEffect,
          reason: row.reason,
          expiresAt: row.expiresAt,
        },
      ];
    });
  }

  // -------------------------------------------------------------------------
  // Phase D3 — role management
  // -------------------------------------------------------------------------

  /**
   * Every role with its version and the administrators holding it, for the editor.
   * Holders are listed whatever their status — a disabled holder still names the role
   * in history, and deleting a role they hold would orphan that.
   */
  async listForManagement(scope: ScopeContext, tx?: unknown): Promise<ManagedRole[]> {
    /*
     * Several statements, so they must share ONE snapshot (Codex 4173474753): read on
     * the pool, a commit between the permissions and the versions paired a stale set
     * with a newer version, and the editor's optimistic check then accepted an edit
     * made from a state nobody saw. With no caller transaction this opens its own,
     * REPEATABLE READ and read-only.
     */
    if (tx === undefined) {
      return this.db.transaction(
        (snapshot) => this.listForManagement(scope, { tx: snapshot, scope }),
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    }
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);
    const base = await this.list(scope, tx);
    const versions = await executor
      .select({ id: roles.id, version: roles.version })
      .from(roles)
      .where(eq(roles.tenantId, tenantId));
    const versionOf = new Map(versions.map((row) => [row.id, row.version]));
    const holders = await executor
      .select({
        roleId: adminRoles.roleId,
        id: admins.id,
        username: admins.username,
        displayName: admins.displayName,
        status: admins.status,
      })
      .from(adminRoles)
      .innerJoin(
        admins,
        and(eq(admins.id, adminRoles.adminId), eq(admins.tenantId, adminRoles.tenantId)),
      )
      .where(eq(adminRoles.tenantId, tenantId))
      .orderBy(asc(admins.username));
    const byRole = new Map<string, ManagedRole['assignedAdmins'][number][]>();
    for (const row of holders) {
      const list = byRole.get(row.roleId) ?? [];
      list.push({
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        status: row.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
      });
      byRole.set(row.roleId, list);
    }
    return base.map((role) => ({
      ...role,
      version: versionOf.get(role.id) ?? 1,
      assignedAdmins: byRole.get(role.id) ?? [],
    }));
  }

  /** One role, `FOR UPDATE`, with its version and permissions. */
  async lockByKey(scope: ScopeContext, key: string, tx: unknown): Promise<LockedRole | null> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);
    const [row] = await executor
      .select()
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.key, key)))
      .for('update')
      .limit(1);
    if (row === undefined) return null;
    const permissionRows = await executor
      .select({ permissionKey: rolePermissions.permissionKey })
      .from(rolePermissions)
      .where(and(eq(rolePermissions.tenantId, tenantId), eq(rolePermissions.roleId, row.id)));
    return {
      id: asId<'RoleId'>(row.id),
      key: row.key,
      name: row.name,
      isSystem: row.isSystem,
      version: row.version,
      permissions: permissionRows
        .map((one) => one.permissionKey)
        .filter(isPermissionKey)
        .sort(),
    };
  }

  /** A new CUSTOM role. Never a system one: those come only from the seed. */
  async createCustom(
    scope: ScopeContext,
    input: {
      readonly id: RoleId;
      readonly key: string;
      readonly name: string;
      readonly permissions: readonly PermissionKey[];
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);
    await executor.insert(roles).values({
      id: input.id,
      tenantId,
      key: input.key,
      name: input.name,
      isSystem: false,
      createdAt: input.now,
      version: 1,
      updatedAt: input.now,
    });
    await this.writePermissions(executor, tenantId, input.id, input.permissions);
  }

  /**
   * Replaces a role's name and permission set, ONLY if it is still at `expectedVersion`.
   * Returns false — and changes nothing — when somebody saved it first.
   */
  async replace(
    scope: ScopeContext,
    roleId: RoleId,
    expectedVersion: number,
    input: {
      readonly name: string;
      readonly permissions: readonly PermissionKey[];
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);
    const updated = await executor
      .update(roles)
      .set({ name: input.name, version: sql`${roles.version} + 1`, updatedAt: input.now })
      .where(
        and(eq(roles.tenantId, tenantId), eq(roles.id, roleId), eq(roles.version, expectedVersion)),
      )
      .returning({ id: roles.id });
    if (updated.length === 0) return false;
    await executor
      .delete(rolePermissions)
      .where(and(eq(rolePermissions.tenantId, tenantId), eq(rolePermissions.roleId, roleId)));
    await this.writePermissions(executor, tenantId, roleId, input.permissions);
    return true;
  }

  /** Deletes a CUSTOM role at `expectedVersion`. The system-role trigger backs this up. */
  async deleteCustom(
    scope: ScopeContext,
    roleId: RoleId,
    expectedVersion: number,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);
    const [row] = await executor
      .select({ version: roles.version, isSystem: roles.isSystem })
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.id, roleId)))
      .limit(1);
    if (row === undefined || row.version !== expectedVersion || row.isSystem) return false;
    await executor
      .delete(rolePermissions)
      .where(and(eq(rolePermissions.tenantId, tenantId), eq(rolePermissions.roleId, roleId)));
    await executor.delete(roles).where(and(eq(roles.tenantId, tenantId), eq(roles.id, roleId)));
    return true;
  }

  /** How many administrators hold this role, whatever their status. */
  async holderCount(scope: ScopeContext, roleId: RoleId, tx?: unknown): Promise<number> {
    const [row] = await executorOf(this.db, tx)
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(adminRoles)
      .where(and(eq(adminRoles.tenantId, requireTenantId(scope)), eq(adminRoles.roleId, roleId)));
    return row?.count ?? 0;
  }

  private async writePermissions(
    executor: Executor,
    tenantId: string,
    roleId: RoleId,
    permissions: readonly PermissionKey[],
  ): Promise<void> {
    if (permissions.length === 0) return;
    await executor
      .insert(rolePermissions)
      .values(permissions.map((permissionKey) => ({ tenantId, roleId, permissionKey })));
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

/** A role as the editor sees it. */
export interface ManagedRole extends Role {
  readonly version: number;
  readonly assignedAdmins: readonly {
    readonly id: string;
    readonly username: string;
    readonly displayName: string;
    readonly status: 'ACTIVE' | 'DISABLED';
  }[];
}

export interface LockedRole {
  readonly id: RoleId;
  readonly key: string;
  readonly name: string;
  readonly isSystem: boolean;
  readonly version: number;
  readonly permissions: readonly PermissionKey[];
}
